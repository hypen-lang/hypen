/**
 * Echo reconciliation for engine-driven text fields (Input / Textarea, DOM
 * and canvas): `.bind(@state.x)` and hand-wired controlled fields
 * (`Input(value: "@{state.x}").onInput(@actions.setX)`, `.onChange`).
 *
 * Both are a round trip: every keystroke sends a write carrying the field's
 * current value (a `__hypen_bind` write, or the handler's action), the module
 * state changes, and the engine answers with `SetProp(value)` carrying that
 * state. When the engine is remote (or simply slower than the typist) several
 * writes are in flight at once, so the answer for keystroke N lands after the
 * user has already typed N+1, N+2… Writing that answer into the field
 * replaced the newer text with an older snapshot (and collapsed the caret),
 * so the next keystroke was appended to the stale value — "Buy milk" became
 * "Bumilk".
 *
 * The fix is sequence-based: each local write is recorded in order as an
 * outstanding (unanswered) value. An incoming value is then classified:
 *
 * - **stale** — it equals an outstanding write that is NOT the newest: the
 *   engine is answering an older keystroke. Everything up to and including
 *   it is answered; the field is left alone because it already holds newer
 *   text.
 * - **latest** — it equals the newest outstanding write: the engine has
 *   caught up. Answer all; the caller writes only if the field somehow
 *   differs (never touching it in the normal case keeps the caret put).
 * - **foreign** — it equals no outstanding write and every outstanding write
 *   has had an answer: a genuine programmatic change (an action cleared the
 *   draft) or the handler's rewrite of the newest write (an `.onInput` that
 *   uppercases, engine-side formatting). It is applied and the outstanding
 *   list dropped, since the server state has diverged from those writes.
 * - **deferred** — it equals no outstanding write while NEWER writes still
 *   await an answer: most likely a handler's rewrite of an OLDER keystroke
 *   ("A" answering "a" while "ab", "abc" are in flight). Applying it would
 *   wipe the newer text exactly like a stale echo, so it is held back; a
 *   later answer supersedes it. A write can go unanswered (a handler that
 *   strips digits leaves state unchanged when a digit is typed, so no
 *   SetProp follows), which would hold the value forever — so a deferred
 *   value is applied anyway once the field has been quiet (no write, no
 *   answer) for {@link DEFERRED_ECHO_SETTLE_MS}.
 *
 * Writes and answers travel over ordered channels (in-process dispatch, a
 * single WebSocket), so matching the OLDEST equal entry is correct even when
 * the same text repeats (type "a", delete, type "a"). The protocol carries no
 * per-action acknowledgement, so "which write does a rewritten value answer"
 * is inferred by counting answers — one per state-changing write.
 */

/** Upper bound on remembered unanswered writes per field. */
const MAX_OUTSTANDING = 256;

/**
 * Quiet period after which a deferred (unmatched) answer is applied even
 * though writes are still outstanding — the fallback for writes that never
 * get an answer.
 */
export const DEFERRED_ECHO_SETTLE_MS = 300;

interface FieldEcho {
  /** Unanswered local writes, oldest first. */
  writes: string[];
  /** Unmatched answers received since the last exact match. */
  unmatched: number;
  /** Held-back unmatched answer and how to apply it. */
  deferred: { value: unknown; apply: (value: unknown) => void } | null;
  timer: ReturnType<typeof setTimeout> | null;
}

const fields = new WeakMap<object, FieldEcho>();

/** Fields whose `value` the engine supplies (controlled fields). */
const engineValued = new WeakSet<object>();

export type BindEchoKind = "stale" | "latest" | "foreign" | "deferred";

function norm(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function drop(key: object): void {
  const field = fields.get(key);
  if (field?.timer) clearTimeout(field.timer);
  fields.delete(key);
}

/** (Re)start the quiet-period timer that flushes a deferred answer. */
function armSettle(key: object, field: FieldEcho): void {
  if (field.timer) clearTimeout(field.timer);
  field.timer = null;
  if (!field.deferred) return;
  field.timer = setTimeout(() => {
    if (fields.get(key) !== field) return;
    const deferred = field.deferred;
    drop(key);
    // Re-entered as a foreign value: nothing is outstanding any more.
    if (deferred) deferred.apply(deferred.value);
  }, DEFERRED_ECHO_SETTLE_MS);
}

/** Record a local write of `value` for `key` (element/node). */
export function noteLocalBindWrite(key: object, value: unknown): void {
  let field = fields.get(key);
  if (!field) {
    field = { writes: [], unmatched: 0, deferred: null, timer: null };
    fields.set(key, field);
  }
  const v = norm(value);
  // Repeated identical writes (e.g. compositionend after input, `.bind` and
  // `.onInput` on one field) add nothing: the second leaves state unchanged,
  // so it gets no answer of its own.
  if (field.writes[field.writes.length - 1] === v) return;
  field.writes.push(v);
  if (field.writes.length > MAX_OUTSTANDING) {
    field.writes.splice(0, field.writes.length - MAX_OUTSTANDING);
  }
  // The user is still typing: a held-back answer stays held.
  armSettle(key, field);
}

/**
 * Classify an engine-supplied value for `key` and advance the outstanding
 * write sequence accordingly. See the module comment for the kinds.
 *
 * `applyDeferred` is how a held-back value is applied later (it is re-run
 * through the caller's normal path, where it classifies as foreign). Without
 * it nothing is ever deferred: an unmatched value is foreign.
 */
export function classifyBindEcho(
  key: object,
  value: unknown,
  applyDeferred?: (value: unknown) => void,
): BindEchoKind {
  const field = fields.get(key);
  if (!field || field.writes.length === 0) {
    drop(key);
    return "foreign";
  }
  const idx = field.writes.indexOf(norm(value));
  if (idx !== -1) {
    // An exact answer supersedes anything held back before it.
    field.writes.splice(0, idx + 1);
    field.unmatched = 0;
    field.deferred = null;
    if (field.writes.length === 0) {
      drop(key);
      return "latest";
    }
    armSettle(key, field);
    return "stale";
  }
  field.unmatched += 1;
  if (!applyDeferred || field.unmatched >= field.writes.length) {
    drop(key);
    return "foreign";
  }
  field.deferred = { value, apply: applyDeferred };
  armSettle(key, field);
  return "deferred";
}

/** Whether `key` has local writes the engine has not answered yet. */
export function hasOutstandingBindWrites(key: object): boolean {
  return (fields.get(key)?.writes.length ?? 0) > 0;
}

/** Forget every outstanding write for `key` (teardown). */
export function clearBindEcho(key: object): void {
  drop(key);
}

/**
 * Mark `key` as a controlled field: the engine supplies its `value` prop
 * (`Input(value: "@{state.x}")`). Only such fields record the values their
 * `.onInput` / `.onChange` handlers send — an uncontrolled field never gets a
 * value answer, so there is nothing to reconcile.
 */
export function noteEngineValuedField(key: object): void {
  engineValued.add(key);
}

/** Whether the engine supplies `key`'s `value` (see {@link noteEngineValuedField}). */
export function isEngineValuedField(key: object): boolean {
  return engineValued.has(key);
}
