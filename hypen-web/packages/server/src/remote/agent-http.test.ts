/**
 * The agent REST surface, exercised end-to-end over a real Bun server.
 *
 * What is being asserted is the engine's rule, not this module's plumbing:
 * nothing is reachable through HTTP that the app did not declare, and the
 * framework's own internals are not reachable at all. Every case here has a
 * counterpart in `hypen-engine-rs/src/agent.rs`'s test module — the point of
 * repeating them at this boundary is that a transport is exactly where a guard
 * gets accidentally routed around.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { portable } from "@hypen-space/core/portable";
import { RemoteServer } from "./server.ts";
import { AgentSurface, buildOpenApi, type McpManifest } from "./agent-http.ts";
import { AgentSessionGoneError } from "./agent-handle.ts";
import {
  AsyncQueueTransport,
  type OutgoingMessage,
  type RemoteSession,
} from "./session.ts";
import { app } from "@hypen-space/core/app";

/**
 * `packages/cf/tests` null core's portable impl in `afterEach` and never put it
 * back, so in a whole-suite run every file that happens to sort after them
 * loses `diffState` — and a handler mutating state then throws inside the state
 * proxy, nowhere near this surface. Re-run the server package's install side
 * effect when that has happened; the specifier is cache-busted because the
 * module is already in the registry and a plain re-import is a no-op.
 */
beforeAll(async () => {
  try {
    portable.pathGet({ probe: 1 }, "probe");
  } catch {
    // Through a variable so the query string is not a specifier TypeScript
    // has to resolve — it is a cache key for the runtime, not a real path.
    const reinstall = "../install-portable.ts?reinstall-for-agent-http-tests";
    await import(reinstall);
  }
});

/**
 * One module body wrapped in a single root: `ast_to_ir_node` lowers a module
 * to its FIRST child, so unwrapped siblings never reach the IR and the
 * declarations hanging off them never exist.
 *
 * Declares, in order: a rendered state path, a `.bind()` field (also a
 * rendered path, via the `value` binding the bind lowers to), a route table,
 * and an action call site. `authToken` is in state and in no template, which
 * is what makes it the negative case for the read surface.
 */
const UI = `module Agent {
  Column {
    Text("Total: @{state.total}")
    Input(placeholder: "Name").bind(@state.name)
    Router { Route(path: "/cart") { Text("cart") } }
    Button("Add").onClick(@actions.addToCart)
  }
}`;

function agentModule() {
  return app
    .defineState<{ total: number; name: string; authToken: string }>({
      total: 4780,
      name: "",
      authToken: "sekrit",
    })
    .onAction("addToCart", ({ state }) => {
      state.total += 1;
    })
    .build();
}

const ENABLED_PORT = 19941;
const DISABLED_PORT = 19942;
const CAPPED_PORT = 19943;
const ATTACH_NO_AUTH_PORT = 19944;
const ATTACH_PORT = 19945;
const ATTACH_SYNC_PORT = 19946;
const ATTACH_MULTI_PORT = 19947;
const TOKEN_PORT = 19948;
const TOKEN_OPEN_PORT = 19949;

type Json = Record<string, any>;

async function readJson(res: Response): Promise<Json> {
  return (await res.json()) as Json;
}

/**
 * The read surface is the engine's, not this module's: `agent_core::get_state`
 * serves a path only when the template renders it. A 200 here therefore does
 * not mean the transport leaked — it means the engine underneath has no read
 * gating, which is true of any `wasm-node` artifact built before commit
 * f2d41a6 ("gate reads on what the template actually renders"). Say so, rather
 * than leaving a bare 404-vs-200 to be misread as a bug in the routing.
 */
function expectNotReadable(res: Response, path: string): void {
  if (res.status === 200) {
    throw new Error(
      `GET state?path=${path} returned 200. The undeclared path is readable, so ` +
        `the engine behind this build has no read gating — rebuild the WASM ` +
        `artifact (cd hypen-engine-rs && ./build-wasm.sh) and re-run.`
    );
  }
  expect(res.status).toBe(404);
}

describe("agent surface — explicit enablement", () => {
  let server: RemoteServer;

  beforeAll(async () => {
    server = await new RemoteServer()
      .module("Agent", agentModule())
      .ui(UI)
      .listen(DISABLED_PORT);
  });

  afterAll(() => server.stop());

  test("is absent until .agent() is called", async () => {
    const base = `http://localhost:${DISABLED_PORT}/__hypen__/agent`;

    const manifest = await fetch(`${base}/manifest`);
    const sessions = await fetch(`${base}/sessions`, { method: "POST" });

    // Not 404-with-an-agent-error, not 405: the surface leaves no trace at
    // all, so these land on the same catch-all any unknown path does. A probe
    // cannot distinguish "disabled" from "this server has never heard of it".
    for (const res of [manifest, sessions]) {
      expect(res.headers.get("content-type")).not.toContain("application/json");
      expect(await res.text()).toBe("Hypen Remote Server");
    }
  });
});

