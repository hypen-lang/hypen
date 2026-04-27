/**
 * Layout Engine
 *
 * Uses Taffy (Rust/WASM) for spec-compliant CSS Flexbox, Grid, and Block
 * layout. Falls back to a basic flexbox implementation in environments
 * without WASM support (e.g. test runners).
 */

import type { VirtualNode, Layout, BoxSpacing } from "./types.js";
import {
  parseSpacing,
  parseSize,
  cssLengthToPx,
  cssLengthToDimension,
  setCurrentViewport,
  getCurrentViewport,
} from "./utils.js";
import { measureText } from "./text.js";
import { getImageNaturalAspect } from "./paint.js";

/**
 * Components whose size is intrinsic to the component itself (icon, avatar,
 * checkbox, etc.) should not be shrunk by their flex parent. Without this,
 * an icon inside a transparent button with no width collapses to 0×0 in
 * tight cross-axis containers.
 */
const INTRINSIC_SIZED = new Set([
  "icon",
  "avatar",
  "badge",
  "checkbox",
  "radio",
  "switch",
  "toggle",
  "spinner",
  "loading",
]);

// Taffy imports — loaded lazily to avoid hard failure when WASM unavailable
let taffy: typeof import("taffy-layout") | null = null;
let taffyReady = false;
let taffyInitPromise: Promise<void> | null = null;

/**
 * Initialise the Taffy WASM module. Safe to call multiple times; only the
 * first call actually loads WASM. Resolves immediately on subsequent calls.
 */
export async function initTaffyLayout(): Promise<boolean> {
  if (taffyReady) return true;
  if (taffyInitPromise) {
    await taffyInitPromise;
    return taffyReady;
  }
  taffyInitPromise = (async () => {
    try {
      taffy = await import("taffy-layout");
      // Bundlers (esp. Bun's browser bundler) sometimes inline a file:// URL
      // for import.meta.url inside taffy_wasm.js, which the browser blocks
      // ("Not allowed to load local resource"). The package's own `loadTaffy`
      // ignores args and falls through to that broken default, so call the
      // raw `__wbg_init` (default export of the `taffy-layout/wasm` subpath)
      // directly with an explicit Response.
      let usedExplicit = false;
      if (typeof window !== "undefined" && typeof fetch === "function") {
        const candidates = [
          new URL("/taffy_wasm_bg.wasm", window.location.origin),
          new URL("https://cdn.jsdelivr.net/npm/taffy-layout@2.0.3/pkg/taffy_wasm_bg.wasm"),
          new URL("https://unpkg.com/taffy-layout@2.0.3/pkg/taffy_wasm_bg.wasm"),
        ];
        const rawWasm = await import(
          /* @vite-ignore */ "taffy-layout/wasm" as string
        );
        const wbgInit = rawWasm.default as (input?: any) => Promise<unknown>;
        for (const url of candidates) {
          try {
            const res = await fetch(url);
            if (!res.ok) continue;
            await wbgInit({ module_or_path: res });
            usedExplicit = true;
            break;
          } catch {
            // Try next candidate
          }
        }
      }
      if (!usedExplicit) {
        await taffy.loadTaffy();
      }
      taffyReady = true;
    } catch {
      taffy = null;
      taffyReady = false;
    }
  })();
  await taffyInitPromise;
  return taffyReady;
}

// ---------------------------------------------------------------------------
// Helpers: map Hypen VirtualNode props → Taffy Style
// ---------------------------------------------------------------------------

/** Parse a Hypen prop value into a Taffy Dimension ("auto" | number | "N%") */
function toDimension(value: any): "auto" | number | `${number}%` {
  return cssLengthToDimension(value);
}

function toLengthPct(value: any): number | `${number}%` {
  const d = cssLengthToDimension(value);
  return d === "auto" ? 0 : d;
}

function toLengthPctAuto(value: any): "auto" | number | `${number}%` {
  return cssLengthToDimension(value);
}

/**
 * Parse an aspect-ratio prop. Accepts a number, `"W / H"`, or `"W"`.
 * Returns the width/height ratio, or null when unparseable.
 */
function parseAspectRatio(value: any): number | null {
  if (typeof value === "number") return value > 0 ? value : null;
  if (typeof value !== "string") return null;
  const s = value.trim();
  const slash = s.indexOf("/");
  if (slash !== -1) {
    const w = parseFloat(s.slice(0, slash));
    const h = parseFloat(s.slice(slash + 1));
    if (isFinite(w) && isFinite(h) && h !== 0) return w / h;
    return null;
  }
  const n = parseFloat(s);
  return isFinite(n) && n > 0 ? n : null;
}

/**
 * Read whether a node is a scrollable container, and on which axes. We can't
 * import from `scroll.ts` here without creating a circular dependency, so
 * inline the parsing — keep it in sync with `getScrollAxes`.
 */
function readScrollAxes(props: Record<string, any>): { x: boolean; y: boolean } {
  const overflow = props.overflow;
  if (overflow === "scroll" || overflow === "auto") return { x: true, y: true };
  const scrollable = props.scrollable;
  if (scrollable === true) return { x: true, y: true };
  if (scrollable === "horizontal") return { x: true, y: false };
  if (scrollable === "vertical") return { x: false, y: true };
  if (scrollable === "both") return { x: true, y: true };
  return { x: false, y: false };
}

/**
 * Build a Taffy Style from a VirtualNode's props. This centralises the
 * mapping between Hypen's declarative property names and CSS-level concepts.
 *
 * `parent` is the immediate parent VirtualNode (or null for the root) so
 * children of a Stack can place themselves in the single grid cell, and
 * children of a scrollable container can opt out of flex-shrink along the
 * scroll axis (otherwise a horizontal strip's items collapse to the
 * strip's width instead of overflowing).
 */
