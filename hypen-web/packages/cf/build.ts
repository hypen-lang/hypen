import { $ } from "bun";

console.log("Building @hypen-space/cf...");

await $`rm -rf dist`;

// Build the browser client bundle
await $`bun run build:client`;

// Build the package root (src/index.ts). worker-entry.ts is shipped as
// TypeScript source — it contains wrangler-specific .wasm and text imports
// that only wrangler's bundler understands, and CF Workers consumers always
// run wrangler as their final bundler anyway.
await Bun.build({
  entrypoints: ["./src/index.ts"],
  root: "./src",
  outdir: "./dist",
  target: "browser",
  format: "esm",
  sourcemap: "external",
  external: [
    "@hypen-space/core",
    "@hypen-space/core/*",
    "@hypen-space/web",
    "@hypen-space/web/*",
    "hypen-engine",
  ],
});

// Generate type declarations
console.log("Generating type declarations...");
await $`bunx tsc -p tsconfig.build.json`;

console.log("✓ @hypen-space/cf built successfully");
