/**
 * @hypen-space/device-web — the browser DeviceHost (RFC 001 §2.6 / §5).
 *
 * Separate from the renderers (which stay pure patch consumers): this package
 * owns consent UI, real platform drivers, grant/cooldown storage, and
 * teardown. It plugs into `RemoteEngine` through the `DeviceEndpoint`
 * contract (`new RemoteEngine(url, { device: new WebDeviceHost({...}) })`).
 *
 * Activation model (RFC 001 §2.6): a server request never borrows the app's
 * latest gesture and is never bound to an app element. When a platform API
 * needs a fresh user gesture (file pickers, permission prompts), the host
 * presents its OWN interaction — a dialog naming the authenticated app origin
 * and the requested operation, with Continue and Cancel — and invokes the
 * platform API inside that trusted click's activation window. Other app
 * gestures never consume a pending request; one host prompt at a time.
 *
 * Driver notes (RFC 001 §2.6 step 4 — how dismissal maps to errors):
 * - `gallery.pick` / `file.pick`: host Cancel → `denied` + cooldown; OS picker
 *   dismissal → `cancelled` (`picker-dismissed`).
 * - `file.save`: validated against `maxDownloadBytes` before any UI
 *   (`invalidParams`). With the File System Access API the destination is a
 *   `FileSystemWritableFileStream`, which commits only on `close()` (aborted
 *   on failure, so no partial output). The fallback `<a download>` path hands
 *   verified bytes to the browser's download manager; the browser may still
 *   show its own UI, and `bytesWritten` reports bytes handed over, not a
 *   guarantee the user kept the file.
 * - `camera.capture`: the host's own capture dialog (live preview, Capture
 *   or Record/Stop, Cancel — armed like Continue) is the per-use consent;
 *   nothing is captured before a trusted activation of Capture/Record. A
 *   photo is the preview frame as JPEG (canvas); a video is MediaRecorder
 *   output (webm) streamed as recorded, without a declared size. Cancel →
 *   `cancelled` (+ cooldown); a refused camera permission → `denied`.
 * - `mic.record`: consent dialog, then getUserMedia + an AudioWorklet
 *   (ScriptProcessor fallback) resampled to the requested rate → PCM16
 *   (`audio/L16`, interleaved when stereo), streamed as captured without a
 *   declared size. The always-visible recording indicator (origin + Stop)
 *   stays up for the whole recording; Stop, `maxDurationMs` and the page
 *   becoming hidden end it normally. When the server starves it of credit
 *   the capture keeps a bounded window, then ends `throttled`.
 * - `bluetooth.select`: consent dialog, then the browser's Web Bluetooth
 *   chooser inside the trusted click (`navigator.bluetooth.requestDevice`);
 *   chooser dismissal → `cancelled`. Not advertised where Web Bluetooth is
 *   absent (a request anyway → `unsupported`).
 * - `permission.query` / `permission.request`: the closed P1 enum. camera,
 *   microphone, location (geolocation) and notifications map to the
 *   Permissions API; `photos` is `granted` (the file picker needs no
 *   permission); `bluetooth` is `prompt` where Web Bluetooth exists;
 *   anything the web cannot represent (`contacts`) is `unsupported` with the
 *   name as platformDetail. `permission.request` really prompts
 *   (getUserMedia with the tracks stopped at once, getCurrentPosition,
 *   Notification.requestPermission) behind the consent dialog's trusted
 *   Continue; an already-decided permission answers without a dialog.
 * - Background lifetime is never admitted: the web has no compliant
 *   always-visible background indicator (RFC 001 §5) → `unavailable`.
 * - Capabilities that depend on a browser permission (see
 *   `permissionDependencies`) are terminated with `revoked` if that
 *   permission flips to `denied` while the request is live; any watched
 *   permission change re-emits the full `core.capabilities` advertisement.
 */

import {
  DeviceClient,
  implementableVersions,
  type DeviceAck,
  type DeviceClientTransport,
  type DeviceDriver,
  type DeviceEndpoint,
  type DeviceErrorCode,
  type DeviceEvent,
  type DeviceHello,
  type DeviceRequest,
  type DeviceResponse,
  type DriverBlob,
  type DriverContext,
  type DriverOutcome,
} from "@hypen-space/core/remote/device";
import {
  bareMediaType,
  browserMediaBackend,
  mediaErrorOutcome,
  stopStream,
  type AudioCaptureLike,
  type MediaBackend,
  type MediaStreamLike,
  type RecorderLike,
} from "./media.js";
import { codedError, LiveQueue, PcmEncoder } from "./pcm.js";
import {
  CaptureDialog,
  ConsentDialog,
  DEFAULT_INPUT_PROTECTION_MS,
  RecordingIndicator,
  type CaptureAction,
  type DeviceDialogTheme,
  type DropZoneOptions,
} from "./ui.js";
export { fileMatchesAccept, type DeviceDialogTheme, type DroppedFiles, type DropZoneOptions } from "./ui.js";

export { floatToPcm16, LiveQueue, PcmEncoder } from "./pcm.js";
export { bareMediaType, browserMediaBackend } from "./media.js";
export type { AudioCaptureLike, MediaBackend, MediaStreamLike, RecorderLike } from "./media.js";

/**
 * Server → client download sink (RFC 001 §2.4), supplied by the core runtime
 * on `DriverContext.download` for download capabilities (`file.save`).
 * Declared structurally here so this package compiles whether or not the
 * runtime's own `DownloadSink` type is present.
 */
export interface DownloadSinkLike {
  readonly declared: { name: string; contentType: string; bytes: number; sha256: string };
  /**
   * Starts granting credit and resolves with all verified bytes (or rejects
   * with an Error whose `code` is a DeviceErrorCode). Called only after
   * consent and destination selection — calling it is what grants credit.
   */
  receiveAll(): Promise<Uint8Array>;
}

type DownloadDriverContext = DriverContext & { readonly download?: DownloadSinkLike };

/** The subset of `Permissions` / `PermissionStatus` the host uses. */
export interface PermissionStatusLike {
  readonly state: string;
  onchange?: ((this: PermissionStatusLike, ev: Event) => unknown) | null;
  addEventListener?(type: "change", listener: () => void): void;
  removeEventListener?(type: "change", listener: () => void): void;
}
export interface PermissionsLike {
  query(descriptor: { name: string }): Promise<PermissionStatusLike>;
}

export interface WebDeviceHostOptions {
  /**
   * The authenticated app origin the prompts name (RFC 001 §5): normally the
   * remote server's origin (`new URL(wsUrl).origin`). Grants/cooldowns persist
   * only for `wss:`/`https:` origins; plaintext origins are session-scoped.
   */
  origin: string;
  /** Capabilities this host implements. Defaults to every built-in driver
   *  plus every key of `drivers`. */
  capabilities?: string[];
  /** Where the host dialog mounts. Defaults to `document.body`. */
  mount?: HTMLElement;
  /**
   * Client-side maximum for any request deadline: the runtime terminates
   * `timeout` at `min(timeoutMs, maxTimeoutMs)` from receipt, for every
   * driver. The connection-owned `core.capabilities` stream is bounded by its
   * revision instead. Default 300 s.
   */
  maxTimeoutMs?: number;
  /** Cooldown after a refusal before the same capability may prompt again. */
  denialCooldownMs?: number;
  /** Client-side maximum size of a `file.save` download (default 64 MiB). */
  maxDownloadBytes?: number;
  /**
   * Additional host-side drivers (trusted host code, not server input). They
   * get the same background-lifetime and revocation policy as built-ins.
   */
  drivers?: Record<string, DeviceDriver>;
  /**
   * Capability → browser permission name it depends on. While such a request
   * is live, the permission is watched; a flip to `denied` ends it with
   * `revoked`. Merged over the built-in map.
   */
  permissionDependencies?: Record<string, string>;
  /** Permissions API. Defaults to `navigator.permissions`. */
  permissions?: PermissionsLike;
  /**
   * Input protection for the host dialog (RFC 001 §2.6 step 3, §10): for
   * this long after the dialog becomes visible — and again whenever the page
   * becomes visible or the window regains focus — Continue is disabled, and
   * only an activation that STARTS on the enabled Continue (a trusted
   * pointer-down or Enter/Space key-down on it) counts. Keystrokes and
   * clicks meant for the app therefore never reach it. Default 500 ms.
   */
  inputProtectionMs?: number;
  /**
   * Look of the host's consent and camera dialogs: accent, colors, radius,
   * font, light/dark. Each field is also a `--hypen-device-*` CSS custom
   * property, and the dialogs carry stable `hypen-device-*` class names, so
   * page CSS can restyle them too. Host-side only: the app server cannot.
   */
  theme?: DeviceDialogTheme;
  /**
   * Camera/microphone/Web Audio seams (getUserMedia, preview, JPEG
   * snapshot, MediaRecorder, PCM capture). Defaults to the real browser.
   */
  media?: MediaBackend;
  /** Web Bluetooth. Defaults to `navigator.bluetooth`. */
  bluetooth?: BluetoothLike;
  /** Geolocation (permission.request "location"). Defaults to `navigator.geolocation`. */
  geolocation?: GeolocationLike;
  /** Notification permission API. Defaults to the global `Notification`. */
  notifications?: NotificationsLike;
  /**
   * Bounded capture window (RFC 001 §2.4): bytes a live recording may hold
   * while the server grants no credit before it ends `throttled`.
   * Defaults: `mic.record` 1 MiB, `camera.capture` video 8 MiB.
   */
  captureBufferBytes?: { mic?: number; video?: number };
  /**
   * Stop a recording (normally, a success with what was captured) when the
   * page becomes hidden — the web grants no background capture (RFC 001
   * §2.4/§5). Default true.
   */
  stopRecordingWhenHidden?: boolean;
}

