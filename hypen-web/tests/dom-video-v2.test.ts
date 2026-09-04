/**
 * DOM Video v2 — player states, playback bind, composition slots, Scrubber
 * (hypen-docs/content/docs/guide/components.mdx §"Playback control & composition slots").
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DOMRenderer } from "../packages/web/src/dom/renderer";
import {
  getVideoSurface,
  __setVideoClockForTests,
} from "../packages/web/src/dom/components/video";
import {
  PLAYBACK_REPORT_INTERVAL_MS,
  VIDEO_SLOTS,
  VIDEO_SLOT_VISIBILITY,
  type VideoPlayerState,
  type VideoSlotName,
} from "../packages/core/src/types";
import type { Patch } from "../packages/core/src/types";
import type { IEngine as Engine } from "../packages/core/src/app";
import { ensureFakeDomGlobals, FakeElement } from "./fake-dom";
import { flushMicrotasks } from "./helpers";

ensureFakeDomGlobals();

class RecordingEngine {
  actions: Array<{ name: string; payload: any }> = [];
  dispatchAction(name: string, payload?: any): void {
    this.actions.push({ name, payload });
  }
  actionsNamed(name: string): Array<{ name: string; payload: any }> {
    return this.actions.filter((a) => a.name === name);
  }
  /** `__hypen_bind` writes for one struct key, in order. */
  binds(key: string): any[] {
    return this.actions
      .filter((a) => a.name === "__hypen_bind" && a.payload?.path?.endsWith(`.${key}`))
      .map((a) => a.payload.value);
  }
  clear(): void {
    this.actions.length = 0;
  }
}

function makeRenderer() {
  const container = document.createElement("div");
  const engine = new RecordingEngine();
  const renderer = new DOMRenderer(container, engine as unknown as Engine);
  return { container, engine, renderer };
}

/**
 * Give the fake `<video>` the handful of media-element behaviours the
 * component touches (play/pause flip `paused` and fire their events).
 */
function equipMedia(media: any, duration = 120): { plays: number } {
  const calls = { plays: 0 };
  media.currentTime = 0;
  media.duration = duration;
  media.paused = true;
  media.ended = false;
  media.play = () => {
    calls.plays += 1;
    media.paused = false;
    media.dispatchEvent("play");
    return Promise.resolve();
  };
  media.pause = () => {
    media.paused = true;
    media.dispatchEvent("pause");
  };
  return calls;
}

function createVideo(
  renderer: DOMRenderer,
  props: Record<string, any>,
  id = "vid"
): { root: FakeElement; media: any } {
  renderer.applyPatches([
    { type: "create", id: "root-1", elementType: "Column", props: {} } as Patch,
    { type: "create", id, elementType: "Video", props } as Patch,
    { type: "insert", parentId: "root-1", id } as Patch,
  ]);
  const root = renderer.getNode(id) as unknown as FakeElement;
  const media = getVideoSurface(root as unknown as HTMLElement) as any;
  return { root, media };
}

/** Insert a `.slot(name)` child into a Video node. */
function addSlot(
  renderer: DOMRenderer,
  videoId: string,
  slot: VideoSlotName,
  id = `slot-${slot}`
): FakeElement {
  renderer.applyPatches([
    {
      type: "create",
      id,
      elementType: "Column",
      props: { "slot.0": slot },
    } as Patch,
    { type: "insert", parentId: videoId, id } as Patch,
  ]);
  return renderer.getNode(id) as unknown as FakeElement;
}

function playerState(root: FakeElement): string | undefined {
  return root.dataset.hypenVideoState;
}

function isHidden(el: FakeElement): boolean {
  return el.style.getPropertyValue("display") === "none";
}

/** Drive the element into a given normative player state. */
function driveTo(media: any, state: VideoPlayerState): void {
  switch (state) {
    case "idle":
      media.dispatchEvent("canplay");
      break;
    case "loading":
      media.dispatchEvent("loadstart");
      break;
    case "playing":
      media.dispatchEvent("play");
      break;
    case "paused":
      media.dispatchEvent("pause");
      break;
    case "ended":
      media.dispatchEvent("ended");
      break;
    case "error":
      media.dispatchEvent("error");
      break;
  }
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  ensureFakeDomGlobals();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  __setVideoClockForTests(null);
});

// ============================================================================
// Renderer-local fullscreen intent
// ============================================================================

