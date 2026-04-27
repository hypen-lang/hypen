package core

import (
	"encoding/json"
	"fmt"
	"reflect"
)

// TypedActionContext is the context passed to a typed action handler.
//
// The State field is a pointer to a value of the user's own struct type,
// which can be read and mutated directly using normal Go field access.
// Mutations are automatically diffed against the prior snapshot after the
// handler returns, and only the changed paths are committed to the
// underlying ObservableState.
type TypedActionContext[T any] struct {
	// Action carries the dispatched action's name, payload, and sender.
	Action ActionContext
	// State is a pointer to the typed state struct. Mutate fields directly.
	State *T
	// Context provides cross-module communication (events, router, other modules).
	Context GlobalContext
}

// TypedActionHandler is the signature of an action handler for a typed module.
type TypedActionHandler[T any] func(ctx TypedActionContext[T])

// TypedLifecycleHandler is the signature of onCreated/onDestroyed handlers for
// a typed module. The state pointer can be mutated in onCreated and changes
// will be committed when the handler returns.
type TypedLifecycleHandler[T any] func(state *T, context GlobalContext)

// TypedDisconnectContext is the context passed to a typed OnDisconnect handler.
//
// State is a pointer to the typed state struct at the moment of disconnect.
// Mutations have no effect on the suspended session (the suspension stores its
// own copy) but are still committed to the live observable state for any
// remaining observers.
type TypedDisconnectContext[T any] struct {
	State   *T
	Session SessionInfo
}

// TypedDisconnectHandler fires when the last WebSocket connection for a
// session drops.
type TypedDisconnectHandler[T any] func(ctx TypedDisconnectContext[T])

// TypedReconnectContext is the context passed to a typed OnReconnect handler.
//
// Restore pushes a typed value back into the live observable state, mirroring
// the untyped `Restore(map[string]any)` callback. If the handler does not call
// Restore, the saved state is applied automatically by the runtime.
type TypedReconnectContext[T any] struct {
	Session SessionInfo
	Restore func(T)
}

// TypedReconnectHandler fires when a client resumes a suspended session
// within the TTL window.
type TypedReconnectHandler[T any] func(ctx TypedReconnectContext[T])

// TypedAppBuilder is a generic, strongly-typed builder for Hypen modules.
//
// Use NewApp[T] to start building a module whose state is expressed as a Go
// struct. State access in handlers is then type-safe — no `any` casts, no
// string-keyed Get/Set, and typos are caught at compile time.
//
// Example:
//
//	type CounterState struct {
//	    Count   int    `json:"count"`
//	    Message string `json:"message"`
//	}
//
//	counter := core.NewApp(CounterState{Count: 0, Message: "Hi"}).
//	    OnAction("increment", func(ctx core.TypedActionContext[CounterState]) {
//	        ctx.State.Count++
//	    }).
//	    UI(`Column { Text("@{state.count}") }`)
type TypedAppBuilder[T any] struct {
	inner *AppBuilder
}

// NewApp creates a new typed app builder from an initial state struct.
//
// The struct is serialized to a map using encoding/json, so fields should
// carry `json:"..."` tags matching the names referenced from the Hypen DSL
// template (e.g. @{state.count}).
func NewApp[T any](initial T, options ...*ModuleOptions) *TypedAppBuilder[T] {
	var opts *ModuleOptions
	if len(options) > 0 {
		opts = options[0]
	}
	initialMap, err := structToMap(initial)
	if err != nil {
		panic(fmt.Errorf("hypen: failed to encode initial state: %w", err))
	}
	return &TypedAppBuilder[T]{
		inner: NewAppBuilder(initialMap, opts),
	}
}

// Name sets the module name for registry auto-registration and state
// namespacing. When set, Build() automatically registers the module in
// the global App registry so the server can discover it.
//
// Example:
//
//	core.NewApp(SearchState{}).Name("Search").Build()
func (b *TypedAppBuilder[T]) Name(name string) *TypedAppBuilder[T] {
	b.inner.options.Name = name
	b.inner.app = App // auto-register in the global registry
	return b
}

