import { readFileSync } from "fs";
import { resolve, extname } from "path";

const PORT = Number(process.env.WEB_PORT) || 3001;
const webDir = import.meta.dir;

// The backend's WebSocket URL, injected into the page as
// `<meta name="hypen-ws">` so the client follows the server's real port.
// WS_URL overrides it outright; otherwise it is this request's host on the
// backend's PORT (the same variable every Social server listens on).
function backendWsUrl(url: URL): string {
  if (process.env.WS_URL) return process.env.WS_URL;
  const scheme = url.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${url.hostname}:${Number(process.env.PORT) || 3000}`;
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = readFileSync(resolve(webDir, "index.html"), "utf-8").replace(
        "</head>",
        `  <meta name="hypen-ws" content="${backendWsUrl(url)}">\n</head>`,
      );
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
