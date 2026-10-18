/**
 * Node dev server (src/dev-node.ts): same RemoteServer architecture as the
 * Bun server, behind node:http + src/node-ws.ts. Exercised in-process under
 * Bun (node:http is Node-compatible there) and, when a `node` binary with
 * TypeScript type stripping is on PATH, for real under Node.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  dev,
  DevServerError,
  isAppNavigation,
  nodeCanImportTypeScript,
  typeScriptUnsupportedMessage,
} from "../src/dev-node";

const CLI_NODE_MODULES = join(import.meta.dir, "..", "node_modules");

/** Scaffold-shaped project: App (Router) -> Home (nested module with `tap`). */
function writeProject(root: string): void {
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "node-dev-fixture", type: "module" }));
  // Resolve @hypen-space/* through the CLI's own install, so the project,
  // the dev server and the component modules share one copy.
  symlinkSync(CLI_NODE_MODULES, join(root, "node_modules"), "dir");
  const comp = (name: string, ts: string, hypen: string) => {
    mkdirSync(join(root, "src/components", name), { recursive: true });
    writeFileSync(join(root, "src/components", name, "component.ts"), ts);
    writeFileSync(join(root, "src/components", name, "component.hypen"), hypen);
  };
  comp(
    "App",
    `import { app } from "@hypen-space/core";
type AppState = { location: string };
export default app.defineState<AppState>({ location: "/" }).build();
`,
    `module App {
  Router {
    Route(path: "/") { Home() }
    Route(path: "/other") { Text("Other") }
  }
}
`
  );
  comp(
    "Home",
    `import { app } from "@hypen-space/core";
type HomeState = { taps: number };
export default app
  .module("Home")
  .defineState<HomeState>({ taps: 0 })
  .onAction("tap", ({ state }) => { state.taps += 1; })
  .build();
`,
    `module Home { Column { Text("Taps: @{state.taps}") Button { Text("Tap") }.onClick(@actions.tap) } }
`
  );
}

/** hello -> initialTree, then dispatch Home.tap and wait for its patch. */
async function exerciseSession(port: number): Promise<{ initial: string; patch: string }> {
  return new Promise((resolvePromise, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    const timer = setTimeout(() => reject(new Error("session timeout")), 10_000);
    let initial = "";
    ws.onopen = () => ws.send(JSON.stringify({ type: "hello" }));
    ws.onerror = (e) => reject(e);
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.type === "initialTree") {
        initial = JSON.stringify(m.patches);
        ws.send(JSON.stringify({ type: "dispatchAction", module: "Home", action: "tap" }));
      } else if (m.type === "patch") {
        clearTimeout(timer);
        ws.close();
        resolvePromise({ initial, patch: JSON.stringify(m.patches) });
      }
    };
  });
}

describe("dev-node helpers", () => {
  test("detects Node TypeScript type stripping", () => {
    expect(nodeCanImportTypeScript({ typescript: "strip" })).toBe(true);
    expect(nodeCanImportTypeScript({ typescript: "transform" })).toBe(true);
    expect(nodeCanImportTypeScript({ typescript: false })).toBe(false);
    expect(nodeCanImportTypeScript({})).toBe(false);
    expect(nodeCanImportTypeScript({ typescript: undefined })).toBe(false);
  });

  test("the unsupported-runtime message tells the user how to fix it", () => {
    const msg = typeScriptUnsupportedMessage("20.11.0");
    expect(msg).toContain("Node 20.11.0");
    expect(msg).toContain("bunx hypen dev");
    expect(msg).toContain("22.18");
  });

  test("SPA fallback only answers page navigations", () => {
    expect(isAppNavigation("GET", "/counter", true)).toBe(true);
    expect(isAppNavigation("GET", "/a/b", true)).toBe(true);
    expect(isAppNavigation("GET", "/counter", false)).toBe(false);
    expect(isAppNavigation("POST", "/counter", true)).toBe(false);
    expect(isAppNavigation("GET", "/logo.png", true)).toBe(false);
    expect(isAppNavigation("GET", "/__hypen__/x", true)).toBe(false);
  });
});

