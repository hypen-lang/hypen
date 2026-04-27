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
