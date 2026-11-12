/**
 * Open-Meteo client (https://open-meteo.com — keyless, CC BY 4.0).
 *
 *   forecast     api.open-meteo.com/v1/forecast              current + hourly + daily
 *   air quality  air-quality-api.open-meteo.com/v1/air-quality  current US AQI
 *   geocoding    geocoding-api.open-meteo.com/v1/search      city autocomplete
 *   ensemble     ensemble-api.open-meteo.com/v1/ensemble      fallback when the
 *                forecast API rate-limits us (see `ensembleToForecast`)
 *
 * Everything goes through `cached()`: an in-isolate TTL cache with in-flight
 * de-duplication, so every session in a Durable Object (and every DO in the
 * isolate) looking at the same ~1 km grid cell shares one upstream request.
 * Upstream fetches also carry `cf.cacheTtl`, so a deployed Worker gets the
 * edge cache on top. Transient failures (429 / 5xx / network) retry with
 * exponential backoff, honouring `Retry-After`. Open-Meteo's free tier is
 * rate-limited per IP; a *daily* 429 is not worth retrying, so the forecast
 * API is benched for a while and the ensemble API stands in for it.
 */

// ---------------------------------------------------------------------------
// Normalised forecast
// ---------------------------------------------------------------------------

export interface Forecast {
  /** Which Open-Meteo API produced this forecast. */
  source: "forecast" | "ensemble";
  fetchedAt: number;
  timezone: string;
  utcOffsetSeconds: number;
  current: {
    /** Local ISO time ("2026-11-12T09:15"). */
    time: string;
    temperature: number;
    apparent: number;
    humidity: number | null;
    isDay: boolean;
    code: number;
    windSpeed: number;
    windDirection: number | null;
    precipitation: number;
  };
  hourly: {
    time: string[];
    temperature: number[];
    /** Precipitation probability, % (null when the model has none). */
    pop: (number | null)[];
    code: number[];
    windSpeed: number[];
    isDay: number[];
  };
  daily: {
    date: string[];
    code: number[];
    max: number[];
    min: number[];
    sunrise: string[];
    sunset: string[];
    uv: (number | null)[];
    pop: (number | null)[];
  };
}

export interface CityResult {
  id: string;
  name: string;
  region: string;
  country: string;
  countryCode: string;
  latitude: number;
  longitude: number;
  timezone: string;
  population: number;
}

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly daily = false,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Fetch with retry + cache
// ---------------------------------------------------------------------------

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

let fetcher: Fetcher = (url, init) => fetch(url, init);

/** Tests swap the network for recorded responses. */
export function setFetcher(next: Fetcher | null): void {
  fetcher = next ?? ((url, init) => fetch(url, init));
  cache.clear();
  forecastBenchedUntil = 0;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function fetchJson<T>(
  url: string,
  { attempts = 3, cacheTtl = 300, timeoutMs = 9_000 } = {},
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetcher(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
        // Edge cache on a deployed Worker; ignored elsewhere.
        cf: { cacheTtl, cacheEverything: true },
      } as RequestInit);
      if (response.ok) return (await response.json()) as T;

      let reason = `HTTP ${response.status}`;
      try {
        const body = (await response.json()) as { reason?: string };
        if (body?.reason) reason = body.reason;
      } catch {
        // non-JSON error body
      }
      const daily = response.status === 429 && /daily|tomorrow/i.test(reason);
      const error = new UpstreamError(reason, response.status, daily);
      // 4xx other than 429 and daily quotas will not get better by retrying.
      if (daily || (response.status < 500 && response.status !== 429)) throw error;
      lastError = error;
      const retryAfter = Number(response.headers.get("retry-after"));
      await sleep(
        Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 5_000)
          : 400 * 2 ** attempt + Math.random() * 200,
      );
    } catch (error) {
      if (error instanceof UpstreamError && (error.daily || (error.status < 500 && error.status !== 429))) {
        throw error;
      }
      lastError = error;
      if (attempt < attempts - 1) await sleep(400 * 2 ** attempt + Math.random() * 200);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

interface CacheEntry {
  at: number;
  ttl: number;
  value?: unknown;
  pending?: Promise<unknown>;
}

const cache = new Map<string, CacheEntry>();
const MAX_CACHE_ENTRIES = 200;

/**
 * TTL cache with in-flight de-duplication. A failed refresh keeps serving
 * the last good value (stale-if-error) for up to `staleMs`.
 */
export async function cached<T>(
  key: string,
  ttlMs: number,
  load: () => Promise<T>,
  staleMs = 6 * 60 * 60_000,
): Promise<T> {
  const now = Date.now();
  const entry = cache.get(key);
  if (entry?.value !== undefined && now - entry.at < entry.ttl) return entry.value as T;
  if (entry?.pending) return entry.pending as Promise<T>;

  const pending = load().then(
    (value) => {
      cache.set(key, { at: Date.now(), ttl: ttlMs, value });
      return value;
    },
    (error) => {
      const stale = cache.get(key);
      if (stale?.value !== undefined && Date.now() - stale.at < staleMs) {
        cache.set(key, { ...stale, pending: undefined });
        return stale.value as T;
      }
      cache.delete(key);
      throw error;
    },
  );
  cache.set(key, { ...(entry ?? { at: 0, ttl: ttlMs }), pending });
  if (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined && oldest !== key) cache.delete(oldest);
  }
  return pending;
}