describe("Video v2: videoIntent fullscreen", () => {
  test("click toggles fullscreen on the WRAPPER (custom controls preserved)", () => {
    const { renderer } = makeRenderer();
    const { root } = createVideo(renderer, { src: "https://cdn/a.mp4" });
    addSlot(renderer, "vid", "controls");
    renderer.applyPatches([
      { type: "create", id: "fs-btn", elementType: "Button",
        props: { "videoIntent.0": "fullscreen" } } as Patch,
      { type: "insert", parentId: "slot-controls", id: "fs-btn" } as Patch,
    ]);
    const btn = renderer.getNode("fs-btn") as unknown as FakeElement;
    expect(btn.dataset.hypenVideoIntent).toBe("fullscreen");

    const requested: any[] = [];
    (root as any).requestFullscreen = () => { requested.push(root); return Promise.resolve(); };
    const docs = [ (btn as any).ownerDocument, globalThis.document ].filter(Boolean);
    let exited = 0;
    for (const d of docs) {
      (d as any).fullscreenElement = null;
      (d as any).exitFullscreen = () => { exited++; return Promise.resolve(); };
    }

    btn.dispatchEvent("click");
    // The WRAPPER (data-hypen-video-state root) goes fullscreen — never the
    // raw <video>, whose native fullscreen chrome would replace the slots.
    expect(requested.length).toBe(1);
    expect(requested[0]).toBe(root);
    expect(exited).toBe(0);

    for (const d of docs) (d as any).fullscreenElement = root;
    btn.dispatchEvent("click");
    expect(exited).toBe(1);
    expect(requested.length).toBe(1);
  });
});

// ============================================================================
// Player state machine
// ============================================================================

describe("Video v2: player state machine", () => {
  test("idle → loading → playing ⇄ paused → ended", () => {
    const { renderer } = makeRenderer();
    const { root, media } = createVideo(renderer, {});
    equipMedia(media);

    // No source resolved yet.
    expect(playerState(root)).toBe("idle");

    renderer.applyPatches([
      { type: "setProp", id: "vid", name: "src", value: "https://cdn/a.mp4" } as Patch,
    ]);
    // A source is resolving.
    expect(playerState(root)).toBe("loading");

    // Ready but never played: poster state, not a perpetual spinner.
    media.dispatchEvent("canplay");
    expect(playerState(root)).toBe("idle");

    media.dispatchEvent("play");
    expect(playerState(root)).toBe("playing");

    media.dispatchEvent("pause");
    expect(playerState(root)).toBe("paused");

    media.dispatchEvent("play");
    media.dispatchEvent("ended");
    expect(playerState(root)).toBe("ended");
  });

  test("rebuffer re-enters loading WITHOUT dispatching onPause", () => {
    const { renderer, engine } = makeRenderer();
    const { root, media } = createVideo(renderer, {
      src: "https://cdn/a.mp4",
      onPause: "@actions.paused",
    });
    equipMedia(media);

    media.dispatchEvent("canplay");
    media.dispatchEvent("play");
    expect(playerState(root)).toBe("playing");

    media.dispatchEvent("waiting");
    expect(playerState(root)).toBe("loading");
    expect(engine.actionsNamed("paused").length).toBe(0);

    media.dispatchEvent("playing");
    expect(playerState(root)).toBe("playing");
    expect(engine.actionsNamed("paused").length).toBe(0);

    // A real pause still reports.
    media.dispatchEvent("pause");
    expect(playerState(root)).toBe("paused");
    expect(engine.actionsNamed("paused").length).toBe(1);
  });

  test("a media error is the sticky error state; a new source clears it", async () => {
    globalThis.fetch = (async () => ({ ok: true, status: 200 }) as Response) as typeof fetch;
    const { renderer } = makeRenderer();
    const { root, media } = createVideo(renderer, { src: "https://cdn/a.mp4" });
    equipMedia(media);

    media.dispatchEvent("error");
    await flushMicrotasks(5);
    expect(playerState(root)).toBe("error");
    expect(media.dataset.hypenVideoError).toBe("true");
    // Built-in error surface: the quiet black box.
    expect(media.style.getPropertyValue("background-color")).toBe("#000");

    renderer.applyPatches([
      { type: "setProp", id: "vid", name: "src", value: "https://cdn/b.mp4" } as Patch,
    ]);
    expect(playerState(root)).toBe("loading");
    expect(media.dataset.hypenVideoError).toBeUndefined();
    // Pre-existing bug: the black background outlived the error state and
    // blacked out every later successful load.
    expect(media.style.getPropertyValue("background-color")).toBe("");
  });

  test("mid-playlist ended is not the ended state (only the last track is)", () => {
    const { renderer } = makeRenderer();
    const { root, media } = createVideo(renderer, {
      playlist: ["https://cdn/ep1.mp4", "https://cdn/ep2.mp4"],
    });
    equipMedia(media);
    media.dispatchEvent("canplay");
    media.dispatchEvent("play");

    media.dispatchEvent("ended"); // advances to ep2
    expect(playerState(root)).not.toBe("ended");
    expect(media.src).toBe("https://cdn/ep2.mp4");

    media.dispatchEvent("play");
    media.dispatchEvent("ended"); // queue exhausted
    expect(playerState(root)).toBe("ended");
  });
});

// ============================================================================
// Playback bind
// ============================================================================

