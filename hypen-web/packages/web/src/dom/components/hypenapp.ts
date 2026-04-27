/**
 * HypenApp Component
 *
 * Embeds a remote Hypen app via WebSocket
 *
 * Usage in Hypen DSL:
 * ```hypen
 * HypenApp("ws://localhost:3000")
 *
 * // Or with named prop:
 * HypenApp(url: "ws://localhost:3000")
 * ```
 */

import type { ComponentHandler } from "./index.js";
import { RemoteEngine } from "@hypen-space/core/remote/client";
import type { Patch } from "@hypen-space/core/types";
import { frameworkLoggers } from "@hypen-space/core/logger";

const log = frameworkLoggers.remote;

// Store active HypenApp instances for cleanup
const activeInstances = new WeakMap<
  HTMLElement,
  {
    engine: RemoteEngine;
    nodes: Map<string, HTMLElement>;
  }
>();

export const hypenAppHandler: ComponentHandler = {
  create(doc: Document): HTMLElement {
    const el = doc.createElement("div");
    el.dataset.hypenType = "hypenapp";
    el.style.display = "contents"; // Don't affect layout
    return el;
  },

  applyProps(element: HTMLElement, props: Record<string, any>): void {
    // Get URL from props (can be positional "0" or named "url")
    const url = props["0"] || props.url;

    if (!url || typeof url !== "string") {
      log.error("HypenApp: URL is required");
      element.innerHTML = '<div style="color: red;">HypenApp: URL required</div>';
      return;
    }

    // Check if already connected
    const existing = activeInstances.get(element);
    if (existing) {
      // Already connected, don't reconnect
      return;
    }

    // Create the remote engine
    const engine = new RemoteEngine(url, {
      autoReconnect: props.autoReconnect ?? true,
      reconnectInterval: props.reconnectInterval ?? 3000,
      maxReconnectAttempts: props.maxReconnectAttempts ?? 10,
    });

    // Map to track created nodes
    const nodes = new Map<string, HTMLElement>();
    let rootId: string | null = null;

    // Store instance for cleanup
    activeInstances.set(element, { engine, nodes });

    // Set up patch handling
    engine.onPatches((patches) => {
      applyPatches(element, nodes, patches, engine, (id) => {
        if (!rootId) rootId = id;
      });
    });

    // Show loading state
    element.innerHTML = '<div class="hypen-app-loading">Connecting...</div>';

    // Connect
    engine
      .connect()
      .then(() => {
        // Clear loading state - patches will populate content
        element.innerHTML = "";
        log.debug(`HypenApp connected to ${url}`);
      })
      .catch((error) => {
        element.innerHTML = `<div style="color: red;">HypenApp: Connection failed - ${error.message}</div>`;
        log.error("HypenApp connection failed:", error);
      });

    // Handle disconnection
    engine.onDisconnect(() => {
      log.debug("HypenApp disconnected");
    });

    engine.onError((error) => {
      log.error("HypenApp error:", error);
    });

    // Cleanup on element removal
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const removedNode of mutation.removedNodes) {
          if (removedNode === element || (removedNode as Element).contains?.(element)) {
            engine.disconnect();
            activeInstances.delete(element);
            observer.disconnect();
            log.debug("HypenApp cleaned up");
            return;
          }
        }
      }
    });

    // Observe parent for removal
    if (element.parentNode) {
      observer.observe(element.parentNode, { childList: true, subtree: true });
    }
  },
};

/**
 * Minimal patch application for HypenApp container
 */
