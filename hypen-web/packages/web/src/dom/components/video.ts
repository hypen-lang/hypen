import { dispatchUIAction } from "@hypen-space/core";
/**
 * Video Component
 *
 * Implements the cross-platform Video contract
 * (hypen-docs/content/docs/guide/components.mdx) for the DOM renderer:
 *
 * - `0`/`src`/`source` single URL, or `playlist` (supersedes `src`) with
 *   `startIndex`, auto-advance on `ended` and queue wrap under `loop`.
 * - `poster`, `controls`, `autoplay` (with muted-fallback retry for browser
 *   autoplay policy), `loop`, `muted`, `preload` (default `"metadata"`).
 * - `headers`: HTML media elements cannot attach request headers, so the
 *   renderer fetches with `fetch(src, { headers })` and tiers the result:
 *   containers that sniff as MSE-streamable (fragmented MP4, WebM) are
 *   pumped into a `MediaSource` so playback starts while the download is
 *   still in flight; everything else (e.g. progressive MP4) falls back to
 *   accumulate-to-Blob → object URL, reusing the bytes already read.
 * - Events: `onPlay`, `onPause`, `onEnded` (with `completed`),
 *   `onTrackChange`, `onError` (with HTTP `status` recovered via a 1-byte
 *   ranged probe where the media element hides it).
 *
 * Listeners attach ONCE per element; the current action values live in
 * element meta and are re-read on every fire, so re-applied props retarget
 * the dispatch instead of stacking listeners.
 *
 * v2 (hypen-docs/content/docs/guide/components.mdx §"Playback control & composition slots"):
 *
 * - A per-node `VideoPlayerState` machine (idle/loading/playing/paused/
 *   ended/error) derived from the media events. Rebuffering re-enters
 *   `loading` WITHOUT emitting `onPause`.
 * - `.bind(@state.playback)` (lowered by the engine to a `playback` prop +
 *   a `bind` path string): the struct is reported back through
 *   `__hypen_bind` writes — one key at a time so concurrent fields are
 *   never clobbered — with `position` throttled to 250 ms while playing
 *   and transitions reported immediately. Inbound writes seek (1 s
 *   epsilon, clamped), play/pause, and restart from 0 when `playing: true`
 *   arrives in `ended`. `duration`/`state` writes are ignored.
 * - `startPosition`: create-time seek, applied once when seekable.
 * - Composition slots: `.slot("controls"|"loading"|"error"|"poster")`
 *   children are overlaid full-bleed on the video surface (the node is a
 *   positioned wrapper holding the `<video>`), shown/hidden strictly per
 *   `VIDEO_SLOT_VISIBILITY` — show/hide, never mount/unmount. A present
 *   slot replaces the built-in for its concern (controls slot suppresses
 *   native chrome regardless of the `controls` prop, poster slot the
 *   `poster` attribute, error slot the built-in error visuals, loading
 *   any built-in spinner).
 */

import { toBool, type ComponentHandler } from "./index.js";
import {
  getEngine,
  findEngine,
  getRegisteredEvents,
  registerEvent,
  unregisterEvent,
  getMeta,
  setMeta,
} from "../element-data.js";
import {
  getElementDisposables,
  disposableListener,
} from "@hypen-space/core/disposable";
import { frameworkLoggers } from "@hypen-space/core/logger";
import {
  PLAYBACK_REPORT_INTERVAL_MS,
  PLAYBACK_SEEK_EPSILON_S,
  VIDEO_SLOTS,
  VIDEO_SLOT_VISIBILITY,
  type VideoPlayerState,
  type VideoSlotName,
} from "@hypen-space/core/types";
import { extractActionDetails } from "../applicators/events.js";
import { slotChildren, setVisible } from "../slots.js";

const log = frameworkLoggers.renderer;

// ============================================================================
// Per-element state
// ============================================================================

interface VideoElementState {
  /**
   * The renderer-facing node: a positioned wrapper that holds the `<video>`
   * surface and the overlaid slot children. Engine reference, meta (event
   * actions) and slot children all live here, never on the surface.
   */
  root: HTMLElement | null;
  /** Ordered play queue; empty = single-src mode. */
  playlist: string[];
  /** Current playlist index (0 in single-src mode). */
  index: number;
  /** Single-source URL (used only when `playlist` is empty). */
  singleSrc: string | null;
  /** Extra HTTP headers for media fetches (forces the blob fallback). */
  headers: Record<string, string> | null;
  /** Contract `loop`: native loop for single src, queue wrap for playlists. */
  loop: boolean;
  /** Contract `autoplay` (with muted-fallback retry). */
  autoplay: boolean;
  /** Contract `muted` as authored (drives the autoplay fallback decision). */
  muted: boolean;
  /** `startIndex` as authored; applied whenever a playlist is (re)applied. */
  startIndex: number;
  /** Live object URL from the headers/blob fallback, revoked on replace/teardown. */
  objectUrl: string | null;
  /** Monotonic token so a stale async header-fetch can never clobber a newer load. */
  loadToken: number;
  /** Cancels the in-flight headers body stream (MSE pump or blob accumulate). */
  abortStream: (() => void) | null;

  // --- v2: player state machine ------------------------------------------
  /** Current normative player state (see hypen-docs/content/docs/guide/components.mdx). */
  playerState: VideoPlayerState;
  /** A load has begun for the current source (`loadstart` / src assignment). */
  loadStarted: boolean;
  /** Media has enough data to play (`loadeddata`/`canplay`). */
  ready: boolean;
  /** Playback has begun at least once for the current source. */
  hasPlayed: boolean;
  /** Currently playing (element not paused). */
  playing: boolean;
  /** Rebuffering/stalled (`waiting`/`stalled`) — re-enters `loading`. */
  buffering: boolean;
  /** The current source ran out with nothing left to play. */
  ended: boolean;
  /** Sticky failure state, cleared when a new source loads. */
  errored: boolean;
  /** Play the next assigned source regardless of `autoplay` (queue advance). */
  playPending: boolean;

  // --- v2: playback bind --------------------------------------------------
  /** `.bind(@state.playback)` target path, or null when unbound. */
  bindPath: string | null;
  /** Last values written back, so an echoed write is never re-applied. */
  lastReported: {
    playing: boolean | null;
    position: number | null;
    duration: number | null;
    state: VideoPlayerState | null;
  };
  /** Recent `playing` values we reported, for echo detection (see
   * PLAYING_ECHO_HORIZON_MS). */
  playingReportLog: Array<{ v: boolean; t: number }>;
  /** Timestamps of applied inbound writes that flipped play state — the
   * echo-storm detector's evidence. */
  inboundFlipLog: number[];
  /** Timestamp of the last `position` report (250 ms throttle). */
  lastPositionReportAt: number;

  // --- v2: create-time seek ----------------------------------------------
  startPosition: number | null;
  startPositionApplied: boolean;
  /**
   * Fingerprint of the SOURCE CONFIGURATION (`src`/`playlist`/`headers`) as
   * last applied from props. `startPosition` re-arms whenever this changes
   * (contract: "it re-arms when the source configuration changes, not on
   * unrelated prop updates"). Playlist auto-advance moves `index` only and
   * deliberately does NOT re-arm — the fingerprint is recomputed from props,
   * never from queue movement.
   */
  sourceFingerprint: string | null;

  // --- v2: built-ins a present slot replaces ------------------------------
  /** `controls` as authored (null = never authored). */
  controlsProp: boolean | null;
  /** `poster` as authored (null = never authored). */
  posterProp: string | null;
}

const videoStates = new WeakMap<HTMLElement, VideoElementState>();
/** node (wrapper) → `<video>` surface. */
const videoSurfaces = new WeakMap<HTMLElement, HTMLVideoElement>();

function getState(el: HTMLElement): VideoElementState {
  let state = videoStates.get(el);
  if (!state) {
    state = {
      root: null,
      playlist: [],
      index: 0,
      singleSrc: null,
      headers: null,
      loop: false,
      autoplay: false,
      muted: false,
      startIndex: 0,
      objectUrl: null,
      loadToken: 0,
      abortStream: null,
      playerState: "idle",
      loadStarted: false,
      ready: false,
      hasPlayed: false,
      playing: false,
      buffering: false,
      ended: false,
      errored: false,
      playPending: false,
      bindPath: null,
      lastReported: { playing: null, position: null, duration: null, state: null },
      playingReportLog: [],
      inboundFlipLog: [],
      lastPositionReportAt: 0,
      startPosition: null,
      startPositionApplied: false,
      sourceFingerprint: null,
      controlsProp: null,
      posterProp: null,
    };
    videoStates.set(el, state);
  }
  return state;
}

