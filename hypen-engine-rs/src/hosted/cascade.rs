//! The dispatch cascade: one top-level module call and everything it causes.
//!
//! A cascade starts from a root — an action, a lifecycle hook, or a host
//! state write — and drains the follow-ups its reducer outputs request
//! (`emit`, cross-module dispatch, subscriber notifications) from a FIFO
//! queue until it is empty. Two caps bound it: the depth of any causal chain
//! ([`MAX_CASCADE_DEPTH`], stops ping-pong) and the total number of reducer
//! invocations (the dispatch budget, stops fan-out).
//!
//! Error semantics:
//! - the **root** failing is the caller's error and applies nothing;
//! - a **follow-up** failing, being refused or hitting a cap is recorded in
//!   the [`CascadeReport`] and never stops the rest of the queue. State the
//!   successful steps applied stays applied.

use super::names::ScopeName;
use super::registry::{Granted, Registry};
use super::report::{
    CascadeFailure, CascadeReport, CascadeRoot, FailureCause, LifecycleHook, Origin,
};
use super::snapshots::SnapshotError;
use super::ClosureActions;
use super::{CascadeState, EngineCtx, HostedModules, MAX_CASCADE_DEPTH};
use crate::action_routing::{scoped_action_name, wildcard_covers};
use crate::dispatch::Action;
use crate::engine_core::EngineCore;
use crate::error::EngineError;
use crate::module_host::{HostAction, ReducerOutput, SiblingState};
use std::collections::VecDeque;

/// Which export of a hosted module a cascade step calls.
pub(crate) enum Call {
    Dispatch(HostAction),
    Lifecycle(LifecycleHook),
}

/// What a queued follow-up runs.
enum Work {
    /// `action` in the reducer of the hosted module `scope`.
    Module {
        scope: ScopeName,
        action: HostAction,
    },
    /// The in-process handler of `name` in the non-hosted scope `scope`.
    /// `action` is what the handler receives: the scoped wire name, the
    /// decoded payload, the sending module as `sender`.
    Closure {
        scope: String,
        name: String,
        action: Action,
    },
}

impl Work {
    /// The addressed scope and the bare action name, for a failure record.
    fn into_labels(self) -> (String, String) {
        match self {
            Work::Module { scope, action } => (scope.as_str().to_string(), action.name),
            Work::Closure { scope, name, .. } => (scope, name),
        }
    }
}

/// A queued follow-up: run `work`, because of `origin`.
struct WorkItem {
    work: Work,
    origin: Origin,
    /// Length of the causal chain ending in this item (the root is depth 1).
    depth: u32,
}

/// Why a follow-up's payload cannot cross a module boundary, if it cannot.
/// An empty payload means "no payload" and becomes `null`.
fn normalize_payload(payload: &mut Vec<u8>) -> Result<(), FailureCause> {
    if payload.is_empty() {
        payload.extend_from_slice(b"null");
        return Ok(());
    }
    serde_json::from_slice::<serde::de::IgnoredAny>(payload)
        .map(|_| ())
        .map_err(|e| FailureCause::PayloadNotJson(e.to_string()))
}

/// A follow-up asking to join the queue.
pub(crate) struct FollowUp<'a> {
    /// Canonical name of the scope the action is addressed to.
    pub(crate) target: &'a str,
    pub(crate) action: HostAction,
    pub(crate) origin: Origin,
    /// Depth of the step whose output (or write) caused this follow-up.
    pub(crate) caused_at_depth: u32,
}

/// The work queue, remaining budget and failure log of one cascade.
pub(crate) struct Cascade {
    queue: VecDeque<WorkItem>,
    /// The configured budget, for the exhaustion message.
    budget: usize,
    remaining: usize,
    report: CascadeReport,
}

impl Cascade {
    /// `budget` is clamped to at least 1, so a root can always run.
    pub(crate) fn new(root: CascadeRoot, budget: usize) -> Self {
        let budget = budget.max(1);
        Self {
            queue: VecDeque::new(),
            budget,
            remaining: budget,
            report: CascadeReport::new(root),
        }
    }

    pub(crate) fn fail(&mut self, failure: CascadeFailure) {
        self.report.record(failure);
    }

