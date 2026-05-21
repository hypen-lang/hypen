/**
 * Paint System
 *
 * Drawing virtual nodes to canvas
 */

import type { VirtualNode, PainterFunction } from "./types.js";
import { renderText } from "./text.js";
import { ScrollManager, isScrollable } from "./scroll.js";
import { getVisibleChildren, VIRTUALIZE_THRESHOLD } from "./virtualize.js";
import type { SelectionManager } from "./selection.js";
import { cssLengthToPx } from "./utils.js";

/**
 * Module-level reference to the active SelectionManager so paintText
 * can render selection highlights. Set once from the renderer.
 */
let activeSelectionManager: SelectionManager | null = null;
export function setSelectionManager(mgr: SelectionManager | null): void {
  activeSelectionManager = mgr;
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
 * Paint a virtual node and its children
 */
export function paintNode(ctx: CanvasRenderingContext2D, node: VirtualNode): void {
  if (!node.visible || !node.layout) return;

  ctx.save();

  // Apply transforms
  applyTransforms(ctx, node);

  // Apply opacity
  if (node.opacity < 1) {
    ctx.globalAlpha = node.opacity;
  }

  // Check for custom painter
  const customPainter = customPainters.get(node.type.toLowerCase());
  if (customPainter) {
    customPainter(ctx, node);
    ctx.restore();
    return;
  }

  // Default painting based on type
  switch (node.type.toLowerCase()) {
    case "column":
    case "row":
    case "stack":
      paintContainer(ctx, node);
      break;
    case "text":
      paintText(ctx, node);
      break;
    case "button":
      paintButton(ctx, node);
      break;
    case "input":
      paintInput(ctx, node);
      break;
    case "image":
      paintImage(ctx, node);
      break;
    case "spacer":
      // Spacer is invisible, just takes up space
      break;
    case "divider":
    case "separator":
      paintDivider(ctx, node);
      break;
    case "checkbox":
      paintCheckbox(ctx, node);
      break;
    case "radio":
      paintRadio(ctx, node);
      break;
    case "switch":
    case "toggle":
      paintSwitch(ctx, node);
      break;
    case "slider":
      paintSlider(ctx, node);
      break;
    case "progress":
    case "progressbar":
      paintProgress(ctx, node);
      break;
    case "spinner":
    case "loading":
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
    case "icon":
      paintIcon(ctx, node);
      break;
    case "link":
      paintLink(ctx, node);
      break;
    case "app":
    case "container":
    case "box":
      paintContainer(ctx, node);
      break;
    default:
      paintContainer(ctx, node);
  }

  ctx.restore();

  // Apply scroll translation for scrollable containers
  const ss = node.scrollState;
  if (ss && (ss.scrollX !== 0 || ss.scrollY !== 0)) {
    ctx.save();
    ctx.translate(-ss.scrollX, -ss.scrollY);
    (node as any)._scrollRestore = true;
  }

  // Paint children -- use windowed rendering for large scrollable lists
  const shouldVirtualize =
    isScrollable(node) &&
    node.children.length > VIRTUALIZE_THRESHOLD &&
    node.layout != null;

  const childrenToPaint = shouldVirtualize
    ? getVisibleChildren(node, {
        x: node.layout!.x,
        y: node.layout!.y,
        width: node.layout!.width,
        height: node.layout!.height,
      })
    : node.children;

  // Paint flow children first, then absolute-positioned overlays on top.
  // CSS uses `z-index` to order absolute siblings; Canvas just paints in
  // tree order, so a `position: absolute` header declared FIRST in the
  // tree (Story uses this for its close button) gets covered by the
  // following in-flow Image. Push absolute kids to the end so they land
  // on top — same effect as `z-index: auto` painting absolute after flow.
  const flowKids: VirtualNode[] = [];
  const overlayKids: VirtualNode[] = [];
  for (const child of childrenToPaint) {
    if (child.props.position === "absolute") overlayKids.push(child);
    else flowKids.push(child);
  }
  for (const child of flowKids) paintNode(ctx, child);
  for (const child of overlayKids) paintNode(ctx, child);

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
  const backgroundColor = props.backgroundColor || props.background;
  if (backgroundColor) {
    // Support for gradients
    if (typeof backgroundColor === "string" && backgroundColor.includes("gradient")) {
      ctx.fillStyle = parseGradient(ctx, backgroundColor, x, y, width, height);
    } else {
      ctx.fillStyle = backgroundColor;
    }

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
    if (radius > 0) {
      drawRoundedRect(ctx, x, y, width, height, radius);
      ctx.stroke();
    } else {
      ctx.strokeRect(x, y, width, height);
    }
  }

  // Apply overflow clipping for children
  const overflow = props.overflow || "visible";
  if (overflow === "hidden" || overflow === "scroll" || overflow === "auto") {
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
  const color = props.color || "#000000";
  const fontSize = cssLengthToPx(props.fontSize) ?? 16;
  const fontWeight = props.fontWeight || "normal";
  const fontFamily = props.fontFamily || "system-ui, sans-serif";
  const textAlign = props.textAlign || "left";
  const lineHeight = cssLengthToPx(props.lineHeight) ?? fontSize * 1.2;
  const textDecoration = props.textDecoration || "none";
  const textTransform = props.textTransform || "none";
  const letterSpacing = cssLengthToPx(props.letterSpacing) ?? 0;

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
    ctx.font = `${fontWeight} ${fontSize}px ${fontFamily}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";

    let currentX = x;
    for (let i = 0; i < text.length; i++) {
      ctx.fillText(text[i], currentX, y);
      currentX += ctx.measureText(text[i]).width;
      // Add letter spacing after each character except the last
      if (i < text.length - 1) {
        currentX += letterSpacing;
      }
    }

    // Text decoration with letter spacing (now correct width)
    if (textDecoration !== "none") {
      applyTextDecoration(ctx, textDecoration, color, x, y, currentX - x, fontSize);
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
        : undefined;

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

    // Text decoration (need to set font again for measurement)
    if (textDecoration !== "none") {
      ctx.font = `${fontWeight} ${fontSize}px ${fontFamily}`;
      const textWidth = ctx.measureText(text).width;
      applyTextDecoration(ctx, textDecoration, color, x, y, textWidth, fontSize);
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
  } else if (props.backgroundColor !== undefined) {
    backgroundColor = props.backgroundColor;
  }

  if (backgroundColor !== undefined) {
    if (typeof backgroundColor === "string" && backgroundColor.includes("gradient")) {
      ctx.fillStyle = parseGradient(ctx, backgroundColor, x, y, width, height);
    } else {
      ctx.fillStyle = backgroundColor;
    }
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

  // Paint children (typically Text)
  for (const child of node.children) {
    paintNode(ctx, child);
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

  // Input value text
  const value = props.value || "";
  const placeholder = props.placeholder || "";
  const text = value || placeholder;
  const textColor = value ? (props.color || "#000000") : "#999999";

  if (text) {
    const fontSize = cssLengthToPx(props.fontSize) ?? 16;
    const fontWeight = props.fontWeight || "normal";
    const fontFamily = props.fontFamily || "system-ui, sans-serif";
    const lineHeight = cssLengthToPx(props.lineHeight) ?? fontSize * 1.2;

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
        verticalAlign: "middle",
        lineHeight,
      }
    );
  }
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

/** Returns width/height of the cached image, or null if unknown. */
export function getImageNaturalAspect(src: string): number | null {
  return imageNaturalAspect.get(src) ?? null;
}

/** Test helper: seed the intrinsic-size cache without loading a real image. */
export function setImageNaturalSize(src: string, width: number, height: number): void {
  if (width > 0 && height > 0) {
    imageNaturalAspect.set(src, width / height);
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
      }
      imagePending.delete(src);
      imageFailCache.delete(src);
      evictMap(imageCache, MAX_IMAGE_CACHE_SIZE);
      // Request a repaint so the loaded image is drawn
      canvas.dispatchEvent(new CustomEvent("hypen:redraw"));
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

    const parts = match[1].split(",").map((s) => s.trim());

    // Determine direction (default to bottom)
    let x0 = x, y0 = y, x1 = x, y1 = y + height;
    let colorStart = 0;

    if (parts[0].includes("deg") || parts[0].includes("to ")) {
      colorStart = 1;
      const direction = parts[0];

      if (direction.includes("to right") || direction === "90deg") {
        x1 = x + width;
        y1 = y;
      } else if (direction.includes("to left") || direction === "270deg") {
        x0 = x + width;
        x1 = x;
        y0 = y;
        y1 = y;
      } else if (direction.includes("to top") || direction === "0deg") {
        y0 = y + height;
        y1 = y;
      }
      // Default is "to bottom" which we already set
    }

    const gradient = ctx.createLinearGradient(x0, y0, x1, y1);

    // Add color stops
    const colors = parts.slice(colorStart);
    colors.forEach((color, i) => {
      const stop = i / (colors.length - 1);
      gradient.addColorStop(stop, color.trim());
    });

    return gradient;
  } else if (gradientStr.startsWith("radial-gradient")) {
    // Extract content between parentheses
    const match = gradientStr.match(/radial-gradient\((.*)\)/);
    if (!match) return gradientStr;

    const parts = match[1].split(",").map((s) => s.trim());

    // Create radial gradient from center
    const centerX = x + width / 2;
    const centerY = y + height / 2;
    const radius = Math.max(width, height) / 2;

    const gradient = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, radius);

    // Add color stops
    parts.forEach((color, i) => {
      const stop = i / (parts.length - 1);
      gradient.addColorStop(stop, color.trim());
    });

    return gradient;
  }

  return gradientStr;
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
  const translateX = parseFloat(props.translateX) || 0;
  const translateY = parseFloat(props.translateY) || 0;
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
  const color = props.color || props.backgroundColor || "#e0e0e0";
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
  const checkedValue = props.checked !== undefined ? props.checked : props.value;
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
  const fillColor = props.fillColor || props.color || "#007bff";

  // Support gradient fills
  if (typeof fillColor === "string" && fillColor.includes("gradient")) {
    ctx.fillStyle = parseGradient(ctx, fillColor, x, trackY, fillWidth, trackHeight);
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
    const fillColor = props.fillColor || props.color || "#007bff";
    if (typeof fillColor === "string" && fillColor.includes("gradient")) {
      ctx.fillStyle = parseGradient(ctx, fillColor, x, y, fillWidth, height);
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
  const color = props.color || "#007bff";

  // Use timestamp for animation if available
  const rotation = (Date.now() / 1000) * Math.PI; // Rotate based on time

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
  const backgroundColor = props.backgroundColor || "#ffffff";
  if (typeof backgroundColor === "string" && backgroundColor.includes("gradient")) {
    ctx.fillStyle = parseGradient(ctx, backgroundColor, x, y, width, height);
  } else {
    ctx.fillStyle = backgroundColor;
  }

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

  // Paint children
  for (const child of node.children) {
    paintNode(ctx, child);
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
  const radius = layout.border.radius || height / 2;

  // Background
  const backgroundColor = props.backgroundColor || "#dc3545";
  ctx.fillStyle = backgroundColor;
  drawRoundedRect(ctx, x, y, width, height, radius);
  ctx.fill();

  // Text content
  const text = String(props[0] || props.text || "");
  if (text) {
    ctx.fillStyle = props.color || "#ffffff";
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

  // Text initials if provided
  const text = String(props[0] || props.text || props.initials || "");
  if (text) {
    ctx.fillStyle = props.color || "#ffffff";
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
  const color = props.color || props["color.0"] || "#000000";

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
  const color = node.hovered ? (props.hoverColor || "#0056b3") : (props.color || "#007bff");
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









