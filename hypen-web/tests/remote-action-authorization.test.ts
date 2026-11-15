/**
 * A Remote UI client is untrusted: it may only run an action that is bound on
 * a node currently rendered for its session. Knowing a handler's name — bare
 * or in the engine's internal `__hypen_scoped:` form — is not authority.
 */
import { describe, expect, test } from "bun:test";
import { RemoteServer } from "../packages/server/src/remote/server";
import { AsyncQueueTransport } from "../packages/core/src/remote/remote-session";
import { HypenApp } from "../packages/core/src/app";

const UI = `
  Column {
    Text("Count: @{state.count}")
    Input(placeholder: "Name").bind(@state.name)
    Button("@actions.increment") { Text("+") }
    If(@state.isAdmin) { Button("@actions.wipe") { Text("Wipe") } }
  }
`;

function build() {
  const calls: string[] = [];
  const def = new HypenApp()
    .defineState({ count: 0, name: "", isAdmin: false })
    .onAction("increment", ({ state }) => {
      calls.push("increment");
      state.count += 1;
    })
    .onAction("wipe", () => {
      calls.push("wipe");
    })
    .onAction("navigateBack", () => {
      calls.push("navigateBack");
    })
    .ui(UI);
  return { calls, server: new RemoteServer().module("Counter", def) };
}

async function connect(server: RemoteServer) {
  await server.prepare();
  const transport = new AsyncQueueTransport();
  const messages: any[] = [];
  void (async () => {
    for await (const m of transport.stream()) messages.push(m);
  })();
  const session = server.createSession(transport, { helloGraceMs: null });
  await session.receive({ type: "hello" } as any);
  await session.ready;
  await new Promise((r) => setTimeout(r, 20));
  const send = async (action: string, payload?: unknown) => {
    await session.receive({ type: "dispatchAction", action, payload } as any);
    await new Promise((r) => setTimeout(r, 20));
  };
  const nodeOf = (action: string): string => {
    const create = messages
      .flatMap((m) => (m.type === "initialTree" || m.type === "patch" ? m.patches : []))
      .find((p: any) => p.type === "create" && p.props?.action === `@${action}`);
    return create.id;
  };
  const state = () => (session as any)._moduleInstance.getState();
  return { session, send, nodeOf, state };
}

describe("client-originated actions need a rendered binding", () => {
  test("a rendered action dispatches, by envelope or by bare name", async () => {
    const { calls, server } = build();
    const c = await connect(server);
    await c.send("__hypen_dispatch", { node: c.nodeOf("increment"), action: "increment", payload: {} });
    await c.send("increment");
    expect(calls).toEqual(["increment", "increment"]);
    await c.session.destroy();
  });

  test("an action whose control is not on screen is refused in every spelling", async () => {
    const { calls, server } = build();
    const c = await connect(server);
    await c.send("wipe");
    await c.send("__hypen_scoped::wipe");
    await c.send("__hypen_scoped:counter:wipe");
    await c.send("__hypen_dispatch", { node: c.nodeOf("increment"), action: "wipe", payload: {} });
    await c.send("__hypen_dispatch", { action: "wipe" });
    // Even a rendered action is not addressable by its internal name.
    await c.send("__hypen_scoped::increment");
    expect(calls).toEqual([]);
    await c.session.destroy();
  });

  test("the state writer is not reachable by name", async () => {
    const { server } = build();
    const c = await connect(server);
    const write = { path: "isAdmin", value: true };
    await c.send("__hypen_bind", write);
    await c.send("__hypen_scoped::__hypen_bind", write);
    await c.send("__hypen_dispatch", { action: "__hypen_bind", payload: write });
    expect(c.state().isAdmin).toBe(false);
    await c.session.destroy();
  });

  test("clientActions names what a client may call without a binding", async () => {
    const closed = build();
    const a = await connect(closed.server);
    await a.send("navigateBack");
    expect(closed.calls).toEqual([]);
    await a.session.destroy();

    const open = build();
    const b = await connect(open.server.clientActions("navigateBack", "__hypen_bind"));
    await b.send("navigateBack");
    await b.send("wipe");
    await b.send("__hypen_bind", { path: "isAdmin", value: true });
    expect(open.calls).toEqual(["navigateBack"]);
    expect(b.state().isAdmin).toBe(false);
    await b.session.destroy();
  });
});
