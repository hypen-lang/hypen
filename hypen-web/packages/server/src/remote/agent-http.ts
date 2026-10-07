/**
 * The agent REST surface — HTTP in front of the engine's external capability
 * guard.
 *
 * # Why this exists
 *
 * `hypen-engine-rs/src/agent.rs` states the rule: **nothing is externally
 * reachable that a developer did not declare**. `Engine.dispatchAction` is the
 * renderer's permissive path — it reaches `__hypen_bind` (an arbitrary state
 * writer) and every `router.*` verb by name — so a caller that is not the
 * rendered tree gets `dispatchExternal` instead, which authorises through
 * `agent_core::resolve_external` first.
 *
 * This module is a transport and nothing else. It parses a request, hands the
 * name and payload to the guard, and translates the guard's answer into a
 * status code. It holds no allowlist, no denylist and no name table of its
 * own; adding one here would give the rule a second implementation, and the
 * engine's module docs are explicit that the second one drifts.
 *
 * # Explicit enablement
 *
 * The surface is off until `RemoteServer.agent()` is called. Not off-by-config,
 * not on-in-dev: a `RemoteServer` with no `.agent()` never constructs an
 * `AgentSurface`, so `/__hypen__/agent/*` falls through to the same catch-all
 * response as any other unknown path — a probe cannot even tell the surface
 * exists. Remote-driving an app is a capability grant, and a grant nobody made
 * is not a grant.
 *
 * # Headless and attached sessions
 *
 * `POST /sessions` with an empty body opens a **headless** session: a fresh
 * engine on a transport nobody watches, sandboxed to the caller. That is the
 * default. With a body of `{ "sessionId" }` it instead **attaches** to the
 * live user session that id names, so the guarded dispatch and read run on
 * the user's own engine and the user's transport receives the patches — the
 * co-pilot case, where the human watching a session sees what the agent did.
 *
 * Attaching is a second grant on top of the first, made per request by
 * `AgentOptions.authorize`. No `authorize` callback ⇒ every attach is
 * refused, and every refusal — no authorizer, authorizer said no or threw,
 * no such live session — answers with the byte-identical `unknown_session`
 * 404, so the route cannot be used to learn which session ids exist. The
 * record the surface keeps for an attached session is a handle and nothing
 * more (`agent-handle.ts`): sweeping it, or disposing the surface, drops the
 * handle and leaves the user's session untouched.
 *
 * # Status codes
 *
 * A caller has to be able to tell "you may not do that" from "you asked
 * wrongly", so the three cases stay apart:
 *
 * | Code | Meaning | Source |
 * |---|---|---|
 * | 400 | malformed request | HTTP-level parse failure, or `EngineError::StateError` |
 * | 401 | no or wrong bearer token, when `token` is configured | this module, before routing |
 * | 403 | the guard refused | `EngineError::ActionNotFound` |
 * | 404 | no such session, or a state path outside the read surface | this module / `get_state` |
 *
 * The engine collapses both error variants into one structured `actionError`
 * on the way through wasm-bindgen (`wasm/js.rs`), so the only signal left at
 * this boundary is the message prefix `EngineError`'s `Display` writes. Prefix
 * matching is what `classifyEngineError` in `@hypen-space/core` already does
 * for the same reason; see `REFUSAL_PREFIXES` below.
 *
 * # Response shapes and the settlement cursor
 *
 * | Route | 2xx body |
 * |---|---|
 * | `POST /sessions` | `{ sessionId, attached?: true, revision }` |
 * | `POST /sessions/:id/dispatch` | `{ dispatched, revision }` |
 * | `GET /sessions/:id/state` | `{ module, path, value, revision }` |
 *
 * `revision` is the session's render counter — monotonic, per session, and
 * moved only by a render that produced patches. A dispatch answers
 * "dispatched", never "done": handlers are async and the engine does not
 * await them, so the surface cannot know whether the handler has finished.
 * What it can say is where the counter stood once the dispatch call
 * returned, and that every later read is at-or-above that value. An agent
 * doing multi-step work therefore compares: a read whose `revision` is
 * above the dispatch's has observed at least one render since, and a read
 * whose `revision` equals it has observed none — "the handler is still
 * awaiting a fetch" and "the handler ran and changed nothing" look the same
 * to the counter, but either way the caller is no longer polling blind.
 * The value is opaque: compare it only against values from the same
 * session, never across sessions or against a client's own `revision`.
 *
 * A refusal (403) moves nothing — the guard throws before any handler runs
 * — so the counter read before and after a refused dispatch is the same.
 *
 * # Authentication
 *
 * `AgentOptions.token`, when set, gates **every** route under the base path
 * — manifest, openapi, sessions, dispatch, state, and the 404 for a path
 * that is none of those — behind `Authorization: Bearer <token>`, checked
 * with a constant-time comparison before any routing, body reading or
 * session lookup happens. A missing or wrong token answers 401 with the
 * same body on every route, so it cannot be used to learn which session
 * ids exist. When unset the surface is open, exactly as before: the app is
 * expected to put it behind its own authentication, and `authorize` still
 * gates attach on top of either.
 */

import { timingSafeEqual } from "node:crypto";
import { frameworkLoggers } from "@hypen-space/core/logger";
import type {
  OutgoingMessage,
  RemoteSession,
  SessionTransport,
} from "./session.js";
import { AgentSessionGoneError, type AgentHandle } from "./agent-handle.js";

