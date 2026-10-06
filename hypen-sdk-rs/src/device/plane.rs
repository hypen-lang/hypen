//! One connection's device plane: the native half around the shared Rust
//! [`DeviceBroker`] (RFC 001 §4 "one broker implementation").
//!
//! The broker owns the protocol state machine; this file pumps socket input
//! into it, drains its outputs into the [`DeviceTransport`] and the handler
//! API, and drives its timers from a small per-connection timer thread (the
//! Go SDK's `time.AfterFunc`, the TypeScript `setTimeout`).
//!
//! # Delivery and locking
//!
//! Handler traffic (events, data chunks, settlements) never runs under the
//! plane lock. Each output becomes a queued *job*; jobs run in order on
//! whichever thread next drains the queue: the socket reader after
//! `handle_message` / `handle_binary`, the timer thread after a tick, or the
//! session at the end of an action dispatch. A job that applies a device
//! result to module state takes the session lock itself; jobs are never run
//! while the current thread is inside a session dispatch (that would
//! re-enter the session), so a handler that opens a request and has its
//! refusal settle immediately just leaves the job for the dispatch's own
//! drain. Lock order is always *session → plane*, never the reverse.

use std::cell::Cell;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, Weak};
use std::time::{Duration, Instant};

use hypen_engine::device::{
    DeviceBroker, LocalRefusal, OpenSpec, Outcome, Output, DEVICE_PLANE_CLOSE_CODE,
};
use hypen_engine::serialize::device::DeviceErrorCode;
use serde_json::Value;

use super::DeviceTransport;

/// Work queued by the plane for a consumer, run outside the plane lock.
pub(crate) type Job = Box<dyn FnOnce() + Send>;

/// What a request's consumer receives, in order.
pub(crate) enum Delivery {
    Event(Value),
    Data { channel: u16, bytes: Vec<u8> },
    Settled(Outcome),
}

/// A request's consumer. Called from a job (never under the plane lock).
pub(crate) type Consumer = Box<dyn FnMut(Delivery) + Send>;

enum Slot {
    /// Opened; its consumer is not installed yet: deliveries wait here.
    Waiting(Vec<Delivery>),
    Consuming(Arc<Mutex<Consumer>>),
}

/// Applies a closure to one module's JSON state inside the session and
/// ships the resulting patches — how a device result reaches module state.
pub(crate) trait StateApplier: Send + Sync {
    /// Run `f` on the state of `scope` (`""` = primary module). Returns
    /// false when the session is gone.
    fn apply(&self, scope: &str, f: &mut dyn FnMut(&mut Value)) -> bool;
}

thread_local! {
    /// Set while this thread runs a session dispatch (a handler, a hello, a
    /// device continuation): jobs must not run re-entrantly then.
    static IN_DISPATCH: Cell<u32> = const { Cell::new(0) };
}

/// RAII marker for "this thread is inside a session dispatch".
pub(crate) struct DispatchGuard;

impl DispatchGuard {
    pub(crate) fn enter() -> Self {
        IN_DISPATCH.with(|c| c.set(c.get() + 1));
        DispatchGuard
    }
}

impl Drop for DispatchGuard {
    fn drop(&mut self) {
        IN_DISPATCH.with(|c| c.set(c.get().saturating_sub(1)));
    }
}

pub(crate) fn in_dispatch() -> bool {
    IN_DISPATCH.with(|c| c.get() > 0)
}

struct PlaneState {
    broker: DeviceBroker,
    closed: bool,
    slots: HashMap<u32, Slot>,
}

pub(crate) struct DevicePlane {
    state: Mutex<PlaneState>,
    /// Wakes the timer thread when the next deadline may have moved.
    timer: Condvar,
    transport: Arc<dyn DeviceTransport>,
    start: Instant,
    jobs: Mutex<VecDeque<Job>>,
    draining: AtomicBool,
    applier: Mutex<Option<Arc<dyn StateApplier>>>,
}

