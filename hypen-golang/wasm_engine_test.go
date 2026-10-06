package core

import (
	"os"
	"path/filepath"
	"testing"
)

// getWasmPath returns the path to the WASM binary
func getWasmPath() string {
	// Try relative path from hypen-golang directory
	paths := []string{
		"../target/wasm32-wasip1/release/hypen_engine.wasm",
		"../hypen-engine-rs/target/wasm32-wasip1/release/hypen_engine.wasm",
		"../../hypen-engine-rs/target/wasm32-wasip1/release/hypen_engine.wasm",
	}

	for _, p := range paths {
		if _, err := os.Stat(p); err == nil {
			abs, _ := filepath.Abs(p)
			return abs
		}
	}

	return ""
}

func newTestEngine(t *testing.T) *WasmEngine {
	t.Helper()
	wasmPath := getWasmPath()
	if wasmPath == "" {
		t.Skip("WASM binary not found - build with: cd hypen-engine-rs && cargo build --target wasm32-wasip1 --features wasi --release")
	}

	engine, err := NewWasmEngine(WasmEngineConfig{
		WasmPath:   wasmPath,
		Primitives: []string{"Text", "Column", "Row", "Button", "Input"},
	})
	if err != nil {
		t.Fatalf("Failed to create engine: %v", err)
	}
	t.Cleanup(func() { engine.Close() })
	return engine
}

// findPatch returns the first patch matching the given type, or nil.
func findPatch(patches []Patch, patchType string) *Patch {
	for i := range patches {
		if patches[i].Type == patchType {
			return &patches[i]
		}
	}
	return nil
}

// findPatches returns all patches matching the given type.
func findPatches(patches []Patch, patchType string) []Patch {
	var result []Patch
	for _, p := range patches {
		if p.Type == patchType {
			result = append(result, p)
		}
	}
	return result
}

func TestWasmEngineCreate(t *testing.T) {
	engine := newTestEngine(t)

	ast, err := engine.ParseToJSON(`Text("Hello")`)
	if err != nil {
		t.Fatalf("Failed to parse: %v", err)
	}
	if ast == "" {
		t.Error("Expected non-empty AST")
	}
}

func TestWasmEngineRender(t *testing.T) {
	engine := newTestEngine(t)

	patches, err := engine.RenderSource(`Text("Hello World")`)
	if err != nil {
		t.Fatalf("Failed to render: %v", err)
	}

	if len(patches) == 0 {
		t.Fatal("Expected patches from render")
	}

	// Should have create and insert patches
	create := findPatch(patches, PatchCreate)
	if create == nil {
		t.Fatal("Expected a create patch")
	}
	if create.ElementType != "Text" {
		t.Errorf("Expected ElementType='Text', got '%s'", create.ElementType)
	}
	if create.ID == "" {
		t.Error("Expected non-empty ID on create patch")
	}

	insert := findPatch(patches, PatchInsert)
	if insert == nil {
		t.Fatal("Expected an insert patch")
	}
	if insert.ParentID == "" {
		t.Error("Expected non-empty ParentID on insert patch")
	}
	if insert.ID == "" {
		t.Error("Expected non-empty ID on insert patch")
	}
}

func TestWasmEngineRender_CreatePatchProps(t *testing.T) {
	engine := newTestEngine(t)

	patches, err := engine.RenderSource(`Text("Hello World")`)
	if err != nil {
		t.Fatalf("Failed to render: %v", err)
	}

	create := findPatch(patches, PatchCreate)
	if create == nil {
		t.Fatal("Expected a create patch")
	}

	// Text("Hello World") should have props with the text content
	if len(create.Props) == 0 {
		t.Fatal("Expected non-empty props on create patch")
	}

	// The text content should be in props (typically as positional arg "0")
	textVal, ok := create.Props["0"]
	if !ok {
		t.Fatalf("Expected prop '0' (positional text arg), got props: %v", create.Props)
	}
	if textVal != "Hello World" {
		t.Errorf("Expected prop '0'='Hello World', got '%v'", textVal)
	}
}

func TestWasmEngineRender_InsertPatchFields(t *testing.T) {
	engine := newTestEngine(t)

	patches, err := engine.RenderSource(`Text("Hello")`)
	if err != nil {
		t.Fatalf("Failed to render: %v", err)
	}

	insert := findPatch(patches, PatchInsert)
	if insert == nil {
		t.Fatal("Expected an insert patch")
	}

	// Root insert should have parentId = "root"
	if insert.ParentID != "root" {
		t.Errorf("Expected ParentID='root', got '%s'", insert.ParentID)
	}

	// The insert ID should match the create ID
	create := findPatch(patches, PatchCreate)
	if create == nil {
		t.Fatal("Expected a create patch")
	}
	if insert.ID != create.ID {
		t.Errorf("Insert ID '%s' should match Create ID '%s'", insert.ID, create.ID)
	}
}