// OnCreated registers a typed lifecycle handler invoked when the module is
// created. Mutations made to *state are committed after the handler returns.
func (b *TypedAppBuilder[T]) OnCreated(fn TypedLifecycleHandler[T]) *TypedAppBuilder[T] {
	b.inner.OnCreated(func(state *ObservableState, ctx GlobalContext) {
		typed, before, err := decodeState[T](state)
		if err != nil {
			panic(fmt.Errorf("hypen: onCreated decode failed: %w", err))
		}
		fn(&typed, ctx)
		commitTypedChanges(state, typed, before)
	})
	return b
}

// OnActivated registers a typed lifecycle handler invoked every time
// the module becomes the active route target (once right after
// OnCreated on first mount, then again on each re-mount when the
// ManagedRouter restores a cached instance). Mutations made to *state
// are committed after the handler returns.
func (b *TypedAppBuilder[T]) OnActivated(fn TypedLifecycleHandler[T]) *TypedAppBuilder[T] {
	b.inner.OnActivated(func(state *ObservableState, ctx GlobalContext) {
		typed, before, err := decodeState[T](state)
		if err != nil {
			panic(fmt.Errorf("hypen: onActivated decode failed: %w", err))
		}
		fn(&typed, ctx)
		commitTypedChanges(state, typed, before)
	})
	return b
}

// OnDeactivated registers a typed lifecycle handler invoked every time
// the module stops being the active route target (before persistence
// OR before OnDestroyed). Mutations made to *state are committed after
// the handler returns.
func (b *TypedAppBuilder[T]) OnDeactivated(fn TypedLifecycleHandler[T]) *TypedAppBuilder[T] {
	b.inner.OnDeactivated(func(state *ObservableState, ctx GlobalContext) {
		typed, before, err := decodeState[T](state)
		if err != nil {
			panic(fmt.Errorf("hypen: onDeactivated decode failed: %w", err))
		}
		fn(&typed, ctx)
		commitTypedChanges(state, typed, before)
	})
	return b
}

// OnAction registers a typed handler for a specific action name. The handler
// receives a TypedActionContext[T] whose State pointer can be mutated directly.
func (b *TypedAppBuilder[T]) OnAction(name string, fn TypedActionHandler[T]) *TypedAppBuilder[T] {
	b.inner.OnAction(name, func(ctx ActionHandlerContext) {
		typed, before, err := decodeState[T](ctx.State)
		if err != nil {
			panic(fmt.Errorf("hypen: action %q decode failed: %w", name, err))
		}
		fn(TypedActionContext[T]{
			Action:  ctx.Action,
			State:   &typed,
			Context: ctx.Context,
		})
		commitTypedChanges(ctx.State, typed, before)
	})
	return b
}

// OnDestroyed registers a typed lifecycle handler invoked when the module is
// destroyed. Mutations made after destruction are not observable; this hook
// is intended for cleanup.
func (b *TypedAppBuilder[T]) OnDestroyed(fn TypedLifecycleHandler[T]) *TypedAppBuilder[T] {
	b.inner.OnDestroyed(func(state *ObservableState, ctx GlobalContext) {
		typed, _, err := decodeState[T](state)
		if err != nil {
			// Best-effort: still call the handler with a zero value so cleanup
			// code can run, but preserve the error context.
			var zero T
			fn(&zero, ctx)
			return
		}
		fn(&typed, ctx)
	})
	return b
}

// OnError registers a module-level error handler. The signature is the same
// as the untyped builder because ErrorContext surfaces engine-level state.
func (b *TypedAppBuilder[T]) OnError(fn ErrorHandler) *TypedAppBuilder[T] {
	b.inner.OnError(fn)
	return b
}

// OnDisconnect registers a typed handler that fires when the last WebSocket
// connection for a session drops. The state pointer is decoded from the
// live observable state; handler mutations are committed after it returns.
func (b *TypedAppBuilder[T]) OnDisconnect(fn TypedDisconnectHandler[T]) *TypedAppBuilder[T] {
	b.inner.OnDisconnect(func(ctx DisconnectContext) {
		typed, before, err := decodeState[T](ctx.State)
		if err != nil {
			panic(fmt.Errorf("hypen: onDisconnect decode failed: %w", err))
		}
		fn(TypedDisconnectContext[T]{
			State:   &typed,
			Session: ctx.Session,
		})
		commitTypedChanges(ctx.State, typed, before)
	})
	return b
}

