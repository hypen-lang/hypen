/**
 * Core types shared across the engine and runtime.
 *
 * These types are intentionally decoupled from the WASM engine so that
 * packages can import them without pulling in any WASM code.
 */

export type Patch = {
  /**
   * Patch variant.
   *
   * `detach` / `attach` are used by the engine's Router subtree cache
   * to keep off-screen route content alive between navigations. On
   * `detach`, the renderer must unlink the subtree from its parent
   * but keep the underlying native element (and its children) alive
   * under the same id, so a later `attach` can reinsert it with zero
   * rebuild. If `remove` arrives for a detached id instead, the
   * subtree is torn down normally.
   */
  type:
    | "create"
    | "setProp"
    | "removeProp"
    | "setText"
    | "insert"
    | "move"
    | "remove"
    | "attachEvent"
    | "detachEvent"
    | "detach"
    | "attach"
    | "setSemantics"
    | "batchAnimation"
    | "registerTemplate"
    | "instantiate";
  id?: string;
  elementType?: string;
  props?: Record<string, any>;
  /**
   * Accessibility semantics derived by the engine for this node. Carried on
   * `create` (first paint) and on `setSemantics` (reactive change — a
   * templated accessible name or bound state whose source path changed).
   * A `setSemantics` always carries the node's **complete** resolved block;
   * renderers re-apply it with the same translation they run at create,
   * clearing anything the new block no longer sets. Absent on `create` when
   * the node has nothing derivable; absent on `setSemantics` when the node
   * lost all semantics (→ clear everything).
   */
  semantics?: Semantics;
  name?: string;
  value?: any;
  text?: string;
  parentId?: string;
  beforeId?: string;
  eventName?: string;
  /**
   * On `remove`: `true` when the removed subtree's root carries an
   * `__anim.exit` spec and the renderer should play the exit animation
   * before tearing the element down. Engine-side the id is already dead —
   * the renderer owns deferred finalization (no ack round-trip). A flagged
   * root is emitted BEFORE its descendants' plain removes so the renderer
   * learns the subtree is exiting first. Absent/false — and in renderers
   * that don't understand the flag — removal is immediate (sanctioned snap).
   */
  transition?: boolean;
  /**
   * On `batchAnimation` (Option D cheap subset — transaction-scoped
   * animation): the normalized animation spec object, e.g.
   * `{ curve: "spring", duration: 250 }`. A `batchAnimation` patch is
   * emitted as the FIRST patch of a render cycle whose triggering state
   * update carried an animation context (`updateState` /
   * `updateStateSparse` with the optional `animation` argument). It
   * addresses no node — it scopes the *batch*: renderers that understand
   * it animate every whitelisted prop change in the patches that follow
   * using this spec (precedence: batch spec > node `.transition` default >
   * snap). Renderers that don't know the type ignore it and snap — the
   * rest of the batch is wire-identical to an unstamped one.
   */
  spec?: any;
  /**
   * Template instantiation — permanent wire citizens: the engine ALWAYS
   * emits these two kinds when an iterable row is plannable as a
   * template. Consumers either exploit them (the DOM renderer clones a
   * prototype element per instance) or lower them back into the plain
   * `create`+`insert` run they replace via `TemplateExpander`
   * (`@hypen-space/core/patch-expand` — Canvas renderer, remote
   * streaming boundaries).
   *
   * `registerTemplate` carries `templateId` + `root` — a static skeleton
   * tree `{elementType, props, children}` sent once per template.
   * `instantiate` carries `templateId`, `parentId`/`beforeId`, `nodes`
   * (per-element ids, depth-first over the template) and `subs`
   * (`[nodeIndex, prop, value]` triples for every dynamic prop), plus
   * optional `semantics` (`[nodeIndex, block]` pairs).
   */
  templateId?: string;
  root?: TemplateSkeletonNode;
  nodes?: string[];
  subs?: Array<[number, string, any]>;
  /**
   * On `instantiate`: per-node accessibility semantics. (On `create` /
   * `setSemantics` the single-node `semantics` field above is used.)
   */
  nodeSemantics?: Array<[number, Semantics]>;
};

/** Static skeleton node of a registered template (see `registerTemplate`). */
export type TemplateSkeletonNode = {
  elementType: string;
  props: Record<string, any>;
  children: TemplateSkeletonNode[];
};

