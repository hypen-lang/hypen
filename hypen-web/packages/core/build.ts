/**
 * Build script for @hypen-space/core
 *
 * Compiles TypeScript to JavaScript for npm distribution.
 * Core is now WASM-free — engines live in @hypen-space/server and @hypen-space/web-engine.
 */

import { $ } from "bun";

console.log("Building @hypen-space/core...");

// Clean dist directory and old wasm artifacts
await $`rm -rf dist`;
await $`rm -rf wasm 2>/dev/null || true`;

// All entrypoints (platform-agnostic, no Node.js-specific APIs)
const entrypoints = [
  "./src/index.ts",
  "./src/index.browser.ts",
  "./src/app.ts",
  "./src/hypen.ts",
  "./src/state.ts",
  "./src/renderer.ts",
  "./src/router.ts",
  "./src/managed-router.ts",
  "./src/persistence.ts",
  "./src/events.ts",
  "./src/context.ts",
  "./src/datasource.ts",
  "./src/remote/index.ts",
  "./src/remote/client.ts",
  "./src/remote/types.ts",
  "./src/remote/session.ts",
  "./src/resolver.ts",
  "./src/components/builtin.ts",
  "./src/disposable.ts",
  "./src/logger.ts",
  "./src/types.ts",
  "./src/animation.ts",
  "./src/result.ts",
  "./src/retry.ts",
  "./src/engine-base.ts",
  "./src/portable.ts",
  "./src/patch-expand.ts",
];

// Build all entrypoints with browser target (platform-agnostic)
await Bun.build({
  entrypoints,
  root: "./src",
  outdir: "./dist",
  target: "browser",
  format: "esm",
  sourcemap: "external",
  // Emit shared chunks so cross-entrypoint singletons (e.g. the
  // `portable` impl slot, the global module registry) live in ONE
  // module instance at runtime. Without splitting, each entrypoint
  // gets its own inlined copy of `portable.ts` and `setPortableImpl`
  // only mutates the copy reachable from `@hypen-space/core/portable`
  // — router.js / state.js keep stale `notInstalled` placeholders.
  splitting: true,
});

// Generate type declarations using tsc
console.log("Generating type declarations...");
await $`bunx tsc -p tsconfig.build.json`;

console.log("✓ @hypen-space/core built successfully");
