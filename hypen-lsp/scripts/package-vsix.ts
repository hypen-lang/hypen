#!/usr/bin/env bun
/**
 * Build the VS Code extension (.vsix).
 *
 *   bun run package:vsix                  # -> hypen-lsp-<version>.vsix
 *   bun run package:vsix --out path.vsix  # custom output path
 *
 * The extension runs inside VS Code with no node_modules, so this:
 *   1. bundles src/extension.ts and src/server.ts (with vscode-languageclient,
 *      vscode-languageserver, ...) into self-contained CommonJS files under
 *      out/ — `vscode` is provided by the editor and stays external;
 *   2. copies the parser WASM (wasm/) and engine WASM (wasm-engine/) in as
 *      real files. The server loads them with `import("../wasm/...")` relative
 *      to out/server.js, so the layout matches the dev checkout, where
 *      wasm/ and wasm-engine/ are symlinks into ../parser and
 *      ../hypen-engine-rs (see `bun run setup:wasm`);
 *   3. stages everything in dist/vsix/ with a VSIX-specific manifest and runs
 *      `vsce package` there.
 *
 * The WASM is not rebuilt here; build it first with `bun run build:wasm`
 * (or let CI build it). The staged manifest differs from package.json, which
 * stays the npm manifest of @hypen-space/lsp:
 *   - name `hypen-lsp` (vsce rejects scoped names; extension id hypen.hypen-lsp)
 *   - no `files` (vsce refuses `files` together with .vscodeignore)
 *   - never `type: module` (the bundles and wasm-bindgen glue are CommonJS)
 *   - no scripts / dependencies (everything is bundled; this also keeps vsce
 *     from re-running `vscode:prepublish` inside the stage)
 */

import { $ } from "bun";
import { cp, mkdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const stage = join(root, "dist", "vsix");

const pkg = await Bun.file(join(root, "package.json")).json();
const outArg = process.argv.indexOf("--out");
const vsixPath =
  outArg !== -1 && process.argv[outArg + 1]
    ? resolve(process.argv[outArg + 1])
    : join(root, `hypen-lsp-${pkg.version}.vsix`);

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// ── WASM inputs ────────────────────────────────────────────────────────
// wasm/ and wasm-engine/ may be symlinks (dev, CI) or real directories.
const wasmDirs = [
  { dir: "wasm", glue: "hypen_parser.js", wasm: "hypen_parser_bg.wasm" },
  { dir: "wasm-engine", glue: "hypen_engine.js", wasm: "hypen_engine_bg.wasm" },
];
for (const { dir, glue, wasm } of wasmDirs) {
  for (const file of [glue, wasm]) {
    if (!(await exists(join(root, dir, file)))) {
      console.error(
        `error: ${dir}/${file} is missing. Build the WASM first:\n` +
          `  bun run build:wasm && bun run setup:wasm`,
      );
      process.exit(1);
    }
  }
}

// ── Stage ──────────────────────────────────────────────────────────────
await rm(stage, { recursive: true, force: true });
await mkdir(join(stage, "out"), { recursive: true });

const result = await Bun.build({
  entrypoints: [join(root, "src/extension.ts"), join(root, "src/server.ts")],
  outdir: join(stage, "out"),
  target: "node",
  format: "cjs",
  // `vscode` comes from the editor; the WASM glue is loaded at runtime from
  // the copied wasm/ and wasm-engine/ directories next to out/.
  external: ["vscode", "../wasm/*", "../wasm-engine/*"],
  minify: { whitespace: true, syntax: true, identifiers: false },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

for (const { dir, glue, wasm } of wasmDirs) {
  await mkdir(join(stage, dir), { recursive: true });
  for (const file of [glue, wasm]) {
    // cp dereferences the symlinked directory; files are copied as files.
    await cp(join(root, dir, file), join(stage, dir, file));
  }
}

for (const entry of [
  "syntaxes",
  "icons",
  "language-configuration.json",
  "README.md",
  "CHANGELOG.md",
  ".vscodeignore",
]) {
  await cp(join(root, entry), join(stage, entry), { recursive: true });
}
await cp(join(root, "..", "LICENSE"), join(stage, "LICENSE"));

const manifest = { ...pkg, name: "hypen-lsp" };
for (const key of ["files", "type", "scripts", "dependencies", "devDependencies"]) {
  delete manifest[key];
}
await Bun.write(join(stage, "package.json"), JSON.stringify(manifest, null, 2) + "\n");

// ── Package ────────────────────────────────────────────────────────────
const vsce = join(root, "node_modules", ".bin", "vsce");
await $`${vsce} package --no-dependencies --out ${vsixPath}`.cwd(stage);
await $`${vsce} ls --no-dependencies`.cwd(stage);
console.log(`\nVSIX: ${vsixPath}`);
