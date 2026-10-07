import { semanticAction } from "./helpers";
/**
 * DOM scrub-binding runtime (Option G — `__anim.scrub*` channel consumption).
 *
 * Drives the renderer with raw Patch arrays over fake-dom + StubEngine (the
 * dom.renderer.anim.test.ts pattern). Pointer and scroll events go through
 * fake-dom's `dispatchEvent`; the drag/settle clock and rAF are injected via
 * the scrubber's public `now`/`raf`/`caf` fields (the canvas animator's
 * deterministic-clock pattern), so drags, velocity projection, and settle
 * frames are fully deterministic. The cleanup-timeout and scroll-rest
 * debounce run on real (short) timers.
 */
import { describe, expect, test } from "bun:test";
import { DOMRenderer } from "../packages/web/src/dom/renderer";
import { configureLogger, getLogLevel, setLogLevel } from "../packages/core/src/logger";
import type { Patch } from "../packages/core/src/types";
import type { IEngine as Engine } from "../packages/core/src/app";
import { ensureFakeDomGlobals, FakeElement } from "./fake-dom";

ensureFakeDomGlobals();

class StubEngine {
  public dispatchCalls: Array<{ name: string; payload: any }> = [];

  dispatchAction(name: string, payload: any): void {
    this.dispatchCalls.push(semanticAction(name, payload));
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const makeRenderer = () => {
  const container = document.createElement("div");
  const engine = new StubEngine();
  const renderer = new DOMRenderer(container, engine as unknown as Engine);
  return { container: container as unknown as FakeElement, engine, renderer };
};

/** Boot a renderer past its first batch with a root Column, and wire the
 *  scrubber's injectable clock/rAF for deterministic settles. */
const makeScrubHarness = () => {
  const made = makeRenderer();
  made.renderer.applyPatches([
    { type: "create", id: "root-1", elementType: "Column", props: {} } as Patch,
    { type: "insert", parentId: "root", id: "root-1" } as Patch,
  ]);
  const scrubber = made.renderer.getScrubber();
  let now = 0;
  const frames: Array<() => void> = [];
  scrubber.now = () => now;
  scrubber.raf = (cb: () => void) => {
    frames.push(cb);
    return frames.length;
  };
  scrubber.caf = () => {};
  /** Advance the clock and run the currently queued settle frames. */
  const advance = (ms: number) => {
    now += ms;
    const pending = frames.splice(0, frames.length);
    for (const cb of pending) cb();
  };
  const setTime = (ms: number) => {
    now = ms;
  };
  return { ...made, scrubber, advance, setTime, frames };
};

/** A bottom-sheet gesture scrub over the closed/open poses. */
const gestureProps = (over: [number, number] = [0, 400]) => ({
  "translateY.0": 400,
  "__anim.scrub": {
    from: "closed",
    to: "open",
    source: "gesture",
    axis: "y",
    over,
    rubberBand: 0.4,
  },
  "__anim.scrubSettle": { curve: "linear", duration: 100 },
  "__anim.scrubBind": "sheetPhase",
  "__anim.scrubPoses": {
    "translateY.0": [400, 0],
    "opacity.0": [0.5, 1],
    "backgroundColor.0": ["#000000", "#ffffff"],
  },
  "__anim.states": { label: "closed" },
});

const mountSheet = (
  renderer: DOMRenderer,
  props: Record<string, unknown> = gestureProps()
): FakeElement => {
  renderer.applyPatches([
    { type: "create", id: "sheet", elementType: "Column", props } as Patch,
    { type: "insert", parentId: "root-1", id: "sheet" } as Patch,
  ]);
  return renderer.getNode("sheet") as FakeElement;
};

const styleOf = (el: FakeElement, prop: string): string | undefined =>
  (el.style as unknown as Record<string, string | undefined>)[prop];

/** A collapsing-header scroll scrub over the expanded/collapsed poses. */
const scrollHeaderProps = {
  "height.0": 120,
  "__anim.scrub": {
    from: "expanded",
    to: "collapsed",
    source: "scroll",
    axis: "y",
    over: [0, 120],
    rubberBand: 0.4,
  },
  "__anim.scrubSettle": { curve: "linear", duration: 100 },
  "__anim.scrubBind": "headerMode",
  "__anim.scrubPoses": { "height.0": [120, 48] },
  "__anim.states": { label: "expanded" },
};

/** Mount an overflow-auto scroller under the root with a scrubbed header inside. */
const mountHeaderScene = (
  renderer: DOMRenderer,
  props: Record<string, unknown> = scrollHeaderProps
) => {
  renderer.applyPatches([
    { type: "create", id: "scroller", elementType: "Column", props: {} } as Patch,
    { type: "insert", parentId: "root-1", id: "scroller" } as Patch,
  ]);
  const scroller = renderer.getNode("scroller") as FakeElement & { scrollTop?: number };
  (scroller.style as any).overflow = "auto";
  renderer.applyPatches([
    { type: "create", id: "header", elementType: "Column", props } as Patch,
    { type: "insert", parentId: "scroller", id: "header" } as Patch,
  ]);
  const header = renderer.getNode("header") as FakeElement;
  return { scroller, header };
};

/** Capture logger WARN output at the default ("info") level. */
const captureWarns = (run: (warns: string[]) => void) => {
  const warns: string[] = [];
  const previousLevel = getLogLevel();
  setLogLevel("info");
  configureLogger({
    handler: {
      debug: () => {},
      info: () => {},
      warn: (_tag: string, ...args: unknown[]) => {
        warns.push(args.map(String).join(" "));
      },
      error: () => {},
    },
  });
  try {
    run(warns);
  } finally {
    configureLogger({ handler: undefined });
    setLogLevel(previousLevel);
  }
};

const withReducedMotion = async (run: () => Promise<void> | void) => {
  (globalThis.window as any).matchMedia = (query: string) => ({
    matches: query.includes("prefers-reduced-motion"),
  });
  try {
    await run();
  } finally {
    delete (globalThis.window as any).matchMedia;
  }
};

describe("gesture drag interpolation", () => {
  test("pointer travel writes interpolated inline styles for every scrubbed key", () => {
    const { renderer } = makeScrubHarness();
    const sheet = mountSheet(renderer);
    // Create-time base: the static translateY applicator ran.
    expect(sheet.style.transform).toBe("translateY(400px)");

    sheet.dispatchEvent("pointerdown", { clientY: 100, pointerId: 1 });
    sheet.dispatchEvent("pointermove", { clientY: 200, pointerId: 1 }); // travel 100 → p 0.25

    expect(sheet.style.transform).toBe("translateY(300px)");
    expect(styleOf(sheet, "opacity")).toBe("0.625");
    // Core RGBA interpolation for color props: #000 → #fff at 0.25.
    expect(styleOf(sheet, "background-color")).toBe("rgba(64, 64, 64, 1)");

    sheet.dispatchEvent("pointermove", { clientY: 300, pointerId: 1 }); // p 0.5
    expect(sheet.style.transform).toBe("translateY(200px)");
    expect(styleOf(sheet, "opacity")).toBe("0.75");
    expect(styleOf(sheet, "background-color")).toBe("rgba(128, 128, 128, 1)");
  });

  test("over is directed: [0, -400] maps upward travel onto forward progress", () => {
    const { renderer } = makeScrubHarness();
    const sheet = mountSheet(renderer, gestureProps([0, -400]));

    sheet.dispatchEvent("pointerdown", { clientY: 500, pointerId: 1 });
    sheet.dispatchEvent("pointermove", { clientY: 300, pointerId: 1 }); // travel -200 → p 0.5
    expect(sheet.style.transform).toBe("translateY(200px)");

    sheet.dispatchEvent("pointermove", { clientY: 100, pointerId: 1 }); // travel -400 → p 1
    expect(sheet.style.transform).toBe("translateY(0px)");
    // …and travel in the WRONG direction is progress < 0 (rubber-banded).
    sheet.dispatchEvent("pointermove", { clientY: 600, pointerId: 1 }); // travel +100 → raw -0.25
    // p' = -0.25 * 0.4 = -0.1 → translateY = 400 + (0-400)·(-0.1) = 440.
    expect(sheet.style.transform).toBe("translateY(440px)");
  });

  test("beyond the range the rubber band resists: p' = bound + (p - bound) · rubberBand", () => {
    const { renderer } = makeScrubHarness();
    const sheet = mountSheet(renderer);

    sheet.dispatchEvent("pointerdown", { clientY: 0, pointerId: 1 });
    sheet.dispatchEvent("pointermove", { clientY: 500, pointerId: 1 }); // raw 1.25 → p' 1.1

    expect(sheet.style.transform).toBe("translateY(-40px)");
    // Clamped quantities clamp the RESULT of interpolation, not progress.
    expect(styleOf(sheet, "opacity")).toBe("1");
  });

  test("zero engine traffic during the drag", () => {
    const { renderer, engine } = makeScrubHarness();
    const sheet = mountSheet(renderer);
    sheet.dispatchEvent("pointerdown", { clientY: 0, pointerId: 1 });
    for (let y = 20; y <= 300; y += 20) {
      sheet.dispatchEvent("pointermove", { clientY: y, pointerId: 1 });
    }
    expect(engine.dispatchCalls.length).toBe(0);
  });
});

describe("velocity-projected settle + bind write", () => {
  test("a slow release below the midpoint settles back to the from pose and writes its label", () => {
    const { renderer, engine, advance, setTime } = makeScrubHarness();
    const sheet = mountSheet(renderer);

    setTime(0);
    sheet.dispatchEvent("pointerdown", { clientY: 0, pointerId: 1 });
    // Rest at p = 0.3 long enough that the 5-sample window shows zero
    // velocity (the down-sample slides out of the window).
    for (let i = 1; i <= 5; i++) {
      setTime(i * 10);
      sheet.dispatchEvent("pointermove", { clientY: 120, pointerId: 1 });
    }
    sheet.dispatchEvent("pointerup", { pointerId: 1 });
    expect(engine.dispatchCalls.length).toBe(0); // settling, not yet arrived

    advance(100); // full settle duration
    expect(sheet.style.transform).toBe("translateY(400px)");
    expect(engine.dispatchCalls).toEqual([
      { name: "__hypen_bind", payload: { path: "sheetPhase", value: "closed" } },
    ]);
  });

  test("a fast flick at p 0.3 projects to the FAR endpoint and animates with the settle curve", () => {
    const { renderer, engine, advance, setTime } = makeScrubHarness();
    const sheet = mountSheet(renderer);

    setTime(0);
    sheet.dispatchEvent("pointerdown", { clientY: 0, pointerId: 1 });
    setTime(10);
    sheet.dispatchEvent("pointermove", { clientY: 120, pointerId: 1 }); // p 0.3 in 10ms
    sheet.dispatchEvent("pointerup", { pointerId: 1 });
    // v = 0.03 progress/ms → p* = 0.3 + 0.03·150 = 4.8 → target: open (1).

    advance(50); // linear settle, halfway: p = 0.3 + 0.7·0.5 = 0.65
    expect(sheet.style.transform).toBe("translateY(140px)");
    expect(engine.dispatchCalls.length).toBe(0); // no write before arrival

    advance(50); // arrival
    expect(sheet.style.transform).toBe("translateY(0px)");
    expect(styleOf(sheet, "opacity")).toBe("1");
    expect(engine.dispatchCalls).toEqual([
      { name: "__hypen_bind", payload: { path: "sheetPhase", value: "open" } },
    ]);
  });
});

describe("post-settle cleanup (no-flash contract)", () => {
  const settleToOpen = (harness: ReturnType<typeof makeScrubHarness>, sheet: FakeElement) => {
    harness.setTime(0);
    sheet.dispatchEvent("pointerdown", { clientY: 0, pointerId: 1 });
    harness.setTime(10);
    sheet.dispatchEvent("pointermove", { clientY: 120, pointerId: 1 });
    sheet.dispatchEvent("pointerup", { pointerId: 1 });
    harness.advance(100);
  };

  test("the first batch whose __anim.states label matches clears scrub styles and applies deferred writes", () => {
    const harness = makeScrubHarness();
    const { renderer } = harness;
    const sheet = mountSheet(renderer);
    settleToOpen(harness, sheet);
    expect(sheet.style.transform).toBe("translateY(0px)"); // held — no flash

    // The engine's re-render: pose SetProps (deferred — scrub still owns
    // the node) followed by the states label matching the winning pose.
    renderer.applyPatches([
      { type: "setProp", id: "sheet", name: "translateY.0", value: 0 } as Patch,
      { type: "setProp", id: "sheet", name: "opacity.0", value: 1 } as Patch,
      { type: "setProp", id: "sheet", name: "__anim.states", value: { label: "open" } } as Patch,
    ]);

    // Cleanup ran: scrub-inline styles cleared, deferred engine writes
    // applied through the normal applicator path.
    expect(sheet.style.transform).toBe("translateY(0px)"); // fresh applicator write
    expect(styleOf(sheet, "opacity")).toBe("1"); // engine's own opacity write
    expect(styleOf(sheet, "background-color")).toBeUndefined(); // scrub inline removed
    expect(renderer.getScrubber().ownsNode("sheet")).toBe(false);
  });

  test("ANY states label during awaitingCleanup proves the re-render landed and cleans up", () => {
    // Contract (deliberate): a label SetProp — matching the settle's winning
    // label or NOT — is the engine re-render landing. A raced different
    // label must not hold stale visuals for the timeout window and then
    // snap.
    const harness = makeScrubHarness();
    const { renderer } = harness;
    const sheet = mountSheet(renderer);
    settleToOpen(harness, sheet);
    expect(sheet.style.transform).toBe("translateY(0px)"); // held — no flash

    renderer.applyPatches([
      { type: "setProp", id: "sheet", name: "__anim.states", value: { label: "peek" } } as Patch,
    ]);
    // Cleanup ran immediately on the non-matching label: base restored,
    // inline extras cleared, ownership released.
    expect(sheet.style.transform).toBe("translateY(400px)");
    expect(styleOf(sheet, "opacity")).toBeUndefined();
    expect(renderer.getScrubber().ownsNode("sheet")).toBe(false);
  });

  test("with no states feed at all, the ~500ms timeout fallback cleans up", async () => {
    const harness = makeScrubHarness();
    const { renderer } = harness;
    harness.scrubber.cleanupTimeoutMs = 30;
    const sheet = mountSheet(renderer);
    settleToOpen(harness, sheet);
    expect(sheet.style.transform).toBe("translateY(0px)"); // still held

    await sleep(60);
    // Timeout fallback: no deferred transform write arrived, so the
    // captured base transform is restored and the inline extras cleared.
    expect(sheet.style.transform).toBe("translateY(400px)");
    expect(styleOf(sheet, "opacity")).toBeUndefined();
    expect(renderer.getScrubber().ownsNode("sheet")).toBe(false);
  });
});

describe("engine-write conflicts (gesture wins)", () => {
  test("mid-drag SetProps to scrubbed keys are deferred (latest value), others flow; deferral applies at cleanup", async () => {
    const harness = makeScrubHarness();
    const { renderer } = harness;
    harness.scrubber.cleanupTimeoutMs = 20;
    const sheet = mountSheet(renderer);

    harness.setTime(0);
    sheet.dispatchEvent("pointerdown", { clientY: 0, pointerId: 1 });
    sheet.dispatchEvent("pointermove", { clientY: 200, pointerId: 1 }); // p 0.5
    expect(sheet.style.transform).toBe("translateY(200px)");

    renderer.applyPatches([
      { type: "setProp", id: "sheet", name: "translateY.0", value: 123 } as Patch, // scrubbed → deferred
      { type: "setProp", id: "sheet", name: "translateY.0", value: 77 } as Patch, // latest wins
      { type: "setProp", id: "sheet", name: "width.0", value: 55 } as Patch, // not scrubbed → flows
    ]);
    expect(sheet.style.transform).toBe("translateY(200px)"); // drag still owns it
    expect(styleOf(sheet, "width")).toBe("55px");

    // Release at rest (zero velocity samples at p 0.5 → projects to open).
    for (let i = 1; i <= 5; i++) {
      harness.setTime(i * 10);
      sheet.dispatchEvent("pointermove", { clientY: 200, pointerId: 1 });
    }
    sheet.dispatchEvent("pointerup", { pointerId: 1 });
    harness.advance(100);

    await sleep(40); // timeout-fallback cleanup applies the deferred write
    expect(sheet.style.transform).toBe("translateY(77px)");
  });

  test("a scrub-active node is excluded from transaction application (scrub > transaction)", () => {
    const harness = makeScrubHarness();
    const { renderer } = harness;
    const sheet = mountSheet(renderer);
    renderer.applyPatches([
      { type: "create", id: "other", elementType: "Text", props: {} } as Patch,
      { type: "insert", parentId: "root-1", id: "other" } as Patch,
    ]);
    const other = renderer.getNode("other") as FakeElement;

    sheet.dispatchEvent("pointerdown", { clientY: 0, pointerId: 1 });
    sheet.dispatchEvent("pointermove", { clientY: 100, pointerId: 1 });

    renderer.applyPatches([
      { type: "batchAnimation", spec: { curve: "linear", duration: 120 } } as Patch,
      { type: "setProp", id: "sheet", name: "width.0", value: 55 } as Patch,
      { type: "setProp", id: "other", name: "width.0", value: 55 } as Patch,
    ]);

    // The stamped batch glides the untouched node…
    expect(other.style.transitionProperty).toBe("width");
    // …but never retargets the scrub-active node's styles.
    expect(sheet.style.transitionProperty).toBeUndefined();
  });
});

describe("scroll source", () => {
  const scrollProps = {
    "height.0": 120,
    "__anim.scrub": {
      from: "expanded",
      to: "collapsed",
      source: "scroll",
      axis: "y",
      over: [0, 120],
      rubberBand: 0.4,
    },
    "__anim.scrubSettle": { curve: "linear", duration: 100 },
    "__anim.scrubBind": "headerMode",
    "__anim.scrubPoses": { "height.0": [120, 48] },
    "__anim.states": { label: "expanded" },
  };

  const mountScrollScene = (renderer: DOMRenderer) => {
    renderer.applyPatches([
      { type: "create", id: "scroller", elementType: "Column", props: {} } as Patch,
      { type: "insert", parentId: "root-1", id: "scroller" } as Patch,
    ]);
    const scroller = renderer.getNode("scroller") as FakeElement & { scrollTop?: number };
    (scroller.style as any).overflow = "auto";
    renderer.applyPatches([
      { type: "create", id: "header", elementType: "Column", props: scrollProps } as Patch,
      { type: "insert", parentId: "scroller", id: "header" } as Patch,
    ]);
    const header = renderer.getNode("header") as FakeElement;
    return { scroller, header };
  };

  test("scrollTop maps through over identically; the bind write fires only after resting at an endpoint", async () => {
    const harness = makeScrubHarness();
    const { renderer, engine } = harness;
    harness.scrubber.restDebounceMs = 20;
    const { scroller, header } = mountScrollScene(renderer);

    scroller.scrollTop = 60;
    scroller.dispatchEvent("scroll", {});
    expect(styleOf(header, "height")).toBe("84px"); // p 0.5

    scroller.scrollTop = 120;
    scroller.dispatchEvent("scroll", {});
    expect(styleOf(header, "height")).toBe("48px"); // p 1
    expect(engine.dispatchCalls.length).toBe(0); // not yet rested

    await sleep(40); // rest at p == 1 → debounced write
    expect(engine.dispatchCalls).toEqual([
      { name: "__hypen_bind", payload: { path: "headerMode", value: "collapsed" } },
    ]);
  });

  test("leaving the endpoint before the debounce expires cancels the write", async () => {
    const harness = makeScrubHarness();
    const { renderer, engine } = harness;
    harness.scrubber.restDebounceMs = 25;
    const { scroller } = mountScrollScene(renderer);

    scroller.scrollTop = 120;
    scroller.dispatchEvent("scroll", {});
    scroller.scrollTop = 60; // bounce back inside before the debounce fires
    scroller.dispatchEvent("scroll", {});

    await sleep(50);
    expect(engine.dispatchCalls.length).toBe(0);
  });

  test("of: matches the ancestor whose resolved id prop equals the string, without warning", () => {
    captureWarns((warns) => {
    const harness = makeScrubHarness();
    const { renderer } = harness;
    renderer.applyPatches([
      { type: "create", id: "outer", elementType: "Column", props: {} } as Patch,
      { type: "insert", parentId: "root-1", id: "outer" } as Patch,
      { type: "create", id: "inner", elementType: "Column", props: {} } as Patch,
      { type: "insert", parentId: "outer", id: "inner" } as Patch,
    ]);
    const outer = renderer.getNode("outer") as FakeElement & { scrollTop?: number };
    const inner = renderer.getNode("inner") as FakeElement & { scrollTop?: number };
    outer.setAttribute("id", "lister");
    (inner.style as any).overflow = "auto"; // nearest scrollable — must NOT win over of:

    renderer.applyPatches([
      {
        type: "create",
        id: "header",
        elementType: "Column",
        props: {
          ...scrollProps,
          "__anim.scrub": { ...scrollProps["__anim.scrub"], of: "lister" },
        },
      } as Patch,
      { type: "insert", parentId: "inner", id: "header" } as Patch,
    ]);
    const header = renderer.getNode("header") as FakeElement;

    outer.scrollTop = 60;
    outer.dispatchEvent("scroll", {});
    expect(styleOf(header, "height")).toBe("84px");

    // The nearest-scrollable inner is not the listener target.
    inner.scrollTop = 120;
    inner.dispatchEvent("scroll", {});
    expect(styleOf(header, "height")).toBe("84px");

    // A matched of: never warns.
    expect(warns.length).toBe(0);
    });
  });

  test("an of: matching nothing warns once and falls back to the nearest scrollable ancestor", () => {
    captureWarns((warns) => {
      const harness = makeScrubHarness();
      const { renderer } = harness;
      const { scroller, header } = (() => {
        renderer.applyPatches([
          { type: "create", id: "scroller", elementType: "Column", props: {} } as Patch,
          { type: "insert", parentId: "root-1", id: "scroller" } as Patch,
        ]);
        const scroller = renderer.getNode("scroller") as FakeElement & { scrollTop?: number };
        (scroller.style as any).overflow = "auto";
        renderer.applyPatches([
          {
            type: "create",
            id: "header",
            elementType: "Column",
            props: {
              ...scrollProps,
              "__anim.scrub": { ...scrollProps["__anim.scrub"], of: "nope" },
            },
          } as Patch,
          { type: "insert", parentId: "scroller", id: "header" } as Patch,
        ]);
        return { scroller, header: renderer.getNode("header") as FakeElement };
      })();

      expect(warns.filter((w) => w.includes('"nope"')).length).toBe(1);

      // Fallback container works.
      scroller.scrollTop = 60;
      scroller.dispatchEvent("scroll", {});
      expect(styleOf(header, "height")).toBe("84px");

      // A re-insert re-resolves without warning again.
      renderer.applyPatches([
        { type: "move", parentId: "scroller", id: "header" } as Patch,
      ]);
      expect(warns.filter((w) => w.includes('"nope"')).length).toBe(1);
    });
  });
});

describe("reduced motion", () => {
  test("dragging works unchanged; release settles instantly and still writes", async () => {
    await withReducedMotion(() => {
      const harness = makeScrubHarness();
      const { renderer, engine, frames } = harness;
      const sheet = mountSheet(renderer);

      // Direct manipulation is exempt — the drag tracks the finger.
      sheet.dispatchEvent("pointerdown", { clientY: 0, pointerId: 1 });
      sheet.dispatchEvent("pointermove", { clientY: 200, pointerId: 1 });
      expect(sheet.style.transform).toBe("translateY(200px)");

      // Release: NO animation frames — instant settle at the target, then
      // the write (p 0.5 projects to open).
      sheet.dispatchEvent("pointerup", { pointerId: 1 });
      expect(frames.length).toBe(0);
      expect(sheet.style.transform).toBe("translateY(0px)");
      expect(engine.dispatchCalls).toEqual([
        { name: "__hypen_bind", payload: { path: "sheetPhase", value: "open" } },
      ]);
    });
  });

  test("a `.motion(essential)` node's release settle animates normally (#149)", async () => {
    await withReducedMotion(() => {
      const harness = makeScrubHarness();
      const { renderer, engine, frames, advance } = harness;
      const sheet = mountSheet(renderer, {
        ...gestureProps(),
        "__anim.motion": { essential: true },
      });

      sheet.dispatchEvent("pointerdown", { clientY: 0, pointerId: 1 });
      sheet.dispatchEvent("pointermove", { clientY: 200, pointerId: 1 });
      expect(sheet.style.transform).toBe("translateY(200px)");

      // Release: the settle ANIMATES (frames queued) instead of snapping.
      sheet.dispatchEvent("pointerup", { pointerId: 1 });
      expect(frames.length).toBeGreaterThan(0);
      expect(engine.dispatchCalls.length).toBe(0); // not arrived yet

      advance(50); // mid-settle: between the drag pose and the target
      const mid = sheet.style.transform!;
      expect(mid).not.toBe("translateY(200px)");
      expect(mid).not.toBe("translateY(0px)");

      advance(100); // past the 100ms settle duration
      expect(sheet.style.transform).toBe("translateY(0px)");
      expect(engine.dispatchCalls).toEqual([
        { name: "__hypen_bind", payload: { path: "sheetPhase", value: "open" } },
      ]);
    });
  });
});

describe("mid-drag teardown", () => {
  test("a remove mid-drag cancels everything and releases pointer capture cleanly", () => {
    const harness = makeScrubHarness();
    const { renderer } = harness;
    const sheet = mountSheet(renderer);
    const captured: number[] = [];
    const released: number[] = [];
    (sheet as any).setPointerCapture = (pointerId: number) => captured.push(pointerId);
    (sheet as any).releasePointerCapture = (pointerId: number) => released.push(pointerId);

    sheet.dispatchEvent("pointerdown", { clientY: 0, pointerId: 7 });
    sheet.dispatchEvent("pointermove", { clientY: 100, pointerId: 7 });
    expect(captured).toEqual([7]);

    renderer.applyPatches([{ type: "remove", id: "sheet" } as Patch]);
    expect(released).toEqual([7]);

    // Listener teardown: a stray move after removal is inert.
    const transform = sheet.style.transform;
    sheet.dispatchEvent("pointermove", { clientY: 300, pointerId: 7 });
    expect(sheet.style.transform).toBe(transform);
    expect(renderer.getScrubber().ownsNode("sheet")).toBe(false);
  });

  test("a detach mid-drag cancels the interaction and restores the node's styles", () => {
    const harness = makeScrubHarness();
    const { renderer } = harness;
    const sheet = mountSheet(renderer);
    const released: number[] = [];
    (sheet as any).setPointerCapture = () => {};
    (sheet as any).releasePointerCapture = (pointerId: number) => released.push(pointerId);

    sheet.dispatchEvent("pointerdown", { clientY: 0, pointerId: 3 });
    sheet.dispatchEvent("pointermove", { clientY: 100, pointerId: 3 });
    expect(sheet.style.transform).toBe("translateY(300px)");

    renderer.applyPatches([{ type: "detach", id: "sheet" } as Patch]);
    expect(released).toEqual([3]);
    expect(sheet.style.transform).toBe("translateY(400px)"); // base restored
    expect(renderer.getScrubber().ownsNode("sheet")).toBe(false);
  });
});

describe("relative drag anchoring", () => {
  test("a second drag after a settle anchors at the settled pose, not progress 0", () => {
    const harness = makeScrubHarness();
    const { renderer, engine } = harness;
    const sheet = mountSheet(renderer);

    // First interaction: flick open, engine re-render lands.
    harness.setTime(0);
    sheet.dispatchEvent("pointerdown", { clientY: 0, pointerId: 1 });
    harness.setTime(10);
    sheet.dispatchEvent("pointermove", { clientY: 120, pointerId: 1 });
    sheet.dispatchEvent("pointerup", { pointerId: 1 });
    harness.advance(100);
    renderer.applyPatches([
      { type: "setProp", id: "sheet", name: "__anim.states", value: { label: "open" } } as Patch,
    ]);
    expect(renderer.getScrubber().ownsNode("sheet")).toBe(false);

    // Second drag: grabbing the OPEN sheet must not snap it to closed —
    // the mapping is relative to the grabbed pose (p = 1 + travel/span).
    harness.setTime(200);
    sheet.dispatchEvent("pointerdown", { clientY: 400, pointerId: 2 });
    sheet.dispatchEvent("pointermove", { clientY: 350, pointerId: 2 }); // travel -50 → p 0.875
    expect(sheet.style.transform).toBe("translateY(50px)");

    // Release near the open pose settles back to open.
    sheet.dispatchEvent("pointerup", { pointerId: 2 });
    harness.advance(100);
    expect(engine.dispatchCalls[1]).toEqual({
      name: "__hypen_bind",
      payload: { path: "sheetPhase", value: "open" },
    });
  });

  test("a grab mid-settle catches the element at its live progress (no jump)", () => {
    const harness = makeScrubHarness();
    const { renderer, engine } = harness;
    const sheet = mountSheet(renderer);

    harness.setTime(0);
    sheet.dispatchEvent("pointerdown", { clientY: 0, pointerId: 1 });
    harness.setTime(10);
    sheet.dispatchEvent("pointermove", { clientY: 120, pointerId: 1 }); // flick → open
    sheet.dispatchEvent("pointerup", { pointerId: 1 });
    harness.advance(50); // linear settle halfway: p = 0.3 + 0.7·0.5 = 0.65
    expect(sheet.style.transform).toBe("translateY(140px)");

    // Catch: a SETTLING element claims immediately (no slop wait), stopping
    // the settle at its live progress.
    sheet.dispatchEvent("pointerdown", { clientY: 100, pointerId: 1 });
    harness.advance(100); // stray queued settle frames are inert
    expect(sheet.style.transform).toBe("translateY(140px)"); // held, no snap
    expect(engine.dispatchCalls.length).toBe(0); // the interrupted settle never wrote

    sheet.dispatchEvent("pointermove", { clientY: 60, pointerId: 1 }); // travel -40 → p 0.55
    expect(sheet.style.transform).toBe("translateY(180px)");
  });

  test("a node created in its to-pose drags from progress 1 (states-label seed)", () => {
    const { renderer } = makeScrubHarness();
    const sheet = mountSheet(renderer, {
      ...gestureProps(),
      "__anim.states": { label: "open" },
    });

    sheet.dispatchEvent("pointerdown", { clientY: 200, pointerId: 1 });
    sheet.dispatchEvent("pointermove", { clientY: 100, pointerId: 1 }); // travel -100 → p 0.75
    expect(sheet.style.transform).toBe("translateY(100px)");
  });

  test("an over range not starting at 0 does not jump at drag start", () => {
    const { renderer } = makeScrubHarness();
    const sheet = mountSheet(renderer, gestureProps([100, 500]));

    sheet.dispatchEvent("pointerdown", { clientY: 0, pointerId: 1 });
    sheet.dispatchEvent("pointermove", { clientY: 10, pointerId: 1 }); // travel 10 → p 10/400
    expect(sheet.style.transform).toBe("translateY(390px)");
  });
});

describe("tap slop (gesture claim)", () => {
  test("a below-slop tap is a total no-op: no capture, no styles, no settle, no write", () => {
    const harness = makeScrubHarness();
    const { renderer, engine } = harness;
    const sheet = mountSheet(renderer);
    const captured: number[] = [];
    (sheet as any).setPointerCapture = (pointerId: number) => captured.push(pointerId);

    sheet.dispatchEvent("pointerdown", { clientY: 100, pointerId: 1 });
    sheet.dispatchEvent("pointermove", { clientY: 103, pointerId: 1 }); // 3px < slop
    sheet.dispatchEvent("pointerup", { pointerId: 1 });

    expect(captured).toEqual([]); // pointer never captured — child clicks survive
    expect(engine.dispatchCalls.length).toBe(0);
    expect(sheet.style.transform).toBe("translateY(400px)");
    expect(renderer.getScrubber().ownsNode("sheet")).toBe(false);

    // The gesture source still works afterwards.
    sheet.dispatchEvent("pointerdown", { clientY: 100, pointerId: 1 });
    sheet.dispatchEvent("pointermove", { clientY: 150, pointerId: 1 });
    expect(sheet.style.transform).toBe("translateY(350px)");
  });

  test("travel past the slop claims the gesture: capture + scrub styles", () => {
    const harness = makeScrubHarness();
    const { renderer } = harness;
    const sheet = mountSheet(renderer);
    const captured: number[] = [];
    (sheet as any).setPointerCapture = (pointerId: number) => captured.push(pointerId);

    sheet.dispatchEvent("pointerdown", { clientY: 100, pointerId: 1 });
    sheet.dispatchEvent("pointermove", { clientY: 110, pointerId: 1 }); // 10px ≥ slop
    expect(captured).toEqual([1]);
    expect(sheet.style.transform).toBe("translateY(390px)");
    expect(renderer.getScrubber().ownsNode("sheet")).toBe(true);
  });
});

describe("multi-pointer noise", () => {
  test("a second finger's move and lift are ignored; the first finger keeps the drag", () => {
    const harness = makeScrubHarness();
    const { renderer, engine } = harness;
    const sheet = mountSheet(renderer);

    sheet.dispatchEvent("pointerdown", { clientY: 0, pointerId: 1 });
    sheet.dispatchEvent("pointermove", { clientY: 100, pointerId: 1 }); // p 0.25
    expect(sheet.style.transform).toBe("translateY(300px)");

    sheet.dispatchEvent("pointerdown", { clientY: 999, pointerId: 2 }); // one drag at a time
    sheet.dispatchEvent("pointermove", { clientY: 400, pointerId: 2 }); // travel noise ignored
    expect(sheet.style.transform).toBe("translateY(300px)");
    sheet.dispatchEvent("pointerup", { pointerId: 2 }); // second finger's lift: no settle
    expect(engine.dispatchCalls.length).toBe(0);

    sheet.dispatchEvent("pointermove", { clientY: 200, pointerId: 1 }); // drag continues
    expect(sheet.style.transform).toBe("translateY(200px)");
  });
});

describe("stale velocity", () => {
  test("drag, hold, release settles to the NEAREST endpoint (old burst discarded)", () => {
    const harness = makeScrubHarness();
    const { renderer, engine, advance, setTime } = harness;
    const sheet = mountSheet(renderer);

    setTime(0);
    sheet.dispatchEvent("pointerdown", { clientY: 0, pointerId: 1 });
    setTime(10);
    sheet.dispatchEvent("pointermove", { clientY: 120, pointerId: 1 }); // fast burst to p 0.3
    setTime(2000); // hold still for ~2s
    sheet.dispatchEvent("pointerup", { pointerId: 1 });
    // All samples are older than the ~100ms window → v = 0 → nearest (from).
    advance(100);
    expect(sheet.style.transform).toBe("translateY(400px)");
    expect(engine.dispatchCalls).toEqual([
      { name: "__hypen_bind", payload: { path: "sheetPhase", value: "closed" } },
    ]);
  });

  test("a projected progress of exactly 0.5 settles to the to pose (>= contract)", () => {
    const harness = makeScrubHarness();
    const { renderer, engine, advance, setTime } = harness;
    const sheet = mountSheet(renderer);

    setTime(0);
    sheet.dispatchEvent("pointerdown", { clientY: 0, pointerId: 1 });
    for (let i = 1; i <= 5; i++) {
      setTime(i * 10);
      sheet.dispatchEvent("pointermove", { clientY: 200, pointerId: 1 }); // rest at exactly p 0.5
    }
    sheet.dispatchEvent("pointerup", { pointerId: 1 }); // v = 0 → p* = 0.5 → to
    advance(100);
    expect(engine.dispatchCalls).toEqual([
      { name: "__hypen_bind", payload: { path: "sheetPhase", value: "open" } },
    ]);
  });
});

describe("channel invalidation mid-interaction", () => {
  test("removing __anim.scrub mid-drag runs the full cleanup: styles, deferred writes, capture, ownership", () => {
    const harness = makeScrubHarness();
    const { renderer } = harness;
    const sheet = mountSheet(renderer);
    const released: number[] = [];
    (sheet as any).setPointerCapture = () => {};
    (sheet as any).releasePointerCapture = (pointerId: number) => released.push(pointerId);

    sheet.dispatchEvent("pointerdown", { clientY: 0, pointerId: 5 });
    sheet.dispatchEvent("pointermove", { clientY: 200, pointerId: 5 }); // p 0.5
    renderer.applyPatches([
      { type: "setProp", id: "sheet", name: "translateY.0", value: 77 } as Patch, // deferred
    ]);
    expect(sheet.style.transform).toBe("translateY(200px)");

    renderer.applyPatches([{ type: "removeProp", id: "sheet", name: "__anim.scrub" } as Patch]);

    expect(released).toEqual([5]); // capture released
    expect(sheet.style.transform).toBe("translateY(77px)"); // deferred write flushed
    expect(styleOf(sheet, "opacity")).toBeUndefined(); // scrub inline styles gone
    expect(styleOf(sheet, "background-color")).toBeUndefined();
    expect(renderer.getScrubber().ownsNode("sheet")).toBe(false);

    // Fully disarmed: a stray move after invalidation is inert.
    const transform = sheet.style.transform;
    sheet.dispatchEvent("pointermove", { clientY: 300, pointerId: 5 });
    expect(sheet.style.transform).toBe(transform);
  });
});

describe("router detach/attach (scroll source)", () => {
  const mountRoutedScene = (renderer: DOMRenderer) => {
    renderer.applyPatches([
      { type: "create", id: "scroller", elementType: "Column", props: {} } as Patch,
      { type: "insert", parentId: "root-1", id: "scroller" } as Patch,
    ]);
    const scroller = renderer.getNode("scroller") as FakeElement & { scrollTop?: number };
    (scroller.style as any).overflow = "auto";
    renderer.applyPatches([
      { type: "create", id: "route", elementType: "Column", props: {} } as Patch,
      { type: "insert", parentId: "scroller", id: "route" } as Patch,
      { type: "create", id: "header", elementType: "Column", props: scrollHeaderProps } as Patch,
      { type: "insert", parentId: "route", id: "header" } as Patch,
    ]);
    const header = renderer.getNode("header") as FakeElement;
    return { scroller, header };
  };

  test("a detached route stops scrubbing via the persistent scroller and never writes", async () => {
    const harness = makeScrubHarness();
    const { renderer, engine } = harness;
    harness.scrubber.restDebounceMs = 20;
    const { scroller, header } = mountRoutedScene(renderer);

    scroller.scrollTop = 60;
    scroller.dispatchEvent("scroll", {});
    expect(styleOf(header, "height")).toBe("84px");

    // The detach patch names only the route ROOT — the scrubbed DESCENDANT's
    // scroll listener on the persistent app-shell scroller must go too.
    renderer.applyPatches([{ type: "detach", id: "route" } as Patch]);
    expect(styleOf(header, "height")).toBeUndefined(); // full cleanup

    scroller.scrollTop = 120;
    scroller.dispatchEvent("scroll", {});
    expect(styleOf(header, "height")).toBeUndefined(); // off-document route: inert
    await sleep(40);
    expect(engine.dispatchCalls.length).toBe(0); // no write into the inactive module
  });

  test("a cached re-attach re-arms a scrubbed descendant's scroll source", async () => {
    const harness = makeScrubHarness();
    const { renderer, engine } = harness;
    harness.scrubber.restDebounceMs = 20;
    const { scroller, header } = mountRoutedScene(renderer);

    renderer.applyPatches([{ type: "detach", id: "route" } as Patch]);
    renderer.applyPatches([{ type: "attach", parentId: "scroller", id: "route" } as Patch]);

    scroller.scrollTop = 60;
    scroller.dispatchEvent("scroll", {});
    expect(styleOf(header, "height")).toBe("84px"); // re-armed

    scroller.scrollTop = 120;
    scroller.dispatchEvent("scroll", {});
    await sleep(40); // endpoint rest → the bind write works again too
    expect(engine.dispatchCalls).toEqual([
      { name: "__hypen_bind", payload: { path: "headerMode", value: "collapsed" } },
    ]);
  });
});

describe("scroll quiescence (bounded deferral)", () => {
  test("resting mid-range flushes deferred writes and releases ownership; the next scroll re-claims", async () => {
    const harness = makeScrubHarness();
    const { renderer } = harness;
    harness.scrubber.restDebounceMs = 20;
    const { scroller, header } = mountHeaderScene(renderer);

    scroller.scrollTop = 60;
    scroller.dispatchEvent("scroll", {});
    expect(styleOf(header, "height")).toBe("84px"); // p 0.5

    renderer.applyPatches([
      { type: "setProp", id: "header", name: "height.0", value: 100 } as Patch,
    ]);
    expect(styleOf(header, "height")).toBe("84px"); // deferred while input is live
    expect(renderer.getScrubber().ownsNode("header")).toBe(true);

    await sleep(40); // scroll quiescence
    expect(styleOf(header, "height")).toBe("100px"); // deferred write conceded to the engine
    expect(renderer.getScrubber().ownsNode("header")).toBe(false); // ownership released

    // The next scroll event re-derives scrub styles and re-claims ownership.
    scroller.scrollTop = 30;
    scroller.dispatchEvent("scroll", {});
    expect(styleOf(header, "height")).toBe("102px"); // p 0.25
    expect(renderer.getScrubber().ownsNode("header")).toBe(true);
    renderer.applyPatches([
      { type: "setProp", id: "header", name: "height.0", value: 99 } as Patch,
    ]);
    expect(styleOf(header, "height")).toBe("102px"); // deferral re-engaged
  });
});

describe("base transform composition", () => {
  test("a static non-scrubbed transform applicator survives the drag", () => {
    const { renderer } = makeScrubHarness();
    const sheet = mountSheet(renderer, { ...gestureProps(), "rotate.0": 45 });
    expect(sheet.style.transform).toBe("translateY(400px) rotate(45)");

    sheet.dispatchEvent("pointerdown", { clientY: 0, pointerId: 1 });
    sheet.dispatchEvent("pointermove", { clientY: 100, pointerId: 1 }); // p 0.25
    // Base minus the scrub-owned translateY is prepended; rotation persists.
    expect(sheet.style.transform).toBe("rotate(45) translateY(300px)");
  });

  test("cleanup with a deferred transform write preserves the static functions", () => {
    const harness = makeScrubHarness();
    const { renderer } = harness;
    const sheet = mountSheet(renderer, { ...gestureProps(), "rotate.0": 45 });

    harness.setTime(0);
    sheet.dispatchEvent("pointerdown", { clientY: 0, pointerId: 1 });
    harness.setTime(10);
    sheet.dispatchEvent("pointermove", { clientY: 120, pointerId: 1 });
    renderer.applyPatches([
      { type: "setProp", id: "sheet", name: "translateY.0", value: 0 } as Patch, // deferred
    ]);
    sheet.dispatchEvent("pointerup", { pointerId: 1 });
    harness.advance(100); // settle to open

    renderer.applyPatches([
      { type: "setProp", id: "sheet", name: "__anim.states", value: { label: "open" } } as Patch,
    ]);
    // The base minus the deferred function kind is restored FIRST, then the
    // deferred write appends its fresh value (the applicator convention) —
    // the static rotation is never lost.
    expect(sheet.style.transform).toBe("rotate(45) translateY(0px)");
  });
});

describe("exit vs scrub", () => {
  const exitProps = () => ({
    ...gestureProps(),
    "__anim.exit": { presets: ["fade"], duration: 60, curve: "linear" },
  });

  test("an exit-flagged remove mid-drag cancels the scrub fully before the exit begins", () => {
    const harness = makeScrubHarness();
    const { renderer, engine } = harness;
    const sheet = mountSheet(renderer, exitProps());
    const released: number[] = [];
    (sheet as any).setPointerCapture = () => {};
    (sheet as any).releasePointerCapture = (pointerId: number) => released.push(pointerId);

    sheet.dispatchEvent("pointerdown", { clientY: 0, pointerId: 9 });
    sheet.dispatchEvent("pointermove", { clientY: 100, pointerId: 9 });
    expect(sheet.style.transform).toBe("translateY(300px)");

    renderer.applyPatches([{ type: "remove", id: "sheet", transition: true } as Patch]);
    expect(released).toEqual([9]); // capture released BEFORE the exit owns the node
    expect(sheet.getAttribute("data-hypen-exiting")).not.toBeNull(); // the exit did begin
    expect(engine.dispatchCalls.length).toBe(0); // no bind write for a dead node

    // The gesture is fully disarmed: a stray move cannot fight the exit.
    const transform = sheet.style.transform;
    sheet.dispatchEvent("pointermove", { clientY: 300, pointerId: 9 });
    expect(sheet.style.transform).toBe(transform);
  });

  test("a mid-settle exit-flagged remove never dispatches the bind write", () => {
    const harness = makeScrubHarness();
    const { renderer, engine, advance, setTime } = harness;
    const sheet = mountSheet(renderer, exitProps());

    setTime(0);
    sheet.dispatchEvent("pointerdown", { clientY: 0, pointerId: 1 });
    setTime(10);
    sheet.dispatchEvent("pointermove", { clientY: 120, pointerId: 1 });
    sheet.dispatchEvent("pointerup", { pointerId: 1 }); // settling → open
    advance(50); // mid-settle

    renderer.applyPatches([{ type: "remove", id: "sheet", transition: true } as Patch]);
    advance(200); // stray queued settle frames are inert
    expect(engine.dispatchCalls.length).toBe(0); // the settle write never fires
  });
});

describe(".animate preset precedence", () => {
  test("scrub engagement suspends a conflicting preset; cleanup resumes it", () => {
    const harness = makeScrubHarness();
    const { renderer } = harness;
    const sheet = mountSheet(renderer, {
      ...gestureProps(),
      "__anim.animate": { preset: "spin", duration: 800, curve: "linear", repeat: "loop" },
    });
    expect(sheet.classList.contains("hypen-anim-spin")).toBe(true);
    expect(styleOf(sheet, "animation")).toBeUndefined();

    harness.setTime(0);
    sheet.dispatchEvent("pointerdown", { clientY: 0, pointerId: 1 });
    harness.setTime(10);
    sheet.dispatchEvent("pointermove", { clientY: 120, pointerId: 1 });
    // Engaged: the spin preset's transform keyframes would beat the scrub's
    // inline transform — suspended for the interaction.
    expect(styleOf(sheet, "animation")).toBe("none");

    sheet.dispatchEvent("pointerup", { pointerId: 1 });
    harness.advance(100);
    expect(styleOf(sheet, "animation")).toBe("none"); // held with the settle styles

    renderer.applyPatches([
      { type: "setProp", id: "sheet", name: "__anim.states", value: { label: "open" } } as Patch,
    ]);
    expect(styleOf(sheet, "animation")).toBeUndefined(); // resumed at cleanup
    expect(sheet.classList.contains("hypen-anim-spin")).toBe(true); // preset class intact
  });
});

describe("scroll cleanup mid-range (no snap)", () => {
  test("label arrival mid-range flushes deferred state but re-derives styles from live progress", async () => {
    const harness = makeScrubHarness();
    const { renderer, engine } = harness;
    harness.scrubber.restDebounceMs = 20;
    const { scroller, header } = mountHeaderScene(renderer);

    scroller.scrollTop = 120;
    scroller.dispatchEvent("scroll", {});
    await sleep(40); // rest at p == 1 → settle write
    expect(engine.dispatchCalls).toEqual([
      { name: "__hypen_bind", payload: { path: "headerMode", value: "collapsed" } },
    ]);

    // Continued scroll during awaitingCleanup keeps driving progress.
    scroller.scrollTop = 60;
    scroller.dispatchEvent("scroll", {});
    expect(styleOf(header, "height")).toBe("84px");

    // The engine's re-render lands while the scroll rests MID-RANGE: the
    // deferred pose write flushes, but the visual re-derives from live
    // progress instead of snapping to the settled pose.
    renderer.applyPatches([
      { type: "setProp", id: "header", name: "height.0", value: 48 } as Patch, // deferred
      {
        type: "setProp",
        id: "header",
        name: "__anim.states",
        value: { label: "collapsed" },
      } as Patch,
    ]);
    expect(styleOf(header, "height")).toBe("84px"); // no snap

    // Quiescence then releases ownership; the mid-range styles persist
    // (styles drop only at an endpoint rest or teardown).
    await sleep(40);
    expect(renderer.getScrubber().ownsNode("header")).toBe(false);
    expect(styleOf(header, "height")).toBe("84px");
  });
});
