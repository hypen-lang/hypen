import { dispatchUIAction } from "@hypen-space/core";
/**
 * Event Applicators
 *
 * Handles event applicators like onClick, onPress, etc.
 * Uses a factory pattern to reduce boilerplate and ensure consistency.
 */

import type { ApplicatorHandler } from "./types.js";
import {
  getElementDisposables,
  disposableListener,
  disposableTimeout,
  type Disposable,
} from "@hypen-space/core/disposable";
import { frameworkLoggers } from "@hypen-space/core/logger";
import { ACTION_ANIMATE_KEY } from "@hypen-space/core/types";
import {
  type IEngine,
  getEngine,
  getRegisteredEvents,
  registerEvent,
  unregisterEvent,
  getKeyTarget,
  setKeyTarget,
  getMeta,
  setMeta,
  getPayloadResolver,
} from "../element-data.js";
import { isInExitingSubtree } from "../anim.js";
import { setAnimationCompleteAction } from "../anim-complete.js";
import { dragCarriesFiles, dragItemCount } from "../../file-drag.js";
import {
  DND_DRAG_OVER_DWELL_KEY,
  DND_EVENT_NAMES,
  type DndEventName,
} from "@hypen-space/core/dnd";

const log = frameworkLoggers.events;

// ============================================================================
// Types
// ============================================================================

interface EventHandlerOptions {
  /** Custom payload extractor for this event type */
  extractPayload?: (event: Event, element: HTMLElement) => Record<string, unknown>;
  /** Throttle events to max one per N milliseconds */
  throttleMs?: number;
  /** Prevent default behavior */
  preventDefault?: boolean;
  /** Use passive listener (for scroll, touch) */
  passive?: boolean;
  /** Key to listen for (keyboard events) */
  key?: string;
}


// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Stamp an element that carries at least one event applicator. Components
 * whose geometry should be pointer-transparent unless it is interactive (a
 * chart's decorative marks, a tooltip Marker) key CSS off this marker, so an
 * `.onClick` added later flips them live without a re-layout.
 */
function markInteractive(element: HTMLElement): void {
  if (element.dataset && element.dataset.hypenInteractive !== "true") {
    element.dataset.hypenInteractive = "true";
  }
}

/**
 * Convert Map or nested objects to plain objects
 */
function toPlainObject(value: unknown): unknown {
  if (value instanceof Map) {
    const obj: Record<string, unknown> = {};
    for (const [key, val] of value.entries()) {
      obj[key] = toPlainObject(val);
    }
    return obj;
  }

  if (Array.isArray(value)) {
    return value.map((item) => toPlainObject(item));
  }

  if (value && typeof value === "object") {
    const obj: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      obj[key] = toPlainObject(val);
    }
    return obj;
  }

  return value;
}

/**
 * Extract action name and custom payload from an applicator value.
 *
 * The `animate:` named argument (transaction-scoped animation, Option D) is
 * pulled OUT of the payload and returned as the distinct `animate` field —
 * it stamps the dispatched action (`Action.animate`) and must never reach a
 * module handler's payload. Both the token form (`animate: spring` → a bare
 * string) and the object form (`animate: {curve: spring, duration: 300}`)
 * arrive under the `"animate"` key of the applicator's argument object.
 * ONLY that named-argument position is reserved: an `animate` key inside a
 * POSITIONAL payload object (`.onClick("@a", {animate: false})` → arg "1")
 * is user data and reaches the handler untouched.
 */
