// Upstream APIs: the Hacker News Firebase API and the Wikimedia REST feed.
//
// Everything here is a pure fetch + normalise step. Caching, polling and
// fan-out live in the NewsHub Durable Object (hub.ts) so every visitor shares
// one upstream budget. The normalisers are exported for the fixture tests.

import { domainOf, pad2 } from "./format";
import { htmlToRichText, htmlToText } from "./html";

// Wikimedia asks API clients for a descriptive agent with a contact point
// (https://meta.wikimedia.org/wiki/User-Agent_policy). Generic on purpose: it
// names the example project, never the person running it.
export const USER_AGENT = "HypenNewsExample/1.0 (+https://github.com/hypen-lang/hypen; Hypen example app)";

const HN = "https://hacker-news.firebaseio.com/v0";
const WIKI = "https://en.wikipedia.org/api/rest_v1";
const TIMEOUT_MS = 8000;

export class UpstreamError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function getJson<T>(url: string, wiki = false): Promise<T> {
  const headers: Record<string, string> = { "User-Agent": USER_AGENT, Accept: "application/json" };
  if (wiki) headers["Api-User-Agent"] = USER_AGENT;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new UpstreamError(`${res.status} from ${new URL(url).host}`, res.status);
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Hacker News
// ---------------------------------------------------------------------------

export const HN_KINDS = ["top", "new", "best", "ask", "show", "job"] as const;
export type HnKind = (typeof HN_KINDS)[number];

export interface HnItem {
  id: number;
  type?: "story" | "comment" | "job" | "poll" | "pollopt";
  by?: string;
  time?: number;
  title?: string;
  url?: string;
  text?: string;
  score?: number;
  descendants?: number;
  kids?: number[];
  parent?: number;
  dead?: boolean;
  deleted?: boolean;
}

/** The compact story shape the hub hands to sessions (cheap to ship over RPC). */
export interface StoryLite {
  id: number;
  title: string;
  url: string;
  domain: string;
  score: number;
  by: string;
  time: number;
  comments: number;
  type: string;
}

export function fetchHnIds(kind: HnKind): Promise<number[]> {
  return getJson<number[]>(`${HN}/${kind}stories.json`);
}

export function fetchHnItem(id: number): Promise<HnItem | null> {
  return getJson<HnItem | null>(`${HN}/item/${id}.json`);
}

export function hnUrl(id: number): string {
  return `https://news.ycombinator.com/item?id=${id}`;
}

export function toStoryLite(item: HnItem): StoryLite {
  return {
    id: item.id,
    title: htmlToText(item.title ?? "(untitled)"),
    url: item.url ?? hnUrl(item.id),
    domain: item.url ? domainOf(item.url) : "news.ycombinator.com",
    score: item.score ?? 0,
    by: item.by ?? "",
    time: item.time ?? 0,
    comments: item.descendants ?? 0,
    type: item.type ?? "story",
  };
}

// ---------------------------------------------------------------------------
// Wikipedia
// ---------------------------------------------------------------------------

export interface WikiCard {
  /** Canonical title ("Ada_Lovelace") — route param and summary key. */
  title: string;
  name: string;
  description: string;
  thumb: string;
  /** e.g. "776K views" for most-read, else "". */
  meta: string;
  rank: number;
}

export interface NewsItem {
  id: string;
  text: string;
  /** Main article (the bold link in the blurb), for the tap target. */
  title: string;
  thumb: string;
}

export interface OtdEvent {
  id: string;
  year: number;
  yearLabel: string;
  text: string;
  title: string;
  name: string;
  thumb: string;
}

export interface Potd {
  title: string;
  thumb: string;
  width: number;
  height: number;
  caption: string;
  credit: string;
  page: string;
}

export interface FeaturedDigest {
  date: string;
  potd: Potd | null;
  news: NewsItem[];
  mostRead: WikiCard[];
  onThisDay: OtdEvent[];
}

export interface WikiSummary {
  title: string;
  name: string;
  description: string;
  extract: string;
  image: string;
  width: number;
  height: number;
  page: string;
}

interface RawPage {
  title?: string;
  normalizedtitle?: string;
  titles?: { normalized?: string; canonical?: string };
  description?: string;
  thumbnail?: { source?: string; width?: number; height?: number };
  originalimage?: { source?: string; width?: number; height?: number };
  views?: number;
  rank?: number;
  namespace?: { id?: number };
  type?: string;
}

function pageName(p: RawPage): string {
  return p.titles?.normalized ?? p.normalizedtitle ?? (p.title ?? "").replace(/_/g, " ");
}

function pageTitle(p: RawPage): string {
  return p.titles?.canonical ?? p.title ?? "";
}

function isArticle(p: RawPage): boolean {
  const t = pageTitle(p);
  return (p.namespace?.id ?? 0) === 0 && t !== "Main_Page" && !t.startsWith("Special:") && p.type !== "disambiguation";
}

/** Wikimedia hands out `?utm_*` tracking params on thumbnails; strip them. */
export function cleanImage(src: string | undefined): string {
  if (!src) return "";
  return src.replace(/\?utm_[^#]*$/, "");
}

function views(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M views`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K views`;
  return `${n} views`;
}

function boldTitle(html: string): string | null {
  const m = html.match(/<b[^>]*>(?:<[^>]+>)*<a[^>]*href="\.\/([^"#]+)"/i);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

function yearLabel(year: number): string {
  return year < 0 ? `${-year} BC` : String(year);
}

export function toOtd(raw: { text?: string; year?: number; pages?: RawPage[] }[], prefix: string): OtdEvent[] {
  return raw
    .filter((e) => typeof e.year === "number" && e.text)
    .map((e, i) => {
      const pages = (e.pages ?? []).filter(isArticle);
      const withThumb = pages.find((p) => p.thumbnail?.source);
      const main = pages[0];
      return {
        id: `${prefix}${i}-${e.year}`,
        year: e.year!,
        yearLabel: yearLabel(e.year!),
        text: htmlToText(e.text),
        title: main ? pageTitle(main) : "",
        name: main ? pageName(main) : "",
        thumb: cleanImage(withThumb?.thumbnail?.source),
      };
    })
    .sort((a, b) => b.year - a.year);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toFeaturedDigest(raw: any, date: string): FeaturedDigest {
  const image = raw?.image;
  const potd: Potd | null = image?.thumbnail?.source
    ? {
        title: String(image.title ?? "").replace(/^File:/, "").replace(/\.[a-z]+$/i, ""),
        thumb: cleanImage(image.thumbnail.source),
        width: image.thumbnail.width ?? 640,
        height: image.thumbnail.height ?? 480,
        caption: htmlToText(image.description?.html ?? image.description?.text ?? ""),
        credit: [image.artist?.text, image.license?.type].filter(Boolean).join(" · "),
        page: image.file_page ?? "",
      }
    : null;

  const news: NewsItem[] = (raw?.news ?? []).map((n: { story?: string; links?: RawPage[] }, i: number) => {
    const links = (n.links ?? []).filter(isArticle);
    const bold = n.story ? boldTitle(n.story) : null;
    const main = links.find((l) => pageTitle(l) === bold) ?? links[0];
    const withThumb = (main?.thumbnail?.source ? main : undefined) ?? links.find((l) => l.thumbnail?.source);
    return {
      id: `n${i}-${main ? pageTitle(main) : i}`,
      text: htmlToRichText(n.story).text,
      title: main ? pageTitle(main) : "",
      thumb: cleanImage(withThumb?.thumbnail?.source),
    };
  });

  const mostRead: WikiCard[] = (raw?.mostread?.articles ?? [])
    .filter(isArticle)
    .slice(0, 12)
    .map((p: RawPage, i: number) => ({
      title: pageTitle(p),
      name: pageName(p),
      description: p.description ?? "",
      thumb: cleanImage(p.thumbnail?.source),
      meta: views(p.views ?? 0),
      rank: i + 1,
    }));

  return {
    date,
    potd,
    news,
    mostRead,
    onThisDay: toOtd(raw?.onthisday ?? [], "s"),
  };
}

export function dateParts(d: Date): { y: number; m: string; d: string } {
  return { y: d.getUTCFullYear(), m: pad2(d.getUTCMonth() + 1), d: pad2(d.getUTCDate()) };
}

export async function fetchFeatured(date: Date): Promise<FeaturedDigest> {
  const p = dateParts(date);
  const raw = await getJson<unknown>(`${WIKI}/feed/featured/${p.y}/${p.m}/${p.d}`, true);
  return toFeaturedDigest(raw, `${p.y}-${p.m}-${p.d}`);
}

export type OtdKind = "events" | "births" | "deaths";

export async function fetchOnThisDay(kind: OtdKind, month: string, day: string): Promise<OtdEvent[]> {
  const raw = await getJson<Record<string, { text?: string; year?: number; pages?: RawPage[] }[]>>(
    `${WIKI}/feed/onthisday/${kind}/${month}/${day}`,
    true,
  );
  return toOtd(raw[kind] ?? [], kind[0]!).slice(0, 60);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toSummary(raw: any): WikiSummary {
  const img = raw?.originalimage?.width && raw.originalimage.width <= 1200 ? raw.originalimage : raw?.thumbnail;
  return {
    title: raw?.titles?.canonical ?? raw?.title ?? "",
    name: raw?.titles?.normalized ?? raw?.title ?? "",
    description: raw?.description ?? "",
    extract: raw?.extract ?? "",
    image: cleanImage(img?.source),
    width: img?.width ?? 0,
    height: img?.height ?? 0,
    page: raw?.content_urls?.mobile?.page ?? raw?.content_urls?.desktop?.page ?? "",
  };
}

export async function fetchSummary(title: string): Promise<WikiSummary> {
  const raw = await getJson<unknown>(`${WIKI}/page/summary/${encodeURIComponent(title)}`, true);
  return toSummary(raw);
}
