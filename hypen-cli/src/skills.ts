import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { createInterface } from "readline";
import { SKILL_CONTENT } from "./skill-content.js";
import { dim, pink } from "./colors.js";

export type SkillTarget = "claude" | "agents" | "none";

/**
 * Interactive prompt asking the user which AI agent skill files to install.
 * In non-interactive environments (piped stdin, CI), defaults to "agents".
 */
export async function promptSkillChoice(): Promise<SkillTarget> {
  if (!process.stdin.isTTY) {
    return "agents";
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log(`\n  ${pink("AI Agent Skills")}`);
  console.log(`  Install Hypen language skills so AI coding agents understand Hypen DSL?\n`);
  console.log(`    1) Claude Code only`);
  console.log(`    2) All agents (Claude Code + general) ${dim("(Recommended)")}`);
  console.log(`    3) None\n`);

  return new Promise<SkillTarget>((resolve) => {
    rl.question("  Choose (1-3): ", (answer) => {
      rl.close();
      const trimmed = answer.trim();
      if (trimmed === "1") resolve("claude");
      else if (trimmed === "2") resolve("agents");
      else if (trimmed === "3") resolve("none");
      else {
        console.log(`  ${dim("Defaulting to: All agents")}`);
        resolve("agents");
      }
    });
  });
}

/**
 * Write skill files to the appropriate directories.
 */
export function installSkills(projectDir: string, target: SkillTarget): void {
  if (target === "none") return;

  const claudeSkillDir = join(projectDir, ".claude", "skills");
  const claudeSkillPath = join(claudeSkillDir, "hypen-ui.md");

  mkdirSync(claudeSkillDir, { recursive: true });
  writeFileSync(claudeSkillPath, SKILL_CONTENT);
  console.log(`  ${dim("Created:")} .claude/skills/hypen-ui.md`);

  if (target === "agents") {
    const agentSkillDir = join(projectDir, ".agent", "skills");
    const agentSkillPath = join(agentSkillDir, "hypen-ui.md");

    mkdirSync(agentSkillDir, { recursive: true });
    writeFileSync(agentSkillPath, SKILL_CONTENT);
    console.log(`  ${dim("Created:")} .agent/skills/hypen-ui.md`);
  }
}

/**
 * Ensure .gitignore has entries for skill directories.
 */
export function ensureGitignoreSkillEntries(projectDir: string): void {
  const gitignorePath = join(projectDir, ".gitignore");
  const entries = [".claude/skills/", ".agent/skills/"];

  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, entries.join("\n") + "\n");
    console.log(`  ${dim("Created:")} .gitignore (with skill entries)`);
    return;
  }

  const content = readFileSync(gitignorePath, "utf-8");
  const missing = entries.filter((e) => !content.includes(e));
  if (missing.length === 0) return;

  const suffix = (content.endsWith("\n") ? "" : "\n") + missing.join("\n") + "\n";
  writeFileSync(gitignorePath, content + suffix);
  console.log(`  ${dim("Updated:")} .gitignore (added ${missing.join(", ")})`);
}
