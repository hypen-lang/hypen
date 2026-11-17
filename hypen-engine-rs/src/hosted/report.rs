//! What went wrong in a cascade, as data.
//!
//! Every refusal and failure met while draining a cascade is recorded as a
//! [`CascadeFailure`] — which module, which action, *why it was going to run*
//! ([`Origin`]) and *why it did not* ([`FailureCause`]) — and collected in a
//! [`CascadeReport`]. The public `Engine` API still returns the stable
//! `EngineError` variants; the report is rendered into the message there
//! ([`CascadeReport::to_engine_error`]) and stays available, structured,
//! through `Engine::last_module_cascade_report`.

use super::names::ScopeName;
use crate::error::EngineError;
use crate::module_host::HostError;
use std::fmt;
use std::sync::Arc;

/// Failures kept in full per cascade; [`CascadeReport::failure_count`] is
/// always exact.
pub const MAX_REPORTED_FAILURES: usize = 8;

/// A lifecycle export the engine drives and folds like a dispatch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifecycleHook {
    Activated,
    Deactivated,
}

impl LifecycleHook {
    /// The pseudo action name the hook is reported under.
    pub fn label(self) -> &'static str {
        match self {
            LifecycleHook::Activated => "<on_activated>",
            LifecycleHook::Deactivated => "<on_deactivated>",
        }
    }
}

/// Why an action was going to run in a module.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Origin {
    /// The top-level action the embedder or renderer dispatched.
    Root,
    /// The top-level lifecycle call (`activate_module` / `deactivate_module`).
    Lifecycle(LifecycleHook),
    /// The module emitted it to itself.
    Emit,
    /// Module `from` dispatched it across modules. `addressed_as` is the
    /// name `from` used for the target when an alias translated it (the
    /// failure's `scope` is then the scope the alias stands for).
    CrossDispatch {
        from: ScopeName,
        addressed_as: Option<Arc<str>>,
    },
    /// The module subscribed to `target` at `path`, and that state changed
    /// (written by a reducer, or by the host — see [`CascadeRoot::HostWrite`]).
    SubscriptionChange { target: Arc<str>, path: Arc<str> },
    /// Not a run at all: the module asked to subscribe to `target` at `path`
    /// with this action as `on_change`, and the request itself was refused.
    /// `target` is the name the module used; `scope` the scope an alias
    /// makes it stand for, when there is one.
    SubscribeRequest {
        target: String,
        path: String,
        scope: Option<Arc<str>>,
    },
    /// Not a run at all: the module queued this deferred HTTP request
    /// (`hypen:http/deferred.send`) with the failure's action as `then`, and
    /// the request was refused. `url` is shortened for display.
    HttpRequest { method: String, url: String },
    /// The completion (`ok: false`, `denied`) of a deferred HTTP request that
    /// was refused in this same cascade.
    HttpRefusal,
}

impl Origin {
    /// [`Origin::HttpRequest`] for a guest-supplied method and URL, both
    /// bounded and made printable (they are untrusted and may be huge).
    pub(crate) fn http_request(method: &str, url: &str) -> Self {
        fn shown(s: &str, max: usize) -> String {
            let mut out: String = s.chars().take(max).flat_map(char::escape_default).collect();
            if s.chars().nth(max).is_some() {
                out.push('…');
            }
            out
        }
        Origin::HttpRequest {
            method: shown(method, 16),
            url: shown(url, 128),
        }
    }
}

/// Which deferred-HTTP cap a request ran into.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HttpLimit {
    /// More requests in one reducer call than `MAX_HTTP_REQUESTS_PER_CALL`.
    PerCall(usize),
    /// The module already has this many requests in flight
    /// (`Engine::module_http_in_flight_limit`).
    InFlight(usize),
}

/// What started a cascade.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CascadeRoot {
    Dispatch {
        scope: ScopeName,
        action: String,
    },
    Lifecycle {
        scope: ScopeName,
        hook: LifecycleHook,
    },
    /// The host wrote `scope`'s state (`update_state*`) and its subscribers
    /// were notified.
    HostWrite {
        scope: String,
    },
}

impl CascadeRoot {
    /// The action the root is reported under: the dispatched name, a
    /// lifecycle hook's [`label`](LifecycleHook::label), or
    /// `<host state update>`.
    pub fn action_label(&self) -> &str {
        match self {
            CascadeRoot::Dispatch { action, .. } => action,
            CascadeRoot::Lifecycle { hook, .. } => hook.label(),
            CascadeRoot::HostWrite { .. } => "<host state update>",
        }
    }

