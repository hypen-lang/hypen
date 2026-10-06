import { dispatchUIAction } from "@hypen-space/core";
import { pinOffset } from "./pin-position";
/**
 * Paint System
 *
 * Drawing virtual nodes to canvas
 */

import type { VirtualNode, PainterFunction, Rectangle } from "./types.js";
import { measureText, renderText } from "./text.js";
import { ScrollManager, isScrollable } from "./scroll.js";
import { getVisibleChildren, VIRTUALIZE_THRESHOLD } from "./virtualize.js";
import type { SelectionManager } from "./selection.js";
import type { TextEditController } from "./editing.js";
import {
  SELECTION_HIGHLIGHT_COLOR,
  offsetToCaretRect,
  rangeToRects,
} from "./text-geometry.js";
import {
  cssLengthToPx,
  cssLengthToPxForFont,
  cssLineHeightToPx,
  isLayoutHidden,
  inheritedTextProp,
  ownTextColor,
} from "./utils.js";
import { paintChartMark } from "./chart.js";
import {
  PLAYBACK_REPORT_INTERVAL_MS,
  PLAYBACK_SEEK_EPSILON_S,
  VIDEO_SLOTS,
  VIDEO_SLOT_VISIBILITY,
  type PlaybackBinding,
  type VideoPlayerState,
  type VideoSlotName,
} from "@hypen-space/core/types";

/**
 * Module-level reference to the active SelectionManager so paintText
 * can render selection highlights. Set once from the renderer.
 */
let activeSelectionManager: SelectionManager | null = null;
export function setSelectionManager(mgr: SelectionManager | null): void {
  activeSelectionManager = mgr;
}

/**
 * Module-level reference to the active TextEditController so paintInput can
 * render the edited value, selection highlight, composition underline, and
 * blinking caret. Same late-binding pattern as the SelectionManager hook.
 */
let activeTextEditor: TextEditController | null = null;
export function setTextEditor(editor: TextEditController | null): void {
  activeTextEditor = editor;
}

/**
 * Custom painters registry
 */
const customPainters = new Map<string, PainterFunction>();

/**
 * Register a custom painter for a component type
 */
export function registerPainter(type: string, painter: PainterFunction): void {
  customPainters.set(type.toLowerCase(), painter);
}

/**
 * Per-font character advance widths, used by the manual letter-spacing path
 * so each glyph is shaped once per font instead of once per frame.
 */
const charAdvanceCache = new Map<string, Map<string, number>>();
const MAX_CHAR_ADVANCE_FONTS = 32;

/**
 * Clear cached per-character advances. Must be called when web fonts finish
 * loading: the cache is keyed by CSS font string, which is identical before
 * and after a webfont replaces its fallback, so advances measured against
 * the fallback font would otherwise poison letter-spaced rendering
 * permanently.
 */
export function clearCharAdvanceCache(): void {
  charAdvanceCache.clear();
}

function charAdvance(ctx: CanvasRenderingContext2D, font: string, ch: string): number {
  let perFont = charAdvanceCache.get(font);
  if (!perFont) {
    perFont = new Map();
    charAdvanceCache.set(font, perFont);
    evictMap(charAdvanceCache, MAX_CHAR_ADVANCE_FONTS);
  }
  let width = perFont.get(ch);
  if (width === undefined) {
    width = ctx.measureText(ch).width;
    perFont.set(ch, width);
  }
  return width;
}

/**
 * Component types whose painters set sticky canvas state (textAlign,
 * textBaseline, lineCap, shadows, …) that must not leak to siblings — they
 * need a scoping save/restore pair. Containers, text, and spacers (and
 * every unknown type, which routes to paintContainer) only touch state each
 * draw call re-sets before use, so they paint without one.
 */
const STATE_UNSAFE_TYPES = new Set([
  "button",
  "input",
  "textarea",
  "image",
  "video",
  "divider",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "scrubber",
  "progressbar",
  "spinner",
  "card",
  "badge",
  "avatar",
  "icon",
  "link",
  // Chart marks set lineWidth, dashes, shadows, font and textAlign.
  "chart",
  "line",
  "area",
  "bars",
  "points",
  "axis",
  "rule",
  "path",
]);

/** Whether any transform-related prop is present on the node. */
function hasTransformProps(props: Record<string, any>): boolean {
  return (
    props.transform !== undefined ||
    props["__dnd.pinX"] !== undefined || props["__dnd.pinY"] !== undefined ||
    props.translateX !== undefined ||
    props.translateY !== undefined ||
    props.rotate !== undefined ||
    props.scale !== undefined ||
    props.scaleX !== undefined ||
    props.scaleY !== undefined ||
    props.skew !== undefined ||
    props.skewX !== undefined ||
    props.skewY !== undefined
  );
}

/** Extra pixels a node's painting may reach beyond its layout box. */
const CULL_SLACK = 8;

/** How far a shadow can bleed outside the box it is attached to. */
function shadowExtent(shadow: any): number {
  if (typeof shadow === "string") {
    const parts = shadow.trim().split(/\s+/);
    const ox = Math.abs(parseFloat(parts[0])) || 0;
    const oy = Math.abs(parseFloat(parts[1])) || 0;
    const blur = Math.abs(parseFloat(parts[2])) || 0;
    return Math.max(ox, oy) + blur;
  }
  if (shadow && typeof shadow === "object") {
    return (
      Math.max(Math.abs(shadow.offsetX || 0), Math.abs(shadow.offsetY || 0)) +
      Math.abs(shadow.blur || 0)
    );
  }
  return 0;
}

/**
 * Whether the whole subtree rooted at `node` can be skipped when repainting
 * only `cull`. Conservative: nodes with transforms or custom painters are
 * never culled (they can draw anywhere), the box is expanded by shadow
 * bleed + slack, and a node with children is only culled when it clips them.
 */
function canCullSubtree(node: VirtualNode, cull: Rectangle): boolean {
  const layout = node.layout!;
  if (hasTransformProps(node.props) || node.dndOffset !== undefined) return false;
  if (customPainters.has(node.type.toLowerCase())) return false;

  const shadow = node.props.shadow || node.props.boxShadow || node.props.textShadow;
  const margin = CULL_SLACK + (shadow ? shadowExtent(shadow) : 0);
  if (
    layout.x - margin < cull.x + cull.width &&
    layout.x + layout.width + margin > cull.x &&
    layout.y - margin < cull.y + cull.height &&
    layout.y + layout.height + margin > cull.y
  ) {
    return false;
  }

  if (node.children.length === 0) return true;
  const overflow = node.props.overflow;
  return overflow === "hidden" || overflow === "scroll" || overflow === "auto";
}

/**
 * Paint a virtual node and its children.
 *
 * `cull` (optional) is the dirty region being repainted — subtrees that
 * provably cannot reach it are skipped entirely.
 */
export function paintNode(
  ctx: CanvasRenderingContext2D,
  node: VirtualNode,
  cull?: Rectangle | null,
): void {
  if (!node.visible || !node.layout) return;
  // Out of the visual flow: `display: none` (Tailwind `hidden`, often paired
  // with `md:flex`) or a screen-reader-only `VisuallyHidden` wrapper. The
  // layout pass already gave it a zero box, but a zero-box Text/Image still
  // paints its placeholder — skip the whole subtree instead.
  if (isLayoutHidden(node)) return;
  if (node.dndGhost && node !== ghostPassNode) return;
  if (cull && canCullSubtree(node, cull)) return;

  const type = node.type.toLowerCase();
  const customPainter = customPainters.get(type);
  const needsTransform = hasTransformProps(node.props);
  const blurRadius = Math.max(0, cssLengthToPx(node.props.blur) ?? 0);
  // Transform, opacity and blur are subtree effects in every other renderer.
  // Keep the Canvas state alive while descendants paint as well; restoring it
  // immediately after the host box made child text escape those effects.
  const dndOffset = node.dndOffset;
  const hasDndOffset = !!dndOffset && (dndOffset.x !== 0 || dndOffset.y !== 0);
  const hasSubtreeEffect = needsTransform || hasDndOffset || node.opacity < 1 || blurRadius > 0;
  const needsSave =
    customPainter !== undefined ||
    hasSubtreeEffect ||
    STATE_UNSAFE_TYPES.has(type);

  if (needsSave) {
    ctx.save();

    if (hasDndOffset) ctx.translate(dndOffset!.x, dndOffset!.y);

    // Apply transforms
    if (needsTransform) {
      applyTransforms(ctx, node);
    }

    // Apply opacity
    if (node.opacity < 1) {
      ctx.globalAlpha = node.opacity;
    }

    if (blurRadius > 0 && "filter" in ctx) {
      ctx.filter = `blur(${blurRadius}px)`;
    }
  }

  // Check for custom painter
  if (customPainter) {
    customPainter(ctx, node);
    ctx.restore();
    return;
  }

  // Default painting based on type
  switch (type) {
    case "column":
    case "row":
    case "stack":
      paintContainer(ctx, node);
      break;
    case "text":
      // Text can own the same visual box applicators as any other element
      // (background, border, radius, shadow). Paint that box before glyphs;
      // previously Spacer demos looked empty because their colored children
      // were Text nodes and only the white glyphs were drawn.
      paintContainer(ctx, node);
      paintText(ctx, node);
      break;
    case "button":
      paintButton(ctx, node);
      break;
    case "input":
    case "textarea":
      paintInput(ctx, node);
      break;
    case "select":
      paintSelect(ctx, node);
      break;
    case "image":
      paintImage(ctx, node);
      break;
    case "video":
      paintVideo(ctx, node);
      break;
    case "spacer":
      // Spacer is invisible, just takes up space
      break;
    case "divider":
      paintDivider(ctx, node);
      break;
    case "checkbox":
      paintCheckbox(ctx, node);
      break;
    case "radio":
      paintRadio(ctx, node);
      break;
    case "switch":
      paintSwitch(ctx, node);
      break;
    case "slider":
      paintSlider(ctx, node);
      break;
    case "scrubber":
      paintScrubber(ctx, node);
      break;
    case "progressbar":
      paintProgress(ctx, node);
      break;
    case "spinner":
      paintSpinner(ctx, node);
      break;
    case "card":
      paintCard(ctx, node);
      break;
    case "badge":
      paintBadge(ctx, node);
      break;
    case "avatar":
      paintAvatar(ctx, node);
      break;
    case "audio":
      paintAudio(ctx, node);
      break;
    case "icon":
      paintIcon(ctx, node);
      break;
    case "link":
      paintLink(ctx, node);
      break;
    // Chart host: its own box paints like any container; the marks are its
    // children and paint themselves against the resolved plot rect.
    case "chart":
      paintContainer(ctx, node);
      break;
    // Chart marks. Outside a Chart these types mean nothing and draw
    // nothing — `paintChartMark` returns early unless the parent is a Chart.
    // A Marker draws nothing itself; its Hypen children are ordinary nodes
    // and paint normally at the box the chart layout placed them in.
    case "line":
    case "area":
    case "bars":
    case "points":
    case "axis":
    case "rule":
    case "path":
    case "marker":
      if (!paintChartMark(ctx, node)) paintContainer(ctx, node);
      break;
    case "app":
    case "container":
    case "box":
    // SafeArea paints like any other container: its background fills the
    // whole box, insets included, and only its children are inset.
    case "safearea":
      paintContainer(ctx, node);
      break;
    default:
      paintContainer(ctx, node);
  }

  if (needsSave && !hasSubtreeEffect) {
    ctx.restore();
  }

  // Apply scroll translation for scrollable containers
  const ss = node.scrollState;
  let childCull = cull ?? null;
  if (ss && (ss.scrollX !== 0 || ss.scrollY !== 0)) {
    ctx.save();
    ctx.translate(-ss.scrollX, -ss.scrollY);
    (node as any)._scrollRestore = true;
    // Children paint in scrolled space — shift the cull region to match.
    if (childCull) {
      childCull = {
        x: childCull.x + ss.scrollX,
        y: childCull.y + ss.scrollY,
        width: childCull.width,
        height: childCull.height,
      };
    }
  }

  // Paint children -- use windowed rendering for large scrollable lists
  const shouldVirtualize =
    isScrollable(node) &&
    node.children.length > VIRTUALIZE_THRESHOLD &&
    node.layout != null;

  // A Video's children are composition slots, not flow content: only the
  // ones the normative visibility table shows in the current player state
  // paint (hidden ≠ removed — the subtree keeps its state, it is simply
  // skipped here, by hit testing, and by the a11y mirror). Untagged
  // children of a Video are invalid per the contract and never paint.
  let childrenToPaint = type === "select"
    ? []
    : isVideoNode(node)
    ? visibleVideoSlotChildren(node)
    : shouldVirtualize
    ? getVisibleChildren(node, {
        x: node.layout!.x,
        y: node.layout!.y,
        width: node.layout!.width,
        height: node.layout!.height,
      })
    : node.children;

  if (type === "stack" && childrenToPaint.length > 1) {
    // Layout child indices are keyed to retained tree order. Never mutate
    // node.children while choosing a paint order, or nodes get paired with
    // another sibling's computed rectangle.
    childrenToPaint = [...childrenToPaint].sort((a, b) => {
      const za = Number(a.props.zIndex ?? a.props["z-index"] ?? 0);
      const zb = Number(b.props.zIndex ?? b.props["z-index"] ?? 0);
      return za - zb;
    });
  }

  // Paint flow children first, then absolute-positioned overlays on top.
  // CSS uses `z-index` to order absolute siblings; Canvas just paints in
  // tree order, so a `position: absolute` header declared FIRST in the
  // tree (Story uses this for its close button) gets covered by the
  // following in-flow Image. Push absolute kids to the end so they land
  // on top — same effect as `z-index: auto` painting absolute after flow.
  // Video slot children are exempt: their stacking is the normative slot
  // paint order `visibleVideoSlotChildren` already returns, and a
  // `position: absolute` on a slot must not re-order it above `error`.
  let hasOverlays = false;
  for (const child of childrenToPaint) {
    if (!isVideoNode(node) && child.props.position === "absolute") {
      hasOverlays = true;
      continue;
    }
    paintNode(ctx, child, childCull);
  }
  if (hasOverlays) {
    for (const child of childrenToPaint) {
      if (child.props.position === "absolute") {
        paintNode(ctx, child, childCull);
      }
    }
  }

  // Undo scroll translation before drawing scrollbars
  if ((node as any)._scrollRestore) {
    ctx.restore();
    delete (node as any)._scrollRestore;
  }

  // Paint scrollbar indicators (on top of children, inside clip)
  if (ss && ss.scrollbarOpacity > 0) {
    ScrollManager.paintScrollbars(ctx, node);
  }

  // Restore context if overflow clipping was applied
  if ((node as any)._needsRestore) {
    ctx.restore();
    delete (node as any)._needsRestore;
  }

  if (needsSave && hasSubtreeEffect) {
    ctx.restore();
  }
}

/**
 * Paint a container (Column, Row, Stack, Box)
 */
