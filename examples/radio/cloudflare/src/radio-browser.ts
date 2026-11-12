// Radio Browser client (https://api.radio-browser.info — community-run, no key).
//
// Etiquette we follow, per their docs:
// - discover API servers from the server list instead of hard-coding one,
//   falling back to a known mirror when the list is unreachable;
// - send a descriptive User-Agent (generic, no personal info);
// - report a "click" through /json/url/<uuid> when a listener actually
//   starts a station (see `countClick`).
//
// Only metadata (JSON) passes through the worker. Audio is never proxied:
// the client's media element connects straight to the station's stream URL.

export const USER_AGENT = "HypenRadioExample/1.0 (open-source Hypen UI example app)";

const SERVER_LIST_URL = "https://all.api.radio-browser.info/json/servers";
const FALLBACK_SERVERS = ["de1.api.radio-browser.info", "de2.api.radio-browser.info", "fi1.api.radio-browser.info"];
const SERVER_TTL_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8000;

/** Raw station record as returned by Radio Browser (only the fields we read). */
export interface RawStation {
  stationuuid: string;
  name: string;
  url: string;
  url_resolved: string;
  homepage: string;
  favicon: string;
  tags: string;
  country: string;
  countrycode: string;
  language: string;
  codec: string;
  bitrate: number;
  hls: number;
  votes: number;
  clickcount: number;
  clicktrend: number;
  lastcheckok: number;
}

/** The trimmed, UI-ready station shape that lives in module state. */
export interface Station {
  id: string;
  name: string;
  /** Stream URL the client plays directly (https, non-HLS — see `playability`). */
  stream: string;
  /** Same-origin artwork path served by the worker's `/art/<id>` route. */
  art: string;
  homepage: string;
  hasHomepage: boolean;
  tags: string;
  country: string;
  countrycode: string;
  flag: string;
  language: string;
  codec: string;
  bitrate: number;
  /** "MP3 · 128 kbps" */
  quality: string;
  /** "Germany · pop, rock" — one-line row subtitle. */
  subtitle: string;
  votes: number;
  clicks: number;
  playable: boolean;
  /** Why a station can't be played here ("" when playable). */
  unplayableReason: string;
}

export interface Category {
  /** Stable key for ForEach. */
  id: string;
  name: string;
  /** Route path segment (URL-encoded value). */
  slug: string;
  count: number;
  /** Small leading glyph: flag emoji for countries, "" otherwise. */
  badge: string;
}

// ---------------------------------------------------------------------------
// Server selection
// ---------------------------------------------------------------------------

let serverCache: { hosts: string[]; at: number } | null = null;

async function servers(): Promise<string[]> {
  if (serverCache && Date.now() - serverCache.at < SERVER_TTL_MS) return serverCache.hosts;
  try {
    const res = await fetch(SERVER_LIST_URL, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) {
      const list = (await res.json()) as { name?: string }[];
      const hosts = [...new Set(list.map((s) => s.name).filter((n): n is string => !!n))];
      if (hosts.length) {
        serverCache = { hosts, at: Date.now() };
        return hosts;
      }
    }
  } catch {
    // fall through to the static mirrors
  }
  return FALLBACK_SERVERS;
}

