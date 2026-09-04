import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import {
  findHypenFiles,
  formatA11yReport,
  partitionFindings,
  resolveCheckTargets,
  checkOutcome,
  detectRuleDrift,
  formatDriftWarning,
  COULD_NOT_CHECK,
  EXPECTED_A11Y_RULES,
} from "../src/check.js";

describe("findHypenFiles", () => {
  const testDir = `/tmp/hypen-check-test-${Date.now()}`;

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test("recursively finds .hypen files", () => {
    mkdirSync(join(testDir, "src/components/Counter"), { recursive: true });
    writeFileSync(join(testDir, "src/components/Counter/component.hypen"), "Text('hi')");
    writeFileSync(join(testDir, "src/components/App.hypen"), "Router {}");
    writeFileSync(join(testDir, "src/components/App.ts"), "export default {}");

    const files = findHypenFiles(testDir);
    expect(files.length).toBe(2);
    expect(files.some((f) => f.endsWith("App.hypen"))).toBe(true);
    expect(files.some((f) => f.endsWith("Counter/component.hypen"))).toBe(true);
    // Non-.hypen files are excluded.
    expect(files.some((f) => f.endsWith(".ts"))).toBe(false);
  });

  test("skips node_modules and build dirs", () => {
    mkdirSync(join(testDir, "node_modules/pkg"), { recursive: true });
    writeFileSync(join(testDir, "node_modules/pkg/dep.hypen"), "Text('dep')");
    mkdirSync(join(testDir, "dist"), { recursive: true });
    writeFileSync(join(testDir, "dist/out.hypen"), "Text('out')");
    mkdirSync(join(testDir, ".hypen"), { recursive: true });
    writeFileSync(join(testDir, ".hypen/cache.hypen"), "Text('cache')");
    writeFileSync(join(testDir, "real.hypen"), "Text('real')");

    const files = findHypenFiles(testDir);
    expect(files.length).toBe(1);
    expect(files[0].endsWith("real.hypen")).toBe(true);
  });

  test("returns sorted results", () => {
    writeFileSync(join(testDir, "b.hypen"), "Text('b')");
    writeFileSync(join(testDir, "a.hypen"), "Text('a')");

    const files = findHypenFiles(testDir);
    expect(files[0].endsWith("a.hypen")).toBe(true);
    expect(files[1].endsWith("b.hypen")).toBe(true);
  });

  test("returns empty for missing directory", () => {
    expect(findHypenFiles(join(testDir, "does-not-exist"))).toEqual([]);
  });
});

describe("formatA11yReport", () => {
  test("formats findings as '<file>: a11y[<rule>] <elementType> — <message>'", () => {
    const { lines, count } = formatA11yReport([
      {
        file: "src/components/App.hypen",
        diagnostic: {
          rule: "icon-only-control",
          elementType: "Button",
          message: "Button has no accessible label",
        },
      },
    ]);

    expect(count).toBe(1);
    expect(lines[0]).toBe(
      "src/components/App.hypen: a11y[icon-only-control] Button — Button has no accessible label",
    );
    expect(lines[1]).toBe("Found 1 accessibility issue across 1 file.");
  });

  test("includes file:line:col when the diagnostic carries a location", () => {
    const { lines } = formatA11yReport([
      {
        file: "src/components/Toolbar.hypen",
        diagnostic: {
          rule: "missing-accessible-name",
          elementType: "Button",
          message: "interactive Button has no accessible name",
          span: { start: 210, end: 216 },
          line: 14,
          col: 5,
        },
      },
    ]);

    expect(lines[0]).toBe(
      "src/components/Toolbar.hypen:14:5: a11y[missing-accessible-name] Button — interactive Button has no accessible name",
    );
  });

  test("omits location when line/col are absent (older engine binding)", () => {
    const { lines } = formatA11yReport([
      {
        file: "a.hypen",
        diagnostic: { rule: "r", elementType: "Button", message: "m" },
      },
    ]);
    expect(lines[0]).toBe("a.hypen: a11y[r] Button — m");
  });

  test("counts distinct files and pluralizes the summary", () => {
    const { lines, count } = formatA11yReport([
      {
        file: "a.hypen",
        diagnostic: { rule: "r1", elementType: "Button", message: "m1" },
      },
      {
        file: "a.hypen",
        diagnostic: { rule: "r2", elementType: "Image", message: "m2" },
      },
      {
        file: "b.hypen",
        diagnostic: { rule: "r3", elementType: "Input", message: "m3" },
      },
    ]);

    expect(count).toBe(3);
    expect(lines[lines.length - 1]).toBe(
      "Found 3 accessibility issues across 2 files.",
    );
  });

  test("reports a clean pass when there are no findings", () => {
    const { lines, count } = formatA11yReport([]);
    expect(count).toBe(0);
    expect(lines).toEqual(["No accessibility issues found."]);
  });
});