export function extractActionDetails(value: unknown): {
  actionName: string | null;
  payload: Record<string, unknown>;
  animate?: unknown;
} {
  // String format: "@actions.doSomething" or "@doSomething"
  if (typeof value === "string") {
    if (!value.startsWith("@")) {
      return { actionName: null, payload: {} };
    }

    let actionName = value.substring(1);
    if (actionName.startsWith("actions.")) {
      actionName = actionName.substring(8);
    }
    return { actionName, payload: {} };
  }

  // Object format: { "0": "@actions.doSomething", "customKey": "value" }
  if (value && typeof value === "object") {
    const plain = toPlainObject(value) as Record<string, unknown>;
    const payload: Record<string, unknown> = {};
    let actionName: string | null = null;

    if (plain && typeof plain === "object") {
      const actionValue = plain["0"];
      if (typeof actionValue === "string" && actionValue.startsWith("@")) {
        actionName = actionValue.substring(1);
        if (actionName.startsWith("actions.")) {
          actionName = actionName.substring(8);
        }
      }

      // Transaction-animation stamp: ONLY the applicator's own named
      // `animate:` argument (the args object's `animate` key, before any
      // positional-payload merging) is reserved. An `animate` key inside a
      // merged positional payload object is user data, not a stamp.
      const hasAnimate = Object.prototype.hasOwnProperty.call(plain, "animate");
      const animate = hasAnimate ? plain["animate"] : undefined;

      for (const [key, val] of Object.entries(plain)) {
        if (key !== "0" && !(hasAnimate && key === "animate")) {
          // If the key is numeric (like "1", "2") and the value is an object,
          // merge the object's keys into the payload directly.
          // This handles: .onClick("@actions.foo", { id: "123" })
          // where the second positional arg becomes "1": { id: "123" }
          if (/^\d+$/.test(key) && val && typeof val === "object" && !Array.isArray(val)) {
            for (const [innerKey, innerVal] of Object.entries(val)) {
              payload[innerKey] = innerVal;
            }
          } else {
            payload[key] = val;
          }
        }
      }

      if (hasAnimate) {
        return { actionName, payload, animate };
      }
    }

    return { actionName, payload };
  }

  return { actionName: null, payload: {} };
}

/**
 * Attach a transaction-animation stamp to a dispatch payload under the
 * reserved cross-boundary key (see `ACTION_ANIMATE_KEY` in core types).
 * `BaseEngine.onAction` lifts it back out into `Action.animate`; module
 * handlers never see the key. No-op (same payload object) without a stamp.
 */
function withAnimateStamp(
  payload: Record<string, unknown>,
  animate: unknown
): Record<string, unknown> {
  if (animate === undefined) return payload;
  return { ...payload, [ACTION_ANIMATE_KEY]: animate };
}

/**
 * Extract relevant data from a DOM event
 */
function extractEventData(event: Event, element: HTMLElement): Record<string, unknown> {
  const data: Record<string, unknown> = {
    type: event.type,
    timestamp: Date.now(),
  };

  // Mouse events
  if (event instanceof MouseEvent) {
    data.clientX = event.clientX;
    data.clientY = event.clientY;
    data.button = event.button;
  }

  // Keyboard events
  if (event instanceof KeyboardEvent) {
    data.key = event.key;
    data.code = event.code;
    data.ctrlKey = event.ctrlKey;
    data.shiftKey = event.shiftKey;
    data.altKey = event.altKey;
    data.metaKey = event.metaKey;
  }

  // Input element values
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    data.value = element.value;
  }

  // Select element values
  if (element instanceof HTMLSelectElement) {
    data.value = element.value;
    data.selectedIndex = element.selectedIndex;
  }

  // Form data
  if (event.type === "submit" && element instanceof HTMLFormElement) {
    data.formData = new FormData(element);
  }

  return data;
}


/**
 * Capitalize first letter of a string
 */
function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// ============================================================================
// Event Handler Factory
// ============================================================================


/**
 * Create an event handler applicator with common boilerplate
 */
