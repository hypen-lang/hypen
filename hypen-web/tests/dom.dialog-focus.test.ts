/**
 * Dialog focus completion (operability.ts + DOMRenderer wiring) and the
 * route-focus opt-out.
 *
 * The dialog contract under test:
 * - mount (insert/attach into the document) focuses the dialog's first
 *   focusable descendant, else the dialog itself, and remembers the trigger;
 * - remove/detach restores focus to the remembered trigger when it is still
 *   connected (and never when it died with the dialog);
 * - Escape dispatches the dialog's `onClose` action when one is declared,
 *   and does nothing otherwise (closing is app state);
 * - all installers are idempotent via dataset guards.
 *
 * Route focus (§5): `DOMRendererOptions.routeFocus: "off"` skips the
 * navigation focus contract entirely.
 */

import { describe, expect, test } from "bun:test";
import { DOMRenderer } from "../packages/web/src/dom/renderer";
import {
  findFirstFocusable,
  restoreDialogFocus,
  installDialogEscape,
} from "../packages/web/src/dom/operability";
import type { Patch } from "../packages/core/src/types";
import type { IEngine as Engine } from "../packages/core/src/app";
import { ensureFakeDomGlobals, FakeElement } from "./fake-dom";

ensureFakeDomGlobals();

class RecordingEngine {
  actions: Array<{ name: string; payload?: any }> = [];
  dispatchAction(name: string, payload?: any): void {
    this.actions.push({ name, payload });
  }
}

const makeRenderer = (options?: { routeFocus?: "auto" | "off" }) => {
  const container = document.createElement("div");
  const engine = new RecordingEngine();
  const renderer = new DOMRenderer(container, engine as unknown as Engine, undefined, options);
  return { container, renderer, engine };
};

const attrs = (node: unknown): Record<string, string> =>
  (node as { attributes?: Record<string, string> }).attributes ?? {};

const active = (): unknown => (document as any).activeElement;

/** A page shell: root Column with a trigger Button the user has focused. */
const buildPage = (renderer: DOMRenderer): void => {
  renderer.applyPatches([
    { type: "create", id: "page", elementType: "Column", props: {} } as Patch,
    { type: "insert", parentId: "root", id: "page" } as Patch,
    { type: "create", id: "trigger", elementType: "Button", props: { "0": "Open" } } as Patch,
    { type: "insert", parentId: "page", id: "trigger" } as Patch,
  ]);
  (renderer.getNode("trigger") as any).focus();
};

/** Open a dialog under `page`: role=dialog Column with the given children. */
const openDialog = (
  renderer: DOMRenderer,
  children: Array<{ id: string; type: string; props?: any }>,
  dialogProps: Record<string, any> = {},
): void => {
  const patches: Patch[] = [
    {
      type: "create",
      id: "dlg",
      elementType: "Column",
      props: dialogProps,
      semantics: { role: "dialog" },
    } as Patch,
    { type: "insert", parentId: "page", id: "dlg" } as Patch,
  ];
  for (const c of children) {
    patches.push({ type: "create", id: c.id, elementType: c.type, props: c.props ?? {} } as Patch);
    patches.push({ type: "insert", parentId: "dlg", id: c.id } as Patch);
  }
  renderer.applyPatches(patches);
};

describe("findFirstFocusable", () => {
  test("finds the first focusable descendant in document order, depth-first", () => {
    const root = new FakeElement("DIV");
    const section = new FakeElement("SECTION");
    const input = new FakeElement("INPUT");
    const button = new FakeElement("BUTTON");
    section.appendChild(input);
    root.appendChild(section);
    root.appendChild(button);
    expect(findFirstFocusable(root as unknown as HTMLElement)).toBe(input as any);
  });

  test("an explicit tabindex counts as focusable", () => {
    const root = new FakeElement("DIV");
    const div = new FakeElement("DIV");
    div.setAttribute("tabindex", "0");
    root.appendChild(div);
    expect(findFirstFocusable(root as unknown as HTMLElement)).toBe(div as any);
  });

  test("returns null when nothing is focusable", () => {
    const root = new FakeElement("DIV");
    root.appendChild(new FakeElement("SPAN"));
    expect(findFirstFocusable(root as unknown as HTMLElement)).toBe(null);
  });
});

