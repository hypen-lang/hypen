// Host-side implementation of the `hypen:storage/{local,app,cloud}`
// capability imports (wit/deps/hypen-storage/storage.wit).
//
// Layering:
//
//   StorageBackend      dumb synchronous byte store (get/set/delete/keys).
//                       Injected per JsModuleHost; defaults to localStorage
//                       when the global exists, otherwise in-memory.
//   HostStorage         one per JsModuleHost. Owns the backends and applies
//                       the policy: scope isolation, unambiguous composite
//                       keys, per-entry metadata (size / modified time /
//                       cloud version / writer) and quotas.
//   createStorageImports(storage, module)
//                       the jco-shaped import objects for ONE module: WIT
//                       resources become JS classes (`static open(...)` +
//                       instance methods), errors are thrown as the WIT
//                       `error` variant (`{ tag, val }`), success values are
//                       returned directly. The module name is bound here, at
//                       link time — it is never a guest-supplied parameter.
//
// Scopes (parity with the native WasmtimeHost):
//
//   local  always granted, MODULE-PRIVATE: every key lives under the
//          registered module name, so one module can never read or
//          overwrite another's `local` data.
//   app    shared by every module of the app (one keyspace). Linked only
//          when the manifest grants it.
//   cloud  user-scoped, shared by the app's modules (the WIT describes it as
//          the user's synced store, not a per-module one). Linked only when
//          granted. NOT ACTUALLY SYNCED by this package: see CloudBucket
//          below.
//
// Blob resources (`blob-bucket` / `blob-handle` / `blob-writer`) are stubs
// that fail with `unavailable`, matching the native hosts.

/** The three `hypen:storage` visibility scopes. */
export type StorageScope = "local" | "app" | "cloud";

/** All storage scopes, in WIT order. */
export const STORAGE_SCOPES: readonly StorageScope[] = ["local", "app", "cloud"];

/**
 * Minimal synchronous byte store behind {@link HostStorage}. Keys are opaque
 * strings produced by the host (already scoped and escaped); values are raw
 * bytes. Must be synchronous: the Rust BridgedHost drives reducers
 * synchronously, so storage imports cannot await.
 *
 * Implementations may throw; the host surfaces the failure to the module as
 * the WIT `backend` error (or `quota-exceeded` for the host's own quotas).
 */
export interface StorageBackend {
  get(key: string): Uint8Array | undefined;
  set(key: string, value: Uint8Array): void;
  /** Returns whether the key existed. */
  delete(key: string): boolean;
  /** Every key currently stored (iteration may be lazy). */
  keys(): Iterable<string>;
}

// ----------------------------------------------------------------------------
// Backends
// ----------------------------------------------------------------------------

/** In-memory backend. Persistence lasts for the lifetime of the object. */
export class MemoryStorageBackend implements StorageBackend {
  readonly data = new Map<string, Uint8Array>();

  get(key: string): Uint8Array | undefined {
    return this.data.get(key);
  }
  set(key: string, value: Uint8Array): void {
    // Copy: callers (jco lifting, tests) may reuse the buffer.
    this.data.set(key, value.slice());
  }
  delete(key: string): boolean {
    return this.data.delete(key);
  }
  keys(): Iterable<string> {
    return Array.from(this.data.keys());
  }
}

/** The subset of the DOM `Storage` interface {@link LocalStorageBackend} uses. */
export interface StorageLike {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Default key prefix {@link LocalStorageBackend} writes under. */
export const LS_PREFIX = "hypen-storage:v1/";

const b64encode = (bytes: Uint8Array): string => {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
};
const b64decode = (str: string): Uint8Array =>
  Uint8Array.from(atob(str), (c) => c.charCodeAt(0));

function globalLocalStorage(): StorageLike | undefined {
  try {
    // Accessing `localStorage` throws in sandboxed iframes / opaque origins.
    return (globalThis as { localStorage?: StorageLike }).localStorage;
  } catch {
    return undefined;
  }
}

/**
 * Backend over a DOM `Storage` (default `globalThis.localStorage`), with
 * bytes base64-encoded because Storage only holds strings. Synchronous,
 * which is what the sync import surface needs (IndexedDB is async-only).
 * Only keys under `prefix` are ever read, listed or removed.
 */
export class LocalStorageBackend implements StorageBackend {
  readonly #storage: StorageLike;
  readonly prefix: string;

