//! Image / Icon bitmap loading and painting.
//!
//! Phase 13 ships local file decoding. Phase 14 adds HTTP fetching:
//! the cache promotes from `Mutex<HashMap<String, Option<Pixmap>>>`
//! to a state machine (`Loading | Loaded | Failed`); HTTP / HTTPS
//! sources get queued on a single dedicated worker thread that
//! fetches with `ureq` + decodes with `image`. When a fetch lands,
//! the worker fires an `AppEvent::Wake` through the renderer's
//! winit `EventLoopProxy` so the next paint picks the bitmap up.

use crate::layout::Rect as LayoutRect;
use crate::style::Rgba;
use crate::window::AppEvent;
use std::collections::HashMap;
#[allow(unused_imports)]
use std::collections::hash_map;
use std::io::Read;
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tiny_skia::{
    Color, FillRule, IntSize, Mask, Paint, PathBuilder, Pixmap, PixmapPaint, PixmapRef, Rect,
    Transform,
};
use winit::event_loop::EventLoopProxy;

/// One slot in the image cache.
#[derive(Debug)]
pub(crate) enum CacheEntry {
    /// Worker has been told about this src; result not yet back.
    /// Painter renders the placeholder for now.
    Loading,
    /// Source decoded successfully; bitmap ready for `draw_pixmap`.
    Loaded(Pixmap),
    /// Source can't be loaded (missing file, decode error, network
    /// failure). Cache stays this way so we don't retry every frame.
    Failed,
}

/// Process-global cache. Created on first access; the worker thread
/// is spawned at the same time and lives for the process lifetime.
pub(crate) struct ImageCache {
    pub(crate) entries: Mutex<HashMap<String, CacheEntry>>,
    /// URLs awaiting HTTP fetch. Local files decode synchronously on
    /// the calling thread.
    work_tx: mpsc::Sender<String>,
    /// Set once when the renderer starts; lets the worker wake the
    /// event loop when a fetch completes. None means tests / offline
    /// embedders — the cache still works, paints just won't refresh
    /// until the next external event triggers a redraw.
    waker: Mutex<Option<EventLoopProxy<AppEvent>>>,
}

fn cache() -> &'static ImageCache {
    static CACHE: OnceLock<ImageCache> = OnceLock::new();
    CACHE.get_or_init(|| {
        let (work_tx, work_rx) = mpsc::channel::<String>();
        std::thread::Builder::new()
            .name("hypen-image-fetch".into())
            .spawn(move || run_image_worker(work_rx))
            .expect("spawn hypen-image-fetch worker");
        ImageCache {
            entries: Mutex::new(HashMap::new()),
            work_tx,
            waker: Mutex::new(None),
        }
    })
}

/// Register the renderer's event-loop proxy so the worker can wake
/// the window when an HTTP fetch completes. Idempotent — calling
/// twice replaces the proxy, which is fine for tests.
pub fn set_waker(proxy: EventLoopProxy<AppEvent>) {
    *cache().waker.lock().expect("image cache waker poisoned") = Some(proxy);
}

/// Cap on the per-rect image render cache. Sized to comfortably hold
/// every Image visible on a busy feed *plus* enough off-screen slack
/// to scroll past one screenful without wholesale eviction. Each
/// entry holds a tile sized to the laid-out rect; we cap individual
/// tiles at `MAX_TILE_DIM` so a single huge image can't blow memory.
const IMAGE_RENDER_CACHE_CAP: usize = 256;
/// Cap on the longest side of any cached tile in physical pixels.
/// Past this we render at a smaller intrinsic size and let the
/// composite upscale via tiny-skia's bilinear sampler. Avoids 9 MB+
/// tiles on 100%-width post body images at HiDPI, where building
/// the alpha mask + scaling 2 M+ pixels per cache miss was the
/// dominant cost during scroll.
const MAX_TILE_DIM: u32 = 768;

