/**
 * Action Dispatch
 *
 * Resolves a DOM-ish event on a virtual node to the engine action its
 * props declare, and dispatches it. Shared by the canvas hit-test path
 * (pointer events) and the accessibility-mirror path (keyboard / AT
 * activation) so both produce identical action payloads.
 */

import type { VirtualNode } from "./types.js";
import { resolveEventAction } from "./props.js";

/** Minimal engine surface needed for dispatch. */
export interface DispatchEngine {
  dispatchAction(name: string, payload?: any): void;
}

// Maps a DOM event type to the applicator prop names the engine may have set
// on a node, in priority order. Multi-word events (`mouseenter`) need their
// proper camelCase form (`onMouseEnter`) since the engine emits applicator
// names verbatim. `mouseenter` also accepts `onHover` as an alias.
const CANVAS_EVENT_PROP_NAMES: Record<string, string[]> = {
  mouseenter: ["onMouseEnter", "onHover", "onmouseenter", "mouseenter"],
  mouseleave: ["onMouseLeave", "onmouseleave", "mouseleave"],
  mousedown: ["onMouseDown", "onmousedown", "mousedown"],
  mouseup: ["onMouseUp", "onmouseup", "mouseup"],
  dblclick: ["onDblClick", "onDoubleClick", "ondblclick", "dblclick"],
  contextmenu: ["onContextMenu", "oncontextmenu", "contextmenu"],
  keydown: ["onKeyDown", "onkeydown", "keydown"],
  keyup: ["onKeyUp", "onkeyup", "keyup"],
};

/**
 * Dispatch an event on a node to the engine action its props declare.
 *
 * Engine emits event applicators in camelCase (`onClick`, `onMouseEnter`).
 * Multi-word DOM events like `mouseenter` must map to `onMouseEnter`, not
 * the naive `onMouseenter` that `on${capitalize(eventType)}` would produce.
 * The older flat form `onclick`/`onmouseenter` is still accepted. After
 * prop normalisation the value is either a string (action name) or an
 * object carrying an action name at `"0"` plus an auxiliary payload.
 */
export function dispatchNodeEvent(
  engine: DispatchEngine,
  node: VirtualNode,
  eventType: string,
  data: any,
): void {
  const propNames = CANVAS_EVENT_PROP_NAMES[eventType] ?? [
    `on${eventType.charAt(0).toUpperCase()}${eventType.slice(1)}`,
    `on${eventType}`,
    eventType,
  ];

  let spec: unknown;
  for (const name of propNames) {
    if (node.props[name] != null) {
      spec = node.props[name];
      break;
    }
  }

  // Actionable components fall back to the bare `action` prop on click.
  if (spec == null && eventType === "click") {
    spec = node.props.action;
  }

  const resolved = resolveEventAction(spec);
  if (!resolved) return;

  engine.dispatchAction(resolved.actionName, {
    type: eventType,
    nodeId: node.id,
    timestamp: Date.now(),
    ...resolved.payload,
    ...data,
  });
}
