/**
 * Project-local resolution for the CLI.
 *
 * A globally installed `hypen` must run against the PROJECT's copies of
 * `@hypen-space/*`. Otherwise the project's `component.ts` files register
 * into the project's `@hypen-space/core` while the CLI's RemoteServer and
 * loader use the CLI's own copy — two module registries, so nested modules
 * never get their scoped handlers and every click fails with
 * "invalid scoped UI action" (the dual-package hazard).
 *
 * Two layers:
 *  1. `findLocalCli` + bin/hypen.ts re-exec: when the project has its own
 *     `@hypen-space/cli` (every `hypen init` scaffold does), the global CLI
 *     hands the whole invocation to it — dev, Studio, test, run all then
 *     share the project's packages.
 *  2. `importFromProject`: without a local CLI, the dev server imports the
 *     runtime packages from the project root when the project has them.
 */

import { existsSync, readFileSync, realpathSync } from "fs";
import { createRequire } from "module";
import { dirname, join, resolve } from "path";
import { pathToFileURL } from "url";

/** Walk up from `start` to the nearest dir containing `package.json` named `name`. */
export function findPackageRoot(start: string, name: string): string | null {
  let dir = resolve(start);
  for (let i = 0; i < 12; i++) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        if (JSON.parse(readFileSync(pkgPath, "utf-8"))?.name === name) return dir;
      } catch {
        /* unreadable package.json — keep walking */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export interface LocalCli {
  /** Package root of the project's @hypen-space/cli. */
  root: string;
  /** Absolute path to its `hypen` bin. */
  bin: string;
  version: string;
}

/**
 * The project-local `@hypen-space/cli` visible from `cwd` (node_modules
 * lookup walks up like Node's resolver), or null when there is none or it
 * is the very package `selfRoot` points at.
 */
export function findLocalCli(cwd: string, selfRoot: string | null): LocalCli | null {
  let dir = resolve(cwd);
  for (let i = 0; i < 32; i++) {
    const root = join(dir, "node_modules", "@hypen-space", "cli");
    const pkgPath = join(root, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        const binRel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.hypen;
        if (!binRel) return null;
        const bin = resolve(root, binRel);
        if (!existsSync(bin)) return null;
        if (selfRoot && realpathOrSelf(root) === realpathOrSelf(selfRoot)) return null;
        return { root, bin, version: String(pkg.version ?? "") };
      } catch {
        return null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Resolve `specifier` as if imported from a file in `projectRoot`. Returns
 * null when the project doesn't have it.
 *
 * Bun resolves with its own resolver (`bun` export condition → the
 * package's TS sources). Node uses `createRequire`, which walks the
 * project's node_modules like an import would; the `@hypen-space/*`
 * packages publish a `default` condition next to `import`, so this lands on
 * the same `dist/*.js` file an ESM import resolves to.
 */
export function resolveFromProject(
  specifier: string,
  projectRoot: string = process.cwd()
): string | null {
  if (typeof globalThis.Bun !== "undefined") {
    try {
      return Bun.resolveSync(specifier, projectRoot);
    } catch {
      return null;
    }
  }
  try {
    return createRequire(join(resolve(projectRoot), "package.json")).resolve(specifier);
  } catch {
    return null;
  }
}

/**
 * Import `specifier` from the project's node_modules when it has the
 * package, else via `fallback` (the CLI's own copy — a literal `import()`
 * so the bundler still sees it).
 */
export async function importFromProject<T>(
  specifier: string,
  fallback: () => Promise<T>,
  projectRoot: string = process.cwd()
): Promise<T> {
  const resolved = resolveFromProject(specifier, projectRoot);
  if (resolved) {
    // Node's ESM loader only takes URLs for absolute paths.
    const target = typeof globalThis.Bun !== "undefined" ? resolved : pathToFileURL(resolved).href;
    return (await import(target)) as T;
  }
  return fallback();
}
