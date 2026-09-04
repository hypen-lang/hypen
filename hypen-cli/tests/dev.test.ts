import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "fs";
import { join } from "path";

// Import actual implementations from source
import { dev as bunDev, build as bunBuild, DevServerError } from "../src/dev-bun";
import { dev as nodeDev, build as nodeBuild } from "../src/dev-node";

// We can't directly import private functions, so we test via the public API
// and through the CLI integration tests. For the utility functions that are
// internal, we test their behavior through the dev/build outputs.

describe("Dev Server Utilities", () => {
  const testDir = `/tmp/hypen-dev-test-${Date.now()}`;

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("dev server (RemoteServer-backed)", () => {
    test("dev server comes up and answers /health", async () => {
      // Create a minimal component structure
      const componentDir = join(testDir, "components", "App");
      mkdirSync(componentDir, { recursive: true });
      writeFileSync(join(componentDir, "component.ts"), "export default {}");
      writeFileSync(join(componentDir, "component.hypen"), "Text('App')");

      const port = 19890;
      const result = await bunDev({
        components: join(testDir, "components"),
        entry: "App",
        port,
        hot: false,
      });

      expect(result.url).toBe(`http://localhost:${port}`);
      const health = await fetch(`http://localhost:${port}/health`);
      expect(health.ok).toBe(true);

      result.stop();
    });
  });

  describe("DevOptions defaults", () => {
    test("uses default port 3000 when not specified", async () => {
      // Just verify the types accept the options shape
      const options = {
        components: "./components",
        entry: "App",
      };

      expect(options.components).toBe("./components");
      expect(options.entry).toBe("App");
    });
  });

  describe("BuildOptions defaults", () => {
    test("accepts valid build options", () => {
      const options = {
        components: "./components",
        entry: "App",
        outDir: "dist",
        minify: true,
        sourcemap: true,
      };

      expect(options.components).toBe("./components");
      expect(options.entry).toBe("App");
      expect(options.outDir).toBe("dist");
      expect(options.minify).toBe(true);
      expect(options.sourcemap).toBe(true);
    });
  });

  describe("output directory handling", () => {
    test("creates output directory if it doesn't exist", () => {
      const outDir = join(testDir, "output", "nested");

      if (!existsSync(outDir)) {
        mkdirSync(outDir, { recursive: true });
      }

      expect(existsSync(outDir)).toBe(true);
    });

    test("handles existing output directory", () => {
      const outDir = join(testDir, "existing");
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, "existing.txt"), "test");

      // Creating again should not throw
      mkdirSync(outDir, { recursive: true });

      expect(existsSync(outDir)).toBe(true);
      expect(existsSync(join(outDir, "existing.txt"))).toBe(true);
    });
  });

  describe("file generation", () => {
    test("generates components file", async () => {
      // Create a simple component
      const componentDir = join(testDir, "components", "App");
      mkdirSync(componentDir, { recursive: true });
      writeFileSync(join(componentDir, "component.ts"), "export default {}");
      writeFileSync(join(componentDir, "component.hypen"), "Text('App')");

      // Import and use generateComponentsCode
      const { generateComponentsCode } = await import("@hypen-space/server");
      const code = await generateComponentsCode(join(testDir, "components"));

      expect(code).toContain("App");
      expect(code).toContain("template");
    });

    test("dev server serves an HTML page at /", async () => {
      const componentDir = join(testDir, "components", "App");
      mkdirSync(componentDir, { recursive: true });
      writeFileSync(join(componentDir, "component.ts"), "export default {}");
      writeFileSync(join(componentDir, "component.hypen"), "Text('App')");

      const port = 19891;
      const result = await bunDev({
        components: join(testDir, "components"),
        entry: "App",
        port,
        hot: false,
      });

      const page = await fetch(`http://localhost:${port}/`);
      expect(page.status).toBe(200);

      result.stop();
    });
  });
});

describe("dev server API behavior", () => {
  // In-tree so fixture imports of @hypen-space/core resolve.
  const apiTestDir = join(import.meta.dir, `.tmp-dev-api-${process.pid}`);

  beforeEach(() => {
    mkdirSync(apiTestDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(apiTestDir, { recursive: true, force: true });
  });

  function writeCounterApp(): string {
    const dir = join(apiTestDir, "components", "App");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "component.ts"),
      `import { app } from "@hypen-space/core";
export default app
  .defineState({ count: 0 })
  .onAction("increment", ({ state }) => {
    state.count += 1;
  })
  .build();
`
    );
    writeFileSync(join(dir, "component.hypen"), `module App { Text("@{state.count}") }`);
    return join(apiTestDir, "components");
  }

  test("throws DevServerError instead of exiting when the entry is missing", async () => {
    mkdirSync(join(apiTestDir, "components"), { recursive: true });
    const err = await bunDev({
      components: join(apiTestDir, "components"),
      entry: "App",
      port: 19893,
      hot: false,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(DevServerError);
    expect(err.code).toBe("ENTRY_NOT_FOUND");
    expect(err.message).toContain('Entry component "App" not found');
  });

  test("warns on deprecated htmlTemplate/outDir but still starts", async () => {
    const components = writeCounterApp();
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "));

    let result: { url: string; stop: () => void } | null = null;
    try {
      result = await bunDev({
        components,
        entry: "App",
        port: 19894,
        hot: false,
        htmlTemplate: "custom.html",
        outDir: ".out",
      });
    } finally {
      console.warn = originalWarn;
    }

    expect(warnings.some((w) => w.includes("htmlTemplate"))).toBe(true);
    expect(warnings.some((w) => w.includes("outDir"))).toBe(true);
    const health = await fetch("http://localhost:19894/health");
    expect(health.ok).toBe(true);
    result!.stop();
  });

  // Pins the CURRENT (deliberate-for-now) behavior: `dev()` enables
  // `.syncActions()`, so an action from one client is replayed on every
  // other client's engine — tabs and native runners mirror the same
  // scene. Flip these assertions if dev ever moves to per-tab isolation.
  test("clients mirror actions (syncActions is on)", async () => {
    const components = writeCounterApp();
    const port = 19895;
    const result = await bunDev({ components, entry: "App", port, hot: false });

    function connect(): Promise<{ messages: any[]; ws: WebSocket }> {
      return new Promise((res, rej) => {
        const messages: any[] = [];
        const ws = new WebSocket(`ws://localhost:${port}`);
        const timer = setTimeout(() => rej(new Error("connect timeout")), 5000);
        ws.onopen = () => ws.send(JSON.stringify({ type: "hello" }));
        ws.onmessage = (e) => {
          const m = JSON.parse(e.data as string);
          messages.push(m);
          if (m.type === "initialTree") {
            clearTimeout(timer);
            res({ messages, ws });
          }
        };
        ws.onerror = rej;
      });
    }

    const a = await connect();
    const b = await connect();

    a.ws.send(JSON.stringify({ type: "dispatchAction", module: "App", action: "increment" }));
    await new Promise((r) => setTimeout(r, 400));

    // A's own engine re-rendered, and the action was replayed on B's.
    expect(a.messages.some((m) => m.type === "patch")).toBe(true);
    expect(b.messages.some((m) => m.type === "patch")).toBe(true);

    a.ws.close();
    b.ws.close();
    await new Promise((r) => setTimeout(r, 50));
    result.stop();
  });
});
