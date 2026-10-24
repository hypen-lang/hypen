/**
 * `hypen build` (src/build.ts) for component-based projects.
 *
 * The browser behavior (routes, nested modules, actions, URLs) was verified
 * end to end in Chromium; these tests pin the build's contract: the output
 * layout, that the engine WASM ships in the output instead of being fetched
 * from a CDN, the generated SPA server, and the error cases.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { build, BuildError, serverSource } from "../src/build";

// Inside the CLI package so the fixture resolves @hypen-space/* from the
// CLI's own node_modules, like a scaffolded project resolves its own.
const root = mkdtempSync(join(import.meta.dir, ".tmp-build-"));

function writeComponent(name: string, hypen: string, ts?: string) {
  const dir = join(root, "src/components", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "component.hypen"), hypen);
  if (ts) writeFileSync(join(dir, "component.ts"), ts);
}

beforeAll(() => {
  writeComponent(
    "App",
    `module App {
  Router {
    Route(path: "/") { Home() }
    Route(path: "/counter") { Counter() }
  }
}`,
    `import { app } from "@hypen-space/core";
export default app.defineState({ location: "/" }).build();`
  );
  writeComponent(
    "Home",
    `module Home { Button { Text("Go") }.onClick(@router.push, to: "/counter") }`
  );
  writeComponent(
    "Counter",
    `module Counter { Text("@{state.count}") }`,
    `import { app } from "@hypen-space/core";
export default app.module("Counter").defineState({ count: 0 })
  .onAction("increment", ({ state }) => { state.count += 1; }).build();`
  );
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("hypen build (component projects)", () => {
  let outDir = "";

  test("emits a self-contained static site", async () => {
    const result = await build({
      components: "./src/components",
      entry: "App",
      root,
      log: false,
    });
    outDir = result.outDir;
    for (const f of [
      "index.html",
      "main.js",
      "worker.js",
      "server.js",
      "hypen/hypen_engine.js",
      "hypen/hypen_engine_bg.wasm",
    ]) {
      expect(existsSync(join(outDir, f))).toBe(true);
    }
    // Temp sources are cleaned up.
    expect(existsSync(join(root, ".hypen"))).toBe(false);

    // Asset URLs are absolute so deep links (/counter) load the bundle.
    const html = readFileSync(join(outDir, "index.html"), "utf-8");
    expect(html).toContain('<script type="module" src="/main.js">');

    // The page starts the worker; the worker loads the WASM the build
    // shipped, not a floating CDN copy.
    const main = readFileSync(join(outDir, "main.js"), "utf-8");
    expect(main).toContain("worker.js");
    const worker = readFileSync(join(outDir, "worker.js"), "utf-8");
    expect(worker).toContain("hypen/hypen_engine_bg.wasm");
    expect(worker).not.toContain("web-engine@latest");
    // Even the CDN fallback is pinned to the installed web-engine version
    // (the define is substituted in the worker bundle, not left to `latest`).
    // (Published web-engine <= 0.6.6 hard-codes `@latest` and has no define.)
    expect(worker).not.toContain("__HYPEN_WEB_ENGINE_VERSION__");
    const webEngineDir = join(import.meta.dir, "..", "node_modules", "@hypen-space", "web-engine");
    if (readFileSync(join(webEngineDir, "src", "engine.ts"), "utf-8").includes("__HYPEN_WEB_ENGINE_VERSION__")) {
      const { version } = JSON.parse(readFileSync(join(webEngineDir, "package.json"), "utf-8"));
      expect(worker).toContain(`@hypen-space/web-engine@${version}/wasm-browser`);
    }
    // The session runtime and both component modules are in the worker.
    expect(worker).toContain("Counter");
    expect(worker).toContain("router.push");
  }, 60_000);

  test("server.js serves files and falls back to index.html for routes", async () => {
    expect(outDir).not.toBe("");
    const port = 4600 + Math.floor(Math.random() * 40);
    const proc = Bun.spawn(["bun", join(outDir, "server.js")], {
      env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const base = `http://127.0.0.1:${port}`;
      let ready = false;
      for (let i = 0; i < 50 && !ready; i++) {
        try {
          await fetch(base + "/");
          ready = true;
        } catch {
          await Bun.sleep(100);
        }
      }
      expect(ready).toBe(true);

      const deep = await fetch(base + "/counter");
      expect(deep.status).toBe(200);
      expect(deep.headers.get("content-type")).toContain("text/html");
      expect(await deep.text()).toContain('id="app"');

      const wasm = await fetch(base + "/hypen/hypen_engine_bg.wasm");
      expect(wasm.status).toBe(200);
      expect(wasm.headers.get("content-type")).toBe("application/wasm");
      await wasm.arrayBuffer();

      expect((await fetch(base + "/missing.js")).status).toBe(404);
      expect((await fetch(base + "/%2e%2e/%2e%2e/package.json")).status).not.toBe(200);
    } finally {
      proc.kill();
      await proc.exited;
    }
  }, 30_000);

  test("unknown entry is a BuildError", async () => {
    await expect(
      build({ components: "./src/components", entry: "Nope", root, outDir: "dist-nope", log: false })
    ).rejects.toBeInstanceOf(BuildError);
    expect(existsSync(join(root, ".hypen"))).toBe(false);
  });

  test("a template that doesn't parse is a BuildError naming the file", async () => {
    const broken = join(root, "src/components/Broken");
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, "component.hypen"), "Column {{{ (\n");
    try {
      const err = await build({
        components: "./src/components", entry: "App", root, outDir: "dist-broken", log: false,
      }).catch((e) => e);
      expect(err).toBeInstanceOf(BuildError);
      expect(String(err.message)).toContain("src/components/Broken/component.hypen:1:");
      expect(existsSync(join(root, "dist-broken"))).toBe(false);
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });

  test("a project without @hypen-space/web-engine is a BuildError", async () => {
    const bare = mkdtempSync(join(tmpdir(), "hypen-build-bare-"));
    try {
      mkdirSync(join(bare, "src/components/App"), { recursive: true });
      writeFileSync(join(bare, "src/components/App/component.hypen"), `Text("hi")`);
      await expect(
        build({ components: "./src/components", entry: "App", root: bare, log: false })
      ).rejects.toThrow(/web-engine/);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  test("the package's programmatic `build` is the same build `hypen build` runs", async () => {
    const pkg = await import("../src/index");
    expect(pkg.BuildError).toBe(BuildError);
    await expect(
      pkg.build({ components: "./src/components", entry: "Nope", root, outDir: "dist-nope", log: false })
    ).rejects.toBeInstanceOf(BuildError);
    const dev = await import("../src/dev");
    expect(dev.hypen.build).toBe(pkg.build);
  });

  test("generated server has no dependencies beyond node: builtins", () => {
    const imports = [...serverSource().matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) expect(spec.startsWith("node:")).toBe(true);
  });
});
