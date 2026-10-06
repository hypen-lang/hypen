/**
 * DOM Renderer
 *
 * Renders Hypen patches to the DOM
 */

import type { Patch, TemplateSkeletonNode } from "@hypen-space/core/types";
import { TemplateExpander } from "@hypen-space/core/patch-expand";
import type { HypenModuleInstance } from "@hypen-space/core/app";
import type { HypenRouter } from "@hypen-space/core/router";
import type { HypenGlobalContext } from "@hypen-space/core/context";
import { frameworkLoggers, isDebugMode } from "@hypen-space/core/logger";

const log = frameworkLoggers.renderer;

/** A compiled piece of a text template: literal text, or an `@{...}` binding. */
type TemplateSegment = string | { match: string; keys: string[] };

interface TextBinding {
  element: HTMLElement;
  template: string;
  segments: TemplateSegment[];
}

/**
 * Split a text template into literal and `@{state.path}` binding segments,
 * so per-update interpolation walks pre-split paths instead of re-running
 * the regex over the whole template.
 */
function compileTextTemplate(template: string): TemplateSegment[] {
  const bindingPattern = /@\{([^}]+)\}/g;
  const segments: TemplateSegment[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = bindingPattern.exec(template)) !== null) {
    if (match.index > last) {
      segments.push(template.slice(last, match.index));
    }
    segments.push({ match: match[0], keys: match[1]!.split(".") });
    last = match.index + match[0].length;
  }
  if (last < template.length) {
    segments.push(template.slice(last));
  }
  return segments;
}

/** Element types that treat the "action" prop as an onClick handler */
/**
 * Update an element's text in place. When the element's sole child is
 * already a text node, write `nodeValue` — a characterData mutation that
 * reuses the node, matching what React does. `textContent = ...` would
 * tear the text node down and create a fresh one, turning every text
 * update into a childList remove + add (double the DOM churn a text
 * change needs). Anything else (empty element, element children) falls
 * back to `textContent`.
 */
function setElementText(element: HTMLElement, text: string): void {
  // Loose null check: fake-dom (tests) reports missing children as
  // `undefined` where the DOM spec says `null`.
  const first = element.firstChild;
  if (first != null && first.nodeType === 3 /* TEXT_NODE */ && first.nextSibling == null) {
    if (first.nodeValue !== text) {
      first.nodeValue = text;
    }
    return;
  }
  element.textContent = text;
}

const ACTIONABLE_TYPES = new Set(["button", "link", "card"]);
const HORIZONTAL_DEMAND_PROP = /^(?:width|size|fillMaxWidth|fillMaxSize|horizontalAlignment|horizontalAlign|justifyContent|alignSelf|weight|flex|flexGrow|orientation)(?:\.|$)/;

/**
 * Per-component-type props that map to HTML element attributes (not CSS).
 * SetProp for these names must go through the component's `applyProps`
 * (which writes the attribute), otherwise the applicator's CSS fallback
 * tries `el.style.<name>` and the update silently no-ops — most visibly
 * for `Image.src` updates that depend on async-loaded state (the social
 * `Your story` avatar that fills in once `state.currentUser` arrives).
 */
/**
 * Expand each name to the bare spelling and the `.0` applicator spelling.
 *
 * The engine lowers every applicator to `<name>.0` (`ir/expand.rs`) while a
 * constructor argument stays bare, so `Slider(value: x)` and
 * `Slider().value(x)` arrive under different keys for the same prop. Listing
 * only one spelling silently drops the other.
 */
const bothSpellings = (names: string[]): Set<string> =>
  new Set(names.flatMap((name) => [name, `${name}.0`]));

/**
 * A renderer-owned host element. Hypen nodes are HTML elements, except the
 * chart family whose host is an `<svg>` (and whose marks are `<g>`s), which
 * is not an HTMLElement in a browser — but has the same dataset/style
 * surface and needs the same child-change notifications.
 */
function isHostElement(node: unknown): node is HTMLElement {
  if (node instanceof HTMLElement) return true;
  const SVG = (globalThis as any).SVGElement;
  return typeof SVG === "function" && node instanceof SVG;
}

const COMPONENT_HTML_ATTRS: Record<string, Set<string>> = {
  // Chart family: every data/geometry prop must reach the handler so a
  // reactive SetProp re-lays the chart out (the CSS fallback would write
  // `style.points`, a no-op). Style props (`stroke`, `fill`, …) stay on
  // the CSS path on purpose — SVG inherits them into the geometry.
  chart: bothSpellings(["x", "y", "width", "height", "padding"]),
  line: bothSpellings(["0", "points", "data", "values", "x", "y", "smooth", "series", "name"]),
  area: bothSpellings(["0", "points", "data", "values", "x", "y", "smooth", "series", "name"]),
  bars: bothSpellings([
    "0", "points", "data", "values", "x", "y", "label", "value",
    "highlight", "barWidth", "radius", "series", "name",
  ]),
  points: bothSpellings(["0", "points", "data", "values", "x", "y", "radius", "highlight", "series", "name"]),
  axis: bothSpellings(["0", "axis", "ticks", "label", "grid"]),
  rule: bothSpellings(["x", "y"]),
  marker: bothSpellings(["x", "y", "anchor"]),
  path: bothSpellings(["0", "d"]),
  image: bothSpellings(["src", "alt", "url", "0", "srcset"]),
  input: bothSpellings(["type", "placeholder", "value", "disabled", "readonly", "name", "checked"]),
  textarea: bothSpellings(["placeholder", "value", "rows", "cols", "disabled", "readonly", "name"]),
  select: bothSpellings(["name", "multiple", "disabled", "value", "options"]),
  checkbox: bothSpellings(["checked", "disabled", "name"]),
  switch: bothSpellings(["checked", "on", "value", "disabled", "name"]),
  radio: bothSpellings(["checked", "disabled", "name", "value"]),
  link: bothSpellings(["href", "target", "rel"]),
  // Player transport and source are element attributes, not CSS. Without this
  // an `Audio(src: @state.track)` that resolves after first paint stays silent.
  audio: bothSpellings(["0", "src", "source", "controls", "autoplay", "loop", "muted"]),
  slider: bothSpellings(["value", "min", "max", "step", "disabled"]),
  progressbar: bothSpellings(["value", "max", "color", "height"]),
  spinner: bothSpellings(["size", "color", "animated"]),
  avatar: bothSpellings(["0", "src", "source", "initials", "size"]),
  badge: bothSpellings(["0", "text", "theme"]),
  // `level` picks the tag at create; a later change routes here so the
  // handler can express it as aria-level. `__icon*` are engine-injected SVG
  // payloads that the generic applicator path drops (it strips `__` keys).
  heading: bothSpellings(["0", "text", "level"]),
  icon: bothSpellings(["0", "name", "size", "color", "__iconPaths", "__iconViewBox"]),
  divider: bothSpellings([
    "orientation", "color", "backgroundColor", "height", "thickness",
  ]),
  // Route URL changes to the handler so it reconnects the embedded app
  // instead of the generic text branch overwriting the subtree.
  hypenapp: new Set(["0", "url"]),
  // Video contract (hypen-docs/content/docs/guide/components.mdx): every contract prop — media
  // sources, playback flags, headers, and the media event actions — must
  // reach videoHandler.applyProps on SetProp (the CSS fallback would
  // silently no-op them). Props can arrive as "controls" or "controls.0",
  // so both spellings are listed.
  video: bothSpellings([
    "0",
      "src",
      "source",
      "poster",
      "playlist",
      "startIndex",
      "controls",
      "autoplay",
      "loop",
      "muted",
      "preload",
      "headers",
      // v2: playback bind (`playback` struct + `bind` path), the one-way
      // `playing` controlled prop, and the create-time seek. The bind
      // channel MUST route to the handler — the generic bind applicator
      // only knows form controls.
      "playback",
      "playing",
      "bind",
      "startPosition",
      "onPlay",
      "onPause",
      "onEnded",
      "onTrackChange",
      "onError",
  ]),
  // Scrubber (Video v2): its bind path, seek action and value/duration
  // overrides are handler state, not CSS.
  scrubber: bothSpellings([
    "0", "bind", "value", "position", "duration", "disabled", "onSeek",
  ]),
};

import { ComponentRegistry, aliasApplicatorSpellings } from "./components/index.js";
import { ApplicatorRegistry } from "./applicators/index.js";
import { DomAnimator } from "./anim.js";
import { DomScrubber } from "./scrub.js";
import { DomDnd } from "./dnd.js";
import { ANIM_PROP_PREFIX } from "@hypen-space/core/animation";
import { DND_PROP_PREFIX } from "@hypen-space/core/dnd";
import { applySemantics } from "./semantics.js";
import {
  makeKeyboardActivatable,
  makeFocusTrap,
  makeRovingTablist,
  makeRovingListbox,
  focusDialogOnOpen,
  restoreDialogFocus,
  installDialogEscape,
} from "./operability.js";
import { findRouteFocusTarget, focusRouteTarget } from "./route-focus.js";
import type { Semantics } from "@hypen-space/core/types";
import { canvasHandler, canvasApplicators } from "./canvas/index.js";
import { CanvasRenderer } from "../canvas/renderer.js";
import { RerenderTracker, type DebugConfig, defaultDebugConfig } from "./debug.js";
import { setEngine, disposeHypenElement } from "./element-data.js";
import { ensureA11yStyles } from "./a11y-styles.js";
import { ensureAnimStyles } from "./anim-styles.js";
import type { SafeAreaInsetOverrides } from "../safe-area.js";
import { createSafeAreaHandler } from "./components/safearea.js";
import { createImageHandler } from "./components/image.js";
import { createHypenAppHandler, type HypenAppDeviceFactory } from "./components/hypenapp.js";
import { reconcileColumnWidthDemandFrom } from "./cross-axis-width.js";

