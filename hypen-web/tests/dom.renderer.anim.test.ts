import { semanticAction } from "./helpers";
/**
 * DOM renderer animation runtime (`__anim.*` channel consumption).
 *
 * Drives the renderer with raw Patch arrays over fake-dom + StubEngine (the
 * dom.renderer.test.ts pattern). `transitionend` is driven via fake-dom's
 * `dispatchEvent`; the timeout backbone runs on real (short) timers.
 */
import { describe, expect, test } from "bun:test";
import { DOMRenderer } from "../packages/web/src/dom/renderer";
import { EXITING_ATTR, MOTION_ESSENTIAL_ATTR } from "../packages/web/src/dom/anim";
import {
  CURVE_TO_CSS,
  cssPropertiesFor,
} from "../packages/core/src/animation";
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

/**
 * Give a fake element real-DOM `isConnected` semantics: connected iff the
 * `parentNode` chain reaches the fake document. `FakeElement` doesn't
 * implement `isConnected` (undefined = "unknown, assume connected" in the
 * animator), so tests exercising the Router-detach suppression opt in per
 * element — and must also append the renderer container to `document.body`
 * so the connected case reads `true`.
 */
const wireIsConnected = (element: FakeElement) => {
  Object.defineProperty(element, "isConnected", {
    configurable: true,
    get: () => {
      let node: unknown = element;
      while (node) {
        if (node === (globalThis as any).document) return true;
        node = (node as { parentNode?: unknown }).parentNode ?? null;
      }
      return false;
    },
  });
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

describe("`.onAnimationComplete` completion events (Option F)", () => {
  const DONE = "onAnimationComplete.0";
  const enterSpec = { presets: ["fade"], duration: 30, curve: "easeOut" };
  const exitSpec = { presets: ["fade"], duration: 30, curve: "easeIn" };

  test("enter settling naturally dispatches { animation: 'enter' }", () => {
    const { renderer, engine } = makeBootedRenderer();
    renderer.applyPatches([
      {
        type: "create",
        id: "toast",
        elementType: "Text",
        props: { "__anim.enter": enterSpec, [DONE]: "@actions.animDone" },
      } as Patch,
      { type: "insert", parentId: "root-1", id: "toast" } as Patch,
    ]);
    const toast = renderer.getNode("toast") as FakeElement;
    expect(engine.dispatchCalls.length).toBe(0); // mid-flight: nothing yet

    toast.dispatchEvent("transitionend", { target: toast });

    expect(engine.dispatchCalls).toEqual([
      { name: "animDone", payload: { animation: "enter" } },
    ]);
  });

  test("extra applicator args merge under the payload; completion fields win", () => {
    const { renderer, engine } = makeBootedRenderer();
    renderer.applyPatches([
      {
        type: "create",
        id: "toast",
        elementType: "Text",
        props: {
          "__anim.enter": enterSpec,
          [DONE]: "@actions.animDone",
          "onAnimationComplete.id": "toast-1",
        },
      } as Patch,
      { type: "insert", parentId: "root-1", id: "toast" } as Patch,
    ]);
    const toast = renderer.getNode("toast") as FakeElement;

    toast.dispatchEvent("transitionend", { target: toast });

    expect(engine.dispatchCalls).toEqual([
      { name: "animDone", payload: { id: "toast-1", animation: "enter" } },
    ]);
  });

  test("no onAnimationComplete prop dispatches nothing on any settle", () => {
    const { renderer, engine } = makeBootedRenderer();
    renderer.applyPatches([
      {
        type: "create",
        id: "toast",
        elementType: "Text",
        props: { "__anim.enter": enterSpec, "__anim.exit": exitSpec },
      } as Patch,
      { type: "insert", parentId: "root-1", id: "toast" } as Patch,
    ]);
    const toast = renderer.getNode("toast") as FakeElement;
    toast.dispatchEvent("transitionend", { target: toast }); // enter settles

    renderer.applyPatches([{ type: "remove", id: "toast", transition: true } as Patch]);
    toast.dispatchEvent("transitionend", { target: toast }); // exit settles

    expect(renderer.getNode("toast")).toBeUndefined();
    expect(engine.dispatchCalls.length).toBe(0);
  });

  test("exit settling naturally dispatches { animation: 'exit' } just before finalize", () => {
    const { renderer, engine } = makeBootedRenderer();
    renderer.applyPatches([
      {
        type: "create",
        id: "toast",
        elementType: "Text",
        props: { "__anim.exit": exitSpec, [DONE]: "@actions.animDone" },
      } as Patch,
      { type: "insert", parentId: "root-1", id: "toast" } as Patch,
    ]);
    const toast = renderer.getNode("toast") as FakeElement;

    // Record whether the node was still alive at dispatch time (the "just
    // before finalize" contract).
    const aliveAtDispatch: boolean[] = [];
    const record = engine.dispatchAction.bind(engine);
    engine.dispatchAction = (name: string, payload: any) => {
      aliveAtDispatch.push(renderer.getNode("toast") !== undefined);
      record(name, payload);
    };

    renderer.applyPatches([{ type: "remove", id: "toast", transition: true } as Patch]);
    expect(engine.dispatchCalls.length).toBe(0); // mid-exit: nothing yet

    toast.dispatchEvent("transitionend", { target: toast });

    expect(engine.dispatchCalls).toEqual([
      { name: "animDone", payload: { animation: "exit" } },
    ]);
    expect(aliveAtDispatch).toEqual([true]);
    expect(renderer.getNode("toast")).toBeUndefined();
  });

  test("interrupted enter fires nothing; the superseding exit still fires", async () => {
    const { renderer, engine } = makeBootedRenderer();
    renderer.applyPatches([
      {
        type: "create",
        id: "toast",
        elementType: "Text",
        props: {
          "__anim.enter": enterSpec, // settle backbone at 30 + 80ms
          "__anim.exit": { presets: ["fade"], duration: 400, curve: "easeIn" },
          [DONE]: "@actions.animDone",
        },
      } as Patch,
      { type: "insert", parentId: "root-1", id: "toast" } as Patch,
    ]);
    const toast = renderer.getNode("toast") as FakeElement;

    // Exit begins while the enter is still in flight — the enter is
    // superseded and must never report completion.
    renderer.applyPatches([{ type: "remove", id: "toast", transition: true } as Patch]);

    await sleep(170); // past the stale enter settle, well before the exit's
    expect(engine.dispatchCalls.length).toBe(0);

    toast.dispatchEvent("transitionend", { target: toast });
    expect(engine.dispatchCalls).toEqual([
      { name: "animDone", payload: { animation: "exit" } },
    ]);
  });

  test("an enter settling under an ancestor's exit fires nothing (engine-side dead)", () => {
    const { renderer, engine } = makeBootedRenderer();
    renderer.applyPatches([
      {
        type: "create",
        id: "panel",
        elementType: "Column",
        props: { "__anim.exit": { presets: ["fade"], duration: 300, curve: "easeIn" } },
      } as Patch,
      { type: "insert", parentId: "root-1", id: "panel" } as Patch,
      {
        type: "create",
        id: "toast",
        elementType: "Text",
        props: { "__anim.enter": enterSpec, [DONE]: "@actions.animDone" },
      } as Patch,
      { type: "insert", parentId: "panel", id: "toast" } as Patch,
    ]);
    const toast = renderer.getNode("toast") as FakeElement;

    // The ANCESTOR exits while the toast's enter is in flight. The toast's
    // own plain remove defers onto the exiting root (beginExit's cancelSettle
    // only targets the exit root's id), so the enter settle stays alive —
    // its dispatch must be suppressed for a node the engine already removed.
    renderer.applyPatches([
      { type: "remove", id: "panel", transition: true } as Patch,
      { type: "remove", id: "toast" } as Patch,
    ]);

    // Enter settle fast path fires the callback — style restore runs, but
    // no completion may be dispatched.
    toast.dispatchEvent("transitionend", { target: toast });

    expect(engine.dispatchCalls.length).toBe(0);
  });

  test("reduced-motion exit snap fires nothing", async () => {
    await withReducedMotion(async () => {
      const { renderer, engine } = makeBootedRenderer();
      renderer.applyPatches([
        {
          type: "create",
          id: "toast",
          elementType: "Text",
          props: { "__anim.exit": exitSpec, [DONE]: "@actions.animDone" },
        } as Patch,
        { type: "insert", parentId: "root-1", id: "toast" } as Patch,
      ]);

      renderer.applyPatches([{ type: "remove", id: "toast", transition: true } as Patch]);
      await sleep(0); // microtask snap-finalize

      expect(renderer.getNode("toast")).toBeUndefined();
      expect(engine.dispatchCalls.length).toBe(0);
    });
  });

  test("finite `.animate` preset completion dispatches the preset name", () => {
    const { renderer, engine } = makeBootedRenderer();
    renderer.applyPatches([
      {
        type: "create",
        id: "alert",
        elementType: "Text",
        props: {
          "__anim.animate": { preset: "shake", duration: 400, repeat: 1, curve: "easeInOut" },
          [DONE]: "@actions.animDone",
        },
      } as Patch,
      { type: "insert", parentId: "root-1", id: "alert" } as Patch,
    ]);
    const alert = renderer.getNode("alert") as FakeElement;

    alert.dispatchEvent("animationend", { target: alert, animationName: "hypen-shake" });

    expect(engine.dispatchCalls).toEqual([
      { name: "animDone", payload: { animation: "shake" } },
    ]);
  });

  test("a foreign animation ending on the element is not a preset completion", () => {
    const { renderer, engine } = makeBootedRenderer();
    renderer.applyPatches([
      {
        type: "create",
        id: "alert",
        elementType: "Text",
        props: {
          "__anim.animate": { preset: "shake", duration: 400, repeat: 1, curve: "easeInOut" },
          [DONE]: "@actions.animDone",
        },
      } as Patch,
      { type: "insert", parentId: "root-1", id: "alert" } as Patch,
    ]);
    const alert = renderer.getNode("alert") as FakeElement;

    alert.dispatchEvent("animationend", { target: alert, animationName: "confetti" });

    expect(engine.dispatchCalls.length).toBe(0);
  });

  test("looping presets never fire completion", () => {
    const { renderer, engine } = makeBootedRenderer();
    renderer.applyPatches([
      {
        type: "create",
        id: "spinner",
        elementType: "Text",
        props: {
          "__anim.animate": { preset: "spin", duration: 800, repeat: "loop", curve: "linear" },
          [DONE]: "@actions.animDone",
        },
      } as Patch,
      { type: "insert", parentId: "root-1", id: "spinner" } as Patch,
    ]);
    const spinner = renderer.getNode("spinner") as FakeElement;

    // Defensive: infinite animations emit no animationend, but even a stray
    // one must not report a loop as complete.
    spinner.dispatchEvent("animationend", { target: spinner, animationName: "hypen-spin" });

    expect(engine.dispatchCalls.length).toBe(0);
  });

  test("preset completion on an exit-animating node fires nothing (dead engine-side)", () => {
    const { renderer, engine } = makeBootedRenderer();
    renderer.applyPatches([
      {
        type: "create",
        id: "badge",
        elementType: "Text",
        props: {
          "__anim.animate": { preset: "shake", duration: 400, repeat: 1, curve: "easeInOut" },
          "__anim.exit": { presets: ["fade"], duration: 400, curve: "easeIn" },
          [DONE]: "@actions.animDone",
        },
      } as Patch,
      { type: "insert", parentId: "root-1", id: "badge" } as Patch,
    ]);
    const badge = renderer.getNode("badge") as FakeElement;

    renderer.applyPatches([{ type: "remove", id: "badge", transition: true } as Patch]);
    badge.dispatchEvent("animationend", { target: badge, animationName: "hypen-shake" });

    expect(engine.dispatchCalls.length).toBe(0);
  });

  describe("`.states` settle", () => {
    const statesNodeProps = {
      "__anim.transition": { duration: 30, curve: "easeOut" },
      "__anim.states": { label: "collapsed" },
      [DONE]: "@actions.animDone",
    };

    test("a label change settles after duration+delay with the label in the payload", async () => {
      const { renderer, engine } = makeBootedRenderer();
      renderer.applyPatches([
        { type: "create", id: "card", elementType: "Column", props: statesNodeProps } as Patch,
        { type: "insert", parentId: "root-1", id: "card" } as Patch,
      ]);

      // Create-time resolution is not a transition — nothing settles.
      await sleep(60);
      expect(engine.dispatchCalls.length).toBe(0);

      renderer.applyPatches([
        { type: "setProp", id: "card", name: "__anim.states", value: { label: "expanded" } } as Patch,
      ]);
      expect(engine.dispatchCalls.length).toBe(0); // window open, not settled

      await sleep(60); // past duration (30) + delay (0)
      expect(engine.dispatchCalls).toEqual([
        { name: "animDone", payload: { animation: "states", state: "expanded" } },
      ]);
    });

    test("a superseding label change cancels the pending settle — only the last fires", async () => {
      const { renderer, engine } = makeBootedRenderer();
      renderer.applyPatches([
        { type: "create", id: "card", elementType: "Column", props: statesNodeProps } as Patch,
        { type: "insert", parentId: "root-1", id: "card" } as Patch,
      ]);

      renderer.applyPatches([
        { type: "setProp", id: "card", name: "__anim.states", value: { label: "expanded" } } as Patch,
      ]);
      renderer.applyPatches([
        { type: "setProp", id: "card", name: "__anim.states", value: { label: "collapsed" } } as Patch,
      ]);

      await sleep(90); // past both windows
      expect(engine.dispatchCalls).toEqual([
        { name: "animDone", payload: { animation: "states", state: "collapsed" } },
      ]);
    });

    test("re-resolving to the same label opens no new window and cancels nothing", async () => {
      const { renderer, engine } = makeBootedRenderer();
      renderer.applyPatches([
        { type: "create", id: "card", elementType: "Column", props: statesNodeProps } as Patch,
        { type: "insert", parentId: "root-1", id: "card" } as Patch,
      ]);

      renderer.applyPatches([
        { type: "setProp", id: "card", name: "__anim.states", value: { label: "expanded" } } as Patch,
      ]);
      // Same label again (e.g. an unrelated re-resolve): NOT a pose switch.
      renderer.applyPatches([
        { type: "setProp", id: "card", name: "__anim.states", value: { label: "expanded" } } as Patch,
      ]);

      await sleep(60);
      expect(engine.dispatchCalls).toEqual([
        { name: "animDone", payload: { animation: "states", state: "expanded" } },
      ]);
    });

    test("falling back to the default pose (no matched label) fires nothing", async () => {
      const { renderer, engine } = makeBootedRenderer();
      renderer.applyPatches([
        { type: "create", id: "card", elementType: "Column", props: statesNodeProps } as Patch,
        { type: "insert", parentId: "root-1", id: "card" } as Patch,
      ]);

      renderer.applyPatches([
        { type: "removeProp", id: "card", name: "__anim.states" } as Patch,
      ]);

      await sleep(60);
      expect(engine.dispatchCalls.length).toBe(0);
    });

    test("a label change without a transition spec snaps and fires nothing", async () => {
      const { renderer, engine } = makeBootedRenderer();
      renderer.applyPatches([
        {
          type: "create",
          id: "card",
          elementType: "Column",
          props: { "__anim.states": { label: "collapsed" }, [DONE]: "@actions.animDone" },
        } as Patch,
        { type: "insert", parentId: "root-1", id: "card" } as Patch,
      ]);

      renderer.applyPatches([
        { type: "setProp", id: "card", name: "__anim.states", value: { label: "expanded" } } as Patch,
      ]);

      await sleep(60);
      expect(engine.dispatchCalls.length).toBe(0);
    });

    test("reduced motion snaps pose switches and fires nothing", async () => {
      await withReducedMotion(async () => {
        const { renderer, engine } = makeBootedRenderer();
        renderer.applyPatches([
          { type: "create", id: "card", elementType: "Column", props: statesNodeProps } as Patch,
          { type: "insert", parentId: "root-1", id: "card" } as Patch,
        ]);

        renderer.applyPatches([
          { type: "setProp", id: "card", name: "__anim.states", value: { label: "expanded" } } as Patch,
        ]);

        await sleep(60);
        expect(engine.dispatchCalls.length).toBe(0);
      });
    });

    test("a remove during the settle window fires nothing for the states transition", async () => {
      const { renderer, engine } = makeBootedRenderer();
      renderer.applyPatches([
        { type: "create", id: "card", elementType: "Column", props: statesNodeProps } as Patch,
        { type: "insert", parentId: "root-1", id: "card" } as Patch,
      ]);

      renderer.applyPatches([
        { type: "setProp", id: "card", name: "__anim.states", value: { label: "expanded" } } as Patch,
      ]);
      renderer.applyPatches([{ type: "remove", id: "card" } as Patch]);

      await sleep(60);
      expect(engine.dispatchCalls.length).toBe(0);
    });

    test("wire-shape tolerance: `__anim.states` arriving as a Map still settles", async () => {
      const { renderer, engine } = makeBootedRenderer();
      renderer.applyPatches([
        { type: "create", id: "card", elementType: "Column", props: statesNodeProps } as Patch,
        { type: "insert", parentId: "root-1", id: "card" } as Patch,
      ]);

      renderer.applyPatches([
        {
          type: "setProp",
          id: "card",
          name: "__anim.states",
          value: new Map<string, any>([["label", "expanded"]]),
        } as Patch,
      ]);

      await sleep(60);
      expect(engine.dispatchCalls).toEqual([
        { name: "animDone", payload: { animation: "states", state: "expanded" } },
      ]);
    });

    test("a pose flip reconciled into a Router-detached (cached) subtree fires nothing", async () => {
      const { container, renderer, engine } = makeBootedRenderer();
      (globalThis as any).document.body.appendChild(container);
      renderer.applyPatches([
        { type: "create", id: "card", elementType: "Column", props: statesNodeProps } as Patch,
        { type: "insert", parentId: "root-1", id: "card" } as Patch,
      ]);
      const card = renderer.getNode("card") as FakeElement;
      wireIsConnected(card);

      // Route leaves: the engine detaches the subtree but deliberately keeps
      // reconciling it — SetProps for the off-screen card still arrive. No
      // CSS transition can play on a disconnected element, so no completion
      // may be owed.
      renderer.applyPatches([{ type: "detach", id: "card" } as Patch]);
      renderer.applyPatches([
        { type: "setProp", id: "card", name: "__anim.states", value: { label: "expanded" } } as Patch,
      ]);

      await sleep(60);
      expect(engine.dispatchCalls.length).toBe(0);
    });

    test("a detach during the settle window suppresses the pending completion", async () => {
      const { container, renderer, engine } = makeBootedRenderer();
      (globalThis as any).document.body.appendChild(container);
      renderer.applyPatches([
        { type: "create", id: "card", elementType: "Column", props: statesNodeProps } as Patch,
        { type: "insert", parentId: "root-1", id: "card" } as Patch,
      ]);
      const card = renderer.getNode("card") as FakeElement;
      wireIsConnected(card);

      // Window opens while connected…
      renderer.applyPatches([
        { type: "setProp", id: "card", name: "__anim.states", value: { label: "expanded" } } as Patch,
      ]);
      // …then the route leaves mid-window: the timer survives but must fire
      // nothing (re-checked at fire time).
      renderer.applyPatches([{ type: "detach", id: "card" } as Patch]);

      await sleep(60);
      expect(engine.dispatchCalls.length).toBe(0);
    });

    test("a states window on a node under an ancestor's exit fires nothing (engine-side dead)", async () => {
      const { renderer, engine } = makeBootedRenderer();
      renderer.applyPatches([
        {
          type: "create",
          id: "panel",
          elementType: "Column",
          props: { "__anim.exit": { presets: ["fade"], duration: 200, curve: "easeIn" } },
        } as Patch,
        { type: "insert", parentId: "root-1", id: "panel" } as Patch,
        { type: "create", id: "card", elementType: "Column", props: statesNodeProps } as Patch,
        { type: "insert", parentId: "panel", id: "card" } as Patch,
      ]);

      // Window opens (30ms)…
      renderer.applyPatches([
        { type: "setProp", id: "card", name: "__anim.states", value: { label: "expanded" } } as Patch,
      ]);
      // …then the PARENT exits before it settles: flagged root first, then
      // the card's plain remove (deferred onto the exiting root — beginExit
      // only cancels the exit ROOT's own window, so the card's timer
      // survives and must fire nothing).
      renderer.applyPatches([
        { type: "remove", id: "panel", transition: true } as Patch,
        { type: "remove", id: "card" } as Patch,
      ]);

      await sleep(60); // past the states window, before the exit settles
      expect(engine.dispatchCalls.length).toBe(0);
    });

    test("a pose flip landing during an in-flight enter snaps and fires nothing", async () => {
      const { renderer, engine } = makeBootedRenderer();
      renderer.applyPatches([
        {
          type: "create",
          id: "card",
          elementType: "Column",
          props: {
            ...statesNodeProps,
            "__anim.enter": { presets: ["fade"], duration: 200, curve: "easeOut" },
          },
        } as Patch,
        { type: "insert", parentId: "root-1", id: "card" } as Patch,
      ]);
      const card = renderer.getNode("card") as FakeElement;

      // The enter owns `transition-property` (retargeted to "opacity"), so
      // the pose props SNAP — the label change must open no window.
      renderer.applyPatches([
        { type: "setProp", id: "card", name: "__anim.states", value: { label: "expanded" } } as Patch,
      ]);

      await sleep(60); // past the 30ms states window, enter still in flight
      expect(engine.dispatchCalls.length).toBe(0);

      // The enter itself still completes naturally.
      card.dispatchEvent("transitionend", { target: card });
      expect(engine.dispatchCalls).toEqual([
        { name: "animDone", payload: { animation: "enter" } },
      ]);
    });
  });

  test("`onAnimationComplete` never attaches a DOM listener or leaks into CSS", () => {
    const { renderer, engine } = makeBootedRenderer();
    renderer.applyPatches([
      {
        type: "create",
        id: "toast",
        elementType: "Text",
        props: { "__anim.enter": enterSpec, [DONE]: "@actions.animDone" },
      } as Patch,
      { type: "insert", parentId: "root-1", id: "toast" } as Patch,
    ]);
    const toast = renderer.getNode("toast") as FakeElement;

    // No inline-CSS fallback write for the event prop. The enter playback
    // wrote transition longhands, so the key set is non-empty — assert that
    // first so the loop below cannot pass vacuously.
    const styleKeys = Object.keys(toast.style);
    expect(styleKeys.length).toBeGreaterThan(0);
    for (const key of styleKeys) {
      expect(key.toLowerCase().includes("animationcomplete")).toBe(false);
    }
    // …and no DOM event listener: the DONE action IS stored on the element,
    // so if the applicator were wired like an ordinary on* handler
    // (createEventHandler listens on the lowercased derived name), one of
    // these dispatches would reach the engine.
    toast.dispatchEvent("onAnimationComplete", { target: toast });
    toast.dispatchEvent("animationcomplete", { target: toast });
    expect(engine.dispatchCalls.length).toBe(0);
  });
});

describe("`.sharedElement` cross-route FLIP (Option H)", () => {
  const SHARED_TIMING = { duration: 30, curve: "spring" };
  const sharedProps = (key: string, extra: Record<string, any> = {}) => ({
    "__anim.sharedKey": key,
    "__anim.shared": SHARED_TIMING,
    ...extra,
  });

  const rect = (left: number, top: number, width = 100, height = 100) => ({
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
  });

  /** Root + routeA containing a visible shared source node "thumb". */
  const makeSharedScene = () => {
    const made = makeBootedRenderer();
    made.renderer.applyPatches([
      { type: "create", id: "routeA", elementType: "Column", props: {} } as Patch,
      { type: "insert", parentId: "root-1", id: "routeA" } as Patch,
      { type: "create", id: "thumb", elementType: "Image", props: sharedProps("hero") } as Patch,
      { type: "insert", parentId: "routeA", id: "thumb" } as Patch,
    ]);
    return made;
  };

  /**
   * Two-route scene for the cache-hit (detach+attach) navigation shape:
   * routeA (source "thumb") is visible; routeB (target "heroImg") was built
   * by a past navigation and now sits detached in the Router cache. Both
   * shared nodes get real-DOM `isConnected` semantics (fake-dom otherwise
   * reports "unknown"), so the cached side is correctly invisible to the
   * source snapshot pre-pass.
   */
  const makeTwoRouteScene = (targetExtra: Record<string, any> = {}, targetKey = "hero") => {
    const made = makeSharedScene();
    (globalThis as any).document.body.appendChild(made.container);
    made.renderer.applyPatches([
      { type: "detach", id: "routeA" } as Patch,
      { type: "create", id: "routeB", elementType: "Column", props: {} } as Patch,
      { type: "insert", parentId: "root-1", id: "routeB" } as Patch,
      {
        type: "create",
        id: "heroImg",
        elementType: "Image",
        props: sharedProps(targetKey, targetExtra),
      } as Patch,
      { type: "insert", parentId: "routeB", id: "heroImg" } as Patch,
    ]);
    made.renderer.applyPatches([
      { type: "detach", id: "routeB" } as Patch,
      { type: "attach", parentId: "root-1", id: "routeA" } as Patch,
    ]);
    const thumb = made.renderer.getNode("thumb") as FakeElement;
    const heroImg = made.renderer.getNode("heroImg") as FakeElement;
    wireIsConnected(thumb);
    wireIsConnected(heroImg);
    return { ...made, thumb, heroImg };
  };

  /** Navigate the two-route scene A → B (detach + cached attach). */
  const navigateToB = (renderer: DOMRenderer) =>
    renderer.applyPatches([
      { type: "detach", id: "routeA" } as Patch,
      { type: "attach", parentId: "root-1", id: "routeB" } as Patch,
    ]);

  /**
   * Stub `getBoundingClientRect` on elements created DURING `run` — the only
   * way to give a node created and measured inside one `applyPatches` (the
   * create-path shared-element target) a natural rect. `onCreated` can also
   * install a style-write recorder before the renderer touches the element.
   */
  const withCreatedElements = (
    onCreated: (el: FakeElement, tag: string) => void,
    run: () => void
  ) => {
    const doc = (globalThis as any).document;
    const orig = doc.createElement.bind(doc);
    doc.createElement = (tag: string) => {
      const el = orig(tag);
      onCreated(el, tag.toLowerCase());
      return el;
    };
    try {
      run();
    } finally {
      doc.createElement = orig;
    }
  };

  test("matched key FLIPs the attached node from the source rect with shared timing", () => {
    const { renderer, thumb, heroImg } = makeTwoRouteScene();
    thumb.getBoundingClientRect = () => rect(10, 20, 100, 50);
    heroImg.getBoundingClientRect = () => rect(200, 300, 200, 100);
    const writes = recordStyleWrites(heroImg);

    navigateToB(renderer);

    // Inverted pose: translate by (first - last), scale by (first / last),
    // from an explicitly pinned top-left origin, transitions off first.
    const noneIndex = writes.findIndex(
      ([prop, value]) => prop === "transitionProperty" && value === "none"
    );
    const invertIndex = writes.findIndex(
      ([prop, value]) =>
        prop === "transform" && value === "translate(-190px, -280px) scale(0.5, 0.5)"
    );
    expect(noneIndex).toBeGreaterThanOrEqual(0);
    expect(invertIndex).toBeGreaterThan(noneIndex);
    expect(heroImg.style.transformOrigin).toBe("top left");

    // Play to identity with the node's shared timing.
    expect(heroImg.style.transform).toBe("");
    expect(heroImg.style.transitionProperty).toBe("transform");
    expect(heroImg.style.transitionDuration).toBe("30ms");
    expect(heroImg.style.transitionTimingFunction).toBe(CURVE_TO_CSS.spring);

    // Settle cleanup: transition handed back, pinned origin cleared.
    heroImg.dispatchEvent("transitionend", { target: heroImg });
    expect(heroImg.style.transitionProperty).toBe("");
    expect(heroImg.style.transformOrigin).toBe("");
  });

  test("a stamped batch never touches a mid-shared-flight node (pinned-origin lifecycle intact)", () => {
    const { renderer, thumb, heroImg } = makeTwoRouteScene();
    thumb.getBoundingClientRect = () => rect(10, 20, 100, 50);
    heroImg.getBoundingClientRect = () => rect(200, 300, 200, 100);

    navigateToB(renderer);
    // Shared FLIP in flight: transform owned, origin pinned.
    expect(heroImg.style.transitionProperty).toBe("transform");
    expect(heroImg.style.transformOrigin).toBe("top left");

    // Transaction stamp touching the mid-flight node: EXCLUDED (structural
    // playbacks outrank the transaction) — the flight's transition targets
    // stay put and its settle contract is untouched.
    renderer.applyPatches([
      { type: "batchAnimation", spec: { curve: "linear", duration: 500 } } as Patch,
      { type: "setProp", id: "heroImg", name: "backgroundColor", value: "#123456" } as Patch,
    ]);
    expect(heroImg.style.transitionProperty).toBe("transform");
    expect(heroImg.style.transitionDuration).toBe("30ms");
    expect(heroImg.style.transformOrigin).toBe("top left");

    // Natural settle still runs the FULL shared-flight cleanup: transition
    // handed back AND the pinned origin cleared (a transaction settle would
    // have skipped clearPinnedOrigin — the R1 takeover-contract violation).
    heroImg.dispatchEvent("transitionend", { target: heroImg });
    expect(heroImg.style.transitionProperty).toBe("");
    expect(heroImg.style.transformOrigin).toBe("");
  });

  test("shared playback suppresses the node's own enter (create-path target)", () => {
    const { renderer } = makeSharedScene();
    const thumb = renderer.getNode("thumb") as FakeElement;
    thumb.getBoundingClientRect = () => rect(0, 0, 100, 100);

    let writes: Array<[string, string]> = [];
    withCreatedElements(
      (el, tag) => {
        if (tag === "img") {
          el.getBoundingClientRect = () => rect(200, 300, 200, 200);
          writes = recordStyleWrites(el);
        }
      },
      () =>
        renderer.applyPatches([
          { type: "detach", id: "routeA" } as Patch,
          { type: "create", id: "routeB", elementType: "Column", props: {} } as Patch,
          { type: "insert", parentId: "root-1", id: "routeB" } as Patch,
          {
            type: "create",
            id: "heroImg",
            elementType: "Image",
            props: sharedProps("hero", {
              "__anim.enter": { presets: ["fade"], duration: 30, curve: "easeOut" },
            }),
          } as Patch,
          { type: "insert", parentId: "routeB", id: "heroImg" } as Patch,
        ])
    );

    const heroImg = renderer.getNode("heroImg") as FakeElement;
    // One motion, not two: the enter's fade pose never ran…
    expect(heroImg.style.opacity).toBeUndefined();
    expect(writes.some(([prop]) => prop === "opacity")).toBe(false);
    // …and the shared FLIP did.
    expect(
      writes.some(
        ([prop, value]) =>
          prop === "transform" && value === "translate(-200px, -300px) scale(0.5, 0.5)"
      )
    ).toBe(true);
    expect(heroImg.style.transitionProperty).toBe("transform");
  });

  test("unmatched key skips silently — plain navigation", () => {
    const { renderer, thumb, heroImg } = makeTwoRouteScene({}, "other-key");
    thumb.getBoundingClientRect = () => rect(10, 20, 100, 50);
    heroImg.getBoundingClientRect = () => rect(200, 300, 200, 100);

    navigateToB(renderer);

    expect(heroImg.style.transform).toBeUndefined();
    expect(heroImg.style.transitionProperty).toBeUndefined();
    expect(heroImg.style.transformOrigin).toBeUndefined();
  });

  test("unmeasurable source (zero rect) skips silently", () => {
    const { renderer, heroImg } = makeTwoRouteScene();
    // thumb keeps fake-dom's default all-zero rect — a real disconnected or
    // unlaid-out element reports exactly this.
    heroImg.getBoundingClientRect = () => rect(200, 300, 200, 100);

    navigateToB(renderer);

    expect(heroImg.style.transform).toBeUndefined();
    expect(heroImg.style.transitionProperty).toBeUndefined();
  });

  test("exit wins: a target inside an exiting subtree never FLIPs", () => {
    const { renderer } = makeSharedScene();
    renderer.applyPatches([
      {
        type: "create",
        id: "panel",
        elementType: "Column",
        props: { "__anim.exit": { presets: ["fade"], duration: 300, curve: "easeIn" } },
      } as Patch,
      { type: "insert", parentId: "root-1", id: "panel" } as Patch,
    ]);
    const thumb = renderer.getNode("thumb") as FakeElement;
    thumb.getBoundingClientRect = () => rect(0, 0, 100, 100);

    let writes: Array<[string, string]> = [];
    withCreatedElements(
      (el, tag) => {
        if (tag === "img") {
          el.getBoundingClientRect = () => rect(200, 300, 200, 200);
          writes = recordStyleWrites(el);
        }
      },
      () =>
        renderer.applyPatches([
          { type: "detach", id: "routeA" } as Patch,
          // The panel begins its exit in the same batch…
          { type: "remove", id: "panel", transition: true } as Patch,
          // …and the (synthetic) incoming shared node lands inside it.
          {
            type: "create",
            id: "heroImg",
            elementType: "Image",
            props: sharedProps("hero"),
          } as Patch,
          { type: "insert", parentId: "panel", id: "heroImg" } as Patch,
        ])
    );

    expect(writes.some(([prop]) => prop === "transform")).toBe(false);
    expect(writes.some(([prop]) => prop === "transitionProperty")).toBe(false);
  });

  test("reduced motion: no FLIP and no double-enter", async () => {
    await withReducedMotion(() => {
      const { renderer } = makeSharedScene();
      const thumb = renderer.getNode("thumb") as FakeElement;
      thumb.getBoundingClientRect = () => rect(0, 0, 100, 100);

      let writes: Array<[string, string]> = [];
      withCreatedElements(
        (el, tag) => {
          if (tag === "img") {
            el.getBoundingClientRect = () => rect(200, 300, 200, 200);
            writes = recordStyleWrites(el);
          }
        },
        () =>
          renderer.applyPatches([
            { type: "detach", id: "routeA" } as Patch,
            { type: "create", id: "routeB", elementType: "Column", props: {} } as Patch,
            { type: "insert", parentId: "root-1", id: "routeB" } as Patch,
            {
              type: "create",
              id: "heroImg",
              elementType: "Image",
              props: sharedProps("hero", {
                "__anim.enter": { presets: ["fade"], duration: 30, curve: "easeOut" },
              }),
            } as Patch,
            { type: "insert", parentId: "routeB", id: "heroImg" } as Patch,
          ])
      );

      const heroImg = renderer.getNode("heroImg") as FakeElement;
      expect(writes.some(([prop]) => prop === "transform")).toBe(false);
      expect(writes.some(([prop]) => prop === "opacity")).toBe(false);
      expect(heroImg.style.transitionProperty).toBeUndefined();
    });
  });

  test("interruption: a second navigation retargets from the animated presentation rect", () => {
    const { renderer, thumb, heroImg } = makeTwoRouteScene();
    thumb.getBoundingClientRect = () => rect(0, 0, 100, 100);
    heroImg.getBoundingClientRect = () => rect(200, 300, 200, 200);

    // First navigation: heroImg FLIPs from the thumb's rect.
    navigateToB(renderer);
    expect(heroImg.style.transitionProperty).toBe("transform");

    // Mid-flight, heroImg's presentation rect is partway between source and
    // natural (getBoundingClientRect reflects the animated transform).
    heroImg.getBoundingClientRect = () => rect(100, 150, 150, 150);
    const writes = recordStyleWrites(thumb);

    // Back-navigation before the first FLIP settles: thumb (re-attached with
    // routeA) must FLIP from heroImg's CURRENT rect, not its original source.
    renderer.applyPatches([
      { type: "detach", id: "routeB" } as Patch,
      { type: "attach", parentId: "root-1", id: "routeA" } as Patch,
    ]);

    expect(
      writes.some(
        ([prop, value]) =>
          prop === "transform" && value === "translate(100px, 150px) scale(1.5, 1.5)"
      )
    ).toBe(true);
    expect(thumb.style.transform).toBe("");
    expect(thumb.style.transitionProperty).toBe("transform");
  });

  test("non-navigation batches never snapshot shared sources", () => {
    const { renderer } = makeSharedScene();
    const thumb = renderer.getNode("thumb") as FakeElement;
    let measured = 0;
    thumb.getBoundingClientRect = () => {
      measured += 1;
      return rect(0, 0, 100, 100);
    };

    // Plain content batch: insert without a detach.
    renderer.applyPatches([
      { type: "create", id: "extra", elementType: "Text", props: {} } as Patch,
      { type: "insert", parentId: "root-1", id: "extra" } as Patch,
    ]);
    expect(measured).toBe(0);

    // Detach-only batch (no incoming side): also not a navigation.
    renderer.applyPatches([{ type: "detach", id: "routeA" } as Patch]);
    expect(measured).toBe(0);
  });

  test("snapshots never leak across batches", () => {
    const { renderer } = makeSharedScene();
    const thumb = renderer.getNode("thumb") as FakeElement;
    thumb.getBoundingClientRect = () => rect(10, 20, 100, 50);

    // Navigation with no matching target: the "hero" snapshot is taken —
    // and must be dropped at the end of this batch's flush.
    renderer.applyPatches([
      { type: "detach", id: "routeA" } as Patch,
      { type: "create", id: "dummy", elementType: "Column", props: {} } as Patch,
      { type: "insert", parentId: "root-1", id: "dummy" } as Patch,
    ]);
    // The source is then removed for good.
    renderer.applyPatches([{ type: "remove", id: "thumb" } as Patch]);

    // A later navigation creating a "hero" target must find nothing: were
    // the snapshot map leaking, this would FLIP from the stale thumb rect.
    let writes: Array<[string, string]> = [];
    withCreatedElements(
      (el, tag) => {
        if (tag === "img") {
          el.getBoundingClientRect = () => rect(200, 300, 200, 100);
          writes = recordStyleWrites(el);
        }
      },
      () =>
        renderer.applyPatches([
          { type: "detach", id: "dummy" } as Patch,
          { type: "create", id: "heroImg", elementType: "Image", props: sharedProps("hero") } as Patch,
          { type: "insert", parentId: "root-1", id: "heroImg" } as Patch,
        ])
    );

    expect(writes.some(([prop]) => prop === "transform")).toBe(false);
    expect((renderer.getNode("heroImg") as FakeElement).style.transitionProperty).toBeUndefined();
  });

  test("duplicate target keys in one batch: first match wins", () => {
    const { renderer } = makeSharedScene();
    const thumb = renderer.getNode("thumb") as FakeElement;
    thumb.getBoundingClientRect = () => rect(0, 0, 100, 100);

    withCreatedElements(
      (el, tag) => {
        if (tag === "img") {
          el.getBoundingClientRect = () => rect(200, 300, 200, 200);
        }
      },
      () =>
        renderer.applyPatches([
          { type: "detach", id: "routeA" } as Patch,
          { type: "create", id: "routeB", elementType: "Column", props: {} } as Patch,
          { type: "insert", parentId: "root-1", id: "routeB" } as Patch,
          { type: "create", id: "t1", elementType: "Image", props: sharedProps("hero") } as Patch,
          { type: "insert", parentId: "routeB", id: "t1" } as Patch,
          { type: "create", id: "t2", elementType: "Image", props: sharedProps("hero") } as Patch,
          { type: "insert", parentId: "routeB", id: "t2" } as Patch,
        ])
    );

    const t1 = renderer.getNode("t1") as FakeElement;
    const t2 = renderer.getNode("t2") as FakeElement;
    expect(t1.style.transitionProperty).toBe("transform");
    expect(t1.style.transformOrigin).toBe("top left");
    expect(t2.style.transitionProperty).toBeUndefined();
    expect(t2.style.transform).toBeUndefined();
  });

  test("natural settle dispatches { animation: 'sharedElement' } via onAnimationComplete", () => {
    const { renderer, engine, thumb, heroImg } = makeTwoRouteScene({
      "onAnimationComplete.0": "@actions.animDone",
    });
    thumb.getBoundingClientRect = () => rect(10, 20, 100, 50);
    heroImg.getBoundingClientRect = () => rect(200, 300, 200, 100);

    navigateToB(renderer);
    expect(engine.dispatchCalls.length).toBe(0); // mid-flight: nothing yet

    heroImg.dispatchEvent("transitionend", { target: heroImg });

    expect(engine.dispatchCalls).toEqual([
      { name: "animDone", payload: { animation: "sharedElement" } },
    ]);
  });

  test("an interrupted shared flight dispatches no completion", async () => {
    const { renderer, engine, thumb, heroImg } = makeTwoRouteScene({
      "onAnimationComplete.0": "@actions.animDone",
    });
    thumb.getBoundingClientRect = () => rect(0, 0, 100, 100);
    heroImg.getBoundingClientRect = () => rect(200, 300, 200, 200);

    navigateToB(renderer); // flight starts (settle backbone at 30 + 80ms)

    // A second navigation interrupts before the flight settles: heroImg
    // leaves the document with routeB. Its surviving settle backbone must
    // dispatch nothing (interrupted playbacks fire NOTHING).
    renderer.applyPatches([
      { type: "detach", id: "routeB" } as Patch,
      { type: "attach", parentId: "root-1", id: "routeA" } as Patch,
    ]);

    await sleep(170); // past both flights' settle backbones
    expect(engine.dispatchCalls).toEqual([]);
  });

  test("zero-delta match suppresses enter AND dispatches completion immediately", () => {
    const { renderer, engine } = makeSharedScene();
    const thumb = renderer.getNode("thumb") as FakeElement;
    thumb.getBoundingClientRect = () => rect(10, 20, 100, 50);

    let writes: Array<[string, string]> = [];
    withCreatedElements(
      (el, tag) => {
        if (tag === "img") {
          el.getBoundingClientRect = () => rect(10, 20, 100, 50); // same as source
          writes = recordStyleWrites(el);
        }
      },
      () =>
        renderer.applyPatches([
          { type: "detach", id: "routeA" } as Patch,
          { type: "create", id: "routeB", elementType: "Column", props: {} } as Patch,
          { type: "insert", parentId: "root-1", id: "routeB" } as Patch,
          {
            type: "create",
            id: "heroImg",
            elementType: "Image",
            props: sharedProps("hero", {
              "__anim.enter": { presets: ["fade"], duration: 30, curve: "easeOut" },
              "onAnimationComplete.0": "@actions.animDone",
            }),
          } as Patch,
          { type: "insert", parentId: "routeB", id: "heroImg" } as Patch,
        ])
    );

    const heroImg = renderer.getNode("heroImg") as FakeElement;
    // The element visually persisted: no enter pose, no FLIP playback…
    expect(writes.some(([prop]) => prop === "opacity")).toBe(false);
    expect(writes.some(([prop]) => prop === "transform")).toBe(false);
    expect(heroImg.style.transitionProperty).toBeUndefined();
    // …but the completion still fires — an instant natural settle, or
    // module machines waiting on onAnimationComplete stall.
    expect(engine.dispatchCalls).toEqual([
      { name: "animDone", payload: { animation: "sharedElement" } },
    ]);
  });

  test("a non-identity base transform composes AFTER the prepended invert and survives settle", () => {
    const { renderer, thumb, heroImg } = makeTwoRouteScene();
    thumb.getBoundingClientRect = () => rect(10, 20, 100, 50);
    heroImg.getBoundingClientRect = () => rect(200, 300, 200, 100);
    heroImg.style.transform = "scale(1.05)"; // base transform (e.g. a `.states` pose)
    const writes = recordStyleWrites(heroImg);

    navigateToB(renderer);

    // The viewport-space invert PREPENDS (CSS composes left-to-right): the
    // measured delta must not be distorted by the base's coordinate space.
    expect(
      writes.some(
        ([prop, value]) =>
          prop === "transform" &&
          value === "translate(-190px, -280px) scale(0.5, 0.5) scale(1.05)"
      )
    ).toBe(true);
    // Play target is exactly the base transform, not identity.
    expect(heroImg.style.transform).toBe("scale(1.05)");
    expect(heroImg.style.transitionProperty).toBe("transform");

    // Settle: base transform intact, pinned origin cleared.
    heroImg.dispatchEvent("transitionend", { target: heroImg });
    expect(heroImg.style.transform).toBe("scale(1.05)");
    expect(heroImg.style.transformOrigin).toBe("");
    expect(heroImg.style.transitionProperty).toBe("");
  });

  test("a `.layout` FLIP superseding a shared flight clears the pinned transform-origin", () => {
    const { renderer, thumb, heroImg } = makeTwoRouteScene({
      "__anim.layout": { duration: 30, curve: "linear" },
    });
    thumb.getBoundingClientRect = () => rect(10, 20, 100, 50);
    heroImg.getBoundingClientRect = () => rect(200, 300, 200, 100);

    navigateToB(renderer);
    expect(heroImg.style.transformOrigin).toBe("top left"); // flight in progress

    // A move patch mid-flight: the layout FLIP supersedes the shared
    // flight's settle (which therefore never runs its own unpin).
    const rects = [rect(200, 300, 200, 100), rect(200, 200, 200, 100)]; // First, Last
    heroImg.getBoundingClientRect = () => rects.shift() ?? rect(200, 200, 200, 100);
    renderer.applyPatches([
      { type: "move", parentId: "routeB", id: "heroImg" } as Patch,
    ]);

    // The pin must not leak into the new playback or beyond it.
    expect(heroImg.style.transformOrigin).toBe("");
    expect(heroImg.style.transitionProperty).toBe("transform"); // second FLIP playing

    heroImg.dispatchEvent("transitionend", { target: heroImg });
    expect(heroImg.style.transformOrigin).toBe("");
    expect(heroImg.style.transitionProperty).toBe("");
  });

  test("an exit superseding a shared flight clears the pinned transform-origin", () => {
    const { renderer, thumb, heroImg } = makeTwoRouteScene({
      "__anim.exit": { presets: ["fade"], duration: 30, curve: "easeIn" },
    });
    thumb.getBoundingClientRect = () => rect(10, 20, 100, 50);
    heroImg.getBoundingClientRect = () => rect(200, 300, 200, 100);

    navigateToB(renderer);
    expect(heroImg.style.transformOrigin).toBe("top left"); // flight in progress

    // Exit begins mid-flight: beginExit cancels the shared settle, so it
    // must clear the pin itself.
    renderer.applyPatches([{ type: "remove", id: "heroImg", transition: true } as Patch]);
    expect(heroImg.style.transformOrigin).toBe("");

    heroImg.dispatchEvent("transitionend", { target: heroImg });
    expect(renderer.getNode("heroImg")).toBeUndefined();
  });

  test("a persistent keyed node outside the detached subtree is never a source", () => {
    const { renderer } = makeBootedRenderer();
    renderer.applyPatches([
      // App-shell node sharing the key, created FIRST so first-wins would
      // shadow the real source if it were snapshotted at all.
      { type: "create", id: "shellLogo", elementType: "Image", props: sharedProps("hero") } as Patch,
      { type: "insert", parentId: "root-1", id: "shellLogo" } as Patch,
      { type: "create", id: "routeA", elementType: "Column", props: {} } as Patch,
      { type: "insert", parentId: "root-1", id: "routeA" } as Patch,
      { type: "create", id: "thumb", elementType: "Image", props: sharedProps("hero") } as Patch,
      { type: "insert", parentId: "routeA", id: "thumb" } as Patch,
    ]);
    const shellLogo = renderer.getNode("shellLogo") as FakeElement;
    const thumb = renderer.getNode("thumb") as FakeElement;
    shellLogo.getBoundingClientRect = () => rect(500, 500, 50, 50);
    thumb.getBoundingClientRect = () => rect(10, 20, 100, 50);

    let writes: Array<[string, string]> = [];
    withCreatedElements(
      (el, tag) => {
        if (tag === "img") {
          el.getBoundingClientRect = () => rect(200, 300, 200, 100);
          writes = recordStyleWrites(el);
        }
      },
      () =>
        renderer.applyPatches([
          { type: "detach", id: "routeA" } as Patch,
          { type: "create", id: "routeB", elementType: "Column", props: {} } as Patch,
          { type: "insert", parentId: "root-1", id: "routeB" } as Patch,
          { type: "create", id: "heroImg", elementType: "Image", props: sharedProps("hero") } as Patch,
          { type: "insert", parentId: "routeB", id: "heroImg" } as Patch,
        ])
    );

    // The FLIP sources from the node INSIDE the detached route (thumb),
    // never from the still-visible shell node.
    expect(
      writes.some(
        ([prop, value]) =>
          prop === "transform" && value === "translate(-190px, -280px) scale(0.5, 0.5)"
      )
    ).toBe(true);
    expect(
      writes.some(
        ([prop, value]) =>
          prop === "transform" && value === "translate(300px, 200px) scale(0.25, 0.5)"
      )
    ).toBe(false);
    // The shell node itself is untouched.
    expect(shellLogo.style.transform).toBeUndefined();
  });

  test("a key present only outside the detached subtree is not snapshotted (no FLIP)", () => {
    const { renderer } = makeBootedRenderer();
    renderer.applyPatches([
      { type: "create", id: "shellLogo", elementType: "Image", props: sharedProps("logo") } as Patch,
      { type: "insert", parentId: "root-1", id: "shellLogo" } as Patch,
      { type: "create", id: "routeA", elementType: "Column", props: {} } as Patch,
      { type: "insert", parentId: "root-1", id: "routeA" } as Patch,
    ]);
    const shellLogo = renderer.getNode("shellLogo") as FakeElement;
    let measured = 0;
    shellLogo.getBoundingClientRect = () => {
      measured += 1;
      return rect(500, 500, 50, 50);
    };

    withCreatedElements(
      (el, tag) => {
        if (tag === "img") {
          el.getBoundingClientRect = () => rect(200, 300, 200, 100);
        }
      },
      () =>
        renderer.applyPatches([
          { type: "detach", id: "routeA" } as Patch,
          { type: "create", id: "routeB", elementType: "Column", props: {} } as Patch,
          { type: "insert", parentId: "root-1", id: "routeB" } as Patch,
          { type: "create", id: "heroImg", elementType: "Image", props: sharedProps("logo") } as Patch,
          { type: "insert", parentId: "routeB", id: "heroImg" } as Patch,
        ])
    );

    // The still-visible shell node was never even measured, and the
    // incoming node degrades to a plain navigation.
    expect(measured).toBe(0);
    const heroImg = renderer.getNode("heroImg") as FakeElement;
    expect(heroImg.style.transform).toBeUndefined();
    expect(heroImg.style.transitionProperty).toBeUndefined();
  });

  test("a batch that throws mid-apply cannot leak stale snapshots into the next navigation", () => {
    const { renderer } = makeSharedScene();
    const thumb = renderer.getNode("thumb") as FakeElement;
    thumb.getBoundingClientRect = () => rect(10, 20, 100, 50);
    Object.defineProperty(thumb, "textContent", {
      configurable: true,
      get: () => "",
      set: () => {
        throw new Error("boom");
      },
    });

    // Navigation-shaped batch: the pre-pass snapshots "hero", then a later
    // patch throws — flush() never runs, so its end-of-batch cleanup is
    // skipped.
    expect(() =>
      renderer.applyPatches([
        { type: "detach", id: "routeA" } as Patch,
        { type: "create", id: "pageB", elementType: "Column", props: {} } as Patch,
        { type: "insert", parentId: "root-1", id: "pageB" } as Patch,
        { type: "setText", id: "thumb", text: "boom" } as Patch,
      ])
    ).toThrow("boom");

    // The very next batch is a navigation whose detach root (pageB) contains
    // no "hero" source: it must find nothing. Were the per-batch state not
    // reset in the pre-pass, the stale "hero" snapshot would win the
    // first-wins duplicate guard and FLIP the target from the old thumb rect.
    let writes: Array<[string, string]> = [];
    withCreatedElements(
      (el, tag) => {
        if (tag === "img") {
          el.getBoundingClientRect = () => rect(200, 300, 200, 100);
          writes = recordStyleWrites(el);
        }
      },
      () =>
        renderer.applyPatches([
          { type: "detach", id: "pageB" } as Patch,
          { type: "create", id: "heroImg", elementType: "Image", props: sharedProps("hero") } as Patch,
          { type: "insert", parentId: "root-1", id: "heroImg" } as Patch,
        ])
    );

    expect(writes.some(([prop]) => prop === "transform")).toBe(false);
    expect((renderer.getNode("heroImg") as FakeElement).style.transitionProperty).toBeUndefined();
  });

  describe("dev warnings", () => {
    /** Capture logger WARN output at the default ("info") level. */
    const captureWarns = (run: (warns: string[]) => void) => {
      const warns: string[] = [];
      const previousLevel = getLogLevel();
      setLogLevel("info"); // the out-of-the-box level — warnings must pass here
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

    test("an unmatched key warns at the default level, once per key across navigations", () => {
      captureWarns((warns) => {
        const { renderer } = makeSharedScene();
        const thumb = renderer.getNode("thumb") as FakeElement;
        thumb.getBoundingClientRect = () => rect(10, 20, 100, 50);

        // Navigation 1: "hero" is source-only → exactly one warning.
        renderer.applyPatches([
          { type: "detach", id: "routeA" } as Patch,
          { type: "create", id: "pageB", elementType: "Column", props: {} } as Patch,
          { type: "insert", parentId: "root-1", id: "pageB" } as Patch,
        ]);
        expect(warns.filter((w) => w.includes("hero")).length).toBe(1);

        // Navigation 2: back — "hero" is now target-only. The same key must
        // not warn on every navigation.
        renderer.applyPatches([
          { type: "detach", id: "pageB" } as Patch,
          { type: "attach", parentId: "root-1", id: "routeA" } as Patch,
        ]);
        expect(warns.filter((w) => w.includes("hero")).length).toBe(1);
      });
    });

    test("matched keys never produce the unmatched warning", () => {
      captureWarns((warns) => {
        const { renderer } = makeSharedScene();
        const thumb = renderer.getNode("thumb") as FakeElement;
        thumb.getBoundingClientRect = () => rect(10, 20, 100, 50);

        withCreatedElements(
          (el, tag) => {
            if (tag === "img") {
              el.getBoundingClientRect = () => rect(200, 300, 200, 100);
            }
          },
          () =>
            renderer.applyPatches([
              { type: "detach", id: "routeA" } as Patch,
              { type: "create", id: "routeB", elementType: "Column", props: {} } as Patch,
              { type: "insert", parentId: "root-1", id: "routeB" } as Patch,
              { type: "create", id: "heroImg", elementType: "Image", props: sharedProps("hero") } as Patch,
              { type: "insert", parentId: "routeB", id: "heroImg" } as Patch,
            ])
        );

        // Sanity: the key actually matched and FLIPped…
        expect((renderer.getNode("heroImg") as FakeElement).style.transitionProperty).toBe(
          "transform"
        );
        // …and no warning fired.
        expect(warns.length).toBe(0);
      });
    });

    test("a matched target with no timing spec (sanctioned snap) is not reported unmatched", () => {
      captureWarns((warns) => {
        const { renderer } = makeSharedScene();
        const thumb = renderer.getNode("thumb") as FakeElement;
        thumb.getBoundingClientRect = () => rect(10, 20, 100, 50);

        withCreatedElements(
          (el, tag) => {
            if (tag === "img") {
              el.getBoundingClientRect = () => rect(200, 300, 200, 100);
            }
          },
          () =>
            renderer.applyPatches([
              { type: "detach", id: "routeA" } as Patch,
              { type: "create", id: "routeB", elementType: "Column", props: {} } as Patch,
              { type: "insert", parentId: "root-1", id: "routeB" } as Patch,
              // Identity half only — no `__anim.shared` timing.
              {
                type: "create",
                id: "heroImg",
                elementType: "Image",
                props: { "__anim.sharedKey": "hero" },
              } as Patch,
              { type: "insert", parentId: "routeB", id: "heroImg" } as Patch,
            ])
        );

        // Sanctioned snap: no FLIP, and no misleading "source-only" report.
        expect((renderer.getNode("heroImg") as FakeElement).style.transform).toBeUndefined();
        expect(warns.length).toBe(0);
      });
    });
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

describe("`batchAnimation` transaction stamps (Option D)", () => {
  const STAMP = { type: "batchAnimation", spec: { curve: "spring", duration: 250 } } as Patch;

  test("a stamped batch glides whitelisted SetProps on a node WITHOUT .transition, restoring none after settle", () => {
    const { renderer } = makeBootedRenderer();
    renderer.applyPatches([
      { type: "create", id: "box", elementType: "Text", props: {} } as Patch,
      { type: "insert", parentId: "root-1", id: "box" } as Patch,
    ]);
    const box = renderer.getNode("box") as FakeElement;
    expect(box.style.transitionProperty).toBeUndefined();

    renderer.applyPatches([
      STAMP,
      { type: "setProp", id: "box", name: "opacity", value: 0.5 } as Patch,
    ]);

    // Transaction transition longhands were set BEFORE the prop applied,
    // scoped to exactly the props this stamped batch wrote (never the
    // whole whitelist — an unstamped write in the settle window must snap)…
    expect(box.style.transitionProperty).toBe("opacity");
    expect(box.style.transitionDuration).toBe("250ms");
    expect(box.style.transitionTimingFunction).toBe(CURVE_TO_CSS.spring);
    // …and the prop write itself landed.
    expect(box.style.getProperty("opacity")).toBe("0.5");

    // Natural settle (transitionend fast path) hands back the node's base
    // transition — none, so the longhands clear.
    box.dispatchEvent("transitionend", { target: box });
    expect(box.style.transitionProperty).toBe("");
    expect(box.style.transitionDuration).toBe("");
    expect(box.style.transitionTimingFunction).toBe("");
  });

  test("the transaction spec OVERRIDES a node's own .transition for the batch; base restored after settle", () => {
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
    expect(box.style.transitionDuration).toBe("200ms");

    renderer.applyPatches([
      { type: "batchAnimation", spec: { curve: "linear", duration: 500 } } as Patch,
      { type: "setProp", id: "box", name: "backgroundColor", value: "#ff0000" } as Patch,
    ]);

    // Transaction wins over the node's own .transition during the batch,
    // targeting only the prop the batch wrote.
    expect(box.style.transitionDuration).toBe("500ms");
    expect(box.style.transitionTimingFunction).toBe("linear");
    expect(box.style.transitionProperty).toBe("background-color");

    // Settle restores the node's OWN base transition, not "none".
    box.dispatchEvent("transitionend", { target: box });
    expect(box.style.transitionDuration).toBe("200ms");
    expect(box.style.transitionTimingFunction).toBe("ease-out");
    expect(box.style.transitionProperty).toBe(cssPropertiesFor().join(", "));
  });

  test("timeout backbone restores the base transition when transitionend never fires", async () => {
    const { renderer } = makeBootedRenderer();
    renderer.applyPatches([
      { type: "create", id: "box", elementType: "Text", props: {} } as Patch,
      { type: "insert", parentId: "root-1", id: "box" } as Patch,
    ]);
    const box = renderer.getNode("box") as FakeElement;

    renderer.applyPatches([
      { type: "batchAnimation", spec: { curve: "linear", duration: 10 } } as Patch,
      { type: "setProp", id: "box", name: "opacity", value: 0.25 } as Patch,
    ]);
    expect(box.style.transitionDuration).toBe("10ms");

    // duration (10) + grace (80) — no transitionend dispatched.
    await sleep(140);
    expect(box.style.transitionDuration).toBe("");
    expect(box.style.transitionProperty).toBe("");
  });

  test("the spec never outlives its batch — the next unstamped batch snaps", () => {
    const { renderer } = makeBootedRenderer();
    renderer.applyPatches([
      STAMP, // stamped batch (leading prelude; no whitelisted SetProps consume it)
      { type: "create", id: "box", elementType: "Text", props: {} } as Patch,
      { type: "insert", parentId: "root-1", id: "box" } as Patch,
    ]);
    const box = renderer.getNode("box") as FakeElement;

    // Next batch is UNSTAMPED: no transaction styles for its SetProps.
    renderer.applyPatches([
      { type: "setProp", id: "box", name: "opacity", value: 0.5 } as Patch,
    ]);
    expect(box.style.transitionProperty).toBeUndefined();
    expect(box.style.getProperty("opacity")).toBe("0.5");
  });

  test("non-whitelisted props never glide in a stamped batch", () => {
    const { renderer } = makeBootedRenderer();
    renderer.applyPatches([
      { type: "create", id: "box", elementType: "Text", props: {} } as Patch,
      { type: "insert", parentId: "root-1", id: "box" } as Patch,
    ]);
    const box = renderer.getNode("box") as FakeElement;

    renderer.applyPatches([
      STAMP,
      { type: "setProp", id: "box", name: "zIndex", value: 3 } as Patch,
    ]);
    expect(box.style.transitionProperty).toBeUndefined();
  });

  test("reduced motion ignores stamps entirely", async () => {
    await withReducedMotion(async () => {
      const { renderer } = makeBootedRenderer();
      renderer.applyPatches([
        { type: "create", id: "box", elementType: "Text", props: {} } as Patch,
        { type: "insert", parentId: "root-1", id: "box" } as Patch,
      ]);
      const box = renderer.getNode("box") as FakeElement;

      renderer.applyPatches([
        STAMP,
        { type: "setProp", id: "box", name: "opacity", value: 0.5 } as Patch,
      ]);

      // Snap: the prop applied, but no transaction transition styles.
      expect(box.style.transitionProperty).toBeUndefined();
      expect(box.style.getProperty("opacity")).toBe("0.5");
    });
  });

  test("a malformed spec degrades to an unstamped batch (snap)", () => {
    const { renderer } = makeBootedRenderer();
    renderer.applyPatches([
      { type: "create", id: "box", elementType: "Text", props: {} } as Patch,
      { type: "insert", parentId: "root-1", id: "box" } as Patch,
    ]);
    const box = renderer.getNode("box") as FakeElement;

    renderer.applyPatches([
      { type: "batchAnimation", spec: { curve: "not-a-curve" } } as Patch,
      { type: "setProp", id: "box", name: "opacity", value: 0.5 } as Patch,
    ]);
    expect(box.style.transitionProperty).toBeUndefined();
  });

  test("a stamped batch accumulates transition-property over exactly the props it writes", () => {
    const { renderer } = makeBootedRenderer();
    renderer.applyPatches([
      { type: "create", id: "box", elementType: "Text", props: {} } as Patch,
      { type: "insert", parentId: "root-1", id: "box" } as Patch,
    ]);
    const box = renderer.getNode("box") as FakeElement;

    renderer.applyPatches([
      STAMP,
      { type: "setProp", id: "box", name: "opacity", value: 0.5 } as Patch,
      { type: "setProp", id: "box", name: "backgroundColor", value: "#112233" } as Patch,
    ]);

    // Both written props glide; nothing else is listed.
    expect(box.style.transitionProperty).toBe("opacity, background-color");
    expect(box.style.transitionDuration).toBe("250ms");
  });

  test("an UNSTAMPED write inside the settle window snaps (base restored before the write lands)", () => {
    const { renderer } = makeBootedRenderer();
    renderer.applyPatches([
      { type: "create", id: "box", elementType: "Text", props: {} } as Patch,
      { type: "insert", parentId: "root-1", id: "box" } as Patch,
    ]);
    const box = renderer.getNode("box") as FakeElement;

    renderer.applyPatches([
      STAMP,
      { type: "setProp", id: "box", name: "opacity", value: 0.5 } as Patch,
    ]);
    expect(box.style.transitionProperty).toBe("opacity");

    // Unstamped follow-up on the SAME prop while the transaction settle is
    // still open: the transaction longhands are restored to base FIRST, so
    // this write snaps instead of gliding with the stale spec.
    renderer.applyPatches([
      { type: "setProp", id: "box", name: "opacity", value: 0.9 } as Patch,
    ]);
    expect(box.style.transitionProperty).toBe("");
    expect(box.style.transitionDuration).toBe("");
    expect(box.style.getProperty("opacity")).toBe("0.9");
  });

  test("back-to-back stamped batches retarget the same node before the first settles", () => {
    const { renderer } = makeBootedRenderer();
    renderer.applyPatches([
      { type: "create", id: "box", elementType: "Text", props: {} } as Patch,
      { type: "insert", parentId: "root-1", id: "box" } as Patch,
    ]);
    const box = renderer.getNode("box") as FakeElement;

    renderer.applyPatches([
      { type: "batchAnimation", spec: { curve: "linear", duration: 400 } } as Patch,
      { type: "setProp", id: "box", name: "opacity", value: 0.5 } as Patch,
    ]);
    expect(box.style.transitionDuration).toBe("400ms");

    // Second stamped batch lands before the first settles: the node glides
    // with the NEW spec (its prop list, its timing) — not the stale one.
    renderer.applyPatches([
      { type: "batchAnimation", spec: { curve: "spring", duration: 120 } } as Patch,
      { type: "setProp", id: "box", name: "backgroundColor", value: "#445566" } as Patch,
    ]);
    expect(box.style.transitionDuration).toBe("120ms");
    expect(box.style.transitionTimingFunction).toBe(CURVE_TO_CSS.spring);
    expect(box.style.transitionProperty).toBe("background-color");

    // The (single) settle restores the true base — no transaction residue.
    box.dispatchEvent("transitionend", { target: box });
    expect(box.style.transitionProperty).toBe("");
    expect(box.style.transitionDuration).toBe("");
  });

  test("a stamped batch NEVER touches a node with an in-flight enter (playback wins; preset resumes)", () => {
    const { renderer } = makeBootedRenderer();
    // Node with an enter AND a pulse preset (pulse keyframes own opacity, so
    // the enter suspends it with an inline `animation: none`).
    renderer.applyPatches([
      {
        type: "create",
        id: "box",
        elementType: "Text",
        props: {
          "__anim.enter": { presets: ["fade"], duration: 60, curve: "easeOut" },
          "__anim.animate": { preset: "pulse", duration: 100, curve: "linear", repeat: "loop" },
        },
      } as Patch,
      { type: "insert", parentId: "root-1", id: "box" } as Patch,
    ]);
    const box = renderer.getNode("box") as FakeElement;
    // Enter in flight: transition targets the pose props, preset suspended.
    expect(box.style.transitionProperty).toBe("opacity");
    expect(box.style.transitionDuration).toBe("60ms");
    expect(box.style.getProperty("animation")).toBe("none");

    // Stamped batch touching the mid-enter node: EXCLUDED — the enter's
    // transition styles are untouched (no snap), the settle stays the
    // enter's own.
    renderer.applyPatches([
      { type: "batchAnimation", spec: { curve: "linear", duration: 500 } } as Patch,
      { type: "setProp", id: "box", name: "backgroundColor", value: "#123456" } as Patch,
    ]);
    expect(box.style.transitionProperty).toBe("opacity");
    expect(box.style.transitionDuration).toBe("60ms");

    // Natural enter settle: base restored AND the preset suspension lifted
    // (the takeover contract a transaction settle must never bypass).
    box.dispatchEvent("transitionend", { target: box });
    expect(box.style.transitionProperty).toBe("");
    expect(box.style.getProperty("animation")).toBeUndefined();
  });

  test("mid-array batchAnimation patches are NOT stamps (first-patch contract)", () => {
    const { renderer } = makeBootedRenderer();
    renderer.applyPatches([
      { type: "create", id: "box", elementType: "Text", props: {} } as Patch,
      { type: "insert", parentId: "root-1", id: "box" } as Patch,
    ]);
    const box = renderer.getNode("box") as FakeElement;

    // Stamp buried mid-array (e.g. concatenated batches): ignored entirely —
    // even for SetProps that FOLLOW it.
    renderer.applyPatches([
      { type: "setProp", id: "box", name: "opacity", value: 0.4 } as Patch,
      STAMP,
      { type: "setProp", id: "box", name: "backgroundColor", value: "#abcdef" } as Patch,
    ]);
    expect(box.style.transitionProperty).toBeUndefined();
    expect(box.style.getProperty("opacity")).toBe("0.4");
  });
});

describe("`batchAnimation` replication into canvas sub-batches", () => {
  const STAMP = { type: "batchAnimation", spec: { curve: "spring", duration: 250 } } as Patch;

  /** Renderer with a recorded fake CanvasRenderer owning subtree node "child". */
  const makeCanvasRouted = () => {
    const made = makeBootedRenderer();
    const received: Patch[][] = [];
    const fakeCanvas = { applyPatches: (batch: Patch[]) => received.push([...batch]) };
    (made.renderer as any).canvasRenderers.set("cv", fakeCanvas);
    (made.renderer as any).canvasSubtreeMap.set("child", "cv");
    return { ...made, received };
  };

  test("a leading stamp is replicated at index 0 of every canvas sub-batch", () => {
    const { renderer, received } = makeCanvasRouted();

    renderer.applyPatches([
      STAMP,
      { type: "setProp", id: "child", name: "opacity", value: 0.5 } as Patch,
    ]);

    expect(received.length).toBe(1);
    expect(received[0][0].type).toBe("batchAnimation");
    expect((received[0][0] as any).spec).toEqual({ curve: "spring", duration: 250 });
    expect(received[0][1].type).toBe("setProp");
  });

  test("a mid-array batchAnimation is NOT replicated (first-patch contract)", () => {
    const { renderer, received } = makeCanvasRouted();

    renderer.applyPatches([
      { type: "setProp", id: "child", name: "opacity", value: 0.5 } as Patch,
      STAMP,
    ]);

    expect(received.length).toBe(1);
    expect(received[0].some((p) => p.type === "batchAnimation")).toBe(false);
  });
});

describe("`batchAnimation` + legacy string `.transition(\"...\")` inline styles", () => {
  const STAMP = { type: "batchAnimation", spec: { curve: "spring", duration: 250 } } as Patch;

  test("a legacy-styled node glides under a stamp and keeps its inline transition afterwards", () => {
    const { renderer } = makeBootedRenderer();
    renderer.applyPatches([
      // Legacy string passthrough applicator: writes el.style.transition.
      {
        type: "create",
        id: "box",
        elementType: "Text",
        props: { "transition.0": "opacity 0.3s ease" },
      } as Patch,
      { type: "insert", parentId: "root-1", id: "box" } as Patch,
    ]);
    const box = renderer.getNode("box") as FakeElement;
    // Simulate the longhands a real DOM derives from the shorthand (fake-dom
    // doesn't expand shorthands).
    box.style.transitionProperty = "opacity";
    box.style.transitionDuration = "0.3s";
    box.style.transitionTimingFunction = "ease";
    expect(box.style.transition).toBe("opacity 0.3s ease");

    renderer.applyPatches([
      STAMP,
      { type: "setProp", id: "box", name: "opacity", value: 0.5 } as Patch,
    ]);
    // Transaction overrode the inline values for the glide…
    expect(box.style.transitionDuration).toBe("250ms");

    // …and settle restores the CAPTURED inline values verbatim — not a
    // recompute from the (absent) __anim.transition spec, which would have
    // cleared the legacy styling permanently.
    box.dispatchEvent("transitionend", { target: box });
    expect(box.style.transition).toBe("opacity 0.3s ease");
    expect(box.style.transitionProperty).toBe("opacity");
    expect(box.style.transitionDuration).toBe("0.3s");
    expect(box.style.transitionTimingFunction).toBe("ease");
  });
});

describe("`.motion(essential)` reduced-motion opt-out (#149)", () => {
  const MOTION = "__anim.motion";
  const essential = { essential: true };
  const enterSpec = { presets: ["fade"], duration: 30, curve: "easeOut" };
  const exitSpec = { presets: ["fade"], duration: 30, curve: "easeIn" };

  test("create stamps the attribute; setProp/removeProp track the flag", () => {
    const { renderer } = makeBootedRenderer();
    renderer.applyPatches([
      { type: "create", id: "spin", elementType: "Text", props: { [MOTION]: essential } } as Patch,
      { type: "insert", parentId: "root-1", id: "spin" } as Patch,
      { type: "create", id: "plain", elementType: "Text", props: {} } as Patch,
      { type: "insert", parentId: "root-1", id: "plain" } as Patch,
    ]);
    const spin = renderer.getNode("spin") as FakeElement;
    const plain = renderer.getNode("plain") as FakeElement;
    expect(spin.getAttribute(MOTION_ESSENTIAL_ATTR)).not.toBeNull();
    expect(plain.getAttribute(MOTION_ESSENTIAL_ATTR)).toBeNull();

    // RemoveProp reverts the stamp.
    renderer.applyPatches([{ type: "removeProp", id: "spin", name: MOTION } as Patch]);
    expect(spin.getAttribute(MOTION_ESSENTIAL_ATTR)).toBeNull();

    // SetProp re-stamps; a malformed value un-stamps (defensive parse).
    renderer.applyPatches([{ type: "setProp", id: "spin", name: MOTION, value: essential } as Patch]);
    expect(spin.getAttribute(MOTION_ESSENTIAL_ATTR)).not.toBeNull();
    renderer.applyPatches([
      { type: "setProp", id: "spin", name: MOTION, value: { essential: "yes" } } as Patch,
    ]);
    expect(spin.getAttribute(MOTION_ESSENTIAL_ATTR)).toBeNull();
  });

  test("the global stylesheets exempt stamped nodes from the reduced-motion kill", () => {
    makeRenderer(); // injects both sheets
    const a11y = (globalThis as any).document.getElementById("hypen-a11y-styles");
    expect(a11y.textContent).toContain(
      "[data-hypen-id]:not([data-hypen-motion-essential])"
    );
    // The exemption lives INSIDE the reduced-motion media block, and no
    // unguarded [data-hypen-id] kill remains.
    expect(a11y.textContent).not.toContain("[data-hypen-id] {\n    transition: none");
    const anim = (globalThis as any).document.getElementById("hypen-anim-styles");
    expect(anim.textContent).toContain(
      ".hypen-anim-shimmer:not([data-hypen-motion-essential])::after"
    );
  });

  test("essential enter plays under reduced motion; non-essential still snaps", async () => {
    await withReducedMotion(() => {
      const { renderer } = makeBootedRenderer();
      renderer.applyPatches([
        {
          type: "create",
          id: "toast",
          elementType: "Text",
          props: { "__anim.enter": enterSpec, [MOTION]: essential },
        } as Patch,
        { type: "insert", parentId: "root-1", id: "toast" } as Patch,
        {
          type: "create",
          id: "plain",
          elementType: "Text",
          props: { "__anim.enter": enterSpec },
        } as Patch,
        { type: "insert", parentId: "root-1", id: "plain" } as Patch,
      ]);

      const toast = renderer.getNode("toast") as FakeElement;
      expect(toast.style.transitionProperty).toBe("opacity");
      expect(toast.style.transitionDuration).toBe("30ms");

      const plain = renderer.getNode("plain") as FakeElement;
      expect(plain.style.transitionDuration).toBeUndefined();
      expect(plain.style.opacity).toBeUndefined();
    });
  });

  test("essential exit defers under reduced motion; non-essential finalizes on a microtask", async () => {
    await withReducedMotion(async () => {
      const { renderer, container } = makeBootedRenderer();
      renderer.applyPatches([
        {
          type: "create",
          id: "toast",
          elementType: "Text",
          props: { "__anim.exit": exitSpec, [MOTION]: essential },
        } as Patch,
        { type: "insert", parentId: "root-1", id: "toast" } as Patch,
        {
          type: "create",
          id: "plain",
          elementType: "Text",
          props: { "__anim.exit": exitSpec },
        } as Patch,
        { type: "insert", parentId: "root-1", id: "plain" } as Patch,
      ]);
      const toast = renderer.getNode("toast") as FakeElement;
      const root = renderer.getNode("root-1") as FakeElement;

      renderer.applyPatches([
        { type: "remove", id: "toast", transition: true } as Patch,
        { type: "remove", id: "plain", transition: true } as Patch,
      ]);

      // Essential: exit playback in flight — still in the DOM, marked inert.
      expect(root.children).toContain(toast);
      expect(toast.getAttribute(EXITING_ATTR)).not.toBeNull();
      expect(toast.style.transitionProperty).toBe("opacity");
      expect(toast.style.opacity).toBe("0");

      // Non-essential: reduced-motion snap — gone after the microtask.
      await sleep(0);
      expect(renderer.getNode("plain")).toBeUndefined();
      expect(renderer.getNode("toast")).toBeDefined();

      // The essential exit settles normally.
      toast.dispatchEvent("transitionend", { target: toast });
      expect(renderer.getNode("toast")).toBeUndefined();
      void container;
    });
  });

  test("essential `.animate` preset keeps its class (stylesheet exemption plays it)", async () => {
    await withReducedMotion(() => {
      const { renderer } = makeBootedRenderer();
      renderer.applyPatches([
        {
          type: "create",
          id: "spin",
          elementType: "Text",
          props: {
            "__anim.animate": { preset: "spin", duration: 800, repeat: "loop", curve: "linear" },
            [MOTION]: essential,
          },
        } as Patch,
        { type: "insert", parentId: "root-1", id: "spin" } as Patch,
      ]);
      const spin = renderer.getNode("spin") as FakeElement;
      // The class + vars are applied and the attribute exempts the node from
      // the stylesheet kill — the preset actually runs under reduced motion.
      expect(spin.classList.contains("hypen-anim-spin")).toBe(true);
      expect(spin.getAttribute(MOTION_ESSENTIAL_ATTR)).not.toBeNull();
    });
  });

  test("essential `.transition` glide: longhands + attribute survive reduced motion", async () => {
    await withReducedMotion(() => {
      const { renderer } = makeBootedRenderer();
      renderer.applyPatches([
        {
          type: "create",
          id: "box",
          elementType: "Text",
          props: {
            "__anim.transition": { duration: 200, curve: "easeOut" },
            [MOTION]: essential,
          },
        } as Patch,
        { type: "insert", parentId: "root-1", id: "box" } as Patch,
      ]);
      const box = renderer.getNode("box") as FakeElement;
      // Inline longhands present AND the attribute exempts them from the
      // `transition: none !important` kill — the glide is real.
      expect(box.style.transitionDuration).toBe("200ms");
      expect(box.getAttribute(MOTION_ESSENTIAL_ATTR)).not.toBeNull();
    });
  });

  test("transaction stamps glide essential nodes under reduced motion; others snap", async () => {
    await withReducedMotion(() => {
      const { renderer } = makeBootedRenderer();
      renderer.applyPatches([
        { type: "create", id: "e", elementType: "Text", props: { [MOTION]: essential } } as Patch,
        { type: "insert", parentId: "root-1", id: "e" } as Patch,
        { type: "create", id: "p", elementType: "Text", props: {} } as Patch,
        { type: "insert", parentId: "root-1", id: "p" } as Patch,
      ]);
      renderer.applyPatches([
        { type: "batchAnimation", spec: { curve: "linear", duration: 100 } } as Patch,
        { type: "setProp", id: "e", name: "backgroundColor", value: "#ff0000" } as Patch,
        { type: "setProp", id: "p", name: "backgroundColor", value: "#00ff00" } as Patch,
      ]);
      const e = renderer.getNode("e") as FakeElement;
      const p = renderer.getNode("p") as FakeElement;
      expect(e.style.transitionProperty).toBe("background-color");
      expect(e.style.transitionDuration).toBe("100ms");
      expect(p.style.transitionProperty).toBeUndefined();
    });
  });

  test("`.states` settle fires the completion for essential nodes under reduced motion", async () => {
    await withReducedMotion(async () => {
      const { renderer, engine } = makeBootedRenderer();
      renderer.applyPatches([
        {
          type: "create",
          id: "card",
          elementType: "Column",
          props: {
            "__anim.transition": { duration: 30, curve: "easeOut" },
            "__anim.states": { label: "collapsed" },
            [MOTION]: essential,
            "onAnimationComplete.0": "@actions.animDone",
          },
        } as Patch,
        { type: "insert", parentId: "root-1", id: "card" } as Patch,
      ]);
      renderer.applyPatches([
        { type: "setProp", id: "card", name: "__anim.states", value: { label: "expanded" } } as Patch,
      ]);
      await sleep(60);
      expect(engine.dispatchCalls).toEqual([
        { name: "animDone", payload: { animation: "states", state: "expanded" } },
      ]);
    });
  });

  test("flag removal reverts: later playbacks snap again under reduced motion", async () => {
    await withReducedMotion(async () => {
      const { renderer } = makeBootedRenderer();
      renderer.applyPatches([
        {
          type: "create",
          id: "toast",
          elementType: "Text",
          props: { "__anim.exit": exitSpec, [MOTION]: essential },
        } as Patch,
        { type: "insert", parentId: "root-1", id: "toast" } as Patch,
      ]);
      renderer.applyPatches([{ type: "removeProp", id: "toast", name: MOTION } as Patch]);

      renderer.applyPatches([{ type: "remove", id: "toast", transition: true } as Patch]);
      // No exit playback: reduced-motion snap applies again.
      await sleep(0);
      expect(renderer.getNode("toast")).toBeUndefined();
    });
  });
});

describe("`.layout` sibling-shift on removal (#146)", () => {
  const layoutProps = { "__anim.layout": { duration: 30, curve: "spring" } };
  const exitSpec = { presets: ["fade"], duration: 30, curve: "easeIn" };

  const rect = (left: number, top: number) => ({
    left,
    top,
    right: left + 100,
    bottom: top + 20,
    width: 100,
    height: 20,
  });

  test("a plain remove FLIPs a `.layout` sibling from its pre-removal rect", () => {
    const { renderer } = makeBootedRenderer();
    renderer.applyPatches([
      { type: "create", id: "gone", elementType: "Text", props: {} } as Patch,
      { type: "insert", parentId: "root-1", id: "gone" } as Patch,
      { type: "create", id: "b", elementType: "Text", props: layoutProps } as Patch,
      { type: "insert", parentId: "root-1", id: "b" } as Patch,
    ]);
    const b = renderer.getNode("b") as FakeElement;
    const rects = [rect(0, 100), rect(0, 0)]; // First (pre-pass), Last (flush)
    b.getBoundingClientRect = () => rects.shift() ?? rect(0, 0);
    const writes = recordStyleWrites(b);

    renderer.applyPatches([{ type: "remove", id: "gone" } as Patch]);

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

  test("a flagged remove FLIPs siblings at exit finalize, not at patch time", async () => {
    const { renderer } = makeBootedRenderer();
    renderer.applyPatches([
      { type: "create", id: "gone", elementType: "Text", props: { "__anim.exit": exitSpec } } as Patch,
      { type: "insert", parentId: "root-1", id: "gone" } as Patch,
      { type: "create", id: "b", elementType: "Text", props: layoutProps } as Patch,
      { type: "insert", parentId: "root-1", id: "b" } as Patch,
    ]);
    const gone = renderer.getNode("gone") as FakeElement;
    const b = renderer.getNode("b") as FakeElement;
    // While the exit plays, the corpse still occupies flow: pre-pass and
    // flush both measure (0, 100) — zero delta, no FLIP at patch time. At
    // finalize the sibling actually shifts: First (0, 100) → Last (0, 0).
    const rects = [rect(0, 100), rect(0, 100), rect(0, 100), rect(0, 0)];
    b.getBoundingClientRect = () => rects.shift() ?? rect(0, 0);

    renderer.applyPatches([{ type: "remove", id: "gone", transition: true } as Patch]);

    // Exit in flight: sibling untouched (zero delta at flush).
    expect(b.style.transform).toBeUndefined();
    expect(b.style.transitionProperty).toBeUndefined();

    const writes = recordStyleWrites(b);
    gone.dispatchEvent("transitionend", { target: gone });

    // Teardown happened, then the sibling FLIPped from its pre-shift rect.
    expect(renderer.getNode("gone")).toBeUndefined();
    const invertIndex = writes.findIndex(
      ([prop, value]) => prop === "transform" && value === "translate(0px, 100px)",
    );
    expect(invertIndex).toBeGreaterThanOrEqual(0);
    expect(b.style.transform).toBe("");
    expect(b.style.transitionProperty).toBe("transform");
    expect(b.style.transitionDuration).toBe("30ms");
  });

  test("non-layout siblings never measure or animate on removal", () => {
    const { renderer } = makeBootedRenderer();
    renderer.applyPatches([
      { type: "create", id: "gone", elementType: "Text", props: {} } as Patch,
      { type: "insert", parentId: "root-1", id: "gone" } as Patch,
      { type: "create", id: "b", elementType: "Text", props: {} } as Patch,
      { type: "insert", parentId: "root-1", id: "b" } as Patch,
    ]);
    const b = renderer.getNode("b") as FakeElement;
    let measured = 0;
    b.getBoundingClientRect = () => {
      measured += 1;
      return rect(0, measured * 100);
    };

    renderer.applyPatches([{ type: "remove", id: "gone" } as Patch]);

    expect(measured).toBe(0);
    expect(b.style.transitionProperty).toBeUndefined();
  });

  test("an exiting sibling is excluded (exit wins over the removal FLIP)", async () => {
    const { renderer } = makeBootedRenderer();
    renderer.applyPatches([
      { type: "create", id: "gone", elementType: "Text", props: {} } as Patch,
      { type: "insert", parentId: "root-1", id: "gone" } as Patch,
      {
        type: "create",
        id: "b",
        elementType: "Text",
        props: { ...layoutProps, "__anim.exit": exitSpec },
      } as Patch,
      { type: "insert", parentId: "root-1", id: "b" } as Patch,
    ]);
    const b = renderer.getNode("b") as FakeElement;
    b.getBoundingClientRect = () => rect(0, 100);

    // b starts exiting in the same batch that removes its sibling: the exit
    // owns b — no removal FLIP may retarget its transition styles.
    renderer.applyPatches([
      { type: "remove", id: "b", transition: true } as Patch,
      { type: "remove", id: "gone" } as Patch,
    ]);

    expect(b.style.transform).toBeUndefined();
    expect(b.style.transitionProperty).toBe("opacity"); // the exit's, not "transform"
    b.dispatchEvent("transitionend", { target: b });
  });

  test("reduced motion: removal FLIP skips non-essential siblings, plays essential ones", async () => {
    await withReducedMotion(() => {
      const { renderer } = makeBootedRenderer();
      renderer.applyPatches([
        { type: "create", id: "gone", elementType: "Text", props: {} } as Patch,
        { type: "insert", parentId: "root-1", id: "gone" } as Patch,
        { type: "create", id: "b", elementType: "Text", props: layoutProps } as Patch,
        { type: "insert", parentId: "root-1", id: "b" } as Patch,
        {
          type: "create",
          id: "c",
          elementType: "Text",
          props: { ...layoutProps, "__anim.motion": { essential: true } },
        } as Patch,
        { type: "insert", parentId: "root-1", id: "c" } as Patch,
      ]);
      const b = renderer.getNode("b") as FakeElement;
      const c = renderer.getNode("c") as FakeElement;
      const bRects = [rect(0, 100), rect(0, 0)];
      const cRects = [rect(0, 200), rect(0, 100)];
      b.getBoundingClientRect = () => bRects.shift() ?? rect(0, 0);
      c.getBoundingClientRect = () => cRects.shift() ?? rect(0, 100);

      renderer.applyPatches([{ type: "remove", id: "gone" } as Patch]);

      expect(b.style.transform).toBeUndefined(); // snapped
      expect(c.style.transform).toBe(""); // FLIPped back to identity
      expect(c.style.transitionProperty).toBe("transform");
    });
  });
});
