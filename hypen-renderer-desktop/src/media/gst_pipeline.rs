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
            _ => Err(format!("refusing non-HTTP media source from a remote app: {src}")),
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
    // fetches anything the manifest names. (At EOS the legacy demuxer
    // then logs a harmless GStreamer-CRITICAL about its missing
    // playlist; the pipeline is torn down on the error below anyway.)
    if factory.as_ref().is_some_and(is_legacy_adaptive_demuxer) {
        for pad in element.sink_pads() {
            pad.add_probe(
                gst::PadProbeType::BUFFER | gst::PadProbeType::BUFFER_LIST,
                |_, _| gst::PadProbeReturn::Drop,
            );
        }
    }
    let _ = pipeline.post_message(
        gst::message::Error::builder(
            gst::ResourceError::NotAuthorized,
            "refusing a non-HTTP media source from a remote app",
        )
        .src(element)
        .debug(&what)
        .build(),
    );
    false
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