describe("Video v2: playback bind reports", () => {
  test("transitions report immediately; position is throttled to 250ms", async () => {
    let clock = 1000;
    __setVideoClockForTests(() => clock);

    const { renderer, engine } = makeRenderer();
    const { media } = createVideo(renderer, {
      src: "https://cdn/a.mp4",
      bind: "playback",
    });
    equipMedia(media);
    await flushMicrotasks(2);
    engine.clear();

    media.dispatchEvent("canplay"); // duration becomes known
    media.dispatchEvent("play");

    // Transitions: state + playing go out immediately, one key at a time.
    expect(engine.binds("state")).toContain("playing");
    expect(engine.binds("playing")).toEqual([true]);
    for (const action of engine.actionsNamed("__hypen_bind")) {
      expect(action.payload.path.startsWith("playback.")).toBe(true);
    }

    engine.clear();

    // Same tick as the last report → throttled away.
    media.currentTime = 5;
    media.dispatchEvent("timeupdate");
    expect(engine.binds("position")).toEqual([]);

    clock += PLAYBACK_REPORT_INTERVAL_MS - 1;
    media.currentTime = 6;
    media.dispatchEvent("timeupdate");
    expect(engine.binds("position")).toEqual([]);

    clock += 2; // now past the 250ms window
    media.currentTime = 7;
    media.dispatchEvent("timeupdate");
    expect(engine.binds("position")).toEqual([7]);

    // A transition (seek completion) bypasses the throttle.
    engine.clear();
    media.currentTime = 50;
    media.dispatchEvent("seeked");
    expect(engine.binds("position")).toEqual([50]);

    // Duration is renderer-owned and reported immediately when it changes.
    engine.clear();
    media.duration = 200;
    media.dispatchEvent("durationchange");
    expect(engine.binds("duration")).toEqual([200]);
  });

  test("playing stays true across a rebuffer while state reports loading", async () => {
    const { renderer, engine } = makeRenderer();
    const { media } = createVideo(renderer, { src: "https://cdn/a.mp4", bind: "playback" });
    equipMedia(media);
    await flushMicrotasks(2);

    media.dispatchEvent("play");
    engine.clear();
    media.dispatchEvent("waiting");

    expect(engine.binds("state")).toEqual(["loading"]);
    expect(engine.binds("playing")).toEqual([]);
  });
});

