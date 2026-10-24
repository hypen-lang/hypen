/**
 * Remote clients (cf generic client, `HypenApp` embeds) replace the mounted
 * tree only when the server sends a fresh `initialTree` (a reconnect), never
 * on an ordinary patch batch that happens to create+insert under `root`.
 *
 * Regression: with a top-level Router, every first visit to a route is a
 * batch that detaches the old route and creates+inserts the new route's
 * root under `root`. The clients used to treat that as "replacement root"
 * and `clear()` the renderer, destroying the Router's cached (detached)
 * route subtrees — so Home -> Search -> Home rendered an empty page because
 * the engine's `attach` for Home found no node.
 */

import { describe, expect, test } from "bun:test";
import { RemoteEngine } from "../packages/core/src/remote/client";
import { DOMRenderer } from "../packages/web/src/dom/renderer";
import type { Patch } from "../packages/core/src/types";
import type { IEngine as Engine } from "../packages/core/src/app";
import { ensureFakeDomGlobals } from "./fake-dom";

ensureFakeDomGlobals();

const route = (id: string): Patch[] => [
  { type: "create", id, elementType: "Column", props: {} } as Patch,
  { type: "insert", parentId: "root", id } as Patch,
];

/** Feed a server message to the client without a socket. */
const deliver = (engine: RemoteEngine, message: unknown): void => {
  (engine as unknown as { handleMessage(data: string, ws: null): void }).handleMessage(
    JSON.stringify(message),
    null,
  );
};

/** The wiring both remote clients use. */
const mount = () => {
  const engine = new RemoteEngine("ws://localhost:1", { autoReconnect: false });
  const container = document.createElement("div");
  const renderer = new DOMRenderer(container, engine as unknown as Engine);
  const events: string[] = [];
  let hasRenderedTree = false;
  engine.onInitialTree(() => {
    events.push("initialTree");
    if (hasRenderedTree) renderer.clear();
    hasRenderedTree = true;
  });
  engine.onPatches((patches) => {
    events.push(`patches:${patches.length}`);
    renderer.applyPatches(patches);
  });
  return { engine, renderer, events };
};

describe("RemoteEngine.onInitialTree", () => {
  test("fires once per initialTree, before that tree's patches, and not for patch batches", () => {
    const { engine, events } = mount();
    deliver(engine, { type: "initialTree", module: "App", state: {}, revision: 1, patches: route("home") });
    deliver(engine, { type: "patch", module: "App", revision: 2, patches: route("search") });
    expect(events).toEqual(["initialTree", "patches:2", "patches:2"]);
    engine.dispose();
  });

  test("a top-level Router's cached route survives a first visit to another route", () => {
    const { engine, renderer } = mount();
    deliver(engine, { type: "initialTree", module: "App", state: {}, revision: 1, patches: route("home") });
    // Home -> Search: detach Home (kept in the Router cache), build Search.
    deliver(engine, {
      type: "patch",
      module: "App",
      revision: 2,
      patches: [{ type: "detach", id: "home" }, ...route("search")],
    });
    // Search -> Home: detach Search, re-attach the cached Home subtree.
    deliver(engine, {
      type: "patch",
      module: "App",
      revision: 3,
      patches: [
        { type: "detach", id: "search" },
        { type: "attach", parentId: "root", id: "home" },
      ],
    });
    expect(renderer.getNode("home")).toBeDefined();
    expect(renderer.getNode("search")).toBeDefined();
    engine.dispose();
  });

  test("a reconnect's initialTree replaces the previously mounted tree", () => {
    const { engine, renderer } = mount();
    deliver(engine, { type: "initialTree", module: "App", state: {}, revision: 1, patches: route("old") });
    deliver(engine, { type: "initialTree", module: "App", state: {}, revision: 1, patches: route("fresh") });
    expect(renderer.getNode("old")).toBeUndefined();
    expect(renderer.getNode("fresh")).toBeDefined();
    engine.dispose();
  });
});