/** GET a Radio Browser JSON endpoint, trying another mirror on failure. */
export async function rbGet<T>(path: string, params: Record<string, string | number | boolean> = {}): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
  const query = qs.toString();
  const hosts = await servers();
  // Random start spreads load across mirrors, as the docs ask.
  const start = Math.floor(Math.random() * hosts.length);
  let lastError: unknown = null;
  for (let i = 0; i < Math.min(hosts.length, 3); i++) {
    const host = hosts[(start + i) % hosts.length];
    try {
      const res = await fetch(`https://${host}${path}${query ? `?${query}` : ""}`, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`Radio Browser ${res.status} for ${path}`);
      return (await res.json()) as T;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Radio Browser unreachable");
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * Codecs every renderer's native media stack decodes from a plain progressive
 * stream: browsers (<video>/<audio>), AVPlayer (iOS) and ExoPlayer (Android).
 * OGG/Opus is left out because Safari/AVPlayer can't play it.
 */
const PLAYABLE_CODECS = new Set(["MP3", "AAC", "AAC+"]);

export function playability(raw: Pick<RawStation, "url_resolved" | "hls" | "codec">): string {
  const url = raw.url_resolved || "";
  if (!url.startsWith("https://")) return "This station only streams over plain HTTP, which browsers block on secure pages.";
  if (raw.hls) return "This station streams HLS, which only Safari and the native apps can play.";
  if (!PLAYABLE_CODECS.has((raw.codec || "").toUpperCase())) {
    return `This station's ${raw.codec || "unknown"} stream isn't supported on every platform.`;
  }
  return "";
}

export function flagEmoji(code: string): string {
  if (!/^[A-Za-z]{2}$/.test(code)) return "";
  const base = 0x1f1e6;
  const upper = code.toUpperCase();
  return String.fromCodePoint(base + upper.charCodeAt(0) - 65, base + upper.charCodeAt(1) - 65);
}

function cleanTags(tags: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of (tags || "").split(",")) {
    const tag = t.trim().toLowerCase();
    if (!tag || tag.length > 24 || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

export function tagList(station: Pick<Station, "tags">): string[] {
  return station.tags ? station.tags.split(", ") : [];
}

export function normalize(raw: RawStation): Station {
  const tags = cleanTags(raw.tags).slice(0, 6);
  const codec = (raw.codec || "").toUpperCase();
  const quality = [codec && codec !== "UNKNOWN" ? codec : "", raw.bitrate > 0 ? `${raw.bitrate} kbps` : ""]
    .filter(Boolean)
    .join(" · ");
  // Radio Browser's names are long-form ("The United States Of America").
  const country = /^[A-Za-z]{2}$/.test(raw.countrycode || "")
    ? countryName(raw.countrycode)
    : raw.country || "";
  const reason = playability(raw);
  const homepage = /^https?:\/\//.test(raw.homepage || "") ? raw.homepage : "";
  return {
    id: raw.stationuuid,
    name: (raw.name || "Untitled station").trim().replace(/\s+/g, " "),
    stream: reason ? "" : raw.url_resolved,
    art: `/art/${raw.stationuuid}`,
    homepage,
    hasHomepage: homepage !== "",
    tags: tags.join(", "),
    country,
    countrycode: (raw.countrycode || "").toUpperCase(),
    flag: flagEmoji(raw.countrycode || ""),
    language: raw.language || "",
    codec,
    bitrate: raw.bitrate || 0,
    quality: quality || "Unknown format",
    subtitle: [country, tags.slice(0, 2).join(", ")].filter(Boolean).join(" · "),
    votes: raw.votes || 0,
    clicks: raw.clickcount || 0,
    playable: reason === "",
    unplayableReason: reason,
  };
}

/**
 * Keep playable stations only, dropping Radio Browser's frequent duplicates
 * (the same station submitted several times under one name).
 */
export function playableStations(raws: RawStation[], limit: number): Station[] {
  const seen = new Set<string>();
  const out: Station[] = [];
  for (const raw of raws) {
    if (playability(raw)) continue;
    const key = (raw.name || "").trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(normalize(raw));
    if (out.length >= limit) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export type ListKind = "top" | "trending" | "country" | "tag" | "language";

export interface StationQuery {
  kind: ListKind;
  value?: string;
  name?: string;
}

/**
 * Station search. `is_https` + `hidebroken` filter at the source; HLS and
 * codec filtering happen locally, so we over-fetch and trim.
 */
export async function searchStations(q: StationQuery, limit = 40): Promise<Station[]> {
  const params: Record<string, string | number | boolean> = {
    hidebroken: true,
    is_https: true,
    reverse: true,
    order: q.kind === "trending" ? "clicktrend" : "clickcount",
    limit: Math.min(limit * 3, 300),
  };
  if (q.kind === "country" && q.value) params.countrycode = q.value.toUpperCase();
  if (q.kind === "tag" && q.value) {
    params.tag = q.value;
    params.tagExact = true;
  }
  if (q.kind === "language" && q.value) {
    params.language = q.value;
    params.languageExact = true;
  }
  if (q.name) params.name = q.name;
  const raws = await rbGet<RawStation[]>("/json/stations/search", params);
  return playableStations(raws, limit);
}

export async function stationById(id: string): Promise<Station | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const raws = await rbGet<RawStation[]>("/json/stations/byuuid", { uuids: id });
  return raws[0] ? normalize(raws[0]) : null;
}

/** Raw favicon URL + name for the artwork route (not exposed to clients). */
export async function faviconFor(id: string): Promise<{ favicon: string; name: string }> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return { favicon: "", name: "" };
  const raws = await rbGet<RawStation[]>("/json/stations/byuuid", { uuids: id });
  return { favicon: raws[0]?.favicon ?? "", name: raws[0]?.name ?? "" };
}

/**
 * Count a click (Radio Browser's popularity signal). Called once each time a
 * listener starts a station. Fire-and-forget: a failure never blocks playback.
 */
export async function countClick(id: string): Promise<boolean> {
  try {
    const res = await rbGet<{ ok?: boolean | string }>(`/json/url/${encodeURIComponent(id)}`);
    return res.ok === true || res.ok === "true";
  } catch {
    return false;
  }
}

export type CategoryKind = "genres" | "countries" | "languages";

interface RawTag { name: string; stationcount: number }
interface RawCountry { name: string; iso_3166_1: string; stationcount: number }
interface RawLanguage { name: string; iso_639: string | null; stationcount: number }

export async function categories(kind: CategoryKind): Promise<Category[]> {
  const common = { order: "stationcount", reverse: true, hidebroken: true };
  if (kind === "countries") {
    const list = await rbGet<RawCountry[]>("/json/countries", common);
    return list
      .filter((c) => c.iso_3166_1 && c.stationcount >= 5)
      .map((c) => ({
        id: c.iso_3166_1,
        name: c.name,
        slug: encodeURIComponent(c.iso_3166_1),
        count: c.stationcount,
        badge: flagEmoji(c.iso_3166_1),
      }));
  }
  if (kind === "languages") {
    const list = await rbGet<RawLanguage[]>("/json/languages", { ...common, limit: 80 });
    return list
      .filter((l) => l.name && l.stationcount >= 5)
      .map((l) => ({
        id: l.name,
        name: l.name.replace(/\b\w/g, (m) => m.toUpperCase()),
        slug: encodeURIComponent(l.name),
        count: l.stationcount,
        badge: "",
      }));
  }
  const list = await rbGet<RawTag[]>("/json/tags", { ...common, limit: 120 });
  return list
    .filter((t) => t.name && t.name.length <= 24 && !/[\d]{4}|^\W/.test(t.name))
    .slice(0, 80)
    .map((t) => ({
      id: t.name,
      name: t.name,
      slug: encodeURIComponent(t.name),
      count: t.stationcount,
      badge: "",
    }));
}

let countryNames: Intl.DisplayNames | null = null;
export function countryName(code: string): string {
  try {
    countryNames ??= new Intl.DisplayNames(["en"], { type: "region" });
    return countryNames.of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}