impl std::fmt::Debug for DevicePlane {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DevicePlane").finish_non_exhaustive()
    }
}

impl DevicePlane {
    /// A plane around `broker` (not started), with its timer thread.
    pub(crate) fn new(
        broker: DeviceBroker,
        transport: Arc<dyn DeviceTransport>,
        start: Instant,
    ) -> Arc<Self> {
        let plane = Arc::new(DevicePlane {
            state: Mutex::new(PlaneState {
                broker,
                closed: false,
                slots: HashMap::new(),
            }),
            timer: Condvar::new(),
            transport,
            start,
            jobs: Mutex::new(VecDeque::new()),
            draining: AtomicBool::new(false),
            applier: Mutex::new(None),
        });
        let weak = Arc::downgrade(&plane);
        let _ = std::thread::Builder::new()
            .name("hypen-device-timer".into())
            .spawn(move || timer_loop(weak));
        plane
    }

    pub(crate) fn now(&self) -> u64 {
        self.start.elapsed().as_millis() as u64
    }

    pub(crate) fn set_applier(&self, applier: Arc<dyn StateApplier>) {
        *self.applier.lock().unwrap() = Some(applier);
    }

    pub(crate) fn applier(&self) -> Option<Arc<dyn StateApplier>> {
        self.applier.lock().unwrap().clone()
    }

    /// Run `op` on the broker with the plane lock held, then flush its
    /// outputs (socket traffic now, handler traffic as jobs) and drain the
    /// job queue when this thread may.
    fn with_broker<R>(&self, op: impl FnOnce(&mut DeviceBroker, u64) -> R) -> Option<R> {
        let r = {
            let mut st = self.state.lock().unwrap();
            if st.closed {
                return None;
            }
            let now = self.now();
            let r = op(&mut st.broker, now);
            self.flush_locked(&mut st);
            r
        };
        self.timer.notify_all();
        self.drain_jobs();
        Some(r)
    }

    fn flush_locked(&self, st: &mut PlaneState) {
        st.broker
            .set_transport_buffered(self.transport.buffered_bytes());
        let outs = st.broker.poll();
        let mut close: Option<(u16, String)> = None;
        for out in outs {
            match out {
                Output::SendText(text) => self.transport.send_text(text),
                Output::SendFrame(frame) => self.transport.send_binary(frame),
                Output::Event { id, event } => deliver(st, &self.jobs, id, Delivery::Event(event)),
                Output::Data { id, channel, bytes } => {
                    deliver(st, &self.jobs, id, Delivery::Data { channel, bytes })
                }
                Output::Settled { id, outcome } => {
                    deliver(st, &self.jobs, id, Delivery::Settled(outcome))
                }
                Output::CloseConnection { code, reason } => close = Some((code, reason)),
            }
        }
        if let Some((code, reason)) = close {
            st.closed = true;
            // Every pending consumer settles; nothing else is sent.
            settle_all(st, &self.jobs, DeviceErrorCode::ConnectionLost);
            log::warn!("hypen device: {reason} — closing the socket ({code})");
            self.transport.close(code, &reason);
        }
    }

    /// Run queued jobs, in order, unless this thread is inside a session
    /// dispatch (the dispatch drains when it ends) or another thread is
    /// draining already.
    pub(crate) fn drain_jobs(&self) {
        if in_dispatch() {
            return;
        }
        loop {
            if self.draining.swap(true, Ordering::AcqRel) {
                return; // another thread drains; it re-checks the queue
            }
            loop {
                let job = self.jobs.lock().unwrap().pop_front();
                let Some(job) = job else { break };
                if std::panic::catch_unwind(std::panic::AssertUnwindSafe(job)).is_err() {
                    log::error!("hypen device: a device continuation panicked");
                }
            }
            self.draining.store(false, Ordering::Release);
            if self.jobs.lock().unwrap().is_empty() {
                return;
            }
        }
    }

    // ---- socket input ------------------------------------------------------

    pub(crate) fn on_text(&self, text: &str) {
        self.with_broker(|b, now| b.on_text(text, now));
    }

