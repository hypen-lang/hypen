package core

import (
	"fmt"
	"testing"
)

// TestLazyListWindowing drives the WASI engine's list virtualization: a
// renderer opts in with SetVirtualization, the engine materializes only a
// window of a List's rows and reports it in `__virt.window`, and
// SetListViewport moves the window.
func TestLazyListWindowing(t *testing.T) {
	engine := newTestEngine(t)
	if err := engine.RegisterPrimitive("List"); err != nil {
		t.Fatalf("register List: %v", err)
	}
	if err := engine.SetVirtualization(true); err != nil {
		t.Fatalf("SetVirtualization: %v", err)
	}

	items := make([]any, 100)
	for i := range items {
		items[i] = map[string]any{"id": i, "name": fmt.Sprintf("row %d", i)}
	}
	engine.SetModule("Test", []string{}, []string{"items"}, map[string]any{"items": items})

	patches, err := engine.RenderSource(`List(@state.items, key: "id", initialCount: 10) { Text("@{item.name}") }`)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	var listID string
	for _, p := range findPatches(patches, "create") {
		if p.ElementType == "List" {
			listID = p.ID
		}
	}
	if listID == "" {
		t.Fatal("no List created")
	}
	if got := countTexts(patches); got != 10 {
		t.Fatalf("initial window: %d rows created, want 10", got)
	}
	assertWindow(t, patches, listID, 100, 0, 10)

	moved, err := engine.SetListViewport(listID, 40, 55)
	if err != nil {
		t.Fatalf("SetListViewport: %v", err)
	}
	if got := countTexts(moved); got != 15 {
		t.Errorf("viewport move: %d rows created, want 15", got)
	}
	if got := len(findPatches(moved, "remove")); got != 10 {
		t.Errorf("viewport move: %d rows removed, want 10", got)
	}
	assertWindow(t, moved, listID, 100, 40, 55)

	// An id naming no lazy list is ignored, not an error.
	none, err := engine.SetListViewport("not-a-node", 0, 5)
	if err != nil || len(none) != 0 {
		t.Errorf("unknown id: patches=%d err=%v, want none", len(none), err)
	}
}

func countTexts(patches []Patch) int {
	n := 0
	for _, p := range findPatches(patches, "create") {
		if p.ElementType == "Text" {
			n++
		}
	}
	return n
}

func assertWindow(t *testing.T, patches []Patch, listID string, total, start, end float64) {
	t.Helper()
	for _, p := range findPatches(patches, "setProp") {
		if p.ID != listID || p.Name != "__virt.window" {
			continue
		}
		w, ok := p.Value.(map[string]any)
		if !ok || w["total"] != total || w["start"] != start || w["end"] != end {
			t.Fatalf("__virt.window = %v, want total=%v start=%v end=%v", p.Value, total, start, end)
		}
		return
	}
	t.Fatalf("no __virt.window setProp for %s", listID)
}
