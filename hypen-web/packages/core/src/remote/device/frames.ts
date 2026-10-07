/**
 * Device Capability Protocol — binary frame codec (RFC 001 §2.3).
 *
 * Native per SDK by design (the engine is never on the device wire path);
 * pinned against the shared golden bytes in
 * engine-compatibility-tests/fixtures/device/frames.json.
 *
 * Layout, little-endian, 12 bytes:
 *   [u8 version=1][u8 flags=0][u16 channel][u32 requestId][u32 seq][payload…]
 *
 * `seq` is a u32: a sender terminates the request before it would wrap past
 * 2^32−1, so the encoder rejects anything outside [0, 2^32−1]. The
 * receiver-side `seq` rule (frames.json `sequences`) is enforced on the
 * server by the Rust broker (hypen-engine-rs/src/device/) and, for
 * downloads, inline by the client runtime.
 */

export const FRAME_HEADER_LEN = 12;
export const FRAME_VERSION = 1;
const U32_MAX = 0xffff_ffff;

export interface FrameHeader {
  version: number;
  flags: number;
  channel: number;
  requestId: number;
  seq: number;
}

export type FrameDecodeError =
  /** Frame shorter than the 12-byte header: drop silently. */
  | { kind: "shortHeader" }
  /** Unknown version or nonzero flags: protocol violation. */
  | { kind: "violation"; detail: string };

export type FrameDecodeResult =
  | { ok: true; header: FrameHeader; payload: Uint8Array }
  | { ok: false; error: FrameDecodeError };

export function encodeFrame(header: FrameHeader, payload: Uint8Array): Uint8Array {
  if (!Number.isInteger(header.seq) || header.seq < 0 || header.seq > U32_MAX) {
    throw new RangeError("seq must be an integer in [0, 2^32-1]");
  }
  const out = new Uint8Array(FRAME_HEADER_LEN + payload.length);
  const view = new DataView(out.buffer);
  view.setUint8(0, header.version);
  view.setUint8(1, header.flags);
  view.setUint16(2, header.channel, true);
  view.setUint32(4, header.requestId, true);
  view.setUint32(8, header.seq, true);
  out.set(payload, FRAME_HEADER_LEN);
  return out;
}

export function decodeFrame(frame: Uint8Array): FrameDecodeResult {
  if (frame.byteLength < FRAME_HEADER_LEN) {
    return { ok: false, error: { kind: "shortHeader" } };
  }
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const version = view.getUint8(0);
  const flags = view.getUint8(1);
  if (version !== FRAME_VERSION) {
    return { ok: false, error: { kind: "violation", detail: `version ${version}` } };
  }
  if (flags !== 0) {
    return { ok: false, error: { kind: "violation", detail: `flags ${flags}` } };
  }
  return {
    ok: true,
    header: {
      version,
      flags,
      channel: view.getUint16(2, true),
      requestId: view.getUint32(4, true),
      seq: view.getUint32(8, true),
    },
    payload: frame.subarray(FRAME_HEADER_LEN),
  };
}
