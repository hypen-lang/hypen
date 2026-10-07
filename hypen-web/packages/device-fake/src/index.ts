/**
 * @hypen-space/device-fake — the explicit fake DeviceHost (RFC 001 §1 pillar 11).
 *
 * `FakeDeviceHost` is a deterministic, scripted device host for development
 * and conformance: it drives requests from scenarios instead of real
 * hardware. Per the RFC it is explicit in every way that matters:
 *
 * - it is a separate development package, never part of `@hypen-space/core`;
 * - it refuses to initialize in production (`NODE_ENV=production`);
 * - every terminal response it sends carries the protocol-level
 *   `simulated: true` marker;
 * - it shows a visible "Simulated device" banner whenever a DOM exists
 *   (mounted automatically by `client()`/`endpoint()`, or explicitly with
 *   `showBanner(doc)`).
 *
 * The generic client runtime it builds on (`DeviceClient`) lives in
 * `@hypen-space/core/remote/device`.
 */

import {
  DeviceClient,
  implementableVersions,
  type DeviceAck,
  type DeviceClientOptions,
  type DeviceClientTransport,
  type DeviceDriver,
  type DeviceEndpoint,
  type DeviceEvent,
  type DeviceHello,
  type DeviceRequest,
  type DeviceResponse,
  type DriverOutcome,
} from "@hypen-space/core/remote/device";

export type {
  DeviceClientTransport,
  DeviceDriver,
  DriverBlob,
  DriverContext,
  DriverOutcome,
} from "@hypen-space/core/remote/device";

/** Attribute identifying the banner element (one per document). */
export const BANNER_ATTRIBUTE = "data-hypen-device-fake-banner";

function isProduction(): boolean {
  const env = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } })
    .process?.env?.NODE_ENV;
  return env === "production";
}

/**
 * Mount the fixed, always-visible "Simulated device" banner (RFC 001 §1.11).
 * Idempotent per document: returns the existing banner if one is mounted.
 * Returns `null` when no DOM is available (headless/server use).
 */
export function showBanner(doc?: Document): HTMLElement | null {
  const d =
    doc ?? (globalThis as unknown as { document?: Document }).document;
  if (!d || typeof d.createElement !== "function" || typeof d.querySelector !== "function") {
    return null;
  }
  try {
    return mountBanner(d);
  } catch {
    // A partial/mock DOM (tests, SSR shims) must not break the fake host.
    return null;
  }
}

function mountBanner(d: Document): HTMLElement | null {
  const existing = d.querySelector<HTMLElement>(`[${BANNER_ATTRIBUTE}]`);
  if (existing) return existing;
  const host = d.body ?? d.documentElement;
  if (!host) return null;

  const banner = d.createElement("div");
  banner.setAttribute(BANNER_ATTRIBUTE, "");
  banner.setAttribute("role", "status");
  banner.setAttribute("aria-live", "polite");
  banner.textContent = "Simulated device — device results are fake (development only)";
  const style: Record<string, string> = {
    position: "fixed",
    left: "0",
    right: "0",
    bottom: "0",
    "z-index": "2147483647",
    "pointer-events": "none",
    padding: "4px 10px",
    background: "#b45309",
    color: "#fff",
    "font-family": "system-ui, sans-serif",
    "font-size": "12px",
    "font-weight": "600",
    "text-align": "center",
  };
  for (const [prop, value] of Object.entries(style)) banner.style.setProperty(prop, value);
  host.append(banner);
  return banner;
}

/** Remove the banner from a document (e.g. in test teardown). */
export function hideBanner(doc?: Document): void {
  const d =
    doc ?? (globalThis as unknown as { document?: Document }).document;
  if (typeof d?.querySelector !== "function") return;
  d.querySelector(`[${BANNER_ATTRIBUTE}]`)?.remove();
}

/**
 * Wraps a transport so every terminal response a fake host emits carries
 * `simulated: true` (protocol-level marker, RFC 001 §1.11).
 */
function markSimulated(transport: DeviceClientTransport): DeviceClientTransport {
  return {
    sendMessage(message: DeviceResponse | DeviceEvent) {
      if (message.type === "deviceResponse") {
        transport.sendMessage({ ...message, simulated: true });
      } else {
        transport.sendMessage(message);
      }
    },
    sendBinary(frame) {
      transport.sendBinary(frame);
    },
    ...(transport.bufferedAmount ? { bufferedAmount: () => transport.bufferedAmount!() } : {}),
    ...(transport.close ? { close: (code: number, reason: string) => transport.close!(code, reason) } : {}),
  };
}

/**
 * A scripted, deterministic device host for development and tests. Register
 * per-capability scenarios; every result is marked `simulated`.
 */
