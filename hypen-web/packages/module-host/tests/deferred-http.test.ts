/**
 * `hypen:http/deferred` in the JS module host.
 *
 *   1. With FAKE bindings: the per-call queue is open for `dispatch`,
 *      `onActivated` and `onDeactivated`, closed everywhere else, restored
 *      around nested calls and discarded when the call throws.
 *   2. With the REAL fixture (`deferred_http_module.wasm`, the one the native
 *      host tests in `hypen-engine-rs/tests/test_module_host_http.rs` use):
 *      link-time denial without the `http` grant, and the same answers at
 *      `send` as the native host — the expected strings below are copied
 *      from that Rust test.
 *   3. Through the engine (wasm-node): the queued request arrives at the
 *      effect handler, `completeHttpRequest` runs `fetched`.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  JsModuleHost,
  MAX_HTTP_REQUESTS_PER_CALL,
  MemoryStorageBackend,
  buildImportMap,
  normalizeManifest,
  type DeferredHttpImport,
  type ModuleBindings,
  type ModuleManifest,
  type ReducerOutput,
} from "../src/index.ts";
import { REPO_ROOT, hasFixture, readFixture } from "./_fixtures.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();
const emptyOut = { state: undefined, effects: [], emit: [] };

function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (e) {
    return e;
  }
  return undefined;
}

const get = (url: string) => ({ method: "GET", url, headers: [] as Array<[string, string]> });

describe("the per-call queue (fake bindings)", () => {
  type Hook = (http: DeferredHttpImport) => unknown;
  function makeHost(manifest: ModuleManifest, hooks: Partial<Record<keyof ModuleBindings, Hook>>) {
    const host = new JsModuleHost({ storage: new MemoryStorageBackend() });
    const http = host.deferredHttp;
    const run = (name: keyof ModuleBindings): unknown => hooks[name]?.(http) ?? emptyOut;
    const bindings: ModuleBindings = {
      init: (config) => {
        run("init");
        return config;
      },
      actions: () => {
        run("actions");
        return ["go"];
      },
      dispatch: () => run("dispatch"),
      onActivated: () => run("onActivated"),
      onDeactivated: () => run("onDeactivated"),
      onDestroyed: () => {
        run("onDestroyed");
      },
    };
    host.registerPrepared("m", bindings, manifest);
    return { host, id: host.instantiate("m") };
  }
  const state = enc.encode("{}");
  const go = { name: "go", payload: enc.encode("{}") };

  test("dispatch, onActivated and onDeactivated each carry what they queued", () => {
    const send: Hook = (http) => {
      http.send({ ...get("https://api.example.com/a"), body: new Uint8Array([1, 2]), timeoutMs: 500 }, "done", "t");
      return emptyOut;
    };
    const { host, id } = makeHost({ http: true }, { dispatch: send, onActivated: send, onDeactivated: send });
    const expected = [
      {
        request: {
          method: "GET",
          url: "https://api.example.com/a",
          headers: [],
          body: new Uint8Array([1, 2]),
          timeoutMs: 500,
        },
        then: "done",
        tag: "t",
      },
    ];
    expect(host.dispatch(id, state, go, []).httpRequests).toEqual(expected);
    expect(host.onActivated(id, state, []).httpRequests).toEqual(expected);
    expect(host.onDeactivated(id, state).httpRequests).toEqual(expected);
    // Each call starts empty: nothing leaks from the previous one.
    const quiet = makeHost({ http: true }, {});
    expect(quiet.host.dispatch(quiet.id, state, go, []).httpRequests).toEqual([]);
  });

  test("omitted body / timeout / tag are null on the wire", () => {
    const { host, id } = makeHost(
      { http: true },
      {
        dispatch: (http) => {
          http.send(get("http://h.test/"), "done");
          return emptyOut;
        },
      },
    );
    expect(host.dispatch(id, state, go, []).httpRequests).toEqual([
      { request: { method: "GET", url: "http://h.test/", headers: [], body: null, timeoutMs: null }, then: "done", tag: null },
    ]);
  });

  test("the queued body is a copy: the guest may reuse its buffer", () => {
    const buffer = new Uint8Array([7, 7, 7]);
    const { host, id } = makeHost(
      { http: true },
      {
        dispatch: (http) => {
          http.send({ ...get("http://h.test/"), method: "POST", body: buffer }, "done");
          buffer.fill(0);
          return emptyOut;
        },
      },
    );
    expect(host.dispatch(id, state, go, []).httpRequests[0]!.request.body).toEqual(new Uint8Array([7, 7, 7]));
  });

  test("init, actions, onDestroyed and code outside any call cannot queue", () => {
    const refused: unknown[] = [];
    const probe: Hook = (http) => {
      refused.push(thrownBy(() => http.send(get("http://h.test/"), "done")));
      return undefined;
    };
    const { host, id } = makeHost({ http: true }, { init: probe, actions: probe, onDestroyed: probe });
    host.init(id, state);
    host.actions(id);
    host.onDestroyed(id, state);
    refused.push(thrownBy(() => host.deferredHttp.send(get("http://h.test/"), "done")));
    expect(refused).toHaveLength(4);
    for (const error of refused) {
      expect(error).toEqual({
        tag: "permission-denied",
        val:
          "http: requests can only be queued from `dispatch`, `on-activated` or " +
          "`on-deactivated` (this export returns no reducer output to carry one)",
      });
    }
  });

  test("a call that throws discards its queue and closes the window", () => {
    const { host, id } = makeHost(
      { http: true },
      {
        dispatch: (http) => {
          http.send(get("http://h.test/"), "done");
          throw new Error("reducer failed");
        },
      },
    );
    expect(() => host.dispatch(id, state, go, [])).toThrow("reducer failed");
    expect(thrownBy(() => host.deferredHttp.send(get("http://h.test/"), "done"))).toMatchObject({
      tag: "permission-denied",
    });
  });

  test("a refused request is not queued; the ones around it are", () => {
    const errors: unknown[] = [];
    const { host, id } = makeHost(
      { http: true, httpHosts: ["*.example.com"] },
      {
        dispatch: (http) => {
          http.send(get("https://a.example.com/1"), "done", "first");
          errors.push(thrownBy(() => http.send(get("https://evil.test/"), "done")));
          errors.push(thrownBy(() => http.send(get("not a url"), "done")));
          http.send(get("https://b.example.com/2"), "done", "second");
          return emptyOut;
        },
      },
    );
    const out = host.dispatch(id, state, go, []);
    expect(out.httpRequests.map((q) => q.tag)).toEqual(["first", "second"]);
    expect(errors[0]).toEqual({
      tag: "permission-denied",
      val: "host 'evil.test:443' is not in the manifest's `httpHosts` allowlist",
    });
    expect(errors[1]).toMatchObject({ tag: "invalid-request" });
  });

  test("registerPrepared without the grant: send answers permission-denied", () => {
    const errors: unknown[] = [];
    const { host, id } = makeHost(
      {},
      {
        dispatch: (http) => {
          errors.push(thrownBy(() => http.send(get("https://a.example.com/"), "done")));
          return emptyOut;
        },
      },
    );
    expect(host.dispatch(id, state, go, []).httpRequests).toEqual([]);
    expect(errors).toEqual([{ tag: "permission-denied", val: "the manifest does not grant `http`" }]);
  });
});

describe("manifest: httpHosts", () => {
  test("normalizeManifest turns http + httpHosts into one grant", () => {
    expect(normalizeManifest(undefined).httpGrant).toEqual({ kind: "denied" });
    expect(normalizeManifest({ http: true }).httpGrant).toEqual({ kind: "anyHost" });
    expect(normalizeManifest({ http: true, httpHosts: [] }).httpGrant).toEqual({ kind: "anyHost" });
    expect(normalizeManifest({ http: true, httpHosts: ["API.example.com:8443"] }).httpGrant).toEqual({
      kind: "hosts",
      patterns: [{ kind: "exact", host: "api.example.com", port: 8443 }],
    });
    // What the engine's `ManifestWire` always sends for an ungranted module.
    expect(normalizeManifest({ http: false, httpHosts: [] }).httpGrant).toEqual({ kind: "denied" });
  });

  test("a bad allowlist is an error naming the module and the pattern — never a wider grant", () => {
    expect(() => normalizeManifest({ name: "net", http: true, httpHosts: ["https://api.example.com"] })).toThrow(
      /manifest\.httpHosts of module 'net': invalid host pattern 'https:\/\/api\.example\.com': .*drop the scheme/,
    );
    expect(() => normalizeManifest({ name: "net", http: true, httpHosts: [7] as unknown as string[] })).toThrow(
      /manifest\.httpHosts of module 'net' must be a list of host patterns \(strings\); got 7/,
    );
    expect(() => normalizeManifest({ name: "net", httpHosts: ["api.example.com"] })).toThrow(
      /narrows the `http` grant, but `http` is not true for this module — add `"http": true`, or remove `httpHosts`/,
    );
    const host = new JsModuleHost({ storage: new MemoryStorageBackend() });
    expect(() => host.register("net", new Uint8Array([0]), { name: "net", http: true, httpHosts: ["*"] })).toThrow(
      /leave the allowlist empty to allow any host/,
    );
  });
});

describe("buildImportMap: hypen:http/deferred is gated like wasi:http", () => {
  const available = Object.fromEntries(
    ["hypen:storage/local", "hypen:engine/state", "hypen:http/deferred", "wasi:http/types", "wasi:io/streams"].map(
      (k) => [k, { impl: k }],
    ),
  );
  for (const version of ["0.1.0", "0.2.0"]) {
    const required = [`hypen:http/deferred@${version}`, "wasi:io/streams@0.2.3"];
    test(`@${version}: linked only with http: true`, () => {
      expect("hypen:http/deferred" in buildImportMap("m", { http: true }, required, available)).toBe(true);
      for (const manifest of [undefined, {}, { http: false }, { http: "yes" as unknown as boolean }]) {
        expect(() => buildImportMap("m", manifest, required, available)).toThrow(
          "http egress denied for module 'm': manifest.http is not true but the component imports hypen:http/deferred",
        );
      }
    });
  }
  test("an ungranted module that does not import it is unaffected, and never sees it", () => {
    const map = buildImportMap("m", {}, ["wasi:io/streams"], available);
    expect("hypen:http/deferred" in map).toBe(false);
    expect("wasi:http/types" in map).toBe(false);
  });
});

const FIXTURE = "deferred_http_module.wasm";
const ASYNC_FIXTURE = "deferred_http_async_module.wasm";

describe.skipIf(!hasFixture(FIXTURE))("deferred_http_module.wasm in JsModuleHost", () => {
  /** A prepared instance and a `dispatch` that threads the state like the engine does. */
  async function start(manifest: ModuleManifest, config = "{}") {
    const host = new JsModuleHost({ storage: new MemoryStorageBackend() });
    await host.prepare("m", readFixture(FIXTURE), { name: "m", ...manifest });
    const id = host.instantiate("m");
    let state = host.init(id, enc.encode(config));
    return {
      host,
      id,
      state: (): Record<string, any> => JSON.parse(dec.decode(state)),
      dispatch(name: string, payload: unknown): ReducerOutput {
        const out = host.dispatch(id, state, { name, payload: enc.encode(JSON.stringify(payload)) }, []);
        if (out.state) state = out.state;
        return out;
      },
    };
  }

  // importing_the_interface_without_the_http_grant_is_a_link_time_denial
  test("without the http grant, prepare() fails naming the import", async () => {
    for (const manifest of [{}, { http: false }, { storage: ["app", "cloud"], reads: ["x"] }] as ModuleManifest[]) {
      const host = new JsModuleHost({ storage: new MemoryStorageBackend() });
      const error = await host.prepare("m", readFixture(FIXTURE), { name: "m", ...manifest }).then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(error?.message).toBe(
        "http egress denied for module 'm': manifest.http is not true but the component imports hypen:http/deferred",
      );
      expect(() => host.instantiate("m")).toThrow(/module not prepared/);
    }
  }, 60_000);

  test("`get` queues exactly what the guest asked for", async () => {
    const guest = await start({ http: true });
    expect(guest.host.actions(guest.id)).toEqual(["get", "fetched", "flood", "bad"]);
    const plain = guest.dispatch("get", { url: "https://api.example.com/x" });
    expect(guest.state().queued).toBe(1);
    expect(guest.state().sendError).toBeNull();
    expect(plain.httpRequests).toEqual([
      {
        request: { method: "GET", url: "https://api.example.com/x", headers: [], body: null, timeoutMs: null },
        then: "fetched",
        tag: null,
      },
    ]);
    const full = guest.dispatch("get", {
      url: "http://127.0.0.1:8080/items?q=1",
      method: "POST",
      headers: { "content-type": "application/json", "x-trace": "abc" },
      body: '{"a":1}',
      timeoutMs: 1500,
      tag: "t",
    });
    expect(full.httpRequests).toEqual([
      {
        request: {
          method: "POST",
          url: "http://127.0.0.1:8080/items?q=1",
          headers: [
            ["content-type", "application/json"],
            ["x-trace", "abc"],
          ],
          body: enc.encode('{"a":1}'),
          timeoutMs: 1500,
        },
        then: "fetched",
        tag: "t",
      },
    ]);
  }, 60_000);

  // requests_are_bounded_per_call_and_malformed_ones_are_refused_at_send
  test("requests are bounded per call and malformed ones are refused at send", async () => {
    const guest = await start({ http: true });
    const flood = guest.dispatch("flood", { url: "http://h.test/", count: 20 });
    expect(flood.httpRequests).toHaveLength(MAX_HTTP_REQUESTS_PER_CALL);
    expect(guest.state().accepted).toBe(MAX_HTTP_REQUESTS_PER_CALL);
    expect(guest.state().sendError).toBe("limit-exceeded: too many requests in one call (limit 16)");
    // The bound is per call, not per instance.
    expect(guest.dispatch("flood", { url: "http://h.test/", count: 3 }).httpRequests).toHaveLength(3);

    for (const [bad, expected] of [
      ["url", "invalid-request: invalid url: contains a space"],
      ["scheme", "invalid-request: invalid url: must be absolute and start with http:// or https://"],
      ["header", "invalid-request: header 'Host' is set by the host"],
      ["method", "invalid-request: method 'GET /smuggled' is not an HTTP token"],
      ["body", "limit-exceeded: body of 1048577 bytes exceeds the 1048576-byte limit"],
      ["timeout", "invalid-request: timeout-ms is 0"],
    ] as const) {
      const out = guest.dispatch("bad", { case: bad });
      expect([bad, out.httpRequests.length]).toEqual([bad, 0]);
      expect(guest.state().sendError).toStartWith(expected);
    }
    // An unknown `then` is not the host's to judge; the engine refuses it.
    const then = guest.dispatch("bad", { case: "then" });
    expect(then.httpRequests.map((q) => q.then)).toEqual(["not-an-action"]);
  }, 60_000);

  // the_allowlist_is_checked_at_send_and_names_the_host
  test("the allowlist is checked at send and names the host", async () => {
    const guest = await start({ http: true, httpHosts: ["*.example.com", "127.0.0.1:8080"] });
    for (const allowed of ["https://api.example.com/x", "http://deep.api.EXAMPLE.com:8443/", "http://127.0.0.1:8080/health"]) {
      expect([allowed, guest.dispatch("get", { url: allowed }).httpRequests.length]).toEqual([allowed, 1]);
    }
    for (const [refused, host] of [
      ["https://evil.test/", "evil.test:443"],
      ["https://example.com/", "example.com:443"],
      ["http://127.0.0.1:9090/", "127.0.0.1:9090"],
      ["http://api.example.com.evil.test/", "api.example.com.evil.test:80"],
    ] as const) {
      expect(guest.dispatch("get", { url: refused }).httpRequests).toEqual([]);
      expect(guest.state().sendError).toBe(
        `permission-denied: host '${host}' is not in the manifest's \`httpHosts\` allowlist`,
      );
    }
  }, 60_000);

  // nothing_can_be_queued_from_init
  test("nothing can be queued from init", async () => {
    const guest = await start({ http: true }, '{"probe":"http://h.test/"}');
    expect(guest.state().initSend).toStartWith(
      "permission-denied: http: requests can only be queued from `dispatch`",
    );
  }, 60_000);

  test.skipIf(!hasFixture(ASYNC_FIXTURE))(
    "the 0.2 (CM-async) build imports the same interface, gated the same way",
    async () => {
      const host = new JsModuleHost({ storage: new MemoryStorageBackend() });
      const error = await host.prepare("m", readFixture(ASYNC_FIXTURE), { name: "m" }).then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(error?.message).toContain("http egress denied for module 'm'");
      expect(error?.message).toContain("hypen:http/deferred");
    },
    60_000,
  );
});