describe("Video v2: playback bind writes", () => {
  function boundVideo() {
    const { renderer, engine } = makeRenderer();
    const { root, media } = createVideo(renderer, {
      src: "https://cdn/a.mp4",
      bind: "playback",
    });
    equipMedia(media);
    return { renderer, engine, root, media };
  }

  function writePlayback(renderer: DOMRenderer, value: Record<string, unknown>): void {
    renderer.applyPatches([
      { type: "setProp", id: "vid", name: "playback", value } as Patch,
    ]);
  }

  test("position writes within 1s are ignored; beyond apply and clamp", () => {
    const { renderer, media } = boundVideo();
    media.currentTime = 10;

    writePlayback(renderer, { position: 10.5 });
    expect(media.currentTime).toBe(10);

    writePlayback(renderer, { position: 11 });
    expect(media.currentTime).toBe(10); // exactly 1s is not "more than" 1s

    writePlayback(renderer, { position: 40 });
    expect(media.currentTime).toBe(40);

    writePlayback(renderer, { position: -5 });
    expect(media.currentTime).toBe(0);

    writePlayback(renderer, { position: 999 });
    expect(media.currentTime).toBe(120); // clamped to duration
  });

  test("an echoed report never seeks and never re-reports (loop converges)", () => {
    let clock = 5000;
    __setVideoClockForTests(() => clock);
    const { renderer, engine, media } = boundVideo();

    clock += 1000;
    media.currentTime = 30;
    media.dispatchEvent("timeupdate");
    expect(engine.binds("position")).toEqual([30]);

    engine.clear();
    // Module state now holds 30 and echoes it straight back.
    writePlayback(renderer, { position: 30, duration: 120, state: "playing" });
    expect(media.currentTime).toBe(30);
    expect(engine.actionsNamed("__hypen_bind").length).toBe(0);

    // …and the next tick at the same position stays quiet too.
    clock += 1000;
    media.dispatchEvent("timeupdate");
    expect(engine.binds("position")).toEqual([]);
  });

  test("a lagging echo storm is broken within a few flips (storm breaker)", () => {
    // The engine echoes every report as a whole-struct SetProp; reports
    // alternate on real transitions, so a lagging echo stream ping-ponged
    // play/pause at round-trip rate (observed live at ~50 cycles/s). The
    // storm breaker lets isolated commands through but suppresses further
    // flips once several inbound writes have flipped state inside the
    // window while matching our own recent reports.
    let clock = 10000;
    __setVideoClockForTests(() => clock);
    const { renderer, engine, media } = boundVideo();
    const calls = equipMedia(media);

    media.dispatchEvent("play");   // report playing:true
    clock += 100;
    media.dispatchEvent("pause");  // report playing:false (the seed)
    engine.clear();

    // Simulate the alternating echo stream at round-trip cadence.
    const playsBefore = calls.plays;
    for (let i = 0; i < 10; i++) {
      clock += 20;
      writePlayback(renderer, { playing: i % 2 === 0, position: 0, duration: 120, state: "playing" });
    }
    // The breaker kills the loop within PLAYING_STORM_FLIPS applications —
    // not one per echo.
    expect(calls.plays - playsBefore).toBeLessThanOrEqual(2);

    // After the storm drains, a genuine module command applies normally.
    clock += 3000;
    if (!media.paused) { media.pause(); clock += 100; engine.clear(); }
    clock += 3000;
    const before = calls.plays;
    writePlayback(renderer, { playing: true });
    expect(calls.plays).toBe(before + 1);
  });

  test("an echo arriving while currentTime advanced does not bypass the throttle", () => {
    // Regression: applyProps used to end with an IMMEDIATE report, so each
    // engine echo of our own report re-reported the now-advanced position —
    // a self-sustaining loop at echo round-trip rate while playing.
    let clock = 5000;
    __setVideoClockForTests(() => clock);
    const { renderer, engine, media } = boundVideo();
    media.dispatchEvent("play");
    engine.clear(); // drop the play transition's immediate report

    clock += 1000;
    media.currentTime = 10;
    media.dispatchEvent("timeupdate");
    expect(engine.binds("position")).toEqual([10]);
    engine.clear();

    // Echo lands 20ms later; playback has advanced meanwhile. Inside the
    // 250ms window this must stay silent — no unthrottled tail report.
    clock += 20;
    media.currentTime = 10.02;
    writePlayback(renderer, { playing: true, position: 10, duration: 120, state: "playing" });
    expect(engine.binds("position")).toEqual([]);

    // The next report flows once the throttle window reopens.
    clock += 250;
    media.currentTime = 10.3;
    media.dispatchEvent("timeupdate");
    expect(engine.binds("position")).toEqual([10.3]);
  });

  test("playing writes play/pause; true in `ended` restarts from 0", () => {
    const { renderer, root, media } = boundVideo();
    const calls = equipMedia(media);

    writePlayback(renderer, { playing: true });
    expect(calls.plays).toBe(1);
    expect(playerState(root)).toBe("playing");

    writePlayback(renderer, { playing: false });
    expect(media.paused).toBe(true);
    expect(playerState(root)).toBe("paused");

    media.dispatchEvent("play");
    media.currentTime = 118;
    media.dispatchEvent("ended");
    expect(playerState(root)).toBe("ended");

    writePlayback(renderer, { playing: true });
    expect(media.currentTime).toBe(0);
    expect(playerState(root)).toBe("playing");
  });

  test("duration and state writes are ignored", () => {
    const { renderer, root, media } = boundVideo();
    media.dispatchEvent("canplay");

    writePlayback(renderer, { duration: 9, state: "error" });

    expect(media.duration).toBe(120);
    expect(playerState(root)).toBe("idle");
  });

  test("one-way `playing` prop is the controlled subset (module drives)", () => {
    const { renderer } = makeRenderer();
    const { root, media } = createVideo(renderer, { src: "https://cdn/a.mp4" });
    const calls = equipMedia(media);
    media.dispatchEvent("canplay");
    expect(playerState(root)).toBe("idle");

    renderer.applyPatches([
      { type: "setProp", id: "vid", name: "playing", value: true } as Patch,
    ]);
    expect(calls.plays).toBe(1);
    expect(playerState(root)).toBe("playing");

    renderer.applyPatches([
      { type: "setProp", id: "vid", name: "playing", value: false } as Patch,
    ]);
    expect(media.paused).toBe(true);
    expect(playerState(root)).toBe("paused");

    // Shares the bind's write semantics: true in `ended` restarts from 0.
    media.dispatchEvent("play");
    media.currentTime = 118;
    media.dispatchEvent("ended");
    expect(playerState(root)).toBe("ended");
    renderer.applyPatches([
      { type: "setProp", id: "vid", name: "playing", value: true } as Patch,
    ]);
    expect(media.currentTime).toBe(0);
    expect(playerState(root)).toBe("playing");
  });

  test("a combined {playing, position} write in `ended` resumes at the position", () => {
    // "Continue watching": the module writes play intent AND the resume
    // point in one struct. The restart-from-`ended` rule must yield — the
    // explicit seek is what the viewer asked for.
    const { renderer, root, media } = boundVideo();
    media.dispatchEvent("canplay");
    media.dispatchEvent("play");
    media.currentTime = 120;
    media.dispatchEvent("ended");
    expect(playerState(root)).toBe("ended");

    writePlayback(renderer, { playing: true, position: 30 });

    expect(media.currentTime).toBe(30);
    expect(playerState(root)).toBe("playing");
  });

  test("a bare `playing: true` in `ended` still restarts from 0, echoes included", () => {
    const { renderer, root, media } = boundVideo();
    media.dispatchEvent("canplay");
    media.dispatchEvent("play");
    media.currentTime = 120;
    media.dispatchEvent("ended");

    // The struct carries the position we ourselves just reported: an echo,
    // not a seek request — restart wins.
    writePlayback(renderer, { playing: true, position: 120 });

    expect(media.currentTime).toBe(0);
    expect(playerState(root)).toBe("playing");
  });

  test("startPosition seeks once, when the source becomes seekable", () => {
    const { renderer } = makeRenderer();
    const { media } = createVideo(renderer, {
      src: "https://cdn/a.mp4",
      startPosition: 30,
    });
    equipMedia(media);

    // Not seekable yet at create time (no duration): nothing applied.
    expect(media.currentTime).toBe(0);

    media.dispatchEvent("loadedmetadata");
    expect(media.currentTime).toBe(30);

    // Applied ONCE: a later readiness event must not yank the viewer back.
    media.currentTime = 45;
    media.dispatchEvent("loadedmetadata");
    media.dispatchEvent("canplay");
    expect(media.currentTime).toBe(45);
  });

  test("startPosition re-arms when the SOURCE changes, value unchanged", () => {
    // Contract: "It re-arms when the source configuration (src/playlist/
    // headers) changes" — not merely when its own value changes.
    const { renderer } = makeRenderer();
    const { media } = createVideo(renderer, {
      src: "https://cdn/ep1.mp4",
      startPosition: 30,
    });
    equipMedia(media);
    media.dispatchEvent("loadedmetadata");
    expect(media.currentTime).toBe(30);
    media.currentTime = 88; // watched on past the resume point

    // Next episode, same resume point: the value never changes.
    renderer.applyPatches([
      { type: "setProp", id: "vid", name: "src", value: "https://cdn/ep2.mp4" } as Patch,
    ]);
    // Nothing seeks while the new source is still loading.
    expect(media.currentTime).toBe(88);

    media.dispatchEvent("loadedmetadata");
    expect(media.currentTime).toBe(30);
  });

  test("a src+startPosition retarget under headers seeks the NEW source", async () => {
    // The headers tier assigns `src` after an async fetch, so the OLD source
    // is still loaded (and seekable) when the accompanying startPosition
    // lands: seeking it would scrub the outgoing video and burn the one-shot.
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      blob: async () => new Blob(["bytes"], { type: "video/mp4" }),
    })) as unknown as typeof fetch;

    const { renderer } = makeRenderer();
    const { media } = createVideo(renderer, {
      src: "https://cdn/ep1.mp4",
      headers: { Authorization: "Bearer t" },
      startPosition: 10,
    });
    equipMedia(media);
    await flushMicrotasks(5);
    media.dispatchEvent("loadedmetadata");
    expect(media.currentTime).toBe(10);
    media.currentTime = 55;

    // Both change in the same batch.
    renderer.applyPatches([
      { type: "setProp", id: "vid", name: "src", value: "https://cdn/ep2.mp4" } as Patch,
      { type: "setProp", id: "vid", name: "startPosition", value: 42 } as Patch,
    ]);
    // The old source is untouched while its replacement is still in flight.
    expect(media.currentTime).toBe(55);

    await flushMicrotasks(5);
    media.dispatchEvent("loadedmetadata");
    expect(media.currentTime).toBe(42);
  });

  test("playlist auto-advance does NOT re-arm startPosition", () => {
    // Queue movement is not a source-configuration change: the resume point
    // belongs to the entry into the playlist, not to every track.
    const { renderer } = makeRenderer();
    const { media } = createVideo(renderer, {
      playlist: ["https://cdn/a.mp4", "https://cdn/b.mp4"],
      startPosition: 5,
    });
    equipMedia(media);
    media.dispatchEvent("loadedmetadata");
    expect(media.currentTime).toBe(5);

    media.dispatchEvent("play");
    media.currentTime = 99;
    media.dispatchEvent("ended"); // advances to track 2
    expect(media.src).toBe("https://cdn/b.mp4");

    media.dispatchEvent("loadedmetadata");
    expect(media.currentTime).toBe(99);
  });
});

