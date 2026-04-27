package core

import (
	"sync"
	"testing"
)

// helper to reset App between tests
func resetApp() {
	App.Clear()
}

// ========================================================================
// A. Named State Paths Tests
// ========================================================================

func TestNamedModule_InitialStateIsRaw(t *testing.T) {
	engine := NewMockEngine()
	def := NewAppBuilder(map[string]any{"count": 0}, &ModuleOptions{Name: "HomePage"}).Build()

	NewModuleInstance(engine, def)

	// State is passed through as-is — no host-side namespacing.
	if engine.InitialState["count"] != float64(0) && engine.InitialState["count"] != 0 {
		t.Errorf("expected count=0 at top level, got %v", engine.InitialState)
	}
	if _, ok := engine.InitialState["homepage"]; ok {
		t.Errorf("state should not be nested under module name, got %v", engine.InitialState)
	}
}

func TestAnonymousModule_NoPrefixState(t *testing.T) {
	engine := NewMockEngine()
	def := NewAppBuilder(map[string]any{"count": 0}, nil).Build()

	NewModuleInstance(engine, def)

	// Direct access
	if engine.InitialState["count"] == nil {
		t.Error("expected direct count key in initial state")
	}
}

func TestNamedModule_StateChangesAreRaw(t *testing.T) {
	engine := NewMockEngine()
	def := NewAppBuilder(map[string]any{"count": 0}, &ModuleOptions{Name: "Counter"}).Build()

	instance := NewModuleInstance(engine, def)

	// Mutate state
	instance.GetLiveState().Set("count", 42)

	// Primary-module mutations flow through NotifyStateChange with an empty
	// scope and raw paths. The engine routes via active_action_scope or to
	// the primary module.
	changes := engine.GetStateChanges()
	if len(changes) == 0 {
		t.Fatal("expected state changes")
	}

	lastChange := changes[len(changes)-1]
	if lastChange.Scope != "" {
		t.Errorf("expected empty scope for primary module, got %q", lastChange.Scope)
	}
	found := false
	for _, path := range lastChange.Paths {
		if path == "count" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected raw path 'count', got %v", lastChange.Paths)
	}
}

func TestEmptyNameModule_NoPrefixState(t *testing.T) {
	engine := NewMockEngine()
	def := NewAppBuilder(map[string]any{"x": 1}, &ModuleOptions{Name: ""}).Build()

	NewModuleInstance(engine, def)

	// Empty name = no nesting
	if engine.InitialState["x"] == nil {
		t.Error("expected direct x key")
	}
}

// ========================================================================
// B. App Registry — auto-registration via Build()
// ========================================================================

func TestAppRegistry_AutoRegistersOnBuild(t *testing.T) {
	resetApp()
	def := App.DefineState(map[string]any{"count": 0}, &ModuleOptions{Name: "Counter"}).Build()

	if !App.Has("Counter") {
		t.Error("expected Counter to be auto-registered")
	}
	if App.Get("Counter") != def {
		t.Error("expected same definition back")
	}
}

func TestAppRegistry_AnonymousDoesNotRegister(t *testing.T) {
	resetApp()
	App.DefineState(map[string]any{"count": 0}, nil).Build()

	if App.Size() != 0 {
		t.Error("expected no registrations for anonymous module")
	}
}

func TestAppRegistry_GetReturnsNilForMissing(t *testing.T) {
	resetApp()
	if App.Get("Missing") != nil {
		t.Error("expected nil for missing definition")
	}
}

func TestAppRegistry_Has(t *testing.T) {
	resetApp()
	App.DefineState(nil, &ModuleOptions{Name: "A"}).Build()

	if !App.Has("A") {
		t.Error("expected Has('A') = true")
	}
	if App.Has("B") {
		t.Error("expected Has('B') = false")
	}
}

