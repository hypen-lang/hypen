/**
 * What a remote client may trigger.
 *
 * A Remote UI client is untrusted: the server runs an action it sends only
 * when it arrives as a `__hypen_dispatch` envelope addressed to a live node
 * that declares that action. A pre-scoped `__hypen_scoped:<scope>:<name>`,
 * a bare reserved write (`__hypen_bind`) and — unless the host listed it —
 * a bare application name are refused before any handler runs.
 *
 * Two groups:
 *  - "admission" runs against any engine artifact (the checks live in the
 *    session and in `client-action.ts`);
 *  - "binding check (rebuilt engine)" needs `resolveClientAction` in the
 *    WASM artifact and is skipped until it is rebuilt from an engine that
 *    has `EngineCore::route_client_action`.
 */

import { describe, expect, test, afterEach } from "bun:test";
import { RemoteServer } from "../packages/server/src/remote/server";
import { Engine } from "../packages/server/src/engine";
import {
  AsyncQueueTransport,
  type OutgoingMessage,
  type SessionTransport,
} from "../packages/server/src/remote/session";
import { app } from "../packages/core/src/app";
import {
  ClientActionRefused,
  admitUnboundClientAction,
  resolveClientEnvelope,
  type UnboundClientActions,
} from "../packages/core/src/remote/client-action";

const UI = `module Admin {
  Column {
    Text("Saves: @{state.saves}")
    Button { Text("Save") }.onClick(@actions.save)
    Input(placeholder: "Name").bind(@state.name)
    If(@state.isAdmin) {
      Button { Text("Wipe") }.onClick(@actions.wipe)
    }
  }
}`;

interface AdminState {
  saves: number;
  wiped: number;
  audits: number;
  backs: number;
  name: string;
  isAdmin: boolean;
}

