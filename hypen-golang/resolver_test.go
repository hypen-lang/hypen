package core

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestParseImports_DefaultImport(t *testing.T) {
	text := `import HomePage from "./HomePage"`

	imports := ParseImports(text)

	if len(imports) != 1 {
		t.Fatalf("expected 1 import, got %d", len(imports))
	}

	if imports[0].Clause.Type != ImportClauseDefault {
		t.Errorf("expected default import, got %s", imports[0].Clause.Type)
	}

	if imports[0].Clause.Name != "HomePage" {
		t.Errorf("expected name 'HomePage', got %s", imports[0].Clause.Name)
	}

	if imports[0].Source.Type != ImportSourceLocal {
		t.Errorf("expected local source, got %s", imports[0].Source.Type)
	}

	if imports[0].Source.Path != "./HomePage" {
		t.Errorf("expected path './HomePage', got %s", imports[0].Source.Path)
	}
}

func TestParseImports_NamedImport(t *testing.T) {
	text := `import { Button, Card } from "./components"`

	imports := ParseImports(text)

	if len(imports) != 1 {
		t.Fatalf("expected 1 import, got %d", len(imports))
	}

	if imports[0].Clause.Type != ImportClauseNamed {
		t.Errorf("expected named import, got %s", imports[0].Clause.Type)
	}

	if len(imports[0].Clause.Names) != 2 {
		t.Errorf("expected 2 names, got %d", len(imports[0].Clause.Names))
	}

	if imports[0].Clause.Names[0] != "Button" || imports[0].Clause.Names[1] != "Card" {
		t.Errorf("expected ['Button', 'Card'], got %v", imports[0].Clause.Names)
	}
}

func TestParseImports_URLImport(t *testing.T) {
	text := `import Component from "https://example.com/component.json"`

	imports := ParseImports(text)

	if len(imports) != 1 {
		t.Fatalf("expected 1 import, got %d", len(imports))
	}

	if imports[0].Source.Type != ImportSourceURL {
		t.Errorf("expected URL source, got %s", imports[0].Source.Type)
	}

	if imports[0].Source.URL != "https://example.com/component.json" {
		t.Errorf("expected URL 'https://example.com/component.json', got %s", imports[0].Source.URL)
	}
}

func TestParseImports_MultipleImports(t *testing.T) {
	text := `
import HomePage from "./HomePage"
import { Button, Card } from "./components"
import RemoteWidget from "https://cdn.example.com/widget.json"
`

	imports := ParseImports(text)

	if len(imports) != 3 {
		t.Fatalf("expected 3 imports, got %d", len(imports))
	}

	// Check first import
	if imports[0].Clause.Name != "HomePage" {
		t.Errorf("expected 'HomePage', got %s", imports[0].Clause.Name)
	}

	// Check second import
	if len(imports[1].Clause.Names) != 2 {
		t.Errorf("expected 2 named imports, got %d", len(imports[1].Clause.Names))
	}

	// Check third import
	if imports[2].Source.Type != ImportSourceURL {
		t.Errorf("expected URL source for third import")
	}
}

func TestParseImports_SingleQuotes(t *testing.T) {
	text := `import Button from './Button'`

	imports := ParseImports(text)

	if len(imports) != 1 {
		t.Fatalf("expected 1 import, got %d", len(imports))
	}

	if imports[0].Source.Path != "./Button" {
		t.Errorf("expected './Button', got %s", imports[0].Source.Path)
	}
}

func TestParseImports_EmptyText(t *testing.T) {
	imports := ParseImports("")

	if len(imports) != 0 {
		t.Errorf("expected 0 imports, got %d", len(imports))
	}
}

func TestParseImports_NoImports(t *testing.T) {
	text := `Column { Text("Hello") }`

	imports := ParseImports(text)

	if len(imports) != 0 {
		t.Errorf("expected 0 imports, got %d", len(imports))
	}
}

func TestRemoveImports(t *testing.T) {
	text := `import Button from "./Button"
import { Card } from "./components"

Column {
    Button("Click me")
}`

	result := RemoveImports(text)

	// Should not contain import statements
	if len(ParseImports(result)) != 0 {
		t.Error("expected all imports to be removed")
	}

	// Should still contain the component usage
	if !containsString(result, "Column") {
		t.Error("expected 'Column' to remain in text")
	}
}