function buildTaffyStyle(
  node: VirtualNode,
  parent: VirtualNode | null = null,
): InstanceType<typeof import("taffy-layout").Style> {
  const T = taffy!;
  const props = node.props;
  const type = node.type.toLowerCase();
  const parentType = parent?.type.toLowerCase() ?? null;
  const parentScrollAxes = parent ? readScrollAxes(parent.props) : { x: false, y: false };

  const style = new T.Style();

  // --- Display / direction ---------------------------------------------------
  // Stack overlays children in a single grid cell — matches the DOM
  // renderer's `grid-template-areas: "stack"` strategy. Children get
  // `gridColumn: 1 / 2; gridRow: 1 / 2` further down.
  const isStack = type === "stack";
  // `List` is the DSL's vertical-stack iterator (see dom/components/list.ts
  // — `flex-direction: column` is its default). Match that here so feeds
  // like Notifications stack their rows vertically instead of flowing
  // sideways. The `direction` prop can still flip it to row.
  const isListColumn = type === "list" && props.direction !== "horizontal";
  const isColumn = !isStack && (type === "column" || isListColumn || props.flexDirection === "column");
  const isGrid = !isStack && (type === "grid" || props.display === "grid");

  if (isStack) {
    style.display = T.Display.Grid;
    // Auto tracks: the single cell sizes to fit the largest child instead
    // of `1fr` (which would inflate the Stack to its parent's full size and
    // stretch the children to match — see PARITY.md).
    style.gridTemplateColumns = [{ min: "auto", max: "auto" }];
    style.gridTemplateRows = [{ min: "auto", max: "auto" }];
    // Default top-left matches the DOM Stack (`justify-items: start;
    // align-items: start`) and iOS/Android ZStack defaults — also keeps
    // explicitly-sized children at their declared size instead of letting
    // Taffy's default `stretch` overwrite the box.
    style.justifyItems = props.horizontalAlignment
      ? mapAlign(T, props.horizontalAlignment)
      : T.AlignItems.Start;
    style.alignItems = props.verticalAlignment
      ? mapAlign(T, props.verticalAlignment)
      : T.AlignItems.Start;
  } else if (isGrid) {
    style.display = T.Display.Grid;

    // --- Grid template tracks ------------------------------------------------
    // The DSL's `.gridColumns(N)` / `.gridRows(N)` applicators land on
    // props with the applicator's own name (`gridColumns`, `gridRows`).
    // The DOM renderer also accepts the older shorthand `columns`/`rows`
    // and the spec-name `gridTemplateColumns`/`gridTemplateRows`. A bare
    // number N expands to N equal `1fr` tracks — same logic as
    // `dom/applicators/advanced-layout.ts`.
    const colsProp = props.gridTemplateColumns ?? props.gridColumns ?? props.columns;
    const rowsProp = props.gridTemplateRows ?? props.gridRows ?? props.rows;
    if (colsProp !== undefined) {
      style.gridTemplateColumns = parseGridTemplate(colsProp);
    }
    if (rowsProp !== undefined) {
      style.gridTemplateRows = parseGridTemplate(rowsProp);
    }

    // --- Grid auto flow ------------------------------------------------------
    if (props.gridAutoFlow) {
      style.gridAutoFlow = mapGridAutoFlow(T, props.gridAutoFlow);
    }

    // --- Grid auto tracks ----------------------------------------------------
    if (props.gridAutoColumns) {
      style.gridAutoColumns = parseTrackSizingList(props.gridAutoColumns);
    }
    if (props.gridAutoRows) {
      style.gridAutoRows = parseTrackSizingList(props.gridAutoRows);
    } else if (typeof props.__autoRowsPx === "number") {
      // Set by `annotateCollapsedAspectGrids` after a first layout pass —
      // pin implicit rows to the height we want each cell to be (column
      // width / aspectRatio), so `aspect-square` images don't overlap.
      const px = props.__autoRowsPx as number;
      style.gridAutoRows = [{ min: px, max: px }];
    }

    // --- Grid template areas -------------------------------------------------
    if (props.gridTemplateAreas) {
      style.gridTemplateAreas = parseGridTemplateAreas(props.gridTemplateAreas);
    }
  } else {
    style.display = T.Display.Flex;
  }

  if (!isStack) {
    style.flexDirection = isColumn ? T.FlexDirection.Column : T.FlexDirection.Row;
  }

  // --- Stack child placement -------------------------------------------------
  // Place every child of a Stack in the single 1×1 cell so they overlap.
  if (parentType === "stack") {
    style.gridColumn = { start: 1, end: 2 };
    style.gridRow = { start: 1, end: 2 };
  }

  // --- Grid child placement (applies regardless of parent display) ----------
  if (props.gridColumn) {
    style.gridColumn = parseGridLine(props.gridColumn);
  }
  if (props.gridRow) {
    style.gridRow = parseGridLine(props.gridRow);
  }
  if (props.gridColumnStart !== undefined) {
    style.gridColumnStart = parseGridPlacement(props.gridColumnStart);
  }
  if (props.gridColumnEnd !== undefined) {
    style.gridColumnEnd = parseGridPlacement(props.gridColumnEnd);
  }
  if (props.gridRowStart !== undefined) {
    style.gridRowStart = parseGridPlacement(props.gridRowStart);
  }
  if (props.gridRowEnd !== undefined) {
    style.gridRowEnd = parseGridPlacement(props.gridRowEnd);
  }

  // --- Flex properties -------------------------------------------------------
  // The `flex: <n>` shorthand (Tailwind's `flex-1` is `flex: 1 1 0%`) sets
  // grow + shrink + basis at once. Without honouring the basis here, an
  // overflowing flex item starts at its intrinsic content size (e.g. a
  // huge feed) and Taffy redistributes from there, which under-allocates
  // the BottomNav and pushes it off-screen on routes with tall content.
  const flexShorthand = props.flex !== undefined ? parseFloat(props.flex) : NaN;
  style.flexGrow = parseFloat(props.flexGrow) || (Number.isFinite(flexShorthand) ? flexShorthand : 0);
  // Default flex-shrink is 0 when:
  //   - the component has an intrinsic size (icon, avatar, …) — otherwise it
  //     collapses to 0×0 in a tight cross-axis container, e.g. an icon inside
  //     a transparent button with only `padding.0`.
  //   - the parent is a scrollable container along the main axis — otherwise
  //     a horizontal strip's items shrink to fit instead of overflowing,
  //     making the strip pointless.
  const parentIsRow = parentType !== "column" && parentType !== "stack" && parentType !== null;
  const parentIsCol = parentType === "column";
  const parentMainAxisScrolls =
    (parentIsRow && parentScrollAxes.x) || (parentIsCol && parentScrollAxes.y);
  const defaultShrink = INTRINSIC_SIZED.has(type) || parentMainAxisScrolls ? 0 : 1;
  style.flexShrink = props.flexShrink !== undefined ? parseFloat(props.flexShrink) : defaultShrink;
  if (props.flexBasis !== undefined) {
    style.flexBasis = toDimension(props.flexBasis);
  } else if (Number.isFinite(flexShorthand)) {
    // `flex: 1` shorthand → basis 0%. Pinning basis is the load-bearing
    // bit: an item with `flex: 1 1 auto` starts at its content size and
    // distributes from there, leaving siblings in a tight container with
    // negative space; `flex: 1 1 0%` starts at zero and grows up.
    style.flexBasis = 0;
  }

  if (props.flexWrap === "wrap") style.flexWrap = T.FlexWrap.Wrap;
  else if (props.flexWrap === "wrap-reverse") style.flexWrap = T.FlexWrap.WrapReverse;

  // --- Alignment (Hypen uses verticalAlignment / horizontalAlignment) --------
  // Stack handles its own alignment via justifyItems/alignItems above.
  if (!isStack) {
    const justifyRaw = isColumn
      ? (props.verticalAlignment || props.justifyContent)
      : (props.horizontalAlignment || props.justifyContent);
    const alignRaw = isColumn
      ? (props.horizontalAlignment || props.alignItems)
      : (props.verticalAlignment || props.alignItems);

    if (justifyRaw) style.justifyContent = mapJustify(T, justifyRaw);
    if (alignRaw) style.alignItems = mapAlign(T, alignRaw);
  }

  // --- Size ------------------------------------------------------------------
  const w = parseSize(props.width);
  const h = parseSize(props.height);

  // Component-type defaults
  if (type === "app" || type === "spacer") {
    style.size = {
      width: w !== null ? w : "100%",
      height: h !== null ? h : "100%",
    };
  } else if (type === "divider" || type === "separator") {
    const orientation = props.orientation || "horizontal";
    const thickness = cssLengthToPx(props.thickness) ?? 1;
    if (orientation === "vertical") {
      style.size = { width: w ?? thickness, height: h !== null ? h : "100%" };
    } else {
      style.size = { width: w !== null ? w : "100%", height: h ?? thickness };
    }
  } else if (type === "checkbox" || type === "radio") {
    const sz = cssLengthToPx(props.size) ?? 20;
    style.size = { width: w ?? sz, height: h ?? sz };
  } else if (type === "switch" || type === "toggle") {
    style.size = { width: w ?? 44, height: h ?? 24 };
  } else if (type === "slider") {
    style.size = { width: w ?? 200, height: h ?? 20 };
  } else if (type === "progress" || type === "progressbar") {
    style.size = { width: w ?? 200, height: h ?? 8 };
  } else if (type === "spinner" || type === "loading") {
    const sz = cssLengthToPx(props.size) ?? 24;
    style.size = { width: w ?? sz, height: h ?? sz };
  } else if (type === "badge") {
    style.size = { width: w ?? 20, height: h ?? 20 };
  } else if (type === "avatar") {
    const sz = cssLengthToPx(props.size) ?? 40;
    style.size = { width: w ?? sz, height: h ?? sz };
  } else if (type === "icon") {
    const sz = cssLengthToPx(props.size) ?? 24;
    style.size = { width: w ?? sz, height: h ?? sz };
  } else if (type === "input" || type === "textarea" || type === "select") {
    // Form controls have no painted children, so without an intrinsic
    // height they collapse to padding only (the social Search bar
    // rendered as a 4-tall pill instead of the ~36 the DOM produces).
    // Match the DOM box: outer = line-height(s) + padding + border.
    // Taffy defaults to `box-sizing: border-box`, so we add the
    // padding/border ourselves into `size.height`.
    const fontSize = cssLengthToPx(props.fontSize) ?? 16;
    const lineHeight = cssLengthToPx(props.lineHeight) ?? fontSize * 1.5;
    const minRows = type === "textarea" ? Math.max(1, Number(props.rows) || 3) : 1;
    const padTop = cssLengthToPx(props.paddingTop ?? props.padding) ?? 0;
    const padBottom = cssLengthToPx(props.paddingBottom ?? props.padding) ?? 0;
    const borderTop = cssLengthToPx(props.borderTopWidth ?? props.borderWidth) ?? 0;
    const borderBottom = cssLengthToPx(props.borderBottomWidth ?? props.borderWidth) ?? 0;
    const intrinsicH = lineHeight * minRows + padTop + padBottom + borderTop + borderBottom;
    style.size = { width: toDimension(props.width), height: h ?? intrinsicH };
  } else {
    // Children of a Grid that ask for `width: 100%` actually mean "fill
    // the cell" — that's the DOM behavior (`grid > * { justify-self:
    // stretch }`). Taffy handles this via the grid item's default
    // stretch alignment when the size is auto, but a literal 100% creates
    // a circular dependency with track sizing (the cell wants to be 1fr
    // of the grid, the item wants to be 100% of the cell, and Taffy
    // collapses both to the item's max-content). Strip the 100% on grid
    // children so the Taffy grid stretch wins. Same for height.
    const parentIsGridLayout =
      parent &&
      (parent.type.toLowerCase() === "grid" || parent.props.display === "grid");
    const widthIn = parentIsGridLayout && props.width === "100%" ? undefined : props.width;
    const heightIn = parentIsGridLayout && props.height === "100%" ? undefined : props.height;
    style.size = { width: toDimension(widthIn), height: toDimension(heightIn) };
  }

  // --- Min / Max constraints -------------------------------------------------
  // Default `min-width: 0` for children of a Grid container. CSS makes
  // grid items default to `min-width: auto` (= min-content) which prevents
  // them shrinking below their intrinsic min. For an Image with
  // `aspect-ratio: 1`, that "min" is the image's natural max-content —
  // so the grid track sizing collapses (one item ends up 360px wide and
  // squashes its row). Explicitly setting min: 0 is the standard CSS
  // workaround and matches the DOM grid's `justify-self: stretch` shape.
  const parentIsGrid =
    parent &&
    (parent.type.toLowerCase() === "grid" || parent.props.display === "grid");
  if (props.minWidth !== undefined || props.minHeight !== undefined) {
    style.minSize = {
      width: toDimension(props.minWidth),
      height: toDimension(props.minHeight),
    };
  } else if (parentIsGrid) {
    style.minSize = { width: 0, height: 0 };
  }
  if (props.maxWidth !== undefined || props.maxHeight !== undefined) {
    style.maxSize = {
      width: toDimension(props.maxWidth),
      height: toDimension(props.maxHeight),
    };
  }

  // --- Margin ----------------------------------------------------------------
  const m = parseSpacing(props.margin || 0);
  if (props.marginTop !== undefined) m.top = cssLengthToPx(props.marginTop) ?? 0;
  if (props.marginRight !== undefined) m.right = cssLengthToPx(props.marginRight) ?? 0;
  if (props.marginBottom !== undefined) m.bottom = cssLengthToPx(props.marginBottom) ?? 0;
  if (props.marginLeft !== undefined) m.left = cssLengthToPx(props.marginLeft) ?? 0;
  style.margin = { top: m.top, right: m.right, bottom: m.bottom, left: m.left };

  // --- Padding ---------------------------------------------------------------
  const p = parseSpacing(props.padding || 0);
  if (props.paddingTop !== undefined) p.top = cssLengthToPx(props.paddingTop) ?? 0;
  if (props.paddingRight !== undefined) p.right = cssLengthToPx(props.paddingRight) ?? 0;
  if (props.paddingBottom !== undefined) p.bottom = cssLengthToPx(props.paddingBottom) ?? 0;
  if (props.paddingLeft !== undefined) p.left = cssLengthToPx(props.paddingLeft) ?? 0;
  style.padding = { top: p.top, right: p.right, bottom: p.bottom, left: p.left };

  // --- Border ----------------------------------------------------------------
  const bw = cssLengthToPx(props.borderWidth) ?? 0;
  if (bw > 0) {
    style.border = { top: bw, right: bw, bottom: bw, left: bw };
  }

  // --- Gap -------------------------------------------------------------------
  const gap = cssLengthToPx(props.gap) ?? 0;
  if (gap > 0) {
    style.gap = { width: gap, height: gap };
  }

  // --- Aspect ratio ----------------------------------------------------------
  // Engine emits values like `"1"` or `16/9`. Taffy expects a number.
  if (props.aspectRatio !== undefined) {
    const ar = parseAspectRatio(props.aspectRatio);
    if (ar !== null) style.aspectRatio = ar;
  } else if (type === "image") {
    // Implicit aspect ratio from the decoded image's intrinsic size — only
    // useful when the caller fixes one dimension and lets the other follow.
    // Without this, an image with `width: 100` stretches to whatever Taffy
    // picks for the height (the parent's full height under the default
    // `align-items: stretch` of a flex row).
    //
    // We can't rely on Taffy's `aspectRatio` alone: with `align-items:
    // stretch`, the cross-axis size is forced before aspect-ratio is
    // applied. Pin both dimensions explicitly instead.
    const wParsed = parseSize(props.width);
    const hParsed = parseSize(props.height);
    if ((wParsed === null) !== (hParsed === null)) {
      const src = props.src ?? props[0];
      if (typeof src === "string") {
        const intrinsic = getImageNaturalAspect(src);
        if (intrinsic !== null) {
          if (wParsed !== null) {
            style.size = { width: wParsed, height: wParsed / intrinsic };
            style.aspectRatio = intrinsic;
          } else if (hParsed !== null) {
            style.size = { width: hParsed * intrinsic, height: hParsed };
            style.aspectRatio = intrinsic;
          }
        }
      }
    }
  }

  // --- Position (absolute) ---------------------------------------------------
  if (props.position === "absolute") {
    style.position = T.Position.Absolute;
    if (props.top !== undefined) style.top = toLengthPctAuto(props.top);
    if (props.left !== undefined) style.left = toLengthPctAuto(props.left);
    if (props.right !== undefined) style.right = toLengthPctAuto(props.right);
    if (props.bottom !== undefined) style.bottom = toLengthPctAuto(props.bottom);
  }

  // --- Overflow (scrollable containers) -------------------------------------
  // For scroll containers we need a careful balance:
  //   - Children must lay out at their full intrinsic positions so
  //     `ScrollManager.updateScrollBounds` can compute scrollHeight (a feed
  //     with overflow:Hidden gets its children clamped and the page won't
  //     scroll).
  //   - But the CONTAINER itself must not bubble its overflowing min-content
  //     up into its parent (a horizontally-scrollable Stories row with 5+
  //     w-24 items inflated the whole feed to 607px on a 470px canvas).
  //
  // Setting overflow to `Scroll` on the relevant axis tells Taffy to treat
  // this container as a scroll port — children flow at intrinsic sizes but
  // the container's own contribution to the parent stays bounded. The
  // non-scroll axis stays Visible so siblings still see the right content
  // size when they need to.
  const ownAxes = readScrollAxes(props);
  if (ownAxes.x || ownAxes.y) {
    style.overflow = {
      x: ownAxes.x ? T.Overflow.Scroll : T.Overflow.Visible,
      y: ownAxes.y ? T.Overflow.Scroll : T.Overflow.Visible,
    };
  }

  return style;
}