    /// The scope the root call addressed (or the host wrote).
    pub fn scope(&self) -> &str {
        match self {
            CascadeRoot::Dispatch { scope, .. } | CascadeRoot::Lifecycle { scope, .. } => {
                scope.as_str()
            }
            CascadeRoot::HostWrite { scope } => scope,
        }
    }
}

impl fmt::Display for CascadeRoot {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{}] {}", self.scope(), self.action_label())
    }
}

/// Why a reducer's returned state cannot become the scope's state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InvalidState {
    /// The bytes are not JSON (carries the decoder's message).
    NotJson(String),
    /// Valid JSON, but module state must be an object.
    NotAnObject,
}

impl fmt::Display for InvalidState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            InvalidState::NotJson(e) => write!(f, "invalid state: {e}"),
            InvalidState::NotAnObject => f.write_str("module state must be a JSON object"),
        }
    }
}

/// Why an action did not run, or a subscription was not registered.
#[derive(Debug)]
pub enum FailureCause {
    /// No hosted module is wired under the addressed scope (and, for a
    /// cross-module dispatch, no in-process module is registered there).
    UnknownModule,
    /// The addressed module does not accept that action name (a hosted
    /// module's action set, or — for a cross-module dispatch to an in-process
    /// scope — no handler registered for it).
    NotAccepted,
    /// A cross-module dispatch without the sender's `dispatches` grant.
    /// `missing_grant` is the scope to add to the sender's `dispatches` list.
    DispatchDenied { missing_grant: String },
    /// A subscription without the subscriber's `reads` grant. `missing_grant`
    /// is the scope to add to the subscriber's `reads` list.
    ReadDenied { missing_grant: String },
    /// The subscriber already holds the per-module maximum.
    SubscriptionLimit { limit: usize },
    /// The follow-up's payload is neither empty nor JSON; it was not delivered.
    PayloadNotJson(String),
    /// The follow-up would exceed the cascade depth cap.
    DepthExceeded { limit: u32 },
    /// The cascade's reducer-invocation budget ran out; `dropped` pending
    /// actions (this one first) never ran.
    BudgetExhausted { budget: usize, dropped: usize },
    /// The module host failed the call (trap, dead instance, module error, …).
    Host(HostError),
    /// The in-process handler a cross-module dispatch was delivered to did
    /// not complete (carries what it reported).
    Handler(String),
    /// No module host is installed on the engine.
    NoHost,
    /// The scope has no state slot in the engine.
    NoStateSlot,
    /// The scope's state could not be encoded for the call.
    StateEncoding(String),
    /// The reducer returned unusable state; nothing of its output was applied.
    InvalidState(InvalidState),
    /// A deferred HTTP request from a module whose grants do not include
    /// `http`.
    HttpNotGranted,
    /// A deferred HTTP request to a host outside the module's `httpHosts`
    /// allowlist. `host` is `host:port`.
    HttpDenied { host: String },
    /// A deferred HTTP request that is malformed or over a size bound
    /// (carries which part and why).
    HttpInvalid(String),
    /// A deferred HTTP request over a count cap.
    HttpLimit(HttpLimit),
    /// A deferred HTTP request on an engine whose embedder installed no
    /// effect handler: nothing can perform it.
    HttpUnavailable,
}

