//! Route discovery — walk an IR tree and enumerate every `Router { Route … }`
//! block with the element names that live inside each route's body.
//!
//! Used by the server SDKs to auto-wire a per-session `ManagedRouter`
//! without the example having to call `managed.addRoute(...)` for every
//! route. The SDK cross-references the BFS-ordered `element_names` list
//! against its `HypenApp` registry to pick the component to mount for
//! each path — first name that's a registered module wins, so templates
//! like `Route("/") { Column { HomePage() BottomNav() } }` still work
//! (HomePage is registered; Column / BottomNav are not).
//!
//! This helper walks the IR as-is: it does **not** trigger component
//! resolution. For nested routers (a Router inside another component's
//! template), call this again on the nested module's IR when that
//! module mounts — the walker returns every Router it finds, including
//! those scoped under `module_scope` markers, so the SDK can key nested
//! wirings by scope.

use super::{ConditionalBranch, IRNode, RouterRoute};
use serde::{Deserialize, Serialize};

/// One route inside a discovered Router, with the ordered list of
/// element names found inside the route body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiscoveredRoute {
    /// The URL pattern on the Route (e.g. `/`, `/user-profile/:id`).
    pub path: String,
    /// BFS-ordered element names inside this route's body. Wrapper
    /// elements (Column, Row, …) come before the actual component,
    /// so the SDK should scan until it finds a name that matches a
    /// registered `HypenApp` module.
    pub element_names: Vec<String>,
}

/// A `Router { ... }` block found in the IR.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiscoveredRouter {
    /// The module scope this Router lives under, if any. `None` means
    /// it was found at the document root (the primary module's
    /// template). Nested Routers inside `module Foo { ... }` carry
    /// `Some("foo")`.
    pub module_scope: Option<String>,
    pub routes: Vec<DiscoveredRoute>,
}

/// Walk an IR tree and return every `Router { Route … }` block it contains.
///
/// Discovery order is depth-first; nested routers appear after their
/// enclosing router. Empty routers (no routes) are still included.
pub fn discover_routers(ir: &IRNode) -> Vec<DiscoveredRouter> {
    let mut out = Vec::new();
    walk(ir, &mut out);
    out
}

fn walk(ir: &IRNode, out: &mut Vec<DiscoveredRouter>) {
    match ir {
        IRNode::Router {
            routes,
            fallback,
            module_scope,
            ..
        } => {
            let mut discovered = DiscoveredRouter {
                module_scope: module_scope.clone(),
                routes: Vec::with_capacity(routes.len()),
            };
            for route in routes {
                discovered.routes.push(DiscoveredRoute {
                    path: route.path.clone(),
                    element_names: collect_element_names(&route.children),
                });
            }
            out.push(discovered);

            // Recurse — a route body can host another Router block, and
            // fallback children can too. Nested discoveries need to
            // appear as separate DiscoveredRouter entries so the SDK
            // can wire them as nested managed routers.
            for route in routes {
                for child in &route.children {
                    walk(child, out);
                }
            }
            if let Some(fb) = fallback {
                for child in fb {
                    walk(child, out);
                }
            }
        }
        IRNode::Element(el) => {
            for child in &el.ir_children {
                walk(child, out);
            }
        }
        IRNode::ForEach { template, .. } => {
            for child in template {
                walk(child, out);
            }
        }
        IRNode::Conditional {
            branches, fallback, ..
        } => {
            for branch in branches {
                for child in &branch.children {
                    walk(child, out);
                }
            }
            if let Some(fb) = fallback {
                for child in fb {
                    walk(child, out);
                }
            }
        }
    }
}

