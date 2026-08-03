/**
 * Form-control accessibility in the DOM renderer: the auto-associated
 * label pair the engine wires at expand (Text `id` anchor + control
 * `labelledby`/`name`) and the reactive `.invalid` → `aria-invalid` state.
 *
 * The engine-side wiring itself is covered in
 * `hypen-engine-rs/tests/test_form_label_association.rs`; these tests pin
 * the DOM translation of the blocks it emits.
 */

import { describe, expect, test } from "bun:test";
import { DOMRenderer } from "../packages/web/src/dom/renderer";
import type { Patch } from "../packages/core/src/types";
import type { IEngine as Engine } from "../packages/core/src/app";
import { ensureFakeDomGlobals } from "./fake-dom";

ensureFakeDomGlobals();

class StubEngine {
  dispatchAction(): void {}
}

const makeRenderer = () => {
  const container = document.createElement("div");
  const renderer = new DOMRenderer(container, new StubEngine() as unknown as Engine);
  return { container, renderer };
};

const attrs = (node: unknown): Record<string, string> =>
  (node as { attributes?: Record<string, string> }).attributes ?? {};

describe("auto-associated form labels", () => {
  test("the wired pair lands as id ↔ aria-labelledby, with no aria-label", () => {
    const { renderer } = makeRenderer();

    // What the engine emits for
    //   Column { Text("Name") Input(...) }.id("signup")
    renderer.applyPatches([
      {
        type: "create",
        id: "t1",
        elementType: "Text",
        props: { "0": "Name" },
        semantics: { id: "signup-label-0" },
      } as Patch,
      {
        type: "create",
        id: "i1",
        elementType: "Input",
        props: {},
        semantics: { role: "textbox", name: "Name", labelledby: "signup-label-0" },
      } as Patch,
    ]);

    // The Text is the reference anchor.
    expect(attrs(renderer.getNode("t1")).id).toBe("signup-label-0");

    const input = attrs(renderer.getNode("i1"));
    expect(input["aria-labelledby"]).toBe("signup-label-0");
    // The auto-wired name is non-explicit: aria-labelledby provides the DOM
    // name, so aria-label must NOT be applied (it would shadow the live Text).
    expect("aria-label" in input).toBe(false);
    // <input> already implies textbox — no redundant role.
    expect("role" in input).toBe(false);
  });
});

describe("aria-invalid", () => {
  test("is applied on create for both true and false", () => {
    const { renderer } = makeRenderer();
    renderer.applyPatches([
      {
        type: "create",
        id: "bad",
        elementType: "Input",
        props: {},
        semantics: { role: "textbox", invalid: true },
      } as Patch,
      {
        type: "create",
        id: "ok",
        elementType: "Input",
        props: {},
        semantics: { role: "textbox", invalid: false },
      } as Patch,
    ]);
    expect(attrs(renderer.getNode("bad"))["aria-invalid"]).toBe("true");
    // An explicit false is meaningful (explicitly valid), not an omission.
    expect(attrs(renderer.getNode("ok"))["aria-invalid"]).toBe("false");
  });

  test("tracks setSemantics re-emits and clears when the block drops it", () => {
    const { renderer } = makeRenderer();
    renderer.applyPatches([
      {
        type: "create",
        id: "f1",
        elementType: "Input",
        props: {},
        semantics: { role: "textbox", invalid: false },
      } as Patch,
    ]);
    expect(attrs(renderer.getNode("f1"))["aria-invalid"]).toBe("false");

    // Bound `.invalid(@state.hasError)` flips → the engine re-emits the
    // full block; the attribute must follow.
    renderer.applyPatches([
      {
        type: "setSemantics",
        id: "f1",
        semantics: { role: "textbox", invalid: true },
      } as Patch,
    ]);
    expect(attrs(renderer.getNode("f1"))["aria-invalid"]).toBe("true");

    // Block without the field → the managed attribute is removed, not left
    // stale.
    renderer.applyPatches([
      { type: "setSemantics", id: "f1", semantics: { role: "textbox" } } as Patch,
    ]);
    expect("aria-invalid" in attrs(renderer.getNode("f1"))).toBe(false);
  });
});