impl FailureCause {
    /// `refused` (a policy said no), `dropped` (a cap was hit) or `failed`
    /// (it ran, or tried to, and broke).
    fn verb(&self) -> &'static str {
        match self {
            FailureCause::UnknownModule
            | FailureCause::NotAccepted
            | FailureCause::DispatchDenied { .. }
            | FailureCause::ReadDenied { .. }
            | FailureCause::SubscriptionLimit { .. }
            | FailureCause::PayloadNotJson(_)
            | FailureCause::HttpNotGranted
            | FailureCause::HttpDenied { .. }
            | FailureCause::HttpInvalid(_)
            | FailureCause::HttpUnavailable => "refused",
            FailureCause::DepthExceeded { .. }
            | FailureCause::BudgetExhausted { .. }
            | FailureCause::HttpLimit(_) => "dropped",
            FailureCause::Host(_)
            | FailureCause::Handler(_)
            | FailureCause::NoHost
            | FailureCause::NoStateSlot
            | FailureCause::StateEncoding(_)
            | FailureCause::InvalidState(_) => "failed",
        }
    }

    /// The `error.message` a module is given when its deferred HTTP request
    /// is refused for this cause.
    pub(crate) fn http_refusal_message(&self) -> String {
        match self {
            FailureCause::HttpNotGranted => "the module's manifest does not grant `http`".into(),
            FailureCause::HttpDenied { host } => {
                format!("host '{host}' is not in the manifest's `httpHosts` allowlist")
            }
            FailureCause::HttpInvalid(why) => why.clone(),
            FailureCause::HttpLimit(HttpLimit::PerCall(limit)) => {
                format!("too many requests in one call (limit {limit})")
            }
            FailureCause::HttpLimit(HttpLimit::InFlight(limit)) => {
                format!("too many requests in flight (limit {limit}); wait for one to complete")
            }
            FailureCause::HttpUnavailable => {
                "this host does not perform HTTP requests (no effect handler installed)".into()
            }
            other => format!("refused ({})", other.code()),
        }
    }
}

/// One refusal or failure met during a cascade.
#[derive(Debug)]
pub struct CascadeFailure {
    /// The module the action was addressed to (for a refused subscription:
    /// the subscriber). Canonical spelling; may name no hosted module.
    pub scope: String,
    /// The action name (for a refused subscription: its `on_change`; for a
    /// lifecycle call: [`LifecycleHook::label`]).
    pub action: String,
    pub origin: Origin,
    pub cause: FailureCause,
}

impl CascadeFailure {
    /// Whether this is the failure of the cascade's root call (in which case
    /// nothing was applied and it is the report's only failure).
    pub fn is_root(&self) -> bool {
        matches!(self.origin, Origin::Root | Origin::Lifecycle(_))
    }

    fn write_cause(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let Self {
            scope,
            action,
            origin,
            cause,
        } = self;
        match cause {
            FailureCause::UnknownModule => write!(f, "no hosted module under scope '{scope}'"),
            FailureCause::NotAccepted => match origin {
                Origin::SubscribeRequest { .. } => {
                    write!(f, "on_change '{action}' is not an action of '{scope}'")
                }
                Origin::HttpRequest { .. } => {
                    write!(f, "`then` '{action}' is not an action of '{scope}'")
                }
                _ => write!(f, "module '{scope}' does not accept that action"),
            },
            FailureCause::DispatchDenied { missing_grant } => {
                let sender = match origin {
                    Origin::CrossDispatch { from, .. } => from.as_str(),
                    _ => "the sender",
                };
                write!(
                    f,
                    "'{sender}' has no `dispatches` grant on '{missing_grant}' — add \
                     \"{missing_grant}\" to `dispatches` in the manifest of '{sender}'"
                )
            }
            FailureCause::ReadDenied { missing_grant } => write!(
                f,
                "no `reads` grant on '{missing_grant}' — add \"{missing_grant}\" to `reads` in \
                 the manifest of '{scope}'"
            ),
            FailureCause::SubscriptionLimit { limit } => {
                write!(f, "subscription limit ({limit}) reached")
            }
            FailureCause::PayloadNotJson(e) => write!(f, "payload is not JSON ({e})"),
            FailureCause::DepthExceeded { limit } => {
                write!(f, "cascade depth cap ({limit}) reached")
            }
            FailureCause::BudgetExhausted { budget, dropped } => write!(
                f,
                "reducer-invocation budget ({budget}) exhausted; dropped {dropped} pending \
                 action(s), this one first"
            ),
            FailureCause::Host(e) => write!(f, "{e}"),
            FailureCause::Handler(e) => write!(f, "the in-process handler failed: {e}"),
            FailureCause::NoHost => f.write_str("no module host installed"),
            FailureCause::NoStateSlot => f.write_str("module has no state slot"),
            FailureCause::StateEncoding(e) => write!(f, "module state could not be encoded: {e}"),
            FailureCause::InvalidState(reason) => write!(f, "{reason}"),
            FailureCause::HttpNotGranted => write!(
                f,
                "'{scope}' has no `http` grant — set `http: true` in the manifest of '{scope}'"
            ),
            FailureCause::HttpDenied { host } => write!(
                f,
                "host '{host}' is not in the `httpHosts` allowlist of '{scope}' — add it to \
                 `httpHosts` in the manifest of '{scope}'"
            ),
            FailureCause::HttpInvalid(why) => write!(f, "{why}"),
            FailureCause::HttpLimit(_) | FailureCause::HttpUnavailable => {
                f.write_str(&cause.http_refusal_message())
            }
        }
    }
}

