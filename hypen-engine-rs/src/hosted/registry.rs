//! The instance table: which scopes are hosted, by which instance, with which
//! actions and grants — and the routing records the engine core keeps for
//! them.
//!
//! The table is the source of truth for "is this scope WASM-backed". A module
//! that exports no actions still has an entry, so its lifecycle hooks run and
//! a reload can find the old instance.

use super::names::{canonical_scope, ActionSet, ScopeName};
use super::ClosureActions;
use crate::action_routing::scoped_action_name;
use crate::engine_core::EngineCore;
use crate::module_host::{HttpGrant, ModuleInstanceId, ModuleManifest, ScopeAliases};
use indexmap::IndexMap;
use std::fmt;
use std::sync::Arc;

/// The capabilities the engine enforces for one hosted scope.
///
/// Mirrors the `reads` / `dispatches` lists and the `http` / `http_hosts`
/// grant of a [`ModuleManifest`]. The engine checks them itself when it folds
/// a reducer's output (cross-module dispatch, `subscribe`, deferred HTTP
/// requests) and uses `reads` to decide which sibling snapshots a module is
/// handed at all — it does not rely on the
/// [`ModuleHost`](crate::module_host::ModuleHost) having enforced them. Scope
/// names compare case-insensitively; there is no wildcard.
///
/// `reads` / `dispatches` hold the names *the module uses* — the same lists
/// its host was registered with. A name means the scope of that name unless
/// `aliases` says otherwise (see [`ScopeAliases`]).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ModuleGrants {
    /// Scopes whose state this module may read and subscribe to.
    pub reads: Vec<String>,
    /// Scopes this module may dispatch actions to.
    pub dispatches: Vec<String>,
    /// What the module may request over deferred HTTP
    /// (`hypen:http/deferred`). Default: nothing.
    pub http: HttpGrant,
    /// Which scope a name in `reads` / `dispatches` stands for, where it is
    /// not the scope of that name. Default: none.
    pub aliases: ScopeAliases,
}

impl ModuleGrants {
    /// No cross-module access at all.
    pub fn none() -> Self {
        Self::default()
    }

    pub fn new<R, D>(reads: R, dispatches: D) -> Self
    where
        R: IntoIterator,
        R::Item: Into<String>,
        D: IntoIterator,
        D::Item: Into<String>,
    {
        Self {
            reads: reads.into_iter().map(Into::into).collect(),
            dispatches: dispatches.into_iter().map(Into::into).collect(),
            http: HttpGrant::Denied,
            aliases: ScopeAliases::new(),
        }
    }

    /// The same grants, with the names in `reads` / `dispatches` meaning
    /// what `aliases` says.
    pub fn with_aliases(mut self, aliases: ScopeAliases) -> Self {
        self.aliases = aliases;
        self
    }

    /// The same grants with deferred HTTP allowed as `http` says.
    pub fn with_http(mut self, http: HttpGrant) -> Self {
        self.http = http;
        self
    }
}

impl From<&ModuleManifest> for ModuleGrants {
    fn from(manifest: &ModuleManifest) -> Self {
        Self {
            reads: manifest.reads.clone(),
            dispatches: manifest.dispatches.clone(),
            http: manifest.http_grant(),
            aliases: manifest.aliases.clone(),
        }
    }
}

/// Why a module's alias table cannot be wired. Nothing is changed when one
/// of these is returned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InvalidAlias {
    /// The aliased name is empty, contains `:` or is in the reserved
    /// `__hypen_` namespace: no module could address a scope by it.
    Name(String),
    /// The scope an alias points at cannot be a scope name.
    Target { name: String, target: String },
    /// Two entries alias the same name (names compare case-insensitively) to
    /// different scopes.
    Conflict {
        name: String,
        first: String,
        second: String,
    },
    /// Two names in one grant list stand for the same scope. Each scope a
    /// module can reach has exactly one name in that module.
    SameScope {
        /// `reads` or `dispatches`.
        list: &'static str,
        first: String,
        second: String,
        scope: String,
    },
}

