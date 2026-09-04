/**
 * Zero-Config Development Server
 *
 * Simple API for starting a Hypen development server.
 *
 * Usage:
 *   import { dev } from "@hypen-space/cli/dev";
 *
 *   await dev({
 *     components: "./src/components",
 *     entry: "App",
 *   });
 */

import { join, resolve, normalize, relative, isAbsolute } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import {
  discoverComponents,
  watchComponents,
  generateComponentsCode,
  type DiscoveredComponent,
} from "@hypen-space/server";
import { pink, yellow, dim, boldPink, boldYellow } from "./colors.js";
import { createDevA11yChecker, type DevA11yOptions } from "./dev.js";

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
   * @deprecated No effect under Bun: the dev server streams patches to the
   * built-in web client instead of bundling a browser SPA, so there is no
   * HTML template to swap. Passing it logs a warning. (Still honored by the
   * Node fallback dev server.)
   */
  htmlTemplate?: string;

  /**
   * @deprecated No effect under Bun: the dev server no longer generates
   * `.hypen/` files (use `hypen generate` for that). Passing it logs a
   * warning. (Still honored by the Node fallback dev server.)
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
   * Opt-in accessibility findings on the dev loop (initial build + every
   * rebuild, `hypen check` format). Never fails the server. Default: off.
   */
  a11y?: DevA11yOptions;
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
 * Default HTML template for development
 */
function getDefaultHtmlTemplate(entry: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <!-- viewport-fit=cover lets the page extend under notches/rounded corners so
       env(safe-area-inset-*) reports real values for the SafeArea component. -->
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>Hypen App</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { height: 100%; }
    body { font-family: system-ui, -apple-system, sans-serif; }
    /* Fullscreen by default: the app fills the viewport, and the root
       component stretches to it (grows past it when content is taller). */
    #app { width: 100vw; min-height: 100vh; display: flex; flex-direction: column; }
    #app > * { flex: 1; }
  </style>
</head>
<body>
  <div id="app"></div>
  <script type="module" src="/__hypen__/main.js"></script>
</body>
</html>
`;
}

/**
 * Generate the main entry file (production `build()` only — the dev
 * server no longer bundles a browser SPA; it streams patches from a
 * RemoteServer instead).
 */
function generateMainEntry(
  entry: string,
  componentsPath: string,
  debug: boolean
): string {
  // Normalize to POSIX separators for valid ESM import specifiers
  const posixPath = componentsPath.replace(/\\+/g, "/");
  return `/**
 * Auto-generated Hypen entry point
 */
import { renderWithComponents } from "@hypen-space/web-engine";
import * as components from ${JSON.stringify(posixPath)};

const app = await renderWithComponents(
  components,
  ${JSON.stringify(entry)},
  "#app",
  { debug: ${debug} }
);

// Hot reload support
if (import.meta.hot) {
  import.meta.hot.accept();
}

export default app;
`;
}

/**
 * Error thrown by `dev()` for expected failure modes, so programmatic
 * callers can catch and handle them. The CLI catches it, prints the
 * message, and exits — `dev()` itself never kills the host process.
 */
export class DevServerError extends Error {
  constructor(
    message: string,
    readonly code: "ENTRY_NOT_FOUND" | "PORT_IN_USE"
  ) {
    super(message);
    this.name = "DevServerError";
  }
}

/**
 * Start a development server.
 *
 * Runs the project through a `RemoteServer`: components are discovered from
 * the filesystem, the engine renders server-side, and the browser gets the
 * default web client (served at `/`) which receives streamed patches over
 * WebSocket — the same architecture `hypen test`, `hypen run`, and Studio
 * previews use, so every surface behaves identically. Native clients can
 * dial the same port (`ws://localhost:<port>`) directly.
 *
 * Every connection gets its own session (engine + module instance), but
 * `.syncActions()` replays each dispatched action onto every other
 * session's engine — so two browser tabs (or a tab + a native runner on
 * the same port) mirror each other. That differs from the old browser-SPA
 * dev server, where tabs were fully independent. Deliberate for now:
 * remove the `.syncActions()` call below to get per-tab isolation.
 *
 * File changes hot-reload by briefly disconnecting every client: each one
 * auto-reconnects (~0.5s), resumes its session against the freshly loaded
 * templates and module code, and gets its saved primary-module state back.
 * Nested (route) module state resets on reload.
 *
 * @throws {DevServerError} when the entry component can't be found or the
 * port is taken.
 */
