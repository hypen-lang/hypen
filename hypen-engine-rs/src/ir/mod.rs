pub mod anim;
pub mod component;
pub mod conformance;
pub mod discover;
pub mod dnd;
pub mod expand;
pub mod icon;
pub mod node;
pub mod semantics;
pub mod span;
pub mod walk;

pub use component::{
    Component, ComponentRegistry, ComponentResolver, ResolvedComponent, DEFAULT_PRIMITIVES,
};
pub use conformance::{
    check_accessibility, check_accessibility_source, check_accessibility_source_located,
    check_accessibility_trees, A11yDiagnostic, A11yRule, LocatedDiagnostic,
};
pub use discover::{discover_routers, DiscoveredRoute, DiscoveredRouter};
pub use expand::ast_to_ir_node;
pub use icon::{parse_svg, resolve_icons_in_ir, IconData, IconPath, ResourceRegistry};
pub use node::{ConditionalBranch, Element, IRNode, NodeId, Props, RouterRoute, Value};
pub use semantics::{Role, Semantics};
pub use span::{LineIndex, SourceSpan};