function paintContainer(ctx: CanvasRenderingContext2D, node: VirtualNode): void {
  const layout = node.layout!;
  const props = node.props;

  const x = layout.x;
  const y = layout.y;
  const width = layout.width;
  const height = layout.height;
  const radius = layout.border.radius;

  // Apply shadow if specified
  const shadow = props.shadow || props.boxShadow;
  if (shadow) {
    applyShadow(ctx, shadow);
  }

  // Draw background
  const background = resolveBackgroundPaint(props);
  if (background) {
    ctx.fillStyle = resolveCanvasPaint(ctx, background, x, y, width, height);

    if (radius > 0) {
      drawRoundedRect(ctx, x, y, width, height, radius);
      ctx.fill();
    } else {
      ctx.fillRect(x, y, width, height);
    }
  }

  // Reset shadow for border
  if (shadow) {
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
  }

  // Draw border
  if (layout.border.width > 0 && layout.border.color !== "transparent") {
    ctx.strokeStyle = layout.border.color;
    ctx.lineWidth = layout.border.width;
    applyBorderLineStyle(ctx, props, layout.border.width);
    if (radius > 0) {
      drawRoundedRect(ctx, x, y, width, height, radius);
      ctx.stroke();
    } else {
      ctx.strokeRect(x, y, width, height);
    }
    ctx.setLineDash?.([]);
  }

  // Apply overflow clipping for children.
  //
  // `.scrollable("horizontal")` (Hypeflix's poster rails) sets `scrollable`,
  // not `overflow` — so without asking `isScrollable` too, a rail's off-screen
  // posters painted straight over the page margins and the neighbouring
  // sections instead of being clipped to the strip.
  const overflow = props.overflow || "visible";
  if (
    overflow === "hidden" ||
    overflow === "scroll" ||
    overflow === "auto" ||
    overflow === "clip" ||
    isScrollable(node)
  ) {
    ctx.save();
    ctx.beginPath();
    if (radius > 0) {
      drawRoundedRect(ctx, x, y, width, height, radius);
    } else {
      ctx.rect(x, y, width, height);
    }
    ctx.clip();

    // Mark that we need to restore later
    (node as any)._needsRestore = true;
  }
}

/** Match the DOM border applicator's solid/dashed/dotted styles. */
function applyBorderLineStyle(
  ctx: CanvasRenderingContext2D,
  props: Record<string, any>,
  width: number,
): void {
  const compound = props.border && typeof props.border === "object"
    ? props.border as Record<string, any>
    : null;
  const style = String(props.borderStyle ?? compound?.style ?? "solid").toLowerCase();
  if (style === "dashed") {
    ctx.setLineDash?.([Math.max(3, width * 3), Math.max(2, width * 2)]);
  } else if (style === "dotted") {
    ctx.setLineDash?.([Math.max(1, width), Math.max(2, width * 1.75)]);
  } else {
    ctx.setLineDash?.([]);
  }
}

/**
 * Paint text node
 */
function paintText(ctx: CanvasRenderingContext2D, node: VirtualNode): void {
  // Draw selection highlight behind text
  if (activeSelectionManager) {
    activeSelectionManager.paintSelection(ctx, node);
  }

  const layout = node.layout!;
  const props = node.props;

  let text = String(props[0] || props.text || "");
  const color = inheritedTextProp(node, "color") || "#000000";
  const fontSize = cssLengthToPx(inheritedTextProp(node, "fontSize")) ?? 16;
  const fontWeight = inheritedTextProp(node, "fontWeight") || "normal";
  const fontFamily = inheritedTextProp(node, "fontFamily") || "system-ui, sans-serif";
  const textAlign = inheritedTextProp(node, "textAlign") || "left";
  const lineHeight = cssLineHeightToPx(inheritedTextProp(node, "lineHeight"), fontSize) ?? fontSize * 1.2;
  const textDecoration = props.textDecoration || "none";
  const textTransform = props.textTransform || "none";
  // `em` in `letter-spacing` is relative to the element's OWN font size, so
  // Tailwind's `tracking-[0.2em]` on a `text-2xl` heading is 4.8px, not the
  // 3.2px a root-relative `em` would give.
  const letterSpacing = cssLengthToPxForFont(props.letterSpacing, fontSize) ?? 0;

  // Apply text transform
  if (textTransform === "uppercase") {
    text = text.toUpperCase();
  } else if (textTransform === "lowercase") {
    text = text.toLowerCase();
  } else if (textTransform === "capitalize") {
    text = text.replace(/\b\w/g, (char) => char.toUpperCase());
  }

  // Apply text shadow if specified
  const textShadow = props.textShadow || props.shadow;
  if (textShadow) {
    applyShadow(ctx, textShadow);
  }

  // Handle letter spacing
  const x = layout.x + layout.contentX;
  const y = layout.y + layout.contentY;

  if (letterSpacing !== 0) {
    // Manual letter spacing
    ctx.fillStyle = color;
    const font = `${fontWeight} ${fontSize}px ${fontFamily}`;
    ctx.font = font;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";

    // Honour `text-align` here too. Canvas's own `textAlign` can't be used —
    // we place each glyph by hand — so shift the run's start instead. Without
    // this, any `text-center` / `text-right` heading that ALSO carried a
    // `tracking-*` class silently fell back to left alignment (Hypeflix's
    // `text-center tracking-tight` movie title pinned to the left edge).
    let runWidth = 0;
    for (let i = 0; i < text.length; i++) {
      runWidth += charAdvance(ctx, font, text[i]);
      if (i < text.length - 1) runWidth += letterSpacing;
    }
    let startX = x;
    if (textAlign === "center") startX = x + (layout.contentWidth - runWidth) / 2;
    else if (textAlign === "right" || textAlign === "end") {
      startX = x + layout.contentWidth - runWidth;
    }

    let currentX = startX;
    for (let i = 0; i < text.length; i++) {
      ctx.fillText(text[i], currentX, y);
      currentX += charAdvance(ctx, font, text[i]);
      // Add letter spacing after each character except the last
      if (i < text.length - 1) {
        currentX += letterSpacing;
      }
    }

    // Text decoration with letter spacing (now correct width) — anchored to
    // the aligned run, not the box origin.
    if (textDecoration !== "none") {
      applyTextDecoration(ctx, textDecoration, color, startX, y, currentX - startX, fontSize);
    }
  } else {
    const maxLinesRaw = props.maxLines;
    const maxLines =
      typeof maxLinesRaw === "number"
        ? maxLinesRaw
        : typeof maxLinesRaw === "string"
          ? parseInt(maxLinesRaw, 10) || undefined
          : undefined;
    const textOverflow =
      props.textOverflow === "ellipsis" || props.textOverflow === "clip"
        ? (props.textOverflow as "ellipsis" | "clip")
        : maxLines !== undefined ? "ellipsis" : undefined;

    renderText(
      ctx,
      text,
      x,
      y,
      layout.contentWidth,
      layout.contentHeight,
      {
        color,
        fontSize,
        fontWeight,
        fontFamily,
        textAlign: textAlign as any,
        verticalAlign: "top",
        lineHeight,
      },
      maxLines,
      textOverflow
    );

    // Text decoration — reuse the wrapped metrics renderText just resolved
    // (cache hit) instead of re-shaping the raw, unwrapped string.
    if (textDecoration !== "none") {
      const metrics = measureText(
        ctx,
        text,
        { fontSize, fontWeight, fontFamily, lineHeight },
        layout.contentWidth,
        maxLines,
        textOverflow,
      );
      applyTextDecoration(ctx, textDecoration, color, x, y, metrics.width, fontSize);
    }
  }

  // Reset shadow
  if (textShadow) {
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
  }
}

/**
 * Paint button node
 */
function paintButton(ctx: CanvasRenderingContext2D, node: VirtualNode): void {
  const layout = node.layout!;
  const props = node.props;

  const x = layout.x;
  const y = layout.y;
  const width = layout.width;
  const height = layout.height;
  const radius = layout.border.radius || 4;

  // Apply shadow if specified
  const shadow = props.shadow || props.boxShadow;
  if (shadow) {
    applyShadow(ctx, shadow);
  }

  // Resolve background from state. The DOM, iOS, and Android renderers all
  // paint no background for a button until the caller supplies one — match
  // that here (canvas used to default to `#007bff`, which made bare
  // `Button { Text("-") }` render as a blue pill in canvas but plain text
  // in DOM/native). Hover/focus only apply when the caller opts in via
  // `hoverColor`/`focusColor`.
  let backgroundColor: string | undefined;
  if (node.hovered && props.hoverColor !== undefined) {
    backgroundColor = props.hoverColor;
  } else if (node.focused && props.focusColor !== undefined) {
    backgroundColor = props.focusColor;
  } else {
    backgroundColor = resolveBackgroundPaint(props);
  }

  if (backgroundColor !== undefined) {
    ctx.fillStyle = resolveCanvasPaint(ctx, backgroundColor, x, y, width, height);
    drawRoundedRect(ctx, x, y, width, height, radius);
    ctx.fill();
  }

  // Reset shadow for border
  if (shadow) {
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
  }

  // Draw border
  if (layout.border.width > 0) {
    ctx.strokeStyle = layout.border.color;
    ctx.lineWidth = layout.border.width;
    drawRoundedRect(ctx, x, y, width, height, radius);
    ctx.stroke();
  }

  // Keyboard focus ring. Focus lives on the node's (unrendered) mirror
  // element in the canvas fallback content, so the UA can't draw a ring at
  // the painted box — paint one so keyboard users can see where they are.
  if (node.focused) {
    ctx.save();
    ctx.strokeStyle = props.focusRingColor || "#007bff";
    ctx.lineWidth = 2;
    drawRoundedRect(ctx, x - 2, y - 2, width + 4, height + 4, radius + 2);
    ctx.stroke();
    ctx.restore();
  }

}

/**
 * Paint input node
 */
function paintInput(ctx: CanvasRenderingContext2D, node: VirtualNode): void {
  const layout = node.layout!;
  const props = node.props;

  const x = layout.x;
  const y = layout.y;
  const width = layout.width;
  const height = layout.height;
  const radius = layout.border.radius || 4;

  // Background
  ctx.fillStyle = props.backgroundColor || "#ffffff";
  drawRoundedRect(ctx, x, y, width, height, radius);
  ctx.fill();

  // Border (thicker if focused)
  const borderColor = node.focused ? "#007bff" : (layout.border.color || "#cccccc");
  const borderWidth = node.focused ? 2 : (layout.border.width || 1);
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = borderWidth;
  drawRoundedRect(ctx, x, y, width, height, radius);
  ctx.stroke();

  const isSingleLine = node.type.toLowerCase() === "input";

  // While editing, the mirror element (via TextEditController) is the value
  // source — paint stays ahead of the engine's SetProp echo.
  const edit = activeTextEditor?.getStateFor(node) ?? null;

  const value = edit ? edit.value : (props.value || "");
  const placeholder = props.placeholder || "";
  const text = value || placeholder;
  const textColor = value ? (ownTextColor(props) || "#000000") : "#999999";

  const fontSize = cssLengthToPx(props.fontSize) ?? 16;
  const fontWeight = props.fontWeight || "normal";
  const fontFamily = props.fontFamily || "system-ui, sans-serif";
  const lineHeight = cssLineHeightToPx(props.lineHeight, fontSize) ?? fontSize * 1.2;

  if (!edit) {
    if (text) {
      renderText(
        ctx,
        text,
        layout.x + layout.contentX,
        layout.y + layout.contentY,
        layout.contentWidth,
        layout.contentHeight,
        {
          color: textColor,
          fontSize,
          fontWeight,
          fontFamily,
          textAlign: "left",
          verticalAlign: isSingleLine ? "middle" : "top",
          lineHeight,
        }
      );
    }
    return;
  }

  // ---- Editing visuals: clip → selection highlight → text → composition
  // ---- underline → caret. Geometry comes from the edit controller so
  // ---- pointer mapping and painting share identical math (incl. scrollX).
  ctx.save();
  drawRoundedRect(ctx, x, y, width, height, radius);
  ctx.clip();

  const g = activeTextEditor!.geometry(
    layout.x + layout.contentX - edit.scrollX,
    layout.y + layout.contentY,
  );

  // Selection highlight behind the text
  if (edit.selStart !== edit.selEnd) {
    const from = Math.min(edit.selStart, edit.selEnd);
    const to = Math.max(edit.selStart, edit.selEnd);
    ctx.fillStyle = SELECTION_HIGHLIGHT_COLOR;
    for (const r of rangeToRects(ctx, g, from, to)) {
      ctx.fillRect(r.x, r.y, r.width, r.height);
    }
  }

  if (text) {
    renderText(
      ctx,
      value || placeholder,
      g.contentX,
      layout.y + layout.contentY,
      // Single-line inputs never wrap — the clip + scrollX pan handle
      // overflow. Textareas wrap at content width like static paint.
      isSingleLine ? Number.POSITIVE_INFINITY : layout.contentWidth,
      layout.contentHeight,
      {
        color: textColor,
        fontSize,
        fontWeight,
        fontFamily,
        textAlign: "left",
        verticalAlign: isSingleLine ? "middle" : "top",
        lineHeight,
      }
    );
  }

  // IME composition underline (dashed, under the composing range)
  if (edit.compStart !== null && edit.compEnd !== null && edit.compEnd > edit.compStart) {
    ctx.strokeStyle = ownTextColor(props) || "#000000";
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);
    for (const r of rangeToRects(ctx, g, edit.compStart, edit.compEnd)) {
      ctx.beginPath();
      ctx.moveTo(r.x, r.y + r.height - 2);
      ctx.lineTo(r.x + r.width, r.y + r.height - 2);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  // Caret (hidden while a range is selected, blinks via the edit timer)
  if (edit.caretVisible && edit.selStart === edit.selEnd) {
    const caret = offsetToCaretRect(ctx, g, edit.selEnd);
    ctx.fillStyle = ownTextColor(props) || "#000000";
    ctx.fillRect(caret.x, caret.y + 1, 1.5, caret.height - 2);
  }

  ctx.restore();
}

function paintSelect(ctx: CanvasRenderingContext2D, node: VirtualNode): void {
  const layout = node.layout!;
  const props = node.props;
  const radius = layout.border.radius || 4;
  ctx.fillStyle = props.backgroundColor || "#ffffff";
  drawRoundedRect(ctx, layout.x, layout.y, layout.width, layout.height, radius);
  ctx.fill();
  ctx.strokeStyle = layout.border.width > 0 ? layout.border.color : "#d1d5db";
  ctx.lineWidth = layout.border.width || 1;
  drawRoundedRect(ctx, layout.x, layout.y, layout.width, layout.height, radius);
  ctx.stroke();

  const selected = props.value
    ?? props.placeholder
    ?? node.children.find(child => child.type.toLowerCase() === "text")?.props[0]
    ?? "Select…";
  const fontSize = cssLengthToPx(props.fontSize) ?? 16;
  ctx.fillStyle = ownTextColor(props) || "#111827";
  ctx.font = `${props.fontWeight || "normal"} ${fontSize}px ${props.fontFamily || "system-ui, sans-serif"}`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillText(String(selected), layout.x + 10, layout.y + layout.height / 2);

  const cx = layout.x + layout.width - 14;
  const cy = layout.y + layout.height / 2;
  ctx.beginPath();
  ctx.moveTo(cx - 4, cy - 2);
  ctx.lineTo(cx + 4, cy - 2);
  ctx.lineTo(cx, cy + 3);
  ctx.closePath();
  ctx.fill();
}

/**
 * Image cache for canvas renderer
 */
const MAX_IMAGE_CACHE_SIZE = 100;
const MAX_FAIL_CACHE_SIZE = 200;
const imageCache = new Map<string, HTMLImageElement>();
const imagePending = new Set<string>();
const imageInFlight = new Map<string, HTMLImageElement>();
const imageFailCache = new Map<string, { failedAt: number; attempts: number }>();
const IMAGE_FAIL_COOLDOWN_MS = 30_000;
const IMAGE_MAX_ATTEMPTS = 3;

/**
 * Cached intrinsic aspect ratios (width / height) for decoded images. The
 * layout engine reads this to give an Image with only one declared dimension
 * the right size on the other axis (instead of stretching to Taffy auto).
 *
 * Populated when an Image's onload fires; tests can seed it via
 * `setImageNaturalSize` to assert the layout path without a real DOM.
 */
const imageNaturalAspect = new Map<string, number>();
const imageNaturalSize = new Map<string, { width: number; height: number }>();

/** Returns width/height of the cached image, or null if unknown. */
export function getImageNaturalAspect(src: string): number | null {
  return imageNaturalAspect.get(src) ?? null;
}

/** Returns the decoded intrinsic pixel dimensions, or null before load. */
export function getImageNaturalSize(src: string): { width: number; height: number } | null {
  return imageNaturalSize.get(src) ?? null;
}

/** Test helper: seed the intrinsic-size cache without loading a real image. */
export function setImageNaturalSize(src: string, width: number, height: number): void {
  if (width > 0 && height > 0) {
    imageNaturalAspect.set(src, width / height);
    imageNaturalSize.set(src, { width, height });
  }
}

/**
 * Evict oldest entries from a Map when it exceeds the given maximum size.
 */
function evictMap<V>(map: Map<string, V>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/**
 * Purge expired entries from imageFailCache.
 */
function purgeExpiredFailures(): void {
  const now = Date.now();
  for (const [key, entry] of imageFailCache) {
    if (entry.attempts >= IMAGE_MAX_ATTEMPTS) continue; // Keep max-attempt entries until evicted by size
    if (now - entry.failedAt >= IMAGE_FAIL_COOLDOWN_MS) {
      imageFailCache.delete(key);
    }
  }
}

/**
 * Clear the image cache and cancel all in-flight loads, freeing resources.
 */
export function clearImageCache(): void {
  // Cancel in-flight Image loads so their callbacks cannot repopulate caches
  for (const img of imageInFlight.values()) {
    img.onload = null;
    img.onerror = null;
    img.src = "";
  }
  imageInFlight.clear();

  for (const img of imageCache.values()) {
    img.src = "";
  }
  imageCache.clear();
  imagePending.clear();
  imageFailCache.clear();
  imageNaturalAspect.clear();
  imageNaturalSize.clear();
}

/**
 * Paint image node
 */
function paintImage(ctx: CanvasRenderingContext2D, node: VirtualNode): void {
  const layout = node.layout!;
  const props = node.props;

  const src = props.src || props[0];
  if (!src) return;

  const x = layout.x;
  const y = layout.y;
  const width = layout.width;
  const height = layout.height;
  const radius = layout.border.radius;

  // Clip to the rounded box so `rounded-full` avatars actually paint as
  // circles. Without this, avatars and post-header photos paint as
  // squares behind their (correctly-rounded) story-ring border.
  const clipped = radius > 0 && width > 0 && height > 0;
  if (clipped) {
    ctx.save();
    drawRoundedRect(ctx, x, y, width, height, radius);
    ctx.clip();
  }

  const cached = imageCache.get(src);
  if (cached && cached.complete && cached.naturalWidth > 0) {
    // `objectFit: cover` is the social-feed default — fill the box without
    // squashing. Anything else (or unspecified) falls back to the prior
    // stretch behaviour for back-compat.
    if (props.objectFit === "cover") {
      drawImageCover(ctx, cached, x, y, width, height);
    } else {
      ctx.drawImage(cached, x, y, width, height);
    }
    if (clipped) ctx.restore();
    return;
  }

  // Draw placeholder while loading
  ctx.fillStyle = "#e0e0e0";
  ctx.fillRect(x, y, width, height);

  ctx.strokeStyle = "#999999";
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, width, height);

  ctx.fillStyle = "#666666";
  ctx.font = "14px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // Check if this URL has failed recently
  const failEntry = imageFailCache.get(src);
  if (failEntry) {
    if (failEntry.attempts >= IMAGE_MAX_ATTEMPTS || Date.now() - failEntry.failedAt < IMAGE_FAIL_COOLDOWN_MS) {
      ctx.fillText("Failed", x + width / 2, y + height / 2);
      if (clipped) ctx.restore();
      return;
    }
  }

  ctx.fillText("Loading...", x + width / 2, y + height / 2);
  if (clipped) ctx.restore();

  // Start loading if not already pending
  if (!imagePending.has(src)) {
    imagePending.add(src);
    const canvas = ctx.canvas;
    const img = new Image();
    img.crossOrigin = "anonymous";
    imageInFlight.set(src, img);
    img.onload = () => {
      imageInFlight.delete(src);
      imageCache.set(src, img);
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        imageNaturalAspect.set(src, img.naturalWidth / img.naturalHeight);
        imageNaturalSize.set(src, { width: img.naturalWidth, height: img.naturalHeight });
      }
      imagePending.delete(src);
      imageFailCache.delete(src);
      evictMap(imageCache, MAX_IMAGE_CACHE_SIZE);
      // Request a repaint so the loaded image is drawn. `layout: true`
      // because the decoded intrinsic size can change the image's box
      // (see getImageNaturalAspect in layout.ts).
      canvas.dispatchEvent(new CustomEvent("hypen:redraw", { detail: { layout: true } }));
    };
    img.onerror = () => {
      imageInFlight.delete(src);
      imagePending.delete(src);
      purgeExpiredFailures();
      imageFailCache.set(src, {
        failedAt: Date.now(),
        attempts: (imageFailCache.get(src)?.attempts ?? 0) + 1,
      });
      evictMap(imageFailCache, MAX_FAIL_CACHE_SIZE);
    };
    img.src = src;
  }
}

