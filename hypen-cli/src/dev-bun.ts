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
 * Default HTML template for development
 */
function getDefaultHtmlTemplate(entry: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Hypen App</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; }
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
 * Generate the main entry file
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
 * Start a development server
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
    htmlTemplate,
    outDir = ".hypen",
    onStart,
    onComponentsChange,
  } = options;

  const log = debug
    ? (...args: unknown[]) => console.log("[hypen:dev]", ...args)
    : () => {};

  const resolvedComponentsDir = resolve(componentsDir);
  const resolvedOutDir = resolve(outDir);

  // Ensure output directory exists
  if (!existsSync(resolvedOutDir)) {
    mkdirSync(resolvedOutDir, { recursive: true });
  }

  log("Components directory:", resolvedComponentsDir);
  log("Output directory:", resolvedOutDir);

  // Generate initial components
  const generateComponents = async () => {
    log("Generating components...");
    const code = await generateComponentsCode(resolvedComponentsDir, { outputDir: resolvedOutDir, debug });
    const componentsPath = join(resolvedOutDir, "components.generated.ts");
    writeFileSync(componentsPath, code);
    log("Generated:", componentsPath);
    return componentsPath;
  };

  // Generate main entry
  const generateMain = (componentsPath: string) => {
    log("Generating main entry...");
    const code = generateMainEntry(entry, componentsPath, debug);
    const mainPath = join(resolvedOutDir, "main.ts");
    writeFileSync(mainPath, code);
    log("Generated:", mainPath);
    return mainPath;
  };

  // Initial generation
  const componentsPath = await generateComponents();
  const mainPath = generateMain(componentsPath);

  // Bundle the entry point so bare specifiers like @hypen-space/web-engine
  // are resolved into a single browser-ready JS file.
  const bundleOutDir = join(resolvedOutDir, "bundle");
  let bundledMainPath = "";

  const buildBundle = async () => {
    log("Bundling entry point...");
    try {
      const result = await Bun.build({
        entrypoints: [mainPath],
        outdir: bundleOutDir,
        target: "browser",
        format: "esm",
        sourcemap: "inline",
      });
      if (!result.success) {
        console.error("Bundle failed:");
        for (const msg of result.logs) console.error(msg);
        bundledMainPath = ""; // Clear stale path on failure
      } else {
        bundledMainPath = result.outputs[0]?.path ?? "";
        log("Bundled:", bundledMainPath);
      }
    } catch (err) {
      console.error("Bundle error:", err);
      bundledMainPath = ""; // Clear stale path on exception
    }
  };

  await buildBundle();

  // Watch for changes
  let watcher: { stop: () => void } | null = null;

  if (hot) {
    watcher = watchComponents(resolvedComponentsDir, {
      debug,
      onChange: async (components) => {
        log("Components changed, regenerating...");
        await generateComponents();
        generateMain(componentsPath);
        await buildBundle();
        onComponentsChange?.(components);
      },
    });
  }

  // Get HTML template
  const html = htmlTemplate
    ? readFileSync(htmlTemplate, "utf-8")
    : getDefaultHtmlTemplate(entry);

  // Create Bun server
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const pathname = url.pathname;

      log("Request:", pathname);

      // Serve HTML for root
      if (pathname === "/" || pathname === "/index.html") {
        return new Response(html, {
          headers: { "Content-Type": "text/html" },
        });
      }

      // Serve bundled main.js
      if (pathname === "/__hypen__/main.js") {
        if (bundledMainPath) {
          try {
            const js = readFileSync(bundledMainPath, "utf-8");
            return new Response(js, {
              headers: { "Content-Type": "application/javascript" },
            });
          } catch {
            // File doesn't exist or read error — fall through to 404
          }
        }
      }

      // Serve other generated files
      if (pathname.startsWith("/__hypen__/")) {
        const fileName = pathname.replace("/__hypen__/", "");
        const filePath = join(resolvedOutDir, fileName.replace(/\.js$/, ".ts"));

        // Prevent path traversal: ensure resolved path stays within output dir
        const resolvedFile = resolve(filePath);
        const rel = relative(resolvedOutDir, resolvedFile);
        if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
          try {
            const transpiler = new Bun.Transpiler({ loader: "ts" });
            const code = readFileSync(resolvedFile, "utf-8");
            const js = transpiler.transformSync(code);

            return new Response(js, {
              headers: { "Content-Type": "application/javascript" },
            });
          } catch {
            // File doesn't exist — fall through to 404
          }
        }
      }

      // Serve static files from project
      if (pathname.endsWith(".ts") || pathname.endsWith(".js")) {
        // Normalize pathname to prevent path traversal (e.g., /../../../etc/passwd)
        const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, "");

        const possiblePaths = [
          resolve(resolvedComponentsDir, safePath.replace(/^[/\\]/, "")),
          resolve(process.cwd(), safePath.replace(/^[/\\]/, "")),
        ];

        for (const filePath of possiblePaths) {
          // Ensure the resolved path stays within the allowed directories
          const relToComponents = relative(resolvedComponentsDir, filePath);
          const relToCwd = relative(resolve(process.cwd()), filePath);
          const inComponents = relToComponents && !relToComponents.startsWith('..') && !isAbsolute(relToComponents);
          const inCwd = relToCwd && !relToCwd.startsWith('..') && !isAbsolute(relToCwd);
          if (!inComponents && !inCwd) {
            continue;
          }
          try {
            const transpiler = new Bun.Transpiler({ loader: "ts" });
            const code = readFileSync(filePath, "utf-8");
            const js = transpiler.transformSync(code);

            return new Response(js, {
              headers: { "Content-Type": "application/javascript" },
            });
          } catch {
            // File doesn't exist — try next path
          }
        }
      }

      // 404
      return new Response("Not Found", { status: 404 });
    },
  });
  } catch (err: any) {
    if (err?.code === "EADDRINUSE" || err?.message?.includes("address already in use")) {
      console.error(`\n  Error: Port ${port} is already in use.`);
      console.error(`  Try a different port: hypen dev --port ${port + 1}\n`);
      process.exit(1);
    }
    throw err;
  }

  const serverUrl = `http://localhost:${port}`;

  console.log(`\n  ${boldPink("Hypen Dev Server")}\n`);
  console.log(`  ${dim("Local:")}      ${yellow(serverUrl)}`);
  console.log(`  ${dim("Entry:")}      ${entry}`);
  console.log(`  ${dim("Components:")} ${resolvedComponentsDir}\n`);

  onStart?.(serverUrl);

  return {
    url: serverUrl,
    stop: () => {
      watcher?.stop();
      server.stop();
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
