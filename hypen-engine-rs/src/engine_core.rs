//! Shared engine core logic extracted from `Engine` and `WasmEngine`.
//!
//! `EngineCore` owns the fields and methods that are identical across the
//! native Rust engine and the WASM engine, eliminating duplication in
//! module registration, state updates, data-source context management,
//! and dirty-node rendering.

use crate::{
    ir::{ComponentRegistry, IRNode, ResourceRegistry},
    lifecycle::{Module, ModuleInstance},
    reactive::{DependencyGraph, Scheduler},
    reconcile::{reconcile_ir_with_ds, InstanceTree, Patch},
    state::StateChange,
};
use indexmap::IndexMap;
use std::collections::HashSet;

/// Static null value to avoid cloning state when no module exists.
static NULL_STATE: serde_json::Value = serde_json::Value::Null;

/// Shared fields and methods for all engine variants (native, WASM, UniFFI).
pub(crate) struct EngineCore {
    pub component_registry: ComponentRegistry,
    pub resource_registry: ResourceRegistry,
    pub module: Option<ModuleInstance>,
    pub modules: IndexMap<String, ModuleInstance>,
    pub tree: InstanceTree,
    pub dependencies: DependencyGraph,
    pub scheduler: Scheduler,
    pub revision: u64,
    pub data_sources: IndexMap<String, serde_json::Value>,
    /// Maps action name → owning module scope. `None` = primary slot
    /// (installed via [`set_module`]); `Some(name)` = named module (installed
    /// via [`register_module`]). This lets [`action_scope_for`] return the
    /// correct scope for both primary and named modules without a sentinel
    /// string collision.
    pub action_module_map: IndexMap<String, Option<String>>,
    /// Action names registered by the host. Used by polling-based bindings
    /// (UniFFI, WASI) to validate `dispatch_action` requests before queuing.
    /// `js` uses its own closure-based handler map and doesn't touch this.
    #[cfg_attr(
        not(any(
            feature = "uniffi",
            all(target_arch = "wasm32", feature = "wasi"),
        )),
        allow(dead_code)
    )]
    pub registered_actions: Vec<String>,
}

impl EngineCore {
    pub fn new() -> Self {
        Self {
            component_registry: ComponentRegistry::new(),
            resource_registry: ResourceRegistry::new(),
            module: None,
            modules: IndexMap::new(),
            tree: InstanceTree::new(),
            dependencies: DependencyGraph::new(),
            scheduler: Scheduler::new(),
            revision: 0,
            data_sources: IndexMap::new(),
            action_module_map: IndexMap::new(),
            registered_actions: Vec::new(),
        }
    }

    // ── Component & Resource Registration ──────────────────────────────

    /// Register a custom component.
    pub fn register_component(&mut self, component: crate::ir::Component) {
        self.component_registry.register(component);
    }

    /// Set the component resolver for dynamic component loading.
    pub fn set_component_resolver<F>(&mut self, resolver: F)
    where
        F: Fn(&str, Option<&str>) -> Option<crate::ir::ResolvedComponent> + Send + Sync + 'static,
    {
        self.component_registry
            .set_resolver(std::sync::Arc::new(resolver));
    }

    /// Register a single resource from raw SVG content.
    pub fn register_resource(&mut self, name: &str, svg: &str) {
        self.resource_registry.register(name, svg);
    }

    /// Register multiple resources from a name -> SVG map.
    pub fn register_resources(&mut self, map: IndexMap<String, String>) {
        self.resource_registry.register_map(map);
    }

    // ── Module Management ──────────────────────────────────────────────

    /// Set the primary module instance (backward-compatible single-module API).
    ///
    /// Also registers the module's declared actions in `action_module_map`
    /// with a `None` scope so that [`action_scope_for`] resolves primary-slot
    /// actions for polling bindings (WASI/UniFFI). If a primary module was
    /// already installed, any of its action entries in the map are evicted
    /// first so stale routing can't leak across replacements.
    pub fn set_module(&mut self, module: ModuleInstance) {
        // Evict previous primary-slot actions (scope == None). Any named-module
        // actions (scope == Some(_)) are left intact.
        self.action_module_map
            .retain(|_, scope| scope.is_some());
        for action in &module.module.actions {
            self.action_module_map
                .insert(action.clone(), None);
        }
        self.module = Some(module);
    }

