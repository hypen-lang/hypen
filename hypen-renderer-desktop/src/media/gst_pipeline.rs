//! GStreamer pipeline construction for [`crate::media`].
//!
//! One `playbin` per playing video: automatic source selection
//! (`souphttpsrc` for http(s), `filesrc` for file://), automatic
//! demux/decoder selection, built-in A/V sync. The video sink is an
//! `appsink` constrained to `video/x-raw,format=RGBA`; its
//! `new_sample` callback copies the frame (tightly packed) into the
//! player's shared slot and wakes the winit loop. The bus sync
//! handler turns EOS / errors into [`MediaEventKind`] events (or a
//! silent seek-to-zero for single-src looping).
//!
//! A remote app's media ([`PlayOpts::restrict_sources`], or any media
//! while the window is in a remote asset scope) plays in a restricted
//! `playbin3`: only `http(s)` / `data:` sources, including every source
//! the stream itself names (HLS / DASH segments, playlists, keys) — see
//! [`guard_remote_element`] and `LEGACY_ADAPTIVE_DEMUXERS`.

use super::{MediaEventKind, PlayOpts, PlayerShared, VideoFrame};
use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_video::prelude::*;
use std::sync::atomic::Ordering;
use std::sync::Arc;

/// Resolve a Video `src` into a URI playbin accepts. http(s), file,
/// data and every other explicit scheme pass through; bare paths get
/// `file://`-ified.
fn to_uri(src: &str) -> Result<String, String> {
    let s = src.trim();
    // A remote app's media URLs resolve against its server like its
    // images do, and never reach local files (see `paint::image`).
    if let Some(origin) = crate::paint::image::remote_origin() {
        return match crate::paint::image::plan_source(s, Some(&*origin)) {
            crate::paint::image::SourcePlan::Http(url) => Ok(url),
            crate::paint::image::SourcePlan::Data => Ok(s.to_string()),
            _ => Err(format!(
                "refusing non-HTTP media source from a remote app: {src}"
            )),
        };
    }
    if s.contains("://") || s.starts_with("data:") {
        return Ok(s.to_string());
    }
    let path = s.strip_prefix("file://").unwrap_or(s);
    let abs = std::path::Path::new(path);
    let abs = if abs.is_absolute() {
        abs.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|e| format!("cwd unavailable for relative media path: {e}"))?
            .join(abs)
    };
    gst::glib::filename_to_uri(&abs, None)
        .map(|u| u.to_string())
        .map_err(|e| format!("cannot build file URI for {src}: {e}"))
}

/// The only URI schemes a restricted (remote-content) pipeline may
/// open: `http`, `https` and `data`.
pub(crate) fn remote_media_uri_allowed(uri: &str) -> bool {
    let Some((scheme, _)) = uri.trim().split_once(':') else {
        return false;
    };
    ["http", "https", "data"]
        .iter()
        .any(|s| scheme.eq_ignore_ascii_case(s))
}

/// Adaptive-streaming demuxers of the LEGACY `adaptivedemux` family
/// (gst-plugins-bad). Besides the per-fragment source elements they add
/// (which [`guard_remote_element`] vets), they fetch variant playlists,
/// manifest updates and encryption keys through an internal
/// `GstUriDownloader` whose source never joins any bin — no signal
/// reaches it, so a remote manifest could make it read a `file://`
/// URI (verified: with `playbin` an HTTP manifest naming a `file://`
/// segment or `EXT-X-KEY` URI reads the local file). Their
/// `adaptivedemux2` successors (`hlsdemux2`, `dashdemux2`, `mssdemux2`,
/// gst-plugins-good) download over HTTP only — but `playbin`'s
/// decodebin never plugs them; only `playbin3` (urisourcebin) does. So a
/// restricted pipeline is a `playbin3` (HLS / DASH keep working, through
/// the HTTP-only demuxers), never plugs a legacy demuxer under `playbin`
/// ([`skip_legacy_demuxers`]), and starves one that gets in anyway
/// ([`guard_remote_element`]).
const LEGACY_ADAPTIVE_DEMUXERS: &[&str] = &["hlsdemux", "dashdemux", "mssdemux"];

fn is_legacy_adaptive_demuxer(factory: &gst::ElementFactory) -> bool {
    LEGACY_ADAPTIVE_DEMUXERS.contains(&factory.name().as_str())
}

