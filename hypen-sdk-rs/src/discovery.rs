use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::error::{Result, SdkError};

/// A discovered component definition (template + optional module).
#[derive(Debug, Clone)]
pub struct ComponentEntry {
    /// Component name (derived from filename or explicit).
    pub name: String,
    /// Hypen DSL source for the component's UI.
    pub source: String,
    /// File path this was loaded from (if file-based).
    pub path: Option<PathBuf>,
}

/// Registry for discovered and manually registered components.
///
/// Components can be loaded from:
/// - Individual files
/// - A components directory (auto-discovery)
/// - Inline registration
///
/// # Example
///
/// ```rust,ignore
/// use hypen_server::discovery::ComponentRegistry;
///
/// let mut registry = ComponentRegistry::new();
///
/// // Manual registration
/// registry.register("Button", r#"Button { Text("Click") }"#, None);
///
/// // Load from a directory
/// registry.load_dir("./components")?;
///
/// // Look up
/// let button = registry.get("Button");
/// ```
pub struct ComponentRegistry {
    components: HashMap<String, ComponentEntry>,
}

impl ComponentRegistry {
    pub fn new() -> Self {
        Self {
            components: HashMap::new(),
        }
    }

    /// Register a component with inline Hypen DSL source.
    pub fn register(
        &mut self,
        name: impl Into<String>,
        source: impl Into<String>,
        path: Option<PathBuf>,
    ) {
        let name = name.into();
        self.components.insert(
            name.clone(),
            ComponentEntry {
                name,
                source: source.into(),
                path,
            },
        );
    }

    /// Load all `.hypen` files from a directory.
    ///
    /// Component names are derived from filenames:
    /// - `button.hypen` -> `"Button"`
    /// - `user-card.hypen` -> `"UserCard"`
    /// - `my_component.hypen` -> `"MyComponent"`
    pub fn load_dir(&mut self, dir: impl AsRef<Path>) -> Result<Vec<String>> {
        let dir = dir.as_ref();
        if !dir.is_dir() {
            return Err(SdkError::Component(format!(
                "Not a directory: {}",
                dir.display()
            )));
        }

        let mut loaded = Vec::new();
        let entries = std::fs::read_dir(dir).map_err(|e| {
            SdkError::Component(format!("Failed to read directory {}: {e}", dir.display()))
        })?;

        for entry in entries {
            let entry = entry.map_err(|e| SdkError::Component(e.to_string()))?;
            let path = entry.path();

            // Folder-based: Name/component.hypen (e.g., Feed/component.hypen → "Feed")
            if path.is_dir() {
                let component_file = path.join("component.hypen");
                if component_file.exists() {
                    let name = path
                        .file_name()
                        .and_then(|s| s.to_str())
                        .unwrap_or("Unknown")
                        .to_string();
                    let source = std::fs::read_to_string(&component_file).map_err(|e| {
                        SdkError::Component(format!(
                            "Failed to read {}: {e}",
                            component_file.display()
                        ))
                    })?;
                    self.register(&name, source, Some(component_file));
                    loaded.push(name);
                    continue;
                }
                // Also check index.hypen
                let index_file = path.join("index.hypen");
                if index_file.exists() {
                    let name = path
                        .file_name()
                        .and_then(|s| s.to_str())
                        .unwrap_or("Unknown")
                        .to_string();
                    let source = std::fs::read_to_string(&index_file).map_err(|e| {
                        SdkError::Component(format!("Failed to read {}: {e}", index_file.display()))
                    })?;
                    self.register(&name, source, Some(index_file));
                    loaded.push(name);
                    continue;
                }
            }

            // Sibling file: name.hypen (e.g., my-button.hypen → "MyButton")
            if path.extension().and_then(|e| e.to_str()) == Some("hypen") {
                let stem = path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("Unknown");
                // Skip component.hypen and index.hypen in the root (handled by folder pattern)
                if stem == "component" || stem == "index" {
                    continue;
                }
                let name = to_pascal_case(stem);
                let source = std::fs::read_to_string(&path).map_err(|e| {
                    SdkError::Component(format!("Failed to read {}: {e}", path.display()))
                })?;

                self.register(&name, source, Some(path));
                loaded.push(name);
            }
        }

        Ok(loaded)
    }

    /// Load a single component from a file path.
    pub fn load_file(&mut self, path: impl AsRef<Path>) -> Result<String> {
        let path = path.as_ref();
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("Unknown");
        let name = to_pascal_case(stem);
        let source = std::fs::read_to_string(path)
            .map_err(|e| SdkError::Component(format!("Failed to read {}: {e}", path.display())))?;

        self.register(&name, source, Some(path.to_path_buf()));
        Ok(name)
    }

    /// Get a component by name.
    pub fn get(&self, name: &str) -> Option<&ComponentEntry> {
        self.components.get(name)
    }

