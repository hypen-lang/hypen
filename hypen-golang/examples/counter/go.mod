module github.com/hypen-space/examples/counter

go 1.25.0

require github.com/hypen-space/core v0.0.0

require (
	github.com/tetratelabs/wazero v1.12.0 // indirect
	golang.org/x/sys v0.44.0 // indirect
)

replace github.com/hypen-space/core => ../..
