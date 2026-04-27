package core

import (
	"strings"
	"sync"
)

// RouteDefinition maps a route path to a component and optional module.
type RouteDefinition struct {
	// Route path pattern (e.g., "/", "/profile/:id")
	Path string
	// Component name — used to look up in app registry
	Component string
	// Inline module definition (alternative to registry lookup)
	Module *ModuleDefinition
}

// ManagedRouter orchestrates module mount/unmount on route changes.
//
// When the router navigates to a route:
//  1. Deactivates and unmounts the previous module (either persisting it
//     for later reuse or destroying it).
//  2. Mounts the new module (creating it fresh or restoring from the
//     persistence cache) and activates it.
//
// Module names are used as state prefixes (lowercased) for isolation.
//
// # Persistence (default: on for module-backed routes)
//
// By default, any route whose Component resolves to a registered module
// definition (or provides one inline via Route.Module) has its module
// instance persisted across navigations. This preserves module state so
// navigating away and back doesn't re-trigger the initial "loading"
// state that usually lives in OnCreated. Opt out by setting Persist to
// BoolPtr(false) on ModuleOptions.
//
// # Lifecycle on navigation
//
//	First visit:      construct → OnCreated → OnActivated
//	Navigate away:    OnDeactivated (then persist OR OnDestroyed)
//	Revisit (cached): OnActivated (OnCreated does not re-run)
type ManagedRouter struct {
	mu            sync.Mutex
	router        *HypenRouter
	engine        IEngine
	registry      *HypenApp
	globalContext *HypenGlobalContext
	routes        []RouteDefinition
	activeModule  *ModuleInstance
	activeRoute   *RouteDefinition
	unsubscribe   func()
	// Cached instances for module-backed routes, keyed by the
	// lowercase module id. Populated on unmount (when persistence
	// applies) and consulted on mount to restore state.
	persistedModules map[string]*ModuleInstance
}

// NewManagedRouter creates a new ManagedRouter.
func NewManagedRouter(
	router *HypenRouter,
	engine IEngine,
	registry *HypenApp,
	globalContext *HypenGlobalContext,
) *ManagedRouter {
	return &ManagedRouter{
		router:           router,
		engine:           engine,
		registry:         registry,
		globalContext:    globalContext,
		routes:           make([]RouteDefinition, 0),
		persistedModules: make(map[string]*ModuleInstance),
	}
}

// AddRoute adds a route definition.
func (m *ManagedRouter) AddRoute(route RouteDefinition) *ManagedRouter {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.routes = append(m.routes, route)
	return m
}

// Start begins listening for route changes and mounts the initial route.
//
// Also installs the reserved `@router.*` engine action handlers so DSL
// authors can write `.onClick(@router.push, to: "/x")` /
// `@router.back` / `@router.replace` / `@router.forward` and have them
// dispatched against this session's HypenRouter without any per-example
// wiring. The namespace is reserved in hypen-engine's ir/expand.rs.
func (m *ManagedRouter) Start() {
	m.unsubscribe = m.router.OnNavigate(func(route RouteState) {
		m.handleRouteChange(route.CurrentPath)
	})

	m.installRouterActions()

	// Mount initial route
	m.handleRouteChange(m.router.GetCurrentPath())
}

// installRouterActions registers the `router.*` engine handlers. Each
// handler runs its HypenRouter mutation on a fresh goroutine so the
// write lands after the engine finishes dispatching — the TS SDK needs
// `queueMicrotask` for the same reason; Go's analogue is a `go func`
// that yields back to the scheduler.
func (m *ManagedRouter) installRouterActions() {
	router := m.router
	readTo := func(action Action) string {
		payload, ok := action.Payload.(map[string]any)
		if !ok {
			return ""
		}
		to, _ := payload["to"].(string)
		return to
	}

	m.engine.OnAction("router.push", func(action Action) {
		to := readTo(action)
		if to != "" {
			go router.Push(to)
		}
	})
	m.engine.OnAction("router.replace", func(action Action) {
		to := readTo(action)
		if to != "" {
			go router.Replace(to)
		}
	})
	m.engine.OnAction("router.back", func(_ Action) {
		go router.Back()
	})
	m.engine.OnAction("router.forward", func(_ Action) {
		go router.Forward()
	})
}

// Stop stops listening and unmounts the active module.
// Also destroys all persisted modules.
func (m *ManagedRouter) Stop() {
	if m.unsubscribe != nil {
		m.unsubscribe()
		m.unsubscribe = nil
	}
	m.unmountActive()

	// Destroy all persisted modules on full stop. Instances in this
	// map are inactive (they were deactivated when persisted), so
	// Destroy just fires OnDestroyed.
	m.mu.Lock()
	persisted := m.persistedModules
	m.persistedModules = make(map[string]*ModuleInstance)
	m.mu.Unlock()
	for moduleId, instance := range persisted {
		instance.Destroy()
		m.globalContext.UnregisterModule(moduleId)
	}
}

// GetActiveModule returns the currently active module instance.
func (m *ManagedRouter) GetActiveModule() *ModuleInstance {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.activeModule
}

// GetActiveRoute returns the currently active route.
func (m *ManagedRouter) GetActiveRoute() *RouteDefinition {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.activeRoute
}

