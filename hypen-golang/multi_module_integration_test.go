package core

import (
	"testing"
)

// ========================================================================
// Multi-Module Integration Tests
//
// These tests verify the typed builder + app registry + nested module
// creation pipeline works end-to-end.
// ========================================================================

type searchState struct {
	Query   string   `json:"query"`
	Results []string `json:"results"`
}

type feedItemsState struct {
	Posts   []string `json:"posts"`
	Loading bool     `json:"loading"`
}

type profileInfo struct {
	Username string `json:"username"`
	Bio      string `json:"bio"`
}

// ========================================================================
// A. Typed builder Name("X").Build() registers in App.GetNames()
// ========================================================================

func TestTypedBuilder_NamedModuleAppearsInGetNames(t *testing.T) {
	resetApp()

	NewApp(searchState{Query: "", Results: []string{}}).
		Name("Search").
		OnAction("search", func(ctx TypedActionContext[searchState]) {
			ctx.State.Results = []string{"result1", "result2"}
		}).
		Build()

	names := App.GetNames()
	found := false
	for _, n := range names {
		if n == "Search" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected 'Search' in App.GetNames(), got %v", names)
	}
}

func TestTypedBuilder_MultipleNamedModulesInRegistry(t *testing.T) {
	resetApp()

	NewApp(searchState{}).Name("Search").Build()
	NewApp(feedItemsState{}).Name("Feed").Build()
	NewApp(profileInfo{}).Name("Profile").Build()

	names := App.GetNames()
	if len(names) != 3 {
		t.Errorf("expected 3 modules in registry, got %d: %v", len(names), names)
	}

	expected := map[string]bool{"Search": false, "Feed": false, "Profile": false}
	for _, n := range names {
		expected[n] = true
	}
	for name, found := range expected {
		if !found {
			t.Errorf("expected '%s' in App.GetNames()", name)
		}
	}
}

func TestTypedBuilder_ModuleDefinitionHasCorrectInitialState(t *testing.T) {
	resetApp()

	NewApp(searchState{Query: "hello", Results: []string{"a", "b"}}).
		Name("Search").
		Build()

	def := App.Get("Search")
	if def == nil {
		t.Fatal("expected 'Search' module in registry")
	}

	// The initial state should contain the struct fields
	if def.InitialState == nil {
		t.Fatal("expected non-nil initial state")
	}

	state := def.InitialState

	if state["query"] != "hello" {
		t.Errorf("expected query='hello', got %v", state["query"])
	}
}

// ========================================================================
// B. Typed module + CreateNestedModuleInstances integration
// ========================================================================

func TestTypedModule_CreateNestedModuleInstances(t *testing.T) {
	resetApp()
	engine := NewMockEngine()
	globalCtx := NewHypenGlobalContext()

	// Register primary module (already instantiated)
	NewApp(counterState{Count: 0}).
		Name("App").
		Build()

	primaryDef := App.Get("App")
	primaryInst := NewModuleInstance(engine, primaryDef, WithGlobalContext(globalCtx))
	globalCtx.RegisterModule("app", primaryInst)

	// Register nested modules via typed builder
	NewApp(searchState{Query: "", Results: []string{}}).
		Name("Search").
		OnAction("search", func(ctx TypedActionContext[searchState]) {
			ctx.State.Results = []string{"found"}
		}).
		Build()

	NewApp(feedItemsState{Posts: []string{}, Loading: false}).
		Name("Feed").
		OnAction("loadFeed", func(ctx TypedActionContext[feedItemsState]) {
			ctx.State.Loading = true
		}).
		Build()

	// Create nested instances
	nested := CreateNestedModuleInstances(engine, App, globalCtx, nil)

	// Should create Search and Feed (not App, already instantiated)
	if len(nested) != 2 {
		t.Errorf("expected 2 nested modules, got %d", len(nested))
	}
	if _, ok := nested["Search"]; !ok {
		t.Error("expected 'Search' in nested modules")
	}
	if _, ok := nested["Feed"]; !ok {
		t.Error("expected 'Feed' in nested modules")
	}

	// Verify they are in global context
	if !globalCtx.HasModule("search") {
		t.Error("expected 'search' registered in global context")
	}
	if !globalCtx.HasModule("feed") {
		t.Error("expected 'feed' registered in global context")
	}
}

// ========================================================================
// C. Full integration: typed modules + nested instances + actions
// ========================================================================

