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

/**
 * Per-component-type props that map to HTML element attributes (not CSS).
 * SetProp for these names must go through the component's `applyProps`
 * (which writes the attribute), otherwise the applicator's CSS fallback
 * tries `el.style.<name>` and the update silently no-ops — most visibly
 * for `Image.src` updates that depend on async-loaded state (the social
 * `Your story` avatar that fills in once `state.currentUser` arrives).
 */
const COMPONENT_HTML_ATTRS: Record<string, Set<string>> = {
  image: new Set(["src", "alt", "url", "0", "srcset"]),
  input: new Set(["type", "placeholder", "value", "disabled", "readonly", "name", "checked"]),
  textarea: new Set(["placeholder", "value", "rows", "cols", "disabled", "readonly", "name"]),
  select: new Set(["name", "multiple", "disabled", "value"]),
  checkbox: new Set(["checked", "disabled", "name"]),
  radio: new Set(["checked", "disabled", "name", "value"]),
  link: new Set(["href", "target", "rel"]),
  // Route URL changes to the handler so it reconnects the embedded app
  // instead of the generic text branch overwriting the subtree.
  hypenapp: new Set(["0", "url"]),
  // Video contract (hypen-docs/content/docs/guide/components.mdx): every contract prop — media
  // sources, playback flags, headers, and the media event actions — must
  // reach videoHandler.applyProps on SetProp (the CSS fallback would
  // silently no-op them). Props can arrive as "controls" or "controls.0",
  // so both spellings are listed.
  video: new Set([
    "0",
    ...[
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
    ].flatMap((name) => [name, `${name}.0`]),
  ]),
  // Scrubber (Video v2): its bind path, seek action and value/duration
  // overrides are handler state, not CSS.
  scrubber: new Set([
    "0",
    ...["bind", "value", "position", "duration", "disabled", "onSeek"].flatMap(
      (name) => [name, `${name}.0`]
    ),
  ]),
};

import { ComponentRegistry } from "./components/index.js";
import { ApplicatorRegistry } from "./applicators/index.js";
import { DomAnimator } from "./anim.js";
import { DomScrubber } from "./scrub.js";
import { ANIM_PROP_PREFIX } from "@hypen-space/core/animation";
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
}

export class DOMRenderer {
  private container: HTMLElement;
  private nodes: Map<string, HTMLElement> = new Map();

  /** Registered template prototypes + per-node deferred event props. */
  private templateProtos: Map<
    string,
    { proto: HTMLElement; deferred: Array<Array<[string, any]>> }
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
  private pendingCreateProps = new Map<string, { elementType: string; props: Record<string, any> }>();
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

    // Option G precedence: a scrub-active node is excluded from transaction
    // application and enter/FLIP participation (scrub owns it).
    this.animator.setScrubActiveCheck((id) => this.scrubber.ownsNode(id));

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
    const build = (node: TemplateSkeletonNode): HTMLElement => {
      const index = deferred.length;
      const mine: Array<[string, any]> = [];
      deferred.push(mine);

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
      this.applicators.applyAll(element, staticProps);

      for (const child of node.children ?? []) {
        element.appendChild(build(child));
      }
      return element;
    };

