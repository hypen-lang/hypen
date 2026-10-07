/**
 * Device Capability Protocol — strict JSON decoding for device messages
 * (RFC 001 §2.1 "JSON limits", decisions D4/D7/D8).
 *
 * `JSON.parse` silently keeps the LAST value of a duplicated key, accepts
 * `1.0`/`1e0`/`-0`, lone surrogate escapes and arbitrary nesting, and costs
 * CPU in proportion to whatever size it is handed. Device messages are
 * untrusted input, so every SDK applies ONE set of limits to the whole
 * message (envelope and `params`/`result`/`event`) and to the handshake
 * objects, from the text, before anything reads it:
 *
 *   - at most 1,048,576 bytes of UTF-8 text, checked BEFORE parsing;
 *   - nesting depth at most 32 containers (`{`/`[`; scalars do not count);
 *   - integer tokens only (`-?(0|[1-9][0-9]*)`): no fraction, exponent,
 *     `-0`, leading zero or `+`; at most 16 digits, magnitude ≤ 2^53−1;
 *   - valid UTF-8 strings with no raw control characters (< 0x20) and no
 *     lone surrogate escapes, in keys AND values;
 *   - duplicate keys (compared after unescaping) rejected at any depth;
 *   - literals exactly `true`/`false`/`null`; no BOM, no trailing data.
 *
 * Text that breaks these limits is attributable to NO request (a
 * connection-level violation: discarded and counted, never terminating the
 * request its id seems to name). A message within the limits whose `type`
 * is a device type and whose `id` is a u32 ≥ 1, but which fails the
 * envelope schema, is a known-id invalid message for that id.
 *
 * Shared corpus: engine-compatibility-tests/fixtures/device/conformance/
 * messages.json (`raw`, `rawHex`, `rawRepeat` and `handshake` cases).
 * The parser is single-pass, iterative in cost (recursion is bounded by the
 * depth limit) and allocation-light, so a hostile 1 MiB message costs one
 * linear scan.
 */

import {
  validateDeviceAck,
  validateDeviceMessage,
  type DeviceLifetime,
  type DeviceMessage,
} from "./generated.js";

/** Maximum device message (and handshake object) text size, UTF-8 bytes. */
export const MAX_DEVICE_MESSAGE_BYTES = 1_048_576;
/** Maximum object/array nesting accepted in a device message. */
export const MAX_DEVICE_JSON_DEPTH = 32;
/** Maximum digits in an integer token (2^53−1 has 16). */
export const MAX_DEVICE_JSON_DIGITS = 16;

export interface StrictJsonOptions {
  /** Size cap in UTF-8 bytes (default 1 MiB). */
  maxBytes?: number;
  /** Container nesting cap (default 32). */
  maxDepth?: number;
}

export type StrictJsonResult = { ok: true; value: unknown } | { ok: false; reason: string };

/**
 * UTF-8 byte length of `text`, or `Infinity` as soon as it exceeds `limit`.
 * A lone surrogate code unit (not encodable as UTF-8) yields `NaN`.
 */
export function utf8ByteLength(text: string, limit: number = Number.POSITIVE_INFINITY): number {
  // Every UTF-16 unit is at least one byte: cheap early exit before the scan.
  if (text.length > limit) return Number.POSITIVE_INFINITY;
  let bytes = 0;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      const d = i + 1 < n ? text.charCodeAt(i + 1) : 0;
      if (d < 0xdc00 || d > 0xdfff) return Number.NaN;
      bytes += 4;
      i += 1;
    } else if (c >= 0xdc00 && c <= 0xdfff) return Number.NaN;
    else bytes += 3;
    if (bytes > limit) return Number.POSITIVE_INFINITY;
  }
  return bytes;
}

/**
 * Whether `text` takes more than `limit` bytes as UTF-8, stopping as soon as
 * it does. A lone surrogate counts 3 bytes (the U+FFFD a UTF-8 encoder
 * substitutes), so the answer is defined for every JS string.
 */
export function exceedsUtf8Bytes(text: string, limit: number): boolean {
  // At most 3 bytes per UTF-16 unit (a surrogate pair is 4 bytes / 2 units).
  if (text.length * 3 <= limit) return false;
  if (text.length > limit) return true; // at least 1 byte per unit
  let bytes = 0;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < n) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else bytes += 3;
    } else bytes += 3;
    if (bytes > limit) return true;
  }
  return false;
}

