// `/art/<station uuid>` — station artwork, edge-cached.
//
// Radio Browser favicons are submitted by the community: many are plain
// http (blocked as mixed content on an https page), many 404, some are
// HTML error pages. Clients can't fall back on their own (Image has no error
// slot), so the worker resolves the favicon by station id, validates that
// it's a reasonably sized image, and otherwise answers with a generated
// monogram tile (drawn below). The route only ever fetches the favicon URL Radio Browser
// lists for that station — it is not an open proxy.

import { faviconFor, USER_AGENT } from "./radio-browser";
import { tintFor } from "./tint";

const TTL_S = 7 * 86400;
const FAIL_TTL_S = 3600;
const MAX_BYTES = 512 * 1024;
// ---------------------------------------------------------------------------
// Monogram tile
//
// A station without a usable logo gets a generated one: its initials on a
// dot-matrix tuner display, over the station's own colour (tint.ts) and a set
// of broadcast rings. The letters are drawn as circles, not SVG <text>, so
// the tile looks the same in every renderer (the canvas and desktop
// rasterisers have no fonts for SVG text).
// ---------------------------------------------------------------------------

/** 5x7 dot-matrix glyphs, one string per row, "#" = lit. */
const GLYPHS: Record<string, string[]> = {
  A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  B: ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
  C: [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."],
  D: ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
  E: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
  F: ["#####", "#....", "#....", "####.", "#....", "#....", "#...."],
  G: [".###.", "#...#", "#....", "#.###", "#...#", "#...#", ".###."],
  H: ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  I: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "#####"],
  J: ["..###", "...#.", "...#.", "...#.", "...#.", "#..#.", ".##.."],
  K: ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"],
  L: ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
  M: ["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"],
  N: ["#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#", "#...#"],
  O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  P: ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
  Q: [".###.", "#...#", "#...#", "#...#", "#.#.#", "#..#.", ".##.#"],
  R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  S: [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
  T: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
  U: ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  V: ["#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#.."],
  W: ["#...#", "#...#", "#...#", "#.#.#", "#.#.#", "##.##", "#...#"],
  X: ["#...#", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#"],
  Y: ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."],
  Z: ["#####", "....#", "...#.", "..#..", ".#...", "#....", "#####"],
  "0": [".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."],
  "1": ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
  "2": [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
  "3": ["####.", "....#", "....#", ".###.", "....#", "....#", "####."],
  "4": ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
  "5": ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
  "6": [".###.", "#....", "#....", "####.", "#...#", "#...#", ".###."],
  "7": ["#####", "....#", "...#.", "..#..", "..#..", "..#..", "..#.."],
  "8": [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
  "9": [".###.", "#...#", "#...#", ".####", "....#", "....#", ".###."],
};

/**
 * Up to two display letters: the initials of the first two words, or the
 * first letter of a one-word name. Accents fold to their base letter;
 * scripts the matrix has no glyphs for yield "" (the tile shows rings only).
 */
export function initials(name: string): string {
  const words = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
  return words
    .slice(0, 2)
    .map((w) => w[0])
    .join("");
}

export function monogram(id: string, name = ""): string {
  const { glow, tint } = tintFor(id);
  const letters = initials(name);
  // Broadcast rings from the bottom-right corner (the tiles' play button sits there).
  const rings = [30, 52, 74, 96, 118]
    .map((r, i) => `<circle cx="128" cy="128" r="${r}" fill="none" stroke="#FFF4E0" stroke-opacity="${(0.34 - i * 0.055).toFixed(3)}" stroke-width="2"/>`)
    .join("");
  let display: string;
  if (letters) {
    const cols = letters.length * 5 + (letters.length - 1);
    const cell = letters.length === 1 ? 10 : 8;
    const x0 = 16 + cell / 2;
    const y0 = 16 + cell / 2;
    const dots: string[] = [];
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < cols; col++) {
        const glyph = col % 6 === 5 ? null : GLYPHS[letters[Math.floor(col / 6)]];
        const lit = glyph?.[row][col % 6] === "#";
        dots.push(
          `<circle cx="${x0 + col * cell}" cy="${y0 + row * cell}" r="${(cell * (lit ? 0.42 : 0.16)).toFixed(1)}" fill="#FFF4E0"${lit ? "" : ' fill-opacity="0.22"'}/>`,
        );
      }
    }
    display = dots.join("");
  } else {
    display = `<g fill="none" stroke="#FFF4E0" stroke-width="6" stroke-linecap="round"><path d="M38 60a22 22 0 0 1 0-32"/><path d="M26 72a38 38 0 0 1 0-56"/></g><circle cx="54" cy="44" r="8" fill="#FFF4E0"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${glow}"/><stop offset="1" stop-color="${tint}"/></linearGradient></defs><rect width="128" height="128" fill="url(#g)"/>${rings}${display}</svg>`;
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
  // "v3" = the dot-matrix monogram; bump when the generated tile changes.
  const cacheKey = new Request(`${url.origin}/art/v3/${id}`, { method: "GET" });
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
