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
	OnCreate  func(id string, elementType string, props map[string]any)
	OnSetProp func(id string, name string, value any)
	OnSetText func(id string, text string)
	OnInsert  func(parentID string, id string, beforeID string)
	OnMove    func(parentID string, id string, beforeID string)
	OnRemove  func(id string)
	// OnClearChildren handles a "clearChildren" patch: unlink every child
	// of id and tear down each child's subtree exactly as OnRemove would
	// for each child (no exit transition), keeping id itself. Renderers
	// that set OnRemove must set this too, or a cleared list stays on
	// screen.
	OnClearChildren func(id string)
	OnRemoveProp    func(id string, name string)
	OnAttachEvent   func(id string, eventName string)
	OnDetachEvent   func(id string, eventName string)
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
	case PatchClearChildren:
		if r.OnClearChildren != nil {
			r.OnClearChildren(patch.ID)
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

	// Tree bookkeeping (parent → ordered child ids, child → parent) so
	// "remove" and "clearChildren" can tear down whole subtrees.
	children map[string][]string
	parentOf map[string]string
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
		children:     map[string][]string{},
		parentOf:     map[string]string{},
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
		tr.link(parentID, id, beforeID)
	}

	tr.OnMove = func(parentID string, id string, beforeID string) {
		tr.Events = append(tr.Events, RendererEvent{
			Type: "move",
			Args: []any{parentID, id, beforeID},
		})
		tr.link(parentID, id, beforeID)
	}

	tr.OnRemove = func(id string) {
		tr.Events = append(tr.Events, RendererEvent{
			Type: "remove",
			Args: []any{id},
		})
		tr.unlink(id)
		tr.dropSubtree(id)
	}

	// clearChildren == a plain remove of each current child of id; id
	// itself (and its props) stays. Unknown ids have no children: no-op.
	tr.OnClearChildren = func(id string) {
		tr.Events = append(tr.Events, RendererEvent{
			Type: "clearChildren",
			Args: []any{id},
		})
		kids := tr.children[id]
		delete(tr.children, id)
		for _, child := range kids {
			delete(tr.parentOf, child)
			tr.dropSubtree(child)
		}
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

// ChildIDs returns the ordered child ids currently linked under id
// ("root" for the root container).
func (tr *TestRenderer) ChildIDs(id string) []string {
	return append([]string(nil), tr.children[id]...)
}

// link places id under parentID (before beforeID when it is a sibling,
// else last), unlinking it from any previous parent first.
func (tr *TestRenderer) link(parentID, id, beforeID string) {
	tr.unlink(id)
	kids := tr.children[parentID]
	at := len(kids)
	if beforeID != "" {
		for i, k := range kids {
			if k == beforeID {
				at = i
				break
			}
		}
	}
	kids = append(kids, "")
	copy(kids[at+1:], kids[at:])
	kids[at] = id
	tr.children[parentID] = kids
	tr.parentOf[id] = parentID
}

// unlink removes id from its parent's child list (the subtree stays).
func (tr *TestRenderer) unlink(id string) {
	parent, ok := tr.parentOf[id]
	if !ok {
		return
	}
	delete(tr.parentOf, id)
	kids := tr.children[parent]
	for i, k := range kids {
		if k == id {
			tr.children[parent] = append(kids[:i:i], kids[i+1:]...)
			break
		}
	}
}

// dropSubtree forgets id and every descendant.
func (tr *TestRenderer) dropSubtree(id string) {
	for _, child := range tr.children[id] {
		delete(tr.parentOf, child)
		tr.dropSubtree(child)
	}
	delete(tr.children, id)
	tr.DeleteNode(id)
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