function mapJustify(T: typeof import("taffy-layout"), value: string) {
  switch (value) {
    case "center": return T.JustifyContent.Center;
    case "flex-end": case "end": return T.JustifyContent.End;
    case "space-between": return T.JustifyContent.SpaceBetween;
    case "space-around": return T.JustifyContent.SpaceAround;
    case "space-evenly": return T.JustifyContent.SpaceEvenly;
    default: return T.JustifyContent.Start;
  }
}

function mapAlign(T: typeof import("taffy-layout"), value: string) {
  switch (value) {
    case "center": return T.AlignItems.Center;
    case "flex-end": case "end": return T.AlignItems.End;
    case "stretch": return T.AlignItems.Stretch;
    case "baseline": return T.AlignItems.Baseline;
    default: return T.AlignItems.Start;
  }
}

// ---------------------------------------------------------------------------
// Grid helpers: parse Hypen prop values → Taffy grid types
// ---------------------------------------------------------------------------

/**
 * Parse a single track sizing value like "100", "auto", "1fr", "50%",
 * "min-content", "max-content" into a TrackSizingFunction.
 */
function parseTrackSizing(value: string | number): { min: any; max: any } {
  if (typeof value === "number") {
    return { min: value, max: value };
  }

  const s = String(value).trim();
  if (s === "auto") return { min: "auto", max: "auto" };
  if (s === "min-content") return { min: "min-content", max: "min-content" };
  if (s === "max-content") return { min: "max-content", max: "max-content" };

  // Fractional units e.g. "1fr", "2.5fr"
  if (s.endsWith("fr")) {
    return { min: "auto", max: s as `${number}fr` };
  }

  // Percentage e.g. "50%"
  if (s.endsWith("%")) {
    return { min: s as `${number}%`, max: s as `${number}%` };
  }

  // Plain number in a string
  const n = parseFloat(s);
  if (!isNaN(n)) {
    return { min: n, max: n };
  }

  return { min: "auto", max: "auto" };
}

