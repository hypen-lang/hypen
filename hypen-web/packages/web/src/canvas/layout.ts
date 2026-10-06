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
  cssLengthToPxForFont,
  cssLineHeightToPx,
  cssLengthToPxWithBasis,
  parseCalcLength,
  setCssViewport,
  isLayoutHidden,
  inheritedTextProp,
} from "./utils.js";
import { measureText } from "./text.js";
import { trackCount } from "../grid-tracks.js";
import {
  SAFE_AREA_EDGES,
  getEffectiveSafeAreaInsets,
  resolveSafeAreaEdges,
} from "../safe-area.js";
import {
  getImageNaturalAspect,
  getImageNaturalSize,
  getVideoIntrinsicAspect,
  isVideoNode,
  videoSlotName,
} from "./paint.js";
import { CHART_DEFAULTS, isChartNode, layoutCharts } from "./chart.js";

/**
 * Components whose size is intrinsic to the component itself (icon, avatar,
 * checkbox, etc.) should not be shrunk by their flex parent. Without this,
 * an icon inside a transparent button with no width collapses to 0×0 in
 * tight cross-axis containers.
 */
const INTRINSIC_SIZED = new Set([
  "icon",
  "avatar",
  "audio",
  "badge",
  "checkbox",
  "radio",
  "switch",
  "spinner",
]);

/**
 * Component types whose children flow HORIZONTALLY by default.
 *
 * Everything else that isn't a Stack/Grid flows vertically, which is what the
 * DOM renderer does: `Row`/`Tabs` set `flex-direction: row`, while `App`,
 * `Router`, `Route`, `Button`, `List`, and `Column` set `column` — and a plain
 * `div` (`Container`, `Card`, and the `display: contents` fallback the DOM
 * uses for UNKNOWN types such as module wrappers) stacks its children in block
 * flow, i.e. vertically.
 *
 * Canvas used to default every non-Column type to a flex ROW, so the
 * `Router` → `Route` → `<ModuleName>` wrapper chain the engine emits around
 * every routed module laid its page sections out side by side. In Hypeflix
 * that stacked the header, hero, banner and all five rails on top of each
 * other along the top edge — the single biggest source of the garbled canvas
 * page. Keep this list explicit (rather than "unknown ⇒ row") so an
 * unrecognised custom component behaves like the DOM's transparent wrapper.
 */
/**
 * Resolve the gap for both axes.
 *
 * `rowGap` / `columnGap` are registered applicators on DOM, Android and Swift
 * but the canvas only ever read the shorthand `gap`, so per-axis gaps were
 * silently dropped. The shorthand remains the fallback for either axis.
 */
function resolveGap(props: Record<string, any>): { row: number; column: number } {
  const shorthand = cssLengthToPx(props.gap) ?? 0;
  return {
    row: cssLengthToPx(props.rowGap) ?? shorthand,
    column: cssLengthToPx(props.columnGap) ?? shorthand,
  };
}

/** Gap along a container's main axis: rows stack vertically, columns across. */
function mainAxisGap(props: Record<string, any>, isCol: boolean): number {
  const { row, column } = resolveGap(props);
  return isCol ? row : column;
}

const ROW_FLOW_TYPES = new Set(["row", "tabs", "badge"]);

/**
 * Does this node lay its children out along the vertical axis?
 * Explicit `flexDirection` (from `.tw("flex-row")` / `flex-col`) always wins.
 */
function isColumnFlow(node: VirtualNode): boolean {
  const type = node.type.toLowerCase();
  const dir = node.props.flexDirection;
  if (dir === "row" || dir === "row-reverse") return false;
  if (dir === "column" || dir === "column-reverse") return true;
  // `List` is the DSL's stack iterator: vertical unless asked otherwise.
  if (type === "list") return node.props.direction !== "horizontal";
  return !ROW_FLOW_TYPES.has(type);
}

/**
 * SafeArea: add the effective safe-area inset to the node's padding on each
 * edge the `edges` prop selects (all four when absent/empty).
 *
 * Additive on purpose — the DOM renderer's element carries safe-area padding
 * alongside the authored `.padding()`, and canvas has no separate box to
 * hang one of them on, so the two simply sum here. Mutates `p` in place;
 * every caller owns a freshly parsed BoxSpacing.
 */
function addSafeAreaPadding(p: BoxSpacing, props: Record<string, any>): void {
  const insets = getEffectiveSafeAreaInsets();
  const edges = resolveSafeAreaEdges(props.edges);
  for (const edge of SAFE_AREA_EDGES) {
    if (edges.has(edge)) p[edge] += insets[edge];
  }
}

/**
 * Which layout backend {@link computeLayout} uses.
 *
 * `"auto"` (the default) prefers Taffy when its WASM module came up and falls
 * back to the JS flex implementation otherwise. `"fallback"` pins the JS path
 * unconditionally — the two backends are separately observable (Taffy is a
 * full CSS implementation; the JS path models the subset the DSL reaches), so
 * anything that needs to assert one specific backend's behaviour has to be
 * able to say which.
 */
export type LayoutBackend = "auto" | "fallback";
let layoutBackend: LayoutBackend = "auto";

/** Force (or un-force) the layout backend. See {@link LayoutBackend}. */
export function setLayoutBackend(backend: LayoutBackend): void {
  layoutBackend = backend;
}

