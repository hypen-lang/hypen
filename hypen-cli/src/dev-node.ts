/**
 * Node.js-compatible Development Server
 *
 * Uses http.createServer() and esbuild for Node.js environments.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { join, resolve, extname, normalize, relative, isAbsolute } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, watch } from "fs";
import {
  discoverComponents,
  generateComponentsCode,
  type DiscoveredComponent,
} from "@hypen-space/server";
import { pink, yellow, dim, boldPink, boldYellow } from "./colors.js";
import { createDevA11yChecker, type DevA11yOptions } from "./dev.js";

// Lazy load esbuild to avoid issues if not installed
let esbuild: typeof import("esbuild") | null = null;

async function getEsbuild() {
  if (!esbuild) {
    try {
      esbuild = await import("esbuild");
    } catch {
      throw new Error(
        "esbuild is required for Node.js support. Install it with: npm install esbuild"
      );
    }
  }
  return esbuild;
}

export interface DevOptions {
  components: string;
  entry: string;
  port?: number;
  hot?: boolean;
  debug?: boolean;
  htmlTemplate?: string;
  outDir?: string;
  onStart?: (url: string) => void;
  onComponentsChange?: (components: DiscoveredComponent[]) => void;
  /**
   * Opt-in accessibility findings on the dev loop (initial build + every
   * rebuild, `hypen check` format). Never fails the server. Default: off.
   */
  a11y?: DevA11yOptions;
}

export interface BuildOptions {
  components: string;
  entry: string;
  outDir?: string;
  minify?: boolean;
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
 * MIME types for common file extensions
 */
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".ts": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
};

/**
 * Transpile TypeScript to JavaScript using esbuild
 */
async function transpileTS(code: string, filename: string): Promise<string> {
  const es = await getEsbuild();
  const result = await es.transform(code, {
    loader: "ts",
    sourcefile: filename,
    format: "esm",
    target: "es2020",
  });
  return result.code;
}

/**
 * Start a development server (Node.js version)
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
    a11y,
  } = options;

  // Verify esbuild is available
  await getEsbuild();

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
    const code = await generateComponentsCode(resolvedComponentsDir, { debug });
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

  // Opt-in accessibility pass over the .hypen sources; runs after the
  // initial generation and after every rebuild. Never throws.
  const runA11y = a11y
    ? createDevA11yChecker({
        componentsDir: resolvedComponentsDir,
        projectRoot: resolve("."),
        ignoreRules: a11y.ignoreRules,
      })
    : null;

  // Initial generation
  const componentsPath = await generateComponents();
  generateMain(componentsPath);

  // Watch for changes
  let watcher: ReturnType<typeof watch> | null = null;

  if (hot && existsSync(resolvedComponentsDir)) {
    watcher = watch(
      resolvedComponentsDir,
      { recursive: true },
      async (eventType, filename) => {
        if (
          filename &&
          (filename.endsWith(".hypen") || filename.endsWith(".ts"))
        ) {
          log("File changed:", filename);
          await generateComponents();
          await runA11y?.();
          const components = await discoverComponents(resolvedComponentsDir);
          onComponentsChange?.(components);
        }
      }
    );
  }

  // Get HTML template
  const html = htmlTemplate
    ? readFileSync(htmlTemplate, "utf-8")
    : getDefaultHtmlTemplate(entry);

  // Create Node.js HTTP server
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", `http://localhost:${port}`);
    const pathname = url.pathname;

    log("Request:", pathname);

    try {
      // Serve HTML for root
      if (pathname === "/" || pathname === "/index.html") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(html);
        return;
      }

      // Serve generated files
      if (pathname.startsWith("/__hypen__/")) {
        const fileName = pathname.replace("/__hypen__/", "");
        const filePath = join(resolvedOutDir, fileName.replace(/\.js$/, ".ts"));

        // Prevent path traversal: ensure resolved path stays within output dir
        const resolvedFile = resolve(filePath);
        const rel = relative(resolvedOutDir, resolvedFile);
        if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
          try {
            const code = readFileSync(resolvedFile, "utf-8");
            const js = await transpileTS(code, resolvedFile);

            res.writeHead(200, { "Content-Type": "application/javascript" });
            res.end(js);
            return;
          } catch {
            // File doesn't exist — fall through
          }
        }
      }

      // Serve static files from components directory
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
            const code = readFileSync(filePath, "utf-8");
            const js = await transpileTS(code, filePath);

            res.writeHead(200, { "Content-Type": "application/javascript" });
            res.end(js);
            return;
          } catch {
            // File doesn't exist — try next path
          }
        }
      }

      // Serve other static files
      const ext = extname(pathname);
      if (ext && MIME_TYPES[ext]) {
        const filePath = join(process.cwd(), pathname.slice(1));
        if (existsSync(filePath)) {
          const content = readFileSync(filePath);
          res.writeHead(200, { "Content-Type": MIME_TYPES[ext] });
          res.end(content);
          return;
        }
      }

      // 404
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    } catch (error) {
      log("Error:", error);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(`Server Error: ${error}`);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.error(`\n  Error: Port ${port} is already in use.`);
        console.error(`  Try a different port: hypen dev --port ${port + 1}\n`);
        process.exit(1);
      }
      reject(err);
    });
    server.listen(port, () => resolve());
  });

  const serverUrl = `http://localhost:${port}`;

  console.log(`\n  ${boldPink("Hypen Dev Server")} ${dim("(Node.js)")}\n`);
  console.log(`  ${dim("Local:")}      ${yellow(serverUrl)}`);
  console.log(`  ${dim("Entry:")}      ${entry}`);
  console.log(`  ${dim("Components:")} ${resolvedComponentsDir}\n`);

  onStart?.(serverUrl);

  // Initial-build findings print under the banner; fire-and-forget so the
  // WASM engine boot never delays the server coming up.
  void runA11y?.();

  return {
    url: serverUrl,
    stop: () => {
      watcher?.close();
      server.close();
    },
  };
}

/**
 * Build for production (Node.js version)
 */
export async function build(options: BuildOptions): Promise<void> {
  const {
    components: componentsDir,
    entry,
    outDir = "dist",
    minify = true,
    sourcemap = false,
  } = options;

  const es = await getEsbuild();
  const resolvedComponentsDir = resolve(componentsDir);
  const resolvedOutDir = resolve(outDir);

  console.log(`\n  ${boldPink("Hypen Build")} ${dim("(Node.js)")}\n`);
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

  // Bundle with esbuild
  try {
    await es.build({
      entryPoints: [mainPath],
      bundle: true,
      outdir: resolvedOutDir,
      minify,
      sourcemap,
      format: "esm",
      target: "es2020",
      platform: "browser",
    });
  } catch (error) {
    console.error("Build failed:", error);
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
  console.log(`    ${yellow(join(resolvedOutDir, "main.js"))}`);
  console.log(`    ${yellow(join(resolvedOutDir, "index.html"))}`);
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
