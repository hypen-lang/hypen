/**
 * JSON tree diff — TypeScript port of the engine's canonical
 * `hypen-engine-rs/src/portable/diff.rs`, run directly over live JS
 * values so the mutation hot path never serializes the state.
 *
 * ## Why a second implementation exists
 *
 * The portable seam deliberately had no TS fallback: every helper
 * routed through the Rust engine so five SDKs could not drift. For
 * `diffState` that routing costs Θ(|state|) *serialization* per
 * mutation flush — stringify the whole state twice, parse both strings
 * inside WASM, walk the tree, serialize the result — measured at
 * 70–90 µs per KB of state, dominating small interactions (a one-field
 * change on a 163 KB state paid ~17 ms of diff for a 5.7 ms engine
 * update). This port removes every serialization step; the walk itself
 * is the only remaining cost.
 *
 * Rust stays the single source of TRUTH, no longer the single point of
 * EXECUTION:
 *
 *  - the cross-SDK fixtures under
 *    `engine-compatibility-tests/fixtures/portable/diff/` pin this
 *    implementation byte-for-byte to `diff_paths` (the TS runner
 *    exercises both),
 *  - a differential fuzz suite (`hypen-web/tests/diff.fuzz.test.ts`)
 *    compares it against the WASM implementation on thousands of
 *    generated cases,
 *  - the install sites can cross-check every production diff against
 *    the WASM oracle when `HYPEN_DIFF_ORACLE` is enabled.
 *
 * ## Fidelity contract (matches the old stringify→WASM pipeline)
 *
 * The old pipeline saw state through `JSON.stringify`, so this diff
 * compares values through the same lens:
 *
 *  - `toJSON` is honoured (`Date` → ISO string); `Number`/`String`/
 *    `Boolean` wrapper objects unwrap; `NaN`/`±Infinity` → null.
 *  - `undefined`, functions and symbols: absent as object values,
 *    `null` as array elements. Symbol keys and non-enumerable
 *    properties don't exist. Map/Set/class instances are their own
 *    enumerable properties (`{}` for Map/Set).
 *  - A `BigInt` or a circular reference ANYWHERE in either tree makes
 *    the whole diff report no changes — exactly what the
 *    `JSON.stringify` try/catch in the old install sites did.
 *
 * Entry order matches Rust: serde_json's map is a BTreeMap, so object
 * keys iterate in sorted order (code-point order — Rust compares UTF-8
 * bytes, which is code-point order, NOT JS's default UTF-16 sort), with
 * each object's removals/recursions (old-side keys) emitted before its
 * additions (new-only keys). One deliberate divergence: key order
 * INSIDE emitted container values follows the live object, not sorted
 * order — the engine parses values back into BTreeMaps, re-sorting at
 * ingestion, so no consumer can observe the difference; preserving it
 * lets unchanged subtrees be emitted by reference instead of copied.
 *
 * Semantics (from diff.rs):
 *  - objects recurse by key; keys only in `new` → `(path, value)`;
 *    keys only in `old` → `(path, null)`;
 *  - arrays: SHRINKING at a non-root path emits one whole-array
 *    replacement at the parent path (`set_value_at_path` never
 *    truncates, so per-index nulls would leave phantom tail slots);
 *    growing and same-length stay granular per index; a root-level
 *    array shrink stays granular (the guard is `!prefix.is_empty()`);
 *  - primitives compare by value; a type change emits the new value;
 *  - the root itself (empty prefix) is never emitted.
 */

import type { StateChange } from "./state.js";

// Local proxy unwrap via the shared symbol registry rather than an
// import from state.ts — state.ts imports this module for the scoped
// diff, and a value import back at it would create a runtime cycle.
// `Symbol.for` returns the identical symbols state.ts registers.
const IS_PROXY = Symbol.for("hypen.isProxy");
const RAW_TARGET = Symbol.for("hypen.rawTarget");