/**
 * Decode received text-frame bytes as strict UTF-8 (overlong forms, encoded
 * surrogates, truncated sequences and stray bytes are rejected; a BOM is
 * kept so the parser refuses it). Size is checked first.
 */
export function decodeDeviceText(
  bytes: Uint8Array,
  maxBytes: number = MAX_DEVICE_MESSAGE_BYTES
): { ok: true; text: string } | { ok: false; reason: string } {
  if (bytes.byteLength > maxBytes) {
    return { ok: false, reason: `device message larger than ${maxBytes} bytes` };
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return { ok: true, text };
  } catch {
    return { ok: false, reason: "invalid UTF-8" };
  }
}

class StrictJsonError extends Error {}

const fail = (reason: string): never => {
  throw new StrictJsonError(reason);
};

const isHex = (c: number) =>
  (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);

/** Single-pass strict parser over one text (see the module doc). */
class StrictParser {
  private i = 0;
  constructor(
    private readonly s: string,
    private readonly maxDepth: number
  ) {}

  parse(): unknown {
    this.ws();
    const value = this.value(0);
    this.ws();
    if (this.i !== this.s.length) fail(`trailing data at offset ${this.i}`);
    return value;
  }

  private ws(): void {
    const s = this.s;
    while (this.i < s.length) {
      const c = s.charCodeAt(this.i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) this.i += 1;
      else break;
    }
  }

  private value(depth: number): unknown {
    const s = this.s;
    if (this.i >= s.length) fail("unexpected end of text");
    const c = s.charCodeAt(this.i);
    switch (c) {
      case 0x7b /* { */:
        return this.object(depth + 1);
      case 0x5b /* [ */:
        return this.array(depth + 1);
      case 0x22 /* " */:
        return this.string();
      case 0x74 /* t */:
        return this.literal("true", true);
      case 0x66 /* f */:
        return this.literal("false", false);
      case 0x6e /* n */:
        return this.literal("null", null);
      default:
        if (c === 0x2d || (c >= 0x30 && c <= 0x39)) return this.number();
        return fail(`unexpected character at offset ${this.i} (only true/false/null literals)`);
    }
  }

  private literal(word: string, value: unknown): unknown {
    if (this.s.startsWith(word, this.i)) {
      this.i += word.length;
      const next = this.s.charCodeAt(this.i);
      // `truex`, `nullable` … are not literals.
      if (this.i < this.s.length && ((next >= 0x61 && next <= 0x7a) || (next >= 0x41 && next <= 0x5a) || (next >= 0x30 && next <= 0x39))) {
        fail(`invalid literal at offset ${this.i - word.length}`);
      }
      return value;
    }
    return fail(`invalid literal at offset ${this.i} (only true/false/null)`);
  }

  private number(): number {
    const s = this.s;
    const start = this.i;
    let negative = false;
    if (s.charCodeAt(this.i) === 0x2d) {
      negative = true;
      this.i += 1;
    }
    const digitsStart = this.i;
    const first = s.charCodeAt(this.i);
    if (!(first >= 0x30 && first <= 0x39)) fail(`invalid number at offset ${start}`);
    if (first === 0x30) {
      this.i += 1;
      const next = s.charCodeAt(this.i);
      if (next >= 0x30 && next <= 0x39) fail(`leading zero at offset ${start}`);
    } else {
      while (this.i < s.length) {
        const d = s.charCodeAt(this.i);
        if (d < 0x30 || d > 0x39) break;
        this.i += 1;
        // Stop early: never scan (or big-number parse) a million digits.
        if (this.i - digitsStart > MAX_DEVICE_JSON_DIGITS) {
          fail(`integer with more than ${MAX_DEVICE_JSON_DIGITS} digits at offset ${start}`);
        }
      }
    }
    const next = s.charCodeAt(this.i);
    if (next === 0x2e || next === 0x65 || next === 0x45) {
      fail(`non-integer number at offset ${start} (integer tokens only)`);
    }
    if (negative && this.i - digitsStart === 1 && first === 0x30) fail(`-0 at offset ${start}`);
    const value = Number(s.slice(start, this.i));
    if (!Number.isSafeInteger(value)) fail(`integer magnitude above 2^53-1 at offset ${start}`);
    return value;
  }

