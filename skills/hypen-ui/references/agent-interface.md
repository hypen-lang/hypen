# Agent interface

Use this when implementing modules intended for agents, or wiring MCP, REST, and live-session attachment.

- Register actions through each SDK's normal handler API. All registered, non-reserved public actions are exposed, even without visible UI call sites. Names beginning `__`, `router.`, `hypen.`, or `hypen_` are reserved. There is no separate exposure annotation. Prefix a name with `_` to keep it private to the UI. Guarded dispatch stamps `action.sender` as `external` unless the host supplies a more specific sender.
- `.bind(@state.field)` declares a writable input. Call `dispatchExternal("hypen.set_input", { module: "search", field: "query", value: "..." })` for a named module. Primary-module writes omit `module`; reads use null. Obtain exact addresses from manifest metadata.
- Template references such as `Text("@{state.total}")` declare readable paths. Reading an ancestor projects declared descendants; referencing an entire object grants descendant reads. Keep private fields out of referenced objects.
- Exposure follows retained template declarations, including inactive routes and conditional branches, not current visibility or enabled state. Module teardown removes its declarations; persisted modules can retain them.
- `Router { Route(...) }` declares navigation. External names are `hypen.navigate` with `{ to }`, and `hypen.back`. MCP names replace the built-ins with `hypen_navigate`, `hypen_back`, `hypen_set_input`; module action names remain unchanged.
- Payload schemas derive from template call sites and seeded state, not host-language type declarations. Schemas for module actions are advisory. Validate untrusted payloads and permissions in the handler.
- State-backed `List`/`ForEach` resources project directly referenced row fields and row fields passed to public actions, preserving nested arrays and custom aliases. Read the collection resource, select a row, and send its declared argument (for example `sku`). Unreferenced fields, state-only action arguments, and arguments used only by `_private` actions stay unreadable. Iteration alone, computed row expressions, and provider-backed collections do not grant whole-state reads. Empty collections remain discoverable as `[]`.

## Host wiring

TypeScript engines provide `listActions`, `listRoutes`, `listBindings`, `getStateAt`, `dispatchExternal`, and `mcpManifest`. Wait for module readiness and render templates before inspecting the interface. Use manifest `degraded` entries to diagnose unpublishable names or unresolved scopes. For resource reads, use `_meta["dev.hypen/module"]` and `_meta["dev.hypen/statePath"]`, never parse URIs.

`@hypen-space/agent` supplies `serveStdio({ engine })` and `HypenMcpServer`. Stdio requires stdout to contain only protocol messages; send app logs to stderr. Successful MCP calls acknowledge delivery, not async completion. Read resources to observe results. Responses carry a revision cursor when available; compare it within one session to observe later renders, not as proof of async completion.

`RemoteServer.agent(options)` enables the TypeScript REST endpoints under `/__hypen__/agent`: GET `/manifest`, GET `/openapi.json`, POST `/sessions`, POST `/sessions/:id/dispatch`, GET `/sessions/:id/state`. POST `/sessions` with a user `sessionId` requests attachment; without it, a new headless engine is created. Headless handlers still have their normal external side effects.

The `authorize(request, sessionId)` callback gates attachment only. Set `.agent({ token })` for bearer authentication of every REST route, or authenticate in the host/gateway; without either the surface is open. Subsequent agent IDs are bearer capabilities. In-process `server.attach(sessionId)` does no authorization. Pass `handle.engine` to MCP for the same session the user sees. Handles become invalid after session teardown and follow `syncActions` when enabled.

Kotlin/Swift use server `attach`, Go uses `Attach`, Rust uses `SessionRegistry` with live sessions and outbound sinks. Those SDKs provide guarded dispatch and reads; bundled MCP/REST transports are TypeScript. Go's AgentHandle does not yet expose a manifest method. Consult the chosen SDK's README rather than inventing parity APIs.

The repository's maintained user guide is `hypen-docs/content/docs/guide/agent-interface.mdx`. Rebuild stale engine artifacts with `hypen-engine-rs/build-wasm.sh`, which copies JS/WASI artifacts and regenerates native bindings.