describe("agent surface", () => {
  let server: RemoteServer;
  const base = `http://localhost:${ENABLED_PORT}/__hypen__/agent`;
  let sessionId: string;

  const dispatch = (name: unknown, payload?: unknown) =>
    fetch(`${base}/sessions/${sessionId}/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload === undefined ? { name } : { name, payload }),
    });

  const read = (query: string) =>
    fetch(`${base}/sessions/${sessionId}/state${query}`);

  /**
   * Action handlers are async and the engine does not await them, so a 200
   * from dispatch means "delivered" and nothing more. Poll rather than sleep.
   */
  async function readBodyUntil(query: string, predicate: (value: unknown) => boolean) {
    for (let attempt = 0; attempt < 50; attempt++) {
      const res = await read(query);
      if (res.ok) {
        const body = await readJson(res);
        if (predicate(body.value)) return body;
      } else {
        await res.text();
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`state at ${query} never satisfied the predicate`);
  }

  async function readUntil(query: string, predicate: (value: unknown) => boolean) {
    return (await readBodyUntil(query, predicate)).value;
  }

  /** The settlement cursor a read of `total` reports right now. */
  async function revisionNow(): Promise<number> {
    const body = await readJson(await read("?path=total"));
    expect(typeof body.revision).toBe("number");
    return body.revision;
  }

  beforeAll(async () => {
    server = await new RemoteServer()
      .module("Agent", agentModule())
      .ui(UI)
      .agent()
      .listen(ENABLED_PORT);

    const res = await fetch(`${base}/sessions`, { method: "POST" });
    expect(res.status).toBe(201);
    const opened = await readJson(res);
    sessionId = opened.sessionId;
    expect(typeof sessionId).toBe("string");
    // A headless session has rendered once by the time its id is handed
    // out, and the engine's counter counts that render — so the cursor a
    // caller starts from is never 0.
    expect(opened.revision).toBeGreaterThanOrEqual(1);
  });

  afterAll(() => server.stop());

  test("a declared action dispatches and its handler runs", async () => {
    const res = await dispatch("addToCart");
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.dispatched).toBe("addToCart");
    expect(typeof body.revision).toBe("number");

    expect(await readUntil("?path=total", (v) => v === 4781)).toBe(4781);
  });

  test("__hypen_bind is refused, whatever payload it carries", async () => {
    const before = await revisionNow();
    const res = await dispatch("__hypen_bind", { path: "authToken", value: "stolen" });

    expect(res.status).toBe(403);
    const body = await readJson(res);
    expect(body.error).toBe("forbidden");
    // The engine's own message, not a paraphrase.
    expect(body.message).toContain("__hypen_bind");
    // An error envelope carries no cursor — there was no dispatch to
    // settle — and the session's own cursor did not move.
    expect(body.revision).toBeUndefined();
    expect(await revisionNow()).toBe(before);

    // And the arbitrary write it would have performed did not happen.
    const after = await read("?path=authToken");
    expectNotReadable(after, "authToken");
    await after.text();
  });

  test("router.replace is refused — the built-in table withholds it deliberately", async () => {
    const res = await dispatch("router.replace", { to: "/admin" });
    expect(res.status).toBe(403);
    expect((await readJson(res)).error).toBe("forbidden");
  });

  test("set_input refuses an undeclared field and accepts a declared one", async () => {
    const undeclared = await dispatch("hypen.set_input", {
      field: "authToken",
      value: "stolen",
    });
    expect(undeclared.status).toBe(403);
    expect((await readJson(undeclared)).message).toContain("authToken");

    const declared = await dispatch("hypen.set_input", { field: "name", value: "Ada" });
    expect(declared.status).toBe(200);
    expect(await readUntil("?path=name", (v) => v === "Ada")).toBe("Ada");
  });

  test("a gated read serves declared paths and not an undeclared one", async () => {
    const total = await read("?path=total");
    expect(total.status).toBe(200);
    expect((await readJson(total)).value).toBe(4781);

    // `authToken` is in the module's state and in no template, so it was never
    // shown to the user and is not shown to an agent acting for them either.
    const token = await read("?path=authToken");
    expectNotReadable(token, "authToken");
    expect((await readJson(token)).error).toBe("not_readable");

    // The whole-tree read is projected down to the declared paths rather than
    // refused — an agent still gets a usable picture, minus the token.
    const whole = await read("");
    expect(whole.status).toBe(200);
    const value = (await readJson(whole)).value;
    expect(value.total).toBe(4781);
    expect(value.name).toBe("Ada");
    expect(value.authToken).toBeUndefined();
  });

  test("dispatch returns a settlement cursor every later read is at-or-above", async () => {
    // The problem this solves: dispatch says "delivered", the handler is
    // async, and a caller could not tell "ran and changed nothing" from
    // "still running". The cursor is where the counter stood once the
    // dispatch returned; a read above it has seen a render since.
    const before = await revisionNow();

    const res = await dispatch("addToCart");
    expect(res.status).toBe(200);
    const { revision: cursor } = await readJson(res);
    expect(cursor).toBeGreaterThanOrEqual(before);

    const settled = await readBodyUntil("?path=total", (v) => v === 4782);
    expect(settled.revision).toBeGreaterThanOrEqual(cursor);
    // The read that observed the effect necessarily observed the render
    // that carried it, so it is strictly past where the caller started.
    expect(settled.revision).toBeGreaterThan(before);

    // Idle: nothing renders on its own, so the cursor holds still.
    expect(await revisionNow()).toBe(settled.revision);
  });

  test("a malformed request is 400, kept apart from a refusal", async () => {
    // No payload at all: the guard could not read the call, rather than
    // refusing it. A caller has to be able to tell "fix your request" from
    // "stop asking".
    const noPayload = await dispatch("hypen.set_input");
    expect(noPayload.status).toBe(400);
    expect((await readJson(noPayload)).error).toBe("bad_request");

    const noName = await fetch(`${base}/sessions/${sessionId}/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: {} }),
    });
    expect(noName.status).toBe(400);

    const notJson = await fetch(`${base}/sessions/${sessionId}/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ not json",
    });
    expect(notJson.status).toBe(400);
  });

  test("an unknown session is 404, not 403", async () => {
    const dispatched = await fetch(`${base}/sessions/nope/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "addToCart" }),
    });
    expect(dispatched.status).toBe(404);
    expect((await readJson(dispatched)).error).toBe("unknown_session");

    const readRes = await fetch(`${base}/sessions/nope/state?path=total`);
    expect(readRes.status).toBe(404);
    expect((await readJson(readRes)).error).toBe("unknown_session");
  });

  test("the wrong verb is 405, not a silent success", async () => {
    const res = await fetch(`${base}/sessions`);
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
    await res.text();
  });

  test("manifest and openapi answer together, and openapi never precedes it", async () => {
    const manifest = await fetch(`${base}/manifest`);
    const openapi = await fetch(`${base}/openapi.json`);

    // `Engine::mcp_manifest()` exists in the Rust core but has no
    // `#[wasm_bindgen]` wrapper, so no JS host can reach it. Until that
    // binding lands both routes report the gap rather than one of them
    // inventing a manifest — which is exactly the drift they exist to avoid.
    if (manifest.status === 503) {
      expect((await readJson(manifest)).error).toBe("manifest_unavailable");
      expect(openapi.status).toBe(503);
      expect((await readJson(openapi)).error).toBe("manifest_unavailable");
      return;
    }

    expect(manifest.status).toBe(200);
    const body = await readJson(manifest);
    expect(typeof body.protocolVersion).toBe("string");
    expect(Array.isArray(body.tools)).toBe(true);

    expect(openapi.status).toBe(200);
    const doc = await readJson(openapi);
    expect(doc.info.version).toBe(body.protocolVersion);
    expect(doc.paths[`/__hypen__/agent/sessions/{sessionId}/dispatch`]).toBeDefined();
  });
});