/// Make a restricted pipeline's (uri)decodebin never pick a legacy
/// adaptive demuxer: its `autoplug-select` answers `skip` for them (and
/// `try` — the default, which lets the remaining handlers decide — for
/// everything else). Decoding then falls back to the next candidate
/// (`hlsdemux2` …) or fails with a missing-plugin error.
fn skip_legacy_demuxers(decodebin: &gst::Element) {
    if !matches!(
        decodebin.factory().map(|f| f.name().to_string()).as_deref(),
        Some("uridecodebin" | "decodebin")
    ) {
        return;
    }
    let Some(result_type) = gst::glib::Type::from_name("GstAutoplugSelectResult") else {
        return;
    };
    // `glib::Value` isn't `Send`; the handler runs on streaming threads,
    // so it builds its answer from the (thread-safe) GType each time.
    decodebin.connect("autoplug-select", false, move |args| {
        let legacy = args
            .get(3)
            .and_then(|v| v.get::<gst::ElementFactory>().ok())
            .is_some_and(|f| is_legacy_adaptive_demuxer(&f));
        if legacy {
            log::warn!("video: not plugging a legacy adaptive demuxer in a remote app's pipeline");
        }
        gst::glib::EnumClass::with_type(result_type)?.to_value_by_nick(if legacy {
            "skip"
        } else {
            "try"
        })
    });
}

/// Vet one element joining a restricted pipeline (playbin's
/// `element-setup` / `source-setup`, which fire synchronously for every
/// element added anywhere below playbin — including the per-fragment
/// sources an HLS / DASH demuxer creates for the segment URIs its
/// manifest names). A URI source for anything but `http(s)` / `data:`,
/// or a legacy adaptive demuxer that got plugged anyway, is refused:
/// its state is locked (a fragment source's bin is brought up with
/// `sync_state_with_parent`, so a locked `filesrc` never opens its
/// file) and a `resource/NotAuthorized` error is posted STRAIGHT on
/// `pipeline` — demuxers and decodebin swallow their children's errors
/// (fragment retries, autoplug fallbacks) — so the bus handler turns it
/// into the node's `onError` and the window tears the pipeline down.
/// Returns `false` when the element was refused.
pub(crate) fn guard_remote_element(pipeline: &gst::Element, element: &gst::Element) -> bool {
    let factory = element.factory();
    let refusal = if factory.as_ref().is_some_and(is_legacy_adaptive_demuxer) {
        Some(format!(
            "{} (its internal downloader can read local files)",
            factory
                .as_ref()
                .map(|f| f.name().to_string())
                .unwrap_or_default()
        ))
    } else {
        match element.dynamic_cast_ref::<gst::URIHandler>() {
            Some(handler) if handler.uri_type() == gst::URIType::Src => {
                let uri = handler.uri().map(|u| u.to_string());
                match uri {
                    Some(uri) if remote_media_uri_allowed(&uri) => None,
                    other => Some(format!("source {}", other.as_deref().unwrap_or("<no uri>"))),
                }
            }
            _ => {
                skip_legacy_demuxers(element);
                if factory
                    .as_ref()
                    .is_some_and(|f| HTTP_ONLY_ADAPTIVE_DEMUXERS.contains(&f.name().as_str()))
                {
                    watch_http_only_demuxer(pipeline, element);
                }
                None
            }
        }
    };
    let Some(what) = refusal else {
        return true;
    };
    log::warn!("video: refusing {what} in a remote app's media pipeline");
    element.set_locked_state(true);
    // A demuxer is brought up directly by its parent (lock ignored):
    // starve it instead — it never sees its manifest, so it never
    // fetches anything the manifest names. The probe answers `Handled`,
    // not `Drop`: the Rust probe trampoline takes ownership of the
    // buffer (and clears the probe info's pointer), so after `Drop`
    // GStreamer would unref the now-NULL item itself
    // (`gst_mini_object_unref: assertion 'mini_object != NULL'`);
    // `Handled` tells it the probe consumed the item.
    if factory.as_ref().is_some_and(is_legacy_adaptive_demuxer) {
        for pad in element.sink_pads() {
            pad.add_probe(
                gst::PadProbeType::BUFFER | gst::PadProbeType::BUFFER_LIST,
                |_, _| gst::PadProbeReturn::Handled,
            );
        }
    }
    post_refusal(pipeline, element, &what);
    false
}

/// Post the `resource/NotAuthorized` refusal STRAIGHT on `pipeline` (see
/// [`guard_remote_element`]); the bus handler turns it into the node's
/// `onError`.
fn post_refusal(pipeline: &gst::Element, element: &gst::Element, what: &str) {
    let _ = pipeline.post_message(
        gst::message::Error::builder(
            gst::ResourceError::NotAuthorized,
            "refusing a non-HTTP media source from a remote app",
        )
        .src(element)
        .debug(what)
        .build(),
    );
}