/** The subset of Web Bluetooth `bluetooth.select` uses. */
export interface BluetoothLike {
  requestDevice(options: {
    filters?: Array<{ services?: string[]; namePrefix?: string }>;
    acceptAllDevices?: boolean;
    optionalServices?: string[];
  }): Promise<{ id: string; name?: string | null }>;
}

/** The subset of Geolocation `permission.request` uses. */
export interface GeolocationLike {
  getCurrentPosition(
    success: (position: unknown) => void,
    error?: (err: { code: number; PERMISSION_DENIED?: number }) => void,
    options?: { maximumAge?: number; timeout?: number; enableHighAccuracy?: boolean }
  ): void;
}

/** The subset of `Notification` the permission drivers use. */
export interface NotificationsLike {
  readonly permission: string;
  requestPermission(): Promise<string>;
}

/** The closed permission enum (P1, permission.query@1 / permission.request@1). */
export type DevicePermission =
  | "camera"
  | "microphone"
  | "photos"
  | "location"
  | "notifications"
  | "bluetooth"
  | "contacts";

/** Permissions-API names for the enum entries the web can query. */
const PERMISSION_API_NAME: Partial<Record<DevicePermission, string>> = {
  camera: "camera",
  microphone: "microphone",
  location: "geolocation",
  notifications: "notifications",
};

const BUILTIN_CAPABILITIES = [
  "core.capabilities",
  "gallery.pick",
  "file.pick",
  "file.save",
  "permission.query",
  "permission.request",
  "camera.capture",
  "mic.record",
  "bluetooth.select",
] as const;

/** Built-in capability → browser permission it depends on (revocation). */
const BUILTIN_PERMISSION_DEPENDENCIES: Record<string, string> = {
  "camera.capture": "camera",
  "mic.record": "microphone",
};

/** Host-controlled operation labels (never server text, RFC 001 §2.6). */
const VERB: Record<string, string> = {
  "gallery.pick": "choose a photo or video from your device",
  "file.pick": "choose a file from your device",
  "file.save": "save a file to your device",
  "permission.request": "request a permission",
  "mic.record": "record audio from your microphone",
  "bluetooth.select": "connect to a nearby Bluetooth device",
};

/** Host labels for permission.request prompts. */
const PERMISSION_VERB: Partial<Record<DevicePermission, string>> = {
  camera: "use your camera",
  microphone: "use your microphone",
  location: "know your location",
  notifications: "show notifications",
};

const DEFAULT_MIC_BUFFER_BYTES = 1024 * 1024;
const DEFAULT_VIDEO_BUFFER_BYTES = 8 * 1024 * 1024;
/** MediaRecorder timeslice: video bytes leave as they are encoded. */
const VIDEO_TIMESLICE_MS = 250;

// Matches the file.save-v1 registry maxItemBytes (the runtime also enforces it).
const DEFAULT_MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
// gallery.pick-v1 / file.pick-v1 maxItemBytes, used when a driver runs
// without the runtime's `ctx.revision` (the runtime always supplies it).
const DEFAULT_MAX_ITEM_BYTES = 64 * 1024 * 1024;

const ERROR_CODES: ReadonlySet<string> = new Set<DeviceErrorCode>([
  "unsupported",
  "unavailable",
  "denied",
  "revoked",
  "cancelled",
  "timeout",
  "throttled",
  "connectionLost",
  "invalidParams",
  "internal",
]);

/** Human-readable byte size for host UI. */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/**
 * Characters a file name must never carry (server text, RFC 001 §5): path
 * separators, C0/C1 controls and DEL, and every Unicode format (Cf)
 * character — bidi embeddings/overrides/isolates and marks (U+202A–U+202E,
 * U+2066–U+2069, U+200E/U+200F, U+061C), zero-width joiners/spaces, the
 * BOM, soft hyphen, … — which could make "invoice\u202Efdp.exe" display as
 * "invoiceexe.pdf". Plus line/paragraph separators.
 */
// eslint-disable-next-line no-control-regex
const UNSAFE_NAME_CHARS = /[\\/\u0000-\u001f\u007f-\u009f\u2028\u2029]|\p{Cf}/gu;

/** A download name safe to hand to a platform save API (and to show). */
export function safeFileName(name: string): string {
  const cleaned = name.replace(UNSAFE_NAME_CHARS, "_").trim().slice(0, 255);
  return cleaned.length > 0 && cleaned !== "." && cleaned !== ".." ? cleaned : "download";
}

/**
 * Split a sanitized name for display: the extension is shown on its own
 * ("type: .exe"), so the part the user reads last is always the real one.
 */
export function describeFileName(name: string): { base: string; extension: string } {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return { base: name, extension: "" };
  return { base: name.slice(0, dot), extension: name.slice(dot + 1) };
}

/** Cooldown store: persistent for authenticated origins, in-memory otherwise. */
class CooldownStore {
  private readonly memory = new Map<string, number>();
  constructor(private readonly origin: string) {}

  private key(capability: string): string {
    return `hypen.device.cooldown:${this.origin}:${capability}`;
  }

  private get persistent(): boolean {
    return this.origin.startsWith("wss:") || this.origin.startsWith("https:");
  }

  until(capability: string): number {
    if (this.persistent) {
      try {
        const raw = globalThis.localStorage?.getItem(this.key(capability));
        return raw ? Number(raw) || 0 : 0;
      } catch {
        return this.memory.get(capability) ?? 0;
      }
    }
    return this.memory.get(capability) ?? 0;
  }

  set(capability: string, until: number): void {
    this.memory.set(capability, until);
    if (this.persistent) {
      try {
        globalThis.localStorage?.setItem(this.key(capability), String(until));
      } catch {
        /* storage unavailable: memory only */
      }
    }
  }
}

/**
 * Shared permission watches: one `PermissionStatus` per permission name,
 * fanned out to live requests (revocation) and the host's advertisement
 * re-emit. Lazily queried; torn down on detach.
 */
class PermissionWatcher {
  private readonly entries = new Map<
    string,
    {
      status: PermissionStatusLike | null;
      last: string | null;
      listeners: Set<(state: string, previous: string | null) => void>;
      unhook: (() => void) | null;
    }
  >();
  private disposed = false;

  constructor(
    private readonly permissions: () => PermissionsLike | undefined,
    private readonly onAnyChange: () => void
  ) {}

  /**
   * Watch `name`; `listener(state, previous)` fires on every change. Resolves
   * once the initial state is known (or immediately if unqueryable). Returns
   * an unsubscribe function.
   */
  watch(name: string, listener?: (state: string, previous: string | null) => void): () => void {
    let entry = this.entries.get(name);
    if (!entry) {
      entry = { status: null, last: null, listeners: new Set(), unhook: null };
      this.entries.set(name, entry);
      void this.hook(name, entry);
    }
    if (listener) entry.listeners.add(listener);
    return () => {
      if (listener) entry!.listeners.delete(listener);
    };
  }

