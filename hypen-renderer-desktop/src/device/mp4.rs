//! A minimal **fragmented MP4** (ISO BMFF) muxer for H.264 video — the
//! container of the desktop `camera.capture` video (`video/mp4`).
//!
//! A live recording cannot know its size, and RFC 001 §2.4 forbids spooling
//! it to a temporary file just to learn it, so the item is streamed without
//! a declaration. A classic MP4 (`moov` after `mdat`, or `mdat` with a size
//! written up front) cannot be produced as a stream; a fragmented one can:
//! an init segment (`ftyp` + `moov` with `mvex`, no samples) followed by
//! self-contained `moof` + `mdat` fragments, each emitted as soon as its
//! samples are encoded. This is the layout MSE / DASH / HLS use, and what
//! browsers, QuickTime/AVFoundation, ExoPlayer, ffmpeg and VLC play as a
//! plain file.
//!
//! Input is Annex-B H.264 access units (what OpenH264 emits); SPS/PPS go
//! into `avcC`, samples are stored length-prefixed (4-byte lengths). Sample
//! durations come from the capture timestamps (variable frame rate), so a
//! fragment is written once the next frame's timestamp is known.

use std::time::Duration;

/// Media timescale of the video track (ticks per second).
pub const VIDEO_TIMESCALE: u32 = 90_000;

/// Default duration of the very last sample when no successor exists.
const FALLBACK_SAMPLE_TICKS: u32 = VIDEO_TIMESCALE / 30;

fn push_u16(v: &mut Vec<u8>, x: u16) {
    v.extend_from_slice(&x.to_be_bytes());
}
fn push_u32(v: &mut Vec<u8>, x: u32) {
    v.extend_from_slice(&x.to_be_bytes());
}
fn push_u64(v: &mut Vec<u8>, x: u64) {
    v.extend_from_slice(&x.to_be_bytes());
}

/// A plain box: `size, type, body`.
fn bx(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(8 + body.len());
    push_u32(&mut v, (8 + body.len()) as u32);
    v.extend_from_slice(kind);
    v.extend_from_slice(body);
    v
}

/// A full box: `size, type, version, flags, body`.
fn full(kind: &[u8; 4], version: u8, flags: u32, body: &[u8]) -> Vec<u8> {
    let mut b = Vec::with_capacity(4 + body.len());
    b.push(version);
    b.extend_from_slice(&flags.to_be_bytes()[1..]);
    b.extend_from_slice(body);
    bx(kind, &b)
}

const UNITY_MATRIX: [u32; 9] = [0x0001_0000, 0, 0, 0, 0x0001_0000, 0, 0, 0, 0x4000_0000];

/// Split an Annex-B byte stream into NAL units (start codes removed).
pub fn annexb_nals(data: &[u8]) -> Vec<&[u8]> {
    let mut starts = Vec::new(); // (start code begin, payload begin)
    let mut i = 0;
    while i + 3 <= data.len() {
        if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
            let begin = if i > 0 && data[i - 1] == 0 { i - 1 } else { i };
            starts.push((begin, i + 3));
            i += 3;
        } else {
            i += 1;
        }
    }
    let mut out = Vec::with_capacity(starts.len());
    for (k, &(_, payload)) in starts.iter().enumerate() {
        let end = starts.get(k + 1).map(|&(b, _)| b).unwrap_or(data.len());
        if end > payload {
            out.push(&data[payload..end]);
        }
    }
    out
}

struct Sample {
    data: Vec<u8>,
    decode_ticks: u64,
    duration: u32,
    sync: bool,
}

/// Fragmented-MP4 writer for one H.264 track. Every method returns the
/// bytes that are ready to go out, in order; concatenated they form a valid
/// file.
pub struct FragmentedMp4 {
    width: u16,
    height: u16,
    sps: Option<Vec<u8>>,
    pps: Option<Vec<u8>>,
    init_written: bool,
    origin: Option<Duration>,
    pending: Vec<Sample>,
    sequence: u32,
    last_duration: u32,
    samples_written: u64,
}