  private string(): string {
    const s = this.s;
    this.i += 1; // opening quote
    let out = "";
    let runStart = this.i;
    for (;;) {
      if (this.i >= s.length) fail("unterminated string");
      const c = s.charCodeAt(this.i);
      if (c === 0x22) {
        out += s.slice(runStart, this.i);
        this.i += 1;
        return out;
      }
      if (c < 0x20) fail(`raw control character 0x${c.toString(16)} in a string at offset ${this.i}`);
      if (c >= 0xd800 && c <= 0xdfff) {
        // A raw surrogate must be a well-formed pair (valid UTF-8 text).
        const d = s.charCodeAt(this.i + 1);
        if (c > 0xdbff || !(d >= 0xdc00 && d <= 0xdfff)) fail(`invalid UTF-8 (lone surrogate) at offset ${this.i}`);
        this.i += 2;
        continue;
      }
      if (c !== 0x5c) {
        this.i += 1;
        continue;
      }
      out += s.slice(runStart, this.i);
      const e = s.charCodeAt(this.i + 1);
      switch (e) {
        case 0x22: out += '"'; break;
        case 0x5c: out += "\\"; break;
        case 0x2f: out += "/"; break;
        case 0x62: out += "\b"; break;
        case 0x66: out += "\f"; break;
        case 0x6e: out += "\n"; break;
        case 0x72: out += "\r"; break;
        case 0x74: out += "\t"; break;
        case 0x75 /* u */: {
          const unit = this.hex4(this.i + 2);
          if (unit >= 0xdc00 && unit <= 0xdfff) fail(`lone surrogate escape at offset ${this.i}`);
          if (unit >= 0xd800 && unit <= 0xdbff) {
            // Must be immediately followed by a low-surrogate escape.
            if (s.charCodeAt(this.i + 6) !== 0x5c || s.charCodeAt(this.i + 7) !== 0x75) {
              fail(`lone surrogate escape at offset ${this.i}`);
            }
            const low = this.hex4(this.i + 8);
            if (low < 0xdc00 || low > 0xdfff) fail(`lone surrogate escape at offset ${this.i}`);
            out += String.fromCharCode(unit, low);
            this.i += 12;
          } else {
            out += String.fromCharCode(unit);
            this.i += 6;
          }
          runStart = this.i;
          continue;
        }
        default:
          fail(`invalid escape at offset ${this.i}`);
      }
      this.i += 2;
      runStart = this.i;
    }
  }

  private hex4(at: number): number {
    const s = this.s;
    let v = 0;
    for (let k = 0; k < 4; k++) {
      const c = s.charCodeAt(at + k);
      if (!isHex(c)) fail(`invalid \\u escape at offset ${at - 2}`);
      v = v * 16 + parseInt(s[at + k]!, 16);
    }
    return v;
  }

  private object(depth: number): Record<string, unknown> {
    if (depth > this.maxDepth) fail(`nesting deeper than ${this.maxDepth}`);
    this.i += 1; // {
    const out: Record<string, unknown> = {};
    const keys = new Set<string>();
    this.ws();
    if (this.s.charCodeAt(this.i) === 0x7d) {
      this.i += 1;
      return out;
    }
    for (;;) {
      this.ws();
      if (this.s.charCodeAt(this.i) !== 0x22) fail(`expected a key at offset ${this.i}`);
      const key = this.string();
      if (keys.has(key)) fail(`duplicate key ${JSON.stringify(key)}`);
      keys.add(key);
      this.ws();
      if (this.s.charCodeAt(this.i) !== 0x3a) fail(`expected ':' at offset ${this.i}`);
      this.i += 1;
      this.ws();
      const value = this.value(depth);
      if (key === "__proto__") {
        // An own data property, exactly as JSON.parse creates it — never the prototype.
        Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
      } else {
        out[key] = value;
      }
      this.ws();
      const c = this.s.charCodeAt(this.i);
      if (c === 0x2c) {
        this.i += 1;
        continue;
      }
      if (c === 0x7d) {
        this.i += 1;
        return out;
      }
      fail(`expected ',' or '}' at offset ${this.i}`);
    }
  }

  private array(depth: number): unknown[] {
    if (depth > this.maxDepth) fail(`nesting deeper than ${this.maxDepth}`);
    this.i += 1; // [
    const out: unknown[] = [];
    this.ws();
    if (this.s.charCodeAt(this.i) === 0x5d) {
      this.i += 1;
      return out;
    }
    for (;;) {
      this.ws();
      out.push(this.value(depth));
      this.ws();
      const c = this.s.charCodeAt(this.i);
      if (c === 0x2c) {
        this.i += 1;
        continue;
      }
      if (c === 0x5d) {
        this.i += 1;
        return out;
      }
      fail(`expected ',' or ']' at offset ${this.i}`);
    }
  }
}

