# wasm-http

A Hypen module that makes an HTTP request — written in **TypeScript**, built to
a **WebAssembly Component**, and hosted by an ordinary TypeScript app.

- **`App`** — the entry, an in-process TypeScript module (`src/components/App/`).
- **`Weather`** — TypeScript source in `modules/weather/`, compiled with
  `hypen build --target wasm` and declared in `hypen.json` as a prebuilt
  module. It fetches a forecast from a local API (`scripts/api.ts`), so the
  example runs offline.

## Why it looks the way it does

A module that runs as a component is a synchronous reducer: a handler cannot
`await fetch(...)`. Instead it **queues** a request and names the action that
should receive the response. The host performs the request after the handler
returns, and dispatches that action with the outcome:

```ts
.onAction("refresh", ({ state, context }) => {
  state.status = "loading…";
  context.http!.get(state.endpoint, { then: "loaded", tag: String(state.requests) });
})
.onAction("loaded", ({ action, state }) => {
  const response = action.payload;
  if (!isHttpCompletion(response)) return;
  if (!response.ok) state.status = `failed (${response.error.kind}): ${response.error.message}`;
  else if (response.status !== 200) state.status = `the server answered HTTP ${response.status}`;
  else Object.assign(state, show(JSON.parse(response.body)), { status: "ok" });
})
```

This is `hypen:http/deferred`, and it works on every host (Node, Bun, the
native runtime, a browser). The full module is
[`modules/weather/src/components/Weather/component.ts`](modules/weather/src/components/Weather/component.ts).

## The grants

The module is a **source package** of the app: the app's `hypen.json` points
at the module project and `hypen dev` builds it.

```json
"wasm": {
  "packages": {
    "./modules/weather": { "source": true }
  }
}
```

What the module may do is declared once, in the module project
(`modules/weather/hypen.json`):

```json
"Weather": { "http": true, "httpHosts": ["127.0.0.1:8787"] }
```

- `"http": true` lets the module make requests at all. For a TypeScript
  module it also decides whether the built component imports the HTTP
  interface. A source package is granted what it declares, so the app does
  not repeat it.
- `"httpHosts"` narrows the grant to an allowlist. Here it also does a second
  job: a server does not let a hosted module reach `localhost` or a private
  address unless the module's `httpHosts` names that host exactly. Remove the
  line and the request to the local API is refused, with the field to add in
  the dev server's output.

## Run

`hypen dev` builds the module's component from source at startup (a few
seconds; it is about 12 MB — a TypeScript module carries a JavaScript engine
— so it is not committed). That needs `@bytecodealliance/jco`, a dev
dependency of the CLI. From this directory, with the in-repo CLI:

```bash
# 1. the local "weather service"
bun scripts/api.ts                               # http://127.0.0.1:8787

# 2. the app (another terminal): builds modules/weather, then serves
bun ../../hypen-cli/bin/hypen.ts dev             # http://localhost:3000
```

Edit `modules/weather/src/components/Weather/component.ts` while it runs and
the module is rebuilt and reloaded in the open page.

Open the page and press **Refresh**, or drive it from a third terminal over
the same WebSocket protocol a renderer uses:

```bash
bun scripts/drive.ts ws://localhost:3000
```

```
  click "Refresh"
    <- Requests sent: 1
    <- Status: loading…
    <- City: Oslo
    <- Status: ok
    <- Sky: light rain
    <- Temperature: 7 °C
```

`loading…` is the reducer's own state change; the rest arrives when the
response does.

## Things to try

`scripts/drive.ts` takes a URL (and a time budget in ms) for the module to
request instead of its default:

| Command | What happens |
|---------|--------------|
| `bun scripts/drive.ts ws://localhost:3000 http://127.0.0.1:8787/old/zagreb` | The API redirects; the server follows it (still inside the allowlist) |
| `… http://127.0.0.1:8787/nope` | `Status: the server answered HTTP 404` — a 404 is a response, not a failure |
| `… http://example.com/` | Refused when queued: `Status: not sent (permission-denied): host 'example.com:80' is not in the manifest's \`httpHosts\` allowlist` |
| `… http://127.0.0.1:8787/away` | The API redirects to `example.com`; the server refuses the hop and the dev console says which host to add to `httpHosts` |
| `… http://127.0.0.1:8787/slow 500` | `Status: failed (timeout): no complete response within 500 ms` |

Refusals and failures also appear in the `hypen dev` output:

```
  ✖ Weather "loaded": HTTP request did not complete
    GET http://127.0.0.1:8787/slow failed (timeout): no complete response within 500 ms
    request: GET http://127.0.0.1:8787/slow → timeout
    Hint: the request's time budget is 500 ms: pass a larger `timeoutMs` (up to 120000) if the endpoint is slow
```

In this repository `tsconfig.json` points `@hypen-space/*` at the SDK sources
next to the example. In your own project, drop those `paths` and install the
packages: `bun add @hypen-space/core @hypen-space/server @hypen-space/module-host`
and `bun add -d @hypen-space/cli @bytecodealliance/jco@1.42.0`.

## Files

```
hypen.json                                    the app; points at modules/weather as a source package
src/components/App/                           entry (in-process TypeScript)
modules/weather/hypen.json                    the module's own project: what Weather requests
modules/weather/src/components/Weather/       the module: component.ts + component.hypen
modules/weather/dist/wasm/                    what `hypen dev` builds (git-ignored)
scripts/api.ts                                the local weather API
scripts/drive.ts                              a small protocol client
```

The example is built, booted and clicked through by
`hypen-cli/tests/example-wasm-http.test.ts`, wherever jco is available.
