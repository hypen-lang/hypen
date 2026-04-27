package core

import (
	"sync"
	"testing"
	"time"
)

type counterState struct {
	Count   int    `json:"count"`
	Message string `json:"message"`
}

func TestTypedApp_ActionMutatesStructDirectly(t *testing.T) {
	engine := NewFakeEngine()

	def := NewApp(counterState{Count: 0, Message: "hi"}).
		OnAction("increment", func(ctx TypedActionContext[counterState]) {
			ctx.State.Count++
		}).
		OnAction("setMessage", func(ctx TypedActionContext[counterState]) {
			ctx.State.Message = "updated"
		}).
		Build()

	instance := NewModuleInstance(engine, def)
	defer instance.Destroy()

	engine.DispatchActionAs("increment", nil, "test")
	engine.DispatchActionAs("increment", nil, "test")
	engine.DispatchActionAs("increment", nil, "test")
	engine.DispatchActionAs("setMessage", nil, "test")

	state := instance.GetState()

	// JSON decoding returns numbers as float64 in map[string]any.
	got, ok := state["count"].(float64)
	if !ok {
		t.Fatalf("expected count to be float64, got %T (%v)", state["count"], state["count"])
	}
	if int(got) != 3 {
		t.Errorf("expected count == 3, got %v", got)
	}
	if state["message"] != "updated" {
		t.Errorf("expected message == 'updated', got %v", state["message"])
	}
}

func TestTypedApp_OnlyChangedKeysAreCommitted(t *testing.T) {
	engine := NewFakeEngine()

	def := NewApp(counterState{Count: 5, Message: "keep"}).
		OnAction("bump", func(ctx TypedActionContext[counterState]) {
			ctx.State.Count++
		}).
		Build()

	instance := NewModuleInstance(engine, def)
	defer instance.Destroy()

	// Reset recorded state changes from initial SetModule.
	engine.mu.Lock()
	engine.notifyCalls = nil
	engine.mu.Unlock()

	engine.DispatchActionAs("bump", nil, "test")

	engine.mu.Lock()
	calls := append([]NotifyCall{}, engine.notifyCalls...)
	engine.mu.Unlock()

	if len(calls) == 0 {
		t.Fatal("expected at least one state change notification")
	}

	for _, ch := range calls {
		for _, p := range ch.Paths {
			if p != "count" {
				t.Errorf("unexpected changed path %q; only 'count' should have changed", p)
			}
		}
	}
}

func TestTypedApp_OnCreatedCommitsMutations(t *testing.T) {
	engine := NewFakeEngine()

	def := NewApp(counterState{Count: 0, Message: "init"}).
		OnCreated(func(state *counterState, _ GlobalContext) {
			state.Count = 42
			state.Message = "ready"
		}).
		Build()

	instance := NewModuleInstance(engine, def)
	defer instance.Destroy()

	state := instance.GetState()
	if got, _ := state["count"].(float64); int(got) != 42 {
		t.Errorf("expected count == 42 after onCreated, got %v", state["count"])
	}
	if state["message"] != "ready" {
		t.Errorf("expected message == 'ready' after onCreated, got %v", state["message"])
	}
}

type profileState struct {
	User  userInfo `json:"user"`
	Tags  []string `json:"tags"`
	Score float64  `json:"score"`
}

type userInfo struct {
	Name string `json:"name"`
	Age  int    `json:"age"`
}

func TestTypedApp_NestedStructMutation(t *testing.T) {
	engine := NewFakeEngine()

	def := NewApp(profileState{
		User:  userInfo{Name: "Alice", Age: 30},
		Tags:  []string{"admin"},
		Score: 1.5,
	}).
		OnAction("rename", func(ctx TypedActionContext[profileState]) {
			ctx.State.User.Name = "Bob"
			ctx.State.User.Age = 31
			ctx.State.Tags = append(ctx.State.Tags, "verified")
			ctx.State.Score = 9.9
		}).
		Build()

	instance := NewModuleInstance(engine, def)
	defer instance.Destroy()

	engine.DispatchActionAs("rename", nil, "test")

	state := instance.GetState()
	user, ok := state["user"].(map[string]any)
	if !ok {
		t.Fatalf("expected user to be map, got %T", state["user"])
	}
	if user["name"] != "Bob" {
		t.Errorf("expected user.name == 'Bob', got %v", user["name"])
	}
	if age, _ := user["age"].(float64); int(age) != 31 {
		t.Errorf("expected user.age == 31, got %v", user["age"])
	}
	tags, _ := state["tags"].([]any)
	if len(tags) != 2 || tags[1] != "verified" {
		t.Errorf("expected tags to contain 'verified', got %v", tags)
	}
	if score, _ := state["score"].(float64); score != 9.9 {
		t.Errorf("expected score == 9.9, got %v", state["score"])
	}
}

func TestTypedApp_UISetsTemplate(t *testing.T) {
	def := NewApp(counterState{Count: 0}).
		OnAction("inc", func(ctx TypedActionContext[counterState]) {
			ctx.State.Count++
		}).
		UI(`Column { Text("@{state.count}") }`)

	if def.Template == "" {
		t.Error("expected template to be set via UI()")
	}
	if len(def.Actions) != 1 || def.Actions[0] != "inc" {
		t.Errorf("expected Actions == ['inc'], got %v", def.Actions)
	}
}

