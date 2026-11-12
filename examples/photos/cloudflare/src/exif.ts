/**
 * A small, dependency-free EXIF reader for the photo library.
 *
 * It reads only what the app shows: when the photo was taken, the camera and
 * lens, a few exposure values, the GPS position and the pixel size. Input is
 * untrusted (anything a visitor uploads), so every offset is bounds-checked,
 * IFD walks are capped, and a malformed file simply yields fewer fields —
 * the parser never throws.
 *
 * Formats: JPEG (APP1 "Exif" segment + SOF dimensions), PNG (IHDR + an
 * optional eXIf chunk), WebP (VP8/VP8L/VP8X dimensions + an EXIF chunk), GIF
 * (logical screen size). HEIC is stored and downloadable but not parsed.
 */

export interface PhotoMeta {
  /** "YYYY-MM-DDTHH:MM:SS" wall-clock time from the camera, or "" if absent. */
  takenAt: string;
  /** "+01:00" when the camera recorded its UTC offset, else "". */
  offset: string;
  make: string;
  model: string;
  lens: string;
  /** "f/1.8" */
  aperture: string;
  /** "1/120 s" */
  exposure: string;
  iso: number;
  /** "4.2 mm" */
  focalLength: string;
  width: number;
  height: number;
  /** 1–8, the EXIF Orientation tag (1 when absent). */
  orientation: number;
  /** Decimal degrees, null when the photo has no (valid) GPS position. */
  lat: number | null;
  lon: number | null;
  /** Metres above sea level, null when absent. */
  altitude: number | null;
}

export function emptyMeta(): PhotoMeta {
  return {
    takenAt: "",
    offset: "",
    make: "",
    model: "",
    lens: "",
    aperture: "",
    exposure: "",
    iso: 0,
    focalLength: "",
    width: 0,
    height: 0,
    orientation: 1,
    lat: null,
    lon: null,
    altitude: null,
  };
}

/** Read whatever metadata `bytes` carries. Never throws. */
export function readPhotoMeta(bytes: Uint8Array): PhotoMeta {
  const meta = emptyMeta();
  try {
    if (bytes[0] === 0xff && bytes[1] === 0xd8) readJpeg(bytes, meta);
    else if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) readPng(bytes, meta);
    else if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") readWebp(bytes, meta);
    else if (ascii(bytes, 0, 4) === "GIF8" && bytes.length >= 10) {
      meta.width = bytes[6]! | (bytes[7]! << 8);
      meta.height = bytes[8]! | (bytes[9]! << 8);
    }
  } catch {
    // Truncated or hostile input: keep what was read so far.
  }
  // Rotated 90°/270°: report the size as displayed.
  if (meta.orientation >= 5 && meta.orientation <= 8) {
    [meta.width, meta.height] = [meta.height, meta.width];
  }
  return meta;
}

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------

function startsWith(b: Uint8Array, sig: number[]): boolean {
  return sig.every((v, i) => b[i] === v);
}

function ascii(b: Uint8Array, from: number, to: number): string {
  return String.fromCharCode(...b.subarray(from, Math.min(to, b.length)));
}

function be16(b: Uint8Array, o: number): number {
  return (b[o]! << 8) | b[o + 1]!;
}

function be32(b: Uint8Array, o: number): number {
  return ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
}

function le32(b: Uint8Array, o: number): number {
  return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
}

