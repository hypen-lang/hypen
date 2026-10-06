/**
 * Device Capability Protocol — handler-facing device access (RFC 001 §4/§7).
 *
 * `DeviceContext` is what `context.device` resolves to inside a handler. It is
 * scoped per invocation/activation so it carries the owner authority
 * (module instance + activation) the broker needs, and it enforces the replay
 * firewall (§1.7): a device request issued from a `syncActions`-replayed or
 * `broadcast`-derived dispatch fails synchronously with `unavailable`, and
 * that restriction survives `await`.
 *
 * Everything protocol-side — admission against the live selection and the
 * selected revision (lifetimes, pin caps, deadline and credit clamps, params
 * and download announcements), leases, credit, blob verification — is the
 * Rust broker's, reached through the connection's {@link DevicePlane}. This
 * file is the typed, Result-style API on top of it: typed params/results per
 * capability, handler scopes, abort signals, stream consumers.
 */

import type {
  BluetoothSelectV1Params,
  CameraCaptureV1Params,
  DeviceCapabilityMap,
  DeviceCapabilityName,
  DeviceErrorCode,
  DeviceLifetime,
  DevicePermission,
  MicRecordV1Params,
} from "./generated.js";
import { sha256Hex } from "./blob.js";
import type { DevicePlane, DeviceRequestHandle } from "./plane.js";

export type DeviceResult<T> =
  | {
      ok: true;
      value: T;
      /** Set when a development fake produced the result (RFC 001 §1.11). */
      simulated?: true;
    }
  | { ok: false; error: { code: DeviceErrorCode; platformDetail?: string } };

/**
 * The subset of `AbortSignal` a device call observes (structural, so core
 * does not depend on a DOM lib).
 */