/**
 * Parse device JSON text under the RFC 001 §2.1 limits. The size limit is
 * checked before any parsing. Never throws.
 */
export function parseStrictDeviceJson(text: string, options: StrictJsonOptions = {}): StrictJsonResult {
  const maxBytes = options.maxBytes ?? MAX_DEVICE_MESSAGE_BYTES;
  const size = utf8ByteLength(text, maxBytes);
  if (Number.isNaN(size)) return { ok: false, reason: "invalid UTF-8 (lone surrogate)" };
  if (size > maxBytes) return { ok: false, reason: `device message larger than ${maxBytes} bytes` };
  try {
    const value = new StrictParser(text, options.maxDepth ?? MAX_DEVICE_JSON_DEPTH).parse();
    return { ok: true, value };
  } catch (err) {
    if (err instanceof StrictJsonError) return { ok: false, reason: err.message };
    // RangeError from a pathological input — still a limits violation.
    return { ok: false, reason: "unparseable device JSON" };
  }
}

/**
 * The JSON limits for an already-parsed value (a caller that was handed a
 * value, not text): depth, integer-only safe numbers without `-0`, no lone
 * surrogates in keys or strings. Text-only rules (duplicate keys, number
 * spellings, raw control characters, size) need the text.
 */
export function checkJsonValue(value: unknown, maxDepth: number = MAX_DEVICE_JSON_DEPTH): string | null {
  const walk = (v: unknown, depth: number): string | null => {
    if (v === null || typeof v === "boolean") return null;
    if (typeof v === "number") {
      if (!Number.isSafeInteger(v)) return `non-integer or out-of-range number ${String(v)}`;
      if (Object.is(v, -0)) return "-0";
      return null;
    }
    if (typeof v === "string") return hasLoneSurrogate(v) ? "lone surrogate in a string" : null;
    if (typeof v !== "object") return `non-JSON value of type ${typeof v}`;
    if (depth + 1 > maxDepth) return `nesting deeper than ${maxDepth}`;
    if (Array.isArray(v)) {
      for (const item of v) {
        const r = walk(item, depth + 1);
        if (r) return r;
      }
      return null;
    }
    for (const key of Object.keys(v)) {
      if (hasLoneSurrogate(key)) return "lone surrogate in a key";
      const r = walk((v as Record<string, unknown>)[key], depth + 1);
      if (r) return r;
    }
    return null;
  };
  return walk(value, 0);
}

function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) return true;
      i += 1;
    } else if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

/**
 * Locate a top-level member's raw value text in a JSON object text that
 * `JSON.parse` already accepted (e.g. `hello.device` inside a UI `hello`),
 * so the member alone can be strictly decoded. Keys compare after
 * unescaping; a duplicated member is an error (the endpoints would disagree
 * about which one counts). Linear, no allocation beyond the keys.
 */
export function findTopLevelMember(
  text: string,
  member: string
): { found: false } | { found: true; raw: string } | { found: false; error: string } {
  const n = text.length;
  let i = 0;
  const skipWs = () => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i += 1;
      else break;
    }
  };
  const skipString = () => {
    i += 1;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 0x5c) i += 2;
      else if (c === 0x22) {
        i += 1;
        return;
      } else i += 1;
    }
  };
  const skipValue = () => {
    const c = text.charCodeAt(i);
    if (c === 0x22) {
      skipString();
      return;
    }
    if (c === 0x7b || c === 0x5b) {
      let depth = 0;
      while (i < n) {
        const d = text.charCodeAt(i);
        if (d === 0x22) {
          skipString();
          continue;
        }
        i += 1;
        if (d === 0x7b || d === 0x5b) depth += 1;
        else if ((d === 0x7d || d === 0x5d) && --depth === 0) return;
      }
      return;
    }
    // Scalar: runs to the next delimiter or whitespace.
    while (i < n) {
      const d = text.charCodeAt(i);
      if (d === 0x2c || d === 0x7d || d === 0x5d || d === 0x20 || d === 0x09 || d === 0x0a || d === 0x0d) return;
      i += 1;
    }
  };
  skipWs();
  if (text.charCodeAt(i) !== 0x7b) return { found: false, error: "not an object" };
  i += 1;
  let raw: string | null = null;
  // A key whose raw text is shorter than the member's or longer than its
  // fully `\uXXXX`-escaped form cannot unescape to it: it is skipped
  // without being unescaped, so a huge key never reaches `JSON.parse`.
  const minKeyRaw = member.length + 2;
  const maxKeyRaw = member.length * 6 + 2;
  for (;;) {
    skipWs();
    const c = text.charCodeAt(i);
    if (c === 0x7d || i >= n) break;
    if (c === 0x2c) {
      i += 1;
      continue;
    }
    if (c !== 0x22) return { found: false, error: "malformed object" };
    const keyStart = i;
    skipString();
    let key: string | null = null;
    if (i - keyStart >= minKeyRaw && i - keyStart <= maxKeyRaw) {
      try {
        key = JSON.parse(text.slice(keyStart, i)) as string;
      } catch {
        return { found: false, error: "malformed key" };
      }
    }
    skipWs();
    if (text.charCodeAt(i) !== 0x3a) return { found: false, error: "malformed object" };
    i += 1;
    skipWs();
    const valueStart = i;
    skipValue();
    if (key === member) {
      if (raw !== null) return { found: false, error: `duplicate ${JSON.stringify(member)} member` };
      raw = text.slice(valueStart, i);
    }
  }
  return raw === null ? { found: false } : { found: true, raw };
}

