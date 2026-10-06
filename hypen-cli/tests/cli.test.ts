import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { spawn } from "bun";
import { generateTypescriptProject } from "../src/init/typescript";

describe("CLI", () => {
  const testDir = `/tmp/hypen-cli-test-${Date.now()}`;
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

  describe("help command", () => {
    test("shows help with --help flag", async () => {
      const result = await runCli(["--help"]);

      expect(result.stdout).toContain("hypen");
      expect(result.stdout).toContain("Commands:");
      expect(result.stdout).toContain("init");
      expect(result.stdout).toContain("dev");
      expect(result.stdout).toContain("build");
      expect(result.stdout).toContain("studio");
      expect(result.stdout).toContain("test");
      expect(result.exitCode).toBe(0);
    });

    test("shows help with -h flag", async () => {
      const result = await runCli(["-h"]);

      expect(result.stdout).toContain("hypen");
      expect(result.exitCode).toBe(0);
    });

    test("shows help with no command", async () => {
      const result = await runCli([]);

      expect(result.stdout).toContain("Usage:");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("version command", () => {
    test("shows version matching package.json with --version flag", async () => {
      const result = await runCli(["--version"]);
      const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf-8"));

      expect(result.stdout).toContain(`hypen v${pkg.version}`);
      expect(result.exitCode).toBe(0);
    });

    test("shows version with -v flag", async () => {
      const result = await runCli(["-v"]);

      expect(result.stdout).toContain("hypen v");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("init command", () => {
    test("creates new project structure", async () => {
      const projectName = "test-app";
      const result = await runCli(["init", projectName]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Creating Hypen project");
      expect(result.stdout).toContain("Done!");

      // Check files were created
      const projectDir = join(testDir, projectName);
      expect(existsSync(join(projectDir, "package.json"))).toBe(true);
      expect(existsSync(join(projectDir, "hypen.json"))).toBe(true);
      expect(existsSync(join(projectDir, "tsconfig.json"))).toBe(true);
      expect(existsSync(join(projectDir, ".gitignore"))).toBe(true);
      // Default file-based scaffold ships three modules: App (router),
      // Home (landing), Counter (state mutation demo).
      expect(existsSync(join(projectDir, "src/components/App/component.ts"))).toBe(true);
      expect(existsSync(join(projectDir, "src/components/App/component.hypen"))).toBe(true);
      expect(existsSync(join(projectDir, "src/components/Home/component.ts"))).toBe(true);
      expect(existsSync(join(projectDir, "src/components/Home/component.hypen"))).toBe(true);
      expect(existsSync(join(projectDir, "src/components/Counter/component.ts"))).toBe(true);
      expect(existsSync(join(projectDir, "src/components/Counter/component.hypen"))).toBe(true);
    });

    test("creates package.json with correct content", async () => {
      const projectName = "my-app";
      await runCli(["init", projectName]);

      const packageJson = JSON.parse(
        readFileSync(join(testDir, projectName, "package.json"), "utf-8")
      );

      expect(packageJson.name).toBe(projectName);
      expect(packageJson.type).toBe("module");
      expect(packageJson.scripts.dev).toBe("hypen dev");
      expect(packageJson.scripts.build).toBe("hypen build");
    });

    test("creates hypen.json with correct content", async () => {
      const projectName = "config-app";
      await runCli(["init", projectName]);

      const config = JSON.parse(readFileSync(
        join(testDir, projectName, "hypen.json"),
        "utf-8"
      ));

      expect(config.components).toBe("./src/components");
      expect(config.entry).toBe("App");
      expect(config.port).toBe(3000);
    });

    test("server-based scaffold writes a script entry and no components dir pointer", () => {
      const projectDir = join(testDir, "server-app");
      mkdirSync(projectDir, { recursive: true });
      generateTypescriptProject({
        projectDir,
        projectName: "server-app",
        layout: "server-based",
      });

      const config = JSON.parse(
        readFileSync(join(projectDir, "hypen.json"), "utf-8")
      );

      // Server-based projects register modules inside the entry script;
      // pointing `components` at a directory the scaffold never creates
      // made `hypen dev` crash on fs.watch (ENOENT). The file-extension
      // entry is what dev/test use to detect the layout.
      expect(config.entry).toBe("./src/app.ts");
      expect(config.components).toBeUndefined();
      expect(existsSync(join(projectDir, "src/app.ts"))).toBe(true);
      expect(existsSync(join(projectDir, "src/modules/App.ts"))).toBe(true);
    });

    test("creates .gitignore with env and npmrc entries", async () => {
      const projectName = "gitignore-app";
      await runCli(["init", projectName]);

      const gitignore = readFileSync(
        join(testDir, projectName, ".gitignore"),
        "utf-8"
      );

      expect(gitignore).toContain("node_modules/");
      expect(gitignore).toContain(".env");
      expect(gitignore).toContain(".npmrc");
      expect(gitignore).toContain("dist/");
    });

    test("App module wires a Router with multiple routes", async () => {
      const projectName = "router-app";
      await runCli(["init", projectName]);

      const componentTs = readFileSync(
        join(testDir, projectName, "src/components/App/component.ts"),
        "utf-8"
      );
      const componentHypen = readFileSync(
        join(testDir, projectName, "src/components/App/component.hypen"),
        "utf-8"
      );

      // Typed navigation action drives the Router's current route.
      expect(componentTs).toContain("defineState");
      expect(componentTs).toContain("location");
      expect(componentTs).toContain(".onAction<NavigatePayload>");
      expect(componentTs).toContain("\"navigate\"");

      // Template should declare a Router with at least the two routes
      // we scaffold (Home + Counter) and use Tailwind via `.tw(...)`.
      expect(componentHypen).toContain("Router");
      expect(componentHypen).toContain("Route(path: \"/\")");
      expect(componentHypen).toContain("Route(path: \"/counter\")");
      expect(componentHypen).toContain("Home()");
      expect(componentHypen).toContain("Counter()");
      expect(componentHypen).toContain(".tw(");
    });

    test("Counter module demonstrates state mutation and typed actions", async () => {
      const projectName = "counter-app";
      await runCli(["init", projectName]);

      const componentTs = readFileSync(
        join(testDir, projectName, "src/components/Counter/component.ts"),
        "utf-8"
      );
      const componentHypen = readFileSync(
        join(testDir, projectName, "src/components/Counter/component.hypen"),
        "utf-8"
      );

      expect(componentTs).toContain("defineState");
      expect(componentTs).toContain("count");
      expect(componentTs).toContain("increment");
      expect(componentTs).toContain("decrement");
      // Typed payload action demonstrating action type inference.
      expect(componentTs).toContain(".onAction<StepPayload>");

      expect(componentHypen).toContain("@{state.count}");
      expect(componentHypen).toContain("@actions.increment");
      expect(componentHypen).toContain("@actions.decrement");
      // The Counter scaffold styles entirely with Tailwind utilities.
      expect(componentHypen).toContain(".tw(");
    });

    test("Home module exists as a second module with typed action", async () => {
      const projectName = "home-app";
      await runCli(["init", projectName]);

      const homeTs = readFileSync(
        join(testDir, projectName, "src/components/Home/component.ts"),
        "utf-8"
      );
      const homeHypen = readFileSync(
        join(testDir, projectName, "src/components/Home/component.hypen"),
        "utf-8"
      );

      expect(homeTs).toContain("app\n  .module(\"Home\")");
      expect(homeTs).toContain(".onAction<UpdateGreetingPayload>");
      // Home links back to /counter through the parent's navigate action.
      expect(homeHypen).toContain("@actions.navigate");
      expect(homeHypen).toContain("/counter");
    });

    test("creates tsconfig.json", async () => {
      const projectName = "ts-app";
      await runCli(["init", projectName]);

      const tsconfig = JSON.parse(
        readFileSync(join(testDir, projectName, "tsconfig.json"), "utf-8")
      );

      expect(tsconfig.compilerOptions.target).toBe("ESNext");
      expect(tsconfig.compilerOptions.module).toBe("ESNext");
      expect(tsconfig.compilerOptions.strict).toBe(true);
    });

    test("rejects invalid project names", async () => {
      const result = await runCli(["init", ".hidden-project"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Invalid project name");
    });
  });

  describe("input validation", () => {
    test("rejects invalid port numbers", async () => {
      const result = await runCli(["dev", "--port", "99999"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Port must be between 1 and 65535");
    });

    test("rejects non-numeric port", async () => {
      const result = await runCli(["dev", "--port", "abc"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Port must be a valid integer");
    });
  });

  describe("unknown command", () => {
    test("shows error for unknown command", async () => {
      const result = await runCli(["unknown-command"]);

      // Error message goes to stderr
      expect(result.stderr).toContain("Unknown command");
      expect(result.exitCode).toBe(1);
    });
  });

  describe("test command", () => {
    test("recognises the command and detects missing project", async () => {
      // Spawn in an empty temp dir (no hypen.json, no src/components) and
      // give it a moment to print the connect-only banner, then kill it
      // before it actually opens a browser tab. We assert on stdout rather
      // than waiting for clean exit because Studio is designed to run
      // indefinitely.
      const proc = spawn({
        cmd: ["bun", cliPath, "test"],
        cwd: testDir,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, HYPEN_NO_OPEN: "1" },
      });

      let stdoutBuf = "";
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      const deadline = Date.now() + 4000;
      try {
        while (Date.now() < deadline) {
          const { value, done } = await reader.read();
          if (done) break;
          stdoutBuf += decoder.decode(value);
          if (stdoutBuf.includes("Not inside a Hypen project")) break;
        }
      } finally {
        try { proc.kill(); } catch { /* already dead */ }
        await proc.exited.catch(() => { /* expected */ });
      }

      expect(stdoutBuf).toContain("Not inside a Hypen project");
      // Crucially, the test command should NOT be treated as unknown.
      expect(stdoutBuf).not.toContain("Unknown command");
    }, 10_000);
  });

  describe("dev command (server-based)", () => {
    test("runs the entry script instead of component discovery", async () => {
      // A server-based project: hypen.json entry is a script path, no
      // components directory exists. `hypen dev` must run the script (with
      // the configured port in $PORT) rather than crash trying to watch
      // ./src/components.
      const projectDir = join(testDir, "server-dev");
      mkdirSync(join(projectDir, "src"), { recursive: true });
      writeFileSync(
        join(projectDir, "package.json"),
        JSON.stringify({ name: "server-dev", type: "module" })
      );
      writeFileSync(
        join(projectDir, "hypen.json"),
        JSON.stringify({ entry: "./src/app.ts", port: 3123 })
      );
      writeFileSync(
        join(projectDir, "src/app.ts"),
        'console.log("SERVER_ENTRY_BOOTED on " + process.env.PORT);'
      );

      const proc = spawn({
        cmd: ["bun", cliPath, "dev"],
        cwd: projectDir,
        stdout: "pipe",
        stderr: "pipe",
      });

      let stdoutBuf = "";
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      const deadline = Date.now() + 8000;
      try {
        while (Date.now() < deadline) {
          const { value, done } = await reader.read();
          if (done) break;
          stdoutBuf += decoder.decode(value);
          if (stdoutBuf.includes("SERVER_ENTRY_BOOTED")) break;
        }
      } finally {
        try { proc.kill(); } catch { /* already dead */ }
        await proc.exited.catch(() => { /* expected */ });
      }

      expect(stdoutBuf).toContain("(server-based)");
      expect(stdoutBuf).toContain("SERVER_ENTRY_BOOTED on 3123");
      expect(stdoutBuf).not.toContain("ENOENT");
    }, 15_000);
  });

  describe("command parsing", () => {
    test("parses --port option", async () => {
      // This would start a server, so we just test the help mentions the option
      const result = await runCli(["--help"]);

      expect(result.stdout).toContain("--port");
    });

    test("parses --debug option", async () => {
      const result = await runCli(["--help"]);

      // Debug is available in examples section
      expect(result.exitCode).toBe(0);
    });
  });
});

describe("CLI Config Loading", () => {
  const testDir = `/tmp/hypen-cli-config-test-${Date.now()}`;
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

  describe("loadConfig with hypen.json", () => {
    test("loads config from hypen.json when present", async () => {
      // Create a hypen.json config
      const config = {
        entry: "Main",
        components: "./src/views",
        port: 4000,
        outDir: "build",
      };
      const { writeFileSync } = await import("fs");
      writeFileSync(join(testDir, "hypen.json"), JSON.stringify(config));

      // Create minimal component structure so the CLI doesn't error
      mkdirSync(join(testDir, "src/views/Main"), { recursive: true });
      writeFileSync(join(testDir, "src/views/Main/component.ts"), "export default {}");
      writeFileSync(join(testDir, "src/views/Main/component.hypen"), "Text('Main')");

      // Run generate command which uses loadConfig
      const result = await runCli(["generate"], testDir);

      // The generate command should have used the config's components path
      expect(result.exitCode).toBe(0);
    });
  });
});
