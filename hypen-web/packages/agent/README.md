# @hypen-space/agent

An MCP server over a **running** Hypen app. Point Claude Desktop, Claude Code
or any MCP client at it and the agent can press the app's buttons, walk its
routes, fill in its forms and read template-declared state. The interface
follows declarations, including inactive branches and retained modules, rather
than current screen visibility.

## What it exposes, and why that is the whole design

Every tool, schema, description and paragraph of instructions comes from
`Engine::mcp_manifest()` in the Rust engine, published here **verbatim**.
This package composes nothing:

| MCP request | Answered with |
|---|---|
| `initialize` | `manifest.protocolVersion`, `manifest.instructions` |
| `tools/list` | `manifest.tools`, unedited and unfiltered |
| `tools/call` | `engine.dispatchExternal(...)` |
| `resources/list` | `manifest.resources`, unedited |
| `resources/read` | `engine.getStateAt(...)`, addressed from the resource's `_meta` |

The manifest is derived from what a developer declared: `.onAction()` gives
tools, `Router { Route(path: …) }` gives navigation, `.bind(@state.x)` gives
writable inputs, and readable state is the paths the template actually
*renders*. Framework internals — `__hypen_bind`, the raw `router.*` verbs —
are never reachable, whatever a module names its own actions.

That rule is enforced in the engine (`hypen-engine-rs/src/agent.rs`), not
here. This server's contribution is negative: it never calls
`dispatchAction`, never parses a resource URI, and never resolves a tool name
the manifest did not publish. A URI that is not in `resources/list` is
refused as a string — `hypen://state/cart/_token` does not become a read just
because it is well-formed.

**Tools act; they never return data.** A successful `tools/call` reports that
the action was *delivered* — handlers run asynchronously and are not awaited,
so there is no return value to report and this server invents none. To
observe an effect, read a resource.

What it does report is a **settlement cursor**: the engine's render
`revision`, read after the dispatch returned, in the result's
`structuredContent: { dispatched, revision }` and in its text. Every
`resources/read` carries the revision at the time of the read in the
content's `_meta["dev.hypen/revision"]` (the `text` stays the bare JSON
value). The counter moves only on a render that produced patches, so a read
above a call's revision has observed a render since the call and one equal
to it has observed none — which lets a client stop polling blind, though it
cannot tell "still running" from "ran and changed nothing". An engine
without `getRevision` omits the cursor everywhere.

## Requirements

- An engine exposing `mcpManifest()`. `BaseEngine` in `@hypen-space/core`
  has it (next to `listActions` / `dispatchExternal`), reading the
  `wasm-bindgen` export in `hypen-engine-rs/src/wasm/js.rs`; it returns
  `null` when the loaded WASM predates that export, and in that case
  `new HypenMcpServer(...)` throws with a message naming the rebuild — it
  will not improvise a manifest. `AgentEngine` is a structural type, so the
  server accepts `@hypen-space/server`'s and `@hypen-space/web-engine`'s
  engines, and an `AgentHandle`'s `engine` view (below), with no change
  here. `tests/engine-binding.test.ts` pins that.
- Bun or Node ≥18. Stdio only; a browser has no stdin.

## Serving one app

Write a small entry script that boots your app exactly as any other host
would, then hands the engine to `serveStdio`:

```ts
// agent.ts
import { Engine } from "@hypen-space/server";
import { app, HypenModuleInstance } from "@hypen-space/core";
import { serveStdio } from "@hypen-space/agent";

const counter = app
  .defineState({ count: 0 }, { name: "Counter" })
  .onAction("increment", ({ state }) => {
    state.count += 1;
  })
  .build();

const engine = new Engine();
await engine.init();
// Nothing is on a screen, but a renderer callback is still how the engine
// hands over patches — and the declared surface only exists once something
// has been rendered.
engine.setRenderCallback(() => {});
engine.renderSource(`
  module Counter {
    Column {
      Text("Count: @{state.count}")
      Button("+").onClick(@actions.increment)
    }
  }
`);
await new HypenModuleInstance(engine, counter).waitForReady();

await serveStdio({
  engine,
  serverInfo: { name: "counter", version: "1.0.0" },
  // Optional: re-read the manifest on a timer so a surface change that
  // happens while the client is idle still sends tools/list_changed.
  pollIntervalMs: 1000,
});
```