    /// Check if a component is registered.
    pub fn has(&self, name: &str) -> bool {
        self.components.contains_key(name)
    }

    /// Get all registered component names.
    pub fn names(&self) -> Vec<String> {
        self.components.keys().cloned().collect()
    }

    /// Get all registered component entries.
    pub fn all(&self) -> Vec<&ComponentEntry> {
        self.components.values().collect()
    }

    /// Remove a component.
    pub fn remove(&mut self, name: &str) -> Option<ComponentEntry> {
        self.components.remove(name)
    }

    /// Clear all registered components.
    pub fn clear(&mut self) {
        self.components.clear();
    }

    /// Number of registered components.
    pub fn len(&self) -> usize {
        self.components.len()
    }

    /// Whether the registry is empty.
    pub fn is_empty(&self) -> bool {
        self.components.is_empty()
    }
}

impl Default for ComponentRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// Convert a kebab-case or snake_case filename to PascalCase.
///
/// - `button` -> `Button`
/// - `user-card` -> `UserCard`
/// - `my_component` -> `MyComponent`
fn to_pascal_case(input: &str) -> String {
    input
        .split(['-', '_'])
        .filter(|s| !s.is_empty())
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                Some(c) => {
                    let upper: String = c.to_uppercase().collect();
                    upper + chars.as_str()
                }
                None => String::new(),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_to_pascal_case() {
        assert_eq!(to_pascal_case("button"), "Button");
        assert_eq!(to_pascal_case("user-card"), "UserCard");
        assert_eq!(to_pascal_case("my_component"), "MyComponent");
        assert_eq!(to_pascal_case("a-b-c"), "ABC");
        assert_eq!(to_pascal_case("already"), "Already");
    }

    #[test]
    fn test_register_and_get() {
        let mut registry = ComponentRegistry::new();
        registry.register("Button", r#"Button { Text("Click") }"#, None);

        assert!(registry.has("Button"));
        let entry = registry.get("Button").unwrap();
        assert_eq!(entry.name, "Button");
        assert!(entry.source.contains("Button"));
    }

    #[test]
    fn test_names_and_len() {
        let mut registry = ComponentRegistry::new();
        registry.register("A", "A {}", None);
        registry.register("B", "B {}", None);

        assert_eq!(registry.len(), 2);
        let mut names = registry.names();
        names.sort();
        assert_eq!(names, vec!["A", "B"]);
    }

    #[test]
    fn test_remove() {
        let mut registry = ComponentRegistry::new();
        registry.register("A", "A {}", None);
        assert!(registry.has("A"));

        registry.remove("A");
        assert!(!registry.has("A"));
    }

    #[test]
    fn test_load_dir_with_hypen_files() {
        let dir = std::env::temp_dir().join("hypen_test_load_dir");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        std::fs::write(dir.join("my-button.hypen"), r#"Button { Text("Click") }"#).unwrap();
        std::fs::write(dir.join("user_card.hypen"), r#"Column { Text("User") }"#).unwrap();
        // Non-.hypen file should be ignored
        std::fs::write(dir.join("readme.txt"), "ignore me").unwrap();

        let mut registry = ComponentRegistry::new();
        let loaded = registry.load_dir(&dir).unwrap();

        assert_eq!(loaded.len(), 2);
        assert!(registry.has("MyButton"));
        assert!(registry.has("UserCard"));
        assert!(!registry.has("Readme"));

        let btn = registry.get("MyButton").unwrap();
        assert!(btn.source.contains("Button"));
        assert!(btn.path.is_some());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_load_dir_nonexistent() {
        let mut registry = ComponentRegistry::new();
        let result = registry.load_dir("/tmp/hypen_nonexistent_dir_xyz");
        assert!(result.is_err());
    }

    #[test]
    fn test_load_file() {
        let dir = std::env::temp_dir().join("hypen_test_load_file");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let path = dir.join("counter-view.hypen");
        std::fs::write(&path, r#"Column { Text("Count") }"#).unwrap();

        let mut registry = ComponentRegistry::new();
        let name = registry.load_file(&path).unwrap();

        assert_eq!(name, "CounterView");
        assert!(registry.has("CounterView"));
        assert_eq!(
            registry.get("CounterView").unwrap().source,
            r#"Column { Text("Count") }"#
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_load_file_nonexistent() {
        let mut registry = ComponentRegistry::new();
        let result = registry.load_file("/tmp/hypen_no_such_file.hypen");
        assert!(result.is_err());
    }

    #[test]
    fn test_clear() {
        let mut registry = ComponentRegistry::new();
        registry.register("A", "A {}", None);
        registry.register("B", "B {}", None);

        registry.clear();
        assert!(registry.is_empty());
    }
}