function createEventHandler(
  eventType: string,
  options: EventHandlerOptions = {}
): ApplicatorHandler {
  const actionMetaKey = `event:${eventType}`;
  return (element: HTMLElement, value: unknown) => {
    const { actionName, payload: customPayload, animate } = extractActionDetails(value);

    if (!actionName) {
      log.warn(`${eventType} requires an action reference starting with @, got:`, value);
      return;
    }

    // Store the current action on the element; the persistent listener reads
    // it per event, so re-applying with a different action (e.g. a keyed-
    // reused node) replaces the dispatch target instead of stacking listeners.
    setMeta(element, actionMetaKey, { actionName, customPayload, animate });

    const disposables = getElementDisposables(element);

    // Track that we've registered this event type
    // The disposable stack handles cleanup automatically
    const eventKey = eventType;
    if (getRegisteredEvents(element).has(eventKey)) {
      // Listener already installed — the meta update above retargets it
      return;
    }
    registerEvent(element, eventKey);
    markInteractive(element);

    // Create throttle state if needed
    let throttleTimer: Disposable | null = null;

    // Create the event listener
    const listener = (event: Event) => {
      const current = getMeta<{
        actionName: string;
        customPayload: Record<string, unknown>;
        animate?: unknown;
      }>(element, actionMetaKey);
      if (!current) return;

      // Exit-animating subtrees are visually leaving and their engine-side
      // ids are already dead — drop dispatches instead of firing ghosts.
      if (isInExitingSubtree(element)) return;

      // Handle throttling
      if (options.throttleMs && throttleTimer) {
        return;
      }

      if (options.throttleMs) {
        throttleTimer = disposableTimeout(() => {
          throttleTimer = null;
        }, options.throttleMs);
      }

      // Handle preventDefault
      if (options.preventDefault) {
        event.preventDefault();
      }

      // Build payload
      const base =
        Object.keys(current.customPayload).length > 0
          ? { ...current.customPayload }
          : options.extractPayload
            ? options.extractPayload(event, element)
            : extractEventData(event, element);
      // Components that know what an event *means* (a chart mark resolving
      // the datum under the pointer) contribute on top of either branch.
      const resolver = getPayloadResolver(element);
      const resolved = resolver ? resolver(event) : undefined;
      const payload = resolved ? { ...base, ...resolved } : base;

      // Dispatch to engine, catching any async rejections
      const engine = getEngine(element);
      if (engine) {
        try {
          dispatchUIAction(engine, element.dataset.hypenId,
            current.actionName,
            withAnimateStamp(payload, current.animate)
          );
        } catch (err) {
          log.error(`Error dispatching action "${current.actionName}":`, err);
        }
      }
    };

    // Register the listener using disposable pattern
    disposables.add(
      disposableListener(element, eventType, listener, {
        passive: options.passive,
      })
    );

    // Clean up registered events tracking on dispose
    disposables.addCallback(() => {
      unregisterEvent(element, eventKey);
      if (throttleTimer) {
        throttleTimer.dispose();
      }
    });
  };
}

/**
 * Element meta key under which the DnD runtime installs a files-zone gate
 * (`(event) => boolean`) on a `.dropZone(files: true)` node. When present,
 * `.onFileDragEnter` on that same node fires only if the gate passes (zone
 * enabled, `accept:` matched) — the zone and the handler share ONE entry
 * signal, so a node with both never double-fires. Absent ⇒ the node is not a
 * files zone and `.onFileDragEnter` does nothing (same on every renderer).
 */
export const FILE_DRAG_GATE_META = "dnd:fileDragGate";

/**
 * `.onFileDragEnter(@actions.x)` — files dragged in from outside the page
 * entered this `.dropZone(files: true)`. On a node that is not a files zone
 * it is inert, as on every other renderer.
 *
 * This is a plain UI signal, never a file channel: the payload carries only
 * how many items the drag holds, never names or contents (browsers hide both
 * until drop anyway). An app answers it by asking the device plane for files
 * (`context.device.request("file.pick", …)`); the DeviceHost's own dialog —
 * which carries a host-owned drop zone — pops up under the still-held drag,
 * and the user releases the files there. Renderers stay pure patch consumers.
 *
 * Fires once per entry (nested children's enter/leave pairs are counted, not
 * re-fired). A drop that lands on this element instead is swallowed so the
 * browser never navigates away to the dropped file.
 */
