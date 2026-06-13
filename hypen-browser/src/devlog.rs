//! In-app debug console buffer + a `log::Log` that tees the terminal
//! logs into it.
//!
//! The browser's patch console (the `{ }` toolbar panel) shows three
//! kinds of line, interleaved newest-last:
//!   * `▶ out` — actions dispatched to the active tab's server
//!   * `◀ in`  — patch batches received from the server
//!   * `·`     — the same `log::` records that print to the terminal
//!
//! Everything funnels through one process-global [`Console`] ring
//! buffer so the three sources stay in chronological order. Capture is
//! gated on [`Console::enabled`] so there's no cost (beyond an atomic
//! load) while the console is closed.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

/// Max lines retained in the console ring buffer.
const CONSOLE_CAP: usize = 400;

pub struct Console {
    lines: Mutex<VecDeque<String>>,
    enabled: AtomicBool,
}

impl Console {
    pub fn enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }

    /// Open / close capture. Closing also clears the buffer so a
    /// re-open starts fresh.
    pub fn set_enabled(&self, on: bool) {
        self.enabled.store(on, Ordering::Relaxed);
        if !on {
            self.lines.lock().expect("console poisoned").clear();
        }
    }

    /// Append a line (capped). No-op while disabled.
    pub fn push(&self, line: impl Into<String>) {
        if !self.enabled() {
            return;
        }
        let mut q = self.lines.lock().expect("console poisoned");
        q.push_back(line.into());
        while q.len() > CONSOLE_CAP {
            q.pop_front();
        }
    }

    /// Current buffer joined newest-last, ready to render.
    pub fn snapshot(&self) -> String {
        self.lines
            .lock()
            .expect("console poisoned")
            .iter()
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    }
}

/// The process-global console buffer.
pub fn console() -> &'static Console {
    static C: OnceLock<Console> = OnceLock::new();
    C.get_or_init(|| Console {
        lines: Mutex::new(VecDeque::new()),
        enabled: AtomicBool::new(false),
    })
}

/// Wraps `env_logger`'s logger: every record still prints to stderr
/// exactly as before, and (when the console is enabled) is mirrored
/// into the in-app buffer at the same filter level.
struct TeeLogger {
    inner: env_logger::Logger,
}

impl log::Log for TeeLogger {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        self.inner.enabled(metadata)
    }

    fn log(&self, record: &log::Record) {
        if self.inner.enabled(record.metadata()) {
            console().push(format!("· {:<5} {}", record.level(), record.args()));
        }
        self.inner.log(record);
    }

    fn flush(&self) {
        self.inner.flush();
    }
}

/// Install the tee logger. Honours `RUST_LOG` (default `info`) just
/// like the plain `env_logger` setup it replaces.
pub fn init_logging() {
    let inner =
        env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).build();
    let max = inner.filter();
    if log::set_boxed_logger(Box::new(TeeLogger { inner })).is_ok() {
        log::set_max_level(max);
    }
}
