//! The real camera backend (feature `camera`): nokhwa over V4L2 (Linux),
//! AVFoundation (macOS) and Media Foundation (Windows).
//!
//! nokhwa's own `decoding` feature (a mozjpeg C build) is off: frames are
//! converted here — MJPEG through `image`'s JPEG decoder (with the standard
//! Huffman tables re-inserted for webcams that omit them), YUYV / NV12 /
//! RGB / BGR / GRAY by hand — into the packed RGB the drivers use.

use std::time::Instant;

use nokhwa::utils::{
    ApiBackend, CameraFormat, CameraInfo, FrameFormat, RequestedFormat, RequestedFormatType,
    Resolution,
};
use nokhwa::{Camera, NokhwaError};

use crate::device::hw::{CameraBackend, CameraSource, Facing, HwError, RgbFrame};

/// The platform camera stack.
#[derive(Debug, Default, Clone, Copy)]
pub struct NativeCamera;

fn map_err(e: NokhwaError) -> HwError {
    let text = e.to_string();
    let lower = text.to_ascii_lowercase();
    if lower.contains("permission")
        || lower.contains("denied")
        || lower.contains("not authorized")
        || lower.contains("eacces")
    {
        HwError::Denied("camera".into())
    } else if lower.contains("busy") || lower.contains("ebusy") || lower.contains("in use") {
        HwError::Unavailable("camera-busy".into())
    } else {
        HwError::Unavailable(format!(
            "camera: {}",
            text.chars().take(160).collect::<String>()
        ))
    }
}

fn cameras() -> Result<Vec<CameraInfo>, HwError> {
    nokhwa::query(ApiBackend::Auto).map_err(map_err)
}

/// The camera matching a `facing` hint by its name (desktops rarely label
/// cameras; laptops' built-in ones are usually "front"/"FaceTime"/
/// "Integrated"), else the first one.
fn pick(cams: &[CameraInfo], facing: Option<Facing>) -> Option<&CameraInfo> {
    let score = |info: &CameraInfo| -> bool {
        let label = format!("{} {}", info.human_name(), info.description()).to_ascii_lowercase();
        match facing {
            Some(Facing::Front) => ["front", "user", "facetime", "integrated", "built-in"]
                .iter()
                .any(|k| label.contains(k)),
            Some(Facing::Back) => ["back", "rear", "environment", "world"]
                .iter()
                .any(|k| label.contains(k)),
            None => false,
        }
    };
    cams.iter().find(|c| score(c)).or_else(|| cams.first())
}

impl CameraBackend for NativeCamera {
    fn camera_count(&self) -> Result<usize, HwError> {
        match cameras() {
            Ok(v) => Ok(v.len()),
            // Linux without any /dev/video* node reports an error rather
            // than an empty list on some setups: that is "no camera".
            Err(HwError::Unavailable(_)) => Ok(0),
            Err(e) => Err(e),
        }
    }

    fn open(&self, facing: Option<Facing>) -> Result<Box<dyn CameraSource>, HwError> {
        let cams = cameras()?;
        let info = pick(&cams, facing).ok_or(HwError::NoDevice("no-camera"))?;
        const DECODABLE: &[FrameFormat] = &[
            FrameFormat::MJPEG,
            FrameFormat::YUYV,
            FrameFormat::NV12,
            FrameFormat::RAWRGB,
            FrameFormat::RAWBGR,
            FrameFormat::GRAY,
        ];
        let wanted = RequestedFormat::with_formats(
            RequestedFormatType::Closest(CameraFormat::new(
                Resolution::new(1280, 720),
                FrameFormat::MJPEG,
                30,
            )),
            DECODABLE,
        );
        let mut camera = Camera::new(info.index().clone(), wanted)
            .or_else(|_| {
                Camera::new(
                    info.index().clone(),
                    RequestedFormat::with_formats(RequestedFormatType::None, DECODABLE),
                )
            })
            .map_err(map_err)?;
        camera.open_stream().map_err(map_err)?;
        Ok(Box::new(NokhwaSource {
            camera,
            started: Instant::now(),
        }))
    }
}

struct NokhwaSource {
    camera: Camera,
    started: Instant,
}

impl Drop for NokhwaSource {
    fn drop(&mut self) {
        let _ = self.camera.stop_stream();
    }
}

