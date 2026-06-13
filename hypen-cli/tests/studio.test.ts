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
