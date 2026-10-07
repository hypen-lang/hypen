//! Generic IRNode tree walkers.
//!
//! These helpers eliminate the boilerplate of dispatching across every
//! `IRNode` variant when implementing tree-wide visitors that don't
//! transform shape (i.e. mutate-in-place or accumulate state). The
//! visitor closure is called pre-order on every node; the walker is
//! responsible for descending into all children.
//!
//! For shape-changing transformations (returning a new tree), keep
//! writing the explicit match — the walker pattern doesn't help when
//! every variant has to be reconstructed.

use super::IRNode;
use crate::reactive::{Binding, BindingSource};

/// Walk an IRNode tree in pre-order, calling `f` on every node.
///
/// Recursion descends into the *current* (post-mutation) children, so
/// the visitor may safely rewrite the visited node as long as it leaves
/// a valid IRNode in place.
pub fn walk_ir_mut<F>(node: &mut IRNode, f: &mut F)
where
    F: FnMut(&mut IRNode),
{
    f(node);
    match node {
        IRNode::Element(element) => {
            for child in &mut element.ir_children {
                walk_ir_mut(child, f);
            }
        }
        IRNode::ForEach { template, .. } => {
            for child in template {
                walk_ir_mut(child, f);
            }
        }
        IRNode::Conditional {
            branches, fallback, ..
        } => {
            for branch in branches {
                for child in &mut branch.children {
                    walk_ir_mut(child, f);
                }
            }
            if let Some(fb) = fallback {
                for child in fb {
                    walk_ir_mut(child, f);
                }
            }
        }
        IRNode::Router {
            routes, fallback, ..
        } => {
            for route in routes {
                for child in &mut route.children {
                    walk_ir_mut(child, f);
                }
            }
            if let Some(fb) = fallback {
                for child in fb {
                    walk_ir_mut(child, f);
                }
            }
        }
    }
}

/// Immutable counterpart of [`walk_ir_mut`]. Pre-order visit, walker
/// owns the recursion.
pub fn walk_ir<F>(node: &IRNode, f: &mut F)
where
    F: FnMut(&IRNode),
{
    f(node);
    match node {
        IRNode::Element(element) => {
            for child in &element.ir_children {
                walk_ir(child, f);
            }
        }
        IRNode::ForEach { template, .. } => {
            for child in template {
                walk_ir(child, f);
            }
        }
        IRNode::Conditional {
            branches, fallback, ..
        } => {
            for branch in branches {
                for child in &branch.children {
                    walk_ir(child, f);
                }
            }
            if let Some(fb) = fallback {
                for child in fb {
                    walk_ir(child, f);
                }
            }
        }
        IRNode::Router {
            routes, fallback, ..
        } => {
            for route in routes {
                for child in &route.children {
                    walk_ir(child, f);
                }
            }
            if let Some(fb) = fallback {
                for child in fb {
                    walk_ir(child, f);
                }
            }
        }
    }
}

/// One enclosing `ForEach`, as seen from inside its template.
///
/// A row binding — `@item.sku`, or `@product.sku` under `as: product` — names
/// nothing on its own: which collection it reads, and which name stands for
/// the row, are both properties of the loop that encloses it. The frame
/// carries exactly those two facts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForEachFrame {
    /// The loop's `as:` name — `item` unless the developer chose another.
    pub item_name: String,
    /// Absolute module-state path of the collection, with `*` standing for
    /// each enclosing row: `products` for a top-level list, and
    /// `products.*.variants` for a list nested inside its rows. `None` when
    /// the collection does not live in module state at all — a data-source
    /// list (`@spacetime.messages`), or a list nested under such a frame —
    /// so nothing read through it can be spelled as a state path.
    pub collection: Option<String>,
    /// Module owning the collection; row references cannot grant another module reads.
    pub module_scope: Option<String>,
}