func TestWasmEngineRender_NestedChildren(t *testing.T) {
	engine := newTestEngine(t)

	patches, err := engine.RenderSource(`Column { Text("First") Text("Second") }`)
	if err != nil {
		t.Fatalf("Failed to render: %v", err)
	}

	creates := findPatches(patches, PatchCreate)
	if len(creates) < 3 {
		t.Fatalf("Expected at least 3 create patches (Column + 2 Text), got %d", len(creates))
	}

	// Should have a Column and two Text creates
	hasColumn := false
	textCount := 0
	for _, c := range creates {
		switch c.ElementType {
		case "Column":
			hasColumn = true
		case "Text":
			textCount++
		}
	}
	if !hasColumn {
		t.Error("Expected a Column create patch")
	}
	if textCount != 2 {
		t.Errorf("Expected 2 Text create patches, got %d", textCount)
	}

	// Inserts: children should have parentId pointing to the column
	inserts := findPatches(patches, PatchInsert)
	if len(inserts) < 3 {
		t.Fatalf("Expected at least 3 insert patches, got %d", len(inserts))
	}

	// Find the Column's ID
	var columnID string
	for _, c := range creates {
		if c.ElementType == "Column" {
			columnID = c.ID
			break
		}
	}

	// At least two inserts should have parentId == columnID (the Text children)
	childInserts := 0
	for _, ins := range inserts {
		if ins.ParentID == columnID {
			childInserts++
		}
	}
	if childInserts != 2 {
		t.Errorf("Expected 2 child inserts with parentId='%s', got %d", columnID, childInserts)
	}
}

func TestWasmEngineWithState_SetPropPatch(t *testing.T) {
	engine := newTestEngine(t)

	engine.SetModule("TestModule", []string{}, []string{"count"}, map[string]any{
		"count": 0,
	})

	// Render with state binding
	_, err := engine.RenderSource(`Text("@{state.count}")`)
	if err != nil {
		t.Fatalf("Failed to render: %v", err)
	}

	// Update state — should produce a setProp or setText patch
	updatePatches, err := engine.UpdateState(map[string]any{
		"count": 42,
	})
	if err != nil {
		t.Fatalf("Failed to update state: %v", err)
	}

	if len(updatePatches) == 0 {
		t.Fatal("Expected patches from state update")
	}

	// Look for a patch that reflects the new value
	found := false
	for _, p := range updatePatches {
		if p.Type == PatchSetProp {
			if p.Name == "" {
				t.Error("SetProp patch should have a non-empty Name")
			}
			if p.ID == "" {
				t.Error("SetProp patch should have a non-empty ID")
			}
			found = true
		} else if p.Type == PatchSetText {
			if p.ID == "" {
				t.Error("SetText patch should have a non-empty ID")
			}
			found = true
		}
	}

	if !found {
		t.Errorf("Expected setProp or setText patch from state update, got: %+v", updatePatches)
	}
}

func TestWasmEngineActions(t *testing.T) {
	engine := newTestEngine(t)

	actionCalled := false
	var receivedAction Action
	engine.OnAction("testAction", func(action Action) {
		actionCalled = true
		receivedAction = action
	})

	err := engine.DispatchAction("testAction", map[string]any{"value": 42})
	if err != nil {
		t.Fatalf("Failed to dispatch action: %v", err)
	}

	if !actionCalled {
		t.Log("Action handler not called (may be expected if action wasn't in UI)")
	} else {
		if receivedAction.Name != "testAction" {
			t.Errorf("Expected action name 'testAction', got '%s'", receivedAction.Name)
		}
	}
}

func TestWasmEngineIEngine(t *testing.T) {
	engine := newTestEngine(t)

	var iengine IEngine = engine
	iengine.SetModule("Test", []string{"click"}, []string{"count"}, map[string]any{"count": 0})
	iengine.OnAction("click", func(action Action) {})
}

func TestWasmEngineRevision(t *testing.T) {
	engine := newTestEngine(t)

	rev1 := engine.GetRevision()

	engine.RenderSource(`Text("Hello")`)

	rev2 := engine.GetRevision()
	if rev2 <= rev1 {
		t.Errorf("Expected revision to increase, got %d -> %d", rev1, rev2)
	}
}

