package core

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestDiscoverComponents_EmptyDirectory(t *testing.T) {
	tmpDir := t.TempDir()

	components, err := DiscoverComponents(tmpDir, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if len(components) != 0 {
		t.Errorf("expected 0 components, got %d", len(components))
	}
}

func TestDiscoverComponents_SiblingPattern(t *testing.T) {
	tmpDir := t.TempDir()

	// Create Button.hypen
	hypenPath := filepath.Join(tmpDir, "Button.hypen")
	os.WriteFile(hypenPath, []byte(`Text("Click me")`), 0644)

	components, err := DiscoverComponents(tmpDir, &DiscoveryOptions{
		Patterns: []DiscoveryPattern{PatternSibling},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if len(components) != 1 {
		t.Fatalf("expected 1 component, got %d", len(components))
	}

	if components[0].Name != "Button" {
		t.Errorf("expected name 'Button', got %s", components[0].Name)
	}

	if components[0].HasModule {
		t.Error("expected HasModule to be false")
	}
}

func TestDiscoverComponents_SiblingPatternWithModule(t *testing.T) {
	tmpDir := t.TempDir()

	// Create Button.hypen and Button.go
	os.WriteFile(filepath.Join(tmpDir, "Button.hypen"), []byte(`Text("Click")`), 0644)
	os.WriteFile(filepath.Join(tmpDir, "Button.go"), []byte(`package main`), 0644)

	components, err := DiscoverComponents(tmpDir, &DiscoveryOptions{
		Patterns: []DiscoveryPattern{PatternSibling},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if len(components) != 1 {
		t.Fatalf("expected 1 component, got %d", len(components))
	}

	if !components[0].HasModule {
		t.Error("expected HasModule to be true")
	}

	if components[0].ModulePath == "" {
		t.Error("expected ModulePath to be set")
	}
}

func TestDiscoverComponents_FolderPattern(t *testing.T) {
	tmpDir := t.TempDir()

	// Create Button/component.hypen
	buttonDir := filepath.Join(tmpDir, "Button")
	os.Mkdir(buttonDir, 0755)
	os.WriteFile(filepath.Join(buttonDir, "component.hypen"), []byte(`Text("Button")`), 0644)

	components, err := DiscoverComponents(tmpDir, &DiscoveryOptions{
		Patterns: []DiscoveryPattern{PatternFolder},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if len(components) != 1 {
		t.Fatalf("expected 1 component, got %d", len(components))
	}

	if components[0].Name != "Button" {
		t.Errorf("expected name 'Button', got %s", components[0].Name)
	}
}

func TestDiscoverComponents_IndexPattern(t *testing.T) {
	tmpDir := t.TempDir()

	// Create Card/index.hypen
	cardDir := filepath.Join(tmpDir, "Card")
	os.Mkdir(cardDir, 0755)
	os.WriteFile(filepath.Join(cardDir, "index.hypen"), []byte(`Column { Text("Card") }`), 0644)

	components, err := DiscoverComponents(tmpDir, &DiscoveryOptions{
		Patterns: []DiscoveryPattern{PatternIndex},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if len(components) != 1 {
		t.Fatalf("expected 1 component, got %d", len(components))
	}

	if components[0].Name != "Card" {
		t.Errorf("expected name 'Card', got %s", components[0].Name)
	}
}

func TestDiscoverComponents_PreservesImports(t *testing.T) {
	tmpDir := t.TempDir()

	template := `import { Icon } from "./icons"

Column {
    Icon("home")
    Text("Home")
}`
	os.WriteFile(filepath.Join(tmpDir, "Home.hypen"), []byte(template), 0644)

	components, err := DiscoverComponents(tmpDir, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if len(components) != 1 {
		t.Fatalf("expected 1 component, got %d", len(components))
	}

	// Template should preserve imports (engine processes them via parse_document)
	if !strings.Contains(components[0].Template, "import") {
		t.Error("expected imports to be preserved in template")
	}

	// Should still contain the component content
	if !strings.Contains(components[0].Template, "Column") {
		t.Error("expected 'Column' to remain in template")
	}
}

func TestDiscoverComponents_Recursive(t *testing.T) {
	tmpDir := t.TempDir()

	// Create nested structure
	subDir := filepath.Join(tmpDir, "subdir")
	os.Mkdir(subDir, 0755)
	os.WriteFile(filepath.Join(tmpDir, "Top.hypen"), []byte(`Text("Top")`), 0644)
	os.WriteFile(filepath.Join(subDir, "Nested.hypen"), []byte(`Text("Nested")`), 0644)

	// Without recursive
	components, err := DiscoverComponents(tmpDir, &DiscoveryOptions{Recursive: false})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if len(components) != 1 {
		t.Errorf("expected 1 component without recursion, got %d", len(components))
	}

	// With recursive
	components, err = DiscoverComponents(tmpDir, &DiscoveryOptions{Recursive: true})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if len(components) != 2 {
		t.Errorf("expected 2 components with recursion, got %d", len(components))
	}
}

func TestDiscoverComponents_SkipsDuplicates(t *testing.T) {
	tmpDir := t.TempDir()

	// Create both sibling and folder versions
	os.WriteFile(filepath.Join(tmpDir, "Button.hypen"), []byte(`Text("Sibling")`), 0644)

	buttonDir := filepath.Join(tmpDir, "Button")
	os.Mkdir(buttonDir, 0755)
	os.WriteFile(filepath.Join(buttonDir, "component.hypen"), []byte(`Text("Folder")`), 0644)

	components, err := DiscoverComponents(tmpDir, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Should only have one Button
	buttonCount := 0
	for _, c := range components {
		if c.Name == "Button" {
			buttonCount++
		}
	}

	if buttonCount != 1 {
		t.Errorf("expected 1 Button component (deduped), got %d", buttonCount)
	}
}

func TestDiscoverComponents_IgnoresComponentAndIndex(t *testing.T) {
	tmpDir := t.TempDir()

	// Create component.hypen and index.hypen at root (not in folders)
	os.WriteFile(filepath.Join(tmpDir, "component.hypen"), []byte(`Text("Root component")`), 0644)
	os.WriteFile(filepath.Join(tmpDir, "index.hypen"), []byte(`Text("Root index")`), 0644)
	os.WriteFile(filepath.Join(tmpDir, "Regular.hypen"), []byte(`Text("Regular")`), 0644)

	components, err := DiscoverComponents(tmpDir, &DiscoveryOptions{
		Patterns: []DiscoveryPattern{PatternSibling},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Should only find Regular, not component or index
	if len(components) != 1 {
		t.Errorf("expected 1 component, got %d", len(components))
	}

	if len(components) > 0 && components[0].Name != "Regular" {
		t.Errorf("expected 'Regular', got %s", components[0].Name)
	}
}

func TestDiscoverComponents_NonExistentDirectory(t *testing.T) {
	_, err := DiscoverComponents("/non/existent/path", nil)
	if err == nil {
		t.Error("expected error for non-existent directory")
	}
}

func TestLoadDiscoveredComponents(t *testing.T) {
	loader := NewComponentLoader()

	components := []DiscoveredComponent{
		{Name: "Button", Template: `Text("Click")`, HasModule: false},
		{Name: "Card", Template: `Column { Text("Card") }`, HasModule: true},
	}

	LoadDiscoveredComponents(components, loader)

	if !loader.Has("Button") {
		t.Error("expected Button to be registered")
	}

	if !loader.Has("Card") {
		t.Error("expected Card to be registered")
	}

	button := loader.Get("Button")
	if button.Template != `Text("Click")` {
		t.Errorf("unexpected template: %s", button.Template)
	}
}

func TestComponentWatcher_Creation(t *testing.T) {
	tmpDir := t.TempDir()

	watcher := WatchComponents(tmpDir, nil)

	if watcher == nil {
		t.Fatal("expected non-nil watcher")
	}

	if watcher.baseDir != tmpDir {
		t.Errorf("expected baseDir %s, got %s", tmpDir, watcher.baseDir)
	}
}

func TestComponentWatcher_StartStop(t *testing.T) {
	tmpDir := t.TempDir()

	watcher := WatchComponents(tmpDir, &WatchOptions{
		PollInterval: 50 * time.Millisecond,
	})

	watcher.Start()

	// Give it a moment to do initial scan
	time.Sleep(100 * time.Millisecond)

	watcher.Stop()

	// Should be able to stop multiple times without panic
	watcher.Stop()
}

func TestComponentWatcher_DetectsNewComponent(t *testing.T) {
	tmpDir := t.TempDir()

	var mu sync.Mutex
	added := []string{}

	watcher := WatchComponents(tmpDir, &WatchOptions{
		PollInterval: 50 * time.Millisecond,
		OnAdd: func(component DiscoveredComponent) {
			mu.Lock()
			added = append(added, component.Name)
			mu.Unlock()
		},
	})

	watcher.Start()
	defer watcher.Stop()

	// Wait for initial scan
	time.Sleep(100 * time.Millisecond)

	// Add a new component
	os.WriteFile(filepath.Join(tmpDir, "New.hypen"), []byte(`Text("New")`), 0644)

	// Wait for detection
	time.Sleep(200 * time.Millisecond)

	mu.Lock()
	if len(added) != 1 || added[0] != "New" {
		t.Errorf("expected ['New'], got %v", added)
	}
	mu.Unlock()
}

func TestComponentWatcher_DetectsRemovedComponent(t *testing.T) {
	tmpDir := t.TempDir()

	// Create initial component
	hypenPath := filepath.Join(tmpDir, "Old.hypen")
	os.WriteFile(hypenPath, []byte(`Text("Old")`), 0644)

	var mu sync.Mutex
	removed := []string{}

	watcher := WatchComponents(tmpDir, &WatchOptions{
		PollInterval: 50 * time.Millisecond,
		OnRemove: func(name string) {
			mu.Lock()
			removed = append(removed, name)
			mu.Unlock()
		},
	})

	watcher.Start()
	defer watcher.Stop()

	// Wait for initial scan
	time.Sleep(100 * time.Millisecond)

	// Remove the component
	os.Remove(hypenPath)

	// Wait for detection
	time.Sleep(200 * time.Millisecond)

	mu.Lock()
	if len(removed) != 1 || removed[0] != "Old" {
		t.Errorf("expected ['Old'], got %v", removed)
	}
	mu.Unlock()
}

func TestComponentWatcher_DetectsUpdatedComponent(t *testing.T) {
	tmpDir := t.TempDir()

	// Create initial component
	hypenPath := filepath.Join(tmpDir, "Updating.hypen")
	os.WriteFile(hypenPath, []byte(`Text("Original")`), 0644)

	var mu sync.Mutex
	updated := []string{}

	watcher := WatchComponents(tmpDir, &WatchOptions{
		PollInterval: 50 * time.Millisecond,
		OnUpdate: func(component DiscoveredComponent) {
			mu.Lock()
			updated = append(updated, component.Name)
			mu.Unlock()
		},
	})

	watcher.Start()
	defer watcher.Stop()

	// Wait for initial scan
	time.Sleep(200 * time.Millisecond)

	// Update the component
	os.WriteFile(hypenPath, []byte(`Text("Modified")`), 0644)

	// Poll until the update callback fires (up to 3s)
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		done := len(updated) >= 1
		mu.Unlock()
		if done {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}

	mu.Lock()
	if len(updated) != 1 || updated[0] != "Updating" {
		t.Errorf("expected ['Updating'], got %v", updated)
	}
	mu.Unlock()
}

func TestComponentWatcher_GetComponents(t *testing.T) {
	tmpDir := t.TempDir()

	os.WriteFile(filepath.Join(tmpDir, "A.hypen"), []byte(`Text("A")`), 0644)
	os.WriteFile(filepath.Join(tmpDir, "B.hypen"), []byte(`Text("B")`), 0644)

	watcher := WatchComponents(tmpDir, &WatchOptions{
		PollInterval: 50 * time.Millisecond,
	})

	watcher.Start()
	defer watcher.Stop()

	// Wait for initial scan
	time.Sleep(100 * time.Millisecond)

	components := watcher.GetComponents()
	if len(components) != 2 {
		t.Errorf("expected 2 components, got %d", len(components))
	}
}

func TestGenerateComponentsCode(t *testing.T) {
	tmpDir := t.TempDir()

	os.WriteFile(filepath.Join(tmpDir, "Button.hypen"), []byte(`Text("Click")`), 0644)
	os.WriteFile(filepath.Join(tmpDir, "Card.hypen"), []byte(`Column { Text("Card") }`), 0644)

	code, err := GenerateComponentsCode(tmpDir, "components", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if !strings.Contains(code, "package components") {
		t.Error("expected package declaration")
	}

	if !strings.Contains(code, "var Button") {
		t.Error("expected Button variable")
	}

	if !strings.Contains(code, "var Card") {
		t.Error("expected Card variable")
	}

	if !strings.Contains(code, "RegisterComponents") {
		t.Error("expected RegisterComponents function")
	}
}

func TestGenerateComponentsCode_EmptyDirectory(t *testing.T) {
	tmpDir := t.TempDir()

	code, err := GenerateComponentsCode(tmpDir, "empty", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if !strings.Contains(code, "package empty") {
		t.Error("expected package declaration")
	}

	// Should still have RegisterComponents function
	if !strings.Contains(code, "RegisterComponents") {
		t.Error("expected RegisterComponents function")
	}
}

func TestDefaultDiscoveryOptions(t *testing.T) {
	opts := DefaultDiscoveryOptions()

	if len(opts.Patterns) != 3 {
		t.Errorf("expected 3 default patterns, got %d", len(opts.Patterns))
	}

	if opts.Recursive {
		t.Error("expected Recursive to be false by default")
	}

	if opts.Debug {
		t.Error("expected Debug to be false by default")
	}
}
