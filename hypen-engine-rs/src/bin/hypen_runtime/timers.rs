//! `Delay` effects: one timer thread driving a min-heap.
//!
//! [`TimerQueue`] is the pure part — a heap of `(deadline, scope, action)`
//! with a per-module cap, driven by explicit `Instant`s so scheduling and
//! firing order are unit-testable without sleeping. [`Timers`] wraps it in a
//! mutex + condvar and owns the single thread that sleeps until the earliest
//! deadline and hands due timers to a callback (which dispatches them through
//! `Engine::dispatch_module_action`). Dropping [`Timers`] stops and joins the
//! thread; pending timers are discarded.

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::error::RuntimeError;
use crate::sync::lock;

/// Most timers one module may have pending. A module that keeps scheduling
/// past this is leaking timers (or looping); further delays are refused.
pub const MAX_PENDING_PER_MODULE: usize = 1024;

/// A timer that has come due: dispatch `action` to `scope`.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct TimerFire {
    pub scope: String,
    pub action: String,
}

#[derive(Debug, PartialEq, Eq, PartialOrd, Ord)]
struct Entry {
    deadline: Instant,
    /// Insertion order: timers with equal deadlines fire first-scheduled
    /// first.
    seq: u64,
    fire: TimerFire,
}

/// A min-heap of pending timers. No clock, no threads.
#[derive(Debug, Default)]
pub struct TimerQueue {
    heap: BinaryHeap<Reverse<Entry>>,
    pending: HashMap<String, usize>,
    next_seq: u64,
}

impl TimerQueue {
    /// Schedule `action` for `scope` at `deadline`. Refused (and nothing is
    /// queued) once the module has [`MAX_PENDING_PER_MODULE`] timers pending.
    pub fn schedule(&mut self, deadline: Instant, fire: TimerFire) -> Result<(), RuntimeError> {
        let pending = self.pending.entry(fire.scope.clone()).or_insert(0);
        if *pending >= MAX_PENDING_PER_MODULE {
            return Err(RuntimeError::TimerLimit {
                scope: fire.scope,
                action: fire.action,
                limit: MAX_PENDING_PER_MODULE,
            });
        }
        *pending += 1;
        let seq = self.next_seq;
        self.next_seq += 1;
        self.heap.push(Reverse(Entry { deadline, seq, fire }));
        Ok(())
    }

    /// Remove and return every timer due at `now`, earliest first.
    pub fn pop_due(&mut self, now: Instant) -> Vec<TimerFire> {
        let mut due = Vec::new();
        while self.heap.peek().is_some_and(|Reverse(e)| e.deadline <= now) {
            let Some(Reverse(entry)) = self.heap.pop() else { break };
            if let Some(count) = self.pending.get_mut(&entry.fire.scope) {
                *count -= 1;
                if *count == 0 {
                    self.pending.remove(&entry.fire.scope);
                }
            }
            due.push(entry.fire);
        }
        due
    }

    /// When the earliest pending timer is due.
    pub fn next_deadline(&self) -> Option<Instant> {
        self.heap.peek().map(|Reverse(e)| e.deadline)
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.heap.len()
    }
}

struct Shared {
    state: Mutex<State>,
    wake: Condvar,
}

struct State {
    queue: TimerQueue,
    stop: bool,
}

/// The timer service: schedule from any thread, fire on one.
pub struct Timers {
    shared: Arc<Shared>,
    thread: Option<JoinHandle<()>>,
}

/// A cheap handle for scheduling onto a [`Timers`] from other threads.
#[derive(Clone)]
pub struct TimerHandle {
    shared: Arc<Shared>,
}

impl TimerHandle {
    /// Schedule `fire` to run `delay` from now. A refused timer (per-module
    /// cap) is returned as an error for the caller to log.
    pub fn schedule(&self, delay: Duration, fire: TimerFire) -> Result<(), RuntimeError> {
        // `Instant + Duration` panics on overflow; a u32 of milliseconds
        // (≈49 days) cannot overflow it, but stay total anyway.
        let now = Instant::now();
        let deadline = now.checked_add(delay).unwrap_or(now);
        let result = lock(&self.shared.state, "timer").queue.schedule(deadline, fire);
        self.shared.wake.notify_one();
        result
    }

    #[cfg(test)]
    fn pending(&self) -> usize {
        lock(&self.shared.state, "timer").queue.len()
    }
}

impl Timers {
    /// Start the timer thread. `on_fire` runs on that thread for each due
    /// timer, with no timer lock held, and is handed a [`TimerHandle`] so it
    /// can schedule follow-up timers (a delayed action's own `Delay`s).
    pub fn start<F>(on_fire: F) -> Result<Self, RuntimeError>
    where
        F: Fn(TimerFire, &TimerHandle) + Send + 'static,
    {
        let shared = Arc::new(Shared {
            state: Mutex::new(State { queue: TimerQueue::default(), stop: false }),
            wake: Condvar::new(),
        });
        let worker = Arc::clone(&shared);
        let thread = std::thread::Builder::new()
            .name("hypen-timers".into())
            .spawn(move || run(&TimerHandle { shared: worker }, on_fire))
            .map_err(|source| RuntimeError::Thread { what: "timer", source })?;
        Ok(Timers { shared, thread: Some(thread) })
    }

