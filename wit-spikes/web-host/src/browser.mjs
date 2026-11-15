// Browser entry point. Same loop as src/run.mjs but rendered to the DOM
// instead of stdout, with localStorage-backed storage scopes so state
// survives a page reload (proves the persistence claim in a real browser).

import { instantiate } from '../transpiled/stub-module.js';
import * as preview2Cli from '@bytecodealliance/preview2-shim/cli';
import * as preview2Io from '@bytecodealliance/preview2-shim/io';
import { LocalBucket, CloudBucket, dumpStores, clearAll } from './storage-browser.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();

const log = (line, cls = '') => {
  const out = document.getElementById('output');
  const el = document.createElement('div');
  if (cls) el.className = cls;
  el.textContent = line;
  out.appendChild(el);
  out.scrollTop = out.scrollHeight;
};
const logEffects = (effects) => effects.map(e =>
  e.tag === 'log' ? `log[${e.val.level}] ${e.val.message}` : e.tag,
);

// Fetch + compile the core .wasm files that the transpiled module asks for.
async function getCoreModule(relPath) {
  const response = await fetch(`./transpiled/${relPath}`);
  if (!response.ok) throw new Error(`failed to fetch core module ${relPath}: ${response.status}`);
  const bytes = await response.arrayBuffer();
  return WebAssembly.compile(bytes);
}

const imports = {
  'hypen:storage/local':         { Bucket: LocalBucket },
  'hypen:storage/cloud':         { Bucket: CloudBucket },
  'wasi:cli/environment':        preview2Cli.environment,
  'wasi:cli/exit':               preview2Cli.exit,
  'wasi:cli/stderr':             preview2Cli.stderr,
  'wasi:cli/stdin':              preview2Cli.stdin,
  'wasi:cli/stdout':             preview2Cli.stdout,
  'wasi:cli/terminal-input':     preview2Cli.terminalInput,
  'wasi:cli/terminal-output':    preview2Cli.terminalOutput,
  'wasi:cli/terminal-stderr':    preview2Cli.terminalStderr,
  'wasi:cli/terminal-stdin':     preview2Cli.terminalStdin,
  'wasi:cli/terminal-stdout':    preview2Cli.terminalStdout,
  'wasi:io/error':               preview2Io.error,
  'wasi:io/poll':                preview2Io.poll,
  'wasi:io/streams':             preview2Io.streams,
};

let mod;
let state;

async function loadModule() {
  log('---- loading module ----', 'section');
  mod = await instantiate(getCoreModule, imports);
  state = mod.init(enc.encode('{}'));
  log(`init()         state = ${dec.decode(state)}`);
}

function dispatch(name, payload = '{}') {
  const result = mod.dispatch(state, { name, payload: enc.encode(payload) });
  if (result.state !== undefined) state = result.state;
  log(
    `dispatch(${name.padEnd(9)}) state = ${dec.decode(state)}   effects = [${logEffects(result.effects).join(', ')}]`,
  );
  return result;
}

function showStores() {
  log('---- persisted ----', 'section');
  log(JSON.stringify(dumpStores(), null, 2));
}

// Wire up UI.
document.getElementById('increment').addEventListener('click', () => dispatch('increment'));
document.getElementById('sync').addEventListener('click', () => dispatch('sync'));
document.getElementById('reload').addEventListener('click', async () => {
  log('---- warm start (reusing localStorage) ----', 'section');
  await loadModule();
});
document.getElementById('reset').addEventListener('click', () => {
  clearAll();
  log('---- cleared all storage ----', 'section');
  document.getElementById('output').innerHTML = '';
  loadModule();
});
document.getElementById('dump').addEventListener('click', showStores);

await loadModule();

// Expose for e2e test driver (playwright reads window.__spike).
// Only set AFTER first init completes so test drivers can use its presence
// as a readiness signal.
window.__spike = {
  dispatch,
  getState: () => dec.decode(state),
  dumpStores,
  reload: loadModule,
};