export class FakeDeviceHost {
  private readonly drivers = new Map<string, DeviceDriver>();

  constructor() {
    if (isProduction()) {
      throw new Error(
        "FakeDeviceHost must not be initialized in production (NODE_ENV=production). " +
          "It is a development/conformance host only."
      );
    }
  }

  /** Register (or replace) the driver for a capability. */
  driver(capability: string, driver: DeviceDriver): this {
    this.drivers.set(capability, driver);
    return this;
  }

  /** Convenience: a photo picker that returns fixed bytes after `delayMs`. */
  galleryReturns(bytes: Uint8Array, contentType = "image/jpeg", delayMs = 0): this {
    return this.driver("gallery.pick", async ({ cancelled }) => {
      if (delayMs > 0) {
        const raced = await Promise.race([
          sleep(delayMs).then(() => "done" as const),
          cancelled.then(() => "cancelled" as const),
        ]);
        if (raced === "cancelled") return { kind: "error", code: "cancelled" };
      }
      return { kind: "result", result: {}, blobs: [{ channel: 0, contentType, bytes }] };
    });
  }

  /** Convenience: a permission driver returning a fixed status (or denial). */
  permissionReturns(status: "granted" | "denied" | "prompt"): this {
    const handler: DeviceDriver = async () =>
      status === "denied"
        ? { kind: "error", code: "denied", platformDetail: "user-declined" }
        : { kind: "result", result: { status } };
    this.driver("permission.request", handler);
    this.driver("permission.query", handler);
    return this;
  }

  /**
   * Convenience: a per-permission scenario for `permission.query` and
   * `permission.request` over the closed P1 enum. A name mapped to
   * `"unsupported"`, or not mapped at all, answers `unsupported` with the
   * name as platformDetail (a host that cannot represent it, RFC 001 §3).
   */
  permissionsReturn(statuses: Partial<Record<FakePermission, FakePermissionStatus | "unsupported">>): this {
    const handler: DeviceDriver = async ({ request }) => {
      const permission = String((request.params as { permission?: unknown }).permission);
      const status = statuses[permission as FakePermission];
      if (status === undefined || status === "unsupported") {
        return { kind: "error", code: "unsupported", platformDetail: permission };
      }
      return { kind: "result", result: { status } };
    };
    this.driver("permission.query", handler);
    this.driver("permission.request", handler);
    return this;
  }

  /**
   * Convenience: `camera.capture` answering with fixed bytes. A photo
   * request gets `photo` (declared, JPEG by default); a video request gets
   * `video` streamed chunk by chunk WITHOUT a declared size, like a live
   * recorder (§2.4). A mode without a scenario is `unavailable`.
   */
  cameraReturns(scenario: {
    photo?: { bytes: Uint8Array; contentType?: "image/jpeg" | "image/heic" };
    video?: { chunks: Uint8Array[]; contentType?: "video/webm" | "video/mp4" | "video/quicktime"; chunkDelayMs?: number };
  }): this {
    return this.driver("camera.capture", async ({ request, cancelled }) => {
      const mode = (request.params as { mode?: unknown }).mode;
      if (mode === "photo" && scenario.photo) {
        return {
          kind: "result",
          result: {},
          blobs: [{ channel: 0, contentType: scenario.photo.contentType ?? "image/jpeg", bytes: scenario.photo.bytes }],
        };
      }
      if (mode === "video" && scenario.video) {
        const { chunks, chunkDelayMs = 0 } = scenario.video;
        return {
          kind: "result",
          result: {},
          blobs: [
            {
              channel: 0,
              contentType: scenario.video.contentType ?? "video/webm",
              stream: liveChunks(chunks, chunkDelayMs, cancelled),
            },
          ],
        };
      }
      return { kind: "error", code: "unavailable", platformDetail: `no simulated ${String(mode)}` };
    });
  }

  /**
   * Convenience: `mic.record` streaming the given PCM16 chunks as a live
   * recording (undeclared size, one chunk per `chunkDelayMs`), ending
   * normally after the last one (or at `maxDurationMs`, truncated to whole
   * frames). `durationMs` is derived from the bytes sent, the requested rate
   * and channel count.
   */
  micRecords(chunks: Uint8Array[], options: { chunkDelayMs?: number } = {}): this {
    return this.driver("mic.record", async ({ request, cancelled }) => {
      const params = request.params as { sampleRate: number; channels?: number; maxDurationMs?: number };
      const frameBytes = 2 * (params.channels ?? 1);
      const limit =
        params.maxDurationMs !== undefined
          ? Math.floor((params.maxDurationMs * params.sampleRate) / 1000) * frameBytes
          : Number.POSITIVE_INFINITY;
      const bounded: Uint8Array[] = [];
      let total = 0;
      for (const chunk of chunks) {
        if (total >= limit) break;
        const take = Math.min(chunk.byteLength, limit - total);
        bounded.push(chunk.subarray(0, take - (take % frameBytes)));
        total += take - (take % frameBytes);
      }
      return {
        kind: "result",
        result: {},
        blobs: [{ channel: 0, contentType: "audio/L16", stream: liveChunks(bounded, options.chunkDelayMs ?? 0, cancelled) }],
        complete: () => ({ durationMs: Math.round((total / frameBytes / params.sampleRate) * 1000) }),
      };
    });
  }

