# Hypen Remote Streaming

Stream Hypen apps over WebSocket to enable:

- **Cross-platform rendering**: Run your app on a server, render on any client (Web, iOS, Android)
- **Embedded remote apps**: Nest remote apps within local apps using the `HypenApp` component
- **Thin clients**: Reduce bundle size by moving logic to the server
- **Server-side rendering**: Full control over state and business logic

## Quick Start

### 1. Create a Remote Server

```typescript
// server.ts
import { RemoteServer } from "@hypen-space/server";
import { HypenApp } from "@hypen-space/core";

const myApp = new HypenApp();

myApp.module("Counter")
  .defineState({ count: 0 })
  .onAction("increment", async ({ state }) => { state.count++; })
  .ui(`
    Column {
      Text("Count: @{state.count}")
      Button { Text("+") }.onClick("@actions.increment")
    }
  `)
  .build();

new RemoteServer()
  .app(myApp)
  .onConnection((client) => {
    console.log(\`Client \${client.id} connected\`);
  })
  .listen(3000);
```

Run the server:
```bash
bun run server.ts
```

### 2. Connect a Client (Programmatic)

```typescript
// client.ts
import { RemoteEngine } from "@hypen-space/core/remote/client";
import { createHypenClient } from "@hypen-space/web/dom";

const app = document.getElementById("app");

const remoteEngine = new RemoteEngine("ws://localhost:3000")
  .onConnect(() => {
    console.log("Connected!");
  });

// `createHypenClient` builds the renderer and subscribes to patches in one call.
createHypenClient(app, remoteEngine);

await remoteEngine.connect();
```

### 3. Embed Remote Apps in Hypen DSL

```typescript
import { HypenAppComponent } from "@hypen-space/core/remote";

// Create local app
const localUI = `
  Column {
    Text("Local content")
    Container { }.id("remote-container")
  }
`;

engine.renderSource(localUI);

// Embed remote app
const container = document.querySelector('[data-hypen-id*="remote-container"]');
const remoteApp = new HypenAppComponent(container, {
  url: "ws://localhost:3000",
  autoReconnect: true,
});
```

## Examples

### Run the Counter Server
```bash
bun run examples/remote/counter-server.ts
```

### Run the Client
```bash
# Start a dev server for the client HTML
bun examples/remote/server.ts
# Then open http://localhost:3001/counter-client.html
```

### Embedded App Example
```bash
bun run examples/remote/embedded-app.ts
```

## Plugging Into Your Own Server

`RemoteServer.listen(port)` owns Bun's WebSocket server end-to-end, which is
the right default. If you already have an HTTP framework, want to run on
plain Node, or need a non-WebSocket transport, use the transport-agnostic
primitives instead:

```typescript
await server.prepare();                          // discovery + session manager
const session = server.createSession(transport); // any SessionTransport
session.receive(clientMsg);                      // forward incoming messages
session.destroy();                               // on disconnect
```

`SessionTransport` is the entire seam — `{ send(msg), close(code, reason) }`
— so adapting any server stack is ~15 lines.

| Stack                            | Example                                                 |
| -------------------------------- | ------------------------------------------------------- |
| Express + `ws`                   | [`express-ws-server.ts`](./express-ws-server.ts)        |
| Fastify + `@fastify/websocket`   | [`fastify-server.ts`](./fastify-server.ts)              |
| Node `http` + Server-Sent Events | [`node-http-sse-server.ts`](./node-http-sse-server.ts)  |
| Bun (default)                    | [`counter-server.ts`](./counter-server.ts)              |

For async-iterator-style consumers (SSE, HTTP/2 push, gRPC streaming), use
`AsyncQueueTransport` and pump `transport.stream()` into your response:

```typescript
const transport = new AsyncQueueTransport();
const session = server.createSession(transport);
for await (const msg of transport.stream()) {
  res.write(`data: ${JSON.stringify(msg)}\n\n`);
}
```

## Protocol

The Remote UI protocol uses JSON messages over WebSocket:

### InitialTree (Server → Client)
Sent when a client first connects:
```json
{
  "type": "initialTree",
  "module": "Counter",
  "state": { "count": 0 },
  "patches": [/* Create patches */],
  "revision": 0
}
```

### Patch (Server → Client)
Incremental updates:
```json
{
  "type": "patch",
  "module": "Counter",
  "patches": [/* Update patches */],
  "revision": 5
}
```

### DispatchAction (Client → Server)
User interactions:
```json
{
  "type": "dispatchAction",
  "module": "Counter",
  "action": "increment",
  "payload": { "amount": 5 }
}
```

