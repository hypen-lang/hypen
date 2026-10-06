/**
 * Resume credential (#12, RFC 001 §5 / Phase S): the public session id alone
 * never resumes — or, under kick-old, takes over — a session that negotiated
 * a device plane. `sessionAck.resumeToken` (≥128-bit, base64url, rotated per
 * acknowledged connection) is issued in EVERY ack and must be presented as
 * `hello.resumeToken` to resume a device session; otherwise the hello starts
 * a NEW session. A UI-only session (no device plane negotiated — a legacy
 * client, or a server with `disableDevice()`) keeps the legacy id-only
 * resume.
 */

import { describe, expect, test } from "bun:test";
import { app } from "../packages/core/src/app";
import { RemoteSession, SessionManager, type SessionHost } from "@hypen-space/core/remote";
import { deviceHello, flush, makeHost, makeTransport } from "./device-srv-harness";

function world(opts: { deviceDisabled?: boolean } = {}) {
  const sessionManager = new SessionManager({ concurrent: "kick-old" });
  const module = app.defineState({ n: 0 }).build() as unknown as SessionHost["module"];
  const live: RemoteSession[] = [];
  const host: SessionHost = {
    ...makeHost(module, { deviceDisabled: opts.deviceDisabled, sessionManager }),
    sessionsForId: (id: string) => live.filter((s) => s.sessionId === id && !s.isDestroyed),
  };
  const connect = async (hello: Record<string, unknown>) => {
    const t = makeTransport();
    const session = new RemoteSession(host, t.transport, { helloGraceMs: null });
    live.push(session);
    await session.receive(JSON.stringify(hello));
    await session.ready;
    await flush();
    const ack = t.ui.find((m) => m.type === "sessionAck") as any;
    return { ...t, session, ack };
  };
  return { connect, sessionManager };
}

const BASE64URL_128 = /^[A-Za-z0-9_-]{22,}$/;

describe("device session (device plane negotiated)", () => {
  test("sessionAck carries a random base64url resumeToken distinct from the session id", async () => {
    const w = world();
    const a = await w.connect(deviceHello());
    const b = await w.connect(deviceHello());
    expect(a.ack.resumeToken).toMatch(BASE64URL_128);
    expect(a.ack.resumeToken).not.toBe(a.ack.sessionId);
    expect(a.ack.resumeToken).not.toBe(b.ack.resumeToken);
    // Legacy (no device extension) clients on this server get one too.
    const legacy = await w.connect({ type: "hello" });
    expect(legacy.ack.resumeToken).toMatch(BASE64URL_128);
    for (const s of [a, b, legacy]) await s.session.destroy();
  });

  test("resume with the matching token restores the session and rotates the token", async () => {
    const w = world();
    const a = await w.connect(deviceHello());
    await a.session.destroy(); // suspended, resumable
    const b = await w.connect(deviceHello([], { sessionId: a.ack.sessionId, resumeToken: a.ack.resumeToken }));
    expect(b.ack).toMatchObject({ sessionId: a.ack.sessionId, isNew: false, isRestored: true });
    expect(b.ack.resumeToken).toMatch(BASE64URL_128);
    expect(b.ack.resumeToken).not.toBe(a.ack.resumeToken);
    await b.session.destroy();

    // The rotated-out token no longer works.
    const c = await w.connect(deviceHello([], { sessionId: a.ack.sessionId, resumeToken: a.ack.resumeToken }));
    expect(c.ack.isNew).toBe(true);
    expect(c.ack.sessionId).not.toBe(a.ack.sessionId);
    await c.session.destroy();
  });

  for (const [name, token] of [
    ["missing token", undefined],
    ["wrong token", "A".repeat(43)],
    ["wrong length", "abc"],
    ["non-string token", 12345],
  ] as const) {
    test(`${name} ⇒ a NEW session, never a resume`, async () => {
      const w = world();
      const a = await w.connect(deviceHello());
      await a.session.destroy();
      const hello: Record<string, unknown> = { sessionId: a.ack.sessionId };
      if (token !== undefined) hello.resumeToken = token;
      const b = await w.connect(deviceHello(undefined, hello));
      expect(b.ack.isNew).toBe(true);
      expect(b.ack.isRestored).toBe(false);
      expect(b.ack.sessionId).not.toBe(a.ack.sessionId);
      await b.session.destroy();
    });
  }

  test("kick-old cannot be triggered by the public id alone: the live session survives", async () => {
    const w = world();
    const victim = await w.connect(deviceHello());
    const attacker = await w.connect(deviceHello(undefined, { sessionId: victim.ack.sessionId }));
    expect(attacker.ack.sessionId).not.toBe(victim.ack.sessionId);
    expect(victim.closes).toEqual([]);
    expect(victim.ui.some((m) => m.type === "sessionExpired")).toBe(false);
    expect(victim.session.deviceBroker).not.toBeNull();
    // The token holder can still take over its own session (kick-old).
    const owner = await w.connect(
      deviceHello(undefined, { sessionId: victim.ack.sessionId, resumeToken: victim.ack.resumeToken })
    );
    expect(owner.ack).toMatchObject({ sessionId: victim.ack.sessionId, isNew: false });
    expect(victim.ui.some((m) => m.type === "sessionExpired")).toBe(true);
    for (const s of [victim, attacker, owner]) await s.session.destroy();
  });

  test("tokens are forgotten when the session is destroyed", async () => {
    const w = world();
    const a = await w.connect(deviceHello());
    expect(w.sessionManager.verifyResumeToken(a.ack.sessionId, a.ack.resumeToken)).toBe(true);
    w.sessionManager.destroySession(a.ack.sessionId);
    expect(w.sessionManager.verifyResumeToken(a.ack.sessionId, a.ack.resumeToken)).toBe(false);
    await a.session.destroy();
  });
});

