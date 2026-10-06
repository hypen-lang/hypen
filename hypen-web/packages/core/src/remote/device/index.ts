/**
 * Device Capability Protocol — core module (RFC 001, provisional).
 *
 * Generated wire types + validators live in ./generated.ts (regenerate with
 * `bun scripts/generate-device-types.ts`); the hand-written modules add the
 * binary frame codec (pinned by golden bytes), the registry, strict JSON
 * decoding, the client runtime and the server handler API. The registry,
 * the strict decoder and the generated validators serve the CLIENT runtime
 * (`DeviceClient`, the `RemoteEngine` handshake) and the typed API's types.
 *
 * The server-side protocol logic — the advertisement and what the server
 * consumes, handshake negotiation (hello validation + selection), payload
 * validation and the broker — is NOT implemented here: it lives once, in
 * Rust, and reaches this WASM-free package through the broker port
 * (./port.ts, `DeviceBrokerFactory.negotiate` and the factory's brokers).
 */

export * from "./generated.js";
export * from "./frames.js";
export * from "./constants.js";
export * from "./registry.js";
export * from "./port.js";
export * from "./plane.js";
export * from "./context.js";
export * from "./blob.js";
export * from "./runtime.js";

export * from "./strict-json.js";
