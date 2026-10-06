/**
 * Regressions in how the DOM renderer routes props to component handlers.
 *
 * Three defects are covered here:
 *
 *  1. `Heading().level(n)` was a no-op. The handler built a replacement
 *     `h{level}` and called `replaceChild`, but `createElement` runs
 *     `applyProps` before the element is ever parented, so the branch never
 *     fired and every heading stayed `<h2>`.
 *
 *  2. `COMPONENT_HTML_ATTRS` gates which props reach `applyProps` on SetProp.
 *     Components missing from it (Slider, ProgressBar, Audio, Icon, Avatar)
 *     rendered once and then froze — the applicator CSS fallback silently
 *     no-ops an element attribute.
 *
 *  3. The engine lowers applicators to `<name>.0` while constructor args stay
 *     bare, so `Slider(value: 5)` and `Slider().value(5)` arrive under
 *     different keys. Handlers read only the bare spelling.
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

describe("Heading level", () => {
  test("level picks the tag at create time", () => {
    const { renderer } = makeRenderer();
    const el = create(renderer, "h", "Heading", { level: 1, "0": "Title" });
    expect(el.tagName.toLowerCase()).toBe("h1");
    expect(el.textContent).toBe("Title");
  });

  test("the applicator spelling level.0 works too", () => {
    const { renderer } = makeRenderer();
    const el = create(renderer, "h", "Heading", { "level.0": 3, "0": "Sub" });
    expect(el.tagName.toLowerCase()).toBe("h3");
  });

  test("no level still yields h2", () => {
    const { renderer } = makeRenderer();
    expect(create(renderer, "h", "Heading", {}).tagName.toLowerCase()).toBe("h2");
  });

  test("level is clamped to 1-6", () => {
    const { renderer } = makeRenderer();
    expect(create(renderer, "a", "Heading", { level: 9 }).tagName.toLowerCase()).toBe("h6");
    expect(create(renderer, "b", "Heading", { level: 0 }).tagName.toLowerCase()).toBe("h1");
  });

  test("a reactive level change becomes aria-level, keeping the node identity", () => {
    const { renderer } = makeRenderer();
    const el = create(renderer, "h", "Heading", { level: 2, "0": "T" });
    setProp(renderer, "h", "level", 4);

    // Same element — replacing it would orphan the renderer's node map.
    expect((renderer as any).nodes.get("h")).toBe(el);
    expect(el.getAttribute("aria-level")).toBe("4");
  });

  test("returning to the tag's own level clears aria-level", () => {
    const { renderer } = makeRenderer();
    const el = create(renderer, "h", "Heading", { level: 2 });
    setProp(renderer, "h", "level", 5);
    expect(el.getAttribute("aria-level")).toBe("5");
    setProp(renderer, "h", "level", 2);
    expect(el.getAttribute("aria-level")).toBeFalsy();
  });
});

describe("reactive updates reach handlers (COMPONENT_HTML_ATTRS)", () => {
  test("ProgressBar value updates after create", () => {
    const { renderer } = makeRenderer();
    const el = create(renderer, "p", "ProgressBar", { value: 10, max: 100 });
    const bar = el.querySelector('[data-hypen-bar="true"]');
    expect(bar.style.width).toBe("10%");

    setProp(renderer, "p", "value", 60);
    expect(bar.style.width).toBe("60%");
  });

  test("ProgressBar honours max", () => {
    const { renderer } = makeRenderer();
    const el = create(renderer, "p", "ProgressBar", { value: 30, max: 60 });
    expect(el.querySelector('[data-hypen-bar="true"]').style.width).toBe("50%");
  });

  test("Slider value updates after create", () => {
    const { renderer } = makeRenderer();
    const el = create(renderer, "s", "Slider", { value: 3, min: 0, max: 10 });
    expect(el.value).toBe("3");

    setProp(renderer, "s", "value", 7);
    expect(el.value).toBe("7");
  });

  test("Audio src updates after create", () => {
    const { renderer } = makeRenderer();
    const el = create(renderer, "a", "Audio", { src: "first.mp3" });
    expect(el.src).toBe("first.mp3");

    setProp(renderer, "a", "src", "second.mp3");
    expect(el.src).toBe("second.mp3");
  });

  test("Avatar src updates after create", () => {
    const { renderer } = makeRenderer();
    create(renderer, "av", "Avatar", { initials: "AB" });
    setProp(renderer, "av", "src", "u.png");

    const el = (renderer as any).nodes.get("av");
    expect(el.querySelector("img")?.src ?? el.src).toBe("u.png");
  });
});

describe("applicator .0 spelling reaches handlers", () => {
  test("Slider().value(5) lowers to value.0 and still applies", () => {
    const { renderer } = makeRenderer();
    const el = create(renderer, "s", "Slider", { "value.0": 5, "min.0": 0, "max.0": 10 });
    expect(el.value).toBe("5");
  });

  test("Input().value(x) lowers to value.0 and still applies", () => {
    const { renderer } = makeRenderer();
    const el = create(renderer, "i", "Input", { "value.0": "hello" });
    expect(el.value).toBe("hello");
  });

  test("a reactive value.0 SetProp applies", () => {
    const { renderer } = makeRenderer();
    const el = create(renderer, "i", "Input", { "value.0": "a" });
    setProp(renderer, "i", "value.0", "b");
    expect(el.value).toBe("b");
  });

  test("a bare key already present wins over the .0 alias", () => {
    const { renderer } = makeRenderer();
    const el = create(renderer, "i", "Input", { value: "bare", "value.0": "dotted" });
    expect(el.value).toBe("bare");
  });
});

describe("Input attributes promised by COMPONENT_HTML_ATTRS", () => {
  test("disabled is honoured rather than swallowed", () => {
    const { renderer } = makeRenderer();
    const el = create(renderer, "i", "Input", { disabled: true });
    expect(el.disabled).toBe(true);

    setProp(renderer, "i", "disabled", false);
    expect(el.disabled).toBe(false);
  });

  test("readonly and name are honoured", () => {
    const { renderer } = makeRenderer();
    const el = create(renderer, "i", "Input", { readonly: true, name: "email" });
    expect(el.readOnly).toBe(true);
    expect(el.name).toBe("email");
  });

  test('the string "false" is falsey, not truthy', () => {
    const { renderer } = makeRenderer();
    const el = create(renderer, "i", "Input", { disabled: "false" });
    expect(el.disabled).toBe(false);
  });
});

/**
 * Routing a prop to `applyProps` must not corrupt the element.
 *
 * Handlers are written against the create-time contract "these are all my
 * props", and several derive one output from several inputs. Handing them a
 * lone changed key made them recompute from missing inputs: ProgressBar snaps
 * to 0% because `value` is absent, Icon replaces its resolved SVG with the
 * "?" placeholder because `__iconPaths` is absent.
 */