    /// Register a named module for multi-module apps.
    ///
    /// Also registers the module's declared actions in the action->module map
    /// so that `update_state` after `dispatch_action` automatically routes
    /// to the correct module. If a named module with this key was already
    /// registered, its previous action entries are evicted first to prevent
    /// stale routing.
    pub fn register_module(&mut self, name: impl Into<String>, module: ModuleInstance) {
        let name = name.into().to_lowercase();
        // Evict any existing entries owned by this scope before re-registering.
        self.action_module_map
            .retain(|_, scope| scope.as_deref() != Some(name.as_str()));
        for action in &module.module.actions {
            self.action_module_map
                .insert(action.clone(), Some(name.clone()));
        }
        self.modules.insert(name, module);
    }

    /// Get a named module's state (for reconciler lookups).
    pub fn get_module_state(&self, name: &str) -> Option<&serde_json::Value> {
        self.modules.get(name).map(|m| m.get_state())
    }

    // ── State Updates ──────────────────────────────────────────────────

    /// Canonicalize a scope: returns `None` for the primary slot, otherwise
    /// the lowercased module name. Lets callers pass scopes in any case
    /// without worrying about matching the engine's internal convention.
    fn canon_scope(scope: Option<&str>) -> Option<String> {
        scope
            .filter(|s| !s.is_empty())
            .map(|s| s.to_lowercase())
    }

    /// Apply a state patch and schedule affected nodes for re-render.
    ///
    /// `scope` selects which module's state slot is updated:
    /// - `None` → primary module (`self.module`)
    /// - `Some(name)` → named module in `self.modules`. Case is normalized
    ///   to match the lowercased key used by [`register_module`], so callers
    ///   can pass any casing.
    ///
    /// Returns `true` if state actually changed (so callers can skip
    /// rendering when the patch was a no-op). Affected nodes are looked up
    /// using the same scope: primary updates invalidate raw paths, named
    /// updates invalidate `mod:name:path`.
    pub fn update_state(&mut self, scope: Option<&str>, patch: serde_json::Value) -> bool {
        let scope = Self::canon_scope(scope);
        let changed = match scope.as_deref() {
            Some(name) => match self.modules.get_mut(name) {
                Some(module) => {
                    let old = module.get_state_shared();
                    module.update_state(patch.clone());
                    *module.get_state() != *old
                }
                None => return false,
            },
            None => match &mut self.module {
                Some(module) => {
                    let old = module.get_state_shared();
                    module.update_state(patch.clone());
                    *module.get_state() != *old
                }
                None => return false,
            },
        };

        if !changed {
            return false;
        }

        let change = StateChange::from_json(&patch);
        self.schedule_dirty_for_paths(scope.as_deref(), change.paths());
        true
    }

    /// Apply a sparse state patch (path-value pairs) and schedule re-render.
    ///
    /// See [`update_state`] for `scope` semantics. Sparse updates only touch
    /// the listed paths, which is more efficient than passing a deep clone of
    /// the full state when only a few leaves changed.
    pub fn update_state_sparse(
        &mut self,
        scope: Option<&str>,
        paths: &[String],
        values: &serde_json::Value,
    ) -> bool {
        let scope = Self::canon_scope(scope);
        let changed = match scope.as_deref() {
            Some(name) => match self.modules.get_mut(name) {
                Some(module) => {
                    let old = module.get_state_shared();
                    module.update_state_sparse(paths, values);
                    *module.get_state() != *old
                }
                None => return false,
            },
            None => match &mut self.module {
                Some(module) => {
                    let old = module.get_state_shared();
                    module.update_state_sparse(paths, values);
                    *module.get_state() != *old
                }
                None => return false,
            },
        };

        if !changed {
            return false;
        }

        self.schedule_dirty_for_paths(scope.as_deref(), paths.iter().map(|s| s.as_str()));
        true
    }

