/**
 * `.onFileDragEnter(@actions.x)` on the DOM renderer: a UI-only signal that
 * OS files are being dragged over a `.dropZone(files: true)` (inert on any
 * other element). It never carries file names or
 * contents (an app answers it through the device plane's `file.pick`, whose
 * host dialog owns the actual drop), fires once per entry, and swallows a
 * stray drop so the browser never navigates to the file.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { eventHandlers, FILE_DRAG_GATE_META } from "../packages/web/src/dom/applicators/events";
import { setEngine, setMeta } from "../packages/web/src/dom/element-data";

let dom: JSDOM;
let doc: Document;

beforeEach(() => {
  dom = new JSDOM("<!doctype html><html><body></body></html>");
  doc = dom.window.document;
});
afterEach(() => dom.window.close());

function drag(type: string, types: string[] = ["Files"], items = 2): Event {
  const ev = new dom.window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "dataTransfer", {
    value: { types, items: { length: items }, files: [], dropEffect: "copy" },
  });
  return ev;
}

function setup({ filesZone = true } = {}) {
  const dispatched: Array<{ name: string; payload: any }> = [];
  const host = doc.createElement("div");
  const zone = doc.createElement("div");
  const child = doc.createElement("span");
  zone.append(child);
  host.append(zone);
  doc.body.append(host);
  setEngine(host, { dispatchAction: (name: string, payload?: any) => dispatched.push({ name, payload }) } as never);
  // The DnD runtime installs this gate on a `.dropZone(files: true)` node.
  if (filesZone) setMeta(zone, FILE_DRAG_GATE_META, () => true);
  eventHandlers.onFileDragEnter!(zone, "@actions.filesIncoming");
  return { dispatched, zone, child };
}

describe("onFileDragEnter", () => {
  test("fires once per entry with an item count and no file data", () => {
    const { dispatched, zone, child } = setup();
    zone.dispatchEvent(drag("dragenter"));
    // Crossing into a child fires enter(child) before leave(zone): no re-fire.
    child.dispatchEvent(drag("dragenter"));
    zone.dispatchEvent(drag("dragleave"));
    expect(dispatched.length).toBe(1);
    expect(dispatched[0]!.name).toBe("filesIncoming");
    expect(dispatched[0]!.payload).toMatchObject({ type: "filedragenter", items: 2 });
    expect(Object.keys(dispatched[0]!.payload).sort()).toEqual(["items", "timestamp", "type"]);
    // Leaving fully, then entering again, is a new entry.
    child.dispatchEvent(drag("dragleave"));
    zone.dispatchEvent(drag("dragenter"));
    expect(dispatched.length).toBe(2);
  });

  test("is inert on an element that is not a files zone", () => {
    const { dispatched, zone } = setup({ filesZone: false });
    const enter = drag("dragenter");
    zone.dispatchEvent(enter);
    const drop = drag("drop");
    zone.dispatchEvent(drop);
    expect(dispatched.length).toBe(0);
    expect(enter.defaultPrevented).toBe(false);
    expect(drop.defaultPrevented).toBe(false);
  });

  test("ignores drags that carry no files (text, in-page elements)", () => {
    const { dispatched, zone } = setup();
    zone.dispatchEvent(drag("dragenter", ["text/plain"]));
    expect(dispatched.length).toBe(0);
  });

  test("a stray file drop on the element is swallowed and resets the entry", () => {
    const { dispatched, zone } = setup();
    zone.dispatchEvent(drag("dragenter"));
    const over = drag("dragover");
    zone.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    expect((over as any).dataTransfer.dropEffect).toBe("none");
    const drop = drag("drop");
    zone.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    zone.dispatchEvent(drag("dragenter"));
    expect(dispatched.length).toBe(2);
  });
});