/**
 * Draw an image with `object-fit: cover` semantics — fill the entire
 * destination box without distortion, cropping the longer source axis.
 */
function drawImageCover(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
): void {
  const sw = img.naturalWidth;
  const sh = img.naturalHeight;
  if (sw <= 0 || sh <= 0) {
    ctx.drawImage(img, dx, dy, dw, dh);
    return;
  }
  const srcAspect = sw / sh;
  const dstAspect = dw / dh;
  let sx = 0, sy = 0, sWidth = sw, sHeight = sh;
  if (srcAspect > dstAspect) {
    // Source is wider — crop horizontally.
    sWidth = sh * dstAspect;
    sx = (sw - sWidth) / 2;
  } else if (srcAspect < dstAspect) {
    // Source is taller — crop vertically.
    sHeight = sw / dstAspect;
    sy = (sh - sHeight) / 2;
  }
  ctx.drawImage(img, sx, sy, sWidth, sHeight, dx, dy, dw, dh);
}

/* ==========================================================================
 * Video support
 *
 * Canvas has no media element of its own, so each Video node drives an
 * OFFSCREEN `<video>` element (never inserted into the document) and paints
 * its current frame with `drawImage` — the capability-matrix approach for
 * the canvas renderer ("offscreen <video> → canvas"). Elements are keyed by
 * NODE ID, not URL: two Video nodes showing the same URL play independently.
 *
 * See hypen-docs/content/docs/guide/components.mdx for the normative contract.
 * ========================================================================== */

/** readyState threshold: a decodable frame exists at currentTime. */
const HAVE_CURRENT_DATA = 2;

/** Intrinsic aspect assumed before `loadedmetadata` fires. */
const DEFAULT_VIDEO_ASPECT = 16 / 9;

/** Engine action dispatcher — late-bound by the renderer, same pattern as
 * the SelectionManager/TextEditController hooks above. */
type VideoActionDispatcher = (name: string, payload?: any) => void;
let videoActionDispatcher: VideoActionDispatcher | null = null;
export function setVideoActionDispatcher(fn: VideoActionDispatcher | null): void {
  videoActionDispatcher = fn;
}

interface VideoEntry {
  video: HTMLVideoElement;
  /** Canvas to poke with `hypen:redraw` when frames/metadata arrive. */
  canvas: HTMLCanvasElement | null;
  /** The node this entry paints for — re-pointed every paint so event
   *  handlers resolve action props against live values. */
  node: VirtualNode;
  /** Resolved play queue (playlist, or [src] for single-source). */
  tracks: string[];
  index: number;
  /** Wire URL of the loaded track (blob substitution happens below it). */
  currentSrc: string;
  loop: boolean;
  headers: Record<string, string> | null;
  /** Playback has been started at least once (autoplay or tap). */
  started: boolean;
  playing: boolean;
  /** Current track failed to fetch/decode — quiet error state. */
  error: boolean;
  /**
   * Normative player state (hypen-docs/content/docs/guide/components.mdx §Player states).
   * Derived from the offscreen element's events; slot visibility and the
   * `playback` bind struct both read it verbatim.
   */
  state: VideoPlayerState;
  /**
   * True between a track's `ended` and the replacement track's first
   * `play`/`canplay`. A queue advance re-`load()`s the element, which fires
   * a `pause` the viewer never asked for — suppressed while this is set so
   * the advance produces `ended → trackchange`, never a phantom `pause`.
   */
  advancing: boolean;
  /** Resolved `.bind(@state.x)` path for the playback struct (null = unbound). */
  bindPath: string | null;
  /** Last struct field values this entry actually wrote back (echo guard). */
  lastReported: PlaybackBinding | null;
  /** `Date.now()` of the last throttled `position` report. */
  lastReportAt: number;
  /** Last inbound `playback.playing` / `.position` consumed from state. */
  lastInboundPlaying: boolean | null;
  /** Recent `playing` values we reported, for echo detection. */
  playingReportLog: Array<{ v: boolean; t: number }>;
  /** Timestamps of applied inbound writes that flipped play state. */
  inboundFlipLog: number[];
  lastInboundPosition: number | null;
  /** `startPosition` is a create-time seek — applied at most once. */
  startPositionApplied: boolean;
  /** Muted-autoplay fallback engaged; stop syncing `muted` from props. */
  mutedFallback: boolean;
  blobUrl: string | null;
  /** Monotonic token guarding async blob loads against stale completions. */
  loadToken: number;
  released: boolean;
  listeners: Array<[string, () => void]>;
  configKey: string;
}

const videoCache = new Map<string, VideoEntry>();

/**
 * Cached intrinsic aspect ratios (videoWidth / videoHeight), keyed by wire
 * URL — the layout engine reads these exactly like `imageNaturalAspect`.
 * Populated on `loadedmetadata`; tests seed it via `setVideoNaturalSize`.
 */
const videoNaturalAspect = new Map<string, number>();

/** Returns videoWidth/videoHeight for the URL, or null if unknown. */
export function getVideoNaturalAspect(src: string): number | null {
  return videoNaturalAspect.get(src) ?? null;
}

/** Test helper: seed the intrinsic-size cache without decoding real media. */
export function setVideoNaturalSize(src: string, width: number, height: number): void {
  if (width > 0 && height > 0) {
    videoNaturalAspect.set(src, width / height);
  }
}

/**
 * Aspect ratio the layout engine should assume for a Video node: the loaded
 * track's natural aspect when metadata has arrived, 16:9 until then.
 */
export function getVideoIntrinsicAspect(
  nodeId: string,
  props: Record<string, any>,
): number {
  const entry = videoCache.get(nodeId);
  let src = entry?.currentSrc;
  if (!src) {
    const { tracks, startIndex } = resolveVideoTracks(props);
    src = tracks[startIndex];
  }
  if (src) {
    const natural = videoNaturalAspect.get(src);
    if (natural) return natural;
  }
  return DEFAULT_VIDEO_ASPECT;
}

/** Test/diagnostic seam: the offscreen element behind a Video node. */
export function getVideoElement(nodeId: string): HTMLVideoElement | null {
  return videoCache.get(nodeId)?.video ?? null;
}

/** Test/diagnostic seam: current playlist index for a Video node. */
export function getVideoTrackIndex(nodeId: string): number | null {
  return videoCache.get(nodeId)?.index ?? null;
}

/* ---- v2: player state, composition slots, playback bind ------------------ */

/** Is this node a Video? (engine emits `"Video"`, everything else lowercases) */
export function isVideoNode(node: VirtualNode): boolean {
  return node.type.toLowerCase() === "video";
}

const VIDEO_SLOT_SET = new Set<string>(VIDEO_SLOTS);

/**
 * The composition slot a Video child is tagged with, or null when it carries
 * no (or an unknown) `.slot(name)`. `.slot("controls")` lowers to the
 * `slot.0` prop; the flat `slot` alias is accepted the same way the DOM
 * renderer accepts it.
 */
export function videoSlotName(node: VirtualNode): VideoSlotName | null {
  const raw = node.props["slot.0"] ?? node.props.slot;
  if (typeof raw !== "string") return null;
  return VIDEO_SLOT_SET.has(raw) ? (raw as VideoSlotName) : null;
}

/**
 * The player state a Video node is in. Nodes with no offscreen entry yet
 * (no src, or not painted once) are `idle` — the state the slot-visibility
 * table treats as "pre-playback".
 */
export function getVideoPlayerState(nodeId: string): VideoPlayerState {
  return videoCache.get(nodeId)?.state ?? "idle";
}

/** Does this Video node declare a child in the given slot? */
export function hasVideoSlot(node: VirtualNode, slot: VideoSlotName): boolean {
  for (const child of node.children) {
    if (videoSlotName(child) === slot) return true;
  }
  return false;
}

/**
 * Should this Video child be shown right now? Normative table lookup
 * (`VIDEO_SLOT_VISIBILITY[slot][state]`); untagged children of a Video are
 * invalid per the contract and are never shown.
 *
 * Hidden ≠ removed: the node stays in the tree with its state intact, it is
 * only skipped by paint, hit testing and the a11y mirror.
 */
export function isVideoSlotChildVisible(child: VirtualNode): boolean {
  const parent = child.parent;
  if (!parent || !isVideoNode(parent)) return true;
  const slot = videoSlotName(child);
  if (!slot) return false;
  return VIDEO_SLOT_VISIBILITY[slot][getVideoPlayerState(parent.id)];
}

/**
 * Normative slot paint order, bottom → top: the poster sits under the
 * spinner, controls sit above both, and the error surface tops everything.
 * Only co-visible pairs actually overlap (poster+loading in `loading`,
 * poster+controls in `idle`/`ended`), but the order is contract, not
 * declaration order — the spec's own example declares `controls` first and
 * `poster` last, which in declaration order would bury the play button.
 */
const VIDEO_SLOT_PAINT_ORDER: Record<VideoSlotName, number> = {
  poster: 1,
  loading: 2,
  controls: 3,
  error: 4,
};

/**
 * Currently-visible slot children of a Video, in PAINT order (bottom → top:
 * poster → loading → controls → error; declaration order within one slot).
 * Painting iterates this forward; hit testing iterates it in reverse.
 */
export function visibleVideoSlotChildren(node: VirtualNode): VirtualNode[] {
  const out: VirtualNode[] = [];
  for (const child of node.children) {
    if (isVideoSlotChildVisible(child)) out.push(child);
  }
  // Stable sort: same-slot siblings keep their declaration order.
  return out
    .map((child, i) => ({ child, i, order: VIDEO_SLOT_PAINT_ORDER[videoSlotName(child)!] }))
    .sort((a, b) => a.order - b.order || a.i - b.i)
    .map((e) => e.child);
}

/** Nearest enclosing Video node, or null (a Scrubber outside a player). */
export function findEnclosingVideoNode(node: VirtualNode | null): VirtualNode | null {
  let current: VirtualNode | null = node;
  while (current) {
    if (isVideoNode(current)) return current;
    current = current.parent;
  }
  return null;
}

/** Is the node inside a Video's slot subtree (used to keep built-in
 *  tap-to-toggle from firing under authored chrome)? */
export function isInsideVideoSlot(node: VirtualNode | null): boolean {
  let current: VirtualNode | null = node;
  while (current) {
    const parent: VirtualNode | null = current.parent;
    if (parent && isVideoNode(parent) && videoSlotName(current) !== null) return true;
    current = parent;
  }
  return false;
}

/** Numeric media-element field that may be absent/NaN on fake elements. */
function mediaNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Live playback snapshot in the shape `.bind(@state.playback)` keeps. */
function playbackSnapshot(entry: VideoEntry): PlaybackBinding {
  const v = entry.video as HTMLVideoElement & { currentTime?: number; duration?: number };
  return {
    // `playing` reports play INTENT, not the state name: it stays `true`
    // through a rebuffer (while `state` reports `loading`) so a play/pause
    // toggle bound to it doesn't flicker mid-stall (normative report
    // semantics). `entry.playing` is exactly that intent — set on
    // `play`/`playing`, cleared only by pause/ended/error.
    playing: entry.playing,
    position: Math.max(0, mediaNumber(v.currentTime)),
    duration: Math.max(0, mediaNumber(v.duration)),
    state: entry.state,
  };
}

