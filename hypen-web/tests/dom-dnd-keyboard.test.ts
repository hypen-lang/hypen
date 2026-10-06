/**
 * DOM drag-and-drop runtime — keyboard path (plan §6 item 8).
 *
 * Space lifts, Arrow keys move within the sortable, Tab / Shift+Tab cycle
 * zones, Space drops, Esc cancels — driven by the core `KeyboardDragMachine`
 * and emitting the IDENTICAL actions/events a pointer drop does, with
 * `aria-grabbed` and a polite live region on the DOM side. Same fake-dom +
 * StubEngine harness as dom-dnd.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { DOMRenderer } from "../packages/web/src/dom/renderer";
import type { Patch } from "../packages/core/src/types";
import type { IEngine as Engine } from "../packages/core/src/app";
import { ensureFakeDomGlobals, FakeElement } from "./fake-dom";

ensureFakeDomGlobals();

class StubEngine {
  public dispatchCalls: Array<{ name: string; payload: any }> = [];

  rawDispatches: any[] = [];
  dispatchAction(name: string, payload: any): void {
    if (name === "__hypen_dispatch") { this.rawDispatches.push(payload); name = payload.action; payload = payload.payload; }

    this.dispatchCalls.push({ name, payload });
  }
}

const makeRenderer = () => {
  const container = document.createElement("div");
  const engine = new StubEngine();
  const renderer = new DOMRenderer(container, engine as unknown as Engine);
  renderer.applyPatches([
    { type: "create", id: "root-1", elementType: "Column", props: {} } as Patch,
    { type: "insert", parentId: "root", id: "root-1" } as Patch,
  ]);
  const dnd = renderer.getDnd();
  dnd.cleanupTimeoutMs = 30;
  return { engine, renderer, dnd };
};

const setRect = (el: FakeElement, r: { left: number; top: number; width: number; height: number }) => {
  el.getBoundingClientRect = () => ({
    left: r.left,
    top: r.top,
    width: r.width,
    height: r.height,
    right: r.left + r.width,
    bottom: r.top + r.height,
  });
};

const tf = (el: FakeElement): string => el.style.transform ?? "";

const SOURCE = { group: null, handle: false, activation: "auto" };

/** `Column.sortable().bind(@state.tasks)` with three plain draggable rows. */
const mountList = (renderer: DOMRenderer, listProps: Record<string, unknown> = {}) => {
  const keys = ["t1", "t2", "t3"];
  const patches: Patch[] = [
    {
      type: "create",
      id: "todo",
      elementType: "Column",
      props: { "__dnd.sort": { group: "board", axis: "y" }, bind: "tasks", ...listProps },
    } as Patch,
    { type: "insert", parentId: "root-1", id: "todo" } as Patch,
  ];
  for (const key of keys) {
    patches.push(
      {
        type: "create",
        id: `row-${key}`,
        elementType: "Card",
        props: { "0": key, "__dnd.key": key, "__dnd.source": SOURCE },
      } as Patch,
      { type: "insert", parentId: "todo", id: `row-${key}` } as Patch
    );
  }
  renderer.applyPatches(patches);
  setRect(renderer.getNode("todo") as FakeElement, { left: 0, top: 0, width: 200, height: 300 });
  keys.forEach((key, i) =>
    setRect(renderer.getNode(`row-${key}`) as FakeElement, { left: 0, top: i * 100, width: 200, height: 100 })
  );
  return { row: (key: string) => renderer.getNode(`row-${key}`) as FakeElement };
};

const mountTrash = (renderer: DOMRenderer) => {
  renderer.applyPatches([
    {
      type: "create",
      id: "trash",
      elementType: "Column",
      props: {
        "__dnd.zone": { group: "board", band: 0.5 },
        "__dnd.zoneId": "trash",
        "onDrop.0": "@deleteTask",
        "__anim.statePoses": { over: { "opacity.0": 0.5 } },
      },
    } as Patch,
    { type: "insert", parentId: "root-1", id: "trash" } as Patch,
  ]);
  const trash = renderer.getNode("trash") as FakeElement;
  setRect(trash, { left: 300, top: 0, width: 100, height: 100 });
  return trash;
};

const key = (el: FakeElement, k: string, extra: Record<string, unknown> = {}) => {
  let prevented = false;
  el.dispatchEvent("keydown", { key: k, preventDefault: () => (prevented = true), ...extra });
  return prevented;
};