// ============================================================================
// Composition slots
// ============================================================================

describe("Video v2: composition slots", () => {
  test("visibility matches VIDEO_SLOT_VISIBILITY for every state", async () => {
    globalThis.fetch = (async () => ({ ok: true, status: 200 }) as Response) as typeof fetch;
    const { renderer } = makeRenderer();
    const { root, media } = createVideo(renderer, { src: "https://cdn/a.mp4" });
    equipMedia(media);

    const children: Record<VideoSlotName, FakeElement> = {} as any;
    for (const slot of VIDEO_SLOTS) {
      children[slot] = addSlot(renderer, "vid", slot);
    }

    const states: VideoPlayerState[] = [
      "idle",
      "loading",
      "playing",
      "paused",
      "ended",
      "error",
    ];

    for (const state of states) {
      driveTo(media, state);
      await flushMicrotasks(2);
      expect(playerState(root)).toBe(state);

      for (const slot of VIDEO_SLOTS) {
        const expectVisible = VIDEO_SLOT_VISIBILITY[slot][state];
        expect({ slot, state, visible: !isHidden(children[slot]) }).toEqual({
          slot,
          state,
          visible: expectVisible,
        });
      }
    }
  });

  test("controls slot is visible in idle and can start first play", () => {
    const { renderer, engine } = makeRenderer();
    const { root, media } = createVideo(renderer, {
      src: "https://cdn/a.mp4",
      bind: "playback",
    });
    equipMedia(media);
    const controls = addSlot(renderer, "vid", "controls");

    // Ready-but-never-played is `idle` — and the controls slot shows, so a
    // custom play button is reachable before playback has ever begun.
    media.dispatchEvent("canplay");
    expect(playerState(root)).toBe("idle");
    expect(isHidden(controls)).toBe(false);

    // The slot button's toggle dispatches a `playing` write through the
    // bind; the write must actually start first play from `idle`.
    engine.clear();
    renderer.applyPatches([
      { type: "setProp", id: "vid", name: "playback", value: { playing: true } } as Patch,
    ]);
    expect(playerState(root)).toBe("playing");
    expect(isHidden(controls)).toBe(false);
    expect(engine.binds("state")).toContain("playing");
  });

  test("slot children are overlaid full-bleed, poster under loading under controls", () => {
    const { renderer } = makeRenderer();
    createVideo(renderer, { src: "https://cdn/a.mp4" });
    const poster = addSlot(renderer, "vid", "poster");
    const loading = addSlot(renderer, "vid", "loading");
    const controls = addSlot(renderer, "vid", "controls");

    for (const el of [poster, loading, controls]) {
      expect(el.style.getPropertyValue("position")).toBe("absolute");
      expect(el.style.getPropertyValue("top")).toBe("0");
      expect(el.style.getPropertyValue("bottom")).toBe("0");
      expect(el.style.getPropertyValue("left")).toBe("0");
      expect(el.style.getPropertyValue("right")).toBe("0");
    }
    expect(Number(poster.style.getPropertyValue("z-index"))).toBeLessThan(
      Number(loading.style.getPropertyValue("z-index"))
    );
    expect(Number(loading.style.getPropertyValue("z-index"))).toBeLessThan(
      Number(controls.style.getPropertyValue("z-index"))
    );
  });

  test("a controls slot suppresses native controls regardless of the prop", () => {
    const { renderer } = makeRenderer();
    const { media } = createVideo(renderer, {
      src: "https://cdn/a.mp4",
      controls: true,
    });
    expect(media.controls).toBe(true);

    addSlot(renderer, "vid", "controls");
    expect(media.controls).toBe(false);

    // Re-asserting the prop while the slot is present changes nothing.
    renderer.applyPatches([
      { type: "setProp", id: "vid", name: "controls", value: true } as Patch,
    ]);
    expect(media.controls).toBe(false);

    // Slot leaves (When/ForEach): the native chrome comes back.
    renderer.applyPatches([{ type: "remove", id: "slot-controls" } as Patch]);
    expect(media.controls).toBe(true);
  });

  test("a poster slot suppresses the poster attribute", () => {
    const { renderer } = makeRenderer();
    const { media } = createVideo(renderer, {
      src: "https://cdn/a.mp4",
      poster: "https://cdn/p.jpg",
    });
    expect(media.poster).toBe("https://cdn/p.jpg");

    addSlot(renderer, "vid", "poster");
    expect(media.poster).toBe("");

    renderer.applyPatches([{ type: "remove", id: "slot-poster" } as Patch]);
    expect(media.poster).toBe("https://cdn/p.jpg");
  });

  test("an error slot replaces the built-in error surface", async () => {
    globalThis.fetch = (async () => ({ ok: true, status: 200 }) as Response) as typeof fetch;
    const { renderer } = makeRenderer();
    const { root, media } = createVideo(renderer, { src: "https://cdn/a.mp4" });
    equipMedia(media);
    const slot = addSlot(renderer, "vid", "error");

    media.dispatchEvent("error");
    await flushMicrotasks(5);

    expect(playerState(root)).toBe("error");
    expect(isHidden(slot)).toBe(false);
    // No black box: the slot content IS the error surface.
    expect(media.style.getPropertyValue("background-color")).toBe("");
  });

  test("visibility is show/hide, never unmount (slot subtrees keep state)", () => {
    const { renderer } = makeRenderer();
    const { media } = createVideo(renderer, { src: "https://cdn/a.mp4" });
    equipMedia(media);
    const controls = addSlot(renderer, "vid", "controls");
    const node = renderer.getNode("slot-controls");

    media.dispatchEvent("play");
    expect(isHidden(controls)).toBe(false);
    media.dispatchEvent("waiting"); // rebuffer → loading; controls stay visible
    expect(isHidden(controls)).toBe(false);
    media.dispatchEvent("error"); // error is the state that hides controls
    expect(isHidden(controls)).toBe(true);

    // Same element instance throughout — no rebuild.
    expect(renderer.getNode("slot-controls")).toBe(node!);
    expect(controls.parentNode).toBeTruthy();
  });
});

