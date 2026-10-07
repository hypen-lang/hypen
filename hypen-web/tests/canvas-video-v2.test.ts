import { semanticAction } from "./helpers";
/**
 * Canvas Video v2 Tests — player state machine, playback bind, composition
 * slots, Scrubber.
 *
 * Normative spec: hypen-docs/content/docs/guide/components.mdx §"Playback control & composition
 * slots". The shared constants (`VIDEO_SLOT_VISIBILITY`,
 * `PLAYBACK_REPORT_INTERVAL_MS`, `PLAYBACK_SEEK_EPSILON_S`) are imported
 * from `@hypen-space/core/types` and driven directly — the table below is
 * NOT re-declared here, so a spec change fails these tests rather than
 * silently diverging.
 *
 * Same harness as canvas-video.test.ts: a fake 2D context capturing draw
 * calls, `getVideoElement` to reach the offscreen (fake) <video> whose
 * events are fired by hand, and `setVideoActionDispatcher` to capture both
 * action dispatches and `__hypen_bind` write-backs.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  paintNode,
  getVideoElement,
  getVideoPlayerState,
  getVideoPlayback,
  getScrubberFraction,
  beginScrubberDrag,
  updateScrubberDrag,
  commitScrubberDrag,
  isScrubberLive,
  clearVideoCache,
  setVideoActionDispatcher,
  setVideoNaturalSize,
} from "../packages/web/src/canvas/paint.js";
import { computeLayout } from "../packages/web/src/canvas/layout.js";
import { CanvasEventManager } from "../packages/web/src/canvas/events.js";
import type { VirtualNode } from "../packages/web/src/canvas/types.js";
import {
  VIDEO_SLOTS,
  VIDEO_SLOT_VISIBILITY,
  PLAYBACK_REPORT_INTERVAL_MS,
  PLAYBACK_SEEK_EPSILON_S,
  type VideoPlayerState,
  type VideoSlotName,
} from "../packages/core/src/types";
import { ensureFakeDomGlobals } from "./fake-dom";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Mock 2D context recording draw calls WITH the fill style in effect. */
class MockCanvasContext {
  calls: Array<{ method: string; args: any[]; fillStyle: any }> = [];

  fillStyle: any = "#000000";
  strokeStyle: string = "#000000";
  lineWidth: number = 1;
  font: string = "10px sans-serif";
  textAlign: string = "left";
  textBaseline: string = "top";
  globalAlpha: number = 1;

  canvas: any = { dispatchEvent: () => true };

  private record(method: string, ...args: any[]) {
    this.calls.push({ method, args, fillStyle: this.fillStyle });
  }

  save() { this.record("save"); }
  restore() { this.record("restore"); }
  scale() {}
  translate() {}
  fillRect(x: number, y: number, w: number, h: number) { this.record("fillRect", x, y, w, h); }
  strokeRect(x: number, y: number, w: number, h: number) { this.record("strokeRect", x, y, w, h); }
  clearRect(x: number, y: number, w: number, h: number) { this.record("clearRect", x, y, w, h); }
  fillText(text: string, x: number, y: number) { this.record("fillText", text, x, y); }
  measureText(text: string) { return { width: text.length * 8 }; }
  beginPath() { this.record("beginPath"); }
  closePath() { this.record("closePath"); }
  moveTo(x: number, y: number) { this.record("moveTo", x, y); }
  lineTo(x: number, y: number) { this.record("lineTo", x, y); }
  arcTo(...args: any[]) { this.record("arcTo", ...args); }
  arc(...args: any[]) { this.record("arc", ...args); }
  fill() { this.record("fill"); }
  stroke() { this.record("stroke"); }
  clip() { this.record("clip"); }
  rect(x: number, y: number, w: number, h: number) { this.record("rect", x, y, w, h); }
  drawImage(...args: any[]) { this.record("drawImage", ...args); }

  wasCalled(method: string): boolean {
    return this.calls.some((c) => c.method === method);
  }
  callsOf(method: string) {
    return this.calls.filter((c) => c.method === method);
  }
  /** Did anything paint with this fill colour? (slot markers use one each) */
  paintedWith(color: string): boolean {
    return this.calls.some(
      (c) => (c.method === "fillRect" || c.method === "fill") && c.fillStyle === color,
    );
  }
  clearCalls() {
    this.calls = [];
  }
}

let nodeCounter = 0;

function makeNode(
  type: string,
  props: Record<string, any> = {},
  children: VirtualNode[] = [],
): VirtualNode {
  const node: VirtualNode = {
    id: `v2n${++nodeCounter}`,
    type,
    props,
    children,
    parent: null,
    visible: true,
    opacity: 1,
    clickable: props.onClick != null || props.action != null,
    hoverable: false,
    focusable: false,
    focused: false,
    hovered: false,
  };
  for (const child of children) child.parent = node;
  return node;
}

/** A slot child that paints a single identifiable coloured box. */
function slotChild(slot: string, color: string, children: VirtualNode[] = []): VirtualNode {
  return makeNode("column", { "slot.0": slot, backgroundColor: color }, children);
}

function layoutTree(root: VirtualNode, ctx: MockCanvasContext, w = 800, h = 600): void {
  computeLayout(ctx as any, root, w, h, 0, 0);
}

function fire(el: any, type: string): void {
  el.dispatchEvent(type, {});
}

/** Drive the offscreen element's events until the entry reports `state`. */
function driveToState(el: any, state: VideoPlayerState): void {
  switch (state) {
    case "idle":
      break; // fresh entry with no autoplay
    case "loading":
      el.paused = false;
      fire(el, "play");
      fire(el, "waiting");
      break;
    case "playing":
      el.paused = false;
      fire(el, "play");
      break;
    case "paused":
      el.paused = false;
      fire(el, "play");
      el.paused = true;
      fire(el, "pause");
      break;
    case "ended":
      el.paused = false;
      fire(el, "play");
      el.ended = true;
      el.paused = true;
      fire(el, "ended");
      break;
    case "error":
      el.error = { code: 4, message: "decode" };
      fire(el, "error");
      break;
  }
}

let dispatched: Array<{ name: string; payload: any }> = [];

function bindWrites(): Array<{ path: string; value: any }> {
  return dispatched
    .filter((d) => d.name === "__hypen_bind")
    .map((d) => ({ path: d.payload.path, value: d.payload.value }));
}

function bindWritesTo(field: string): any[] {
  return bindWrites().filter((w) => w.path.endsWith(`.${field}`)).map((w) => w.value);
}

const realNow = Date.now;
function setClock(ms: number): void {
  Date.now = () => ms;
}

beforeEach(() => {
  ensureFakeDomGlobals();
  clearVideoCache();
  dispatched = [];
  setVideoActionDispatcher((name, payload) => dispatched.push(semanticAction(name, payload)));
});

afterEach(() => {
  Date.now = realNow;
  clearVideoCache();
  setVideoActionDispatcher(null);
});

const SRC = "https://cdn.example/v2.mp4";

/** Video node with a rect, laid out, painted once (entry created). */
function mountVideo(
  props: Record<string, any> = {},
  children: VirtualNode[] = [],
): { video: VirtualNode; root: VirtualNode; ctx: MockCanvasContext; el: any } {
  const ctx = new MockCanvasContext();
  const video = makeNode("video", { src: SRC, width: 320, height: 180, ...props }, children);
  const root = makeNode("column", { width: 800, height: 600 }, [video]);
  layoutTree(root, ctx);
  paintNode(ctx as any, root);
  return { video, root, ctx, el: getVideoElement(video.id) as any };
}

// ---------------------------------------------------------------------------
// Player state machine
// ---------------------------------------------------------------------------