const liveText = (): string => {
  const region = (document.body as unknown as FakeElement).children.find(
    (c) => c.attributes["data-hypen-dnd-live"] !== undefined
  );
  // The runtime toggles a zero-width space to re-announce identical text.
  return (region?.textContent ?? "").replace(/\u200b/g, "");
};

describe("keyboard drag (§6.8)", () => {
  test("draggables are focusable and announce grabbable", () => {
    const { renderer } = makeRenderer();
    const { row } = mountList(renderer);
    expect(row("t1").attributes.tabindex).toBe("0");
    expect(row("t1").attributes["aria-grabbed"]).toBe("false");
  });

  test("Space lifts, arrows move with preview + announcements, Space drops with the exact pointer outcome", () => {
    const { renderer, engine } = makeRenderer();
    const { row } = mountList(renderer, {
      "onSort.0": "@reorder",
      "onDragStart.0": "@dragBegan",
      "onDragEnd.0": "@dragEnded",
    });
    row("t1").focus();
    expect(key(row("t1"), " ")).toBe(true);
    expect(row("t1").attributes["aria-grabbed"]).toBe("true");
    expect(engine.dispatchCalls.map((c) => c.name)).toEqual(["dragBegan"]);
    expect(liveText()).toBe("t1, position 1 of 3");

    key(row("t1"), "ArrowDown");
    expect(liveText()).toBe("t1, position 2 of 3");
    expect(tf(row("t1"))).toBe("translate(0px, 100px)");
    expect(tf(row("t2"))).toBe("translateY(-100px)");
    expect(tf(row("t3"))).toBe("");
    key(row("t1"), "ArrowDown");
    key(row("t1"), "ArrowDown"); // clamps at the end
    expect(liveText()).toBe("t1, position 3 of 3");
    expect(tf(row("t1"))).toBe("translate(0px, 200px)");
    expect(tf(row("t3"))).toBe("translateY(-100px)");
    key(row("t1"), "ArrowUp");
    expect(liveText()).toBe("t1, position 2 of 3");
    expect(tf(row("t3"))).toBe("");
    key(row("t1"), "ArrowDown");
    expect(engine.dispatchCalls.length).toBe(1); // moves never touch the engine

    expect(key(row("t1"), " ")).toBe(true);
    expect(engine.dispatchCalls.map((c) => c.name)).toEqual([
      "dragBegan",
      "__hypen_reorder",
      "reorder",
      "dragEnded",
    ]);
    expect(engine.dispatchCalls[1]!.payload).toEqual({ path: "tasks", from: 0, to: 2 });
    expect(engine.dispatchCalls[2]!.payload).toEqual({
      item: "t1",
      from: { zone: "board", index: 0 },
      to: { zone: "board", index: 2 },
    });
    expect(engine.dispatchCalls[3]!.payload).toEqual({
      item: "t1",
      from: { zone: "board", index: 0 },
      to: { zone: "board", index: 2 },
      dropped: true,
    });
    expect(liveText()).toBe("t1, dropped");
    // Held until the engine's Move lands, exactly like a pointer drop.
    expect(tf(row("t1"))).toBe("translate(0px, 200px)");
    renderer.applyPatches([{ type: "move", parentId: "todo", id: "row-t1" } as Patch]);
    expect(tf(row("t1"))).toBe("");
    expect(tf(row("t2"))).toBe("");
    expect(tf(row("t3"))).toBe("");
    expect(row("t1").attributes["aria-grabbed"]).toBe("false");
  });

  test("Escape cancels: only onDragEnd {dropped: false}, everything restored", () => {
    const { renderer, engine } = makeRenderer();
    const { row } = mountList(renderer, { "onSort.0": "@reorder", "onDragEnd.0": "@dragEnded" });
    key(row("t2"), " ");
    key(row("t2"), "ArrowUp");
    expect(tf(row("t2"))).toBe("translate(0px, -100px)");
    expect(tf(row("t1"))).toBe("translateY(100px)");
    expect(key(row("t2"), "Escape")).toBe(true);
    expect(engine.dispatchCalls).toEqual([
      {
        name: "dragEnded",
        payload: {
          item: "t2",
          from: { zone: "board", index: 1 },
          to: { zone: "board", index: 0 },
          dropped: false,
        },
      },
    ]);
    expect(tf(row("t2"))).toBe("");
    expect(tf(row("t1"))).toBe("");
    expect(row("t2").attributes["aria-grabbed"]).toBe("false");
    expect(liveText()).toBe("t2, cancelled");
  });

  test("dropping in place is a no-op drop: no write, no onSort, onDragEnd {dropped: true}", () => {
    const { renderer, engine } = makeRenderer();
    const { row } = mountList(renderer, { "onSort.0": "@reorder", "onDragEnd.0": "@dragEnded" });
    key(row("t2"), " ");
    key(row("t2"), "ArrowDown");
    key(row("t2"), "ArrowUp");
    key(row("t2"), " ");
    expect(engine.dispatchCalls.map((c) => c.name)).toEqual(["dragEnded"]);
    expect(engine.dispatchCalls[0]!.payload.dropped).toBe(true);
    expect(tf(row("t2"))).toBe("");
  });

  test("Tab cycles to a compatible drop zone (over pose applied), Space drops into it", () => {
    const { renderer, engine } = makeRenderer();
    const { row } = mountList(renderer, { "onDragEnd.0": "@dragEnded" });
    const trash = mountTrash(renderer);
    key(row("t3"), " ");
    expect(key(row("t3"), "Tab")).toBe(true); // focus stays: the runtime owns Tab while lifted
    expect(liveText()).toBe("t3, over trash");
    expect((trash.style as any).opacity).toBe("0.5");
    key(row("t3"), "Tab", { shiftKey: true }); // back to the origin
    expect(liveText()).toBe("t3, position 3 of 3");
    expect((trash.style as any).opacity).toBeUndefined();
    key(row("t3"), "Tab");
    key(row("t3"), " ");
    expect(engine.dispatchCalls.map((c) => c.name)).toEqual(["deleteTask", "dragEnded"]);
    expect(engine.dispatchCalls[0]!.payload).toEqual({
      item: "t3",
      from: { zone: "board", index: 2 },
      to: { zone: "trash", index: null },
    });
    expect(engine.dispatchCalls[1]!.payload.dropped).toBe(true);
  });

  test("Space on a disabled source, or while a pointer drag is live, does nothing", () => {
    const { renderer, engine } = makeRenderer();
    const { row } = mountList(renderer, { "onDragStart.0": "@dragBegan" });
    renderer.applyPatches([
      { type: "setProp", id: "row-t1", name: "__dnd.sourceEnabled", value: false } as Patch,
    ]);
    expect(key(row("t1"), " ")).toBe(false);
    expect(engine.dispatchCalls).toEqual([]);
    // A pointer drag on t2 owns the runtime: t3's Space is ignored.
    row("t2").dispatchEvent("pointerdown", { clientX: 100, clientY: 150, pointerId: 1 });
    row("t2").dispatchEvent("pointermove", { clientX: 100, clientY: 250, pointerId: 1 });
    expect(engine.dispatchCalls.map((c) => c.name)).toEqual(["dragBegan"]);
    key(row("t3"), " ");
    expect(engine.dispatchCalls.length).toBe(1);
    row("t2").dispatchEvent("pointerup", { clientX: 100, clientY: 250, pointerId: 1 });
  });

  test("a Remove of the lifted node mid-keyboard-drag cancels silently", () => {
    const { renderer, engine } = makeRenderer();
    const { row } = mountList(renderer, { "onDragEnd.0": "@dragEnded" });
    key(row("t1"), " ");
    key(row("t1"), "ArrowDown");
    renderer.applyPatches([{ type: "remove", id: "row-t1" } as Patch]);
    expect(engine.dispatchCalls).toEqual([]);
    expect(tf(row("t2"))).toBe("");
  });

  test("losing focus while lifted cancels with onDragEnd {dropped: false}", () => {
    const { renderer, engine } = makeRenderer();
    const { row } = mountList(renderer, { "onDragEnd.0": "@dragEnded" });
    row("t1").focus();
    key(row("t1"), " ");
    row("t2").focus(); // blurs t1
    expect(engine.dispatchCalls.map((c) => c.name)).toEqual(["dragEnded"]);
    expect(engine.dispatchCalls[0]!.payload.dropped).toBe(false);
    expect(row("t1").attributes["aria-grabbed"]).toBe("false");
  });
});

