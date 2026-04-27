use std::sync::Arc;

use crate::context::GlobalContext;
use crate::discovery::ComponentRegistry;
use crate::module::{create_nested_instance, ModuleBuilder, ModuleDefinition, ModuleInstance};
use crate::router::HypenRouter;
use crate::state::State;

/// Top-level application builder and registry.
///
/// `HypenApp` is the entry point for building Hypen applications. It provides:
/// - A shorthand for creating module builders
/// - A component registry for custom components
/// - A global context and router
/// - Route-based module management
///
/// # Example
///
/// ```rust,ignore
/// use hypen_server::prelude::*;
/// use serde::{Deserialize, Serialize};
///
/// #[derive(Clone, Default, Serialize, Deserialize)]
/// struct Home { title: String }
///
/// #[derive(Clone, Default, Serialize, Deserialize)]
/// struct Counter { count: i32 }
///
/// let app = HypenApp::builder()
///     .route("/", HypenApp::module::<Home>("Home")
///         .state(Home { title: "Welcome".into() })
///         .ui(r#"Column { Text("@{state.title}") }"#)
///         .build())
///     .route("/counter", HypenApp::module::<Counter>("Counter")
///         .state(Counter { count: 0 })
///         .ui(r#"Column { Text("@{state.count}") }"#)
///         .on_action::<()>("increment", |state, _, _| { state.count += 1; })
///         .build())
///     .components_dir("./components")
///     .build();
/// ```
pub struct HypenApp {
    context: Arc<GlobalContext>,
    router: Arc<HypenRouter>,
    components: ComponentRegistry,
    routes: Vec<RouteEntry>,
}

/// A route entry mapping a path pattern to a module name.
struct RouteEntry {
    pattern: String,
    module_name: String,
}

impl HypenApp {
    pub fn builder() -> HypenAppBuilder {
        HypenAppBuilder {
            components: ComponentRegistry::new(),
            routes: Vec::new(),
            components_dirs: Vec::new(),
        }
    }

    /// Shorthand to start building a module definition.
    ///
    /// ```rust,ignore
    /// let module = HypenApp::module::<MyState>("MyModule")
    ///     .state(MyState::default())
    ///     .on_action::<()>("do_thing", |state, _, _ctx| { /* ... */ })
    ///     .build();
    /// ```
    pub fn module<S: State>(name: impl Into<String>) -> ModuleBuilder<S> {
        ModuleBuilder::new(name)
    }

    /// Access the global context.
    pub fn context(&self) -> &GlobalContext {
        &self.context
    }

    /// Access the router.
    pub fn router(&self) -> &HypenRouter {
        &self.router
    }

    /// Access the component registry.
    pub fn components(&self) -> &ComponentRegistry {
        &self.components
    }

    /// Instantiate a module by its definition, connecting it to this app's context.
    pub fn instantiate<S: State>(
        &self,
        definition: Arc<ModuleDefinition<S>>,
    ) -> crate::error::Result<ModuleInstance<S>> {
        ModuleInstance::new(definition, Some(Arc::clone(&self.context)))
    }

    /// Instantiate a module as a nested child, auto-registering it in the global context.
    ///
    /// The module's state is registered in the `GlobalContext` under its lowercase name,
    /// and the instance is automatically mounted.
    ///
    /// # Example
    ///
    /// ```rust,ignore
    /// let app = HypenApp::default();
    /// let def = Arc::new(HypenApp::module::<MyState>("Feed")
    ///     .state(MyState::default())
    ///     .build());
    ///
    /// let instance = app.instantiate_nested(def).unwrap();
    /// assert!(app.context().has_module("feed"));
    /// ```
    pub fn instantiate_nested<S: State>(
        &self,
        definition: Arc<ModuleDefinition<S>>,
    ) -> crate::error::Result<ModuleInstance<S>> {
        create_nested_instance(definition, Arc::clone(&self.context))
    }

    /// Instantiate a module with access to the app's component registry.
    ///
    /// This enables the module's UI template to reference custom components
    /// (e.g., `Column { Card {} }`) registered in the app.
    pub fn instantiate_with_components<S: State>(
        &self,
        definition: Arc<ModuleDefinition<S>>,
    ) -> crate::error::Result<ModuleInstance<S>> {
        ModuleInstance::new_with_components(
            definition,
            Some(Arc::clone(&self.context)),
            &self.components,
        )
    }

    /// Navigate to a route.
    pub fn navigate(&self, path: &str) {
        self.router.push(path);
    }