/** Age (ms) of a cached value, or null when absent. */
export function cacheAge(key: string): number | null {
  const entry = cache.get(key);
  return entry?.value !== undefined ? Date.now() - entry.at : null;
}

/** ~1 km grid: nearby viewers share cache entries. */
export const gridKey = (lat: number, lon: number) => `${lat.toFixed(2)},${lon.toFixed(2)}`;

export const FORECAST_TTL_MS = 10 * 60_000;
const AIR_TTL_MS = 30 * 60_000;
const SEARCH_TTL_MS = 24 * 60 * 60_000;

// ---------------------------------------------------------------------------
// Forecast
// ---------------------------------------------------------------------------

export function forecastUrl(lat: number, lon: number): string {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", lat.toFixed(4));
  url.searchParams.set("longitude", lon.toFixed(4));
  url.searchParams.set(
    "current",
    "temperature_2m,apparent_temperature,relative_humidity_2m,is_day,weather_code,wind_speed_10m,wind_direction_10m,precipitation",
  );
  url.searchParams.set("hourly", "temperature_2m,precipitation_probability,weather_code,wind_speed_10m,is_day");
  url.searchParams.set(
    "daily",
    "weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,uv_index_max,precipitation_probability_max",
  );
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("forecast_days", "8");
  return url.toString();
}

export function ensembleUrl(lat: number, lon: number): string {
  const url = new URL("https://ensemble-api.open-meteo.com/v1/ensemble");
  url.searchParams.set("latitude", lat.toFixed(4));
  url.searchParams.set("longitude", lon.toFixed(4));
  url.searchParams.set(
    "hourly",
    "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_direction_10m,is_day",
  );
  url.searchParams.set("models", "icon_seamless");
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("forecast_days", "8");
  return url.toString();
}

interface RawForecast {
  timezone: string;
  utc_offset_seconds: number;
  current: Record<string, number | string>;
  hourly: Record<string, (number | null)[] | string[]>;
  daily: Record<string, (number | null)[] | string[]>;
}

const nums = (v: unknown): number[] => (Array.isArray(v) ? v.map((x) => (typeof x === "number" ? x : NaN)) : []);
const maybeNums = (v: unknown, n: number): (number | null)[] =>
  Array.isArray(v) ? v.map((x) => (typeof x === "number" ? x : null)) : new Array(n).fill(null);

export function normaliseForecast(raw: RawForecast, fetchedAt = Date.now()): Forecast {
  const c = raw.current;
  const h = raw.hourly;
  const d = raw.daily;
  const hourTimes = (h.time ?? []) as string[];
  const dayDates = (d.time ?? []) as string[];
  return {
    source: "forecast",
    fetchedAt,
    timezone: raw.timezone,
    utcOffsetSeconds: raw.utc_offset_seconds,
    current: {
      time: String(c.time),
      temperature: Number(c.temperature_2m),
      apparent: Number(c.apparent_temperature),
      humidity: typeof c.relative_humidity_2m === "number" ? c.relative_humidity_2m : null,
      isDay: Number(c.is_day) === 1,
      code: Number(c.weather_code),
      windSpeed: Number(c.wind_speed_10m),
      windDirection: typeof c.wind_direction_10m === "number" ? c.wind_direction_10m : null,
      precipitation: Number(c.precipitation ?? 0),
    },
    hourly: {
      time: hourTimes,
      temperature: nums(h.temperature_2m),
      pop: maybeNums(h.precipitation_probability, hourTimes.length),
      code: nums(h.weather_code),
      windSpeed: nums(h.wind_speed_10m),
      isDay: nums(h.is_day),
    },
    daily: {
      date: dayDates,
      code: nums(d.weather_code),
      max: nums(d.temperature_2m_max),
      min: nums(d.temperature_2m_min),
      sunrise: (d.sunrise ?? []) as string[],
      sunset: (d.sunset ?? []) as string[],
      uv: maybeNums(d.uv_index_max, dayDates.length),
      pop: maybeNums(d.precipitation_probability_max, dayDates.length),
    },
  };
}

