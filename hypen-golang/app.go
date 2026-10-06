package core

import (
	"fmt"
	"os"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/hypen-space/core/device"
)

var logModule = LogModule

// Action represents an action dispatched from UI
type Action struct {
	Name    string
	Payload any
	Sender  string
}

// Patch represents a DOM patch
type Patch struct {
	Type        string         `json:"type"`
	ID          string         `json:"id,omitempty"`
	ElementType string         `json:"elementType,omitempty"`
	Props       map[string]any `json:"props,omitempty"`
	Name        string         `json:"name,omitempty"`
	Value       any            `json:"value,omitempty"`
	Text        string         `json:"text,omitempty"`
	ParentID    string         `json:"parentId,omitempty"`
	BeforeID    string         `json:"beforeId,omitempty"`
	EventName   string         `json:"eventName,omitempty"`
	// Transition marks a "remove" whose root carries an exit animation:
	// animation-capable renderers (e.g. a browser client behind the remote
	// relay) defer the teardown and play the exit; everyone else snaps.
	// Carried even though Go renders nothing itself — dropping it here
	// would silently strip exit animations from every Go-hosted app.
	Transition bool `json:"transition,omitempty"`
	// Spec carries the "batchAnimation" prelude's animation spec (Option D
	// transaction-scoped animation): a patch batch whose first entry is
	// {"type":"batchAnimation","spec":{...}} animates every prop change in
	// the batch on animation-capable renderers. Like Transition, it is
	// relayed even though Go renders nothing itself — dropping it here
	// would strip batch animation from every Go-hosted app's remote
	// clients.
	//
	// NOTE: this field is pure relay plumbing today. The Go host does not
	// implement dispatch-side stamping — the `animate:` event argument is
	// TS-host-only for now: Go strips the reserved "__hypenAnimate" payload
	// key before handlers run (remote/session.go), and Go's state-sync path
	// (NotifyStateChange → hypen_update_state) has no animation envelope,
	// so a Go-hosted engine never emits a batchAnimation prelude. The field
	// exists so that IF the engine ever produces one (or patches transit a
	// Go relay), it survives the trip.
	Spec map[string]any `json:"spec,omitempty"`
}

// Patch type constants
const (
	PatchCreate      = "create"
	PatchSetProp     = "setProp"
	PatchSetText     = "setText"
	PatchInsert      = "insert"
	PatchMove        = "move"
	PatchRemove      = "remove"
	PatchRemoveProp  = "removeProp"
	PatchAttachEvent = "attachEvent"
	PatchDetachEvent = "detachEvent"
	// PatchBatchAnimation is the batch-scoped animation prelude — always
	// the FIRST patch of a stamped batch; carries only Spec.
	PatchBatchAnimation = "batchAnimation"
)

// IEngine interface for engine compatibility
type IEngine interface {
	SetModule(name string, actions []string, stateKeys []string, initialState any)
	RegisterModule(name string, actions []string, stateKeys []string, initialState any)
	OnAction(actionName string, handler func(action Action))
	// NotifyStateChange dispatches a state-change notification to the engine.
	//
	// An empty `scope` string targets the primary module slot (installed via
	// SetModule). Any other value targets the named module registered under
	// that name (installed via RegisterModule). The engine's canon_scope
	// helper flattens "" → primary internally, so empty-string and
	// unnamed-primary are equivalent at the engine boundary.
	NotifyStateChange(scope string, paths []string, changedValues map[string]any)
	// DispatchAction fires the closure previously registered via OnAction
	// for the given action name. Used by ModuleInstance.DispatchAction so
	// programmatic action dispatch flows through the same code path as
	// UI-driven dispatch (WebSocket → engine → registered closure).
	// Returns ErrActionNotFound if no handler is registered for the name.
	DispatchAction(name string, payload any) error
}

// ActionContext provides context about the dispatched action
type ActionContext struct {
	Name    string
	Payload any
	Sender  string
}

// GlobalContext provides access to cross-module functionality
type GlobalContext interface {
	GetModule(id string) *ModuleReference
	HasModule(id string) bool
	GetModuleIds() []string
	GetGlobalState() map[string]any
	Emit(event string, payload any)
	On(event string, handler EventHandler) func()
	GetRouter() *HypenRouter
}

// ActionHandlerContext contains all context for an action handler
type ActionHandlerContext struct {
	Action  ActionContext
	State   *ObservableState
	Context GlobalContext

	// device is the invocation-scoped device plane (RFC 001); nil means
	// unavailable. Read it through Device().
	device *device.Device
}

// Device returns the handler's scoped device plane (RFC 001): the
// connection's negotiated capabilities, acting for this module instance's
// current activation and this dispatch's provenance. It is never nil —
// without a device plane every call fails unavailable ("device-disabled")
// and Supports reports false.
func (c ActionHandlerContext) Device() *device.Device {
	if c.device == nil {
		return device.Unavailable("device-disabled")
	}
	return c.device
}

// WithDevice returns a copy of the context carrying d. Hosts (the remote
// server) call it when they invoke a handler; application code does not
// need it.
func (c ActionHandlerContext) WithDevice(d *device.Device) ActionHandlerContext {
	c.device = d
	return c
}

// ActionHandler handles an action
type ActionHandler func(ctx ActionHandlerContext)

// LifecycleHandler handles lifecycle events
type LifecycleHandler func(state *ObservableState, context GlobalContext)

// ErrorContext provides context about errors in module handlers
type ErrorContext struct {
	// The error that occurred
	Error error
	// Current state (for inspection)
	State *ObservableState
	// The action name if error occurred in an action handler
	ActionName string
	// The lifecycle phase if error occurred in a lifecycle handler
	Lifecycle string // "created", "activated", "deactivated", "destroyed", or ""
}