/// Per-painter cache of pre-scaled + masked image pixmaps. Keyed on
/// `(src, tile_w, tile_h, fit, radius)` — note `tile_w/h` after the
/// `MAX_TILE_DIM` cap, not the requested rect's full size. On cache
/// hit, painting an Image becomes a single `draw_pixmap` (with
/// optional bilinear up-scale when the cap kicked in).
#[derive(Default)]
pub struct ImageRenderCache {
    /// Insertion-ordered for FIFO eviction at `IMAGE_RENDER_CACHE_CAP`.
    /// Single-entry eviction keeps cache churn proportional to
    /// inserts instead of dropping wholesale on overflow.
    entries: indexmap::IndexMap<u64, Pixmap>,
}

impl ImageRenderCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn clear(&mut self) {
        self.entries.clear();
    }
}

/// Paint `src` (a path or URL) inside `rect` on `pixmap`. Falls back
/// to a placeholder rectangle when src is missing, still loading, or
/// permanently failed. Backwards-compatible wrapper around
/// [`paint_image_cached`] for the test suite + any external callers
/// that haven't moved to the cache yet.
pub fn paint_image(
    pixmap: &mut Pixmap,
    rect: LayoutRect,
    src: Option<&str>,
    scale_factor: f32,
    radius: f32,
    fit: crate::layout::ObjectFit,
) {
    let mut cache = ImageRenderCache::new();
    paint_image_cached(pixmap, rect, src, scale_factor, radius, fit, &mut cache);
}

/// Same as [`paint_image`] but composites a pre-rasterised tile from
/// `tile_cache` when one exists. Cache miss does the full scale + mask
/// pipeline once into a tile, stores it, and composites.
pub fn paint_image_cached(
    pixmap: &mut Pixmap,
    rect: LayoutRect,
    src: Option<&str>,
    scale_factor: f32,
    radius: f32,
    fit: crate::layout::ObjectFit,
    tile_cache: &mut ImageRenderCache,
) {
    let target_w = rect.w.ceil().max(1.0) as u32;
    let target_h = rect.h.ceil().max(1.0) as u32;
    // Cap the tile's longest side at `MAX_TILE_DIM`. The cache is
    // keyed on the *capped* size, so we don't store giant tiles for
    // 100%-width post body images. Composite uses tiny-skia's
    // bilinear sampler to upscale back to `(target_w, target_h)`.
    let scale_to_tile = (MAX_TILE_DIM as f32 / target_w.max(target_h) as f32).min(1.0);
    let cw = ((target_w as f32) * scale_to_tile).ceil().max(1.0) as u32;
    let ch = ((target_h as f32) * scale_to_tile).ceil().max(1.0) as u32;
    let upscaled = scale_to_tile < 1.0;
    if let Some(s) = src {
        let key = render_cache_key(s, cw, ch, fit, radius);
        if let Some(tile) = tile_cache.entries.get(&key) {
            composite_tile(pixmap, tile, rect, upscaled);
            return;
        }
    }
    let bitmap_data: Option<(Vec<u8>, u32, u32)> = src.and_then(|s| {
        ensure_loaded(s);
        let entries = cache().entries.lock().expect("image cache poisoned");
        match entries.get(s) {
            Some(CacheEntry::Loaded(pm)) => {
                Some((pm.data().to_vec(), pm.width(), pm.height()))
            }
            _ => None,
        }
    });

    if let Some((data, w, h)) = bitmap_data {
        let size = IntSize::from_wh(w, h).expect("non-zero source size");
        let pm =
            Pixmap::from_vec(data, size).expect("source bitmap matches RGBA layout");
        // Render into a tile-sized scratch pixmap so the (scale +
        // mask) pipeline runs once per `(src, target_size, fit,
        // radius)` tuple instead of once per frame. Tile size is the
        // requested rect's size in physical pixels.
        let mut tile = match Pixmap::new(cw, ch) {
            Some(p) => p,
            None => {
                paint_placeholder(pixmap, rect, scale_factor);
                return;
            }
        };
        // Resolve object-fit into per-axis scale + centring offsets,
        // expressed against the tile origin (0, 0)..(cw, ch).
        let sx = cw as f32 / w as f32;
        let sy = ch as f32 / h as f32;
        let (sx, sy) = match fit {
            crate::layout::ObjectFit::Fill => (sx, sy),
            crate::layout::ObjectFit::Cover => {
                let s = sx.max(sy);
                (s, s)
            }
            crate::layout::ObjectFit::Contain => {
                let s = sx.min(sy);
                (s, s)
            }
            crate::layout::ObjectFit::None => (1.0, 1.0),
        };
        let dx = (cw as f32 - w as f32 * sx) * 0.5;
        let dy = (ch as f32 - h as f32 * sy) * 0.5;
        let transform = Transform::from_scale(sx, sy).post_translate(dx, dy);
        let paint = PixmapPaint {
            quality: tiny_skia::FilterQuality::Bilinear,
            ..PixmapPaint::default()
        };
        // Mask is built against the tile's local coordinates so it
        // stays valid for any future composite location.
        let mask = if radius > 0.0 {
            build_rounded_rect_mask(
                cw,
                ch,
                LayoutRect { x: 0.0, y: 0.0, w: cw as f32, h: ch as f32 },
                radius,
            )
        } else {
            None
        };
        tile.draw_pixmap(
            0,
            0,
            PixmapRef::from_bytes(pm.data(), w, h).expect("pixmap bytes valid"),
            &paint,
            transform,
            mask.as_ref(),
        );
        // Cache the tile keyed on what fed it. FIFO-evict ONE entry
        // when over cap so churn is proportional to inserts instead
        // of dropping wholesale (which previously caused full re-
        // render storms on long feeds).
        if let Some(s) = src {
            if tile_cache.entries.len() >= IMAGE_RENDER_CACHE_CAP {
                tile_cache.entries.shift_remove_index(0);
            }
            let key = render_cache_key(s, cw, ch, fit, radius);
            tile_cache.entries.insert(key, tile);
            let tile = tile_cache.entries.get(&key).expect("just inserted");
            composite_tile(pixmap, tile, rect, upscaled);
        } else {
            composite_tile(pixmap, &tile, rect, upscaled);
        }
        return;
    }

    paint_placeholder(pixmap, rect, scale_factor);
}

