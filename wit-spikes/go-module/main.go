// Hypen counter module in Go, compiled to a WASM Component via TinyGo.
//
// Mirrors the Rust (wit-spikes/stub-module) and TS (wit-spikes/ts-module)
// counter modules; same WIT contract, different source language. Proves
// the WIT-as-language-agnostic-contract claim across a third toolchain.
//
//   action "increment" -> count += 1, history += ["inc"]
//   action "decrement" -> count -= 1, history += ["dec"]
//   action "reset"     -> count = 0, history = []
//
// Build with:
//   tinygo build -target=wasip2 -wit-package wit \
//                -wit-world module -o app.wasm main.go

package main

import (
	"encoding/json"

	"go.bytecodealliance.org/cm"

	module "hypen.space/go-module/internal/bindings/hypen/module/module"
	types "hypen.space/go-module/internal/bindings/hypen/module/types"
)

// counterState is the JSON shape the engine sees. Same as the Rust and
// TS counters — proves modules in different source languages can share a
// state shape transparently.
type counterState struct {
	Count   int      `json:"count"`
	History []string `json:"history"`
}

// ── helpers ────────────────────────────────────────────────────────────────

func encodeJSON(v any) module.JSON {
	bytes, _ := json.Marshal(v)
	// `module.JSON` is `types.JSON` which is a named type around
	// `cm.List[uint8]`; the cm.ToList helper gives us the underlying
	// shape and we cast.
	return types.JSON(cm.ToList(bytes))
}

func decodeState(j module.JSON) counterState {
	bytes := j.Slice()
	s := counterState{History: []string{}}
	if len(bytes) > 0 {
		_ = json.Unmarshal(bytes, &s)
	}
	if s.History == nil {
		s.History = []string{}
	}
	return s
}

func okOutput(state counterState) cm.Result[module.ReducerOutputShape, module.ReducerOutput, string] {
	out := module.ReducerOutput{
		State:   cm.Some(encodeJSON(state)),
		Effects: cm.NewList[types.Effect](nil, 0),
		Emit:    cm.NewList[module.Action](nil, 0),
	}
	var r cm.Result[module.ReducerOutputShape, module.ReducerOutput, string]
	r.SetOK(out)
	return r
}

func errOutput(msg string) cm.Result[module.ReducerOutputShape, module.ReducerOutput, string] {
	var r cm.Result[module.ReducerOutputShape, module.ReducerOutput, string]
	r.SetErr(msg)
	return r
}

func noopOutput() cm.Result[module.ReducerOutputShape, module.ReducerOutput, string] {
	out := module.ReducerOutput{
		State:   cm.None[module.JSON](),
		Effects: cm.NewList[types.Effect](nil, 0),
		Emit:    cm.NewList[module.Action](nil, 0),
	}
	var r cm.Result[module.ReducerOutputShape, module.ReducerOutput, string]
	r.SetOK(out)
	return r
}

// ── WIT exports ────────────────────────────────────────────────────────────

func init() {
	module.Exports.Init = func(_ module.JSON) cm.Result[module.JSON, module.JSON, string] {
		bytes := encodeJSON(counterState{Count: 0, History: []string{}})
		var r cm.Result[module.JSON, module.JSON, string]
		r.SetOK(bytes)
		return r
	}

	module.Exports.Dispatch = func(state module.JSON, action module.Action) cm.Result[module.ReducerOutputShape, module.ReducerOutput, string] {
		s := decodeState(state)
		switch action.Name {
		case "increment":
			s.Count += 1
			s.History = append(s.History, "inc")
		case "decrement":
			s.Count -= 1
			s.History = append(s.History, "dec")
		case "reset":
			s.Count = 0
			s.History = []string{}
		default:
			return errOutput("unknown action: " + action.Name)
		}
		return okOutput(s)
	}

	module.Exports.OnActivated = func(_ module.JSON) cm.Result[module.ReducerOutputShape, module.ReducerOutput, string] {
		return noopOutput()
	}
	module.Exports.OnDeactivated = func(_ module.JSON) cm.Result[module.ReducerOutputShape, module.ReducerOutput, string] {
		return noopOutput()
	}
	module.Exports.OnDestroyed = func(_ module.JSON) cm.Result[string, struct{}, string] {
		var r cm.Result[string, struct{}, string]
		r.SetOK(struct{}{})
		return r
	}
	module.Exports.Actions = func() cm.List[string] {
		return cm.ToList([]string{"increment", "decrement", "reset"})
	}
}

// TinyGo wasi-p2 needs a main even for library-like components.
func main() {}