// ErrorHandlerResult controls error propagation
type ErrorHandlerResult struct {
	// If true, error was handled — skip default behavior
	Handled bool
	// If true, re-panic the error
	Rethrow bool
}

// ErrorHandler handles errors that occur in module handlers
type ErrorHandler func(ctx ErrorContext) *ErrorHandlerResult

// DisconnectContext is passed to OnDisconnect handlers when the last
// WebSocket connection for a session drops. The state snapshot is the
// state at the moment of disconnect; mutating it has no effect on the
// suspended session (the suspension stores its own copy).
type DisconnectContext struct {
	State   *ObservableState
	Session SessionInfo
}

// DisconnectHandler is invoked when a session has no more connections
// and is about to be suspended.
type DisconnectHandler func(ctx DisconnectContext)

// ReconnectContext is passed to OnReconnect handlers when a client
// reconnects to a suspended session within the TTL window. The handler
// can call `Restore(savedState)` to push the saved state into the live
// observable state. If the handler does NOT call Restore, the saved
// state is applied automatically (matching Kotlin/Swift semantics).
type ReconnectContext struct {
	Session SessionInfo
	Restore func(map[string]any)
}

// ReconnectHandler is invoked when a client resumes a suspended session.
type ReconnectHandler func(ctx ReconnectContext)

// ExpireContext is passed to OnExpire handlers when a suspended session's
// TTL elapses without a reconnect.
type ExpireContext struct {
	Session SessionInfo
}

// ExpireHandler is invoked when a suspended session expires. The module
// is destroyed immediately after this handler returns.
type ExpireHandler func(ctx ExpireContext)

// ModuleHandlers contains all handlers for a module
type ModuleHandlers struct {
	OnCreated LifecycleHandler
	// OnActivated fires every time the module becomes the active route
	// target — once right after OnCreated on first mount, and again on
	// each re-mount when the ManagedRouter restores a cached instance.
	// Use for data refresh, (re)connecting subscriptions, etc.
	OnActivated LifecycleHandler
	OnAction    map[string]ActionHandler
	// OnDeactivated fires every time the module stops being the active
	// route target — before the module is cached for persistence OR
	// before OnDestroyed if it's being torn down.
	OnDeactivated LifecycleHandler
	OnDestroyed   LifecycleHandler
	OnError       ErrorHandler
	OnDisconnect  DisconnectHandler
	OnReconnect   ReconnectHandler
	OnExpire      ExpireHandler
}

// ModuleDefinition defines a Hypen module
type ModuleDefinition struct {
	Name      string
	Actions   []string
	StateKeys []string
	// Persist controls whether the ManagedRouter keeps this module
	// instance alive across navigations.
	//
	//   nil   → use the default (persist for any module-backed route)
	//   true  → always persist (same as default, explicit)
	//   false → opt out: destroy the instance on navigation away
	Persist      *bool
	Version      int
	InitialState map[string]any
	// Template is the inline Hypen DSL UI template for single-file components.
	// Set via the .UI() method on AppBuilder.
	Template string
	Handlers ModuleHandlers
}

// BoolPtr returns a pointer to the given bool. Convenience helper for
// setting optional-bool fields on ModuleDefinition / ModuleOptions.
func BoolPtr(b bool) *bool { return &b }

// AppBuilder builds module definitions
type AppBuilder struct {
	initialState       map[string]any
	options            ModuleOptions
	createdHandler     LifecycleHandler
	activatedHandler   LifecycleHandler
	deactivatedHandler LifecycleHandler
	actionHandlers     map[string]ActionHandler
	destroyedHandler   LifecycleHandler
	app                *HypenApp
	errorHandler       ErrorHandler
	disconnectHandler  DisconnectHandler
	reconnectHandler   ReconnectHandler
	expireHandler      ExpireHandler
	template           string
}

// ModuleOptions contains optional configuration for modules.
type ModuleOptions struct {
	// Persist the module instance across route navigations.
	//   nil   → use the default (persist for module-backed routes)
	//   true  → explicit opt-in (same as default)
	//   false → explicit opt-out
	// Use BoolPtr(true) / BoolPtr(false) to set, e.g.
	//   &ModuleOptions{Persist: core.BoolPtr(false)}
	Persist *bool
	Version int
	Name    string
}

// NewAppBuilder creates a new AppBuilder with initial state.
// The app parameter is optional; when set, Build() auto-registers named modules.
func NewAppBuilder(initialState map[string]any, options *ModuleOptions, app ...*HypenApp) *AppBuilder {
	opts := ModuleOptions{}
	if options != nil {
		opts = *options
	}

	var appRef *HypenApp
	if len(app) > 0 {
		appRef = app[0]
	}

	return &AppBuilder{
		initialState:   initialState,
		options:        opts,
		actionHandlers: make(map[string]ActionHandler),
		app:            appRef,
	}
}

// OnCreated registers a handler for module creation. Runs once per
// module instance.
func (b *AppBuilder) OnCreated(fn LifecycleHandler) *AppBuilder {
	b.createdHandler = fn
	return b
}

// OnActivated registers a handler that runs every time the module
// becomes the active route target.
//
// Unlike OnCreated, which only runs once per module instance, OnActivated
// runs on every mount — the first one (right after OnCreated) and every
// subsequent re-entry when the ManagedRouter restores a cached instance.
// Use for data refresh, re-connecting subscriptions, or any "screen
// became visible" side effect.
func (b *AppBuilder) OnActivated(fn LifecycleHandler) *AppBuilder {
	b.activatedHandler = fn
	return b
}