/** Public snapshot (tests, Scrubber painting, a11y value text). */
export function getVideoPlayback(nodeId: string): PlaybackBinding | null {
  const entry = videoCache.get(nodeId);
  return entry ? playbackSnapshot(entry) : null;
}

/** One field write through the `.bind` channel the SDK auto-registers. */
function writePlaybackField(
  entry: VideoEntry,
  field: keyof PlaybackBinding,
  value: unknown,
): void {
  if (!videoActionDispatcher || !entry.bindPath) return;
  dispatchUIAction({ dispatchAction: videoActionDispatcher }, entry.node.id, "__hypen_bind", {
    path: `${entry.bindPath}.${field}`,
    value,
  });
}

/**
 * Renderer → state reports (docs: "Report semantics").
 *
 * `playing`/`state`/`duration` write immediately whenever they change;
 * `position` writes at most every {@link PLAYBACK_REPORT_INTERVAL_MS} while
 * playing, and immediately when `immediate` is set (play, pause, seek
 * completion, track change, ended, error).
 *
 * Every write is remembered in `lastReported` so the state mutation echoing
 * back as a `playback` prop is recognised as our own and never re-applied
 * (together with the 1 s seek epsilon this makes the loop converge).
 */
function reportPlayback(entry: VideoEntry, immediate: boolean): void {
  if (!entry.bindPath || !videoActionDispatcher) return;
  const snap = playbackSnapshot(entry);
  const last = entry.lastReported;

  if (!last || last.state !== snap.state) writePlaybackField(entry, "state", snap.state);
  if (!last || last.playing !== snap.playing) {
    writePlaybackField(entry, "playing", snap.playing);
    entry.playingReportLog.push({ v: snap.playing, t: Date.now() });
    if (entry.playingReportLog.length > 8) entry.playingReportLog.shift();
  }
  if (snap.duration > 0 && (!last || last.duration !== snap.duration)) {
    writePlaybackField(entry, "duration", snap.duration);
  }

  const now = Date.now();
  let position = last ? last.position : snap.position;
  const positionChanged = !last || last.position !== snap.position;
  if (
    positionChanged &&
    (immediate || now - entry.lastReportAt >= PLAYBACK_REPORT_INTERVAL_MS)
  ) {
    writePlaybackField(entry, "position", snap.position);
    entry.lastReportAt = now;
    position = snap.position;
  }

  entry.lastReported = {
    playing: snap.playing,
    state: snap.state,
    duration: snap.duration > 0 ? snap.duration : last?.duration ?? 0,
    position,
  };
}

/** Enter a new player state: report the transition immediately and repaint. */
function setVideoState(entry: VideoEntry, next: VideoPlayerState): void {
  if (entry.state === next) return;
  entry.state = next;
  reportPlayback(entry, /* immediate */ true);
  requestVideoRedraw(entry);
}

/** Is the element far enough along to accept a seek? */
function isVideoSeekable(entry: VideoEntry): boolean {
  const v = entry.video as HTMLVideoElement & { readyState?: number; duration?: number };
  if ((v.readyState ?? 0) >= 1) return true;
  const d = Number(v.duration);
  return Number.isFinite(d) && d > 0;
}

/** Seek, clamped to `[0, duration]` when the duration is known. */
function seekVideo(entry: VideoEntry, position: number): void {
  const v = entry.video as HTMLVideoElement & { duration?: number };
  const duration = Number(v.duration);
  let target = Math.max(0, position);
  if (Number.isFinite(duration) && duration > 0) target = Math.min(target, duration);
  try {
    v.currentTime = target;
  } catch { /* fake elements / unseekable sources */ }
  reportPlayback(entry, /* immediate */ true);
  requestVideoRedraw(entry);
}

/**
 * `startPosition` — the bind-less "resume where you left off" prop. Applied
 * exactly once per entry, the first time the source reports as seekable.
 */
function applyStartPosition(entry: VideoEntry): void {
  if (entry.startPositionApplied) return;
  const raw = Number(entry.node.props.startPosition);
  if (!Number.isFinite(raw) || raw <= 0) {
    entry.startPositionApplied = true;
    return;
  }
  if (!isVideoSeekable(entry)) return;
  entry.startPositionApplied = true;
  seekVideo(entry, raw);
}

/** Parse the `playback` prop, which may arrive as an object or JSON string. */
function parsePlaybackProp(raw: unknown): Partial<PlaybackBinding> | null {
  let value: unknown = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (value instanceof Map) value = Object.fromEntries(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Partial<PlaybackBinding>;
}

/**
 * State → renderer writes (docs: "Write semantics"). Runs on every paint,
 * so a reactive `playback` change reaches the element on the next frame.
 *
 * - `playing: true|false` plays/pauses; writing `true` while `ended`
 *   restarts from 0.
 * - `position: n` seeks only when it differs from the element's actual
 *   position by more than {@link PLAYBACK_SEEK_EPSILON_S} — the echo guard.
 * - `duration`/`state` writes are ignored.
 */
function syncPlaybackBinding(entry: VideoEntry, props: Record<string, any>): void {
  entry.bindPath = typeof props.bind === "string" && props.bind ? props.bind : null;

  const pb = parsePlaybackProp(props.playback);
  if (pb && typeof pb.playing === "boolean") {
    applyInboundPlaying(entry, pb.playing);
  }

  // One-way form (`playing: @{state.isPlaying}` as a plain prop): the
  // controlled subset of the bind — module drives, renderer follows,
  // renderer-initiated changes surface only via events. Shares the bind's
  // write semantics (`true` while `ended` restarts from 0).
  const oneWay = props.playing;
  if (oneWay !== undefined && oneWay !== null) {
    applyInboundPlaying(entry, truthyProp(oneWay));
  }

  if (!pb) return;

  const position = Number(pb.position);
  if (Number.isFinite(position) && position !== entry.lastInboundPosition) {
    entry.lastInboundPosition = position;
    const actual = mediaNumber((entry.video as any).currentTime);
    if (Math.abs(position - actual) > PLAYBACK_SEEK_EPSILON_S) {
      seekVideo(entry, position);
    }
  }
}

/** Consume one inbound `playing` write (bind struct field or one-way prop),
 * de-duplicated so the module's unchanged value is not re-applied every paint. */
function applyInboundPlaying(entry: VideoEntry, playing: boolean): void {
  if (playing === entry.lastInboundPlaying) return;
  entry.lastInboundPlaying = playing;
  // Echo-storm breaker: the engine echoes every report back as a
  // whole-struct prop, and reports ALTERNATE on real transitions — a
  // lagging echo stream is always an "edge" against the last inbound
  // value, so edge dedup alone cannot catch it, and one seed pause then
  // ping-pongs play/pause at round-trip rate. An ISOLATED write is always
  // a command (restart-after-ended legitimately matches recent reports);
  // only a rapid run of state-flipping inbound writes matching our own
  // recent reports is suppressed, killing a loop within ~3 cycles.
  const now = Date.now();
  entry.inboundFlipLog = entry.inboundFlipLog.filter((t) => now - t <= PLAYING_STORM_WINDOW_MS);
  const matchesRecentReport = entry.playingReportLog.some(
    (e) => e.v === playing && now - e.t <= PLAYING_ECHO_HORIZON_MS,
  );
  if (matchesRecentReport && entry.inboundFlipLog.length >= PLAYING_STORM_FLIPS) {
    return;
  }
  const elementPlaying = (entry.video as HTMLVideoElement).paused === false;
  if (playing !== elementPlaying) entry.inboundFlipLog.push(now);
  if (playing) {
    if (entry.state === "ended") {
      seekVideo(entry, 0);
      safePlayVideo(entry);
    } else if (!elementPlaying) {
      safePlayVideo(entry);
    }
  } else if (elementPlaying) {
    try {
      entry.video.pause?.();
    } catch { /* ignore */ }
  }
}

/** Inbound `playing` values matching a report this recent can be echoes of
 * our own transitions rather than module commands. */
const PLAYING_ECHO_HORIZON_MS = 2500;
/** Window and flip count for the echo-storm breaker. */
const PLAYING_STORM_WINDOW_MS = 2000;
const PLAYING_STORM_FLIPS = 3;

/** Boolean props may arrive as real booleans or "true"/"false" strings —
 * same parse the checkbox/switch painters use. */
function truthyProp(v: unknown): boolean {
  return v === true || v === "true" || (v !== undefined && v !== null && v !== false && v !== "false" && !!v);
}

/**
 * Resolve the node's play queue per the contract: a non-empty `playlist`
 * supersedes `src`/`0`/`source`; `startIndex` is clamped to a valid range.
 */
function resolveVideoTracks(props: Record<string, any>): {
  tracks: string[];
  startIndex: number;
} {
  let playlist: unknown = props.playlist;
  if (typeof playlist === "string") {
    try {
      playlist = JSON.parse(playlist);
    } catch {
      playlist = undefined;
    }
  }
  let tracks: string[] = [];
  if (Array.isArray(playlist) && playlist.length > 0) {
    tracks = playlist.map(String).filter((s) => s.length > 0);
  }
  if (tracks.length === 0) {
    const src = props.src ?? props[0] ?? props.source;
    if (typeof src === "string" && src) tracks = [src];
  }
  let startIndex = Number(props.startIndex);
  if (!Number.isFinite(startIndex)) startIndex = 0;
  startIndex = Math.min(Math.max(0, Math.floor(startIndex)), Math.max(0, tracks.length - 1));
  return { tracks, startIndex };
}

/** Normalise the `headers` prop (Map or object) to a string record. */
function resolveVideoHeaders(props: Record<string, any>): Record<string, string> | null {
  let raw: unknown = props.headers;
  if (raw instanceof Map) raw = Object.fromEntries(raw);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof k === "string" && v != null) out[k] = String(v);
  }
  return Object.keys(out).length > 0 ? out : null;
}

function requestVideoRedraw(entry: VideoEntry, layout = false): void {
  entry.canvas?.dispatchEvent(
    new CustomEvent("hypen:redraw", layout ? { detail: { layout: true } } : undefined),
  );
}

/**
 * Resolve one of the node's event action props (`onPlay`, `onEnded`, …) and
 * dispatch it to the engine with the given payload. Silent no-op when the
 * prop is absent or no dispatcher is bound.
 */
function dispatchVideoAction(
  entry: VideoEntry,
  propName: string,
  payload: Record<string, any>,
): void {
  if (!videoActionDispatcher) return;
  const resolved = resolveVideoEventAction(entry.node.props[propName]);
  if (!resolved) return;
  dispatchUIAction({ dispatchAction: videoActionDispatcher }, entry.node.id, resolved.actionName, {
    nodeId: entry.node.id,
    timestamp: Date.now(),
    ...resolved.payload,
    ...payload,
  });
}

/** Same resolution rules as `props.ts#resolveEventAction` (string `@actions.x`
 * or normalized applicator object) — inlined to keep paint.ts's import graph
 * unchanged. */
function resolveVideoEventAction(
  spec: unknown,
): { actionName: string; payload: Record<string, any> } | null {
  const strip = (s: string) =>
    s.replace(/^@?actions\./, "").replace(/^@/, "");
  if (typeof spec === "string") {
    if (!spec.startsWith("@")) return null;
    return { actionName: strip(spec), payload: {} };
  }
  if (spec && typeof spec === "object") {
    const obj = spec as Record<string, any>;
    const raw = obj["0"];
    if (typeof raw !== "string" || !raw.startsWith("@")) return null;
    const payload: Record<string, any> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === "0" || k === "animate") continue;
      payload[k] = v;
    }
    return { actionName: strip(raw), payload };
  }
  return null;
}

/** Attempt playback; on rejection retry muted (browser autoplay policy),
 * per the contract's "fall back to muted autoplay" rule. */
function safePlayVideo(entry: VideoEntry): void {
  entry.started = true;
  // Playback intent on a cold player is `loading` (the spinner slot shows
  // now, not once the first frame decodes); `paused`/`ended` wait for the
  // element's own `play`/`playing` event so we never report a frame that
  // isn't rolling.
  if (entry.state === "idle") setVideoState(entry, "loading");
  let p: unknown;
  try {
    p = entry.video.play?.();
  } catch {
    return;
  }
  if (p && typeof (p as Promise<void>).catch === "function") {
    (p as Promise<void>).catch(() => {
      if (entry.released) return;
      entry.mutedFallback = true;
      entry.video.muted = true;
      try {
        const p2 = entry.video.play?.();
        if (p2 && typeof (p2 as Promise<void>).catch === "function") {
          (p2 as Promise<void>).catch(() => {});
        }
      } catch {
        /* stay paused — tap can retry */
      }
    });
  }
}

/**
 * Load `tracks[index]` into the element. Without `headers` the URL is
 * assigned directly and streams natively; with `headers` the media is
 * fetched (headers attached) → Blob → object URL, since HTML media elements
 * cannot carry request headers. Fetch failures dispatch `onError` with the
 * HTTP status.
 */
function loadVideoTrack(entry: VideoEntry, index: number, playAfter: boolean): void {
  entry.index = index;
  entry.currentSrc = entry.tracks[index] ?? "";
  entry.error = false;
  // A source that is resolving with playback intent is `loading`; without
  // intent the player is still `idle` (preload hasn't begun for the viewer).
  setVideoState(entry, playAfter || entry.started ? "loading" : "idle");
  const token = ++entry.loadToken;
  if (entry.blobUrl) {
    try {
      URL.revokeObjectURL?.(entry.blobUrl);
    } catch { /* ignore */ }
    entry.blobUrl = null;
  }
  if (!entry.currentSrc) return;

  const assign = (url: string) => {
    entry.video.src = url;
    try {
      entry.video.load?.();
    } catch { /* ignore */ }
    if (playAfter) safePlayVideo(entry);
  };

  if (entry.headers && typeof fetch === "function") {
    fetch(entry.currentSrc, { headers: entry.headers })
      .then((res) => {
        if (entry.released || token !== entry.loadToken) return;
        if (!res.ok) {
          entry.error = true;
          dispatchVideoAction(entry, "onError", {
            type: "error",
            src: entry.currentSrc,
            index: entry.index,
            status: res.status,
            message: `HTTP ${res.status}`,
          });
          requestVideoRedraw(entry);
          return;
        }
        return res.blob().then((blob) => {
          if (entry.released || token !== entry.loadToken) {
            return;
          }
          const url = URL.createObjectURL(blob);
          entry.blobUrl = url;
          assign(url);
        });
      })
      .catch((err) => {
        if (entry.released || token !== entry.loadToken) return;
        entry.error = true;
        dispatchVideoAction(entry, "onError", {
          type: "error",
          src: entry.currentSrc,
          index: entry.index,
          message: String((err as Error)?.message ?? err),
        });
        requestVideoRedraw(entry);
      });
  } else {
    assign(entry.currentSrc);
  }
}

/** Queue advance: update index, announce `onTrackChange`, load + play. */
function advanceVideoTrack(entry: VideoEntry, index: number): void {
  entry.index = index;
  entry.currentSrc = entry.tracks[index] ?? "";
  // The `load()` below fires a `pause` the viewer never asked for.
  entry.advancing = true;
  // A new track re-arms the create-time seek only through a config change;
  // within one queue `startPosition` stays a once-per-entry seek.
  dispatchVideoAction(entry, "onTrackChange", {
    type: "trackchange",
    src: entry.currentSrc,
    index,
  });
  loadVideoTrack(entry, index, /* playAfter */ true);
}

function handleVideoEnded(entry: VideoEntry): void {
  entry.playing = false;
  setVideoState(entry, "ended");
  const lastIndex = entry.tracks.length - 1;
  const isLast = entry.index >= lastIndex;
  const completed = isLast && !entry.loop;
  dispatchVideoAction(entry, "onEnded", {
    type: "ended",
    src: entry.currentSrc,
    index: entry.index,
    completed,
  });
  if (!isLast) {
    advanceVideoTrack(entry, entry.index + 1);
  } else if (entry.loop && entry.tracks.length > 1) {
    // Single-source loop never reaches here (video.loop handles it natively).
    advanceVideoTrack(entry, 0);
  }
  requestVideoRedraw(entry);
}

