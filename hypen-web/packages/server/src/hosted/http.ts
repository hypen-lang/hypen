/**
 * Deferred HTTP (`hypen:http/deferred`) for hosted modules on a server:
 * performing the requests the engine admitted.
 *
 * A hosted reducer queues a request; the engine hands it to the session's
 * effect handler as `{ type: "http", id, request, … }`; this file performs it
 * with `fetch` and reports how it ended, which the session passes to
 * `engine.completeHttpRequest`. It is the TypeScript counterpart of
 * `hypen-engine-rs/src/bin/hypen_runtime/http.rs` (the native runtime's
 * embedder) and follows it rule for rule:
 *
 * - redirects are followed here (`redirect: "manual"`), at most
 *   `MAX_HTTP_REDIRECTS`, and the module's `httpHosts` allowlist is asked
 *   again for every hop;
 * - credentials (`Authorization`, `Cookie`) do not follow a request to
 *   another origin; 303 (and 301/302 for POST) turn it into a body-less GET;
 * - the whole exchange runs under the request's time budget;
 * - the response body is read as a stream and abandoned the moment it passes
 *   `MAX_HTTP_RESPONSE_BODY_BYTES`;
 * - every way of not getting a response is one of the contract's five kinds.
 *
 * What a server adds on top (the native runtime is a developer's own
 * machine; a server runs modules next to other people's infrastructure):
 * an egress policy, evaluated before the first request and before every
 * redirect hop — see {@link HttpEgressPolicy}.
 *
 * Nothing here touches the engine or a session: `performHttpRequest` takes
 * the effect and what it needs as functions, so it is testable on its own.
 */

import {
  MAX_HTTP_REDIRECTS,
  MAX_HTTP_RESPONSE_BODY_BYTES,
  joinHttpUrl,
  parseHostPattern,
  parseHttpUrl,
  type HttpFailureKind,
  type HttpUrl,
  type IpAddress,
} from "@hypen-space/core/http";
import type { HostedModuleHttpEffect, HttpCompletionResult } from "@hypen-space/core/types";

/**
 * Most deferred HTTP exchanges in progress per session; further requests
 * wait in a FIFO. The native runtime's `MAX_CONCURRENT_REQUESTS`
 * (`hypen_runtime/http.rs`).
 */
export const DEFAULT_MAX_CONCURRENT_HTTP_REQUESTS = 8;

/** Sent when the module names no `User-Agent`; some servers refuse requests without one. */
const USER_AGENT = "hypen-server";

// ── what an app can plug in ─────────────────────────────────────────────────

/** What {@link HostedFetch} is called with: always these fields, never more. */
export interface HostedFetchInit {
  method: string;
  /** `[name, value]` pairs, in the module's order. */
  headers: Array<[string, string]>;
  /** `null`: no body. */
  body: Uint8Array | null;
  /** Always `"manual"`: redirects are followed (and checked) by the server. */
  redirect: "manual";
  /** Aborted when the request's time budget runs out or the session ends. */
  signal: AbortSignal;
}

/**
 * The function that performs one hop. The default is the runtime's `fetch`;
 * replace it (`hostedModules({ fetch })`) to go through a proxy or an agent,
 * to pin DNS, or to fake the network in tests. It must not follow redirects
 * itself: return the 3xx response and the server follows it.
 */
export type HostedFetch = (url: string, init: HostedFetchInit) => Promise<Response>;

/** What kind of address a request is going to, as far as its URL says. */
export type HttpTargetNetwork =
  /** A DNS name (other than `localhost`) or a public address. */
  | "public"
  /** `127.0.0.0/8`, `::1`, `localhost`, `*.localhost`. */
  | "loopback"
  /** `169.254.0.0/16`, `fe80::/10` (cloud metadata services live here). */
  | "linkLocal"
  /** `10/8`, `172.16/12`, `192.168/16`, `100.64/10`, `fc00::/7`, `fec0::/10`. */
  | "private"
  /** `0.0.0.0/8`, `::`. */
  | "unspecified";

