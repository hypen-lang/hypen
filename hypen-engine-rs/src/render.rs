//! Shared rendering logic for Engine and WasmEngine
//!
//! This module contains the common rendering logic to avoid code duplication
//! between the native Engine and WASM WasmEngine implementations.

use crate::{
    ir::{NodeId, Value},
    lifecycle::ModuleInstance,
    reactive::{DependencyGraph, Scheduler},
    reconcile::{evaluate_binding, reconcile_ir_node_impl, InstanceTree, Patch, ReconcileCtx},
};

/// Render only dirty nodes (optimized for state changes)
/// This is shared logic used by both Engine and WasmEngine
pub fn render_dirty_nodes(
    scheduler: &mut Scheduler,
    tree: &mut InstanceTree,
    module: Option<&ModuleInstance>,
) -> Vec<Patch> {
    render_dirty_nodes_full(
        scheduler,
        tree,
        module,
        &mut DependencyGraph::new(),
        None,
        None,
    )
}

/// Render only dirty nodes with data source context
pub fn render_dirty_nodes_with_data_sources(
    scheduler: &mut Scheduler,
    tree: &mut InstanceTree,
    module: Option<&ModuleInstance>,
    data_sources: Option<&indexmap::IndexMap<String, serde_json::Value>>,
) -> Vec<Patch> {
    render_dirty_nodes_full(
        scheduler,
        tree,
        module,
        &mut DependencyGraph::new(),
        data_sources,
        None,
    )
}

/// Render only dirty nodes with dependency tracking for List reconciliation
pub fn render_dirty_nodes_with_deps(
    scheduler: &mut Scheduler,
    tree: &mut InstanceTree,
    module: Option<&ModuleInstance>,
    dependencies: &mut DependencyGraph,
) -> Vec<Patch> {
    render_dirty_nodes_full(scheduler, tree, module, dependencies, None, None)
}

/// Full render of dirty nodes with all contexts
pub fn render_dirty_nodes_full(
    scheduler: &mut Scheduler,
    tree: &mut InstanceTree,
    module: Option<&ModuleInstance>,
    dependencies: &mut DependencyGraph,
    data_sources: Option<&indexmap::IndexMap<String, serde_json::Value>>,
    modules: Option<&indexmap::IndexMap<String, ModuleInstance>>,
) -> Vec<Patch> {
    if !scheduler.has_dirty() {
        return Vec::new();
    }

    let dirty_nodes = scheduler.take_dirty();
    let state = module
        .map(|m| m.get_state())
        .unwrap_or(&serde_json::Value::Null);

    // Store old props before updating, then update and generate patches for changed props only
    let mut patches = Vec::new();
    for node_id in dirty_nodes {
        // Check if this is a List node (has array binding in raw_props AND element_template)
        // The element_template is set for List elements that need to re-render children
        let is_list_node = tree
            .get(node_id)
            .map(|n| {
                n.raw_props
                    .get("0")
                    .map(|v| matches!(v, Value::Binding(_)))
                    .unwrap_or(false)
                    && n.element_template.is_some()
            })
            .unwrap_or(false);

        // Check if this is a control flow node (ForEach or Conditional) with an IR template
        let is_control_flow = tree
            .get(node_id)
            .map(|n| n.ir_node_template.is_some())
            .unwrap_or(false);

        if is_list_node {
            // For List nodes, we need to re-reconcile the entire list
            render_dirty_list(
                node_id,
                tree,
                state,
                &mut patches,
                dependencies,
                data_sources,
            );
        } else if is_control_flow {
            // For control flow nodes (ForEach/Conditional from IRNode path),
            // re-reconcile the entire subtree using the stored IR template.
            let ir_template = tree.get(node_id).and_then(|n| n.ir_node_template.clone());
            if let Some(template) = ir_template {
                let mut ctx = ReconcileCtx {
                    tree,
                    state,
                    patches: &mut patches,
                    dependencies,
                    data_sources,
                    modules,
                };
                reconcile_ir_node_impl(&mut ctx, node_id, &template);
            }
        } else {
            // Regular node: just update props
            let old_props = tree.get(node_id).map(|n| n.props.clone());

            // Determine the effective state: if this node belongs to a module scope,
            // use that module's state; otherwise use the primary module's state.
            let effective_state = tree
                .get(node_id)
                .and_then(|n| n.module_scope.as_deref())
                .and_then(|scope| modules.and_then(|m| m.get(scope)))
                .map(|m| m.get_state())
                .unwrap_or(state);

            // Update props with new state (and data sources if available)
            if let Some(node) = tree.get_mut(node_id) {
                if data_sources.is_some() {
                    node.update_props_with_data_sources(effective_state, data_sources);
                } else {
                    node.update_props(effective_state);
                }
            }

            // Compare and generate patches only for changed props. Deref
            // the Arc<IndexMap> explicitly to get a `&IndexMap` iterator.
            if let (Some(old), Some(node)) = (old_props, tree.get(node_id)) {
                for (key, new_value) in node.props.iter() {
                    if old.get(key.as_str()) != Some(new_value) {
                        patches.push(Patch::set_prop(node_id, key.clone(), new_value.clone()));
                    }
                }
                // Remove props that no longer exist
                for key in old.keys() {
                    if !node.props.contains_key(key.as_str()) {
                        patches.push(Patch::remove_prop(node_id, key.clone()));
                    }
                }
            }
        }
    }

    patches
}

