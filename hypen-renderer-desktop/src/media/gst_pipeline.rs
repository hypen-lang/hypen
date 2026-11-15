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
///
/// Why silence is all there is to go on (GStreamer 1.24.2,
/// `ext/adaptivedemux2`): every download — fragment, key, variant
/// playlist, live playlist update — goes through the demuxer's private
/// `DownloadHelper` and its own `SoupSession` (`downloadhelper.c`
/// `downloadhelper_new`), never through an element, a pad or a shared
/// context; a URI libsoup will not take makes
/// `downloadhelper_submit_request` return FALSE with nothing posted, and
/// the callers only log it (`gstadaptivedemux-stream.c`
/// `gst_adaptive_demux2_stream_load_a_fragment`: "Failed to begin
/// fragment download"; `hls/gsthlsdemux-playlist-loader.c`
/// `start_playlist_download`: state STOPPED, no message). The download
/// statistics message is compiled out (`#if 0` in
/// `gst_adaptive_demux2_stream_finish_download`). So the watchdog detects
/// the stall, then confirms a refusal by fetching the playlists the
/// demuxer works from and scanning them ([`check_playlists`]).
const HTTP_ONLY_ADAPTIVE_DEMUXERS: &[&str] = &["hlsdemux2", "dashdemux2", "mssdemux2"];

/// Most manifest bytes buffered for the scan; a larger manifest is
/// passed through unscanned (the stall watchdog still covers it).
const MANIFEST_SCAN_LIMIT: usize = 4 << 20;

/// How long an HTTP-only adaptive demuxer in a restricted pipeline may
/// go, after accepting its manifest, without a single byte of media
/// before [`watch_http_only_demuxer`]'s watchdog gives up on the stream:
/// `resource/NotAuthorized` when the playlists it works from name a URI
/// the pipeline may not open, else a network timeout (`resource/Read`,
/// what `souphttpsrc` reports for a server that stops answering). Longer
/// than the demuxer's own HTTP timeout (10 s), so a slow-to-start but
/// working server is never cut off.
const ADAPTIVE_STALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// How long the stream may be silent (before playback: no media in;
/// during playback: no media in or out while PLAYING) before the
/// watchdog checks the playlists for a refused URI. A refusal is
/// reported as soon as that check finds it.
const ADAPTIVE_STALL_SUSPECT: std::time::Duration = std::time::Duration::from_secs(3);

/// Least time between two playlist checks of one stream.
const ADAPTIVE_RECHECK_INTERVAL: std::time::Duration = std::time::Duration::from_secs(5);

/// How often the stall watchdog looks.
const ADAPTIVE_STALL_CHECK: std::time::Duration = std::time::Duration::from_millis(250);

/// Most playlists one check fetches (the manifest and an HLS master
/// playlist's variants / renditions).
const PLAYLIST_CHECK_LIMIT: usize = 16;

/// Per-request timeout of a playlist check.
const PLAYLIST_CHECK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Test hook: a shorter stall timeout (ms; 0 = the real one). The
/// suspect threshold shrinks with it (to half).
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

/// Test hook: the next HTTP-only demuxer whose parser receives media
/// posts, at that moment, exactly the error GStreamer 1.24's
/// unexposed-pad EOS race posts (see [`is_unexposed_eos_race`]) — in the
/// race's own state (media downloaded into the parser, no demuxer pad
/// exposed yet), made deterministic.
#[cfg(test)]
pub(crate) static INJECT_UNEXPOSED_EOS_RACE: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// The error adaptivedemux2's `gst_adaptive_demux2_stream_error` posts
/// with no download error recorded (1.24.2, `gstadaptivedemux-stream.c`).
#[cfg(test)]
pub(crate) fn unexposed_eos_race_error(demux: &gst::Element) -> gst::Message {
    gst::message::Error::builder(gst::ResourceError::NotFound, "Couldn't download fragments")
        .src(demux)
        .debug("Fragment downloading has failed consecutive times")
        .details(
            gst::Structure::builder("details")
                .field("http-status-code", 200u32)
                .build(),
        )
        .build()
}

