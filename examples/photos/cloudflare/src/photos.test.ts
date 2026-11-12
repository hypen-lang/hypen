// `bun test` — the pure parts: EXIF parsing, image sniffing, place and date
// formatting. (The device-plane flows are verified in a browser; see README.)
import { describe, expect, test } from "bun:test";
import { exifDate, readPhotoMeta } from "./exif";
import { formatPlace, placeKey } from "./geocode";
import { cleanAlbumName, sniffImageType, wallClock } from "./library";
import { dayTitle, formatBytes } from "./photos";

/** A minimal big-endian EXIF JPEG: Make/Model, DateTimeOriginal, f-number, GPS. */
function jpegWithExif(opts: { lat: number; lon: number; date: string }): Uint8Array {
  const bytes: number[] = [];
  const u16 = (v: number) => bytes.push((v >> 8) & 0xff, v & 0xff);
  const u32 = (v: number) => bytes.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  const text = (s: string) => [...s].map((c) => c.charCodeAt(0)).concat(0);

  // Layout (offsets within the TIFF block):
  //   0  header | 8 IFD0 (4 entries) | 62 Exif IFD (2) | 92 GPS IFD (4) | 146 data
  const data: number[] = [];
  const DATA = 146;
  const put = (b: number[]) => {
    const at = DATA + data.length;
    data.push(...b);
    return at;
  };
  const rational = (n: number, d: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255, (d >>> 24) & 255, (d >>> 16) & 255, (d >>> 8) & 255, d & 255];
  const dms = (v: number) => {
    const a = Math.abs(v);
    const d = Math.floor(a);
    const m = Math.floor((a - d) * 60);
    const s = Math.round(((a - d) * 60 - m) * 60 * 100);
    return [...rational(d, 1), ...rational(m, 1), ...rational(s, 100)];
  };
  const make = put(text("Apple"));
  const model = put(text("iPhone 15 Pro"));
  const date = put(text(opts.date));
  const fnum = put(rational(178, 100));
  const lat = put(dms(opts.lat));
  const lon = put(dms(opts.lon));

  const entry = (tag: number, type: number, count: number, value: number, inline = false) => {
    u16(tag);
    u16(type);
    u32(count);
    if (inline && type === 2) bytes.push(value, 0, 0, 0);
    else u32(value);
  };
  bytes.push(0x4d, 0x4d); // "MM"
  u16(42);
  u32(8);
  u16(4); // IFD0
  entry(0x010f, 2, 6, make);
  entry(0x0110, 2, 14, model);
  entry(0x8769, 4, 1, 62);
  entry(0x8825, 4, 1, 92);
  u32(0);
  u16(2); // Exif IFD @62
  entry(0x829d, 5, 1, fnum);
  entry(0x9003, 2, 20, date);
  u32(0);
  u16(4); // GPS IFD @92
  entry(0x0001, 2, 2, opts.lat < 0 ? 0x53 : 0x4e, true);
  entry(0x0002, 5, 3, lat);
  entry(0x0003, 2, 2, opts.lon < 0 ? 0x57 : 0x45, true);
  entry(0x0004, 5, 3, lon);
  u32(0);
  expect(bytes.length).toBe(DATA);
  const tiff = [...bytes, ...data];

  const app1 = [..."Exif\0\0"].map((c) => c.charCodeAt(0)).concat(tiff);
  const sof = [0x08, 0x02, 0x58, 0x03, 0x20, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]; // 800×600
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe1, ((app1.length + 2) >> 8) & 255, (app1.length + 2) & 255, ...app1,
    0xff, 0xc0, ((sof.length + 2) >> 8) & 255, (sof.length + 2) & 255, ...sof,
    0xff, 0xd9,
  ]);
}

describe("EXIF", () => {
  test("reads date, camera, aperture, GPS and size", () => {
    const meta = readPhotoMeta(jpegWithExif({ lat: 38.7139, lon: -9.1394, date: "2024:06:14 18:42:10" }));
    expect(meta.takenAt).toBe("2024-06-14T18:42:10");
    expect(meta.make).toBe("Apple");
    expect(meta.model).toBe("iPhone 15 Pro");
    expect(meta.aperture).toBe("f/1.8");
    expect(meta.lat).toBeCloseTo(38.7139, 3);
    expect(meta.lon).toBeCloseTo(-9.1394, 3);
    expect([meta.width, meta.height]).toEqual([800, 600]);
  });

  test("survives truncated and hostile input", () => {
    const full = jpegWithExif({ lat: 1, lon: 1, date: "2024:01:01 00:00:00" });
    for (let n = 0; n < full.length; n += 7) expect(() => readPhotoMeta(full.subarray(0, n))).not.toThrow();
    const garbage = new Uint8Array(4096).map((_, i) => (i * 7919) & 255);
    garbage.set([0xff, 0xd8, 0xff, 0xe1, 0x0f, 0xff, 0x45, 0x78, 0x69, 0x66, 0, 0, 0x4d, 0x4d, 0, 42]);
    expect(() => readPhotoMeta(garbage)).not.toThrow();
  });

  test("rejects impossible dates", () => {
    expect(exifDate("0000:00:00 00:00:00")).toBe("");
    expect(exifDate("2024:13:01 10:00:00")).toBe("");
    expect(exifDate("2024:02:29 23:59:59")).toBe("2024-02-29T23:59:59");
  });
});

describe("serving safety", () => {
  test("sniffs real image types only", () => {
    expect(sniffImageType(jpegWithExif({ lat: 1, lon: 1, date: "2024:01:01 00:00:00" }))).toBe("image/jpeg");
    expect(sniffImageType(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(sniffImageType(new TextEncoder().encode("<!doctype html><script>"))).toBeNull();
  });

  test("album names are cleaned", () => {
    expect(cleanAlbumName("  Trip\u202Egpj.exe \n to\tLisbon ")).toBe("Trip gpj.exe to Lisbon");
    expect(cleanAlbumName("x".repeat(200)).length).toBe(60);
  });
});

describe("formatting", () => {
  test("places", () => {
    expect(formatPlace({ city: "Lisbon", country: "Portugal" })).toBe("Lisbon, Portugal");
    expect(formatPlace({ village: "Sintra", state: "Lisbon", country: "Portugal" })).toBe("Sintra, Portugal");
    expect(placeKey(38.71391, -9.13942)).toBe("38.714,-9.139");
  });

  test("day titles", () => {
    expect(dayTitle("2026-11-12", "2026-11-12")).toBe("Today");
    expect(dayTitle("2026-11-11", "2026-11-12")).toBe("Yesterday");
    expect(dayTitle("2026-11-09", "2026-11-12")).toBe("Monday, Nov 9");
    expect(dayTitle("2026-03-02", "2026-11-12")).toBe("Mar 2");
    expect(dayTitle("2025-03-02", "2026-11-12")).toBe("Mar 2, 2025");
  });

  test("wall clock in a zone, bytes", () => {
    expect(wallClock(Date.UTC(2026, 10, 12, 23, 30, 0), "Asia/Tokyo")).toBe("2026-11-13T08:30:00");
    expect(formatBytes(1536)).toBe("1.5 KB");
  });
});
