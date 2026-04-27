use super::Element;
use indexmap::IndexMap;
use std::collections::HashSet;
use std::sync::Arc;

/// Standard primitive element types recognized by all Hypen renderers.
///
/// Registering these prevents the component resolver from trying to resolve
/// them as user-defined components. All renderers (DOM, Canvas, iOS, Android)
/// are expected to handle these element types natively.
pub const DEFAULT_PRIMITIVES: &[&str] = &[
    "Text", "Column", "Row", "Button", "Input", "Textarea", "Image", "Container", "Box",
    "Center", "List", "Spacer", "Stack", "Divider", "Grid", "Card", "Heading", "Checkbox",
    "Select", "Switch", "Slider", "Spinner", "Badge", "Avatar", "ProgressBar", "Video", "Audio",
    "Paragraph", "Icon",
];

/// Result from component resolution
/// Contains the source code and the resolved path for the component
pub struct ResolvedComponent {
    pub source: String,
    pub path: String,
    pub passthrough: bool,
    pub lazy: bool,
}

/// Callback type for resolving component source code
/// Takes component name and optional path context, returns resolved component
/// Path context is the file path where this component is being referenced from
/// Resolver should return (source_code, resolved_path) where resolved_path is the
/// absolute path to the component file (used for resolving nested components)
pub type ComponentResolver =
    Arc<dyn Fn(&str, Option<&str>) -> Option<ResolvedComponent> + Send + Sync>;

/// A component definition - a template that can be instantiated
#[derive(Clone)]
pub struct Component {
    /// Component name
    pub name: String,

    /// Template function that produces element tree
    /// Takes props and returns expanded element tree
    pub template: Arc<dyn Fn(IndexMap<String, serde_json::Value>) -> Element + Send + Sync>,

    /// Default props
    pub default_props: IndexMap<String, serde_json::Value>,

    /// Source path where this component was loaded from (optional)
    pub source_path: Option<String>,

    /// If true, this component acts as a passthrough container
    /// It preserves its children and props without template expansion
    pub passthrough: bool,

    /// If true, this component's children are NOT expanded during initial pass
    /// Children remain as component references for lazy rendering
    pub lazy: bool,

    /// When true, the source declared `module X { ... }`. The expansion sets
    /// `module_scope` on all descendant elements so the reconciler scopes
    /// `@{state.xxx}` bindings to this module's state.
    pub is_module: bool,

    /// Lowercased name used as the module scope key (e.g., "search").
    pub module_name: Option<String>,
}

impl Component {
    pub fn new(
        name: impl Into<String>,
        template: impl Fn(IndexMap<String, serde_json::Value>) -> Element + Send + Sync + 'static,
    ) -> Self {
        Self {
            name: name.into(),
            template: Arc::new(template),
            default_props: IndexMap::new(),
            source_path: None,
            passthrough: false,
            lazy: false,
            is_module: false,
            module_name: None,
        }
    }

    pub fn with_defaults(mut self, defaults: IndexMap<String, serde_json::Value>) -> Self {
        self.default_props = defaults;
        self
    }

    pub fn with_source_path(mut self, path: impl Into<String>) -> Self {
        self.source_path = Some(path.into());
        self
    }

    pub fn with_passthrough(mut self, passthrough: bool) -> Self {
        self.passthrough = passthrough;
        self
    }

    pub fn with_lazy(mut self, lazy: bool) -> Self {
        self.lazy = lazy;
        self
    }

    /// Instantiate this component with given props
    pub fn instantiate(&self, props: IndexMap<String, serde_json::Value>) -> Element {
        let mut merged_props = self.default_props.clone();
        merged_props.extend(props);
        (self.template)(merged_props)
    }
}

/// Registry of all available components
pub struct ComponentRegistry {
    /// Components indexed by fully qualified key (path:name or just name)
    components: IndexMap<String, Component>,
    /// Optional resolver for dynamically loading components
    resolver: Option<ComponentResolver>,
    /// Cache of resolved component paths to prevent re-resolving
    /// Key format: "path:component_name" or "component_name" if no path
    /// Value: true = resolved successfully, false = failed to resolve
    resolved_cache: IndexMap<String, bool>,
    /// Primitive element names that should never be resolved as components.
    /// Separate from resolved_cache to avoid conflating "is a primitive"
    /// with "failed to resolve without context."
    primitives: HashSet<String>,
}

