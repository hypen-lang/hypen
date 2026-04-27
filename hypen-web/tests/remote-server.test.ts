import { describe, expect, test, afterEach } from "bun:test";
import { RemoteServer } from "../packages/server/src/remote/server";
import { app } from "../packages/core/src/app";

const UI = `module Counter { Text("Count: @{state.count}") Button { Text("+") }.onClick(@actions.increment) }`;

function createCounterModule() {
  return app
    .defineState<{ count: number }>({ count: 0 })
    .onAction("increment", ({ state }) => {
      state.count++;
    })
    .build();
}

type Client = {
  messages: any[];
  send: (msg: any) => void;
  close: () => void;
  waitForMessage: (predicate: (msg: any) => boolean, timeoutMs?: number) => Promise<any>;
};

/**
 * Connect a raw WebSocket, send hello, and collect all JSON messages.
 */
function connectClient(port: number): Promise<Client> {
  return new Promise((resolve, reject) => {
    const messages: any[] = [];
    const waiters: Array<{ predicate: (msg: any) => boolean; resolve: (msg: any) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];
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
            // Check existing messages first
            const existing = messages.find(predicate);
            if (existing) return res(existing);
            if (closed) return rej(new Error("WebSocket closed before message arrived"));
            const timer = setTimeout(() => rej(new Error("Timed out waiting for message")), timeoutMs);
            waiters.push({
              predicate,
              resolve: (msg) => { clearTimeout(timer); res(msg); },
              reject: rej,
              timer,
            });
          }),
      });
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data as string);
      messages.push(msg);
      // Check waiters
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].predicate(msg)) {
          waiters[i].resolve(msg);
          waiters.splice(i, 1);
        }
      }
    };

    ws.onclose = () => {
      closed = true;
      // Reject all pending waiters so tests don't hang
      for (const w of waiters) {
        clearTimeout(w.timer);
        w.reject(new Error("WebSocket closed before message arrived"));
      }
      waiters.length = 0;
    };

    ws.onerror = (err) => reject(err);
  });
}

/** Small delay to ensure messages are not received */
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("RemoteServer basics", () => {
  let server: RemoteServer | null = null;
  let clients: Client[] = [];
  const PORT = 19876;

  afterEach(async () => {
    // Close all clients before stopping server to avoid unhandled errors
    for (const c of clients) c.close();
    clients = [];
    await wait(50);
    server?.stop();
    server = null;
    // Give the OS time to release the port
    await wait(50);
  });

  test("sends initialTree with state on connect", async () => {
    server = new RemoteServer()
      .module("Counter", createCounterModule())
      .ui(UI);

    await server.listen(PORT);

    const client = await connectClient(PORT);
    clients.push(client);
    const initMsg = await client.waitForMessage((m) => m.type === "initialTree");

    expect(initMsg.type).toBe("initialTree");
    expect(initMsg.module).toBe("Counter");
    expect(initMsg.state).toBeDefined();
    expect(initMsg.state.count).toBe(0);
    expect(initMsg.patches).toBeInstanceOf(Array);
    expect(initMsg.patches.length).toBeGreaterThan(0);
  });

  test("does NOT send stateUpdate when client has not subscribed", async () => {
    server = new RemoteServer()
      .module("Counter", createCounterModule())
      .ui(UI);

    await server.listen(PORT);

    const client = await connectClient(PORT);
    clients.push(client);
    await client.waitForMessage((m) => m.type === "initialTree");

    // Dispatch an action — should get patches but no stateUpdate
    client.send({ type: "dispatchAction", module: "Counter", action: "increment" });
    await client.waitForMessage((m) => m.type === "patch");

    // Give time for any stateUpdate to arrive (it shouldn't)
    await wait(100);

    const stateUpdates = client.messages.filter((m) => m.type === "stateUpdate");
    expect(stateUpdates.length).toBe(0);
  });
});

