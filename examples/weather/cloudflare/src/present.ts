/**
 * Forecast → view model. Pure functions (no I/O), so the whole screen can
 * be re-derived from the cached forecast on every clock tick or unit flip,
 * and unit-tested against a recorded response.
 */

import { ICONS, type IconName } from "./icons";
import { localIso, type Forecast } from "./openmeteo";

export type Unit = "C" | "F";

// ---------------------------------------------------------------------------
// WMO weather codes (https://open-meteo.com/en/docs#weathervariables)
// ---------------------------------------------------------------------------

export type Kind = "clear" | "partly" | "cloudy" | "fog" | "drizzle" | "rain" | "snow" | "storm";

export function describeCode(code: number): { kind: Kind; label: string } {
  switch (code) {
    case 0: return { kind: "clear", label: "Clear" };
    case 1: return { kind: "partly", label: "Mostly clear" };
    case 2: return { kind: "partly", label: "Partly cloudy" };
    case 3: return { kind: "cloudy", label: "Overcast" };
    case 45: return { kind: "fog", label: "Fog" };
    case 48: return { kind: "fog", label: "Freezing fog" };
    case 51: return { kind: "drizzle", label: "Light drizzle" };
    case 53: return { kind: "drizzle", label: "Drizzle" };
    case 55: return { kind: "drizzle", label: "Heavy drizzle" };
    case 56: case 57: return { kind: "drizzle", label: "Freezing drizzle" };
    case 61: return { kind: "rain", label: "Light rain" };
    case 63: return { kind: "rain", label: "Rain" };
    case 65: return { kind: "rain", label: "Heavy rain" };
    case 66: case 67: return { kind: "rain", label: "Freezing rain" };
    case 71: return { kind: "snow", label: "Light snow" };
    case 73: return { kind: "snow", label: "Snow" };
    case 75: return { kind: "snow", label: "Heavy snow" };
    case 77: return { kind: "snow", label: "Snow grains" };
    case 80: return { kind: "rain", label: "Light showers" };
    case 81: return { kind: "rain", label: "Showers" };
    case 82: return { kind: "rain", label: "Violent showers" };
    case 85: return { kind: "snow", label: "Snow showers" };
    case 86: return { kind: "snow", label: "Heavy snow showers" };
    case 95: return { kind: "storm", label: "Thunderstorm" };
    case 96: case 99: return { kind: "storm", label: "Thunderstorm, hail" };
    default: return { kind: "cloudy", label: "Unknown" };
  }
}

export function iconFor(code: number, isDay: boolean): string {
  const { kind } = describeCode(code);
  const name: IconName =
    kind === "clear" ? (isDay ? "sun" : "moon")
    : kind === "partly" ? (isDay ? "partly-day" : "partly-night")
    : kind === "cloudy" ? "cloud"
    : kind;
  return ICONS[name];
}

// ---------------------------------------------------------------------------
// Theme: background + surfaces follow the condition and day / night
// ---------------------------------------------------------------------------

export interface Theme {
  bg: string;
  card: string;
  cardBorder: string;
  text: string;
  sub: string;
  chip: string;
  chipActive: string;
  chipActiveText: string;
  input: string;
  accent: string;
}

const GRADIENTS: Record<Kind, [string, string]> = {
  //       day                                   night
  clear: ["#1F7FE0, #4FA6F2 55%, #93C9F5", "#070B1F, #142250 55%, #263A70"],
  partly: ["#3D82CC, #6EA6DD 55%, #A3C3E2", "#0E1630, #22304F 55%, #374767"],
  cloudy: ["#5A6E84, #7D90A4 55%, #A2B0BF", "#171E28, #29323F 55%, #3C4655"],
  fog: ["#6E7B88, #919CA8 55%, #B3BBC4", "#1E232B, #30363F 55%, #444B55"],
  drizzle: ["#4A6077, #667C92 55%, #8A9DB0", "#121A24, #202C3B 55%, #314054"],
  rain: ["#344A60, #4E647B 55%, #6E8399", "#0D141D, #1A2533 55%, #2A394C"],
  snow: ["#6F8BA8, #93ABC4 55%, #BCCDDF", "#1F2A40, #35435D 55%, #50607C"],
  storm: ["#262A40, #3D4360 55%, #565D7E", "#0B0C16, #1A1C2E 55%, #2B2E4A"],
};

