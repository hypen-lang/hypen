package core

import (
	"sync"
	"testing"
	"time"
)

func TestModuleInstance_RegistersModuleAndRunsOnCreated(t *testing.T) {
	engine := NewFakeEngine()
	createdCalled := false

	definition := App.DefineState(
		map[string]any{"count": float64(0)},
		&ModuleOptions{Name: "Counter"},
	).OnCreated(func(state *ObservableState, context GlobalContext) {
		createdCalled = true
		state.Set("count", float64(1))
	}).OnAction("increment", func(ctx ActionHandlerContext) {
		count := ctx.State.Get("count").(float64)
		payload := float64(1)
		if ctx.Action.Payload != nil {
			payload = ctx.Action.Payload.(float64)
		}
		ctx.State.Set("count", count+payload)
	}).Build()

	_ = NewModuleInstance(engine, definition)

	// Wait for async operations
	time.Sleep(50 * time.Millisecond)

	if !createdCalled {
		t.Error("expected onCreated to be called")
	}

	engine.mu.Lock()
	defer engine.mu.Unlock()

	if len(engine.setModuleCalls) == 0 {
		t.Fatal("expected setModule to be called")
	}

	call := engine.setModuleCalls[0]
	if call.Name != "Counter" {
		t.Errorf("expected name='Counter', got %s", call.Name)
	}

	found := false
	for _, a := range call.Actions {
		if a == "increment" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected 'increment' in actions, got %v", call.Actions)
	}
}

func TestModuleInstance_ActionHandlersReceiveContextAndPropagateChanges(t *testing.T) {
	engine := NewFakeEngine()

	definition := App.DefineState(
		map[string]any{"count": float64(0)},
		nil,
	).OnAction("increment", func(ctx ActionHandlerContext) {
		if ctx.Action.Name != "increment" {
			t.Errorf("expected action name 'increment', got %s", ctx.Action.Name)
		}
		if ctx.Action.Payload != float64(3) {
			t.Errorf("expected payload 3, got %v", ctx.Action.Payload)
		}
		if ctx.Action.Sender != "ui" {
			t.Errorf("expected sender 'ui', got %s", ctx.Action.Sender)
		}

		count := ctx.State.Get("count").(float64)
		ctx.State.Set("count", count+ctx.Action.Payload.(float64))
	}).Build()

	instance := NewModuleInstance(engine, definition)

	engine.DispatchActionAs("increment", float64(3), "ui")

	time.Sleep(50 * time.Millisecond)

	state := instance.GetLiveState()
	if state.Get("count") != float64(3) {
		t.Errorf("expected count=3, got %v", state.Get("count"))
	}
}

func TestModuleInstance_DestroyInvokesOnDestroyedOnce(t *testing.T) {
	engine := NewFakeEngine()
	destroyedCount := 0
	mu := sync.Mutex{}

	definition := App.DefineState(
		map[string]any{"active": true},
		nil,
	).OnDestroyed(func(state *ObservableState, context GlobalContext) {
		mu.Lock()
		destroyedCount++
		mu.Unlock()
	}).Build()

	instance := NewModuleInstance(engine, definition)
	instance.Destroy()
	instance.Destroy() // Call twice

	mu.Lock()
	defer mu.Unlock()

	if destroyedCount != 1 {
		t.Errorf("expected destroyedCount=1, got %d", destroyedCount)
	}
}

func TestModuleInstance_UpdateStateMergesPatchAndTriggersNotification(t *testing.T) {
	engine := NewFakeEngine()

	definition := App.DefineState(
		map[string]any{"count": float64(0), "label": ""},
		nil,
	).Build()

	instance := NewModuleInstance(engine, definition)
	instance.UpdateState(map[string]any{"count": float64(10)})

	time.Sleep(50 * time.Millisecond)

	state := instance.GetState()
	if state["count"] != float64(10) {
		t.Errorf("expected count=10, got %v", state["count"])
	}
	if state["label"] != "" {
		t.Errorf("expected label='', got %v", state["label"])
	}
}

