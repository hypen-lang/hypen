/**
 * Connection geolocation for the clock/weather widget.
 *
 * Cloudflare stamps every edge request with `request.cf` — latitude,
 * longitude, city, timezone — derived from the caller's IP. That object
 * lives on the Request, not in anything the Hypen module graph can see, so
 * worker.ts captures it on the way in (worker fetch stamps a header; the DO
 * subclass parses header-or-cf in its own isolate) and parks it here in a
 * module-scope slot for launcher.ts to read from `onCreated`.
 *
 * One slot, not per-session: the launcher DO is keyed per session in
 * worker.ts, so by the time a session's module handlers run, the slot holds
 * the geo of that session's own upgrade request.
 */

export interface ConnectionGeo {
  latitude: number;
  longitude: number;
  city: string;
  timezone: string;
}

/** Demo-friendly default for local dev, where `request.cf` has no geo. */
const FALLBACK_GEO: ConnectionGeo = {
  latitude: 37.7749,
  longitude: -122.4194,
  city: "San Francisco",
  timezone: "America/Los_Angeles",
};

export const GEO_HEADER = "x-hypen-geo";

let current: ConnectionGeo = FALLBACK_GEO;

interface CfLike {
  latitude?: string | number;
  longitude?: string | number;
  city?: string;
  timezone?: string;
}

function fromCf(cf: CfLike | undefined): ConnectionGeo | null {
  const lat = Number(cf?.latitude);
  const lon = Number(cf?.longitude);
  if (!cf || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    latitude: lat,
    longitude: lon,
    city: cf.city || "Your area",
    timezone: cf.timezone || FALLBACK_GEO.timezone,
  };
}

/** Serialise `request.cf` geo for the worker → DO hop (returns null when absent). */
export function geoHeaderValue(cf: unknown): string | null {
  const geo = fromCf(cf as CfLike | undefined);
  return geo ? JSON.stringify(geo) : null;
}

/**
 * Capture geo from an incoming DO request: prefer the header stamped by the
 * worker (always survives the hop), fall back to `request.cf` if the runtime
 * forwarded it, else keep the previous/fallback value.
 */
export function captureGeo(request: Request): void {
  const header = request.headers.get(GEO_HEADER);
  if (header) {
    try {
      const parsed = JSON.parse(header) as ConnectionGeo;
      if (Number.isFinite(parsed.latitude) && Number.isFinite(parsed.longitude)) {
        current = parsed;
        return;
      }
    } catch {
      // fall through to cf / previous value
    }
  }
  const cfGeo = fromCf((request as Request & { cf?: CfLike }).cf);
  if (cfGeo) current = cfGeo;
}

export function getGeo(): ConnectionGeo {
  return current;
}

// ---------------------------------------------------------------------------
// Weather (Open-Meteo — keyless, fine for a demo)
// ---------------------------------------------------------------------------

export interface Weather {
  /** Icon slug for the widget: sun | cloud-sun | cloud | rain | snow. */
  icon: string;
  temp: string;
  description: string;
  hiLo: string;
}

/** WMO weather code → icon slug + human label. */
function describe(code: number): { icon: string; label: string } {
  if (code === 0) return { icon: "sun", label: "Clear" };
  if (code === 1 || code === 2) return { icon: "cloud-sun", label: "Partly cloudy" };
  if (code === 3) return { icon: "cloud", label: "Overcast" };
  if (code === 45 || code === 48) return { icon: "cloud", label: "Foggy" };
  if ((code >= 51 && code <= 57) || (code >= 61 && code <= 67) || (code >= 80 && code <= 82))
    return { icon: "rain", label: "Rain" };
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return { icon: "snow", label: "Snow" };
  if (code >= 95) return { icon: "rain", label: "Thunderstorm" };
  return { icon: "cloud-sun", label: "Mild" };
}

export async function fetchWeather(geo: ConnectionGeo): Promise<Weather | null> {
  try {
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", String(geo.latitude));
    url.searchParams.set("longitude", String(geo.longitude));
    url.searchParams.set("current", "temperature_2m,weather_code");
    url.searchParams.set("daily", "temperature_2m_max,temperature_2m_min");
    url.searchParams.set("forecast_days", "1");
    url.searchParams.set("timezone", geo.timezone);
    const response = await fetch(url.toString());
    if (!response.ok) return null;
    const data = (await response.json()) as {
      current?: { temperature_2m?: number; weather_code?: number };
      daily?: { temperature_2m_max?: number[]; temperature_2m_min?: number[] };
    };
    const temp = data.current?.temperature_2m;
    if (typeof temp !== "number") return null;
    const { icon, label } = describe(data.current?.weather_code ?? 1);
    const hi = data.daily?.temperature_2m_max?.[0];
    const lo = data.daily?.temperature_2m_min?.[0];
    return {
      icon,
      temp: `${Math.round(temp)}°`,
      description: label,
      hiLo:
        typeof hi === "number" && typeof lo === "number"
          ? `H ${Math.round(hi)}° · L ${Math.round(lo)}°`
          : "",
    };
  } catch {
    return null;
  }
}