    /// Queue `follow_up`, or record why it was refused.
    ///
    /// The action name is an opaque string matched against the target's
    /// action set: never parsed, qualified or re-routed. The payload crosses
    /// a module boundary, so it must be JSON; an empty payload means "no
    /// payload" and is delivered as `null`.
    pub(crate) fn admit(&mut self, registry: &Registry, follow_up: FollowUp<'_>) {
        let FollowUp {
            target,
            mut action,
            origin,
            caused_at_depth,
        } = follow_up;
        let refusal = match registry.resolve(target) {
            None => Err(FailureCause::UnknownModule),
            Some((_, module)) if !module.actions.accepts(&action.name) => {
                Err(FailureCause::NotAccepted)
            }
            Some(_) if caused_at_depth >= MAX_CASCADE_DEPTH => Err(FailureCause::DepthExceeded {
                limit: MAX_CASCADE_DEPTH,
            }),
            Some((scope, _)) => Ok(scope),
        };
        let scope = match refusal {
            Ok(scope) => scope.clone(),
            Err(cause) => {
                self.fail(CascadeFailure {
                    scope: target.to_string(),
                    action: action.name,
                    origin,
                    cause,
                });
                return;
            }
        };
        if let Err(cause) = normalize_payload(&mut action.payload) {
            self.fail(CascadeFailure {
                scope: target.to_string(),
                action: action.name,
                origin,
                cause,
            });
            return;
        }
        self.queue.push_back(WorkItem {
            work: Work::Module { scope, action },
            origin,
            depth: caused_at_depth + 1,
        });
    }

    /// Queue a cross-module dispatch from the hosted module `from` (whose
    /// `dispatches` grant on the target the caller has checked), or record
    /// why it was refused.
    ///
    /// A hosted target is queued like any follow-up. Any other target is an
    /// in-process scope: the action goes to the handler registered under the
    /// scope's wire name for it, if there is one. The guest picks the name,
    /// so the engine's reserved `__hypen_*` protocol actions (`__hypen_bind`
    /// writes an arbitrary state path) are never deliverable this way, and a
    /// target or name that could alias another scope's wire name is refused.
    pub(crate) fn admit_cross_dispatch(
        &mut self,
        registry: &Registry,
        closures: &dyn ClosureActions,
        core: &EngineCore,
        from: &ScopeName,
        follow_up: FollowUp<'_>,
    ) {
        if registry.resolve(follow_up.target).is_some() {
            return self.admit(registry, follow_up);
        }
        let FollowUp {
            target,
            mut action,
            origin,
            caused_at_depth,
        } = follow_up;
        let handler = ScopeName::parse(target)
            .ok()
            .filter(|_| wildcard_covers(&action.name) && !action.name.contains(':'))
            .map(|scope| scoped_action_name(scope.as_str(), &action.name))
            .filter(|handler| closures.has_handler(handler));
        let admitted = match handler {
            // No handler: say whether the scope exists at all.
            None if core.modules.contains_key(target) => Err(FailureCause::NotAccepted),
            None => Err(FailureCause::UnknownModule),
            Some(_) if caused_at_depth >= MAX_CASCADE_DEPTH => Err(FailureCause::DepthExceeded {
                limit: MAX_CASCADE_DEPTH,
            }),
            Some(handler) => normalize_payload(&mut action.payload).and_then(|()| {
                serde_json::from_slice::<serde_json::Value>(&action.payload)
                    .map(|payload| (handler, payload))
                    .map_err(|e| FailureCause::PayloadNotJson(e.to_string()))
            }),
        };
        match admitted {
            Ok((handler, payload)) => self.queue.push_back(WorkItem {
                work: Work::Closure {
                    scope: target.to_string(),
                    name: action.name,
                    action: Action {
                        name: handler,
                        payload: Some(payload),
                        sender: Some(from.as_str().to_string()),
                    },
                },
                origin,
                depth: caused_at_depth + 1,
            }),
            Err(cause) => self.fail(CascadeFailure {
                scope: target.to_string(),
                action: action.name,
                origin,
                cause,
            }),
        }
    }

