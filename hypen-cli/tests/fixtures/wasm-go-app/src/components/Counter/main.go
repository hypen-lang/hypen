// A Hypen counter module in Go, built to a WASM Component by
// `hypen build --target wasm`. Implements the `hypen:module` reducer ABI
// against the bindings the CLI generates into `internal/bindings/`.
package main

import (
	"encoding/json"

	"go.bytecodealliance.org/cm"

	module "hypen.space/wasm-go-app/internal/bindings/hypen/module/module"
	types "hypen.space/wasm-go-app/internal/bindings/hypen/module/types"
)

type counterState struct {
	Count int `json:"count"`
}

func encodeJSON(v any) module.JSON {
	bytes, _ := json.Marshal(v)
	return types.JSON(cm.ToList(bytes))
}

func decodeState(j module.JSON) counterState {
	bytes := j.Slice()
	s := counterState{}
	if len(bytes) > 0 {
		_ = json.Unmarshal(bytes, &s)
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

func errOutput(msg string) cm.Result[module.ReducerOutputShape, module.ReducerOutput, string] {
	var r cm.Result[module.ReducerOutputShape, module.ReducerOutput, string]
	r.SetErr(msg)
	return r
}

func init() {
	module.Exports.Init = func(_ module.JSON) cm.Result[module.JSON, module.JSON, string] {
		var r cm.Result[module.JSON, module.JSON, string]
		r.SetOK(encodeJSON(counterState{Count: 0}))
		return r
	}

	module.Exports.Dispatch = func(state module.JSON, action module.Action) cm.Result[module.ReducerOutputShape, module.ReducerOutput, string] {
		s := decodeState(state)
		switch action.Name {
		case "increment":
			s.Count += 1
		case "decrement":
			s.Count -= 1
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
		return cm.ToList([]string{"increment", "decrement"})
	}
}

func main() {}