  constructor(storage?: StorageLike, prefix: string = LS_PREFIX) {
    const resolved = storage ?? globalLocalStorage();
    if (!resolved) {
      throw new Error("LocalStorageBackend: no localStorage available in this environment");
    }
    this.#storage = resolved;
    this.prefix = prefix;
  }

  get(key: string): Uint8Array | undefined {
    const raw = this.#storage.getItem(this.prefix + key);
    return raw === null ? undefined : b64decode(raw);
  }
  set(key: string, value: Uint8Array): void {
    this.#storage.setItem(this.prefix + key, b64encode(value));
  }
  delete(key: string): boolean {
    const full = this.prefix + key;
    const had = this.#storage.getItem(full) !== null;
    if (had) this.#storage.removeItem(full);
    return had;
  }
  keys(): Iterable<string> {
    // Snapshot: callers delete while iterating (clear()).
    const out: string[] = [];
    const s = this.#storage;
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k !== null && k.startsWith(this.prefix)) out.push(k.slice(this.prefix.length));
    }
    return out;
  }
}

/**
 * The default `local`/`app` backend: localStorage-backed when a usable
 * `localStorage` global exists (browsers), otherwise a fresh in-memory store
 * (Node, Bun, workers without DOM storage). Evaluated when called — i.e. per
 * host construction, not at import time.
 */
export function defaultStorageBackend(): StorageBackend {
  const ls = globalLocalStorage();
  if (ls) {
    try {
      return new LocalStorageBackend(ls);
    } catch {
      // fall through
    }
  }
  return new MemoryStorageBackend();
}

// ----------------------------------------------------------------------------
// Errors, quotas, metadata
// ----------------------------------------------------------------------------

/** The WIT `hypen:storage/types.error` variant, jco representation. */
export type StorageError =
  | { tag: "not-found" }
  | { tag: "quota-exceeded"; val: bigint }
  | { tag: "unavailable"; val: string }
  | { tag: "corrupted"; val: string }
  | { tag: "backend"; val: string };

/** Storage quotas enforced by {@link HostStorage}. */
export interface StorageQuotas {
  /** Largest single value, in bytes. */
  maxValueBytes: number;
  /**
   * Total bytes one module may hold in one scope (sum over its entries of
   * value bytes + UTF-8 key bytes). In the shared `app`/`cloud` scopes an
   * entry is charged to the module that last wrote it.
   */
  maxBytesPerModulePerScope: number;
}

/** Defaults mirroring the native hosts: 1 MiB per value, 5 MiB per module per scope. */
export const DEFAULT_STORAGE_QUOTAS: Readonly<StorageQuotas> = Object.freeze({
  maxValueBytes: 1024 * 1024,
  maxBytesPerModulePerScope: 5 * 1024 * 1024,
});

/** `info(key)` result: the WIT `entry-info` record. */
export interface BucketEntryInfo {
  size: bigint;
  /** Wall-clock time of the last write, ms since the unix epoch. */
  modifiedMs: bigint;
  /** Monotonic per-key version on `cloud`; `undefined` on `local`/`app`. */
  version: bigint | undefined;
}

/** Identifies one bucket: scope + owning module (local only) + tier + namespace. */
export interface BucketRef {
  scope: StorageScope;
  /** Registered module name for `local`; `""` for the shared scopes. */
  owner: string;
  tier: string;
  namespace: string;
}

interface EntryMeta {
  /** charged bytes (value + key) */
  s: number;
  /** modified ms */
  t: number;
  /** cloud version */
  v?: number;
  /** writer module (quota attribution) */
  o: string;
}

const utf8 = new TextEncoder();
const utf8d = new TextDecoder();

// Length-prefixed component: `<len>:<text>`. Concatenating these is
// unambiguous whatever characters the components contain (no escaping
// needed, `/` and `:` in namespaces or keys cannot collide).
const part = (s: string): string => `${s.length}:${s}`;