/// `[module] 'action' refused|dropped|failed: why (why it was going to run)`.
impl fmt::Display for CascadeFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let Self {
            scope,
            action,
            origin,
            cause,
        } = self;
        let verb = cause.verb();
        if let Origin::SubscribeRequest {
            target,
            path,
            scope: aliased,
        } = origin
        {
            write!(f, "[{scope}] subscribe to '{target}'")?;
            if let Some(aliased) = aliased {
                write!(f, " (the scope '{aliased}')")?;
            }
            if !path.is_empty() {
                write!(f, " at '{path}'")?;
            }
            write!(f, " {verb}: ")?;
            return self.write_cause(f);
        }
        if let Origin::HttpRequest { method, url } = origin {
            write!(f, "[{scope}] http request {method} {url} {verb}: ")?;
            return self.write_cause(f);
        }
        write!(f, "[{scope}] '{action}' {verb}: ")?;
        self.write_cause(f)?;
        match origin {
            // The root is named by the report's header.
            Origin::Root
            | Origin::Lifecycle(_)
            | Origin::SubscribeRequest { .. }
            | Origin::HttpRequest { .. } => Ok(()),
            Origin::HttpRefusal => write!(f, " (completion of a refused http request)"),
            Origin::Emit => write!(f, " (emitted by '{scope}')"),
            Origin::CrossDispatch {
                from,
                addressed_as: None,
            } => write!(f, " (dispatched by '{from}')"),
            Origin::CrossDispatch {
                from,
                addressed_as: Some(name),
            } => write!(f, " (dispatched by '{from}', which calls it '{name}')"),
            Origin::SubscriptionChange { target, path } if path.is_empty() => {
                write!(f, " (notification: '{target}' changed)")
            }
            Origin::SubscriptionChange { target, path } => {
                write!(f, " (notification: '{target}' changed at '{path}')")
            }
        }
    }
}

/// The failures of one cascade. Only produced when there is at least one.
#[derive(Debug)]
pub struct CascadeReport {
    root: CascadeRoot,
    failures: Vec<CascadeFailure>,
    failure_count: usize,
}

impl CascadeReport {
    pub(crate) fn new(root: CascadeRoot) -> Self {
        Self {
            root,
            failures: Vec::new(),
            failure_count: 0,
        }
    }

    pub(crate) fn record(&mut self, failure: CascadeFailure) {
        self.failure_count += 1;
        if self.failures.len() < MAX_REPORTED_FAILURES {
            self.failures.push(failure);
        }
    }

    /// What started the cascade.
    pub fn root(&self) -> &CascadeRoot {
        &self.root
    }

    /// The first [`MAX_REPORTED_FAILURES`] failures, in the order they
    /// happened.
    pub fn failures(&self) -> &[CascadeFailure] {
        &self.failures
    }

    /// How many failures there were in total (may exceed
    /// `failures().len()`).
    pub fn failure_count(&self) -> usize {
        self.failure_count
    }

    pub fn is_clean(&self) -> bool {
        self.failure_count == 0
    }

    /// The root call's own failure, if that is what this report records.
    pub fn root_failure(&self) -> Option<&CascadeFailure> {
        self.failures.first().filter(|failure| failure.is_root())
    }

    /// Render for the public API, keeping the `EngineError` variant each
    /// situation always had: a root failure is the caller's error
    /// (`StateError` for unusable state, `ModuleError` otherwise); follow-up
    /// failures are summarized as one `ModuleError`.
    pub fn to_engine_error(&self) -> EngineError {
        match self.root_failure() {
            Some(failure) => match failure.cause {
                FailureCause::NoStateSlot
                | FailureCause::StateEncoding(_)
                | FailureCause::InvalidState(_) => EngineError::StateError(failure.to_string()),
                _ => EngineError::ModuleError(failure.to_string()),
            },
            None => EngineError::ModuleError(self.to_string()),
        }
    }
}

// ── as data for a binding ────────────────────────────────────────────────────
//
// The same report as plain JSON, for surfaces that cannot hand out Rust types
// (the JS binding's `lastModuleCascadeReport`). Field names are camelCase and
// every `code` / `kind` string is stable API: add, never rename.