/// BFS-ordered collection of every Element name reachable from the
/// supplied node list, *stopping* at the first match for each branch
/// so the scan mirrors the DSL's top-down reading order. ForEach /
/// Conditional / Router children are included at their natural depth.
fn collect_element_names(children: &[IRNode]) -> Vec<String> {
    let mut names = Vec::new();
    let mut queue: std::collections::VecDeque<&IRNode> =
        children.iter().collect();
    while let Some(node) = queue.pop_front() {
        match node {
            IRNode::Element(el) => {
                names.push(el.element_type.clone());
                for child in &el.ir_children {
                    queue.push_back(child);
                }
            }
            IRNode::ForEach { template, .. } => {
                for child in template {
                    queue.push_back(child);
                }
            }
            IRNode::Conditional {
                branches, fallback, ..
            } => {
                for ConditionalBranch { children, .. } in branches {
                    for child in children {
                        queue.push_back(child);
                    }
                }
                if let Some(fb) = fallback {
                    for child in fb {
                        queue.push_back(child);
                    }
                }
            }
            IRNode::Router { routes, fallback, .. } => {
                for RouterRoute { children, .. } in routes {
                    for child in children {
                        queue.push_back(child);
                    }
                }
                if let Some(fb) = fallback {
                    for child in fb {
                        queue.push_back(child);
                    }
                }
            }
        }
    }
    names
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ir::ast_to_ir_node;

    fn parse(source: &str) -> IRNode {
        let doc = hypen_parser::parse_document(source).expect("parse");
        let component = doc.components.first().expect("has component");
        ast_to_ir_node(component)
    }

    #[test]
    fn discovers_flat_router() {
        let ir = parse(
            r#"
            module App {
                Router {
                    Route(path: "/") { HomePage() }
                    Route(path: "/search") { Search() }
                }
            }
            "#,
        );
        let routers = discover_routers(&ir);
        assert_eq!(routers.len(), 1);
        let r = &routers[0];
        assert_eq!(r.module_scope.as_deref(), Some("app"));
        assert_eq!(r.routes.len(), 2);
        assert_eq!(r.routes[0].path, "/");
        assert_eq!(r.routes[0].element_names, vec!["HomePage"]);
        assert_eq!(r.routes[1].path, "/search");
        assert_eq!(r.routes[1].element_names, vec!["Search"]);
    }

    #[test]
    fn discovers_component_through_wrappers() {
        // The Social pattern: Column wrapping the real component.
        let ir = parse(
            r#"
            module App {
                Router {
                    Route(path: "/") {
                        Column {
                            HomePage()
                            BottomNav()
                        }
                    }
                }
            }
            "#,
        );
        let routers = discover_routers(&ir);
        assert_eq!(routers.len(), 1);
        // BFS: Column first, then HomePage + BottomNav. Consumer picks
        // the first one registered as a module.
        assert_eq!(
            routers[0].routes[0].element_names,
            vec!["Column", "HomePage", "BottomNav"]
        );
    }

    #[test]
    fn discovers_route_params() {
        let ir = parse(
            r#"
            module App {
                Router {
                    Route(path: "/user-profile/:id") { UserProfile() }
                    Route(path: "/comments/:postId") { Comments() }
                }
            }
            "#,
        );
        let routers = discover_routers(&ir);
        assert_eq!(routers[0].routes[0].path, "/user-profile/:id");
        assert_eq!(routers[0].routes[1].path, "/comments/:postId");
    }

    #[test]
    fn discovers_nested_routers() {
        // Pattern the user called out: an outer Router with a Route
        // whose body itself contains a Router. We emit both.
        let ir = parse(
            r#"
            module App {
                Router {
                    Route(path: "/") {
                        Column {
                            Home()
                            Router {
                                Route(path: "/") { Feed() }
                                Route(path: "/explore") { Explore() }
                            }
                        }
                    }
                }
            }
            "#,
        );
        let routers = discover_routers(&ir);
        assert_eq!(routers.len(), 2);
        assert_eq!(routers[0].routes[0].path, "/");
        assert_eq!(routers[1].routes.len(), 2);
        assert_eq!(routers[1].routes[0].path, "/");
        assert_eq!(routers[1].routes[1].path, "/explore");
    }

    #[test]
    fn no_routers_returns_empty() {
        let ir = parse(
            r#"
            module App {
                Column {
                    Text("No routes here")
                    Button("Click me")
                }
            }
            "#,
        );
        assert!(discover_routers(&ir).is_empty());
    }
}