impl FragmentedMp4 {
    pub fn new(width: u32, height: u32) -> Self {
        FragmentedMp4 {
            width: width.min(u32::from(u16::MAX)) as u16,
            height: height.min(u32::from(u16::MAX)) as u16,
            sps: None,
            pps: None,
            init_written: false,
            origin: None,
            pending: Vec::new(),
            sequence: 0,
            last_duration: FALLBACK_SAMPLE_TICKS,
            samples_written: 0,
        }
    }

    /// Samples written into fragments so far.
    pub fn samples_written(&self) -> u64 {
        self.samples_written
    }

    fn ticks(&mut self, at: Duration) -> u64 {
        let origin = *self.origin.get_or_insert(at);
        let rel = at.saturating_sub(origin);
        (rel.as_secs_f64() * f64::from(VIDEO_TIMESCALE)).round() as u64
    }

    /// Add one encoded access unit (Annex B) captured at `at`. `sync` marks
    /// an IDR frame. Frames before the first IDR (and before SPS/PPS are
    /// known) are dropped: a fragmented file must start on a sync sample.
    pub fn push(&mut self, annexb: &[u8], at: Duration, sync: bool) -> Vec<u8> {
        let mut sample = Vec::with_capacity(annexb.len() + 16);
        for nal in annexb_nals(annexb) {
            match nal[0] & 0x1f {
                7 => self.sps = Some(nal.to_vec()),
                8 => self.pps = Some(nal.to_vec()),
                9 => {} // access unit delimiter: not stored in MP4 samples
                _ => {
                    push_u32(&mut sample, nal.len() as u32);
                    sample.extend_from_slice(nal);
                }
            }
        }
        if sample.is_empty() {
            return Vec::new(); // a skipped frame: the previous sample lasts longer
        }
        if !self.init_written && (!sync || self.sps.is_none() || self.pps.is_none()) {
            return Vec::new();
        }
        let ticks = self.ticks(at);
        let mut out = Vec::new();
        if !self.init_written {
            out.extend(self.init_segment());
            self.init_written = true;
        }
        if let Some(prev) = self.pending.last_mut() {
            let d = ticks
                .saturating_sub(prev.decode_ticks)
                .clamp(1, u64::from(u32::MAX)) as u32;
            prev.duration = d;
            self.last_duration = d;
        }
        // A new GOP starts a new fragment: everything before it is complete.
        if sync && !self.pending.is_empty() {
            out.extend(self.flush());
        }
        self.pending.push(Sample {
            data: sample,
            decode_ticks: ticks,
            duration: self.last_duration,
            sync,
        });
        out
    }

    /// End of the recording: the last fragment (the final sample lasts as
    /// long as the one before it).
    pub fn finish(&mut self) -> Vec<u8> {
        if let Some(last) = self.pending.last_mut() {
            last.duration = self.last_duration;
        }
        self.flush()
    }

