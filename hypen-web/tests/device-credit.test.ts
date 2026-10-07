/**
 * Device Capability Protocol — upload credit, both ends (RFC 001 §2.3/§2.4).
 *
 * Client (`DeviceClient`): balance starts at the request's `initialCredit`,
 * each frame spends its payload length, the runtime never sends beyond the
 * balance, pauses once at zero and resumes on an additive `control.grant`.
 *
 * Server (`DeviceBroker`): frames must follow a `blobStart`, stay within the
 * declaration, the revision's item cap and the outstanding credit; channel
 * count is bounded; violations cancel + settle `invalidParams`; accepted
 * bytes are replenished without exceeding `max_outstanding_credit`.
 *
 * Also pins the TS registry table to the Rust reference by parsing
 * hypen-engine-rs/src/serialize/device.rs.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEVICE_REGISTRY,
  DeviceContext,
  decodeFrame,
  encodeFrame,
  validateCapabilityPayload,
  validateDeviceMessage,
  type DeviceDriver,
  type DeviceEvent,
  type DeviceRequest,
  type DeviceResponse,
} from "@hypen-space/core/remote/device";
import { DeviceClient } from "@hypen-space/core/remote/device";
import { loopback, makePlane, spec, type PlaneHarnessOptions } from "./device-srv-harness";

// ---------------------------------------------------------------------------
// helpers

const owner = { moduleInstanceId: "m1", activationId: 1 };
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
async function ticks(n: number) {
  for (let i = 0; i < n; i++) await tick();
}

/** The Rust broker through the port (plane + fake clock). */
function makeBroker(opts: PlaneHarnessOptions = {}) {
  return makePlane(opts);
}

const openUpload = (h: ReturnType<typeof makeBroker>, initialCredit: number, capability = "gallery.pick") =>
  h.plane.open(
    // maxCount bounds the channels a request may allocate (§2.3); 16 lets
    // the item-cap test reach the revision's maxItems.
    spec(capability, { mediaTypes: ["photo"], maxCount: 16 }, { initialCredit, timeoutMs: 300_000 })
  );

const blobStart = (id: number | null, channel: number, bytes: number, contentType = "image/jpeg") =>
  ({ type: "deviceEvent", id, event: { kind: "blobStart", channel, contentType, bytes } }) as const;

const frame = (id: number | null, channel: number, seq: number, len: number, fill = 7) =>
  encodeFrame({ version: 1, flags: 0, channel, requestId: id!, seq }, new Uint8Array(len).fill(fill));

const cancels = (sent: any[], id: number | null) =>
  sent.filter((m) => m.type === "deviceEvent" && m.id === id && m.control && "cancel" in m.control);

const grants = (sent: any[], id: number | null) =>
  sent.filter((m) => m.type === "deviceEvent" && m.id === id && m.control && "grant" in m.control).map((m) => m.control.grant as number);

function uploadRequest(id: number, initialCredit: number): DeviceRequest {
  return {
    type: "deviceRequest",
    id,
    capability: "gallery.pick",
    version: 1,
    owner: { moduleInstanceId: "m1", activationId: 1 },
    lifetime: "activation",
    timeoutMs: 300_000,
    initialCredit,
    params: { mediaTypes: ["photo"], maxCount: 1 },
  };
}

// ---------------------------------------------------------------------------