/// The HTTP-only adaptive demuxers (`adaptivedemux2`, gst-plugins-good)
/// a restricted pipeline is allowed to use. They refuse a non-HTTP URI
/// named by a manifest on their own (libsoup will not build a request
/// for it) — but SILENTLY: the download never begins, nothing is posted
/// on the bus and the stream stalls forever in `loading`.
/// [`watch_http_only_demuxer`] turns that refusal into the same
/// `resource/NotAuthorized` error the element guard posts.
const HTTP_ONLY_ADAPTIVE_DEMUXERS: &[&str] = &["hlsdemux2", "dashdemux2", "mssdemux2"];

/// Most manifest bytes buffered for the scan; a larger manifest is
/// passed through unscanned (the stall watchdog still covers it).
const MANIFEST_SCAN_LIMIT: usize = 4 << 20;

/// How long an HTTP-only adaptive demuxer in a restricted pipeline may
/// go, after accepting its manifest, without a single byte of media
/// arriving before [`watch_http_only_demuxer`]'s watchdog reports the
/// stream refused. Longer than the demuxer's own HTTP timeout (10 s), so
/// a slow-to-start but working server is never cut off; a demuxer that
/// refused a URI (see [`HTTP_ONLY_ADAPTIVE_DEMUXERS`]) never fetches
/// anything, so it is caught however long this is.
const ADAPTIVE_STALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// How often the stall watchdog looks.
const ADAPTIVE_STALL_CHECK: std::time::Duration = std::time::Duration::from_millis(250);

/// Test hook: a shorter stall timeout (ms; 0 = the real one).
#[cfg(test)]
pub(crate) static ADAPTIVE_STALL_TIMEOUT_MS_OVERRIDE: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);

fn adaptive_stall_timeout() -> std::time::Duration {
    #[cfg(test)]
    {
        let ms = ADAPTIVE_STALL_TIMEOUT_MS_OVERRIDE.load(Ordering::SeqCst);
        if ms > 0 {
            return std::time::Duration::from_millis(ms);
        }
    }
    ADAPTIVE_STALL_TIMEOUT
}

/// Decode `bytes` (a manifest) as text: UTF-16 when it starts with a
/// UTF-16 byte-order mark (an XML manifest may be), else UTF-8 (lossy).
pub(crate) fn manifest_text(bytes: &[u8]) -> String {
    let utf16 = |be: bool| {
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| {
                if be {
                    u16::from_be_bytes([c[0], c[1]])
                } else {
                    u16::from_le_bytes([c[0], c[1]])
                }
            })
            .collect();
        String::from_utf16_lossy(&units)
    };
    match bytes {
        [0xFF, 0xFE, ..] => utf16(false),
        [0xFE, 0xFF, ..] => utf16(true),
        _ => String::from_utf8_lossy(bytes).into_owned(),
    }
}

/// The parts of `manifest` a demuxer acts on, normalised for
/// [`manifest_refused_uri`]: XML comments (`<!-- … -->`) and HLS comment
/// lines (`#` not followed by `EXT`) are dropped — an encoder's
/// `<!-- source: file:///… -->` note is not a URI anything opens — and,
/// in an XML manifest, numeric character references are decoded, as the
/// demuxer's XML parser would (`file&#58;//` IS `file://`).
fn scannable_manifest(manifest: &str) -> String {
    let xml = manifest
        .trim_start_matches('\u{feff}')
        .trim_start()
        .starts_with('<');
    let mut text = String::with_capacity(manifest.len());
    if xml {
        let mut rest = manifest;
        while let Some(start) = rest.find("<!--") {
            text.push_str(&rest[..start]);
            match rest[start + 4..].find("-->") {
                Some(end) => rest = &rest[start + 4 + end + 3..],
                None => {
                    rest = "";
                    break;
                }
            }
        }
        text.push_str(rest);
        return decode_numeric_char_refs(&text);
    }
    for line in manifest.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with('#') && !trimmed.starts_with("#EXT") {
            continue;
        }
        text.push_str(line);
        text.push('\n');
    }
    text
}