/// Composite `tile` onto `pixmap` at `rect`. When `upscaled` is true,
/// the tile's intrinsic size is smaller than `rect` (the per-side
/// `MAX_TILE_DIM` cap kicked in) and tiny-skia's bilinear sampler
/// scales it up at composite time.
fn composite_tile(
    pixmap: &mut Pixmap,
    tile: &Pixmap,
    rect: LayoutRect,
    upscaled: bool,
) {
    let transform = if upscaled {
        let sx = rect.w / tile.width() as f32;
        let sy = rect.h / tile.height() as f32;
        Transform::from_scale(sx, sy).post_translate(rect.x.round(), rect.y.round())
    } else {
        Transform::from_translate(rect.x.round(), rect.y.round())
    };
    let paint = if upscaled {
        PixmapPaint {
            quality: tiny_skia::FilterQuality::Bilinear,
            ..PixmapPaint::default()
        }
    } else {
        PixmapPaint::default()
    };
    pixmap.draw_pixmap(
        0,
        0,
        PixmapRef::from_bytes(tile.data(), tile.width(), tile.height())
            .expect("tile bytes valid"),
        &paint,
        transform,
        None,
    );
}

fn render_cache_key(
    src: &str,
    w: u32,
    h: u32,
    fit: crate::layout::ObjectFit,
    radius: f32,
) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    src.hash(&mut hasher);
    w.hash(&mut hasher);
    h.hash(&mut hasher);
    (fit as u8).hash(&mut hasher);
    radius.to_bits().hash(&mut hasher);
    hasher.finish()
}

/// Build a `Mask` of `surface_w × surface_h` whose alpha is opaque
/// only inside the rounded rect described by `rect` + `radius`. Used
/// to clip bitmap draws to circular / rounded shapes.
fn build_rounded_rect_mask(
    surface_w: u32,
    surface_h: u32,
    rect: LayoutRect,
    radius: f32,
) -> Option<Mask> {
    let mut mask = Mask::new(surface_w, surface_h)?;
    let path = rounded_rect_path(rect.x, rect.y, rect.w, rect.h, radius)?;
    mask.fill_path(&path, FillRule::Winding, true, Transform::identity());
    Some(mask)
}