export interface DeviceAbortSignal {
  readonly aborted: boolean;
  addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

// ---------------------------------------------------------------------------
// Typed capability surface (RFC 001 §4 "Typed per capability"), derived from
// the generated `DeviceCapabilityMap` (latest revision per capability name).
// ---------------------------------------------------------------------------

type CapMap = DeviceCapabilityMap;

/** Params a capability's latest revision takes. */
export type ParamsOf<C extends DeviceCapabilityName> = CapMap[C]["params"];
/** The wire result of a capability's latest revision. */
export type WireResultOf<C extends DeviceCapabilityName> = CapMap[C]["result"];
/** Capability events of a JSON stream, as `onEvent` sees them (no progress). */
export type StreamEventOf<C extends DeviceCapabilityName> = Exclude<
  CapMap[C]["event"],
  { kind: "progress" }
>;

/** A verified upload item as a handler receives it: bytes instead of size + hash. */
export type VerifiedBlobOf<I> = Omit<I, "bytes" | "sha256"> & { bytes: Uint8Array };

/**
 * What `device.request()` resolves to: the wire result, except that the
 * blob items of a client → server upload (`items` / `item`) carry their
 * verified bytes.
 */
export type ResultOf<C extends DeviceCapabilityName> = CapMap[C]["data"] extends "binaryUpload"
  ? WireResultOf<C> extends { items: Array<infer I> }
    ? Omit<WireResultOf<C>, "items"> & { items: Array<VerifiedBlobOf<I>> }
    : WireResultOf<C> extends { item: infer I }
      ? Omit<WireResultOf<C>, "item"> & { item: VerifiedBlobOf<I> }
      : WireResultOf<C>
  : WireResultOf<C>;

/** Whether handler code may own work on this capability (not connection-only). */
type AppOwnable<C extends DeviceCapabilityName> = [
  Extract<CapMap[C]["lifetimes"], "activation" | "background">,
] extends [never]
  ? false
  : true;

/** Capabilities `device.request()` issues: unary, no server → client bytes. */
export type UnaryCapability = {
  [K in DeviceCapabilityName]: CapMap[K]["mode"] extends "unary"
    ? CapMap[K]["data"] extends "binaryDownload"
      ? never
      : AppOwnable<K> extends true
        ? K
        : never
    : never;
}[DeviceCapabilityName];

/** JSON event streams `device.stream(…, onEvent)` opens (e.g. `bluetooth.scan`). */
export type JsonStreamCapability = {
  [K in DeviceCapabilityName]: CapMap[K]["mode"] extends "stream"
    ? CapMap[K]["data"] extends "jsonEvents"
      ? AppOwnable<K> extends true
        ? K
        : never
      : never
    : never;
}[DeviceCapabilityName];

/** Binary-upload streams `device.stream(…, { onData })` opens (e.g. `mic.record`). */
export type BinaryStreamCapability = {
  [K in DeviceCapabilityName]: CapMap[K]["mode"] extends "stream"
    ? CapMap[K]["data"] extends "binaryUpload"
      ? AppOwnable<K> extends true
        ? K
        : never
      : never
    : never;
}[DeviceCapabilityName];

/** Any capability `device.stream()` accepts. */
export type StreamCapability = JsonStreamCapability | BinaryStreamCapability;

/**
 * Consumer of a binary-upload stream (`mic.record`). `onData` receives the
 * bytes in order, one call at a time; upload credit is replenished as it
 * returns (or its promise settles), so a slow consumer backpressures the
 * device. A throwing/rejecting `onData` still consumed its chunk. The
 * stream's `settled` resolves once every accepted chunk was delivered, with
 * the result whose `sha256` was verified over everything delivered.
 */
export interface DeviceDataConsumer {
  onData(chunk: Uint8Array): void | Promise<unknown>;
}

type JsonEventConsumer<E> = (event: E) => void | Promise<unknown>;

/** A live JSON stream opened by `context.device.stream()` (RFC 001 §4). */
export interface DeviceStreamHandle<R = unknown> {
  /** Wire request id, or null when the stream was refused locally. */
  readonly id: number | null;
  /**
   * Terminal outcome, exactly once: the client's result, or an error value
   * (`cancelled` after `cancel()`, `timeout`, `revoked`, …). Never rejects.
   */
  readonly settled: Promise<DeviceResult<R>>;
  /** Abandon the stream (server-side cancellation; idempotent). */
  cancel(): void;
}

/** Provenance of the dispatch a device call is made from. */
export type Provenance = "origin" | "replay";

export interface DeviceRequestInit {
  /**
   * Request lifetime (RFC 001 §2.7). Defaults to `activation`. `background`
   * is allowed only when the selected revision lists it; its owner is the
   * module instance (survives deactivation, swept on destruction) and counts
   * toward the per-connection pin cap. `connection` is protocol-internal.
   */
  lifetime?: DeviceLifetime;
  /** Overall deadline; clamped to the revision's `max_timeout_ms`. */
  timeoutMs?: number;
  /**
   * Initial client → server data credit; clamped to the revision's
   * `max_initial_credit`. Binary uploads default to 256 KiB; server → client
   * data planes always send zero. An explicit `0` on a client → server
   * data plane (upload bytes or JSON stream events) is refused
   * `invalidParams`: the client could never send anything and the request
   * would only end at its deadline. JSON streams default to 64 events.
   */
  initialCredit?: number;
  /**
   * Caller abandon (RFC 001 §2.1): aborting cancels the request (the client
   * is told `cancel`) and settles it `cancelled`. Already aborted ⇒ nothing
   * is sent.
   */
  signal?: DeviceAbortSignal;
}

export interface DeviceSaveOptions {
  /** Suggested file name shown by the host's save interaction. */
  name: string;
  contentType: string;
  timeoutMs?: number;
  /**
   * Caller abandon: aborting cancels the download (the client is told
   * `cancel`) and settles it `cancelled`. Already aborted ⇒ nothing is sent.
   */
  signal?: DeviceAbortSignal;
}

/**
 * The invoking handler's scope (RFC 001 §2.4): unary requests opened while
 * it is open are cancelled if still pending when the handler returns ("an
 * operation outliving its initiating handler is cancelled rather than
 * delivering an orphaned blob"), and delivered results keep counting toward
 * the connection's retained-bytes quota until it ends.
 */
interface HandlerScope {
  open: boolean;
  /** Live unary requests opened inside the scope. */
  readonly unary: Set<() => void>;
  /** Result-charge releases deferred to the end of the scope. */
  releases: Array<() => void>;
}


/** The owner authority captured by a handler context (RFC 001 §2.7). */
export interface DeviceOwner {
  moduleInstanceId: string;
  activationId: number;
}

type DeviceError = { code: DeviceErrorCode; platformDetail?: string };

/** `timeoutMs` as the broker takes it: a positive integer, or absent. */
function wireTimeout(t: number | undefined): number | undefined {
  if (t === undefined || Number.isNaN(t)) return undefined;
  if (!Number.isFinite(t)) return t > 0 ? Number.MAX_SAFE_INTEGER : 1;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, Math.floor(t)));
}