function createFileDragEnterHandler(): ApplicatorHandler {
  const metaKey = "event:filedragenter";
  return (element: HTMLElement, value: unknown) => {
    const { actionName, payload: customPayload } = extractActionDetails(value);
    if (!actionName) {
      log.warn("onFileDragEnter requires an action reference starting with @, got:", value);
      return;
    }
    setMeta(element, metaKey, { actionName, customPayload });

    const eventKey = "filedragenter";
    if (getRegisteredEvents(element).has(eventKey)) return;
    registerEvent(element, eventKey);

    const disposables = getElementDisposables(element);
    let depth = 0;
    const zoneGate = () => getMeta<(event: Event) => boolean>(element, FILE_DRAG_GATE_META);
    const onEnter = (event: Event) => {
      if (!dragCarriesFiles(event)) return;
      const gate = zoneGate();
      if (!gate) return;
      event.preventDefault();
      depth += 1;
      if (depth > 1) return;
      const current = getMeta<{ actionName: string; customPayload: Record<string, unknown> }>(element, metaKey);
      if (!current || isInExitingSubtree(element)) return;
      if (!gate(event)) return;
      const items = dragItemCount(event);
      const payload =
        Object.keys(current.customPayload).length > 0
          ? { ...current.customPayload }
          : { type: "filedragenter", timestamp: Date.now(), items };
      const engine = getEngine(element);
      if (!engine) return;
      try {
        dispatchUIAction(engine, element.dataset.hypenId, current.actionName, payload);
      } catch (err) {
        log.error(`Error dispatching action "${current.actionName}":`, err);
      }
    };
    const onLeave = () => {
      depth = Math.max(0, depth - 1);
    };
    const onOver = (event: Event) => {
      if (!dragCarriesFiles(event) || !zoneGate()) return;
      // Not a drop target for the files themselves: show "none", but keep the
      // default from running so a stray release is swallowed below.
      event.preventDefault();
      const dt = (event as DragEvent).dataTransfer;
      if (dt) dt.dropEffect = "none";
    };
    const onDrop = (event: Event) => {
      depth = 0;
      if (dragCarriesFiles(event) && zoneGate()) event.preventDefault();
    };
    disposables.add(disposableListener(element, "dragenter", onEnter));
    disposables.add(disposableListener(element, "dragleave", onLeave));
    disposables.add(disposableListener(element, "dragover", onOver));
    disposables.add(disposableListener(element, "drop", onDrop));
    disposables.addCallback(() => unregisterEvent(element, eventKey));
  };
}

/**
 * Dispatch the action encoded in an applicator value (e.g. `"@actions.save"`)
 * to the element's engine. Shared by click wiring and keyboard activation so
 * both routes dispatch identically. No-op if the value carries no action or
 * the element has no engine.
 */
export function triggerElementAction(element: HTMLElement, value: unknown): void {
  const { actionName, payload, animate } = extractActionDetails(value);
  if (!actionName) return;
  const engine = getEngine(element);
  if (!engine) return;
  try {
    dispatchUIAction(engine, element.dataset.hypenId, actionName, withAnimateStamp(payload, animate));
  } catch (err) {
    log.error(`Error dispatching action "${actionName}":`, err);
  }
}

/**
 * Dispatch an already-resolved action (name + payload) to the element's
 * engine with the optional transaction-animation stamp attached. The
 * renderer-resident runtimes (DnD) build their own payloads and route them
 * here so a `.onSort(@a, animate: spring)` stamps exactly like a click.
 */
export function dispatchElementAction(
  element: HTMLElement,
  actionName: string,
  payload: Record<string, unknown>,
  animate?: unknown,
  fromNode?: string
): boolean {
  const engine = getEngine(element);
  if (!engine) return false;
  try {
    dispatchUIAction(engine, element.dataset.hypenId, actionName, withAnimateStamp(payload, animate), fromNode);
    return true;
  } catch (err) {
    log.error(`Error dispatching action "${actionName}":`, err);
    return false;
  }
}

// ============================================================================
// Drag & drop event applicators (DnD plan §2.2 / §4.2)
// ============================================================================

/**
 * A stored DnD event applicator (`.onDragStart` … `.onDragEnd`). Unlike the
 * DOM-listener events these attach NO listener: the drag runtime
 * (`dom/dnd.ts`) owns the gesture and reads the binding at dispatch time,
 * so a re-apply with a different action retargets it exactly like the
 * click path. `dwell` is the reserved named argument of `.onDragOver`
 * (stripped from the payload, like `animate:`); `null` for the others or
 * when absent (the runtime applies the 500ms default).
 */