export async function dev(options: DevOptions): Promise<{
  url: string;
  stop: () => void;
}> {
  const {
    components: componentsDir,
    entry,
    port = 3000,
    hot = true,
    debug = false,
    onStart,
    onComponentsChange,
    a11y,
  } = options;

  const log = debug
    ? (...args: unknown[]) => console.log("[hypen:dev]", ...args)
    : () => {};

  if (options.htmlTemplate !== undefined) {
    console.warn(
      "  Warning: `htmlTemplate` has no effect under Bun — the dev server serves the built-in web client."
    );
  }
  if (options.outDir !== undefined) {
    console.warn(
      "  Warning: `outDir` has no effect under Bun — the dev server no longer generates files (use `hypen generate`)."
    );
  }

  const resolvedComponentsDir = resolve(componentsDir);
  log("Components directory:", resolvedComponentsDir);

  const { RemoteServer } = await import("@hypen-space/server/remote");
  const { discoverComponents, loadDiscoveredComponents } = await import(
    "@hypen-space/server"
  );
  const { configureLogger } = await import("@hypen-space/core");

  const discovered = await discoverComponents(resolvedComponentsDir);
  const loaded = await loadDiscoveredComponents(discovered);
  const entryComponent = loaded.get(entry);

  if (!entryComponent) {
    throw new DevServerError(
      `Entry component "${entry}" not found in ${resolvedComponentsDir}\n` +
        `  Available components: ${Array.from(loaded.keys()).join(", ") || "(none)"}`,
      "ENTRY_NOT_FOUND"
    );
  }

  // Keep framework logs quiet unless --debug — the banner below is the UX.
  configureLogger({ level: debug ? "debug" : "error" });

  const remoteServer = new RemoteServer()
    .module(entry, entryComponent.module)
    .source(resolvedComponentsDir)
    // Mirror actions across all connected clients (tabs + native runners
    // preview the same scene, like `hypen test`). See the doc comment
    // above for the per-tab-isolation alternative.
    .syncActions();

  try {
    await remoteServer.listen(port);
  } catch (err: any) {
    if (err?.code === "EADDRINUSE" || err?.message?.includes("address already in use")) {
      throw new DevServerError(
        `Port ${port} is already in use.\n` +
          `  Try a different port: hypen dev --port ${port + 1}`,
        "PORT_IN_USE"
      );
    }
    throw err;
  }

  // Opt-in accessibility pass over the .hypen sources; runs after the
  // initial build and after every rebuild. Never throws.
  const runA11y = a11y
    ? createDevA11yChecker({
        componentsDir: resolvedComponentsDir,
        projectRoot: resolve("."),
        ignoreRules: a11y.ignoreRules,
      })
    : null;

  // Watch for changes and hot-reload all connected clients.
  let watcher: { stop: () => void } | null = null;
  if (hot) {
    let isInitialScan = true;
    watcher = watchComponents(resolvedComponentsDir, {
      debug,
      onChange: async (components) => {
        if (isInitialScan) {
          isInitialScan = false;
          return;
        }
        log("Components changed, reloading clients...");
        try {
          const clients = remoteServer.getClientCount();
          await remoteServer.reload();
          console.log(
            `  ${yellow("Reloaded")} ${dim(`(${clients} client(s) reconnecting)`)}`
          );
        } catch (e: any) {
          console.error(`  Hot reload failed: ${e?.message ?? e}`);
        }
        await runA11y?.();
        onComponentsChange?.(components);
      },
    });
  }

  const serverUrl = `http://localhost:${port}`;

  console.log(`\n  ${boldPink("Hypen Dev Server")}\n`);
  console.log(`  ${dim("Local:")}      ${yellow(serverUrl)}`);
  console.log(`  ${dim("Remote:")}     ${yellow(`ws://localhost:${port}`)}`);
  console.log(`  ${dim("Entry:")}      ${entry}`);
  console.log(`  ${dim("Components:")} ${resolvedComponentsDir}\n`);

  onStart?.(serverUrl);

  // Initial-build findings print under the banner; fire-and-forget so the
  // WASM engine boot never delays the server coming up.
  void runA11y?.();

  return {
    url: serverUrl,
    stop: () => {
      watcher?.stop();
      remoteServer.stop();
    },
  };
}

/**
 * Build for production
 */
export async function build(options: BuildOptions): Promise<void> {
  const {
    components: componentsDir,
    entry,
    outDir = "dist",
    minify = true,
    sourcemap = false,
  } = options;

  const resolvedComponentsDir = resolve(componentsDir);
  const resolvedOutDir = resolve(outDir);

  console.log(`\n  ${boldPink("Hypen Build")}\n`);
  console.log(`  ${dim("Entry:")}      ${entry}`);
  console.log(`  ${dim("Components:")} ${resolvedComponentsDir}`);
  console.log(`  ${dim("Output:")}     ${resolvedOutDir}\n`);

  // Ensure output directory exists
  if (!existsSync(resolvedOutDir)) {
    mkdirSync(resolvedOutDir, { recursive: true });
  }

  // Generate components
  const tempDir = join(resolvedOutDir, ".temp");
  const code = await generateComponentsCode(resolvedComponentsDir, { outputDir: tempDir });

  if (!existsSync(tempDir)) {
    mkdirSync(tempDir, { recursive: true });
  }

  const componentsPath = join(tempDir, "components.generated.ts");
  writeFileSync(componentsPath, code);

  // Generate main entry
  const mainCode = generateMainEntry(entry, componentsPath, false);
  const mainPath = join(tempDir, "main.ts");
  writeFileSync(mainPath, mainCode);

  // Bundle with Bun
  const result = await Bun.build({
    entrypoints: [mainPath],
    outdir: resolvedOutDir,
    minify,
    sourcemap: sourcemap ? "external" : "none",
    target: "browser",
    format: "esm",
  });

  if (!result.success) {
    console.error("Build failed:");
    for (const log of result.logs) {
      console.error(log);
    }
    process.exit(1);
  }

  // Generate HTML
  const html = getDefaultHtmlTemplate(entry).replace(
    "/__hypen__/main.js",
    "./main.js"
  );
  writeFileSync(join(resolvedOutDir, "index.html"), html);

  console.log(`  ${pink("Build complete!")}\n`);
  console.log(`  ${dim("Files:")}`);
  for (const output of result.outputs) {
    console.log(`    ${yellow(output.path)}`);
  }
  console.log();
}

/**
 * Main hypen object for easy imports
 */
export const hypen = {
  dev,
  build,
};

export default hypen;
