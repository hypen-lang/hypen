/**
 * Patch-stream validation. A `create` patch whose `elementType` is neither a
 * known primitive nor a resolved component is a silent resolver miss — the
 * renderer drops the node, no error surfaces. `validatePatches` turns that into
 * a one-line test/CI assertion.
 */

import type { Patch } from "./types.js";

export interface PatchValidationResult {
  /** Distinct `create` `elementType`s not in `knownTypes` (i.e. dropped nodes). */
  unknownTypes: string[];
}

/**
 * Distinct `create` `elementType`s not in `knownTypes`.
 *
 * `knownTypes` is caller-supplied (engine primitives + the app's resolvable
 * component names) rather than read from the engine: the wasm-bindgen build
 * exposes no primitive list, and hardcoding the built-ins would drift from Rust.
 */
export function validatePatches(
  patches: Patch[],
  knownTypes: Iterable<string>,
): PatchValidationResult {
  const known = knownTypes instanceof Set ? knownTypes : new Set(knownTypes);
  const unknown = new Set<string>();

  for (const patch of patches) {
    if (patch.type !== "create") continue;
    const elementType = patch.elementType;
    if (typeof elementType !== "string") continue;
    if (!known.has(elementType)) unknown.add(elementType);
  }

  return { unknownTypes: [...unknown] };
}
