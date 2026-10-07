/**
 * The server-side device broker for Node/Bun (RFC 001): the Rust
 * `DeviceBroker` from the `wasm-node` build (`WasmDeviceBroker`), handed to
 * `@hypen-space/core` through its WASM-free {@link DeviceBrokerPort}.
 *
 * One broker per device connection; the brokers of one process share
 * a {@link WasmRetainedBytesPool} (an aggregate retained-bytes budget next to
 * each connection's own), so many connections cannot together exhaust
 * memory. `RemoteServer` wires this automatically (the device plane is on by
 * default); custom
 * `SessionHost`s pass `createWasmDeviceBrokerFactory()` as
 * `deviceBrokerFactory`. The factory's `negotiate` is the Rust handshake
 * (`deviceHandshake`: hello validation + selection), so the TS server has
 * no selection code of its own.
 */

import {
  WasmDeviceBroker,
  WasmRetainedBytesPool,
  deviceHandshake,
} from "../wasm-node/hypen_engine.js";
import {
  DEFAULT_PROCESS_RETAINED_BYTES,
  toDeviceHandshakeOutcome,
  type DeviceBrokerConfig,
  type DeviceBrokerFactory,
  type DeviceBrokerPort,
} from "@hypen-space/core/remote/device";

export { WasmDeviceBroker, WasmRetainedBytesPool };

export interface WasmDeviceBrokerFactoryOptions {
  /**
   * Aggregate retained-bytes budget shared by every broker this factory
   * creates. Defaults to `DEFAULT_PROCESS_RETAINED_BYTES` (1 GiB); `null`
   * shares none (each connection keeps only its own budget).
   */
  poolBytes?: number | null;
  /** Share an existing pool instead (e.g. across several servers). */
  pool?: WasmRetainedBytesPool;
}

/** A {@link DeviceBrokerFactory} that also exposes the pool it shares. */
export interface WasmDeviceBrokerFactory extends DeviceBrokerFactory {
  readonly pool: WasmRetainedBytesPool | null;
}

/**
 * Create brokers backed by the Rust implementation. Throws (from the broker
 * constructor) on a malformed configuration.
 */
export function createWasmDeviceBrokerFactory(
  opts: WasmDeviceBrokerFactoryOptions = {}
): WasmDeviceBrokerFactory {
  const pool =
    opts.pool ??
    (opts.poolBytes === null
      ? null
      : new WasmRetainedBytesPool(opts.poolBytes ?? DEFAULT_PROCESS_RETAINED_BYTES));
  const factory = (config: DeviceBrokerConfig, nowMs: number): DeviceBrokerPort =>
    pool ? WasmDeviceBroker.withPool(config, pool, nowMs) : new WasmDeviceBroker(config, nowMs);
  const negotiate: DeviceBrokerFactory["negotiate"] = (helloText, binaryRoute, serverCapabilities) =>
    toDeviceHandshakeOutcome(deviceHandshake(helloText, binaryRoute, serverCapabilities ?? null));
  return Object.assign(factory, { pool, negotiate });
}