/**
 * Media element error: media elements don't expose the HTTP status, so per
 * the contract issue a 1-byte ranged probe and report the probe's status.
 * Skipped for blob playback (the originating fetch already reported it) and
 * omitted when the probe itself fails (e.g. CORS).
 */
function handleVideoError(entry: VideoEntry): void {
  entry.error = true;
  entry.playing = false;
  entry.advancing = false;
  setVideoState(entry, "error");
  const mediaError = (entry.video as HTMLVideoElement & { error?: MediaError | null }).error;
  const base = {
    type: "error",
    src: entry.currentSrc,
    index: entry.index,
    code: mediaError?.code,
    message: mediaError?.message || "media playback error",
  };
  const canProbe =
    typeof fetch === "function" && !entry.blobUrl && /^https?:/i.test(entry.currentSrc);
  if (canProbe) {
    fetch(entry.currentSrc, {
      headers: { Range: "bytes=0-0", ...(entry.headers ?? {}) },
    })
      .then((res) => {
        if (entry.released) return;
        dispatchVideoAction(entry, "onError", { ...base, status: res.status });
      })
      .catch(() => {
        if (entry.released) return;
        dispatchVideoAction(entry, "onError", base);
      });
  } else {
    dispatchVideoAction(entry, "onError", base);
  }
  requestVideoRedraw(entry);
}

/* ---- Frame pump: repaint canvases only while a video is actually playing */

let videoFrameLoopActive = false;

function startVideoFrameLoop(): void {
  if (videoFrameLoopActive) return;
  if (typeof requestAnimationFrame === "undefined") return; // headless: no pump
  videoFrameLoopActive = true;
  const tick = () => {
    let anyPlaying = false;
    for (const entry of videoCache.values()) {
      if (entry.playing && entry.video.paused === false) {
        anyPlaying = true;
        // Progress reports ride the frame pump as well as `timeupdate`
        // (throttled to PLAYBACK_REPORT_INTERVAL_MS either way), so a
        // bound module sees position move at the documented rate even on
        // engines that fire `timeupdate` sparsely.
        reportPlayback(entry, /* immediate */ false);
        requestVideoRedraw(entry);
      }
    }
    if (anyPlaying) {
      requestAnimationFrame(tick);
    } else {
      videoFrameLoopActive = false;
    }
  };
  requestAnimationFrame(tick);
}

/** Sync per-paint flags whose live value the offscreen element must track. */
function syncVideoFlags(entry: VideoEntry, props: Record<string, any>): void {
  entry.loop = truthyProp(props.loop);
  // Native looping only for single-source playback; playlist wrap is
  // handled by the `ended` handler so `onTrackChange` still fires.
  entry.video.loop = entry.loop && entry.tracks.length <= 1;
  if (!entry.mutedFallback) {
    entry.video.muted = truthyProp(props.muted);
  }
}

/**
 * Get or lazily create the offscreen element for a Video node. A change to
 * the resolved track list or headers releases and rebuilds the entry.
 */
function ensureVideoEntry(
  node: VirtualNode,
  canvas: HTMLCanvasElement | null,
  tracks: string[],
  startIndex: number,
  props: Record<string, any>,
): VideoEntry | null {
  if (typeof document === "undefined") return null;

  const headers = resolveVideoHeaders(props);
  const configKey = JSON.stringify([tracks, headers]);

  let entry = videoCache.get(node.id);
  if (entry && entry.configKey !== configKey) {
    releaseVideo(node.id);
    entry = undefined;
  }
  if (entry) {
    entry.node = node;
    if (canvas) entry.canvas = canvas;
    syncVideoFlags(entry, props);
    syncPlaybackBinding(entry, props);
    applyStartPosition(entry);
    return entry;
  }

  const video = document.createElement("video") as HTMLVideoElement;
  entry = {
    video,
    canvas,
    node,
    tracks,
    index: startIndex,
    currentSrc: tracks[startIndex] ?? "",
    loop: truthyProp(props.loop),
    headers,
    started: false,
    playing: false,
    error: false,
    state: "idle",
    advancing: false,
    bindPath: typeof props.bind === "string" && props.bind ? props.bind : null,
    lastReported: null,
    lastReportAt: 0,
    lastInboundPlaying: null,
    playingReportLog: [],
    inboundFlipLog: [],
    lastInboundPosition: null,
    startPositionApplied: false,
    mutedFallback: false,
    blobUrl: null,
    loadToken: 0,
    released: false,
    listeners: [],
    configKey,
  };
  videoCache.set(node.id, entry);

  try {
    video.crossOrigin = "anonymous"; // don't taint the canvas
    (video as any).playsInline = true;
    video.setAttribute?.("playsinline", "");
    const preload = typeof props.preload === "string" ? props.preload : "metadata";
    video.preload = (preload === "none" || preload === "auto" ? preload : "metadata") as "" | "none" | "auto" | "metadata";
  } catch { /* fake elements in tests */ }
  syncVideoFlags(entry, props);

  const e = entry;
  const on = (type: string, fn: () => void) => {
    video.addEventListener?.(type, fn);
    e.listeners.push([type, fn]);
  };
  on("loadedmetadata", () => {
    const vw = (video as any).videoWidth ?? 0;
    const vh = (video as any).videoHeight ?? 0;
    if (vw > 0 && vh > 0) {
      videoNaturalAspect.set(e.currentSrc, vw / vh);
    }
    // Duration is now known — the bind's read-only field reports at once.
    reportPlayback(e, /* immediate */ true);
    applyStartPosition(e);
    // `layout: true` — the intrinsic aspect can resize the node's box.
    requestVideoRedraw(e, true);
  });
  on("durationchange", () => reportPlayback(e, /* immediate */ true));
  on("play", () => {
    e.playing = true;
    e.started = true;
    e.advancing = false;
    dispatchVideoAction(e, "onPlay", { type: "play", src: e.currentSrc, index: e.index });
    setVideoState(e, "playing");
    startVideoFrameLoop();
    requestVideoRedraw(e);
  });
  // Buffering resolved (also the resume edge after a rebuffer): back to
  // `playing` with no `onPlay` — the viewer never left playback.
  on("playing", () => {
    e.playing = true;
    e.started = true;
    e.advancing = false;
    setVideoState(e, "playing");
    startVideoFrameLoop();
    requestVideoRedraw(e);
  });
  // Rebuffer: re-enter `loading` WITHOUT emitting `onPause` (normative).
  on("waiting", () => {
    if (e.state === "error" || e.state === "ended") return;
    setVideoState(e, "loading");
  });
  on("stalled", () => {
    if (e.state !== "playing") return;
    setVideoState(e, "loading");
  });
  on("canplay", () => {
    e.advancing = false;
    applyStartPosition(e);
    if (e.state !== "loading") return;
    if (!e.started) setVideoState(e, "idle");
    else if ((video as HTMLVideoElement).paused !== false) setVideoState(e, "paused");
    // started && not paused: play() is in flight — the `playing` event
    // promotes the state so the frame we report is a real one.
  });
  on("pause", () => {
    // A track that just finished fires `pause` right after `ended` (and a
    // queue advance's `load()` fires one too). Neither is a viewer pause:
    // reporting them would emit a phantom `onPause` before every `onEnded`
    // and knock the state machine out of `ended`.
    if ((video as HTMLVideoElement & { ended?: boolean }).ended) return;
    if (e.state === "ended" || e.advancing) return;
    e.playing = false;
    dispatchVideoAction(e, "onPause", { type: "pause", src: e.currentSrc, index: e.index });
    setVideoState(e, "paused");
    reportPlayback(e, /* immediate */ true);
    requestVideoRedraw(e);
  });
  on("timeupdate", () => reportPlayback(e, /* immediate */ false));
  on("seeked", () => reportPlayback(e, /* immediate */ true));
  on("ended", () => handleVideoEnded(e));
  on("error", () => handleVideoError(e));

  // Load first, then consume the bind: a `playback.playing === true` at
  // first render must call play() on an element that already has a source.
  loadVideoTrack(entry, startIndex, /* playAfter */ truthyProp(props.autoplay));
  syncPlaybackBinding(entry, props);
  applyStartPosition(entry);
  return entry;
}

/**
 * Toggle play/pause on a Video node — the canvas controls common
 * denominator, wired to tap by the event manager. Returns true when a
 * video entry existed and was toggled.
 */
export function toggleVideoPlayback(nodeId: string): boolean {
  const entry = videoCache.get(nodeId);
  if (!entry) return false;
  if (entry.video.paused === false) {
    try {
      entry.video.pause?.();
    } catch { /* ignore */ }
    entry.playing = false;
  } else {
    // Same restart rule the `playing: true` bind write follows.
    if (entry.state === "ended") seekVideo(entry, 0);
    safePlayVideo(entry);
  }
  return true;
}

/** Pause every video inside a subtree (Router detach keeps nodes alive but
 * off-screen playback/audio must stop). */
export function pauseVideoSubtree(node: VirtualNode): void {
  const entry = videoCache.get(node.id);
  if (entry) {
    try {
      entry.video.pause?.();
    } catch { /* ignore */ }
    entry.playing = false;
  }
  for (const child of node.children) {
    pauseVideoSubtree(child);
  }
}

/**
 * Release the offscreen element behind a removed node: detach listeners,
 * pause, drop the source (src = "" + load() releases the decoder), and
 * revoke any blob object URL. Called from the renderer's remove path.
 */
export function releaseVideo(nodeId: string): void {
  const entry = videoCache.get(nodeId);
  if (!entry) return;
  // A scrub in flight over this player has nothing left to commit to.
  if (scrubberDrag?.videoNodeId === nodeId) scrubberDrag = null;
  entry.released = true;
  entry.loadToken++;
  for (const [type, fn] of entry.listeners) {
    entry.video.removeEventListener?.(type, fn);
  }
  entry.listeners = [];
  try {
    entry.video.pause?.();
  } catch { /* ignore */ }
  entry.video.src = "";
  try {
    entry.video.load?.();
  } catch { /* ignore */ }
  if (entry.blobUrl) {
    try {
      URL.revokeObjectURL?.(entry.blobUrl);
    } catch { /* ignore */ }
    entry.blobUrl = null;
  }
  entry.playing = false;
  videoCache.delete(nodeId);
}

/** Release every video entry and clear the intrinsic-size cache. */
export function clearVideoCache(): void {
  for (const id of [...videoCache.keys()]) {
    releaseVideo(id);
  }
  videoNaturalAspect.clear();
}

/**
 * Paint video node.
 *
 * Ready frame → drawImage with objectFit math (default `contain` per the
 * contract). Not ready → poster via the shared image pipeline, else a dark
 * placeholder. A centered play glyph overlays whenever playback is paused
 * (tap toggles); error state is quiet (poster/dark box, no spinner).
 *
 * v2 composition slots replace built-ins for the concern they cover: a
 * `controls` slot suppresses the play glyph (and the tap-to-toggle the
 * event manager wires), a `poster` slot suppresses the `poster` prop image,
 * an `error` slot suppresses the renderer-drawn error surface. Slot
 * subtrees themselves are painted by `paintNode` after this, so authored
 * chrome always lands on top of the frame.
 */
function paintVideo(ctx: CanvasRenderingContext2D, node: VirtualNode): void {
  const layout = node.layout!;
  const props = node.props;

  const x = layout.x;
  const y = layout.y;
  const width = layout.width;
  const height = layout.height;
  const radius = layout.border.radius;

  const clipped = radius > 0 && width > 0 && height > 0;
  if (clipped) {
    ctx.save();
    drawRoundedRect(ctx, x, y, width, height, radius);
    ctx.clip();
  }

  const { tracks, startIndex } = resolveVideoTracks(props);

  // No src and no playlist → empty placeholder box; no dispatch, no crash.
  if (tracks.length === 0) {
    ctx.fillStyle = "#e0e0e0";
    ctx.fillRect(x, y, width, height);
    if (clipped) ctx.restore();
    return;
  }

  const entry = ensureVideoEntry(node, ctx.canvas ?? null, tracks, startIndex, props);
  const video = entry?.video as (HTMLVideoElement & { readyState?: number }) | undefined;

  const controlsSlot = hasVideoSlot(node, "controls");
  const posterSlot = hasVideoSlot(node, "poster");
  const errorSlot = hasVideoSlot(node, "error");

  const frameReady =
    entry != null &&
    video != null &&
    !entry.error &&
    (video.readyState ?? 0) >= HAVE_CURRENT_DATA &&
    ((video as any).videoWidth ?? 0) > 0;

  // Poster wins until playback has started (DOM `<video poster>` parity).
  // A `poster` slot replaces the prop image entirely.
  const posterSrc =
    !posterSlot && typeof props.poster === "string" && props.poster ? props.poster : null;
  const usePoster = posterSrc !== null && !(entry?.started ?? false);

  if (frameReady && !usePoster) {
    drawVideoFrame(ctx, video!, props.objectFit, x, y, width, height);
    // Glyph only while paused — a playing video paints clean frames — and
    // never when the author supplied their own transport chrome.
    if (video!.paused !== false && !controlsSlot) {
      drawPlayGlyph(ctx, x, y, width, height);
    }
    if (clipped) ctx.restore();
    return;
  }

  // An `error` slot replaces the renderer-drawn error surface wholesale:
  // no dark box, no poster fallback, no glyph — the slot subtree paints it.
  if ((entry?.error ?? false) && errorSlot) {
    if (clipped) ctx.restore();
    return;
  }

  // Poster (through the shared image cache) or dark placeholder.
  let posterDrawn = false;
  if (posterSrc) {
    const img = ensureImageLoaded(posterSrc, ctx.canvas ?? null);
    if (img) {
      if (props.objectFit === "fill") {
        ctx.drawImage(img, x, y, width, height);
      } else {
        drawImageCover(ctx, img, x, y, width, height);
      }
      posterDrawn = true;
    }
  }
  if (!posterDrawn) {
    ctx.fillStyle = "#1c1c1e";
    ctx.fillRect(x, y, width, height);
  }

  // Quiet error state: no glyph, no spinner — the module's onError handler
  // decides what happens next.
  if (!(entry?.error ?? false) && !controlsSlot) {
    drawPlayGlyph(ctx, x, y, width, height);
  }

  if (clipped) ctx.restore();
}

/* ==========================================================================
 * Scrubber (built-in, slot-aware)
 *
 * A timeline widget for the `controls` slot. Inside a Video it wires itself
 * to the enclosing player RENDERER-SIDE: the thumb tracks `currentTime` at
 * frame rate (the video frame pump already repaints every frame, so this is
 * free), dragging previews locally with no dispatch, and only the release
 * commits — as a `position` write through the `.bind(@state.playback)`
 * struct (its own, else the enclosing Video's), or as an `onSeek` action
 * when bound-less. Outside a Video it paints an inert track.
 * ========================================================================== */

/** The one in-flight scrub, if any. Canvas has a single pointer. */
let scrubberDrag: {
  nodeId: string;
  videoNodeId: string;
  fraction: number;
} | null = null;

/** Is this node a Scrubber? */
export function isScrubberNode(node: VirtualNode): boolean {
  return node.type.toLowerCase() === "scrubber";
}

/** The Video entry a Scrubber drives, or null when it sits outside a player. */
function scrubberVideoEntry(node: VirtualNode): VideoEntry | null {
  const videoNode = findEnclosingVideoNode(node.parent);
  if (!videoNode) return null;
  return videoCache.get(videoNode.id) ?? null;
}

/** A live Scrubber is one inside a Video that has an offscreen element. */
export function isScrubberLive(node: VirtualNode): boolean {
  return isScrubberNode(node) && scrubberVideoEntry(node) !== null;
}