    pub fn handle(&self) -> TimerHandle {
        TimerHandle { shared: Arc::clone(&self.shared) }
    }
}

impl Drop for Timers {
    fn drop(&mut self) {
        lock(&self.shared.state, "timer").stop = true;
        self.shared.wake.notify_all();
        if let Some(thread) = self.thread.take() {
            // A panic in `on_fire` already printed; nothing more to do here.
            let _ = thread.join();
        }
    }
}

fn run<F: Fn(TimerFire, &TimerHandle)>(handle: &TimerHandle, on_fire: F) {
    let shared = &*handle.shared;
    let mut state = lock(&shared.state, "timer");
    loop {
        if state.stop {
            return;
        }
        let now = Instant::now();
        let due = state.queue.pop_due(now);
        if !due.is_empty() {
            drop(state);
            for fire in due {
                on_fire(fire, handle);
            }
            state = lock(&shared.state, "timer");
            continue;
        }
        state = match state.queue.next_deadline() {
            Some(deadline) => {
                let wait = deadline.saturating_duration_since(now);
                match shared.wake.wait_timeout(state, wait) {
                    Ok((guard, _)) => guard,
                    Err(poisoned) => poisoned.into_inner().0,
                }
            }
            None => match shared.wake.wait(state) {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            },
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn fire(scope: &str, action: &str) -> TimerFire {
        TimerFire { scope: scope.into(), action: action.into() }
    }

    #[test]
    fn timers_fire_in_deadline_order_then_insertion_order() {
        let t0 = Instant::now();
        let ms = Duration::from_millis;
        let mut q = TimerQueue::default();
        q.schedule(t0 + ms(30), fire("a", "late")).unwrap();
        q.schedule(t0 + ms(10), fire("a", "first")).unwrap();
        q.schedule(t0 + ms(10), fire("b", "second")).unwrap();
        q.schedule(t0 + ms(20), fire("a", "third")).unwrap();

        assert_eq!(q.next_deadline(), Some(t0 + ms(10)));
        assert!(q.pop_due(t0 + ms(9)).is_empty(), "nothing due yet");
        assert_eq!(q.pop_due(t0 + ms(10)), vec![fire("a", "first"), fire("b", "second")]);
        assert_eq!(q.pop_due(t0 + ms(100)), vec![fire("a", "third"), fire("a", "late")]);
        assert_eq!(q.next_deadline(), None);
        assert_eq!(q.len(), 0);
    }

    #[test]
    fn pending_timers_are_capped_per_module() {
        let t0 = Instant::now();
        let mut q = TimerQueue::default();
        for _ in 0..MAX_PENDING_PER_MODULE {
            q.schedule(t0, fire("greedy", "tick")).unwrap();
        }
        let err = q.schedule(t0, fire("greedy", "tick")).unwrap_err();
        assert!(
            matches!(err, RuntimeError::TimerLimit { ref scope, limit, .. }
                if scope == "greedy" && limit == MAX_PENDING_PER_MODULE),
            "{err}"
        );
        assert_eq!(q.len(), MAX_PENDING_PER_MODULE, "the refused timer was not queued");

        // The cap is per module…
        q.schedule(t0, fire("modest", "tick")).unwrap();
        // …and firing frees capacity.
        assert_eq!(q.pop_due(t0).len(), MAX_PENDING_PER_MODULE + 1);
        q.schedule(t0, fire("greedy", "tick")).unwrap();
    }

    #[test]
    fn one_thread_fires_many_timers_and_they_can_chain() {
        let (tx, rx) = mpsc::channel::<TimerFire>();
        let timers = Timers::start(move |f: TimerFire, handle: &TimerHandle| {
            // A fired timer schedules a follow-up, like a module's chained Delay.
            if f.action == "first" {
                handle.schedule(Duration::ZERO, fire("m", "chained")).unwrap();
            }
            tx.send(f).unwrap();
        })
        .unwrap();
        let handle = timers.handle();

        handle.schedule(Duration::from_millis(40), fire("m", "second")).unwrap();
        handle.schedule(Duration::from_millis(5), fire("m", "first")).unwrap();

        let wait = Duration::from_secs(5);
        assert_eq!(rx.recv_timeout(wait).unwrap().action, "first");
        assert_eq!(rx.recv_timeout(wait).unwrap().action, "chained");
        assert_eq!(rx.recv_timeout(wait).unwrap().action, "second");
        assert_eq!(handle.pending(), 0);
    }

    #[test]
    fn dropping_timers_stops_the_thread_and_discards_pending() {
        let (tx, rx) = mpsc::channel::<TimerFire>();
        let timers = Timers::start(move |f, _: &TimerHandle| {
            let _ = tx.send(f);
        })
        .unwrap();
        let handle = timers.handle();
        // Far in the future: must not keep the process (or the join) waiting.
        handle.schedule(Duration::from_secs(3600 * 24 * 49), fire("m", "never")).unwrap();

        let started = Instant::now();
        drop(timers); // joins the thread
        assert!(started.elapsed() < Duration::from_secs(5), "shutdown is prompt");
        assert!(rx.recv_timeout(Duration::from_millis(50)).is_err(), "nothing fired");
        // Scheduling after shutdown is harmless.
        handle.schedule(Duration::ZERO, fire("m", "ignored")).unwrap();
    }
}