// Interface for the engine that renderer needs
interface IEngine {
  dispatchAction(name: string, payload?: any): void;
}

export interface DOMRendererOptions {
  /**
   * Route-change focus contract (route-focus.ts). `"auto"` (default) moves
   * focus to the incoming route's first heading / `main` landmark / subtree
   * root on every navigation. `"off"` skips `focusIncomingRoute` entirely —
   * the escape hatch for authors who own focus management themselves (custom
   * transition choreography, embedded shells) and would otherwise fight the
   * renderer for focus on every navigation.
   */
  routeFocus?: "auto" | "off";

  /**
   * Per-edge override for the insets the `SafeArea` component pads by.
   * Each edge is optional and merges over the browser's own
   * `env(safe-area-inset-*)` value, so `{ bottom: 0 }` zeroes only the
   * bottom edge. Values are CSS px numbers or any CSS length string —
   * the escape hatch for embedders (native shells, kiosk frames) whose
   * real unsafe regions the browser cannot report.
   */
  safeAreaInsets?: SafeAreaInsetOverrides;

  /**
   * Base URL for relative image sources. Nested `HypenApp` renderers set this
   * to the child app's HTTP origin so `/poster/x` does not accidentally load
   * from the shell that happens to host the embed.
   */
  assetBaseUrl?: string;

  /**
   * Device plane for `HypenApp` embeds (RFC 001): called with each embedded
   * app's WebSocket URL, it returns that embed's device endpoint — normally
   * `(url) => new WebDeviceHost({ origin: new URL(url).origin })` from
   * `@hypen-space/device-web`. The renderer itself has no device behavior;
   * it only hands the factory to the embeds it creates. Absent ⇒ embedded
   * apps run UI-only.
   */
  hypenAppDevice?: HypenAppDeviceFactory;
}

/**
 * The node id, stamped on the element object itself beside `dataset.hypenId`
 * for the teardown sweep. Reading `dataset.hypenId` back off every
 * descendant of a removed subtree is a DOM attribute lookup per node (a
 * 1,000-row clear sweeps ~17k); a symbol-keyed expando is a plain property
 * read. Not a WeakMap: `WeakMap.set` is a V8 runtime call, and one per
 * created node cost a 1,000-row create ~40 ms — more than the sweep saved.
 */
const ELEMENT_ID: unique symbol = Symbol("hypen.elementId");
type ElementWithId = HTMLElement & { [ELEMENT_ID]?: string };

/**
 * How one template node's `subs` prop is applied on instantiation — see
 * `DOMRenderer.resolveSubApplier`. `demand` marks applicator props that
 * can change horizontal width demand (`HORIZONTAL_DEMAND_PROP`).
 */
type SubApplier =
  | { kind: "generic" }
  | { kind: "text" }
  | { kind: "applicator"; demand: boolean };
const GENERIC_SUB: SubApplier = { kind: "generic" };
const TEXT_SUB: SubApplier = { kind: "text" };

/**
 * Pre-order walk of `root` and every descendant element, by
 * `firstElementChild` / `nextElementSibling` / climb. Never touches
 * `children`: a live `HTMLCollection` is an object per element to build,
 * and its `length` is recomputed by walking every child after any mutation
 * in the subtree — the sweep of a removed 1,000-row list and the walk of
 * each freshly cloned row both hit that.
 */
function walkElements(root: HTMLElement, visit: (element: HTMLElement) => void): void {
  let el: HTMLElement = root;
  for (;;) {
    visit(el);
    let next = el.firstElementChild as HTMLElement | null;
    while (next === null) {
      if (el === root) return;
      next = el.nextElementSibling as HTMLElement | null;
      if (next === null) el = el.parentNode as HTMLElement;
    }
    el = next;
  }
}

export class DOMRenderer {
  private container: HTMLElement;
  private nodes: Map<string, HTMLElement> = new Map();

  /** Registered template prototypes + per-node deferred event props. */
  private templateProtos: Map<
    string,
    {
      proto: HTMLElement;
      deferred: Array<Array<[string, any]>>;
      /** Per-node static props, for seeding each clone's handlerProps. */
      statics: Array<Record<string, any>>;
      /** Lower-cased element type per template node, in engine (DFS) order. */
      types: string[];
      /**
       * For every element of the prototype in DFS order (component-internal
       * wrappers included), whether it is a template node. A clone has the
       * same shape, so this maps a clone walk onto `types`/`statics`
       * without a `dataset` read per element — see `onInstantiate`.
       */
      mask: boolean[];
      /**
       * Template nodes whose text carries a client-side `@{state.…}`
       * template, with the segments compiled once: every clone registers
       * exactly these bindings, so instantiation does not probe each Text
       * node's `data-text-template` (9 per row in a typical list).
       */
      textBindings: Array<{ index: number; template: string; segments: TemplateSegment[] }>;
      /**
       * Per template node, the resolved way to apply each `subs` prop —
       * see [`SubApplier`]. Filled lazily on first use: the `(node, prop)`
       * pairs are the same for every instantiation of a template, and
       * resolving them once replaces the generic `onSetProp` dispatch
       * (map lookup, animation/scrub probes, name matching, registry
       * dispatch) with a direct write per sub.
       */
      subAppliers: Array<Map<string, SubApplier> | undefined>;
    }
  > = new Map();
  private rootId: string | null = null;
  private components: ComponentRegistry;
  private applicators: ApplicatorRegistry;
  private engine: IEngine;
  private currentState: Record<string, any> = {};
  private router: HypenRouter | null = null;
  private globalContext: HypenGlobalContext | null = null;
  private componentInstances = new Map<string, HypenModuleInstance>();
  private debugTracker: RerenderTracker;

  /**
   * Text elements whose template contains an `@{...}` binding, with the
   * template pre-compiled into segments. Only these nodes are visited on
   * state changes — static text never re-interpolates.
   */
  private textBindings = new Map<string, TextBinding>();

  // Canvas subtree routing — Canvas components get their own CanvasRenderer
  // and all descendant patches are forwarded to it instead of the DOM.
  private canvasRenderers = new Map<string, CanvasRenderer>();
  private canvasSubtreeMap = new Map<string, string>(); // nodeId → canvasRootId
  // Parent/child links within canvas subtrees, so removes can prune the
  // routing maps without scanning every entry ever recorded.
  private canvasNodeChildren = new Map<string, Set<string>>();
  private canvasNodeParent = new Map<string, string>();
  private canvasElements = new Map<string, HTMLCanvasElement>();
  /** Props stashed at create-time so we can forward them to CanvasRenderer */
  /**
   * Last known complete prop set for nodes whose type has a
   * COMPONENT_HTML_ATTRS entry, so a SetProp can hand `applyProps` the whole
   * set rather than a single key.
   *
   * Handlers are written against the create-time contract "these are all my
   * props" and several derive one output from several inputs: ProgressBar
   * computes width from value AND max, Icon picks its SVG-vs-placeholder
   * branch on __iconPaths, Avatar picks image-vs-initials on src. Passing a
   * lone changed key made those handlers recompute from missing inputs and
   * blank the element -- ProgressBar snapping to 0% on a colour change, Icon
   * replacing its SVG with "?". Only allowlisted types are tracked, and the
   * entry dies with the node.
   */
  private handlerProps = new Map<string, Record<string, any>>();
  /**
   * Lowers canvas-targeted `instantiate` patches into plain create/insert
   * runs before routing — canvas subtrees can't exploit DOM cloning. Fed
   * every `registerTemplate` (the engine sends each template once per
   * session, and a template registered before any canvas subtree exists
   * may be instantiated inside one later).
   */
  private canvasExpander = new TemplateExpander();

  /**
   * Focus-restore memory for the Router subtree cache, keyed by detached
   * subtree root id: the element that held focus when the route was
   * detached, restored on cached re-`attach`. Entries are dropped on
   * `remove` (Router LRU eviction) so focus restore can never target an
   * evicted NodeId — the route-focus contract (see route-focus.ts).
   */
  private routeFocusMemory = new Map<string, HTMLElement>();

  /** See `DOMRendererOptions.routeFocus` — `"off"` disables `focusIncomingRoute`. */
  private routeFocus: "auto" | "off";

  /** Ids created with `semantics.role === "dialog"`, so insert/remove hooks can act. */
  private dialogIds = new Set<string>();
  /**
   * Open dialog id → the element that held focus before the dialog took it
   * (the trigger), restored on dialog remove/detach when still connected.
   * Presence of an entry means "already focused" — re-inserts (moves) of an
   * open dialog never re-run the mount focus.
   */
  private dialogOpeners = new Map<string, HTMLElement | null>();
  /**
   * Dialog ids inserted during the current batch. Mount focus runs after the
   * whole batch, because a dialog's focusable children may be inserted after
   * the dialog's own insert patch.
   */
  private pendingDialogMounts: string[] = [];

  /**
   * `__anim.*` runtime: transition styles, enter/FLIP playback queues, and
   * deferred-remove (exit) lifecycles. See `anim.ts`.
   */
  private animator = new DomAnimator();