/// Decode XML numeric character references (`&#58;`, `&#x3A;`); every
/// other `&` sequence is kept as is.
fn decode_numeric_char_refs(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find("&#") {
        out.push_str(&rest[..at]);
        let after = &rest[at + 2..];
        let decoded = after.find(';').filter(|&end| end <= 10).and_then(|end| {
            let body = &after[..end];
            let code = match body.strip_prefix(['x', 'X']) {
                Some(hex) => u32::from_str_radix(hex, 16).ok(),
                None => body.parse::<u32>().ok(),
            }?;
            Some((char::from_u32(code)?, end))
        });
        match decoded {
            Some((c, end)) => {
                out.push(c);
                rest = &after[end + 1..];
            }
            None => {
                out.push_str("&#");
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// The first absolute URI in `manifest` (an HLS playlist, DASH MPD or
/// Smooth Streaming manifest, as text) whose scheme a restricted
/// pipeline may not open — anything but `http(s)` / `data:`. Relative
/// references resolve against the manifest's own (HTTP) URI and are
/// fine. Scans every `scheme://` and every bare `file:` at a token
/// boundary, wherever it appears (playlist lines, `URI="…"` attributes,
/// `<BaseURL>`, `media=` / `initialization=` templates), so it does not
/// depend on the manifest format — after dropping comments and decoding
/// XML character references ([`scannable_manifest`]).
pub(crate) fn manifest_refused_uri(manifest: &str) -> Option<String> {
    let manifest = scannable_manifest(manifest);
    let manifest = manifest.as_str();
    let bytes = manifest.as_bytes();
    let boundary = |i: usize| {
        i == 0
            || !(bytes[i - 1].is_ascii_alphanumeric() || matches!(bytes[i - 1], b'+' | b'.' | b'-'))
    };
    let uri_at = |start: usize| {
        let end = manifest[start..]
            .find(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | '<' | '>' | ','))
            .map_or(manifest.len(), |e| start + e);
        manifest[start..end].to_string()
    };
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b':' {
            // Walk back over the scheme: ALPHA *( ALPHA / DIGIT / + - . )
            let mut start = i;
            while start > 0
                && (bytes[start - 1].is_ascii_alphanumeric()
                    || matches!(bytes[start - 1], b'+' | b'.' | b'-'))
            {
                start -= 1;
            }
            // A scheme starts with a letter; skip leading digits/marks.
            while start < i && !bytes[start].is_ascii_alphabetic() {
                start += 1;
            }
            let scheme = &manifest[start..i];
            let authority = manifest[i + 1..].starts_with("//");
            if !scheme.is_empty()
                && boundary(start)
                && (authority || scheme.eq_ignore_ascii_case("file"))
            {
                let candidate = uri_at(start);
                if !remote_media_uri_allowed(&candidate) {
                    return Some(candidate);
                }
            }
        }
        i += 1;
    }
    None
}

/// Stall watchdog state of one HTTP-only demuxer (see
/// [`watch_http_only_demuxer`]).
pub(crate) struct StallWatch {
    since: std::time::Instant,
    /// Milliseconds after `since` of the last sign of life — the
    /// manifest being accepted, or media bytes reaching the demuxer's
    /// parser. `u64::MAX` until the manifest is accepted (not armed).
    last_progress_ms: std::sync::atomic::AtomicU64,
    /// Media left the demuxer (or the stream was refused / torn down):
    /// the watchdog has nothing left to do.
    done: std::sync::atomic::AtomicBool,
}

impl StallWatch {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self {
            since: std::time::Instant::now(),
            last_progress_ms: std::sync::atomic::AtomicU64::new(u64::MAX),
            done: std::sync::atomic::AtomicBool::new(false),
        })
    }

    pub(crate) fn progress(&self) {
        let now = self.since.elapsed().as_millis() as u64;
        self.last_progress_ms.store(now, Ordering::SeqCst);
    }

    /// True when armed and silent for longer than `timeout`.
    pub(crate) fn stalled(&self, timeout: std::time::Duration) -> bool {
        let last = self.last_progress_ms.load(Ordering::SeqCst);
        last != u64::MAX
            && (self.since.elapsed().as_millis() as u64).saturating_sub(last)
                > timeout.as_millis() as u64
    }
}

