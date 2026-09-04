/**
 * Scrubber Component (Video v2)
 *
 * A media timeline designed for a Video's `controls` slot
 * (docs/components/video.md §"`Scrubber` (built-in, slot-aware)").
 *
 * Inside a Video it wires itself to the enclosing player RENDERER-SIDE:
 *
 * - the thumb tracks `currentTime` at frame rate without touching module
 *   state (rAF while playing, media events otherwise),
 * - dragging previews locally — still no state writes,
 * - only the release commits, as a `position` write on the `__hypen_bind`
 *   channel (`<path>.position`). Commit precedence (normative): the
 *   Scrubber's OWN `.bind(...)` wins, else the enclosing Video's
 *   `.bind(@state.playback)` struct, else an `onSeek` action payload
 *   `{type: "seek", position}` when there is no bind at all. The local
 *   seek applies in every case.
 *
 * That keeps scrubbing responsive on remote apps, where a state round trip
 * costs a network hop. Outside a Video the widget renders inert (disabled,
 * not focusable, no commits).
 *
 * Keyboard: ←/↓ and →/↑ seek ∓5 s and commit immediately.
 */

import type { ComponentHandler } from "./index.js";
import { getEngine, findEngine, getMeta, setMeta } from "../element-data.js";
import {
  getElementDisposables,
  disposableListener,
} from "@hypen-space/core/disposable";
import { frameworkLoggers } from "@hypen-space/core/logger";
import { extractActionDetails } from "../applicators/events.js";
import { getVideoSurface, getVideoBindPath, isVideoPlaying } from "./video.js";

const log = frameworkLoggers.renderer;

/** Seconds an arrow key seeks. */
const KEYBOARD_STEP_S = 5;

interface ScrubberParts {
  root: HTMLElement;
  track: HTMLElement;
  progress: HTMLElement;
  thumb: HTMLElement;
  /** `.bind(...)` on the Scrubber itself (wins over the Video's bind). */
  bindPath: string | null;
  /** Explicit disable from props. */
  disabled: boolean;
  /** Enclosing Video node, resolved lazily after insertion. */
  videoRoot: HTMLElement | null;
  media: HTMLVideoElement | null;
  /** Media listeners attached (so wiring happens exactly once). */
  wired: boolean;
  /** Live drag: preview position in seconds, or null when not dragging. */
  dragPosition: number | null;
  /** Pending rAF handle for the frame-rate thumb tracking. */
  raf: number | null;
}

const parts = new WeakMap<HTMLElement, ScrubberParts>();

const META_ON_SEEK = "scrubber:onSeek";

// ---------------------------------------------------------------------------
// Template instantiation (cloned prototypes)
// ---------------------------------------------------------------------------
//
// Plannable list rows are built by cloning a prototype (`registerTemplate` +
// `instantiate`). A clone keeps the DOM — the `data-hypen-part` track/progress/
// thumb structure and the recorded props below — but loses every JS-side
// association: the `parts` entry and all interaction listeners. `adoptClone`
// rebuilds both from the surviving markers, so a Scrubber in a list row is a
// working timeline rather than a painted-on picture of one.

/** dataset key recording `.bind(...)` so a clone can restore it. */
const BIND_MARKER = "hypenScrubberBind";
/** dataset key recording the `disabled` prop so a clone can restore it. */
const DISABLED_MARKER = "hypenScrubberDisabled";

/** The `data-hypen-part="…"` child stamped by `create()` (survives cloning). */
function findPart(root: HTMLElement, name: string): HTMLElement | null {
  const kids = root.children as unknown as ArrayLike<HTMLElement> | undefined;
  if (!kids || kids.length === 0) return null;
  for (const child of Array.from(kids)) {
    if (child && (child as HTMLElement).dataset?.hypenPart === name) {
      return child as HTMLElement;
    }
  }
  return null;
}

/**
 * Re-register a cloned Scrubber: parts map, recorded props, interaction
 * listeners. Returns null when `root` doesn't carry the structure.
 */
function adoptClone(root: HTMLElement): ScrubberParts | null {
  const track = findPart(root, "track");
  const progress = findPart(root, "progress");
  const thumb = findPart(root, "thumb");
  if (!track || !progress || !thumb) return null;

  const bind = root.dataset[BIND_MARKER];
  const entry: ScrubberParts = {
    root,
    track,
    progress,
    thumb,
    bindPath: bind ? bind : null,
    disabled: root.dataset[DISABLED_MARKER] === "true",
    videoRoot: null,
    media: null,
    wired: false,
    dragPosition: null,
    raf: null,
  };
  parts.set(root, entry);
  // Inert until the enclosing Video is resolved (same as a fresh create).
  setInert(entry, true);
  attachInteraction(root, entry);
  return entry;
}

