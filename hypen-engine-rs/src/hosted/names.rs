//! Validated names: the scope a hosted module is wired under and the set of
//! actions it accepts.
//!
//! Both are built once, at the `register_module_instance` /
//! `rewire_module_instance` boundary. Everything behind that boundary holds a
//! [`ScopeName`] (or borrows the registry's interned one) and asks an
//! [`ActionSet`] whether it [`accepts`](ActionSet::accepts) a name — nothing
//! re-validates or re-lowercases a string on the dispatch path.

use crate::action_routing::{wildcard_covers, UI_ACTION};
use indexmap::IndexSet;
use std::borrow::{Borrow, Cow};
use std::fmt;
use std::sync::Arc;

/// Prefix of the engine's reserved protocol names (`__hypen_dispatch`,
/// `__hypen_scoped:…`, `__hypen_bind`, …).
const RESERVED_PREFIX: &str = "__hypen_";

/// Why a scope or action name cannot be used to wire a hosted module.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InvalidName {
    /// The scope is empty or contains `:` — the separator of the scoped wire
    /// name `__hypen_scoped:<scope>:<action>`, so such a scope could alias
    /// another scope's handler record.
    Scope(String),
    /// The scope starts with the engine's reserved `__hypen_` prefix.
    ReservedScope(String),
    /// An action name is empty, contains `:`, or is the reserved
    /// `__hypen_dispatch` envelope name.
    Action { scope: String, action: String },
}

impl fmt::Display for InvalidName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            InvalidName::Scope(scope) => write!(
                f,
                "invalid module scope '{scope}': must be non-empty and contain no ':'"
            ),
            InvalidName::ReservedScope(scope) => write!(
                f,
                "invalid module scope '{scope}': the '{RESERVED_PREFIX}' prefix is reserved for \
                 the engine"
            ),
            InvalidName::Action { scope, action } => write!(
                f,
                "[{scope}] invalid action name '{action}': must be non-empty, contain no ':' \
                 and not be the reserved '{UI_ACTION}'"
            ),
        }
    }
}

/// The canonical spelling of a scope: module scopes are lowercase engine-side.
/// Borrows when `name` already is canonical, which is the common case on the
/// dispatch path (the engine hands out lowercased names).
pub(crate) fn canonical_scope(name: &str) -> Cow<'_, str> {
    // `is_ascii` + no ASCII capital is exactly "to_lowercase() is a no-op" for
    // ASCII input; anything else takes the general (allocating) path.
    if name.is_ascii() && !name.bytes().any(|b| b.is_ascii_uppercase()) {
        Cow::Borrowed(name)
    } else {
        Cow::Owned(name.to_lowercase())
    }
}

/// The scope a hosted module is wired under: lowercased, non-empty, free of
/// `:` and outside the reserved `__hypen_` namespace.
///
/// Cheap to clone (a reference count), so queue items, subscriptions and
/// failure reports can each own one without allocating per dispatch.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ScopeName(Arc<str>);

impl ScopeName {
    /// Validate and canonicalize a caller-supplied scope.
    pub fn parse(scope: &str) -> Result<Self, InvalidName> {
        let canonical = canonical_scope(scope);
        if canonical.is_empty() || canonical.contains(':') {
            return Err(InvalidName::Scope(canonical.into_owned()));
        }
        if canonical.starts_with(RESERVED_PREFIX) {
            return Err(InvalidName::ReservedScope(canonical.into_owned()));
        }
        Ok(Self(Arc::from(canonical.as_ref())))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Borrow<str> for ScopeName {
    fn borrow(&self) -> &str {
        &self.0
    }
}

impl AsRef<str> for ScopeName {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ScopeName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// The action names a hosted module accepts.
///
/// A module's `actions()` list either names every action (`Named`) or contains
/// `"*"` (`Wildcard`): accept any application action. Reserved engine names
/// (`__hypen_bind`, `__hypen_reorder`, …) are protocol, never covered by the
/// wildcard — a module receives them only when it also lists them, which is
/// what `explicit` holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActionSet {
    Named(IndexSet<String>),
    Wildcard { explicit: IndexSet<String> },
}

impl ActionSet {
    /// Validate a module's exported action list for `scope`.
    pub fn parse(scope: &ScopeName, actions: Vec<String>) -> Result<Self, InvalidName> {
        let mut wildcard = false;
        let mut named = IndexSet::with_capacity(actions.len());
        for action in actions {
            if action == "*" {
                wildcard = true;
            } else if action.is_empty() || action.contains(':') || action == UI_ACTION {
                return Err(InvalidName::Action {
                    scope: scope.as_str().to_string(),
                    action,
                });
            } else {
                named.insert(action);
            }
        }
        Ok(if wildcard {
            ActionSet::Wildcard { explicit: named }
        } else {
            ActionSet::Named(named)
        })
    }

    /// Whether the module handles `name`. Guest- and client-supplied names are
    /// matched as opaque strings: never parsed, qualified or re-routed.
    pub fn accepts(&self, name: &str) -> bool {
        match self {
            ActionSet::Named(named) => named.contains(name),
            ActionSet::Wildcard { explicit } => explicit.contains(name) || wildcard_covers(name),
        }
    }

    /// The names listed explicitly (never `"*"`).
    pub fn named(&self) -> &IndexSet<String> {
        match self {
            ActionSet::Named(named) | ActionSet::Wildcard { explicit: named } => named,
        }
    }

    pub fn is_wildcard(&self) -> bool {
        matches!(self, ActionSet::Wildcard { .. })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn actions(scope: &str, names: &[&str]) -> Result<ActionSet, InvalidName> {
        let scope = ScopeName::parse(scope).unwrap();
        ActionSet::parse(&scope, names.iter().map(|n| n.to_string()).collect())
    }

    #[test]
    fn scope_names_are_lowercased_once_and_validated() {
        assert_eq!(ScopeName::parse("Search").unwrap().as_str(), "search");
        assert_eq!(ScopeName::parse("ÄB").unwrap().as_str(), "äb");
        assert!(matches!(ScopeName::parse(""), Err(InvalidName::Scope(_))));
        assert!(matches!(
            ScopeName::parse("a:b"),
            Err(InvalidName::Scope(_))
        ));
        assert!(matches!(
            ScopeName::parse("__Hypen_scoped"),
            Err(InvalidName::ReservedScope(_))
        ));
    }

    #[test]
    fn canonical_scope_borrows_what_is_already_lowercase() {
        assert!(matches!(canonical_scope("search"), Cow::Borrowed("search")));
        assert!(matches!(canonical_scope("Search"), Cow::Owned(s) if s == "search"));
        assert_eq!(canonical_scope("É"), "é");
    }

    #[test]
    fn action_sets_reject_names_that_could_alias_a_wire_name() {
        for bad in ["", "b:x", "__hypen_dispatch"] {
            assert!(
                matches!(actions("a", &["ok", bad]), Err(InvalidName::Action { .. })),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn a_wildcard_covers_application_names_but_not_reserved_ones() {
        let named = actions("a", &["x"]).unwrap();
        assert!(named.accepts("x") && !named.accepts("y") && !named.is_wildcard());

        let wildcard = actions("a", &["*", "__hypen_bind"]).unwrap();
        assert!(wildcard.is_wildcard());
        assert!(wildcard.accepts("anything") && wildcard.accepts("b:x"));
        assert!(wildcard.accepts("__hypen_bind"), "listed explicitly");
        assert!(!wildcard.accepts("__hypen_reorder") && !wildcard.accepts(""));
        assert_eq!(wildcard.named().len(), 1, "\"*\" is not a name");
    }
}
