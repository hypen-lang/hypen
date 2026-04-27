/**
 * Barrel import safety tests.
 *
 * Regression test for: importing from "@hypen-space/core" barrel (index.ts)
 * transitively pulled in Node.js WASM (via remote/server.ts -> engine.ts ->
 * wasm-node/hypen_engine.js) which called `require('fs').readFileSync()`,
 * crashing any browser-bundled consumer.
 *
 * These tests verify that:
 * 1. The barrel does NOT export Node-only modules at runtime
 * 2. The subpath exports exist and work
 * 3. The @hypen-space/web DOM renderer can be imported without WASM
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "fs";

const distExists = existsSync(import.meta.dir + "/../packages/core/dist");

describe("@hypen-space/core barrel import safety", () => {
  test("barrel does not export RemoteServer or serve", async () => {
    const barrel = await import("../packages/core/src/index");
    expect((barrel as any).RemoteServer).toBeUndefined();
    expect((barrel as any).serve).toBeUndefined();
  });

  test("barrel does not export ComponentLoader or componentLoader", async () => {
    const barrel = await import("../packages/core/src/index");
    expect((barrel as any).ComponentLoader).toBeUndefined();
    expect((barrel as any).componentLoader).toBeUndefined();
  });

  test("barrel does not export discoverComponents or loadDiscoveredComponents", async () => {
    const barrel = await import("../packages/core/src/index");
    expect((barrel as any).discoverComponents).toBeUndefined();
    expect((barrel as any).loadDiscoveredComponents).toBeUndefined();
    expect((barrel as any).watchComponents).toBeUndefined();
    expect((barrel as any).generateComponentsCode).toBeUndefined();
  });

  test("barrel does not export hypenPlugin or registerHypenPlugin", async () => {
    const barrel = await import("../packages/core/src/index");
    expect((barrel as any).hypenPlugin).toBeUndefined();
    expect((barrel as any).registerHypenPlugin).toBeUndefined();
    expect((barrel as any).defaultHypenPlugin).toBeUndefined();
  });

  test("barrel does not export Engine or WasmEngine", async () => {
    const barrel = await import("../packages/core/src/index");
    expect((barrel as any).Engine).toBeUndefined();
    expect((barrel as any).WasmEngine).toBeUndefined();
    expect((barrel as any).BrowserEngine).toBeUndefined();
  });

  test("barrel exports browser-safe types and classes", async () => {
    const barrel = await import("../packages/core/src/index");

    // These should all be available from the barrel
    expect(barrel.app).toBeDefined();
    expect(barrel.HypenApp).toBeDefined();
    expect(barrel.HypenAppBuilder).toBeDefined();
    expect(barrel.BaseRenderer).toBeDefined();
    expect(barrel.HypenRouter).toBeDefined();
    expect(barrel.TypedEventEmitter).toBeDefined();
    expect(barrel.HypenGlobalContext).toBeDefined();
    expect(barrel.RemoteEngine).toBeDefined();
    expect(barrel.SessionManager).toBeDefined();
    expect(barrel.createObservableState).toBeDefined();
    expect(barrel.frameworkLoggers).toBeDefined();
  });
});

describe("@hypen-space/core barrel has no transitive fs dependency", () => {
  test("barrel source does not import from engine.ts or engine.js", async () => {
    const indexSource = await Bun.file(
      import.meta.dir + "/../packages/core/src/index.ts"
    ).text();

    // Should not import the engine (which pulls in WASM)
    expect(indexSource).not.toMatch(/from\s+["']\.\/engine(?:\.js)?["']/);
    expect(indexSource).not.toMatch(/from\s+["']\.\/engine\.browser(?:\.js)?["']/);

    // Should not import remote/server (which imports engine)
    expect(indexSource).not.toMatch(/from\s+["']\.\/remote\/server(?:\.js)?["']/);

    // Should not import loader (which uses fs)
    expect(indexSource).not.toMatch(
      /^(?!.*type\s).*export\s+\{[^}]*\}\s+from\s+["']\.\/loader(?:\.js)?["']/m
    );

    // Should not import discovery (which uses fs)
    expect(indexSource).not.toMatch(
      /^(?!.*type\s).*export\s+\{[^}]*\}\s+from\s+["']\.\/discovery(?:\.js)?["']/m
    );

    // Should not import plugin (which uses fs)
    expect(indexSource).not.toMatch(
      /^(?!.*type\s).*export\s+\{[^}]*\}\s+from\s+["']\.\/plugin(?:\.js)?["']/m
    );
  });
});

describe.skipIf(!distExists)("@hypen-space/core dist build has no node:module in shared entrypoints", () => {
  // Regression test: Bun's node-target build injects `createRequire` from "node:module"
  // into every output file. Shared entrypoints (logger, state, etc.) are platform-agnostic
  // and must be built with browser target so they work when bundled for the browser.
  // Skipped when dist/ hasn't been built (run `bun run build` in packages/core first).

  const sharedDistFiles = [
    "logger.js",
    "state.js",
    "app.js",
    "renderer.js",
    "router.js",
    "events.js",
    "context.js",
    "resolver.js",
    "disposable.js",
    "types.js",
    "components/builtin.js",
    "remote/index.js",
    "remote/client.js",
  ];

  // NOTE: engine.js, loader.js, discovery.js, remote/server.js moved to @hypen-space/server
  const nodeOnlyDistFiles = [
    "index.js",
  ];

  for (const file of sharedDistFiles) {
    test(`dist/${file} does not import from node:module`, async () => {
      const distDir = import.meta.dir + "/../packages/core/dist";
      const content = await Bun.file(`${distDir}/${file}`).text();
      expect(content).not.toContain('from "node:module"');
      expect(content).not.toContain("from 'node:module'");
    });
  }

  test("dist/index.browser.js does not import from node:module", async () => {
    const distDir = import.meta.dir + "/../packages/core/dist";
    const content = await Bun.file(`${distDir}/index.browser.js`).text();
    expect(content).not.toContain('from "node:module"');
  });

  // Node-only files are allowed to have createRequire
  for (const file of nodeOnlyDistFiles) {
    test(`dist/${file} is allowed to use node:module (node-only)`, async () => {
      const distDir = import.meta.dir + "/../packages/core/dist";
      const content = await Bun.file(`${distDir}/${file}`).text();
      // Just verify the file exists and is readable (no assertion on content)
      expect(content.length).toBeGreaterThan(0);
    });
  }
});

describe("@hypen-space/web barrel does not export engine/orchestrator symbols", () => {
  test("web barrel does not export Hypen, render, or renderWithComponents", async () => {
    const barrel = await import("../packages/web/src/index");
    expect((barrel as any).Hypen).toBeUndefined();
    expect((barrel as any).render).toBeUndefined();
    expect((barrel as any).renderWithComponents).toBeUndefined();
  });

  test("web barrel does not export Engine", async () => {
    const barrel = await import("../packages/web/src/index");
    expect((barrel as any).Engine).toBeUndefined();
  });

  test("web barrel exports renderers", async () => {
    const barrel = await import("../packages/web/src/index");
    expect(barrel.DOMRenderer).toBeDefined();
    expect(barrel.CanvasRenderer).toBeDefined();
    expect(barrel.ComponentRegistry).toBeDefined();
    expect(barrel.ApplicatorRegistry).toBeDefined();
  });
});

describe("@hypen-space/web-engine barrel exports browser engine symbols", () => {
  test("web-engine barrel exports Hypen, render, renderWithComponents, Engine", async () => {
    const barrel = await import("../packages/web-engine/src/index");
    expect(barrel.Hypen).toBeDefined();
    expect(barrel.render).toBeDefined();
    expect(barrel.renderWithComponents).toBeDefined();
    expect(barrel.Engine).toBeDefined();
  });
});

describe("@hypen-space/server barrel exports server symbols", () => {
  test("server barrel exports Engine, discovery, loader, and RemoteServer", async () => {
    const barrel = await import("../packages/server/src/index");
    expect(barrel.Engine).toBeDefined();
    expect(barrel.discoverComponents).toBeDefined();
    expect(barrel.loadDiscoveredComponents).toBeDefined();
    expect(barrel.watchComponents).toBeDefined();
    expect(barrel.generateComponentsCode).toBeDefined();
    expect(barrel.RemoteServer).toBeDefined();
    expect(barrel.serve).toBeDefined();
    expect(barrel.componentLoader).toBeDefined();
  });
});

describe("@hypen-space/web imports are WASM-free", () => {
  test("DOM renderer imports frameworkLoggers from subpath, not barrel", async () => {
    const rendererSource = await Bun.file(
      import.meta.dir + "/../packages/web/src/dom/renderer.ts"
    ).text();

    // Should import from the logger subpath
    expect(rendererSource).toMatch(/@hypen-space\/core\/logger/);

    // Should NOT import frameworkLoggers from the barrel
    expect(rendererSource).not.toMatch(
      /import\s+\{[^}]*frameworkLoggers[^}]*\}\s+from\s+["']@hypen-space\/core["']/
    );
  });

  test("no web package source files import frameworkLoggers from barrel", async () => {
    const glob = new Bun.Glob("**/*.ts");
    const webSrcDir = import.meta.dir + "/../packages/web/src";

    for await (const file of glob.scan({ cwd: webSrcDir })) {
      const content = await Bun.file(`${webSrcDir}/${file}`).text();

      // If the file imports frameworkLoggers, it should be from the subpath
      if (content.includes("frameworkLoggers")) {
        expect(content).not.toMatch(
          /import\s+\{[^}]*frameworkLoggers[^}]*\}\s+from\s+["']@hypen-space\/core["']/
        );
      }
    }
  });
});
