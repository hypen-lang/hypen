/**
 * Minimal static file server used for both apps.
 *
 * Deliberately identical for React and Hypen — same headers, no compression,
 * no caching — so nothing about the transport can favour one side. Byte sizes
 * for the report are computed from the files on disk, not from the response.
 */

import { file } from "bun";
import { resolve } from "node:path";

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  wasm: "application/wasm",
  json: "application/json",
  map: "application/json",
};

export interface StaticServer {
  url: string;
  stop: () => void;
}

export function serveDir(dir: string, port: number): StaticServer {
  const root = resolve(dir);
  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      let path = decodeURIComponent(url.pathname);
      if (path.endsWith("/")) path += "index.html";
      const target = resolve(root + path);
      if (!target.startsWith(root)) return new Response("no", { status: 403 });

      const f = file(target);
      if (!(await f.exists())) {
        // SPA fallback.
        const index = file(resolve(root, "index.html"));
        return new Response(index, {
          headers: { "content-type": TYPES.html },
        });
      }
      const ext = target.split(".").pop() ?? "";
      return new Response(f, {
        headers: {
          "content-type": TYPES[ext] ?? "application/octet-stream",
          "cache-control": "no-store",
        },
      });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  };
}
