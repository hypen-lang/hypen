//! AVIF still-image decoding without a system library.
//!
//! The HEIF container is parsed by `avif-parse`; the AV1 payload is
//! decoded by `rav1d`, a Rust port of dav1d, built here without its
//! hand-written assembly so the build needs nothing but `cargo` (no
//! system `libdav1d`, no `nasm` / `meson`). The `avif-asm` feature turns
//! the assembly back on for builds that have `nasm`.
//!
//! The decoded YUV planes are converted to straight-alpha RGBA8 here; the
//! caller premultiplies like every other raster format.
//!
//! Support status:
//! - Still AVIF (major brand `avif`, or another major brand such as
//!   `mif1` that lists `avif` as compatible): decoded, with alpha.
//! - Animated AVIF (`avis`): a file that also lists `avif` carries a
//!   still primary image and that is what is shown (no animation). One
//!   that is `avis` only has no still image and fails to decode.
//! - Grid (tiled) primary images: not supported (avif-parse refuses
//!   them); the source fails to decode.
//!
//! A source that fails is logged once by the image worker and cached as
//! failed, so it is never fetched or decoded again.
//!
//! Crash isolation: image bytes come from remote servers, and rav1d
//! panics on some malformed bitstreams (e.g. an `unwrap` on its error
//! path; it has hundreds of such sites). Upstream, its only public entry
//! points are `extern "C"` (`dav1d_*`), through which a panic aborts the
//! process; the workspace therefore uses a vendored rav1d whose `extern`
//! functions and function pointers are `extern "C-unwind"`
//! (`third_party/rav1d/PATCHES.md`), and each decode runs on its own
//! thread inside `catch_unwind` with a fresh decoder, single-threaded
//! (see [`decoder_settings`]), within [`DECODE_TIMEOUT`] (see
//! [`run_with_deadline`]). This needs `panic = "unwind"`, the default:
//! with `panic = "abort"` any of these panics ends the process.

use rav1d::include::dav1d::data::Dav1dData;
use rav1d::include::dav1d::dav1d::{Dav1dContext, Dav1dSettings};
use rav1d::include::dav1d::headers::{
    DAV1D_MC_BT2020_CL, DAV1D_MC_BT2020_NCL, DAV1D_MC_BT709, DAV1D_MC_IDENTITY, DAV1D_MC_SMPTE240,
    DAV1D_PIXEL_LAYOUT_I400, DAV1D_PIXEL_LAYOUT_I420, DAV1D_PIXEL_LAYOUT_I422,
    DAV1D_PIXEL_LAYOUT_I444,
};
use rav1d::include::dav1d::picture::Dav1dPicture;
use rav1d::src::lib::{
    dav1d_close, dav1d_data_create, dav1d_data_unref, dav1d_default_settings, dav1d_get_picture,
    dav1d_open, dav1d_picture_unref, dav1d_send_data,
};
use std::mem::MaybeUninit;
use std::ptr::NonNull;
use std::time::Duration;

/// Allocation budget for decoding one AVIF: the ceiling `image`'s
/// default `Limits::max_alloc` puts on PNG / JPEG / WebP (512 MiB). A
/// flat AV1 frame of any size encodes to a few KB, so the byte cap on
/// fetched files says nothing about how much a decode allocates.
const MAX_DECODE_BYTES: u64 = 512 * 1024 * 1024;

/// Bytes per pixel alive at the decode's peak, for the costliest picture
/// a stream can produce whatever its header announces: three 16-bit
/// planes (10/12-bit 4:4:4), a second copy when film grain is applied,
/// and the RGBA8 output being written (the alpha item is decoded after
/// the color picture is released, into that same RGBA buffer; the
/// caller premultiplies it in place).
const PEAK_BYTES_PER_PIXEL: u64 = 3 * 2 * 2 + 4;

/// Largest frame (in pixels) a decode accepts: 32 Mi px, room for an 8K
/// UHD (7680×4320) image. Checked against each item's sequence header
/// before a decoder is opened, and given to rav1d as its frame size
/// limit so a stream that changes its sequence header mid-item can't
/// get past it either.
const MAX_FRAME_PIXELS: u32 = (MAX_DECODE_BYTES / PEAK_BYTES_PER_PIXEL) as u32;

/// The leading `ftyp` box's major brand and compatible brands, if
/// `bytes` starts with one.
fn ftyp_brands(bytes: &[u8]) -> Option<(&[u8; 4], &[[u8; 4]])> {
    if bytes.len() < 16 || &bytes[4..8] != b"ftyp" {
        return None;
    }
    let size = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
    let end = size.clamp(16, bytes.len());
    // Major brand at 8..12, minor version at 12..16, compatible brands after.
    let major = bytes[8..12].try_into().ok()?;
    Some((major, bytes[16..end].as_chunks::<4>().0))
}

/// What the `ftyp` brands say an AVIF file holds.
#[derive(Debug, PartialEq, Eq)]
enum AvifKind {
    /// A still image avif-parse reads as-is (major brand `avif`).
    Still,
    /// A still image under another major brand (`mif1`, `avis`, ...)
    /// that lists `avif` as compatible. avif-parse insists on major
    /// brand `avif`, so it is handed the file with that brand.
    StillUnderOtherMajorBrand,
    /// `avis` without `avif`: an image sequence with no still image.
    SequenceOnly,
}

fn avif_kind(bytes: &[u8]) -> Option<AvifKind> {
    let (major, compatible) = ftyp_brands(bytes)?;
    let has = |brand: &[u8; 4]| major == brand || compatible.contains(brand);
    if major == b"avif" {
        Some(AvifKind::Still)
    } else if has(b"avif") {
        Some(AvifKind::StillUnderOtherMajorBrand)
    } else if has(b"avis") {
        Some(AvifKind::SequenceOnly)
    } else {
        None
    }
}

