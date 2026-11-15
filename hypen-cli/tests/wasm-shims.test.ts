/**
 * The wasm-build shims, tested as the source files they are:
 *  - the TS shim (`src/wasm/shims/module-shim.ts`) by importing it and
 *    driving its exports with a fake module definition and fake host imports;
 *  - the generated per-module entry by bundling it the way the build does;
 *  - the Go shim template by rendering it and syntax-checking the result.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "bun";
import { renderGoShim, tsShimEntrySource } from "../src/build-wasm.js";
import { goShimTemplatePath, tsShimPath } from "../src/wasm/assets.js";
import {
  ModuleHttpError,
  createModuleExports,
  type DeferredHttpImports,
  type ShimContext,
  type ShimHttp,
  type WitHttpRequest,
  type EngineStateImports,
  type ModuleDefinitionLike,
  type ShimActionHandler,
  type ShimLifecycleHandler,
} from "../src/wasm/shims/module-shim.js";

const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const dec = (b: Uint8Array | undefined) => JSON.parse(new TextDecoder().decode(b));
const NO_PAYLOAD = new Uint8Array();

/** A componentize-js style variant error thrown by a WIT import. */
const componentError = (tag: string, val?: string) =>
  Object.assign(new Error("ComponentError"), { payload: val === undefined ? { tag } : { tag, val } });

/** A fake `hypen:engine/state` host recording subscriptions. */
function fakeHost(read: EngineStateImports["read"] = (id) => {
  throw new Error("read not stubbed: " + id);
}) {
  const subscribed: Array<[string, string, string]> = [];
  const host: EngineStateImports = {
    read,
    subscribe: (module, path, onChange) => {
      subscribed.push([module, path, onChange]);
    },
  };
  return { host, subscribed };
}

/** A fake module definition with the given action handlers. */
function fakeModule(
  handlers: Record<string, ShimActionHandler>,
  lifecycle: Partial<Record<"onActivated" | "onDeactivated" | "onDestroyed", ShimLifecycleHandler>> = {},
  initialState: unknown = { count: 0 }
): ModuleDefinitionLike {
  return {
    initialState,
    actions: Object.keys(handlers),
    handlers: { onAction: new Map(Object.entries(handlers)), ...lifecycle },
  };
}

/** The value an export throws (exports signal `err(string)` by throwing a string). */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected the call to throw");
}

describe("TS shim: world exports", () => {
  test("exposes exactly the hypen:module exports", () => {
    const m = createModuleExports(fakeModule({ a: () => {} }), fakeHost().host);
    expect(Object.keys(m).sort()).toEqual(
      ["actions", "dispatch", "init", "onActivated", "onDeactivated", "onDestroyed"].sort()
    );
    expect(m.actions()).toEqual(["a"]);
  });

  test("dispatch runs the handler on the decoded state and returns the mutated state", () => {
    const seen: unknown[] = [];
    const m = createModuleExports(
      fakeModule({
        add: ({ action, state }) => {
          seen.push(action);
          state.count = (state.count as number) + (action.payload as { by: number }).by;
        },
      }),
      fakeHost().host
    );
    const out = m.dispatch(enc({ count: 1 }), { name: "add", payload: enc({ by: 4 }) });
    expect(dec(out.state)).toEqual({ count: 5 });
    expect(out.effects).toEqual([]);
    expect(out.emit).toEqual([]);
    expect(seen).toEqual([{ name: "add", payload: { by: 4 }, sender: undefined }]);
    // An empty payload decodes to null; empty state bytes to {}.
    const empty = createModuleExports(
      fakeModule({ probe: ({ action, state }) => { state.payload = action.payload; } }),
      fakeHost().host
    ).dispatch(NO_PAYLOAD, { name: "probe", payload: NO_PAYLOAD });
    expect(dec(empty.state)).toEqual({ payload: null });
  });

  test("an unknown action is err(string), not a trap", () => {
    const m = createModuleExports(fakeModule({}), fakeHost().host);
    expect(thrownBy(() => m.dispatch(enc({}), { name: "nope", payload: NO_PAYLOAD }))).toBe(
      "unknown action: nope"
    );
  });

  test("context.emit queues follow-up actions on the reducer output", () => {
    const m = createModuleExports(
      fakeModule({ go: ({ context }) => { context.emit("next", { n: 1 }); context.emit("bare"); } }),
      fakeHost().host
    );
    const out = m.dispatch(enc({}), { name: "go", payload: NO_PAYLOAD });
    expect(out.emit.map((a) => [a.name, dec(a.payload)])).toEqual([
      ["next", { n: 1 }],
      ["bare", null],
    ]);
  });
});