export interface DndEventBinding {
  actionName: string;
  /** Extra named arguments the author passed (merged UNDER the §4.2 payload). */
  customPayload: Record<string, unknown>;
  animate?: unknown;
  dwell: number | null;
}

const dndMetaKey = (name: DndEventName): string => `dnd:${name}`;

/** Read the stored `.on<DndEvent>` binding of an element, if any. */
export function getDndEventBinding(
  element: HTMLElement,
  name: DndEventName
): DndEventBinding | undefined {
  return getMeta<DndEventBinding | null>(element, dndMetaKey(name)) ?? undefined;
}

function createDndEventHandler(name: DndEventName): ApplicatorHandler {
  return (element: HTMLElement, value: unknown) => {
    const { actionName, payload, animate } = extractActionDetails(value);
    if (!actionName) {
      // A value without an action (e.g. the removeProp path merging the
      // args away) clears the stored binding.
      setMeta(element, dndMetaKey(name), null);
      return;
    }
    let dwell: number | null = null;
    if (name === "onDragOver" && Object.prototype.hasOwnProperty.call(payload, DND_DRAG_OVER_DWELL_KEY)) {
      const raw = payload[DND_DRAG_OVER_DWELL_KEY];
      const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
      if (Number.isFinite(n) && n >= 0) {
        dwell = n;
      } else {
        log.warn(`onDragOver dwell must be a non-negative number, got:`, raw);
      }
      delete payload[DND_DRAG_OVER_DWELL_KEY];
    }
    const binding: DndEventBinding = { actionName, customPayload: payload, dwell };
    if (animate !== undefined) binding.animate = animate;
    setMeta(element, dndMetaKey(name), binding);
  };
}

const DND_WRITE_TARGET_META = "dnd:writeTarget";

/**
 * Mark an element as a DnD write target (`__dnd.sort` / `__dnd.pin`): its
 * `bind` prop is the reorder/pin path the SDK writes, not a form-control
 * two-way binding, so the `bind` applicator must leave it alone. Set by the
 * renderer BEFORE the create-time applicators run.
 */
export function markDndWriteTarget(element: HTMLElement, isTarget: boolean): void {
  setMeta(element, DND_WRITE_TARGET_META, isTarget ? true : undefined);
}

export function isDndWriteTarget(element: HTMLElement): boolean {
  return getMeta<boolean>(element, DND_WRITE_TARGET_META) === true;
}

const dndEventHandlers: Record<string, ApplicatorHandler> = Object.fromEntries(
  DND_EVENT_NAMES.map((name) => [name, createDndEventHandler(name)])
);

/**
 * Create a keyboard event handler that filters by key
 */
function createKeyHandler(defaultKey: string = "Enter"): ApplicatorHandler {
  return (element: HTMLElement, value: unknown) => {
    const { actionName, payload: customPayload, animate } = extractActionDetails(value);

    if (!actionName) {
      log.warn(`onKey requires an action reference starting with @, got:`, value);
      return;
    }

    const disposables = getElementDisposables(element);

    const eventKey = `keydown:${actionName}:${defaultKey}`;
    if (getRegisteredEvents(element).has(eventKey)) {
      return;
    }
    registerEvent(element, eventKey);
    markInteractive(element);

    // Get target key from element data or use default
    const targetKey = getKeyTarget(element) || defaultKey;
    const keyToMatch = targetKey.toLowerCase() === "return" ? "Enter" : targetKey;

    const listener = (event: Event) => {
      const keyEvent = event as KeyboardEvent;
      if (keyEvent.key !== keyToMatch) {
        return;
      }

      event.preventDefault();

      const target = event.target as HTMLInputElement | HTMLTextAreaElement;
      const payload =
        Object.keys(customPayload).length > 0
          ? { ...customPayload }
          : {
              type: event.type,
              timestamp: Date.now(),
              key: keyEvent.key,
              code: keyEvent.code,
              value: target.value,
              input: target.value,
              ctrlKey: keyEvent.ctrlKey,
              shiftKey: keyEvent.shiftKey,
              altKey: keyEvent.altKey,
              metaKey: keyEvent.metaKey,
            };

      const engine = getEngine(element);
      if (engine) {
        dispatchUIAction(engine, element.dataset.hypenId, actionName, withAnimateStamp(payload, animate));
      }
    };

    disposables.add(disposableListener(element, "keydown", listener));
    disposables.addCallback(() => {
      unregisterEvent(element, eventKey);
    });
  };
}

