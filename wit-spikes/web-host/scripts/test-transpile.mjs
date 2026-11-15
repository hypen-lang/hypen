// Proves the runtime jco-transpile pipeline in JsModuleHost: register the
// ACTUAL counter_module.wasm fixture bytes, `await prepare()` (in-memory
// transpile -> WebAssembly.compile -> instantiate against the wasi shim
// import map), then drive the synchronous host surface (instantiate / init /
// dispatch / actions) exactly the way the Rust BridgedHost does.
//
// Run: node scripts/test-transpile.mjs

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsModuleHost } from '../src/js-module-host.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(
  __dirname, '..', '..', '..', 'hypen-engine-rs', 'tests', 'fixtures', 'counter_module.wasm',
);

const enc = new TextEncoder();
const dec = new TextDecoder();

const assert = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
};

console.log('---- runtime transpile pipeline ----');

const bytes = await readFile(fixture);
const manifest = {
  name: 'counter', version: '1.0.0',
  storage: ['local', 'app', 'cloud'], reads: [], dispatches: [],
};

const host = new JsModuleHost();

// register() alone must NOT make the module instantiable — the async
// transpile work belongs to prepare().
host.register('counter', bytes, manifest);
let threw = null;
try { host.instantiate('counter'); } catch (e) { threw = e; }
assert(threw && /not prepared/.test(String(threw)), 'instantiate before prepare throws "not prepared"');

// The real pipeline: jco transpile in memory + compile + instantiate.
await host.prepare('counter');

// From here on everything is synchronous, matching the BridgedHost contract.
const id = host.instantiate('counter');
assert(typeof id === 'number', 'instantiate returns a numeric id');

const acts = host.actions(id);
console.log('actions() =', acts);
assert(acts.includes('increment') && acts.includes('sync'), `module self-describes actions: ${acts}`);

let state = host.init(id, enc.encode('{}'));
console.log('init()   state =', dec.decode(state));
assert(JSON.parse(dec.decode(state)).count === 0, 'fresh init starts at count=0');

for (let i = 1; i <= 3; i++) {
  const out = host.dispatch(id, state, { name: 'increment', payload: enc.encode('{}') }, []);
  if (out.state !== undefined) state = out.state;
  console.log(`dispatch(increment) state = ${dec.decode(state)}  effects =`,
    out.effects.map(e => e.tag));
  assert(JSON.parse(dec.decode(state)).count === i, `count=${i} after increment #${i}`);
  assert(out.effects.some(e => e.tag === 'log'), 'increment emits a log effect');
}

// A second instance of the same prepared component still works.
const id2 = host.instantiate('counter');
assert(id2 !== id, 'second instantiate gets a fresh id');
const state2 = host.init(id2, enc.encode('{}'));
// The counter persists to hypen:storage/local, so a warm init reads 3 back.
assert(JSON.parse(dec.decode(state2)).count === 3,
  `warm init restores persisted count=3, got ${dec.decode(state2)}`);

host.destroy(id2);
host.destroy(id);

console.log('\nPASS: runtime jco transpile pipeline drives the real fixture end-to-end.');