describe("Video v2: player state machine", () => {
  test("a source with no playback intent stays idle", () => {
    const { video } = mountVideo();
    expect(getVideoPlayerState(video.id)).toBe("idle");
  });

  test("autoplay enters loading, play → playing, pause → paused", () => {
    const { video, el } = mountVideo({ autoplay: true });
    expect(getVideoPlayerState(video.id)).toBe("loading");

    el.paused = false;
    fire(el, "play");
    expect(getVideoPlayerState(video.id)).toBe("playing");

    el.paused = true;
    fire(el, "pause");
    expect(getVideoPlayerState(video.id)).toBe("paused");
  });

  test("canplay leaves an intent-free player idle", () => {
    const { video, el } = mountVideo(); // no autoplay: nobody asked to play
    el.paused = true;
    fire(el, "canplay");
    expect(getVideoPlayerState(video.id)).toBe("idle");
  });

  test("canplay resolves a buffering-but-paused player to paused", () => {
    const { video, el } = mountVideo({ autoplay: true });
    expect(getVideoPlayerState(video.id)).toBe("loading");
    el.paused = false;
    fire(el, "play");
    fire(el, "waiting");
    expect(getVideoPlayerState(video.id)).toBe("loading");
    el.paused = true;
    fire(el, "canplay");
    expect(getVideoPlayerState(video.id)).toBe("paused");
  });

  test("rebuffer re-enters loading WITHOUT emitting onPause, and resumes on playing", () => {
    const { video, el } = mountVideo({ onPause: "@actions.paused", onPlay: "@actions.played" });
    el.paused = false;
    fire(el, "play");
    expect(getVideoPlayerState(video.id)).toBe("playing");
    expect(dispatched.filter((d) => d.name === "played").length).toBe(1);

    fire(el, "waiting"); // stall mid-stream
    expect(getVideoPlayerState(video.id)).toBe("loading");
    expect(dispatched.filter((d) => d.name === "paused").length).toBe(0);

    fire(el, "playing"); // buffer refilled
    expect(getVideoPlayerState(video.id)).toBe("playing");
    // Resuming from a rebuffer is not a new play — onPlay stays at one.
    expect(dispatched.filter((d) => d.name === "played").length).toBe(1);
  });

  test("playback intent on a cold player enters loading (spinner slot shows at once)", () => {
    const ctx = new MockCanvasContext();
    const canvas = new MockCanvas();
    const engine = new MockEngine();
    const events = new CanvasEventManager(canvas as any, engine as any);

    const video = makeNode("video", { src: SRC, controls: true, width: 320, height: 180 });
    const root = makeNode("column", { width: 800, height: 600 }, [video]);
    layoutTree(root, ctx);
    paintNode(ctx as any, root);
    events.setRootNode(root);
    expect(getVideoPlayerState(video.id)).toBe("idle");

    clickAt(canvas, video.layout!.x + 10, video.layout!.y + 10);
    expect(getVideoPlayerState(video.id)).toBe("loading");

    events.destroy();
  });

  test("stalled only demotes an actually-playing element", () => {
    const { video, el } = mountVideo();
    fire(el, "stalled");
    expect(getVideoPlayerState(video.id)).toBe("idle");
    el.paused = false;
    fire(el, "play");
    fire(el, "stalled");
    expect(getVideoPlayerState(video.id)).toBe("loading");
  });

  test("no spurious onPause before onEnded (either event order)", () => {
    const { video, el } = mountVideo({
      onPause: "@actions.paused",
      onEnded: "@actions.done",
    });
    el.paused = false;
    fire(el, "play");
    dispatched = [];

    // Browsers fire `ended`, then `pause` with el.ended already true.
    el.ended = true;
    el.paused = true;
    fire(el, "ended");
    fire(el, "pause");

    expect(dispatched.filter((d) => d.name === "done").length).toBe(1);
    expect(dispatched.filter((d) => d.name === "paused").length).toBe(0);
    expect(getVideoPlayerState(video.id)).toBe("ended");
  });

  test("a queue advance emits ended → trackchange with no phantom pause", () => {
    const playlist = ["https://cdn.example/a.mp4", "https://cdn.example/b.mp4"];
    const { el } = mountVideo({
      src: undefined,
      playlist,
      onPause: "@actions.paused",
      onEnded: "@actions.done",
      onTrackChange: "@actions.track",
    });
    el.paused = false;
    fire(el, "play");
    dispatched = [];

    fire(el, "ended");
    fire(el, "pause"); // the load() of the next track fires this

    expect(dispatched.map((d) => d.name)).toEqual(["done", "track"]);
  });

  test("error is sticky and wins over later transitions", () => {
    const { video, el } = mountVideo({ src: "stream://bad.mp4" });
    el.error = { code: 4, message: "decode" };
    fire(el, "error");
    expect(getVideoPlayerState(video.id)).toBe("error");
    fire(el, "waiting"); // a stall after failure must not un-error the player
    expect(getVideoPlayerState(video.id)).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// Playback bind (.bind(@state.playback))
// ---------------------------------------------------------------------------

describe("Video v2: playback bind", () => {
  const bound = (playback: Record<string, any> = {}) => ({
    bind: "playback",
    playback: { playing: false, position: 0, duration: 0, state: "idle", ...playback },
  });

  test("transitions report state + playing immediately", () => {
    const { el } = mountVideo(bound());
    dispatched = [];
    el.paused = false;
    fire(el, "play");

    expect(bindWritesTo("state")).toContain("playing");
    expect(bindWritesTo("playing")).toContain(true);
    // Paths are namespaced under the bind path.
    expect(bindWrites().every((w) => w.path.startsWith("playback."))).toBe(true);

    dispatched = [];
    el.paused = true;
    fire(el, "pause");
    expect(bindWritesTo("state")).toContain("paused");
    expect(bindWritesTo("playing")).toContain(false);
  });

  test("duration reports once known and is not re-sent", () => {
    const { el } = mountVideo(bound());
    dispatched = [];
    el.duration = 120;
    el.videoWidth = 640;
    el.videoHeight = 360;
    fire(el, "loadedmetadata");
    expect(bindWritesTo("duration")).toEqual([120]);

    dispatched = [];
    fire(el, "durationchange");
    expect(bindWritesTo("duration")).toEqual([]);
  });

  test("position reports are throttled to PLAYBACK_REPORT_INTERVAL_MS", () => {
    setClock(10_000);
    const { el } = mountVideo(bound());
    el.duration = 300;
    el.paused = false;
    fire(el, "play"); // transition → immediate report, arms the window
    dispatched = [];

    setClock(10_000 + PLAYBACK_REPORT_INTERVAL_MS);
    el.currentTime = 1;
    fire(el, "timeupdate");
    expect(bindWritesTo("position")).toEqual([1]);

    dispatched = [];
    setClock(10_000 + 2 * PLAYBACK_REPORT_INTERVAL_MS - 1);
    el.currentTime = 2;
    fire(el, "timeupdate");
    expect(bindWritesTo("position")).toEqual([]); // inside the window

    setClock(10_000 + 2 * PLAYBACK_REPORT_INTERVAL_MS);
    el.currentTime = 3;
    fire(el, "timeupdate");
    expect(bindWritesTo("position")).toEqual([3]);
  });

  test("transitions report position immediately, throttle notwithstanding", () => {
    setClock(50_000);
    const { el } = mountVideo(bound());
    el.duration = 300;
    el.paused = false;
    fire(el, "play");
    el.currentTime = 4;
    fire(el, "timeupdate");
    dispatched = [];

    el.currentTime = 4.1;
    el.paused = true;
    fire(el, "pause"); // transition inside the throttle window
    expect(bindWritesTo("position")).toEqual([4.1]);
  });

  test("inbound position seeks only beyond PLAYBACK_SEEK_EPSILON_S", () => {
    const { video, root, ctx, el } = mountVideo(bound());
    el.duration = 300;
    el.currentTime = 10;

    // Inside the epsilon: the renderer's own progress echoing back.
    video.props.playback = { ...video.props.playback, position: 10 + PLAYBACK_SEEK_EPSILON_S };
    paintNode(ctx as any, root);
    expect(el.currentTime).toBe(10);

    // Beyond it: a real seek.
    video.props.playback = { ...video.props.playback, position: 42 };
    paintNode(ctx as any, root);
    expect(el.currentTime).toBe(42);
  });

  test("inbound position is clamped to [0, duration]", () => {
    const { video, root, ctx, el } = mountVideo(bound());
    el.duration = 60;
    el.currentTime = 0;

    video.props.playback = { ...video.props.playback, position: 900 };
    paintNode(ctx as any, root);
    expect(el.currentTime).toBe(60);

    video.props.playback = { ...video.props.playback, position: -30 };
    paintNode(ctx as any, root);
    expect(el.currentTime).toBe(0);
  });

  test("a reported position echoed back never re-seeks (loop converges)", () => {
    setClock(1_000);
    const { video, root, ctx, el } = mountVideo(bound());
    el.duration = 300;
    el.paused = false;
    fire(el, "play");
    setClock(1_000 + PLAYBACK_REPORT_INTERVAL_MS);
    el.currentTime = 17.5;
    fire(el, "timeupdate");
    const reported = bindWritesTo("position").at(-1);
    expect(reported).toBe(17.5);

    // The module's state now carries exactly what we reported.
    dispatched = [];
    video.props.playback = { ...video.props.playback, position: reported };
    el.currentTime = 17.9; // playback moved on a little meanwhile
    paintNode(ctx as any, root);
    expect(el.currentTime).toBe(17.9); // untouched
    expect(bindWrites().filter((w) => w.path.endsWith(".position")).length).toBe(0);
  });

  test("playing:true plays, playing:false pauses", () => {
    const { video, root, ctx, el } = mountVideo(bound());
    const calls: string[] = [];
    el.play = () => { calls.push("play"); };
    el.pause = () => { calls.push("pause"); };

    el.paused = true;
    video.props.playback = { ...video.props.playback, playing: true };
    paintNode(ctx as any, root);
    expect(calls).toEqual(["play"]);

    el.paused = false;
    video.props.playback = { ...video.props.playback, playing: false };
    paintNode(ctx as any, root);
    expect(calls).toEqual(["play", "pause"]);
  });

  test("playing:true while ended restarts from 0", () => {
    const { video, root, ctx, el } = mountVideo(bound());
    const calls: string[] = [];
    el.play = () => { calls.push("play"); };
    el.duration = 90;
    el.paused = false;
    fire(el, "play");
    el.currentTime = 90;
    el.ended = true;
    el.paused = true;
    fire(el, "ended");
    expect(getVideoPlayerState(video.id)).toBe("ended");

    calls.length = 0;
    video.props.playback = { ...video.props.playback, playing: true };
    paintNode(ctx as any, root);
    expect(el.currentTime).toBe(0);
    expect(calls).toEqual(["play"]);
  });

  test("duration/state writes from state are ignored", () => {
    const { video, root, ctx, el } = mountVideo(bound());
    el.duration = 120;
    el.currentTime = 5;
    video.props.playback = {
      ...video.props.playback,
      duration: 9999,
      state: "playing",
    };
    paintNode(ctx as any, root);
    expect(el.currentTime).toBe(5);
    expect(getVideoPlayerState(video.id)).toBe("idle");
  });

  test("playing:true at first render starts a player that already has a source", () => {
    const ctx = new MockCanvasContext();
    const video = makeNode("video", {
      src: SRC,
      width: 320,
      height: 180,
      ...bound({ playing: true }),
    });
    const root = makeNode("column", { width: 800, height: 600 }, [video]);
    layoutTree(root, ctx);
    // The element only exists after the first paint, so the play() spy is
    // installed by patching the prototype-free fake on creation: paint once
    // (which creates it AND consumes the bind), then assert the intent
    // reached the element as a `loading` transition.
    paintNode(ctx as any, root);
    const el = getVideoElement(video.id) as any;
    expect(el.src).toBe(SRC); // source assigned before playback was requested
    expect(getVideoPlayerState(video.id)).toBe("loading");
  });

  test("one-way `playing:` plain prop is the controlled subset of the bind", () => {
    const { video, root, ctx, el } = mountVideo({ playing: false });
    const calls: string[] = [];
    el.play = () => { calls.push("play"); };
    el.pause = () => { calls.push("pause"); };

    el.paused = true;
    video.props.playing = true;
    paintNode(ctx as any, root);
    expect(calls).toEqual(["play"]);

    // Unchanged value re-painted: not re-applied.
    el.paused = false;
    paintNode(ctx as any, root);
    expect(calls).toEqual(["play"]);

    video.props.playing = false;
    paintNode(ctx as any, root);
    expect(calls).toEqual(["play", "pause"]);
  });

  test("one-way `playing: true` while ended restarts from 0", () => {
    const { video, root, ctx, el } = mountVideo({ playing: false });
    const calls: string[] = [];
    el.play = () => { calls.push("play"); };
    el.duration = 90;
    el.paused = false;
    fire(el, "play");
    el.currentTime = 90;
    el.ended = true;
    el.paused = true;
    fire(el, "ended");
    expect(getVideoPlayerState(video.id)).toBe("ended");

    calls.length = 0;
    video.props.playing = true;
    paintNode(ctx as any, root);
    expect(el.currentTime).toBe(0);
    expect(calls).toEqual(["play"]);
  });

  test("an unbound Video reports nothing", () => {
    const { el } = mountVideo();
    el.paused = false;
    fire(el, "play");
    expect(bindWrites().length).toBe(0);
  });

  test("getVideoPlayback exposes the live struct", () => {
    const { video, el } = mountVideo();
    el.duration = 200;
    el.currentTime = 50;
    el.paused = false;
    fire(el, "play");
    expect(getVideoPlayback(video.id)).toEqual({
      playing: true,
      position: 50,
      duration: 200,
      state: "playing",
    });
    expect(getVideoPlayback("nope")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// startPosition
// ---------------------------------------------------------------------------

describe("Video v2: startPosition", () => {
  test("seeks once the source is seekable, exactly once", () => {
    const { el } = mountVideo({ startPosition: 42 });
    expect(el.currentTime).toBeUndefined(); // not seekable yet

    el.readyState = 1;
    el.duration = 300;
    fire(el, "loadedmetadata");
    expect(el.currentTime).toBe(42);

    // A later readiness event must not re-seek a viewer who moved on.
    el.currentTime = 100;
    fire(el, "canplay");
    expect(el.currentTime).toBe(100);
  });

  test("is clamped to the duration and ignored when absent or zero", () => {
    const a = mountVideo({ startPosition: 500 });
    a.el.readyState = 1;
    a.el.duration = 120;
    fire(a.el, "loadedmetadata");
    expect(a.el.currentTime).toBe(120);

    clearVideoCache();
    const b = mountVideo();
    b.el.readyState = 1;
    b.el.duration = 120;
    fire(b.el, "loadedmetadata");
    expect(b.el.currentTime).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Composition slots
// ---------------------------------------------------------------------------

describe("Video v2: slot layout", () => {
  test("slot children are full-bleed overlays of the video rect", () => {
    const ctx = new MockCanvasContext();
    const controls = slotChild("controls", "#c0ffee");
    const poster = slotChild("poster", "#p05732");
    const video = makeNode("video", { src: SRC, width: 320, height: 180 }, [controls, poster]);
    const root = makeNode("column", { width: 800, height: 600, padding: 20 }, [video]);
    layoutTree(root, ctx);

    const vr = video.layout!;
    expect(vr.width).toBeCloseTo(320, 1);
    expect(vr.height).toBeCloseTo(180, 1);
    for (const slot of [controls, poster]) {
      expect(slot.layout).toBeDefined();
      expect(slot.layout!.x).toBeCloseTo(vr.x, 1);
      expect(slot.layout!.y).toBeCloseTo(vr.y, 1);
      expect(slot.layout!.width).toBeCloseTo(vr.width, 1);
      expect(slot.layout!.height).toBeCloseTo(vr.height, 1);
    }
  });

  test("slot children do not participate in the player's own sizing", () => {
    setVideoNaturalSize(SRC, 1600, 900);
    const ctx = new MockCanvasContext();
    // A tall slot subtree must not stretch the video box.
    const controls = slotChild("controls", "#c0ffee", [
      makeNode("column", { height: 900 }),
    ]);
    const video = makeNode("video", { src: SRC, width: 320 }, [controls]);
    const root = makeNode("column", { width: 800, height: 600 }, [video]);
    layoutTree(root, ctx);

    expect(video.layout!.width).toBeCloseTo(320, 1);
    expect(video.layout!.height).toBeCloseTo(180, 1); // 16:9 intrinsic, not 900
  });

  test("untagged children of a Video collapse to a zero box and never paint", () => {
    const ctx = new MockCanvasContext();
    const stray = makeNode("column", { backgroundColor: "#deadbe" });
    const video = makeNode("video", { src: SRC, width: 320, height: 180 }, [stray]);
    const root = makeNode("column", { width: 800, height: 600 }, [video]);
    layoutTree(root, ctx);
    expect(stray.layout!.width).toBe(0);
    expect(stray.layout!.height).toBe(0);

    paintNode(ctx as any, root);
    expect(ctx.paintedWith("#deadbe")).toBe(false);
  });

  test("nested Videos inside a slot get their own slots laid out", () => {
    const ctx = new MockCanvasContext();
    const innerControls = slotChild("controls", "#111111");
    const inner = makeNode("video", { src: SRC, width: 100, height: 60 }, [innerControls]);
    const outerControls = slotChild("controls", "#222222", [inner]);
    const outer = makeNode("video", { src: SRC, width: 320, height: 180 }, [outerControls]);
    const root = makeNode("column", { width: 800, height: 600 }, [outer]);
    layoutTree(root, ctx);

    expect(innerControls.layout!.width).toBeCloseTo(inner.layout!.width, 1);
    expect(innerControls.layout!.height).toBeCloseTo(inner.layout!.height, 1);
    expect(innerControls.layout!.x).toBeCloseTo(inner.layout!.x, 1);
  });
});

describe("Video v2: slot visibility (whole VIDEO_SLOT_VISIBILITY table)", () => {
  const COLORS: Record<VideoSlotName, string> = {
    poster: "#p00000",
    loading: "#100000",
    controls: "#c00000",
    error: "#e00000",
  };
  const STATES: VideoPlayerState[] = [
    "idle",
    "loading",
    "playing",
    "paused",
    "ended",
    "error",
  ];

  for (const state of STATES) {
    test(`state "${state}" shows exactly the slots the table marks`, () => {
      const ctx = new MockCanvasContext();
      const children = VIDEO_SLOTS.map((s) => slotChild(s, COLORS[s]));
      const video = makeNode("video", { src: SRC, width: 320, height: 180 }, children);
      const root = makeNode("column", { width: 800, height: 600 }, [video]);
      layoutTree(root, ctx);
      paintNode(ctx as any, root);

      const el = getVideoElement(video.id) as any;
      driveToState(el, state);
      expect(getVideoPlayerState(video.id)).toBe(state);

      ctx.clearCalls();
      paintNode(ctx as any, root);

      for (const slot of VIDEO_SLOTS) {
        expect({ slot, state, painted: ctx.paintedWith(COLORS[slot]) }).toEqual({
          slot,
          state,
          painted: VIDEO_SLOT_VISIBILITY[slot][state],
        });
      }
    });
  }

  test("hidden ≠ removed: the subtree and its state survive a transition", () => {
    const ctx = new MockCanvasContext();
    const input = makeNode("input", { value: "half-typed" });
    const controls = slotChild("controls", "#c00000", [input]);
    const video = makeNode("video", { src: SRC, width: 320, height: 180 }, [controls]);
    const root = makeNode("column", { width: 800, height: 600 }, [video]);
    layoutTree(root, ctx);
    paintNode(ctx as any, root);
    const el = getVideoElement(video.id) as any;

    driveToState(el, "playing");
    layoutTree(root, ctx);
    ctx.clearCalls();
    paintNode(ctx as any, root);
    expect(ctx.paintedWith("#c00000")).toBe(true);

    // → error hides the controls slot…
    el.error = { code: 4, message: "x" };
    fire(el, "error");
    ctx.clearCalls();
    paintNode(ctx as any, root);
    expect(ctx.paintedWith("#c00000")).toBe(false);

    // …but the node is still in the tree with its state intact.
    expect(video.children).toContain(controls);
    expect(controls.children[0]).toBe(input);
    expect(input.props.value).toBe("half-typed");
    expect(controls.layout).toBeDefined();
  });
});

describe("Video v2: slots replace built-ins", () => {
  test("a controls slot suppresses the built-in play glyph", () => {
    const withSlot = mountVideo({}, [slotChild("controls", "#c00000")]);
    // idle + no glyph: the only `arc` a bare player paints is the glyph.
    expect(withSlot.ctx.wasCalled("arc")).toBe(false);

    clearVideoCache();
    const bare = mountVideo();
    expect(bare.ctx.wasCalled("arc")).toBe(true);
  });

  test("a poster slot suppresses the poster prop image", () => {
    const { ctx } = mountVideo(
      { poster: "https://cdn.example/poster.jpg" },
      [slotChild("poster", "#p00000")],
    );
    // The poster prop would go through the image cache → drawImage.
    expect(ctx.wasCalled("drawImage")).toBe(false);
    // Dark placeholder still backs the (transparent) slot content.
    expect(ctx.paintedWith("#1c1c1e")).toBe(true);
  });

  test("an error slot replaces the renderer-drawn error surface", () => {
    const ctx = new MockCanvasContext();
    const errorSlot = slotChild("error", "#e00000");
    const video = makeNode("video", { src: SRC, width: 320, height: 180 }, [errorSlot]);
    const root = makeNode("column", { width: 800, height: 600 }, [video]);
    layoutTree(root, ctx);
    paintNode(ctx as any, root);
    const el = getVideoElement(video.id) as any;
    el.error = { code: 4, message: "decode" };
    fire(el, "error");

    ctx.clearCalls();
    paintNode(ctx as any, root);
    expect(ctx.paintedWith("#1c1c1e")).toBe(false); // no renderer-drawn surface
    expect(ctx.paintedWith("#e00000")).toBe(true); // the slot paints instead
  });

  test("a bare Video keeps today's error surface", () => {
    const ctx = new MockCanvasContext();
    const video = makeNode("video", { src: SRC, width: 320, height: 180 });
    const root = makeNode("column", { width: 800, height: 600 }, [video]);
    layoutTree(root, ctx);
    paintNode(ctx as any, root);
    const el = getVideoElement(video.id) as any;
    el.error = { code: 4, message: "decode" };
    fire(el, "error");
    ctx.clearCalls();
    paintNode(ctx as any, root);
    expect(ctx.paintedWith("#1c1c1e")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Hit testing through the event manager
// ---------------------------------------------------------------------------

class MockCanvas {
  width = 800;
  height = 600;
  style: any = { width: "800px", height: "600px", cursor: "default" };
  private eventListeners = new Map<string, Function[]>();

  getBoundingClientRect() {
    return { width: 800, height: 600, left: 0, top: 0, right: 800, bottom: 600, x: 0, y: 0 };
  }
  addEventListener(event: string, handler: Function) {
    if (!this.eventListeners.has(event)) this.eventListeners.set(event, []);
    this.eventListeners.get(event)!.push(handler);
  }
  removeEventListener(event: string, handler: Function) {
    const arr = this.eventListeners.get(event);
    if (arr) {
      const i = arr.indexOf(handler);
      if (i >= 0) arr.splice(i, 1);
    }
  }
  dispatchEvent(event: any) {
    (this.eventListeners.get(event.type) || []).forEach((h) => h(event));
    return true;
  }
}

class MockEngine {
  actions: Array<{ name: string; payload: any }> = [];
  dispatchAction(name: string, payload?: any) {
    this.actions.push(semanticAction(name, payload));
  }
}

/** Full press-release cycle at a canvas point. */
function clickAt(canvas: MockCanvas, x: number, y: number): void {
  canvas.dispatchEvent({ type: "mousedown", clientX: x, clientY: y, button: 0 });
  canvas.dispatchEvent({ type: "mouseup", clientX: x, clientY: y, button: 0 });
  canvas.dispatchEvent({ type: "click", clientX: x, clientY: y, button: 0 });
}

describe("Video v2: slot hit testing", () => {
  test("a visible slot's button is hittable; the same button is not while hidden", () => {
    const ctx = new MockCanvasContext();
    const canvas = new MockCanvas();
    const engine = new MockEngine();
    const events = new CanvasEventManager(canvas as any, engine as any);

    const button = makeNode("button", { onClick: "@actions.togglePlay", width: 80, height: 30 });
    const controls = slotChild("controls", "#c00000", [button]);
    const video = makeNode("video", { src: SRC, width: 320, height: 180 }, [controls]);
    const root = makeNode("column", { width: 800, height: 600 }, [video]);
    layoutTree(root, ctx);
    paintNode(ctx as any, root);
    events.setRootNode(root);

    const el = getVideoElement(video.id) as any;
    driveToState(el, "playing"); // controls visible
    layoutTree(root, ctx);

    const bx = button.layout!.x + 5;
    const by = button.layout!.y + 5;
    clickAt(canvas, bx, by);
    expect(engine.actions.filter((a) => a.name === "togglePlay").length).toBe(1);

    // → loading keeps the controls slot visible and hittable (a buffering
    // stream must not strand the viewer with only a spinner).
    fire(el, "waiting");
    expect(getVideoPlayerState(video.id)).toBe("loading");
    engine.actions = [];
    clickAt(canvas, bx, by);
    expect(engine.actions.filter((a) => a.name === "togglePlay").length).toBe(1);

    // → error is the state that hides controls; the button stops being hittable.
    fire(el, "error");
    expect(getVideoPlayerState(video.id)).toBe("error");
    engine.actions = [];
    clickAt(canvas, bx, by);
    expect(engine.actions.filter((a) => a.name === "togglePlay").length).toBe(0);

    events.destroy();
  });

  test("a controls slot disables the built-in tap-to-toggle", () => {
    const ctx = new MockCanvasContext();
    const canvas = new MockCanvas();
    const engine = new MockEngine();
    const events = new CanvasEventManager(canvas as any, engine as any);

    const controls = slotChild("controls", "#c00000");
    const video = makeNode(
      "video",
      { src: SRC, controls: true, width: 320, height: 180 },
      [controls],
    );
    const root = makeNode("column", { width: 800, height: 600 }, [video]);
    layoutTree(root, ctx);
    paintNode(ctx as any, root);
    events.setRootNode(root);
    const el = getVideoElement(video.id) as any;
    driveToState(el, "playing");

    const calls: string[] = [];
    el.play = () => { calls.push("play"); };
    el.pause = () => { calls.push("pause"); };

    clickAt(canvas, video.layout!.x + 10, video.layout!.y + 10);
    expect(calls).toEqual([]); // authored chrome owns the transport

    events.destroy();
  });

  test("without a controls slot, tap-to-toggle still works", () => {
    const ctx = new MockCanvasContext();
    const canvas = new MockCanvas();
    const engine = new MockEngine();
    const events = new CanvasEventManager(canvas as any, engine as any);

    const video = makeNode("video", { src: SRC, controls: true, width: 320, height: 180 });
    const root = makeNode("column", { width: 800, height: 600 }, [video]);
    layoutTree(root, ctx);
    paintNode(ctx as any, root);
    events.setRootNode(root);

    const el = getVideoElement(video.id) as any;
    const calls: string[] = [];
    el.play = () => { calls.push("play"); };
    el.paused = true;

    clickAt(canvas, video.layout!.x + 10, video.layout!.y + 10);
    expect(calls).toEqual(["play"]);

    events.destroy();
  });
});

// ---------------------------------------------------------------------------
// Renderer-local fullscreen intent
// ---------------------------------------------------------------------------

/** Attach a recording Fullscreen API to a mock canvas + the fake document. */
function stubFullscreen(canvas: MockCanvas) {
  const doc: any = (globalThis as any).document;
  const requested: any[] = [];
  let exited = 0;
  (canvas as any).ownerDocument = doc;
  (canvas as any).requestFullscreen = () => {
    requested.push(canvas);
    doc.fullscreenElement = canvas;
    return Promise.resolve();
  };
  doc.fullscreenElement = null;
  doc.exitFullscreen = () => {
    exited++;
    doc.fullscreenElement = null;
    return Promise.resolve();
  };
  return { requested, exits: () => exited };
}

describe("Video v2: videoIntent fullscreen", () => {
  test("a completed tap toggles fullscreen on the canvas host", () => {
    const ctx = new MockCanvasContext();
    const canvas = new MockCanvas();
    const engine = new MockEngine();
    const events = new CanvasEventManager(canvas as any, engine as any);
    const fs = stubFullscreen(canvas);

    const button = makeNode("button", {
      "videoIntent.0": "fullscreen",
      width: 80,
      height: 30,
    });
    const controls = slotChild("controls", "#c00000", [button]);
    const video = makeNode("video", { src: SRC, width: 320, height: 180 }, [controls]);
    const root = makeNode("column", { width: 800, height: 600 }, [video]);
    layoutTree(root, ctx);
    paintNode(ctx as any, root);
    events.setRootNode(root);

    const el = getVideoElement(video.id) as any;
    driveToState(el, "playing"); // controls slot visible
    layoutTree(root, ctx);

    const bx = button.layout!.x + 5;
    const by = button.layout!.y + 5;

    clickAt(canvas, bx, by);
    // The canvas host goes fullscreen — the whole painted app (surface AND
    // the slot chrome overlaid on it) scales with it.
    expect(fs.requested.length).toBe(1);
    expect(fs.requested[0]).toBe(canvas);
    expect(fs.exits()).toBe(0);
    // Presentation only: no action dispatched, player state untouched.
    expect(engine.actions.length).toBe(0);
    expect(getVideoPlayerState(video.id)).toBe("playing");

    clickAt(canvas, bx, by);
    expect(fs.exits()).toBe(1);
    expect(fs.requested.length).toBe(1);

    events.destroy();
  });

  test("a videoIntent node OUTSIDE a Video subtree is inert", () => {
    const ctx = new MockCanvasContext();
    const canvas = new MockCanvas();
    const engine = new MockEngine();
    const events = new CanvasEventManager(canvas as any, engine as any);
    const fs = stubFullscreen(canvas);

    const button = makeNode("button", {
      "videoIntent.0": "fullscreen",
      onClick: "@actions.tapped",
      width: 80,
      height: 30,
    });
    const root = makeNode("column", { width: 800, height: 600 }, [button]);
    layoutTree(root, ctx);
    paintNode(ctx as any, root);
    events.setRootNode(root);

    clickAt(canvas, button.layout!.x + 5, button.layout!.y + 5);
    // The tap DID land (its own action dispatched) — the intent alone is inert.
    expect(engine.actions.filter((a) => a.name === "tapped").length).toBe(1);
    expect(fs.requested.length).toBe(0);
    expect(fs.exits()).toBe(0);

    events.destroy();
  });

  test("a press that releases off the intent node does not fullscreen", () => {
    const ctx = new MockCanvasContext();
    const canvas = new MockCanvas();
    const engine = new MockEngine();
    const events = new CanvasEventManager(canvas as any, engine as any);
    const fs = stubFullscreen(canvas);

    const button = makeNode("button", {
      "videoIntent.0": "fullscreen",
      width: 80,
      height: 30,
    });
    const controls = slotChild("controls", "#c00000", [button]);
    const video = makeNode("video", { src: SRC, width: 320, height: 180 }, [controls]);
    const root = makeNode("column", { width: 800, height: 600 }, [video]);
    layoutTree(root, ctx);
    paintNode(ctx as any, root);
    events.setRootNode(root);
    driveToState(getVideoElement(video.id) as any, "playing");
    layoutTree(root, ctx);

    // Press far away from the button, release on it.
    canvas.dispatchEvent({ type: "mousedown", clientX: 700, clientY: 560, button: 0 });
    canvas.dispatchEvent({
      type: "mouseup", clientX: button.layout!.x + 5, clientY: button.layout!.y + 5, button: 0,
    });
    canvas.dispatchEvent({
      type: "click", clientX: button.layout!.x + 5, clientY: button.layout!.y + 5, button: 0,
    });
    expect(fs.requested.length).toBe(0);

    events.destroy();
  });
});

// ---------------------------------------------------------------------------
// Scrubber
// ---------------------------------------------------------------------------

/** A controls slot with a Scrubber, mounted, laid out and painted once. */
function mountScrubber(
  scrubberProps: Record<string, any> = {},
  videoProps: Record<string, any> = {},
) {
  const ctx = new MockCanvasContext();
  const scrubber = makeNode("scrubber", { width: 300, height: 20, ...scrubberProps });
  const controls = slotChild("controls", "#c00000", [scrubber]);
  const video = makeNode(
    "video",
    { src: SRC, width: 320, height: 180, ...videoProps },
    [controls],
  );
  const root = makeNode("column", { width: 800, height: 600 }, [video]);
  layoutTree(root, ctx);
  paintNode(ctx as any, root);
  const el = getVideoElement(video.id) as any;
  driveToState(el, "playing"); // controls slot visible
  layoutTree(root, ctx);
  return { ctx, root, video, controls, scrubber, el };
}

describe("Video v2: Scrubber", () => {
  test("thumb tracks the enclosing player's currentTime", () => {
    const { ctx, root, scrubber, el } = mountScrubber();
    el.duration = 200;
    el.currentTime = 50;

    expect(getScrubberFraction(scrubber)).toBeCloseTo(0.25, 5);

    ctx.clearCalls();
    paintNode(ctx as any, root);
    const arcs = ctx.callsOf("arc");
    expect(arcs.length).toBe(1); // the thumb
    expect(arcs[0]!.args[0]).toBeCloseTo(
      scrubber.layout!.x + scrubber.layout!.width * 0.25,
      1,
    );
    // Track + progress fills both landed.
    expect(ctx.callsOf("fill").length).toBeGreaterThanOrEqual(3);
  });

  test("a Scrubber outside a Video is inert: track only, no thumb", () => {
    const ctx = new MockCanvasContext();
    const scrubber = makeNode("scrubber", { width: 300, height: 20 });
    const root = makeNode("column", { width: 800, height: 600 }, [scrubber]);
    layoutTree(root, ctx);
    paintNode(ctx as any, root);

    expect(isScrubberLive(scrubber)).toBe(false);
    expect(getScrubberFraction(scrubber)).toBe(0);
    expect(ctx.wasCalled("arc")).toBe(false);
    expect(ctx.wasCalled("fill")).toBe(true); // the inert track still paints
  });

  test("dragging previews locally and dispatches nothing", () => {
    const { scrubber, el } = mountScrubber();
    el.duration = 100;
    el.currentTime = 10;
    dispatched = [];

    expect(beginScrubberDrag(scrubber, 0.5)).toBe(true);
    updateScrubberDrag(scrubber, 0.75);
    expect(getScrubberFraction(scrubber)).toBeCloseTo(0.75, 5);
    expect(el.currentTime).toBe(10); // the element is untouched mid-drag
    expect(dispatched.filter((d) => d.name !== "__noop").length).toBe(0);
  });

  test("release seeks and commits through the sibling bind", () => {
    const { scrubber, el } = mountScrubber({ bind: "playback" });
    el.duration = 100;
    el.currentTime = 10;
    dispatched = [];

    beginScrubberDrag(scrubber, 0.4);
    expect(commitScrubberDrag(scrubber)).toBeCloseTo(40, 5);
    expect(el.currentTime).toBeCloseTo(40, 5);

    const writes = bindWrites().filter((w) => w.path === "playback.position");
    expect(writes.length).toBe(1);
    expect(writes[0]!.value).toBeCloseTo(40, 5);
    // Committed once: the drag is over.
    expect(commitScrubberDrag(scrubber)).toBeNull();
  });

  test("release falls back to the enclosing Video's bind path", () => {
    const { scrubber, el } = mountScrubber({}, { bind: "player", playback: {} });
    el.duration = 100;
    dispatched = [];
    beginScrubberDrag(scrubber, 0.2);
    commitScrubberDrag(scrubber);
    expect(bindWrites().map((w) => w.path)).toContain("player.position");
  });

  test("bound-less release dispatches onSeek {type:'seek', position}", () => {
    const { scrubber, el } = mountScrubber({ onSeek: "@actions.seeked" });
    el.duration = 60;
    dispatched = [];

    beginScrubberDrag(scrubber, 0.5);
    commitScrubberDrag(scrubber);

    const seek = dispatched.find((d) => d.name === "seeked");
    expect(seek).toBeDefined();
    expect(seek!.payload.type).toBe("seek");
    expect(seek!.payload.position).toBeCloseTo(30, 5);
    expect(bindWrites().length).toBe(0);
  });

  test("pointer press → move → release commits exactly once", () => {
    const ctx = new MockCanvasContext();
    const canvas = new MockCanvas();
    const engine = new MockEngine();
    const events = new CanvasEventManager(canvas as any, engine as any);

    const scrubber = makeNode("scrubber", { width: 300, height: 20, bind: "playback" });
    const controls = slotChild("controls", "#c00000", [scrubber]);
    const video = makeNode("video", { src: SRC, width: 320, height: 180 }, [controls]);
    const root = makeNode("column", { width: 800, height: 600 }, [video]);
    layoutTree(root, ctx);
    paintNode(ctx as any, root);
    events.setRootNode(root);

    const el = getVideoElement(video.id) as any;
    driveToState(el, "playing");
    layoutTree(root, ctx);
    el.duration = 400;
    el.currentTime = 0;
    dispatched = [];

    const sx = scrubber.layout!.x;
    const sy = scrubber.layout!.y + scrubber.layout!.height / 2;
    canvas.dispatchEvent({ type: "mousedown", clientX: sx + 30, clientY: sy, button: 0 });
    expect(bindWrites().length).toBe(0); // nothing on press
    canvas.dispatchEvent({ type: "mousemove", clientX: sx + 150, clientY: sy });
    expect(getScrubberFraction(scrubber)).toBeCloseTo(0.5, 5);
    expect(bindWrites().length).toBe(0); // nothing during the drag

    canvas.dispatchEvent({ type: "mouseup", clientX: sx + 150, clientY: sy, button: 0 });
    const writes = bindWrites().filter((w) => w.path === "playback.position");
    expect(writes.length).toBe(1);
    expect(writes[0]!.value).toBeCloseTo(200, 1);
    expect(el.currentTime).toBeCloseTo(200, 1);

    events.destroy();
  });

  test("the Scrubber's own bind outranks the enclosing Video's bind and onSeek (R2)", () => {
    // All three commit targets present at once: own bind wins, the others
    // stay silent — and the local seek still applies.
    const { scrubber, el } = mountScrubber(
      { bind: "own", onSeek: "@actions.seeked" },
      { bind: "player", playback: {} },
    );
    el.duration = 100;
    el.currentTime = 10;
    dispatched = [];

    beginScrubberDrag(scrubber, 0.6);
    expect(commitScrubberDrag(scrubber)).toBeCloseTo(60, 5);
    expect(el.currentTime).toBeCloseTo(60, 5); // local seek in every case

    // The COMMIT lands on the Scrubber's own bind, exactly once. (The
    // enclosing Video may still REPORT the seek to its own bind — that is
    // the normal "position reports immediately on seek completion" flow,
    // not a second commit.)
    const ownWrites = bindWrites().filter((w) => w.path === "own.position");
    expect(ownWrites.length).toBe(1);
    expect(ownWrites[0]!.value).toBeCloseTo(60, 5);
    // The losing fallbacks stay silent: no onSeek dispatch.
    expect(dispatched.filter((d) => d.name === "seeked").length).toBe(0);
  });

  test("Video-bind commit still beats onSeek when the Scrubber has no own bind (R2)", () => {
    const { scrubber, el } = mountScrubber(
      { onSeek: "@actions.seeked" },
      { bind: "player", playback: {} },
    );
    el.duration = 100;
    dispatched = [];

    beginScrubberDrag(scrubber, 0.3);
    commitScrubberDrag(scrubber);

    expect(bindWrites().map((w) => w.path)).toContain("player.position");
    expect(dispatched.filter((d) => d.name === "seeked").length).toBe(0);
  });

  test("a scrub commit does not also toggle playback", () => {
    const ctx = new MockCanvasContext();
    const canvas = new MockCanvas();
    const engine = new MockEngine();
    const events = new CanvasEventManager(canvas as any, engine as any);

    const scrubber = makeNode("scrubber", { width: 300, height: 20, bind: "playback" });
    const controls = slotChild("controls", "#c00000", [scrubber]);
    const video = makeNode(
      "video",
      { src: SRC, controls: true, width: 320, height: 180 },
      [controls],
    );
    const root = makeNode("column", { width: 800, height: 600 }, [video]);
    layoutTree(root, ctx);
    paintNode(ctx as any, root);
    events.setRootNode(root);
    const el = getVideoElement(video.id) as any;
    driveToState(el, "playing");
    layoutTree(root, ctx);
    el.duration = 100;

    const calls: string[] = [];
    el.play = () => { calls.push("play"); };
    el.pause = () => { calls.push("pause"); };

    const sx = scrubber.layout!.x + 10;
    const sy = scrubber.layout!.y + scrubber.layout!.height / 2;
    clickAt(canvas, sx, sy);
    expect(calls).toEqual([]);

    events.destroy();
  });
});

// ---------------------------------------------------------------------------
// Scrubber: off-canvas release (drag-scoped window listeners)
// ---------------------------------------------------------------------------

/**
 * Replace the no-op window listener stubs `ensureFakeDomGlobals()` installs
 * with functional ones, so the drag-scoped window release listeners the
 * CanvasEventManager arms during a live scrub can be observed and fired.
 * `beforeEach` re-runs `ensureFakeDomGlobals()`, so nothing leaks across
 * tests.
 */
function installFakeWindowListeners() {
  const w = (globalThis as any).window;
  const listeners = new Map<string, Function[]>();
  w.addEventListener = (type: string, handler: Function) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type)!.push(handler);
  };
  w.removeEventListener = (type: string, handler: Function) => {
    const arr = listeners.get(type);
    if (arr) {
      const i = arr.indexOf(handler);
      if (i >= 0) arr.splice(i, 1);
    }
  };
  w.dispatchEvent = (event: any) => {
    // Copy: a handler may remove listeners mid-dispatch (disarm-on-commit).
    [...(listeners.get(event.type) ?? [])].forEach((h) => h(event));
    return true;
  };
  return {
    count: (type: string) => listeners.get(type)?.length ?? 0,
    total: () =>
      [...listeners.values()].reduce((n, arr) => n + arr.length, 0),
    fire: (type: string, event: any = {}) => w.dispatchEvent({ type, ...event }),
  };
}

/** Scrubber-in-controls player wired through a live CanvasEventManager. */
function mountScrubberWithEvents() {
  const ctx = new MockCanvasContext();
  const canvas = new MockCanvas();
  const engine = new MockEngine();
  const events = new CanvasEventManager(canvas as any, engine as any);
  const scrubber = makeNode("scrubber", { width: 300, height: 20, bind: "playback" });
  const controls = slotChild("controls", "#c00000", [scrubber]);
  const video = makeNode("video", { src: SRC, width: 320, height: 180 }, [controls]);
  const root = makeNode("column", { width: 800, height: 600 }, [video]);
  layoutTree(root, ctx);
  paintNode(ctx as any, root);
  events.setRootNode(root);
  const el = getVideoElement(video.id) as any;
  driveToState(el, "playing"); // controls slot visible
  layoutTree(root, ctx);
  el.duration = 400;
  el.currentTime = 0;
  dispatched = [];
  const sx = scrubber.layout!.x;
  const sy = scrubber.layout!.y + scrubber.layout!.height / 2;
  return { ctx, canvas, engine, events, scrubber, video, el, sx, sy };
}

function positionWrites(): number[] {
  return bindWrites()
    .filter((w) => w.path === "playback.position")
    .map((w) => w.value);
}

describe("Video v2: Scrubber off-canvas release", () => {
  test("window release listeners exist only while a drag is live", () => {
    const win = installFakeWindowListeners();
    const { canvas, events, sx, sy } = mountScrubberWithEvents();

    expect(win.total()).toBe(0); // nothing armed at rest
    canvas.dispatchEvent({ type: "mousedown", clientX: sx + 30, clientY: sy, button: 0 });
    expect(win.count("pointerup")).toBe(1);
    expect(win.count("mouseup")).toBe(1);

    canvas.dispatchEvent({ type: "mouseup", clientX: sx + 150, clientY: sy, button: 0 });
    expect(positionWrites()).toEqual([200]); // canvas release still commits
    expect(win.total()).toBe(0); // and disarms the window listeners

    events.destroy();
  });

  test("a release outside the canvas commits once via the window listener", () => {
    const win = installFakeWindowListeners();
    const { canvas, events, el, sx, sy } = mountScrubberWithEvents();

    canvas.dispatchEvent({ type: "mousedown", clientX: sx + 30, clientY: sy, button: 0 });
    canvas.dispatchEvent({ type: "mousemove", clientX: sx + 100, clientY: sy, buttons: 1 });
    expect(positionWrites()).toEqual([]); // nothing mid-drag

    // Pointer leaves the canvas, button released elsewhere on the page:
    // pointerup then mouseup both reach the window. Exactly one commit, at
    // the release x (DOM range parity — commit, not cancel).
    win.fire("pointerup", { clientX: sx + 150, clientY: -40, button: 0 });
    win.fire("mouseup", { clientX: sx + 170, clientY: -40, button: 0 });
    expect(positionWrites()).toEqual([200]); // fraction 0.5 of duration 400
    expect(el.currentTime).toBeCloseTo(200, 5);
    expect(win.total()).toBe(0);

    // Regression (the finding's probe): a later unrelated click on the
    // canvas corner must NOT commit a stale seek.
    clickAt(canvas, 799, 599);
    expect(positionWrites()).toEqual([200]);
    expect(el.currentTime).toBeCloseTo(200, 5);

    events.destroy();
  });

  test("an off-track release clamps the committed fraction to the track", () => {
    const win = installFakeWindowListeners();
    const { canvas, events, sx, sy } = mountScrubberWithEvents();

    canvas.dispatchEvent({ type: "mousedown", clientX: sx + 30, clientY: sy, button: 0 });
    win.fire("mouseup", { clientX: sx - 5000, clientY: sy, button: 0 });
    expect(positionWrites()).toEqual([0]); // clamped to the track start

    events.destroy();
  });

  test("a buttonless mousemove finalizes a drag whose release was missed", () => {
    const win = installFakeWindowListeners();
    const { canvas, events, el, scrubber, sx, sy } = mountScrubberWithEvents();

    canvas.dispatchEvent({ type: "mousedown", clientX: sx + 30, clientY: sy, button: 0 });
    // Release happened where nobody saw it (outside the window). The pointer
    // re-enters the canvas with no buttons down: finalize per commit
    // semantics, exactly once, at that move's x.
    canvas.dispatchEvent({ type: "mousemove", clientX: sx + 150, clientY: sy, buttons: 0 });
    expect(positionWrites()).toEqual([200]);
    expect(el.currentTime).toBeCloseTo(200, 5);
    expect(win.total()).toBe(0); // guard path disarms too

    // The drag is over: further buttonless moves are plain hover, and an
    // unrelated click commits nothing.
    canvas.dispatchEvent({ type: "mousemove", clientX: sx + 250, clientY: sy, buttons: 0 });
    expect(getScrubberFraction(scrubber)).toBeCloseTo(0.5, 5); // el time, not hover x
    clickAt(canvas, 799, 599);
    expect(positionWrites()).toEqual([200]);

    events.destroy();
  });

  test("moves with buttons held — or without a buttons field — keep the drag", () => {
    const { canvas, events, scrubber, sx, sy } = mountScrubberWithEvents();

    canvas.dispatchEvent({ type: "mousedown", clientX: sx + 30, clientY: sy, button: 0 });
    canvas.dispatchEvent({ type: "mousemove", clientX: sx + 150, clientY: sy, buttons: 1 });
    expect(getScrubberFraction(scrubber)).toBeCloseTo(0.5, 5);
    expect(positionWrites()).toEqual([]);

    // Synthetic events without `buttons` (undefined) must not end the drag.
    canvas.dispatchEvent({ type: "mousemove", clientX: sx + 240, clientY: sy });
    expect(getScrubberFraction(scrubber)).toBeCloseTo(0.8, 5);
    expect(positionWrites()).toEqual([]);

    canvas.dispatchEvent({ type: "mouseup", clientX: sx + 240, clientY: sy, button: 0 });
    expect(positionWrites()).toEqual([320]);

    events.destroy();
  });

  test("destroy() mid-drag drops the drag and the window listeners", () => {
    const win = installFakeWindowListeners();
    const { canvas, events, sx, sy } = mountScrubberWithEvents();

    canvas.dispatchEvent({ type: "mousedown", clientX: sx + 30, clientY: sy, button: 0 });
    expect(win.total()).toBe(2);
    events.destroy();
    expect(win.total()).toBe(0);
    // Teardown cancels rather than commits (node is going away).
    expect(positionWrites()).toEqual([]);
    // A stray window release after destroy is inert.
    win.fire("mouseup", { clientX: sx + 150, clientY: sy, button: 0 });
    expect(positionWrites()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Amended rulings: controls-in-idle reachability (R1) and playing-as-intent (R3)
// ---------------------------------------------------------------------------

describe("Video v2: controls slot in idle (R1)", () => {
  test("a controls-slot button tap in idle reaches its action (spec example declaration order)", () => {
    const ctx = new MockCanvasContext();
    const canvas = new MockCanvas();
    const engine = new MockEngine();
    const events = new CanvasEventManager(canvas as any, engine as any);

    // Spec-example order: controls declared FIRST, poster declared LAST.
    // Both are visible in `idle`; the normative paint order (poster under
    // controls) must keep the play button hittable — a controls slot
    // suppresses tap-to-toggle, so this button is the ONLY way to start.
    const button = makeNode("button", { onClick: "@actions.startPlay", width: 80, height: 30 });
    const controls = slotChild("controls", "#c00000", [button]);
    const poster = slotChild("poster", "#p00000");
    const video = makeNode(
      "video",
      { src: SRC, controls: true, width: 320, height: 180 },
      [controls, poster],
    );
    const root = makeNode("column", { width: 800, height: 600 }, [video]);
    layoutTree(root, ctx);
    paintNode(ctx as any, root);
    events.setRootNode(root);
    expect(getVideoPlayerState(video.id)).toBe("idle");

    const el = getVideoElement(video.id) as any;
    const calls: string[] = [];
    el.play = () => { calls.push("play"); };
    el.pause = () => { calls.push("pause"); };

    clickAt(canvas, button.layout!.x + 5, button.layout!.y + 5);
    expect(engine.actions.filter((a) => a.name === "startPlay").length).toBe(1);
    // The tap belongs to the authored chrome, never the built-in toggle.
    expect(calls).toEqual([]);

    events.destroy();
  });

  test("slots paint bottom-to-top poster → controls in idle, regardless of declaration order", () => {
    const ctx = new MockCanvasContext();
    // Declaration order controls-then-poster; paint order must invert it.
    const controls = slotChild("controls", "#c00000");
    const poster = slotChild("poster", "#p00000");
    const video = makeNode("video", { src: SRC, width: 320, height: 180 }, [controls, poster]);
    const root = makeNode("column", { width: 800, height: 600 }, [video]);
    layoutTree(root, ctx);
    ctx.clearCalls();
    paintNode(ctx as any, root);
    expect(getVideoPlayerState(video.id)).toBe("idle");

    const indexOfFill = (color: string) =>
      ctx.calls.findIndex(
        (c) => (c.method === "fillRect" || c.method === "fill") && c.fillStyle === color,
      );
    const posterAt = indexOfFill("#p00000");
    const controlsAt = indexOfFill("#c00000");
    expect(posterAt).toBeGreaterThanOrEqual(0);
    expect(controlsAt).toBeGreaterThanOrEqual(0);
    expect(posterAt).toBeLessThan(controlsAt); // poster under controls
  });
});

describe("Video v2: playing reports intent (R3)", () => {
  const bound = () => ({
    bind: "playback",
    playback: { playing: false, position: 0, duration: 0, state: "idle" },
  });

  test("playing stays true through a rebuffer while state reports loading", () => {
    const { video, el } = mountVideo(bound());
    el.paused = false;
    fire(el, "play");
    expect(bindWritesTo("playing")).toContain(true);
    dispatched = [];

    fire(el, "waiting"); // mid-stream stall
    expect(getVideoPlayerState(video.id)).toBe("loading");
    // The state transition reports, but `playing` is intent: no flicker.
    expect(bindWritesTo("state")).toContain("loading");
    expect(bindWritesTo("playing")).toEqual([]);
    expect(getVideoPlayback(video.id)).toMatchObject({ playing: true, state: "loading" });

    dispatched = [];
    fire(el, "playing"); // buffer refilled
    expect(bindWritesTo("playing")).toEqual([]); // intent never changed
    expect(getVideoPlayback(video.id)).toMatchObject({ playing: true, state: "playing" });
  });

  test("intent drops on pause and on error, not on stall", () => {
    const { video, el } = mountVideo(bound());
    el.paused = false;
    fire(el, "play");
    fire(el, "stalled");
    expect(getVideoPlayback(video.id)).toMatchObject({ playing: true, state: "loading" });

    dispatched = [];
    el.error = { code: 2, message: "network" };
    fire(el, "error");
    expect(getVideoPlayback(video.id)).toMatchObject({ playing: false, state: "error" });
    expect(bindWritesTo("playing")).toContain(false);
    expect(getVideoPlayerState(video.id)).toBe("error");
  });
});
