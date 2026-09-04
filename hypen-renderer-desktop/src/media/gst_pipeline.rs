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

/// Ensure GStreamer is initialised (idempotent, thread-safe).
pub(crate) fn ensure_init() -> Result<(), String> {
    gst::init().map_err(|e| format!("GStreamer init failed: {e}"))
}

/// Build a `playbin` pipeline for `url`, wired to `shared`. The
/// returned element is in the `Null` state — the caller sets it to
/// `Paused` / `Playing`.
pub(crate) fn build(
    node_id: &str,
    url: &str,
    opts: &PlayOpts,
    shared: Arc<PlayerShared>,
) -> Result<gst::Element, String> {
    ensure_init()?;
    let uri = to_uri(url)?;

    let playbin = gst::ElementFactory::make("playbin")
        .build()
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