/** Longest raw spelling of a device `type` value (fully `\uXXXX`-escaped). */
const MAX_DEVICE_TYPE_RAW = "deviceResponse".length * 6 + 2;

/**
 * Whether `text` is a device message over the RFC 001 §2.1 size limit,
 * decided WITHOUT parsing it (decision D4: the limit is checked before
 * parsing). Only a text whose UTF-8 size exceeds `limit` is inspected, with
 * the linear top-level scan of `findTopLevelMember` — so `type` is found
 * wherever it sits among the members and whatever whitespace precedes it,
 * and an escaped spelling (`"device\u0045vent"`) is recognised too.
 * An over-limit text that cannot be scanned (malformed, or with a duplicated
 * `type`) counts as device text: it is hostile, and parsing it is exactly
 * the cost the limit exists to avoid. Linear time; `JSON.parse` only ever
 * sees key and `type` spellings of a few dozen characters.
 */
export function isOversizeDeviceText(text: string, limit: number = MAX_DEVICE_MESSAGE_BYTES): boolean {
  if (!exceedsUtf8Bytes(text, limit)) return false;
  return isDeviceTypedText(text);
}

/**
 * Whether a text message belongs to the device plane, decided by the same
 * linear top-level scan as {@link isOversizeDeviceText} and BEFORE (instead
 * of) `JSON.parse`, so a host routes it by what was sent rather than by
 * what a lenient parser makes of it: its top-level `type` names a device
 * message (`deviceRequest`, `deviceResponse`, `deviceEvent`, escaped
 * spellings included), or the text cannot be scanned as one JSON object
 * with a single `type` (malformed, not an object, a duplicated or malformed
 * `type`). The latter is hostile on a device connection — endpoints would
 * disagree about what it is — so it goes to the broker too, whose strict
 * decode counts it as a connection-level violation (decision D4/D8).
 * A well-formed UI message (`type` a non-device string) or one without
 * `type` is not device text.
 */
export function isDeviceTypedText(text: string): boolean {
  const member = findTopLevelMember(text, "type");
  if (!member.found) return "error" in member;
  const raw = member.raw;
  if (raw.length > MAX_DEVICE_TYPE_RAW || raw.charCodeAt(0) !== 0x22) return false;
  try {
    return DEVICE_TYPES.has(JSON.parse(raw) as string);
  } catch {
    return true; // a malformed `type` string: unscannable, as above
  }
}

export type DeviceDecodeResult =
  | { ok: true; message: DeviceMessage }
  | {
      ok: false;
      /**
       * The message's id when the failure is attributable (decision D8): the
       * text is within the JSON limits, `type` is a device type and `id` is a
       * u32 ≥ 1. `null` = connection-level (JSON limits broken, or no clean
       * device type/id): discard and count, never terminate a request.
       */
      id: number | null;
      /** The attributed message's `type` (when `id` is set), else null. */
      type: "deviceRequest" | "deviceResponse" | "deviceEvent" | null;
      /** True when the JSON limits (not the schema) rejected the message. */
      limits: boolean;
      reason: string;
    };

const DEVICE_TYPES = new Set(["deviceRequest", "deviceResponse", "deviceEvent"]);