describe("partitionFindings", () => {
  const diag = (rule: string, extra: object = {}) => ({
    rule,
    elementType: "Button",
    message: "m",
    ...extra,
  });

  test("engine-marked suppressed findings are counted, not active", () => {
    const { active, suppressedCount } = partitionFindings([
      diag("missing-accessible-name", { suppressed: true }),
      diag("image-missing-alt"),
    ]);
    expect(suppressedCount).toBe(1);
    expect(active.map((d) => d.rule)).toEqual(["image-missing-alt"]);
  });

  test("config ignoreRules suppress matching rules only", () => {
    const { active, suppressedCount } = partitionFindings(
      [diag("heading-missing-level"), diag("image-missing-alt")],
      ["heading-missing-level"],
    );
    expect(suppressedCount).toBe(1);
    expect(active.map((d) => d.rule)).toEqual(["image-missing-alt"]);
  });

  test("a non-matching ignore rule suppresses nothing", () => {
    const { active, suppressedCount } = partitionFindings(
      [diag("image-missing-alt")],
      ["dangling-reference"],
    );
    expect(suppressedCount).toBe(0);
    expect(active.length).toBe(1);
  });

  test("inline and config suppression accumulate into one count", () => {
    const { active, suppressedCount } = partitionFindings(
      [
        diag("missing-accessible-name", { suppressed: true }),
        diag("heading-missing-level"),
        diag("image-missing-alt"),
      ],
      ["heading-missing-level"],
    );
    expect(suppressedCount).toBe(2);
    expect(active.map((d) => d.rule)).toEqual(["image-missing-alt"]);
  });

  test("older bindings without the suppressed field suppress nothing", () => {
    const { active, suppressedCount } = partitionFindings([
      diag("image-missing-alt"),
    ]);
    expect(suppressedCount).toBe(0);
    expect(active.length).toBe(1);
  });
});

describe("formatA11yReport suppressed-count line", () => {
  const finding = {
    file: "a.hypen",
    diagnostic: { rule: "r", elementType: "Button", message: "m" },
  };

  test("appends 'N findings suppressed.' after the summary", () => {
    const { lines, count } = formatA11yReport([finding], 2);
    expect(count).toBe(1);
    expect(lines[lines.length - 1]).toBe("2 findings suppressed.");
  });

  test("singular form for one suppressed finding", () => {
    const { lines } = formatA11yReport([], 1);
    expect(lines).toEqual([
      "No accessibility issues found.",
      "1 finding suppressed.",
    ]);
  });

  test("no suppressed line when nothing was suppressed", () => {
    const { lines } = formatA11yReport([finding]);
    expect(lines.some((l) => l.includes("suppressed"))).toBe(false);
  });

  test("suppressed findings never enter the count (exit code input)", () => {
    // All findings suppressed → clean pass + visible suppression summary.
    const { lines, count } = formatA11yReport([], 3);
    expect(count).toBe(0);
    expect(lines).toEqual([
      "No accessibility issues found.",
      "3 findings suppressed.",
    ]);
  });
});

describe("COULD_NOT_CHECK sentinel", () => {
  test("is distinct from clean (0) and found-issues (>0) so the caller can pick a separate exit code", () => {
    expect(COULD_NOT_CHECK).toBeLessThan(0);
    // The dispatcher checks `=== COULD_NOT_CHECK` before `count > 0 ? 1 : 0`,
    // so a "couldn't check" never collapses into the clean (exit 0) path.
    expect(COULD_NOT_CHECK).not.toBe(0);
  });
});