/**
 * Parse a grid-template-columns / grid-template-rows value.
 * Accepts:
 *   - An array of values: [100, "1fr", "auto"]
 *   - A space-separated string: "100 1fr auto"
 *   - A single value: "1fr"
 */
function parseGridTemplate(value: any): any[] {
  if (Array.isArray(value)) {
    return value.map(parseTrackSizing);
  }
  if (typeof value === "string") {
    // The DSL's `.gridColumns(3)` sometimes arrives here as `"3"` after
    // stringification (engine emits numeric applicator args as strings).
    // Treat a bare integer string the same way the DOM renderer does —
    // expand to N equal 1fr tracks. `repeat(N, 1fr)` shorthand would work
    // too but Taffy wants the expanded track list.
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) {
      const n = parseInt(trimmed, 10);
      return Array.from({ length: n }, () => ({
        min: "auto",
        max: "1fr" as `${number}fr`,
      }));
    }
    return value.split(/\s+/).filter(Boolean).map(parseTrackSizing);
  }
  if (typeof value === "number") {
    // Bare number = column count. DOM: `repeat(N, 1fr)`.
    return Array.from({ length: value }, () => ({
      min: "auto",
      max: "1fr" as `${number}fr`,
    }));
  }
  return [];
}

/**
 * Parse grid-auto-columns / grid-auto-rows (TrackSizingFunction[]).
 * Same format as template tracks but semantically for implicit tracks.
 */
function parseTrackSizingList(value: any): any[] {
  return parseGridTemplate(value);
}

/** Map a gridAutoFlow string to Taffy's GridAutoFlow enum. */
function mapGridAutoFlow(T: typeof import("taffy-layout"), value: string) {
  switch (value) {
    case "column": return T.GridAutoFlow.Column;
    case "row-dense": case "dense": return T.GridAutoFlow.RowDense;
    case "column-dense": return T.GridAutoFlow.ColumnDense;
    default: return T.GridAutoFlow.Row;
  }
}

/**
 * Parse a single GridPlacement value.
 * Accepts: "auto", a number (line index), or { span: N }.
 */
function parseGridPlacement(value: any): any {
  if (value === "auto" || value === undefined || value === null) return "auto";
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "auto") return "auto";
    // "span N"
    const spanMatch = trimmed.match(/^span\s+(\d+)$/);
    if (spanMatch) return { span: parseInt(spanMatch[1], 10) };
    const n = parseInt(trimmed, 10);
    if (!isNaN(n)) return n;
    return "auto";
  }
  // Already an object like { span: 2 } or { line: 1, ident: "foo" }
  if (typeof value === "object") return value;
  return "auto";
}

