package counter

import core "github.com/hypen-lang/hypen/hypen-golang"

type State struct {
	Count int `json:"count"`
}

// Module exposes the module definition the wasm build adapts to hypen:module.
func Module() *core.ModuleDefinition {
	return core.NewApp(State{Count: 0}).
		OnAction("increment", func(ctx core.TypedActionContext[State]) { ctx.State.Count++ }).
		OnAction("decrement", func(ctx core.TypedActionContext[State]) { ctx.State.Count-- }).
		Build()
}
