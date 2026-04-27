/**
 * Canvas Renderer Types
 *
 * Shared type definitions for the canvas renderer
 */

export interface VirtualNode {
  id: string;
  type: string;
  props: Record<string, any>;
  children: VirtualNode[];
  parent: VirtualNode | null;

  // Computed layout
  layout?: Layout;

  // Rendering state
  visible: boolean;
  opacity: number;

  // Interaction state
  clickable: boolean;
  hoverable: boolean;
  focusable: boolean;
  focused: boolean;
  hovered: boolean;

  // Scroll state (managed by ScrollManager, not serialised)
  scrollState?: ScrollState;
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
  enableAccessibility?: boolean;
  enableHitTesting?: boolean;
  enableInputOverlay?: boolean;

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











