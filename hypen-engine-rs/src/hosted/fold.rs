//! Folding a reducer output into the engine.
//!
//! One output is applied in a fixed order:
//!
//! 1. **State** — the scope's state is replaced wholesale with what the
//!    reducer returned; the old/new comparison only yields the changed paths
//!    (binding invalidation, subscriber matching). Unusable state rejects the
//!    whole output: nothing below runs.
//! 2. **Subscriptions** the reducer requested (so one created here does not
//!    fire on the very change that created it — step 1 already picked who to
//!    notify).
//! 3. **Effects** (`Log` engine-side, `Navigate`/`Delay` via the embedder),
//!    then the **deferred HTTP requests** the reducer queued: each is
//!    admitted (see `http`) and handed to the embedder as `Effect::Http`.
//! 4. **Follow-ups**, queued in this order: `emit` (always the emitting scope),
//!    cross-module dispatch (needs the `dispatches` grant; the target is a
//!    hosted module or an in-process scope's handler), subscriber
//!    notifications (run in the subscriber).
//!
//! Everything a guest supplies here — action names, targets, payloads, state
//! — is untrusted: grants are re-checked whatever the host enforced, and
//! names are matched, never routed by parsing them.

use super::cascade::{Cascade, FollowUp};
use super::names::{canonical_scope, ScopeName};
use super::paths::collect_changed_paths;
use super::report::{CascadeFailure, FailureCause, InvalidState, Origin};
use super::subscriptions::Notification;
use super::{EngineCtx, HostedModules};
use crate::module_host::{Effect, HostAction, LogLevel, ReducerOutput};

impl HostedModules {
    /// Fold one [`ReducerOutput`] of `scope`, produced by a step at `depth`,
    /// and queue its follow-ups.
    ///
    /// Returns `Err` — with nothing applied — only when the returned state is
    /// unusable. Refused follow-ups and subscriptions are recorded on
    /// `cascade` and never stop the rest of the output from being applied.
    pub(super) fn fold_output(
        &mut self,
        ctx: &mut EngineCtx<'_>,
        scope: &ScopeName,
        depth: u32,
        output: ReducerOutput,
        cascade: &mut Cascade,
    ) -> Result<(), FailureCause> {
        let ReducerOutput {
            state,
            effects,
            emit,
            cross_dispatch,
            subscribe_requests,
            http_requests,
        } = output;

        // 1. State.
        let notifications = match state {
            Some(bytes) => self.replace_state(ctx, scope, &bytes)?,
            None => Vec::new(),
        };

        // 2. Subscriptions this reducer requested (subscriber = this scope).
        if !subscribe_requests.is_empty() {
            match self.registry.get(scope.as_str()) {
                Some(module) => {
                    for request in subscribe_requests {
                        if let Err(refusal) = self.subscriptions.add(scope, module, request) {
                            cascade.fail(*refusal);
                        }
                    }
                }
                // Unreachable: the output came from this scope's instance and
                // the table cannot change mid-cascade. Reported, not assumed.
                None => {
                    for request in subscribe_requests {
                        cascade.fail(CascadeFailure {
                            scope: scope.as_str().to_string(),
                            action: request.on_change,
                            origin: Origin::SubscribeRequest {
                                target: request.target,
                                path: request.path,
                                scope: None,
                            },
                            cause: FailureCause::UnknownModule,
                        });
                    }
                }
            }
        }

        // 3. Side effects.
        for effect in effects {
            self.perform_effect(scope.as_str(), effect);
        }
        // 3b. Deferred HTTP requests. A refused one is completed as `denied`
        //     by a follow-up queued here, ahead of the reducer's own.
        if !http_requests.is_empty() {
            self.admit_http_requests(scope, depth, http_requests, cascade);
        }

        // 4a. `emit` always targets the emitting module's own scope.
        for action in emit {
            cascade.admit(
                &self.registry,
                FollowUp {
                    target: scope.as_str(),
                    action,
                    origin: Origin::Emit,
                    caused_at_depth: depth,
                },
            );
        }
        // 4b. Cross-dispatch needs the sender's `dispatches` grant on the
        //     target, re-checked here whatever the host enforced.
        for (target, action) in cross_dispatch {
            // `target` is the sender's own name for a scope; its grant entry
            // says which scope that is.
            let target = canonical_scope(&target);
            let granted = self
                .registry
                .get(scope.as_str())
                .and_then(|module| module.grants.dispatchable_as(&target));
            let Some(granted) = granted else {
                cascade.fail(CascadeFailure {
                    scope: target.to_string(),
                    action: action.name,
                    origin: Origin::CrossDispatch {
                        from: scope.clone(),
                        addressed_as: None,
                    },
                    cause: FailureCause::DispatchDenied {
                        missing_grant: target.into_owned(),
                    },
                });
                continue;
            };
            cascade.admit_cross_dispatch(
                &self.registry,
                ctx.closures,
                ctx.core,
                scope,
                FollowUp {
                    target: granted.scope(),
                    action,
                    origin: Origin::CrossDispatch {
                        from: scope.clone(),
                        addressed_as: granted.alias().cloned(),
                    },
                    caused_at_depth: depth,
                },
            );
        }
        // 4c. Subscriber notifications run in the subscriber's own scope.
        self.admit_notifications(cascade, notifications, depth);
        Ok(())
    }

