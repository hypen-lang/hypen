package core

import (
	"sync"
)

var logEvents = LogEvents

// EventHandler is a function that handles an event
type EventHandler func(payload any)

// TypedEventEmitter provides a type-safe event emission and subscription system
type TypedEventEmitter struct {
	mu       sync.RWMutex
	eventBus map[string]map[*EventHandler]struct{}
}

// NewTypedEventEmitter creates a new TypedEventEmitter
func NewTypedEventEmitter() *TypedEventEmitter {
	return &TypedEventEmitter{
		eventBus: make(map[string]map[*EventHandler]struct{}),
	}
}

// Emit emits an event with a payload to all subscribed handlers
func (e *TypedEventEmitter) Emit(event string, payload any) {
	e.mu.RLock()
	handlers, exists := e.eventBus[event]
	if !exists || len(handlers) == 0 {
		e.mu.RUnlock()
		return
	}

	// Copy handlers to avoid holding lock during callback execution
	handlersCopy := make([]*EventHandler, 0, len(handlers))
	for h := range handlers {
		handlersCopy = append(handlersCopy, h)
	}
	e.mu.RUnlock()

	for _, handler := range handlersCopy {
		func() {
			defer func() {
				if r := recover(); r != nil {
					logEvents.Error("Error in event handler for %q: %v", event, r)
				}
			}()
			(*handler)(payload)
		}()
	}
}

// On subscribes to an event and returns an unsubscribe function
func (e *TypedEventEmitter) On(event string, handler EventHandler) func() {
	e.mu.Lock()
	defer e.mu.Unlock()

	if _, exists := e.eventBus[event]; !exists {
		e.eventBus[event] = make(map[*EventHandler]struct{})
	}

	// Heap-allocate the handler to ensure the pointer remains valid
	// after this function returns (taking &handler would point to the stack)
	handlerPtr := new(EventHandler)
	*handlerPtr = handler
	e.eventBus[event][handlerPtr] = struct{}{}

	// Return unsubscribe function
	return func() {
		e.mu.Lock()
		defer e.mu.Unlock()

		if handlers, exists := e.eventBus[event]; exists {
			delete(handlers, handlerPtr)
			if len(handlers) == 0 {
				delete(e.eventBus, event)
			}
		}
	}
}

// Once subscribes to an event once (auto-unsubscribes after first emit)
func (e *TypedEventEmitter) Once(event string, handler EventHandler) func() {
	var mu sync.Mutex
	var unsubscribe func()
	var once sync.Once

	wrappedHandler := func(payload any) {
		once.Do(func() {
			handler(payload)
			mu.Lock()
			unsub := unsubscribe
			mu.Unlock()
			if unsub != nil {
				unsub()
			}
		})
	}

	mu.Lock()
	unsubscribe = e.On(event, wrappedHandler)
	mu.Unlock()
	return unsubscribe
}

// Off removes a specific handler from an event
// Note: In Go, we can't compare function pointers directly,
// so this method removes the handler by reference
func (e *TypedEventEmitter) Off(event string, handler *EventHandler) {
	e.mu.Lock()
	defer e.mu.Unlock()

	if handlers, exists := e.eventBus[event]; exists {
		delete(handlers, handler)
		if len(handlers) == 0 {
			delete(e.eventBus, event)
		}
	}
}

// RemoveAllListeners removes all listeners for a specific event
func (e *TypedEventEmitter) RemoveAllListeners(event string) {
	e.mu.Lock()
	defer e.mu.Unlock()

	delete(e.eventBus, event)
}

// ClearAll removes all listeners for all events
func (e *TypedEventEmitter) ClearAll() {
	e.mu.Lock()
	defer e.mu.Unlock()

	e.eventBus = make(map[string]map[*EventHandler]struct{})
}

// ListenerCount returns the number of listeners for an event
func (e *TypedEventEmitter) ListenerCount(event string) int {
	e.mu.RLock()
	defer e.mu.RUnlock()

	if handlers, exists := e.eventBus[event]; exists {
		return len(handlers)
	}
	return 0
}

// EventNames returns all registered event names
func (e *TypedEventEmitter) EventNames() []string {
	e.mu.RLock()
	defer e.mu.RUnlock()

	names := make([]string, 0, len(e.eventBus))
	for name := range e.eventBus {
		names = append(names, name)
	}
	return names
}

// HypenFrameworkEvents defines the standard framework events
type HypenFrameworkEvents struct {
	ModuleCreated   ModuleCreatedEvent
	ModuleDestroyed ModuleDestroyedEvent
	RouteChanged    RouteChangedEvent
	StateUpdated    StateUpdatedEvent
	ActionDispatched ActionDispatchedEvent
	Error           ErrorEvent
}

// ModuleCreatedEvent is emitted when a module is created
type ModuleCreatedEvent struct {
	ModuleID string
}

// ModuleDestroyedEvent is emitted when a module is destroyed
type ModuleDestroyedEvent struct {
	ModuleID string
}

// RouteChangedEvent is emitted when the route changes
type RouteChangedEvent struct {
	From string
	To   string
}

// StateUpdatedEvent is emitted when state is updated
type StateUpdatedEvent struct {
	ModuleID string
	Paths    []string
}

// ActionDispatchedEvent is emitted when an action is dispatched
type ActionDispatchedEvent struct {
	ModuleID   string
	ActionName string
	Payload    any
}

// ErrorEvent is emitted when an error occurs
type ErrorEvent struct {
	Message string
	Error   error
	Context string
}

// Event name constants
const (
	EventModuleCreated    = "module:created"
	EventModuleDestroyed  = "module:destroyed"
	EventRouteChanged     = "route:changed"
	EventStateUpdated     = "state:updated"
	EventActionDispatched = "action:dispatched"
	EventError            = "error"
)

// CreateEventEmitter creates a new TypedEventEmitter
func CreateEventEmitter() *TypedEventEmitter {
	return NewTypedEventEmitter()
}
