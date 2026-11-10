package core

import (
	"fmt"
	"testing"
)

// TestLazyListWindowing drives the WASI engine's list virtualization: the
// engine materializes only a window of a List's rows and reports it in
// `__virt.window`, and SetListViewport moves the window.
func TestLazyListWindowing(t *testing.T) {
	engine := newTestEngine(t)
	if err := engine.RegisterPrimitive("List"); err != nil {
		t.Fatalf("register List: %v", err)
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
	// The window jumps clear of every materialized row, so the 10 old rows
	// leave in one clearChildren on the List (docs/clear-children.md), not
	// 10 removes; it precedes the new rows.
	if got := len(findPatches(moved, "remove")); got != 0 {
		t.Errorf("viewport move: %d per-row removes, want 0 (one clearChildren)", got)
	}
	if got := findPatches(moved, PatchClearChildren); len(got) != 1 || got[0].ID != listID {
		t.Errorf("viewport move: clearChildren = %+v, want one on %s", got, listID)
	}
	for _, p := range moved {
		if p.Type == PatchClearChildren {
			break
		}
		if p.Type == PatchCreate || p.Type == PatchInsert {
			t.Errorf("viewport move: %s %s precedes the clearChildren", p.Type, p.ID)
			break
		}
	}
	assertWindow(t, moved, listID, 100, 40, 55)

	// An id naming no lazy list is ignored, not an error.
	none, err := engine.SetListViewport("not-a-node", 0, 5)
	if err != nil || len(none) != 0 {
		t.Errorf("unknown id: patches=%d err=%v, want none", len(none), err)
	}
}

// TestClearChildrenFromEngine pins the WASI engine's clearChildren
// emission (hypen-web/docs/clear-children.md): emptying or wholesale
// replacing a list that owns its element sends one clearChildren ahead
// of the new rows; a list sharing its parent keeps per-row removes.
func TestClearChildrenFromEngine(t *testing.T) {
	rows := func(from, to int) []any {
		out := []any{}
		for i := from; i < to; i++ {
			out = append(out, map[string]any{"id": i, "name": fmt.Sprintf("row %d", i)})
		}
		return out
	}
	render := func(t *testing.T, src string, n int) (*WasmEngine, *TestRenderer) {
		engine := newTestEngine(t)
		if err := engine.RegisterPrimitive("List"); err != nil {
			t.Fatalf("register List: %v", err)
		}
		engine.SetModule("Test", []string{}, []string{"items"}, map[string]any{"items": rows(0, n)})
		patches, err := engine.RenderSource(src)
		if err != nil {
			t.Fatalf("render: %v", err)
		}
		r := NewTestRenderer()
		r.ApplyPatches(patches)
		return engine, r
	}
	update := func(t *testing.T, e *WasmEngine, r *TestRenderer, items []any) []Patch {
		patches, err := e.UpdateState(map[string]any{"items": items})
		if err != nil {
			t.Fatalf("update: %v", err)
		}
		r.ApplyPatches(patches)
		return patches
	}
	const eager = `List(@state.items, key: "id", lazy: false) { Text("@{item.name}") }`

	t.Run("emptied", func(t *testing.T) {
		e, r := render(t, eager, 5)
		listID := r.ChildIDs("root")[0]
		got := update(t, e, r, []any{})
		if c, rm := len(findPatches(got, PatchClearChildren)), len(findPatches(got, PatchRemove)); c != 1 || rm != 0 {
			t.Fatalf("clearChildren=%d remove=%d, want 1/0: %+v", c, rm, got)
		}
		if got[0].Type != PatchClearChildren || got[0].ID != listID {
			t.Errorf("first patch = %+v, want clearChildren of %s", got[0], listID)
		}
		if n := len(r.ChildIDs(listID)); n != 0 {
			t.Errorf("%d rows left after clear", n)
		}
	})

	t.Run("replaced", func(t *testing.T) {
		e, r := render(t, eager, 3)
		listID := r.ChildIDs("root")[0]
		got := update(t, e, r, rows(100, 104))
		clearAt, firstNew := -1, -1
		for i, p := range got {
			if p.Type == PatchClearChildren && clearAt < 0 {
				clearAt = i
			}
			if (p.Type == PatchCreate || p.Type == PatchInsert) && firstNew < 0 {
				firstNew = i
			}
		}
		if clearAt < 0 || firstNew < 0 || clearAt > firstNew {
			t.Fatalf("clearChildren at %d, first new row at %d: %+v", clearAt, firstNew, got)
		}
		if rm := len(findPatches(got, PatchRemove)); rm != 0 {
			t.Errorf("%d removes alongside clearChildren", rm)
		}
		if n := len(r.ChildIDs(listID)); n != 4 {
			t.Errorf("%d rows after replace, want 4", n)
		}
	})

	t.Run("sibling keeps per-row removes", func(t *testing.T) {
		e, r := render(t, `Column { Text("header") ForEach(items: @state.items, key: "id") { Text("@{item.name}") } }`, 4)
		got := update(t, e, r, []any{})
		if c, rm := len(findPatches(got, PatchClearChildren)), len(findPatches(got, PatchRemove)); c != 0 || rm != 4 {
			t.Errorf("clearChildren=%d remove=%d, want 0/4", c, rm)
		}
	})

	t.Run("single row is a plain remove", func(t *testing.T) {
		e, r := render(t, eager, 1)
		got := update(t, e, r, []any{})
		if c, rm := len(findPatches(got, PatchClearChildren)), len(findPatches(got, PatchRemove)); c != 0 || rm != 1 {
			t.Errorf("clearChildren=%d remove=%d, want 0/1", c, rm)
		}
	})
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
