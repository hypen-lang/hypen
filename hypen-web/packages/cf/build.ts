import { $ } from "bun";

console.log("Building @hypen-space/cf...");

await $`rm -rf dist`;

// Build the browser client bundle, then assert it actually contains the
// renderer runtime. `build:client` bundles @hypen-space/web as a dependency,
// so a stale copy under packages/cf/node_modules silently shadows the
// workspace package and ships a client missing whatever the newer renderer
// added — no error, no warning. That is how @hypen-space/cf@0.6.0 shipped a
// client built against web@0.5.4, which predates the DOM animation runtime:
// every published web app rendered fine and animated nothing.
await $`bun run build:client`;
await $`bun run client/verify-bundle.ts`;

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
