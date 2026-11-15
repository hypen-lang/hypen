// Deferred HTTP (`hypen:http/deferred`): the value types, the request
// bounds, the URL grammar, the `httpHosts` allowlist and the completion
// payload — the TypeScript port of `hypen-engine-rs/src/module_host/http.rs`.
//
// Why a port and not a call into the engine: the JS module host answers the
// guest's `send` synchronously, from inside a reducer call the engine is
// already running — it cannot call back into the engine there. The native
// host validates at `send` with the Rust code; this file gives a guest the
// same answers on a JS host. The engine re-checks every request it is handed
// (a bridged host is not trusted), so a disagreement between the two is a
// wrong *message*, never a request that should not have been made — but the
// two must still agree, and `tests/http-parity.test.ts` pins this file to the
// Rust unit tests case by case.
//
// Everything here is plain data and pure functions: no I/O, no host state.
//
// # One parser
//
// A URL is parsed once, by `parseHttpUrl`, and the allowlist is matched
// against *that* parse. The grammar is a strict subset of what any HTTP
// stack accepts (ASCII only, no userinfo, no backslashes, no numeric-host
// spellings other than a canonical dotted quad), so a second parser
// downstream — `fetch`'s, a proxy's — cannot read a different host out of
// the same string. Do not match hosts with string operations at use sites.

// ── bounds ──────────────────────────────────────────────────────────────────
//
// Each constant is the Rust constant of the same name in
// `hypen-engine-rs/src/module_host/http.rs` (and, for the in-flight default,
// the value the WIT documents). `tests/http-parity.test.ts` reads the Rust
// source and fails when one of them changes there and not here.

/** `MAX_HTTP_REQUESTS_PER_CALL`: most requests one guest call may queue. */
export const MAX_HTTP_REQUESTS_PER_CALL = 16;
/** `MAX_HTTP_URL_BYTES`: longest request URL, in bytes. */
export const MAX_HTTP_URL_BYTES = 8 * 1024;
/** `MAX_HTTP_HEADERS`: most request headers. */
export const MAX_HTTP_HEADERS = 64;
/** `MAX_HTTP_HEADER_BYTES`: most bytes of request header names + values together. */
export const MAX_HTTP_HEADER_BYTES = 16 * 1024;
/** `MAX_HTTP_BODY_BYTES`: largest request body, in bytes. */
export const MAX_HTTP_BODY_BYTES = 1024 * 1024;
/** `MAX_HTTP_METHOD_BYTES`: longest method, in bytes. */
export const MAX_HTTP_METHOD_BYTES = 32;
/** `MAX_HTTP_NAME_BYTES`: longest completion action name and longest tag, in bytes. */
export const MAX_HTTP_NAME_BYTES = 256;
/** `DEFAULT_HTTP_TIMEOUT_MS`: time budget of a request that names none. */
export const DEFAULT_HTTP_TIMEOUT_MS = 30_000;
/** `MAX_HTTP_TIMEOUT_MS`: longest time budget; larger values are clamped. */
export const MAX_HTTP_TIMEOUT_MS = 120_000;
/** `MAX_HTTP_RESPONSE_BODY_BYTES`: largest response body delivered to a module. */
export const MAX_HTTP_RESPONSE_BODY_BYTES = 4 * 1024 * 1024;
/** `MAX_HTTP_REDIRECTS`: most redirects an embedder follows for one request. */
export const MAX_HTTP_REDIRECTS = 5;
/** `DEFAULT_HTTP_IN_FLIGHT_PER_MODULE`: default cap on requests one module may have in flight. */
export const DEFAULT_HTTP_IN_FLIGHT_PER_MODULE = 32;

// ── small shared pieces ─────────────────────────────────────────────────────

/** The outcome of a parse: the value, or why the input is not one. */
export type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const err = <T = never>(error: string): Parsed<T> => ({ ok: false, error });

const encoder = new TextEncoder();
/** Length in UTF-8 bytes — what Rust's `str::len` counts. */
const utf8Length = (s: string): number => encoder.encode(s).length;

/**
 * A short, printable rendering of guest text for an error message — Rust's
 * `shown()`: the first 64 characters, each through `char::escape_default`,
 * then `…` when there were more.
 */
export function shown(s: string): string {
  const MAX = 64;
  let out = "";
  let count = 0;
  for (const ch of s) {
    if (count === MAX) return out + "…";
    count += 1;
    out += escapeDefault(ch);
  }
  return out;
}