    /// Get the active route pattern match for a given path.
    pub fn match_route(&self, path: &str) -> Option<(&str, &str)> {
        for entry in &self.routes {
            if self.router.match_path(&entry.pattern, path).is_some() {
                return Some((&entry.pattern, &entry.module_name));
            }
        }
        None
    }
}

impl Default for HypenApp {
    fn default() -> Self {
        let context = Arc::new(GlobalContext::new());
        let router = Arc::new(HypenRouter::new());
        context.set_router(Arc::clone(&router));
        Self {
            context,
            router,
            components: ComponentRegistry::new(),
            routes: Vec::new(),
        }
    }
}

/// Builder for `HypenApp`.
pub struct HypenAppBuilder {
    components: ComponentRegistry,
    routes: Vec<RouteEntry>,
    components_dirs: Vec<String>,
}

impl HypenAppBuilder {
    /// Add a route mapping a URL pattern to a module definition.
    ///
    /// The module name is used to identify which module to mount when
    /// the route matches.
    pub fn route<S: State>(
        mut self,
        pattern: impl Into<String>,
        definition: ModuleDefinition<S>,
    ) -> Self {
        let pattern = pattern.into();
        let name = definition.name().to_string();
        self.routes.push(RouteEntry {
            pattern,
            module_name: name,
        });
        // Store the definition's UI source in the component registry if present
        if let Some(source) = definition.ui_source() {
            self.components.register(definition.name(), source, None);
        }
        self
    }

    /// Register a component from inline DSL source.
    pub fn component(mut self, name: impl Into<String>, source: impl Into<String>) -> Self {
        self.components.register(name, source, None);
        self
    }

    /// Load components from a directory of `.hypen` files.
    pub fn components_dir(mut self, dir: impl Into<String>) -> Self {
        self.components_dirs.push(dir.into());
        self
    }

    /// Build the `HypenApp`.
    pub fn build(mut self) -> HypenApp {
        // Load component directories
        for dir in &self.components_dirs {
            // Best-effort: log errors but don't fail the build
            if let Err(e) = self.components.load_dir(dir) {
                eprintln!("[hypen-server] Warning: failed to load components from {dir}: {e}");
            }
        }

        let context = Arc::new(GlobalContext::new());
        let router = Arc::new(HypenRouter::new());
        context.set_router(Arc::clone(&router));

        HypenApp {
            context,
            router,
            components: self.components,
            routes: self.routes,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};

    #[derive(Clone, Default, Serialize, Deserialize)]
    struct TestState {
        value: i32,
    }

    #[test]
    fn test_module_shorthand() {
        let def = HypenApp::module::<TestState>("MyModule")
            .state(TestState { value: 42 })
            .on_action::<()>("inc", |state, _, _| {
                state.value += 1;
            })
            .build();

        assert_eq!(def.name(), "MyModule");
    }

    #[test]
    fn test_app_builder() {
        let app = HypenApp::builder()
            .component("Button", r#"Button { Text("Click") }"#)
            .build();

        assert!(app.components().has("Button"));
    }

    #[test]
    fn test_app_with_routes() {
        let app = HypenApp::builder()
            .route(
                "/",
                HypenApp::module::<TestState>("Home")
                    .state(TestState::default())
                    .build(),
            )
            .route(
                "/about",
                HypenApp::module::<TestState>("About")
                    .state(TestState::default())
                    .build(),
            )
            .build();

        let (_, module) = app.match_route("/").unwrap();
        assert_eq!(module, "Home");

        let (_, module) = app.match_route("/about").unwrap();
        assert_eq!(module, "About");

        assert!(app.match_route("/nonexistent").is_none());
    }

    #[test]
    fn test_app_navigate() {
        let app = HypenApp::default();
        app.navigate("/users/42");
        assert_eq!(app.router().current_path(), "/users/42");
    }

    #[test]
    fn test_components_dir() {
        let dir = std::env::temp_dir().join("hypen_test_app_components");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        std::fs::write(dir.join("my-widget.hypen"), r#"Column { Text("Widget") }"#).unwrap();

        let app = HypenApp::builder()
            .components_dir(dir.to_str().unwrap())
            .build();

        assert!(app.components().has("MyWidget"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_instantiate_module() {
        let app = HypenApp::default();

        let def = HypenApp::module::<TestState>("Test")
            .state(TestState { value: 10 })
            .on_action::<()>("double", |state, _, _| {
                state.value *= 2;
            })
            .build();

        let instance = app.instantiate(Arc::new(def)).unwrap();
        instance.mount();
        assert_eq!(instance.get_state().value, 10);

        instance.dispatch_action("double", None).unwrap();
        assert_eq!(instance.get_state().value, 20);
    }
}
