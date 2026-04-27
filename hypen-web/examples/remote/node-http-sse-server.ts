/**
 * Example: Hypen Remote over Server-Sent Events (no WebSockets)
 *
 * If your runtime (a corporate proxy, a serverless platform, an HTTP/2-only
 * CDN tier) doesn't speak WebSockets, you can serve Hypen entirely over
 * plain HTTP by splitting the protocol across two endpoints:
 *
 *   GET  /hypen/stream?sessionId=...  → SSE response, server → client
 *   POST /hypen/send   { sessionId, message: ClientMessage }
 *                                     → forwards to the session
 *
 * The client establishes the EventSource first; the server replies with a
 * `sessionAck` carrying the session id; the client uses that id on every
 * subsequent POST.
 *
 * This file uses the built-in Node `http` module so it has zero non-Hypen
 * dependencies. The same pattern works on Express, Hono, or any other
 * Node HTTP framework.
 */

// @ts-nocheck — example file; uses node http only, no extra deps
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { app } from "@hypen-space/core";
import {
  RemoteServer,
  AsyncQueueTransport,
  type RemoteSession,
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

// Track sessions by Hypen sessionId so POST /hypen/send can route messages.
const sessionsById = new Map<string, RemoteSession>();

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

  // ----------------------------------------------------------------------
  // GET /hypen/stream — open an SSE connection and stream patches.
  // ----------------------------------------------------------------------
  if (req.method === "GET" && url.pathname === "/hypen/stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // disable nginx buffering
    });
    res.write(": connected\n\n");

    const transport = new AsyncQueueTransport();
    const session = hypen.createSession(transport, {
      // Disable the legacy hello timeout: the client will hello via POST.
      helloGraceMs: null,
      socketHandle: res,
    });

    // Heartbeat so proxies don't kill an idle connection.
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);

    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      clearInterval(heartbeat);
      transport.close();
      if (session.sessionId) sessionsById.delete(session.sessionId);
      session.destroy();
    };

    req.on("close", cleanup);
    req.on("error", cleanup);

    // Pump messages from session → SSE response.
    (async () => {
      try {
        for await (const msg of transport.stream()) {
          // Capture session id once we see sessionAck so POST /hypen/send
          // can find the session by id.
          if (msg.type === "sessionAck") {
            sessionsById.set(msg.sessionId, session);
          }
          res.write(`data: ${JSON.stringify(msg)}\n\n`);
        }
      } catch (err) {
        console.error("SSE pump error:", err);
      } finally {
        try { res.end(); } catch {}
      }
    })();
    return;
  }

  // ----------------------------------------------------------------------
  // POST /hypen/send — client sends hello / dispatchAction / etc.
  // Body: { sessionId?: string, message: RemoteMessage }
  // For the very first hello, sessionId is omitted; the server creates one
  // and returns it via sessionAck on the SSE stream.
  // ----------------------------------------------------------------------
  if (req.method === "POST" && url.pathname === "/hypen/send") {
    const body = await readBody(req);
    let parsed: { sessionId?: string; message: any };
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400).end("invalid json");
      return;
    }

    // For hello, the client must pass a `streamId` (we use sessionAck's
    // sessionId once it's known). Real apps would correlate via a cookie
    // set on the GET. For brevity, this example uses an explicit sessionId
    // returned from the first sessionAck.
    const session = parsed.sessionId
      ? sessionsById.get(parsed.sessionId)
      : firstUnclaimedSession();

    if (!session) {
      res.writeHead(404).end("unknown session");
      return;
    }

    await session.receive(parsed.message);
    res.writeHead(202).end();
    return;
  }

  res.writeHead(404).end();
});

/**
 * Trivial helper: return the most recently created session that has not
 * yet received a hello. A real deployment would correlate via a cookie
 * set on the GET /hypen/stream response instead.
 */
function firstUnclaimedSession(): RemoteSession | undefined {
  for (const [, s] of sessionsById) {
    if (!s.helloReceived) return s;
  }
  return undefined;
}

server.listen(3000, () => {
  console.log("Hypen SSE on http://localhost:3000/hypen/stream (GET)");
  console.log("           http://localhost:3000/hypen/send   (POST)");
});