func TestModuleInstance_GetStateReturnsSnapshotIsolatedFromLiveProxy(t *testing.T) {
	engine := NewFakeEngine()

	definition := App.DefineState(
		map[string]any{"value": float64(1)},
		nil,
	).Build()

	instance := NewModuleInstance(engine, definition)

	snapshot := instance.GetState()
	instance.GetLiveState().Set("value", float64(2))

	if snapshot["value"] != float64(1) {
		t.Errorf("expected snapshot.value=1, got %v", snapshot["value"])
	}
}

func TestAppBuilder_BuildCapturesOptionsAndHandlers(t *testing.T) {
	definition := App.DefineState(
		map[string]any{"flag": false},
		&ModuleOptions{Persist: BoolPtr(true), Version: 2, Name: "Toggle"},
	).OnCreated(func(state *ObservableState, context GlobalContext) {}).
		OnAction("flip", func(ctx ActionHandlerContext) {}).
		OnDestroyed(func(state *ObservableState, context GlobalContext) {}).
		Build()

	if definition.Name != "Toggle" {
		t.Errorf("expected name='Toggle', got %s", definition.Name)
	}
	if definition.Persist == nil || !*definition.Persist {
		t.Error("expected persist=true")
	}
	if definition.Version != 2 {
		t.Errorf("expected version=2, got %d", definition.Version)
	}

	found := false
	for _, a := range definition.Actions {
		if a == "flip" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected 'flip' in actions, got %v", definition.Actions)
	}

	if len(definition.Handlers.OnAction) != 1 {
		t.Errorf("expected 1 action handler, got %d", len(definition.Handlers.OnAction))
	}
}

func TestAppBuilder_NilInitialState(t *testing.T) {
	definition := App.DefineState(nil, nil).Build()

	if definition.InitialState != nil {
		t.Errorf("expected nil initial state, got %v", definition.InitialState)
	}
	if len(definition.StateKeys) != 0 {
		t.Errorf("expected empty state keys, got %v", definition.StateKeys)
	}
}

func TestModuleInstance_OnStateChangeCallback(t *testing.T) {
	engine := NewFakeEngine()
	callbackCalled := false

	definition := App.DefineState(
		map[string]any{"value": float64(0)},
		nil,
	).Build()

	instance := NewModuleInstance(engine, definition)
	instance.OnStateChange(func() {
		callbackCalled = true
	})

	instance.GetLiveState().Set("value", float64(1))

	time.Sleep(50 * time.Millisecond)

	if !callbackCalled {
		t.Error("expected state change callback to be called")
	}
}

func TestModuleInstance_WithRouterContext(t *testing.T) {
	engine := NewFakeEngine()
	router := NewHypenRouter()
	globalCtx := NewHypenGlobalContext()
	globalCtx.SetRouter(router)

	var capturedRouter *HypenRouter

	definition := App.DefineState(
		map[string]any{},
		nil,
	).OnAction("navigate", func(ctx ActionHandlerContext) {
		capturedRouter = ctx.Context.GetRouter()
	}).Build()

	_ = NewModuleInstance(engine, definition, WithRouter(&RouterContext{Root: router}), WithGlobalContext(globalCtx))

	engine.DispatchActionAs("navigate", nil, "")

	if capturedRouter != router {
		t.Error("expected router to be accessible via context.GetRouter()")
	}
}

func TestModuleInstance_WithGlobalContext(t *testing.T) {
	engine := NewFakeEngine()
	globalContext := NewHypenGlobalContext()

	var capturedContext GlobalContext

	definition := App.DefineState(
		map[string]any{},
		nil,
	).OnAction("test", func(ctx ActionHandlerContext) {
		capturedContext = ctx.Context
	}).Build()

	instance := NewModuleInstance(engine, definition, WithGlobalContext(globalContext))
	globalContext.RegisterModule("test", instance)

	engine.DispatchActionAs("test", nil, "")

	if capturedContext == nil {
		t.Error("expected context to be passed to action handler")
	}
}
