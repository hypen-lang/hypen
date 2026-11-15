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
use crate::module_host::{ModuleInstanceId, ModuleManifest};
use indexmap::IndexMap;

/// The cross-module capabilities the engine enforces for one hosted scope.
///
/// Mirrors the `reads` / `dispatches` lists of a [`ModuleManifest`]. The
/// engine checks them itself when it folds a reducer's output (cross-module
/// dispatch, `subscribe`) and uses `reads` to decide which sibling snapshots a
/// module is handed at all — it does not rely on the
/// [`ModuleHost`](crate::module_host::ModuleHost) having enforced them. Names
/// are module scopes and compare case-insensitively; there is no wildcard.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ModuleGrants {
    /// Scopes whose state this module may read and subscribe to.
    pub reads: Vec<String>,
    /// Scopes this module may dispatch actions to.
    pub dispatches: Vec<String>,
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
        }
    }
}

impl From<&ModuleManifest> for ModuleGrants {
    fn from(manifest: &ModuleManifest) -> Self {
        Self {
            reads: manifest.reads.clone(),
            dispatches: manifest.dispatches.clone(),
        }
    }
}

/// [`ModuleGrants`] as the engine enforces them: every name canonical
/// (lowercase) and listed once. Built once per wiring, so the checks on the
/// dispatch path are plain string comparisons.
///
/// A grant may name a scope that is not hosted (a closure-backed module's
/// state is readable too) or not registered yet, so the entries are scope
/// *references*, not validated [`ScopeName`]s.
#[derive(Debug, Default)]
pub(crate) struct Grants {
    reads: Vec<String>,
    dispatches: Vec<String>,
}

impl From<ModuleGrants> for Grants {
    fn from(grants: ModuleGrants) -> Self {
        fn canonical(names: Vec<String>) -> Vec<String> {
            let mut out: Vec<String> = Vec::with_capacity(names.len());
            for name in names {
                let name = canonical_scope(&name).into_owned();
                if !out.contains(&name) {
                    out.push(name);
                }
            }
            out
        }
        Self {
            reads: canonical(grants.reads),
            dispatches: canonical(grants.dispatches),
        }
    }
}

impl Grants {
    /// Whether the module may read (and subscribe to) `scope`'s state.
    /// `scope` must be canonical.
    pub(crate) fn may_read(&self, scope: &str) -> bool {
        self.reads.iter().any(|granted| granted == scope)
    }

    /// Whether the module may dispatch actions to `scope` (canonical).
    pub(crate) fn may_dispatch_to(&self, scope: &str) -> bool {
        self.dispatches.iter().any(|granted| granted == scope)
    }

    /// The scopes whose snapshots the module is handed on a call.
    pub(crate) fn readable(&self) -> &[String] {
        &self.reads
    }
}

/// One hosted module scope.
pub(crate) struct HostedModule {
    pub(crate) id: ModuleInstanceId,
    pub(crate) actions: ActionSet,
    pub(crate) grants: Grants,
}

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
        }
    }

    #[test]
    fn grants_are_canonical_and_deduplicated() {
        let grants = Grants::from(ModuleGrants::new(["B", "b", "c"], ["Ä"]));
        assert_eq!(grants.readable(), ["b", "c"]);
        assert!(grants.may_read("b") && !grants.may_read("B") && !grants.may_read("ä"));
        assert!(grants.may_dispatch_to("ä") && !grants.may_dispatch_to("b"));
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
