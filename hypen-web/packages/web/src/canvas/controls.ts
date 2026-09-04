/**
 * Form-control interaction for the canvas renderer.
 *
 * Checkbox, Radio, Switch and Slider painted correctly but responded to
 * nothing: the canvas synthesizes only pointer, key and focus events, there
 * was no `change`/`input` dispatch anywhere, and `.bind()` was wired for
 * `input`/`textarea` alone (see `editing.ts`). The docs make `.onChange` the
 * canonical wiring for exactly these controls
 * (hypen-docs/content/docs/guide/inputs.mdx), so every one of them was inert.
 *
 * The Scrubber is the one control that was already wired end to end; this
 * module follows its shape — mutate the node's own props so the next paint
 * reflects the change immediately, then tell the engine.
 */

import type { VirtualNode } from "./types.js";
import { cssLengthToPx } from "./utils.js";
import { dispatchNodeEvent, type DispatchEngine } from "./dispatch.js";

/** Types this module drives. Select is painted but not yet operable — see below. */
const TOGGLE_TYPES = new Set(["checkbox", "radio", "switch"]);
/** Every type this module drives, for the renderer's clickable/focusable flags. */
export const FORM_CONTROL_TYPES: ReadonlySet<string> = new Set([...TOGGLE_TYPES, "slider"]);
const CONTROL_TYPES = FORM_CONTROL_TYPES;

/**
 * A node's lowercased type, tolerating a node that has none.
 *
 * These predicates run on the accessibility-mirror path too, where a node is
 * resolved from a DOM id rather than built by the renderer, so a missing
 * `type` must read as "not a control" instead of throwing and aborting the
 * activation handler around it.
 */
function typeOf(node: VirtualNode): string {
  return typeof node.type === "string" ? node.type.toLowerCase() : "";
}

export function isFormControl(node: VirtualNode): boolean {
  return CONTROL_TYPES.has(typeOf(node));
}

export function isToggleControl(node: VirtualNode): boolean {
  return TOGGLE_TYPES.has(typeOf(node));
}

export function isSliderControl(node: VirtualNode): boolean {
  return typeOf(node) === "slider";
}

/**
 * Wire values are strings as often as booleans — `"false"` is the case that
 * matters, since it is truthy. Mirrors the DOM renderer's `toBool`.
 */
export function toBool(value: any): boolean {
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    return !(v === "false" || v === "0" || v === "");
  }
  return Boolean(value);
}

/** A control the user cannot operate. */
export function isControlDisabled(node: VirtualNode): boolean {
  const p = node.props;
  const disabled = p.disabled ?? p["disabled.0"];
  if (disabled !== undefined) return toBool(disabled);
  const enabled = p.enabled ?? p["enabled.0"];
  if (enabled !== undefined) return !toBool(enabled);
  return false;
}

/**
 * Current checked state, under any spelling the painters accept.
 *
 * A Radio's `value` is its option id (`Radio(value: "a")`), never its
 * state — reading it as "checked" made every valued radio unselectable —
 * so for radios only `checked` counts.
 */
export function isChecked(node: VirtualNode): boolean {
  const p = node.props;
  const raw =
    typeOf(node) === "radio"
      ? p.checked ?? p["checked.0"]
      : p.checked ?? p["checked.0"] ?? p.on ?? p.value;
  return toBool(raw);
}

/**
 * Sibling radios in the same group as `node`: same `name` when one is set,
 * otherwise every radio under the same parent.
 */
function radioGroupSiblings(node: VirtualNode): VirtualNode[] {
  const parent = node.parent;
  if (!parent) return [];
  const name = node.props.name ?? node.props["name.0"];
  return parent.children.filter(
    (sib) =>
      sib !== node &&
      typeOf(sib) === "radio" &&
      (name == null || (sib.props.name ?? sib.props["name.0"]) === name),
  );
}

/** Slider bounds, matching `paintSlider`'s own parsing. */
export function sliderRange(node: VirtualNode): { min: number; max: number; step: number } {
  const p = node.props;
  const min = parseFloat(p.min) || 0;
  const parsedMax = parseFloat(p.max);
  const max = Number.isFinite(parsedMax) ? parsedMax : 100;
  const parsedStep = parseFloat(p.step);
  const step = Number.isFinite(parsedStep) && parsedStep > 0 ? parsedStep : 0;
  return { min, max: max === min ? min + 1 : max, step };
}

/**
 * Value for a pointer at `x`, snapped to `step`.
 *
 * The usable track is inset by half a thumb at each end so dragging to the
 * visual extremes actually reaches min and max, matching where the thumb is
 * painted (`paintSlider`).
 */
export function sliderValueAt(node: VirtualNode, x: number): number {
  const layout = node.layout;
  if (!layout) return sliderRange(node).min;

  const thumbSize = cssLengthToPx(node.props.thumbSize) ?? 16;
  const usable = Math.max(1, layout.width - thumbSize);
  const fraction = Math.min(1, Math.max(0, (x - layout.x - thumbSize / 2) / usable));

  const { min, max, step } = sliderRange(node);
  let value = min + fraction * (max - min);
  if (step > 0) value = min + Math.round((value - min) / step) * step;
  // Snapping can overshoot the top of the range on a non-integral step.
  value = Math.min(max, Math.max(min, value));
  // Trim binary float dust so a 0.1 step reports 0.3, not 0.30000000000000004.
  return step > 0 ? Number(value.toFixed(10)) : value;
}