function unwrapProxy<T>(value: T): T {
  if (value !== null && typeof value === "object" && (value as any)[IS_PROXY]) {
    return (value as any)[RAW_TARGET];
  }
  return value;
}

export interface DiffEntry {
  path: string;
  /** The new value at `path`; `null` for deleted keys. */
  value: unknown;
}

/** Thrown internally when a value JSON.stringify could not serialize is
 * found (BigInt, circular structure); converted to an empty diff. */
const UNSERIALIZABLE: Error = new Error("unserializable");

/** Sentinel for object properties JSON.stringify would drop. */
const ABSENT: unique symbol = Symbol("hypen.diff.absent");

/** Depth at which cycle tracking starts. A circular structure recurses
 * without bound, so it always crosses this depth and is caught; below
 * it the walk pays no WeakSet bookkeeping. */
const CYCLE_CHECK_DEPTH = 64;

/**
 * Diff two live JS values, returning every changed leaf as
 * `(path, newValue)` in the same order the Rust implementation emits.
 * Returns `[]` when either tree contains a BigInt or a cycle (the old
 * pipeline's stringify-throws contract).
 */
export function diffJsonPaths(oldValue: unknown, newValue: unknown): DiffEntry[] {
  const out: DiffEntry[] = [];
  try {
    let a = view(oldValue);
    let b = view(newValue);
    // A root value stringify cannot represent behaves as null (the
    // install sites' `state ?? null`).
    if (a === ABSENT) a = null;
    if (b === ABSENT) b = null;
    diffInto("", a, b, out, 0, null, null);
  } catch (err) {
    if (err === UNSERIALIZABLE) return [];
    throw err;
  }
  return out;
}

/**
 * Drop-in for the portable `diffState` shape used by the install sites:
 * maps the entry list into `{ paths, newValues }`. `basePath` is
 * accepted and ignored, exactly like the WASM-backed implementations.
 */
export function diffStateJs(
  oldState: unknown,
  newState: unknown,
  _basePath?: string,
): StateChange {
  const entries = diffJsonPaths(oldState ?? null, newState ?? null);
  const paths: string[] = [];
  const newValues: Record<string, unknown> = {};
  for (const e of entries) {
    paths.push(e.path);
    newValues[e.path] = e.value;
  }
  return { paths, newValues } as StateChange;
}

/** One side of a dirty root: whether the path resolves in that tree,
 * and to what. An explicit `undefined` value with `present: true`
 * behaves as absent, matching the stringify lens. */
export interface PathSlot {
  present: boolean;
  value: unknown;
}

/**
 * Diff the value AT a specific path — the scoped-diff building block
 * for trap-recorded dirty roots. Wrapping both slots in a one-key
 * object reuses every diff_paths rule unchanged and makes the root
 * addressable (a bare `diffJsonPaths` never emits the root itself):
 *
 *  - scalar change at the root       → `(rootPath, newValue)`
 *  - array shrink at the root        → whole-array replacement (the
 *    wrapper key makes the prefix non-empty, as any real parent would)
 *  - missing on one side             → deletion `(rootPath, null)` or
 *    addition `(rootPath, value)`
 *  - anything deeper                 → granular `rootPath.…` leaves
 *
 * A BigInt or cycle under either slot empties THIS root's entries (the
 * caller's other roots are unaffected) — the old whole-state-stringify
 * contract, applied per root.
 */
export function diffJsonPathsAt(
  rootPath: string,
  oldSlot: PathSlot,
  newSlot: PathSlot,
): DiffEntry[] {
  const wa: Record<string, unknown> = {};
  if (oldSlot.present) wa.r = oldSlot.value;
  const wb: Record<string, unknown> = {};
  if (newSlot.present) wb.r = newSlot.value;
  const entries = diffJsonPaths(wa, wb);
  for (const e of entries) {
    e.path = e.path === "r" ? rootPath : rootPath + e.path.slice(1);
  }
  return entries;
}

/**
 * Canonical JSON of a diff entry list: entries sorted by path, object
 * keys sorted recursively. Used by the runtime oracles to compare
 * results across the documented order divergences.
 */