func TestAppRegistry_Unregister(t *testing.T) {
	resetApp()
	App.DefineState(nil, &ModuleOptions{Name: "Widget"}).Build()
	App.Unregister("Widget")

	if App.Has("Widget") {
		t.Error("expected Widget to be unregistered")
	}
}

func TestAppRegistry_Size(t *testing.T) {
	resetApp()
	if App.Size() != 0 {
		t.Error("expected size 0")
	}

	App.DefineState(nil, &ModuleOptions{Name: "A"}).Build()
	App.DefineState(nil, &ModuleOptions{Name: "B"}).Build()

	if App.Size() != 2 {
		t.Errorf("expected size 2, got %d", App.Size())
	}
}

func TestAppRegistry_GetNames(t *testing.T) {
	resetApp()
	App.DefineState(nil, &ModuleOptions{Name: "Foo"}).Build()
	App.DefineState(nil, &ModuleOptions{Name: "Bar"}).Build()

	names := App.GetNames()
	if len(names) != 2 {
		t.Errorf("expected 2 names, got %d", len(names))
	}

	nameSet := make(map[string]bool)
	for _, n := range names {
		nameSet[n] = true
	}
	if !nameSet["Foo"] || !nameSet["Bar"] {
		t.Errorf("expected Foo and Bar, got %v", names)
	}
}

func TestAppRegistry_Clear(t *testing.T) {
	resetApp()
	App.DefineState(nil, &ModuleOptions{Name: "A"}).Build()
	App.DefineState(nil, &ModuleOptions{Name: "B"}).Build()

	App.Clear()
	if App.Size() != 0 {
		t.Error("expected empty registry after clear")
	}
}

func TestAppRegistry_Overwrite(t *testing.T) {
	resetApp()
	App.DefineState(map[string]any{"v": 1}, &ModuleOptions{Name: "Widget"}).Build()
	def2 := App.DefineState(map[string]any{"v": 2}, &ModuleOptions{Name: "Widget"}).Build()

	got := App.Get("Widget")
	if got != def2 {
		t.Error("expected overwritten definition")
	}
}

func TestAppModule_ConvenienceMethod(t *testing.T) {
	resetApp()
	def := App.Module("Settings").DefineState(map[string]any{"theme": "dark"}, nil).Build()

	if !App.Has("Settings") {
		t.Error("expected Settings to be auto-registered via Module()")
	}
	if App.Get("Settings") != def {
		t.Error("expected same definition back")
	}
	if def.Name != "Settings" {
		t.Errorf("expected name 'Settings', got '%s'", def.Name)
	}
}

// ========================================================================
// C. Managed Router Tests
// ========================================================================

func TestManagedRouter_MountsOnStart(t *testing.T) {
	resetApp()
	engine := NewMockEngine()
	router := NewHypenRouter()
	globalCtx := NewHypenGlobalContext()

	App.DefineState(map[string]any{"count": 0}, &ModuleOptions{Name: "Home"}).Build()

	managed := NewManagedRouter(router, engine, App, globalCtx)
	managed.AddRoute(RouteDefinition{
		Path:      "/",
		Component: "Home",
	})
	managed.Start()

	// Should have mounted the home module
	if managed.GetActiveModule() == nil {
		t.Error("expected active module after start")
	}

	if !globalCtx.HasModule("home") {
		t.Error("expected 'home' module registered in global context")
	}
}

func TestManagedRouter_UnmountsOnStop(t *testing.T) {
	resetApp()
	engine := NewMockEngine()
	router := NewHypenRouter()
	globalCtx := NewHypenGlobalContext()

	App.DefineState(map[string]any{"count": 0}, &ModuleOptions{Name: "Home"}).Build()

	managed := NewManagedRouter(router, engine, App, globalCtx)
	managed.AddRoute(RouteDefinition{
		Path:      "/",
		Component: "Home",
	})
	managed.Start()
	managed.Stop()

	if managed.GetActiveModule() != nil {
		t.Error("expected no active module after stop")
	}
	if globalCtx.HasModule("home") {
		t.Error("expected module unregistered after stop")
	}
}

