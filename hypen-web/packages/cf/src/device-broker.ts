/**
 * The server-side device broker for Cloudflare Durable Objects (RFC 001):
 * the Rust `DeviceBroker` (`WasmDeviceBroker`) from the injected web-target
 * `hypen-engine` exports, handed to `@hypen-space/core` through its WASM-free
 * {@link DeviceBrokerPort}.
 *
 * `@hypen-space/cf` stays WASM-free: the worker imports the glue (built with
 * `--features js,device-broker`) and passes it as
 * `HypenDurableObjectConfig.deviceWasm` (`defineHypenWorker` does this from
 * its `wasm` option). One broker per device socket; the brokers of
 * one Durable Object share a {@link DO_DEVICE_AGGREGATE_RETAINED_BYTES}
 * pool.
 */

import {
  toDeviceHandshakeOutcome,
  type DeviceBrokerConfig,
  type DeviceBrokerFactory,
  type DeviceBrokerPort,
} from "@hypen-space/core/remote/device";

/**
 * The device-broker exports of the web-target wasm-bindgen glue, typed
 * structurally (the cf package never imports the generated `.d.ts`).
 */
export interface CFDeviceWasmExports {
  WasmDeviceBroker: {
    new (config: unknown, nowMs: number): DeviceBrokerPort;
    withPool(config: unknown, pool: any, nowMs: number): DeviceBrokerPort;
  };
  WasmRetainedBytesPool: new (limit: number) => { readonly limit: number; inUse(): number };
  /** The Rust server handshake (hello validation + selection). */
  deviceHandshake(hello: unknown, binaryRoute: boolean, serverCapabilities: unknown): unknown;
}

/** Whether `wasm` carries the device broker (a `js,device-broker` build). */
export function hasDeviceBroker(wasm: unknown): wasm is CFDeviceWasmExports {
  const w = wasm as Partial<CFDeviceWasmExports> | null | undefined;
  return (
    typeof w?.WasmDeviceBroker === "function" &&
    typeof w.WasmDeviceBroker.withPool === "function" &&
    typeof w.WasmRetainedBytesPool === "function" &&
    typeof w.deviceHandshake === "function"
  );
}

/**
 * Create brokers backed by the Rust implementation (and negotiate the
 * handshake through the Rust `deviceHandshake`), sharing one aggregate
 * retained-bytes pool of `poolBytes` (created on first use, after the WASM
 * was initialised). Throws (from the broker constructor) on a malformed
 * configuration.
 */
export function createCFDeviceBrokerFactory(
  wasm: CFDeviceWasmExports,
  poolBytes: number
): DeviceBrokerFactory {
  let pool: InstanceType<CFDeviceWasmExports["WasmRetainedBytesPool"]> | null = null;
  const factory = (config: DeviceBrokerConfig, nowMs: number): DeviceBrokerPort => {
    pool ??= new wasm.WasmRetainedBytesPool(poolBytes);
    return wasm.WasmDeviceBroker.withPool(config, pool, nowMs);
  };
  const negotiate: DeviceBrokerFactory["negotiate"] = (helloText, binaryRoute, serverCapabilities) =>
    toDeviceHandshakeOutcome(wasm.deviceHandshake(helloText, binaryRoute, serverCapabilities ?? null));
  return Object.assign(factory, { negotiate });
}
