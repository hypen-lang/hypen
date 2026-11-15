//! What every native host shares: the wasmtime engine, the epoch ticker, the
//! tokio runtime, and the deadline every guest call runs under.

use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use wasmtime::{Config, Engine, Store};

use super::error::Fault;
use super::store::HostState;
use crate::module_host::HostError;

/// How often the background thread advances wasmtime's epoch counter. A
/// [`Deadline`] is a whole number of these ticks, so this is also the
/// granularity of the guest-CPU timeout.
const EPOCH_TICK: Duration = Duration::from_millis(10);

/// How the wasmtime engine executes module code.
///
/// `Jit` (Cranelift) is the default everywhere runtime codegen is allowed.
/// `Interpreter` compiles modules to Pulley bytecode and interprets them —
/// no executable pages are ever mapped, which is the hard requirement on
/// iOS (no JIT entitlement) and the reason this knob exists. Reducers are
/// small and event-driven, so interpretation is an acceptable trade there.
/// Timeouts and memory limits work identically under both.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum ExecStrategy {
    #[default]
    Jit,
    Interpreter,
}

/// The Pulley target triple for the current pointer width.
fn pulley_triple() -> &'static str {
    if cfg!(target_pointer_width = "32") {
        "pulley32"
    } else {
        "pulley64"
    }
}

/// The wall-clock budget of one guest call, measured from the moment the
/// call starts. It is enforced twice, because neither mechanism alone covers
/// both ways a call can overrun:
///
/// - **epoch interruption** traps guest code that is still *running* at the
///   deadline (a CPU loop never yields to the runtime), and
/// - **`tokio::time::timeout`** cancels a call that is *parked in a host
///   call* at the deadline (`wasi:io/poll`, a `wasi:http` request to a
///   silent server, `hypen:time.sleep-ms`) — no guest code runs there, so
///   epochs never fire.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Deadline {
    budget: Duration,
}

impl Deadline {
    pub(crate) fn after(budget: Duration) -> Self {
        Self { budget }
    }

    /// The budget as a number of epoch ticks: at least 1, and capped so
    /// that wasmtime's `current epoch + ticks` cannot overflow however large
    /// a budget the embedder configured.
    fn epoch_ticks(self) -> u64 {
        const MAX_TICKS: u64 = u64::MAX / 2;
        let ticks = self.budget.as_millis() / EPOCH_TICK.as_millis().max(1);
        u64::try_from(ticks)
            .unwrap_or(MAX_TICKS)
            .clamp(1, MAX_TICKS)
    }
}

/// The engine, the epoch-ticker thread that drives guest-CPU timeouts, and
/// the current-thread tokio runtime that drives async guest calls. One per
/// standalone host; `DualHost` shares a single core between its v0.1 and
/// v0.2 hosts (one engine, one ticker thread, one runtime). Dropping the last
/// reference stops the ticker.
pub(crate) struct HostCore {
    engine: Engine,
    /// `Some` until drop (`shutdown_background` consumes the runtime).
    runtime: Option<tokio::runtime::Runtime>,
    epoch_stop: Arc<AtomicBool>,
    ticker: Option<JoinHandle<()>>,
}

impl HostCore {
    pub(crate) fn new(strategy: ExecStrategy) -> Result<Arc<Self>, HostError> {
        let mut config = Config::new();
        config.wasm_component_model(true);
        // CM-async (the v0.2 world) is default-enabled with wasmtime's
        // `component-model-async` cargo feature; set explicitly for
        // self-documentation. v0.1 components don't use it.
        config.wasm_component_model_async(true);
        // Epoch interruption is the guest-CPU timeout: a background thread
        // ticks the epoch and guest code still running at its deadline traps.
        config.epoch_interruption(true);
        // Shared memories are not routed through `ResourceLimiter`; keep them
        // uncreatable (wasmtime's default) so the memory budget is total.
        config.shared_memory(false);
        if strategy == ExecStrategy::Interpreter {
            config
                .target(pulley_triple())
                .map_err(|e| HostError::Runtime(format!("pulley target: {e}")))?;
        }
        let engine = Engine::new(&config)
            .map_err(|e| HostError::Runtime(format!("wasmtime engine: {e}")))?;

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| HostError::Runtime(format!("module runtime: {e}")))?;