/**
 * Parse a grid-column / grid-row shorthand into a Line<GridPlacement>.
 * Accepts:
 *   - An object { start, end }
 *   - A string "1 / 3" or "1 / span 2"
 */
function parseGridLine(value: any): { start: any; end: any } {
  if (typeof value === "object" && value !== null && "start" in value) {
    return {
      start: parseGridPlacement(value.start),
      end: parseGridPlacement(value.end),
    };
  }
  if (typeof value === "string") {
    const parts = value.split("/").map((s: string) => s.trim());
    return {
      start: parseGridPlacement(parts[0]),
      end: parts.length > 1 ? parseGridPlacement(parts[1]) : "auto",
    };
  }
  return { start: "auto", end: "auto" };
}

/**
 * Parse grid-template-areas.
 * Accepts an array of strings like ["header header", "sidebar main", "footer footer"].
 * Each string is a row; each word is a cell name (or "." for empty).
 * Returns an array of GridTemplateArea objects.
 */
function parseGridTemplateAreas(value: any): any[] {
  if (!Array.isArray(value)) return [];

  const rows: string[][] = value.map((row: string) =>
    String(row).split(/\s+/).filter(Boolean)
  );

  if (rows.length === 0) return [];

  // Collect unique area names (skip "." which means empty)
  const areaNames = new Set<string>();
  for (const row of rows) {
    for (const cell of row) {
      if (cell !== ".") areaNames.add(cell);
    }
  }

  // For each area name, find its bounding rectangle
  const areas: any[] = [];
  for (const name of areaNames) {
    let rowStart = Infinity, rowEnd = -1, colStart = Infinity, colEnd = -1;
    for (let r = 0; r < rows.length; r++) {
      for (let c = 0; c < rows[r].length; c++) {
        if (rows[r][c] === name) {
          rowStart = Math.min(rowStart, r + 1);
          rowEnd = Math.max(rowEnd, r + 2); // end line is exclusive
          colStart = Math.min(colStart, c + 1);
          colEnd = Math.max(colEnd, c + 2);
        }
      }
    }
    if (rowEnd > 0) {
      areas.push({ name, rowStart, rowEnd, columnStart: colStart, columnEnd: colEnd });
    }
  }

  return areas;
}

// ---------------------------------------------------------------------------
// Taffy-based layout
// ---------------------------------------------------------------------------

interface TextMeasureContext {
  text: string;
  fontSize: number;
  fontWeight: string | number;
  fontFamily: string;
  lineHeight: number;
  paddingH: number;
  paddingV: number;
  maxLines?: number;
  textOverflow?: "ellipsis" | "clip";
}

/**
 * Marker context for image leaves whose height should follow the column-
 * stretched width via aspect-ratio. Without this, Taffy's grid auto-row
 * sizing only sees the image's max-content (= 0 for a leaf with no fixed
 * height) and a `gridColumns(3)` of `aspect-square` images collapses to
 * gap-tall rows that overlap by 150px each (the Search explore grid).
 */
interface ImageAspectMeasureContext {
  aspectRatio: number;
}

/**
 * Build a TaffyTree mirroring the VirtualNode tree. Returns the root Taffy
 * node id and a mapping from Taffy node ids → VirtualNodes.
 */
function buildTree(
  tree: InstanceType<typeof import("taffy-layout").TaffyTree>,
  node: VirtualNode,
  parent: VirtualNode | null = null,
): bigint {
  const T = taffy!;
  const props = node.props;
  const style = buildTaffyStyle(node, parent);

  // Text leaf nodes — create with measurement context. The engine emits the
  // type capitalised (`"Text"`); compare case-insensitively so a Taffy leaf
  // is created. Without this, every Text node was treated as an empty
  // container with size 0×0, and downstream siblings were placed on top of
  // each other ("1,431 likes" overlapping the caption row was the visible
  // symptom).
  if (node.type.toLowerCase() === "text" && props[0] && node.children.length === 0) {
    const text = String(props[0] || "");
    const fontSize = cssLengthToPx(props.fontSize) ?? 16;
    const fontWeight = props.fontWeight || "normal";
    const fontFamily = props.fontFamily || "system-ui, sans-serif";
    const lineHeight = cssLengthToPx(props.lineHeight) ?? fontSize * 1.2;

    const p = parseSpacing(props.padding || 0);
    if (props.paddingTop !== undefined) p.top = cssLengthToPx(props.paddingTop) ?? 0;
    if (props.paddingRight !== undefined) p.right = cssLengthToPx(props.paddingRight) ?? 0;
    if (props.paddingBottom !== undefined) p.bottom = cssLengthToPx(props.paddingBottom) ?? 0;
    if (props.paddingLeft !== undefined) p.left = cssLengthToPx(props.paddingLeft) ?? 0;

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

    const ctx: TextMeasureContext = {
      text,
      fontSize,
      fontWeight,
      fontFamily,
      lineHeight,
      paddingH: p.left + p.right,
      paddingV: p.top + p.bottom,
      maxLines,
      textOverflow,
    };

    return tree.newLeafWithContext(style, ctx);
  }

  // Image leaves with aspect-ratio: contribute height = stretched-width /
  // aspectRatio to grid/flex track sizing via the measure callback. The
  // `style.aspectRatio` alone isn't enough — Taffy's grid auto-row pass asks
  // for the leaf's max-content height, which for an image with no fixed
  // height is 0; without the callback the row collapses.
  if (node.type.toLowerCase() === "image" && node.children.length === 0) {
    const ar =
      props.aspectRatio !== undefined
        ? parseAspectRatio(props.aspectRatio)
        : null;
    if (ar !== null) {
      const ictx: ImageAspectMeasureContext = { aspectRatio: ar };
      return tree.newLeafWithContext(style, ictx);
    }
  }

  // Container nodes
  const childIds: bigint[] = [];
  for (const child of node.children) {
    childIds.push(buildTree(tree, child, node));
  }

  return tree.newWithChildren(style, childIds);
}

/**
 * Walk the TaffyTree in the same order as the VirtualNode tree and write
 * computed layout data back to each VirtualNode.
 *
 * @param isRoot - true for the root node, where Taffy's x/y are 0 and
 *                 margin must be added manually to match the expected
 *                 absolute-position convention.
 */
