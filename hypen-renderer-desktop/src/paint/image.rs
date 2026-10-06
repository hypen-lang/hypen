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
use indexmap::IndexMap;
use std::io::Read;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
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
    /// Source's *encoded* bytes (JPEG / PNG / WebP). Decoded on
    /// demand by `loaded_source`. Holding encoded keeps the global
    /// cache 10-15× smaller than holding decoded `Pixmap`s — a
    /// 1080×1080 JPEG is ~300 KB encoded vs ~4.6 MB premultiplied
    /// RGBA. The painter-side tile cache (`VelloPainter::image_cache`
    /// at 256 entries, `ImageRenderCache` at 256 tiles) absorbs the
    /// decode cost: one decode per unique `(src, w, h, fit, radius)`
    /// combination on cold paint, then warm-path hits never touch
    /// the source again.
    Loaded(Arc<Vec<u8>>),
    /// Source can't be loaded (missing file, decode error, network
    /// failure). Cache stays this way so we don't retry every frame.
    Failed,
}

/// Process-global cache. Created on first access; the worker thread
/// is spawned at the same time and lives for the process lifetime.
///
/// `entries` is an `IndexMap` for LRU semantics: insertion order
/// doubles as recency order, and `touch_recent` moves cache hits to
/// the back so `shift_remove_index(0)` always evicts the oldest
/// unused entry first. A plain `HashMap` here would grow without
/// bound — a long-running session that visits enough distinct
/// images (HTTP CDN avatars, post bodies, etc.) would accumulate
/// every decoded RGBA bitmap for the process lifetime.
pub(crate) struct ImageCache {
    pub(crate) entries: Mutex<IndexMap<String, CacheEntry>>,
    /// URLs awaiting HTTP fetch. Local files decode synchronously on
    /// the calling thread.
    work_tx: mpsc::Sender<String>,
    /// Set once when the renderer starts; lets the worker wake the
    /// event loop when a fetch completes. None means tests / offline
    /// embedders — the cache still works, paints just won't refresh
    /// until the next external event triggers a redraw.
    waker: Mutex<Option<EventLoopProxy<AppEvent>>>,
}

/// Cap on the number of encoded-source entries the global cache
/// holds. Each `Loaded` entry retains an `Arc<Vec<u8>>` of the
/// original JPEG / PNG / WebP body — typically ~100 KB-3 MB. 256
/// entries gives a high-watermark on the order of ~500 MB for a
/// busy feed; far below the 12 GB runaway we saw before any cap
/// existed, and ~10-15× smaller than holding RGBA at the same cap.
const GLOBAL_IMAGE_CACHE_CAP: usize = 256;

/// Cap on the short-term *decoded* pixmap cache (see [`DecodedCache`]).
/// Sized to comfortably cover one screen's visible image set so a
/// resize / scroll-out-and-back doesn't re-decode every image —
/// JPEG decode is the dominant cost (50-200 ms per mid-sized photo)
/// and a single resize can become a multi-second hitch without this
/// tier. 32 entries × ~5 MB average decoded image = ~160 MB ceiling,
/// on top of the encoded cache. Worth it for the interactive
/// smoothness; the decoded entries get cleared on `Occluded(true)`
/// (see `clear_decoded_cache`) so background memory still drops.
const DECODED_CACHE_CAP: usize = 32;

/// Bump `src` to the back of the LRU queue. No-op on an empty cache
/// or when the entry is already last. Caller must already hold the
/// cache lock. Generic over the value type so the same logic serves
/// both the encoded-bytes cache and the decoded-pixmap cache.
///
/// These two caches are genuine LRUs — position *is* recency here, and
/// `evict_overflow` / `store_decoded` drop from the front — unlike the
/// plain memo caches elsewhere in the renderer, which never re-insert on
/// a hit and so carry no recency information at all.
///
/// Known cost: `move_index` is O(distance), so promoting from the front
/// of a full cache walks the entry vector, and that sits on the *hit*
/// path (every visible image, every frame). Skipping the promotion for
/// entries already near the back would remove it, but it would also
/// break the invariant callers rely on — that a hit unconditionally
/// protects an entry from the next overflow. Making hits O(1) properly
/// means moving recency into the entry (a use counter) and having
/// `evict_overflow` pick the minimum, which trades an O(n) hit for an
/// O(n) eviction; evictions are far rarer. Left as-is for now: at
/// `GLOBAL_IMAGE_CACHE_CAP` this is tens of microseconds a frame, well
/// below the costs worth restructuring a process-global cache for.
fn touch_recent<V>(entries: &mut IndexMap<String, V>, src: &str) {
    let len = entries.len();
    if len < 2 {
        return;
    }
    if let Some(idx) = entries.get_index_of(src) {
        if idx + 1 != len {
            entries.move_index(idx, len - 1);
        }
    }
}

/// Evict the oldest entries until the cache is at or below cap.
/// Skips `Loading` entries — their worker is still in flight and
/// dropping them would orphan the decoded result. Caller must
/// already hold the cache lock.
fn evict_overflow(entries: &mut IndexMap<String, CacheEntry>) {
    while entries.len() > GLOBAL_IMAGE_CACHE_CAP {
        let evict_at = entries
            .iter()
            .position(|(_, e)| !matches!(e, CacheEntry::Loading));
        match evict_at {
            Some(i) => {
                entries.shift_remove_index(i);
            }
            // Everything in the cache is Loading — nothing safe to
            // evict. The worker will land results shortly and the
            // next call gets another chance.
            None => break,
        }
    }
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
            entries: Mutex::new(IndexMap::new()),
            work_tx,
            waker: Mutex::new(None),
        }
    })
}

/// Short-term decoded-pixmap cache, sized as the second tier on top
/// of the encoded `ImageCache`. The encoded tier solves the long-
/// term memory bound; this tier solves the interactive-cost bound
/// — a window resize invalidates every painter tile-cache entry
/// (key includes width / height), so without this tier each visible
/// image would re-decode from JPEG on the paint thread, producing
/// the multi-hundred-ms hitch users see post the #5 compression
/// optimisation. Hit returns `Arc<Pixmap>` directly; miss falls
/// through to encoded-bytes-and-decode and populates this tier for
/// next time. LRU eviction; populated lazily so an image that was
/// loaded but never painted doesn't claim a slot.
struct DecodedCache {
    entries: Mutex<IndexMap<String, Arc<Pixmap>>>,
}

fn decoded_cache() -> &'static DecodedCache {
    static CACHE: OnceLock<DecodedCache> = OnceLock::new();
    CACHE.get_or_init(|| DecodedCache {
        entries: Mutex::new(IndexMap::new()),
    })
}

/// Drop every entry in the decoded-pixmap cache. Called by the
/// window code on `WindowEvent::Occluded(true)` (next to clearing
/// the painter's tile cache) so a hidden window's resident set
/// shrinks. Encoded cache survives — re-decoding on resume is
/// cheap relative to re-fetching from the network.
pub fn clear_decoded_cache() {
    decoded_cache()
        .entries
        .lock()
        .expect("decoded cache poisoned")
        .clear();
}