/** The parts of a Scrubber node, adopting a template clone on a miss. */
function getParts(root: HTMLElement): ScrubberParts | null {
  return parts.get(root) ?? adoptClone(root);
}

// ============================================================================
// Helpers
// ============================================================================

/** `parentElement` in real DOM, `parentNode` in the lightweight test double. */
function parentOf(el: HTMLElement): HTMLElement | null {
  const parent =
    (el as { parentElement?: HTMLElement | null }).parentElement ??
    (el.parentNode as HTMLElement | null);
  return parent && (parent as { dataset?: unknown }).dataset !== undefined
    ? parent
    : null;
}

/** Nearest enclosing Video node, or null when the Scrubber stands alone. */
function findVideoRoot(el: HTMLElement): HTMLElement | null {
  let current = parentOf(el);
  while (current) {
    if (current.dataset?.hypenType === "video") return current;
    current = parentOf(current);
  }
  return null;
}

function duration(entry: ScrubberParts): number {
  const value = Number(entry.media?.duration);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function position(entry: ScrubberParts): number {
  if (entry.dragPosition !== null) return entry.dragPosition;
  const value = Number(entry.media?.currentTime);
  return Number.isFinite(value) ? value : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** `m:ss` (or `h:mm:ss`) for aria-valuetext. */
function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const total = Math.floor(seconds);
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hrs > 0 ? `${hrs}:${pad(mins)}:${pad(secs)}` : `${mins}:${pad(secs)}`;
}

// ============================================================================
// Rendering
// ============================================================================

function setInert(entry: ScrubberParts, inert: boolean): void {
  const { root } = entry;
  if (inert) {
    root.setAttribute("aria-disabled", "true");
    root.setAttribute("tabindex", "-1");
    root.style.opacity = "0.5";
    root.style.cursor = "default";
  } else {
    root.removeAttribute("aria-disabled");
    root.setAttribute("tabindex", "0");
    root.style.removeProperty("opacity");
    root.style.cursor = "pointer";
  }
}

/** Paint the timeline from the current (or previewed) position. */
function render(entry: ScrubberParts): void {
  const total = duration(entry);
  const current = clamp(position(entry), 0, total > 0 ? total : Number.MAX_SAFE_INTEGER);
  const ratio = total > 0 ? clamp(current / total, 0, 1) : 0;
  const percent = `${(ratio * 100).toFixed(3)}%`;

  entry.progress.style.width = percent;
  entry.thumb.style.left = percent;

  entry.root.setAttribute("aria-valuemin", "0");
  entry.root.setAttribute("aria-valuemax", String(total));
  entry.root.setAttribute("aria-valuenow", String(current));
  entry.root.setAttribute(
    "aria-valuetext",
    total > 0 ? `${formatTime(current)} of ${formatTime(total)}` : formatTime(current)
  );
}

/**
 * Frame-rate thumb tracking while the enclosing video plays. Purely local:
 * no state writes, no action dispatch.
 */
function startTicking(entry: ScrubberParts): void {
  if (entry.raf !== null) return;
  const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => number })
    .requestAnimationFrame;
  if (typeof raf !== "function") return;
  const tick = (): void => {
    entry.raf = null;
    render(entry);
    if (entry.videoRoot && isVideoPlaying(entry.videoRoot)) {
      entry.raf = raf(tick);
    }
  };
  entry.raf = raf(tick);
}

function stopTicking(entry: ScrubberParts): void {
  if (entry.raf === null) return;
  const cancel = (globalThis as { cancelAnimationFrame?: (handle: number) => void })
    .cancelAnimationFrame;
  if (typeof cancel === "function") cancel(entry.raf);
  entry.raf = null;
}

// ============================================================================
// Wiring to the enclosing player
// ============================================================================

/**
 * Resolve the enclosing Video and attach the media listeners, once. The
 * Scrubber is created before it is inserted into the tree, so this is
 * retried lazily — on prop application, on a microtask after create, and at
 * the start of every interaction.
 */
function ensureWired(el: HTMLElement): ScrubberParts | null {
  const entry = getParts(el);
  if (!entry) return null;
  if (entry.wired) return entry;

  const videoRoot = findVideoRoot(el);
  const media = videoRoot ? getVideoSurface(videoRoot) : null;
  if (!videoRoot || !media) {
    setInert(entry, true);
    return entry;
  }

  entry.videoRoot = videoRoot;
  entry.media = media;
  entry.wired = true;
  setInert(entry, entry.disabled);

  const disposables = getElementDisposables(el);
  const repaint = (): void => render(entry);
  for (const type of ["timeupdate", "durationchange", "loadedmetadata", "seeked", "pause", "ended"]) {
    disposables.add(disposableListener(media as unknown as HTMLElement, type, repaint));
  }
  disposables.add(
    disposableListener(media as unknown as HTMLElement, "playing", () => {
      render(entry);
      startTicking(entry);
    })
  );
  disposables.add(
    disposableListener(media as unknown as HTMLElement, "play", () => {
      render(entry);
      startTicking(entry);
    })
  );
  disposables.addCallback(() => stopTicking(entry));

  render(entry);
  // Wiring can land mid-playback (a Scrubber inserted into a playing
  // player): start tracking without waiting for the next `play`.
  if (isVideoPlaying(videoRoot)) startTicking(entry);
  return entry;
}