const log = frameworkLoggers.remote;

/** Default mount point. Shares the `/__hypen__/` namespace with `client.js`. */
const DEFAULT_BASE_PATH = "/__hypen__/agent";

/**
 * Largest request body accepted, in bytes. The surface takes small JSON
 * envelopes only, and unless `AgentOptions.token` is set it has no
 * authentication layer of its own for these routes to sit behind —
 * `authorize` gates attach and nothing else, and it runs after the body has
 * been read — so an unbounded `req.json()` would be a free
 * memory-exhaustion primitive.
 */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * `EngineError::ActionNotFound`'s `Display` prefix — the guard's refusal.
 *
 * Read from the message rather than from a type because `WasmEngine::
 * dispatch_external` maps every `EngineError` to `structured_error(
 * "actionError", &e.to_string())`, discarding the variant. Until that binding
 * carries the variant, the prefix is the only thing that survives the boundary.
 */
const REFUSAL_PREFIXES = [
  // `EngineError::ActionNotFound` — no handler is reachable under that name,
  // which is what a reserved name like `__hypen_bind` or `router.replace` is.
  "No handler registered for action: ",
  // `EngineError::NotDeclared` — the handler exists and the request was
  // refused: a route outside the declared table, a `set_input` field no
  // `.bind()` declares. Both are 403; the distinction is in the message.
  "Not declared by this app: ",
];

/**
 * `Display` prefixes that mean the caller's payload was wrong rather than
 * forbidden: `EngineError::StateError` (a `hypen.set_input` with no `field`, a
 * `hypen.navigate` with no `to`, a value contradicting the bound prop's type)
 * and the payload deserialisation failure in the wasm binding itself.
 */
const MALFORMED_PREFIXES = ["State error: ", "Invalid action payload: "];

/** How the surface is configured at `RemoteServer.agent()`. */
export interface AgentOptions {
  /** Mount point for every route. Default `/__hypen__/agent`. */
  basePath?: string;
  /**
   * Most agent sessions alive at once. Each one owns an engine, a module
   * instance and a `SessionManager` entry, so `POST /sessions` is an
   * allocation primitive and needs a ceiling. Default 8.
   */
  maxSessions?: number;
  /**
   * Milliseconds a session may go unused before it is torn down. Swept lazily
   * on each request rather than on a timer, so an idle server holds no handle
   * that keeps the process alive. Default 5 minutes.
   */
  idleTimeoutMs?: number;
  /**
   * Bearer token gating the **whole surface**. When set, every route under
   * `basePath` — manifest, openapi, sessions, dispatch, state, and unknown
   * sub-paths — requires `Authorization: Bearer <token>`, compared in
   * constant time before any routing or body reading; anything else answers
   * `401 { error: "unauthorized" }` with `WWW-Authenticate: Bearer`, the
   * same body on every route. When unset, behaviour is unchanged: the
   * surface is open and the app is expected to sit it behind its own
   * authentication.
   *
   * This is the coarse gate; `authorize` is the fine one. A caller with the
   * token can open headless sessions and drive them, but still cannot
   * attach to a user's session unless `authorize` says so.
   *
   * Must be non-empty when present: an empty token would "gate" the surface
   * behind an empty header, which is no gate, so it is rejected at
   * configuration rather than silently accepted.
   */
  token?: string;
  /**
   * Decide whether this request may attach to the live user session
   * `sessionId` names (`POST /sessions` with `{ "sessionId" }`).
   *
   * **Absent ⇒ every attach is refused.** Attaching hands a caller the
   * user's own engine — the patches land in the user's browser — so it is a
   * grant only the app can make, against whatever it authenticates with
   * (a cookie, a bearer token, an internal network). Return `true` to
   * allow; `false`, or a throw, refuses. Every refusal, and an id that
   * names no ready session, answers with the same `unknown_session` 404 so
   * the route is not an oracle for which session ids exist.
   *
   * Gates attach only — `token` gates the whole surface — and runs on top
   * of it: with both set, a request has to carry the token to reach this
   * at all. Headless sessions (no `sessionId` in the body) never consult
   * this.
   */
  authorize?: (req: Request, sessionId: string) => boolean | Promise<boolean>;
}

/**
 * The slice of `RemoteServer` this surface needs. Narrow on purpose: taking
 * the class would make `server.ts` and this file import each other.
 */
export interface AgentSessionFactory {
  createSession(
    transport: SessionTransport,
    options?: { clientId?: string; helloGraceMs?: number | null; socketHandle?: unknown }
  ): RemoteSession;
  /**
   * A handle over the live session with this id, or `null` when no ready
   * session has it. Performs no authorisation — that is `authorize`'s job,
   * and it has already run by the time this is called.
   */
  attach(sessionId: string): AgentHandle | null;
}

// ── the MCP manifest, as it crosses the wasm boundary ─────────────────────
//
// Mirrors `McpManifest` in `hypen-engine-rs/src/agent.rs`, whose derive is
// `#[serde(rename_all = "camelCase")]` with `_meta` kept verbatim. Declared
// here as a read-only shape: this module never composes a manifest, it only
// forwards one and reads names and schemas out of it.

/** One entry of an MCP `_meta` bag. */
export type McpMeta = Record<string, unknown>;

