/**
 * Node.js Development Server
 *
 * Same architecture as the Bun dev server (`dev-bun.ts`): the project runs
 * through a `RemoteServer` — components are discovered from the filesystem,
 * the engine renders server-side, and the browser loads the built-in web
 * client at `/`, which receives streamed patches over WebSocket. Native
 * clients can dial the same `ws://` port.
 *
 * Only the transport differs. `RemoteServer.listen()` is `Bun.serve()`, so
 * here the server is `RemoteServer.prepare()` + `createSession()` behind a
 * `node:http` server and the small RFC 6455 implementation in `node-ws.ts`.
 *
 * Requirements under Node:
 *   - TypeScript type stripping (Node >= 22.18 / 23.6, or 22.6+ with
 *     `--experimental-strip-types`) so the project's `component.ts` modules
 *     can be imported directly — checked up front with a clear error.
 *   - The web client bundle shipped in `@hypen-space/server`
 *     (`dist/web-client.bundle.js`); a source checkout falls back to
 *     bundling `web-client-entry.ts` with esbuild.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { dirname, join, resolve } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import type { DiscoveredComponent } from "@hypen-space/server";
import { pink, yellow, dim, boldPink } from "./colors.js";
import { createDevA11yChecker, type DevA11yOptions } from "./dev.js";
import { findPackageRoot, importFromProject, resolveFromProject } from "./dev-resolve.js";
import { DevServerError } from "./dev-errors.js";
import { createHypenSourceValidator, formatReloadError } from "./dev-diagnostics.js";
import { acceptUpgrade, type NodeWebSocket } from "./node-ws.js";

export { DevServerError };

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
  /**
   * @deprecated No effect: the dev server serves the built-in web client
   * (streamed patches), not a bundled browser SPA. Passing it logs a warning.
   */
  htmlTemplate?: string;
  /**
   * @deprecated No effect: the dev server generates no files (use
   * `hypen generate`). Passing it logs a warning.
   */
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

// ---------------------------------------------------------------------------
// Runtime checks
// ---------------------------------------------------------------------------

/**
 * Can this Node import `.ts` files directly? `process.features.typescript`
 * is `"strip"`/`"transform"` when type stripping is on (Node >= 22.18 /
 * 23.6 by default, 22.6+ with `--experimental-strip-types`), `false` or
 * absent otherwise.
 */
export function nodeCanImportTypeScript(
  features: { typescript?: unknown } | undefined = (process as any).features
): boolean {
  const ts = features?.typescript;
  return ts === "strip" || ts === "transform" || ts === true;
}

/** Message for a Node that can't load the project's `.ts` modules. */
export function typeScriptUnsupportedMessage(
  nodeVersion: string = process.versions.node
): string {
  return (
    `This project's component modules are TypeScript, but Node ${nodeVersion} has type stripping off.\n` +
    `  Run the dev server with Bun (recommended):  bunx hypen dev\n` +
    `  or use Node >= 22.18 (type stripping on by default), or Node 22.6+ with\n` +
    `  NODE_OPTIONS=--experimental-strip-types.`
  );
}

// ---------------------------------------------------------------------------
// Web client
// ---------------------------------------------------------------------------

/** HTML shell that mounts the app and loads the bundled web client. */
export function renderClientHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>Hypen App</title>
  <link rel="icon" href="data:,">
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
  <script type="module" src="/__hypen__/client.js"></script>
</body>
</html>
`;
}

function renderFallbackHtml(wsUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Hypen Dev Server</title>
  <link rel="icon" href="data:,">
  <style>
    body { font-family: system-ui, sans-serif; margin: 4rem auto; max-width: 40rem; padding: 0 1rem; color: #1f2937; }
    code { background: #f3f4f6; padding: 2px 6px; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>Hypen Dev Server</h1>
  <p>The app is streaming on <code>${wsUrl}</code>, but the built-in web
  client could not be loaded (it ships with <code>@hypen-space/server</code>
  and needs <code>@hypen-space/web</code> installed).</p>
  <p>Connect with Hypen Studio (<code>hypen test</code>) or run
  <code>bunx hypen dev</code> instead.</p>
</body>
</html>
`;
}

/**
 * Load the browser client: the bundle `@hypen-space/server` ships in
 * `dist/web-client.bundle.js`, else (source checkouts) an esbuild bundle of
 * its `src/remote/web-client-entry.ts`. Null when neither works.
 */