fn adaptive_stall_suspect() -> std::time::Duration {
    ADAPTIVE_STALL_SUSPECT.min(adaptive_stall_timeout() / 2)
}

fn adaptive_recheck_interval() -> std::time::Duration {
    ADAPTIVE_RECHECK_INTERVAL.min(adaptive_stall_timeout() / 2)
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

/// What the stall watchdog makes of a stream's silence (see
/// [`StallWatch::verdict`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StallVerdict {
    /// Media is moving, the stream is paused, or the watch is not armed.
    Fine,
    /// Silent long enough to check the playlists for a refused URI.
    Suspect,
    /// No media at all since the manifest, for the whole stall timeout.
    TimedOut,
}

/// Stall watchdog state of one HTTP-only demuxer (see
/// [`watch_http_only_demuxer`]). Times are milliseconds after `since`.
pub(crate) struct StallWatch {
    since: std::time::Instant,
    /// Last media bytes reaching the demuxer's parser (or the manifest
    /// being accepted). `u64::MAX` until the manifest is accepted (not
    /// armed).
    last_input_ms: std::sync::atomic::AtomicU64,
    /// Last media leaving the demuxer (or the pipeline sitting paused —
    /// a pause is not a stall). `u64::MAX` until media first leaves it.
    last_output_ms: std::sync::atomic::AtomicU64,
    /// End of stream, refused / timed out, or torn down: nothing left
    /// to watch.
    done: std::sync::atomic::AtomicBool,
    /// An error was posted for this stream (one per stream).
    posted: std::sync::atomic::AtomicBool,
    /// A playlist check is running.
    checking: std::sync::atomic::AtomicBool,
    /// The periodic check is scheduled on the clock.
    ticking: std::sync::atomic::AtomicBool,
    /// When the last playlist check started (`u64::MAX`: never).
    last_check_ms: std::sync::atomic::AtomicU64,
    /// The URI the demuxer's manifest came from (redirect-resolved);
    /// what a playlist check fetches.
    manifest_uri: std::sync::Mutex<Option<String>>,
}

impl StallWatch {
    pub(crate) fn new() -> Arc<Self> {
        use std::sync::atomic::{AtomicBool, AtomicU64};
        Arc::new(Self {
            since: std::time::Instant::now(),
            last_input_ms: AtomicU64::new(u64::MAX),
            last_output_ms: AtomicU64::new(u64::MAX),
            done: AtomicBool::new(false),
            posted: AtomicBool::new(false),
            checking: AtomicBool::new(false),
            ticking: AtomicBool::new(false),
            last_check_ms: AtomicU64::new(u64::MAX),
            manifest_uri: std::sync::Mutex::new(None),
        })
    }

    fn now_ms(&self) -> u64 {
        self.since.elapsed().as_millis() as u64
    }

    /// Media bytes reached the demuxer's parser (or the manifest was
    /// accepted — which arms the watch).
    pub(crate) fn progress(&self) {
        self.last_input_ms.store(self.now_ms(), Ordering::SeqCst);
    }

    /// Media left the demuxer.
    pub(crate) fn output(&self) {
        self.last_output_ms.store(self.now_ms(), Ordering::SeqCst);
    }

    fn armed(&self) -> bool {
        self.last_input_ms.load(Ordering::SeqCst) != u64::MAX
    }

    /// True when armed, no media has left the demuxer yet, and no media
    /// byte arrived for longer than `timeout`.
    pub(crate) fn stalled(&self, timeout: std::time::Duration) -> bool {
        self.verdict(false, timeout, timeout) == StallVerdict::TimedOut
    }

