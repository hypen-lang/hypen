module hypen.space/wasm-go-app-api

go 1.25.0

require (
	github.com/hypen-lang/hypen/hypen-golang v0.0.0
	go.bytecodealliance.org/cm v0.3.0
)

// Fixture-local: build against the in-repo Go SDK. The build-wasm e2e test
// rewrites this to an absolute path; a real project would `go get` the
// published module instead.
replace github.com/hypen-lang/hypen/hypen-golang => ../../../../hypen-golang