impl ComponentRegistry {
    pub fn new() -> Self {
        Self {
            components: IndexMap::new(),
            resolver: None,
            resolved_cache: IndexMap::new(),
            primitives: HashSet::new(),
        }
    }

    /// Register a primitive element name to skip component resolution.
    /// Called by the renderer to mark built-in DOM elements.
    pub fn register_primitive(&mut self, name: &str) {
        self.primitives.insert(name.to_string());
    }

    /// Register the standard set of Hypen primitives.
    ///
    /// These are the built-in element types that all renderers support.
    /// Registering them prevents the component resolver from trying to
    /// look them up as user-defined components.
    pub fn register_default_primitives(&mut self) {
        for name in DEFAULT_PRIMITIVES {
            self.register_primitive(name);
        }
    }

    /// Check if a name is a registered primitive element.
    pub fn is_primitive(&self, name: &str) -> bool {
        self.primitives.contains(name)
    }

    /// Clear all resolved components and caches, but preserve primitives
    /// and the resolver callback. Used for hot-reload so components are
    /// re-resolved from fresh source files.
    pub fn clear_resolved(&mut self) {
        self.components.clear();
        self.resolved_cache.clear();
    }

    /// Set the component resolver callback
    pub fn set_resolver(&mut self, resolver: ComponentResolver) {
        self.resolver = Some(resolver);
    }

    pub fn register(&mut self, component: Component) {
        // Register with qualified key if source path is available
        if let Some(ref path) = component.source_path {
            let qualified_key = format!("{}:{}", path, component.name);
            self.components.insert(qualified_key, component.clone());
        }

        // Always register with unqualified name as fallback
        self.components.insert(component.name.clone(), component);
    }

    /// Get a component by name and optional context path
    pub fn get(&self, name: &str, context_path: Option<&str>) -> Option<&Component> {
        // Try with context path first
        if let Some(path) = context_path {
            let qualified_key = format!("{}:{}", path, name);
            if let Some(component) = self.components.get(&qualified_key) {
                return Some(component);
            }
        }

        // Fall back to just name (for globally registered components)
        self.components.get(name)
    }

    /// Try to resolve and register a component by name and context path
    fn try_resolve(&mut self, name: &str, context_path: Option<&str>) -> bool {
        // Primitives are never resolved as components, regardless of context.
        if self.primitives.contains(name) {
            return false;
        }

        // Build cache key
        let cache_key = if let Some(path) = context_path {
            format!("{}:{}", path, name)
        } else {
            name.to_string()
        };

        // Check cache for context-scoped resolution
        if let Some(&cached) = self.resolved_cache.get(&cache_key) {
            return cached;
        }

        // Try to resolve
        if let Some(ref resolver) = self.resolver {
            if let Some(resolved) = resolver(name, context_path) {
                // For lazy components, don't parse the template
                // Children won't be expanded until explicitly requested
                if resolved.lazy {
                    #[cfg(all(target_arch = "wasm32", feature = "js"))]
                    web_sys::console::log_1(
                        &format!("Registering lazy component: {}", name).into(),
                    );

                    // Create a dummy component - children won't be expanded
                    let dummy_element = Element::new(name);
                    let component = Component::new(name, move |_props| dummy_element.clone())
                        .with_source_path(resolved.path.clone())
                        .with_lazy(true);

                    self.register(component);
                    self.resolved_cache.insert(cache_key, true);
                    return true;
                }

                // For passthrough components, don't parse the template
                // They act as transparent containers
                if resolved.passthrough {
                    #[cfg(all(target_arch = "wasm32", feature = "js"))]
                    web_sys::console::log_1(
                        &format!("Registering passthrough component: {}", name).into(),
                    );

                    // Create a dummy component - the template won't be used for passthrough
                    let dummy_element = Element::new(name);
                    let component = Component::new(name, move |_props| dummy_element.clone())
                        .with_source_path(resolved.path.clone())
                        .with_passthrough(true);

                    self.register(component);
                    self.resolved_cache.insert(cache_key, true);
                    return true;
                }

                // Parse the component source for non-passthrough components
                match hypen_parser::parse_component(&resolved.source) {
                    Ok(component_spec) => {
                        // Detect if the source declares a module (e.g., `module Search { ... }`)
                        let spec_is_module = component_spec.declaration_type
                            == hypen_parser::DeclarationType::Module;
                        let spec_module_name = if spec_is_module {
                            Some(component_spec.name.to_lowercase())
                        } else {
                            None
                        };

                        // Convert to IR, preserving control-flow children
                        let ir_node = super::expand::ast_to_ir_node(&component_spec);
                        let element = match ir_node {
                            super::IRNode::Element(e) => e,
                            _ => {
                                #[cfg(all(target_arch = "wasm32", feature = "js"))]
                                web_sys::console::error_1(
                                    &format!("Component {} root must be an element", name).into(),
                                );
                                return false;
                            }
                        };

                        // Create a component that returns the parsed element
                        let mut component = Component::new(name, move |_props| element.clone())
                            .with_source_path(resolved.path.clone())
                            .with_passthrough(false);

                        // Tag module components so expansion propagates module_scope
                        if spec_is_module {
                            component.is_module = true;
                            component.module_name = spec_module_name;
                        }

                        self.register(component);
                        self.resolved_cache.insert(cache_key, true);
                        return true;
                    }
                    Err(e) => {
                        #[cfg(all(target_arch = "wasm32", feature = "js"))]
                        web_sys::console::error_1(
                            &format!("Failed to parse component {}: {:?}", name, e).into(),
                        );

                        #[cfg(not(all(target_arch = "wasm32", feature = "js")))]
                        eprintln!("Failed to parse component {}: {:?}", name, e);

                        self.resolved_cache.insert(cache_key, false);
                        return false;
                    }
                }
            }
        }

        self.resolved_cache.insert(cache_key, false);
        false
    }