  /**
   * `__anim.scrub*` runtime (Option G): renderer-resident gesture/scroll
   * scrubbing between `.states` poses, velocity-projected settle, and the
   * `.bind`-channel settle write. See `scrub.ts`. Deferred engine writes
   * flush back through `onSetProp` (the scrubber is idle by then, so
   * nothing re-defers).
   */
  private scrubber = new DomScrubber({
    applyProp: (id, name, value) => this.onSetProp(id, name, value),
    // Option G × `.animate`: a running preset's CSS animation beats the
    // scrub's inline styles — engagement suspends it via the animator's
    // suspend machinery; cleanup resumes it.
    suspendPresets: (id, element, targets) =>
      this.animator.suspendPresetsForScrub(id, element, targets),
    resumePresets: (element) => this.animator.resumePresetsAfterScrub(element),
  });

  /**
   * `__dnd.*` runtime: renderer-resident drag-and-drop (activation, ghost,
   * sortable preview, zone resolution, pinboard math, keyboard) that
   * dispatches only the drop outcome. See `dnd.ts`. Deferred engine writes
   * flush back through `onSetProp` (the runtime is idle by then, so nothing
   * re-defers); runtime `.states` poses go straight to the applicators.
   */
  private dnd = new DomDnd({
    applyProp: (id, name, value) => this.onSetProp(id, name, value),
    removeProp: (id, name) => this.onRemoveProp(id, name),
    applyApplicator: (element, name, value) => this.applicators.apply(element, name, value),
  });

  constructor(
    container: HTMLElement,
    engine: IEngine,
    debugConfig?: Partial<DebugConfig>,
    options?: DOMRendererOptions,
  ) {
    this.container = container;
    this.engine = engine;
    this.components = new ComponentRegistry();
    this.applicators = new ApplicatorRegistry();
    this.debugTracker = new RerenderTracker({ ...defaultDebugConfig, ...debugConfig });
    this.routeFocus = options?.routeFocus ?? "auto";

    // Ownership precedence (normative): dnd > scrub > structural playbacks >
    // transaction > `.transition`. A node owned by either gesture runtime is
    // excluded from transaction application and enter/FLIP participation,
    // and a node the DnD runtime is interacting with suspends its scrub.
    this.animator.setScrubActiveCheck((id) => this.dnd.ownsNode(id) || this.scrubber.ownsNode(id));
    this.scrubber.suspended = (id) => this.dnd.isInteracting(id);

    // Inject the global reduced-motion + focus-visible stylesheet once.
    ensureA11yStyles();
    // Inject the `.animate` preset keyframes/classes stylesheet once.
    ensureAnimStyles();

    // Match the canvas/iOS/Android renderers: text without an explicit
    // `.color()` defaults to black. Without this, DOM text would inherit
    // whatever the host page's body color is — a dark shell makes every
    // Text render as muted gray.
    if (!container.style.color) {
      container.style.color = "#000000";
    }

    // Embedder-supplied safe-area insets: re-register SafeArea with a
    // handler bound to them (the default registration uses the browser's
    // own `env(safe-area-inset-*)` values).
    if (options?.safeAreaInsets) {
      this.components.register("safearea", createSafeAreaHandler(options.safeAreaInsets));
    }
    if (options?.assetBaseUrl) {
      this.components.register("image", createImageHandler(options.assetBaseUrl));
    }
    if (options?.hypenAppDevice) {
      this.components.register("hypenapp", createHypenAppHandler({ device: options.hypenAppDevice }));
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
    // Newer engine artifacts deliver the batch as a JSON string; older
    // core wrappers pass it through unparsed. Accept both so a renderer
    // never silently drops a batch on a core/engine version skew.
    if (typeof patches === "string") {
      patches = JSON.parse(patches) as Patch[];
    }
    // Transaction-scoped animation stamp (Option D): honored ONLY as the
    // batch's FIRST patch — the engine's wire contract emits the prelude at
    // index 0, and a `batchAnimation` anywhere else is not a stamp for this
    // batch (e.g. accumulated/concatenated batches must not over-scope).
    const stamp =
      patches.length > 0 && patches[0]!.type === "batchAnimation" ? patches[0]! : null;
    if (stamp) {
      this.animator.beginBatchAnimation(stamp.spec);
    }

    // Canvas routing only matters once a canvas root exists; the common
    // no-canvas case applies the batch directly with no extra passes.
    let canvasBatches: Map<string, Patch[]> | null = null;
    let domPatches = patches;

    if (this.canvasRenderers.size > 0 || this.canvasSubtreeMap.size > 0) {
      // Canvas-targeted instantiates lowered in phase 1 (canvas can't
      // exploit DOM cloning), consumed by the routing in phase 2.
      let canvasInstantiates: Map<
        Patch,
        { rootId: string; expanded: Patch[] }
      > | null = null;

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
            this.registerCanvasMember(childId, parentId, canvasRootId);
          }
        } else if (patch.type === "registerTemplate") {
          // Skeleton must be known before a same-batch canvas-targeted
          // instantiate below is lowered. `onRegisterTemplate` registers
          // again on the DOM pass (idempotent) — that call covers the
          // no-canvas fast path that skips these phases entirely.
          this.canvasExpander.register(patch.templateId!, patch.root);
        } else if (patch.type === "instantiate" && patch.parentId) {
          const canvasRootId =
            this.canvasRenderers.has(patch.parentId) ? patch.parentId
            : this.canvasSubtreeMap.get(patch.parentId);
          if (canvasRootId) {
            // Lower to the plain create/insert run and register the
            // instance's nodes as subtree members so later patches
            // (setProp/remove — routed by id) and same-batch inserts
            // under them resolve to this canvas.
            const expanded = this.canvasExpander.expand([patch]);
            for (const p of expanded) {
              if (p.type === "insert" && p.id && p.parentId) {
                this.registerCanvasMember(p.id, p.parentId, canvasRootId);
              }
            }
            (canvasInstantiates ??= new Map()).set(patch, {
              rootId: canvasRootId,
              expanded,
            });
          }
        }
      }

      // Phase 2: route patches
      canvasBatches = new Map<string, Patch[]>();
      domPatches = [];

      for (const patch of patches) {
        const lowered = canvasInstantiates?.get(patch);
        const canvasRootId = lowered
          ? lowered.rootId
          : this.getCanvasRouteTarget(patch);
        if (canvasRootId) {
          let batch = canvasBatches.get(canvasRootId);
          if (!batch) { batch = []; canvasBatches.set(canvasRootId, batch); }
          if (lowered) {
            batch.push(...lowered.expanded);
          } else {
            batch.push(patch);
          }
          if (patch.type === "remove" && patch.id) {
            // Removed canvas nodes never come back (engine node ids are
            // never reused), so drop their routing entries now.
            this.pruneCanvasSubtree(patch.id);
          }
        } else {
          domPatches.push(patch);
        }
      }

