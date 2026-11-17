/** Minimal CF type stubs */
interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}
interface DurableObjectId {}
interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

/**
 * How WebSocket upgrades are routed to Durable Objects. Each distinct key is
 * its own DO: its own engine, its own storage, its own `.persist()` state.
 *
 * - `"visitor"` — one DO per browser visitor, keyed by an HttpOnly visitor
 *   cookie ({@link DEFAULT_VISITOR_COOKIE}). The cookie is minted on the
 *   first page response and on the first WebSocket 101 that arrives without
 *   it, so every tab, reload and same-site `HypenApp` embed of one browser
 *   lands in the same DO — `.persist()` state survives a reload. A socket
 *   with no cookie but a `?sessionId=` (a native client) is keyed by that.
 *   The default of `defineHypenWorker`.
 * - `"connection"` — the client chooses: `?sessionId=`, then a
 *   `hypen_session` cookie, then the URL path (`/room/abc` → `room:abc`),
 *   else a fresh DO. The bare socket endpoint (`/ws`) is NOT a path key:
 *   it would put every client that connects without a session id (every
 *   `HypenApp` embed) into one shared DO. The default of
 *   `createWorkerHandler`.
 * - `"shared"` — every client in ONE DO (key `"shared"`): one state for the
 *   whole deployment, e.g. a public shared list. Opt in explicitly.
 *
 * A custom `getRoutingKey` overrides the mode (and no cookie is set).
 */
export type RoutingMode = "visitor" | "connection" | "shared";

/** Name of the visitor cookie used by `routing: "visitor"`. */
export const DEFAULT_VISITOR_COOKIE = "hypen_visitor";

export interface VisitorCookieOptions {
  /** Cookie name (default {@link DEFAULT_VISITOR_COOKIE}). */
  name?: string;
  /** Lifetime in seconds (default one year). */
  maxAgeSeconds?: number;
  /**
   * `SameSite` attribute (default `"Lax"`: sent by same-site pages and
   * embeds, never by a cross-site page). `"None"` lets cross-site embeds
   * share the visitor's DO where third-party cookies are allowed; it
   * implies `Secure`.
   */
  sameSite?: "Lax" | "Strict" | "None";
}

/** The DO routing key for a visitor id. */
export function visitorRoutingKey(visitorId: string): string {
  return `visitor:${visitorId}`;
}

const VISITOR_ID = /^[A-Za-z0-9_-]{16,128}$/;

/** Value of cookie `name` in the request, or null. */
function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** The visitor id carried by the request's cookie, or null (absent / malformed). */
export function readVisitorId(
  request: Request,
  options: VisitorCookieOptions = {},
): string | null {
  const id = readCookie(request, options.name ?? DEFAULT_VISITOR_COOKIE);
  return id && VISITOR_ID.test(id) ? id : null;
}

/** A fresh, unguessable visitor id. */
export function mintVisitorId(): string {
  return crypto.randomUUID();
}

/**
 * `response` with a `Set-Cookie` for `visitorId` appended (HttpOnly, Path=/,
 * `Secure` on https). Keeps a 101's `webSocket`, so it wraps the upgrade
 * response too — the cookie must ride on BOTH the page response and the
 * WebSocket 101, or an embed that never loads a page never gets one.
 */
export function withVisitorCookie(
  response: Response,
  visitorId: string,
  request: Request,
  options: VisitorCookieOptions = {},
): Response {
  const name = options.name ?? DEFAULT_VISITOR_COOKIE;
  const maxAge = options.maxAgeSeconds ?? 60 * 60 * 24 * 365;
  const sameSite = options.sameSite ?? "Lax";
  const secure = sameSite === "None" || new URL(request.url).protocol === "https:";
  const headers = new Headers(response.headers);
  headers.append(
    "Set-Cookie",
    `${name}=${visitorId}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=${sameSite}${secure ? "; Secure" : ""}`,
  );
  const init: ResponseInit & { webSocket?: unknown } = {
    status: response.status,
    statusText: response.statusText,
    headers,
  };
  const ws = (response as Response & { webSocket?: unknown }).webSocket;
  if (ws) init.webSocket = ws;
  // A 101 carries no body.
  return new Response(response.status === 101 ? null : response.body, init as ResponseInit);
}

