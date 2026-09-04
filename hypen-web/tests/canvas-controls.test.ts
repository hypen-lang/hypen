/**
 * Canvas form controls are operable.
 *
 * Checkbox, Radio, Switch and Slider painted correctly and responded to
 * nothing: the canvas synthesized only pointer/key/focus events, there was no
 * `change`/`input` dispatch anywhere, and `.bind()` covered `input`/`textarea`
 * alone. The docs make `.onChange` the canonical wiring for exactly these
 * controls (hypen-docs/content/docs/guide/inputs.mdx).
 */

import { test, expect, describe } from "bun:test";
import {
  isFormControl,
  isToggleControl,
  isChecked,
  isControlDisabled,
  sliderValueAt,
  sliderRange,
  activateToggle,
  stepSlider,
  updateSliderDrag,
  finishSliderDrag,
  handleControlKey,
} from "../packages/web/src/canvas/controls";
import type { VirtualNode } from "../packages/web/src/canvas/types";
import { ensureFakeDomGlobals } from "./fake-dom";

class MockEngine {
  dispatched: Array<{ name: string; payload: any }> = [];
  dispatchAction(name: string, payload?: any) {
    this.dispatched.push({ name, payload });
  }
}

const node = (type: string, props: Record<string, any> = {}): VirtualNode =>
  ({
    id: "n",
    type,
    props,
    children: [],
    parent: null,
    visible: true,
    opacity: 1,
    clickable: true,
    hoverable: true,
    focusable: true,
    focused: false,
    hovered: false,
    layout: { x: 0, y: 0, width: 216, height: 20 },
  }) as unknown as VirtualNode;

describe("control identification", () => {
  test("recognises the four operable types", () => {
    for (const t of ["checkbox", "radio", "switch", "slider"]) {
      expect(isFormControl(node(t))).toBe(true);
    }
    expect(isFormControl(node("column"))).toBe(false);
  });

  test("a node with no type is not a control rather than a crash", () => {
    // The accessibility-mirror path resolves nodes from a DOM id, so a node
    // without `type` reaches these predicates.
    expect(() => isToggleControl({ props: {} } as any)).not.toThrow();
    expect(isToggleControl({ props: {} } as any)).toBe(false);
  });
});

describe("checked state", () => {
  test("reads checked, on and value", () => {
    expect(isChecked(node("checkbox", { checked: true }))).toBe(true);
    expect(isChecked(node("switch", { on: true }))).toBe(true);
    expect(isChecked(node("checkbox", { value: true }))).toBe(true);
    expect(isChecked(node("checkbox", {}))).toBe(false);
  });

  test('the wire string "false" is falsey', () => {
    expect(isChecked(node("checkbox", { checked: "false" }))).toBe(false);
    expect(isControlDisabled(node("slider", { disabled: "false" }))).toBe(false);
    expect(isControlDisabled(node("slider", { disabled: "true" }))).toBe(true);
  });

  test("enabled: false means disabled", () => {
    expect(isControlDisabled(node("checkbox", { enabled: false }))).toBe(true);
  });
});