describe("registry table mirrors the Rust reference", () => {
  test("every capability revision bound matches hypen-engine-rs registry()", () => {
    const src = readFileSync(
      join(import.meta.dir, "../../hypen-engine-rs/src/serialize/device.rs"),
      "utf8"
    );
    const consts: Record<string, number> = {};
    for (const m of src.matchAll(/^const (KIB|MIB): u64 = ([^;]+);/gm)) {
      consts[m[1]!] = evalExpr(m[2]!, consts);
    }
    const lifetimeSets: Record<string, string[]> = {};
    for (const m of src.matchAll(/^const (\w+): &\[Lifetime\] = &\[([^\]]*)\];/gm)) {
      lifetimeSets[m[1]!] = [...m[2]!.matchAll(/Lifetime::(\w+)/g)].map((x) => camel(x[1]!));
    }
    const body = src.slice(src.indexOf("pub fn registry()"), src.indexOf("pub fn find_revision"));
    const decls = body.split("CapabilityDecl {").slice(1);
    const parsed = new Map<string, Record<string, unknown>>();
    for (const decl of decls) {
      const name = /name: "([^"]+)"/.exec(decl)![1]!;
      const field = (f: string) => new RegExp(`\\b${f}: ([^,\\n]+),`).exec(decl)![1]!.trim();
      parsed.set(name, {
        version: Number(field("version")),
        mode: camel(field("mode").replace("Mode::", "")),
        data: camel(field("data").replace("DataPlane::", "")),
        consent: camel(field("consent").replace("Consent::", "")),
        overflow: camel(field("overflow").replace("Overflow::", "")),
        lifetimes: lifetimeSets[field("lifetimes")],
        maxItemBytes: evalExpr(field("max_item_bytes"), consts),
        maxItems: evalExpr(field("max_items"), consts),
        maxInitialCredit: evalExpr(field("max_initial_credit"), consts),
        maxOutstandingCredit: evalExpr(field("max_outstanding_credit"), consts),
        maxTimeoutMs: evalExpr(field("max_timeout_ms"), consts),
      });
      // Each decl has exactly one revision in v1; a second would need the
      // table (and this parser) extended.
      expect(decl.split("CapabilityRevision {").length - 1).toBe(1);
    }
    expect([...parsed.keys()].sort()).toEqual([...DEVICE_REGISTRY.keys()].sort());
    for (const [name, rust] of parsed) {
      const ts = DEVICE_REGISTRY.get(name)!;
      expect(ts.length).toBe(1);
      expect({ ...ts[0]!, lifetimes: [...ts[0]!.lifetimes] }).toEqual(rust as never);
    }
  });
});

function camel(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}
function evalExpr(expr: string, consts: Record<string, number>): number {
  return expr
    .replace(/\/\/.*$/, "")
    .split("*")
    .map((t) => t.trim().replace(/_/g, ""))
    .reduce((acc, t) => acc * (t in consts ? consts[t]! : Number(t)), 1);
}

describe("client runtime: credit-paced upload", () => {
  test("pauses at zero credit (paused:true once), resumes on grant (paused:false), never exceeds balance", async () => {
    const photo = new Uint8Array(100 * 1024).map((_, i) => i & 0xff);
    const sent: Array<DeviceResponse | DeviceEvent> = [];
    const frames: Uint8Array[] = [];
    const driver: DeviceDriver = async () => ({
      kind: "result",
      result: {},
      blobs: [{ channel: 0, contentType: "image/jpeg", bytes: photo }],
    });
    const client = new DeviceClient(
      { sendMessage: (m) => sent.push(m), sendBinary: (f) => frames.push(f) },
      new Map([["gallery.pick", driver]])
    );
    const paused = () =>
      sent
        .filter((m) => m.type === "deviceEvent" && m.control && "paused" in m.control)
        .map((m) => (m as DeviceEvent).control as { paused: boolean });

    client.handleMessage(uploadRequest(1, 0));
    await ticks(5);
    // Zero initial credit: announcement goes out, but no bytes.
    expect(sent.some((m) => m.type === "deviceEvent" && (m.event as { kind?: string })?.kind === "blobStart")).toBe(true);
    expect(frames.length).toBe(0);
    expect(paused()).toEqual([{ paused: true }]);

    // Grant 40 KiB: exactly 40 KiB of payload may flow, then pause again.
    client.handleMessage({ type: "deviceEvent", id: 1, control: { grant: 40 * 1024 } });
    await ticks(5);
    const sum = () => frames.reduce((n, f) => {
      const d = decodeFrame(f);
      return n + (d.ok ? d.payload.byteLength : 0);
    }, 0);
    expect(sum()).toBe(40 * 1024);
    expect(paused()).toEqual([{ paused: true }, { paused: false }, { paused: true }]);
    expect(sent.some((m) => m.type === "deviceResponse")).toBe(false);

    // Additive grant covering the rest completes the transfer.
    client.handleMessage({ type: "deviceEvent", id: 1, control: { grant: 100 * 1024 } });
    await ticks(10);
    expect(sum()).toBe(photo.byteLength);
    expect(paused().at(-1)).toEqual({ paused: false });
    // Frames are ≤ 64 KiB, contiguous seq.
    const seqs = frames.map((f) => (decodeFrame(f) as { header: { seq: number } }).header.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i));
    for (const f of frames) expect(f.byteLength - 12).toBeLessThanOrEqual(64 * 1024);
    const res = sent.find((m): m is DeviceResponse => m.type === "deviceResponse")!;
    expect((res.result as { items: Array<{ bytes: number }> }).items[0]!.bytes).toBe(photo.byteLength);
  });

  test("a grant overflowing the revision's max outstanding credit terminates invalidParams", async () => {
    const sent: Array<DeviceResponse | DeviceEvent> = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const driver: DeviceDriver = async () => {
      await gate;
      return { kind: "result", result: {}, blobs: [{ channel: 0, contentType: "image/jpeg", bytes: new Uint8Array(4) }] };
    };
    const client = new DeviceClient(
      { sendMessage: (m) => sent.push(m), sendBinary: () => {} },
      new Map([["gallery.pick", driver]])
    );
    client.handleMessage(uploadRequest(1, 1024));
    client.handleMessage({ type: "deviceEvent", id: 1, control: { grant: 16 * 1024 * 1024 } });
    release();
    await ticks(3);
    const res = sent.filter((m): m is DeviceResponse => m.type === "deviceResponse");
    expect(res.length).toBe(1);
    expect(res[0]!.error?.code).toBe("invalidParams");
  });
});