/**
 * The per-activation device surface. `owner` and `provenance` are fixed at
 * construction; a handler cannot forge another owner's authority or launder a
 * replayed dispatch into a live request.
 */
export class DeviceContext {
  private scope: HandlerScope | null = null;

  constructor(
    /** The connection's device plane, or null when there is none. */
    private readonly plane: DevicePlane | null,
    /** The invoking module's activation; null for a context without an owner. */
    private readonly owner: DeviceOwner | null,
    private readonly provenance: Provenance,
    /**
     * Why requests fail `unavailable` even though a plane exists (e.g.
     * "owner-inactive" for a handler running outside an activation); null
     * when the owner may issue requests.
     */
    private readonly blockedDetail: string | null = null,
    /**
     * Whether the captured owner authority is still live. Checked again after
     * any internal `await` so a continuation resuming after deactivation
     * cannot start new device work (RFC 001 §2.7). Absent ⇒ always live.
     */
    private readonly ownerLive: () => boolean = () => true
  ) {}

  /**
   * Open the invoking handler's scope. Called by the module instance right
   * before it runs an action or lifecycle handler with this context; not
   * for application code.
   * @internal
   */
  beginHandlerScope(): void {
    if (this.scope) return;
    this.scope = { open: true, unary: new Set(), releases: [] };
  }

  /**
   * The invoking handler returned (its promise settled): cancel every unary
   * request it left pending — the handler can no longer consume the result —
   * and release the retained-bytes charge of results it received. Requests
   * issued later through this context (e.g. from a timer carrying a
   * still-live owner) are not scoped: their results are released on
   * delivery. Streams are never scoped; they end with their owner.
   * @internal
   */
  endHandlerScope(): void {
    const scope = this.scope;
    if (!scope || !scope.open) return;
    scope.open = false;
    for (const cancel of [...scope.unary]) cancel();
    scope.unary.clear();
    const releases = scope.releases;
    scope.releases = [];
    for (const release of releases) release();
  }

  /**
   * `camera.capture`: one photo or video through the host's own capture UI
   * (the per-use consent gate). Resolves with exactly one verified item.
   */
  get camera(): {
    capture(
      params: CameraCaptureV1Params,
      init?: DeviceRequestInit
    ): Promise<DeviceResult<ResultOf<"camera.capture">>>;
  } {
    return { capture: (params, init) => this.request("camera.capture", params, init) };
  }

  /**
   * `mic.record`: a PCM16 recording streamed to `onData` in order (credit
   * paced by the consumer); `settled` carries `{ durationMs, item }` with the
   * sha256 verified over everything delivered.
   */
  get mic(): {
    record(
      params: MicRecordV1Params,
      onData: (chunk: Uint8Array) => void | Promise<unknown>,
      init?: DeviceRequestInit
    ): DeviceStreamHandle<WireResultOf<"mic.record">>;
  } {
    return { record: (params, onData, init) => this.stream("mic.record", params, init ?? {}, { onData }) };
  }

  /** `bluetooth.select`: the identity of one device the user chose in the host chooser. */
  get bluetooth(): {
    select(
      params?: BluetoothSelectV1Params,
      init?: DeviceRequestInit
    ): Promise<DeviceResult<ResultOf<"bluetooth.select">>>;
  } {
    return { select: (params, init) => this.request("bluetooth.select", params ?? {}, init) };
  }

