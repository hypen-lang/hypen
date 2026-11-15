// Spike runner: load the stub Hypen module, wire its capability imports
// to in-memory hosts, and exercise the reducer + effect loop end-to-end.
//
// Run with:  bun run test       (or: node src/run.mjs)

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { instantiate } from '../transpiled/stub-module.js';
import * as preview2Cli from '@bytecodealliance/preview2-shim/cli';
import * as preview2Io from '@bytecodealliance/preview2-shim/io';
import { LocalBucket, CloudBucket, dumpStores } from './storage.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const transpiledDir = resolve(__dirname, '..', 'transpiled');

const enc = new TextEncoder();
const dec = new TextDecoder();

// jco asks for each core .wasm file by relative path. Load + compile on demand.
async function getCoreModule(relPath) {
  const bytes = await readFile(resolve(transpiledDir, relPath));
  return WebAssembly.compile(bytes);
}

// The instantiated module's exports.
const imports = {
  'hypen:storage/local':   { Bucket: LocalBucket  },
  'hypen:storage/cloud':   { Bucket: CloudBucket  },
  // WASI surface pulled in by Rust's stdlib (format!, panic, alloc).
  // The preview2-shim implements all of these for us.
  'wasi:cli/environment':       preview2Cli.environment,
  'wasi:cli/exit':              preview2Cli.exit,
  'wasi:cli/stderr':            preview2Cli.stderr,
  'wasi:cli/stdin':             preview2Cli.stdin,
  'wasi:cli/stdout':            preview2Cli.stdout,
  'wasi:cli/terminal-input':    preview2Cli.terminalInput,
  'wasi:cli/terminal-output':   preview2Cli.terminalOutput,
  'wasi:cli/terminal-stderr':   preview2Cli.terminalStderr,
  'wasi:cli/terminal-stdin':    preview2Cli.terminalStdin,
  'wasi:cli/terminal-stdout':   preview2Cli.terminalStdout,
  'wasi:io/error':              preview2Io.error,
  'wasi:io/poll':               preview2Io.poll,
  'wasi:io/streams':            preview2Io.streams,
};

const mod = await instantiate(getCoreModule, imports);

// -- Drive the module ---------------------------------------------------------

console.log('---- spike: stub counter module ----');

// 1. init — fresh start, no prior persistence.
let state = mod.init(enc.encode('{}'));
console.log('init()         state =', dec.decode(state));

// 2. dispatch "increment" three times. Each one returns a new state snapshot
//    plus a log-effect descriptor that the engine would normally surface.
function runAction(name, payload = '{}') {
  const result = mod.dispatch(state, { name, payload: enc.encode(payload) });
  if (result.state !== undefined) state = result.state;
  console.log(
    `dispatch(${name.padEnd(9)}) state =`, dec.decode(state),
    '  effects =', result.effects.map(e =>
      e.tag === 'log' ? `log[${e.val.level}] ${e.val.message}` : e.tag
    ),
  );
  return result;
}

runAction('increment');
runAction('increment');
runAction('increment');

// 3. sync to cloud via compare-and-set. State doesn't change but the cloud
//    store gets a versioned entry.
runAction('sync');

// 4. Inspect what got persisted.
console.log('\n---- persisted state ----');
console.dir(dumpStores(), { depth: null });

// 5. Sanity: spin a second instance, observe that local survived (proves the
//    module's `init` reads back from storage).
console.log('\n---- second instance (warm start) ----');
const mod2 = await instantiate(getCoreModule, imports);
const restored = mod2.init(enc.encode('{}'));
console.log('init()         state =', dec.decode(restored));

// Final assertion: count should be 3 (three increments persisted to local).
const finalCount = JSON.parse(dec.decode(restored)).count;
if (finalCount !== 3) {
  console.error(`FAIL: expected count=3 after warm start, got ${finalCount}`);
  process.exit(1);
}
console.log('\nPASS: end-to-end reducer + storage loop works.');