/** A known-id attribution: a device `type` and an integer `id` in 1..2^32−1. */
export function attributableId(value: unknown): number | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const own = (k: string) => Object.prototype.hasOwnProperty.call(value, k);
  if (!own("type") || !own("id")) return null;
  const type = (value as { type: unknown }).type;
  if (typeof type !== "string" || !DEVICE_TYPES.has(type)) return null;
  const id = (value as { id: unknown }).id;
  return typeof id === "number" && Number.isInteger(id) && id >= 1 && id <= 0xffff_ffff ? id : null;
}

/**
 * Strictly decode one device envelope message: text is parsed under the
 * JSON limits (a parsed value gets the value-level subset), then validated
 * against envelope-v1 and the rules no schema expresses (owner/lifetime).
 * Never throws.
 */
export function decodeDeviceMessage(input: unknown): DeviceDecodeResult {
  let value: unknown = input;
  if (typeof input === "string") {
    const parsed = parseStrictDeviceJson(input);
    if (!parsed.ok) return { ok: false, id: null, type: null, limits: true, reason: parsed.reason };
    value = parsed.value;
  } else if (input instanceof Uint8Array) {
    const text = decodeDeviceText(input);
    if (!text.ok) return { ok: false, id: null, type: null, limits: true, reason: text.reason };
    return decodeDeviceMessage(text.text);
  } else {
    const limits = checkJsonValue(input);
    if (limits) return { ok: false, id: null, type: null, limits: true, reason: limits };
  }
  const violations = validateDeviceMessage(value);
  if (violations.length > 0) {
    const id = attributableId(value);
    return {
      ok: false,
      id,
      type: id === null ? null : ((value as { type: DeviceMessage["type"] }).type),
      limits: false,
      reason: describeViolations(violations),
    };
  }
  const message = value as DeviceMessage;
  if (message.type === "deviceRequest" && !ownerMatchesLifetime(message.owner, message.lifetime)) {
    return {
      ok: false,
      id: message.id,
      type: message.type,
      limits: false,
      reason: `owner shape does not match lifetime ${message.lifetime}`,
    };
  }
  return { ok: true, message };
}

/**
 * Strictly decode `sessionAck.device`, the only handshake object a CLIENT
 * decodes (RFC 001 §2.2, D7): JSON limits (text) or their value-level subset
 * (parsed value), the handshake-v1 schema, and unique capability names
 * (exact code points). Never throws. A server's side of the handshake — the
 * untrusted `hello.device` and `core.capabilities` snapshots — is decoded by
 * the Rust broker (`DeviceBrokerFactory.negotiate`, the broker's `onText`).
 */
export function decodeDeviceAck(
  input: unknown
): { ok: true; value: unknown } | { ok: false; reason: string } {
  let value: unknown = input;
  if (typeof input === "string") {
    const parsed = parseStrictDeviceJson(input);
    if (!parsed.ok) return { ok: false, reason: parsed.reason };
    value = parsed.value;
  } else {
    const limits = checkJsonValue(input);
    if (limits) return { ok: false, reason: limits };
  }
  const violations = validateDeviceAck(value);
  if (violations.length > 0) return { ok: false, reason: describeViolations(violations) };
  const names = (value as { capabilities: Array<{ name: string }> }).capabilities.map((c) => c.name);
  if (new Set(names).size !== names.length) return { ok: false, reason: "duplicate capability name" };
  return { ok: true, value };
}

/**
 * Owner shape per lifetime (RFC 001 §2.7) — not expressible in the envelope
 * schema, enforced by every decoder: `activation` ⇒ `{moduleInstanceId,
 * activationId}`, `background` ⇒ `{moduleInstanceId}`, `connection` ⇒
 * `{connection: true}`.
 */
export function ownerMatchesLifetime(owner: unknown, lifetime: DeviceLifetime): boolean {
  if (typeof owner !== "object" || owner === null) return false;
  const has = (k: string) => Object.prototype.hasOwnProperty.call(owner, k);
  switch (lifetime) {
    case "activation":
      return has("moduleInstanceId") && has("activationId");
    case "background":
      return has("moduleInstanceId") && !has("activationId");
    case "connection":
      return has("connection");
    default:
      return false;
  }
}

/** A bounded, human-readable summary of schema violations. */
export function describeViolations(violations: ReadonlyArray<{ path: string; message: string }>): string {
  return violations
    .slice(0, 4)
    .map((v) => `${v.path}: ${v.message}`)
    .join("; ")
    .slice(0, 512);
}
