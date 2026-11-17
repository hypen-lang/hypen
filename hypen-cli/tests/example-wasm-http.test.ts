/**
 * examples/wasm-http, booted for real: its local "weather API", `hypen dev`
 * in the example directory, and a WebSocket client over the actual protocol.
 * One click makes the TypeScript-authored WASM module queue an HTTP request
 * (`context.http.get`), the dev server performs it, and the response comes
 * back to the module as an action.
 *
 * Offline: everything it talks to is on 127.0.0.1.
 *
 * The module is a SOURCE PACKAGE of the app (`wasm.packages["./modules/weather"]`
 * with `"source": true`): `hypen dev` builds its component (~12 MB: it embeds
 * a JS engine; a few seconds with jco) at startup, so nothing is committed
 * and nothing is copied by hand. The test runs wherever jco is available.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { classifyWasm, findJco, readModulePackage } from "../src/build-wasm";

const REPO = resolve(import.meta.dir, "..", "..");
const EXAMPLE = join(REPO, "examples", "wasm-http");
const MODULE = join(EXAMPLE, "modules", "weather");
/** Where `hypen dev` builds the module (the app declares it as a source package). */
const WASM = join(MODULE, "dist", "wasm", "Weather.wasm");
const CLI = join(REPO, "hypen-cli", "bin", "hypen.ts");
const PORT = 19961;
const E2E = process.env.HYPEN_WASM_E2E === "1";

type Patch = Record<string, any>;

// `hypen dev` builds the module itself, so the test needs jco — which the
// CLI's own devDependencies provide in this repository.
const haveJco = findJco(MODULE).status === "found";

describe.skipIf(!E2E && !haveJco)("examples/wasm-http", () => {
  let dev: ReturnType<typeof Bun.spawn> | null = null;
  let api: { server: { stop(force?: boolean): void }; hits: string[] } | null = null;
  let output = "";

  beforeAll(async () => {
    // The example's own API server, on the port its hypen.json allowlists.
    const { startApi } = (await import(join(EXAMPLE, "scripts", "api.ts"))) as {
      startApi(port?: number): { server: { stop(force?: boolean): void }; hits: string[] };
    };
    api = startApi(8787);

    dev = Bun.spawn({
      cmd: ["bun", CLI, "dev", "--port", String(PORT)],
      cwd: EXAMPLE,
      env: { ...process.env, HYPEN_NO_ONBOARDING: "1", NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const drain = async (stream: ReadableStream<Uint8Array>) => {
      for await (const chunk of stream) output += new TextDecoder().decode(chunk);
    };
    void drain(dev.stdout as ReadableStream<Uint8Array>);
    void drain(dev.stderr as ReadableStream<Uint8Array>);
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        if ((await fetch(`http://localhost:${PORT}/health`)).ok) break;
      } catch {
        /* not up yet */
      }
      if (dev.exitCode !== null || Date.now() > deadline) {
        throw new Error(`hypen dev did not come up:\n${output}`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }, 240_000);

  afterAll(() => {
    dev?.kill();
    api?.server.stop(true);
  });

  test("hypen dev built the module from source: a Component, described by a verified manifest", () => {
    expect(output).toContain("Building ./modules/weather");
    expect(existsSync(WASM)).toBe(true);
    expect(classifyWasm(readFileSync(WASM).subarray(0, 8))).toEqual({ kind: "component" });
    // What the module declares in its own hypen.json is what it requests.
    const pkg = readModulePackage(join(MODULE, "dist", "wasm", "hypen-modules.json"));
    expect(pkg.manifest.entry).toBe("Weather");
    expect(pkg.modules.map((m) => [m.name, { ...m.requests }])).toEqual([
      ["Weather", { reads: [], dispatches: [], storage: [], http: true, httpHosts: ["127.0.0.1:8787"] }],
    ]);
  });

  /** Connect like a renderer; returns helpers over the patch stream. */
  async function connect() {
    const socket = new WebSocket(`ws://localhost:${PORT}`);
    const patches: Patch[] = [];
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.type === "initialTree" || message.type === "patch") patches.push(...message.patches);
    });
    await new Promise<void>((done, fail) => {
      socket.addEventListener("open", () => done());
      socket.addEventListener("error", () => fail(new Error("connect failed")));
    });
    socket.send(JSON.stringify({ type: "hello" }));
    const texts = (): string[] => {
      const byNode = new Map<string, string>();
      for (const p of patches) {
        if (p.type === "create" && typeof p.props?.["0"] === "string") byNode.set(p.id, p.props["0"]);
        if (p.type === "setProp" && typeof p.value === "string") byNode.set(p.id, p.value);
      }
      return [...byNode.values()];
    };
    const until = async (...expected: string[]) => {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const now = texts();
        if (expected.every((text) => now.some((t) => t.includes(text)))) return;
        if (Date.now() > deadline) {
          throw new Error(`expected ${JSON.stringify(expected)} in ${JSON.stringify(now)}\n${output}`);
        }
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    const refresh = (payload: Record<string, unknown> = {}) => {
      const button = patches.find((p) => p.type === "create" && p.elementType === "Button" && p.semantics?.name === "Refresh");
      if (!button) throw new Error('no "Refresh" button');
      socket.send(
        JSON.stringify({
          type: "dispatchAction",
          module: "App",
          action: "__hypen_dispatch",
          payload: { node: button.id, action: "refresh", payload },
        })
      );
    };
    return { socket, until, refresh, texts };
  }

  test("Refresh: the WASM module queues a request, the dev server fetches it, the response lands in its state", async () => {
    expect(output).toContain("Prebuilt:   Weather");
    const client = await connect();
    try {
      await client.until("City: —", "Status: idle", "Requests sent: 0");
      client.refresh();
      await client.until("City: Oslo", "Temperature: 7 °C", "Sky: light rain", "Status: ok", "Requests sent: 1");
      expect(api!.hits).toContain("GET /forecast/oslo");
      // A redirect inside the allowlist is followed by the server.
      client.refresh({ url: "http://127.0.0.1:8787/old/zagreb" });
      await client.until("City: Zagreb", "Temperature: 14 °C", "Status: ok", "Requests sent: 2");
      // A 404 is a completed exchange, not a failure.
      client.refresh({ url: "http://127.0.0.1:8787/nowhere" });
      await client.until("Status: the server answered HTTP 404");
      // Nothing was reported as failed along the way.
      expect(output).not.toContain("✖");
    } finally {
      client.socket.close();
    }
  }, 30_000);

  test("refusals: a host outside httpHosts is refused at send; a redirect out of it is refused by the server and reported", async () => {
    const client = await connect();
    try {
      await client.until("Status: idle");
      client.refresh({ url: "http://example.com/" });
      await client.until(
        "Status: not sent (permission-denied): host 'example.com:80' is not in the manifest's `httpHosts` allowlist"
      );
      client.refresh({ url: "http://127.0.0.1:8787/away" });
      await client.until("Status: failed (denied): redirect from http://127.0.0.1:8787/away to http://example.com/ refused");
      const deadline = Date.now() + 5000;
      while (!output.includes("HTTP request did not complete") && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(output).toContain('✖ Weather "loaded": HTTP request did not complete');
      expect(output).toContain('missing grant: httpHosts ← "example.com:80"');
      // A source package is granted what it declares, so the place to
      // change the allowlist is the module project's own hypen.json.
      expect(output).toContain('add "example.com:80" to ./modules/weather/hypen.json wasm.modules.Weather.httpHosts');
    } finally {
      client.socket.close();
    }
  }, 30_000);
});
