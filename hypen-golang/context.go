package core

import (
	"sync"
)

var logContext = LogContext

// ModuleReference provides access to a module's state
type ModuleReference struct {
	state    *ObservableState
	instance *ModuleInstance
}

// State returns the live state proxy
func (r *ModuleReference) State() *ObservableState {
	return r.state
}

// SetState updates the module state
func (r *ModuleReference) SetState(patch map[string]any) {
	r.instance.UpdateState(patch)
}

// GetState returns a snapshot of the state
func (r *ModuleReference) GetState() map[string]any {
	return r.instance.GetState()
}

// HypenGlobalContext provides cross-module communication and state access
type HypenGlobalContext struct {
	mu             sync.RWMutex
	modules        map[string]*ModuleInstance
	typedEvents    *TypedEventEmitter
	legacyEventBus map[string]map[*EventHandler]struct{}
	router         *HypenRouter
}

// NewHypenGlobalContext creates a new global context
func NewHypenGlobalContext() *HypenGlobalContext {
	return &HypenGlobalContext{
		modules:        make(map[string]*ModuleInstance),
		typedEvents:    NewTypedEventEmitter(),
		legacyEventBus: make(map[string]map[*EventHandler]struct{}),
	}
}

// Events returns the typed event emitter
func (c *HypenGlobalContext) Events() *TypedEventEmitter {
	return c.typedEvents
}

// RegisterModule registers a module instance with an ID
func (c *HypenGlobalContext) RegisterModule(id string, instance *ModuleInstance) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if _, exists := c.modules[id]; exists {
		logContext.Warn("Module %q is already registered. Overwriting.", id)
	}
	c.modules[id] = instance
	logContext.Debug("Registered module: %s", id)
}

// UnregisterModule removes a module
func (c *HypenGlobalContext) UnregisterModule(id string) {
	c.mu.Lock()
	defer c.mu.Unlock()

	delete(c.modules, id)
	logContext.Debug("Unregistered module: %s", id)
}

// GetModule returns a module reference by ID, or nil if not found.
// Use HasModule() to check existence before calling if a nil return is undesirable.
func (c *HypenGlobalContext) GetModule(id string) *ModuleReference {
	c.mu.RLock()
	defer c.mu.RUnlock()

	module, exists := c.modules[id]
	if !exists {
		logContext.Warn("Module %q not found. Available modules: %v", id, c.moduleIds())
		return nil
	}

	return &ModuleReference{
		state:    module.GetLiveState(),
		instance: module,
	}
}

// moduleIds returns the list of registered module IDs (caller must hold at least RLock).
func (c *HypenGlobalContext) moduleIds() []string {
	ids := make([]string, 0, len(c.modules))
	for k := range c.modules {
		ids = append(ids, k)
	}
	return ids
}

// HasModule checks if a module exists
func (c *HypenGlobalContext) HasModule(id string) bool {
	c.mu.RLock()
	defer c.mu.RUnlock()

	_, exists := c.modules[id]
	return exists
}

// GetModuleIds returns all registered module IDs
func (c *HypenGlobalContext) GetModuleIds() []string {
	c.mu.RLock()
	defer c.mu.RUnlock()

	ids := make([]string, 0, len(c.modules))
	for id := range c.modules {
		ids = append(ids, id)
	}
	return ids
}

// GetGlobalState returns the entire app state tree (snapshot)
func (c *HypenGlobalContext) GetGlobalState() map[string]any {
	c.mu.RLock()
	defer c.mu.RUnlock()

	state := make(map[string]any)
	for id, module := range c.modules {
		state[id] = module.GetState()
	}
	return state
}

// Emit emits an event to the legacy event bus
func (c *HypenGlobalContext) Emit(event string, payload any) {
	c.mu.RLock()
	handlers, exists := c.legacyEventBus[event]
	if !exists || len(handlers) == 0 {
		c.mu.RUnlock()
		logContext.Debug("Event %q emitted but no listeners", event)
	} else {
		logContext.Debug("Emitting event: %s %v", event, payload)
		// Copy handlers to avoid holding lock during callback execution
		handlersCopy := make([]*EventHandler, 0, len(handlers))
		for h := range handlers {
			handlersCopy = append(handlersCopy, h)
		}
		c.mu.RUnlock()

		for _, handler := range handlersCopy {
			func() {
				defer func() {
					if r := recover(); r != nil {
						logContext.Error("Error in event handler for %q: %v", event, r)
					}
				}()
				(*handler)(payload)
			}()
		}
	}

	// Also emit to typed event system
	c.typedEvents.Emit(event, payload)
}

// On subscribes to an event (legacy API)
func (c *HypenGlobalContext) On(event string, handler EventHandler) func() {
	c.mu.Lock()
	defer c.mu.Unlock()

	if _, exists := c.legacyEventBus[event]; !exists {
		c.legacyEventBus[event] = make(map[*EventHandler]struct{})
	}

	// Heap-allocate the handler to ensure the pointer remains valid
	// after this function returns (taking &handler would point to the stack)
	handlerPtr := new(EventHandler)
	*handlerPtr = handler
	c.legacyEventBus[event][handlerPtr] = struct{}{}

	logContext.Debug("Listening to event: %s", event)

	// Return unsubscribe function
	return func() {
		c.mu.Lock()
		defer c.mu.Unlock()

		if handlers, exists := c.legacyEventBus[event]; exists {
			delete(handlers, handlerPtr)
			if len(handlers) == 0 {
				delete(c.legacyEventBus, event)
			}
		}
	}
}

// Off unsubscribes a handler from an event
func (c *HypenGlobalContext) Off(event string, handler *EventHandler) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if handlers, exists := c.legacyEventBus[event]; exists {
		delete(handlers, handler)
		if len(handlers) == 0 {
			delete(c.legacyEventBus, event)
		}
	}
}

// ClearEvent removes all handlers for an event
func (c *HypenGlobalContext) ClearEvent(event string) {
	c.mu.Lock()
	defer c.mu.Unlock()

	delete(c.legacyEventBus, event)
}

// ClearAllEvents removes all handlers for all events
func (c *HypenGlobalContext) ClearAllEvents() {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.legacyEventBus = make(map[string]map[*EventHandler]struct{})
}

// Debug returns debug information about the context
func (c *HypenGlobalContext) Debug() ContextDebugInfo {
	c.mu.RLock()
	defer c.mu.RUnlock()

	events := make([]string, 0, len(c.legacyEventBus))
	for event := range c.legacyEventBus {
		events = append(events, event)
	}

	return ContextDebugInfo{
		Modules:     c.GetModuleIds(),
		Events:      events,
		TypedEvents: c.typedEvents.EventNames(),
		State:       c.GetGlobalState(),
	}
}

// ContextDebugInfo contains debug information
type ContextDebugInfo struct {
	Modules     []string
	Events      []string
	TypedEvents []string
	State       map[string]any
}

// SetRouter sets the router instance
func (c *HypenGlobalContext) SetRouter(router *HypenRouter) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.router = router
}

// GetRouter returns the router instance
func (c *HypenGlobalContext) GetRouter() *HypenRouter {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.router
}
