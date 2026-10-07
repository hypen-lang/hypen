package core

import (
	"testing"
)

// ========================================================================
// A. Nested module instance tests (NewModuleInstance with AsNested())
// ========================================================================

func TestNestedModule_RegistersWithEngine(t *testing.T) {
	engine := NewMockEngine()
	// Primary module — sets up the engine
	primaryDef := NewAppBuilder(map[string]any{"count": 0}, &ModuleOptions{Name: "App"}).Build()
	NewModuleInstance(engine, primaryDef)

	// Nested module — should NOT overwrite SetModule; it should call
	// RegisterModule so the engine owns the scoped initial state directly.
	feedDef := NewAppBuilder(map[string]any{"items": []any{"a", "b"}}, &ModuleOptions{Name: "Feed"}).Build()
	engine.ClearStateChanges()
	NewModuleInstance(engine, feedDef, AsNested())

	// SetModule should have been called only ONCE (for the primary module)
	if engine.SetModuleCallCount != 1 {
		t.Errorf("expected SetModule called once (primary only), got %d", engine.SetModuleCallCount)
	}

	// RegisterModule should have been called for Feed with its raw state.
	feed, ok := engine.RegisteredModules["Feed"]
	if !ok {
		t.Fatalf("expected 'Feed' in RegisteredModules, got %v", engine.RegisteredModules)
	}
	items, ok := feed.InitialState["items"].([]any)
	if !ok || len(items) != 2 {
		t.Errorf("expected raw 'items' key in Feed initial state, got %v", feed.InitialState)
	}

	// Initial registration should NOT emit state-change notifications.
	if len(engine.GetStateChanges()) != 0 {
		t.Errorf("expected no state changes from initial registration, got %v", engine.GetStateChanges())
	}
}

func TestNestedModule_RegistersActionHandlers(t *testing.T) {
	engine := NewMockEngine()
	primaryDef := NewAppBuilder(map[string]any{"count": 0}, &ModuleOptions{Name: "App"}).Build()
	NewModuleInstance(engine, primaryDef)

	actionCalled := false
	feedDef := NewAppBuilder(map[string]any{"items": []any{}}, &ModuleOptions{Name: "Feed"}).
		OnAction("loadFeed", func(ctx ActionHandlerContext) {
			actionCalled = true
		}).
		Build()
	NewModuleInstance(engine, feedDef, AsNested())

	// Trigger the nested module's action
	if !engine.HasAction("loadFeed") {
		t.Fatal("expected 'loadFeed' action registered")
	}
	engine.TriggerAction("loadFeed", nil)
	if !actionCalled {
		t.Error("expected nested action handler to be called")
	}
}

func TestNestedModule_StateChangesCarryScope(t *testing.T) {
	engine := NewMockEngine()
	primaryDef := NewAppBuilder(map[string]any{"count": 0}, &ModuleOptions{Name: "App"}).Build()
	NewModuleInstance(engine, primaryDef)

	feedDef := NewAppBuilder(map[string]any{"items": []any{}}, &ModuleOptions{Name: "Feed"}).Build()
	instance := NewModuleInstance(engine, feedDef, AsNested())

	engine.ClearStateChanges()

	// Mutate nested module state
	instance.GetLiveState().Set("items", []any{"x", "y"})

	changes := engine.GetStateChanges()
	if len(changes) == 0 {
		t.Fatal("expected state changes after mutation")
	}

	// Nested mutations flow through NotifyStateChange with a non-empty scope,
	// which records the scope alongside the raw path. The SDK passes the
	// module name as-is to the engine — the engine canonicalizes case
	// internally — so the recorded scope reflects the original casing.
	found := false
	for _, change := range changes {
		if change.Scope != "Feed" {
			continue
		}
		for _, path := range change.Paths {
			if path == "items" {
				found = true
			}
		}
	}
	if !found {
		t.Errorf("expected scope='Feed' with raw path 'items', got %v", changes)
	}
}

func TestNestedModule_CallsOnCreated(t *testing.T) {
	engine := NewMockEngine()
	primaryDef := NewAppBuilder(map[string]any{"count": 0}, &ModuleOptions{Name: "App"}).Build()
	NewModuleInstance(engine, primaryDef)

	createdCalled := false
	feedDef := NewAppBuilder(map[string]any{"items": []any{}}, &ModuleOptions{Name: "Feed"}).
		OnCreated(func(state *ObservableState, ctx GlobalContext) {
			createdCalled = true
		}).
		Build()
	NewModuleInstance(engine, feedDef, AsNested())

	if !createdCalled {
		t.Error("expected onCreated to be called for nested module")
	}
}

