/**
 * Example: Hypen Remote on Express + `ws`
 *
 * Plug `RemoteServer` into an existing Express app + the `ws` WebSocket
 * library, instead of letting Hypen own `Bun.serve`. Useful when:
 *   - You already have an Express app with auth/middleware/routes
 *   - You're deploying to Node (not Bun) and want the standard `ws` stack
 *   - You want Hypen at one path (`/hypen`) alongside your REST API
 *
 * Install:
 *   npm install express ws @types/express @types/ws
 *
 * The integration is ~15 lines: build a `SessionTransport` over the ws
 * socket, hand it to `server.createSession(...)`, and forward
 * message/close events.
 */

// @ts-nocheck — example file; user provides their own express/ws install
import express from "express";
import { WebSocketServer } from "ws";
import { createServer } from "http";
import { app } from "@hypen-space/core";
import {
  RemoteServer,
  type SessionTransport,
} from "@hypen-space/server";

// ---------------------------------------------------------------------------
// 1. Define your Hypen app exactly as before.
// ---------------------------------------------------------------------------

const counterModule = app
  .defineState<{ count: number }>({ count: 0 })
  .onAction("increment", ({ state }) => {
    state.count++;
  })
  .build();

const counterUI = `
  Column {
    Text("Count: @{state.count}")
    Button { Text("+") }.onClick(@actions.increment)
  }
`;

const hypen = new RemoteServer()
  .module("Counter", counterModule)
  .ui(counterUI);

// One-time setup: discovery + session manager. Required before createSession.
await hypen.prepare();

// ---------------------------------------------------------------------------
// 2. Stand up Express however you normally would — auth middleware,
//    REST routes, static files, the works.
// ---------------------------------------------------------------------------

const expressApp = express();
expressApp.use(express.json());

expressApp.get("/health", (_req, res) => res.send("OK"));
expressApp.get("/api/stats", (_req, res) => res.json(hypen.getSessionStats()));

// Serve your client HTML, run auth middleware, etc.
// expressApp.use(authMiddleware);
// expressApp.use(express.static("public"));

const httpServer = createServer(expressApp);

// ---------------------------------------------------------------------------
// 3. Mount Hypen on a WebSocket path. The ws library handles the upgrade;
//    we just bridge each socket to a `RemoteSession`.
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ server: httpServer, path: "/hypen" });

wss.on("connection", (socket, req) => {
  // You can run any auth check here using `req.headers` before creating
  // the session. e.g. `if (!validToken(req.headers.authorization)) return socket.close(1008);`

  const transport: SessionTransport = {
    send: (msg) => socket.send(JSON.stringify(msg)),
    close: (code, reason) => socket.close(code, reason),
  };

  const session = hypen.createSession(transport, { socketHandle: socket });

  socket.on("message", (raw) => {
    // `raw` is a Buffer; `session.receive` accepts string|Buffer|RemoteMessage.
    session.receive(raw as Buffer);
  });

  socket.on("close", () => {
    session.destroy();
  });

  socket.on("error", (err) => {
    console.error(`Hypen socket error for ${session.id}:`, err);
  });
});

httpServer.listen(3000, () => {
  console.log("Express on http://localhost:3000");
  console.log("Hypen on  ws://localhost:3000/hypen");
});