  /** `permission.query` / `permission.request` over the closed permission enum (P1). */
  get permissions(): {
    query(
      permission: DevicePermission,
      init?: DeviceRequestInit
    ): Promise<DeviceResult<ResultOf<"permission.query">>>;
    request(
      permission: DevicePermission,
      init?: DeviceRequestInit
    ): Promise<DeviceResult<ResultOf<"permission.request">>>;
  } {
    return {
      query: (permission, init) => this.request("permission.query", { permission }, init),
      request: (permission, init) => this.request("permission.request", { permission }, init),
    };
  }

  /** Negotiated live support — not a permission grant (RFC 001 §4). */
  supports(capability: DeviceCapabilityName | (string & {})): boolean {
    return this.plane?.supports(capability) ?? false;
  }

  private guard(): DeviceError | null {
    if (this.provenance === "replay") {
      return { code: "unavailable", platformDetail: "syncActions.replay" };
    }
    if (!this.plane) {
      return { code: "unavailable", platformDetail: this.blockedDetail ?? "device-disabled" };
    }
    if (this.plane.isClosed) {
      return { code: "connectionLost" };
    }
    if (this.blockedDetail !== null || !this.owner) {
      return { code: "unavailable", platformDetail: this.blockedDetail ?? "owner-inactive" };
    }
    if (!this.ownerLive()) {
      return { code: "unavailable", platformDetail: "owner-inactive" };
    }
    return null;
  }

  /**
   * `initialCredit` for the wire: absent, or a positive integer on a client →
   * server data plane. An explicit value below 1 there is refused
   * `invalidParams` (the client could never send anything and the request
   * would only end at its deadline); data planes without client → server
   * data take no credit at all.
   */
  private wireCredit(
    capability: string,
    data: string | undefined,
    init: DeviceRequestInit
  ): { ok: true; value: number | undefined } | { ok: false; error: DeviceError } {
    if (init.initialCredit === undefined) return { ok: true, value: undefined };
    if (data !== "binaryUpload" && data !== "jsonEvents") return { ok: true, value: undefined };
    if (!(init.initialCredit >= 1)) {
      return {
        ok: false,
        error: {
          code: "invalidParams",
          platformDetail: `initialCredit must be ≥ 1 for ${capability} (a zero budget can never make progress)`,
        },
      };
    }
    return { ok: true, value: Math.min(Number.MAX_SAFE_INTEGER, Math.floor(init.initialCredit)) };
  }

  /**
   * Issue a unary request and await its terminal settlement as a value.
   * Typed per capability (RFC 001 §4): `capability` must be a unary name of
   * the generated `DeviceCapabilityMap` and `params` its latest revision's
   * params, so an unknown name or ill-typed params (`{ permission: "camra" }`,
   * a photo with `maxDurationMs`) is a compile error; `requestUntyped` is
   * the explicit escape hatch for dynamic names. Upload items resolve with
   * their verified bytes.
   *
   * Replayed dispatches and disabled device planes fail synchronously (the
   * returned promise is already rejected-shaped, never a live request).
   * Every client error — `denied`, `revoked` (even mid-stream), `cancelled`
   * … — arrives as `{ ok: false, error }`, never as a throw. Params are
   * still validated at runtime against the selected revision.
   */
  request<C extends UnaryCapability>(
    capability: C,
    params: ParamsOf<C>,
    init: DeviceRequestInit = {}
  ): Promise<DeviceResult<ResultOf<C>>> {
    return this.requestUntyped<ResultOf<C>>(capability, params, init);
  }