  private async hook(
    name: string,
    entry: NonNullable<ReturnType<PermissionWatcher["entries"]["get"]>>
  ): Promise<void> {
    const perms = this.permissions();
    if (!perms) return;
    let status: PermissionStatusLike;
    try {
      status = await perms.query({ name });
    } catch {
      return; // unknown/unqueryable permission: nothing to watch
    }
    if (this.disposed || this.entries.get(name) !== entry) return;
    entry.status = status;
    entry.last = status.state;
    const onChange = () => {
      const previous = entry.last;
      entry.last = status.state;
      if (previous === status.state) return;
      for (const l of [...entry.listeners]) l(status.state, previous);
      this.onAnyChange();
    };
    if (typeof status.addEventListener === "function") {
      status.addEventListener("change", onChange);
      entry.unhook = () => status.removeEventListener?.("change", onChange);
    } else {
      status.onchange = onChange;
      entry.unhook = () => {
        if (status.onchange === onChange) status.onchange = null;
      };
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.entries.values()) {
      entry.unhook?.();
      entry.listeners.clear();
    }
    this.entries.clear();
  }
}

type Stop = "cancelled" | "timeout";

export class WebDeviceHost implements DeviceEndpoint {
  readonly advertisement: DeviceHello;
  private client: DeviceClient | null = null;
  private ack: DeviceAck | undefined;
  private readonly dialog: ConsentDialog;
  private readonly cooldown: CooldownStore;
  private readonly origin: string;
  private readonly maxTimeoutMs: number;
  private readonly denialCooldownMs: number;
  private readonly maxDownloadBytes: number;
  private readonly capabilities: string[];
  private readonly extraDrivers: Record<string, DeviceDriver>;
  private readonly permissionDependencies: Record<string, string>;
  private readonly permissionsOption: PermissionsLike | undefined;
  private readonly doc: Document;
  private readonly mount: HTMLElement;
  private readonly protectionMs: number;
  private readonly theme: DeviceDialogTheme | undefined;
  private readonly mediaOption: MediaBackend | undefined;
  private mediaBackend: MediaBackend | null = null;
  private readonly bluetoothOption: BluetoothLike | undefined;
  private readonly geolocationOption: GeolocationLike | undefined;
  private readonly notificationsOption: NotificationsLike | undefined;
  private readonly micBufferBytes: number;
  private readonly videoBufferBytes: number;
  private readonly stopWhenHidden: boolean;
  private watcher: PermissionWatcher | null = null;
  /** Teardown of every live capture (camera/mic), run on detach. */
  private readonly captures = new Set<() => void>();
  /** Host-internal "advertisement changed" listeners (core.capabilities streams). */
  private readonly advertiseListeners = new Set<() => void>();
  /** At most one prompt-raising operation (dialog + platform picker) at once (§5). */
  private prompting = false;

  constructor(options: WebDeviceHostOptions) {
    this.origin = options.origin;
    this.extraDrivers = options.drivers ?? {};
    this.mediaOption = options.media;
    this.bluetoothOption = options.bluetooth;
    this.geolocationOption = options.geolocation;
    this.notificationsOption = options.notifications;
    this.micBufferBytes = options.captureBufferBytes?.mic ?? DEFAULT_MIC_BUFFER_BYTES;
    this.videoBufferBytes = options.captureBufferBytes?.video ?? DEFAULT_VIDEO_BUFFER_BYTES;
    this.stopWhenHidden = options.stopRecordingWhenHidden ?? true;
    this.permissionsOption = options.permissions;
    const mount = options.mount ?? document.body;
    this.mount = mount;
    this.doc = mount.ownerDocument;
    this.protectionMs = options.inputProtectionMs ?? DEFAULT_INPUT_PROTECTION_MS;
    this.theme = options.theme;
    // By default: every built-in this browser can actually drive (camera /
    // microphone / Web Bluetooth are feature-detected) plus host drivers.
    this.capabilities = options.capabilities ?? [
      ...new Set([
        ...BUILTIN_CAPABILITIES.filter((name) => this.platformSupports(name)),
        ...Object.keys(this.extraDrivers),
      ]),
    ];
    this.maxTimeoutMs = options.maxTimeoutMs ?? 300_000;
    this.denialCooldownMs = options.denialCooldownMs ?? 30_000;
    this.maxDownloadBytes = options.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
    this.permissionDependencies = {
      ...BUILTIN_PERMISSION_DEPENDENCIES,
      ...(options.permissionDependencies ?? {}),
    };
    this.dialog = new ConsentDialog(mount, this.protectionMs, this.theme);
    this.cooldown = new CooldownStore(options.origin);
    // Advertise only what the runtime can admit (a registry revision with a
    // generated schema) — never a name it would then refuse (RFC 001 §2.2).
    this.advertisement = {
      protocolVersions: [1],
      binary: true,
      capabilities: this.capabilities
        .map((name) => ({ name, versions: implementableVersions(name) }))
        .filter((c) => c.versions.length > 0),
    };
  }

  /** The negotiated selection, once the server acked. */
  get selected(): DeviceAck | undefined {
    return this.ack;
  }

  // ---- DeviceEndpoint ----

  attach(io: DeviceClientTransport): void {
    this.watcher?.dispose();
    this.watcher = new PermissionWatcher(
      () => this.permissionsApi(),
      () => this.advertiseChanged()
    );
    // Prime watches for every advertised capability's permission so changes
    // re-advertise even when no request is live.
    for (const cap of this.capabilities) {
      const perm = this.permissionDependencies[cap];
      if (perm) this.watcher.watch(perm);
    }
    this.client?.detach();
    this.ack = undefined;
    // The runtime owns admission, leases and the local deadline
    // min(timeoutMs, maxTimeoutMs) for every driver, built-in or host-supplied,
    // and the connection model: nothing is admitted before the sessionAck,
    // the first ack carrying `device` is final, app requests only after the
    // core.capabilities stream opened (RFC 001 §2.2).
    this.client = new DeviceClient(io, this.buildDrivers(), {
      maxTimeoutMs: this.maxTimeoutMs,
      requireHandshake: true,
    });
  }

  onAck(ack: DeviceAck | undefined): void {
    // Admit only the negotiated revisions from now on (RFC 001 §2.2). The
    // first selection is final for the socket (the runtime ignores later
    // ones, and so does `selected`).
    if (this.ack === undefined) this.ack = ack;
    this.client?.setSelection(ack);
  }

  handleMessage(message: DeviceRequest | DeviceEvent | DeviceResponse): void {
    this.client?.handleMessage(message);
  }

  handleText(text: string): void {
    this.client?.handleText(text);
  }

  handleMalformed(message: unknown, detail: string): void {
    this.client?.handleMalformed(message, detail);
  }

  handleFrame(frame: Uint8Array): void {
    this.client?.handleFrame(frame);
  }

  detach(): void {
    this.dialog.dismiss();
    for (const stop of [...this.captures]) stop();
    this.captures.clear();
    this.client?.detach();
    this.client = null;
    this.ack = undefined;
    this.watcher?.dispose();
    this.watcher = null;
  }

  // ---- drivers ----

  private permissionsApi(): PermissionsLike | undefined {
    if (this.permissionsOption) return this.permissionsOption;
    const nav = (this.doc.defaultView?.navigator ?? globalThis.navigator) as
      | (Navigator & { permissions?: PermissionsLike })
      | undefined;
    return nav?.permissions;
  }

  private media(): MediaBackend {
    if (this.mediaOption) return this.mediaOption;
    if (!this.mediaBackend) this.mediaBackend = browserMediaBackend(this.doc.defaultView);
    return this.mediaBackend;
  }

  private navigatorLike(): (Navigator & { bluetooth?: BluetoothLike }) | undefined {
    return (this.doc.defaultView?.navigator ?? globalThis.navigator) as
      | (Navigator & { bluetooth?: BluetoothLike })
      | undefined;
  }

  private bluetoothApi(): BluetoothLike | undefined {
    if (this.bluetoothOption) return this.bluetoothOption;
    const bt = this.navigatorLike()?.bluetooth;
    return bt && typeof bt.requestDevice === "function" ? bt : undefined;
  }