function bucketPrefix(b: BucketRef): string {
  return part(b.scope) + part(b.owner) + part(b.tier) + part(b.namespace);
}

/** Parse the trailing `<len>:<key>` component; undefined if malformed. */
function parseLastPart(rest: string): string | undefined {
  const colon = rest.indexOf(":");
  if (colon <= 0) return undefined;
  const len = Number(rest.slice(0, colon));
  const key = rest.slice(colon + 1);
  return Number.isInteger(len) && key.length === len ? key : undefined;
}

const DATA = "d";
const META = "m";

function backendError(e: unknown): StorageError {
  if (isStorageError(e)) return e;
  const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return { tag: "backend", val: msg };
}

function isStorageError(e: unknown): e is StorageError {
  return (
    typeof e === "object" &&
    e !== null &&
    typeof (e as { tag?: unknown }).tag === "string" &&
    ["not-found", "quota-exceeded", "unavailable", "corrupted", "backend"].includes(
      (e as { tag: string }).tag,
    )
  );
}

/** Run `fn`, rethrowing any backend failure as a WIT storage error. */
function guarded<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    throw backendError(e);
  }
}

export interface HostStorageOptions {
  /** Backend for the `local` and `app` scopes. Default: {@link defaultStorageBackend}. */
  storage?: StorageBackend;
  /**
   * Backend for the `cloud` scope. Default: a fresh {@link MemoryStorageBackend}
   * (cloud data lasts as long as the host). Nothing is synced either way.
   */
  cloudStorage?: StorageBackend;
  /** Override individual quotas; unspecified ones use {@link DEFAULT_STORAGE_QUOTAS}. */
  quotas?: Partial<StorageQuotas>;
  /** Clock for `entry-info.modified-ms`. Default `Date.now`. */
  now?: () => number;
}

/**
 * Per-host storage policy over the injected backends. All methods are
 * synchronous and throw {@link StorageError} values on failure.
 */
export class HostStorage {
  readonly plain: StorageBackend;
  readonly cloud: StorageBackend;
  readonly quotas: Readonly<StorageQuotas>;
  readonly #now: () => number;

  constructor(options: HostStorageOptions = {}) {
    this.plain = options.storage ?? defaultStorageBackend();
    this.cloud = options.cloudStorage ?? new MemoryStorageBackend();
    this.quotas = Object.freeze({ ...DEFAULT_STORAGE_QUOTAS, ...(options.quotas ?? {}) });
    this.#now = options.now ?? Date.now;
  }

