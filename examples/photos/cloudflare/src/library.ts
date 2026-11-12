/**
 * The photo library's storage: metadata in the visitor's Durable Object
 * SQLite, bytes in the `PHOTOS` R2 bucket.
 *
 * Every visitor gets their own Durable Object (the worker routes on the
 * `hypen_photos` cookie, see worker.ts), so "whose photos are these" is
 * simply "which DO is this". Handlers never keep that in a module-level
 * global: several DOs can share one isolate and interleave across `await`s
 * (a camera capture waits on the user for as long as they like), so a
 * rebind-per-message global could file one visitor's photo under another.
 * The DO runs every entry point inside `libraryScope.run(scope, …)` and the
 * handlers read it through `AsyncLocalStorage`, which follows their own
 * async continuations. (Same pattern as home-screen's Files app, drive.ts.)
 *
 * R2 keys are `photos/<durable object id>/<photo id>`. Only this DO's rows
 * can name an object, so a visitor can reach nothing but their own photos.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { readPhotoMeta, type PhotoMeta } from "./exif";

interface SqlCursor {
  toArray(): Record<string, unknown>[];
}
export interface LibraryStorage {
  sql: { exec(query: string, ...bindings: unknown[]): SqlCursor };
  transactionSync<T>(fn: () => T): T;
}

/** The subset of an R2 bucket binding the library uses. */
export interface PhotoBucket {
  put(key: string, value: Uint8Array, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; size: number } | null>;
  delete(keys: string | string[]): Promise<void>;
}

/** Everything one visitor's library needs. */
export interface LibraryScope {
  storage: LibraryStorage;
  bucket: PhotoBucket;
  /** `photos/<durable object id>/` */
  prefix: string;
  /** The visitor's IANA time zone (from `request.cf`), for "Today" and upload times. */
  timeZone: string;
}

export const libraryScope = new AsyncLocalStorage<LibraryScope>();

