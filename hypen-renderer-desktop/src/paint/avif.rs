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

/// Largest frame (in pixels) the decoder accepts: a hostile file can't
/// make it allocate more than a 16k×16k picture.
const MAX_FRAME_PIXELS: u32 = 16384 * 16384;

/// Whether `bytes` is an AVIF file: an ISO-BMFF `ftyp` box whose major
/// or compatible brands include `avif` (still) or `avis` (sequence).
pub(crate) fn looks_like_avif(bytes: &[u8]) -> bool {
    if bytes.len() < 16 || &bytes[4..8] != b"ftyp" {
        return false;
    }
    let size = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
    let end = size.clamp(16, bytes.len());
    // Major brand at 8..12, minor version at 12..16, compatible brands after.
    std::iter::once(&bytes[8..12])
        .chain(
            bytes[16..end]
                .as_chunks::<4>()
                .0
                .iter()
                .map(|brand| &brand[..]),
        )
        .any(|brand| brand == b"avif" || brand == b"avis")
}

/// Decode an AVIF file's primary image (and its alpha item, if any) to
/// straight-alpha RGBA8. Returns `(width, height, pixels)`.
pub(crate) fn decode_rgba8(bytes: &[u8]) -> Result<(u32, u32, Vec<u8>), String> {
    // Image bytes come from remote servers; a malformed file must fail
    // its own decode, not take the image worker thread down with it
    // (avif-parse asserts on some inconsistent box layouts).
    std::panic::catch_unwind(|| decode_unguarded(bytes))
        .unwrap_or_else(|_| Err("malformed AVIF (decoder panicked)".into()))
}

fn decode_unguarded(bytes: &[u8]) -> Result<(u32, u32, Vec<u8>), String> {
    let avif =
        avif_parse::read_avif(&mut &bytes[..]).map_err(|e| format!("AVIF container: {e}"))?;
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

/// One rav1d context, closed on drop. Holds the last decoded picture so
/// the [`Frame`] borrowing it stays valid.
struct Decoder {
    ctx: Option<Dav1dContext>,
    picture: Option<Dav1dPicture>,
}

impl Decoder {
    fn new() -> Result<Self, String> {
        let mut settings = MaybeUninit::<Dav1dSettings>::uninit();
        // SAFETY: `dav1d_default_settings` initialises every field of the
        // struct it is handed.
        let mut settings = unsafe {
            dav1d_default_settings(NonNull::from(&mut settings).cast());
            settings.assume_init()
        };
        // Still images: one frame, so no frame pipelining; tiles still
        // decode in parallel. Film grain is part of the picture (browsers
        // synthesise it too).
        settings.n_threads = std::thread::available_parallelism()
            .map_or(4, |n| n.get())
            .min(8) as _;
        settings.max_frame_delay = 1;
        settings.apply_grain = 1;
        settings.frame_size_limit = MAX_FRAME_PIXELS;
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

    #[test]
    fn truncated_files_fail_instead_of_panicking() {
        for len in [0, 16, 64, SWATCH.len() / 2, SWATCH.len() - 1] {
            assert!(decode_rgba8(&SWATCH[..len]).is_err(), "len {len}");
        }
    }
}