describe("keyboard zone identity (§6.11)", () => {
  /** A second sortable sharing the `board` group, bound to `doing`, 300px to the right. */
  const mountDoing = (renderer: DOMRenderer) => {
    renderer.applyPatches([
      {
        type: "create",
        id: "doing",
        elementType: "Column",
        props: { "__dnd.sort": { group: "board", axis: "y" }, bind: "doing", "onSort.0": "@sortDoing" },
      } as Patch,
      { type: "insert", parentId: "root-1", id: "doing" } as Patch,
      {
        type: "create",
        id: "row-d1",
        elementType: "Card",
        props: { "0": "d1", "__dnd.key": "d1", "__dnd.source": SOURCE },
      } as Patch,
      { type: "insert", parentId: "doing", id: "row-d1" } as Patch,
    ]);
    setRect(renderer.getNode("doing") as FakeElement, { left: 300, top: 0, width: 200, height: 100 });
    setRect(renderer.getNode("row-d1") as FakeElement, { left: 300, top: 0, width: 200, height: 100 });
    return renderer.getNode("row-d1") as FakeElement;
  };

  test("Tab into a same-group sibling sortable is a distinct zone: cross-list write + onSort on the destination", () => {
    const { renderer, engine } = makeRenderer();
    const { row } = mountList(renderer, { "onSort.0": "@sortTodo", "onDragEnd.0": "@dragEnded" });
    const d1 = mountDoing(renderer);
    key(row("t1"), " ");
    expect(liveText()).toBe("t1, position 1 of 3");
    key(row("t1"), "Tab"); // → doing (appends)
    expect(liveText()).toBe("t1, board, position 2 of 2");
    key(row("t1"), "Tab"); // wraps back to the origin
    expect(liveText()).toBe("t1, position 1 of 3");
    key(row("t1"), "Tab", { shiftKey: true }); // → doing again
    key(row("t1"), "ArrowUp"); // slot 0 of doing: d1 opens the gap
    expect(liveText()).toBe("t1, board, position 1 of 2");
    expect(tf(d1)).toBe("translateY(100px)");
    expect(engine.dispatchCalls).toEqual([]);

    key(row("t1"), " ");
    expect(engine.dispatchCalls.map((c) => c.name)).toEqual(["__hypen_reorder", "sortDoing", "dragEnded"]);
    expect(engine.dispatchCalls[0]!.payload).toEqual({ fromPath: "tasks", from: 0, toPath: "doing", to: 0 });
    expect(engine.dispatchCalls[1]!.payload).toEqual({
      item: "t1",
      from: { zone: "board", index: 0 },
      to: { zone: "board", index: 0 },
    });
    expect(engine.dispatchCalls[2]!.payload.dropped).toBe(true);
    // Held until the destination re-renders.
    expect(tf(d1)).toBe("translateY(100px)");
    renderer.applyPatches([{ type: "move", parentId: "doing", id: "row-t1" } as Patch]);
    expect(tf(d1)).toBe("");
    expect(tf(row("t1"))).toBe("");
  });

  test("a loose draggable's pseudo-origin is keyed by its node: Tab reaches a zone and drops into it", () => {
    const { renderer, engine } = makeRenderer();
    renderer.applyPatches([
      {
        type: "create",
        id: "card",
        elementType: "Card",
        props: { "__dnd.source": { group: "board", handle: false, activation: "auto" }, "onDragEnd.0": "@dragEnded" },
      } as Patch,
      { type: "insert", parentId: "root-1", id: "card" } as Patch,
    ]);
    mountTrash(renderer);
    const card = renderer.getNode("card") as FakeElement;
    key(card, " ");
    expect(liveText()).toBe("card, position 1");
    key(card, "Tab");
    expect(liveText()).toBe("card, over trash");
    key(card, " ");
    expect(engine.dispatchCalls.map((c) => c.name)).toEqual(["deleteTask", "dragEnded"]);
    expect(engine.dispatchCalls[0]!.payload).toEqual({
      item: "card",
      from: { zone: "root-1", index: null },
      to: { zone: "trash", index: null },
    });
  });
});