// ---------------------------------------------------------------------------
// Template instantiation (cloned prototypes)
// ---------------------------------------------------------------------------
//
// Plannable list rows are materialized by `registerTemplate` + `instantiate`:
// the renderer builds ONE prototype through `create()`/`applyProps()` and then
// `cloneNode(true)`s it per row. A clone inherits the DOM — tags, dataset,
// attributes, inline styles — but NOTHING on the JS side: no WeakMap
// membership, no listeners. Everything below exists so a clone can rebuild its
// own state from what the DOM actually carries:
//
//  - `data-hypen-video-surface` marks the `<video>` inside the wrapper, so the
//    surface is re-findable structurally (`adoptSurface`),
//  - `data-hypen-video-config` records the source configuration applied to the
//    prototype (src/playlist/headers/bind/… — none of which is recoverable
//    from the media element alone), so the clone re-applies it verbatim.
//
// Adoption happens on the FIRST lookup of a clone's surface, so every entry
// point (`applyProps` for a `subs` prop, `onChildrenChanged`, the Scrubber
// wiring itself to the enclosing player, and the renderer's explicit `adopt`
// hook) sees a fully-wired node.

/** dataset key of the `<video>` surface marker stamped by `create()`. */
const SURFACE_MARKER = "hypenVideoSurface";
/** dataset key holding the prototype's source configuration (JSON). */
const CONFIG_MARKER = "hypenVideoConfig";

/**
 * Props recorded into `data-hypen-video-config`: everything that establishes
 * per-element state rather than being reconstructible from the media element.
 * Transient playback writes (`playback`, `playing`) are deliberately excluded
 * — they are per-instance commands, not configuration.
 */
const CONFIG_PROPS = new Set([
  "0",
  "src",
  "source",
  "playlist",
  "startIndex",
  "headers",
  "poster",
  "controls",
  "autoplay",
  "loop",
  "muted",
  "preload",
  "bind",
  "startPosition",
]);

/** The marked `<video>` child of a Video wrapper (survives `cloneNode`). */
function findSurface(root: HTMLElement): HTMLVideoElement | null {
  const kids = root.children as unknown as ArrayLike<HTMLElement> | undefined;
  if (!kids || kids.length === 0) return null;
  for (const child of Array.from(kids)) {
    if (child && (child as HTMLElement).dataset?.[SURFACE_MARKER] === "true") {
      return child as HTMLVideoElement;
    }
  }
  return null;
}

/** Record the source configuration on the node so clones can replay it. */
function recordConfig(root: HTMLElement, props: Record<string, any>): void {
  let seen: Record<string, unknown> | null = null;
  for (const key of Object.keys(props)) {
    const base = key.endsWith(".0") ? key.slice(0, -2) : key;
    if (!CONFIG_PROPS.has(base)) continue;
    (seen ??= {})[key] = toPlain(props[key]);
  }
  // Hot path (playback echoes carry no configuration): nothing to record.
  if (!seen) return;

  const previous = root.dataset[CONFIG_MARKER];
  const merged = previous ? { ...readConfig(root), ...seen } : seen;
  try {
    const next = JSON.stringify(merged);
    if (next !== previous) root.dataset[CONFIG_MARKER] = next;
  } catch {
    // Unserializable prop value: the clone falls back to its DOM attributes.
  }
}

function readConfig(root: HTMLElement): Record<string, any> | null {
  const raw = root.dataset[CONFIG_MARKER];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, any>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Re-register a cloned Video node: surface lookup, per-element state, media
 * listeners, and the prototype's recorded configuration. Returns null when
 * `root` is not a Video wrapper at all.
 */
function adoptSurface(root: HTMLElement): HTMLVideoElement | null {
  const media = findSurface(root);
  if (!media) return null;

  videoSurfaces.set(root, media);
  // A cloned `<video>` is a brand-new element, so `getState` mints fresh
  // defaults — the prototype's machine is never inherited. Reset the DOM
  // markers the clone inherited to match that fresh state.
  const state = getState(media);
  state.root = root;
  root.dataset.hypenVideoState = "idle";
  if (root.dataset.hypenVideoError !== undefined) {
    delete root.dataset.hypenVideoError;
    root.style.removeProperty("background-color");
  }
  ensureListeners(media, root);

  const config = readConfig(root);
  if (config) {
    // Static props were applied to the prototype only; replay them so the
    // clone loads its source and drives its own state machine. Per-instance
    // `subs` are applied by the renderer afterwards and win.
    videoHandler.applyProps!(root, config);
  }
  return media;
}

/**
 * The `<video>` surface inside a Video node. The renderer-facing node is a
 * positioned wrapper (slot children overlay the surface inside it), so every
 * media operation has to hop one level down. Exported for the Scrubber (and
 * tests), which wire themselves to the enclosing player.
 *
 * Adopts template clones on a miss (see the block comment above): a Video
 * materialized by prototype cloning has no WeakMap entry until it is looked
 * up here.
 */
export function getVideoSurface(root: HTMLElement): HTMLVideoElement | null {
  return videoSurfaces.get(root) ?? adoptSurface(root);
}

/** The `.bind(@state.playback)` path of a Video node, if it has one. */
export function getVideoBindPath(root: HTMLElement): string | null {
  const media = getVideoSurface(root);
  return media ? getState(media).bindPath : null;
}

/** Whether a Video node is currently playing (Scrubber rAF gating). */
export function isVideoPlaying(root: HTMLElement): boolean {
  const media = getVideoSurface(root);
  return media ? getState(media).playerState === "playing" : false;
}

/**
 * Test/diagnostic clock seam: the 250 ms position-report throttle reads
 * time through this, so tests can drive the throttle deterministically
 * instead of sleeping. Pass `null` to restore `Date.now`.
 */
let nowFn: () => number = () => Date.now();

export function __setVideoClockForTests(fn: (() => number) | null): void {
  nowFn = fn ?? (() => Date.now());
}

// ============================================================================
// Prop normalization
// ============================================================================

const EVENT_PROPS = [
  "onPlay",
  "onPause",
  "onEnded",
  "onTrackChange",
  "onError",
] as const;

type VideoEventProp = (typeof EVENT_PROPS)[number];

/**
 * Read a prop that may arrive under its plain name or with a ".0" suffix
 * (positional applicator-argument encoding), checking aliases in order.
 */
function readProp(props: Record<string, any>, ...names: string[]): any {
  for (const name of names) {
    if (props[name] !== undefined) return props[name];
    const suffixed = props[`${name}.0`];
    if (suffixed !== undefined) return suffixed;
  }
  return undefined;
}

/** Convert Maps (from WASM) into plain objects/arrays, recursively. */
function toPlain(value: unknown): unknown {
  if (value instanceof Map) {
    const obj: Record<string, unknown> = {};
    for (const [key, val] of value.entries()) {
      obj[String(key)] = toPlain(val);
    }
    return obj;
  }
  if (Array.isArray(value)) return value.map(toPlain);
  if (value && typeof value === "object") {
    const obj: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      obj[key] = toPlain(val);
    }
    return obj;
  }
  return value;
}

/** Defensive: array | Map | numeric-keyed object | JSON string → string[]. */
function normalizeStringArray(value: unknown): string[] {
  let plain = toPlain(value);

  if (typeof plain === "string") {
    const trimmed = plain.trim();
    if (trimmed.startsWith("[")) {
      try {
        plain = JSON.parse(trimmed);
      } catch {
        return trimmed ? [trimmed] : [];
      }
    } else {
      return trimmed ? [trimmed] : [];
    }
  }

  if (Array.isArray(plain)) {
    return plain.map((item) => String(item)).filter((s) => s.length > 0);
  }

  if (plain && typeof plain === "object") {
    // Map-decoded array: numeric string keys in insertion order.
    return Object.entries(plain as Record<string, unknown>)
      .filter(([key]) => /^\d+$/.test(key))
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([, item]) => String(item))
      .filter((s) => s.length > 0);
  }

  return [];
}