describe("agent surface — session ceiling", () => {
  let server: RemoteServer;

  beforeAll(async () => {
    server = await new RemoteServer()
      .module("Agent", agentModule())
      .ui(UI)
      .agent({ maxSessions: 1 })
      .listen(CAPPED_PORT);
  });

  afterAll(() => server.stop());

  test("POST /sessions is bounded — it allocates an engine per call", async () => {
    const base = `http://localhost:${CAPPED_PORT}/__hypen__/agent`;

    const first = await fetch(`${base}/sessions`, { method: "POST" });
    expect(first.status).toBe(201);
    await first.json();

    const second = await fetch(`${base}/sessions`, { method: "POST" });
    expect(second.status).toBe(503);
    expect((await readJson(second)).error).toBe("session_limit");
  });
});

/**
 * `buildOpenApi` is pure, so it is tested against a hand-built manifest rather
 * than through the server — which also means these assertions hold today,
 * while the engine still exports no `mcpManifest()` binding.
 *
 * The fixture mirrors `McpManifest`'s serde output: camelCase everywhere,
 * `_meta` verbatim, and the built-ins under the MCP spellings
 * `agent_manifest::BUILTIN_TOOL_NAMES` assigns them.
 */
describe("buildOpenApi", () => {
  const manifest: McpManifest = {
    protocolVersion: "2025-06-18",
    instructions: "This server drives one running Hypen application.",
    tools: [
      {
        name: "addToCart",
        title: "addToCart",
        description: "Dispatch the app's 'addToCart' action.",
        inputSchema: { type: "object", properties: { sku: { type: "string" } } },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
        _meta: { "dev.hypen/enforcement": "advisory" },
      },
      {
        name: "hypen_navigate",
        title: "Navigate",
        description: "Move the app to one of its declared routes. Declared: /cart.",
        inputSchema: { type: "object", properties: { to: { enum: ["/cart"] } } },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
        _meta: { "dev.hypen/enforcement": "guard", "dev.hypen/routes": ["/cart"] },
      },
    ],
    resources: [
      {
        uri: "hypen://state/agent/total",
        name: "agent.total",
        title: "total",
        description: "Value of 'total' in the 'agent' module's state.",
        mimeType: "application/json",
        _meta: { "dev.hypen/module": null, "dev.hypen/statePath": "total" },
      },
    ],
    resourceTemplates: [],
    degraded: [{ kind: "tool", name: "add to cart!", reason: "not an MCP tool name" }],
  };

  const actions = [
    { name: "addToCart", module: null, builtin: false },
    { name: "hypen.navigate", module: null, builtin: true },
  ];

  const doc = buildOpenApi(manifest, actions, "/__hypen__/agent") as any;
  const variants =
    doc.paths["/__hypen__/agent/sessions/{sessionId}/dispatch"].post.requestBody
      .content["application/json"].schema.oneOf;

  test("documents the name the guard accepts, not the MCP spelling", () => {
    // The whole reason names come from `listActions()` rather than from
    // `tool.name`: `hypen_navigate` starts with a reserved prefix and would be
    // refused outright, so documenting it would document a call that 403s.
    const names = variants.map((v: any) => v.properties.name.const);
    expect(names).toEqual(["addToCart", "hypen.navigate"]);
  });

  test("copies each tool's schema rather than re-deriving one", () => {
    const navigate = variants.find(
      (v: any) => v.properties.name.const === "hypen.navigate"
    );
    expect(navigate.properties.payload).toBe(manifest.tools[1]!.inputSchema);
    expect(navigate["x-hypen-mcp-tool"]).toBe("hypen_navigate");
    expect(navigate.description).toBe(manifest.tools[1]!.description);
  });

  test("bounds the readable paths by the manifest's resources", () => {
    const params =
      doc.paths["/__hypen__/agent/sessions/{sessionId}/state"].get.parameters;
    const path = params.find((p: any) => p.name === "path");
    expect(path.schema.enum).toEqual(["total"]);
    // `dev.hypen/module` is null for the primary module — addressed by
    // omission, which no enum entry can spell.
    const moduleParam = params.find((p: any) => p.name === "module");
    expect(moduleParam.schema.enum).toBeUndefined();
  });

  test("carries the manifest's version, prose and degradations through", () => {
    expect(doc.info.version).toBe("2025-06-18");
    expect(doc.info.description).toBe(manifest.instructions);
    expect(doc["x-hypen-degraded"]).toEqual(manifest.degraded);
  });

  test("an app declaring nothing still yields a usable body schema", () => {
    const empty = buildOpenApi(
      { ...manifest, tools: [], resources: [] },
      [],
      "/__hypen__/agent"
    ) as any;
    const schema =
      empty.paths["/__hypen__/agent/sessions/{sessionId}/dispatch"].post.requestBody
        .content["application/json"].schema;
    expect(schema.oneOf).toBeUndefined();
    expect(schema.required).toEqual(["name"]);
  });
});