    pub fn expand(&mut self, element: &Element) -> Element {
        self.expand_with_context(element, None)
    }

    /// Force expand an element's children (used for lazy components)
    /// This will expand children that were previously kept unexpanded
    pub fn expand_children(
        &mut self,
        element: &Element,
        context_path: Option<&str>,
    ) -> Vec<Element> {
        element
            .ir_children
            .iter()
            .filter_map(|child_ir| {
                if let super::IRNode::Element(child) = child_ir {
                    Some(self.expand_with_context(child, context_path))
                } else {
                    None
                }
            })
            .collect()
    }

    /// Expand an element with a context path for component resolution
    fn expand_with_context(&mut self, element: &Element, context_path: Option<&str>) -> Element {
        // First check if component exists, if not try to resolve it
        let component_exists = self.get(&element.element_type, context_path).is_some();

        if !component_exists {
            // Try to resolve the component dynamically
            self.try_resolve(&element.element_type, context_path);
        }

        // If this element references a registered component, expand it
        if let Some(component) = self.get(&element.element_type, context_path) {
            // Capture module metadata before mutable operations
            let comp_is_module = component.is_module;
            let comp_module_name = component.module_name.clone();

            // Check if this is a lazy component (children NOT expanded until explicitly requested)
            if component.lazy {
                // Lazy component: keep element and children, but DON'T expand children yet
                let mut element = element.clone();

                // Mark as lazy so reconciler knows to skip children
                element.props.insert(
                    "__lazy".to_string(),
                    super::Value::Static(serde_json::json!(true)),
                );

                #[cfg(all(target_arch = "wasm32", feature = "js"))]
                web_sys::console::log_1(
                    &format!(
                        "Lazy {} (props: {:?}): {} children kept unexpanded",
                        element.element_type,
                        element.props.keys().collect::<Vec<_>>(),
                        element.ir_children.len()
                    )
                    .into(),
                );

                return element;
            }

            // Check if this is a passthrough component
            if component.passthrough {
                // Passthrough component: keep the original element but expand its children
                let mut element = element.clone();

                #[cfg(all(target_arch = "wasm32", feature = "js"))]
                {
                    let props_str = element
                        .props
                        .iter()
                        .map(|(k, v)| format!("{}={:?}", k, v))
                        .collect::<Vec<_>>()
                        .join(", ");
                    web_sys::console::log_1(
                        &format!(
                            "Passthrough {} (props: [{}]): {} children before expansion",
                            element.element_type,
                            props_str,
                            element.ir_children.len()
                        )
                        .into(),
                    );
                }

                // Get the source path for child context
                let child_context = component.source_path.clone();
                let child_context_ref = child_context.as_deref();

                // Recursively expand ir_children
                element.ir_children = element
                    .ir_children
                    .iter()
                    .map(|child| self.expand_ir_node_with_context(child, child_context_ref))
                    .collect();

                #[cfg(all(target_arch = "wasm32", feature = "js"))]
                web_sys::console::log_1(
                    &format!(
                        "Passthrough {}: {} children after expansion",
                        element.element_type,
                        element.ir_children.len()
                    )
                    .into(),
                );

                element
            } else {
                // Regular component: instantiate template and replace
                // Convert Value props to serde_json::Value (resolve only static values here)
                let mut props = IndexMap::new();
                for (k, v) in &element.props {
                    if let super::Value::Static(val) = v {
                        props.insert(k.clone(), val.clone());
                    }
                }

                let mut expanded = component.instantiate(props);

                // Preserve bindings and actions from the original element
                for (k, v) in &element.props {
                    match v {
                        super::Value::Binding(_) | super::Value::Action(_) => {
                            expanded.props.insert(k.clone(), v.clone());
                        }
                        _ => {}
                    }
                }

                // Get the source path of this component for resolving its children
                // Clone it to avoid holding a borrow
                let child_context = component.source_path.clone();

                // Replace Children() placeholders with actual children from the caller
                expanded.ir_children = self.replace_children_slots(
                    &expanded.ir_children,
                    &element.ir_children,
                    context_path,
                );

                // Recursively expand ir_children with the new context
                let child_context_ref = child_context.as_deref();
                expanded.ir_children = expanded
                    .ir_children
                    .iter()
                    .map(|child| self.expand_ir_node_with_context(child, child_context_ref))
                    .collect();

                // If this component is a module, set module_scope on the
                // expanded element and all its descendants so the reconciler
                // resolves @{state.xxx} against this module's state.
                if comp_is_module {
                    if let Some(ref scope) = comp_module_name {
                        super::expand::propagate_module_scope_element(&mut expanded, scope);
                    }
                }

                expanded
            }
        } else {
            // Not a component, just expand ir_children
            let mut element = element.clone();
            element.ir_children = element
                .ir_children
                .iter()
                .map(|child| self.expand_ir_node_with_context(child, context_path))
                .collect();
            element
        }
    }

