// Unit test for the unified storage.mjs backend selection: when a
// localStorage global exists (browser), LocalBucket must ride it — base64
// round-trip, prefix isolation, delete/keys/clear semantics — because
// that's what makes the *bridged* browser host persistent across reloads.
// Runs in node by installing a minimal localStorage shim BEFORE the module
// is imported (selection happens at import time).

const backing = new Map();
globalThis.localStorage = {
  getItem: (k) => (backing.has(k) ? backing.get(k) : null),
  setItem: (k, v) => backing.set(k, String(v)),
  removeItem: (k) => backing.delete(k),
  key: (i) => [...backing.keys()][i] ?? null,
  get length() {
    return backing.size;
  },
};

const { LocalBucket } = await import('../src/storage.mjs');

const enc = new TextEncoder();
const dec = new TextDecoder();
const assert = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
};

const bucket = LocalBucket.open('persistent', 'counter');

// Round-trip arbitrary bytes through the base64 layer.
const payload = new Uint8Array([0, 1, 2, 250, 255, 104, 105]);
bucket.set('blob', payload);
assert(
  dec.decode(bucket.get('blob')) === dec.decode(payload),
  'bytes round-trip through base64',
);

// It actually landed in the (shimmed) localStorage, under the prefix.
assert(
  [...backing.keys()].some((k) => k.startsWith('hypen-storage/')),
  'writes go through globalThis.localStorage',
);

// A second bucket instance (fresh page stand-in) sees the same data.
const rehydrated = LocalBucket.open('persistent', 'counter');
assert(rehydrated.get('blob') !== undefined, 'second open reads persisted value');

// Namespace isolation + keys().
bucket.set('a', enc.encode('1'));
LocalBucket.open('persistent', 'other').set('a', enc.encode('2'));
const keys = bucket.keys('', 10);
assert(keys.includes('a') && keys.includes('blob'), `own keys listed: ${keys}`);
assert(!keys.some((k) => k.includes('other')), 'no cross-namespace leakage');

// delete + clear.
assert(bucket.delete('a') === true, 'delete reports removal');
assert(bucket.get('a') === undefined, 'deleted key is gone');
bucket.clear();
assert(bucket.get('blob') === undefined, 'clear empties the namespace');
assert(
  LocalBucket.open('persistent', 'other').get('a') !== undefined,
  'clear is namespace-scoped',
);

console.log('PASS: localStorage-backed LocalBucket behaves.');
