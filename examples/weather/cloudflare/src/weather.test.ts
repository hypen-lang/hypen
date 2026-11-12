/**
 * Data-layer tests against recorded Open-Meteo responses (fixtures/).
 * Run: bun test
 */

import { afterEach, describe, expect, test } from "bun:test";
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

const SF = { lat: 37.7749, lon: -122.4194 };
// The ensemble fixture was recorded 2026-11-12 ~09:30 Pacific.
const RECORDED_AT = Date.parse("2026-11-12T17:30:00Z");

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

afterEach(() => setFetcher(null));

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