func TestTypedApp_NoChangeMeansNoNotification(t *testing.T) {
	engine := NewFakeEngine()

	def := NewApp(counterState{Count: 5, Message: "hi"}).
		OnAction("noop", func(ctx TypedActionContext[counterState]) {
			// Read but don't mutate.
			_ = ctx.State.Count
		}).
		Build()

	instance := NewModuleInstance(engine, def)
	defer instance.Destroy()

	engine.mu.Lock()
	engine.notifyCalls = nil
	engine.mu.Unlock()

	engine.DispatchActionAs("noop", nil, "test")

	engine.mu.Lock()
	calls := append([]NotifyCall{}, engine.notifyCalls...)
	engine.mu.Unlock()

	if len(calls) != 0 {
		t.Errorf("expected no state changes for noop handler, got %v", calls)
	}
}

// ---------------------------------------------------------------------------
// Typed equivalents of the user-facing scenarios in app_test.go, ensuring the
// typed layer (NewApp[T]) has first-class coverage of action metadata,
// lifecycle hooks, router context, and global context access.
// ---------------------------------------------------------------------------

func TestTypedApp_RegistersModuleAndRunsOnCreated(t *testing.T) {
	engine := NewFakeEngine()
	createdCalled := false

	def := NewApp(
		counterState{Count: 0},
		&ModuleOptions{Name: "Counter"},
	).
		OnCreated(func(state *counterState, _ GlobalContext) {
			createdCalled = true
			state.Count = 1
		}).
		OnAction("increment", func(ctx TypedActionContext[counterState]) {
			ctx.State.Count++
		}).
		Build()

	_ = NewModuleInstance(engine, def)

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

func TestTypedApp_ActionContextCarriesNamePayloadSender(t *testing.T) {
	engine := NewFakeEngine()

	var gotName, gotSender string
	var gotPayload any

	def := NewApp(counterState{Count: 0}).
		OnAction("increment", func(ctx TypedActionContext[counterState]) {
			gotName = ctx.Action.Name
			gotPayload = ctx.Action.Payload
			gotSender = ctx.Action.Sender

			if step, ok := ctx.Action.Payload.(float64); ok {
				ctx.State.Count += int(step)
			}
		}).
		Build()

	instance := NewModuleInstance(engine, def)
	defer instance.Destroy()

	engine.DispatchActionAs("increment", float64(3), "ui")
	time.Sleep(50 * time.Millisecond)

	if gotName != "increment" {
		t.Errorf("expected action name 'increment', got %q", gotName)
	}
	if gotPayload != float64(3) {
		t.Errorf("expected payload 3, got %v", gotPayload)
	}
	if gotSender != "ui" {
		t.Errorf("expected sender 'ui', got %q", gotSender)
	}
	if count, _ := instance.GetState()["count"].(float64); int(count) != 3 {
		t.Errorf("expected count=3, got %v", instance.GetState()["count"])
	}
}

func TestTypedApp_DestroyInvokesOnDestroyedOnce(t *testing.T) {
	engine := NewFakeEngine()
	destroyedCount := 0
	mu := sync.Mutex{}

	type activeState struct {
		Active bool `json:"active"`
	}

	def := NewApp(activeState{Active: true}).
		OnDestroyed(func(_ *activeState, _ GlobalContext) {
			mu.Lock()
			destroyedCount++
			mu.Unlock()
		}).
		Build()

	instance := NewModuleInstance(engine, def)
	instance.Destroy()
	instance.Destroy() // idempotent

	mu.Lock()
	defer mu.Unlock()

	if destroyedCount != 1 {
		t.Errorf("expected destroyedCount=1, got %d", destroyedCount)
	}
}

func TestTypedApp_HandlerReceivesRouterContext(t *testing.T) {
	engine := NewFakeEngine()
	router := NewHypenRouter()
	globalCtx := NewHypenGlobalContext()
	globalCtx.SetRouter(router)

	var capturedRouter *HypenRouter

	type empty struct{}

	def := NewApp(empty{}).
		OnAction("navigate", func(ctx TypedActionContext[empty]) {
			capturedRouter = ctx.Context.GetRouter()
		}).
		Build()

	_ = NewModuleInstance(engine, def, WithRouter(&RouterContext{Root: router}), WithGlobalContext(globalCtx))

	engine.DispatchActionAs("navigate", nil, "")

	if capturedRouter != router {
		t.Error("expected router to be accessible via ctx.Context.GetRouter()")
	}
}

func TestTypedApp_HandlerReceivesGlobalContext(t *testing.T) {
	engine := NewFakeEngine()
	globalContext := NewHypenGlobalContext()

	var capturedContext GlobalContext

	type empty struct{}

	def := NewApp(empty{}).
		OnAction("test", func(ctx TypedActionContext[empty]) {
			capturedContext = ctx.Context
		}).
		Build()

	instance := NewModuleInstance(engine, def, WithGlobalContext(globalContext))
	globalContext.RegisterModule("test", instance)

	engine.DispatchActionAs("test", nil, "")

	if capturedContext == nil {
		t.Error("expected context to be passed to typed action handler")
	}
}

func TestTypedApp_OnErrorHandlerCatchesPanic(t *testing.T) {
	engine := NewFakeEngine()
	var handledErr error

	def := NewApp(counterState{Count: 0}).
		OnAction("boom", func(ctx TypedActionContext[counterState]) {
			panic("kaboom")
		}).
		OnError(func(ctx ErrorContext) *ErrorHandlerResult {
			handledErr = ctx.Error
			return &ErrorHandlerResult{Handled: true}
		}).
		Build()

	_ = NewModuleInstance(engine, def)
	engine.DispatchActionAs("boom", nil, "")

	if handledErr == nil {
		t.Error("expected OnError handler to receive the panic")
	}
}