func TestNewComponentResolver(t *testing.T) {
	resolver := NewComponentResolver(nil)

	if resolver == nil {
		t.Fatal("expected non-nil resolver")
	}

	if resolver.options.BaseDir != "." {
		t.Errorf("expected default baseDir '.', got %s", resolver.options.BaseDir)
	}

	if !resolver.options.Cache {
		t.Error("expected cache to be enabled by default")
	}
}

func TestNewComponentResolver_WithOptions(t *testing.T) {
	resolver := NewComponentResolver(&ResolverOptions{
		BaseDir: "/custom/path",
		Cache:   false,
	})

	if resolver.options.BaseDir != "/custom/path" {
		t.Errorf("expected baseDir '/custom/path', got %s", resolver.options.BaseDir)
	}

	if resolver.options.Cache {
		t.Error("expected cache to be disabled")
	}
}

func TestComponentResolver_ResolveURL(t *testing.T) {
	// Create a test server
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		component := map[string]any{
			"module": map[string]any{
				"state": map[string]any{"count": 0},
			},
			"template": "Text(\"Count: @{state.count}\")",
		}
		json.NewEncoder(w).Encode(component)
	}))
	defer server.Close()

	resolver := NewComponentResolver(nil)

	stmt := ImportStatement{
		Clause: ImportClause{
			Type: ImportClauseDefault,
			Name: "Counter",
		},
		Source: ImportSource{
			Type: ImportSourceURL,
			URL:  server.URL,
		},
	}

	components, err := resolver.Resolve(stmt)
	if err != nil {
		t.Fatalf("failed to resolve: %v", err)
	}

	if len(components) != 1 {
		t.Fatalf("expected 1 component, got %d", len(components))
	}

	counter, ok := components["Counter"]
	if !ok {
		t.Fatal("expected 'Counter' component")
	}

	if counter.Template != "Text(\"Count: @{state.count}\")" {
		t.Errorf("unexpected template: %s", counter.Template)
	}
}

func TestComponentResolver_CacheHit(t *testing.T) {
	fetchCount := 0

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fetchCount++
		component := map[string]any{
			"module":   map[string]any{},
			"template": "Text(\"Hello\")",
		}
		json.NewEncoder(w).Encode(component)
	}))
	defer server.Close()

	resolver := NewComponentResolver(nil)

	stmt := ImportStatement{
		Clause: ImportClause{Type: ImportClauseDefault, Name: "Test"},
		Source: ImportSource{Type: ImportSourceURL, URL: server.URL},
	}

	// First resolve
	_, err := resolver.Resolve(stmt)
	if err != nil {
		t.Fatalf("first resolve failed: %v", err)
	}

	// Second resolve (should hit cache)
	_, err = resolver.Resolve(stmt)
	if err != nil {
		t.Fatalf("second resolve failed: %v", err)
	}

	// Should only fetch once
	if fetchCount != 1 {
		t.Errorf("expected 1 fetch, got %d", fetchCount)
	}
}

func TestComponentResolver_CacheDisabled(t *testing.T) {
	fetchCount := 0

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fetchCount++
		component := map[string]any{
			"module":   map[string]any{},
			"template": "Text(\"Hello\")",
		}
		json.NewEncoder(w).Encode(component)
	}))
	defer server.Close()

	resolver := NewComponentResolver(&ResolverOptions{Cache: false})

	stmt := ImportStatement{
		Clause: ImportClause{Type: ImportClauseDefault, Name: "Test"},
		Source: ImportSource{Type: ImportSourceURL, URL: server.URL},
	}

	// First resolve
	_, _ = resolver.Resolve(stmt)

	// Second resolve (should NOT hit cache)
	_, _ = resolver.Resolve(stmt)

	// Should fetch twice
	if fetchCount != 2 {
		t.Errorf("expected 2 fetches, got %d", fetchCount)
	}
}

