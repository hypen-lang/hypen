/**
 * Uploaded photos: bytes in an R2 bucket (`MEDIA`), metadata in the Durable
 * Object's SQLite.
 *
 * Bytes arrive from the device plane (`gallery.pick` / `camera.capture`)
 * already size- and hash-verified by the broker, but they are still
 * untrusted input (RFC 001 §1.9): the client's declared `contentType` is
 * never believed. `sniffImageType` reads the magic bytes and only real
 * JPEG / PNG / GIF / WebP / AVIF / HEIC files are accepted; the object is
 * written with that sniffed type, and `GET /media/<id>` streams it straight
 * from R2 in the Worker (no Durable Object hop) with `nosniff`.
 */

import { db } from "./db";

/** Largest photo we keep. The DO's device plane retains ≤ 16 MiB per socket. */
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

export const MEDIA_SCHEMA = `
CREATE TABLE IF NOT EXISTS media (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    content_type TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

/** The subset of an R2 bucket binding this file uses. */
export interface MediaBucket {
  put(key: string, value: Uint8Array, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<{ body: ReadableStream; size: number; httpMetadata?: { contentType?: string } } | null>;
  delete(key: string): Promise<void>;
}

// Hypengram runs ONE Durable Object (every connection is routed to it), so
// a module-level binding, set in its constructor, is unambiguous here.
let bucket: MediaBucket | null = null;

export function bindMediaBucket(b: MediaBucket): void {
  bucket = b;
}

function requireBucket(): MediaBucket {
  if (!bucket) throw new Error("MEDIA bucket not bound (see wrangler.jsonc r2_buckets)");
  return bucket;
}

const objectKey = (id: string) => `media/${id}`;

const startsWith = (b: Uint8Array, sig: number[], at = 0) =>
  b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);

const ascii = (b: Uint8Array, from: number, to: number) =>
  String.fromCharCode(...b.subarray(from, Math.min(to, b.length)));

/** The image type the bytes really are, or null when they are not an image we serve. */
export function sniffImageType(b: Uint8Array): string | null {
  if (startsWith(b, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a") return "image/gif";
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return "image/webp";
  if (ascii(b, 4, 8) === "ftyp") {
    const brand = ascii(b, 8, 12);
    if (brand === "avif" || brand === "avis") return "image/avif";
    if (["heic", "heix", "hevc", "heim", "heis", "mif1", "msf1"].includes(brand)) return "image/heic";
  }
  return null;
}

export type StoreResult =
  | { ok: true; id: string; url: string }
  | { ok: false; reason: string };

/** Validate and store one uploaded photo. */
export async function storePhoto(bytes: Uint8Array, ownerId: string): Promise<StoreResult> {
  if (bytes.byteLength === 0) return { ok: false, reason: "That file is empty." };
  if (bytes.byteLength > MAX_PHOTO_BYTES) {
    return { ok: false, reason: `That photo is too large (max ${MAX_PHOTO_BYTES / 1024 / 1024} MB).` };
  }
  const contentType = sniffImageType(bytes);
  if (!contentType) return { ok: false, reason: "That file isn't a photo we can show." };

  const id = `m-${crypto.randomUUID()}`;
  // Object first, row second: a row never points at bytes that aren't there.
  await requireBucket().put(objectKey(id), bytes, { httpMetadata: { contentType } });
  db.query("INSERT INTO media (id, owner_id, content_type, bytes) VALUES (?, ?, ?, ?)").run(
    id,
    ownerId,
    contentType,
    bytes.byteLength
  );
  return { ok: true, id, url: mediaUrl(id) };
}

/** Relative on purpose: an embedding `HypenApp` resolves it against this app's origin. */
export function mediaUrl(id: string): string {
  return `/media/${id}`;
}

/** The media id behind a `/media/<id>` URL, or null for any other URL. */
export function mediaIdFromUrl(url: string | null | undefined): string | null {
  const m = /^\/media\/(m-[0-9a-f-]{36})$/.exec(url ?? "");
  return m ? m[1]! : null;
}

export async function deleteMedia(id: string, ownerId: string): Promise<void> {
  const row = db.query("SELECT owner_id FROM media WHERE id = ?").get<{ owner_id: string }>(id);
  if (!row || row.owner_id !== ownerId) return;
  db.query("DELETE FROM media WHERE id = ?").run(id);
  await requireBucket().delete(objectKey(id));
}

/** `GET /media/<id>` → the stored photo, straight from R2 (ids are never reused). */
export async function serveMedia(request: Request, media: MediaBucket): Promise<Response> {
  const id = mediaIdFromUrl(new URL(request.url).pathname);
  const object = id ? await media.get(objectKey(id)) : null;
  const contentType = object?.httpMetadata?.contentType ?? "";
  // Only what storePhoto wrote: a sniffed image type.
  if (!object || !contentType.startsWith("image/")) return new Response("Not found", { status: 404 });
  return new Response(object.body, {
    headers: {
      "content-type": contentType,
      "content-length": String(object.size),
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
}
