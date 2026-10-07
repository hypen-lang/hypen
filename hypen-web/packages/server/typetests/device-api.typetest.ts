/**
 * Type-level tests for the typed device API (RFC 001 §4 "Typed per
 * capability", round-3 P1/C2/C3/C4). Never executed: `bun run typecheck`
 * (typecheck:server — this directory is in packages/server/tsconfig.json's
 * `include`) compiles it, and every `@ts-expect-error` below must be an
 * actual error — an unused one fails the typecheck, so a regression that
 * makes a bad call compile is caught. Runtime behaviour lives in
 * tests/device-srv-typed-api.test.ts.
 */

import { app } from "@hypen-space/core";
import type {
  DeviceCapabilityMap,
  DeviceCapabilityName,
  DeviceContext,
  DevicePermission,
  DeviceResult,
  DeviceStreamHandle,
  MicRecordV1Result,
  ResultOf,
  UnaryCapability,
  JsonStreamCapability,
  BinaryStreamCapability,
} from "@hypen-space/core/remote/device";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function assertType<T extends true>(_: T): void {}

declare const device: DeviceContext;

async function typedRequests(): Promise<void> {
  // ---- permissions (P1): the closed enum is checked at compile time ----
  const q = await device.request("permission.query", { permission: "camera" });
  if (q.ok) {
    const status: "granted" | "denied" | "prompt" = q.value.status;
    void status;
  }
  // @ts-expect-error — misspelled permission is not a DevicePermission
  await device.request("permission.query", { permission: "camra" });
  // @ts-expect-error — the old "geolocation" alias is gone; only "location"
  await device.request("permission.request", { permission: "geolocation" });
  // @ts-expect-error — params are a closed object
  await device.request("permission.query", { permission: "camera", extra: 1 });
  // @ts-expect-error — permission is required
  await device.request("permission.query", {});

  // ---- unknown capability names are a type error ----
  // @ts-expect-error — not a capability of the generated map
  await device.request("camera.snap", {});
  // @ts-expect-error — typo of a real name
  await device.request("gallery.pik", { mediaTypes: ["photo"], maxCount: 1 });
  // ...unless the caller opts into the explicit escape hatch.
  const dynamicName: string = "camera.snap";
  const untyped: DeviceResult<unknown> = await device.requestUntyped(dynamicName, { anything: true });
  void untyped;

  // ---- streams and downloads are not unary requests ----
  // @ts-expect-error — mic.record is a stream (device.stream / device.mic.record)
  await device.request("mic.record", { format: "pcm16", sampleRate: 16000 });
  // @ts-expect-error — bluetooth.scan is a JSON stream
  await device.request("bluetooth.scan", {});
  // @ts-expect-error — file.save carries server → client bytes (device.save)
  await device.request("file.save", { channel: 0, name: "a", contentType: "text/plain", bytes: 1, sha256: "0" });
  // @ts-expect-error — core.capabilities is protocol-internal (connection lifetime only)
  await device.request("core.capabilities", {});

  // ---- camera.capture (C2) ----
  const photo = await device.request("camera.capture", { mode: "photo", facing: "back" });
  if (photo.ok) {
    const bytes: Uint8Array = photo.value.items[0]!.bytes; // verified bytes, not a size
    const ct: "image/jpeg" | "image/heic" | "video/mp4" | "video/quicktime" | "video/webm" =
      photo.value.items[0]!.contentType;
    void bytes;
    void ct;
  }
  await device.request("camera.capture", { mode: "video", maxDurationMs: 5_000 });
  // @ts-expect-error — maxDurationMs is video-only
  await device.request("camera.capture", { mode: "photo", maxDurationMs: 5_000 });
  // @ts-expect-error — unknown mode
  await device.request("camera.capture", { mode: "panorama" });
  // @ts-expect-error — unknown facing
  await device.request("camera.capture", { mode: "photo", facing: "left" });

  // ---- bluetooth.select (C4) ----
  const bt = await device.request("bluetooth.select", { services: ["0000180d-0000-1000-8000-00805f9b34fb"] });
  if (bt.ok) {
    const id: string = bt.value.device.id;
    const name: string | undefined = bt.value.device.name;
    void id;
    void name;
  }
  // @ts-expect-error — services is a list of UUID strings
  await device.request("bluetooth.select", { services: 0x180d });
  // @ts-expect-error — no GATT options: identity only
  await device.request("bluetooth.select", { connect: true });

  // ---- gallery.pick: verified items carry bytes, not sha256 ----
  const pick = await device.request("gallery.pick", { mediaTypes: ["photo"], maxCount: 2 });
  if (pick.ok) {
    const b: Uint8Array = pick.value.items[0]!.bytes;
    void b;
    // @ts-expect-error — the hash was verified and stripped
    void pick.value.items[0]!.sha256;
  }
  // @ts-expect-error — mediaTypes values are a closed enum
  await device.request("gallery.pick", { mediaTypes: ["audio"], maxCount: 1 });
}

