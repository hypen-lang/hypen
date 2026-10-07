import { semanticAction } from "./helpers";
/**
 * Canvas Video Component Tests
 *
 * The canvas renderer plays Video through an OFFSCREEN <video> element
 * (keyed by node id) and paints its frames with drawImage — see
 * hypen-docs/content/docs/guide/components.mdx for the contract and
 * packages/web/src/canvas/paint.ts for the implementation.
 *
 * JSDOM/bun cannot decode real media, so these tests drive the test seams:
 * `setVideoNaturalSize` seeds intrinsic aspect for layout, `getVideoElement`
 * exposes the offscreen element (a FakeElement here) whose events are fired
 * manually, and `setVideoActionDispatcher` captures dispatched actions.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  paintNode,
  setVideoNaturalSize,
  getVideoNaturalAspect,
  getVideoElement,
  getVideoTrackIndex,
  toggleVideoPlayback,
  releaseVideo,
  clearVideoCache,
  setVideoActionDispatcher,
} from "../packages/web/src/canvas/paint.js";
import { computeLayout } from "../packages/web/src/canvas/layout.js";
import { CanvasRenderer } from "../packages/web/src/canvas/index.js";
import type { VirtualNode } from "../packages/web/src/canvas/types.js";
import type { Patch } from "../packages/core/src/types";
import { ensureFakeDomGlobals } from "./fake-dom";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Mock 2D context that records draw calls (same shape as canvas-paint tests). */
class MockCanvasContext {
  calls: Array<{ method: string; args: any[] }> = [];

  fillStyle: any = "#000000";
  strokeStyle: string = "#000000";
  lineWidth: number = 1;
  font: string = "10px sans-serif";
  textAlign: string = "left";
  textBaseline: string = "top";
  globalAlpha: number = 1;

  // paintVideo pokes `ctx.canvas` for redraw events — a tiny stub suffices.
  canvas: any = { dispatchEvent: () => true };

  private record(method: string, ...args: any[]) {
    this.calls.push({ method, args });
  }

  save() { this.record("save"); }
  restore() { this.record("restore"); }
  scale() {}
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
    id: `n${++nodeCounter}`,
    type,
    props,
    children,
    parent: null,
    visible: true,
    opacity: 1,
    clickable: false,
    hoverable: false,
    focusable: false,
    focused: false,
    hovered: false,
  };
  for (const child of children) child.parent = node;
  return node;
}

function withLayout(node: VirtualNode, x = 0, y = 0, width = 200, height = 100): VirtualNode {
  node.layout = {
    x,
    y,
    width,
    height,
    margin: { top: 0, right: 0, bottom: 0, left: 0 },
    padding: { top: 0, right: 0, bottom: 0, left: 0 },
    border: { width: 0, color: "transparent", radius: 0 },
    contentX: 0,
    contentY: 0,
    contentWidth: width,
    contentHeight: height,
  };
  return node;
}

/** Fire an event on the offscreen fake <video> element. */
function fireVideoEvent(el: any, type: string): void {
  el.dispatchEvent(type, {});
}

let dispatched: Array<{ name: string; payload: any }> = [];

beforeEach(() => {
  ensureFakeDomGlobals();
  clearVideoCache();
  dispatched = [];
  setVideoActionDispatcher((name, payload) => dispatched.push(semanticAction(name, payload)));
});

afterEach(() => {
  clearVideoCache();
  setVideoActionDispatcher(null);
});

// ---------------------------------------------------------------------------
// Layout: intrinsic aspect
// ---------------------------------------------------------------------------

