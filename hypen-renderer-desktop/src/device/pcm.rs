//! PCM16 conversion for `mic.record` (RFC 001 §2.4 "frames as captured"):
//! whatever the input device delivers (any rate, any channel count, float
//! samples) becomes little-endian signed 16-bit PCM at the requested rate,
//! mono or interleaved stereo — the same bytes the web (AudioWorklet), iOS
//! (`AVAudioConverter`) and Android (`AudioRecord`) hosts send as
//! `audio/L16`.
//!
//! [`PcmConverter`] is streaming and stateful: feeding a signal in any
//! chunking yields the same output, so the capture callback can hand it
//! whatever block size the audio backend uses. It also enforces the
//! recording limit (`maxDurationMs` and the revision's item cap) in whole
//! frames, like the other hosts' encoders.

/// The requested wire format.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PcmFormat {
    pub sample_rate: u32,
    /// 1 or 2.
    pub channels: u16,
}

impl PcmFormat {
    /// Bytes per frame (one PCM16 sample per channel).
    pub fn frame_bytes(&self) -> u64 {
        2 * u64::from(self.channels)
    }
}

/// Frames a `maxDurationMs` limit allows at `sample_rate`, rounded up (the
/// web and Android hosts do the same).
pub fn frames_for(duration_ms: u64, sample_rate: u32) -> u64 {
    (duration_ms * u64::from(sample_rate)).div_ceil(1000)
}

/// Whole-millisecond duration of `frames` at `sample_rate`, rounded.
pub fn duration_ms(frames: u64, sample_rate: u32) -> u64 {
    if sample_rate == 0 {
        return 0;
    }
    (frames * 1000 + u64::from(sample_rate) / 2) / u64::from(sample_rate)
}

/// Streaming remix + linear-interpolation resampler + PCM16 encoder.
///
/// Remixing: to mono, every input channel is averaged; to stereo, a mono
/// input is duplicated and a multichannel input keeps its first two
/// channels (front left / right). Resampling is linear interpolation
/// between neighbouring input frames — no low-pass filter, which is fine
/// for the modest ratios between a device's native rate and a requested
/// speech/music rate; the output is deterministic for tests.
#[derive(Debug)]
pub struct PcmConverter {
    in_rate: u32,
    in_channels: u16,
    out: PcmFormat,
    /// Output frames emitted so far.
    produced: u64,
    /// Input frames received so far.
    consumed: u64,
    /// The previous chunk's last (remixed) frame.
    last: Option<[f32; 2]>,
    /// Output frame limit (`maxDurationMs` / item cap), if any.
    max_frames: Option<u64>,
}

impl PcmConverter {
    /// A converter from `in_rate` / `in_channels` to `out`, stopping after
    /// `max_frames` output frames when given.
    pub fn new(in_rate: u32, in_channels: u16, out: PcmFormat, max_frames: Option<u64>) -> Self {
        PcmConverter {
            in_rate: in_rate.max(1),
            in_channels: in_channels.max(1),
            out,
            produced: 0,
            consumed: 0,
            last: None,
            max_frames,
        }
    }

    /// Output frames produced so far.
    pub fn frames(&self) -> u64 {
        self.produced
    }

    /// The recording limit is reached: no further output.
    pub fn is_full(&self) -> bool {
        self.max_frames.is_some_and(|m| self.produced >= m)
    }

    /// Duration of what was produced, in whole milliseconds.
    pub fn duration_ms(&self) -> u64 {
        duration_ms(self.produced, self.out.sample_rate)
    }

    fn remix(&self, frame: &[f32]) -> [f32; 2] {
        match (self.out.channels, frame.len()) {
            (1, n) => {
                let sum: f32 = frame.iter().sum();
                [sum / n as f32, 0.0]
            }
            (_, 1) => [frame[0], frame[0]],
            (_, _) => [frame[0], frame[1]],
        }
    }

    /// Convert interleaved float samples (`-1.0..=1.0`) to PCM16 bytes.
    /// A trailing partial frame is ignored (backends deliver whole frames).
    pub fn push_f32(&mut self, samples: &[f32]) -> Vec<u8> {
        let ch = usize::from(self.in_channels);
        let frames = samples.len() / ch;
        if frames == 0 || self.is_full() {
            return Vec::new();
        }
        let out_ch = usize::from(self.out.channels);
        let mut out = Vec::with_capacity(
            ((frames as u64 * u64::from(self.out.sample_rate) / u64::from(self.in_rate) + 2)
                * 2
                * out_ch as u64) as usize,
        );
        let remixed: Vec<[f32; 2]> = (0..frames)
            .map(|i| self.remix(&samples[i * ch..(i + 1) * ch]))
            .collect();
        // Input frame index of the first frame available to interpolate
        // from (the previous chunk's last frame, when there is one).
        let prev = self.last;
        let base = self.consumed - u64::from(prev.is_some());
        let end = self.consumed + frames as u64 - 1; // last available index
        let frame_at = |idx: u64| -> [f32; 2] {
            if idx < self.consumed {
                prev.expect("index before this chunk implies a previous frame")
            } else {
                remixed[(idx - self.consumed) as usize]
            }
        };
        let (in_rate, out_rate) = (u64::from(self.in_rate), u64::from(self.out.sample_rate));
        loop {
            if self.max_frames.is_some_and(|m| self.produced >= m) {
                break;
            }
            let num = self.produced * in_rate;
            let i = num / out_rate;
            if i < base {
                // Cannot happen after the first chunk; skip defensively.
                self.produced += 1;
                continue;
            }
            let frac = (num % out_rate) as f32 / out_rate as f32;
            let value = if in_rate == out_rate {
                if i > end {
                    break;
                }
                frame_at(i)
            } else {
                if i + 1 > end {
                    break;
                }
                let a = frame_at(i);
                let b = frame_at(i + 1);
                [a[0] + (b[0] - a[0]) * frac, a[1] + (b[1] - a[1]) * frac]
            };
            for &sample in value.iter().take(out_ch) {
                out.extend_from_slice(&to_i16(sample).to_le_bytes());
            }
            self.produced += 1;
        }
        self.last = Some(remixed[frames - 1]);
        self.consumed += frames as u64;
        out
    }

