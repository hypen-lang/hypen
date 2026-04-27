import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const PORT =
  Number(process.env.WEB_CANVAS_PORT) ||
  Number(process.env.WEB_PORT) ||
  3002;
const webDir = import.meta.dir;

// Resolve taffy-layout's WASM payload up the workspace. The bundled canvas
// renderer references it via `new URL('taffy_wasm_bg.wasm', import.meta.url)`,
// which after bundling resolves to `/<filename>` at the page origin. Without
// this route the file 404s and Taffy never initialises — the renderer then
// silently falls back to the JS flexbox path, which has known parity issues.
function findTaffyWasm(): string | null {
  // examples/social/typescript/web_canvas → examples/social/typescript → ts → social → examples → repo
  const candidates = [
    resolve(webDir, "../node_modules/taffy-layout/pkg/taffy_wasm_bg.wasm"),
    resolve(webDir, "../../../../hypen-web/node_modules/taffy-layout/pkg/taffy_wasm_bg.wasm"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}
const TAFFY_WASM_PATH = findTaffyWasm();

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = readFileSync(resolve(webDir, "index.html"), "utf-8");
      return new Response(html, {
        headers: { "Content-Type": "text/html" },
      });
    }

    if (url.pathname === "/taffy_wasm_bg.wasm") {
      if (!TAFFY_WASM_PATH) {
        return new Response("taffy WASM not found", { status: 404 });
      }
      return new Response(readFileSync(TAFFY_WASM_PATH), {
        headers: { "Content-Type": "application/wasm" },
      });
    }

    if (url.pathname.endsWith(".ts")) {
      const filePath = resolve(webDir, url.pathname.slice(1));
      const result = await Bun.build({
        entrypoints: [filePath],
        target: "browser",
        format: "esm",
      });
      if (result.outputs.length > 0) {
        const code = await result.outputs[0].text();
        return new Response(code, {
          headers: { "Content-Type": "application/javascript" },
        });
      }
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`Web canvas client serving at http://localhost:${PORT}`);