describe("Video layout", () => {
  test("seeded natural size drives the derived dimension", () => {
    const src = "https://cdn.example/natural-2to1.mp4";
    setVideoNaturalSize(src, 1000, 500); // aspect 2
    expect(getVideoNaturalAspect(src)).toBe(2);

    const video = makeNode("video", { src, width: 200 });
    const root = makeNode("column", {}, [video]);
    const ctx = new MockCanvasContext();
    computeLayout(ctx as any, root, 800, 600, 0, 0);

    expect(video.layout).toBeDefined();
    expect(video.layout!.width).toBeCloseTo(200, 1);
    expect(video.layout!.height).toBeCloseTo(100, 1); // 200 / 2
  });

  test("defaults to 16:9 before metadata", () => {
    const video = makeNode("video", { src: "https://cdn.example/unknown.mp4", width: 320 });
    const root = makeNode("column", {}, [video]);
    const ctx = new MockCanvasContext();
    computeLayout(ctx as any, root, 800, 600, 0, 0);

    expect(video.layout!.width).toBeCloseTo(320, 1);
    expect(video.layout!.height).toBeCloseTo(180, 1); // 320 / (16/9)
  });

  test("height-only derives width from natural aspect", () => {
    const src = "https://cdn.example/vertical.mp4";
    setVideoNaturalSize(src, 500, 1000); // aspect 0.5
    const video = makeNode("video", { src, height: 300 });
    const root = makeNode("column", {}, [video]);
    const ctx = new MockCanvasContext();
    computeLayout(ctx as any, root, 800, 600, 0, 0);

    expect(video.layout!.height).toBeCloseTo(300, 1);
    expect(video.layout!.width).toBeCloseTo(150, 1); // 300 * 0.5
  });
});

// ---------------------------------------------------------------------------
// Paint
// ---------------------------------------------------------------------------

describe("Video paint", () => {
  test("no src and no playlist paints an empty placeholder, creates no entry, dispatches nothing", () => {
    const node = withLayout(makeNode("video", {}));
    const ctx = new MockCanvasContext();
    expect(() => paintNode(ctx as any, node)).not.toThrow();
    expect(ctx.wasCalled("fillRect")).toBe(true);
    expect(getVideoElement(node.id)).toBeNull();
    expect(dispatched.length).toBe(0);
  });

  test("placeholder state paints dark box + play glyph and creates the offscreen element", () => {
    const node = withLayout(makeNode("video", { src: "https://cdn.example/movie.mp4" }));
    const ctx = new MockCanvasContext();
    expect(() => paintNode(ctx as any, node)).not.toThrow();

    // Dark placeholder box at the node's layout rect
    const fills = ctx.callsOf("fillRect");
    expect(fills.length).toBeGreaterThan(0);
    expect(fills[0].args).toEqual([0, 0, 200, 100]);
    // Play glyph: scrim circle (arc) + triangle (moveTo/lineTo/fill)
    expect(ctx.wasCalled("arc")).toBe(true);
    expect(ctx.wasCalled("fill")).toBe(true);
    // Balanced save/restore
    expect(ctx.callsOf("save").length).toBe(ctx.callsOf("restore").length);

    const el = getVideoElement(node.id) as any;
    expect(el).not.toBeNull();
    expect(el.src).toBe("https://cdn.example/movie.mp4");
    expect(getVideoTrackIndex(node.id)).toBe(0);
  });

  test("ready state draws the current frame (contain letterboxes on black)", () => {
    const node = withLayout(makeNode("video", { src: "https://cdn.example/ready.mp4" }));
    const ctx = new MockCanvasContext();
    paintNode(ctx as any, node); // creates entry

    const el = getVideoElement(node.id) as any;
    el.readyState = 2; // HAVE_CURRENT_DATA
    el.videoWidth = 640;
    el.videoHeight = 360;
    el.paused = false;

    ctx.clearCalls();
    paintNode(ctx as any, node);

    const draws = ctx.callsOf("drawImage");
    expect(draws.length).toBe(1);
    expect(draws[0].args[0]).toBe(el);
    // contain: 640x360 into 200x100 → scale 100/360? no: min(200/640, 100/360)
    // = min(0.3125, 0.2778) = 0.2778 → 177.8 x 100, centered horizontally.
    const [, dx, dy, dw, dh] = draws[0].args;
    expect(dh).toBeCloseTo(100, 1);
    expect(dw).toBeCloseTo(640 * (100 / 360), 1);
    expect(dx).toBeCloseTo((200 - 640 * (100 / 360)) / 2, 1);
    expect(dy).toBeCloseTo(0, 1);
    // No play glyph while playing (paused === false)
    expect(ctx.wasCalled("arc")).toBe(false);
  });

  test("objectFit cover crops the longer source axis", () => {
    const node = withLayout(
      makeNode("video", { src: "https://cdn.example/cover.mp4", objectFit: "cover" }),
    );
    const ctx = new MockCanvasContext();
    paintNode(ctx as any, node);
    const el = getVideoElement(node.id) as any;
    el.readyState = 2;
    el.videoWidth = 640;
    el.videoHeight = 360;
    el.paused = false;

    ctx.clearCalls();
    paintNode(ctx as any, node);

    const draws = ctx.callsOf("drawImage");
    expect(draws.length).toBe(1);
    // dest aspect 2 > src aspect 1.78 → crop vertically:
    // sHeight = 640 / 2 = 320, sy = (360 - 320) / 2 = 20
    expect(draws[0].args).toEqual([el, 0, 20, 640, 320, 0, 0, 200, 100]);
  });

  test("paused-after-start paints frame plus play glyph", () => {
    const node = withLayout(makeNode("video", { src: "https://cdn.example/paused.mp4" }));
    const ctx = new MockCanvasContext();
    paintNode(ctx as any, node);
    const el = getVideoElement(node.id) as any;
    el.readyState = 2;
    el.videoWidth = 640;
    el.videoHeight = 360;
    el.paused = true;
    toggleVideoPlayback(node.id); // started = true

    ctx.clearCalls();
    paintNode(ctx as any, node);
    expect(ctx.wasCalled("drawImage")).toBe(true);
    expect(ctx.wasCalled("arc")).toBe(true); // glyph overlays paused frame
  });
});

