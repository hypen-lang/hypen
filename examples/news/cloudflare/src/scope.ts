// Per-visitor scope for module handlers.
//
// Each visitor gets their own Durable Object (routed by the `hypen_news`
// cookie, see worker.ts), but Durable Objects of one class share a JS
// isolate, so a module-level "current storage" variable would be shared by
// every visitor's DO and race across `await`s. Instead the DO wraps each
// entry point in `visitorScope.run({ storage, hub }, …)`; handlers read it via
// AsyncLocalStorage, which follows their own async continuations (and the
// timers they start), so a handler always talks to ITS visitor's storage.
//
// The library — saved stories and read history — lives in that storage.

import { AsyncLocalStorage } from "node:async_hooks";
import type { HubStub } from "./hub";
import type { StoryLite } from "./upstream";

export interface VisitorStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export interface VisitorScope {
  storage: VisitorStorage;
  hub: HubStub;
}

export const visitorScope = new AsyncLocalStorage<VisitorScope>();

export function currentScope(): VisitorScope {
  const scope = visitorScope.getStore();
  // Never fall back to another visitor's DO — fail loudly instead.
  if (!scope) throw new Error("news: handler ran outside visitorScope.run");
  return scope;
}

export function hub(): HubStub {
  return currentScope().hub;
}

// ---------------------------------------------------------------------------
// Library: saved stories + read history
// ---------------------------------------------------------------------------

export interface SavedStory extends StoryLite {
  savedAt: number;
}

const SAVED_KEY = "news:saved";
const READ_KEY = "news:read";
const MAX_READ = 1000;
const MAX_SAVED = 300;

export interface Library {
  saved: SavedStory[];
  savedIds: Set<number>;
  readIds: Set<number>;
}

export async function loadLibrary(scope: VisitorScope = currentScope()): Promise<Library> {
  const [saved, read] = await Promise.all([
    scope.storage.get<SavedStory[]>(SAVED_KEY),
    scope.storage.get<number[]>(READ_KEY),
  ]);
  const list = saved ?? [];
  return { saved: list, savedIds: new Set(list.map((s) => s.id)), readIds: new Set(read ?? []) };
}

export async function markRead(id: number, scope: VisitorScope = currentScope()): Promise<void> {
  const read = (await scope.storage.get<number[]>(READ_KEY)) ?? [];
  if (read[read.length - 1] === id) return;
  const next = read.filter((r) => r !== id);
  next.push(id);
  await scope.storage.put(READ_KEY, next.slice(-MAX_READ));
}

export async function clearRead(scope: VisitorScope = currentScope()): Promise<void> {
  await scope.storage.delete(READ_KEY);
}

/** Toggle a story's saved flag; returns the new value. */
export async function toggleSaved(story: StoryLite, scope: VisitorScope = currentScope()): Promise<boolean> {
  const saved = (await scope.storage.get<SavedStory[]>(SAVED_KEY)) ?? [];
  const exists = saved.some((s) => s.id === story.id);
  const next = exists
    ? saved.filter((s) => s.id !== story.id)
    : [{ ...story, savedAt: Date.now() }, ...saved].slice(0, MAX_SAVED);
  await scope.storage.put(SAVED_KEY, next);
  return !exists;
}

/** Refresh the stored snapshot (score/comments) of saved stories we just saw. */
export async function refreshSaved(fresh: StoryLite[], scope: VisitorScope = currentScope()): Promise<void> {
  const saved = (await scope.storage.get<SavedStory[]>(SAVED_KEY)) ?? [];
  if (saved.length === 0) return;
  const byId = new Map(fresh.map((s) => [s.id, s]));
  let changed = false;
  const next = saved.map((s) => {
    const f = byId.get(s.id);
    if (!f || (f.score === s.score && f.comments === s.comments)) return s;
    changed = true;
    return { ...s, score: f.score, comments: f.comments };
  });
  if (changed) await scope.storage.put(SAVED_KEY, next);
}
