/**
 * Development server for Canvas Counter Example
 */

import { resolve } from "path";

const PORT = 3001;

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    let path = url.pathname;

    // Default to canvas-counter.html
    if (path === "/") {
      path = "/canvas-counter.html";
    }

    // Serve files from examples directory
    const filePath = resolve(`./examples${path}`);

    try {
      const file = Bun.file(filePath);
      const exists = await file.exists();

      if (!exists) {
        // Try to serve WASM from engine-rs
        if (path.endsWith(".wasm")) {
          const wasmPath = resolve("../hypen-engine-rs/pkg/browser/hypen_engine_bg.wasm");
          const wasmFile = Bun.file(wasmPath);
          if (await wasmFile.exists()) {
            return new Response(wasmFile, {
              headers: { "Content-Type": "application/wasm" },
            });
          }
        }
        return new Response("Not Found", { status: 404 });
      }

      // Set correct MIME type
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

console.log(`🎨 Canvas Counter Example running at http://localhost:${PORT}/`);
console.log(`   Press Ctrl+C to stop the server`);









