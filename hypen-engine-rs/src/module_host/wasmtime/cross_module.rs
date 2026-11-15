//! `hypen:engine/state`: cross-module read / dispatch / subscribe.
//!
//! The capability is always linked; what a module may do with it is decided
//! at **call time** from its manifest ([`Acl`]). Requests are never executed
//! from inside the guest call — `read` answers from snapshots the engine
//! passed in, and `dispatch` / `subscribe` are queued and handed back to the
//! engine in the reducer output — so a guest cannot re-enter another module
//! (or itself) through the host.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use super::limits::{MAX_CROSS_MODULE_REQUESTS, MAX_CROSS_MODULE_REQUEST_BYTES};
use crate::module_host::kv::ModuleName;
use crate::module_host::{
    HostAction, ModuleManifest, ReducerOutput, SiblingState, SubscribeRequest,
};

/// The manifest grant a cross-module call needs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Grant {
    /// `reads` — covers `read` and `subscribe` (observing state is a read).
    Reads,
    /// `dispatches`.
    Dispatches,
}

impl Grant {
    /// The manifest field that carries this grant.
    pub(crate) fn manifest_field(self) -> &'static str {
        match self {
            Grant::Reads => "reads",
            Grant::Dispatches => "dispatches",
        }
    }
}

/// Which siblings a module may reach, from its manifest. Built once per
/// registration and shared by the module's instances.
#[derive(Debug, Default)]
pub(crate) struct Acl {
    reads: HashSet<ModuleName>,
    dispatches: HashSet<ModuleName>,
}

impl Acl {
    pub(crate) fn from_manifest(manifest: &ModuleManifest) -> Self {
        Self {
            reads: manifest.reads.iter().map(ModuleName::new).collect(),
            dispatches: manifest.dispatches.iter().map(ModuleName::new).collect(),
        }
    }

    fn check(&self, grant: Grant, target: &str) -> Result<(), CrossModuleError> {
        let allowed = match grant {
            Grant::Reads => &self.reads,
            Grant::Dispatches => &self.dispatches,
        };
        if allowed.contains(target) {
            Ok(())
        } else {
            Err(CrossModuleError::PermissionDenied(grant))
        }
    }
}

/// Why a `hypen:engine/state` call was refused.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum CrossModuleError {
    /// The target is readable but the engine supplied no snapshot for it.
    NotFound,
    /// The manifest lacks this grant for the target.
    PermissionDenied(Grant),
    /// A per-call bound was exceeded.
    Limit(String),
}

/// What a guest call queued for the engine to route afterwards.
#[derive(Debug, Default)]
pub(crate) struct Requests {
    dispatches: Vec<(String, HostAction)>,
    subscriptions: Vec<SubscribeRequest>,
}

impl Requests {
    pub(crate) fn attach_to(self, output: &mut ReducerOutput) {
        output.cross_dispatch = self.dispatches;
        output.subscribe_requests = self.subscriptions;
    }
}

/// An export that may use `hypen:engine/state` is running.
#[derive(Debug)]
pub(crate) struct ActiveCall {
    acl: Arc<Acl>,
    /// Snapshots of the siblings the ACL lets this module read.
    siblings: HashMap<String, Vec<u8>>,
    requests: Requests,
}

/// Per-store cross-module state. `Active` only while a `dispatch` /
/// `on-activated` export runs; outside one (`init`, the other lifecycle
/// hooks, component start) every `hypen:engine/state` call is denied.
#[derive(Debug, Default)]
pub(crate) enum CrossModuleCtx {
    #[default]
    Idle,
    Active(ActiveCall),
}

impl CrossModuleCtx {
    /// Enter a call: install the module's ACL and the sibling snapshots it
    /// is allowed to read (the rest are not even copied in).
    pub(crate) fn begin(&mut self, acl: Arc<Acl>, siblings: &[SiblingState]) {
        let siblings = siblings
            .iter()
            .filter(|(name, _)| acl.check(Grant::Reads, name).is_ok())
            .cloned()
            .collect();
        *self = Self::Active(ActiveCall {
            acl,
            siblings,
            requests: Requests::default(),
        });
    }

    /// Leave the call, returning what it queued. Always resets to `Idle` so
    /// nothing leaks into a later call.
    pub(crate) fn end(&mut self) -> Requests {
        match std::mem::take(self) {
            Self::Active(call) => call.requests,
            Self::Idle => Requests::default(),
        }
    }

    pub(crate) fn read(&self, module: &str) -> Result<Vec<u8>, CrossModuleError> {
        let Self::Active(call) = self else {
            return Err(CrossModuleError::PermissionDenied(Grant::Reads));
        };
        call.acl.check(Grant::Reads, module)?;
        call.siblings
            .get(module)
            .cloned()
            .ok_or(CrossModuleError::NotFound)
    }

    pub(crate) fn dispatch(
        &mut self,
        module: String,
        action: HostAction,
    ) -> Result<(), CrossModuleError> {
        let Self::Active(call) = self else {
            return Err(CrossModuleError::PermissionDenied(Grant::Dispatches));
        };
        call.acl.check(Grant::Dispatches, &module)?;
        check_request(
            "dispatch",
            call.requests.dispatches.len(),
            [module.len(), action.name.len(), action.payload.len()],
        )?;
        call.requests.dispatches.push((module, action));
        Ok(())
    }