// ---------------------------------------------------------------------------
// Playback events + playlist
// ---------------------------------------------------------------------------

describe("Video playback events", () => {
  const actionProps = {
    onPlay: "@actions.played",
    onPause: "@actions.paused",
    onEnded: "@actions.done",
    onTrackChange: "@actions.trackChanged",
    onError: "@actions.failed",
  };

  test("play/pause events dispatch onPlay/onPause with src + index", () => {
    const node = withLayout(
      makeNode("video", { src: "https://cdn.example/ev.mp4", ...actionProps }),
    );
    const ctx = new MockCanvasContext();
    paintNode(ctx as any, node);
    const el = getVideoElement(node.id) as any;

    fireVideoEvent(el, "play");
    fireVideoEvent(el, "pause");

    const play = dispatched.find((d) => d.name === "played");
    const pause = dispatched.find((d) => d.name === "paused");
    expect(play).toBeDefined();
    expect(play!.payload.type).toBe("play");
    expect(play!.payload.src).toBe("https://cdn.example/ev.mp4");
    expect(play!.payload.index).toBe(0);
    expect(pause).toBeDefined();
    expect(pause!.payload.type).toBe("pause");
  });

  test("playlist advances on ended, dispatching onEnded then onTrackChange", () => {
    const playlist = [
      "https://cdn.example/ep1.mp4",
      "https://cdn.example/ep2.mp4",
      "https://cdn.example/ep3.mp4",
    ];
    const node = withLayout(makeNode("video", { playlist, ...actionProps }));
    const ctx = new MockCanvasContext();
    paintNode(ctx as any, node);
    const el = getVideoElement(node.id) as any;
    expect(el.src).toBe(playlist[0]);

    fireVideoEvent(el, "ended");
    expect(getVideoTrackIndex(node.id)).toBe(1);
    expect(el.src).toBe(playlist[1]);

    const ended1 = dispatched.filter((d) => d.name === "done");
    expect(ended1.length).toBe(1);
    expect(ended1[0].payload).toMatchObject({
      type: "ended",
      src: playlist[0],
      index: 0,
      completed: false,
    });
    const change1 = dispatched.filter((d) => d.name === "trackChanged");
    expect(change1.length).toBe(1);
    expect(change1[0].payload).toMatchObject({
      type: "trackchange",
      src: playlist[1],
      index: 1,
    });

    // Ordering: onEnded before onTrackChange
    expect(dispatched.findIndex((d) => d.name === "done")).toBeLessThan(
      dispatched.findIndex((d) => d.name === "trackChanged"),
    );

    fireVideoEvent(el, "ended"); // → track 2
    expect(getVideoTrackIndex(node.id)).toBe(2);
    expect(el.src).toBe(playlist[2]);

    dispatched = [];
    fireVideoEvent(el, "ended"); // last track, no loop → completed
    expect(getVideoTrackIndex(node.id)).toBe(2); // stays on last track
    const final = dispatched.find((d) => d.name === "done");
    expect(final).toBeDefined();
    expect(final!.payload.completed).toBe(true);
    expect(dispatched.find((d) => d.name === "trackChanged")).toBeUndefined();
  });

  test("playlist with loop wraps to track 0 after the last track", () => {
    const playlist = ["https://cdn.example/a.mp4", "https://cdn.example/b.mp4"];
    const node = withLayout(makeNode("video", { playlist, loop: true, ...actionProps }));
    const ctx = new MockCanvasContext();
    paintNode(ctx as any, node);
    const el = getVideoElement(node.id) as any;

    fireVideoEvent(el, "ended"); // 0 → 1
    expect(getVideoTrackIndex(node.id)).toBe(1);

    dispatched = [];
    fireVideoEvent(el, "ended"); // 1 → wrap to 0
    expect(getVideoTrackIndex(node.id)).toBe(0);
    expect(el.src).toBe(playlist[0]);
    const ended = dispatched.find((d) => d.name === "done");
    expect(ended!.payload.completed).toBe(false); // queue not done: it wraps
    const change = dispatched.find((d) => d.name === "trackChanged");
    expect(change!.payload.index).toBe(0);
  });

  test("startIndex is clamped and honored", () => {
    const playlist = ["https://cdn.example/a.mp4", "https://cdn.example/b.mp4"];
    const node = withLayout(makeNode("video", { playlist, startIndex: 7 }));
    const ctx = new MockCanvasContext();
    paintNode(ctx as any, node);
    expect(getVideoTrackIndex(node.id)).toBe(1); // clamped to last
    expect((getVideoElement(node.id) as any).src).toBe(playlist[1]);
  });

  test("media error dispatches onError with code/message (no probe for non-http src)", () => {
    const node = withLayout(
      makeNode("video", { src: "stream://unfetchable.mp4", ...actionProps }),
    );
    const ctx = new MockCanvasContext();
    paintNode(ctx as any, node);
    const el = getVideoElement(node.id) as any;
    el.error = { code: 4, message: "MEDIA_ELEMENT_ERROR: Format error" };

    fireVideoEvent(el, "error");

    const err = dispatched.find((d) => d.name === "failed");
    expect(err).toBeDefined();
    expect(err!.payload).toMatchObject({
      type: "error",
      src: "stream://unfetchable.mp4",
      index: 0,
      code: 4,
    });
    expect(err!.payload.status).toBeUndefined();

    // Error state paints quietly: dark box, no glyph
    ctx.clearCalls();
    paintNode(ctx as any, node);
    expect(ctx.wasCalled("fillRect")).toBe(true);
    expect(ctx.wasCalled("arc")).toBe(false);
  });

  test("toggleVideoPlayback returns false for unknown nodes, true for live ones", () => {
    expect(toggleVideoPlayback("nope")).toBe(false);
    const node = withLayout(makeNode("video", { src: "https://cdn.example/t.mp4" }));
    paintNode(new MockCanvasContext() as any, node);
    expect(toggleVideoPlayback(node.id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

describe("Video teardown", () => {
  test("releaseVideo drops the entry, clears src, and detaches listeners", () => {
    const node = withLayout(
      makeNode("video", {
        playlist: ["https://cdn.example/a.mp4", "https://cdn.example/b.mp4"],
        onTrackChange: "@actions.trackChanged",
        onEnded: "@actions.done",
      }),
    );
    paintNode(new MockCanvasContext() as any, node);
    const el = getVideoElement(node.id) as any;
    expect(el).not.toBeNull();

    releaseVideo(node.id);
    expect(getVideoElement(node.id)).toBeNull();
    expect(el.src).toBe("");

    // Listeners are gone — a late 'ended' must not dispatch or advance.
    dispatched = [];
    fireVideoEvent(el, "ended");
    expect(dispatched.length).toBe(0);
  });

  test("repainting after config change rebuilds the entry", () => {
    const node = withLayout(makeNode("video", { src: "https://cdn.example/one.mp4" }));
    const ctx = new MockCanvasContext();
    paintNode(ctx as any, node);
    const first = getVideoElement(node.id) as any;
    expect(first.src).toBe("https://cdn.example/one.mp4");

    node.props.src = "https://cdn.example/two.mp4";
    paintNode(ctx as any, node);
    const second = getVideoElement(node.id) as any;
    expect(second).not.toBe(first);
    expect(second.src).toBe("https://cdn.example/two.mp4");
    expect(first.src).toBe(""); // old element released
  });
});

// ---------------------------------------------------------------------------
// Renderer integration: remove patch releases the offscreen element
// ---------------------------------------------------------------------------

class MockRendererContext extends MockCanvasContext {}

class MockCanvas {
  width = 800;
  height = 600;
  style: any = { width: "800px", height: "600px", cursor: "default" };
  private context = new MockRendererContext();
  private eventListeners = new Map<string, Function[]>();

  getContext(type: string) {
    return type === "2d" ? this.context : null;
  }
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
  get parentElement() {
    return { appendChild: () => {} };
  }
}

class MockEngine {
  actions: Array<{ name: string; payload: any }> = [];
  dispatchAction(name: string, payload?: any) {
    this.actions.push(semanticAction(name, payload));
  }
}

describe("Video renderer integration", () => {
  let canvas: MockCanvas;
  let engine: MockEngine;
  let renderer: CanvasRenderer;

  beforeEach(() => {
    canvas = new MockCanvas();
    engine = new MockEngine();
    renderer = new CanvasRenderer(canvas as any, engine as any, {
      devicePixelRatio: 1,
      backgroundColor: "#ffffff",
      enableAccessibility: false,
      enableHitTesting: true,
    });
  });

  afterEach(() => {
    renderer.destroy();
  });

  function mountVideo(id: string): void {
    const patches: Patch[] = [
      { type: "create", id: "root", elementType: "Column", props: {} } as any,
      { type: "insert", parentId: "root", id: "root" } as any,
      {
        type: "create",
        id,
        elementType: "Video",
        props: { src: `https://cdn.example/${id}.mp4`, width: 200, height: 100 },
      } as any,
      { type: "insert", parentId: "root", id } as any,
    ];
    renderer.applyPatches(patches);
  }

  test("remove patch releases the node's offscreen video element", () => {
    mountVideo("v1");
    const el = getVideoElement("v1") as any;
    expect(el).not.toBeNull();

    renderer.applyPatches([{ type: "remove", id: "v1" } as any]);
    expect(getVideoElement("v1")).toBeNull();
    expect(el.src).toBe("");
  });

  test("removing an ancestor releases descendant video elements", () => {
    mountVideo("v2");
    expect(getVideoElement("v2")).not.toBeNull();

    renderer.applyPatches([{ type: "remove", id: "root" } as any]);
    expect(getVideoElement("v2")).toBeNull();
  });

  test("renderer.clear() releases all of its video elements", () => {
    mountVideo("v3");
    expect(getVideoElement("v3")).not.toBeNull();
    renderer.clear();
    expect(getVideoElement("v3")).toBeNull();
  });

  test("video playback events reach the engine through the renderer-bound dispatcher", () => {
    const patches: Patch[] = [
      { type: "create", id: "root", elementType: "Column", props: {} } as any,
      { type: "insert", parentId: "root", id: "root" } as any,
      {
        type: "create",
        id: "v4",
        elementType: "Video",
        props: {
          src: "https://cdn.example/v4.mp4",
          width: 200,
          height: 100,
          onPlay: "@actions.videoStarted",
        },
      } as any,
      { type: "insert", parentId: "root", id: "v4" } as any,
    ];
    renderer.applyPatches(patches);

    const el = getVideoElement("v4") as any;
    expect(el).not.toBeNull();
    fireVideoEvent(el, "play");
    const started = engine.actions.find((a) => a.name === "videoStarted");
    expect(started).toBeDefined();
    expect(started!.payload.src).toBe("https://cdn.example/v4.mp4");
  });
});