/** Defensive: object | Map | JSON string → Record<string,string> | null. */
function normalizeHeaders(value: unknown): Record<string, string> | null {
  let plain = toPlain(value);

  if (typeof plain === "string") {
    try {
      plain = JSON.parse(plain);
    } catch {
      return null;
    }
  }

  if (plain && typeof plain === "object" && !Array.isArray(plain)) {
    const out: Record<string, string> = {};
    for (const [key, val] of Object.entries(plain as Record<string, unknown>)) {
      if (val !== undefined && val !== null) {
        out[key] = String(val);
      }
    }
    return Object.keys(out).length > 0 ? out : null;
  }

  return null;
}

function clampIndex(index: number, length: number): number {
  if (!Number.isFinite(index) || length <= 0) return 0;
  return Math.min(Math.max(Math.trunc(index), 0), length - 1);
}

// ============================================================================
// Event dispatch
// ============================================================================

function metaKey(prop: VideoEventProp): string {
  return `video:${prop}`;
}

/** Engine for a Video node, resolved from its wrapper (the renderer's node). */
function engineFor(el: HTMLElement): { dispatchAction(name: string, payload?: unknown): void } | undefined {
  const host = getState(el).root ?? el;
  return getEngine(host) ?? findEngine(host);
}

/**
 * Dispatch a media event's action, re-reading the CURRENT action value from
 * element meta so re-applied props retarget the persistent listeners.
 * Contract payload fields win over any extra author-supplied payload args.
 */
function dispatchVideoEvent(
  el: HTMLElement,
  prop: VideoEventProp,
  contractPayload: Record<string, unknown>
): void {
  // Actions and the engine reference live on the renderer-facing node (the
  // wrapper), not on the `<video>` surface the listeners fire on.
  const host = getState(el).root ?? el;
  const raw = getMeta(host, metaKey(prop));
  if (raw === undefined || raw === null) return;

  const { actionName, payload: customPayload } = extractActionDetails(raw);
  if (!actionName) return;

  const engine = engineFor(el);
  if (!engine) return;

  try {
    dispatchUIAction(engine, host.dataset.hypenId, actionName, { ...customPayload, ...contractPayload });
  } catch (err) {
    log.error(`Error dispatching video action "${actionName}":`, err);
  }
}

// ============================================================================
// Source loading
// ============================================================================

function currentSrc(state: VideoElementState): string | null {
  if (state.playlist.length > 0) {
    return state.playlist[state.index] ?? null;
  }
  return state.singleSrc;
}

/** Playlist index for event payloads (`0` for single-src playback). */
function playlistIndex(state: VideoElementState): number {
  return state.playlist.length > 0 ? state.index : 0;
}

function revokeObjectUrl(state: VideoElementState): void {
  if (state.objectUrl) {
    try {
      URL.revokeObjectURL(state.objectUrl);
    } catch {
      // Best effort — some test environments lack object URL support.
    }
    state.objectUrl = null;
  }
}

function showErrorState(el: HTMLElement): void {
  const state = getState(el);
  state.errored = true;
  state.playing = false;
  state.buffering = false;
  el.dataset.hypenVideoError = "true";
  // Quiet error state: dark box (poster, if any, still shows above the
  // background) — never an infinite spinner. An `error` slot replaces this
  // built-in surface entirely, so the box is only painted when no slot is
  // present (`syncPlayerState` → `refreshSlots` owns that decision).
  syncPlayerState(el);
}

function clearErrorState(el: HTMLElement): void {
  const state = getState(el);
  state.errored = false;
  if (el.dataset.hypenVideoError !== undefined) {
    delete el.dataset.hypenVideoError;
    // The error box painted a black background; leaving it behind blacked
    // out every subsequent successful load of the same element.
    el.style.removeProperty("background-color");
  }
}

// ============================================================================
// v2: player state machine
// ============================================================================

/**
 * Derive the normative player state from the element's flags.
 *
 * `paused` is only reachable once playback has begun (the spec's
 * `playing ⇄ paused` edge); a loaded-but-never-played source reports `idle`
 * so the poster shows and no spinner spins forever, and a source still
 * resolving reports `loading`.
 */
function deriveState(state: VideoElementState): VideoPlayerState {
  if (state.errored) return "error";
  if (!currentSrc(state)) return "idle";
  if (state.ended) return "ended";
  if (state.buffering) return "loading";
  if (state.playing) return "playing";
  if (state.hasPlayed) return "paused";
  if (state.loadStarted && !state.ready) return "loading";
  return "idle";
}

/**
 * Recompute the player state, and — when it changed — republish it: the
 * `data-hypen-video-state` marker, slot visibility, and an immediate
 * playback-bind report (transitions are never throttled).
 */
function syncPlayerState(el: HTMLElement): void {
  const state = getState(el);
  const next = deriveState(state);
  if (next === state.playerState) {
    // Slots still need a pass on first paint (initial state === "idle").
    return;
  }
  state.playerState = next;
  const root = state.root;
  if (root) root.dataset.hypenVideoState = next;
  refreshSlots(el);
  reportPlayback(el, { immediate: true });
}

// ============================================================================
// v2: composition slots
// ============================================================================

/**
 * Paint order for overlaid slots (bottom → top). The poster sits under the
 * spinner, controls sit above both, and the error surface tops everything —
 * only pairs that can be visible simultaneously actually matter (poster +
 * loading in `loading`, poster + controls in `idle`/`ended`).
 */
const SLOT_PAINT_ORDER: Record<VideoSlotName, number> = {
  poster: 1,
  loading: 2,
  controls: 3,
  error: 4,
};

/** Full-bleed overlay geometry, applied once per slot child. */
function styleSlotChild(el: HTMLElement, slot: VideoSlotName): void {
  if (el.dataset.hypenVideoSlotStyled === "true") return;
  el.dataset.hypenVideoSlotStyled = "true";
  el.style.position = "absolute";
  el.style.top = "0";
  el.style.left = "0";
  el.style.right = "0";
  el.style.bottom = "0";
  el.style.zIndex = String(SLOT_PAINT_ORDER[slot]);
}

/**
 * Apply the normative visibility table to this node's slot children, and
 * suppress every built-in a present slot replaces.
 *
 * Slot children are ordinary patch-managed nodes that can arrive or leave at
 * any time (ForEach/When), so this re-reads the child list on every call —
 * the renderer notifies us synchronously on child/slot changes.
 */
function refreshSlots(el: HTMLElement): void {
  const state = getState(el);
  const root = state.root;
  if (!root) return;

  const present = {} as Record<VideoSlotName, HTMLElement[]>;
  for (const slot of VIDEO_SLOTS) {
    present[slot] = slotChildren(root, slot);
    const visible = VIDEO_SLOT_VISIBILITY[slot][state.playerState];
    for (const child of present[slot]) {
      styleSlotChild(child, slot);
      setVisible(child, visible);
    }
  }

  const media = el as HTMLVideoElement;

  // A present `controls` slot replaces native chrome regardless of `controls`.
  if (present.controls.length > 0) {
    media.controls = false;
  } else if (state.controlsProp !== null) {
    media.controls = state.controlsProp;
  }

  // A present `poster` slot replaces the `poster` attribute's image.
  if (present.poster.length > 0) {
    if (media.poster) media.poster = "";
  } else if (state.posterProp !== null) {
    media.poster = state.posterProp;
  }

  // A present `error` slot replaces the renderer-drawn error surface (the
  // quiet black box); the slot content is the error UI instead.
  if (state.playerState === "error" && present.error.length === 0) {
    media.style.backgroundColor = "#000";
  } else {
    media.style.removeProperty("background-color");
  }
  // `loading`: there is no built-in DOM spinner to suppress — the browser
  // draws buffering chrome itself only under native controls, which a
  // controls slot already turns off.
}

// ============================================================================
// v2: playback bind (renderer → state reports, state → renderer writes)
// ============================================================================