    /// The watchdog's reading of the stream right now. `playing`: the
    /// pipeline is PLAYING.
    ///
    /// - Before media first leaves the demuxer, silence is counted from
    ///   the last byte into its parser, whatever the pipeline state (a
    ///   paused pipeline still prerolls): `Suspect` past `suspect`,
    ///   `TimedOut` past `timeout`.
    /// - Once playback has begun, a refusal in a playlist the demuxer
    ///   downloads itself (a live update naming a `file://` segment)
    ///   looks like this: nothing in AND nothing out while PLAYING —
    ///   which a download-ahead pause never does (the demuxer's queued
    ///   output keeps flowing; it stops downloading only while it has
    ///   data). Paused, nothing flows by design: the timer is held. No
    ///   `TimedOut` mid-stream — a network failure there is the
    ///   demuxer's own to report (it retries, then errors).
    pub(crate) fn verdict(
        &self,
        playing: bool,
        suspect: std::time::Duration,
        timeout: std::time::Duration,
    ) -> StallVerdict {
        if self.done.load(Ordering::SeqCst) || !self.armed() {
            return StallVerdict::Fine;
        }
        let now = self.now_ms();
        let input = self.last_input_ms.load(Ordering::SeqCst);
        let output = self.last_output_ms.load(Ordering::SeqCst);
        let quiet = if output == u64::MAX {
            let quiet = now.saturating_sub(input);
            if quiet > timeout.as_millis() as u64 {
                return StallVerdict::TimedOut;
            }
            quiet
        } else {
            if !playing {
                self.output();
                return StallVerdict::Fine;
            }
            now.saturating_sub(input.max(output))
        };
        if quiet > suspect.as_millis() as u64 {
            StallVerdict::Suspect
        } else {
            StallVerdict::Fine
        }
    }

    /// Claim the next playlist check: none running, and none started in
    /// the last `interval`.
    fn claim_check(&self, interval: std::time::Duration) -> bool {
        let last = self.last_check_ms.load(Ordering::SeqCst);
        let now = self.now_ms();
        if last != u64::MAX && now.saturating_sub(last) < interval.as_millis() as u64 {
            return false;
        }
        if self
            .checking
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return false;
        }
        self.last_check_ms.store(now, Ordering::SeqCst);
        true
    }
}

/// The variant / rendition playlists an HLS MASTER playlist names
/// (`#EXT-X-STREAM-INF` URI lines, `URI="…"` of `#EXT-X-MEDIA` and
/// `#EXT-X-I-FRAME-STREAM-INF`), resolved against `base`; only `http(s)`
/// ones. Empty for a media playlist (its URI lines are segments) and for
/// anything that is not HLS.
pub(crate) fn hls_master_playlist_uris(base: &str, text: &str) -> Vec<String> {
    if !text.contains("#EXT-X-STREAM-INF") && !text.contains("#EXT-X-MEDIA:") {
        return Vec::new();
    }
    let mut out: Vec<String> = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        let reference = if line.is_empty() {
            None
        } else if line.starts_with('#') {
            (line.starts_with("#EXT-X-MEDIA:") || line.starts_with("#EXT-X-I-FRAME-STREAM-INF:"))
                .then(|| {
                    let at = line.find("URI=\"")? + 5;
                    let end = line[at..].find('"')?;
                    Some(&line[at..at + end])
                })
                .flatten()
        } else {
            Some(line)
        };
        let Some(reference) = reference else { continue };
        let Some(uri) = url::Url::parse(base)
            .ok()
            .and_then(|base| base.join(reference).ok())
        else {
            continue;
        };
        let uri = uri.to_string();
        let http = uri.split_once(':').is_some_and(|(s, _)| {
            s.eq_ignore_ascii_case("http") || s.eq_ignore_ascii_case("https")
        });
        if http && !out.contains(&uri) {
            out.push(uri);
        }
    }
    out
}

