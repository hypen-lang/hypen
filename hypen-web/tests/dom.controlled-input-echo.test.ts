/**
 * Hand-wired controlled text fields under a slow (remote) engine:
 * `Input(value: "@{state.x}").onInput(@actions.setX)` (and Textarea, and the
 * `.onChange` spelling), where the handler does `state.x = payload.value`.
 *
 * Same race as `.bind` (dom.bind-echo.test.ts): every keystroke dispatches
 * the handler with the field's value, the engine answers each with
 * `SetProp(value)`, and with several in flight the answer to an older
 * keystroke overwrote newer text. The field now records the values it sends
 * as outstanding writes (bind-echo.ts) and classifies the answers. Handlers
 * may rewrite the value (uppercase, strip digits): such an answer matches no
 * write, is held back while newer writes are in flight, and applies — caret
 * clamped — once the engine has answered everything (or the field goes
 * quiet, for writes that get no answer at all).
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { DOMRenderer } from "../packages/web/src/dom/renderer";
import { DEFERRED_ECHO_SETTLE_MS, hasOutstandingBindWrites } from "../packages/web/src/bind-echo";
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
  "MouseEvent",
  "KeyboardEvent",
  "HTMLFormElement",
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
  sent(action: string): string[] {
    return this.actions.filter((a) => a.name === action).map((a) => a.payload?.value);
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

/** Browser-side edit: replace the value, place the caret, fire `eventType`. */
function type(
  el: HTMLInputElement | HTMLTextAreaElement,
  value: string,
  caret = value.length,
  eventType = "input",
) {
  el.value = value;
  el.setSelectionRange(caret, caret);
  el.dispatchEvent(new dom.window.Event(eventType, { bubbles: true }));
}

/** The engine's answer: `SetProp(value)` for the field. */
function answer(renderer: DOMRenderer, value: unknown) {
  renderer.applyPatches([{ type: "setProp", id: "f", name: "value", value } as Patch]);
}

const settle = () => new Promise((r) => setTimeout(r, DEFERRED_ECHO_SETTLE_MS + 60));

const VARIANTS = [
  { kind: "Input", handler: "onInput", event: "input" },
  { kind: "Textarea", handler: "onInput", event: "input" },
  { kind: "Input", handler: "onChange", event: "change" },
  { kind: "Textarea", handler: "onChange", event: "change" },
] as const;