    /// Mark every node bound to one of `paths` (under `scope`) as dirty.
    fn schedule_dirty_for_paths<'p>(
        &mut self,
        scope: Option<&str>,
        paths: impl IntoIterator<Item = &'p str>,
    ) {
        let mut affected_nodes = indexmap::IndexSet::new();
        for path in paths {
            let key = match scope {
                Some(name) => format!("mod:{}:{}", name, path),
                None => path.to_string(),
            };
            affected_nodes.extend(self.dependencies.get_affected_nodes(&key));
        }
        self.scheduler
            .mark_many_dirty(affected_nodes.iter().copied());
    }

    /// Schedule dirty nodes from a `StateChange` (primary module paths).
    pub fn schedule_from_state_change(&mut self, change: &StateChange) {
        let mut affected_nodes = indexmap::IndexSet::new();
        for path in change.paths() {
            affected_nodes.extend(self.dependencies.get_affected_nodes(path));
        }
        self.scheduler
            .mark_many_dirty(affected_nodes.iter().copied());
    }

    // ── Data Source Context ────────────────────────────────────────────

    /// Set (or replace) a named data source context.
    ///
    /// Registers the provider in the dependency graph (if not already known),
    /// stores the data, and marks **every** node bound to anything under
    /// `ds:{name}:…` (including deeply nested paths like
    /// `ds:spacetime:user.name`) as dirty. The caller must call
    /// `render_dirty()` afterwards.
    ///
    /// Note: this replaces the entire provider blob, so we invalidate every
    /// subscriber regardless of which nested key changed — there is no sparse
    /// diff. Hosts that want granular invalidation should construct their
    /// own patch strategy at the SDK layer.
    pub fn set_context(&mut self, name: &str, data: serde_json::Value) {
        self.dependencies.register_data_source_provider(name);

        let affected = self.dependencies.get_data_source_affected_nodes(name);

        self.data_sources.insert(name.to_string(), data);

        if !affected.is_empty() {
            self.scheduler
                .mark_many_dirty(affected.iter().copied());
        }
    }

    /// Classify an action name as a data-source action and build the
    /// `{provider, method, payload}` envelope all FFI bindings forward to
    /// their data-source action handler.
    ///
    /// Returns `None` when `name` doesn't contain a `.`, or when the prefix
    /// before the `.` isn't a registered data-source provider. Bindings call
    /// this on the fall-through path of `dispatch_action` after exact-match
    /// handler lookup fails, so the same routing rules live in one place.
    #[cfg_attr(
        not(all(target_arch = "wasm32", any(feature = "js", feature = "wasi"))),
        allow(dead_code)
    )]
    pub fn build_data_source_action(
        &self,
        name: &str,
        payload: serde_json::Value,
    ) -> Option<serde_json::Value> {
        let dot = name.find('.')?;
        let provider = &name[..dot];
        if !self.data_sources.contains_key(provider) {
            return None;
        }
        let method = &name[dot + 1..];
        Some(serde_json::json!({
            "provider": provider,
            "method": method,
            "payload": payload,
        }))
    }

    /// Remove a data source context entirely and mark bound nodes dirty.
    /// The caller must call `render_dirty()` afterwards.
    pub fn remove_context(&mut self, name: &str) {
        self.data_sources.shift_remove(name);

        let affected = self.dependencies.get_data_source_affected_nodes(name);
        if !affected.is_empty() {
            self.scheduler
                .mark_many_dirty(affected.iter().copied());
        }
    }

    // ── Rendering ──────────────────────────────────────────────────────

    /// Expand components, resolve icons, and reconcile an IR node against the
    /// current tree, returning the resulting patches. Clears and rebuilds the
    /// dependency graph.
    pub fn render_ir_node(&mut self, ir_node: &IRNode) -> Vec<Patch> {
        let mut expanded = self.component_registry.expand_ir_node(ir_node);

        if !self.resource_registry.is_empty() {
            crate::ir::resolve_icons_in_ir(&self.resource_registry, &mut expanded);
        }

        // Auto-register placeholder modules for any module_scope values
        // found in the expanded IR that aren't already registered.
        self.auto_register_scoped_modules(&expanded);

        let state: &serde_json::Value = self
            .module
            .as_ref()
            .map(|m| m.get_state())
            .unwrap_or(&NULL_STATE);

        self.dependencies.clear();

        let ds = if self.data_sources.is_empty() {
            None
        } else {
            Some(&self.data_sources)
        };
        let mods = if self.modules.is_empty() {
            None
        } else {
            Some(&self.modules)
        };
        let patches = reconcile_ir_with_ds(
            &mut self.tree,
            &expanded,
            None,
            state,
            &mut self.dependencies,
            ds,
            mods,
        );

        self.revision += 1;
        patches
    }

    /// Render only dirty nodes and return the resulting patches.
    pub fn render_dirty(&mut self) -> Vec<Patch> {
        let ds = if self.data_sources.is_empty() {
            None
        } else {
            Some(&self.data_sources)
        };
        let mods = if self.modules.is_empty() {
            None
        } else {
            Some(&self.modules)
        };
        let patches = crate::render::render_dirty_nodes_full(
            &mut self.scheduler,
            &mut self.tree,
            self.module.as_ref(),
            &mut self.dependencies,
            ds,
            mods,
        );

        if !patches.is_empty() {
            self.revision += 1;
        }

        patches
    }

    /// Filter out Remove patches for elements that were Created in the same
    /// batch. This happens when a conditional re-reconciles module-scoped
    /// children whose stored template doesn't carry module_scope.
    pub fn filter_spurious_removes(patches: &mut Vec<Patch>) {
        let created_ids: std::collections::HashSet<String> = patches
            .iter()
            .filter_map(|p| {
                if let Patch::Create { id, .. } = p {
                    Some(id.clone())
                } else {
                    None
                }
            })
            .collect();
        if !created_ids.is_empty() {
            patches.retain(|p| {
                if let Patch::Remove { id } = p {
                    !created_ids.contains(id)
                } else {
                    true
                }
            });
        }
    }

    /// Look up which named module owns an action and return its scope, if any.
    ///
    /// Returns:
    /// - `Some(name)` — action is owned by a named module registered via
    ///   [`register_module`]. Polling bindings route follow-up `update_state`
    ///   calls to that module.
    /// - `None` — action is either owned by the primary module (installed via
    ///   [`set_module`]) or not registered at all. In both cases polling
    ///   bindings should route follow-up updates to the primary slot, which
    ///   is the correct default.
    pub fn action_scope_for(&self, action_name: &str) -> Option<String> {
        self.action_module_map
            .get(action_name)
            .cloned()
            .flatten()
    }

    /// Scan an expanded IR tree for `module_scope` values and auto-register
    /// placeholder modules for any scopes not already in `self.modules`.
    /// Skips scopes that match the primary module (by name, or the first scope
    /// when the primary module has a generic/anonymous name).
    pub fn auto_register_scoped_modules(&mut self, ir_node: &IRNode) {
        let mut scopes = HashSet::new();
        collect_module_scopes_ir(ir_node, &mut scopes);

        if scopes.is_empty() {
            return;
        }

        // Determine which scope belongs to the primary module.
        // If the primary module's name matches a scope, skip it.
        // If the primary module has an anonymous/generic name, the FIRST scope
        // in the expanded IR (typically the root `module X {}` declaration)
        // is assumed to be the primary module.
        let primary_name = self
            .module
            .as_ref()
            .map(|m| m.module.name.to_lowercase());

        let primary_scope: Option<String> = if let Some(ref name) = primary_name {
            if scopes.contains(name.as_str()) {
                Some(name.clone())
            } else {
                // Primary module name doesn't match any scope — it's anonymous/generic.
                // Find the first scope that isn't already a registered named module.
                scopes
                    .iter()
                    .find(|s| !self.modules.contains_key(s.as_str()))
                    .cloned()
            }
        } else {
            None
        };

        for scope in scopes {
            if self.modules.contains_key(&scope) {
                continue;
            }
            if primary_scope.as_deref() == Some(scope.as_str()) {
                continue;
            }
            let module = Module::new(&scope);
            let instance = ModuleInstance::new(module, serde_json::json!({}));
            self.modules.insert(scope, instance);
        }
    }
}

fn collect_module_scopes_ir(node: &IRNode, scopes: &mut HashSet<String>) {
    crate::ir::walk::walk_ir(node, &mut |n| {
        if let IRNode::Element(element) = n {
            if let Some(ref scope) = element.module_scope {
                scopes.insert(scope.clone());
            }
        }
    });
}

impl Default for EngineCore {
    fn default() -> Self {
        Self::new()
    }
}