export function themeFor(code: number, isDay: boolean): Theme {
  const { kind } = describeCode(code);
  const [day, night] = GRADIENTS[kind];
  return {
    bg: `linear-gradient(180deg, ${isDay ? day : night})`,
    card: isDay ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.08)",
    cardBorder: isDay ? "rgba(255,255,255,0.22)" : "rgba(255,255,255,0.12)",
    text: "#FFFFFF",
    sub: isDay ? "rgba(255,255,255,0.82)" : "rgba(255,255,255,0.66)",
    chip: isDay ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.10)",
    chipActive: "#FFFFFF",
    chipActiveText: isDay ? "#1E3A5F" : "#111827",
    input: isDay ? "rgba(255,255,255,0.22)" : "rgba(255,255,255,0.10)",
    accent: kind === "clear" || kind === "partly" ? "#FFD43B" : "#7DD3FC",
  };
}

// ---------------------------------------------------------------------------
// Units & formatting
// ---------------------------------------------------------------------------

export const toUnit = (celsius: number, unit: Unit) => (unit === "F" ? (celsius * 9) / 5 + 32 : celsius);
export const deg = (celsius: number, unit: Unit) =>
  Number.isFinite(celsius) ? `${Math.round(toUnit(celsius, unit))}°` : "—";

/** "2026-11-12T15:00" → "3 PM" (°F) or "15:00" (°C). */
export function hourLabel(localTime: string, unit: Unit): string {
  const h = Number(localTime.slice(11, 13));
  if (unit === "C") return `${String(h).padStart(2, "0")}:00`;
  return `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? "AM" : "PM"}`;
}