function applyPatches(
  container: HTMLElement,
  nodes: Map<string, HTMLElement>,
  patches: Patch[],
  engine: RemoteEngine,
  onRoot: (id: string) => void
): void {
  for (const patch of patches) {
    switch (patch.type) {
      case "create": {
        const el = createElement(patch.elementType!, patch.props || {});
        el.dataset.hypenId = patch.id!;
        (el as any).__hypenEngine = engine;
        nodes.set(patch.id!, el);
        break;
      }

      case "setProp": {
        const el = nodes.get(patch.id!);
        if (el) {
          applyProp(el, patch.name!, patch.value);
        }
        break;
      }

      case "setText": {
        const el = nodes.get(patch.id!);
        if (el) {
          el.textContent = patch.text!;
        }
        break;
      }

      case "insert": {
        const parentId = patch.parentId!;
        const parent = parentId === "root" ? container : nodes.get(parentId);
        const child = nodes.get(patch.id!);
        const beforeId = patch.beforeId;

        if (parent && child) {
          if (parentId === "root") {
            onRoot(patch.id!);
          }

          if (beforeId) {
            const before = nodes.get(beforeId);
            if (before && before.parentNode === parent) {
              parent.insertBefore(child, before);
            } else if (!parent.contains(child)) {
              parent.appendChild(child);
            }
          } else if (!parent.contains(child)) {
            parent.appendChild(child);
          }
        }
        break;
      }

      case "move": {
        const parentId = patch.parentId!;
        const parent = parentId === "root" ? container : nodes.get(parentId);
        const child = nodes.get(patch.id!);
        const beforeId = patch.beforeId;

        if (parent && child) {
          if (beforeId) {
            const before = nodes.get(beforeId);
            if (before && before.parentNode === parent) {
              parent.insertBefore(child, before);
            }
          } else {
            parent.appendChild(child);
          }
        }
        break;
      }

      case "remove": {
        const el = nodes.get(patch.id!);
        if (el && el.parentNode) {
          el.parentNode.removeChild(el);
        }
        nodes.delete(patch.id!);
        break;
      }
    }
  }
}

/**
 * Create element by type
 */
function createElement(type: string, props: Record<string, any>): HTMLElement {
  const normalizedType = type.toLowerCase();

  // Map Hypen types to HTML elements
  const tagMap: Record<string, string> = {
    column: "div",
    row: "div",
    text: "span",
    button: "button",
    input: "input",
    image: "img",
    container: "div",
    box: "div",
    center: "div",
    list: "div",
    spacer: "div",
    stack: "div",
    divider: "hr",
    grid: "div",
    card: "div",
    heading: "h2",
    link: "a",
    textarea: "textarea",
    checkbox: "input",
    select: "select",
    slider: "input",
    switch: "input",
    spinner: "div",
    badge: "span",
    avatar: "img",
    progressbar: "div",
    video: "video",
    audio: "audio",
  };

  const tag = tagMap[normalizedType] || "div";
  const el = document.createElement(tag);
  el.dataset.hypenType = normalizedType;

  // Apply basic styles
  if (normalizedType === "column") {
    el.style.display = "flex";
    el.style.flexDirection = "column";
  } else if (normalizedType === "row") {
    el.style.display = "flex";
    el.style.flexDirection = "row";
  } else if (normalizedType === "center") {
    el.style.display = "flex";
    el.style.alignItems = "center";
    el.style.justifyContent = "center";
  } else if (normalizedType === "text") {
    // Text content from props
    if (props["0"]) {
      el.textContent = String(props["0"]);
    }
  } else if (normalizedType === "button") {
    el.style.cursor = "pointer";
  } else if (normalizedType === "checkbox" || normalizedType === "switch") {
    (el as HTMLInputElement).type = "checkbox";
  } else if (normalizedType === "slider") {
    (el as HTMLInputElement).type = "range";
  }

  return el;
}

/**
 * Apply a prop to an element
 */
function applyProp(el: HTMLElement, name: string, value: any): void {
  // Text content
  if (name === "0" || name === "text") {
    el.textContent = String(value);
    return;
  }

  // Style props
  const styleProps: Record<string, string> = {
    padding: "padding",
    margin: "margin",
    backgroundColor: "backgroundColor",
    background: "background",
    color: "color",
    fontSize: "fontSize",
    fontWeight: "fontWeight",
    width: "width",
    height: "height",
    minWidth: "minWidth",
    minHeight: "minHeight",
    maxWidth: "maxWidth",
    maxHeight: "maxHeight",
    borderRadius: "borderRadius",
    border: "border",
    gap: "gap",
    flex: "flex",
    opacity: "opacity",
    overflow: "overflow",
  };

  if (styleProps[name]) {
    const cssValue = typeof value === "number" ? `${value}px` : String(value);
    (el.style as any)[styleProps[name]] = cssValue;
    return;
  }

  // Event handlers
  if (name === "onClick" || name === "onclick") {
    el.onclick = () => {
      const engine = (el as any).__hypenEngine as RemoteEngine;
      if (engine && typeof value === "string" && value.startsWith("@actions.")) {
        const action = value.replace("@actions.", "");
        engine.dispatchAction(action);
      }
    };
    return;
  }

  // Other attributes
  el.setAttribute(name, String(value));
}

/**
 * Disconnect a HypenApp instance
 */
export function disconnectHypenApp(element: HTMLElement): void {
  const instance = activeInstances.get(element);
  if (instance) {
    instance.engine.disconnect();
    activeInstances.delete(element);
  }
}