/** One MCP tool, as `agent_manifest::mcp_manifest` composes it. */
export interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: unknown;
  annotations?: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
  };
  _meta?: McpMeta;
}

/** One readable state path, as an MCP resource. */
export interface McpResource {
  uri: string;
  name: string;
  title: string;
  description: string;
  mimeType: string;
  _meta?: McpMeta;
}

/** Everything an MCP host needs to describe this app to a client. */
export interface McpManifest {
  protocolVersion: string;
  instructions: string;
  tools: McpTool[];
  resources: McpResource[];
  resourceTemplates: unknown[];
  degraded: Array<{ kind: string; name: string; reason: string }>;
}

/** One externally dispatchable action, as `listActions()` reports it. */
interface ListedAction {
  name: string;
  module: string | null;
  builtin: boolean;
}

/**
 * The engine methods this surface calls. `mcpManifest` is optional because no
 * JS binding exports it yet — `Engine::mcp_manifest()` exists in the Rust core
 * but `wasm/js.rs` has no `#[wasm_bindgen]` wrapper for it, so a Node host
 * cannot reach it. `GET /manifest` reports that as 503 rather than composing a
 * manifest here; composing one would be the second implementation of the rule
 * that `agent.rs` says drifts.
 */
interface GuardedEngine {
  dispatchExternal(name: string, payload?: unknown): void;
  getStateAt(module: string | null, path: string | null): unknown;
  listActions(): ListedAction[];
  /** The core's monotonic render counter — see `revisionOf`. */
  getRevision(): number;
  mcpManifest?: () => McpManifest;
}

/**
 * A transport that goes nowhere.
 *
 * An agent session still renders and still streams patches, because that is
 * how the engine keeps its declaration tables and its state current. Nobody is
 * watching the pixels, so the frames are dropped — but `close()` is not, since
 * `RemoteSession.initializeSession` reports a failed initial render by closing
 * the transport and returning WITHOUT resolving `ready`. Awaiting `ready`
 * alone would hang forever on a template that does not parse.
 */
class SinkTransport implements SessionTransport {
  private resolveClosed!: (reason: string) => void;
  readonly closed: Promise<string>;

  constructor() {
    this.closed = new Promise<string>((resolve) => {
      this.resolveClosed = resolve;
    });
  }

  send(_message: OutgoingMessage): void {
    /* an agent reads state, never patches */
  }

  close(code?: number, reason?: string): void {
    this.resolveClosed(reason ?? `closed with code ${code ?? "?"}`);
  }
}

/**
 * What an agent id resolves to.
 *
 * `headless` — a session this surface opened and therefore owns: it is
 * destroyed when swept or disposed. `attached` — a handle over a user's
 * session that this surface does NOT own: sweeping or disposing drops the
 * handle and nothing else. The discriminant is what keeps `destroy()` from
 * ever being reachable from an attached record.
 */
type SessionRecord = { lastSeen: number } & (
  | { kind: "headless"; session: RemoteSession }
  | { kind: "attached"; handle: AgentHandle }
);

/** JSON response helper — every route answers `application/json`. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Error envelope. `error` is a stable code; `message` is for a human. */
function fail(status: number, error: string, message: string): Response {
  return json({ error, message }, status);
}

/**
 * HTTP in front of `dispatchExternal` / `getStateAt`.
 *
 * Constructed only by `RemoteServer.agent()`, and torn down by
 * `RemoteServer.stop()`.
 */
export class AgentSurface {
  private readonly basePath: string;
  private readonly maxSessions: number;
  private readonly idleTimeoutMs: number;
  /** `null` — not "always allow" — when the app configured none. */
  private readonly authorize: AgentOptions["authorize"] | null;
  /**
   * The configured bearer token as bytes, or `null` when the surface is
   * open. Kept as a `Buffer` so the per-request comparison is a
   * `timingSafeEqual` over the same bytes every time, with no string
   * work on the secret in the hot path.
   */
  private readonly token: Buffer | null;
  private readonly sessions = new Map<string, SessionRecord>();
  /**
   * A session held purely so the manifest has an engine to derive from.
   * `mcp_manifest` reads the declaration tables, which only exist after a
   * render, and `GET /manifest` deliberately takes no session id — the
   * manifest describes the app, not one caller's view of it.
   */
  private probe: RemoteSession | null = null;
  private probePending: Promise<RemoteSession> | null = null;
  private disposed = false;

  constructor(
    private readonly host: AgentSessionFactory,
    options: AgentOptions = {}
  ) {
    this.basePath = (options.basePath ?? DEFAULT_BASE_PATH).replace(/\/+$/, "");
    this.maxSessions = options.maxSessions ?? 8;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 5 * 60_000;
    this.authorize = options.authorize ?? null;
    if (options.token !== undefined && options.token.length === 0) {
      throw new Error("AgentOptions.token must be a non-empty string when set.");
    }
    this.token = options.token === undefined ? null : Buffer.from(options.token, "utf8");
  }

