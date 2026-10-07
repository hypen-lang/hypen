/**
 * Horizontal layout-demand propagation for the DOM renderer.
 *
 * Hypen's vertical containers are content-sized by default. That is useful
 * for raw content, but CSS cannot infer that an otherwise-unsized chain must
 * accept the finite width proposal when a descendant uses a percentage,
 * Row arrangement/flex, or a horizontal Divider. Native layout engines carry
 * that proposal through the chain automatically.
 *
 * Applicators leave durable dataset markers and the renderer reconciles them
 * after prop and tree mutations. The markers also survive template cloning.
 * Only a path containing explicit horizontal demand is stretched; raw
 * children and explicitly-sized components (notably Badge) stay intrinsic.
 */

type WidthSource = "width" | "size" | "fillMaxWidth" | "fillMaxSize";
type WidthKind = "fixed" | "relative";

const SOURCE_DATASET_KEYS: Record<WidthSource, string> = {
  width: "hypenWidthSourceWidth",
  size: "hypenWidthSourceSize",
  fillMaxWidth: "hypenWidthSourceFillMaxWidth",
  fillMaxSize: "hypenWidthSourceFillMaxSize",
};

const VERTICAL_CARRIERS = new Set(["column", "list"]);
const DEMAND_CARRIERS = new Set(["column", "list", "card"]);

function hypenType(element: HTMLElement): string {
  return element.dataset.hypenType?.toLowerCase() ?? "";
}

function isVerticalCarrier(element: HTMLElement): boolean {
  return VERTICAL_CARRIERS.has(hypenType(element));
}

function isDemandCarrier(element: HTMLElement): boolean {
  return DEMAND_CARRIERS.has(hypenType(element));
}

/**
 * `Array.from(el.children).some(pred)`, without touching `children` at all.
 *
 * The reconcile walk runs from every insert/move/remove up through every
 * ancestor, and a list container's children are exactly the rows being
 * inserted or removed — so on a 1,000-row create or clear the scan of the
 * container runs once per row. `Array.from` copied all ~1,000 children
 * before `.some` could stop at the first demanding row. An indexed loop
 * over the live `HTMLCollection` was no better: every insert or remove
 * invalidates the collection's cache, and its `length` is then recomputed
 * by walking every child — O(rows) per patch again (59 ms of replace-1k
 * in a CPU profile, for a scan that stops at the first row). Sibling
 * traversal is O(1) per step and O(1) total in the common case where the
 * first child already carries demand.
 */
function anyChild(element: HTMLElement, pred: (child: HTMLElement) => boolean): boolean {
  for (
    let child = element.firstElementChild as HTMLElement | null;
    child;
    child = child.nextElementSibling as HTMLElement | null
  ) {
    if (pred(child)) return true;
  }
  return false;
}

// Hoisted: `Object.values(SOURCE_DATASET_KEYS)` allocated a fresh array on
// every probe, and the reconcile walk probes several elements per patch.
const SOURCE_DATASET_KEY_LIST: readonly string[] = Object.values(SOURCE_DATASET_KEYS);

function effectiveWidthKind(element: HTMLElement): WidthKind | null {
  let hasFixed = false;
  for (const key of SOURCE_DATASET_KEY_LIST) {
    const kind = element.dataset[key] as WidthKind | undefined;
    if (kind === "relative") return "relative";
    if (kind === "fixed") hasFixed = true;
  }
  return hasFixed ? "fixed" : null;
}

/** Parent percentages (including calc expressions containing one) need a width proposal. */
export function widthKindForCssValue(value: string): WidthKind | null {
  if (/^(auto|fit-content|min-content|max-content)$/.test(value)) return null;
  return value.includes("%") ? "relative" : "fixed";
}

/** Record or clear one applicator's explicit width contribution. */
export function recordWidthSource(
  element: HTMLElement,
  source: WidthSource,
  kind: WidthKind | null,
): void {
  const key = SOURCE_DATASET_KEYS[source];
  if (kind === null) delete element.dataset[key];
  else element.dataset[key] = kind;
}

/** Mark whether this element consumes remaining horizontal Row space. */
export function recordHorizontalFlexDemand(element: HTMLElement, value: unknown): void {
  const numeric = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  if (Number.isFinite(numeric) && numeric > 0) element.dataset.hypenFlex = "true";
  else delete element.dataset.hypenFlex;
}

/** A real applicator is about to own align-self; keep its value on cleanup. */
export function releaseAutomaticStretchOwnership(element: HTMLElement): void {
  delete element.dataset.hypenAutoCrossAxisStretch;
}

