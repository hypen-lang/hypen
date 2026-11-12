/**
 * The browser client bundle `defineHypenWorker({ serveClient })` serves.
 *
 * `@hypen-space/cf@0.6.7` shipped a client built before the DOM renderer
 * learned `clearChildren` (engine: one patch for "a list pass removed every
 * child"): the published client ignored it, old rows stayed on screen and
 * tapping them failed with "stale UI action target". The bundle is a
 * build-time snapshot of `@hypen-space/web`, so these tests build it from
 * the workspace sources exactly as `build:client` does, and run it in a DOM
 * against a fake socket.
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { JSDOM } from "jsdom";
import { join } from "node:path";
import { buildClient, resolveWorkspaceSource } from "../client/build-client.js";

const PACKAGES = join(import.meta.dir, "..", "..");
let bundle = "";

beforeAll(async () => {
  // HYPEN_CF_CLIENT_BUNDLE=<path> checks a given bundle instead — e.g. the
  // dist/client/generic.js of a packed or published tarball before release.
  const given = process.env.HYPEN_CF_CLIENT_BUNDLE;
  bundle = given ? await Bun.file(given).text() : await buildClient();
}, 60_000);

/** Run the bundle in a DOM whose `WebSocket` is a recording fake. */
function boot() {
  const dom = new JSDOM(
    `<!doctype html><html><body data-hypen-renderer="dom"><div id="app"></div></body></html>`,
    { url: "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true },
  );
  const win = dom.window as unknown as Record<string, any>;
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = 0;
    bufferedAmount = 0;
    extensions = "";
    sent: string[] = [];
    onopen: ((e: unknown) => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onclose: ((e: unknown) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    constructor(public url: string) {
      sockets.push(this);
    }
    send(data: string) { this.sent.push(data); }
    close() { this.readyState = 3; }
    private listeners = new Map<string, Set<(e: any) => void>>();
    addEventListener(type: string, fn: (e: any) => void) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type)!.add(fn);
    }
    removeEventListener(type: string, fn: (e: any) => void) {
      this.listeners.get(type)?.delete(fn);
    }
    private emit(type: string, event: any) {
      (this as any)[`on${type}`]?.(event);
      for (const fn of this.listeners.get(type) ?? []) fn(event);
    }
    open() {
      this.readyState = 1;
      this.emit("open", {});
    }
    deliver(message: unknown) {
      this.emit("message", { data: JSON.stringify(message) });
    }
  }
  win.WebSocket = FakeSocket;
  // The page loads the bundle as `<script type="module">`; jsdom evaluates
  // classic scripts only, so stand in for the one module-only construct
  // (lazy WASM URL resolution in the canvas layout glue, unused here).
  win.eval(bundle.replaceAll("import.meta.url", JSON.stringify("http://localhost/client.js")));
  return { dom, sockets };
}

const flush = () => new Promise((r) => setTimeout(r, 30));

describe("generic client bundle", () => {
  test("resolves @hypen-space/* to workspace SOURCES with browser semantics, never dist/", () => {
    expect(resolveWorkspaceSource("@hypen-space/web/dom")).toBe(join(PACKAGES, "web/src/dom/index.ts"));
    expect(resolveWorkspaceSource("@hypen-space/web/canvas")).toBe(join(PACKAGES, "web/src/canvas/index.ts"));
    // core's root resolves to its BROWSER entry, as the `browser` condition would.
    expect(resolveWorkspaceSource("@hypen-space/core")).toBe(join(PACKAGES, "core/src/index.browser.ts"));
    expect(resolveWorkspaceSource("@hypen-space/core/remote/client")).toBe(
      join(PACKAGES, "core/src/remote/client.ts"),
    );
    expect(resolveWorkspaceSource("@hypen-space/device-web")).toBe(join(PACKAGES, "device-web/src/index.ts"));
    expect(resolveWorkspaceSource("@hypen-space/server")).toBeNull();
  });

  test("is built from the workspace renderer (carries clearChildren)", () => {
    expect(bundle.includes("clearChildren")).toBe(true);
  });

  test("applies clearChildren: the old rows leave the DOM", async () => {
    const { dom, sockets } = boot();
    const ws = sockets[0]!;
    expect(ws.url).toContain("/ws");
    ws.open();
    await flush();
    ws.deliver({ type: "sessionAck", sessionId: "s1", isNew: true, isRestored: false });
    ws.deliver({
      type: "initialTree",
      module: "App",
      state: {},
      revision: 0,
      patches: [
        { type: "create", id: "list", elementType: "Column", props: {} },
        { type: "insert", parentId: "root", id: "list" },
        { type: "create", id: "r1", elementType: "Text", props: { "0": "row one" } },
        { type: "insert", parentId: "list", id: "r1" },
        { type: "create", id: "r2", elementType: "Text", props: { "0": "row two" } },
        { type: "insert", parentId: "list", id: "r2" },
      ],
    });
    await flush();
    const app = dom.window.document.getElementById("app")!;
    expect(app.textContent).toContain("row one");
    expect(app.textContent).toContain("row two");

    // The list is replaced: one clearChildren, then the new row.
    ws.deliver({
      type: "patch",
      revision: 1,
      patches: [
        { type: "clearChildren", id: "list" },
        { type: "create", id: "r3", elementType: "Text", props: { "0": "row three" } },
        { type: "insert", parentId: "list", id: "r3" },
      ],
    });
    await flush();
    expect(app.textContent).not.toContain("row one");
    expect(app.textContent).not.toContain("row two");
    expect(app.textContent).toContain("row three");
    dom.window.close();
  });
});
