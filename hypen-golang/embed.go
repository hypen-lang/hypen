package core

import _ "embed"

// embeddedWasm contains the pre-built Hypen WASM engine binary.
// This allows NewDefaultEngine() to create an engine without any configuration.
//
//go:embed hypen_engine.wasm
var embeddedWasm []byte