impl CameraSource for NokhwaSource {
    fn next_frame(&mut self) -> Result<RgbFrame, HwError> {
        let buffer = self.camera.frame().map_err(map_err)?;
        let at = self.started.elapsed();
        let res = buffer.resolution();
        let (w, h) = (res.width_x, res.height_y);
        let rgb = to_rgb(buffer.source_frame_format(), buffer.buffer(), w, h)?;
        let (w, h) = rgb.1;
        Ok(RgbFrame {
            width: w,
            height: h,
            rgb: rgb.0,
            at,
        })
    }
}

/// Convert one camera buffer to packed RGB. Returns the pixels and their
/// actual size (an MJPEG frame decodes to its own size).
pub fn to_rgb(
    format: FrameFormat,
    data: &[u8],
    w: u32,
    h: u32,
) -> Result<(Vec<u8>, (u32, u32)), HwError> {
    let px = w as usize * h as usize;
    let short = || HwError::Unavailable("short-frame".into());
    match format {
        FrameFormat::MJPEG => {
            let decoded = image::load_from_memory_with_format(data, image::ImageFormat::Jpeg)
                .or_else(|_| {
                    image::load_from_memory_with_format(
                        &with_default_huffman(data),
                        image::ImageFormat::Jpeg,
                    )
                })
                .map_err(|e| HwError::Unavailable(format!("mjpeg: {e}")))?
                .to_rgb8();
            let (dw, dh) = decoded.dimensions();
            Ok((decoded.into_raw(), (dw, dh)))
        }
        FrameFormat::YUYV => {
            if data.len() < px * 2 {
                return Err(short());
            }
            let mut out = Vec::with_capacity(px * 3);
            for quad in data[..px * 2].chunks_exact(4) {
                let (y0, u, y1, v) = (quad[0], quad[1], quad[2], quad[3]);
                out.extend_from_slice(&yuv_to_rgb(y0, u, v));
                out.extend_from_slice(&yuv_to_rgb(y1, u, v));
            }
            Ok((out, (w, h)))
        }
        FrameFormat::NV12 => {
            let (wu, hu) = (w as usize, h as usize);
            if data.len() < px + px / 2 {
                return Err(short());
            }
            let (ys, uv) = data.split_at(px);
            let mut out = Vec::with_capacity(px * 3);
            for y in 0..hu {
                for x in 0..wu {
                    let i = (y / 2) * wu + (x & !1);
                    let (u, v) = (
                        uv.get(i).copied().unwrap_or(128),
                        uv.get(i + 1).copied().unwrap_or(128),
                    );
                    out.extend_from_slice(&yuv_to_rgb(ys[y * wu + x], u, v));
                }
            }
            Ok((out, (w, h)))
        }
        FrameFormat::RAWRGB => {
            if data.len() < px * 3 {
                return Err(short());
            }
            Ok((data[..px * 3].to_vec(), (w, h)))
        }
        FrameFormat::RAWBGR => {
            if data.len() < px * 3 {
                return Err(short());
            }
            let mut out = Vec::with_capacity(px * 3);
            for bgr in data[..px * 3].chunks_exact(3) {
                out.extend_from_slice(&[bgr[2], bgr[1], bgr[0]]);
            }
            Ok((out, (w, h)))
        }
        FrameFormat::GRAY => {
            if data.len() < px {
                return Err(short());
            }
            let mut out = Vec::with_capacity(px * 3);
            for &g in &data[..px] {
                out.extend_from_slice(&[g, g, g]);
            }
            Ok((out, (w, h)))
        }
    }
}

/// BT.601 limited-range YCbCr → RGB.
fn yuv_to_rgb(y: u8, u: u8, v: u8) -> [u8; 3] {
    let c = f32::from(y) - 16.0;
    let d = f32::from(u) - 128.0;
    let e = f32::from(v) - 128.0;
    let clamp = |x: f32| x.round().clamp(0.0, 255.0) as u8;
    [
        clamp(1.164 * c + 1.596 * e),
        clamp(1.164 * c - 0.392 * d - 0.813 * e),
        clamp(1.164 * c + 2.017 * d),
    ]
}

/// Many webcams send "MJPEG" frames without a DHT segment (the AVI1 /
/// Motion-JPEG convention: decoders use the default tables of JPEG Annex
/// K.3). Insert those tables right after SOI when the frame has none.
pub fn with_default_huffman(jpeg: &[u8]) -> Vec<u8> {
    if jpeg.len() < 2
        || jpeg[0] != 0xff
        || jpeg[1] != 0xd8
        || jpeg.windows(2).any(|w| w == [0xff, 0xc4])
    {
        return jpeg.to_vec();
    }
    let mut out = Vec::with_capacity(jpeg.len() + DEFAULT_DHT.len());
    out.extend_from_slice(&jpeg[..2]);
    out.extend_from_slice(DEFAULT_DHT);
    out.extend_from_slice(&jpeg[2..]);
    out
}