function writeLayout(
  tree: InstanceType<typeof import("taffy-layout").TaffyTree>,
  taffyId: bigint,
  node: VirtualNode,
  parentX: number,
  parentY: number,
  isRoot: boolean = false,
): void {
  const tl = tree.getLayout(taffyId);

  // Taffy positions children relative to parent's content area (margin
  // included in x/y). For the root node there is no parent, so Taffy
  // reports x=0/y=0 — we must add the margin ourselves.
  const absX = parentX + tl.x + (isRoot ? tl.marginLeft : 0);
  const absY = parentY + tl.y + (isRoot ? tl.marginTop : 0);

  const borderColor = node.props.borderColor || "transparent";
  const borderRadius = cssLengthToPx(node.props.borderRadius) ?? 0;
  // Taffy computes uniform border width per side; pick top as representative
  const borderWidth = tl.borderTop;

  const layout: Layout = {
    x: absX,
    y: absY,
    width: tl.width,
    height: tl.height,
    margin: {
      top: tl.marginTop,
      right: tl.marginRight,
      bottom: tl.marginBottom,
      left: tl.marginLeft,
    },
    padding: {
      top: tl.paddingTop,
      right: tl.paddingRight,
      bottom: tl.paddingBottom,
      left: tl.paddingLeft,
    },
    border: {
      width: borderWidth,
      color: borderColor,
      radius: borderRadius,
    },
    contentX: tl.paddingLeft + borderWidth,
    contentY: tl.paddingTop + borderWidth,
    contentWidth: tl.width - tl.paddingLeft - tl.paddingRight - borderWidth * 2,
    contentHeight: tl.height - tl.paddingTop - tl.paddingBottom - borderWidth * 2,
  };

  node.layout = layout;

  // Recurse children (same order as buildTree)
  for (let i = 0; i < node.children.length; i++) {
    const childTaffyId = tree.getChildAtIndex(taffyId, i);
    writeLayout(tree, childTaffyId, node.children[i], absX, absY);
  }
}

/**
 * After a layout pass, detect Grid containers whose implicit row tracks
 * collapsed against aspect-ratio image children — Taffy treats the
 * leaves' max-content height as 0 (the measure callback can't anchor the
 * height without a known width during track sizing), so the rows get
 * sized to gap-only and items overflow their tracks by ~150px each.
 *
 * Mark the grid with a private hint (`__autoRowsPx`) carrying the height
 * we want each implicit row to be — derived from the first item's
 * computed width and aspect-ratio after the first pass. The next layout
 * pass reads this hint in `buildTaffyStyle` and sets explicit
 * `gridAutoRows`. Returns true if any grid was marked (caller re-runs
 * layout from scratch).
 */
function annotateCollapsedAspectGrids(node: VirtualNode): boolean {
  let touched = false;
  for (const child of node.children) {
    if (annotateCollapsedAspectGrids(child)) touched = true;
  }

  if (!node.layout) return touched;
  const t = node.type.toLowerCase();
  const isGrid = t === "grid" || node.props.display === "grid";
  if (!isGrid) return touched;
  // Only adjust grids that haven't already been pinned (avoid loops).
  if (node.props.__autoRowsPx) return touched;

  let firstAspectKid: VirtualNode | null = null;
  let aspectRatio = 0;
  for (const child of node.children) {
    if (child.type.toLowerCase() !== "image" || !child.layout) continue;
    const ar =
      child.props.aspectRatio !== undefined
        ? parseAspectRatio(child.props.aspectRatio)
        : null;
    if (ar === null) continue;
    firstAspectKid = child;
    aspectRatio = ar;
    break;
  }
  if (!firstAspectKid) return touched;

  const itemWidth = firstAspectKid.layout!.width;
  const expectedRowHeight = itemWidth / aspectRatio;
  if (expectedRowHeight <= 0) return touched;

  // Find a sibling image in the next row to confirm collapse: if its y
  // delta from the first row is less than the expected row height (minus
  // a tolerance for fractional pixels and gap rounding), the rows
  // overlapped — this is the symptom we're fixing.
  let nextRowKid: VirtualNode | null = null;
  for (const child of node.children) {
    if (child === firstAspectKid) continue;
    if (!child.layout) continue;
    if (child.layout.y > firstAspectKid.layout!.y + 1) {
      nextRowKid = child;
      break;
    }
  }
  if (!nextRowKid) return touched;
  const rowDelta = nextRowKid.layout!.y - firstAspectKid.layout!.y;
  if (rowDelta >= expectedRowHeight - 1) return touched;

  node.props.__autoRowsPx = expectedRowHeight;
  return true;
}

/**
 * Compute layout for a virtual node tree using Taffy.
 * Requires `initTaffyLayout()` to have been called and resolved.
 */
