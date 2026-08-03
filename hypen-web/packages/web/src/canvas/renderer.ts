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
import { clearTextCache } from "./text.js";
import { paintNode, registerPainter, clearCharAdvanceCache } from "./paint.js";
import { CanvasEventManager } from "./events.js";
import { AccessibilityLayer } from "./accessibility.js";
import { FocusManager } from "./focus.js";
import { TextEditController, isEditableNode } from "./editing.js";
import { setTextEditor } from "./paint.js";
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
  private accessibilityLayer: AccessibilityLayer;
  private focusManager: FocusManager;
  private textEditor: TextEditController;
  
  private dirtyTracker: DirtyRectTracker;

  private rafId: number | null = null;
  private needsRedraw = false;

  // Whether the next frame must re-run layout. Patches, resize, font loads,
  // and image decodes set it; pure paint frames (scroll, hover, caret blink,
  // scrollbar fade) leave it clear so the frame skips the Taffy solve.
  private layoutDirty = true;

  private frameCount = 0;
  private lastFrameTime = 0;

  private boundFontsLoaded = () => {
    // Metrics measured against the fallback font are stale now — both the
    // wrapped-text metrics and the per-glyph advances used by the manual
    // letter-spacing path (keyed by CSS font string, which does not change
    // when the real font replaces the fallback).
    clearTextCache();
    clearCharAdvanceCache();
    this.layoutDirty = true;
    this.scheduleRedraw();
  };

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
    // The mirror is a transparent positioned overlay above the canvas: its
    // elements are exposed to AT with REAL geometry (screen-reader browse
    // modes are geometry-driven) and join the native tab order, while the
    // canvas paints all pixels and keeps all pointer events.
    this.accessibilityLayer = new AccessibilityLayer(
      canvas as unknown as HTMLElement,
      this.options.enableAccessibility || false
    );

    // Text editing happens IN the focused mirror element (the browser owns
    // value/caret/selection/IME there); the controller reads that state and
    // the canvas paints text, selection, and caret natively.
    this.textEditor = new TextEditController(canvas, engine, {
      scheduleRedraw: () => this.scheduleRedraw(),
      markDirty: (node) => {
        if (this.options.enableDirtyRects) {
          this.dirtyTracker.markNodeDirty(node);
        }
      },
      // Proxy blurred to somewhere outside the canvas: node.focused follows.
      onEditBlur: () => this.focusManager.clearFocus(),
    });
    setTextEditor(this.textEditor);

    // DOM focus on mirror elements (canvas fallback content) is the single
    // source of truth for focus: Tab/Shift+Tab traverse the mirror natively,
    // and the pointer path (hit-test in CanvasEventManager) funnels into the
    // same place by focusing the node's mirror element.
    this.focusManager = new FocusManager(this.accessibilityLayer, engine, {
      getNode: (id) => this.nodes.get(id),
      isAuxFocusTarget: (el) => this.textEditor.isProxyElement(el),
      onFocusChange: (next) => {
        if (next && isEditableNode(next)) {
          const el = this.accessibilityLayer.getElement(next.id);
          if (el) {
            this.textEditor.beginEditing(
              next,
              el as HTMLInputElement | HTMLTextAreaElement,
            );
          }
        } else {
          this.textEditor.endEditing();
        }
        // Repaint so focus styling (input border, button ring) updates.
        this.scheduleRedraw();
      },
    });
    this.eventManager.setFocusManager(this.focusManager);
    this.eventManager.setEditablePointerHandler((node, point) => {
      this.textEditor.placeCaretFromPoint(node, point);
    });

    // Listen for redraw requests from event manager (paint-only) and image
    // loads (which carry `detail.layout` — a decoded intrinsic size can
    // change the layout, see `getImageNaturalAspect`).
    this.canvas.addEventListener("hypen:redraw", (e: Event) => {
      if ((e as CustomEvent).detail?.layout) {
        this.layoutDirty = true;
      }
      this.scheduleRedraw();
    });

    // A late-loading web font changes every measurement made against the
    // fallback font — re-run layout once the real metrics are available.
    if (typeof document !== "undefined") {
      (document as any).fonts?.addEventListener?.("loadingdone", this.boundFontsLoaded);
    }

    // Eagerly initialise Taffy WASM for layout (non-blocking — fallback used
    // until ready). Repaint once it arrives: the fallback's first frame is
    // approximate, and without this redraw its layout would stick until the
    // next state change.
    initTaffyLayout().then((ready) => {
      if (ready) {
        this.layoutDirty = true;
        this.scheduleRedraw();
      }
    });

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
    this.layoutDirty = true;
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

    // The accessibility mirror is synced incrementally by the per-patch
    // handlers above — no per-batch rebuild, so mirror element identity
    // (and with it AT focus/virtual-cursor position) survives updates.

    // Any patch can affect layout (props, tree shape, text).
    this.layoutDirty = true;

    // Schedule redraw
    this.scheduleRedraw();
  }

  /**
   * Apply single patch
   */
  private applyPatch(patch: Patch): void {
    switch (patch.type) {
      case "create":
        this.onCreate(patch.id!, patch.elementType!, patch.props || {}, patch.semantics);
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

      case "setSemantics":
        this.onSetSemantics(patch.id!, patch.semantics);
        break;
    }
  }

  /**
   * Reactive accessibility update: swap in the node's complete re-resolved
   * semantics block and re-apply it to the shadow element. This is the only
   * channel that keeps the canvas shadow tree's accessible name/state live —
   * painted text is invisible to AT, so prop deltas alone can't do it.
   */
  private onSetSemantics(
    id: string,
    semantics?: import("@hypen-space/core/types").Semantics,
  ): void {
    const node = this.nodes.get(id);
    if (!node) return;
    node.semantics = semantics;
    this.accessibilityLayer.updateNode(node);
  }

  /**
   * Create new virtual node
   */
  private onCreate(
    id: string,
    elementType: string,
    props: Record<string, any>,
    semantics?: import("@hypen-space/core/types").Semantics,
  ): void {
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
      semantics,
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

    // Mirror the create (element stays detached until its insert patch).
    this.accessibilityLayer.createNode(node);
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

    // Engine value echo for an actively edited input: same value → no-op
    // (the caret must not move); a rewritten value re-seeds the element.
    if (name === "value") {
      this.textEditor.onEngineValueEcho(node);
    }
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

    // Mirror the insert/attach/move — insertNode resolves root addressing
    // and unknown-beforeId fallback with the same rules as the code below.
    this.accessibilityLayer.insertNode(parentId, id, beforeId);

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

    // An edit session inside the detached subtree ends (flushing any
    // pending composition value) before the subtree leaves the tree, and
    // focus state follows.
    this.textEditor.endIfWithin(node);
    this.focusManager.clearIfWithin(node);

    // Mirror keeps the element (and subtree ids) alive for re-attach.
    this.accessibilityLayer.detachNode(id);

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

    // End any edit session inside the removed subtree; focus state follows.
    this.textEditor.endIfWithin(node);
    this.focusManager.clearIfWithin(node);

    // Drop the mirror element and its subtree's id mappings.
    this.accessibilityLayer.removeNode(node);

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

    // Layout may have moved the edited input — keep the IME proxy (and with
    // it the IME candidate window) pinned to the painted caret.
    if (this.textEditor.isActive()) {
      this.textEditor.syncProxyPosition();
    }

    // Keep the semantics overlay's element boxes on the painted bounds so
    // screen-reader browse modes (geometry-driven) track layout changes.
    this.accessibilityLayer.syncPositions(this.rootNode);

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
   * Resolve variants and re-run layout when (and only when) something that
   * affects layout changed since the last frame. Variants are resolved every
   * frame — hover/focus/pressed winners must reach paint — but the Taffy
   * solve, computed-prop refresh, and scroll-bounds pass only run when a
   * patch/resize/font/image marked the layout dirty or a variant winner
   * actually changed (variants can rewrite spacing/size props).
   */
  private runLayoutIfNeeded(dpr: number): void {
    if (!this.rootNode) return;

    // Resolve responsive + state variants against the current content width
    // BEFORE layout so spacing/size winners feed the layout engine and
    // colour/opacity winners feed paint.
    const contentWidth = this.canvas.width / dpr;
    const variantsChanged = applyVariants(this.rootNode, contentWidth);
    if (!variantsChanged && !this.layoutDirty) return;

    this.refreshComputedProps(this.rootNode);

    computeLayout(
      this.ctx,
      this.rootNode,
      contentWidth,
      this.canvas.height / dpr
    );

    ScrollManager.updateScrollBounds(this.rootNode);
    this.layoutDirty = false;
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
      this.runLayoutIfNeeded(dpr);

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
    this.runLayoutIfNeeded(dpr);

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

    // Repaint the tree — the clip path bounds rasterized pixels and the
    // dirty region is threaded through paintNode so subtrees that cannot
    // reach it are pruned from the traversal entirely.
    if (this.rootNode) {
      paintNode(this.ctx, this.rootNode, dirtyRegion);

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
    this.textEditor.endEditing();
    this.rootNode = null;
    this.nodes.clear();
    this.eventManager.setRootNode(null);
    this.scrollManager.setRootNode(null);
    this.selectionManager.setRootNode(null);
    this.accessibilityLayer.rebuild(null);
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
    // Re-enabling rebuilds the mirror from the current tree — incremental
    // sync has no history to replay for the disabled period.
    this.accessibilityLayer.setEnabled(
      this.options.enableAccessibility || false,
      this.rootNode,
    );
  }

  /**
   * Destroy renderer
   */
  destroy(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
    }
    if (typeof document !== "undefined") {
      (document as any).fonts?.removeEventListener?.("loadingdone", this.boundFontsLoaded);
    }
    this.eventManager.destroy();
    this.scrollManager.destroy();
    this.selectionManager.destroy();
    setSelectionManager(null);
    this.textEditor.destroy();
    setTextEditor(null);
    this.focusManager.destroy();
    this.accessibilityLayer.destroy();
  }
}