/**
 * Create a long-click/long-press handler
 */
function createLongClickHandler(thresholdMs: number = 500): ApplicatorHandler {
  return (element: HTMLElement, value: unknown) => {
    const { actionName, payload: customPayload, animate } = extractActionDetails(value);

    if (!actionName) {
      log.warn(`onLongClick requires an action reference starting with @, got:`, value);
      return;
    }

    const disposables = getElementDisposables(element);

    const eventKey = `longclick:${actionName}`;
    if (getRegisteredEvents(element).has(eventKey)) {
      return;
    }
    registerEvent(element, eventKey);
    markInteractive(element);

    let longClickTimer: Disposable | null = null;

    const downListener = (event: Event) => {
      const pointerEvent = event as PointerEvent;

      longClickTimer = disposableTimeout(() => {
        const payload =
          Object.keys(customPayload).length > 0
            ? { ...customPayload }
            : {
                type: "longclick",
                timestamp: Date.now(),
                clientX: pointerEvent.clientX,
                clientY: pointerEvent.clientY,
              };

        const engine = getEngine(element);
        if (engine) {
          dispatchUIAction(engine, element.dataset.hypenId, actionName, withAnimateStamp(payload, animate));
        }

        longClickTimer = null;
      }, thresholdMs);
    };

    const cancelListener = () => {
      if (longClickTimer) {
        longClickTimer.dispose();
        longClickTimer = null;
      }
    };

    disposables.add(disposableListener(element, "pointerdown", downListener));
    disposables.add(disposableListener(element, "pointerup", cancelListener));
    disposables.add(disposableListener(element, "pointerleave", cancelListener));
    disposables.addCallback(() => {
      unregisterEvent(element, eventKey);
      cancelListener();
    });
  };
}

// ============================================================================
// Payload Extractors
// ============================================================================

const inputPayload = (event: Event, element: HTMLElement): Record<string, unknown> => {
  const target = element as HTMLInputElement | HTMLTextAreaElement;
  return {
    type: event.type,
    timestamp: Date.now(),
    value: target.value,
    input: target.value,
  };
};

const scrollPayload = (_event: Event, element: HTMLElement): Record<string, unknown> => {
  const scrollTop = element.scrollTop;
  const scrollHeight = element.scrollHeight;
  const clientHeight = element.clientHeight;
  const scrollPercentage =
    scrollHeight - clientHeight > 0
      ? (scrollTop / (scrollHeight - clientHeight)) * 100
      : 0;

  const nearBottom =
    scrollHeight - scrollTop - clientHeight < 100 || scrollPercentage > 90;

  return {
    type: "scroll",
    timestamp: Date.now(),
    scrollTop,
    scrollLeft: element.scrollLeft,
    scrollHeight,
    scrollWidth: element.scrollWidth,
    clientHeight,
    clientWidth: element.clientWidth,
    scrollPercentage: Math.round(scrollPercentage),
    nearBottom,
    atBottom: scrollHeight - scrollTop === clientHeight,
    atTop: scrollTop === 0,
  };
};

const focusPayload = (event: Event, element: HTMLElement): Record<string, unknown> => ({
  type: event.type,
  timestamp: Date.now(),
  value: (element as HTMLInputElement).value ?? undefined,
});

const mousePayload = (event: Event, _element: HTMLElement): Record<string, unknown> => {
  const mouseEvent = event as MouseEvent;
  return {
    type: event.type,
    timestamp: Date.now(),
    clientX: mouseEvent.clientX,
    clientY: mouseEvent.clientY,
  };
};

// ============================================================================
// Event Handlers Export
// ============================================================================

/** Injected once per document: in fullscreen the wrapper covers the
 * viewport (UA stylesheet), the surface must fill it, and the author's
 * aspect-ratio must yield. Slot overlays are absolute within the wrapper
 * and ride along untouched. */