describe("broker: upload credit and declaration enforcement", () => {
  test("frame beyond outstanding credit → invalidParams + cancel, buffered data discarded", async () => {
    const h = makeBroker();
    const r = openUpload(h, 10);
    h.receive(blobStart(r.id, 0, 100));
    expect(h.plane.receiveFrame(frame(r.id, 0, 0, 20))).toBe(false);
    const s = await r.settled;
    expect("error" in s && s.error.code).toBe("invalidParams");
    expect("error" in s && s.error.platformDetail).toMatch(/credit/);
    expect(cancels(h.sent, r.id).length).toBe(1);
    expect(h.plane.isLive(r.id!)).toBe(false);
    expect(h.plane.retainedBytes).toBe(0);
  });

  test("frame beyond the blobStart declaration → invalidParams + cancel", async () => {
    const h = makeBroker();
    const r = openUpload(h, 1000);
    h.receive(blobStart(r.id, 0, 10));
    expect(h.plane.receiveFrame(frame(r.id, 0, 0, 8))).toBe(true);
    expect(h.plane.receiveFrame(frame(r.id, 0, 1, 8))).toBe(false);
    const s = await r.settled;
    expect("error" in s && s.error).toMatchObject({ code: "invalidParams", platformDetail: expect.stringMatching(/declared/) });
    expect(cancels(h.sent, r.id).length).toBe(1);
  });

  test("frame before blobStart → invalidParams + cancel, no storage", async () => {
    const h = makeBroker();
    const r = openUpload(h, 1000);
    expect(h.plane.receiveFrame(frame(r.id, 0, 0, 8))).toBe(false);
    const s = await r.settled;
    expect("error" in s && s.error).toMatchObject({ code: "invalidParams", platformDetail: expect.stringMatching(/before blobStart/) });
    expect(cancels(h.sent, r.id).length).toBe(1);
    expect(h.plane.retainedBytes).toBe(0);
  });

  test("more channels than max_items → invalidParams + cancel", async () => {
    const h = makeBroker();
    const r = openUpload(h, 1000);
    const max = DEVICE_REGISTRY.get("gallery.pick")![0]!.maxItems;
    for (let c = 0; c < max; c++) h.receive(blobStart(r.id, c, 1));
    expect(h.plane.isLive(r.id!)).toBe(true);
    h.receive(blobStart(r.id, max, 1));
    const s = await r.settled;
    // Rejected by the revision's event schema (channel ≤ maxItems-1) or the
    // broker's item cap — either way before any sink exists.
    expect("error" in s && s.error.code).toBe("invalidParams");
    expect(cancels(h.sent, r.id).length).toBe(1);
  });

  test("oversize declaration (> max_item_bytes) is rejected before allocating", async () => {
    const h = makeBroker();
    const r = openUpload(h, 1000);
    h.receive(blobStart(r.id, 0, 64 * 1024 * 1024 + 1));
    const s = await r.settled;
    expect("error" in s && s.error).toMatchObject({ code: "invalidParams", platformDetail: expect.stringMatching(/max.item.bytes/) });
    expect(h.plane.retainedBytes).toBe(0);
  });

  test("duplicate channel and seq gap are violations", async () => {
    const a = makeBroker();
    const h1 = openUpload(a, 1000);
    a.receive(blobStart(h1.id, 0, 10));
    a.receive(blobStart(h1.id, 0, 10));
    expect(await h1.settled).toMatchObject({ error: { code: "invalidParams" } });

    const b = makeBroker();
    const h2 = openUpload(b, 1000);
    b.receive(blobStart(h2.id, 0, 10));
    expect(b.plane.receiveFrame(frame(h2.id, 0, 1, 4))).toBe(false); // seq 0 skipped
    expect(await h2.settled).toMatchObject({ error: { code: "invalidParams", platformDetail: expect.stringMatching(/seq/) } });
  });

  test("blobStart / frames on a capability without an upload plane are violations", async () => {
    const h = makeBroker();
    const r = h.plane.open(spec("permission.request", { permission: "camera" }, { timeoutMs: 30_000 }));
    h.receive(blobStart(r.id, 0, 4));
    expect(await r.settled).toMatchObject({ error: { code: "invalidParams" } });
  });

  test("replenishment is batched (half the window per grant); outstanding never exceeds max_outstanding_credit", async () => {
    const h = makeBroker({
      config: { revisionOverrides: [{ capability: "gallery.pick", version: 1, maxOutstandingCredit: 100 }] },
    });
    // A sender-side overshoot of the bound (150 > 100) must not be topped up;
    // replenishment waits until half the initial window (75) was consumed.
    // The initial credit is clamped to max_initial_credit (4 MiB), not the
    // outstanding bound.
    const r = openUpload(h, 150);
    h.receive(blobStart(r.id, 0, 10_000));
    expect(h.plane.receiveFrame(frame(r.id, 0, 0, 30))).toBe(true);
    expect(h.plane.receiveFrame(frame(r.id, 0, 1, 30))).toBe(true);
    expect(grants(h.sent, r.id)).toEqual([]); // 60 consumed < 75: no grant yet
    expect(h.plane.outstandingCredit(r.id!)).toBe(90);
    for (let seq = 2; seq < 12; seq++) {
      expect(h.plane.receiveFrame(frame(r.id, 0, seq, 50))).toBe(true);
      expect(h.plane.outstandingCredit(r.id!)!).toBeLessThanOrEqual(100);
      expect(h.plane.outstandingCredit(r.id!)!).toBeGreaterThan(0); // never starved
    }
    // 12 frames, 5 grants: the first tops up to exactly 100 (60 of 110
    // consumed), then one 100-byte grant per two 50-byte frames.
    expect(grants(h.sent, r.id)).toEqual([60, 100, 100, 100, 100]);
    r.cancel();
  });

  test("grant from the client on an upload request is a wrong-direction violation", async () => {
    const h = makeBroker();
    const r = openUpload(h, 1000);
    h.receive({ type: "deviceEvent", id: r.id, control: { grant: 10 } });
    expect(await r.settled).toMatchObject({ error: { code: "invalidParams" } });
  });

  test("terminal result whose items differ from blobStart declarations → invalidParams", async () => {
    const h = makeBroker();
    const r = openUpload(h, 1000);
    h.receive(blobStart(r.id, 0, 4));
    h.plane.receiveFrame(frame(r.id, 0, 0, 4));
    h.receive({
      type: "deviceResponse",
      id: r.id,
      result: { items: [{ channel: 0, contentType: "image/png", bytes: 4, sha256: "0".repeat(64) }] },
    });
    expect(await r.settled).toMatchObject({ error: { code: "invalidParams" } });
  });
});

