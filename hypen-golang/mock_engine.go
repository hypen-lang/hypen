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

	// nodes models the part of a render tree the client entry checks:
	// live node id -> the module scope that owns it and the actions it
	// carries (see DeclareNodeAction).
	nodes map[string]*mockNode
}

type mockNode struct {
	scope   string
	actions map[string]bool
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
		nodes:             make(map[string]*mockNode),
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

// mockUIEnvelope is the engine's UI dispatch envelope name.
const mockUIEnvelope = "__hypen_dispatch"

// DeclareNodeAction models a live, attached node `nodeID`, owned by module
// `scope` ("" for the primary module), that carries `action` — what
// `.onClick(@actions.<action>)` declares in a real template. For the
// reserved writes it stands for the `.bind` / pin declaration
// (`__hypen_bind`, `__hypen_reorder`, `__hypen_pin`). Calling it again adds
// more actions to the same node.
//
// The MockEngine renders nothing, so this is the only way its
// DispatchClientAction can accept an envelope. It does NOT model the
// engine's payload checks for the reserved writes (the bound path must
// match the node's `.bind`) — test those against the real WasmEngine.
func (e *MockEngine) DeclareNodeAction(nodeID, scope, action string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	n := e.nodes[nodeID]
	if n == nil {
		n = &mockNode{scope: scope, actions: make(map[string]bool)}
		e.nodes[nodeID] = n
	}
	n.actions[action] = true
}

// RemoveNode models the node leaving the tree: envelopes addressed to it
// are refused afterwards.
func (e *MockEngine) RemoveNode(nodeID string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	delete(e.nodes, nodeID)
}

// DispatchClientAction implements IEngine.DispatchClientAction with the
// engine's client-entry rule over the nodes declared by DeclareNodeAction:
// only a `__hypen_dispatch` envelope is accepted, its node must be declared
// and must carry the inner action, and a nested envelope, a
// `__hypen_scoped:` name or any other `__hypen_*` name is refused. The
// accepted action runs the handler registered for
// `__hypen_scoped:<scope>:<action>` (or, for the primary module, a bare
// `<action>` registration) with the envelope's inner payload and the node
// as Sender.
func (e *MockEngine) DispatchClientAction(name string, payload any) error {
	refuse := func(reason string) error {
		return &EngineError{Code: ErrActionNotFound, Message: "client action refused: " + reason}
	}
	if name != mockUIEnvelope {
		return refuse("client actions must be node-addressed")
	}
	env, ok := payload.(map[string]any)
	if !ok {
		return refuse("invalid scoped UI action")
	}
	node, _ := env["node"].(string)
	inner, _ := env["action"].(string)
	if node == "" || inner == "" || inner == mockUIEnvelope || strings.HasPrefix(inner, "__hypen_scoped:") {
		return refuse("invalid scoped UI action")
	}

	e.mu.RLock()
	n := e.nodes[node]
	var scope string
	carried := false
	if n != nil {
		scope = n.scope
		carried = n.actions[inner]
	}
	e.mu.RUnlock()
	if n == nil {
		return refuse("stale UI action target")
	}
	reservedWrite := inner == "__hypen_bind" || inner == "__hypen_reorder" || inner == "__hypen_pin"
	if (strings.HasPrefix(inner, "__hypen_") && !reservedWrite) || !carried {
		return refuse("UI action is not bound on the target node")
	}

	resolved := "__hypen_scoped:" + strings.ToLower(scope) + ":" + inner
	e.mu.RLock()
	handler, exists := e.actionHandlers[resolved]
	if !exists && scope == "" {
		if h, ok := e.actionHandlers[inner]; ok {
			handler, exists, resolved = h, true, inner
		}
	}
	e.mu.RUnlock()
	if !exists {
		return refuse("invalid scoped UI action")
	}

	action := Action{Name: resolved, Payload: env["payload"], Sender: node}
	e.mu.Lock()
	e.dispatchedActions = append(e.dispatchedActions, action)
	e.mu.Unlock()
	if handler != nil {
		handler(action)
	}
	return nil
}