  private geolocationApi(): GeolocationLike | undefined {
    return this.geolocationOption ?? (this.navigatorLike()?.geolocation as GeolocationLike | undefined);
  }

  private notificationsApi(): NotificationsLike | undefined {
    if (this.notificationsOption) return this.notificationsOption;
    const N = ((this.doc.defaultView as unknown as { Notification?: NotificationsLike } | null)?.Notification ??
      (globalThis as unknown as { Notification?: NotificationsLike }).Notification);
    return N && typeof N.requestPermission === "function" ? N : undefined;
  }

  /** Whether this browser can drive a built-in capability at all. */
  private platformSupports(name: string): boolean {
    switch (name) {
      case "camera.capture":
        return typeof this.media().getUserMedia === "function";
      case "mic.record":
        return typeof this.media().getUserMedia === "function" && typeof this.media().openAudioCapture === "function";
      case "bluetooth.select":
        return this.bluetoothApi() !== undefined;
      default:
        return true;
    }
  }

  private advertiseChanged(): void {
    for (const l of [...this.advertiseListeners]) l();
  }

  private buildDrivers(): Map<string, DeviceDriver> {
    const builtins: Record<string, DeviceDriver> = {
      "core.capabilities": this.coreCapabilities,
      "gallery.pick": this.galleryPick,
      "file.pick": this.filePick,
      "file.save": this.fileSave,
      "permission.query": this.permissionQuery,
      "permission.request": this.permissionRequest,
      "camera.capture": this.cameraCapture,
      "mic.record": this.micRecord,
      "bluetooth.select": this.bluetoothSelect,
    };
    const all: Record<string, DeviceDriver> = { ...builtins, ...this.extraDrivers };
    const drivers = new Map<string, DeviceDriver>();
    for (const cap of this.capabilities) {
      const driver = all[cap];
      if (driver) drivers.set(cap, this.guard(cap, driver));
    }
    return drivers;
  }

