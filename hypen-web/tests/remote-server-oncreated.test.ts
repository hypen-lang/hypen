import { describe, expect, test, afterEach } from "bun:test";
import { RemoteServer } from "../packages/server/src/remote/server";
import { app } from "../packages/core/src/app";
import type { Patch } from "../packages/core/src/types";

/**
 * Tests for the RemoteServer's handling of onCreated state mutations.
 *
 * The state proxy uses queueMicrotask to coalesce changes. When onCreated
 * mutates state, the engine re-renders in a microtask. If the server sends
 * the initialTree before the microtask fires, the client misses the elements
 * created by onCreated. Then when the user navigates, the engine's diff
 * references elements the client never received — causing broken rendering.
 */

// A module whose onCreated sets state that changes the UI
const UI_WITH_LIST = `module App {
  Column {
    Text("Header")
    ForEach(items: @state.items, key: "id") {
      Text("@{item.name}")
    }
  }
}`;

function createModuleWithOnCreated() {
  return app
    .defineState<{ items: Array<{ id: string; name: string }>; view: string }>({
      items: [],
      view: "home",
    })
    .onCreated(async (state) => {
      // This mutates state synchronously inside an async handler.
      // The state proxy defers the notification via queueMicrotask,
      // which means the re-render happens AFTER renderSource returns.
      state.items = [
        { id: "1", name: "Alpha" },
        { id: "2", name: "Beta" },
        { id: "3", name: "Charlie" },
      ];
    })
    .onAction("switchView", ({ state }) => {
      state.view = state.view === "home" ? "other" : "home";
      // Simulate a view change that clears and recreates content
      state.items = [
        { id: "4", name: "Delta" },
        { id: "5", name: "Echo" },
      ];
    })
    .build();
}

type Client = {
  messages: any[];
  send: (msg: any) => void;
  close: () => void;
  waitForMessage: (
    predicate: (msg: any) => boolean,
    timeoutMs?: number
  ) => Promise<any>;
};

function connectClient(port: number): Promise<Client> {
  return new Promise((resolve, reject) => {
    const messages: any[] = [];
    const waiters: Array<{
      predicate: (msg: any) => boolean;
      resolve: (msg: any) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }> = [];
    let closed = false;

    const ws = new WebSocket(`ws://localhost:${port}`);

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "hello" }));
      resolve({
        messages,
        send: (msg: any) => ws.send(JSON.stringify(msg)),
        close: () => ws.close(),
        waitForMessage: (predicate, timeoutMs = 5000) =>
          new Promise((res, rej) => {
            const existing = messages.find(predicate);
            if (existing) return res(existing);
            if (closed)
              return rej(
                new Error("WebSocket closed before message arrived")
              );
            const timer = setTimeout(
              () => rej(new Error("Timed out waiting for message")),
              timeoutMs
            );
            waiters.push({
              predicate,
              resolve: (msg) => {
                clearTimeout(timer);
                res(msg);
              },
              reject: rej,
              timer,
            });
          }),
      });
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data as string);
      messages.push(msg);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].predicate(msg)) {
          waiters[i].resolve(msg);
          waiters.splice(i, 1);
        }
      }
    };

    ws.onclose = () => {
      closed = true;
      for (const w of waiters) {
        clearTimeout(w.timer);
        w.reject(new Error("WebSocket closed before message arrived"));
      }
      waiters.length = 0;
    };

    ws.onerror = (err) => reject(err);
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Collect all element IDs created in a patch list
 */
function getCreatedIds(patches: Patch[]): Set<string> {
  return new Set(
    patches
      .filter((p: any) => p.type === "create" && p.id)
      .map((p: any) => p.id as string)
  );
}

/**
 * Collect all parent IDs referenced by insert patches
 */
function getInsertParentIds(patches: Patch[]): Set<string> {
  return new Set(
    patches
      .filter((p: any) => p.type === "insert" && p.parentId)
      .map((p: any) => p.parentId as string)
  );
}