/** Largest single photo (the device plane retains ≤ 16 MiB per transfer batch). */
export const MAX_PHOTO_BYTES = 16 * 1024 * 1024;
/** Per-visitor quota. */
export const MAX_LIBRARY_BYTES = 500 * 1024 * 1024;
const MAX_ALBUM_NAME = 60;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS photos (
    id TEXT PRIMARY KEY,
    content_type TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    source TEXT NOT NULL,
    original_name TEXT NOT NULL DEFAULT '',
    taken_at TEXT NOT NULL,
    taken_from_exif INTEGER NOT NULL DEFAULT 0,
    added_at INTEGER NOT NULL,
    width INTEGER NOT NULL DEFAULT 0,
    height INTEGER NOT NULL DEFAULT 0,
    make TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    lens TEXT NOT NULL DEFAULT '',
    aperture TEXT NOT NULL DEFAULT '',
    exposure TEXT NOT NULL DEFAULT '',
    iso INTEGER NOT NULL DEFAULT 0,
    focal_length TEXT NOT NULL DEFAULT '',
    lat REAL,
    lon REAL,
    altitude REAL,
    place TEXT NOT NULL DEFAULT '',
    favorite INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_photos_taken ON photos(taken_at DESC);
CREATE TABLE IF NOT EXISTS albums (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS album_photos (
    album_id TEXT NOT NULL,
    photo_id TEXT NOT NULL,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (album_id, photo_id)
);
CREATE INDEX IF NOT EXISTS idx_album_photos_photo ON album_photos(photo_id);
CREATE TABLE IF NOT EXISTS geocache (
    key TEXT PRIMARY KEY,
    place TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
);
`;

const ready = new WeakSet<object>();

/** The library of the Durable Object this code runs for. Throws outside a scope. */
export function currentLibrary(): Library {
  const scope = libraryScope.getStore();
  if (!scope) throw new Error("photo library used outside a Durable Object scope");
  if (!ready.has(scope.storage)) {
    scope.storage.sql.exec(SCHEMA);
    ready.add(scope.storage);
  }
  return new Library(scope);
}

export type PhotoSource = "camera" | "gallery" | "file";

export interface Photo {
  id: string;
  contentType: string;
  bytes: number;
  source: PhotoSource;
  originalName: string;
  /** Local wall-clock "YYYY-MM-DDTHH:MM:SS" (EXIF, else upload time in the visitor's zone). */
  takenAt: string;
  takenFromExif: boolean;
  addedAt: number;
  width: number;
  height: number;
  make: string;
  model: string;
  lens: string;
  aperture: string;
  exposure: string;
  iso: number;
  focalLength: string;
  lat: number | null;
  lon: number | null;
  altitude: number | null;
  place: string;
  favorite: boolean;
}

export interface Album {
  id: string;
  name: string;
  count: number;
  /** The most recently added photo, "" for an empty album. */
  coverId: string;
}

function num(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

function rowToPhoto(r: Record<string, unknown>): Photo {
  const source = r.source === "camera" || r.source === "gallery" ? r.source : "file";
  return {
    id: String(r.id),
    contentType: String(r.content_type ?? ""),
    bytes: Number(r.bytes ?? 0),
    source,
    originalName: String(r.original_name ?? ""),
    takenAt: String(r.taken_at ?? ""),
    takenFromExif: Number(r.taken_from_exif ?? 0) === 1,
    addedAt: Number(r.added_at ?? 0),
    width: Number(r.width ?? 0),
    height: Number(r.height ?? 0),
    make: String(r.make ?? ""),
    model: String(r.model ?? ""),
    lens: String(r.lens ?? ""),
    aperture: String(r.aperture ?? ""),
    exposure: String(r.exposure ?? ""),
    iso: Number(r.iso ?? 0),
    focalLength: String(r.focal_length ?? ""),
    lat: num(r.lat),
    lon: num(r.lon),
    altitude: num(r.altitude),
    place: String(r.place ?? ""),
    favorite: Number(r.favorite ?? 0) === 1,
  };
}

/** `ms` as a "YYYY-MM-DDTHH:MM:SS" wall-clock time in `timeZone`. */
export function wallClock(ms: number, timeZone: string): string {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(0, 19);
  }
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
}

/** An album name safe to store and show: no control/bidi characters, bounded. */
export function cleanAlbumName(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]|\p{Cf}/gu, " ").replace(/\s+/g, " ").trim();
  return [...cleaned].slice(0, MAX_ALBUM_NAME).join("");
}

/** "image/jpeg" etc. — what the bytes really are (never the uploader's claim), or null. */
export function sniffImageType(b: Uint8Array): string | null {
  const starts = (sig: number[]) => sig.every((v, i) => b[i] === v);
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, Math.min(to, b.length)));
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (ascii(4, 8) === "ftyp" && ["avif", "avis"].includes(ascii(8, 12))) return "image/avif";
  return null;
}

/** HEIC/HEIF: kept (and downloadable) but browsers cannot show it. */
export function isHeic(b: Uint8Array): boolean {
  const brand = String.fromCharCode(...b.subarray(8, 12));
  return String.fromCharCode(...b.subarray(4, 8)) === "ftyp" && ["heic", "heix", "hevc", "heim", "heis", "mif1", "msf1"].includes(brand);
}

export class Library {
  private readonly storage: LibraryStorage;
  private readonly bucket: PhotoBucket;
  private readonly prefix: string;
  readonly timeZone: string;

  constructor(scope: LibraryScope) {
    this.storage = scope.storage;
    this.bucket = scope.bucket;
    this.prefix = scope.prefix;
    this.timeZone = scope.timeZone;
  }

  private key(photoId: string): string {
    return `${this.prefix}${photoId}`;
  }

  private all(query: string, ...args: unknown[]): Record<string, unknown>[] {
    return this.storage.sql.exec(query, ...args).toArray();
  }

  /** Thumbnail/viewer URL: `/p/<DO id>/<photo id>` (relative; HypenApp resolves it against this worker). */
  url(photoId: string): string {
    return `/p/${this.prefix.slice("photos/".length)}${photoId}`;
  }

  get(id: string): Photo | null {
    const row = this.all("SELECT * FROM photos WHERE id = ?", id)[0];
    return row ? rowToPhoto(row) : null;
  }

  /** Every photo, newest first. */
  list(): Photo[] {
    return this.all("SELECT * FROM photos ORDER BY taken_at DESC, added_at DESC").map(rowToPhoto);
  }

  favorites(): Photo[] {
    return this.all("SELECT * FROM photos WHERE favorite = 1 ORDER BY taken_at DESC, added_at DESC").map(rowToPhoto);
  }

  inAlbum(albumId: string): Photo[] {
    return this.all(
      `SELECT p.* FROM photos p JOIN album_photos a ON a.photo_id = p.id
        WHERE a.album_id = ? ORDER BY p.taken_at DESC, p.added_at DESC`,
      albumId,
    ).map(rowToPhoto);
  }

  usedBytes(): number {
    return Number(this.all("SELECT COALESCE(SUM(bytes), 0) AS total FROM photos")[0]?.total ?? 0);
  }

  count(): number {
    return Number(this.all("SELECT COUNT(*) AS n FROM photos")[0]?.n ?? 0);
  }

  /**
   * Store one photo. The caller has checked size and quota. Returns null
   * when the bytes are not an image we know.
   */
  async add(bytes: Uint8Array, source: PhotoSource, originalName: string): Promise<Photo | null> {
    const type = sniffImageType(bytes) ?? (isHeic(bytes) ? "image/heic" : null);
    if (!type) return null;
    const meta: PhotoMeta = readPhotoMeta(bytes);
    const id = crypto.randomUUID();
    const now = Date.now();
    // Object first, row second: a row never names bytes that aren't there.
    await this.bucket.put(this.key(id), bytes, { httpMetadata: { contentType: type } });
    this.storage.sql.exec(
      `INSERT INTO photos (id, content_type, bytes, source, original_name, taken_at, taken_from_exif, added_at,
         width, height, make, model, lens, aperture, exposure, iso, focal_length, lat, lon, altitude)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      type,
      bytes.byteLength,
      source,
      originalName,
      meta.takenAt || wallClock(now, this.timeZone),
      meta.takenAt ? 1 : 0,
      now,
      meta.width,
      meta.height,
      meta.make,
      meta.model,
      meta.lens,
      meta.aperture,
      meta.exposure,
      meta.iso,
      meta.focalLength,
      meta.lat,
      meta.lon,
      meta.altitude,
    );
    return this.get(id);
  }

  async read(id: string): Promise<{ photo: Photo; bytes: Uint8Array } | null> {
    const photo = this.get(id);
    if (!photo) return null;
    const object = await this.bucket.get(this.key(id));
    if (!object) return null;
    const bytes = new Uint8Array(await object.arrayBuffer());
    return bytes.byteLength === photo.bytes ? { photo, bytes } : null;
  }

  setFavorite(id: string, favorite: boolean): boolean {
    if (!this.get(id)) return false;
    this.storage.sql.exec("UPDATE photos SET favorite = ? WHERE id = ?", favorite ? 1 : 0, id);
    return true;
  }

  setPlace(id: string, place: string): void {
    this.storage.sql.exec("UPDATE photos SET place = ? WHERE id = ?", place, id);
  }

  /** Photos with a GPS position but no place name yet. */
  needingPlace(): Photo[] {
    return this.all("SELECT * FROM photos WHERE lat IS NOT NULL AND place = '' ORDER BY added_at DESC LIMIT 32").map(
      rowToPhoto,
    );
  }

  async remove(id: string): Promise<boolean> {
    if (!this.get(id)) return false;
    this.storage.transactionSync(() => {
      this.storage.sql.exec("DELETE FROM album_photos WHERE photo_id = ?", id);
      this.storage.sql.exec("DELETE FROM photos WHERE id = ?", id);
    });
    await this.bucket.delete(this.key(id));
    return true;
  }

  // ----- Albums -----

  albums(): Album[] {
    return this.all(
      `SELECT a.id, a.name,
              (SELECT COUNT(*) FROM album_photos x WHERE x.album_id = a.id) AS n,
              COALESCE((SELECT x.photo_id FROM album_photos x JOIN photos p ON p.id = x.photo_id
                         WHERE x.album_id = a.id ORDER BY x.added_at DESC LIMIT 1), '') AS cover
         FROM albums a ORDER BY a.created_at`,
    ).map((r) => ({ id: String(r.id), name: String(r.name), count: Number(r.n ?? 0), coverId: String(r.cover ?? "") }));
  }

  album(id: string): Album | null {
    return this.albums().find((a) => a.id === id) ?? null;
  }

  /** The album with this name (case-insensitive), if any. */
  albumNamed(rawName: string): Album | null {
    const name = cleanAlbumName(rawName).toLowerCase();
    return name ? (this.albums().find((a) => a.name.toLowerCase() === name) ?? null) : null;
  }

  createAlbum(rawName: string): Album | null {
    const name = cleanAlbumName(rawName);
    if (!name) return null;
    const id = `a-${crypto.randomUUID()}`;
    this.storage.sql.exec("INSERT INTO albums (id, name, created_at) VALUES (?, ?, ?)", id, name, Date.now());
    return this.album(id);
  }

  renameAlbum(id: string, rawName: string): boolean {
    const name = cleanAlbumName(rawName);
    if (!name || !this.album(id)) return false;
    this.storage.sql.exec("UPDATE albums SET name = ? WHERE id = ?", name, id);
    return true;
  }

  deleteAlbum(id: string): void {
    this.storage.transactionSync(() => {
      this.storage.sql.exec("DELETE FROM album_photos WHERE album_id = ?", id);
      this.storage.sql.exec("DELETE FROM albums WHERE id = ?", id);
    });
  }

  /** Add a photo to an album. Returns false if either is missing or it was already there. */
  addToAlbum(albumId: string, photoId: string): boolean {
    if (!this.album(albumId) || !this.get(photoId)) return false;
    const before = this.all("SELECT 1 FROM album_photos WHERE album_id = ? AND photo_id = ?", albumId, photoId).length;
    if (before) return false;
    this.storage.sql.exec(
      "INSERT INTO album_photos (album_id, photo_id, added_at) VALUES (?, ?, ?)",
      albumId,
      photoId,
      Date.now(),
    );
    return true;
  }

  removeFromAlbum(albumId: string, photoId: string): void {
    this.storage.sql.exec("DELETE FROM album_photos WHERE album_id = ? AND photo_id = ?", albumId, photoId);
  }

  albumIdsOf(photoId: string): Set<string> {
    return new Set(this.all("SELECT album_id FROM album_photos WHERE photo_id = ?", photoId).map((r) => String(r.album_id)));
  }

  // ----- Reverse-geocoding cache (per visitor; see geocode.ts) -----

  cachedPlace(key: string): string | null {
    const row = this.all("SELECT place FROM geocache WHERE key = ?", key)[0];
    return row ? String(row.place) : null;
  }

  cachePlace(key: string, place: string): void {
    this.storage.sql.exec(
      "INSERT OR REPLACE INTO geocache (key, place, fetched_at) VALUES (?, ?, ?)",
      key,
      place,
      Date.now(),
    );
  }
}

