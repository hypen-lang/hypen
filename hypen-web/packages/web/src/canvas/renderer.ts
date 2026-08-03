/**
 * Canvas Renderer
 *
 * Main renderer class that orchestrates layout, painting, and events
 */

import type { Renderer } from "@hypen-space/core/renderer";
import type { Patch } from "@hypen-space/core/types";
import { frameworkLoggers } from "@hypen-space/core/logger";

const log = frameworkLoggers.canvas;

// Interface for the engine that canvas renderer needs
interface IEngine {
  dispatchAction(name: string, payload?: any): void;
}
import type {
  VirtualNode,
  CanvasRendererOptions,
  PainterFunction,
  LayoutFunction,
} from "./types.js";
import { computeLayout, initTaffyLayout } from "./layout.js";
import { paintNode, registerPainter } from "./paint.js";
import { CanvasEventManager } from "./events.js";
import { InputOverlay } from "./input.js";
import { AccessibilityLayer } from "./accessibility.js";
import { findNodeById } from "./utils.js";
import { ScrollManager } from "./scroll.js";
import { SelectionManager } from "./selection.js";
import { setSelectionManager } from "./paint.js";
import { DirtyRectTracker } from "./dirty.js";
import {
  normalizeAllApplicators,
  refreshApplicator,
  parseApplicatorBase,
} from "./props.js";
import { applyVariants, invalidateVariantCache, deriveNodeComputed } from "./variants.js";

const DEFAULT_OPTIONS: CanvasRendererOptions = {
  devicePixelRatio: typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1,
  backgroundColor: "#ffffff",
  enableAccessibility: true,
  enableHitTesting: true,
  enableInputOverlay: true,
  enableDirtyRects: false,
  enableLayerCaching: false,
  maxLayerCacheSize: 10,
  showLayoutBounds: false,
  showDirtyRects: false,
  logPerformance: false,
};

/**
 * Canvas Renderer
 */