describe("TS shim: init", () => {
  test("no config (empty bytes, {}, non-object) returns initialState untouched", () => {
    const m = createModuleExports(fakeModule({}, {}, { count: 0, label: "hi" }), fakeHost().host);
    expect(dec(m.init(NO_PAYLOAD))).toEqual({ count: 0, label: "hi" });
    expect(dec(m.init(enc({})))).toEqual({ count: 0, label: "hi" });
    expect(dec(m.init(enc(null)))).toEqual({ count: 0, label: "hi" });
    expect(dec(m.init(enc([1, 2])))).toEqual({ count: 0, label: "hi" });
    expect(dec(m.init(enc(7)))).toEqual({ count: 0, label: "hi" });
  });

  test("declaration-site config shallow-merges over initialState", () => {
    // `module X(count: 7)` → config {"count":7}.
    const m = createModuleExports(fakeModule({}, {}, { count: 0, label: "hi" }), fakeHost().host);
    expect(dec(m.init(enc({ count: 7 })))).toEqual({ count: 7, label: "hi" });
    expect(dec(m.init(enc({ extra: [1] })))).toEqual({ count: 0, label: "hi", extra: [1] });
    // A missing initialState still seeds from config.
    const bare = createModuleExports({ ...fakeModule({}), initialState: undefined }, fakeHost().host);
    expect(dec(bare.init(enc({ a: 1 })))).toEqual({ a: 1 });
    expect(dec(bare.init(NO_PAYLOAD))).toBeNull();
  });
});

describe("TS shim: lifecycle", () => {
  test("an absent handler is a no-op output (state: none)", () => {
    const m = createModuleExports(fakeModule({}), fakeHost().host);
    expect(m.onActivated(enc({ count: 2 }))).toEqual({ state: undefined, effects: [], emit: [] });
    expect(m.onDeactivated(enc({ count: 2 }))).toEqual({ state: undefined, effects: [], emit: [] });
    expect(m.onDestroyed(enc({ count: 2 }))).toBeUndefined();
  });

  test("handlers mutate state, and may emit and navigate", () => {
    const m = createModuleExports(
      fakeModule(
        {},
        {
          onActivated: (state, context) => {
            state.visits = ((state.visits as number) ?? 0) + 1;
            context.emit("refresh");
            context.router.navigate("/home");
          },
          onDeactivated: (state) => {
            state.left = true;
          },
        }
      ),
      fakeHost().host
    );
    const on = m.onActivated(enc({ visits: 1 }));
    expect(dec(on.state)).toEqual({ visits: 2 });
    expect(on.emit.map((a) => a.name)).toEqual(["refresh"]);
    expect(on.effects).toEqual([{ tag: "navigate", val: "/home" }]);
    expect(dec(m.onDeactivated(enc({})).state)).toEqual({ left: true });
  });

  test("onDestroyed runs the handler and returns nothing (its emits are dropped)", () => {
    let seen: unknown;
    const m = createModuleExports(
      fakeModule({}, { onDestroyed: (state, context) => { seen = { ...state }; context.emit("late"); } }),
      fakeHost().host
    );
    expect(m.onDestroyed(enc({ count: 3 }))).toBeUndefined();
    expect(seen).toEqual({ count: 3 });
  });
});

describe("TS shim: router", () => {
  test("push/replace/navigate emit the WIT navigate effect", () => {
    const m = createModuleExports(
      fakeModule({
        go: ({ context }) => {
          context.router.push("/a");
          context.router.replace("/b");
          context.router.navigate("/c");
        },
      }),
      fakeHost().host
    );
    expect(m.dispatch(enc({ count: 0 }), { name: "go", payload: NO_PAYLOAD }).effects).toEqual([
      { tag: "navigate", val: "/a" },
      { tag: "navigate", val: "/b" },
      { tag: "navigate", val: "/c" },
    ]);
  });

  test("unwired router members and non-string paths fail with a clear error", () => {
    const m = createModuleExports(
      fakeModule({
        // The SDK's HypenRouter has `back`; the wasm target does not wire it.
        back: ({ context }) => { (context.router as unknown as { back(): void }).back(); },
        bad: ({ context }) => { context.router.push(42 as unknown as string); },
        // Awaiting the router must not look like a thenable.
        thenable: ({ state, context }) => { state.then = typeof (context.router as unknown as { then?: unknown }).then; },
      }),
      fakeHost().host
    );
    expect(thrownBy(() => m.dispatch(enc({}), { name: "back", payload: NO_PAYLOAD }))).toMatch(
      /context\.router\.back is not supported on the wasm target yet/
    );
    expect(thrownBy(() => m.dispatch(enc({}), { name: "bad", payload: NO_PAYLOAD }))).toBe(
      "router navigation needs a path string on the wasm target"
    );
    expect(dec(m.dispatch(enc({}), { name: "thenable", payload: NO_PAYLOAD }).state)).toEqual({
      then: "undefined",
    });
  });
});