/** Fraction of the point along the scrubber's track, clamped to [0, 1]. */
export function scrubberFractionAt(node: VirtualNode, pointX: number): number {
  const layout = node.layout;
  if (!layout || layout.width <= 0) return 0;
  return Math.min(1, Math.max(0, (pointX - layout.x) / layout.width));
}

/** Painted fraction: the local drag preview while scrubbing, else live time. */
export function getScrubberFraction(node: VirtualNode): number {
  if (scrubberDrag && scrubberDrag.nodeId === node.id) return scrubberDrag.fraction;
  const entry = scrubberVideoEntry(node);
  if (!entry) return 0;
  const snap = playbackSnapshot(entry);
  if (snap.duration <= 0) return 0;
  return Math.min(1, Math.max(0, snap.position / snap.duration));
}

/** Is a scrub in flight on this node? */
export function isScrubberDragging(node: VirtualNode): boolean {
  return scrubberDrag?.nodeId === node.id;
}

/** Begin a local scrub. No dispatch — the preview is renderer-side only. */
export function beginScrubberDrag(node: VirtualNode, fraction: number): boolean {
  const entry = scrubberVideoEntry(node);
  if (!entry) return false;
  scrubberDrag = {
    nodeId: node.id,
    videoNodeId: entry.node.id,
    fraction: Math.min(1, Math.max(0, fraction)),
  };
  requestVideoRedraw(entry);
  return true;
}

/** Move the preview thumb. Still no dispatch. */
export function updateScrubberDrag(node: VirtualNode, fraction: number): boolean {
  if (scrubberDrag?.nodeId !== node.id) return false;
  scrubberDrag.fraction = Math.min(1, Math.max(0, fraction));
  const entry = scrubberVideoEntry(node);
  if (entry) requestVideoRedraw(entry);
  return true;
}

/** Drop a scrub without committing (pointer capture lost, node removed, …). */
export function cancelScrubberDrag(): void {
  scrubberDrag = null;
}

/**
 * Release: seek the player and announce the commit exactly once.
 *
 * The renderer owns the media element, so it applies the seek locally (that
 * is what keeps scrubbing responsive when the module lives across a network
 * hop); the outward notification is a `position` write through the bind
 * struct, or an `onSeek` action `{type:"seek", position}` when bound-less.
 * Returns the committed position, or null when there was nothing to commit.
 */
export function commitScrubberDrag(node: VirtualNode): number | null {
  if (scrubberDrag?.nodeId !== node.id) return null;
  const fraction = scrubberDrag.fraction;
  scrubberDrag = null;

  const entry = scrubberVideoEntry(node);
  if (!entry) return null;
  const duration = playbackSnapshot(entry).duration;
  if (duration <= 0) {
    requestVideoRedraw(entry);
    return null;
  }
  const position = fraction * duration;

  seekVideo(entry, position);

  // Bind precedence: the Scrubber's own `.bind(@state.playback)` first
  // (the spec's example binds the Scrubber, not the Video), else the
  // enclosing player's bind path.
  const ownBind = typeof node.props.bind === "string" && node.props.bind ? node.props.bind : null;
  const bindPath = ownBind ?? entry.bindPath;
  if (bindPath && videoActionDispatcher) {
    dispatchUIAction({ dispatchAction: videoActionDispatcher }, (ownBind ? node : entry.node).id, "__hypen_bind", {
      path: `${bindPath}.position`,
      value: position,
    });
  } else if (videoActionDispatcher) {
    const resolved = resolveVideoEventAction(node.props.onSeek);
    if (resolved) {
      dispatchUIAction({ dispatchAction: videoActionDispatcher }, node.id, resolved.actionName, {
        nodeId: node.id,
        timestamp: Date.now(),
        ...resolved.payload,
        type: "seek",
        position,
      });
    }
  }
  return position;
}

/** Buffered-ahead fraction, or 0 when the element can't report it. */
function scrubberBufferedFraction(entry: VideoEntry): number {
  const v = entry.video as HTMLVideoElement & { buffered?: TimeRanges };
  const duration = mediaNumber(v.duration);
  if (duration <= 0) return 0;
  try {
    const ranges = v.buffered;
    if (!ranges || ranges.length === 0) return 0;
    return Math.min(1, Math.max(0, ranges.end(ranges.length - 1) / duration));
  } catch {
    return 0;
  }
}

/**
 * Paint scrubber node: track, buffered fill, progress fill, thumb.
 * Defaults are player chrome (white on a translucent track) rather than the
 * Slider's form-control blue, since a Scrubber's home is over video.
 */
function paintScrubber(ctx: CanvasRenderingContext2D, node: VirtualNode): void {
  const layout = node.layout!;
  const props = node.props;

  const x = layout.x;
  const y = layout.y;
  const width = layout.width;
  const height = layout.height;
  if (width <= 0 || height <= 0) return;

  const trackHeight = cssLengthToPx(props.trackHeight) ?? 4;
  const trackY = y + (height - trackHeight) / 2;
  const radius = trackHeight / 2;

  // Track background (the whole widget for an inert Scrubber).
  ctx.fillStyle = props.trackColor || "rgba(255, 255, 255, 0.28)";
  drawRoundedRect(ctx, x, trackY, width, trackHeight, radius);
  ctx.fill();

  const entry = scrubberVideoEntry(node);
  if (!entry) return; // Outside a Video: inert track, no thumb.

  const buffered = scrubberBufferedFraction(entry);
  if (buffered > 0) {
    ctx.fillStyle = props.bufferedColor || "rgba(255, 255, 255, 0.5)";
    drawRoundedRect(ctx, x, trackY, width * buffered, trackHeight, radius);
    ctx.fill();
  }

  const fraction = getScrubberFraction(node);
  const fillColor = props.fillColor || ownTextColor(props) || "#ffffff";
  if (fraction > 0) {
    if (typeof fillColor === "string" && fillColor.includes("gradient")) {
      ctx.fillStyle = resolveCanvasPaint(ctx, fillColor, x, trackY, width * fraction, trackHeight);
    } else {
      ctx.fillStyle = fillColor;
    }
    drawRoundedRect(ctx, x, trackY, width * fraction, trackHeight, radius);
    ctx.fill();
  }

  // Thumb — grows while dragging so the grab reads as engaged.
  const baseThumb = cssLengthToPx(props.thumbSize) ?? 12;
  const thumbSize = isScrubberDragging(node) ? baseThumb * 1.25 : baseThumb;
  ctx.fillStyle = props.thumbColor || fillColor;
  ctx.beginPath();
  ctx.arc(x + width * fraction, y + height / 2, thumbSize / 2, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * Get a decoded image for `src` from the shared image cache, kicking off a
 * load (with the same fail-cooldown rules paintImage uses) when absent.
 * Used by paintVideo for posters. Returns null until decoded.
 */
function ensureImageLoaded(
  src: string,
  canvas: HTMLCanvasElement | null,
): HTMLImageElement | null {
  const cached = imageCache.get(src);
  if (cached && cached.complete && cached.naturalWidth > 0) return cached;

  const failEntry = imageFailCache.get(src);
  if (
    failEntry &&
    (failEntry.attempts >= IMAGE_MAX_ATTEMPTS ||
      Date.now() - failEntry.failedAt < IMAGE_FAIL_COOLDOWN_MS)
  ) {
    return null;
  }

  if (!imagePending.has(src) && typeof Image !== "undefined") {
    imagePending.add(src);
    const img = new Image();
    img.crossOrigin = "anonymous";
    imageInFlight.set(src, img);
    img.onload = () => {
      imageInFlight.delete(src);
      imageCache.set(src, img);
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        imageNaturalAspect.set(src, img.naturalWidth / img.naturalHeight);
        imageNaturalSize.set(src, { width: img.naturalWidth, height: img.naturalHeight });
      }
      imagePending.delete(src);
      imageFailCache.delete(src);
      evictMap(imageCache, MAX_IMAGE_CACHE_SIZE);
      canvas?.dispatchEvent(new CustomEvent("hypen:redraw"));
    };
    img.onerror = () => {
      imageInFlight.delete(src);
      imagePending.delete(src);
      purgeExpiredFailures();
      imageFailCache.set(src, {
        failedAt: Date.now(),
        attempts: (imageFailCache.get(src)?.attempts ?? 0) + 1,
      });
      evictMap(imageFailCache, MAX_FAIL_CACHE_SIZE);
    };
    img.src = src;
  }
  return null;
}

/**
 * Draw the current video frame with objectFit semantics. Default is
 * `contain` (contract): letterbox on black without distortion. `cover`
 * reuses the image cover math; `fill` stretches.
 */
function drawVideoFrame(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  objectFit: string | undefined,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
): void {
  const sw = (video as any).videoWidth ?? 0;
  const sh = (video as any).videoHeight ?? 0;
  if (sw <= 0 || sh <= 0 || objectFit === "fill") {
    ctx.drawImage(video, dx, dy, dw, dh);
    return;
  }
  if (objectFit === "cover") {
    const srcAspect = sw / sh;
    const dstAspect = dw / dh;
    let sx = 0,
      sy = 0,
      sWidth = sw,
      sHeight = sh;
    if (srcAspect > dstAspect) {
      sWidth = sh * dstAspect;
      sx = (sw - sWidth) / 2;
    } else if (srcAspect < dstAspect) {
      sHeight = sw / dstAspect;
      sy = (sh - sHeight) / 2;
    }
    ctx.drawImage(video, sx, sy, sWidth, sHeight, dx, dy, dw, dh);
    return;
  }
  // contain (default): scale to fit entirely, centered, letterboxed.
  ctx.fillStyle = "#000000";
  ctx.fillRect(dx, dy, dw, dh);
  const scale = Math.min(dw / sw, dh / sh);
  const fw = sw * scale;
  const fh = sh * scale;
  ctx.drawImage(video, dx + (dw - fw) / 2, dy + (dh - fh) / 2, fw, fh);
}

/** Centered scrim circle + white play triangle — the tap affordance. */
function drawPlayGlyph(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const cx = x + width / 2;
  const cy = y + height / 2;
  const r = Math.max(12, Math.min(32, Math.min(width, height) * 0.18));

  ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();

  const t = r * 0.55;
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.moveTo(cx - t * 0.6, cy - t);
  ctx.lineTo(cx - t * 0.6, cy + t);
  ctx.lineTo(cx + t, cy);
  ctx.closePath();
  ctx.fill();
}

/**
 * Draw rounded rectangle path.
 *
 * Clamps the radius to half the smallest side — Tailwind's `rounded-full`
 * lands on the engine as `border-radius: 9999px`, and without clamping the
 * arcs wrap outside the box and fill a giant area (a 20×20 badge with
 * radius 9999 paints as ~470×250 of background colour, swamping the row).
 */
function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): void {
  if (radius <= 0 || width <= 0 || height <= 0) {
    ctx.rect(x, y, width, height);
    return;
  }

  const r = Math.min(radius, width / 2, height / 2);

  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.arcTo(x + width, y, x + width, y + r, r);
  ctx.lineTo(x + width, y + height - r);
  ctx.arcTo(x + width, y + height, x + width - r, y + height, r);
  ctx.lineTo(x + r, y + height);
  ctx.arcTo(x, y + height, x, y + height - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

/**
 * Apply shadow to canvas context
 * Supports both simple and CSS-like shadow syntax:
 * - Simple: "2 2 4 rgba(0,0,0,0.3)"
 * - CSS-like: "2px 2px 4px rgba(0,0,0,0.3)"
 * - Named: {offsetX: 2, offsetY: 2, blur: 4, color: "rgba(0,0,0,0.3)"}
 */
function applyShadow(ctx: CanvasRenderingContext2D, shadow: any): void {
  if (typeof shadow === "string") {
    // Parse CSS-like shadow string: "offsetX offsetY blur color"
    const parts = shadow.trim().split(/\s+/);
    if (parts.length >= 3) {
      const offsetX = parseFloat(parts[0]);
      const offsetY = parseFloat(parts[1]);
      const blur = parseFloat(parts[2]);
      const color = parts.slice(3).join(" ") || "rgba(0,0,0,0.3)";

      ctx.shadowOffsetX = offsetX;
      ctx.shadowOffsetY = offsetY;
      ctx.shadowBlur = blur;
      ctx.shadowColor = color;
    }
  } else if (typeof shadow === "object") {
    // Object syntax
    ctx.shadowOffsetX = shadow.offsetX || 0;
    ctx.shadowOffsetY = shadow.offsetY || 0;
    ctx.shadowBlur = shadow.blur || 0;
    ctx.shadowColor = shadow.color || "rgba(0,0,0,0.3)";
  }
}

/**
 * Resolve DOM background applicator props into the CSS-like paint strings
 * Canvas understands. DOM applicators map `.linearGradient("...")` to
 * `background-image: linear-gradient(...)`; Canvas receives the original prop
 * and must do the same translation before painting.
 */
function resolveBackgroundPaint(props: Record<string, any>): string | undefined {
  if (props.linearGradient !== undefined) {
    return `linear-gradient(${props.linearGradient})`;
  }
  if (props.radialGradient !== undefined) {
    return `radial-gradient(${props.radialGradient})`;
  }
  if (props.conicGradient !== undefined) {
    return `conic-gradient(${props.conicGradient})`;
  }
  if (props.backgroundImage !== undefined) {
    return String(props.backgroundImage);
  }
  if (props.backgroundColor !== undefined) {
    return String(props.backgroundColor);
  }
  if (props.background !== undefined) {
    return String(props.background);
  }
  return undefined;
}

/**
 * Parsed gradients keyed by (source string, box geometry). CanvasGradient
 * objects are not bound to a specific context, so identical fills across
 * frames — the common case, since layout geometry is stable — skip the
 * regex parse and createLinearGradient/createRadialGradient entirely.
 */
const gradientCache = new Map<string, CanvasGradient | string>();
const MAX_GRADIENT_CACHE_SIZE = 256;

function resolveCanvasPaint(
  ctx: CanvasRenderingContext2D,
  paint: string,
  x: number,
  y: number,
  width: number,
  height: number,
): CanvasGradient | string {
  if (!paint.includes("gradient(")) return paint;
  const key = `${paint}|${x}|${y}|${width}|${height}`;
  let resolved = gradientCache.get(key);
  if (resolved === undefined) {
    resolved = parseGradient(ctx, paint, x, y, width, height);
    gradientCache.set(key, resolved);
    evictMap(gradientCache, MAX_GRADIENT_CACHE_SIZE);
  }
  return resolved;
}

/**
 * Parse gradient string and create canvas gradient
 * Supports:
 * - linear-gradient(direction, color1, color2, ...)
 * - radial-gradient(color1, color2, ...)
 */
function parseGradient(
  ctx: CanvasRenderingContext2D,
  gradientStr: string,
  x: number,
  y: number,
  width: number,
  height: number
): CanvasGradient | string {
  // Simple gradient parsing
  if (gradientStr.startsWith("linear-gradient")) {
    // Extract content between parentheses
    const match = gradientStr.match(/linear-gradient\((.*)\)/);
    if (!match) return gradientStr;

    const parts = splitCssArgs(match[1]);

    // Determine direction (default to bottom)
    let x0 = x, y0 = y, x1 = x, y1 = y + height;
    let colorStart = 0;

    if (parts[0].includes("deg") || parts[0].includes("to ")) {
      colorStart = 1;
      const direction = parts[0];

      const line = gradientLineForDirection(direction, x, y, width, height);
      if (line !== null) {
        x0 = line.x0;
        y0 = line.y0;
        x1 = line.x1;
        y1 = line.y1;
      }
    }

    const gradient = ctx.createLinearGradient(x0, y0, x1, y1);

    // Add color stops
    addColorStops(gradient, parts.slice(colorStart));

    return gradient;
  } else if (gradientStr.startsWith("radial-gradient")) {
    // Extract content between parentheses
    const match = gradientStr.match(/radial-gradient\((.*)\)/);
    if (!match) return gradientStr;

    const parts = splitCssArgs(match[1]);

    // Create radial gradient from center
    const centerX = x + width / 2;
    const centerY = y + height / 2;
    const radius = Math.max(width, height) / 2;

    const gradient = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, radius);

    // Add color stops
    addColorStops(gradient, parts);

    return gradient;
  } else if (gradientStr.startsWith("conic-gradient")) {
    const match = gradientStr.match(/conic-gradient\((.*)\)/);
    if (!match) return gradientStr;
    const createConicGradient = (ctx as CanvasRenderingContext2D & {
      createConicGradient?: (startAngle: number, x: number, y: number) => CanvasGradient;
    }).createConicGradient;
    if (!createConicGradient) return firstGradientColor(match[1]) ?? gradientStr;
    const centerX = x + width / 2;
    const centerY = y + height / 2;
    const gradient = createConicGradient.call(ctx, 0, centerX, centerY);
    addColorStops(gradient, splitCssArgs(match[1]));
    return gradient;
  }

  return gradientStr;
}

function splitCssArgs(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === "," && depth === 0) {
      const part = input.slice(start, i).trim();
      if (part) parts.push(part);
      start = i + 1;
    }
  }
  const tail = input.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

