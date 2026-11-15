// localStorage-backed `hypen:storage/{local,cloud}` for browser hosts.
//
// Why localStorage and not IndexedDB? Our v0.1 storage WIT exposes sync
// methods (get/set/delete). IndexedDB is async. localStorage is sync, has
// per-origin scoping, ~5-10MB capacity. Good enough to prove the loop;
// real production wants async storage (see wit/V0_2_NOTES.md §2).

const dec = new TextDecoder();
const enc = new TextEncoder();

const PREFIX_LOCAL = 'hypen:local/';
const PREFIX_CLOUD = 'hypen:cloud/';

const fmtKey = (tier, namespace, key) => `${tier}/${namespace}/${key}`;

// Encode bytes -> base64 string for localStorage (which is text-only).
function bytesToB64(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function b64ToBytes(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ----------------------------------------------------------------------------
// LocalBucket — module-private, device-local, persisted to localStorage.
// ----------------------------------------------------------------------------
export class LocalBucket {
  constructor(tier, namespace) {
    this.tier = tier;
    this.namespace = namespace;
  }

  static open(tier, namespace) {
    return new LocalBucket(tier, namespace);
  }

  #lsKey(key) {
    return PREFIX_LOCAL + fmtKey(this.tier, this.namespace, key);
  }

  get(key) {
    const stored = localStorage.getItem(this.#lsKey(key));
    return stored === null ? undefined : b64ToBytes(stored);
  }

  set(key, value) {
    localStorage.setItem(this.#lsKey(key), bytesToB64(value));
  }

  delete(key) {
    const k = this.#lsKey(key);
    const existed = localStorage.getItem(k) !== null;
    localStorage.removeItem(k);
    return existed;
  }

  keys(prefix, limit) {
    const fullPrefix = this.#lsKey(prefix);
    const stripFrom = PREFIX_LOCAL.length + `${this.tier}/${this.namespace}/`.length;
    const out = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(fullPrefix)) {
        out.push(k.slice(stripFrom));
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  info(key) {
    const stored = localStorage.getItem(this.#lsKey(key));
    if (stored === null) return undefined;
    return {
      size: BigInt(b64ToBytes(stored).byteLength),
      modifiedMs: 0n,
      version: undefined,
    };
  }

  clear() {
    const prefix = PREFIX_LOCAL + `${this.tier}/${this.namespace}/`;
    const toDelete = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) toDelete.push(k);
    }
    for (const k of toDelete) localStorage.removeItem(k);
  }
}

// ----------------------------------------------------------------------------
// CloudBucket — synced (in-memory only in this spike; localStorage just
// proves the loop). Real cloud impl would talk to a sync service.
// Values stored as `{v: base64, ver: "N"}` to keep version numbers.
// ----------------------------------------------------------------------------
export class CloudBucket {
  constructor(tier, namespace) {
    this.tier = tier;
    this.namespace = namespace;
  }

  static open(tier, namespace) {
    return new CloudBucket(tier, namespace);
  }

  #lsKey(key) {
    return PREFIX_CLOUD + fmtKey(this.tier, this.namespace, key);
  }

  #read(key) {
    const raw = localStorage.getItem(this.#lsKey(key));
    if (raw === null) return undefined;
    const { v, ver } = JSON.parse(raw);
    return { value: b64ToBytes(v), version: BigInt(ver) };
  }

  #write(key, value, version) {
    localStorage.setItem(
      this.#lsKey(key),
      JSON.stringify({ v: bytesToB64(value), ver: version.toString() }),
    );
  }

  get(key) {
    return this.#read(key)?.value;
  }

  set(key, value) {
    const prev = this.#read(key);
    const nextVersion = prev ? prev.version + 1n : 1n;
    this.#write(key, value, nextVersion);
  }

  delete(key) {
    const k = this.#lsKey(key);
    const existed = localStorage.getItem(k) !== null;
    localStorage.removeItem(k);
    return existed;
  }

  keys(prefix, limit) {
    const fullPrefix = this.#lsKey(prefix);
    const stripFrom = PREFIX_CLOUD.length + `${this.tier}/${this.namespace}/`.length;
    const out = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(fullPrefix)) {
        out.push(k.slice(stripFrom));
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  info(key) {
    const entry = this.#read(key);
    if (entry === undefined) return undefined;
    return {
      size: BigInt(entry.value.byteLength),
      modifiedMs: 0n,
      version: entry.version,
    };
  }

  compareAndSet(key, expectedVersion, value) {
    const prev = this.#read(key);
    const currentVersion = prev?.version;
    const matches = expectedVersion === undefined
      ? currentVersion === undefined
      : currentVersion === expectedVersion;

    if (!matches) {
      throw { tag: 'unavailable', val: 'version mismatch' };
    }

    const nextVersion = (currentVersion ?? 0n) + 1n;
    this.#write(key, value, nextVersion);
    return nextVersion;
  }
}

export function dumpStores() {
  const local = {};
  const cloud = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    const v = localStorage.getItem(k);
    if (k.startsWith(PREFIX_LOCAL)) {
      local[k.slice(PREFIX_LOCAL.length)] = dec.decode(b64ToBytes(v));
    } else if (k.startsWith(PREFIX_CLOUD)) {
      const { v: payload, ver } = JSON.parse(v);
      cloud[k.slice(PREFIX_CLOUD.length)] = {
        value: dec.decode(b64ToBytes(payload)),
        version: ver,
      };
    }
  }
  return { local, cloud };
}

export function clearAll() {
  const toDelete = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k.startsWith(PREFIX_LOCAL) || k.startsWith(PREFIX_CLOUD)) toDelete.push(k);
  }
  for (const k of toDelete) localStorage.removeItem(k);
}