describe("end-to-end: credit replenishment carries a transfer larger than the initial budget", () => {
  test("300 KiB upload with 64 KiB initial credit completes and verifies", async () => {
    const photo = new Uint8Array(300 * 1024).map((_, i) => (i * 31) & 0xff);
    const h = loopback(
      (t) =>
        new DeviceClient(
          t,
          new Map<string, DeviceDriver>([
            ["gallery.pick", async () => ({ kind: "result", result: {}, blobs: [{ channel: 0, contentType: "image/jpeg", bytes: photo }] })],
          ])
        )
    );
    const ctx = new DeviceContext(h.plane, owner, "origin");
    const res = await ctx.request("gallery.pick", { mediaTypes: ["photo"], maxCount: 1 }, { initialCredit: 64 * 1024 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.items[0]!.bytes).toEqual(photo);
    // More than the initial budget flowed: the broker granted along the way.
    expect(grants(h.sent, h.sent.find((m) => m.capability === "gallery.pick")!.id).length).toBeGreaterThan(0);
  });

  test("DeviceContext clamps initialCredit to the revision and defaults uploads to 256 KiB", () => {
    const h = makeBroker();
    const ctx = new DeviceContext(h.plane, owner, "origin");
    void ctx.request("gallery.pick", { mediaTypes: ["photo"], maxCount: 1 });
    void ctx.request("gallery.pick", { mediaTypes: ["photo"], maxCount: 1 }, { initialCredit: 1 << 30 });
    void ctx.request("permission.query", { permission: "camera" }, { initialCredit: 99 });
    const reqs = h.sent.filter((m): m is DeviceRequest => m.type === "deviceRequest" && m.capability !== "core.capabilities");
    expect(reqs.map((r) => r.initialCredit)).toEqual([256 * 1024, 4 * 1024 * 1024, 0]);
    // timeoutMs clamps to the revision's max_timeout_ms (permission.query: 30s).
    expect(reqs[2]!.timeoutMs).toBe(30_000);
    h.plane.close();
  });

  test("an explicit initialCredit below 1 on an upload is refused locally (nothing sent)", async () => {
    const h = makeBroker();
    const before = h.sent.length;
    const ctx = new DeviceContext(h.plane, owner, "origin");
    for (const bad of [0, -5, Number.NaN]) {
      const res = await ctx.request("gallery.pick", { mediaTypes: ["photo"], maxCount: 1 }, { initialCredit: bad });
      expect(res).toMatchObject({ ok: false, error: { code: "invalidParams" } });
    }
    expect(h.sent.length).toBe(before);
  });
});

describe("file.pick: names ride on result items", () => {
  test("named driver blobs → wire result validates against file.pick v1; handler sees names", async () => {
    const a = new TextEncoder().encode("alpha");
    const b = new TextEncoder().encode("beta!");
    const h = loopback(
      (t) =>
        new DeviceClient(
          t,
          new Map<string, DeviceDriver>([
            [
              "file.pick",
              async () => ({
                kind: "result",
                result: {},
                blobs: [
                  { channel: 0, name: "a.pdf", contentType: "application/pdf", bytes: a },
                  { channel: 1, name: "b.txt", contentType: "text/plain", bytes: b },
                ],
              }),
            ],
          ])
        )
    );
    const ctx = new DeviceContext(h.plane, owner, "origin");
    const res = await ctx.request("file.pick", { accept: ["*/*"], maxCount: 2 });

    // Wire: every message is envelope-valid (blobStart stays closed, no name)
    // and the terminal result — with sha256 — validates against file.pick v1.
    const wire = h.clientSent.filter((m): m is DeviceResponse | DeviceEvent => !(m instanceof Uint8Array));
    for (const m of wire) expect(validateDeviceMessage(m)).toEqual([]);
    const terminal = wire.find((m): m is DeviceResponse => m.type === "deviceResponse")!;
    expect(validateCapabilityPayload("file.pick", 1, "result", terminal.result)).toEqual([]);
    const starts = wire.filter((m) => m.type === "deviceEvent" && (m.event as { kind?: string })?.kind === "blobStart");
    for (const s of starts) expect("name" in (s as DeviceEvent).event!).toBe(false);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.items.map((i) => i.name)).toEqual(["a.pdf", "b.txt"]);
    expect(new TextDecoder().decode(res.value.items[1]!.bytes)).toBe("beta!");
  });
});