describe("toggles", () => {
  test("a checkbox toggles and dispatches onChange", () => {
    const e = new MockEngine();
    const n = node("checkbox", { checked: false, onChange: "@actions.toggle" });

    expect(activateToggle(e, n)).toBe(true);
    expect(n.props.checked).toBe(true);
    expect(e.dispatched.map((d) => d.name)).toContain("toggle");
  });

  test("a switch toggles back off", () => {
    const e = new MockEngine();
    const n = node("switch", { on: true });
    activateToggle(e, n);
    expect(n.props.on).toBe(false);
  });

  test("bind dispatches __hypen_bind with the path and value", () => {
    const e = new MockEngine();
    const n = node("checkbox", { checked: false, bind: "form.agreed" });

    activateToggle(e, n);
    const bind = e.dispatched.find((d) => d.name === "__hypen_bind");
    expect(bind).toBeDefined();
    expect(bind!.payload).toEqual({ path: "form.agreed", value: true });
  });

  test("a disabled control does nothing at all", () => {
    const e = new MockEngine();
    const n = node("checkbox", { checked: false, disabled: true, bind: "x" });

    expect(activateToggle(e, n)).toBe(false);
    expect(n.props.checked).toBe(false);
    expect(e.dispatched).toHaveLength(0);
  });

  test("a selected radio does not turn itself off", () => {
    const e = new MockEngine();
    const n = node("radio", { checked: true });
    expect(activateToggle(e, n)).toBe(false);
    expect(n.props.checked).toBe(true);
  });

  test("an unselected radio selects", () => {
    const e = new MockEngine();
    const n = node("radio", { checked: false });
    expect(activateToggle(e, n)).toBe(true);
    expect(n.props.checked).toBe(true);
  });

  test("the authored spelling is the one written back", () => {
    const e = new MockEngine();
    const n = node("switch", { on: false });
    activateToggle(e, n);
    // `on` was the authored key, so the painter must keep reading it —
    // writing the new state to `checked` instead would leave the paint stale.
    expect(n.props.on).toBe(true);
    expect(n.props.checked).toBeUndefined();
  });
});

describe("radio groups", () => {
  const group = (checkedIdx: number) => {
    const parent = node("column");
    const radios = ["a", "b", "c"].map((v, i) =>
      ({ ...node("radio", { name: "g", value: v, checked: i === checkedIdx, onChange: "@actions.pick" }), id: v, parent }) as VirtualNode);
    parent.children = radios;
    return radios;
  };

  test("a radio's value is its option id, not its state", () => {
    expect(isChecked(node("radio", { value: "a" }))).toBe(false);
    expect(isChecked(node("radio", { value: "a", checked: true }))).toBe(true);
  });

  test("selecting a radio clears its group siblings and reports the option value", () => {
    const e = new MockEngine();
    const [a, b, c] = group(0);
    expect(activateToggle(e, b)).toBe(true);
    expect(a.props.checked).toBe(false);
    expect(b.props.checked).toBe(true);
    expect(c.props.checked).toBe(false);
    // The option value is not clobbered by the state write.
    expect(b.props.value).toBe("b");
    const pick = e.dispatched.find((d) => d.name === "pick");
    expect(pick?.payload.value).toBe("b");
    expect(pick?.payload.checked).toBe(true);
  });
});