func TestManagedRouter_SwitchesModuleOnNavigate(t *testing.T) {
	// Explicit Persist: BoolPtr(false) to exercise the pre-default
	// teardown behavior: navigating away destroys and unregisters the
	// leaving module.
	resetApp()
	engine := NewMockEngine()
	router := NewHypenRouter()
	globalCtx := NewHypenGlobalContext()

	App.DefineState(
		map[string]any{"count": 0},
		&ModuleOptions{Name: "Home", Persist: BoolPtr(false)},
	).Build()
	App.DefineState(
		map[string]any{"name": "Alice"},
		&ModuleOptions{Name: "Profile", Persist: BoolPtr(false)},
	).Build()

	managed := NewManagedRouter(router, engine, App, globalCtx)
	managed.AddRoute(RouteDefinition{Path: "/", Component: "Home"})
	managed.AddRoute(RouteDefinition{Path: "/profile", Component: "Profile"})
	managed.Start()

	// Verify home is mounted
	if !globalCtx.HasModule("home") {
		t.Error("expected home module")
	}

	// Navigate to profile
	router.Push("/profile")

	// Home should be unmounted, profile mounted
	if globalCtx.HasModule("home") {
		t.Error("expected home to be unmounted")
	}
	if !globalCtx.HasModule("profile") {
		t.Error("expected profile to be mounted")
	}
}

func TestManagedRouter_NoModuleForUnknownRoute(t *testing.T) {
	resetApp()
	engine := NewMockEngine()
	router := NewHypenRouter()
	globalCtx := NewHypenGlobalContext()

	managed := NewManagedRouter(router, engine, App, globalCtx)
	managed.AddRoute(RouteDefinition{Path: "/home", Component: "Home"})
	managed.Start()

	// Root "/" doesn't match "/home"
	if managed.GetActiveModule() != nil {
		t.Error("expected no active module for unmatched route")
	}
}

func TestManagedRouter_InlineModuleDefinition(t *testing.T) {
	resetApp()
	engine := NewMockEngine()
	router := NewHypenRouter()
	globalCtx := NewHypenGlobalContext()

	inlineDef := NewAppBuilder(map[string]any{"x": 1}, &ModuleOptions{Name: "Inline"}).Build()

	managed := NewManagedRouter(router, engine, App, globalCtx)
	managed.AddRoute(RouteDefinition{
		Path:      "/",
		Component: "Inline",
		Module:    inlineDef,
	})
	managed.Start()

	if !globalCtx.HasModule("inline") {
		t.Error("expected inline module mounted")
	}
}

// ========================================================================
// E. Persist Flag Tests
// ========================================================================

func TestPersistFalse_ModuleDestroyedOnUnmount(t *testing.T) {
	// Explicit opt-out: Persist: BoolPtr(false) restores pre-default
	// behavior where modules are destroyed on every navigation.
	resetApp()
	engine := NewMockEngine()
	router := NewHypenRouter()
	globalCtx := NewHypenGlobalContext()

	App.DefineState(map[string]any{"count": 0}, &ModuleOptions{Name: "Home", Persist: BoolPtr(false)}).Build()
	App.DefineState(map[string]any{"name": "Alice"}, &ModuleOptions{Name: "Profile", Persist: BoolPtr(false)}).Build()

	managed := NewManagedRouter(router, engine, App, globalCtx)
	managed.AddRoute(RouteDefinition{Path: "/", Component: "Home"})
	managed.AddRoute(RouteDefinition{Path: "/profile", Component: "Profile"})
	managed.Start()

	if !globalCtx.HasModule("home") {
		t.Error("expected home module mounted")
	}

	// Navigate away — Home should be destroyed (persist explicitly false)
	router.Push("/profile")

	if globalCtx.HasModule("home") {
		t.Error("expected home module destroyed after navigation")
	}
	if !globalCtx.HasModule("profile") {
		t.Error("expected profile module mounted")
	}
}