impl fmt::Display for InvalidAlias {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            InvalidAlias::Name(name) => write!(
                f,
                "invalid alias '{name}': an aliased name must be non-empty, contain no ':' and \
                 not start with '__hypen_'"
            ),
            InvalidAlias::Target { name, target } => write!(
                f,
                "alias '{name}' points at '{target}', which cannot be a module scope (non-empty, \
                 no ':', not starting with '__hypen_')"
            ),
            InvalidAlias::Conflict {
                name,
                first,
                second,
            } => write!(
                f,
                "alias '{name}' is given twice, as '{first}' and as '{second}' (names compare \
                 case-insensitively)"
            ),
            InvalidAlias::SameScope {
                list,
                first,
                second,
                scope,
            } => write!(
                f,
                "`{list}` names '{first}' and '{second}', which both stand for the scope \
                 '{scope}' — keep one of them, or point the alias somewhere else"
            ),
        }
    }
}

/// One entry of a grant list: the name the module (and its host) uses, and
/// the scope it stands for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Granted {
    /// Canonical spelling of the module's own name for the scope.
    name: Arc<str>,
    /// The scope an alias points the name at; `None` when the name is the
    /// scope.
    target: Option<Arc<str>>,
}

impl Granted {
    /// The name the module knows the scope by — what crosses the host
    /// boundary.
    pub(crate) fn name(&self) -> &str {
        &self.name
    }

    /// The engine scope the name stands for (canonical).
    pub(crate) fn scope(&self) -> &str {
        self.target.as_deref().unwrap_or(&self.name)
    }

    /// The module's name for the scope, when it differs from the scope — a
    /// shared handle, for a failure record.
    pub(crate) fn alias(&self) -> Option<&Arc<str>> {
        self.target.as_ref().map(|_| &self.name)
    }
}

/// [`ModuleGrants`] as the engine enforces them: every name canonical
/// (lowercase), listed once and resolved to the scope it stands for. Built
/// once per wiring, so the checks on the dispatch path are plain string
/// comparisons and nothing is allocated to look a name up.
///
/// A grant may name a scope that is not hosted (a closure-backed module's
/// state is readable too) or not registered yet, so the entries are scope
/// *references*, not validated [`ScopeName`]s.
#[derive(Debug, Default)]
pub(crate) struct Grants {
    reads: Vec<Granted>,
    dispatches: Vec<Granted>,
    /// Shared with each `Effect::Http` the module causes (the embedder
    /// re-checks it on redirect hops), hence the `Arc`.
    http: Arc<HttpGrant>,
}