/** "2026-11-12T07:04" → "7:04 AM" (°F) or "07:04" (°C). */
export function clockLabel(localTime: string, unit: Unit): string {
  if (!localTime) return "—";
  const h = Number(localTime.slice(11, 13));
  const m = localTime.slice(14, 16);
  if (unit === "C") return `${String(h).padStart(2, "0")}:${m}`;
  return `${h % 12 === 0 ? 12 : h % 12}:${m} ${h < 12 ? "AM" : "PM"}`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const weekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const compass = (degrees: number) => COMPASS[Math.round((((degrees % 360) + 360) % 360) / 45) % 8]!;

function uvLabel(uv: number): string {
  if (uv < 3) return "Low";
  if (uv < 6) return "Moderate";
  if (uv < 8) return "High";
  if (uv < 11) return "Very high";
  return "Extreme";
}

function aqiLabel(aqi: number): string {
  if (aqi <= 50) return "Good";
  if (aqi <= 100) return "Moderate";
  if (aqi <= 150) return "Unhealthy for some";
  if (aqi <= 200) return "Unhealthy";
  if (aqi <= 300) return "Very unhealthy";
  return "Hazardous";
}

/** Colour for a temperature (°C) on the range bars. */
function tempColor(celsius: number): string {
  if (celsius < -5) return "#A5B4FC";
  if (celsius < 3) return "#93C5FD";
  if (celsius < 10) return "#67E8F9";
  if (celsius < 17) return "#6EE7B7";
  if (celsius < 23) return "#FDE047";
  if (celsius < 29) return "#FDBA74";
  return "#F87171";
}

// ---------------------------------------------------------------------------
// The view model
// ---------------------------------------------------------------------------

export interface HourCell {
  id: string;
  time: string;
  icon: string;
  condition: string;
  temp: string;
  pop: string;
  /** Strength of the rain chance (0–1), drives the label opacity. */
  popOpacity: number;
  isNow: boolean;
}

export interface DayRow {
  id: string;
  day: string;
  icon: string;
  condition: string;
  pop: string;
  lo: string;
  hi: string;
  /** Range bar: offset and width as percentages of the week's span. */
  left: string;
  width: string;
  bar: string;
}

export interface Detail {
  id: string;
  label: string;
  value: string;
  sub: string;
}

export interface WeatherView {
  now: {
    temp: string;
    icon: string;
    label: string;
    hiLo: string;
    feels: string;
    localTime: string;
    dateLabel: string;
    isDay: boolean;
  };
  theme: Theme;
  hourly: HourCell[];
  chart: { points: [number, number][]; domain: [number, number]; nowPoint: [number, number][] };
  summary: string;
  daily: DayRow[];
  details: Detail[];
  footer: string;
}

const HOURS = 24;

export function present(
  f: Forecast,
  unit: Unit,
  aqi: number | null,
  nowMs = Date.now(),
): WeatherView {
  const nowLocal = localIso(nowMs, f.utcOffsetSeconds);
  const today = nowLocal.slice(0, 10);

  // ---- hourly: from the current hour, 24 entries ----
  const nextIdx = f.hourly.time.findIndex((t) => t > nowLocal);
  const start = Math.max(0, (nextIdx === -1 ? f.hourly.time.length : nextIdx) - 1);
  const idx = Array.from({ length: HOURS }, (_, k) => start + k).filter((i) => i < f.hourly.time.length);
  const hourly: HourCell[] = idx.map((i, k) => {
    const pop = f.hourly.pop[i];
    return {
      id: f.hourly.time[i]!,
      time: k === 0 ? "Now" : hourLabel(f.hourly.time[i]!, unit),
      icon: k === 0 ? iconFor(f.current.code, f.current.isDay) : iconFor(f.hourly.code[i]!, f.hourly.isDay[i] === 1),
      condition: describeCode(k === 0 ? f.current.code : f.hourly.code[i]!).label,
      temp: deg(k === 0 ? f.current.temperature : f.hourly.temperature[i]!, unit),
      pop: pop != null && pop >= 10 ? `${Math.round(pop / 5) * 5}%` : "",
      popOpacity: pop != null ? Math.min(1, 0.55 + pop / 200) : 0,
      isNow: k === 0,
    };
  });

  const temps = idx.map((i, k) => toUnit(k === 0 ? f.current.temperature : f.hourly.temperature[i]!, unit));
  const lo = Math.min(...temps);
  const hi = Math.max(...temps);
  const pad = Math.max(1, (hi - lo) * 0.25);
  const points = temps.map((t, k) => [k, Math.round(t * 10) / 10] as [number, number]);

  // ---- summary line over the hourly strip ----
  const wet = idx.findIndex((i) => (f.hourly.pop[i] ?? 0) >= 50);
  const peakK = temps.indexOf(hi);
  const summary =
    wet === 0
      ? `${describeCode(f.current.code).label} now · ${Math.round(f.hourly.pop[idx[0]!] ?? 0)}% chance of precipitation this hour.`
      : wet > 0
        ? `${describeCode(f.hourly.code[idx[wet]!]!).kind === "snow" ? "Snow" : "Rain"} likely from ${hourLabel(f.hourly.time[idx[wet]!]!, unit)} (${f.hourly.pop[idx[wet]!]}%).`
        : `No precipitation expected in the next 24 hours. ${peakK === 0 ? "Warmest right now" : `Peak ${deg(f.hourly.temperature[idx[peakK]!]!, unit)} at ${hourLabel(f.hourly.time[idx[peakK]!]!, unit)}`}.`;

  // ---- daily: from today, 7 rows with range bars on the week's span ----
  const dayStart = Math.max(0, f.daily.date.indexOf(today));
  const days = f.daily.date.slice(dayStart, dayStart + 7).map((_, k) => dayStart + k);
  const weekMin = Math.min(...days.map((d) => f.daily.min[d]!));
  const weekMax = Math.max(...days.map((d) => f.daily.max[d]!));
  const span = Math.max(1, weekMax - weekMin);
  const daily: DayRow[] = days.map((d, k) => {
    const dMin = f.daily.min[d]!;
    const dMax = f.daily.max[d]!;
    const left = ((dMin - weekMin) / span) * 100;
    const width = Math.max(6, ((dMax - dMin) / span) * 100);
    const pop = f.daily.pop[d];
    return {
      id: f.daily.date[d]!,
      day: k === 0 ? "Today" : WEEKDAYS[weekday(f.daily.date[d]!)]!,
      icon: iconFor(f.daily.code[d]!, true),
      condition: describeCode(f.daily.code[d]!).label,
      pop: pop != null && pop >= 20 ? `${Math.round(pop / 10) * 10}%` : "",
      lo: deg(dMin, unit),
      hi: deg(dMax, unit),
      left: `${Math.min(left, 94).toFixed(1)}%`,
      width: `${Math.min(width, 100 - Math.min(left, 94)).toFixed(1)}%`,
      bar: `linear-gradient(90deg, ${tempColor(dMin)}, ${tempColor(dMax)})`,
    };
  });

  // ---- detail tiles ----
  const c = f.current;
  const d0 = days[0] ?? 0;
  const feelsDelta = c.apparent - c.temperature;
  const wind = unit === "F" ? `${Math.round(c.windSpeed * 0.621371)} mph` : `${Math.round(c.windSpeed)} km/h`;
  const sunrise = f.daily.sunrise[d0] ?? "";
  const sunset = f.daily.sunset[d0] ?? "";
  const tomorrowSunrise = f.daily.sunrise[d0 + 1] ?? "";
  const sun =
    sunrise && nowLocal < sunrise
      ? { label: "Sunrise", value: clockLabel(sunrise, unit), sub: `Sunset ${clockLabel(sunset, unit)}` }
      : sunset && nowLocal < sunset
        ? { label: "Sunset", value: clockLabel(sunset, unit), sub: `Sunrise ${clockLabel(sunrise, unit)}` }
        : { label: "Sunrise", value: clockLabel(tomorrowSunrise, unit), sub: `Tomorrow · set ${clockLabel(sunset, unit)} today` };
  const uv = f.daily.uv[d0];
  const maxPop = Math.max(0, ...idx.map((i) => f.hourly.pop[i] ?? 0));
  const precip = unit === "F" ? `${(c.precipitation / 25.4).toFixed(2)} in` : `${c.precipitation.toFixed(1)} mm`;

  const details: Detail[] = [
    {
      id: "feels",
      label: "Feels like",
      value: deg(c.apparent, unit),
      sub: Math.abs(feelsDelta) < 1.5 ? "Close to the actual temperature" : feelsDelta < 0 ? "Wind makes it feel colder" : "Humidity makes it feel warmer",
    },
    {
      id: "wind",
      label: "Wind",
      value: wind,
      sub: c.windDirection != null ? `From the ${compass(c.windDirection)}` : "",
    },
    {
      id: "humidity",
      label: "Humidity",
      value: c.humidity != null ? `${Math.round(c.humidity)}%` : "—",
      sub: `Precipitation ${precip} now`,
    },
    {
      id: "sun",
      label: sun.label,
      value: sun.value,
      sub: sun.sub,
    },
    {
      id: "uv",
      label: "UV index",
      value: uv != null ? String(Math.round(uv)) : "—",
      sub: uv != null ? `${uvLabel(uv)} today` : "Not in this model",
    },
    {
      id: "aqi",
      label: "Air quality",
      value: aqi != null ? String(Math.round(aqi)) : "—",
      sub: aqi != null ? `${aqiLabel(aqi)} · US AQI` : "Unavailable",
    },
  ];

  const nowDate = new Date(`${today}T12:00:00Z`);
  const ageMin = Math.max(0, Math.round((nowMs - f.fetchedAt) / 60_000));
  return {
    now: {
      temp: deg(c.temperature, unit),
      icon: iconFor(c.code, c.isDay),
      label: describeCode(c.code).label,
      hiLo: `H:${deg(f.daily.max[d0]!, unit)}  L:${deg(f.daily.min[d0]!, unit)}`,
      feels: `Feels like ${deg(c.apparent, unit)}`,
      localTime: clockLabel(nowLocal, unit),
      dateLabel: `${WEEKDAYS_LONG[nowDate.getUTCDay()]}, ${MONTHS[nowDate.getUTCMonth()]} ${nowDate.getUTCDate()}`,
      isDay: c.isDay,
    },
    theme: themeFor(c.code, c.isDay),
    hourly,
    chart: {
      points,
      domain: [Math.floor(lo - pad), Math.ceil(hi + pad)],
      nowPoint: points.slice(0, 1),
    },
    summary,
    daily,
    details,
    footer:
      `Weather data by Open-Meteo.com${f.source === "ensemble" ? " (ICON ensemble — forecast API rate-limited)" : ""} · ` +
      (ageMin === 0 ? "updated just now" : `updated ${ageMin} min ago`),
  };
}