function gradientLineForDirection(
  direction: string,
  x: number,
  y: number,
  width: number,
  height: number,
): { x0: number; y0: number; x1: number; y1: number } | null {
  const trimmed = direction.trim().toLowerCase();
  const deg = trimmed.match(/^(-?(?:\d+|\d*\.\d+))deg$/);
  if (deg) return gradientLineForAngle(Number(deg[1]), x, y, width, height);
  if (!trimmed.startsWith("to ")) return null;

  const words = new Set(trimmed.slice(3).split(/\s+/).filter(Boolean));
  let vx = 0;
  let vy = 0;
  if (words.has("right")) vx = width;
  else if (words.has("left")) vx = -width;
  if (words.has("bottom")) vy = height;
  else if (words.has("top")) vy = -height;
  if (vx === 0 && vy === 0) return null;
  return gradientLineForVector(vx, vy, x, y, width, height);
}

function gradientLineForAngle(
  cssDegrees: number,
  x: number,
  y: number,
  width: number,
  height: number,
): { x0: number; y0: number; x1: number; y1: number } {
  const radians = (cssDegrees * Math.PI) / 180;
  return gradientLineForVector(
    Math.sin(radians),
    -Math.cos(radians),
    x,
    y,
    width,
    height,
  );
}

/** Convert a direction vector into the CSS line crossing the paint box. */
function gradientLineForVector(
  vx: number,
  vy: number,
  x: number,
  y: number,
  width: number,
  height: number,
): { x0: number; y0: number; x1: number; y1: number } {
  const magnitude = Math.hypot(vx, vy) || 1;
  const ux = vx / magnitude;
  const uy = vy / magnitude;
  const cx = x + width / 2;
  const cy = y + height / 2;
  // Project the rectangle onto the gradient direction. This is the CSS
  // "magic corners" extent: 0/100% land on the correct box edges rather
  // than outside them, which otherwise makes diagonal fills look solid.
  const half = (Math.abs(width * ux) + Math.abs(height * uy)) / 2;
  const dx = ux * half;
  const dy = uy * half;
  return {
    x0: cx - dx,
    y0: cy - dy,
    x1: cx + dx,
    y1: cy + dy,
  };
}

function parseColorStop(raw: string, fallbackStop: number): { color: string; stop: number } {
  const trimmed = raw.trim();
  const match = trimmed.match(/^(.*\S)\s+(-?(?:\d+|\d*\.\d+)%)$/);
  if (!match) return { color: trimmed, stop: fallbackStop };
  return {
    color: match[1].trim(),
    stop: Math.max(0, Math.min(1, parseFloat(match[2]) / 100)),
  };
}

function addColorStops(gradient: CanvasGradient, rawStops: string[]): void {
  const stops = rawStops.filter(Boolean);
  if (stops.length === 0) return;
  if (stops.length === 1) {
    const parsed = parseColorStop(stops[0], 0);
    gradient.addColorStop(0, parsed.color);
    gradient.addColorStop(1, parsed.color);
    return;
  }
  stops.forEach((raw, i) => {
    const fallback = i / (stops.length - 1);
    const { color, stop } = parseColorStop(raw, fallback);
    gradient.addColorStop(stop, color);
  });
}

function firstGradientColor(input: string): string | undefined {
  const first = splitCssArgs(input)[0];
  if (!first) return undefined;
  return parseColorStop(first, 0).color;
}

/**
 * Apply CSS-like transforms to canvas context
 * Supports:
 * - translate(x, y)
 * - rotate(angle)
 * - scale(x, y)
 * - skew(x, y)
 * - transform: "translate(10, 20) rotate(45) scale(1.5)"
 */
function applyTransforms(ctx: CanvasRenderingContext2D, node: VirtualNode): void {
  const props = node.props;
  const layout = node.layout!;

  // Get transform origin (default to center)
  const originX = parseFloat(props.transformOriginX) || 0.5;
  const originY = parseFloat(props.transformOriginY) || 0.5;

  const centerX = layout.x + layout.width * originX;
  const centerY = layout.y + layout.height * originY;

  // Check for individual transform properties
  const translateX = (parseFloat(props.translateX) || 0) + pinOffset(node).x;
  const translateY = (parseFloat(props.translateY) || 0) + pinOffset(node).y;
  const rotate = parseFloat(props.rotate) || 0; // in degrees
  const scaleX = parseFloat(props.scaleX) || parseFloat(props.scale) || 1;
  const scaleY = parseFloat(props.scaleY) || parseFloat(props.scale) || 1;
  const skewX = parseFloat(props.skewX) || parseFloat(props.skew) || 0; // in degrees
  const skewY = parseFloat(props.skewY) || 0; // in degrees

  // Apply transforms in order: translate to origin, scale, rotate, skew, translate back, translate by offset
  if (translateX !== 0 || translateY !== 0 || rotate !== 0 || scaleX !== 1 || scaleY !== 1 || skewX !== 0 || skewY !== 0) {
    // Move to transform origin
    ctx.translate(centerX, centerY);

    // Apply scale
    if (scaleX !== 1 || scaleY !== 1) {
      ctx.scale(scaleX, scaleY);
    }

    // Apply rotation (convert degrees to radians)
    if (rotate !== 0) {
      ctx.rotate((rotate * Math.PI) / 180);
    }

    // Apply skew using transform matrix
    if (skewX !== 0 || skewY !== 0) {
      const skewXRad = (skewX * Math.PI) / 180;
      const skewYRad = (skewY * Math.PI) / 180;
      ctx.transform(1, Math.tan(skewYRad), Math.tan(skewXRad), 1, 0, 0);
    }

    // Move back from origin and apply translation
    ctx.translate(-centerX + translateX, -centerY + translateY);
  }

  // Also support compound transform string (optional, for future extensibility)
  if (props.transform && typeof props.transform === "string") {
    parseTransformString(ctx, props.transform, centerX, centerY);
  }
}

/**
 * Parse and apply a CSS-like transform string
 */
function parseTransformString(
  ctx: CanvasRenderingContext2D,
  transformStr: string,
  originX: number,
  originY: number
): void {
  // Simple transform parsing - matches translate(), rotate(), scale()
  const transforms = transformStr.match(/(\w+)\(([^)]+)\)/g);
  if (!transforms) return;

  ctx.translate(originX, originY);

  for (const transform of transforms) {
    const match = transform.match(/(\w+)\(([^)]+)\)/);
    if (!match) continue;

    const [, func, args] = match;
    const values = args.split(",").map((v) => parseFloat(v.trim()));

    switch (func.toLowerCase()) {
      case "translate":
        ctx.translate(values[0] || 0, values[1] || 0);
        break;
      case "rotate":
        ctx.rotate((values[0] * Math.PI) / 180);
        break;
      case "scale":
        ctx.scale(values[0] || 1, values[1] || values[0] || 1);
        break;
    }
  }

  ctx.translate(-originX, -originY);
}

/**
 * Paint divider/separator node
 */
function paintDivider(ctx: CanvasRenderingContext2D, node: VirtualNode): void {
  const layout = node.layout!;
  const props = node.props;

  const orientation = props.orientation || "horizontal";
  const color = ownTextColor(props) || props.backgroundColor || "#e0e0e0";
  const thickness = cssLengthToPx(props.thickness) ?? 1;

  ctx.strokeStyle = color;
  ctx.lineWidth = thickness;
  ctx.beginPath();

  if (orientation === "vertical") {
    const x = layout.x + layout.width / 2;
    ctx.moveTo(x, layout.y);
    ctx.lineTo(x, layout.y + layout.height);
  } else {
    const y = layout.y + layout.height / 2;
    ctx.moveTo(layout.x, y);
    ctx.lineTo(layout.x + layout.width, y);
  }

  ctx.stroke();
}

/**
 * Paint checkbox node
 */
function paintCheckbox(ctx: CanvasRenderingContext2D, node: VirtualNode): void {
  const layout = node.layout!;
  const props = node.props;

  const size = Math.min(layout.width, layout.height);
  const x = layout.x;
  const y = layout.y;

  // Properly parse boolean values (handle string "false")
  const checkedValue = props.checked !== undefined ? props.checked : props.value;
  const checked = checkedValue === true || checkedValue === "true" || (checkedValue !== false && checkedValue !== "false" && !!checkedValue);

  const radius = cssLengthToPx(props.borderRadius) ?? 2;

  // Background
  const bgColor = checked ? (props.checkedColor || "#007bff") : (props.backgroundColor || "#ffffff");
  ctx.fillStyle = bgColor;
  drawRoundedRect(ctx, x, y, size, size, radius);
  ctx.fill();

  // Border
  const borderColor = checked ? (props.checkedColor || "#007bff") : (props.borderColor || "#cccccc");
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = node.focused ? 2 : 1;
  drawRoundedRect(ctx, x, y, size, size, radius);
  ctx.stroke();

  // Checkmark
  if (checked) {
    ctx.strokeStyle = props.checkColor || "#ffffff";
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    const padding = size * 0.25;
    ctx.beginPath();
    ctx.moveTo(x + padding, y + size / 2);
    ctx.lineTo(x + size * 0.4, y + size - padding);
    ctx.lineTo(x + size - padding, y + padding);
    ctx.stroke();
  }
}

/**
 * Paint radio button node
 */
