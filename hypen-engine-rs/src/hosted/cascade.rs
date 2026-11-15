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
use super::registry::Registry;
use super::report::{
    CascadeFailure, CascadeReport, CascadeRoot, FailureCause, LifecycleHook, Origin,
};
use super::snapshots::SnapshotError;
use super::{CascadeState, EngineCtx, HostedModules, MAX_CASCADE_DEPTH};
use crate::engine_core::EngineCore;
use crate::error::EngineError;
use crate::module_host::{HostAction, ReducerOutput, SiblingState};
use std::collections::VecDeque;

/// Which export of a hosted module a cascade step calls.
pub(crate) enum Call {
    Dispatch(HostAction),
    Lifecycle(LifecycleHook),
}

/// A queued follow-up: run `action` in `scope`'s reducer, because of `origin`.
struct WorkItem {
    scope: ScopeName,
    action: HostAction,
    origin: Origin,
    /// Length of the causal chain ending in this item (the root is depth 1).
    depth: u32,
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
        if action.payload.is_empty() {
            action.payload.extend_from_slice(b"null");
        } else if let Err(e) = serde_json::from_slice::<serde::de::IgnoredAny>(&action.payload) {
            self.fail(CascadeFailure {
                scope: target.to_string(),
                action: action.name,
                origin,
                cause: FailureCause::PayloadNotJson(e.to_string()),
            });
            return;
        }
        self.queue.push_back(WorkItem {
            scope,
            action,
            origin,
            depth: caused_at_depth + 1,
        });
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
        self.fail(CascadeFailure {
            scope: item.scope.as_str().to_string(),
            action: item.action.name,
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
            scope,
            action,
            origin,
            depth,
        }) = cascade.next()
        {
            // The host call consumes the action; keep its name for a failure.
            let name = action.name.clone();
            let step = self
                .invoke(ctx.core, &scope, Call::Dispatch(action))
                .and_then(|output| self.fold_output(ctx, &scope, depth, output, &mut cascade));
            if let Err(cause) = step {
                cascade.fail(CascadeFailure {
                    scope: scope.as_str().to_string(),
                    action: name,
                    origin,
                    cause,
                });
            }
        }
        cascade.into_report()
    }

    /// Log a finished cascade's follow-up failures, remember its report for
    /// [`last_report`](Self::last_report), and turn it into the caller's
    /// result.
    pub(super) fn conclude(&mut self, report: CascadeReport) -> Result<(), EngineError> {
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
        let readable: &[String] = match call {
            Call::Lifecycle(LifecycleHook::Deactivated) => &[],
            Call::Dispatch(_) | Call::Lifecycle(LifecycleHook::Activated) => {
                module.grants.readable()
            }
        };
        let mut siblings: Vec<SiblingState> = Vec::with_capacity(readable.len());
        let mut receipts = Vec::with_capacity(readable.len());
        for name in readable {
            if name == scope.as_str() {
                continue;
            }
            // A grant may name a scope with no state (not registered yet, or
            // destroyed): the module simply is not handed a snapshot of it.
            if let Ok(lease) = self.snapshots.checkout(core, name) {
                let (bytes, receipt) = lease.into_parts();
                siblings.push((name.clone(), bytes));
                receipts.push(receipt);
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
        for ((name, bytes), receipt) in siblings.into_iter().zip(receipts) {
            self.snapshots.checkin(&name, receipt.rejoin(bytes));
        }
        result.map_err(FailureCause::Host)
    }
}