// OnReconnect registers a typed handler that fires when a client resumes a
// suspended session within the TTL window. The handler can opt to restore
// saved state via the Restore callback on TypedReconnectContext, which
// forwards to the underlying untyped Restore(map[string]any) by encoding
// the typed value through JSON.
func (b *TypedAppBuilder[T]) OnReconnect(fn TypedReconnectHandler[T]) *TypedAppBuilder[T] {
	b.inner.OnReconnect(func(ctx ReconnectContext) {
		typedRestore := func(v T) {
			m, err := structToMap(v)
			if err != nil {
				panic(fmt.Errorf("hypen: onReconnect restore encode failed: %w", err))
			}
			ctx.Restore(m)
		}
		fn(TypedReconnectContext[T]{
			Session: ctx.Session,
			Restore: typedRestore,
		})
	})
	return b
}

// OnExpire registers a handler that fires when a suspended session's TTL
// elapses without a reconnect. ExpireContext surfaces no state (the module
// is about to be destroyed), so this shares the untyped handler signature.
func (b *TypedAppBuilder[T]) OnExpire(fn ExpireHandler) *TypedAppBuilder[T] {
	b.inner.OnExpire(fn)
	return b
}

// UI sets the inline Hypen DSL template and finalizes the module definition.
func (b *TypedAppBuilder[T]) UI(template string) *ModuleDefinition {
	return b.inner.UI(template)
}

// UIFile loads the Hypen DSL template from a file and finalizes the module.
func (b *TypedAppBuilder[T]) UIFile(path string) (*ModuleDefinition, error) {
	return b.inner.UIFile(path)
}

// Build finalizes the module definition without a template. Prefer UI() for
// single-file components.
func (b *TypedAppBuilder[T]) Build() *ModuleDefinition {
	return b.inner.Build()
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

// structToMap encodes a struct (or map) into a map[string]any via JSON,
// honoring json tags. Returns an empty map for nil inputs.
func structToMap(v any) (map[string]any, error) {
	if v == nil {
		return map[string]any{}, nil
	}
	// Fast path for an already-encoded map.
	if m, ok := v.(map[string]any); ok {
		out := make(map[string]any, len(m))
		for k, val := range m {
			out[k] = val
		}
		return out, nil
	}
	data, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, err
	}
	if out == nil {
		out = map[string]any{}
	}
	return out, nil
}

// mapToStruct decodes a map[string]any into a struct value of type T.
func mapToStruct[T any](m map[string]any) (T, error) {
	var out T
	if m == nil {
		return out, nil
	}
	data, err := json.Marshal(m)
	if err != nil {
		return out, err
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return out, err
	}
	return out, nil
}

// decodeState snapshots the observable state into a typed struct, returning
// both the typed value and the raw pre-handler snapshot used for diffing.
func decodeState[T any](state *ObservableState) (T, map[string]any, error) {
	var zero T
	if state == nil {
		return zero, map[string]any{}, nil
	}
	snap := state.Snapshot()
	typed, err := mapToStruct[T](snap)
	if err != nil {
		return zero, snap, err
	}
	return typed, snap, nil
}

// commitTypedChanges diffs the mutated typed value against the pre-handler
// snapshot and writes only the changed top-level keys back into the
// ObservableState, so the engine only sees a minimal delta.
func commitTypedChanges[T any](state *ObservableState, typed T, before map[string]any) {
	if state == nil {
		return
	}
	after, err := structToMap(typed)
	if err != nil {
		// Should not happen for values that successfully round-tripped in.
		return
	}

	// Collect changed / new keys.
	changed := make(map[string]any)
	for k, v := range after {
		if old, ok := before[k]; !ok || !reflect.DeepEqual(old, v) {
			changed[k] = v
		}
	}
	// Collect keys that disappeared — rare for fixed-shape structs, but
	// possible for omitempty fields that became zero-valued.
	deleted := make([]string, 0)
	for k := range before {
		if _, ok := after[k]; !ok {
			deleted = append(deleted, k)
		}
	}

	if len(changed) == 0 && len(deleted) == 0 {
		return
	}

	BatchStateUpdates(state, func() {
		for k, v := range changed {
			state.Set(k, v)
		}
		for _, k := range deleted {
			state.Delete(k)
		}
	})
}
