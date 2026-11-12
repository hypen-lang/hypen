// Story actions shared by every screen that shows story rows.

import type { GlobalContext } from "@hypen-space/core";
import { currentScope, markRead, toggleSaved, visitorScope, type VisitorScope } from "./scope";
import type { StoryRow } from "./stories";
import { toStoryLite } from "./upstream";

/** Mark read (persisted), dim the row now, then navigate to the thread. */
export async function openStory(rows: StoryRow[], id: string | undefined, context: GlobalContext | undefined) {
  const n = Number(id);
  if (!Number.isFinite(n) || n <= 0) return;
  const row = rows.find((r) => r.id === id);
  if (row && !row.read) row.read = true;
  context?.router?.push(`/story/${n}`);
  await markRead(n);
}

/** Toggle the bookmark; reflects the new flag into every list passed in. */
export async function toggleSave(lists: StoryRow[][], id: string | undefined): Promise<boolean | null> {
  const n = Number(id);
  if (!Number.isFinite(n) || n <= 0) return null;
  const scope = currentScope();
  const item = await scope.hub.story(n);
  if (!item) return null;
  const saved = await toggleSaved(toStoryLite(item), scope);
  for (const rows of lists) for (const r of rows) if (r.id === String(n) && r.saved !== saved) r.saved = saved;
  return saved;
}

// ---------------------------------------------------------------------------
// Per-module-instance timers (live polling)
// ---------------------------------------------------------------------------

const timers = new WeakMap<object, ReturnType<typeof setInterval>>();

/**
 * Run `tick` every `ms` while the module is on screen. The visitor scope is
 * captured now and re-entered on each tick, so a timer never touches another
 * visitor's storage. Errors are logged, never thrown into the runtime.
 */
export function startPolling(state: object, ms: number, tick: () => Promise<void>): void {
  stopPolling(state);
  const scope: VisitorScope = currentScope();
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void visitorScope
      .run(scope, tick)
      .catch((err) => console.warn("news: poll failed:", err instanceof Error ? err.message : err))
      .finally(() => {
        busy = false;
      });
  }, ms);
  timers.set(state, timer);
}

export function stopPolling(state: object): void {
  const timer = timers.get(state);
  if (timer !== undefined) clearInterval(timer);
  timers.delete(state);
}