impl Grants {
    /// Validate and resolve `grants`. Without aliases this cannot fail.
    pub(crate) fn resolve(grants: ModuleGrants) -> Result<Self, InvalidAlias> {
        let ModuleGrants {
            reads,
            dispatches,
            http,
            aliases,
        } = grants;

        // name → scope, both canonical. An alias of a name to itself says
        // nothing and is dropped.
        let mut table: Vec<(Arc<str>, Arc<str>)> = Vec::with_capacity(aliases.len());
        for (name, target) in aliases.iter() {
            let invalid = |raw: &str| {
                let canonical = canonical_scope(raw);
                ScopeName::parse(&canonical).is_err()
            };
            if invalid(name) {
                return Err(InvalidAlias::Name(name.to_string()));
            }
            if invalid(target) {
                return Err(InvalidAlias::Target {
                    name: name.to_string(),
                    target: target.to_string(),
                });
            }
            let name = canonical_scope(name);
            let target = canonical_scope(target);
            match table.iter().find(|(known, _)| **known == *name) {
                Some((_, first)) if **first != *target => {
                    return Err(InvalidAlias::Conflict {
                        name: name.into_owned(),
                        first: first.to_string(),
                        second: target.into_owned(),
                    });
                }
                Some(_) => {}
                None => table.push((Arc::from(name.as_ref()), Arc::from(target.as_ref()))),
            }
        }

        let list = |names: Vec<String>, which: &'static str| {
            let mut out: Vec<Granted> = Vec::with_capacity(names.len());
            for name in names {
                let name = canonical_scope(&name);
                if out.iter().any(|granted| granted.name() == &*name) {
                    continue;
                }
                let granted = match table.iter().find(|(alias, _)| **alias == *name) {
                    Some((alias, target)) if alias != target => Granted {
                        name: Arc::clone(alias),
                        target: Some(Arc::clone(target)),
                    },
                    _ => Granted {
                        name: Arc::from(name.as_ref()),
                        target: None,
                    },
                };
                if let Some(other) = out.iter().find(|other| other.scope() == granted.scope()) {
                    return Err(InvalidAlias::SameScope {
                        list: which,
                        first: other.name().to_string(),
                        second: granted.name().to_string(),
                        scope: granted.scope().to_string(),
                    });
                }
                out.push(granted);
            }
            Ok(out)
        };
        Ok(Self {
            reads: list(reads, "reads")?,
            dispatches: list(dispatches, "dispatches")?,
            http: Arc::new(http),
        })
    }

    /// The `reads` entry for `name` — the module's own name for a scope,
    /// canonical — if the module may read (and subscribe to) it.
    pub(crate) fn readable_as(&self, name: &str) -> Option<&Granted> {
        self.reads.iter().find(|granted| granted.name() == name)
    }

    /// The `dispatches` entry for `name` (the module's own name, canonical),
    /// if the module may dispatch actions to it.
    pub(crate) fn dispatchable_as(&self, name: &str) -> Option<&Granted> {
        self.dispatches.iter().find(|granted| granted.name() == name)
    }

    /// What the module may request over deferred HTTP.
    pub(crate) fn http(&self) -> &Arc<HttpGrant> {
        &self.http
    }

    /// The scopes whose snapshots the module is handed on a call.
    pub(crate) fn readable(&self) -> &[Granted] {
        &self.reads
    }
}

/// One hosted module scope.
pub(crate) struct HostedModule {
    pub(crate) id: ModuleInstanceId,
    pub(crate) actions: ActionSet,
    pub(crate) grants: Grants,
    /// Which wiring of the scope this is (see [`Wiring`]).
    pub(crate) wiring: Wiring,
}

/// Identifies one wiring of a scope: every `register` / `rewire` gets the
/// next number, engine-wide. Work that outlives a call — an HTTP request in
/// flight — remembers the wiring it belongs to, so its completion can tell
/// "the instance that asked" from a later instance under the same scope
/// (instance ids are the host's and may be reused; these are not).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub(crate) struct Wiring(pub(crate) u64);

/// Hosted module instances by scope.
#[derive(Default)]
pub(crate) struct Registry {
    modules: IndexMap<ScopeName, HostedModule>,
}

impl Registry {
    pub(crate) fn is_empty(&self) -> bool {
        self.modules.is_empty()
    }

    /// Every wired scope, in wiring order.
    pub(crate) fn iter(&self) -> impl Iterator<Item = (&ScopeName, &HostedModule)> {
        self.modules.iter()
    }

    /// The module wired under `scope`, which must already be canonical — a
    /// [`ScopeName`], or the scope part of a scoped wire name.
    pub(crate) fn get(&self, scope: &str) -> Option<&HostedModule> {
        self.modules.get(scope)
    }

    /// Look a caller- or guest-supplied scope up in any letter case, yielding
    /// the table's own interned name alongside the module.
    pub(crate) fn resolve(&self, scope: &str) -> Option<(&ScopeName, &HostedModule)> {
        self.modules.get_key_value(canonical_scope(scope).as_ref())
    }