func TestNestedModule_DestroyCallsOnDestroyed(t *testing.T) {
	engine := NewMockEngine()
	primaryDef := NewAppBuilder(map[string]any{"count": 0}, &ModuleOptions{Name: "App"}).Build()
	NewModuleInstance(engine, primaryDef)

	destroyedCalled := false
	feedDef := NewAppBuilder(map[string]any{"items": []any{}}, &ModuleOptions{Name: "Feed"}).
		OnDestroyed(func(state *ObservableState, ctx GlobalContext) {
			destroyedCalled = true
		}).
		Build()
	instance := NewModuleInstance(engine, feedDef, AsNested())
	instance.Destroy()

	if !destroyedCalled {
		t.Error("expected onDestroyed to be called for nested module")
	}
}

func TestNestedModule_GlobalContextAccess(t *testing.T) {
	engine := NewMockEngine()
	globalCtx := NewHypenGlobalContext()

	primaryDef := NewAppBuilder(map[string]any{"count": 0}, &ModuleOptions{Name: "App"}).Build()
	primaryInst := NewModuleInstance(engine, primaryDef, WithGlobalContext(globalCtx))
	globalCtx.RegisterModule("app", primaryInst)

	feedDef := NewAppBuilder(map[string]any{"items": []any{}}, &ModuleOptions{Name: "Feed"}).
		OnAction("checkParent", func(ctx ActionHandlerContext) {
			if ctx.Context == nil {
				t.Error("expected global context to be available")
			}
			if !ctx.Context.HasModule("app") {
				t.Error("expected 'app' module accessible via context")
			}
		}).
		Build()
	feedInst := NewModuleInstance(engine, feedDef, AsNested(), WithGlobalContext(globalCtx))
	globalCtx.RegisterModule("feed", feedInst)

	engine.TriggerAction("checkParent", nil)
}

// ========================================================================
// B. CreateNestedModuleInstances Tests
// ========================================================================

func TestCreateNestedModuleInstances_CreatesStatefulModules(t *testing.T) {
	resetApp()
	engine := NewMockEngine()
	globalCtx := NewHypenGlobalContext()

	// Register primary module (already instantiated)
	App.DefineState(map[string]any{"count": 0}, &ModuleOptions{Name: "App"}).Build()
	primaryDef := App.Get("App")
	primaryInst := NewModuleInstance(engine, primaryDef, WithGlobalContext(globalCtx))
	globalCtx.RegisterModule("app", primaryInst)

	// Register a nested module in the app registry
	App.DefineState(map[string]any{"items": []any{}}, &ModuleOptions{Name: "Feed"}).
		OnAction("refresh", func(ctx ActionHandlerContext) {}).
		Build()

	// Create nested instances
	nested := CreateNestedModuleInstances(engine, App, globalCtx, nil)

	if len(nested) != 1 {
		t.Errorf("expected 1 nested module, got %d", len(nested))
	}
	if _, ok := nested["Feed"]; !ok {
		t.Error("expected 'Feed' in nested modules")
	}
	if !globalCtx.HasModule("feed") {
		t.Error("expected 'feed' registered in global context")
	}
}

func TestCreateNestedModuleInstances_SkipsAlreadyInstantiated(t *testing.T) {
	resetApp()
	engine := NewMockEngine()
	globalCtx := NewHypenGlobalContext()

	App.DefineState(map[string]any{"count": 0}, &ModuleOptions{Name: "App"}).Build()
	primaryInst := NewModuleInstance(engine, App.Get("App"), WithGlobalContext(globalCtx))
	globalCtx.RegisterModule("app", primaryInst)

	App.DefineState(map[string]any{"items": []any{}}, &ModuleOptions{Name: "Feed"}).Build()

	// First call creates Feed
	nested1 := CreateNestedModuleInstances(engine, App, globalCtx, nil)
	if len(nested1) != 1 {
		t.Fatalf("expected 1 nested module, got %d", len(nested1))
	}

	// Second call should skip both App and Feed (already in GlobalContext)
	nested2 := CreateNestedModuleInstances(engine, App, globalCtx, nil)
	if len(nested2) != 0 {
		t.Errorf("expected 0 nested modules on second call, got %d", len(nested2))
	}
}

func TestCreateNestedModuleInstances_SkipsStatelessModules(t *testing.T) {
	resetApp()
	engine := NewMockEngine()
	globalCtx := NewHypenGlobalContext()

	// Stateless component (no state, no actions)
	App.Register("Banner", NewAppBuilder(nil, &ModuleOptions{Name: "Banner"}).Build())

	nested := CreateNestedModuleInstances(engine, App, globalCtx, nil)
	if len(nested) != 0 {
		t.Errorf("expected 0 nested modules for stateless component, got %d", len(nested))
	}
}

func TestCreateNestedModuleInstances_NilAppOrContext(t *testing.T) {
	engine := NewMockEngine()
	globalCtx := NewHypenGlobalContext()

	// Nil app
	nested := CreateNestedModuleInstances(engine, nil, globalCtx, nil)
	if len(nested) != 0 {
		t.Error("expected empty result for nil app")
	}

	// Nil context
	nested = CreateNestedModuleInstances(engine, App, nil, nil)
	if len(nested) != 0 {
		t.Error("expected empty result for nil context")
	}
}

// ========================================================================
// C. Integration: Primary + Nested Modules on Shared Engine
// ========================================================================

