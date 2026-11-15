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
   *
   * `clearChildren` empties element `id` in one step: exactly a plain
   * `remove` (no `transition`) of each of its current children — every
   * child subtree is torn down, `id` keeps its own props and may receive
   * new children later in the same batch. Unknown `id` is ignored. See
   * `hypen-web/docs/clear-children.md`.
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
    | "clearChildren"
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


// ---------------------------------------------------------------------------
// External capability surface
// (hypen-engine-rs/src/agent.rs §"The rule")
//
// The shapes the engine's `listActions` / `listRoutes` / `listBindings`
// return. They describe what a caller that is NOT the rendered UI — an MCP
// server, a REST endpoint, a CLI, an agent — may reach, and each list is an
// allowlist derived from a developer declaration: `.onAction()` for actions,
// `Router { Route }` for navigation, `.bind(@state.x)` for inputs. Nothing
// else is externally reachable, so these types double as the tool schema a
// transport publishes.
// ---------------------------------------------------------------------------

/**
 * External name of the navigation built-in — dispatch it with `{ to }`.
 * Maps to `router.push` inside the engine.
 *
 * The `hypen.` namespace is not decoration: a bare `navigate` collides with
 * real module actions (core's own `Link` declares `.onAction("navigate")`),
 * and the whole prefix is reserved so a module cannot shadow a built-in and
 * change what a caller thinks it is invoking.
 *
 * These three mirror `NAVIGATE` / `BACK` / `SET_INPUT` in
 * `hypen-engine-rs/src/agent.rs`, which stays the source of truth — the
 * tests dispatch through these constants so a rename there fails loudly
 * here rather than drifting.
 */
export const AGENT_NAVIGATE = "hypen.navigate";

/** External name of the history-back built-in. Maps to `router.back`. */
export const AGENT_BACK = "hypen.back";

/**
 * External name of the input-setting built-in — dispatch it with
 * `{ field, value }`, where `field` must be a path `listBindings()` reports.
 * Maps to `__hypen_bind`, but only after that validation.
 */
export const AGENT_SET_INPUT = "hypen.set_input";

/** One externally dispatchable action, as `listActions()` reports it. */
export type AgentAction = {
  /**
   * Name to pass to `dispatchExternal`. For module actions this is the
   * declared action name; for built-ins it is the external alias
   * ({@link AGENT_NAVIGATE} / {@link AGENT_BACK} / {@link AGENT_SET_INPUT}),
   * never the internal `router.*` / `__hypen_bind` name behind it.
   */
  name: string;
  /** Owning module scope (lowercased). `null` for the primary module and for built-ins. */
  module: string | null;
  /** True for framework-provided capabilities, false for module actions. */
  builtin: boolean;
};

/** A declared route, as a target for the {@link AGENT_NAVIGATE} built-in. */
export type AgentRoute = {
  /** The pattern exactly as declared (e.g. `/user-profile/:id`). */
  path: string;
  /** Names of the `:param` segments, in order. Empty for a static route. */
  params: string[];
  /** Module scope of the enclosing `Router`, if any. */
  moduleScope: string | null;
};

/** One `.bind()`-declared writable input — {@link AGENT_SET_INPUT}'s schema. */
export type BoundInput = {
  /** State path the bind writes — the exact string `field` must carry. */
  path: string;
  /**
   * Prop the value lands on: `value`, `checked`, `on` or `playback`. Mirrored
   * from the element type because it types the field without a state read —
   * `checked` / `on` mean boolean.
   */
  prop: string;
  /** Element type that declared the bind (`Input`, `Checkbox`, …). */
  elementType: string;
  /** Module scope of the declaring element, if any. */
  moduleScope: string | null;
};

// ============================================================================
// HOSTED (WASM-COMPONENT) MODULES
// ============================================================================
//
// The engine's hosted-module surface (`BaseEngine.registerHostedModule` et
// al.). It exists only in server engine builds; check
// `BaseEngine.supportsHostedModules` first. The shapes mirror
// `hypen-engine-rs/src/wasm/js_modules.rs` and `src/hosted/report.rs`.

import type { HttpCompletion, HttpFailureKind } from "./http.js";

/**
 * The completion payload a module receives for a deferred HTTP request, and
 * its `error.kind` — defined with the rest of the deferred-HTTP contract in
 * `@hypen-space/core/http`.
 */
export type { HttpCompletion, HttpFailureKind } from "./http.js";

/**
 * The object the engine drives hosted modules through: a `JsModuleHost` from
 * `@hypen-space/module-host`, or anything with the same synchronous methods.
 * Typed loosely on purpose — core does not depend on that package.
 */
