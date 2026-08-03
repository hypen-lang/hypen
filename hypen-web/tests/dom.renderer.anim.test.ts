/**
 * DOM renderer animation runtime (`__anim.*` channel consumption).
 *
 * Drives the renderer with raw Patch arrays over fake-dom + StubEngine (the
 * dom.renderer.test.ts pattern). `transitionend` is driven via fake-dom's
 * `dispatchEvent`; the timeout backbone runs on real (short) timers.
 */
import { describe, expect, test } from "bun:test";
import { DOMRenderer } from "../packages/web/src/dom/renderer";
import { EXITING_ATTR } from "../packages/web/src/dom/anim";
import {
  CURVE_TO_CSS,
  cssPropertiesFor,
} from "../packages/core/src/animation";
import type { Patch } from "../packages/core/src/types";
import type { IEngine as Engine } from "../packages/core/src/app";
import { ensureFakeDomGlobals, FakeElement } from "./fake-dom";

ensureFakeDomGlobals();

class StubEngine {
  public dispatchCalls: Array<{ name: string; payload: any }> = [];

  dispatchAction(name: string, payload: any): void {
    this.dispatchCalls.push({ name, payload });
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const makeRenderer = () => {
  const container = document.createElement("div");
  const engine = new StubEngine();
  const renderer = new DOMRenderer(container, engine as unknown as Engine);
  return { container: container as unknown as FakeElement, engine, renderer };
};

/** Boot a renderer past its first batch (enter suppression) with a root Column. */
const makeBootedRenderer = () => {
  const made = makeRenderer();
  made.renderer.applyPatches([
    { type: "create", id: "root-1", elementType: "Column", props: {} } as Patch,
    { type: "insert", parentId: "root", id: "root-1" } as Patch,
  ]);
  return made;
};

/** Record every style write on an element (FakeStyle is proxy-wrappable). */
const recordStyleWrites = (element: FakeElement): Array<[string, string]> => {
  const writes: Array<[string, string]> = [];
  (element as any).style = new Proxy(element.style, {
    set(target, prop, value) {
      writes.push([String(prop), String(value)]);
      return Reflect.set(target, prop, value);
    },
  });
  return writes;
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

describe("`.transition` styles", () => {
  test("create applies transition longhands over the full whitelist", () => {
    const { renderer } = makeBootedRenderer();

    renderer.applyPatches([
      {
        type: "create",
        id: "box",
        elementType: "Text",
        props: { "__anim.transition": { duration: 200, curve: "easeOut" } },
      } as Patch,
      { type: "insert", parentId: "root-1", id: "box" } as Patch,
    ]);

    const box = renderer.getNode("box") as FakeElement;
    expect(box.style.transitionProperty).toBe(cssPropertiesFor().join(", "));
    expect(box.style.transitionDuration).toBe("200ms");
    expect(box.style.transitionTimingFunction).toBe("ease-out");
    expect(box.style.transitionDelay).toBe("");
  });

  test("wire-shape tolerance: channel value arriving as a Map still applies", () => {
    const { renderer } = makeBootedRenderer();

    renderer.applyPatches([
      {
        type: "create",
        id: "box",
        elementType: "Text",
        props: new Map<string, any>([
          ["__anim.transition", new Map<string, any>([["duration", 150], ["curve", "spring"]])],
        ]),
      } as Patch,
      { type: "insert", parentId: "root-1", id: "box" } as Patch,
    ]);

    const box = renderer.getNode("box") as FakeElement;
    expect(box.style.transitionDuration).toBe("150ms");
    expect(box.style.transitionTimingFunction).toBe(CURVE_TO_CSS.spring);
  });

  test("setProp updates the spec (scoped props, delay); removeProp clears it", () => {
    const { renderer } = makeBootedRenderer();

    renderer.applyPatches([
      { type: "create", id: "box", elementType: "Text", props: {} } as Patch,
      { type: "insert", parentId: "root-1", id: "box" } as Patch,
      {
        type: "setProp",
        id: "box",
        name: "__anim.transition",
        value: { duration: 300, curve: "spring", delay: 50, props: ["opacity", "translateY"] },
      } as Patch,
    ]);

    const box = renderer.getNode("box") as FakeElement;
    expect(box.style.transitionProperty).toBe("opacity, transform");
    expect(box.style.transitionDuration).toBe("300ms");
    expect(box.style.transitionTimingFunction).toBe(CURVE_TO_CSS.spring);
    expect(box.style.transitionDelay).toBe("50ms");

    renderer.applyPatches([
      { type: "removeProp", id: "box", name: "__anim.transition" } as Patch,
    ]);

    expect(box.style.transitionProperty).toBe("");
    expect(box.style.transitionDuration).toBe("");
    expect(box.style.transitionTimingFunction).toBe("");
    expect(box.style.transitionDelay).toBe("");
  });

  test("malformed channel value degrades to no transition (snap)", () => {
    const { renderer } = makeBootedRenderer();

    renderer.applyPatches([
      {
        type: "create",
        id: "box",
        elementType: "Text",
        props: { "__anim.transition": { curve: "easeOut" } }, // no duration
      } as Patch,
      { type: "insert", parentId: "root-1", id: "box" } as Patch,
    ]);

    const box = renderer.getNode("box") as FakeElement;
    expect(box.style.transitionProperty).toBeUndefined();
    expect(box.style.transitionDuration).toBeUndefined();
  });
});

describe("`__anim.*` never leaks into CSS", () => {
  test("create and setProp keep __-prefixed names out of inline styles", () => {
    const { renderer } = makeBootedRenderer();

    renderer.applyPatches([
      {
        type: "create",
        id: "box",
        elementType: "Text",
        props: {
          "__anim.transition": { duration: 200, curve: "easeOut" },
          "__anim.enter": { presets: ["fade"], duration: 200, curve: "easeOut" },
        },
      } as Patch,
      { type: "insert", parentId: "root-1", id: "box" } as Patch,
      { type: "setProp", id: "box", name: "__anim.future", value: { some: "thing" } } as Patch,
    ]);

    const box = renderer.getNode("box") as FakeElement;
    for (const key of Object.keys(box.style)) {
      expect(key.includes("__")).toBe(false);
      expect(key.includes("anim")).toBe(false);
    }
  });

  test("applicator registry CSS fallback ignores __-prefixed names outright", () => {
    const { renderer } = makeBootedRenderer();
    const el = document.createElement("div") as unknown as HTMLElement;

    renderer.getApplicatorRegistry().apply(el, "__anim.transition", { duration: 200 });
    renderer.getApplicatorRegistry().apply(el, "__anything", "value");

    expect(Object.keys((el as unknown as FakeElement).style).length).toBe(0);
  });
});

describe("`.enter` playback", () => {
  const enterSpec = { presets: ["fade"], duration: 30, curve: "easeOut" };

  test("first-ever batch suppresses enter animations", () => {
    const { renderer } = makeRenderer();

    renderer.applyPatches([
      { type: "create", id: "root-1", elementType: "Column", props: {} } as Patch,
      { type: "insert", parentId: "root", id: "root-1" } as Patch,
      { type: "create", id: "toast", elementType: "Text", props: { "__anim.enter": enterSpec } } as Patch,
      { type: "insert", parentId: "root-1", id: "toast" } as Patch,
    ]);

    const toast = renderer.getNode("toast") as FakeElement;
    expect(toast.style.transitionDuration).toBeUndefined();
    expect(toast.style.opacity).toBeUndefined();
  });

  test("later-batch create+insert plays enter and cleans up on transitionend", () => {
    const { renderer } = makeBootedRenderer();

    renderer.applyPatches([
      { type: "create", id: "toast", elementType: "Text", props: { "__anim.enter": enterSpec } } as Patch,
      { type: "insert", parentId: "root-1", id: "toast" } as Patch,
    ]);

    const toast = renderer.getNode("toast") as FakeElement;
    // Mid-flight: transitioning back to the node's real styles.
    expect(toast.style.transitionProperty).toBe("opacity");
    expect(toast.style.transitionDuration).toBe("30ms");
    expect(toast.style.transitionTimingFunction).toBe("ease-out");
    expect(toast.style.opacity).toBe(""); // restored target, animating from 0

    toast.dispatchEvent("transitionend", { target: toast });

    // Cleanup: playback transition handed back (no `.transition` → cleared).
    expect(toast.style.transitionProperty).toBe("");
    expect(toast.style.transitionDuration).toBe("");
  });

  test("insert in a later batch than create does not enter-animate", () => {
    const { renderer } = makeBootedRenderer();

    renderer.applyPatches([
      { type: "create", id: "toast", elementType: "Text", props: { "__anim.enter": enterSpec } } as Patch,
    ]);
    renderer.applyPatches([
      { type: "insert", parentId: "root-1", id: "toast" } as Patch,
    ]);

    const toast = renderer.getNode("toast") as FakeElement;
    expect(toast.style.transitionDuration).toBeUndefined();
  });

  test("reduced motion skips enter playback entirely", async () => {
    await withReducedMotion(() => {
      const { renderer } = makeBootedRenderer();

      renderer.applyPatches([
        { type: "create", id: "toast", elementType: "Text", props: { "__anim.enter": enterSpec } } as Patch,
        { type: "insert", parentId: "root-1", id: "toast" } as Patch,
      ]);

      const toast = renderer.getNode("toast") as FakeElement;
      expect(toast.style.transitionDuration).toBeUndefined();
      expect(toast.style.opacity).toBeUndefined();
    });
  });
});

describe("`.exit` deferred remove", () => {
  const exitSpec = { presets: ["fade"], duration: 30, curve: "easeIn" };

  const makeExitScene = () => {
    const made = makeBootedRenderer();
    made.renderer.applyPatches([
      { type: "create", id: "toast", elementType: "Text", props: { "__anim.exit": exitSpec } } as Patch,
      { type: "insert", parentId: "root-1", id: "toast" } as Patch,
    ]);
    return made;
  };

  test("flagged remove defers teardown, marks the root, and plays the inverse pose", () => {
    const { renderer } = makeExitScene();
    const toast = renderer.getNode("toast") as FakeElement;
    const root = renderer.getNode("root-1") as FakeElement;
    const writes = recordStyleWrites(toast);

    renderer.applyPatches([
      { type: "remove", id: "toast", transition: true } as Patch,
    ]);

    // Still alive: element in the DOM, nodes entry intact.
    expect(renderer.getNode("toast")).toBe(toast as unknown as HTMLElement);
    expect(root.children).toContain(toast);

    // Marked inert and exiting.
    expect(toast.getAttribute(EXITING_ATTR)).not.toBeNull();
    expect(toast.getAttribute("inert")).not.toBeNull();
    expect(toast.style.pointerEvents).toBe("none");

    // Inverse fade: transition applied before the hidden pose lands.
    expect(toast.style.transitionProperty).toBe("opacity");
    expect(toast.style.transitionDuration).toBe("30ms");
    expect(toast.style.transitionTimingFunction).toBe("ease-in");
    expect(toast.style.opacity).toBe("0");
    const transitionWrite = writes.findIndex(([prop]) => prop === "transitionProperty");
    const poseWrite = writes.findIndex(([prop, value]) => prop === "opacity" && value === "0");
    expect(transitionWrite).toBeGreaterThanOrEqual(0);
    expect(poseWrite).toBeGreaterThan(transitionWrite);
  });

  test("transitionend finalizes the deferred remove (fast path)", () => {
    const { renderer } = makeExitScene();
    const toast = renderer.getNode("toast") as FakeElement;
    const root = renderer.getNode("root-1") as FakeElement;

    renderer.applyPatches([
      { type: "remove", id: "toast", transition: true } as Patch,
    ]);
    toast.dispatchEvent("transitionend", { target: toast });

    expect(renderer.getNode("toast")).toBeUndefined();
    expect(root.children).not.toContain(toast);
  });

  test("timeout backbone finalizes when transitionend never fires", async () => {
    const { renderer } = makeExitScene();
    const toast = renderer.getNode("toast") as FakeElement;

    renderer.applyPatches([
      { type: "remove", id: "toast", transition: true } as Patch,
    ]);
    expect(renderer.getNode("toast")).toBeDefined();

    await sleep(170); // duration 30 + grace 80, with slack
    expect(renderer.getNode("toast")).toBeUndefined();
    expect((renderer.getNode("root-1") as FakeElement).children).not.toContain(toast);
  });

  test("descendant plain removes defer with their exiting root", () => {
    const { renderer } = makeBootedRenderer();
    renderer.applyPatches([
      { type: "create", id: "card", elementType: "Column", props: { "__anim.exit": exitSpec } } as Patch,
      { type: "insert", parentId: "root-1", id: "card" } as Patch,
      { type: "create", id: "inner", elementType: "Text", props: {} } as Patch,
      { type: "insert", parentId: "card", id: "inner" } as Patch,
    ]);
    const card = renderer.getNode("card") as FakeElement;
    const inner = renderer.getNode("inner") as FakeElement;

    // Root-first ordering: flagged root, then plain descendant removes.
    renderer.applyPatches([
      { type: "remove", id: "card", transition: true } as Patch,
      { type: "remove", id: "inner" } as Patch,
    ]);

    // Whole subtree still intact while the exit plays.
    expect(renderer.getNode("card")).toBeDefined();
    expect(renderer.getNode("inner")).toBeDefined();
    expect(card.children).toContain(inner);

    card.dispatchEvent("transitionend", { target: card });

    expect(renderer.getNode("card")).toBeUndefined();
    expect(renderer.getNode("inner")).toBeUndefined();
  });

  test("events from an exiting subtree do not dispatch", () => {
    const { renderer, engine } = makeBootedRenderer();
    renderer.applyPatches([
      { type: "create", id: "card", elementType: "Column", props: { "__anim.exit": exitSpec } } as Patch,
      { type: "insert", parentId: "root-1", id: "card" } as Patch,
      { type: "create", id: "btn", elementType: "Button", props: { "onClick.0": "@dismiss", "onClick.id": "t1" } } as Patch,
      { type: "insert", parentId: "card", id: "btn" } as Patch,
    ]);
    const btn = renderer.getNode("btn") as FakeElement;

    btn.dispatchEvent("click", { type: "click", target: btn });
    expect(engine.dispatchCalls.length).toBe(1); // sanity: live subtree dispatches

    renderer.applyPatches([
      { type: "remove", id: "card", transition: true } as Patch,
      { type: "remove", id: "btn" } as Patch,
    ]);
    btn.dispatchEvent("click", { type: "click", target: btn });

    expect(engine.dispatchCalls.length).toBe(1); // exiting subtree stays silent
  });

  test("flagged remove without a cached exit spec removes instantly", () => {
    const { renderer } = makeBootedRenderer();
    renderer.applyPatches([
      { type: "create", id: "plain", elementType: "Text", props: {} } as Patch,
      { type: "insert", parentId: "root-1", id: "plain" } as Patch,
    ]);
    const plain = renderer.getNode("plain") as FakeElement;

    renderer.applyPatches([
      { type: "remove", id: "plain", transition: true } as Patch,
    ]);

    expect(renderer.getNode("plain")).toBeUndefined();
    expect((renderer.getNode("root-1") as FakeElement).children).not.toContain(plain);
  });

  test("reduced motion finalizes the exit on the next microtask", async () => {
    await withReducedMotion(async () => {
      const { renderer } = makeExitScene();
      const toast = renderer.getNode("toast") as FakeElement;

      renderer.applyPatches([
        { type: "remove", id: "toast", transition: true } as Patch,
      ]);

      // Deferred past the batch so descendants can queue…
      expect(renderer.getNode("toast")).toBeDefined();
      expect(toast.style.opacity).toBeUndefined(); // no playback under reduced motion

      await sleep(0);

      // …but snaps without waiting on any transition.
      expect(renderer.getNode("toast")).toBeUndefined();
    });
  });

  test("create arriving for an exiting id finalizes the corpse first (defensive)", () => {
    const { renderer } = makeExitScene();
    const oldToast = renderer.getNode("toast") as FakeElement;
    const root = renderer.getNode("root-1") as FakeElement;

    renderer.applyPatches([
      { type: "remove", id: "toast", transition: true } as Patch,
    ]);
    renderer.applyPatches([
      { type: "create", id: "toast", elementType: "Text", props: {} } as Patch,
      { type: "insert", parentId: "root-1", id: "toast" } as Patch,
    ]);

    const newToast = renderer.getNode("toast") as FakeElement;
    expect(newToast).not.toBe(oldToast);
    expect(root.children).toContain(newToast);
    expect(root.children).not.toContain(oldToast);
  });
});

describe("`.layout` FLIP on moves", () => {
  const layoutProps = { "__anim.layout": { duration: 30, curve: "spring" } };

  const makeListScene = () => {
    const made = makeBootedRenderer();
    made.renderer.applyPatches([
      { type: "create", id: "a", elementType: "Text", props: layoutProps } as Patch,
      { type: "insert", parentId: "root-1", id: "a" } as Patch,
      { type: "create", id: "b", elementType: "Text", props: layoutProps } as Patch,
      { type: "insert", parentId: "root-1", id: "b" } as Patch,
    ]);
    return made;
  };

  const rect = (left: number, top: number) => ({
    left,
    top,
    right: left + 100,
    bottom: top + 20,
    width: 100,
    height: 20,
  });

  test("move inverts to the First rect with transitions off, then plays", () => {
    const { renderer } = makeListScene();
    const b = renderer.getNode("b") as FakeElement;
    const rects = [rect(0, 100), rect(0, 0)]; // First (pre-pass), Last (flush)
    b.getBoundingClientRect = () => rects.shift() ?? rect(0, 0);
    const writes = recordStyleWrites(b);

    renderer.applyPatches([
      { type: "move", parentId: "root-1", id: "b", beforeId: "a" } as Patch,
    ]);

    // Invert happened under transitionProperty: none…
    const invertIndex = writes.findIndex(
      ([prop, value]) => prop === "transform" && value === "translate(0px, 100px)",
    );
    const noneIndex = writes.findIndex(
      ([prop, value]) => prop === "transitionProperty" && value === "none",
    );
    expect(noneIndex).toBeGreaterThanOrEqual(0);
    expect(invertIndex).toBeGreaterThan(noneIndex);

    // …and Play transitions transform back to identity.
    expect(b.style.transform).toBe("");
    expect(b.style.transitionProperty).toBe("transform");
    expect(b.style.transitionDuration).toBe("30ms");
    expect(b.style.transitionTimingFunction).toBe(CURVE_TO_CSS.spring);

    b.dispatchEvent("transitionend", { target: b });
    expect(b.style.transitionProperty).toBe("");
  });

  test("zero-delta move skips FLIP entirely", () => {
    const { renderer } = makeListScene();
    const b = renderer.getNode("b") as FakeElement;
    b.getBoundingClientRect = () => rect(0, 50);

    renderer.applyPatches([
      { type: "move", parentId: "root-1", id: "b", beforeId: "a" } as Patch,
    ]);

    expect(b.style.transform).toBeUndefined();
    expect(b.style.transitionProperty).toBeUndefined();
  });

  test("move of a node without a `.layout` spec never measures or animates", () => {
    const { renderer } = makeBootedRenderer();
    renderer.applyPatches([
      { type: "create", id: "a", elementType: "Text", props: {} } as Patch,
      { type: "insert", parentId: "root-1", id: "a" } as Patch,
      { type: "create", id: "b", elementType: "Text", props: {} } as Patch,
      { type: "insert", parentId: "root-1", id: "b" } as Patch,
    ]);
    const b = renderer.getNode("b") as FakeElement;
    let measured = 0;
    b.getBoundingClientRect = () => {
      measured += 1;
      return rect(0, measured * 100);
    };

    renderer.applyPatches([
      { type: "move", parentId: "root-1", id: "b", beforeId: "a" } as Patch,
    ]);

    expect(measured).toBe(0);
    expect(b.style.transitionProperty).toBeUndefined();
  });
});

describe("superseded playback settles are cancelled", () => {
  test("an interrupted enter's stale settle cannot snap a subsequent exit", async () => {
    const { renderer } = makeBootedRenderer();
    renderer.applyPatches([
      {
        type: "create",
        id: "toast",
        elementType: "Text",
        props: {
          "__anim.enter": { presets: ["fade"], duration: 30, curve: "easeOut" },
          "__anim.exit": { presets: ["fade"], duration: 400, curve: "easeIn" },
        },
      } as Patch,
      { type: "insert", parentId: "root-1", id: "toast" } as Patch,
    ]);
    const toast = renderer.getNode("toast") as FakeElement;

    // Exit begins while the enter is still in flight (its settle backbone
    // would fire at 30 + 80ms).
    renderer.applyPatches([{ type: "remove", id: "toast", transition: true } as Patch]);
    expect(toast.style.transitionDuration).toBe("400ms");

    await sleep(170); // past the stale enter settle, well before the exit's

    // The stale enter settle must NOT have restored the base transition —
    // per CSS semantics that retarget would cancel the running exit
    // transition (instant snap) and orphan the corpse.
    expect(toast.style.transitionProperty).toBe("opacity");
    expect(toast.style.transitionDuration).toBe("400ms");
    expect(renderer.getNode("toast")).toBeDefined();

    toast.dispatchEvent("transitionend", { target: toast });
    expect(renderer.getNode("toast")).toBeUndefined();
  });

  test("a superseded FLIP settle cannot snap the next FLIP", async () => {
    const layoutProps = { "__anim.layout": { duration: 100, curve: "linear" } };
    const { renderer } = makeBootedRenderer();
    renderer.applyPatches([
      { type: "create", id: "a", elementType: "Text", props: layoutProps } as Patch,
      { type: "insert", parentId: "root-1", id: "a" } as Patch,
      { type: "create", id: "b", elementType: "Text", props: layoutProps } as Patch,
      { type: "insert", parentId: "root-1", id: "b" } as Patch,
    ]);
    const b = renderer.getNode("b") as FakeElement;
    let y = 0;
    b.getBoundingClientRect = () => ({
      left: 0,
      top: (y += 100),
      right: 100,
      bottom: (y += 0) + 20,
      width: 100,
      height: 20,
    });

    // Two moves within one settle budget (100 + 80ms): the second FLIP
    // supersedes the first's pending settle.
    renderer.applyPatches([
      { type: "move", parentId: "root-1", id: "b", beforeId: "a" } as Patch,
    ]);
    await sleep(100);
    renderer.applyPatches([
      { type: "move", parentId: "root-1", id: "b", beforeId: null } as Patch,
    ]);
    expect(b.style.transitionProperty).toBe("transform");

    // t≈230ms: the FIRST settle (fires ~180ms) is stale and must have been
    // cancelled — the second FLIP (settles ~280ms) is still mid-flight and
    // its transition styles must be untouched.
    await sleep(130);
    expect(b.style.transitionProperty).toBe("transform");
    expect(b.style.transitionDuration).toBe("100ms");

    b.dispatchEvent("transitionend", { target: b });
    expect(b.style.transitionProperty).toBe("");
  });
});

describe("subtree bookkeeping sweep on remove", () => {
  test("a root-only remove (keyed/ForEach path) sweeps descendant bookkeeping", () => {
    const { renderer } = makeBootedRenderer();
    renderer.applyPatches([
      { type: "create", id: "card", elementType: "Column", props: {} } as Patch,
      { type: "insert", parentId: "root-1", id: "card" } as Patch,
      {
        type: "create",
        id: "inner",
        elementType: "Text",
        props: { "__anim.transition": { duration: 200, curve: "easeOut" } },
      } as Patch,
      { type: "insert", parentId: "card", id: "inner" } as Patch,
    ]);
    expect(renderer.getNode("inner")).toBeDefined();

    // The engine's keyed and ForEach-rebuild paths emit ONE Remove for the
    // subtree root — no per-descendant Removes ever arrive.
    renderer.applyPatches([{ type: "remove", id: "card" } as Patch]);

    expect(renderer.getNode("card")).toBeUndefined();
    expect(renderer.getNode("inner")).toBeUndefined();
  });

  test("a deferred exit sweeps descendants that never got their own removes", () => {
    const { renderer } = makeBootedRenderer();
    renderer.applyPatches([
      {
        type: "create",
        id: "card",
        elementType: "Column",
        props: { "__anim.exit": { presets: ["fade"], duration: 30, curve: "easeIn" } },
      } as Patch,
      { type: "insert", parentId: "root-1", id: "card" } as Patch,
      { type: "create", id: "inner", elementType: "Text", props: {} } as Patch,
      { type: "insert", parentId: "card", id: "inner" } as Patch,
    ]);
    const card = renderer.getNode("card") as FakeElement;

    renderer.applyPatches([{ type: "remove", id: "card", transition: true } as Patch]);

    // Subtree intact during the exit…
    expect(renderer.getNode("inner")).toBeDefined();

    card.dispatchEvent("transitionend", { target: card });

    // …and fully forgotten after it, root and descendant alike.
    expect(renderer.getNode("card")).toBeUndefined();
    expect(renderer.getNode("inner")).toBeUndefined();
  });
});

describe("`.animate` preset playback", () => {
  const VAR_DURATION = "--hypen-anim-duration";
  const VAR_CURVE = "--hypen-anim-curve";
  const VAR_DELAY = "--hypen-anim-delay";
  const VAR_ITERATIONS = "--hypen-anim-iterations";

  const varOf = (element: FakeElement, name: string): string | undefined =>
    (element.style as any).getProperty(name);

  /** Record classList add/remove calls and forced reflows in one ordered log. */
  const recordAnimateOps = (element: FakeElement): string[] => {
    const ops: string[] = [];
    const add = element.classList.add;
    const remove = element.classList.remove;
    element.classList.add = (...names: string[]) => {
      for (const name of names) ops.push(`add:${name}`);
      add(...names);
    };
    element.classList.remove = (...names: string[]) => {
      for (const name of names) ops.push(`remove:${name}`);
      remove(...names);
    };
    Object.defineProperty(element, "offsetWidth", {
      configurable: true,
      get: () => {
        ops.push("reflow");
        return 0;
      },
    });
    return ops;
  };

  test("create sets the preset class and timing vars from the wire spec", () => {
    const { renderer } = makeBootedRenderer();

    renderer.applyPatches([
      {
        type: "create",
        id: "spinner",
        elementType: "Text",
        props: {
          "__anim.animate": { preset: "spin", duration: 800, repeat: "loop", curve: "linear" },
        },
      } as Patch,
      { type: "insert", parentId: "root-1", id: "spinner" } as Patch,
    ]);

    const spinner = renderer.getNode("spinner") as FakeElement;
    expect(spinner.classList.contains("hypen-anim-spin")).toBe(true);
    expect(varOf(spinner, VAR_DURATION)).toBe("800ms");
    expect(varOf(spinner, VAR_CURVE)).toBe("linear");
    expect(varOf(spinner, VAR_DELAY)).toBe("0ms");
    expect(varOf(spinner, VAR_ITERATIONS)).toBe("infinite");
  });

  test("per-preset engine defaults land as vars; overrides win", () => {
    const { renderer } = makeBootedRenderer();

    renderer.applyPatches([
      {
        type: "create",
        id: "badge",
        elementType: "Text",
        // The engine-filled pulse defaults on the wire.
        props: {
          "__anim.animate": { preset: "pulse", duration: 1200, repeat: "loop", curve: "easeInOut" },
        },
      } as Patch,
      { type: "insert", parentId: "root-1", id: "badge" } as Patch,
      {
        type: "create",
        id: "alert",
        elementType: "Text",
        // Fully-overridden pulse: finite repeat + delay + custom curve.
        props: {
          "__anim.animate": { preset: "pulse", duration: 300, repeat: 3, curve: "spring", delay: 100 },
        },
      } as Patch,
      { type: "insert", parentId: "root-1", id: "alert" } as Patch,
    ]);

    const badge = renderer.getNode("badge") as FakeElement;
    expect(badge.classList.contains("hypen-anim-pulse")).toBe(true);
    expect(varOf(badge, VAR_DURATION)).toBe("1200ms");
    expect(varOf(badge, VAR_CURVE)).toBe("ease-in-out");
    expect(varOf(badge, VAR_ITERATIONS)).toBe("infinite");

    const alert = renderer.getNode("alert") as FakeElement;
    expect(alert.classList.contains("hypen-anim-pulse")).toBe(true);
    expect(varOf(alert, VAR_DURATION)).toBe("300ms");
    expect(varOf(alert, VAR_CURVE)).toBe(CURVE_TO_CSS.spring);
    expect(varOf(alert, VAR_DELAY)).toBe("100ms");
    expect(varOf(alert, VAR_ITERATIONS)).toBe("3");
  });

  test("setProp restarts playback: class removed, reflow forced, class re-added", () => {
    const { renderer } = makeBootedRenderer();
    renderer.applyPatches([
      {
        type: "create",
        id: "spinner",
        elementType: "Text",
        props: {
          "__anim.animate": { preset: "spin", duration: 800, repeat: "loop", curve: "linear" },
        },
      } as Patch,
      { type: "insert", parentId: "root-1", id: "spinner" } as Patch,
    ]);
    const spinner = renderer.getNode("spinner") as FakeElement;
    const ops = recordAnimateOps(spinner);

    renderer.applyPatches([
      {
        type: "setProp",
        id: "spinner",
        name: "__anim.animate",
        value: { preset: "spin", duration: 400, repeat: "loop", curve: "easeInOut" },
      } as Patch,
    ]);

    // Restart choreography, in order: drop the class, force a reflow so the
    // re-add starts a fresh animation, then re-add.
    expect(ops).toEqual(["remove:hypen-anim-spin", "reflow", "add:hypen-anim-spin"]);
    expect(spinner.classList.contains("hypen-anim-spin")).toBe(true);
    expect(varOf(spinner, VAR_DURATION)).toBe("400ms");
    expect(varOf(spinner, VAR_CURVE)).toBe("ease-in-out");
  });

  test("setProp with a different preset swaps classes", () => {
    const { renderer } = makeBootedRenderer();
    renderer.applyPatches([
      {
        type: "create",
        id: "box",
        elementType: "Text",
        props: {
          "__anim.animate": { preset: "spin", duration: 800, repeat: "loop", curve: "linear" },
        },
      } as Patch,
      { type: "insert", parentId: "root-1", id: "box" } as Patch,
      {
        type: "setProp",
        id: "box",
        name: "__anim.animate",
        value: { preset: "shake", duration: 400, repeat: 1, curve: "easeInOut" },
      } as Patch,
    ]);

    const box = renderer.getNode("box") as FakeElement;
    expect(box.classList.contains("hypen-anim-spin")).toBe(false);
    expect(box.classList.contains("hypen-anim-shake")).toBe(true);
    expect(varOf(box, VAR_DURATION)).toBe("400ms");
    expect(varOf(box, VAR_ITERATIONS)).toBe("1");
  });

  test("removeProp clears the class and every timing var", () => {
    const { renderer } = makeBootedRenderer();
    renderer.applyPatches([
      {
        type: "create",
        id: "spinner",
        elementType: "Text",
        props: {
          "__anim.animate": { preset: "shimmer", duration: 1500, repeat: "loop", curve: "linear" },
        },
      } as Patch,
      { type: "insert", parentId: "root-1", id: "spinner" } as Patch,
    ]);
    const spinner = renderer.getNode("spinner") as FakeElement;
    expect(spinner.classList.contains("hypen-anim-shimmer")).toBe(true);

    renderer.applyPatches([
      { type: "removeProp", id: "spinner", name: "__anim.animate" } as Patch,
    ]);

    expect(spinner.classList.contains("hypen-anim-shimmer")).toBe(false);
    expect(varOf(spinner, VAR_DURATION)).toBeUndefined();
    expect(varOf(spinner, VAR_CURVE)).toBeUndefined();
    expect(varOf(spinner, VAR_DELAY)).toBeUndefined();
    expect(varOf(spinner, VAR_ITERATIONS)).toBeUndefined();
  });

  test("unknown or malformed spec on create is a no-op (snap)", () => {
    const { renderer } = makeBootedRenderer();

    renderer.applyPatches([
      {
        type: "create",
        id: "a",
        elementType: "Text",
        props: {
          // Unknown preset: never emitted by the engine, ignored defensively.
          "__anim.animate": { preset: "wiggle", duration: 800, repeat: "loop", curve: "linear" },
        },
      } as Patch,
      { type: "insert", parentId: "root-1", id: "a" } as Patch,
      {
        type: "create",
        id: "b",
        elementType: "Text",
        // Missing required duration → whole channel malformed.
        props: { "__anim.animate": { preset: "spin", repeat: "loop", curve: "linear" } },
      } as Patch,
      { type: "insert", parentId: "root-1", id: "b" } as Patch,
    ]);

    for (const id of ["a", "b"]) {
      const node = renderer.getNode(id) as FakeElement;
      for (const preset of ["pulse", "spin", "shimmer", "shake"]) {
        expect(node.classList.contains(`hypen-anim-${preset}`)).toBe(false);
      }
      expect(varOf(node, VAR_DURATION)).toBeUndefined();
      expect(varOf(node, VAR_ITERATIONS)).toBeUndefined();
    }
  });

  test("malformed setProp over a running animation degrades to a clear", () => {
    const { renderer } = makeBootedRenderer();
    renderer.applyPatches([
      {
        type: "create",
        id: "spinner",
        elementType: "Text",
        props: {
          "__anim.animate": { preset: "spin", duration: 800, repeat: "loop", curve: "linear" },
        },
      } as Patch,
      { type: "insert", parentId: "root-1", id: "spinner" } as Patch,
      { type: "setProp", id: "spinner", name: "__anim.animate", value: "not-json{" } as Patch,
    ]);

    const spinner = renderer.getNode("spinner") as FakeElement;
    expect(spinner.classList.contains("hypen-anim-spin")).toBe(false);
    expect(varOf(spinner, VAR_DURATION)).toBeUndefined();
  });

  test("coexists with `.transition` on the same node — neither clobbers the other", () => {
    const { renderer } = makeBootedRenderer();

    renderer.applyPatches([
      {
        type: "create",
        id: "box",
        elementType: "Text",
        props: {
          "__anim.transition": { duration: 200, curve: "easeOut" },
          "__anim.animate": { preset: "pulse", duration: 1200, repeat: "loop", curve: "easeInOut" },
        },
      } as Patch,
      { type: "insert", parentId: "root-1", id: "box" } as Patch,
    ]);

    const box = renderer.getNode("box") as FakeElement;
    // `.transition` longhands intact…
    expect(box.style.transitionProperty).toBe(cssPropertiesFor().join(", "));
    expect(box.style.transitionDuration).toBe("200ms");
    // …and `.animate` class + vars intact alongside them.
    expect(box.classList.contains("hypen-anim-pulse")).toBe(true);
    expect(varOf(box, VAR_DURATION)).toBe("1200ms");

    // Dropping `.animate` leaves `.transition` untouched.
    renderer.applyPatches([
      { type: "removeProp", id: "box", name: "__anim.animate" } as Patch,
    ]);
    expect(box.classList.contains("hypen-anim-pulse")).toBe(false);
    expect(box.style.transitionProperty).toBe(cssPropertiesFor().join(", "));
    expect(box.style.transitionDuration).toBe("200ms");
  });

  test("wire-shape tolerance: channel value arriving as a Map still applies", () => {
    const { renderer } = makeBootedRenderer();

    renderer.applyPatches([
      {
        type: "create",
        id: "spinner",
        elementType: "Text",
        props: new Map<string, any>([
          [
            "__anim.animate",
            new Map<string, any>([
              ["preset", "spin"],
              ["duration", 800],
              ["repeat", "loop"],
              ["curve", "linear"],
            ]),
          ],
        ]),
      } as Patch,
      { type: "insert", parentId: "root-1", id: "spinner" } as Patch,
    ]);

    const spinner = renderer.getNode("spinner") as FakeElement;
    expect(spinner.classList.contains("hypen-anim-spin")).toBe(true);
    expect(varOf(spinner, VAR_DURATION)).toBe("800ms");
  });

  test("renderer construction injects the preset stylesheet exactly once", () => {
    makeRenderer();
    makeRenderer();

    const sheet = (document as any).getElementById("hypen-anim-styles") as FakeElement | null;
    expect(sheet).not.toBeNull();
    const head = (document as any).head as FakeElement;
    const sheets = head.children.filter((child) => child.id === "hypen-anim-styles");
    expect(sheets.length).toBe(1);

    // Keyframes + classes for all four presets, with the normative preset
    // defaults as var() fallbacks, and the shimmer overlay only a stylesheet
    // can express.
    const css = sheet!.textContent;
    for (const preset of ["pulse", "spin", "shimmer", "shake"]) {
      expect(css).toContain(`@keyframes hypen-${preset}`);
      expect(css).toContain(`.hypen-anim-${preset}`);
    }
    expect(css).toContain("var(--hypen-anim-duration, 1200ms)"); // pulse default
    expect(css).toContain("var(--hypen-anim-duration, 800ms)"); // spin default
    expect(css).toContain("var(--hypen-anim-duration, 1500ms)"); // shimmer default
    expect(css).toContain("var(--hypen-anim-duration, 400ms)"); // shake default
    expect(css).toContain("var(--hypen-anim-iterations, 1)"); // shake plays once
    expect(css).toContain(".hypen-anim-shimmer::after");
  });

  test("shimmer containment: background-position sweep, no overflow clipping", () => {
    makeRenderer();
    const sheet = (document as any).getElementById("hypen-anim-styles") as FakeElement;
    const css = sheet.textContent;

    // The sweep must be a background-position animation on the inset:0
    // overlay — backgrounds self-clip to the element's box, so the gradient
    // can never escape even when an author's inline `.overflow(visible)`
    // beats the class rule.
    expect(css).toContain("background-position-x: 200%");
    expect(css).toContain("background-size: 200% 100%");
    expect(css).toContain("@keyframes hypen-shimmer {\n  from { background-position-x: 200%; }");
    // No overflow declaration at all: nothing to leak past, nothing to clip
    // an intentionally-overflowing child (dropdown/badge) with.
    expect(css).not.toContain("overflow:");
    // The one deliberate side effect: position: relative anchors the overlay.
    expect(css).toContain("position: relative");
  });
});

describe("`.animate` under Router-cache detach/attach", () => {
  const shakeOnce = { preset: "shake", duration: 400, repeat: 1, curve: "easeInOut" };
  const spinLoop = { preset: "spin", duration: 800, repeat: "loop", curve: "linear" };

  test("cached re-attach strips finite-repeat presets (root and descendants); loops resume", () => {
    const { renderer } = makeBootedRenderer();
    renderer.applyPatches([
      // The route root itself carries a one-shot preset…
      { type: "create", id: "route", elementType: "Column", props: { "__anim.animate": shakeOnce } } as Patch,
      { type: "insert", parentId: "root-1", id: "route" } as Patch,
      // …as does a descendant; a looping sibling must keep resuming.
      { type: "create", id: "card", elementType: "Text", props: { "__anim.animate": shakeOnce } } as Patch,
      { type: "insert", parentId: "route", id: "card" } as Patch,
      { type: "create", id: "spinner", elementType: "Text", props: { "__anim.animate": spinLoop } } as Patch,
      { type: "insert", parentId: "route", id: "spinner" } as Patch,
    ]);
    const route = renderer.getNode("route") as FakeElement;
    const card = renderer.getNode("card") as FakeElement;
    const spinner = renderer.getNode("spinner") as FakeElement;
    expect(route.classList.contains("hypen-anim-shake")).toBe(true);
    expect(card.classList.contains("hypen-anim-shake")).toBe(true);

    renderer.applyPatches([{ type: "detach", id: "route" } as Patch]);
    renderer.applyPatches([{ type: "attach", parentId: "root-1", id: "route" } as Patch]);

    // Re-entering the document restarts CSS animations from iteration 0 —
    // one-shot attention motion must not replay on every navigation back
    // (the `.animate` counterpart of "a cached attach never enter-animates").
    expect(route.classList.contains("hypen-anim-shake")).toBe(false);
    expect(card.classList.contains("hypen-anim-shake")).toBe(false);
    // Looping presets legitimately resume.
    expect(spinner.classList.contains("hypen-anim-spin")).toBe(true);
  });

  test("a __anim.animate setProp after a stripped attach restarts playback", () => {
    const { renderer } = makeBootedRenderer();
    renderer.applyPatches([
      { type: "create", id: "route", elementType: "Column", props: {} } as Patch,
      { type: "insert", parentId: "root-1", id: "route" } as Patch,
      { type: "create", id: "card", elementType: "Text", props: { "__anim.animate": shakeOnce } } as Patch,
      { type: "insert", parentId: "route", id: "card" } as Patch,
    ]);
    const card = renderer.getNode("card") as FakeElement;

    renderer.applyPatches([{ type: "detach", id: "route" } as Patch]);
    renderer.applyPatches([{ type: "attach", parentId: "root-1", id: "route" } as Patch]);
    expect(card.classList.contains("hypen-anim-shake")).toBe(false);

    renderer.applyPatches([
      {
        type: "setProp",
        id: "card",
        name: "__anim.animate",
        value: { preset: "shake", duration: 300, repeat: 1, curve: "easeInOut" },
      } as Patch,
    ]);
    expect(card.classList.contains("hypen-anim-shake")).toBe(true);
  });

  test("attach of an unrelated subtree leaves other finite presets untouched", () => {
    const { renderer } = makeBootedRenderer();
    renderer.applyPatches([
      { type: "create", id: "route", elementType: "Column", props: {} } as Patch,
      { type: "insert", parentId: "root-1", id: "route" } as Patch,
      // Lives OUTSIDE the detached route.
      { type: "create", id: "toast", elementType: "Text", props: { "__anim.animate": shakeOnce } } as Patch,
      { type: "insert", parentId: "root-1", id: "toast" } as Patch,
    ]);
    const toast = renderer.getNode("toast") as FakeElement;

    renderer.applyPatches([{ type: "detach", id: "route" } as Patch]);
    renderer.applyPatches([{ type: "attach", parentId: "root-1", id: "route" } as Patch]);

    expect(toast.classList.contains("hypen-anim-shake")).toBe(true);
  });
});

describe("`.animate` suspension during enter/exit/FLIP playback", () => {
  test("exit suspends a conflicting preset so the pose can render (pulse vs fade)", () => {
    const { renderer } = makeBootedRenderer();
    renderer.applyPatches([
      {
        type: "create",
        id: "badge",
        elementType: "Text",
        props: {
          "__anim.animate": { preset: "pulse", duration: 1200, repeat: "loop", curve: "easeInOut" },
          "__anim.exit": { presets: ["fade"], duration: 30, curve: "easeIn" },
        },
      } as Patch,
      { type: "insert", parentId: "root-1", id: "badge" } as Patch,
    ]);
    const badge = renderer.getNode("badge") as FakeElement;
    expect(badge.style.animation).toBeUndefined(); // no suspension while live

    renderer.applyPatches([{ type: "remove", id: "badge", transition: true } as Patch]);

    // The running pulse keyframes would own computed opacity and defeat the
    // fade entirely (visible, pulsing corpse until the timeout backbone).
    expect(badge.style.animation).toBe("none");
    expect(badge.style.opacity).toBe("0");

    badge.dispatchEvent("transitionend", { target: badge });
    expect(renderer.getNode("badge")).toBeUndefined();
  });

  test("enter suspends a conflicting preset and resumes it on settle (spin vs scale)", () => {
    const { renderer } = makeBootedRenderer();
    renderer.applyPatches([
      {
        type: "create",
        id: "spinner",
        elementType: "Text",
        props: {
          "__anim.animate": { preset: "spin", duration: 800, repeat: "loop", curve: "linear" },
          "__anim.enter": { presets: ["scale"], duration: 30, curve: "easeOut" },
        },
      } as Patch,
      { type: "insert", parentId: "root-1", id: "spinner" } as Patch,
    ]);
    const spinner = renderer.getNode("spinner") as FakeElement;

    // Mid-flight: spin suspended (its transform keyframes would mask the
    // scale pose), class untouched.
    expect(spinner.style.animation).toBe("none");
    expect(spinner.classList.contains("hypen-anim-spin")).toBe(true);

    spinner.dispatchEvent("transitionend", { target: spinner });

    // Settled: suspension lifted, the preset plays again.
    expect(spinner.style.animation).toBeUndefined();
    expect(spinner.classList.contains("hypen-anim-spin")).toBe(true);
  });

  test("FLIP suspends a transform-keyframing preset and resumes it on settle", () => {
    const layoutProps = {
      "__anim.layout": { duration: 30, curve: "linear" },
      "__anim.animate": { preset: "spin", duration: 800, repeat: "loop", curve: "linear" },
    };
    const { renderer } = makeBootedRenderer();
    renderer.applyPatches([
      { type: "create", id: "a", elementType: "Text", props: layoutProps } as Patch,
      { type: "insert", parentId: "root-1", id: "a" } as Patch,
      { type: "create", id: "b", elementType: "Text", props: layoutProps } as Patch,
      { type: "insert", parentId: "root-1", id: "b" } as Patch,
    ]);
    const b = renderer.getNode("b") as FakeElement;
    const rects = [
      { left: 0, top: 100, right: 100, bottom: 120, width: 100, height: 20 },
      { left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 },
    ];
    b.getBoundingClientRect = () => rects.shift() ?? rects[0] ?? { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };

    renderer.applyPatches([
      { type: "move", parentId: "root-1", id: "b", beforeId: "a" } as Patch,
    ]);

    expect(b.style.animation).toBe("none"); // spin masked the invert otherwise
    b.dispatchEvent("transitionend", { target: b });
    expect(b.style.animation).toBeUndefined();
  });

  test("a non-conflicting preset (shimmer) is never suspended by playback", () => {
    const { renderer } = makeBootedRenderer();
    renderer.applyPatches([
      {
        type: "create",
        id: "skeleton",
        elementType: "Text",
        props: {
          // shimmer keyframes live on the ::after overlay, not the element.
          "__anim.animate": { preset: "shimmer", duration: 1500, repeat: "loop", curve: "linear" },
          "__anim.exit": { presets: ["fade"], duration: 30, curve: "easeIn" },
        },
      } as Patch,
      { type: "insert", parentId: "root-1", id: "skeleton" } as Patch,
    ]);
    const skeleton = renderer.getNode("skeleton") as FakeElement;

    renderer.applyPatches([{ type: "remove", id: "skeleton", transition: true } as Patch]);

    expect(skeleton.style.animation).toBeUndefined();
    expect(skeleton.classList.contains("hypen-anim-shimmer")).toBe(true);
    expect(skeleton.style.opacity).toBe("0");
  });
});

describe("Detach is unaffected by animation specs", () => {
  test("detach unlinks instantly even when the node has an exit spec", () => {
    const { renderer } = makeBootedRenderer();
    renderer.applyPatches([
      {
        type: "create",
        id: "route",
        elementType: "Column",
        props: { "__anim.exit": { presets: ["fade"], duration: 150, curve: "easeIn" } },
      } as Patch,
      { type: "insert", parentId: "root-1", id: "route" } as Patch,
    ]);
    const route = renderer.getNode("route") as FakeElement;
    const root = renderer.getNode("root-1") as FakeElement;

    renderer.applyPatches([{ type: "detach", id: "route" } as Patch]);

    // Instant unlink, no exit choreography, subtree kept alive for re-attach.
    expect(root.children).not.toContain(route);
    expect(renderer.getNode("route")).toBe(route as unknown as HTMLElement);
    expect(route.getAttribute(EXITING_ATTR)).toBeNull();
    expect(route.style.opacity).toBeUndefined();
  });
});
