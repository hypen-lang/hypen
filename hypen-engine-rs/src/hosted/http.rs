//! Deferred HTTP (`hypen:http/deferred`), engine side: admitting the requests
//! a reducer queued, tracking them while the embedder performs them, and
//! turning the embedder's outcome into the module's completion action.
//!
//! ```text
//! reducer ──send──▶ host queue ──ReducerOutput.http_requests──▶ admit (here)
//!                                                         │ Effect::Http { id, … }
//!                                                         ▼
//! module ◀── `then`(payload) ── complete (here) ◀── embedder performs it
//! ```
//!
//! **Admission** re-checks everything, whatever the host enforced (a host is
//! not trusted to have applied the bounds or the allowlist): the module
//! accepts `then`; the request is well-formed and within bounds; the grant
//! allows the URL's host; the module is under its in-flight cap; an effect
//! handler exists to perform it. A refusal is recorded on the cascade like a
//! refused cross-dispatch and never fails the dispatch that queued it.
//!
//! **One completion per accepted `send`.** The module was told `ok` when it
//! queued the request, so a request refused here is still *completed*: its
//! `then` runs in the same cascade with `{ ok: false, error: { kind:
//! "denied" } }` (unless `then` itself is what was wrong). A module therefore
//! never waits for a completion that cannot come.
//!
//! **In flight.** Each admitted request is remembered under its
//! [`HttpRequestId`] with the [`Wiring`] of the instance that asked. The
//! in-flight count of a module is the number of entries with its current
//! wiring, so destroying or reloading a module frees its slots at once; the
//! entries themselves stay until the embedder completes them, and such a
//! late completion is dropped quietly instead of reaching a different
//! instance.

use std::collections::HashMap;
use std::sync::Arc;

use super::cascade::{Call, Cascade, FollowUp};
use super::names::ScopeName;
use super::registry::Wiring;
use super::report::{CascadeFailure, FailureCause, HttpLimit, Origin};
use super::{EngineCtx, HostedModules};
use crate::error::EngineError;
use crate::module_host::{
    Effect, HostAction, HttpDenial, HttpEffect, HttpFailure, HttpFailureKind, HttpGrant,
    HttpOutcome, HttpRequestId, HttpUrl, QueuedHttpRequest, DEFAULT_HTTP_IN_FLIGHT_PER_MODULE,
    MAX_HTTP_REQUESTS_PER_CALL,
};

/// A request the embedder is performing.
struct Pending {
    scope: ScopeName,
    wiring: Wiring,
    then: String,
    tag: Option<String>,
    /// The grant the request was admitted under, for redirect checks by id.
    grant: Arc<HttpGrant>,
}

/// The requests in flight, by id.
pub(crate) struct InFlight {
    pending: HashMap<HttpRequestId, Pending>,
    next_id: u64,
    /// Per-module cap.
    limit: usize,
}

impl Default for InFlight {
    fn default() -> Self {
        Self {
            pending: HashMap::new(),
            next_id: 1,
            limit: DEFAULT_HTTP_IN_FLIGHT_PER_MODULE,
        }
    }
}

impl InFlight {
    fn count_for(&self, scope: &ScopeName, wiring: Wiring) -> usize {
        self.pending
            .values()
            .filter(|p| p.wiring == wiring && p.scope == *scope)
            .count()
    }

    fn insert(&mut self, pending: Pending) -> HttpRequestId {
        let id = HttpRequestId(self.next_id);
        // 2^64 requests do not happen; wrapping keeps this total anyway.
        self.next_id = self.next_id.wrapping_add(1);
        self.pending.insert(id, pending);
        id
    }
}

/// What became of a completion.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HttpDelivery {
    /// The module's `then` action ran with the outcome.
    Delivered,
    /// The module that queued the request was destroyed or reloaded while it
    /// was in flight; the outcome was discarded.
    ModuleGone,
}

