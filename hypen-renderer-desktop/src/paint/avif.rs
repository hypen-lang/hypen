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
//! path). Its entry points are `extern "C"`, so such a panic can't be
//! caught: it aborts the process. On Unix every decode therefore runs in
//! a forked child (see [`isolated`]) that hands the pixels back over a
//! pipe; a child that crashes or exceeds [`DECODE_TIMEOUT`] is killed
//! and the decode fails, and the image worker carries on. Elsewhere the
//! decode runs in-process under `catch_unwind`, which only covers panics
//! outside rav1d. rav1d runs single-threaded (see [`decoder_settings`]),
//! so nothing is left waiting on a decoder thread that died.

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

/// Longest a decode may take before it is abandoned (the forked child
/// is killed). Generous: a debug build decodes a 4K frame on one thread
/// in a few seconds.
const DECODE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

type Rgba8 = (u32, u32, Vec<u8>);

/// Decode an AVIF file's primary image (and its alpha item, if any) to
/// straight-alpha RGBA8. Returns `(width, height, pixels)`.
///
/// A malformed file fails its own decode; it can't take the image
/// worker (or, through rav1d's non-unwinding entry points, the whole
/// process) down with it. See the module docs.
pub(crate) fn decode_rgba8(bytes: &[u8]) -> Result<Rgba8, String> {
    // Refuse what isn't a decodable still before paying for a fork.
    avif_kind(bytes).ok_or("not an AVIF file")?;
    #[cfg(unix)]
    {
        isolated::run(|| decode_in_process(bytes), DECODE_TIMEOUT)
    }
    #[cfg(not(unix))]
    {
        decode_in_process(bytes)
    }
}

fn decode_in_process(bytes: &[u8]) -> Result<Rgba8, String> {
    // avif-parse asserts on some inconsistent box layouts.
    std::panic::catch_unwind(|| decode_unguarded(bytes))
        .unwrap_or_else(|_| Err("malformed AVIF (decoder panicked)".into()))
}

/// Run a decode in a forked child process.
///
/// The child runs only the calling thread's closure (no other thread
/// of the parent exists there), writes the result to a pipe, and
/// `_exit`s without running destructors or `atexit` handlers. The
/// parent reads the result with a deadline. A child that aborts (a
/// panic in rav1d), dies, or overruns the deadline is reaped (killed
/// first if needed) and the decode fails with the reason.
///
/// The memory budget still holds: the child's peak is the decode's
/// (see [`MAX_DECODE_BYTES`]); the parent only ever allocates the
/// RGBA8 result, whose size it checks against the frame limit before
/// reading it.
#[cfg(unix)]
pub(crate) mod isolated {
    use super::Rgba8;
    use std::time::{Duration, Instant};

    const TAG_OK: u8 = 0;
    const TAG_ERR: u8 = 1;