/** Local wall-clock ISO minute ("2026-11-12T09:15") for a UTC offset. */
export function localIso(ms: number, utcOffsetSeconds: number): string {
  return new Date(ms + utcOffsetSeconds * 1000).toISOString().slice(0, 16);
}

/**
 * Sunrise / sunset (local ISO minutes) from the sunrise equation —
 * https://en.wikipedia.org/wiki/Sunrise_equation. Accurate to a minute or
 * two; only used on the ensemble fallback, which has no daily sun times.
 */
export function sunTimes(
  date: string,
  lat: number,
  lon: number,
  utcOffsetSeconds: number,
): { sunrise: string; sunset: string } | null {
  const rad = Math.PI / 180;
  const midnightUtc = Date.parse(`${date}T00:00:00Z`);
  const jd = midnightUtc / 86_400_000 + 2440587.5;
  const n = Math.ceil(jd - 2451545.0 + 0.0008);
  const jStar = n - lon / 360;
  const m = (357.5291 + 0.98560028 * jStar) % 360;
  const cEq = 1.9148 * Math.sin(m * rad) + 0.02 * Math.sin(2 * m * rad) + 0.0003 * Math.sin(3 * m * rad);
  const lambda = (m + cEq + 180 + 102.9372) % 360;
  const jTransit = 2451545.0 + jStar + 0.0053 * Math.sin(m * rad) - 0.0069 * Math.sin(2 * lambda * rad);
  const sinDecl = Math.sin(lambda * rad) * Math.sin(23.4397 * rad);
  const cosDecl = Math.cos(Math.asin(sinDecl));
  const cosOmega = (Math.sin(-0.833 * rad) - Math.sin(lat * rad) * sinDecl) / (Math.cos(lat * rad) * cosDecl);
  if (cosOmega < -1 || cosOmega > 1) return null; // polar day / night
  const omega = Math.acos(cosOmega) / rad;
  const toMs = (j: number) => (j - 2440587.5) * 86_400_000;
  return {
    sunrise: localIso(toMs(jTransit - omega / 360), utcOffsetSeconds),
    sunset: localIso(toMs(jTransit + omega / 360), utcOffsetSeconds),
  };
}

/**
 * Turn an ensemble response (control run + members, hourly only) into the
 * same `Forecast` shape. Precipitation probability is the share of ensemble
 * members with ≥ 0.1 mm in the hour — the same definition the forecast API
 * uses. Daily values are aggregated from the hours; sun times are computed.
 */
export function ensembleToForecast(
  raw: { timezone: string; utc_offset_seconds: number; hourly: Record<string, (number | null)[] | string[]> },
  lat: number,
  lon: number,
  now = Date.now(),
): Forecast {
  const h = raw.hourly;
  const time = (h.time ?? []) as string[];
  const memberKeys = Object.keys(h).filter((k) => k.startsWith("precipitation_member"));
  const precipSeries = [h.precipitation, ...memberKeys.map((k) => h[k])].map((s) => nums(s));
  const pop = time.map((_, i) => {
    const valid = precipSeries.map((s) => s[i]).filter((v): v is number => Number.isFinite(v));
    if (valid.length === 0) return null;
    return Math.round((100 * valid.filter((v) => v >= 0.1).length) / valid.length);
  });
  const temperature = nums(h.temperature_2m);
  const code = nums(h.weather_code).map((c) => (Number.isFinite(c) ? c : 0));
  const windSpeed = nums(h.wind_speed_10m);
  const isDay = nums(h.is_day);

  const nowLocal = localIso(now, raw.utc_offset_seconds);
  const hourIndex = Math.max(0, time.findIndex((t) => t > nowLocal) - 1);

  const dates = [...new Set(time.map((t) => t.slice(0, 10)))];
  const daily: Forecast["daily"] = { date: [], code: [], max: [], min: [], sunrise: [], sunset: [], uv: [], pop: [] };
  for (const date of dates) {
    const idx = time.flatMap((t, i) => (t.startsWith(date) ? [i] : []));
    if (idx.length < 20) continue; // partial trailing day
    const temps = idx.map((i) => temperature[i]!).filter(Number.isFinite);
    const dayHours = idx.filter((i) => {
      const hour = Number(time[i]!.slice(11, 13));
      return hour >= 7 && hour <= 20;
    });
    const sun = sunTimes(date, lat, lon, raw.utc_offset_seconds);
    daily.date.push(date);
    daily.code.push(Math.max(...dayHours.map((i) => code[i]!)));
    daily.max.push(Math.max(...temps));
    daily.min.push(Math.min(...temps));
    daily.sunrise.push(sun?.sunrise ?? "");
    daily.sunset.push(sun?.sunset ?? "");
    daily.uv.push(null);
    daily.pop.push(Math.max(...idx.map((i) => pop[i] ?? 0)));
  }

  const at = (series: unknown, i: number) => nums(series)[i];
  return {
    source: "ensemble",
    fetchedAt: now,
    timezone: raw.timezone,
    utcOffsetSeconds: raw.utc_offset_seconds,
    current: {
      time: nowLocal,
      temperature: temperature[hourIndex]!,
      apparent: at(h.apparent_temperature, hourIndex) ?? temperature[hourIndex]!,
      humidity: Number.isFinite(at(h.relative_humidity_2m, hourIndex)) ? at(h.relative_humidity_2m, hourIndex)! : null,
      isDay: isDay[hourIndex] === 1,
      code: code[hourIndex]!,
      windSpeed: windSpeed[hourIndex]!,
      windDirection: Number.isFinite(at(h.wind_direction_10m, hourIndex)) ? at(h.wind_direction_10m, hourIndex)! : null,
      precipitation: at(h.precipitation, hourIndex) ?? 0,
    },
    hourly: { time, temperature, pop, code, windSpeed, isDay },
    daily,
  };
}

