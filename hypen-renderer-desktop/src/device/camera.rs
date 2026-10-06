//! The `camera.capture` camera thread: it owns the open camera, feeds the
//! capture panel's live preview, and on the user's command encodes a photo
//! (JPEG, via `image`) or records video (H.264 through OpenH264 into the
//! fragmented MP4 of [`super::mp4`], streamed fragment by fragment).
//!
//! The thread ends — releasing the camera — when the photo is taken, the
//! recording ends (Stop, `maxDurationMs`, the item cap), the camera fails,
//! or the worker drops its command channel (cancel, deadline, disconnect).

use std::sync::mpsc::{Receiver, TryRecvError};
use std::sync::Arc;
#[cfg(feature = "camera")]
use std::time::Duration;
use std::time::Instant;

use super::capture::{CamCmd, CaptureEvent, Emit};
use super::hw::{CameraBackend, Facing, HwError, RgbFrame};
use super::ui::{DeviceUi, PreviewFrame, SurfaceId, SurfaceUpdate};

/// Whether this build can record video (feature `camera`: OpenH264).
pub const VIDEO_SUPPORTED: bool = cfg!(feature = "camera");

/// JPEG quality of photos.
pub const PHOTO_QUALITY: u8 = 90;

/// Preview frames are scaled down to at most this width.
const PREVIEW_MAX_WIDTH: u32 = 640;

/// Headroom kept below the item cap for the last fragment: a recording that
/// reaches it ends normally.
#[cfg(feature = "camera")]
const CAP_HEADROOM: u64 = 2 * 1024 * 1024;

pub(crate) struct CameraJob {
    pub backend: Arc<dyn CameraBackend>,
    pub facing: Option<Facing>,
    pub video: bool,
    pub max_duration_ms: Option<u64>,
    pub max_bytes: u64,
    pub ui: Arc<dyn DeviceUi>,
    pub surface: SurfaceId,
    /// Keeps the capture panel up while this thread holds the camera.
    pub panel: Arc<super::capture::UiGuard>,
    pub emit: Emit,
    pub commands: Receiver<CamCmd>,
}

/// Encode an RGB frame as a baseline JPEG.
pub fn encode_jpeg(frame: &RgbFrame) -> Result<Vec<u8>, HwError> {
    let expected = frame.width as usize * frame.height as usize * 3;
    if frame.width == 0 || frame.height == 0 || frame.rgb.len() < expected {
        return Err(HwError::Internal("malformed-frame".into()));
    }
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, PHOTO_QUALITY)
        .encode(
            &frame.rgb[..expected],
            frame.width,
            frame.height,
            image::ExtendedColorType::Rgb8,
        )
        .map_err(|e| HwError::Internal(format!("jpeg: {e}")))?;
    Ok(out)
}

/// A preview-sized RGBA copy of `frame` (nearest-neighbour downscale).
pub fn preview_of(frame: &RgbFrame) -> PreviewFrame {
    let (w, h) = (frame.width.max(1), frame.height.max(1));
    let (pw, ph) = if w > PREVIEW_MAX_WIDTH {
        (
            PREVIEW_MAX_WIDTH,
            (u64::from(h) * u64::from(PREVIEW_MAX_WIDTH) / u64::from(w)).max(1) as u32,
        )
    } else {
        (w, h)
    };
    let mut rgba = Vec::with_capacity(pw as usize * ph as usize * 4);
    for y in 0..ph {
        let sy = (u64::from(y) * u64::from(h) / u64::from(ph)) as usize;
        for x in 0..pw {
            let sx = (u64::from(x) * u64::from(w) / u64::from(pw)) as usize;
            let i = (sy * w as usize + sx) * 3;
            let px = frame.rgb.get(i..i + 3).unwrap_or(&[0, 0, 0]);
            rgba.extend_from_slice(&[px[0], px[1], px[2], 255]);
        }
    }
    PreviewFrame {
        width: pw,
        height: ph,
        rgba: Arc::new(rgba),
    }
}