fn lookup_decoded(src: &str) -> Option<Arc<Pixmap>> {
    let mut entries = decoded_cache()
        .entries
        .lock()
        .expect("decoded cache poisoned");
    let pm = entries.get(src).map(Arc::clone)?;
    touch_recent(&mut entries, src);
    Some(pm)
}

fn store_decoded(src: &str, pm: Arc<Pixmap>) {
    let mut entries = decoded_cache()
        .entries
        .lock()
        .expect("decoded cache poisoned");
    entries.insert(src.to_string(), pm);
    while entries.len() > DECODED_CACHE_CAP {
        entries.shift_remove_index(0);
    }
}

/// Public surface for the Vello painter: queue async load (or fast-
/// path early-return if already cached) and return the loaded
/// `Arc<Pixmap>` if available. Used by the Vello image draw path
/// which needs the source bitmap to build a `peniko::Image`.
pub fn ensure_loaded_public(src: &str) {
    ensure_loaded(src);
}

/// Test-only helper: stash a pre-decoded `Arc<Pixmap>` directly in
/// the tier-1 decoded cache so `loaded_source(src)` returns it
/// synchronously, without going through the async worker. Lets tests
/// in sibling modules (e.g. `vello_painter`) exercise the draw-image
/// path deterministically.
#[cfg(test)]
pub(crate) fn test_seed_decoded(src: &str, pm: Arc<Pixmap>) {
    store_decoded(src, pm);
}

pub fn loaded_source(src: &str) -> Option<std::sync::Arc<Pixmap>> {
    // Mirrors the `ensure_loaded` guard: an empty src is never cached,
    // so this would miss both tiers anyway — return before paying two
    // mutex acquisitions per paint for a node that draws nothing.
    if src.trim().is_empty() {
        return None;
    }
    // Tier 1: decoded-pixmap cache hit. The hot path during resize
    // / scroll-out-and-back where the painter tile cache invalidated
    // for every visible image but the source decode is cached here.
    // `Arc::clone` pointer-bump, no decode work, no encoded-cache
    // contention with the worker thread.
    if let Some(pm) = lookup_decoded(src) {
        return Some(pm);
    }

    // Tier 2: encoded-bytes cache. Lock just long enough to clone
    // the `Arc<Vec<u8>>` + bump LRU; release before decoding so the
    // (potentially multi-MB JPEG) decode doesn't hold the cache
    // mutex against the worker thread.
    let encoded = {
        let mut entries = cache().entries.lock().expect("image cache poisoned");
        let result = match entries.get(src) {
            Some(CacheEntry::Loaded(bytes)) => Some(Arc::clone(bytes)),
            _ => None,
        };
        // Mark as recently used so eviction doesn't strip the avatar
        // we're currently rendering when the cache fills up.
        if result.is_some() {
            touch_recent(&mut entries, src);
        }
        result
    };
    let encoded = encoded?;
    let pm = Arc::new(decode_bytes(&encoded, src)?);
    // Populate the decoded tier so next resize / scroll hits.
    store_decoded(src, Arc::clone(&pm));
    Some(pm)
}

/// Register the renderer's event-loop proxy so the worker can wake
/// the window when an HTTP fetch completes. Idempotent — calling
/// twice replaces the proxy, which is fine for tests.
pub fn set_waker(proxy: EventLoopProxy<AppEvent>) {
    *cache().waker.lock().expect("image cache waker poisoned") = Some(proxy);
}

/// Natural (intrinsic) pixel size of a source that has already been
/// fetched + decoded — `None` while it's loading, failed, or was never
/// requested. Never *triggers* a load: layout calls this to derive a
/// Video poster's natural aspect ratio and must stay non-blocking on
/// the miss path (decode of already-fetched bytes is served from the
/// decoded-pixmap tier after the first call).
pub fn loaded_natural_size(src: &str) -> Option<(f32, f32)> {
    loaded_source(src).map(|pm| (pm.width() as f32, pm.height() as f32))
}

// ---------------------------------------------------------------------------
// HTTP failure registry — Video `onError` support.
//
// The Video contract (`hypen-docs/content/docs/guide/components.mdx`) has the
// desktop renderer report `onError` with the HTTP `status` "from the
// poster/probe fetch". The worker already learns the status from
// `ureq::Error::Status`; this registry keeps it addressable by src so
// the window can dispatch the element's `onError` action after the
// worker's `AppEvent::Wake` lands.
// ---------------------------------------------------------------------------

/// Details of an HTTP-status fetch failure (non-2xx response).
/// Network-level and decode failures are NOT recorded here — they have
/// no status and the renderer only logs them.
#[derive(Debug, Clone)]
pub struct LoadFailure {
    pub status: u16,
    pub message: String,
}

fn failure_registry() -> &'static Mutex<std::collections::HashMap<String, LoadFailure>> {
    static REG: OnceLock<Mutex<std::collections::HashMap<String, LoadFailure>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

fn record_failure(src: &str, status: u16, message: String) {
    failure_registry()
        .lock()
        .expect("failure registry poisoned")
        .insert(src.to_string(), LoadFailure { status, message });
}

/// HTTP failure details for `src`, if its fetch came back with a
/// non-2xx status. Sticky, like `CacheEntry::Failed`.
pub fn load_failure(src: &str) -> Option<LoadFailure> {
    failure_registry()
        .lock()
        .expect("failure registry poisoned")
        .get(src)
        .cloned()
}