// ============================================================================
// Commit (the only path that touches module state)
// ============================================================================

function commit(el: HTMLElement, entry: ScrubberParts, seconds: number): void {
  const media = entry.media;
  if (!media) return;

  const total = duration(entry);
  const upper = total > 0 ? total : Math.max(seconds, 0);
  const target = clamp(seconds, 0, upper);

  // Local first: the thumb and the picture move without waiting for the
  // state round trip (the whole point of renderer-side scrubbing).
  media.currentTime = target;
  entry.dragPosition = null;
  render(entry);

  const engine = getEngine(el) ?? findEngine(el);
  if (!engine) return;

  // Commit precedence (normative): the Scrubber's OWN bind wins, else the
  // enclosing Video's playback bind, else the onSeek action below.
  const bindPath =
    entry.bindPath ?? (entry.videoRoot ? getVideoBindPath(entry.videoRoot) : null);

  try {
    if (bindPath) {
      engine.dispatchAction("__hypen_bind", {
        path: `${bindPath}.position`,
        value: target,
      });
      return;
    }
    const raw = getMeta(el, META_ON_SEEK);
    if (raw === undefined || raw === null) return;
    const { actionName, payload } = extractActionDetails(raw);
    if (!actionName) return;
    engine.dispatchAction(actionName, { ...payload, type: "seek", position: target });
  } catch (err) {
    log.error("Error committing scrubber seek:", err);
  }
}

/** Seconds under a pointer x-coordinate. */
function positionFromPointer(entry: ScrubberParts, clientX: number): number {
  const rect = entry.root.getBoundingClientRect();
  const width = rect.width || 0;
  const total = duration(entry);
  if (width <= 0 || total <= 0) return position(entry);
  const ratio = clamp((clientX - rect.left) / width, 0, 1);
  return ratio * total;
}

// ============================================================================
// Component handler
// ============================================================================

export const scrubberHandler: ComponentHandler = {
  create(): HTMLElement {
    const root = document.createElement("div");
    root.dataset.hypenType = "scrubber";
    root.setAttribute("role", "slider");
    root.setAttribute("tabindex", "0");
    root.style.position = "relative";
    root.style.width = "100%";
    root.style.height = "16px";
    root.style.cursor = "pointer";
    root.style.touchAction = "none";
    root.style.userSelect = "none";

    const track = document.createElement("div");
    track.dataset.hypenPart = "track";
    track.style.position = "absolute";
    track.style.left = "0";
    track.style.right = "0";
    track.style.top = "50%";
    track.style.height = "4px";
    track.style.marginTop = "-2px";
    track.style.borderRadius = "2px";
    track.style.backgroundColor = "rgba(255, 255, 255, 0.3)";

    const progress = document.createElement("div");
    progress.dataset.hypenPart = "progress";
    progress.style.position = "absolute";
    progress.style.left = "0";
    progress.style.top = "50%";
    progress.style.height = "4px";
    progress.style.marginTop = "-2px";
    progress.style.width = "0%";
    progress.style.borderRadius = "2px";
    progress.style.backgroundColor = "currentColor";

    const thumb = document.createElement("div");
    thumb.dataset.hypenPart = "thumb";
    thumb.style.position = "absolute";
    thumb.style.top = "50%";
    thumb.style.left = "0%";
    thumb.style.width = "12px";
    thumb.style.height = "12px";
    thumb.style.marginTop = "-6px";
    thumb.style.marginLeft = "-6px";
    thumb.style.borderRadius = "50%";
    thumb.style.backgroundColor = "currentColor";

    root.appendChild(track);
    root.appendChild(progress);
    root.appendChild(thumb);

    const entry: ScrubberParts = {
      root,
      track,
      progress,
      thumb,
      bindPath: null,
      disabled: false,
      videoRoot: null,
      media: null,
      wired: false,
      dragPosition: null,
      raf: null,
    };
    parts.set(root, entry);
    // Inert until an enclosing Video is found (see `ensureWired`).
    setInert(entry, true);
    attachInteraction(root, entry);
    return root;
  },

  applyProps(el: HTMLElement, props: Record<string, any>): void {
    // Adopts on a miss, so a Scrubber materialized by template cloning wires
    // itself here instead of silently dropping bind/onSeek/disabled.
    const entry = getParts(el);
    if (!entry) return;

    const read = (...names: string[]): unknown => {
      for (const name of names) {
        if (props[name] !== undefined) return props[name];
        if (props[`${name}.0`] !== undefined) return props[`${name}.0`];
      }
      return undefined;
    };

    const bind = read("bind");
    if (bind !== undefined) {
      entry.bindPath = typeof bind === "string" && bind ? bind : null;
      // Recorded on the node so a clone of this prototype restores it.
      if (entry.bindPath) el.dataset[BIND_MARKER] = entry.bindPath;
      else delete el.dataset[BIND_MARKER];
    }

    const onSeek = read("onSeek");
    if (onSeek !== undefined) {
      setMeta(el, META_ON_SEEK, onSeek);
    }

    const disabled = read("disabled");
    if (disabled !== undefined) {
      entry.disabled = disabled !== false && disabled !== "false" && Boolean(disabled);
      if (entry.disabled) el.dataset[DISABLED_MARKER] = "true";
      else delete el.dataset[DISABLED_MARKER];
    }

    settle(el, entry);
  },

  /**
   * Template instantiation: the renderer cloned a prototype, so this node has
   * the track/thumb DOM and none of the wiring. Rebuild the parts entry,
   * restore the recorded props and re-attach interaction — a fully static
   * Scrubber in a list row never reaches `applyProps`, so this is its only
   * wiring point.
   */
  adopt(el: HTMLElement): void {
    const entry = getParts(el);
    if (entry) settle(el, entry);
  },
};