    fn init_segment(&self) -> Vec<u8> {
        let sps = self.sps.as_deref().unwrap_or(&[0x67, 0x42, 0xc0, 0x1e]);
        let pps = self.pps.as_deref().unwrap_or(&[0x68]);
        let mut ftyp = Vec::new();
        ftyp.extend_from_slice(b"isom");
        push_u32(&mut ftyp, 0x200);
        for brand in [b"isom", b"iso6", b"avc1", b"mp41"] {
            ftyp.extend_from_slice(brand);
        }

        // mvhd
        let mut mvhd = Vec::new();
        push_u32(&mut mvhd, 0); // creation
        push_u32(&mut mvhd, 0); // modification
        push_u32(&mut mvhd, 1000); // timescale
        push_u32(&mut mvhd, 0); // duration (fragmented: unknown)
        push_u32(&mut mvhd, 0x0001_0000); // rate 1.0
        push_u16(&mut mvhd, 0x0100); // volume 1.0
        mvhd.extend_from_slice(&[0; 10]); // reserved
        for m in UNITY_MATRIX {
            push_u32(&mut mvhd, m);
        }
        mvhd.extend_from_slice(&[0; 24]); // pre_defined
        push_u32(&mut mvhd, 2); // next_track_ID

        // tkhd
        let mut tkhd = Vec::new();
        push_u32(&mut tkhd, 0);
        push_u32(&mut tkhd, 0);
        push_u32(&mut tkhd, 1); // track_ID
        push_u32(&mut tkhd, 0); // reserved
        push_u32(&mut tkhd, 0); // duration
        tkhd.extend_from_slice(&[0; 8]);
        push_u16(&mut tkhd, 0); // layer
        push_u16(&mut tkhd, 0); // alternate_group
        push_u16(&mut tkhd, 0); // volume (video)
        push_u16(&mut tkhd, 0);
        for m in UNITY_MATRIX {
            push_u32(&mut tkhd, m);
        }
        push_u32(&mut tkhd, u32::from(self.width) << 16);
        push_u32(&mut tkhd, u32::from(self.height) << 16);

        // mdhd
        let mut mdhd = Vec::new();
        push_u32(&mut mdhd, 0);
        push_u32(&mut mdhd, 0);
        push_u32(&mut mdhd, VIDEO_TIMESCALE);
        push_u32(&mut mdhd, 0);
        push_u16(&mut mdhd, 0x55c4); // 'und'
        push_u16(&mut mdhd, 0);

        let mut hdlr = Vec::new();
        push_u32(&mut hdlr, 0);
        hdlr.extend_from_slice(b"vide");
        hdlr.extend_from_slice(&[0; 12]);
        hdlr.extend_from_slice(b"VideoHandler\0");

        let vmhd = full(b"vmhd", 0, 1, &[0; 8]);
        let dref = {
            let mut b = Vec::new();
            push_u32(&mut b, 1);
            b.extend(full(b"url ", 0, 1, &[]));
            full(b"dref", 0, 0, &b)
        };
        let dinf = bx(b"dinf", &dref);

        // avcC
        let mut avcc = vec![
            1,
            sps.get(1).copied().unwrap_or(0x42),
            sps.get(2).copied().unwrap_or(0),
            sps.get(3).copied().unwrap_or(0x1e),
            0xff,
            0xe1,
        ];
        push_u16(&mut avcc, sps.len() as u16);
        avcc.extend_from_slice(sps);
        avcc.push(1);
        push_u16(&mut avcc, pps.len() as u16);
        avcc.extend_from_slice(pps);

        // avc1 visual sample entry
        let mut avc1 = Vec::new();
        avc1.extend_from_slice(&[0; 6]);
        push_u16(&mut avc1, 1); // data_reference_index
        avc1.extend_from_slice(&[0; 16]); // pre_defined + reserved
        push_u16(&mut avc1, self.width);
        push_u16(&mut avc1, self.height);
        push_u32(&mut avc1, 0x0048_0000); // 72 dpi
        push_u32(&mut avc1, 0x0048_0000);
        push_u32(&mut avc1, 0);
        push_u16(&mut avc1, 1); // frame_count
        avc1.extend_from_slice(&[0; 32]); // compressorname
        push_u16(&mut avc1, 0x0018); // depth
        push_u16(&mut avc1, 0xffff); // pre_defined = -1
        avc1.extend(bx(b"avcC", &avcc));

        let stsd = {
            let mut b = Vec::new();
            push_u32(&mut b, 1);
            b.extend(bx(b"avc1", &avc1));
            full(b"stsd", 0, 0, &b)
        };
        let empty_table = |kind: &[u8; 4]| full(kind, 0, 0, &[0; 4]);
        let stsz = full(b"stsz", 0, 0, &[0; 8]);
        let mut stbl = Vec::new();
        stbl.extend(stsd);
        stbl.extend(empty_table(b"stts"));
        stbl.extend(empty_table(b"stsc"));
        stbl.extend(stsz);
        stbl.extend(empty_table(b"stco"));

        let mut minf = Vec::new();
        minf.extend(vmhd);
        minf.extend(dinf);
        minf.extend(bx(b"stbl", &stbl));

        let mut mdia = Vec::new();
        mdia.extend(full(b"mdhd", 0, 0, &mdhd));
        mdia.extend(full(b"hdlr", 0, 0, &hdlr));
        mdia.extend(bx(b"minf", &minf));

        let mut trak = Vec::new();
        trak.extend(full(b"tkhd", 0, 3, &tkhd));
        trak.extend(bx(b"mdia", &mdia));

        let mut trex = Vec::new();
        push_u32(&mut trex, 1); // track_ID
        push_u32(&mut trex, 1); // default_sample_description_index
        push_u32(&mut trex, 0);
        push_u32(&mut trex, 0);
        push_u32(&mut trex, 0);
        let mvex = bx(b"mvex", &full(b"trex", 0, 0, &trex));

        let mut moov = Vec::new();
        moov.extend(full(b"mvhd", 0, 0, &mvhd));
        moov.extend(bx(b"trak", &trak));
        moov.extend(mvex);

        let mut out = bx(b"ftyp", &ftyp);
        out.extend(bx(b"moov", &moov));
        out
    }