/// Test-only: seed an HTTP failure without running the worker.
#[cfg(test)]
pub(crate) fn test_seed_failure(src: &str, status: u16, message: &str) {
    record_failure(src, status, message.to_string());
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
    // Clone the Arc handle (cheap pointer bump) instead of copying
    // the decoded RGBA bytes. Each tile-cache miss for a different
    // target size used to allocate + memcpy the entire source bitmap
    // — for a 4 K post body that's ~64 MB of redundant RGBA per
    // miss. With Arc<Pixmap>, the source stays uniquely allocated
    // in the global image cache.
    let source: Option<Arc<Pixmap>> = src.and_then(|s| {
        ensure_loaded(s);
        loaded_source(s)
    });

    if let Some(pm) = source {
        let w = pm.width();
        let h = pm.height();
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
                LayoutRect {
                    x: 0.0,
                    y: 0.0,
                    w: cw as f32,
                    h: ch as f32,
                },
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
fn composite_tile(pixmap: &mut Pixmap, tile: &Pixmap, rect: LayoutRect, upscaled: bool) {
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
        PixmapRef::from_bytes(tile.data(), tile.width(), tile.height()).expect("tile bytes valid"),
        &paint,
        transform,
        None,
    );
}

fn render_cache_key(src: &str, w: u32, h: u32, fit: crate::layout::ObjectFit, radius: f32) -> u64 {
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
    // An absent source is "no image", not a load failure. Without this
    // an `Image(src: "")` — what a record with no poster/avatar
    // serialises to — burned a cache slot, queued worker work, and made
    // the worker `fs::read("")`, which logs
    // `image: failed reading : No such file or directory` naming no
    // file at all. Web treats `<img src="">` as nothing to fetch; so do
    // we.
    if src.trim().is_empty() {
        return;
    }
    {
        let mut entries = cache().entries.lock().expect("image cache poisoned");
        if entries.contains_key(src) {
            // Cache hit — bump to back so a re-render of the same
            // image survives the next eviction sweep.
            touch_recent(&mut entries, src);
            return;
        }
        // Insert as Loading and evict the oldest non-Loading entries
        // to keep the cache at cap. Same lock window as the
        // contains_key check above so two concurrent ensure_loaded
        // calls for the same src can't both queue work.
        entries.insert(src.to_string(), CacheEntry::Loading);
        evict_overflow(&mut entries);
    }
    // Both HTTP and local file paths queue on the worker thread now.
    // Local-file synchronous decode used to hitch the paint thread on
    // first paint of any post-body image (multi-MB JPEG decode +
    // premultiply on the main loop). Worker hands the result back via
    // the same `AppEvent::Wake` redraw nudge as HTTP fetches.
    if let Err(e) = cache().work_tx.send(src.to_string()) {
        log::warn!("image: worker channel closed: {e}");
    }
}

fn is_http(src: &str) -> bool {
    src.starts_with("http://") || src.starts_with("https://")
}

fn is_data_uri(src: &str) -> bool {
    src.len() >= 5 && src[..5].eq_ignore_ascii_case("data:")
}

/// Decode a `data:` URI's payload to the encoded image bytes.
///
/// The loader otherwise branches HTTP vs local file, so a `data:` URI fell
/// to the file branch and failed as a filename — which is why the
/// home-screen wallpaper (a base64 PNG inlined into the `background`
/// shorthand) never appeared. Only base64 payloads are supported; a
/// percent-encoded one returns None and degrades to "no image".
fn decode_data_uri(src: &str) -> Option<Vec<u8>> {
    let comma = src.find(',')?;
    let meta = &src[..comma];
    if !meta.to_ascii_lowercase().contains("base64") {
        log::warn!("image: non-base64 data URI is not supported");
        return None;
    }
    let payload: String = src[comma + 1..]
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    match base64_decode(&payload) {
        Some(bytes) => Some(bytes),
        None => {
            log::warn!("image: malformed base64 in data URI");
            None
        }
    }
}

/// Minimal standard-alphabet base64 decoder.
///
/// The crate graph has no base64 dependency and this is the only caller;
/// tolerates missing padding, rejects anything outside the alphabet.
fn base64_decode(input: &str) -> Option<Vec<u8>> {
    fn val(c: u8) -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some((c - b'A') as u32),
            b'a'..=b'z' => Some((c - b'a') as u32 + 26),
            b'0'..=b'9' => Some((c - b'0') as u32 + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let bytes: Vec<u8> = input.bytes().filter(|b| *b != b'=').collect();
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
    for chunk in bytes.chunks(4) {
        let mut acc = 0u32;
        for (i, b) in chunk.iter().enumerate() {
            acc |= val(*b)? << (18 - 6 * i);
        }
        let produced = match chunk.len() {
            4 => 3,
            3 => 2,
            2 => 1,
            _ => return None,
        };
        for i in 0..produced {
            out.push(((acc >> (16 - 8 * i)) & 0xFF) as u8);
        }
    }
    Some(out)
}

/// Worker loop. Receives src strings on the channel, fetches the
/// encoded source bytes (HTTP body for URLs, file read for local
/// paths), validates them by attempting a decode (discarding the
/// result), stores the **encoded** bytes in the cache, then nudges
/// the event loop. Either branch off the main thread keeps the
/// paint loop responsive — the network and IO are obvious wins; the
/// validation decode is here so we don't cache un-decodable bytes
/// that fail on every paint until evicted.
/// Monotonic counter bumped every time the image worker resolves an
/// `src` (success OR failure). The painter reads this on each
/// `build_scene` call: if it moved since the last paint, any subtree
/// scene cached during a frame where some image's source was still
/// `Loading` is now potentially stale (the image is loaded and would
/// draw differently), so the painter invalidates its subtree cache.
///
/// Without this, the scene cache happily replays an "image not loaded
/// → bail out, render nothing" fragment forever — the user saw the
/// thumbnails pop in only on viewport resize, which dropped the
/// cache as a side effect.
static IMAGE_LOAD_GEN: AtomicU64 = AtomicU64::new(0);

/// Read the current image-load generation. The painter compares this
/// against its last-seen value to decide whether to drop subtree
/// caches that may have been encoded against an unloaded source.
pub fn image_load_generation() -> u64 {
    IMAGE_LOAD_GEN.load(Ordering::Relaxed)
}

/// Bump the generation without going near the worker thread.
///
/// The counter is what drives `compute_inner_state`'s bulk-rebuild
/// branch outside of an explicit `mark_needs_rebuild`, so tests that
/// need to exercise that branch would otherwise have to queue a real
/// fetch and poll for the worker to land — slow and flaky. This is the
/// same store the worker performs.
#[cfg(test)]
pub(crate) fn bump_image_load_generation_for_test() {
    IMAGE_LOAD_GEN.fetch_add(1, Ordering::Relaxed);
}

fn run_image_worker(rx: mpsc::Receiver<String>) {
    while let Ok(src) = rx.recv() {
        let bytes = if is_data_uri(&src) {
            decode_data_uri(&src)
        } else if is_http(&src) {
            fetch_http_bytes(&src)
        } else {
            read_local_bytes(&src)
        };
        let entry = match bytes {
            Some(bytes) => {
                // Decode + discard for validation. The paint thread
                // re-decodes on demand via `loaded_source`; the
                // painter-side tile cache then keeps the warm path
                // off the encoded source.
                if decode_bytes(&bytes, &src).is_some() {
                    CacheEntry::Loaded(Arc::new(bytes))
                } else {
                    CacheEntry::Failed
                }
            }
            None => CacheEntry::Failed,
        };
        {
            let mut entries = cache().entries.lock().expect("image cache poisoned");
            // `IndexMap::insert` keeps an existing key in place; the
            // entry was Loading, we want the newly-decoded result at
            // the back so it counts as freshly used. shift_remove +
            // insert is O(n) in the cache size but n ≤ cap (256), so
            // ~µs per landing — negligible compared to the JPEG
            // decode we just did.
            entries.shift_remove(&src);
            entries.insert(src, entry);
            evict_overflow(&mut entries);
        }
        // Bump the load generation BEFORE the wake event so the next
        // redraw sees the new value when it checks. Even Failed
        // entries bump it: a failed src that was previously Loading
        // would have been encoded as "skip the draw" in any cached
        // subtree, and we want to re-encode that subtree once with
        // the final Failed state so it stops trying to load every
        // frame (the global cache's Failed sticks).
        IMAGE_LOAD_GEN.fetch_add(1, Ordering::Relaxed);
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

/// Fetch the *encoded* body of an HTTP / HTTPS URL via `ureq`.
/// Returns `None` on any failure (timeout, non-2xx, oversize body).
/// Decode validation happens in the worker loop.
fn fetch_http_bytes(url: &str) -> Option<Vec<u8>> {
    let response = match ureq::get(url).timeout(Duration::from_secs(10)).call() {
        Ok(r) => r,
        Err(ureq::Error::Status(code, _)) => {
            // Non-2xx: keep the status addressable so the renderer can
            // dispatch Video `onError` with `status` per the contract.
            log::warn!("image: HTTP {code} for {url}");
            record_failure(url, code, format!("HTTP {code} fetching {url}"));
            return None;
        }
        Err(e) => {
            log::warn!("image: HTTP failed for {url}: {e}");
            return None;
        }
    };
    let mut bytes = Vec::with_capacity(64 * 1024);
    // 20 MB hard cap per image. Keeps a misbehaving server from
    // wedging the worker thread on a giant body.
    if let Err(e) = response
        .into_reader()
        .take(20 * 1024 * 1024)
        .read_to_end(&mut bytes)
    {
        log::warn!("image: read failed for {url}: {e}");
        return None;
    }
    Some(bytes)
}

/// Read the encoded bytes of a local file path (raw or `file://`-
/// prefixed). HTTP URLs return `None` here so the caller routes
/// them to `fetch_http_bytes` instead.
pub(crate) fn read_local_bytes(src: &str) -> Option<Vec<u8>> {
    if is_http(src) {
        log::debug!("image: HTTP src queued for worker (not local): {src}");
        return None;
    }
    let path = src.strip_prefix("file://").unwrap_or(src);
    match std::fs::read(path) {
        Ok(b) => Some(b),
        Err(e) => {
            log::warn!("image: failed reading {path}: {e}");
            None
        }
    }
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

// ---------------------------------------------------------------------------
// Video surface — poster frame + play glyph.
//
// Desktop has no inline media decode (capability matrix in
// `hypen-docs/content/docs/guide/components.mdx`): a Video paints its poster
// (through the same cache/tile pipeline as Image, objectFit cover) or
// a dark #111 placeholder, with a centered play affordance on top.
// ---------------------------------------------------------------------------

/// Quiet dark background for a Video with no (loaded) poster. The
/// contract's "poster or dark box — never an infinite spinner".
pub const VIDEO_PLACEHOLDER_RGBA: Rgba = Rgba(0x11, 0x11, 0x11, 0xff);

/// Letterbox bands behind a contain-fit live playback frame
/// (feature `video`). Pure black, like every native video player.
pub const VIDEO_LETTERBOX_RGBA: Rgba = Rgba(0x00, 0x00, 0x00, 0xff);

/// Translucent scrim circle behind the play triangle.
pub const PLAY_GLYPH_CIRCLE_RGBA: Rgba = Rgba(0x00, 0x00, 0x00, 0x66);

/// The play triangle itself.
pub const PLAY_GLYPH_TRIANGLE_RGBA: Rgba = Rgba(0xff, 0xff, 0xff, 0xf2);

/// Resolved play-glyph geometry, shared by the CPU (tiny-skia) and
/// Vello painters so both draw the identical affordance.
pub struct PlayGlyph {
    /// Scrim circle: center + radius, physical px.
    pub cx: f32,
    pub cy: f32,
    pub radius: f32,
    /// Triangle corner points (pointing right), physical px.
    pub triangle: [(f32, f32); 3],
    /// Corner-rounding inset distance for the triangle.
    pub corner: f32,
}

/// Compute the play glyph for a video rect: a circle sized against the
/// shorter side (clamped so tiny thumbnails still get a legible glyph
/// and huge heroes don't get a billboard), and an equilateral triangle
/// inscribed in it with a slight rightward optical shift.
pub fn play_glyph_geometry(rect: LayoutRect, scale: f32) -> Option<PlayGlyph> {
    if rect.w <= 0.0 || rect.h <= 0.0 {
        return None;
    }
    let short = rect.w.min(rect.h);
    let radius = (short * 0.18)
        .clamp(10.0 * scale, 40.0 * scale)
        .min(short * 0.45);
    if radius <= 0.0 {
        return None;
    }
    let cx = rect.x + rect.w * 0.5;
    let cy = rect.y + rect.h * 0.5;
    let tr = radius * 0.58;
    // Optical centering: a right-pointing triangle's centroid sits left
    // of the circle center, so nudge it right a touch.
    let ox = radius * 0.07;
    let (s, c) = (120.0f32.to_radians().sin(), 120.0f32.to_radians().cos());
    let triangle = [
        (cx + ox + tr, cy),
        (cx + ox + tr * c, cy + tr * s),
        (cx + ox + tr * c, cy - tr * s),
    ];
    Some(PlayGlyph {
        cx,
        cy,
        radius,
        triangle,
        corner: tr * 0.25,
    })
}

// ---------------------------------------------------------------------------
// Video v2 `Scrubber`
// ---------------------------------------------------------------------------

/// Unplayed remainder of the timeline.
pub const SCRUBBER_TRACK_RGBA: Rgba = Rgba(0xff, 0xff, 0xff, 0x4d);

/// Elapsed portion of the timeline.
pub const SCRUBBER_PROGRESS_RGBA: Rgba = Rgba(0xff, 0xff, 0xff, 0xf2);

/// Draggable thumb.
pub const SCRUBBER_THUMB_RGBA: Rgba = Rgba(0xff, 0xff, 0xff, 0xff);

/// Resolved `Scrubber` geometry, shared by the CPU (tiny-skia) and Vello
/// painters so both draw the identical widget — and so the geometry is
/// unit-testable without a GPU.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScrubberGeometry {
    /// Full-width track rect (physical px), vertically centred in the
    /// item box at [`crate::layout::SCRUBBER_TRACK_PX`] thickness.
    pub track: LayoutRect,
    /// Elapsed sub-rect of the track — `track` with the width scaled by
    /// the progress fraction.
    pub progress: LayoutRect,
    /// Thumb circle centre + radius.
    pub thumb_cx: f32,
    pub thumb_cy: f32,
    pub thumb_r: f32,
    /// Corner radius for the track / progress bars (a pill).
    pub radius: f32,
}

/// Compute the Scrubber's geometry for an item rect and a progress
/// fraction in `0..=1`.
///
/// The track spans the full item width so the pointer→fraction mapping
/// in the window (`(x - rect.x) / rect.w`) and the painted geometry are
/// the same function — the invariant that keeps the thumb under the
/// finger. The thumb is inset by its own radius at both ends so it never
/// hangs outside the item box at 0 % / 100 %.
pub fn scrubber_geometry(rect: LayoutRect, fraction: f32, scale: f32) -> Option<ScrubberGeometry> {
    if rect.w <= 0.0 || rect.h <= 0.0 {
        return None;
    }
    let f = fraction.clamp(0.0, 1.0);
    let thickness = (crate::layout::SCRUBBER_TRACK_PX * scale).min(rect.h);
    let track = LayoutRect {
        x: rect.x,
        y: rect.y + (rect.h - thickness) * 0.5,
        w: rect.w,
        h: thickness,
    };
    let progress = LayoutRect {
        w: track.w * f,
        ..track
    };
    let thumb_r = (rect.h * 0.5).min(6.0 * scale).max(thickness * 0.5);
    let usable = (rect.w - 2.0 * thumb_r).max(0.0);
    Some(ScrubberGeometry {
        track,
        progress,
        thumb_cx: rect.x + thumb_r + usable * f,
        thumb_cy: rect.y + rect.h * 0.5,
        thumb_r,
        radius: thickness * 0.5,
    })
}

/// Move `d` px from `from` towards `to`, clamped to half the edge so
/// rounding insets from both ends of a short edge never cross.
fn point_towards(from: (f32, f32), to: (f32, f32), d: f32) -> (f32, f32) {
    let dx = to.0 - from.0;
    let dy = to.1 - from.1;
    let len = (dx * dx + dy * dy).sqrt();
    if len <= f32::EPSILON {
        return from;
    }
    let d = d.min(len * 0.5);
    (from.0 + dx / len * d, from.1 + dy / len * d)
}

/// Closed polygon path with rounded corners (each corner replaced by a
/// quadratic through the vertex). Used for the play triangle.
fn rounded_polygon_path(points: &[(f32, f32)], corner: f32) -> Option<tiny_skia::Path> {
    let n = points.len();
    if n < 3 {
        return None;
    }
    let mut pb = PathBuilder::new();
    for i in 0..n {
        let p = points[i];
        let prev = points[(i + n - 1) % n];
        let next = points[(i + 1) % n];
        let a = point_towards(p, prev, corner);
        let b = point_towards(p, next, corner);
        if i == 0 {
            pb.move_to(a.0, a.1);
        } else {
            pb.line_to(a.0, a.1);
        }
        pb.quad_to(p.0, p.1, b.0, b.1);
    }
    pb.close();
    pb.finish()
}

fn fill_path_rgba(pixmap: &mut Pixmap, path: &tiny_skia::Path, color: Rgba) {
    let mut paint = Paint::default();
    let [r, g, b, a] = color.premultiplied();
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
    pixmap.fill_path(path, &paint, FillRule::Winding, Transform::identity(), None);
}

/// Paint the centered play affordance: translucent circle + white
/// rounded triangle. tiny-skia flavour; the Vello painter draws the
/// same [`play_glyph_geometry`] with kurbo shapes.
pub fn paint_play_glyph(pixmap: &mut Pixmap, rect: LayoutRect, scale: f32) {
    let Some(glyph) = play_glyph_geometry(rect, scale) else {
        return;
    };
    let mut pb = PathBuilder::new();
    pb.push_circle(glyph.cx, glyph.cy, glyph.radius);
    if let Some(circle) = pb.finish() {
        fill_path_rgba(pixmap, &circle, PLAY_GLYPH_CIRCLE_RGBA);
    }
    if let Some(tri) = rounded_polygon_path(&glyph.triangle, glyph.corner) {
        fill_path_rgba(pixmap, &tri, PLAY_GLYPH_TRIANGLE_RGBA);
    }
}

/// Paint a `Video` surface into `rect`: the poster (objectFit cover,
/// via the shared Image pipeline + tile cache) when one is present and
/// loaded, else the dark placeholder; then the play glyph on top.
/// Queues the poster load on first sight — the worker's wake repaints
/// once it lands.
pub fn paint_video_surface(
    pixmap: &mut Pixmap,
    rect: LayoutRect,
    poster: Option<&str>,
    scale_factor: f32,
    radius: f32,
    // Video v2: `false` when a composition slot replaces the built-in
    // affordance (`controls` always, `loading` / `error` in their state).
    play_glyph: bool,
    tile_cache: &mut ImageRenderCache,
) {
    if rect.w <= 0.0 || rect.h <= 0.0 {
        return;
    }
    let poster_ready = poster
        .map(|p| {
            ensure_loaded(p);
            loaded_source(p).is_some()
        })
        .unwrap_or(false);
    if poster_ready {
        paint_image_cached(
            pixmap,
            rect,
            poster,
            scale_factor,
            radius,
            crate::layout::ObjectFit::Cover,
            tile_cache,
        );
    } else if let Some(path) = rounded_rect_path(rect.x, rect.y, rect.w, rect.h, radius) {
        fill_path_rgba(pixmap, &path, VIDEO_PLACEHOLDER_RGBA);
    }
    if play_glyph {
        paint_play_glyph(pixmap, rect, scale_factor);
    }
}

/// Video v2 `Scrubber` (tiny-skia flavour of the Vello painter's
/// `draw_scrubber`): track + elapsed progress + thumb, off the shared
/// [`scrubber_geometry`].
pub fn paint_scrubber(pixmap: &mut Pixmap, rect: LayoutRect, fraction: f32, scale_factor: f32) {
    let Some(g) = scrubber_geometry(rect, fraction, scale_factor) else {
        return;
    };
    if let Some(path) = rounded_rect_path(g.track.x, g.track.y, g.track.w, g.track.h, g.radius) {
        fill_path_rgba(pixmap, &path, SCRUBBER_TRACK_RGBA);
    }
    if g.progress.w > 0.0 {
        if let Some(path) = rounded_rect_path(
            g.progress.x,
            g.progress.y,
            g.progress.w,
            g.progress.h,
            g.radius,
        ) {
            fill_path_rgba(pixmap, &path, SCRUBBER_PROGRESS_RGBA);
        }
    }
    if let Some(path) = rounded_rect_path(
        g.thumb_cx - g.thumb_r,
        g.thumb_cy - g.thumb_r,
        g.thumb_r * 2.0,
        g.thumb_r * 2.0,
        g.thumb_r,
    ) {
        fill_path_rgba(pixmap, &path, SCRUBBER_THUMB_RGBA);
    }
}

/// Feature `video`: paint the latest decoded playback frame into
/// `rect` — objectFit contain, letterboxed on black — and overlay the
/// play affordance while paused / ended. tiny-skia flavour of the
/// Vello painter's `draw_video_frame`.
#[cfg(feature = "video")]
pub fn paint_video_frame(
    pixmap: &mut Pixmap,
    rect: LayoutRect,
    frame: &crate::media::VideoFrame,
    scale_factor: f32,
    radius: f32,
    paused: bool,
) {
    if rect.w <= 0.0 || rect.h <= 0.0 || frame.width == 0 || frame.height == 0 {
        return;
    }
    if let Some(path) = rounded_rect_path(rect.x, rect.y, rect.w, rect.h, radius) {
        fill_path_rgba(pixmap, &path, VIDEO_LETTERBOX_RGBA);
    }
    if let Some(src) = PixmapRef::from_bytes(frame.data.as_slice(), frame.width, frame.height) {
        let sx = rect.w / frame.width as f32;
        let sy = rect.h / frame.height as f32;
        let s = sx.min(sy);
        let dx = rect.x + (rect.w - frame.width as f32 * s) * 0.5;
        let dy = rect.y + (rect.h - frame.height as f32 * s) * 0.5;
        let transform = Transform::from_scale(s, s).post_translate(dx, dy);
        let paint = PixmapPaint {
            quality: tiny_skia::FilterQuality::Bilinear,
            ..PixmapPaint::default()
        };
        let mask = if radius > 0.0 {
            build_rounded_rect_mask(pixmap.width(), pixmap.height(), rect, radius)
        } else {
            None
        };
        pixmap.draw_pixmap(0, 0, src, &paint, transform, mask.as_ref());
    }
    if paused {
        paint_play_glyph(pixmap, rect, scale_factor);
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
    pb.cubic_to(
        x + w,
        y + h - ry + cy,
        x + w - rx + cx,
        y + h,
        x + w - rx,
        y + h,
    );
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
    fn read_local_bytes_skips_http_urls() {
        // `read_local_bytes` is the local-file fast path; HTTP URLs
        // return None so the caller routes them to `fetch_http_bytes`
        // instead.
        assert!(read_local_bytes("http://example.com/x.png").is_none());
        assert!(read_local_bytes("https://example.com/x.png").is_none());
    }

    #[test]
    fn read_local_bytes_returns_none_for_missing_file() {
        assert!(read_local_bytes("/tmp/__hypen_test_does_not_exist_xyz.png").is_none());
    }

    #[test]
    fn empty_src_never_enters_the_cache_or_the_worker_queue() {
        // A record with no poster serialises to `src: ""`. That must be
        // a no-op, not a queued load that fails against no filename.
        for blank in ["", "   ", "\t\n"] {
            ensure_loaded(blank);
            let entries = cache().entries.lock().expect("image cache poisoned");
            assert!(
                !entries.contains_key(blank),
                "blank src {blank:?} took a cache slot"
            );
        }
    }

    #[test]
    fn loaded_source_is_none_for_blank_src() {
        assert!(loaded_source("").is_none());
        assert!(loaded_source("   ").is_none());
    }

    #[test]
    fn ensure_loaded_marks_http_urls_as_loading_and_queues_them() {
        // We can't run the actual worker reliably in tests, but we
        // can verify the bookkeeping: an unseen HTTP URL flips to
        // `Loading` immediately and the entry stays put across
        // repeated `ensure_loaded` calls (no double-queueing).
        let url = "http://hypen-test.invalid/cache-loading-state.png";
        // Clear any prior state from earlier tests.
        cache().entries.lock().unwrap().shift_remove(url);

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
        // Local-file decode is async via the worker thread. The
        // initial `ensure_loaded` flips state to `Loading` and queues
        // the work; once the worker fails to read the missing file,
        // it lands as `Failed`. Poll briefly to bridge the latency —
        // the worker is single-threaded but cheap.
        let key = "/tmp/__hypen_test_local_miss_caches_failed.png";
        cache().entries.lock().unwrap().shift_remove(key);
        ensure_loaded(key);
        // Loading → Failed transition happens on the worker.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            {
                let entries = cache().entries.lock().unwrap();
                if matches!(entries.get(key), Some(CacheEntry::Failed)) {
                    return;
                }
            }
            if std::time::Instant::now() >= deadline {
                let entries = cache().entries.lock().unwrap();
                panic!(
                    "local miss should land as Failed within timeout; got {:?}",
                    entries.get(key)
                );
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
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
        paint_image(
            &mut pm,
            rect,
            None,
            1.0,
            0.0,
            crate::layout::ObjectFit::Fill,
        );
        assert_ne!(pm.data(), before.as_slice());
    }

    #[test]
    fn paint_image_renders_loaded_bitmap_over_placeholder() {
        // Pre-seed the cache with a tiny bright-red 4×4 bitmap and
        // assert paint_image samples it (drawn pixels should match
        // red, not the placeholder gray). With compressed-bytes
        // caching, the seed has to be a real encoded PNG — the paint
        // path decodes via `loaded_source` on demand.
        let key = "test://seeded-red-4x4";
        let mut img = image::RgbaImage::new(4, 4);
        for px in img.pixels_mut() {
            *px = image::Rgba([0xff, 0, 0, 0xff]);
        }
        let mut png_bytes = Vec::new();
        image::DynamicImage::ImageRgba8(img)
            .write_to(
                &mut std::io::Cursor::new(&mut png_bytes),
                image::ImageFormat::Png,
            )
            .expect("encode 4×4 red png for seed");
        cache()
            .entries
            .lock()
            .unwrap()
            .insert(key.to_string(), CacheEntry::Loaded(Arc::new(png_bytes)));

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

    // -----------------------------------------------------------------
    // LRU cap on the global decoded-source cache
    // -----------------------------------------------------------------

    /// Build a `Loaded` entry whose payload is a tiny PNG byte buffer
    /// — content doesn't matter for the cache-mechanics tests, only
    /// the entry's discriminant. We use real PNG bytes (a 1×1 white
    /// pixel) so any test path that does decode the bytes still
    /// works; cache-mechanics tests don't bother decoding.
    fn dummy_loaded() -> CacheEntry {
        CacheEntry::Loaded(Arc::new(tiny_png_bytes()))
    }

    /// 1×1 white pixel encoded as PNG via the `image` crate. Generated
    /// at test time rather than hand-frozen bytes — PNG CRCs are
    /// fiddly enough to get wrong by hand (we tried) and the `image`
    /// crate is already a dep with the `png` feature on, so this is
    /// trivially available.
    fn tiny_png_bytes() -> Vec<u8> {
        let img = image::RgbaImage::from_pixel(1, 1, image::Rgba([0xff, 0xff, 0xff, 0xff]));
        let mut buf = Vec::new();
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png)
            .expect("encode 1×1 white png");
        buf
    }

    #[test]
    fn touch_recent_moves_existing_key_to_back() {
        let mut entries: IndexMap<String, CacheEntry> = IndexMap::new();
        entries.insert("a".into(), dummy_loaded());
        entries.insert("b".into(), dummy_loaded());
        entries.insert("c".into(), dummy_loaded());

        touch_recent(&mut entries, "a");

        let order: Vec<&str> = entries.keys().map(String::as_str).collect();
        assert_eq!(order, vec!["b", "c", "a"], "touched key must end up last");
    }

    #[test]
    fn touch_recent_is_noop_on_missing_key() {
        let mut entries: IndexMap<String, CacheEntry> = IndexMap::new();
        entries.insert("a".into(), dummy_loaded());
        entries.insert("b".into(), dummy_loaded());
        touch_recent(&mut entries, "missing");
        let order: Vec<&str> = entries.keys().map(String::as_str).collect();
        assert_eq!(order, vec!["a", "b"]);
    }

    #[test]
    fn evict_overflow_drops_oldest_loaded_first() {
        let mut entries: IndexMap<String, CacheEntry> = IndexMap::new();
        // Insert one more than the cap so eviction kicks in.
        for i in 0..(GLOBAL_IMAGE_CACHE_CAP + 1) {
            entries.insert(format!("k{i}"), dummy_loaded());
        }
        evict_overflow(&mut entries);
        assert_eq!(entries.len(), GLOBAL_IMAGE_CACHE_CAP);
        // The oldest insert (`k0`) should be gone; the newest still
        // present.
        assert!(!entries.contains_key("k0"));
        assert!(entries.contains_key(&format!("k{}", GLOBAL_IMAGE_CACHE_CAP)));
    }

    #[test]
    fn evict_overflow_skips_loading_entries() {
        // Loading entries have in-flight worker decodes; evicting them
        // orphans the decode result. The eviction sweep must skip
        // Loading and prefer the oldest non-Loading.
        let mut entries: IndexMap<String, CacheEntry> = IndexMap::new();
        entries.insert("loading_old".into(), CacheEntry::Loading);
        entries.insert("loaded_mid".into(), dummy_loaded());
        for i in 0..(GLOBAL_IMAGE_CACHE_CAP - 1) {
            entries.insert(format!("filler{i}"), dummy_loaded());
        }
        // We're now at cap + 1 with `loading_old` at the front.
        assert_eq!(entries.len(), GLOBAL_IMAGE_CACHE_CAP + 1);

        evict_overflow(&mut entries);
        assert_eq!(entries.len(), GLOBAL_IMAGE_CACHE_CAP);
        // `loading_old` must survive even though it's the oldest;
        // `loaded_mid` (next-oldest non-Loading) is the casualty.
        assert!(entries.contains_key("loading_old"));
        assert!(!entries.contains_key("loaded_mid"));
    }

    #[test]
    fn evict_overflow_with_all_loading_is_a_noop() {
        // Pathological: every entry is in flight. We refuse to evict
        // anything (would lose worker results) and live with the
        // temporary overshoot. The worker pipeline drains and the next
        // sweep catches up.
        let mut entries: IndexMap<String, CacheEntry> = IndexMap::new();
        for i in 0..(GLOBAL_IMAGE_CACHE_CAP + 4) {
            entries.insert(format!("k{i}"), CacheEntry::Loading);
        }
        evict_overflow(&mut entries);
        assert_eq!(entries.len(), GLOBAL_IMAGE_CACHE_CAP + 4);
    }

    // -----------------------------------------------------------------
    // Decoded-pixmap LRU (the second tier — solves the resize hitch)
    // -----------------------------------------------------------------

    #[test]
    fn loaded_source_populates_decoded_cache_on_first_call() {
        // Hermetic test: unique key so concurrent tests can't trash
        // each other's state via the global caches.
        let key = "test://decoded-populate-fresh";
        {
            let mut entries = cache().entries.lock().unwrap();
            entries.shift_remove(key);
            entries.insert(key.into(), CacheEntry::Loaded(Arc::new(tiny_png_bytes())));
        }
        decoded_cache().entries.lock().unwrap().shift_remove(key);

        let pm = loaded_source(key).expect("first load decodes successfully");

        let decoded = decoded_cache().entries.lock().unwrap();
        let stored = decoded
            .get(key)
            .expect("decoded cache must retain after the first decode");
        assert!(
            Arc::ptr_eq(&pm, stored),
            "the Arc returned by loaded_source must be the same instance the \
             decoded cache stored — otherwise resize will re-decode anyway",
        );

        drop(decoded);
        cache().entries.lock().unwrap().shift_remove(key);
        decoded_cache().entries.lock().unwrap().shift_remove(key);
    }

    #[test]
    fn loaded_source_second_call_hits_decoded_cache() {
        // Two `loaded_source` calls in a row should return the SAME
        // Arc instance — proving the second one took the decoded-
        // cache fast path rather than re-decoding from encoded bytes
        // (which would mint a fresh `Arc<Pixmap>`).
        let key = "test://decoded-second-call-hits";
        {
            let mut entries = cache().entries.lock().unwrap();
            entries.shift_remove(key);
            entries.insert(key.into(), CacheEntry::Loaded(Arc::new(tiny_png_bytes())));
        }
        decoded_cache().entries.lock().unwrap().shift_remove(key);

        let first = loaded_source(key).expect("first load");
        let second = loaded_source(key).expect("second load (decoded-cache hit)");
        assert!(
            Arc::ptr_eq(&first, &second),
            "second loaded_source must return the same Arc — proves no re-decode",
        );

        cache().entries.lock().unwrap().shift_remove(key);
        decoded_cache().entries.lock().unwrap().shift_remove(key);
    }

    #[test]
    fn clear_decoded_cache_empties_it() {
        let key = "test://decoded-clear";
        {
            let mut entries = cache().entries.lock().unwrap();
            entries.shift_remove(key);
            entries.insert(key.into(), CacheEntry::Loaded(Arc::new(tiny_png_bytes())));
        }
        let _ = loaded_source(key);
        assert!(decoded_cache().entries.lock().unwrap().contains_key(key));
        clear_decoded_cache();
        assert!(
            !decoded_cache().entries.lock().unwrap().contains_key(key),
            "clear_decoded_cache must drop every entry",
        );

        cache().entries.lock().unwrap().shift_remove(key);
    }

    #[test]
    fn decoded_cache_evicts_at_cap() {
        // Stuff the decoded cache past the cap directly (skipping the
        // encoded-tier hop), then call `store_decoded` once more and
        // assert size + oldest-evicted.
        let mut decoded = decoded_cache().entries.lock().unwrap();
        decoded.clear();
        let dummy = Arc::new(Pixmap::new(1, 1).unwrap());
        for i in 0..DECODED_CACHE_CAP {
            decoded.insert(format!("test://evict-fixture-{i}"), Arc::clone(&dummy));
        }
        assert_eq!(decoded.len(), DECODED_CACHE_CAP);
        drop(decoded);

        store_decoded("test://evict-fixture-tipover", Arc::clone(&dummy));
        let decoded = decoded_cache().entries.lock().unwrap();
        assert_eq!(
            decoded.len(),
            DECODED_CACHE_CAP,
            "store_decoded must enforce the cap"
        );
        // Oldest (index 0) is gone; newest is at the back.
        assert!(!decoded.contains_key("test://evict-fixture-0"));
        assert!(decoded.contains_key("test://evict-fixture-tipover"));
        drop(decoded);

        // Cleanup so other tests aren't sensitive to leftovers.
        let mut decoded = decoded_cache().entries.lock().unwrap();
        decoded.clear();
    }

    #[test]
    fn loaded_source_bumps_lru_on_hit() {
        // Seed the global cache with three live entries, then read the
        // oldest and confirm it moves to the back so a subsequent
        // overflow doesn't evict the freshly-rendered image.
        let keys: [&str; 3] = [
            "test://lru-bump-old",
            "test://lru-bump-mid",
            "test://lru-bump-new",
        ];
        {
            let mut entries = cache().entries.lock().unwrap();
            for k in &keys {
                entries.shift_remove(*k);
            }
            for k in &keys {
                entries.insert((*k).into(), dummy_loaded());
            }
        }
        // Reads must bump.
        let _ = loaded_source(keys[0]);
        {
            let entries = cache().entries.lock().unwrap();
            // The other two seeded keys should now precede `keys[0]`.
            let idx_old = entries.get_index_of(keys[0]).unwrap();
            let idx_mid = entries.get_index_of(keys[1]).unwrap();
            let idx_new = entries.get_index_of(keys[2]).unwrap();
            assert!(
                idx_mid < idx_old && idx_new < idx_old,
                "loaded_source hit must bump key past its prior neighbours; \
                 got old={idx_old} mid={idx_mid} new={idx_new}",
            );
        }
        // Cleanup so other tests aren't sensitive to leftovers.
        let mut entries = cache().entries.lock().unwrap();
        for k in &keys {
            entries.shift_remove(*k);
        }
    }

    // -----------------------------------------------------------------
    // Video surface: poster / placeholder + play glyph
    // -----------------------------------------------------------------

    #[test]
    fn play_glyph_geometry_is_none_for_degenerate_rect() {
        for (w, h) in [(0.0, 40.0), (40.0, 0.0), (0.0, 0.0)] {
            assert!(play_glyph_geometry(
                LayoutRect {
                    x: 0.0,
                    y: 0.0,
                    w,
                    h
                },
                1.0
            )
            .is_none());
        }
    }

    #[test]
    fn play_glyph_geometry_centers_on_the_rect() {
        let rect = LayoutRect {
            x: 10.0,
            y: 20.0,
            w: 96.0,
            h: 54.0,
        };
        let g = play_glyph_geometry(rect, 1.0).expect("glyph");
        assert!((g.cx - (10.0 + 48.0)).abs() < 0.01);
        assert!((g.cy - (20.0 + 27.0)).abs() < 0.01);
        assert!(g.radius > 0.0 && g.radius <= 54.0 * 0.5);
        // Triangle stays inside the circle.
        for (x, y) in g.triangle {
            let d = ((x - g.cx).powi(2) + (y - g.cy).powi(2)).sqrt();
            assert!(
                d <= g.radius + 0.01,
                "triangle vertex ({x},{y}) escaped the scrim circle",
            );
        }
    }

    #[test]
    fn paint_video_surface_without_poster_paints_dark_box_and_glyph() {
        let mut pm = Pixmap::new(96, 54).unwrap();
        pm.fill(Color::WHITE);
        let rect = LayoutRect {
            x: 0.0,
            y: 0.0,
            w: 96.0,
            h: 54.0,
        };
        let mut cache = ImageRenderCache::new();
        paint_video_surface(&mut pm, rect, None, 1.0, 0.0, true, &mut cache);

        // Corner (away from the centered glyph): the dark #111 box.
        let corner = pm.pixel(4, 4).expect("corner pixel");
        assert!(
            corner.red() < 0x20 && corner.green() < 0x20 && corner.blue() < 0x20,
            "expected dark placeholder at the corner, got R={} G={} B={}",
            corner.red(),
            corner.green(),
            corner.blue(),
        );
        // Center: the white play triangle sits over the placeholder.
        let center = pm.pixel(48, 27).expect("center pixel");
        assert!(
            center.red() > 0xB0 && center.green() > 0xB0 && center.blue() > 0xB0,
            "expected the white play triangle at the center, got R={} G={} B={}",
            center.red(),
            center.green(),
            center.blue(),
        );
    }

    #[test]
    fn paint_video_surface_with_loaded_poster_draws_poster_under_glyph() {
        // Seed a solid-red encoded poster like the Image tests do.
        let key = "test://video-poster-red-8x8";
        let mut img = image::RgbaImage::new(8, 8);
        for px in img.pixels_mut() {
            *px = image::Rgba([0xff, 0, 0, 0xff]);
        }
        let mut png_bytes = Vec::new();
        image::DynamicImage::ImageRgba8(img)
            .write_to(
                &mut std::io::Cursor::new(&mut png_bytes),
                image::ImageFormat::Png,
            )
            .expect("encode red png");
        cache()
            .entries
            .lock()
            .unwrap()
            .insert(key.to_string(), CacheEntry::Loaded(Arc::new(png_bytes)));

        let mut pm = Pixmap::new(96, 96).unwrap();
        pm.fill(Color::WHITE);
        let rect = LayoutRect {
            x: 0.0,
            y: 0.0,
            w: 96.0,
            h: 96.0,
        };
        let mut tile_cache = ImageRenderCache::new();
        paint_video_surface(&mut pm, rect, Some(key), 1.0, 0.0, true, &mut tile_cache);

        // Away from the glyph: poster red, not the dark placeholder.
        let edge = pm.pixel(6, 6).expect("edge pixel");
        assert!(
            edge.red() > 0xC0 && edge.green() < 0x40,
            "expected the red poster at the edge, got R={} G={}",
            edge.red(),
            edge.green(),
        );
        // Center: play triangle (white → green channel jumps) over red.
        let center = pm.pixel(48, 48).expect("center pixel");
        assert!(
            center.green() > 0xA0,
            "expected the white play triangle over the poster, got G={}",
            center.green(),
        );

        cache().entries.lock().unwrap().shift_remove(key);
        decoded_cache().entries.lock().unwrap().shift_remove(key);
    }

    #[test]
    fn paint_video_surface_with_unloaded_poster_falls_back_to_dark_box() {
        // A poster URL that's Loading (queued, not yet fetched) must
        // paint the dark quiet state, not the Image gray placeholder,
        // and never block.
        let key = "http://hypen-test.invalid/video-poster-loading.jpg";
        cache().entries.lock().unwrap().shift_remove(key);
        let mut pm = Pixmap::new(64, 64).unwrap();
        pm.fill(Color::WHITE);
        let rect = LayoutRect {
            x: 0.0,
            y: 0.0,
            w: 64.0,
            h: 64.0,
        };
        let mut tile_cache = ImageRenderCache::new();
        paint_video_surface(&mut pm, rect, Some(key), 1.0, 0.0, true, &mut tile_cache);
        let corner = pm.pixel(3, 3).expect("corner pixel");
        assert!(
            corner.red() < 0x20 && corner.green() < 0x20 && corner.blue() < 0x20,
            "expected dark placeholder while the poster loads, got R={} G={} B={}",
            corner.red(),
            corner.green(),
            corner.blue(),
        );
    }

    #[test]
    fn http_failure_registry_roundtrip() {
        let key = "http://hypen-test.invalid/poster-403.jpg";
        assert!(load_failure(key).is_none());
        test_seed_failure(key, 403, "HTTP 403 fetching poster");
        let failure = load_failure(key).expect("seeded failure");
        assert_eq!(failure.status, 403);
        assert!(failure.message.contains("403"));
    }

    #[test]
    fn loaded_natural_size_reports_decoded_dimensions() {
        let key = "test://natural-size-3x2";
        let pm = Pixmap::new(3, 2).unwrap();
        test_seed_decoded(key, Arc::new(pm));
        assert_eq!(loaded_natural_size(key), Some((3.0, 2.0)));
        assert_eq!(loaded_natural_size("test://natural-size-missing"), None);
        decoded_cache().entries.lock().unwrap().shift_remove(key);
    }
}