    /// [`Self::push_f32`] for 16-bit integer input.
    pub fn push_i16(&mut self, samples: &[i16]) -> Vec<u8> {
        let floats: Vec<f32> = samples.iter().map(|&s| f32::from(s) / 32768.0).collect();
        self.push_f32(&floats)
    }
}

/// Float sample → PCM16, clamped, rounded to nearest.
pub fn to_i16(sample: f32) -> i16 {
    if sample.is_nan() {
        return 0;
    }
    let scaled = (sample * 32768.0).round();
    scaled.clamp(-32768.0, 32767.0) as i16
}

#[cfg(test)]
mod tests {
    use super::*;

    fn samples(bytes: &[u8]) -> Vec<i16> {
        bytes
            .chunks_exact(2)
            .map(|c| i16::from_le_bytes([c[0], c[1]]))
            .collect()
    }

    #[test]
    fn identity_mono_is_a_plain_pcm16_encoding() {
        let mut c = PcmConverter::new(
            16_000,
            1,
            PcmFormat {
                sample_rate: 16_000,
                channels: 1,
            },
            None,
        );
        let out = c.push_f32(&[0.0, 0.5, -0.5, 1.0, -1.0, 2.0]);
        assert_eq!(samples(&out), [0, 16384, -16384, 32767, -32768, 32767]);
        assert_eq!(c.frames(), 6);
    }

    #[test]
    fn stereo_input_to_mono_averages_and_mono_to_stereo_duplicates() {
        let mono = PcmFormat {
            sample_rate: 8_000,
            channels: 1,
        };
        let mut down = PcmConverter::new(8_000, 2, mono, None);
        assert_eq!(samples(&down.push_f32(&[0.5, -0.5, 0.25, 0.25])), [0, 8192]);
        let stereo = PcmFormat {
            sample_rate: 8_000,
            channels: 2,
        };
        let mut up = PcmConverter::new(8_000, 1, stereo, None);
        assert_eq!(samples(&up.push_f32(&[0.5])), [16384, 16384]);
        // 5.1 input keeps front left/right for stereo.
        let mut surround = PcmConverter::new(8_000, 6, stereo, None);
        assert_eq!(
            samples(&surround.push_f32(&[0.5, -0.5, 0.9, 0.9, 0.9, 0.9])),
            [16384, -16384]
        );
    }

    #[test]
    fn resampling_is_chunking_independent_and_hits_the_target_rate() {
        let out = PcmFormat {
            sample_rate: 16_000,
            channels: 1,
        };
        let input: Vec<f32> = (0..4_800)
            .map(|i| ((i as f32) * 0.01).sin() * 0.8)
            .collect();
        let mut whole = PcmConverter::new(48_000, 1, out, None);
        let a = whole.push_f32(&input);
        let mut parts = PcmConverter::new(48_000, 1, out, None);
        let mut b = Vec::new();
        for chunk in input.chunks(333) {
            b.extend(parts.push_f32(chunk));
        }
        assert_eq!(a, b);
        // 4 800 frames at 48 kHz = 100 ms = 1 600 frames at 16 kHz.
        assert!(
            (1_599..=1_600).contains(&whole.frames()),
            "{}",
            whole.frames()
        );
        // Upsampling 8 → 44.1 kHz also keeps the duration.
        let mut up = PcmConverter::new(
            8_000,
            1,
            PcmFormat {
                sample_rate: 44_100,
                channels: 1,
            },
            None,
        );
        let n: usize = (0..10).map(|_| up.push_f32(&[0.1; 800]).len() / 2).sum();
        assert!((44_090..=44_100).contains(&n), "{n}");
    }

    #[test]
    fn the_frame_limit_truncates_in_whole_frames() {
        let out = PcmFormat {
            sample_rate: 16_000,
            channels: 2,
        };
        let limit = frames_for(10, 16_000); // 160 frames
        let mut c = PcmConverter::new(16_000, 2, out, Some(limit));
        let bytes = c.push_f32(&[0.1; 1_000]);
        assert_eq!(bytes.len() as u64, limit * out.frame_bytes());
        assert!(c.is_full());
        assert!(c.push_f32(&[0.1; 10]).is_empty());
        assert_eq!(c.duration_ms(), 10);
    }

    #[test]
    fn duration_math_matches_the_other_hosts() {
        assert_eq!(frames_for(1, 44_100), 45); // ceil(44.1)
        assert_eq!(frames_for(1_000, 16_000), 16_000);
        assert_eq!(duration_ms(16_000, 16_000), 1_000);
        assert_eq!(duration_ms(8, 16_000), 1); // 0.5 ms rounds up
        assert_eq!(duration_ms(7, 16_000), 0);
    }
}