    /// Expand an IRNode recursively, expanding any Element nodes via the component registry
    pub fn expand_ir_node(&mut self, node: &super::IRNode) -> super::IRNode {
        self.expand_ir_node_with_context(node, None)
    }

    /// Expand an IRNode with context path for component resolution
    fn expand_ir_node_with_context(
        &mut self,
        node: &super::IRNode,
        context_path: Option<&str>,
    ) -> super::IRNode {
        match node {
            super::IRNode::Element(element) => {
                // expand_with_context already recurses into ir_children
                // through every non-lazy branch. Recursing here again would
                // do 2x the work at every level (O(2^depth) blowup).
                let expanded = self.expand_with_context(element, context_path);
                super::IRNode::Element(expanded)
            }
            super::IRNode::ForEach {
                source,
                item_name,
                key_path,
                template,
                props,
                module_scope,
            } => {
                // Recursively expand template children
                let expanded_template: Vec<super::IRNode> = template
                    .iter()
                    .map(|child| self.expand_ir_node_with_context(child, context_path))
                    .collect();

                super::IRNode::ForEach {
                    source: source.clone(),
                    item_name: item_name.clone(),
                    key_path: key_path.clone(),
                    template: expanded_template,
                    props: props.clone(),
                    module_scope: module_scope.clone(),
                }
            }
            super::IRNode::Conditional {
                value,
                branches,
                fallback,
                module_scope,
            } => {
                // Expand branch children
                let expanded_branches: Vec<super::ConditionalBranch> = branches
                    .iter()
                    .map(|branch| super::ConditionalBranch {
                        pattern: branch.pattern.clone(),
                        children: branch
                            .children
                            .iter()
                            .map(|child| self.expand_ir_node_with_context(child, context_path))
                            .collect(),
                    })
                    .collect();

                // Expand fallback children if present
                let expanded_fallback = fallback.as_ref().map(|fb| {
                    fb.iter()
                        .map(|child| self.expand_ir_node_with_context(child, context_path))
                        .collect()
                });

                super::IRNode::Conditional {
                    value: value.clone(),
                    branches: expanded_branches,
                    fallback: expanded_fallback,
                    module_scope: module_scope.clone(),
                }
            }
            super::IRNode::Router {
                location,
                routes,
                fallback,
                module_scope,
            } => {
                // Expand each route's children
                let expanded_routes: Vec<super::RouterRoute> = routes
                    .iter()
                    .map(|route| super::RouterRoute {
                        path: route.path.clone(),
                        children: route
                            .children
                            .iter()
                            .map(|child| self.expand_ir_node_with_context(child, context_path))
                            .collect(),
                    })
                    .collect();

                // Expand fallback children if present
                let expanded_fallback = fallback.as_ref().map(|fb| {
                    fb.iter()
                        .map(|child| self.expand_ir_node_with_context(child, context_path))
                        .collect()
                });

                super::IRNode::Router {
                    location: location.clone(),
                    routes: expanded_routes,
                    fallback: expanded_fallback,
                    module_scope: module_scope.clone(),
                }
            }
        }
    }

