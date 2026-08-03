/**
 * HypenApp Component
 *
 * Embeds a remote Hypen app via WebSocket.
 *
 * Usage in Hypen DSL:
 * ```hypen
 * HypenApp("ws://localhost:3000")
 *
 * // Or with named prop:
 * HypenApp(url: "ws://localhost:3000")
 * ```
 *
 * The embedded app is rendered by a full `DOMRenderer` driven by its own
 * `RemoteEngine` — the exact pairing the generic client uses at top level —
 * so embedded apps get identical styling, event dispatch, router patch
 * handling, and a11y behavior to a standalone page. (Route-change focus is
 * disabled: the *host* app owns focus management; an embedded frame stealing
 * focus on its internal navigations would fight it.)
 */

import type { ComponentHandler } from "./index.js";
import { RemoteEngine } from "@hypen-space/core/remote/client";
import type { Patch } from "@hypen-space/core/types";
import { getElementDisposables } from "@hypen-space/core/disposable";
import { frameworkLoggers } from "@hypen-space/core/logger";
import type { DOMRenderer } from "../renderer.js";

const log = frameworkLoggers.remote;

interface HypenAppInstance {
  engine: RemoteEngine;
  renderer: DOMRenderer;
  url: string;
}

// Store active HypenApp instances for cleanup
const activeInstances = new WeakMap<HTMLElement, HypenAppInstance>();

export const hypenAppHandler: ComponentHandler = {
  create(): HTMLElement {
    const el = document.createElement("div");
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

    const existing = activeInstances.get(element);
    if (existing) {
      if (existing.url === url) return; // Already connected to this app
      // URL changed — tear down and reconnect below.
      existing.engine.disconnect();
      activeInstances.delete(element);
      element.innerHTML = "";
    }

    // Lazy-required to break the static cycle:
    // renderer.ts → components/index.ts → hypenapp.ts → renderer.ts
    const { DOMRenderer: Renderer } =
      require("../renderer.js") as typeof import("../renderer.js");

    const engine = new RemoteEngine(url, {
      autoReconnect: props.autoReconnect ?? true,
      reconnectInterval: props.reconnectInterval ?? 3000,
      maxReconnectAttempts: props.maxReconnectAttempts ?? 10,
    });

    const renderer = new Renderer(element, engine, undefined, { routeFocus: "off" });
    activeInstances.set(element, { engine, renderer, url });

    // Show a loading placeholder until the initial tree arrives.
    const loading = document.createElement("div");
    loading.className = "hypen-app-loading";
    loading.textContent = "Connecting...";
    element.appendChild(loading);
    const clearLoading = () => {
      if (loading.parentNode) loading.parentNode.removeChild(loading);
    };

    // Same replacement-root handling as the generic client: a fresh root
    // insert after we've already rendered one means "replace the tree".
    let hasRenderedRoot = false;
    engine.onPatches((patches: Patch[]) => {
      clearLoading();
      const createdIds = new Set(
        patches.filter((patch) => patch.type === "create").map((patch) => patch.id),
      );
      const hasReplacementRoot = patches.some(
        (patch) =>
          patch.type === "insert" &&
          patch.parentId === "root" &&
          createdIds.has(patch.id),
      );
      if (hasReplacementRoot && hasRenderedRoot) {
        renderer.clear();
      }
      renderer.applyPatches(patches);
      hasRenderedRoot = hasRenderedRoot || hasReplacementRoot;
    });

    engine
      .connect()
      .then((result: any) => {
        if (result && result.ok === false) {
          clearLoading();
          element.innerHTML = `<div style="color: red;">HypenApp: Connection failed - ${result.error?.message ?? result.error}</div>`;
          log.error("HypenApp connection failed:", result.error);
          return;
        }
        log.debug(`HypenApp connected to ${url}`);
      })
      .catch((error: Error) => {
        clearLoading();
        element.innerHTML = `<div style="color: red;">HypenApp: Connection failed - ${error.message}</div>`;
        log.error("HypenApp connection failed:", error);
      });

    engine.onDisconnect(() => {
      log.debug("HypenApp disconnected");
    });

    engine.onError((error) => {
      log.error("HypenApp error:", error);
    });

    // Cleanup rides the renderer's element-disposal channel: the host
    // DOMRenderer runs this on a real `remove` patch (and on `clear()`),
    // but NOT on a Router `detach` — so a cached route keeps its live
    // connection and re-attaches warm, while LRU eviction closes it.
    getElementDisposables(element).addCallback(() => {
      engine.disconnect();
      activeInstances.delete(element);
      log.debug("HypenApp cleaned up");
    });
  },
};

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