/// Whether `bytes` is an AVIF file: an ISO-BMFF `ftyp` box whose major
/// or compatible brands include `avif` (still) or `avis` (sequence).
/// Every such file goes to [`decode_rgba8`], which either decodes it or
/// fails with the reason (see the module docs for what is supported).
pub(crate) fn looks_like_avif(bytes: &[u8]) -> bool {
    avif_kind(bytes).is_some()
}

/// Longest a decode may take before the caller stops waiting for it
/// (see [`run_with_deadline`]). Generous: a debug build decodes a 4K
/// frame on one thread in a few seconds.
const DECODE_TIMEOUT: Duration = Duration::from_secs(30);

/// Stack for the decode thread (the image worker's own stack, or a
/// host's main thread, can be as small as 1 MiB on Windows).
const DECODE_STACK: usize = 16 * 1024 * 1024;

/// Most frame headers (`OBU_FRAME` / `OBU_FRAME_HEADER`, including
/// `show_existing_frame` repeats) one AVIF item may hold. A still item
/// is one temporal unit: one frame, or one per layer of a layered
/// image (at most 4). Without a cap a few bytes per frame header buy a
/// full-size frame decode (rav1d reads past the end of tile data as
/// padding) or a full-size film-grain pass per output picture, so a
/// 20 MB item could keep a core busy for days.
const MAX_FRAMES_PER_ITEM: usize = 8;

type Rgba8 = (u32, u32, Vec<u8>);

/// Decode an AVIF file's primary image (and its alpha item, if any) to
/// straight-alpha RGBA8. Returns `(width, height, pixels)`.
///
/// A malformed file fails its own decode; it can't take the image
/// worker or the process down with it: a panic in avif-parse or rav1d
/// is caught (rav1d is vendored with unwinding entry points, see
/// `third_party/rav1d/PATCHES.md`), and a decode that overruns
/// [`DECODE_TIMEOUT`] is abandoned (see [`run_with_deadline`]).
pub(crate) fn decode_rgba8(bytes: &[u8]) -> Result<Rgba8, String> {
    avif_kind(bytes).ok_or("not an AVIF file")?;
    let bytes = bytes.to_vec();
    run_with_deadline(move || decode_unguarded(&bytes), DECODE_TIMEOUT)
}

/// Run `decode` on a fresh thread inside `catch_unwind` and wait at most
/// `timeout` for it.
///
/// A panic (avif-parse asserts on some box layouts; rav1d has hundreds
/// of `unwrap` / `assert!` sites reachable from malformed bitstreams)
/// becomes an error naming it. Every decode opens its own rav1d context
/// ([`Decoder`]), so nothing a panicking decode leaves half-updated is
/// seen by the next one; the context is closed afterwards, and any
/// picture buffer the unwound frames held is leaked (bounded by the
/// decode budget, once per malformed file, which the image worker then
/// caches as failed and never decodes again).
///
/// rav1d has no cancellation, so a decode past `timeout` can't be
/// stopped: its thread is abandoned and runs to completion in the
/// background (its result dropped), holding up to [`MAX_DECODE_BYTES`]
/// until it ends. The input checks (frame size cap, at most
/// [`MAX_FRAMES_PER_ITEM`] frames per item) bound how long that is.
fn run_with_deadline(
    decode: impl FnOnce() -> Result<Rgba8, String> + Send + 'static,
    timeout: Duration,
) -> Result<Rgba8, String> {
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    std::thread::Builder::new()
        .name("hypen-avif-decode".into())
        .stack_size(DECODE_STACK)
        .spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(decode))
                .unwrap_or_else(|payload| {
                    close_orphaned_decoders();
                    Err(format!(
                        "malformed AVIF (decoder panicked: {})",
                        panic_message(&*payload)
                    ))
                });
            // The caller may have stopped waiting; that's fine.
            let _ = tx.send(result);
        })
        .map_err(|e| format!("AVIF decode thread: {e}"))?;
    match rx.recv_timeout(timeout) {
        Ok(result) => result,
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            Err(format!("AVIF decode timed out after {} s (abandoned)", timeout.as_secs()))
        }
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            Err("malformed AVIF (decoder thread died)".into())
        }
    }
}

fn panic_message(payload: &(dyn std::any::Any + Send)) -> &str {
    payload
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
        .unwrap_or("non-string panic payload")
}

/// How many frame headers (`OBU_FRAME_HEADER` = 3, `OBU_FRAME` = 6) the
/// AV1 OBU stream `av1` holds, as far as its OBU headers can be walked.
/// A stream that stops parsing is counted up to there; rav1d reports
/// the rest.
fn count_frame_headers(av1: &[u8]) -> usize {
    let mut rest = av1;
    let mut frames = 0;
    while let Some((&header, after)) = rest.split_first() {
        let obu_type = header >> 3 & 0xf;
        let extension = header & 0b100 != 0;
        let has_size = header & 0b10 != 0;
        frames += usize::from(matches!(obu_type, 3 | 6));
        let Some(payload) = after.get(usize::from(extension)..) else { break };
        let size = if has_size {
            let Some((size, len)) = leb128(payload) else { break };
            rest = &payload[len..];
            size
        } else {
            rest = payload;
            payload.len() as u64
        };
        rest = rest.get(usize::try_from(size).unwrap_or(usize::MAX)..).unwrap_or(&[]);
    }
    frames
}