impl LifecycleHook {
    fn code(self) -> &'static str {
        match self {
            LifecycleHook::Activated => "activated",
            LifecycleHook::Deactivated => "deactivated",
        }
    }
}

impl Origin {
    /// `{ kind, ... }`: `root`, `lifecycle` (`hook`), `emit`, `crossDispatch`
    /// (`from`, and `addressedAs` when an alias translated the target),
    /// `subscriptionChange` / `subscribeRequest` (`target`, `path`; the
    /// latter also `scope` when `target` is an alias),
    /// `httpRequest` (`method`, `url`), `httpRefusal`.
    pub fn to_json(&self) -> serde_json::Value {
        use serde_json::json;
        match self {
            Origin::Root => json!({ "kind": "root" }),
            Origin::Lifecycle(hook) => json!({ "kind": "lifecycle", "hook": hook.code() }),
            Origin::Emit => json!({ "kind": "emit" }),
            Origin::CrossDispatch { from, addressed_as } => {
                let mut origin = json!({ "kind": "crossDispatch", "from": from.as_str() });
                if let Some(name) = addressed_as {
                    origin["addressedAs"] = json!(&**name);
                }
                origin
            }
            Origin::SubscriptionChange { target, path } => {
                json!({ "kind": "subscriptionChange", "target": &**target, "path": &**path })
            }
            Origin::SubscribeRequest {
                target,
                path,
                scope,
            } => {
                let mut origin =
                    json!({ "kind": "subscribeRequest", "target": target, "path": path });
                if let Some(scope) = scope {
                    origin["scope"] = json!(&**scope);
                }
                origin
            }
            Origin::HttpRequest { method, url } => {
                json!({ "kind": "httpRequest", "method": method, "url": url })
            }
            Origin::HttpRefusal => json!({ "kind": "httpRefusal" }),
        }
    }
}

impl HostError {
    /// A stable code for the variant.
    pub fn code(&self) -> &'static str {
        match self {
            HostError::UnknownModule(_) => "unknownModule",
            HostError::DeadInstance => "deadInstance",
            HostError::ModuleError(_) => "moduleError",
            HostError::Trap(_) => "trap",
            HostError::Instantiate(_) => "instantiate",
            HostError::Codec(_) => "codec",
            HostError::Runtime(_) => "runtime",
        }
    }
}