function paintRadio(ctx: CanvasRenderingContext2D, node: VirtualNode): void {
  const layout = node.layout!;
  const props = node.props;

  const size = Math.min(layout.width, layout.height);
  const centerX = layout.x + size / 2;
  const centerY = layout.y + size / 2;
  const radius = size / 2;

  // Properly parse boolean values (handle string "false")
  // Only `checked`: a radio's `value` is its option id, not its state.
  const checkedValue = props.checked ?? props["checked.0"];
  const checked = checkedValue === true || checkedValue === "true" || (checkedValue !== false && checkedValue !== "false" && !!checkedValue);

  // Outer circle background
  const bgColor = props.backgroundColor || "#ffffff";
  ctx.fillStyle = bgColor;
  ctx.beginPath();
  ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
  ctx.fill();

  // Outer circle border
  const borderColor = checked ? (props.checkedColor || "#007bff") : (props.borderColor || "#cccccc");
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = node.focused ? 2 : 1;
  ctx.beginPath();
  ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
  ctx.stroke();

  // Inner filled circle when checked
  if (checked) {
    ctx.fillStyle = props.checkedColor || "#007bff";
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius * 0.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * Paint switch/toggle node
 */
function paintSwitch(ctx: CanvasRenderingContext2D, node: VirtualNode): void {
  const layout = node.layout!;
  const props = node.props;

  const width = layout.width;
  const height = layout.height;
  const x = layout.x;
  const y = layout.y;

  // Properly parse boolean values (handle string "false")
  const checkedValue = props.checked !== undefined ? props.checked : props.value;
  const checked = checkedValue === true || checkedValue === "true" || (checkedValue !== false && checkedValue !== "false" && !!checkedValue);

  const radius = height / 2;

  // Track background
  const trackColor = checked ? (props.checkedColor || "#4caf50") : (props.backgroundColor || "#cccccc");
  ctx.fillStyle = trackColor;
  drawRoundedRect(ctx, x, y, width, height, radius);
  ctx.fill();

  // Thumb (circle)
  const thumbRadius = radius * 0.8;
  const thumbX = checked ? (x + width - radius) : (x + radius);
  const thumbY = y + radius;

  ctx.fillStyle = props.thumbColor || "#ffffff";
  ctx.beginPath();
  ctx.arc(thumbX, thumbY, thumbRadius, 0, Math.PI * 2);
  ctx.fill();

  // Thumb shadow
  if (props.shadow !== false) {
    ctx.shadowColor = "rgba(0,0,0,0.2)";
    ctx.shadowBlur = 2;
    ctx.shadowOffsetY = 1;
    ctx.beginPath();
    ctx.arc(thumbX, thumbY, thumbRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
  }
}

/**
 * Paint slider node
 */
function paintSlider(ctx: CanvasRenderingContext2D, node: VirtualNode): void {
  const layout = node.layout!;
  const props = node.props;

  const width = layout.width;
  const height = layout.height;
  const x = layout.x;
  const y = layout.y;

  const min = parseFloat(props.min) || 0;
  const max = parseFloat(props.max) || 100;
  const value = parseFloat(props.value) || min;
  const percentage = (value - min) / (max - min);

  const trackHeight = cssLengthToPx(props.trackHeight) ?? 4;
  const thumbSize = cssLengthToPx(props.thumbSize) ?? 16;
  const trackY = y + (height - trackHeight) / 2;

  // Track background
  ctx.fillStyle = props.trackColor || "#e0e0e0";
  drawRoundedRect(ctx, x, trackY, width, trackHeight, trackHeight / 2);
  ctx.fill();

  // Track fill
  const fillWidth = width * percentage;
  const fillColor = props.fillColor || ownTextColor(props) || "#007bff";

  // Support gradient fills
  if (typeof fillColor === "string" && fillColor.includes("gradient")) {
    ctx.fillStyle = resolveCanvasPaint(ctx, fillColor, x, trackY, fillWidth, trackHeight);
  } else {
    ctx.fillStyle = fillColor;
  }

  drawRoundedRect(ctx, x, trackY, fillWidth, trackHeight, trackHeight / 2);
  ctx.fill();

  // Thumb
  const thumbX = x + fillWidth;
  const thumbY = y + height / 2;

  ctx.fillStyle = props.thumbColor || "#007bff";
  ctx.beginPath();
  ctx.arc(thumbX, thumbY, thumbSize / 2, 0, Math.PI * 2);
  ctx.fill();

  // Thumb border
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(thumbX, thumbY, thumbSize / 2, 0, Math.PI * 2);
  ctx.stroke();
}

/**
 * Paint progress bar node
 */
function paintProgress(ctx: CanvasRenderingContext2D, node: VirtualNode): void {
  const layout = node.layout!;
  const props = node.props;

  const width = layout.width;
  const height = layout.height;
  const x = layout.x;
  const y = layout.y;

  const min = parseFloat(props.min) || 0;
  const max = parseFloat(props.max) || 100;
  const value = parseFloat(props.value) || 0;
  const percentage = Math.min(Math.max((value - min) / (max - min), 0), 1);
  const radius = layout.border.radius || height / 2;

  // Background
  ctx.fillStyle = props.backgroundColor || "#e0e0e0";
  drawRoundedRect(ctx, x, y, width, height, radius);
  ctx.fill();

  // Progress fill
  if (percentage > 0) {
    const fillWidth = width * percentage;

    // Support gradient fills
    const fillColor = props.fillColor || ownTextColor(props) || "#007bff";
    if (typeof fillColor === "string" && fillColor.includes("gradient")) {
      ctx.fillStyle = resolveCanvasPaint(ctx, fillColor, x, y, fillWidth, height);
    } else {
      ctx.fillStyle = fillColor;
    }

    drawRoundedRect(ctx, x, y, fillWidth, height, radius);
    ctx.fill();
  }

  // Optional text label
  if (props.showLabel) {
    const label = props.label || `${Math.round(percentage * 100)}%`;
    ctx.fillStyle = props.labelColor || "#ffffff";
    ctx.font = `${props.fontSize || 12}px ${props.fontFamily || "sans-serif"}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, x + width / 2, y + height / 2);
  }
}

/**
 * Paint spinner/loading node
 */
function paintSpinner(ctx: CanvasRenderingContext2D, node: VirtualNode): void {
  const layout = node.layout!;
  const props = node.props;

  const size = Math.min(layout.width, layout.height);
  const centerX = layout.x + size / 2;
  const centerY = layout.y + size / 2;
  const radius = size / 2 - 4;
  const thickness = cssLengthToPx(props.thickness) ?? 4;
  const color = ownTextColor(props) || "#3b82f6";

  // Use timestamp for animation if available
  const animated = props.animated ?? props["animated.0"] ?? true;
  const rotation = animated === false ? -Math.PI / 2 : (Date.now() / 1000) * Math.PI;

  ctx.strokeStyle = color;
  ctx.lineWidth = thickness;
  ctx.lineCap = "round";

  // Draw circular arc
  ctx.beginPath();
  ctx.arc(centerX, centerY, radius, rotation, rotation + Math.PI * 1.5);
  ctx.stroke();

  // Fade out effect
  ctx.globalAlpha = 0.3;
  ctx.beginPath();
  ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/**
 * Paint card node
 */
function paintCard(ctx: CanvasRenderingContext2D, node: VirtualNode): void {
  const layout = node.layout!;
  const props = node.props;

  const x = layout.x;
  const y = layout.y;
  const width = layout.width;
  const height = layout.height;
  const radius = layout.border.radius || 8;

  // Default card shadow
  const shadow = props.shadow || props.boxShadow || "0 2 8 rgba(0,0,0,0.1)";
  applyShadow(ctx, shadow);

  // Background
  const backgroundColor = resolveBackgroundPaint(props) || "#ffffff";
  ctx.fillStyle = resolveCanvasPaint(ctx, backgroundColor, x, y, width, height);

  drawRoundedRect(ctx, x, y, width, height, radius);
  ctx.fill();

  // Reset shadow
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;

  // Border
  if (layout.border.width > 0) {
    ctx.strokeStyle = layout.border.color;
    ctx.lineWidth = layout.border.width;
    drawRoundedRect(ctx, x, y, width, height, radius);
    ctx.stroke();
  }

}

/**
 * Paint badge node
 */
function paintBadge(ctx: CanvasRenderingContext2D, node: VirtualNode): void {
  const layout = node.layout!;
  const props = node.props;

  const x = layout.x;
  const y = layout.y;
  const width = layout.width;
  const height = layout.height;
  const radius = layout.border.radius || 4;

  // Background
  const backgroundColor = props.backgroundColor || "#e0e0e0";
  ctx.fillStyle = backgroundColor;
  drawRoundedRect(ctx, x, y, width, height, radius);
  ctx.fill();

  // Text content
  const text = String(props[0] || props.text || "");
  if (text) {
    ctx.fillStyle = ownTextColor(props) || "#ffffff";
    ctx.font = `${props.fontWeight || "bold"} ${props.fontSize || 10}px ${props.fontFamily || "sans-serif"}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, x + width / 2, y + height / 2);
  }
}

/**
 * Paint avatar node
 */
function paintAvatar(ctx: CanvasRenderingContext2D, node: VirtualNode): void {
  const layout = node.layout!;
  const props = node.props;

  const size = Math.min(layout.width, layout.height);
  const centerX = layout.x + size / 2;
  const centerY = layout.y + size / 2;
  const radius = size / 2;

  // Clip to circle
  ctx.save();
  ctx.beginPath();
  ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
  ctx.clip();

  // Background
  const backgroundColor = props.backgroundColor || "#cccccc";
  ctx.fillStyle = backgroundColor;
  ctx.beginPath();
  ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
  ctx.fill();

  const src = props.src || props.image;
  if (typeof src === "string" && src.length > 0) {
    const image = ensureImageLoaded(src, ctx.canvas);
    if (image) {
      drawImageCover(ctx, image, layout.x, layout.y, size, size);
    }
  }

  // Text initials if provided
  const text = String(props[0] || props.text || props.initials || "");
  if (text) {
    ctx.fillStyle = ownTextColor(props) || "#ffffff";
    ctx.font = `${props.fontWeight || "bold"} ${props.fontSize || size / 2.5}px ${props.fontFamily || "sans-serif"}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, centerX, centerY);
  }

  ctx.restore();

  // Border
  if (layout.border.width > 0) {
    ctx.strokeStyle = layout.border.color;
    ctx.lineWidth = layout.border.width;
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
    ctx.stroke();
  }
}

const audioLoaded = new Set<string>();
const audioPending = new Set<string>();
const audioFailed = new Set<string>();

function ensureAudioLoaded(src: string, canvas: HTMLCanvasElement): void {
  if (audioLoaded.has(src) || audioPending.has(src) || audioFailed.has(src)) return;
  audioPending.add(src);
  fetch(src, { cache: "no-store" })
    .then(response => {
      if (!response.ok) throw new Error(`Audio request returned ${response.status}`);
      return response.arrayBuffer();
    })
    .then(() => {
      audioPending.delete(src);
      audioLoaded.add(src);
      canvas.dispatchEvent(new CustomEvent("hypen:redraw"));
    })
    .catch(() => {
      audioPending.delete(src);
      audioFailed.add(src);
      canvas.dispatchEvent(new CustomEvent("hypen:redraw"));
    });
}

/** Paint a deterministic Canvas-native audio control surface. */
function paintAudio(ctx: CanvasRenderingContext2D, node: VirtualNode): void {
  const { layout, props } = node;
  if (!layout) return;
  const src = props.src || props[0];
  if (typeof src === "string" && src.length > 0) ensureAudioLoaded(src, ctx.canvas);
  if (props.controls === false) return;

  // Audio changes textAlign/textBaseline while drawing its duration. Canvas
  // context state survives between nodes and even between frames, so leaking
  // `right` here makes later ordinary Text use its left coordinate as a right
  // anchor (the gallery headings were pushed off the left edge). Keep the
  // control surface completely paint-local.
  ctx.save();

  const { x, y, width, height } = layout;
  const middleY = y + height / 2;
  ctx.fillStyle = props.backgroundColor || "#f3f4f6";
  drawRoundedRect(ctx, x, y, width, height, Math.min(height / 2, 12));
  ctx.fill();

  const buttonRadius = Math.min(15, Math.max(9, height * 0.28));
  const buttonX = x + 12 + buttonRadius;
  ctx.fillStyle = ownTextColor(props) || "#374151";
  ctx.beginPath();
  ctx.arc(buttonX, middleY, buttonRadius, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.moveTo(buttonX - 3, middleY - 6);
  ctx.lineTo(buttonX + 6, middleY);
  ctx.lineTo(buttonX - 3, middleY + 6);
  ctx.closePath();
  ctx.fill();

  const timeWidth = 62;
  const trackX = buttonX + buttonRadius + 12;
  const trackWidth = Math.max(0, width - (trackX - x) - timeWidth - 12);
  ctx.fillStyle = "#d1d5db";
  drawRoundedRect(ctx, trackX, middleY - 2, trackWidth, 4, 2);
  ctx.fill();

  ctx.fillStyle = "#6b7280";
  ctx.font = "12px sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  const duration = typeof src === "string" && audioLoaded.has(src) ? "0:01" : "--:--";
  ctx.fillText(`0:00 / ${duration}`, x + width - 12, middleY);
  ctx.restore();
}

/**
 * Paint icon node using SVG path data from the engine's icon registry.
 * Falls back to simple shapes if no path data is provided.
 */
function paintIcon(ctx: CanvasRenderingContext2D, node: VirtualNode): void {
  const layout = node.layout!;
  const props = node.props;

  const size = Math.min(layout.width, layout.height);
  const x = layout.x;
  const y = layout.y;
  const color = ownTextColor(props) || "#000000";

  // Server-resolved SVG path data (from engine's ResourceRegistry)
  const iconPaths: Array<{
    d: string;
    fill?: string;
    stroke?: string;
    strokeWidth?: number;
  }> = props.__iconPaths;
  const viewBox: string = props.__iconViewBox || "0 0 24 24";

  if (iconPaths && Array.isArray(iconPaths) && iconPaths.length > 0) {
    // Parse viewBox to compute scale
    const vbParts = viewBox.split(" ").map(Number);
    const vbWidth = vbParts[2] || 24;
    const vbHeight = vbParts[3] || 24;
    const scale = size / Math.max(vbWidth, vbHeight);

    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scale, scale);

    for (const pathData of iconPaths) {
      const path2d = new Path2D(pathData.d);
      const fill = pathData.fill || "none";
      const stroke =
        (pathData.stroke || "currentColor") === "currentColor"
          ? color
          : pathData.stroke || color;

      if (fill && fill !== "none") {
        ctx.fillStyle = fill === "currentColor" ? color : fill;
        ctx.fill(path2d);
      }
      if (stroke && stroke !== "none") {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = (pathData.strokeWidth || 2) ;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.stroke(path2d);
      }
    }

    ctx.restore();
    return;
  }

  // Fallback: simple shapes for when no icon registry is available
  const iconName = props.icon || props.name || props["0"] || "circle";
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;

  switch (String(iconName).toLowerCase()) {
    case "circle":
      ctx.beginPath();
      ctx.arc(x + size / 2, y + size / 2, size / 3, 0, Math.PI * 2);
      ctx.fill();
      break;

    case "square": {
      const padding = size * 0.2;
      ctx.fillRect(x + padding, y + padding, size - padding * 2, size - padding * 2);
      break;
    }

    case "star":
      drawStar(ctx, x + size / 2, y + size / 2, 5, size / 3, size / 6);
      ctx.fill();
      break;

    case "check":
    case "checkmark": {
      const p = size * 0.2;
      ctx.beginPath();
      ctx.moveTo(x + p, y + size / 2);
      ctx.lineTo(x + size * 0.4, y + size - p);
      ctx.lineTo(x + size - p, y + p);
      ctx.stroke();
      break;
    }

    case "x":
    case "close": {
      const pd = size * 0.2;
      ctx.beginPath();
      ctx.moveTo(x + pd, y + pd);
      ctx.lineTo(x + size - pd, y + size - pd);
      ctx.moveTo(x + size - pd, y + pd);
      ctx.lineTo(x + pd, y + size - pd);
      ctx.stroke();
      break;
    }

    default:
      ctx.beginPath();
      ctx.arc(x + size / 2, y + size / 2, size / 3, 0, Math.PI * 2);
      ctx.fill();
  }
}

/**
 * Paint link node
 */
function paintLink(ctx: CanvasRenderingContext2D, node: VirtualNode): void {
  const layout = node.layout!;
  const props = node.props;

  const text = String(props[0] || props.text || "");
  const color = node.hovered ? (props.hoverColor || "#0056b3") : (ownTextColor(props) || "#007bff");
  const fontSize = cssLengthToPx(props.fontSize) ?? 16;
  const fontWeight = props.fontWeight || "normal";
  const fontFamily = props.fontFamily || "system-ui, sans-serif";
  const textDecoration = props.textDecoration !== undefined ? props.textDecoration : "underline";

  ctx.fillStyle = color;
  ctx.font = `${fontWeight} ${fontSize}px ${fontFamily}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";

  const x = layout.x + layout.contentX;
  const y = layout.y + layout.contentY;

  ctx.fillText(text, x, y);

  // Underline
  if (textDecoration === "underline") {
    const textWidth = ctx.measureText(text).width;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y + fontSize + 2);
    ctx.lineTo(x + textWidth, y + fontSize + 2);
    ctx.stroke();
  }
}

/**
 * Apply text decoration (underline, line-through, etc.)
 */
function applyTextDecoration(
  ctx: CanvasRenderingContext2D,
  decoration: string,
  color: string,
  x: number,
  y: number,
  width: number,
  fontSize: number
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, fontSize / 16);

  ctx.beginPath();

  if (decoration === "underline") {
    const underlineY = y + fontSize + 2;
    ctx.moveTo(x, underlineY);
    ctx.lineTo(x + width, underlineY);
  } else if (decoration === "line-through" || decoration === "strikethrough") {
    const lineThroughY = y + fontSize / 2;
    ctx.moveTo(x, lineThroughY);
    ctx.lineTo(x + width, lineThroughY);
  } else if (decoration === "overline") {
    ctx.moveTo(x, y);
    ctx.lineTo(x + width, y);
  }

  ctx.stroke();
}

/**
 * Apply overflow clipping
 */
function applyOverflowClip(ctx: CanvasRenderingContext2D, node: VirtualNode): void {
  const props = node.props;
  const overflow = props.overflow || "visible";

  if (overflow === "hidden" || overflow === "scroll" || overflow === "auto") {
    const layout = node.layout!;
    const x = layout.x;
    const y = layout.y;
    const width = layout.width;
    const height = layout.height;
    const radius = layout.border.radius;

    ctx.save();
    ctx.beginPath();

    if (radius > 0) {
      drawRoundedRect(ctx, x, y, width, height, radius);
    } else {
      ctx.rect(x, y, width, height);
    }

    ctx.clip();
  }
}

/**
 * Helper: Draw a star shape
 */
function drawStar(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  spikes: number,
  outerRadius: number,
  innerRadius: number
): void {
  let rot = (Math.PI / 2) * 3;
  let x = cx;
  let y = cy;
  const step = Math.PI / spikes;

  ctx.beginPath();
  ctx.moveTo(cx, cy - outerRadius);

  for (let i = 0; i < spikes; i++) {
    x = cx + Math.cos(rot) * outerRadius;
    y = cy + Math.sin(rot) * outerRadius;
    ctx.lineTo(x, y);
    rot += step;

    x = cx + Math.cos(rot) * innerRadius;
    y = cy + Math.sin(rot) * innerRadius;
    ctx.lineTo(x, y);
    rot += step;
  }

  ctx.lineTo(cx, cy - outerRadius);
  ctx.closePath();
}

/**
 * The node currently being painted by {@link paintDndGhost}. `paintNode`
 * skips `dndGhost` nodes in the ordinary tree walk unless it is this one.
 */
let ghostPassNode: VirtualNode | null = null;

/**
 * Drag-and-drop ghost pass: paint the lifted item ABOVE the whole tree, at
 * the position the in-tree pass would have given it (ancestor scroll
 * offsets and ancestor translations re-applied) plus its `dndOffset`,
 * which `paintNode` composes in itself. Called by the renderer after the
 * root paint so the ghost is never covered by a later sibling or by an
 * overlay — and it is not clipped by an `overflow: hidden` ancestor list,
 * so a card dragged out of one column into another stays visible. Ancestor
 * `scale`/`rotate` are not replicated (translation only).
 */
export function paintDndGhost(ctx: CanvasRenderingContext2D, node: VirtualNode): void {
  if (!node.visible || !node.layout || !node.dndGhost) return;
  let dx = 0;
  let dy = 0;
  for (let a = node.parent; a; a = a.parent) {
    const ss = a.scrollState;
    if (ss) {
      dx -= ss.scrollX;
      dy -= ss.scrollY;
    }
    dx += (parseFloat(a.props.translateX) || 0) + pinOffset(a).x + (a.dndOffset?.x ?? 0);
    dy += (parseFloat(a.props.translateY) || 0) + pinOffset(a).y + (a.dndOffset?.y ?? 0);
  }
  ctx.save();
  if (dx !== 0 || dy !== 0) ctx.translate(dx, dy);
  ghostPassNode = node;
  try {
    paintNode(ctx, node);
  } finally {
    ghostPassNode = null;
    ctx.restore();
  }
}

