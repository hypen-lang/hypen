/**
 * List virtualization over the remote protocol (docs/virtualization.md §4):
 * the `viewport` client → server message.
 *
 *   - session handler: applied to THIS session's engine after hello; ignored
 *     before hello and when malformed; clamped to u32; never replayed to a
 *     sibling session under syncActions; never answered with a stateUpdate.
 *   - end to end over a real WebSocket: RemoteServer + RemoteEngine render a
 *     100-item List, only the initial window arrives, a viewport report
 *     brings in the new rows.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { app } from "../packages/core/src/app";
import { RemoteEngine } from "../packages/core/src/remote/client";
import type { Patch } from "../packages/core/src/types";
import { RemoteServer } from "../packages/server/src/remote/server";
import type {
  OutgoingMessage,
  SessionTransport,
} from "../packages/server/src/remote/session";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => queueMicrotask(() => r(null)));
  await sleep(0);
};

const UI = `module Feed { List(@state.items, key: "id") { Text("row-@{item.id}") } }`;

function feedModule() {
  return app
    .defineState<{ items: Array<{ id: number }> }>({
      items: Array.from({ length: 100 }, (_, i) => ({ id: i })),
    })
    .onAction("noop", () => {})
    .build();
}

const VIRT = "__virt.window";

type VirtWindow = { total: number; start: number; end: number };

/** The element id carrying `__virt.window`, and its latest value. */
function findWindow(patches: Patch[]): { id: string; win: VirtWindow } | null {
  let found: { id: string; win: VirtWindow } | null = null;
  for (const p of patches as any[]) {
    if (p.type === "create" && p.props && VIRT in p.props) found = { id: p.id, win: p.props[VIRT] };
    if (p.type === "setProp" && p.name === VIRT) found = { id: p.id, win: p.value };
  }
  return found;
}

/** Text content of every created row. */
function rowTexts(patches: Patch[]): string[] {
  const out: string[] = [];
  for (const p of patches as any[]) {
    const vals =
      p.type === "create" ? Object.values(p.props ?? {}) : p.type === "setProp" ? [p.value] : [];
    for (const v of vals) if (typeof v === "string" && v.startsWith("row-")) out.push(v);
  }
  return out;
}

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function buildServer(sync = false): Promise<RemoteServer> {
  const server = new RemoteServer().module("Feed", feedModule()).ui(UI);
  if (sync) server.syncActions();
  await server.prepare();
  cleanups.push(() => server.stop());
  return server;
}

function openSession(server: RemoteServer) {
  const sent: OutgoingMessage[] = [];
  let closed = false;
  const transport: SessionTransport = {
    send: (m) => sent.push(m),
    close: () => {
      closed = true;
    },
  };
  const session = server.createSession(transport, { helloGraceMs: null });
  cleanups.push(() => session.destroy());
  const calls: Array<[string, number, number]> = [];
  const real = session.engine.setListViewport.bind(session.engine);
  session.engine.setListViewport = (id: string, s: number, e: number) => {
    calls.push([id, s, e]);
    real(id, s, e);
  };
  return { session, sent, calls, isClosed: () => closed };
}

type Opened = ReturnType<typeof openSession>;

async function hello(s: Opened) {
  await s.session.receive({ type: "hello" });
  await s.session.ready;
  const initial = s.sent.find((m) => m.type === "initialTree") as any;
  expect(initial).toBeDefined();
  const w = findWindow(initial.patches);
  expect(w).not.toBeNull();
  return w!;
}

const patchesOf = (s: Opened) =>
  s.sent.filter((m) => m.type === "patch").flatMap((m: any) => m.patches as Patch[]);

