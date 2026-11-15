//! The instance table: which ids are live, which are dead and why.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

use super::error::CallFailure;
use crate::module_host::{HostError, ModuleInstanceId};

/// Ids are drawn from one process-wide counter, so an id is never reused and
/// never valid in a host other than the one that issued it: a stale or
/// foreign id can only miss, it cannot address some other live instance.
static NEXT_INSTANCE: AtomicU64 = AtomicU64::new(1);

/// A marker bit in the ids a table issues, so `DualHost` can route an id to
/// the host that owns it without a lookup table.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum IdTag {
    /// Ids of a standalone host, and of the v0.1 host of a `DualHost`.
    Plain,
    /// Ids of the v0.2 host of a `DualHost`.
    Async,
}

impl IdTag {
    /// The counter would need 2^63 instantiations to reach this bit.
    const ASYNC_BIT: u64 = 1 << 63;

    fn bits(self) -> u64 {
        match self {
            IdTag::Plain => 0,
            IdTag::Async => Self::ASYNC_BIT,
        }
    }

    /// The tag an id carries.
    pub(crate) fn of(id: ModuleInstanceId) -> Self {
        if id.0 & Self::ASYNC_BIT == 0 {
            IdTag::Plain
        } else {
            IdTag::Async
        }
    }
}

/// One entry of the table.
pub(crate) enum InstanceSlot<I> {
    Live(I),
    /// The instance trapped or overran its deadline. Its store is gone (the
    /// guest's memory was left mid-call, so nothing in it can be trusted);
    /// the slot stays, remembering why, until the id is destroyed.
    Dead {
        reason: CallFailure,
    },
}

pub(crate) struct InstanceTable<I> {
    slots: HashMap<u64, InstanceSlot<I>>,
    tag: IdTag,
}

impl<I> InstanceTable<I> {
    pub(crate) fn new(tag: IdTag) -> Self {
        Self {
            slots: HashMap::new(),
            tag,
        }
    }

    pub(crate) fn insert(&mut self, instance: I) -> ModuleInstanceId {
        let id = NEXT_INSTANCE.fetch_add(1, Ordering::Relaxed) | self.tag.bits();
        self.slots.insert(id, InstanceSlot::Live(instance));
        ModuleInstanceId(id)
    }

    /// The live instance behind `id`. A dead instance, a destroyed one, and
    /// an id this host never issued all answer [`HostError::DeadInstance`].
    pub(crate) fn live_mut(&mut self, id: ModuleInstanceId) -> Result<&mut I, HostError> {
        match self.slots.get_mut(&id.0) {
            Some(InstanceSlot::Live(instance)) => Ok(instance),
            Some(InstanceSlot::Dead { .. }) | None => Err(HostError::DeadInstance),
        }
    }

    /// Drop the instance behind `id` (and with it its store) and remember
    /// why. No-op for an id that is not in the table.
    pub(crate) fn kill(&mut self, id: ModuleInstanceId, reason: CallFailure) {
        if let Some(slot) = self.slots.get_mut(&id.0) {
            *slot = InstanceSlot::Dead { reason };
        }
    }

    /// Why the instance behind `id` is dead; `None` if it is live or unknown.
    pub(crate) fn death_reason(&self, id: ModuleInstanceId) -> Option<&CallFailure> {
        match self.slots.get(&id.0) {
            Some(InstanceSlot::Dead { reason }) => Some(reason),
            Some(InstanceSlot::Live(_)) | None => None,
        }
    }

    /// Forget `id`. A dead instance still occupies its slot until destroyed,
    /// so destroying it succeeds; destroying twice does not.
    pub(crate) fn remove(&mut self, id: ModuleInstanceId) -> Result<(), HostError> {
        self.slots
            .remove(&id.0)
            .map(drop)
            .ok_or(HostError::DeadInstance)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::module_host::kv::ModuleName;
    use crate::module_host::wasmtime::error::{Export, Fault};

    fn failure() -> CallFailure {
        CallFailure {
            module: ModuleName::new("m"),
            export: Export::Dispatch,
            fault: Fault::GuestTrap("boom".into()),
        }
    }

    #[test]
    fn ids_are_unique_across_tables_and_carry_the_tag() {
        let mut plain = InstanceTable::new(IdTag::Plain);
        let mut tagged = InstanceTable::new(IdTag::Async);
        let a = plain.insert("a");
        let b = tagged.insert("b");
        let c = plain.insert("c");
        assert_eq!(IdTag::of(a), IdTag::Plain);
        assert_eq!(IdTag::of(b), IdTag::Async);
        assert!(a != c && a.0 != b.0 & !IdTag::ASYNC_BIT);

        // An id is only valid in the table that issued it.
        assert!(matches!(tagged.live_mut(a), Err(HostError::DeadInstance)));
        assert!(matches!(plain.live_mut(b), Err(HostError::DeadInstance)));
        assert!(matches!(plain.remove(b), Err(HostError::DeadInstance)));
        assert_eq!(plain.live_mut(a).ok().copied(), Some("a"));
    }

    #[test]
    fn a_killed_instance_keeps_its_slot_and_its_reason_until_destroyed() {
        let mut table = InstanceTable::new(IdTag::Plain);
        let id = table.insert(());
        assert!(table.death_reason(id).is_none());

        table.kill(id, failure());
        assert!(matches!(table.live_mut(id), Err(HostError::DeadInstance)));
        assert_eq!(table.death_reason(id), Some(&failure()));

        table.remove(id).unwrap();
        assert!(table.death_reason(id).is_none());
        assert!(matches!(table.remove(id), Err(HostError::DeadInstance)));
        // Killing an id that is gone does not resurrect a slot.
        table.kill(id, failure());
        assert!(table.death_reason(id).is_none());
    }
}
