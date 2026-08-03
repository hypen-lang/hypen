/**
 * Canvas animation runtime tests (`packages/web/src/canvas/anim.ts`).
 *
 * The canvas renderer has no CSS engine — animations are a numeric ticker
 * driven by the renderer's redraw scheduler. In Bun there is no
 * `requestAnimationFrame`, so `scheduleRedraw()` renders synchronously and
 * never self-arms; tests drive frames deterministically by overriding the
 * animator's clock (`animator.now`) and invoking `render()` directly. The
 * one rAF-behavior test installs a fake global rAF queue and restores it.
 *
 * The exit timeout-backbone test uses REAL (short) timers, mirroring
 * `dom.renderer.anim.test.ts`.
 */

import { test, expect, describe } from "bun:test";
import { CanvasRenderer } from "../packages/web/src/canvas/index.js";
import type { Patch } from "../packages/core/src/types";

// ---------------------------------------------------------------------------
// Mocks (canvas-integration.test.ts pattern, plus the transform methods the
// paint path needs once animated nodes carry translate/rotate/scale props)
// ---------------------------------------------------------------------------

class MockCanvasContext {
  fillStyle: any = "#000000";
  strokeStyle: any = "#000000";
  lineWidth = 1;
  font = "10px sans-serif";
  textAlign = "left";
  textBaseline = "top";
  globalAlpha = 1;
  shadowColor = "";
  shadowBlur = 0;
  shadowOffsetX = 0;
  shadowOffsetY = 0;

  private stack: any[] = [];

  save() {
    this.stack.push({ fillStyle: this.fillStyle, globalAlpha: this.globalAlpha, font: this.font });
  }
  restore() {
    const s = this.stack.pop();
    if (s) Object.assign(this, s);
  }
  scale() {}
  translate() {}
  rotate() {}
  transform() {}
  setTransform() {}
  fillRect() {}
  strokeRect() {}
  clearRect() {}
  fillText() {}
  measureText(text: string) {
    return { width: text.length * 8 };
  }
  beginPath() {}
  closePath() {}
  moveTo() {}
  lineTo() {}
  arcTo() {}
  arc() {}
  ellipse() {}
  quadraticCurveTo() {}
  bezierCurveTo() {}
  fill() {}
  stroke() {}
  clip() {}
  rect() {}
  setLineDash() {}
  drawImage() {}
  createLinearGradient() {
    return { addColorStop() {} };
  }
  createRadialGradient() {
    return { addColorStop() {} };
  }
}

class MockCanvas {
  width = 800;
  height = 600;
  style: any = { width: "800px", height: "600px", cursor: "default" };
  private context = new MockCanvasContext();
  private listeners = new Map<string, Function[]>();

  getContext(type: string) {
    return type === "2d" ? this.context : null;
  }
  getBoundingClientRect() {
    return { width: 800, height: 600, left: 0, top: 0, right: 800, bottom: 600, x: 0, y: 0 };
  }
  addEventListener(event: string, handler: Function) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event)!.push(handler);
  }
  removeEventListener(event: string, handler: Function) {
    const list = this.listeners.get(event);
    if (list) {
      const i = list.indexOf(handler);
      if (i >= 0) list.splice(i, 1);
    }
  }
  dispatchEvent(event: any) {
    for (const h of this.listeners.get(event.type) ?? []) h(event);
    return true;
  }
  get parentElement() {
    return { appendChild: () => {} };
  }
}

