/**
 * `.dropZone(files: true, accept:)` on the DOM renderer (docs/dnd.md, "Files
 * from the OS"): while files dragged in from outside the page hover an
 * enabled files zone, the runtime `over` pose applies (innermost zone wins,
 * one at a time) and clears on leave / drop; `accept` filters on the drag's
 * item types; `.onFileDragEnter` on the zone fires once per entry (never
 * twice); a release is swallowed. In-app drags are unaffected.
 *
 * Renderer driven with raw patches over fake-dom (the dom-dnd.test.ts idiom);
 * native drag events are bubbled with a fake `dataTransfer`.
 */
import { describe, expect, test } from "bun:test";
import { DOMRenderer } from "../packages/web/src/dom/renderer";
import type { Patch } from "../packages/core/src/types";
import type { IEngine as Engine } from "../packages/core/src/app";
import { fileDragMatchesAccept, parseDndZone } from "../packages/core/src/dnd";
import { ensureFakeDomGlobals, FakeElement } from "./fake-dom";

ensureFakeDomGlobals();

class StubEngine {
  public dispatchCalls: Array<{ name: string; payload: any }> = [];
  dispatchAction(name: string, payload: any): void {
    if (name === "__hypen_dispatch") {
      name = payload.action;
      payload = payload.payload;
    }
    this.dispatchCalls.push({ name, payload });
  }
}

const OVER_POSE = {
  "backgroundColor.0": "#fff",
  "__anim.states": { label: null, runtime: true },
  "__anim.statePoses": { over: { "backgroundColor.0": "#eef" } },
};

const makeRenderer = () => {
  const container = document.createElement("div");
  const engine = new StubEngine();
  const renderer = new DOMRenderer(container, engine as unknown as Engine);
  renderer.applyPatches([
    { type: "create", id: "root-1", elementType: "Column", props: {} } as Patch,
    { type: "insert", parentId: "root", id: "root-1" } as Patch,
  ]);
  return { engine, renderer, dnd: renderer.getDnd() };
};

const mount = (renderer: DOMRenderer, id: string, props: Record<string, unknown>, parent = "root-1") => {
  renderer.applyPatches([
    { type: "create", id, elementType: "Column", props } as Patch,
    { type: "insert", parentId: parent, id } as Patch,
  ]);
  return renderer.getNode(id) as FakeElement;
};

const filesZone = (extra: Record<string, unknown> = {}, zone: Record<string, unknown> = {}) => ({
  "__dnd.zone": { group: null, band: 0.5, files: true, accept: null, ...zone },
  ...OVER_POSE,
  ...extra,
});

type Item = { kind: string; type: string };
const fileItems = (...types: string[]): Item[] => types.map((type) => ({ kind: "file", type }));

/** A native drag event (bubbling through fake-dom) carrying OS files. */
const drag = (
  el: FakeElement,
  type: string,
  opts: { items?: Item[] | { length: number }; types?: string[] } = {}
) => {
  const items = opts.items ?? fileItems("image/png");
  const event: any = {
    type,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    dataTransfer: { types: opts.types ?? ["Files"], items, dropEffect: "copy" },
  };
  el.bubbleEvent(type, event);
  return event;
};

const bg = (el: FakeElement) => (el.style as unknown as Record<string, string | undefined>)["background-color"];

describe("core: files zone parsing + accept matching", () => {
  test("parseDndZone reads files / accept; absent keys = in-app only", () => {
    expect(parseDndZone({ group: "g", band: 0.5 })).toEqual({ group: "g", band: 0.5, files: false, accept: null });
    expect(parseDndZone({ files: true, accept: "image/*" })).toMatchObject({ files: true, accept: "image/*" });
    expect(parseDndZone({ files: true, accept: null })!.accept).toBeNull();
    expect(parseDndZone({ files: "yes" })!.files).toBe(false);
  });

  test("fileDragMatchesAccept", () => {
    expect(fileDragMatchesAccept(null, ["text/plain"])).toBe(true);
    expect(fileDragMatchesAccept("image/*", ["image/png"])).toBe(true);
    expect(fileDragMatchesAccept("image/*", ["application/pdf"])).toBe(false);
    expect(fileDragMatchesAccept("image/*, application/pdf", ["text/plain", "application/pdf"])).toBe(true);
    expect(fileDragMatchesAccept("application/pdf", ["APPLICATION/PDF"])).toBe(true);
    // Unknown types match.
    expect(fileDragMatchesAccept("image/*", null)).toBe(true);
    expect(fileDragMatchesAccept("image/*", [])).toBe(true);
    expect(fileDragMatchesAccept("image/*", [""])).toBe(true);
    // Extensions can't be known before the drop: an extension token matches.
    expect(fileDragMatchesAccept(".pdf", ["text/plain"])).toBe(true);
    expect(fileDragMatchesAccept("image/*,.heic", ["text/plain"])).toBe(true);
  });
});

