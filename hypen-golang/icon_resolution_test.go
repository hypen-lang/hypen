package core

import (
	"encoding/json"
	"testing"
)

// TestIconResolution_WithoutRegistration reproduces the "..." bug:
// when the engine is asked to render Icon(@resources.heart) without any
// resources/icon pack registered, the resulting Create patch should have
// NO resolved path data. This documents the pre-fix broken behavior.
func TestIconResolution_WithoutRegistration(t *testing.T) {
	engine, err := NewDefaultEngine()
	if err != nil {
		t.Fatalf("NewDefaultEngine failed: %v", err)
	}
	t.Cleanup(func() { engine.Close() })
	for _, p := range []string{"Text", "Column", "Row", "Button", "Icon"} {
		if err := engine.RegisterPrimitive(p); err != nil {
			t.Fatalf("RegisterPrimitive %s failed: %v", p, err)
		}
	}

	patches, rerr := engine.RenderSource(`Icon(@resources.heart)`)
	if rerr != nil {
		t.Fatalf("RenderSource failed: %v", rerr)
	}

	create := findPatch(patches, PatchCreate)
	if create == nil {
		t.Fatal("expected a create patch for Icon")
	}
	if create.ElementType != "Icon" {
		t.Fatalf("expected ElementType='Icon', got %q", create.ElementType)
	}

	t.Logf("Icon create patch props WITHOUT registration: %+v", create.Props)

	// Without registration, the engine cannot resolve @resources.heart,
	// so props must NOT contain __iconPaths. The literal "@resources.heart"
	// string will be left in props[0] — which is why clients render "..." /
	// nothing: they see a raw reference string with no icon data.
	if _, ok := create.Props["__iconPaths"]; ok {
		t.Errorf("expected no __iconPaths when resources not registered, but found one")
	}
	if v, ok := create.Props["0"]; !ok || v != "@resources.heart" {
		t.Errorf("expected raw '@resources.heart' reference in props[0], got %v", create.Props)
	}
}

// TestIconResolution_WithRegistration verifies that registering resources
// via RegisterResources causes the engine to resolve @resources.heart into
// concrete path data embedded in the Create patch props. SVG parsing is
// performed in Rust centrally by the engine.
func TestIconResolution_WithRegistration(t *testing.T) {
	engine, err := NewDefaultEngine()
	if err != nil {
		t.Fatalf("NewDefaultEngine failed: %v", err)
	}
	t.Cleanup(func() { engine.Close() })
	for _, p := range []string{"Text", "Column", "Row", "Button", "Icon"} {
		if err := engine.RegisterPrimitive(p); err != nil {
			t.Fatalf("RegisterPrimitive %s failed: %v", p, err)
		}
	}

	// Register a "heart" resource as raw SVG; the engine parses it in Rust.
	heartSVG := `<svg viewBox="0 0 24 24"><path d="M12 21s-7-4.5-7-11a5 5 0 0 1 9-3 5 5 0 0 1 9 3c0 6.5-7 11-7 11z" stroke="currentColor" stroke-width="2" fill="none"/></svg>`
	if rerr := engine.RegisterResources(map[string]string{"heart": heartSVG}); rerr != nil {
		t.Fatalf("RegisterResources failed: %v", rerr)
	}

	patches, rerr := engine.RenderSource(`Icon(@resources.heart)`)
	if rerr != nil {
		t.Fatalf("RenderSource failed: %v", rerr)
	}

	create := findPatch(patches, PatchCreate)
	if create == nil {
		t.Fatal("expected a create patch for Icon")
	}

	propsJSON, _ := json.MarshalIndent(create.Props, "", "  ")
	t.Logf("Icon create patch props WITH registration:\n%s", propsJSON)

	// With registration, props should contain __iconPaths array with real path data.
	pathsRaw, ok := create.Props["__iconPaths"]
	if !ok {
		t.Fatalf("expected '__iconPaths' prop on Icon create patch after RegisterResources, props: %+v", create.Props)
	}
	pathsArr, ok := pathsRaw.([]any)
	if !ok {
		t.Fatalf("expected '__iconPaths' to be an array, got %T", pathsRaw)
	}
	if len(pathsArr) == 0 {
		t.Fatal("expected at least one path in resolved icon, got 0")
	}

	first, ok := pathsArr[0].(map[string]any)
	if !ok {
		t.Fatalf("expected first path to be an object, got %T", pathsArr[0])
	}
	d, _ := first["d"].(string)
	if d == "" {
		t.Error("expected non-empty 'd' on first resolved path")
	}
	t.Logf("Resolved heart path d=%q", d)
}
