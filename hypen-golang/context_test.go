package core

import (
	"strings"
	"sync"
	"testing"
)

// FakeEngine for testing
type FakeEngine struct {
	setModuleCalls []SetModuleCall
	notifyCalls    []NotifyCall
	actionHandlers map[string]func(action Action)
	mu             sync.Mutex
}

type SetModuleCall struct {
	Name         string
	Actions      []string
	StateKeys    []string
	InitialState any
}

type NotifyCall struct {
	Paths         []string
	ChangedValues map[string]any
}

func NewFakeEngine() *FakeEngine {
	return &FakeEngine{
		setModuleCalls: []SetModuleCall{},
		notifyCalls:    []NotifyCall{},
		actionHandlers: make(map[string]func(action Action)),
	}
}

func (e *FakeEngine) SetModule(name string, actions []string, stateKeys []string, initialState any) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.setModuleCalls = append(e.setModuleCalls, SetModuleCall{
		Name:         name,
		Actions:      actions,
		StateKeys:    stateKeys,
		InitialState: initialState,
	})
}

func (e *FakeEngine) RegisterModule(name string, actions []string, stateKeys []string, initialState any) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.setModuleCalls = append(e.setModuleCalls, SetModuleCall{
		Name:         name,
		Actions:      actions,
		StateKeys:    stateKeys,
		InitialState: initialState,
	})
}

func (e *FakeEngine) NotifyStateChange(scope string, paths []string, changedValues map[string]any) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.notifyCalls = append(e.notifyCalls, NotifyCall{
		Paths:         paths,
		ChangedValues: changedValues,
	})
}

func (e *FakeEngine) OnAction(actionName string, handler func(action Action)) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.actionHandlers[actionName] = handler
}

// DispatchAction implements IEngine.DispatchAction. Dispatches with an
// empty sender string. Tests that need a specific sender can use
// DispatchActionAs instead.
func (e *FakeEngine) DispatchAction(name string, payload any) error {
	e.DispatchActionAs(name, payload, "")
	return nil
}

// DispatchActionAs is a FakeEngine-only helper that lets tests specify
// a sender field on the dispatched Action. Not part of IEngine.
func (e *FakeEngine) DispatchActionAs(name string, payload any, sender string) {
	e.mu.Lock()
	handler := e.actionHandlers[name]
	if handler == nil {
		for key, candidate := range e.actionHandlers {
			if strings.HasPrefix(key, "__hypen_scoped:") && strings.HasSuffix(key, ":"+name) {
				if handler != nil {
					handler = nil
					break
				}
				handler = candidate
			}
		}
	}
	e.mu.Unlock()
	if handler != nil {
		handler(Action{Name: name, Payload: payload, Sender: sender})
	}
}

// FakeModuleInstance for testing context
type FakeModuleInstance struct {
	liveState map[string]any
	state     map[string]any
	updates   []map[string]any
	mu        sync.Mutex
}

func NewFakeModuleInstance(state map[string]any) *FakeModuleInstance {
	return &FakeModuleInstance{
		liveState: state,
		state:     DeepClone(state),
		updates:   []map[string]any{},
	}
}

func (m *FakeModuleInstance) GetLiveState() *ObservableState {
	return NewObservableState(m.liveState, nil)
}

func (m *FakeModuleInstance) GetState() map[string]any {
	m.mu.Lock()
	defer m.mu.Unlock()
	return DeepClone(m.state)
}

func (m *FakeModuleInstance) UpdateState(patch map[string]any) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.updates = append(m.updates, patch)
	for k, v := range patch {
		m.state[k] = v
	}
}

func TestHypenGlobalContext_RegistersModule(t *testing.T) {
	context := NewHypenGlobalContext()
	instance := NewFakeModuleInstance(map[string]any{"count": float64(0)})

	// Need to wrap with a real ModuleInstance
	engine := NewFakeEngine()
	def := App.DefineState(map[string]any{"count": float64(0)}, nil).Build()
	moduleInstance := NewModuleInstance(engine, def)

	context.RegisterModule("counter", moduleInstance)

	if !context.HasModule("counter") {
		t.Error("expected module 'counter' to be registered")
	}

	ids := context.GetModuleIds()
	found := false
	for _, id := range ids {
		if id == "counter" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected 'counter' in module ids, got %v", ids)
	}

	_ = instance // Use the fake instance
}

func TestHypenGlobalContext_UnregistersModule(t *testing.T) {
	context := NewHypenGlobalContext()
	engine := NewFakeEngine()
	def := App.DefineState(map[string]any{}, nil).Build()
	instance := NewModuleInstance(engine, def)

	context.RegisterModule("test", instance)
	if !context.HasModule("test") {
		t.Error("expected module to be registered")
	}

	context.UnregisterModule("test")
	if context.HasModule("test") {
		t.Error("expected module to be unregistered")
	}
}