// ── attach mode ────────────────────────────────────────────────────────────
//
// What is being asserted here is the co-pilot promise and its two guard
// rails. The promise: a dispatch through an attached agent id lands on the
// user's own transport as exactly the message a click would have produced.
// The rails: nobody attaches without the app's say-so, and nothing an agent
// does — including going idle, or the server shutting the surface down — can
// end the user's session.

/**
 * A user's browser, as the test sees it: one live session on an in-memory
 * transport, and everything that transport has received.
 *
 * Messages are pumped into `inbox` by a background loop so a read that times
 * out never leaves a dangling iterator waiter to swallow the next message.
 * Reads poll with a bounded loop rather than sleeping for a fixed time.
 */
class LiveUser {
  readonly transport = new AsyncQueueTransport();
  readonly inbox: OutgoingMessage[] = [];
  session!: RemoteSession;
  sessionId!: string;
  private cursor = 0;

  static async connect(
    server: RemoteServer,
    hello: Record<string, unknown> = {}
  ): Promise<LiveUser> {
    const user = new LiveUser();
    // `helloGraceMs: null`: the test sends hello itself, and the legacy
    // auto-init timer would otherwise be a stray handle.
    user.session = server.createSession(user.transport, { helloGraceMs: null });
    void (async () => {
      for await (const msg of user.transport.stream()) user.inbox.push(msg);
    })();
    await user.session.receive(JSON.stringify({ type: "hello", ...hello }));
    await user.session.ready;
    const ack = await user.next();
    expect(ack.type).toBe("sessionAck");
    const tree = await user.next();
    expect(tree.type).toBe("initialTree");
    user.sessionId = (ack as { sessionId: string }).sessionId;
    return user;
  }

  /** The next message this user has not yet read. */
  async next(): Promise<OutgoingMessage> {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (this.cursor < this.inbox.length) return this.inbox[this.cursor++]!;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("no message reached the user's transport");
  }

  /**
   * Nothing arrives within the window. A negative cannot be polled to
   * completion, so this is the one place a fixed wait is used — and it is
   * a wait, not a `Date.now()` comparison.
   */
  async expectSilent(ms = 100): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
    expect(this.inbox.slice(this.cursor)).toEqual([]);
  }
}

function postSessions(base: string, body?: unknown): Promise<Response> {
  return fetch(`${base}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function dispatchAs(base: string, agentId: string, name: string, payload?: unknown) {
  return fetch(`${base}/sessions/${agentId}/dispatch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload === undefined ? { name } : { name, payload }),
  });
}

/**
 * The bytes an unknown *agent* id gets on any route of this server — the
 * canonical `unknown_session` body every attach refusal must match exactly.
 */
async function unknownSessionBodyFor(base: string, id: string): Promise<string> {
  const res = await fetch(`${base}/sessions/${id}/state?path=total`);
  expect(res.status).toBe(404);
  return res.text();
}