pub(crate) fn run(job: CameraJob) {
    let CameraJob {
        backend,
        facing,
        video,
        max_duration_ms,
        max_bytes,
        ui,
        surface,
        panel,
        emit,
        commands,
    } = job;
    // Declared before the camera: locals drop in reverse order, so the
    // camera is released before this thread's hold on the panel.
    let _panel = panel;
    if !super::capture::still_wanted(&_panel) {
        return; // the request ended before the camera opened
    }
    let mut source = match backend.open(facing) {
        Ok(s) => s,
        Err(e) => {
            emit(CaptureEvent::CameraFailed(e));
            return;
        }
    };
    emit(CaptureEvent::CameraOpened);
    let mut last: Option<RgbFrame> = None;
    let mut want_photo = false;
    #[cfg(feature = "camera")]
    let mut recorder: Option<video::Recorder> = None;
    let mut recording_since: Option<Instant> = None;
    loop {
        match commands.try_recv() {
            Ok(CamCmd::Capture) if !video => want_photo = true,
            Ok(CamCmd::Record) if video && recording_since.is_none() => {
                recording_since = Some(Instant::now());
            }
            Ok(CamCmd::Stop) => {
                #[cfg(feature = "camera")]
                if let Some(mut rec) = recorder.take() {
                    let tail = rec.finish();
                    if !tail.is_empty() {
                        emit(CaptureEvent::VideoData(tail));
                    }
                }
                emit(CaptureEvent::VideoEnded(Ok(())));
                return;
            }
            Ok(_) => {}
            Err(TryRecvError::Empty) => {}
            // The request ended: release the camera.
            Err(TryRecvError::Disconnected) => return,
        }
        if want_photo {
            if let Some(frame) = &last {
                emit(CaptureEvent::Photo(encode_jpeg(frame)));
                return;
            }
        }
        let frame = match source.next_frame() {
            Ok(f) => f,
            Err(e) => {
                emit(if recording_since.is_some() {
                    CaptureEvent::VideoEnded(Err(e))
                } else {
                    CaptureEvent::CameraFailed(e)
                });
                return;
            }
        };
        ui.update(surface, SurfaceUpdate::Preview(preview_of(&frame)));
        #[cfg(feature = "camera")]
        if let Some(since) = recording_since {
            let rec = match recorder.as_mut() {
                Some(r) => r,
                None => match video::Recorder::new(frame.width, frame.height) {
                    Ok(r) => recorder.insert(r),
                    Err(e) => {
                        emit(CaptureEvent::VideoEnded(Err(e)));
                        return;
                    }
                },
            };
            match rec.push(&frame) {
                Ok(bytes) => {
                    if !bytes.is_empty() {
                        emit(CaptureEvent::VideoData(bytes));
                    }
                }
                Err(e) => {
                    emit(CaptureEvent::VideoEnded(Err(e)));
                    return;
                }
            }
            // A recording limit ends the recording normally (§2.4).
            let by_time = max_duration_ms.is_some_and(|ms| {
                rec.recorded() >= Duration::from_millis(ms)
                    || since.elapsed() >= Duration::from_millis(ms)
            });
            let by_size = rec.bytes() + CAP_HEADROOM >= max_bytes;
            if by_time || by_size {
                let tail = rec.finish();
                if !tail.is_empty() {
                    emit(CaptureEvent::VideoData(tail));
                }
                emit(CaptureEvent::VideoEnded(Ok(())));
                return;
            }
        }
        #[cfg(not(feature = "camera"))]
        let _ = (recording_since, max_duration_ms, max_bytes);
        last = Some(frame);
    }
}

#[cfg(feature = "camera")]
pub(crate) mod video {
    //! H.264 encoding (OpenH264, built from its bundled source) into the
    //! fragmented MP4 muxer.

    use std::time::Duration;

    use openh264::encoder::{
        BitRate, Encoder, EncoderConfig, FrameRate, FrameType, IntraFramePeriod,
    };
    use openh264::formats::{RgbSliceU8, YUVBuffer};
    use openh264::OpenH264API;

    use super::super::hw::{HwError, RgbFrame};
    use super::super::mp4::FragmentedMp4;

    /// Frames between IDR frames (one fragment each): ~1 s at 30 fps.
    const GOP: u32 = 30;

    pub struct Recorder {
        encoder: Encoder,
        mux: FragmentedMp4,
        width: u32,
        height: u32,
        first_at: Option<Duration>,
        last_at: Duration,
        bytes: u64,
        rgb: Vec<u8>,
    }

    impl Recorder {
        /// A recorder for `width` x `height` frames (cropped to even sizes,
        /// as 4:2:0 H.264 needs).
        pub fn new(width: u32, height: u32) -> Result<Self, HwError> {
            let (w, h) = (width & !1, height & !1);
            if w < 16 || h < 16 {
                return Err(HwError::Internal("frame-too-small".into()));
            }
            // ~1.6 bits per pixel per second: 720p ≈ 1.5 Mbit/s, which
            // keeps ten minutes of video inside the 64 MiB item cap at
            // modest resolutions; larger frames end at the cap normally.
            let bps = (u64::from(w) * u64::from(h) * 16 / 10).clamp(300_000, 3_000_000) as u32;
            let config = EncoderConfig::new()
                .bitrate(BitRate::from_bps(bps))
                .max_frame_rate(FrameRate::from_hz(30.0))
                .intra_frame_period(IntraFramePeriod::from_num_frames(GOP));
            let encoder = Encoder::with_api_config(OpenH264API::from_source(), config)
                .map_err(|e| HwError::Internal(format!("h264 encoder: {e}")))?;
            Ok(Recorder {
                encoder,
                mux: FragmentedMp4::new(w, h),
                width: w,
                height: h,
                first_at: None,
                last_at: Duration::ZERO,
                bytes: 0,
                rgb: Vec::new(),
            })
        }

        /// Encoded bytes emitted so far.
        pub fn bytes(&self) -> u64 {
            self.bytes
        }