    /// The scopes that list `action` by name (a wildcard does not count: it
    /// never makes a bare name ambiguous).
    pub(crate) fn exporters_of<'a>(
        &'a self,
        action: &'a str,
    ) -> impl Iterator<Item = &'a ScopeName> + 'a {
        self.modules
            .iter()
            .filter(move |(_, module)| module.actions.named().contains(action))
            .map(|(scope, _)| scope)
    }

    /// Record `scope` as hosted by `module`. Each explicit action name is
    /// also noted as a scoped handler in the core, and a wildcard scope is
    /// flagged there, so [`EngineCore::route_ui_action`] resolves renderer
    /// envelopes for nodes this module owns instead of failing closed.
    pub(crate) fn wire(&mut self, core: &mut EngineCore, scope: ScopeName, module: HostedModule) {
        for action in module.actions.named() {
            core.note_handler(&scoped_action_name(scope.as_str(), action));
        }
        if module.actions.is_wildcard()
            && !core
                .wildcard_action_scopes
                .iter()
                .any(|s| s == scope.as_str())
        {
            core.wildcard_action_scopes.push(scope.as_str().to_string());
        }
        self.modules.insert(scope, module);
    }

    /// Forget the instance wired under `scope`: its table entry and the core
    /// records [`wire`](Self::wire) added — the wildcard flag and each scoped
    /// handler name, unless a closure handler is registered under that same
    /// name (then the record is the closure's, and stays).
    pub(crate) fn unwire(
        &mut self,
        core: &mut EngineCore,
        closures: &dyn ClosureActions,
        scope: &str,
    ) -> Option<HostedModule> {
        core.wildcard_action_scopes.retain(|s| s != scope);
        let module = self.modules.shift_remove(scope)?;
        for action in module.actions.named() {
            let scoped = scoped_action_name(scope, action);
            if !closures.has_handler(&scoped) {
                core.registered_actions.retain(|a| a != &scoped);
            }
        }
        Some(module)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dispatch::ActionDispatcher;

    fn module(id: u64, actions: &[&str]) -> HostedModule {
        let scope = ScopeName::parse("any").unwrap();
        let actions = actions.iter().map(|a| a.to_string()).collect();
        HostedModule {
            id: ModuleInstanceId(id),
            actions: ActionSet::parse(&scope, actions).unwrap(),
            grants: Grants::default(),
            wiring: Wiring::default(),
        }
    }

    fn names(list: &[Granted]) -> Vec<(&str, &str)> {
        list.iter().map(|g| (g.name(), g.scope())).collect()
    }

    #[test]
    fn grants_are_canonical_and_deduplicated() {
        let grants = Grants::resolve(ModuleGrants::new(["B", "b", "c"], ["Ä"])).unwrap();
        assert_eq!(names(grants.readable()), [("b", "b"), ("c", "c")]);
        assert!(grants.readable_as("b").is_some());
        assert!(grants.readable_as("B").is_none() && grants.readable_as("ä").is_none());
        assert!(grants.dispatchable_as("ä").is_some() && grants.dispatchable_as("b").is_none());
        assert!(grants.readable().iter().all(|g| g.alias().is_none()));
    }

    fn aliased(reads: &[&str], dispatches: &[&str], aliases: &[(&str, &str)]) -> ModuleGrants {
        ModuleGrants::new(reads.iter().copied(), dispatches.iter().copied())
            .with_aliases(aliases.iter().copied().collect())
    }

    #[test]
    fn an_alias_says_which_scope_a_granted_name_means() {
        let grants = Grants::resolve(aliased(
            &["Cart", "user"],
            &["cart"],
            &[("Cart", "Acme__Cart"), ("user", "user"), ("unused", "x")],
        ))
        .unwrap();
        assert_eq!(
            names(grants.readable()),
            [("cart", "acme__cart"), ("user", "user")]
        );
        let cart = grants.dispatchable_as("cart").unwrap();
        assert_eq!((cart.scope(), cart.alias().map(|a| &**a)), ("acme__cart", Some("cart")));
        // The scope's own name is not a name the module has for it, an alias
        // of a name to itself is no alias, and an alias grants nothing.
        assert!(grants.readable_as("acme__cart").is_none());
        assert!(grants.readable_as("user").unwrap().alias().is_none());
        assert!(grants.readable_as("unused").is_none() && grants.readable_as("x").is_none());
    }

    #[test]
    fn aliases_are_not_chained_so_a_swap_is_not_a_cycle() {
        let grants = Grants::resolve(aliased(&["a", "b"], &[], &[("a", "b"), ("b", "a")])).unwrap();
        assert_eq!(names(grants.readable()), [("a", "b"), ("b", "a")]);
    }

    #[test]
    fn bad_alias_tables_are_refused_with_the_reason() {
        let err = |grants| Grants::resolve(grants).unwrap_err();
        assert_eq!(
            err(aliased(&[], &[], &[("", "x")])),
            InvalidAlias::Name(String::new())
        );
        assert!(matches!(
            err(aliased(&[], &[], &[("__hypen_x", "x")])),
            InvalidAlias::Name(_)
        ));
        for target in ["", "a:b", "__hypen_scoped"] {
            assert!(
                matches!(
                    err(aliased(&["cart"], &[], &[("cart", target)])),
                    InvalidAlias::Target { .. }
                ),
                "{target:?}"
            );
        }
        assert_eq!(
            err(aliased(&[], &[], &[("Cart", "a"), ("cart", "b")])),
            InvalidAlias::Conflict {
                name: "cart".into(),
                first: "a".into(),
                second: "b".into()
            }
        );
        // The same alias twice is not a conflict.
        assert!(Grants::resolve(aliased(&[], &[], &[("Cart", "a"), ("cart", "A")])).is_ok());

        // An aliased name landing on a scope another granted name already
        // means: the module would see one scope under two names.
        let same = err(aliased(&["basket", "cart"], &[], &[("cart", "basket")]));
        assert_eq!(
            same,
            InvalidAlias::SameScope {
                list: "reads",
                first: "basket".into(),
                second: "cart".into(),
                scope: "basket".into()
            }
        );
        assert!(same.to_string().contains("'basket' and 'cart'"), "{same}");
        assert!(matches!(
            err(aliased(&[], &["a", "b"], &[("a", "x"), ("b", "x")])),
            InvalidAlias::SameScope { list: "dispatches", .. }
        ));
    }

    #[test]
    fn wiring_records_routes_in_the_core_and_unwiring_removes_exactly_those() {
        let mut core = EngineCore::new();
        let mut closures = ActionDispatcher::new();
        let mut registry = Registry::default();
        let scope = ScopeName::parse("A").unwrap();

        // A closure handler shares one scoped name with the module.
        let shared = scoped_action_name("a", "shared");
        core.note_handler(&shared);
        closures.on(shared.clone(), |_| {});

        registry.wire(&mut core, scope.clone(), module(7, &["x", "shared", "*"]));
        assert!(core
            .registered_actions
            .contains(&scoped_action_name("a", "x")));
        assert_eq!(core.wildcard_action_scopes, ["a"]);
        assert_eq!(
            registry
                .resolve("A")
                .map(|(name, m)| (name.as_str(), m.id.0)),
            Some(("a", 7))
        );
        assert_eq!(registry.exporters_of("x").count(), 1);
        assert_eq!(
            registry.exporters_of("anything").count(),
            0,
            "wildcard is not an export"
        );

        // Re-wiring a wildcard scope does not duplicate its flag.
        registry.wire(&mut core, scope, module(8, &["x", "shared", "*"]));
        assert_eq!(core.wildcard_action_scopes, ["a"]);

        let removed = registry.unwire(&mut core, &closures, "a").unwrap();
        assert_eq!(removed.id, ModuleInstanceId(8));
        assert!(registry.is_empty() && core.wildcard_action_scopes.is_empty());
        assert!(!core
            .registered_actions
            .contains(&scoped_action_name("a", "x")));
        assert!(
            core.registered_actions.contains(&shared),
            "the closure's record stays"
        );
        assert!(registry.unwire(&mut core, &closures, "a").is_none());
    }
}
