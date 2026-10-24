/**
 * Target-directory checks for `hypen init`.
 *
 * The generators write files unconditionally, so scaffolding into a
 * directory that already holds a project would silently overwrite the
 * user's `package.json`, `hypen.json` and components. `hypen init` refuses
 * a non-empty target instead; entries that are harmless to scaffold next
 * to (a fresh `git init`, editor folders, OS metadata) don't count.
 */

import { existsSync, readdirSync, statSync } from "fs";

/** Entries that don't make a directory "non-empty" for `hypen init`. */
const IGNORED_ENTRIES = new Set([".git", ".DS_Store", "Thumbs.db", ".idea", ".vscode"]);

/**
 * Why `hypen init` can't scaffold into `dir`, or `null` when it can (the
 * directory doesn't exist yet, or holds only ignorable entries).
 */
export function initTargetProblem(dir: string): string | null {
  if (!existsSync(dir)) return null;
  if (!statSync(dir).isDirectory()) {
    return `${dir} already exists and is not a directory.`;
  }
  const entries = readdirSync(dir).filter((name) => !IGNORED_ENTRIES.has(name));
  if (entries.length === 0) return null;
  const shown = entries.slice(0, 5).join(", ") + (entries.length > 5 ? ", ..." : "");
  return `${dir} is not empty (${shown}). hypen init would overwrite files there.`;
}
