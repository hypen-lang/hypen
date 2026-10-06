/**
 * Bulk scheduling: cancellation while a turn is mid-flight (RFC 001 §2.3 "a
 * cancellation may discard queued bytes"). A cancel issued from inside the
 * transport write of the running turn — e.g. a cancel that the write itself
 * triggered — must drop exactly that request's remaining frames (also the
 * ones already taken for this turn), keep round-robin over the others, and
 * keep the queued-bytes accounting. The scheduler is the Rust broker's; the
 * DevicePlane discards a turn's frames of a request that is no longer live.
 */

import { describe, expect, test } from "bun:test";
import { sha256Hex } from "@hypen-space/core/remote/device";
import { makePlane, spec } from "./device-srv-harness";

const idOf = (f: Uint8Array) => new DataView(f.buffer, f.byteOffset).getUint32(4, true);

async function downloads(n: number, opts: Parameters<typeof makePlane>[0] = {}) {
  const h = makePlane(opts);
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const data = new Uint8Array(300).fill(i);
    const params = { channel: 0, name: `f${i}`, contentType: "a/b", bytes: 300, sha256: await sha256Hex(data) };
    const r = h.plane.open(spec("file.save", params, { download: data }));
    ids.push(r.id!);
  }
  const grant = (id: number, n: number) => h.receive({ type: "deviceEvent", id, control: { grant: n } });
  return { ...h, ids, grant };
}

describe("discard mid-turn", () => {
  test("cancelling the running request and a peer from inside the frame write", async () => {
    const sent: number[] = [];
    let cancelled = false;
    let plane!: ReturnType<typeof makePlane>["plane"];
    let ids: number[] = [];
    const io = { buffered: 300 * 1024 };
    const h = await downloads(3, {
      config: { scheduler: { turnBytes: 1_000_000 } },
      bufferedAmount: () => io.buffered,
      onFrameOut: (f) => {
        const id = idOf(f);
        sent.push(id);
        if (id === ids[0] && !cancelled) {
          cancelled = true;
          plane.cancel(ids[0]!); // cancel of the request being written
          plane.cancel(ids[1]!); // and of a peer queued behind it
        }
      },
    });
    plane = h.plane;
    ids = h.ids;
    // Queue three 100-byte frames per request while the socket is saturated.
    for (let s = 0; s < 3; s++) for (const id of ids) h.grant(id, 100);
    expect(h.plane.info()!.queuedBulkBytes).toBe(9 * 112);
    io.buffered = 0;
    h.clock.advance(10); // one large turn takes every queued frame
    await new Promise((r) => setTimeout(r, 0));
    expect(sent.filter((x) => x === ids[0])).toEqual([ids[0]]);
    expect(sent.filter((x) => x === ids[1])).toEqual([]);
    expect(sent.filter((x) => x === ids[2])).toEqual([ids[2], ids[2], ids[2]]);
    expect(h.plane.info()!.queuedBulkBytes).toBe(0);
    expect(await h.plane.isLive(ids[2]!)).toBe(true);
  });

  test("cancel between turns of a saturated transport resumes cleanly for the rest", async () => {
    const io = { buffered: 300 * 1024 }; // saturated
    const h = await downloads(2, { bufferedAmount: () => io.buffered, config: { scheduler: { retryMs: 1 } } });
    h.grant(h.ids[0]!, 100);
    h.grant(h.ids[1]!, 100);
    for (let i = 0; i < 5; i++) h.clock.advance(1); // retries only: nothing handed while ≥ 256 KiB is pending
    expect(h.frames).toEqual([]);
    h.plane.cancel(h.ids[0]!);
    io.buffered = 0;
    h.clock.advance(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.frames.map(idOf)).toEqual([h.ids[1]]);
    expect(h.plane.info()!.queuedBulkBytes).toBe(0);
  });
});