for (const { kind, handler, event } of VARIANTS) {
  describe(`controlled ${kind}(value:).${handler} echo reconciliation`, () => {
    const make = () => mount(kind, { value: "", [handler]: "@actions.setX" });
    const edit = (el: any, value: string, caret = value.length) => type(el, value, caret, event);

    test("answers to older keystrokes never overwrite newer text", () => {
      const { renderer, engine, el } = make();
      el.focus();
      const text = "Buy milk";
      for (let i = 1; i <= text.length; i++) edit(el, text.slice(0, i));
      expect(engine.sent("setX")).toEqual([...text].map((_, i) => text.slice(0, i + 1)));
      answer(renderer, "B");
      expect(el.value).toBe("Buy milk");
      answer(renderer, "Bu");
      edit(el, "Buy milk!");
      answer(renderer, "Buy");
      expect(el.value).toBe("Buy milk!");
      for (const v of ["Buy ", "Buy m", "Buy mi", "Buy mil", "Buy milk"]) {
        answer(renderer, v);
        expect(el.value).toBe("Buy milk!");
      }
      answer(renderer, "Buy milk!");
      expect(el.value).toBe("Buy milk!");
      expect(el.selectionStart).toBe(9);
      expect(hasOutstandingBindWrites(el)).toBe(false);
    });

    test("an uppercasing handler: older rewrites are held, the newest applies with the caret kept", () => {
      const { renderer, el } = make();
      el.focus();
      edit(el, "a");
      edit(el, "ab");
      edit(el, "abc");
      // Answers to "a" and "ab" while "abc" is in flight: the field keeps
      // the user's text instead of snapping back to a shorter value.
      answer(renderer, "A");
      expect(el.value).toBe("abc");
      answer(renderer, "AB");
      expect(el.value).toBe("abc");
      edit(el, "abcd");
      answer(renderer, "ABC");
      expect(el.value).toBe("abcd");
      // The answer to the newest write is the handler's result: applied.
      answer(renderer, "ABCD");
      expect(el.value).toBe("ABCD");
      expect(el.selectionStart).toBe(4);
      expect(hasOutstandingBindWrites(el)).toBe(false);
    });

    test("a rewrite with nothing else in flight applies at once, caret clamped", () => {
      const { renderer, el } = make();
      el.focus();
      edit(el, "hello", 2);
      answer(renderer, "HELLO");
      expect(el.value).toBe("HELLO");
      expect(el.selectionStart).toBe(2);
      // A shortening rewrite (strip digits) clamps the caret to the end.
      edit(el, "HELLO123");
      answer(renderer, "HELLO");
      expect(el.value).toBe("HELLO");
      expect(el.selectionStart).toBe(5);
    });

    test("a write that gets no answer (state unchanged) lets a held rewrite settle", async () => {
      const { renderer, el } = make();
      el.focus();
      // Strip-digits handler: "a1" leaves state "a" unchanged → no answer.
      edit(el, "a");
      edit(el, "a1");
      edit(el, "a1b");
      answer(renderer, "a"); // answers "a" (exact): stale, "a1"/"a1b" pending
      expect(el.value).toBe("a1b");
      answer(renderer, "ab"); // answers "a1b"; "a1" never gets one
      expect(el.value).toBe("a1b");
      await settle();
      expect(el.value).toBe("ab");
      expect(el.selectionStart).toBe(2);
      expect(hasOutstandingBindWrites(el)).toBe(false);
    });

    test("a held rewrite is superseded by a newer exact answer", async () => {
      const { renderer, el } = make();
      el.focus();
      edit(el, "a");
      edit(el, "ab");
      edit(el, "abc");
      answer(renderer, "zzz"); // an unrelated value while writes are in flight
      expect(el.value).toBe("abc");
      answer(renderer, "a");
      answer(renderer, "ab");
      answer(renderer, "abc");
      await settle();
      expect(el.value).toBe("abc");
    });

    test("clear after submit applies, and typing resumes from the empty field", () => {
      const { renderer, el } = make();
      el.focus();
      edit(el, "h");
      edit(el, "hi");
      answer(renderer, "h");
      answer(renderer, "hi");
      // Submit action: state.x = "".
      answer(renderer, "");
      expect(el.value).toBe("");
      edit(el, "n");
      answer(renderer, "n");
      expect(el.value).toBe("n");
    });

    test("clear after submit while keystrokes are still in flight", () => {
      const { renderer, el } = make();
      el.focus();
      edit(el, "h");
      edit(el, "hi");
      // Server order: setX("h"), setX("hi"), submit clears.
      answer(renderer, "h");
      expect(el.value).toBe("hi");
      answer(renderer, "hi");
      answer(renderer, "");
      expect(el.value).toBe("");
      expect(el.selectionStart).toBe(0);
    });

    test("repeated identical values are matched in order", () => {
      const { renderer, el } = make();
      el.focus();
      edit(el, "a");
      edit(el, "");
      edit(el, "a");
      edit(el, "ab");
      answer(renderer, "a");
      answer(renderer, "");
      expect(el.value).toBe("ab");
      answer(renderer, "a");
      expect(el.value).toBe("ab");
      answer(renderer, "ab");
      expect(el.value).toBe("ab");
      expect(hasOutstandingBindWrites(el)).toBe(false);
    });

    test("with nothing in flight, engine values apply as before", () => {
      const { renderer, el } = make();
      answer(renderer, "from state");
      expect(el.value).toBe("from state");
      answer(renderer, "");
      expect(el.value).toBe("");
    });
  });
}

describe("fields the controlled-input reconciliation must not touch", () => {
  test("an uncontrolled Input (no value prop) records nothing and its handler still fires", () => {
    const { engine, el } = mount("Input", { placeholder: "free", onInput: "@actions.log" });
    el.focus();
    type(el, "a");
    type(el, "ab");
    expect(engine.sent("log")).toEqual(["a", "ab"]);
    expect(hasOutstandingBindWrites(el)).toBe(false);
    expect(el.value).toBe("ab");
  });

  test("an Input that becomes controlled later (first value via SetProp) is reconciled from then on", () => {
    const { renderer, el } = mount("Input", { onInput: "@actions.setX" });
    type(el, "x");
    expect(hasOutstandingBindWrites(el)).toBe(false);
    answer(renderer, "x");
    el.focus();
    type(el, "xy");
    type(el, "xyz");
    answer(renderer, "xy");
    expect(el.value).toBe("xyz");
  });

  test("a custom payload (no field value sent) records nothing", () => {
    const { renderer, engine, el } = mount("Input", {
      value: "",
      onInput: { "0": "@actions.ping", k: 1 },
    });
    el.focus();
    type(el, "abc");
    expect(engine.actions.some((a) => a.name === "ping")).toBe(true);
    expect(hasOutstandingBindWrites(el)).toBe(false);
    answer(renderer, "server");
    expect(el.value).toBe("server");
  });

  test("a controlled Input without a handler follows every engine value", () => {
    const { renderer, el } = mount("Input", { value: "a" });
    el.focus();
    el.value = "typed";
    answer(renderer, "b");
    expect(el.value).toBe("b");
  });
});