/** One request (or redirect hop) a hosted module is about to make. */
export interface HostedHttpRequestInfo {
  /** The module's name as declared (`Weather`). */
  module: string;
  /** Its engine scope (`weather`). */
  scope: string;
  method: string;
  /** The URL about to be requested (for a hop: the redirect target). */
  url: string;
  scheme: "http" | "https";
  /** Canonical host: lowercase name, dotted quad, or bracketed IPv6. */
  host: string;
  port: number;
  /**
   * Where the URL points, judged from the URL alone: an IP literal by its
   * range, `localhost` by name. A DNS name is `"public"` whatever it
   * resolves to — resolve and pin it yourself (`fetch`) if that matters.
   */
  network: HttpTargetNetwork;
  /** 0 for the request the module queued, 1.. for redirect hops. */
  hop: number;
}

export interface HostedHttpRequestContext {
  /** The session the module runs on. */
  sessionId: string;
  /** The module's `httpHosts` allowlist (canonical pattern strings); `null` = any host. */
  allowedHosts: readonly string[] | null;
  /** The action that will receive the completion. */
  then: string;
  tag: string | null;
}

/** An egress decision: let the request go, or refuse it and say why. */
export type HttpEgressDecision = "allow" | { deny: string };

/**
 * App-level egress policy (`hostedModules({ onHttpRequest })`): called before
 * each request and each redirect hop, after the module's own allowlist and
 * the private-network rule let it through. It can only narrow — returning
 * `"allow"` does not override either of those. A denied request completes to
 * the module as `ok: false`, `error.kind: "denied"`, with the reason as the
 * message. If it throws, the request is denied.
 */
export type HttpEgressPolicy = (
  request: HostedHttpRequestInfo,
  context: HostedHttpRequestContext
) => HttpEgressDecision;

// ── the private-network rule ────────────────────────────────────────────────

function ipv4Network(o: readonly number[]): HttpTargetNetwork {
  const [a = 0, b = 0] = o;
  if (a === 127) return "loopback";
  if (a === 0) return "unspecified";
  if (a === 169 && b === 254) return "linkLocal";
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "private";
  // RFC 6598 shared address space (carrier-grade NAT; also used inside clouds).
  if (a === 100 && b >= 64 && b <= 127) return "private";
  return "public";
}

function ipNetwork(ip: IpAddress): HttpTargetNetwork {
  if (ip.version === 4) return ipv4Network(ip.octets);
  const s = ip.segments;
  const embedded = (): HttpTargetNetwork =>
    ipv4Network([(s[6] ?? 0) >> 8, (s[6] ?? 0) & 0xff, (s[7] ?? 0) >> 8, (s[7] ?? 0) & 0xff]);
  const leadingZeros = s.slice(0, 5).every((g) => g === 0);
  // IPv4-mapped (`::ffff:a.b.c.d`) and NAT64 (`64:ff9b::/96`) reach the IPv4
  // address they embed.
  if (leadingZeros && s[5] === 0xffff) return embedded();
  if (s[0] === 0x64 && s[1] === 0xff9b && s.slice(2, 6).every((g) => g === 0)) return embedded();
  if (leadingZeros && s[5] === 0) {
    if (s[6] === 0 && s[7] === 1) return "loopback";
    if (s[6] === 0 && s[7] === 0) return "unspecified";
  }
  const first = s[0] ?? 0;
  if ((first & 0xffc0) === 0xfe80) return "linkLocal";
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfec0) return "private";
  return "public";
}

/** Where `url` points, judged from the URL alone (see {@link HostedHttpRequestInfo.network}). */
export function httpTargetNetwork(url: HttpUrl): HttpTargetNetwork {
  if (url.ip !== null) return ipNetwork(url.ip);
  return url.host === "localhost" || url.host.endsWith(".localhost") ? "loopback" : "public";
}