export interface ModuleHostLike {
  register(name: string, bytes: Uint8Array, manifest: unknown): void;
  instantiate(name: string): number;
  destroy(id: number): void;
  init(id: number, config: Uint8Array): Uint8Array;
  dispatch(id: number, state: Uint8Array, action: any, siblings: any): unknown;
  onActivated(id: number, state: Uint8Array, siblings: any): unknown;
  onDeactivated(id: number, state: Uint8Array): unknown;
  onDestroyed(id: number, state: Uint8Array): void;
  actions(id: number): string[];
}

/** A hosted module's capability manifest. Everything omitted is denied. */
export type HostedModuleManifest = {
  name?: string;
  version?: string;
  /** Storage scopes granted besides the always-granted `local`. */
  storage?: Array<"local" | "app" | "cloud">;
  /** Scopes (hosted or in-process) whose state the module may read and subscribe to. */
  reads?: string[];
  /** Scopes (hosted or in-process) the module may dispatch actions to. */
  dispatches?: string[];
  /** Outbound HTTP: blocking `wasi:http` and deferred `hypen:http/deferred`. */
  http?: boolean;
  /**
   * Hosts `http` is limited to: `api.example.com`, `*.example.com` (any
   * subdomain, not the apex), either with `:port`. Omitted or empty = any
   * host. A malformed pattern is an `invalidArgument` at registration.
   */
  httpHosts?: string[];
};

/** Options of `registerHostedModule`. */
export type HostedModuleOptions = {
  /**
   * Name the component is registered and prepared under in the module host.
   * Defaults to the scope.
   */
  component?: string;
  manifest?: HostedModuleManifest;
  /** `init` config: JSON-encoded, or a `Uint8Array` passed as is. Default `{}`. */
  config?: unknown;
  /** Action-list override. Default: the module's own `actions` export. */
  actions?: string[];
};

/** One hosted module, as registration returns it and `hostedModules()` lists it. */
export type HostedModuleInfo = {
  /** The scope it is wired under (lowercase). */
  scope: string;
  /** Its component name in the module host. */
  component: string | null;
  /** The host's instance id. */
  instanceId: number | null;
  /** The actions it lists by name (never `"*"`). */
  actions: string[];
  /** Whether it also accepts any other application action. */
  wildcard: boolean;
};

/**
 * A deferred HTTP request (`hypen:http/deferred`) the engine admitted, for
 * the embedder to perform. Shape: `http_effect_js` in
 * `hypen-engine-rs/src/wasm/js_modules.rs`.
 */
export type HostedModuleHttpEffect = {
  type: "http";
  /** The engine's handle for the request: pass it to `completeHttpRequest`. */
  id: number;
  request: {
    method: string;
    url: string;
    /** `[name, value]` pairs, in order. */
    headers: Array<[string, string]>;
    body: Uint8Array | null;
    /** The effective time budget (defaulted to 30 s, clamped to 120 s). */
    timeoutMs: number;
  };
  /** The action the completion is dispatched as (informational). */
  then: string;
  tag: string | null;
  /**
   * The module's `httpHosts` allowlist; `null` = any host. Do not match it
   * by hand: ask `httpRedirectAllowed(id, url)` before following a redirect.
   */
  allowedHosts: string[] | null;
};

/** An effect a hosted reducer returned that only the embedder can perform. */
export type HostedModuleEffect =
  | { type: "navigate"; path: string }
  /** After `ms`, dispatch `then` to the module (`dispatchModuleAction`). */
  | { type: "delay"; ms: number; then: string }
  /** Perform the request, then report it with `completeHttpRequest(id, result)`. */
  | HostedModuleHttpEffect;

/**
 * How a deferred HTTP request ended, as the embedder reports it to
 * `completeHttpRequest`. Any status is a completed exchange (`ok: true`);
 * `ok: false` means there is no response at all.
 */
export type HttpCompletionResult =
  | {
      ok: true;
      status: number;
      /** `{ name: value | values }` or `[name, value]` pairs, as received. */
      headers?: Record<string, string | string[]> | Array<[string, string]>;
      /** A string is sent as its UTF-8 bytes; absent = empty. */
      body?: Uint8Array | ArrayBuffer | string | null;
    }
  | { ok: false; error: { kind: HttpFailureKind; message?: string } };

/** Whether `value` is an {@link HttpCompletion} (e.g. an action's payload). */
export function isHttpCompletion(value: unknown): value is HttpCompletion {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.tag !== null && typeof v.tag !== "string") return false;
  if (v.ok === true) {
    return (
      typeof v.status === "number" &&
      typeof v.body === "string" &&
      (v.bodyEncoding === "utf8" || v.bodyEncoding === "base64") &&
      v.headers !== null &&
      typeof v.headers === "object"
    );
  }
  if (v.ok !== false || v.error === null || typeof v.error !== "object") return false;
  const error = v.error as Record<string, unknown>;
  return typeof error.kind === "string" && typeof error.message === "string";
}

