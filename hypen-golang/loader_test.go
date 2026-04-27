package core

import (
	"os"
	"path/filepath"
	"testing"
)

func TestComponentLoader_RegistersComponent(t *testing.T) {
	loader := NewComponentLoader()

	module := App.DefineState(map[string]any{"count": float64(0)}, &ModuleOptions{Name: "Counter"}).Build()
	template := "Text('Hello')"

	loader.Register("Counter", module, template, "")

	if !loader.Has("Counter") {
		t.Error("expected component to be registered")
	}

	comp := loader.Get("Counter")
	if comp == nil {
		t.Fatal("expected component to be returned")
	}

	if comp.Name != "Counter" {
		t.Errorf("expected name 'Counter', got %s", comp.Name)
	}
	if comp.Template != template {
		t.Errorf("expected template %s, got %s", template, comp.Template)
	}
	if comp.Path != "Counter" {
		t.Errorf("expected path 'Counter', got %s", comp.Path)
	}
}

func TestComponentLoader_RegistersWithCustomPath(t *testing.T) {
	loader := NewComponentLoader()

	module := App.DefineState(map[string]any{}, &ModuleOptions{Name: "Button"}).Build()
	template := "Text('Click')"

	loader.Register("Button", module, template, "./components/Button")

	comp := loader.Get("Button")
	if comp.Path != "./components/Button" {
		t.Errorf("expected path './components/Button', got %s", comp.Path)
	}
}

func TestComponentLoader_OverwritesExistingComponent(t *testing.T) {
	loader := NewComponentLoader()

	module1 := App.DefineState(map[string]any{"version": float64(1)}, &ModuleOptions{Name: "Test"}).Build()
	module2 := App.DefineState(map[string]any{"version": float64(2)}, &ModuleOptions{Name: "Test"}).Build()

	loader.Register("Test", module1, "Version 1", "")
	loader.Register("Test", module2, "Version 2", "")

	comp := loader.Get("Test")
	if comp.Template != "Version 2" {
		t.Errorf("expected template 'Version 2', got %s", comp.Template)
	}
}

func TestComponentLoader_GetReturnsNilForNonExistent(t *testing.T) {
	loader := NewComponentLoader()

	comp := loader.Get("NonExistent")
	if comp != nil {
		t.Error("expected nil for non-existent component")
	}
}

func TestComponentLoader_HasReturnsFalseForNonExistent(t *testing.T) {
	loader := NewComponentLoader()

	if loader.Has("NonExistent") {
		t.Error("expected Has to return false")
	}
}

func TestComponentLoader_GetNamesReturnsEmptyWhenNoComponents(t *testing.T) {
	loader := NewComponentLoader()

	names := loader.GetNames()
	if len(names) != 0 {
		t.Errorf("expected empty array, got %v", names)
	}
}

func TestComponentLoader_GetNamesReturnsAllNames(t *testing.T) {
	loader := NewComponentLoader()

	module := App.DefineState(map[string]any{}, nil).Build()

	loader.Register("Button", module, "Button template", "")
	loader.Register("Card", module, "Card template", "")
	loader.Register("Avatar", module, "Avatar template", "")

	names := loader.GetNames()
	if len(names) != 3 {
		t.Errorf("expected 3 names, got %d", len(names))
	}

	hasButton := false
	hasCard := false
	hasAvatar := false
	for _, n := range names {
		if n == "Button" {
			hasButton = true
		}
		if n == "Card" {
			hasCard = true
		}
		if n == "Avatar" {
			hasAvatar = true
		}
	}

	if !hasButton || !hasCard || !hasAvatar {
		t.Errorf("expected Button, Card, Avatar in names, got %v", names)
	}
}

func TestComponentLoader_GetAllReturnsAllComponents(t *testing.T) {
	loader := NewComponentLoader()

	module := App.DefineState(map[string]any{}, nil).Build()

	loader.Register("A", module, "A", "")
	loader.Register("B", module, "B", "")
	loader.Register("C", module, "C", "")

	all := loader.GetAll()
	if len(all) != 3 {
		t.Errorf("expected 3 components, got %d", len(all))
	}
}

func TestComponentLoader_ClearRemovesAllComponents(t *testing.T) {
	loader := NewComponentLoader()

	module := App.DefineState(map[string]any{}, nil).Build()

	loader.Register("A", module, "A", "")
	loader.Register("B", module, "B", "")

	loader.Clear()

	if len(loader.GetNames()) != 0 {
		t.Error("expected no components after clear")
	}
}

func TestComponentLoader_LoadFromDirectory_ThrowsForNonExistent(t *testing.T) {
	loader := NewComponentLoader()

	err := loader.LoadFromDirectory("Test", "/non/existent/path")
	if err == nil {
		t.Error("expected error for non-existent directory")
	}
}

func TestComponentLoader_LoadFromComponentsDir_HandlesNonExistentGracefully(t *testing.T) {
	loader := NewComponentLoader()

	err := loader.LoadFromComponentsDir("/non/existent/directory")
	if err != nil {
		t.Errorf("expected no error, got %v", err)
	}
}