    this.templateProtos.set(templateId, { proto: build(root), deferred });
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
    // the engine assigned ids in. Only elements stamped with hypenType
    // count — a component's internal wrapper elements are skipped, though
    // the walk still descends through them.
    const elements: HTMLElement[] = [];
    const collect = (el: HTMLElement): void => {
      if (el.dataset?.hypenType) {
        elements.push(el);
      }
      const kids = el.children as unknown as ArrayLike<HTMLElement> | undefined;
      if (kids?.length) {
        for (const child of Array.from(kids)) collect(child);
      }
    };
    collect(clone);
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
      setEngine(element, this.engine);
      this.nodes.set(ids[i], element);
    }
    // Per-node passes AFTER all ids are registered, so handlers that look
    // up related nodes resolve.
    //
    // Adoption first: a clone carries the prototype's DOM but none of its
    // JS-side state (WeakMap entries, listeners, media wiring), and the
    // passes below — deferred event props, `subs` — assume a live component.
    // Parents adopt before children (depth-first collect order), so a
    // Scrubber finds its enclosing Video already wired.
    for (const element of elements) {
      this.components.adopt(element);
    }
    for (const [index, semantics] of patch.nodeSemantics ?? []) {
      applySemantics(elements[index], semantics);
    }
    for (let i = 0; i < elements.length; i++) {
      for (const [key, value] of entry.deferred[i] ?? []) {
        this.onSetProp(ids[i], key, value);
      }
      if (elements[i].dataset.hypenType === "text") {
        this.syncTextBinding(ids[i], elements[i]);
      }
    }
    for (const [index, prop, value] of patch.subs ?? []) {
      this.onSetProp(ids[index], prop, value);
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

    // Split off `__anim.*` channel props: they configure the animator, and
    // must never reach the applicators (or their CSS fallback).
    let animProps: Record<string, any> | null = null;
    for (const key of Object.keys(propsObj)) {
      if (key.startsWith(ANIM_PROP_PREFIX)) {
        (animProps ??= {})[key] = propsObj[key];
      }
    }
    if (animProps) {
      const rest: Record<string, any> = {};
      for (const [key, value] of Object.entries(propsObj)) {
        if (!key.startsWith(ANIM_PROP_PREFIX)) rest[key] = value;
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

    // `__anim.*` channel props route to the animator + scrubber, never to
    // applicators. The scrubber consumes the `__anim.scrub*` channels and
    // watches `__anim.states` (its cleanup signal); the animator ignores
    // the scrub channels.
    if (name.startsWith(ANIM_PROP_PREFIX)) {
      this.scrubber.setAnimProp(id, element, name, value);
      this.animator.setAnimProp(id, element, name, value);
      return;
    }

    // Scrub conflict rule (Option G, gesture wins): while a drag/settle is
    // active on this node, engine writes to its SCRUBBED prop keys are
    // deferred — latest value stored, applied at cleanup. Other props flow
    // normally.
    if (this.scrubber.deferEngineProp(id, name, value)) {
      return;
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
      if (elementType && COMPONENT_HTML_ATTRS[elementType]?.has(name)) {
        const handler = this.components.get(elementType);
        if (handler?.applyProps) {
          handler.applyProps(element, { [name]: value });
          return;
        }
      }

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
    const elementType = element.dataset.hypenType;
    if (elementType && COMPONENT_HTML_ATTRS[elementType]?.has(name)) {
      const handler = this.components.get(elementType);
      if (handler?.applyProps) {
        handler.applyProps(element, { [name]: value });
        return;
      }
    }

    this.applicators.apply(element, name, value);

    // Forward canvas dimension changes to its CanvasRenderer
    if ((name === "width" || name === "height") && this.canvasRenderers.has(id)) {
      const canvasEl = this.canvasElements.get(id)!;
      this.canvasRenderers.get(id)!.resize(canvasEl.width, canvasEl.height);
    }
  }

  /**
   * Remove a property from an element
   */
  private onRemoveProp(id: string, name: string): void {
    const element = this.nodes.get(id);
    if (!element) return;

    if (name.startsWith(ANIM_PROP_PREFIX)) {
      this.scrubber.removeAnimProp(id, element, name);
      this.animator.removeAnimProp(id, element, name);
      return;
    }

    this.debugTracker.trackRerender(id, element, `removeProp:${name}`);

    if (name === "slot.0" || name === "slot") {
      delete element.dataset.hypenSlot;
      this.notifyParentChildrenChanged(element);
      return;
    }

    this.applicators.apply(element, name, undefined);
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
  private onInsert(parentId: string, id: string, beforeId?: string): void {
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

    if (beforeId) {
      const before = this.nodes.get(beforeId);
      if (before && before.parentNode === parent) {
        parent.insertBefore(child, before);
      } else if (!parent.contains(child)) {
        parent.appendChild(child);
      }
    } else {
      if (!parent.contains(child)) {
        parent.appendChild(child);
      }
    }

    if (previousParent instanceof HTMLElement && previousParent !== parent) {
      this.components.notifyChildrenChanged(previousParent);
    }
    if (parent instanceof HTMLElement) {
      this.components.notifyChildrenChanged(parent);
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
  }

  /**
   * Move an element within the tree
   */
  private onMove(parentId: string, id: string, beforeId?: string): void {
    this.onInsert(parentId, id, beforeId);
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
    if (previousParent instanceof HTMLElement) {
      this.components.notifyChildrenChanged(previousParent);
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
    if (previousParent instanceof HTMLElement) {
      this.components.notifyChildrenChanged(previousParent);
    }

    // Restore-to-trigger for any open dialog in the removed subtree, before
    // the node map forgets it. The removed subtree is gone for good, so the
    // dialog id is dropped too.
    this.restoreDialogsWithin(element);

    this.nodes.delete(id);
    this.textBindings.delete(id);
    this.dialogIds.delete(id);
    this.animator.forget(id);
    // A remove mid-drag cancels everything and releases capture cleanly.
    this.scrubber.forget(id);
    // Router LRU eviction: this subtree is gone for good — focus restore
    // must never target it again (route-focus contract).
    this.routeFocusMemory.delete(id);

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
    // Leaf roots have nothing to sweep (`children`, not `firstChild` —
    // fake-dom only models element children).
    if (!root.children?.length) return;
    // Walk *down* the removed subtree. The previous implementation scanned
    // every tracked node in the renderer and walked each one's parentNode
    // chain looking for `root`, which is O(removes × total nodes): tearing
    // down a 1,000-row list touched ~17M entries. Descending costs
    // O(subtree) and reaches exactly the same set, since every element this
    // renderer tracks carries `dataset.hypenId` and children/parentNode are
    // consistent in both real DOM and fake-dom.
    //
    // Indexed reads over the live HTMLCollection, deliberately: an earlier
    // version materialized `Array.from(children)` per visited node, which
    // made this sweep the hottest frame of a full-list clear (~34k array
    // allocations for 1,000 rows). The collections aren't mutated during
    // the walk, so index access is stable.
    const pushKids = (stack: HTMLElement[], el: HTMLElement): void => {
      const kids = el.children as unknown as ArrayLike<HTMLElement> | undefined;
      if (!kids) return;
      for (let i = kids.length - 1; i >= 0; i--) {
        stack.push(kids[i]!);
      }
    };

    const stack: HTMLElement[] = [];
    pushKids(stack, root);
    while (stack.length > 0) {
      const desc = stack.pop()!;
      pushKids(stack, desc);
      const descId = (desc as { dataset?: Record<string, string | undefined> })
        .dataset?.hypenId;
      // Only forget the id if it still maps to *this* element: a recycled id
      // pointing elsewhere must not be swept out from under its live node.
      if (descId === undefined || this.nodes.get(descId) !== desc) continue;
      disposeHypenElement(desc);
      this.nodes.delete(descId);
      this.textBindings.delete(descId);
      this.dialogIds.delete(descId);
      this.animator.forget(descId);
      this.scrubber.forget(descId);
      this.routeFocusMemory.delete(descId);
    }
  }

  /**
   * Slot identity belongs to the child, but its meaning belongs to the
   * native parent component (currently HypenApp). Keep that parent in sync
   * when a reactive SetProp/RemoveProp changes the assignment.
   */
  private notifyParentChildrenChanged(element: HTMLElement): void {
    const parent = element.parentNode;
    if (parent instanceof HTMLElement) {
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