// ── `context.http`: what a module author writes ─────────────────────────────

/** A request for `context.http.send`. */
export interface ModuleHttpRequest {
  /** Default: `"GET"`, or `"POST"` when there is a `body`. */
  method?: string;
  /** Absolute `http://` or `https://` URL (ASCII; percent-encode anything else). */
  url: string;
  /** A plain object or `[name, value]` pairs. */
  headers?: Record<string, string> | ReadonlyArray<readonly [string, string]>;
  /**
   * A string (sent as UTF-8; `content-type: text/plain;charset=UTF-8` unless
   * set), bytes (sent as they are), or any other JSON-serialisable value
   * (sent as JSON; `content-type: application/json` unless set).
   */
  body?: unknown;
  /** Time budget for the whole exchange, in milliseconds (default 30 s, capped at 120 s). */
  timeoutMs?: number;
}

/** Where a request's completion goes. */
export interface ModuleHttpCompletionTarget {
  /**
   * The action of THIS module that is dispatched when the request completes
   * or fails, with an {@link HttpCompletion} as `action.payload`.
   */
  then: string;
  /** Echoed back as `payload.tag`, so one handler can tell requests apart. */
  tag?: string;
}

/** Why `context.http.send` refused a request. */
export type ModuleHttpErrorCode =
  /** The module has no `http` grant (`wasm.modules.<Name>.http` in hypen.json). */
  | "not-granted"
  /** The host is outside the module's `httpHosts`, or nothing can be queued from here. */
  | "permission-denied"
  /** Malformed: method, URL, header, timeout, or `then` is not one of the module's actions. */
  | "invalid-request"
  /** A bound was exceeded: 16 requests per call, URL 8 KiB, headers 16 KiB, body 1 MiB. */
  | "limit-exceeded"
  /** This runtime has no `context.http` (an in-process TypeScript module: use `fetch`). */
  | "unavailable";

/** What `context.http.send` / `get` throw. Recognise it with {@link isModuleHttpError}. */
export interface ModuleHttpError extends Error {
  name: "ModuleHttpError";
  code: ModuleHttpErrorCode;
  /** The host's own message, without the hint. */
  detail: string;
}

/** Whether `err` was thrown by `context.http` because a request was refused. */
export function isModuleHttpError(err: unknown): err is ModuleHttpError {
  return (
    err instanceof Error &&
    err.name === "ModuleHttpError" &&
    typeof (err as { code?: unknown }).code === "string"
  );
}

/**
 * `context.http`: outbound HTTP for a module that runs as a WASM component
 * (`hypen build --target wasm`). A reducer cannot wait for a response, so a
 * request is *queued*: the call returns at once, the host performs the
 * request after the handler returns, and the response arrives as a new
 * action.
 *
 * ```ts
 * .onAction("refresh", ({ state, context }) => {
 *   state.loading = true;
 *   context.http.get("https://api.example.com/forecast", { then: "loaded" });
 * })
 * .onAction("loaded", ({ action, state }) => {
 *   const response = action.payload as HttpCompletion;
 *   state.loading = false;
 *   if (response.ok && response.status === 200) state.forecast = JSON.parse(response.body);
 *   else state.error = response.ok ? `HTTP ${response.status}` : response.error.message;
 * })
 * ```
 *
 * Needs `"http": true` under `wasm.modules.<Name>` in hypen.json
 * (`httpHosts` narrows it to an allowlist).
 */
export interface ModuleHttp {
  /**
   * Queue `request`; when it completes or fails, `on.then` is dispatched to
   * this module with the {@link HttpCompletion}. Returns nothing: accepted
   * means queued, not sent.
   *
   * @throws {ModuleHttpError} when the request is refused (see
   *   {@link ModuleHttpErrorCode}); nothing was queued.
   */
  send(request: ModuleHttpRequest, on: ModuleHttpCompletionTarget): void;
  /** `send({ method: "GET", url, headers, timeoutMs }, on)`. */
  get(
    url: string,
    on: ModuleHttpCompletionTarget & Pick<ModuleHttpRequest, "headers" | "timeoutMs">,
  ): void;
}

/**
 * Receives `(scope, effect)`. Runs while the engine call that produced the
 * effect is still in progress, so it must not call the engine synchronously.
 */
export type HostedModuleEffectHandler = (
  scope: string,
  effect: HostedModuleEffect,
) => void;