function mediaDuration(media: HTMLVideoElement): number {
  const duration = Number(media.duration);
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

function mediaPosition(media: HTMLVideoElement): number {
  const position = Number(media.currentTime);
  return Number.isFinite(position) ? position : 0;
}

/**
 * Report the playback struct back into module state.
 *
 * Keys are written INDIVIDUALLY (`<path>.position`, `<path>.playing`, …) so
 * two concurrent reports can never clobber each other's fields, and every
 * write is deduplicated against `lastReported` — which doubles as the
 * echo guard for inbound writes.
 *
 * `playing`/`state`/`duration` go out immediately on change; `position` is
 * throttled to `PLAYBACK_REPORT_INTERVAL_MS` unless the caller marks the
 * report as a transition (`immediate`).
 */
function reportPlayback(el: HTMLElement, opts: { immediate?: boolean } = {}): void {
  const state = getState(el);
  const bindPath = state.bindPath;
  if (!bindPath) return;
  const engine = engineFor(el);
  if (!engine) return;

  const media = el as HTMLVideoElement;
  const write = (key: string, value: unknown): void => {
    try {
      dispatchUIAction(engine, (state.root ?? el).dataset.hypenId, "__hypen_bind", { path: `${bindPath}.${key}`, value });
    } catch (err) {
      log.error("Error reporting video playback binding:", err);
    }
  };

  if (state.lastReported.state !== state.playerState) {
    state.lastReported.state = state.playerState;
    write("state", state.playerState);
  }

  // `playing` mirrors the element's play/pause intent, not the state name:
  // a rebuffer moves `state` to "loading" while playback is still engaged,
  // and a module-side toggle button must not flip to "play" mid-stall.
  const playing = state.playing;
  if (state.lastReported.playing !== playing) {
    state.lastReported.playing = playing;
    state.playingReportLog.push({ v: playing, t: nowFn() });
    if (state.playingReportLog.length > 8) state.playingReportLog.shift();
    write("playing", playing);
  }

  const duration = mediaDuration(media);
  if (state.lastReported.duration !== duration) {
    state.lastReported.duration = duration;
    write("duration", duration);
  }

  const position = mediaPosition(media);
  if (state.lastReported.position === position) return;
  const now = nowFn();
  if (!opts.immediate && now - state.lastPositionReportAt < PLAYBACK_REPORT_INTERVAL_MS) {
    return;
  }
  state.lastPositionReportAt = now;
  state.lastReported.position = position;
  write("position", position);
}

/**
 * Apply an inbound `playback` struct write (module → renderer).
 *
 * - `position`: seeks only when it differs from the actual position by more
 *   than `PLAYBACK_SEEK_EPSILON_S`, clamped to `[0, duration]`. Combined
 *   with the `lastReported` comparison this makes the report/write loop
 *   converge instead of ringing.
 * - `playing`: play/pause; `true` while `ended` restarts from 0.
 * - `duration`/`state`: read-only, ignored.
 */
function applyPlaybackWrite(el: HTMLElement, raw: unknown): void {
  const plain = toPlain(raw);
  if (!plain || typeof plain !== "object" || Array.isArray(plain)) return;
  const struct = plain as Record<string, unknown>;
  const state = getState(el);
  const media = el as HTMLVideoElement;

  // Did THIS write carry an explicit (non-echoed) position? A restart from
  // `ended` must yield to it — `{playing: true, position: 30}` means "resume
  // at 30", not "restart from 0" (contract: the explicit seek wins).
  let seekRequested = false;

  if (struct.position !== undefined && struct.position !== null) {
    const requested = Number(struct.position);
    // An echo of our own last report is never a seek request.
    if (Number.isFinite(requested) && requested !== state.lastReported.position) {
      seekRequested = true;
      const duration = mediaDuration(media);
      const target = Math.min(Math.max(requested, 0), duration > 0 ? duration : requested);
      if (Math.abs(target - mediaPosition(media)) > PLAYBACK_SEEK_EPSILON_S) {
        media.currentTime = target;
        // Treat the applied seek as already-known state on both sides, so
        // the position it lands on isn't bounced straight back.
        state.lastReported.position = target;
        state.lastPositionReportAt = nowFn();
      }
    }
  }

  if (struct.playing !== undefined && struct.playing !== null) {
    const wantPlaying = toBool(struct.playing);
    // Echo suppression with a report-history horizon. The engine echoes
    // every report back as a SetProp of the whole struct, and reports
    // ALTERNATE on real transitions — so a lagging echo always differs
    // from the LATEST lastReported value and a level comparison cannot
    // catch it. One seed pause then ping-pongs play/pause at round-trip
    // rate forever (observed live: ~50 cycles/s). Any inbound value we
    // ourselves reported within the horizon is an echo, not a command;
    // a genuine toggle targets a value whose last report (if any) is a
    // transition ago and outside the horizon.
    const now = nowFn();
    state.inboundFlipLog = state.inboundFlipLog.filter(
      (t) => now - t <= PLAYING_STORM_WINDOW_MS
    );
    const matchesRecentReport = state.playingReportLog.some(
      (e) => e.v === wantPlaying && now - e.t <= PLAYING_ECHO_HORIZON_MS
    );
    // Echo-storm breaker: an isolated write is ALWAYS a command (restart
    // after ended, a fast toggle — both legitimately match recent
    // reports). Only when inbound writes have flipped play state several
    // times within the window AND the value matches something we
    // ourselves just reported is it a lagging echo stream — suppress
    // until the storm drains. A real ping-pong dies within ~3 cycles.
    const storm =
      matchesRecentReport && state.inboundFlipLog.length >= PLAYING_STORM_FLIPS;
    const flips = wantPlaying !== (state.playing || state.playerState === "playing");
    if (storm) {
      // suppressed: fall through without acting
    } else if (wantPlaying) {
      if (state.playerState === "ended") {
        // Writing `playing: true` in `ended` restarts from the top — unless
        // the same write asked for a position, which is where playback is
        // meant to resume.
        if (!seekRequested) {
          media.currentTime = 0;
          state.lastReported.position = 0;
        }
        state.ended = false;
      }
      if (state.playerState !== "playing") {
        state.buffering = false;
        if (flips) state.inboundFlipLog.push(now);
        attemptPlay(media, false);
      }
    } else if (state.playerState === "playing" || state.playing) {
      // An explicit pause is a user pause, not a rebuffer: clear the
      // buffering flag so the `pause` event reports it as one.
      state.buffering = false;
      if (flips) state.inboundFlipLog.push(now);
      if (typeof media.pause === "function") media.pause();
    }
  }
  // `duration` / `state` are renderer-owned: writes are ignored by contract.
}

/** Inbound `playing` values matching a report this recent can be echoes of
 * our own transitions rather than module commands. */
const PLAYING_ECHO_HORIZON_MS = 2500;
/** Window and flip count for the echo-storm breaker: only a rapid run of
 * state-flipping inbound writes is treated as a lagging echo stream. */
const PLAYING_STORM_WINDOW_MS = 2000;
const PLAYING_STORM_FLIPS = 3;

/** Create-time `startPosition` seek, applied once the source is seekable. */
function applyStartPosition(el: HTMLElement): void {
  const state = getState(el);
  if (state.startPositionApplied) return;
  const target = state.startPosition;
  if (target === null || !(target > 0)) return;
  // The seek belongs to the CURRENT source. A load in flight (notably the
  // `headers` tier, whose src assignment lands after an async fetch) leaves
  // the previous source loaded and seekable — seeking it would scrub the
  // outgoing video and burn the one-shot flag before the new source arrives.
  if (!state.ready) return;

  const media = el as HTMLVideoElement;
  const duration = mediaDuration(media);
  const seekable = media.seekable as { length?: number } | undefined;
  const isSeekable = duration > 0 || (seekable?.length ?? 0) > 0;
  if (!isSeekable) return;

  media.currentTime = duration > 0 ? Math.min(target, duration) : target;
  state.startPositionApplied = true;
  reportPlayback(el, { immediate: true });
}

/**
 * (Re)load the current source into the element. Direct URL assignment when
 * no headers are configured (native streaming); fetch → Blob → object URL
 * fallback when `headers` is present (media elements can't attach headers).
 */
function loadCurrent(el: HTMLVideoElement): void {
  const state = getState(el);
  const url = currentSrc(state);
  const token = ++state.loadToken;

  // Any in-flight headers stream belongs to a previous load (its token is
  // now stale): cancel its network reader eagerly instead of letting it
  // drain in the background.
  if (state.abortStream) {
    const abort = state.abortStream;
    state.abortStream = null;
    abort();
  }

  // Native loop only for single-src playback; playlist wrap is queue logic
  // in the `ended` handler, so el.loop must stay false with a playlist.
  el.loop = state.playlist.length > 0 ? false : state.loop;

  if (!url) {
    // Contract failure mode 1: no src and no playlist → empty placeholder
    // box, no crash, no dispatch.
    el.dataset.hypenVideoPlaceholder = "true";
    state.loadStarted = false;
    state.ready = false;
    state.playPending = false;
    syncPlayerState(el);
    return;
  }

  delete el.dataset.hypenVideoPlaceholder;
  clearErrorState(el);

  // A new source resets the per-source machine: the load has begun (the
  // element's own `loadstart` confirms it), nothing is ready or played yet.
  state.loadStarted = true;
  state.ready = false;
  state.hasPlayed = false;
  state.playing = false;
  state.buffering = false;
  state.ended = false;
  syncPlayerState(el);

  if (state.headers) {
    void loadWithHeaders(el, state, url, token);
    return;
  }

  revokeObjectUrl(state);
  el.src = url;
  maybeAutoplay(el, state);
}

// ============================================================================
// Headers fallback: container sniffing + tiered loading (MSE stream vs blob)
// ============================================================================

/**
 * Classification of the leading bytes of a media response body:
 *
 * - `"fmp4"`            — fragmented MP4 (ftyp/styp with moof fragments, or an
 *                         fMP4-typical major brand). MSE-streamable.
 * - `"webm"`            — EBML magic. MSE-streamable.
 * - `"progressive-mp4"` — plain MP4 (moov + bare mdat, no moof). NOT
 *                         MSE-streamable; must be blob-buffered.
 * - `"unknown"`         — anything else / not enough bytes yet.
 */
export type ContainerSniff = "fmp4" | "webm" | "progressive-mp4" | "unknown";

/** `ftyp` major brands that (per CMAF/DASH convention) imply fragmentation. */
const FMP4_MAJOR_BRANDS = new Set([
  "iso5",
  "iso6",
  "cmfc",
  "cmf2",
  "dash",
  "msdh",
  "msix",
]);

/** Stop sniffing once this many leading bytes fail to produce a verdict. */
const SNIFF_BYTE_LIMIT = 65536;

/** Seconds of already-played media kept behind the playhead on quota eviction. */
const QUOTA_KEEP_BEHIND_SECONDS = 3;

function fourCC(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset]!,
    bytes[offset + 1]!,
    bytes[offset + 2]!,
    bytes[offset + 3]!
  );
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) |
      (bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!) >>>
    0
  );
}

