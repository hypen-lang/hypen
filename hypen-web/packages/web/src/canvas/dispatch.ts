import { dispatchUIAction } from "@hypen-space/core";
/**
 * Action Dispatch
 *
 * Resolves a DOM-ish event on a virtual node to the engine action its
 * props declare, and dispatches it. Shared by the canvas hit-test path
 * (pointer events) and the accessibility-mirror path (keyboard / AT
 * activation) so both produce identical action payloads.
 */

import { ACTION_ANIMATE_KEY } from "@hypen-space/core/types";
import type { VirtualNode } from "./types.js";
import { resolveEventAction } from "./props.js";
import { CHART_POINTER_KEY, chartEventPayload } from "./chart.js";

/** Minimal engine surface needed for dispatch. */
export interface DispatchEngine {
  dispatchAction(name: string, payload?: any): void;
}

// Maps a DOM event type to the applicator prop names the engine may have set
// on a node, in priority order. Multi-word events (`mouseenter`) need their
// proper camelCase form (`onMouseEnter`) since the engine emits applicator
// names verbatim. `mouseenter` also accepts `onHover` as an alias.
const CANVAS_EVENT_PROP_NAMES: Record<string, string[]> = {
  // `onPress` is the mobile-style alias the DOM applicator registry maps to
  // `click`; chart marks (and Buttons) are documented with both spellings.
  click: ["onClick", "onPress", "onclick", "click"],
  // Pointer tracking across an element, throttled by the event manager —
  // mouse, touch and pen alike. Mirrors the DOM's `onMove` applicator.
  pointermove: ["onMove", "onPointerMove", "onpointermove", "pointermove"],
  longpress: ["onLongPress", "onlongpress", "longpress"],
  mouseenter: ["onMouseEnter", "onHover", "onmouseenter", "mouseenter"],
  mouseleave: ["onMouseLeave", "onmouseleave", "mouseleave"],
  mousedown: ["onMouseDown", "onmousedown", "mousedown"],
  mouseup: ["onMouseUp", "onmouseup", "mouseup"],
  dblclick: ["onDblClick", "onDoubleClick", "ondblclick", "dblclick"],
  contextmenu: ["onContextMenu", "oncontextmenu", "contextmenu"],
  keydown: ["onKeyDown", "onkeydown", "keydown"],
  keyup: ["onKeyUp", "onkeyup", "keyup"],
};

/** A Link's destination, under the spellings the renderer marks clickable. */
export function linkDestination(node: VirtualNode): string | null {
  if (typeof node.type !== "string" || node.type.toLowerCase() !== "link") return null;
  const p = node.props;
  const raw = p.href ?? p["href.0"] ?? p.to ?? p["to.0"] ?? p["0"];
  return typeof raw === "string" && raw ? raw : null;
}

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Navigate for a Link that carries a destination but no click handler.
 * In-app paths go through the router action the module-backed form sends
 * (`router.push`, read by ManagedRouter as `to`); a URL with a scheme
 * leaves the app the way an anchor would.
 */
function activateBareLink(engine: DispatchEngine, node: VirtualNode): void {
  const to = linkDestination(node);
  if (!to) return;
  if (HAS_SCHEME.test(to)) {
    if (typeof window === "undefined") return;
    const target = node.props.target ?? node.props["target.0"];
    if (target === "_blank") window.open(to, "_blank", "noopener");
    else window.location.assign(to);
    return;
  }
  engine.dispatchAction("router.push", { type: "click", nodeId: node.id, to });
}

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
  if (!resolved) {
    // A bare `Link("/next")` has no handler prop; on the DOM the `<a href>`
    // navigates by itself. Give the canvas the same default.
    if (eventType === "click") activateBareLink(engine, node);
    return;
  }

  // The pointer position travels under a reserved key so the chart resolver
  // can read it; it is renderer plumbing and never reaches a handler.
  let extras = data;
  let pointer: { x: number; y: number } | null = null;
  if (data && typeof data === "object" && CHART_POINTER_KEY in data) {
    extras = { ...data };
    pointer = extras[CHART_POINTER_KEY] ?? null;
    delete extras[CHART_POINTER_KEY];
  }

  const payload: Record<string, any> = {
    type: eventType,
    nodeId: node.id,
    timestamp: Date.now(),
    ...resolved.payload,
    ...extras,
  };

  // A chart mark's datum (or the Chart's own pointer position in data units)
  // is merged LAST: it is the contract's payload and wins over static args.
  const chart = chartEventPayload(node, pointer);
  if (chart) Object.assign(payload, chart);
  // Transaction-animation stamp (Option D): carried across the dispatch
  // boundary under the reserved key; BaseEngine.onAction lifts it into
  // Action.animate, so handlers never see it in the payload.
  if (resolved.animate !== undefined) {
    payload[ACTION_ANIMATE_KEY] = resolved.animate;
  }
  dispatchUIAction(engine, node.id, resolved.actionName, payload);
}