    fn flush(&mut self) -> Vec<u8> {
        if self.pending.is_empty() {
            return Vec::new();
        }
        let samples = std::mem::take(&mut self.pending);
        self.sequence += 1;
        let base = samples[0].decode_ticks;

        let build_moof = |data_offset: i32| -> Vec<u8> {
            let mut tfhd = Vec::new();
            push_u32(&mut tfhd, 1); // track_ID
            let mut tfdt = Vec::new();
            push_u64(&mut tfdt, base);
            let mut trun = Vec::new();
            push_u32(&mut trun, samples.len() as u32);
            trun.extend_from_slice(&data_offset.to_be_bytes());
            for s in &samples {
                push_u32(&mut trun, s.duration);
                push_u32(&mut trun, s.data.len() as u32);
                // sync: depends_on = 2 (none); others: depends_on = 1 + non-sync.
                push_u32(&mut trun, if s.sync { 0x0200_0000 } else { 0x0101_0000 });
            }
            let mut traf = Vec::new();
            // default-base-is-moof: data offsets are relative to this moof.
            traf.extend(full(b"tfhd", 0, 0x02_0000, &tfhd));
            traf.extend(full(b"tfdt", 1, 0, &tfdt));
            // data-offset | sample-duration | sample-size | sample-flags
            traf.extend(full(b"trun", 0, 0x0701, &trun));
            let mut mfhd = Vec::new();
            push_u32(&mut mfhd, self.sequence);
            let mut moof = full(b"mfhd", 0, 0, &mfhd);
            moof.extend(bx(b"traf", &traf));
            bx(b"moof", &moof)
        };
        // The data offset points past the moof and the mdat header; the
        // moof's size does not depend on the offset's value.
        let moof_len = build_moof(0).len();
        let moof = build_moof((moof_len + 8) as i32);
        let payload: usize = samples.iter().map(|s| s.data.len()).sum();
        let mut out = Vec::with_capacity(moof.len() + 8 + payload);
        out.extend(moof);
        push_u32(&mut out, (8 + payload) as u32);
        out.extend_from_slice(b"mdat");
        for s in &samples {
            out.extend_from_slice(&s.data);
        }
        self.samples_written += samples.len() as u64;
        out
    }
}

/// Test/diagnostic helper: the top-level boxes of an ISO BMFF byte stream as
/// `(type, offset, size)`; `None` when the boxes do not tile the input.
pub fn top_level_boxes(data: &[u8]) -> Option<Vec<([u8; 4], usize, usize)>> {
    let mut out = Vec::new();
    let mut at = 0;
    while at < data.len() {
        if at + 8 > data.len() {
            return None;
        }
        let size = u32::from_be_bytes(data[at..at + 4].try_into().ok()?) as usize;
        if size < 8 || at + size > data.len() {
            return None;
        }
        let kind: [u8; 4] = data[at + 4..at + 8].try_into().ok()?;
        out.push((kind, at, size));
        at += size;
    }
    Some(out)
}