  /**
   * Handle one request, or return `null` when the path is not ours so the
   * host's own routing carries on unchanged.
   */
  async handle(req: Request, url: URL): Promise<Response | null> {
    if (this.disposed) return null;
    const path = url.pathname;
    if (path !== this.basePath && !path.startsWith(`${this.basePath}/`)) {
      return null;
    }

    // The token gate comes first — before the sweep, before routing, before
    // a body is read — so an unauthenticated request does no work on this
    // surface and gets the same answer whatever it asked for.
    if (!this.bearerAccepted(req)) return unauthorized();

    this.sweepIdle();

    const segments = path.slice(this.basePath.length).split("/").filter(Boolean);
    const method = req.method.toUpperCase();

    // GET {base}/manifest
    if (segments.length === 1 && segments[0] === "manifest") {
      return this.methodGuard(method, "GET") ?? (await this.getManifest());
    }

    // GET {base}/openapi.json
    if (segments.length === 1 && segments[0] === "openapi.json") {
      return this.methodGuard(method, "GET") ?? (await this.getOpenApi());
    }

    // POST {base}/sessions
    if (segments.length === 1 && segments[0] === "sessions") {
      return this.methodGuard(method, "POST") ?? (await this.postSession(req));
    }

    if (segments.length === 3 && segments[0] === "sessions") {
      const id = segments[1]!;
      // POST {base}/sessions/:id/dispatch
      if (segments[2] === "dispatch") {
        return this.methodGuard(method, "POST") ?? (await this.postDispatch(req, id));
      }
      // GET {base}/sessions/:id/state
      if (segments[2] === "state") {
        return this.methodGuard(method, "GET") ?? this.getState(url, id);
      }
    }

    return fail(404, "not_found", `No agent route at ${path}`);
  }

  /**
   * Destroy every session this surface opened, and forget every one it
   * attached to. Called from `stop()`. An attached record is a handle over
   * a session the user's transport owns; dropping the handle is all that
   * happens to it.
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    const open: RemoteSession[] = [];
    for (const record of this.sessions.values()) {
      if (record.kind === "headless") open.push(record.session);
    }
    this.sessions.clear();
    if (this.probe) {
      open.push(this.probe);
      this.probe = null;
    }
    this.probePending = null;
    await Promise.all(
      open.map((s) =>
        s.destroy().catch((err) => log.error("Agent session teardown failed:", err))
      )
    );
  }

  // ── routes ───────────────────────────────────────────────────────────

  private async getManifest(): Promise<Response> {
    const probe = await this.probeEngine();
    if ("error" in probe) return probe.error;
    const manifest = readManifest(probe.engine);
    if (!manifest) return manifestUnavailable();
    // Verbatim. Every field of `McpManifest` is meant to be copied into an MCP
    // handshake unchanged; paraphrasing it here would put protocol prose back
    // in a host, which is the duplication the engine composes it to remove.
    return json(manifest);
  }

  private async getOpenApi(): Promise<Response> {
    const probe = await this.probeEngine();
    if ("error" in probe) return probe.error;
    const manifest = readManifest(probe.engine);
    if (!manifest) return manifestUnavailable();
    return json(
      buildOpenApi(manifest, probe.engine.listActions(), this.basePath, {
        requiresToken: this.token !== null,
      })
    );
  }

  private async postSession(req: Request): Promise<Response> {
    // Both kinds count: an attached record is cheap, but the map it lives in
    // is still the thing an unauthenticated caller can grow.
    if (this.sessions.size >= this.maxSessions) {
      return fail(
        503,
        "session_limit",
        `Agent session limit reached (${this.maxSessions}). Existing sessions expire after ${this.idleTimeoutMs}ms idle.`
      );
    }

    // Read the body only when there is one: `readJsonBody` 400s on empty,
    // and a bare `POST /sessions` — today's headless call — has no body.
    const target = await readAttachTarget(req);
    if ("error" in target) return target.error;

    if (target.sessionId === null) {
      return this.openHeadless();
    }
    return this.openAttached(req, target.sessionId);
  }

  private async openHeadless(): Promise<Response> {
    let session: RemoteSession;
    try {
      session = await this.openSession();
    } catch (err) {
      return fail(500, "session_failed", messageOf(err));
    }
    // A fresh opaque id rather than `session.sessionId`. The latter is the
    // `SessionManager` resume token: hand it out over REST and an agent id
    // doubles as a credential for reattaching to that session's saved state
    // over the WebSocket, which is a capability nobody granted.
    const id = crypto.randomUUID();
    const record: SessionRecord = { kind: "headless", session, lastSeen: Date.now() };
    this.sessions.set(id, record);
    return json({ sessionId: id, revision: revisionOf(record) }, 201);
  }

  /**
   * Attach to a live user session.
   *
   * Three refusals, one answer: no `authorize` configured, `authorize` said
   * no (or threw), and no ready session with that id all return the same
   * `unknownSession` 404 — the bytes a bad *agent* id gets on any route. A
   * distinct status per case would let a caller with no grant learn which
   * ids are live; a distinct status for "not configured" would advertise
   * that attaching is a thing this server does.
   */
  private async openAttached(req: Request, sessionId: string): Promise<Response> {
    if (!this.authorize) return unknownSession(sessionId);
    let allowed = false;
    try {
      allowed = (await this.authorize(req, sessionId)) === true;
    } catch (err) {
      // A throwing authorizer is a refusal, and a logged one: the app's own
      // code failed, and that should be visible to the app, not the caller.
      log.error("Agent attach authorizer threw:", err);
      allowed = false;
    }
    if (!allowed) return unknownSession(sessionId);

    const handle = this.host.attach(sessionId);
    if (!handle) return unknownSession(sessionId);

    // Still a fresh opaque id, for the same reason as the headless path — and
    // one more: the user's session id is the *input* here, so echoing it
    // back would confirm to an authorised caller only what it already knew,
    // while making the two kinds of id interchangeable on the wire.
    const id = crypto.randomUUID();
    const record: SessionRecord = { kind: "attached", handle, lastSeen: Date.now() };
    this.sessions.set(id, record);
    let revision: number;
    try {
      revision = revisionOf(record);
    } catch (err) {
      // The session closed between `attach()` and here. Rare, but the id
      // must not be handed out over a session that is already gone.
      if (!(err instanceof AgentSessionGoneError)) throw err;
      this.sessions.delete(id);
      return unknownSession(sessionId);
    }
    return json({ sessionId: id, attached: true, revision }, 201);
  }

