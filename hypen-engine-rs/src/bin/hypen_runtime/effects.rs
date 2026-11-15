//! Effects (`Navigate`, `Delay`, `Http`) the host has to perform.
//!
//! The engine cannot perform these itself — navigation needs a router, delay
//! needs a timer, a deferred HTTP request needs a client — so it hands each
//! `(scope, effect)` to a handler. The handler here just records them in an
//! [`EffectOutbox`]; after a dispatch the runtime drains the outbox into
//! [`HostEffects`], and the front end (server or REPL) decides what
//! performing them means: the server schedules delays on the timer thread,
//! puts HTTP requests on the worker pool and returns navigations in the
//! response; the REPL prints navigations and delays and performs HTTP
//! requests inline.

use std::sync::Mutex;
use std::time::Duration;

use hypen_engine::module_host::{Effect, HttpEffect};

use crate::sync::lock;
use crate::http::{HttpJob, HttpPoolHandle};
use crate::timers::{TimerFire, TimerHandle};

/// Effects recorded by the engine's effect handler, awaiting a drain.
#[derive(Default)]
pub struct EffectOutbox {
    pending: Mutex<Vec<(String, Effect)>>,
}

impl EffectOutbox {
    pub fn push(&self, scope: &str, effect: &Effect) {
        // The clone is the engine's hand-off of the effect (for `Http`, the
        // one copy of the request body made on its way to the client).
        lock(&self.pending, "effect outbox").push((scope.to_string(), effect.clone()));
    }

    /// Take everything recorded so far, sorted into what the host must do.
    pub fn drain(&self) -> HostEffects {
        let drained = std::mem::take(&mut *lock(&self.pending, "effect outbox"));
        HostEffects::from_effects(drained)
    }
}

/// A `Delay` effect: dispatch `action` back to `scope` after `delay`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DelayRequest {
    pub scope: String,
    pub action: String,
    pub delay: Duration,
}

/// What one dispatch asked the host to do.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HostEffects {
    /// Paths to navigate to, in emission order.
    pub navigations: Vec<String>,
    pub delays: Vec<DelayRequest>,
    /// Deferred HTTP requests to perform and then complete, with the scope
    /// that queued each.
    pub http: Vec<(String, HttpEffect)>,
}

impl HostEffects {
    fn from_effects(effects: Vec<(String, Effect)>) -> Self {
        let mut out = HostEffects::default();
        for (scope, effect) in effects {
            match effect {
                Effect::Navigate(path) => out.navigations.push(path),
                Effect::Delay { ms, then } => out.delays.push(DelayRequest {
                    scope,
                    action: then,
                    delay: Duration::from_millis(u64::from(ms)),
                }),
                Effect::Http(request) => out.http.push((scope, request)),
                // Handled engine-side; never reaches the outbox.
                Effect::Log { .. } => {}
            }
        }
        out
    }

    /// Put every delay on the timer thread. A delay refused by the per-module
    /// cap is logged and dropped; the rest are still scheduled.
    pub fn schedule_delays(&self, timers: &TimerHandle) {
        for d in &self.delays {
            let fire = TimerFire { scope: d.scope.clone(), action: d.action.clone() };
            if let Err(e) = timers.schedule(d.delay, fire) {
                eprintln!("[timers] {e}");
            }
        }
    }

    /// Put every HTTP request on the worker pool. Each one is completed
    /// through the pool's callback, whatever happens to it.
    pub fn start_http(&mut self, pool: &HttpPoolHandle) {
        for (scope, effect) in self.http.drain(..) {
            pool.submit(HttpJob { scope, effect });
        }
    }

    /// Perform everything a background dispatch (a fired timer, an HTTP
    /// completion) asked for; `source` names it in the log. Navigations have
    /// no response to ride on, so they are only logged.
    pub fn perform_in_background(mut self, timers: &TimerHandle, pool: &HttpPoolHandle, source: &str) {
        self.schedule_delays(timers);
        self.start_http(pool);
        for path in &self.navigations {
            eprintln!("{source} asked to navigate to {path}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hypen_engine::module_host::LogLevel;

    #[test]
    fn drain_sorts_effects_and_empties_the_outbox() {
        let outbox = EffectOutbox::default();
        outbox.push("app", &Effect::Navigate("/a".into()));
        outbox.push("counter", &Effect::Delay { ms: 250, then: "tick".into() });
        outbox.push("app", &Effect::Log { level: LogLevel::Info, message: "x".into() });
        outbox.push("app", &Effect::Navigate("/b".into()));

        let effects = outbox.drain();
        assert_eq!(effects.navigations, vec!["/a", "/b"]);
        assert_eq!(
            effects.delays,
            vec![DelayRequest {
                scope: "counter".into(),
                action: "tick".into(),
                delay: Duration::from_millis(250),
            }]
        );
        assert_eq!(outbox.drain(), HostEffects::default(), "drained once");
    }
}