/**
 * Sniff a media container from the leading bytes of a stream (pure — safe to
 * call repeatedly as more bytes arrive).
 *
 * WebM is a 4-byte EBML magic check. For ISO-BMFF the top-level boxes are
 * walked by their size fields (box *headers* are enough — a multi-megabyte
 * `moov` is skipped, not read): `moof`/`styp` ⇒ fragmented; a bare `mdat`
 * (media data outside any fragment) ⇒ progressive; an fMP4-typical `ftyp`
 * major brand ⇒ fragmented without waiting for the first `moof`. A `moov`
 * with no `moof` in the provided bytes classifies as progressive — callers
 * feeding an incomplete prefix should treat only `"fmp4"`/`"webm"` as final
 * and keep reading before trusting a negative verdict.
 */
export function sniffContainer(bytes: Uint8Array): ContainerSniff {
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  ) {
    return "webm";
  }

  if (bytes.length < 8) return "unknown";

  const firstBox = fourCC(bytes, 4);
  if (firstBox !== "ftyp" && firstBox !== "styp" && firstBox !== "moof") {
    return "unknown";
  }

  let sawMoov = false;
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    let size = readU32(bytes, offset);
    const type = fourCC(bytes, offset + 4);

    if (type === "moof" || type === "styp") return "fmp4";
    if (type === "mdat") {
      // In fMP4, media data only ever follows a moof — a bare mdat means
      // progressive samples addressed by a (possibly trailing) moov.
      return "progressive-mp4";
    }
    if (type === "ftyp" && offset + 12 <= bytes.length) {
      const major = fourCC(bytes, offset + 8);
      if (FMP4_MAJOR_BRANDS.has(major)) return "fmp4";
    }
    if (type === "moov") sawMoov = true;

    if (size === 1) {
      // 64-bit largesize extension.
      if (offset + 16 > bytes.length) break;
      size = readU32(bytes, offset + 8) * 0x100000000 + readU32(bytes, offset + 12);
    } else if (size === 0) {
      break; // box extends to end of file
    }
    if (size < 8) break; // malformed
    offset += size;
  }

  return sawMoov ? "progressive-mp4" : "unknown";
}

/** Structural reader type — keeps the pump independent of DOM lib details. */
interface ByteStreamReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel?(reason?: unknown): unknown;
}

/** Structural surface of the MediaSource API the streaming tier needs. */
export interface SourceBufferLike {
  updating: boolean;
  buffered?: { length: number; start(index: number): number; end(index: number): number };
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
  appendBuffer(data: Uint8Array): void;
  remove(start: number, end: number): void;
}

export interface MediaSourceLike {
  readyState: string;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
  addSourceBuffer(mime: string): SourceBufferLike;
  endOfStream(error?: string): void;
}

export interface MediaSourceCtorLike {
  new (): MediaSourceLike;
  isTypeSupported?(mime: string): boolean;
}

interface MediaSourceSeam {
  MediaSource: MediaSourceCtorLike;
  /** Binds a media-element URL to the MediaSource (URL.createObjectURL in browsers). */
  createObjectURL: (ms: MediaSourceLike) => string;
}

let mediaSourceSeamOverride: MediaSourceSeam | null | undefined;

/**
 * Test/diagnostic seam (same style as the canvas paint seams): override the
 * MediaSource implementation used by the headers streaming tier. Pass `null`
 * to force the blob fallback, `undefined` to restore platform detection.
 */
export function __setMediaSourceForTests(
  seam:
    | {
        MediaSource: MediaSourceCtorLike;
        createObjectURL?: (ms: MediaSourceLike) => string;
      }
    | null
    | undefined
): void {
  if (seam === null || seam === undefined) {
    mediaSourceSeamOverride = seam;
    return;
  }
  mediaSourceSeamOverride = {
    MediaSource: seam.MediaSource,
    createObjectURL:
      seam.createObjectURL ??
      ((ms) => URL.createObjectURL(ms as unknown as Blob)),
  };
}

function resolveMediaSourceSeam(): MediaSourceSeam | null {
  if (mediaSourceSeamOverride !== undefined) return mediaSourceSeamOverride;
  const ctor = (globalThis as { MediaSource?: MediaSourceCtorLike }).MediaSource;
  if (
    !ctor ||
    typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function"
  ) {
    return null;
  }
  return {
    MediaSource: ctor,
    createObjectURL: (ms) => URL.createObjectURL(ms as unknown as Blob),
  };
}

/**
 * Codec probe candidates per sniffed container. Cheap codec sniffing from the
 * bitstream isn't practical, so the common profiles are probed in order and
 * the first `isTypeSupported` hit wins; a `codecs=`-bearing Content-Type from
 * the server (checked first by `pickMseMime`) beats all of these.
 */
const MSE_MIME_CANDIDATES: Record<"fmp4" | "webm", string[]> = {
  fmp4: [
    'video/mp4; codecs="avc1.42E01E, mp4a.40.2"',
    'video/mp4; codecs="avc1.640028, mp4a.40.2"',
    "video/mp4",
  ],
  webm: [
    'video/webm; codecs="vp9, opus"',
    'video/webm; codecs="vp8, vorbis"',
    "video/webm",
  ],
};

function pickMseMime(
  sniff: "fmp4" | "webm",
  contentType: string | null,
  ctor: MediaSourceCtorLike
): string | null {
  const probe = ctor.isTypeSupported;
  if (typeof probe !== "function") return null;
  const candidates: string[] = [];
  if (contentType && contentType.includes("codecs")) candidates.push(contentType);
  candidates.push(...MSE_MIME_CANDIDATES[sniff]);
  for (const mime of candidates) {
    try {
      if (probe.call(ctor, mime)) return mime;
    } catch {
      // keep probing
    }
  }
  return null;
}

function toUint8(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return new Uint8Array(0);
}

function concatChunks(chunks: Uint8Array[], totalLength: number): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function cancelReader(reader: ByteStreamReader): void {
  try {
    void reader.cancel?.();
  } catch {
    // best effort
  }
}

function waitForSourceOpen(ms: MediaSourceLike): Promise<void> {
  if (ms.readyState === "open") return Promise.resolve();
  return new Promise((resolve) => {
    const onOpen = () => {
      ms.removeEventListener("sourceopen", onOpen);
      resolve();
    };
    ms.addEventListener("sourceopen", onOpen);
  });
}