class MockEngine {
  dispatched: Array<{ name: string; payload: any }> = [];
  dispatchAction(name: string, payload?: any) {
    this.dispatched.push({ name, payload });
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function createHarness() {
  const canvas = new MockCanvas();
  const engine = new MockEngine();
  const renderer = new CanvasRenderer(canvas as any, engine as any, {
    devicePixelRatio: 1,
    backgroundColor: "#ffffff",
    enableAccessibility: false,
    enableHitTesting: true,
  });
  const animator = renderer.getAnimator();
  let now = 0;
  animator.now = () => now;
  // Frames are driven manually below — disable the rAF-less snap fallback
  // (which is itself under test in the "tickless host" describe block).
  animator.manualFrameDriver = true;
  /** Advance the animator clock and run one frame. */
  const advance = (ms: number) => {
    now += ms;
    (renderer as any).render();
  };
  return { canvas, engine, renderer, animator, advance, currentTime: () => now };
}

const create = (id: string, elementType: string, props: Record<string, any> = {}): Patch =>
  ({ type: "create", id, elementType, props }) as any;
const insert = (parentId: string, id: string, beforeId?: string): Patch =>
  ({ type: "insert", parentId, id, beforeId }) as any;
const setProp = (id: string, name: string, value: any): Patch =>
  ({ type: "setProp", id, name, value }) as any;
const removeProp = (id: string, name: string): Patch =>
  ({ type: "removeProp", id, name }) as any;
const remove = (id: string, transition?: boolean): Patch =>
  ({ type: "remove", id, ...(transition ? { transition: true } : {}) }) as any;

/** Root column, applied as the (enter-suppressed) first batch. */
function mountRoot(renderer: CanvasRenderer) {
  renderer.applyPatches([create("root", "column", {}), insert("root", "root")]);
}

const LINEAR_TRANSITION = { duration: 200, curve: "linear" };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function synthesizeClick(canvas: MockCanvas, x: number, y: number) {
  const base = { clientX: x, clientY: y, button: 0, preventDefault() {} };
  canvas.dispatchEvent({ type: "mousedown", ...base });
  canvas.dispatchEvent({ type: "mouseup", ...base });
  canvas.dispatchEvent({ type: "click", ...base });
}

// ---------------------------------------------------------------------------
// .transition
// ---------------------------------------------------------------------------

describe("canvas .transition channel", () => {
  test("numeric prop interpolates into real props and layout mid-flight, settles exactly", () => {
    const { renderer, animator, advance } = createHarness();
    mountRoot(renderer);
    renderer.applyPatches([
      create("a", "column", { width: 100, height: 50, "__anim.transition": LINEAR_TRANSITION }),
      insert("root", "a"),
    ]);
    const node = renderer.getNode("a")!;
    expect(node.props.width).toBe(100);

    renderer.applyPatches([setProp("a", "width", 200)]);
    // Rewound to the previous value until the clock advances.
    expect(node.props.width).toBe(100);
    expect(animator.hasActive()).toBe(true);

    advance(100); // t = 0.5, linear
    expect(node.props.width).toBeCloseTo(150, 5);
    // The REAL layout follows the interpolated prop (hit-testing reads it).
    expect(node.layout).toBeDefined();
    expect(Math.abs(node.layout!.width - 150)).toBeLessThan(1);

    advance(100); // t = 1 → settle to the exact target
    expect(node.props.width).toBe(200);
    expect(animator.hasActive()).toBe(false);
    expect(Math.abs(node.layout!.width - 200)).toBeLessThan(1);
  });

  test("mid-flight retarget continues from the current interpolated value", () => {
    const { renderer, advance } = createHarness();
    mountRoot(renderer);
    renderer.applyPatches([
      create("a", "column", { width: 100, "__anim.transition": LINEAR_TRANSITION }),
      insert("root", "a"),
    ]);
    const node = renderer.getNode("a")!;
    renderer.applyPatches([setProp("a", "width", 200)]);
    advance(100); // width = 150

    renderer.applyPatches([setProp("a", "width", 300)]);
    // No jump: the retargeted animation starts from the interpolated 150.
    expect(node.props.width).toBeCloseTo(150, 5);
    advance(100); // half of 150 → 300
    expect(node.props.width).toBeCloseTo(225, 5);
    advance(100);
    expect(node.props.width).toBe(300);
  });

  test("color props interpolate in RGBA and settle to the exact target string", () => {
    const { renderer, advance } = createHarness();
    mountRoot(renderer);
    renderer.applyPatches([
      create("a", "column", { backgroundColor: "#000000", "__anim.transition": LINEAR_TRANSITION }),
      insert("root", "a"),
    ]);
    const node = renderer.getNode("a")!;
    renderer.applyPatches([setProp("a", "backgroundColor", "#ffffff")]);
    // The batch's synchronous frame already ticked at t=0, so the from-color
    // is in play (normalized to rgba form) — visually still black.
    expect(node.props.backgroundColor).toBe("rgba(0, 0, 0, 1)");

    advance(100);
    expect(node.props.backgroundColor).toBe("rgba(128, 128, 128, 1)");
    advance(100);
    expect(node.props.backgroundColor).toBe("#ffffff");
  });

  test("opacity animates through the computed cache (0 stays 0, not opaque)", () => {
    const { renderer, advance } = createHarness();
    mountRoot(renderer);
    renderer.applyPatches([
      create("a", "column", { opacity: 1, "__anim.transition": LINEAR_TRANSITION }),
      insert("root", "a"),
    ]);
    const node = renderer.getNode("a")!;
    renderer.applyPatches([setProp("a", "opacity", 0)]);
    advance(100);
    expect(node.props.opacity).toBeCloseTo(0.5, 5);
    expect(node.opacity).toBeCloseTo(0.5, 5);
    advance(100);
    expect(node.props.opacity).toBe(0);
  });

  test("props-scoped spec snaps out-of-scope changes", () => {
    const { renderer, animator } = createHarness();
    mountRoot(renderer);
    renderer.applyPatches([
      create("a", "column", {
        width: 100,
        "__anim.transition": { duration: 200, curve: "linear", props: ["opacity"] },
      }),
      insert("root", "a"),
    ]);
    renderer.applyPatches([setProp("a", "width", 200)]);
    expect(renderer.getNode("a")!.props.width).toBe(200);
    expect(animator.hasActive()).toBe(false);
  });

  test("non-interpolable values and malformed specs snap silently", () => {
    const { renderer, animator } = createHarness();
    mountRoot(renderer);
    renderer.applyPatches([
      create("a", "column", { backgroundColor: "#000000", "__anim.transition": LINEAR_TRANSITION }),
      // Malformed channel (duration is not a number) → parses to null → snap.
      create("b", "column", { width: 100, "__anim.transition": { duration: "fast", curve: "linear" } }),
      insert("root", "a"),
      insert("root", "b"),
    ]);
    renderer.applyPatches([setProp("a", "backgroundColor", "no-such-color-token")]);
    expect(renderer.getNode("a")!.props.backgroundColor).toBe("no-such-color-token");
    renderer.applyPatches([setProp("b", "width", 300)]);
    expect(renderer.getNode("b")!.props.width).toBe(300);
    expect(animator.hasActive()).toBe(false);
  });

  test("applicator-namespaced setProp (opacity.0) animates the flat prop", () => {
    const { renderer, advance } = createHarness();
    mountRoot(renderer);
    renderer.applyPatches([
      create("a", "column", { "opacity.0": 1, "__anim.transition": LINEAR_TRANSITION }),
      insert("root", "a"),
    ]);
    const node = renderer.getNode("a")!;
    expect(node.props.opacity).toBe(1); // normalized flat entry
    renderer.applyPatches([setProp("a", "opacity.0", 0.2)]);
    advance(100);
    expect(node.props.opacity).toBeCloseTo(0.6, 5);
    advance(100);
    expect(node.props.opacity).toBe(0.2);
  });
});

// ---------------------------------------------------------------------------
// .enter
// ---------------------------------------------------------------------------

describe("canvas .enter channel", () => {
  test("fade enters from opacity 0 and restores the original prop on settle", () => {
    const { renderer, advance } = createHarness();
    mountRoot(renderer);
    renderer.applyPatches([
      create("e", "column", { "__anim.enter": { presets: ["fade"], duration: 200, curve: "linear" } }),
      insert("root", "e"),
    ]);
    const node = renderer.getNode("e")!;
    // Hidden pose lands at flush, before the first tick advances.
    expect(node.props.opacity).toBe(0);
    expect(node.opacity).toBe(0);

    advance(100);
    expect(node.props.opacity).toBeCloseTo(0.5, 5);
    advance(100);
    // Original prop was absent → restored to absent, cache back to 1.
    expect(node.props.opacity).toBeUndefined();
    expect(node.opacity).toBe(1);
  });

  test("slide(from: bottom) enters via translateY and cleans up after itself", () => {
    const { renderer, advance, animator } = createHarness();
    mountRoot(renderer);
    renderer.applyPatches([
      create("e", "column", {
        "__anim.enter": { presets: ["slide"], from: "bottom", duration: 200, curve: "linear" },
      }),
      insert("root", "e"),
    ]);
    const node = renderer.getNode("e")!;
    expect(node.props.translateY).toBe(24);
    advance(100);
    expect(node.props.translateY).toBeCloseTo(12, 5);
    advance(100);
    expect(node.props.translateY).toBeUndefined();
    expect(animator.hasActive()).toBe(false);
  });

  test("the first-ever batch never enter-animates", () => {
    const { renderer, animator } = createHarness();
    renderer.applyPatches([
      create("root", "column", {}),
      create("e", "column", { "__anim.enter": { presets: ["fade"], duration: 200, curve: "linear" } }),
      insert("root", "root"),
      insert("root", "e"),
    ]);
    expect(renderer.getNode("e")!.props.opacity).toBeUndefined();
    expect(animator.hasActive()).toBe(false);
  });

  test("a cached attach (detach → attach) never replays the enter", () => {
    const { renderer, advance, animator } = createHarness();
    mountRoot(renderer);
    renderer.applyPatches([
      create("e", "column", { "__anim.enter": { presets: ["fade"], duration: 200, curve: "linear" } }),
      insert("root", "e"),
    ]);
    advance(250); // let the create-batch enter settle
    renderer.applyPatches([{ type: "detach", id: "e" } as any]);
    renderer.applyPatches([{ type: "attach", parentId: "root", id: "e" } as any]);
    expect(renderer.getNode("e")!.props.opacity).toBeUndefined();
    expect(animator.hasActive()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// .exit — deferred remove protocol
// ---------------------------------------------------------------------------

describe("canvas .exit channel", () => {
  const exitSpec = { presets: ["fade"], duration: 1000, curve: "linear" };

  test("flagged remove defers teardown, excludes the subtree from hit-testing, finalizes on settle", () => {
    const { renderer, canvas, engine, advance } = createHarness();
    mountRoot(renderer);
    renderer.applyPatches([
      create("x", "button", {
        width: 100,
        height: 40,
        onClick: "@actions.tap",
        "__anim.exit": exitSpec,
      }),
      insert("root", "x"),
    ]);
    advance(0); // layout pass so hit-testing has bounds

    synthesizeClick(canvas, 10, 10);
    expect(engine.dispatched.filter((d) => d.name === "tap").length).toBe(1);

    renderer.applyPatches([remove("x", true)]);
    const node = renderer.getNode("x")!;
    // Deferred: still in the tree, still painted, marked exiting.
    expect(node).toBeDefined();
    expect(renderer.getNode("root")!.children).toContain(node);
    expect(node.exiting).toBe(true);

    // Hit-testing excludes the exiting subtree immediately.
    synthesizeClick(canvas, 10, 10);
    expect(engine.dispatched.filter((d) => d.name === "tap").length).toBe(1);

    advance(500);
    expect(node.props.opacity).toBeCloseTo(0.5, 5);
    expect(renderer.getNode("x")).toBeDefined();

    advance(600); // past duration → finalize
    expect(renderer.getNode("x")).toBeUndefined();
    expect(renderer.getNode("root")!.children.length).toBe(0);
  });

  test("descendant plain removes defer with the exiting root and finalize together", () => {
    const { renderer, advance } = createHarness();
    mountRoot(renderer);
    renderer.applyPatches([
      create("p", "column", { "__anim.exit": exitSpec }),
      create("c", "text", {}),
      insert("root", "p"),
      insert("p", "c"),
    ]);
    // Wire ordering: flagged root FIRST, then descendants as plain removes.
    renderer.applyPatches([remove("p", true), remove("c")]);
    expect(renderer.getNode("p")).toBeDefined();
    expect(renderer.getNode("c")).toBeDefined();
    expect(renderer.getNode("p")!.children.length).toBe(1);

    advance(1100);
    expect(renderer.getNode("p")).toBeUndefined();
    expect(renderer.getNode("c")).toBeUndefined();
  });

  test("flagged remove without an exit spec snaps (sanctioned degradation)", () => {
    const { renderer } = createHarness();
    mountRoot(renderer);
    renderer.applyPatches([create("x", "column", {}), insert("root", "x")]);
    renderer.applyPatches([remove("x", true)]);
    expect(renderer.getNode("x")).toBeUndefined();
  });

  test("timeout backbone finalizes a stalled exit (duration + delay + 80ms)", async () => {
    const { renderer } = createHarness();
    mountRoot(renderer);
    renderer.applyPatches([
      create("x", "column", { "__anim.exit": { presets: ["fade"], duration: 40, curve: "linear" } }),
      insert("root", "x"),
    ]);
    renderer.applyPatches([remove("x", true)]);
    expect(renderer.getNode("x")).toBeDefined();
    // No ticks at all: the fake clock never advances. The real-time timeout
    // backbone (40 + 0 + 80 = 120ms) must finalize on its own.
    await sleep(200);
    expect(renderer.getNode("x")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// .animate presets
// ---------------------------------------------------------------------------

describe("canvas .animate presets", () => {
  test("pulse oscillates opacity (1 → 0.5 → 1) and loops", () => {
    const { renderer, advance, animator } = createHarness();
    mountRoot(renderer);
    renderer.applyPatches([
      create("a", "column", {
        "__anim.animate": { preset: "pulse", duration: 1000, repeat: "loop", curve: "linear" },
      }),
      insert("root", "a"),
    ]);
    const node = renderer.getNode("a")!;
    advance(500);
    expect(node.props.opacity).toBeCloseTo(0.5, 5);
    advance(250); // p = 0.75 → back toward 1
    expect(node.props.opacity).toBeCloseTo(0.75, 5);
    advance(250); // wrapped: p = 0 → 1
    expect(node.props.opacity).toBeCloseTo(1, 5);
    expect(animator.hasActive()).toBe(true); // loops keep the ticker alive
  });

  test("spin rotates 0→360 per iteration with real rotate prop", () => {
    const { renderer, advance } = createHarness();
    mountRoot(renderer);
    renderer.applyPatches([
      create("a", "column", {
        "__anim.animate": { preset: "spin", duration: 800, repeat: "loop", curve: "linear" },
      }),
      insert("root", "a"),
    ]);
    const node = renderer.getNode("a")!;
    advance(400);
    expect(node.props.rotate).toBeCloseTo(180, 5);
    advance(800); // full extra iteration → same phase
    expect(node.props.rotate).toBeCloseTo(180, 5);
  });

  test("finite repeat (shake) stops after its iterations and restores props", () => {
    const { renderer, advance, animator } = createHarness();
    mountRoot(renderer);
    renderer.applyPatches([
      create("a", "column", {
        "__anim.animate": { preset: "shake", duration: 400, repeat: 1, curve: "linear" },
      }),
      insert("root", "a"),
    ]);
    const node = renderer.getNode("a")!;
    advance(200); // p = 0.5 → between +6 (0.4) and -4 (0.6) keyframes
    expect(typeof node.props.translateX).toBe("number");
    advance(300); // past the single iteration
    expect(node.props.translateX).toBeUndefined();
    expect(animator.hasActive()).toBe(false);
  });

  test("a changed spec restarts playback from the beginning", () => {
    const { renderer, advance } = createHarness();
    mountRoot(renderer);
    renderer.applyPatches([
      create("a", "column", {
        "__anim.animate": { preset: "pulse", duration: 1000, repeat: "loop", curve: "linear" },
      }),
      insert("root", "a"),
    ]);
    const node = renderer.getNode("a")!;
    advance(500);
    expect(node.props.opacity).toBeCloseTo(0.5, 5);
    renderer.applyPatches([
      setProp("a", "__anim.animate", { preset: "pulse", duration: 1000, repeat: "loop", curve: "linear" }),
    ]);
    advance(0); // restarted: phase 0 → factor 1
    expect(node.props.opacity).toBeCloseTo(1, 5);
  });

  test("removing the channel stops playback and restores the touched props", () => {
    const { renderer, advance, animator } = createHarness();
    mountRoot(renderer);
    renderer.applyPatches([
      create("a", "column", {
        "__anim.animate": { preset: "pulse", duration: 1000, repeat: "loop", curve: "linear" },
      }),
      insert("root", "a"),
    ]);
    const node = renderer.getNode("a")!;
    advance(500);
    expect(node.props.opacity).toBeCloseTo(0.5, 5);
    renderer.applyPatches([removeProp("a", "__anim.animate")]);
    expect(node.props.opacity).toBeUndefined();
    expect(node.opacity).toBe(1);
    expect(animator.hasActive()).toBe(false);
  });

  test("shimmer is a silent no-op (no honest canvas equivalent)", () => {
    const { renderer, advance, animator } = createHarness();
    mountRoot(renderer);
    renderer.applyPatches([
      create("a", "column", {
        backgroundColor: "#eeeeee",
        "__anim.animate": { preset: "shimmer", duration: 1500, repeat: "loop", curve: "linear" },
      }),
      insert("root", "a"),
    ]);
    const node = renderer.getNode("a")!;
    advance(750);
    expect(node.props.backgroundColor).toBe("#eeeeee");
    expect(animator.hasActive()).toBe(false); // no runaway ticker for a no-op
  });
});

// ---------------------------------------------------------------------------
// Reduced motion
// ---------------------------------------------------------------------------

describe("canvas reduced motion", () => {
  test("snaps transitions, skips enters, never starts .animate", () => {
    const { renderer, animator } = createHarness();
    animator.reducedMotionOverride = true;
    mountRoot(renderer);
    renderer.applyPatches([
      create("a", "column", { width: 100, "__anim.transition": LINEAR_TRANSITION }),
      create("e", "column", { "__anim.enter": { presets: ["fade"], duration: 200, curve: "linear" } }),
      create("p", "column", {
        "__anim.animate": { preset: "pulse", duration: 1000, repeat: "loop", curve: "linear" },
      }),
      insert("root", "a"),
      insert("root", "e"),
      insert("root", "p"),
    ]);
    // Enter skipped (no hidden pose), animate never started.
    expect(renderer.getNode("e")!.props.opacity).toBeUndefined();
    expect(animator.hasActive()).toBe(false);

    renderer.applyPatches([setProp("a", "width", 200)]);
    expect(renderer.getNode("a")!.props.width).toBe(200); // snap
    expect(animator.hasActive()).toBe(false);
  });

  test("finalizes a flagged exit immediately (synchronous teardown)", () => {
    const { renderer, animator } = createHarness();
    animator.reducedMotionOverride = true;
    mountRoot(renderer);
    renderer.applyPatches([
      create("x", "column", { "__anim.exit": { presets: ["fade"], duration: 1000, curve: "linear" } }),
      insert("root", "x"),
    ]);
    renderer.applyPatches([remove("x", true)]);
    expect(renderer.getNode("x")).toBeUndefined();
    expect(renderer.getNode("root")!.children.length).toBe(0);
    expect(animator.hasActive()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Coherence with the rest of the renderer (engine writes, variants, router)
// ---------------------------------------------------------------------------

describe("canvas animation coherence", () => {
  test("a transition on a prop that also carries a variant key is not clobbered by the variant pass", () => {
    const { renderer, advance, animator } = createHarness();
    mountRoot(renderer);
    renderer.applyPatches([
      create("v", "column", {
        opacity: 1,
        "opacity:hover": 0.8, // same base carries a variant key
        "__anim.transition": LINEAR_TRANSITION,
      }),
      insert("root", "v"),
    ]);
    const node = renderer.getNode("v")!;
    renderer.applyPatches([setProp("v", "opacity", 0)]);

    advance(100);
    // The per-frame variant pass (restore originals → resolve winners) must
    // ride on the interpolated value, not restore the pre-animation snapshot.
    expect(node.props.opacity).toBeCloseTo(0.5, 5);
    advance(100);
    expect(node.props.opacity).toBe(0);
    expect(animator.hasActive()).toBe(false);
    // Later frames (variant pass keeps running) must not resurrect the old value.
    advance(50);
    expect(node.props.opacity).toBe(0);
  });

  test("an engine setProp mid-enter retargets the playback and survives settle", () => {
    const { renderer, advance, animator } = createHarness();
    mountRoot(renderer);
    renderer.applyPatches([
      create("e", "column", { "__anim.enter": { presets: ["fade"], duration: 200, curve: "linear" } }),
      insert("root", "e"),
    ]);
    const node = renderer.getNode("e")!;
    advance(50);
    expect(node.props.opacity).toBeCloseTo(0.25, 5);

    // No `.transition` spec on the node: the engine's write is still ground
    // truth — the enter converges to it and settle must NOT restore the
    // pre-enter original (absent → fully opaque).
    renderer.applyPatches([setProp("e", "opacity", 0.5)]);
    advance(150); // past the enter duration
    expect(node.props.opacity).toBe(0.5);
    expect(node.opacity).toBe(0.5);
    expect(animator.hasActive()).toBe(false);
    advance(50);
    expect(node.props.opacity).toBe(0.5); // stays: no stale restore
  });

  test("an engine setProp mid-ambient refreshes originals and base opacity", () => {
    const { renderer, advance } = createHarness();
    mountRoot(renderer);
    renderer.applyPatches([
      create("p", "column", {
        opacity: 0.9,
        "__anim.animate": { preset: "pulse", duration: 1000, repeat: "loop", curve: "linear" },
      }),
      insert("root", "p"),
    ]);
    const node = renderer.getNode("p")!;
    advance(250);

    renderer.applyPatches([setProp("p", "opacity", 0.3)]);
    advance(250); // p = 0.5 → factor 0.5 against the NEW base
    expect(node.props.opacity).toBeCloseTo(0.15, 5);

    // Clearing the channel restores the engine's 0.3, not the stale 0.9.
    renderer.applyPatches([removeProp("p", "__anim.animate")]);
    expect(node.props.opacity).toBe(0.3);
    expect(node.opacity).toBe(0.3);
  });

  test("an engine removeProp mid-ambient restores 'absent' on stop", () => {
    const { renderer, advance } = createHarness();
    mountRoot(renderer);
    renderer.applyPatches([
      create("p", "column", {
        opacity: 0.9,
        "__anim.animate": { preset: "pulse", duration: 1000, repeat: "loop", curve: "linear" },
      }),
      insert("root", "p"),
    ]);
    const node = renderer.getNode("p")!;
    advance(250);
    renderer.applyPatches([removeProp("p", "opacity")]);
    advance(250);
    renderer.applyPatches([removeProp("p", "__anim.animate")]);
    expect(node.props.opacity).toBeUndefined();
    expect(node.opacity).toBe(1);
  });

  test("a Router-detached subtree holds its looping ambient (no runaway ticker) and resumes on attach", () => {
    const { renderer, advance, animator } = createHarness();
    mountRoot(renderer);
    renderer.applyPatches([
      create("s", "column", {
        "__anim.animate": { preset: "spin", duration: 800, repeat: "loop", curve: "linear" },
      }),
      insert("root", "s"),
    ]);
    const node = renderer.getNode("s")!;
    advance(400);
    expect(node.props.rotate).toBeCloseTo(180, 5);
    expect(animator.hasActive()).toBe(true);

    renderer.applyPatches([{ type: "detach", id: "s" } as any]);
    // Not painted → not ticked, and the ambient must NOT keep the redraw
    // loop armed (a cached route would otherwise burn 60fps forever).
    expect(animator.hasActive()).toBe(false);
    advance(600);
    expect(node.props.rotate).toBeCloseTo(180, 5); // no writes while detached

    renderer.applyPatches([{ type: "attach", parentId: "root", id: "s" } as any]);
    expect(animator.hasActive()).toBe(true);
    advance(400); // now=1400 → phase (1400 % 800)/800 = 0.75
    expect(node.props.rotate).toBeCloseTo(270, 5);
  });

  test("a delayed layout transition does not force per-frame layout re-solves during the delay window", () => {
    const { renderer, advance, animator } = createHarness();
    mountRoot(renderer);
    renderer.applyPatches([
      create("d", "column", {
        width: 100,
        "__anim.transition": { duration: 200, curve: "linear", delay: 1000 },
      }),
      insert("root", "d"),
    ]);
    const host = (animator as any).host;
    const origMarkLayoutDirty = host.markLayoutDirty;
    let layoutDirtyCalls = 0;
    host.markLayoutDirty = () => {
      layoutDirtyCalls += 1;
      origMarkLayoutDirty();
    };

    renderer.applyPatches([setProp("d", "width", 300)]);
    const baseline = layoutDirtyCalls; // ≤1: the one-time hold write
    advance(100);
    advance(100);
    advance(100);
    // Pure delay-phase frames: the held from-value never changes, so no
    // layout invalidation may fire.
    expect(layoutDirtyCalls).toBe(baseline);
    expect(renderer.getNode("d")!.props.width).toBe(100);

    advance(800); // now = 1100 → t = 0.5
    expect(renderer.getNode("d")!.props.width).toBeCloseTo(200, 5);
    expect(layoutDirtyCalls).toBeGreaterThan(baseline);
    advance(200);
    expect(renderer.getNode("d")!.props.width).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// Exit window: focus / keyboard / AT parity
// ---------------------------------------------------------------------------

describe("canvas exit focus and activation eviction", () => {
  const exitSpec = { presets: ["fade"], duration: 1000, curve: "linear" };

  test("beginning an exit evicts focus from the dying subtree immediately", () => {
    const { renderer, advance } = createHarness();
    mountRoot(renderer);
    renderer.applyPatches([
      create("x", "button", { onClick: "@actions.tap", "__anim.exit": exitSpec }),
      insert("root", "x"),
    ]);
    advance(0);
    const node = renderer.getNode("x")!;
    const focusManager = (renderer as any).focusManager;
    focusManager.requestFocus(node);
    expect(focusManager.getFocusedNode()).toBe(node);
    expect(node.focused).toBe(true);

    renderer.applyPatches([remove("x", true)]);
    // Deferred teardown — but focus must die NOW, not at finalize.
    expect(renderer.getNode("x")).toBeDefined();
    expect(node.exiting).toBe(true);
    expect(focusManager.getFocusedNode()).toBe(null);
    expect(node.focused).toBe(false);
  });

  test("mirror click/key activation on an exiting subtree never dispatches (AT twin of hit-test pruning)", async () => {
    const { FocusManager } = await import("../packages/web/src/canvas/focus.js");
    const listeners = new Map<string, Function>();
    const fakeRoot: any = {
      addEventListener: (type: string, cb: Function) => listeners.set(type, cb),
      removeEventListener: () => {},
      contains: () => false,
    };
    const mirror: any = { getRoot: () => fakeRoot, getElement: () => undefined };
    const engine = new MockEngine();
    const parent: any = { id: "p", props: {}, parent: null, children: [], exiting: true };
    const child: any = {
      id: "c",
      props: { onClick: "@actions.tap" },
      parent,
      children: [],
      clickable: true,
    };
    parent.children.push(child);
    const fm = new FocusManager(mirror, engine as any, {
      getNode: (id: string) => (id === "c" ? child : id === "p" ? parent : undefined),
      onFocusChange: () => {},
    });
    const target = {
      getAttribute: (name: string) => (name === "data-hypen-id" ? "c" : null),
      parentNode: fakeRoot,
    };

    listeners.get("click")!({ target });
    listeners.get("keydown")!({ target, key: "Enter", code: "Enter" });
    expect(engine.dispatched.length).toBe(0); // corpse: engine-side id is dead

    parent.exiting = false; // control: same wiring dispatches once live
    listeners.get("click")!({ target });
    expect(engine.dispatched.length).toBe(1);
    expect(engine.dispatched[0].name).toBe("tap");
    fm.destroy();
  });
});

// ---------------------------------------------------------------------------
// Reduced motion: live preference toggle
// ---------------------------------------------------------------------------

describe("canvas reduced motion live toggle", () => {
  test("enabling reduce-motion mid-session snaps transitions/ambients/exits; disabling starts cached .animate specs", () => {
    const globals = globalThis as any;
    let mediaListener: (() => void) | null = null;
    const query = {
      matches: false,
      addEventListener: (_type: string, cb: () => void) => {
        mediaListener = cb;
      },
      removeEventListener: () => {},
    };
    globals.window = {
      matchMedia: () => query,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    try {
      const { renderer, animator, advance } = createHarness();
      mountRoot(renderer);
      renderer.applyPatches([
        create("a", "column", { width: 100, "__anim.transition": LINEAR_TRANSITION }),
        create("p", "column", {
          "__anim.animate": { preset: "pulse", duration: 1000, repeat: "loop", curve: "linear" },
        }),
        create("x", "column", { "__anim.exit": { presets: ["fade"], duration: 1000, curve: "linear" } }),
        insert("root", "a"),
        insert("root", "p"),
        insert("root", "x"),
      ]);
      renderer.applyPatches([setProp("a", "width", 200)]);
      renderer.applyPatches([remove("x", true)]);
      advance(100);
      expect(renderer.getNode("a")!.props.width).toBeCloseTo(150, 5);
      expect(renderer.getNode("x")).toBeDefined(); // exit in flight
      expect(mediaListener).not.toBe(null);

      query.matches = true;
      mediaListener!();
      // Everything snapped: transition at target, pulse stopped+restored,
      // exit finalized, ticker idle.
      expect(renderer.getNode("a")!.props.width).toBe(200);
      expect(renderer.getNode("p")!.props.opacity).toBeUndefined();
      expect(renderer.getNode("x")).toBeUndefined();
      expect(animator.hasActive()).toBe(false);

      // While reduced: a transition-covered setProp snaps.
      renderer.applyPatches([setProp("a", "width", 400)]);
      expect(renderer.getNode("a")!.props.width).toBe(400);
      expect(animator.hasActive()).toBe(false);

      query.matches = false;
      mediaListener!();
      // The cached looping preset starts now (it never got to play).
      expect(animator.hasActive()).toBe(true);
      advance(500);
      expect(renderer.getNode("p")!.props.opacity).toBeCloseTo(0.5, 5);
      renderer.destroy(); // exercises the media-listener teardown path
    } finally {
      delete globals.window;
    }
  });
});

// ---------------------------------------------------------------------------
// rAF-less hosts: snap, don't freeze
// ---------------------------------------------------------------------------

describe("canvas tickless-host degradation", () => {
  test("without rAF (and without manual driving), animations snap to final values instead of freezing", () => {
    const { renderer, animator } = createHarness();
    animator.manualFrameDriver = false; // production-like headless host
    mountRoot(renderer);
    renderer.applyPatches([
      create("a", "column", { width: 100, "__anim.transition": LINEAR_TRANSITION }),
      create("e", "column", { "__anim.enter": { presets: ["fade"], duration: 200, curve: "linear" } }),
      insert("root", "a"),
      insert("root", "e"),
    ]);
    // The enter must not freeze at its hidden pose (opacity 0 = content
    // vanishes) — it settles to the restored original immediately.
    expect(renderer.getNode("e")!.props.opacity).toBeUndefined();
    expect(renderer.getNode("e")!.opacity).toBe(1);

    renderer.applyPatches([setProp("a", "width", 200)]);
    expect(renderer.getNode("a")!.props.width).toBe(200);
    expect(animator.hasActive()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Ticker lifecycle (fake rAF)
// ---------------------------------------------------------------------------

describe("canvas animation ticker", () => {
  test("re-arms rAF while animations are in flight and stands down when idle", () => {
    const globals = globalThis as any;
    const queue: Array<() => void> = [];
    globals.requestAnimationFrame = (cb: () => void) => {
      queue.push(cb);
      return queue.length;
    };
    globals.cancelAnimationFrame = () => {};
    try {
      const { renderer, animator } = createHarness();
      let now = 0;
      animator.now = () => now;
      const flushFrames = () => {
        const cbs = queue.splice(0);
        for (const cb of cbs) cb();
      };

      mountRoot(renderer); // schedules the first frame
      flushFrames();
      renderer.applyPatches([
        create("a", "column", { width: 100, "__anim.transition": LINEAR_TRANSITION }),
        insert("root", "a"),
      ]);
      flushFrames();
      renderer.applyPatches([setProp("a", "width", 200)]);
      expect(queue.length).toBe(1); // batch scheduled a frame

      now = 100;
      flushFrames(); // mid-flight tick → re-arms exactly one frame
      expect(renderer.getNode("a")!.props.width).toBeCloseTo(150, 5);
      expect(queue.length).toBe(1);

      now = 250;
      flushFrames(); // settles → no re-arm
      expect(renderer.getNode("a")!.props.width).toBe(200);
      expect(queue.length).toBe(0);

      flushFrames(); // nothing pending, nothing scheduled
      expect(queue.length).toBe(0);
    } finally {
      delete globals.requestAnimationFrame;
      delete globals.cancelAnimationFrame;
    }
  });
});
