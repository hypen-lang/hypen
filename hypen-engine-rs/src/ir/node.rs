use crate::reactive::Binding;
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use slotmap::new_key_type;
use std::sync::Arc;

// Stable, unique node identifier for reconciliation
new_key_type! {
    pub struct NodeId;
}

/// IR value - either static or a binding to reactive state
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Value {
    /// Static value (string, number, bool, etc.)
    Static(serde_json::Value),
    /// Binding to state: parsed from @{state.user.name}
    Binding(Binding),
    /// Template string with embedded bindings: "Count: @{state.count}"
    /// Stores the template string and all bindings found within it
    TemplateString {
        template: String,
        bindings: Vec<Binding>,
    },
    /// Action reference: @actions.signIn
    Action(String),
    /// Resource reference: @resources.heart
    Resource(String),
}

/// First-class IR node - distinguishes between regular elements and control flow constructs
/// This provides type-safe pattern matching in the reconciler and clear separation of concerns
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum IRNode {
    /// Regular UI element (Text, Column, Button, etc.)
    Element(Element),

    /// Iteration construct: ForEach(items: @{state.todos}, as: "todo", key: "id") { children }
    /// Renders template children for each item in an array
    ForEach {
        /// The binding to the array in state (e.g., @{state.todos})
        source: Binding,
        /// The variable name for each item (default: "item", can be "todo", "user", etc.)
        item_name: String,
        /// Optional path to use as key for stable reconciliation (e.g., "id")
        key_path: Option<String>,
        /// Template children to repeat for each item
        template: Vec<IRNode>,
        /// Additional props for the container element
        props: Props,
        /// Enclosing module scope (propagated from `module <Name> { ... }` in the
        /// DSL). When the named module is registered, the source array binding
        /// resolves and registers under that module's state slot.
        module_scope: Option<String>,
    },

    /// Conditional construct: When(value: @{state.status}) { Case(match: "loading") {...} Else {...} }
    /// Renders matching branch based on evaluated value
    Conditional {
        /// The value to match against (binding or static)
        value: Value,
        /// Branches with patterns to match
        branches: Vec<ConditionalBranch>,
        /// Fallback if no branch matches (Else)
        fallback: Option<Vec<IRNode>>,
        /// Enclosing module scope (propagated from `module <Name> { ... }` in the
        /// DSL). When the named module is registered, the condition value
        /// resolves and registers under that module's state slot.
        module_scope: Option<String>,
    },

    /// Router construct: Router { Route(path: "/foo") { ... } Route(path: "/bar") { ... } }
    /// Renders the route whose path matches the current location.
    ///
    /// Routing is engine-side: the engine reads the location binding (default
    /// `state.location`), matches it against each `Route(path: ...)`, and
    /// renders only that route's children. When `location` changes, the
    /// dependency graph dirties this node and the matching route is swapped
    /// in via normal patches — no renderer-side routing is required.
    Router {
        /// Binding to the current location string. Defaults to `state.location`
        /// when the DSL doesn't specify `Router(value: @{state.x})`.
        location: Value,
        /// Ordered route table. First match wins.
        routes: Vec<RouterRoute>,
        /// Optional fallback children rendered when no route matches.
        fallback: Option<Vec<IRNode>>,
        /// Enclosing module scope (propagated from `module <Name> { ... }` in
        /// the DSL). When set, the location binding resolves under that
        /// module's state slot.
        module_scope: Option<String>,
    },
}

/// A conditional branch with a pattern and children
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConditionalBranch {
    /// The pattern to match against the conditional value
    pub pattern: Value,
    /// Children to render if this branch matches
    pub children: Vec<IRNode>,
}

/// A router route with a path pattern and children to render when matched.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RouterRoute {
    /// URL path pattern. Currently exact match; `:param` segments are
    /// reserved for future support.
    pub path: String,
    /// Children to render when the current location matches `path`.
    pub children: Vec<IRNode>,
}

impl RouterRoute {
    pub fn new(path: impl Into<String>, children: Vec<IRNode>) -> Self {
        Self {
            path: path.into(),
            children,
        }
    }
}

impl IRNode {
    /// Create an Element IRNode
    pub fn element(element: Element) -> Self {
        IRNode::Element(element)
    }

    /// Create a ForEach IRNode
    pub fn for_each(
        source: Binding,
        item_name: impl Into<String>,
        key_path: Option<String>,
        template: Vec<IRNode>,
        props: Props,
    ) -> Self {
        IRNode::ForEach {
            source,
            item_name: item_name.into(),
            key_path,
            template,
            props,
            module_scope: None,
        }
    }

    /// Create a Conditional IRNode (When/If)
    pub fn conditional(
        value: Value,
        branches: Vec<ConditionalBranch>,
        fallback: Option<Vec<IRNode>>,
    ) -> Self {
        IRNode::Conditional {
            value,
            branches,
            fallback,
            module_scope: None,
        }
    }