export class CanvasRenderer implements Renderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private engine: IEngine;
  private options: CanvasRendererOptions;
  
  private rootNode: VirtualNode | null = null;
  private nodes = new Map<string, VirtualNode>();
  
  private eventManager: CanvasEventManager;
  private scrollManager: ScrollManager;
  private selectionManager: SelectionManager;
  private inputOverlay: InputOverlay;
  private accessibilityLayer: AccessibilityLayer;
  
  private dirtyTracker: DirtyRectTracker;

  private rafId: number | null = null;
  private needsRedraw = false;

  private frameCount = 0;
  private lastFrameTime = 0;

  constructor(canvas: HTMLCanvasElement, engine: IEngine, options?: Partial<CanvasRendererOptions>) {
    this.canvas = canvas;
    this.engine = engine;
    this.options = { ...DEFAULT_OPTIONS, ...options };

    // Get context
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Failed to get 2D context from canvas");
    }
    this.ctx = ctx;

    // Setup HiDPI
    this.setupHiDPI();

    // Initialize dirty rect tracker
    const dpr = this.options.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    this.dirtyTracker = new DirtyRectTracker(rect.width, rect.height);

    // Initialize subsystems
    this.eventManager = new CanvasEventManager(canvas, engine);
    this.scrollManager = new ScrollManager(canvas, () => this.scheduleRedraw());
    this.selectionManager = new SelectionManager(canvas, () => this.scheduleRedraw());
    setSelectionManager(this.selectionManager);
    this.inputOverlay = new InputOverlay(
      (canvas as any).parentElement || (typeof document !== "undefined" ? document.body : null)
    );
    this.accessibilityLayer = new AccessibilityLayer(
      (canvas as any).parentElement || (typeof document !== "undefined" ? document.body : null),
      this.options.enableAccessibility || false
    );

    // Bridge focus changes from the hit-tester to the HTML input overlay.
    // Without this, `Input`/`Textarea` painted on the canvas but clicking
    // one did nothing — the overlay never got mounted.
    this.eventManager.setFocusChangeHandler((next) => {
      const t = next ? next.type.toLowerCase() : null;
      if (next && (t === "input" || t === "textarea")) {
        const rect = this.canvas.getBoundingClientRect();
        this.inputOverlay.showInput(
          next,
          rect,
          (value) => {
            // Local mirror so the next paint sees the typed text even
            // before the engine echoes it back via SetProp.
            next.props.value = value;
            this.scheduleRedraw();
          },
          this.engine,
        );
      } else {
        this.inputOverlay.hideInput();
      }
    });

    // Listen for redraw requests from event manager
    this.canvas.addEventListener("hypen:redraw", () => this.scheduleRedraw());

    // Eagerly initialise Taffy WASM for layout (non-blocking — fallback used until ready)
    initTaffyLayout();

    // Don't schedule initial render - wait for patches
  }

  /**
   * Setup HiDPI rendering
   */
  private setupHiDPI(): void {
    const dpr = this.options.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();

    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;

    this.ctx.scale(dpr, dpr);

    // Update canvas display size
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;

    // Sync dirty tracker with new canvas size
    if (this.dirtyTracker) {
      this.dirtyTracker.setCanvasSize(rect.width, rect.height);
      this.dirtyTracker.markFullDirty();
    }
  }

  /**
   * Resize the canvas and re-run HiDPI setup + redraw.
   * Called by DOMRenderer when the Canvas component's width/height props change.
   */
  resize(width: number, height: number): void {
    this.canvas.width = width;
    this.canvas.height = height;
    this.setupHiDPI();
    this.scheduleRedraw();
  }

  /**
   * Apply patches from engine
   */
  applyPatches(patches: Patch[]): void {
    const hadRoot = this.rootNode !== null;

    for (const patch of patches) {
      this.applyPatch(patch);
    }

    // On first render (root just appeared), mark the entire canvas dirty
    if (this.options.enableDirtyRects && !hadRoot && this.rootNode !== null) {
      this.dirtyTracker.markFullDirty();
    }

    // Update accessibility layer
    if (this.rootNode) {
      this.accessibilityLayer.syncTree(this.rootNode);
    }

    // Schedule redraw
    this.scheduleRedraw();
  }

  /**
   * Apply single patch
   */
  private applyPatch(patch: Patch): void {
    switch (patch.type) {
      case "create":
        this.onCreate(patch.id!, patch.elementType!, patch.props || {});
        break;

      case "setProp":
        this.onSetProp(patch.id!, patch.name!, patch.value);
        break;

      case "removeProp":
        this.onRemoveProp(patch.id!, patch.name!);
        break;

      case "setText":
        this.onSetText(patch.id!, patch.text!);
        break;

      case "insert":
        this.onInsert(patch.parentId!, patch.id!, patch.beforeId);
        break;

      case "move":
        this.onMove(patch.parentId!, patch.id!, patch.beforeId);
        break;

      case "remove":
        this.onRemove(patch.id!);
        break;

      case "detach":
        this.onDetach(patch.id!);
        break;

      case "attach":
        this.onInsert(patch.parentId!, patch.id!, patch.beforeId);
        break;
    }
  }

  /**
   * Create new virtual node
   */
  private onCreate(id: string, elementType: string, props: Record<string, any>): void {
    // Engine may send a Map (from WASM) or a plain object. Copy either way so
    // we own the prop bag and can mutate it during applicator normalisation.
    const rawProps: Record<string, any> =
      props instanceof Map ? Object.fromEntries(props) : { ...props };
    normalizeAllApplicators(rawProps);

    // Engine emits the element type capitalised (`"Button"`, `"Text"`, …);
    // every per-type comparison downstream lowercases it, so do the same
    // for clickable/focusable. Without this, Buttons weren't flagged as
    // clickable (so hover/cursor barely fired) and Inputs/Textareas
    // weren't focusable (caret never landed).
    const lowerType = elementType.toLowerCase();
    const node: VirtualNode = {
      id,
      type: elementType,
      props: rawProps,
      children: [],
      parent: null,
      visible: true,
      opacity: parseFloat(rawProps.opacity) || 1,
      clickable:
        lowerType === "button" ||
        rawProps.onClick != null ||
        rawProps.onclick != null ||
        rawProps.action != null,
      hoverable: true,
      focusable: lowerType === "input" || lowerType === "textarea" || lowerType === "button",
      focused: false,
      hovered: false,
    };

    this.nodes.set(id, node);
  }

  /**
   * Set property on node
   */
  private onSetProp(id: string, name: string, value: any): void {
    const node = this.nodes.get(id);
    if (!node) return;

    // Mark dirty before prop change (old bounds)
    if (this.options.enableDirtyRects) {
      this.dirtyTracker.markNodeDirty(node);
    }

    node.props[name] = value;

    // A new key may introduce a variant marker (e.g. `padding@md.0`) — drop the
    // cached variant-base set so the next frame rescans.
    invalidateVariantCache(node);

    // If this is an applicator-namespaced key (e.g. `flex.0`, `onClick.to`),
    // rebuild the derived flat/aggregate entry under the base name so layout,
    // paint, and event dispatch see the updated value.
    const base = parseApplicatorBase(name);
    if (base !== null) {
      refreshApplicator(node.props, base);
    }

    // Update computed properties — check both the direct key and the
    // post-refresh derived key so setProp on `opacity.0` still updates opacity.
    if (name === "visible") {
      node.visible = !!value;
    }
    if (name === "opacity" || base === "opacity") {
      node.opacity = parseFloat(node.props.opacity) || 1;
    }
    if (
      name === "onClick" || name === "onclick" || name === "action" ||
      base === "onClick" || base === "onclick" || base === "action"
    ) {
      node.clickable =
        node.props.onClick != null ||
        node.props.onclick != null ||
        node.props.action != null;
    }

    // Mark dirty after prop change (new bounds will be captured after layout)
    if (this.options.enableDirtyRects) {
      this.dirtyTracker.markNodeDirty(node);
    }

    // Update accessibility
    this.accessibilityLayer.updateNode(node);
  }

  /**
   * Remove a property from a node
   */
  private onRemoveProp(id: string, name: string): void {
    const node = this.nodes.get(id);
    if (!node) return;

    if (this.options.enableDirtyRects) {
      this.dirtyTracker.markNodeDirty(node);
    }

    delete node.props[name];

    invalidateVariantCache(node);

    const base = parseApplicatorBase(name);
    if (base !== null) {
      refreshApplicator(node.props, base);
    }

    if (name === "visible") {
      node.visible = true;
    }
    if (name === "opacity" || base === "opacity") {
      node.opacity = parseFloat(node.props.opacity) || 1;
    }
    if (
      name === "onClick" || name === "onclick" || name === "action" ||
      base === "onClick" || base === "onclick" || base === "action"
    ) {
      node.clickable =
        node.props.onClick != null ||
        node.props.onclick != null ||
        node.props.action != null;
    }

    if (this.options.enableDirtyRects) {
      this.dirtyTracker.markNodeDirty(node);
    }

    this.accessibilityLayer.updateNode(node);
  }

  /**
   * Set text on node
   */
  private onSetText(id: string, text: string): void {
    const node = this.nodes.get(id);
    if (!node) return;

    if (this.options.enableDirtyRects) {
      this.dirtyTracker.markNodeDirty(node);
    }

    node.props[0] = text;

    if (this.options.enableDirtyRects) {
      this.dirtyTracker.markNodeDirty(node);
    }

    // Update accessibility
    this.accessibilityLayer.updateNode(node);
  }

  /**
   * Insert node into tree
   */
  private onInsert(parentId: string, id: string, beforeId?: string): void {
    const child = this.nodes.get(id);
    if (!child) return;

    // Check if this is setting the root node (parent_id === id === "root" or similar)
    if (parentId === "root" && id === "root") {
      this.rootNode = child;
      this.eventManager.setRootNode(child);
      this.scrollManager.setRootNode(child);
      this.selectionManager.setRootNode(child);
      return;
    }

    // Otherwise find the parent node
    const parent = this.nodes.get(parentId);
    if (!parent) {
      // If parent is "root", this might be the first real root node
      if (parentId === "root") {
        this.rootNode = child;
        this.eventManager.setRootNode(child);
      this.scrollManager.setRootNode(child);
      this.selectionManager.setRootNode(child);
      }
      return;
    }

    // Insert child into parent
    child.parent = parent;

    if (beforeId) {
      const beforeIndex = parent.children.findIndex((c) => c.id === beforeId);
      if (beforeIndex >= 0) {
        parent.children.splice(beforeIndex, 0, child);
      } else {
        parent.children.push(child);
      }
    } else {
      parent.children.push(child);
    }

    // Mark parent dirty since its children changed
    if (this.options.enableDirtyRects) {
      this.dirtyTracker.markNodeDirty(parent);
    }
  }

  /**
   * Move node in tree
   */
  private onMove(parentId: string, id: string, beforeId?: string): void {
    // Remove from old parent
    const node = this.nodes.get(id);
    if (!node || !node.parent) return;

    const oldParent = node.parent;

    // Mark old position dirty before move
    if (this.options.enableDirtyRects) {
      this.dirtyTracker.markNodeDirty(node);
      this.dirtyTracker.markNodeDirty(oldParent);
    }

    const oldIndex = oldParent.children.indexOf(node);
    if (oldIndex >= 0) {
      oldParent.children.splice(oldIndex, 1);
    }

    // Insert into new location (also marks new parent dirty)
    this.onInsert(parentId, id, beforeId);
  }

  /**
   * Detach a subtree from its parent without destroying it.
   *
   * The VirtualNode and its descendants stay in `this.nodes`, just
   * unlinked from the visible tree (removed from the parent's
   * `children` array and `node.parent = null`). A subsequent
   * `attach` patch reinserts it — scroll offsets, focus state,
   * layout caches, and any other per-node derived state survive.
   *
   * Used by the engine's Router cache to keep off-screen route
   * subtrees alive between navigations so re-entry is instant.
   */
  private onDetach(id: string): void {
    const node = this.nodes.get(id);
    if (!node) return;

    // Mark dirty so the next paint doesn't leave stale pixels behind.
    if (this.options.enableDirtyRects) {
      this.dirtyTracker.markNodeDirty(node);
    }

    if (node.parent) {
      const idx = node.parent.children.indexOf(node);
      if (idx >= 0) {
        node.parent.children.splice(idx, 1);
        if (this.options.enableDirtyRects) {
          this.dirtyTracker.markNodeDirty(node.parent);
        }
      }
      node.parent = null;
    }

    if (this.rootNode === node) {
      this.rootNode = null;
      this.eventManager.setRootNode(null);
      this.scrollManager.setRootNode(null);
      this.selectionManager.setRootNode(null);
    }
  }

  /**
   * Remove node from tree
   */
  private onRemove(id: string): void {
    const node = this.nodes.get(id);
    if (!node) return;

    // Mark dirty before removal
    if (this.options.enableDirtyRects) {
      this.dirtyTracker.markNodeDirty(node);
    }

    // Remove from parent
    if (node.parent) {
      const index = node.parent.children.indexOf(node);
      if (index >= 0) {
        node.parent.children.splice(index, 1);
      }
    }

    // Remove from root
    if (this.rootNode === node) {
      this.rootNode = null;
      this.eventManager.setRootNode(null);
      this.scrollManager.setRootNode(null);
    this.selectionManager.setRootNode(null);
    }

    // Remove from nodes map
    this.nodes.delete(id);
  }

  /**
   * Schedule redraw
   */
  private scheduleRedraw(): void {
    if (this.rafId !== null) return;

    // Use requestAnimationFrame if available (browser), otherwise render immediately (tests)
    if (typeof requestAnimationFrame !== "undefined") {
      this.rafId = requestAnimationFrame(() => {
        this.render();
        this.rafId = null;
      });
    } else {
      // In non-browser environments (tests), render immediately
      this.render();
    }
  }

  /**
   * Main render function
   */
  private render(): void {
    const startTime = performance.now();
    const dpr = this.options.devicePixelRatio || 1;

    if (this.options.enableDirtyRects) {
      this.renderWithDirtyRects(dpr);
    } else {
      this.renderFull(dpr);
    }

    // Performance logging
    if (this.options.logPerformance) {
      const elapsed = performance.now() - startTime;
      this.frameCount++;
      if (performance.now() - this.lastFrameTime > 1000) {
        log.debug(`Canvas FPS: ${this.frameCount}, Last frame: ${elapsed.toFixed(2)}ms`);
        this.frameCount = 0;
        this.lastFrameTime = performance.now();
      }
    }
  }

  /**
   * Re-derive cached computed fields that may have been overridden by variant
   * resolution. `node.opacity` is read straight off `node.props.opacity` in
   * paint, but it is cached on the node at create/setProp time — after a
   * variant pass changes `props.opacity` (e.g. `opacity:disabled`), the cache
   * must be refreshed or the paint would use the stale value.
   */
  private refreshComputedProps(node: VirtualNode): void {
    deriveNodeComputed(node);
    for (const child of node.children) {
      this.refreshComputedProps(child);
    }
  }

  /**
   * Full canvas repaint (default behavior when dirty rects disabled)
   */
  private renderFull(dpr: number): void {
    // Clear canvas
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    // Draw background
    if (this.options.backgroundColor) {
      this.ctx.fillStyle = this.options.backgroundColor;
      this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }

    // Layout and paint
    if (this.rootNode) {
      // Resolve responsive + state variants against the current content width
      // BEFORE layout so spacing/size winners feed the layout engine and
      // colour/opacity winners feed paint.
      const contentWidth = this.canvas.width / dpr;
      applyVariants(this.rootNode, contentWidth);
      this.refreshComputedProps(this.rootNode);

      computeLayout(
        this.ctx,
        this.rootNode,
        contentWidth,
        this.canvas.height / dpr
      );

      ScrollManager.updateScrollBounds(this.rootNode);

      paintNode(this.ctx, this.rootNode);

      if (this.options.showLayoutBounds) {
        this.drawLayoutBounds(this.rootNode);
      }
    }
  }

  /**
   * Optimized render that only repaints dirty regions
   */
  private renderWithDirtyRects(dpr: number): void {
    // Always run layout so nodes have up-to-date bounds
    if (this.rootNode) {
      const contentWidth = this.canvas.width / dpr;
      applyVariants(this.rootNode, contentWidth);
      this.refreshComputedProps(this.rootNode);

      computeLayout(
        this.ctx,
        this.rootNode,
        contentWidth,
        this.canvas.height / dpr
      );
      ScrollManager.updateScrollBounds(this.rootNode);
    }

    const dirtyRegion = this.dirtyTracker.getDirtyRegion();
    this.dirtyTracker.clear();

    // Nothing dirty — skip repaint entirely
    if (dirtyRegion === null) {
      return;
    }

    this.ctx.save();

    // Clip to dirty region so only affected pixels are drawn
    this.ctx.beginPath();
    this.ctx.rect(dirtyRegion.x, dirtyRegion.y, dirtyRegion.width, dirtyRegion.height);
    this.ctx.clip();

    // Clear only the dirty region
    this.ctx.clearRect(dirtyRegion.x, dirtyRegion.y, dirtyRegion.width, dirtyRegion.height);

    // Repaint background within dirty region
    if (this.options.backgroundColor) {
      this.ctx.fillStyle = this.options.backgroundColor;
      this.ctx.fillRect(dirtyRegion.x, dirtyRegion.y, dirtyRegion.width, dirtyRegion.height);
    }

    // Repaint the full tree — clip path ensures only dirty pixels are touched
    if (this.rootNode) {
      paintNode(this.ctx, this.rootNode);

      if (this.options.showLayoutBounds) {
        this.drawLayoutBounds(this.rootNode);
      }
    }

    this.ctx.restore();

    // Debug: show dirty rect outline
    if (this.options.showDirtyRects) {
      this.ctx.save();
      this.ctx.strokeStyle = "rgba(255, 0, 0, 0.8)";
      this.ctx.lineWidth = 2;
      this.ctx.setLineDash([4, 2]);
      this.ctx.strokeRect(dirtyRegion.x, dirtyRegion.y, dirtyRegion.width, dirtyRegion.height);
      this.ctx.setLineDash([]);
      this.ctx.restore();
    }
  }

  /**
   * Draw layout bounds for debugging
   */
  private drawLayoutBounds(node: VirtualNode): void {
    if (!node.layout) return;

    const layout = node.layout;

    this.ctx.strokeStyle = "#ff0000";
    this.ctx.lineWidth = 1;
    this.ctx.strokeRect(layout.x, layout.y, layout.width, layout.height);

    for (const child of node.children) {
      this.drawLayoutBounds(child);
    }
  }

  /**
   * Get node by ID
   */
  getNode(id: string): VirtualNode | undefined {
    return this.nodes.get(id);
  }

  /**
   * Clear renderer
   */
  clear(): void {
    this.rootNode = null;
    this.nodes.clear();
    this.eventManager.setRootNode(null);
    this.scrollManager.setRootNode(null);
    this.selectionManager.setRootNode(null);
    this.dirtyTracker.clear();
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /**
   * Register custom painter
   */
  registerPainter(type: string, painter: PainterFunction): void {
    registerPainter(type, painter);
  }

  /**
   * Set renderer options
   */
  setOptions(options: Partial<CanvasRendererOptions>): void {
    this.options = { ...this.options, ...options };
    this.accessibilityLayer.setEnabled(this.options.enableAccessibility || false);
  }

  /**
   * Destroy renderer
   */
  destroy(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
    }
    this.eventManager.destroy();
    this.scrollManager.destroy();
    this.selectionManager.destroy();
    setSelectionManager(null);
    this.accessibilityLayer.destroy();
  }
}

