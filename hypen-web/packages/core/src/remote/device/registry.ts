/**
 * Device Capability Protocol — per-revision registry bounds (RFC 001 §3).
 *
 * Hand-mirrored from `registry()` in hypen-engine-rs/src/serialize/device.rs
 * (the reference). `tests/device-credit.test.ts` parses that Rust source and
 * `tests/device-srv-conformance.test.ts` compares against the exported
 * engine-compatibility-tests/schema/device/registry-v1.json; both fail when
 * this table drifts. It serves the CLIENT runtime (`DeviceClient`, the
 * `RemoteEngine` hello) and the typed API's revision shapes only: data plane
 * direction, allowed lifetimes, and the numeric bounds for items, credit and
 * deadlines. Everything server-side — the advertisement, which revisions a
 * server consumes, handshake selection and the broker's enforcement — is the
 * Rust registry's, reached through the broker port (overrides go through
 * `DeviceBrokerConfig.revisionOverrides`).
 *
 * The table is injectable (`DeviceClient` options) so tests can exercise
 * revisions that do not exist in v1 yet without editing the real registry.
 */

import type { DeviceLifetime } from "./generated.js";

export type DeviceDataPlane = "none" | "jsonEvents" | "binaryUpload" | "binaryDownload";
/** Consent policy enforced by DeviceHost (§2.6/§5). */
export type DeviceConsent = "none" | "perUse" | "persistable";
/** Data-plane overflow policy when credit is exhausted (§2.3). */
export type DeviceOverflow = "none" | "dropOldest" | "pause";

export interface DeviceRevisionBounds {
  version: number;
  mode: "unary" | "stream";
  data: DeviceDataPlane;
  consent: DeviceConsent;
  overflow: DeviceOverflow;
  /** Lifetimes a request may select. First entry is the default. */
  lifetimes: readonly DeviceLifetime[];
  /** Hard cap on a single blob item, bytes (0 = no blob items). */
  maxItemBytes: number;
  /** Hard cap on blob items / channels per request. */
  maxItems: number;
  /** Upper bound for `initialCredit` (0 for server→client data planes). */
  maxInitialCredit: number;
  /** Upper bound on outstanding (granted, unspent) credit. */
  maxOutstandingCredit: number;
  /** Upper bound a request's `timeoutMs` may take. */
  maxTimeoutMs: number;
}

/** capability name → revisions ascending by version. */
export type DeviceRegistry = ReadonlyMap<string, readonly DeviceRevisionBounds[]>;

const KIB = 1024;
const MIB = 1024 * 1024;

const ACTIVATION_ONLY: readonly DeviceLifetime[] = ["activation"];
const CONNECTION_ONLY: readonly DeviceLifetime[] = ["connection"];