func TestComponentLoader_LoadFromComponentsDir_HandlesEmptyDirectory(t *testing.T) {
	// Create a temporary empty directory
	tmpDir, err := os.MkdirTemp("", "hypen-test-empty-")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	loader := NewComponentLoader()
	err = loader.LoadFromComponentsDir(tmpDir)
	if err != nil {
		t.Errorf("expected no error, got %v", err)
	}

	if len(loader.GetNames()) != 0 {
		t.Error("expected no components")
	}
}

func TestComponentLoader_LoadFromDirectory_LoadsTemplate(t *testing.T) {
	// Create a temporary directory with a component
	tmpDir, err := os.MkdirTemp("", "hypen-test-component-")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	// Create component.hypen file
	templateContent := "Text('Hello World')"
	err = os.WriteFile(filepath.Join(tmpDir, "component.hypen"), []byte(templateContent), 0644)
	if err != nil {
		t.Fatalf("failed to write template: %v", err)
	}

	loader := NewComponentLoader()
	err = loader.LoadFromDirectory("TestComponent", tmpDir)
	if err != nil {
		t.Errorf("expected no error, got %v", err)
	}

	comp := loader.Get("TestComponent")
	if comp == nil {
		t.Fatal("expected component to be loaded")
	}

	if comp.Template != templateContent {
		t.Errorf("expected template '%s', got '%s'", templateContent, comp.Template)
	}
}

func TestComponentLoader_RegisterWithModule(t *testing.T) {
	loader := NewComponentLoader()

	module := App.DefineState(map[string]any{"count": float64(0)}, &ModuleOptions{Name: "Counter"}).Build()
	template := "Text(@state.count)"

	loader.RegisterWithModule("Counter", module, template)

	comp := loader.Get("Counter")
	if comp == nil {
		t.Fatal("expected component to be registered")
	}

	if comp.Module != module {
		t.Error("expected module to be set")
	}
	if comp.Path != "Counter" {
		t.Errorf("expected path 'Counter', got %s", comp.Path)
	}
}

func TestComponentLoader_ComponentsMaintainSeparateState(t *testing.T) {
	loader := NewComponentLoader()

	module1 := App.DefineState(map[string]any{"value": float64(1)}, &ModuleOptions{Name: "Component1"}).Build()
	module2 := App.DefineState(map[string]any{"value": float64(2)}, &ModuleOptions{Name: "Component2"}).Build()

	loader.Register("Component1", module1, "Template1", "")
	loader.Register("Component2", module2, "Template2", "")

	comp1 := loader.Get("Component1")
	comp2 := loader.Get("Component2")

	if comp1.Module.InitialState["value"] != float64(1) {
		t.Errorf("expected comp1 value=1, got %v", comp1.Module.InitialState["value"])
	}
	if comp2.Module.InitialState["value"] != float64(2) {
		t.Errorf("expected comp2 value=2, got %v", comp2.Module.InitialState["value"])
	}
}

func TestComponentLoader_HandlesEmptyTemplates(t *testing.T) {
	loader := NewComponentLoader()

	module := App.DefineState(map[string]any{}, &ModuleOptions{Name: "Empty"}).Build()

	loader.Register("Empty", module, "", "")

	comp := loader.Get("Empty")
	if comp.Template != "" {
		t.Errorf("expected empty template, got '%s'", comp.Template)
	}
}

func TestComponentLoader_HandlesSpecialCharactersInNames(t *testing.T) {
	loader := NewComponentLoader()

	module := App.DefineState(map[string]any{}, &ModuleOptions{Name: "Test"}).Build()

	specialNames := []string{
		"Button-Primary",
		"Card_Featured",
		"Avatar.Large",
		"Form/Input",
	}

	for _, name := range specialNames {
		loader.Register(name, module, "Template", "")
		if !loader.Has(name) {
			t.Errorf("expected component '%s' to be registered", name)
		}
	}

	if len(loader.GetNames()) != len(specialNames) {
		t.Errorf("expected %d components, got %d", len(specialNames), len(loader.GetNames()))
	}
}

func TestComponentLoader_HandlesVeryLongNames(t *testing.T) {
	loader := NewComponentLoader()

	module := App.DefineState(map[string]any{}, &ModuleOptions{Name: "Test"}).Build()

	longName := ""
	for i := 0; i < 1000; i++ {
		longName += "A"
	}

	loader.Register(longName, module, "Template", "")

	if !loader.Has(longName) {
		t.Error("expected long-named component to be registered")
	}

	comp := loader.Get(longName)
	if comp.Name != longName {
		t.Error("expected component name to match")
	}
}

func TestComponentLoader_HandlesVeryLongTemplates(t *testing.T) {
	loader := NewComponentLoader()

	module := App.DefineState(map[string]any{}, &ModuleOptions{Name: "Test"}).Build()

	longTemplate := ""
	for i := 0; i < 10000; i++ {
		longTemplate += "Text('Hello')"
	}

	loader.Register("Test", module, longTemplate, "")

	comp := loader.Get("Test")
	if comp.Template != longTemplate {
		t.Error("expected template to be preserved")
	}
}

func TestComponentLoaderInstance_IsGlobal(t *testing.T) {
	if ComponentLoaderInstance == nil {
		t.Error("expected global ComponentLoaderInstance to exist")
	}
}