describe("dev-node server (in-process)", () => {
  let root: string;
  let cwd: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "hypen-dev-node-"));
    writeProject(root);
    cwd = process.cwd();
    process.chdir(root);
  });
  afterAll(() => {
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  });

  test("serves the web client, SPA fallback and a working RemoteServer session", async () => {
    const port = 19911;
    const server = await dev({ components: "./src/components", entry: "App", port, hot: false });
    try {
      const health = await fetch(`http://localhost:${port}/__hypen__/health`);
      expect(await health.json()).toEqual({ status: "ok", server: "hypen-remote" });
      expect(await (await fetch(`http://localhost:${port}/health`)).text()).toBe("OK");

      const index = await fetch(`http://localhost:${port}/`);
      expect(await index.text()).toContain("/__hypen__/client.js");

      // Deep link: a browser navigation to an app route gets the shell.
      const deep = await fetch(`http://localhost:${port}/other`, { headers: { Accept: "text/html" } });
      expect(deep.status).toBe(200);
      expect(await deep.text()).toContain('<div id="app">');
      // Assets and non-navigations stay 404s.
      expect((await fetch(`http://localhost:${port}/logo.png`, { headers: { Accept: "text/html" } })).status).toBe(404);

      const client = await fetch(`http://localhost:${port}/__hypen__/client.js`);
      expect(client.status).toBe(200);
      expect(client.headers.get("content-type")).toContain("javascript");

      // Nested module handler (Home.tap) runs server-side.
      const { initial, patch } = await exerciseSession(port);
      expect(initial).toContain("Taps: 0");
      expect(patch).toContain("Taps: 1");
    } finally {
      server.stop();
    }
  }, 30_000);

  test("throws DevServerError for a missing entry and a taken port", async () => {
    const missing = await dev({ components: "./src/components", entry: "Nope", port: 19912, hot: false }).catch((e) => e);
    expect(missing).toBeInstanceOf(DevServerError);
    expect(missing.code).toBe("ENTRY_NOT_FOUND");

    const blocker = Bun.serve({ port: 19913, fetch: () => new Response("") });
    try {
      const taken = await dev({ components: "./src/components", entry: "App", port: 19913, hot: false }).catch((e) => e);
      expect(taken).toBeInstanceOf(DevServerError);
      expect(taken.code).toBe("PORT_IN_USE");
    } finally {
      blocker.stop(true);
    }
  }, 30_000);
});

// Real Node: the code path `hypen dev` takes when the CLI runs under node.
const nodeBin = Bun.which("node");
const nodeHasTs = (() => {
  if (!nodeBin) return false;
  const r = Bun.spawnSync([nodeBin, "-p", "process.features.typescript"]);
  return /strip|transform/.test(r.stdout.toString());
})();

describe.skipIf(!nodeHasTs)("dev-node server under Node", () => {
  test("serves a working session and the web client", async () => {
    const root = mkdtempSync(join(tmpdir(), "hypen-dev-node-real-"));
    const port = 19914;
    let proc: ReturnType<typeof Bun.spawn> | null = null;
    try {
      writeProject(root);
      const out = join(root, ".build");
      const built = await Bun.build({
        entrypoints: [join(import.meta.dir, "../src/dev-node.ts")],
        outdir: out,
        target: "node",
        format: "esm",
        external: ["@hypen-space/*", "esbuild"],
      });
      expect(built.success).toBe(true);
      writeFileSync(
        join(root, "run.mjs"),
        `const { dev } = await import(${JSON.stringify(join(out, "dev-node.js"))});
await dev({ components: "./src/components", entry: "App", port: ${port}, hot: false });
console.log("READY");
`
      );
      proc = Bun.spawn([nodeBin!, "run.mjs"], { cwd: root, stdout: "pipe", stderr: "pipe" });
      const deadline = Date.now() + 20_000;
      let up = false;
      while (Date.now() < deadline) {
        try {
          if ((await fetch(`http://localhost:${port}/__hypen__/health`)).ok) {
            up = true;
            break;
          }
        } catch {
          /* not yet */
        }
        await Bun.sleep(200);
      }
      if (!up) {
        proc.kill();
        throw new Error(`node dev server did not start: ${await new Response(proc.stderr as any).text()}`);
      }
      expect((await fetch(`http://localhost:${port}/__hypen__/client.js`)).status).toBe(200);
      const { initial, patch } = await exerciseSession(port);
      expect(initial).toContain("Taps: 0");
      expect(patch).toContain("Taps: 1");
    } finally {
      proc?.kill();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