// OnDeactivated registers a handler that runs every time the module
// stops being the active route target.
//
// Runs before the module is cached for persistence OR before OnDestroyed
// if the module is being torn down. Use for pausing timers or
// unsubscribing from ephemeral streams.
func (b *AppBuilder) OnDeactivated(fn LifecycleHandler) *AppBuilder {
	b.deactivatedHandler = fn
	return b
}

// OnAction registers a handler for a specific action
func (b *AppBuilder) OnAction(name string, fn ActionHandler) *AppBuilder {
	b.actionHandlers[name] = fn
	return b
}

// OnDestroyed registers a handler for module destruction
func (b *AppBuilder) OnDestroyed(fn LifecycleHandler) *AppBuilder {
	b.destroyedHandler = fn
	return b
}

// OnError registers an error handler for the module.
// Called when any error occurs in action handlers or lifecycle hooks.
func (b *AppBuilder) OnError(fn ErrorHandler) *AppBuilder {
	b.errorHandler = fn
	return b
}

// OnDisconnect registers a handler that fires when the last WebSocket
// connection for a session drops. The session is then suspended for the
// configured TTL.
func (b *AppBuilder) OnDisconnect(fn DisconnectHandler) *AppBuilder {
	b.disconnectHandler = fn
	return b
}

// OnReconnect registers a handler that fires when a client resumes a
// suspended session within the TTL window. The handler can opt to
// restore saved state via the Restore callback on ReconnectContext, or
// leave it to the default (saved state applied automatically).
func (b *AppBuilder) OnReconnect(fn ReconnectHandler) *AppBuilder {
	b.reconnectHandler = fn
	return b
}

// OnExpire registers a handler that fires when a suspended session's
// TTL elapses without a reconnect. The module is destroyed immediately
// after the handler returns.
func (b *AppBuilder) OnExpire(fn ExpireHandler) *AppBuilder {
	b.expireHandler = fn
	return b
}

// UI sets the inline Hypen DSL template and builds the module definition.
// This is the recommended way to create single-file components.
//
// For new code, prefer the typed builder NewApp[T], which wraps this API
// and lets you express state as a Go struct. AppBuilder remains useful
// when the state shape is dynamic or not known at compile time:
//
//	counter := core.NewAppBuilder(map[string]any{"count": 0}, nil).
//	    OnAction("increment", func(ctx core.ActionHandlerContext) { ... }).
//	    UI(`
//	        Column {
//	            Text("Count: ${state.count}")
//	            Button("@actions.increment") { Text("+") }
//	        }
//	    `)
func (b *AppBuilder) UI(template string) *ModuleDefinition {
	b.template = template
	return b.Build()
}

// UIFile reads a .hypen template from the filesystem and builds the module
// definition. For compiled binaries, prefer using go:embed to bake the
// template into the binary at compile time:
//
//	//go:embed counter.hypen
//	var counterTemplate string
//
//	counter := core.NewApp(CounterState{Count: 0}).
//	    OnAction("increment", handler).
//	    UI(counterTemplate)
func (b *AppBuilder) UIFile(path string) (*ModuleDefinition, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	b.template = strings.TrimSpace(string(data))
	return b.Build(), nil
}

// Build creates the module definition.
// If the builder was created via App.DefineState() or App.Module() and the
// module has a Name, the definition is automatically registered in the App registry.
func (b *AppBuilder) Build() *ModuleDefinition {
	actions := make([]string, 0, len(b.actionHandlers))
	for name := range b.actionHandlers {
		actions = append(actions, name)
	}

	stateKeys := make([]string, 0)
	if b.initialState != nil {
		for key := range b.initialState {
			stateKeys = append(stateKeys, key)
		}
	}

	def := &ModuleDefinition{
		Name:         b.options.Name,
		Actions:      actions,
		StateKeys:    stateKeys,
		Persist:      b.options.Persist,
		Version:      b.options.Version,
		InitialState: b.initialState,
		Template:     b.template,
		Handlers: ModuleHandlers{
			OnCreated:     b.createdHandler,
			OnActivated:   b.activatedHandler,
			OnDeactivated: b.deactivatedHandler,
			OnAction:      b.actionHandlers,
			OnDestroyed:   b.destroyedHandler,
			OnError:       b.errorHandler,
			OnDisconnect:  b.disconnectHandler,
			OnReconnect:   b.reconnectHandler,
			OnExpire:      b.expireHandler,
		},
	}

	// Auto-register in the app registry when the module has a name
	if b.options.Name != "" && b.app != nil {
		b.app.Register(b.options.Name, def)
	}

	return def
}

// HypenApp is the main app API — singleton factory and component registry.
//
// Modules built with a Name are automatically registered here.
// Consumers (ManagedRouter, ComponentResolver) read from this registry
// instead of requiring a separate ModuleRegistry instance.
type HypenApp struct {
	mu       sync.RWMutex
	registry map[string]*ModuleDefinition
}

// DefineState creates a new AppBuilder with initial state
func (a *HypenApp) DefineState(initial map[string]any, options *ModuleOptions) *AppBuilder {
	return NewAppBuilder(initial, options, a)
}

// Module returns a builder helper with the name pre-set.
//
//	App.Module("Settings").DefineState(state).Build()
func (a *HypenApp) Module(name string) *AppModuleHelper {
	return &AppModuleHelper{app: a, name: name}
}

// ---------------------------------------------------------------------------
// Registry API
// ---------------------------------------------------------------------------

func (a *HypenApp) ensureRegistry() {
	if a.registry == nil {
		a.registry = make(map[string]*ModuleDefinition)
	}
}

// Register adds a module definition to the registry under the given name.
func (a *HypenApp) Register(name string, def *ModuleDefinition) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.ensureRegistry()
	a.registry[name] = def
}

