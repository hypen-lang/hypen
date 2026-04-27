/**
 * Template introspection + mock-module synthesis.
 *
 * When a .hypen entry has no sibling .ts module, we scan the template for
 * `@{state.*}` and `@actions.*` references and build a best-guess state
 * schema plus a matching module with no-op action handlers. The user can
 * toggle state values in the Studio's State panel to drive the preview.
 *
 * V1 intentionally uses regex rather than the parser AST — keeps studio-ui
 * independent of the Rust parser boundary, which isn't exposed to JS.
 * Lossy: types are all strings by default, array row counts start at 1.
 * A proper AST-driven pass can replace this later without changing callers.
 */

/**
 * `@{ state.user.name }` / `@{state.items.0.title}` — we accept optional
 * whitespace and allow both dotted and bracketed array access.
 */
const STATE_RE = /@\{\s*state((?:\.[a-zA-Z_$][\w$]*|\.\d+|\[\d+\])*)\s*\}/g;

/** `@actions.foo` — bare reference, no braces, often used as attribute value. */
const ACTION_RE = /@actions\.([a-zA-Z_$][\w$]*)/g;

export interface TemplateReferences {
  /** Dotted paths found under `state.*`, deduped, e.g. ["user.name", "items.0.title"]. */
  statePaths: string[];
  /** Action names, deduped. */
  actionNames: string[];
}

export function scanReferences(template: string): TemplateReferences {
  const statePaths = new Set<string>();
  for (const m of template.matchAll(STATE_RE)) {
    const raw = m[1] ?? "";
    if (!raw) continue;
    // Normalise `[0]` → `.0` so downstream shape-building has one format.
    const normalised = raw.replace(/\[(\d+)\]/g, ".$1").replace(/^\./, "");
    if (normalised) statePaths.add(normalised);
  }

  const actionNames = new Set<string>();
  for (const m of template.matchAll(ACTION_RE)) {
    if (m[1]) actionNames.add(m[1]);
  }

  return {
    statePaths: [...statePaths].sort(),
    actionNames: [...actionNames].sort(),
  };
}

const isArrayIndex = (key: string): boolean => /^\d+$/.test(key);

/**
 * Given a list of dotted paths, materialise a nested shape. A numeric
 * segment signals an array parent; strings signal objects. Leaves default
 * to `""` — swap for null / 0 later via the State panel.
 */
export function buildShape(paths: string[]): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const path of paths) {
    const parts = path.split(".");
    setNestedDefault(root, parts);
  }
  return root;
}

function setNestedDefault(root: any, parts: string[]): void {
  let cur: any = root;
  for (let i = 0; i < parts.length; i++) {
    const key = parts[i];
    const isLast = i === parts.length - 1;
    const nextKey = parts[i + 1];
    const nextIsArrayIdx = nextKey !== undefined && isArrayIndex(nextKey);

    if (isArrayIndex(key)) {
      // Parent is expected to be an array; if a previous path created it
      // as an object (conflict), we leave it — the user's template is
      // inconsistent and we surface their structure, not ours.
      const arr = cur as unknown[];
      const idx = parseInt(key, 10);
      if (isLast) {
        if (arr[idx] === undefined) arr[idx] = "";
      } else {
        if (arr[idx] === undefined) arr[idx] = nextIsArrayIdx ? [] : {};
        cur = arr[idx];
      }
    } else {
      if (isLast) {
        if (cur[key] === undefined) cur[key] = "";
      } else {
        if (cur[key] === undefined) cur[key] = nextIsArrayIdx ? [] : {};
        cur = cur[key];
      }
    }
  }
}

/**
 * Append a new row to the array at `path` (dotted). Uses the first
 * existing row as a template so the new row has the same keys with
 * reset values — matches what a user iterating a list expects.
 */
export function addArrayRow(state: Record<string, unknown>, dottedPath: string): Record<string, unknown> {
  const parts = dottedPath.split(".");
  let parent: any = state;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (isArrayIndex(key)) parent = (parent as unknown[])[parseInt(key, 10)];
    else parent = parent[key];
    if (parent == null) return state; // path is broken; no-op
  }
  const last = parts[parts.length - 1];
  const target = isArrayIndex(last) ? undefined : parent[last];
  if (!Array.isArray(target)) return state;

  const templateRow = target[0];
  const newRow = cloneEmpty(templateRow);
  target.push(newRow);
  return state;
}

/** Deep-clone an object/array with leaf values reset to empty defaults. */
function cloneEmpty(v: unknown): unknown {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.length > 0 ? [cloneEmpty(v[0])] : [];
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = cloneEmpty(val);
    }
    return out;
  }
  if (typeof v === "number") return 0;
  if (typeof v === "boolean") return false;
  return "";
}

/**
 * Collect the dotted paths of every array in the state tree — the UI uses
 * this to render "+ row" buttons beside the right nodes.
 */
export function findArrayPaths(state: Record<string, unknown>): string[] {
  const out: string[] = [];
  walk(state, [], out);
  return out;
}

function walk(node: unknown, path: string[], out: string[]): void {
  if (Array.isArray(node)) {
    out.push(path.join("."));
    if (node.length > 0) walk(node[0], [...path, "0"], out);
    return;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      walk(v, [...path, k], out);
    }
  }
}