func TestPersist_DefaultsToTrueForModuleBackedRoutes(t *testing.T) {
	// Without Persist set on the module options, module-backed routes
	// now persist across navigation by default.
	resetApp()
	engine := NewMockEngine()
	router := NewHypenRouter()
	globalCtx := NewHypenGlobalContext()

	App.DefineState(map[string]any{"count": 0}, &ModuleOptions{Name: "Home"}).Build()
	App.DefineState(map[string]any{"name": "Alice"}, &ModuleOptions{Name: "Profile"}).Build()

	managed := NewManagedRouter(router, engine, App, globalCtx)
	managed.AddRoute(RouteDefinition{Path: "/", Component: "Home"})
	managed.AddRoute(RouteDefinition{Path: "/profile", Component: "Profile"})
	managed.Start()

	if !globalCtx.HasModule("home") {
		t.Error("expected home module mounted")
	}

	router.Push("/profile")

	// Home should persist by default.
	if !globalCtx.HasModule("home") {
		t.Error("expected home module to persist by default")
	}
	if !globalCtx.HasModule("profile") {
		t.Error("expected profile module mounted")
	}
}

func TestPersistTrue_ModuleStaysRegisteredAfterUnmount(t *testing.T) {
	resetApp()
	engine := NewMockEngine()
	router := NewHypenRouter()
	globalCtx := NewHypenGlobalContext()

	App.DefineState(map[string]any{"items": []any{}}, &ModuleOptions{Name: "Cart", Persist: BoolPtr(true)}).Build()
	App.DefineState(map[string]any{"step": 1}, &ModuleOptions{Name: "Checkout"}).Build()

	managed := NewManagedRouter(router, engine, App, globalCtx)
	managed.AddRoute(RouteDefinition{Path: "/cart", Component: "Cart"})
	managed.AddRoute(RouteDefinition{Path: "/checkout", Component: "Checkout"})

	// Navigate to cart first
	router.Push("/cart")
	managed.Start()

	if !globalCtx.HasModule("cart") {
		t.Error("expected cart module mounted")
	}

	// Navigate to checkout — Cart should persist
	router.Push("/checkout")

	if !globalCtx.HasModule("cart") {
		t.Error("expected cart module to persist after navigation")
	}
	if !globalCtx.HasModule("checkout") {
		t.Error("expected checkout module mounted")
	}
}

func TestPersistTrue_ReusesPersistedInstance(t *testing.T) {
	resetApp()
	engine := NewMockEngine()
	router := NewHypenRouter()
	globalCtx := NewHypenGlobalContext()

	App.DefineState(map[string]any{"items": []any{}}, &ModuleOptions{Name: "Cart", Persist: BoolPtr(true)}).Build()
	App.DefineState(map[string]any{"x": 1}, &ModuleOptions{Name: "Other"}).Build()

	managed := NewManagedRouter(router, engine, App, globalCtx)
	managed.AddRoute(RouteDefinition{Path: "/cart", Component: "Cart"})
	managed.AddRoute(RouteDefinition{Path: "/other", Component: "Other"})

	router.Push("/cart")
	managed.Start()

	// Capture registerModule call count after initial mount. Routed
	// modules mount through NewModuleInstance(..., AsNested()) so they
	// register in the engine's named-modules map, not the primary slot.
	callCountAfterMount := engine.RegisterModuleCallCount

	// Navigate away and back
	router.Push("/other")
	router.Push("/cart")

	// Should NOT have created a new module instance for Cart (it's
	// persisted). Only "Other" gets a fresh RegisterModule call.
	if engine.RegisterModuleCallCount != callCountAfterMount+1 {
		t.Errorf("expected %d registerModule calls, got %d", callCountAfterMount+1, engine.RegisterModuleCallCount)
	}

	if managed.GetActiveModule() == nil {
		t.Error("expected active module after re-navigating to cart")
	}
}