func TestIntegration_PrimaryAndNestedModulesCoexist(t *testing.T) {
	engine := NewMockEngine()
	globalCtx := NewHypenGlobalContext()

	// Create primary module
	appDef := NewAppBuilder(map[string]any{"count": float64(0)}, &ModuleOptions{Name: "App"}).
		OnAction("increment", func(ctx ActionHandlerContext) {
			count := ctx.State.Get("count")
			if c, ok := count.(float64); ok {
				ctx.State.Set("count", c+1)
			}
		}).
		Build()
	appInst := NewModuleInstance(engine, appDef, WithGlobalContext(globalCtx))
	globalCtx.RegisterModule("app", appInst)

	// Create nested module
	feedDef := NewAppBuilder(map[string]any{"items": []any{"a"}}, &ModuleOptions{Name: "Feed"}).
		OnAction("addItem", func(ctx ActionHandlerContext) {
			items := ctx.State.Get("items")
			if list, ok := items.([]any); ok {
				ctx.State.Set("items", append(list, "new"))
			}
		}).
		Build()
	feedInst := NewModuleInstance(engine, feedDef, AsNested(), WithGlobalContext(globalCtx))
	globalCtx.RegisterModule("feed", feedInst)

	// Both modules should be in GlobalContext
	if !globalCtx.HasModule("app") {
		t.Error("expected 'app' module")
	}
	if !globalCtx.HasModule("feed") {
		t.Error("expected 'feed' module")
	}

	// Trigger primary module action — raw path, empty scope.
	engine.ClearStateChanges()
	engine.TriggerAction("increment", nil)

	changes := engine.GetStateChanges()
	foundAppChange := false
	for _, change := range changes {
		if change.Scope != "" {
			continue
		}
		for _, path := range change.Paths {
			if path == "count" {
				foundAppChange = true
			}
		}
	}
	if !foundAppChange {
		t.Error("expected raw 'count' state change with empty scope from primary module action")
	}

	// Trigger nested module action — raw path, scope=module name as-is.
	// (The engine canonicalizes case internally.)
	engine.ClearStateChanges()
	engine.TriggerAction("addItem", nil)

	changes = engine.GetStateChanges()
	foundFeedChange := false
	for _, change := range changes {
		if change.Scope != "Feed" {
			continue
		}
		for _, path := range change.Paths {
			if path == "items" {
				foundFeedChange = true
			}
		}
	}
	if !foundFeedChange {
		t.Error("expected scope='Feed' with path 'items' from nested module action")
	}
}

func TestIntegration_CrossModuleCommunication(t *testing.T) {
	engine := NewMockEngine()
	globalCtx := NewHypenGlobalContext()

	// Primary module
	appDef := NewAppBuilder(map[string]any{"notifications": 0}, &ModuleOptions{Name: "App"}).Build()
	appInst := NewModuleInstance(engine, appDef, WithGlobalContext(globalCtx))
	globalCtx.RegisterModule("app", appInst)

	// Nested module that modifies parent's state via GlobalContext
	feedDef := NewAppBuilder(map[string]any{"items": []any{}}, &ModuleOptions{Name: "Feed"}).
		OnAction("notifyParent", func(ctx ActionHandlerContext) {
			appRef := ctx.Context.GetModule("app")
			if appRef == nil {
				t.Error("expected app module accessible")
				return
			}
			appRef.SetState(map[string]any{"notifications": 1})
		}).
		Build()
	feedInst := NewModuleInstance(engine, feedDef, AsNested(), WithGlobalContext(globalCtx))
	globalCtx.RegisterModule("feed", feedInst)

	// Trigger cross-module action
	engine.TriggerAction("notifyParent", nil)

	// Check that the parent module's state was updated
	appRef := globalCtx.GetModule("app")
	if appRef == nil {
		t.Fatal("expected app module in context")
	}
	state := appRef.GetState()
	// The state keys are prefixed under "app" by ObservableState
	if notifications, ok := state["notifications"]; ok {
		if n, ok := notifications.(int); ok && n != 1 {
			t.Errorf("expected notifications=1, got %v", notifications)
		}
	}
}

func TestNestedModule_BindActionWorks(t *testing.T) {
	engine := NewMockEngine()
	primaryDef := NewAppBuilder(map[string]any{"count": 0}, &ModuleOptions{Name: "App"}).Build()
	NewModuleInstance(engine, primaryDef)

	feedDef := NewAppBuilder(map[string]any{"query": ""}, &ModuleOptions{Name: "Feed"}).Build()
	instance := NewModuleInstance(engine, feedDef, AsNested())

	// Simulate a .bind() action from the UI
	engine.TriggerAction("__hypen_scoped:feed:__hypen_bind", map[string]any{
		"path":  "query",
		"value": "hello",
	})

	// The nested module's state should be updated
	query := instance.GetLiveState().Get("query")
	if query != "hello" {
		t.Errorf("expected query='hello', got %v", query)
	}
}