/** Resolve once the SourceBuffer is idle (backpressure between appends). */
function waitForIdle(sb: SourceBufferLike): Promise<void> {
  if (!sb.updating) return Promise.resolve();
  return new Promise((resolve) => {
    const onSettle = () => {
      sb.removeEventListener("updateend", onSettle);
      sb.removeEventListener("error", onSettle);
      resolve();
    };
    sb.addEventListener("updateend", onSettle);
    sb.addEventListener("error", onSettle);
  });
}

function isQuotaExceeded(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: unknown; code?: unknown };
  return e.name === "QuotaExceededError" || e.code === 22;
}

/**
 * Evict already-played media from the front of the buffer so a quota-blocked
 * append can be retried. Returns false when there is nothing evictable.
 */
async function evictPlayedRange(
  el: HTMLVideoElement,
  sb: SourceBufferLike
): Promise<boolean> {
  const currentTime = typeof el.currentTime === "number" ? el.currentTime : 0;
  const end = currentTime - QUOTA_KEEP_BEHIND_SECONDS;
  let start = 0;
  try {
    if (sb.buffered && sb.buffered.length > 0) start = sb.buffered.start(0);
  } catch {
    // unreadable buffered ranges: assume the buffer starts at 0
  }
  if (!(end > start)) return false;
  try {
    await waitForIdle(sb);
    sb.remove(start, end);
    await waitForIdle(sb);
    return true;
  } catch {
    return false;
  }
}

/** Append one chunk, honoring backpressure and quota eviction (retry once). */
async function appendWithBackpressure(
  el: HTMLVideoElement,
  sb: SourceBufferLike,
  chunk: Uint8Array
): Promise<void> {
  await waitForIdle(sb);
  try {
    sb.appendBuffer(chunk);
  } catch (err) {
    if (!isQuotaExceeded(err)) throw err;
    if (!(await evictPlayedRange(el, sb))) throw err;
    sb.appendBuffer(chunk);
  }
  await waitForIdle(sb);
}

/** Assign a fully-buffered Blob to the element (legacy headers fallback). */
function assignBlobUrl(
  el: HTMLVideoElement,
  state: VideoElementState,
  url: string,
  blob: Blob
): void {
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
    // No object URL support (exotic embed): stream the URL directly —
    // headers are lost, but playback beats a black box.
    log.warn("Video headers fallback unavailable (no URL.createObjectURL); assigning src directly");
    el.src = url;
    maybeAutoplay(el, state);
    return;
  }

  revokeObjectUrl(state);
  state.objectUrl = URL.createObjectURL(blob);
  el.src = state.objectUrl;
  maybeAutoplay(el, state);
}

async function loadWithHeaders(
  el: HTMLVideoElement,
  state: VideoElementState,
  url: string,
  token: number
): Promise<void> {
  try {
    const res = await fetch(url, { headers: state.headers ?? {} });
    if (state.loadToken !== token) return; // superseded by a newer load

    if (!res.ok) {
      showErrorState(el);
      dispatchVideoEvent(el, "onError", {
        type: "error",
        src: url,
        index: playlistIndex(state),
        status: res.status,
        message: `HTTP ${res.status} while fetching video source`,
      });
      return;
    }

    const body = (res as { body?: { getReader?: () => ByteStreamReader } }).body;
    const reader =
      body && typeof body.getReader === "function" ? body.getReader() : null;

    if (reader) {
      state.abortStream = () => cancelReader(reader);
      try {
        await streamHeadersBody(el, state, url, token, res, reader);
      } finally {
        // Only clear our own registration — a newer load may have replaced it.
        if (state.loadToken === token) state.abortStream = null;
      }
      return;
    }

    // No readable body stream (older embeds / exotic Response impls):
    // original whole-file blob fallback.
    const blob = await res.blob();
    if (state.loadToken !== token) return;
    assignBlobUrl(el, state, url, blob);
  } catch (err) {
    if (state.loadToken !== token) return;
    showErrorState(el);
    // Network / mid-stream pump error: no HTTP status to report — omit it
    // per contract; include a platform code when the error carries one.
    const payload: Record<string, unknown> = {
      type: "error",
      src: url,
      index: playlistIndex(state),
      message: err instanceof Error ? err.message : "Network error while fetching video source",
    };
    const code = (err as { code?: unknown } | null | undefined)?.code;
    if (typeof code === "number") payload.code = code;
    dispatchVideoEvent(el, "onError", payload);
  }
}

/**
 * Tiered headers-body loader:
 *
 * 1. Sniff the container from the first chunk(s) of the already-started body.
 * 2. MSE-streamable (fMP4/WebM) + MediaSource available + a supported MIME
 *    probe → pump chunks into a SourceBuffer: playback starts while the
 *    download is still in flight.
 * 3. Otherwise accumulate to a Blob, REUSING the bytes already read (the
 *    stream is never refetched).
 */
async function streamHeadersBody(
  el: HTMLVideoElement,
  state: VideoElementState,
  url: string,
  token: number,
  res: Response,
  reader: ByteStreamReader
): Promise<void> {
  // --- Tier 1: sniff -----------------------------------------------------
  const prefix: Uint8Array[] = [];
  let prefixBytes = 0;
  let streamDone = false;
  let sniff: ContainerSniff = "unknown";

  while (prefixBytes < SNIFF_BYTE_LIMIT) {
    const { done, value } = await reader.read();
    if (state.loadToken !== token) {
      cancelReader(reader);
      return;
    }
    if (done) {
      streamDone = true;
      break;
    }
    const chunk = toUint8(value);
    if (chunk.length === 0) continue;
    prefix.push(chunk);
    prefixBytes += chunk.length;
    sniff = sniffContainer(concatChunks(prefix, prefixBytes));
    // Early exit only on a *streamable* verdict — a negative one can still
    // flip when the next chunk arrives (e.g. the first moof of an fMP4
    // whose ftyp brand is generic).
    if (sniff === "fmp4" || sniff === "webm") break;
  }

  const headersObj = (res as { headers?: { get?: (name: string) => string | null } }).headers;
  const contentType =
    headersObj && typeof headersObj.get === "function"
      ? headersObj.get("content-type")
      : null;

  // --- Tier 2: MSE streaming --------------------------------------------
  if (!streamDone && (sniff === "fmp4" || sniff === "webm")) {
    const seam = resolveMediaSourceSeam();
    const mime = seam ? pickMseMime(sniff, contentType, seam.MediaSource) : null;
    if (seam && mime) {
      let ms: MediaSourceLike | null = null;
      let msUrl: string | null = null;
      try {
        ms = new seam.MediaSource();
        msUrl = seam.createObjectURL(ms);
      } catch {
        ms = null;
        msUrl = null; // MediaSource object URLs unsupported here → tier 3
      }
      if (ms && msUrl !== null) {
        await streamViaMediaSource(el, state, url, token, ms, msUrl, mime, prefix, reader);
        return;
      }
    }
  }

  // --- Tier 3: accumulate to Blob, reusing the prefetched bytes ----------
  const chunks = prefix;
  while (!streamDone) {
    const { done, value } = await reader.read();
    if (state.loadToken !== token) {
      cancelReader(reader);
      return;
    }
    if (done) break;
    const chunk = toUint8(value);
    if (chunk.length > 0) chunks.push(chunk);
  }

  const blobType =
    contentType ??
    (sniff === "webm" ? "video/webm" : sniff !== "unknown" ? "video/mp4" : "");
  const blob = new Blob(
    chunks as unknown as BlobPart[],
    blobType ? { type: blobType } : undefined
  );
  if (state.loadToken !== token) return;
  assignBlobUrl(el, state, url, blob);
}

/**
 * Pump the body stream into a MediaSource so playback starts immediately.
 * Backpressure: one append in flight at a time (wait for `updateend`).
 * Quota: evict already-played ranges and retry once. Teardown/source change:
 * the load token goes stale and the pump cancels the reader on its next step.
 */
