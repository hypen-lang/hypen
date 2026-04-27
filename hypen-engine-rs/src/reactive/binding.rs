use serde::{Deserialize, Serialize};

/// The source of a binding (state, item, or data source)
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum BindingSource {
    /// Binding to module state: @{state.user.name}
    State,
    /// Binding to iteration item: @{item.name}
    Item,
    /// Binding to a data source plugin: @spacetime.messages, @firebase.user.name
    /// The String is the provider name (e.g., "spacetime", "firebase")
    DataSource(String),
}

/// Represents a parsed binding expression like @{state.user.name} or @{item.name}
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Binding {
    /// The source of the binding (state or item)
    pub source: BindingSource,
    /// The path after the source, e.g., ["user", "name"]
    pub path: Vec<String>,
}

impl Binding {
    pub fn new(source: BindingSource, path: Vec<String>) -> Self {
        Self { source, path }
    }

    /// Create a state binding
    pub fn state(path: Vec<String>) -> Self {
        Self::new(BindingSource::State, path)
    }

    /// Create an item binding
    pub fn item(path: Vec<String>) -> Self {
        Self::new(BindingSource::Item, path)
    }

    /// Create a data source binding
    pub fn data_source(provider: impl Into<String>, path: Vec<String>) -> Self {
        Self::new(BindingSource::DataSource(provider.into()), path)
    }

    /// Check if this is a state binding
    pub fn is_state(&self) -> bool {
        matches!(self.source, BindingSource::State)
    }

    /// Check if this is an item binding
    pub fn is_item(&self) -> bool {
        matches!(self.source, BindingSource::Item)
    }

    /// Check if this is a data source binding
    pub fn is_data_source(&self) -> bool {
        matches!(self.source, BindingSource::DataSource(_))
    }

    /// Get the data source provider name (e.g., "spacetime", "firebase")
    pub fn provider(&self) -> Option<&str> {
        match &self.source {
            BindingSource::DataSource(name) => Some(name.as_str()),
            _ => None,
        }
    }

    /// Get the root key (first segment of path)
    pub fn root_key(&self) -> Option<&str> {
        self.path.first().map(|s| s.as_str())
    }

    /// Get the full path as a dot-separated string (without source prefix)
    pub fn full_path(&self) -> String {
        self.path.join(".")
    }

    /// Get the full path including source prefix (e.g., "state.user.name" or "item.name")
    pub fn full_path_with_source(&self) -> String {
        let prefix = match &self.source {
            BindingSource::State => "state".to_string(),
            BindingSource::Item => "item".to_string(),
            BindingSource::DataSource(provider) => provider.clone(),
        };
        if self.path.is_empty() {
            prefix
        } else {
            format!("{}.{}", prefix, self.path.join("."))
        }
    }
}