func TestPersistTrue_StopDestroysPersistedModules(t *testing.T) {
	resetApp()
	engine := NewMockEngine()
	router := NewHypenRouter()
	globalCtx := NewHypenGlobalContext()

	App.DefineState(map[string]any{"items": []any{}}, &ModuleOptions{Name: "Cart", Persist: BoolPtr(true)}).Build()
	App.DefineState(map[string]any{"x": 1}, &ModuleOptions{Name: "Other"}).Build()

	managed := NewManagedRouter(router, engine, App, globalCtx)
	managed.AddRoute(RouteDefinition{Path: "/cart", Component: "Cart"})
	managed.AddRoute(RouteDefinition{Path: "/other", Component: "Other"})

	router.Push("/cart")
	managed.Start()

	// Navigate away (Cart persisted)
	router.Push("/other")

	if !globalCtx.HasModule("cart") {
		t.Error("expected cart persisted")
	}

	// Full stop — everything cleaned up
	managed.Stop()

	if globalCtx.HasModule("cart") {
		t.Error("expected cart destroyed after stop")
	}
	if globalCtx.HasModule("other") {
		t.Error("expected other destroyed after stop")
	}
}

func TestPersistFlag_SetViaOptions(t *testing.T) {
	def := NewAppBuilder(map[string]any{"count": 0}, &ModuleOptions{Name: "PersistModule", Persist: BoolPtr(true)}).Build()
	if def.Persist == nil || !*def.Persist {
		t.Error("expected persist=true")
	}
}

func TestPersistFlag_DefaultsToNilOnDefinition(t *testing.T) {
	// The raw Persist field is nil when unset — ManagedRouter interprets
	// nil as "persist by default" for module-backed routes.
	def := NewAppBuilder(map[string]any{"count": 0}, nil).Build()
	if def.Persist != nil {
		t.Errorf("expected nil persist on definition, got %v", *def.Persist)
	}
}

// TestActivationLifecycle verifies OnActivated / OnDeactivated fire on
// every mount / unmount in the correct order, and that OnCreated only
// runs once per instance.
func TestActivationLifecycle(t *testing.T) {
	resetApp()
	engine := NewMockEngine()
	router := NewHypenRouter()
	globalCtx := NewHypenGlobalContext()

	var events []string
	var mu sync.Mutex
	logEvent := func(e string) {
		mu.Lock()
		defer mu.Unlock()
		events = append(events, e)
	}
	snapshot := func() []string {
		mu.Lock()
		defer mu.Unlock()
		out := make([]string, len(events))
		copy(out, events)
		return out
	}

	// Note: ObservableState DeepClones initialState via JSON, so Go ints
	// become float64 on readback. Use float64 arithmetic accordingly.
	App.DefineState(map[string]any{"visits": 0}, &ModuleOptions{Name: "Screen"}).
		OnCreated(func(_ *ObservableState, _ GlobalContext) { logEvent("created") }).
		OnActivated(func(state *ObservableState, _ GlobalContext) {
			logEvent("activated")
			cur, _ := state.Get("visits").(float64)
			state.Set("visits", cur+1)
		}).
		OnDeactivated(func(_ *ObservableState, _ GlobalContext) { logEvent("deactivated") }).
		OnDestroyed(func(_ *ObservableState, _ GlobalContext) { logEvent("destroyed") }).
		Build()

	App.DefineState(map[string]any{}, &ModuleOptions{Name: "Other"}).Build()

	managed := NewManagedRouter(router, engine, App, globalCtx)
	managed.AddRoute(RouteDefinition{Path: "/screen", Component: "Screen"})
	managed.AddRoute(RouteDefinition{Path: "/other", Component: "Other"})

	router.Push("/screen")
	managed.Start()
	assertEq := func(want []string, where string) {
		got := snapshot()
		if len(got) != len(want) {
			t.Fatalf("%s: events %v, want %v", where, got, want)
		}
		for i := range got {
			if got[i] != want[i] {
				t.Fatalf("%s: events %v, want %v", where, got, want)
			}
		}
	}
	assertEq([]string{"created", "activated"}, "after first mount")

	router.Push("/other")
	assertEq([]string{"created", "activated", "deactivated"}, "after navigate away")

	router.Push("/screen")
	assertEq([]string{"created", "activated", "deactivated", "activated"}, "after navigate back")

	screen := managed.GetActiveModule()
	if v, _ := screen.GetState()["visits"].(float64); v != 2 {
		t.Errorf("expected visits=2, got %v", screen.GetState()["visits"])
	}

	managed.Stop()
	assertEq(
		[]string{"created", "activated", "deactivated", "activated", "deactivated", "destroyed"},
		"after stop",
	)
}

