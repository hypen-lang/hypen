/**
 * Lease cadence (#5, RFC 001 §2.7; Swift review #4): the server renews on a
 * fixed 5 s cadence keyed to its last renewal SEND. Previously the gate was
 * keyed to the client's ack arrival, so any RTT pushed renewals to every
 * 10 s and left a healthy request 5 s from a client-side lease expiry.
 *
 * Runs against the Rust broker (through the port) driven by a DevicePlane
 * with a fake clock: the plane re-arms its one timer from the broker's next
 * deadline, so renewals land exactly on the broker's schedule. The u32
 * renewal-sequence bound (the broker terminates before `renewLease` would
 * wrap) needs 2^32 renewals and is pinned in Rust
 * (`device::broker::tests::renew_lease_sequence_never_wraps`).
 */

import { describe, expect, test } from "bun:test";
import { makePlane, spec } from "./device-srv-harness";

/** A broker whose client acks every renewal after `rttMs`, via the clock. */
function withAckingClient(rttMs: number, opts: { ack?: (seq: number) => boolean } = {}) {
  const h = makePlane();
  const renewals: Array<{ id: number; seq: number; at: number }> = [];
  const pendingAcks: Array<{ seq: number; due: number; id: number }> = [];
  let seen = 0;
  /** Record renewals the broker sent since the last look (at send time). */
  const observe = () => {
    for (; seen < h.sent.length; seen++) {
      const m = h.sent[seen];
      if (m.type === "deviceEvent" && m.control && "renewLease" in m.control) {
        renewals.push({ id: m.id, seq: m.control.renewLease, at: h.clock.now() });
        // The control stream is always acknowledged (a dead control stream
        // would close the whole plane); the request under test per `ack`.
        if (m.id === h.core || (opts.ack?.(m.control.renewLease) ?? true)) {
          pendingAcks.push({ seq: m.control.renewLease, due: h.clock.now() + rttMs, id: m.id });
        }
      }
    }
  };
  const req = h.plane.open(spec("permission.request", { permission: "camera" }));
  observe();
  /** Advance in 10 ms steps, delivering acks when their RTT elapses. */
  const run = (ms: number) => {
    for (let t = 0; t < ms; t += 10) {
      h.clock.advance(10);
      observe();
      for (const a of [...pendingAcks]) {
        if (a.due <= h.clock.now()) {
          pendingAcks.splice(pendingAcks.indexOf(a), 1);
          h.receive({ type: "deviceEvent", id: a.id, control: { leaseAck: a.seq } });
        }
      }
    }
  };
  const of = () => renewals.filter((r) => r.id === req.id);
  return { ...h, renewals: of, run, req };
}

describe("renewal cadence", () => {
  test("renewLease 1 goes out with the request; handler ids start after core.capabilities", () => {
    const { sent, req, core } = withAckingClient(50);
    expect(core).toBe(1);
    expect(req.id).toBe(2);
    const own = sent.filter((m) => m.id === req.id);
    expect(own[0]).toMatchObject({ type: "deviceRequest", capability: "permission.request" });
    expect(own[1]).toEqual({ type: "deviceEvent", id: req.id, control: { renewLease: 1 } });
  });

  test("with 50 ms RTT, renewals go out at 0, 5, 10, 15, 20 s — not every 10 s", () => {
    const { renewals, run, plane, req } = withAckingClient(50);
    run(20_000);
    expect(renewals().map((r) => r.at)).toEqual([0, 5_000, 10_000, 15_000, 20_000]);
    expect(renewals().map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(plane.isLive(req.id!)).toBe(true);
  });

  test("a 4 s RTT still gets a fresh renewal every 5 s and stays live for a minute", () => {
    const { renewals, run, plane, req } = withAckingClient(4_000);
    run(60_000);
    const list = renewals();
    const gaps = list.slice(1).map((r, i) => r.at - list[i]!.at);
    expect(gaps.length).toBeGreaterThan(10);
    expect(gaps.every((g) => g === 5_000)).toBe(true);
    expect(plane.isLive(req.id!)).toBe(true);
  });

  test("with no acks at all: renewals at 0/5/10 s, expiry checked before the 15 s renewal", async () => {
    const { renewals, run, req, closes } = withAckingClient(50, { ack: () => false });
    run(20_000);
    // Expiry is evaluated before renewing, so no seq 4 is sent to a lost peer.
    expect(renewals().map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(await req.settled).toEqual({ error: { code: "connectionLost" } });
    // An ordinary request's lease failure never touches the connection.
    expect(closes).toEqual([]);
  });

  test("15 s without ack progress expires even while renewals keep flowing", async () => {
    // Only seq 1 is ever acknowledged.
    const { run, req } = withAckingClient(50, { ack: (seq) => seq === 1 });
    run(14_000);
    expect(await Promise.race([req.settled, Promise.resolve("live")])).toBe("live");
    run(3_000);
    expect(await req.settled).toEqual({ error: { code: "connectionLost" } });
  });
});
