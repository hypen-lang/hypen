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
} from "../element-data.js";
import { isInExitingSubtree } from "../anim.js";
import { setAnimationCompleteAction } from "../anim-complete.js";

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
function extractActionDetails(value: unknown): {
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
      const payload =
        Object.keys(current.customPayload).length > 0
          ? { ...current.customPayload }
          : options.extractPayload
            ? options.extractPayload(event, element)
            : extractEventData(event, element);

      // Dispatch to engine, catching any async rejections
      const engine = getEngine(element);
      if (engine) {
        try {
          engine.dispatchAction(
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
    engine.dispatchAction(actionName, withAnimateStamp(payload, animate));
  } catch (err) {
    log.error(`Error dispatching action "${actionName}":`, err);
  }
}

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
        engine.dispatchAction(actionName, withAnimateStamp(payload, animate));
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
          engine.dispatchAction(actionName, withAnimateStamp(payload, animate));
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

  // Two-way binding for .bind(@state.x)
  bind: ((element: HTMLElement, value: unknown) => {
    const bindPath = typeof value === "string" ? value : null;
    if (!bindPath) return;

    const disposables = getElementDisposables(element);
    const eventKey = `bind:${bindPath}`;
    if (getRegisteredEvents(element).has(eventKey)) return;
    registerEvent(element, eventKey);

    // Determine the target element, event type, and value extractor based on component type
    const hypenType = element.dataset?.hypenType;

    if (hypenType === "checkbox" || hypenType === "switch") {
      // Checkbox/Switch: wrapper <label> containing <input type="checkbox">
      const input = element.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
      if (!input) return;

      const listener = () => {
        const engine = getEngine(element);
        if (engine) {
          engine.dispatchAction("__hypen_bind", {
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
          engine.dispatchAction("__hypen_bind", {
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
          engine.dispatchAction("__hypen_bind", {
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