    /// Queue the `on_change` of each notification, as caused by a write at
    /// `depth`.
    pub(super) fn admit_notifications(
        &self,
        cascade: &mut Cascade,
        notifications: Vec<Notification>,
        depth: u32,
    ) {
        for Notification {
            subscriber,
            on_change,
            target,
            path,
        } in notifications
        {
            cascade.admit(
                &self.registry,
                FollowUp {
                    target: subscriber.as_str(),
                    action: HostAction::new(on_change, b"null".to_vec()),
                    origin: Origin::SubscriptionChange { target, path },
                    caused_at_depth: depth,
                },
            );
        }
    }

    /// Make `bytes` — the whole state a reducer returned — `scope`'s state,
    /// re-render what is bound to the paths that changed, and return the
    /// subscriber notifications the change owes.
    fn replace_state(
        &mut self,
        ctx: &mut EngineCtx<'_>,
        scope: &ScopeName,
        bytes: &[u8],
    ) -> Result<Vec<Notification>, FailureCause> {
        let new_state: serde_json::Value = serde_json::from_slice(bytes)
            .map_err(|e| FailureCause::InvalidState(InvalidState::NotJson(e.to_string())))?;
        if !new_state.is_object() {
            return Err(FailureCause::InvalidState(InvalidState::NotAnObject));
        }
        let old_state = ctx
            .core
            .get_module_state(scope.as_str())
            .ok_or(FailureCause::NoStateSlot)?;
        let mut changed = Vec::new();
        collect_changed_paths(old_state, &new_state, &mut String::new(), &mut changed);
        if changed.is_empty() {
            return Ok(Vec::new());
        }
        ctx.core
            .replace_module_state(scope.as_str(), new_state, &changed);
        ctx.render_dirty();
        Ok(self
            .subscriptions
            .notifications_for(scope.as_str(), &changed))
    }

    /// Perform an effect a reducer returned. `Log` is handled here directly.
    /// `Navigate` and `Delay` need the embedder (a router / a timer), so they
    /// go to the installed effect handler. (`Http` is not something a reducer
    /// returns: the engine creates it in `admit_http_requests`.)
    ///
    /// With no handler installed the engine cannot perform them. That is not
    /// a failure of the dispatch (the reducer ran and its state stands), so
    /// it is not reported as one; the dropped effect is logged — a lost
    /// `Delay` continuation at `Warn`.
    fn perform_effect(&self, scope: &str, effect: Effect) {
        use crate::logger::{log, LogLevel as Level, LogScope};
        match (&effect, &self.on_effect) {
            (Effect::Log { level, message }, _) => {
                let level = match level {
                    LogLevel::Trace => Level::Trace,
                    LogLevel::Debug => Level::Debug,
                    LogLevel::Info => Level::Info,
                    LogLevel::Warn => Level::Warn,
                    LogLevel::Error => Level::Error,
                };
                log(level, LogScope::Engine, &format!("[{scope}] {message}"));
            }
            (Effect::Navigate(_) | Effect::Delay { .. }, Some(handler)) => handler(scope, &effect),
            (Effect::Navigate(path), None) => log(
                Level::Debug,
                LogScope::Engine,
                &format!("[{scope}] navigate -> {path} (no effect handler)"),
            ),
            (Effect::Delay { ms, then }, None) => log(
                Level::Warn,
                LogScope::Engine,
                &format!("[{scope}] Delay({ms}ms -> {then}) dropped (no effect handler)"),
            ),
            // No host produces this (it carries an engine-issued id); one that
            // did would be asking the embedder to perform a request that was
            // never admitted.
            (Effect::Http(_), _) => log(
                Level::Warn,
                LogScope::Engine,
                &format!(
                    "[{scope}] ignored an `Http` effect in a reducer output; requests are \
                     queued through `hypen:http/deferred`"
                ),
            ),
        }
    }
}
