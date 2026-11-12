/**
 * Text hygiene and formatting helpers (pure functions, no storage).
 *
 * Escaping: every user string reaches the client as a state VALUE that the
 * DOM renderer writes with `textContent`, and none is ever spliced into the
 * DSL template, so there is no HTML or template injection path to escape
 * for. What we do instead is normalise: strip control and bidi-override
 * characters, collapse runs of blank lines, and enforce length limits. URLs
 * are only ever handed to `Link`/`Image` after `safeHttpUrl` (no
 * `javascript:` / `data:` hrefs).
 */

export const LIMITS = {
  nameMin: 1,
  nameMax: 24,
  roomMin: 2,
  roomMax: 24,
  messageMax: 1000,
  imageBytes: 1024 * 1024, // per image, stored in DO SQLite (< 2 MB row cap)
} as const;

export const PALETTE = [
  "#6366F1", // indigo
  "#EC4899", // pink
  "#F97316", // orange
  "#10B981", // emerald
  "#0EA5E9", // sky
  "#8B5CF6", // violet
  "#EF4444", // red
  "#14B8A6", // teal
] as const;

export const REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🎉"] as const;

// C0/C1 controls except \n and \t, zero-width + bidi overrides (Trojan-source style spoofing).
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/g;

/** Trim, strip control/bidi chars, collapse 3+ newlines; null when empty. */
export function cleanMessage(input: unknown): string | null {
  if (typeof input !== "string") return null;
  let text = input.replace(/\r\n?/g, "\n").replace(CONTROL, "");
  text = text.replace(/\n{3,}/g, "\n\n").trim();
  if (!text) return null;
  if ([...text].length > LIMITS.messageMax) text = [...text].slice(0, LIMITS.messageMax).join("");
  return text;
}

/** Display names: single line, collapsed spaces, 1..24 code points. */
export function cleanName(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const text = input.replace(CONTROL, "").replace(/\s+/g, " ").trim();
  const chars = [...text];
  if (chars.length < LIMITS.nameMin) return null;
  return chars.slice(0, LIMITS.nameMax).join("");
}

/** Room names become slugs: lowercase a-z, 0-9 and dashes, 2..24 chars. */
export function cleanRoomName(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const slug = input
    .toLowerCase()
    .replace(/^#+/, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, LIMITS.roomMax);
  return slug.length >= LIMITS.roomMin ? slug : null;
}

export function isPaletteColor(c: unknown): c is string {
  return typeof c === "string" && (PALETTE as readonly string[]).includes(c);
}

export function initialOf(name: string): string {
  const first = [...name.trim()][0] ?? "?";
  return first.toUpperCase();
}

/** http(s) URL with no credentials, else null. Used for every href/src from user content. */
export function safeHttpUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 2048) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** First http(s) link in a message body. */
export function firstUrl(text: string): string | null {
  const match = /\bhttps?:\/\/[^\s<>"']+/i.exec(text);
  if (!match) return null;
  // Trailing punctuation is almost never part of the link.
  return safeHttpUrl(match[0].replace(/[),.!?;:]+$/, ""));
}

// ---------------------------------------------------------------------------
// Time formatting in the visitor's timezone (from request.cf at connect time)
// ---------------------------------------------------------------------------

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string, opts: Intl.DateTimeFormatOptions, key: string): Intl.DateTimeFormat {
  const k = `${tz}|${key}`;
  let f = fmtCache.get(k);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-US", { ...opts, timeZone: tz });
    } catch {
      f = new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" });
    }
    fmtCache.set(k, f);
  }
  return f;
}

export function clockTime(ms: number, tz: string): string {
  return fmt(tz, { hour: "numeric", minute: "2-digit" }, "clock").format(ms);
}

/** A stable per-day key in the visitor's zone, e.g. "2026-11-12". */
export function dayKey(ms: number, tz: string): string {
  return fmt(tz, { year: "numeric", month: "2-digit", day: "2-digit" }, "day").format(ms);
}

export function dayLabel(ms: number, now: number, tz: string): string {
  const k = dayKey(ms, tz);
  if (k === dayKey(now, tz)) return "Today";
  if (k === dayKey(now - 86_400_000, tz)) return "Yesterday";
  if (now - ms < 6 * 86_400_000) return fmt(tz, { weekday: "long" }, "weekday").format(ms);
  return fmt(tz, { weekday: "short", month: "short", day: "numeric" }, "date").format(ms);
}

/** Conversation-list timestamp: clock time today, weekday this week, else a date. */
export function listTime(ms: number, now: number, tz: string): string {
  if (!ms) return "";
  if (dayKey(ms, tz) === dayKey(now, tz)) return clockTime(ms, tz);
  if (now - ms < 6 * 86_400_000) return fmt(tz, { weekday: "short" }, "wd").format(ms);
  return fmt(tz, { month: "short", day: "numeric" }, "md").format(ms);
}

export function agoLabel(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Image type from magic bytes. Only raster formats; never SVG (scriptable). */
export function sniffImage(bytes: Uint8Array): string | null {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) return "image/webp";
  return null;
}