describe("TS shim: cross-module state", () => {
  test("getModule / getGlobalState read a sibling through hypen:engine/state", () => {
    const reads: string[] = [];
    const { host } = fakeHost((id) => {
      reads.push(id);
      return enc({ items: [id] });
    });
    const m = createModuleExports(
      fakeModule({
        read: ({ state, context }) => {
          state.a = context.getModule("catalog").state;
          state.b = context.getModule("cart").getState();
          state.c = context.getGlobalState().user;
          state.ids = context.getModuleIds();
        },
      }),
      host
    );
    expect(dec(m.dispatch(enc({}), { name: "read", payload: NO_PAYLOAD }).state)).toEqual({
      a: { items: ["catalog"] },
      b: { items: ["cart"] },
      c: { items: ["user"] },
      ids: [],
    });
    expect(reads).toEqual(["catalog", "cart", "user"]);
  });

  test("hasModule: not-found is false, permission-denied throws, present is true", () => {
    const { host } = fakeHost((id) => {
      if (id === "missing") throw componentError("not-found");
      if (id === "secret") throw componentError("permission-denied", "reads");
      return enc({ ok: true });
    });
    const m = createModuleExports(
      fakeModule({ probe: ({ state, context }) => { state.result = context.hasModule(state.target as string); } }),
      host
    );
    const probe = (target: string) =>
      dec(m.dispatch(enc({ target }), { name: "probe", payload: NO_PAYLOAD }).state).result;
    expect(probe("catalog")).toBe(true);
    expect(probe("missing")).toBe(false);
    const denied = thrownBy(() => probe("secret"));
    expect(denied).toMatch(/context\.hasModule\("secret"\): permission denied/);
    // The message says how to fix it.
    expect(denied).toMatch(/wasm\.modules\.<ThisModule>\.reads in hypen\.json/);
  });

  test("context.on subscribes; its unsubscribe throws (the WIT has no unsubscribe)", () => {
    const { host, subscribed } = fakeHost();
    const m = createModuleExports(
      fakeModule({
        sub: ({ context }) => { context.on("catalog", "items", "refresh"); },
        subRoot: ({ context }) => { context.on("catalog", undefined, "refresh"); },
        subUnsub: ({ context }) => { context.on("catalog", "", "refresh")(); },
      }),
      host
    );
    m.dispatch(enc({}), { name: "sub", payload: NO_PAYLOAD });
    m.dispatch(enc({}), { name: "subRoot", payload: NO_PAYLOAD });
    expect(subscribed).toEqual([
      ["catalog", "items", "refresh"],
      ["catalog", "", "refresh"],
    ]);
    expect(thrownBy(() => m.dispatch(enc({}), { name: "subUnsub", payload: NO_PAYLOAD }))).toMatch(
      /unsubscribing from context\.on\(\.\.\.\) is not supported on the wasm target/
    );
  });

  test("cross-module writes and data sources fail loudly", () => {
    const m = createModuleExports(
      fakeModule({
        write: ({ context }) => { context.getModule("cart").setState(); },
        data: ({ dataSources }) => { void dataSources.db; },
      }),
      fakeHost(() => enc({})).host
    );
    expect(thrownBy(() => m.dispatch(enc({}), { name: "write", payload: NO_PAYLOAD }))).toMatch(
      /setState is not supported on the wasm target yet/
    );
    expect(thrownBy(() => m.dispatch(enc({}), { name: "data", payload: NO_PAYLOAD }))).toBe(
      "data sources are not supported on the wasm target yet"
    );
  });
});

