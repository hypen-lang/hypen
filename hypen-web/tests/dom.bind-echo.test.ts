/**
 * `.bind(@state.x)` on text fields under a slow (remote) engine.
 *
 * Every keystroke sends a `__hypen_bind` write and the engine answers with
 * `SetProp(value)` for that state. With several writes in flight, the echo
 * of keystroke N arrives after the user has typed N+1…; writing it into the
 * field replaced the newer text and the next keystroke appended to the
 * stale value ("Buy milk" → "Bumilk"). The renderer now matches echoes
 * against the ordered outstanding writes (bind-echo.ts): stale echoes are
 * dropped, the newest echo is a no-op, and only genuinely foreign values
 * (an action clearing the draft, formatting) are applied.
 *
 * These tests play the remote engine by hand: `type()` performs the
 * browser's edit + `input` event (the renderer dispatches the write), and
 * `echo()` delivers a SetProp whenever the test decides the "server" got
 * there.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { DOMRenderer } from "../packages/web/src/dom/renderer";
import type { Patch } from "../packages/core/src/types";
import type { IEngine as Engine } from "../packages/core/src/app";
import { semanticAction } from "./helpers";

const GLOBAL_KEYS = [
  "window",
  "document",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "HTMLSelectElement",
  "Node",
  "Element",
  "Event",
  "getComputedStyle",
];
const originalGlobals: Record<string, unknown> = {};
for (const key of GLOBAL_KEYS) originalGlobals[key] = (globalThis as any)[key];

const dom = new JSDOM("<!DOCTYPE html><html><head></head><body></body></html>", {
  url: "http://localhost/",
});
for (const key of GLOBAL_KEYS) {
  const v = (dom.window as any)[key === "window" ? "window" : key];
  (globalThis as any)[key] =
    key === "getComputedStyle" ? dom.window.getComputedStyle.bind(dom.window) : key === "document" ? dom.window.document : v;
}

afterAll(() => {
  for (const key of GLOBAL_KEYS) (globalThis as any)[key] = originalGlobals[key];
});
afterEach(() => {
  document.body.innerHTML = "";
});

class RecordingEngine {
  actions: Array<{ name: string; payload: any }> = [];
  dispatchAction(name: string, payload?: any): void {
    this.actions.push(semanticAction(name, payload));
  }
  binds(): any[] {
    return this.actions.filter((a) => a.name === "__hypen_bind").map((a) => a.payload);
  }
}

function mount(elementType: string, props: Record<string, any>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const engine = new RecordingEngine();
  const renderer = new DOMRenderer(container, engine as unknown as Engine);
  renderer.applyPatches([
    { type: "create", id: "f", elementType, props } as Patch,
    { type: "insert", parentId: "root", id: "f" } as Patch,
  ]);
  const el = renderer.getNode("f") as any;
  if (!el.isConnected) container.appendChild(el);
  return { renderer, engine, el };
}

/** Browser-side edit: replace the value, place the caret, fire `input`. */
function type(el: HTMLInputElement | HTMLTextAreaElement, value: string, caret = value.length) {
  el.value = value;
  el.setSelectionRange(caret, caret);
  el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
}

function echo(renderer: DOMRenderer, value: unknown, name = "value") {
  renderer.applyPatches([{ type: "setProp", id: "f", name, value } as Patch]);
}

