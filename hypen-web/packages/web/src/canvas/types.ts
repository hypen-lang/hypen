/**
 * Canvas Renderer Types
 *
 * Shared type definitions for the canvas renderer
 */

import type { Semantics } from "@hypen-space/core/types";

export interface VirtualNode {
  id: string;
  type: string;
  props: Record<string, any>;
  children: VirtualNode[];
  parent: VirtualNode | null;

  /**
   * Engine-derived accessibility semantics (role, name, hidden, …) carried
   * from the Create patch. Drives the transparent accessibility overlay,
   * since the canvas bitmap itself exposes nothing to assistive technology.
   */
  semantics?: Semantics;

  // Computed layout
  layout?: Layout;

  // Rendering state
  visible: boolean;
  opacity: number;

  // Exit-animating subtree root (set by CanvasAnimator on a transition-
  // flagged remove). The node stays in the tree — still painted — until the
  // exit finalizes, but the whole subtree is excluded from hit-testing and
  // scroll targeting immediately: engine-side the id is already dead.
  exiting?: boolean;

  // Interaction state
  clickable: boolean;
  hoverable: boolean;
  focusable: boolean;
  focused: boolean;
  hovered: boolean;

  // Scroll state (managed by ScrollManager, not serialised)
  scrollState?: ScrollState;

  // Pointer-pressed (active) state, tracked by the event manager from
  // mousedown/mouseup so `:active` paint variants can resolve.
  pressed?: boolean;

  // --- Variant resolution bookkeeping (managed by applyVariants) ---
  // Set of applicator base names that have at least one `@bp`/`:state` variant
  // key on this node. Computed lazily; null means "not yet scanned", an empty
  // set means "scanned, no variants".
  variantBases?: Set<string> | null;
  // Snapshot of the node's original (variant-free) base values, captured the
  // first time a variant override is applied so each frame resolves from the
  // un-overridden base instead of compounding overrides.
  variantOriginals?: Record<string, unknown>;
}

export interface Layout {
  x: number;
  y: number;
  width: number;
  height: number;

  // Box model
  margin: BoxSpacing;
  padding: BoxSpacing;
  border: BorderStyle;

  // Content area (after padding)
  contentX: number;
  contentY: number;
  contentWidth: number;
  contentHeight: number;
}

export interface BoxSpacing {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface BorderStyle {
  width: number;
  color: string;
  radius: number;
}

export interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface FontStyle {
  fontFamily: string;
  fontSize: number;
  fontWeight: string | number;
  lineHeight?: number;
}

export interface TextStyle extends FontStyle {
  color: string;
  textAlign: "left" | "center" | "right";
  verticalAlign: "top" | "middle" | "bottom";
}

export interface TextMetrics {
  width: number;
  height: number;
  lines: string[];
  lineHeight: number;
}

export interface CanvasRendererOptions {
  // Display
  devicePixelRatio?: number;
  backgroundColor?: string;

  // Features
  //
  // enableAccessibility also gates text-input editing and keyboard focus:
  // the accessibility mirror (a transparent positioned overlay above the
  // canvas) is the renderer's focus system, and Input/Textarea edit
  // sessions start from mirror focus.
  enableAccessibility?: boolean;
  enableHitTesting?: boolean;

  // Performance
  enableDirtyRects?: boolean;
  enableLayerCaching?: boolean;
  maxLayerCacheSize?: number;

  // Debug
  showLayoutBounds?: boolean;
  showDirtyRects?: boolean;
  logPerformance?: boolean;
}

export interface PainterFunction {
  (ctx: CanvasRenderingContext2D, node: VirtualNode): void;
}

export interface LayoutFunction {
  (node: VirtualNode, availableWidth: number, availableHeight: number): {
    width: number;
    height: number;
  };
}

export interface ScrollState {
  /** Current scroll offset (pixels from origin) */
  scrollX: number;
  scrollY: number;

  /** Scroll velocity for momentum (px/ms) */
  velocityX: number;
  velocityY: number;

  /** Total scrollable content size (set during layout) */
  scrollWidth: number;
  scrollHeight: number;

  /** Whether a touch/pointer sequence is active */
  touching: boolean;

  /** Timestamp of last velocity sample */
  lastTouchTime: number;

  /** Scrollbar fade-out opacity (0–1) */
  scrollbarOpacity: number;
}

export interface DirtyRect extends Rectangle {
  frameId: number;
}