describe("TS shim: guard() turns failures into err(string)", () => {
  // componentize-js maps a thrown string to the export's err(string), but
  // re-throws an Error instance as a trap that kills the component instance.
  const { host } = fakeHost(() => {
    throw componentError("permission-denied", "reads");
  });
  const m = createModuleExports(
    fakeModule(
      {
        boom: () => { throw new Error("kaboom"); },
        str: () => { throw "plain"; },
        obj: () => { throw { code: 7 }; },
        blank: () => { throw new Error(""); },
        readDenied: ({ context }) => { void context.getModule("secret").state; },
      },
      { onActivated: () => { throw new TypeError("bad activate"); } }
    ),
    host
  );
  const fail = (name: string) => thrownBy(() => m.dispatch(enc({}), { name, payload: NO_PAYLOAD }));

  test("Error → its message; string → itself; other values → JSON", () => {
    expect(fail("boom")).toBe("kaboom");
    expect(fail("str")).toBe("plain");
    expect(fail("obj")).toBe('{"code":7}');
    // An Error with no message still yields a non-empty string.
    expect(fail("blank")).toBe("Error");
  });

  test("a host capability error carries the WIT variant", () => {
    expect(fail("readDenied")).toBe('host capability error: {"tag":"permission-denied","val":"reads"}');
  });

  test("lifecycle exports and init are guarded too", () => {
    expect(thrownBy(() => m.onActivated(enc({})))).toBe("bad activate");
    expect(typeof thrownBy(() => m.init(new TextEncoder().encode("{not json")))).toBe("string");
  });
});

describe("TS shim: async handlers are rejected, not silently dropped", () => {
  const m = createModuleExports(
    fakeModule(
      { later: async ({ state }) => { state.count = 1; } },
      { onActivated: async () => {}, onDestroyed: async () => {} }
    ),
    fakeHost().host
  );

  test("an async action handler", () => {
    expect(thrownBy(() => m.dispatch(enc({}), { name: "later", payload: NO_PAYLOAD }))).toBe(
      'async handlers are not supported on the wasm target yet (action handler "later" returned a Promise)'
    );
  });

  test("async lifecycle handlers", () => {
    expect(thrownBy(() => m.onActivated(enc({})))).toMatch(/async handlers are not supported.*onActivated/);
    expect(thrownBy(() => m.onDestroyed(enc({})))).toMatch(/async handlers are not supported.*onDestroyed/);
  });

  test("the handler's eventual rejection is swallowed (no unhandled rejection)", async () => {
    const rejecting = createModuleExports(
      fakeModule({ later: async () => { throw new Error("late failure"); } }),
      fakeHost().host
    );
    expect(thrownBy(() => rejecting.dispatch(enc({}), { name: "later", payload: NO_PAYLOAD }))).toMatch(
      /async handlers are not supported/
    );
    // If the rejection escaped, bun would fail this test as unhandled.
    await new Promise((r) => setTimeout(r, 10));
  });
});

