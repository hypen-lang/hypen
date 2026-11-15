// Browser-side half of the real-browser harness (tests/browser/run.ts).
//
// Bundled with Bun.build (target: browser) against the BUILT package
// (`dist/`), exactly as a consumer's bundler would see it, and driven from
// Playwright through `window.hx`. Everything returned from here must be
// structured-cloneable (no Uint8Array state, no bigint).

import {
  JsModuleHost,
  LocalStorageBackend,
  MemoryStorageBackend,
  createStorageImports,
  type ModuleManifest,
  type StorageQuotaOptions,
  type PrepareInfo,
} from "../../dist/index.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

const hosts = new Map<string, JsModuleHost>();
const fixtures = new Map<string, Uint8Array>();

function host(id: string): JsModuleHost {
  const h = hosts.get(id);
  if (!h) throw new Error(`no host '${id}'`);
  return h;
}

async function fixture(file: string): Promise<Uint8Array> {
  let bytes = fixtures.get(file);
  if (!bytes) {
    const res = await fetch(`/fixtures/${file}`);
    if (!res.ok) throw new Error(`fixture ${file}: HTTP ${res.status}`);
    bytes = new Uint8Array(await res.arrayBuffer());
    fixtures.set(file, bytes);
  }
  return bytes;
}

interface Step {
  action: string;
  payload?: unknown;
}

const api = {
  /** A fresh host; `default` storage = the package default (localStorage in a page). */
  newHost(id: string, storage: "default" | "memory" = "default", quotas?: StorageQuotaOptions): string {
    const h = new JsModuleHost({
      ...(storage === "memory" ? { storage: new MemoryStorageBackend() } : {}),
      ...(quotas ? { quotas } : {}),
      onPrepare: (info) => lastPrepare.set(`${id}/${info.module}`, info),
    });
    hosts.set(id, h);
    // (constructor.name does not survive minification)
    const plain = h.storage.plain;
    return plain instanceof LocalStorageBackend
      ? "LocalStorageBackend"
      : plain instanceof MemoryStorageBackend
        ? "MemoryStorageBackend"
        : "other";
  },

  /** `await prepare()`; never throws — returns the error message instead. */
  async prepare(
    hostId: string,
    name: string,
    file: string,
    manifest: ModuleManifest,
  ): Promise<{ ok: true; info: PrepareInfo; wallMs: number } | { ok: false; error: string; wallMs: number }> {
    const bytes = await fixture(file);
    const t = performance.now();
    try {
      await host(hostId).prepare(name, bytes, manifest);
      return { ok: true, info: lastPrepare.get(`${hostId}/${name}`)!, wallMs: performance.now() - t };
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message ?? e), wallMs: performance.now() - t };
    }
  },

  /** instantiate + init + dispatch each step, synchronously (the BridgedHost contract). */
  run(hostId: string, name: string, steps: Step[]) {
    const h = host(hostId);
    const id = h.instantiate(name);
    let state = h.init(id, enc.encode("{}"));
    const states = [dec.decode(state)];
    const effects: unknown[] = [];
    for (const step of steps) {
      const out = h.dispatch(
        id,
        state,
        { name: step.action, payload: enc.encode(JSON.stringify(step.payload ?? {})) },
        [],
      );
      if (out.state) state = out.state;
      states.push(dec.decode(state));
      effects.push(...out.effects);
    }
    return { actions: h.actions(id), states, effects };
  },

  dump(hostId: string) {
    return host(hostId).storage.dump();
  },

  /**
   * Try to read every `local` entry `owner` wrote, as module `spy` (through
   * spy's own storage imports, the only door a module has): returns what
   * spy could see.
   */
  spyOnLocal(hostId: string, owner: string, spy: string): { tried: number; leaked: string[] } {
    const h = host(hostId);
    const spyLocal = createStorageImports(h.storage, spy).local;
    const leaked: string[] = [];
    let tried = 0;
    for (const path of Object.keys(h.storage.dump())) {
      const [scope, mod, tier, ns, ...rest] = path.split("/");
      if (scope !== "local" || mod !== owner) continue;
      tried++;
      const bucket = spyLocal.Bucket.open(tier!, ns!);
      const key = rest.join("/");
      if (bucket.get(key) !== undefined || bucket.keys("", 100).length > 0) leaked.push(path);
    }
    return { tried, leaked };
  },

  /**
   * Write `chunk`-byte values into module `filler`'s local bucket until a
   * write fails; report how many value bytes landed and the error.
   */
  fill(hostId: string, chunk: number): { valueBytes: number; error: unknown; localStorageChars: number } {
    const bucket = createStorageImports(host(hostId).storage, "filler").local.Bucket.open("persistent", "fill");
    const value = new Uint8Array(chunk).fill(120);
    let valueBytes = 0;
    let error: unknown = null;
    for (let i = 0; i < 10_000; i++) {
      try {
        bucket.set(`k${i}`, value);
        valueBytes += chunk;
      } catch (e) {
        error = typeof (e as { val?: unknown })?.val === "bigint" ? { ...(e as object), val: String((e as { val: bigint }).val) } : e;
        break;
      }
    }
    let localStorageChars = 0;
    for (const k of Object.keys(localStorage)) localStorageChars += k.length + (localStorage.getItem(k)?.length ?? 0);
    bucket.clear();
    return { valueBytes, error, localStorageChars };
  },

  localStorageKeys(): string[] {
    return Object.keys(localStorage);
  },
};

const lastPrepare = new Map<string, PrepareInfo>();

(globalThis as unknown as { hx: typeof api }).hx = api;
(globalThis as unknown as { hxReady: boolean }).hxReady = true;