/// Test/diagnostic helper: the children of a container box body.
pub fn child_boxes(body: &[u8]) -> Option<Vec<([u8; 4], &[u8])>> {
    let boxes = top_level_boxes(body)?;
    Some(
        boxes
            .into_iter()
            .map(|(k, off, size)| (k, &body[off + 8..off + size]))
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn au(nals: &[&[u8]]) -> Vec<u8> {
        let mut v = Vec::new();
        for n in nals {
            v.extend_from_slice(&[0, 0, 0, 1]);
            v.extend_from_slice(n);
        }
        v
    }

    const SPS: &[u8] = &[0x67, 0x42, 0xc0, 0x1f, 0xaa];
    const PPS: &[u8] = &[0x68, 0xce, 0x3c, 0x80];

    #[test]
    fn annexb_splitting_handles_three_and_four_byte_start_codes() {
        let data = [
            0, 0, 0, 1, 0x67, 1, 2, 0, 0, 1, 0x68, 3, 0, 0, 0, 1, 0x65, 9,
        ];
        let nals = annexb_nals(&data);
        assert_eq!(
            nals,
            vec![&[0x67, 1, 2][..], &[0x68, 3][..], &[0x65, 9][..]]
        );
    }

    #[test]
    fn a_stream_is_init_then_self_contained_fragments() {
        let mut m = FragmentedMp4::new(640, 480);
        let ms = Duration::from_millis;
        // A P frame before the first IDR is dropped.
        assert!(m.push(&au(&[&[0x41, 1]]), ms(0), false).is_empty());
        let mut out = m.push(&au(&[SPS, PPS, &[0x65, 1, 2, 3]]), ms(10), true);
        let init = top_level_boxes(&out).unwrap();
        assert_eq!(
            init.iter().map(|b| &b.0).collect::<Vec<_>>(),
            [b"ftyp", b"moov"]
        );
        out.extend(m.push(&au(&[&[0x41, 4]]), ms(43), false));
        out.extend(m.push(&au(&[&[0x41, 5, 6]]), ms(76), false));
        // The next IDR closes the first fragment (3 samples).
        out.extend(m.push(&au(&[SPS, PPS, &[0x65, 7]]), ms(110), true));
        out.extend(m.finish());
        let boxes = top_level_boxes(&out).unwrap();
        let kinds: Vec<&[u8; 4]> = boxes.iter().map(|b| &b.0).collect();
        assert_eq!(
            kinds,
            [b"ftyp", b"moov", b"moof", b"mdat", b"moof", b"mdat"]
        );
        assert_eq!(m.samples_written(), 4);

        // First fragment: trun has 3 samples with durations from the
        // timestamps, and the data offset lands on the mdat payload.
        let (_, moof_off, moof_size) = boxes[2];
        let moof = &out[moof_off + 8..moof_off + moof_size];
        let traf = child_boxes(moof)
            .unwrap()
            .into_iter()
            .find(|b| &b.0 == b"traf")
            .unwrap()
            .1;
        let trun = child_boxes(traf)
            .unwrap()
            .into_iter()
            .find(|b| &b.0 == b"trun")
            .unwrap()
            .1;
        let n = u32::from_be_bytes(trun[4..8].try_into().unwrap());
        assert_eq!(n, 3);
        let offset = i32::from_be_bytes(trun[8..12].try_into().unwrap()) as usize;
        let durations: Vec<u32> = (0..3)
            .map(|i| u32::from_be_bytes(trun[12 + i * 12..16 + i * 12].try_into().unwrap()))
            .collect();
        assert_eq!(durations, [2970, 2970, 3060]); // 33, 33, 34 ms at 90 kHz
        let first_sample_at = moof_off + offset;
        assert_eq!(&out[first_sample_at..first_sample_at + 4], &[0, 0, 0, 4]);
        assert_eq!(
            out[first_sample_at + 4],
            0x65,
            "IDR slice, SPS/PPS moved to avcC"
        );
        // tfdt of the second fragment is the decode time of its IDR.
        let (_, moof2, size2) = boxes[4];
        let traf2 = child_boxes(&out[moof2 + 8..moof2 + size2])
            .unwrap()
            .into_iter()
            .find(|b| &b.0 == b"traf")
            .unwrap()
            .1;
        let tfdt = child_boxes(traf2)
            .unwrap()
            .into_iter()
            .find(|b| &b.0 == b"tfdt")
            .unwrap()
            .1;
        assert_eq!(u64::from_be_bytes(tfdt[4..12].try_into().unwrap()), 9_000);

        // avcC carries the SPS / PPS.
        let (_, moov_off, moov_size) = boxes[1];
        let moov = &out[moov_off..moov_off + moov_size];
        let pos = moov.windows(4).position(|w| w == b"avcC").unwrap();
        assert_eq!(&moov[pos + 4..pos + 8], &[1, 0x42, 0xc0, 0x1f]);
        assert!(moov.windows(SPS.len()).any(|w| w == SPS));
        assert!(moov.windows(4).any(|w| w == b"mvex"));
    }
}
