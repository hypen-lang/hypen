/**
 * Link previews: fetch a page's OpenGraph tags server-side.
 *
 * Guard rails (this runs on a URL any visitor can type):
 *   - http(s) only, default ports only, no credentials in the URL;
 *   - SSRF: the host must be a public DNS name. IP literals in private,
 *     loopback, link-local, CGNAT, multicast or reserved ranges (v4 and v6,
 *     including v4-mapped v6), `localhost`, single-label names and internal
 *     suffixes (.local, .internal, .lan, .home.arpa, …) are refused. Workers
 *     cannot resolve DNS themselves, so a public name that resolves to a
 *     private address is left to Cloudflare's egress, which does not route
 *     Worker subrequests to private networks;
 *   - redirects are followed by hand (max 3), re-checking every hop;
 *   - 4 s overall timeout, `text/html` only, and at most 256 KiB of the body
 *     is read before parsing;
 *   - extracted strings are entity-decoded, stripped and length-capped, and
 *     the preview image must itself be a safe https URL.
 */

import { safeHttpUrl } from "./text";

export interface LinkPreview {
  url: string;
  site: string;
  title: string;
  description: string;
  image: string;
}

const TIMEOUT_MS = 4000;
const MAX_BYTES = 256 * 1024;
const MAX_REDIRECTS = 3;

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".lan", ".home", ".corp", ".home.arpa", ".private"];

function ipv4Blocked(host: string): boolean | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([a, b, Number(m[3]), Number(m[4])].some((n) => n > 255)) return true;
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) ||           // link-local / cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224                              // multicast + reserved
  );
}

function ipv6Blocked(host: string): boolean | null {
  if (!host.startsWith("[")) return null;
  const h = host.slice(1, -1).toLowerCase();
  if (h === "::" || h === "::1") return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (mapped) return ipv4Blocked(mapped[1]!) ?? true;
  if (h.startsWith("::ffff:")) return true; // hex-form v4-mapped
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(h) || h.startsWith("64:ff9b") || h.startsWith("2001:db8");
}

/** Whether a URL is allowed as an outbound preview fetch. */
export function isPublicUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  if (url.port && url.port !== "80" && url.port !== "443") return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const v6 = ipv6Blocked(host);
  if (v6 !== null) return !v6;
  const v4 = ipv4Blocked(host);
  if (v4 !== null) return !v4;
  // Other numeric forms (`2130706433`, `0x7f.1`) — refuse anything all-numeric/hex-ish.
  if (/^[0-9.x]+$/i.test(host)) return false;
  if (!host.includes(".") || host === "localhost") return false;
  return !BLOCKED_SUFFIXES.some((s) => host.endsWith(s));
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 31 && code < 0x110000 ? String.fromCodePoint(code) : "";
    }
    return ENTITIES[e.toLowerCase()] ?? whole;
  });
}

function clip(s: string | undefined, max: number): string {
  if (!s) return "";
  const t = decodeEntities(s).replace(/[\u0000-\u001F\u007F​-‏‪-‮]/g, " ").replace(/\s+/g, " ").trim();
  const chars = [...t];
  return chars.length > max ? chars.slice(0, max - 1).join("") + "…" : t;
}

/** Pull og:/twitter:/<title> metadata out of the first chunk of an HTML page. */
export function parseOpenGraph(html: string, pageUrl: string): Omit<LinkPreview, "url"> | null {
  const head = html.slice(0, MAX_BYTES);
  const meta = new Map<string, string>();
  for (const tag of head.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = new Map<string, string>();
    for (const a of tag[0].matchAll(/([a-zA-Z:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
      attrs.set(a[1]!.toLowerCase(), a[3] ?? a[4] ?? a[5] ?? "");
    }
    const key = (attrs.get("property") ?? attrs.get("name") ?? "").toLowerCase();
    const content = attrs.get("content");
    if (key && content !== undefined && !meta.has(key)) meta.set(key, content);
  }
  const titleTag = /<title[^>]*>([^<]*)<\/title>/i.exec(head)?.[1];
  const title = clip(meta.get("og:title") ?? meta.get("twitter:title") ?? titleTag, 120);
  const description = clip(meta.get("og:description") ?? meta.get("twitter:description") ?? meta.get("description"), 200);
  if (!title && !description) return null;
  let image = "";
  const rawImage = meta.get("og:image") ?? meta.get("og:image:url") ?? meta.get("twitter:image");
  if (rawImage) {
    try {
      const abs = safeHttpUrl(new URL(decodeEntities(rawImage), pageUrl).href);
      if (abs && abs.startsWith("https://") && isPublicUrl(abs)) image = abs;
    } catch {
      /* ignore a malformed image URL */
    }
  }
  const site = clip(meta.get("og:site_name"), 60) || new URL(pageUrl).hostname.replace(/^www\./, "");
  return { site, title: title || site, description, image };
}

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const buf = new Uint8Array(Math.min(total, MAX_BYTES));
  let off = 0;
  for (const c of chunks) {
    const take = Math.min(c.byteLength, buf.byteLength - off);
    buf.set(c.subarray(0, take), off);
    off += take;
    if (off >= buf.byteLength) break;
  }
  return new TextDecoder().decode(buf);
}

/** Fetch + parse a preview; null on any refusal, timeout or non-HTML answer. */
export async function fetchPreview(rawUrl: string): Promise<LinkPreview | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let url = rawUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!isPublicUrl(url)) return null;
      const res = await fetch(url, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": "HypenMessagesLinkPreview/1.0 (+link previews for a chat demo)",
          Accept: "text/html,application/xhtml+xml",
        },
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("Location");
        res.body?.cancel().catch(() => {});
        if (!loc) return null;
        url = new URL(loc, url).href;
        continue;
      }
      if (!res.ok) {
        res.body?.cancel().catch(() => {});
        return null;
      }
      const type = res.headers.get("Content-Type") ?? "";
      if (!/text\/html|application\/xhtml/i.test(type)) {
        res.body?.cancel().catch(() => {});
        return null;
      }
      // Only the first MAX_BYTES are read, whatever Content-Length says.
      const html = await readCapped(res);
      const og = parseOpenGraph(html, url);
      return og ? { url: rawUrl, ...og } : null;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