/**
 * Whether the module's allowlist names `url`'s host *explicitly*: an exact
 * entry for that host (with a matching port, when the entry has one). A
 * wildcard never counts — `*.internal` is not a decision about `10.0.0.5`.
 */
export function httpHostsNameExplicitly(allowedHosts: readonly string[] | null, url: HttpUrl): boolean {
  for (const text of allowedHosts ?? []) {
    const pattern = parseHostPattern(text);
    if (!pattern.ok || pattern.value.kind !== "exact") continue;
    if (pattern.value.host === url.host && (pattern.value.port === null || pattern.value.port === url.port)) {
      return true;
    }
  }
  return false;
}

// ── one exchange ────────────────────────────────────────────────────────────

/** What refused a request that was denied, for diagnostics. */
export type HttpRefusedBy = "httpHosts" | "privateNetwork" | "policy";

/** How one request ended: the completion for the engine, plus what diagnostics need. */
export interface PerformedHttpRequest {
  result: HttpCompletionResult;
  /** The URL being requested when it ended (the last hop). */
  url: string;
  /** Set when the request was refused rather than failed. */
  refusedBy?: HttpRefusedBy;
  /** For `refusedBy: "httpHosts" | "privateNetwork"`: the `host:port` to allow. */
  refusedHost?: string;
}

export interface PerformHttpOptions {
  fetch: HostedFetch;
  module: string;
  scope: string;
  sessionId: string;
  /** `"block"` (default): see {@link HostedHttpRequestInfo.network} and `httpHostsNameExplicitly`. */
  privateNetwork: "block" | "allow";
  policy?: HttpEgressPolicy;
  /** The engine's `httpRedirectAllowed(id, url)`: the module's allowlist, for a redirect hop. */
  redirectAllowed(url: string): boolean;
  /** Aborted when the session ends. */
  signal: AbortSignal;
}

const errorText = (err: unknown): string =>
  err instanceof Error ? err.message || err.name : typeof err === "string" ? err : String(err);

function failure(kind: HttpFailureKind, message: string): HttpCompletionResult {
  return { ok: false, error: { kind, message } };
}

/** Whether what `fetch` threw says the peer did not speak HTTP (vs. could not be reached). */
function isMalformedResponse(err: unknown): boolean {
  const code = String((err as { code?: unknown } | null)?.code ?? "");
  const cause = (err as { cause?: { code?: unknown } } | null)?.cause;
  const causeCode = String(cause?.code ?? "");
  const name = err instanceof Error ? err.name : "";
  return (
    /^HPE_/.test(code) ||
    /^HPE_/.test(causeCode) ||
    name === "HTTPParserError" ||
    /Malformed_HTTP_Response|InvalidHTTPResponse|malformed http|invalid http|parse error/i.test(
      `${code} ${causeCode} ${errorText(err)}`
    )
  );
}

const equalsIgnoreCase = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

class TooLarge extends Error {}

