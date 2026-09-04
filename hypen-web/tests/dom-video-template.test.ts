/**
 * Video + Scrubber through the DOM renderer's TEMPLATE INSTANTIATION path.
 *
 * The engine emits `registerTemplate` + `instantiate` for every plannable
 * ForEach row (an all-Element subtree), and the DOM renderer materializes
 * those rows by `cloneNode(true)`-ing a single prototype. A clone inherits
 * the DOM and nothing else — WeakMap entries keyed by the element and all
 * event listeners belong to the prototype alone — so components that keep
 * per-element state (Video's surface/state maps, the Scrubber's parts map
 * plus its pointer/keyboard listeners) MUST re-adopt the clone.
 *
 * Without adoption a Video or Scrubber in a list row is completely inert: no
 * src, no media listeners, no bind, no interaction — a visible but dead
 * player. These tests drive REAL registerTemplate/instantiate patches through
 * DOMRenderer and assert the row behaves exactly like a `create`-built one.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DOMRenderer } from "../packages/web/src/dom/renderer";
import {
  getVideoSurface,
  getVideoBindPath,
} from "../packages/web/src/dom/components/video";
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
  clear(): void {
    this.actions.length = 0;
  }
}

/** Media-element behaviours the component touches (as in dom-video-v2). */
function equipMedia(media: any, duration = 100): void {
  media.currentTime = 0;
  media.duration = duration;
  media.paused = true;
  media.ended = false;
  media.play = () => {
    media.paused = false;
    media.dispatchEvent("play");
    return Promise.resolve();
  };
  media.pause = () => {
    media.paused = true;
    media.dispatchEvent("pause");
  };
}

/**
 * One list row: a Video with a `controls` slot holding a Scrubber — the
 * shape the contract's composition example uses, and an all-Element subtree
 * the engine always plans as a template.
 */
const registerRow: Patch = {
  type: "registerTemplate",
  templateId: "row",
  root: {
    elementType: "Video",
    props: {
      controls: true,
      poster: "https://cdn/poster.jpg",
      bind: "playback",
      onPlay: "@actions.played",
    },
    children: [
      {
        elementType: "Column",
        props: { "slot.0": "controls" },
        children: [{ elementType: "Scrubber", props: {}, children: [] }],
      },
    ],
  },
} as unknown as Patch;

function instantiateRow(nodes: string[], src: string): Patch {
  return {
    type: "instantiate",
    templateId: "row",
    parentId: "list",
    nodes,
    // The per-row dynamic prop, exactly as `plan_instantiation` lowers it.
    subs: [[0, "src", src]],
    nodeSemantics: [],
  } as unknown as Patch;
}

function makeRenderer() {
  const container = document.createElement("div");
  const engine = new RecordingEngine();
  const renderer = new DOMRenderer(container, engine as unknown as Engine);
  renderer.applyPatches([
    { type: "create", id: "list", elementType: "Column", props: {} } as Patch,
    { type: "insert", parentId: "root", id: "list" } as Patch,
  ]);
  return { container, engine, renderer };
}

function nodeOf(renderer: DOMRenderer, id: string): FakeElement {
  return renderer.getNode(id) as unknown as FakeElement;
}

function withTrackWidth(el: FakeElement, width = 200): FakeElement {
  el.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    right: width,
    bottom: 16,
    width,
    height: 16,
  });
  return el;
}

beforeEach(() => {
  ensureFakeDomGlobals();
});

afterEach(() => {
  // no global overrides in this file
});

describe("Video through registerTemplate/instantiate", () => {
  test("a cloned Video applies its per-instance src and drives its own state machine", () => {
    const { renderer } = makeRenderer();
    renderer.applyPatches([
      registerRow,
      instantiateRow(["v1", "c1", "s1"], "https://cdn/ep1.mp4"),
      instantiateRow(["v2", "c2", "s2"], "https://cdn/ep2.mp4"),
    ]);

    const rootA = nodeOf(renderer, "v1");
    const rootB = nodeOf(renderer, "v2");
    const mediaA = getVideoSurface(rootA as unknown as HTMLElement) as any;
    const mediaB = getVideoSurface(rootB as unknown as HTMLElement) as any;

    // The surface is re-findable on both clones (the regression: it was not).
    expect(mediaA).not.toBeNull();
    expect(mediaB).not.toBeNull();
    expect(mediaA).not.toBe(mediaB);

    // Each row loaded its OWN source…
    expect(mediaA.src).toBe("https://cdn/ep1.mp4");
    expect(mediaB.src).toBe("https://cdn/ep2.mp4");
    // …and the prototype's static props were replayed onto every clone
    // (`poster` reaches the surface; `controls` is recorded but suppressed
    // by the present `controls` slot, per the contract).
    expect(mediaA.poster).toBe("https://cdn/poster.jpg");
    expect(mediaB.poster).toBe("https://cdn/poster.jpg");
    expect(mediaA.controls).toBe(false);

    // Independent state machines: driving one row leaves the other alone.
    equipMedia(mediaA);
    equipMedia(mediaB);
    expect(rootA.dataset.hypenVideoState).toBe("loading");
    mediaA.dispatchEvent("canplay");
    mediaA.dispatchEvent("play");
    expect(rootA.dataset.hypenVideoState).toBe("playing");
    expect(rootB.dataset.hypenVideoState).toBe("loading");
  });

  test("a cloned Video dispatches its media events", () => {
    const { renderer, engine } = makeRenderer();
    renderer.applyPatches([
      registerRow,
      instantiateRow(["v1", "c1", "s1"], "https://cdn/ep1.mp4"),
    ]);
    const media = getVideoSurface(
      nodeOf(renderer, "v1") as unknown as HTMLElement
    ) as any;
    equipMedia(media);
    engine.clear();

    media.dispatchEvent("play");

    expect(engine.actionsNamed("played").map((a) => a.payload)).toEqual([
      { type: "play", src: "https://cdn/ep1.mp4", index: 0 },
    ]);
  });

  test("a cloned Video honors its bind (reports out, and applies inbound writes)", async () => {
    const { renderer, engine } = makeRenderer();
    renderer.applyPatches([
      registerRow,
      instantiateRow(["v1", "c1", "s1"], "https://cdn/ep1.mp4"),
    ]);
    const root = nodeOf(renderer, "v1");
    const media = getVideoSurface(root as unknown as HTMLElement) as any;
    equipMedia(media);

    // The static `bind` path survived cloning.
    expect(getVideoBindPath(root as unknown as HTMLElement)).toBe("playback");

    await flushMicrotasks(2);
    engine.clear();

    // Renderer → state: a transition reports immediately on the bound path.
    media.dispatchEvent("canplay");
    media.dispatchEvent("play");
    const binds = engine
      .actionsNamed("__hypen_bind")
      .map((a) => a.payload.path);
    expect(binds).toContain("playback.state");
    expect(binds).toContain("playback.playing");

    // State → renderer: an inbound seek reaches the cloned element.
    renderer.applyPatches([
      {
        type: "setProp",
        id: "v1",
        name: "playback",
        value: { playing: true, position: 42 },
      } as Patch,
    ]);
    expect(media.currentTime).toBe(42);
  });

  test("slot children of a cloned Video are overlaid and visibility-managed", () => {
    const { renderer } = makeRenderer();
    renderer.applyPatches([
      registerRow,
      instantiateRow(["v1", "c1", "s1"], "https://cdn/ep1.mp4"),
    ]);
    const slot = nodeOf(renderer, "c1");

    // The `.slot("controls")` marker survives into the instance…
    expect(slot.dataset.hypenSlot).toBe("controls");
    // …and the slot child is positioned full-bleed over the surface.
    expect(slot.style.getPropertyValue("position")).toBe("absolute");
    // `controls` is visible in `loading`, so it is not hidden.
    expect(slot.style.getPropertyValue("display")).not.toBe("none");
  });
});