  /**
   * Policy every driver runs under: no background lifetime on the web, and
   * revocation of a depended-on permission terminates the request.
   */
  private guard(capability: string, driver: DeviceDriver): DeviceDriver {
    return async (ctx) => {
      if (ctx.request.lifetime === "background") {
        // RFC 001 §5: no compliant always-visible background indicator here.
        return { kind: "error", code: "unavailable", platformDetail: "no-background-indicator" };
      }
      const permission = this.permissionDependencies[capability];
      const watcher = this.watcher;
      if (!permission || !watcher) return driver(ctx);

      let onRevoke!: () => void;
      const revoked = new Promise<"revoked">((resolve) => {
        onRevoke = () => resolve("revoked");
      });
      const unwatch = watcher.watch(permission, (state, previous) => {
        if (state === "denied" && previous !== "denied") onRevoke();
      });
      // The driver observes revocation as cancellation so it releases
      // hardware, dismisses prompts and clears buffers.
      const derived: DriverContext = Object.create(ctx, {
        cancelled: { value: Promise.race([ctx.cancelled, revoked.then(() => undefined)]) },
      });
      // Watch until the request is terminal, not merely until the driver
      // returned: a live capture (mic.record, camera video) hands its item
      // over and keeps recording while the runtime uploads it; a revocation
      // then ends the request through `ctx.fail` (RFC 001 §5).
      let returned = false;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        unwatch();
      };
      void ctx.cancelled.then(release);
      void revoked.then(() => {
        if (returned) ctx.fail?.("revoked", `permission:${permission}`);
      });
      try {
        const outcome = await Promise.race([driver(derived), revoked]);
        returned = true;
        if (outcome === "revoked") {
          release();
          return { kind: "error", code: "revoked", platformDetail: `permission:${permission}` };
        }
        // Without a runtime-managed context (`fail`), nothing can end the
        // request later: stop watching now.
        if (typeof ctx.fail !== "function") release();
        return outcome;
      } catch (err) {
        release();
        throw err;
      }
    };
  }

  /**
   * Connection-owned control stream: full advertisement now, and a full
   * replacement advertisement whenever a watched permission changes.
   */
  private coreCapabilities: DeviceDriver = async ({ emit, cancelled }) => {
    const advertise = () => emit({ capabilities: this.advertisement.capabilities });
    advertise();
    this.advertiseListeners.add(advertise);
    try {
      await cancelled;
    } finally {
      this.advertiseListeners.delete(advertise);
    }
    return { kind: "result", result: {} };
  };

  /**
   * Admission shared by every prompt-raising driver: cooldown, one prompt at
   * a time. Returns the error outcome to reply with, or a release function
   * holding the prompt slot.
   */
  private admit(ctx: DriverContext): { blocked: DriverOutcome } | { release: () => void } {
    const now = Date.now();
    if (this.cooldown.until(ctx.request.capability) > now) {
      return { blocked: { kind: "error", code: "throttled", platformDetail: "cooldown" } };
    }
    if (this.prompting || this.dialog.open) {
      return {
        blocked: { kind: "error", code: "throttled", platformDetail: "prompt-in-progress" },
      };
    }
    this.prompting = true;
    let held = true;
    return {
      release: () => {
        if (held) {
          held = false;
          this.prompting = false;
        }
      },
    };
  }

  /**
   * Resolves when the runtime stops the operation (server cancel, local
   * deadline, lease expiry, detach). The runtime has already sent the
   * terminal response; the driver's own outcome is then discarded.
   */
  private stopped(ctx: DriverContext): Promise<Stop> {
    return ctx.cancelled.then(() => "cancelled" as const);
  }

  /**
   * Present the host dialog raced against server cancel and the deadline.
   * Returns the trusted Continue event, or the terminal error outcome
   * (refusal sets the cooldown).
   */
  private async consent(
    ctx: DriverContext,
    stop: Promise<Stop>,
    verb: string,
    detail?: string[],
    drop?: DropZoneOptions
  ): Promise<{ ev: Event } | { files: File[] } | { outcome: DriverOutcome }> {
    const outcome = await Promise.race([
      this.dialog.present(this.origin, verb, detail, drop).then((ev) => ({ kind: "gesture" as const, ev })),
      stop.then((kind) => ({ kind })),
    ]);
    if (outcome.kind !== "gesture") {
      this.dialog.dismiss();
      return { outcome: { kind: "error", code: outcome.kind } };
    }
    if (outcome.ev === "dismissed") {
      // Torn down by the host itself (detach/stop), not a user refusal: no cooldown.
      return { outcome: { kind: "error", code: "cancelled", platformDetail: "dialog-dismissed" } };
    }
    if (!outcome.ev) {
      // Host refusal before admission is a denial with a cooldown (§2.6).
      this.cooldown.set(ctx.request.capability, Date.now() + this.denialCooldownMs);
      return { outcome: { kind: "error", code: "denied", platformDetail: "host-refused" } };
    }
    if ("kind" in outcome.ev && outcome.ev.kind === "drop") return { files: outcome.ev.files };
    return { ev: outcome.ev as Event };
  }

  private galleryPick: DeviceDriver = (ctx) => {
    const params = ctx.request.params as { mediaTypes?: unknown; maxCount?: unknown };
    const mediaTypes = Array.isArray(params.mediaTypes) ? params.mediaTypes : ["photo"];
    if (mediaTypes.length > 2 || mediaTypes.some((t) => t !== "photo" && t !== "video")) {
      return Promise.resolve({ kind: "error", code: "invalidParams", platformDetail: "mediaTypes" });
    }
    const accept = [...new Set(mediaTypes.map((t) => (t === "video" ? "video/*" : "image/*")))].join(",");
    return this.pick(ctx, VERB["gallery.pick"]!, accept, params.maxCount, false);
  };

  private filePick: DeviceDriver = (ctx) => {
    const params = ctx.request.params as { accept?: unknown; maxCount?: unknown };
    const accept = Array.isArray(params.accept) ? params.accept : [];
    if (
      accept.length > 32 ||
      // A comma would smuggle extra types into the accept attribute.
      accept.some((a) => typeof a !== "string" || a.length > 128 || a.includes(","))
    ) {
      return Promise.resolve({ kind: "error", code: "invalidParams", platformDetail: "accept" });
    }
    const acceptAttr = (accept as string[]).map((a) => a.trim()).filter(Boolean).join(",");
    return this.pick(ctx, VERB["file.pick"]!, acceptAttr, params.maxCount, true);
  };

  /** Shared picker flow for gallery.pick / file.pick. */
  private async pick(
    ctx: DriverContext,
    verb: string,
    accept: string,
    rawMaxCount: unknown,
    withNames: boolean
  ): Promise<DriverOutcome> {
    if (
      rawMaxCount !== undefined &&
      (typeof rawMaxCount !== "number" || !Number.isInteger(rawMaxCount) || rawMaxCount < 1 || rawMaxCount > 16)
    ) {
      return { kind: "error", code: "invalidParams", platformDetail: "maxCount" };
    }
    const maxCount = (rawMaxCount as number | undefined) ?? 1;

    const admission = this.admit(ctx);
    if ("blocked" in admission) return admission.blocked;
    const stop = this.stopped(ctx);
    try {
      // Host-owned consent + activation: the picker opens inside the trusted
      // Continue click's activation window. The dialog also carries a
      // host-owned drop zone: dropping files onto it is the same per-use
      // choice as picking them, so no OS picker is needed then.
      const consent = await this.consent(ctx, stop, verb, undefined, { accept, multiple: maxCount > 1 });
      if ("outcome" in consent) return consent.outcome;

      const files = "files" in consent ? consent.files : await this.openFilePicker(accept, maxCount > 1, stop);
      if (files === "cancelled" || files === "timeout") return { kind: "error", code: files };
      if (files.length === 0) {
        return { kind: "error", code: "cancelled", platformDetail: "picker-dismissed" };
      }
      admission.release();

      // Check sizes against the revision before reading anything into memory
      // (RFC 001 §2.4/§5: bound buffers; never allocate for an oversize item).
      const chosen = files.slice(0, maxCount);
      const maxItemBytes = ctx.revision?.maxItemBytes ?? DEFAULT_MAX_ITEM_BYTES;
      if (chosen.some((f) => f.size > maxItemBytes)) {
        return { kind: "error", code: "throttled", platformDetail: "item exceeds size limit" };
      }

      const blobs: Array<DriverBlob & { name?: string }> = [];
      let channel = 0;
      let stoppedEarly = false;
      void stop.then(() => (stoppedEarly = true));
      for (const file of chosen) {
        if (stoppedEarly) return { kind: "error", code: "cancelled" };
        // Stream each file (decision D5): the runtime pulls chunks only as
        // credit allows and hashes incrementally, so a large pick is never
        // held in memory whole. The picked file's size is known, so it is
        // declared. Engines without `Blob.stream()` read it at once.
        const source =
          typeof (file as Blob & { stream?: unknown }).stream === "function"
            ? { stream: readBlobStream(file), declaredBytes: file.size }
            : { bytes: new Uint8Array(await file.arrayBuffer()) };
        const blob: DriverBlob & { name?: string } = {
          channel: channel++,
          contentType: file.type || "application/octet-stream",
          ...source,
        };
        // file.pick items carry `name` (file.pick-v1 FileItem). The core
        // runtime assembles `items` from blobs; the name rides on the blob.
        if (withNames) blob.name = file.name.slice(0, 512);
        blobs.push(blob);
      }
      return { kind: "result", result: {}, blobs };
    } finally {
      admission.release();
    }
  }

  /**
   * Open `<input type=file>` synchronously (must be called within the
   * activation window). Resolves with the chosen files, `[]` when the picker
   * is dismissed, or the stop reason if the server cancelled / deadline hit.
   */
  private openFilePicker(accept: string, multiple: boolean, stop: Promise<Stop>): Promise<File[] | Stop> {
    return new Promise((resolve) => {
      const doc = this.doc;
      const input = doc.createElement("input");
      input.type = "file";
      input.accept = accept;
      input.multiple = multiple;
      input.setAttribute("data-hypen-device", "file-input");
      input.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0";
      let settled = false;
      const done = (v: File[] | Stop) => {
        if (settled) return;
        settled = true;
        input.remove();
        resolve(v);
      };
      input.addEventListener("change", () => done(Array.from(input.files ?? [])));
      // Modern Chromium fires `cancel` when the dialog is dismissed.
      input.addEventListener("cancel", () => done([]));
      void stop.then((reason) => done(reason));
      (doc.body ?? doc.documentElement).append(input);
      input.click();
    });
  }

  private fileSave: DeviceDriver = async (ctx) => {
    const download = (ctx as DownloadDriverContext).download;
    if (!download) {
      return { kind: "error", code: "unavailable", platformDetail: "no-download-sink" };
    }
    const declared = download.declared;
    // RFC 001 §2.4: validate limits before showing any interaction.
    if (
      typeof declared.bytes !== "number" ||
      !Number.isInteger(declared.bytes) ||
      declared.bytes < 1 ||
      declared.bytes > this.maxDownloadBytes
    ) {
      return {
        kind: "error",
        code: "invalidParams",
        platformDetail: `size ${declared.bytes} exceeds client max ${this.maxDownloadBytes}`,
      };
    }
    if (typeof declared.name !== "string" || declared.name.length === 0 || declared.name.length > 512) {
      return { kind: "error", code: "invalidParams", platformDetail: "name" };
    }
    const name = safeFileName(declared.name);
    const shown = describeFileName(name);
    const contentType =
      typeof declared.contentType === "string" && declared.contentType.length <= 256
        ? declared.contentType
        : "application/octet-stream";

    const admission = this.admit(ctx);
    if ("blocked" in admission) return admission.blocked;
    const stop = this.stopped(ctx);
    try {
      const consent = await this.consent(ctx, stop, VERB["file.save"]!, [
        `Name: ${shown.base}`,
        `Type: ${shown.extension ? `.${shown.extension}` : "(none)"} · ${contentType}`,
        `Size: ${formatBytes(declared.bytes)}`,
      ]);
      if ("outcome" in consent) return consent.outcome;

      const view = this.doc.defaultView as (Window & { showSaveFilePicker?: ShowSaveFilePicker }) | null;
      if (view && typeof view.showSaveFilePicker === "function") {
        return await this.saveWithPicker(view.showSaveFilePicker.bind(view), download, name, contentType, stop, admission.release);
      }
      admission.release();
      return await this.saveWithAnchor(download, name, contentType, stop);
    } finally {
      admission.release();
    }
  };

  /** File System Access path: destination picker inside the trusted click. */
  private async saveWithPicker(
    showSaveFilePicker: ShowSaveFilePicker,
    download: DownloadSinkLike,
    name: string,
    contentType: string,
    stop: Promise<Stop>,
    releasePrompt: () => void
  ): Promise<DriverOutcome> {
    let handle: SaveFileHandle;
    try {
      const picked = await Promise.race([
        showSaveFilePicker({ suggestedName: name }).then((h) => ({ h })),
        stop.then((reason) => ({ reason })),
      ]);
      if ("reason" in picked) return { kind: "error", code: picked.reason };
      handle = picked.h;
    } catch (err) {
      if (isAbortError(err)) {
        return { kind: "error", code: "cancelled", platformDetail: "picker-dismissed" };
      }
      return { kind: "error", code: "unavailable", platformDetail: errorDetail(err) };
    }
    // Destination chosen: the prompt is over; the transfer is not a prompt.
    releasePrompt();

    let writable: SaveWritable;
    try {
      writable = await handle.createWritable();
    } catch (err) {
      return { kind: "error", code: "unavailable", platformDetail: errorDetail(err) };
    }
    // Only now grant credit (receiveAll) — consent + destination complete.
    const received = await this.receive(download, stop);
    if ("outcome" in received) {
      await writable.abort?.().catch(() => undefined);
      return received.outcome;
    }
    try {
      await writable.write(new Blob([received.bytes as BlobPart], { type: contentType }));
      await writable.close(); // commits the temp file atomically
    } catch (err) {
      await writable.abort?.().catch(() => undefined);
      return { kind: "error", code: "internal", platformDetail: errorDetail(err) };
    }
    return { kind: "result", result: { bytesWritten: received.bytes.byteLength } };
  }

  /** Fallback: hand verified bytes to the browser download manager. */
  private async saveWithAnchor(
    download: DownloadSinkLike,
    name: string,
    contentType: string,
    stop: Promise<Stop>
  ): Promise<DriverOutcome> {
    const received = await this.receive(download, stop);
    if ("outcome" in received) return received.outcome;

    const view = this.doc.defaultView as (Window & typeof globalThis) | null;
    // Pair a Blob with the realm whose URL can mint object URLs.
    const realm =
      view && typeof view.URL?.createObjectURL === "function" ? view : globalThis;
    const blob = new realm.Blob([received.bytes as BlobPart], { type: contentType });
    const url = realm.URL.createObjectURL(blob);
    const a = this.doc.createElement("a");
    a.href = url;
    a.download = name;
    a.rel = "noopener";
    a.style.display = "none";
    a.setAttribute("data-hypen-device", "download-link");
    (this.doc.body ?? this.doc.documentElement).append(a);
    try {
      a.click();
    } finally {
      a.remove();
      // Give the download manager time to read the URL before revoking it.
      setTimeout(() => realm.URL.revokeObjectURL(url), 10_000);
    }
    return { kind: "result", result: { bytesWritten: received.bytes.byteLength } };
  }

  /** `receiveAll()` raced against stop; rejections map to their error code. */
  private async receive(
    download: DownloadSinkLike,
    stop: Promise<Stop>
  ): Promise<{ bytes: Uint8Array } | { outcome: DriverOutcome }> {
    try {
      const raced = await Promise.race([
        download.receiveAll().then((bytes) => ({ bytes })),
        stop.then((reason) => ({ reason })),
      ]);
      if ("reason" in raced) return { outcome: { kind: "error", code: raced.reason } };
      if (raced.bytes.byteLength !== download.declared.bytes) {
        return {
          outcome: { kind: "error", code: "invalidParams", platformDetail: "size-mismatch" },
        };
      }
      return { bytes: raced.bytes };
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      return {
        outcome: {
          kind: "error",
          code: typeof code === "string" && ERROR_CODES.has(code) ? (code as DeviceErrorCode) : "internal",
          platformDetail: errorDetail(err),
        },
      };
    }
  }

  // ---- permissions (P1) ----

  /**
   * Current status of an enum permission, or the `unsupported` outcome when
   * the web cannot represent it (platformDetail = the permission name).
   */
  private async permissionStatus(
    permission: DevicePermission
  ): Promise<{ status: "granted" | "denied" | "prompt" } | { outcome: DriverOutcome }> {
    const unsupported = { outcome: { kind: "error", code: "unsupported", platformDetail: permission } as DriverOutcome };
    switch (permission) {
      case "photos":
        // The web file picker needs no permission.
        return { status: "granted" };
      case "bluetooth":
        // Web Bluetooth grants per device through its chooser.
        return this.bluetoothApi() ? { status: "prompt" } : unsupported;
      case "contacts":
        return unsupported;
      default:
        break;
    }
    const apiName = PERMISSION_API_NAME[permission];
    if (!apiName) return unsupported;
    const perms = this.permissionsApi();
    if (perms) {
      try {
        const status = await perms.query({ name: apiName });
        return { status: normalizeState(status.state) };
      } catch {
        /* unqueryable here: fall through to the API-specific fallback */
      }
    }
    // The Permissions API cannot say (older engines): the permission still
    // exists wherever its platform API does, undecided until it prompts.
    switch (permission) {
      case "notifications": {
        const n = this.notificationsApi();
        return n ? { status: normalizeState(n.permission) } : unsupported;
      }
      case "camera":
      case "microphone":
        return typeof this.media().getUserMedia === "function" ? { status: "prompt" } : unsupported;
      case "location":
        return this.geolocationApi() ? { status: "prompt" } : unsupported;
      default:
        return unsupported;
    }
  }

  private permissionQuery: DeviceDriver = async (ctx) => {
    const permission = (ctx.request.params as { permission: DevicePermission }).permission;
    const current = await this.permissionStatus(permission);
    return "outcome" in current ? current.outcome : { kind: "result", result: { status: current.status } };
  };

  private permissionRequest: DeviceDriver = async (ctx) => {
    const permission = (ctx.request.params as { permission: DevicePermission }).permission;
    const current = await this.permissionStatus(permission);
    if ("outcome" in current) return current.outcome;
    // Already decided (or not promptable on the web: photos/bluetooth) —
    // answer without a dialog; a denied browser permission cannot be
    // re-prompted by the page anyway.
    const verb = PERMISSION_VERB[permission];
    if (current.status !== "prompt" || !verb) return { kind: "result", result: { status: current.status } };

    const admission = this.admit(ctx);
    if ("blocked" in admission) return admission.blocked;
    const stop = this.stopped(ctx);
    try {
      ctx.emit({ kind: "progress", state: "pendingConsent" });
      const consent = await this.consent(ctx, stop, verb);
      if ("outcome" in consent) return consent.outcome;
      ctx.emit({ kind: "progress", state: "running" });
      // Inside the trusted Continue's activation window.
      const prompted = await Promise.race([this.promptPermission(permission), stop.then((reason) => ({ reason }))]);
      if ("reason" in prompted) return { kind: "error", code: prompted.reason };
      return prompted.outcome;
    } finally {
      admission.release();
    }
  };

  /** Raise the platform's own prompt for a promptable permission. */
  private async promptPermission(permission: DevicePermission): Promise<{ outcome: DriverOutcome }> {
    const granted = (status: "granted" | "denied" | "prompt") => ({
      outcome: { kind: "result", result: { status } } as DriverOutcome,
    });
    switch (permission) {
      case "camera":
      case "microphone": {
        const getUserMedia = this.media().getUserMedia;
        if (!getUserMedia) return { outcome: { kind: "error", code: "unsupported", platformDetail: permission } };
        try {
          const stream = await getUserMedia(permission === "camera" ? { video: true } : { audio: true });
          stopStream(stream); // only the grant was wanted
          return granted("granted");
        } catch (err) {
          const mapped = mediaErrorOutcome(err);
          return mapped.code === "denied" ? granted("denied") : { outcome: { kind: "error", ...mapped } };
        }
      }
      case "location": {
        const geo = this.geolocationApi();
        if (!geo) return { outcome: { kind: "error", code: "unsupported", platformDetail: permission } };
        const status = await new Promise<"granted" | "denied">((resolve) => {
          try {
            geo.getCurrentPosition(
              () => resolve("granted"),
              // Code 1 = PERMISSION_DENIED; unavailable/timeout mean the
              // permission itself was granted.
              (err) => resolve(err?.code === 1 ? "denied" : "granted"),
              { maximumAge: Number.POSITIVE_INFINITY, timeout: 30_000 }
            );
          } catch {
            resolve("denied");
          }
        });
        return granted(status);
      }
      case "notifications": {
        const n = this.notificationsApi();
        if (!n) return { outcome: { kind: "error", code: "unsupported", platformDetail: permission } };
        const result = await n.requestPermission();
        return granted(normalizeState(result));
      }
      default:
        return { outcome: { kind: "error", code: "unsupported", platformDetail: permission } };
    }
  }

  /**
   * Refuse up front when the browser already denied a permission the
   * capture needs: the page cannot re-prompt, so no dialog is shown.
   */
  private async deniedUpFront(permission: "camera" | "microphone"): Promise<DriverOutcome | null> {
    const perms = this.permissionsApi();
    if (!perms) return null;
    try {
      const status = await perms.query({ name: permission });
      if (status.state === "denied") {
        return { kind: "error", code: "denied", platformDetail: `permission:${permission}` };
      }
    } catch {
      /* unqueryable: getUserMedia decides */
    }
    return null;
  }

  // ---- camera.capture (C2) ----

  private cameraCapture: DeviceDriver = async (ctx) => {
    const params = ctx.request.params as { mode: "photo" | "video"; facing?: "front" | "back"; maxDurationMs?: number };
    const media = this.media();
    const getUserMedia = media.getUserMedia;
    if (!getUserMedia) return { kind: "error", code: "unsupported", platformDetail: "no-getUserMedia" };
    if (params.mode === "photo" && params.maxDurationMs !== undefined) {
      return { kind: "error", code: "invalidParams", platformDetail: "maxDurationMs is video-only" };
    }
    const refused = await this.deniedUpFront("camera");
    if (refused) return refused;

    const admission = this.admit(ctx);
    if ("blocked" in admission) return admission.blocked;
    const stop = this.stopped(ctx);
    let stream: MediaStreamLike | null = null;
    let dialog: CaptureDialog | null = null;
    let recorder: RecorderLike | null = null;
    let handedOver = false; // a live video item belongs to the runtime now
    // The user's actions in the capture dialog, in order. A pending
    // `nextAction()` is shared by every caller until an action arrives, so
    // an abandoned race never swallows one.
    const queuedActions: CaptureAction[] = [];
    let pendingAction: Promise<CaptureAction> | null = null;
    let deliver: ((a: CaptureAction) => void) | null = null;
    const actions = (a: CaptureAction) => {
      if (deliver) {
        const d = deliver;
        deliver = null;
        pendingAction = null;
        d(a);
      } else queuedActions.push(a);
    };
    const nextAction = (): Promise<CaptureAction> => {
      const queued = queuedActions.shift();
      if (queued) return Promise.resolve(queued);
      if (!pendingAction) pendingAction = new Promise<CaptureAction>((resolve) => (deliver = resolve));
      return pendingAction;
    };
    const cleanup = () => {
      if (recorder && recorder.state !== "inactive") {
        try {
          recorder.stop();
        } catch {
          /* already stopped */
        }
      }
      stopStream(stream);
      stream = null;
      dialog?.close();
      dialog = null;
      admission.release();
      this.captures.delete(cleanup);
    };
    this.captures.add(cleanup);
    void stop.then(() => cleanup());

    try {
      ctx.emit({ kind: "progress", state: "pendingConsent" });
      dialog = new CaptureDialog(this.mount, this.origin, params.mode, this.protectionMs, (a) => actions(a), this.theme);
      const facingMode = params.facing === "front" ? "user" : params.facing === "back" ? "environment" : undefined;
      const video: MediaTrackConstraints | boolean = facingMode ? { facingMode: { ideal: facingMode } } : true;
      const opening = this.openCamera(getUserMedia, video, params.mode === "video");
      const opened = await Promise.race([
        opening.then(
          (s) => ({ s }),
          (err: unknown) => ({ err })
        ),
        stop.then((reason) => ({ reason })),
        nextAction().then((a) => ({ early: a })),
      ]);
      if (!("s" in opened)) {
        // A camera that opens after the request ended is released at once.
        opening.then(stopStream, () => undefined);
      }
      if ("reason" in opened) return { kind: "error", code: opened.reason };
      if ("early" in opened) {
        // Cancel before the camera even started.
        this.cooldown.set(ctx.request.capability, Date.now() + this.denialCooldownMs);
        return { kind: "error", code: "cancelled", platformDetail: "capture-cancelled" };
      }
      if ("err" in opened) return { kind: "error", ...mediaErrorOutcome(opened.err) };
      stream = opened.s;
      if (!dialog) {
        stopStream(stream);
        return { kind: "error", code: "cancelled" };
      }
      await media.attachPreview(dialog.video, stream);
      dialog.ready();

      const action = await Promise.race([nextAction(), stop]);
      if (action === "cancelled" || action === "timeout") return { kind: "error", code: action };
      if (action === "cancel" || action === "stop") {
        this.cooldown.set(ctx.request.capability, Date.now() + this.denialCooldownMs);
        return { kind: "error", code: "cancelled", platformDetail: "capture-cancelled" };
      }
      ctx.emit({ kind: "progress", state: "running" });

      if (params.mode === "photo") {
        dialog.busy("Capturing…");
        let jpeg: Blob;
        try {
          jpeg = await media.snapshot(dialog.video);
        } catch (err) {
          return { kind: "error", code: "internal", platformDetail: errorDetail(err) };
        }
        const bytes = new Uint8Array(await jpeg.arrayBuffer());
        cleanup();
        if (bytes.byteLength === 0) return { kind: "error", code: "internal", platformDetail: "empty-photo" };
        return { kind: "result", result: {}, blobs: [{ channel: 0, contentType: "image/jpeg", bytes }] };
      }

      // Video: stream MediaRecorder output as it is encoded (undeclared size).
      const made = media.createRecorder(stream);
      if (!made || !["video/webm", "video/mp4", "video/quicktime"].includes(made.contentType)) {
        return { kind: "error", code: "unavailable", platformDetail: "no-video-recorder" };
      }
      recorder = made.recorder;
      const rec = recorder;
      const queue = new LiveQueue(this.videoBufferBytes, () => cleanup());
      // Recorder chunks are read strictly in order (each Blob read chained
      // after the previous one), then the item ends after the last read.
      let reads: Promise<void> = Promise.resolve();
      rec.ondataavailable = (ev) => {
        const data = ev.data;
        if (!data || data.size === 0) return;
        reads = reads.then(async () => {
          if (queue.closed) return;
          let buf: ArrayBuffer;
          try {
            buf = await data.arrayBuffer();
          } catch (err) {
            queue.fail(codedError("internal", errorDetail(err)));
            return;
          }
          if (queue.push(new Uint8Array(buf)) === "full") {
            // Starved of credit past the bounded window (§2.4).
            ctx.fail?.("throttled", "capture-buffer-full");
            queue.fail(codedError("throttled", "capture-buffer-full"));
            cleanup();
          }
        });
      };
      rec.onstop = () => {
        stopStream(stream);
        dialog?.close();
        reads = reads.then(() => queue.end());
      };
      rec.onerror = (ev) => {
        queue.fail(codedError("internal", `recorder: ${errorDetail((ev as { error?: unknown })?.error ?? ev)}`));
        cleanup();
      };
      const finishRecording = () => {
        if (rec.state !== "inactive") {
          try {
            rec.stop();
          } catch {
            /* already stopped */
          }
        }
      };
      try {
        rec.start(VIDEO_TIMESLICE_MS);
      } catch (err) {
        return { kind: "error", code: "unavailable", platformDetail: errorDetail(err) };
      }
      dialog.startedRecording();
      handedOver = true;
      // Stop / limit / hidden page end the recording normally (success).
      const limit = params.maxDurationMs;
      const timer = limit !== undefined ? setTimeout(finishRecording, limit) : null;
      const onHidden = () => {
        if (this.stopWhenHidden && this.doc.visibilityState === "hidden") finishRecording();
      };
      this.doc.addEventListener("visibilitychange", onHidden);
      void (async () => {
        for (;;) {
          const a = await Promise.race([nextAction(), stop.then(() => "ended" as const)]);
          if (a === "ended") break;
          if (a === "stop") {
            finishRecording();
            break;
          }
          if (a === "cancel") {
            // Cancel mid-recording discards it (§5: the user's Cancel).
            ctx.fail?.("cancelled", "capture-cancelled");
            queue.fail(codedError("cancelled", "capture-cancelled"));
            cleanup();
            break;
          }
        }
      })();
      const unhook = () => {
        if (timer !== null) clearTimeout(timer);
        this.doc.removeEventListener("visibilitychange", onHidden);
      };
      void stop.then(unhook);
      // Ended (Stop / limit / hidden), failed or released: the dialog, the
      // camera and the prompt slot go.
      queue.onDone(() => {
        unhook();
        cleanup();
      });
      return {
        kind: "result",
        result: {},
        blobs: [{ channel: 0, contentType: made.contentType, stream: queue }],
      };
    } finally {
      if (!handedOver) cleanup();
    }
  };

  /** getUserMedia for the camera (+ microphone for video when present). */
  private async openCamera(
    getUserMedia: NonNullable<MediaBackend["getUserMedia"]>,
    video: MediaTrackConstraints | boolean,
    withAudio: boolean
  ): Promise<MediaStreamLike> {
    if (!withAudio) return getUserMedia({ video });
    try {
      return await getUserMedia({ video, audio: true });
    } catch (err) {
      // No microphone at all: a silent video is still a video.
      const name = (err as { name?: unknown } | null)?.name;
      if (name === "NotFoundError" || name === "OverconstrainedError") return getUserMedia({ video });
      throw err;
    }
  }

  // ---- mic.record (C3) ----

  private micRecord: DeviceDriver = async (ctx) => {
    const params = ctx.request.params as {
      format: "pcm16";
      sampleRate: number;
      channels?: 1 | 2;
      maxDurationMs?: number;
    };
    const media = this.media();
    const getUserMedia = media.getUserMedia;
    const openAudioCapture = media.openAudioCapture;
    if (!getUserMedia || !openAudioCapture) {
      return { kind: "error", code: "unsupported", platformDetail: "no-audio-capture" };
    }
    const channels = params.channels ?? 1;
    const refused = await this.deniedUpFront("microphone");
    if (refused) return refused;

    const admission = this.admit(ctx);
    if ("blocked" in admission) return admission.blocked;
    const stop = this.stopped(ctx);
    let handedOver = false;
    let stream: MediaStreamLike | null = null;
    let capture: AudioCaptureLike | null = null;
    let indicator: RecordingIndicator | null = null;
    const teardown = () => {
      capture?.close();
      capture = null;
      stopStream(stream);
      stream = null;
      indicator?.close();
      indicator = null;
      admission.release();
      this.captures.delete(teardown);
    };
    this.captures.add(teardown);
    void stop.then(() => teardown());
    try {
      ctx.emit({ kind: "progress", state: "pendingConsent" });
      const detail = [
        `Format: PCM16 · ${params.sampleRate} Hz · ${channels === 2 ? "stereo" : "mono"}`,
        ...(params.maxDurationMs !== undefined ? [`Up to ${formatDuration(params.maxDurationMs)}`] : []),
      ];
      const consent = await this.consent(ctx, stop, VERB["mic.record"]!, detail);
      if ("outcome" in consent) return consent.outcome;

      const opening = getUserMedia({
        audio: {
          channelCount: { ideal: channels },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      const opened = await Promise.race([
        opening.then(
          (s) => ({ s }),
          (err: unknown) => ({ err })
        ),
        stop.then((reason) => ({ reason })),
      ]);
      if ("reason" in opened) {
        opening.then(stopStream, () => undefined); // opened too late: release
        return { kind: "error", code: opened.reason };
      }
      if ("err" in opened) return { kind: "error", ...mediaErrorOutcome(opened.err) };
      stream = opened.s;

      const queue = new LiveQueue(this.micBufferBytes, () => teardown());
      let encoder: PcmEncoder | null = null;
      let finishing = false;
      const maxFrames =
        params.maxDurationMs !== undefined ? Math.ceil((params.maxDurationMs * params.sampleRate) / 1000) : undefined;
      const finish = () => {
        // Stop is success: flush what the graph holds, then end the item.
        if (finishing) return;
        finishing = true;
        const c = capture;
        void (c ? c.flush() : Promise.resolve()).then(() => {
          capture?.close();
          capture = null;
          stopStream(stream);
          indicator?.close();
          indicator = null;
          queue.end();
        });
      };
      const overflow = () => {
        ctx.fail?.("throttled", "capture-buffer-full");
        queue.fail(codedError("throttled", "capture-buffer-full"));
        teardown();
      };
      const onBlock = (planar: Float32Array[]) => {
        if (!encoder || queue.closed) return;
        const bytes = encoder.push(planar);
        const pushed = bytes.byteLength > 0 ? queue.push(bytes) : "ok";
        if (pushed === "full") {
          overflow();
          return;
        }
        if (pushed === "closed") return;
        if (encoder.full) finish();
      };
      try {
        const starting = openAudioCapture(stream, channels, onBlock);
        const started = await Promise.race([starting.then((c) => ({ c })), stop.then((reason) => ({ reason }))]);
        if ("reason" in started) {
          starting.then((c) => c.close(), () => undefined); // started too late: tear down
          return { kind: "error", code: started.reason };
        }
        capture = started.c;
      } catch (err) {
        return { kind: "error", code: "unavailable", platformDetail: errorDetail(err) };
      }
      encoder = new PcmEncoder(capture.sampleRate, params.sampleRate, channels, maxFrames);
      indicator = new RecordingIndicator(this.mount, this.origin, finish);
      ctx.emit({ kind: "progress", state: "running" });
      const onHidden = () => {
        if (this.stopWhenHidden && this.doc.visibilityState === "hidden") finish();
      };
      this.doc.addEventListener("visibilitychange", onHidden);
      const unhook = () => this.doc.removeEventListener("visibilitychange", onHidden);
      void stop.then(unhook);
      queue.onDone(() => {
        unhook();
        teardown();
      });
      // The indicator is not a prompt: other prompts may run meanwhile.
      admission.release();
      handedOver = true;
      const enc = encoder;
      return {
        kind: "result",
        result: {},
        blobs: [{ channel: 0, contentType: "audio/L16", stream: queue }],
        complete: () => ({ durationMs: enc.durationMs }),
      };
    } finally {
      if (!handedOver) teardown();
    }
  };

  // ---- bluetooth.select (C4) ----

  private bluetoothSelect: DeviceDriver = async (ctx) => {
    const params = ctx.request.params as { services?: string[]; namePrefix?: string };
    const bluetooth = this.bluetoothApi();
    if (!bluetooth) return { kind: "error", code: "unsupported", platformDetail: "no-web-bluetooth" };
    const services = params.services ?? [];
    const filter: { services?: string[]; namePrefix?: string } = {};
    if (services.length > 0) filter.services = [...services];
    if (params.namePrefix !== undefined) filter.namePrefix = params.namePrefix;
    const options =
      Object.keys(filter).length > 0
        ? { filters: [filter], ...(services.length > 0 ? { optionalServices: [...services] } : {}) }
        : { acceptAllDevices: true };

    const admission = this.admit(ctx);
    if ("blocked" in admission) return admission.blocked;
    const stop = this.stopped(ctx);
    try {
      ctx.emit({ kind: "progress", state: "pendingConsent" });
      const detail = [
        ...(services.length > 0 ? [`Services: ${services.join(", ")}`] : []),
        ...(params.namePrefix !== undefined ? [`Name starts with: ${params.namePrefix}`] : []),
      ];
      const consent = await this.consent(ctx, stop, VERB["bluetooth.select"]!, detail);
      if ("outcome" in consent) return consent.outcome;
      ctx.emit({ kind: "progress", state: "running" });
      // The browser's chooser opens inside the trusted Continue's activation.
      let picked: { device: { id: string; name?: string | null } } | { reason: Stop };
      try {
        picked = await Promise.race([
          bluetooth.requestDevice(options).then((device) => ({ device })),
          stop.then((reason) => ({ reason })),
        ]);
      } catch (err) {
        const name = (err as { name?: unknown } | null)?.name;
        if (name === "NotFoundError" || name === "AbortError") {
          return { kind: "error", code: "cancelled", platformDetail: "chooser-dismissed" };
        }
        if (name === "SecurityError" || name === "NotAllowedError") {
          return { kind: "error", code: "denied", platformDetail: errorDetail(err) };
        }
        return { kind: "error", code: "unavailable", platformDetail: errorDetail(err) };
      }
      if ("reason" in picked) return { kind: "error", code: picked.reason };
      const id = typeof picked.device.id === "string" ? truncateCodePoints(picked.device.id, 128) : "";
      if (id.length === 0) return { kind: "error", code: "internal", platformDetail: "device without an id" };
      const name = picked.device.name;
      return {
        kind: "result",
        result: {
          device: { id, ...(typeof name === "string" ? { name: truncateCodePoints(name, 256) } : {}) },
        },
      };
    } finally {
      admission.release();
    }
  };
}

function normalizeState(state: string): "granted" | "denied" | "prompt" {
  if (state === "granted" || state === "denied") return state;
  return "prompt"; // "prompt", "default", or anything a browser adds later
}

function truncateCodePoints(text: string, max: number): string {
  const cps = Array.from(text);
  return cps.length <= max ? text : cps.slice(0, max).join("");
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  return s < 60 ? `${Math.round(s * 10) / 10} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}

/**
 * A Blob's bytes as an async iterable of chunks. Returning early (the
 * request stopped) cancels the underlying read.
 */
async function* readBlobStream(blob: Blob): AsyncGenerator<Uint8Array> {
  const reader = (blob.stream() as ReadableStream<Uint8Array>).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value && value.byteLength > 0) yield value;
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

// ---- File System Access (not in lib.dom) ----

interface SaveWritable {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}
interface SaveFileHandle {
  createWritable(): Promise<SaveWritable>;
}
type ShowSaveFilePicker = (options?: { suggestedName?: string }) => Promise<SaveFileHandle>;

function isAbortError(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === "AbortError";
}

function errorDetail(err: unknown): string {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return msg.slice(0, 512);
}