impl FailureCause {
    /// A stable code for the variant.
    pub fn code(&self) -> &'static str {
        match self {
            FailureCause::UnknownModule => "unknownModule",
            FailureCause::NotAccepted => "notAccepted",
            FailureCause::DispatchDenied { .. } => "dispatchDenied",
            FailureCause::ReadDenied { .. } => "readDenied",
            FailureCause::SubscriptionLimit { .. } => "subscriptionLimit",
            FailureCause::PayloadNotJson(_) => "payloadNotJson",
            FailureCause::DepthExceeded { .. } => "depthExceeded",
            FailureCause::BudgetExhausted { .. } => "budgetExhausted",
            FailureCause::Host(_) => "host",
            FailureCause::Handler(_) => "handler",
            FailureCause::NoHost => "noHost",
            FailureCause::NoStateSlot => "noStateSlot",
            FailureCause::StateEncoding(_) => "stateEncoding",
            FailureCause::InvalidState(_) => "invalidState",
            FailureCause::HttpNotGranted => "httpNotGranted",
            FailureCause::HttpDenied { .. } => "httpDenied",
            FailureCause::HttpInvalid(_) => "httpInvalid",
            FailureCause::HttpLimit(_) => "httpLimit",
            FailureCause::HttpUnavailable => "httpUnavailable",
        }
    }

    /// `{ code, ... }` with the variant's data: `missingGrant` and `grant`
    /// (`"dispatches"` / `"reads"`) for the two denials, `limit`, `budget` +
    /// `dropped`, `detail` (a decoder / handler message), `host`
    /// (`{ code, message }`), `reason` (`notJson` / `notAnObject`); for the
    /// deferred-HTTP refusals `grant` (`"http"` / `"httpHosts"`) with, for
    /// `httpDenied`, the refused `host` (`host:port`), and for `httpLimit`
    /// `limit` + `per` (`"call"` / `"module"`).
    pub fn to_json(&self) -> serde_json::Value {
        use serde_json::json;
        let code = self.code();
        match self {
            FailureCause::UnknownModule
            | FailureCause::NotAccepted
            | FailureCause::NoHost
            | FailureCause::NoStateSlot
            | FailureCause::HttpUnavailable => json!({ "code": code }),
            FailureCause::HttpNotGranted => json!({ "code": code, "grant": "http" }),
            FailureCause::HttpDenied { host } => {
                json!({ "code": code, "grant": "httpHosts", "host": host })
            }
            FailureCause::HttpLimit(HttpLimit::PerCall(limit)) => {
                json!({ "code": code, "limit": limit, "per": "call" })
            }
            FailureCause::HttpLimit(HttpLimit::InFlight(limit)) => {
                json!({ "code": code, "limit": limit, "per": "module" })
            }
            FailureCause::DispatchDenied { missing_grant } => {
                json!({ "code": code, "grant": "dispatches", "missingGrant": missing_grant })
            }
            FailureCause::ReadDenied { missing_grant } => {
                json!({ "code": code, "grant": "reads", "missingGrant": missing_grant })
            }
            FailureCause::SubscriptionLimit { limit } => json!({ "code": code, "limit": limit }),
            FailureCause::DepthExceeded { limit } => json!({ "code": code, "limit": limit }),
            FailureCause::BudgetExhausted { budget, dropped } => {
                json!({ "code": code, "budget": budget, "dropped": dropped })
            }
            FailureCause::PayloadNotJson(detail)
            | FailureCause::Handler(detail)
            | FailureCause::HttpInvalid(detail)
            | FailureCause::StateEncoding(detail) => json!({ "code": code, "detail": detail }),
            FailureCause::Host(e) => json!({
                "code": code,
                "host": { "code": e.code(), "message": e.to_string() },
            }),
            FailureCause::InvalidState(InvalidState::NotJson(detail)) => {
                json!({ "code": code, "reason": "notJson", "detail": detail })
            }
            FailureCause::InvalidState(InvalidState::NotAnObject) => {
                json!({ "code": code, "reason": "notAnObject" })
            }
        }
    }
}

impl CascadeFailure {
    /// `{ scope, action, outcome, isRoot, origin, cause, message }` —
    /// `outcome` is `refused` / `dropped` / `failed`, `message` the rendered
    /// line.
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "scope": self.scope,
            "action": self.action,
            "outcome": self.cause.verb(),
            "isRoot": self.is_root(),
            "origin": self.origin.to_json(),
            "cause": self.cause.to_json(),
            "message": self.to_string(),
        })
    }
}

impl CascadeRoot {
    /// `{ kind, scope, action }` — `kind` is `dispatch`, `lifecycle` (plus
    /// `hook`) or `hostWrite`; `action` is the [`action_label`](Self::action_label).
    pub fn to_json(&self) -> serde_json::Value {
        let mut root = serde_json::json!({
            "kind": match self {
                CascadeRoot::Dispatch { .. } => "dispatch",
                CascadeRoot::Lifecycle { .. } => "lifecycle",
                CascadeRoot::HostWrite { .. } => "hostWrite",
            },
            "scope": self.scope(),
            "action": self.action_label(),
        });
        if let CascadeRoot::Lifecycle { hook, .. } = self {
            root["hook"] = hook.code().into();
        }
        root
    }
}

impl CascadeReport {
    /// `{ root, rootFailed, failureCount, failures, message }`. `failures`
    /// holds at most [`MAX_REPORTED_FAILURES`] entries, `failureCount` is
    /// exact; `rootFailed` means the root call itself failed and nothing was
    /// applied; `message` is what the `EngineError` of the call carried.
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "root": self.root.to_json(),
            "rootFailed": self.root_failure().is_some(),
            "failureCount": self.failure_count,
            "failures": self.failures.iter().map(CascadeFailure::to_json).collect::<Vec<_>>(),
            "message": self.to_engine_error().to_string(),
        })
    }
}