  /**
   * Untyped unary request for names only known at runtime (the explicit
   * opt-out of `request`'s compile-time checks). Behaves exactly like
   * `request`: names and params are validated against the selected
   * revision before anything is sent.
   */
  async requestUntyped<T = unknown>(
    capability: string,
    params: unknown,
    init: DeviceRequestInit = {}
  ): Promise<DeviceResult<T>> {
    const blocked = this.guard();
    if (blocked) return { ok: false, error: blocked };
    if (init.signal?.aborted) return { ok: false, error: { code: "cancelled" } };
    const plane = this.plane!;
    const owner = this.owner!;

    const version = plane.selectedVersion(capability);
    if (version === undefined) return { ok: false, error: { code: "unsupported" } };
    const rev = plane.revision(capability, version);
    const credit = this.wireCredit(capability, rev?.data, init);
    if (!credit.ok) return { ok: false, error: credit.error };

    // The broker admits or refuses (lifetime, pin cap, operation shape — a
    // stream or a download is refused here — params, deadline and credit
    // clamps), in that order, before anything is sent.
    const handle = plane.open({
      capability,
      version,
      params,
      moduleInstanceId: owner.moduleInstanceId,
      activationId: owner.activationId,
      ...(init.lifetime !== undefined ? { lifetime: init.lifetime } : {}),
      ...optional("timeoutMs", wireTimeout(init.timeoutMs)),
      ...optional("initialCredit", credit.value),
      mode: "unary",
      // Completed-but-unconsumed results keep counting toward the quota
      // until the handler scope ends (or delivery, outside a scope).
      holdResult: true,
    });
    // Activation-owned unary work is scoped to the invoking handler;
    // `background` work is explicitly detached from it (owned by the module
    // instance, swept on destroy) and is never scope-cancelled.
    const lifetime = init.lifetime ?? rev?.lifetimes[0] ?? "activation";
    if (handle.id === null) return { ok: false, error: await this.refusal(handle) };
    const scope = this.scope?.open && lifetime !== "background" ? this.scope : null;
    scope?.unary.add(handle.cancel);
    const detach = this.bindAbort(init.signal, handle.cancel);
    const settlement = await handle.settled;
    detach();
    scope?.unary.delete(handle.cancel);
    if (!("result" in settlement)) return { ok: false, error: settlement.error };
    const release = settlement.release;
    if (release) {
      if (scope?.open) scope.releases.push(release);
      else queueMicrotask(release); // after the value was handed over
    }
    const simulated = settlement.simulated === true ? { simulated: true as const } : {};

    // A client → server blob plane: the broker verified the received bytes
    // against the declared item set (count, sizes, sha256, content types)
    // before settling ok (RFC 001 §2.4); the handler gets the bytes in place
    // of the declared size + hash.
    if (rev?.data === "binaryUpload") {
      const raw = settlement.result as { items?: unknown; item?: unknown };
      const single = !Array.isArray(raw?.items) && raw?.item !== undefined;
      const items = settlement.blobs.map((b) => ({
        channel: b.channel,
        ...(typeof b.name === "string" ? { name: b.name } : {}),
        contentType: b.contentType,
        bytes: b.bytes,
      }));
      const result = single
        ? { ...(settlement.result as object), item: items[0] }
        : { ...(settlement.result as object), items };
      return { ok: true, value: result as T, ...simulated };
    }

    return { ok: true, value: settlement.result as T, ...simulated };
  }

  /**
   * Open a stream (RFC 001 §2.3/§4), typed per capability like `request`.
   *
   * - JSON event streams (`bluetooth.scan`): pass `onEvent`. Each event is
   *   validated against the revision's event schema by the broker before
   *   `onEvent` sees it; event credit is replenished as `onEvent` returns
   *   (or its promise settles), so a slow consumer backpressures the device.
   * - Binary-upload streams (`mic.record`): pass `{ onData }`. Bytes arrive
   *   in order and are never buffered server-side; upload credit is
   *   replenished as `onData` returns; `settled` resolves after the last
   *   chunk was delivered, with the result whose `sha256` was verified over
   *   everything delivered (a mismatch settles `invalidParams`).
   *
   * The stream ends with one terminal outcome on `settled`; `cancel()`
   * abandons it. `streamUntyped` is the escape hatch for dynamic names.
   */
  stream<C extends JsonStreamCapability>(
    capability: C,
    params: ParamsOf<C>,
    init: DeviceRequestInit,
    onEvent: JsonEventConsumer<StreamEventOf<C>>
  ): DeviceStreamHandle<WireResultOf<C>>;
  stream<C extends BinaryStreamCapability>(
    capability: C,
    params: ParamsOf<C>,
    init: DeviceRequestInit,
    consumer: DeviceDataConsumer
  ): DeviceStreamHandle<WireResultOf<C>>;
  stream(
    capability: StreamCapability,
    params: unknown,
    init: DeviceRequestInit,
    consumer: JsonEventConsumer<never> | DeviceDataConsumer
  ): DeviceStreamHandle<unknown> {
    return this.streamUntyped(
      capability,
      params,
      init,
      consumer as JsonEventConsumer<Record<string, unknown>> | DeviceDataConsumer
    );
  }