describe("revoke propagation", () => {
  test("a client `revoked` response settles the handler with an ordinary revoked value", async () => {
    const h = loopback(
      (t) =>
        new DeviceClient(
          t,
          new Map<string, DeviceDriver>([
            ["gallery.pick", async () => ({ kind: "error", code: "revoked", platformDetail: "permission-revoked" })],
          ])
        )
    );
    const ctx = new DeviceContext(h.plane, owner, "origin");
    const res = await ctx.request("gallery.pick", { mediaTypes: ["photo"], maxCount: 1 });
    expect(res).toEqual({ ok: false, error: { code: "revoked", platformDetail: "permission-revoked" } });
  });

  test("mid-stream revoke (after blobStart + bytes) settles revoked and discards the partial upload", async () => {
    const h = makeBroker();
    const ctx = new DeviceContext(h.plane, owner, "origin");
    const p = ctx.request("gallery.pick", { mediaTypes: ["photo"], maxCount: 1 });
    const id = h.sent.find((m): m is DeviceRequest => m.type === "deviceRequest" && m.capability === "gallery.pick")!.id;
    h.receive(blobStart(id, 0, 1000));
    expect(h.plane.receiveFrame(frame(id, 0, 0, 500))).toBe(true);
    expect(h.plane.retainedBytes).toBeGreaterThan(0);
    h.receive({ type: "deviceResponse", id, error: { code: "revoked" } });
    expect(await p).toEqual({ ok: false, error: { code: "revoked" } });
    // The id is retired: the rest of the stream is dropped without storage,
    // and the server never answers a client terminal with a cancel.
    expect(h.plane.receiveFrame(frame(id, 0, 1, 500))).toBe(false);
    expect(cancels(h.sent, id).length).toBe(0);
    expect(h.plane.isLive(id)).toBe(false);
    expect(h.plane.retainedBytes).toBe(0);
  });
});
