/**
 * DOM renderer parity with the native renderers.
 *
 * Three gaps are covered here:
 *
 *  1. Boolean coercion. The remote protocol and Tailwind lowering both
 *     deliver booleans as strings, so `Boolean(props.x)` made the wire value
 *     "false" TRUTHY — `Slider(disabled: "false")` disabled the slider.
 *     Every control routes through the shared `toBool` instead.
 *
 *  2. RemoveProp. Only Divider routed a removal to its handler; every other
 *     component fell to the applicator CSS fallback, which no-ops on an
 *     element attribute — `Input.disabled` could be set but never cleared.
 *
 *  3. `foregroundColor`, the Swift/Android spelling of the text colour, had
 *     no DOM applicator, so the unknown-prop fallback wrote the non-existent
 *     CSS property `foreground-color` and the colour was silently dropped.
 */

import { describe, expect, test } from "bun:test";
import { DOMRenderer } from "../packages/web/src/dom/renderer";
import { getVideoSurface } from "../packages/web/src/dom/components/video";
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

/** Create a node, then read it back out of the renderer's element map. */
const create = (
  renderer: DOMRenderer,
  id: string,
  elementType: string,
  props: Record<string, any>
): any => {
  renderer.applyPatches([{ type: "create", id, elementType, props } as Patch]);
  return (renderer as any).nodes.get(id);
};

const setProp = (renderer: DOMRenderer, id: string, name: string, value: any) => {
  renderer.applyPatches([{ type: "setProp", id, name, value } as Patch]);
};

const removeProp = (renderer: DOMRenderer, id: string, name: string) => {
  renderer.applyPatches([{ type: "removeProp", id, name } as Patch]);
};

/** The `<input>` a Checkbox/Switch wrapper owns. */
const control = (wrapper: any, marker: string): any =>
  wrapper.querySelector(`[${marker}="true"]`);

describe("string booleans off the wire", () => {
  test('Slider(disabled: "false") stays interactive, "true" still disables', () => {
    const { renderer } = makeRenderer();
    expect(create(renderer, "s", "Slider", { disabled: "false" }).disabled).toBe(false);
    expect(create(renderer, "a", "Slider", { disabled: "true" }).disabled).toBe(true);
    expect(create(renderer, "b", "Slider", { disabled: true }).disabled).toBe(true);
  });

  test("Select disabled/multiple accept the padded, mixed-case spelling", () => {
    const { renderer } = makeRenderer();
    const el = create(renderer, "sel", "Select", { disabled: " FALSE ", multiple: "0" });
    expect(el.disabled).toBe(false);
    expect(el.multiple).toBe(false);
  });

  test("Audio transport flags are not enabled by the string false", () => {
    const { renderer } = makeRenderer();
    const el = create(renderer, "au", "Audio", {
      controls: "false",
      autoplay: "false",
      loop: "false",
      muted: "false",
    });
    expect(el.controls).toBe(false);
    expect(el.autoplay).toBe(false);
    expect(el.loop).toBe(false);
    expect(el.muted).toBe(false);
  });

  test("Checkbox checked/disabled are not turned on by the string false", () => {
    const { renderer } = makeRenderer();
    const input = control(
      create(renderer, "cb", "Checkbox", { checked: "false", disabled: "false" }),
      "data-hypen-checkbox"
    );
    expect(input.checked).toBe(false);
    expect(input.disabled).toBe(false);
  });

  test("Switch checked/disabled are not turned on by the string false", () => {
    const { renderer } = makeRenderer();
    const input = control(
      create(renderer, "sw", "Switch", { checked: "false", disabled: "false" }),
      "data-hypen-switch"
    );
    expect(input.checked).toBe(false);
    expect(input.disabled).toBe(false);
  });

  test("Video shares the same coercion, so a mixed-case false is false", () => {
    const { renderer } = makeRenderer();
    const root = create(renderer, "vid", "Video", { src: "clip.mp4", controls: "FALSE" });
    expect((getVideoSurface(root) as any).controls).toBe(false);
  });
});