describe("RemoteServer onCreated state mutations", () => {
  let server: RemoteServer | null = null;
  let clients: Client[] = [];
  const PORT = 19899;

  afterEach(async () => {
    for (const c of clients) c.close();
    clients = [];
    await wait(50);
    server?.stop();
    server = null;
    await wait(50);
  });

  test("initialTree includes elements from onCreated state mutations", async () => {
    server = new RemoteServer()
      .module("App", createModuleWithOnCreated())
      .ui(UI_WITH_LIST);

    await server.listen(PORT);

    const client = await connectClient(PORT);
    clients.push(client);
    const initMsg = await client.waitForMessage(
      (m) => m.type === "initialTree"
    );

    // The initial tree should include the items set by onCreated.
    // If the microtask flush is missing, the initialTree only has the
    // structure (Column, Text "Header") but NOT the ForEach items.
    expect(initMsg.patches.length).toBeGreaterThan(0);

    // Check that the state includes the items from onCreated
    expect(initMsg.state.items).toBeDefined();
    expect(initMsg.state.items.length).toBe(3);
    expect(initMsg.state.items[0].name).toBe("Alpha");

    // The patches should include Text elements for "Alpha", "Beta", "Charlie"
    // These come from the ForEach expansion triggered by onCreated state mutation
    const textPatches = initMsg.patches.filter(
      (p: any) =>
        p.type === "create" && p.elementType === "Text"
    );

    // Should have at least 4 Text elements: "Header" + "Alpha" + "Beta" + "Charlie"
    expect(textPatches.length).toBeGreaterThanOrEqual(4);
  });

  test("navigation after onCreated does not reference missing elements", async () => {
    server = new RemoteServer()
      .module("App", createModuleWithOnCreated())
      .ui(UI_WITH_LIST);

    await server.listen(PORT);

    const client = await connectClient(PORT);
    clients.push(client);
    const initMsg = await client.waitForMessage(
      (m) => m.type === "initialTree"
    );

    // Collect all element IDs the client knows about from the initial tree
    const knownIds = getCreatedIds(initMsg.patches);

    // Now dispatch an action that changes the view (simulates navigation)
    client.send({
      type: "dispatchAction",
      module: "App",
      action: "switchView",
    });

    // Wait for all patch messages
    await wait(200);

    // Collect ALL patch messages after initial tree
    const patchMessages = client.messages.filter((m) => m.type === "patch");

    // Process all patches to build the full set of known IDs
    for (const patchMsg of patchMessages) {
      for (const p of patchMsg.patches) {
        if (p.type === "create" && p.id) {
          knownIds.add(p.id);
        }
        if (p.type === "remove" && p.id) {
          knownIds.delete(p.id);
        }
      }
    }

    // The critical check: every Insert patch must reference a parent that either:
    // 1. Was in the initial tree
    // 2. Was created EARLIER in the same batch (Create comes before Insert)
    // If onCreated elements were missing, inserts will reference unknown parents.
    for (const patchMsg of patchMessages) {
      // Build set of IDs created so far in this batch (Create before Insert order)
      const batchCreatedIds = new Set<string>();
      for (const p of patchMsg.patches as any[]) {
        if (p.type === "create" && p.id) {
          batchCreatedIds.add(p.id);
        }
        if (p.type === "insert" && p.parentId && p.parentId !== "root") {
          const parentExists =
            knownIds.has(p.parentId) ||
            batchCreatedIds.has(p.parentId);

          if (!parentExists) {
            console.error(
              `INSERT references unknown parent ${p.parentId} for child ${p.id}. Known: ${[...knownIds].join(",")}, Batch: ${[...batchCreatedIds].join(",")}`
            );
          }
          expect(parentExists).toBe(true);
        }
      }
    }
  });

  test("no orphaned patch messages between initialTree and first action", async () => {
    server = new RemoteServer()
      .module("App", createModuleWithOnCreated())
      .ui(UI_WITH_LIST);

    await server.listen(PORT);

    const client = await connectClient(PORT);
    clients.push(client);
    await client.waitForMessage((m) => m.type === "initialTree");

    // Wait for any extra patches that might arrive from onCreated
    await wait(200);

    // Before any user action, there should be NO extra patch messages.
    // All onCreated content should be in the initialTree.
    const unexpectedPatches = client.messages.filter(
      (m) => m.type === "patch"
    );

    // If this fails, it means onCreated triggered a separate patch message
    // instead of being included in the initialTree. The client receives
    // the extra patches, but if there's any timing issue (e.g., the client
    // processes them out of order), elements can be lost.
    expect(unexpectedPatches.length).toBe(0);
  });
});