    pub(crate) fn on_frame(&self, frame: &[u8]) {
        self.with_broker(|b, now| b.on_frame(frame, now));
    }

    // ---- lifecycle -------------------------------------------------------------

    pub(crate) fn start(&self) -> Result<u32, LocalRefusal> {
        self.with_broker(|b, now| b.start(now))
            .unwrap_or(Err(LocalRefusal {
                code: DeviceErrorCode::ConnectionLost,
                detail: None,
            }))
    }

    pub(crate) fn owner_activated(&self, module: &str, activation: u32) -> bool {
        self.with_broker(|b, now| b.owner_activated(module, activation, now))
            .unwrap_or(false)
    }

    pub(crate) fn owner_deactivated(&self, module: &str, activation: u32) {
        self.with_broker(|b, now| b.owner_deactivated(module, activation, now));
    }

    pub(crate) fn owner_destroyed(&self, module: &str) {
        self.with_broker(|b, now| b.owner_destroyed(module, now));
    }

    /// The connection closed: every live request settles `connectionLost`,
    /// nothing more is sent, the timer thread exits.
    pub(crate) fn close(&self) {
        {
            let mut st = self.state.lock().unwrap();
            if st.closed {
                return;
            }
            st.closed = true;
            st.broker.close(DeviceErrorCode::ConnectionLost);
            // Only settlements are left in the broker's queue now.
            let outs = st.broker.poll();
            for out in outs {
                if let Output::Settled { id, outcome } = out {
                    deliver(&mut st, &self.jobs, id, Delivery::Settled(outcome));
                }
            }
            settle_all(&mut st, &self.jobs, DeviceErrorCode::ConnectionLost);
        }
        self.timer.notify_all();
        self.drain_jobs();
    }

    pub(crate) fn is_closed(&self) -> bool {
        self.state.lock().unwrap().closed
    }

    // ---- queries -------------------------------------------------------------------

    pub(crate) fn supports(&self, capability: &str) -> bool {
        let st = self.state.lock().unwrap();
        !st.closed && st.broker.supports(capability)
    }

    pub(crate) fn selected_version(&self, capability: &str) -> Option<u32> {
        let st = self.state.lock().unwrap();
        if st.closed {
            return None;
        }
        st.broker.selected_version(capability)
    }

    pub(crate) fn selection(&self) -> Vec<(String, u32)> {
        let st = self.state.lock().unwrap();
        if st.closed {
            return Vec::new();
        }
        st.broker.selection().to_vec()
    }

    /// Diagnostics for tests: `(live requests, retained bytes, connection
    /// violations)`.
    pub(crate) fn stats(&self) -> (usize, u64, u64) {
        let st = self.state.lock().unwrap();
        (
            st.broker.live_count(),
            st.broker.retained_bytes(),
            st.broker.connection_violations(),
        )
    }

    // ---- requests ----------------------------------------------------------------

    /// Open a request; its deliveries wait until [`Self::install`].
    pub(crate) fn open(&self, spec: OpenSpec) -> Result<u32, LocalRefusal> {
        let r = {
            let mut st = self.state.lock().unwrap();
            if st.closed {
                return Err(LocalRefusal {
                    code: DeviceErrorCode::Unavailable,
                    detail: Some("device-disabled".into()),
                });
            }
            let now = self.now();
            let r = st.broker.open(spec, now);
            if let Ok(id) = r {
                st.slots.insert(id, Slot::Waiting(Vec::new()));
            }
            // A refusal can still queue outputs (id exhaustion closes the
            // plane).
            self.flush_locked(&mut st);
            r
        };
        self.timer.notify_all();
        self.drain_jobs();
        r
    }