// ---------------------------------------------------------------------------
// Serving images
// ---------------------------------------------------------------------------

/** `/p/<64-hex DO id>/<uuid>` */
export const PHOTO_PATH = /^\/p\/([0-9a-f]{64})\/([0-9a-f-]{36})$/;

/**
 * `GET /p/<DO id>/<photo id>` → the photo's bytes. Only sniffed raster image
 * types are served (`nosniff`, sandboxed CSP): an upload that is really HTML
 * or SVG never renders as a page on this origin, and HEIC (which browsers
 * cannot show) 404s here — it is still downloadable through `file.save`.
 */
export async function servePhoto(scope: LibraryScope, request: Request): Promise<Response> {
  const id = PHOTO_PATH.exec(new URL(request.url).pathname)?.[2];
  const file = id ? await libraryScope.run(scope, () => currentLibrary().read(id)) : null;
  const type = file ? sniffImageType(file.bytes) : null;
  if (!file || !type) return new Response("Not found", { status: 404 });
  return new Response(file.bytes, {
    headers: {
      "content-type": type,
      "content-length": String(file.bytes.byteLength),
      // The id is random and the bytes never change for it.
      "cache-control": "private, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      // Embedded in the launcher on another origin: let it load the image.
      "cross-origin-resource-policy": "cross-origin",
    },
  });
}