/// The standard luminance/chrominance DC and AC Huffman tables (ITU-T T.81
/// Annex K.3) as one DHT segment.
const DEFAULT_DHT: &[u8] = &[
    0xff, 0xc4, 0x01, 0xa2, // DHT, length 418
    // DC luminance (class 0, id 0)
    0x00, 0x00, 0x01, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b,
    // DC chrominance (class 0, id 1)
    0x01, 0x00, 0x03, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b,
    // AC luminance (class 1, id 0)
    0x10, 0x00, 0x02, 0x01, 0x03, 0x03, 0x02, 0x04, 0x03, 0x05, 0x05, 0x04, 0x04, 0x00, 0x00, 0x01,
    0x7d, 0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61,
    0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1,
    0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27,
    0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
    0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
    0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88,
    0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6,
    0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4,
    0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1,
    0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7,
    0xf8, 0xf9, 0xfa, // AC chrominance (class 1, id 1)
    0x11, 0x00, 0x02, 0x01, 0x02, 0x04, 0x04, 0x03, 0x04, 0x07, 0x05, 0x04, 0x04, 0x00, 0x01, 0x02,
    0x77, 0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61,
    0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52,
    0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a,
    0x26, 0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47,
    0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67,
    0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86,
    0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4,
    0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2,
    0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9,
    0xda, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7,
    0xf8, 0xf9, 0xfa,
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_huffman_segment_is_well_formed() {
        let len = u16::from_be_bytes([DEFAULT_DHT[2], DEFAULT_DHT[3]]) as usize;
        assert_eq!(len + 2, DEFAULT_DHT.len());
        // Each table: 1 class/id byte + 16 counts + sum(counts) symbols.
        let mut at = 4;
        let mut tables = 0;
        while at < DEFAULT_DHT.len() {
            let n: usize = DEFAULT_DHT[at + 1..at + 17]
                .iter()
                .map(|&c| c as usize)
                .sum();
            at += 17 + n;
            tables += 1;
        }
        assert_eq!((at, tables), (DEFAULT_DHT.len(), 4));
    }

    #[test]
    fn mjpeg_frames_without_huffman_tables_decode() {
        // A real JPEG, then its DHT segments stripped (as AVI1 webcams send).
        let img = image::RgbImage::from_fn(32, 16, |x, y| {
            image::Rgb([(x * 8) as u8, (y * 16) as u8, 90])
        });
        let mut jpeg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 90)
            .encode(img.as_raw(), 32, 16, image::ExtendedColorType::Rgb8)
            .unwrap();
        let mut stripped = Vec::new();
        let mut i = 0;
        while i < jpeg.len() {
            if i + 4 <= jpeg.len() && jpeg[i] == 0xff && jpeg[i + 1] == 0xc4 {
                let l = u16::from_be_bytes([jpeg[i + 2], jpeg[i + 3]]) as usize;
                i += 2 + l;
                continue;
            }
            stripped.push(jpeg[i]);
            i += 1;
        }
        assert!(!stripped.windows(2).any(|w| w == [0xff, 0xc4]));
        let (rgb, (w, h)) = to_rgb(FrameFormat::MJPEG, &stripped, 32, 16).unwrap();
        assert_eq!((w, h, rgb.len()), (32, 16, 32 * 16 * 3));
    }

    #[test]
    fn packed_yuv_formats_convert() {
        // Mid-grey YUYV / NV12 → mid-grey RGB.
        let yuyv = [126u8, 128, 126, 128].repeat(4 * 2 / 2); // 4x2 px
        let (rgb, _) = to_rgb(FrameFormat::YUYV, &yuyv, 4, 2).unwrap();
        assert_eq!(rgb.len(), 4 * 2 * 3);
        assert!(rgb.iter().all(|&c| (126..=130).contains(&c)), "{rgb:?}");
        let mut nv12 = vec![126u8; 8];
        nv12.extend_from_slice(&[128; 4]);
        let (rgb, _) = to_rgb(FrameFormat::NV12, &nv12, 4, 2).unwrap();
        assert!(rgb.iter().all(|&c| (126..=130).contains(&c)));
        let (rgb, _) = to_rgb(FrameFormat::RAWBGR, &[1, 2, 3], 1, 1).unwrap();
        assert_eq!(rgb, [3, 2, 1]);
        assert!(to_rgb(FrameFormat::YUYV, &[0; 3], 4, 2).is_err());
    }
}
