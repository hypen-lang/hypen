package core

import (
	"reflect"
	"testing"
)

func TestBaseRenderer_DispatchesPatchesToHandlers(t *testing.T) {
	renderer := NewTestRenderer()

	renderer.ApplyPatches([]Patch{
		{Type: PatchCreate, ID: "root", ElementType: "Column", Props: map[string]any{"role": "main"}},
		{Type: PatchSetProp, ID: "root", Name: "role", Value: "application"},
		{Type: PatchSetText, ID: "root", Text: "Hello"},
		{Type: PatchInsert, ParentID: "container", ID: "root"},
		{Type: PatchMove, ParentID: "container", ID: "root", BeforeID: "child"},
		{Type: PatchAttachEvent, ID: "root", EventName: "click"},
		{Type: PatchDetachEvent, ID: "root", EventName: "click"},
		{Type: PatchRemove, ID: "root"},
	})

	expectedTypes := []string{
		"create",
		"setProp",
		"setText",
		"insert",
		"move",
		"attachEvent",
		"detachEvent",
		"remove",
	}

	if !reflect.DeepEqual(renderer.EventTypes(), expectedTypes) {
		t.Errorf("expected event types %v, got %v", expectedTypes, renderer.EventTypes())
	}

	// Node should be removed after remove patch
	if renderer.GetNode("root") != nil {
		t.Error("expected node 'root' to be removed")
	}
}

func TestBaseRenderer_ClearRemovesAllNodes(t *testing.T) {
	renderer := NewTestRenderer()

	renderer.ApplyPatches([]Patch{
		{Type: PatchCreate, ID: "node", ElementType: "Box", Props: map[string]any{}},
	})

	if renderer.GetNode("node") == nil {
		t.Error("expected node to be created")
	}

	renderer.Clear()

	if renderer.GetNode("node") != nil {
		t.Error("expected node to be cleared")
	}
}

func TestConsoleRenderer_AppliesPatches(t *testing.T) {
	renderer := NewConsoleRenderer()

	// Should not panic
	renderer.ApplyPatches([]Patch{
		{Type: PatchCreate, ID: "node"},
	})

	// GetNode returns nil for console renderer
	if renderer.GetNode("node") != nil {
		t.Error("expected GetNode to return nil for console renderer")
	}

	// Clear is a no-op
	renderer.Clear()
}

func TestTestRenderer_TracksCreateEvents(t *testing.T) {
	renderer := NewTestRenderer()

	renderer.ApplyPatches([]Patch{
		{Type: PatchCreate, ID: "node1", ElementType: "Text", Props: map[string]any{"text": "Hello"}},
	})

	if len(renderer.Events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(renderer.Events))
	}

	event := renderer.Events[0]
	if event.Type != "create" {
		t.Errorf("expected type 'create', got %s", event.Type)
	}

	if event.Args[0] != "node1" {
		t.Errorf("expected id 'node1', got %v", event.Args[0])
	}
	if event.Args[1] != "Text" {
		t.Errorf("expected elementType 'Text', got %v", event.Args[1])
	}
}

func TestTestRenderer_TracksSetPropEvents(t *testing.T) {
	renderer := NewTestRenderer()

	renderer.ApplyPatches([]Patch{
		{Type: PatchCreate, ID: "node", ElementType: "Box", Props: map[string]any{}},
		{Type: PatchSetProp, ID: "node", Name: "color", Value: "red"},
	})

	if len(renderer.Events) != 2 {
		t.Fatalf("expected 2 events, got %d", len(renderer.Events))
	}

	event := renderer.Events[1]
	if event.Type != "setProp" {
		t.Errorf("expected type 'setProp', got %s", event.Type)
	}

	if event.Args[1] != "color" {
		t.Errorf("expected name 'color', got %v", event.Args[1])
	}
	if event.Args[2] != "red" {
		t.Errorf("expected value 'red', got %v", event.Args[2])
	}
}

func TestTestRenderer_TracksSetTextEvents(t *testing.T) {
	renderer := NewTestRenderer()

	renderer.ApplyPatches([]Patch{
		{Type: PatchCreate, ID: "node", ElementType: "Text", Props: map[string]any{}},
		{Type: PatchSetText, ID: "node", Text: "Hello World"},
	})

	event := renderer.Events[1]
	if event.Type != "setText" {
		t.Errorf("expected type 'setText', got %s", event.Type)
	}

	if event.Args[1] != "Hello World" {
		t.Errorf("expected text 'Hello World', got %v", event.Args[1])
	}

	// Check that node text is updated
	node := renderer.GetNode("node").(map[string]any)
	if node["text"] != "Hello World" {
		t.Errorf("expected node text 'Hello World', got %v", node["text"])
	}
}