      // A batchAnimation stamp scopes the WHOLE batch, not one node — the
      // id-less patch routes to the DOM side above, so replicate it at the
      // head of every canvas sub-batch so canvas-subtree prop changes glide
      // with the same transaction spec. Only the index-0 prelude counts
      // (first-patch contract).
      if (stamp) {
        for (const batch of canvasBatches.values()) {
          batch.unshift(stamp);
        }
      }
    }

    // Route-change detection for the focus contract: a batch with a detach
    // (route leaving) plus incoming subtree roots (attach of a cached route,
    // or a fresh top-level create+insert) is a navigation. Initial renders
    // have no detach, so they never steal focus.
    const isNavigation = domPatches.some((p) => p.type === "detach");
    const incomingRoots: string[] = [];
    if (isNavigation) {
      const createdInBatch = new Set<string>();
      for (const p of domPatches) {
        if (p.type === "create" && p.id) {
          createdInBatch.add(p.id);
        }
      }
      for (const p of domPatches) {
        if (p.type === "attach" && p.id) {
          incomingRoots.push(p.id);
        } else if (
          p.type === "insert" &&
          p.id &&
          createdInBatch.has(p.id) &&
          (!p.parentId || !createdInBatch.has(p.parentId))
        ) {
          // A freshly-built subtree root: created in this batch, inserted
          // under a parent that predates the batch (the router's slot).
          incomingRoots.push(p.id);
        }
      }
    }

    // FLIP pre-pass: record First rects for `.layout`-animated moves before
    // the batch mutates the DOM (Last is measured in `animator.flush()`).
    this.animator.prepareMoves(domPatches, (nodeId) => this.nodes.get(nodeId));

    // Shared-element pre-pass (Option H): on navigation-shaped batches
    // (detach + attach/insert), snapshot source rects for `__anim.sharedKey`
    // nodes at-or-under the batch's detach roots before the DOM mutates;
    // matching and playback happen in `animator.flush()`.
    this.animator.prepareShared(domPatches, (nodeId) => this.nodes.get(nodeId));

    // Apply DOM patches normally
    for (const patch of domPatches) {
      this.applyPatch(patch);
    }

    // Forward canvas-subtree patches to their CanvasRenderer instances
    if (canvasBatches) {
      for (const [rootId, batch] of canvasBatches) {
        const renderer = this.canvasRenderers.get(rootId);
        if (renderer) {
          renderer.applyPatches(batch);
        }
      }
    }

    if (isNavigation && incomingRoots.length > 0 && this.routeFocus !== "off") {
      this.focusIncomingRoute(incomingRoots[0]!);
    }

    // Dialog mount focus runs last: a dialog opened by this batch takes
    // focus even when the batch was also a navigation (modal wins).
    this.flushDialogMounts();

    // DnD post-batch hook: lists an insert/remove dirtied mid-drag are
    // rebuilt ONCE here (one measure pass after all the batch's DOM writes),
    // before the animator measures Last.
    this.dnd.flushStructural();

    // Animation post-batch hook: play queued enters and FLIP moves now that
    // the whole batch (including late-arriving descendants) is in the DOM.
    this.animator.flush();
  }

  /**
   * Apply the dialog focus contract to dialogs inserted by the finished
   * batch: focus the first focusable descendant, else the dialog itself, and
   * remember the previously-focused element (the trigger) for restore on
   * close. Deferred to batch end so descendants inserted after the dialog's
   * own insert patch are visible to the focus search.
   */
  private flushDialogMounts(): void {
    if (this.pendingDialogMounts.length === 0) return;
    const pending = this.pendingDialogMounts;
    this.pendingDialogMounts = [];
    for (const id of pending) {
      if (this.dialogOpeners.has(id)) continue; // already open — a move, not a mount
      const dialog = this.nodes.get(id);
      if (!dialog) continue;
      this.dialogOpeners.set(id, focusDialogOnOpen(dialog));
    }
  }

  /**
   * Apply the route-focus contract to a freshly-shown route subtree: restore
   * the remembered focus of a cached route when it is still inside the
   * subtree, otherwise land on the first heading / main landmark / the
   * subtree root (see route-focus.ts for the full contract).
   */
  private focusIncomingRoute(rootId: string): void {
    const root = this.nodes.get(rootId);
    if (!root) return;

    const remembered = this.routeFocusMemory.get(rootId);
    const target =
      remembered && (root === remembered || root.contains?.(remembered))
        ? remembered
        : findRouteFocusTarget(root);
    focusRouteTarget(target);
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
        // setProp, removeProp, setText, remove, detach — route by node id.
        // registerTemplate (no id) always stays DOM-side; canvas-targeted
        // instantiate (no id, routes by parentId) is lowered to plain
        // patches before routing ever consults this method.
        if (!id) return undefined;
        return this.canvasSubtreeMap.get(id);
      }
    }
  }

  /**
   * Record a node as a member of a canvas subtree, tracking its parent link
   * so a later `remove` can prune the whole subtree from the routing maps.
   */
  private registerCanvasMember(childId: string, parentId: string, canvasRootId: string): void {
    this.canvasSubtreeMap.set(childId, canvasRootId);
    const prevParent = this.canvasNodeParent.get(childId);
    if (prevParent !== undefined && prevParent !== parentId) {
      this.canvasNodeChildren.get(prevParent)?.delete(childId);
    }
    this.canvasNodeParent.set(childId, parentId);
    let siblings = this.canvasNodeChildren.get(parentId);
    if (!siblings) {
      siblings = new Set();
      this.canvasNodeChildren.set(parentId, siblings);
    }
    siblings.add(childId);
  }

  /**
   * Drop a removed canvas node and all of its descendants from the canvas
   * routing maps. The engine emits `remove` only for the subtree root, so
   * descendants are walked via the tracked child links.
   */
  private pruneCanvasSubtree(id: string): void {
    const children = this.canvasNodeChildren.get(id);
    if (children) {
      this.canvasNodeChildren.delete(id);
      for (const childId of children) {
        this.pruneCanvasSubtree(childId);
      }
    }
    this.canvasSubtreeMap.delete(id);
    const parentId = this.canvasNodeParent.get(id);
    if (parentId !== undefined) {
      this.canvasNodeParent.delete(id);
      this.canvasNodeChildren.get(parentId)?.delete(id);
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
   * Interpolate state values in all binding-bearing text elements
   */
  private interpolateAllText(): void {
    for (const [id, binding] of this.textBindings) {
      const interpolated = this.interpolateSegments(binding.segments, this.currentState);
      const element = binding.element;
      if (element.textContent !== interpolated) {
        this.debugTracker.trackRerender(id, element, "interpolate");
        setElementText(element, interpolated);
      }
    }
  }

  /**
   * Resolve a compiled template against the current state.
   *
   * Bindings use the `@{state.path}` syntax (matching the engine's parser);
   * unresolvable bindings render as their original `@{...}` text.
   */
  private interpolateSegments(segments: TemplateSegment[], state: Record<string, any>): string {
    let result = "";
    for (const segment of segments) {
      if (typeof segment === "string") {
        result += segment;
        continue;
      }
      try {
        let value: any = state;
        for (const key of segment.keys) {
          value = key === "state" ? state : value?.[key];
        }
        result += value !== undefined ? String(value) : segment.match;
      } catch {
        result += segment.match;
      }
    }
    return result;
  }

  /**
   * Keep the binding index in sync with the element's stored template:
   * register text elements whose template contains an `@{...}` binding,
   * drop everything else.
   */
  private syncTextBinding(id: string, element: HTMLElement): void {
    const template = element.dataset.textTemplate;
    if (element.dataset.hypenType === "text" && template && template.includes("@{")) {
      const existing = this.textBindings.get(id);
      if (!existing || existing.template !== template || existing.element !== element) {
        this.textBindings.set(id, {
          element,
          template,
          segments: compileTextTemplate(template),
        });
      }
    } else {
      this.textBindings.delete(id);
    }
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
        this.onCreate(id!, elementType ?? "container", patch.props || {}, patch.semantics);
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
        this.onRemove(id!, patch.transition === true);
        break;
      case "detach":
        this.onDetach(id!);
        break;
      case "attach":
        this.onAttach(parentId!, id!, beforeId);
        break;
      case "setSemantics":
        this.onSetSemantics(id!, patch.semantics);
        break;
      case "batchAnimation":
        // Transaction-scoped animation stamp (Option D): scopes the batch,
        // addresses no node. Handled at the head of applyPatches — ONLY the
        // batch's first patch is a valid stamp, so a mid-array occurrence
        // is deliberately ignored here.
        break;
      case "registerTemplate":
        this.onRegisterTemplate(patch.templateId!, patch.root!);
        break;
      case "instantiate":
        this.onInstantiate(patch);
        break;
    }
  }

  /**
   * Register a reusable element prototype (the engine always emits
   * `registerTemplate`/`instantiate` for plannable list rows — this
   * renderer is the consumer that exploits them via DOM cloning). The
   * prototype is built ONCE with all static props applied; event-flavored
   * props (`on*` applicators, `action`) are recorded per node instead of
   * applied, because DOM event listeners do not survive `cloneNode` —
   * each instance re-applies them.
   */
  private onRegisterTemplate(templateId: string, root: TemplateSkeletonNode): void {
    // Keep the canvas-lowering expander in sync even on the no-canvas
    // fast path — a canvas subtree created later may instantiate this
    // template (idempotent with the phase-1 registration).
    this.canvasExpander.register(templateId, root);
    const deferred: Array<Array<[string, any]>> = [];
    // Per-node static props, kept so `onInstantiate` can seed each clone's
    // handlerProps cache. Without it a templated list row starts with an
    // empty set and the first SetProp recomputes from handler defaults.
    const statics: Array<Record<string, any>> = [];
    const types: string[] = [];
    const build = (node: TemplateSkeletonNode): HTMLElement => {
      const index = deferred.length;
      const mine: Array<[string, any]> = [];
      deferred.push(mine);
      types[index] = node.elementType.toLowerCase();

      const staticProps: Record<string, any> = {};
      for (const [key, value] of Object.entries(node.props ?? {})) {
        const dot = key.indexOf(".");
        const base = dot !== -1 ? key.slice(0, dot) : key;
        if (/^on[A-Z]/.test(base) || base === "action") {
          mine.push([key, value]);
        } else {
          staticProps[key] = value;
        }
      }

      let element = this.components.createElement(node.elementType, staticProps);
      if (!element) {
        const fallback = document.createElement("div");
        fallback.style.display = "contents";
        element = fallback;
      }
      element.dataset.hypenType = node.elementType.toLowerCase();
      // `.slot("name")` marker, same as `onCreate`: slot-aware containers
      // (HypenApp, Video) identify their slotted children at the DOM level,
      // and the marker has to be on the prototype to survive into clones.
      const slotName = staticProps["slot.0"] ?? staticProps.slot;
      if (typeof slotName === "string" && slotName) {
        element.dataset.hypenSlot = slotName;
      }
      statics[index] = staticProps;
      this.applicators.applyAll(element, staticProps);

      for (const child of node.children ?? []) {
        const childElement = build(child);
        element.appendChild(childElement);
        reconcileColumnWidthDemandFrom(childElement);
      }
      // Prototype subtrees are assembled without normal insert patches.
      // Reconcile bottom-up here so the generated demand markers and
      // automatic Column stretch survive cloneNode(true) on instantiate.
      reconcileColumnWidthDemandFrom(element);
      return element;
    };

    const proto = build(root);
    const mask: boolean[] = [];
    const textBindings: Array<{ index: number; template: string; segments: TemplateSegment[] }> = [];
    let index = 0;
    walkElements(proto, (el) => {
      const isTemplateNode = el.dataset.hypenType !== undefined;
      mask.push(isTemplateNode);
      if (!isTemplateNode) return;
      const template = types[index] === "text" ? el.dataset.textTemplate : undefined;
      if (template && template.includes("@{")) {
        textBindings.push({ index, template, segments: compileTextTemplate(template) });
      }
      index++;
    });
    this.templateProtos.set(templateId, {
      proto,
      deferred,
      statics,
      types,
      mask,
      textBindings,
      subAppliers: [],
    });
  }

  /**
   * Resolve how a template node's `subs` prop is applied, once per
   * `(node, prop)` per template. Mirrors the branches of `onSetProp` for a
   * freshly cloned, not-yet-inserted node: a plain text write or a plain
   * applicator call is done directly; everything with per-node state or a
   * component hook (animation channels, slots, SafeArea edges, handler
   * attributes, actionable `action`, canvas sizing) keeps the generic path.
   */
  private resolveSubApplier(type: string, prop: string): SubApplier {
    if (prop.startsWith(ANIM_PROP_PREFIX)) return GENERIC_SUB;
    if (prop === "slot" || prop === "slot.0") return GENERIC_SUB;
    if ((prop === "edges" || prop === "edges.0") && type === "safearea") return GENERIC_SUB;
    if (prop === "action" && ACTIONABLE_TYPES.has(type)) return GENERIC_SUB;
    if (COMPONENT_HTML_ATTRS[type]?.has(prop)) return GENERIC_SUB;
    if (prop === "0" || prop === "text") {
      return type === "input" ? GENERIC_SUB : TEXT_SUB;
    }
    if (prop === "width" || prop === "height") return GENERIC_SUB; // canvas resize hook
    return { kind: "applicator", demand: HORIZONTAL_DEMAND_PROP.test(prop) };
  }

  /**
   * Materialize one template instance: `cloneNode(true)` the prototype
   * (styles, static text, attributes all survive the clone), assign the
   * engine's ids to the clone's elements in depth-first order, then apply
   * per-node semantics, the deferred event props, and the dynamic-prop
   * subs — each through the same `onSetProp` path a plain patch would
   * take — and insert the finished subtree once.
   */
  private onInstantiate(patch: Patch): void {
    const entry = this.templateProtos.get(patch.templateId!);
    const ids = patch.nodes ?? [];
    if (!entry || ids.length === 0) {
      log.warn(`instantiate for unknown template "${patch.templateId}"`);
      return;
    }

    const clone = entry.proto.cloneNode(true) as HTMLElement;
    // Collect the clone's template elements in the same depth-first order
    // the engine assigned ids in. Only template nodes count — a
    // component's internal wrapper elements are skipped, though the walk
    // still descends through them. The clone has the prototype's shape, so
    // the prototype's precomputed mask says which elements those are
    // without a `dataset` read per element (17k per 1,000-row create); a
    // shape mismatch (a prototype mutated after registration) falls back
    // to reading the markers.
    const { mask, types } = entry;
    let elements: HTMLElement[] = [];
    let position = 0;
    walkElements(clone, (el) => {
      if (mask[position++]) elements.push(el);
    });
    if (position !== mask.length) {
      elements = [];
      walkElements(clone, (el) => {
        if (el.dataset?.hypenType) elements.push(el);
      });
    }
    if (elements.length !== ids.length) {
      log.warn(
        `instantiate node count mismatch for "${patch.templateId}": ` +
          `${elements.length} elements vs ${ids.length} ids`,
      );
      return;
    }

    for (let i = 0; i < elements.length; i++) {
      const element = elements[i];
      element.dataset.hypenId = ids[i];
      (element as ElementWithId)[ELEMENT_ID] = ids[i];
      // No `setEngine` per node: `getEngine` resolves through the mounted
      // ancestors, and the per-element WeakMap write was ~17k per create.
      this.nodes.set(ids[i], element);
      // Seed the prop cache from the prototype's static props, exactly as
      // onCreate does from a Create patch. A clone that skipped this had an
      // empty set, so the first SetProp on it recomputed every other prop
      // from the handler's defaults -- ProgressBar losing its `max`, Icon
      // losing its resolved paths.
      const cloneType = types[i];
      if (cloneType && COMPONENT_HTML_ATTRS[cloneType]) {
        this.handlerProps.set(
          ids[i],
          aliasApplicatorSpellings({ ...(entry.statics?.[i] ?? {}) }),
        );
      }
    }
    // Per-node passes AFTER all ids are registered, so handlers that look
    // up related nodes resolve.
    //
    // Adoption first: a clone carries the prototype's DOM but none of its
    // JS-side state (WeakMap entries, listeners, media wiring), and the
    // passes below — deferred event props, `subs` — assume a live component.
    // Parents adopt before children (depth-first collect order), so a
    // Scrubber finds its enclosing Video already wired.
    for (let i = 0; i < elements.length; i++) {
      this.components.adopt(elements[i], types[i]);
    }
    for (const [index, semantics] of patch.nodeSemantics ?? []) {
      applySemantics(elements[index], semantics);
    }
    for (let i = 0; i < elements.length; i++) {
      for (const [key, value] of entry.deferred[i] ?? []) {
        this.onSetProp(ids[i], key, value);
      }
    }
    for (const { index, template, segments } of entry.textBindings) {
      this.textBindings.set(ids[index], { element: elements[index], template, segments });
    }

    // `subs`: the item-dependent props, already resolved by the engine.
    // Applied through per-template resolved appliers rather than the
    // generic `onSetProp` (see `resolveSubApplier`). A stamped
    // (transaction) batch keeps the generic path so its glide rules apply;
    // otherwise a fresh clone has no scrub or animation state to consult.
    // Width-demand reconciles once per affected element after all subs,
    // not once per sub.
    const generic = this.animator.transactionActive;
    let demandDirty: HTMLElement[] | null = null;
    const { subAppliers } = entry;
    for (const [index, prop, value] of patch.subs ?? []) {
      let appliers = subAppliers[index];
      if (!appliers) subAppliers[index] = appliers = new Map();
      let applier = appliers.get(prop);
      if (!applier) {
        applier = this.resolveSubApplier(types[index], prop);
        appliers.set(prop, applier);
      }
      if (generic || applier.kind === "generic") {
        this.onSetProp(ids[index], prop, value);
        continue;
      }
      const element = elements[index];
      if (applier.kind === "text") {
        // A value that is itself a template must go through the generic
        // path, which records it for client-side re-interpolation.
        if (typeof value === "string" && value.includes("@{")) {
          this.onSetProp(ids[index], prop, value);
        } else {
          setElementText(element, String(value));
        }
        continue;
      }
      this.applicators.apply(element, prop, value);
      if (applier.demand) (demandDirty ??= []).push(element);
    }
    if (demandDirty) {
      for (const element of new Set(demandDirty)) reconcileColumnWidthDemandFrom(element);
    }

    this.onInsert(patch.parentId!, ids[0], patch.beforeId);
  }

  /**
   * Reactive accessibility update: re-run the create-time semantics
   * translation on the live element with the node's complete re-resolved
   * block. `applySemantics` is idempotent and clears attributes it set on a
   * previous pass that the new block no longer produces. This is the sole
   * ARIA writer for bound self-state — the SetProp that accompanies a bound
   * `.expanded(@state.open)` change does not touch ARIA attributes.
   */
  private onSetSemantics(id: string, semantics?: Semantics): void {
    const element = this.nodes.get(id);
    if (!element) {
      log.warn(`setSemantics: element ${id} not found`);
      return;
    }
    applySemantics(element, semantics);
  }

  /**
   * Create a new element
   */
  private onCreate(id: string, elementType: string, props: Record<string, any> | Map<string, any>, semantics?: Semantics): void {
    // Defensive: a create for an id still exit-animating finalizes the old
    // subtree first, so the corpse can't shadow the new element in `nodes`.
    this.animator.finalizeNow(id);

    let propsObj = props instanceof Map ? Object.fromEntries(props) : props;

    // Split off `__anim.*` / `__dnd.*` channel props: they configure the
    // animator / scrubber / DnD runtime, and must never reach the
    // applicators (or their CSS fallback).
    let animProps: Record<string, any> | null = null;
    let hasDndProps = false;
    for (const key of Object.keys(propsObj)) {
      if (key.startsWith(ANIM_PROP_PREFIX)) {
        (animProps ??= {})[key] = propsObj[key];
      } else if (key.startsWith(DND_PROP_PREFIX)) {
        hasDndProps = true;
      }
    }
    const fullProps = propsObj;
    if (animProps || hasDndProps) {
      const rest: Record<string, any> = {};
      for (const [key, value] of Object.entries(propsObj)) {
        if (!key.startsWith(ANIM_PROP_PREFIX) && !key.startsWith(DND_PROP_PREFIX)) rest[key] = value;
      }
      propsObj = rest;
    }

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
    (element as ElementWithId)[ELEMENT_ID] = id;
    setEngine(element, this.engine);

    // Slot marker: `.slot("name")` lowers to the `slot.0` prop. The engine
    // resolves slots during component expansion, but container components
    // that own their children natively (HypenApp's loading/error slots)
    // need to identify slotted children at the DOM level.
    const slotName = propsObj["slot.0"] ?? propsObj.slot;
    if (typeof slotName === "string" && slotName) {
      element.dataset.hypenSlot = slotName;
    }

    // Apply engine-derived accessibility semantics (role, …) before styling
    // props, so a redundant-role check sees the final host tag.
    applySemantics(element, semantics);

    // Dialog-like containers trap keyboard focus so Tab cycles within the
    // dialog rather than escaping to the page behind it. Mount focus and
    // restore-to-trigger run on insert/remove (tracked via dialogIds) — the
    // element isn't in the document yet at create time. Escape closes only
    // when the author declared an onClose action; without one, closing is
    // app state and Escape does nothing.
    if (semantics?.role === "dialog") {
      makeFocusTrap(element);
      this.dialogIds.add(id);
      const onClose = propsObj.onClose ?? propsObj["onClose.0"];
      if (onClose) {
        installDialogEscape(element, onClose);
      }
    }

    // Tablists get the WAI-ARIA roving-tabindex keyboard contract: arrows
    // move focus among the role="tab" children, Home/End jump to the ends,
    // only the focused tab stays in the page Tab order, and printable
    // characters typeahead to the next matching tab.
    if (semantics?.role === "tablist") {
      makeRovingTablist(element);
    }

    // Listboxes get the same roving + typeahead contract over their
    // role="option" children (no-op on a native <select> host, where the
    // browser owns the keyboard behaviour).
    if (semantics?.role === "listbox") {
      makeRovingListbox(element);
    }

    // DnD registers FIRST: its pointerdown listener must precede the
    // scrubber's (dnd > scrub on a shared pointerdown), and the `bind`
    // applicator below must already see the sortable/pinboard write-target
    // marker so it leaves the reorder path alone.
    if (hasDndProps || animProps) {
      this.dnd.registerCreate(id, element, fullProps, animProps);
    }
    if (animProps) {
      this.animator.registerCreate(id, element, animProps);
      this.scrubber.registerCreate(id, element, animProps);
    }

    this.applicators.applyAll(element, propsObj);

    // Actionable components: wire "action" prop as onClick, and make
    // non-native hosts (e.g. an actionable Card div) keyboard-operable.
    if (propsObj.action && ACTIONABLE_TYPES.has(elementType.toLowerCase())) {
      this.applicators.apply(element, "onClick", propsObj.action);
      makeKeyboardActivatable(element, propsObj.action);
    }

    // Seed the prop cache for types whose handler needs the full set on a
    // later SetProp (see `handlerProps`).
    if (COMPONENT_HTML_ATTRS[elementType.toLowerCase()]) {
      // Aliased, not raw: handlers read the bare spelling, and a node built
      // purely from applicators (`Image().src("a.png")` → `{"src.0": …}`)
      // would otherwise cache a set in which every bare read is undefined —
      // so the next merge-and-reapply would look like "src was removed".
      this.handlerProps.set(id, aliasApplicatorSpellings({ ...propsObj }));
    }

    this.nodes.set(id, element);
    // Only Text elements can ever register a binding (`syncTextBinding`
    // requires dataset.hypenType === "text"), and its first act is a
    // DOMStringMap read — a real attribute access. Skipping the call for
    // the other 16-of-17 elements in a typical row removes tens of
    // thousands of dataset reads from a large first render.
    if (elementType.toLowerCase() === "text") {
      this.syncTextBinding(id, element);
    }
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

    // `__dnd.*` channel props route to the DnD runtime, never to applicators.
    if (name.startsWith(DND_PROP_PREFIX)) {
      if ((name === "__dnd.pinX" || name === "__dnd.pinY") && this.dnd.deferEngineProp(id, name, value)) return;
      this.dnd.setDndProp(id, element, name, value);
      return;
    }

    // `__anim.*` channel props route to the animator + scrubber (+ the DnD
    // runtime for `__anim.statePoses`), never to applicators. The scrubber
    // consumes the `__anim.scrub*` channels and watches `__anim.states` (its
    // cleanup signal); the animator ignores the scrub channels.
    if (name.startsWith(ANIM_PROP_PREFIX)) {
      this.dnd.setAnimProp(id, element, name, value);
      this.scrubber.setAnimProp(id, element, name, value);
      this.animator.setAnimProp(id, element, name, value);
      return;
    }

    // Gesture conflict rules (gesture wins; dnd > scrub): while a drag owns
    // this node, engine writes to its translate keys (or to the props a
    // runtime `.states` label overrides) are deferred — latest value stored,
    // applied at release. Likewise a scrub's SCRUBBED keys during a
    // drag/settle. Other props flow normally.
    if (this.dnd.deferEngineProp(id, name, value)) {
      return;
    }
    if (this.scrubber.deferEngineProp(id, name, value)) {
      return;
    }
    // The DnD runtime reads a sortable/pinboard's `bind` and a zone's `id`
    // off the node; keep it current (no-op for non-DnD nodes).
    if (name === "bind" || name === "id" || name === "id.0") {
      this.dnd.noteProp(id, name, value);
    }

    // Transaction-scoped animation (Option D): in a batch stamped by a
    // leading batchAnimation patch, whitelisted prop changes glide with the
    // transaction spec on ANY node — the animator sets the transaction
    // transition styles BEFORE the prop write below lands. No-op for
    // unstamped batches.
    this.animator.noteTransactionProp(id, element, name);

    this.debugTracker.trackRerender(id, element, `setProp:${name}`);

    if (name === "slot.0" || name === "slot") {
      if (typeof value === "string" && value) {
        element.dataset.hypenSlot = value;
      } else {
        delete element.dataset.hypenSlot;
      }
      this.notifyParentChildrenChanged(element);
      return;
    }

    // SafeArea's `edges` selects which edges carry inset padding, so a
    // change has to go back through the handler. The generic applicator
    // path would only emit a bogus `edges` CSS declaration — and canvas
    // re-derives the same thing from props on its next layout pass.
    if (
      (name === "edges" || name === "edges.0") &&
      element.dataset.hypenType === "safearea"
    ) {
      this.components.get("safearea")?.applyProps?.(element, { edges: value });
      return;
    }

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
      // Same merged path as any other allowlisted prop. Passing the lone key
      // here left the cache holding the OLD `0`, so the next SetProp on any
      // other key re-applied it and visibly reverted the content.
      if (this.applyPropThroughHandler(id, element, name, value)) return;

      const nextText = String(value);
      setElementText(element, nextText);

      // Preserve the original template when it contains state interpolation.
      // Engine patches may send interpolated strings; if we overwrite the template,
      // future state updates won't be able to re-interpolate.
      const currentTemplate = element.dataset.textTemplate;
      const nextLooksLikeTemplate = nextText.includes("@{");

      // A dataset assignment is a real DOM attribute mutation, so writes
      // are limited to the cases where the stored value's MEANING changes.
      // The marker's only reader is `syncTextBinding`, which acts solely on
      // values containing `@{` — so a plain value going stale is unread
      // noise, and rewriting it turned every plain text update into
      // text + attribute churn (2 DOM mutations where React does 1).
      if (nextLooksLikeTemplate) {
        if (currentTemplate !== nextText) {
          element.dataset.textTemplate = nextText;
        }
      } else if (currentTemplate === undefined) {
        // No template stored yet; treat this as the template.
        element.dataset.textTemplate = nextText;
      }
      // else: keep the stored value as-is. A stored template must survive
      // interpolated (plain) output or future state updates can't
      // re-interpolate; a stored plain value going stale changes nothing.
      this.syncTextBinding(id, element);
      log.debug(`Updated text content: "${value}"`);
      return;
    }

    // Actionable components: wire "action" prop as onClick
    if (name === "action" && ACTIONABLE_TYPES.has(element.dataset.hypenType || "")) {
      this.applicators.apply(element, "onClick", value);
      makeKeyboardActivatable(element, value);
      return;
    }

    // Element-specific HTML attributes (img.src, input.placeholder, etc.)
    // need to go through the component handler's `applyProps`. Without
    // this, a follow-up SetProp(src=…) for an `Image` whose initial
    // Create had no src — the `Your story` avatar that depends on
    // `state.currentUser`, which loads after the first paint — was
    // routed to the CSS fallback (`el.style.src`, a no-op) and the
    // image stayed blank forever.
    if (this.applyPropThroughHandler(id, element, name, value)) return;

    this.applicators.apply(element, name, value);

    if (HORIZONTAL_DEMAND_PROP.test(name)) {
      reconcileColumnWidthDemandFrom(element);
    }

    // Forward canvas dimension changes to its CanvasRenderer
    if ((name === "width" || name === "height") && this.canvasRenderers.has(id)) {
      const canvasEl = this.canvasElements.get(id)!;
      this.canvasRenderers.get(id)!.resize(canvasEl.width, canvasEl.height);
    }
  }

  /**
   * Remove a property from an element
   */
  /**
   * Props whose live value belongs to the USER, not to the last patch.
   *
   * Handing a handler the full cached set means it re-asserts every prop in
   * it, including ones the user has since changed by typing or clicking. The
   * cache holds the create-time value, so an unrelated SetProp would revert
   * the edit — `Input(value: "a")` typed to "hello" snapped back to "a" on
   * the next `disabled` patch. Reading these back off the DOM first keeps the
   * element the source of truth for them until a patch actually changes them.
   */
  private static readonly LIVE_DOM_PROPS: Record<string, Array<[prop: string, domField: string]>> = {
    input: [["value", "value"], ["checked", "checked"]],
    textarea: [["value", "value"]],
    select: [["value", "value"]],
    checkbox: [["checked", "checked"]],
    // Switch accepts three spellings for the same state (`checked ?? on ??
    // value` in switch.ts); every one the node was created with has to track
    // the live toggle, or `Switch(on: true)` snaps back on at the next patch.
    switch: [["checked", "checked"], ["on", "checked"], ["value", "checked"]],
    radio: [["checked", "checked"]],
  };

  /** Refresh user-owned props in `merged` from the DOM, except `changing`. */
  private syncLiveProps(
    elementType: string,
    element: HTMLElement,
    merged: Record<string, any>,
    changing: string,
  ): void {
    const live = DOMRenderer.LIVE_DOM_PROPS[elementType];
    if (!live) return;

    // Checkbox and Switch wrap their input; Input/Select/TextArea are it.
    const field =
      (element.querySelector?.("input,select,textarea") as HTMLInputElement | null) ??
      (element as HTMLInputElement);

    for (const [prop, domField] of live) {
      // The prop being patched must take the engine's value, not the DOM's.
      if (prop === changing) continue;
      if (!(prop in merged)) continue;
      const current = (field as any)?.[domField];
      if (current !== undefined) merged[prop] = current;
    }
  }

  /**
   * Route an allowlisted prop to its component handler with the node's full
   * prop set. Returns false when the prop is not handler-backed, so the
   * caller falls through to the applicator.
   */
  private applyPropThroughHandler(
    id: string,
    element: HTMLElement,
    name: string,
    value: any,
  ): boolean {
    const elementType = element.dataset.hypenType;
    if (!elementType || !COMPONENT_HTML_ATTRS[elementType]?.has(name)) return false;

    const handler = this.components.get(elementType);
    if (!handler?.applyProps) return false;

    // Handlers read the bare spelling; `.0` is the applicator wire form for
    // the same prop. `"0"` (positional) is left alone — it does not end in
    // `.0`.
    const bare = name.endsWith(".0") ? name.slice(0, -2) : name;

    // Merge into the node's known props rather than passing the lone changed
    // key: handlers derive output from several inputs at once and recompute
    // from defaults for anything missing.
    const merged = this.handlerProps.get(id) ?? {};
    this.syncLiveProps(elementType, element, merged, bare);
    merged[bare] = value;
    merged[name] = value;
    this.handlerProps.set(id, merged);
    handler.applyProps(element, merged);

    if (HORIZONTAL_DEMAND_PROP.test(name)) {
      reconcileColumnWidthDemandFrom(element);
    }
    return true;
  }

  private onRemoveProp(id: string, name: string): void {
    const element = this.nodes.get(id);
    if (!element) return;

    if (name.startsWith(DND_PROP_PREFIX)) {
      if ((name === "__dnd.pinX" || name === "__dnd.pinY") && this.dnd.deferEngineRemoveProp(id, name)) return;
      this.dnd.removeDndProp(id, element, name);
      return;
    }

    if (name.startsWith(ANIM_PROP_PREFIX)) {
      this.dnd.setAnimProp(id, element, name, undefined);
      this.scrubber.removeAnimProp(id, element, name);
      this.animator.removeAnimProp(id, element, name);
      return;
    }

    // Drag wins (dnd > scrub): a RemoveProp of a transform key on the
    // dragged node, or of a pose-overridden key on a labelled node, is
    // deferred exactly like a SetProp and replayed at release.
    if (this.dnd.deferEngineRemoveProp(id, name)) {
      return;
    }
    if (name === "bind" || name === "id" || name === "id.0") {
      this.dnd.noteProp(id, name, undefined);
    }

    this.debugTracker.trackRerender(id, element, `removeProp:${name}`);

    if (name === "slot.0" || name === "slot") {
      delete element.dataset.hypenSlot;
      this.notifyParentChildrenChanged(element);
      return;
    }

    // Mirror of the SetProp routing: an attribute-backed prop can only be
    // cleared by its handler, since the applicator fallback no-ops on an
    // element attribute (`Input.disabled` could be set but never unset).
    // The handler gets the node's remaining props with the removed key
    // present and `undefined`: dropping the key instead would let a handler
    // guarding `props.x !== undefined` skip the removal and leave the
    // attribute it last wrote in place.
    const elementType = element.dataset.hypenType;
    if (elementType && COMPONENT_HTML_ATTRS[elementType]?.has(name)) {
      const handler = this.components.get(elementType);
      if (handler?.applyProps) {
        const bare = name.endsWith(".0") ? name.slice(0, -2) : name;
        const merged = this.handlerProps.get(id) ?? {};
        // Both spellings go together: SetProp writes them as a pair.
        delete merged[bare];
        delete merged[name];
        this.handlerProps.set(id, merged);
        handler.applyProps(element, { ...merged, [bare]: undefined, [name]: undefined });
        // A handful of names are backed by BOTH a handler and an applicator:
        // `size` writes an attribute AND records a width source that layout
        // reads back. Returning here would clear the attribute but strand the
        // applicator's bookkeeping, and the reconcile below would then act on
        // the stale marker — turning a removal into a bogus width demand.
        if (this.applicators.hasHandler(bare)) {
          this.applicators.apply(element, bare, undefined);
        }
        // Unconditional, as the divider case this generalises always was: an
        // attribute reset can change intrinsic width demand under names
        // `HORIZONTAL_DEMAND_PROP` does not list (Divider's `thickness`).
        reconcileColumnWidthDemandFrom(element);
        return;
      }
    }

    this.applicators.apply(element, name, undefined);
    if (HORIZONTAL_DEMAND_PROP.test(name)) {
      reconcileColumnWidthDemandFrom(element);
    }
  }

  /**
   * Set text content
   */
  private onSetText(id: string, text: string): void {
    const element = this.nodes.get(id);
    if (!element) return;

    this.debugTracker.trackRerender(id, element, "setText");
    setElementText(element, text);
  }

  /**
   * Insert an element into the tree
   */
  private onInsert(parentId: string, id: string, beforeId?: string, isMove = false): void {
    const parent = parentId === "root" ? this.container : this.nodes.get(parentId);
    const child = this.nodes.get(id);
    const previousParent = child?.parentNode;

    // Gated up front: building the payload reads `textContent`, which
    // serializes the whole subtree's text — too costly to pay when debug
    // logging is off.
    if (isDebugMode()) {
      log.debug(`Inserting ${id} into ${parentId}`, {
        parent: parent ? `${parent.tagName}#${parent.id || 'no-id'}` : 'null',
        child: child ? `${child.tagName}#${child.id || 'no-id'}` : 'null',
        childText: child?.textContent?.substring(0, 20)
      });
    }

    if (!parent || !child) return;

    if (parentId === "root") {
      this.rootId = id;
    }

    // Re-inserting a focused element (or an ancestor of one) drops focus to
    // <body> in every browser: a keyboard-reordered row, a focused input in
    // a keyed list the engine re-sorted. Remember and restore after the
    // move, so keyboard users are not dumped to the top of the document.
    const doc = (child.ownerDocument ?? (typeof document !== "undefined" ? document : null)) as Document | null;
    const active = (doc?.activeElement ?? null) as HTMLElement | null;
    const focusedWithin =
      active !== null && previousParent != null && (child === active || child.contains?.(active) === true);

    if (beforeId) {
      const before = this.nodes.get(beforeId);
      if (before && before.parentNode === parent) {
        parent.insertBefore(child, before);
      } else if (!parent.contains(child)) {
        parent.appendChild(child);
      }
    } else if (!parent.contains(child)) {
      parent.appendChild(child);
    } else if (isMove && child.parentNode === parent && parent.lastChild !== child) {
      // A Move with no anchor means "to the end" (the keyed reconciler
      // emits it for the item that lands last). The child is already in
      // this parent, so the containment check above would skip it.
      parent.appendChild(child);
    }

    if (focusedWithin && doc && doc.activeElement !== active) {
      active!.focus?.({ preventScroll: true });
    }

    if (isHostElement(previousParent) && previousParent !== parent) {
      this.components.notifyChildrenChanged(previousParent);
      reconcileColumnWidthDemandFrom(previousParent);
    }
    if (isHostElement(parent)) {
      this.components.notifyChildrenChanged(parent);
      reconcileColumnWidthDemandFrom(child);
    }

    // Dialog entering the document (insert or cached re-attach): queue mount
    // focus for the end of the batch (flushDialogMounts). Already-open
    // dialogs are filtered there, so moves never re-focus.
    if (this.dialogIds.has(id)) {
      this.pendingDialogMounts.push(id);
    }

    // Enter animation queue: only nodes created in this same batch qualify
    // (the animator checks), so a cached `attach` — routed through here —
    // never enter-animates.
    this.animator.noteInsert(id, child);

    // Scroll-source scrubs resolve their container at insert time (their
    // ancestors don't exist before this).
    this.scrubber.noteInsert(id, child);

    // DnD: an insert under a hovered list mid-drag invalidates its cached
    // geometry; during a post-drop hold an insert under the origin or
    // destination list is the re-render landing.
    this.dnd.noteStructural(parentId, id);
  }

  /**
   * Move an element within the tree
   */
  private onMove(parentId: string, id: string, beforeId?: string): void {
    this.onInsert(parentId, id, beforeId, true);
    // DnD no-flash contract: the engine's Move for a dropped reorder releases
    // the held local transforms (before the animator's flush measures Last,
    // so the `.layout()` FLIP animates from the ghost's on-screen rect).
    this.dnd.noteMove(parentId, id);
  }

  /**
   * Reinsert a cached (Router) subtree. Same DOM mechanics as insert, plus
   * the animator's attach hook: re-entering the document restarts every CSS
   * animation in the subtree, and finite-repeat `.animate` presets must not
   * replay on a cached re-attach (the `.animate` counterpart of the
   * "a cached attach never enter-animates" contract; looping presets resume).
   */
  private onAttach(parentId: string, id: string, beforeId?: string): void {
    this.onInsert(parentId, id, beforeId);
    const element = this.nodes.get(id);
    if (element) {
      this.animator.noteAttach(element);
      // Scroll-source scrubs anywhere in the re-attached subtree re-arm:
      // the attach patch names only the root, but descendants' scroll
      // listeners were detached with the route (Option G).
      this.scrubber.noteAttach(element);
    }
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
    const previousParent = element.parentNode;

    // A detach mid-drag cancels the scrub interaction cleanly (capture
    // released, styles restored, deferred writes applied) for EVERY scrubbed
    // node in the leaving subtree — a descendant's scroll listener on a
    // persistent app-shell scroller must not keep scrubbing an off-document
    // route. Entries survive for a cached re-attach (see onAttach).
    this.scrubber.cancelSubtree(element);
    // A detach mid-drag cancels the drag cleanly and dispatches NOTHING.
    this.dnd.cancelSubtree(element);

    // Remember where focus was inside the leaving route, so a cached
    // re-`attach` of this subtree can restore it (route-focus contract).
    const active = (element.ownerDocument?.activeElement ??
      (typeof document !== "undefined" ? document.activeElement : null)) as HTMLElement | null;
    if (active && (element === active || element.contains?.(active))) {
      this.routeFocusMemory.set(id, active);
    }

    if (element.parentNode) {
      element.parentNode.removeChild(element);
    }
    if (isHostElement(previousParent)) {
      this.components.notifyChildrenChanged(previousParent);
      reconcileColumnWidthDemandFrom(previousParent);
    }

    // Any open dialog inside the detached subtree just left the document:
    // restore its trigger (a trigger detached along with it fails the
    // connectivity check and is skipped — the route-focus contract owns
    // focus for the incoming route). Runs after the DOM unlink so the
    // connectivity check reflects the detach. dialogIds keeps the id — a
    // cached re-attach re-runs mount focus.
    this.restoreDialogsWithin(element);

    // If the root gets detached (unlikely but defensible), clear
    // rootId so a later attach can re-root cleanly.
    if (this.rootId === id) {
      this.rootId = null;
    }
  }

  /**
   * Close-side of the dialog focus contract: every open dialog at-or-under
   * `subtree` has left the document — restore focus to its remembered
   * trigger (when still connected) and drop the open entry so a later
   * insert/attach counts as a fresh mount.
   */
  private restoreDialogsWithin(subtree: HTMLElement): void {
    if (this.dialogOpeners.size === 0) return;
    for (const [dialogId, opener] of this.dialogOpeners) {
      const dialog = this.nodes.get(dialogId);
      if (!dialog || subtree === dialog || subtree.contains?.(dialog)) {
        this.dialogOpeners.delete(dialogId);
        if (dialog) restoreDialogFocus(dialog, opener);
      }
    }
  }

  /**
   * Remove an element from the tree.
   *
   * A `remove` flagged with `transition: true` whose root carries an
   * `__anim.exit` spec defers teardown: the animator plays the exit and runs
   * `finalizeRemove` when it settles. The engine emits the flagged root
   * BEFORE its descendants' plain removes, so descendant removes arriving
   * while an ancestor exits queue their finalize on that root — the subtree
   * stays intact until the exit finishes. Everything else (no flag, no spec,
   * unaware paths) tears down immediately.
   */
  private onRemove(id: string, transition = false): void {
    const element = this.nodes.get(id);
    if (!element) return;

    // Option G: an exiting/removed node's scrub sources detach IMMEDIATELY —
    // cancel fully (release capture, stop the settle rAF, never dispatch the
    // bind write) BEFORE any exit playback can begin, so the live gesture
    // and the exit never fight and a mid-settle arrival cannot write into a
    // dead node's bind path.
    this.scrubber.cancel(id);
    // Likewise a Remove mid-drag: cancel, release capture, dispatch nothing.
    this.dnd.cancel(id);

    if (
      transition &&
      this.animator.beginExit(id, element, () => this.finalizeRemove(id, element))
    ) {
      return;
    }

    if (this.animator.deferToExitingAncestor(element, () => this.finalizeRemove(id, element))) {
      return;
    }

    this.finalizeRemove(id, element);
  }

  /**
   * Tear an element down for real: shared by the instant path and the
   * deferred (exit-animated) path.
   */
  private finalizeRemove(id: string, element: HTMLElement): void {
    // Clean up canvas renderer if this is a canvas root
    if (this.canvasRenderers.has(id)) {
      this.canvasRenderers.get(id)!.destroy();
      this.canvasRenderers.delete(id);
      this.canvasElements.delete(id);
      // Remove all subtree entries pointing to this canvas root
      const members = this.canvasNodeChildren.get(id);
      if (members) {
        this.canvasNodeChildren.delete(id);
        for (const childId of members) {
          this.pruneCanvasSubtree(childId);
        }
      }
    }

    // Dispose event listeners and other resources before removing from DOM
    disposeHypenElement(element);

    // Read the parent before the unlink: on the deferred (exit-animated)
    // path the element is still attached until this runs.
    const previousParent = element.parentNode;
    if (element.parentNode) {
      element.parentNode.removeChild(element);
    }
    if (isHostElement(previousParent)) {
      this.components.notifyChildrenChanged(previousParent);
      reconcileColumnWidthDemandFrom(previousParent);
    }

    // Restore-to-trigger for any open dialog in the removed subtree, before
    // the node map forgets it. The removed subtree is gone for good, so the
    // dialog id is dropped too.
    this.restoreDialogsWithin(element);

    this.nodes.delete(id);
    this.handlerProps.delete(id);
    this.textBindings.delete(id);
    this.dialogIds.delete(id);
    this.animator.forget(id);
    // A remove mid-drag cancels everything and releases capture cleanly.
    this.scrubber.forget(id);
    this.dnd.forget(id);
    // Router LRU eviction: this subtree is gone for good — focus restore
    // must never target it again (route-focus contract).
    this.routeFocusMemory.delete(id);
    // A removed row under a hovered/held list is a structural change too.
    if (previousParent instanceof HTMLElement) {
      this.dnd.noteStructural(previousParent.dataset?.hypenId ?? null, id);
    }

    // The engine emits ONE Remove for a removed subtree's root on the keyed
    // and ForEach-rebuild paths (descendants get no Removes of their own),
    // so descendant bookkeeping must be swept here or it leaks for the life
    // of the renderer.
    this.sweepDetachedDescendants(element);

    if (this.rootId === id) {
      this.rootId = null;
    }
  }

  /**
   * Drop bookkeeping for every tracked node that lives inside a subtree
   * just torn out of the document. `root` is already detached, but its
   * internal `parentNode` links survive removal — descendants are found by
   * walking up to `root` (fake-dom has no `closest`/`contains`).
   */
  private sweepDetachedDescendants(root: HTMLElement): void {
    // Leaf roots have nothing to sweep.
    if (!root.firstElementChild) return;
    // Walk *down* the removed subtree. The previous implementation scanned
    // every tracked node in the renderer and walked each one's parentNode
    // chain looking for `root`, which is O(removes × total nodes): tearing
    // down a 1,000-row list touched ~17M entries. Descending costs
    // O(subtree) and reaches exactly the same set, since every element this
    // renderer tracks carries its id and children/parentNode are consistent
    // in both real DOM and fake-dom. Sibling traversal, not `children`: an
    // earlier version materialized `Array.from(children)` per node (~34k
    // array allocations per 1,000-row clear), and an indexed loop over the
    // live collection still built an HTMLCollection per element.
    walkElements(root, (desc) => {
      if (desc === root) return;
      // Component-internal wrapper elements are never registered and fall
      // through to the (empty) attribute read.
      const descId = (desc as ElementWithId)[ELEMENT_ID] ??
        (desc as { dataset?: Record<string, string | undefined> }).dataset?.hypenId;
      // Only forget the id if it still maps to *this* element: a recycled id
      // pointing elsewhere must not be swept out from under its live node.
      if (descId === undefined || this.nodes.get(descId) !== desc) return;
      disposeHypenElement(desc);
      this.nodes.delete(descId);
      this.handlerProps.delete(descId);
      this.textBindings.delete(descId);
      this.dialogIds.delete(descId);
      this.animator.forget(descId);
      this.scrubber.forget(descId);
      this.dnd.forget(descId);
      this.routeFocusMemory.delete(descId);
    });
  }

  /**
   * Slot identity belongs to the child, but its meaning belongs to the
   * native parent component (currently HypenApp). Keep that parent in sync
   * when a reactive SetProp/RemoveProp changes the assignment.
   */
  private notifyParentChildrenChanged(element: HTMLElement): void {
    const parent = element.parentNode;
    if (isHostElement(parent)) {
      this.components.notifyChildrenChanged(parent);
    }
  }

  /**
   * Get an element by ID
   */
  getNode(id: string): HTMLElement | undefined {
    return this.nodes.get(id);
  }

  /**
   * The `__anim.scrub*` runtime (Option G) — exposed for tests, which
   * override its injectable clock/rAF fields to drive drags and settles
   * deterministically (the canvas animator's `animator.now` pattern).
   */
  getScrubber(): DomScrubber {
    return this.scrubber;
  }

  /**
   * The `__dnd.*` runtime — exposed for tests, which override its timing
   * fields (`cleanupTimeoutMs`, `pressDelayMs`) to drive holds and presses
   * deterministically.
   */
  getDnd(): DomDnd {
    return this.dnd;
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
    this.canvasNodeChildren.clear();
    this.canvasNodeParent.clear();

    // Dispose all element resources before clearing
    for (const element of this.nodes.values()) {
      disposeHypenElement(element);
    }
    this.container.innerHTML = "";
    this.nodes.clear();
    this.textBindings.clear();
    this.animator.reset();
    this.scrubber.reset();
    this.dnd.reset();
    this.rootId = null;
    this.dialogIds.clear();
    this.dialogOpeners.clear();
    this.pendingDialogMounts = [];
    this.routeFocusMemory.clear();
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