// TestNoLoadingFlash ensures that state set during OnCreated survives
// a navigate-away-and-back round trip without OnCreated re-running.
func TestNoLoadingFlash(t *testing.T) {
	resetApp()
	engine := NewMockEngine()
	router := NewHypenRouter()
	globalCtx := NewHypenGlobalContext()

	var createdCount int
	var mu sync.Mutex
	App.DefineState(
		map[string]any{"loading": true, "items": []any{}},
		&ModuleOptions{Name: "Items"},
	).OnCreated(func(state *ObservableState, _ GlobalContext) {
		mu.Lock()
		createdCount++
		mu.Unlock()
		// Simulate immediate data load.
		state.Set("items", []any{"a", "b", "c"})
		state.Set("loading", false)
	}).Build()
	App.DefineState(map[string]any{}, &ModuleOptions{Name: "Other"}).Build()

	managed := NewManagedRouter(router, engine, App, globalCtx)
	managed.AddRoute(RouteDefinition{Path: "/items", Component: "Items"})
	managed.AddRoute(RouteDefinition{Path: "/other", Component: "Other"})

	router.Push("/items")
	managed.Start()

	mu.Lock()
	if createdCount != 1 {
		t.Fatalf("expected OnCreated to run once, got %d", createdCount)
	}
	mu.Unlock()

	first := managed.GetActiveModule().GetState()
	if loading, _ := first["loading"].(bool); loading {
		t.Error("expected loading=false after first OnCreated")
	}

	router.Push("/other")
	router.Push("/items")

	mu.Lock()
	if createdCount != 1 {
		t.Errorf("expected OnCreated to stay at 1, got %d (module was not persisted)", createdCount)
	}
	mu.Unlock()

	second := managed.GetActiveModule().GetState()
	if loading, _ := second["loading"].(bool); loading {
		t.Error("expected loading=false on re-entry (state should persist)")
	}
}

// ========================================================================
// F. Integration: Two modules with separate state
// ========================================================================

func TestTwoModules_SeparateNamespacedState(t *testing.T) {
	engine := NewMockEngine()
	globalCtx := NewHypenGlobalContext()

	homeDef := NewAppBuilder(map[string]any{"count": 0}, &ModuleOptions{Name: "home"}).Build()
	profileDef := NewAppBuilder(map[string]any{"name": "Alice"}, &ModuleOptions{Name: "profile"}).Build()

	homeInst := NewModuleInstance(engine, homeDef, WithGlobalContext(globalCtx))
	globalCtx.RegisterModule("home", homeInst)

	profileInst := NewModuleInstance(engine, profileDef, WithGlobalContext(globalCtx))
	globalCtx.RegisterModule("profile", profileInst)

	// Verify both are registered
	ids := globalCtx.GetModuleIds()
	if len(ids) != 2 {
		t.Errorf("expected 2 modules, got %d", len(ids))
	}

	// Global state should have both
	state := globalCtx.GetGlobalState()
	if _, ok := state["home"]; !ok {
		t.Error("expected 'home' in global state")
	}
	if _, ok := state["profile"]; !ok {
		t.Error("expected 'profile' in global state")
	}
}
