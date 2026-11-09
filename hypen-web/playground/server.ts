/**
 * Development server for Hypen Playground
 */

import { unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { pidFileFor } from "./pidfile";

const PORT = Number(process.env.PORT) || 3000;
const ROOT = import.meta.dir;
// Engine WASM served at /wasm/*. Defaults to the in-repo browser build that
// @hypen-space/web-engine ships; `bun run replayground` points it at a fresh
// hypen-engine-rs/pkg/browser build instead.
const WASM_DIR = resolve(
  process.env.HYPEN_PLAYGROUND_WASM_DIR ?? `${ROOT}/../packages/web-engine/wasm-browser`,
);

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    let path = url.pathname;

    // Default to index.html
    if (path === "/") {
      path = "/index.html";
    }

    if (path.includes("..")) {
      return new Response("Not Found", { status: 404 });
    }

    // Serve engine WASM from WASM_DIR, everything else from the playground directory
    const filePath = path.startsWith("/wasm/")
      ? `${WASM_DIR}/${path.slice("/wasm/".length)}`
      : `${ROOT}${path}`;

    try {
      const file = Bun.file(filePath);
      const exists = await file.exists();

      if (!exists) {
        return new Response("Not Found", { status: 404 });
      }

      // Set correct MIME type for WASM files
      const headers: Record<string, string> = {};
      if (path.endsWith(".wasm")) {
        headers["Content-Type"] = "application/wasm";
      } else if (path.endsWith(".js")) {
        headers["Content-Type"] = "application/javascript";
      } else if (path.endsWith(".html")) {
        headers["Content-Type"] = "text/html";
      } else if (path.endsWith(".css")) {
        headers["Content-Type"] = "text/css";
      }

      return new Response(file, { headers });
    } catch (error) {
      console.error(`Error serving ${path}:`, error);
      return new Response("Internal Server Error", { status: 500 });
    }
  },
  development: true,
});

// Record our PID so `bun playground/stop.ts` (used by replayground) stops only
// this server, never some unrelated process that happens to hold the port.
const pidFile = pidFileFor(server.port);
await Bun.write(pidFile, String(process.pid));
const removePidFile = () => {
  try {
    unlinkSync(pidFile);
  } catch {}
};
process.on("exit", removePidFile);
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => process.exit(0));
}

console.log(`🚀 Playground server running at http://localhost:${server.port}/`);
