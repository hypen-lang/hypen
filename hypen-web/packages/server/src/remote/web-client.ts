/**
 * Default web client served by `RemoteServer` over plain HTTP.
 *
 * `hypen dev` on a server-based project used to give you only a `ws://`
 * endpoint — nothing to open in a browser. Now any HTTP GET to `/` returns a
 * small HTML shell, and `/__hypen__/client.js` returns a browser bundle of
 * `web-client-entry.ts` (remote protocol client + DOM renderer, no WASM)
 * that dials back into the same server over WebSocket.
 *
 * The bundle is built lazily on the first request with `Bun.build` and
 * cached for the server's lifetime. Building requires `@hypen-space/web` to
 * be resolvable from this package (it is a peer of every scaffolded
 * project); when it isn't — or the runtime isn't Bun — the shell is replaced
 * by an info page and the WebSocket endpoint keeps working exactly as
 * before.
 */

import { existsSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import { frameworkLoggers } from "@hypen-space/core/logger";

const log = frameworkLoggers.remote;

/** Resolve `url` to a filesystem path if the file exists, else null. */
function existingPath(url: URL): string | null {
  try {
    const path = fileURLToPath(url);
    return existsSync(path) ? path : null;
  } catch {
    // Non-file URL (e.g. bundled into a single artifact).
    return null;
  }
}

/**
 * Locate the pre-bundled client written by the package build
 * (`dist/web-client.bundle.js`). From a source checkout this module runs as
 * `src/remote/web-client.ts`; from the published package it runs as
 * `dist/remote/web-client.js` — probe both layouts.
 */
function findPrebuiltBundle(): string | null {
  return (
    existingPath(new URL("../web-client.bundle.js", import.meta.url)) ??
    existingPath(new URL("../../dist/web-client.bundle.js", import.meta.url))
  );
}

/**
 * Locate the browser entry source for on-demand bundling. Sibling of this
 * file in `src/`; the published package ships `src/` too.
 */
function findClientEntry(): string | null {
  return (
    existingPath(new URL("./web-client-entry.ts", import.meta.url)) ??
    existingPath(new URL("../../src/remote/web-client-entry.ts", import.meta.url))
  );
}

let bundlePromise: Promise<string | null> | null = null;

/**
 * Return the browser client bundle, or `null` when it can't be produced in
 * this environment. Prefers the artifact pre-bundled at package build time;
 * falls back to bundling `web-client-entry.ts` on demand (source checkouts).
 * A successful bundle is cached for the process lifetime; a failure is NOT —
 * a transient error (out of memory, dependency mid-install) would otherwise
 * pin the fallback page forever. Concurrent requests share one in-flight
 * attempt. Never rejects.
 */
export function getWebClientBundle(): Promise<string | null> {
  if (!bundlePromise) {
    const attempt = loadOrBuildBundle().then((bundle) => {
      if (bundle === null && bundlePromise === attempt) {
        bundlePromise = null; // retry on the next request
      }
      return bundle;
    });
    bundlePromise = attempt;
  }
  return bundlePromise;
}

async function loadOrBuildBundle(): Promise<string | null> {
  const prebuilt = findPrebuiltBundle();
  if (prebuilt) {
    try {
      return readFileSync(prebuilt, "utf-8");
    } catch (err) {
      log.warn("Failed to read prebuilt web client bundle:", err);
    }
  }

  if (typeof Bun === "undefined") {
    log.warn(
      "Default web client unavailable: no prebuilt bundle and bundling requires Bun.",
    );
    return null;
  }
  const entry = findClientEntry();
  if (!entry) {
    log.warn("Default web client unavailable: web-client-entry.ts not found.");
    return null;
  }
  try {
    // Bundle in a subprocess rather than via the in-process `Bun.build`
    // API: inside `bun test` the in-process bundler inherits the test
    // runner's module resolution and mis-resolves package-relative
    // imports; a clean `bun build` child process is deterministic.
    //
    // `--conditions=bun` makes @hypen-space/* resolve through their `bun`
    // export condition (`src/*.ts`, shipped in the published tarballs)
    // instead of the `browser` condition's `dist/*` — dist is a build
    // artifact that doesn't exist in a source checkout or CI, and this
    // subprocess is always Bun, which bundles TS sources directly.
    const proc = Bun.spawn(
      [
        "bun",
        "build",
        entry,
        "--target",
        "browser",
        "--conditions=bun",
        "--format",
        "esm",
        "--minify",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0 || !out) {
      log.warn(
        "Default web client could not be bundled — is @hypen-space/web installed? " +
          "The ws:// endpoint still works; connect with your own client or Hypen Studio.",
        err.trim(),
      );
      return null;
    }
    return out;
  } catch (err) {
    log.warn("Default web client bundle failed:", err);
    return null;
  }
}

/** HTML shell that mounts the app and loads the bundled client. */
export function renderClientHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
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
  <script type="module" src="/__hypen__/client.js"></script>
</body>
</html>
`;
}

/** Fallback page when the client bundle can't be produced. */
export function renderFallbackHtml(wsHint: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Hypen Remote Server</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 4rem auto; max-width: 40rem; padding: 0 1rem; color: #1f2937; }
    code { background: #f3f4f6; padding: 2px 6px; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>Hypen Remote Server</h1>
  <p>The app is streaming on <code>${wsHint}</code>, but the built-in web
  client could not be bundled (it needs <code>@hypen-space/web</code>
  installed and the Bun runtime).</p>
  <p>Connect with Hypen Studio (<code>hypen test</code>) or your own
  Hypen client instead.</p>
</body>
</html>
`;
}