// ============================================================================
// Scrubber
// ============================================================================

describe("Video v2: Scrubber", () => {
  function makeScrubber(videoProps: Record<string, any>, scrubberProps: Record<string, any> = {}) {
    const { renderer, engine } = makeRenderer();
    const { root, media } = createVideo(renderer, videoProps);
    const calls = equipMedia(media, 100);
    addSlot(renderer, "vid", "controls");
    renderer.applyPatches([
      { type: "create", id: "scr", elementType: "Scrubber", props: scrubberProps } as Patch,
      { type: "insert", parentId: "slot-controls", id: "scr" } as Patch,
    ]);
    const scrubber = renderer.getNode("scr") as unknown as FakeElement;
    scrubber.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      right: 200,
      bottom: 16,
      width: 200,
      height: 16,
    });
    return { renderer, engine, root, media, scrubber, calls };
  }

  test("drag previews locally and only the release commits (through the video bind)", () => {
    const { engine, media, scrubber } = makeScrubber({
      src: "https://cdn/a.mp4",
      bind: "playback",
    });
    engine.clear();

    scrubber.dispatchEvent("pointerdown", { clientX: 100, pointerId: 1 });
    // Preview only: no state writes, and the media element is untouched.
    expect(engine.actions.length).toBe(0);
    expect(media.currentTime).toBe(0);
    expect(scrubber.getAttribute("aria-valuenow")).toBe("50");

    scrubber.dispatchEvent("pointermove", { clientX: 150, pointerId: 1 });
    expect(engine.actions.length).toBe(0);
    expect(scrubber.getAttribute("aria-valuenow")).toBe("75");

    scrubber.dispatchEvent("pointerup", { clientX: 150, pointerId: 1 });
    expect(media.currentTime).toBe(75);
    expect(engine.actionsNamed("__hypen_bind").map((a) => a.payload)).toEqual([
      { path: "playback.position", value: 75 },
    ]);
  });

  test("pointercancel reverts the preview and commits nothing", () => {
    // An aborted gesture (scroll takeover, palm rejection) is not a release.
    // `pointercancel` carries degenerate coordinates (0,0 in Chrome), so a
    // commit here seeks the viewer to the very start of the video.
    const { engine, media, scrubber } = makeScrubber({
      src: "https://cdn/a.mp4",
      bind: "playback",
    });
    media.currentTime = 40;
    engine.clear();

    scrubber.dispatchEvent("pointerdown", { clientX: 100, pointerId: 1 });
    expect(scrubber.getAttribute("aria-valuenow")).toBe("50");

    scrubber.dispatchEvent("pointercancel", { clientX: 0, pointerId: 1 });

    expect(media.currentTime).toBe(40); // no local seek
    expect(engine.actions.length).toBe(0); // no commit
    expect(scrubber.getAttribute("aria-valuenow")).toBe("40"); // preview reverted

    // A stray release after the cancel must not resurrect the drag.
    scrubber.dispatchEvent("pointerup", { clientX: 0, pointerId: 1 });
    expect(media.currentTime).toBe(40);
    expect(engine.actions.length).toBe(0);
  });

  test("the Scrubber's OWN bind wins over the enclosing Video's bind", () => {
    const { engine, media, scrubber } = makeScrubber(
      { src: "https://cdn/a.mp4", bind: "playback" },
      { bind: "scrub" }
    );
    engine.clear();

    scrubber.dispatchEvent("pointerdown", { clientX: 100, pointerId: 1 });
    scrubber.dispatchEvent("pointerup", { clientX: 100, pointerId: 1 });

    // Local seek applies in every case; the commit goes to the OWN bind.
    expect(media.currentTime).toBe(50);
    expect(engine.actionsNamed("__hypen_bind").map((a) => a.payload)).toEqual([
      { path: "scrub.position", value: 50 },
    ]);
  });

  test("without a bind it dispatches its own onSeek action", () => {
    const { engine, media, scrubber } = makeScrubber(
      { src: "https://cdn/a.mp4" },
      { onSeek: "@actions.seek" }
    );
    engine.clear();

    scrubber.dispatchEvent("pointerdown", { clientX: 20, pointerId: 1 });
    scrubber.dispatchEvent("pointerup", { clientX: 20, pointerId: 1 });

    expect(media.currentTime).toBe(10);
    expect(engine.actionsNamed("__hypen_bind").length).toBe(0);
    expect(engine.actionsNamed("seek")[0]!.payload).toEqual({
      type: "seek",
      position: 10,
    });
  });

  test("arrow keys seek ±5s and commit immediately", () => {
    const { engine, media, scrubber } = makeScrubber({
      src: "https://cdn/a.mp4",
      bind: "playback",
    });
    media.currentTime = 20;
    engine.clear();

    scrubber.dispatchEvent("keydown", { key: "ArrowRight" });
    expect(media.currentTime).toBe(25);
    expect(engine.binds("position")).toEqual([25]);

    scrubber.dispatchEvent("keydown", { key: "ArrowLeft" });
    expect(media.currentTime).toBe(20);
    expect(engine.binds("position")).toEqual([25, 20]);

    // Non-arrow keys are ignored.
    scrubber.dispatchEvent("keydown", { key: "a" });
    expect(engine.binds("position")).toEqual([25, 20]);

    // Clamped to [0, duration].
    media.currentTime = 2;
    scrubber.dispatchEvent("keydown", { key: "ArrowLeft" });
    expect(media.currentTime).toBe(0);
    media.currentTime = 98;
    scrubber.dispatchEvent("keydown", { key: "ArrowRight" });
    expect(media.currentTime).toBe(100);
  });

  test("aria exposes the timeline as a slider", async () => {
    const { media, scrubber } = makeScrubber({ src: "https://cdn/a.mp4" });
    // Wiring to the enclosing player settles a microtask after the batch.
    await flushMicrotasks(2);
    media.currentTime = 30;
    media.dispatchEvent("timeupdate");

    expect(scrubber.getAttribute("role")).toBe("slider");
    expect(scrubber.getAttribute("aria-valuemin")).toBe("0");
    expect(scrubber.getAttribute("aria-valuemax")).toBe("100");
    expect(scrubber.getAttribute("aria-valuenow")).toBe("30");
    expect(scrubber.getAttribute("aria-valuetext")).toBe("0:30 of 1:40");
  });

  test("outside a Video it renders inert", () => {
    const { renderer, engine } = makeRenderer();
    renderer.applyPatches([
      { type: "create", id: "root-1", elementType: "Column", props: {} } as Patch,
      { type: "create", id: "scr", elementType: "Scrubber", props: {} } as Patch,
      { type: "insert", parentId: "root-1", id: "scr" } as Patch,
    ]);
    const scrubber = renderer.getNode("scr") as unknown as FakeElement;
    scrubber.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      right: 200,
      bottom: 16,
      width: 200,
      height: 16,
    });

    expect(scrubber.getAttribute("aria-disabled")).toBe("true");
    expect(scrubber.getAttribute("tabindex")).toBe("-1");

    scrubber.dispatchEvent("pointerdown", { clientX: 100, pointerId: 1 });
    scrubber.dispatchEvent("pointerup", { clientX: 100, pointerId: 1 });
    scrubber.dispatchEvent("keydown", { key: "ArrowRight" });
    expect(engine.actions.length).toBe(0);
  });
});