describe("RemoveProp clears an element attribute", () => {
  test("a removed Input.disabled re-enables the field", () => {
    const { renderer } = makeRenderer();
    const el = create(renderer, "i", "Input", { disabled: true, placeholder: "Name" });
    expect(el.disabled).toBe(true);

    removeProp(renderer, "i", "disabled");
    expect(el.disabled).toBe(false);
    // The rest of the node's props are re-applied untouched.
    expect(el.placeholder).toBe("Name");
  });

  test("the applicator spelling is removed as one with the bare one", () => {
    const { renderer } = makeRenderer();
    const el = create(renderer, "i", "Input", { "disabled.0": true });
    expect(el.disabled).toBe(true);

    removeProp(renderer, "i", "disabled.0");
    expect(el.disabled).toBe(false);
  });

  test("a removed Textarea.readonly makes it writable again", () => {
    const { renderer } = makeRenderer();
    const el = create(renderer, "t", "Textarea", { readonly: true });
    expect(el.readOnly).toBe(true);

    removeProp(renderer, "t", "readonly");
    expect(el.readOnly).toBe(false);
  });

  test("a removed Switch.disabled re-enables the toggle", () => {
    const { renderer } = makeRenderer();
    const input = control(create(renderer, "sw", "Switch", { disabled: true }), "data-hypen-switch");
    expect(input.disabled).toBe(true);

    removeProp(renderer, "sw", "disabled");
    expect(input.disabled).toBe(false);
  });

  test("a prop set after create is still removable", () => {
    const { renderer } = makeRenderer();
    const el = create(renderer, "s", "Slider", {});
    setProp(renderer, "s", "disabled", true);
    expect(el.disabled).toBe(true);

    removeProp(renderer, "s", "disabled");
    expect(el.disabled).toBe(false);
  });

  test("the handler gets the node's remaining props, not the lone removed key", () => {
    const { renderer } = makeRenderer();
    const el = create(renderer, "p", "ProgressBar", { value: 40, max: 200 });
    const bar = el.querySelector('[data-hypen-bar="true"]');
    expect(bar.style.width).toBe("20%");

    // `max` falls back to 100 and `value` must survive: a lone-key call would
    // recompute the width from a missing value and snap the bar to 0%.
    removeProp(renderer, "p", "max");
    expect(bar.style.width).toBe("40%");
  });

  test("Divider keeps its own removal behaviour", () => {
    const { renderer } = makeRenderer();
    const el = create(renderer, "d", "Divider", {});
    setProp(renderer, "d", "orientation", "vertical");
    expect(el.dataset.hypenDividerOrientation).toBe("vertical");

    removeProp(renderer, "d", "orientation");
    expect(el.dataset.hypenDividerOrientation).toBe("horizontal");
    expect(el.style.height).toBe("1px");
    expect(el.style.getPropertyValue("width")).toBe("");
  });
});

describe("foregroundColor applicator", () => {
  test("it paints the inherited text colour, like the native renderers", () => {
    const { renderer } = makeRenderer();
    const el = create(renderer, "t", "Text", { "0": "Hi", foregroundColor: "red" });
    expect(el.style.color).toBe("red");
    // Not the invented `foreground-color` the unknown-prop fallback wrote.
    expect(el.style.getPropertyValue("foreground-color")).toBe("");
  });

  test("the applicator spelling works too", () => {
    const { renderer } = makeRenderer();
    const el = create(renderer, "t", "Text", { "0": "Hi", "foregroundColor.0": "#0af" });
    expect(el.style.color).toBe("#0af");
  });

  test("a reactive change repaints it", () => {
    const { renderer } = makeRenderer();
    const el = create(renderer, "t", "Text", { "0": "Hi", foregroundColor: "red" });
    setProp(renderer, "t", "foregroundColor", "blue");
    expect(el.style.color).toBe("blue");
  });
});

/**
 * Defects found by adversarial review of the parity changes themselves.
 */
describe("RemoveProp does not strand applicator bookkeeping", () => {
  test("removing `size` clears the width-source marker it recorded", () => {
    const { renderer } = makeRenderer();
    renderer.applyPatches([{ type: "create", id: "a", elementType: "Avatar",
      props: { initials: "AB", size: "50%" } } as Patch]);
    const el: any = (renderer as any).nodes.get("a");
    expect(el.dataset.hypenWidthSourceSize).toBe("relative");

    renderer.applyPatches([{ type: "removeProp", id: "a", name: "size" } as Patch]);
    // `size` is backed by BOTH the avatar handler and the size applicator.
    // Running only the handler stranded this marker, and the reconcile that
    // follows then read it back as a live width demand.
    expect(el.dataset.hypenWidthSourceSize).toBeUndefined();
    expect(el.dataset.hypenHorizontalWidthDemand).toBeUndefined();
  });
});

describe("handlerProps caches the spelling handlers actually read", () => {
  test("a node built only from applicators caches the bare alias too", () => {
    const { renderer } = makeRenderer();
    renderer.applyPatches([{ type: "create", id: "i", elementType: "Image",
      props: { "src.0": "a.png", alt: "A" } } as Patch]);

    const cached = (renderer as any).handlerProps.get("i");
    // Without the alias every bare read in the merged set is undefined, so
    // the next merge-and-reapply looks to the handler like "src was removed".
    expect(cached.src).toBe("a.png");
  });

  test("an unrelated removal does not blank the image", () => {
    const { renderer } = makeRenderer();
    renderer.applyPatches([{ type: "create", id: "i", elementType: "Image",
      props: { "src.0": "a.png", alt: "A" } } as Patch]);
    renderer.applyPatches([{ type: "removeProp", id: "i", name: "alt" } as Patch]);
    expect((renderer as any).nodes.get("i").src).toBe("a.png");
  });
});

describe("color wins over foregroundColor in either order", () => {
  test("color declared last", () => {
    const { renderer } = makeRenderer();
    renderer.applyPatches([{ type: "create", id: "t", elementType: "Text",
      props: { foregroundColor: "red", color: "blue" } } as Patch]);
    expect((renderer as any).nodes.get("t").style.color).toBe("blue");
  });

  test("color declared first", () => {
    const { renderer } = makeRenderer();
    renderer.applyPatches([{ type: "create", id: "t", elementType: "Text",
      props: { color: "blue", foregroundColor: "red" } } as Patch]);
    expect((renderer as any).nodes.get("t").style.color).toBe("blue");
  });

  test("foregroundColor alone still applies", () => {
    const { renderer } = makeRenderer();
    renderer.applyPatches([{ type: "create", id: "t", elementType: "Text",
      props: { foregroundColor: "red" } } as Patch]);
    expect((renderer as any).nodes.get("t").style.color).toBe("red");
  });
});