/// An AV1 `leb128()` value (at most 8 bytes) and its length in bytes.
fn leb128(bytes: &[u8]) -> Option<(u64, usize)> {
    let mut value = 0u64;
    for (i, &b) in bytes.iter().take(8).enumerate() {
        value |= u64::from(b & 0x7f) << (7 * i);
        if b & 0x80 == 0 || i == 7 {
            return Some((value, i + 1));
        }
    }
    None
}

/// Refuse an item with more than [`MAX_FRAMES_PER_ITEM`] frame headers.
fn check_frame_count(av1: &[u8]) -> Result<(), String> {
    let frames = count_frame_headers(av1);
    if frames > MAX_FRAMES_PER_ITEM {
        return Err(format!(
            "AVIF item has {frames} AV1 frame headers (limit {MAX_FRAMES_PER_ITEM})"
        ));
    }
    Ok(())
}

/// Parse the container, steering avif-parse (which requires major brand
/// `avif`) to the still image of files that declare one under another
/// major brand.
fn read_container(bytes: &[u8]) -> Result<avif_parse::AvifData, String> {
    use std::io::Read;
    let kind = avif_kind(bytes).ok_or("not an AVIF file")?;
    let parsed = match kind {
        AvifKind::Still => avif_parse::read_avif(&mut &bytes[..]),
        AvifKind::StillUnderOtherMajorBrand => {
            // Same bytes with the major brand read as `avif`; the box
            // size and everything after it are untouched.
            let mut head = [0u8; 12];
            head[..8].copy_from_slice(&bytes[..8]);
            head[8..].copy_from_slice(b"avif");
            avif_parse::read_avif(&mut (&head[..]).chain(&bytes[12..]))
        }
        AvifKind::SequenceOnly => {
            return Err("animated AVIF without a still image (brand 'avis' only) is not supported".into())
        }
    };
    parsed.map_err(|e| format!("AVIF container: {e}"))
}

fn decode_unguarded(bytes: &[u8]) -> Result<(u32, u32, Vec<u8>), String> {
    let avif = read_container(bytes)?;
    // Size every item from its sequence header before decoding anything.
    let color_meta = avif
        .primary_item_metadata()
        .map_err(|e| format!("AV1 sequence header: {e}"))?;
    check_frame_budget(&color_meta)?;
    check_frame_count(&avif.primary_item)?;
    if let Some(alpha_item) = avif.alpha_item.as_deref() {
        check_frame_count(alpha_item)?;
    }
    if let Some(alpha_meta) = avif
        .alpha_item_metadata()
        .map_err(|e| format!("AV1 alpha sequence header: {e}"))?
    {
        check_frame_budget(&alpha_meta)?;
    }
    let mut decoder = Decoder::new()?;
    let (w, h, mut rgba) = {
        let color = decoder.decode(&avif.primary_item)?;
        color.to_rgba8()?
    };
    if let Some(alpha_item) = avif.alpha_item.as_deref() {
        let alpha = decoder.decode(alpha_item)?;
        alpha.write_alpha(&mut rgba, w, h)?;
        if avif.premultiplied_alpha {
            for px in rgba.as_chunks_mut::<4>().0 {
                let a = u32::from(px[3]);
                if a != 0 && a != 255 {
                    for c in &mut px[..3] {
                        *c = (u32::from(*c) * 255 / a).min(255) as u8;
                    }
                }
            }
        }
    }
    Ok((w, h, rgba))
}

/// Refuse an item whose announced frame would take the decode past
/// [`MAX_DECODE_BYTES`].
fn check_frame_budget(meta: &avif_parse::AV1Metadata) -> Result<(), String> {
    let (w, h) = (meta.max_frame_width.get(), meta.max_frame_height.get());
    if u64::from(w) * u64::from(h) > u64::from(MAX_FRAME_PIXELS) {
        return Err(format!(
            "AVIF {w}x{h} is too large to decode (limit {MAX_FRAME_PIXELS} pixels)"
        ));
    }
    Ok(())
}

/// One rav1d context, closed on drop. Holds the last decoded picture so
/// the [`Frame`] borrowing it stays valid.
struct Decoder {
    ctx: Option<Dav1dContext>,
    picture: Option<Dav1dPicture>,
}

/// rav1d settings for one still image.
///
/// One thread: rav1d then spawns no worker threads and decodes on the
/// calling thread, so a panic on a malformed bitstream unwinds to that
/// thread's `catch_unwind` (see [`run_with_deadline`]) instead of
/// killing a rav1d worker the caller then waits on forever. Still
/// images have one frame, so there is no frame pipelining to lose
/// either; the cost is tile parallelism, off the paint path. Film
/// grain is part of the picture (browsers synthesise it too).
fn decoder_settings() -> Dav1dSettings {
    let mut settings = MaybeUninit::<Dav1dSettings>::uninit();
    // SAFETY: `dav1d_default_settings` initialises every field of the
    // struct it is handed.
    let mut settings = unsafe {
        dav1d_default_settings(NonNull::from(&mut settings).cast());
        settings.assume_init()
    };
    settings.n_threads = 1;
    settings.max_frame_delay = 1;
    settings.apply_grain = 1;
    settings.frame_size_limit = MAX_FRAME_PIXELS;
    settings
}

impl Decoder {
    fn new() -> Result<Self, String> {
        let mut settings = decoder_settings();
        let mut ctx = None;
        // SAFETY: both pointers are to live locals; on success `ctx` holds
        // a context we own and close in `Drop`.
        let res = unsafe {
            dav1d_open(
                Some(NonNull::from(&mut ctx)),
                Some(NonNull::from(&mut settings)),
            )
        };
        if res.0 != 0 || ctx.is_none() {
            return Err(format!("AV1 decoder init failed ({})", res.0));
        }
        Ok(Self { ctx, picture: None })
    }