    /// Take one reducer invocation out of the budget, if any is left.
    fn spend(&mut self) -> bool {
        match self.remaining.checked_sub(1) {
            Some(left) => {
                self.remaining = left;
                true
            }
            None => false,
        }
    }

    /// The next item to run. When the budget is exhausted the whole queue is
    /// dropped and reported as one failure naming the first dropped item.
    fn next(&mut self) -> Option<WorkItem> {
        let item = self.queue.pop_front()?;
        if self.spend() {
            return Some(item);
        }
        let dropped = self.queue.len() + 1;
        self.queue.clear();
        let (scope, action) = item.work.into_labels();
        self.fail(CascadeFailure {
            scope,
            action,
            origin: item.origin,
            cause: FailureCause::BudgetExhausted {
                budget: self.budget,
                dropped,
            },
        });
        None
    }

    fn into_report(self) -> CascadeReport {
        self.report
    }
}

impl HostedModules {
    /// Structural mutations of the instance table are refused while a
    /// cascade is draining. `&mut self` already makes that statically
    /// unreachable from safe Rust (no callback is handed the engine); the
    /// state turns a future regression into a clear error instead of a
    /// corrupted queue.
    pub(super) fn reject_during_cascade(&self, what: &str) -> Result<(), EngineError> {
        match self.cascade_state {
            CascadeState::Idle => Ok(()),
            CascadeState::Draining => Err(EngineError::ModuleError(format!(
                "{what} called while a module dispatch cascade is running"
            ))),
        }
    }

    /// Run one top-level module call and drain everything it causes.
    ///
    /// Re-entrancy: a second cascade cannot start while one is draining (it is
    /// rejected with an error). No engine callback receives `&mut Engine`, so
    /// this is unreachable from safe code today; follow-ups a reducer wants
    /// are expressed in its [`ReducerOutput`] and join the running queue.
    pub(super) fn run_cascade(
        &mut self,
        ctx: &mut EngineCtx<'_>,
        scope: ScopeName,
        call: Call,
    ) -> Result<(), EngineError> {
        self.reject_during_cascade("module dispatch")?;
        self.cascade_state = CascadeState::Draining;
        let report = self.drain_from_root(ctx, scope, call);
        self.cascade_state = CascadeState::Idle;
        self.conclude(report)
    }

    fn drain_from_root(
        &mut self,
        ctx: &mut EngineCtx<'_>,
        scope: ScopeName,
        call: Call,
    ) -> CascadeReport {
        let (root, origin) = match &call {
            Call::Dispatch(action) => (
                CascadeRoot::Dispatch {
                    scope: scope.clone(),
                    action: action.name.clone(),
                },
                Origin::Root,
            ),
            Call::Lifecycle(hook) => (
                CascadeRoot::Lifecycle {
                    scope: scope.clone(),
                    hook: *hook,
                },
                Origin::Lifecycle(*hook),
            ),
        };
        let mut cascade = Cascade::new(root, self.dispatch_budget);

        // Root: any failure is the caller's error and nothing is applied.
        // (The budget is at least 1, so the root always gets to run.)
        cascade.spend();
        let step = self
            .invoke(ctx.core, &scope, call)
            .and_then(|output| self.fold_output(ctx, &scope, 1, output, &mut cascade));
        if let Err(cause) = step {
            // The host call consumed the action; the root still names it.
            let action = cascade.report.root().action_label().to_string();
            cascade.fail(CascadeFailure {
                scope: scope.as_str().to_string(),
                action,
                origin,
                cause,
            });
            return cascade.into_report();
        }
        self.drain_queue(ctx, cascade)
    }