for (const kind of ["Input", "Textarea"] as const) {
  describe(`${kind}.bind() echo reconciliation`, () => {
    const make = () => mount(kind, { bind: "draft", value: "" });

    test("echoes of older keystrokes never overwrite newer text", () => {
      const { renderer, engine, el } = make();
      el.focus();
      // "Buy milk" typed faster than the round trip: every write in flight.
      const text = "Buy milk";
      for (let i = 1; i <= text.length; i++) type(el, text.slice(0, i));
      expect(engine.binds().map((b) => b.value)).toEqual(
        [...text].map((_, i) => text.slice(0, i + 1)),
      );
      // Server catches up one keystroke at a time; the user keeps typing
      // in the middle of it.
      echo(renderer, "B");
      expect(el.value).toBe("Buy milk");
      echo(renderer, "Bu");
      type(el, "Buy milk!");
      echo(renderer, "Buy");
      expect(el.value).toBe("Buy milk!");
      for (const v of ["Buy ", "Buy m", "Buy mi", "Buy mil", "Buy milk"]) {
        echo(renderer, v);
        expect(el.value).toBe("Buy milk!");
      }
      echo(renderer, "Buy milk!");
      expect(el.value).toBe("Buy milk!");
    });

    test("caret stays put while stale and latest echoes arrive", () => {
      const { renderer, el } = make();
      el.focus();
      type(el, "hello");
      type(el, "heXllo", 3); // inserted mid-string, caret after X
      echo(renderer, "hello");
      expect(el.value).toBe("heXllo");
      expect(el.selectionStart).toBe(3);
      echo(renderer, "heXllo");
      expect(el.selectionStart).toBe(3);
    });

    test("an action that clears the field still applies (after the writes it follows)", () => {
      const { renderer, el } = make();
      el.focus();
      type(el, "a");
      type(el, "ab");
      type(el, "abc");
      // Server: three bind writes, then the Add action sets draft = "".
      echo(renderer, "a");
      echo(renderer, "ab");
      echo(renderer, "abc");
      echo(renderer, "");
      expect(el.value).toBe("");
      // The next keystroke starts from the cleared field.
      type(el, "n");
      echo(renderer, "n");
      expect(el.value).toBe("n");
    });

    test("a clear processed between writes converges to the server's final state", () => {
      const { renderer, el } = make();
      el.focus();
      type(el, "a");
      type(el, "ab");
      // Server order: write "a", action clears, write "ab".
      echo(renderer, "a");
      expect(el.value).toBe("ab");
      echo(renderer, "");
      expect(el.value).toBe("");
      echo(renderer, "ab");
      expect(el.value).toBe("ab");
    });

    test("repeated identical values are matched in order", () => {
      const { renderer, el } = make();
      el.focus();
      type(el, "a");
      type(el, "");
      type(el, "a");
      type(el, "ab");
      echo(renderer, "a");
      echo(renderer, "");
      expect(el.value).toBe("ab");
      echo(renderer, "a");
      expect(el.value).toBe("ab");
      echo(renderer, "ab");
      expect(el.value).toBe("ab");
    });

    test("a programmatic rewrite of a focused field keeps the caret (clamped)", () => {
      const { renderer, el } = make();
      el.focus();
      type(el, "hello world", 2);
      echo(renderer, "hello world");
      echo(renderer, "HELLO WORLD"); // e.g. an action upper-casing the draft
      expect(el.value).toBe("HELLO WORLD");
      expect(el.selectionStart).toBe(2);
      echo(renderer, "X");
      expect(el.value).toBe("X");
      expect(el.selectionStart).toBe(1);
    });

    test("with nothing in flight, engine values apply as before", () => {
      const { renderer, el } = make();
      echo(renderer, "from state");
      expect(el.value).toBe("from state");
      echo(renderer, "");
      expect(el.value).toBe("");
    });
  });
}

describe("controls the echo filter must not touch", () => {
  test("an unbound Input follows every engine value", () => {
    const { renderer, el } = mount("Input", { value: "a" });
    el.focus();
    el.value = "typed";
    echo(renderer, "b");
    expect(el.value).toBe("b");
  });

  test("Checkbox.bind writes and follows engine `checked`", () => {
    const { renderer, engine, el } = mount("Checkbox", { bind: "agreed", checked: false });
    const box = el.querySelector('input[type="checkbox"]') as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    expect(engine.binds()).toEqual([{ path: "agreed", value: true }]);
    echo(renderer, false, "checked");
    expect(box.checked).toBe(false);
    echo(renderer, true, "checked");
    expect(box.checked).toBe(true);
  });

  test("Select.bind writes and follows engine `value`", () => {
    const { renderer, engine, el } = mount("Select", {
      bind: "country",
      options: ["us", "hr", "de"],
      value: "us",
    });
    el.value = "hr";
    el.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    expect(engine.binds()).toEqual([{ path: "country", value: "hr" }]);
    echo(renderer, "de");
    expect(el.value).toBe("de");
  });
});
