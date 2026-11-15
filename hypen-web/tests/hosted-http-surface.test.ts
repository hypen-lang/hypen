/**
 * The typed deferred-HTTP surface of `@hypen-space/core`: the `BaseEngine`
 * wrappers over the engine's `completeHttpRequest` / `httpRedirectAllowed` /
 * `moduleHttpInFlightLimit` / `setModuleHttpInFlightLimit`, and the
 * `HttpCompletion` guard.
 */

import { describe, expect, test } from "bun:test";
import { BaseEngine } from "../packages/core/src/engine-base";
import { isHostedModuleError, isHttpCompletion, type HttpCompletion } from "../packages/core/src/types";
import { Engine } from "../packages/server/src/engine";
import { hasServerEngine } from "./hosted-modules-harness";

function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to throw");
}

describe("isHttpCompletion", () => {
  const success: HttpCompletion = { ok: true, status: 200, headers: { "content-type": "text/plain" }, body: "hi", bodyEncoding: "utf8", tag: null };
  const failure: HttpCompletion = { ok: false, error: { kind: "timeout", message: "no complete response within 50 ms" }, tag: "t" };

  test("accepts both arms of the contract", () => {
    expect(isHttpCompletion(success)).toBe(true);
    expect(isHttpCompletion({ ...success, bodyEncoding: "base64", tag: "x" })).toBe(true);
    expect(isHttpCompletion(failure)).toBe(true);
  });

  test("rejects other payloads", () => {
    for (const other of [
      null,
      undefined,
      "ok",
      {},
      { ok: true },
      { ...success, tag: undefined },
      { ...success, bodyEncoding: "hex" },
      { ...success, status: "200" },
      { ...success, headers: null },
      { ok: false, tag: null },
      { ok: false, error: { kind: "timeout" }, tag: null },
      { ok: "yes", error: failure.ok ? undefined : failure.error, tag: null },
    ]) {
      expect(isHttpCompletion(other)).toBe(false);
    }
  });

  test("narrows", () => {
    const payload: unknown = failure;
    if (!isHttpCompletion(payload)) throw new Error("not a completion");
    // Type-level: `error` exists only on the failed arm.
    expect(payload.ok ? payload.status : payload.error.kind).toBe("timeout");
  });
});

describe.skipIf(!hasServerEngine)("BaseEngine: deferred HTTP wrappers (server engine)", () => {
  test("the server build supports it; the in-flight cap reads, writes and clamps", async () => {
    const engine = new Engine();
    expect(engine.supportsDeferredHttp).toBe(false); // before init()
    await engine.init();
    expect(engine.supportsDeferredHttp).toBe(true);
    expect(engine.moduleHttpInFlightLimit()).toBe(32);
    engine.setModuleHttpInFlightLimit(4);
    expect(engine.moduleHttpInFlightLimit()).toBe(4);
    engine.setModuleHttpInFlightLimit(0);
    expect(engine.moduleHttpInFlightLimit()).toBe(1);
  });

  test("an id that is not in flight: completing throws `unknownHttpRequest`, a redirect is not allowed", async () => {
    const engine = new Engine();
    await engine.init();
    const unknown = thrownBy(() => engine.completeHttpRequest(41, { ok: true, status: 200 }));
    expect(isHostedModuleError(unknown) && unknown.code).toBe("unknownHttpRequest");
    expect(engine.httpRedirectAllowed(41, "https://api.example.com/")).toBe(false);
    // A malformed result is refused before the id is looked at.
    const invalid = thrownBy(() =>
      engine.completeHttpRequest(41, { ok: false, error: { kind: "nope" } } as never)
    );
    expect(isHostedModuleError(invalid) && invalid.code).toBe("invalidArgument");
  });
});

describe("BaseEngine: an engine build that predates deferred HTTP", () => {
  /** Hosted modules, but none of the four deferred-HTTP methods. */
  class OldEngine extends BaseEngine {
    async init(): Promise<void> {
      this.wasmEngine = { registerHostedModule() {} };
      this.initialized = true;
    }
  }

  test("says so, with what to do, instead of a TypeError", async () => {
    const engine = new OldEngine();
    await engine.init();
    expect(engine.supportsHostedModules).toBe(true);
    expect(engine.supportsDeferredHttp).toBe(false);
    for (const call of [
      () => engine.completeHttpRequest(1, { ok: true, status: 200 }),
      () => engine.httpRedirectAllowed(1, "https://api.example.com/"),
      () => engine.moduleHttpInFlightLimit(),
      () => engine.setModuleHttpInFlightLimit(8),
    ]) {
      const err = thrownBy(call);
      expect(isHostedModuleError(err) && err.code).toBe("hostedModulesUnsupported");
      expect((err as Error).message).toContain("no deferred-HTTP support");
      expect((err as Error).message).toContain("build-wasm.sh");
    }
  });
});

describe.skipIf(!hasServerEngine)("context.http in an in-process TypeScript module", () => {
  test("is present, and explains that it belongs to the wasm target instead of failing obscurely", async () => {
    const { HypenApp } = await import("../packages/core/src/app");
    const { RemoteServer } = await import("../packages/server/src/remote/server");
    const { isModuleHttpError } = await import("../packages/core/src/types");
    const { connect } = await import("./hosted-modules-harness");

    const seen: unknown[] = [];
    const app = new HypenApp();
    const entry = app
      .module("App")
      .defineState({ tried: 0 })
      .onAction("load", ({ state, context }) => {
        state.tried += 1;
        for (const call of [
          () => context.http!.get("https://api.example.com/", { then: "loaded" }),
          () => context.http!.send({ url: "https://api.example.com/", body: { a: 1 } }, { then: "loaded" }),
        ]) {
          try {
            call();
          } catch (err) {
            seen.push(err);
          }
        }
      })
      .ui(`module App { Column { Text("Tried: @{state.tried}") Button { Text("Load") }.onClick(@actions.load) } }`);
    const server = new RemoteServer().app(app).module("App", entry);
    await server.prepare();
    const client = await connect(server);
    try {
      await client.click(client.button("Load"), "load");
      expect(seen).toHaveLength(2);
      for (const err of seen) {
        expect(isModuleHttpError(err) && err.code).toBe("unavailable");
        expect((err as Error).message).toContain("make the handler async and call fetch()");
        expect((err as Error).message).toContain("hypen build --target wasm");
      }
    } finally {
      await client.close();
    }
  });
});