/// Trigger a load if we haven't seen this src before. Local file
/// paths decode synchronously (first paint pays the cost, subsequent
/// paints hit the cache). HTTP / HTTPS URLs queue on the worker
/// thread and the entry sits in `Loading` until the worker reports
/// back.
fn ensure_loaded(src: &str) {
    {
        let entries = cache().entries.lock().expect("image cache poisoned");
        if entries.contains_key(src) {
            return;
        }
    }
    if is_http(src) {
        // Mark Loading and ask the worker to fetch.
        cache()
            .entries
            .lock()
            .expect("image cache poisoned")
            .insert(src.to_string(), CacheEntry::Loading);
        // The worker channel is unbounded-ish (std mpsc); a send only
        // fails if the receiver has dropped, which only happens at
        // process tear-down. Log + leave the entry as Loading so the
        // placeholder paints — we won't retry in this run.
        if let Err(e) = cache().work_tx.send(src.to_string()) {
            log::warn!("image: worker channel closed: {e}");
        }
        return;
    }
    // Local file — decode synchronously.
    let entry = match decode_local(src) {
        Some(pm) => CacheEntry::Loaded(pm),
        None => CacheEntry::Failed,
    };
    cache()
        .entries
        .lock()
        .expect("image cache poisoned")
        .insert(src.to_string(), entry);
}

fn is_http(src: &str) -> bool {
    src.starts_with("http://") || src.starts_with("https://")
}

/// Worker loop. Receives URLs on the channel, fetches + decodes each,
/// stores the result in the cache, then nudges the event loop.
fn run_image_worker(rx: mpsc::Receiver<String>) {
    while let Ok(url) = rx.recv() {
        let entry = match fetch_and_decode(&url) {
            Some(pm) => CacheEntry::Loaded(pm),
            None => CacheEntry::Failed,
        };
        cache()
            .entries
            .lock()
            .expect("image cache poisoned")
            .insert(url, entry);
        // Best-effort wake. If no proxy was registered (tests / no
        // window yet), the next external event will drive the redraw.
        if let Some(proxy) = cache()
            .waker
            .lock()
            .expect("image cache waker poisoned")
            .as_ref()
        {
            let _ = proxy.send_event(AppEvent::Wake);
        }
    }
}

/// Fetch + decode an HTTP / HTTPS URL via `ureq`. Returns `None` on
/// any failure (timeout, non-2xx, decode error, oversize body).
fn fetch_and_decode(url: &str) -> Option<Pixmap> {
    let response = match ureq::get(url)
        .timeout(Duration::from_secs(10))
        .call()
    {
        Ok(r) => r,
        Err(e) => {
            log::warn!("image: HTTP failed for {url}: {e}");
            return None;
        }
    };
    let mut bytes = Vec::with_capacity(64 * 1024);
    // 20 MB hard cap per image. Keeps a misbehaving server from
    // wedging the worker thread on a giant body.
    if let Err(e) = response.into_reader().take(20 * 1024 * 1024).read_to_end(&mut bytes) {
        log::warn!("image: read failed for {url}: {e}");
        return None;
    }
    decode_bytes(&bytes, url)
}

/// Decode a local file path (raw or `file://`-prefixed). HTTP URLs
/// return `None` here so the caller routes them to the worker.
pub(crate) fn decode_local(src: &str) -> Option<Pixmap> {
    if is_http(src) {
        log::debug!("image: HTTP src queued for worker (not local): {src}");
        return None;
    }
    let path = src.strip_prefix("file://").unwrap_or(src);
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) => {
            log::warn!("image: failed reading {path}: {e}");
            return None;
        }
    };
    decode_bytes(&bytes, path)
}