describe("slider", () => {
  test("range defaults to 0-100", () => {
    expect(sliderRange(node("slider", {}))).toEqual({ min: 0, max: 100, step: 0 });
  });

  test("a degenerate range does not divide by zero", () => {
    const r = sliderRange(node("slider", { min: 5, max: 5 }));
    expect(r.max).toBeGreaterThan(r.min);
    expect(Number.isFinite(sliderValueAt(node("slider", { min: 5, max: 5 }), 100))).toBe(true);
  });

  test("value tracks pointer position across the usable track", () => {
    // width 216, thumb 16 -> usable 200, inset 8 each side.
    const n = node("slider", { min: 0, max: 100 });
    expect(sliderValueAt(n, 8)).toBeCloseTo(0, 5);
    expect(sliderValueAt(n, 108)).toBeCloseTo(50, 5);
    expect(sliderValueAt(n, 208)).toBeCloseTo(100, 5);
  });

  test("dragging past either end clamps", () => {
    const n = node("slider", { min: 0, max: 100 });
    expect(sliderValueAt(n, -500)).toBe(0);
    expect(sliderValueAt(n, 5000)).toBe(100);
  });

  test("step snaps and does not leave float dust", () => {
    const n = node("slider", { min: 0, max: 1, step: 0.1 });
    const v = sliderValueAt(n, 68);
    expect(v).toBe(0.3);
  });

  test("a drag writes the value, binds and dispatches input per move — change only on release", () => {
    const e = new MockEngine();
    const n = node("slider", {
      min: 0, max: 100, value: 0, bind: "state.v",
      onInput: "@actions.preview", onChange: "@actions.set",
    });

    expect(updateSliderDrag(e, n, 108)).toBe(true);
    expect(n.props.value).toBeCloseTo(50, 5);
    expect(updateSliderDrag(e, n, 150)).toBe(true);
    const names = e.dispatched.map((d) => d.name);
    // Two moves: two bind writes, two previews, no commit yet.
    expect(names.filter((x) => x === "__hypen_bind")).toHaveLength(2);
    expect(names.filter((x) => x === "preview")).toHaveLength(2);
    expect(names).not.toContain("set");

    finishSliderDrag(e, n);
    const sets = e.dispatched.filter((d) => d.name === "set");
    expect(sets).toHaveLength(1);
    expect(sets[0].payload.value).toBeCloseTo(n.props.value, 5);
  });

  test("a drag to the value it already holds dispatches nothing", () => {
    const e = new MockEngine();
    const n = node("slider", { min: 0, max: 100, value: 50 });
    expect(updateSliderDrag(e, n, 108)).toBe(false);
    expect(e.dispatched).toHaveLength(0);
  });

  test("arrow keys step by `step`", () => {
    const e = new MockEngine();
    const n = node("slider", { min: 0, max: 10, step: 2, value: 4 });

    expect(handleControlKey(e, n, "ArrowRight")).toBe(true);
    expect(n.props.value).toBe(6);
    expect(handleControlKey(e, n, "ArrowLeft")).toBe(true);
    expect(n.props.value).toBe(4);
  });

  test("with no step, arrows move 1% of the range", () => {
    const e = new MockEngine();
    const n = node("slider", { min: 0, max: 200, value: 100 });
    stepSlider(e, n, 1);
    expect(n.props.value).toBe(102);
  });

  test("arrows stop at the bounds", () => {
    const e = new MockEngine();
    const n = node("slider", { min: 0, max: 10, step: 5, value: 10 });
    expect(handleControlKey(e, n, "ArrowRight")).toBe(false);
    expect(n.props.value).toBe(10);
  });
});

describe("keyboard activation", () => {
  test("space toggles a checkbox; Enter is left alone, as a native checkbox", () => {
    const e = new MockEngine();
    const n = node("checkbox", { checked: false });
    expect(handleControlKey(e, n, " ")).toBe(true);
    expect(n.props.checked).toBe(true);
    expect(handleControlKey(e, n, "Enter")).toBe(false);
    expect(n.props.checked).toBe(true);
  });

  test("an unrelated key is not consumed", () => {
    const e = new MockEngine();
    expect(handleControlKey(e, node("checkbox", {}), "a")).toBe(false);
    expect(handleControlKey(e, node("slider", {}), "a")).toBe(false);
  });

  test("arrows do nothing on a toggle", () => {
    const e = new MockEngine();
    expect(handleControlKey(e, node("switch", {}), "ArrowRight")).toBe(false);
  });
});

/**
 * Link activation.
 *
 * Routing on the canvas is ordinary action dispatch: `@router.push` is
 * normalised to `router.push` in `props.ts` and sent to the engine, which
 * owns route matching (`IRNode::Router`) and answers with detach/attach
 * patches. Nothing about it is renderer-local. The module-backed Link wires
 * its own `onClick`; the bare primitive form only needed a hit target.
 */
