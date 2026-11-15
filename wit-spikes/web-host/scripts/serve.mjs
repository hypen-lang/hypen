// Tiny static server with on-the-fly bundling for browser.mjs.
// Run: `bun run serve` then open http://localhost:3000.

import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const mimeFor = (path) => {
  if (path.endsWith('.html')) return 'text/html; charset=utf-8';
  if (path.endsWith('.js') || path.endsWith('.mjs')) return 'application/javascript';
  if (path.endsWith('.wasm')) return 'application/wasm';
  if (path.endsWith('.css')) return 'text/css';
  if (path.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
};

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  async fetch(req) {
    const url = new URL(req.url);
    let path = url.pathname;
    if (path === '/') path = '/index.html';

    // Special: bundle browser.mjs (+ deps like preview2-shim) on demand.
    // Avoids a build step. Bun.build handles bare module specifiers
    // through node_modules.
    if (path === '/dist/browser.js') {
      const result = await Bun.build({
        entrypoints: [join(root, 'src/browser.mjs')],
        target: 'browser',
        format: 'esm',
        minify: false,
        sourcemap: 'inline',
      });
      if (!result.success) {
        const msg = result.logs.map(l => l.message).join('\n');
        console.error('[bundle error]\n' + msg);
        return new Response(`/* bundle error */\nconsole.error(${JSON.stringify(msg)});`, {
          status: 500,
          headers: { 'Content-Type': 'application/javascript' },
        });
      }
      return new Response(await result.outputs[0].text(), {
        headers: { 'Content-Type': 'application/javascript' },
      });
    }

    // Static files from the spike directory.
    const file = Bun.file(join(root, path));
    if (!(await file.exists())) return new Response('not found', { status: 404 });
    return new Response(file, { headers: { 'Content-Type': mimeFor(path) } });
  },
});

console.log(`serving http://localhost:${server.port}`);
