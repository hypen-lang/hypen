// Package core provides the Hypen SDK for Go - a reactive UI runtime.
package core

import (
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
	"sync"
)

// StatePath represents a dot-separated path to a state value (e.g., "user.name", "items.0.title")
type StatePath = string

// StateChange represents a change in state with full path information
type StateChange struct {
	Paths     []StatePath
	NewValues map[StatePath]any
}

// StateObserverOptions configures state observation
type StateObserverOptions struct {
	OnChange func(change StateChange)
}

// ObservableState wraps a state object and tracks changes
type ObservableState struct {
	mu           sync.RWMutex
	state        map[string]any
	lastSnapshot map[string]any
	options      StateObserverOptions
	batchDepth   int
	batchChanges *StateChange
}

// NewObservableState creates a new observable state from initial data
func NewObservableState(initialState map[string]any, options *StateObserverOptions) *ObservableState {
	if options == nil {
		options = &StateObserverOptions{OnChange: func(change StateChange) {}}
	}
	if options.OnChange == nil {
		options.OnChange = func(change StateChange) {}
	}

	// Deep clone the initial state
	cloned := DeepClone(initialState)
	snapshot := DeepClone(initialState)

	return &ObservableState{
		state:        cloned,
		lastSnapshot: snapshot,
		options:      *options,
	}
}

// Get returns the value at the given path
func (o *ObservableState) Get(path string) any {
	o.mu.RLock()
	defer o.mu.RUnlock()
	return getValueAtPath(o.state, path)
}

// GetAll returns the full state as a map
func (o *ObservableState) GetAll() map[string]any {
	o.mu.RLock()
	defer o.mu.RUnlock()
	return DeepClone(o.state)
}

// Set sets a value at the given path and notifies observers
func (o *ObservableState) Set(path string, value any) {
	o.mu.Lock()

	oldValue := getValueAtPath(o.state, path)
	setValueAtPath(o.state, path, value)

	if !reflect.DeepEqual(oldValue, value) {
		if o.batchDepth > 0 {
			// In batch mode, accumulate changes
			if o.batchChanges == nil {
				o.batchChanges = &StateChange{
					Paths:     []StatePath{},
					NewValues: make(map[StatePath]any),
				}
			}
			o.batchChanges.Paths = append(o.batchChanges.Paths, path)
			o.batchChanges.NewValues[path] = value
			o.mu.Unlock()
			return
		}

		// Not in batch, notify immediately
		o.lastSnapshot = DeepClone(o.state)
		o.mu.Unlock()

		change := StateChange{
			Paths:     []StatePath{path},
			NewValues: map[StatePath]any{path: value},
		}
		o.options.OnChange(change)
		return
	}

	o.mu.Unlock()
}

// SetAll replaces the entire state
func (o *ObservableState) SetAll(newState map[string]any) {
	o.mu.Lock()

	changes := diffState(o.lastSnapshot, newState)

	if len(changes.Paths) > 0 {
		o.state = DeepClone(newState)
		o.lastSnapshot = DeepClone(newState)

		if o.batchDepth > 0 {
			if o.batchChanges == nil {
				o.batchChanges = &StateChange{
					Paths:     []StatePath{},
					NewValues: make(map[StatePath]any),
				}
			}
			o.batchChanges.Paths = append(o.batchChanges.Paths, changes.Paths...)
			for k, v := range changes.NewValues {
				o.batchChanges.NewValues[k] = v
			}
			o.mu.Unlock()
			return
		}

		o.mu.Unlock()
		o.options.OnChange(changes)
		return
	}

	o.mu.Unlock()
}

// Delete removes a value at the given path
func (o *ObservableState) Delete(path string) {
	o.mu.Lock()

	if hasValueAtPath(o.state, path) {
		deleteValueAtPath(o.state, path)

		if o.batchDepth > 0 {
			if o.batchChanges == nil {
				o.batchChanges = &StateChange{
					Paths:     []StatePath{},
					NewValues: make(map[StatePath]any),
				}
			}
			o.batchChanges.Paths = append(o.batchChanges.Paths, path)
			o.batchChanges.NewValues[path] = nil
			o.mu.Unlock()
			return
		}

		o.lastSnapshot = DeepClone(o.state)
		o.mu.Unlock()

		change := StateChange{
			Paths:     []StatePath{path},
			NewValues: map[StatePath]any{path: nil},
		}
		o.options.OnChange(change)
		return
	}

	o.mu.Unlock()
}

// BeginBatch starts a batch update
func (o *ObservableState) BeginBatch() {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.batchDepth++
}