function readJpeg(b: Uint8Array, meta: PhotoMeta): void {
  let o = 2;
  let sawExif = false;
  // Walk the marker segments up to the image data.
  for (let guard = 0; o + 4 <= b.length && guard < 512; guard++) {
    if (b[o] !== 0xff) return;
    const marker = b[o + 1]!;
    if (marker === 0xff) {
      o++; // fill byte
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return; // EOI / start of scan
    if (marker >= 0xd0 && marker <= 0xd7) {
      o += 2;
      continue;
    }
    const len = be16(b, o + 2);
    if (len < 2 || o + 2 + len > b.length) return;
    const body = o + 4;
    if (marker === 0xe1 && !sawExif && ascii(b, body, body + 6) === "Exif\0\0") {
      sawExif = true;
      readTiff(b.subarray(body + 6, o + 2 + len), meta);
    } else if (
      // SOF0..SOF15, except DHT (C4), JPG (C8) and DAC (CC).
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc &&
      len >= 7
    ) {
      meta.height = be16(b, body + 1);
      meta.width = be16(b, body + 3);
    }
    o += 2 + len;
  }
}

function readPng(b: Uint8Array, meta: PhotoMeta): void {
  let o = 8;
  for (let guard = 0; o + 12 <= b.length && guard < 4096; guard++) {
    const len = be32(b, o);
    const type = ascii(b, o + 4, o + 8);
    const data = o + 8;
    if (data + len > b.length) return;
    if (type === "IHDR" && len >= 8) {
      meta.width = be32(b, data);
      meta.height = be32(b, data + 4);
    } else if (type === "eXIf") {
      readTiff(b.subarray(data, data + len), meta);
    } else if (type === "IDAT" || type === "IEND") {
      // eXIf must come before IDAT; nothing more to find.
      if (type === "IEND") return;
    }
    o = data + len + 4; // + CRC
  }
}

function readWebp(b: Uint8Array, meta: PhotoMeta): void {
  let o = 12;
  for (let guard = 0; o + 8 <= b.length && guard < 256; guard++) {
    const type = ascii(b, o, o + 4);
    const len = le32(b, o + 4);
    const data = o + 8;
    if (data + len > b.length) return;
    if (type === "VP8X" && len >= 10) {
      meta.width = 1 + (b[data + 4]! | (b[data + 5]! << 8) | (b[data + 6]! << 16));
      meta.height = 1 + (b[data + 7]! | (b[data + 8]! << 8) | (b[data + 9]! << 16));
    } else if (type === "VP8 " && len >= 10 && !meta.width) {
      meta.width = (b[data + 6]! | (b[data + 7]! << 8)) & 0x3fff;
      meta.height = (b[data + 8]! | (b[data + 9]! << 8)) & 0x3fff;
    } else if (type === "VP8L" && len >= 5 && !meta.width) {
      const bits = le32(b, data + 1);
      meta.width = (bits & 0x3fff) + 1;
      meta.height = ((bits >>> 14) & 0x3fff) + 1;
    } else if (type === "EXIF") {
      let tiff = b.subarray(data, data + len);
      // Some writers keep the JPEG-style "Exif\0\0" prefix.
      if (ascii(tiff, 0, 6) === "Exif\0\0") tiff = tiff.subarray(6);
      readTiff(tiff, meta);
    }
    o = data + len + (len & 1);
  }
}

// ---------------------------------------------------------------------------
// TIFF / EXIF
// ---------------------------------------------------------------------------

/** Byte sizes of the TIFF field types (1-based; 0 = unknown). */
const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];

interface Entry {
  type: number;
  count: number;
  /** Offset of the value bytes within the TIFF block. */
  at: number;
}

class Tiff {
  constructor(
    readonly b: Uint8Array,
    readonly little: boolean,
  ) {}

  u16(o: number): number {
    if (o + 2 > this.b.length) throw new RangeError("tiff");
    return this.little ? this.b[o]! | (this.b[o + 1]! << 8) : be16(this.b, o);
  }

  u32(o: number): number {
    if (o + 4 > this.b.length) throw new RangeError("tiff");
    return this.little ? le32(this.b, o) : be32(this.b, o);
  }

  i32(o: number): number {
    return this.u32(o) | 0;
  }

  /** The tags of the IFD at `offset` (at most 512 entries). */
  ifd(offset: number): Map<number, Entry> {
    const tags = new Map<number, Entry>();
    if (offset < 8 || offset + 2 > this.b.length) return tags;
    const n = Math.min(this.u16(offset), 512);
    for (let i = 0; i < n; i++) {
      const e = offset + 2 + i * 12;
      if (e + 12 > this.b.length) break;
      const tag = this.u16(e);
      const type = this.u16(e + 2);
      const count = this.u32(e + 4);
      const size = (TYPE_SIZE[type] ?? 0) * count;
      if (!size) continue;
      const at = size <= 4 ? e + 8 : this.u32(e + 8);
      if (at + size > this.b.length) continue;
      tags.set(tag, { type, count, at });
    }
    return tags;
  }

