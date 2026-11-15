// End-to-end proof that the BridgedHost in engine.wasm round-trips into a
// JsModuleHost in JS that drives a jco-loaded WASM Component.
//
//   JS (this script)
//     └─► engine.wasm.dispatchAction("increment")
//             └─► BridgedHost::dispatch  (Rust, in engine.wasm)
//                     └─► JsModuleHost.dispatch  (JS, this process)
//                             └─► jco-instantiated counter component
//                                 (a third wasm, hosted entirely in JS)
//                                     └─► returns new state + effects
//             ◄─── BridgedHost decodes ReducerOutput
//             ◄─── engine does path-diff + reactive bookkeeping
//     ◄─── engine.wasm returns
//
// Run with: bun run test:bridged

import { WasmHostedEngine } from '../../../hypen-engine-rs/pkg-bridged/hypen_engine.js';
import { JsModuleHost } from './js-module-host.mjs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const enc = new TextEncoder();
const dec = new TextDecoder();

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(
  __dirname, '..', '..', '..', 'hypen-engine-rs', 'tests', 'fixtures', 'counter_module.wasm',
);

console.log('---- bridged host spike ----');

const manifest = {
  name: 'counter', version: '1.0.0',
  storage: ['local', 'app', 'cloud'], reads: [], dispatches: [],
};

// 1. Wire the bridge: WasmHostedEngine in engine.wasm <-> JsModuleHost here.
//    prepare() jco-transpiles + instantiates the ACTUAL counter component
//    bytes at runtime (the async half), so the engine's later synchronous
//    register/instantiate calls find the bindings ready.
const engine = new WasmHostedEngine();
const jsHost = new JsModuleHost();
await jsHost.prepare('counter', await readFile(fixture), manifest);

// Wrap the JS host's dispatch so the test can (a) observe which actions the
// engine drives through the host, and (b) inject a subscribe request into a
// chosen dispatch's output — standing in for a module that called
// hypen:engine/state.subscribe. (The counter component targets world `module`
// and can't import that capability, so we synthesize the request the shim's
// engineStateImport would otherwise produce.) This exercises the
// subscribeRequests wire field through the Rust BridgedHost::decode_output.
const seenActions = [];
let injectSubscribe = null;                       // a Sub to attach to the next output
const rawDispatch = jsHost.dispatch.bind(jsHost);
jsHost.dispatch = (id, state, action, siblings) => {
  seenActions.push(action.name);
  const out = rawDispatch(id, state, action, siblings);
  if (injectSubscribe) {
    out.subscribeRequests.push(injectSubscribe);
    injectSubscribe = null;
  }
  return out;
};

engine.setModuleHost(jsHost);

// 3. Register + instantiate the counter module through the engine. The call
//    flows: JS -> engine.wasm -> BridgedHost -> JsModuleHost.
//    Pass empty bytes here because prepare() already registered the real
//    bytes and cached the instantiated bindings (register() with empty
//    bytes is a keep-prepared no-op).
// Pass `null` for actions → the engine discovers them from the module's
// `actions` export via the BridgedHost (the same self-describing path the
// native runtime uses).
const id = engine.registerAndInstantiate(
  'counter',
  new Uint8Array(0),
  manifest,
  null,
  enc.encode('{}'),
);
console.log(`registered + instantiated, id=${id}`);

const initial = engine.getModuleState('counter');
console.log('initial state =', initial);
if (initial?.count !== 0) {
  throw new Error(`expected count=0 after init, got ${JSON.stringify(initial)}`);
}

// 4. Dispatch a UI action. The full path runs through the bridge.
engine.dispatchAction('increment', {});
engine.dispatchAction('increment', {});
engine.dispatchAction('increment', {});

const after = engine.getModuleState('counter');
console.log('after 3 increments state =', after);
if (after?.count !== 3) {
  throw new Error(`expected count=3 after 3 increments, got ${JSON.stringify(after)}`);
}

// 5. Subscribe round-trip. Register a self-subscription: whenever
//    counter.count changes, the engine re-dispatches counter's own `sync`
//    action. `sync` returns no new state and doesn't touch count, so the
//    notification fires exactly once with no cascade.
injectSubscribe = { module: 'counter', path: 'count', onChange: 'sync' };
engine.dispatchAction('increment', {});   // count 3 -> 4; registers the sub
                                          // (a subscription never self-fires on
                                          //  the change that created it)

const beforeFire = seenActions.length;
engine.dispatchAction('increment', {});   // count 4 -> 5; this change fires the sub

const afterFire = engine.getModuleState('counter');
console.log('after subscribe + 2 increments state =', afterFire);
if (afterFire?.count !== 5) {
  throw new Error(`expected count=5, got ${JSON.stringify(afterFire)}`);
}

// The engine must have driven `sync` back through the host as a direct result
// of the subscription firing — proof the injected subscribeRequests survived
// BridgedHost::decode_output and registered a live subscription.
const firedActions = seenActions.slice(beforeFire);
if (!firedActions.includes('sync')) {
  throw new Error(
    `subscription did not round-trip: expected a 'sync' re-dispatch after ` +
    `count changed, host saw ${JSON.stringify(firedActions)}`,
  );
}
console.log(`subscribe round-trip fired on-change actions = ${JSON.stringify(firedActions)}`);

console.log('\nPASS: BridgedHost round-trip works end-to-end.');
console.log('      engine.wasm hosted modules running through a JS shim,');
console.log('      same ModuleHost trait as the native wasmtime path.');
