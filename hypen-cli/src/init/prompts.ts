/**
 * Interactive prompts for `hypen init`.
 *
 * Everything in this file is TTY-aware: if the CLI is being driven non-
 * interactively (e.g. tests, CI, piped stdin) every prompt resolves to the
 * documented default so the command still produces a usable project.
 */

import { createInterface } from "readline";
import { dim, pink } from "../colors.js";

export type Language = "typescript" | "go" | "kotlin";
export type ModuleLayout = "file-based" | "server-based";

const LANGUAGES: { key: Language; label: string; note?: string }[] = [
  { key: "typescript", label: "TypeScript", note: "Recommended" },
  { key: "go", label: "Go" },
  { key: "kotlin", label: "Kotlin" },
];

const LAYOUTS: { key: ModuleLayout; label: string; description: string }[] = [
  {
    key: "file-based",
    label: "File-based",
    description: "one folder per module, auto-discovered from the filesystem",
  },
  {
    key: "server-based",
    label: "Server-based",
    description: "modules registered inline with the server at startup",
  },
];

function ask(rl: ReturnType<typeof createInterface>, prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, (answer) => resolve(answer)));
}

/**
 * Prompt for the project's host language. Returns `"typescript"` when stdin
 * is not a TTY so automated flows keep working.
 */
export async function promptLanguage(): Promise<Language> {
  if (!process.stdin.isTTY) return "typescript";

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`\n  ${pink("Language")}`);
    console.log(`  Which language should your Hypen project use?\n`);
    LANGUAGES.forEach((lang, i) => {
      const suffix = lang.note ? ` ${dim(`(${lang.note})`)}` : "";
      console.log(`    ${i + 1}) ${lang.label}${suffix}`);
    });
    console.log("");

    const answer = (await ask(rl, `  Choose (1-${LANGUAGES.length}): `)).trim();
    const idx = parseInt(answer, 10) - 1;
    if (Number.isInteger(idx) && idx >= 0 && idx < LANGUAGES.length) {
      return LANGUAGES[idx]!.key;
    }
    console.log(`  ${dim("Defaulting to: TypeScript")}`);
    return "typescript";
  } finally {
    rl.close();
  }
}

/**
 * Prompt for whether modules should be discovered from the filesystem
 * (file-based) or registered programmatically at server startup
 * (server-based). Defaults to `"file-based"` outside of a TTY.
 */
export async function promptModuleLayout(): Promise<ModuleLayout> {
  if (!process.stdin.isTTY) return "file-based";

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`\n  ${pink("Module layout")}`);
    console.log(`  How should modules be organised in the generated project?\n`);
    LAYOUTS.forEach((layout, i) => {
      console.log(`    ${i + 1}) ${layout.label} ${dim(`- ${layout.description}`)}`);
    });
    console.log("");

    const answer = (await ask(rl, `  Choose (1-${LAYOUTS.length}): `)).trim();
    const idx = parseInt(answer, 10) - 1;
    if (Number.isInteger(idx) && idx >= 0 && idx < LAYOUTS.length) {
      return LAYOUTS[idx]!.key;
    }
    console.log(`  ${dim("Defaulting to: File-based")}`);
    return "file-based";
  } finally {
    rl.close();
  }
}
