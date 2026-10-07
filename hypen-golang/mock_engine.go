package core

import (
	"strings"
	"sync"
)

// MockEngine provides a test implementation of IEngine for unit testing modules
// without requiring the actual WASM engine.
//
// Usage:
//
//	type CounterState struct {
//	    Count int `json:"count"`
//	}
//
//	engine := core.NewMockEngine()
//	definition := core.NewApp(CounterState{Count: 0}).
//	    OnAction("increment", func(ctx core.TypedActionContext[CounterState]) {
//	        ctx.State.Count++
//	    }).
//	    Build()
//
//	instance := core.NewModuleInstance(engine, definition)
//
//	// Trigger an action
//	engine.TriggerAction("increment", nil)
//
//	// Verify state changes
//	changes := engine.GetStateChanges()
type MockEngine struct {
	mu sync.RWMutex

	// Module registration
	ModuleName         string
	Actions            []string
	StateKeys          []string
	InitialState       map[string]any
	SetModuleCallCount int

	// Named-module registration (for nested modules)
	RegisteredModules       map[string]MockRegisteredModule
	RegisterModuleCallCount int

	// Action handlers
	actionHandlers map[string]func(action Action)

	// State change tracking
	stateChanges []MockStateChange

	// Render callback
	renderCallback func(patches []Patch)

	// Dispatched actions for verification
	dispatchedActions []Action
}

// MockRegisteredModule records a RegisterModule call
type MockRegisteredModule struct {
	Name         string
	Actions      []string
	StateKeys    []string
	InitialState map[string]any
}

// MockStateChange records a state change notification. Scope is empty for
// primary-module updates and set to the module name for nested updates.
type MockStateChange struct {
	Scope  string
	Paths  []string
	Values map[string]any
}

// NewMockEngine creates a new MockEngine for testing
func NewMockEngine() *MockEngine {
	return &MockEngine{
		actionHandlers:    make(map[string]func(action Action)),
		stateChanges:      []MockStateChange{},
		dispatchedActions: []Action{},
		RegisteredModules: make(map[string]MockRegisteredModule),
	}
}

// SetModule implements IEngine.SetModule
func (e *MockEngine) SetModule(name string, actions []string, stateKeys []string, initialState any) {
	e.mu.Lock()
	defer e.mu.Unlock()

	e.ModuleName = name
	e.Actions = actions
	e.StateKeys = stateKeys
	e.SetModuleCallCount++

	if state, ok := initialState.(map[string]any); ok {
		e.InitialState = state
	}
}

// RegisterModule implements IEngine.RegisterModule
func (e *MockEngine) RegisterModule(name string, actions []string, stateKeys []string, initialState any) {
	e.mu.Lock()
	defer e.mu.Unlock()

	e.RegisterModuleCallCount++
	var state map[string]any
	if s, ok := initialState.(map[string]any); ok {
		state = s
	}
	e.RegisteredModules[name] = MockRegisteredModule{
		Name:         name,
		Actions:      actions,
		StateKeys:    stateKeys,
		InitialState: state,
	}
}

// OnAction implements IEngine.OnAction
func (e *MockEngine) OnAction(actionName string, handler func(action Action)) {
	e.mu.Lock()
	defer e.mu.Unlock()

	e.actionHandlers[actionName] = handler
}

// NotifyStateChange implements IEngine.NotifyStateChange
func (e *MockEngine) NotifyStateChange(scope string, paths []string, changedValues map[string]any) {
	e.mu.Lock()
	defer e.mu.Unlock()

	e.stateChanges = append(e.stateChanges, MockStateChange{
		Scope:  scope,
		Paths:  paths,
		Values: changedValues,
	})
}

// TriggerAction simulates dispatching an action (for testing).
// Equivalent to DispatchAction but with a "test" sender and no error
// return — kept for backward compatibility with existing tests.
func (e *MockEngine) TriggerAction(name string, payload any) {
	_ = e.DispatchAction(name, payload)
}

