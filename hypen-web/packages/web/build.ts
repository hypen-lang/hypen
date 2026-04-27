/**
 * Build script for @hypen/web
 *
 * Compiles TypeScript to JavaScript + declarations for npm distribution.
 * Uses tsc (not Bun.build) to correctly handle barrel re-exports.
 */

import { $ } from "bun";

console.log("Building @hypen/web...");

// Clean dist directory
await $`rm -rf dist`;

// Emit JS + declarations via tsc.
// tsconfig.build.json clears path mappings so @hypen-space/core resolves as
// an external package (not the local ../core/src/ alias used for IDE support).
console.log("Generating type declarations...");
await $`bunx tsc -p tsconfig.build.json`;

console.log("✓ @hypen/web built successfully");