describe("TS shim: context.http (hypen:http/deferred)", () => {
  type Sent = { request: WitHttpRequest; then: string; tag: string | undefined };

  /** A fake `hypen:http/deferred` import recording what was queued. */
  function fakeHttp(refuse?: (sent: Sent) => { tag: string; val?: string } | undefined) {
    const sent: Sent[] = [];
    const http: DeferredHttpImports = {
      send(request, then, tag) {
        const call = { request, then, tag };
        const refusal = refuse?.(call);
        if (refusal) throw componentError(refusal.tag, refusal.val);
        sent.push(call);
      },
    };
    return { http, sent };
  }

  /** Run `use(context.http)` inside a `load` action of a module that also handles `loaded`. */
  function inHandler(options: Parameters<typeof createModuleExports>[2], use: (http: ShimHttp, context: ShimContext) => void) {
    const m = createModuleExports(
      fakeModule({ load: ({ context }) => use(context.http, context), loaded: () => {} }),
      fakeHost().host,
      options
    );
    return () => m.dispatch(enc({ count: 0 }), { name: "load", payload: NO_PAYLOAD });
  }

  const text = (bytes: Uint8Array | undefined) => (bytes ? new TextDecoder().decode(bytes) : undefined);

  test("get queues a GET and names the completion action; nothing else leaves the reducer", () => {
    const { http, sent } = fakeHttp();
    const out = inHandler({ name: "Weather", http }, (h) => {
      expect(h.get("https://api.example.com/forecast?city=Oslo", { then: "loaded", tag: "oslo" })).toBeUndefined();
    })();
    expect(sent).toEqual([
      {
        request: {
          method: "GET",
          url: "https://api.example.com/forecast?city=Oslo",
          headers: [],
          body: undefined,
          timeoutMs: undefined,
        },
        then: "loaded",
        tag: "oslo",
      },
    ]);
    // The request is not an effect and not an emit: the host carries it.
    expect(out.effects).toEqual([]);
    expect(out.emit).toEqual([]);
  });

  test("get passes headers and a time budget", () => {
    const { http, sent } = fakeHttp();
    inHandler({ http }, (h) =>
      h.get("https://api.example.com/", { then: "loaded", headers: { accept: "application/json" }, timeoutMs: 2500 })
    )();
    expect(sent[0]!.request).toMatchObject({ headers: [["accept", "application/json"]], timeoutMs: 2500 });
    expect(sent[0]!.tag).toBeUndefined();
  });

  test("send: an object body is JSON with a content-type, unless one is set", () => {
    const { http, sent } = fakeHttp();
    inHandler({ http }, (h) => {
      h.send({ url: "https://api.example.com/items", body: { name: "kettle", qty: 2 } }, { then: "loaded" });
      h.send(
        { url: "https://api.example.com/items", body: [1, 2], headers: { "Content-Type": "application/vnd.api+json" } },
        { then: "loaded" }
      );
    })();
    expect(sent[0]!.request.method).toBe("POST"); // a body makes the default method POST
    expect(text(sent[0]!.request.body)).toBe('{"name":"kettle","qty":2}');
    expect(sent[0]!.request.headers).toEqual([["content-type", "application/json"]]);
    expect(text(sent[1]!.request.body)).toBe("[1,2]");
    expect(sent[1]!.request.headers).toEqual([["Content-Type", "application/vnd.api+json"]]);
  });

  test("send: a string body is UTF-8 text; bytes are sent as they are; no body is none", () => {
    const { http, sent } = fakeHttp();
    const bytes = new Uint8Array([0, 255, 7]);
    inHandler({ http }, (h) => {
      h.send({ method: "PUT", url: "https://api.example.com/note", body: "héllo" }, { then: "loaded" });
      h.send({ method: "PUT", url: "https://api.example.com/blob", body: bytes, headers: [["x-kind", "raw"]] }, { then: "loaded" });
      h.send({ method: "DELETE", url: "https://api.example.com/note" }, { then: "loaded" });
      h.send({ url: "https://api.example.com/note", body: null }, { then: "loaded" });
    })();
    expect(sent.map((s) => s.request.method)).toEqual(["PUT", "PUT", "DELETE", "GET"]);
    expect(text(sent[0]!.request.body)).toBe("héllo");
    expect(sent[0]!.request.headers).toEqual([["content-type", "text/plain;charset=UTF-8"]]);
    expect(sent[1]!.request.body).toBe(bytes);
    expect(sent[1]!.request.headers).toEqual([["x-kind", "raw"]]);
    expect(sent[2]!.request.body).toBeUndefined();
    expect(sent[3]!.request.body).toBeUndefined();
  });

  test("without the http grant the helper says which field to add — and names the module", () => {
    let caught: unknown;
    const run = inHandler({ name: "Weather" }, (h) => {
      try {
        h.get("https://api.example.com/", { then: "loaded" });
      } catch (e) {
        caught = e;
        throw e;
      }
    });
    // Uncaught, it is the handler's failure, readable by the host.
    expect(thrownBy(run)).toBe(
      'context.http: this module has no `http` grant — add "http": true under wasm.modules.Weather in hypen.json'
    );
    expect(caught).toBeInstanceOf(ModuleHttpError);
    expect(caught).toMatchObject({ name: "ModuleHttpError", code: "not-granted", detail: "this module has no `http` grant" });
    // Still present on the context (so `context.http.get` is never a TypeError).
    const m = createModuleExports(fakeModule({ probe: ({ context, state }) => void (state.has = typeof context.http.send) }), fakeHost().host);
    expect(dec(m.dispatch(enc({}), { name: "probe", payload: NO_PAYLOAD }).state)).toEqual({ has: "function" });
  });

  test("the host's refusals become typed errors a handler can branch on", () => {
    const refusals: Array<[variant: { tag: string; val?: string }, code: string, message: string]> = [
      [
        { tag: "permission-denied", val: "host 'evil.test:443' is not in the manifest's `httpHosts` allowlist" },
        "permission-denied",
        "context.http.send: permission-denied: host 'evil.test:443' is not in the manifest's `httpHosts` allowlist — add the host to wasm.modules.Weather.httpHosts in hypen.json",
      ],
      [
        { tag: "invalid-request", val: "invalid url: must be absolute and start with http:// or https://" },
        "invalid-request",
        "context.http.send: invalid-request: invalid url: must be absolute and start with http:// or https://",
      ],
      [
        { tag: "limit-exceeded", val: "too many requests in one call (limit 16)" },
        "limit-exceeded",
        "context.http.send: limit-exceeded: too many requests in one call (limit 16)",
      ],
    ];
    for (const [variant, code, message] of refusals) {
      const { http } = fakeHttp(() => variant);
      const state: { error?: unknown } = {};
      const m = createModuleExports(
        fakeModule({
          load: ({ context, state: s }) => {
            try {
              context.http.get("https://evil.test/", { then: "loaded" });
            } catch (e) {
              state.error = e;
              // A handler that catches keeps running: the state it returns stands.
              s.failed = (e as ModuleHttpError).code;
            }
          },
          loaded: () => {},
        }),
        fakeHost().host,
        { name: "Weather", http }
      );
      const out = m.dispatch(enc({}), { name: "load", payload: NO_PAYLOAD });
      expect(dec(out.state)).toEqual({ failed: code });
      expect(state.error).toBeInstanceOf(ModuleHttpError);
      expect(state.error).toMatchObject({ code, message, detail: variant.val });
    }
  });

  test("an error the host did not define is not dressed up as an HTTP refusal", () => {
    const { http } = fakeHttp(() => ({ tag: "something-new", val: "?" }));
    expect(thrownBy(inHandler({ http }, (h) => h.get("https://api.example.com/", { then: "loaded" })))).toBe(
      'host capability error: {"tag":"something-new","val":"?"}'
    );
  });

  test("mistakes only the shim can see are refused before the host is asked", () => {
    const cases: Array<[label: string, use: (h: ShimHttp) => void, message: string]> = [
      [
        "a `then` that is not one of the module's actions",
        (h) => h.get("https://api.example.com/", { then: "lodaed" }),
        'context.http.send: `then: "lodaed"` is not an action of this module (it handles: load, loaded) — add .onAction("lodaed", …) to receive the response',
      ],
      [
        "no completion target",
        (h) => h.get("https://api.example.com/", undefined as never),
        'context.http.send: `then` is missing: name the action that receives the response, e.g. { then: "loaded" }',
      ],
      ["no url", (h) => h.send({} as never, { then: "loaded" }), "context.http.send: the request needs a `url` string"],
      [
        "a fractional timeout",
        (h) => h.send({ url: "https://api.example.com/", timeoutMs: 1.5 }, { then: "loaded" }),
        "context.http.send: `timeoutMs` must be a whole number of milliseconds",
      ],
      [
        "a non-string header value",
        (h) => h.send({ url: "https://api.example.com/", headers: { "x-n": 1 as never } }, { then: "loaded" }),
        "context.http.send: every header needs a string name and a string value",
      ],
      [
        "a body JSON cannot carry",
        (h) => h.send({ url: "https://api.example.com/", body: { n: 1n } }, { then: "loaded" }),
        "context.http.send: `body` is not JSON-serialisable",
      ],
      [
        "a non-string tag",
        (h) => h.get("https://api.example.com/", { then: "loaded", tag: 7 as never }),
        "context.http.send: `tag` must be a string",
      ],
    ];
    for (const [label, use, message] of cases) {
      const { http, sent } = fakeHttp();
      const thrown = thrownBy(inHandler({ http }, use));
      expect([label, String(thrown).startsWith(message)]).toEqual([label, true]);
      expect(sent).toEqual([]);
    }
  });

  test("a wildcard module may name any completion action", () => {
    const { http, sent } = fakeHttp();
    const m = createModuleExports(
      {
        initialState: {},
        actions: ["*"],
        handlers: { onAction: new Map([["load", ({ context }) => context.http.get("https://api.example.com/", { then: "whatever" })]]) },
      },
      fakeHost().host,
      { http }
    );
    m.dispatch(enc({}), { name: "load", payload: NO_PAYLOAD });
    expect(sent.map((s) => s.then)).toEqual(["whatever"]);
  });

  test("lifecycle handlers can queue too (on-activated: load when the screen appears)", () => {
    const { http, sent } = fakeHttp();
    const m = createModuleExports(
      fakeModule({ loaded: () => {} }, { onActivated: (_state, context) => context.http.get("https://api.example.com/", { then: "loaded" }) }),
      fakeHost().host,
      { http }
    );
    m.onActivated(enc({}));
    expect(sent).toHaveLength(1);
  });
});