/** Why an action was going to run in a module. */
export type ModuleCascadeOrigin =
  | { kind: "root" }
  | { kind: "lifecycle"; hook: "activated" | "deactivated" }
  | { kind: "emit" }
  | { kind: "crossDispatch"; from: string }
  | { kind: "subscriptionChange"; target: string; path: string }
  | { kind: "subscribeRequest"; target: string; path: string }
  /** A deferred HTTP request the module queued (admission refused it). */
  | { kind: "httpRequest"; method: string; url: string }
  /** The completion (`ok: false`, `denied`) of a request that was refused at admission. */
  | { kind: "httpRefusal" };

/** Why it did not run (or a subscription was not registered). */
export type ModuleCascadeCause =
  | { code: "unknownModule" | "notAccepted" | "noHost" | "noStateSlot" }
  | { code: "dispatchDenied"; grant: "dispatches"; missingGrant: string }
  | { code: "readDenied"; grant: "reads"; missingGrant: string }
  | { code: "subscriptionLimit" | "depthExceeded"; limit: number }
  | { code: "budgetExhausted"; budget: number; dropped: number }
  | { code: "payloadNotJson" | "handler" | "stateEncoding"; detail: string }
  /** A deferred HTTP request from a module without the `http` grant. */
  | { code: "httpNotGranted"; grant: "http" }
  /** A deferred HTTP request to a host (`host:port`) outside `httpHosts`. */
  | { code: "httpDenied"; grant: "httpHosts"; host: string }
  /** A malformed or oversized deferred HTTP request. */
  | { code: "httpInvalid"; detail: string }
  /** Too many deferred HTTP requests: in one call, or in flight for the module. */
  | { code: "httpLimit"; limit: number; per: "call" | "module" }
  /** No effect handler is installed: nothing can perform the request. */
  | { code: "httpUnavailable" }
  | {
      code: "host";
      host: {
        code:
          | "unknownModule"
          | "deadInstance"
          | "moduleError"
          | "trap"
          | "instantiate"
          | "codec"
          | "runtime";
        message: string;
      };
    }
  | { code: "invalidState"; reason: "notJson" | "notAnObject"; detail?: string };

/** One refusal or failure met during a cascade. */
export type ModuleCascadeFailure = {
  /** The module the action was addressed to (for a refused subscription: the subscriber). */
  scope: string;
  /** The action name (a lifecycle call: `<on_activated>` / `<on_deactivated>`). */
  action: string;
  /** A policy said no / a cap was hit / it ran and broke. */
  outcome: "refused" | "dropped" | "failed";
  /** Whether this is the cascade's root call itself (then nothing was applied). */
  isRoot: boolean;
  origin: ModuleCascadeOrigin;
  cause: ModuleCascadeCause;
  /** The rendered one-line description. */
  message: string;
};

/** The failures of one module cascade. */
export type ModuleCascadeReport = {
  root: {
    kind: "dispatch" | "lifecycle" | "hostWrite";
    scope: string;
    /** The dispatched name, `<on_activated>` / `<on_deactivated>`, or `<host state update>`. */
    action: string;
    hook?: "activated" | "deactivated";
  };
  /** The root call itself failed: nothing was applied. */
  rootFailed: boolean;
  /** Exact; `failures` holds at most the first 8. */
  failureCount: number;
  failures: ModuleCascadeFailure[];
  message: string;
};

/** The stable `code` of a {@link HostedModuleError}. */
export type HostedModuleErrorCode =
  | "invalidArgument"
  | "invalidName"
  | "noModuleHost"
  | "modulesRegistered"
  | "alreadyRegistered"
  | "scopeInUse"
  | "unknownModule"
  | "actionNotAccepted"
  | "hostError"
  | "invalidState"
  | "moduleCallFailed"
  | "cascadeIncomplete"
  /** `completeHttpRequest` with an id that is not in flight (never issued, or already completed). */
  | "unknownHttpRequest"
  | "moduleError"
  /** JS called the engine from inside a callback the engine was running. */
  | "engineReentrancy"
  /** This engine build has no hosted-module support. */
  | "hostedModulesUnsupported";

/** What the hosted-module methods throw. */
export interface HostedModuleError extends Error {
  type: "moduleError";
  code: HostedModuleErrorCode;
  scope?: string;
  /** The module-host call that failed (`hostError` / `invalidState`). */
  stage?: "register" | "instantiate" | "init" | "actions" | "onDestroyed" | "destroy";
  /** The host error's kind (`hostError`). */
  hostCode?: string;
  /** The cascade's failures (`moduleCallFailed` / `cascadeIncomplete`). */
  report?: ModuleCascadeReport;
}

/** Whether `err` is an error thrown by the hosted-module surface. */
export function isHostedModuleError(err: unknown): err is HostedModuleError {
  return (
    err instanceof Error &&
    (err as { type?: unknown }).type === "moduleError" &&
    typeof (err as { code?: unknown }).code === "string"
  );
}