// Get returns a module definition by component name, or nil if not found.
func (a *HypenApp) Get(name string) *ModuleDefinition {
	a.mu.RLock()
	defer a.mu.RUnlock()
	if a.registry == nil {
		return nil
	}
	return a.registry[name]
}

// Has returns true if a module definition exists for the given name.
func (a *HypenApp) Has(name string) bool {
	a.mu.RLock()
	defer a.mu.RUnlock()
	if a.registry == nil {
		return false
	}
	_, exists := a.registry[name]
	return exists
}

// GetNames returns all registered component names.
func (a *HypenApp) GetNames() []string {
	a.mu.RLock()
	defer a.mu.RUnlock()
	names := make([]string, 0, len(a.registry))
	for name := range a.registry {
		names = append(names, name)
	}
	return names
}

// Size returns the number of registered definitions.
func (a *HypenApp) Size() int {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return len(a.registry)
}

// Unregister removes a module definition.
func (a *HypenApp) Unregister(name string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	delete(a.registry, name)
}

// Clear removes all registered definitions.
func (a *HypenApp) Clear() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.registry = make(map[string]*ModuleDefinition)
}

// AppModuleHelper is a convenience returned by App.Module("name")
type AppModuleHelper struct {
	app  *HypenApp
	name string
}

// DefineState starts building a module definition with the pre-set name.
func (h *AppModuleHelper) DefineState(initial map[string]any, options *ModuleOptions) *AppBuilder {
	opts := &ModuleOptions{Name: h.name}
	if options != nil {
		opts.Persist = options.Persist // *bool, nil is valid
		opts.Version = options.Version
	}
	return NewAppBuilder(initial, opts, h.app)
}

// App is the global app instance
var App = &HypenApp{
	registry: make(map[string]*ModuleDefinition),
}

// ModuleInstance manages a running module with state
type ModuleInstance struct {
	mu         sync.RWMutex
	engine     IEngine
	ownsEngine bool // true when CreateInstance() created the engine
	definition *ModuleDefinition
	state      *ObservableState
	// isActive is true when the module is currently the active route
	// target (i.e. OnActivated has fired more recently than
	// OnDeactivated). Used to make Activate() / Deactivate() idempotent
	// so the ManagedRouter can call them safely regardless of state.
	isActive             bool
	isDestroyed          bool
	routerContext        *RouterContext
	globalContext        GlobalContext
	stateChangeCallbacks []func()

	// Device plane binding (RFC 001). deviceID is this instance's
	// moduleInstanceId on the wire; activation is its current activation
	// id (0 = never active). With deviceManaged the instance drives the
	// plane's owner lifecycle from Activate/Deactivate/Destroy; without it
	// the instance only stamps a fixed owner managed by its host.
	devicePlane   device.Plane
	deviceID      string
	activation    uint32
	deviceManaged bool
}

// deviceInstanceSeq numbers module instances for their device identity.
var deviceInstanceSeq atomic.Uint64

// newDeviceInstanceID returns a process-unique moduleInstanceId for name.
func newDeviceInstanceID(name string) string {
	base := strings.ToLower(name)
	if base == "" {
		base = "module"
	}
	if len(base) > 200 {
		base = base[:200]
	}
	return fmt.Sprintf("%s#%d", base, deviceInstanceSeq.Add(1))
}

// RouterContext provides router information
type RouterContext struct {
	Root    *HypenRouter
	Current *HypenRouter
	Parent  *HypenRouter
}

// InstanceOption configures a module instance created by NewModuleInstance
// or ModuleDefinition.CreateInstance.
type InstanceOption func(*instanceConfig)

type instanceConfig struct {
	engine        IEngine
	routerContext *RouterContext
	globalContext GlobalContext
	nested        bool
	// skipEngineRegister tells newModuleInstance to skip the
	// engine.SetModule / engine.RegisterModule step. Only makes sense
	// when the caller has already registered the module on the engine
	// through another path — e.g. the RemoteSession's auto-wire needs
	// a ModuleInstance handle it can put in the HypenGlobalContext so
	// `context.GetModule("app")` works from routed children, but the
	// primary slot was already filled by an earlier engine.SetModule
	// call at session init. Opt in via AsAlreadyInEngine().
	skipEngineRegister bool

	devicePlane device.Plane
	deviceOwner *device.Owner
}

// WithDevicePlane binds the instance to a connection's device plane
// (RFC 001). The instance gets its own moduleInstanceId, and its lifecycle
// drives activation authority: Activate starts a new activation (the
// previous one's work is swept), Deactivate sweeps the activation's work,
// Destroy sweeps everything. Action handlers see the plane through
// ActionHandlerContext.Device(), scoped to the activation live when the
// handler started. The ManagedRouter passes this for routed modules.
func WithDevicePlane(plane device.Plane) InstanceOption {
	return func(c *instanceConfig) { c.devicePlane = plane }
}

// WithDeviceOwner binds the instance to plane under an owner whose
// lifecycle is managed elsewhere (e.g. the remote session's primary
// module): handlers act for owner, and Activate/Deactivate/Destroy do not
// touch the plane.
func WithDeviceOwner(plane device.Plane, owner device.Owner) InstanceOption {
	return func(c *instanceConfig) {
		c.devicePlane = plane
		o := owner
		c.deviceOwner = &o
	}
}

// WithEngine overrides the default embedded WASM engine. Only meaningful
// when used with CreateInstance (which allocates an engine if none is
// provided); NewModuleInstance takes the engine positionally and ignores
// this option.
func WithEngine(engine IEngine) InstanceOption {
	return func(c *instanceConfig) { c.engine = engine }
}

// WithRouter sets the router context for the instance.
func WithRouter(rc *RouterContext) InstanceOption {
	return func(c *instanceConfig) { c.routerContext = rc }
}