describe("partial SetProp does not corrupt multi-input handlers", () => {
  test("ProgressBar keeps its value when only the colour changes", () => {
    const { renderer } = makeRenderer();
    const el = create(renderer, "p", "ProgressBar", { value: 60, max: 100 });
    const bar = el.querySelector('[data-hypen-bar="true"]');
    expect(bar.style.width).toBe("60%");

    setProp(renderer, "p", "color", "red");
    expect(bar.style.width).toBe("60%");
    expect(bar.style.backgroundColor).toBe("red");
  });

  test("ProgressBar keeps its value when only the height changes", () => {
    const { renderer } = makeRenderer();
    const el = create(renderer, "p", "ProgressBar", { value: 40, max: 100 });
    setProp(renderer, "p", "height", 12);
    expect(el.querySelector('[data-hypen-bar="true"]').style.width).toBe("40%");
  });

  test("ProgressBar recomputes against the remembered max", () => {
    const { renderer } = makeRenderer();
    const el = create(renderer, "p", "ProgressBar", { value: 10, max: 50 });
    setProp(renderer, "p", "value", 25);
    expect(el.querySelector('[data-hypen-bar="true"]').style.width).toBe("50%");
  });

  test("Icon keeps its resolved paths when only the colour changes", () => {
    const { renderer } = makeRenderer();
    const el = create(renderer, "i", "Icon", {
      "0": "home",
      size: 48,
      __iconPaths: [{ d: "M0 0h24v24H0z" }],
      __iconViewBox: "0 0 24 24",
    });
    expect(el.textContent).not.toBe("?");

    setProp(renderer, "i", "color.0", "red");
    // The placeholder branch would have written "?" and reset the box to 24px.
    expect(el.textContent).not.toBe("?");
    expect(el.style.width).not.toBe("24px");
  });

  test("Icon keeps its size when the paths are replaced", () => {
    const { renderer } = makeRenderer();
    const el = create(renderer, "i", "Icon", {
      "0": "home",
      size: 48,
      __iconPaths: [{ d: "M0 0h24v24H0z" }],
    });
    setProp(renderer, "i", "__iconPaths", [{ d: "M1 1h2v2H1z" }]);
    // The SVG is rebuilt; it must be rebuilt at the element's own size, not
    // at the handler's 24px default.
    const svg = el.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg.getAttribute("width")).toBe("48");
  });

  test("Avatar keeps its image when only the initials change", () => {
    const { renderer } = makeRenderer();
    create(renderer, "av", "Avatar", { src: "u.png", initials: "AB" });
    setProp(renderer, "av", "initials", "CD");

    const el = (renderer as any).nodes.get("av");
    expect(el.querySelector("img")?.src).toBe("u.png");
  });

  test("the prop cache does not outlive the node", () => {
    const { renderer } = makeRenderer();
    create(renderer, "p", "ProgressBar", { value: 10 });
    expect((renderer as any).handlerProps.has("p")).toBe(true);
    renderer.applyPatches([{ type: "remove", id: "p" } as Patch]);
    expect((renderer as any).handlerProps.has("p")).toBe(false);
  });
});

