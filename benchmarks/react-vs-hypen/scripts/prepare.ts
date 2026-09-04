/**
 * Copies the browser WASM engine into the Hypen app's `public/` so it is
 * served same-origin alongside the bundle.
 *
 * Source of truth is `hypen-web/packages/web-engine/wasm-browser/`, which
 * `hypen-engine-rs/build-wasm.sh` writes. If you have just changed the engine,
 * rebuild that first — this script only copies.
 */

import { $ } from "bun";
import { cp, mkdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packages = resolve(here, "../../../hypen-web/packages");
const src = resolve(packages, "web-engine/wasm-browser");
const dest = resolve(here, "../apps/hypen/public/wasm");

// Build the `dist/` the Hypen app bundles against, so it measures the same
// artifact an npm consumer installs rather than raw TypeScript sources.
//
// Only `core` and `web` are built here. `web-engine`'s build script starts by
// deleting its `wasm-browser/` directory and repopulating it from a fresh
// wasm-pack output; running it without that toolchain would wipe the checked-in
// engine binary. Its sources are bundled directly instead (see vite.config.ts).
for (const pkg of ["core", "web"]) {
  console.log(`[prepare] building @hypen-space/${pkg}`);
  await $`bun run build.ts`.cwd(resolve(packages, pkg)).quiet();
}

try {
  await stat(src);
} catch {
  console.error(
    `[prepare] missing ${src}\n` +
      `          run ./build-wasm.sh in hypen-engine-rs/ first`,
  );
  process.exit(1);
}

await mkdir(dest, { recursive: true });
for (const file of ["hypen_engine.js", "hypen_engine_bg.wasm"]) {
  await cp(resolve(src, file), resolve(dest, file));
  const { size } = await stat(resolve(dest, file));
  console.log(`[prepare] ${file} (${(size / 1024).toFixed(1)} KiB)`);
}