// WithGlobalContext sets the global context for the instance.
func WithGlobalContext(gc GlobalContext) InstanceOption {
	return func(c *instanceConfig) { c.globalContext = gc }
}

// AsNested marks the instance as a nested (child) module that shares its
// parent's engine. Nested instances register with the engine via
// RegisterModule (instead of SetModule), preserving the parent's primary
// slot, and route their state changes via NotifyStateChange with the
// module's name as the scope (instead of the empty-string primary scope).
//
// Default is primary (non-nested).
func AsNested() InstanceOption {
	return func(c *instanceConfig) { c.nested = true }
}

// AsAlreadyInEngine builds a ModuleInstance wrapper without calling
// engine.SetModule or engine.RegisterModule. Use when the primary slot
// (or a named scope) has been set up on the engine through another
// code path — typically a RemoteSession auto-wire that needs a
// handle to hang in HypenGlobalContext for cross-module reads from
// routed children, without clobbering the engine state it already
// configured.
//
// State changes on the returned instance still propagate to the engine
// via NotifyStateChange; the skip applies only to initial registration.
// Compose with AsNested() when wrapping a named scope.
func AsAlreadyInEngine() InstanceOption {
	return func(c *instanceConfig) { c.skipEngineRegister = true }
}

// CreateInstance creates a module instance using the embedded WASM engine.
// No engine setup needed — just call counter.CreateInstance().
//
//	instance, err := counter.CreateInstance()
//	instance, err := counter.CreateInstance(core.WithRouter(rc), core.WithGlobalContext(gc))
//
// To create a nested instance against a pre-existing engine, use
// NewModuleInstance(engine, def, core.AsNested(), …) instead.
func (d *ModuleDefinition) CreateInstance(opts ...InstanceOption) (*ModuleInstance, error) {
	cfg := &instanceConfig{}
	for _, opt := range opts {
		opt(cfg)
	}
	ownsEngine := false
	if cfg.engine == nil {
		engine, err := NewDefaultEngine()
		if err != nil {
			return nil, fmt.Errorf("failed to create engine: %w", err)
		}
		cfg.engine = engine
		ownsEngine = true
	}
	inst := newModuleInstance(cfg.engine, d, cfg)
	inst.ownsEngine = ownsEngine
	return inst, nil
}

// NewModuleInstance creates a module instance with an explicit engine.
//
// By default the instance occupies the engine's primary slot (via
// engine.SetModule). Pass core.AsNested() to make it a child of an existing
// primary module — the engine then registers it under its own name in the
// named-modules map without disturbing the primary slot.
//
//	primary := core.NewModuleInstance(engine, appDef)
//	nested  := core.NewModuleInstance(engine, feedDef, core.AsNested())
//	withCtx := core.NewModuleInstance(engine, def,
//	    core.WithRouter(rc),
//	    core.WithGlobalContext(gc),
//	)
//
// For single-module apps that don't need an explicit engine, prefer
// ModuleDefinition.CreateInstance().
func NewModuleInstance(engine IEngine, definition *ModuleDefinition, opts ...InstanceOption) *ModuleInstance {
	cfg := &instanceConfig{}
	for _, opt := range opts {
		opt(cfg)
	}
	return newModuleInstance(engine, definition, cfg)
}

// newModuleInstance is the shared body for primary and nested instances.
// The two paths differ in only three places — engine registration call,
// state-change notification call, and the empty-name fallback for primary —
// all branched on cfg.nested.
func newModuleInstance(
	engine IEngine,
	definition *ModuleDefinition,
	cfg *instanceConfig,
) *ModuleInstance {
	m := &ModuleInstance{
		engine:        engine,
		definition:    definition,
		routerContext: cfg.routerContext,
		globalContext: cfg.globalContext,
		devicePlane:   cfg.devicePlane,
	}
	if cfg.deviceOwner != nil {
		m.deviceID = cfg.deviceOwner.ModuleInstanceID
		m.activation = cfg.deviceOwner.ActivationID
	} else {
		m.deviceID = newDeviceInstanceID(definition.Name)
		m.deviceManaged = cfg.devicePlane != nil
	}

	// State change notification routes via the primary or named-scope path
	// depending on whether this is a nested instance. Observable state always
	// produces raw paths (e.g. "count", "items.0.title"). For primary
	// instances the notify scope is empty — the WASI engine's
	// active_action_scope routes them to the correct module during dispatch,
	// or to the primary slot otherwise. For nested instances we pass the
	// module name explicitly so the engine targets the named-modules map.
	// This mirrors Kotlin's `engineScope: String` pattern in
	// BaseModuleInstance.kt.
	nested := cfg.nested
	notifyScope := ""
	if nested {
		notifyScope = definition.Name
	}
	m.state = NewObservableState(definition.InitialState, &StateObserverOptions{
		OnChange: func(change StateChange) {
			engine.NotifyStateChange(notifyScope, change.Paths, change.NewValues)
			m.mu.RLock()
			callbacks := m.stateChangeCallbacks
			m.mu.RUnlock()
			for _, cb := range callbacks {
				cb()
			}
		},
	})

	// Register with the engine. SetModule installs into the primary slot;
	// RegisterModule inserts into the named-modules map without touching
	// the primary slot. Empty-name fallback only applies to primary —
	// a nested instance with an empty name is a programming error that
	// will surface as a missing-scope routing failure.
	name := definition.Name
	if !cfg.skipEngineRegister {
		if nested {
			engine.RegisterModule(name, definition.Actions, definition.StateKeys, m.state.Snapshot())
		} else {
			if name == "" {
				// Backwards-compat fallback. See ENGINE_CONTRACT.md §15 for the
				// open question about whether this should panic instead.
				name = "AnonymousModule"
			}
			engine.SetModule(name, definition.Actions, definition.StateKeys, m.state.Snapshot())
		}
	}

	// Register action handlers (shared between primary and nested).
	for actionName, handler := range definition.Handlers.OnAction {
		actionName := actionName // Capture for closure
		handler := handler       // Capture for closure
		logModule.Debug("Registering action handler: %s for module %s (nested=%v)", actionName, definition.Name, nested)

		engine.OnAction("__hypen_scoped:"+strings.ToLower(notifyScope)+":"+actionName, func(action Action) {
			logModule.Debug("Action handler fired: %s %+v", actionName, action)

			actionCtx := ActionContext{
				Name:    actionName,
				Payload: action.Payload,
				Sender:  action.Sender,
			}

			// The Device is scoped to this invocation: results it receives
			// keep their retained-bytes charge until the handler returns.
			dev, endScope := m.Device().Scoped()
			ctx := ActionHandlerContext{
				Action:  actionCtx,
				State:   m.state,
				Context: m.globalContext,
				device:  dev,
			}

			func() {
				defer endScope()
				defer func() {
					if r := recover(); r != nil {
						err, ok := r.(error)
						if !ok {
							err = &EngineError{Code: ErrRender, Message: fmt.Sprintf("%v", r)}
						}
						if m.handleError(err, actionName, "") {
							panic(r)
						}
					}
				}()
				handler(ctx)
				logModule.Debug("Action handler completed: %s", actionName)
			}()
		})
	}

	// Auto-register __hypen_bind for .bind() two-way binding support.
	engine.OnAction("__hypen_scoped:"+strings.ToLower(notifyScope)+":"+"__hypen_bind", func(action Action) {
		payload, ok := action.Payload.(map[string]interface{})
		if !ok {
			return
		}
		path, ok := payload["path"].(string)
		if !ok || path == "" {
			return
		}
		value := payload["value"]
		m.state.Set(path, value)
	})

	// Auto-register the drag-and-drop outcome actions (.sortable / .pinboard
	// drops). Like __hypen_bind they write through the tracked state so the
	// change notification reaches the engine; see dnd.go.
	engine.OnAction("__hypen_scoped:"+strings.ToLower(notifyScope)+":"+ReorderActionName, func(action Action) {
		ApplyReorderAction(m.state, action.Payload)
	})
	engine.OnAction("__hypen_scoped:"+strings.ToLower(notifyScope)+":"+PinActionName, func(action Action) {
		ApplyPinAction(m.state, action.Payload)
	})

	// Call onCreated lifecycle hook.
	m.callCreatedHandler()

	return m
}