describe("DOM files drop zone", () => {
  test("over pose applies while files hover and clears on leave", () => {
    const { renderer } = makeRenderer();
    const zone = mount(renderer, "zone", filesZone());
    const child = mount(renderer, "zone-child", {}, "zone");
    expect(bg(zone)).toBe("#fff");
    drag(zone, "dragenter");
    expect(bg(zone)).toBe("#eef");
    // Crossing into a child: enter(child) before leave(zone) — stays lit.
    drag(child, "dragenter");
    drag(zone, "dragleave");
    expect(bg(zone)).toBe("#eef");
    drag(child, "dragover");
    expect(bg(zone)).toBe("#eef");
    drag(child, "dragleave");
    expect(bg(zone)).toBe("#fff");
  });

  test("a release is swallowed with dropEffect none and clears the pose; nothing dispatched", () => {
    const { renderer, engine } = makeRenderer();
    const zone = mount(renderer, "zone", filesZone({ "onDrop.0": "@dropped" }));
    drag(zone, "dragenter");
    const over = drag(zone, "dragover");
    expect(over.defaultPrevented).toBe(true);
    expect(over.dataTransfer.dropEffect).toBe("none");
    const drop = drag(zone, "drop");
    expect(drop.defaultPrevented).toBe(true);
    expect(bg(zone)).toBe("#fff");
    expect(engine.dispatchCalls).toEqual([]);
    // A new drag lights it again.
    drag(zone, "dragenter");
    expect(bg(zone)).toBe("#eef");
  });

  test("innermost enabled files zone wins, one at a time", () => {
    const { renderer } = makeRenderer();
    const outer = mount(renderer, "outer", filesZone());
    const inner = mount(renderer, "inner", filesZone(), "outer");
    drag(outer, "dragenter");
    expect(bg(outer)).toBe("#eef");
    drag(inner, "dragenter");
    drag(outer, "dragleave");
    expect(bg(inner)).toBe("#eef");
    expect(bg(outer)).toBe("#fff");
    drag(outer, "dragenter");
    drag(inner, "dragleave");
    expect(bg(inner)).toBe("#fff");
    expect(bg(outer)).toBe("#eef");
  });

  test("a disabled zone is ignored (inner disabled ⇒ outer lights; never swallows)", () => {
    const { renderer } = makeRenderer();
    const outer = mount(renderer, "outer", filesZone());
    const inner = mount(renderer, "inner", filesZone({ "__dnd.zoneEnabled": false }), "outer");
    drag(inner, "dragenter");
    expect(bg(inner)).toBe("#fff");
    expect(bg(outer)).toBe("#eef");

    const { renderer: r2 } = makeRenderer();
    const lone = mount(r2, "lone", filesZone({ "__dnd.zoneEnabled": false }));
    drag(lone, "dragenter");
    const over = drag(lone, "dragover");
    expect(bg(lone)).toBe("#fff");
    expect(over.defaultPrevented).toBe(false);
  });

  test("disabling a lit zone clears its pose", () => {
    const { renderer } = makeRenderer();
    const zone = mount(renderer, "zone", filesZone());
    drag(zone, "dragenter");
    expect(bg(zone)).toBe("#eef");
    renderer.applyPatches([{ type: "setProp", id: "zone", name: "__dnd.zoneEnabled", value: false } as Patch]);
    expect(bg(zone)).toBe("#fff");
  });

  test("accept: match lights, mismatch stays dark, unknown types light", () => {
    const { renderer } = makeRenderer();
    const zone = mount(renderer, "zone", filesZone({}, { accept: "image/*" }));
    drag(zone, "dragenter", { items: fileItems("application/pdf") });
    expect(bg(zone)).toBe("#fff");
    drag(zone, "dragleave", { items: fileItems("application/pdf") });

    drag(zone, "dragenter", { items: fileItems("text/plain", "image/jpeg") });
    expect(bg(zone)).toBe("#eef");
    drag(zone, "dragleave");

    drag(zone, "dragenter", { items: fileItems("") });
    expect(bg(zone)).toBe("#eef");
    drag(zone, "dragleave");

    drag(zone, "dragenter", { items: { length: 3 } });
    expect(bg(zone)).toBe("#eef");
    drag(zone, "dragleave");

    const ext = mount(renderer, "ext", filesZone({}, { accept: ".pdf" }));
    drag(ext, "dragenter", { items: fileItems("text/plain") });
    expect(bg(ext)).toBe("#eef");
  });

  test("a mismatched inner zone falls through to an accepting outer zone", () => {
    const { renderer } = makeRenderer();
    const outer = mount(renderer, "outer", filesZone());
    const inner = mount(renderer, "inner", filesZone({}, { accept: "image/*" }), "outer");
    drag(inner, "dragenter", { items: fileItems("application/pdf") });
    expect(bg(inner)).toBe("#fff");
    expect(bg(outer)).toBe("#eef");
  });

  test("drags without files (text, in-page) never light a files zone", () => {
    const { renderer } = makeRenderer();
    const zone = mount(renderer, "zone", filesZone());
    const over = drag(zone, "dragenter", { types: ["text/plain"] });
    expect(bg(zone)).toBe("#fff");
    expect(over.defaultPrevented).toBe(false);
  });

  test("onFileDragEnter on the zone fires once per entry, with the default payload", () => {
    const { renderer, engine } = makeRenderer();
    const zone = mount(renderer, "zone", filesZone({ "onFileDragEnter.0": "@incoming" }));
    const child = mount(renderer, "zone-child", {}, "zone");
    drag(zone, "dragenter", { items: fileItems("image/png", "image/gif") });
    drag(child, "dragenter");
    drag(zone, "dragleave");
    drag(child, "dragover");
    expect(engine.dispatchCalls.length).toBe(1);
    expect(engine.dispatchCalls[0]!.name).toBe("incoming");
    expect(engine.dispatchCalls[0]!.payload).toMatchObject({ type: "filedragenter", items: 2 });
    expect(Object.keys(engine.dispatchCalls[0]!.payload).sort()).toEqual(["items", "timestamp", "type"]);
    drag(child, "dragleave");
    drag(zone, "dragenter");
    expect(engine.dispatchCalls.length).toBe(2);
  });

  test("onFileDragEnter custom named args replace the payload", () => {
    const { renderer, engine } = makeRenderer();
    const zone = mount(renderer, "zone", filesZone({ "onFileDragEnter.0": "@incoming", "onFileDragEnter.slot": "avatar" }));
    drag(zone, "dragenter");
    expect(engine.dispatchCalls.length).toBe(1);
    expect(engine.dispatchCalls[0]!.payload).toEqual({ slot: "avatar" });
  });

  test("onFileDragEnter on a zone that can't light (accept mismatch / disabled) does not fire", () => {
    const { renderer, engine } = makeRenderer();
    const zone = mount(renderer, "zone", filesZone({ "onFileDragEnter.0": "@incoming" }, { accept: "image/*" }));
    drag(zone, "dragenter", { items: fileItems("application/pdf") });
    expect(engine.dispatchCalls).toEqual([]);
    const off = mount(renderer, "off", filesZone({ "onFileDragEnter.0": "@incoming", "__dnd.zoneEnabled": false }));
    drag(off, "dragenter");
    expect(engine.dispatchCalls).toEqual([]);
  });

  test("onFileDragEnter without a files zone is inert (fires nothing, swallows nothing)", () => {
    const { renderer, engine } = makeRenderer();
    const el = mount(renderer, "plain", { "onFileDragEnter.0": "@incoming" });
    const enter = drag(el, "dragenter", { items: fileItems("application/pdf") });
    expect(engine.dispatchCalls.map((c) => c.name)).toEqual([]);
    expect(enter.defaultPrevented).toBe(false);
    const drop = drag(el, "drop");
    expect(drop.defaultPrevented).toBe(false);
  });

  test("an in-app (in-zone) zone without files: ignores OS file drags", () => {
    const { renderer } = makeRenderer();
    const zone = mount(renderer, "zone", { "__dnd.zone": { group: null, band: 0.5 }, ...OVER_POSE });
    const over = drag(zone, "dragenter");
    drag(zone, "dragover");
    expect(bg(zone)).toBe("#fff");
    expect(over.defaultPrevented).toBe(false);
  });

  test("in-app drag onto a files zone is unaffected (over pose + onDrop)", () => {
    const { renderer, engine } = makeRenderer();
    renderer.applyPatches([
      {
        type: "create",
        id: "card",
        elementType: "Card",
        props: { "__dnd.key": "c1", "__dnd.source": { group: "cards", handle: false, activation: "auto" } },
      } as Patch,
      { type: "insert", parentId: "root-1", id: "card" } as Patch,
    ]);
    const card = renderer.getNode("card") as FakeElement;
    const zone = mount(
      renderer,
      "zone",
      filesZone({ "__dnd.zoneId": "inbox", "onDrop.0": "@dropped" }, { group: "cards", accept: "image/*" })
    );
    const rect = (el: FakeElement, left: number, top: number, w: number, h: number) => {
      el.getBoundingClientRect = () => ({ left, top, width: w, height: h, right: left + w, bottom: top + h });
    };
    rect(card, 0, 0, 100, 50);
    rect(zone, 300, 0, 100, 100);
    const pe = (el: FakeElement, type: string, x: number, y: number) =>
      el.dispatchEvent(type, {
        pointerId: 1,
        pointerType: "mouse",
        button: 0,
        clientX: x,
        clientY: y,
        preventDefault() {},
        stopPropagation() {},
      });
    pe(card, "pointerdown", 50, 25);
    pe(card, "pointermove", 350, 50);
    expect(bg(zone)).toBe("#eef");
    pe(card, "pointerup", 350, 50);
    expect(engine.dispatchCalls.map((c) => c.name)).toEqual(["dropped"]);
  });
});
