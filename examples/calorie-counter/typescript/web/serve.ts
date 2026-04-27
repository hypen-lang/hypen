import { readFileSync } from "fs";
import { resolve } from "path";

const PORT = Number(process.env.WEB_PORT) || 3001;
const webDir = import.meta.dir;

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

console.log(`Web client serving at http://localhost:${PORT}`);
