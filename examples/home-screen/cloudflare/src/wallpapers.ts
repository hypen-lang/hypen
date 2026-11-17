/**
 * `GET|HEAD /wallpapers/<version>/<file>.avif` — the launcher's wallpaper
 * renditions, served by the Worker from the `FILES` R2 bucket.
 *
 * Why not Workers Static Assets: any `assets` config puts Cloudflare's asset
 * router in front of the Worker, and that router terminates the `/ws`
 * WebSocket itself and negotiates permessage-deflate (with context takeover)
 * whatever `no_web_socket_compression` says. Hypen clients then keep the
 * connection UI-only — no device plane, so the Files app can't upload or
 * download. So the renditions live in R2 under `assets/wallpapers/`, a prefix
 * that can't collide with visitors' drive data (`drive/<DO id>/`), and are
 * uploaded with `bun run wallpapers:upload` (see scripts/upload-wallpapers.ts).
 *
 * No `caches.default`: the Cache API is a no-op on `*.workers.dev`, and the
 * URLs are versioned and served `immutable`, so browsers fetch each one once.
 */

/** R2 key prefix for the renditions: `assets/wallpapers/<version>/<file>`. */
export const WALLPAPER_R2_PREFIX = "assets/wallpapers/";

const SEGMENT = "[A-Za-z0-9_-][A-Za-z0-9._-]*";
const WALLPAPER_PATH = new RegExp(`^/wallpapers/(${SEGMENT})/(${SEGMENT}\\.avif)$`);

/** The headers `public/_headers` used to set, plus the type R2 doesn't guarantee. */
export const WALLPAPER_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "image/avif",
  "Cache-Control": "public, max-age=31536000, immutable",
  "Access-Control-Allow-Origin": "*",
};

/** The minimal slice of an R2 bucket this route uses. */
export interface WallpaperBucket {
  head(key: string): Promise<{ httpEtag: string; size: number } | null>;
  get(key: string): Promise<{ httpEtag: string; size: number; body: ReadableStream } | null>;
}

/** `/wallpapers/v1/night-ridge-md.avif` → `assets/wallpapers/v1/night-ridge-md.avif`; null for anything else. */
export function wallpaperKey(pathname: string): string | null {
  const match = WALLPAPER_PATH.exec(pathname);
  return match ? `${WALLPAPER_R2_PREFIX}${match[1]}/${match[2]}` : null;
}

/** True when the request is for the wallpaper route (whatever the outcome). */
export function isWallpaperRequest(request: Request): boolean {
  return new URL(request.url).pathname.startsWith("/wallpapers/");
}

function notFound(): Response {
  return new Response("Not found", { status: 404, headers: { "Access-Control-Allow-Origin": "*" } });
}

function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  const bare = (tag: string) => tag.trim().replace(/^W\//, "");
  return header.split(",").some((tag) => tag.trim() === "*" || bare(tag) === bare(etag));
}

export async function serveWallpaper(request: Request, bucket: WallpaperBucket): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  const key = wallpaperKey(new URL(request.url).pathname);
  if (!key) return notFound();

  const ifNoneMatch = request.headers.get("If-None-Match");
  // HEAD and conditional GETs only need the metadata.
  const meta = request.method === "HEAD" || ifNoneMatch ? await bucket.head(key) : null;
  if ((request.method === "HEAD" || ifNoneMatch) && !meta) return notFound();

  if (meta && etagMatches(ifNoneMatch, meta.httpEtag)) {
    const headers = new Headers(WALLPAPER_HEADERS);
    headers.delete("Content-Type");
    headers.set("ETag", meta.httpEtag);
    return new Response(null, { status: 304, headers });
  }

  const headers = new Headers(WALLPAPER_HEADERS);
  if (request.method === "HEAD") {
    headers.set("ETag", meta!.httpEtag);
    headers.set("Content-Length", String(meta!.size));
    return new Response(null, { status: 200, headers });
  }

  const object = await bucket.get(key);
  if (!object) return notFound();
  headers.set("ETag", object.httpEtag);
  return new Response(object.body, { status: 200, headers });
}