describe("keyboard lift surface and focus (a11y)", () => {
  test("Space from a focusable child (Input / Button) belongs to the child: no lift, keystroke untouched", () => {
    const { renderer, engine } = makeRenderer();
    const { row } = mountList(renderer, { "onDragStart.0": "@dragBegan" });
    renderer.applyPatches([
      { type: "create", id: "note", elementType: "Input", props: { placeholder: "note" } } as Patch,
      { type: "insert", parentId: "row-t1", id: "note" } as Patch,
      { type: "create", id: "del", elementType: "Button", props: { "0": "Delete" } } as Patch,
      { type: "insert", parentId: "row-t1", id: "del" } as Patch,
    ]);
    const input = renderer.getNode("note") as FakeElement;
    const button = renderer.getNode("del") as FakeElement;
    for (const child of [input, button]) {
      child.focus();
      let prevented = false;
      child.bubbleEvent("keydown", { key: " ", preventDefault: () => (prevented = true) });
      expect(prevented).toBe(false);
      expect(engine.dispatchCalls).toEqual([]);
      expect(row("t1").attributes["aria-grabbed"]).toBe("false");
    }
    // The draggable itself still lifts on Space.
    row("t1").focus();
    expect(key(row("t1"), " ")).toBe(true);
    expect(engine.dispatchCalls.map((c) => c.name)).toEqual(["dragBegan"]);
    expect(row("t1").attributes["aria-grabbed"]).toBe("true");
  });

  test("focus survives the engine's Move after a keyboard drop (not dumped to the body)", () => {
    const { renderer } = makeRenderer();
    const { row } = mountList(renderer, { "onSort.0": "@reorder" });
    row("t1").focus();
    key(row("t1"), " ");
    key(row("t1"), "ArrowDown");
    key(row("t1"), "ArrowDown");
    key(row("t1"), " ");
    expect((document as any).activeElement).toBe(row("t1"));
    renderer.applyPatches([{ type: "move", parentId: "todo", id: "row-t1" } as Patch]);
    // fake-dom drops focus on removal like a browser; the renderer restores it.
    expect((document as any).activeElement).toBe(row("t1"));
    expect(tf(row("t1"))).toBe("");
    // And the next keyboard reorder starts from the item, not the top of the page.
    expect(key(row("t1"), " ")).toBe(true);
    expect(row("t1").attributes["aria-grabbed"]).toBe("true");
  });

  test("a re-parenting blur (node off-document) does not cancel a live keyboard drag; a real blur does", () => {
    const { renderer, engine } = makeRenderer();
    const { row } = mountList(renderer, { "onDragEnd.0": "@dragEnded" });
    row("t1").focus();
    key(row("t1"), " ");
    (row("t1") as any).isConnected = false;
    row("t1").dispatchEvent("blur", {});
    (row("t1") as any).isConnected = undefined;
    expect(engine.dispatchCalls).toEqual([]);
    expect(row("t1").attributes["aria-grabbed"]).toBe("true");
    row("t2").focus();
    expect(engine.dispatchCalls.map((c) => c.name)).toEqual(["dragEnded"]);
  });

  test("the live region exists (empty) as soon as a draggable is armed, before the first announcement", () => {
    ensureFakeDomGlobals(); // a fresh document: no region from earlier tests
    const { renderer } = makeRenderer();
    const region = () =>
      (document.body as unknown as FakeElement).children.find((c) => c.attributes["data-hypen-dnd-live"] !== undefined);
    expect(region()).toBeUndefined();
    mountList(renderer);
    expect(region()).toBeDefined();
    expect(region()!.attributes["aria-live"]).toBe("polite");
    expect(region()!.textContent).toBe("");
  });

  test("Esc while lifted inside a Dialog cancels the drag only; the dialog's onClose does not fire", () => {
    const { renderer, engine } = makeRenderer();
    renderer.applyPatches([
      {
        type: "create",
        id: "dlg",
        elementType: "Column",
        props: { onClose: "@actions.dismiss" },
        semantics: { role: "dialog" },
      } as Patch,
      { type: "insert", parentId: "root-1", id: "dlg" } as Patch,
    ]);
    const { row } = mountList(renderer, { "onDragEnd.0": "@dragEnded" });
    renderer.applyPatches([{ type: "move", parentId: "dlg", id: "todo" } as Patch]);
    row("t1").focus();
    key(row("t1"), " ");
    expect(row("t1").attributes["aria-grabbed"]).toBe("true");
    const event = {
      key: "Escape",
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
    };
    row("t1").bubbleEvent("keydown", event);
    expect(engine.dispatchCalls.map((c) => c.name)).toEqual(["dragEnded"]);
    expect(row("t1").attributes["aria-grabbed"]).toBe("false");
    // Idle again: the next Esc is the dialog's.
    row("t1").bubbleEvent("keydown", { key: "Escape", defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });
    expect(engine.dispatchCalls.map((c) => c.name)).toEqual(["dragEnded", "dismiss"]);
  });
});
