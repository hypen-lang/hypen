//! WASI C ABI for the device broker (RFC 001) — `hypen_device_*`.
//!
//! Used by the Go SDK through wazero (and by any other WASI host). The
//! broker is the sans-IO [`crate::device::DeviceBroker`]; this file only
//! moves bytes across the ABI. JSON shapes (config, open spec, outputs,
//! info) are documented in [`super::device_binding`] and shared with the JS
//! and UniFFI surfaces.
//!
//! # Conventions
//!
//! - Strings and byte runs are `(ptr, len)` pairs in linear memory
//!   (allocate with `wasi_alloc`, free with `wasi_free`). A zero `len` needs
//!   no valid pointer.
//! - Brokers and retained-bytes pools are opaque `u32` handles, never 0 and
//!   never reused within an instance.
//! - Times are monotonic milliseconds (`u64`); a host feeds the same clock
//!   to every call of one broker.
//! - Return values: `i32` statuses are `0` (ok) or a negative error;
//!   boolean answers are `1`/`0`; `i64` answers use `-1` for "none"
//!   (no deadline, no such id). Errors are always `<= -2`:
//!   [`ERR_HANDLE`] (unknown handle), [`ERR_INPUT`] (null pointer or invalid
//!   UTF-8 where text is required), [`ERR_JSON`] (malformed config/spec
//!   JSON). The message is in `hypen_device_last_error`.
//! - Results with a body (open/start, poll, info, handshake helpers) are
//!   written to the device result buffer: read `hypen_device_result_len`,
//!   then copy with `hypen_device_result`. The buffer is overwritten by the
//!   next call that produces a result.
//! - `hypen_device_broker_poll` writes the framed output encoding of
//!   [`super::device_binding::encode_framed`]:
//!   `[u32 LE header_len][JSON array][payload bytes]`, where byte-carrying
//!   outputs reference the payload section through `offset`/`len`.
//! - Incoming device text that is not valid UTF-8 cannot be a device
//!   message: `on_text` counts it as a connection-level violation (D4) and
//!   returns `0`.

use std::cell::RefCell;
use std::collections::HashMap;

use serde::Deserialize;
use serde_json::Value;

use crate::device::{
    file_save_params, is_oversize_device_text, sha256_hex, DeviceBroker, RetainedBytesPool,
};
use crate::serialize::device::CapabilityOffer;

use super::device_binding as db;

/// Unknown broker or pool handle.
pub const ERR_HANDLE: i32 = -2;
/// Null pointer with a nonzero length, or invalid UTF-8 where text is required.
pub const ERR_INPUT: i32 = -3;
/// Malformed configuration / open spec / server JSON.
pub const ERR_JSON: i32 = -4;

#[derive(Default)]
struct Tables {
    /// Owned brokers: removing one (destroy) closes it and returns its
    /// pooled bytes ([`db::OwnedBroker`]).
    brokers: HashMap<u32, db::OwnedBroker>,
    pools: HashMap<u32, RetainedBytesPool>,
    next_handle: u32,
}

impl Tables {
    fn handle(&mut self) -> u32 {
        self.next_handle = self.next_handle.wrapping_add(1).max(1);
        while self.brokers.contains_key(&self.next_handle)
            || self.pools.contains_key(&self.next_handle)
        {
            self.next_handle = self.next_handle.wrapping_add(1).max(1);
        }
        self.next_handle
    }
}