/// Fetch `uri` (http(s) only) as manifest text, at most
/// [`MANIFEST_SCAN_LIMIT`] bytes. `None` when it cannot be fetched.
fn fetch_playlist(uri: &str, timeout: std::time::Duration) -> Option<String> {
    use std::io::Read;
    let http = uri
        .split_once(':')
        .is_some_and(|(s, _)| s.eq_ignore_ascii_case("http") || s.eq_ignore_ascii_case("https"));
    if !http || timeout.is_zero() {
        return None;
    }
    let response = ureq::AgentBuilder::new()
        .timeout(timeout)
        .redirects(5)
        .build()
        .get(uri)
        .call()
        .ok()?;
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(MANIFEST_SCAN_LIMIT as u64 + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    (bytes.len() <= MANIFEST_SCAN_LIMIT).then(|| manifest_text(&bytes))
}

/// Re-read the playlists an adaptive demuxer works from — its manifest
/// and, for an HLS master playlist, every variant / rendition playlist it
/// names (what the demuxer downloads itself, out of the manifest scan's
/// sight) — and scan each with [`manifest_refused_uri`]. Returns
/// `(playlist, refused URI)` for the first refusal found. Bounded: at most
/// [`PLAYLIST_CHECK_LIMIT`] playlists, within twice
/// [`PLAYLIST_CHECK_TIMEOUT`] overall.
pub(crate) fn check_playlists(manifest_uri: &str) -> Option<(String, String)> {
    let deadline = std::time::Instant::now() + PLAYLIST_CHECK_TIMEOUT * 2;
    let remaining = || {
        deadline
            .saturating_duration_since(std::time::Instant::now())
            .min(PLAYLIST_CHECK_TIMEOUT)
    };
    let manifest = fetch_playlist(manifest_uri, remaining())?;
    if let Some(uri) = manifest_refused_uri(&manifest) {
        return Some((manifest_uri.to_string(), uri));
    }
    for playlist in hls_master_playlist_uris(manifest_uri, &manifest)
        .into_iter()
        .take(PLAYLIST_CHECK_LIMIT)
    {
        let Some(text) = fetch_playlist(&playlist, remaining()) else {
            continue;
        };
        if let Some(uri) = manifest_refused_uri(&text) {
            return Some((playlist, uri));
        }
    }
    None
}

/// Post the stall watchdog's network timeout on `pipeline`: the same
/// `resource/Read` `souphttpsrc` reports for a server that stops
/// answering.
fn post_stall_timeout(pipeline: &gst::Element, element: &gst::Element, what: &str) {
    let _ = pipeline.post_message(
        gst::message::Error::builder(
            gst::ResourceError::Read,
            "Could not read from resource: the adaptive stream timed out",
        )
        .src(element)
        .debug(what)
        .build(),
    );
}

/// Run a playlist check ([`check_playlists`]) for `watch` on a thread of
/// its own (a blocking HTTP fetch must not hold a clock or streaming
/// thread) and post what it finds: the refusal, or — when `timed_out` —
/// the network timeout. At most one error per stream.
fn spawn_playlist_check(
    pipeline: gst::glib::WeakRef<gst::Element>,
    element: gst::glib::WeakRef<gst::Element>,
    watch: Arc<StallWatch>,
    timed_out: Option<std::time::Duration>,
) {
    let uri = watch
        .manifest_uri
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone();
    let spawned = std::thread::Builder::new()
        .name("hypen-media-playlist-check".into())
        .spawn(move || {
            let refused = uri.as_deref().and_then(check_playlists);
            watch.checking.store(false, Ordering::SeqCst);
            let (Some(pipeline), Some(element)) = (pipeline.upgrade(), element.upgrade()) else {
                return;
            };
            if pipeline.current_state() == gst::State::Null {
                return; // torn down meanwhile
            }
            if let Some((playlist, uri)) = refused {
                if watch.posted.swap(true, Ordering::SeqCst) {
                    return;
                }
                watch.done.store(true, Ordering::SeqCst);
                log::warn!("video: a remote app's adaptive stream names {uri} (in {playlist}); refusing it");
                post_refusal(
                    &pipeline,
                    &element,
                    &format!("the adaptive demuxer refused {uri}, named by {playlist}"),
                );
            } else if let Some(timeout) = timed_out {
                if watch.posted.swap(true, Ordering::SeqCst) {
                    return;
                }
                log::warn!(
                    "video: a remote app's adaptive stream fetched no media for {timeout:?} \
                     after its manifest; reporting a network timeout"
                );
                post_stall_timeout(
                    &pipeline,
                    &element,
                    &format!("no media data arrived for {timeout:?} after the manifest"),
                );
            }
        });
    if spawned.is_err() {
        log::warn!("video: could not start a playlist check thread");
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
///    or live playlist update the demuxer downloads itself naming a
///    `file://` segment or key — the demuxer refuses without a word (see
///    [`HTTP_ONLY_ADAPTIVE_DEMUXERS`]) and then never fetches anything.
///    Once the manifest is accepted, a periodic check on the system clock
///    reads the stream's silence ([`StallWatch::verdict`]): media bytes
///    reaching the demuxer's parser and media leaving the demuxer are its
///    signs of life. Silent for [`ADAPTIVE_STALL_SUSPECT`] — before
///    playback, or while PLAYING — it re-reads the playlists the demuxer
///    works from and posts `resource/NotAuthorized` when they name a
///    refused URI ([`check_playlists`]). No media at all for
///    [`ADAPTIVE_STALL_TIMEOUT`] after the manifest, and no refusal
///    found, is a network timeout (`resource/Read`), not a refusal.
///    Everything is scoped to this element: no process-wide hook,
///    nothing depending on GStreamer's debug log.
fn watch_http_only_demuxer(pipeline: &gst::Element, element: &gst::Element) {
    let watch = StallWatch::new();
    let pipeline_weak = pipeline.downgrade();
    let element_weak = element.downgrade();

    // Sign of life in: media bytes reaching any parser the demuxer adds
    // (adaptivedemux2 feeds each fragment, as it downloads, into a
    // `parsebin` inside the demuxer bin).
    if let Some(bin) = element.dynamic_cast_ref::<gst::Bin>() {
        let watch = Arc::clone(&watch);
        bin.connect_element_added(move |demux, child| {
            #[cfg(test)]
            if child
                .factory()
                .is_some_and(|f| f.name().as_str() == "parsebin")
            {
                let demux = demux.clone().upcast::<gst::Element>();
                for pad in child.sink_pads() {
                    let demux = demux.clone();
                    pad.add_probe(gst::PadProbeType::BUFFER, move |_, _| {
                        if INJECT_UNEXPOSED_EOS_RACE.swap(false, Ordering::SeqCst) {
                            let _ = demux.post_message(unexposed_eos_race_error(&demux));
                        }
                        gst::PadProbeReturn::Remove
                    });
                }
            }
            #[cfg(not(test))]
            let _ = demux;
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
    // Sign of life out: media leaving the demuxer. Its EOS ends the watch.
    {
        let watch = Arc::clone(&watch);
        element.connect_pad_added(move |_, pad| {
            if pad.direction() != gst::PadDirection::Src {
                return;
            }
            let watch = Arc::clone(&watch);
            pad.add_probe(
                gst::PadProbeType::BUFFER
                    | gst::PadProbeType::BUFFER_LIST
                    | gst::PadProbeType::EVENT_DOWNSTREAM,
                move |_, info| {
                    if watch.done.load(Ordering::SeqCst) {
                        return gst::PadProbeReturn::Remove;
                    }
                    match &info.data {
                        Some(gst::PadProbeData::Event(event)) => {
                            if event.type_() == gst::EventType::Eos {
                                watch.done.store(true, Ordering::SeqCst);
                            }
                        }
                        _ => watch.output(),
                    }
                    gst::PadProbeReturn::Ok
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
            /// Buffers of a list already taken whole: a pad without a
            /// chain-list function (adaptivedemux2's) hands a list on one
            /// buffer at a time, through this probe again — not counted
            /// twice.
            from_list: std::collections::VecDeque<usize>,
        }
        let manifest = std::sync::Mutex::new(Manifest::default());
        let element_weak = element_weak.clone();
        let pipeline_weak = pipeline_weak.clone();
        let watch = Arc::clone(&watch);
        pad.add_probe(
            gst::PadProbeType::BUFFER
                | gst::PadProbeType::BUFFER_LIST
                | gst::PadProbeType::EVENT_DOWNSTREAM,
            move |pad, info| {
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
                        let ptr = buffer.as_ptr() as usize;
                        if m.from_list.front() == Some(&ptr) {
                            m.from_list.pop_front();
                            return gst::PadProbeReturn::Ok;
                        }
                        m.from_list.clear();
                        if let Ok(map) = buffer.map_readable() {
                            take(map.as_slice(), &mut m);
                        }
                        gst::PadProbeReturn::Ok
                    }
                    Some(gst::PadProbeData::BufferList(list)) => {
                        m.from_list.clear();
                        for buffer in list.iter() {
                            m.from_list.push_back(buffer.as_ptr() as usize);
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
                        let Manifest {
                            bytes, overflowed, ..
                        } = std::mem::take(&mut *m);
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
                            *watch
                                .manifest_uri
                                .lock()
                                .unwrap_or_else(|p| p.into_inner()) = manifest_uri(pad, &pipeline);
                            arm_stall_watchdog(&pipeline, &element, &watch);
                            return gst::PadProbeReturn::Ok;
                        };
                        log::warn!(
                            "video: refusing a manifest that names {uri} in a remote app's media pipeline"
                        );
                        watch.done.store(true, Ordering::SeqCst);
                        watch.posted.store(true, Ordering::SeqCst);
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

/// Where the manifest a demuxer's sink pad just received came from: the
/// upstream source's answer to a URI query (its redirect target when it
/// followed one), else the pipeline's own `uri`.
fn manifest_uri(sink: &gst::Pad, pipeline: &gst::Element) -> Option<String> {
    let mut query = gst::query::Uri::new();
    if sink.peer_query(&mut query) {
        if let (Some(redirect), _) = query.redirection() {
            return Some(redirect.to_string());
        }
        if let Some(uri) = query.uri() {
            return Some(uri.to_string());
        }
    }
    pipeline
        .find_property("uri")
        .and_then(|_| pipeline.property::<Option<String>>("uri"))
}

/// Arm `watch` (the manifest was just accepted — the stream (re)starts:
/// nothing has left the demuxer yet) and, unless it is already ticking,
/// start its periodic check on the system clock (no thread of our own).
/// The check unschedules itself once the watch is done or the pipeline
/// / demuxer is gone (or stopped: a restarted pipeline re-arms here).
fn arm_stall_watchdog(pipeline: &gst::Element, element: &gst::Element, watch: &Arc<StallWatch>) {
    watch.progress();
    watch.last_output_ms.store(u64::MAX, Ordering::SeqCst);
    if !watch.posted.load(Ordering::SeqCst) {
        watch.done.store(false, Ordering::SeqCst);
    }
    if watch.ticking.swap(true, Ordering::SeqCst) {
        return; // already ticking
    }
    let clock = gst::SystemClock::obtain();
    let interval = gst::ClockTime::from_nseconds(ADAPTIVE_STALL_CHECK.as_nanos() as u64);
    let now = clock.time();
    let id = clock.new_periodic_id(now + interval, interval);
    let watch = Arc::clone(watch);
    let pipeline = pipeline.downgrade();
    let element = element.downgrade();
    let timeout = adaptive_stall_timeout();
    let suspect = adaptive_stall_suspect();
    let recheck = adaptive_recheck_interval();
    let _ = id.wait_async(move |_, _, id| {
        let stop = |id: &gst::ClockId| {
            watch.ticking.store(false, Ordering::SeqCst);
            id.unschedule();
        };
        let (Some(pipeline_strong), Some(_)) = (pipeline.upgrade(), element.upgrade()) else {
            stop(id);
            return;
        };
        if watch.done.load(Ordering::SeqCst)
            || watch.posted.load(Ordering::SeqCst)
            || pipeline_strong.current_state() == gst::State::Null
        {
            stop(id);
            return;
        }
        let playing = pipeline_strong.current_state() == gst::State::Playing;
        drop(pipeline_strong);
        match watch.verdict(playing, suspect, timeout) {
            StallVerdict::Fine => {}
            StallVerdict::Suspect => {
                if watch.claim_check(recheck) {
                    spawn_playlist_check(
                        pipeline.clone(),
                        element.clone(),
                        Arc::clone(&watch),
                        None,
                    );
                }
            }
            StallVerdict::TimedOut => {
                // Let a running check finish first (it is bounded); then
                // one last look decides refusal vs timeout.
                if watch
                    .checking
                    .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                    .is_ok()
                {
                    watch.done.store(true, Ordering::SeqCst);
                    stop(id);
                    spawn_playlist_check(
                        pipeline.clone(),
                        element.clone(),
                        Arc::clone(&watch),
                        Some(timeout),
                    );
                }
            }
        }
    });
}

/// Most pipeline restarts one player spends on the unexposed-pad EOS
/// race ([`is_unexposed_eos_race`]) before its error goes through.
const MAX_RACE_RESTARTS: u32 = 3;

/// `true` for the error GStreamer 1.24's adaptivedemux2 posts when a
/// stream it HAS downloaded and parsed reaches its end before the
/// demuxer's output task exposed a pad: `end_of_manifest` finds no output
/// slot yet ("Can't push EOS on non-exposed pad",
/// `gstadaptivedemux-stream.c` `gst_adaptive_demux2_stream_end_of_manifest`)
/// and calls `gst_adaptive_demux2_stream_error` with no download error
/// recorded — `resource/NotFound` "Couldn't download fragments", debug
/// "Fragment downloading has failed consecutive times", details
/// `http-status-code` 200 (the last download succeeded). A race between
/// the demuxer's scheduler and output threads, hit by short streams
/// served at once (a single segment) when the output thread is scheduled
/// late — nothing wrong with the stream, which plays on a retry.
///
/// Told apart from a real download failure by all of: an HTTP-only
/// adaptive demuxer posted it, the last download's status was 200 (a
/// failed download records its own status — 4xx/5xx, or 0 for a
/// transport error — in `http-status-code`), the demuxer exposes no pad
/// yet, and it has a parser (`parsebin`, created just before the first
/// fragment download is submitted). Restarts are capped
/// ([`MAX_RACE_RESTARTS`]), so a look-alike can only delay its error.
pub(crate) fn is_unexposed_eos_race(err: &gst::message::Error) -> bool {
    let Some(demux) = err
        .src()
        .and_then(|s| s.downcast_ref::<gst::Element>())
        .filter(|e| {
            e.factory()
                .is_some_and(|f| HTTP_ONLY_ADAPTIVE_DEMUXERS.contains(&f.name().as_str()))
        })
    else {
        return false;
    };
    let debug = err.debug().map(|d| d.to_string()).unwrap_or_default();
    let status_ok = err
        .details()
        .and_then(|d| d.get::<u32>("http-status-code").ok())
        == Some(200);
    let parsing = demux.dynamic_cast_ref::<gst::Bin>().is_some_and(|bin| {
        bin.children().iter().any(|child| {
            child
                .factory()
                .is_some_and(|f| f.name().as_str() == "parsebin")
        })
    });
    err.error().matches(gst::ResourceError::NotFound)
        && debug.contains("Fragment downloading has failed consecutive times")
        && status_ok
        && demux.src_pads().is_empty()
        && parsing
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
                    // GStreamer 1.24's adaptivedemux2 EOS race: the
                    // stream is fine — restart it (off this streaming
                    // thread) instead of failing the node.
                    if is_unexposed_eos_race(err)
                        && !shared.errored.load(Ordering::Relaxed)
                        && shared.race_restarts.fetch_add(1, Ordering::Relaxed) < MAX_RACE_RESTARTS
                    {
                        if let Some(p) = pipeline_weak.upgrade() {
                            log::warn!(
                                "video: adaptive demuxer hit GStreamer's unexposed-pad EOS race; \
                                 rebuilding the stream"
                            );
                            let shared = Arc::clone(&shared);
                            let node_id = node_id.clone();
                            p.call_async(move |_| super::rebuild_after_race(&node_id, &shared));
                            return gst::BusSyncReply::Drop;
                        }
                    }
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
