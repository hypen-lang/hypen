#!/usr/bin/env bun
/**
 * create-hypen-cf — scaffold a Hypen-on-Cloudflare app.
 *
 *   bunx create-hypen-cf my-app
 *   bunx create-hypen-cf my-app --module Dashboard
 *
 * Writes the file set from `scaffold()` into a new ./<app-name> directory.
 */

import { mkdir, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { scaffold, type ScaffoldOptions } from "../src/scaffold.ts";

function parseArgs(argv: string[]): { appName?: string; moduleName?: string } {
  const out: { appName?: string; moduleName?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--module" || a === "-m") {
      out.moduleName = argv[++i];
    } else if (a.startsWith("--module=")) {
      out.moduleName = a.slice("--module=".length);
    } else if (!a.startsWith("-") && !out.appName) {
      out.appName = a;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.appName) {
    console.error("usage: create-hypen-cf <app-name> [--module <Name>]");
    process.exit(1);
  }

  const opts: ScaffoldOptions = {
    appName: args.appName,
    moduleName: args.moduleName,
  };

  let files: Map<string, string>;
  try {
    files = scaffold(opts);
  } catch (err) {
    console.error(`✘ ${(err as Error).message}`);
    process.exit(1);
  }

  const targetDir = resolve(process.cwd(), args.appName);
  if (existsSync(targetDir) && (await readdir(targetDir)).length > 0) {
    console.error(`✘ Directory "${args.appName}" already exists and is not empty.`);
    process.exit(1);
  }

  for (const [relPath, content] of files) {
    const full = join(targetDir, relPath);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }

  console.log(`✓ Created ${args.appName}/ (${files.size} files)\n`);
  console.log("Next:");
  console.log(`  cd ${args.appName}`);
  console.log("  bun install");
  console.log("  bun run dev        # wrangler dev → ws://localhost:8787/ws\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