export function canonicalDiffJson(entries: DiffEntry[]): string {
  return canonicalEntriesJson(entries);
}

/**
 * True when runtime cross-checking of every diff against the WASM
 * implementation is enabled: `HYPEN_DIFF_ORACLE=1` in the environment
 * (server) or `globalThis.__HYPEN_DIFF_ORACLE__ = true` (browser).
 * Development tool — the check re-serializes the whole state, undoing
 * the perf win, so it must stay off in production.
 */
export function diffOracleEnabled(): boolean {
  if ((globalThis as any).__HYPEN_DIFF_ORACLE__ === true) return true;
  try {
    return (
      typeof process !== "undefined" &&
      (process as any).env?.HYPEN_DIFF_ORACLE === "1"
    );
  } catch {
    return false;
  }
}

/**
 * Compare a JS-diff result against the canonical WASM `diffPaths` on
 * the same inputs and `console.error` on divergence. Entry order and
 * key order inside values are compared canonically (both are
 * re-sorted), matching the documented divergences.
 */
export function checkDiffOracle(
  change: StateChange,
  oldState: unknown,
  newState: unknown,
  wasmDiffPaths: (oldJson: string, newJson: string) => string,
): void {
  let expected: DiffEntry[];
  try {
    const oldJson = JSON.stringify(oldState ?? null);
    const newJson = JSON.stringify(newState ?? null);
    expected = JSON.parse(wasmDiffPaths(oldJson, newJson));
  } catch {
    expected = []; // stringify threw → old pipeline reported no changes
  }
  const got = change.paths.map((p) => ({
    path: p,
    value: (change.newValues as Record<string, unknown>)[p],
  }));
  if (canonicalEntriesJson(got) !== canonicalEntriesJson(expected)) {
    console.error(
      "[hypen diff oracle] JS diff diverged from WASM diff_paths.",
      "\n  js:  ", canonicalEntriesJson(got),
      "\n  wasm:", canonicalEntriesJson(expected),
    );
  }
}

function canonicalEntriesJson(entries: DiffEntry[]): string {
  const sorted = [...entries].sort((x, y) => compareCodePoints(x.path, y.path));
  return JSON.stringify(sorted, function replacerCanon(_k, v) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort(compareCodePoints)) out[k] = v[k];
      return out;
    }
    return v;
  });
}

/**
 * How JSON.stringify would see `v`: a normalized scalar, ABSENT, or a
 * container (proxy-unwrapped, toJSON/wrapper-object resolved).
 */
function view(v: any): any {
  switch (typeof v) {
    case "string":
    case "boolean":
      return v;
    case "number":
      return Number.isFinite(v) ? v : null;
    case "bigint":
      throw UNSERIALIZABLE;
    case "undefined":
    case "function":
    case "symbol":
      return ABSENT;
  }
  if (v === null) return null;
  v = unwrapProxy(v);
  if (typeof v.toJSON === "function") return view(v.toJSON());
  if (v instanceof Number || v instanceof String || v instanceof Boolean) {
    return view(v.valueOf());
  }
  return v;
}

function isContainer(v: any): boolean {
  return typeof v === "object" && v !== null;
}

/** Compare strings by code point — UTF-8 byte order, i.e. the order
 * Rust's BTreeMap<String, _> iterates in. JS's default sort compares
 * UTF-16 code units, which orders astral-plane characters differently. */
export function compareCodePoints(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ca = a.codePointAt(i)!;
    const cb = b.codePointAt(j)!;
    if (ca !== cb) return ca < cb ? -1 : 1;
    i += ca > 0xffff ? 2 : 1;
    j += cb > 0xffff ? 2 : 1;
  }
  return a.length - i - (b.length - j);
}

/** Own enumerable string keys whose values JSON.stringify would keep,
 * in the order serde_json's BTreeMap iterates them. */