  /**
   * Untyped stream for names only known at runtime. A JSON stream takes an
   * `onEvent` function, a binary-upload stream a `{ onData }` consumer; the
   * wrong kind is refused locally `invalidParams`.
   */
  streamUntyped<E = Record<string, unknown>, R = Record<string, unknown>>(
    capability: string,
    params: unknown,
    init: DeviceRequestInit,
    consumer: JsonEventConsumer<E> | DeviceDataConsumer
  ): DeviceStreamHandle<R> {
    const refused = (error: DeviceError): DeviceStreamHandle<R> => ({
      id: null,
      settled: Promise.resolve({ ok: false, error }),
      cancel: () => {},
    });
    const blocked = this.guard();
    if (blocked) return refused(blocked);
    if (init.signal?.aborted) return refused({ code: "cancelled" });
    const plane = this.plane!;
    const owner = this.owner!;
    const version = plane.selectedVersion(capability);
    if (version === undefined) return refused({ code: "unsupported" });
    const rev = plane.revision(capability, version);
    const data = rev?.mode === "stream" ? rev.data : null;
    if (data !== "jsonEvents" && data !== "binaryUpload") {
      return refused({
        code: "invalidParams",
        platformDetail: `${capability} is not a stream; use device.request()`,
      });
    }
    const onData =
      typeof consumer === "object" && consumer !== null && typeof consumer.onData === "function"
        ? consumer
        : null;
    const onEvent = typeof consumer === "function" ? consumer : null;
    if (data === "binaryUpload" && !onData) {
      return refused({
        code: "invalidParams",
        platformDetail: `${capability} streams bytes; pass { onData }`,
      });
    }
    if (data === "jsonEvents" && !onEvent) {
      return refused({
        code: "invalidParams",
        platformDetail: `${capability} streams JSON events; pass an onEvent function`,
      });
    }
    const credit = this.wireCredit(capability, data, init);
    if (!credit.ok) return refused(credit.error);
    const handle = plane.open({
      capability,
      version,
      params,
      moduleInstanceId: owner.moduleInstanceId,
      activationId: owner.activationId,
      ...(init.lifetime !== undefined ? { lifetime: init.lifetime } : {}),
      ...optional("timeoutMs", wireTimeout(init.timeoutMs)),
      ...optional("initialCredit", credit.value),
      mode: "stream",
      ...(onEvent ? { onEvent: (event: Record<string, unknown>) => onEvent(event as E) } : {}),
      ...(onData ? { onData: (chunk: Uint8Array) => onData.onData(chunk) } : {}),
    });
    if (handle.id === null) {
      return {
        id: null,
        settled: this.refusal(handle).then((error) => ({ ok: false, error })),
        cancel: () => {},
      };
    }
    const detach = this.bindAbort(init.signal, handle.cancel);
    const settled = handle.settled.then((settlement): DeviceResult<R> => {
      detach();
      if (!("result" in settlement)) return { ok: false, error: settlement.error };
      return {
        ok: true,
        value: settlement.result as R,
        ...(settlement.simulated === true ? { simulated: true as const } : {}),
      };
    });
    return { id: handle.id, settled, cancel: handle.cancel };
  }

  /**
   * A local refusal from the broker, as the Rust broker worded it. Params
   * that fail the selected revision's schema (RFC 001 §1.9 "validate both
   * ends": a handler bug fails locally instead of costing a round trip and a
   * device prompt) carry the offending path in the detail
   * (`params $.services[0]: …`), so the handler sees what to fix.
   */
  private async refusal(handle: DeviceRequestHandle): Promise<DeviceError> {
    const settlement = await handle.settled;
    return "error" in settlement ? settlement.error : { code: "internal" };
  }