/// Shared codec path: bytes → RGBA8 → premultiplied → tiny-skia
/// pixmap. Used by both local decode and worker fetch.
fn decode_bytes(bytes: &[u8], debug_label: &str) -> Option<Pixmap> {
    let img = match image::load_from_memory(bytes) {
        Ok(d) => d,
        Err(e) => {
            log::warn!("image: failed decoding {debug_label}: {e}");
            return None;
        }
    };
    let rgba = img.to_rgba8();
    let (w, h) = rgba.dimensions();
    let size = IntSize::from_wh(w, h)?;
    let mut data = rgba.into_raw();
    // image gives us straight alpha; tiny-skia wants premultiplied.
    for px in data.chunks_exact_mut(4) {
        let a = px[3] as u32;
        px[0] = ((px[0] as u32 * a + 127) / 255) as u8;
        px[1] = ((px[1] as u32 * a + 127) / 255) as u8;
        px[2] = ((px[2] as u32 * a + 127) / 255) as u8;
    }
    Pixmap::from_vec(data, size)
}

fn paint_placeholder(pixmap: &mut Pixmap, rect: LayoutRect, scale: f32) {
    if rect.w <= 0.0 || rect.h <= 0.0 {
        return;
    }
    let radius = 6.0 * scale;
    if let Some(path) = rounded_rect_path(rect.x, rect.y, rect.w, rect.h, radius) {
        let placeholder = Rgba(0xe5, 0xe7, 0xeb, 0xff);
        let mut paint = Paint::default();
        let [r, g, b, a] = placeholder.premultiplied();
        paint.set_color(
            Color::from_rgba(
                r as f32 / 255.0,
                g as f32 / 255.0,
                b as f32 / 255.0,
                a as f32 / 255.0,
            )
            .unwrap_or(Color::BLACK),
        );
        paint.anti_alias = true;
        pixmap.fill_path(
            &path,
            &paint,
            FillRule::Winding,
            Transform::identity(),
            None,
        );
    }
}