  /** Convenience: `bluetooth.select` answering with a fixed device identity. */
  bluetoothSelects(device: { id: string; name?: string }): this {
    return this.driver("bluetooth.select", async () => ({ kind: "result", result: { device: { ...device } } }));
  }

  /** Capability names with a registered scenario. */
  get capabilities(): string[] {
    return [...this.drivers.keys()];
  }

  /**
   * Build a `DeviceClient` bound to a transport using the registered drivers.
   * Mounts the visible banner when a DOM exists.
   */
  client(transport: DeviceClientTransport, options: DeviceClientOptions = {}): DeviceClient {
    showBanner();
    return new DeviceClient(markSimulated(transport), new Map(this.drivers), options);
  }

  /**
   * A `DeviceEndpoint` for `RemoteEngine` (`{ device: fake.endpoint() }`)
   * advertising exactly the registered scenarios plus the mandatory
   * connection-owned `core.capabilities` stream (served by a built-in
   * driver unless one was registered). The endpoint runs the full
   * connection model (`requireHandshake`): nothing is admitted before the
   * sessionAck, the first ack carrying `device` is final, app requests only
   * after the core stream opened. Mounts the banner on attach.
   */
  endpoint(options: DeviceClientOptions = {}): DeviceEndpoint & { readonly selected: DeviceAck | undefined } {
    const core: DeviceDriver = async ({ emit, cancelled }) => {
      emit({ capabilities: advertisement.capabilities });
      await cancelled;
      return { kind: "result", result: {} };
    };
    const drivers = new Map<string, DeviceDriver>([["core.capabilities", this.drivers.get("core.capabilities") ?? core]]);
    for (const [name, driver] of this.drivers) drivers.set(name, driver);
    const advertisement: DeviceHello = {
      protocolVersions: [1],
      binary: true,
      // Only scenarios the runtime can admit (registry revision + schema).
      capabilities: [...drivers.keys()]
        .map((name) => ({ name, versions: implementableVersions(name) }))
        .filter((c) => c.versions.length > 0),
    };
    let client: DeviceClient | null = null;
    let ack: DeviceAck | undefined;
    return {
      advertisement,
      get selected() {
        return ack;
      },
      attach: (io) => {
        client?.detach();
        showBanner();
        client = new DeviceClient(markSimulated(io), new Map(drivers), { ...options, requireHandshake: true });
        ack = undefined;
      },
      onAck: (a) => {
        // Admit only the negotiated revisions from now on (RFC 001 §2.2);
        // the first selection carrying `device` is final for the socket.
        if (ack === undefined) ack = a;
        client?.setSelection(a);
      },
      handleMessage: (m: DeviceRequest | DeviceEvent | DeviceResponse) => client?.handleMessage(m),
      handleText: (text: string) => client?.handleText(text),
      handleMalformed: (m: unknown, detail: string) => client?.handleMalformed(m, detail),
      handleFrame: (f) => client?.handleFrame(f),
      detach: () => {
        client?.detach();
        client = null;
        ack = undefined;
      },
    };
  }
}

/** The closed P1 permission enum (permission.query@1 / permission.request@1). */
export type FakePermission = "camera" | "microphone" | "photos" | "location" | "notifications" | "bluetooth" | "contacts";
export type FakePermissionStatus = "granted" | "denied" | "prompt";

/** A live source yielding `chunks` one per `delayMs`, stopping on cancel. */
async function* liveChunks(chunks: Uint8Array[], delayMs: number, cancelled: Promise<void>): AsyncGenerator<Uint8Array> {
  let stopped = false;
  void cancelled.then(() => (stopped = true));
  for (const chunk of chunks) {
    if (delayMs > 0) await sleep(delayMs);
    if (stopped) return;
    if (chunk.byteLength > 0) yield chunk;
  }
}

function sleep(ms: number): Promise<void> {
  const timer = (globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown })
    .setTimeout;
  return new Promise((resolve) => timer(() => resolve(), ms));
}

// Keep the outcome type referenced for API-surface stability.
export type FakeOutcome = DriverOutcome;