/** The backend currently selected (not necessarily the one available). */
export function getLayoutBackend(): LayoutBackend {
  return layoutBackend;
}

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
      // In a server runtime (Bun/Node — including test runs where a JSDOM
      // `window` may be globally registered by another test file), load the
      // WASM from node_modules via fs. This path is deterministic; the
      // fetch-based branch below depends on a reachable origin/CDN and must
      // never be selected just because a test polyfilled `window`.
      const isServerRuntime =
        typeof process !== "undefined" &&
        !!(process.versions?.bun || process.versions?.node);
      if (isServerRuntime) {
        await taffy.loadTaffy();
        taffyReady = true;
        return;
      }
      // Bundlers (esp. Bun's browser bundler) sometimes inline a file:// URL
      // for import.meta.url inside taffy_wasm.js, which the browser blocks
      // ("Not allowed to load local resource"). The package's own `loadTaffy`
      // ignores args and falls through to that broken default, so call the
      // raw `__wbg_init` (default export of the `taffy-layout/wasm` subpath)
      // directly with an explicit Response.
      let usedExplicit = false;
      // Only take the fetch path in a real browser. Test environments (and
      // anything else that installs a fake `window` global) must fall through
      // to `loadTaffy()`, which resolves the WASM from the package on disk —
      // a fake window without `location.origin` used to throw here and
      // silently disable Taffy for the rest of the process.
      const isRealBrowser =
        typeof window !== "undefined" &&
        typeof fetch === "function" &&
        typeof window.location?.origin === "string" &&
        window.document?.defaultView === window;
      if (isRealBrowser) {
        try {
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
        } catch {
          // Fall through to loadTaffy()
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

/**
 * True when a `calc()` value needed a containing-block basis this pass but
 * none was available yet (the parent had no computed layout). `computeLayout`
 * re-runs once in that case — the second pass sees the first pass' boxes and
 * resolves the calc exactly. Mirrors the `annotateCollapsedAspectGrids`
 * two-pass pattern already used for aspect-ratio grids.
 */
let calcNeedsSecondPass = false;

/** Parse a Hypen prop value into a Taffy Dimension ("auto" | number | "N%") */
function toDimension(value: any, basis?: number | null): "auto" | number | `${number}%` {
  if (basis === undefined && typeof value === "string" && value.includes("calc(")) {
    const calc = parseCalcLength(value);
    if (calc && calc.pct !== 0 && calc.px !== 0) calcNeedsSecondPass = true;
  }
  return cssLengthToDimension(value, basis);
}

/**
 * Containing-block size for a child's `calc()`/percentage resolution, taken
 * from the parent's PREVIOUS layout pass. Null on the very first pass (or for
 * the root), which flags a second pass.
 */
function calcBasis(parent: VirtualNode | null, axis: "width" | "height"): number | null {
  if (!parent?.layout) return null;
  return axis === "width" ? parent.layout.contentWidth : parent.layout.contentHeight;
}

/**
 * Resolve a width/height prop to a Taffy Dimension, using the parent's known
 * content box as the basis for mixed `calc()` values.
 */
function toAxisDimension(
  value: any,
  parent: VirtualNode | null,
  axis: "width" | "height",
): "auto" | number | `${number}%` {
  if (typeof value === "string" && value.includes("calc(")) {
    const calc = parseCalcLength(value);
    if (calc && calc.pct !== 0 && calc.px !== 0) {
      const basis = calcBasis(parent, axis);
      if (basis === null) calcNeedsSecondPass = true;
      return cssLengthToDimension(value, basis);
    }
  }
  return cssLengthToDimension(value);
}

/**
 * Expand combined/fill sizing applicators into the per-axis value the DOM
 * renderer would write to CSS. Canvas does not run the DOM applicator
 * registry, so these declarations otherwise remain inert props.
 */
function axisSizeValue(
  props: Record<string, any>,
  axis: "width" | "height",
): any {
  if (props[axis] !== undefined) return props[axis];

  const size = props.size;
  if (size !== undefined && size !== null) {
    if (typeof size === "object") {
      if (size[axis] !== undefined) return size[axis];
    } else {
      return size;
    }
  }

  const fill = props.fillMaxSize !== undefined
    ? props.fillMaxSize
    : axis === "width"
      ? props.fillMaxWidth
      : props.fillMaxHeight;
  if (fill === false || fill === null || fill === undefined) return undefined;
  const fraction = typeof fill === "number" ? fill : 1;
  return `${fraction * 100}%`;
}

function borderObject(props: Record<string, any>): Record<string, any> | null {
  return props.border && typeof props.border === "object" ? props.border : null;
}

function resolvedBorderWidth(props: Record<string, any>): number {
  const border = borderObject(props);
  const value = props.borderWidth ?? border?.width ??
    (typeof props.border === "number" ? props.border : undefined);
  return cssLengthToPx(value) ?? 0;
}

function resolvedBorderColor(props: Record<string, any>): string {
  return String(props.borderColor ?? borderObject(props)?.color ?? "transparent");
}

function resolvedBorderRadius(props: Record<string, any>): number {
  return cssLengthToPx(
    props.borderRadius ?? props.cornerRadius ?? borderObject(props)?.radius,
  ) ?? 0;
}

const BADGE_PADDING_KEYS = [
  "padding", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "paddingHorizontal", "paddingVertical",
];

function basePaddingValue(props: Record<string, any>, type: string): any {
  if (props.padding !== undefined) return props.padding;
  if (type === "card") {
    const hasCustomPadding = BADGE_PADDING_KEYS.some(
      (name) => name !== "padding" && props[name] !== undefined,
    );
    return hasCustomPadding ? 0 : 16;
  }
  if (type !== "badge") return 0;
  const hasCustomPadding = BADGE_PADDING_KEYS.some(
    (name) => name !== "padding" && props[name] !== undefined,
  );
  const hasFixedBox =
    axisSizeValue(props, "width") !== undefined &&
    axisSizeValue(props, "height") !== undefined;
  return hasFixedBox && !hasCustomPadding ? 0 : "4 8";
}

const HORIZONTAL_DEMAND_CARRIERS = new Set(["column", "list", "card"]);

function horizontalWidthKind(node: VirtualNode): "fixed" | "relative" | null {
  const value = axisSizeValue(node.props, "width");
  if (value === undefined || value === null || value === "auto") return null;
  return typeof value === "string" && value.includes("%") ? "relative" : "fixed";
}

/** Pure Canvas equivalent of DOM cross-axis width-demand propagation. */
function carriesHorizontalDemand(node: VirtualNode): boolean {
  const ownWidth = horizontalWidthKind(node);
  if (ownWidth === "fixed") return false;
  if (ownWidth === "relative") return true;

  const type = node.type.toLowerCase();
  if (type === "grid" || type === "list") return true;
  if (type === "divider") {
    return node.props.orientation !== "vertical";
  }
  if (type === "row") {
    const justify = String(node.props.horizontalAlignment ?? node.props.justifyContent ?? "start");
    if (justify !== "start" && justify !== "flex-start") return true;
    return node.children.some((child) => {
      if (child.type.toLowerCase() === "spacer") return true;
      const flex = Number(child.props.flex ?? child.props.weight ?? child.props.flexGrow ?? 0);
      return flex > 0 || carriesHorizontalDemand(child);
    });
  }
  return HORIZONTAL_DEMAND_CARRIERS.has(type) &&
    node.children.some(carriesHorizontalDemand);
}

function needsAutomaticCrossAxisStretch(node: VirtualNode): boolean {
  return horizontalWidthKind(node) === null && carriesHorizontalDemand(node);
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
  const isCenter = type === "center";
  const isColumn = !isStack && isColumnFlow(node);
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
    const stackAlignment = props.alignment ?? props["alignment.0"];
    style.justifyItems = (props.horizontalAlignment || stackAlignment)
      ? mapAlign(T, props.horizontalAlignment || stackAlignment)
      : T.AlignItems.Start;
    style.alignItems = (props.verticalAlignment || stackAlignment)
      ? mapAlign(T, props.verticalAlignment || stackAlignment)
      : T.AlignItems.Start;
  } else if (isGrid) {
    style.display = T.Display.Grid;

    // --- Grid columns --------------------------------------------------------
    // `.gridColumns(N)` (or the Grid `columns` prop): a count of equal `1fr`
    // tracks — the only track form every renderer supports (see
    // grid-tracks.ts). Same as the DOM renderer.
    const cols = trackCount(props.gridColumns ?? props.columns);
    if (cols !== null) style.gridTemplateColumns = equalTracks(cols);

    // Set by `annotateCollapsedAspectGrids` after a first layout pass — pin
    // implicit rows to the height we want each cell to be (column width /
    // aspectRatio), so `aspect-square` images don't overlap.
    if (typeof props.__autoRowsPx === "number") {
      const px = props.__autoRowsPx as number;
      style.gridAutoRows = [{ min: px, max: px }];
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

  // --- Grid child placement --------------------------------------------------
  // `.gridColumn("span N")` (or N): a column span, as on iOS/Android.
  if (props.gridColumn !== undefined) {
    const span = trackCount(String(props.gridColumn).trim().replace(/^span\s+/i, ""));
    if (span !== null) style.gridColumn = parseGridLine(`span ${span}`);
  }

  // --- Flex properties -------------------------------------------------------
  // The `flex: <n>` shorthand (Tailwind's `flex-1` is `flex: 1 1 0%`) sets
  // grow + shrink + basis at once. Without honouring the basis here, an
  // overflowing flex item starts at its intrinsic content size (e.g. a
  // huge feed) and Taffy redistributes from there, which under-allocates
  // the BottomNav and pushes it off-screen on routes with tall content.
  const flexValue = props.flex ?? props.weight;
  const flexShorthand = flexValue !== undefined ? parseFloat(flexValue) : NaN;
  style.flexGrow = parseFloat(props.flexGrow) || (Number.isFinite(flexShorthand) ? flexShorthand : 0);
  // Default flex-shrink is 0 when:
  //   - the component has an intrinsic size (icon, avatar, …) — otherwise it
  //     collapses to 0×0 in a tight cross-axis container, e.g. an icon inside
  //     a transparent button with only `padding.0`.
  //   - the parent is a scrollable container along the main axis — otherwise
  //     a horizontal strip's items shrink to fit instead of overflowing,
  //     making the strip pointless.
  const parentIsStack = parentType === "stack";
  const parentIsCol = parent !== null && !parentIsStack && isColumnFlow(parent);
  const parentIsRow = parent !== null && !parentIsStack && !parentIsCol;
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
    else if (isColumn && props.textAlign) {
      const inheritedAlign = String(props.textAlign).toLowerCase();
      if (inheritedAlign === "center") style.alignItems = T.AlignItems.Center;
      else if (inheritedAlign === "right" || inheritedAlign === "end") style.alignItems = T.AlignItems.End;
      else style.alignItems = T.AlignItems.Start;
    }
    else {
      // Hypen Columns and Rows both default to cross-axis start. Expansion
      // is explicit via a fill applicator or stretch alignment, matching the
      // DOM, SwiftUI, and Compose contracts. Taffy's flex default is Stretch,
      // which made an ordinary Row child silently fill a fixed Row height.
      style.alignItems = T.AlignItems.Start;
    }
    if (isCenter) {
      style.justifyContent = T.JustifyContent.Center;
      style.alignItems = T.AlignItems.Center;
    }
  }

  // --- Align-self (per-item cross-axis override) -----------------------------
  // Tailwind's `self-center` / the `.alignSelf("center")` applicator. This is
  // the other half of the page-level "max-w-… + centered" pattern: a child of
  // a Column with `width: 100%`, `max-width: 1280` and `align-self: center`
  // must keep its own cross size (not stretch) and sit centred. Without this
  // mapping the child inherited the container's `align-items` (stretch by
  // default), so every centred page section pinned to the left edge.
  //
  // Under a Stack (grid) parent the same intent applies to BOTH axes: the
  // single cell is `justify-items/align-items: start`, so a `self-center`
  // child needs `justifySelf` too or it only moves vertically.
  if (props.alignSelf !== undefined && props.alignSelf !== "auto") {
    const self = mapAlignSelf(T, String(props.alignSelf));
    if (self !== null) {
      style.alignSelf = self;
      if (parentType === "stack") style.justifySelf = self;
    }
  } else if (
    type === "text" &&
    parentType === "stack" &&
    inheritedTextAlign(node) !== null
  ) {
    style.alignSelf = T.AlignSelf.Stretch;
    style.justifySelf = T.AlignSelf.Stretch;
  } else if (needsAutomaticCrossAxisStretch(node)) {
    style.alignSelf = T.AlignSelf.Stretch;
  } else if (type === "badge") {
    // DOM Badge is inline-flex and therefore remains content-sized inside a
    // Column instead of accepting the parent's default cross-axis stretch.
    style.alignSelf = T.AlignSelf.Start;
  }
  if (props.justifySelf !== undefined && props.justifySelf !== "auto") {
    const jself = mapAlignSelf(T, String(props.justifySelf));
    if (jself !== null) style.justifySelf = jself;
  }

  // --- Size ------------------------------------------------------------------
  const widthValue = axisSizeValue(props, "width");
  const heightValue = axisSizeValue(props, "height");
  const widthDimension = toAxisDimension(widthValue, parent, "width");
  const heightDimension = toAxisDimension(heightValue, parent, "height");
  const widthIsSet = widthValue !== undefined && widthValue !== null;
  const heightIsSet = heightValue !== undefined && heightValue !== null;

  // Component-type defaults
  if (type === "app" || type === "safearea") {
    style.size = {
      width: widthIsSet ? widthDimension : "100%",
      height: heightIsSet ? heightDimension : "100%",
    };
  } else if (type === "spacer") {
    style.size = { width: widthDimension, height: heightDimension };
    style.flexGrow = 1;
    style.flexShrink = 1;
    style.flexBasis = 0;
  } else if (type === "divider") {
    const orientation = props.orientation || "horizontal";
    const thickness = cssLengthToPx(props.thickness) ?? 1;
    if (orientation === "vertical") {
      style.size = {
        width: widthIsSet ? widthDimension : thickness,
        height: heightIsSet ? heightDimension : "100%",
      };
    } else {
      style.size = {
        width: widthIsSet ? widthDimension : "100%",
        height: heightIsSet ? heightDimension : thickness,
      };
    }
  } else if (type === "checkbox" || type === "radio") {
    const sz = cssLengthToPx(props.size) ?? 20;
    style.size = {
      width: widthIsSet ? widthDimension : sz,
      height: heightIsSet ? heightDimension : sz,
    };
  } else if (type === "switch") {
    style.size = {
      width: widthIsSet ? widthDimension : 44,
      height: heightIsSet ? heightDimension : 24,
    };
  } else if (type === "slider") {
    style.size = {
      width: widthIsSet ? widthDimension : 200,
      height: heightIsSet ? heightDimension : 20,
    };
  } else if (type === "scrubber") {
    // Same intrinsic box as Slider: a timeline in a controls Row grows via
    // `.flex(1)` / `.fillMaxWidth(true)` like any other child.
    style.size = {
      width: widthIsSet ? widthDimension : 200,
      height: heightIsSet ? heightDimension : 20,
    };
  } else if (type === "progressbar") {
    style.size = {
      width: widthIsSet ? widthDimension : 200,
      height: heightIsSet ? heightDimension : 8,
    };
  } else if (type === "spinner") {
    const sz = cssLengthToPx(props.size) ?? 24;
    style.size = {
      width: widthIsSet ? widthDimension : sz,
      height: heightIsSet ? heightDimension : sz,
    };
  } else if (type === "chart") {
    // A Chart is a block that fills its parent's width and has an intrinsic
    // height, exactly like the DOM renderer's <svg> host. Its marks are laid
    // out by the chart itself (see `layoutCharts`), never by Taffy.
    style.size = {
      width: widthIsSet ? widthDimension : "100%",
      height: heightIsSet ? heightDimension : CHART_DEFAULTS.height,
    };
  } else if (type === "badge") {
    style.size = {
      width: widthDimension,
      height: heightDimension,
    };
  } else if (type === "avatar") {
    const sz = cssLengthToPx(props.size) ?? 40;
    style.size = {
      width: widthIsSet ? widthDimension : sz,
      height: heightIsSet ? heightDimension : sz,
    };
  } else if (type === "audio") {
    style.size = {
      width: widthIsSet ? widthDimension : 300,
      height: heightIsSet ? heightDimension : 54,
    };
  } else if (type === "icon") {
    const sz = cssLengthToPx(props.size) ?? 24;
    style.size = {
      width: widthIsSet ? widthDimension : sz,
      height: heightIsSet ? heightDimension : sz,
    };
  } else if (type === "input" || type === "textarea" || type === "select") {
    // Form controls have no painted children, so without an intrinsic
    // height they collapse to padding only (the social Search bar
    // rendered as a 4-tall pill instead of the ~36 the DOM produces).
    // Match the DOM box: outer = line-height(s) + padding + border.
    // Taffy defaults to `box-sizing: border-box`, so we add the
    // padding/border ourselves into `size.height`.
    const fontSize = cssLengthToPx(props.fontSize) ?? 16;
    const lineHeight = cssLineHeightToPx(props.lineHeight, fontSize) ?? fontSize * 1.5;
    const minRows = type === "textarea" ? Math.max(1, Number(props.rows) || 3) : 1;
    const padTop = cssLengthToPx(props.paddingTop ?? props.padding) ?? 0;
    const padBottom = cssLengthToPx(props.paddingBottom ?? props.padding) ?? 0;
    const borderTop = props.borderTopWidth !== undefined
      ? cssLengthToPx(props.borderTopWidth) ?? 0
      : resolvedBorderWidth(props);
    const borderBottom = props.borderBottomWidth !== undefined
      ? cssLengthToPx(props.borderBottomWidth) ?? 0
      : resolvedBorderWidth(props);
    const intrinsicH = lineHeight * minRows + padTop + padBottom + borderTop + borderBottom;
    style.size = {
      // A native/DOM Select has an intrinsic inline width even without an
      // authored width. Canvas leaves otherwise measure to zero because the
      // option children are semantic data rather than layout descendants.
      width: type === "select" && !widthIsSet ? 120 : widthDimension,
      height: heightIsSet ? heightDimension : intrinsicH,
    };
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
    const widthIn = parentIsGridLayout && widthValue === "100%" ? undefined : widthValue;
    const heightIn = parentIsGridLayout && heightValue === "100%" ? undefined : heightValue;
    style.size = {
      width: toAxisDimension(widthIn, parent, "width"),
      height: toAxisDimension(heightIn, parent, "height"),
    };
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
    (parent.type.toLowerCase() === "grid" ||
      parent.type.toLowerCase() === "stack" ||
      parent.props.display === "grid");
  if (props.minWidth !== undefined || props.minHeight !== undefined) {
    style.minSize = {
      width: toAxisDimension(props.minWidth, parent, "width"),
      height: toAxisDimension(props.minHeight, parent, "height"),
    };
  } else if (parentIsGrid || (parentIsRow && style.flexGrow > 0)) {
    style.minSize = { width: 0, height: 0 };
  }
  if (props.maxWidth !== undefined || props.maxHeight !== undefined) {
    style.maxSize = {
      width: toAxisDimension(props.maxWidth, parent, "width"),
      height: toAxisDimension(props.maxHeight, parent, "height"),
    };
  }

  // --- Margin ----------------------------------------------------------------
  const m = parseSpacing(props.margin || 0);
  if (props.marginHorizontal !== undefined) {
    m.left = cssLengthToPx(props.marginHorizontal) ?? 0;
    m.right = cssLengthToPx(props.marginHorizontal) ?? 0;
  }
  if (props.marginVertical !== undefined) {
    m.top = cssLengthToPx(props.marginVertical) ?? 0;
    m.bottom = cssLengthToPx(props.marginVertical) ?? 0;
  }
  if (props.marginTop !== undefined) m.top = cssLengthToPx(props.marginTop) ?? 0;
  if (props.marginRight !== undefined) m.right = cssLengthToPx(props.marginRight) ?? 0;
  if (props.marginBottom !== undefined) m.bottom = cssLengthToPx(props.marginBottom) ?? 0;
  if (props.marginLeft !== undefined) m.left = cssLengthToPx(props.marginLeft) ?? 0;
  style.margin = { top: m.top, right: m.right, bottom: m.bottom, left: m.left };

  // --- Padding ---------------------------------------------------------------
  const p = parseSpacing(basePaddingValue(props, type));
  if (props.paddingHorizontal !== undefined) {
    p.left = cssLengthToPx(props.paddingHorizontal) ?? 0;
    p.right = cssLengthToPx(props.paddingHorizontal) ?? 0;
  }
  if (props.paddingVertical !== undefined) {
    p.top = cssLengthToPx(props.paddingVertical) ?? 0;
    p.bottom = cssLengthToPx(props.paddingVertical) ?? 0;
  }
  if (props.paddingTop !== undefined) p.top = cssLengthToPx(props.paddingTop) ?? 0;
  if (props.paddingRight !== undefined) p.right = cssLengthToPx(props.paddingRight) ?? 0;
  if (props.paddingBottom !== undefined) p.bottom = cssLengthToPx(props.paddingBottom) ?? 0;
  if (props.paddingLeft !== undefined) p.left = cssLengthToPx(props.paddingLeft) ?? 0;
  if (type === "safearea") addSafeAreaPadding(p, props);
  style.padding = { top: p.top, right: p.right, bottom: p.bottom, left: p.left };

  // --- Border ----------------------------------------------------------------
  const bw = resolvedBorderWidth(props);
  if (bw > 0) {
    style.border = { top: bw, right: bw, bottom: bw, left: bw };
  }

  // --- Gap -------------------------------------------------------------------
  const { row: rowGap, column: columnGap } = resolveGap(props);
  if (rowGap > 0 || columnGap > 0) {
    // Taffy's `width` is the between-columns gap, `height` the between-rows.
    style.gap = { width: columnGap, height: rowGap };
  }

  // --- Aspect ratio ----------------------------------------------------------
  // Engine emits values like `"1"` or `16/9`. Taffy expects a number.
  if (props.aspectRatio !== undefined) {
    const ar = parseAspectRatio(props.aspectRatio);
    if (ar !== null) style.aspectRatio = ar;
  } else if (type === "image") {
    // A decoded image contributes its intrinsic ratio even when neither
    // dimension was declared. This is essential for auto-row grids such as
    // `.gridColumns(3) { Image(...) }`: the track supplies the width and the
    // natural ratio supplies a non-zero row height.
    const wParsed = parseSize(props.width);
    const hParsed = parseSize(props.height);
    const src = props.src ?? props[0];
    if (typeof src === "string") {
      const intrinsic = getImageNaturalAspect(src);
      if (intrinsic !== null) {
        style.aspectRatio = intrinsic;
        // With exactly one declared axis, pin both dimensions explicitly:
        // cross-axis stretch otherwise wins before Taffy applies the ratio.
        if ((wParsed === null) !== (hParsed === null)) {
          if (wParsed !== null) {
            style.size = { width: wParsed, height: wParsed / intrinsic };
          } else if (hParsed !== null) {
            style.size = { width: hParsed * intrinsic, height: hParsed };
          }
        } else if (wParsed === null && hParsed === null && parentType !== "grid") {
          const natural = getImageNaturalSize(src);
          if (natural !== null) {
            style.size = { width: natural.width, height: natural.height };
          }
        }
      }
    }
  } else if (type === "video") {
    // Same one-declared-dimension fixup as Image, with one difference: a
    // Video always has an intrinsic aspect to pin against — the loaded
    // track's natural aspect after `loadedmetadata`, 16:9 until then
    // (per the Video contract).
    const wParsed = parseSize(props.width);
    const hParsed = parseSize(props.height);
    if ((wParsed === null) !== (hParsed === null)) {
      const intrinsic = getVideoIntrinsicAspect(node.id, props);
      if (wParsed !== null) {
        style.size = { width: wParsed, height: wParsed / intrinsic };
        style.aspectRatio = intrinsic;
      } else if (hParsed !== null) {
        style.size = { width: hParsed * intrinsic, height: hParsed };
        style.aspectRatio = intrinsic;
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
  } else if (props.overflow === "hidden" || props.overflow === "clip") {
    // Tailwind's `overflow-hidden`. Same reasoning as the scroll case: the
    // container must not bubble its overflowing min-content size up into its
    // parent. Hypeflix's route shells are `flex-1 h-full min-h-0
    // overflow-hidden` — without this the tall Browse feed inflated every
    // ancestor and the `h-screen` page could never bound it.
    const o = props.overflow === "clip" ? T.Overflow.Clip : T.Overflow.Hidden;
    style.overflow = { x: o, y: o };
  }

  // --- Out of flow (Tailwind `hidden`, VisuallyHidden) -----------------------
  // Applied LAST so it overrides the flex/grid display chosen above. Taffy
  // removes the node (and its subtree) from layout entirely, matching CSS.
  if (isLayoutHidden(node)) {
    style.display = T.Display.None;
  }

  return style;
}

function inheritedTextAlign(node: VirtualNode): string | null {
  let current: VirtualNode | null = node;
  while (current) {
    const value = current.props.textAlign ?? current.props["text-align"];
    if (value !== undefined) return String(value).toLowerCase();
    current = current.parent;
  }
  return null;
}

function mapJustify(T: typeof import("taffy-layout"), value: string) {
  switch (normalizeJustify(value)) {
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

/**
 * Map an `align-self` / `justify-self` value onto Taffy's AlignSelf enum.
 * Returns null for `auto` and unknown values so the caller leaves the item
 * inheriting the container's `align-items`.
 */
function mapAlignSelf(T: typeof import("taffy-layout"), value: string) {
  switch (value) {
    case "center": return T.AlignSelf.Center;
    case "start": case "flex-start": case "self-start": return T.AlignSelf.Start;
    case "end": case "flex-end": case "self-end": return T.AlignSelf.End;
    case "stretch": return T.AlignSelf.Stretch;
    case "baseline": return T.AlignSelf.Baseline;
    default: return null;
  }
}


// ---------------------------------------------------------------------------
// Grid helpers: parse Hypen prop values → Taffy grid types
// ---------------------------------------------------------------------------

/** N equal `1fr` tracks (Taffy wants the expanded track list). */
function equalTracks(n: number): any[] {
  return Array.from({ length: n }, () => ({ min: "auto", max: "1fr" as `${number}fr` }));
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
  /** Resolved `letter-spacing` in px (em is relative to this node's font). */
  letterSpacing?: number;
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
    const fontSize = cssLengthToPx(inheritedTextProp(node, "fontSize")) ?? 16;
    const fontWeight = inheritedTextProp(node, "fontWeight") || "normal";
    const fontFamily = inheritedTextProp(node, "fontFamily") || "system-ui, sans-serif";
    const lineHeight = cssLineHeightToPx(inheritedTextProp(node, "lineHeight"), fontSize) ?? fontSize * 1.2;

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
        : maxLines !== undefined ? "ellipsis" : undefined;

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
      letterSpacing: cssLengthToPxForFont(props.letterSpacing, fontSize) ?? 0,
    };

    return tree.newLeafWithContext(style, ctx);
  }

  // Image leaves with aspect-ratio: contribute height = stretched-width /
  // aspectRatio to grid/flex track sizing via the measure callback. The
  // `style.aspectRatio` alone isn't enough — Taffy's grid auto-row pass asks
  // for the leaf's max-content height, which for an image with no fixed
  // height is 0; without the callback the row collapses.
  if (node.type.toLowerCase() === "image" && node.children.length === 0) {
    const src = props.src ?? props[0];
    const ar = props.aspectRatio !== undefined
      ? parseAspectRatio(props.aspectRatio)
      : typeof src === "string"
        ? getImageNaturalAspect(src)
        : null;
    if (ar !== null) {
      const ictx: ImageAspectMeasureContext = { aspectRatio: ar };
      return tree.newLeafWithContext(style, ictx);
    }
  }

  // Video leaves always carry an aspect measure context: unlike Image there
  // is always a defined intrinsic aspect (natural once metadata arrives,
  // 16:9 before), so a Video with no fixed height still contributes a
  // sensible max-content height to flex/grid track sizing.
  //
  // A Video is a leaf here even when it HAS children: v2 composition slots
  // are overlays, not flow content, so they must not feed the player's own
  // sizing. `layoutVideoSlots` places them after the main pass.
  if (isVideoNode(node)) {
    const ar =
      props.aspectRatio !== undefined
        ? parseAspectRatio(props.aspectRatio)
        : null;
    const ictx: ImageAspectMeasureContext = {
      aspectRatio: ar ?? getVideoIntrinsicAspect(node.id, props),
    };
    return tree.newLeafWithContext(style, ictx);
  }

  // Select options are semantic data for the control, not painted/layout
  // descendants. Treat Select as one intrinsic-height form-control leaf.
  if (node.type.toLowerCase() === "select") {
    return tree.newLeaf(style);
  }

  // A Chart is a leaf too: its children are marks positioned in DATA units
  // against the resolved plot rect, so they must not feed (or be sized by)
  // the flex/grid pass. `layoutCharts` places them once the chart's own box
  // is known — the same two-phase shape a Video's composition slots use.
  if (isChartNode(node)) {
    return tree.newLeaf(style);
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

  const borderColor = resolvedBorderColor(node.props);
  const borderRadius = resolvedBorderRadius(node.props);
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

  // A Video was built as a leaf (see buildTree) — its children are slot
  // overlays with no Taffy nodes; `layoutVideoSlots` places them.
  if (isVideoNode(node) || isChartNode(node) || node.type.toLowerCase() === "select") return;

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
    const childType = child.type.toLowerCase();
    if ((childType !== "image" && childType !== "video") || !child.layout) continue;
    const ar =
      child.props.aspectRatio !== undefined
        ? parseAspectRatio(child.props.aspectRatio)
        : typeof (child.props.src ?? child.props[0]) === "string"
          ? getImageNaturalAspect(child.props.src ?? child.props[0])
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
  pinRoot: boolean = true,
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
    const rootWidth = axisSizeValue(rootProps, "width");
    const rootHeight = axisSizeValue(rootProps, "height");
    const rootHasExplicitWidth = rootWidth !== undefined && rootWidth !== null;
    const rootHasExplicitHeight = rootHeight !== undefined && rootHeight !== null;
    if (pinRoot && (!rootHasExplicitWidth || !rootHasExplicitHeight)) {
      const rootStyle = tree.getStyle(rootId);
      rootStyle.size = {
        width: rootHasExplicitWidth
          ? cssLengthToDimension(rootWidth)
          : availableWidth,
        height: rootHasExplicitHeight
          ? cssLengthToDimension(rootHeight)
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
          letterSpacing: tctx.letterSpacing,
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
  // Publish the canvas size as the viewport basis so `vw`/`vh` units resolve
  // for the whole pass (Tailwind's `h-screen` → `100vh`). This MUST happen
  // before any style is built — see `setCssViewport`.
  setCssViewport(availableWidth, availableHeight);

  if (layoutBackend === "auto" && taffyReady && taffy) {
    calcNeedsSecondPass = false;
    computeLayoutTaffy(ctx, node, availableWidth, availableHeight, x, y);
    // A mixed `calc(100% - 40px)` needs the parent's computed content box,
    // which only exists after a first pass. Re-run once so it resolves.
    if (calcNeedsSecondPass) {
      calcNeedsSecondPass = false;
      computeLayoutTaffy(ctx, node, availableWidth, availableHeight, x, y);
    }
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

  // Video composition slots are laid out against the finished player rect.
  layoutVideoSlots(ctx, node);

  // Chart marks are laid out against the finished chart rect, for the same
  // reason: the chart owns their positions, in data units.
  layoutCharts(node, (child, maxWidth, maxHeight, cx, cy) =>
    layoutSubtreeIntrinsic(ctx, child, maxWidth, maxHeight, cx, cy),
  );
}

/**
 * Lay a subtree out at its INTRINSIC size inside `maxWidth`/`maxHeight`,
 * rooted at `(x, y)` — the root is not pinned to the available box, so a
 * Marker's tooltip card is as wide as its content rather than as wide as
 * the plot. Used by the chart layout pass; every other caller wants the
 * pinned form (`computeLayout`).
 */
function layoutSubtreeIntrinsic(
  ctx: CanvasRenderingContext2D,
  node: VirtualNode,
  maxWidth: number,
  maxHeight: number,
  x: number,
  y: number,
): void {
  if (layoutBackend === "auto" && taffyReady && taffy) {
    computeLayoutTaffy(ctx, node, maxWidth, maxHeight, x, y, /* pinRoot */ false);
  } else {
    computeLayoutFallback(ctx, node, maxWidth, maxHeight, x, y, /* pinRoot */ false);
  }
}

/**
 * Place every Video's `.slot(name)` children as full-bleed overlays of the
 * player's rect (hypen-docs/content/docs/guide/components.mdx §Composition slots: "Renderers
 * overlay slot content on the video surface, full-bleed, in slot order").
 *
 * Each slot subtree is laid out in its own pass with the video rect as its
 * containing block, so a slot root with no declared size fills the player
 * exactly (the same root pin both backends apply to a canvas root) while a
 * slot root that declares `.width/.height` keeps them. Slots overlap — they
 * are stacked in declaration order, painted back-to-front by `paintNode`.
 *
 * Untagged children of a Video are invalid per the contract: they get a
 * zero box (and never paint), rather than corrupting the player's flow.
 */
function layoutVideoSlots(ctx: CanvasRenderingContext2D, node: VirtualNode): void {
  if (isVideoNode(node) && node.children.length > 0 && node.layout) {
    const rect = node.layout;
    for (const child of node.children) {
      if (videoSlotName(child) === null || isLayoutHidden(child)) {
        zeroLayoutSubtree(child, rect.x, rect.y);
        continue;
      }
      if (layoutBackend === "auto" && taffyReady && taffy) {
        computeLayoutTaffy(ctx, child, rect.width, rect.height, rect.x, rect.y);
      } else {
        computeLayoutFallback(ctx, child, rect.width, rect.height, rect.x, rect.y);
      }
    }
  }
  for (const child of node.children) {
    layoutVideoSlots(ctx, child);
  }
}

/** Collapse a subtree to a zero box at `(x, y)` — laid out, never painted. */
function zeroLayoutSubtree(node: VirtualNode, x: number, y: number): void {
  node.layout = {
    x,
    y,
    width: 0,
    height: 0,
    margin: { top: 0, right: 0, bottom: 0, left: 0 },
    padding: { top: 0, right: 0, bottom: 0, left: 0 },
    border: { width: 0, color: "transparent", radius: 0 },
    contentX: 0,
    contentY: 0,
    contentWidth: 0,
    contentHeight: 0,
  };
  for (const child of node.children) zeroLayoutSubtree(child, x, y);
}

// ---------------------------------------------------------------------------
// Fallback: JS flexbox implementation
// ---------------------------------------------------------------------------
//
// Used whenever the Taffy WASM module is unavailable. That is NOT a rare
// edge case: the browser build resolves the WASM over the network, so any
// deployment that doesn't serve `taffy_wasm_bg.wasm` (or has no CDN reach)
// runs the whole page through this code. It therefore implements a real
// two-phase flex algorithm rather than the old single-pass approximation:
//
//   measure(node, avail)  -> the node's outer border-box size, no positions
//   place(node, x, y, w, h) -> writes `node.layout` and recurses
//
// The old implementation measured a child by *laying it out* at the origin
// and only afterwards moved the child itself — so grandchildren kept
// coordinates relative to (0,0) and every nested subtree painted in the top
// band of the canvas. Splitting measurement from placement is what fixes it:
// a node is positioned before its children are ever placed.

/** Per-pass memo of `measureFallback` results (cleared on every root call). */
let fallbackMeasureCache: WeakMap<VirtualNode, Map<string, FallbackSize>> | null = null;

interface FallbackSize {
  width: number;
  height: number;
}

/** Resolved box model (margin/padding/border) for a node. */
interface FallbackBox {
  margin: BoxSpacing;
  padding: BoxSpacing;
  border: number;
}

function readMarginFallback(props: Record<string, any>): BoxSpacing {
  const m = parseSpacing(props.margin || 0);
  if (props.marginHorizontal !== undefined) {
    m.left = cssLengthToPx(props.marginHorizontal) ?? 0;
    m.right = cssLengthToPx(props.marginHorizontal) ?? 0;
  }
  if (props.marginVertical !== undefined) {
    m.top = cssLengthToPx(props.marginVertical) ?? 0;
    m.bottom = cssLengthToPx(props.marginVertical) ?? 0;
  }
  if (props.marginTop !== undefined) m.top = cssLengthToPx(props.marginTop) ?? 0;
  if (props.marginRight !== undefined) m.right = cssLengthToPx(props.marginRight) ?? 0;
  if (props.marginBottom !== undefined) m.bottom = cssLengthToPx(props.marginBottom) ?? 0;
  if (props.marginLeft !== undefined) m.left = cssLengthToPx(props.marginLeft) ?? 0;
  return m;
}

function readPaddingFallback(props: Record<string, any>, type: string): BoxSpacing {
  const p = parseSpacing(basePaddingValue(props, type));
  if (props.paddingHorizontal !== undefined) {
    p.left = cssLengthToPx(props.paddingHorizontal) ?? 0;
    p.right = cssLengthToPx(props.paddingHorizontal) ?? 0;
  }
  if (props.paddingVertical !== undefined) {
    p.top = cssLengthToPx(props.paddingVertical) ?? 0;
    p.bottom = cssLengthToPx(props.paddingVertical) ?? 0;
  }
  if (props.paddingTop !== undefined) p.top = cssLengthToPx(props.paddingTop) ?? 0;
  if (props.paddingRight !== undefined) p.right = cssLengthToPx(props.paddingRight) ?? 0;
  if (props.paddingBottom !== undefined) p.bottom = cssLengthToPx(props.paddingBottom) ?? 0;
  if (props.paddingLeft !== undefined) p.left = cssLengthToPx(props.paddingLeft) ?? 0;
  if (type === "safearea") addSafeAreaPadding(p, props);
  return p;
}

function readBoxFallback(props: Record<string, any>, type: string): FallbackBox {
  return {
    margin: readMarginFallback(props),
    padding: readPaddingFallback(props, type),
    border: resolvedBorderWidth(props),
  };
}

/**
 * Resolve a declared length against its containing-block size.
 * Handles px/rem/pt, viewport units (`h-screen` → `100vh`), percentages
 * (`w-full` → `100%`) and `calc(100% - 40px)`. Returns null for `auto`.
 */
function resolveLenFallback(value: any, basis: number | null): number | null {
  if (value === undefined || value === null) return null;
  return cssLengthToPxWithBasis(value, basis);
}

/** Clamp a resolved size by the node's min/max props on one axis. */
function clampSizeFallback(
  size: number,
  props: Record<string, any>,
  axis: "width" | "height",
  basis: number | null,
): number {
  const min = resolveLenFallback(axis === "width" ? props.minWidth : props.minHeight, basis);
  const max = resolveLenFallback(axis === "width" ? props.maxWidth : props.maxHeight, basis);
  let out = size;
  if (min !== null) out = Math.max(out, min);
  if (max !== null) out = Math.min(out, max);
  return Math.max(0, out);
}

/**
 * Component types with an intrinsic size, mirroring the Taffy path's table.
 * Returns the default outer size for the axes the caller hasn't pinned.
 */
function intrinsicSizeFallback(
  node: VirtualNode,
  availW: number,
  availH: number,
): { width: number | null; height: number | null } {
  const props = node.props;
  const type = node.type.toLowerCase();
  switch (type) {
    case "app":
    case "safearea":
      return { width: availW, height: availH };
    case "spacer":
      return { width: null, height: null };
    case "divider": {
      const thickness = cssLengthToPx(props.thickness) ?? 1;
      return props.orientation === "vertical"
        ? { width: thickness, height: availH }
        : { width: availW, height: thickness };
    }
    case "checkbox":
    case "radio": {
      const sz = cssLengthToPx(props.size) ?? 20;
      return { width: sz, height: sz };
    }
    case "switch":
      return { width: 44, height: 24 };
    case "slider":
      return { width: 200, height: 20 };
    case "scrubber":
      return { width: 200, height: 20 };
    case "progressbar":
      return { width: 200, height: 8 };
    case "spinner": {
      const sz = cssLengthToPx(props.size) ?? 24;
      return { width: sz, height: sz };
    }
    case "avatar": {
      const sz = cssLengthToPx(props.size) ?? 40;
      return { width: sz, height: sz };
    }
    case "audio":
      return { width: 300, height: 54 };
    case "chart":
      // Fills the available width, intrinsic 200 tall — the DOM host's
      // `width: 100%; height: 200px`.
      return { width: availW, height: CHART_DEFAULTS.height };
    case "icon": {
      const sz = cssLengthToPx(props.size) ?? 24;
      return { width: sz, height: sz };
    }
    default:
      return { width: null, height: null };
  }
}

/**
 * The aspect ratio a node's box should honour: the explicit `aspect-ratio`
 * prop (Tailwind `aspect-video` / `aspect-[2/3]`) first, then an Image's
 * decoded natural aspect, then a Video's intrinsic aspect (always defined).
 */
function aspectRatioFallback(node: VirtualNode): number | null {
  const props = node.props;
  if (props.aspectRatio !== undefined) {
    const ar = parseAspectRatio(props.aspectRatio);
    if (ar !== null) return ar;
  }
  const type = node.type.toLowerCase();
  if (type === "image") {
    const src = props.src ?? props[0];
    if (typeof src === "string") return getImageNaturalAspect(src);
    return null;
  }
  if (type === "video") return getVideoIntrinsicAspect(node.id, props);
  return null;
}

/** Text-measurement inputs shared by the measure and paint-adjacent paths. */
function textMetricsFallback(
  ctx: CanvasRenderingContext2D,
  node: VirtualNode,
  maxWidth: number | undefined,
) {
  const props = node.props;
  const fontSize = cssLengthToPx(inheritedTextProp(node, "fontSize")) ?? 16;
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
  return measureText(
    ctx,
    String(props[0] ?? props.text ?? ""),
    {
      fontSize,
      fontWeight: inheritedTextProp(node, "fontWeight") || "normal",
      fontFamily: inheritedTextProp(node, "fontFamily") || "system-ui, sans-serif",
      lineHeight: cssLineHeightToPx(inheritedTextProp(node, "lineHeight"), fontSize) ?? fontSize * 1.2,
      letterSpacing: cssLengthToPxForFont(props.letterSpacing, fontSize) ?? 0,
    },
    maxWidth,
    maxLines,
    textOverflow,
  );
}

/**
 * Measure a node's OUTER border-box (margins excluded) given the space its
 * containing block offers.
 *
 * `fillW` / `fillH` request the CSS `stretch` behaviour on that axis: an
 * auto-sized node takes the whole available extent instead of shrinking to
 * its content. Flex containers pass `fillW` for a stretched cross axis and
 * the root call passes both.
 *
 * `pinnedW` lets a caller resolve the cross axis first (a Column stretches
 * its children's width, and the width is what decides how the text wraps and
 * therefore how tall the child ends up).
 */
function measureFallback(
  ctx: CanvasRenderingContext2D,
  node: VirtualNode,
  availW: number,
  availH: number,
  fillW: boolean,
  fillH: boolean,
  pinnedW?: number,
): FallbackSize {
  if (isLayoutHidden(node)) return { width: 0, height: 0 };

  const cacheKey = `${availW}|${availH}|${fillW ? 1 : 0}|${fillH ? 1 : 0}|${pinnedW ?? ""}`;
  let perNode = fallbackMeasureCache?.get(node);
  const hit = perNode?.get(cacheKey);
  if (hit) return hit;

  const props = node.props;
  const type = node.type.toLowerCase();
  const box = readBoxFallback(props, type);
  const insetW = box.padding.left + box.padding.right + box.border * 2;
  const insetH = box.padding.top + box.padding.bottom + box.border * 2;

  let width = resolveLenFallback(axisSizeValue(props, "width"), availW);
  let height = resolveLenFallback(axisSizeValue(props, "height"), availH);
  if (width === null && pinnedW !== undefined) width = pinnedW;

  const intrinsic = intrinsicSizeFallback(node, availW, availH);
  if (width === null && intrinsic.width !== null) width = intrinsic.width;
  if (height === null && intrinsic.height !== null) height = intrinsic.height;

  // Form controls collapse to padding without an intrinsic line box.
  if (
    height === null &&
    (type === "input" || type === "textarea" || type === "select")
  ) {
    const fontSize = cssLengthToPx(props.fontSize) ?? 16;
    const lineHeight = cssLineHeightToPx(props.lineHeight, fontSize) ?? fontSize * 1.5;
    const rows = type === "textarea" ? Math.max(1, Number(props.rows) || 3) : 1;
    height = lineHeight * rows + insetH;
  }

  // Aspect ratio derives the missing axis from the known one.
  const aspect = aspectRatioFallback(node);
  if (aspect !== null && aspect > 0) {
    if (width !== null && height === null) height = width / aspect;
    else if (height !== null && width === null) width = height * aspect;
  }

  if (type === "text" && node.children.length === 0) {
    const maxWidth =
      width !== null
        ? width - insetW
        : fillW
          ? availW - insetW
          : Math.max(0, availW - insetW);
    const metrics = textMetricsFallback(ctx, node, maxWidth);
    if (width === null) width = Math.ceil(metrics.width) + insetW;
    if (height === null) height = Math.ceil(metrics.height) + insetH;
  }

  // A Video's children are slot overlays, never flow content — they must
  // not contribute to the player's measured size (see layoutVideoSlots).
  if (
    (width === null || height === null) &&
    node.children.length > 0 &&
    type !== "video" &&
    type !== "chart"
  ) {
    // Content size from the children's flow. The cross axis is measured
    // first when it is already known, so text wraps against the real width.
    const innerAvailW = (width !== null ? width : fillW ? availW : availW) - insetW;
    const innerAvailH = (height !== null ? height : availH) - insetH;
    const content = measureChildrenFallback(
      ctx,
      node,
      Math.max(0, innerAvailW),
      Math.max(0, innerAvailH),
      width !== null || fillW,
    );
    if (width === null) {
      // CSS shrink-to-fit: an auto-width box is `min(max-content, available)`,
      // not max-content. Without the cap, a `max-w-[1200] self-center` hero
      // card measured at its (much wider) max-content and overhung both page
      // edges once the viewport dropped below that width. A container that
      // scrolls horizontally is exempt — overflowing is the whole point.
      width = content.width + insetW;
      if (!readScrollAxes(props).x) width = Math.min(width, availW);
    }
    if (height === null) height = content.height + insetH;
  }

  if (width === null) width = fillW ? availW : 0;
  if (height === null) height = fillH ? availH : 0;

  // Re-apply the aspect ratio when only one axis came from content.
  if (aspect !== null && aspect > 0 && props.aspectRatio !== undefined) {
    if (resolveLenFallback(props.height, availH) === null) height = width / aspect;
  }

  width = clampSizeFallback(width, props, "width", availW);
  height = clampSizeFallback(height, props, "height", availH);

  const result: FallbackSize = { width, height };
  if (fallbackMeasureCache) {
    if (!perNode) {
      perNode = new Map();
      fallbackMeasureCache.set(node, perNode);
    }
    perNode.set(cacheKey, result);
  }
  return result;
}

/**
 * Intrinsic content size of a container's children laid out in flow — the
 * measurement counterpart of {@link placeChildrenFallback}. Absolutely
 * positioned children are out of flow and contribute nothing.
 */
function measureChildrenFallback(
  ctx: CanvasRenderingContext2D,
  node: VirtualNode,
  innerW: number,
  innerH: number,
  crossKnown: boolean,
): FallbackSize {
  const type = node.type.toLowerCase();
  const isStack = type === "stack";
  const isCol = isColumnFlow(node);
  const gap = mainAxisGap(node.props, isCol);

  let main = 0;
  let cross = 0;
  let count = 0;

  for (const child of node.children) {
    if (isLayoutHidden(child)) continue;
    if (child.props.position === "absolute") continue;
    const m = readMarginFallback(child.props);
    // In a column the child's width is the cross axis: when the container's
    // own width is already known, stretch the child into it so its text
    // wraps exactly as it will when placed.
    const stretchCross = isCol && crossKnown && childAlign(node, child, isCol) === "stretch";
    const size = measureFallback(
      ctx,
      child,
      Math.max(0, innerW - m.left - m.right),
      Math.max(0, innerH - m.top - m.bottom),
      stretchCross,
      false,
    );
    const outerW = size.width + m.left + m.right;
    const outerH = size.height + m.top + m.bottom;
    if (isStack) {
      main = Math.max(main, isCol ? outerH : outerW);
      cross = Math.max(cross, isCol ? outerW : outerH);
    } else if (isCol) {
      main += outerH;
      cross = Math.max(cross, outerW);
    } else {
      main += outerW;
      cross = Math.max(cross, outerH);
    }
    count++;
  }

  if (!isStack && count > 1) main += gap * (count - 1);

  return isCol ? { width: cross, height: main } : { width: main, height: cross };
}

/**
 * The effective cross-axis alignment for one child: `align-self` overrides
 * the container's `align-items`, and the Hypen-native
 * `horizontalAlignment` / `verticalAlignment` props alias `align-items` on
 * the cross axis. Defaults mirror the DOM handlers: both Column and Row keep
 * intrinsic child cross sizes; expansion is explicit.
 */
function childAlign(parent: VirtualNode, child: VirtualNode, isCol: boolean): string {
  const selfRaw = child.props.alignSelf;
  if (selfRaw !== undefined && selfRaw !== "auto") return normalizeAlign(String(selfRaw));
  if (isCol && needsAutomaticCrossAxisStretch(child)) return "stretch";
  if (child.type.toLowerCase() === "badge") return "flex-start";
  const props = parent.props;
  if (parent.type.toLowerCase() === "center") return "center";
  const raw = isCol
    ? (props.horizontalAlignment || props.alignItems)
    : (props.verticalAlignment || props.alignItems);
  if (raw) return normalizeAlign(String(raw));
  return "flex-start";
}

/** Fold the `start`/`flex-start` and `end`/`flex-end` spellings together. */
function normalizeAlign(value: string): string {
  switch (value) {
    case "start": case "flex-start": case "self-start": return "flex-start";
    case "end": case "flex-end": case "self-end": return "flex-end";
    default: return value;
  }
}

/** Same folding for justify-content, including the space-* keywords. */
function normalizeJustify(value: string): string {
  // Engine applicator values use camelCase (`spaceBetween`) while Tailwind
  // and CSS use kebab-case (`space-between`). Accept both spellings so the
  // production Taffy path and the JS fallback distribute free space alike.
  const canonical = value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();
  switch (canonical) {
    case "start": case "flex-start": return "flex-start";
    case "end": case "flex-end": return "flex-end";
    default: return canonical;
  }
}

/**
 * Write `node.layout` for an already-sized, already-positioned box and lay
 * out its children inside it. `x`/`y` are the absolute top-left of the
 * border box (margins already applied by the caller).
 */
function placeFallback(
  ctx: CanvasRenderingContext2D,
  node: VirtualNode,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const props = node.props;
  const box = readBoxFallback(props, node.type.toLowerCase());
  const borderWidth = box.border;

  node.layout = {
    x,
    y,
    width,
    height,
    margin: box.margin,
    padding: box.padding,
    border: {
      width: borderWidth,
      color: resolvedBorderColor(props),
      radius: resolvedBorderRadius(props),
    },
    contentX: box.padding.left + borderWidth,
    contentY: box.padding.top + borderWidth,
    contentWidth: Math.max(0, width - box.padding.left - box.padding.right - borderWidth * 2),
    contentHeight: Math.max(0, height - box.padding.top - box.padding.bottom - borderWidth * 2),
  };

  if (isLayoutHidden(node)) return;
  // Video slot children are placed by `layoutVideoSlots` against the
  // player's own rect, which only exists once this node is placed.
  if (isVideoNode(node)) return;
  // Chart marks are likewise placed later, against the resolved plot rect.
  if (isChartNode(node)) return;
  if (node.children.length > 0) placeChildrenFallback(ctx, node);
}

/**
 * Flex the children of `parent` into its content box and place each one.
 *
 * Implements the parts of the flex algorithm the Hypen DSL actually reaches:
 * `flex`/`flexGrow`/`flexShrink`/`flexBasis`, `gap`, `justify-content`,
 * `align-items`, `align-self`, min/max clamping and percentage/`calc` sizes.
 * A container that scrolls along its main axis never shrinks its children —
 * that is what makes a `.scrollable("horizontal")` poster rail overflow
 * instead of squeezing eight posters into the viewport width.
 */
function placeChildrenFallback(ctx: CanvasRenderingContext2D, parent: VirtualNode): void {
  const layout = parent.layout!;
  const props = parent.props;
  const originX = layout.x + layout.contentX;
  const originY = layout.y + layout.contentY;
  const contentW = layout.contentWidth;
  const contentH = layout.contentHeight;

  const inFlow = parent.children.filter(
    (c) => !isLayoutHidden(c) && c.props.position !== "absolute",
  );

  if (parent.type.toLowerCase() === "stack") {
    placeStackChildrenFallback(ctx, parent, inFlow);
  } else if (inFlow.length > 0) {
    const isCol = isColumnFlow(parent);
    const gap = mainAxisGap(props, isCol);
    const availMain = isCol ? contentH : contentW;
    const availCross = isCol ? contentW : contentH;
    const scrollAxes = readScrollAxes(props);
    const mainScrolls = isCol ? scrollAxes.y : scrollAxes.x;

    const justify = normalizeJustify(
      String(
        parent.type.toLowerCase() === "center"
          ? "center"
          : (isCol
          ? props.verticalAlignment || props.justifyContent
          : props.horizontalAlignment || props.justifyContent) || "flex-start",
      ),
    );

    interface Item {
      child: VirtualNode;
      margin: BoxSpacing;
      grow: number;
      shrink: number;
      main: number;
      cross: number;
      align: string;
      crossIsExplicit: boolean;
    }

    const items: Item[] = [];
    for (const child of inFlow) {
      const cp = child.props;
      const margin = readMarginFallback(cp);
      const mainMargin = isCol ? margin.top + margin.bottom : margin.left + margin.right;
      const crossMargin = isCol ? margin.left + margin.right : margin.top + margin.bottom;
      const align = childAlign(parent, child, isCol);
      const childAvailMain = Math.max(0, availMain - mainMargin);
      const childAvailCross = Math.max(0, availCross - crossMargin);

      // Cross axis first: it decides how text wraps, hence the main size.
      const crossProp = axisSizeValue(cp, isCol ? "width" : "height");
      const crossBasis = isCol ? availCross : availCross;
      let cross = resolveLenFallback(crossProp, crossBasis);
      const crossIsExplicit = cross !== null;
      if (cross === null && align === "stretch") cross = childAvailCross;

      const measured = measureFallback(
        ctx,
        child,
        isCol ? (cross ?? childAvailCross) : childAvailMain,
        isCol ? childAvailMain : (cross ?? childAvailCross),
        isCol ? align === "stretch" : false,
        false,
        isCol && cross !== null ? cross : undefined,
      );
      if (cross === null) cross = isCol ? measured.width : measured.height;

      // Main axis: explicit size, else flex-basis, else content.
      const flexValue = cp.flex ?? cp.weight;
      const flexShorthand = flexValue !== undefined ? parseFloat(flexValue) : NaN;
      const childType = child.type.toLowerCase();
      let main = resolveLenFallback(
        axisSizeValue(cp, isCol ? "height" : "width"),
        availMain,
      );
      if (main === null && cp.flexBasis !== undefined) {
        main = resolveLenFallback(cp.flexBasis, availMain);
      }
      if (main === null && (Number.isFinite(flexShorthand) || childType === "spacer")) {
        // `flex: N` is `N N 0%` — start from zero and grow up, matching the
        // Taffy path (and CSS). Without the zero basis a `flex-1` sibling
        // starts at its content size and steals the container's free space.
        main = 0;
      }
      if (main === null) main = isCol ? measured.height : measured.width;

      const grow = childType === "spacer"
        ? 1
        : parseFloat(cp.flexGrow) || (Number.isFinite(flexShorthand) ? flexShorthand : 0);
      const defaultShrink = INTRINSIC_SIZED.has(childType) || mainScrolls ? 0 : 1;
      const shrink = cp.flexShrink !== undefined ? parseFloat(cp.flexShrink) : defaultShrink;

      items.push({
        child,
        margin,
        grow: Number.isFinite(grow) ? grow : 0,
        shrink: Number.isFinite(shrink) ? shrink : defaultShrink,
        main,
        cross,
        align,
        crossIsExplicit,
      });
    }

    // --- Resolve flexible lengths -------------------------------------------
    const totalGap = gap * Math.max(0, items.length - 1);
    let usedMain = totalGap;
    for (const it of items) {
      usedMain += it.main + (isCol ? it.margin.top + it.margin.bottom : it.margin.left + it.margin.right);
    }
    let free = availMain - usedMain;

    if (free > 0) {
      const totalGrow = items.reduce((s, it) => s + it.grow, 0);
      if (totalGrow > 0) {
        for (const it of items) {
          if (it.grow > 0) it.main += (free * it.grow) / totalGrow;
        }
        free = 0;
      }
    } else if (free < 0) {
      const weighted = items.reduce((s, it) => s + it.shrink * it.main, 0);
      if (weighted > 0) {
        const deficit = -free;
        for (const it of items) {
          if (it.shrink <= 0) continue;
          const share = (deficit * it.shrink * it.main) / weighted;
          it.main = Math.max(0, it.main - share);
        }
      }
    }

    // Clamp against min/max, then let the cross axis follow the new main
    // size for content-sized items (a Text that grew wider wraps to fewer
    // lines, so its height must be re-measured).
    for (const it of items) {
      const cp = it.child.props;
      it.main = clampSizeFallback(it.main, cp, isCol ? "height" : "width", availMain);
      if (!it.crossIsExplicit && it.align !== "stretch") {
        const remeasured = measureFallback(
          ctx,
          it.child,
          isCol ? it.cross : it.main,
          isCol ? it.main : availCross,
          false,
          false,
          isCol ? it.cross : it.main,
        );
        it.cross = isCol ? remeasured.width : remeasured.height;
      }
      it.cross = clampSizeFallback(it.cross, cp, isCol ? "width" : "height", availCross);
    }

    // --- Distribute along the main axis --------------------------------------
    let usedAfterFlex = totalGap;
    for (const it of items) {
      usedAfterFlex += it.main + (isCol ? it.margin.top + it.margin.bottom : it.margin.left + it.margin.right);
    }
    const remaining = availMain - usedAfterFlex;

    let mainCursor = 0;
    let between = 0;
    if (remaining > 0) {
      if (justify === "center") mainCursor = remaining / 2;
      else if (justify === "flex-end") mainCursor = remaining;
      else if (justify === "space-between" && items.length > 1) between = remaining / (items.length - 1);
      else if (justify === "space-around" && items.length > 0) {
        between = remaining / items.length;
        mainCursor = between / 2;
      } else if (justify === "space-evenly" && items.length > 0) {
        between = remaining / (items.length + 1);
        mainCursor = between;
      }
    }

    for (const it of items) {
      const m = it.margin;
      const mainStart = mainCursor + (isCol ? m.top : m.left);

      let crossStart = isCol ? m.left : m.top;
      const crossMargin = isCol ? m.left + m.right : m.top + m.bottom;
      const slack = availCross - it.cross - crossMargin;
      if (it.align === "center") crossStart += slack / 2;
      else if (it.align === "flex-end") crossStart += slack;

      const cx = isCol ? originX + crossStart : originX + mainStart;
      const cy = isCol ? originY + mainStart : originY + crossStart;
      const w = isCol ? it.cross : it.main;
      const h = isCol ? it.main : it.cross;

      placeFallback(ctx, it.child, cx, cy, w, h);

      mainCursor += (isCol ? it.main + m.top + m.bottom : it.main + m.left + m.right) + gap + between;
    }
  }

  // --- Absolutely positioned children ---------------------------------------
  for (const child of parent.children) {
    if (isLayoutHidden(child)) {
      placeFallback(ctx, child, originX, originY, 0, 0);
      continue;
    }
    if (child.props.position !== "absolute") continue;
    placeAbsoluteFallback(ctx, child, originX, originY, contentW, contentH);
  }
}

/** Stack (ZStack): every child shares the same content box. */
function placeStackChildrenFallback(
  ctx: CanvasRenderingContext2D,
  parent: VirtualNode,
  inFlow: VirtualNode[],
): void {
  const layout = parent.layout!;
  const originX = layout.x + layout.contentX;
  const originY = layout.y + layout.contentY;
  const availW = layout.contentWidth;
  const availH = layout.contentHeight;
  const hAlign = normalizeAlign(String(parent.props.horizontalAlignment || "flex-start"));
  const vAlign = normalizeAlign(String(parent.props.verticalAlignment || "flex-start"));

  for (const child of inFlow) {
    const m = readMarginFallback(child.props);
    const size = measureFallback(
      ctx,
      child,
      Math.max(0, availW - m.left - m.right),
      Math.max(0, availH - m.top - m.bottom),
      false,
      false,
    );
    let dx = m.left;
    let dy = m.top;
    if (hAlign === "center") dx += (availW - size.width - m.left - m.right) / 2;
    else if (hAlign === "flex-end") dx += availW - size.width - m.left - m.right;
    if (vAlign === "center") dy += (availH - size.height - m.top - m.bottom) / 2;
    else if (vAlign === "flex-end") dy += availH - size.height - m.top - m.bottom;
    placeFallback(ctx, child, originX + dx, originY + dy, size.width, size.height);
  }
}

/**
 * `position: absolute` child, resolved against the parent's content box.
 * Opposite insets pin both edges (and therefore the size); a single inset
 * anchors that edge and lets the measured size decide the other.
 */
function placeAbsoluteFallback(
  ctx: CanvasRenderingContext2D,
  child: VirtualNode,
  originX: number,
  originY: number,
  contentW: number,
  contentH: number,
): void {
  const cp = child.props;
  const left = resolveLenFallback(cp.left, contentW);
  const right = resolveLenFallback(cp.right, contentW);
  const top = resolveLenFallback(cp.top, contentH);
  const bottom = resolveLenFallback(cp.bottom, contentH);

  const measured = measureFallback(ctx, child, contentW, contentH, false, false);
  let width = resolveLenFallback(axisSizeValue(cp, "width"), contentW);
  let height = resolveLenFallback(axisSizeValue(cp, "height"), contentH);
  if (width === null) {
    width = left !== null && right !== null ? Math.max(0, contentW - left - right) : measured.width;
  }
  if (height === null) {
    height = top !== null && bottom !== null ? Math.max(0, contentH - top - bottom) : measured.height;
  }

  const x = left !== null ? left : right !== null ? contentW - right - width : 0;
  const y = top !== null ? top : bottom !== null ? contentH - bottom - height : 0;
  placeFallback(ctx, child, originX + x, originY + y, width, height);
}

function computeLayoutFallback(
  ctx: CanvasRenderingContext2D,
  node: VirtualNode,
  availableWidth: number,
  availableHeight: number,
  x: number = 0,
  y: number = 0,
  pinRoot: boolean = true,
): void {
  fallbackMeasureCache = new WeakMap();
  try {
    const margin = readMarginFallback(node.props);
    const availW = Math.max(0, availableWidth - margin.left - margin.right);
    const availH = Math.max(0, availableHeight - margin.top - margin.bottom);
    // The root fills the canvas on both axes unless it declares a size —
    // the same pin the Taffy path applies to its root node.
    const size = measureFallback(ctx, node, availW, availH, pinRoot, pinRoot);
    placeFallback(ctx, node, x + margin.left, y + margin.top, size.width, size.height);
  } finally {
    fallbackMeasureCache = null;
  }
}