describe("Link is activatable", () => {
  test("a link carrying a destination is clickable without an explicit onClick", async () => {
    const { CanvasRenderer } = await import("../packages/web/src/canvas/renderer");
    const r = new CanvasRenderer(makeStubCanvas(), { dispatchAction() {} } as any);
    r.applyPatches([
      { type: "create", id: "l", elementType: "Link", props: { "0": "/next" } } as any,
    ]);
    expect((r as any).nodes.get("l").clickable).toBe(true);
  });

  test("clicking a bare in-app link dispatches router.push with `to`", async () => {
    const { dispatchNodeEvent } = await import("../packages/web/src/canvas/dispatch");
    const e = new MockEngine();
    dispatchNodeEvent(e, node("link", { "0": "/next" }), "click", {});
    expect(e.dispatched).toHaveLength(1);
    expect(e.dispatched[0].name).toBe("router.push");
    expect(e.dispatched[0].payload.to).toBe("/next");
  });

  test("a link with its own onClick keeps that and does not also route", async () => {
    const { dispatchNodeEvent } = await import("../packages/web/src/canvas/dispatch");
    const e = new MockEngine();
    dispatchNodeEvent(e, node("link", { "0": "/next", onClick: "@actions.go" }), "click", {});
    expect(e.dispatched.map((d) => d.name)).toEqual(["go"]);
  });

  test("a link with neither destination nor handler is not clickable", async () => {
    const { CanvasRenderer } = await import("../packages/web/src/canvas/renderer");
    const r = new CanvasRenderer(makeStubCanvas(), { dispatchAction() {} } as any);
    r.applyPatches([
      { type: "create", id: "l", elementType: "Link", props: {} } as any,
    ]);
    expect((r as any).nodes.get("l").clickable).toBe(false);
  });
});

/** Minimal canvas stub: enough surface for the renderer to construct. */
function makeStubCanvas(): any {
  const listeners: Record<string, Function[]> = {};
  const ctx = new Proxy({}, { get: (_t, p) =>
    p === "measureText" ? (t: string) => ({ width: String(t).length * 8 }) : () => undefined });
  return {
    width: 400, height: 400, style: {}, dataset: {},
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 400 }),
    addEventListener: (t: string, cb: Function) => { (listeners[t] ??= []).push(cb); },
    removeEventListener: () => {},
    dispatchEvent: (e: any) => { (listeners[e.type] ?? []).forEach((cb) => cb(e)); return true; },
    ownerDocument: { defaultView: { devicePixelRatio: 1 } },
  };
}

/**
 * Slider gestures at the event-manager level: `change` fires exactly once per
 * drag, on whichever release path ends it, and never for a node removed
 * mid-drag.
 */