func (m *ManagedRouter) handleRouteChange(path string) {
	m.mu.Lock()

	matched := m.matchRoute(path)
	if matched == nil {
		// Unmount under lock, then drop it before firing lifecycle
		// callbacks to avoid holding the router lock during user code.
		toDeactivate, toDestroy, destroyID := m.prepareUnmountLocked()
		m.activeModule = nil
		m.activeRoute = nil
		m.mu.Unlock()
		m.finishUnmount(toDeactivate, toDestroy, destroyID)
		return
	}

	// If same route, no need to remount.
	if m.activeRoute != nil && m.activeRoute.Path == matched.Path {
		m.mu.Unlock()
		return
	}

	// Prepare unmount info under lock.
	toDeactivate, toDestroy, destroyID := m.prepareUnmountLocked()
	m.activeModule = nil
	m.activeRoute = nil

	// Prepare mount info under lock.
	def := matched.Module
	if def == nil {
		def = m.registry.Get(matched.Component)
	}

	if def == nil {
		// No module to mount — just set the active route.
		m.activeRoute = matched
		m.mu.Unlock()
		m.finishUnmount(toDeactivate, toDestroy, destroyID)
		return
	}

	// Ensure the definition has a name for state namespacing.
	if def.Name == "" {
		defCopy := *def
		defCopy.Name = strings.ToLower(matched.Component)
		def = &defCopy
	}
	moduleId := strings.ToLower(def.Name)

	// Remove from cache while active so a concurrent navigation cannot
	// double-mount the same instance.
	var restored *ModuleInstance
	if cached, ok := m.persistedModules[moduleId]; ok {
		restored = cached
		delete(m.persistedModules, moduleId)
	}

	if restored != nil {
		m.activeModule = restored
		m.activeRoute = matched
		m.mu.Unlock()

		// Fire lifecycle callbacks outside the lock.
		m.finishUnmount(toDeactivate, toDestroy, destroyID)
		restored.Activate()
		return
	}

	m.mu.Unlock()

	// Fire unmount lifecycle BEFORE constructing the new instance so
	// OnDeactivated → OnDestroyed of the previous module runs before
	// OnCreated of the next one.
	m.finishUnmount(toDeactivate, toDestroy, destroyID)

	// Construct fresh. OnCreated fires in NewModuleInstance, then we
	// fire OnActivated right after. AsNested() keeps the primary slot
	// (App) intact — omitting it clobbers the initial tree's bindings.
	instance := NewModuleInstance(
		m.engine,
		def,
		AsNested(),
		WithRouter(&RouterContext{Root: m.router}),
		WithGlobalContext(m.globalContext),
	)
	m.globalContext.RegisterModule(moduleId, instance)

	m.mu.Lock()
	m.activeModule = instance
	m.activeRoute = matched
	m.mu.Unlock()

	instance.Activate()
}

func (m *ManagedRouter) matchRoute(path string) *RouteDefinition {
	for i := range m.routes {
		route := &m.routes[i]
		if m.router.MatchPath(route.Path, path) != nil {
			return route
		}
	}
	return nil
}

// prepareUnmountLocked inspects the currently-active module/route and
// returns the work that needs to happen to unmount it. Work is returned
// as two optional *ModuleInstance references — one that always needs
// Deactivate(), one that also needs Destroy() — plus the module id that
// should be unregistered from the GlobalContext on destroy. The caller
// drops the lock before invoking finishUnmount to keep user-land
// callbacks off the router's hot path.
//
// Persistence semantics (matches TypeScript / Kotlin / Swift):
//
//	def present & Persist != &false  →  cache the instance
//	def present & Persist == &false  →  destroy the instance
//	def missing                      →  nothing to persist
func (m *ManagedRouter) prepareUnmountLocked() (
	toDeactivate *ModuleInstance,
	toDestroy *ModuleInstance,
	destroyID string,
) {
	if m.activeModule == nil || m.activeRoute == nil {
		return nil, nil, ""
	}

	def := m.activeRoute.Module
	if def == nil {
		def = m.registry.Get(m.activeRoute.Component)
	}

	moduleId := strings.ToLower(m.activeRoute.Component)
	if def != nil && def.Name != "" {
		moduleId = strings.ToLower(def.Name)
	}

	// Persistence default: module-backed routes persist unless the
	// definition explicitly opts out via Persist = BoolPtr(false).
	persist := def != nil && !(def.Persist != nil && !*def.Persist)

	toDeactivate = m.activeModule
	if persist {
		// Cache the instance. Keep it registered in GlobalContext so
		// other modules can still read its state while it's off-screen.
		m.persistedModules[moduleId] = m.activeModule
	} else {
		toDestroy = m.activeModule
		destroyID = moduleId
	}
	return
}

// finishUnmount runs the deactivate/destroy side-effects prepared by
// prepareUnmountLocked. Must be called WITHOUT the router's lock held.
func (m *ManagedRouter) finishUnmount(
	toDeactivate *ModuleInstance,
	toDestroy *ModuleInstance,
	destroyID string,
) {
	if toDeactivate == nil {
		return
	}
	// Always deactivate first — regardless of whether we persist or
	// destroy — so OnDeactivated → (OnDestroyed) ordering holds.
	toDeactivate.Deactivate()

	if toDestroy != nil {
		toDestroy.Destroy()
		if destroyID != "" {
			m.globalContext.UnregisterModule(destroyID)
		}
	}
}

func (m *ManagedRouter) unmountActive() {
	m.mu.Lock()
	toDeactivate, toDestroy, destroyID := m.prepareUnmountLocked()
	m.activeModule = nil
	m.activeRoute = nil
	m.mu.Unlock()
	m.finishUnmount(toDeactivate, toDestroy, destroyID)
}