    pub(crate) fn run(
        decode: impl FnOnce() -> Result<Rgba8, String>,
        timeout: Duration,
    ) -> Result<Rgba8, String> {
        let mut fds = [0; 2];
        // SAFETY: `fds` is a two-element array, as `pipe` requires.
        if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
            return Err(format!("AVIF decode: pipe failed ({})", std::io::Error::last_os_error()));
        }
        let (rd, wr) = (fds[0], fds[1]);
        for fd in fds {
            // Keep the pipe out of processes other threads spawn meanwhile.
            // SAFETY: `fd` is an open descriptor we own.
            unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) };
        }
        // SAFETY: the child only runs `child` below, which ends in
        // `_exit`; the parent continues normally.
        match unsafe { libc::fork() } {
            -1 => {
                let err = std::io::Error::last_os_error();
                // SAFETY: both descriptors are open and ours.
                unsafe {
                    libc::close(rd);
                    libc::close(wr);
                }
                Err(format!("AVIF decode: fork failed ({err})"))
            }
            0 => {
                // SAFETY: the read end is ours; `child` never returns.
                unsafe { libc::close(rd) };
                child(wr, decode)
            }
            pid => {
                // SAFETY: the write end belongs to the child now.
                unsafe { libc::close(wr) };
                let result = read_result(rd, Instant::now() + timeout);
                // SAFETY: `rd` is open and ours.
                unsafe { libc::close(rd) };
                let status = reap(pid, result.is_err());
                result.map_err(|e| match status {
                    Some(status) if libc::WIFSIGNALED(status) => format!(
                        "malformed AVIF (decoder crashed: signal {}; {e})",
                        libc::WTERMSIG(status)
                    ),
                    _ => e,
                })
            }
        }
    }

    fn child(wr: libc::c_int, decode: impl FnOnce() -> Result<Rgba8, String>) -> ! {
        let mut msg = Vec::new();
        match decode() {
            Ok((w, h, pixels)) => {
                msg.push(TAG_OK);
                msg.extend_from_slice(&w.to_le_bytes());
                msg.extend_from_slice(&h.to_le_bytes());
                // The pixels follow the header in a second write, unbuffered.
                write_all(wr, &msg);
                write_all(wr, &pixels);
            }
            Err(e) => {
                msg.push(TAG_ERR);
                msg.extend_from_slice(e.as_bytes());
                write_all(wr, &msg);
            }
        }
        // SAFETY: ends the forked child without unwinding into (or
        // running destructors of) state copied from the parent.
        unsafe { libc::_exit(0) }
    }

    fn write_all(fd: libc::c_int, mut buf: &[u8]) {
        while !buf.is_empty() {
            // SAFETY: `buf` is a live slice of `buf.len()` bytes.
            let n = unsafe { libc::write(fd, buf.as_ptr().cast(), buf.len()) };
            if n < 0 {
                if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
                return;
            }
            buf = &buf[n as usize..];
        }
    }

    /// Fill `buf` from `fd` by `deadline`; returns the bytes read, short
    /// only when the child closed the pipe (exited or died) first.
    fn read_exact(fd: libc::c_int, buf: &mut [u8], deadline: Instant) -> Result<usize, String> {
        let mut filled = 0;
        while filled < buf.len() {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err("AVIF decode timed out".into());
            }
            let mut pfd = libc::pollfd { fd, events: libc::POLLIN, revents: 0 };
            let ms = left.as_millis().clamp(1, i32::MAX as u128) as libc::c_int;
            // SAFETY: one live `pollfd`.
            let ready = unsafe { libc::poll(&mut pfd, 1, ms) };
            if ready < 0 {
                if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(format!("AVIF decode: poll failed ({})", std::io::Error::last_os_error()));
            }
            if ready == 0 {
                continue; // deadline re-checked above
            }
            let rest = &mut buf[filled..];
            // SAFETY: `rest` is a live, writable slice of `rest.len()` bytes.
            let n = unsafe { libc::read(fd, rest.as_mut_ptr().cast(), rest.len()) };
            if n < 0 {
                if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(format!("AVIF decode: read failed ({})", std::io::Error::last_os_error()));
            }
            if n == 0 {
                break; // EOF
            }
            filled += n as usize;
        }
        Ok(filled)
    }

    fn read_result(fd: libc::c_int, deadline: Instant) -> Result<Rgba8, String> {
        let mut tag = [0u8; 1];
        if read_exact(fd, &mut tag, deadline)? == 0 {
            return Err("malformed AVIF (decoder exited without a result)".into());
        }
        if tag[0] == TAG_ERR {
            let mut msg = Vec::new();
            let mut chunk = [0u8; 256];
            loop {
                let n = read_exact(fd, &mut chunk, deadline)?;
                msg.extend_from_slice(&chunk[..n]);
                if n < chunk.len() || msg.len() > 4096 {
                    break;
                }
            }
            return Err(String::from_utf8_lossy(&msg).into_owned());
        }
        let mut size = [0u8; 8];
        if read_exact(fd, &mut size, deadline)? != size.len() {
            return Err("malformed AVIF (decoder died mid-result)".into());
        }
        let w = u32::from_le_bytes(size[..4].try_into().unwrap());
        let h = u32::from_le_bytes(size[4..].try_into().unwrap());
        if u64::from(w) * u64::from(h) > u64::from(super::MAX_FRAME_PIXELS) {
            return Err("AVIF decode returned an oversized frame".into());
        }
        let len = w as usize * h as usize * 4;
        let mut pixels = Vec::new();
        pixels
            .try_reserve_exact(len)
            .map_err(|_| "AVIF too large to decode".to_string())?;
        pixels.resize(len, 0);
        if read_exact(fd, &mut pixels, deadline)? != len {
            return Err("malformed AVIF (decoder died mid-result)".into());
        }
        Ok((w, h, pixels))
    }

    /// Wait for the child (killing it first when `kill` is set or it
    /// outlives a short grace period) and return its wait status.
    /// `None` when it can't be reaped (e.g. the host ignores SIGCHLD).
    fn reap(pid: libc::pid_t, kill: bool) -> Option<libc::c_int> {
        let mut status = 0;
        if !kill {
            // It has written its result and is exiting; give it a moment.
            let grace = Instant::now() + Duration::from_millis(500);
            while Instant::now() < grace {
                // SAFETY: `pid` is our child; `status` is a live int.
                match unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) } {
                    0 => std::thread::sleep(Duration::from_millis(1)),
                    r if r == pid => return Some(status),
                    _ => return None,
                }
            }
        }
        // SAFETY: `pid` is our child, not yet reaped.
        unsafe { libc::kill(pid, libc::SIGKILL) };
        loop {
            // SAFETY: as above.
            let r = unsafe { libc::waitpid(pid, &mut status, 0) };
            if r == pid {
                return Some(status);
            }
            if r < 0 && std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return None;
        }
    }
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
/// calling thread, so a panic on a malformed bitstream can't kill a
/// rav1d worker that the caller then waits on forever (and in the
/// forked child of [`isolated`], the decode is the only thread). Still
/// images have one frame, so there is no frame pipelining to lose
/// either; the cost is tile parallelism, on a thread that is already
/// off the paint path. Film grain is part of the picture (browsers
/// synthesise it too).
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
        self.release_picture();
        // SAFETY: closes the context opened in `new` (no-op when `None`).
        unsafe { dav1d_close(Some(NonNull::from(&mut self.ctx))) };
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
        // No rav1d worker threads: `catch_unwind` sees every panic.
        let settings = decoder_settings();
        assert_eq!(settings.n_threads, 1);
        assert_eq!(settings.max_frame_delay, 1);
    }

    #[cfg(unix)]
    #[test]
    fn isolated_decode_survives_abort_and_hang() {
        use std::time::{Duration, Instant};
        let ok = isolated::run(|| Ok((2, 1, vec![1, 2, 3, 4, 5, 6, 7, 8])), DECODE_TIMEOUT);
        assert_eq!(ok, Ok((2, 1, vec![1, 2, 3, 4, 5, 6, 7, 8])));
        let err = isolated::run(|| Err("nope".into()), DECODE_TIMEOUT);
        assert_eq!(err, Err("nope".to_string()));
        // What a panic inside rav1d's `extern "C"` entry points does.
        let err = isolated::run(|| std::process::abort(), DECODE_TIMEOUT).unwrap_err();
        assert!(err.contains("crashed"), "{err}");
        // A decoder that never returns is killed at the deadline.
        let start = Instant::now();
        let err = isolated::run(
            || loop {
                std::thread::sleep(Duration::from_secs(1));
            },
            Duration::from_millis(300),
        )
        .unwrap_err();
        assert!(err.contains("timed out"), "{err}");
        assert!(start.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn malformed_bitstreams_never_stall_the_caller() {
        // Corrupt the swatch's AV1 payload (bit flips, garbage runs,
        // truncation) and decode each variant; every one must come back
        // (decoded or an error), never panic out or hang. Run on a
        // separate thread with a deadline so a hang fails the test
        // instead of stalling the suite.
        let item = {
            let mdat = SWATCH.windows(4).position(|w| w == b"mdat").unwrap() - 4;
            SWATCH[mdat + 8..].to_vec()
        };
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut seed = 0x2545_f491_4f6c_dd1du64;
            let mut next = move || {
                seed ^= seed << 13;
                seed ^= seed >> 7;
                seed ^= seed << 17;
                seed
            };
            let mut outcomes = (0usize, 0usize);
            for round in 0..160 {
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
                match decode_rgba8(&swatch_with_item(&bad)) {
                    Ok(_) => outcomes.0 += 1,
                    Err(_) => outcomes.1 += 1,
                }
            }
            let _ = tx.send(outcomes);
        });
        let (ok, err) = rx
            .recv_timeout(std::time::Duration::from_secs(120))
            .expect("a malformed AVIF stalled the decoder");
        assert_eq!(ok + err, 160);
        assert!(err > 0, "corruption is noticed at least sometimes");
    }

    #[test]
    fn truncated_files_fail_instead_of_panicking() {
        for len in [0, 16, 64, SWATCH.len() / 2, SWATCH.len() - 1] {
            assert!(decode_rgba8(&SWATCH[..len]).is_err(), "len {len}");
        }
    }
}