// CreateNestedModuleInstances iterates all registered modules in the app
// registry and creates ModuleInstance for each one that has state or actions
// (i.e., is a stateful module). This is the Go equivalent of the TypeScript
// SDK's Hypen.createNestedModuleInstances().
//
// Modules that are already registered in the GlobalContext are skipped.
// Each created instance is registered in the GlobalContext under its
// lowercase name.
//
// Returns the map of created module instances (name → instance).
func CreateNestedModuleInstances(
	engine IEngine,
	app *HypenApp,
	globalContext *HypenGlobalContext,
	routerContext *RouterContext,
) map[string]*ModuleInstance {
	instances := make(map[string]*ModuleInstance)

	if app == nil || globalContext == nil {
		return instances
	}

	for _, name := range app.GetNames() {
		moduleId := strings.ToLower(name)

		// Skip if already instantiated
		if globalContext.HasModule(moduleId) {
			continue
		}

		def := app.Get(name)
		if def == nil {
			continue
		}

		// Skip stateless modules (no state and no actions)
		if len(def.InitialState) == 0 && len(def.Actions) == 0 && len(def.Handlers.OnAction) == 0 {
			continue
		}

		// Ensure definition has a name for state namespacing
		if def.Name == "" {
			defCopy := *def
			defCopy.Name = name
			def = &defCopy
		}

		instance := NewModuleInstance(
			engine,
			def,
			AsNested(),
			WithRouter(routerContext),
			WithGlobalContext(globalContext),
		)
		globalContext.RegisterModule(moduleId, instance)
		instances[name] = instance
	}

	return instances
}

// handleError routes an error through the module's onError handler.
// Returns true if the error should be re-panicked.
func (m *ModuleInstance) handleError(err error, actionName string, lifecycle string) bool {
	ctx := ErrorContext{
		Error:      err,
		State:      m.state,
		ActionName: actionName,
		Lifecycle:  lifecycle,
	}

	// Call module-level error handler if defined
	if m.definition.Handlers.OnError != nil {
		// Protect against panics in the error handler itself
		var result *ErrorHandlerResult
		func() {
			defer func() {
				if r := recover(); r != nil {
					logModule.Error("Error in onError handler: %v", r)
				}
			}()
			result = m.definition.Handlers.OnError(ctx)
		}()

		if result != nil {
			if result.Handled {
				return false
			}
			if result.Rethrow {
				return true
			}
		}
	}

	// Default behavior: emit error event and log
	if m.globalContext != nil {
		context := "unknown"
		if actionName != "" {
			context = "action:" + actionName
		} else if lifecycle != "" {
			context = "lifecycle:" + lifecycle
		}
		m.globalContext.Emit(EventError, ErrorEvent{
			Message: err.Error(),
			Error:   err,
			Context: context,
		})
	}

	if actionName != "" {
		logModule.Error("Action %q error: %v", actionName, err)
	} else if lifecycle != "" {
		logModule.Error("Lifecycle %q error: %v", lifecycle, err)
	}

	return false
}