        // Spawn the epoch ticker. Cloning the engine is cheap (Arc inside) and
        // lets the thread advance the shared epoch without touching the host.
        let epoch_stop = Arc::new(AtomicBool::new(false));
        let ticker = {
            let engine = engine.clone();
            let stop = Arc::clone(&epoch_stop);
            std::thread::Builder::new()
                .name("hypen-module-epoch".into())
                .spawn(move || {
                    while !stop.load(Ordering::Relaxed) {
                        std::thread::sleep(EPOCH_TICK);
                        engine.increment_epoch();
                    }
                })
                .map_err(|e| HostError::Runtime(format!("epoch ticker: {e}")))?
        };

        Ok(Arc::new(Self {
            engine,
            runtime: Some(runtime),
            epoch_stop,
            ticker: Some(ticker),
        }))
    }

    pub(crate) fn engine(&self) -> &Engine {
        &self.engine
    }

    /// Run one guest call on `store` under `deadline`.
    ///
    /// Arms the epoch deadline, then drives `call` on the host's runtime
    /// inside the wall-clock timeout. A timeout cancels the call by dropping
    /// its future, which unwinds the suspended guest. After `Err` the store
    /// is in an unknown state and must be discarded.
    ///
    /// Blocks the calling thread. tokio refuses a nested `block_on`, so this
    /// (and with it every `ModuleHost` method of the native hosts) panics if
    /// called from inside another runtime's async context — use
    /// `spawn_blocking` there.
    pub(crate) fn run_guest<R>(
        &self,
        deadline: Deadline,
        store: &mut Store<HostState>,
        call: impl AsyncFnOnce(&mut Store<HostState>) -> wasmtime::Result<R>,
    ) -> Result<R, Fault> {
        store.set_epoch_deadline(deadline.epoch_ticks());
        // A refusal from before this call (e.g. during a call that then
        // recovered) must not be blamed on this one.
        store.data_mut().limiter.take_denied();

        let outcome = match self.block_on(deadline.budget, call(store)) {
            Ok(outcome) => outcome,
            Err(TimedOut) => return Err(Fault::HostCallTimeout(deadline.budget)),
        };
        outcome
            .map_err(|e| Fault::from_wasmtime(&e, deadline.budget, &mut store.data_mut().limiter))
    }

    fn block_on<F: Future>(&self, budget: Duration, call: F) -> Result<F::Output, TimedOut> {
        // The runtime is only taken in `drop`, which needs `&mut self`; a
        // shared reference can't observe it missing. Reported as a timeout
        // rather than a panic all the same.
        let Some(runtime) = self.runtime.as_ref() else {
            return Err(TimedOut);
        };
        runtime
            .block_on(async { tokio::time::timeout(budget, call).await })
            .map_err(|_| TimedOut)
    }
}

/// The wall-clock timeout fired before the call finished.
struct TimedOut;

impl Drop for HostCore {
    fn drop(&mut self) {
        self.epoch_stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.ticker.take() {
            let _ = t.join();
        }
        // Don't wait on blocking-pool work a cancelled call left behind
        // (e.g. a DNS lookup): dropping a host must not hang.
        if let Some(rt) = self.runtime.take() {
            rt.shutdown_background();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A host's background resources stop with it: after the last reference
    /// to the core drops, nothing keeps ticking the engine's epoch.
    #[test]
    fn dropping_the_core_stops_the_epoch_ticker() {
        let core = HostCore::new(ExecStrategy::Jit).unwrap();
        let stop = Arc::clone(&core.epoch_stop);
        let second = Arc::clone(&core);
        drop(core);
        assert!(
            !stop.load(Ordering::Relaxed),
            "still referenced: keeps ticking"
        );
        drop(second);
        assert!(stop.load(Ordering::Relaxed));
        // `Drop` joined the thread; only our handle to the flag is left.
        assert_eq!(Arc::strong_count(&stop), 1);
    }

    /// The deadline wrapper cancels a future that never completes.
    #[test]
    fn block_on_cancels_at_the_deadline() {
        let core = HostCore::new(ExecStrategy::Jit).unwrap();
        let started = std::time::Instant::now();
        let res = core.block_on(Duration::from_millis(50), std::future::pending::<()>());
        assert!(res.is_err());
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_eq!(
            core.block_on(Duration::from_secs(5), async { 7 }).ok(),
            Some(7)
        );
    }

    #[test]
    fn a_deadline_is_at_least_one_epoch_tick() {
        assert_eq!(Deadline::after(Duration::ZERO).epoch_ticks(), 1);
        assert_eq!(Deadline::after(Duration::from_millis(5)).epoch_ticks(), 1);
        assert_eq!(Deadline::after(Duration::from_secs(5)).epoch_ticks(), 500);
        assert_eq!(Deadline::after(Duration::MAX).epoch_ticks(), u64::MAX / 2);
    }
}