  private async postDispatch(req: Request, id: string): Promise<Response> {
    const record = this.sessions.get(id);
    if (!record) return unknownSession(id);
    record.lastSeen = Date.now();

    const body = await readJsonBody(req);
    if ("error" in body) return body.error;

    const envelope = body.value;
    if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
      return fail(400, "bad_request", "Body must be a JSON object of { name, payload }.");
    }
    const { name, payload } = envelope as { name?: unknown; payload?: unknown };
    if (typeof name !== "string" || name.length === 0) {
      return fail(400, "bad_request", "'name' must be a non-empty string.");
    }

    try {
      // `dispatchExternal`, never `dispatchAction`. The permissive path would
      // hand `__hypen_bind` and every `router.*` verb straight to a handler
      // without consulting the guard at all — the whole reason this surface
      // exists is that an HTTP caller is not the rendered tree.
      if (record.kind === "attached") {
        // On the user's engine, so the user's transport carries the result;
        // and under `syncActions` the handle mirrors the dispatch to the
        // other live sessions the way a click is mirrored. The `authorize`
        // grant at attach time is what makes that reach legitimate.
        record.handle.dispatch(name, payload ?? undefined);
      } else {
        // Headless: deliberately NOT fanned out to sibling sessions the way
        // `RemoteSession.receive` does under `syncActions`. Nobody authorised
        // this caller to reach anyone's live browser session, and a sandbox
        // that leaks into the room is not a sandbox.
        const engine = record.session.engine as unknown as GuardedEngine;
        engine.dispatchExternal(name, payload ?? undefined);
      }
    } catch (err) {
      if (err instanceof AgentSessionGoneError) {
        this.sessions.delete(id);
        return unknownSession(id);
      }
      return dispatchFailure(name, err);
    }

