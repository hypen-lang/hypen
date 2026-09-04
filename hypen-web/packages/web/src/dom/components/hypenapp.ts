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
 *
 * // With custom loading / error UI via slot children:
 * HypenApp("ws://localhost:3000") {
 *     Column { Spinner() Text("Connecting to app...") }.slot("loading")
 *     Column { Text("Couldn't reach the app") }.slot("error")
 * }
 * ```
 *
 * Slot children are rendered by the *host* app (they're ordinary host
 * nodes with full access to host state and actions); the handler only
 * toggles their visibility as the connection moves through
 * loading → connected / error. Children without a recognized slot render
 * unconditionally. When a slot isn't provided, a built-in fallback is
 * used ("Connecting..." text / red error message).
 *
 * The embedded app is rendered by a full `DOMRenderer` driven by its own
 * `RemoteEngine` — the exact pairing the generic client uses at top level —
 * so embedded apps get identical styling, event dispatch, router patch
 * handling, and a11y behavior to a standalone page. (Route-change focus is
 * disabled: the *host* app owns focus management; an embedded frame stealing
 * focus on its internal navigations would fight it.) It renders into a
 * dedicated content wrapper so slot toggling and error handling never
 * touch host-owned slot children, and vice versa.
 */

import type { ComponentHandler } from "./index.js";
import { RemoteEngine } from "@hypen-space/core/remote/client";
import type { Patch } from "@hypen-space/core/types";
import { getElementDisposables } from "@hypen-space/core/disposable";
import { frameworkLoggers } from "@hypen-space/core/logger";
import { slotChildren, setVisible } from "../slots.js";
import type { DOMRenderer } from "../renderer.js";

const log = frameworkLoggers.remote;

export const LOADING_SLOT = "loading";
export const ERROR_SLOT = "error";

type EmbedStatus = "loading" | "connected" | "error";

interface HypenAppInstance {
  engine: RemoteEngine | null;
  renderer: DOMRenderer | null;
  visibility: SlotVisibilityController;
  url: string | null;
  dispose(): void;
}

// Store active HypenApp instances for cleanup
const activeInstances = new WeakMap<HTMLElement, HypenAppInstance>();

/**
 * Connection-state → visibility controller for one HypenApp container.
 *
 * Slot children arrive via Insert patches *after* the container's Create
 * (and can arrive/leave any time under ForEach/When), so DOMRenderer
 * synchronously refreshes this controller after child/slot changes.
 */
class SlotVisibilityController {
  private status: EmbedStatus = "loading";
  private errorMessage = "";
  private defaultLoading: HTMLElement | null = null;
  private defaultError: HTMLElement | null = null;
  private observer: MutationObserver | null = null;

  constructor(
    private element: HTMLElement,
    private contentHost: HTMLElement,
  ) {
    this.element.dataset.hypenAppStatus = this.status;
    // DOMRenderer handles patch-driven changes synchronously. Keep an
    // observer as a safety net for direct DOM manipulation by host code.
    if (typeof MutationObserver !== "undefined") {
      this.observer = new MutationObserver((mutations) => {
        const directSlotChanged = mutations.some((mutation) => {
          if (mutation.type === "childList") {
            return mutation.target === element;
          }
          return (mutation.target as HTMLElement).parentElement === element;
        });
        if (directSlotChanged) this.refresh();
      });
      this.observer.observe(element, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["data-hypen-slot"],
      });
    }
    this.refresh();
  }

  setStatus(status: EmbedStatus, errorMessage?: string): void {
    this.status = status;
    if (errorMessage !== undefined) this.errorMessage = errorMessage;
    this.element.dataset.hypenAppStatus = status;
    this.refresh();
  }

  /**
   * Re-read host-owned children after an insert/remove/move or slot prop
   * update. DOMRenderer calls this synchronously; MutationObserver remains a
   * safety net for consumers that manipulate the element outside patches.
   */
  refresh(): void {
    const showLoading = this.status === "loading";
    const showError = this.status === "error";

    const loadingSlots = slotChildren(this.element, LOADING_SLOT);
    const errorSlots = slotChildren(this.element, ERROR_SLOT);

    for (const el of loadingSlots) setVisible(el, showLoading);
    for (const el of errorSlots) setVisible(el, showError);

    // Built-in fallbacks only cover states the host didn't style.
    this.toggleDefaultLoading(showLoading && loadingSlots.length === 0);
    this.toggleDefaultError(showError && errorSlots.length === 0);

    // Only show embedded content once the remote tree is actually connected.
    // While loading or failed, the host-owned slots/fallbacks own the frame.
    setVisible(this.contentHost, !showLoading && !showError);
  }

  private toggleDefaultLoading(show: boolean): void {
    if (show && !this.defaultLoading) {
      const el = document.createElement("div");
      el.className = "hypen-app-loading";
      el.textContent = "Connecting...";
      this.defaultLoading = el;
      this.element.appendChild(el);
    } else if (!show && this.defaultLoading) {
      this.defaultLoading.remove();
      this.defaultLoading = null;
    }
  }

  private toggleDefaultError(show: boolean): void {
    if (show && !this.defaultError) {
      const el = document.createElement("div");
      el.className = "hypen-app-error";
      el.style.color = "red";
      this.defaultError = el;
      this.element.appendChild(el);
    }
    if (this.defaultError) {
      if (show) {
        this.defaultError.textContent = this.errorMessage || "HypenApp: Connection failed";
      } else {
        this.defaultError.remove();
        this.defaultError = null;
      }
    }
  }

  dispose(): void {
    this.observer?.disconnect();
    this.defaultLoading?.remove();
    this.defaultError?.remove();
    this.defaultLoading = null;
    this.defaultError = null;
  }
}

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

    const existing = activeInstances.get(element);
    if (existing) {
      if (existing.url === url) return; // Already connected to this app
      // URL changed (or became invalid) — tear down and reconnect below.
      existing.dispose();
      activeInstances.delete(element);
    }

    // The nested renderer owns this wrapper; host-owned slot children are
    // siblings of it, so neither side's cleanup can clobber the other.
    const contentHost = document.createElement("div");
    contentHost.className = "hypen-app-content";
    contentHost.style.display = "contents";
    element.appendChild(contentHost);

    const visibility = new SlotVisibilityController(element, contentHost);

    if (!url || typeof url !== "string") {
      log.error("HypenApp: URL is required");
      visibility.setStatus("error", "HypenApp: URL required");
      activeInstances.set(element, {
        engine: null,
        renderer: null,
        visibility,
        url: null,
        dispose() {
          visibility.dispose();
          contentHost.remove();
        },
      });
      return;
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

    const renderer = new Renderer(contentHost, engine, undefined, { routeFocus: "off" });
    const instance: HypenAppInstance = {
      engine,
      renderer,
      visibility,
      url,
      dispose() {
        engine.disconnect();
        visibility.dispose();
        contentHost.remove();
      },
    };
    activeInstances.set(element, instance);

    // Same replacement-root handling as the generic client: a fresh root
    // insert after we've already rendered one means "replace the tree".
    let hasRenderedRoot = false;
    engine.onPatches((patches: Patch[]) => {
      visibility.setStatus("connected");
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
          visibility.setStatus(
            "error",
            `HypenApp: Connection failed - ${result.error?.message ?? result.error}`,
          );
          log.error("HypenApp connection failed:", result.error);
          return;
        }
        log.debug(`HypenApp connected to ${url}`);
      })
      .catch((error: Error) => {
        visibility.setStatus("error", `HypenApp: Connection failed - ${error.message}`);
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
      instance.dispose();
      activeInstances.delete(element);
      log.debug("HypenApp cleaned up");
    });
  },

  onChildrenChanged(element: HTMLElement): void {
    activeInstances.get(element)?.visibility.refresh();
  },
};

/**
 * Disconnect a HypenApp instance
 */
export function disconnectHypenApp(element: HTMLElement): void {
  const instance = activeInstances.get(element);
  if (instance) {
    instance.engine?.disconnect();
    activeInstances.delete(element);
  }
}