async function streamViaMediaSource(
  el: HTMLVideoElement,
  state: VideoElementState,
  url: string,
  token: number,
  ms: MediaSourceLike,
  msUrl: string,
  mime: string,
  prefix: Uint8Array[],
  reader: ByteStreamReader
): Promise<void> {
  revokeObjectUrl(state);
  state.objectUrl = msUrl; // revoked by the same replace/teardown path as blob URLs
  el.src = msUrl;
  maybeAutoplay(el, state);

  try {
    await waitForSourceOpen(ms);
    if (state.loadToken !== token) {
      cancelReader(reader);
      return;
    }

    const sb = ms.addSourceBuffer(mime);

    for (const chunk of prefix) {
      await appendWithBackpressure(el, sb, chunk);
      if (state.loadToken !== token) {
        cancelReader(reader);
        return;
      }
    }

    for (;;) {
      const { done, value } = await reader.read();
      if (state.loadToken !== token) {
        cancelReader(reader);
        return;
      }
      if (done) break;
      const chunk = toUint8(value);
      if (chunk.length === 0) continue;
      await appendWithBackpressure(el, sb, chunk);
      if (state.loadToken !== token) {
        cancelReader(reader);
        return;
      }
    }

    await waitForIdle(sb);
    if (ms.readyState === "open") ms.endOfStream();
  } catch (err) {
    cancelReader(reader);
    if (state.loadToken !== token) return;
    showErrorState(el);
    // Mid-stream pump failure: code + message, no HTTP status (contract §3).
    const payload: Record<string, unknown> = {
      type: "error",
      src: url,
      index: playlistIndex(state),
      message: err instanceof Error ? err.message : "Media stream append failed",
    };
    const code = (err as { code?: unknown } | null | undefined)?.code;
    if (typeof code === "number") payload.code = code;
    dispatchVideoEvent(el, "onError", payload);
  }
}

// ============================================================================
// Autoplay (browser policy fallback)
// ============================================================================

/**
 * Start playback for a source that just became assignable.
 *
 * `playPending` is the queue-advance channel: a track that ended mid-play
 * asks the NEXT source to start as soon as it is actually assigned. That
 * matters under `headers`, where assignment happens after an async fetch —
 * playing eagerly at `ended` time replayed the old track and left the new
 * one paused.
 */
function maybeAutoplay(el: HTMLVideoElement, state: VideoElementState): void {
  const forced = state.playPending;
  state.playPending = false;
  if (!state.autoplay && !forced) return;
  // If autoplay is requested unmuted, browsers may reject play(): on
  // rejection mute and retry once (standard muted-autoplay fallback).
  // A queue advance is already user-initiated playback, so no fallback.
  attemptPlay(el, forced ? false : !state.muted);
}

function attemptPlay(el: HTMLVideoElement, retryMuted: boolean): void {
  if (typeof el.play !== "function") return;
  let result: unknown;
  try {
    result = el.play();
  } catch {
    if (retryMuted) {
      el.muted = true;
      attemptPlay(el, false);
    }
    return;
  }
  if (result && typeof (result as Promise<void>).then === "function") {
    (result as Promise<void>).catch(() => {
      if (retryMuted) {
        el.muted = true;
        attemptPlay(el, false);
      }
    });
  }
}

// ============================================================================
// Media event handlers
// ============================================================================

function handleEnded(el: HTMLVideoElement): void {
  const state = getState(el);
  const endedSrc = currentSrc(state);
  const endedIndex = playlistIndex(state);
  const hasPlaylist = state.playlist.length > 0;
  const isLast = !hasPlaylist || state.index >= state.playlist.length - 1;

  // `completed`: the whole queue is done. Single src: true unless looping
  // (native loop normally swallows `ended` anyway). Playlist: true only on
  // the last track without wrap.
  const completed = hasPlaylist ? isLast && !state.loop : !state.loop;

  // `ended` is the state for "final track finished, no wrap"; a queue that
  // continues transitions through the next source's `loading` instead.
  state.playing = false;
  state.buffering = false;
  state.ended = true;
  syncPlayerState(el);

  dispatchVideoEvent(el, "onEnded", {
    type: "ended",
    src: endedSrc,
    index: endedIndex,
    completed,
  });

  // Queue advance (wrap to 0 under loop).
  const willContinue = hasPlaylist && (!isLast || state.loop);
  if (!willContinue) return;

  state.index = isLast ? 0 : state.index + 1;
  // The viewer was mid-playback; keep playing into the next track. The play
  // is armed rather than issued here so the `headers` path — whose src
  // assignment lands after an async fetch — plays the NEW track once it is
  // actually assigned, instead of replaying the old one and stranding the
  // next track paused.
  state.playPending = true;
  loadCurrent(el);
  dispatchVideoEvent(el, "onTrackChange", {
    type: "trackchange",
    src: currentSrc(state),
    index: state.index,
  });
}

async function handleError(el: HTMLVideoElement): Promise<void> {
  const state = getState(el);
  const src = currentSrc(state);
  if (!src) return; // nothing configured: placeholder box, no dispatch

  showErrorState(el);

  const media: MediaError | null = el.error ?? null;
  const payload: Record<string, unknown> = {
    type: "error",
    src,
    index: playlistIndex(state),
    message: (media && media.message) || "Media playback error",
  };
  if (media && typeof media.code === "number") {
    payload.code = media.code;
  }

  // Media elements don't expose the HTTP status, so recover it with a
  // 1-byte ranged probe (plus the author's headers). A CORS-blocked or
  // failed probe simply omits `status`.
  try {
    const res = await fetch(src, {
      headers: { Range: "bytes=0-0", ...(state.headers ?? {}) },
    });
    if (res && !res.ok && typeof res.status === "number") {
      payload.status = res.status;
    }
  } catch {
    // omit status
  }

  dispatchVideoEvent(el, "onError", payload);
}

/**
 * Attach the persistent media listeners once per element. Dispatch targets
 * are re-read from meta on every fire (see `dispatchVideoEvent`).
 *
 * Disposables are registered on the renderer-facing node (the wrapper), so a
 * `remove` patch — which disposes that node — tears the media listeners down
 * with it.
 */
function ensureListeners(el: HTMLVideoElement, host: HTMLElement): void {
  const eventKey = "video:media";
  if (getRegisteredEvents(el).has(eventKey)) return;
  registerEvent(el, eventKey);

  const disposables = getElementDisposables(host);
  const state = getState(el);
  const on = (type: string, handler: () => void): void => {
    disposables.add(disposableListener(el, type, handler));
  };

  on("play", () => {
    state.playing = true;
    state.hasPlayed = true;
    state.ended = false;
    syncPlayerState(el);
    dispatchVideoEvent(el, "onPlay", {
      type: "play",
      src: currentSrc(state),
      index: playlistIndex(state),
    });
  });

  on("pause", () => {
    // A track running out fires pause+ended; the end of playback is not a
    // user pause, so onEnded alone reports it.
    if (el.ended || state.ended) return;
    // Rebuffering re-enters `loading` WITHOUT emitting onPause (spec).
    // Browsers don't fire `pause` for a stall, so a `pause` arriving with
    // the element genuinely paused is a real pause even mid-stall; anything
    // else during a stall is buffering noise.
    if (state.buffering && el.paused === false) {
      syncPlayerState(el);
      return;
    }
    state.buffering = false;
    state.playing = false;
    syncPlayerState(el);
    dispatchVideoEvent(el, "onPause", {
      type: "pause",
      src: currentSrc(state),
      index: playlistIndex(state),
    });
  });

  // --- v2 state-machine inputs (no author-facing events of their own) ----

  on("loadstart", () => {
    state.loadStarted = true;
    state.ready = false;
    state.ended = false;
    syncPlayerState(el);
  });

  on("emptied", () => {
    state.ready = false;
    state.hasPlayed = false;
    state.playing = false;
    syncPlayerState(el);
  });

  const markReady = (): void => {
    state.ready = true;
    state.buffering = false;
    applyStartPosition(el);
    syncPlayerState(el);
    reportPlayback(el, { immediate: true });
  };
  on("loadedmetadata", markReady);
  on("loadeddata", markReady);
  on("canplay", markReady);
  on("canplaythrough", markReady);
  on("durationchange", () => reportPlayback(el, { immediate: true }));

  on("playing", () => {
    state.playing = true;
    state.hasPlayed = true;
    state.buffering = false;
    state.ended = false;
    syncPlayerState(el);
  });

  // Rebuffer: back to `loading`, and explicitly NOT an onPause.
  const stall = (): void => {
    if (state.errored || state.ended) return;
    state.buffering = true;
    syncPlayerState(el);
  };
  on("waiting", stall);
  on("stalled", stall);

  on("seeked", () => {
    state.buffering = false;
    syncPlayerState(el);
    reportPlayback(el, { immediate: true });
  });

  // Progress reports: throttled to PLAYBACK_REPORT_INTERVAL_MS.
  on("timeupdate", () => reportPlayback(el));

  on("ended", () => handleEnded(el));
  on("error", () => {
    void handleError(el);
  });

  disposables.addCallback(() => {
    unregisterEvent(el, eventKey);
    // Invalidate any in-flight headers load and cancel its network reader
    // so an MSE pump/blob accumulate never outlives the element.
    state.loadToken += 1;
    if (state.abortStream) {
      const abort = state.abortStream;
      state.abortStream = null;
      abort();
    }
    revokeObjectUrl(state);
  });
}