func TestTestRenderer_TracksInsertAndMoveEvents(t *testing.T) {
	renderer := NewTestRenderer()

	renderer.ApplyPatches([]Patch{
		{Type: PatchInsert, ParentID: "parent", ID: "child", BeforeID: "sibling"},
		{Type: PatchMove, ParentID: "parent", ID: "child", BeforeID: "other"},
	})

	if renderer.Events[0].Type != "insert" {
		t.Errorf("expected type 'insert', got %s", renderer.Events[0].Type)
	}
	if renderer.Events[1].Type != "move" {
		t.Errorf("expected type 'move', got %s", renderer.Events[1].Type)
	}
}

func TestTestRenderer_TracksEventAttachmentAndDetachment(t *testing.T) {
	renderer := NewTestRenderer()

	renderer.ApplyPatches([]Patch{
		{Type: PatchAttachEvent, ID: "node", EventName: "click"},
		{Type: PatchDetachEvent, ID: "node", EventName: "click"},
	})

	if renderer.Events[0].Type != "attachEvent" {
		t.Errorf("expected type 'attachEvent', got %s", renderer.Events[0].Type)
	}
	if renderer.Events[0].Args[1] != "click" {
		t.Errorf("expected eventName 'click', got %v", renderer.Events[0].Args[1])
	}

	if renderer.Events[1].Type != "detachEvent" {
		t.Errorf("expected type 'detachEvent', got %s", renderer.Events[1].Type)
	}
}

func TestTestRenderer_ClearEventsResetsEvents(t *testing.T) {
	renderer := NewTestRenderer()

	renderer.ApplyPatches([]Patch{
		{Type: PatchCreate, ID: "node", ElementType: "Box", Props: map[string]any{}},
	})

	if len(renderer.Events) != 1 {
		t.Error("expected 1 event before clear")
	}

	renderer.ClearEvents()

	if len(renderer.Events) != 0 {
		t.Error("expected 0 events after clear")
	}
}

func TestTestRenderer_NodeStorage(t *testing.T) {
	renderer := NewTestRenderer()

	// Initially no nodes
	if renderer.GetNode("test") != nil {
		t.Error("expected no node initially")
	}

	// After create, node exists
	renderer.ApplyPatches([]Patch{
		{Type: PatchCreate, ID: "test", ElementType: "Box", Props: map[string]any{"width": 100}},
	})

	node := renderer.GetNode("test")
	if node == nil {
		t.Fatal("expected node to exist after create")
	}

	nodeMap := node.(map[string]any)
	if nodeMap["type"] != "Box" {
		t.Errorf("expected type 'Box', got %v", nodeMap["type"])
	}

	// After remove, node is gone
	renderer.ApplyPatches([]Patch{
		{Type: PatchRemove, ID: "test"},
	})

	if renderer.GetNode("test") != nil {
		t.Error("expected node to be removed")
	}
}

func TestBaseRenderer_SetAndDeleteNode(t *testing.T) {
	renderer := NewBaseRenderer()

	renderer.SetNode("test", map[string]any{"value": 123})

	node := renderer.GetNode("test")
	if node == nil {
		t.Fatal("expected node to exist")
	}

	nodeMap := node.(map[string]any)
	if nodeMap["value"] != 123 {
		t.Errorf("expected value 123, got %v", nodeMap["value"])
	}

	renderer.DeleteNode("test")

	if renderer.GetNode("test") != nil {
		t.Error("expected node to be deleted")
	}
}

func TestPatchConstants(t *testing.T) {
	if PatchCreate != "create" {
		t.Errorf("expected PatchCreate='create', got %s", PatchCreate)
	}
	if PatchSetProp != "setProp" {
		t.Errorf("expected PatchSetProp='setProp', got %s", PatchSetProp)
	}
	if PatchSetText != "setText" {
		t.Errorf("expected PatchSetText='setText', got %s", PatchSetText)
	}
	if PatchInsert != "insert" {
		t.Errorf("expected PatchInsert='insert', got %s", PatchInsert)
	}
	if PatchMove != "move" {
		t.Errorf("expected PatchMove='move', got %s", PatchMove)
	}
	if PatchRemove != "remove" {
		t.Errorf("expected PatchRemove='remove', got %s", PatchRemove)
	}
	if PatchAttachEvent != "attachEvent" {
		t.Errorf("expected PatchAttachEvent='attachEvent', got %s", PatchAttachEvent)
	}
	if PatchDetachEvent != "detachEvent" {
		t.Errorf("expected PatchDetachEvent='detachEvent', got %s", PatchDetachEvent)
	}
}