    /// Replace Children() placeholders with actual children
    /// Supports named slots via Children().slot("header")
    fn replace_children_slots(
        &self,
        template_children: &[super::IRNode],
        actual_children: &[super::IRNode],
        _context_path: Option<&str>,
    ) -> Vec<super::IRNode> {
        let mut result = Vec::new();

        for child_ir in template_children {
            match child_ir {
                super::IRNode::Element(child) if child.element_type == "Children" => {
                    // Check if this is a named slot via .slot() applicator
                    let slot_name = self.get_slot_name(&child.props);

                    // If named slot, filter children by slot applicator
                    // Otherwise, include all children that don't have a slot applicator
                    if let Some(slot) = slot_name {
                        for c in actual_children {
                            if let super::IRNode::Element(ce) = c {
                                if self.get_slot_name(&ce.props) == Some(slot) {
                                    result.push(c.clone());
                                }
                            }
                        }
                    } else {
                        // Default slot - children without slot applicator
                        for c in actual_children {
                            if let super::IRNode::Element(ce) = c {
                                if self.get_slot_name(&ce.props).is_none() {
                                    result.push(c.clone());
                                }
                            } else {
                                // Non-element IRNodes (ForEach, Conditional) go to default slot
                                result.push(c.clone());
                            }
                        }
                    }
                }
                super::IRNode::Element(child) => {
                    // Not a Children() placeholder - keep as is but recurse into its children
                    let mut new_child = child.clone();
                    new_child.ir_children =
                        self.replace_children_slots(&child.ir_children, actual_children, _context_path);
                    result.push(super::IRNode::Element(new_child));
                }
                other => {
                    // ForEach/Conditional - keep as-is
                    result.push(other.clone());
                }
            }
        }

        result
    }

    /// Extract slot name from applicators
    /// Looks for .slot("name") which becomes prop "slot.0" = "name"
    fn get_slot_name<'a>(&self, props: &'a super::Props) -> Option<&'a str> {
        props.get("slot.0").and_then(|v| {
            if let super::Value::Static(serde_json::Value::String(s)) = v {
                Some(s.as_str())
            } else {
                None
            }
        })
    }
}