/// Where in the template a visited node sits.
///
/// Position is what turns a raw capability into an addressable one: a bind
/// under `Route(path: "/settings")` is a field of *that screen*, and the same
/// bind inside a `ForEach` template is not one field at all but one per row,
/// with no way to name which. Both facts are invisible to the node itself —
/// only the path taken to reach it carries them.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WalkCtx {
    /// Pattern of the innermost enclosing `Route`, if any. A `Router`'s
    /// fallback children inherit the enclosing route rather than claiming one,
    /// because the fallback is what renders when no route matched.
    pub route: Option<String>,
    /// Every enclosing `ForEach`, outermost first. Sticky: a nested `Route`
    /// under a repeated row does not make its contents addressable again.
    pub frames: Vec<ForEachFrame>,
}

impl WalkCtx {
    /// True anywhere inside a `ForEach` template.
    pub fn in_for_each(&self) -> bool {
        !self.frames.is_empty()
    }

    /// The loop whose row a binding reads, if the binding is a row reference.
    ///
    /// Mirrors how the reconciler substitutes rows, so this classifies exactly
    /// what iteration will fill in:
    ///
    /// * `@{item.x}` (`BindingSource::Item`) is substituted by every enclosing
    ///   loop regardless of its `as:` name, outermost pass first — so it reads
    ///   the innermost loop *named* `item` when one exists, else the innermost
    ///   loop of all.
    /// * `@{product.x}` under `as: product` never parses as an item binding
    ///   (`parse_binding` admits only `state.` and `item.`); it reaches the IR
    ///   as `BindingSource::DataSource("product")` and is recognised at
    ///   substitution time by name. The same name match is applied here. A
    ///   real data source shadowed by an `as:` name is the developer's
    ///   collision, resolved the way the reconciler resolves it: as the row.
    /// * A state binding is never a row reference.
    ///
    /// Not gated on [`Self::in_for_each`]: with no frames there is nothing to
    /// match, so the answer is `None` by construction.
    pub fn frame_for(&self, binding: &Binding) -> Option<&ForEachFrame> {
        match &binding.source {
            BindingSource::Item => self
                .frames
                .iter()
                .rev()
                .find(|f| f.item_name == "item")
                .or_else(|| self.frames.last()),
            BindingSource::DataSource(name) => {
                self.frames.iter().rev().find(|f| f.item_name == *name)
            }
            BindingSource::State => None,
        }
    }

    /// The absolute module-state path a binding reads, with `*` in place of
    /// every row index it is evaluated under.
    ///
    /// `@{state.user.name}` is `user.name` wherever it sits. `@{item.sku}`
    /// under `List(@state.products)` is `products.*.sku`; the bare `@{item}`
    /// is `products.*` — the whole row. A row reference under a loop whose
    /// collection is not module state (see [`ForEachFrame::collection`]) has
    /// no state path and yields `None`, as does a binding that is neither
    /// state nor a row of any enclosing loop.
    pub fn state_path(&self, binding: &Binding) -> Option<String> {
        match &binding.source {
            BindingSource::State => Some(binding.full_path()),
            _ => {
                let collection = self.frame_for(binding)?.collection.as_deref()?;
                Some(row_path(collection, &binding.path))
            }
        }
    }
}

/// `collection.*` joined with a path inside the row: `products` + `["sku"]`
/// is `products.*.sku`, and an empty path is the row itself, `products.*`.
fn row_path(collection: &str, path: &[String]) -> String {
    let mut out = format!("{collection}.*");
    for segment in path {
        out.push('.');
        out.push_str(segment);
    }
    out
}

/// Pre-order walk carrying positional context.
///
/// [`walk_ir`] stays as it is — most visitors only care about the nodes, and
/// paying for context they ignore would be a tax on every existing caller.
pub fn walk_ir_ctx<F>(node: &IRNode, f: &mut F)
where
    F: FnMut(&IRNode, &WalkCtx),
{
    walk_ctx(node, &WalkCtx::default(), f);
}