describe("restoreDialogFocus", () => {
  test("restores a connected opener", () => {
    (document as any).activeElement = null;
    const dialog = new FakeElement("DIV");
    const opener = new FakeElement("BUTTON");
    restoreDialogFocus(dialog as unknown as HTMLElement, opener as unknown as HTMLElement);
    expect(active()).toBe(opener);
  });

  test("skips an opener that lives inside the dialog itself", () => {
    (document as any).activeElement = null;
    const dialog = new FakeElement("DIV");
    const inner = new FakeElement("BUTTON");
    dialog.appendChild(inner);
    restoreDialogFocus(dialog as unknown as HTMLElement, inner as unknown as HTMLElement);
    expect(active()).toBe(null);
  });

  test("skips a disconnected opener", () => {
    (document as any).activeElement = null;
    const dialog = new FakeElement("DIV");
    const opener = new FakeElement("BUTTON");
    (opener as any).isConnected = false;
    restoreDialogFocus(dialog as unknown as HTMLElement, opener as unknown as HTMLElement);
    expect(active()).toBe(null);
  });
});

describe("DOMRenderer dialog mount focus", () => {
  test("opening a dialog focuses its first focusable descendant", () => {
    const { renderer } = makeRenderer();
    buildPage(renderer);
    openDialog(renderer, [
      { id: "msg", type: "Text", props: { "0": "Sure?" } },
      { id: "ok", type: "Button", props: { "0": "OK" } },
    ]);
    expect(active()).toBe(renderer.getNode("ok"));
  });

  test("a dialog with no focusable descendant focuses the dialog itself, programmatically", () => {
    const { renderer } = makeRenderer();
    buildPage(renderer);
    openDialog(renderer, [{ id: "msg", type: "Text", props: { "0": "Notice" } }]);
    const dialog = renderer.getNode("dlg") as any;
    expect(active()).toBe(dialog);
    // Landing point, not a new tab stop.
    expect(attrs(dialog).tabindex).toBe("-1");
  });

  test("a move of an open dialog does not re-run mount focus", () => {
    const { renderer } = makeRenderer();
    buildPage(renderer);
    openDialog(renderer, [{ id: "ok", type: "Button", props: { "0": "OK" } }]);
    // The user tabbed back to the trigger somehow; a reorder must not yank focus.
    (renderer.getNode("trigger") as any).focus();
    renderer.applyPatches([{ type: "move", parentId: "page", id: "dlg" } as Patch]);
    expect(active()).toBe(renderer.getNode("trigger"));
  });
});

describe("DOMRenderer dialog close restores the trigger", () => {
  test("removing the dialog restores focus to the remembered trigger", () => {
    const { renderer } = makeRenderer();
    buildPage(renderer);
    openDialog(renderer, [{ id: "ok", type: "Button", props: { "0": "OK" } }]);
    expect(active()).toBe(renderer.getNode("ok"));

    renderer.applyPatches([
      { type: "remove", id: "ok" } as Patch,
      { type: "remove", id: "dlg" } as Patch,
    ]);
    expect(active()).toBe(renderer.getNode("trigger"));
  });

  test("a disconnected trigger is not restored", () => {
    const { renderer } = makeRenderer();
    buildPage(renderer);
    openDialog(renderer, [{ id: "ok", type: "Button", props: { "0": "OK" } }]);
    const okButton = renderer.getNode("ok");

    (renderer.getNode("trigger") as any).isConnected = false;
    renderer.applyPatches([{ type: "remove", id: "dlg" } as Patch]);
    expect(active()).toBe(okButton);
  });

  test("detach restores the trigger; re-attach re-runs mount focus", () => {
    const { renderer } = makeRenderer();
    buildPage(renderer);
    openDialog(renderer, [{ id: "ok", type: "Button", props: { "0": "OK" } }]);
    expect(active()).toBe(renderer.getNode("ok"));

    renderer.applyPatches([{ type: "detach", id: "dlg" } as Patch]);
    expect(active()).toBe(renderer.getNode("trigger"));

    renderer.applyPatches([{ type: "attach", parentId: "page", id: "dlg" } as Patch]);
    expect(active()).toBe(renderer.getNode("ok"));
  });

  test("removing an ancestor of an open dialog also restores", () => {
    const { renderer } = makeRenderer();
    buildPage(renderer);
    // Trigger lives outside the removed subtree.
    renderer.applyPatches([
      { type: "create", id: "wrap", elementType: "Column", props: {} } as Patch,
      { type: "insert", parentId: "page", id: "wrap" } as Patch,
      {
        type: "create",
        id: "dlg",
        elementType: "Column",
        props: {},
        semantics: { role: "dialog" },
      } as Patch,
      { type: "insert", parentId: "wrap", id: "dlg" } as Patch,
      { type: "create", id: "ok", elementType: "Button", props: { "0": "OK" } } as Patch,
      { type: "insert", parentId: "dlg", id: "ok" } as Patch,
    ]);
    expect(active()).toBe(renderer.getNode("ok"));

    renderer.applyPatches([{ type: "remove", id: "wrap" } as Patch]);
    expect(active()).toBe(renderer.getNode("trigger"));
  });
});

