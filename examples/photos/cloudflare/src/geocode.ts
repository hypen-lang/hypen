/**
 * Reverse geocoding for photo GPS positions, through OpenStreetMap's
 * Nominatim (https://nominatim.org/release-docs/latest/api/Reverse/).
 *
 * Nominatim's usage policy (https://operations.osmfoundation.org/policies/nominatim/)
 * asks for:
 *
 * - an identifying, descriptive User-Agent — this one names the open-source
 *   example and nothing about the person using it;
 * - at most one request per second — requests from this isolate go through a
 *   single queue spaced ≥ 1.1 s apart;
 * - caching — positions are rounded to ~100 m (3 decimals), looked up in an
 *   isolate-wide memory cache, then in the visitor's own SQLite `geocache`
 *   table, and only then fetched; a failed lookup is not retried until the
 *   photo is opened again;
 * - attribution — the viewer shows "© OpenStreetMap" next to the place.
 *
 * Only the rounded coordinates leave the worker; no image, id or cookie.
 * For heavy production use, run your own Nominatim or a commercial geocoder.
 */

const ENDPOINT = "https://nominatim.openstreetmap.org/reverse";
const USER_AGENT = "HypenPhotosExample/0.1 (open-source Hypen example app; reverse geocoding of photo GPS tags)";
const MIN_SPACING_MS = 1100;
const TIMEOUT_MS = 6000;

/** Cache key: the position rounded to 3 decimals (~110 m). */
export function placeKey(lat: number, lon: number): string {
  return `${lat.toFixed(3)},${lon.toFixed(3)}`;
}

const memory = new Map<string, string>();
const MEMORY_LIMIT = 2000;
let queue: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;

/** Wait for this isolate's turn so requests stay ≥ 1.1 s apart. */
function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = lastRequestAt + MIN_SPACING_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt = Date.now();
    return fn();
  });
  queue = run.catch(() => undefined);
  return run;
}

interface NominatimAddress {
  city?: string;
  town?: string;
  village?: string;
  hamlet?: string;
  municipality?: string;
  suburb?: string;
  county?: string;
  state?: string;
  country?: string;
}

/** "Lisbon, Portugal" from a Nominatim address. */
export function formatPlace(address: NominatimAddress | undefined, displayName?: string): string {
  const a = address ?? {};
  const locality = a.city ?? a.town ?? a.village ?? a.hamlet ?? a.municipality ?? a.suburb ?? a.county ?? a.state;
  const parts = [locality, a.country].filter((p): p is string => typeof p === "string" && p.trim() !== "");
  const text = parts.length ? parts.join(", ") : (displayName ?? "").split(",").slice(0, 2).join(",");
  // eslint-disable-next-line no-control-regex
  return [...text.replace(/[\u0000-\u001f\u007f-\u009f]|\p{Cf}/gu, "").trim()].slice(0, 80).join("");
}

export interface PlaceCache {
  cachedPlace(key: string): string | null;
  cachePlace(key: string, place: string): void;
}

/**
 * The place name for a position, or "" when it cannot be found right now.
 * `cache` is the visitor's own SQLite cache.
 */
export async function reverseGeocode(lat: number, lon: number, cache: PlaceCache): Promise<string> {
  const key = placeKey(lat, lon);
  const remembered = memory.get(key) ?? cache.cachedPlace(key);
  if (remembered !== null && remembered !== undefined) return remembered;

  const place = await throttled(async () => {
    const url = `${ENDPOINT}?format=jsonv2&zoom=10&addressdetails=1&accept-language=en&lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { address?: NominatimAddress; display_name?: string; error?: string };
      if (body.error) return ""; // e.g. open ocean: a definite "no place".
      return formatPlace(body.address, body.display_name);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  });

  if (place === null) return ""; // transient failure: don't cache
  if (memory.size >= MEMORY_LIMIT) memory.delete(memory.keys().next().value as string);
  memory.set(key, place);
  cache.cachePlace(key, place);
  return place;
}
