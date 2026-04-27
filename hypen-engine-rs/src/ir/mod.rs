pub mod component;
pub mod discover;
pub mod expand;
pub mod icon;
pub mod node;
pub mod walk;

pub use component::{
    Component, ComponentRegistry, ComponentResolver, ResolvedComponent, DEFAULT_PRIMITIVES,
};
pub use discover::{discover_routers, DiscoveredRoute, DiscoveredRouter};
pub use expand::ast_to_ir_node;
pub use icon::{parse_svg, resolve_icons_in_ir, IconData, IconPath, ResourceRegistry};
pub use node::{ConditionalBranch, Element, IRNode, NodeId, Props, RouterRoute, Value};
