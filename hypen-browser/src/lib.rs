//! Hypen Browser — a native desktop browser for Hypen apps.
//!
//! Wraps the Hypen desktop renderer in a single window that hosts:
//!
//! * A locally-defined Hypen module (the "shell") that renders the
//!   home screen and a floating iOS-style island for the address bar.
//! * An optional `RemoteModule` that streams patches from a
//!   `RemoteServer` over WebSocket once the user opens a URL.
//!
//! The two engines are merged inside [`browser::BrowserModule`] before
//! reaching the renderer — see that module's docs for the routing
//! rules.
//!
//! ## Run
//!
//! ```bash
//! cargo run -p hypen-browser
//! ```
//!
//! Type a Hypen WebSocket URL (e.g. `ws://localhost:3000`) into the
//! address bar and press **Open**, or click any tile under "Last
//! opened" to reopen a saved app. The island collapses to a small
//! chip when the app is loaded; click the chip to expand the address
//! bar again.

pub mod browser;
pub mod chrome;
pub mod devlog;
pub mod embed;
pub mod shell;
pub mod storage;

pub use browser::BrowserModule;
pub use devlog::init_logging;
pub use storage::{normalize_url, pretty_name, RecentApp, Storage};

/// Test-only allocation meter: counts the bytes the CURRENT thread
/// allocates, so a test can pin "this step copies nothing" (see
/// `browser::tests::shadow_tree_copies_no_prop_value`). Thread-local, so
/// the other tests running in parallel never disturb a measurement.
#[cfg(test)]
pub(crate) mod alloc_meter {
    use std::alloc::{GlobalAlloc, Layout, System};
    use std::cell::Cell;

    thread_local! {
        static ALLOCATED: Cell<usize> = const { Cell::new(0) };
    }

    pub(crate) struct Meter;

    // SAFETY: forwards every call to `System`; only adds a thread-local
    // counter update (const-initialised, so it never allocates).
    unsafe impl GlobalAlloc for Meter {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            let _ = ALLOCATED.try_with(|a| a.set(a.get() + layout.size()));
            unsafe { System.alloc(layout) }
        }
        unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
            unsafe { System.dealloc(ptr, layout) }
        }
        unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
            let _ = ALLOCATED.try_with(|a| a.set(a.get() + layout.size()));
            unsafe { System.alloc_zeroed(layout) }
        }
        unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
            let _ = ALLOCATED.try_with(|a| a.set(a.get() + new_size));
            unsafe { System.realloc(ptr, layout, new_size) }
        }
    }

    #[global_allocator]
    static METER: Meter = Meter;

    /// Bytes the current thread allocated while running `f`.
    pub(crate) fn allocated_during<T>(f: impl FnOnce() -> T) -> (T, usize) {
        let before = ALLOCATED.with(Cell::get);
        let out = f();
        (out, ALLOCATED.with(Cell::get) - before)
    }
}