describe("TS shim: generated entry", () => {
  test("a module granted http imports hypen:http/deferred under its versioned name and hands it to the shim", () => {
    const granted = tsShimEntrySource({ modulePath: "/abs/Weather/component.ts", shimPath: "/cli/module-shim.js", moduleName: "Weather", http: true });
    const httpWit = readFileSync(join(import.meta.dir, "..", "wit", "deps", "hypen-http", "http.wit"), "utf8");
    const pkg = httpWit.match(/^package\s+(hypen:http)@([\d.]+);/m)!;
    expect(granted).toContain(`import { send as hypenHttpSend } from "${pkg[1]}/deferred@${pkg[2]}";`);
    expect(granted).toContain(
      'const hypenModule = createModuleExports(def, { read, subscribe }, { name: "Weather", http: { send: hypenHttpSend } });'
    );
    // Ungranted: the import is absent (it would not link) — only the name is passed.
    const ungranted = tsShimEntrySource({ modulePath: "/abs/Weather/component.ts", shimPath: "/cli/module-shim.js", moduleName: "Weather" });
    expect(ungranted).not.toContain("hypen:http");
    expect(ungranted).toContain('const hypenModule = createModuleExports(def, { read, subscribe }, { name: "Weather" });');
  });

  test("imports the user module, the versioned host import and the shim; exports the world", () => {
    const src = tsShimEntrySource({ modulePath: "/abs/Counter/component.ts", shimPath: "/cli/module-shim.js" });
    expect(src).toContain('import def from "/abs/Counter/component.ts";');
    expect(src).toContain('import { createModuleExports } from "/cli/module-shim.js";');
    // componentize-js only binds world imports under their fully versioned
    // name, so the specifier must match the vendored WIT package.
    const stateWit = readFileSync(join(import.meta.dir, "..", "wit", "deps", "hypen-engine", "state.wit"), "utf8");
    const pkg = stateWit.match(/^package\s+(hypen:engine)@([\d.]+);/m)!;
    expect(src).toContain(`import { read, subscribe } from "${pkg[1]}/state@${pkg[2]}";`);
    for (const name of ["init", "dispatch", "onActivated", "onDeactivated", "onDestroyed", "actions"]) {
      expect(src).toContain(`export const ${name} = hypenModule.${name};`);
    }
  });

  test("escapes paths, so any module path yields valid JS", () => {
    const src = tsShimEntrySource({ modulePath: '/weird/"quoted"/path.ts', shimPath: "/s.js" });
    expect(src).toContain(JSON.stringify('/weird/"quoted"/path.ts'));
  });

  test("bundles with the shipped shim into a working module (as the build does, minus jco)", async () => {
    const esbuild = await import("esbuild");
    const dir = mkdtempSync(join(tmpdir(), "hypen-shim-entry-"));
    try {
      writeFileSync(
        join(dir, "user.mjs"),
        `export default {\n` +
          `  initialState: { count: 0 },\n` +
          `  actions: ["inc", "peek"],\n` +
          `  handlers: { onAction: new Map([\n` +
          `    ["inc", ({ state }) => { state.count++; }],\n` +
          `    ["peek", ({ state, context }) => { state.seen = context.getModule("other").state; context.on("other", "x", "inc"); }],\n` +
          `  ]) },\n` +
          `};\n`
      );
      writeFileSync(
        join(dir, "entry.mjs"),
        tsShimEntrySource({ modulePath: join(dir, "user.mjs"), shimPath: tsShimPath() })
      );
      const hostState = { subscribed: [] as unknown[] };
      (globalThis as { __hypenTestState?: unknown }).__hypenTestState = hostState;
      await esbuild.build({
        entryPoints: [join(dir, "entry.mjs")],
        bundle: true,
        outfile: join(dir, "out.mjs"),
        format: "esm",
        platform: "neutral",
        logLevel: "silent",
        plugins: [
          {
            name: "fake-engine-state",
            setup(b) {
              b.onResolve({ filter: /^hypen:engine\/state@/ }, (a) => ({ path: a.path, namespace: "fake" }));
              b.onLoad({ filter: /.*/, namespace: "fake" }, () => ({
                contents:
                  `export const read = (id) => new TextEncoder().encode(JSON.stringify({ from: id }));\n` +
                  `export const subscribe = (m, p, a) => { globalThis.__hypenTestState.subscribed.push([m, p, a]); };\n`,
                loader: "js",
              }));
            },
          },
        ],
      });
      // The bundle is self-contained: nothing left to resolve at run time.
      expect(readFileSync(join(dir, "out.mjs"), "utf8")).not.toMatch(/^import /m);
      const mod = await import(join(dir, "out.mjs"));
      expect(mod.actions()).toEqual(["inc", "peek"]);
      expect(dec(mod.init(NO_PAYLOAD))).toEqual({ count: 0 });
      expect(dec(mod.dispatch(enc({ count: 1 }), { name: "inc", payload: NO_PAYLOAD }).state)).toEqual({ count: 2 });
      expect(dec(mod.dispatch(enc({}), { name: "peek", payload: NO_PAYLOAD }).state)).toEqual({
        seen: { from: "other" },
      });
      expect(hostState.subscribed).toEqual([["other", "x", "inc"]]);
    } finally {
      delete (globalThis as { __hypenTestState?: unknown }).__hypenTestState;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the shim is self-contained (it is bundled into the guest: no imports)", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "wasm", "shims", "module-shim.ts"), "utf8");
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).not.toMatch(/\brequire\(/);
    expect(src).not.toMatch(/\b(process|Bun|Buffer)\./);
  });
});

describe("Go shim template", () => {
  const template = readFileSync(goShimTemplatePath(), "utf8");
  const rendered = renderGoShim("example.com/app/src/components/Counter", "example.com/app/internal/bindings/hypen/module");
  const haveGofmt = (() => {
    try {
      return spawnSync({ cmd: ["gofmt", "-h"], stdout: "ignore", stderr: "ignore" }).exitCode !== null;
    } catch {
      return false;
    }
  })();

  test("renders the user package and the project's bindings into the imports", () => {
    expect(rendered).toContain('usermod "example.com/app/src/components/Counter"');
    expect(rendered).toContain('module "example.com/app/internal/bindings/hypen/module/module"');
    expect(rendered).toContain('types "example.com/app/internal/bindings/hypen/module/types"');
    // No placeholder survives.
    expect(rendered).not.toContain('"hypen.invalid');
    // Everything outside the three import lines is the template verbatim.
    const strip = (s: string) => s.split("\n").filter((l) => !/^\t(usermod|module|types) "/.test(l)).join("\n");
    expect(strip(rendered)).toBe(strip(template));
  });

  test("quotes import paths as Go string literals", () => {
    expect(renderGoShim('weird/"path"', "b")).toContain('usermod "weird/\\"path\\""');
    // `$&` and friends in a path are not treated as replacement patterns.
    expect(renderGoShim("a/$&/b", "b")).toContain('usermod "a/$&/b"');
  });

  test("a template missing a placeholder is an error, not a silently unrendered shim", () => {
    expect(() => renderGoShim("a", "b", template.replace('"hypen.invalid/usermod"', '"other"'))).toThrow(
      /does not import "hypen\.invalid\/usermod" exactly once/
    );
  });

  test("imports the SDK by its real module path", () => {
    // Must match the `module` line of hypen-golang/go.mod, or `go mod tidy`
    // in the user's project cannot resolve the shim's import.
    const sdkGoMod = readFileSync(join(import.meta.dir, "..", "..", "hypen-golang", "go.mod"), "utf8");
    const sdkModule = sdkGoMod.match(/^module\s+(\S+)/m)![1];
    expect(rendered).toContain(`core ${JSON.stringify(sdkModule)}`);
  });

  test("init shallow-merges declaration-site config over InitialState", () => {
    // Merge at the JSON layer (type-agnostic over InitialState's Go type).
    expect(rendered).toContain("\n\t\tseed := decodeMap(config)");
    expect(rendered).toContain("if len(seed) == 0 {");
    expect(rendered).toContain("json.Marshal(def.InitialState)");
    expect(rendered).toContain("for k, v := range seed {");
  });

  test.skipIf(!haveGofmt)("the template itself is gofmt-clean Go", () => {
    const r = spawnSync({ cmd: ["gofmt", "-l", "-e", goShimTemplatePath()], stdout: "pipe", stderr: "pipe" });
    expect(new TextDecoder().decode(r.stderr)).toBe("");
    expect(r.exitCode).toBe(0);
    // `gofmt -l` lists files whose formatting differs: none.
    expect(new TextDecoder().decode(r.stdout).trim()).toBe("");
  });

  test.skipIf(!haveGofmt)("a rendered shim parses as Go", () => {
    const dir = mkdtempSync(join(tmpdir(), "hypen-go-shim-"));
    try {
      const file = join(dir, "main.go");
      writeFileSync(file, rendered);
      const r = spawnSync({ cmd: ["gofmt", "-e", file], stdout: "pipe", stderr: "pipe" });
      expect(new TextDecoder().decode(r.stderr)).toBe("");
      expect(r.exitCode).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
