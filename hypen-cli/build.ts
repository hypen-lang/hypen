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

console.log("Build complete!");
console.log("  dist/bin/hypen.js");
console.log("  dist/src/*.js");
console.log("  dist/**/*.d.ts\n");
