/**
 * Canvas applicator-prop normalisation.
 *
 * The engine emits props using the applicator-argument naming scheme:
 *   - single-positional:   `flex.0`, `padding.0`, `width.0`
 *   - multi-argument:      `onClick.0`, `onClick.to`, `onClick.postId`
 *
 * The DOM renderer groups these at apply time via ApplicatorRegistry so
 * downstream code can read `style.flex`, handler payloads, etc. The canvas
 * layout (`layout.ts`) and paint (`paint.ts`) expect the same flat / aggregate
 * shape but don't run an applicator pipeline, so without normalisation every
 * size/flex/padding arriving from the engine is silently ignored — nodes
 * collapse to Taffy auto sizing and images paint at full canvas bounds.
 *
 * We mirror the DOM grouping here: keep the raw `"base.key"` entries on the
 * node (so follow-up SetProp patches can re-derive the aggregate) and
 * additionally populate the bare `base` key with either the scalar value
 * (single `.0`) or an aggregate object (multiple args).
 */

/** Return the applicator base name for a namespaced key, or null if it's flat. */
export function parseApplicatorBase(name: string): string | null {
  const dot = name.indexOf(".");
  if (dot <= 0) return null;
  return name.slice(0, dot);
}

/**
 * Rebuild the derived flat/aggregate entry for `baseName` from all
 * `"baseName.*"` keys currently on `props`. Mutates `props` in place.
 *
 * - Zero matching dotted keys: delete `props[baseName]` (any previously
 *   derived value is now stale).
 * - Exactly one key, numeric (`baseName.0`): flatten to the scalar value.
 * - Anything else: store as an object keyed by the arg names.
 */
export function refreshApplicator(props: Record<string, any>, baseName: string): void {
  const prefix = baseName + ".";
  const args: Record<string, any> = {};
  let count = 0;
  for (const key of Object.keys(props)) {
    if (!key.startsWith(prefix)) continue;
    args[key.slice(prefix.length)] = props[key];
    count++;
  }
  if (count === 0) {
    delete props[baseName];
    return;
  }
  const keys = Object.keys(args);
  if (keys.length === 1 && /^\d+$/.test(keys[0])) {
    props[baseName] = args[keys[0]];
  } else {
    props[baseName] = args;
  }
}

/**
 * Walk every key in `props`, collect the set of applicator base names,
 * and refresh each one. Used on the initial Create patch where the whole
 * prop bag arrives at once.
 */
export function normalizeAllApplicators(props: Record<string, any>): void {
  const bases = new Set<string>();
  for (const key of Object.keys(props)) {
    const base = parseApplicatorBase(key);
    if (base !== null) bases.add(base);
  }
  for (const base of bases) refreshApplicator(props, base);
}

/**
 * Strip the engine's DSL prefixes from an action name. The Hypen DSL writes
 * `@router.push` / `@actions.toggleLike`; the engine wants `router.push` /
 * `toggleLike` on the wire. Mirrors the DOM renderer's
 * `extractActionDetails` in `dom/applicators/events.ts`.
 */
function stripActionPrefixes(raw: string): string {
  if (!raw.startsWith("@")) return raw;
  let name = raw.substring(1);
  if (name.startsWith("actions.")) name = name.substring(8);
  return name;
}

/**
 * Resolve an event applicator value into `(actionName, payload)`.
 *
 * After normalisation, `onClick` is either:
 *   - a string:   `"@router.push"` (single positional, no extra args)
 *   - an object:  `{ "0": "@router.push", to: "/notifications" }`
 *
 * Strips the leading `@` and the `actions.` namespace prefix so the wire
 * format matches what the DOM renderer sends — without this, `@router.push`
 * went out verbatim and the engine ignored it because it expects the
 * stripped form (`router.push`).
 *
 * The `animate:` named argument (transaction-scoped animation, Option D) is
 * pulled OUT of the payload and returned as the distinct `animate` field —
 * it stamps the dispatched action and must never reach a module handler's
 * payload. Both the token form (`animate: spring` → string) and the object
 * form (`animate: {curve, duration}`) arrive under the `"animate"` key.
 * ONLY the aggregate's own top-level `animate` key — the applicator's NAMED
 * `animate:` argument (`onClick.animate`) — is reserved. An `animate` key
 * inside a positional payload object (`.onClick("@a", {animate: false})` →
 * nested under `"1"`) is user data and is never extracted.
 *
 * Returns `null` if no dispatchable action name could be found.
 */
export function resolveEventAction(
  spec: unknown,
): { actionName: string; payload: Record<string, any>; animate?: unknown } | null {
  if (typeof spec === "string") {
    if (!spec.startsWith("@")) return null;
    return { actionName: stripActionPrefixes(spec), payload: {} };
  }
  if (spec && typeof spec === "object") {
    const obj = spec as Record<string, any>;
    const raw = obj["0"];
    if (typeof raw !== "string" || !raw.startsWith("@")) return null;
    const payload: Record<string, any> = {};
    let animate: unknown;
    let hasAnimate = false;
    for (const [k, v] of Object.entries(obj)) {
      if (k === "0") continue;
      if (k === "animate") {
        animate = v;
        hasAnimate = true;
        continue;
      }
      payload[k] = v;
    }
    return hasAnimate
      ? { actionName: stripActionPrefixes(raw), payload, animate }
      : { actionName: stripActionPrefixes(raw), payload };
  }
  return null;
}
