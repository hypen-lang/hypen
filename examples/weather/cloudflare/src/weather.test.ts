/**
 * Data-layer tests against recorded Open-Meteo responses (fixtures/).
 * Run: bun test
 */

import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import ensembleFixture from "../fixtures/ensemble-sf.json";
import geocodingFixture from "../fixtures/geocoding-reykjav.json";
import airFixture from "../fixtures/air-quality-sf.json";
import {
  ensembleToForecast,
  getAirQuality,
  getForecast,
  searchCities,
  setFetcher,
  sunTimes,
  type Forecast,
} from "./openmeteo";
import { describeCode, present } from "./present";
import weather, { initialWeatherState, load, retry, retryDelayMs, tick } from "./weather";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-ignore - the web-target glue (initSync + WasmEngine), as in worker.ts.
import * as wasm from "hypen-engine";

const SF = { lat: 37.7749, lon: -122.4194 };
// The ensemble fixture was recorded 2026-11-12 ~09:30 Pacific.
const RECORDED_AT = Date.parse("2026-11-12T17:30:00Z");

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

afterEach(() => setFetcher(null));

// Pin the wall clock to the fixture's recording time. Paths that read
// Date.now() internally (getForecast -> ensembleToForecast, load -> present)
// would otherwise drop the fixture's "past" days as real time moves on.
beforeAll(() => setSystemTime(RECORDED_AT));
afterAll(() => setSystemTime());

function ensembleForecast(): Forecast {
  return ensembleToForecast(ensembleFixture as never, SF.lat, SF.lon, RECORDED_AT);
}

describe("ensemble fallback", () => {
  test("derives current, hourly precipitation probability and daily aggregates", () => {
    const f = ensembleForecast();
    expect(f.source).toBe("ensemble");
    expect(f.timezone).toBe("America/Los_Angeles");
    expect(f.hourly.time.length).toBe(168);
    expect(f.current.time).toBe("2026-11-12T09:30");
    for (const p of f.hourly.pop) {
      expect(p).not.toBeNull();
      expect(p!).toBeGreaterThanOrEqual(0);
      expect(p!).toBeLessThanOrEqual(100);
    }
    expect(f.daily.date.length).toBe(7);
    for (let d = 0; d < 7; d++) expect(f.daily.max[d]!).toBeGreaterThanOrEqual(f.daily.min[d]!);
  });

  test("computes plausible sun times", () => {
    const sun = sunTimes("2026-11-12", SF.lat, SF.lon, -8 * 3600)!;
    // NOAA: SF on Nov 12 2026 — sunrise ≈ 06:49, sunset ≈ 17:00.
    expect(sun.sunrise >= "2026-11-12T06:44" && sun.sunrise <= "2026-11-12T06:54").toBe(true);
    expect(sun.sunset >= "2026-11-12T16:55" && sun.sunset <= "2026-11-12T17:05").toBe(true);
    expect(sunTimes("2026-12-21", 78.2, 15.6, 3600)).toBeNull(); // Svalbard polar night
  });
});

describe("present", () => {
  test("builds the 24 h strip, 7-day rows and tiles", () => {
    const view = present(ensembleForecast(), "C", 58, RECORDED_AT);
    expect(view.hourly.length).toBe(24);
    expect(view.hourly[0]!.time).toBe("Now");
    expect(view.hourly[1]!.time).toBe("10:00");
    expect(view.chart.points.length).toBe(24);
    expect(view.chart.domain[0]).toBeLessThan(view.chart.domain[1]);
    expect(view.daily[0]!.day).toBe("Today");
    expect(view.daily.length).toBe(7);
    expect(view.details.map((d) => d.id)).toEqual(["feels", "wind", "humidity", "sun", "uv", "aqi"]);
    expect(view.details.find((d) => d.id === "aqi")!.sub).toContain("Moderate");
    expect(view.details.find((d) => d.id === "uv")!.value).toBe("—"); // ICON ensemble has no UV
    expect(view.footer).toContain("ensemble");
    expect(view.theme.bg).toContain("linear-gradient");
    for (const row of view.daily) {
      expect(parseFloat(row.left) + parseFloat(row.width)).toBeLessThanOrEqual(100.01);
    }
  });

  test("°F converts temperatures, wind and clock labels", () => {
    const f = ensembleForecast();
    const c = present(f, "C", null, RECORDED_AT);
    const fahrenheit = present(f, "F", null, RECORDED_AT);
    expect(fahrenheit.now.temp).toBe(`${Math.round((f.current.temperature * 9) / 5 + 32)}°`);
    expect(c.now.temp).toBe(`${Math.round(f.current.temperature)}°`);
    expect(fahrenheit.hourly[1]!.time).toBe("10 AM");
    expect(fahrenheit.details.find((d) => d.id === "wind")!.value).toContain("mph");
  });

  test("night clear sky gets the moon and a dark sky", () => {
    expect(describeCode(0).kind).toBe("clear");
    const f = ensembleForecast();
    const night = present({ ...f, current: { ...f.current, code: 0, isDay: false } }, "C", null, RECORDED_AT);
    expect(night.now.icon).toContain("data:image/svg+xml");
    expect(night.theme.bg).toContain("#070B1F");
  });
});