func (m *ModuleInstance) callCreatedHandler() {
	if m.definition.Handlers.OnCreated != nil {
		func() {
			defer func() {
				if r := recover(); r != nil {
					err, ok := r.(error)
					if !ok {
						err = &EngineError{Code: ErrRender, Message: fmt.Sprintf("%v", r)}
					}
					if m.handleError(err, "", "created") {
						panic(r)
					}
				}
			}()
			m.definition.Handlers.OnCreated(m.state, m.globalContext)
		}()
	}
}

// OnStateChange registers a callback to be notified when state changes
func (m *ModuleInstance) OnStateChange(callback func()) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.stateChangeCallbacks = append(m.stateChangeCallbacks, callback)
}

// Activate marks the module as the active route target and fires
// OnActivated.
//
// Idempotent: calling Activate on an already-active module is a no-op.
// Called by ManagedRouter on every route mount — both fresh constructions
// and re-mounts from the persistence cache.
func (m *ModuleInstance) Activate() {
	m.mu.Lock()
	if m.isDestroyed || m.isActive {
		m.mu.Unlock()
		return
	}
	m.isActive = true
	var plane device.Plane
	var activation uint32
	if m.deviceManaged {
		m.activation++
		plane, activation = m.devicePlane, m.activation
	}
	m.mu.Unlock()

	// Authority first: the new activation is live before OnActivated runs.
	if plane != nil {
		plane.OwnerActivated(m.deviceID, activation)
	}

	if m.definition.Handlers.OnActivated != nil {
		func() {
			defer func() {
				if r := recover(); r != nil {
					err, ok := r.(error)
					if !ok {
						err = &EngineError{Code: ErrRender, Message: fmt.Sprintf("%v", r)}
					}
					if m.handleError(err, "", "activated") {
						panic(r)
					}
				}
			}()
			m.definition.Handlers.OnActivated(m.state, m.globalContext)
		}()
	}
}

// Deactivate marks the module as no longer the active route target and
// fires OnDeactivated.
//
// Idempotent: calling Deactivate on an inactive module is a no-op.
// Called by ManagedRouter before persisting a module for later reuse OR
// before destroying it.
func (m *ModuleInstance) Deactivate() {
	m.mu.Lock()
	if m.isDestroyed || !m.isActive {
		m.mu.Unlock()
		return
	}
	m.isActive = false
	var plane device.Plane
	activation := m.activation
	if m.deviceManaged {
		plane = m.devicePlane
	}
	m.mu.Unlock()

	// The activation's device work is swept as it leaves the active slot.
	if plane != nil {
		plane.OwnerDeactivated(m.deviceID, activation)
	}

	if m.definition.Handlers.OnDeactivated != nil {
		func() {
			defer func() {
				if r := recover(); r != nil {
					err, ok := r.(error)
					if !ok {
						err = &EngineError{Code: ErrRender, Message: fmt.Sprintf("%v", r)}
					}
					if m.handleError(err, "", "deactivated") {
						panic(r)
					}
				}
			}()
			m.definition.Handlers.OnDeactivated(m.state, m.globalContext)
		}()
	}
}

// Device returns the instance's device plane scoped to its current
// activation and to the dispatch running now (RFC 001). Handlers get the
// same value through ActionHandlerContext.Device(); lifecycle code (e.g.
// an OnActivated that starts background work) may call it on the
// instance. Never nil: without a plane every call fails unavailable.
func (m *ModuleInstance) Device() *device.Device {
	m.mu.RLock()
	plane, owner := m.devicePlane, device.Owner{ModuleInstanceID: m.deviceID, ActivationID: m.activation}
	m.mu.RUnlock()
	return device.Bind(plane, owner)
}

// BindDevicePlane binds an instance that was constructed without a device
// plane to plane, as WithDevicePlane would have at construction: from now
// on its lifecycle drives the plane's activation authority. An instance
// that is active right now starts a new activation at once (its handlers
// running from then on act for it); an inactive one starts its first on
// the next Activate. Returns false — and changes nothing — when the
// instance already has a plane, is destroyed, or plane is nil.
//
// Used when a connection's device plane appears after the instance was
// built (ManagedRouter.SetDevicePlane on a router already running).
func (m *ModuleInstance) BindDevicePlane(plane device.Plane) bool {
	if plane == nil {
		return false
	}
	m.mu.Lock()
	if m.isDestroyed || m.devicePlane != nil {
		m.mu.Unlock()
		return false
	}
	m.devicePlane = plane
	m.deviceManaged = true
	var activation uint32
	if m.isActive {
		m.activation++
		activation = m.activation
	}
	m.mu.Unlock()
	if activation != 0 {
		plane.OwnerActivated(m.deviceID, activation)
	}
	return true
}

// BindDeviceOwner binds an instance that was constructed without a device
// plane to plane under owner, as WithDeviceOwner would have at
// construction: handlers act for owner and the instance's lifecycle does
// not touch the plane (owner's activation is managed by the caller).
// Returns false — and changes nothing — when the instance already has a
// plane, is destroyed, or plane is nil.
func (m *ModuleInstance) BindDeviceOwner(plane device.Plane, owner device.Owner) bool {
	if plane == nil {
		return false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.isDestroyed || m.devicePlane != nil {
		return false
	}
	m.devicePlane = plane
	m.deviceID = owner.ModuleInstanceID
	m.activation = owner.ActivationID
	m.deviceManaged = false
	return true
}

// DeviceOwner is the instance's device identity: its moduleInstanceId and
// current activation id (0 before the first activation).
func (m *ModuleInstance) DeviceOwner() device.Owner {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return device.Owner{ModuleInstanceID: m.deviceID, ActivationID: m.activation}
}

// IsActive reports whether the module is currently the active route target.
func (m *ModuleInstance) IsActive() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.isActive
}