describe("DOMRenderer dialog Escape", () => {
  test("Escape dispatches the dialog's onClose action", () => {
    const { renderer, engine } = makeRenderer();
    buildPage(renderer);
    engine.actions.length = 0;
    openDialog(renderer, [{ id: "ok", type: "Button", props: { "0": "OK" } }], {
      onClose: "@actions.dismiss",
    });

    const dialog = renderer.getNode("dlg") as any;
    expect(dialog.dataset.hypenDialogEsc).toBe("1");
    dialog.dispatchEvent("keydown", { key: "Escape", preventDefault() {} });
    expect(engine.actions).toEqual([{ name: "dismiss", payload: {} }]);
  });

  test("the flattened onClose.0 prop form also wires Escape", () => {
    const { renderer, engine } = makeRenderer();
    buildPage(renderer);
    engine.actions.length = 0;
    openDialog(renderer, [], { "onClose.0": "@actions.close" });

    const dialog = renderer.getNode("dlg") as any;
    dialog.dispatchEvent("keydown", { key: "Escape", preventDefault() {} });
    expect(engine.actions).toEqual([{ name: "close", payload: {} }]);
  });

  test("without onClose, Escape does nothing (closing is app state)", () => {
    const { renderer, engine } = makeRenderer();
    buildPage(renderer);
    engine.actions.length = 0;
    openDialog(renderer, [{ id: "ok", type: "Button", props: { "0": "OK" } }]);

    const dialog = renderer.getNode("dlg") as any;
    expect(dialog.dataset.hypenDialogEsc).toBeUndefined();
    dialog.dispatchEvent("keydown", { key: "Escape", preventDefault() {} });
    expect(engine.actions).toEqual([]);
  });

  test("installDialogEscape is idempotent (dataset guard)", () => {
    const el = new FakeElement("DIV");
    installDialogEscape(el as unknown as HTMLElement, "@actions.close");
    expect(el.dataset.hypenDialogEsc).toBe("1");
    installDialogEscape(el as unknown as HTMLElement, "@actions.close");
    expect(el.dataset.hypenDialogEsc).toBe("1");
  });

  test("an unrelated key does not dispatch", () => {
    const { renderer, engine } = makeRenderer();
    buildPage(renderer);
    engine.actions.length = 0;
    openDialog(renderer, [], { onClose: "@actions.dismiss" });

    const dialog = renderer.getNode("dlg") as any;
    dialog.dispatchEvent("keydown", { key: "Enter", preventDefault() {} });
    expect(engine.actions).toEqual([]);
  });
});

describe("route-focus opt-out (routeFocus: \"off\")", () => {
  const buildRoute = (
    rootId: string,
    children: Array<{ id: string; type: string; props?: any }>,
  ): Patch[] => {
    const patches: Patch[] = [
      { type: "create", id: rootId, elementType: "Column", props: {} } as Patch,
      { type: "insert", parentId: "root", id: rootId } as Patch,
    ];
    for (const c of children) {
      patches.push({ type: "create", id: c.id, elementType: c.type, props: c.props ?? {} } as Patch);
      patches.push({ type: "insert", parentId: rootId, id: c.id } as Patch);
    }
    return patches;
  };

  test("navigation does not move focus when routeFocus is off", () => {
    (document as any).activeElement = null;
    const { renderer } = makeRenderer({ routeFocus: "off" });
    renderer.applyPatches(buildRoute("home", [{ id: "hh", type: "Heading", props: { "0": "Home" } }]));

    renderer.applyPatches([
      { type: "detach", id: "home" } as Patch,
      ...buildRoute("profile", [{ id: "ph", type: "Heading", props: { "0": "Profile" } }]),
    ]);
    expect(active()).toBe(null);
    // No programmatic-focus tabindex was granted either.
    expect(attrs(renderer.getNode("ph")).tabindex).toBeUndefined();
  });

  test("dialog mount focus still applies with routeFocus off", () => {
    const { renderer } = makeRenderer({ routeFocus: "off" });
    buildPage(renderer);
    openDialog(renderer, [{ id: "ok", type: "Button", props: { "0": "OK" } }]);
    expect(active()).toBe(renderer.getNode("ok"));
  });
});
