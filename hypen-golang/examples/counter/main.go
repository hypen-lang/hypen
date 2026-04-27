// Counter demonstrates a minimal single-file Hypen component in Go using the
// typed API: state as a Go struct, direct field mutation in action handlers,
// and an inline UI template via .UI(). No `any` casts, no string-keyed state.
package main

import (
	"fmt"
	"log"

	core "github.com/hypen-space/core"
)

// CounterState is the module's state shape. Fields are tagged with json
// names that match the `@{state.xxx}` references in the Hypen DSL template.
type CounterState struct {
	Count   int    `json:"count"`
	Message string `json:"message"`
}

func main() {
	counter := core.NewApp(CounterState{
		Count:   0,
		Message: "Click the buttons to count!",
	}).
		OnAction("increment", func(ctx core.TypedActionContext[CounterState]) {
			ctx.State.Count++
		}).
		OnAction("decrement", func(ctx core.TypedActionContext[CounterState]) {
			ctx.State.Count--
		}).
		OnAction("reset", func(ctx core.TypedActionContext[CounterState]) {
			ctx.State.Count = 0
			ctx.State.Message = "Counter reset!"
		}).
		UI(`
			Column {
				Text("Single-File Counter")
					.fontSize(28)
					.fontWeight("bold")

				Text("@{state.count}")
					.fontSize(64)
					.fontWeight("bold")

				Text("@{state.message}")
					.fontSize(14)
					.color("#888888")

				Row {
					Button("@actions.decrement") { Text("-") }
					Button("@actions.reset")     { Text("Reset") }
					Button("@actions.increment")  { Text("+") }
				}
				.gap(12)
			}
			.padding(40)
			.alignItems("center")
		`)

	instance, err := counter.CreateInstance()
	if err != nil {
		log.Fatal(err)
	}

	instance.DispatchAction("increment", nil)
	instance.DispatchAction("increment", nil)
	instance.DispatchAction("increment", nil)
	instance.DispatchAction("decrement", nil)

	state := instance.GetState()
	fmt.Printf("count: %v\n", state["count"])
	fmt.Printf("template: %s...\n", counter.Template[:40])

	instance.Destroy()
}