describe("Scrubber through registerTemplate/instantiate", () => {
  test("a cloned Scrubber has working pointer interaction and commits on release", () => {
    const { renderer, engine } = makeRenderer();
    renderer.applyPatches([
      registerRow,
      instantiateRow(["v1", "c1", "s1"], "https://cdn/ep1.mp4"),
    ]);
    const media = getVideoSurface(
      nodeOf(renderer, "v1") as unknown as HTMLElement
    ) as any;
    equipMedia(media, 100);
    const scrubber = withTrackWidth(nodeOf(renderer, "s1"));
    engine.clear();

    // Wired to the enclosing player: not inert.
    expect(scrubber.getAttribute("aria-disabled")).toBeNull();

    scrubber.dispatchEvent("pointerdown", { clientX: 100, pointerId: 1 });
    // Drag previews locally — no commit yet.
    expect(scrubber.getAttribute("aria-valuenow")).toBe("50");
    expect(engine.actions.length).toBe(0);

    scrubber.dispatchEvent("pointermove", { clientX: 150, pointerId: 1 });
    expect(scrubber.getAttribute("aria-valuenow")).toBe("75");

    scrubber.dispatchEvent("pointerup", { clientX: 150, pointerId: 1 });
    expect(media.currentTime).toBe(75);
    // Commit resolution: no own bind → the enclosing Video's bind.
    expect(engine.actionsNamed("__hypen_bind").map((a) => a.payload)).toEqual([
      { path: "playback.position", value: 75 },
    ]);
  });

  test("a cloned Scrubber tracks its OWN row's playback", async () => {
    const { renderer } = makeRenderer();
    renderer.applyPatches([
      registerRow,
      instantiateRow(["v1", "c1", "s1"], "https://cdn/ep1.mp4"),
      instantiateRow(["v2", "c2", "s2"], "https://cdn/ep2.mp4"),
    ]);
    const mediaA = getVideoSurface(
      nodeOf(renderer, "v1") as unknown as HTMLElement
    ) as any;
    const mediaB = getVideoSurface(
      nodeOf(renderer, "v2") as unknown as HTMLElement
    ) as any;
    equipMedia(mediaA, 100);
    equipMedia(mediaB, 100);
    const scrubberA = withTrackWidth(nodeOf(renderer, "s1"));
    const scrubberB = withTrackWidth(nodeOf(renderer, "s2"));
    await flushMicrotasks(2);

    mediaA.currentTime = 25;
    mediaA.dispatchEvent("timeupdate");

    expect(scrubberA.getAttribute("aria-valuenow")).toBe("25");
    expect(scrubberB.getAttribute("aria-valuenow")).toBe("0");
  });

  test("a cloned Scrubber's keyboard seek commits", () => {
    const { renderer, engine } = makeRenderer();
    renderer.applyPatches([
      registerRow,
      instantiateRow(["v1", "c1", "s1"], "https://cdn/ep1.mp4"),
    ]);
    const media = getVideoSurface(
      nodeOf(renderer, "v1") as unknown as HTMLElement
    ) as any;
    equipMedia(media, 100);
    media.currentTime = 20;
    const scrubber = withTrackWidth(nodeOf(renderer, "s1"));
    engine.clear();

    scrubber.dispatchEvent("keydown", { key: "ArrowRight" });

    expect(media.currentTime).toBe(25);
    expect(engine.actionsNamed("__hypen_bind").map((a) => a.payload)).toEqual([
      { path: "playback.position", value: 25 },
    ]);
  });
});
