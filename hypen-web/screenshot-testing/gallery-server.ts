/**
 * Hypen Web Gallery Server
 *
 * Serves the gallery.html with bundled TypeScript.
 * Bun automatically bundles the TypeScript when importing HTML.
 *
 * Run with: bun run gallery-server.ts
 */

const PORT = process.env.GALLERY_PORT ? parseInt(process.env.GALLERY_PORT) : 5556;

// Import HTML - Bun automatically bundles referenced .ts files
import index from "./gallery.html";

Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",

  routes: {
    "/": index,
    "/gallery": index,
    "/gallery.html": index,
  },

  development: {
    hmr: true,
    console: true,
  },
});

console.log(`
Hypen Web Gallery Server running at:
  http://localhost:${PORT}

Usage:
  http://localhost:${PORT}?name=button
  http://localhost:${PORT}?name=padding
  http://localhost:${PORT}#column

Make sure component-gallery-server is running on port 6555:
  cd ../../component-gallery-server && bun run server.ts
`);