function escapeDefault(ch: string): string {
  switch (ch) {
    case "\t":
      return "\\t";
    case "\r":
      return "\\r";
    case "\n":
      return "\\n";
    case "'":
      return "\\'";
    case '"':
      return '\\"';
    case "\\":
      return "\\\\";
  }
  const code = ch.codePointAt(0) ?? 0;
  return code >= 0x20 && code <= 0x7e ? ch : `\\u{${code.toString(16)}}`;
}

const isAsciiAlphanumeric = (c: number): boolean =>
  (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
const isAsciiDigit = (c: number): boolean => c >= 0x30 && c <= 0x39;

const everyCode = (s: string, pred: (code: number) => boolean): boolean => {
  for (let i = 0; i < s.length; i++) if (!pred(s.charCodeAt(i))) return false;
  return true;
};

const TOKEN_PUNCTUATION = "!#$%&'*+-.^_`|~";
/** RFC 9110 `tchar`: what a method and a header name are made of. */
const isTokenCode = (c: number): boolean => isAsciiAlphanumeric(c) || (c < 0x80 && TOKEN_PUNCTUATION.includes(String.fromCharCode(c)));
const isToken = (s: string): boolean => s.length > 0 && everyCode(s, isTokenCode);

const equalsIgnoreAsciiCase = (a: string, b: string): boolean => a.length === b.length && asciiLower(a) === asciiLower(b);
/** ASCII-only lowercasing (`to_ascii_lowercase`): never touches other scripts. */
const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

// ── IP literals ─────────────────────────────────────────────────────────────

/** An IP literal host, decoded. */
export type IpAddress =
  | { readonly version: 4; readonly octets: readonly [number, number, number, number] }
  /** Eight 16-bit groups. */
  | { readonly version: 6; readonly segments: readonly number[] };

/** `Ipv4Addr::from_str`: exactly four decimal octets, no leading zeros. */
function parseIpv4(s: string): [number, number, number, number] | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (part.length === 0 || part.length > 3 || !everyCode(part, isAsciiDigit)) return null;
    if (part.length > 1 && part[0] === "0") return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets as [number, number, number, number];
}

/**
 * `Ipv6Addr::from_str`: up to eight groups of 1-4 hex digits, at most one
 * `::` (standing for at least one zero group), optionally ending in a dotted
 * quad. No zone id.
 */
function parseIpv6(s: string): number[] | null {
  const groups = (part: string, allowTrailingIpv4: boolean): number[] | null => {
    if (part === "") return [];
    const pieces = part.split(":");
    const out: number[] = [];
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i]!;
      if (allowTrailingIpv4 && i === pieces.length - 1 && piece.includes(".")) {
        const v4 = parseIpv4(piece);
        if (!v4) return null;
        out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null;
      out.push(parseInt(piece, 16));
    }
    return out;
  };
  const gap = s.indexOf("::");
  if (gap < 0) {
    const all = groups(s, true);
    return all !== null && all.length === 8 ? all : null;
  }
  const head = groups(s.slice(0, gap), false);
  const tail = groups(s.slice(gap + 2), true);
  if (head === null || tail === null || head.length + tail.length > 7) return null;
  return [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail];
}