// ============================================================================
// Playlist auto-advance under `headers` (async load ordering)
// ============================================================================

describe("Video v2: playlist advance under headers", () => {
  test("plays the NEXT track only once its async load has landed", async () => {
    const fetched: string[] = [];
    globalThis.fetch = (async (url: any) => {
      fetched.push(String(url));
      return {
        ok: true,
        status: 200,
        blob: async () => new Blob(["bytes"], { type: "video/mp4" }),
      } as unknown as Response;
    }) as typeof fetch;

    const { renderer } = makeRenderer();
    const { media } = createVideo(renderer, {
      playlist: ["https://cdn/ep1.mp4", "https://cdn/ep2.mp4"],
      headers: { Authorization: "Bearer t" },
    });
    const calls = equipMedia(media);

    await flushMicrotasks(5);
    expect(fetched).toEqual(["https://cdn/ep1.mp4"]);
    const firstSrc = media.src;
    calls.plays = 0;

    media.dispatchEvent("ended");
    // The next track's bytes are still in flight: playing here would replay
    // the old source and strand the new track paused.
    expect(calls.plays).toBe(0);
    expect(media.src).toBe(firstSrc);

    await flushMicrotasks(5);
    expect(fetched).toEqual(["https://cdn/ep1.mp4", "https://cdn/ep2.mp4"]);
    expect(media.src).not.toBe(firstSrc);
    expect(calls.plays).toBe(1);
  });
});
