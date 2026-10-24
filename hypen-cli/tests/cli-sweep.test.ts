/**
 * Regression tests for the CLI/Studio sweep fixes: init target checks,
 * strict --port parsing, Go/Kotlin project detection, template parse-error
 * diagnostics, `hypen generate` import paths and per-command flag wiring.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawn } from "bun";
import { initTargetProblem } from "../src/init/target";
import { npmPackageName } from "../src/init/typescript";
import { nonTsProjectKind, nonTsRunHint, parsePortArg } from "../src/project-kind";
import {
  byteOffsetToLineCol,
  createHypenSourceValidator,
  formatHypenParseError,
  formatReloadError,
} from "../src/dev-diagnostics";

const cliPath = join(import.meta.dir, "../bin/hypen.ts");
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hypen-sweep-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function runCli(args: string[], cwd = dir, env: Record<string, string> = {}) {
  const proc = spawn({
    cmd: ["bun", cliPath, ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env, HYPEN_NO_ONBOARDING: "1", NO_COLOR: "1", ...env },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { stdout, stderr, exitCode: await proc.exited };
}

describe("hypen init target directory", () => {
  test("a missing or empty directory (or one with only .git) is fine", () => {
    expect(initTargetProblem(join(dir, "nope"))).toBeNull();
    expect(initTargetProblem(dir)).toBeNull();
    mkdirSync(join(dir, ".git"));
    expect(initTargetProblem(dir)).toBeNull();
  });

  test("a directory with files is refused", () => {
    writeFileSync(join(dir, "package.json"), "{}");
    expect(initTargetProblem(dir)).toContain("is not empty (package.json)");
  });

  test("init refuses to overwrite an existing project", async () => {
    const target = join(dir, "app");
    mkdirSync(join(target, "src/components/Home"), { recursive: true });
    writeFileSync(join(target, "src/components/Home/component.hypen"), 'Text("MINE")');
    const result = await runCli(["init", "app"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("is not empty");
    expect(readFileSync(join(target, "src/components/Home/component.hypen"), "utf-8")).toBe('Text("MINE")');
    expect(existsSync(join(target, "package.json"))).toBe(false);
  });

  test("package names are npm-valid", () => {
    expect(npmPackageName("My App")).toBe("my-app");
    expect(npmPackageName("UPPER")).toBe("upper");
    expect(npmPackageName("ok-name")).toBe("ok-name");
    expect(npmPackageName("   ")).toBe("hypen-app");
  });
});

describe("--port parsing", () => {
  test("accepts plain integers in range", () => {
    expect(parsePortArg("5400")).toEqual({ port: 5400 });
  });

  test("rejects trailing garbage, zero and out-of-range values", () => {
    expect(parsePortArg("3000abc")).toHaveProperty("error");
    expect(parsePortArg("0")).toHaveProperty("error");
    expect(parsePortArg("70000")).toHaveProperty("error");
    expect(parsePortArg("-1")).toHaveProperty("error");
  });

  test("the CLI rejects --port 3000abc instead of using 3000", async () => {
    const result = await runCli(["dev", "--port", "3000abc"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Port must be a valid integer");
  });

  test("--studio-port is validated too", async () => {
    const result = await runCli(["test", "--studio-port", "x1"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--studio-port");
  });
});

describe("Go/Kotlin projects", () => {
  test("detected from go.mod / gradle files when there is no package.json", () => {
    expect(nonTsProjectKind(dir)).toBeNull();
    writeFileSync(join(dir, "go.mod"), "module x\n");
    expect(nonTsProjectKind(dir)).toBe("go");
    expect(nonTsRunHint("go", dir)).toBe("go run .");
    writeFileSync(join(dir, "package.json"), "{}");
    expect(nonTsProjectKind(dir)).toBeNull();
  });

  test("kotlin hint prefers the wrapper", () => {
    writeFileSync(join(dir, "build.gradle.kts"), "");
    expect(nonTsProjectKind(dir)).toBe("kotlin");
    expect(nonTsRunHint("kotlin", dir)).toBe("gradle run");
    writeFileSync(join(dir, "gradlew"), "");
    expect(nonTsRunHint("kotlin", dir)).toBe("./gradlew run");
  });

  test("hypen dev in a Go project explains instead of writing a package.json", async () => {
    writeFileSync(join(dir, "go.mod"), "module x\n");
    writeFileSync(join(dir, "hypen.json"), '{"components":"./components","entry":"App"}');
    const result = await runCli(["dev", "--port", "5497"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Go Hypen project");
    expect(result.stderr).toContain("go run .");
    expect(existsSync(join(dir, "package.json"))).toBe(false);
  });
});

describe("template diagnostics", () => {
  test("byte offsets map to 1-based line/col, counting characters", () => {
    expect(byteOffsetToLineCol("abc\ndef", 5)).toEqual({ line: 2, col: 2 });
    // "→" is 3 bytes in UTF-8 but one column.
    expect(byteOffsetToLineCol('Text("→")\n{{', 12)).toEqual({ line: 2, col: 1 });
    expect(byteOffsetToLineCol('Text("→")', 10)).toEqual({ line: 1, col: 9 });
  });

  test("parse errors become file:line:col with a code frame", () => {
    const source = "module Home {\n  Column {{{ (\n  }\n}";
    const lines = formatHypenParseError("Home/component.hypen", source, {
      type: "parseError",
      message: "unexpected '{' at position 24",
    });
    expect(lines[0]).toBe("Home/component.hypen:2:11: parse error: unexpected '{'");
    expect(lines.join("\n")).toContain("> 2 |   Column {{{ (");
    expect(lines.join("\n")).toContain("^");
  });

  test("errors without a position are passed through", () => {
    expect(formatHypenParseError("a.hypen", "", new Error("boom"))).toEqual(["a.hypen: boom"]);
  });

  test("Bun build errors are listed with their locations", () => {
    const err = Object.assign(new AggregateError([], '2 errors building "/p/src/components/Home/component.ts"'), {
      errors: [
        { message: 'Expected ";" but found "is"', position: { file: "/p/src/components/Home/component.ts", line: 3, column: 6, lineText: "this is bad" } },
        { message: "Unexpected end of file", position: null },
      ],
    });
    const lines = formatReloadError(err, "/p");
    expect(lines[0]).toContain("2 errors building");
    expect(lines[1]).toBe('  src/components/Home/component.ts:3:6: Expected ";" but found "is"');
    expect(lines[2]).toContain("this is bad");
    expect(lines[3]).toBe("  Unexpected end of file");
  });

  test("the source validator reports only broken templates", async () => {
    mkdirSync(join(dir, "Good"), { recursive: true });
    mkdirSync(join(dir, "Bad"), { recursive: true });
    writeFileSync(join(dir, "Good/component.hypen"), 'Text("ok")');
    writeFileSync(join(dir, "Bad/component.hypen"), "Column {{");
    const validate = createHypenSourceValidator({
      componentsDir: dir,
      projectRoot: dir,
      parse: (src) => {
        if (src.includes("{{")) throw { type: "parseError", message: "unexpected '{' at position 8" };
      },
    });
    const problems = await validate();
    expect(problems[0]).toBe("Bad/component.hypen:1:9: parse error: unexpected '{'");
    expect(problems.join("\n")).not.toContain("Good");
  });

  test("the validator works with the real engine", async () => {
    mkdirSync(join(dir, "Bad"), { recursive: true });
    writeFileSync(join(dir, "Bad/component.hypen"), "module Bad {\n  Column {{{ (\n}\n");
    const problems = await createHypenSourceValidator({ componentsDir: dir, projectRoot: dir })();
    // The error is at the stray '{' (2:11), not at the module's '{' (1:12).
    expect(problems[0]).toBe("Bad/component.hypen:2:11: parse error: expected component or '}', found '{'");
  });
});

describe("hypen generate", () => {
  test("writes imports that resolve from .hypen/", async () => {
    mkdirSync(join(dir, "src/components/Home"), { recursive: true });
    writeFileSync(join(dir, "src/components/Home/component.hypen"), 'module Home { Text("hi") }');
    writeFileSync(
      join(dir, "src/components/Home/component.ts"),
      'import { app } from "@hypen-space/core";\nexport default app.defineState({}).build();\n',
    );
    writeFileSync(join(dir, "hypen.json"), '{"components":"./src/components","entry":"Home"}');
    writeFileSync(join(dir, "package.json"), '{"name":"x"}');
    const result = await runCli(["generate"]);
    expect(result.exitCode).toBe(0);
    const code = readFileSync(join(dir, ".hypen/components.generated.ts"), "utf-8");
    expect(code).toContain('from "../src/components/Home/component.js"');
  });

  test("a missing components directory is reported", async () => {
    writeFileSync(join(dir, "hypen.json"), '{"components":"./src/nope"}');
    writeFileSync(join(dir, "package.json"), '{"name":"x"}');
    const result = await runCli(["generate"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("components directory not found");
  });
});

describe("help and errors", () => {
  test("global help lists every command's flags", async () => {
    const { stdout } = await runCli(["--help"]);
    for (const flag of ["--minify", "--sourcemap", "--session", "--studio-port", "--url", "--clean", "a11y"]) {
      expect(stdout).toContain(flag);
    }
  });

  test("hypen test --help documents --studio-port", async () => {
    const { stdout } = await runCli(["test", "--help"]);
    expect(stdout).toContain("--studio-port");
  });

  test("unknown commands are reported concisely with a suggestion", async () => {
    const result = await runCli(["devv"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unknown command: devv");
    expect(result.stderr).toContain("did you mean dev?");
    expect(result.stdout).not.toContain("Commands:");
  });

  test("unknown flags don't carry node's positional-argument advice", async () => {
    const result = await runCli(["build", "--bogus"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unknown option '--bogus'");
    expect(result.stderr).not.toContain("positional argument");
  });
});

describe("hypen run ios --device", () => {
  test("both runIOS call sites receive the run options (device)", () => {
    const src = readFileSync(join(import.meta.dir, "../bin/hypen.ts"), "utf-8");
    const calls = src.match(/runIOS\([^)]*\)/g) ?? [];
    expect(calls.length).toBe(2);
    for (const call of calls) expect(call).toContain("runOpts");
    expect(src).toMatch(/const runOpts = \{ device: options\.device/);
  });

  test("run help documents --device for iOS", async () => {
    const { stdout } = await runCli(["run", "--help"]);
    expect(stdout).toContain("iOS: simulator name or UDID");
    expect(stdout).toContain('hypen run ios --device "iPhone 16 Pro"');
  });
});

describe("hypen run android device states", () => {
  test("attached-but-unusable devices are explained", async () => {
    const { unreadyAdbDevices } = await import("../src/run");
    const out = unreadyAdbDevices(
      "List of devices attached\nR58M\tunauthorized\nemulator-5554\toffline\nZX1\tdevice\n",
    );
    expect(out.map((d) => [d.id, d.status])).toEqual([
      ["R58M", "unauthorized"],
      ["emulator-5554", "offline"],
    ]);
    expect(out[0]!.hint).toContain("Allow USB debugging");
    expect(unreadyAdbDevices("List of devices attached\n")).toEqual([]);
  });
});