/** While the forecast API reports its daily quota spent, skip straight to the fallback. */
let forecastBenchedUntil = 0;

export async function getForecast(lat: number, lon: number): Promise<Forecast> {
  return cached(`forecast:${gridKey(lat, lon)}`, FORECAST_TTL_MS, async () => {
    if (Date.now() >= forecastBenchedUntil) {
      try {
        const raw = await fetchJson<RawForecast>(forecastUrl(lat, lon), { cacheTtl: 600 });
        return normaliseForecast(raw);
      } catch (error) {
        if (!(error instanceof UpstreamError && error.status === 429)) throw error;
        // Rate-limited even after backoff: bench the API (a daily quota for
        // longer) and serve the ensemble model instead of an error.
        forecastBenchedUntil = Date.now() + (error.daily ? 30 : 3) * 60_000;
        console.warn(`[weather] forecast API: ${error.message} — using the ensemble API`);
      }
    }
    const raw = await fetchJson<Parameters<typeof ensembleToForecast>[0]>(ensembleUrl(lat, lon), { cacheTtl: 600 });
    return ensembleToForecast(raw, lat, lon);
  });
}

export async function getAirQuality(lat: number, lon: number): Promise<number | null> {
  try {
    return await cached(`aqi:${gridKey(lat, lon)}`, AIR_TTL_MS, async () => {
      const url = new URL("https://air-quality-api.open-meteo.com/v1/air-quality");
      url.searchParams.set("latitude", lat.toFixed(4));
      url.searchParams.set("longitude", lon.toFixed(4));
      url.searchParams.set("current", "us_aqi");
      url.searchParams.set("timezone", "auto");
      const raw = await fetchJson<{ current?: { us_aqi?: number } }>(url.toString(), { cacheTtl: 1800, attempts: 2 });
      return typeof raw.current?.us_aqi === "number" ? raw.current.us_aqi : null;
    });
  } catch {
    return null; // supplementary: the tile just shows a dash
  }
}

export async function searchCities(query: string): Promise<CityResult[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  return cached(`search:${q.toLowerCase()}`, SEARCH_TTL_MS, async () => {
    const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
    url.searchParams.set("name", q);
    url.searchParams.set("count", "8");
    url.searchParams.set("language", "en");
    url.searchParams.set("format", "json");
    const raw = await fetchJson<{ results?: Array<Record<string, unknown>> }>(url.toString(), {
      cacheTtl: 86_400,
      attempts: 2,
      timeoutMs: 6_000,
    });
    return (raw.results ?? [])
      .filter((r) => typeof r.latitude === "number" && typeof r.longitude === "number")
      .map((r) => ({
        id: String(r.id),
        name: String(r.name ?? ""),
        region: String(r.admin1 ?? ""),
        country: String(r.country ?? r.country_code ?? ""),
        countryCode: String(r.country_code ?? ""),
        latitude: r.latitude as number,
        longitude: r.longitude as number,
        timezone: String(r.timezone ?? "auto"),
        population: typeof r.population === "number" ? r.population : 0,
      }));
  });
}