const SERVER_WASM = resolve(REPO_ROOT, "hypen-web/packages/server/wasm-node/hypen_engine.js");

describe.skipIf(!existsSync(SERVER_WASM) || !hasFixture(FIXTURE))("through the engine (wasm-node)", () => {
  let WasmEngine: any;
  beforeAll(async () => {
    ({ WasmEngine } = await import(SERVER_WASM));
  });

  type HttpEffect = {
    type: "http";
    id: number;
    request: { method: string; url: string; headers: [string, string][]; body: Uint8Array | null; timeoutMs: number };
    then: string;
    tag: string | null;
    allowedHosts: string[] | null;
  };

  async function setup(manifest: ModuleManifest) {
    const host = new JsModuleHost({ storage: new MemoryStorageBackend() });
    await host.prepare("net", readFixture(FIXTURE), manifest);
    const engine = new WasmEngine();
    engine.registerDefaultPrimitives();
    engine.setRenderCallback(() => {});
    engine.setModuleHost(host);
    const effects: HttpEffect[] = [];
    engine.setModuleEffectHandler((_scope: string, effect: HttpEffect) => {
      if (effect.type === "http") effects.push(effect);
    });
    engine.registerHostedModule("net", "net", manifest, {});
    return { engine, effects };
  }

  test("a queued request reaches the effect handler; its completion runs `fetched`", async () => {
    const { engine, effects } = await setup({ name: "net", http: true, httpHosts: ["*.example.com"] });
    engine.dispatchModuleAction("net", "get", { url: "https://a.example.com/first", tag: "one", timeoutMs: 999_999 });
    expect(effects).toHaveLength(1);
    const effect = effects[0]!;
    expect(effect).toMatchObject({
      type: "http",
      then: "fetched",
      tag: "one",
      allowedHosts: ["*.example.com"],
      request: { method: "GET", url: "https://a.example.com/first", headers: [], body: null, timeoutMs: 120_000 },
    });
    expect(engine.httpRedirectAllowed(effect.id, "https://b.example.com/next")).toBe(true);
    expect(engine.httpRedirectAllowed(effect.id, "https://evil.test/")).toBe(false);
    expect(engine.getModuleState("net").completions).toBe(0);

    const delivered = engine.completeHttpRequest(effect.id, {
      ok: true,
      status: 200,
      headers: [["Content-Type", "text/plain"]],
      body: enc.encode("hello"),
    });
    expect(delivered).toBe(true);
    expect(engine.getModuleState("net").last).toEqual({
      ok: true,
      status: 200,
      body: "hello",
      bodyEncoding: "utf8",
      contentType: "text/plain",
      tag: "one",
    });
    // Exactly one completion per request.
    expect(thrownBy(() => engine.completeHttpRequest(effect.id, { ok: true, status: 200 }))).toMatchObject({
      code: "unknownHttpRequest",
    });
  }, 60_000);

  test("what the host refused at send never reaches the engine", async () => {
    const { engine, effects } = await setup({ name: "net", http: true, httpHosts: ["*.example.com"] });
    engine.dispatchModuleAction("net", "get", { url: "https://evil.test/" });
    expect(effects).toEqual([]);
    expect(engine.getModuleState("net").sendError).toBe(
      "permission-denied: host 'evil.test:443' is not in the manifest's `httpHosts` allowlist",
    );
    expect(engine.lastModuleCascadeReport()).toBeNull();
  }, 60_000);
});
