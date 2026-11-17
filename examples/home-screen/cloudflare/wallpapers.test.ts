import { describe, expect, test } from "bun:test";
import { serveWallpaper, wallpaperKey, type WallpaperBucket } from "./src/wallpapers";

const BYTES = new Uint8Array([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70]);
const KEY = "assets/wallpapers/v1/night-ridge-md.avif";
const ETAG = '"abc123"';

function bucket(): WallpaperBucket & { keys: string[] } {
  const keys: string[] = [];
  return {
    keys,
    async head(key) {
      keys.push(key);
      return key === KEY ? { httpEtag: ETAG, size: BYTES.byteLength } : null;
    },
    async get(key) {
      keys.push(key);
      return key === KEY ? { httpEtag: ETAG, size: BYTES.byteLength, body: new Response(BYTES).body! } : null;
    },
  };
}

const req = (path: string, init?: RequestInit) => new Request(`https://home.example${path}`, init);

describe("wallpaper route", () => {
  test("maps the public URL onto the R2 assets prefix", () => {
    expect(wallpaperKey("/wallpapers/v1/night-ridge-md.avif")).toBe(KEY);
    expect(wallpaperKey("/wallpapers/v2/a_b.c-d.avif")).toBe("assets/wallpapers/v2/a_b.c-d.avif");
  });

  test.each([
    "/wallpapers/v1/night-ridge-md.png",
    "/wallpapers/v1/../drive/x.avif",
    "/wallpapers/../v1/x.avif",
    "/wallpapers/./x.avif",
    "/wallpapers/v1/.hidden.avif",
    "/wallpapers/v1/sub/x.avif",
    "/wallpapers/v1/x%2F..avif",
    "/wallpapers/v1/",
    "/wallpapers/x.avif",
    "/drive/v1/x.avif",
  ])("rejects %s", (path) => {
    expect(wallpaperKey(path)).toBeNull();
  });

  test("GET serves the object with immutable cache, CORS and the AVIF type", async () => {
    const res = await serveWallpaper(req("/wallpapers/v1/night-ridge-md.avif"), bucket());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/avif");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("etag")).toBe(ETAG);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(BYTES);
  });

  test("HEAD returns headers without reading the body", async () => {
    const b = bucket();
    const res = await serveWallpaper(req("/wallpapers/v1/night-ridge-md.avif", { method: "HEAD" }), b);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/avif");
    expect(res.headers.get("etag")).toBe(ETAG);
    expect(res.body).toBeNull();
  });

  test("If-None-Match with the current ETag is a 304", async () => {
    for (const tag of [ETAG, `W/${ETAG}`, `"other", ${ETAG}`, "*"]) {
      const res = await serveWallpaper(req("/wallpapers/v1/night-ridge-md.avif", { headers: { "If-None-Match": tag } }), bucket());
      expect(res.status).toBe(304);
      expect(res.headers.get("etag")).toBe(ETAG);
      expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    }
    const stale = await serveWallpaper(req("/wallpapers/v1/night-ridge-md.avif", { headers: { "If-None-Match": '"old"' } }), bucket());
    expect(stale.status).toBe(200);
  });

  test("unknown files and bad paths are 404 and never touch other prefixes", async () => {
    const b = bucket();
    expect((await serveWallpaper(req("/wallpapers/v1/missing-md.avif"), b)).status).toBe(404);
    expect((await serveWallpaper(req("/wallpapers/v1/../../drive/x.avif"), b)).status).toBe(404);
    expect((await serveWallpaper(req("/wallpapers/v1/x.png"), b)).status).toBe(404);
    expect(b.keys.every((k) => k.startsWith("assets/wallpapers/"))).toBe(true);
  });

  test("other methods are 405", async () => {
    const res = await serveWallpaper(req("/wallpapers/v1/night-ridge-md.avif", { method: "PUT" }), bucket());
    expect(res.status).toBe(405);
  });
});