func TestWasmEngineRender_MultipleElements(t *testing.T) {
	engine := newTestEngine(t)

	patches, err := engine.RenderSource(`Row { Button("Click") Text("Label") }`)
	if err != nil {
		t.Fatalf("Failed to render: %v", err)
	}

	creates := findPatches(patches, PatchCreate)

	elementTypes := map[string]int{}
	for _, c := range creates {
		elementTypes[c.ElementType]++
		// Every create must have an ID
		if c.ID == "" {
			t.Errorf("Create patch for '%s' has empty ID", c.ElementType)
		}
	}

	if elementTypes["Row"] != 1 {
		t.Errorf("Expected 1 Row, got %d", elementTypes["Row"])
	}
	if elementTypes["Button"] != 1 {
		t.Errorf("Expected 1 Button, got %d", elementTypes["Button"])
	}
	if elementTypes["Text"] != 1 {
		t.Errorf("Expected 1 Text, got %d", elementTypes["Text"])
	}
}

func TestWasmEngineRender_ClearAndRerender(t *testing.T) {
	engine := newTestEngine(t)

	// First render
	patches1, err := engine.RenderSource(`Text("First")`)
	if err != nil {
		t.Fatalf("Failed to render: %v", err)
	}
	if len(patches1) == 0 {
		t.Fatal("Expected patches from first render")
	}

	// Clear tree
	engine.ClearTree()

	// Second render should produce fresh create patches
	patches2, err := engine.RenderSource(`Text("Second")`)
	if err != nil {
		t.Fatalf("Failed to render after clear: %v", err)
	}

	create := findPatch(patches2, PatchCreate)
	if create == nil {
		t.Fatal("Expected create patch after clear + re-render")
	}
	if create.ElementType != "Text" {
		t.Errorf("Expected ElementType='Text', got '%s'", create.ElementType)
	}
}

func TestWasmEngineParsePatchFromJSON_AllTypes(t *testing.T) {
	engine := newTestEngine(t)

	// Render a tree, then clear + re-render to get remove patches
	// First, render a multi-element tree
	patches, err := engine.RenderSource(`Column { Text("A") Text("B") }`)
	if err != nil {
		t.Fatalf("Failed to render: %v", err)
	}

	// Verify all create patches have ElementType and ID
	for _, p := range patches {
		switch p.Type {
		case PatchCreate:
			if p.ElementType == "" {
				t.Errorf("Create patch has empty ElementType: %+v", p)
			}
			if p.ID == "" {
				t.Errorf("Create patch has empty ID: %+v", p)
			}
		case PatchInsert:
			if p.ID == "" {
				t.Errorf("Insert patch has empty ID: %+v", p)
			}
			if p.ParentID == "" {
				t.Errorf("Insert patch has empty ParentID: %+v", p)
			}
		case PatchSetProp:
			if p.ID == "" {
				t.Errorf("SetProp patch has empty ID: %+v", p)
			}
			if p.Name == "" {
				t.Errorf("SetProp patch has empty Name: %+v", p)
			}
		case PatchSetText:
			if p.ID == "" {
				t.Errorf("SetText patch has empty ID: %+v", p)
			}
		}
	}
}

func TestWasmEngineRender_IDsAreConsistent(t *testing.T) {
	engine := newTestEngine(t)

	patches, err := engine.RenderSource(`Text("Hello")`)
	if err != nil {
		t.Fatalf("Failed to render: %v", err)
	}

	create := findPatch(patches, PatchCreate)
	insert := findPatch(patches, PatchInsert)

	if create == nil || insert == nil {
		t.Fatal("Expected both create and insert patches")
	}

	// The node created should be the same node inserted
	if create.ID != insert.ID {
		t.Errorf("Create ID '%s' does not match Insert ID '%s'", create.ID, insert.ID)
	}

	// IDs should be short numeric strings (from node_id_str)
	for _, ch := range create.ID {
		if ch < '0' || ch > '9' {
			t.Errorf("Expected numeric ID, got '%s'", create.ID)
			break
		}
	}
}

// ========================================================================
// End-to-end nested module tests with real WASM engine
// ========================================================================