### StateUpdate (Server → Client)
Full state sync (optional):
```json
{
  "type": "stateUpdate",
  "module": "Counter",
  "state": { "count": 10 }
}
```

## API Reference

### RemoteServer

```typescript
class RemoteServer {
  module(name: string, module: HypenModule): this;
  ui(dsl: string): this;
  config(config: RemoteServerConfig): this;
  onConnection(callback: (client: RemoteClient) => void): this;
  onDisconnection(callback: (client: RemoteClient) => void): this;
  listen(port?: number): void;
  getClientCount(): number;
  broadcast(message: RemoteMessage): void;
}
```

### RemoteEngine

```typescript
class RemoteEngine {
  constructor(url: string, options?: RemoteEngineOptions);
  connect(): Promise<void>;
  disconnect(): void;
  dispatchAction(action: string, payload?: any): void;
  onPatches(callback: (patches: Patch[]) => void): this;
  onStateUpdate(callback: (state: any) => void): this;
  onConnect(callback: () => void): this;
  onDisconnect(callback: () => void): this;
  onError(callback: (error: Error) => void): this;
  getState(): RemoteConnectionState;
  getCurrentState(): any;
  getRevision(): number;
}
```

### HypenAppComponent

```typescript
class HypenAppComponent {
  constructor(container: HTMLElement, props: HypenAppProps);
  dispatchAction(action: string, payload?: any): void;
  destroy(): void;
  get connected(): boolean;
}
```

## Architecture

```
┌─────────────────────────────────┐
│  Server (Bun)                   │
│  ┌────────────────────────┐    │
│  │ RemoteServer           │    │
│  │  ├─ Engine             │    │
│  │  ├─ Module             │    │
│  │  └─ WebSocket Handler  │    │
│  └──────────┬─────────────┘    │
└─────────────┼───────────────────┘
              │ WS
              │ JSON Messages
┌─────────────▼───────────────────┐
│  Client (Web/iOS/Android)       │
│  ┌────────────────────────┐    │
│  │ RemoteEngine           │    │
│  │  ├─ WebSocket          │    │
│  │  ├─ Message Parser     │    │
│  │  └─ Patch Queue        │    │
│  └──────────┬─────────────┘    │
│             │ Patches           │
│  ┌──────────▼─────────────┐    │
│  │ Renderer (DOM/Canvas)  │    │
│  └────────────────────────┘    │
└─────────────────────────────────┘
```

## Use Cases

### 1. Cross-Platform Apps
Write your app once, stream to Web, iOS, and Android:
```typescript
// Server runs the app
new RemoteServer().app(myApp).listen(3000);

// Clients just connect (Web, iOS, Android, etc.)
const engine = new RemoteEngine("ws://server.com:3000");
```

### 2. Embedded Widgets
Embed remote apps as widgets in a local app:
```typescript
// Host app
const localUI = `
  Column {
    Text("My Dashboard")
    // Embed remote widget
    Container { }.id("widget-1")
  }
`;

// Embed remote counter widget
new HypenAppComponent(widget1Container, {
  url: "ws://widgets.com/counter"
});
```

### 3. Multi-Tenant SaaS
Each tenant gets their own engine instance:
```typescript
const server = new RemoteServer()
  .onConnection((client) => {
    // Extract tenant from connection
    const tenant = getTenantFromClient(client);
    // Create tenant-specific module
    client.metadata = { tenant };
  });
```

## Advanced Features

### Reconnection
```typescript
const engine = new RemoteEngine(url, {
  autoReconnect: true,
  reconnectInterval: 3000,
  maxReconnectAttempts: 10,
});
```

### State Synchronization
```typescript
remoteEngine.onStateUpdate((state) => {
  console.log("State updated:", state);
  // Sync with local storage, etc.
});
```

### Error Handling
```typescript
remoteEngine.onError((error) => {
  console.error("Connection error:", error);
  showErrorToast(error.message);
});
```

## Performance Considerations

- **Revision Tracking**: Ensures patches apply in order
- **Keyed Reconciliation**: Minimizes DOM operations
- **Incremental Patches**: Only sends changes, not full tree
- **Binary Protocol**: Consider using MessagePack for production
- **Compression**: Enable WebSocket compression for large apps

## Security

- Use WSS (WebSocket Secure) in production
- Implement authentication before WebSocket upgrade
- Validate all actions server-side
- Rate limit actions to prevent abuse
- Sanitize user inputs in actions

## Next Steps

- [ ] Binary protocol (MessagePack)
- [ ] Built-in authentication hooks
- [ ] Session persistence
- [ ] Horizontal scaling with Redis pub/sub
- [x] Native iOS/Android SDKs
