// Package core provides the Hypen reactive UI framework SDK for Go.
//
// Hypen is a declarative UI language and runtime for building cross-platform
// applications. This SDK provides the core building blocks for creating
// stateful modules, managing reactive state, handling routing, and streaming
// UI over WebSocket.
//
// # Quick Start
//
// Define module state as a Go struct and mutate it directly in action
// handlers — type-safe, no any casts, no string-keyed Get/Set:
//
//	type CounterState struct {
//	    Count int `json:"count"`
//	}
//
//	counter := core.NewApp(CounterState{Count: 0}).
//	    OnAction("increment", func(ctx core.TypedActionContext[CounterState]) {
//	        ctx.State.Count++
//	    }).
//	    UI(`Column { Text("@{state.count}") }`)
//
// The lower-level untyped builder is also available via NewAppBuilder for
// dynamic state shapes; NewApp[T] is a thin generic wrapper on top of it.
//
// # State Management
//
// ObservableState provides reactive state with automatic change tracking:
//
//	state := core.NewObservableState(map[string]any{"name": "Alice"}, &core.StateObserverOptions{
//	    OnChange: func(change core.StateChange) {
//	        fmt.Printf("Changed: %v\n", change.Paths)
//	    },
//	})
//	state.Set("name", "Bob")  // Triggers OnChange
//
// # Event System
//
// TypedEventEmitter provides pub/sub messaging:
//
//	emitter := core.CreateEventEmitter()
//	emitter.On("event", func(payload any) { ... })
//	emitter.Emit("event", data)
//
// # Routing
//
// HypenRouter provides URL-based navigation with pattern matching:
//
//	router := core.NewHypenRouter("/")
//	router.Push("/users/123")
//	match, params := router.MatchPath("/users/:id")  // true, {"id": "123"}
//
// # Testing
//
// MockEngine allows testing modules without the WASM engine:
//
//	engine := core.NewMockEngine()
//	instance := core.NewModuleInstance(engine, definition)
//	engine.TriggerAction("increment", nil)
//	// Verify state changes
//
// # Remote UI
//
// The remote subpackage provides WebSocket client/server for streaming UI.
// See github.com/hypen-space/core/remote for details.
package core