    /// Install the consumer of `id`; deliveries that arrived before are
    /// queued to it at once, in order.
    pub(crate) fn install(&self, id: u32, consumer: Consumer) {
        let consumer = Arc::new(Mutex::new(consumer));
        {
            let mut st = self.state.lock().unwrap();
            let Some(slot) = st.slots.get_mut(&id) else {
                return;
            };
            let waiting = match std::mem::replace(slot, Slot::Consuming(Arc::clone(&consumer))) {
                Slot::Waiting(w) => w,
                Slot::Consuming(_) => Vec::new(),
            };
            let settled = waiting.iter().any(|d| matches!(d, Delivery::Settled(_)));
            if settled {
                st.slots.remove(&id);
            }
            let mut jobs = self.jobs.lock().unwrap();
            for d in waiting {
                let c = Arc::clone(&consumer);
                jobs.push_back(Box::new(move || (c.lock().unwrap())(d)));
            }
        }
        self.drain_jobs();
    }

    pub(crate) fn cancel(&self, id: u32) {
        self.with_broker(|b, now| b.cancel(id, now));
    }

    pub(crate) fn release_result(&self, id: u32) {
        self.with_broker(|b, _| b.release_result(id));
    }

    pub(crate) fn consumed_events(&self, id: u32, n: u64) {
        self.with_broker(|b, now| b.consumed_events(id, n, now));
    }

    pub(crate) fn consumed_data(&self, id: u32, chunks: usize) {
        self.with_broker(|b, now| b.consumed_data(id, chunks, now));
    }

    fn tick(&self) -> Option<u64> {
        let next = {
            let mut st = self.state.lock().unwrap();
            if st.closed {
                return None;
            }
            let now = self.now();
            let next = st.broker.tick(now);
            self.flush_locked(&mut st);
            if st.closed {
                None
            } else {
                st.broker.next_deadline().or(next)
            }
        };
        self.drain_jobs();
        next
    }
}

/// Queue a delivery for `id`'s consumer (or park it until one is installed).
fn deliver(st: &mut PlaneState, jobs: &Mutex<VecDeque<Job>>, id: u32, d: Delivery) {
    let settled = matches!(d, Delivery::Settled(_));
    match st.slots.get_mut(&id) {
        None => {} // the broker's internal core stream, or an unknown id
        Some(Slot::Waiting(w)) => w.push(d),
        Some(Slot::Consuming(c)) => {
            let c = Arc::clone(c);
            jobs.lock()
                .unwrap()
                .push_back(Box::new(move || (c.lock().unwrap())(d)));
            if settled {
                st.slots.remove(&id);
            }
        }
    }
}

/// Settle every consumer still waiting (the plane closed under them).
fn settle_all(st: &mut PlaneState, jobs: &Mutex<VecDeque<Job>>, code: DeviceErrorCode) {
    let ids: Vec<u32> = st.slots.keys().copied().collect();
    for id in ids {
        let already = matches!(
            st.slots.get(&id),
            Some(Slot::Waiting(w)) if w.iter().any(|d| matches!(d, Delivery::Settled(_)))
        );
        if !already {
            deliver(
                st,
                jobs,
                id,
                Delivery::Settled(Outcome::Err { code, detail: None }),
            );
        }
    }
}

/// The plane's timer: tick at the broker's next deadline. Holds only a weak
/// reference between waits, so a dropped plane ends the thread.
fn timer_loop(plane: Weak<DevicePlane>) {
    loop {
        let Some(p) = plane.upgrade() else { return };
        let wait = {
            let st = p.state.lock().unwrap();
            if st.closed {
                return;
            }
            let now = p.now();
            match st.broker.next_deadline() {
                Some(at) if at <= now => None,
                Some(at) => Some(Duration::from_millis((at - now).min(1_000))),
                None => Some(Duration::from_millis(1_000)),
            }
        };
        match wait {
            None => {
                p.tick();
            }
            Some(d) => {
                let st = p.state.lock().unwrap();
                let _ = p.timer.wait_timeout(st, d).unwrap();
            }
        }
        drop(p);
    }
}

/// The close code a host uses when the plane resets the connection.
pub(crate) const PLANE_CLOSE_CODE: u16 = DEVICE_PLANE_CLOSE_CODE;
