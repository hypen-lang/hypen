import { describe, expect, test, afterEach } from "bun:test";
import { RemoteServer } from "../packages/server/src/remote/server";
import { app } from "../packages/core/src/app";

/**
 * Tests for If-condition-based navigation (state.currentView switching).
 * Reproduces the social example pattern where clicking a story/nav item
 * should change the visible page via If(condition: "@{state.currentView == '...'}")
 */

const NAVIGATION_UI = `
module App {
  Column {
    If(condition: "@{state.currentView == 'feed'}") {
      Text("Feed Page")
    }
    If(condition: "@{state.currentView == 'profile'}") {
      Text("Profile Page")
    }
    If(condition: "@{state.currentView == 'storyViewer'}") {
      Text("Story Viewer")
    }
    Button { Text("Go Profile") }
      .onClick(@actions.navigateToProfile)
    Button { Text("View Story") }
      .onClick(@actions.viewStory, id: "s1")
  }
}
`;

function createNavModule() {
  return app
    .defineState<{
      currentView: string;
      previousView: string;
      selectedStoryId: string;
    }>({
      currentView: "feed",
      previousView: "feed",
      selectedStoryId: "",
    })
    .onAction("navigateToProfile", ({ state }) => {
      state.previousView = state.currentView;
      state.currentView = "profile";
    })
    .onAction("navigateToFeed", ({ state }) => {
      state.currentView = "feed";
    })
    .onAction<{ id?: string }>("viewStory", ({ state, action }) => {
      state.selectedStoryId = action.payload?.id || "";
      state.previousView = state.currentView;
      state.currentView = "storyViewer";
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

describe("Conditional navigation via state.currentView", () => {
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

  test("initial render shows feed page (currentView == 'feed')", async () => {
    server = new RemoteServer()
      .module("App", createNavModule())
      .ui(NAVIGATION_UI);

    await server.listen(PORT);

    const client = await connectClient(PORT);
    clients.push(client);
    const initMsg = await client.waitForMessage(
      (m) => m.type === "initialTree"
    );

    expect(initMsg.type).toBe("initialTree");
    expect(initMsg.state.currentView).toBe("feed");
    expect(initMsg.patches.length).toBeGreaterThan(0);

    // Should contain a setProp patch with "Feed Page" text content
    // The engine uses setProp with name "0" or "text" for text content
    const textPatches = initMsg.patches.filter(
      (p: any) =>
        (p.type === "setProp" && (p.name === "0" || p.name === "text") && p.value === "Feed Page") ||
        (p.type === "setText" && p.text === "Feed Page") ||
        (p.type === "create" && p.props?.["0"] === "Feed Page")
    );
    expect(
      textPatches.length,
      `Expected 'Feed Page' text in patches, got: ${JSON.stringify(initMsg.patches.filter((p: any) => p.type === "setProp" || p.type === "setText" || p.type === "create"), null, 2)}`
    ).toBeGreaterThan(0);
  });

  test("navigation patches use correct parent IDs (not transparent control-flow nodes)", async () => {
    server = new RemoteServer()
      .module("App", createNavModule())
      .ui(NAVIGATION_UI);

    await server.listen(PORT);

    const client = await connectClient(PORT);
    clients.push(client);
    const initMsg = await client.waitForMessage(
      (m) => m.type === "initialTree"
    );

    // Collect all created element IDs from initial patches
    const createdIds = new Set<string>();
    for (const p of initMsg.patches) {
      if (p.type === "create") createdIds.add(p.id);
    }

    client.send({ type: "subscribeState" });

    // Navigate to profile
    client.send({
      type: "dispatchAction",
      module: "App",
      action: "navigateToProfile",
    });

    const patchMsg = await client.waitForMessage((m) => m.type === "patch");

    // Every insert patch should reference a parentId that was previously created
    // or is "root". This verifies we don't reference transparent __Conditional nodes.
    for (const p of patchMsg.patches) {
      if (p.type === "insert") {
        expect(
          p.parentId === "root" || createdIds.has(p.parentId),
          `Insert patch references parentId "${p.parentId}" which was never created as a DOM element. ` +
          `Created IDs: ${[...createdIds].join(", ")}`
        ).toBe(true);
      }
      // Track newly created elements
      if (p.type === "create") createdIds.add(p.id);
    }
  });

  test("dispatching navigateToProfile changes view and generates patches", async () => {
    server = new RemoteServer()
      .module("App", createNavModule())
      .ui(NAVIGATION_UI);

    await server.listen(PORT);

    const client = await connectClient(PORT);
    clients.push(client);
    await client.waitForMessage((m) => m.type === "initialTree");

    // Subscribe to state to verify state changes
    client.send({ type: "subscribeState" });

    // Navigate to profile
    client.send({
      type: "dispatchAction",
      module: "App",
      action: "navigateToProfile",
    });

    // Should receive patches for the view change
    const patchMsg = await client.waitForMessage((m) => m.type === "patch");
    expect(patchMsg.patches.length).toBeGreaterThan(0);

    // Should receive state update with currentView = 'profile'
    const stateMsg = await client.waitForMessage(
      (m) => m.type === "stateUpdate"
    );
    expect(stateMsg.state.currentView).toBe("profile");

    // The patches should include removing "Feed Page" and adding "Profile Page"
    // Look for setText or setProp with "Profile Page"
    const allPatches = patchMsg.patches;
    const hasProfileText = allPatches.some(
      (p: any) =>
        (p.type === "setProp" && p.value === "Profile Page") ||
        (p.type === "setText" && p.text === "Profile Page")
    );
    const hasRemove = allPatches.some((p: any) => p.type === "remove");

    // At minimum, new elements should be created for the profile view
    const hasCreate = allPatches.some((p: any) => p.type === "create");

    expect(
      hasProfileText || hasCreate,
      `Expected patches to contain profile content or create ops, got: ${JSON.stringify(allPatches, null, 2)}`
    ).toBe(true);
  });

  test("dispatching viewStory with payload changes view to storyViewer", async () => {
    server = new RemoteServer()
      .module("App", createNavModule())
      .ui(NAVIGATION_UI);

    await server.listen(PORT);

    const client = await connectClient(PORT);
    clients.push(client);
    await client.waitForMessage((m) => m.type === "initialTree");

    client.send({ type: "subscribeState" });

    // View a story (mimics clicking a story item)
    client.send({
      type: "dispatchAction",
      module: "App",
      action: "viewStory",
      payload: { id: "s1" },
    });

    // Should get patches
    const patchMsg = await client.waitForMessage((m) => m.type === "patch");
    expect(patchMsg.patches.length).toBeGreaterThan(0);

    // State should reflect the change
    const stateMsg = await client.waitForMessage(
      (m) => m.type === "stateUpdate"
    );
    expect(stateMsg.state.currentView).toBe("storyViewer");
    expect(stateMsg.state.selectedStoryId).toBe("s1");
  });

  test("navigating feed -> profile -> feed produces correct patches each time", async () => {
    server = new RemoteServer()
      .module("App", createNavModule())
      .ui(NAVIGATION_UI);

    await server.listen(PORT);

    const client = await connectClient(PORT);
    clients.push(client);
    await client.waitForMessage((m) => m.type === "initialTree");
    client.send({ type: "subscribeState" });

    // Navigate to profile
    client.send({
      type: "dispatchAction",
      module: "App",
      action: "navigateToProfile",
    });
    await client.waitForMessage(
      (m) => m.type === "stateUpdate" && m.state?.currentView === "profile"
    );

    const patchesAfterProfile = client.messages.filter(
      (m) => m.type === "patch"
    );
    expect(patchesAfterProfile.length).toBeGreaterThan(0);

    // Navigate back to feed
    client.send({
      type: "dispatchAction",
      module: "App",
      action: "navigateToFeed",
    });
    await client.waitForMessage(
      (m) => m.type === "stateUpdate" && m.state?.currentView === "feed"
    );

    const patchesAfterFeed = client.messages.filter(
      (m) => m.type === "patch"
    );
    // Should have more patches (from both navigations)
    expect(patchesAfterFeed.length).toBeGreaterThan(patchesAfterProfile.length);
  });

  test("multiple rapid navigations all produce patches", async () => {
    server = new RemoteServer()
      .module("App", createNavModule())
      .ui(NAVIGATION_UI);

    await server.listen(PORT);

    const client = await connectClient(PORT);
    clients.push(client);
    await client.waitForMessage((m) => m.type === "initialTree");
    client.send({ type: "subscribeState" });

    // Rapid navigation: feed -> profile -> storyViewer -> feed
    client.send({
      type: "dispatchAction",
      module: "App",
      action: "navigateToProfile",
    });
    client.send({
      type: "dispatchAction",
      module: "App",
      action: "viewStory",
      payload: { id: "s2" },
    });
    client.send({
      type: "dispatchAction",
      module: "App",
      action: "navigateToFeed",
    });

    // Wait for final state
    await client.waitForMessage(
      (m) => m.type === "stateUpdate" && m.state?.currentView === "feed"
    );

    // Each navigation should produce patches
    const patches = client.messages.filter((m) => m.type === "patch");
    expect(patches.length).toBeGreaterThanOrEqual(3);
  });
});