/** The provisional v1 registry bounds, mirrored from the Rust reference. */
export const DEVICE_REGISTRY: DeviceRegistry = new Map<string, readonly DeviceRevisionBounds[]>([
  [
    "core.capabilities",
    [
      {
        version: 1,
        mode: "stream",
        data: "jsonEvents",
        consent: "none",
        overflow: "dropOldest",
        lifetimes: CONNECTION_ONLY,
        maxItemBytes: 0,
        maxItems: 0,
        maxInitialCredit: 64,
        maxOutstandingCredit: 64,
        maxTimeoutMs: 86_400_000,
      },
    ],
  ],
  [
    "bluetooth.scan",
    [
      {
        version: 1,
        mode: "stream",
        data: "jsonEvents",
        consent: "persistable",
        overflow: "dropOldest",
        lifetimes: ACTIVATION_ONLY,
        maxItemBytes: 0,
        maxItems: 0,
        maxInitialCredit: 256,
        maxOutstandingCredit: 1024,
        maxTimeoutMs: 600_000,
      },
    ],
  ],
  [
    "bluetooth.select",
    [
      {
        version: 1,
        mode: "unary",
        data: "none",
        consent: "perUse",
        overflow: "none",
        lifetimes: ACTIVATION_ONLY,
        maxItemBytes: 0,
        maxItems: 0,
        maxInitialCredit: 0,
        maxOutstandingCredit: 0,
        maxTimeoutMs: 300_000,
      },
    ],
  ],
  [
    "camera.capture",
    [
      {
        version: 1,
        mode: "unary",
        data: "binaryUpload",
        consent: "perUse",
        overflow: "pause",
        lifetimes: ACTIVATION_ONLY,
        maxItemBytes: 64 * MIB,
        maxItems: 1,
        maxInitialCredit: 4 * MIB,
        maxOutstandingCredit: 8 * MIB,
        maxTimeoutMs: 600_000,
      },
    ],
  ],
  [
    "file.pick",
    [
      {
        version: 1,
        mode: "unary",
        data: "binaryUpload",
        consent: "perUse",
        overflow: "pause",
        lifetimes: ACTIVATION_ONLY,
        maxItemBytes: 64 * MIB,
        maxItems: 16,
        maxInitialCredit: 4 * MIB,
        maxOutstandingCredit: 8 * MIB,
        maxTimeoutMs: 300_000,
      },
    ],
  ],
  [
    "file.save",
    [
      {
        version: 1,
        mode: "unary",
        data: "binaryDownload",
        consent: "perUse",
        overflow: "pause",
        lifetimes: ACTIVATION_ONLY,
        maxItemBytes: 64 * MIB,
        maxItems: 1,
        maxInitialCredit: 0,
        maxOutstandingCredit: 8 * MIB,
        maxTimeoutMs: 300_000,
      },
    ],
  ],
  [
    "gallery.pick",
    [
      {
        version: 1,
        mode: "unary",
        data: "binaryUpload",
        consent: "perUse",
        overflow: "pause",
        lifetimes: ACTIVATION_ONLY,
        maxItemBytes: 64 * MIB,
        maxItems: 16,
        maxInitialCredit: 4 * MIB,
        maxOutstandingCredit: 8 * MIB,
        maxTimeoutMs: 300_000,
      },
    ],
  ],
  [
    "mic.record",
    [
      {
        version: 1,
        mode: "stream",
        data: "binaryUpload",
        consent: "perUse",
        overflow: "pause",
        lifetimes: ACTIVATION_ONLY,
        maxItemBytes: 64 * MIB,
        maxItems: 1,
        maxInitialCredit: 256 * KIB,
        maxOutstandingCredit: MIB,
        maxTimeoutMs: 600_000,
      },
    ],
  ],
  [
    "permission.query",
    [
      {
        version: 1,
        mode: "unary",
        data: "none",
        consent: "none",
        overflow: "none",
        lifetimes: ACTIVATION_ONLY,
        maxItemBytes: 0,
        maxItems: 0,
        maxInitialCredit: 0,
        maxOutstandingCredit: 0,
        maxTimeoutMs: 30_000,
      },
    ],
  ],
  [
    "permission.request",
    [
      {
        version: 1,
        mode: "unary",
        data: "none",
        consent: "perUse",
        overflow: "none",
        lifetimes: ACTIVATION_ONLY,
        maxItemBytes: 0,
        maxItems: 0,
        maxInitialCredit: 0,
        maxOutstandingCredit: 0,
        maxTimeoutMs: 300_000,
      },
    ],
  ],
]);

/** Look up a declared capability revision (mirror of Rust `find_revision`). */
export function findRevision(
  capability: string,
  version: number,
  registry: DeviceRegistry = DEVICE_REGISTRY
): DeviceRevisionBounds | undefined {
  return registry.get(capability)?.find((r) => r.version === version);
}

/**
 * A copy of `base` with one revision's bounds overridden — the test/injection
 * seam for revisions v1 does not define yet (e.g. a `background` lifetime).
 */
export function withRevisionOverride(
  capability: string,
  version: number,
  override: Partial<Omit<DeviceRevisionBounds, "version">>,
  base: DeviceRegistry = DEVICE_REGISTRY
): DeviceRegistry {
  const out = new Map(base);
  const revisions = [...(base.get(capability) ?? [])];
  const idx = revisions.findIndex((r) => r.version === version);
  const current: DeviceRevisionBounds =
    idx >= 0
      ? revisions[idx]!
      : {
          version,
          mode: "unary",
          data: "none",
          consent: "none",
          overflow: "none",
          lifetimes: ACTIVATION_ONLY,
          maxItemBytes: 0,
          maxItems: 0,
          maxInitialCredit: 0,
          maxOutstandingCredit: 0,
          maxTimeoutMs: 300_000,
        };
  const next = { ...current, ...override, version };
  if (idx >= 0) revisions[idx] = next;
  else revisions.push(next);
  out.set(capability, revisions);
  return out;
}

/** Whether a revision needs the binary frame profile (§2.5). */
export function needsBinary(rev: DeviceRevisionBounds): boolean {
  return rev.data === "binaryUpload" || rev.data === "binaryDownload";
}