/** `Ipv6Addr`'s `Display`: RFC 5952, with `::ffff:a.b.c.d` for IPv4-mapped. */
function formatIpv6(segments: readonly number[]): string {
  if (segments.slice(0, 5).every((g) => g === 0) && segments[5] === 0xffff) {
    const [hi, lo] = [segments[6]!, segments[7]!];
    return `::ffff:${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  // The first longest run of two or more zero groups is compressed.
  let best = { start: -1, len: 0 };
  let run = { start: -1, len: 0 };
  segments.forEach((g, i) => {
    if (g === 0) {
      if (run.len === 0) run = { start: i, len: 0 };
      run.len += 1;
      if (run.len > best.len) best = { ...run };
    } else {
      run = { start: -1, len: 0 };
    }
  });
  const hex = (part: readonly number[]): string => part.map((g) => g.toString(16)).join(":");
  if (best.len > 1) {
    return `${hex(segments.slice(0, best.start))}::${hex(segments.slice(best.start + best.len))}`;
  }
  return hex(segments);
}

// ── host names ──────────────────────────────────────────────────────────────

/** A canonical host: what `HttpUrl.host` holds and what a pattern is compared with. */
interface HostName {
  /** Lowercase DNS name, dotted-quad IPv4, or bracketed IPv6 (`[::1]`). */
  readonly text: string;
  /** The address when the host is an IP literal, else `null`. */
  readonly ip: IpAddress | null;
}

function parseHostName(host: string): Parsed<HostName> {
  if (host === "") return err("the host is empty");
  if (host.startsWith("[")) {
    if (!host.endsWith("]")) return err("unterminated '[' in the host");
    const inner = host.slice(1, -1);
    const segments = parseIpv6(inner);
    if (!segments) return err(`'${shown(inner)}' is not an IPv6 address`);
    return ok({ text: `[${formatIpv6(segments)}]`, ip: { version: 6, segments } });
  }
  if (utf8Length(host) > 253) return err("the host is longer than 253 bytes");
  const lower = asciiLower(host);
  const labels = lower.split(".");
  for (const label of labels) {
    const valid =
      label.length > 0 &&
      label.length <= 63 &&
      everyCode(label, (c) => isAsciiAlphanumeric(c) || c === 0x2d /* - */ || c === 0x5f /* _ */);
    if (!valid) {
      return err(
        `'${shown(lower)}' is not a host name (labels of letters, digits, '-' and '_' ` +
          "separated by single dots)",
      );
    }
  }
  // A host whose last label is numeric is an IPv4 address to every URL
  // parser — but they disagree on the spellings (`127.1`, `0x7f.0.0.1`,
  // `2130706433`). Only the canonical dotted quad is accepted.
  const last = labels[labels.length - 1] ?? "";
  const numeric =
    everyCode(last, isAsciiDigit) || (last.startsWith("0x") && last.length > 2 && /^[0-9a-f]+$/.test(last.slice(2)));
  if (numeric) {
    const octets = parseIpv4(lower);
    if (!octets) {
      return err(`'${shown(lower)}' looks like an IPv4 address but is not a dotted quad (a.b.c.d)`);
    }
    return ok({ text: octets.join("."), ip: { version: 4, octets } });
  }
  return ok({ text: lower, ip: null });
}

/** Split `host`, `host:port`, `[v6]` or `[v6]:port`. */
function splitHostPort(authority: string): Parsed<{ host: string; port: string | null }> {
  if (authority.startsWith("[")) {
    const end = authority.indexOf("]");
    if (end < 0) return err("unterminated '[' in the host");
    const host = authority.slice(0, end + 1);
    const rest = authority.slice(end + 1);
    if (rest.startsWith(":")) return ok({ host, port: rest.slice(1) });
    if (rest === "") return ok({ host, port: null });
    return err(`unexpected '${shown(rest)}' after the IPv6 address`);
  }
  const colon = authority.indexOf(":");
  return colon < 0
    ? ok({ host: authority, port: null })
    : ok({ host: authority.slice(0, colon), port: authority.slice(colon + 1) });
}

function parsePort(port: string): Parsed<number> {
  const valid = port.length > 0 && port.length <= 5 && everyCode(port, isAsciiDigit);
  const value = valid ? Number(port) : 0;
  return value >= 1 && value <= 65535 ? ok(value) : err(`'${shown(port)}' is not a port (1-65535)`);
}

// ── URLs ────────────────────────────────────────────────────────────────────

export type HttpScheme = "http" | "https";

const defaultPort = (scheme: HttpScheme): number => (scheme === "https" ? 443 : 80);

/**
 * A parsed absolute `http`/`https` URL: where to connect and what to ask
 * for. Only {@link parseHttpUrl} and {@link joinHttpUrl} make one.
 */
export interface HttpUrl {
  readonly scheme: HttpScheme;
  /** Canonical: a lowercase DNS name, a dotted-quad IPv4 address or a bracketed IPv6 address. */
  readonly host: string;
  /** The address when `host` is an IP literal, else `null`. */
  readonly ip: IpAddress | null;
  /** The port to connect to (the scheme's default when the URL names none). */
  readonly port: number;
  /** Path and query: starts with `/`, never contains a fragment. */
  readonly pathAndQuery: string;
  /** `host` or `host:port` — the port is left out when it is the scheme's default. */
  readonly authority: string;
  /** `scheme://authority/path?query` (Rust's `Display`). No fragment. */
  readonly href: string;
}

const TARGET_PUNCTUATION = "-._~!$&'()*+,;=:@/?%[]";
/** RFC 3986 path / query characters plus the square brackets query strings commonly carry. */
const isTargetCode = (c: number): boolean =>
  isAsciiAlphanumeric(c) || (c < 0x80 && TARGET_PUNCTUATION.includes(String.fromCharCode(c)));

function makeUrl(scheme: HttpScheme, host: HostName, port: number, pathAndQuery: string): HttpUrl {
  const authority = port === defaultPort(scheme) ? host.text : `${host.text}:${port}`;
  return {
    scheme,
    host: host.text,
    ip: host.ip,
    port,
    pathAndQuery,
    authority,
    href: `${scheme}://${authority}${pathAndQuery}`,
  };
}

/**
 * `HttpUrl::parse`. The error is the Rust `InvalidUrl`'s `Display`
 * (`invalid url: …`).
 */
export function parseHttpUrl(url: string): Parsed<HttpUrl> {
  const invalid = (why: string): Parsed<HttpUrl> => err(`invalid url: ${why}`);
  // Rust checks bytes: any non-ASCII character has a UTF-8 lead byte >= 0xc2.
  const bytes = encoder.encode(url);
  const bad = bytes.find((b) => b < 0x21 || b > 0x7e);
  if (bad !== undefined) {
    return invalid(
      `contains a space, control or non-ASCII character (byte 0x${bad.toString(16).padStart(2, "0")}); ` +
        "percent-encode it (internationalized hosts in punycode)",
    );
  }
  let scheme: HttpScheme;
  let rest: string;
  if (equalsIgnoreAsciiCase(url.slice(0, 8), "https://")) {
    scheme = "https";
    rest = url.slice(8);
  } else if (equalsIgnoreAsciiCase(url.slice(0, 7), "http://")) {
    scheme = "http";
    rest = url.slice(7);
  } else {
    return invalid("must be absolute and start with http:// or https://");
  }

  const found = rest.search(/[/?#]/);
  const authorityEnd = found < 0 ? rest.length : found;
  const authority = rest.slice(0, authorityEnd);
  const after = rest.slice(authorityEnd);
  if (authority.includes("@")) {
    return invalid("credentials in the URL (user:pass@host) are not allowed; send an Authorization header");
  }
  const split = splitHostPort(authority);
  if (!split.ok) return invalid(split.error);
  const host = parseHostName(split.value.host);
  if (!host.ok) return invalid(host.error);
  let port = defaultPort(scheme);
  if (split.value.port !== null) {
    const parsed = parsePort(split.value.port);
    if (!parsed.ok) return invalid(parsed.error);
    port = parsed.value;
  }

  // The fragment never leaves the client.
  const hash = after.indexOf("#");
  const target = hash < 0 ? after : after.slice(0, hash);
  for (let i = 0; i < target.length; i++) {
    if (!isTargetCode(target.charCodeAt(i))) {
      return invalid(`path or query contains '${escapeDefault(target[i]!)}'; percent-encode it`);
    }
  }
  // `http://host?query` and `http://host`.
  return ok(makeUrl(scheme, host.value, port, target.startsWith("/") ? target : `/${target}`));
}

/**
 * `HttpUrl::join`: resolve a `Location` header value against `base` — an
 * absolute `http(s)` URL, a scheme-relative one (`//host/path`), an absolute
 * path, or a path relative to `base`'s. Dot segments are sent as written.
 */
export function joinHttpUrl(base: HttpUrl, location: string): Parsed<HttpUrl> {
  const trimmed = location.replace(/^[ \t]+|[ \t]+$/g, "");
  if (trimmed === "") return err("invalid url: empty redirect location");
  if (trimmed.startsWith("//")) return parseHttpUrl(`${base.scheme}:${trimmed}`);
  // `scheme:` before any `/`, `?` or `#` makes it absolute.
  const schemeEnd = trimmed.search(/[:/?#]/);
  if (schemeEnd >= 0 && trimmed[schemeEnd] === ":") return parseHttpUrl(trimmed);
  const origin = `${base.scheme}://${base.authority}`;
  if (trimmed.startsWith("/")) return parseHttpUrl(`${origin}${trimmed}`);
  const path = base.pathAndQuery.split("?")[0] ?? "/";
  if (trimmed.startsWith("?")) return parseHttpUrl(`${origin}${path}${trimmed}`);
  if (trimmed.startsWith("#")) return ok(base);
  // Relative path: replace everything after the last `/` of the base path.
  const dir = path.slice(0, path.lastIndexOf("/") + 1);
  return parseHttpUrl(`${origin}${dir}${trimmed}`);
}

// ── the allowlist ───────────────────────────────────────────────────────────

/**
 * One entry of a manifest's `httpHosts` allowlist, parsed:
 *
 * | pattern | matches |
 * |---|---|
 * | `api.example.com` | that host, any port |
 * | `api.example.com:8443` | that host on that port |
 * | `*.example.com` | every subdomain of `example.com` at any depth — **not** `example.com` itself |
 * | `127.0.0.1:8080`, `[::1]` | an IP literal |
 *
 * Hosts compare case-insensitively. A pattern never carries a scheme or a path.
 */
export type HostPattern =
  | { readonly kind: "exact"; readonly host: string; readonly port: number | null }
  /** `suffix` is what a subdomain ends with, leading dot included (`.example.com`). */
  | { readonly kind: "subdomains"; readonly suffix: string; readonly port: number | null };

/**
 * `HostPattern::from_str`. The error is the Rust `InvalidHostPattern`'s
 * `Display`: it names the pattern, what is wrong and the expected forms.
 */
export function parseHostPattern(pattern: string): Parsed<HostPattern> {
  const invalid = (why: string): Parsed<HostPattern> =>
    err(
      `invalid host pattern '${shown(pattern)}': ${why} (expected \`host\`, \`*.domain\`, or either with \`:port\`)`,
    );
  if (pattern === "") return invalid("it is empty");
  if (pattern.includes("://")) return invalid("a pattern names a host, not a URL — drop the scheme");
  if (/[/?#@]/.test(pattern)) {
    return invalid("a pattern names a host, not a URL — drop the path, query and credentials");
  }
  const split = splitHostPort(pattern);
  if (!split.ok) return invalid(split.error);
  let port: number | null = null;
  if (split.value.port !== null) {
    const parsed = parsePort(split.value.port);
    if (!parsed.ok) return invalid(parsed.error);
    port = parsed.value;
  }
  const host = split.value.host;
  if (host.startsWith("*.")) {
    const domain = parseHostName(host.slice(2));
    if (!domain.ok) return invalid(domain.error);
    if (domain.value.ip !== null) return invalid("a wildcard needs a domain name, not an address");
    return ok({ kind: "subdomains", suffix: `.${domain.value.text}`, port });
  }
  if (host === "*") {
    return invalid("a bare `*` is not a pattern — leave the allowlist empty to allow any host");
  }
  if (host.includes("*")) {
    return invalid("`*` is only allowed as the whole first label (`*.example.com`)");
  }
  const exact = parseHostName(host);
  if (!exact.ok) return invalid(exact.error);
  return ok({ kind: "exact", host: exact.value.text, port });
}

/** The canonical pattern string (Rust's `Display`); round-trips through {@link parseHostPattern}. */
export function formatHostPattern(pattern: HostPattern): string {
  const host = pattern.kind === "exact" ? pattern.host : `*${pattern.suffix}`;
  return pattern.port === null ? host : `${host}:${pattern.port}`;
}

/** Whether a canonical host (an {@link HttpUrl}'s `host`) on `port` matches. */
export function hostPatternMatches(pattern: HostPattern, host: string, port: number): boolean {
  if (pattern.port !== null && pattern.port !== port) return false;
  return pattern.kind === "exact"
    ? pattern.host === host
    : host.length > pattern.suffix.length && host.endsWith(pattern.suffix);
}

/** What a module's manifest lets it reach over HTTP (`http` + `httpHosts`). */
export type HttpGrant =
  /** `http` is not granted: no request may be made. */
  | { readonly kind: "denied" }
  /** `http: true` with no `httpHosts`: any host. */
  | { readonly kind: "anyHost" }
  /** `http: true` with `httpHosts`: only hosts matching one of these. */
  | { readonly kind: "hosts"; readonly patterns: readonly HostPattern[] };

/** Why a grant refuses a host. */
export type HttpDenial =
  | { readonly kind: "notGranted" }
  /** `host` is `host:port`. */
  | { readonly kind: "hostNotAllowed"; readonly host: string };

/** Rust's `HttpDenial` `Display`. */
export function formatHttpDenial(denial: HttpDenial): string {
  return denial.kind === "notGranted"
    ? "the manifest does not grant `http`"
    : `host '${denial.host}' is not in the manifest's \`httpHosts\` allowlist`;
}

/** `HttpGrant::check`: `null` when a request to `url` is allowed. */
export function checkHttpGrant(grant: HttpGrant, url: HttpUrl): HttpDenial | null {
  return checkHost(grant, url.host, url.port);
}

function checkHost(grant: HttpGrant, host: string, port: number): HttpDenial | null {
  switch (grant.kind) {
    case "denied":
      return { kind: "notGranted" };
    case "anyHost":
      return null;
    case "hosts":
      return grant.patterns.some((p) => hostPatternMatches(p, host, port))
        ? null
        : { kind: "hostNotAllowed", host: `${host}:${port}` };
  }
}

/**
 * `HttpGrant::check_authority`: the check for a host that did not come out
 * of {@link parseHttpUrl} (the authority of a blocking `wasi:http` request).
 * With an allowlist the host is canonicalized first and one outside the
 * grammar matches nothing; without one, any host passes.
 */
export function checkHttpAuthority(grant: HttpGrant, host: string, port: number): HttpDenial | null {
  if (grant.kind !== "hosts") return checkHost(grant, host, port);
  const parsed = parseHostName(host);
  return parsed.ok
    ? checkHost(grant, parsed.value.text, port)
    : { kind: "hostNotAllowed", host: `${shown(host)}:${port}` };
}

/**
 * {@link checkHttpAuthority} for an authority string as `wasi:http` carries
 * it (`host`, `host:port`, `[v6]:port`) under `scheme`. An authority that
 * cannot be split, or whose port is not one, matches nothing under an
 * allowlist.
 */
export function checkHttpAuthorityText(grant: HttpGrant, scheme: HttpScheme, authority: string): HttpDenial | null {
  if (grant.kind !== "hosts") return checkHost(grant, authority, defaultPort(scheme));
  const refused: HttpDenial = { kind: "hostNotAllowed", host: shown(authority) };
  const split = splitHostPort(authority);
  if (!split.ok) return refused;
  let port = defaultPort(scheme);
  if (split.value.port !== null) {
    const parsed = parsePort(split.value.port);
    if (!parsed.ok) return refused;
    port = parsed.value;
  }
  return checkHttpAuthority(grant, split.value.host, port);
}

/**
 * The grant a manifest's `http` / `httpHosts` describe
 * (`ModuleManifest::http_grant`). `httpHosts` is strict where the other
 * manifest lists are lenient, because for this one "dropped" means "wider":
 * an empty allowlist is *any host*. So anything that is not a list of valid
 * patterns is an error, and so is an allowlist without `http: true`.
 */
export function httpGrantOf(http: boolean, httpHosts: unknown, module = ""): Parsed<HttpGrant> {
  const of = module ? ` of module '${module}'` : "";
  if (httpHosts === undefined || httpHosts === null) {
    return ok(http ? { kind: "anyHost" } : { kind: "denied" });
  }
  if (!Array.isArray(httpHosts)) {
    return err(`manifest.httpHosts${of} must be a list of host patterns, e.g. ["api.example.com", "*.example.org"]`);
  }
  const patterns: HostPattern[] = [];
  for (const entry of httpHosts as unknown[]) {
    if (typeof entry !== "string") {
      return err(`manifest.httpHosts${of} must be a list of host patterns (strings); got ${JSON.stringify(entry) ?? typeof entry}`);
    }
    const parsed = parseHostPattern(entry);
    if (!parsed.ok) return err(`manifest.httpHosts${of}: ${parsed.error}`);
    const text = formatHostPattern(parsed.value);
    if (!patterns.some((p) => formatHostPattern(p) === text)) patterns.push(parsed.value);
  }
  if (patterns.length === 0) return ok(http ? { kind: "anyHost" } : { kind: "denied" });
  if (!http) {
    return err(
      `manifest.httpHosts${of} narrows the \`http\` grant, but \`http\` is not true for this module ` +
        '— add `"http": true`, or remove `httpHosts`',
    );
  }
  return ok({ kind: "hosts", patterns });
}

// ── requests ────────────────────────────────────────────────────────────────

/** The WIT `request`, as jco hands it to the import (and as the engine's `HttpRequestWire` reads it). */
export interface HttpRequest {
  method: string;
  url: string;
  /** `[name, value]` pairs, in order. */
  headers: Array<[string, string]>;
  /** `undefined` / `null`: no body. */
  body?: Uint8Array | null;
  /** Time budget in milliseconds; absent = {@link DEFAULT_HTTP_TIMEOUT_MS}. */
  timeoutMs?: number | null;
}

/** One `hypen:http/deferred.send` call: what the reducer output carries in `httpRequests`. */
export interface QueuedHttpRequest {
  request: HttpRequest;
  /** The action dispatched to the calling module when the request completes. */
  then: string;
  /** Echoed back in the completion payload. */
  tag?: string | null;
}

/** The WIT `error` variant, in jco's representation (thrown by the import). */
export type HttpRequestError =
  | { tag: "permission-denied"; val: string }
  | { tag: "invalid-request"; val: string }
  | { tag: "limit-exceeded"; val: string };

const HOST_OWNED_HEADERS = [
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  "keep-alive",
  "upgrade",
  "te",
  "trailer",
  "expect",
] as const;

/** Whether `name` (any case) is a header only the host may set. */
export function isHostOwnedHeader(name: string): boolean {
  const lower = asciiLower(name);
  return (HOST_OWNED_HEADERS as readonly string[]).includes(lower) || lower.startsWith("proxy-");
}

function checkMethod(method: string): string | null {
  if (utf8Length(method) > MAX_HTTP_METHOD_BYTES || !isToken(method)) {
    return `method '${shown(method)}' is not an HTTP token of at most ${MAX_HTTP_METHOD_BYTES} bytes`;
  }
  // Methods that are not request/response exchanges with the origin.
  if (["CONNECT", "TRACE", "TRACK"].some((m) => equalsIgnoreAsciiCase(method, m))) {
    return `method '${method}' is not allowed`;
  }
  return null;
}

function checkHeader(name: string, value: string): string | null {
  if (!isToken(name)) return `header name '${shown(name)}' is not an HTTP token`;
  if (isHostOwnedHeader(name)) return `header '${name}' is set by the host and cannot be sent by a module`;
  // Visible ASCII, space and tab: no CR/LF/NUL (header injection), and
  // nothing a `Headers` object would reject or re-encode.
  if (!everyCode(value, (c) => c === 0x09 || (c >= 0x20 && c <= 0x7e))) {
    return `value of header '${name}' contains a control or non-ASCII character`;
  }
  return null;
}

/** The time budget an embedder applies: defaulted and clamped (`effective_timeout_ms`). */
export function effectiveTimeoutMs(timeoutMs: number | null | undefined): number {
  return Math.min(timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS, MAX_HTTP_TIMEOUT_MS);
}

/**
 * `QueuedHttpRequest::validate`: everything about a request that does not
 * depend on a grant — method, URL, headers, body, timeout, completion action,
 * tag — in the Rust order, with the Rust messages. Returns the parsed URL.
 */
export function validateQueuedHttpRequest(
  queued: QueuedHttpRequest,
): { ok: true; url: HttpUrl } | { ok: false; error: HttpRequestError } {
  const invalid = (val: string) => ({ ok: false as const, error: { tag: "invalid-request" as const, val } });
  const limit = (val: string) => ({ ok: false as const, error: { tag: "limit-exceeded" as const, val } });
  const { request, then, tag } = queued;

  const method = checkMethod(request.method);
  if (method !== null) return invalid(method);

  const urlBytes = utf8Length(request.url);
  if (urlBytes > MAX_HTTP_URL_BYTES) {
    return limit(`url of ${urlBytes} bytes exceeds the ${MAX_HTTP_URL_BYTES}-byte limit`);
  }
  const url = parseHttpUrl(request.url);
  if (!url.ok) return invalid(url.error);

  if (request.headers.length > MAX_HTTP_HEADERS) {
    return limit(`${request.headers.length} headers exceed the limit of ${MAX_HTTP_HEADERS}`);
  }
  const headerBytes = request.headers.reduce((sum, [n, v]) => sum + utf8Length(n) + utf8Length(v), 0);
  if (headerBytes > MAX_HTTP_HEADER_BYTES) {
    return limit(`headers of ${headerBytes} bytes exceed the ${MAX_HTTP_HEADER_BYTES}-byte limit`);
  }
  for (const [name, value] of request.headers) {
    const problem = checkHeader(name, value);
    if (problem !== null) return invalid(problem);
  }

  if (request.body && request.body.length > MAX_HTTP_BODY_BYTES) {
    return limit(`body of ${request.body.length} bytes exceeds the ${MAX_HTTP_BODY_BYTES}-byte limit`);
  }
  if (request.timeoutMs === 0) {
    return invalid("timeout-ms is 0; omit it for the default or give a positive budget");
  }

  if (then === "") return invalid("`then` is empty; name the action that receives the completion");
  const thenBytes = utf8Length(then);
  if (thenBytes > MAX_HTTP_NAME_BYTES) {
    return limit(`\`then\` of ${thenBytes} bytes exceeds the ${MAX_HTTP_NAME_BYTES}-byte limit`);
  }
  if (tag !== undefined && tag !== null) {
    const tagBytes = utf8Length(tag);
    if (tagBytes > MAX_HTTP_NAME_BYTES) {
      return limit(`tag of ${tagBytes} bytes exceeds the ${MAX_HTTP_NAME_BYTES}-byte limit`);
    }
  }
  return { ok: true, url: url.value };
}

// ── the per-call queue ──────────────────────────────────────────────────────

/** `send`'s answer outside a call that returns a reducer output (the native host's wording). */
export const NOT_IN_A_REDUCER_CALL =
  "http: requests can only be queued from `dispatch`, `on-activated` or " +
  "`on-deactivated` (this export returns no reducer output to carry one)";

/**
 * The requests one guest call queues — the native host's `DeferredHttpCtx`
 * while `Active`. `send` validates, allowlist-checks and bounds; a refused
 * request is not queued.
 */
export class DeferredHttpQueue {
  readonly #grant: HttpGrant;
  readonly #queued: QueuedHttpRequest[] = [];

  constructor(grant: HttpGrant) {
    this.#grant = grant;
  }

  /** Validate and queue one request; the error is what the guest is told. */
  send(queued: QueuedHttpRequest): HttpRequestError | null {
    const valid = validateQueuedHttpRequest(queued);
    if (!valid.ok) return valid.error;
    const denial = checkHttpGrant(this.#grant, valid.url);
    if (denial !== null) return { tag: "permission-denied", val: formatHttpDenial(denial) };
    if (this.#queued.length >= MAX_HTTP_REQUESTS_PER_CALL) {
      return { tag: "limit-exceeded", val: `too many requests in one call (limit ${MAX_HTTP_REQUESTS_PER_CALL})` };
    }
    this.#queued.push(queued);
    return null;
  }

  /** What the call queued, in order. */
  drain(): QueuedHttpRequest[] {
    return this.#queued.splice(0);
  }
}

// ── completion ──────────────────────────────────────────────────────────────

/** The `error.kind` of a failed completion (`HttpFailureKind`). */
export type HttpFailureKind = "network" | "timeout" | "denied" | "too-large" | "invalid-response";

export const HTTP_FAILURE_KINDS: readonly HttpFailureKind[] = [
  "network",
  "timeout",
  "denied",
  "too-large",
  "invalid-response",
];

/** How a request ended, as the embedder reports it (`HttpOutcome`). */
export type HttpOutcome =
  /** An HTTP response was read — whatever its status. Headers as received: any case, repeats allowed. */
  | { ok: true; status: number; headers: Array<[string, string]>; body: Uint8Array }
  /** No response. */
  | { ok: false; error: { kind: HttpFailureKind; message: string } };

/**
 * The completion action's payload — the JSON documented at the top of
 * `wit/deps/hypen-http/http.wit` — as a module receives it.
 */
export type HttpCompletion =
  | {
      ok: true;
      status: number;
      /** Names lowercased; a header sent more than once is joined with `", "`. */
      headers: Record<string, string>;
      body: string;
      /** `"utf8"`: `body` is the text; `"base64"`: the bytes were not UTF-8. */
      bodyEncoding: "utf8" | "base64";
      tag: string | null;
    }
  | { ok: false; error: { kind: HttpFailureKind; message: string }; tag: string | null };

/** Standard base64 (RFC 4648 §4, padded). */
export function base64Encode(bytes: Uint8Array): string {
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += ALPHABET[(n >> 18) & 0x3f]! + ALPHABET[(n >> 12) & 0x3f]!;
    out += i + 1 < bytes.length ? ALPHABET[(n >> 6) & 0x3f]! : "=";
    out += i + 2 < bytes.length ? ALPHABET[n & 0x3f]! : "=";
  }
  return out;
}

/**
 * `HttpOutcome::into_payload`: the completion payload for `outcome`.
 *
 * An embedder with an engine never needs this — `completeHttpRequest` builds
 * the payload. It is for a host that drives a `JsModuleHost` directly (a
 * browser page acting as its own embedder) and dispatches `then` itself.
 *
 * A response the contract cannot carry becomes the matching failure: a body
 * over {@link MAX_HTTP_RESPONSE_BODY_BYTES} is `too-large`, a status outside
 * 100–999 is `invalid-response`.
 */
export function httpCompletionPayload(outcome: HttpOutcome, tag: string | null | undefined): HttpCompletion {
  const echoed = tag ?? null;
  if (!outcome.ok) return { ok: false, error: { ...outcome.error }, tag: echoed };
  if (outcome.body.length > MAX_HTTP_RESPONSE_BODY_BYTES) {
    return {
      ok: false,
      error: {
        kind: "too-large",
        message: `response body of ${outcome.body.length} bytes exceeds the ${MAX_HTTP_RESPONSE_BODY_BYTES}-byte limit`,
      },
      tag: echoed,
    };
  }
  if (!Number.isInteger(outcome.status) || outcome.status < 100 || outcome.status > 999) {
    return {
      ok: false,
      error: { kind: "invalid-response", message: `status ${outcome.status} is not an HTTP status code` },
      tag: echoed,
    };
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of outcome.headers) {
    const key = asciiLower(name);
    headers[key] = Object.prototype.hasOwnProperty.call(headers, key) ? `${headers[key]}, ${value}` : value;
  }
  let body: string;
  let bodyEncoding: "utf8" | "base64";
  try {
    body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(outcome.body);
    bodyEncoding = "utf8";
  } catch {
    body = base64Encode(outcome.body);
    bodyEncoding = "base64";
  }
  return { ok: true, status: outcome.status, headers, body, bodyEncoding, tag: echoed };
}