// DispatchAction implements IEngine.DispatchAction. For the mock, this
// looks up the registered handler and fires it synchronously. Returns
// nil unconditionally — MockEngine doesn't surface ActionNotFound.
func (e *MockEngine) DispatchAction(name string, payload any) error {
	e.mu.RLock()
	handler, exists := e.actionHandlers[name]
	if !exists {
		for key, candidate := range e.actionHandlers {
			if strings.HasPrefix(key, "__hypen_scoped:") && strings.HasSuffix(key, ":"+name) {
				if exists {
					handler = nil
					break
				}
				handler, exists = candidate, true
			}
		}
	}
	e.mu.RUnlock()

	action := Action{
		Name:    name,
		Payload: payload,
		Sender:  "test",
	}

	e.mu.Lock()
	e.dispatchedActions = append(e.dispatchedActions, action)
	e.mu.Unlock()

	if exists && handler != nil {
		handler(action)
	}
	return nil
}

// GetStateChanges returns all recorded state changes
func (e *MockEngine) GetStateChanges() []MockStateChange {
	e.mu.RLock()
	defer e.mu.RUnlock()

	result := make([]MockStateChange, len(e.stateChanges))
	copy(result, e.stateChanges)
	return result
}

// GetDispatchedActions returns all dispatched actions
func (e *MockEngine) GetDispatchedActions() []Action {
	e.mu.RLock()
	defer e.mu.RUnlock()

	result := make([]Action, len(e.dispatchedActions))
	copy(result, e.dispatchedActions)
	return result
}

// ClearStateChanges clears recorded state changes
func (e *MockEngine) ClearStateChanges() {
	e.mu.Lock()
	defer e.mu.Unlock()

	e.stateChanges = []MockStateChange{}
}

// ClearDispatchedActions clears recorded dispatched actions
func (e *MockEngine) ClearDispatchedActions() {
	e.mu.Lock()
	defer e.mu.Unlock()

	e.dispatchedActions = []Action{}
}

// HasAction checks if an action handler is registered
func (e *MockEngine) HasAction(name string) bool {
	e.mu.RLock()
	defer e.mu.RUnlock()

	_, exists := e.actionHandlers[name]
	for key := range e.actionHandlers {
		if strings.HasPrefix(key, "__hypen_scoped:") && strings.HasSuffix(key, ":"+name) {
			return true
		}
	}
	return exists
}

// GetRegisteredActions returns all registered action names
func (e *MockEngine) GetRegisteredActions() []string {
	e.mu.RLock()
	defer e.mu.RUnlock()

	actions := make([]string, 0, len(e.actionHandlers))
	for name := range e.actionHandlers {
		actions = append(actions, name)
	}
	return actions
}

// SetRenderCallback sets a callback for when patches would be rendered
func (e *MockEngine) SetRenderCallback(callback func(patches []Patch)) {
	e.mu.Lock()
	defer e.mu.Unlock()

	e.renderCallback = callback
}

// SimulateRender simulates sending patches (for testing renderers)
func (e *MockEngine) SimulateRender(patches []Patch) {
	e.mu.RLock()
	callback := e.renderCallback
	e.mu.RUnlock()

	if callback != nil {
		callback(patches)
	}
}

// Reset clears all state for a fresh test
func (e *MockEngine) Reset() {
	e.mu.Lock()
	defer e.mu.Unlock()

	e.ModuleName = ""
	e.Actions = nil
	e.StateKeys = nil
	e.InitialState = nil
	e.RegisteredModules = make(map[string]MockRegisteredModule)
	e.RegisterModuleCallCount = 0
	e.actionHandlers = make(map[string]func(action Action))
	e.stateChanges = []MockStateChange{}
	e.dispatchedActions = []Action{}
	e.renderCallback = nil
}

// Verify MockEngine implements IEngine
var _ IEngine = (*MockEngine)(nil)