// EndBatch ends a batch update and notifies observers of all accumulated changes
func (o *ObservableState) EndBatch() {
	o.mu.Lock()

	if o.batchDepth > 0 {
		o.batchDepth--
	}

	if o.batchDepth == 0 && o.batchChanges != nil && len(o.batchChanges.Paths) > 0 {
		changes := *o.batchChanges
		o.batchChanges = nil
		o.lastSnapshot = DeepClone(o.state)
		o.mu.Unlock()
		o.options.OnChange(changes)
		return
	}

	o.mu.Unlock()
}

// Snapshot returns a deep copy of the current state
func (o *ObservableState) Snapshot() map[string]any {
	o.mu.RLock()
	defer o.mu.RUnlock()
	return DeepClone(o.state)
}

// BatchStateUpdates executes a function within a batch
func BatchStateUpdates(state *ObservableState, fn func()) {
	if state == nil {
		fn()
		return
	}
	state.BeginBatch()
	defer state.EndBatch()
	fn()
}

// GetStateSnapshot returns a deep copy of the state
func GetStateSnapshot(state *ObservableState) map[string]any {
	if state == nil {
		return nil
	}
	return state.Snapshot()
}

// DeepClone creates a deep copy of a value
func DeepClone(value any) map[string]any {
	if value == nil {
		return nil
	}

	// Use JSON marshaling for deep clone (handles nested structures)
	data, err := json.Marshal(value)
	if err != nil {
		return nil
	}

	var result map[string]any
	if err := json.Unmarshal(data, &result); err != nil {
		return nil
	}

	return result
}

// DeepCloneAny creates a deep copy of any value
func DeepCloneAny(value any) any {
	if value == nil {
		return nil
	}

	data, err := json.Marshal(value)
	if err != nil {
		return value
	}

	var result any
	if err := json.Unmarshal(data, &result); err != nil {
		return value
	}

	return result
}

// diffState compares two states and returns the changes.
//
// Thin wrapper over the engine's canonical `hypen_portable_diff_paths`
// — the diff algorithm lives in Rust at
// `hypen-engine-rs/src/portable/diff.rs` and every Hypen SDK routes
// through it. If the engine call fails the process is broken (the
// embedded WASM can't load), so this panics rather than returning a
// silently-wrong empty change.
func diffState(oldState, newState map[string]any) StateChange {
	entries, err := diffPathsViaEngine(oldState, newState)
	if err != nil {
		panic(fmt.Sprintf("diffState: engine portable runtime unavailable: %v", err))
	}

	paths := make([]StatePath, 0, len(entries))
	newValues := make(map[StatePath]any, len(entries))
	for _, e := range entries {
		paths = append(paths, e.Path)
		newValues[e.Path] = e.Value
	}
	return StateChange{Paths: paths, NewValues: newValues}
}

// getValueAtPath reads the value at a dot-separated path. Thin wrapper
// around the engine's canonical `hypen_portable_path_get`.
func getValueAtPath(obj map[string]any, path string) any {
	v, err := pathGetViaEngine(obj, path)
	if err != nil {
		panic(fmt.Sprintf("getValueAtPath: engine portable runtime unavailable: %v", err))
	}
	return v
}

// setValueAtPath writes `value` at a dot-separated path. The engine
// returns the updated JSON; we copy its top-level entries back into
// `obj` so callers that retained the original map pointer see the
// mutation.
func setValueAtPath(obj map[string]any, path string, value any) {
	if path == "" {
		return
	}
	updated, err := pathSetViaEngine(obj, path, value)
	if err != nil {
		panic(fmt.Sprintf("setValueAtPath: engine portable runtime unavailable: %v", err))
	}
	// Mirror the engine's root object back into the caller's map.
	for k := range obj {
		if _, ok := updated[k]; !ok {
			delete(obj, k)
		}
	}
	for k, v := range updated {
		obj[k] = v
	}
}

// hasValueAtPath returns true iff the path resolves inside obj.
func hasValueAtPath(obj map[string]any, path string) bool {
	ok, err := pathHasViaEngine(obj, path)
	if err != nil {
		panic(fmt.Sprintf("hasValueAtPath: engine portable runtime unavailable: %v", err))
	}
	return ok
}

// deleteValueAtPath removes the value at a dot-separated path. See
// setValueAtPath for the mutation-mirror mechanism.
func deleteValueAtPath(obj map[string]any, path string) {
	if path == "" {
		return
	}
	updated, _, err := pathDeleteViaEngine(obj, path)
	if err != nil {
		panic(fmt.Sprintf("deleteValueAtPath: engine portable runtime unavailable: %v", err))
	}
	for k := range obj {
		if _, ok := updated[k]; !ok {
			delete(obj, k)
		}
	}
	for k, v := range updated {
		obj[k] = v
	}
}

// SortedPaths returns paths sorted alphabetically
func SortedPaths(paths []string) []string {
	sorted := make([]string, len(paths))
	copy(sorted, paths)
	sort.Strings(sorted)
	return sorted
}