func TestComponentResolver_ClearCache(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		component := map[string]any{
			"module":   map[string]any{},
			"template": "Text(\"Hello\")",
		}
		json.NewEncoder(w).Encode(component)
	}))
	defer server.Close()

	resolver := NewComponentResolver(nil)

	stmt := ImportStatement{
		Clause: ImportClause{Type: ImportClauseDefault, Name: "Test"},
		Source: ImportSource{Type: ImportSourceURL, URL: server.URL},
	}

	resolver.Resolve(stmt)

	if resolver.GetCacheSize() != 1 {
		t.Errorf("expected cache size 1, got %d", resolver.GetCacheSize())
	}

	resolver.ClearCache()

	if resolver.GetCacheSize() != 0 {
		t.Errorf("expected cache size 0 after clear, got %d", resolver.GetCacheSize())
	}
}

func TestComponentResolver_CustomFetch(t *testing.T) {
	customFetchCalled := false

	resolver := NewComponentResolver(&ResolverOptions{
		CustomFetch: func(url string) (string, error) {
			customFetchCalled = true
			return `{"module": {}, "template": "Custom"}`, nil
		},
	})

	stmt := ImportStatement{
		Clause: ImportClause{Type: ImportClauseDefault, Name: "Test"},
		Source: ImportSource{Type: ImportSourceURL, URL: "https://example.com/test"},
	}

	components, err := resolver.Resolve(stmt)
	if err != nil {
		t.Fatalf("resolve failed: %v", err)
	}

	if !customFetchCalled {
		t.Error("expected custom fetch to be called")
	}

	if components["Test"].Template != "Custom" {
		t.Errorf("expected template 'Custom', got %s", components["Test"].Template)
	}
}

func TestComponentResolver_ResolveLocal_NotImplemented(t *testing.T) {
	resolver := NewComponentResolver(nil)

	stmt := ImportStatement{
		Clause: ImportClause{Type: ImportClauseDefault, Name: "Local"},
		Source: ImportSource{Type: ImportSourceLocal, Path: "./local"},
	}

	_, err := resolver.Resolve(stmt)
	if err == nil {
		t.Error("expected error for local resolution")
	}
}

func TestComponentResolver_NamedImports(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		component := map[string]any{
			"module":   map[string]any{},
			"template": "Text(\"Shared\")",
		}
		json.NewEncoder(w).Encode(component)
	}))
	defer server.Close()

	resolver := NewComponentResolver(nil)

	stmt := ImportStatement{
		Clause: ImportClause{
			Type:  ImportClauseNamed,
			Names: []string{"Button", "Card"},
		},
		Source: ImportSource{Type: ImportSourceURL, URL: server.URL},
	}

	components, err := resolver.Resolve(stmt)
	if err != nil {
		t.Fatalf("resolve failed: %v", err)
	}

	if len(components) != 2 {
		t.Errorf("expected 2 components, got %d", len(components))
	}

	if _, ok := components["Button"]; !ok {
		t.Error("expected 'Button' component")
	}

	if _, ok := components["Card"]; !ok {
		t.Error("expected 'Card' component")
	}
}

func TestComponentResolver_InvalidJSON(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("invalid json"))
	}))
	defer server.Close()

	resolver := NewComponentResolver(nil)

	stmt := ImportStatement{
		Clause: ImportClause{Type: ImportClauseDefault, Name: "Test"},
		Source: ImportSource{Type: ImportSourceURL, URL: server.URL},
	}

	_, err := resolver.Resolve(stmt)
	if err == nil {
		t.Error("expected error for invalid JSON")
	}
}

func TestComponentResolver_MissingTemplate(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"module": map[string]any{},
			// Missing template
		})
	}))
	defer server.Close()

	resolver := NewComponentResolver(nil)

	stmt := ImportStatement{
		Clause: ImportClause{Type: ImportClauseDefault, Name: "Test"},
		Source: ImportSource{Type: ImportSourceURL, URL: server.URL},
	}

	_, err := resolver.Resolve(stmt)
	if err == nil {
		t.Error("expected error for missing template")
	}
}

func TestComponentResolver_HTTPError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()

	resolver := NewComponentResolver(nil)

	stmt := ImportStatement{
		Clause: ImportClause{Type: ImportClauseDefault, Name: "Test"},
		Source: ImportSource{Type: ImportSourceURL, URL: server.URL},
	}

	_, err := resolver.Resolve(stmt)
	if err == nil {
		t.Error("expected error for HTTP 404")
	}
}

// Helper function
func containsString(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(s) > 0 && containsString(s[1:], substr) || s[:len(substr)] == substr)
}