describe("resolveCheckTargets", () => {
  const testDir = `/tmp/hypen-check-targets-${Date.now()}`;

  beforeEach(() => {
    mkdirSync(join(testDir, "src/components"), { recursive: true });
    writeFileSync(join(testDir, "src/components/App.hypen"), "Text('a')");
    writeFileSync(join(testDir, "src/components/B.hypen"), "Text('b')");
    writeFileSync(join(testDir, "loose.hypen"), "Text('loose')");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("a file argument is checked as-is", () => {
    const { files, missing } = resolveCheckTargets(["loose.hypen"], testDir);
    expect(files).toEqual([join(testDir, "loose.hypen")]);
    expect(missing).toEqual([]);
  });

  test("a directory argument is scanned for .hypen files", () => {
    const { files, missing } = resolveCheckTargets(["src"], testDir);
    expect(files).toEqual([
      join(testDir, "src/components/App.hypen"),
      join(testDir, "src/components/B.hypen"),
    ]);
    expect(missing).toEqual([]);
  });

  test("relative paths resolve against the given cwd, absolute pass through", () => {
    const abs = join(testDir, "src/components/App.hypen");
    const { files } = resolveCheckTargets([abs, "loose.hypen"], testDir);
    expect(files).toEqual([abs, join(testDir, "loose.hypen")].sort());
  });

  test("nonexistent paths land in `missing`, never silently dropped", () => {
    const { files, missing } = resolveCheckTargets(
      ["does-not-exist", "loose.hypen"],
      testDir,
    );
    expect(missing).toEqual(["does-not-exist"]);
    expect(files).toEqual([join(testDir, "loose.hypen")]);
  });

  test("duplicate targets (file also inside a named dir) are deduped", () => {
    const { files } = resolveCheckTargets(
      ["src", "src/components/App.hypen"],
      testDir,
    );
    expect(files.filter((f) => f.endsWith("App.hypen")).length).toBe(1);
  });
});

describe("checkOutcome", () => {
  test("findings win: non-zero count returned even when files also failed", () => {
    expect(checkOutcome(3, 2)).toBe(3);
  });

  test("no findings + failed files → COULD_NOT_CHECK, never a clean 0", () => {
    expect(checkOutcome(0, 1)).toBe(COULD_NOT_CHECK);
  });

  test("no findings + nothing failed → clean 0", () => {
    expect(checkOutcome(0, 0)).toBe(0);
  });
});

describe("detectRuleDrift", () => {
  test("binding without a11yRules() reports every expected rule missing", () => {
    const drift = detectRuleDrift({});
    expect(drift.hasRuleList).toBe(false);
    expect(drift.missing).toEqual([...EXPECTED_A11Y_RULES]);
  });

  test("binding advertising the full rule set is in sync", () => {
    const drift = detectRuleDrift({ a11yRules: () => [...EXPECTED_A11Y_RULES] });
    expect(drift.hasRuleList).toBe(true);
    expect(drift.missing).toEqual([]);
  });

  test("binding missing a newer rule reports exactly that rule", () => {
    const advertised = EXPECTED_A11Y_RULES.filter(
      (r) => r !== "dangling-reference",
    );
    const drift = detectRuleDrift({ a11yRules: () => advertised });
    expect(drift.hasRuleList).toBe(true);
    expect(drift.missing).toEqual(["dangling-reference"]);
  });

  test("extra (future) rules from a newer binding are not drift", () => {
    const drift = detectRuleDrift({
      a11yRules: () => [...EXPECTED_A11Y_RULES, "some-future-rule"],
    });
    expect(drift.missing).toEqual([]);
  });

  test("a throwing a11yRules() is treated as absent, not clean", () => {
    const drift = detectRuleDrift({
      a11yRules: () => {
        throw new Error("boom");
      },
    });
    expect(drift.hasRuleList).toBe(false);
    expect(drift.missing).toEqual([...EXPECTED_A11Y_RULES]);
  });

  test("expected rules include the newest rule (regression: shipped wasm lacked it)", () => {
    expect(EXPECTED_A11Y_RULES).toContain("dangling-reference");
    expect(EXPECTED_A11Y_RULES).toContain("unknown-live-token");
    expect(EXPECTED_A11Y_RULES).toContain("unknown-ignore-rule");
    expect(EXPECTED_A11Y_RULES).toContain("video-missing-label");
  });
});

describe("formatDriftWarning", () => {
  test("silent when the binding is in sync", () => {
    expect(formatDriftWarning({ hasRuleList: true, missing: [] })).toEqual([]);
  });

  test("names the missing rules and the rebuild command, as a warning not a failure", () => {
    const lines = formatDriftWarning({
      hasRuleList: true,
      missing: ["dangling-reference"],
    });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toContain("older than this checker");
    expect(lines[0]).toContain("bun run build:wasm");
    expect(lines[0]).toContain("dangling-reference");
    expect(lines[0]).toContain("WARNING");
  });
});