/**
 * Regressions found by adversarial audit of 8cb1aaf itself.
 *
 * Handing the handler the full cached prop set fixed the "recompute from
 * defaults" bug but introduced three of its own: the cache holds the
 * CREATE-time value, so re-asserting it clobbered whatever the user had since
 * typed or clicked; the positional `0`/`text` branch applied a lone key and
 * never updated the cache, so the next patch reverted the content; and the
 * template path never seeded the cache at all, leaving list rows with exactly
 * the bug the commit claimed to fix.
 */
describe("the prop cache does not fight the live DOM", () => {
  test("a user's typed value survives an unrelated SetProp", () => {
    const { renderer } = makeRenderer();
    const el = create(renderer, "i", "Input", { value: "a" });
    el.value = "hello";

    setProp(renderer, "i", "disabled", true);
    expect(el.value).toBe("hello");
    expect(el.disabled).toBe(true);
  });

  test("a user's checkbox click survives an unrelated SetProp", () => {
    const { renderer } = makeRenderer();
    const el = create(renderer, "c", "Checkbox", { checked: false });
    const field = el.querySelector("input,select,textarea") ?? el;
    field.checked = true;

    setProp(renderer, "c", "disabled", true);
    expect(field.checked).toBe(true);
  });

  test("an engine patch to the live prop itself still wins", () => {
    const { renderer } = makeRenderer();
    const el = create(renderer, "i", "Input", { value: "a" });
    el.value = "hello";

    setProp(renderer, "i", "value", "fromEngine");
    expect(el.value).toBe("fromEngine");
  });
});

describe("the positional 0 prop updates the cache", () => {
  test("a later unrelated SetProp does not revert the text", () => {
    const { renderer } = makeRenderer();
    const el = create(renderer, "b", "Badge", { "0": "New", theme: "info" });

    setProp(renderer, "b", "0", "5");
    expect(el.textContent).toBe("5");

    setProp(renderer, "b", "theme", "error");
    expect(el.textContent).toBe("5");
  });

  test("a later SetProp does not revert an Avatar's source", () => {
    const { renderer } = makeRenderer();
    create(renderer, "av", "Avatar", { "0": "a.png", size: 40 });
    setProp(renderer, "av", "0", "b.png");
    setProp(renderer, "av", "size", 60);

    const el = (renderer as any).nodes.get("av");
    expect(el.querySelector("img")?.src ?? el.src).toBe("b.png");
  });
});

describe("templated rows seed the prop cache", () => {
  test("a ProgressBar clone keeps its template's max", () => {
    const { renderer } = makeRenderer();
    renderer.applyPatches([
      { type: "create", id: "list", elementType: "Column", props: {} } as any,
      {
        type: "registerTemplate",
        templateId: "t",
        root: { elementType: "ProgressBar", props: { max: 200 }, children: [] },
      } as any,
      {
        type: "instantiate",
        templateId: "t",
        parentId: "list",
        nodes: ["r1"],
        subs: [[0, "value", 50]],
        nodeSemantics: [],
      } as any,
    ]);

    const el = (renderer as any).nodes.get("r1");
    // Without the seed, `max` fell back to the handler's default of 100 and
    // the bar read 50%.
    expect(el.querySelector('[data-hypen-bar="true"]').style.width).toBe("25%");
  });
});

describe("live-prop sync covers every spelling the handler reads", () => {
  test.each(["on", "value", "checked"])("Switch(%s: true) toggled off survives an unrelated SetProp", (key) => {
    const { renderer } = makeRenderer();
    const el = create(renderer, "s", "Switch", { [key]: true });
    const input = el.querySelector('[data-hypen-switch="true"]');
    expect(input.checked).toBe(true);
    input.checked = false; // user click
    setProp(renderer, "s", "disabled", true);
    expect(input.checked).toBe(false);
  });

  test("Select keeps its value when options are replaced", () => {
    const { renderer } = makeRenderer();
    const el = create(renderer, "sel", "Select", { options: ["a", "b"], value: "b" });
    setProp(renderer, "sel", "options", ["a", "b", "c"]);
    expect(el.value).toBe("b");
  });
});