        /// Media time recorded so far.
        pub fn recorded(&self) -> Duration {
            self.first_at
                .map(|f| self.last_at.saturating_sub(f))
                .unwrap_or_default()
        }

        /// Encode one frame; returns finished MP4 bytes (init segment and
        /// completed fragments), possibly none.
        pub fn push(&mut self, frame: &RgbFrame) -> Result<Vec<u8>, HwError> {
            if frame.width < self.width || frame.height < self.height {
                return Ok(Vec::new()); // a resolution change mid-recording: skip
            }
            // Crop to the encoder's (even) size.
            let row = self.width as usize * 3;
            self.rgb.clear();
            for y in 0..self.height as usize {
                let start = y * frame.width as usize * 3;
                let Some(line) = frame.rgb.get(start..start + row) else {
                    return Err(HwError::Internal("malformed-frame".into()));
                };
                self.rgb.extend_from_slice(line);
            }
            let yuv = YUVBuffer::from_rgb8_source(RgbSliceU8::new(
                &self.rgb,
                (self.width as usize, self.height as usize),
            ));
            let first = *self.first_at.get_or_insert(frame.at);
            self.last_at = frame.at;
            let ts =
                openh264::Timestamp::from_millis(frame.at.saturating_sub(first).as_millis() as u64);
            let bitstream = self
                .encoder
                .encode_at(&yuv, ts)
                .map_err(|e| HwError::Internal(format!("h264 encode: {e}")))?;
            let sync = bitstream.frame_type() == FrameType::IDR;
            let annexb = bitstream.to_vec();
            let out = self.mux.push(&annexb, frame.at, sync);
            self.bytes += out.len() as u64;
            Ok(out)
        }

        /// The last fragment.
        pub fn finish(&mut self) -> Vec<u8> {
            let out = self.mux.finish();
            self.bytes += out.len() as u64;
            out
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    pub(crate) fn test_frame(w: u32, h: u32, shade: u8, at_ms: u64) -> RgbFrame {
        let mut rgb = Vec::with_capacity((w * h * 3) as usize);
        for y in 0..h {
            for x in 0..w {
                rgb.extend_from_slice(&[
                    (x * 255 / w.max(1)) as u8,
                    (y * 255 / h.max(1)) as u8,
                    shade,
                ]);
            }
        }
        RgbFrame {
            width: w,
            height: h,
            rgb,
            at: Duration::from_millis(at_ms),
        }
    }

    #[test]
    fn photos_are_real_jpegs_that_decode_back() {
        let frame = test_frame(64, 48, 128, 0);
        let jpeg = encode_jpeg(&frame).unwrap();
        assert_eq!(&jpeg[..3], &[0xff, 0xd8, 0xff]);
        let decoded = image::load_from_memory_with_format(&jpeg, image::ImageFormat::Jpeg).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (64, 48));
        assert!(encode_jpeg(&RgbFrame {
            width: 4,
            height: 4,
            rgb: vec![0; 3],
            at: Duration::ZERO
        })
        .is_err());
    }

    #[test]
    fn previews_are_bounded_rgba() {
        let p = preview_of(&test_frame(1280, 720, 0, 0));
        assert_eq!((p.width, p.height), (640, 360));
        assert_eq!(p.rgba.len(), 640 * 360 * 4);
        let small = preview_of(&test_frame(32, 16, 0, 0));
        assert_eq!((small.width, small.height), (32, 16));
    }

    #[cfg(feature = "camera")]
    #[test]
    fn video_is_h264_in_a_playable_fragmented_mp4() {
        let mut rec = video::Recorder::new(161, 91).unwrap(); // odd sizes crop
        let mut out = Vec::new();
        for i in 0..70u64 {
            out.extend(
                rec.push(&test_frame(161, 91, (i * 3) as u8, i * 33))
                    .unwrap(),
            );
        }
        out.extend(rec.finish());
        let boxes = super::super::mp4::top_level_boxes(&out).expect("boxes tile the stream");
        let kinds: Vec<&[u8; 4]> = boxes.iter().map(|b| &b.0).collect();
        assert_eq!(kinds[0], b"ftyp");
        assert_eq!(kinds[1], b"moov");
        // 70 frames with an IDR every 30: three fragments.
        let fragments = kinds.iter().filter(|k| **k == b"moof").count();
        assert!(fragments >= 3, "{kinds:?}");
        assert_eq!(kinds.iter().filter(|k| **k == b"mdat").count(), fragments);
        assert!(rec.recorded() >= Duration::from_millis(2_200));
        assert_eq!(rec.bytes(), out.len() as u64);
        // The sample entry is avc1 at the cropped, even size.
        let moov = &out[boxes[1].1..boxes[1].1 + boxes[1].2];
        let at = moov.windows(4).position(|w| w == b"avc1").unwrap();
        let wh = &moov[at + 4 + 24..at + 4 + 28];
        assert_eq!(wh, &[0, 160, 0, 90]);
    }
}
