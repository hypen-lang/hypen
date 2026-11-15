// Host-side implementations of the `hypen:storage/{local,cloud}` capability
// imports (WIT resources -> JS classes, per jco convention:
//   - `static open(...)` for `resource bucket { open: static func(...) ... }`
//   - instance methods for each non-static func
// Errors are thrown; success values returned directly).
//
// local: module-private, this-device-only storage. In a browser it is backed
// by window.localStorage (persistent across page loads — the browser
// counterpart of the native hosts' `set_storage_path`), with bytes
// base64-encoded because localStorage only holds strings. localStorage's API
// is synchronous, which is exactly what the sync v0.1 import surface needs;
// IndexedDB (async-only) has to wait for jco's async imports / JSPI. Outside
// a browser (node, workers without DOM) it falls back to an in-memory Map
// behind the same interface.
//
// cloud: synced storage with compare-and-set for cross-device coordination.
// In-memory here; pretends to sync. Versions are monotonic per key.

const dec = new TextDecoder();

const fmtKey = (tier: string, namespace: string, key: string): string =>
  `${tier}/${namespace}/${key}`;

/** Minimal synchronous byte-store surface both local backends implement. */
export interface LocalStoreBackend {
  get(key: string): Uint8Array | undefined;
  set(key: string, value: Uint8Array): void;
  delete(key: string): boolean;
  keys(): IterableIterator<string>;
}

// ----------------------------------------------------------------------------
// hypen:storage/local backends
// ----------------------------------------------------------------------------

/** All localStorage keys the host writes live under this prefix. */
export const LS_PREFIX = "hypen-storage/";

const b64encode = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
const b64decode = (str: string): Uint8Array =>
  Uint8Array.from(atob(str), (c) => c.charCodeAt(0));

/** Map-shaped adapter over window.localStorage under a namespace prefix. */
export class BrowserLocalStore implements LocalStoreBackend {
  get(key: string): Uint8Array | undefined {
    const raw = globalThis.localStorage.getItem(LS_PREFIX + key);
    return raw === null ? undefined : b64decode(raw);
  }
  set(key: string, value: Uint8Array): void {
    globalThis.localStorage.setItem(LS_PREFIX + key, b64encode(value));
  }
  delete(key: string): boolean {
    const full = LS_PREFIX + key;
    const had = globalThis.localStorage.getItem(full) !== null;
    globalThis.localStorage.removeItem(full);
    return had;
  }
  *keys(): IterableIterator<string> {
    const ls = globalThis.localStorage;
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (k !== null && k.startsWith(LS_PREFIX)) yield k.slice(LS_PREFIX.length);
    }
  }
}

/** In-memory fallback with the same surface (node, workers without DOM). */
export class MemoryLocalStore implements LocalStoreBackend {
  data = new Map<string, Uint8Array>(); // key -> bytes

  get(key: string): Uint8Array | undefined {
    return this.data.get(key);
  }
  set(key: string, value: Uint8Array): void {
    this.data.set(key, value);
  }
  delete(key: string): boolean {
    return this.data.delete(key);
  }
  *keys(): IterableIterator<string> {
    yield* this.data.keys();
  }
}

// Backend selection happens once, at import time: a localStorage global
// means browser-persistent, otherwise in-memory.
const localStore: LocalStoreBackend =
  typeof globalThis.localStorage !== "undefined"
    ? new BrowserLocalStore()
    : new MemoryLocalStore();

/** `info(key)` result: WIT `record` with size/mtime/optional version. */
export interface BucketEntryInfo {
  size: bigint;
  modifiedMs: bigint;
  version: bigint | undefined;
}

export class LocalBucket {
  tier: string;
  namespace: string;

  constructor(tier: string, namespace: string) {
    this.tier = tier;
    this.namespace = namespace;
  }

  static open(tier: string, namespace: string): LocalBucket {
    return new LocalBucket(tier, namespace);
  }

  get(key: string): Uint8Array | undefined {
    // option<list<u8>> → Uint8Array | undefined
    return localStore.get(fmtKey(this.tier, this.namespace, key));
  }

  set(key: string, value: Uint8Array): void {
    localStore.set(fmtKey(this.tier, this.namespace, key), value);
  }