/// Render a dirty List node by re-reconciling its children using the
/// shared keyed-iterable reconciliation pipeline.
fn render_dirty_list(
    node_id: NodeId,
    tree: &mut InstanceTree,
    state: &serde_json::Value,
    patches: &mut Vec<Patch>,
    dependencies: &mut DependencyGraph,
    data_sources: Option<&indexmap::IndexMap<String, serde_json::Value>>,
) {
    use crate::reconcile::keyed::reconcile_iterable_children;

    // Pull out the array binding, the per-item template, and the explicit
    // `key:` annotation (if any) from the stored element template.
    let (array_binding, element_template, key_path_owned) = {
        let node = match tree.get(node_id) {
            Some(n) => n,
            None => return,
        };

        let binding = match node.raw_props.get("0") {
            Some(Value::Binding(b)) => b.clone(),
            _ => return,
        };

        let template = match &node.element_template {
            Some(t) => t.clone(),
            None => return,
        };

        let key_path = template.props.get("key.0").and_then(|v| match v {
            Value::Static(serde_json::Value::String(s)) => Some(s.clone()),
            _ => None,
        });

        (binding, template, key_path)
    };

    let array = evaluate_binding(&array_binding, state).unwrap_or(serde_json::Value::Array(vec![]));

    let items = match &array {
        serde_json::Value::Array(items) => items.clone(),
        _ => return,
    };

    let mut ctx = ReconcileCtx {
        tree,
        state,
        patches,
        dependencies,
        data_sources,
        modules: None,
    };

    reconcile_iterable_children(
        &mut ctx,
        node_id,
        &items,
        "item",
        key_path_owned.as_deref(),
        &element_template.ir_children,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ir::Element, lifecycle::Module, reactive::Binding};
    use serde_json::json;

    #[test]
    fn test_render_dirty_nodes_no_dirty() {
        let mut scheduler = Scheduler::new();
        let mut tree = InstanceTree::new();

        let patches = render_dirty_nodes(&mut scheduler, &mut tree, None);
        assert_eq!(patches.len(), 0);
    }

    #[test]
    fn test_render_dirty_nodes_with_changes() {
        let mut scheduler = Scheduler::new();
        let mut tree = InstanceTree::new();

        // Create a module with state
        let module = Module::new("TestModule");
        let initial_state = json!({"count": 0});
        let instance = ModuleInstance::new(module, initial_state);

        // Create a node with a binding
        let element = Element::new("Text");
        let node_id = tree.create_node(&element, instance.get_state());

        // Mark the node as dirty
        scheduler.mark_dirty(node_id);

        // Render dirty nodes
        let _patches = render_dirty_nodes(&mut scheduler, &mut tree, Some(&instance));

        // Should have processed the dirty node (though patches may be empty if props didn't change)
        assert!(
            !scheduler.has_dirty(),
            "Scheduler should have no more dirty nodes"
        );
    }

    #[test]
    fn test_render_dirty_nodes_state_change() {
        use crate::ir::Value;

        let mut scheduler = Scheduler::new();
        let mut tree = InstanceTree::new();

        // Create module with initial state
        let module = Module::new("TestModule");
        let initial_state = json!({"text": "Hello"});
        let mut instance = ModuleInstance::new(module, initial_state);

        // Create a node with a binding to state
        let mut element = Element::new("Text");
        element.props.insert(
            "0".to_string(),
            Value::Binding(Binding::state(vec!["text".to_string()])),
        );
        let node_id = tree.create_node(&element, instance.get_state());

        // Update the node's props to reflect initial state
        if let Some(node) = tree.get_mut(node_id) {
            node.update_props(instance.get_state());
        }

        // Update state
        instance.update_state(json!({"text": "World"}));

        // Mark node as dirty
        scheduler.mark_dirty(node_id);

        // Render dirty nodes
        let patches = render_dirty_nodes(&mut scheduler, &mut tree, Some(&instance));

        // Should generate a SetProp patch for the changed text
        let set_prop_count = patches
            .iter()
            .filter(|p| matches!(p, Patch::SetProp { .. }))
            .count();
        assert!(
            set_prop_count > 0,
            "Should have SetProp patches for changed state"
        );
    }

    #[test]
    fn test_render_dirty_nodes_multiple_nodes() {
        let mut scheduler = Scheduler::new();
        let mut tree = InstanceTree::new();

        let module = Module::new("TestModule");
        let initial_state = json!({});
        let instance = ModuleInstance::new(module, initial_state);

        // Create multiple nodes
        let element1 = Element::new("Text");
        let element2 = Element::new("Text");
        let element3 = Element::new("Text");

        let node_id_1 = tree.create_node(&element1, instance.get_state());
        let _node_id_2 = tree.create_node(&element2, instance.get_state());
        let node_id_3 = tree.create_node(&element3, instance.get_state());

        // Mark only some nodes as dirty
        scheduler.mark_dirty(node_id_1);
        scheduler.mark_dirty(node_id_3);

        // Should have 2 dirty nodes
        assert!(scheduler.has_dirty());

        render_dirty_nodes(&mut scheduler, &mut tree, Some(&instance));

        // All dirty nodes should be processed
        assert!(!scheduler.has_dirty());
    }
}