/// Watch an HTTP-only adaptive demuxer joining a restricted pipeline.
///
/// 1. **Manifest scan.** Its sink pad sees the whole top-level manifest
///    before the demuxer acts on it (at EOS). When the manifest names a
///    URI the pipeline may not open ([`manifest_refused_uri`]), the
///    manifest's EOS is withheld — the demuxer never parses it, so it
///    never tries the URI — and the refusal is posted at once.
/// 2. **Stall watchdog.** What the scan cannot see — a variant playlist
///    or manifest update the demuxer downloads itself naming a `file://`
///    segment or key, a manifest too large to buffer — the demuxer
///    refuses without a word and then never fetches anything. So once
///    the manifest is accepted, a periodic check on the system clock
///    posts the refusal if no media byte reaches the demuxer's parser
///    for [`ADAPTIVE_STALL_TIMEOUT`]. It stands down as soon as media
///    leaves the demuxer (a refusal mid-stream, after playback began,
///    is not detected — the demuxer's download-ahead pauses look the
///    same). Everything is scoped to this element: no process-wide
///    hook, nothing depending on GStreamer's debug log.
fn watch_http_only_demuxer(pipeline: &gst::Element, element: &gst::Element) {
    let watch = StallWatch::new();
    let pipeline_weak = pipeline.downgrade();
    let element_weak = element.downgrade();

    // Sign of life: media bytes reaching any parser the demuxer adds
    // (adaptivedemux2 feeds each fragment, as it downloads, into a
    // `parsebin` inside the demuxer bin).
    if let Some(bin) = element.dynamic_cast_ref::<gst::Bin>() {
        let watch = Arc::clone(&watch);
        bin.connect_element_added(move |_, child| {
            for pad in child.sink_pads() {
                let watch = Arc::clone(&watch);
                pad.add_probe(
                    gst::PadProbeType::BUFFER | gst::PadProbeType::BUFFER_LIST,
                    move |_, _| {
                        if watch.done.load(Ordering::SeqCst) {
                            return gst::PadProbeReturn::Remove;
                        }
                        watch.progress();
                        gst::PadProbeReturn::Ok
                    },
                );
            }
        });
    }
    // Media out of the demuxer: the stream works; stand down.
    {
        let watch = Arc::clone(&watch);
        element.connect_pad_added(move |_, pad| {
            if pad.direction() != gst::PadDirection::Src {
                return;
            }
            let watch = Arc::clone(&watch);
            pad.add_probe(
                gst::PadProbeType::BUFFER | gst::PadProbeType::BUFFER_LIST,
                move |_, _| {
                    watch.done.store(true, Ordering::SeqCst);
                    gst::PadProbeReturn::Remove
                },
            );
        });
    }

    for pad in element.sink_pads() {
        #[derive(Default)]
        struct Manifest {
            bytes: Vec<u8>,
            /// Over [`MANIFEST_SCAN_LIMIT`]: no longer buffered or scanned.
            overflowed: bool,
        }
        let manifest = std::sync::Mutex::new(Manifest::default());
        let element_weak = element_weak.clone();
        let pipeline_weak = pipeline_weak.clone();
        let watch = Arc::clone(&watch);
        pad.add_probe(
            gst::PadProbeType::BUFFER
                | gst::PadProbeType::BUFFER_LIST
                | gst::PadProbeType::EVENT_DOWNSTREAM,
            move |_, info| {
                let mut m = manifest.lock().unwrap_or_else(|p| p.into_inner());
                let take = |data: &[u8], m: &mut Manifest| {
                    if m.overflowed {
                        return;
                    }
                    if m.bytes.len() + data.len() > MANIFEST_SCAN_LIMIT {
                        m.overflowed = true;
                        m.bytes = Vec::new();
                    } else {
                        m.bytes.extend_from_slice(data);
                    }
                };
                match &info.data {
                    Some(gst::PadProbeData::Buffer(buffer)) => {
                        if let Ok(map) = buffer.map_readable() {
                            take(map.as_slice(), &mut m);
                        }
                        gst::PadProbeReturn::Ok
                    }
                    Some(gst::PadProbeData::BufferList(list)) => {
                        for buffer in list.iter() {
                            if let Ok(map) = buffer.map_readable() {
                                take(map.as_slice(), &mut m);
                            }
                        }
                        gst::PadProbeReturn::Ok
                    }
                    Some(gst::PadProbeData::Event(event))
                        if event.type_() == gst::EventType::FlushStop
                            || event.type_() == gst::EventType::StreamStart =>
                    {
                        *m = Manifest::default();
                        gst::PadProbeReturn::Ok
                    }
                    Some(gst::PadProbeData::Event(event))
                        if event.type_() == gst::EventType::Eos =>
                    {
                        let Manifest { bytes, overflowed } = std::mem::take(&mut *m);
                        drop(m);
                        let refused = (!overflowed)
                            .then(|| manifest_refused_uri(&manifest_text(&bytes)))
                            .flatten();
                        let (Some(pipeline), Some(element)) =
                            (pipeline_weak.upgrade(), element_weak.upgrade())
                        else {
                            return gst::PadProbeReturn::Ok;
                        };
                        let Some(uri) = refused else {
                            if overflowed {
                                log::warn!(
                                    "video: a remote app's adaptive manifest is over {MANIFEST_SCAN_LIMIT} bytes; \
                                     not scanned (the stall watchdog still applies)"
                                );
                            }
                            arm_stall_watchdog(&pipeline, &element, &watch);
                            return gst::PadProbeReturn::Ok;
                        };
                        log::warn!(
                            "video: refusing a manifest that names {uri} in a remote app's media pipeline"
                        );
                        watch.done.store(true, Ordering::SeqCst);
                        post_refusal(&pipeline, &element, &format!("manifest names {uri}"));
                        // Consumed (see the legacy probe on `Handled`).
                        gst::PadProbeReturn::Handled
                    }
                    _ => gst::PadProbeReturn::Ok,
                }
            },
        );
    }
}