    /// Decode one AVIF item (a single AV1 temporal unit). A layered item
    /// yields one picture per layer; the last one is the full image.
    fn decode(&mut self, av1: &[u8]) -> Result<Frame<'_>, String> {
        let ctx = self.ctx.ok_or("AV1 decoder closed")?;
        self.release_picture();
        let mut newest: Option<Dav1dPicture> = None;
        let mut data = Dav1dData::default();
        // SAFETY: rav1d allocates `av1.len()` bytes for `data` and returns
        // the buffer, which we fill completely before sending.
        let sent = unsafe {
            let buf = dav1d_data_create(Some(NonNull::from(&mut data)), av1.len());
            if buf.is_null() {
                return Err("AV1 data allocation failed".into());
            }
            std::ptr::copy_nonoverlapping(av1.as_ptr(), buf, av1.len());
            loop {
                let res = dav1d_send_data(Some(ctx), Some(NonNull::from(&mut data)));
                if res.0 == 0 {
                    break Ok(());
                }
                // The decoder may be holding a finished picture and need it
                // taken before it accepts more data.
                let mut pending = Dav1dPicture::default();
                if dav1d_get_picture(Some(ctx), Some(NonNull::from(&mut pending))).0 != 0 {
                    dav1d_picture_unref(Some(NonNull::from(&mut pending)));
                    break Err(format!("AV1 decode failed ({})", res.0));
                }
                keep_newest(&mut newest, pending);
            }
        };
        // SAFETY: releases whatever part of the buffer rav1d didn't take.
        unsafe { dav1d_data_unref(Some(NonNull::from(&mut data))) };
        if let Err(e) = sent {
            if let Some(mut pic) = newest.take() {
                // SAFETY: as in `keep_newest`.
                unsafe { dav1d_picture_unref(Some(NonNull::from(&mut pic))) };
            }
            return Err(e);
        }
        loop {
            let mut pic = Dav1dPicture::default();
            // SAFETY: `ctx` is open; `pic` is a live default picture.
            let res = unsafe { dav1d_get_picture(Some(ctx), Some(NonNull::from(&mut pic))) };
            if res.0 != 0 {
                // SAFETY: unref of an empty picture is a no-op.
                unsafe { dav1d_picture_unref(Some(NonNull::from(&mut pic))) };
                break;
            }
            keep_newest(&mut newest, pic);
        }
        let pic = newest.ok_or("AV1 item decoded to no picture")?;
        Ok(Frame(self.picture.insert(pic)))
    }

    fn release_picture(&mut self) {
        if let Some(mut pic) = self.picture.take() {
            // SAFETY: owned picture from `dav1d_get_picture`, released once.
            unsafe { dav1d_picture_unref(Some(NonNull::from(&mut pic))) };
        }
    }
}

impl Drop for Decoder {
    fn drop(&mut self) {
        if std::thread::panicking() {
            // Unwinding from a panic in rav1d: a second panic here (in
            // code that just failed an invariant) would abort, so the
            // context is handed to [`close_orphaned_decoders`], which the
            // decode thread calls once the unwind has been caught.
            let (ctx, picture) = (self.ctx.take(), self.picture.take());
            ORPHANED.with(|o| o.borrow_mut().push((ctx, picture)));
            return;
        }
        self.release_picture();
        // SAFETY: closes the context opened in `new` (no-op when `None`).
        unsafe { dav1d_close(Some(NonNull::from(&mut self.ctx))) };
    }
}

thread_local! {
    /// Contexts (and their held picture) dropped while unwinding.
    static ORPHANED: std::cell::RefCell<Vec<(Option<Dav1dContext>, Option<Dav1dPicture>)>> =
        const { std::cell::RefCell::new(Vec::new()) };
}

/// Close the decoders a caught panic unwound past. Each is closed
/// under `catch_unwind`; one whose close panics too is leaked.
fn close_orphaned_decoders() {
    for (mut ctx, picture) in ORPHANED.with(|o| std::mem::take(&mut *o.borrow_mut())) {
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            if let Some(mut pic) = picture {
                // SAFETY: owned picture from `dav1d_get_picture`, released once.
                unsafe { dav1d_picture_unref(Some(NonNull::from(&mut pic))) };
            }
            // SAFETY: a context opened in `Decoder::new`, closed once.
            unsafe { dav1d_close(Some(NonNull::from(&mut ctx))) };
        }));
    }
}

/// Keep `pic` as the newest picture, releasing the one it supersedes
/// (an earlier layer of the same item).
fn keep_newest(newest: &mut Option<Dav1dPicture>, pic: Dav1dPicture) {
    if let Some(mut old) = newest.replace(pic) {
        // SAFETY: `old` came from `dav1d_get_picture` and is released
        // exactly once.
        unsafe { dav1d_picture_unref(Some(NonNull::from(&mut old))) };
    }
}

/// A decoded picture, valid while the decoder is not reused.
struct Frame<'a>(&'a Dav1dPicture);

/// One plane's samples as `u16` (8-bit samples widened), row-major with
/// its own stride.
struct Plane<'a> {
    bytes: &'a [u8],
    stride: usize,
    w: usize,
    h: usize,
    wide: bool,
}

impl Plane<'_> {
    #[inline]
    fn at(&self, x: usize, y: usize) -> u16 {
        let x = x.min(self.w - 1);
        let y = y.min(self.h - 1);
        if self.wide {
            let i = y * self.stride + x * 2;
            u16::from_ne_bytes([self.bytes[i], self.bytes[i + 1]])
        } else {
            u16::from(self.bytes[y * self.stride + x])
        }
    }
}

