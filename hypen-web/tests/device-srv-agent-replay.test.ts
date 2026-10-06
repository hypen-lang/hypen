/**
 * syncActions keeps the device plane on (RFC 001 §1.7), so EVERY path that
 * mirrors a dispatch onto another session must run it with replay provenance.
 * `RemoteSession`'s click fan-out does (device-session.test.ts); this pins the
 * agent handle's mirror: the user's own dispatch runs as origin, each
 * sibling's copy inside `runReplayed`.
 */

import { describe, expect, test } from "bun:test";
import { AgentHandle } from "../packages/server/src/remote/agent-handle";
import type { RemoteSession, SessionHost } from "../packages/core/src/remote/remote-session";

function fakeSession(id: string, log: Array<{ session: string; replayed: boolean }>) {
  let depth = 0;
  return {
    sessionId: id,
    isReady: true,
    isDestroyed: false,
    helloReceived: true,
    engine: {
      dispatchExternal: () => log.push({ session: id, replayed: depth > 0 }),
    },
    moduleInstance: {
      runReplayed<R>(fn: () => R): R {
        depth += 1;
        try {
          return fn();
        } finally {
          depth -= 1;
        }
      },
    },
  };
}

describe("agent handle under syncActions", () => {
  test("the user's dispatch is origin; every mirrored copy runs with replay provenance", () => {
    const log: Array<{ session: string; replayed: boolean }> = [];
    const a = fakeSession("a", log);
    const b = fakeSession("b", log);
    const c = fakeSession("c", log);
    const all = [a, b, c];
    const host = {
      syncActions: true,
      *otherSessions(self: unknown) {
        for (const s of all) if (s !== self) yield s;
      },
    } as unknown as SessionHost;
    const handle = new AgentHandle(a as unknown as RemoteSession, host);
    handle.dispatch("addToCart");
    expect(log).toEqual([
      { session: "a", replayed: false },
      { session: "b", replayed: true },
      { session: "c", replayed: true },
    ]);
  });
});