  #backend(scope: StorageScope): StorageBackend {
    return scope === "cloud" ? this.cloud : this.plain;
  }

  #readMeta(be: StorageBackend, metaKey: string): EntryMeta | undefined {
    const raw = be.get(metaKey);
    if (raw === undefined) return undefined;
    try {
      const m = JSON.parse(utf8d.decode(raw)) as EntryMeta;
      if (typeof m.s === "number" && typeof m.t === "number") return m;
    } catch {
      // fall through
    }
    return undefined;
  }

  /** Bytes `module` is currently charged for in `scope`. */
  usage(scope: StorageScope, module: string): number {
    const be = this.#backend(scope);
    const scopePrefix = META + part(scope);
    let total = 0;
    return guarded(() => {
      for (const k of be.keys()) {
        if (!k.startsWith(scopePrefix)) continue;
        const m = this.#readMeta(be, k);
        if (m && m.o === module) total += m.s;
      }
      return total;
    });
  }

  get(b: BucketRef, key: string): Uint8Array | undefined {
    const be = this.#backend(b.scope);
    return guarded(() => be.get(DATA + bucketPrefix(b) + part(key)));
  }

  info(b: BucketRef, key: string): BucketEntryInfo | undefined {
    const be = this.#backend(b.scope);
    const tail = bucketPrefix(b) + part(key);
    return guarded(() => {
      const value = be.get(DATA + tail);
      if (value === undefined) return undefined;
      const meta = this.#readMeta(be, META + tail);
      return {
        size: BigInt(value.byteLength),
        modifiedMs: BigInt(Math.floor(meta?.t ?? 0)),
        version: b.scope === "cloud" ? BigInt(meta?.v ?? 1) : undefined,
      };
    });
  }

  /** Throws `quota-exceeded` if `writer` storing `value` at `key` would break a quota. */
  #checkQuota(b: BucketRef, key: string, value: Uint8Array, writer: string, prev?: EntryMeta): number {
    const charged = value.byteLength + utf8.encode(key).byteLength;
    if (value.byteLength > this.quotas.maxValueBytes) {
      throw {
        tag: "quota-exceeded",
        val: BigInt(value.byteLength - this.quotas.maxValueBytes),
      } satisfies StorageError;
    }
    const current = this.usage(b.scope, writer);
    const reclaimed = prev && prev.o === writer ? prev.s : 0;
    const next = current - reclaimed + charged;
    if (next > this.quotas.maxBytesPerModulePerScope) {
      throw {
        tag: "quota-exceeded",
        val: BigInt(next - this.quotas.maxBytesPerModulePerScope),
      } satisfies StorageError;
    }
    return charged;
  }

  #write(b: BucketRef, key: string, value: Uint8Array, writer: string, version?: number): void {
    const be = this.#backend(b.scope);
    const tail = bucketPrefix(b) + part(key);
    const prevMeta = guarded(() => this.#readMeta(be, META + tail));
    const charged = this.#checkQuota(b, key, value, writer, prevMeta);
    const meta: EntryMeta = { s: charged, t: this.#now(), o: writer };
    if (version !== undefined) meta.v = version;
    const prevValue = guarded(() => be.get(DATA + tail));
    guarded(() => be.set(DATA + tail, value));
    try {
      be.set(META + tail, utf8.encode(JSON.stringify(meta)));
    } catch (e) {
      // Roll the value back so data and metadata stay consistent.
      try {
        if (prevValue === undefined) be.delete(DATA + tail);
        else be.set(DATA + tail, prevValue);
      } catch {
        // best effort
      }
      throw backendError(e);
    }
  }

  set(b: BucketRef, key: string, value: Uint8Array, writer: string): void {
    if (b.scope === "cloud") {
      const be = this.cloud;
      const tail = bucketPrefix(b) + part(key);
      const exists = guarded(() => be.get(DATA + tail)) !== undefined;
      const prev = exists ? guarded(() => this.#readMeta(be, META + tail)) : undefined;
      const nextVersion = exists ? (prev?.v ?? 1) + 1 : 1;
      this.#write(b, key, value, writer, nextVersion);
      return;
    }
    this.#write(b, key, value, writer);
  }

  /**
   * WIT `compare-and-set` (cloud only): `expected === undefined` means "the
   * key must not exist"; otherwise the current version must equal
   * `expected`. Returns the new version (previous + 1, or 1 for a new key);
   * on mismatch throws `unavailable("version mismatch")`.
   */
  compareAndSet(
    b: BucketRef,
    key: string,
    expected: bigint | undefined,
    value: Uint8Array,
    writer: string,
  ): bigint {
    const be = this.#backend(b.scope);
    const tail = bucketPrefix(b) + part(key);
    const exists = guarded(() => be.get(DATA + tail)) !== undefined;
    const current = exists
      ? BigInt(guarded(() => this.#readMeta(be, META + tail))?.v ?? 1)
      : undefined;
    const matches = expected === undefined ? current === undefined : current === expected;
    if (!matches) {
      throw { tag: "unavailable", val: "version mismatch" } satisfies StorageError;
    }
    const next = (current ?? 0n) + 1n;
    this.#write(b, key, value, writer, Number(next));
    return next;
  }

  delete(b: BucketRef, key: string): boolean {
    const be = this.#backend(b.scope);
    const tail = bucketPrefix(b) + part(key);
    return guarded(() => {
      const existed = be.delete(DATA + tail);
      be.delete(META + tail);
      return existed;
    });
  }

  keys(b: BucketRef, prefix: string, limit: number): string[] {
    if (limit <= 0) return [];
    const be = this.#backend(b.scope);
    const head = DATA + bucketPrefix(b);
    const out: string[] = [];
    guarded(() => {
      for (const k of be.keys()) {
        if (!k.startsWith(head)) continue;
        const key = parseLastPart(k.slice(head.length));
        if (key !== undefined && key.startsWith(prefix)) out.push(key);
      }
    });
    out.sort();
    return out.slice(0, limit);
  }

  clear(b: BucketRef): void {
    const be = this.#backend(b.scope);
    const head = bucketPrefix(b);
    guarded(() => {
      for (const k of Array.from(be.keys())) {
        if (k.startsWith(DATA + head) || k.startsWith(META + head)) {
          // Only exact bucket members (the remainder is one key component).
          const rest = k.slice(1 + head.length);
          if (parseLastPart(rest) !== undefined) be.delete(k);
        }
      }
    });
  }

  /**
   * Dev affordance: every stored entry, values decoded as UTF-8, keyed
   * `scope/owner/tier/namespace/key` for readability (this display form is
   * NOT the storage key and is ambiguous by design — inspection only).
   */
  dump(): Record<string, { value: string; version?: number; writer: string }> {
    const out: Record<string, { value: string; version?: number; writer: string }> = {};
    for (const be of new Set([this.plain, this.cloud])) {
      for (const k of be.keys()) {
        if (!k.startsWith(DATA)) continue;
        const parts = splitParts(k.slice(1));
        if (!parts || parts.length !== 5) continue;
        const value = be.get(k);
        if (value === undefined) continue;
        const meta = this.#readMeta(be, META + k.slice(1));
        const entry: { value: string; version?: number; writer: string } = {
          value: utf8d.decode(value),
          writer: meta?.o ?? "",
        };
        if (meta?.v !== undefined) entry.version = meta.v;
        out[parts.join("/")] = entry;
      }
    }
    return out;
  }
}

function splitParts(s: string): string[] | undefined {
  const parts: string[] = [];
  let i = 0;
  while (i < s.length) {
    const colon = s.indexOf(":", i);
    if (colon <= i) return undefined;
    const len = Number(s.slice(i, colon));
    if (!Number.isInteger(len) || colon + 1 + len > s.length) return undefined;
    parts.push(s.slice(colon + 1, colon + 1 + len));
    i = colon + 1 + len;
  }
  return parts;
}

// ----------------------------------------------------------------------------
// jco import objects
// ----------------------------------------------------------------------------

const BLOB_UNIMPLEMENTED: StorageError = {
  tag: "unavailable",
  val: "blob storage is not implemented by this host",
};

/** Blob resources are not implemented (native parity): every entry point fails. */
function blobClasses() {
  class BlobHandle {
    size(): bigint {
      return 0n;
    }
    read(_offset: bigint, _len: number): Uint8Array {
      throw BLOB_UNIMPLEMENTED;
    }
  }
  class BlobWriter {
    write(_chunk: Uint8Array): void {
      throw BLOB_UNIMPLEMENTED;
    }
    finish(): BucketEntryInfo {
      throw BLOB_UNIMPLEMENTED;
    }
    abort(): void {}
  }
  class BlobBucket {
    static open(_tier: string, _namespace: string): BlobBucket {
      throw BLOB_UNIMPLEMENTED;
    }
    get(_key: string): BlobHandle | undefined {
      return undefined;
    }
    put(_key: string): BlobWriter {
      throw BLOB_UNIMPLEMENTED;
    }
    delete(_key: string): boolean {
      return false;
    }
    keys(_prefix: string, _limit: number): string[] {
      return [];
    }
  }
  return { BlobBucket, BlobHandle, BlobWriter };
}

/** jco-shaped `bucket` resource for `local` / `app`. */
export interface KvBucket {
  get(key: string): Uint8Array | undefined;
  set(key: string, value: Uint8Array): void;
  delete(key: string): boolean;
  keys(prefix: string, limit: number): string[];
  info(key: string): BucketEntryInfo | undefined;
  clear(): void;
}

/**
 * jco-shaped `bucket` resource for `cloud`: no `clear` (per the WIT), plus
 * `compareAndSet`.
 *
 * In-memory stand-in: this package does NOT sync anything across devices.
 * Data lives in the host's `cloudStorage` backend (default: in-memory, gone
 * when the host is dropped or the page reloads). Versions are real and
 * monotonic per key, `modifiedMs` is the local write time, and
 * compare-and-set follows the WIT exactly — so module logic written against
 * it behaves the same when a real sync backend is plugged in later.
 */
export interface CloudBucket {
  get(key: string): Uint8Array | undefined;
  set(key: string, value: Uint8Array): void;
  delete(key: string): boolean;
  keys(prefix: string, limit: number): string[];
  info(key: string): BucketEntryInfo | undefined;
  compareAndSet(key: string, expectedVersion: bigint | undefined, value: Uint8Array): bigint;
}

/** Class shape jco expects for a `bucket` resource import. */
export interface BucketClass<B> {
  /** Instances are only created through `open` (jco checks `instanceof`). */
  readonly prototype: B;
  open(tier: string, namespace: string): B;
}

/** The import objects for one module, keyed by WIT interface. */
export interface StorageImports {
  local: { Bucket: BucketClass<KvBucket> } & ReturnType<typeof blobClasses>;
  app: { Bucket: BucketClass<KvBucket> } & ReturnType<typeof blobClasses>;
  cloud: { Bucket: BucketClass<CloudBucket> } & ReturnType<typeof blobClasses>;
}

function kvBucketClass(storage: HostStorage, module: string, scope: "local" | "app") {
  // Fresh class per (module, scope): jco checks `instanceof` against the
  // exact class it was handed, and the module identity is captured here —
  // the guest only ever supplies tier + namespace.
  const owner = scope === "local" ? module : "";
  return class Bucket implements KvBucket {
    readonly #ref: BucketRef;
    private constructor(tier: string, namespace: string) {
      this.#ref = { scope, owner, tier: String(tier), namespace: String(namespace) };
    }
    static open(tier: string, namespace: string): Bucket {
      return new Bucket(tier, namespace);
    }
    get(key: string) {
      return storage.get(this.#ref, key);
    }
    set(key: string, value: Uint8Array) {
      storage.set(this.#ref, key, value, module);
    }
    delete(key: string) {
      return storage.delete(this.#ref, key);
    }
    keys(prefix: string, limit: number) {
      return storage.keys(this.#ref, prefix, limit);
    }
    info(key: string) {
      return storage.info(this.#ref, key);
    }
    clear() {
      storage.clear(this.#ref);
    }
  };
}

function cloudBucketClass(storage: HostStorage, module: string) {
  return class Bucket implements CloudBucket {
    readonly #ref: BucketRef;
    private constructor(tier: string, namespace: string) {
      this.#ref = { scope: "cloud", owner: "", tier: String(tier), namespace: String(namespace) };
    }
    static open(tier: string, namespace: string): Bucket {
      return new Bucket(tier, namespace);
    }
    get(key: string) {
      return storage.get(this.#ref, key);
    }
    set(key: string, value: Uint8Array) {
      storage.set(this.#ref, key, value, module);
    }
    delete(key: string) {
      return storage.delete(this.#ref, key);
    }
    keys(prefix: string, limit: number) {
      return storage.keys(this.#ref, prefix, limit);
    }
    info(key: string) {
      return storage.info(this.#ref, key);
    }
    compareAndSet(key: string, expectedVersion: bigint | undefined, value: Uint8Array) {
      return storage.compareAndSet(this.#ref, key, expectedVersion, value, module);
    }
  };
}

/**
 * Build the `hypen:storage/{local,app,cloud}` import objects for `module`.
 * Whether `app`/`cloud` are actually linked is decided by
 * {@link buildImportMap} from the manifest; this only constructs them.
 */
export function createStorageImports(storage: HostStorage, module: string): StorageImports {
  return {
    local: { Bucket: kvBucketClass(storage, module, "local"), ...blobClasses() },
    app: { Bucket: kvBucketClass(storage, module, "app"), ...blobClasses() },
    cloud: { Bucket: cloudBucketClass(storage, module), ...blobClasses() },
  };
}
