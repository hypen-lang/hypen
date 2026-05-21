/**
 * DOM Renderer
 *
 * Renders Hypen patches to the DOM
 */

import type { Patch } from "@hypen-space/core/types";
import type { HypenModuleInstance } from "@hypen-space/core/app";
import type { HypenRouter } from "@hypen-space/core/router";
import type { HypenGlobalContext } from "@hypen-space/core/context";
import { frameworkLoggers } from "@hypen-space/core/logger";

const log = frameworkLoggers.renderer;

/** Element types that treat the "action" prop as an onClick handler */
const ACTIONABLE_TYPES = new Set(["button", "link", "card"]);

/**
 * Per-component-type props that map to HTML element attributes (not CSS).
 * SetProp for these names must go through the component's `applyProps`
 * (which writes the attribute), otherwise the applicator's CSS fallback
 * tries `el.style.<name>` and the update silently no-ops — most visibly
 * for `Image.src` updates that depend on async-loaded state (the social
 * `Your story` avatar that fills in once `state.currentUser` arrives).
 */
const COMPONENT_HTML_ATTRS: Record<string, Set<string>> = {
  image: new Set(["src", "alt", "url", "0", "srcset"]),
  input: new Set(["type", "placeholder", "value", "disabled", "readonly", "name", "checked"]),
  textarea: new Set(["placeholder", "value", "rows", "cols", "disabled", "readonly", "name"]),
  select: new Set(["name", "multiple", "disabled", "value"]),
  checkbox: new Set(["checked", "disabled", "name"]),
  radio: new Set(["checked", "disabled", "name", "value"]),
  link: new Set(["href", "target", "rel"]),
};

import { ComponentRegistry } from "./components/index.js";
import { ApplicatorRegistry } from "./applicators/index.js";
import { canvasHandler, canvasApplicators } from "./canvas/index.js";
import { CanvasRenderer } from "../canvas/renderer.js";
import { RerenderTracker, type DebugConfig, defaultDebugConfig } from "./debug.js";
import { setEngine, disposeHypenElement } from "./element-data.js";

// Interface for the engine that renderer needs
interface IEngine {
  dispatchAction(name: string, payload?: any): void;
}

export class DOMRenderer {
  private container: HTMLElement;
  private nodes: Map<string, HTMLElement> = new Map();
  private rootId: string | null = null;
  private components: ComponentRegistry;
  private applicators: ApplicatorRegistry;
  private engine: IEngine;
  private currentState: Record<string, any> = {};
  private router: HypenRouter | null = null;
  private globalContext: HypenGlobalContext | null = null;
  private componentInstances = new Map<string, HypenModuleInstance>();
  private debugTracker: RerenderTracker;

  // Canvas subtree routing — Canvas components get their own CanvasRenderer
  // and all descendant patches are forwarded to it instead of the DOM.
  private canvasRenderers = new Map<string, CanvasRenderer>();
  private canvasSubtreeMap = new Map<string, string>(); // nodeId → canvasRootId
  private canvasElements = new Map<string, HTMLCanvasElement>();
  /** Props stashed at create-time so we can forward them to CanvasRenderer */
  private pendingCreateProps = new Map<string, { elementType: string; props: Record<string, any> }>();

  constructor(container: HTMLElement, engine: IEngine, debugConfig?: Partial<DebugConfig>) {
    this.container = container;
    this.engine = engine;
    this.components = new ComponentRegistry();
    this.applicators = new ApplicatorRegistry();
    this.debugTracker = new RerenderTracker({ ...defaultDebugConfig, ...debugConfig });

    // Match the canvas/iOS/Android renderers: text without an explicit
    // `.color()` defaults to black. Without this, DOM text would inherit
    // whatever the host page's body color is — a dark shell makes every
    // Text render as muted gray.
    if (!container.style.color) {
      container.style.color = "#000000";
    }

    // Register canvas component and applicators
    this.components.register("canvas", canvasHandler);
    for (const [name, handler] of Object.entries(canvasApplicators)) {
      this.applicators.register(name, handler);
    }
  }

