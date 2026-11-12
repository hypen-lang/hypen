// `/art/<station uuid>` — station artwork, edge-cached.
//
// Radio Browser favicons are submitted by the community: many are plain
// http (blocked as mixed content on an https page), many 404, some are
// HTML error pages. Clients can't fall back on their own (Image has no error
// slot), so the worker resolves the favicon by station id, validates that
// it's a reasonably sized image, and otherwise answers with a generated
// monogram tile. The route only ever fetches the favicon URL Radio Browser
// lists for that station — it is not an open proxy.

import { faviconFor, USER_AGENT } from "./radio-browser";

const TTL_S = 7 * 86400;
const FAIL_TTL_S = 3600;
const MAX_BYTES = 512 * 1024;
const PALETTE = ["#FF5A36", "#F59E0B", "#10B981", "#3B82F6", "#8B5CF6", "#EC4899", "#14B8A6", "#EF4444"];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

export function monogram(id: string, name = ""): string {
  const color = PALETTE[hash(id) % PALETTE.length];
  const letter = (name.trim()[0] ?? "").toUpperCase().replace(/[<&>"']/g, "");
  const glyph = letter
    ? `<text x="64" y="84" text-anchor="middle" font-family="system-ui,-apple-system,Segoe UI,sans-serif" font-size="58" font-weight="700" fill="#fff">${letter}</text>`
    : `<g fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round"><path d="M84 44a28 28 0 0 1 0 40"/><path d="M44 84a28 28 0 0 1 0-40"/><circle cx="64" cy="64" r="8" fill="#fff"/></g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${color}"/><stop offset="1" stop-color="#1F2235"/></linearGradient></defs><rect width="128" height="128" fill="url(#g)"/>${glyph}</svg>`;
}

function fallback(id: string, name: string): Response {
  return new Response(monogram(id, name), {
    headers: { "content-type": "image/svg+xml", "cache-control": `public, max-age=${FAIL_TTL_S}` },
  });
}

export async function serveArt(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const id = url.pathname.slice("/art/".length);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("bad station id", { status: 400 });

  const cache = (caches as unknown as { default: Cache }).default;
  const cacheKey = new Request(`${url.origin}/art/${id}`, { method: "GET" });
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  let favicon = "";
  let name = "";
  try {
    ({ favicon, name } = await faviconFor(id));
  } catch {
    return fallback(id, name);
  }

  let response = fallback(id, name);
  if (/^https?:\/\//i.test(favicon)) {
    try {
      const upstream = await fetch(favicon, {
        headers: { "User-Agent": USER_AGENT, Accept: "image/*" },
        signal: AbortSignal.timeout(6000),
        redirect: "follow",
      });
      const type = upstream.headers.get("content-type") ?? "";
      const length = Number(upstream.headers.get("content-length") ?? 0);
      if (upstream.ok && type.startsWith("image/") && length <= MAX_BYTES) {
        const body = await upstream.arrayBuffer();
        if (body.byteLength > 0 && body.byteLength <= MAX_BYTES) {
          response = new Response(body, {
            headers: {
              "content-type": type,
              "cache-control": `public, max-age=${TTL_S}`,
              // SVG favicons can carry script; neutralise them as a document.
              "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
              "x-content-type-options": "nosniff",
            },
          });
        }
      } else {
        upstream.body?.cancel().catch(() => {});
      }
    } catch {
      // keep the monogram
    }
  }
  await cache.put(cacheKey, response.clone());
  return response;
}
