//! Session state-machine decisions.
//!
//! Each host SDK owns a `SessionManager` that holds native connection
//! handles and timers. This module owns the two pure decisions those
//! managers make on every event: what to do with a new connection
//! given the configured concurrent-connection policy, and whether a
//! suspended session's TTL has elapsed. Transport and bookkeeping stay
//! in the host; the decision lives here.

use serde::{Deserialize, Serialize};

/// How a new connection to an existing session should be handled.
///
/// Matches the `ConcurrentPolicy` / `ConcurrentKickOld` / `.kickOld`
/// enums in the Go, Swift, Kotlin, Rust SDKs and TypeScript core.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SessionPolicy {
    /// Newest connection wins; kick all older ones. (Default.)
    KickOld,
    /// Reject the new connection if any existing one is still attached.
    RejectNew,
    /// Allow unlimited concurrent connections for a single session.
    AllowMultiple,
}

impl Default for SessionPolicy {
    fn default() -> Self {
        SessionPolicy::KickOld
    }
}

/// Input event for [`session_step`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SessionEvent {
    /// A new connection attempt arrived. `existing_connection_count` is
    /// the number of connections currently attached to the session.
    Connect { existing_connection_count: u32 },
    /// The TTL timer fired for a suspended session. `suspended_at_ms`
    /// is when the session was suspended, `now_ms` is the current
    /// wall-clock time, and `ttl_ms` is the configured TTL.
    TtlTick {
        suspended_at_ms: u64,
        now_ms: u64,
        ttl_ms: u64,
    },
}

/// Minimal state carried across `session_step` calls. Currently only
/// holds the policy; kept as a struct so hosts can round-trip it
/// through JSON without caring about the enum representation.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SessionState {
    pub policy: SessionPolicy,
}

/// Effect the host must apply as a result of a [`session_step`] call.
///
/// The decision is pure; the effect describes what the *host* should do
/// with its native connection handles and timers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SessionEffect {
    /// Accept the new connection.
    AcceptConnection,
    /// Accept the new connection and kick every existing one attached
    /// to the same session.
    AcceptAndKickExisting,
    /// Reject the new connection; an existing one already holds the
    /// session under a `RejectNew` policy.
    RejectConnection,
    /// The suspended session's TTL has elapsed — the host should
    /// drop the pending entry and fire its `on_expire` callback.
    ExpireSession,
    /// TTL has not yet elapsed; the host can rearm or ignore.
    RetainSession,
}

/// Decide what to do in response to a session event.
///
/// Always returns exactly one effect; hosts apply it to their native
/// state. No I/O is performed here — the host owns timers, sockets,
/// and connection maps.
pub fn session_step(state: &SessionState, event: &SessionEvent) -> SessionEffect {
    match event {
        SessionEvent::Connect {
            existing_connection_count,
        } => match state.policy {
            SessionPolicy::AllowMultiple => SessionEffect::AcceptConnection,
            SessionPolicy::RejectNew => {
                if *existing_connection_count > 0 {
                    SessionEffect::RejectConnection
                } else {
                    SessionEffect::AcceptConnection
                }
            }
            SessionPolicy::KickOld => {
                if *existing_connection_count > 0 {
                    SessionEffect::AcceptAndKickExisting
                } else {
                    SessionEffect::AcceptConnection
                }
            }
        },
        SessionEvent::TtlTick {
            suspended_at_ms,
            now_ms,
            ttl_ms,
        } => {
            // saturating_sub handles clock skew and overflow.
            let elapsed = now_ms.saturating_sub(*suspended_at_ms);
            if elapsed >= *ttl_ms {
                SessionEffect::ExpireSession
            } else {
                SessionEffect::RetainSession
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kick_old_on_first_connection_accepts() {
        let s = SessionState {
            policy: SessionPolicy::KickOld,
        };
        let e = SessionEvent::Connect {
            existing_connection_count: 0,
        };
        assert_eq!(session_step(&s, &e), SessionEffect::AcceptConnection);
    }

    #[test]
    fn kick_old_on_second_connection_kicks() {
        let s = SessionState {
            policy: SessionPolicy::KickOld,
        };
        let e = SessionEvent::Connect {
            existing_connection_count: 1,
        };
        assert_eq!(session_step(&s, &e), SessionEffect::AcceptAndKickExisting);
    }

    #[test]
    fn reject_new_rejects_when_occupied() {
        let s = SessionState {
            policy: SessionPolicy::RejectNew,
        };
        assert_eq!(
            session_step(
                &s,
                &SessionEvent::Connect {
                    existing_connection_count: 1
                }
            ),
            SessionEffect::RejectConnection
        );
        assert_eq!(
            session_step(
                &s,
                &SessionEvent::Connect {
                    existing_connection_count: 0
                }
            ),
            SessionEffect::AcceptConnection
        );
    }

    #[test]
    fn allow_multiple_always_accepts() {
        let s = SessionState {
            policy: SessionPolicy::AllowMultiple,
        };
        for n in [0, 1, 2, 10, 100] {
            assert_eq!(
                session_step(
                    &s,
                    &SessionEvent::Connect {
                        existing_connection_count: n
                    }
                ),
                SessionEffect::AcceptConnection
            );
        }
    }

    #[test]
    fn ttl_not_yet_elapsed_retains() {
        let s = SessionState::default();
        let e = SessionEvent::TtlTick {
            suspended_at_ms: 1_000,
            now_ms: 1_500,
            ttl_ms: 1_000,
        };
        assert_eq!(session_step(&s, &e), SessionEffect::RetainSession);
    }

    #[test]
    fn ttl_elapsed_expires() {
        let s = SessionState::default();
        let e = SessionEvent::TtlTick {
            suspended_at_ms: 1_000,
            now_ms: 2_001,
            ttl_ms: 1_000,
        };
        assert_eq!(session_step(&s, &e), SessionEffect::ExpireSession);
    }

    #[test]
    fn ttl_clock_skew_does_not_underflow() {
        // If now_ms < suspended_at_ms (clock went backwards), saturating
        // subtraction clamps to zero and we retain.
        let s = SessionState::default();
        let e = SessionEvent::TtlTick {
            suspended_at_ms: 2_000,
            now_ms: 1_000,
            ttl_ms: 1_000,
        };
        assert_eq!(session_step(&s, &e), SessionEffect::RetainSession);
    }

    #[test]
    fn json_roundtrip_for_cross_host_transport() {
        // Hosts serialise state+event through JSON. Round-tripping must
        // preserve meaning so the WASM/UniFFI bindings can use the same
        // string-in/string-out surface.
        let state = SessionState {
            policy: SessionPolicy::KickOld,
        };
        let event = SessionEvent::Connect {
            existing_connection_count: 2,
        };
        let state_s = serde_json::to_string(&state).unwrap();
        let event_s = serde_json::to_string(&event).unwrap();

        let state2: SessionState = serde_json::from_str(&state_s).unwrap();
        let event2: SessionEvent = serde_json::from_str(&event_s).unwrap();
        assert_eq!(
            session_step(&state2, &event2),
            SessionEffect::AcceptAndKickExisting
        );
    }
}