/// Arm `watch` (the manifest was just accepted) and, the first time,
/// start its periodic check on the system clock (no thread of our own).
/// The check unschedules itself once the watch is done or the pipeline
/// / demuxer is gone.
fn arm_stall_watchdog(pipeline: &gst::Element, element: &gst::Element, watch: &Arc<StallWatch>) {
    let first = watch.last_progress_ms.load(Ordering::SeqCst) == u64::MAX;
    watch.progress();
    if !first {
        return; // a manifest reload: already ticking
    }
    let clock = gst::SystemClock::obtain();
    let interval = gst::ClockTime::from_nseconds(ADAPTIVE_STALL_CHECK.as_nanos() as u64);
    let now = clock.time();
    let id = clock.new_periodic_id(now + interval, interval);
    let watch = Arc::clone(watch);
    let pipeline = pipeline.downgrade();
    let element = element.downgrade();
    let timeout = adaptive_stall_timeout();
    let _ = id.wait_async(move |_, _, id| {
        let (Some(pipeline), Some(element)) = (pipeline.upgrade(), element.upgrade()) else {
            id.unschedule();
            return;
        };
        if watch.done.load(Ordering::SeqCst) || pipeline.current_state() == gst::State::Null {
            id.unschedule();
            return;
        }
        if watch.stalled(timeout) {
            watch.done.store(true, Ordering::SeqCst);
            id.unschedule();
            log::warn!(
                "video: a remote app's adaptive stream fetched no media for {timeout:?} \
                 after its manifest; reporting it refused"
            );
            post_refusal(
                &pipeline,
                &element,
                "the adaptive demuxer fetched no media: a URI its stream names \
                 (a variant playlist's segment or key) is not HTTP(S)",
            );
        }
    });
}

/// Ensure GStreamer is initialised (idempotent, thread-safe).
pub(crate) fn ensure_init() -> Result<(), String> {
    gst::init().map_err(|e| format!("GStreamer init failed: {e}"))
}

