/**
 * Unified Development Server
 *
 * Automatically detects runtime (Bun vs Node.js) and uses the appropriate implementation.
 *
 * Usage:
 *   import { dev, build } from "@hypen-space/cli/dev";
 *
 *   await dev({
 *     components: "./src/components",
 *     entry: "App",
 *   });
 */

import type { DiscoveredComponent } from "@hypen-space/server";

export interface DevOptions {
  /**
   * Path to components directory
   */
  components: string;

  /**
   * Entry component name (e.g., "App")
   */
  entry: string;

  /**
   * Development server port
   * Default: 3000
   */
  port?: number;

  /**
   * Enable hot module reloading
   * Default: true
   */
  hot?: boolean;

  /**
   * Enable debug logging
   * Default: false
   */
  debug?: boolean;

  /**
   * Custom HTML template path
   */
  htmlTemplate?: string;

  /**
   * Output directory for generated files
   * Default: ".hypen"
   */
  outDir?: string;

  /**
   * Callback when server starts
   */
  onStart?: (url: string) => void;

  /**
   * Callback when components change
   */
  onComponentsChange?: (components: DiscoveredComponent[]) => void;
}

export interface BuildOptions {
  /**
   * Path to components directory
   */
  components: string;

  /**
   * Entry component name
   */
  entry: string;

  /**
   * Output directory
   * Default: "dist"
   */
  outDir?: string;

  /**
   * Enable minification
   * Default: true
   */
  minify?: boolean;

  /**
   * Enable source maps
   * Default: false
   */
  sourcemap?: boolean;
}

/**
 * Detect if running in Bun
 */
function isBun(): boolean {
  return typeof globalThis.Bun !== "undefined";
}

/**
 * Get the appropriate implementation based on runtime
 */
async function getImplementation() {
  if (isBun()) {
    return import("./dev-bun.js");
  } else {
    return import("./dev-node.js");
  }
}

/**
 * Start a development server
 *
 * Automatically uses Bun.serve() in Bun or http.createServer() in Node.js
 */
export async function dev(options: DevOptions): Promise<{
  url: string;
  stop: () => void;
}> {
  const impl = await getImplementation();
  return impl.dev(options);
}

/**
 * Build for production
 *
 * Automatically uses Bun.build() in Bun or esbuild in Node.js
 */
export async function build(options: BuildOptions): Promise<void> {
  const impl = await getImplementation();
  return impl.build(options);
}

/**
 * Main hypen object for easy imports
 */
export const hypen = {
  dev,
  build,
};

export default hypen;