export async function loadWebClientBundle(projectRoot: string): Promise<string | null> {
  const entry = resolveFromProject("@hypen-space/server", projectRoot);
  const pkgRoot = entry ? findPackageRoot(dirname(entry), "@hypen-space/server") : null;
  if (!pkgRoot) return null;

  const prebuilt = join(pkgRoot, "dist", "web-client.bundle.js");
  if (existsSync(prebuilt)) {
    try {
      return readFileSync(prebuilt, "utf-8");
    } catch {
      /* fall through to bundling */
    }
  }

  const source = join(pkgRoot, "src", "remote", "web-client-entry.ts");
  if (!existsSync(source)) return null;
  try {
    const es = await getEsbuild();
    const result = await es.build({
      entryPoints: [source],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      target: "es2020",
      minify: true,
      // The @hypen-space/* `bun` condition points at their TS sources,
      // which exist in a checkout even when dist/ hasn't been built.
      conditions: ["bun"],
      logLevel: "silent",
    });
    return result.outputFiles?.[0]?.text ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// HTTP routing
// ---------------------------------------------------------------------------

function acceptsHtml(req: IncomingMessage): boolean {
  const accept = req.headers.accept;
  return typeof accept === "string" && /(^|[,\s])text\/html(\s*[;,]|\s*$)/i.test(accept);
}

/**
 * Is this a browser navigation the HTML shell should answer (SPA
 * fallback, so deep links and reloads on `/counter` work)? Mirrors
 * RemoteServer: GET/HEAD accepting HTML, outside `/__hypen__/`, last
 * segment not naming a file.
 */
export function isAppNavigation(method: string, pathname: string, wantsHtml: boolean): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  if (!wantsHtml) return false;
  if (pathname.startsWith("/__hypen__/")) return false;
  const last = pathname.slice(pathname.lastIndexOf("/") + 1);
  return !/\.[a-z0-9]+$/i.test(last);
}

function send(res: ServerResponse, status: number, body: string, type = "text/plain"): void {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-cache" });
  res.end(body);
}

// ---------------------------------------------------------------------------
// dev()
// ---------------------------------------------------------------------------

/**
 * Start a development server under Node. Same behavior and options as the
 * Bun dev server: one session per connection, `.syncActions()` mirroring
 * across tabs/runners, hot reload by briefly disconnecting clients (they
 * reconnect and resume against the fresh templates and module code).
 *
 * @throws {DevServerError} when the entry component can't be found, the
 * port is taken, or this Node can't import the project's `.ts` modules.
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
      "  Warning: `htmlTemplate` has no effect — the dev server serves the built-in web client."
    );
  }
  if (options.outDir !== undefined) {
    console.warn(
      "  Warning: `outDir` has no effect — the dev server no longer generates files (use `hypen generate`)."
    );
  }

  const projectRoot = process.cwd();
  const resolvedComponentsDir = resolve(componentsDir);
  log("Components directory:", resolvedComponentsDir);

  // Runtime packages come from the project when it has them, so the
  // RemoteServer, the loader, and the project's component.ts files share
  // ONE @hypen-space/core (see dev-resolve.ts). RemoteServer is taken from
  // the package root export: it is the same class as `/remote`, and the
  // root entry is the one whose relative WASM import resolves in dist.
  const serverPkg = await importFromProject(
    "@hypen-space/server",
    () => import("@hypen-space/server"),
    projectRoot
  );
  const { RemoteServer, discoverComponents, loadDiscoveredComponents, watchComponents } =
    serverPkg as any;
  const { configureLogger } = await importFromProject(
    "@hypen-space/core",
    () => import("@hypen-space/core"),
    projectRoot
  );

  if (!existsSync(resolvedComponentsDir)) {
    throw new DevServerError(
      `Components directory not found: ${resolvedComponentsDir}\n` +
        `  Set "components" in hypen.json to the folder that holds your components.`,
      "ENTRY_NOT_FOUND"
    );
  }

  const discovered: DiscoveredComponent[] = await discoverComponents(resolvedComponentsDir);
  if (
    typeof globalThis.Bun === "undefined" &&
    discovered.some((c) => c.modulePath && /\.(c|m)?ts$/.test(c.modulePath)) &&
    !nodeCanImportTypeScript()
  ) {
    throw new DevServerError(typeScriptUnsupportedMessage(), "UNSUPPORTED_RUNTIME");
  }

  const loaded = await loadDiscoveredComponents(discovered);
  const entryComponent = loaded.get(entry);
  if (!entryComponent) {
    throw new DevServerError(
      `Entry component "${entry}" not found in ${resolvedComponentsDir}\n` +
        `  Available components: ${Array.from(loaded.keys()).join(", ") || "(none)"}`,
      "ENTRY_NOT_FOUND"
    );
  }

  configureLogger({ level: debug ? "debug" : "error" });

  const remoteServer = new RemoteServer()
    .module(entry, entryComponent.module)
    .source(resolvedComponentsDir)
    // Mirror actions across all connected clients, like the Bun server.
    .syncActions();
  await remoteServer.prepare();
  if (!debug) configureLogger({ level: "warn" });

  // Parse every .hypen source before a reload (see dev-bun.ts).
  const validateSources = createHypenSourceValidator({
    componentsDir: resolvedComponentsDir,
    projectRoot: resolve("."),
    loadServer: async () => serverPkg,
  });
  let sourcesBroken = false;

  let clientBundle: Promise<string | null> | null = null;
  const getClientBundle = () => {
    if (!clientBundle) {
      clientBundle = loadWebClientBundle(projectRoot).then((b) => {
        if (b === null) clientBundle = null; // retry on the next request
        return b;
      });
    }
    return clientBundle;
  };

  const sockets = new Set<NodeWebSocket>();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;
    const wantsHtml = acceptsHtml(req);
    try {
      if (pathname === "/__hypen__/health") {
        return send(res, 200, JSON.stringify({ status: "ok", server: "hypen-remote" }), "application/json");
      }
      // Legacy probes (curl, older CLIs) — a browser navigating there gets
      // the app instead, so app routes with these names still deep-link.
      if (pathname === "/health" && !wantsHtml) return send(res, 200, "OK");
      if (pathname === "/__hypen__/stats" || (pathname === "/stats" && !wantsHtml)) {
        return send(res, 200, JSON.stringify(remoteServer.getSessionStats()), "application/json");
      }
      if (pathname === "/__hypen__/client.js") {
        const bundle = await getClientBundle();
        if (bundle) return send(res, 200, bundle, "application/javascript");
        return send(res, 503, "Web client bundle unavailable");
      }
      if (pathname === "/" || pathname === "/index.html" || isAppNavigation(req.method ?? "GET", pathname, wantsHtml)) {
        const bundle = await getClientBundle();
        const host = req.headers.host ?? `localhost:${port}`;
        return send(res, 200, bundle ? renderClientHtml() : renderFallbackHtml(`ws://${host}`), "text/html");
      }
      return send(res, 404, "Not found");
    } catch (e: any) {
      return send(res, 500, `Dev server error: ${e?.message ?? e}`);
    }
  });

  server.on("upgrade", (req, socket, head) => {
    const ws = acceptUpgrade(req, socket, head);
    if (!ws) return;
    sockets.add(ws);
    const session = remoteServer.createSession(
      {
        send: (msg: unknown) => ws.send(JSON.stringify(msg)),
        close: (code?: number, reason?: string) => ws.close(code, reason),
      },
      { socketHandle: ws }
    );
    ws.listen({
      onMessage: (data) => {
        session.receive(typeof data === "string" ? data : data.toString("utf-8")).catch((err: any) =>
          log("session.receive failed:", err?.message ?? err)
        );
      },
      onClose: () => {
        sockets.delete(ws);
        session.destroy().catch(() => {
          /* already destroyed */
        });
      },
    });
  });

  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (err: any) => rejectListen(err);
      server.once("error", onError);
      server.listen(port, () => {
        server.off("error", onError);
        resolveListen();
      });
    });
  } catch (err: any) {
    if (err?.code === "EADDRINUSE") {
      throw new DevServerError(
        `Port ${port} is already in use.\n` +
          `  Try a different port: hypen dev --port ${port + 1}`,
        "PORT_IN_USE"
      );
    }
    throw err;
  }

  const runA11y = a11y
    ? createDevA11yChecker({
        componentsDir: resolvedComponentsDir,
        projectRoot: resolve("."),
        ignoreRules: a11y.ignoreRules,
      })
    : null;

  let watcher: { stop: () => void } | null = null;
  if (hot) {
    let isInitialScan = true;
    watcher = watchComponents(resolvedComponentsDir, {
      debug,
      onChange: async (components: DiscoveredComponent[]) => {
        if (isInitialScan) {
          isInitialScan = false;
          return;
        }
        log("Components changed, reloading clients...");
        const problems = await validateSources();
        if (problems.length > 0) {
          sourcesBroken = true;
          console.error(`\n  ${yellow("Not reloaded:")} fix the error below; open pages keep the last good version.`);
          for (const line of problems) console.error(`  ${line}`);
          console.error("");
          return;
        }
        if (sourcesBroken) {
          sourcesBroken = false;
          console.log(`  ${dim("Template error fixed.")}`);
        }
        try {
          const clients = remoteServer.getClientCount();
          await remoteServer.reload();
          console.log(
            `  ${yellow("Reloaded")} ${dim(`(${clients} client(s) reconnecting)`)}`
          );
        } catch (e: any) {
          const [first, ...rest] = formatReloadError(e);
          console.error(`  Hot reload failed: ${first}`);
          for (const line of rest) console.error(`  ${line}`);
          console.error(`  ${dim("Open pages keep the last good version.")}`);
        }
        await runA11y?.();
        onComponentsChange?.(components);
      },
    });
  }

  const serverUrl = `http://localhost:${port}`;

  console.log(`\n  ${boldPink("Hypen Dev Server")} ${dim("(Node.js)")}\n`);
  console.log(`  ${dim("Local:")}      ${yellow(serverUrl)}`);
  console.log(`  ${dim("Remote:")}     ${yellow(`ws://localhost:${port}`)}`);
  console.log(`  ${dim("Entry:")}      ${entry}`);
  console.log(`  ${dim("Components:")} ${resolvedComponentsDir}\n`);

  onStart?.(serverUrl);
  void runA11y?.();
  void validateSources().then((problems) => {
    if (problems.length === 0) return;
    sourcesBroken = true;
    console.error(`  ${yellow("Template error:")} the app won't render until this is fixed.`);
    for (const line of problems) console.error(`  ${line}`);
    console.error("");
  });

  return {
    url: serverUrl,
    stop: () => {
      watcher?.stop();
      for (const ws of sockets) ws.close(1001, "Server stopping");
      sockets.clear();
      server.close();
      (server as any).closeAllConnections?.();
    },
  };
}