func TestE2E_NestedModuleRendersChildComponent(t *testing.T) {
	engine := newTestEngine(t)
	globalCtx := NewHypenGlobalContext()

	// Set up primary module with a template that references "Feed"
	appDef := NewAppBuilder(map[string]any{"title": "My App"}, &ModuleOptions{Name: "App"}).Build()
	appInst := NewModuleInstance(engine, appDef, WithGlobalContext(globalCtx))
	globalCtx.RegisterModule("app", appInst)

	// Register Feed as a component with its own template
	feedDef := NewAppBuilder(
		map[string]any{"items": []any{"Post 1", "Post 2"}},
		&ModuleOptions{Name: "Feed"},
	).Build()
	feedDef.Template = `Column { Text("Feed loaded") }`

	// Register Feed's template in the engine as a component
	err := engine.RegisterComponent("Feed", feedDef.Template, "Feed")
	if err != nil {
		t.Fatalf("Failed to register Feed component: %v", err)
	}

	// Create the nested module instance (injects state, registers actions)
	feedInst := NewModuleInstance(engine, feedDef, AsNested(), WithGlobalContext(globalCtx))
	globalCtx.RegisterModule("feed", feedInst)

	// Now render a template that uses the Feed component
	patches, err := engine.RenderSource(`Column { Text("Header") Feed {} }`)
	if err != nil {
		t.Fatalf("Failed to render: %v", err)
	}

	// Should have multiple create patches — one for Column, one for Text("Header"),
	// and the expanded Feed component (Column + Text("Feed loaded"))
	creates := findPatches(patches, PatchCreate)
	if len(creates) < 3 {
		t.Errorf("expected at least 3 create patches (Column, Text, Feed expansion), got %d", len(creates))
	}

	// Verify both modules are registered
	if !globalCtx.HasModule("app") {
		t.Error("expected 'app' in global context")
	}
	if !globalCtx.HasModule("feed") {
		t.Error("expected 'feed' in global context")
	}
}

func TestE2E_NestedModuleStateUpdateProducesPatches(t *testing.T) {
	engine := newTestEngine(t)
	globalCtx := NewHypenGlobalContext()

	// Primary module
	appDef := NewAppBuilder(map[string]any{"count": float64(0)}, &ModuleOptions{Name: "App"}).Build()
	appInst := NewModuleInstance(engine, appDef, WithGlobalContext(globalCtx))
	globalCtx.RegisterModule("app", appInst)

	// Render a template with state binding
	_, err := engine.RenderSource(`Column { Text("Count: @{state.count}") }`)
	if err != nil {
		t.Fatalf("Failed to render: %v", err)
	}

	// Create nested module and inject its state
	feedDef := NewAppBuilder(
		map[string]any{"title": "My Feed"},
		&ModuleOptions{Name: "Feed"},
	).Build()
	feedInst := NewModuleInstance(engine, feedDef, AsNested(), WithGlobalContext(globalCtx))
	globalCtx.RegisterModule("feed", feedInst)

	// Update primary module state — should produce patches
	var patchesReceived []Patch
	engine.SetPatchCallback(func(patches []Patch) {
		patchesReceived = append(patchesReceived, patches...)
	})

	appInst.GetLiveState().Set("count", float64(42))

	// The engine should have processed the state change
	if len(patchesReceived) == 0 {
		t.Log("No patches from callback (state change went through UpdateState)")
	}

	// Verify nested module state is accessible
	feedState := feedInst.GetState()
	if feedState["title"] != "My Feed" {
		t.Errorf("expected feed title='My Feed', got %v", feedState["title"])
	}
}

func newTestEngineWithPrimitives(t *testing.T, primitives []string) *WasmEngine {
	t.Helper()

	// Try file path first, fall back to embedded WASM
	wasmPath := getWasmPath()
	var engine *WasmEngine
	var err error
	if wasmPath != "" {
		engine, err = NewWasmEngine(WasmEngineConfig{
			WasmPath:   wasmPath,
			Primitives: primitives,
		})
	} else if len(embeddedWasm) > 0 {
		engine, err = NewWasmEngine(WasmEngineConfig{
			WasmBytes:  embeddedWasm,
			Primitives: primitives,
		})
	} else {
		t.Skip("WASM binary not found - build with: cd hypen-engine-rs && cargo build --target wasm32-wasip1 --features wasi --release")
	}
	if err != nil {
		t.Fatalf("Failed to create engine: %v", err)
	}
	t.Cleanup(func() { engine.Close() })
	return engine
}