describe("RemoteServer subscribeState", () => {
  let server: RemoteServer | null = null;
  let clients: Client[] = [];
  const PORT = 19878;

  afterEach(async () => {
    for (const c of clients) c.close();
    clients = [];
    await wait(50);
    server?.stop();
    server = null;
    await wait(50);
  });

  test("sends stateUpdate after action when client is subscribed", async () => {
    server = new RemoteServer()
      .module("Counter", createCounterModule())
      .ui(UI);

    await server.listen(PORT);

    const client = await connectClient(PORT);
    clients.push(client);
    await client.waitForMessage((m) => m.type === "initialTree");

    // Subscribe to state updates
    client.send({ type: "subscribeState" });

    // Dispatch an action
    client.send({ type: "dispatchAction", module: "Counter", action: "increment" });

    // Should receive stateUpdate with count: 1
    const stateMsg = await client.waitForMessage((m) => m.type === "stateUpdate");

    expect(stateMsg.type).toBe("stateUpdate");
    expect(stateMsg.module).toBe("Counter");
    expect(stateMsg.state.count).toBe(1);
    expect(stateMsg.revision).toBeGreaterThan(0);
  });

  test("sends stateUpdate for every patch when subscribed", async () => {
    server = new RemoteServer()
      .module("Counter", createCounterModule())
      .ui(UI);

    await server.listen(PORT);

    const client = await connectClient(PORT);
    clients.push(client);
    await client.waitForMessage((m) => m.type === "initialTree");

    client.send({ type: "subscribeState" });

    // Dispatch multiple actions
    client.send({ type: "dispatchAction", module: "Counter", action: "increment" });
    client.send({ type: "dispatchAction", module: "Counter", action: "increment" });
    client.send({ type: "dispatchAction", module: "Counter", action: "increment" });

    await client.waitForMessage(
      (m) => m.type === "stateUpdate" && m.state?.count === 3
    );

    const patches = client.messages.filter((m) => m.type === "patch");
    const stateUpdates = client.messages.filter((m) => m.type === "stateUpdate");

    // Each patch should have a corresponding stateUpdate
    expect(stateUpdates.length).toBe(patches.length);
  });

  test("re-renders when subscribed client sends updateState (time-travel)", async () => {
    server = new RemoteServer()
      .module("Counter", createCounterModule())
      .ui(UI);

    await server.listen(PORT);

    const client = await connectClient(PORT);
    clients.push(client);
    await client.waitForMessage((m) => m.type === "initialTree");

    client.send({ type: "subscribeState" });

    // Increment to count: 3
    client.send({ type: "dispatchAction", module: "Counter", action: "increment" });
    client.send({ type: "dispatchAction", module: "Counter", action: "increment" });
    client.send({ type: "dispatchAction", module: "Counter", action: "increment" });
    await client.waitForMessage((m) => m.type === "stateUpdate" && m.state?.count === 3);

    // Time-travel back to count: 1
    client.send({ type: "updateState", module: "Counter", state: { count: 1 } });

    // Should receive stateUpdate with count: 1 and a corresponding patch
    const stateMsg = await client.waitForMessage(
      (m) => m.type === "stateUpdate" && m.state?.count === 1
    );
    expect(stateMsg.state.count).toBe(1);

    const patchesAfterTravel = client.messages.filter(
      (m) => m.type === "patch" && m.revision === stateMsg.revision
    );
    expect(patchesAfterTravel.length).toBe(1);
  });
});

describe("RemoteServer syncActions + updateState", () => {
  let server: RemoteServer | null = null;
  let clients: Client[] = [];
  const PORT = 19879;

  afterEach(async () => {
    for (const c of clients) c.close();
    clients = [];
    await wait(50);
    server?.stop();
    server = null;
    await wait(50);
  });

  test("updateState syncs to other clients when syncActions is enabled", async () => {
    server = new RemoteServer()
      .module("Counter", createCounterModule())
      .ui(UI)
      .syncActions();

    await server.listen(PORT);

    // Studio subscribes to state, device does not
    const studio = await connectClient(PORT);
    const device = await connectClient(PORT);
    clients.push(studio, device);

    await studio.waitForMessage((m) => m.type === "initialTree");
    await device.waitForMessage((m) => m.type === "initialTree");

    studio.send({ type: "subscribeState" });

    // Increment on device to count: 2 (studio sees it via syncActions)
    device.send({ type: "dispatchAction", module: "Counter", action: "increment" });
    device.send({ type: "dispatchAction", module: "Counter", action: "increment" });
    await studio.waitForMessage((m) => m.type === "stateUpdate" && m.state?.count === 2);

    // Studio time-travels back to count: 0
    studio.send({ type: "updateState", module: "Counter", state: { count: 0 } });

    // Studio should get stateUpdate with count: 0
    await studio.waitForMessage(
      (m) => m.type === "stateUpdate" && m.state?.count === 0
    );

    // Device should also re-render (gets patches, not stateUpdate since it didn't subscribe)
    const devicePatch = await device.waitForMessage(
      (m) => m.type === "patch" && m.revision > 0
    );
    expect(devicePatch.patches.length).toBeGreaterThan(0);
  });
});