describe("network layer", () => {
  test("a daily 429 from the forecast API falls back to the ensemble API", async () => {
    const hosts: string[] = [];
    setFetcher(async (url) => {
      const host = new URL(url).host;
      hosts.push(host);
      if (host === "api.open-meteo.com") {
        return json({ error: true, reason: "Daily API request limit exceeded. Please try again tomorrow." }, 429);
      }
      return json(ensembleFixture);
    });
    const f = await getForecast(SF.lat, SF.lon);
    expect(f.source).toBe("ensemble");
    expect(hosts).toEqual(["api.open-meteo.com", "ensemble-api.open-meteo.com"]); // no retries on a daily quota
  });

  test("transient 503 is retried, concurrent callers share one request", async () => {
    let calls = 0;
    setFetcher(async () => {
      calls++;
      return calls === 1 ? json({ reason: "busy" }, 503, { "retry-after": "0" }) : json(airFixture);
    });
    const [a, b] = await Promise.all([getAirQuality(SF.lat, SF.lon), getAirQuality(SF.lat, SF.lon)]);
    expect(a).toBe(airFixture.current.us_aqi);
    expect(b).toBe(a);
    expect(calls).toBe(2);
    await getAirQuality(SF.lat, SF.lon); // cached
    expect(calls).toBe(2);
  });

  test("geocoding results map to city rows", async () => {
    setFetcher(async (url) => {
      expect(new URL(url).searchParams.get("name")).toBe("Reykjav");
      return json(geocodingFixture);
    });
    const rows = await searchCities("Reykjav");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.name).toBe("Reykjavik");
    expect(rows[0]!.country).toBe("Iceland");
    expect(await searchCities("R")).toEqual([]); // too short — no request
  });
});

// ---------------------------------------------------------------------------
// Module: error state, retry with backoff, stale data
// ---------------------------------------------------------------------------

const timeout = () => Promise.reject(new DOMException("The operation timed out.", "TimeoutError"));

/** Open-Meteo answering normally: the ensemble stands in for the forecast API. */
const healthy: Parameters<typeof setFetcher>[0] = async (url) => {
  const host = new URL(url).host;
  if (host === "api.open-meteo.com") return json({ reason: "Daily API request limit exceeded" }, 429);
  if (host === "air-quality-api.open-meteo.com") return json(airFixture);
  return json(ensembleFixture);
};