impl Frame<'_> {
    fn size(&self) -> (usize, usize) {
        (self.0.p.w.max(0) as usize, self.0.p.h.max(0) as usize)
    }

    fn plane(&self, index: usize) -> Result<Plane<'_>, String> {
        let pic = self.0;
        let (w, h) = self.size();
        if w == 0 || h == 0 {
            return Err("empty AV1 picture".into());
        }
        let wide = pic.p.bpc > 8;
        let (ss_x, ss_y) = match (index, pic.p.layout) {
            (0, _) | (_, DAV1D_PIXEL_LAYOUT_I444) => (0, 0),
            (_, DAV1D_PIXEL_LAYOUT_I420) => (1, 1),
            (_, DAV1D_PIXEL_LAYOUT_I422) => (1, 0),
            _ => return Err("unsupported AV1 pixel layout".into()),
        };
        let (pw, ph) = ((w + ss_x) >> ss_x, (h + ss_y) >> ss_y);
        let stride = pic.stride[usize::from(index != 0)];
        let sample = if wide { 2 } else { 1 };
        if stride <= 0 || (stride as usize) < pw * sample {
            return Err("bad AV1 plane stride".into());
        }
        let data = pic.data[index].ok_or("missing AV1 plane")?;
        let len = stride as usize * ph;
        // SAFETY: rav1d allocates every plane as `ph` whole rows of
        // `stride` bytes, alive as long as the picture (borrowed by
        // `self`).
        let bytes = unsafe { std::slice::from_raw_parts(data.as_ptr().cast::<u8>(), len) };
        Ok(Plane {
            bytes,
            stride: stride as usize,
            w: pw,
            h: ph,
            wide,
        })
    }

    /// `(matrix, full_range)` from the AV1 sequence header. An unspecified
    /// matrix means BT.601, as in browsers.
    fn color(&self) -> (u32, bool) {
        // SAFETY: the sequence header lives as long as the picture.
        match self.0.seq_hdr.map(|h| unsafe { h.as_ref() }) {
            Some(h) => (h.mtrx, h.color_range != 0),
            None => (2, false),
        }
    }

    /// Convert the YUV (or monochrome) picture to straight RGBA8 with
    /// its matrix coefficients and range, like a browser: limited
    /// ("video") range unless the header says full, nearest chroma.
    fn to_rgba8(&self) -> Result<(u32, u32, Vec<u8>), String> {
        let (w, h) = self.size();
        let bpc = self.0.p.bpc.clamp(8, 16) as u32;
        let max = ((1u32 << bpc) - 1) as f32;
        let scale = (1u32 << (bpc - 8)) as f32;
        let (matrix, full_range) = self.color();
        let mut out = Vec::new();
        out.try_reserve_exact(w * h * 4)
            .map_err(|_| "AVIF too large to decode".to_string())?;
        let y_plane = self.plane(0)?;
        let luma = |v: u16| -> f32 {
            if full_range {
                v as f32 / max
            } else {
                (v as f32 - 16.0 * scale) / (219.0 * scale)
            }
        };
        let chroma = |v: u16| -> f32 {
            if full_range {
                (v as f32 - (max + 1.0) / 2.0) / max
            } else {
                (v as f32 - 128.0 * scale) / (224.0 * scale)
            }
        };
        let to_u8 = |v: f32| (v.clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
        if self.0.p.layout == DAV1D_PIXEL_LAYOUT_I400 {
            for y in 0..h {
                for x in 0..w {
                    let g = to_u8(luma(y_plane.at(x, y)));
                    out.extend_from_slice(&[g, g, g, 255]);
                }
            }
            return Ok((w as u32, h as u32, out));
        }
        let (u_plane, v_plane) = (self.plane(1)?, self.plane(2)?);
        let (ss_x, ss_y) = (usize::from(u_plane.w < w), usize::from(u_plane.h < h));
        // Kr / Kb of the luma matrix (ITU-T H.273); everything else BT.601.
        let (kr, kb) = match matrix {
            DAV1D_MC_BT709 => (0.2126, 0.0722),
            DAV1D_MC_BT2020_NCL | DAV1D_MC_BT2020_CL => (0.2627, 0.0593),
            DAV1D_MC_SMPTE240 => (0.212, 0.087),
            _ => (0.299, 0.114),
        };
        let kg = 1.0 - kr - kb;
        for y in 0..h {
            for x in 0..w {
                let yy = y_plane.at(x, y);
                let (cb, cr) = (
                    u_plane.at(x >> ss_x, y >> ss_y),
                    v_plane.at(x >> ss_x, y >> ss_y),
                );
                let (r, g, b) = if matrix == DAV1D_MC_IDENTITY {
                    // GBR: Y carries G, U carries B, V carries R.
                    (luma(cr), luma(yy), luma(cb))
                } else {
                    let (l, pb, pr) = (luma(yy), chroma(cb), chroma(cr));
                    let r = l + 2.0 * (1.0 - kr) * pr;
                    let b = l + 2.0 * (1.0 - kb) * pb;
                    let g = (l - kr * r - kb * b) / kg;
                    (r, g, b)
                };
                out.extend_from_slice(&[to_u8(r), to_u8(g), to_u8(b), 255]);
            }
        }
        Ok((w as u32, h as u32, out))
    }

    /// Write this (alpha item) picture's luma into `rgba`'s alpha bytes.
    fn write_alpha(&self, rgba: &mut [u8], w: u32, h: u32) -> Result<(), String> {
        if self.size() != (w as usize, h as usize) {
            return Err("AVIF alpha size differs from the image".into());
        }
        let bpc = self.0.p.bpc.clamp(8, 16) as u32;
        let max = ((1u32 << bpc) - 1) as f32;
        let scale = (1u32 << (bpc - 8)) as f32;
        let (_, full_range) = self.color();
        let plane = self.plane(0)?;
        for (i, px) in rgba.as_chunks_mut::<4>().0.iter_mut().enumerate() {
            let v = plane.at(i % w as usize, i / w as usize) as f32;
            let a = if full_range {
                v / max
            } else {
                (v - 16.0 * scale) / (219.0 * scale)
            };
            px[3] = (a.clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The home-screen launcher's swatch for its default wallpaper
    /// (`public/wallpapers/v1/blue-currents-swatch.avif`).
    const SWATCH: &[u8] = include_bytes!("../../tests/fixtures/images/blue-currents-swatch.avif");

    #[test]
    fn sniffs_avif_and_nothing_else() {
        assert!(looks_like_avif(SWATCH));
        assert!(!looks_like_avif(b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x01"));
        // HEIC is ISO-BMFF too, with other brands.
        assert!(!looks_like_avif(b"\0\0\0\x18ftypheic\0\0\0\0mif1heic"));
        assert!(!looks_like_avif(b"\0\0\0\x10ftyp"));
    }

    #[test]
    fn decodes_the_launcher_wallpaper_swatch() {
        let meta = avif_parse::read_avif(&mut &SWATCH[..])
            .unwrap()
            .primary_item_metadata()
            .unwrap();
        let (w, h, rgba) = decode_rgba8(SWATCH).expect("decodes without a system library");
        assert_eq!(
            (w, h),
            (meta.max_frame_width.get(), meta.max_frame_height.get())
        );
        assert_eq!(rgba.len(), (w * h * 4) as usize);
        assert!(
            rgba.as_chunks::<4>().0.iter().all(|px| px[3] == 255),
            "no alpha item: opaque"
        );
        let mean = |c: usize| {
            rgba.as_chunks::<4>()
                .0
                .iter()
                .map(|px| px[c] as u64)
                .sum::<u64>()
                / u64::from(w * h)
        };
        let (r, g, b) = (mean(0), mean(1), mean(2));
        // "Blue currents": reference means from libavif's `avifdec`.
        let (er, eg, eb) = EXPECTED_MEAN_RGB;
        for (got, want) in [(r, er), (g, eg), (b, eb)] {
            assert!(
                got.abs_diff(want) <= 3,
                "mean rgb ({r}, {g}, {b}) vs avifdec {EXPECTED_MEAN_RGB:?}"
            );
        }
    }

    const EXPECTED_MEAN_RGB: (u64, u64, u64) = (16, 30, 44);

    /// A reduced still-picture AV1 sequence header OBU announcing a
    /// `w`×`h`, 8-bit 4:2:0 frame.
    fn sequence_header_obu(w: u32, h: u32) -> Vec<u8> {
        let mut bits = Vec::new();
        let mut put = |value: u32, n: u32| bits.extend((0..n).rev().map(|i| value >> i & 1));
        put(0, 3); // seq_profile: 8/10-bit 4:2:0
        put(1, 1); // still_picture
        put(1, 1); // reduced_still_picture_header
        put(31, 5); // seq_level_idx: unconstrained
        put(15, 4); // frame_width_bits_minus_1
        put(15, 4); // frame_height_bits_minus_1
        put(w - 1, 16);
        put(h - 1, 16);
        put(0, 3); // 128x128 superblocks, filter intra, intra edge filter
        put(0, 3); // superres, cdef, loop restoration
        put(0, 1); // high_bitdepth
        put(0, 1); // mono_chrome
        put(0, 1); // color_description_present_flag
        put(1, 1); // color_range: full
        put(0, 2); // chroma_sample_position
        put(0, 1); // separate_uv_delta_q
        put(0, 1); // film_grain_params_present
        put(1, 1); // trailing one bit (zero-padded below)
        let payload: Vec<u8> = bits
            .chunks(8)
            .map(|byte| {
                (0..8).fold(0, |acc, i| {
                    acc << 1 | byte.get(i).copied().unwrap_or(0) as u8
                })
            })
            .collect();
        // OBU header: obu_type 1 (sequence header) in bits 6..3,
        // obu_has_size_field in bit 1.
        [&[0b0000_1010, payload.len() as u8][..], &payload].concat()
    }

    /// The swatch with its single item's AV1 payload replaced by `item`.
    /// The swatch stores that item as the whole of its trailing `mdat`,
    /// located by a version-0 `iloc` with 4-byte offset and length
    /// fields, one item and one extent; asserted here so a re-encoded
    /// fixture fails loudly instead of producing a broken file.
    fn swatch_with_item(item: &[u8]) -> Vec<u8> {
        let find = |tag: &[u8]| SWATCH.windows(4).position(|w| w == tag).unwrap() - 4;
        let be32 = |at: usize| u32::from_be_bytes(SWATCH[at..at + 4].try_into().unwrap()) as usize;
        let (iloc, mdat) = (find(b"iloc"), find(b"mdat"));
        assert_eq!(mdat + be32(mdat), SWATCH.len(), "mdat is the last box");
        let iloc_end = iloc + be32(iloc);
        assert_eq!(&SWATCH[iloc + 8..iloc + 14], &[0, 0, 0, 0, 0x44, 0x00]);
        assert_eq!(be32(iloc_end - 8), mdat + 8, "the item is all of mdat");
        let mut file = SWATCH[..mdat + 8].to_vec();
        file[iloc_end - 4..iloc_end].copy_from_slice(&(item.len() as u32).to_be_bytes());
        file[mdat..mdat + 4].copy_from_slice(&(8 + item.len() as u32).to_be_bytes());
        file.extend_from_slice(item);
        file
    }

    #[test]
    fn frame_budget_matches_the_other_formats_allocation_cap() {
        // The worst-case peak of the largest accepted frame stays within
        // `image`'s default allocation limit for PNG / JPEG / WebP.
        assert!(u64::from(MAX_FRAME_PIXELS) * PEAK_BYTES_PER_PIXEL <= 512 * 1024 * 1024);
        let meta = |w, h| {
            avif_parse::AV1Metadata::parse_av1_bitstream(&sequence_header_obu(w, h)).unwrap()
        };
        assert!(
            check_frame_budget(&meta(7680, 4320)).is_ok(),
            "8K UHD decodes"
        );
        assert!(check_frame_budget(&meta(96, 96)).is_ok());
        assert!(check_frame_budget(&meta(8192, 8192)).is_err());
        assert!(check_frame_budget(&meta(65536, 2)).is_ok());
        assert!(check_frame_budget(&meta(65536, 65536)).is_err());
    }

    #[test]
    fn oversized_frame_is_refused_before_decoding() {
        // A 3 KB file (mostly its ICC profile) announcing a 16k x 16k
        // frame: unchecked, the decode would ask for 1 GiB of RGBA on
        // top of the YUV planes.
        let file = swatch_with_item(&sequence_header_obu(16384, 16384));
        assert!(file.len() < 4096);
        let meta = avif_parse::read_avif(&mut &file[..])
            .unwrap()
            .primary_item_metadata()
            .unwrap();
        assert_eq!(
            (meta.max_frame_width.get(), meta.max_frame_height.get()),
            (16384, 16384)
        );
        let err = decode_rgba8(&file).unwrap_err();
        assert!(err.contains("too large"), "{err}");
        // The same container with an in-budget header gets past the
        // check (and then fails only for want of a frame).
        let small = swatch_with_item(&sequence_header_obu(96, 96));
        let err = decode_rgba8(&small).unwrap_err();
        assert!(!err.contains("too large"), "{err}");
    }

    /// The swatch with its `ftyp` replaced by `major` + `compatible`
    /// brands (same box size, so every offset after it still holds).
    fn swatch_with_brands(major: &[u8; 4], compatible: [&[u8; 4]; 4]) -> Vec<u8> {
        let mut file = SWATCH.to_vec();
        assert_eq!(&file[4..8], b"ftyp");
        assert_eq!(u32::from_be_bytes(file[..4].try_into().unwrap()), 32, "4 compatible brands");
        file[8..12].copy_from_slice(major);
        for (i, brand) in compatible.iter().enumerate() {
            file[16 + 4 * i..20 + 4 * i].copy_from_slice(*brand);
        }
        file
    }

    #[test]
    fn sniffing_and_parsing_agree_on_brands() {
        // `mif1` major brand with `avif` compatible: a still AVIF, sniffed
        // and decoded.
        let mif1 = swatch_with_brands(b"mif1", [b"mif1", b"miaf", b"avif", b"MA1B"]);
        assert_eq!(avif_kind(&mif1), Some(AvifKind::StillUnderOtherMajorBrand));
        assert!(looks_like_avif(&mif1));
        assert_eq!(decode_rgba8(&mif1).unwrap(), decode_rgba8(SWATCH).unwrap());
        // An animated file that also declares `avif` shows its still
        // primary image.
        let avis = swatch_with_brands(b"avis", [b"avif", b"avis", b"msf1", b"mif1"]);
        assert!(looks_like_avif(&avis));
        assert_eq!(decode_rgba8(&avis).unwrap(), decode_rgba8(SWATCH).unwrap());
        // `avis` only: routed to the AVIF decoder (not `image`), which
        // fails with the reason.
        let seq = swatch_with_brands(b"avis", [b"avis", b"msf1", b"mif1", b"miaf"]);
        assert_eq!(avif_kind(&seq), Some(AvifKind::SequenceOnly));
        assert!(looks_like_avif(&seq));
        let err = decode_rgba8(&seq).unwrap_err();
        assert!(err.contains("animated AVIF"), "{err}");
        // `avif` only as a compatible brand of something else entirely
        // still counts; no AVIF brand anywhere does not.
        let heic = swatch_with_brands(b"heic", [b"mif1", b"heic", b"miaf", b"MA1B"]);
        assert_eq!(avif_kind(&heic), None);
        assert!(!looks_like_avif(&heic));
    }

    #[test]
    fn grid_primary_image_fails_with_a_reason() {
        // The swatch's primary item retyped `grid`: avif-parse doesn't
        // assemble tiled images, so the decode fails cleanly (and the
        // worker caches the failure; see `image::resolve_source`).
        let mut file = SWATCH.to_vec();
        let at = file.windows(4).position(|w| w == b"av01").expect("infe item_type");
        file[at..at + 4].copy_from_slice(b"grid");
        assert!(looks_like_avif(&file));
        let err = decode_rgba8(&file).unwrap_err();
        assert!(err.to_ascii_lowercase().contains("grid"), "{err}");
    }

    #[test]
    fn decoder_runs_on_the_calling_thread_only() {
        // No rav1d worker threads: a panic unwinds on the decode thread,
        // to its `catch_unwind`.
        let settings = decoder_settings();
        assert_eq!(settings.n_threads, 1);
        assert_eq!(settings.max_frame_delay, 1);
    }

    /// The swatch's AV1 item (all of its `mdat`).
    fn swatch_item() -> Vec<u8> {
        let mdat = SWATCH.windows(4).position(|w| w == b"mdat").unwrap() - 4;
        SWATCH[mdat + 8..].to_vec()
    }

    /// 160 corruptions of the swatch's AV1 payload (bit flips, garbage
    /// runs, truncation, a scrambled frame after an intact sequence
    /// header), each wrapped back into the swatch's container.
    fn malformed_corpus() -> Vec<Vec<u8>> {
        let item = swatch_item();
        let mut seed = 0x2545_f491_4f6c_dd1du64;
        let mut next = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        (0..160)
            .map(|round| {
                let mut bad = item.clone();
                match round % 4 {
                    0 => {
                        for _ in 0..1 + round % 8 {
                            let i = (next() as usize) % bad.len();
                            bad[i] ^= 1 << (next() % 8);
                        }
                    }
                    1 => {
                        let start = 2 + (next() as usize) % (bad.len() - 2);
                        let end = (start + 1 + (next() as usize) % 64).min(bad.len());
                        for b in &mut bad[start..end] {
                            *b = next() as u8;
                        }
                    }
                    2 => bad.truncate(1 + (next() as usize) % (bad.len() - 1)),
                    _ => {
                        // Keep the sequence header; scramble the frame.
                        let keep = 16.min(bad.len());
                        for b in &mut bad[keep..] {
                            *b = next() as u8;
                        }
                    }
                }
                swatch_with_item(&bad)
            })
            .collect()
    }

    #[test]
    fn malformed_bitstreams_fail_in_process() {
        // Every corrupted variant comes back (decoded or an error) in
        // this process: rav1d's panics on some of them (an `unwrap` in
        // its frame decode, among others) unwind through its
        // `extern "C-unwind"` entry points to the decode's
        // `catch_unwind` instead of aborting the test binary.
        let (mut ok, mut err, mut panicked) = (0, 0, 0);
        for file in malformed_corpus() {
            match decode_rgba8(&file) {
                Ok(_) => ok += 1,
                Err(e) => {
                    err += 1;
                    panicked += usize::from(e.contains("decoder panicked"));
                    assert!(!e.contains("timed out"), "{e}");
                }
            }
        }
        assert_eq!(ok + err, 160);
        assert!(err > 0, "corruption is noticed at least sometimes");
        assert!(panicked > 0, "the corpus reaches rav1d panics ({err} errors)");
        // The decoder is unharmed.
        assert!(decode_rgba8(SWATCH).is_ok());
    }

    /// A corpus entry on which rav1d panics: `f.frame_hdr.as_ref().unwrap()`
    /// in the frame-error handler of `rav1d_submit_frame` (`src/decode.rs`,
    /// line 4997 in 1.1.0), as 76 of the 160 entries do.
    const PANICKING_VARIANT: usize = 3;

    #[test]
    fn rav1d_panic_is_an_error_naming_the_panic() {
        let file = &malformed_corpus()[PANICKING_VARIANT];
        for _ in 0..3 {
            let err = decode_rgba8(file).unwrap_err();
            assert!(err.contains("decoder panicked"), "{err}");
            assert!(err.contains("unwrap"), "{err}");
            // A fresh context per decode: the panic leaves nothing behind.
            assert!(decode_rgba8(SWATCH).is_ok());
        }
    }

    #[test]
    fn deadline_catches_panics_and_abandons_hangs() {
        use std::time::Instant;
        let ok = run_with_deadline(|| Ok((1, 1, vec![1, 2, 3, 4])), DECODE_TIMEOUT);
        assert_eq!(ok, Ok((1, 1, vec![1, 2, 3, 4])));
        let err = run_with_deadline(|| panic!("boom"), DECODE_TIMEOUT).unwrap_err();
        assert!(err.contains("decoder panicked: boom"), "{err}");
        // What the vendored rav1d's entry points are: a panic crosses an
        // `extern "C-unwind"` frame (through `extern "C"` it would abort).
        extern "C-unwind" fn entry_point(n: u32) -> u32 {
            if n > 0 {
                panic!("panic {n} through C-unwind");
            }
            n
        }
        let err = run_with_deadline(|| Ok((entry_point(7), 0, vec![])), DECODE_TIMEOUT).unwrap_err();
        assert!(err.contains("panic 7 through C-unwind"), "{err}");
        // A decode that never returns is abandoned at the deadline (its
        // thread sleeps on, leaked, until the test binary exits).
        let start = Instant::now();
        let err = run_with_deadline(
            || loop {
                std::thread::sleep(Duration::from_secs(1));
            },
            Duration::from_millis(200),
        )
        .unwrap_err();
        assert!(err.contains("timed out"), "{err}");
        assert!(start.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn items_with_many_frames_are_refused() {
        let item = swatch_item();
        assert_eq!(count_frame_headers(&item), 1);
        // Temporal delimiter, then frame-header OBUs (`show_existing_frame`
        // sized, two bytes each, with size fields).
        let mut many = vec![0x12, 0x00];
        many.extend_from_slice(&item);
        for _ in 0..MAX_FRAMES_PER_ITEM {
            many.extend_from_slice(&[0x1a, 0x01, 0x80]);
        }
        assert_eq!(count_frame_headers(&many), MAX_FRAMES_PER_ITEM + 1);
        let err = decode_rgba8(&swatch_with_item(&many)).unwrap_err();
        assert!(err.contains("frame headers"), "{err}");
        // Walking stops at a truncated size field; no size field means
        // the rest of the item.
        assert_eq!(count_frame_headers(&[0x32, 0x80]), 1);
        assert_eq!(count_frame_headers(&[0x30, 0x32, 0x00]), 1);
        assert_eq!(count_frame_headers(&[]), 0);
    }

    #[test]
    fn truncated_files_fail_instead_of_panicking() {
        for len in [0, 16, 64, SWATCH.len() / 2, SWATCH.len() - 1] {
            assert!(decode_rgba8(&SWATCH[..len]).is_err(), "len {len}");
        }
    }
}