  /** Wire an abort signal to a cancel function; returns the unbinder. */
  private bindAbort(signal: DeviceAbortSignal | undefined, cancel: () => void): () => void {
    if (!signal) return () => {};
    const onAbort = () => cancel();
    signal.addEventListener("abort", onAbort, { once: true });
    return () => signal.removeEventListener("abort", onAbort);
  }

  /**
   * Save bytes on the device (`file.save`, RFC 001 §2.4 downloads). The
   * request params are the announcement `{channel:0, name, contentType,
   * bytes, sha256}` and carry `initialCredit: 0`; the broker then sends
   * ≤ 64 KiB frames only within credit the client grants after consent and
   * destination selection. A client that never grants receives nothing — the
   * deadline and lease still apply. The client verifies size and hash before
   * reporting `{ bytesWritten }`. The announcement (an overlong name or
   * content type…) is validated by the Rust broker at open: an invalid one is
   * refused locally with `invalidParams`, nothing sent.
   */
  async save(
    bytes: Uint8Array,
    opts: DeviceSaveOptions
  ): Promise<DeviceResult<{ bytesWritten: number }>> {
    const capability = "file.save";
    const blocked = this.guard();
    if (blocked) return { ok: false, error: blocked };
    if (opts.signal?.aborted) return { ok: false, error: { code: "cancelled" } };
    const plane = this.plane!;
    const owner = this.owner!;
    const version = plane.selectedVersion(capability);
    if (version === undefined) return { ok: false, error: { code: "unsupported" } };
    if (!plane.canSendBinary) {
      return { ok: false, error: { code: "unsupported", platformDetail: "no binary route" } };
    }
    const rev = plane.revision(capability, version);
    if (bytes.byteLength < 1) {
      // Matches the client: a download announces at least one byte.
      return {
        ok: false,
        error: { code: "invalidParams", platformDetail: "file.save needs at least 1 byte" },
      };
    }
    if (rev && bytes.byteLength > rev.maxItemBytes) {
      return {
        ok: false,
        error: {
          code: "invalidParams",
          platformDetail: `${bytes.byteLength} bytes exceeds max item bytes ${rev.maxItemBytes}`,
        },
      };
    }
    // Snapshot: the caller may reuse its buffer while the transfer runs.
    const snapshot = bytes.slice();
    const sha256 = await sha256Hex(snapshot);
    if (opts.signal?.aborted) return { ok: false, error: { code: "cancelled" } };
    // Authority is re-checked after the hash await: a continuation resuming
    // after deactivation/close cannot start new device work (§2.7).
    if (plane.isClosed) return { ok: false, error: { code: "connectionLost" } };
    if (!this.ownerLive()) {
      return { ok: false, error: { code: "unavailable", platformDetail: "owner-inactive" } };
    }

    const handle: DeviceRequestHandle = plane.open({
      capability,
      version,
      params: {
        channel: 0,
        name: opts.name,
        contentType: opts.contentType,
        bytes: snapshot.byteLength,
        sha256,
      },
      moduleInstanceId: owner.moduleInstanceId,
      activationId: owner.activationId,
      ...optional("timeoutMs", wireTimeout(opts.timeoutMs)),
      mode: "unary",
      download: snapshot,
    });
    const detach = this.bindAbort(opts.signal, handle.cancel);
    const settlement = await handle.settled;
    detach();
    if (!("result" in settlement)) return { ok: false, error: settlement.error };
    const written = (settlement.result as { bytesWritten?: unknown })?.bytesWritten;
    if (written !== snapshot.byteLength) {
      return {
        ok: false,
        error: {
          code: "invalidParams",
          platformDetail: `client reported ${String(written)} bytes written of ${snapshot.byteLength}`,
        },
      };
    }
    return { ok: true, value: { bytesWritten: written } };
  }
}

/** `{ [key]: value }` when the value is defined, else `{}`. */
function optional<K extends string>(key: K, value: number | undefined): { [P in K]?: number } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: number };
}

/** A DeviceContext that always refuses — for replayed dispatches and hosts
 *  without a device plane. Keeps call sites uniform. */
export function deniedDeviceContext(provenance: Provenance = "replay"): DeviceContext {
  return new DeviceContext(null, null, provenance);
}
