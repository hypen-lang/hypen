package core

import (
	"os"
	"path/filepath"
	"testing"
)

// ============================================================================
// A. ImportInfo Conversion Tests (4 tests)
// ============================================================================

func TestImportInfoToStatement_Local(t *testing.T) {
	info := ImportInfo{
		Names:      []string{"Button", "Card"},
		SourcePath: "./components/ui",
		SourceType: "local",
	}

	stmt := importInfoToStatement(info)

	if stmt.Clause.Type != ImportClauseNamed {
		t.Errorf("expected named import, got %s", stmt.Clause.Type)
	}
	if len(stmt.Clause.Names) != 2 {
		t.Fatalf("expected 2 names, got %d", len(stmt.Clause.Names))
	}
	if stmt.Clause.Names[0] != "Button" || stmt.Clause.Names[1] != "Card" {
		t.Errorf("expected [Button, Card], got %v", stmt.Clause.Names)
	}
	if stmt.Source.Type != ImportSourceLocal {
		t.Errorf("expected local source, got %s", stmt.Source.Type)
	}
	if stmt.Source.Path != "./components/ui" {
		t.Errorf("expected './components/ui', got %s", stmt.Source.Path)
	}
}

func TestImportInfoToStatement_URL(t *testing.T) {
	info := ImportInfo{
		Names:      []string{"Widget"},
		SourcePath: "https://cdn.example.com/widgets",
		SourceType: "url",
	}

	stmt := importInfoToStatement(info)

	if stmt.Source.Type != ImportSourceURL {
		t.Errorf("expected URL source, got %s", stmt.Source.Type)
	}
	if stmt.Source.URL != "https://cdn.example.com/widgets" {
		t.Errorf("expected URL, got %s", stmt.Source.URL)
	}
}

func TestImportInfoToStatement_SingleName(t *testing.T) {
	info := ImportInfo{
		Names:      []string{"HomePage"},
		SourcePath: "./pages/home",
		SourceType: "local",
	}

	stmt := importInfoToStatement(info)

	if len(stmt.Clause.Names) != 1 {
		t.Fatalf("expected 1 name, got %d", len(stmt.Clause.Names))
	}
	if stmt.Clause.Names[0] != "HomePage" {
		t.Errorf("expected 'HomePage', got %s", stmt.Clause.Names[0])
	}
}

func TestImportInfoToStatement_ManyNames(t *testing.T) {
	info := ImportInfo{
		Names:      []string{"A", "B", "C", "D", "E"},
		SourcePath: "./widgets",
		SourceType: "local",
	}

	stmt := importInfoToStatement(info)

	if len(stmt.Clause.Names) != 5 {
		t.Errorf("expected 5 names, got %d", len(stmt.Clause.Names))
	}
}

// ============================================================================
// B. Local Resolver Tests (5 tests)
// ============================================================================

func TestResolveLocal_HypenFile(t *testing.T) {
	// Create a temporary directory with a .hypen file
	dir := t.TempDir()
	hypenContent := `Text("Hello from Button")`
	os.WriteFile(filepath.Join(dir, "Button.hypen"), []byte(hypenContent), 0644)

	resolver := NewComponentResolver(&ResolverOptions{
		BaseDir: dir,
	})

	stmt := ImportStatement{
		Clause: ImportClause{Type: ImportClauseDefault, Name: "Button"},
		Source: ImportSource{Type: ImportSourceLocal, Path: "./Button"},
	}

	components, err := resolver.Resolve(stmt)
	if err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}

	button, ok := components["Button"]
	if !ok {
		t.Fatal("expected 'Button' component")
	}

	if button.Template != hypenContent {
		t.Errorf("expected template %q, got %q", hypenContent, button.Template)
	}
}

func TestResolveLocal_WithExtension(t *testing.T) {
	// File already has .hypen extension in the path
	dir := t.TempDir()
	hypenContent := `Text("Card component")`
	os.WriteFile(filepath.Join(dir, "Card.hypen"), []byte(hypenContent), 0644)

	resolver := NewComponentResolver(&ResolverOptions{
		BaseDir: dir,
	})

	stmt := ImportStatement{
		Clause: ImportClause{Type: ImportClauseDefault, Name: "Card"},
		Source: ImportSource{Type: ImportSourceLocal, Path: "./Card.hypen"},
	}

	components, err := resolver.Resolve(stmt)
	if err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}

	if _, ok := components["Card"]; !ok {
		t.Fatal("expected 'Card' component")
	}
}