func TestHypenGlobalContext_UnregisteringNonExistentModuleIsSafe(t *testing.T) {
	context := NewHypenGlobalContext()

	// Should not panic
	context.UnregisterModule("nonexistent")
}

func TestHypenGlobalContext_GetModuleReturnsModuleReference(t *testing.T) {
	context := NewHypenGlobalContext()
	engine := NewFakeEngine()
	def := App.DefineState(map[string]any{"count": float64(42)}, nil).Build()
	instance := NewModuleInstance(engine, def)

	context.RegisterModule("counter", instance)
	ref := context.GetModule("counter")

	state := ref.GetState()
	if state["count"] != float64(42) {
		t.Errorf("expected count=42, got %v", state["count"])
	}
}

func TestHypenGlobalContext_GetModuleReturnsNilForNonExistent(t *testing.T) {
	context := NewHypenGlobalContext()

	ref := context.GetModule("nonexistent")
	if ref != nil {
		t.Error("expected nil for non-existent module")
	}
}

func TestHypenGlobalContext_GetModuleReturnsNilWithAvailableModules(t *testing.T) {
	context := NewHypenGlobalContext()
	engine := NewFakeEngine()
	def := App.DefineState(map[string]any{}, nil).Build()
	instance := NewModuleInstance(engine, def)

	context.RegisterModule("module1", instance)
	context.RegisterModule("module2", instance)

	ref := context.GetModule("nonexistent")
	if ref != nil {
		t.Error("expected nil for non-existent module")
	}

	// Verify existing modules still work
	ref1 := context.GetModule("module1")
	if ref1 == nil {
		t.Error("expected module1 to exist")
	}
	ref2 := context.GetModule("module2")
	if ref2 == nil {
		t.Error("expected module2 to exist")
	}
}

func TestHypenGlobalContext_HasModuleReturnsTrueForRegistered(t *testing.T) {
	context := NewHypenGlobalContext()
	engine := NewFakeEngine()
	def := App.DefineState(map[string]any{}, nil).Build()
	instance := NewModuleInstance(engine, def)

	context.RegisterModule("test", instance)
	if !context.HasModule("test") {
		t.Error("expected HasModule to return true")
	}
}

func TestHypenGlobalContext_HasModuleReturnsFalseForNonExistent(t *testing.T) {
	context := NewHypenGlobalContext()
	if context.HasModule("nonexistent") {
		t.Error("expected HasModule to return false")
	}
}

func TestHypenGlobalContext_GetModuleIdsReturnsEmptyWhenNoModules(t *testing.T) {
	context := NewHypenGlobalContext()
	ids := context.GetModuleIds()
	if len(ids) != 0 {
		t.Errorf("expected empty array, got %v", ids)
	}
}

func TestHypenGlobalContext_GetModuleIdsReturnsAllRegistered(t *testing.T) {
	context := NewHypenGlobalContext()
	engine := NewFakeEngine()
	def := App.DefineState(map[string]any{}, nil).Build()
	instance := NewModuleInstance(engine, def)

	context.RegisterModule("module1", instance)
	context.RegisterModule("module2", instance)
	context.RegisterModule("module3", instance)

	ids := context.GetModuleIds()
	if len(ids) != 3 {
		t.Errorf("expected 3 module ids, got %d", len(ids))
	}
}

func TestHypenGlobalContext_GetGlobalStateReturnsEmptyWhenNoModules(t *testing.T) {
	context := NewHypenGlobalContext()
	state := context.GetGlobalState()
	if len(state) != 0 {
		t.Errorf("expected empty state, got %v", state)
	}
}

func TestHypenGlobalContext_GetGlobalStateReturnsAllModuleStates(t *testing.T) {
	context := NewHypenGlobalContext()
	engine := NewFakeEngine()

	def1 := App.DefineState(map[string]any{"count": float64(1)}, nil).Build()
	instance1 := NewModuleInstance(engine, def1)

	def2 := App.DefineState(map[string]any{"name": "test"}, nil).Build()
	instance2 := NewModuleInstance(engine, def2)

	context.RegisterModule("counter", instance1)
	context.RegisterModule("profile", instance2)

	state := context.GetGlobalState()

	counterState, ok := state["counter"].(map[string]any)
	if !ok || counterState["count"] != float64(1) {
		t.Errorf("expected counter.count=1, got %v", state["counter"])
	}

	profileState, ok := state["profile"].(map[string]any)
	if !ok || profileState["name"] != "test" {
		t.Errorf("expected profile.name='test', got %v", state["profile"])
	}
}