    /// Drain `cascade`'s follow-ups — FIFO, each failure recorded, the queue
    /// always emptied — within its remaining budget.
    pub(super) fn drain_queue(
        &mut self,
        ctx: &mut EngineCtx<'_>,
        mut cascade: Cascade,
    ) -> CascadeReport {
        while let Some(WorkItem {
            work,
            origin,
            depth,
        }) = cascade.next()
        {
            match work {
                Work::Module { scope, action } => {
                    // The host call consumes the action; keep its name for a
                    // failure.
                    let name = action.name.clone();
                    let step = self
                        .invoke(ctx.core, &scope, Call::Dispatch(action))
                        .and_then(|output| {
                            self.fold_output(ctx, &scope, depth, output, &mut cascade)
                        });
                    if let Err(cause) = step {
                        cascade.fail(CascadeFailure {
                            scope: scope.as_str().to_string(),
                            action: name,
                            origin,
                            cause,
                        });
                    }
                }
                // An in-process handler returns nothing to fold: whatever it
                // changes reaches the engine as a host write of its own.
                Work::Closure {
                    scope,
                    name,
                    action,
                } => {
                    if let Err(reason) = ctx.closures.deliver(&action) {
                        cascade.fail(CascadeFailure {
                            scope,
                            action: name,
                            origin,
                            cause: FailureCause::Handler(reason),
                        });
                    }
                }
            }
        }
        cascade.into_report()
    }

    /// Log a finished cascade's follow-up failures, remember its report for
    /// [`last_report`](Self::last_report), and turn it into the caller's
    /// result.
    pub(super) fn conclude(&mut self, report: CascadeReport) -> Result<(), EngineError> {
        self.cascades_concluded = self.cascades_concluded.wrapping_add(1);
        if report.is_clean() {
            self.last_report = None;
            return Ok(());
        }
        if report.root_failure().is_none() {
            for failure in report.failures() {
                crate::logger::log(
                    crate::logger::LogLevel::Warn,
                    crate::logger::LogScope::Engine,
                    &format!("module cascade from {}: {failure}", report.root()),
                );
            }
        }
        let error = report.to_engine_error();
        self.last_report = Some(report);
        Err(error)
    }

    /// Call one export of the instance wired under `scope`, handing it the
    /// scope's state and the sibling snapshots its `reads` grant names — and
    /// nothing else. All bytes are lent from the encoded-state cache.
    fn invoke(
        &mut self,
        core: &EngineCore,
        scope: &ScopeName,
        call: Call,
    ) -> Result<ReducerOutput, FailureCause> {
        let module = self
            .registry
            .get(scope.as_str())
            .ok_or(FailureCause::UnknownModule)?;
        let host = self.host.as_deref_mut().ok_or(FailureCause::NoHost)?;
        let own = self
            .snapshots
            .checkout(core, scope.as_str())
            .map_err(|e| match e {
                SnapshotError::NoStateSlot => FailureCause::NoStateSlot,
                SnapshotError::Encode(e) => FailureCause::StateEncoding(e),
            })?;

        // `on_deactivated` takes no sibling snapshots (see `ModuleHost`).
        let readable: &[Granted] = match call {
            Call::Lifecycle(LifecycleHook::Deactivated) => &[],
            Call::Dispatch(_) | Call::Lifecycle(LifecycleHook::Activated) => {
                module.grants.readable()
            }
        };
        let mut siblings: Vec<SiblingState> = Vec::with_capacity(readable.len());
        let mut receipts = Vec::with_capacity(readable.len());
        for granted in readable {
            if granted.scope() == scope.as_str() {
                continue;
            }
            // A grant may name a scope with no state (not registered yet, or
            // destroyed): the module simply is not handed a snapshot of it.
            if let Ok(lease) = self.snapshots.checkout(core, granted.scope()) {
                let (bytes, receipt) = lease.into_parts();
                // The snapshot goes over under the module's own name for the
                // scope — the one its host's ACL and its `read()` calls use.
                siblings.push((granted.name().to_string(), bytes));
                receipts.push((granted.scope(), receipt));
            }
        }

        let result = match call {
            Call::Dispatch(action) => host.dispatch(module.id, own.bytes(), action, &siblings),
            Call::Lifecycle(LifecycleHook::Activated) => {
                host.on_activated(module.id, own.bytes(), &siblings)
            }
            Call::Lifecycle(LifecycleHook::Deactivated) => {
                host.on_deactivated(module.id, own.bytes())
            }
        };

        self.snapshots.checkin(scope.as_str(), own);
        for ((_, bytes), (sibling, receipt)) in siblings.into_iter().zip(receipts) {
            self.snapshots.checkin(sibling, receipt.rejoin(bytes));
        }
        result.map_err(FailureCause::Host)
    }
}