/**
 * Platform-neutral accessibility semantics for a node, derived in the engine
 * and carried on `create` patches. Each renderer maps this onto its native
 * accessibility model (ARIA attributes on DOM, `Modifier.semantics` on
 * Compose, accessibility traits on SwiftUI).
 *
 * Every field is optional; an absent field means "nothing derivable".
 */
export type Semantics = {
  /**
   * What this node is, as a platform-neutral role token (e.g. `"button"`).
   * Mirrors the ARIA role vocabulary. Emitted only where the role is
   * structurally certain from the component type.
   */
  role?: string;
  /** Heading level (1–6) when known. */
  level?: number;
  /** Whether the node represents in-progress content (maps to `aria-busy`). */
  busy?: boolean;
  /**
   * Live-region politeness (`.liveRegion("polite" | "assertive")`) →
   * `aria-live` on DOM and the Canvas shadow tree. The engine validates the
   * token, so only those two values arrive. Travels untranslated to the
   * native renderers (no direct analog wired yet).
   */
  live?: string;
  /**
   * Accessible name derived from the element's text content, for roles that
   * require one. On DOM this is usually left unapplied — the browser derives
   * the name from visible content — but renderers without that affordance
   * (Canvas shadow tree, iOS, Android) use it directly.
   */
  name?: string;
  /**
   * `true` when the element's role requires a name but none could be derived
   * (e.g. an icon-only button). Surfaced by dev-mode conformance checks; the
   * fix is an explicit label.
   */
  nameMissing?: boolean;
  /**
   * `true` when {@link name} came from an explicit author `.label(...)` rather
   * than derived content. DOM applies an explicit name as `aria-label` (an
   * intentional override) but leaves a derived name to the visible content.
   */
  nameExplicit?: boolean;
  /**
   * `true` when the element was marked decorative via `.hidden()`. It is
   * removed from the accessibility tree (`aria-hidden`).
   */
  hidden?: boolean;
  /**
   * Supplementary description (`.description(...)`) — extra context beyond the
   * name. Applied as `aria-description` on DOM.
   */
  description?: string;
  /** Disclosure state → `aria-expanded`. */
  expanded?: boolean;
  /** Toggle-button state → `aria-pressed`. */
  pressed?: boolean;
  /** Selected state (e.g. a tab) → `aria-selected`. */
  selected?: boolean;
  /** Current-item token (page/step/…) → `aria-current`. */
  current?: string;
  /**
   * Checked state for a `Checkbox`/`Switch` bound via `.bind(@state.x)` →
   * `aria-checked`. Resolved at reconcile from the control's bind-target value.
   */
  checked?: boolean;
  /**
   * Validity state for a form control (`.invalid(bool | @state.hasError)`) →
   * `aria-invalid`. A bound value resolves at reconcile and stays live via
   * `setSemantics` re-emits. DOM only for now.
   */
  invalid?: boolean;
  /**
   * Cross-node relationship: id of the element this node controls →
   * `aria-controls`. Web-leaning (DOM only); id references do not survive to
   * the string-hint native APIs. See the guide's "Platform support" section
   * (`hypen-docs/content/docs/guide/accessibility.mdx`).
   */
  controls?: string;
  /**
   * Cross-node relationship: id of the element that describes this node →
   * `aria-describedby`. Web-leaning (DOM only), as with `controls`.
   */
  describedby?: string;
  /**
   * The author-supplied stable id of this node (`.id("details-panel")`) —
   * the anchor id-reference relationships resolve against. Applied as the
   * DOM `id` attribute.
   */
  id?: string;
  /**
   * Cross-node relationship: id of the element that labels this node →
   * `aria-labelledby` (the tabpanel→tab half of the Tabs pattern). DOM only.
   */
  labelledby?: string;
  /**
   * Reactive cross-node reference: id of the currently-active descendant →
   * `aria-activedescendant` (the roving focus pointer of composite widgets).
   * Usually bound (`.activedescendant(@state.focusedId)`); kept live via
   * `setSemantics` re-emits. DOM only.
   */
  activeDescendant?: string;
  /**
   * Cross-node relationship: id of an element that is logically this node's
   * child but rendered elsewhere (a portaled popup) → `aria-owns`. DOM only.
   */
  owns?: string;
  /**
   * Base text direction (`.dir("rtl" | "ltr" | "auto")`) → the HTML `dir`
   * attribute on DOM. The engine validates the token, so only those three
   * values arrive. Native renderers translate to their layout-direction
   * APIs (follow-up; the value already travels on the block).
   */
  dir?: string;
};