/// Check if a string is a valid path segment (identifier or numeric index)
/// Valid segments:
/// - Identifiers: starts with letter/underscore, followed by alphanumerics/underscores
/// - Numeric indices: all digits (for array access like items.0)
fn is_valid_path_segment(s: &str) -> bool {
    if s.is_empty() {
        return false;
    }

    // Allow pure numeric strings for array indexing (e.g., "0", "123")
    if s.chars().all(|c| c.is_ascii_digit()) {
        return true;
    }

    let mut chars = s.chars();
    // First char must be letter or underscore
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    // Rest can be alphanumeric or underscore
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Parse a binding string like "@{state.user.name}" or "@{item.name}" into a Binding.
///
/// Only recognizes `state.*` and `item.*` bindings. Data source bindings
/// (e.g., `@spacetime.messages`) come from the parser's explicit
/// `@provider.path` syntax, NOT from the `@{...}` template syntax.
/// This prevents `@{foo.bar}` from silently becoming a data source binding
/// when `foo` is just a typo or an expression variable.
pub fn parse_binding(s: &str) -> Option<Binding> {
    let trimmed = s.trim();

    // Check for @{...} wrapper
    if !trimmed.starts_with("@{") || !trimmed.ends_with('}') {
        return None;
    }

    // Extract content between @{ and }
    let content = &trimmed[2..trimmed.len() - 1];

    // Only recognize state.* and item.* — nothing else
    let (source, path_start) = if content.starts_with("state.") {
        (BindingSource::State, "state.".len())
    } else if content.starts_with("item.") {
        (BindingSource::Item, "item.".len())
    } else if content == "item" {
        // Handle bare @{item} - represents the whole item
        return Some(Binding::item(vec![]));
    } else {
        // Not a recognized binding prefix — return None.
        // Data source bindings use the parser's @provider.path syntax,
        // not the @{provider.path} template syntax.
        return None;
    };

    // Split by dots after the prefix
    let path: Vec<String> = content[path_start..]
        .split('.')
        .map(|s| s.to_string())
        .collect();

    // Validate that all path segments are valid identifiers
    // This prevents expressions like "active ? 'a' : 'b'" from being parsed as bindings
    for segment in &path {
        if !is_valid_path_segment(segment) {
            return None;
        }
    }

    if path.is_empty() || (path.len() == 1 && path[0].is_empty()) {
        return None;
    }

    Some(Binding::new(source, path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_simple_state_binding() {
        let binding = parse_binding("@{state.user}").unwrap();
        assert!(binding.is_state());
        assert_eq!(binding.path, vec!["user"]);
        assert_eq!(binding.root_key(), Some("user"));
    }

    #[test]
    fn test_parse_nested_state_binding() {
        let binding = parse_binding("@{state.user.name}").unwrap();
        assert!(binding.is_state());
        assert_eq!(binding.path, vec!["user", "name"]);
        assert_eq!(binding.root_key(), Some("user"));
        assert_eq!(binding.full_path(), "user.name");
        assert_eq!(binding.full_path_with_source(), "state.user.name");
    }

    #[test]
    fn test_parse_simple_item_binding() {
        let binding = parse_binding("@{item.name}").unwrap();
        assert!(binding.is_item());
        assert_eq!(binding.path, vec!["name"]);
        assert_eq!(binding.root_key(), Some("name"));
        assert_eq!(binding.full_path(), "name");
        assert_eq!(binding.full_path_with_source(), "item.name");
    }

    #[test]
    fn test_parse_nested_item_binding() {
        let binding = parse_binding("@{item.user.profile.avatar}").unwrap();
        assert!(binding.is_item());
        assert_eq!(binding.path, vec!["user", "profile", "avatar"]);
        assert_eq!(binding.full_path(), "user.profile.avatar");
    }

    #[test]
    fn test_parse_bare_item_binding() {
        let binding = parse_binding("@{item}").unwrap();
        assert!(binding.is_item());
        assert_eq!(binding.path, Vec::<String>::new());
        assert_eq!(binding.full_path(), "");
        assert_eq!(binding.full_path_with_source(), "item");
    }

    #[test]
    fn test_parse_invalid_binding() {
        assert!(parse_binding("state.user").is_none());
        assert!(parse_binding("@{user}").is_none());
        assert!(parse_binding("@{state}").is_none());
    }

    #[test]
    fn test_parse_binding_rejects_unknown_prefix() {
        // @{spacetime.messages} should NOT parse as a binding —
        // data source bindings come from the parser's @provider.path syntax,
        // not from @{...} template syntax
        assert!(parse_binding("@{spacetime.messages}").is_none());
        assert!(parse_binding("@{firebase.user.profile.name}").is_none());
        assert!(parse_binding("@{spacetime}").is_none());
        assert!(parse_binding("@{foo.bar}").is_none());
    }

    #[test]
    fn test_data_source_binding_helpers() {
        let binding = Binding::data_source("convex", vec!["tasks".to_string()]);
        assert!(binding.is_data_source());
        assert!(!binding.is_state());
        assert!(!binding.is_item());
        assert_eq!(binding.provider(), Some("convex"));
    }
}