  delete(key: string): boolean {
    return localStore.delete(fmtKey(this.tier, this.namespace, key));
  }

  keys(prefix: string, limit: number): string[] {
    const out: string[] = [];
    const fullPrefix = fmtKey(this.tier, this.namespace, prefix);
    for (const k of localStore.keys()) {
      if (k.startsWith(fullPrefix)) {
        out.push(k.slice(`${this.tier}/${this.namespace}/`.length));
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  info(key: string): BucketEntryInfo | undefined {
    const value = localStore.get(fmtKey(this.tier, this.namespace, key));
    if (value === undefined) return undefined;
    return { size: BigInt(value.byteLength), modifiedMs: 0n, version: undefined };
  }

  clear(): void {
    const prefix = `${this.tier}/${this.namespace}/`;
    for (const k of Array.from(localStore.keys())) {
      if (k.startsWith(prefix)) localStore.delete(k);
    }
  }
}

// ----------------------------------------------------------------------------
// hypen:storage/cloud — synced. Adds compare-and-set for cross-device.
// ----------------------------------------------------------------------------

interface CloudEntry {
  value: Uint8Array;
  version: bigint;
}

class CloudStore {
  data = new Map<string, CloudEntry>();
}

const cloudStore = new CloudStore();

export class CloudBucket {
  tier: string;
  namespace: string;

  constructor(tier: string, namespace: string) {
    this.tier = tier;
    this.namespace = namespace;
  }

  static open(tier: string, namespace: string): CloudBucket {
    return new CloudBucket(tier, namespace);
  }

  get(key: string): Uint8Array | undefined {
    return cloudStore.data.get(fmtKey(this.tier, this.namespace, key))?.value;
  }

  set(key: string, value: Uint8Array): void {
    const k = fmtKey(this.tier, this.namespace, key);
    const prev = cloudStore.data.get(k);
    const nextVersion = prev ? prev.version + 1n : 1n;
    cloudStore.data.set(k, { value, version: nextVersion });
  }

  delete(key: string): boolean {
    return cloudStore.data.delete(fmtKey(this.tier, this.namespace, key));
  }

  keys(prefix: string, limit: number): string[] {
    const out: string[] = [];
    const fullPrefix = fmtKey(this.tier, this.namespace, prefix);
    for (const k of cloudStore.data.keys()) {
      if (k.startsWith(fullPrefix)) {
        out.push(k.slice(`${this.tier}/${this.namespace}/`.length));
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  info(key: string): BucketEntryInfo | undefined {
    const entry = cloudStore.data.get(fmtKey(this.tier, this.namespace, key));
    if (entry === undefined) return undefined;
    return {
      size: BigInt(entry.value.byteLength),
      modifiedMs: 0n,
      version: entry.version,
    };
  }

  compareAndSet(
    key: string,
    expectedVersion: bigint | undefined,
    value: Uint8Array,
  ): bigint {
    const k = fmtKey(this.tier, this.namespace, key);
    const prev = cloudStore.data.get(k);

    const currentVersion = prev?.version;
    const matches =
      expectedVersion === undefined
        ? currentVersion === undefined
        : currentVersion === expectedVersion;

    if (!matches) {
      // WIT: result<u64, error>. Errors thrown by host show up as guest Err.
      throw { tag: "unavailable", val: "version mismatch" };
    }

    const nextVersion = (currentVersion ?? 0n) + 1n;
    cloudStore.data.set(k, { value, version: nextVersion });
    return nextVersion;
  }
}

/** Dev affordance: inspect what got persisted (values decoded as UTF-8). */
export function dumpStores(): {
  local: Record<string, string>;
  cloud: Record<string, { value: string; version: string }>;
} {
  const local: Record<string, string> = {};
  for (const k of localStore.keys()) {
    const v = localStore.get(k);
    if (v !== undefined) local[k] = dec.decode(v);
  }
  return {
    local,
    cloud: Object.fromEntries(
      [...cloudStore.data.entries()].map(([k, { value, version }]) => [
        k,
        { value: dec.decode(value), version: version.toString() },
      ]),
    ),
  };
}