// Destroy destroys the module instance
func (m *ModuleInstance) Destroy() {
	// If this module is still marked as active (Destroy called without a
	// preceding Deactivate), fire OnDeactivated first so the lifecycle
	// order is always: ...OnActivated → OnDeactivated → OnDestroyed.
	m.mu.RLock()
	stillActive := !m.isDestroyed && m.isActive
	m.mu.RUnlock()
	if stillActive {
		m.Deactivate()
	}

	m.mu.Lock()
	if m.isDestroyed {
		m.mu.Unlock()
		return
	}
	m.isDestroyed = true
	var plane device.Plane
	if m.deviceManaged {
		plane = m.devicePlane
	}
	m.mu.Unlock()

	if plane != nil {
		plane.OwnerDestroyed(m.deviceID)
	}

	if m.definition.Handlers.OnDestroyed != nil {
		func() {
			defer func() {
				if r := recover(); r != nil {
					err, ok := r.(error)
					if !ok {
						err = &EngineError{Code: ErrRender, Message: fmt.Sprintf("%v", r)}
					}
					if m.handleError(err, "", "destroyed") {
						panic(r)
					}
				}
			}()
			m.definition.Handlers.OnDestroyed(m.state, m.globalContext)
		}()
	}

	// Close engine if we created it (via CreateInstance)
	if m.ownsEngine {
		if closer, ok := m.engine.(interface{ Close() error }); ok {
			closer.Close()
		}
	}
}

// HandleDisconnect fires the module's OnDisconnect handler if registered.
// Called by RemoteServer when the last connection for a session drops
// and the session is about to be suspended.
func (m *ModuleInstance) HandleDisconnect(session SessionInfo) {
	m.mu.Lock()
	if m.isDestroyed {
		m.mu.Unlock()
		return
	}
	m.mu.Unlock()

	handler := m.definition.Handlers.OnDisconnect
	if handler == nil {
		return
	}
	func() {
		defer func() {
			if r := recover(); r != nil {
				err, ok := r.(error)
				if !ok {
					err = &EngineError{Code: ErrRender, Message: fmt.Sprintf("%v", r)}
				}
				if m.handleError(err, "", "disconnect") {
					panic(r)
				}
			}
		}()
		handler(DisconnectContext{State: m.state, Session: session})
	}()
}

// HandleReconnect fires the module's OnReconnect handler (if registered)
// or applies the saved state directly when no handler is provided.
//
// The OnReconnect handler is given a Restore callback it can call with
// the state it wants to push into the live ObservableState — this allows
// the handler to opt out of restoration (e.g. if the saved state is now
// stale because the user has been gone for a long time). If the handler
// does not call Restore, the saved state is applied automatically.
func (m *ModuleInstance) HandleReconnect(session SessionInfo, savedState map[string]any) {
	m.mu.Lock()
	if m.isDestroyed {
		m.mu.Unlock()
		return
	}
	m.mu.Unlock()

	handler := m.definition.Handlers.OnReconnect
	if handler == nil {
		// No handler — apply the saved state directly.
		m.state.SetAll(savedState)
		return
	}

	didRestore := false
	restore := func(restoredState map[string]any) {
		didRestore = true
		m.state.SetAll(restoredState)
	}
	func() {
		defer func() {
			if r := recover(); r != nil {
				err, ok := r.(error)
				if !ok {
					err = &EngineError{Code: ErrRender, Message: fmt.Sprintf("%v", r)}
				}
				if m.handleError(err, "", "reconnect") {
					panic(r)
				}
			}
		}()
		handler(ReconnectContext{Session: session, Restore: restore})
	}()

	if !didRestore {
		m.state.SetAll(savedState)
	}
}

// HandleExpire fires the module's OnExpire handler if registered.
// Called by RemoteServer when a suspended session's TTL elapses without
// a reconnect. The module is destroyed by the caller immediately after.
func (m *ModuleInstance) HandleExpire(session SessionInfo) {
	handler := m.definition.Handlers.OnExpire
	if handler == nil {
		return
	}
	func() {
		defer func() {
			if r := recover(); r != nil {
				err, ok := r.(error)
				if !ok {
					err = &EngineError{Code: ErrRender, Message: fmt.Sprintf("%v", r)}
				}
				if m.handleError(err, "", "expire") {
					panic(r)
				}
			}
		}()
		handler(ExpireContext{Session: session})
	}()
}

// GetState returns a snapshot of the current state
func (m *ModuleInstance) GetState() map[string]any {
	return m.state.Snapshot()
}

// GetLiveState returns the live observable state
func (m *ModuleInstance) GetLiveState() *ObservableState {
	return m.state
}

// UpdateState merges a patch with the current state
func (m *ModuleInstance) UpdateState(patch map[string]any) {
	for key, value := range patch {
		m.state.Set(key, value)
	}
}

// GetDefinition returns the module definition
func (m *ModuleInstance) GetDefinition() *ModuleDefinition {
	return m.definition
}

// DispatchAction dispatches an action to this module's handlers by
// routing through the engine's action dispatcher (IEngine.DispatchAction).
// The engine fires the closure registered via IEngine.OnAction during
// newModuleInstance, which runs the user's typed handler against this
// module's state. Programmatic dispatch and UI-driven dispatch
// (WebSocket → remote server → engine.DispatchAction) thus share the
// same code path end-to-end.
//
// Errors from the engine (e.g. ErrActionNotFound) are logged and
// swallowed, matching the pre-refactor behavior where an unknown
// action name was silently ignored.
func (m *ModuleInstance) DispatchAction(name string, payload any) {
	m.mu.RLock()
	if m.isDestroyed {
		m.mu.RUnlock()
		return
	}
	m.mu.RUnlock()

	if err := m.engine.DispatchAction(name, payload); err != nil {
		logModule.Debug("DispatchAction %q failed: %v", name, err)
	}
}
