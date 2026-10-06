/**
 * Negotiated WebSocket extensions vs the device plane (RFC 001 §2.3).
 *
 * permessage-deflate is compatible with the device plane only when every
 * message is compressed on its own: the NEGOTIATED extension must carry both
 * `server_no_context_takeover` and `client_no_context_takeover` (RFC 7692
 * §7.1.1). Then device data never shares a DEFLATE history with any other
 * message (the CRIME/BREACH concern is cross-message context). With context
 * takeover in either direction the connection stays UI-only.
 *
 * Shared by the web client (`WebSocket.extensions`) and the Cloudflare
 * Durable Object (its server socket's negotiated extensions).
 */

/** One extension from a `Sec-WebSocket-Extensions` value. */
export interface WebSocketExtension {
  /** Extension token, lower-cased. */
  name: string;
  /** Parameters by lower-cased name; `null` for a parameter without a value. */
  params: Map<string, string | null>;
  /** A parameter name appeared twice (invalid for permessage-deflate). */
  duplicateParam: boolean;
}

/**
 * How a negotiated `Sec-WebSocket-Extensions` value compresses:
 *
 * - `"none"` — no compression extension (absent or empty value);
 * - `"per-message"` — permessage-deflate with no context takeover in both
 *   directions: each message is compressed on its own;
 * - `"context-takeover"` — anything else that compresses (a missing
 *   no-context-takeover parameter, a malformed value, or an unrecognised
 *   deflate-style extension). Fail closed.
 */
export type DeflateContextPolicy = "none" | "per-message" | "context-takeover";

/**
 * Split a header value on `sep` outside quoted strings (RFC 7230
 * quoted-string, backslash escapes). Returns null on an unterminated quote.
 */
function splitOutsideQuotes(value: string, sep: string): string[] | null {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (quoted) {
      current += ch;
      if (ch === "\\" && i + 1 < value.length) {
        current += value[++i]!;
      } else if (ch === '"') {
        quoted = false;
      }
    } else if (ch === '"') {
      quoted = true;
      current += ch;
    } else if (ch === sep) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (quoted) return null;
  parts.push(current);
  return parts;
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  return value;
}

/**
 * Parse a `Sec-WebSocket-Extensions` value into its extensions (names and
 * parameter names lower-cased). Returns null for a malformed value (an
 * unterminated quoted string or an empty extension name).
 */
export function parseWebSocketExtensions(value: string): WebSocketExtension[] | null {
  const items = splitOutsideQuotes(value, ",");
  if (items === null) return null;
  const out: WebSocketExtension[] = [];
  for (const item of items) {
    if (item.trim() === "") continue; // tolerate `a, , b` and a trailing comma
    const segments = splitOutsideQuotes(item, ";");
    if (segments === null) return null;
    const name = segments[0]!.trim().toLowerCase();
    if (name === "") return null;
    const params = new Map<string, string | null>();
    let duplicateParam = false;
    for (const raw of segments.slice(1)) {
      const seg = raw.trim();
      if (seg === "") continue;
      const eq = seg.indexOf("=");
      const key = (eq < 0 ? seg : seg.slice(0, eq)).trim().toLowerCase();
      if (key === "") return null;
      const val = eq < 0 ? null : unquote(seg.slice(eq + 1).trim());
      if (params.has(key)) duplicateParam = true;
      params.set(key, val);
    }
    out.push({ name, params, duplicateParam });
  }
  return out;
}

/**
 * Classify a negotiated `Sec-WebSocket-Extensions` value (e.g. a browser's
 * `WebSocket.extensions`). Anything that is not a string counts as "no
 * extensions reported" (`"none"`).
 */
export function deflateContextPolicy(extensions: unknown): DeflateContextPolicy {
  if (typeof extensions !== "string" || extensions.trim() === "") return "none";
  const parsed = parseWebSocketExtensions(extensions);
  if (parsed === null) return "context-takeover";
  let compressed = false;
  for (const ext of parsed) {
    if (ext.name === "permessage-deflate") {
      compressed = true;
      // RFC 7692 §7.1.1: both parameters carry no value; a value or a
      // repeated parameter makes the negotiation invalid — fail closed.
      const perMessage =
        !ext.duplicateParam &&
        ext.params.has("server_no_context_takeover") &&
        ext.params.get("server_no_context_takeover") === null &&
        ext.params.has("client_no_context_takeover") &&
        ext.params.get("client_no_context_takeover") === null;
      if (!perMessage) return "context-takeover";
    } else if (ext.name.includes("deflate") || ext.name.includes("compress")) {
      // e.g. the legacy `x-webkit-deflate-frame`: a compression extension
      // whose context behaviour we do not model.
      return "context-takeover";
    }
  }
  return compressed ? "per-message" : "none";
}

/**
 * Whether a connection with these negotiated extensions may carry the device
 * plane: uncompressed, or permessage-deflate with no context takeover in
 * both directions.
 */
export function deviceSafeExtensions(extensions: unknown): boolean {
  return deflateContextPolicy(extensions) !== "context-takeover";
}