describe("UI-only session (no device plane negotiated): legacy id-only resume", () => {
  test("on a device-capable server, a legacy client's session resumes by id without a token", async () => {
    const w = world();
    const a = await w.connect({ type: "hello" });
    expect(a.ack.device).toBeUndefined();
    // The token is always issued; a UI-only session just does not need it.
    expect(a.ack.resumeToken).toMatch(BASE64URL_128);
    await a.session.destroy();
    const b = await w.connect({ type: "hello", sessionId: a.ack.sessionId });
    expect(b.ack).toMatchObject({ sessionId: a.ack.sessionId, isNew: false, isRestored: true });
    expect(b.ack.resumeToken).toMatch(BASE64URL_128);
    await b.session.destroy();
  });

  test("same server: the UI-only session resumes by id while the device session needs its token", async () => {
    const w = world();
    const ui = await w.connect({ type: "hello" });
    const dev = await w.connect(deviceHello());
    expect(dev.ack.device).toBeDefined();
    await ui.session.destroy();
    await dev.session.destroy();

    const uiBack = await w.connect({ type: "hello", sessionId: ui.ack.sessionId });
    expect(uiBack.ack).toMatchObject({ sessionId: ui.ack.sessionId, isNew: false, isRestored: true });

    const devNoToken = await w.connect(deviceHello(undefined, { sessionId: dev.ack.sessionId }));
    expect(devNoToken.ack.isNew).toBe(true);
    expect(devNoToken.ack.sessionId).not.toBe(dev.ack.sessionId);
    // A legacy (device-less) hello cannot reach the device session by id either.
    const legacyNoToken = await w.connect({ type: "hello", sessionId: dev.ack.sessionId });
    expect(legacyNoToken.ack.isNew).toBe(true);
    expect(legacyNoToken.ack.sessionId).not.toBe(dev.ack.sessionId);

    const devBack = await w.connect(
      deviceHello(undefined, { sessionId: dev.ack.sessionId, resumeToken: dev.ack.resumeToken })
    );
    expect(devBack.ack).toMatchObject({ sessionId: dev.ack.sessionId, isNew: false, isRestored: true });
    for (const s of [uiBack, devNoToken, legacyNoToken, devBack]) await s.session.destroy();
  });

  test("disableDevice host: token issued, the session id alone resumes", async () => {
    const w = world({ deviceDisabled: true });
    const a = await w.connect(deviceHello());
    expect(a.ack.device).toBeUndefined();
    expect(a.ack.resumeToken).toMatch(BASE64URL_128);
    await a.session.destroy();
    const b = await w.connect({ type: "hello", sessionId: a.ack.sessionId });
    expect(b.ack).toMatchObject({ sessionId: a.ack.sessionId, isNew: false, isRestored: true });
    await b.session.destroy();
  });
});
