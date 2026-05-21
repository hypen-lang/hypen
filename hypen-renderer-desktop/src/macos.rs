//! macOS-specific Core Animation layer tweaks.
//!
//! Eliminates the live-resize "flash with diff sizing" by reaching the
//! `CAMetalLayer` that wgpu / `raw-window-metal` set up under the
//! NSView and toggling two properties:
//!
//! - **`presentsWithTransaction = YES`** — the canonical macOS fix.
//!   `[CAMetalDrawable present]` is fire-and-forget by default; with
//!   this flag the present is queued inside the next CATransaction
//!   commit, so AppKit's compositor holds the previous frame's
//!   contents until our new frame is available. Without it, the OS
//!   composites the prior swapchain image stretched to the new window
//!   size during the gap between the resize event and our present.
//! - **`contentsGravity = kCAGravityTopLeft`** — defines what happens
//!   to the layer's existing contents when `bounds` change. Default
//!   `kCAGravityResize` stretches; `TopLeft` pins to the top-left so
//!   any visible artifact is a clean tear of empty space rather than
//!   a stretched image.
//!
//! `raw-window-metal` (which wgpu-hal-metal uses) creates the
//! `CAMetalLayer` as a *sublayer* of the NSView's main `CALayer`
//! [^1] — so we walk the view's layer tree and apply the flags to any
//! sublayer that actually responds as a `CAMetalLayer`. That keeps us
//! safe under non-Metal backends (Vulkan via MoltenVK, etc.) where
//! the layer tree contains no `CAMetalLayer`.
//!
//! Re-applied on every `Gpu::resize` because some wgpu paths
//! reconfigure the surface in a way that re-creates the underlying
//! drawable; the layer pointer itself survives, but it costs nothing
//! to set the flag again and guards against future regressions.
//!
//! [^1]: see `wgpu-hal/src/metal/surface.rs` and the
//! "reasoning-behind-creating-a-sublayer" link inside it.

use objc2::msg_send;
use objc2::runtime::AnyObject;
use objc2_quartz_core::{kCAGravityTopLeft, CAMetalLayer};
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use winit::window::Window;

/// Tighten the CAMetalLayer's resize semantics. Best-effort: silently
/// no-ops on non-AppKit handles (shouldn't happen on macOS) and on
/// non-Metal backends (no `CAMetalLayer` in the sublayer tree).
pub fn configure_window_layer(window: &Window) {
    let Ok(handle) = window.window_handle() else {
        return;
    };
    let RawWindowHandle::AppKit(h) = handle.as_raw() else {
        return;
    };
    let ns_view: *mut AnyObject = h.ns_view.as_ptr().cast();
    if ns_view.is_null() {
        return;
    }
    // Safety: `ns_view` is the live NSView for the winit window; the
    // selectors below are part of NSView / CALayer / CAMetalLayer's
    // public API. We ignore the layer if it isn't a CAMetalLayer.
    unsafe {
        let root_layer: *mut AnyObject = msg_send![ns_view, layer];
        if root_layer.is_null() {
            return;
        }
        apply_flags_recursive(root_layer);
    }
}

/// Walk a CALayer + sublayers, set the present-with-transaction flag
/// on every node that is actually a `CAMetalLayer`. We don't gate on
/// the parent layer's class because raw-window-metal occasionally
/// nests the Metal layer under one or two intermediates.
unsafe fn apply_flags_recursive(layer: *mut AnyObject) {
    if layer.is_null() {
        return;
    }
    // `respondsToSelector:` is the cheapest way to ask "are you a
    // CAMetalLayer?" without importing the full class chain — and it
    // covers any future subclass too. `setPresentsWithTransaction:`
    // is unique to CAMetalLayer.
    let sel = objc2::sel!(setPresentsWithTransaction:);
    let responds: bool = msg_send![layer, respondsToSelector: sel];
    if responds {
        // Promote the raw pointer to a typed CAMetalLayer ref. We
        // don't take ownership (no retain) — the NSView keeps the
        // layer alive for the lifetime of the window.
        let metal_layer: &CAMetalLayer = &*(layer as *const CAMetalLayer);
        metal_layer.setPresentsWithTransaction(true);
        metal_layer.setContentsGravity(kCAGravityTopLeft);
    }
    // Recurse into sublayers regardless — the CAMetalLayer raw-window-metal
    // creates is itself a sublayer of the view's root CALayer.
    let sublayers: *mut AnyObject = msg_send![layer, sublayers];
    if sublayers.is_null() {
        return;
    }
    let count: usize = msg_send![sublayers, count];
    for i in 0..count {
        let child: *mut AnyObject = msg_send![sublayers, objectAtIndex: i];
        apply_flags_recursive(child);
    }
}
