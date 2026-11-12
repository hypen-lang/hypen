/**
 * The viewer's approximate location, from the edge request.
 *
 * Cloudflare stamps every request with `request.cf` (latitude, longitude,
 * city, region, country, timezone — derived from the caller's IP). It lives
 * on the Request, not in anything a Hypen handler can see, so:
 *
 *   1. the worker fetch serialises it into the `x-hypen-geo` header (headers
 *      survive the worker → Durable Object hop; `request.cf` does not
 *      reliably);
 *   2. the DO subclass in worker.ts parses it on the WebSocket upgrade and
 *      keeps it on the DO instance (and in DO storage, so it survives
 *      hibernation);
 *   3. every DO entry point runs inside `geoScope.run(geo, …)`, so
 *      `connectionGeo()` inside `onCreated` returns THIS DO's viewer even
 *      when several DOs share one isolate.
 *
 * The browser `location` device capability would be more precise, but the
 * device plane (RFC 001) has no position capability yet — only
 * `permission.request("location")`, which reports a permission status and
 * no coordinates. See README.md.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface ConnectionGeo {
  latitude: number;
  longitude: number;
  city: string;
  region: string;
  country: string;
  timezone: string;
  /** true when the coordinates came from `request.cf`, false for the fallback. */
  fromEdge: boolean;
}

/** Local dev (no `request.cf` geo) lands in San Francisco. */
export const FALLBACK_GEO: ConnectionGeo = {
  latitude: 37.7749,
  longitude: -122.4194,
  city: "San Francisco",
  region: "California",
  country: "US",
  timezone: "America/Los_Angeles",
  fromEdge: false,
};

export const GEO_HEADER = "x-hypen-geo";

export const geoScope = new AsyncLocalStorage<ConnectionGeo>();

interface CfLike {
  latitude?: string | number;
  longitude?: string | number;
  city?: string;
  region?: string;
  country?: string;
  timezone?: string;
}

export function fromCf(cf: unknown): ConnectionGeo | null {
  const c = cf as CfLike | undefined;
  const lat = Number(c?.latitude);
  const lon = Number(c?.longitude);
  if (!c || c.latitude == null || c.longitude == null) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    latitude: lat,
    longitude: lon,
    city: c.city || "Your location",
    region: c.region || "",
    country: c.country || "",
    timezone: c.timezone || "auto",
    fromEdge: true,
  };
}

/** Header value for the worker → DO hop (null when the request has no geo). */
export function geoHeaderValue(cf: unknown): string | null {
  const geo = fromCf(cf);
  return geo ? JSON.stringify(geo) : null;
}

/** Parse geo from a DO request: header first, then `request.cf`. */
export function geoFromRequest(request: Request): ConnectionGeo | null {
  const header = request.headers.get(GEO_HEADER);
  if (header) {
    try {
      const parsed = JSON.parse(header) as ConnectionGeo;
      if (Number.isFinite(parsed.latitude) && Number.isFinite(parsed.longitude)) {
        return { ...FALLBACK_GEO, ...parsed, fromEdge: true };
      }
    } catch {
      // fall through
    }
  }
  return fromCf((request as Request & { cf?: unknown }).cf);
}

/** The geo of the connection whose handler is running (fallback outside a scope). */
export function connectionGeo(): ConnectionGeo {
  return geoScope.getStore() ?? FALLBACK_GEO;
}