func TestTypedModule_EndToEndMultiModule(t *testing.T) {
	resetApp()
	engine := NewMockEngine()
	globalCtx := NewHypenGlobalContext()

	// Primary module
	appDef := NewApp(counterState{Count: 0, Message: "home"}).
		Name("App").
		OnAction("increment", func(ctx TypedActionContext[counterState]) {
			ctx.State.Count++
		}).
		Build()

	appInst := NewModuleInstance(engine, appDef, WithGlobalContext(globalCtx))
	globalCtx.RegisterModule("app", appInst)

	// Nested module
	NewApp(searchState{Query: "", Results: []string{}}).
		Name("Search").
		OnAction("search", func(ctx TypedActionContext[searchState]) {
			ctx.State.Query = "test"
			ctx.State.Results = []string{"result1", "result2"}
		}).
		Build()

	// Create nested instances
	nested := CreateNestedModuleInstances(engine, App, globalCtx, nil)

	if len(nested) != 1 {
		t.Fatalf("expected 1 nested module (Search), got %d", len(nested))
	}

	// Verify primary module action works — raw path, empty scope.
	engine.ClearStateChanges()
	engine.TriggerAction("increment", nil)

	changes := engine.GetStateChanges()
	foundApp := false
	for _, change := range changes {
		if change.Scope != "" {
			continue
		}
		for _, path := range change.Paths {
			if path == "count" {
				foundApp = true
			}
		}
	}
	if !foundApp {
		t.Error("expected raw 'count' state change with empty scope from primary module action")
	}

	// Verify nested module action works — raw path, scope="search".
	engine.ClearStateChanges()
	engine.TriggerAction("search", nil)

	changes = engine.GetStateChanges()
	foundSearch := false
	for _, change := range changes {
		if change.Scope != "Search" {
			continue
		}
		for _, path := range change.Paths {
			if path == "query" || path == "results" {
				foundSearch = true
			}
		}
	}
	if !foundSearch {
		t.Error("expected scope='Search' with raw query/results paths from nested module action")
	}

	// Both modules accessible via global context
	if !globalCtx.HasModule("app") {
		t.Error("expected 'app' in global context")
	}
	if !globalCtx.HasModule("search") {
		t.Error("expected 'search' in global context")
	}
}

func TestTypedModule_CrossModuleCommunicationViaGlobalContext(t *testing.T) {
	resetApp()
	engine := NewMockEngine()
	globalCtx := NewHypenGlobalContext()

	// Primary module
	appDef := NewApp(counterState{Count: 0, Message: "home"}).
		Name("App").
		Build()

	appInst := NewModuleInstance(engine, appDef, WithGlobalContext(globalCtx))
	globalCtx.RegisterModule("app", appInst)

	// Nested module that accesses primary via global context
	NewApp(searchState{}).
		Name("Search").
		OnAction("checkParent", func(ctx TypedActionContext[searchState]) {
			if ctx.Context == nil {
				t.Error("expected global context to be available in typed handler")
				return
			}
			if !ctx.Context.HasModule("app") {
				t.Error("expected 'app' module accessible from nested typed handler")
				return
			}
			appRef := ctx.Context.GetModule("app")
			if appRef == nil {
				t.Error("expected non-nil app module reference")
			}
		}).
		Build()

	nested := CreateNestedModuleInstances(engine, App, globalCtx, nil)
	_ = nested

	// Trigger the nested module's action
	engine.TriggerAction("checkParent", nil)
}

// ========================================================================
// D. Auto-discovery pattern (mirrors RemoteServer.handleOpen)
// ========================================================================

func TestAutoDiscoveryPattern_RegistersNonPrimaryModules(t *testing.T) {
	resetApp()

	primaryModuleName := "App"

	// Register primary
	NewApp(counterState{Count: 0}).Name(primaryModuleName).Build()

	// Register nested modules
	NewApp(searchState{}).Name("Search").Build()
	NewApp(feedItemsState{}).Name("Feed").Build()

	// Simulate the RemoteServer auto-discovery loop:
	//   for name := range appRegistry.GetNames() {
	//       if name == primaryModuleName { continue }
	//       def := appRegistry.Get(name)
	//       engine.RegisterModule(name, ...)
	//   }

	autoDiscovered := []string{}
	for _, name := range App.GetNames() {
		if name == primaryModuleName {
			continue
		}
		def := App.Get(name)
		if def != nil {
			autoDiscovered = append(autoDiscovered, name)
		}
	}

	if len(autoDiscovered) != 2 {
		t.Errorf("expected 2 auto-discovered modules, got %d: %v", len(autoDiscovered), autoDiscovered)
	}

	foundSearch := false
	foundFeed := false
	for _, name := range autoDiscovered {
		if name == "Search" {
			foundSearch = true
		}
		if name == "Feed" {
			foundFeed = true
		}
	}
	if !foundSearch {
		t.Error("expected 'Search' to be auto-discovered")
	}
	if !foundFeed {
		t.Error("expected 'Feed' to be auto-discovered")
	}
}