/// A header naming the root, then one line per failure.
impl fmt::Display for CascadeReport {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "module cascade from {} finished with {} failure(s):",
            self.root, self.failure_count
        )?;
        for failure in &self.failures {
            write!(f, "\n  - {failure}")?;
        }
        let unlisted = self.failure_count - self.failures.len();
        if unlisted > 0 {
            write!(f, "\n  - ... and {unlisted} more")?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope(name: &str) -> ScopeName {
        ScopeName::parse(name).unwrap()
    }

    fn failure(scope: &str, action: &str, origin: Origin, cause: FailureCause) -> CascadeFailure {
        CascadeFailure {
            scope: scope.into(),
            action: action.into(),
            origin,
            cause,
        }
    }

    fn dispatch_root() -> CascadeRoot {
        CascadeRoot::Dispatch {
            scope: scope("cart"),
            action: "checkout".into(),
        }
    }

    #[test]
    fn an_acl_refusal_names_the_grant_to_add() {
        let denied = failure(
            "payments",
            "charge",
            Origin::CrossDispatch {
                from: scope("cart"),
                addressed_as: None,
            },
            FailureCause::DispatchDenied {
                missing_grant: "payments".into(),
            },
        );
        assert_eq!(
            denied.to_string(),
            "[payments] 'charge' refused: 'cart' has no `dispatches` grant on 'payments' — add \
             \"payments\" to `dispatches` in the manifest of 'cart' (dispatched by 'cart')"
        );
        let unread = failure(
            "cart",
            "priceChanged",
            Origin::SubscribeRequest {
                target: "catalog".into(),
                path: "prices".into(),
                scope: None,
            },
            FailureCause::ReadDenied {
                missing_grant: "catalog".into(),
            },
        );
        assert_eq!(
            unread.to_string(),
            "[cart] subscribe to 'catalog' at 'prices' refused: no `reads` grant on 'catalog' — \
             add \"catalog\" to `reads` in the manifest of 'cart'"
        );
    }

    #[test]
    fn a_report_lists_each_failure_on_its_own_line_and_counts_the_unlisted() {
        let mut report = CascadeReport::new(dispatch_root());
        assert!(report.is_clean());
        report.record(failure(
            "cart",
            "recount",
            Origin::Emit,
            FailureCause::BudgetExhausted {
                budget: 1024,
                dropped: 3,
            },
        ));
        report.record(failure(
            "audit",
            "cartChanged",
            Origin::SubscriptionChange {
                target: "cart".into(),
                path: "items".into(),
            },
            FailureCause::Host(HostError::Trap("unreachable".into())),
        ));
        for _ in 0..MAX_REPORTED_FAILURES {
            report.record(failure(
                "cart",
                "x",
                Origin::Emit,
                FailureCause::NotAccepted,
            ));
        }
        assert_eq!(report.failure_count(), MAX_REPORTED_FAILURES + 2);
        assert_eq!(report.failures().len(), MAX_REPORTED_FAILURES);
        assert!(report.root_failure().is_none());

        let EngineError::ModuleError(message) = report.to_engine_error() else {
            panic!("follow-up failures are a ModuleError");
        };
        let lines: Vec<&str> = message.lines().collect();
        assert_eq!(
            &lines[..3],
            [
                "module cascade from [cart] checkout finished with 10 failure(s):",
                "  - [cart] 'recount' dropped: reducer-invocation budget (1024) exhausted; \
                 dropped 3 pending action(s), this one first (emitted by 'cart')",
                "  - [audit] 'cartChanged' failed: module trapped: unreachable (notification: \
                 'cart' changed at 'items')",
            ]
        );
        assert_eq!(lines.len(), 1 + MAX_REPORTED_FAILURES + 1);
        assert_eq!(lines[lines.len() - 1], "  - ... and 2 more");
    }

    #[test]
    fn a_root_failure_keeps_its_engine_error_variant() {
        let mut trapped = CascadeReport::new(dispatch_root());
        trapped.record(failure(
            "cart",
            "checkout",
            Origin::Root,
            FailureCause::Host(HostError::DeadInstance),
        ));
        assert_eq!(
            trapped.to_engine_error(),
            EngineError::ModuleError("[cart] 'checkout' failed: module instance is dead".into())
        );

        let mut bad_state = CascadeReport::new(CascadeRoot::Lifecycle {
            scope: scope("cart"),
            hook: LifecycleHook::Activated,
        });
        bad_state.record(failure(
            "cart",
            LifecycleHook::Activated.label(),
            Origin::Lifecycle(LifecycleHook::Activated),
            FailureCause::InvalidState(InvalidState::NotAnObject),
        ));
        assert_eq!(
            bad_state.to_engine_error(),
            EngineError::StateError(
                "[cart] '<on_activated>' failed: module state must be a JSON object".into()
            )
        );
    }
}