/** Write a new value into a node's props under the spelling it was authored with. */
function writeControlValue(node: VirtualNode, value: boolean | number): void {
  const props = node.props;
  if (typeof value === "boolean") {
    if (typeOf(node) === "radio") {
      // `value` is the option id on a radio — state lives under `checked`.
      props.checked = value;
      if (props["checked.0"] !== undefined) props["checked.0"] = value;
      return;
    }
    // Write back under whichever spelling the node was authored with, so the
    // painter reads the same key it read before. An uncontrolled toggle
    // (`Checkbox {}.bind(...)`) lands under `checked`, the canonical name
    // the DOM handler and `semantics.checked` use.
    if (props.checked !== undefined || props["checked.0"] !== undefined) {
      props.checked = value;
      if (props["checked.0"] !== undefined) props["checked.0"] = value;
    } else if (props.on !== undefined) {
      props.on = value;
    } else if (props.value !== undefined) {
      props.value = value;
    } else {
      props.checked = value;
    }
  } else {
    props.value = value;
    if (props["value.0"] !== undefined) props["value.0"] = value;
  }
}

/** `.bind(@state.x)` — the two-way channel every other renderer supports. */
function writeBind(engine: DispatchEngine, node: VirtualNode, value: boolean | number): void {
  const props = node.props;
  const bindPath = props.bind ?? props["bind.0"];
  if (typeof bindPath === "string" && bindPath) {
    engine.dispatchAction("__hypen_bind", { path: bindPath, value });
  }
}

/**
 * Apply a new value to a control and tell the engine.
 *
 * Props are mutated in place so the very next paint shows the new state
 * without waiting for the engine to echo a patch back — the same optimistic
 * update the scrubber and the text editor already make. The engine remains
 * the source of truth: when its patch arrives it simply agrees.
 *
 * Dispatches `change` once. A slider mid-drag must NOT come through here on
 * every move — see `updateSliderDrag`, which emits `input` per move and
 * leaves `change` to the release, as `<input type=range>` does.
 */
export function commitControlValue(
  engine: DispatchEngine,
  node: VirtualNode,
  value: boolean | number,
): void {
  writeControlValue(node, value);
  writeBind(engine, node, value);

  if (typeOf(node) === "radio" && value === true) {
    // One selected per group: the optimistic paint has to clear siblings
    // too, or two radios show selected until the engine echoes.
    for (const sib of radioGroupSiblings(node)) writeControlValue(sib, false);
    // For a radio the interesting datum is which option, not `true`.
    const optionValue = node.props.value ?? node.props["value.0"];
    dispatchNodeEvent(engine, node, "change", {
      value: optionValue !== undefined ? optionValue : value,
      checked: true,
    });
    return;
  }

  // `.onChange(@actions.x)`.
  dispatchNodeEvent(engine, node, "change", { value });
}

/**
 * Toggle a checkbox/radio/switch. Returns false when the control is disabled
 * or a radio is already selected (a radio never turns itself off).
 */
export function activateToggle(engine: DispatchEngine, node: VirtualNode): boolean {
  if (isControlDisabled(node)) return false;

  const current = isChecked(node);
  if (typeOf(node) === "radio" && current) return false;

  commitControlValue(engine, node, !current);
  return true;
}

/**
 * Nudge a slider by one step, for the arrow keys.
 *
 * With no explicit `step` the control is continuous, so pick 1% of the range
 * — the same default a native range input uses when it has no step.
 */
export function stepSlider(
  engine: DispatchEngine,
  node: VirtualNode,
  direction: 1 | -1,
): boolean {
  if (isControlDisabled(node)) return false;

  const { min, max, step } = sliderRange(node);
  const delta = step > 0 ? step : (max - min) / 100;
  const current = parseFloat(node.props.value);
  const base = Number.isFinite(current) ? current : min;
  const next = Math.min(max, Math.max(min, base + delta * direction));
  if (next === base) return false;

  commitControlValue(engine, node, Number(next.toFixed(10)));
  return true;
}

/**
 * Operate a control from the keyboard, on the node the accessibility mirror
 * says is focused. Returns true when the key was consumed.
 */
export function handleControlKey(
  engine: DispatchEngine,
  node: VirtualNode,
  key: string,
): boolean {
  if (isToggleControl(node)) {
    // Space only, as a native checkbox: Enter is left to the author (and to
    // form submission), so an `onKeyDown` Enter handler does not also flip
    // the control.
    if (key === " " || key === "Spacebar") {
      return activateToggle(engine, node);
    }
    return false;
  }

  if (isSliderControl(node)) {
    if (key === "ArrowRight" || key === "ArrowUp") return stepSlider(engine, node, 1);
    if (key === "ArrowLeft" || key === "ArrowDown") return stepSlider(engine, node, -1);
  }

  return false;
}

/**
 * Continuous slider update during a drag.
 *
 * Emits `input` and the bind write per move (the DOM listens to `input` for
 * `.bind` on a range input too). `change` is NOT emitted here: a native
 * range fires it once on release, and an author's `onChange` is typically
 * the commit hook. `finishSliderDrag` dispatches it with the final value.
 */
export function updateSliderDrag(
  engine: DispatchEngine,
  node: VirtualNode,
  x: number,
): boolean {
  if (isControlDisabled(node)) return false;

  const next = sliderValueAt(node, x);
  if (parseFloat(node.props.value) === next) return false;

  writeControlValue(node, next);
  writeBind(engine, node, next);
  dispatchNodeEvent(engine, node, "input", { value: next });
  return true;
}

/**
 * End of a slider drag: the one `change` for the whole gesture, carrying
 * the value the drag settled on. Called whether the release landed on the
 * canvas, on the window, or was inferred from a buttonless move.
 */
export function finishSliderDrag(engine: DispatchEngine, node: VirtualNode): void {
  if (isControlDisabled(node)) return;
  const value = parseFloat(node.props.value);
  if (!Number.isFinite(value)) return;
  dispatchNodeEvent(engine, node, "change", { value });
}