impl Default for ComponentRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ir::Value;

    #[test]
    fn test_dynamic_component_resolution() {
        let mut registry = ComponentRegistry::new();

        // Set up a resolver that returns component source and path
        registry.set_resolver(Arc::new(|name: &str, _context: Option<&str>| {
            if name == "Header" {
                Some(ResolvedComponent {
                    source: r#"Row { Text("Header") }"#.to_string(),
                    path: "/components/Header.hypen".to_string(),
                    passthrough: false,
                    lazy: false,
                })
            } else {
                None
            }
        }));

        // Create an element that references the unregistered Header component
        let element = Element::new("Column").with_child(Element::new("Header"));

        // Expand should trigger resolution
        let expanded = registry.expand(&element);

        // Should have expanded Header into Row { Text }
        assert_eq!(expanded.element_type, "Column");
        assert_eq!(expanded.ir_children.len(), 1);
        match &expanded.ir_children[0] {
            crate::ir::IRNode::Element(row) => {
                assert_eq!(row.element_type, "Row");
                assert_eq!(row.ir_children.len(), 1);
                match &row.ir_children[0] {
                    crate::ir::IRNode::Element(text) => assert_eq!(text.element_type, "Text"),
                    other => panic!("Expected Element, got {:?}", other),
                }
            }
            other => panic!("Expected Element, got {:?}", other),
        }
    }

    #[test]
    fn test_component_resolution_with_path_context() {
        let mut registry = ComponentRegistry::new();

        // Set up a resolver that resolves based on context path
        registry.set_resolver(Arc::new(|name: &str, context: Option<&str>| {
            match (name, context) {
                ("Button", Some("/pages/Home.hypen")) => Some(ResolvedComponent {
                    source: r#"Text("Home Button")"#.to_string(),
                    path: "/components/buttons/HomeButton.hypen".to_string(),
                    passthrough: false,
                    lazy: false,
                }),
                ("Button", Some("/pages/About.hypen")) => Some(ResolvedComponent {
                    source: r#"Text("About Button")"#.to_string(),
                    path: "/components/buttons/AboutButton.hypen".to_string(),
                    passthrough: false,
                    lazy: false,
                }),
                _ => None,
            }
        }));

        // Register a component with a source path
        let home_element =
            Element::new("Text").with_prop("0", Value::Static(serde_json::json!("Home")));
        let home_component = Component::new("Home", move |_| home_element.clone())
            .with_source_path("/pages/Home.hypen");
        registry.register(home_component);

        // Create an element that uses Button from Home context
        let element = Element::new("Column")
            .with_child(Element::new("Home").with_child(Element::new("Button")));

        let expanded = registry.expand(&element);

        // Button should resolve differently based on its context
        assert_eq!(expanded.element_type, "Column");
    }

    #[test]
    fn test_component_resolution_caching() {
        let mut registry = ComponentRegistry::new();
        let call_count = Arc::new(std::sync::Mutex::new(0));
        let call_count_clone = call_count.clone();

        // Resolver that tracks calls
        registry.set_resolver(Arc::new(move |name: &str, _context: Option<&str>| {
            if name == "Button" {
                *call_count_clone.lock().unwrap() += 1;
                Some(ResolvedComponent {
                    source: r#"Text("Click")"#.to_string(),
                    path: "/components/Button.hypen".to_string(),
                    passthrough: false,
                    lazy: false,
                })
            } else {
                None
            }
        }));

        // First expansion should call resolver
        let element1 = Element::new("Button");
        let _ = registry.expand(&element1);
        assert_eq!(*call_count.lock().unwrap(), 1);

        // Second expansion should use cache
        let element2 = Element::new("Button");
        let _ = registry.expand(&element2);
        assert_eq!(*call_count.lock().unwrap(), 1); // Still 1, not 2
    }

    #[test]
    fn test_failed_resolution_cached() {
        let mut registry = ComponentRegistry::new();
        let call_count = Arc::new(std::sync::Mutex::new(0));
        let call_count_clone = call_count.clone();

        // Resolver that returns None
        registry.set_resolver(Arc::new(move |_name: &str, _context: Option<&str>| {
            *call_count_clone.lock().unwrap() += 1;
            None
        }));

        // First expansion should call resolver
        let element1 = Element::new("Unknown");
        let _ = registry.expand(&element1);
        assert_eq!(*call_count.lock().unwrap(), 1);

        // Second expansion should use cached failure
        let element2 = Element::new("Unknown");
        let _ = registry.expand(&element2);
        assert_eq!(*call_count.lock().unwrap(), 1); // Cached
    }

    #[test]
    fn test_passthrough_component_preserves_props() {
        let mut registry = ComponentRegistry::new();

        // Register Router and Route as passthrough components
        registry.set_resolver(Arc::new(|name: &str, _context: Option<&str>| {
            if name == "Router" || name == "Route" {
                Some(ResolvedComponent {
                    source: String::new(), // Empty template for passthrough
                    path: name.to_string(),
                    passthrough: true,
                    lazy: false,
                })
            } else if name == "HomePage" {
                // Regular component with a simple template
                Some(ResolvedComponent {
                    source: "Text(\"Home\")".to_string(),
                    path: name.to_string(),
                    passthrough: false,
                    lazy: false,
                })
            } else {
                None
            }
        }));

        // Build a tree structure like:
        // Router {
        //   Route("/") { HomePage }
        //   Route("/about") { HomePage }
        // }
        let router = Element::new("Router")
            .with_child(
                Element::new("Route")
                    .with_prop("0", Value::Static(serde_json::json!("/")))
                    .with_child(Element::new("HomePage")),
            )
            .with_child(
                Element::new("Route")
                    .with_prop("0", Value::Static(serde_json::json!("/about")))
                    .with_child(Element::new("HomePage")),
            );

        // Expand the tree
        let expanded = registry.expand(&router);

        // Verify Router is preserved
        assert_eq!(expanded.element_type, "Router");
        assert_eq!(expanded.ir_children.len(), 2);

        // Helper to unwrap IRNode::Element
        fn unwrap_element(node: &crate::ir::IRNode) -> &Element {
            match node {
                crate::ir::IRNode::Element(e) => e,
                other => panic!("Expected Element, got {:?}", other),
            }
        }

        // Verify first Route preserves its path prop
        let expanded_route1 = unwrap_element(&expanded.ir_children[0]);
        assert_eq!(expanded_route1.element_type, "Route");
        if let Some(Value::Static(path)) = expanded_route1.props.get("0") {
            assert_eq!(path.as_str().unwrap(), "/");
        } else {
            panic!("Route 1 missing path prop");
        }

        // Verify second Route preserves its path prop
        let expanded_route2 = unwrap_element(&expanded.ir_children[1]);
        assert_eq!(expanded_route2.element_type, "Route");
        if let Some(Value::Static(path)) = expanded_route2.props.get("0") {
            assert_eq!(path.as_str().unwrap(), "/about");
        } else {
            panic!("Route 2 missing path prop");
        }

        // Verify children are expanded (HomePage should be replaced with Text)
        assert_eq!(expanded_route1.ir_children.len(), 1);
        assert_eq!(unwrap_element(&expanded_route1.ir_children[0]).element_type, "Text");
    }

    #[test]
    fn test_bare_miss_does_not_block_context_resolve() {
        // Regression: a bare-name resolution failure must not prevent
        // a later context-scoped resolution from succeeding.
        let mut registry = ComponentRegistry::new();

        registry.set_resolver(Arc::new(|name: &str, context: Option<&str>| {
            // Only resolve "Header" when inside /pages/Home.hypen
            match (name, context) {
                ("Header", Some("/pages/Home.hypen")) => Some(ResolvedComponent {
                    source: r#"Text("Home Header")"#.to_string(),
                    path: "/components/Header.hypen".to_string(),
                    passthrough: false,
                    lazy: false,
                }),
                _ => None,
            }
        }));

        // First: bare-name miss (no context)
        let element = Element::new("Header");
        let expanded = registry.expand(&element);
        // Should NOT resolve — bare name has no match
        assert_eq!(expanded.element_type, "Header");

        // Second: context-scoped resolve should still succeed
        let element2 = Element::new("Header");
        let expanded2 = registry.expand_with_context(&element2, Some("/pages/Home.hypen"));
        // Should resolve into the template (a Text element via ir_children)
        assert_ne!(expanded2.element_type, "Header",
            "Context-scoped resolve must not be blocked by prior bare-name miss");
    }

    #[test]
    fn test_primitives_never_shadowed_by_resolver() {
        // Primitives must never be resolved as user components,
        // even when a resolver would return a match.
        let mut registry = ComponentRegistry::new();
        registry.register_primitive("Text");

        registry.set_resolver(Arc::new(|name: &str, _context: Option<&str>| {
            if name == "Text" {
                Some(ResolvedComponent {
                    source: r#"Column { Text("Shadowed!") }"#.to_string(),
                    path: "/evil/Text.hypen".to_string(),
                    passthrough: false,
                    lazy: false,
                })
            } else {
                None
            }
        }));

        // Bare resolve — should not shadow
        let element = Element::new("Text");
        let expanded = registry.expand(&element);
        assert_eq!(expanded.element_type, "Text");
        assert!(expanded.ir_children.is_empty());

        // Context resolve — should still not shadow
        let expanded2 = registry.expand_with_context(&element, Some("/some/path"));
        assert_eq!(expanded2.element_type, "Text");
        assert!(expanded2.ir_children.is_empty());
    }
}