function adminModule() {
  return app
    .defineState<AdminState>({ saves: 0, wiped: 0, audits: 0, backs: 0, name: "", isAdmin: false })
    .onAction("save", ({ state }) => { state.saves++; })
    // Bound only behind `If(@state.isAdmin)`.
    .onAction("wipe", ({ state }) => { state.wiped++; })
    // Registered, bound on no node at all.
    .onAction("audit", ({ state }) => { state.audits++; })
    .onAction("navigateBack", ({ state }) => { state.backs++; })
    .build();
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const flush = () => new Promise((r) => setTimeout(r, 10));

async function connect(allow?: UnboundClientActions) {
  const server = new RemoteServer().module("Admin", adminModule()).ui(UI);
  if (allow !== undefined) server.allowUnboundClientActions(allow);
  await server.prepare();
  const sent: OutgoingMessage[] = [];
  const transport: SessionTransport = { send: (m) => sent.push(m), close: () => {} };
  const session = server.createSession(transport, { helloGraceMs: null });
  await session.receive({ type: "hello" });
  await session.ready;
  cleanups.push(async () => {
    await session.destroy();
    server.stop();
  });

  const state = (): AdminState => session.moduleInstance!.getState() as AdminState;
  const send = async (action: string, payload?: unknown) => {
    await session.receive({ type: "dispatchAction", module: "Admin", action, payload } as never);
    await flush();
  };
  /** Wire id of the created node whose props carry `needle`. */
  const node = (needle: string): string => {
    for (const m of sent) {
      if (m.type !== "initialTree" && m.type !== "patch") continue;
      for (const p of m.patches as any[]) {
        if (p.type === "create" && JSON.stringify(p.props ?? {}).includes(needle)) return p.id;
      }
    }
    throw new Error(`no node carrying ${needle}`);
  };
  const envelope = (target: string, action: string, payload: unknown = {}) =>
    send("__hypen_dispatch", { node: target, action, payload });
  return { session, sent, state, send, node, envelope };
}

describe("client action admission", () => {
  test("an envelope on the live node that declares the action runs it", async () => {
    const c = await connect();
    await c.envelope(c.node("@save"), "save");
    expect(c.state().saves).toBe(1);
  });

  test("a bound reserved write goes through its node's .bind", async () => {
    const c = await connect();
    await c.envelope(c.node('"bind"'), "__hypen_bind", { path: "name", value: "Ada" });
    expect(c.state().name).toBe("Ada");
    // …and only to the declared path.
    await c.envelope(c.node('"bind"'), "__hypen_bind", { path: "isAdmin", value: true });
    expect(c.state().isAdmin).toBe(false);
  });

  test("a pre-scoped name is refused, registered or not", async () => {
    for (const allow of [undefined, "any"] as const) {
      const c = await connect(allow);
      await c.send("__hypen_scoped::wipe");
      await c.send("__hypen_scoped::audit", { all: true });
      await c.send("__hypen_scoped:admin:save");
      expect(c.state()).toMatchObject({ wiped: 0, audits: 0, saves: 0 });
    }
  });

  test("a bare reserved write is refused, even when bare names are allowed", async () => {
    for (const allow of [undefined, "any", ["__hypen_bind"]] as const) {
      const c = await connect(allow as UnboundClientActions | undefined);
      await c.send("__hypen_bind", { path: "isAdmin", value: true });
      await c.send("__hypen_reorder", { path: "name", from: 0, to: 1 });
      await c.send("__hypen_pin", { path: "name.0", x: 0, y: 0 });
      expect(c.state().isAdmin).toBe(false);
    }
  });

  test("a bare application name is refused unless the host listed it", async () => {
    const strict = await connect();
    for (const name of ["save", "wipe", "audit", "navigateBack"]) await strict.send(name);
    expect(strict.state()).toMatchObject({ saves: 0, wiped: 0, audits: 0, backs: 0 });

    const listed = await connect(["navigateBack"]);
    for (const name of ["save", "wipe", "audit", "navigateBack"]) await listed.send(name);
    expect(listed.state()).toMatchObject({ saves: 0, wiped: 0, audits: 0, backs: 1 });

    // The explicit opt-out: the pre-existing by-name behaviour.
    const legacy = await connect("any");
    for (const name of ["save", "wipe", "audit", "navigateBack"]) await legacy.send(name);
    expect(legacy.state()).toMatchObject({ saves: 1, wiped: 1, audits: 1, backs: 1 });
  });

  test("a malformed or nested envelope is refused", async () => {
    const c = await connect("any");
    const save = c.node("@save");
    for (const inner of ["__hypen_dispatch", "__hypen_scoped::wipe", "__hypen_anything"]) {
      await c.envelope(save, inner);
    }
    await c.send("__hypen_dispatch", "not an object");
    await c.send("__hypen_dispatch", { node: save });
    await c.send("__hypen_dispatch", { node: "999999", action: "save", payload: {} });
    expect(c.state()).toMatchObject({ saves: 0, wiped: 0, audits: 0 });
  });

  test("a refused action sends nothing and leaves the session usable", async () => {
    const c = await connect();
    const save = c.node("@save");
    c.sent.length = 0;
    await c.send("wipe");
    await c.send("__hypen_scoped::wipe");
    expect(c.sent.filter((m) => m.type === "patch")).toHaveLength(0);
    expect(c.state().wiped).toBe(0);
    await c.envelope(save, "save");
    expect(c.state().saves).toBe(1);
  });
});

describe("admitUnboundClientAction", () => {
  const refused = (name: unknown, allow?: UnboundClientActions) => {
    try {
      admitUnboundClientAction(name, allow);
      return false;
    } catch (err) {
      expect(err).toBeInstanceOf(ClientActionRefused);
      return true;
    }
  };

  test("router actions are always admitted; nothing else is by default", () => {
    for (const name of ["router.push", "router.replace", "router.back", "router.forward"]) {
      expect(refused(name)).toBe(false);
    }
    for (const name of ["save", "router.pushAll", "router", "", 7, null, undefined]) {
      expect(refused(name)).toBe(true);
    }
  });

  test("the allowlist admits exactly its names; `any` admits application names", () => {
    expect(refused("goBack", ["goBack"])).toBe(false);
    expect(refused("goback", ["goBack"])).toBe(true);
    expect(refused("anything", "any")).toBe(false);
  });

  test("no policy admits a reserved name", () => {
    for (const allow of [undefined, "any", ["__hypen_bind", "__hypen_scoped:a:b", "__hypen_dispatch"]] as const) {
      for (const name of ["__hypen_bind", "__hypen_reorder", "__hypen_pin", "__hypen_scoped:a:b", "__hypen_scoped::x", "__hypen_x"]) {
        expect(refused(name, allow as UnboundClientActions | undefined)).toBe(true);
      }
    }
  });
});

describe("resolveClientEnvelope", () => {
  const engine = (hasClientActionEntry: boolean) => {
    const calls: string[] = [];
    return {
      calls,
      hasClientActionEntry,
      resolveClientAction(name: string, payload?: unknown) {
        calls.push("client");
        return { name: "resolved", payload };
      },
      resolveUIAction(name: string, payload?: unknown) {
        calls.push("ui");
        return { name: "resolved", payload };
      },
    };
  };

  test("uses the engine's client entry when the artifact has it", () => {
    const e = engine(true);
    resolveClientEnvelope(e, { node: "1", action: "save" });
    expect(e.calls).toEqual(["client"]);
  });

  test("on an older artifact: ownership resolution, after the name checks", () => {
    const e = engine(false);
    resolveClientEnvelope(e, { node: "1", action: "save" });
    resolveClientEnvelope(e, { node: "1", action: "__hypen_bind" });
    expect(e.calls).toEqual(["ui", "ui"]);
    for (const payload of [null, "x", {}, { action: 3 }, { action: "__hypen_scoped::a" }, { action: "__hypen_dispatch" }, { action: "__hypen_other" }]) {
      expect(() => resolveClientEnvelope(e, payload)).toThrow(ClientActionRefused);
    }
    expect(e.calls).toEqual(["ui", "ui"]);
  });
});

// ── Needs the rebuilt WASM artifact ────────────────────────────────────────
//
// `resolveClientAction` (hypen-engine-rs `EngineCore::route_client_action`)
// is what checks that the ADDRESSED NODE carries the action. With an older
// `packages/server/wasm-node` artifact the session falls back to ownership
// resolution and these cases cannot hold; they run as soon as the artifact
// is rebuilt (`hypen-engine-rs/build-wasm.sh`). The same rule is pinned
// natively in `hypen-engine-rs/tests/test_client_action_authorization.rs`.

const probe = new Engine();
await probe.init();
const rebuilt = probe.hasClientActionEntry;

describe.skipIf(!rebuilt)("binding check (rebuilt engine)", () => {
  test("an envelope naming an action the addressed node does not carry is refused", async () => {
    const c = await connect("any");
    const save = c.node("@save");
    // `audit` is bound nowhere; `wipe` only behind a false If. Both belong
    // to the same module as the Save button.
    await c.envelope(save, "audit");
    await c.envelope(save, "wipe");
    // A sibling that declares nothing.
    await c.envelope(c.node("Saves:"), "save");
    expect(c.state()).toMatchObject({ saves: 0, wiped: 0, audits: 0 });
  });

  test("an action hidden behind a condition becomes reachable only once rendered", async () => {
    const c = await connect();
    expect(() => c.node("@wipe")).toThrow();
    // The app itself reveals the button (server-side state).
    c.session.moduleInstance!.updateState({ isAdmin: true });
    await flush();
    await c.envelope(c.node("@wipe"), "wipe");
    expect(c.state().wiped).toBe(1);
  });

  test("rendered text that looks like a reference is not a binding", async () => {
    const c = await connect();
    await c.envelope(c.node('"bind"'), "__hypen_bind", { path: "name", value: "@actions.wipe" });
    await c.envelope(c.node('"bind"'), "wipe");
    expect(c.state().wiped).toBe(0);
  });
});