describe("RemoteSession viewport handler", () => {
  test("applies a valid viewport to this session's engine and streams patches", async () => {
    const server = await buildServer();
    const a = openSession(server);
    const { id, win } = await hello(a);
    expect(win.total).toBe(100);
    expect(win.start).toBe(0);
    expect(win.end).toBeLessThan(100);

    a.sent.length = 0;
    await a.session.receive({ type: "viewport", listId: id, start: 40, end: 70 });
    await flush();

    expect(a.calls).toEqual([[id, 40, 70]]);
    const patches = patchesOf(a);
    expect(findWindow(patches)?.win).toMatchObject({ total: 100, start: 40, end: 70 });
    expect(rowTexts(patches)).toContain("row-40");
    expect(rowTexts(patches)).toContain("row-69");
    expect(a.sent.some((m) => m.type === "stateUpdate")).toBe(false);
  });

  test("never sends a stateUpdate, even to a state-subscribed client", async () => {
    const server = await buildServer();
    const a = openSession(server);
    const { id } = await hello(a);
    await a.session.receive({ type: "subscribeState" });
    a.sent.length = 0;
    await a.session.receive({ type: "viewport", listId: id, start: 50, end: 80 });
    await flush();
    expect(a.sent.some((m) => m.type === "patch")).toBe(true);
    expect(a.sent.some((m) => m.type === "stateUpdate")).toBe(false);
  });

  test("ignores a viewport before hello", async () => {
    const server = await buildServer();
    const a = openSession(server);
    await a.session.receive({ type: "viewport", listId: "1", start: 0, end: 10 });
    await flush();
    expect(a.calls).toEqual([]);
    expect(a.sent).toEqual([]);
    expect(a.session.helloReceived).toBe(false);
  });

  test("ignores malformed viewports silently and clamps to u32", async () => {
    const server = await buildServer();
    const a = openSession(server);
    const { id } = await hello(a);
    a.sent.length = 0;
    const bad: unknown[] = [
      { type: "viewport", listId: id, start: -1, end: 10 },
      { type: "viewport", listId: id, start: 0, end: -5 },
      { type: "viewport", listId: id, start: 1.5, end: 10 },
      { type: "viewport", listId: id, start: 0, end: Number.NaN },
      { type: "viewport", listId: id, start: 0, end: Infinity },
      { type: "viewport", listId: id, start: "0", end: 10 },
      { type: "viewport", listId: id, end: 10 },
      { type: "viewport", listId: 7, start: 0, end: 10 },
      { type: "viewport", listId: "", start: 0, end: 10 },
      { type: "viewport", start: 0, end: 10 },
    ];
    for (const m of bad) await a.session.receive(m as any);
    // Also as raw text (the wire path).
    await a.session.receive(JSON.stringify({ type: "viewport", listId: id, start: -3, end: 4 }));
    await flush();
    expect(a.calls).toEqual([]);
    expect(a.sent).toEqual([]);
    expect(a.isClosed()).toBe(false);

    // Over-u32 bounds are clamped, not wrapped (and not rejected).
    await a.session.receive({ type: "viewport", listId: id, start: 2 ** 40, end: 2 ** 41 });
    expect(a.calls).toEqual([[id, 0xffffffff, 0xffffffff]]);

    // The session is still healthy afterwards.
    a.sent.length = 0;
    await a.session.receive({ type: "viewport", listId: id, start: 10, end: 40 });
    await flush();
    expect(a.sent.some((m) => m.type === "patch")).toBe(true);
    expect(a.isClosed()).toBe(false);
  });

  test("is not replayed to a sibling session under syncActions", async () => {
    const server = await buildServer(true);
    const a = openSession(server);
    const b = openSession(server);
    const { id } = await hello(a);
    await hello(b);
    a.sent.length = 0;
    b.sent.length = 0;

    await a.session.receive({ type: "viewport", listId: id, start: 60, end: 90 });
    await flush();

    expect(a.calls).toEqual([[id, 60, 90]]);
    expect(b.calls).toEqual([]);
    expect(a.sent.some((m) => m.type === "patch")).toBe(true);
    expect(b.sent).toEqual([]);

    // Sanity: syncActions IS on — an action does fan out to b.
    let bSaw = false;
    const realDispatch = b.session.engine.dispatchAction.bind(b.session.engine);
    b.session.engine.dispatchAction = (n: string, p?: unknown) => {
      bSaw = true;
      realDispatch(n, p);
    };
    await a.session.receive({ type: "dispatchAction", module: "Feed", action: "noop" });
    expect(bSaw).toBe(true);
  });
});

describe("viewport over a real WebSocket (RemoteServer + RemoteEngine)", () => {
  test("only the initial window arrives; a viewport brings in new rows", async () => {
    const server = new RemoteServer()
      .module("Feed", feedModule())
      .ui(UI)
      .config({ webClient: false });
    await server.listen(0);
    cleanups.push(() => server.stop());
    const port = (server as unknown as { server: { port: number } }).server.port;

    const engine = new RemoteEngine(`ws://127.0.0.1:${port}/ws`, { autoReconnect: false });
    cleanups.push(() => engine.dispose());
    const batches: Patch[][] = [];
    let stateUpdates = 0;
    engine.onPatches((p) => batches.push(p));
    engine.onStateUpdate(() => stateUpdates++);

    // Before connecting, a report is dropped, not thrown.
    engine.setListViewport("1", 0, 10);

    const res = await engine.connect();
    expect(res.ok).toBe(true);
    // Subscribed: the server would send a stateUpdate with every render.
    engine.subscribeState();

    let until = Date.now() + 10_000;
    while (batches.length === 0 && Date.now() < until) await sleep(10);
    expect(batches.length).toBe(1);

    const initial = batches[0]!;
    const w = findWindow(initial);
    expect(w).not.toBeNull();
    const { id, win } = w!;
    expect(win.total).toBe(100);
    expect(win.start).toBe(0);
    expect(win.end).toBeGreaterThan(0);
    expect(win.end).toBeLessThan(100);
    const initialRows = rowTexts(initial);
    expect(initialRows).toHaveLength(win.end);
    expect(initialRows).toContain("row-0");
    expect(initialRows).not.toContain(`row-${win.end}`);
    expect(initialRows).not.toContain("row-99");

    // (initialTree fires the state callbacks once client-side.)
    const stateBaseline = stateUpdates;
    engine.setListViewport(id, 80, 100);
    until = Date.now() + 10_000;
    while (batches.length < 2 && Date.now() < until) await sleep(10);
    expect(batches.length).toBe(2);

    const update = batches[1]!;
    const moved = findWindow(update);
    expect(moved?.id).toBe(id);
    expect(moved?.win).toMatchObject({ total: 100, start: 80, end: 100 });
    const newRows = rowTexts(update);
    expect(newRows).toContain("row-80");
    expect(newRows).toContain("row-99");
    expect(newRows).not.toContain("row-79");
    expect(update.some((p) => p.type === "remove")).toBe(true);
    await sleep(50);
    expect(stateUpdates).toBe(stateBaseline);
  });
});