/// Build a `playbin` pipeline for `url`, wired to `shared`. The
/// returned element is in the `Null` state — the caller sets it to
/// `Paused` / `Playing`. A restricted pipeline (remote content, see
/// [`PlayOpts::restrict_sources`]) is a `playbin3` with every element
/// vetted by [`guard_remote_element`]; otherwise a `playbin`.
pub(crate) fn build(
    node_id: &str,
    url: &str,
    opts: &PlayOpts,
    shared: Arc<PlayerShared>,
) -> Result<gst::Element, String> {
    ensure_init()?;
    let uri = to_uri(url)?;
    // A remote app's media (a stamped node, or any node while the
    // window is in a remote asset scope) may only reach http(s) / data:
    // — the top-level URI here, and everything the stream itself names
    // via the element guard below.
    let restricted = opts.restrict_sources || crate::paint::image::remote_origin().is_some();
    if restricted && !remote_media_uri_allowed(&uri) {
        return Err(format!(
            "refusing non-HTTP media source from a remote app: {url}"
        ));
    }

    // playbin3 where available for remote content: only it plugs the
    // HTTP-only adaptive demuxers (see `LEGACY_ADAPTIVE_DEMUXERS`).
    let playbin = restricted
        .then(|| gst::ElementFactory::make("playbin3").build().ok())
        .flatten()
        .map_or_else(|| gst::ElementFactory::make("playbin").build(), Ok)
        .map_err(|e| format!("playbin unavailable (is gstreamer-plugins-base installed?): {e}"))?;
    playbin.set_property("uri", &uri);

    // Video sink: RGBA appsink. `drop = true, max_buffers = 2` keeps
    // the appsink from back-pressuring the decoder when the winit
    // loop paints slower than the stream's frame rate — we only ever
    // show the latest frame anyway.
    let caps = gst::Caps::builder("video/x-raw")
        .field("format", "RGBA")
        .build();
    let appsink = gstreamer_app::AppSink::builder()
        .caps(&caps)
        .max_buffers(2)
        .drop(true)
        .sync(true)
        .build();
    {
        let shared = Arc::clone(&shared);
        appsink.set_callbacks(
            gstreamer_app::AppSinkCallbacks::builder()
                .new_sample(move |sink| {
                    let sample = sink.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                    if let Some(frame) = frame_from_sample(&sample) {
                        *shared.frame.lock().expect("frame slot poisoned") = Some(frame);
                        super::bump_frame_generation();
                        super::wake();
                    }
                    Ok(gst::FlowSuccess::Ok)
                })
                .build(),
        );
    }
    playbin.set_property("video-sink", &appsink);

    // Audio sink: muted playback (and therefore headless test runs)
    // uses a clock-synced fakesink — no audio device discovery at
    // all. Unmuted tries the platform autoaudiosink and falls back
    // to fakesink when the element can't even be created, so video
    // still plays on machines with no audio stack.
    let audio_sink = if opts.muted {
        gst::ElementFactory::make("fakesink")
            .property("sync", true)
            .build()
            .ok()
    } else {
        gst::ElementFactory::make("autoaudiosink")
            .build()
            .ok()
            .or_else(|| {
                log::warn!("video: autoaudiosink unavailable; playing without audio");
                gst::ElementFactory::make("fakesink")
                    .property("sync", true)
                    .build()
                    .ok()
            })
    };
    if let Some(sink) = audio_sink {
        playbin.set_property("audio-sink", &sink);
    }
    playbin.set_property("mute", opts.muted);

    if restricted {
        // `element-setup` fires (synchronously, as each is added) for
        // every element anywhere below playbin, before it changes state:
        // the main source, the demuxers decodebin plugs, and the
        // fragment sources an adaptive demuxer creates for the segment
        // URIs its manifest names. `source-setup` is belt and braces
        // for the main source.
        for signal in ["element-setup", "source-setup"] {
            playbin.connect(signal, false, |args| {
                if let (Ok(pipeline), Ok(element)) =
                    (args[0].get::<gst::Element>(), args[1].get::<gst::Element>())
                {
                    guard_remote_element(&pipeline, &element);
                }
                None
            });
        }
    }

    // Extra HTTP request headers via playbin's source-setup signal.
    // souphttpsrc exposes them as a GstStructure-valued
    // `extra-headers` property; sources without the property (file,
    // data) silently skip.
    if !opts.headers.is_empty() {
        let headers = opts.headers.clone();
        playbin.connect("source-setup", false, move |args| {
            let Ok(source) = args[1].get::<gst::Element>() else {
                return None;
            };
            if source.find_property("extra-headers").is_some() {
                let mut builder = gst::Structure::builder("extra-headers");
                for (k, v) in &headers {
                    builder = builder.field(k.as_str(), v.as_str());
                }
                source.set_property("extra-headers", builder.build());
            }
            None
        });
    }

    // Bus sync handler: runs on the posting (streaming) thread. It
    // must not call back into the registry — it only touches the
    // per-player shared slots and the global event queue.
    let bus = playbin
        .bus()
        .ok_or_else(|| "playbin has no bus".to_string())?;
    {
        let node_id = node_id.to_string();
        let looping = opts.looping;
        let shared = Arc::clone(&shared);
        let pipeline_weak = playbin.downgrade();
        bus.set_sync_handler(move |_, msg| {
            match msg.view() {
                gst::MessageView::Eos(_) => {
                    if looping {
                        // Seek back to the start asynchronously —
                        // seeking from the streaming thread that
                        // posted EOS can deadlock on the flush.
                        if let Some(p) = pipeline_weak.upgrade() {
                            p.call_async(|p| {
                                let _ = p.seek_simple(
                                    gst::SeekFlags::FLUSH | gst::SeekFlags::KEY_UNIT,
                                    gst::ClockTime::ZERO,
                                );
                            });
                        }
                    } else if !shared.ended.swap(true, Ordering::Relaxed) {
                        super::push_event(&node_id, MediaEventKind::Ended);
                    }
                }
                gst::MessageView::Error(err) => {
                    // One error per pipeline: GStreamer can post
                    // several elements' errors for one failure.
                    if !shared.errored.swap(true, Ordering::Relaxed) {
                        let gerr = err.error();
                        let debug = err.debug().map(|d| d.to_string()).unwrap_or_default();
                        let message = gerr.to_string();
                        let status =
                            extract_http_status(&message).or_else(|| extract_http_status(&debug));
                        super::push_event(
                            &node_id,
                            MediaEventKind::Error {
                                code: classify_error(&gerr),
                                message,
                                status,
                            },
                        );
                    }
                }
                _ => {}
            }
            gst::BusSyncReply::Drop
        });
    }

    Ok(playbin)
}