/** Poll a bounded loop until the predicate holds. */
async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("agent surface — attach mode", () => {
  let noAuth: RemoteServer;
  let server: RemoteServer;
  let user: LiveUser;
  let agentId: string;
  const noAuthBase = `http://localhost:${ATTACH_NO_AUTH_PORT}/__hypen__/agent`;
  const base = `http://localhost:${ATTACH_PORT}/__hypen__/agent`;

  /** Swapped per test; the server holds only the indirection. */
  let decide: (req: Request, sessionId: string) => boolean | Promise<boolean> = () => false;
  const seen: Array<{ method: string; sessionId: string }> = [];

  beforeAll(async () => {
    noAuth = await new RemoteServer()
      .module("Agent", agentModule())
      .ui(UI)
      .agent()
      .listen(ATTACH_NO_AUTH_PORT);
    server = await new RemoteServer()
      .module("Agent", agentModule())
      .ui(UI)
      .agent({
        authorize: (req, sessionId) => {
          seen.push({ method: req.method, sessionId });
          return decide(req, sessionId);
        },
      })
      .listen(ATTACH_PORT);
    user = await LiveUser.connect(server);
  });

  afterAll(() => {
    noAuth.stop();
    server.stop();
  });

  test("every refusal is the byte-identical unknown_session 404", async () => {
    // No authorizer configured — against a REAL live session on that server,
    // so this is a refusal of a valid id, not a miss.
    const bystander = await LiveUser.connect(noAuth);
    const noAuthorizer = await postSessions(noAuthBase, { sessionId: bystander.sessionId });
    expect(noAuthorizer.status).toBe(404);
    expect(await noAuthorizer.text()).toBe(
      await unknownSessionBodyFor(noAuthBase, bystander.sessionId)
    );

    // Authorizer says no.
    decide = () => false;
    const refused = await postSessions(base, { sessionId: user.sessionId });
    expect(refused.status).toBe(404);
    const refusedBody = await refused.text();
    expect(refusedBody).toBe(await unknownSessionBodyFor(base, user.sessionId));
    // And it was asked, with the request and the id.
    expect(seen.at(-1)).toEqual({ method: "POST", sessionId: user.sessionId });

    // Authorizer throws — a refusal, not a 500 that says "there is an
    // authorizer and it is broken".
    decide = () => {
      throw new Error("boom");
    };
    const threw = await postSessions(base, { sessionId: user.sessionId });
    expect(threw.status).toBe(404);
    expect(await threw.text()).toBe(refusedBody);

    // Authorizer says yes, but no live session has that id.
    decide = () => true;
    const unknown = await postSessions(base, { sessionId: "nope" });
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toBe(await unknownSessionBodyFor(base, "nope"));

    // None of that reached the user, or moved the session.
    await user.expectSilent();
    await bystander.expectSilent();
    expect(user.session.revision).toBe(0);
    expect(user.session.isDestroyed).toBe(false);
    expect(bystander.session.isDestroyed).toBe(false);
  });

  test("a malformed attach body is 400, and an empty one is headless", async () => {
    decide = () => true;
    const notAString = await postSessions(base, { sessionId: 42 });
    expect(notAString.status).toBe(400);
    expect((await readJson(notAString)).error).toBe("bad_request");

    const notAnObject = await postSessions(base, ["x"]);
    expect(notAnObject.status).toBe(400);
    await notAnObject.text();

    // Today's call, unchanged: no body ⇒ a headless session, and no
    // `attached` flag to mistake for one.
    const headless = await postSessions(base);
    expect(headless.status).toBe(201);
    const body = await readJson(headless);
    expect(typeof body.sessionId).toBe("string");
    expect(body.attached).toBeUndefined();
  });

  test("an authorized attach mints a fresh agent id, never the user's", async () => {
    decide = () => true;
    const res = await postSessions(base, { sessionId: user.sessionId });
    expect(res.status).toBe(201);
    const body = await readJson(res);
    expect(body.attached).toBe(true);
    expect(typeof body.sessionId).toBe("string");
    // The user's id is the resume token for their saved state; the agent id
    // is a REST handle. Handing one out as the other is a capability leak.
    expect(body.sessionId).not.toBe(user.sessionId);
    // An attached cursor is the user's own outgoing revision — the number
    // on the last patch their browser received, which is none so far.
    expect(body.revision).toBe(user.session.revision);
    expect(body.revision).toBe(0);
    agentId = body.sessionId;
  });

  test("a dispatch lands on the user's transport as the patch a click would send", async () => {
    const res = await dispatchAs(base, agentId, "addToCart");
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.dispatched).toBe("addToCart");
    // Read after dispatch returned: the handler is async, so the render
    // may or may not have happened yet — either is at-or-below the patch.
    expect([0, 1]).toContain(body.revision);

    // The browser-side proof: the next thing the user's client receives is
    // the streamed patch, revision 1, carrying the new total.
    const msg = await user.next();
    expect(msg.type).toBe("patch");
    expect((msg as { revision: number }).revision).toBe(1);
    expect(JSON.stringify(msg)).toContain("4781");
    expect(user.session.revision).toBe(1);

    // And the read side agrees, through the same agent id — value and
    // cursor both, the cursor being the very revision the browser saw.
    const state = await fetch(`${base}/sessions/${agentId}/state?path=total`);
    expect(state.status).toBe(200);
    const read = await readJson(state);
    expect(read.value).toBe(4781);
    expect(read.revision).toBe(1);
  });

  test("a refusal reaches the user's transport as nothing at all", async () => {
    const res = await dispatchAs(base, agentId, "__hypen_bind", {
      path: "authToken",
      value: "stolen",
    });
    expect(res.status).toBe(403);
    expect((await readJson(res)).error).toBe("forbidden");

    await user.expectSilent();
    expect(user.session.revision).toBe(1);

    // The read surface is the user's, gated exactly as it is for them.
    const token = await fetch(`${base}/sessions/${agentId}/state?path=authToken`);
    expectNotReadable(token, "authToken");
    await token.text();
  });

  test("stop() drops the record and leaves the user's session alive", async () => {
    // A headless session on the same surface is the positive control: it IS
    // destroyed by dispose, and its teardown is what the poll waits for.
    const headless = await postSessions(base);
    expect(headless.status).toBe(201);
    await headless.text();
    const before = server.getClientCount();
    expect(before).toBeGreaterThanOrEqual(2);

    server.stop();

    await until(
      () => server.getClientCount() < before,
      "the headless agent session to be torn down"
    );
    // Everything the surface owned is gone; the one thing it never owned is
    // exactly as it was.
    await until(
      () => server.getClientCount() === 1,
      "only the user's session to remain"
    );
    expect(user.session.isDestroyed).toBe(false);
    expect(user.session.isReady).toBe(true);
    expect(user.session.revision).toBe(1);
    await user.expectSilent();
  });
});

