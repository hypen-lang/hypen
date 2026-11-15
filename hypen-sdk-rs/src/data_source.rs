//! Data-source contexts: named JSON blobs the engine exposes to templates as
//! `@name.path` (e.g. `@theme.color.primary`).
//!
//! The engine entry point is [`hypen_engine::Engine::set_context`]. The SDK
//! keeps every engine behind a mutex that is **held while action handlers
//! run**, so a handler that pushed a context straight into the engine would
//! deadlock on that mutex. Writes therefore go through a [`ContextSink`]:
//! the value is queued and applied by whoever holds the engine — at once
//! when it is free, otherwise right after the dispatch that is running, the
//! same point at which a handler's state changes reach the engine.

use std::ops::{Deref, DerefMut};
use std::sync::{Arc, Mutex, MutexGuard, Weak};

use hypen_engine::Engine;
use indexmap::IndexMap;
use serde_json::Value;

/// Somewhere a data-source context can be published: an engine owned by a
/// [`ModuleInstance`](crate::module::ModuleInstance) or a
/// [`RemoteSession`](crate::remote::RemoteSession).
///
/// `set_context` never blocks on an engine that is busy on the calling
/// thread: it is safe to call from inside an action or lifecycle handler.
/// Several writes to the same name before the engine picks them up collapse
/// into the last one.
pub trait ContextSink: Send + Sync {
    /// Set (or replace) the data-source context `name`. Nodes bound to
    /// `@name.*` whose value changed re-render.
    fn set_context(&self, name: &str, data: Value);

    /// Set several contexts as one update, so that an engine that is free
    /// renders (and a session sends) them together. The default sets them
    /// one by one.
    fn set_contexts(&self, contexts: Vec<(String, Value)>) {
        for (name, data) in contexts {
            self.set_context(&name, data);
        }
    }

    /// True once the engine behind this sink is gone; publishers drop a
    /// closed sink.
    fn is_closed(&self) -> bool {
        false
    }
}

/// Contexts waiting for the engine, last write per name, in first-write order.
#[derive(Default)]
pub(crate) struct PendingContexts(Mutex<IndexMap<String, Value>>);

impl PendingContexts {
    pub(crate) fn push(&self, name: &str, data: Value) {
        self.0.lock().unwrap().insert(name.to_string(), data);
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.0.lock().unwrap().is_empty()
    }

    /// Hand everything queued to `engine`. The queue lock is released before
    /// the engine runs, so a render callback may queue more.
    pub(crate) fn apply(&self, engine: &mut Engine) {
        let queued = std::mem::take(&mut *self.0.lock().unwrap());
        for (name, data) in queued {
            engine.set_context(&name, data);
        }
    }
}

/// An engine plus the contexts queued for it. Every lock of the engine goes
/// through [`lock`](Self::lock), whose guard applies the queue on release —
/// so a context queued while the engine was busy (a handler mid-dispatch)
/// lands as soon as that dispatch lets go.
pub(crate) struct SharedEngine {
    engine: Mutex<Engine>,
    pending: PendingContexts,
}

impl SharedEngine {
    pub(crate) fn new(engine: Engine) -> Self {
        Self {
            engine: Mutex::new(engine),
            pending: PendingContexts::default(),
        }
    }

    pub(crate) fn lock(&self) -> EngineGuard<'_> {
        EngineGuard {
            guard: Some(self.engine.lock().unwrap()),
            shared: self,
        }
    }

    /// Queue contexts and apply them now if the engine is free.
    pub(crate) fn set_contexts(&self, contexts: impl IntoIterator<Item = (String, Value)>) {
        for (name, data) in contexts {
            self.pending.push(&name, data);
        }
        self.settle();
    }

    /// Apply the queue if the engine is free. When it is not, its holder
    /// does so on release (and re-checks afterwards, which closes the window
    /// between its last drain and its unlock).
    fn settle(&self) {
        while !self.pending.is_empty() {
            match self.engine.try_lock() {
                Ok(mut engine) => self.pending.apply(&mut engine),
                Err(_) => return,
            }
        }
    }
}

pub(crate) struct EngineGuard<'a> {
    guard: Option<MutexGuard<'a, Engine>>,
    shared: &'a SharedEngine,
}

impl Deref for EngineGuard<'_> {
    type Target = Engine;
    fn deref(&self) -> &Engine {
        self.guard.as_ref().expect("guard is live until drop")
    }
}

impl DerefMut for EngineGuard<'_> {
    fn deref_mut(&mut self) -> &mut Engine {
        self.guard.as_mut().expect("guard is live until drop")
    }
}

impl Drop for EngineGuard<'_> {
    fn drop(&mut self) {
        if let Some(mut engine) = self.guard.take() {
            if !std::thread::panicking() {
                self.shared.pending.apply(&mut engine);
            }
        }
        if !std::thread::panicking() {
            self.shared.settle();
        }
    }
}

/// The [`ContextSink`] of a [`ModuleInstance`](crate::module::ModuleInstance)'s
/// engine. Holds the engine weakly: it is inert once the instance is dropped.
pub(crate) struct EngineSink(pub(crate) Weak<SharedEngine>);

impl ContextSink for EngineSink {
    fn set_context(&self, name: &str, data: Value) {
        self.set_contexts(vec![(name.to_string(), data)]);
    }

    fn set_contexts(&self, contexts: Vec<(String, Value)>) {
        if let Some(shared) = self.0.upgrade() {
            shared.set_contexts(contexts);
        }
    }

    fn is_closed(&self) -> bool {
        self.0.strong_count() == 0
    }
}

impl<T: ContextSink + ?Sized> ContextSink for Arc<T> {
    fn set_context(&self, name: &str, data: Value) {
        (**self).set_context(name, data)
    }

    fn set_contexts(&self, contexts: Vec<(String, Value)>) {
        (**self).set_contexts(contexts)
    }

    fn is_closed(&self) -> bool {
        (**self).is_closed()
    }
}