fn walk_ctx<F>(node: &IRNode, ctx: &WalkCtx, f: &mut F)
where
    F: FnMut(&IRNode, &WalkCtx),
{
    f(node, ctx);
    match node {
        IRNode::Element(element) => {
            for child in &element.ir_children {
                walk_ctx(child, ctx, f);
            }
        }
        IRNode::ForEach {
            source,
            item_name,
            module_scope,
            template,
            ..
        } => {
            // The collection is resolved against the frames already open, so
            // a loop over `@item.variants` inside a loop over `@state.products`
            // sits at `products.*.variants` — and one over a data source, or
            // under a data-source loop, resolves to no state path at all.
            let mut frames = ctx.frames.clone();
            frames.push(ForEachFrame {
                item_name: item_name.clone(),
                collection: if source.is_state()
                    || ctx
                        .frame_for(source)
                        .is_some_and(|frame| &frame.module_scope == module_scope)
                {
                    ctx.state_path(source)
                } else {
                    None
                },
                module_scope: module_scope.clone(),
            });
            let inner = WalkCtx {
                route: ctx.route.clone(),
                frames,
            };
            for child in template {
                walk_ctx(child, &inner, f);
            }
        }
        IRNode::Conditional {
            branches, fallback, ..
        } => {
            for branch in branches {
                for child in &branch.children {
                    walk_ctx(child, ctx, f);
                }
            }
            if let Some(fb) = fallback {
                for child in fb {
                    walk_ctx(child, ctx, f);
                }
            }
        }
        IRNode::Router {
            routes, fallback, ..
        } => {
            for route in routes {
                let inner = WalkCtx {
                    route: Some(route.path.clone()),
                    frames: ctx.frames.clone(),
                };
                for child in &route.children {
                    walk_ctx(child, &inner, f);
                }
            }
            if let Some(fb) = fallback {
                for child in fb {
                    walk_ctx(child, ctx, f);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ir::{ast_to_ir_node, IRNode};

    fn parse(source: &str) -> IRNode {
        let doc = hypen_parser::parse_document(source).expect("parse");
        ast_to_ir_node(doc.components.first().expect("has component"))
    }

    /// Collect `(element_type, ctx)` for every element, so the assertions
    /// read as "where did this node turn out to be".
    fn positions(root: &IRNode) -> Vec<(String, WalkCtx)> {
        let mut out = Vec::new();
        walk_ir_ctx(root, &mut |node, ctx| {
            if let IRNode::Element(element) = node {
                out.push((element.element_type.clone(), ctx.clone()));
            }
        });
        out
    }

    #[test]
    fn a_node_carries_the_route_that_encloses_it() {
        let ir = parse(
            r#"
            module App {
                Column {
                    Input(placeholder: "Search").bind(@state.query)
                    Router {
                        Route(path: "/settings") { Switch {}.bind(@state.dark) }
                        Route(path: "/user/:id") { Text("user") }
                    }
                }
            }
            "#,
        );
        let seen = positions(&ir);
        let route_of = |ty: &str| {
            seen.iter()
                .find(|(t, _)| t == ty)
                .unwrap_or_else(|| panic!("no {ty}"))
                .1
                .route
                .clone()
        };

        // The shell's own input belongs to no route; each route's body
        // belongs to the route that encloses it, pattern verbatim.
        assert_eq!(route_of("Input"), None);
        assert_eq!(route_of("Switch"), Some("/settings".to_string()));
        assert_eq!(route_of("Text"), Some("/user/:id".to_string()));
    }

    #[test]
    fn for_each_marks_its_whole_template_and_nothing_outside() {
        let ir = parse(
            r#"
            module App {
                Column {
                    Input(placeholder: "New").bind(@state.draft)
                    List(@state.todos, as: todo) {
                        Row { Checkbox {}.bind(@todo.done) }
                    }
                }
            }
            "#,
        );
        let seen = positions(&ir);
        let in_for_each = |ty: &str| {
            seen.iter()
                .find(|(t, _)| t == ty)
                .unwrap_or_else(|| panic!("no {ty}"))
                .1
                .in_for_each()
        };

        assert!(
            !in_for_each("Input"),
            "the sibling above the list is one field"
        );
        // Sticky through the nesting: the row wrapper and the control inside
        // it are both per-row, and neither is addressable on its own.
        assert!(in_for_each("Row"));
        assert!(in_for_each("Checkbox"));
    }

    /// The frame stack seen at the element of the given type.
    fn frames_at(root: &IRNode, ty: &str) -> Vec<ForEachFrame> {
        let mut found = None;
        walk_ir_ctx(root, &mut |node, ctx| {
            if let IRNode::Element(element) = node {
                if element.element_type == ty && found.is_none() {
                    found = Some(ctx.frames.clone());
                }
            }
        });
        found.unwrap_or_else(|| panic!("no {ty}"))
    }

    #[test]
    fn a_for_each_frame_carries_its_name_and_its_state_collection() {
        let ir = parse(
            r#"
            module App {
                List(@state.products, as: product) {
                    Text("@{product.title}")
                }
            }
            "#,
        );
        assert_eq!(
            frames_at(&ir, "Text"),
            vec![ForEachFrame {
                item_name: "product".to_string(),
                collection: Some("products".to_string()),
                module_scope: Some("app".to_string()),
            }]
        );
    }

    #[test]
    fn a_nested_for_each_resolves_its_collection_through_the_parent_row() {
        let ir = parse(
            r#"
            module App {
                List(@state.products, as: product) {
                    List(@product.variants, as: v) { Text("@{v.size}") }
                    List(@item.tags) { Row {} }
                }
            }
            "#,
        );
        // `@product.variants` is a row reference by name, and `@item.tags`
        // by the reserved spelling; both land under `products.*`.
        assert_eq!(
            frames_at(&ir, "Text")[1].collection.as_deref(),
            Some("products.*.variants")
        );
        assert_eq!(
            frames_at(&ir, "Row")[1].collection.as_deref(),
            Some("products.*.tags")
        );
    }

    #[test]
    fn a_data_source_for_each_has_no_state_collection() {
        let ir = parse(
            r#"
            module App {
                List(@spacetime.messages, as: m) {
                    Text("@{m.body}")
                    List(@m.replies, as: r) { Row {} }
                }
            }
            "#,
        );
        assert_eq!(frames_at(&ir, "Text")[0].collection, None);
        // Nested under a data-source loop: still no state path to extend.
        assert_eq!(frames_at(&ir, "Row")[1].collection, None);
    }

    #[test]
    fn row_bindings_resolve_to_wildcard_state_paths() {
        use crate::reactive::Binding;

        let ctx = WalkCtx {
            route: None,
            frames: vec![
                ForEachFrame {
                    item_name: "item".to_string(),
                    collection: Some("products".to_string()),
                    module_scope: Some("app".to_string()),
                },
                ForEachFrame {
                    item_name: "v".to_string(),
                    collection: Some("products.*.variants".to_string()),
                    module_scope: Some("app".to_string()),
                },
            ],
        };

        // A custom name reads the loop that declared it; the reserved `item`
        // reads the innermost loop *named* item, exactly as the reconciler's
        // outermost-first substitution would fill it.
        assert_eq!(
            ctx.state_path(&Binding::data_source("v", vec!["size".into()]))
                .as_deref(),
            Some("products.*.variants.*.size")
        );
        assert_eq!(
            ctx.state_path(&Binding::item(vec!["sku".into()]))
                .as_deref(),
            Some("products.*.sku")
        );
        // The bare row is the row.
        assert_eq!(
            ctx.state_path(&Binding::data_source("v", vec![]))
                .as_deref(),
            Some("products.*.variants.*")
        );
        // State is state wherever it sits; an unrelated provider is nothing.
        assert_eq!(
            ctx.state_path(&Binding::state(vec!["user".into(), "name".into()]))
                .as_deref(),
            Some("user.name")
        );
        assert_eq!(
            ctx.state_path(&Binding::data_source("spacetime", vec!["messages".into()])),
            None
        );

        // With no loop named `item`, the reserved spelling falls back to the
        // innermost loop — the one whose substitution pass reaches it.
        let custom_only = WalkCtx {
            route: None,
            frames: vec![ForEachFrame {
                item_name: "product".to_string(),
                collection: Some("products".to_string()),
                module_scope: Some("app".to_string()),
            }],
        };
        assert_eq!(
            custom_only
                .state_path(&Binding::item(vec!["sku".into()]))
                .as_deref(),
            Some("products.*.sku")
        );
        assert_eq!(
            WalkCtx::default().state_path(&Binding::item(vec!["sku".into()])),
            None
        );
    }
}