describe("agent surface — attach mode, in-process", () => {
  let server: RemoteServer;
  let user: LiveUser;

  beforeAll(async () => {
    server = new RemoteServer().module("Agent", agentModule()).ui(UI);
    await server.prepare();
    user = await LiveUser.connect(server);
  });

  afterAll(() => server.stop());

  /** Drive an `AgentSurface` directly, no port. */
  function call(
    surface: AgentSurface,
    method: string,
    path: string,
    body?: unknown
  ): Promise<Response | null> {
    const req = new Request(`http://agent.test/__hypen__/agent${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return surface.handle(req, new URL(req.url));
  }

  test("server.attach() binds to a ready session and to nothing else", async () => {
    expect(server.attach("nope")).toBeNull();

    // Created but never hello'd: no id, no declaration tables, no handle.
    const pending = server.createSession(new AsyncQueueTransport(), { helloGraceMs: null });
    expect(pending.isReady).toBe(false);
    expect(server.attach(String(pending.sessionId))).toBeNull();
    await pending.destroy();

    const handle = server.attach(user.sessionId);
    expect(handle).not.toBeNull();
    expect(handle!.sessionId).toBe(user.sessionId);
    expect(handle!.alive).toBe(true);
    expect(handle!.revision()).toBe(0);
    expect(handle!.listActions().map((a) => a.name)).toContain("addToCart");

    // The `AgentEngine`-shaped view routes back through the handle.
    const engine = handle!.engine;
    expect(typeof engine.mcpManifest).toBe("function");
    expect(typeof engine.dispatchExternal).toBe("function");
    expect(typeof engine.getStateAt).toBe("function");
    expect(engine.getRevision()).toBe(0);
    expect(engine.getStateAt(null, "total")).toBe(4780);
    expect(() => engine.dispatchExternal("router.replace", { to: "/x" })).toThrow();
    await user.expectSilent();
    expect(handle!.revision()).toBe(0);
  });

  test("an idle sweep drops an attached record without touching the session", async () => {
    // `idleTimeoutMs: 0` — a record is stale the moment it is created, so
    // the sweep at the top of the NEXT request drops it. Deterministic:
    // `lastSeen` can never be later than the clock that reads it.
    const surface = new AgentSurface(server, { idleTimeoutMs: 0, authorize: () => true });

    const attached = await call(surface, "POST", "/sessions", { sessionId: user.sessionId });
    expect(attached!.status).toBe(201);
    const agentId = (await readJson(attached!)).sessionId;

    const headless = await call(surface, "POST", "/sessions");
    expect(headless!.status).toBe(201);
    await headless!.text();
    const before = server.getClientCount();

    const swept = await call(surface, "GET", `/sessions/${agentId}/state?path=total`);
    expect(swept!.status).toBe(404);
    expect((await readJson(swept!)).error).toBe("unknown_session");

    // The headless one was destroyed by that same sweep …
    await until(() => server.getClientCount() === before - 1, "the headless sweep");
    // … and the user's was not.
    expect(user.session.isDestroyed).toBe(false);
    expect(user.session.isReady).toBe(true);
    expect(server.attach(user.sessionId)).not.toBeNull();
    await user.expectSilent();
  });

  test("dispose() destroys only what the surface opened", async () => {
    const surface = new AgentSurface(server, { authorize: () => true });
    const attached = await call(surface, "POST", "/sessions", { sessionId: user.sessionId });
    expect(attached!.status).toBe(201);
    await attached!.text();
    const headless = await call(surface, "POST", "/sessions");
    expect(headless!.status).toBe(201);
    await headless!.text();
    const before = server.getClientCount();

    await surface.dispose();

    expect(server.getClientCount()).toBe(before - 1);
    expect(user.session.isDestroyed).toBe(false);
    expect(user.session.isReady).toBe(true);
  });

  test("a handle outlives its session only as a thrown AgentSessionGoneError", async () => {
    const doomed = await LiveUser.connect(server);
    const surface = new AgentSurface(server, { authorize: () => true });
    const attached = await call(surface, "POST", "/sessions", { sessionId: doomed.sessionId });
    expect(attached!.status).toBe(201);
    const agentId = (await readJson(attached!)).sessionId;
    const handle = server.attach(doomed.sessionId)!;
    expect(handle.alive).toBe(true);

    // The user closes the tab. The session tears itself down as it always
    // has; the handle had no say in it and has nothing to do about it.
    await doomed.session.destroy();

    expect(handle.alive).toBe(false);
    expect(() => handle.dispatch("addToCart")).toThrow(AgentSessionGoneError);
    expect(() => handle.getState(null, "total")).toThrow(AgentSessionGoneError);
    expect(() => handle.revision()).toThrow(AgentSessionGoneError);
    expect(server.attach(doomed.sessionId)).toBeNull();

    // Over REST the id is now as good as unknown — and forgotten.
    const dispatched = await call(surface, "POST", `/sessions/${agentId}/dispatch`, {
      name: "addToCart",
    });
    expect(dispatched!.status).toBe(404);
    expect((await readJson(dispatched!)).error).toBe("unknown_session");
    const read = await call(surface, "GET", `/sessions/${agentId}/state?path=total`);
    expect(read!.status).toBe(404);
    expect((await readJson(read!)).error).toBe("unknown_session");
    await surface.dispose();
  });
});

describe("agent surface — attach mode under syncActions", () => {
  let server: RemoteServer;
  const base = `http://localhost:${ATTACH_SYNC_PORT}/__hypen__/agent`;

  beforeAll(async () => {
    server = await new RemoteServer()
      .module("Agent", agentModule())
      .ui(UI)
      .syncActions()
      .agent({ authorize: () => true })
      .listen(ATTACH_SYNC_PORT);
  });

  afterAll(() => server.stop());

  test("mirrors a dispatch to every live session, and a refusal to none", async () => {
    const a = await LiveUser.connect(server);
    const b = await LiveUser.connect(server);
    expect(a.sessionId).not.toBe(b.sessionId);

    const attached = await postSessions(base, { sessionId: a.sessionId });
    expect(attached.status).toBe(201);
    const agentId = (await readJson(attached)).sessionId;

    const res = await dispatchAs(base, agentId, "addToCart");
    expect(res.status).toBe(200);
    await res.text();

    // Exactly what a click on A does under syncActions: A re-renders, and
    // so does B, each on its own transport with its own revision.
    for (const peer of [a, b]) {
      const msg = await peer.next();
      expect(msg.type).toBe("patch");
      expect((msg as { revision: number }).revision).toBe(1);
      expect(JSON.stringify(msg)).toContain("4781");
    }
    expect(b.session.engine.getStateAt(null, "total")).toBe(4781);

    const refused = await dispatchAs(base, agentId, "__hypen_bind", {
      path: "total",
      value: 0,
    });
    expect(refused.status).toBe(403);
    await refused.text();
    await a.expectSilent();
    await b.expectSilent();
    expect(a.session.revision).toBe(1);
    expect(b.session.revision).toBe(1);
  });
});

describe("agent surface — attach mode under allow-multiple", () => {
  let server: RemoteServer;
  const base = `http://localhost:${ATTACH_MULTI_PORT}/__hypen__/agent`;

  beforeAll(async () => {
    server = await new RemoteServer()
      .module("Agent", agentModule())
      .ui(UI)
      .session({ concurrent: "allow-multiple" })
      .agent({ authorize: () => true })
      .listen(ATTACH_MULTI_PORT);
  });

  afterAll(() => server.stop());

  test("both peers of one session receive the patch", async () => {
    const first = await LiveUser.connect(server);
    const second = await LiveUser.connect(server, { sessionId: first.sessionId });
    expect(second.sessionId).toBe(first.sessionId);

    const attached = await postSessions(base, { sessionId: first.sessionId });
    expect(attached.status).toBe(201);
    const agentId = (await readJson(attached)).sessionId;

    const res = await dispatchAs(base, agentId, "addToCart");
    expect(res.status).toBe(200);
    await res.text();

    // One render, fanned out by the session's own streaming callback — the
    // same path a click on either tab takes.
    for (const peer of [first, second]) {
      const msg = await peer.next();
      expect(msg.type).toBe("patch");
      expect((msg as { revision: number }).revision).toBe(1);
      expect(JSON.stringify(msg)).toContain("4781");
    }
  });
});

// ── bearer token ───────────────────────────────────────────────────────────
//
// `token` gates the whole surface; `authorize` gates attach on top of it.
// The claims: an open surface is byte-for-byte what it was; a gated one
// answers 401 to every route without the exact token, with a body that says
// nothing about any session id; and holding the token buys no attach.

describe("agent surface — bearer token", () => {
  const TOKEN = "s3cret-agent-token";
  let gated: RemoteServer;
  let open: RemoteServer;
  const base = `http://localhost:${TOKEN_PORT}/__hypen__/agent`;
  const openBase = `http://localhost:${TOKEN_OPEN_PORT}/__hypen__/agent`;
  let agentId: string;

  const bearer = (token: string): Record<string, string> => ({
    Authorization: `Bearer ${token}`,
  });

  beforeAll(async () => {
    gated = await new RemoteServer()
      .module("Agent", agentModule())
      .ui(UI)
      .agent({ token: TOKEN })
      .listen(TOKEN_PORT);
    open = await new RemoteServer()
      .module("Agent", agentModule())
      .ui(UI)
      .agent()
      .listen(TOKEN_OPEN_PORT);
  });

  afterAll(() => {
    gated.stop();
    open.stop();
  });

  test("no token configured ⇒ unchanged, whatever header a caller sends", async () => {
    const bare = await fetch(`${openBase}/sessions`, { method: "POST" });
    expect(bare.status).toBe(201);
    await bare.text();

    // A stray credential is neither required nor checked on an open surface.
    const stray = await fetch(`${openBase}/sessions`, {
      method: "POST",
      headers: bearer("whatever"),
    });
    expect(stray.status).toBe(201);
    await stray.text();

    const manifest = await fetch(`${openBase}/manifest`);
    expect(manifest.status).not.toBe(401);
    expect(manifest.headers.get("WWW-Authenticate")).toBeNull();
    await manifest.text();
  });

  test("every route is 401 without the token or with a wrong one", async () => {
    const routes: Array<[string, RequestInit]> = [
      ["/manifest", {}],
      ["/openapi.json", {}],
      ["/sessions", { method: "POST" }],
      // The wrong verb, too: the gate runs before the method guard.
      ["/sessions", {}],
      [
        "/sessions/nope/dispatch",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "addToCart" }),
        },
      ],
      ["/sessions/nope/state?path=total", {}],
      ["/nothing-here", {}],
    ];
    const credentials: Array<Record<string, string> | undefined> = [
      undefined,
      bearer("wrong"),
      // Same length, one byte off; and the token as a prefix.
      bearer(TOKEN.slice(0, -1) + "X"),
      bearer(`${TOKEN}x`),
      { Authorization: `Basic ${btoa(TOKEN)}` },
      { Authorization: TOKEN },
    ];
    for (const [path, init] of routes) {
      for (const headers of credentials) {
        const res = await fetch(`${base}${path}`, {
          ...init,
          headers: { ...((init.headers as Record<string, string>) ?? {}), ...(headers ?? {}) },
        });
        expect(res.status).toBe(401);
        expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
        expect((await readJson(res)).error).toBe("unauthorized");
      }
    }
  });

  test("the correct token opens the whole surface", async () => {
    const opened = await fetch(`${base}/sessions`, { method: "POST", headers: bearer(TOKEN) });
    expect(opened.status).toBe(201);
    const body = await readJson(opened);
    agentId = body.sessionId;
    expect(typeof agentId).toBe("string");
    expect(typeof body.revision).toBe("number");

    const dispatched = await fetch(`${base}/sessions/${agentId}/dispatch`, {
      method: "POST",
      headers: { ...bearer(TOKEN), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "addToCart" }),
    });
    expect(dispatched.status).toBe(200);
    expect((await readJson(dispatched)).dispatched).toBe("addToCart");

    // The scheme is case-insensitive (RFC 6750); the credential is not.
    const lowerScheme = await fetch(`${base}/sessions/${agentId}/state?path=total`, {
      headers: { Authorization: `bearer ${TOKEN}` },
    });
    expect(lowerScheme.status).toBe(200);
    await lowerScheme.text();
    const upperToken = await fetch(`${base}/sessions/${agentId}/state?path=total`, {
      headers: bearer(TOKEN.toUpperCase()),
    });
    expect(upperToken.status).toBe(401);
    await upperToken.text();

    const manifest = await fetch(`${base}/manifest`, { headers: bearer(TOKEN) });
    expect(manifest.status).not.toBe(401);
    await manifest.text();
    const openapi = await fetch(`${base}/openapi.json`, { headers: bearer(TOKEN) });
    expect(openapi.status).not.toBe(401);
    if (openapi.status === 200) {
      // A gated surface documents its gate; an open one does not (see the
      // pure `buildOpenApi` tests for that side).
      const doc = await readJson(openapi);
      expect(doc.security).toEqual([{ bearerAuth: [] }]);
      expect(doc.paths[`/__hypen__/agent/sessions`].post.responses["401"]).toBeDefined();
    } else {
      await openapi.text();
    }
  });

  test("the 401 body does not leak whether a session id exists", async () => {
    // `agentId` is live; `nope` is not. Without the token the two are
    // indistinguishable — same status, same headers, same bytes.
    const real = await fetch(`${base}/sessions/${agentId}/state?path=total`);
    const fake = await fetch(`${base}/sessions/nope/state?path=total`);
    expect(real.status).toBe(401);
    expect(fake.status).toBe(401);
    expect(await real.text()).toBe(await fake.text());

    // With it, they are exactly as different as they should be.
    const realAuthed = await fetch(`${base}/sessions/${agentId}/state?path=total`, {
      headers: bearer(TOKEN),
    });
    const fakeAuthed = await fetch(`${base}/sessions/nope/state?path=total`, {
      headers: bearer(TOKEN),
    });
    expect(realAuthed.status).toBe(200);
    expect(fakeAuthed.status).toBe(404);
    await realAuthed.text();
    await fakeAuthed.text();
  });

  test("holding the token is not a grant to attach: authorize still runs on top", async () => {
    const user = await LiveUser.connect(gated);
    const seen: string[] = [];
    const surface = new AgentSurface(gated, {
      token: TOKEN,
      authorize: (_req, sessionId) => {
        seen.push(sessionId);
        return false;
      },
    });
    const attach = (headers: Record<string, string>) => {
      const req = new Request(`http://agent.test/__hypen__/agent/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ sessionId: user.sessionId }),
      });
      return surface.handle(req, new URL(req.url));
    };

    // No token: 401, and `authorize` was never consulted — the gate is in
    // front of it, not beside it.
    const noToken = await attach({});
    expect(noToken!.status).toBe(401);
    await noToken!.text();
    expect(seen).toEqual([]);

    // Token, but `authorize` says no: the usual unknown_session 404.
    const refused = await attach(bearer(TOKEN));
    expect(refused!.status).toBe(404);
    expect((await readJson(refused!)).error).toBe("unknown_session");
    expect(seen).toEqual([user.sessionId]);
    await user.expectSilent();
    await surface.dispose();
  });

  test("an empty token is a configuration error, not an open surface", () => {
    expect(() => new AgentSurface(gated, { token: "" })).toThrow(/non-empty/);
  });
});

describe("buildOpenApi — bearer token", () => {
  const manifest: McpManifest = {
    protocolVersion: "2025-06-18",
    instructions: "x",
    tools: [],
    resources: [],
    resourceTemplates: [],
    degraded: [],
  };

  test("documents the gate only when there is one, and the cursor always", () => {
    const open = buildOpenApi(manifest, [], "/__hypen__/agent") as any;
    expect(open.security).toBeUndefined();
    expect(open.components).toBeUndefined();
    expect(open.paths["/__hypen__/agent/manifest"].get.responses["401"]).toBeUndefined();

    const gated = buildOpenApi(manifest, [], "/__hypen__/agent", { requiresToken: true }) as any;
    expect(gated.security).toEqual([{ bearerAuth: [] }]);
    expect(gated.components.securitySchemes.bearerAuth).toEqual({ type: "http", scheme: "bearer" });
    for (const route of Object.values(gated.paths) as any[]) {
      for (const op of Object.values(route) as any[]) {
        expect(op.responses["401"]).toBeDefined();
      }
    }

    for (const doc of [open, gated]) {
      const ok = (path: string, verb: string) =>
        doc.paths[`/__hypen__/agent/${path}`][verb].responses[verb === "post" && path === "sessions" ? "201" : "200"]
          .content["application/json"].schema;
      expect(ok("sessions", "post").required).toContain("revision");
      expect(ok("sessions/{sessionId}/dispatch", "post").required).toContain("revision");
      expect(ok("sessions/{sessionId}/state", "get").required).toContain("revision");
      expect(ok("sessions/{sessionId}/state", "get").properties.revision.type).toBe("integer");
    }
  });
});

describe("buildOpenApi — attach mode", () => {
  const manifest: McpManifest = {
    protocolVersion: "2025-06-18",
    instructions: "x",
    tools: [],
    resources: [],
    resourceTemplates: [],
    degraded: [],
  };
  const doc = buildOpenApi(manifest, [], "/__hypen__/agent") as any;
  const post = doc.paths["/__hypen__/agent/sessions"].post;

  test("documents the optional sessionId body, the attached flag and the 404", () => {
    expect(post.requestBody.required).toBe(false);
    const schema = post.requestBody.content["application/json"].schema;
    expect(schema.properties.sessionId.type).toBe("string");
    expect(post.responses["201"].content["application/json"].schema.properties.attached.type).toBe(
      "boolean"
    );
    expect(post.responses["404"]).toBeDefined();
  });
});