    // "Dispatched", not "done". Handlers are async and the engine does not
    // await them, so anything stronger would be a claim this surface cannot
    // check — read state back to observe an effect. What CAN be said is
    // where the render counter stood once the dispatch call returned: read
    // AFTER the call, so every later read of this session is at-or-above
    // it, and a read that is strictly above has seen a render since.
    let revision: number;
    try {
      revision = revisionOf(record);
    } catch (err) {
      if (!(err instanceof AgentSessionGoneError)) throw err;
      this.sessions.delete(id);
      return unknownSession(id);
    }
    return json({ dispatched: name, revision });
  }

  private getState(url: URL, id: string): Response {
    const record = this.sessions.get(id);
    if (!record) return unknownSession(id);
    record.lastSeen = Date.now();

    // A query string cannot spell "absent" apart from "empty", and the primary
    // module is addressed by absence, so an empty `module=` reads the primary —
    // the same convention `get_state` uses.
    const moduleParam = url.searchParams.get("module");
    const module = moduleParam ? moduleParam : null;
    const pathParam = url.searchParams.get("path");
    const path = pathParam ? pathParam : null;

    let value: unknown;
    let revision: number;
    if (record.kind === "attached") {
      try {
        value = record.handle.getState(module, path);
        revision = revisionOf(record);
      } catch (err) {
        if (!(err instanceof AgentSessionGoneError)) throw err;
        // The user's session closed underneath the agent id. The id is now
        // as good as unknown, so say so and forget it.
        this.sessions.delete(id);
        return unknownSession(id);
      }
    } else {
      const engine = record.session.engine as unknown as GuardedEngine;
      value = engine.getStateAt(module, path);
      revision = revisionOf(record);
    }
    if (value === undefined) {
      // The engine does not distinguish "unknown module" from "path outside the
      // declared read surface", on purpose: distinguishing them would let a
      // caller probe for state it is not being shown. Neither does this.
      return fail(
        404,
        "not_readable",
        `No readable state at ${path ?? "<root>"}${module ? ` in module '${module}'` : ""}.`
      );
    }
    return json({ module, path, value, revision });
  }

  // ── sessions ─────────────────────────────────────────────────────────

  /**
   * Open a headless session and drive it through the hello handshake, so its
   * engine has rendered and the declaration tables the guard reads exist.
   */
  private async openSession(): Promise<RemoteSession> {
    const transport = new SinkTransport();
    // `helloGraceMs: null` disables the legacy auto-init timer: we send hello
    // ourselves immediately, and the timer would otherwise be a stray handle.
    const session = this.host.createSession(transport, { helloGraceMs: null });
    await session.receive(JSON.stringify({ type: "hello" }));

    const outcome = await Promise.race([
      session.ready.then(() => null),
      transport.closed.then((reason) => reason),
    ]);
    if (outcome !== null) {
      await session.destroy().catch(() => {});
      throw new Error(`Session failed to initialise: ${outcome}`);
    }
    return session;
  }

  /** The probe session's engine, or the 500 to answer with. */
  private async probeEngine(): Promise<{ engine: GuardedEngine } | { error: Response }> {
    try {
      const session = await this.probeSession();
      return { engine: session.engine as unknown as GuardedEngine };
    } catch (err) {
      return { error: fail(500, "session_failed", messageOf(err)) };
    }
  }

  private async probeSession(): Promise<RemoteSession> {
    if (this.probe) return this.probe;
    // One in-flight open at a time, or two concurrent `/manifest` requests
    // leak a session apiece.
    this.probePending ??= this.openSession()
      .then((session) => {
        this.probe = session;
        return session;
      })
      .finally(() => {
        this.probePending = null;
      });
    return this.probePending;
  }

  /**
   * Drop sessions nobody has touched inside the idle window.
   *
   * Lazy rather than on an interval: a `setInterval` here would keep the Bun
   * process alive after `stop()` for anyone who forgot to dispose, and the
   * only thing the sweep protects is memory this surface allocated.
   */
  private sweepIdle(): void {
    const cutoff = Date.now() - this.idleTimeoutMs;
    for (const [id, record] of this.sessions) {
      if (record.lastSeen > cutoff) continue;
      this.sessions.delete(id);
      // An attached record is dropped and nothing more: the session behind
      // it belongs to the user's transport, which decides when it ends.
      if (record.kind !== "headless") continue;
      record.session
        .destroy()
        .catch((err) => log.error(`Idle agent session ${id} teardown failed:`, err));
    }
  }

  /**
   * Whether this request carries the configured bearer token. Always true
   * when none is configured.
   *
   * The scheme is matched case-insensitively (RFC 6750 §2.1 makes it so);
   * the credential is compared byte-for-byte in constant time. Length is
   * checked first because `timingSafeEqual` requires equal lengths — a
   * mismatch there is a refusal, and the only thing its timing can reveal
   * is the token's length, which is not the token.
   */
  private bearerAccepted(req: Request): boolean {
    if (this.token === null) return true;
    const header = req.headers.get("authorization");
    if (header === null) return false;
    const space = header.indexOf(" ");
    if (space === -1 || header.slice(0, space).toLowerCase() !== "bearer") return false;
    const presented = Buffer.from(header.slice(space + 1).trim(), "utf8");
    return presented.length === this.token.length && timingSafeEqual(presented, this.token);
  }

  private methodGuard(actual: string, allowed: string): Response | null {
    if (actual === allowed) return null;
    return new Response(
      JSON.stringify({
        error: "method_not_allowed",
        message: `Use ${allowed} on this route.`,
      }),
      { status: 405, headers: { "Content-Type": "application/json", Allow: allowed } }
    );
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function unknownSession(id: string): Response {
  return fail(404, "unknown_session", `No agent session '${id}'.`);
}

/**
 * The 401 for a missing or wrong bearer token. One body for every route and
 * every id, composed with no input from the request, so it cannot confirm
 * or deny that a session id exists.
 */
function unauthorized(): Response {
  return new Response(
    JSON.stringify({
      error: "unauthorized",
      message: "This agent surface requires 'Authorization: Bearer <token>'.",
    }),
    {
      status: 401,
      headers: { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" },
    }
  );
}

/**
 * The settlement cursor for a record — the session's current render count.
 *
 * Two counters exist and both move per render. The engine core's
 * (`EngineCore.revision`, surfaced as `BaseEngine.getRevision()`) increments
 * on every full render and on every dirty render that produced patches; the
 * session's (`RemoteSession.revision`) increments in the streaming render
 * callback, which fires on exactly those dirty renders, but it starts at 0
 * and does not count the initial full render. A headless record reads the
 * engine's: it is the counter `AgentEngine.getRevision` reads under MCP, so
 * one session reports one number over both transports, and it is never 0
 * for a session that has rendered. An attached record reads the handle's,
 * which is the session's outgoing revision — the number stamped on the last
 * `patch` the user's browser received, which is what an attached agent
 * needs to correlate with. Either way the value is monotonic and per
 * session, and callers compare it only against values from the same id.
 *
 * @throws {AgentSessionGoneError} for an attached record whose session closed.
 */
function revisionOf(record: SessionRecord): number {
  if (record.kind === "attached") return record.handle.revision();
  return (record.session.engine as unknown as GuardedEngine).getRevision();
}

function manifestUnavailable(): Response {
  return fail(
    503,
    "manifest_unavailable",
    "This WASM build exports no mcpManifest(). Engine::mcp_manifest() exists in " +
      "hypen-engine-rs but has no #[wasm_bindgen] wrapper in src/wasm/js.rs, so no " +
      "JS host can reach it. Composing a manifest here instead would give the " +
      "external-surface rule a second implementation."
  );
}

/** The manifest, or `null` when this build's binding does not export one. */
function readManifest(engine: GuardedEngine): McpManifest | null {
  if (typeof engine.mcpManifest !== "function") return null;
  return engine.mcpManifest();
}

/**
 * Turn a `dispatchExternal` throw into a status code.
 *
 * The distinction is the whole point: 403 means the guard refused a name or a
 * target the app never declared, 400 means the caller sent a payload the guard
 * could not read. Collapsing them would leave an agent unable to tell "fix your
 * request" from "stop asking".
 */
function dispatchFailure(name: string, err: unknown): Response {
  const message = messageOf(err);
  if (REFUSAL_PREFIXES.some((prefix) => message.startsWith(prefix))) {
    return fail(403, "forbidden", message);
  }
  if (MALFORMED_PREFIXES.some((prefix) => message.startsWith(prefix))) {
    return fail(400, "bad_request", message);
  }
  log.error(`Agent dispatch of '${name}' failed unexpectedly:`, err);
  return fail(500, "internal_error", message);
}

/** Parse a JSON body, bounded, returning either the value or the 400. */
async function readJsonBody(
  req: Request
): Promise<{ value: unknown } | { error: Response }> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return {
      error: fail(413, "payload_too_large", `Body exceeds ${MAX_BODY_BYTES} bytes.`),
    };
  }
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) {
    return {
      error: fail(413, "payload_too_large", `Body exceeds ${MAX_BODY_BYTES} bytes.`),
    };
  }
  if (text.trim().length === 0) {
    return { error: fail(400, "bad_request", "Body must be a JSON object of { name, payload }.") };
  }
  try {
    return { value: JSON.parse(text) };
  } catch (err) {
    return {
      error: fail(400, "bad_request", `Body is not valid JSON: ${(err as Error).message}`),
    };
  }
}

