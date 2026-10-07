package core

import _ "embed"

// embeddedWasm contains the pre-built Hypen WASM engine binary.
// This allows NewDefaultEngine() to create an engine without any configuration.
//
//go:embed hypen_engine.wasm
var embeddedWasm []byte

// EngineWASM returns the embedded engine module (hypen_engine.wasm) — the
// same bytes NewDefaultEngine instantiates. Besides the renderer it exports
// the Rust device broker (RFC 001, `hypen_device_*`), which the remote
// server instantiates through remote/device.NewBrokerRuntime. The returned
// slice is shared: callers must not modify it.
func EngineWASM() []byte { return embeddedWasm }
