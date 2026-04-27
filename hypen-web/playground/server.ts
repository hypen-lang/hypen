/**
 * Development server for Hypen Playground
 */

const PORT = 3000;

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    let path = url.pathname;

    // Default to index.html
    if (path === "/") {
      path = "/index.html";
    }

    // Serve files from playground directory
    const filePath = `./playground${path}`;

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

console.log(`🚀 Playground server running at http://localhost:${PORT}/`);