    pub(crate) fn subscribe(
        &mut self,
        module: String,
        path: String,
        on_change: String,
    ) -> Result<(), CrossModuleError> {
        let Self::Active(call) = self else {
            return Err(CrossModuleError::PermissionDenied(Grant::Reads));
        };
        call.acl.check(Grant::Reads, &module)?;
        check_request(
            "subscribe",
            call.requests.subscriptions.len(),
            [module.len(), path.len(), on_change.len()],
        )?;
        call.requests.subscriptions.push(SubscribeRequest {
            target: module,
            path,
            on_change,
        });
        Ok(())
    }
}

/// Bound one request before it is queued: its size, and how many of its kind
/// this call has queued already.
fn check_request(what: &str, queued: usize, parts: [usize; 3]) -> Result<(), CrossModuleError> {
    let bytes = parts
        .iter()
        .fold(0usize, |sum, part| sum.saturating_add(*part));
    if bytes > MAX_CROSS_MODULE_REQUEST_BYTES {
        return Err(CrossModuleError::Limit(format!(
            "{what} request of {bytes} bytes exceeds the {MAX_CROSS_MODULE_REQUEST_BYTES}-byte limit"
        )));
    }
    if queued >= MAX_CROSS_MODULE_REQUESTS {
        return Err(CrossModuleError::Limit(format!(
            "too many {what} requests in one call (limit {MAX_CROSS_MODULE_REQUESTS})"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn acl(reads: &[&str], dispatches: &[&str]) -> Arc<Acl> {
        Arc::new(Acl::from_manifest(&ModuleManifest {
            reads: reads.iter().map(|s| s.to_string()).collect(),
            dispatches: dispatches.iter().map(|s| s.to_string()).collect(),
            ..ModuleManifest::default()
        }))
    }

    fn action(payload: usize) -> HostAction {
        HostAction::new("go", vec![0; payload])
    }

    #[test]
    fn everything_is_denied_outside_a_call() {
        let mut ctx = CrossModuleCtx::default();
        assert_eq!(
            ctx.read("a"),
            Err(CrossModuleError::PermissionDenied(Grant::Reads))
        );
        assert_eq!(
            ctx.dispatch("a".into(), action(0)),
            Err(CrossModuleError::PermissionDenied(Grant::Dispatches))
        );
        assert_eq!(
            ctx.subscribe("a".into(), "p".into(), "go".into()),
            Err(CrossModuleError::PermissionDenied(Grant::Reads))
        );
    }

    #[test]
    fn the_acl_gates_each_target_and_ungranted_snapshots_are_not_kept() {
        let mut ctx = CrossModuleCtx::default();
        let siblings = vec![
            ("a".to_string(), b"A".to_vec()),
            ("b".to_string(), b"B".to_vec()),
        ];
        ctx.begin(acl(&["a", "ghost"], &["b"]), &siblings);

        assert_eq!(ctx.read("a"), Ok(b"A".to_vec()));
        assert_eq!(
            ctx.read("b"),
            Err(CrossModuleError::PermissionDenied(Grant::Reads))
        );
        assert_eq!(ctx.read("ghost"), Err(CrossModuleError::NotFound));
        let CrossModuleCtx::Active(call) = &ctx else {
            panic!("active")
        };
        assert!(
            !call.siblings.contains_key("b"),
            "unreadable snapshot was copied in"
        );

        assert_eq!(ctx.dispatch("b".into(), action(1)), Ok(()));
        assert_eq!(
            ctx.dispatch("a".into(), action(1)),
            Err(CrossModuleError::PermissionDenied(Grant::Dispatches))
        );
        // Subscribing is a read.
        assert_eq!(ctx.subscribe("a".into(), "p".into(), "go".into()), Ok(()));
        assert_eq!(
            ctx.subscribe("b".into(), "p".into(), "go".into()),
            Err(CrossModuleError::PermissionDenied(Grant::Reads))
        );

        let mut output = ReducerOutput::default();
        ctx.end().attach_to(&mut output);
        assert_eq!(output.cross_dispatch.len(), 1);
        assert_eq!(output.subscribe_requests.len(), 1);
        // Ending the call closes the window again.
        assert_eq!(
            ctx.read("a"),
            Err(CrossModuleError::PermissionDenied(Grant::Reads))
        );
        let mut later = ReducerOutput::default();
        ctx.end().attach_to(&mut later);
        assert!(later.cross_dispatch.is_empty() && later.subscribe_requests.is_empty());
    }

    #[test]
    fn requests_are_bounded_in_size_and_count() {
        let mut ctx = CrossModuleCtx::default();
        ctx.begin(acl(&["a"], &["a"]), &[]);

        let Err(CrossModuleError::Limit(why)) =
            ctx.dispatch("a".into(), action(MAX_CROSS_MODULE_REQUEST_BYTES))
        else {
            panic!("oversized dispatch accepted")
        };
        assert!(why.contains("exceeds"), "{why}");

        for _ in 0..MAX_CROSS_MODULE_REQUESTS {
            ctx.dispatch("a".into(), action(8)).unwrap();
            ctx.subscribe("a".into(), "p".into(), "go".into()).unwrap();
        }
        let Err(CrossModuleError::Limit(why)) = ctx.dispatch("a".into(), action(8)) else {
            panic!("dispatch over the count limit accepted")
        };
        assert!(why.contains("too many dispatch requests"), "{why}");
        let Err(CrossModuleError::Limit(why)) = ctx.subscribe("a".into(), "p".into(), "go".into())
        else {
            panic!("subscribe over the count limit accepted")
        };
        assert!(why.contains("too many subscribe requests"), "{why}");
    }
}
