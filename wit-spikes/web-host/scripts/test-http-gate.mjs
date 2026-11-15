// Proves the browser-style wasi:http egress gate in JsModuleHost. The native
// hosts gate wasi:http at LINK time from the manifest's `http` bool; the JS
// equivalent is withholding the wasi:http/* shims from the import map built
// at prepare() time.
//
//   (a) http granted (absent/true) -> prepare + instantiate succeed, and a
//       dispatch of "fetch" against a local one-shot server lands the body
//       in module state (wasi:http/outgoing-handler really egresses).
//   (b) http: false -> prepare FAILS with an error naming the missing
//       wasi:http import, before any instantiation.
//
// Uses the same fixture as the native tests:
//   hypen-engine-rs/tests/fixtures/fetcher_module.wasm
//
// Run: node scripts/test-http-gate.mjs

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { JsModuleHost } from '../src/js-module-host.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(
  __dirname, '..', '..', '..', 'hypen-engine-rs', 'tests', 'fixtures', 'fetcher_module.wasm',
);

const enc = new TextEncoder();
const dec = new TextDecoder();

const assert = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
};

const bytes = await readFile(fixture);
const BODY = '{"greeting":"hello"}';

// ── (a) http granted: real egress over the shim ─────────────────────────────

console.log('---- http gate: granted ----');

// One-shot local server, mirrors the native test's one_shot_http(). It MUST
// live off the main thread: the wasi:http shim services the module's
// blocking poll by parking the main thread (Atomics.wait), so a server on
// the main event loop could never accept the connection (deadlock). The
// native test spawns a thread for the same reason.
const serverWorker = new Worker(
  `
  const { createServer } = require('node:http');
  const { parentPort, workerData } = require('node:worker_threads');
  const server = createServer((req, res) => {
    parentPort.postMessage({ hit: req.url });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(workerData.body);
  });
  server.listen(0, '127.0.0.1', () => {
    parentPort.postMessage({ port: server.address().port });
  });
  `,
  { eval: true, workerData: { body: BODY } },
);
const hitPromise = new Promise((resolveHit) => {
  serverWorker.on('message', (m) => { if (m.hit !== undefined) resolveHit(m.hit); });
});
const port = await new Promise((resolvePort) => {
  serverWorker.on('message', (m) => { if (m.port !== undefined) resolvePort(m.port); });
});

const granted = new JsModuleHost();
await granted.prepare('fetcher', bytes, {
  name: 'fetcher', version: '1.0.0',
  storage: ['local', 'app', 'cloud'], reads: [], dispatches: [],
  http: true,
});

const id = granted.instantiate('fetcher');
let state = granted.init(id, enc.encode('{}'));
console.log('init() state =', dec.decode(state));

const url = `http://127.0.0.1:${port}/`;
const out = granted.dispatch(
  id, state,
  { name: 'fetch', payload: enc.encode(JSON.stringify({ url })) },
  [],
);
if (out.state !== undefined) state = out.state;
const parsed = JSON.parse(dec.decode(state));
console.log('dispatch(fetch) state =', dec.decode(state));

const hitUrl = await Promise.race([
  hitPromise,
  new Promise((_, rej) => setTimeout(() => rej(new Error('server never hit')), 5000)),
]);
console.log('local server saw request for', hitUrl);
assert(parsed.error == null, `no fetch error: ${JSON.stringify(parsed.error)}`);
assert(parsed.received?.status === 200, `status 200 recorded, got ${JSON.stringify(parsed.received)}`);
assert(parsed.received?.body === BODY, `body round-tripped, got ${JSON.stringify(parsed.received?.body)}`);

await serverWorker.terminate();

// ── (b) http denied: link-time failure naming the import ────────────────────

console.log('\n---- http gate: denied ----');

const denied = new JsModuleHost();
let err = null;
try {
  await denied.prepare('fetcher', bytes, {
    name: 'fetcher', version: '1.0.0',
    storage: ['local', 'app', 'cloud'], reads: [], dispatches: [],
    http: false,
  });
} catch (e) {
  err = e;
}
assert(err !== null, 'prepare() with http:false rejects');
const msg = String(err?.message ?? err);
console.log('denial error =', msg);
assert(msg.includes('wasi:http'), `denial names the missing wasi:http import: ${msg}`);

// And it never became instantiable.
let instErr = null;
try { denied.instantiate('fetcher'); } catch (e) { instErr = e; }
assert(instErr !== null, 'denied module cannot be instantiated');

console.log('\nPASS: manifest.http gates wasi:http egress at prepare (link) time.');
process.exit(0);
