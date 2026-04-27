/**
 * Build script for @hypen-space/cli
 *
 * Compiles TypeScript to JavaScript for npm distribution.
 * Enables `hypen dev` to work directly with Node.js.
 */

import { $ } from "bun";

console.log("Building @hypen-space/cli...\n");

// Clean dist directory
await $`rm -rf dist`;

// Build all entry points
console.log("Compiling TypeScript...");

await Bun.build({
  entrypoints: [
    "./bin/hypen.ts",
    "./src/index.ts",
    "./src/dev.ts",
    "./src/dev-bun.ts",
    "./src/dev-node.ts",
  ],
  outdir: "./dist",
  target: "node",
  format: "esm",
  sourcemap: "external",
  external: [
    "@hypen-space/core",
    "@hypen-space/core/*",
    "@hypen-space/server",
    "@hypen-space/server/*",
    "@hypen-space/web",
    "@hypen-space/web/*",
    "@hypen-space/web-engine",
    "@hypen-space/web-engine/*",
    "esbuild",
  ],
});

console.log("✓ TypeScript compiled\n");

// Generate type declarations
console.log("Generating type declarations...");
await $`bunx tsc --declaration --emitDeclarationOnly --outDir dist`;
console.log("✓ Type declarations generated\n");

// Fix shebang in dist - Bun's bundler may write #!/usr/bin/env node
const hypenJs = await Bun.file("./dist/bin/hypen.js").text();
const fixedShebang = hypenJs.replace(/^#!\/usr\/bin\/env node/, "#!/usr/bin/env bun");
await Bun.write("./dist/bin/hypen.js", fixedShebang);

// ─── Pre-build the Studio UI bundle ──────────────────────────────────
//
// Tailwind v4's oxide scanner refuses to scan files inside `node_modules`.
// When this package is installed (where studio-ui *lives* in node_modules),
// running Bun.build + bun-plugin-tailwind at runtime produces 0 utilities
// — theme defaults emit, vendor CSS emits, but `.flex` / `.bg-card` /
// everything we use is silently dropped. The user sees an unstyled UI.
//
// The fix is to bundle studio-ui at *publish time*, when `studio-ui/` is
// inside the monorepo (not under node_modules), then ship the bundled
// output as a static asset. At runtime studio-ui just serves the prebuilt
// chunks — no Tailwind run, no scanning, no node_modules trap.
//
// `STUDIO_DEV=1` opts the runtime into a fresh Bun.build for HMR while
// iterating on studio-ui itself; that path *only* works when running from
// the monorepo, which is exactly the supported case.
console.log("Bundling Studio UI assets...");
{
  const { rmSync } = await import("fs");
  const { join } = await import("path");
  const tailwindPlugin = (await import("bun-plugin-tailwind")).default;

  const studioUiRoot = "./studio-ui";
  const studioDist = join(studioUiRoot, "dist");
  rmSync(studioDist, { recursive: true, force: true });

  const previousCwd = process.cwd();
  // Tailwind/oxide resolve `@source` and auto-discovery relative to CWD.
  // CD into studio-ui so `.` resolves to `studio-ui/` (where the .tsx files
  // live) rather than the package root.
  process.chdir(studioUiRoot);
  try {
    const result = await Bun.build({
      entrypoints: ["./src/index.html"],
      outdir: "./dist",
      plugins: [tailwindPlugin],
      target: "browser",
      // `naming` strips the publish-time hash so the runtime doesn't have to
      // discover the chunk name. We don't need cache-busting — the bundle
      // ships with the package version.
      minify: false,
    });

    if (!result.success) {
      console.error("Studio UI bundle failed:", result.logs);
      process.exit(1);
    }

    // Hard guard: a bundle without our sentinel utilities means oxide skipped
    // the source files. Catch it here so it never ships.
    const cssOutputs = result.outputs.filter((o) => o.path.endsWith(".css"));
    const cssText = (await Promise.all(cssOutputs.map((o) => o.text()))).join("\n");
    const hasUtilities =
      /\.bg-card\b/.test(cssText) &&
      /\.text-foreground\b/.test(cssText) &&
      /\.flex\s*\{/.test(cssText);
    if (!hasUtilities) {
      console.error(
        `Studio UI bundle produced ${cssText.length} bytes of CSS but no Tailwind utilities. ` +
          `Tailwind scanned zero source files — usually a wrong @source path or running ` +
          `from inside node_modules.`,
      );
      process.exit(1);
    }
    console.log(`✓ Studio UI bundled (${(cssText.length / 1024).toFixed(0)} KB CSS, ${cssOutputs.length} file(s))\n`);
  } finally {
    process.chdir(previousCwd);
  }
}

console.log("Build complete!");
console.log("  dist/bin/hypen.js");
console.log("  dist/src/*.js");
console.log("  dist/**/*.d.ts");
console.log("  studio-ui/dist/*.{html,js,css}\n");