/**
 * Resolve the enclosing Video and paint. It isn't reachable until this node
 * is in the tree, so resolve now (re-applied props, an inserted clone) and
 * again after the patch batch.
 */
function settle(el: HTMLElement, entry: ScrubberParts): void {
  const wired = ensureWired(el);
  if (wired && !wired.wired) {
    queueMicrotask(() => {
      const settled = ensureWired(el);
      if (settled) render(settled);
    });
  }
  setInert(entry, entry.disabled || !entry.wired);
  render(entry);
}

// ============================================================================
// Pointer + keyboard interaction
// ============================================================================

function attachInteraction(el: HTMLElement, entry: ScrubberParts): void {
  const disposables = getElementDisposables(el);

  const usable = (): boolean => {
    const wired = ensureWired(el);
    return Boolean(wired && wired.wired && !wired.disabled && wired.media);
  };

  disposables.add(
    disposableListener(el, "pointerdown", (event: Event) => {
      if (!usable()) return;
      const pointer = event as PointerEvent;
      entry.dragPosition = positionFromPointer(entry, pointer.clientX ?? 0);
      render(entry);
      const capture = (el as unknown as { setPointerCapture?: (id: number) => void })
        .setPointerCapture;
      if (typeof capture === "function" && typeof pointer.pointerId === "number") {
        try {
          capture.call(el, pointer.pointerId);
        } catch {
          // capture is best effort
        }
      }
      (event as { preventDefault?: () => void }).preventDefault?.();
    })
  );

  disposables.add(
    disposableListener(el, "pointermove", (event: Event) => {
      // Drag preview: local only, no state writes until release.
      if (entry.dragPosition === null || !entry.media) return;
      const pointer = event as PointerEvent;
      entry.dragPosition = positionFromPointer(entry, pointer.clientX ?? 0);
      render(entry);
    })
  );

  const release = (event: Event): void => {
    if (entry.dragPosition === null || !entry.media) return;
    const pointer = event as PointerEvent;
    const target =
      typeof pointer.clientX === "number"
        ? positionFromPointer(entry, pointer.clientX)
        : entry.dragPosition;
    commit(el, entry, target);
  };
  /**
   * An aborted gesture is NOT a release: the browser took the pointer away
   * (scroll takeover, palm rejection). Drop the local preview and commit
   * nothing — `pointercancel` carries degenerate coordinates (0,0 in
   * Chrome), which `positionFromPointer` would happily resolve to the track's
   * left edge and seek the video to the very beginning.
   */
  const cancel = (): void => {
    if (entry.dragPosition === null) return;
    entry.dragPosition = null;
    render(entry);
  };
  disposables.add(disposableListener(el, "pointerup", release));
  disposables.add(disposableListener(el, "pointercancel", cancel));

  disposables.add(
    disposableListener(el, "keydown", (event: Event) => {
      if (!usable()) return;
      const key = (event as KeyboardEvent).key;
      let delta = 0;
      if (key === "ArrowRight" || key === "ArrowUp") delta = KEYBOARD_STEP_S;
      else if (key === "ArrowLeft" || key === "ArrowDown") delta = -KEYBOARD_STEP_S;
      else return;
      (event as { preventDefault?: () => void }).preventDefault?.();
      // Keyboard seeks commit immediately — there is no release to wait for.
      commit(el, entry, position(entry) + delta);
    })
  );
}
