/**
 * @hypen-space/cli
 *
 * CLI tools for creating and managing Hypen applications.
 * Works with both Bun and Node.js runtimes.
 */

// Unified API (auto-detects runtime)
export { dev, build, hypen } from "./dev.js";
export type { DevOptions, BuildOptions } from "./dev.js";

// Direct access to runtime-specific implementations
export * as bun from "./dev-bun.js";
export * as node from "./dev-node.js";