    /// Create a Router IRNode
    pub fn router(
        location: Value,
        routes: Vec<RouterRoute>,
        fallback: Option<Vec<IRNode>>,
    ) -> Self {
        IRNode::Router {
            location,
            routes,
            fallback,
            module_scope: None,
        }
    }

    /// Get the element if this is an Element variant
    pub fn as_element(&self) -> Option<&Element> {
        match self {
            IRNode::Element(e) => Some(e),
            _ => None,
        }
    }

    /// Check if this is a ForEach node
    pub fn is_for_each(&self) -> bool {
        matches!(self, IRNode::ForEach { .. })
    }

    /// Check if this is a Conditional node
    pub fn is_conditional(&self) -> bool {
        matches!(self, IRNode::Conditional { .. })
    }

    /// Check if this is a Router node
    pub fn is_router(&self) -> bool {
        matches!(self, IRNode::Router { .. })
    }
}

impl ConditionalBranch {
    /// Create a new conditional branch
    pub fn new(pattern: Value, children: Vec<IRNode>) -> Self {
        Self { pattern, children }
    }
}

/// Properties map type (underlying storage)
pub type PropsMap = IndexMap<String, Value>;

/// Arc-wrapped properties for O(1) clone with copy-on-write semantics.
///
/// This enables efficient Element cloning during reconciliation while
/// preserving the ability to modify props when needed via `make_mut()`.
#[derive(Debug, Clone)]
pub struct Props(Arc<PropsMap>);

impl Props {
    /// Create empty props
    pub fn new() -> Self {
        Props(Arc::new(IndexMap::new()))
    }

    /// Create props from an IndexMap
    pub fn from_map(map: PropsMap) -> Self {
        Props(Arc::new(map))
    }

    /// Get mutable access to props (copy-on-write)
    /// If this is the only reference, mutates in place.
    /// Otherwise, clones the inner map first.
    pub fn make_mut(&mut self) -> &mut PropsMap {
        Arc::make_mut(&mut self.0)
    }

    /// Insert a key-value pair (uses COW internally)
    pub fn insert(&mut self, key: String, value: Value) -> Option<Value> {
        self.make_mut().insert(key, value)
    }

    /// Remove a key (uses COW internally)
    pub fn remove(&mut self, key: &str) -> Option<Value> {
        self.make_mut().shift_remove(key)
    }

    /// Get a reference to the inner map
    pub fn inner(&self) -> &PropsMap {
        &self.0
    }
}

impl Default for Props {
    fn default() -> Self {
        Props::new()
    }
}

impl std::ops::Deref for Props {
    type Target = PropsMap;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl<'a> IntoIterator for &'a Props {
    type Item = (&'a String, &'a Value);
    type IntoIter = indexmap::map::Iter<'a, String, Value>;

    fn into_iter(self) -> Self::IntoIter {
        self.0.iter()
    }
}

impl FromIterator<(String, Value)> for Props {
    fn from_iter<I: IntoIterator<Item = (String, Value)>>(iter: I) -> Self {
        Props(Arc::new(iter.into_iter().collect()))
    }
}

// Custom serde - serialize/deserialize as plain IndexMap
impl serde::Serialize for Props {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        self.0.serialize(serializer)
    }
}

impl<'de> serde::Deserialize<'de> for Props {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let map = PropsMap::deserialize(deserializer)?;
        Ok(Props(Arc::new(map)))
    }
}

/// Core IR element representing a component instance or primitive
///
/// Children are stored as `ir_children: Vec<IRNode>`, the single source of
/// truth for all child nodes (plain elements AND control-flow constructs).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Element {
    /// Component/element type (e.g., "Column", "Text", "Button")
    pub element_type: String,

    /// Properties passed to this element
    pub props: Props,

    /// Children that may include control-flow nodes (ForEach, When, If) as well
    /// as regular Element nodes wrapped in `IRNode::Element`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ir_children: Vec<IRNode>,

    /// Optional key for reconciliation (from user or auto-generated)
    pub key: Option<String>,

    /// When set, `@{state.xxx}` bindings in this element (and its children)
    /// resolve against the named module's state instead of the primary module.
    /// Set during component expansion when the source is `module X { ... }`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub module_scope: Option<String>,
}

impl Element {
    pub fn new(element_type: impl Into<String>) -> Self {
        Self {
            element_type: element_type.into(),
            props: Props::new(),
            ir_children: Vec::new(),
            key: None,
            module_scope: None,
        }
    }

    pub fn with_prop(mut self, key: impl Into<String>, value: Value) -> Self {
        self.props.insert(key.into(), value);
        self
    }

    pub fn with_child(mut self, child: Element) -> Self {
        self.ir_children.push(IRNode::Element(child));
        self
    }

    pub fn with_key(mut self, key: impl Into<String>) -> Self {
        self.key = Some(key.into());
        self
    }
}