function presentKeysSorted(obj: any): string[] {
  const keys = Object.keys(obj);
  let out: string[] | null = null;
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]!;
    const t = typeof obj[k];
    if (t === "undefined" || t === "function" || t === "symbol") {
      if (out === null) out = keys.slice(0, i);
    } else if (out !== null) {
      out.push(k);
    }
  }
  return (out ?? keys).sort(compareCodePoints);
}

function join(prefix: string, segment: string): string {
  return prefix === "" ? segment : prefix + "." + segment;
}

/**
 * `a` and `b` are already viewed (never ABSENT). `ancestorsA`/`ancestorsB`
 * are per-side cycle guards, active past CYCLE_CHECK_DEPTH.
 */
function diffInto(
  prefix: string,
  a: any,
  b: any,
  out: DiffEntry[],
  depth: number,
  ancestorsA: WeakSet<object> | null,
  ancestorsB: WeakSet<object> | null,
): void {
  const aIsContainer = isContainer(a);
  const bIsContainer = isContainer(b);

  if (aIsContainer && bIsContainer && Array.isArray(a) === Array.isArray(b)) {
    if (depth >= CYCLE_CHECK_DEPTH) {
      if (ancestorsA === null) ancestorsA = new WeakSet();
      else if (ancestorsA.has(a)) throw UNSERIALIZABLE;
      if (ancestorsB === null) ancestorsB = new WeakSet();
      else if (ancestorsB.has(b)) throw UNSERIALIZABLE;
      ancestorsA.add(a);
      ancestorsB.add(b);
      try {
        diffContainers(prefix, a, b, out, depth, ancestorsA, ancestorsB);
      } finally {
        ancestorsA.delete(a);
        ancestorsB.delete(b);
      }
    } else {
      diffContainers(prefix, a, b, out, depth, ancestorsA, ancestorsB);
    }
    return;
  }

  // Scalar vs scalar, container vs scalar, or array vs object: emit the
  // new value on inequality. Containers are never equal to scalars or
  // to a container of the other kind; scalars compare by value.
  if (aIsContainer || bIsContainer || a !== b) {
    // Even when the change cannot be named (empty prefix), both sides
    // must still be serializable for the old pipeline to have produced
    // an (empty) answer at all — walk them for BigInts/cycles.
    const value = emitValue(b, depth, null);
    emitValue(a, depth, null);
    if (prefix !== "") out.push({ path: prefix, value });
  }
}

function diffContainers(
  prefix: string,
  a: any,
  b: any,
  out: DiffEntry[],
  depth: number,
  ancestorsA: WeakSet<object> | null,
  ancestorsB: WeakSet<object> | null,
): void {
  if (Array.isArray(a)) {
    const aLen = a.length;
    const bLen = (b as any[]).length;
    if (bLen < aLen && prefix !== "") {
      // Shrinking array (non-root): whole-array replacement. The old
      // side still has to be serializable to match stringify-throws.
      const value = emitValue(b, depth, null);
      emitValue(a, depth, null);
      out.push({ path: prefix, value });
      return;
    }
    const maxLen = aLen > bLen ? aLen : bLen;
    for (let i = 0; i < maxLen; i++) {
      const path = join(prefix, String(i));
      if (i >= bLen) {
        emitValue(view(a[i]), depth + 1, null); // serializability walk
        out.push({ path, value: null });
      } else if (i >= aLen) {
        out.push({ path, value: emitArrayElement(b[i], depth + 1) });
      } else {
        // In arrays, values stringify would drop become null.
        let va = view(a[i]);
        let vb = view(b[i]);
        if (va === ABSENT) va = null;
        if (vb === ABSENT) vb = null;
        diffInto(path, va, vb, out, depth + 1, ancestorsA, ancestorsB);
      }
    }
    return;
  }

  const aKeys = presentKeysSorted(a);
  const bKeys = presentKeysSorted(b);
  const bSet = new Set(bKeys);
  for (const k of aKeys) {
    const path = join(prefix, k);
    if (bSet.has(k)) {
      const va = view(a[k]);
      const vb = view(b[k]);
      // The cheap typeof filter in presentKeysSorted can't see a value
      // whose `toJSON()` returns undefined — stringify drops that key
      // even though `typeof` calls it present. Resolve real presence
      // from the views. (Ordering caveat: a key ABSENT in old but real
      // in new is emitted here, in old-key position, where the old
      // pipeline emitted it in the additions phase — observable only
      // with a toJSON that returns undefined.)
      if (va === ABSENT && vb === ABSENT) continue;
      if (vb === ABSENT) {
        emitValue(va, depth + 1, null); // serializability walk
        out.push({ path, value: null });
      } else if (va === ABSENT) {
        out.push({ path, value: emitValue(vb, depth + 1, null) });
      } else {
        diffInto(path, va, vb, out, depth + 1, ancestorsA, ancestorsB);
      }
    } else {
      const va = view(a[k]);
      if (va === ABSENT) continue;
      emitValue(va, depth + 1, null); // serializability walk
      out.push({ path, value: null });
    }
  }
  const aSet = new Set(aKeys);
  for (const k of bKeys) {
    if (!aSet.has(k)) {
      const vb = view(b[k]);
      if (vb === ABSENT) continue;
      out.push({ path: join(prefix, k), value: emitValue(vb, depth + 1, null) });
    }
  }
}