function ensureFullscreenStyles(doc: Document | null): void {
  if (!doc || doc.getElementById?.("hypen-video-fullscreen-style")) return;
  try {
    const style = doc.createElement("style");
    style.id = "hypen-video-fullscreen-style";
    style.textContent =
      "[data-hypen-video-state]:fullscreen{aspect-ratio:auto !important;max-width:none !important;margin:0 !important;border-radius:0 !important;}" +
      "[data-hypen-video-state]:fullscreen [data-hypen-video-surface]{width:100% !important;height:100% !important;object-fit:contain;}";
    doc.head?.appendChild?.(style);
  } catch {
    // Headless/fake documents without <head> — fullscreen still works,
    // sizing just relies on the UA stylesheet.
  }
}

export const eventHandlers: Record<string, ApplicatorHandler> = {
  // Basic click/press
  onClick: createEventHandler("click"),
  onPress: createEventHandler("click"), // Alias for mobile-style naming

  // Form events
  onChange: createEventHandler("change"),
  onSubmit: createEventHandler("submit", { preventDefault: true }),
  onInput: createEventHandler("input", { extractPayload: inputPayload }),

  // Keyboard events
  onKey: createKeyHandler("Enter"),
  "onKey.key": (element: HTMLElement, value: unknown) => {
    // Store the target key for the action handler to use
    setKeyTarget(element, String(value));
  },
  "onKey.action": createKeyHandler("Enter"),

  // Scroll (throttled)
  onScroll: createEventHandler("scroll", {
    throttleMs: 100,
    passive: true,
    extractPayload: scrollPayload,
  }),

  // Long click/press
  onLongClick: createLongClickHandler(500),
  onLongPress: createLongClickHandler(500), // Alias for mobile-style naming

  // Focus events
  onFocus: createEventHandler("focus", { extractPayload: focusPayload }),
  onBlur: createEventHandler("blur", { extractPayload: focusPayload }),

  // Mouse hover events
  onMouseEnter: createEventHandler("mouseenter", { extractPayload: mousePayload }),
  onMouseLeave: createEventHandler("mouseleave", { extractPayload: mousePayload }),
  onHover: createEventHandler("mouseenter", { extractPayload: mousePayload }), // Alias for onMouseEnter
  // Pointer tracking across an element (mouse, touch and pen alike), throttled
  // to roughly a frame. `onHover` fires once on entry; this follows the pointer
  // — a chart crosshair or a scrubbed tooltip wants this one.
  // Files dragged in from outside the page entered the element (a UI signal
  // only — see createFileDragEnterHandler).
  onFileDragEnter: createFileDragEnterHandler(),
  onMove: createEventHandler("pointermove", {
    throttleMs: 32,
    passive: true,
    extractPayload: mousePayload,
  }),

  // Animation completion (Option F). Registered here so the event-applicator
  // path (`/^on[A-Z]/`, aggregate arg merging) matches it, but unlike every
  // other event it attaches NO DOM listener: it stores the action on the
  // element, and the DomAnimator dispatches it when a playback settles
  // naturally (see anim-complete.ts). A value without an action (e.g. the
  // removeProp path merging the args away) clears the stored action.
  onAnimationComplete: ((element: HTMLElement, value: unknown) => {
    const { actionName, payload } = extractActionDetails(value);
    setAnimationCompleteAction(
      element,
      actionName ? { actionName, customPayload: payload } : null
    );
  }) as ApplicatorHandler,

  // Renderer-local video intents (.videoIntent("fullscreen")). Fullscreen
  // MUST run inside the user gesture — a server round trip can lose
  // transient activation — and it targets the v2 VIDEO WRAPPER, never the
  // raw <video>: fullscreening the wrapper keeps the composition slots
  // (custom controls) overlaid; fullscreening the element would swap in
  // the browser's native fullscreen chrome.
  videoIntent: ((element: HTMLElement, value: unknown) => {
    const intent = typeof value === "string" ? value : null;
    if (intent !== "fullscreen") return;
    element.dataset.hypenVideoIntent = intent;
    const eventKey = "videoIntent:fullscreen";
    if (getRegisteredEvents(element).has(eventKey)) return;
    registerEvent(element, eventKey);
    markInteractive(element);
    ensureFullscreenStyles(element.ownerDocument);
    const disposables = getElementDisposables(element);
    disposables.add(
      disposableListener(element, "click", () => {
        let wrapper: HTMLElement | null = element;
        while (wrapper && wrapper.dataset?.hypenVideoState === undefined) {
          wrapper = (wrapper.parentElement ??
            (wrapper.parentNode as HTMLElement | null)) as HTMLElement | null;
        }
        if (!wrapper) return;
        const doc = (element.ownerDocument ?? globalThis.document) as Document;
        if (doc?.fullscreenElement === wrapper) {
          void doc.exitFullscreen?.();
        } else {
          void (wrapper as HTMLElement & { requestFullscreen?: () => Promise<void> })
            .requestFullscreen?.();
        }
      })
    );
  }) as ApplicatorHandler,

  // Drag & drop lifecycle events: stored on the element for the DnD runtime,
  // no DOM listener (see createDndEventHandler).
  ...dndEventHandlers,

  // Two-way binding for .bind(@state.x)
  bind: ((element: HTMLElement, value: unknown) => {
    const bindPath = typeof value === "string" ? value : null;
    if (!bindPath) return;

    // `.sortable().bind(@state.list)` / `.pinboard().bind(@state.items)`:
    // the path is the DnD write target the runtime dispatches
    // `__hypen_reorder` / `__hypen_pin` against — not a form-control
    // binding. Nothing to wire here (DnD plan §6 item 9).
    if (isDndWriteTarget(element)) return;

    const disposables = getElementDisposables(element);
    const eventKey = `bind:${bindPath}`;
    if (getRegisteredEvents(element).has(eventKey)) return;
    registerEvent(element, eventKey);
    markInteractive(element);

    // Determine the target element, event type, and value extractor based on component type
    const hypenType = element.dataset?.hypenType;

    if (hypenType === "video" || hypenType === "scrubber") {
      // Media components own their bind channel: Video keeps the playback
      // struct ({playing, position, duration, state}) in sync from media
      // events, and Scrubber writes `position` on drag release. Both read
      // the path from their own `bind` prop (routed to their handler via
      // COMPONENT_HTML_ATTRS), so there is nothing to wire here.
      unregisterEvent(element, eventKey);
      return;
    }

    if (hypenType === "checkbox" || hypenType === "switch") {
      // Checkbox/Switch: wrapper <label> containing <input type="checkbox">
      const input = element.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
      if (!input) return;

      const listener = () => {
        const engine = getEngine(element);
        if (engine) {
          dispatchUIAction(engine, element.dataset.hypenId, "__hypen_bind", {
            path: bindPath,
            value: input.checked,
          });
        }
      };

      disposables.add(
        disposableListener(input, "change", listener, { passive: true })
      );
    } else if (element instanceof HTMLSelectElement) {
      // Select: listen to change event, read .value
      const listener = () => {
        const engine = getEngine(element);
        if (engine) {
          dispatchUIAction(engine, element.dataset.hypenId, "__hypen_bind", {
            path: bindPath,
            value: element.value,
          });
        }
      };

      disposables.add(
        disposableListener(element, "change", listener, { passive: true })
      );
    } else if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement
    ) {
      // Input/Textarea: listen to input event, read .value
      const listener = () => {
        const engine = getEngine(element);
        if (engine) {
          dispatchUIAction(engine, element.dataset.hypenId, "__hypen_bind", {
            path: bindPath,
            value: element.value,
          });
        }
      };

      disposables.add(
        disposableListener(element, "input", listener, { passive: true })
      );
    } else {
      log.warn(
        `.bind() is not supported on element type "${element.dataset?.hypenType || element.tagName}". ` +
        `Supported types: input, textarea, checkbox, switch, select.`
      );
      unregisterEvent(element, eventKey);
      return;
    }

    disposables.addCallback(() => unregisterEvent(element, eventKey));
  }) as ApplicatorHandler,
};