  /**
   * Set router and global context for component composition
   */
  setContext(router: HypenRouter | null, globalContext: HypenGlobalContext): void {
    this.router = router;
    this.globalContext = globalContext;
  }

  /**
   * Apply a batch of patches to the DOM.
   *
   * Uses two-pass routing: first discovers which nodes belong to a Canvas
   * subtree (via insert/move parents), then routes each patch to either
   * the DOMRenderer or the owning CanvasRenderer.
   */
  applyPatches(patches: Patch[]): void {
    // Phase 1: scan inserts to discover new canvas-subtree members
    for (const patch of patches) {
      if (patch.type === "insert" || patch.type === "move") {
        const parentId = patch.parentId;
        const childId = patch.id;
        if (!parentId || !childId) continue;

        // Is the parent a canvas root or inside a canvas subtree?
        const canvasRootId =
          this.canvasRenderers.has(parentId) ? parentId
          : this.canvasSubtreeMap.get(parentId);
        if (canvasRootId) {
          this.canvasSubtreeMap.set(childId, canvasRootId);
        }
      }
    }

    // Phase 2: route patches
    const canvasBatches = new Map<string, Patch[]>();
    const domPatches: Patch[] = [];

    for (const patch of patches) {
      const canvasRootId = this.getCanvasRouteTarget(patch);
      if (canvasRootId) {
        let batch = canvasBatches.get(canvasRootId);
        if (!batch) { batch = []; canvasBatches.set(canvasRootId, batch); }
        batch.push(patch);
      } else {
        domPatches.push(patch);
      }
    }

    // Apply DOM patches normally
    for (const patch of domPatches) {
      this.applyPatch(patch);
    }

    // Forward canvas-subtree patches to their CanvasRenderer instances
    for (const [rootId, batch] of canvasBatches) {
      const renderer = this.canvasRenderers.get(rootId);
      if (renderer) {
        renderer.applyPatches(batch);
      }
    }
  }

  /**
   * Determine which canvas root (if any) a patch should be routed to.
   * Returns the canvas root node ID, or undefined for DOM patches.
   */
  private getCanvasRouteTarget(patch: Patch): string | undefined {
    const id = patch.id;
    const parentId = patch.parentId;

    switch (patch.type) {
      case "insert":
      case "move":
      case "attach": {
        // Route by parent — if parent is a canvas root or inside one.
        // `attach` behaves like `insert`: it puts the (already-alive)
        // id into a new parent, so it routes exactly the same way.
        if (!parentId) return undefined;
        if (this.canvasRenderers.has(parentId)) return parentId;
        return this.canvasSubtreeMap.get(parentId);
      }
      case "create": {
        // create patches are routed if the node was pre-registered in phase 1
        if (!id) return undefined;
        return this.canvasSubtreeMap.get(id);
      }
      default: {
        // setProp, removeProp, setText, remove, detach — route by node id
        if (!id) return undefined;
        return this.canvasSubtreeMap.get(id);
      }
    }
  }

  /**
   * Update state and interpolate text content
   */
  updateState(state: Record<string, any>): void {
    log.debug("Updating state:", state);
    this.currentState = state;
    this.interpolateAllText();
  }

  /**
   * Merge component state into current state and re-interpolate
   */
  private mergeComponentState(componentState: Record<string, any>): void {
    this.currentState = { ...this.currentState, ...componentState };
    log.debug("Merged state:", this.currentState);
    this.interpolateAllText();
  }

  /**
   * Interpolate state values in all text elements
   */
  private interpolateAllText(): void {
    for (const [id, element] of this.nodes.entries()) {
      if (element.dataset.hypenType === "text" && element.dataset.textTemplate) {
        const template = element.dataset.textTemplate;
        const interpolated = this.interpolateText(template, this.currentState);

        // Track re-render if text actually changed
        const currentText = element.textContent;
        if (currentText !== interpolated) {
          this.debugTracker.trackRerender(id, element, "interpolate");
        }

        element.textContent = interpolated;
      }
    }
  }