/** Read `response`'s body, giving up as soon as it passes the cap. */
async function readCapped(response: Response): Promise<Uint8Array> {
  // A declared length over the cap is refused before reading any of it —
  // unless the body is content-encoded, where the header counts the encoded
  // bytes and says nothing about what will be read.
  const declared = Number(response.headers.get("content-length") ?? "");
  if (!response.headers.has("content-encoding") && Number.isFinite(declared) && declared > MAX_HTTP_RESPONSE_BODY_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new TooLarge();
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_HTTP_RESPONSE_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      throw new TooLarge();
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * Perform `effect`'s request and say how it ended. Never rejects, and never
 * takes longer than the request's time budget (unless `options.fetch`
 * ignores its abort signal).
 */
export async function performHttpRequest(
  effect: HostedModuleHttpEffect,
  options: PerformHttpOptions
): Promise<PerformedHttpRequest> {
  const budgetMs = effect.request.timeoutMs;
  const timedOut = new AbortController();
  const timer = setTimeout(() => timedOut.abort(), budgetMs);
  const signal = AbortSignal.any([timedOut.signal, options.signal]);
  let current = effect.request.url;
  const timeout = (): PerformedHttpRequest => ({
    result: failure("timeout", `no complete response within ${budgetMs} ms`),
    url: current,
  });

  try {
    // The engine validated this URL at admission with the same grammar.
    const first = parseHttpUrl(effect.request.url);
    if (!first.ok) return { result: failure("network", `the request could not be built (${first.error})`), url: current };
    let url = first.value;
    let method = effect.request.method;
    let headers = effect.request.headers.map(([name, value]): [string, string] => [name, value]);
    let body = effect.request.body;

    for (let hop = 0; hop <= MAX_HTTP_REDIRECTS; hop++) {
      current = url.href;
      const refused = egressRefusal(effect, options, url, method, hop);
      if (refused) return { ...refused, url: current };

      const sent = headers.some(([name]) => equalsIgnoreCase(name, "user-agent"))
        ? headers
        : [...headers, ["user-agent", USER_AGENT] as [string, string]];
      let response: Response;
      try {
        response = await options.fetch(url.href, { method, headers: sent, body, redirect: "manual", signal });
      } catch (err) {
        if (timedOut.signal.aborted) return timeout();
        return {
          result: isMalformedResponse(err)
            ? failure("invalid-response", `the HTTP exchange with ${url.authority} failed: ${errorText(err)}`)
            : failure("network", `requesting ${url.authority} failed: ${errorText(err)}`),
          url: current,
        };
      }

      const location = [301, 302, 303, 307, 308].includes(response.status) ? response.headers.get("location") : null;
      if (location === null) {
        let bytes: Uint8Array;
        try {
          bytes = await readCapped(response);
        } catch (err) {
          if (err instanceof TooLarge) {
            return {
              result: failure("too-large", `the response body exceeds ${MAX_HTTP_RESPONSE_BODY_BYTES} bytes`),
              url: current,
            };
          }
          if (timedOut.signal.aborted) return timeout();
          return {
            result: isMalformedResponse(err)
              ? failure("invalid-response", `the HTTP exchange with ${url.authority} failed: ${errorText(err)}`)
              : failure("network", `reading the response from ${url.authority} failed: ${errorText(err)}`),
            url: current,
          };
        }
        return {
          result: { ok: true, status: response.status, headers: [...response.headers], body: bytes },
          url: current,
        };
      }

      // A redirect: its body is of no interest.
      await response.body?.cancel().catch(() => {});
      if (hop === MAX_HTTP_REDIRECTS) {
        return {
          result: failure("invalid-response", `more than ${MAX_HTTP_REDIRECTS} redirects (last: ${url.href})`),
          url: current,
        };
      }
      const next = joinHttpUrl(url, location);
      if (!next.ok) {
        return {
          result: failure(
            "invalid-response",
            `${url.href} redirected to a location that cannot be requested: ${next.error}`
          ),
          url: current,
        };
      }
      // The allowlist holds for wherever the request ends up, not only for
      // where it started. The engine answers: it holds the parsed patterns.
      if (!options.redirectAllowed(next.value.href)) {
        return {
          result: failure(
            "denied",
            `redirect from ${url.href} to ${next.value.href} refused: host ` +
              `'${next.value.host}:${next.value.port}' is not in the manifest's \`httpHosts\` allowlist`
          ),
          url: next.value.href,
          refusedBy: "httpHosts",
          refusedHost: `${next.value.host}:${next.value.port}`,
        };
      }

      const sameOrigin =
        next.value.scheme === url.scheme && next.value.host === url.host && next.value.port === url.port;
      if (!sameOrigin) {
        // Credentials meant for the first origin do not follow the request.
        headers = headers.filter(
          ([name]) => !equalsIgnoreCase(name, "authorization") && !equalsIgnoreCase(name, "cookie")
        );
      }
      // 303 always, and 301/302 for POST (what every client does), turn the
      // request into a body-less GET; 307/308 repeat it as it was.
      const toGet =
        response.status === 303
          ? !equalsIgnoreCase(method, "HEAD")
          : (response.status === 301 || response.status === 302) && equalsIgnoreCase(method, "POST");
      if (toGet) {
        method = "GET";
        body = null;
        headers = headers.filter(([name]) => !name.toLowerCase().startsWith("content-"));
      }
      url = next.value;
    }
    // The loop returns on every path; this keeps the function total.
    return { result: failure("invalid-response", "redirect loop"), url: current };
  } catch (err) {
    // Nothing above is expected to throw; a request is still completed.
    return { result: failure("network", `the request failed unexpectedly: ${errorText(err)}`), url: current };
  } finally {
    clearTimeout(timer);
  }
}

/** The server's own say on one hop: the private-network rule, then the app's policy. */
function egressRefusal(
  effect: HostedModuleHttpEffect,
  options: PerformHttpOptions,
  url: HttpUrl,
  method: string,
  hop: number
): Omit<PerformedHttpRequest, "url"> | null {
  const network = httpTargetNetwork(url);
  const target = `${url.host}:${url.port}`;
  if (
    options.privateNetwork === "block" &&
    network !== "public" &&
    !httpHostsNameExplicitly(effect.allowedHosts, url)
  ) {
    const kind: Record<Exclude<HttpTargetNetwork, "public">, string> = {
      loopback: "a loopback address",
      linkLocal: "a link-local address",
      private: "a private-network address",
      unspecified: "an unspecified address",
    };
    return {
      result: failure(
        "denied",
        `${hop === 0 ? "request" : "redirect"} to ${target} refused: it is ${kind[network]}, which a hosted ` +
          "module on a server may only reach when its `httpHosts` names that host"
      ),
      refusedBy: "privateNetwork",
      refusedHost: target,
    };
  }
  if (!options.policy) return null;
  let decision: HttpEgressDecision;
  try {
    decision = options.policy(
      { module: options.module, scope: options.scope, method, url: url.href, scheme: url.scheme, host: url.host, port: url.port, network, hop },
      { sessionId: options.sessionId, allowedHosts: effect.allowedHosts, then: effect.then, tag: effect.tag }
    );
  } catch (err) {
    return {
      result: failure("denied", `the server's egress policy failed for ${target}: ${errorText(err)}`),
      refusedBy: "policy",
    };
  }
  if (decision === "allow") return null;
  const reason =
    decision !== null && typeof decision === "object" && typeof decision.deny === "string" && decision.deny !== ""
      ? decision.deny
      : "no reason given";
  return {
    result: failure("denied", `${hop === 0 ? "request" : "redirect"} to ${target} refused by the server's egress policy: ${reason}`),
    refusedBy: "policy",
  };
}

// ── bounded concurrency ─────────────────────────────────────────────────────

/**
 * Runs jobs at most `limit` at a time, in the order they were queued. A job
 * never starts synchronously inside `push` (the caller is inside an engine
 * callback), and a cleared queue starts nothing more.
 */
export class HttpJobQueue {
  private readonly waiting: Array<() => Promise<void>> = [];
  private running = 0;
  private stopped = false;

  constructor(private readonly limit: number) {}

  get active(): number {
    return this.running;
  }

  get queued(): number {
    return this.waiting.length;
  }

  push(job: () => Promise<void>): void {
    if (this.stopped) return;
    this.waiting.push(job);
    queueMicrotask(() => this.pump());
  }

  /** Drop what has not started; jobs in progress end through their abort signal. */
  stop(): void {
    this.stopped = true;
    this.waiting.length = 0;
  }

  private pump(): void {
    while (!this.stopped && this.running < this.limit) {
      const job = this.waiting.shift();
      if (!job) return;
      this.running += 1;
      void job()
        .catch(() => {})
        .finally(() => {
          this.running -= 1;
          this.pump();
        });
    }
  }
}