  str(e: Entry | undefined, max = 128): string {
    if (!e || (e.type !== 2 && e.type !== 7)) return "";
    const raw = ascii(this.b, e.at, e.at + Math.min(e.count, max));
    // eslint-disable-next-line no-control-regex
    return raw.replace(/\0[\s\S]*$/, "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
  }

  /** A SHORT/LONG value (first of `count`). */
  int(e: Entry | undefined): number | null {
    if (!e) return null;
    if (e.type === 3) return this.u16(e.at);
    if (e.type === 4) return this.u32(e.at);
    if (e.type === 9) return this.i32(e.at);
    return null;
  }

  /** The `i`th RATIONAL/SRATIONAL value. */
  rational(e: Entry | undefined, i = 0): number | null {
    if (!e || (e.type !== 5 && e.type !== 10) || i >= e.count) return null;
    const o = e.at + i * 8;
    const num = e.type === 5 ? this.u32(o) : this.i32(o);
    const den = e.type === 5 ? this.u32(o + 4) : this.i32(o + 4);
    return den === 0 ? null : num / den;
  }
}

const TAG = {
  make: 0x010f,
  model: 0x0110,
  orientation: 0x0112,
  dateTime: 0x0132,
  exifIfd: 0x8769,
  gpsIfd: 0x8825,
  exposureTime: 0x829a,
  fNumber: 0x829d,
  iso: 0x8827,
  dateTimeOriginal: 0x9003,
  dateTimeDigitized: 0x9004,
  offsetTimeOriginal: 0x9011,
  focalLength: 0x920a,
  pixelX: 0xa002,
  pixelY: 0xa003,
  lensModel: 0xa434,
} as const;

function readTiff(b: Uint8Array, meta: PhotoMeta): void {
  if (b.length < 8) return;
  const order = ascii(b, 0, 2);
  if (order !== "II" && order !== "MM") return;
  const t = new Tiff(b, order === "II");
  if (t.u16(2) !== 42) return;

  const ifd0 = t.ifd(t.u32(4));
  meta.make = t.str(ifd0.get(TAG.make), 64);
  meta.model = t.str(ifd0.get(TAG.model), 64);
  const orientation = t.int(ifd0.get(TAG.orientation));
  if (orientation && orientation >= 1 && orientation <= 8) meta.orientation = orientation;

  const exifAt = t.int(ifd0.get(TAG.exifIfd));
  const exif = exifAt ? t.ifd(exifAt) : new Map<number, Entry>();

  meta.takenAt =
    exifDate(t.str(exif.get(TAG.dateTimeOriginal), 32)) ||
    exifDate(t.str(exif.get(TAG.dateTimeDigitized), 32)) ||
    exifDate(t.str(ifd0.get(TAG.dateTime), 32));
  const offset = t.str(exif.get(TAG.offsetTimeOriginal), 16);
  if (/^[+-]\d{2}:\d{2}$/.test(offset)) meta.offset = offset;

  meta.lens = t.str(exif.get(TAG.lensModel), 64);
  const f = t.rational(exif.get(TAG.fNumber));
  if (f && f > 0 && f < 100) meta.aperture = `f/${trim(f, 1)}`;
  const exp = t.rational(exif.get(TAG.exposureTime));
  if (exp && exp > 0 && exp < 3600) meta.exposure = exp >= 1 ? `${trim(exp, 1)} s` : `1/${Math.round(1 / exp)} s`;
  const iso = t.int(exif.get(TAG.iso));
  if (iso && iso > 0 && iso < 1_000_000) meta.iso = iso;
  const focal = t.rational(exif.get(TAG.focalLength));
  if (focal && focal > 0 && focal < 10_000) meta.focalLength = `${trim(focal, 1)} mm`;
  const px = t.int(exif.get(TAG.pixelX));
  const py = t.int(exif.get(TAG.pixelY));
  if (!meta.width && px && py) {
    meta.width = px;
    meta.height = py;
  }

  const gpsAt = t.int(ifd0.get(TAG.gpsIfd));
  if (gpsAt) readGps(t, t.ifd(gpsAt), meta);
}

function readGps(t: Tiff, gps: Map<number, Entry>, meta: PhotoMeta): void {
  const dms = (e: Entry | undefined): number | null => {
    if (!e || e.count < 3) return null;
    const d = t.rational(e, 0);
    const m = t.rational(e, 1);
    const s = t.rational(e, 2);
    if (d === null || m === null || s === null) return null;
    return d + m / 60 + s / 3600;
  };
  const lat = dms(gps.get(2));
  const lon = dms(gps.get(4));
  const latRef = t.str(gps.get(1), 2).toUpperCase();
  const lonRef = t.str(gps.get(3), 2).toUpperCase();
  if (lat === null || lon === null || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
  const signedLat = latRef === "S" ? -lat : lat;
  const signedLon = lonRef === "W" ? -lon : lon;
  if (Math.abs(signedLat) > 90 || Math.abs(signedLon) > 180) return;
  // 0,0 is what many cameras write when they had no fix.
  if (signedLat === 0 && signedLon === 0) return;
  meta.lat = Math.round(signedLat * 1e6) / 1e6;
  meta.lon = Math.round(signedLon * 1e6) / 1e6;
  const alt = t.rational(gps.get(6));
  if (alt !== null && Number.isFinite(alt)) {
    const below = gps.get(5) ? t.b[gps.get(5)!.at] === 1 : false;
    meta.altitude = Math.round(below ? -alt : alt);
  }
}

/** "2026:11:12 14:30:05" → "2026-11-12T14:30:05", "" when not a real date. */
export function exifDate(raw: string): string {
  const m = /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(raw);
  if (!m) return "";
  const [, y, mo, d, h, mi, s] = m.map(Number) as number[];
  if (y! < 1900 || y! > 2200 || mo! < 1 || mo! > 12 || d! < 1 || d! > 31 || h! > 23 || mi! > 59 || s! > 60) return "";
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
}

function trim(n: number, digits: number): string {
  return Number(n.toFixed(digits)).toString();
}