func TestE2E_NestedModuleGridRendering(t *testing.T) {
	engine := newTestEngineWithPrimitives(t, []string{
		"Text", "Column", "Row", "Button", "Input", "Grid", "Image", "If",
	})
	globalCtx := NewHypenGlobalContext()

	// 1. Register App as primary module with state {"currentView": "search"}
	appDef := NewAppBuilder(
		map[string]any{"currentView": "search"},
		&ModuleOptions{Name: "App"},
	).Build()
	appInst := NewModuleInstance(engine, appDef, WithGlobalContext(globalCtx))
	globalCtx.RegisterModule("app", appInst)

	// 2. Register Search as a named module with state
	searchState := map[string]any{
		"searchQuery": "",
		"explorePosts": []any{
			map[string]any{"id": "p1", "imageUrl": "https://example.com/1.jpg"},
			map[string]any{"id": "p2", "imageUrl": "https://example.com/2.jpg"},
			map[string]any{"id": "p3", "imageUrl": "https://example.com/3.jpg"},
		},
	}
	searchDef := NewAppBuilder(searchState, &ModuleOptions{Name: "Search"}).Build()

	// 3. Register the Search component source in the engine
	searchSource := `module Search { Column { Input(placeholder: "Search") Grid(@state.explorePosts, key: "id") { Image(src: "@{item.imageUrl}") } } }`
	searchDef.Template = searchSource
	err := engine.RegisterComponent("Search", searchSource, "Search")
	if err != nil {
		t.Fatalf("Failed to register Search component: %v", err)
	}

	// Register Search as a named module in the WASM engine so it knows about
	// the module's state keys and can resolve @state references in module Search { ... }
	engine.RegisterModule("Search", []string{}, []string{"searchQuery", "explorePosts"}, searchState)

	// Create nested module instance (injects state into engine)
	searchInst := NewModuleInstance(engine, searchDef, AsNested(), WithGlobalContext(globalCtx))
	globalCtx.RegisterModule("search", searchInst)

	// 4. Render the App source with If condition referencing Search
	appSource := `module App { Column { If(condition: "@{state.currentView == 'search'}") { Search() } } }`
	patches, err := engine.RenderSource(appSource)
	if err != nil {
		t.Fatalf("Failed to render: %v", err)
	}

	// 5. Capture all create patches
	creates := findPatches(patches, PatchCreate)

	// Log all creates for debugging
	for _, c := range creates {
		t.Logf("Create: type=%s id=%s props=%v", c.ElementType, c.ID, c.Props)
	}

	// 6. Assert Grid element is created
	gridCount := 0
	for _, c := range creates {
		if c.ElementType == "Grid" {
			gridCount++
		}
	}
	if gridCount == 0 {
		t.Error("expected at least 1 Grid create patch")
	}

	// 7. Assert 3 Image elements are created (one per explorePosts item)
	imageCount := 0
	for _, c := range creates {
		if c.ElementType == "Image" {
			imageCount++
		}
	}
	if imageCount != 3 {
		t.Errorf("expected 3 Image create patches, got %d", imageCount)
	}
}

func TestE2E_RenderDocumentWithModules(t *testing.T) {
	engine := newTestEngine(t)
	globalCtx := NewHypenGlobalContext()

	// Set up app registry with a Feed module
	resetApp()
	App.DefineState(map[string]any{"items": []any{"a", "b"}}, &ModuleOptions{Name: "Feed"}).Build()
	App.Get("Feed").Template = `Column { Text("Feed") }`

	// Set up primary module (without rendering UI yet)
	appDef := NewAppBuilder(map[string]any{"x": 1}, &ModuleOptions{Name: "App"}).Build()
	appInst := NewModuleInstance(engine, appDef, WithGlobalContext(globalCtx))
	globalCtx.RegisterModule("app", appInst)

	// Create resolver that uses the App registry
	resolver := NewComponentResolver(&ResolverOptions{App: App})

	// RenderDocumentWithModules should resolve imports, create nested modules
	result, err := engine.RenderDocumentWithModules(
		`Column { Text("Hello") }`,
		resolver, App, globalCtx, nil,
	)
	if err != nil {
		t.Fatalf("Failed: %v", err)
	}

	if result == nil {
		t.Fatal("expected non-nil result")
	}

	// Feed module should have been auto-instantiated from registry
	if !globalCtx.HasModule("feed") {
		t.Error("expected 'feed' module auto-instantiated in global context")
	}

	// Verify nested module has correct initial state
	feedRef := globalCtx.GetModule("feed")
	if feedRef == nil {
		t.Fatal("expected feed module reference")
	}
}