describe("forecast error state", () => {
  test("a hung upstream leaves Loading for an error with Retry, then reports the failure", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    setFetcher(async () => {
      await gate;
      return timeout();
    });
    const state = initialWeatherState();
    const pending = load(state, { deadlineMs: 20 });
    expect(state.status).toBe("loading");
    await Bun.sleep(40);
    // Still waiting on Open-Meteo, but no longer stuck on "Loading…".
    expect(state.status).toBe("error");
    expect(state.errorText).toContain("taking too long");
    expect(state.retryText).toBe("Still trying…");

    release();
    await pending;
    expect(state.status).toBe("error");
    expect(state.errorText).toBe("Open-Meteo is not responding.");
    expect(state.retryText).toBe("Retrying automatically in 1 min.");
    expect(state.stale).toBe(false);
  }, 15_000);

  test("the ticker retries with exponential backoff; Retry skips the wait", async () => {
    expect([1, 2, 3, 4, 5, 9].map(retryDelayMs)).toEqual([60_000, 120_000, 240_000, 480_000, 600_000, 600_000]);

    let calls = 0;
    setFetcher(async (url) => {
      if (new URL(url).host === "api.open-meteo.com") calls++;
      return timeout();
    });
    const state = initialWeatherState();
    const t0 = Date.now();
    await load(state);
    expect(state.status).toBe("error");
    const afterFirst = calls;
    expect(afterFirst).toBeGreaterThan(0);

    // Within the 1 min backoff the ticker only updates the countdown.
    expect(tick(state, t0 + 30_000)).toBeUndefined();
    expect(calls).toBe(afterFirst);

    // Due: the ticker tries again; the second failure doubles the wait.
    await tick(state, Date.now() + 61_000);
    expect(calls).toBeGreaterThan(afterFirst);
    expect(state.status).toBe("error");
    expect(state.retryText).toBe("Retrying automatically in 2 min.");
    const afterSecond = calls;
    expect(tick(state, Date.now() + 90_000)).toBeUndefined();
    expect(calls).toBe(afterSecond);

    // Retry ignores the backoff, and success clears the error.
    setFetcher(healthy);
    await retry(state);
    expect(state.status).toBe("ready");
    expect(state.retryText).toBe("");
    expect(state.daily.length).toBe(7);
  }, 20_000);

  test("a failed refresh keeps the previous forecast on screen, marked stale", async () => {
    setFetcher(healthy);
    const state = initialWeatherState();
    await load(state);
    expect(state.status).toBe("ready");
    const temp = state.now.temp;
    const days = state.daily.length;

    setFetcher(async () => timeout()); // also drops the cache
    await load(state, { quiet: true });
    expect(state.status).toBe("ready");
    expect(state.now.temp).toBe(temp);
    expect(state.daily.length).toBe(days);
    expect(state.stale).toBe(true);
    expect(state.staleText).toContain("Couldn't refresh the forecast");
    expect(state.staleText).toContain("Retrying automatically in 1 min.");

    // A Retry with the forecast up never flips the screen back to Loading.
    setFetcher(healthy);
    const retrying = retry(state);
    expect(state.status).toBe("ready");
    await retrying;
    expect(state.stale).toBe(false);
    expect(state.staleText).toBe("");
  }, 15_000);

  test("the template renders the error screen and the stale banner", () => {
    wasm.initSync({ module: readFileSync(join(import.meta.dir, "../node_modules/hypen-engine/hypen_engine_bg.wasm")) });
    const engine = new wasm.WasmEngine();
    engine.registerDefaultPrimitives?.();
    const batches: string[] = [];
    engine.setRenderCallback((p: unknown) => batches.push(typeof p === "string" ? p : JSON.stringify(p)));
    const module = weather as unknown as { actions: string[]; template: string };
    const state = {
      ...initialWeatherState(),
      status: "error",
      errorText: "Open-Meteo is not responding.",
      retryText: "Retrying automatically in 1 min.",
    };
    engine.setModule("App", module.actions, Object.keys(state), state);
    engine.renderSource(module.template);
    const errorScreen = batches.join("\n");
    expect(errorScreen).toContain("Couldn’t load the forecast for Locating…");
    expect(errorScreen).toContain("Open-Meteo is not responding.");
    expect(errorScreen).toContain("Retrying automatically in 1 min.");
    expect(errorScreen).toContain('"Retry"');

    batches.length = 0;
    engine.updateState(null, { status: "ready", stale: true, staleText: "Couldn't refresh the forecast" });
    expect(batches.join("\n")).toContain("Couldn't refresh the forecast");
  });
});

describe("prefs persistence (one Durable Object per visitor)", () => {
  const memStorage = () => {
    const data = new Map<string, unknown>();
    return {
      data,
      get: async (k: string) => data.get(k),
      put: async (k: string, v: unknown) => void data.set(k, v),
      delete: async (k: string) => data.delete(k),
    };
  };
  const place = { id: "sf", name: "San Francisco", latitude: 37.77, longitude: -122.42 };

  test("each visitor's DO copy keeps its own unit + saved cities", async () => {
    const { prefsStore } = await import("./weather");
    const a = memStorage();
    const b = memStorage();
    const forA = prefsStore.__forStorage(a);
    const forB = prefsStore.__forStorage(b);
    expect(prefsStore.__forStorage(a)).toBe(forA);
    const key = forA.resolveKey(initialWeatherState(), "Weather", "s")!;

    prefsStore.__bindStorage(a);
    const saveA = forA.save(key, { ...initialWeatherState(), unit: "F", saved: [place] } as never);
    prefsStore.__bindStorage(b);
    await saveA;
    expect(await forA.load(key)).toEqual({ unit: "F", saved: [place] } as never);
    expect(await forB.load(key)).toBeNull();
    expect(b.data.size).toBe(0);
  });

  test("identical prefs from two visitors are written to both DOs", async () => {
    // The skip-unchanged cache is per DO copy: a shared one would skip B's
    // write because A had just saved the same value under the same key.
    const { prefsStore } = await import("./weather");
    const a = memStorage();
    const b = memStorage();
    const forA = prefsStore.__forStorage(a);
    const forB = prefsStore.__forStorage(b);
    const key = forA.resolveKey(initialWeatherState(), "Weather", "s")!;
    const prefs = { ...initialWeatherState(), unit: "F", saved: [] } as never;
    await forA.save(key, prefs);
    await forB.save(key, prefs);
    expect(a.data.get(`hypen:${key}`)).toEqual({ unit: "F", saved: [] });
    expect(b.data.get(`hypen:${key}`)).toEqual({ unit: "F", saved: [] });
    // ...and an unchanged save is still skipped within one DO.
    b.data.clear();
    await forB.save(key, prefs);
    expect(b.data.size).toBe(0);
  });
});