// ---------------------------------------------------------------------------
// Legacy build (deprecated)
// ---------------------------------------------------------------------------

function getLegacyHtml(): string {
  return renderClientHtml().replace("/__hypen__/client.js", "./main.js");
}

function generateLegacyMainEntry(entry: string, componentsPath: string): string {
  const posixPath = componentsPath.replace(/\\+/g, "/");
  return `/**
 * Auto-generated Hypen entry point
 */
import { renderWithComponents } from "@hypen-space/web-engine";
import * as components from ${JSON.stringify(posixPath)};

const app = await renderWithComponents(components, ${JSON.stringify(entry)}, "#app", { debug: false });

export default app;
`;
}

/**
 * Build for production (Node.js version) — legacy browser-SPA build.
 *
 * @deprecated `hypen build` no longer uses this. Use `build` from
 * `@hypen-space/cli` (the static site `hypen build` emits; see
 * `src/build.ts`). Kept only for existing programmatic callers.
 */
export async function build(options: BuildOptions): Promise<void> {
  console.warn(
    "[hypen] The runtime-specific `build` export is deprecated and differs from `hypen build`. " +
      "Use `import { build } from \"@hypen-space/cli\"` instead."
  );
  const {
    components: componentsDir,
    entry,
    outDir = "dist",
    minify = true,
    sourcemap = false,
  } = options;

  const es = await getEsbuild();
  const { generateComponentsCode } = (await importFromProject(
    "@hypen-space/server",
    () => import("@hypen-space/server")
  )) as any;
  const resolvedComponentsDir = resolve(componentsDir);
  const resolvedOutDir = resolve(outDir);

  console.log(`\n  ${boldPink("Hypen Build")} ${dim("(Node.js)")}\n`);
  console.log(`  ${dim("Entry:")}      ${entry}`);
  console.log(`  ${dim("Components:")} ${resolvedComponentsDir}`);
  console.log(`  ${dim("Output:")}     ${resolvedOutDir}\n`);

  if (!existsSync(resolvedOutDir)) {
    mkdirSync(resolvedOutDir, { recursive: true });
  }

  const tempDir = join(resolvedOutDir, ".temp");
  const code = await generateComponentsCode(resolvedComponentsDir, { outputDir: tempDir });
  if (!existsSync(tempDir)) {
    mkdirSync(tempDir, { recursive: true });
  }
  const componentsPath = join(tempDir, "components.generated.ts");
  writeFileSync(componentsPath, code);

  const mainPath = join(tempDir, "main.ts");
  writeFileSync(mainPath, generateLegacyMainEntry(entry, componentsPath));

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

  writeFileSync(join(resolvedOutDir, "index.html"), getLegacyHtml());

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
