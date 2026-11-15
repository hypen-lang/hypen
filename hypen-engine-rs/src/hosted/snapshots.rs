//! The encoded-state cache: each scope's state as JSON bytes, re-encoded only
//! when the state actually changed.
//!
//! A module call needs the module's own state and its readable siblings' as
//! JSON bytes. Encoding them on every dispatch would cost O(state) per call,
//! so the bytes are cached per scope and *lent* to the call: [`checkout`]
//! moves the buffer out (no copy), the host borrows it, [`checkin`] moves it
//! back.
//!
//! Staleness needs no invalidation hook. An entry holds a `Weak` to the state
//! `Arc` it was encoded from, and every state write goes through
//! `Arc::make_mut` (which must move to a fresh allocation while a `Weak`
//! exists) or installs a new `Arc`. So "same allocation" is exactly "unchanged
//! since encoding", whichever engine API did the write — and a live `Weak`
//! pins the old allocation, so its address is never reused.
//!
//! [`checkout`]: EncodedStates::checkout
//! [`checkin`]: EncodedStates::checkin

use crate::engine_core::EngineCore;
use std::collections::HashMap;
use std::sync::{Arc, Weak};

/// Cached JSON encoding of a scope's state, valid while `source` still is the
/// allocation the scope's state lives in.
struct EncodedState {
    source: Weak<serde_json::Value>,
    bytes: Vec<u8>,
}

/// A scope's encoded state on loan from the cache. Hand it back with
/// [`EncodedStates::checkin`] so the buffer (and its capacity) is reused.
pub(crate) struct Lease {
    source: Weak<serde_json::Value>,
    bytes: Vec<u8>,
}

impl Lease {
    pub(crate) fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    /// Split into the bytes (for an API that needs them owned, like a
    /// `SiblingState`) and the receipt that turns them back into a lease.
    pub(crate) fn into_parts(self) -> (Vec<u8>, LeaseReceipt) {
        (
            self.bytes,
            LeaseReceipt {
                source: self.source,
            },
        )
    }
}

/// What remains of a [`Lease`] whose bytes were moved out for a call.
pub(crate) struct LeaseReceipt {
    source: Weak<serde_json::Value>,
}

impl LeaseReceipt {
    pub(crate) fn rejoin(self, bytes: Vec<u8>) -> Lease {
        Lease {
            source: self.source,
            bytes,
        }
    }
}

/// Why a scope's encoded state could not be produced.
#[derive(Debug)]
pub(crate) enum SnapshotError {
    /// No module state is registered under the scope.
    NoStateSlot,
    /// The state could not be JSON-encoded. Unreachable for a
    /// `serde_json::Value` in practice; reported rather than assumed.
    Encode(String),
}

/// Per-scope cache of JSON-encoded module state.
#[derive(Default)]
pub(crate) struct EncodedStates {
    entries: HashMap<String, EncodedState>,
}

impl EncodedStates {
    /// Borrow `scope`'s JSON-encoded state out of the cache, encoding it only
    /// when the cached bytes are stale. `scope` must be canonical (lowercase).
    pub(crate) fn checkout(
        &mut self,
        core: &EngineCore,
        scope: &str,
    ) -> Result<Lease, SnapshotError> {
        let Some(instance) = core.modules.get(scope) else {
            self.entries.remove(scope);
            return Err(SnapshotError::NoStateSlot);
        };
        let mut buffer = Vec::new();
        if let Some(entry) = self.entries.get_mut(scope) {
            buffer = std::mem::take(&mut entry.bytes);
            if std::ptr::eq(entry.source.as_ptr(), instance.get_state()) {
                return Ok(Lease {
                    source: entry.source.clone(),
                    bytes: buffer,
                });
            }
            buffer.clear();
        }
        serde_json::to_writer(&mut buffer, instance.get_state())
            .map_err(|e| SnapshotError::Encode(e.to_string()))?;
        Ok(Lease {
            source: Arc::downgrade(&instance.get_state_shared()),
            bytes: buffer,
        })
    }

    /// Return a lease taken with [`checkout`](Self::checkout).
    pub(crate) fn checkin(&mut self, scope: &str, lease: Lease) {
        let Lease { source, bytes } = lease;
        match self.entries.get_mut(scope) {
            Some(entry) => {
                entry.source = source;
                entry.bytes = bytes;
            }
            None => {
                self.entries
                    .insert(scope.to_string(), EncodedState { source, bytes });
            }
        }
    }

    /// Drop `scope`'s cached bytes (the scope was unwired).
    pub(crate) fn forget(&mut self, scope: &str) {
        self.entries.remove(scope);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lifecycle::{Module, ModuleInstance};
    use serde_json::json;

    fn core_with(scope: &str, state: serde_json::Value) -> EngineCore {
        let mut core = EngineCore::new();
        core.register_module(scope, ModuleInstance::new(Module::new(scope), state));
        core
    }

    #[test]
    fn unchanged_state_is_lent_without_re_encoding() {
        let mut core = core_with("a", json!({ "n": 1 }));
        let mut cache = EncodedStates::default();

        let lease = cache.checkout(&core, "a").unwrap();
        assert_eq!(lease.bytes(), br#"{"n":1}"#);
        let first_buffer = lease.bytes().as_ptr();
        cache.checkin("a", lease);

        // Same state allocation: the very same buffer comes back.
        let lease = cache.checkout(&core, "a").unwrap();
        assert_eq!(lease.bytes().as_ptr(), first_buffer);
        cache.checkin("a", lease);

        // Any write moves the state to a new allocation: re-encoded.
        assert!(core.update_state(Some("a"), json!({ "n": 2 }), None));
        let lease = cache.checkout(&core, "a").unwrap();
        assert_eq!(lease.bytes(), br#"{"n":2}"#);
        cache.checkin("a", lease);
    }

    #[test]
    fn bytes_moved_out_for_a_call_rejoin_their_lease() {
        let core = core_with("a", json!({ "n": 1 }));
        let mut cache = EncodedStates::default();
        let (bytes, receipt) = cache.checkout(&core, "a").unwrap().into_parts();
        let buffer = bytes.as_ptr();
        cache.checkin("a", receipt.rejoin(bytes));
        assert_eq!(cache.checkout(&core, "a").unwrap().bytes().as_ptr(), buffer);
    }

    #[test]
    fn a_scope_without_a_state_slot_is_an_error_and_drops_its_entry() {
        let mut core = core_with("a", json!({}));
        let mut cache = EncodedStates::default();
        let lease = cache.checkout(&core, "a").unwrap();
        cache.checkin("a", lease);

        crate::agent_core::unregister_module(&mut core, "a");
        assert!(matches!(
            cache.checkout(&core, "a"),
            Err(SnapshotError::NoStateSlot)
        ));
        assert!(cache.entries.is_empty());
        assert!(matches!(
            cache.checkout(&core, "ghost"),
            Err(SnapshotError::NoStateSlot)
        ));
    }
}