/// Why `Engine::complete_http_request` did not deliver.
#[derive(Debug, Clone, PartialEq)]
pub enum HttpCompletionError {
    /// No request is in flight under this id: it was never issued by this
    /// engine, or it was completed already. Nothing ran.
    UnknownRequest(HttpRequestId),
    /// The completion was delivered and the module's `then` cascade failed —
    /// the error `Engine::dispatch_module_action` would have returned, with
    /// its report in `Engine::last_module_cascade_report`. The request is
    /// complete either way; do not complete it again.
    Cascade(EngineError),
}

impl std::fmt::Display for HttpCompletionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnknownRequest(id) => write!(
                f,
                "no HTTP request is in flight under id {id} (never issued by this engine, or \
                 already completed)"
            ),
            Self::Cascade(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for HttpCompletionError {}

/// What admission established about a request.
struct Admitted {
    url: HttpUrl,
    grant: Arc<HttpGrant>,
    wiring: Wiring,
}

/// Why a queued request is not handed to the embedder.
enum Refusal {
    /// `then` is not one of the module's actions: nothing can be delivered.
    UnknownThen,
    /// Anything else: reported, and completed as `denied`.
    Refused(FailureCause),
}

impl HostedModules {
    pub(crate) fn http_in_flight_limit(&self) -> usize {
        self.http.limit
    }

    /// Clamped to at least 1 so a granted module can always make a request.
    pub(crate) fn set_http_in_flight_limit(&mut self, limit: usize) {
        self.http.limit = limit.max(1);
    }

    /// How many requests `scope`'s current instance has in flight.
    pub(crate) fn http_in_flight(&self, scope: &str) -> usize {
        self.registry
            .resolve(scope)
            .map_or(0, |(scope, module)| self.http.count_for(scope, module.wiring))
    }

    /// Whether the request in flight under `id` may be redirected to `url`:
    /// its module's grant, applied to another hop. `None` for an unknown id.
    pub(crate) fn http_redirect_check(
        &self,
        id: HttpRequestId,
        url: &HttpUrl,
    ) -> Option<Result<(), HttpDenial>> {
        self.http.pending.get(&id).map(|p| p.grant.check(url))
    }

    /// Admit the requests `scope`'s reducer queued (fold step 3b), handing
    /// each admitted one to the effect handler and recording why any other
    /// was refused.
    pub(super) fn admit_http_requests(
        &mut self,
        scope: &ScopeName,
        depth: u32,
        requests: Vec<QueuedHttpRequest>,
        cascade: &mut Cascade,
    ) {
        for (index, queued) in requests.into_iter().enumerate() {
            let cause = match self.check_http_request(scope, index, &queued) {
                Ok(admitted) => {
                    self.start_http_request(scope, queued, admitted);
                    continue;
                }
                Err(Refusal::UnknownThen) => FailureCause::NotAccepted,
                Err(Refusal::Refused(cause)) => {
                    // The module was told `ok`: complete the request as
                    // denied so it is not left waiting.
                    let outcome = HttpOutcome::Failure(HttpFailure::new(
                        HttpFailureKind::Denied,
                        cause.http_refusal_message(),
                    ));
                    cascade.admit(
                        &self.registry,
                        FollowUp {
                            target: scope.as_str(),
                            action: HostAction::new(
                                queued.then.clone(),
                                outcome.into_payload(queued.tag.as_deref()),
                            ),
                            origin: Origin::HttpRefusal,
                            caused_at_depth: depth,
                        },
                    );
                    cause
                }
            };
            cascade.fail(CascadeFailure {
                scope: scope.as_str().to_string(),
                origin: Origin::http_request(&queued.request.method, &queued.request.url),
                action: queued.then,
                cause,
            });
        }
    }

    /// Decide whether the `index`-th request of a reducer output may be
    /// handed to the embedder. Changes nothing.
    fn check_http_request(
        &self,
        scope: &ScopeName,
        index: usize,
        queued: &QueuedHttpRequest,
    ) -> Result<Admitted, Refusal> {
        let refused = |cause: FailureCause| Err(Refusal::Refused(cause));
        let Some(module) = self.registry.get(scope.as_str()) else {
            // Unreachable: the output came from this scope's instance.
            return refused(FailureCause::UnknownModule);
        };
        if !module.actions.accepts(&queued.then) {
            return Err(Refusal::UnknownThen);
        }
        if index >= MAX_HTTP_REQUESTS_PER_CALL {
            let limit = HttpLimit::PerCall(MAX_HTTP_REQUESTS_PER_CALL);
            return refused(FailureCause::HttpLimit(limit));
        }
        let url = match queued.validate() {
            Ok(url) => url,
            Err(e) => return refused(FailureCause::HttpInvalid(e.to_string())),
        };
        let grant = module.grants.http();
        match grant.check(&url) {
            Ok(()) => {}
            Err(HttpDenial::NotGranted) => return refused(FailureCause::HttpNotGranted),
            Err(HttpDenial::HostNotAllowed { host }) => {
                return refused(FailureCause::HttpDenied { host })
            }
        }
        if self.http.count_for(scope, module.wiring) >= self.http.limit {
            let limit = HttpLimit::InFlight(self.http.limit);
            return refused(FailureCause::HttpLimit(limit));
        }
        if self.on_effect.is_none() {
            return refused(FailureCause::HttpUnavailable);
        }
        Ok(Admitted {
            url,
            grant: Arc::clone(grant),
            wiring: module.wiring,
        })
    }

    /// Record an admitted request as in flight and hand it to the embedder.
    fn start_http_request(&mut self, scope: &ScopeName, queued: QueuedHttpRequest, admitted: Admitted) {
        let QueuedHttpRequest { request, then, tag } = queued;
        let Admitted { url, grant, wiring } = admitted;
        let id = self.http.insert(Pending {
            scope: scope.clone(),
            wiring,
            then: then.clone(),
            tag: tag.clone(),
            grant: Arc::clone(&grant),
        });
        // `check_http_request` saw a handler, and nothing ran in between.
        let Some(handler) = &self.on_effect else {
            self.http.pending.remove(&id);
            return;
        };
        // The request (body included) moves into the effect: the embedder's
        // copy out of the `&Effect` is the only one made.
        handler(
            scope.as_str(),
            &Effect::Http(HttpEffect {
                id,
                request,
                url,
                grant,
                then,
                tag,
            }),
        );
    }

    /// Complete the request in flight under `id`: release its slot and run
    /// the module's `then` action with the outcome as a cascade root. See
    /// `Engine::complete_http_request`.
    pub(crate) fn complete_http(
        &mut self,
        ctx: &mut EngineCtx<'_>,
        id: HttpRequestId,
        outcome: HttpOutcome,
    ) -> Result<HttpDelivery, HttpCompletionError> {
        // Checked before the entry is consumed, so a refused call loses
        // nothing.
        self.reject_during_cascade("complete_http_request")
            .map_err(HttpCompletionError::Cascade)?;
        let Some(pending) = self.http.pending.remove(&id) else {
            return Err(HttpCompletionError::UnknownRequest(id));
        };
        let Pending {
            scope,
            wiring,
            then,
            tag,
            grant: _,
        } = pending;
        let live = self
            .registry
            .get(scope.as_str())
            .is_some_and(|module| module.wiring == wiring);
        if !live {
            crate::logger::log(
                crate::logger::LogLevel::Debug,
                crate::logger::LogScope::Engine,
                &format!(
                    "[{scope}] completion of http request {id} dropped: the module was \
                     destroyed or reloaded while it was in flight"
                ),
            );
            return Ok(HttpDelivery::ModuleGone);
        }
        let action = HostAction::new(then, outcome.into_payload(tag.as_deref()));
        self.run_cascade(ctx, scope, Call::Dispatch(action))
            .map(|()| HttpDelivery::Delivered)
            .map_err(HttpCompletionError::Cascade)
    }
}