func TestResolveLocal_NamedImports(t *testing.T) {
	// Named imports: { Button, Card } from "./ui"
	dir := t.TempDir()
	hypenContent := `Column { Text("Shared UI") }`
	os.WriteFile(filepath.Join(dir, "ui.hypen"), []byte(hypenContent), 0644)

	resolver := NewComponentResolver(&ResolverOptions{
		BaseDir: dir,
	})

	stmt := ImportStatement{
		Clause: ImportClause{
			Type:  ImportClauseNamed,
			Names: []string{"Button", "Card"},
		},
		Source: ImportSource{Type: ImportSourceLocal, Path: "./ui"},
	}

	components, err := resolver.Resolve(stmt)
	if err != nil {
		t.Fatalf("expected no error, got: %v", err)
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

func TestResolveLocal_NotFound(t *testing.T) {
	dir := t.TempDir()

	resolver := NewComponentResolver(&ResolverOptions{
		BaseDir: dir,
	})

	stmt := ImportStatement{
		Clause: ImportClause{Type: ImportClauseDefault, Name: "Missing"},
		Source: ImportSource{Type: ImportSourceLocal, Path: "./Missing"},
	}

	_, err := resolver.Resolve(stmt)
	if err == nil {
		t.Error("expected error for missing file")
	}
}

func TestResolveLocal_NestedPath(t *testing.T) {
	// Create nested directory: components/ui/Button.hypen
	dir := t.TempDir()
	subDir := filepath.Join(dir, "components", "ui")
	os.MkdirAll(subDir, 0755)
	os.WriteFile(filepath.Join(subDir, "Button.hypen"), []byte(`Text("Nested")`), 0644)

	resolver := NewComponentResolver(&ResolverOptions{
		BaseDir: dir,
	})

	stmt := ImportStatement{
		Clause: ImportClause{Type: ImportClauseDefault, Name: "Button"},
		Source: ImportSource{Type: ImportSourceLocal, Path: "./components/ui/Button"},
	}

	components, err := resolver.Resolve(stmt)
	if err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}

	if _, ok := components["Button"]; !ok {
		t.Fatal("expected 'Button' component")
	}
}

// ============================================================================
// C. Local Resolver Caching Tests (3 tests)
// ============================================================================

func TestResolveLocal_CacheHit(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "Widget.hypen"), []byte(`Text("Widget")`), 0644)

	resolver := NewComponentResolver(&ResolverOptions{
		BaseDir: dir,
		Cache:   true,
	})

	stmt := ImportStatement{
		Clause: ImportClause{Type: ImportClauseDefault, Name: "Widget"},
		Source: ImportSource{Type: ImportSourceLocal, Path: "./Widget"},
	}

	// First resolve
	_, err := resolver.Resolve(stmt)
	if err != nil {
		t.Fatalf("first resolve failed: %v", err)
	}

	// Delete the file
	os.Remove(filepath.Join(dir, "Widget.hypen"))

	// Second resolve should still work (cached)
	_, err = resolver.Resolve(stmt)
	if err != nil {
		t.Fatalf("second resolve should use cache: %v", err)
	}
}

func TestResolveLocal_CacheSize(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "A.hypen"), []byte(`Text("A")`), 0644)
	os.WriteFile(filepath.Join(dir, "B.hypen"), []byte(`Text("B")`), 0644)

	resolver := NewComponentResolver(&ResolverOptions{
		BaseDir: dir,
		Cache:   true,
	})

	if resolver.GetCacheSize() != 0 {
		t.Errorf("expected empty cache, got %d", resolver.GetCacheSize())
	}

	stmt1 := ImportStatement{
		Clause: ImportClause{Type: ImportClauseDefault, Name: "A"},
		Source: ImportSource{Type: ImportSourceLocal, Path: "./A"},
	}
	stmt2 := ImportStatement{
		Clause: ImportClause{Type: ImportClauseDefault, Name: "B"},
		Source: ImportSource{Type: ImportSourceLocal, Path: "./B"},
	}

	resolver.Resolve(stmt1)
	resolver.Resolve(stmt2)

	if resolver.GetCacheSize() != 2 {
		t.Errorf("expected cache size 2, got %d", resolver.GetCacheSize())
	}

	resolver.ClearCache()
	if resolver.GetCacheSize() != 0 {
		t.Errorf("expected cache size 0 after clear, got %d", resolver.GetCacheSize())
	}
}

func TestResolveLocal_NoCacheMode(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "Widget.hypen"), []byte(`Text("v1")`), 0644)

	resolver := NewComponentResolver(&ResolverOptions{
		BaseDir: dir,
		Cache:   false,
	})

	stmt := ImportStatement{
		Clause: ImportClause{Type: ImportClauseDefault, Name: "Widget"},
		Source: ImportSource{Type: ImportSourceLocal, Path: "./Widget"},
	}

	components, _ := resolver.Resolve(stmt)
	if components["Widget"].Template != `Text("v1")` {
		t.Error("expected v1 template")
	}

	// Update the file
	os.WriteFile(filepath.Join(dir, "Widget.hypen"), []byte(`Text("v2")`), 0644)

	// Should read the new version (no cache)
	components, _ = resolver.Resolve(stmt)
	if components["Widget"].Template != `Text("v2")` {
		t.Error("expected v2 template after file update")
	}
}

// ============================================================================
// D. ParseImports with Hypen DSL (3 tests)
// ============================================================================

func TestParseImports_WithinHypenDSL(t *testing.T) {
	text := `
import { Button } from "./ui"
import Header from "./layout"

Column {
    Header()
    Button(text: "Click")
}
`
	imports := ParseImports(text)

	if len(imports) != 2 {
		t.Fatalf("expected 2 imports, got %d", len(imports))
	}

	if imports[0].Clause.Names[0] != "Button" {
		t.Errorf("expected Button, got %s", imports[0].Clause.Names[0])
	}
	if imports[1].Clause.Name != "Header" {
		t.Errorf("expected Header, got %s", imports[1].Clause.Name)
	}
}

func TestParseImports_WithComments(t *testing.T) {
	text := `
// UI components
import { Button } from "./ui"

/* Layout components */
import Header from "./layout"

Column { Text("Hello") }
`
	imports := ParseImports(text)

	if len(imports) != 2 {
		t.Fatalf("expected 2 imports, got %d", len(imports))
	}
}

func TestParseImports_MixedLocalAndURL(t *testing.T) {
	text := `
import { Button } from "./ui"
import Widget from "https://cdn.example.com/widget"
import { Footer } from "../shared/layout"
`
	imports := ParseImports(text)

	if len(imports) != 3 {
		t.Fatalf("expected 3 imports, got %d", len(imports))
	}

	if imports[0].Source.Type != ImportSourceLocal {
		t.Error("expected first import to be local")
	}
	if imports[1].Source.Type != ImportSourceURL {
		t.Error("expected second import to be URL")
	}
	if imports[2].Source.Type != ImportSourceLocal {
		t.Error("expected third import to be local")
	}
}