function computeLayoutTaffy(
  ctx: CanvasRenderingContext2D,
  node: VirtualNode,
  availableWidth: number,
  availableHeight: number,
  x: number,
  y: number,
): void {
  const T = taffy!;
  const tree = new T.TaffyTree();

  try {
    const rootId = buildTree(tree, node);

    // Pin the root to the canvas's available size when it has no explicit
    // size of its own. Without this, Taffy lets the root grow to its
    // min-content — and a horizontally-scrollable Stories row with 5+
    // items at w-24 inflated the entire feed to 607px on a 470px canvas,
    // pushing the BottomNav off-screen.
    const rootProps = node.props;
    const rootHasExplicitWidth =
      rootProps.width !== undefined || rootProps["width.0"] !== undefined;
    const rootHasExplicitHeight =
      rootProps.height !== undefined || rootProps["height.0"] !== undefined;
    if (!rootHasExplicitWidth || !rootHasExplicitHeight) {
      const rootStyle = tree.getStyle(rootId);
      rootStyle.size = {
        width: rootHasExplicitWidth
          ? cssLengthToDimension(rootProps.width ?? rootProps["width.0"])
          : availableWidth,
        height: rootHasExplicitHeight
          ? cssLengthToDimension(rootProps.height ?? rootProps["height.0"])
          : availableHeight,
      };
      tree.setStyle(rootId, rootStyle);
    }

    // Compute layout with a measure function for text leaf nodes
    tree.computeLayoutWithMeasure(
      rootId,
      { width: availableWidth, height: availableHeight },
      (knownDimensions, availableSpace, _nodeId, context, _style) => {
        // Image-with-aspect-ratio leaf: derive missing dim from the other
        // via aspectRatio so grid track sizing sees a proper max-content
        // height. Falls back to availableSpace.width when nothing's known.
        const ictx = context as ImageAspectMeasureContext | undefined;
        if (ictx && typeof ictx.aspectRatio === "number") {
          const w =
            knownDimensions.width ??
            (typeof availableSpace.width === "number"
              ? availableSpace.width
              : undefined);
          const h =
            knownDimensions.height ??
            (w !== undefined ? w / ictx.aspectRatio : undefined);
          return { width: w ?? 0, height: h ?? 0 };
        }

        const tctx = context as TextMeasureContext | undefined;
        if (!tctx?.text) {
          return { width: knownDimensions.width ?? 0, height: knownDimensions.height ?? 0 };
        }

        const maxWidth = typeof availableSpace.width === "number"
          ? availableSpace.width - tctx.paddingH
          : undefined;

        const metrics = measureText(ctx, tctx.text, {
          fontSize: tctx.fontSize,
          fontWeight: tctx.fontWeight,
          fontFamily: tctx.fontFamily,
          lineHeight: tctx.lineHeight,
        }, maxWidth, tctx.maxLines, tctx.textOverflow);

        // Return the CONTENT size only. `style.padding` is already set on
        // this Text leaf (see `buildTaffyStyle`) so Taffy will add padding
        // around the measured content itself — reporting padded metrics
        // here on top of that double-counts and inflates the box (a
        // `Button { Text.padding(12) }` ended up ~48 px wider than the
        // DOM version of the same tree).
        //
        // `Math.ceil` the reported width: pretext returns a fractional
        // pixel width (e.g. 141.71875 for "View all 87 comments"), Taffy
        // gives the box exactly that, but at paint time we re-measure with
        // a maxWidth of the integer-rounded box width and pretext then
        // wraps because 141.71 > 141. Reserve the next whole pixel up.
        return {
          width: knownDimensions.width ?? Math.ceil(metrics.width),
          height: knownDimensions.height ?? Math.ceil(metrics.height),
        };
      },
    );

    writeLayout(tree, rootId, node, x, y, /* isRoot */ true);
  } finally {
    tree.free();
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute layout for a virtual node tree.
 *
 * Uses Taffy (WASM) when available for spec-compliant CSS Flexbox/Grid/Block
 * layout. Falls back to a basic JS flexbox implementation otherwise.
 */
export function computeLayout(
  ctx: CanvasRenderingContext2D,
  node: VirtualNode,
  availableWidth: number,
  availableHeight: number,
  x: number = 0,
  y: number = 0,
): void {
  // Publish the active viewport so `cssLengthToPx` can resolve `vw` / `vh`
  // against the actual canvas dimensions during this layout pass. Without
  // this, `vh` falls back to `window.innerHeight` (wrong inside an iframe
  // or scaled preview pane) or, worse, to a unitless pixel value that
  // collapses entire layouts. Layout is synchronous, so a try/finally
  // restoring the previous slot is safe under nested or re-entrant calls.
  const prevViewport = getCurrentViewport();
  setCurrentViewport({ width: availableWidth, height: availableHeight });
  try {
    if (taffyReady && taffy) {
      computeLayoutTaffy(ctx, node, availableWidth, availableHeight, x, y);
      // After the first pass, Taffy's grid auto-row sizing for aspect-ratio
      // image leaves can collapse rows (the leaf's max-content height is 0
      // before column widths are known). Detect that pattern and re-run
      // with explicit `gridAutoRows` derived from the now-known column
      // width — see `annotateCollapsedAspectGrids`.
      if (annotateCollapsedAspectGrids(node)) {
        computeLayoutTaffy(ctx, node, availableWidth, availableHeight, x, y);
      }
    } else {
      computeLayoutFallback(ctx, node, availableWidth, availableHeight, x, y);
    }
  } finally {
    setCurrentViewport(prevViewport);
  }
}

// ---------------------------------------------------------------------------
// Fallback: original JS flexbox implementation (used in tests / non-WASM)
// ---------------------------------------------------------------------------

function computeLayoutFallback(
  ctx: CanvasRenderingContext2D,
  node: VirtualNode,
  availableWidth: number,
  availableHeight: number,
  x: number = 0,
  y: number = 0,
): void {
  const props = node.props;

  let margin = parseSpacing(props.margin || 0);
  if (props.marginTop !== undefined) margin.top = cssLengthToPx(props.marginTop) ?? 0;
  if (props.marginRight !== undefined) margin.right = cssLengthToPx(props.marginRight) ?? 0;
  if (props.marginBottom !== undefined) margin.bottom = cssLengthToPx(props.marginBottom) ?? 0;
  if (props.marginLeft !== undefined) margin.left = cssLengthToPx(props.marginLeft) ?? 0;

  let padding = parseSpacing(props.padding || 0);
  if (props.paddingTop !== undefined) padding.top = cssLengthToPx(props.paddingTop) ?? 0;
  if (props.paddingRight !== undefined) padding.right = cssLengthToPx(props.paddingRight) ?? 0;
  if (props.paddingBottom !== undefined) padding.bottom = cssLengthToPx(props.paddingBottom) ?? 0;
  if (props.paddingLeft !== undefined) padding.left = cssLengthToPx(props.paddingLeft) ?? 0;

  const borderWidth = cssLengthToPx(props.borderWidth) ?? 0;
  const borderColor = props.borderColor || "transparent";
  const borderRadius = cssLengthToPx(props.borderRadius) ?? 0;

  const availableAfterMargin = {
    width: availableWidth - margin.left - margin.right,
    height: availableHeight - margin.top - margin.bottom,
  };

  let width = parseSize(props.width);
  let height = parseSize(props.height);

  const type = node.type.toLowerCase();

  if (type === "app") {
    if (width === null) width = availableAfterMargin.width;
    if (height === null) height = availableAfterMargin.height;
  } else if (type === "spacer") {
    if (width === null) width = availableAfterMargin.width;
    if (height === null) height = availableAfterMargin.height;
  } else if (type === "divider" || type === "separator") {
    const orientation = props.orientation || "horizontal";
    const thickness = cssLengthToPx(props.thickness) ?? 1;
    if (orientation === "vertical") {
      if (width === null) width = thickness;
      if (height === null) height = availableAfterMargin.height;
    } else {
      if (width === null) width = availableAfterMargin.width;
      if (height === null) height = thickness;
    }
  } else if (type === "checkbox" || type === "radio") {
    const size = cssLengthToPx(props.size) ?? 20;
    if (width === null) width = size;
    if (height === null) height = size;
  } else if (type === "switch" || type === "toggle") {
    if (width === null) width = 44;
    if (height === null) height = 24;
  } else if (type === "slider") {
    if (width === null) width = 200;
    if (height === null) height = 20;
  } else if (type === "progress" || type === "progressbar") {
    if (width === null) width = 200;
    if (height === null) height = 8;
  } else if (type === "spinner" || type === "loading") {
    const size = cssLengthToPx(props.size) ?? 24;
    if (width === null) width = size;
    if (height === null) height = size;
  } else if (type === "badge") {
    if (width === null) width = 20;
    if (height === null) height = 20;
  } else if (type === "avatar") {
    const size = cssLengthToPx(props.size) ?? 40;
    if (width === null) width = size;
    if (height === null) height = size;
  } else if (type === "icon") {
    const size = cssLengthToPx(props.size) ?? 24;
    if (width === null) width = size;
    if (height === null) height = size;
  }

  if (node.type.toLowerCase() === "text" && node.props[0]) {
    const text = String(node.props[0] || "");
    const fontSize = cssLengthToPx(props.fontSize) ?? 16;
    const fontWeight = props.fontWeight || "normal";
    const fontFamily = props.fontFamily || "system-ui, sans-serif";
    const lineHeight = cssLengthToPx(props.lineHeight) ?? fontSize * 1.2;

    const maxWidth = width || availableAfterMargin.width - padding.left - padding.right;
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
    const metrics = measureText(ctx, text, { fontSize, fontWeight, fontFamily, lineHeight }, maxWidth, maxLines, textOverflow);

    if (!width) width = metrics.width + padding.left + padding.right;
    if (!height) height = metrics.height + padding.top + padding.bottom;
  }

  if (width === null) width = availableAfterMargin.width;
  if (height === null) height = availableAfterMargin.height;

  const minWidth = parseSize(props.minWidth);
  const maxWidth = parseSize(props.maxWidth);
  const minHeight = parseSize(props.minHeight);
  const maxHeight = parseSize(props.maxHeight);

  if (minWidth !== null) width = Math.max(width, minWidth);
  if (maxWidth !== null) width = Math.min(width, maxWidth);
  if (minHeight !== null) height = Math.max(height, minHeight);
  if (maxHeight !== null) height = Math.min(height, maxHeight);

  const layout: Layout = {
    x: x + margin.left,
    y: y + margin.top,
    width,
    height,
    margin,
    padding,
    border: {
      width: borderWidth,
      color: borderColor,
      radius: borderRadius,
    },
    contentX: padding.left + borderWidth,
    contentY: padding.top + borderWidth,
    contentWidth: width - padding.left - padding.right - borderWidth * 2,
    contentHeight: height - padding.top - padding.bottom - borderWidth * 2,
  };

  node.layout = layout;

  if (node.children.length > 0) {
    layoutChildrenFallback(ctx, node);
  }
}

function layoutChildrenFallback(ctx: CanvasRenderingContext2D, parent: VirtualNode): void {
  const layout = parent.layout!;
  const props = parent.props;

  if (parent.type.toLowerCase() === "stack") {
    layoutStackChildrenFallback(ctx, parent);
    return;
  }

  const flexDirection = props.flexDirection || (parent.type === "column" ? "column" : "row");
  const isColumn = flexDirection === "column";

  const justifyContent = isColumn
    ? (props.verticalAlignment || "flex-start")
    : (props.horizontalAlignment || "flex-start");
  const alignItems = isColumn
    ? (props.horizontalAlignment || "flex-start")
    : (props.verticalAlignment || "flex-start");
  const gap = cssLengthToPx(props.gap) ?? 0;

  const availableWidth = layout.contentWidth;
  const availableHeight = layout.contentHeight;

  const childInfo: Array<{
    width: number;
    height: number;
    flexGrow: number;
    flexShrink: number;
    flexBasis: number | null;
  }> = [];
  let totalMainSize = 0;
  let totalFlexGrow = 0;
  let totalFlexShrink = 0;

  for (const child of parent.children) {
    const flexGrow = parseFloat(child.props.flexGrow) || parseFloat(child.props.flex) || 0;
    const childType = child.type.toLowerCase();
    const defaultShrink = INTRINSIC_SIZED.has(childType) ? 0 : 1;
    const flexShrink = child.props.flexShrink !== undefined
      ? parseFloat(child.props.flexShrink)
      : defaultShrink;
    const flexBasis = parseSize(child.props.flexBasis);

    computeLayoutFallback(ctx, child, availableWidth, availableHeight, 0, 0);

    const childLayout = child.layout!;
    let mainSize = isColumn ? childLayout.height : childLayout.width;

    if (flexBasis !== null) {
      mainSize = flexBasis;
      if (isColumn) {
        childLayout.height = flexBasis;
      } else {
        childLayout.width = flexBasis;
      }
    }

    childInfo.push({ width: childLayout.width, height: childLayout.height, flexGrow, flexShrink, flexBasis });
    totalMainSize += mainSize;
    totalFlexGrow += flexGrow;
    totalFlexShrink += flexShrink;
  }

  const totalGap = gap * (parent.children.length - 1);
  totalMainSize += totalGap;

  const availableMain = isColumn ? availableHeight : availableWidth;
  let remainingSpace = availableMain - totalMainSize;

  if (remainingSpace > 0 && totalFlexGrow > 0) {
    const spacePerFlex = remainingSpace / totalFlexGrow;
    for (let i = 0; i < parent.children.length; i++) {
      const info = childInfo[i];
      if (info.flexGrow > 0) {
        const extraSpace = spacePerFlex * info.flexGrow;
        if (isColumn) info.height += extraSpace;
        else info.width += extraSpace;
        totalMainSize += extraSpace;
      }
    }
    remainingSpace = 0;
  }

  if (remainingSpace < 0 && totalFlexShrink > 0) {
    const shrinkPerFlex = Math.abs(remainingSpace) / totalFlexShrink;
    for (let i = 0; i < parent.children.length; i++) {
      const info = childInfo[i];
      if (info.flexShrink > 0) {
        const shrinkSpace = Math.min(
          shrinkPerFlex * info.flexShrink,
          isColumn ? info.height : info.width,
        );
        if (isColumn) info.height = Math.max(0, info.height - shrinkSpace);
        else info.width = Math.max(0, info.width - shrinkSpace);
        totalMainSize -= shrinkSpace;
      }
    }
    remainingSpace = availableMain - totalMainSize;
  }

  let mainStart = 0;
  let spacing = 0;

  if (justifyContent === "center") {
    mainStart = Math.max(0, remainingSpace / 2);
  } else if (justifyContent === "flex-end") {
    mainStart = Math.max(0, remainingSpace);
  } else if (justifyContent === "space-between") {
    spacing = remainingSpace / Math.max(1, parent.children.length - 1);
  } else if (justifyContent === "space-around") {
    spacing = remainingSpace / parent.children.length;
    mainStart = spacing / 2;
  }

  let currentMain = mainStart;

  for (let i = 0; i < parent.children.length; i++) {
    const child = parent.children[i];
    const childLayout = child.layout!;
    const info = childInfo[i];

    childLayout.width = info.width;
    childLayout.height = info.height;

    let crossStart = 0;
    const availableCross = isColumn ? availableWidth : availableHeight;
    const childCross = isColumn ? info.width : info.height;

    if (alignItems === "center") {
      crossStart = (availableCross - childCross) / 2;
    } else if (alignItems === "flex-end") {
      crossStart = availableCross - childCross;
    }

    if (isColumn) {
      childLayout.x = layout.x + layout.contentX + crossStart;
      childLayout.y = layout.y + layout.contentY + currentMain;
      currentMain += info.height + gap;
    } else {
      childLayout.x = layout.x + layout.contentX + currentMain;
      childLayout.y = layout.y + layout.contentY + crossStart;
      currentMain += info.width + gap;
    }

    if (justifyContent === "space-between" || justifyContent === "space-around") {
      currentMain += spacing;
    }
  }
}

function layoutStackChildrenFallback(ctx: CanvasRenderingContext2D, parent: VirtualNode): void {
  const layout = parent.layout!;
  const props = parent.props;

  const horizontalAlignment = props.horizontalAlignment || "flex-start";
  const verticalAlignment = props.verticalAlignment || "flex-start";

  const availableWidth = layout.contentWidth;
  const availableHeight = layout.contentHeight;

  for (const child of parent.children) {
    computeLayoutFallback(ctx, child, availableWidth, availableHeight, 0, 0);

    const childLayout = child.layout!;

    let x = 0;
    let y = 0;

    if (horizontalAlignment === "center") {
      x = (availableWidth - childLayout.width) / 2;
    } else if (horizontalAlignment === "flex-end") {
      x = availableWidth - childLayout.width;
    }

    if (verticalAlignment === "center") {
      y = (availableHeight - childLayout.height) / 2;
    } else if (verticalAlignment === "flex-end") {
      y = availableHeight - childLayout.height;
    }

    childLayout.x = layout.x + layout.contentX + x;
    childLayout.y = layout.y + layout.contentY + y;
  }
}