func TestHypenGlobalContext_EmitEmitsToHandlers(t *testing.T) {
	context := NewHypenGlobalContext()
	received := false
	var payload any

	context.On("test-event", func(p any) {
		received = true
		payload = p
	})

	context.Emit("test-event", map[string]any{"data": "payload"})

	if !received {
		t.Error("expected handler to be called")
	}
	if payload == nil {
		t.Error("expected payload to be received")
	}
}

func TestHypenGlobalContext_EmitToMultipleHandlers(t *testing.T) {
	context := NewHypenGlobalContext()
	callCount := 0
	mu := sync.Mutex{}

	context.On("test-event", func(p any) {
		mu.Lock()
		callCount++
		mu.Unlock()
	})
	context.On("test-event", func(p any) {
		mu.Lock()
		callCount++
		mu.Unlock()
	})
	context.On("test-event", func(p any) {
		mu.Lock()
		callCount++
		mu.Unlock()
	})

	context.Emit("test-event", "payload")

	mu.Lock()
	defer mu.Unlock()
	if callCount != 3 {
		t.Errorf("expected 3 calls, got %d", callCount)
	}
}

func TestHypenGlobalContext_OnReturnsUnsubscribeFunction(t *testing.T) {
	context := NewHypenGlobalContext()
	callCount := 0
	mu := sync.Mutex{}

	unsubscribe := context.On("test-event", func(p any) {
		mu.Lock()
		callCount++
		mu.Unlock()
	})

	context.Emit("test-event", nil)
	mu.Lock()
	if callCount != 1 {
		mu.Unlock()
		t.Fatalf("expected 1 call, got %d", callCount)
	}
	mu.Unlock()

	unsubscribe()
	context.Emit("test-event", nil)

	mu.Lock()
	defer mu.Unlock()
	if callCount != 1 {
		t.Errorf("expected still 1 call after unsubscribe, got %d", callCount)
	}
}

func TestHypenGlobalContext_ClearEventRemovesAllHandlers(t *testing.T) {
	context := NewHypenGlobalContext()
	callCount := 0

	context.On("test-event", func(p any) { callCount++ })
	context.On("test-event", func(p any) { callCount++ })

	context.ClearEvent("test-event")
	context.Emit("test-event", nil)

	if callCount != 0 {
		t.Errorf("expected 0 calls after ClearEvent, got %d", callCount)
	}
}

func TestHypenGlobalContext_ClearAllEventsRemovesAll(t *testing.T) {
	context := NewHypenGlobalContext()
	callCount := 0

	context.On("event1", func(p any) { callCount++ })
	context.On("event2", func(p any) { callCount++ })
	context.On("event3", func(p any) { callCount++ })

	context.ClearAllEvents()
	context.Emit("event1", nil)
	context.Emit("event2", nil)
	context.Emit("event3", nil)

	if callCount != 0 {
		t.Errorf("expected 0 calls after ClearAllEvents, got %d", callCount)
	}
}

func TestHypenGlobalContext_DebugReturnsInfo(t *testing.T) {
	context := NewHypenGlobalContext()
	engine := NewFakeEngine()
	def := App.DefineState(map[string]any{"count": float64(42)}, nil).Build()
	instance := NewModuleInstance(engine, def)

	context.RegisterModule("counter", instance)
	context.On("test-event", func(p any) {})

	debug := context.Debug()

	found := false
	for _, m := range debug.Modules {
		if m == "counter" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected 'counter' in modules, got %v", debug.Modules)
	}

	found = false
	for _, e := range debug.Events {
		if e == "test-event" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected 'test-event' in events, got %v", debug.Events)
	}
}

func TestHypenGlobalContext_DebugReturnsEmptyWhenNothingRegistered(t *testing.T) {
	context := NewHypenGlobalContext()
	debug := context.Debug()

	if len(debug.Modules) != 0 {
		t.Errorf("expected empty modules, got %v", debug.Modules)
	}
	if len(debug.Events) != 0 {
		t.Errorf("expected empty events, got %v", debug.Events)
	}
	if len(debug.State) != 0 {
		t.Errorf("expected empty state, got %v", debug.State)
	}
}

func TestHypenGlobalContext_ConcurrentAccess(t *testing.T) {
	context := NewHypenGlobalContext()
	var wg sync.WaitGroup

	for i := 0; i < 50; i++ {
		wg.Add(3)

		go func(n int) {
			defer wg.Done()
			engine := NewFakeEngine()
			def := App.DefineState(map[string]any{}, nil).Build()
			instance := NewModuleInstance(engine, def)
			context.RegisterModule(string(rune('a'+n%26)), instance)
		}(i)

		go func() {
			defer wg.Done()
			context.GetModuleIds()
		}()

		go func() {
			defer wg.Done()
			context.Emit("test", nil)
		}()
	}

	wg.Wait()
	// If we get here without panics, concurrent access is safe
}
