/**
 * Whose data a hosted module's `hypen:storage` reads and writes.
 *
 * `@hypen-space/module-host` partitions `local` storage by module name only.
 * On a server that is not enough: every user's sessions run the same module,
 * so one shared backend would hand user A's `local` data to user B. Here
 * every session's module host gets the backends of its **owner**:
 *
 * - by default the owner is the session — a private in-memory store that is
 *   gone when the server stops (safe by default, nothing shared);
 * - `storage: (session) => ({ key })` names the owner (a user id): sessions
 *   with the same key share one store — in memory, or one file per owner
 *   under `storageDir` so it survives restarts;
 * - `storage: (session) => backend` hands over an app-provided backend
 *   (anything with the synchronous `get` / `set` / `delete` / `keys`).
 *
 * `local` stays private to each module inside an owner's store; `app` is
 * shared by the modules of the same owner; nothing crosses owners unless
 * the app returns the same backend for both.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import type { Session } from "@hypen-space/core/remote";

/**
 * A synchronous key/value store of raw bytes — structurally the
 * `StorageBackend` of `@hypen-space/module-host` (its `MemoryStorageBackend`
 * and `LocalStorageBackend` are assignable). Synchronous because module
 * reducers are.
 */
export interface HostedStorageBackend {
  get(key: string): Uint8Array | undefined;
  set(key: string, value: Uint8Array): void;
  /** Returns whether the key existed. */
  delete(key: string): boolean;
  keys(): Iterable<string>;
}

/** The backends one owner's modules use. */
export interface HostedStorageBackends {
  /** Backs the `local` (per-module) and `app` (shared by the owner's modules) scopes. */
  storage: HostedStorageBackend;
  /** Backs the `cloud` scope. Default: an in-memory store per owner. */
  cloudStorage?: HostedStorageBackend;
}

/** What a `storage` resolver may return for a session. */
export type HostedStorageChoice =
  /** Use the server's own store for this owner key (memory, or a file under `storageDir`). */
  | { key: string }
  | HostedStorageBackends
  | HostedStorageBackend;

export type HostedStorageResolver = (session: Session) => HostedStorageChoice;

/** In-memory backend. */
export class MemoryHostedStorage implements HostedStorageBackend {
  private readonly data = new Map<string, Uint8Array>();
  get(key: string): Uint8Array | undefined {
    return this.data.get(key);
  }
  set(key: string, value: Uint8Array): void {
    this.data.set(key, value.slice());
  }
  delete(key: string): boolean {
    return this.data.delete(key);
  }
  keys(): Iterable<string> {
    return Array.from(this.data.keys());
  }
}

/**
 * A backend persisted to one JSON file (values base64-encoded), loaded when
 * constructed and rewritten atomically (write + rename) on every change.
 * Meant for small per-user module data — quotas cap a partition at 5 MiB by
 * default. One process per file: there is no cross-process locking.
 */
export class FileHostedStorage implements HostedStorageBackend {
  readonly path: string;
  private readonly data = new Map<string, Uint8Array>();

  constructor(path: string) {
    this.path = resolve(path);
    if (existsSync(this.path)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(this.path, "utf8"));
      } catch (cause) {
        throw new Error(
          `hosted-module storage file ${this.path} is not valid JSON; move it aside to start empty`,
          { cause }
        );
      }
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof value === "string") this.data.set(key, new Uint8Array(Buffer.from(value, "base64")));
        }
      }
    }
  }

  get(key: string): Uint8Array | undefined {
    return this.data.get(key);
  }
  set(key: string, value: Uint8Array): void {
    this.data.set(key, value.slice());
    this.flush();
  }
  delete(key: string): boolean {
    const existed = this.data.delete(key);
    if (existed) this.flush();
    return existed;
  }
  keys(): Iterable<string> {
    return Array.from(this.data.keys());
  }

  private flush(): void {
    const out: Record<string, string> = {};
    for (const [key, value] of this.data) out[key] = Buffer.from(value).toString("base64");
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(out));
    renameSync(tmp, this.path);
  }
}

function isBackend(value: unknown): value is HostedStorageBackend {
  const v = value as Partial<HostedStorageBackend> | null;
  return (
    v !== null &&
    typeof v === "object" &&
    typeof v.get === "function" &&
    typeof v.set === "function" &&
    typeof v.delete === "function" &&
    typeof v.keys === "function"
  );
}

/** How many session-owned in-memory stores are kept (least recently used dropped first). */
export const MAX_SESSION_STORES = 1024;

/**
 * Resolves each session to its owner's backends. Keyed stores are created
 * on first use and reused, so two sessions of one owner see the same data.
 */
export class HostedStorageOwners {
  private readonly resolver: HostedStorageResolver | undefined;
  private readonly storageDir: string | undefined;
  /** Stores for app-chosen keys: kept for the process lifetime (the app bounds its users). */
  private readonly keyed = new Map<string, Required<HostedStorageBackends>>();
  /** Stores for the default per-session owner: bounded LRU. */
  private readonly perSession = new Map<string, Required<HostedStorageBackends>>();

  constructor(options: { storage?: HostedStorageResolver; storageDir?: string } = {}) {
    this.resolver = options.storage;
    this.storageDir = options.storageDir !== undefined ? resolve(options.storageDir) : undefined;
  }

  /** The backends for `session`'s owner. Throws when the resolver returns something unusable. */
  for(session: Session): Required<HostedStorageBackends> {
    if (!this.resolver) return this.sessionStore(session.id);
    const choice = this.resolver(session);
    if (isBackend(choice)) return { storage: choice, cloudStorage: new MemoryHostedStorage() };
    if (choice !== null && typeof choice === "object") {
      if ("key" in choice) {
        if (typeof choice.key !== "string" || choice.key === "") {
          throw new TypeError(
            "hostedModules({ storage }) returned { key } that is not a non-empty string; " +
              "return the owner's id, or a backend"
          );
        }
        return this.keyedStore(choice.key);
      }
      if (isBackend(choice.storage)) {
        return {
          storage: choice.storage,
          cloudStorage: isBackend(choice.cloudStorage) ? choice.cloudStorage : new MemoryHostedStorage(),
        };
      }
    }
    throw new TypeError(
      "hostedModules({ storage }) must return { key: string }, a storage backend " +
        "(get/set/delete/keys), or { storage, cloudStorage? }"
    );
  }

  private sessionStore(sessionId: string): Required<HostedStorageBackends> {
    let store = this.perSession.get(sessionId);
    if (store) {
      // Touch: most recently used last.
      this.perSession.delete(sessionId);
    } else {
      store = { storage: new MemoryHostedStorage(), cloudStorage: new MemoryHostedStorage() };
    }
    this.perSession.set(sessionId, store);
    while (this.perSession.size > MAX_SESSION_STORES) {
      const oldest = this.perSession.keys().next().value;
      if (oldest === undefined) break;
      this.perSession.delete(oldest);
    }
    return store;
  }

  private keyedStore(key: string): Required<HostedStorageBackends> {
    let store = this.keyed.get(key);
    if (!store) {
      if (this.storageDir !== undefined) {
        // The key is app data (a user id, an email): never a path component.
        const stem = createHash("sha256").update(key).digest("hex").slice(0, 32);
        store = {
          storage: new FileHostedStorage(join(this.storageDir, `${stem}.json`)),
          cloudStorage: new FileHostedStorage(join(this.storageDir, `${stem}.cloud.json`)),
        };
      } else {
        store = { storage: new MemoryHostedStorage(), cloudStorage: new MemoryHostedStorage() };
      }
      this.keyed.set(key, store);
    }
    return store;
  }
}