/**
 * The `{ sessionId }` a `POST /sessions` body may carry, `null` when the
 * body is absent (the headless call), or the 400 for a body that is present
 * but not of that shape.
 *
 * Absent means *no bytes*: an explicit `{}` is a body and is read as one,
 * which yields `null` too — a caller spelling "headless" longhand is not an
 * error. Only a `sessionId` that is present and not a non-empty string is.
 */
async function readAttachTarget(
  req: Request
): Promise<{ sessionId: string | null } | { error: Response }> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return {
      error: fail(413, "payload_too_large", `Body exceeds ${MAX_BODY_BYTES} bytes.`),
    };
  }
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) {
    return {
      error: fail(413, "payload_too_large", `Body exceeds ${MAX_BODY_BYTES} bytes.`),
    };
  }
  if (text.trim().length === 0) return { sessionId: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      error: fail(400, "bad_request", `Body is not valid JSON: ${(err as Error).message}`),
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      error: fail(400, "bad_request", "Body must be empty or a JSON object of { sessionId? }."),
    };
  }
  const { sessionId } = parsed as { sessionId?: unknown };
  if (sessionId === undefined || sessionId === null) return { sessionId: null };
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return {
      error: fail(400, "bad_request", "'sessionId' must be a non-empty string when present."),
    };
  }
  return { sessionId };
}

/**
 * Compose the OpenAPI document from the manifest.
 *
 * Every description and every argument schema is copied out of `McpTool` —
 * none is re-derived — so the two documents cannot say different things about
 * the same tool. What the manifest cannot supply is the *dispatch* name: MCP
 * names are `[a-zA-Z0-9_-]`, so `agent_manifest` publishes the built-ins as
 * `hypen_navigate` / `hypen_back` / `hypen_set_input`, while the guard accepts
 * only the dotted external spellings and refuses anything starting `hypen_`
 * outright. Documenting the MCP spelling as the REST `name` would therefore
 * document a call that 403s.
 *
 * So names come from `listActions()` — the same list `mcp_manifest` drives its
 * tools from — and each is paired with its tool by exact name, or, for a
 * built-in, by the dotted-to-underscore spelling. That pairing is a reverse
 * lookup over a live finite list, not a naming rule: it cannot be ambiguous,
 * because the reserved floor refuses any module action named `hypen_*`, which
 * is precisely why that prefix is reserved.
 */
