import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { spawn } from "bun";

import { installSkills, ensureGitignoreSkillEntries } from "../src/skills.js";
import { SKILL_CONTENT } from "../src/skill-content.js";

describe("installSkills", () => {
  const testDir = `/tmp/hypen-skills-test-${Date.now()}`;

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test("'claude' target writes only .claude/skills/hypen-ui.md", () => {
    installSkills(testDir, "claude");

    expect(existsSync(join(testDir, ".claude/skills/hypen-ui.md"))).toBe(true);
    expect(existsSync(join(testDir, ".agent/skills/hypen-ui.md"))).toBe(false);

    const content = readFileSync(join(testDir, ".claude/skills/hypen-ui.md"), "utf-8");
    expect(content).toBe(SKILL_CONTENT);
  });

  test("'agents' target writes to both .claude and .agent", () => {
    installSkills(testDir, "agents");

    expect(existsSync(join(testDir, ".claude/skills/hypen-ui.md"))).toBe(true);
    expect(existsSync(join(testDir, ".agent/skills/hypen-ui.md"))).toBe(true);

    const claude = readFileSync(join(testDir, ".claude/skills/hypen-ui.md"), "utf-8");
    const agent = readFileSync(join(testDir, ".agent/skills/hypen-ui.md"), "utf-8");
    expect(claude).toBe(SKILL_CONTENT);
    expect(agent).toBe(SKILL_CONTENT);
  });

  test("'none' target writes nothing", () => {
    installSkills(testDir, "none");

    expect(existsSync(join(testDir, ".claude"))).toBe(false);
    expect(existsSync(join(testDir, ".agent"))).toBe(false);
  });

  test("skill content contains expected SKILL.md markers", () => {
    expect(SKILL_CONTENT).toContain("hypen-ui");
    expect(SKILL_CONTENT).toContain("# Building UI with Hypen");
    expect(SKILL_CONTENT).toContain("## Built-in Components");
    expect(SKILL_CONTENT.length).toBeGreaterThan(10000);
  });
});

describe("ensureGitignoreSkillEntries", () => {
  const testDir = `/tmp/hypen-gitignore-test-${Date.now()}`;

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test("creates .gitignore when none exists", () => {
    ensureGitignoreSkillEntries(testDir);

    const content = readFileSync(join(testDir, ".gitignore"), "utf-8");
    expect(content).toContain(".claude/skills/");
    expect(content).toContain(".agent/skills/");
  });

  test("appends missing entries to existing .gitignore", () => {
    writeFileSync(join(testDir, ".gitignore"), "node_modules/\ndist/\n");

    ensureGitignoreSkillEntries(testDir);

    const content = readFileSync(join(testDir, ".gitignore"), "utf-8");
    expect(content).toContain("node_modules/");
    expect(content).toContain("dist/");
    expect(content).toContain(".claude/skills/");
    expect(content).toContain(".agent/skills/");
  });

  test("does not duplicate entries if already present", () => {
    writeFileSync(join(testDir, ".gitignore"), ".claude/skills/\n.agent/skills/\n");

    ensureGitignoreSkillEntries(testDir);

    const content = readFileSync(join(testDir, ".gitignore"), "utf-8");
    // Count occurrences — should be exactly 1 each
    expect(content.match(/\.claude\/skills\//g)?.length).toBe(1);
    expect(content.match(/\.agent\/skills\//g)?.length).toBe(1);
  });

  test("appends only the missing entry when one already exists", () => {
    writeFileSync(join(testDir, ".gitignore"), "node_modules/\n.claude/skills/\n");

    ensureGitignoreSkillEntries(testDir);

    const content = readFileSync(join(testDir, ".gitignore"), "utf-8");
    expect(content.match(/\.claude\/skills\//g)?.length).toBe(1);
    expect(content).toContain(".agent/skills/");
  });

  test("handles .gitignore without trailing newline", () => {
    writeFileSync(join(testDir, ".gitignore"), "node_modules/");

    ensureGitignoreSkillEntries(testDir);

    const content = readFileSync(join(testDir, ".gitignore"), "utf-8");
    // Should have a newline between existing content and new entries
    expect(content).toBe("node_modules/\n.claude/skills/\n.agent/skills/\n");
  });
});

describe("CLI init installs skills (non-interactive)", () => {
  const testDir = `/tmp/hypen-init-skills-test-${Date.now()}`;
  const cliPath = join(import.meta.dir, "../bin/hypen.ts");

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const proc = spawn({
      cmd: ["bun", cliPath, ...args],
      cwd: testDir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    return { stdout, stderr, exitCode };
  }

  test("init creates skill files in both .claude and .agent dirs", async () => {
    const result = await runCli(["init", "skill-app"]);

    expect(result.exitCode).toBe(0);

    const projectDir = join(testDir, "skill-app");
    expect(existsSync(join(projectDir, ".claude/skills/hypen-ui.md"))).toBe(true);
    expect(existsSync(join(projectDir, ".agent/skills/hypen-ui.md"))).toBe(true);
  });

  test("init .gitignore includes skill entries", async () => {
    await runCli(["init", "gi-app"]);

    const gitignore = readFileSync(join(testDir, "gi-app", ".gitignore"), "utf-8");
    expect(gitignore).toContain(".claude/skills/");
    expect(gitignore).toContain(".agent/skills/");
  });

  test("skill files contain full SKILL.md content", async () => {
    await runCli(["init", "content-app"]);

    const content = readFileSync(
      join(testDir, "content-app", ".claude/skills/hypen-ui.md"),
      "utf-8"
    );
    expect(content).toBe(SKILL_CONTENT);
  });
});
