//! Scope aliases: what the names in a module's `reads` / `dispatches` mean.
//!
//! A module addresses its siblings by literal name through
//! `hypen:engine/state` (`read("cart")`, `dispatch("cart", …)`,
//! `subscribe("cart", …)`), and nothing in the contract tells it that a
//! sibling lives under another scope in this app — because the app renamed
//! it, or because it is an internal module of a package installed under a
//! namespaced scope. The alias table closes that gap on the engine's side of
//! the host boundary, in one place for every host:
//!
//! - the module, its host and its manifest keep using the module's own names
//!   (the keys);
//! - the engine translates a key to the scope it stands for (the value)
//!   wherever a name crosses the boundary — the sibling snapshots it hands
//!   over, the cross-dispatch and `subscribe` targets it gets back.
//!
//! An alias grants nothing: a name still has to be listed in `reads` /
//! `dispatches`. A name without an alias means the scope of that name, so an
//! empty table is exactly the behaviour without this type. Aliases are not
//! chained (`a → b` and `b → c` do not make `a` mean `c`), so a table cannot
//! contain a cycle. The table is validated when the module is wired (see
//! `InvalidAlias` in the `hosted` subsystem).

use std::collections::BTreeMap;

/// A module's alias table: the name the module uses → the engine scope it
/// means. Names compare case-insensitively once wired; here they are kept as
/// given.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(transparent)]
pub struct ScopeAliases(BTreeMap<String, String>);

impl ScopeAliases {
    /// No aliases: every name means the scope of that name.
    pub fn new() -> Self {
        Self::default()
    }

    /// Make `name` (as the module spells it) mean `scope`. Replaces an
    /// earlier alias of exactly that spelling.
    pub fn insert(&mut self, name: impl Into<String>, scope: impl Into<String>) -> &mut Self {
        self.0.insert(name.into(), scope.into());
        self
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    /// `(name, scope)` pairs, ordered by name.
    pub fn iter(&self) -> impl Iterator<Item = (&str, &str)> {
        self.0.iter().map(|(name, scope)| (name.as_str(), scope.as_str()))
    }
}

impl<N: Into<String>, S: Into<String>> FromIterator<(N, S)> for ScopeAliases {
    fn from_iter<I: IntoIterator<Item = (N, S)>>(iter: I) -> Self {
        Self(
            iter.into_iter()
                .map(|(name, scope)| (name.into(), scope.into()))
                .collect(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aliases_are_a_json_object_and_absent_means_none() {
        let aliases: ScopeAliases = serde_json::from_str(r#"{"cart":"acme__cart"}"#).unwrap();
        assert_eq!(aliases.iter().collect::<Vec<_>>(), [("cart", "acme__cart")]);
        assert_eq!(serde_json::to_string(&aliases).unwrap(), r#"{"cart":"acme__cart"}"#);

        let manifest: crate::module_host::ModuleManifest =
            serde_json::from_str(r#"{"name":"m","reads":["cart"]}"#).unwrap();
        assert!(manifest.aliases.is_empty());
        // A manifest without aliases serializes as it always did.
        assert!(!serde_json::to_string(&manifest).unwrap().contains("aliases"));
    }
}