/// Copy an appsink sample into a tightly-packed RGBA [`VideoFrame`].
fn frame_from_sample(sample: &gst::Sample) -> Option<VideoFrame> {
    let caps = sample.caps()?;
    let info = gstreamer_video::VideoInfo::from_caps(caps).ok()?;
    let buffer = sample.buffer()?;
    let frame = gstreamer_video::VideoFrameRef::from_buffer_ref_readable(buffer, &info).ok()?;
    let width = info.width();
    let height = info.height();
    let stride = frame.plane_stride()[0] as usize;
    let data = frame.plane_data(0).ok()?;
    let row_bytes = width as usize * 4;
    let mut packed = Vec::with_capacity(row_bytes * height as usize);
    for row in 0..height as usize {
        let start = row * stride;
        let src = data.get(start..start + row_bytes)?;
        packed.extend_from_slice(src);
    }
    Some(VideoFrame {
        width,
        height,
        data: Arc::new(packed),
    })
}

/// Map a GStreamer error domain/kind into a stable-ish `code` string
/// for the contract's `onError` payload.
fn classify_error(err: &gst::glib::Error) -> String {
    if let Some(e) = err.kind::<gst::ResourceError>() {
        return format!("resource/{e:?}");
    }
    if let Some(e) = err.kind::<gst::StreamError>() {
        return format!("stream/{e:?}");
    }
    if let Some(e) = err.kind::<gst::CoreError>() {
        return format!("core/{e:?}");
    }
    if let Some(e) = err.kind::<gst::LibraryError>() {
        return format!("library/{e:?}");
    }
    "unknown".to_string()
}

/// Best-effort HTTP status extraction from a GStreamer error string.
///
/// Only numbers appearing in an **explicit status pattern** count — a
/// bare 3-digit run in the 4xx/5xx range is NOT enough, because error
/// and debug strings routinely embed the stream URL, and a CDN path
/// segment like `/480/` or `/540/` would otherwise fabricate a status
/// for failures where no HTTP transaction ever happened (DNS errors,
/// decode errors). Accepted patterns:
///
/// - `(404)` — souphttpsrc's phrasing, e.g. `Not Found (404), URL: …`.
///   A parenthesised number glued to an identifier is rejected so C
///   source-line references like `gstfilesrc.c(553):` don't match.
/// - `HTTP/1.1 403` — a status-line echo of any HTTP version.
/// - a status keyword directly before the number: `returned 403`,
///   `status 404`, `status: 500`, `code 502`, `response 503`.
pub(crate) fn extract_http_status(text: &str) -> Option<u16> {
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if !bytes[i].is_ascii_digit() {
            i += 1;
            continue;
        }
        let start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i - start != 3 {
            continue;
        }
        // Standalone: not embedded in a longer alnum/dotted run (so
        // the `264` in `h264parse` / `x264` and version-ish `1.403`
        // spellings don't match).
        let prev = if start > 0 {
            Some(bytes[start - 1])
        } else {
            None
        };
        if matches!(prev, Some(c) if c.is_ascii_alphanumeric() || c == b'.') {
            continue;
        }
        if i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'.') {
            continue;
        }
        let Ok(n) = text[start..i].parse::<u16>() else {
            continue;
        };
        if !(400..=599).contains(&n) {
            continue;
        }
        if status_context(text, start, i) {
            return Some(n);
        }
    }
    None
}

/// `true` when the 3-digit run at `text[start..end]` sits in one of the
/// explicit status patterns [`extract_http_status`] accepts.
fn status_context(text: &str, start: usize, end: usize) -> bool {
    let bytes = text.as_bytes();
    // `(404)` — but not `foo.c(553):`, where the paren is glued to an
    // identifier; a genuine `Not Found (404)` has whitespace (or
    // start-of-string) before its paren.
    if start >= 1 && bytes[start - 1] == b'(' && bytes.get(end) == Some(&b')') {
        let ident_paren =
            start >= 2 && (bytes[start - 2].is_ascii_alphanumeric() || bytes[start - 2] == b'.');
        return !ident_paren;
    }
    // The remaining patterns require a plain separator directly before
    // the digits — a URL path segment (`/480/`) never has one.
    if start == 0 || !matches!(bytes[start - 1], b' ' | b'\t' | b':' | b'=') {
        return false;
    }
    let mut j = start;
    while j > 0 && matches!(bytes[j - 1], b' ' | b'\t' | b':' | b'=') {
        j -= 1;
    }
    let word_end = j;
    while j > 0 && !bytes[j - 1].is_ascii_whitespace() {
        j -= 1;
    }
    let word = text[j..word_end].to_ascii_lowercase();
    // `HTTP/1.1 403` — a status line of any HTTP version.
    if word.starts_with("http/") {
        return true;
    }
    matches!(word.as_str(), "returned" | "status" | "code" | "response")
}
