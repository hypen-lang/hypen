/**
 * Tests for the transport-agnostic RemoteSession API:
 *   - createSession(transport) drives a Hypen session without Bun.serve
 *   - AsyncQueueTransport.stream() yields outgoing messages as an async iterator
 *   - Custom SessionTransport implementations work end-to-end
 */

import { describe, expect, test, afterEach } from "bun:test";
import { RemoteServer } from "../packages/server/src/remote/server";
import {
  AsyncQueueTransport,
  type OutgoingMessage,
  type SessionTransport,
} from "../packages/server/src/remote/session";
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

async function buildServer(): Promise<RemoteServer> {
  const server = new RemoteServer()
    .module("Counter", createCounterModule())
    .ui(UI);
  await server.prepare();
  return server;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe("RemoteSession transport-agnostic API", () => {
  test("prepare() then createSession() drives a session without Bun.serve", async () => {
    const server = await buildServer();
    cleanups.push(() => server.stop());

    const sent: OutgoingMessage[] = [];
    const transport: SessionTransport = {
      send: (msg) => sent.push(msg),
      close: () => {},
    };

    const session = server.createSession(transport, { helloGraceMs: null });
    await session.receive({ type: "hello" });

    const ack = sent.find((m) => m.type === "sessionAck");
    expect(ack).toBeDefined();
    expect(ack && "isNew" in ack && ack.isNew).toBe(true);

    const initial = sent.find((m) => m.type === "initialTree");
    expect(initial).toBeDefined();
    expect(initial && "patches" in initial ? initial.patches.length : 0).toBeGreaterThan(0);

    // Dispatch an action → session should emit a `patch` message
    sent.length = 0;
    await session.receive({
      type: "dispatchAction",
      module: "Counter",
      action: "increment",
    });

    // Engine mutations propagate through a microtask, so flush.
    await new Promise((r) => queueMicrotask(() => r(null)));

    const patch = sent.find((m) => m.type === "patch");
    expect(patch).toBeDefined();

    await session.destroy();
  });

  test("createSession throws before prepare()", () => {
    const server = new RemoteServer().module("Counter", createCounterModule()).ui(UI);
    const transport: SessionTransport = { send: () => {}, close: () => {} };
    expect(() => server.createSession(transport)).toThrow(/prepared/i);
  });

  test("AsyncQueueTransport.stream() yields outgoing messages", async () => {
    const server = await buildServer();
    cleanups.push(() => server.stop());

    const transport = new AsyncQueueTransport();
    const session = server.createSession(transport, { helloGraceMs: null });

    const received: OutgoingMessage[] = [];
    const consumer = (async () => {
      for await (const msg of transport.stream()) {
        received.push(msg);
        if (msg.type === "initialTree") break;
      }
    })();

    await session.receive({ type: "hello" });
    await consumer;

    expect(received.some((m) => m.type === "sessionAck")).toBe(true);
    expect(received.some((m) => m.type === "initialTree")).toBe(true);

    await session.destroy();
  });

  test("AsyncQueueTransport drains queue before completing", async () => {
    const transport = new AsyncQueueTransport();
    const ack = {
      type: "sessionAck" as const,
      sessionId: "s1",
      isNew: true,
      isRestored: false,
    };
    transport.send(ack);
    transport.close();

    const out: OutgoingMessage[] = [];
    for await (const msg of transport.stream()) out.push(msg);

    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(ack);
  });

  test("createHandler() returns a handler trio", async () => {
    const server = await buildServer();
    cleanups.push(() => server.stop());

    const sent: OutgoingMessage[] = [];
    const transport: SessionTransport = {
      send: (msg) => sent.push(msg),
      close: () => {},
    };

    const handle = server.createHandler();
    const { session, receive, destroy } = handle(transport);
    expect(session.helloReceived).toBe(false);

    await receive({ type: "hello" });
    expect(session.helloReceived).toBe(true);
    expect(sent.some((m) => m.type === "initialTree")).toBe(true);

    await destroy();
    expect(session.isDestroyed).toBe(true);
  });
});