function typedStreams(): void {
  // ---- JSON streams: typed events ----
  const scan = device.stream("bluetooth.scan", {}, {}, (event) => {
    const rssi: number = event.device.rssi;
    void rssi;
  });
  scan.cancel();
  // @ts-expect-error — a JSON stream takes an onEvent function, not { onData }
  device.stream("bluetooth.scan", {}, {}, { onData: (_chunk: Uint8Array) => {} });

  // ---- binary-upload stream (C3): onData + verified result ----
  const rec: DeviceStreamHandle<MicRecordV1Result> = device.stream(
    "mic.record",
    { format: "pcm16", sampleRate: 48_000, channels: 2, maxDurationMs: 1_000 },
    {},
    {
      onData: async (chunk) => {
        const n: number = chunk.byteLength;
        void n;
      },
    }
  );
  void rec.settled.then((r) => {
    if (r.ok) {
      const sha: string = r.value.item.sha256;
      const ms: number = r.value.durationMs;
      void sha;
      void ms;
    }
  });
  // @ts-expect-error — mic.record needs { onData }, not an event callback
  device.stream("mic.record", { format: "pcm16", sampleRate: 16_000 }, {}, () => {});
  // channels is the closed range 1..2, typed as the literal union `1 | 2`.
  device.stream("mic.record", { format: "pcm16", sampleRate: 16_000, channels: 1 }, {}, { onData: () => {} });
  // @ts-expect-error — channels: 3 is outside 1 | 2 (also invalidParams at runtime)
  device.stream("mic.record", { format: "pcm16", sampleRate: 16_000, channels: 3 }, {}, { onData: () => {} });
  // @ts-expect-error — channels: 0 is outside 1 | 2
  device.mic.record({ format: "pcm16", sampleRate: 16_000, channels: 0 }, () => {});
  // @ts-expect-error — only pcm16 exists
  device.stream("mic.record", { format: "opus", sampleRate: 16_000 }, {}, { onData: () => {} });
  // @ts-expect-error — unary capabilities are not streams
  device.stream("camera.capture", { mode: "photo" }, {}, { onData: () => {} });
  // @ts-expect-error — unknown stream name
  device.stream("mic.listen", {}, {}, { onData: () => {} });
  // Escape hatch.
  device.streamUntyped("mic.listen", {}, {}, { onData: () => {} }).cancel();
}

async function wrappers(): Promise<void> {
  const shot = await device.camera.capture({ mode: "photo" });
  if (shot.ok) void (shot.value.items[0]!.bytes satisfies Uint8Array);
  // @ts-expect-error — photo with a duration
  await device.camera.capture({ mode: "photo", maxDurationMs: 10 });

  const rec = device.mic.record({ format: "pcm16", sampleRate: 16_000 }, (chunk) => void chunk.byteLength);
  rec.cancel();

  const sel = await device.bluetooth.select({ namePrefix: "HR" });
  if (sel.ok) void sel.value.device.id;
  await device.bluetooth.select();

  const p = await device.permissions.query("microphone");
  if (p.ok) void (p.value.status satisfies "granted" | "denied" | "prompt");
  await device.permissions.request("notifications");
  // @ts-expect-error — not a DevicePermission
  await device.permissions.query("camra");
  // @ts-expect-error — not a DevicePermission
  await device.permissions.request("storage");
}

// ---- the map and derived unions ----
assertType<Equal<DevicePermission, "camera" | "microphone" | "photos" | "location" | "notifications" | "bluetooth" | "contacts">>(true);
assertType<
  Equal<
    UnaryCapability,
    | "bluetooth.select"
    | "camera.capture"
    | "file.pick"
    | "gallery.pick"
    | "permission.query"
    | "permission.request"
  >
>(true);
assertType<Equal<JsonStreamCapability, "bluetooth.scan">>(true);
assertType<Equal<BinaryStreamCapability, "mic.record">>(true);
assertType<Equal<DeviceCapabilityMap["mic.record"]["mode"], "stream">>(true);
assertType<Equal<DeviceCapabilityMap["camera.capture"]["data"], "binaryUpload">>(true);
assertType<Equal<ResultOf<"bluetooth.select">["device"]["id"], string>>(true);
assertType<"camera.capture" extends DeviceCapabilityName ? true : false>(true);

// ---- inside a module handler: context.device is the typed surface ----
app
  .defineState<{ status: string }>({ status: "" })
  .onAction("check", async ({ state, context }) => {
    const r = await context.device.permissions.query("camera");
    state.status = r.ok ? r.value.status : r.error.code;
    // @ts-expect-error — typed through the handler context too
    await context.device.request("permission.query", { permission: "camra" });
  });

void typedRequests;
void typedStreams;
void wrappers;
