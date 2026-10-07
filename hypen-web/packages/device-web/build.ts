/**
 * Build script for @hypen-space/device-web
 *
 * Compiles TypeScript to JavaScript + declarations for npm distribution.
 * Uses tsc (not Bun.build) to correctly handle barrel re-exports.
 */

import { $ } from "bun";

console.log("Building @hypen-space/device-web...");

await $`rm -rf dist`;

// tsconfig.build.json clears path mappings so @hypen-space/core resolves as
// an external package (not the local ../core/src/ alias used for IDE support).
console.log("Generating type declarations...");
await $`bunx tsc -p tsconfig.build.json`;

console.log("✓ @hypen-space/device-web built successfully");
