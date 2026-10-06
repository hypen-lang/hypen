//! Where is the OS cursor, in window space? Used only while an OS file drag
//! hovers the window ([`crate::dnd::files`]): winit's `HoveredFile` carries
//! no position and no `CursorMoved` arrives during the drag session on
//! macOS / X11, so the window polls this instead.
//!
//! Returns physical px relative to the window's content area (the same
//! space as winit's `CursorMoved`), or `None` when the platform can't tell
//! — the caller then falls back to "the only files zone, or none".

use winit::window::Window;

/// macOS: `-[NSWindow mouseLocationOutsideOfEventStream]` (the live pointer,
/// independent of the event stream the drag session owns), converted into
/// winit's flipped content view exactly as winit's own `mouse_motion` does.
#[cfg(target_os = "macos")]
pub(crate) fn cursor_in_window(window: &Window) -> Option<(f64, f64)> {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    use objc2_foundation::NSPoint;
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};

    let handle = window.window_handle().ok()?;
    let RawWindowHandle::AppKit(h) = handle.as_raw() else {
        return None;
    };
    let view: *mut AnyObject = h.ns_view.as_ptr().cast();
    if view.is_null() {
        return None;
    }
    // Safety: `view` is winit's live NSView (main thread — the caller runs
    // in the event loop); every selector is public AppKit API.
    let point = unsafe {
        let ns_window: *mut AnyObject = msg_send![view, window];
        if ns_window.is_null() {
            return None;
        }
        let in_window: NSPoint = msg_send![ns_window, mouseLocationOutsideOfEventStream];
        let nil: *mut AnyObject = std::ptr::null_mut();
        let in_view: NSPoint = msg_send![view, convertPoint: in_window, fromView: nil];
        in_view
    };
    if !point.x.is_finite() || !point.y.is_finite() {
        return None;
    }
    let scale = window.scale_factor();
    Some((point.x * scale, point.y * scale))
}

/// Windows: `GetCursorPos` + `ScreenToClient` (physical px; winit makes the
/// process per-monitor DPI aware, so client px are winit's physical px).
#[cfg(target_os = "windows")]
pub(crate) fn cursor_in_window(window: &Window) -> Option<(f64, f64)> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};

    #[repr(C)]
    struct Point {
        x: i32,
        y: i32,
    }
    #[link(name = "user32")]
    extern "system" {
        fn GetCursorPos(point: *mut Point) -> i32;
        fn ScreenToClient(hwnd: isize, point: *mut Point) -> i32;
    }

    let handle = window.window_handle().ok()?;
    let RawWindowHandle::Win32(h) = handle.as_raw() else {
        return None;
    };
    let mut p = Point { x: 0, y: 0 };
    // Safety: plain Win32 calls on a valid out-pointer and the live HWND.
    unsafe {
        if GetCursorPos(&mut p) == 0 || ScreenToClient(h.hwnd.get(), &mut p) == 0 {
            return None;
        }
    }
    Some((p.x as f64, p.y as f64))
}

/// Linux (X11 / Wayland) and the rest: unknown. X11 grabs the pointer for
/// the drag (no motion reaches us) and winit drops the `XdndPosition`
/// coordinates; Wayland winit has no file DnD at all.
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub(crate) fn cursor_in_window(_window: &Window) -> Option<(f64, f64)> {
    None
}
