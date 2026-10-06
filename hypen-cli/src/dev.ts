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

import { readFileSync } from "fs";
import { relative, resolve } from "path";
import type { DiscoveredComponent } from "@hypen-space/server";
import type { A11yDiagnostic } from "@hypen-space/core";
import {
  A11Y_BINDING_UNAVAILABLE,
  findHypenFiles,
  formatA11yReport,
  formatDriftWarning,
  partitionFindings,
  resolveRuleDrift,
  type FileA11yFinding,
} from "./check.js";

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
   * @deprecated Only honored by the Node fallback dev server (browser-SPA
   * flow). Under Bun the dev server streams patches to the built-in web
   * client and this logs a warning instead.
   */
  htmlTemplate?: string;

  /**
   * @deprecated Only honored by the Node fallback dev server (browser-SPA
   * flow). Under Bun the dev server generates no files and this logs a
   * warning instead (use `hypen generate` for codegen).
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

  /**
   * Opt-in accessibility findings on the dev loop: when set, the engine's
   * conformance pass runs over every discovered `.hypen` file on the initial
   * build and each rebuild, printing findings in `hypen check` format.
   * Findings never fail or block the server; a clean pass prints nothing.
   * Default: off.
   */
  a11y?: DevA11yOptions;
}

/** Configuration for the opt-in dev-loop accessibility pass. */
export interface DevA11yOptions {
  /** Rule ids suppressed project-wide (hypen.json `a11y.ignoreRules`). */
  ignoreRules?: string[];
}

/**
 * Gate for the dev-loop accessibility pass: the `--a11y` flag OR hypen.json's
 * `"a11y": { "dev": true }` enables it; everything else stays fully silent.
 */
export function isDevA11yEnabled(
  flag: boolean | undefined,
  config: { dev?: boolean } | undefined,
): boolean {
  return flag === true || config?.dev === true;
}

/**
 * Dev-loop variant of {@link formatA11yReport}: identical finding and
 * summary lines, but a clean pass returns no lines at all — the dev console
 * must not accumulate "No accessibility issues found." on every rebuild.
 * Suppressed-only passes are also silent; suppression counts surface via
 * `hypen check`, whose report is the accountable one.
 */
export function formatDevA11yLines(
  findings: FileA11yFinding[],
  suppressedCount = 0,
): string[] {
  if (findings.length === 0) return [];
  return formatA11yReport(findings, suppressedCount).lines;
}

/**
 * Build the rebuild-time accessibility checker for the dev servers.
 *
 * The returned function scans `componentsDir` for `.hypen` files, runs the
 * engine's conformance pass over each, and prints findings (with inline
 * `hypen-a11y-ignore` directives and `ignoreRules` suppressed, exactly like
 * `hypen check`). Guarantees the dev loop relies on:
 *
 * - It never rejects — a broken engine or unreadable file must not take the
 *   server down. Per-file read/parse failures stay quiet; the build itself
 *   already surfaces them.
 * - Runs are serialized, so overlapping rebuilds cannot interleave reports.
 * - The engine boots on the first call; a missing `checkAccessibility`
 *   binding (or drift) is reported once, then later calls are no-ops rather
 *   than a per-rebuild repeat of the note.
 */
export function createDevA11yChecker(opts: {
  componentsDir: string;
  projectRoot: string;
  ignoreRules?: string[];
}): () => Promise<void> {
  const componentsDir = resolve(opts.componentsDir);
  const projectRoot = resolve(opts.projectRoot);

  // undefined = not yet booted, null = binding unavailable (permanently off).
  let engine:
    | { checkAccessibility(source: string): A11yDiagnostic[] }
    | null
    | undefined;

  const ensureEngine = async () => {
    if (engine !== undefined) return engine;
    try {
      const { Engine } = await import("@hypen-space/server");
      const instance = new Engine();
      await instance.init();
      const wasmEngine = (instance as any)?.wasmEngine;
      if (typeof wasmEngine?.checkAccessibility !== "function") {
        console.warn(`  ${A11Y_BINDING_UNAVAILABLE}`);
        engine = null;
        return engine;
      }
      for (const line of formatDriftWarning(await resolveRuleDrift(wasmEngine))) {
        console.warn(`  ${line}`);
      }
      engine = instance as unknown as {
        checkAccessibility(source: string): A11yDiagnostic[];
      };
    } catch {
      console.warn(`  ${A11Y_BINDING_UNAVAILABLE}`);
      engine = null;
    }
    return engine;
  };

  const run = async () => {
    const eng = await ensureEngine();
    if (!eng) return;
    const findings: FileA11yFinding[] = [];
    let suppressedCount = 0;
    for (const file of findHypenFiles(componentsDir)) {
      let diags: A11yDiagnostic[];
      try {
        diags = eng.checkAccessibility(readFileSync(file, "utf-8"));
      } catch {
        continue;
      }
      const { active, suppressedCount: fileSuppressed } = partitionFindings(
        diags,
        opts.ignoreRules,
      );
      suppressedCount += fileSuppressed;
      const rel = relative(projectRoot, file);
      const display = !rel || rel.startsWith("..") ? file : rel;
      for (const d of active) {
        findings.push({ file: display, diagnostic: d });
      }
    }
    for (const line of formatDevA11yLines(findings, suppressedCount)) {
      console.log(`  ${line}`);
    }
  };

  let chain: Promise<void> = Promise.resolve();
  return () => (chain = chain.then(run).catch(() => {}));
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