// ============================================================================
// Component handler
// ============================================================================

export const videoHandler: ComponentHandler = {
  /**
   * The node is a positioned wrapper holding the `<video>` surface, so slot
   * children can be overlaid on the player full-bleed (a `<video>`'s own
   * children are fallback content and never rendered). Everything
   * media-related still lives on the surface: `src`, the placeholder/error
   * markers, and the media listeners.
   */
  create(): HTMLElement {
    const root = document.createElement("div");
    root.dataset.hypenType = "video";
    root.dataset.hypenVideoState = "idle";
    root.style.position = "relative";
    root.style.display = "inline-block";

    const el = document.createElement("video");
    el.dataset.hypenVideoSurface = "true";
    el.style.display = "block";
    el.style.width = "100%";
    el.style.height = "100%";
    // Contract default; overridden by an explicit `preload` prop.
    (el as HTMLVideoElement).preload = "metadata";
    // Empty placeholder box until a source arrives (contract failure mode 1).
    el.dataset.hypenVideoPlaceholder = "true";
    root.appendChild(el);

    videoSurfaces.set(root, el as any as HTMLVideoElement);
    getState(el as any as HTMLElement).root = root;

    return root;
  },

  applyProps(el: HTMLElement, props: Record<string, any>): void {
    // Adopts on a miss, so a Video materialized by template cloning wires
    // itself here instead of silently dropping every prop.
    const video = getVideoSurface(el);
    if (!video) return;
    const state = getState(video);
    state.root = el;
    ensureListeners(video, el);
    // Keep the node's replayable configuration current: this element may be
    // (or may become) a template prototype that gets cloned per list row.
    recordConfig(el, props);

    let needsLoad = false;

    // --- simple element flags -------------------------------------------
    const controls = readProp(props, "controls");
    if (controls !== undefined) {
      state.controlsProp = toBool(controls);
      video.controls = state.controlsProp;
    }

    const muted = readProp(props, "muted");
    if (muted !== undefined) {
      state.muted = toBool(muted);
      video.muted = state.muted;
    }

    const autoplay = readProp(props, "autoplay");
    if (autoplay !== undefined) {
      state.autoplay = toBool(autoplay);
      video.autoplay = state.autoplay;
    }

    const loop = readProp(props, "loop");
    if (loop !== undefined) {
      state.loop = toBool(loop);
    }

    const preload = readProp(props, "preload");
    if (preload !== undefined) {
      video.preload = String(preload) as "" | "none" | "metadata" | "auto";
    }

    const poster = readProp(props, "poster");
    if (poster !== undefined) {
      state.posterProp = String(poster);
      video.poster = state.posterProp;
    }

    // --- v2: playback bind / create-time seek ---------------------------
    const bind = readProp(props, "bind");
    if (bind !== undefined) {
      state.bindPath = typeof bind === "string" && bind ? bind : null;
    }

    const startPosition = readProp(props, "startPosition");
    if (startPosition !== undefined) {
      const parsed = Number(startPosition);
      const next = Number.isFinite(parsed) ? parsed : null;
      if (next !== state.startPosition) {
        state.startPosition = next;
        state.startPositionApplied = false;
      }
    }

    // --- media source configuration -------------------------------------
    const headers = readProp(props, "headers");
    if (headers !== undefined) {
      state.headers = normalizeHeaders(headers);
      needsLoad = true;
    }

    const startIndex = readProp(props, "startIndex");
    if (startIndex !== undefined) {
      const parsed = Number(startIndex);
      state.startIndex = Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
    }

    const src = readProp(props, "0", "src", "source");
    if (src !== undefined) {
      const next = String(src) || null;
      if (next !== state.singleSrc) {
        state.singleSrc = next;
        // A playlist supersedes src; the stored value takes over if the
        // playlist ever empties.
        if (state.playlist.length === 0) {
          needsLoad = true;
        }
      }
    }

    const playlist = readProp(props, "playlist");
    if (playlist !== undefined) {
      state.playlist = normalizeStringArray(playlist);
      state.index = clampIndex(state.startIndex, state.playlist.length);
      needsLoad = true;
    }

    // `startPosition` re-arms on a SOURCE CONFIGURATION change (contract),
    // not just on a change of its own value — the two commonly arrive
    // together, and a value-only check misses "same resume point, new
    // episode" entirely. Computed after every source prop has landed so a
    // batched {src, headers} retarget re-arms exactly once; queue
    // auto-advance never passes through here, so it never re-arms.
    const fingerprint = JSON.stringify([
      state.singleSrc,
      state.playlist,
      state.headers,
    ]);
    if (fingerprint !== state.sourceFingerprint) {
      if (state.sourceFingerprint !== null) state.startPositionApplied = false;
      state.sourceFingerprint = fingerprint;
    }

    // --- event actions (stored on the node; listeners re-read per fire) --
    for (const prop of EVENT_PROPS) {
      const value = readProp(props, prop);
      if (value !== undefined) {
        setMeta(el, metaKey(prop), value);
      }
    }

    // Recompute the native loop flag even without a reload (e.g. a lone
    // SetProp of `loop`).
    video.loop = state.playlist.length > 0 ? false : state.loop;

    if (needsLoad) {
      loadCurrent(video);
    }

    // Inbound playback writes are applied AFTER any reload, so a seek
    // arriving alongside a new source targets the new source.
    const playback = readProp(props, "playback");
    if (playback !== undefined && playback !== null) {
      applyPlaybackWrite(video, playback);
    }

    // One-way form (`playing: @{state.isPlaying}` as a plain prop): the
    // controlled subset of the bind — module drives, renderer follows.
    // Shares the bind's write semantics (`true` in `ended` restarts from 0).
    const playing = readProp(props, "playing");
    if (playing !== undefined && playing !== null) {
      applyPlaybackWrite(video, { playing: toBool(playing) });
    }

    // Startup seek for a source that is already seekable (a re-applied prop
    // on a warm element never gets another `loadedmetadata`).
    applyStartPosition(video);

    // Slot suppression depends on the props just applied (controls/poster),
    // and slot children may already be attached on a re-apply.
    refreshSlots(video);
    if (state.bindPath) {
      // THROTTLED, not immediate: this tail runs on every inbound SetProp —
      // including the engine's echo of our own reports. An immediate report
      // here re-reported the (advanced) currentTime on each echo, sustaining
      // a report→echo→report loop at round-trip rate and bypassing the
      // 250 ms contract. Transitions still report immediately from
      // syncPlayerState; this tail only needs to keep steady-state fields
      // (e.g. a freshly-arrived bind path's opening struct) flowing.
      if (engineFor(video)) {
        reportPlayback(video, {});
      } else {
        // At create time the renderer attaches the engine AFTER the handler
        // runs; report the opening struct once it is reachable. `immediate`
        // is safe here — it runs once per element, not per echo.
        queueMicrotask(() => reportPlayback(video, { immediate: true }));
      }
    }
  },

  /**
   * Slot children are ordinary patch-managed nodes: they can be inserted,
   * removed or re-slotted at any time. The renderer calls this synchronously
   * after every such change (same channel HypenApp's slots use).
   */
  onChildrenChanged(el: HTMLElement): void {
    const video = getVideoSurface(el);
    if (!video) return;
    getState(video).root = el;
    refreshSlots(video);
  },

  /**
   * Template instantiation: the renderer cloned a prototype, so this node has
   * the right DOM and none of the state. Re-register surface, state,
   * listeners and the recorded source configuration before any per-instance
   * prop is applied (a fully static Video in a list row never reaches
   * `applyProps` at all, so this hook is its only wiring point).
   */
  adopt(el: HTMLElement): void {
    getVideoSurface(el);
  },
};