fn rounded_rect_path(x: f32, y: f32, w: f32, h: f32, r: f32) -> Option<tiny_skia::Path> {
    if w <= 0.0 || h <= 0.0 {
        return None;
    }
    let rect = Rect::from_xywh(x, y, w, h)?;
    if r <= 0.0 {
        let mut pb = PathBuilder::new();
        pb.push_rect(rect);
        return pb.finish();
    }
    // CSS `border-radius: 50%` (or any radius >= half the longer
    // side) means *ellipse*, not stadium. When the requested radius
    // exceeds `min(w, h) / 2` AND the shape isn't square, use
    // separate `rx = w/2`, `ry = h/2` so a `rounded-full` ring on
    // a non-square element still encloses an ellipse rather than a
    // capsule.
    const K: f32 = 0.5522847498307936;
    let max_corner = w.min(h) * 0.5;
    let (rx, ry) = if r >= max_corner {
        (w * 0.5, h * 0.5)
    } else {
        (r, r)
    };
    let cx = rx * K;
    let cy = ry * K;
    let mut pb = PathBuilder::new();
    pb.move_to(x + rx, y);
    pb.line_to(x + w - rx, y);
    pb.cubic_to(x + w - rx + cx, y, x + w, y + ry - cy, x + w, y + ry);
    pb.line_to(x + w, y + h - ry);
    pb.cubic_to(x + w, y + h - ry + cy, x + w - rx + cx, y + h, x + w - rx, y + h);
    pb.line_to(x + rx, y + h);
    pb.cubic_to(x + rx - cx, y + h, x, y + h - ry + cy, x, y + h - ry);
    pb.line_to(x, y + ry);
    pb.cubic_to(x, y + ry - cy, x + rx - cx, y, x + rx, y);
    pb.close();
    pb.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http_urls_are_classified_correctly() {
        assert!(is_http("http://example.com/a.png"));
        assert!(is_http("https://example.com/a.png"));
        assert!(!is_http("/tmp/a.png"));
        assert!(!is_http("file:///tmp/a.png"));
        assert!(!is_http("data:image/png;base64,..."));
    }

    #[test]
    fn decode_local_skips_http_urls() {
        // `decode_local` is the synchronous local-file path; HTTP
        // queries return None so the worker can pick them up.
        assert!(decode_local("http://example.com/x.png").is_none());
        assert!(decode_local("https://example.com/x.png").is_none());
    }

    #[test]
    fn decode_local_returns_none_for_missing_file() {
        assert!(decode_local("/tmp/__hypen_test_does_not_exist_xyz.png").is_none());
    }

    #[test]
    fn ensure_loaded_marks_http_urls_as_loading_and_queues_them() {
        // We can't run the actual worker reliably in tests, but we
        // can verify the bookkeeping: an unseen HTTP URL flips to
        // `Loading` immediately and the entry stays put across
        // repeated `ensure_loaded` calls (no double-queueing).
        let url = "http://hypen-test.invalid/cache-loading-state.png";
        // Clear any prior state from earlier tests.
        cache().entries.lock().unwrap().remove(url);

        ensure_loaded(url);
        {
            let entries = cache().entries.lock().unwrap();
            assert!(matches!(entries.get(url), Some(CacheEntry::Loading)));
        }
        // Second call should be a no-op (early return on contains_key).
        ensure_loaded(url);
        {
            let entries = cache().entries.lock().unwrap();
            assert!(matches!(entries.get(url), Some(CacheEntry::Loading)));
        }
    }

    #[test]
    fn ensure_loaded_caches_local_miss_as_failed() {
        let key = "/tmp/__hypen_test_local_miss_caches_failed.png";
        cache().entries.lock().unwrap().remove(key);
        ensure_loaded(key);
        let entries = cache().entries.lock().unwrap();
        assert!(matches!(entries.get(key), Some(CacheEntry::Failed)));
    }

    #[test]
    fn paint_image_falls_back_to_placeholder_when_unloadable() {
        let mut pm = Pixmap::new(64, 64).unwrap();
        pm.fill(Color::WHITE);
        let before = pm.data().to_vec();
        let rect = LayoutRect {
            x: 4.0,
            y: 4.0,
            w: 56.0,
            h: 56.0,
        };
        paint_image(
            &mut pm,
            rect,
            Some("/no/such/file.png"),
            1.0,
            0.0,
            crate::layout::ObjectFit::Fill,
        );
        assert_ne!(
            pm.data(),
            before.as_slice(),
            "placeholder must paint pixels even when the source is missing",
        );
    }

    #[test]
    fn paint_image_with_no_src_is_still_a_placeholder() {
        let mut pm = Pixmap::new(64, 64).unwrap();
        pm.fill(Color::WHITE);
        let before = pm.data().to_vec();
        let rect = LayoutRect {
            x: 0.0,
            y: 0.0,
            w: 64.0,
            h: 64.0,
        };
        paint_image(&mut pm, rect, None, 1.0, 0.0, crate::layout::ObjectFit::Fill);
        assert_ne!(pm.data(), before.as_slice());
    }

    #[test]
    fn paint_image_renders_loaded_bitmap_over_placeholder() {
        // Pre-seed the cache with a tiny bright-red 4×4 bitmap and
        // assert paint_image samples it (drawn pixels should match
        // red, not the placeholder gray).
        let key = "test://seeded-red-4x4";
        let mut data = vec![0u8; 4 * 4 * 4];
        for px in data.chunks_exact_mut(4) {
            px[0] = 0xff; // R
            px[1] = 0;
            px[2] = 0;
            px[3] = 0xff; // A — already premultiplied (R*A/255 = R for A=255)
        }
        let pm = Pixmap::from_vec(data, IntSize::from_wh(4, 4).unwrap()).unwrap();
        cache()
            .entries
            .lock()
            .unwrap()
            .insert(key.to_string(), CacheEntry::Loaded(pm));

        let mut canvas = Pixmap::new(32, 32).unwrap();
        canvas.fill(Color::WHITE);
        let rect = LayoutRect {
            x: 0.0,
            y: 0.0,
            w: 32.0,
            h: 32.0,
        };
        paint_image(
            &mut canvas,
            rect,
            Some(key),
            1.0,
            0.0,
            crate::layout::ObjectFit::Fill,
        );

        // Placeholder gray is roughly (0xe5, 0xe7, 0xeb). Loaded red
        // should have R >> G across the painted area. Sample a few
        // pixels in the middle.
        let sample = canvas.pixel(16, 16).expect("centre pixel");
        assert!(
            sample.red() > sample.green() + 50,
            "loaded bitmap should win over placeholder; got R={} G={} B={}",
            sample.red(),
            sample.green(),
            sample.blue(),
        );
    }
}