export type Action = {
  name: string;
  payload?: any;
  sender?: string;
  /**
   * Transaction-scoped animation stamp (Option D cheap subset): the
   * `animate:` argument of the event applicator that dispatched this action
   * (`.onClick(@actions.toggle, animate: spring)`) — either a bare curve
   * token string or a `{ curve, duration, ... }` spec object. Carried as a
   * DISTINCT field, never inside `payload`: the renderer extracts it from
   * the applicator args before dispatch (crossing the WASM boundary under
   * {@link ACTION_ANIMATE_KEY}) and `BaseEngine.onAction` lifts it back out,
   * so module handlers never see it in their payload. The SDK's module
   * runtime consumes it as the pending animation for the FIRST state flush
   * the handler produces (see `HypenModuleInstance`).
   */
  animate?: any;
};

/**
 * Reserved payload key that carries an event's `animate:` stamp across the
 * engine dispatch boundary. `dispatchAction(name, payload)` is the only
 * channel through the WASM engine, so renderers smuggle the stamp inside the
 * payload under this key; `BaseEngine.onAction` strips it back out into
 * `Action.animate` before any handler sees the payload. Handlers therefore
 * never observe this key — it exists only on the wire.
 */
export const ACTION_ANIMATE_KEY = "__hypenAnimate";

export type RenderCallback = (patches: Patch[]) => void;
export type ActionHandler = (action: Action) => void | Promise<void>;

export type ResolvedComponent = {
  source: string;
  path: string;
};

export type ComponentResolver = (
  componentName: string,
  contextPath: string | null
) => ResolvedComponent | null;


// ---------------------------------------------------------------------------
// Video v2: playback binding & composition slots
// (hypen-docs/content/docs/guide/components.mdx §"Playback control & composition slots")
// ---------------------------------------------------------------------------

/** Normative player states — slot visibility and `PlaybackBinding.state`
 * use these names verbatim. */
export type VideoPlayerState =
  | "idle"
  | "loading"
  | "playing"
  | "paused"
  | "ended"
  | "error";

/**
 * The struct `Video(...).bind(@state.playback)` keeps in sync.
 * `playing`/`position` are read-write (a `position` write is a seek);
 * `duration`/`state` are renderer-owned and read-only.
 */
export type PlaybackBinding = {
  playing: boolean;
  position: number;
  duration: number;
  state: VideoPlayerState;
};

/** Renderer → state position reports are throttled to this interval
 * while playing; transitions (play/pause/seek/ended/error) always
 * report immediately. */
export const PLAYBACK_REPORT_INTERVAL_MS = 250;

/** A `position` write only seeks when it differs from the renderer's
 * actual position by more than this — prevents the renderer's own
 * progress reports from echoing back as seeks. */
export const PLAYBACK_SEEK_EPSILON_S = 1;

/** Video composition slot names (children tagged `.slot(name)`). */
export const VIDEO_SLOTS = ["controls", "loading", "error", "poster"] as const;
export type VideoSlotName = (typeof VIDEO_SLOTS)[number];

/**
 * Normative slot visibility by player state — every renderer keys
 * show/hide off this single table. A present slot replaces the
 * built-in for that concern (controls slot suppresses native chrome,
 * error slot replaces the built-in error surface, poster slot
 * replaces the `poster` prop image, loading replaces any spinner).
 */
export const VIDEO_SLOT_VISIBILITY: Record<
  VideoSlotName,
  Record<VideoPlayerState, boolean>
> = {
  poster: {
    idle: true,
    loading: true,
    playing: false,
    paused: false,
    ended: true,
    error: false,
  },
  loading: {
    idle: false,
    loading: true,
    playing: false,
    paused: false,
    ended: false,
    error: false,
  },
  controls: {
    // Visible in idle so a custom controls slot can start first play
    // (play-button-over-poster), and in loading so a buffering stream
    // still offers its transport (a stalled stream must not strand the
    // viewer with only a spinner).
    idle: true,
    loading: true,
    playing: true,
    paused: true,
    ended: true,
    error: false,
  },
  error: {
    idle: false,
    loading: false,
    playing: false,
    paused: false,
    ended: false,
    error: true,
  },
};
