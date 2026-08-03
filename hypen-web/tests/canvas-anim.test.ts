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
// `.onAnimationComplete` completion events (Option F) — canvas twins of the
// DOM firing-point tests in dom.renderer.anim.test.ts. Natural settles only:
// the tick clock (or the exit timeout backbone) is the settle signal, and
// interrupted / superseded / reduced-motion-skipped playbacks fire nothing.
// ---------------------------------------------------------------------------

describe("canvas `.onAnimationComplete` completion events (Option F)", () => {
  const DONE = "onAnimationComplete.0";
  const enterSpec = { presets: ["fade"], duration: 200, curve: "linear" };
  const exitSpec = { presets: ["fade"], duration: 1000, curve: "linear" };

  test("enter settling naturally dispatches { animation: 'enter' }", () => {
    const { renderer, engine, advance } = createHarness();
    mountRoot(renderer);
    renderer.applyPatches([
      create("toast", "column", { "__anim.enter": enterSpec, [DONE]: "@actions.animDone" }),
      insert("root", "toast"),
    ]);
    advance(100); // mid-flight: nothing yet
    expect(engine.dispatched.length).toBe(0);

    advance(100); // t = 1 → the playback group settles naturally
    expect(engine.dispatched).toEqual([
      { name: "animDone", payload: { animation: "enter" } },
    ]);
  });

  test("extra applicator args merge under the payload; completion fields win", () => {
    const { renderer, engine, advance } = createHarness();
    mountRoot(renderer);
    renderer.applyPatches([
      create("toast", "column", {
        "__anim.enter": enterSpec,
        [DONE]: "@actions.animDone",
        "onAnimationComplete.id": "toast-1",
      }),
      insert("root", "toast"),
    ]);
    advance(250);
    expect(engine.dispatched).toEqual([
      { name: "animDone", payload: { id: "toast-1", animation: "enter" } },
    ]);
  });

  test("no onAnimationComplete prop dispatches nothing on any settle", () => {
    const { renderer, engine, advance } = createHarness();
    mountRoot(renderer);
    renderer.applyPatches([
      create("toast", "column", { "__anim.enter": enterSpec, "__anim.exit": exitSpec }),
      insert("root", "toast"),
    ]);
    advance(250); // enter settles
    renderer.applyPatches([remove("toast", true)]);
    advance(1100); // exit settles + finalizes

    expect(renderer.getNode("toast")).toBeUndefined();
    expect(engine.dispatched.length).toBe(0);
  });

  test("exit settling naturally dispatches { animation: 'exit' } just before finalize", () => {
    const { renderer, engine, advance } = createHarness();
    mountRoot(renderer);
    renderer.applyPatches([
      create("toast", "column", { "__anim.exit": exitSpec, [DONE]: "@actions.animDone" }),
      insert("root", "toast"),
    ]);

    // Record whether the node was still alive at dispatch time (the "just
    // before finalize" contract).
    const aliveAtDispatch: boolean[] = [];
    const record = engine.dispatchAction.bind(engine);
    engine.dispatchAction = (name: string, payload?: any) => {
      aliveAtDispatch.push(renderer.getNode("toast") !== undefined);
      record(name, payload);
    };

    renderer.applyPatches([remove("toast", true)]);
    advance(500); // mid-exit: nothing yet
    expect(engine.dispatched.length).toBe(0);

    advance(600); // past the settle window → dispatch, then finalize
    expect(engine.dispatched).toEqual([
      { name: "animDone", payload: { animation: "exit" } },
    ]);
    expect(aliveAtDispatch).toEqual([true]);
    expect(renderer.getNode("toast")).toBeUndefined();
  });

  test("the timeout backbone settle also dispatches exit (natural, not interrupted)", async () => {
    const { renderer, engine } = createHarness();
    mountRoot(renderer);
    renderer.applyPatches([
      create("toast", "column", {
        "__anim.exit": { presets: ["fade"], duration: 40, curve: "linear" },
        [DONE]: "@actions.animDone",
      }),
      insert("root", "toast"),
    ]);
    renderer.applyPatches([remove("toast", true)]);
    // The fake clock never advances: only the real-time backbone
    // (40 + 0 + 80 = 120ms) settles — the playback still ran its course.
    await sleep(200);
    expect(renderer.getNode("toast")).toBeUndefined();
    expect(engine.dispatched).toEqual([
      { name: "animDone", payload: { animation: "exit" } },
    ]);
  });

  test("interrupted enter fires nothing; the superseding exit still fires", () => {
    const { renderer, engine, advance } = createHarness();
    mountRoot(renderer);
    renderer.applyPatches([
      create("toast", "column", {
        "__anim.enter": enterSpec,
        "__anim.exit": { presets: ["fade"], duration: 400, curve: "linear" },
        [DONE]: "@actions.animDone",
      }),
      insert("root", "toast"),
    ]);
    advance(50); // enter mid-flight

    // The exit replaces the enter's opacity animation — the enter's playback
    // group is broken and must never report completion.
    renderer.applyPatches([remove("toast", true)]);
    expect(engine.dispatched.length).toBe(0);

    advance(400); // exit settles + finalizes
    expect(engine.dispatched).toEqual([
      { name: "animDone", payload: { animation: "exit" } },
    ]);
    expect(renderer.getNode("toast")).toBeUndefined();
  });

  test("reduced-motion exit snap fires nothing", () => {
    const { renderer, engine, animator } = createHarness();
    animator.reducedMotionOverride = true;
    mountRoot(renderer);
    renderer.applyPatches([
      create("toast", "column", { "__anim.exit": exitSpec, [DONE]: "@actions.animDone" }),
      insert("root", "toast"),
    ]);
    renderer.applyPatches([remove("toast", true)]); // synchronous snap teardown
    expect(renderer.getNode("toast")).toBeUndefined();
    expect(engine.dispatched.length).toBe(0);
  });

  test("finite `.animate` preset completion dispatches the preset name", () => {
    const { renderer, engine, advance } = createHarness();
    mountRoot(renderer);
    renderer.applyPatches([
      create("alert", "column", {
        "__anim.animate": { preset: "shake", duration: 400, repeat: 1, curve: "linear" },
        [DONE]: "@actions.animDone",
      }),
      insert("root", "alert"),
    ]);
    advance(200); // mid-iteration: nothing
    expect(engine.dispatched.length).toBe(0);

    advance(250); // iterations exhausted → props restored + completion
    expect(renderer.getNode("alert")!.props.translateX).toBeUndefined();
    expect(engine.dispatched).toEqual([
      { name: "animDone", payload: { animation: "shake" } },
    ]);
  });

  test("looping presets never fire completion", () => {
    const { renderer, engine, advance, animator } = createHarness();
    mountRoot(renderer);
    renderer.applyPatches([
      create("spinner", "column", {
        "__anim.animate": { preset: "spin", duration: 800, repeat: "loop", curve: "linear" },
        [DONE]: "@actions.animDone",
      }),
      insert("root", "spinner"),
    ]);
    advance(4000); // many iterations
    expect(engine.dispatched.length).toBe(0);
    expect(animator.hasActive()).toBe(true); // still looping
  });

  test("interrupting a finite preset (channel removed mid-flight) fires nothing", () => {
    const { renderer, engine, advance } = createHarness();
    mountRoot(renderer);
    renderer.applyPatches([
      create("alert", "column", {
        "__anim.animate": { preset: "shake", duration: 400, repeat: 1, curve: "linear" },
        [DONE]: "@actions.animDone",
      }),
      insert("root", "alert"),
    ]);
    advance(200);
    renderer.applyPatches([removeProp("alert", "__anim.animate")]); // stop + restore
    advance(500); // well past where the iteration would have exhausted
    expect(engine.dispatched.length).toBe(0);
  });

  test("preset exhaustion on an exit-animating node fires nothing (dead engine-side); the exit still fires", () => {
    const { renderer, engine, advance } = createHarness();
    mountRoot(renderer);
    renderer.applyPatches([
      create("badge", "column", {
        // translateX preset vs opacity exit: no prop conflict, so the
        // ambient keeps ticking on the corpse and exhausts mid-exit.
        "__anim.animate": { preset: "shake", duration: 100, repeat: 1, curve: "linear" },
        "__anim.exit": exitSpec,
        [DONE]: "@actions.animDone",
      }),
      insert("root", "badge"),
    ]);
    renderer.applyPatches([remove("badge", true)]);

    advance(150); // shake exhausts while the node is exiting → nothing
    expect(engine.dispatched.length).toBe(0);

    advance(900); // the exit's own natural settle still reports
    expect(engine.dispatched).toEqual([
      { name: "animDone", payload: { animation: "exit" } },
    ]);
  });

  describe("`.states` settle (tick clock)", () => {
    const statesNodeProps = {
      "__anim.transition": { duration: 200, curve: "linear" },
      "__anim.states": { label: "collapsed" },
      [DONE]: "@actions.animDone",
    };
    const statesLabel = (label: string): Patch =>
      setProp("card", "__anim.states", { label });

    test("a label change settles after duration+delay with the label in the payload", () => {
      const { renderer, engine, advance, animator } = createHarness();
      mountRoot(renderer);
      renderer.applyPatches([
        create("card", "column", statesNodeProps),
        insert("root", "card"),
      ]);
      // Create-time resolution is not a transition — nothing settles.
      advance(300);
      expect(engine.dispatched.length).toBe(0);

      renderer.applyPatches([statesLabel("expanded")]);
      // The window rides the tick clock, so it must keep the ticker armed
      // even when every switched prop snapped (nothing else in flight).
      expect(animator.hasActive()).toBe(true);
      advance(100); // window open, not settled
      expect(engine.dispatched.length).toBe(0);

      advance(150); // past duration (200) + delay (0)
      expect(engine.dispatched).toEqual([
        { name: "animDone", payload: { animation: "states", state: "expanded" } },
      ]);
      expect(animator.hasActive()).toBe(false);
    });

    test("a superseding label change cancels the pending settle — only the last fires", () => {
      const { renderer, engine, advance } = createHarness();
      mountRoot(renderer);
      renderer.applyPatches([
        create("card", "column", statesNodeProps),
        insert("root", "card"),
      ]);
      renderer.applyPatches([statesLabel("expanded")]);
      advance(50);
      renderer.applyPatches([statesLabel("collapsed")]);

      advance(400); // past both windows
      expect(engine.dispatched).toEqual([
        { name: "animDone", payload: { animation: "states", state: "collapsed" } },
      ]);
    });

    test("re-resolving to the same label opens no new window and cancels nothing", () => {
      const { renderer, engine, advance } = createHarness();
      mountRoot(renderer);
      renderer.applyPatches([
        create("card", "column", statesNodeProps),
        insert("root", "card"),
      ]);
      renderer.applyPatches([statesLabel("expanded")]);
      advance(50);
      // Same label again (e.g. an unrelated re-resolve): NOT a pose switch.
      renderer.applyPatches([statesLabel("expanded")]);

      advance(200); // the ORIGINAL window (opened at t=0) fires exactly once
      expect(engine.dispatched).toEqual([
        { name: "animDone", payload: { animation: "states", state: "expanded" } },
      ]);
    });

    test("falling back to the default pose (no matched label) fires nothing and cancels a pending window", () => {
      const { renderer, engine, advance } = createHarness();
      mountRoot(renderer);
      renderer.applyPatches([
        create("card", "column", statesNodeProps),
        insert("root", "card"),
      ]);
      renderer.applyPatches([statesLabel("expanded")]);
      advance(50);
      renderer.applyPatches([removeProp("card", "__anim.states")]);

      advance(400);
      expect(engine.dispatched.length).toBe(0);
    });

    test("a label change without a transition spec snaps and fires nothing", () => {
      const { renderer, engine, advance, animator } = createHarness();
      mountRoot(renderer);
      renderer.applyPatches([
        create("card", "column", {
          "__anim.states": { label: "collapsed" },
          [DONE]: "@actions.animDone",
        }),
        insert("root", "card"),
      ]);
      renderer.applyPatches([statesLabel("expanded")]);
      expect(animator.hasActive()).toBe(false); // no window opened
      advance(400);
      expect(engine.dispatched.length).toBe(0);
    });

    test("reduced motion snaps pose switches and fires nothing", () => {
      const { renderer, engine, advance, animator } = createHarness();
      animator.reducedMotionOverride = true;
      mountRoot(renderer);
      renderer.applyPatches([
        create("card", "column", statesNodeProps),
        insert("root", "card"),
      ]);
      renderer.applyPatches([statesLabel("expanded")]);
      advance(400);
      expect(engine.dispatched.length).toBe(0);
    });

    test("a remove during the settle window fires nothing for the states transition", () => {
      const { renderer, engine, advance } = createHarness();
      mountRoot(renderer);
      renderer.applyPatches([
        create("card", "column", statesNodeProps),
        insert("root", "card"),
      ]);
      renderer.applyPatches([statesLabel("expanded")]);
      renderer.applyPatches([remove("card")]);

      advance(400);
      expect(engine.dispatched.length).toBe(0);
    });

    test("wire-shape tolerance: `__anim.states` arriving as a Map still settles", () => {
      const { renderer, engine, advance } = createHarness();
      mountRoot(renderer);
      renderer.applyPatches([
        create("card", "column", statesNodeProps),
        insert("root", "card"),
      ]);
      renderer.applyPatches([
        setProp("card", "__anim.states", new Map<string, any>([["label", "expanded"]])),
      ]);

      advance(250);
      expect(engine.dispatched).toEqual([
        { name: "animDone", payload: { animation: "states", state: "expanded" } },
      ]);
    });

    test("a pose flip reconciled into a Router-detached (cached) subtree fires nothing", () => {
      const { renderer, engine, advance, animator } = createHarness();
      mountRoot(renderer);
      renderer.applyPatches([
        create("card", "column", statesNodeProps),
        insert("root", "card"),
      ]);

      // Route leaves: the engine detaches the subtree but deliberately keeps
      // reconciling it — SetProps for the off-screen card still arrive. A
      // detached node is never painted (ambient parity: "no writes, no dirty
      // rects"), so a pose switch there owes no completion and must not arm
      // the ticker.
      renderer.applyPatches([{ type: "detach", id: "card" } as any]);
      renderer.applyPatches([statesLabel("expanded")]);
      expect(animator.hasActive()).toBe(false); // no window opened

      advance(400);
      expect(engine.dispatched.length).toBe(0);
    });

    test("a detach during the settle window suppresses the pending completion", () => {
      const { renderer, engine, advance } = createHarness();
      mountRoot(renderer);
      renderer.applyPatches([
        create("card", "column", statesNodeProps),
        insert("root", "card"),
      ]);

      // Window opens while attached…
      renderer.applyPatches([statesLabel("expanded")]);
      advance(50);
      // …then the route leaves mid-window: the entry survives but must fire
      // nothing (re-checked at dispatch time in tick).
      renderer.applyPatches([{ type: "detach", id: "card" } as any]);

      advance(400);
      expect(engine.dispatched.length).toBe(0);
    });
  });

  test("`onAnimationComplete` never makes the node clickable or hit-test dispatchable", () => {
    const { renderer, canvas, engine, advance } = createHarness();
    mountRoot(renderer);
    renderer.applyPatches([
      create("toast", "column", {
        width: 100,
        height: 40,
        "__anim.enter": enterSpec,
        [DONE]: "@actions.animDone",
      }),
      insert("root", "toast"),
    ]);
    advance(250); // enter settles (one completion dispatch expected below)

    const node = renderer.getNode("toast")!;
    expect(node.clickable).toBe(false); // the event prop is not a pointer handler
    synthesizeClick(canvas, 10, 10); // hit-test click dispatches nothing extra
    expect(engine.dispatched).toEqual([
      { name: "animDone", payload: { animation: "enter" } },
    ]);
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

// ---------------------------------------------------------------------------
// Shared-element props (Option H) — canvas ignores them in v1
// ---------------------------------------------------------------------------

describe("canvas ignores shared-element props (Option H v1)", () => {
  test("__anim.sharedKey / __anim.shared no-op: no crash, no animation state", () => {
    const { renderer, animator } = createHarness();
    mountRoot(renderer);

    renderer.applyPatches([
      create("a", "column", {
        width: 100,
        height: 50,
        "__anim.sharedKey": "cover-42",
        "__anim.shared": { duration: 350, curve: "spring" },
      }),
      insert("root", "a"),
    ]);
    expect(animator.hasActive()).toBe(false);
    expect(renderer.getNode("a")!.props.width).toBe(100);

    // Live re-resolution and channel updates route through setAnimProp and
    // must fall through the channel switch untouched.
    renderer.applyPatches([setProp("a", "__anim.sharedKey", "cover-7")]);
    renderer.applyPatches([setProp("a", "__anim.shared", { duration: 200, curve: "linear" })]);
    renderer.applyPatches([removeProp("a", "__anim.sharedKey")]);
    renderer.applyPatches([removeProp("a", "__anim.shared")]);
    expect(animator.hasActive()).toBe(false);

    // The node keeps behaving like a plain node (removal included).
    renderer.applyPatches([remove("a")]);
    expect(renderer.getNode("a")).toBeUndefined();
    expect(animator.hasActive()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// batchAnimation transaction stamps (Option D)
// ---------------------------------------------------------------------------

const batchAnim = (spec: any): Patch => ({ type: "batchAnimation", spec }) as any;

describe("canvas batchAnimation transaction stamps", () => {
  test("a stamped batch interpolates whitelisted props on a node WITHOUT __anim.transition", () => {
    const { renderer, animator, advance } = createHarness();
    mountRoot(renderer);
    renderer.applyPatches([create("a", "column", { width: 100 }), insert("root", "a")]);
    const node = renderer.getNode("a")!;

    renderer.applyPatches([
      batchAnim({ curve: "linear", duration: 200 }),
      setProp("a", "width", 200),
    ]);

    // Rewound to the previous value; the transaction spec drives the glide.
    expect(node.props.width).toBe(100);
    expect(animator.hasActive()).toBe(true);

    advance(100); // t = 0.5, linear
    expect(node.props.width).toBeCloseTo(150, 5);
    advance(100);
    expect(node.props.width).toBe(200);
    expect(animator.hasActive()).toBe(false);
  });

  test("the transaction spec OVERRIDES a node's own .transition for the batch", () => {
    const { renderer, advance } = createHarness();
    mountRoot(renderer);
    renderer.applyPatches([
      create("b", "column", { width: 100, "__anim.transition": { duration: 100, curve: "linear" } }),
      insert("root", "b"),
    ]);
    const node = renderer.getNode("b")!;

    renderer.applyPatches([
      batchAnim({ curve: "linear", duration: 400 }),
      setProp("b", "width", 200),
    ]);

    // With the node's own 100ms spec this would have settled by now; the
    // 400ms transaction spec is still mid-flight at t = 0.25.
    advance(100);
    expect(node.props.width).toBeCloseTo(125, 5);
    advance(300);
    expect(node.props.width).toBe(200);
  });

  test("the spec never outlives its batch — the next unstamped batch snaps a spec-less node", () => {
    const { renderer, animator } = createHarness();
    mountRoot(renderer);
    renderer.applyPatches([create("c", "column", { width: 100 }), insert("root", "c")]);

    // A stamped batch with no whitelisted SetProps: the spec must be dropped
    // at flush, not carried into the next batch.
    renderer.applyPatches([batchAnim({ curve: "linear", duration: 200 })]);

    renderer.applyPatches([setProp("c", "width", 300)]);
    expect(renderer.getNode("c")!.props.width).toBe(300); // snap
    expect(animator.hasActive()).toBe(false);
  });

  test("after a stamped batch settles, later unstamped changes on the same node snap again", () => {
    const { renderer, animator, advance } = createHarness();
    mountRoot(renderer);
    renderer.applyPatches([create("d", "column", { width: 100 }), insert("root", "d")]);
    const node = renderer.getNode("d")!;

    renderer.applyPatches([
      batchAnim({ curve: "linear", duration: 200 }),
      setProp("d", "width", 200),
    ]);
    advance(200);
    expect(node.props.width).toBe(200);

    renderer.applyPatches([setProp("d", "width", 400)]);
    expect(node.props.width).toBe(400); // no spec of its own → snap
    expect(animator.hasActive()).toBe(false);
  });

  test("reduced motion ignores stamps entirely (snap)", () => {
    const { renderer, animator } = createHarness();
    animator.reducedMotionOverride = true;
    mountRoot(renderer);
    renderer.applyPatches([create("e", "column", { width: 100 }), insert("root", "e")]);

    renderer.applyPatches([
      batchAnim({ curve: "linear", duration: 200 }),
      setProp("e", "width", 200),
    ]);
    expect(renderer.getNode("e")!.props.width).toBe(200);
    expect(animator.hasActive()).toBe(false);
  });

  test("a malformed spec degrades to an unstamped batch (snap)", () => {
    const { renderer, animator } = createHarness();
    mountRoot(renderer);
    renderer.applyPatches([create("f", "column", { width: 100 }), insert("root", "f")]);

    renderer.applyPatches([
      batchAnim({ curve: "not-a-curve" }),
      setProp("f", "width", 200),
    ]);
    expect(renderer.getNode("f")!.props.width).toBe(200);
    expect(animator.hasActive()).toBe(false);
  });

  test("a mid-array batchAnimation is NOT a stamp (first-patch contract): later SetProps snap", () => {
    const { renderer, animator } = createHarness();
    mountRoot(renderer);
    renderer.applyPatches([create("g", "column", { width: 100 }), insert("root", "g")]);

    renderer.applyPatches([
      setProp("g", "height", 50),
      batchAnim({ curve: "linear", duration: 200 }),
      setProp("g", "width", 200), // AFTER the buried patch — still snaps
    ]);
    expect(renderer.getNode("g")!.props.width).toBe(200);
    expect(animator.hasActive()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Same-batch create + SetProp: the enter owns a freshly-created node
// ---------------------------------------------------------------------------

describe("canvas same-batch create + SetProp", () => {
  test("a same-batch SetProp on an enter-driven prop lands the engine's value (enter settle target uncorrupted)", () => {
    const { renderer, advance } = createHarness();
    mountRoot(renderer);

    renderer.applyPatches([
      create("n", "column", {
        opacity: 0.4,
        "__anim.enter": { presets: ["fade"], duration: 100, curve: "linear" },
        "__anim.transition": { duration: 200, curve: "linear" },
      }),
      insert("root", "n"),
      // Same batch as the create: must NOT start a `.transition` glide — the
      // rewind-to-previous write would poison the enter's base/restore.
      setProp("n", "opacity", 0.9),
    ]);
    const node = renderer.getNode("n")!;

    // The enter's hidden pose is showing after flush (not a rewound 0.4).
    expect(node.props.opacity).toBe(0);

    advance(50); // mid-enter: fading toward the ENGINE's value
    expect(node.props.opacity as number).toBeCloseTo(0.45, 5);

    advance(60); // settle: enter restores the engine's 0.9, not the stale 0.4
    expect(node.props.opacity).toBe(0.9);
  });

  test("a stamped same-batch SetProp on a freshly-created node snaps (DOM parity: nothing to glide from pre-paint)", () => {
    const { renderer, animator } = createHarness();
    mountRoot(renderer);

    renderer.applyPatches([
      batchAnim({ curve: "linear", duration: 200 }),
      create("m", "column", { width: 100 }),
      insert("root", "m"),
      setProp("m", "width", 250),
    ]);
    expect(renderer.getNode("m")!.props.width).toBe(250);
    expect(animator.hasActive()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scrub channels (Option G) — canvas ignores all four props in v1
// ---------------------------------------------------------------------------

describe("canvas scrub channels (Option G, v1 no-op)", () => {
  test("all four __anim.scrub* props are ignored: no playback, no listener, no engine traffic", () => {
    const { renderer, animator, engine, advance } = createHarness();
    mountRoot(renderer);

    const scrubProps = {
      "__anim.scrub": {
        from: "closed",
        to: "open",
        source: "gesture",
        axis: "y",
        over: [0, 400],
        rubberBand: 0.4,
      },
      "__anim.scrubSettle": { curve: "spring", duration: 300 },
      "__anim.scrubBind": "sheetPhase",
      "__anim.scrubPoses": { "translateY.0": [400, 0] },
    };

    renderer.applyPatches([
      create("sheet", "column", { width: 100, height: 50, ...scrubProps }),
      insert("root", "sheet"),
    ]);
    expect(animator.hasActive()).toBe(false);

    // Live channel updates and removals are equally inert.
    renderer.applyPatches([
      setProp("sheet", "__anim.scrub", { ...scrubProps["__anim.scrub"], over: [0, 200] }),
      removeProp("sheet", "__anim.scrubPoses"),
    ]);
    advance(50);
    expect(animator.hasActive()).toBe(false);
    expect(engine.dispatched.length).toBe(0);

    // The node itself renders and lays out normally.
    const node = renderer.getNode("sheet")!;
    expect(node.props.width).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// `.motion(essential)` reduced-motion opt-out (#149)
// ---------------------------------------------------------------------------

describe("canvas `.motion(essential)` reduced-motion opt-out (#149)", () => {
  const ESSENTIAL = { "__anim.motion": { essential: true } };

  test("essential transition glides under reduced motion; non-essential snaps", () => {
    const { renderer, animator, advance } = createHarness();
    animator.reducedMotionOverride = true;
    mountRoot(renderer);
    renderer.applyPatches([
      create("e", "column", { width: 100, "__anim.transition": LINEAR_TRANSITION, ...ESSENTIAL }),
      create("p", "column", { width: 100, "__anim.transition": LINEAR_TRANSITION }),
      insert("root", "e"),
      insert("root", "p"),
    ]);

    renderer.applyPatches([setProp("e", "width", 200), setProp("p", "width", 200)]);
    // Essential: interpolating. Non-essential: already snapped to the target.
    expect(renderer.getNode("p")!.props.width).toBe(200);
    expect(renderer.getNode("e")!.props.width).toBe(100);
    expect(animator.hasActive()).toBe(true);

    advance(100);
    expect(renderer.getNode("e")!.props.width).toBeCloseTo(150, 5);
    advance(100);
    expect(renderer.getNode("e")!.props.width).toBe(200);
    expect(animator.hasActive()).toBe(false);
  });

  test("essential enter plays under reduced motion; non-essential skips", () => {
    const { renderer, animator, advance } = createHarness();
    animator.reducedMotionOverride = true;
    mountRoot(renderer);
    renderer.applyPatches([
      create("e", "column", {
        "__anim.enter": { presets: ["fade"], duration: 200, curve: "linear" },
        ...ESSENTIAL,
      }),
      create("p", "column", {
        "__anim.enter": { presets: ["fade"], duration: 200, curve: "linear" },
      }),
      insert("root", "e"),
      insert("root", "p"),
    ]);
    // Essential: hidden pose landed, enter in flight. Non-essential: skipped.
    expect(renderer.getNode("e")!.props.opacity).toBe(0);
    expect(renderer.getNode("p")!.props.opacity).toBeUndefined();

    advance(100);
    expect(renderer.getNode("e")!.props.opacity).toBeCloseTo(0.5, 5);
    advance(100);
    expect(renderer.getNode("e")!.props.opacity).toBeUndefined(); // original restored
    expect(animator.hasActive()).toBe(false);
  });

  test("essential exit defers under reduced motion; non-essential tears down synchronously", () => {
    const { renderer, animator, advance } = createHarness();
    animator.reducedMotionOverride = true;
    mountRoot(renderer);
    renderer.applyPatches([
      create("e", "column", {
        "__anim.exit": { presets: ["fade"], duration: 200, curve: "linear" },
        ...ESSENTIAL,
      }),
      create("p", "column", {
        "__anim.exit": { presets: ["fade"], duration: 200, curve: "linear" },
      }),
      insert("root", "e"),
      insert("root", "p"),
    ]);

    renderer.applyPatches([remove("p", true)]);
    expect(renderer.getNode("p")).toBeUndefined(); // snap: immediate teardown

    renderer.applyPatches([remove("e", true)]);
    const node = renderer.getNode("e")!;
    expect(node.exiting).toBe(true); // deferred: exit playback owns teardown
    advance(100);
    expect(node.props.opacity).toBeCloseTo(0.5, 5);
    advance(150); // past settle
    expect(renderer.getNode("e")).toBeUndefined();
    expect(animator.hasActive()).toBe(false);
  });

  test("essential `.animate` preset runs under reduced motion; non-essential never starts", () => {
    const { renderer, animator, advance } = createHarness();
    animator.reducedMotionOverride = true;
    mountRoot(renderer);
    renderer.applyPatches([
      create("e", "column", {
        "__anim.animate": { preset: "pulse", duration: 1000, repeat: "loop", curve: "linear" },
        ...ESSENTIAL,
      }),
      create("p", "column", {
        "__anim.animate": { preset: "pulse", duration: 1000, repeat: "loop", curve: "linear" },
      }),
      insert("root", "e"),
      insert("root", "p"),
    ]);
    expect(animator.hasActive()).toBe(true); // the essential ambient ticks

    advance(500); // mid-iteration: opacity dipped
    expect(renderer.getNode("e")!.props.opacity).toBeCloseTo(0.5, 5);
    expect(renderer.getNode("p")!.props.opacity).toBeUndefined();
  });

  test("transaction stamps glide essential nodes under reduced motion; others snap", () => {
    const { renderer, animator, advance } = createHarness();
    animator.reducedMotionOverride = true;
    mountRoot(renderer);
    renderer.applyPatches([
      create("e", "column", { width: 100, ...ESSENTIAL }),
      create("p", "column", { width: 100 }),
      insert("root", "e"),
      insert("root", "p"),
    ]);

    renderer.applyPatches([
      { type: "batchAnimation", spec: { curve: "linear", duration: 200 } } as any,
      setProp("e", "width", 200),
      setProp("p", "width", 200),
    ]);
    expect(renderer.getNode("p")!.props.width).toBe(200); // snap
    expect(renderer.getNode("e")!.props.width).toBe(100); // gliding
    advance(100);
    expect(renderer.getNode("e")!.props.width).toBeCloseTo(150, 5);
    advance(100);
    expect(renderer.getNode("e")!.props.width).toBe(200);
  });

  test("flag removal under reduced motion snaps the node's in-flight work (reverts)", () => {
    const { renderer, animator, advance } = createHarness();
    animator.reducedMotionOverride = true;
    mountRoot(renderer);
    renderer.applyPatches([
      create("e", "column", {
        width: 100,
        "__anim.transition": LINEAR_TRANSITION,
        "__anim.animate": { preset: "pulse", duration: 1000, repeat: "loop", curve: "linear" },
        ...ESSENTIAL,
      }),
      insert("root", "e"),
    ]);
    renderer.applyPatches([setProp("e", "width", 200)]);
    advance(100);
    const node = renderer.getNode("e")!;
    expect(node.props.width).toBeCloseTo(150, 5);
    expect(animator.hasActive()).toBe(true);

    // Un-stamping the flag re-applies reduced motion to the node NOW: the
    // glide lands its target, the ambient stops and restores (DOM parity
    // with the stylesheet kill re-applying on attribute removal).
    renderer.applyPatches([removeProp("e", "__anim.motion")]);
    expect(node.props.width).toBe(200);
    expect(node.props.opacity).toBeUndefined(); // ambient restored
    expect(animator.hasActive()).toBe(false);

    // And later work snaps like any non-essential node.
    renderer.applyPatches([setProp("e", "width", 300)]);
    expect(node.props.width).toBe(300);
    expect(animator.hasActive()).toBe(false);
  });

  test("`.states` settle fires the completion for essential nodes under reduced motion", () => {
    const { renderer, animator, engine, advance } = createHarness();
    animator.reducedMotionOverride = true;
    mountRoot(renderer);
    renderer.applyPatches([
      create("card", "column", {
        "__anim.transition": { duration: 100, curve: "linear" },
        "__anim.states": { label: "collapsed" },
        onAnimationComplete: "@actions.animDone",
        ...ESSENTIAL,
      }),
      insert("root", "card"),
    ]);
    renderer.applyPatches([setProp("card", "__anim.states", { label: "expanded" })]);
    advance(150);
    expect(engine.dispatched).toEqual([
      { name: "animDone", payload: { animation: "states", state: "expanded" } },
    ]);
  });
});