export interface WorkerConfig {
  /** Name of the DO binding in wrangler.toml (e.g., "HYPEN_DO") */
  binding: string;

  /**
   * Extract the DO routing key from the request. Overrides `routing`.
   * For session-based: extract from cookie or URL param
   * For global: return a fixed string
   */
  getRoutingKey?: (request: Request) => string | Promise<string>;

  /**
   * Built-in routing used when `getRoutingKey` is absent. Default
   * `"connection"` (`defineHypenWorker` defaults to `"visitor"`). See
   * {@link RoutingMode}.
   */
  routing?: RoutingMode;

  /** Visitor cookie settings for `routing: "visitor"`. */
  visitorCookie?: VisitorCookieOptions;
}

/** Path segments that name the Hypen socket endpoint, never a room. */
const SOCKET_ENDPOINTS = new Set(["ws"]);

function defaultRoutingKey(request: Request): string {
  const url = new URL(request.url);

  // Check for session ID in query params
  const sessionId = url.searchParams.get("sessionId");
  if (sessionId) return sessionId;

  // Check for session ID in cookie
  const cookieSession = readCookie(request, "hypen_session");
  if (cookieSession) return cookieSession;

  // Use URL path as key (e.g., /room/abc -> "room:abc"). The bare socket
  // endpoint is not a room: keying on it would collapse every client that
  // connects to `/ws` without a session id into ONE shared DO.
  const path = url.pathname.replace(/^\/+|\/+$/g, "");
  if (path && !SOCKET_ENDPOINTS.has(path)) return path.replace(/\//g, ":");

  // Fallback: generate new session
  return crypto.randomUUID();
}

/**
 * The DO key for a WebSocket upgrade under `routing: "visitor"`; `mint` is
 * the visitor id to set on the 101 when the request carried none.
 */
function visitorKey(
  request: Request,
  options: VisitorCookieOptions | undefined,
): { key: string; mint: string | null } {
  const visitor = readVisitorId(request, options);
  if (visitor) return { key: visitorRoutingKey(visitor), mint: null };
  // No cookie: a client that names its session (a native app, which keeps
  // no cookies) stays on it across reconnects.
  const sessionId = new URL(request.url).searchParams.get("sessionId");
  if (sessionId) return { key: sessionId, mint: null };
  const minted = mintVisitorId();
  return { key: visitorRoutingKey(minted), mint: minted };
}

/**
 * Create a CF Worker fetch handler that routes to HypenDurableObject instances.
 *
 * Usage in worker entrypoint:
 * ```typescript
 * import { createWorkerHandler } from "@hypen-space/cf";
 * export default { fetch: createWorkerHandler({ binding: "HYPEN_DO" }) };
 * ```
 */
export function createWorkerHandler(config: WorkerConfig) {
  return async function fetch(
    request: Request,
    env: Record<string, DurableObjectNamespace>,
  ): Promise<Response> {
    // 1. Check if WebSocket upgrade request
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426 });
    }

    // 2. Get the DO namespace from env using config.binding
    const doNamespace = env[config.binding];
    if (!doNamespace) {
      return new Response(
        `Durable Object binding "${config.binding}" not found`,
        { status: 500 },
      );
    }

    // 3. Get routing key
    let key: string;
    let mint: string | null = null;
    if (config.getRoutingKey) {
      key = await config.getRoutingKey(request);
    } else if (config.routing === "shared") {
      key = "shared";
    } else if (config.routing === "visitor") {
      ({ key, mint } = visitorKey(request, config.visitorCookie));
    } else {
      key = defaultRoutingKey(request);
    }

    // 4. Get DO instance
    const id = doNamespace.idFromName(key);
    const stub = doNamespace.get(id);

    // 5. Forward request to DO. A freshly minted visitor id rides on the
    // 101, so this browser's next connection lands in the same DO.
    const response = await stub.fetch(request);
    if (mint && response.status === 101) {
      return withVisitorCookie(response, mint, request, config.visitorCookie);
    }
    return response;
  };
}
