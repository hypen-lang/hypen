/**
 * Build `dist/client/generic.js` — the browser client every
 * `defineHypenWorker({ serveClient })` worker serves — from the workspace
 * SOURCES of `@hypen-space/web`, `@hypen-space/core` and
 * `@hypen-space/device-web`.
 *
 * A plain `bun build --target browser` resolves those packages through their
 * `browser` / `import` export conditions, i.e. their `dist/` folders: the
 * last time each sibling package happened to be built, not the code in the
 * repo. Publishing cf never rebuilds them, so a stale `web/dist` silently
 * became the published client (e.g. one that ignores `clearChildren`
 * patches: old rows stay, taps fail with "stale UI action target").
 *
 * The plugin below keeps browser semantics (it picks the `browser`/`import`
 * entry of each export) but maps `./dist/<p>.js` to `./src/<p>.ts`, so the
 * bundle is always the renderer as it is in the repo.
 *
 *   bun run client/build-client.ts        # writes dist/client/generic.js
 */

import type { BunPlugin } from "bun";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PKG_ROOT = join(import.meta.dir, "..");
const PACKAGES_DIR = join(PKG_ROOT, "..");
/** Workspace packages bundled from source (dir name under packages/). */
const SOURCE_PACKAGES = new Set(["core", "web", "device-web"]);

type ExportEntry = string | Record<string, string | undefined>;

/** Resolve `@hypen-space/<pkg>[/sub]` to the workspace source file. */
export function resolveWorkspaceSource(specifier: string): string | null {
  const match = /^@hypen-space\/([a-z-]+)(\/.*)?$/.exec(specifier);
  if (!match || !SOURCE_PACKAGES.has(match[1]!)) return null;
  const pkgDir = join(PACKAGES_DIR, match[1]!);
  const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as {
    exports?: Record<string, ExportEntry>;
  };
  const entry = manifest.exports?.[`.${match[2] ?? ""}`];
  if (!entry) return null;
  const candidates =
    typeof entry === "string"
      ? [entry]
      : [entry.browser, entry.import, entry.default, entry.bun].filter(
          (p): p is string => typeof p === "string",
        );
  for (const target of candidates) {
    const source = target.startsWith("./dist/")
      ? target.replace(/^\.\/dist\//, "./src/").replace(/\.js$/, ".ts")
      : target;
    const file = join(pkgDir, source);
    if (existsSync(file)) return file;
  }
  return null;
}

export const workspaceSourcePlugin: BunPlugin = {
  name: "hypen-workspace-sources",
  setup(build) {
    build.onResolve({ filter: /^@hypen-space\// }, (args) => {
      const path = resolveWorkspaceSource(args.path);
      return path ? { path } : undefined;
    });
  },
};

/** Build the generic client; returns the bundle text. */
export async function buildClient(options: { minify?: boolean } = {}): Promise<string> {
  const result = await Bun.build({
    entrypoints: [join(PKG_ROOT, "client/generic-client.ts")],
    target: "browser",
    minify: options.minify ?? true,
    plugins: [workspaceSourcePlugin],
  });
  if (!result.success) {
    throw new AggregateError(result.logs, "generic client build failed");
  }
  return result.outputs[0]!.text();
}

if (import.meta.main) {
  const out = join(PKG_ROOT, "dist/client/generic.js");
  const text = await buildClient();
  await Bun.write(out, text); // creates dist/client/ as needed
  console.log(`✓ ${out} (${(text.length / 1024).toFixed(0)} KB)`);
}
