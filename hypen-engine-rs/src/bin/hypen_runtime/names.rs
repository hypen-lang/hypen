//! Validated name newtypes.
//!
//! The engine keys hosted modules by a lowercase *scope*; `:` is the separator
//! of its scoped wire names (`__hypen_scoped:<scope>:<action>`) and the
//! `__hypen_` prefix is reserved for its own actions. A name that breaks those
//! rules yields a module nobody can address, so such names cannot be
//! constructed: holding a [`ScopeName`] or [`ComponentName`] is the proof that
//! the engine will accept it.

use std::fmt;

/// Prefix the engine reserves for its own action / scope names.
const RESERVED_PREFIX: &str = "__hypen_";

/// Why a string is not a usable module / scope name.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum NameError {
    #[error("name is empty")]
    Empty,
    #[error("`{0}` contains `:`, the engine's scope separator")]
    Colon(String),
    #[error("`{0}` contains whitespace")]
    Whitespace(String),
    #[error("`{0}` uses the reserved `__hypen_` prefix")]
    Reserved(String),
}

fn check(name: &str) -> Result<(), NameError> {
    if name.is_empty() {
        return Err(NameError::Empty);
    }
    if name.contains(':') {
        return Err(NameError::Colon(name.to_string()));
    }
    if name.chars().any(char::is_whitespace) {
        return Err(NameError::Whitespace(name.to_string()));
    }
    if name.to_lowercase().starts_with(RESERVED_PREFIX) {
        return Err(NameError::Reserved(name.to_string()));
    }
    Ok(())
}

/// A module's engine state scope: valid and lowercase by construction.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ScopeName(String);

impl ScopeName {
    /// Validate and lowercase `raw`.
    pub fn new(raw: &str) -> Result<Self, NameError> {
        check(raw)?;
        Ok(ScopeName(raw.to_lowercase()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ScopeName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// A component / module name as written in templates (`Counter`), case
/// preserved. Its scope is the lowercased form.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ComponentName(String);

impl ComponentName {
    pub fn new(raw: &str) -> Result<Self, NameError> {
        check(raw)?;
        Ok(ComponentName(raw.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The engine scope a module with this name registers under.
    pub fn scope(&self) -> ScopeName {
        ScopeName(self.0.to_lowercase())
    }
}

impl fmt::Display for ComponentName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_names_are_lowercased() {
        assert_eq!(ScopeName::new("Counter").unwrap().as_str(), "counter");
        assert_eq!(ComponentName::new("Counter").unwrap().scope().as_str(), "counter");
        assert_eq!(ComponentName::new("Counter").unwrap().as_str(), "Counter");
    }

    #[test]
    fn unaddressable_names_are_rejected() {
        assert_eq!(ScopeName::new(""), Err(NameError::Empty));
        assert_eq!(ScopeName::new("a:b"), Err(NameError::Colon("a:b".into())));
        assert_eq!(ScopeName::new("a b"), Err(NameError::Whitespace("a b".into())));
        assert_eq!(
            ComponentName::new("__hypen_dispatch"),
            Err(NameError::Reserved("__hypen_dispatch".into()))
        );
        // The reserved prefix is matched case-insensitively: the scope is the
        // lowercased name.
        assert!(matches!(ComponentName::new("__HYPEN_x"), Err(NameError::Reserved(_))));
    }
}