describe("slider gestures through CanvasEventManager", () => {
  class MockCanvas {
    width = 800; height = 600;
    style: any = { cursor: "default" };
    private listeners = new Map<string, Function[]>();
    getBoundingClientRect() { return { width: 800, height: 600, left: 0, top: 0, right: 800, bottom: 600, x: 0, y: 0 }; }
    addEventListener(t: string, h: Function) { (this.listeners.get(t) ?? this.listeners.set(t, []).get(t)!).push(h); }
    removeEventListener(t: string, h: Function) { const a = this.listeners.get(t); if (a) { const i = a.indexOf(h); if (i >= 0) a.splice(i, 1); } }
    dispatchEvent(e: any) { (this.listeners.get(e.type) ?? []).forEach((h) => h(e)); return true; }
  }

  /** A laid-out box with the border block hit-testing reads. */
  const box = (x: number, y: number, width: number, height: number) => ({
    x, y, width, height,
    border: { radius: 0, width: 0 },
    padding: { top: 0, right: 0, bottom: 0, left: 0 },
    margin: { top: 0, right: 0, bottom: 0, left: 0 },
  });

  // Once, up front: the helper force-rebuilds `window`, so a per-mount call
  // would discard listener stubs a test installs on it.
  ensureFakeDomGlobals();

  const mount = async () => {
    const { CanvasEventManager } = await import("../packages/web/src/canvas/events");
    const canvas = new MockCanvas();
    const engine = new MockEngine();
    const events = new CanvasEventManager(canvas as any, engine as any);
    const slider = {
      ...node("slider", { min: 0, max: 100, value: 0, onInput: "@actions.preview", onChange: "@actions.set" }),
      id: "s",
      layout: box(100, 100, 216, 20),
    } as unknown as VirtualNode;
    const root = { ...node("column"), id: "root", layout: box(0, 0, 800, 600), children: [slider] } as unknown as VirtualNode;
    slider.parent = root;
    events.setRootNode(root);
    const names = () => engine.dispatched.map((d) => d.name);
    return { canvas, engine, events, slider, names };
  };

  test("press, move, release on the canvas: previews per move, one change on release", async () => {
    const { canvas, events, names } = await mount();
    canvas.dispatchEvent({ type: "mousedown", clientX: 120, clientY: 110, button: 0, buttons: 1 });
    canvas.dispatchEvent({ type: "mousemove", clientX: 160, clientY: 110, buttons: 1 });
    canvas.dispatchEvent({ type: "mousemove", clientX: 200, clientY: 110, buttons: 1 });
    expect(names().filter((n) => n === "set")).toHaveLength(0);
    canvas.dispatchEvent({ type: "mouseup", clientX: 200, clientY: 110, button: 0 });
    canvas.dispatchEvent({ type: "click", clientX: 200, clientY: 110, button: 0 });
    expect(names().filter((n) => n === "preview").length).toBeGreaterThanOrEqual(2);
    expect(names().filter((n) => n === "set")).toHaveLength(1);
    events.destroy();
  });

  test("a release seen only at the window level still commits once", async () => {
    // The shared fake window's addEventListener is a no-op; record the
    // release listeners the manager arms so the test can fire them.
    const w = (globalThis as any).window;
    const saved = { add: w.addEventListener, remove: w.removeEventListener };
    const armed = new Map<string, Function[]>();
    w.addEventListener = (t: string, h: Function) => { (armed.get(t) ?? armed.set(t, []).get(t)!).push(h); };
    w.removeEventListener = (t: string, h: Function) => { const a = armed.get(t); if (a) { const i = a.indexOf(h); if (i >= 0) a.splice(i, 1); } };
    try {
      const { canvas, events, names } = await mount();
      canvas.dispatchEvent({ type: "mousedown", clientX: 120, clientY: 110, button: 0, buttons: 1 });
      canvas.dispatchEvent({ type: "mousemove", clientX: 200, clientY: 110, buttons: 1 });
      expect(armed.get("mouseup")?.length).toBe(1);
      for (const h of [...(armed.get("mouseup") ?? [])]) h({ type: "mouseup", clientX: 900, clientY: 110, button: 0 });
      expect(names().filter((n) => n === "set")).toHaveLength(1);
      // Listeners are disarmed once the drag ends.
      expect(armed.get("mouseup")?.length ?? 0).toBe(0);
      // A later click on the canvas does not commit again.
      canvas.dispatchEvent({ type: "click", clientX: 200, clientY: 110, button: 0 });
      expect(names().filter((n) => n === "set")).toHaveLength(1);
      events.destroy();
    } finally {
      w.addEventListener = saved.add;
      w.removeEventListener = saved.remove;
    }
  });

  test("a buttonless move ends the drag with one change", async () => {
    const { canvas, events, names } = await mount();
    canvas.dispatchEvent({ type: "mousedown", clientX: 120, clientY: 110, button: 0, buttons: 1 });
    canvas.dispatchEvent({ type: "mousemove", clientX: 200, clientY: 110, buttons: 0 });
    expect(names().filter((n) => n === "set")).toHaveLength(1);
    events.destroy();
  });

  test("a slider removed mid-drag stops receiving writes and never commits", async () => {
    const { canvas, events, slider, names } = await mount();
    canvas.dispatchEvent({ type: "mousedown", clientX: 120, clientY: 110, button: 0, buttons: 1 });
    const before = slider.props.value;
    events.clearIfWithin(slider);
    canvas.dispatchEvent({ type: "mousemove", clientX: 300, clientY: 110, buttons: 1 });
    expect(slider.props.value).toBe(before);
    canvas.dispatchEvent({ type: "mouseup", clientX: 300, clientY: 110, button: 0 });
    canvas.dispatchEvent({ type: "click", clientX: 300, clientY: 110, button: 0 });
    expect(names().filter((n) => n === "set")).toHaveLength(0);
    events.destroy();
  });
});