thread_local! {
    static TABLES: RefCell<Tables> = RefCell::new(Tables::default());
    static RESULT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static ERROR: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

fn set_error(msg: &str) {
    ERROR.with(|e| *e.borrow_mut() = msg.as_bytes().to_vec());
}

fn fail(code: i32, msg: &str) -> i32 {
    set_error(msg);
    code
}

fn set_result(bytes: Vec<u8>) {
    RESULT.with(|r| *r.borrow_mut() = bytes);
}

fn set_json(v: &Value) {
    set_result(v.to_string().into_bytes());
}

/// Run `f` on broker `h`, or report [`ERR_HANDLE`].
fn with_broker<R>(h: u32, err: R, f: impl FnOnce(&mut DeviceBroker) -> R) -> R {
    TABLES.with(|t| match t.borrow_mut().brokers.get_mut(&h) {
        Some(b) => f(b),
        None => {
            set_error(&format!("unknown device broker handle {h}"));
            err
        }
    })
}

/// # Safety
/// `ptr` must be valid for `len` bytes when `len > 0`.
unsafe fn bytes<'a>(ptr: *const u8, len: usize) -> Option<&'a [u8]> {
    if len == 0 {
        return Some(&[]);
    }
    if ptr.is_null() {
        return None;
    }
    Some(std::slice::from_raw_parts(ptr, len))
}

/// # Safety
/// As [`bytes`].
unsafe fn text<'a>(ptr: *const u8, len: usize, what: &str) -> Result<&'a str, i32> {
    let b = bytes(ptr, len).ok_or_else(|| fail(ERR_INPUT, &format!("{what}: null pointer")))?;
    std::str::from_utf8(b).map_err(|_| fail(ERR_INPUT, &format!("{what}: invalid UTF-8")))
}

fn copy_out(src: &[u8], out_ptr: *mut u8, out_len: usize) -> usize {
    let n = src.len().min(out_len);
    if n > 0 && !out_ptr.is_null() {
        // SAFETY: the host guarantees `out_ptr` is valid for `out_len` bytes.
        unsafe { std::ptr::copy_nonoverlapping(src.as_ptr(), out_ptr, n) };
    }
    n
}

fn opt_i64(v: Option<u64>) -> i64 {
    v.map_or(-1, |x| x.min(i64::MAX as u64) as i64)
}

// ---------------------------------------------------------------------------
// Result and error buffers
// ---------------------------------------------------------------------------

/// Byte length of the device result buffer.
#[no_mangle]
pub extern "C" fn hypen_device_result_len() -> usize {
    RESULT.with(|r| r.borrow().len())
}

/// Copy the device result buffer into `out_ptr` (at most `out_len` bytes);
/// returns the bytes copied.
#[no_mangle]
pub extern "C" fn hypen_device_result(out_ptr: *mut u8, out_len: usize) -> usize {
    RESULT.with(|r| copy_out(&r.borrow(), out_ptr, out_len))
}

/// Byte length of the last device error message (0 = none).
#[no_mangle]
pub extern "C" fn hypen_device_last_error_len() -> usize {
    ERROR.with(|e| e.borrow().len())
}

/// Copy the last device error message (UTF-8); returns the bytes copied.
#[no_mangle]
pub extern "C" fn hypen_device_last_error(out_ptr: *mut u8, out_len: usize) -> usize {
    ERROR.with(|e| copy_out(&e.borrow(), out_ptr, out_len))
}

// ---------------------------------------------------------------------------
// Retained-bytes pools (aggregate budget shared by several brokers)
// ---------------------------------------------------------------------------

/// Create an aggregate retained-bytes pool of `limit` bytes; returns its
/// handle. Pass it to `hypen_device_broker_create` for every connection
/// that shares the budget (a process, a Durable Object).
#[no_mangle]
pub extern "C" fn hypen_device_pool_create(limit: u64) -> u32 {
    TABLES.with(|t| {
        let mut t = t.borrow_mut();
        let h = t.handle();
        t.pools.insert(h, RetainedBytesPool::new(limit));
        h
    })
}

/// Drop the host's reference to a pool (brokers created with it keep
/// sharing it). Returns 0 or [`ERR_HANDLE`].
#[no_mangle]
pub extern "C" fn hypen_device_pool_destroy(pool: u32) -> i32 {
    TABLES.with(|t| match t.borrow_mut().pools.remove(&pool) {
        Some(_) => 0,
        None => fail(ERR_HANDLE, &format!("unknown device pool handle {pool}")),
    })
}

/// Bytes currently reserved in the pool, or [`ERR_HANDLE`].
#[no_mangle]
pub extern "C" fn hypen_device_pool_in_use(pool: u32) -> i64 {
    TABLES.with(|t| match t.borrow().pools.get(&pool) {
        Some(p) => p.in_use().min(i64::MAX as u64) as i64,
        None => fail(ERR_HANDLE, &format!("unknown device pool handle {pool}")) as i64,
    })
}

// ---------------------------------------------------------------------------
// Broker lifecycle
// ---------------------------------------------------------------------------

/// Create a broker from the configuration JSON (see `device_binding`),
/// sharing pool `pool` (0 = none). Returns the handle, or 0 on error.
///
/// # Safety
/// `config_ptr` must be valid for `config_len` bytes.
#[no_mangle]
pub unsafe extern "C" fn hypen_device_broker_create(
    config_ptr: *const u8,
    config_len: usize,
    pool: u32,
    now_ms: u64,
) -> u32 {
    let Ok(config) = text(config_ptr, config_len, "broker config") else {
        return 0;
    };
    TABLES.with(|t| {
        let mut t = t.borrow_mut();
        let pool = if pool == 0 {
            None
        } else {
            match t.pools.get(&pool) {
                Some(p) => Some(p.clone()),
                None => {
                    set_error(&format!("unknown device pool handle {pool}"));
                    return 0;
                }
            }
        };
        match db::parse_config(config, pool) {
            Ok(cfg) => {
                let h = t.handle();
                t.brokers.insert(h, db::OwnedBroker::new(cfg, now_ms));
                h
            }
            Err(e) => {
                set_error(&e);
                0
            }
        }
    })
}

/// Destroy a broker. A broker the host did not close is closed with
/// `connectionLost` first ([`db::OwnedBroker`]), so live requests settle
/// and every pooled byte returns even when the host skipped
/// `hypen_device_broker_close`. Returns 0 or [`ERR_HANDLE`].
#[no_mangle]
pub extern "C" fn hypen_device_broker_destroy(h: u32) -> i32 {
    // Take the broker out before dropping it, so the table borrow is not
    // held while it closes.
    let removed = TABLES.with(|t| t.borrow_mut().brokers.remove(&h));
    match removed {
        Some(b) => {
            drop(b);
            0
        }
        None => fail(ERR_HANDLE, &format!("unknown device broker handle {h}")),
    }
}

/// Open the connection-owned `core.capabilities` stream. Result buffer:
/// `{"id": n}` or `{"error": {...}}`. Returns 0 or [`ERR_HANDLE`].
#[no_mangle]
pub extern "C" fn hypen_device_broker_start(h: u32, now_ms: u64) -> i32 {
    with_broker(h, ERR_HANDLE, |b| {
        set_json(&db::open_result_json(b.start(now_ms)));
        0
    })
}

/// Open a request from the open JSON; `has_download != 0` attaches the
/// `(dl_ptr, dl_len)` bytes (`file.save`, possibly empty). Result buffer:
/// `{"id": n}` or `{"error": {"code", "detail"?}}` (a local refusal).
/// Returns 0, [`ERR_HANDLE`], [`ERR_INPUT`] or [`ERR_JSON`].
///
/// # Safety
/// Each pointer must be valid for its length.
#[no_mangle]
pub unsafe extern "C" fn hypen_device_broker_open(
    h: u32,
    spec_ptr: *const u8,
    spec_len: usize,
    dl_ptr: *const u8,
    dl_len: usize,
    has_download: i32,
    now_ms: u64,
) -> i32 {
    let spec = match text(spec_ptr, spec_len, "open spec") {
        Ok(s) => s,
        Err(code) => return code,
    };
    let download = if has_download != 0 {
        match bytes(dl_ptr, dl_len) {
            Some(b) => Some(b.to_vec()),
            None => return fail(ERR_INPUT, "download: null pointer"),
        }
    } else {
        None
    };
    let spec = match db::parse_open_spec(spec, download) {
        Ok(s) => s,
        Err(e) => return fail(ERR_JSON, &e),
    };
    with_broker(h, ERR_HANDLE, |b| {
        set_json(&db::open_result_json(b.open(spec, now_ms)));
        0
    })
}

/// Server-initiated cancel of request `id`. Returns 0 or [`ERR_HANDLE`].
#[no_mangle]
pub extern "C" fn hypen_device_broker_cancel(h: u32, id: u32, now_ms: u64) -> i32 {
    with_broker(h, ERR_HANDLE, |b| {
        b.cancel(id, now_ms);
        0
    })
}

/// Release a held result's retained-bytes charge.
#[no_mangle]
pub extern "C" fn hypen_device_broker_release_result(h: u32, id: u32) -> i32 {
    with_broker(h, ERR_HANDLE, |b| {
        b.release_result(id);
        0
    })
}

/// The consumer finished `n` JSON events of stream `id`.
#[no_mangle]
pub extern "C" fn hypen_device_broker_consumed_events(h: u32, id: u32, n: u64, now_ms: u64) -> i32 {
    with_broker(h, ERR_HANDLE, |b| {
        b.consumed_events(id, n, now_ms);
        0
    })
}

/// The consumer finished the next `chunks` data chunks of stream `id`.
#[no_mangle]
pub extern "C" fn hypen_device_broker_consumed_data(
    h: u32,
    id: u32,
    chunks: u32,
    now_ms: u64,
) -> i32 {
    with_broker(h, ERR_HANDLE, |b| {
        b.consumed_data(id, chunks as usize, now_ms);
        0
    })
}

/// A module instance became active as `activation_id`. Returns 1 when
/// recorded, 0 for a stale activation, or an error.
///
/// # Safety
/// `mid_ptr` must be valid for `mid_len` bytes.
#[no_mangle]
pub unsafe extern "C" fn hypen_device_broker_owner_activated(
    h: u32,
    mid_ptr: *const u8,
    mid_len: usize,
    activation_id: u32,
    now_ms: u64,
) -> i32 {
    let mid = match text(mid_ptr, mid_len, "moduleInstanceId") {
        Ok(s) => s,
        Err(code) => return code,
    };
    with_broker(h, ERR_HANDLE, |b| {
        b.owner_activated(mid, activation_id, now_ms) as i32
    })
}

/// The activation ended: its activation-owned work is cancelled.
///
/// # Safety
/// `mid_ptr` must be valid for `mid_len` bytes.
#[no_mangle]
pub unsafe extern "C" fn hypen_device_broker_owner_deactivated(
    h: u32,
    mid_ptr: *const u8,
    mid_len: usize,
    activation_id: u32,
    now_ms: u64,
) -> i32 {
    let mid = match text(mid_ptr, mid_len, "moduleInstanceId") {
        Ok(s) => s,
        Err(code) => return code,
    };
    with_broker(h, ERR_HANDLE, |b| {
        b.owner_deactivated(mid, activation_id, now_ms);
        0
    })
}

/// The module instance was destroyed: all of its work is cancelled.
///
/// # Safety
/// `mid_ptr` must be valid for `mid_len` bytes.
#[no_mangle]
pub unsafe extern "C" fn hypen_device_broker_owner_destroyed(
    h: u32,
    mid_ptr: *const u8,
    mid_len: usize,
    now_ms: u64,
) -> i32 {
    let mid = match text(mid_ptr, mid_len, "moduleInstanceId") {
        Ok(s) => s,
        Err(code) => return code,
    };
    with_broker(h, ERR_HANDLE, |b| {
        b.owner_destroyed(mid, now_ms);
        0
    })
}

/// Feed one client → server device text message. Returns 1 when it was
/// for a live request, 0 otherwise (including invalid UTF-8, which counts
/// as a connection-level violation), or an error.
///
/// # Safety
/// `ptr` must be valid for `len` bytes.
#[no_mangle]
pub unsafe extern "C" fn hypen_device_broker_on_text(
    h: u32,
    ptr: *const u8,
    len: usize,
    now_ms: u64,
) -> i32 {
    let Some(raw) = bytes(ptr, len) else {
        return fail(ERR_INPUT, "device text: null pointer");
    };
    with_broker(h, ERR_HANDLE, |b| match std::str::from_utf8(raw) {
        Ok(s) => b.on_text(s, now_ms) as i32,
        Err(_) => {
            b.report_connection_violation("device text is not valid UTF-8", now_ms);
            0
        }
    })
}

/// Feed one client → server binary frame. Returns 1 when accepted, 0 when
/// not, or an error.
///
/// # Safety
/// `ptr` must be valid for `len` bytes.
#[no_mangle]
pub unsafe extern "C" fn hypen_device_broker_on_frame(
    h: u32,
    ptr: *const u8,
    len: usize,
    now_ms: u64,
) -> i32 {
    let Some(frame) = bytes(ptr, len) else {
        return fail(ERR_INPUT, "device frame: null pointer");
    };
    with_broker(h, ERR_HANDLE, |b| b.on_frame(frame, now_ms) as i32)
}

/// Count a connection-level violation the host detected itself (e.g.
/// over-limit device text it refused to parse).
///
/// # Safety
/// `ptr` must be valid for `len` bytes.
#[no_mangle]
pub unsafe extern "C" fn hypen_device_broker_report_violation(
    h: u32,
    ptr: *const u8,
    len: usize,
    now_ms: u64,
) -> i32 {
    let reason = match text(ptr, len, "violation reason") {
        Ok(s) => s,
        Err(code) => return code,
    };
    with_broker(h, ERR_HANDLE, |b| {
        b.report_connection_violation(reason, now_ms);
        0
    })
}

/// Run due timers; returns the next deadline (absolute ms), -1 for none,
/// or [`ERR_HANDLE`].
#[no_mangle]
pub extern "C" fn hypen_device_broker_tick(h: u32, now_ms: u64) -> i64 {
    with_broker(h, ERR_HANDLE as i64, |b| opt_i64(b.tick(now_ms)))
}

/// The next deadline without running anything (-1 = none).
#[no_mangle]
pub extern "C" fn hypen_device_broker_next_deadline(h: u32) -> i64 {
    with_broker(h, ERR_HANDLE as i64, |b| opt_i64(b.next_deadline()))
}

/// Report the transport's buffered (accepted, unwritten) bytes.
#[no_mangle]
pub extern "C" fn hypen_device_broker_set_transport_buffered(h: u32, bytes: u64) -> i32 {
    with_broker(h, ERR_HANDLE, |b| {
        b.set_transport_buffered(bytes.min(usize::MAX as u64) as usize);
        0
    })
}

/// Drain the broker's outputs into the result buffer (framed encoding).
/// Returns the number of outputs, or [`ERR_HANDLE`].
#[no_mangle]
pub extern "C" fn hypen_device_broker_poll(h: u32) -> i32 {
    with_broker(h, ERR_HANDLE, |b| {
        let outputs = b.poll();
        let n = outputs.len().min(i32::MAX as usize) as i32;
        set_result(db::encode_framed(outputs));
        n
    })
}

/// Close the device plane locally: every live request settles with `code`
/// (a wire error code such as `connectionLost`); nothing is sent.
///
/// # Safety
/// `code_ptr` must be valid for `code_len` bytes.
#[no_mangle]
pub unsafe extern "C" fn hypen_device_broker_close(
    h: u32,
    code_ptr: *const u8,
    code_len: usize,
) -> i32 {
    let code = match text(code_ptr, code_len, "error code") {
        Ok(s) => s,
        Err(code) => return code,
    };
    let code = match db::parse_error_code(code) {
        Ok(c) => c,
        Err(e) => return fail(ERR_JSON, &e),
    };
    with_broker(h, ERR_HANDLE, |b| {
        b.close(code);
        0
    })
}

/// Planned reopen of `core.capabilities`: the new stream id, -1 when not
/// reopened, or [`ERR_HANDLE`].
#[no_mangle]
pub extern "C" fn hypen_device_broker_reopen_core(h: u32, now_ms: u64) -> i64 {
    with_broker(h, ERR_HANDLE as i64, |b| {
        opt_i64(b.reopen_core_capabilities(now_ms).map(u64::from))
    })
}

/// Write the broker snapshot JSON (`device_binding::info_json`) to the
/// result buffer.
#[no_mangle]
pub extern "C" fn hypen_device_broker_info(h: u32) -> i32 {
    with_broker(h, ERR_HANDLE, |b| {
        set_json(&db::info_json(b));
        0
    })
}

/// 1 when request `id` is live.
#[no_mangle]
pub extern "C" fn hypen_device_broker_is_live(h: u32, id: u32) -> i32 {
    with_broker(h, ERR_HANDLE, |b| b.is_live(id) as i32)
}

/// 1 when capability `name` is in the live selection.
///
/// # Safety
/// `ptr` must be valid for `len` bytes.
#[no_mangle]
pub unsafe extern "C" fn hypen_device_broker_supports(h: u32, ptr: *const u8, len: usize) -> i32 {
    let name = match text(ptr, len, "capability") {
        Ok(s) => s,
        Err(code) => return code,
    };
    with_broker(h, ERR_HANDLE, |b| b.supports(name) as i32)
}

/// The live selection's revision of `name`, or -1.
///
/// # Safety
/// `ptr` must be valid for `len` bytes.
#[no_mangle]
pub unsafe extern "C" fn hypen_device_broker_selected_version(
    h: u32,
    ptr: *const u8,
    len: usize,
) -> i64 {
    let name = match text(ptr, len, "capability") {
        Ok(s) => s,
        Err(code) => return code as i64,
    };
    with_broker(h, ERR_HANDLE as i64, |b| {
        opt_i64(b.selected_version(name).map(u64::from))
    })
}

/// Outstanding upload/download credit of `id`, or -1.
#[no_mangle]
pub extern "C" fn hypen_device_broker_outstanding_credit(h: u32, id: u32) -> i64 {
    with_broker(h, ERR_HANDLE as i64, |b| opt_i64(b.outstanding_credit(id)))
}

/// Outstanding JSON event credit of `id`, or -1.
#[no_mangle]
pub extern "C" fn hypen_device_broker_outstanding_event_credit(h: u32, id: u32) -> i64 {
    with_broker(h, ERR_HANDLE as i64, |b| {
        opt_i64(b.outstanding_event_credit(id))
    })
}

/// 1 when the module instance owns live background work.
///
/// # Safety
/// `mid_ptr` must be valid for `mid_len` bytes.
#[no_mangle]
pub unsafe extern "C" fn hypen_device_broker_has_background_work(
    h: u32,
    mid_ptr: *const u8,
    mid_len: usize,
) -> i32 {
    let mid = match text(mid_ptr, mid_len, "moduleInstanceId") {
        Ok(s) => s,
        Err(code) => return code,
    };
    with_broker(h, ERR_HANDLE, |b| b.has_background_work(mid) as i32)
}

/// 1 when a new background request from the module fits the pin cap.
///
/// # Safety
/// `mid_ptr` must be valid for `mid_len` bytes.
#[no_mangle]
pub unsafe extern "C" fn hypen_device_broker_admits_background(
    h: u32,
    mid_ptr: *const u8,
    mid_len: usize,
) -> i32 {
    let mid = match text(mid_ptr, mid_len, "moduleInstanceId") {
        Ok(s) => s,
        Err(code) => return code,
    };
    with_broker(h, ERR_HANDLE, |b| b.admits_background(mid) as i32)
}

/// 1 when `(module, activation_id)` is the module's live activation.
///
/// # Safety
/// `mid_ptr` must be valid for `mid_len` bytes.
#[no_mangle]
pub unsafe extern "C" fn hypen_device_broker_owner_is_active(
    h: u32,
    mid_ptr: *const u8,
    mid_len: usize,
    activation_id: u32,
) -> i32 {
    let mid = match text(mid_ptr, mid_len, "moduleInstanceId") {
        Ok(s) => s,
        Err(code) => return code,
    };
    with_broker(h, ERR_HANDLE, |b| {
        b.owner_is_active(mid, activation_id) as i32
    })
}

/// The revision the broker enforces for `capability@version`
/// (`device_binding::revision_json`: registry revision or its configured
/// override, `maxItemBytes` capped) in the result buffer; the buffer holds
/// `null` when it is not a registry revision.
///
/// # Safety
/// `ptr` must be valid for `len` bytes.
#[no_mangle]
pub unsafe extern "C" fn hypen_device_broker_revision(
    h: u32,
    ptr: *const u8,
    len: usize,
    version: u32,
) -> i32 {
    let name = match text(ptr, len, "capability") {
        Ok(s) => s,
        Err(code) => return code,
    };
    with_broker(h, ERR_HANDLE, |b| {
        set_json(&db::revision_json(b, name, version));
        0
    })
}

// ---------------------------------------------------------------------------
// Handshake and helpers (no broker needed)
// ---------------------------------------------------------------------------

/// 1 when a broker-backed server has a consuming API for the capability
/// revision JSON at `(ptr, len)` (needs `mode` and `data`, e.g. a
/// `hypen_device_broker_revision` answer), 0 when it does not, or
/// [`ERR_JSON`] when `mode`/`data` is missing or unknown.
///
/// # Safety
/// `ptr` must be valid for `len` bytes.
#[no_mangle]
pub unsafe extern "C" fn hypen_device_server_consumes(ptr: *const u8, len: usize) -> i32 {
    let revision = match text(ptr, len, "capability revision") {
        Ok(s) => s,
        Err(code) => return code,
    };
    match db::server_consumes_json(revision) {
        Ok(v) => v as i32,
        Err(e) => fail(ERR_JSON, &e),
    }
}

/// `hello.device` JSON → `sessionAck.device` JSON (or `null`: device
/// disabled) in the result buffer, for a server advertising every
/// capability the broker consumes. `binary_route != 0` when the transport
/// carries binary frames.
///
/// # Safety
/// `ptr` must be valid for `len` bytes.
#[no_mangle]
pub unsafe extern "C" fn hypen_device_negotiate(
    ptr: *const u8,
    len: usize,
    binary_route: i32,
) -> i32 {
    let hello = match text(ptr, len, "hello.device") {
        Ok(s) => s,
        Err(code) => return code,
    };
    set_json(&db::negotiate_json(hello, binary_route != 0));
    0
}

/// The whole server-side handshake for raw `hello.device` JSON (strict
/// validation + selection, `device_binding::handshake_json`): the result
/// buffer holds `{"ack": <sessionAck.device>}` or `{"ack": null, "reason":
/// "…"}`. `caps_len == 0` (any `caps_ptr`) advertises every capability the
/// broker consumes; otherwise `caps` is a `[{name, versions}]` JSON array.
/// `binary_route != 0` when the transport carries binary frames.
///
/// # Safety
/// Each pointer must be valid for its length.
#[no_mangle]
pub unsafe extern "C" fn hypen_device_handshake(
    hello_ptr: *const u8,
    hello_len: usize,
    binary_route: i32,
    caps_ptr: *const u8,
    caps_len: usize,
) -> i32 {
    let hello = match text(hello_ptr, hello_len, "hello.device") {
        Ok(s) => s,
        Err(code) => return code,
    };
    let caps = if caps_len == 0 {
        None
    } else {
        match text(caps_ptr, caps_len, "server capabilities") {
            Ok(s) => Some(s),
            Err(code) => return code,
        }
    };
    match db::handshake_json(hello, binary_route != 0, caps) {
        Ok(v) => {
            set_json(&v);
            0
        }
        Err(e) => fail(ERR_JSON, &e),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ServerSide {
    protocol_versions: Vec<u32>,
    capabilities: Vec<CapabilityOffer>,
    binary: bool,
}

/// `select_device_ack` with explicit server lists:
/// `server = {"protocolVersions": [1], "capabilities": [{name, versions}],
/// "binary": true}`. Result buffer: the ack JSON or `null`.
///
/// # Safety
/// Each pointer must be valid for its length.
#[no_mangle]
pub unsafe extern "C" fn hypen_device_select_ack(
    hello_ptr: *const u8,
    hello_len: usize,
    server_ptr: *const u8,
    server_len: usize,
) -> i32 {
    let hello = match text(hello_ptr, hello_len, "hello.device") {
        Ok(s) => s,
        Err(code) => return code,
    };
    let server = match text(server_ptr, server_len, "server selection input") {
        Ok(s) => s,
        Err(code) => return code,
    };
    let server: ServerSide = match serde_json::from_str(server) {
        Ok(s) => s,
        Err(e) => return fail(ERR_JSON, &format!("invalid server selection input: {e}")),
    };
    let caps = match serde_json::to_string(&server.capabilities) {
        Ok(s) => s,
        Err(e) => return fail(ERR_JSON, &e.to_string()),
    };
    match db::select_ack_json(hello, &server.protocol_versions, &caps, server.binary) {
        Ok(v) => {
            set_json(&v);
            0
        }
        Err(e) => fail(ERR_JSON, &e),
    }
}

/// Strictly decode `hello.device`; result buffer:
/// `{"ok": true, "value": …}` or `{"ok": false, "error": "…"}`.
///
/// # Safety
/// `ptr` must be valid for `len` bytes.
#[no_mangle]
pub unsafe extern "C" fn hypen_device_validate_hello(ptr: *const u8, len: usize) -> i32 {
    match text(ptr, len, "hello.device") {
        Ok(s) => {
            set_json(&db::validate_hello_json(s));
            0
        }
        Err(code) => code,
    }
}

/// Strictly decode `sessionAck.device` (same result shape).
///
/// # Safety
/// `ptr` must be valid for `len` bytes.
#[no_mangle]
pub unsafe extern "C" fn hypen_device_validate_ack(ptr: *const u8, len: usize) -> i32 {
    match text(ptr, len, "sessionAck.device") {
        Ok(s) => {
            set_json(&db::validate_ack_json(s));
            0
        }
        Err(code) => code,
    }
}

/// The broker-backed server advertisement JSON in the result buffer.
#[no_mangle]
pub extern "C" fn hypen_device_server_advertisement() -> i32 {
    set_json(&db::server_advertisement_json());
    0
}

/// Protocol/broker constants JSON in the result buffer.
#[no_mangle]
pub extern "C" fn hypen_device_constants() -> i32 {
    set_json(&db::constants_json());
    0
}

/// 1 when `text` is device text over the size limit (decided without
/// parsing): feed it to `report_violation` instead of parsing it. Bytes
/// that are not valid UTF-8 answer 0 (they are not decided here).
///
/// # Safety
/// `ptr` must be valid for `len` bytes.
#[no_mangle]
pub unsafe extern "C" fn hypen_device_is_oversize_text(ptr: *const u8, len: usize) -> i32 {
    match bytes(ptr, len) {
        Some(b) => std::str::from_utf8(b).is_ok_and(is_oversize_device_text) as i32,
        None => fail(ERR_INPUT, "device text: null pointer"),
    }
}

/// The `file.save@1` announcement params JSON for `bytes`.
///
/// # Safety
/// Each pointer must be valid for its length.
#[no_mangle]
pub unsafe extern "C" fn hypen_device_file_save_params(
    name_ptr: *const u8,
    name_len: usize,
    ct_ptr: *const u8,
    ct_len: usize,
    bytes_ptr: *const u8,
    bytes_len: usize,
) -> i32 {
    let name = match text(name_ptr, name_len, "name") {
        Ok(s) => s,
        Err(code) => return code,
    };
    let content_type = match text(ct_ptr, ct_len, "contentType") {
        Ok(s) => s,
        Err(code) => return code,
    };
    let Some(data) = bytes(bytes_ptr, bytes_len) else {
        return fail(ERR_INPUT, "bytes: null pointer");
    };
    set_json(&file_save_params(name, content_type, data));
    0
}

/// Lowercase hex SHA-256 of the bytes (as text) in the result buffer.
///
/// # Safety
/// `ptr` must be valid for `len` bytes.
#[no_mangle]
pub unsafe extern "C" fn hypen_device_sha256_hex(ptr: *const u8, len: usize) -> i32 {
    let Some(data) = bytes(ptr, len) else {
        return fail(ERR_INPUT, "bytes: null pointer");
    };
    set_result(sha256_hex(data).into_bytes());
    0
}

// ---------------------------------------------------------------------------
// Tests: the ABI exercised exactly as a host drives it
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wasm::device_binding::tests::{frame, full_ack_json};
    use serde_json::json;

    fn result() -> Vec<u8> {
        let mut out = vec![0u8; hypen_device_result_len()];
        let n = hypen_device_result(out.as_mut_ptr(), out.len());
        out.truncate(n);
        out
    }

    fn result_json() -> Value {
        serde_json::from_slice(&result()).unwrap()
    }

    fn last_error() -> String {
        let mut out = vec![0u8; hypen_device_last_error_len()];
        let n = hypen_device_last_error(out.as_mut_ptr(), out.len());
        out.truncate(n);
        String::from_utf8(out).unwrap()
    }

    fn create(config: &Value, pool: u32) -> u32 {
        let c = config.to_string();
        unsafe { hypen_device_broker_create(c.as_ptr(), c.len(), pool, 0) }
    }

    fn open(h: u32, spec: &Value, download: Option<&[u8]>, now: u64) -> Value {
        let s = spec.to_string();
        let (p, l, has) = match download {
            Some(d) => (d.as_ptr(), d.len(), 1),
            None => (std::ptr::null(), 0, 0),
        };
        let rc = unsafe { hypen_device_broker_open(h, s.as_ptr(), s.len(), p, l, has, now) };
        assert_eq!(rc, 0, "{}", last_error());
        result_json()
    }

    fn on_text(h: u32, v: &Value, now: u64) -> i32 {
        let s = v.to_string();
        unsafe { hypen_device_broker_on_text(h, s.as_ptr(), s.len(), now) }
    }

    fn on_frame(h: u32, f: &[u8], now: u64) -> i32 {
        unsafe { hypen_device_broker_on_frame(h, f.as_ptr(), f.len(), now) }
    }

    /// Poll once; the header and the payload section.
    fn poll(h: u32) -> (Vec<Value>, Vec<u8>) {
        assert!(hypen_device_broker_poll(h) >= 0);
        let buf = result();
        let (header, payload) = db::decode_framed(&buf).unwrap();
        (header.as_array().unwrap().clone(), payload.to_vec())
    }

    fn slice(payload: &[u8], o: &Value) -> Vec<u8> {
        let off = o["offset"].as_u64().unwrap() as usize;
        let len = o["len"].as_u64().unwrap() as usize;
        payload[off..off + len].to_vec()
    }

    fn activate(h: u32, mid: &str, aid: u32) -> i32 {
        unsafe { hypen_device_broker_owner_activated(h, mid.as_ptr(), mid.len(), aid, 0) }
    }

    /// Grants the poll carried for request `id`.
    fn grants(out: &[Value], id: u32) -> Vec<u64> {
        out.iter()
            .filter(|o| o["type"] == "sendText")
            .filter_map(|o| serde_json::from_str::<Value>(o["text"].as_str()?).ok())
            .filter(|m| m["id"] == id)
            .filter_map(|m| m["control"]["grant"].as_u64())
            .collect()
    }

    #[test]
    fn host_counts_are_clamped_to_deliveries_over_the_c_abi() {
        let h = create(&json!({ "ack": full_ack_json() }), 0);
        assert_eq!(hypen_device_broker_start(h, 0), 0);
        assert_eq!(activate(h, "m1", 1), 1);
        poll(h);
        let scan = open(
            h,
            &json!({"capability": "bluetooth.scan", "moduleInstanceId": "m1",
                    "activationId": 1, "initialCredit": 2}),
            None,
            0,
        )["id"]
            .as_u64()
            .unwrap() as u32;
        poll(h);
        // 10 / u64::MAX "consumed" after 0 deliveries: no credit, at once.
        assert_eq!(hypen_device_broker_consumed_events(h, scan, 10, 1), 0);
        assert_eq!(hypen_device_broker_consumed_events(h, scan, u64::MAX, 1), 0);
        assert!(grants(&poll(h).0, scan).is_empty());
        assert_eq!(hypen_device_broker_outstanding_event_credit(h, scan), 2);
        let ev = json!({"type": "deviceEvent", "id": scan,
                        "event": {"device": {"id": "aa:1", "name": "x", "rssi": -40}}});
        assert_eq!(on_text(h, &ev, 2), 1);
        poll(h);
        assert_eq!(hypen_device_broker_consumed_events(h, scan, u64::MAX, 3), 0);
        assert_eq!(
            grants(&poll(h).0, scan),
            vec![1],
            "exactly the one delivery"
        );
        assert_eq!(hypen_device_broker_consumed_events(h, scan, u64::MAX, 3), 0);
        assert!(grants(&poll(h).0, scan).is_empty(), "already reported");

        // Data chunks: u32::MAX consumed releases only what was delivered.
        let mic = open(
            h,
            &json!({"capability": "mic.record", "moduleInstanceId": "m1", "activationId": 1,
                    "params": {"sampleRate": 16000, "format": "pcm16"}, "initialCredit": 2048}),
            None,
            4,
        )["id"]
            .as_u64()
            .unwrap() as u32;
        poll(h);
        assert_eq!(hypen_device_broker_consumed_data(h, mic, u32::MAX, 4), 0);
        assert!(grants(&poll(h).0, mic).is_empty());
        let bs = json!({"type": "deviceEvent", "id": mic,
                        "event": {"kind": "blobStart", "channel": 0, "contentType": "audio/L16"}});
        assert_eq!(on_text(h, &bs, 5), 1);
        assert_eq!(on_frame(h, &frame(mic, 0, 0, &[7u8; 1024]), 5), 1);
        assert_eq!(on_frame(h, &frame(mic, 0, 1, &[7u8; 1024]), 5), 1);
        poll(h);
        assert_eq!(hypen_device_broker_outstanding_credit(h, mic), 0);
        assert_eq!(hypen_device_broker_consumed_data(h, mic, u32::MAX, 6), 0);
        assert_eq!(grants(&poll(h).0, mic), vec![2048]);
        assert_eq!(hypen_device_broker_consumed_data(h, mic, u32::MAX, 6), 0);
        assert!(grants(&poll(h).0, mic).is_empty());

        // Times and buffered bytes at the top of the u64 range saturate.
        assert_eq!(hypen_device_broker_set_transport_buffered(h, u64::MAX), 0);
        assert!(hypen_device_broker_tick(h, u64::MAX) >= -1);
        assert_eq!(
            hypen_device_broker_consumed_events(h, scan, u64::MAX, u64::MAX),
            0
        );
        hypen_device_broker_destroy(h);

        let late = create(&json!({ "ack": full_ack_json() }), 0);
        assert_eq!(hypen_device_broker_start(late, u64::MAX - 1), 0);
        assert!(hypen_device_broker_tick(late, u64::MAX) >= -1);
        hypen_device_broker_destroy(late);
    }

    #[test]
    fn upload_and_download_over_the_c_abi() {
        let h = create(&json!({ "ack": full_ack_json() }), 0);
        assert_ne!(h, 0, "{}", last_error());
        assert_eq!(hypen_device_broker_start(h, 0), 0);
        let core = result_json()["id"].as_u64().unwrap();
        assert_eq!(activate(h, "m1", 1), 1);
        assert_eq!(activate(h, "m1", 1), 0, "non-increasing activation");
        let (out, _) = poll(h);
        assert!(out.iter().any(|o| o["type"] == "sendText"));

        // Upload.
        let id = open(
            h,
            &json!({"capability": "gallery.pick", "params": {"mediaTypes": ["photo"], "maxCount": 1},
                    "moduleInstanceId": "m1", "activationId": 1}),
            None,
            1,
        )["id"]
            .as_u64()
            .unwrap() as u32;
        assert_ne!(u64::from(id), core);
        assert_eq!(hypen_device_broker_is_live(h, id), 1);
        poll(h);
        let photo = vec![0xAB; 3000];
        assert_eq!(
            on_text(
                h,
                &json!({"type": "deviceEvent", "id": id, "event": {"kind": "blobStart",
                    "channel": 0, "contentType": "image/jpeg", "bytes": photo.len()}}),
                2
            ),
            1
        );
        assert_eq!(on_frame(h, &frame(id, 0, 0, &photo[..2000]), 3), 1);
        assert_eq!(on_frame(h, &frame(id, 0, 1, &photo[2000..]), 3), 1);
        assert!(hypen_device_broker_outstanding_credit(h, id) >= 0);
        let r = json!({"type": "deviceResponse", "id": id, "result": {"items": [{"channel": 0,
            "contentType": "image/jpeg", "bytes": photo.len(), "sha256": sha256_hex(&photo)}]}});
        assert_eq!(on_text(h, &r, 4), 1);
        let (out, payload) = poll(h);
        let settled = out
            .iter()
            .find(|o| o["type"] == "settled" && o["id"] == id)
            .unwrap();
        assert_eq!(settled["outcome"]["ok"], true);
        assert_eq!(slice(&payload, &settled["outcome"]["blobs"][0]), photo);
        assert_eq!(hypen_device_broker_is_live(h, id), 0);
        assert_eq!(hypen_device_broker_outstanding_credit(h, id), -1);

        // Download (file.save) with params built through the ABI.
        let data = b"downloaded bytes".to_vec();
        let (n, ct) = ("a.txt", "text/plain");
        let rc = unsafe {
            hypen_device_file_save_params(
                n.as_ptr(),
                n.len(),
                ct.as_ptr(),
                ct.len(),
                data.as_ptr(),
                data.len(),
            )
        };
        assert_eq!(rc, 0);
        let params = result_json();
        let dl = open(
            h,
            &json!({"capability": "file.save", "params": params,
                    "moduleInstanceId": "m1", "activationId": 1}),
            Some(&data),
            5,
        )["id"]
            .as_u64()
            .unwrap() as u32;
        let (out, _) = poll(h);
        assert!(
            !out.iter().any(|o| o["type"] == "sendFrame"),
            "no frames before a grant"
        );
        assert_eq!(
            on_text(
                h,
                &json!({"type": "deviceEvent", "id": dl, "control": {"grant": 65536}}),
                6
            ),
            1
        );
        let mut sent = Vec::new();
        for _ in 0..4 {
            let (out, payload) = poll(h);
            for o in out.iter().filter(|o| o["type"] == "sendFrame") {
                sent.extend_from_slice(&slice(&payload, o)[12..]);
            }
        }
        assert_eq!(sent, data);
        let receipt =
            json!({"type": "deviceResponse", "id": dl, "result": {"bytesWritten": data.len()}});
        assert_eq!(on_text(h, &receipt, 7), 1);
        let (out, _) = poll(h);
        let settled = out
            .iter()
            .find(|o| o["type"] == "settled" && o["id"] == dl)
            .unwrap();
        assert_eq!(settled["outcome"]["ok"], true);

        assert_eq!(hypen_device_broker_info(h), 0);
        let info = result_json();
        assert_eq!(info["coreStreamId"], core);
        assert_eq!(info["liveCount"], 1);
        assert!(hypen_device_broker_tick(h, 8) > 8);
        assert!(hypen_device_broker_next_deadline(h) > 8);
        assert_eq!(hypen_device_broker_destroy(h), 0);
        assert_eq!(hypen_device_broker_destroy(h), ERR_HANDLE);
    }

    #[test]
    fn refusals_are_results_and_bad_input_is_an_error() {
        let h = create(&json!({ "ack": full_ack_json() }), 0);
        assert_eq!(hypen_device_broker_start(h, 0), 0);
        // Not activated: a refusal in the result buffer, status 0.
        let r = open(
            h,
            &json!({"capability": "permission.query", "params": {"permission": "camera"},
                    "moduleInstanceId": "m9", "activationId": 1}),
            None,
            0,
        );
        assert!(r["error"]["code"].is_string(), "{r}");
        // Replay firewall.
        assert_eq!(activate(h, "m1", 1), 1);
        let r = open(
            h,
            &json!({"capability": "permission.query", "params": {"permission": "camera"},
                    "moduleInstanceId": "m1", "activationId": 1, "replayed": true}),
            None,
            0,
        );
        assert_eq!(r["error"]["code"], "unavailable");
        // Malformed spec JSON is a host error.
        let bad = "{";
        let rc = unsafe {
            hypen_device_broker_open(h, bad.as_ptr(), bad.len(), std::ptr::null(), 0, 0, 0)
        };
        assert_eq!(rc, ERR_JSON);
        assert!(last_error().contains("open spec"));
        // Null pointer with a length.
        let rc = unsafe { hypen_device_broker_on_frame(h, std::ptr::null(), 4, 0) };
        assert_eq!(rc, ERR_INPUT);
        // Unknown handle everywhere.
        assert_eq!(hypen_device_broker_poll(999_999), ERR_HANDLE);
        assert_eq!(hypen_device_broker_tick(999_999, 0), ERR_HANDLE as i64);
        assert_eq!(on_text(999_999, &json!({}), 0), ERR_HANDLE);
        assert!(last_error().contains("999999"));
        // Bad config → handle 0.
        assert_eq!(create(&json!({"ack": {}}), 0), 0);
        assert!(last_error().contains("ack"));
        // Bad close code.
        let code = "ConnectionLost";
        assert_eq!(
            unsafe { hypen_device_broker_close(h, code.as_ptr(), code.len()) },
            ERR_JSON
        );
        let code = "connectionLost";
        assert_eq!(
            unsafe { hypen_device_broker_close(h, code.as_ptr(), code.len()) },
            0
        );
        assert_eq!(hypen_device_broker_info(h), 0);
        assert_eq!(result_json()["closed"], true);
        hypen_device_broker_destroy(h);
    }

    #[test]
    fn invalid_utf8_text_is_a_connection_violation() {
        let h = create(&json!({ "ack": full_ack_json() }), 0);
        hypen_device_broker_start(h, 0);
        let raw = [0x7b, 0xff, 0x7d];
        assert_eq!(
            unsafe { hypen_device_broker_on_text(h, raw.as_ptr(), raw.len(), 0) },
            0
        );
        hypen_device_broker_info(h);
        assert_eq!(result_json()["connectionViolations"], 1);
        hypen_device_broker_destroy(h);
    }

    #[test]
    fn pools_are_shared_between_brokers_and_released_on_destroy() {
        let pool = hypen_device_pool_create(10_000);
        let a = create(&json!({ "ack": full_ack_json() }), pool);
        let b = create(&json!({ "ack": full_ack_json() }), pool);
        assert!(a != 0 && b != 0 && a != b && a != pool && b != pool);
        hypen_device_broker_start(a, 0);
        activate(a, "m1", 1);
        let id = open(
            a,
            &json!({"capability": "gallery.pick", "params": {"mediaTypes": ["photo"], "maxCount": 1},
                    "moduleInstanceId": "m1", "activationId": 1}),
            None,
            0,
        )["id"]
            .as_u64()
            .unwrap() as u32;
        on_text(
            a,
            &json!({"type": "deviceEvent", "id": id, "event": {"kind": "blobStart",
                "channel": 0, "contentType": "image/jpeg", "bytes": 4000}}),
            0,
        );
        assert!(hypen_device_pool_in_use(pool) >= 4000);
        assert_eq!(hypen_device_broker_destroy(a), 0);
        assert_eq!(
            hypen_device_pool_in_use(pool),
            0,
            "destroy releases pooled bytes"
        );
        assert_eq!(hypen_device_pool_destroy(pool), 0);
        assert_eq!(hypen_device_pool_in_use(pool), ERR_HANDLE as i64);
        assert_eq!(create(&json!({ "ack": full_ack_json() }), pool), 0);
        hypen_device_broker_destroy(b);
    }

    #[test]
    fn handshake_over_the_c_abi() {
        let hello = json!({"protocolVersions": [1], "binary": true, "capabilities": [
            {"name": "core.capabilities", "versions": [1]}, {"name": "gallery.pick", "versions": [1]}]})
        .to_string();
        let rc =
            unsafe { hypen_device_handshake(hello.as_ptr(), hello.len(), 1, std::ptr::null(), 0) };
        assert_eq!(rc, 0, "{}", last_error());
        let r = result_json();
        assert_eq!(r["ack"]["capabilities"].as_array().unwrap().len(), 2);
        assert!(r.get("reason").is_none());

        let bad = "{\"protocolVersions\":[1,1],\"binary\":true,\"capabilities\":[]}";
        assert_eq!(
            unsafe { hypen_device_handshake(bad.as_ptr(), bad.len(), 1, std::ptr::null(), 0) },
            0
        );
        let r = result_json();
        assert_eq!(r["ack"], Value::Null);
        assert!(r["reason"]
            .as_str()
            .unwrap()
            .starts_with("invalid hello.device: "));

        let caps = r#"[{"name":"core.capabilities","versions":[1]}]"#;
        assert_eq!(
            unsafe {
                hypen_device_handshake(hello.as_ptr(), hello.len(), 0, caps.as_ptr(), caps.len())
            },
            0
        );
        let r = result_json();
        assert_eq!(r["ack"]["binary"], false);
        assert_eq!(r["ack"]["capabilities"].as_array().unwrap().len(), 1);

        let junk = "nope";
        assert_eq!(
            unsafe {
                hypen_device_handshake(hello.as_ptr(), hello.len(), 1, junk.as_ptr(), junk.len())
            },
            ERR_JSON
        );
        assert!(last_error().contains("server capabilities"));
    }

    #[test]
    fn handshake_helpers_over_the_c_abi() {
        let hello = json!({"protocolVersions": [1], "binary": true, "capabilities": [
            {"name": "core.capabilities", "versions": [1]}, {"name": "gallery.pick", "versions": [1]}]})
        .to_string();
        assert_eq!(
            unsafe { hypen_device_negotiate(hello.as_ptr(), hello.len(), 1) },
            0
        );
        let ack = result_json();
        assert_eq!(ack["capabilities"].as_array().unwrap().len(), 2);
        let garbage = "{\"protocolVersions\":[1,1]}";
        unsafe { hypen_device_negotiate(garbage.as_ptr(), garbage.len(), 1) };
        assert_eq!(result_json(), Value::Null);

        let server = json!({"protocolVersions": [1], "binary": false,
            "capabilities": [{"name": "core.capabilities", "versions": [1]},
                             {"name": "gallery.pick", "versions": [1]}]})
        .to_string();
        assert_eq!(
            unsafe {
                hypen_device_select_ack(hello.as_ptr(), hello.len(), server.as_ptr(), server.len())
            },
            0
        );
        let sel = result_json();
        assert_eq!(sel["binary"], false);
        assert_eq!(
            sel["capabilities"],
            json!([{"name": "core.capabilities", "version": 1}])
        );
        let bad_server = "{\"protocolVersions\":[1]}";
        assert_eq!(
            unsafe {
                hypen_device_select_ack(
                    hello.as_ptr(),
                    hello.len(),
                    bad_server.as_ptr(),
                    bad_server.len(),
                )
            },
            ERR_JSON
        );

        unsafe { hypen_device_validate_hello(hello.as_ptr(), hello.len()) };
        assert_eq!(result_json()["ok"], true);
        let ack_text = sel.to_string();
        unsafe { hypen_device_validate_ack(ack_text.as_ptr(), ack_text.len()) };
        assert_eq!(result_json()["ok"], true);
        unsafe { hypen_device_validate_ack(garbage.as_ptr(), garbage.len()) };
        assert_eq!(result_json()["ok"], false);

        hypen_device_server_advertisement();
        assert_eq!(result_json()[0]["name"], "core.capabilities");
        hypen_device_constants();
        assert_eq!(result_json()["devicePlaneCloseCode"], 1012);

        let small = "{\"type\":\"deviceEvent\"}";
        assert_eq!(
            unsafe { hypen_device_is_oversize_text(small.as_ptr(), small.len()) },
            0
        );
        let big = format!(
            "{{\"type\":\"deviceEvent\",\"pad\":\"{}\"}}",
            "x".repeat(1_100_000)
        );
        assert_eq!(
            unsafe { hypen_device_is_oversize_text(big.as_ptr(), big.len()) },
            1
        );

        let data = b"abc";
        unsafe { hypen_device_sha256_hex(data.as_ptr(), data.len()) };
        assert_eq!(
            String::from_utf8(result()).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn queries_over_the_c_abi() {
        let h = create(
            &json!({ "ack": full_ack_json(), "revisionOverrides": [{"capability": "bluetooth.scan",
                "version": 1, "lifetimes": ["activation", "background"]}] }),
            0,
        );
        hypen_device_broker_start(h, 0);
        activate(h, "m1", 1);
        let name = "gallery.pick";
        assert_eq!(
            unsafe { hypen_device_broker_supports(h, name.as_ptr(), name.len()) },
            1
        );
        assert_eq!(
            unsafe { hypen_device_broker_selected_version(h, name.as_ptr(), name.len()) },
            1
        );
        let nope = "nope";
        assert_eq!(
            unsafe { hypen_device_broker_selected_version(h, nope.as_ptr(), nope.len()) },
            -1
        );
        let mid = "m1";
        assert_eq!(
            unsafe { hypen_device_broker_owner_is_active(h, mid.as_ptr(), mid.len(), 1) },
            1
        );
        assert_eq!(
            unsafe { hypen_device_broker_admits_background(h, mid.as_ptr(), mid.len()) },
            1
        );
        let scan = open(
            h,
            &json!({"capability": "bluetooth.scan", "moduleInstanceId": "m1",
                    "activationId": 1, "lifetime": "background", "initialCredit": 4}),
            None,
            0,
        );
        let id = scan["id"].as_u64().expect("background scan opens") as u32;
        assert_eq!(
            unsafe { hypen_device_broker_has_background_work(h, mid.as_ptr(), mid.len()) },
            1
        );
        assert_eq!(hypen_device_broker_outstanding_event_credit(h, id), 4);
        // Deactivation keeps background work; destruction sweeps it.
        unsafe { hypen_device_broker_owner_deactivated(h, mid.as_ptr(), mid.len(), 1, 1) };
        assert_eq!(hypen_device_broker_is_live(h, id), 1);
        unsafe { hypen_device_broker_owner_destroyed(h, mid.as_ptr(), mid.len(), 2) };
        assert_eq!(hypen_device_broker_is_live(h, id), 0);
        let (out, _) = poll(h);
        let settled = out
            .iter()
            .find(|o| o["type"] == "settled" && o["id"] == id)
            .unwrap();
        assert_eq!(settled["outcome"]["code"], "cancelled");
        assert_eq!(hypen_device_broker_set_transport_buffered(h, 1), 0);
        assert_eq!(hypen_device_broker_consumed_events(h, id, 1, 3), 0);
        assert_eq!(hypen_device_broker_consumed_data(h, id, 1, 3), 0);
        assert_eq!(hypen_device_broker_release_result(h, id), 0);
        assert_eq!(hypen_device_broker_cancel(h, id, 3), 0);
        let reason = "host saw junk";
        unsafe { hypen_device_broker_report_violation(h, reason.as_ptr(), reason.len(), 3) };
        hypen_device_broker_info(h);
        assert_eq!(result_json()["lastConnectionViolation"], reason);
        assert!(hypen_device_broker_reopen_core(h, 4) > 0);
        hypen_device_broker_destroy(h);
    }

    #[test]
    fn revision_and_server_consumes_over_the_c_abi() {
        let h = create(
            &json!({ "ack": full_ack_json(), "maxItemBytes": 2048,
                     "revisionOverrides": [{"capability": "bluetooth.scan", "version": 1,
                        "lifetimes": ["activation", "background"]}] }),
            0,
        );
        let scan = "bluetooth.scan";
        assert_eq!(
            unsafe { hypen_device_broker_revision(h, scan.as_ptr(), scan.len(), 1) },
            0
        );
        let rev = result_json();
        assert_eq!(rev["mode"], "stream");
        assert_eq!(rev["data"], "jsonEvents");
        assert_eq!(rev["lifetimes"], json!(["activation", "background"]));
        // The answer feeds straight back into server_consumes.
        let text = rev.to_string();
        assert_eq!(
            unsafe { hypen_device_server_consumes(text.as_ptr(), text.len()) },
            1
        );
        let pick = "gallery.pick";
        unsafe { hypen_device_broker_revision(h, pick.as_ptr(), pick.len(), 1) };
        assert_eq!(result_json()["maxItemBytes"], 2048);
        unsafe { hypen_device_broker_revision(h, pick.as_ptr(), pick.len(), 9) };
        assert_eq!(result_json(), Value::Null);
        assert_eq!(
            unsafe { hypen_device_broker_revision(h + 1000, pick.as_ptr(), pick.len(), 1) },
            ERR_HANDLE
        );
        assert_eq!(
            unsafe { hypen_device_broker_revision(h, std::ptr::null(), 3, 1) },
            ERR_INPUT
        );
        let dl = r#"{"mode":"stream","data":"binaryDownload"}"#;
        assert_eq!(
            unsafe { hypen_device_server_consumes(dl.as_ptr(), dl.len()) },
            0
        );
        let bad = r#"{"mode":"stream"}"#;
        assert_eq!(
            unsafe { hypen_device_server_consumes(bad.as_ptr(), bad.len()) },
            ERR_JSON
        );
        assert!(last_error().contains("data"));
        let not_utf8 = [0xffu8, 0xfe];
        assert_eq!(
            unsafe { hypen_device_server_consumes(not_utf8.as_ptr(), not_utf8.len()) },
            ERR_INPUT
        );
        hypen_device_broker_destroy(h);
    }
}
