import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { spawn } from "bun";

describe("Studio CLI Command", () => {
  const testDir = `/tmp/hypen-studio-test-${Date.now()}`;
  const cliPath = join(import.meta.dir, "../bin/hypen.ts");

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  async function runCli(args: string[], cwd?: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const proc = spawn({
      cmd: ["bun", cliPath, ...args],
      cwd: cwd || testDir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    return { stdout, stderr, exitCode };
  }

  describe("help includes studio command", () => {
    test("shows studio in help", async () => {
      const result = await runCli(["--help"]);

      expect(result.stdout).toContain("studio");
      expect(result.stdout).toContain("Open Hypen Studio IDE");
      expect(result.exitCode).toBe(0);
    });

    test("shows studio example in help", async () => {
      const result = await runCli(["--help"]);

      expect(result.stdout).toContain("hypen studio --port 5173");
      expect(result.exitCode).toBe(0);
    });
  });
});

describe("Studio UI Structure", () => {
  const studioUiDir = join(import.meta.dir, "../studio-ui");

  describe("required files exist", () => {
    test("index.html exists", () => {
      expect(existsSync(join(studioUiDir, "src/index.html"))).toBe(true);
    });

    test("main server entry exists", () => {
      expect(existsSync(join(studioUiDir, "src/index.tsx"))).toBe(true);
    });

    test("Studio component exists", () => {
      expect(existsSync(join(studioUiDir, "src/components/studio/Studio.tsx"))).toBe(true);
    });

    test("all panel components exist", () => {
      const components = ["Toolbar", "FileTree", "EditorTabs", "Preview", "BottomPanel", "CommandPalette"];
      for (const comp of components) {
        const path = join(studioUiDir, `src/components/studio/${comp}.tsx`);
        expect(existsSync(path)).toBe(true);
      }
    });
  });

  describe("server features", () => {
    test("server includes WebSocket configuration", () => {
      const content = readFileSync(join(studioUiDir, "src/index.tsx"), "utf-8");
      expect(content).toContain("websocket:");
    });

    test("server includes file API endpoints", () => {
      const content = readFileSync(join(studioUiDir, "src/index.tsx"), "utf-8");
      expect(content).toContain('"/api/files"');
      expect(content).toContain('"/api/project"');
    });

    test("server includes security check for file paths", () => {
      const content = readFileSync(join(studioUiDir, "src/index.tsx"), "utf-8");
      expect(content).toContain("fullPath.startsWith(projectDir)");
      expect(content).toContain("Access denied");
    });
  });
});

describe("Studio Server Module", () => {
  test("studio server exports studio function", async () => {
    const mod = await import("../src/studio/server");
    expect(typeof mod.studio).toBe("function");
  });
});

// ─── CSS regression guard ───────────────────────────────────────────────
//
// The "no CSS" bug recurred for several releases because studio-ui used a
// detection heuristic (node_modules probe, then HYPEN_PROJECT_DIR env var)
// to decide whether to run Bun.build + tailwindPlugin or fall back to an
// HMR import path that produces zero utility CSS. Every release a new launch
// shape slipped past the heuristic and Studio loaded unstyled.
//
// This test boots studio-ui exactly the way a published `hypen studio`
// invocation does — no STUDIO_DEV opt-in — fetches `/`, then fetches the
// CSS asset it references, and asserts the CSS contains real Tailwind
// output. If a future change reintroduces detection-based CSS handling and
// the env doesn't satisfy it, this test fails *before* publish.
describe("Studio UI serves real CSS without detection heuristics", () => {
  test("served CSS contains Tailwind utility output", async () => {
    const studioUiDir = join(import.meta.dir, "../studio-ui");
    const port = 5273 + Math.floor(Math.random() * 500);
    const proc = spawn({
      cmd: ["bun", join(studioUiDir, "src/index.tsx")],
      cwd: studioUiDir,
      env: {
        ...process.env,
        // Critical: must NOT set STUDIO_DEV. The whole point is verifying
        // the default (no-opt-in) path produces real CSS.
        PORT: String(port),
        // Provide HYPEN_PROJECT_DIR (the old heuristic) pointing at a temp
        // dir so legacy code paths don't surprise-skip the build.
        HYPEN_PROJECT_DIR: "/tmp",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      // Wait up to 30s for the server to come up.
      const baseUrl = `http://127.0.0.1:${port}`;
      const deadline = Date.now() + 30_000;
      let html: string | null = null;
      while (Date.now() < deadline) {
        try {
          const r = await fetch(`${baseUrl}/`);
          if (r.ok) { html = await r.text(); break; }
        } catch { /* not up yet */ }
        await new Promise((r) => setTimeout(r, 250));
      }
      if (!html) throw new Error("studio-ui did not become ready within 30s");

      // Find the bundled CSS link (Bun.build emits <link rel="stylesheet"
      // href="/chunk-XXXX.css">).
      // Bun.build emits `./chunk-XXXX.css` (relative). Match either.
      const cssMatch = html.match(/href="(?:\.?)(\/?chunk-[^"]+\.css)"/);
      expect(cssMatch).not.toBeNull();
      const cssPath = cssMatch![1]!.replace(/^\/?/, "/");

      const cssRes = await fetch(`${baseUrl}${cssPath}`);
      expect(cssRes.ok).toBe(true);
      const css = await cssRes.text();

      // A working Tailwind v4 build of studio-ui produces 80+ KB once
      // utility classes are actually scanned. The previous 10 KB threshold
      // passed silently even when @source failed to resolve — Tailwind
      // still inlines ~25 KB of theme defaults plus xterm/monaco/tw-animate
      // vendor CSS, totalling ~50 KB of useless-without-utilities output.
      expect(css.length).toBeGreaterThan(60_000);

      // Sentinel utilities that ONLY exist when the scanner sees the .tsx
      // files. `bg-card` / `text-foreground` are theme tokens used widely
      // in studio-ui components — Tailwind only emits them if it scanned
      // source. `.flex { ... }` is the bare utility selector, distinct
      // from xterm's `display: flex` declarations.
      expect(/\.bg-card\b/.test(css)).toBe(true);
      expect(/\.text-foreground\b/.test(css)).toBe(true);
      expect(/\.flex\s*\{/.test(css)).toBe(true);
    } finally {
      try { proc.kill(); } catch {}
      await proc.exited.catch(() => {});
    }
  }, 60_000);
});