> **Never write to stdout.** The protocol *is* stdout: one JSON-RPC message
> per line and nothing else. A single `console.log` anywhere in the process
> corrupts the stream and the client disconnects. Use `console.error` (stderr
> is free-form) — this server already logs its own diagnostics there,
> including anything the app declared that MCP could not publish.

## Attaching to a live session

The script above runs a headless engine of its own: the agent has a
sandbox, and no human sees what it does. To serve MCP over the session a
person is actually looking at, attach to it through `@hypen-space/server`
and hand the resulting handle's `engine` view to `HypenMcpServer`:

```ts
import { RemoteServer } from "@hypen-space/server/remote";
import { HypenMcpServer } from "@hypen-space/agent/server";

const server = new RemoteServer().app(myApp).listen(3000);

// From code that has already authenticated the caller for this session id —
// `attach` performs no authorization of its own.
const handle = server.attach(sessionId); // null: unknown, pre-hello, or destroyed
if (!handle) throw new Error("no live session");

const mcp = new HypenMcpServer({
  engine: handle.engine,
  onNotification: (n) => socket.send(JSON.stringify(n)),
});
```

Every `tools/call` now runs `dispatchExternal` on the user's own engine, so
the user's browser receives exactly the `patch` a click produces; every
`resources/read` reads that user's state, still bounded to the paths the
template renders. The handle never owns the session — it cannot destroy,
suspend or close it, and once the user disconnects `handle.alive` is
`false` and every call throws `AgentSessionGoneError`, which this server
surfaces as a JSON-RPC error like any other refused call. A guard refusal is
silent on the wire: nothing is sent to the user and the revision does not
move.

Over HTTP instead of in-process, `POST /__hypen__/agent/sessions` with
`{ "sessionId" }` does the same behind the server's `authorize` callback;
the `@hypen-space/server` README covers that surface.

## Pointing a client at it

### Claude Desktop

Edit `claude_desktop_config.json`
(macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`,
Windows: `%APPDATA%\Claude\claude_desktop_config.json`), then restart Claude
Desktop:

```json
{
  "mcpServers": {
    "counter": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/agent.ts"]
    }
  }
}
```

Use absolute paths — the client spawns the process with an unspecified
working directory. `"command": "node"` with a compiled `agent.js` works the
same way.

### Claude Code

```bash
claude mcp add counter -- bun run /absolute/path/to/agent.ts
```

### MCP Inspector (for debugging)

```bash
npx @modelcontextprotocol/inspector bun run /absolute/path/to/agent.ts
```

### By hand

The wire format is newline-delimited JSON-RPC, so a pipe is enough:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | bun run agent.ts
```

## What the agent sees

For the counter above:

- `increment` — the declared action, dispatched by name.
- `hypen_navigate` / `hypen_back` — only if the app declares a `Router`, and
  only for the routes it declares.
- `hypen_set_input` — only if the app declares a `.bind()`, and only for the
  fields it binds.
- `hypen://state/counter/count` — readable because the template renders it.

A capability the agent cannot find was **not declared**, rather than declared
and withheld; there is no alternate spelling to look for. Anything the app
declares that MCP cannot spell (an action named `add to cart`, say) is
reported on stderr at startup rather than silently renamed.

## Another transport

`HypenMcpServer` is the protocol; `StdioTransport` is only framing.

```ts
import { HypenMcpServer } from "@hypen-space/agent/server";

const server = new HypenMcpServer({
  engine,
  onNotification: (n) => socket.send(JSON.stringify(n)),
});
const response = server.handle(JSON.parse(incoming)); // null = notification
```

`server.refresh()` re-reads the manifest and emits
`notifications/tools/list_changed` (and the resources twin) when the
published surface actually changed — the engine's revision counter moves on
every render, so a re-read is cheap and a notification is not sent for a
render that changed no declaration.

## Tests

```bash
cd hypen-web && bun test packages/agent
```

See the [agent interface guide](../../../hypen-docs/content/docs/guide/agent-interface.mdx) for exposure rules, authentication responsibilities, and projected row discovery.
