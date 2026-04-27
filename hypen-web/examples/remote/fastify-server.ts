/**
 * Example: Hypen Remote on Fastify + @fastify/websocket
 *
 * The same `RemoteServer.createSession(transport)` primitive plugs into
 * Fastify's WebSocket plugin without any Hypen-specific glue.
 *
 * Install:
 *   npm install fastify @fastify/websocket
 */

// @ts-nocheck — example file; user provides their own fastify install
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { app } from "@hypen-space/core";
import {
  RemoteServer,
  type SessionTransport,
} from "@hypen-space/server";

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

await hypen.prepare();

const fastify = Fastify({ logger: true });
await fastify.register(websocket);

// Regular REST routes coexist with the Hypen WS endpoint.
fastify.get("/health", async () => ({ ok: true }));
fastify.get("/api/stats", async () => hypen.getSessionStats());

fastify.get(
  "/hypen",
  { websocket: true },
  (socket /* WebSocket */, req) => {
    // Auth: `req.headers`, `req.cookies`, etc. — close the socket to reject.

    const transport: SessionTransport = {
      send: (msg) => socket.send(JSON.stringify(msg)),
      close: (code, reason) => socket.close(code, reason),
    };

    const session = hypen.createSession(transport, { socketHandle: socket });

    socket.on("message", (raw) => session.receive(raw as Buffer));
    socket.on("close", () => session.destroy());
  }
);

await fastify.listen({ port: 3000, host: "0.0.0.0" });
console.log("Fastify on http://localhost:3000");
console.log("Hypen on  ws://localhost:3000/hypen");
