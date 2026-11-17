import { describe, expect, test, afterEach } from "bun:test";
import { RemoteServer } from "../packages/server/src/remote/server";
import { HypenApp } from "../packages/core/src/app";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";

/**
 * Named child modules mounted directly in a template (not as the sole child
 * of a Route) must receive their own actions. Previously only the primary
 * module and the ManagedRouter-mounted route component got a
 * HypenModuleInstance, so the engine scoped the click to e.g. `counter` but
 * no `__hypen_scoped:counter:*` handler existed → "invalid scoped UI action".
 */

const counter = (n: string) =>
  `module ${n} { Row { Text("${n}: @{state.count}") Button { Text("inc${n}") }.onClick(@actions.increment) } }`;

function connect(port: number) {
  const messages: any[] = [];
  const ws = new WebSocket(`ws://localhost:${port}`);
  const opened = new Promise<void>((res, rej) => {
    ws.onopen = () => { ws.send(JSON.stringify({ type: "hello" })); res(); };
    ws.onerror = rej;
  });
  ws.onmessage = (e) => messages.push(JSON.parse(e.data as string));
  const until = async (pred: () => boolean, ms = 4000) => {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error("timeout; messages: " + JSON.stringify(messages).slice(0, 2000));
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  return { ws, messages, opened, until };
}

const allPatches = (messages: any[]) =>
  messages.flatMap((m) => (Array.isArray(m.patches) ? m.patches : []));

/** Node id of the Button whose child Text says `label`. */
function buttonFor(messages: any[], label: string): string {
  const patches = allPatches(messages);
  const text = patches.find((p) => p.type === "create" && p.props?.["0"] === label);
  const parent = patches.find((p) => p.type === "insert" && p.id === text?.id)?.parentId;
  if (!parent) throw new Error(`no button for ${label}`);
  return parent;
}

const texts = (messages: any[]) =>
  allPatches(messages)
    .filter((p) => (p.type === "create" && typeof p.props?.["0"] === "string") || (p.type === "setProp" && p.name === "0"))
    .map((p) => (p.type === "create" ? p.props["0"] : p.value));

describe("nested named modules receive actions", () => {
  let server: RemoteServer | null = null;
  let ws: WebSocket | null = null;
  afterEach(async () => {
    ws?.close();
    await new Promise((r) => setTimeout(r, 30));
    server?.stop();
    server = null;
  });

  for (const [label, appUi, names, port] of [
    ["direct child of the entry", `module App { Column { Counter() } }`, ["Counter"], 4621],
    ["sole content of the entry", `module App { Counter() }`, ["Counter"], 4622],
    [
      "second module inside a Route",
      `module App { Router { Route(path: "/") { Column { Alpha() Beta() } } } }`,
      ["Alpha", "Beta"],
      4623,
    ],
  ] as const) {
    test(label, async () => {
      const a = new HypenApp();
      for (const n of names) {
        a.module(n).defineState({ count: 0 }).onAction("increment", ({ state }) => { state.count++; }).ui(counter(n));
      }
      a.module("App").defineState({ location: "/" }).ui(appUi);
      server = new RemoteServer().app(a);
      await server.listen(port);
      const c = connect(port);
      ws = c.ws;
      await c.opened;
      await c.until(() => c.messages.some((m) => m.type === "initialTree"));
      await c.until(() => names.every((n) => texts(c.messages).includes(`${n}: 0`)));
      for (const n of names) {
        c.ws.send(JSON.stringify({
          type: "dispatchAction",
          module: "App",
          action: "__hypen_dispatch",
          payload: { node: buttonFor(c.messages, `inc${n}`), action: "increment" },
        }));
        await c.until(() => texts(c.messages).includes(`${n}: 1`));
      }
      expect(c.messages.filter((m) => m.type === "actionError")).toEqual([]);
    });
  }

  test("unnamed single-file component discovered and mounted as a child", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hypen-sfc-"));
    try {
      const core = resolve(import.meta.dir, "../packages/core/src/index.ts");
      writeFileSync(
        join(dir, "Clicker.ts"),
        `import { app, hypen } from ${JSON.stringify(core)};
export default app
  .defineState({ count: 0 })
  .onAction("increment", ({ state }) => { state.count++; })
  .ui(hypen\`
    // single-file form: no module wrapper
    Column {
      Text("Count: @{state.count}")
      Button { Text("+") }.onClick(@actions.increment)
    }
  \`);
`
      );
      const a = new HypenApp();
      a.module("App").defineState({ title: "t" }).ui(`module App { Column { Text("@{state.title}") Clicker() } }`);
      server = new RemoteServer().app(a).source(dir);
      await server.listen(4624);
      const c = connect(4624);
      ws = c.ws;
      await c.opened;
      await c.until(() => texts(c.messages).includes("Count: 0"));
      c.ws.send(JSON.stringify({
        type: "dispatchAction",
        module: "App",
        action: "__hypen_dispatch",
        payload: { node: buttonFor(c.messages, "+"), action: "increment" },
      }));
      await c.until(() => texts(c.messages).includes("Count: 1"));
      expect(texts(c.messages)).toContain("t");
      expect(c.messages.filter((m) => m.type === "actionError")).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * A module used inside ANOTHER module's template (App → Wrap → Inner) keeps
 * its own state scope and receives its own actions, at any depth and through
 * control flow, a route or a template-only component. The engine used to
 * stamp the outer module's scope over everything it expanded, so `Inner`
 * rendered `null` and its clicks went to `Wrap`.
 */
describe("modules nested inside other modules", () => {
  let server: RemoteServer | null = null;
  let ws: WebSocket | null = null;
  afterEach(async () => {
    ws?.close();
    await new Promise((r) => setTimeout(r, 30));
    server?.stop();
    server = null;
  });

  const wrap = (name: string, inner: string) =>
    `module ${name} { Column { Text("${name}: @{state.count}") Button { Text("inc${name}") }.onClick(@actions.increment) ${inner} } }`;

  for (const [label, templates, stateless, names, port] of [
    ["two modules deep", { Wrap: wrap("Wrap", "Inner()"), Inner: counter("Inner") }, {}, ["Wrap", "Inner"], 4631],
    [
      "three modules deep",
      { Wrap: wrap("Wrap", "Mid()"), Mid: wrap("Mid", "Inner()"), Inner: counter("Inner") },
      {},
      ["Wrap", "Mid", "Inner"],
      4632,
    ],
    [
      "inside If and ForEach",
      {
        Wrap: `module Wrap { Column { Text("Wrap: @{state.count}") Button { Text("incWrap") }.onClick(@actions.increment) If(condition: "@{state.show}") { Inner() } ForEach(items: @state.rows, key: "id") { Other() } } }`,
        Inner: counter("Inner"),
        Other: counter("Other"),
      },
      {},
      ["Wrap", "Inner", "Other"],
      4633,
    ],
    [
      "inside a Route of the outer module",
      {
        Wrap: `module Wrap { Column { Text("Wrap: @{state.count}") Button { Text("incWrap") }.onClick(@actions.increment) Router { Route(path: "/") { Column { Inner() } } } } }`,
        Inner: counter("Inner"),
      },
      {},
      ["Wrap", "Inner"],
      4634,
    ],
    [
      "through a template-only component",
      { Wrap: wrap("Wrap", "Panel { Inner() }"), Inner: counter("Inner") },
      { Panel: `Column { Text("panel") Children() }` },
      ["Wrap", "Inner"],
      4635,
    ],
    [
      "as the root of the outer module's template",
      { Wrap: `module Wrap { Inner() }`, Inner: counter("Inner") },
      {},
      ["Inner"],
      4636,
    ],
  ] as const) {
    test(label, async () => {
      const a = new HypenApp();
      // A different starting count per module: a binding or a click that
      // lands in the wrong module's state shows up as the wrong number.
      const start: Record<string, number> = {};
      Object.keys(templates).forEach((n, i) => { start[n] = (i + 1) * 10; });
      for (const [n, ui] of Object.entries(templates)) {
        a.module(n)
          .defineState({ count: start[n]!, show: true, rows: [{ id: "r1" }], location: "/" })
          .onAction("increment", ({ state }) => { state.count++; })
          .ui(ui);
      }
      a.module("App").defineState({ location: "/" }).ui(`module App { Column { Wrap() } }`);
      server = new RemoteServer().app(a).components(stateless);
      await server.listen(port);
      const c = connect(port);
      ws = c.ws;
      await c.opened;
      await c.until(() => names.every((n) => texts(c.messages).includes(`${n}: ${start[n]}`)));
      for (const n of names) {
        const before = texts(c.messages).length;
        c.ws.send(JSON.stringify({
          type: "dispatchAction",
          module: "App",
          action: "__hypen_dispatch",
          payload: { node: buttonFor(c.messages, `inc${n}`), action: "increment" },
        }));
        await c.until(() => texts(c.messages).includes(`${n}: ${start[n]! + 1}`));
        // The click changed its own module and nothing else.
        expect(texts(c.messages).slice(before)).toEqual([`${n}: ${start[n]! + 1}`]);
      }
      expect(texts(c.messages).some((t) => String(t).includes("null"))).toBe(false);
      expect(c.messages.filter((m) => m.type === "actionError")).toEqual([]);
    });
  }
});