  /**
   * Interpolate state values in text template.
   *
   * Bindings use the `@{state.path}` syntax (matching the engine's parser).
   */
  private interpolateText(template: string, state: Record<string, any>): string {
    return template.replace(/@\{([^}]+)\}/g, (match, path) => {
      try {
        const value = path.split('.').reduce((obj: any, key: string) => {
          if (key === 'state') return state;
          return obj?.[key];
        }, state);
        return value !== undefined ? String(value) : match;
      } catch {
        return match;
      }
    });
  }

  /**
   * Apply a single patch.
   */
  private applyPatch(patch: Patch): void {
    const id = patch.id;
    const elementType = patch.elementType;
    const parentId = patch.parentId;
    const beforeId = patch.beforeId;

    switch (patch.type) {
      case "create":
        this.onCreate(id!, elementType ?? "container", patch.props || {});
        break;
      case "setProp":
        this.onSetProp(id!, patch.name!, patch.value);
        break;
      case "removeProp":
        this.onRemoveProp(id!, patch.name!);
        break;
      case "setText":
        this.onSetText(id!, patch.text!);
        break;
      case "insert":
        this.onInsert(parentId!, id!, beforeId);
        break;
      case "move":
        this.onMove(parentId!, id!, beforeId);
        break;
      case "remove":
        this.onRemove(id!);
        break;
      case "detach":
        this.onDetach(id!);
        break;
      case "attach":
        this.onInsert(parentId!, id!, beforeId);
        break;
    }
  }

  /**
   * Create a new element
   */
  private onCreate(id: string, elementType: string, props: Record<string, any> | Map<string, any>): void {
    const propsObj = props instanceof Map ? Object.fromEntries(props) : props;

    let element = this.components.createElement(elementType, propsObj);

    if (!element) {
      // For unknown component types, create a transparent container (div).
      // This handles module wrappers (like "App") and custom components
      // that aren't registered but should act as layout containers.
      const fallback = document.createElement("div");
      fallback.dataset.hypenType = elementType.toLowerCase();
      fallback.style.display = "contents"; // Make container transparent in layout
      element = fallback;
      log.debug(`Unknown component "${elementType}" - using transparent container`);
    }

    element.dataset.hypenType = elementType.toLowerCase();
    element.dataset.hypenId = id;
    setEngine(element, this.engine);

    this.applicators.applyAll(element, propsObj);

    // Actionable components: wire "action" prop as onClick
    if (propsObj.action && ACTIONABLE_TYPES.has(elementType.toLowerCase())) {
      this.applicators.apply(element, "onClick", propsObj.action);
    }

    this.nodes.set(id, element);
    this.debugTracker.trackRerender(id, element, `create:${elementType}`);

    // Canvas component: create a CanvasRenderer for its subtree
    if (elementType.toLowerCase() === "canvas") {
      const canvasEl = element as unknown as HTMLCanvasElement;
      // Apply sensible defaults if no explicit size
      if (!canvasEl.width || canvasEl.width === 300) canvasEl.width = propsObj.width ? Number(propsObj.width) : 800;
      if (!canvasEl.height || canvasEl.height === 150) canvasEl.height = propsObj.height ? Number(propsObj.height) : 600;

      const canvasRenderer = new CanvasRenderer(canvasEl, this.engine);
      this.canvasRenderers.set(id, canvasRenderer);
      this.canvasElements.set(id, canvasEl);

      // Bootstrap a root container inside the CanvasRenderer so child
      // inserts with parentId === this canvas node find a parent.
      canvasRenderer.applyPatches([
        { type: "create", id, elementType: "container", props: {} },
        { type: "insert", parentId: "root", id },
      ]);
    }

    if (!this.rootId) {
      this.rootId = id;
      if (!this.container.contains(element)) {
        this.container.appendChild(element);
      }
    }
  }

  /**
   * Set a property on an element
   */
  private onSetProp(id: string, name: string, value: any): void {
    const element = this.nodes.get(id);
    if (!element) return;

    this.debugTracker.trackRerender(id, element, `setProp:${name}`);

    if (name === "0" || name === "text") {
      const elementType = element.dataset.hypenType;

      if (elementType === "input") {
        const inputEl = element as HTMLInputElement;
        inputEl.value = String(value);
        log.debug(`Updated input value: "${value}"`);
        return;
      }

      // For element types where the positional `0` is a non-text prop
      // (e.g. `Image(src)` accepts the URL as `0`), let the component's
      // `applyProps` handle it instead of force-setting `textContent`.
      // Without this an `Image` whose URL arrived in a later SetProp
      // patch ended up with `<img>Your story</img>`-style text contents
      // and an empty `src`.
      if (elementType && COMPONENT_HTML_ATTRS[elementType]?.has(name)) {
        const handler = this.components.get(elementType);
        if (handler?.applyProps) {
          handler.applyProps(element, { [name]: value });
          return;
        }
      }

      const nextText = String(value);
      element.textContent = nextText;

      // Preserve the original template when it contains state interpolation.
      // Engine patches may send interpolated strings; if we overwrite the template,
      // future state updates won't be able to re-interpolate.
      const currentTemplate = element.dataset.textTemplate;
      const nextLooksLikeTemplate = nextText.includes("@{");
      const currentLooksLikeTemplate = typeof currentTemplate === "string" && currentTemplate.includes("@{");

      if (nextLooksLikeTemplate) {
        element.dataset.textTemplate = nextText;
      } else if (currentTemplate === undefined) {
        // No template stored yet; treat this as the template.
        element.dataset.textTemplate = nextText;
      } else if (!currentLooksLikeTemplate) {
        // If current template isn't a template, keep it in sync.
        element.dataset.textTemplate = nextText;
      }
      log.debug(`Updated text content: "${value}"`);
      return;
    }

    // Actionable components: wire "action" prop as onClick
    if (name === "action" && ACTIONABLE_TYPES.has(element.dataset.hypenType || "")) {
      this.applicators.apply(element, "onClick", value);
      return;
    }

    // Element-specific HTML attributes (img.src, input.placeholder, etc.)
    // need to go through the component handler's `applyProps`. Without
    // this, a follow-up SetProp(src=…) for an `Image` whose initial
    // Create had no src — the `Your story` avatar that depends on
    // `state.currentUser`, which loads after the first paint — was
    // routed to the CSS fallback (`el.style.src`, a no-op) and the
    // image stayed blank forever.
    const elementType = element.dataset.hypenType;
    if (elementType && COMPONENT_HTML_ATTRS[elementType]?.has(name)) {
      const handler = this.components.get(elementType);
      if (handler?.applyProps) {
        handler.applyProps(element, { [name]: value });
        return;
      }
    }

    this.applicators.apply(element, name, value);

    // Forward canvas dimension changes to its CanvasRenderer
    if ((name === "width" || name === "height") && this.canvasRenderers.has(id)) {
      const canvasEl = this.canvasElements.get(id)!;
      this.canvasRenderers.get(id)!.resize(canvasEl.width, canvasEl.height);
    }
  }

  /**
   * Remove a property from an element
   */
  private onRemoveProp(id: string, name: string): void {
    const element = this.nodes.get(id);
    if (!element) return;

    this.debugTracker.trackRerender(id, element, `removeProp:${name}`);
    this.applicators.apply(element, name, undefined);
  }

  /**
   * Set text content
   */
  private onSetText(id: string, text: string): void {
    const element = this.nodes.get(id);
    if (!element) return;

    this.debugTracker.trackRerender(id, element, "setText");
    element.textContent = text;
  }

  /**
   * Insert an element into the tree
   */
  private onInsert(parentId: string, id: string, beforeId?: string): void {
    const parent = parentId === "root" ? this.container : this.nodes.get(parentId);
    const child = this.nodes.get(id);

    log.debug(`Inserting ${id} into ${parentId}`, {
      parent: parent ? `${parent.tagName}#${parent.id || 'no-id'}` : 'null',
      child: child ? `${child.tagName}#${child.id || 'no-id'}` : 'null',
      childText: child?.textContent?.substring(0, 20)
    });

    if (!parent || !child) return;

    if (parentId === "root") {
      this.rootId = id;
    }

    if (beforeId) {
      const before = this.nodes.get(beforeId);
      if (before && before.parentNode === parent) {
        parent.insertBefore(child, before);
      } else if (!parent.contains(child)) {
        parent.appendChild(child);
      }
    } else {
      if (!parent.contains(child)) {
        parent.appendChild(child);
      }
    }
  }

  /**
   * Move an element within the tree
   */
  private onMove(parentId: string, id: string, beforeId?: string): void {
    this.onInsert(parentId, id, beforeId);
  }

  /**
   * Detach an element from its parent without destroying it.
   *
   * The HTMLElement and its children stay alive in `this.nodes` (and
   * anywhere else they're referenced); only the DOM parent link is
   * broken. A subsequent `attach` patch reinserts the same reference
   * into a parent, preserving scroll position, form state, focus,
   * inline styles, and any attached event listeners.
   *
   * Event listeners and other disposables are intentionally NOT
   * disposed — the subtree is expected to come back. If the engine
   * follows up with a `remove` for this id instead, full teardown
   * happens there.
   *
   * Used by the engine's Router cache to keep previously-visited
   * route subtrees alive between navigations.
   */
  private onDetach(id: string): void {
    const element = this.nodes.get(id);
    if (!element) return;

    if (element.parentNode) {
      element.parentNode.removeChild(element);
    }

    // If the root gets detached (unlikely but defensible), clear
    // rootId so a later attach can re-root cleanly.
    if (this.rootId === id) {
      this.rootId = null;
    }
  }

  /**
   * Remove an element from the tree
   */
  private onRemove(id: string): void {
    const element = this.nodes.get(id);
    if (!element) return;

    // Clean up canvas renderer if this is a canvas root
    if (this.canvasRenderers.has(id)) {
      this.canvasRenderers.get(id)!.destroy();
      this.canvasRenderers.delete(id);
      this.canvasElements.delete(id);
      // Remove all subtree entries pointing to this canvas root
      for (const [nodeId, rootId] of this.canvasSubtreeMap) {
        if (rootId === id) this.canvasSubtreeMap.delete(nodeId);
      }
    }

    // Dispose event listeners and other resources before removing from DOM
    disposeHypenElement(element);

    if (element.parentNode) {
      element.parentNode.removeChild(element);
    }

    this.nodes.delete(id);

    if (this.rootId === id) {
      this.rootId = null;
    }
  }

  /**
   * Get an element by ID
   */
  getNode(id: string): HTMLElement | undefined {
    return this.nodes.get(id);
  }

  /**
   * Clear all nodes
   */
  clear(): void {
    // Destroy all canvas renderers
    for (const renderer of this.canvasRenderers.values()) {
      renderer.destroy();
    }
    this.canvasRenderers.clear();
    this.canvasElements.clear();
    this.canvasSubtreeMap.clear();

    // Dispose all element resources before clearing
    for (const element of this.nodes.values()) {
      disposeHypenElement(element);
    }
    this.container.innerHTML = "";
    this.nodes.clear();
    this.rootId = null;
  }

  /**
   * Get the component registry (for registering custom components)
   */
  getComponentRegistry(): ComponentRegistry {
    return this.components;
  }

  /**
   * Get the applicator registry (for registering custom applicators)
   */
  getApplicatorRegistry(): ApplicatorRegistry {
    return this.applicators;
  }

  /**
   * Enable or configure debug mode
   */
  setDebugConfig(config: Partial<DebugConfig>): void {
    this.debugTracker.setConfig(config);
  }

  /**
   * Reset debug tracking for all elements
   */
  resetDebugTracking(): void {
    this.debugTracker.resetAll();
  }

  /**
   * Get debug statistics
   */
  getDebugStats(): { totalRerenders: number; elementCount: number; avgRerenders: number } {
    return this.debugTracker.getStats();
  }
}
