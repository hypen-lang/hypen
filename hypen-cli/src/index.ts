/**
 * @hypen-space/cli
 *
 * CLI tools for creating and managing Hypen applications.
 * Works with both Bun and Node.js runtimes.
 */

// Unified API (auto-detects runtime)
export { dev, build, hypen } from "./dev.js";
export type { DevOptions, BuildOptions, BuildResult } from "./dev.js";
export { BuildError } from "./build.js";

// Direct access to runtime-specific implementations. Note: their `build`
// exports are the legacy browser-SPA build and are deprecated — use the
// top-level `build` above (what `hypen build` runs).
export * as bun from "./dev-bun.js";
export * as node from "./dev-node.js";