function clearAutomaticStretch(element: HTMLElement): void {
  if (element.dataset.hypenAutoCrossAxisStretch !== "true") return;

  // A later explicit alignSelf owns the style. Forget our marker without
  // deleting the author's value.
  if (element.style.alignSelf === "stretch") {
    element.style.removeProperty("align-self");
  }
  delete element.dataset.hypenAutoCrossAxisStretch;
}

function applyAutomaticStretch(element: HTMLElement): void {
  const parent = element.parentNode;
  if (!(parent instanceof HTMLElement) || !isVerticalCarrier(parent)) {
    clearAutomaticStretch(element);
    return;
  }

  if (element.dataset.hypenAutoCrossAxisStretch === "true") {
    if (element.style.alignSelf !== "stretch") {
      delete element.dataset.hypenAutoCrossAxisStretch;
    }
    return;
  }

  // `align-self: stretch` keeps width:auto, so padding, borders and margins
  // are subtracted from the available width. This is important for an
  // indented Divider: width:100% + margin-left would overflow.
  if (!element.style.alignSelf) {
    element.style.alignSelf = "stretch";
    element.dataset.hypenAutoCrossAxisStretch = "true";
  }
}

function childCarriesDemand(child: HTMLElement): boolean {
  if (effectiveWidthKind(child) === "relative") return true;
  return child.dataset.hypenHorizontalWidthDemand === "true";
}

function rowHasDemand(row: HTMLElement): boolean {
  const arrangement = row.style.justifyContent;
  if (arrangement && arrangement !== "flex-start" && arrangement !== "start") return true;

  return anyChild(row, (child) =>
    child.dataset.hypenFlex === "true" || childCarriesDemand(child)
  );
}

function hasIntrinsicHorizontalDemand(element: HTMLElement): boolean {
  const type = hypenType(element);
  if (type === "row") return rowHasDemand(element);
  if (type === "divider") return element.dataset.hypenDividerOrientation !== "vertical";
  if (type === "grid") return true;
  if (type === "list") return true;
  return false;
}

/**
 * Recompute one element's marker and auto-stretch. Returns whether the
 * marker CHANGED — the only thing an ancestor's own recompute can observe.
 */
function reconcileElement(element: HTMLElement): boolean {
  const ownWidth = effectiveWidthKind(element);
  const intrinsicDemand = hasIntrinsicHorizontalDemand(element);
  const descendantDemand = isDemandCarrier(element) &&
    anyChild(element, childCarriesDemand);

  // A fixed width supplies the basis and ends propagation. A relative width
  // still asks its parent for a basis. Unsized carriers and demand sources
  // pass the request upward.
  const demandUp = ownWidth !== "fixed" &&
    (ownWidth === "relative" || intrinsicDemand || descendantDemand);

  // Relative-width elements already own a CSS width. Auto-stretch is for an
  // unsized source/carrier that needs the vertical parent proposal.
  if (ownWidth === null && (intrinsicDemand || descendantDemand)) {
    applyAutomaticStretch(element);
  } else {
    clearAutomaticStretch(element);
  }

  // Write-if-changed: re-setting a dataset attribute to its existing
  // value still fires a MutationObserver record and invalidates style.
  // This pass runs from every insert/move/remove up through the same
  // shared ancestors, so on a 1,000-row create the unconditional write
  // re-stamped the identical chain a thousand times — 4,000 observable
  // attribute mutations for zero information (7,000 on replace, 3,000
  // on clear), visible in the react-vs-hypen "DOM touched" counters.
  const marked = element.dataset.hypenHorizontalWidthDemand === "true";
  if (demandUp) {
    if (!marked) element.dataset.hypenHorizontalWidthDemand = "true";
  } else if (element.dataset.hypenHorizontalWidthDemand !== undefined) {
    delete element.dataset.hypenHorizontalWidthDemand;
  }
  return demandUp !== marked;
}

/**
 * Reconcile `element` and its HTMLElement ancestors. Call after relevant prop
 * changes and every insert/move/detach/remove. Walking from the mutation site
 * upward makes both demand addition and stale-marker removal deterministic.
 *
 * The walk stops at the first ancestor whose marker did not change: an
 * element's result depends only on its own props and its children's
 * markers/width props, so an unchanged child marker leaves every input of
 * every further ancestor untouched. The mutation site and its parent are
 * always recomputed — the parent's child set (insert/remove) or a child's
 * own width/flex props (prop change) can change without the child's marker
 * moving. Without the stop, every one of a 1,000-row list's inserts and
 * removes re-walked the same unchanged chain to the document root.
 */
export function reconcileColumnWidthDemandFrom(element: HTMLElement | null): void {
  let current: HTMLElement | null = element;
  let depth = 0;
  while (current) {
    const changed = reconcileElement(current);
    if (depth >= 1 && !changed) return;
    current = current.parentNode instanceof HTMLElement ? current.parentNode : null;
    depth++;
  }
}
