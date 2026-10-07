// Package device is the Go SDK's binding of the Device Capability Protocol
// (RFC 001, provisional v2.4) and its thin typed surface.
//
// # One implementation, in Rust
//
// The protocol is implemented ONCE, in the Rust engine: the sans-IO
// `device::DeviceBroker` (hypen-engine-rs/src/device/) and the strict wire
// layer (hypen-engine-rs/src/serialize/device.rs) — the RFC 001 §2.1 JSON
// limits, the envelope and per-revision schemas, the capability registry,
// handshake selection, binary frames, leases, credit, blob verification,
// violation attribution and reactions. Every server SDK runs it; this
// package holds no decoder, validator or negotiator of its own. Do not add
// one.
//
// It binds the engine module's WASI ABI (`hypen_device_*`) with wazero:
// BrokerModule compiles the engine module once and NewRuntime instantiates
// isolated BrokerRuntimes from it; a BrokerRuntime is one module instance
// holding brokers and retained-bytes pools (calls serialised by its mutex;
// a trap poisons that instance only, ErrBrokerRuntimeFailed — servers give
// each connection its own). Broker is one connection's broker (Start, Open,
// OnText, OnFrame, Tick, Poll, owner lifecycle, Close/Destroy, plus
// Revision / OutstandingCredit / ReopenCoreCapabilities queries), and
// DecodeFramedOutputs decodes the poll framing into Output values. The
// handshake runs in Rust too: BrokerRuntime.Negotiate (the server's
// selection against the broker's advertisement), SelectAck (explicit server
// lists), ValidateHello and ValidateAck (the strict decoders).
//
// Package remote pumps a socket through a Broker; package device
// (github.com/hypen-space/core/device) is the handler API on top.
//
// # Typed surface
//
// types.go holds only what the handler API and the transport need: plain
// Go structs for capability params, results and events (encoding/json
// tags, no custom codecs), their closed string enums, DeviceErrorCode,
// Lifetime and the transport constants (MaxMessageBytes, FrameHeaderLen).
// Params are encoded with encoding/json and validated by the broker at
// open (invalid ⇒ a local invalidParams Refusal naming the JSON path;
// nothing is sent); results and events are decoded with encoding/json
// from JSON the broker already validated.
//
// # Conformance
//
// The shared fixtures under engine-compatibility-tests/ are replayed
// through the Rust broker and negotiation via this binding, not through Go
// code: conformance_test.go replays every wire transcript in the server
// role (Go port of hypen-engine-rs/tests/test_device_broker_transcripts.rs),
// the handshake fixtures and frames.json; conformance_shared_test.go
// replays conformance/{selection,messages,payloads}.json and pins
// registry-v1.json to the revisions the broker enforces; types_test.go
// pins the typed structs and enums to the exported schemas; fuzz_test.go
// fuzzes the binding with arbitrary client text and frames.
//
// Everything here is provisional until the RFC 001 §6 Phase 4 real-driver
// gate.
package device
