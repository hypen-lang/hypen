/**
 * Two-way bind echo reconciliation for text fields (Input / Textarea, DOM
 * and canvas).
 *
 * `.bind(@state.x)` is a round trip: every keystroke sends a
 * `__hypen_bind` write with the field's current value, the module state
 * changes, and the engine answers with `SetProp(value)` carrying that state.
 * When the engine is remote (or simply slower than the typist) several
 * writes are in flight at once, so the echo for keystroke N lands after the
 * user has already typed N+1, N+2… Writing that echo into the field
 * replaced the newer text with an older snapshot (and collapsed the caret),
 * so the next keystroke was appended to the stale value — "Buy milk" became
 * "Bumilk".
 *
 * The fix is sequence-based, not timing-based: each local write is recorded
 * in order as an outstanding (unacknowledged) value. An incoming value is
 * then classified:
 *
 * - **stale echo** — it matches an outstanding write that is NOT the newest:
 *   the engine is acknowledging an older keystroke. Everything up to and
 *   including it is acknowledged; the field is left alone because it already
 *   holds newer text.
 * - **latest echo** — it matches the newest outstanding write: the engine has
 *   caught up. Acknowledge all; the caller writes only if the field somehow
 *   differs (never touching it in the normal case keeps the caret put).
 * - **foreign** — it matches nothing outstanding: a genuine programmatic
 *   change (an action cleared the draft, engine-side formatting). It is
 *   applied, and the outstanding list is dropped, since the server state has
 *   diverged from those writes. Any write the user made after it is still
 *   ordered after it on the wire, so its echo re-asserts it.
 *
 * Writes and echoes travel over ordered channels (in-process dispatch, a
 * single WebSocket), so matching the OLDEST equal entry is correct even when
 * the same text repeats (type "a", delete, type "a").
 */

/** Upper bound on remembered unacknowledged writes per field. */
const MAX_OUTSTANDING = 256;

const outstanding = new WeakMap<object, string[]>();

export type BindEchoKind = "stale" | "latest" | "foreign";

function norm(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

/** Record a local `__hypen_bind` write of `value` for `key` (element/node). */
export function noteLocalBindWrite(key: object, value: unknown): void {
  let list = outstanding.get(key);
  if (!list) {
    list = [];
    outstanding.set(key, list);
  }
  const v = norm(value);
  // Repeated identical writes (e.g. compositionend after input) add nothing.
  if (list[list.length - 1] === v) return;
  list.push(v);
  if (list.length > MAX_OUTSTANDING) list.splice(0, list.length - MAX_OUTSTANDING);
}

/**
 * Classify an engine-supplied value for `key` and advance the outstanding
 * write sequence accordingly. See the module comment for the three kinds.
 */
export function classifyBindEcho(key: object, value: unknown): BindEchoKind {
  const list = outstanding.get(key);
  if (!list || list.length === 0) return "foreign";
  const idx = list.indexOf(norm(value));
  if (idx === -1) {
    outstanding.delete(key);
    return "foreign";
  }
  list.splice(0, idx + 1);
  if (list.length === 0) {
    outstanding.delete(key);
    return "latest";
  }
  return "stale";
}

/** Whether `key` has local writes the engine has not acknowledged yet. */
export function hasOutstandingBindWrites(key: object): boolean {
  return (outstanding.get(key)?.length ?? 0) > 0;
}

/** Forget every outstanding write for `key` (teardown). */
export function clearBindEcho(key: object): void {
  outstanding.delete(key);
}
