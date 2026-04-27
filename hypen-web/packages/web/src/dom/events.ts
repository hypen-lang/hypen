/**
 * Event Management System
 *
 * Handles DOM event binding and action dispatching
 */

import { frameworkLoggers } from "@hypen-space/core/logger";

const log = frameworkLoggers.events;

// Interface for the engine that EventManager needs
interface IEngine {
  dispatchAction(name: string, payload?: any): void;
}

export interface EventBinding {
  elementId: string;
  eventName: string;
  actionName: string;
}

export class EventManager {
  private engine: IEngine;
  private bindings: Map<string, Map<string, EventListener>> = new Map();

  constructor(engine: IEngine) {
    this.engine = engine;
  }

  /**
   * Attach an event listener to an element
   */
  attach(elementId: string, element: HTMLElement, eventName: string, actionName: string): void {
    // Convert onClick to click for DOM events
    const domEventName = eventName === "onClick" ? "click" : eventName;
    log.debug(`Attaching ${eventName} (DOM: ${domEventName}) to element ${elementId}, action: ${actionName}`);

    // Create event listener that dispatches action
    const listener = (event: Event) => {
      log.debug(`Event fired: ${eventName} on ${elementId}, dispatching action: ${actionName}`);
      log.debug(`Event object:`, event);
      log.debug(`Element:`, element);

      // Prevent default for certain events
      if (eventName === "submit" || (eventName === "click" && element.tagName === "A")) {
        event.preventDefault();
      }

      // Extract event data
      const payload = this.extractEventData(event, element);
      log.debug(`Event payload:`, payload);

      // Dispatch action to engine
      log.debug(`Calling engine.dispatchAction(${actionName})`);
      try {
        this.engine.dispatchAction(actionName, payload);
        log.debug(`dispatchAction succeeded`);
      } catch (error) {
        log.error(`dispatchAction failed:`, error);
      }
    };

    // Store listener reference using `domEventName` so `detach()` uses the correct name
    let elementBindings = this.bindings.get(elementId);
    if (!elementBindings) {
      elementBindings = new Map();
      this.bindings.set(elementId, elementBindings);
    }

    // Remove any previously attached listener for this event before overwriting,
    // otherwise the old DOM listener leaks and fires alongside the new one.
    const existingListener = elementBindings.get(domEventName);
    if (existingListener) {
      element.removeEventListener(domEventName, existingListener);
    }
    elementBindings.set(domEventName, listener);

    // Attach to DOM
    element.addEventListener(domEventName, listener);
    log.debug(`Listener attached to DOM for ${domEventName}`);
    log.debug(`Element details:`, {
      tagName: element.tagName,
      id: element.id,
      dataset: element.dataset,
      textContent: element.textContent?.substring(0, 50)
    });
  }

  /**
   * Detach an event listener from an element
   */
  detach(elementId: string, element: HTMLElement, eventName: string): void {
    // Convert framework event name to DOM event name, matching `attach()`
    const domEventName = eventName === "onClick" ? "click" : eventName;
    const elementBindings = this.bindings.get(elementId);
    if (!elementBindings) return;

    const listener = elementBindings.get(domEventName);
    if (listener) {
      element.removeEventListener(domEventName, listener);
      elementBindings.delete(domEventName);
    }

    if (elementBindings.size === 0) {
      this.bindings.delete(elementId);
    }
  }

  /**
   * Extract relevant data from an event
   */
  private extractEventData(event: Event, element: HTMLElement): any {
    const data: any = {
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

    // Input events (for form elements)
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      data.value = element.value;
    }

    // Select events
    if (element instanceof HTMLSelectElement) {
      data.value = element.value;
      data.selectedIndex = element.selectedIndex;
    }

    // Form events
    if (event.type === "submit" && element instanceof HTMLFormElement) {
      data.formData = new FormData(element);
    }

    return data;
  }

  /**
   * Clear all event bindings for an element
   */
  clearElement(elementId: string, element: HTMLElement): void {
    const elementBindings = this.bindings.get(elementId);
    if (!elementBindings) return;

    for (const [eventName, listener] of elementBindings) {
      element.removeEventListener(eventName, listener);
    }

    this.bindings.delete(elementId);
  }

  /**
   * Clear all event bindings
   */
  clearAll(): void {
    this.bindings.clear();
  }
}