function emitArrayElement(raw: any, depth: number): unknown {
  const v = view(raw);
  return v === ABSENT ? null : emitValue(v, depth, null);
}

/**
 * JSON-normalize a viewed value for emission, copy-on-write: subtrees
 * that are already plain JSON come back by reference. Also serves as
 * the serializability walk over subtrees the diff otherwise skips
 * (deleted values, both sides of a replacement) so a BigInt or cycle
 * anywhere still empties the diff, matching stringify-throws.
 */
function emitValue(v: any, depth: number, ancestors: WeakSet<object> | null): any {
  if (!isContainer(v)) return v; // viewed scalar (never ABSENT here)

  if (depth < CYCLE_CHECK_DEPTH) {
    return emitContainer(v, depth, ancestors);
  }
  if (ancestors === null) ancestors = new WeakSet();
  else if (ancestors.has(v)) throw UNSERIALIZABLE;
  ancestors.add(v);
  try {
    return emitContainer(v, depth, ancestors);
  } finally {
    ancestors.delete(v);
  }
}

function emitContainer(v: any, depth: number, ancestors: WeakSet<object> | null): any {
  if (Array.isArray(v)) {
    let out: any[] | null = null;
    for (let i = 0; i < v.length; i++) {
      const child = v[i];
      let viewed = view(child);
      if (viewed === ABSENT) viewed = null;
      const emitted = emitValue(viewed, depth + 1, ancestors);
      if (out !== null) {
        out.push(emitted);
      } else if (emitted !== child) {
        out = v.slice(0, i);
        out.push(emitted);
      }
    }
    return out ?? v;
  }

  // Non-array container: own enumerable present keys. A non-plain
  // object (Map, Set, class instance) must always be copied into a
  // plain object — its JSON form.
  const proto = Object.getPrototypeOf(v);
  const keys = Object.keys(v);
  if (proto !== Object.prototype && proto !== null) {
    const out: Record<string, any> = {};
    for (const k of keys) {
      const viewed = view(v[k]);
      if (viewed !== ABSENT) out[k] = emitValue(viewed, depth + 1, ancestors);
    }
    return out;
  }
  let out: Record<string, any> | null = null;
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]!;
    const child = v[k];
    const viewed = view(child);
    const emitted = viewed === ABSENT ? ABSENT : emitValue(viewed, depth + 1, ancestors);
    if (out !== null) {
      if (emitted !== ABSENT) out[k] = emitted;
    } else if (emitted !== child) {
      out = {};
      for (let j = 0; j < i; j++) out[keys[j]!] = v[keys[j]!];
      if (emitted !== ABSENT) out[k] = emitted;
    }
  }
  return out ?? v;
}
