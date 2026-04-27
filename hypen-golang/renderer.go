package core

import (
	"sync"
)

var logRenderer = LogRenderer

// Renderer interface that all platform renderers must implement
type Renderer interface {
	// ApplyPatches applies a batch of patches to the render tree
	ApplyPatches(patches []Patch)

	// GetNode returns a node by its ID (optional, for debugging)
	GetNode(id string) any

	// Clear clears the entire render tree
	Clear()
}

// BaseRenderer provides common utilities for renderers
type BaseRenderer struct {
	mu    sync.RWMutex
	nodes map[string]any

	// Platform-specific handlers (must be set by embedding struct)
	OnCreate      func(id string, elementType string, props map[string]any)
	OnSetProp     func(id string, name string, value any)
	OnSetText     func(id string, text string)
	OnInsert      func(parentID string, id string, beforeID string)
	OnMove        func(parentID string, id string, beforeID string)
	OnRemove      func(id string)
	OnRemoveProp  func(id string, name string)
	OnAttachEvent func(id string, eventName string)
	OnDetachEvent func(id string, eventName string)
}

// NewBaseRenderer creates a new BaseRenderer
func NewBaseRenderer() *BaseRenderer {
	return &BaseRenderer{
		nodes: make(map[string]any),
	}
}

// ApplyPatches applies a batch of patches
func (r *BaseRenderer) ApplyPatches(patches []Patch) {
	for _, patch := range patches {
		r.applyPatch(patch)
	}
}

// applyPatch applies a single patch
func (r *BaseRenderer) applyPatch(patch Patch) {
	switch patch.Type {
	case PatchCreate:
		if r.OnCreate != nil {
			r.OnCreate(patch.ID, patch.ElementType, patch.Props)
		}
	case PatchSetProp:
		if r.OnSetProp != nil {
			r.OnSetProp(patch.ID, patch.Name, patch.Value)
		}
	case PatchSetText:
		if r.OnSetText != nil {
			r.OnSetText(patch.ID, patch.Text)
		}
	case PatchInsert:
		if r.OnInsert != nil {
			r.OnInsert(patch.ParentID, patch.ID, patch.BeforeID)
		}
	case PatchMove:
		if r.OnMove != nil {
			r.OnMove(patch.ParentID, patch.ID, patch.BeforeID)
		}
	case PatchRemove:
		if r.OnRemove != nil {
			r.OnRemove(patch.ID)
		}
	case PatchRemoveProp:
		if r.OnRemoveProp != nil {
			r.OnRemoveProp(patch.ID, patch.Name)
		}
	case PatchAttachEvent:
		if r.OnAttachEvent != nil {
			r.OnAttachEvent(patch.ID, patch.EventName)
		}
	case PatchDetachEvent:
		if r.OnDetachEvent != nil {
			r.OnDetachEvent(patch.ID, patch.EventName)
		}
	}
}

// GetNode returns a node by ID
func (r *BaseRenderer) GetNode(id string) any {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.nodes[id]
}

// SetNode stores a node
func (r *BaseRenderer) SetNode(id string, node any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.nodes[id] = node
}

// DeleteNode removes a node
func (r *BaseRenderer) DeleteNode(id string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.nodes, id)
}

// Clear removes all nodes
func (r *BaseRenderer) Clear() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.nodes = make(map[string]any)
}

// ConsoleRenderer logs patches to console
type ConsoleRenderer struct{}

// NewConsoleRenderer creates a new ConsoleRenderer
func NewConsoleRenderer() *ConsoleRenderer {
	return &ConsoleRenderer{}
}

// ApplyPatches logs patches to console
func (r *ConsoleRenderer) ApplyPatches(patches []Patch) {
	logRenderer.Debug("Patches: %+v", patches)
}

// GetNode returns nil (console renderer doesn't store nodes)
func (r *ConsoleRenderer) GetNode(id string) any {
	return nil
}

// Clear is a no-op for console renderer
func (r *ConsoleRenderer) Clear() {}

// TestRenderer is a renderer for testing that records all operations
type TestRenderer struct {
	*BaseRenderer
	Events []RendererEvent
}

// RendererEvent records a renderer operation
type RendererEvent struct {
	Type string
	Args []any
}

// NewTestRenderer creates a new TestRenderer
func NewTestRenderer() *TestRenderer {
	tr := &TestRenderer{
		BaseRenderer: NewBaseRenderer(),
		Events:       []RendererEvent{},
	}

	tr.OnCreate = func(id string, elementType string, props map[string]any) {
		tr.Events = append(tr.Events, RendererEvent{
			Type: "create",
			Args: []any{id, elementType, props},
		})
		tr.SetNode(id, map[string]any{"type": elementType, "props": props})
	}

	tr.OnSetProp = func(id string, name string, value any) {
		tr.Events = append(tr.Events, RendererEvent{
			Type: "setProp",
			Args: []any{id, name, value},
		})
		if node := tr.GetNode(id); node != nil {
			if m, ok := node.(map[string]any); ok {
				if props, ok := m["props"].(map[string]any); ok {
					props[name] = value
				}
			}
		}
	}

	tr.OnSetText = func(id string, text string) {
		tr.Events = append(tr.Events, RendererEvent{
			Type: "setText",
			Args: []any{id, text},
		})
		if node := tr.GetNode(id); node != nil {
			if m, ok := node.(map[string]any); ok {
				m["text"] = text
			}
		}
	}

	tr.OnInsert = func(parentID string, id string, beforeID string) {
		tr.Events = append(tr.Events, RendererEvent{
			Type: "insert",
			Args: []any{parentID, id, beforeID},
		})
	}

	tr.OnMove = func(parentID string, id string, beforeID string) {
		tr.Events = append(tr.Events, RendererEvent{
			Type: "move",
			Args: []any{parentID, id, beforeID},
		})
	}

	tr.OnRemove = func(id string) {
		tr.Events = append(tr.Events, RendererEvent{
			Type: "remove",
			Args: []any{id},
		})
		tr.DeleteNode(id)
	}

	tr.OnAttachEvent = func(id string, eventName string) {
		tr.Events = append(tr.Events, RendererEvent{
			Type: "attachEvent",
			Args: []any{id, eventName},
		})
	}

	tr.OnDetachEvent = func(id string, eventName string) {
		tr.Events = append(tr.Events, RendererEvent{
			Type: "detachEvent",
			Args: []any{id, eventName},
		})
	}

	return tr
}

// EventTypes returns the types of all recorded events
func (tr *TestRenderer) EventTypes() []string {
	types := make([]string, len(tr.Events))
	for i, e := range tr.Events {
		types[i] = e.Type
	}
	return types
}

// ClearEvents clears all recorded events
func (tr *TestRenderer) ClearEvents() {
	tr.Events = []RendererEvent{}
}