export function buildOpenApi(
  manifest: McpManifest,
  actions: ListedAction[],
  basePath: string,
  options: { requiresToken?: boolean } = {}
): Record<string, unknown> {
  const byName = new Map(manifest.tools.map((tool) => [tool.name, tool]));
  const dispatchable = actions.map((action) => {
    const tool =
      byName.get(action.name) ??
      (action.builtin ? byName.get(action.name.replaceAll(".", "_")) : undefined);
    return { action, tool };
  });

  const variants = dispatchable.map(({ action, tool }) => ({
    type: "object",
    title: tool?.title ?? action.name,
    description: tool?.description,
    properties: {
      name: { const: action.name },
      payload: tool?.inputSchema ?? { type: "object", additionalProperties: true },
    },
    required: ["name"],
    additionalProperties: false,
    ...(tool ? { "x-hypen-mcp-tool": tool.name } : {}),
    ...(action.module ? { "x-hypen-module": action.module } : {}),
  }));

  // An app that declares nothing still has a well-formed body schema; `oneOf`
  // with no branches matches nothing and would make the document unusable.
  const dispatchBody =
    variants.length > 0
      ? { oneOf: variants }
      : {
          type: "object",
          properties: { name: { type: "string" }, payload: {} },
          required: ["name"],
        };

  const readablePaths = dedupe(
    manifest.resources.map((r) => asString(r._meta?.["dev.hypen/statePath"]))
  );
  const readableModules = dedupe(
    manifest.resources.map((r) => asString(r._meta?.["dev.hypen/module"]))
  );

  const errorSchema = {
    type: "object",
    properties: { error: { type: "string" }, message: { type: "string" } },
    required: ["error", "message"],
  };
  const errorResponse = (description: string) => ({
    description,
    content: { "application/json": { schema: errorSchema } },
  });
  // Documented on every route only when the surface is actually gated;
  // an open surface never answers 401, and a document promising one would
  // be describing a server that does not exist.
  const unauthorizedResponse = options.requiresToken
    ? {
        "401": errorResponse(
          "Missing or wrong bearer token. Identical on every route, so it " +
            "confirms nothing about any session id."
        ),
      }
    : {};
  const revisionSchema = {
    type: "integer",
    minimum: 0,
    description:
      "Settlement cursor: the session's render counter at the time of this " +
      "response. Monotonic per session and moved only by a render that " +
      "produced patches; compare only against values from the same session.",
  };

  return {
    openapi: "3.1.0",
    info: {
      title: "Hypen agent surface",
      version: manifest.protocolVersion,
      description: manifest.instructions,
    },
    ...(options.requiresToken
      ? {
          components: {
            securitySchemes: {
              bearerAuth: { type: "http", scheme: "bearer" },
            },
          },
          security: [{ bearerAuth: [] }],
        }
      : {}),
    paths: {
      [`${basePath}/manifest`]: {
        get: {
          summary: "The app's MCP manifest, verbatim.",
          responses: { "200": { description: "MCP manifest." }, ...unauthorizedResponse },
        },
      },
      [`${basePath}/openapi.json`]: {
        get: {
          summary: "This document, generated from the manifest.",
          responses: { "200": { description: "OpenAPI document." }, ...unauthorizedResponse },
        },
      },
      [`${basePath}/sessions`]: {
        post: {
          summary: "Open an agent session — headless, or attached to a live user session.",
          description:
            "With no body (or no 'sessionId'), opens a headless session: a fresh " +
            "engine sandboxed to the caller. With { sessionId }, attaches to the " +
            "live user session that id names, so dispatches run on the user's " +
            "engine and the user's client receives the resulting patches. " +
            "Attaching requires the server's authorize callback to allow this " +
            "request; every refusal answers 404 unknown_session.",
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    sessionId: {
                      type: "string",
                      description:
                        "Id of the live user session to attach to, as its client " +
                        "received it in sessionAck. Omit for a headless session.",
                    },
                  },
                  additionalProperties: false,
                },
              },
            },
          },
          responses: {
            "201": {
              description: "Session opened. The returned id is a fresh agent id, never the user's session id.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      sessionId: { type: "string" },
                      attached: {
                        type: "boolean",
                        description: "Present and true when attached to a live user session.",
                      },
                      revision: revisionSchema,
                    },
                    required: ["sessionId", "revision"],
                  },
                },
              },
            },
            "400": errorResponse("Malformed body."),
            ...unauthorizedResponse,
            "404": errorResponse(
              "Attach refused: not authorised, or no live session with that id. " +
                "The two are deliberately indistinguishable."
            ),
            "503": errorResponse("Too many open agent sessions."),
          },
        },
      },
      [`${basePath}/sessions/{sessionId}/dispatch`]: {
        post: {
          summary: "Dispatch one declared action.",
          description:
            "Authorised by the engine's external guard. A successful call means " +
            "the action was delivered, not that its handler finished. The " +
            "returned revision is read after the dispatch returns: every later " +
            "read of this session reports a revision at or above it, and one " +
            "strictly above it has observed a render since. A refused dispatch " +
            "moves the revision by nothing.",
          parameters: [sessionIdParam()],
          requestBody: {
            required: true,
            content: { "application/json": { schema: dispatchBody } },
          },
          responses: {
            "200": {
              description: "Delivered.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { dispatched: { type: "string" }, revision: revisionSchema },
                    required: ["dispatched", "revision"],
                  },
                },
              },
            },
            "400": errorResponse("Malformed body, or a payload the guard could not read."),
            ...unauthorizedResponse,
            "403": errorResponse("The guard refused this name or target."),
            "404": errorResponse("No such session."),
          },
        },
      },
      [`${basePath}/sessions/{sessionId}/state`]: {
        get: {
          summary: "Read a declared state path.",
          description:
            "Bounded by the paths the template renders. Omit 'path' for the whole " +
            "declared surface, projected down to those paths.",
          parameters: [
            sessionIdParam(),
            {
              name: "module",
              in: "query",
              required: false,
              description: "Omit for the primary module.",
              schema: readableModules.length > 0
                ? { type: "string", enum: readableModules }
                : { type: "string" },
            },
            {
              name: "path",
              in: "query",
              required: false,
              schema: readablePaths.length > 0
                ? { type: "string", enum: readablePaths }
                : { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "The value.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      module: { type: ["string", "null"] },
                      path: { type: ["string", "null"] },
                      value: {},
                      revision: revisionSchema,
                    },
                    required: ["module", "path", "value", "revision"],
                  },
                },
              },
            },
            ...unauthorizedResponse,
            "404": errorResponse("No such session, or nothing readable at that path."),
          },
        },
      },
    },
    // Carried through so what the app declared but could not publish is not
    // lost in translation between the two documents.
    "x-hypen-degraded": manifest.degraded,
  };
}

function sessionIdParam() {
  return {
    name: "sessionId",
    in: "path",
    required: true,
    schema: { type: "string" },
  };
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function dedupe(values: Array<string | null>): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (value !== null && !out.includes(value)) out.push(value);
  }
  return out;
}
