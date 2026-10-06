// Package core provides the Hypen SDK for Go - a reactive UI runtime.
package core

import (
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
	"strconv"
	"strings"
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

// Move relocates element `from` of the array at fromPath so that it becomes
// index `to` of the array at toPath (the two paths may coincide). This is the
// `__hypen_reorder` primitive with exactly the engine's `path_move` semantics
// (see pathMove): `to` is the moved item's FINAL index, clamped to
// [0, len] after removal; a same-array move with from == to is a no-op that
// reports true; a non-array path or an out-of-range `from` leaves the state
// untouched and reports false.
//
// Observers are notified for both container paths — source and destination,
// each re-addressed to where that array lives AFTER the move (see pathMove's
// nested-destination rule; symmetrically, a source array nested under an
// element of the destination array shifts up by one when the item is
// inserted at or before that element) — carrying the full new array at
// each. When the paths coincide a single path is reported. A reported-true
// no-op notifies nobody, matching Set's value-unchanged behaviour.
func (o *ObservableState) Move(fromPath string, from int, toPath string, to int) bool {
	o.mu.Lock()

	srcPath, destPath, moved := pathMoveResolved(o.state, fromPath, from, toPath, to)
	if !moved {
		o.mu.Unlock()
		return false
	}
	if fromPath == toPath && from == to {
		// Same-array same-index: reported as moved, but nothing changed.
		o.mu.Unlock()
		return true
	}

	paths := []StatePath{srcPath}
	if destPath != srcPath {
		paths = append(paths, destPath)
	}
	newValues := make(map[StatePath]any, len(paths))
	for _, p := range paths {
		v, _ := valueAtPathLocal(o.state, p)
		newValues[p] = DeepCloneAny(v)
	}

	if o.batchDepth > 0 {
		if o.batchChanges == nil {
			o.batchChanges = &StateChange{
				Paths:     []StatePath{},
				NewValues: make(map[StatePath]any),
			}
		}
		o.batchChanges.Paths = append(o.batchChanges.Paths, paths...)
		for k, v := range newValues {
			o.batchChanges.NewValues[k] = v
		}
		o.mu.Unlock()
		return true
	}

	o.lastSnapshot = DeepClone(o.state)
	o.mu.Unlock()

	o.options.OnChange(StateChange{Paths: paths, NewValues: newValues})
	return true
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

// pathMove moves element `from` of the array at fromPath to become index
// `to` of the array at toPath (may be the same path). Returns false and
// leaves obj untouched unless both paths resolve to arrays and `from` is in
// range. `to` is clamped to [0, dest.len()] AFTER removal. A same-array
// move with from == to is a no-op returning true.
//
// This is a Go mirror of the engine's canonical `portable::path_move`
// (hypen-engine-rs/src/portable/path.rs, hypen-web/docs/dnd.md) —
// unlike the other path helpers in this file it does not round-trip through
// the embedded WASM, so it must reproduce every case pinned by
// engine-compatibility-tests/fixtures/dnd/path-move.json (see dnd_test.go).
// Nested-destination rule: when toPath lies under an element of the source
// array (tree DnD, `entries` → `entries.2.children`) the removal shifts later
// siblings down by one, so the destination is re-addressed to the SAME
// element; a destination inside the moved element itself is refused.
// Arrays are the `[]any` produced by JSON decoding (what ObservableState
// holds after DeepClone); an empty path addresses the root, which for a
// map-rooted state is never an array.
func pathMove(obj map[string]any, fromPath string, from int, toPath string, to int) bool {
	_, _, moved := pathMoveResolved(obj, fromPath, from, toPath, to)
	return moved
}

// pathMoveResolved is pathMove that also reports where the source and
// destination arrays live AFTER the move — the destination re-addressed per
// the nested-destination rule, the source re-addressed when it hangs under
// an element of the destination array that the insertion pushed down — so
// ObservableState.Move can notify the right containers. On a failed move
// the input paths are echoed back.
func pathMoveResolved(obj map[string]any, fromPath string, from int, toPath string, to int) (string, string, bool) {
	if obj == nil || from < 0 || to < 0 {
		return fromPath, toPath, false
	}

	if fromPath == toPath {
		arr, ok := arrayAtPathLocal(obj, fromPath)
		if !ok || from >= len(arr) {
			return fromPath, toPath, false
		}
		if from == to {
			return fromPath, toPath, true
		}
		item := arr[from]
		arr = spliceRemove(arr, from)
		arr = spliceInsert(arr, min(to, len(arr)), item)
		return fromPath, toPath, replaceAtPathLocal(obj, fromPath, arr)
	}

	// Validate both ends before mutating anything.
	if _, ok := arrayAtPathLocal(obj, toPath); !ok {
		return fromPath, toPath, false
	}
	// A destination INSIDE the source array sees the removal shift its
	// siblings: the moved element itself is gone (refuse), and every element
	// past `from` is one index lower afterwards (re-address).
	origToPath := toPath
	if j, tail, ok := destinationIndexInSource(fromPath, toPath); ok {
		if j == from {
			return fromPath, toPath, false
		}
		if j > from {
			toPath = joinPath(fromPath, joinPath(strconv.Itoa(j-1), tail))
		}
	}

	src, ok := arrayAtPathLocal(obj, fromPath)
	if !ok || from >= len(src) {
		return fromPath, origToPath, false
	}
	item := src[from]
	if !replaceAtPathLocal(obj, fromPath, spliceRemove(src, from)) {
		return fromPath, origToPath, false
	}
	dst, ok := arrayAtPathLocal(obj, toPath)
	if !ok {
		// Unreachable after the validation above; kept as a safety net so a
		// failed move can never lose the element.
		replaceAtPathLocal(obj, fromPath, src)
		return fromPath, origToPath, false
	}
	to = min(to, len(dst))
	if !replaceAtPathLocal(obj, toPath, spliceInsert(dst, to, item)) {
		replaceAtPathLocal(obj, fromPath, src)
		return fromPath, origToPath, false
	}

	// The source array may itself hang under an element of the destination
	// array (`entries.0.children` → `entries`): inserting at or before that
	// element pushes it — and the source array with it — one index down.
	srcPath := fromPath
	if j, tail, ok := destinationIndexInSource(toPath, fromPath); ok && to <= j {
		srcPath = joinPath(toPath, joinPath(strconv.Itoa(j+1), tail))
	}
	return srcPath, toPath, true
}

// destinationIndexInSource reports, when toPath lies under an element of the
// array at fromPath, that element's index and the remaining path below it
// ("" = the element itself). ok is false when the destination is elsewhere.
func destinationIndexInSource(fromPath, toPath string) (int, string, bool) {
	rest := toPath
	if fromPath != "" {
		var found bool
		rest, found = strings.CutPrefix(toPath, fromPath)
		if !found {
			return 0, "", false
		}
		rest, found = strings.CutPrefix(rest, ".")
		if !found {
			return 0, "", false
		}
	}
	first, tail, _ := strings.Cut(rest, ".")
	idx, ok := parseIndex(first)
	if !ok {
		return 0, "", false
	}
	return idx, tail, true
}

// joinPath mirrors the Rust reference's `join_path`, extended so an empty
// `rest` returns base unchanged: the nested re-addressing rules join
// `<index>.<tail>` where the tail is "" when the destination (or source)
// array is a DIRECT element of the other array (arrays-of-arrays,
// `entries` -> `entries.2`), which Rust models as `tail: None` and joins as
// the bare index. Without this an "entries.1." path would never resolve.
func joinPath(base, rest string) string {
	switch {
	case base == "":
		return rest
	case rest == "":
		return base
	}
	return base + "." + rest
}

// parseIndex mirrors Rust's `str::parse::<usize>` closely enough for path
// segments: decimal digits only, no sign, no whitespace.
func parseIndex(seg string) (int, bool) {
	if seg == "" {
		return 0, false
	}
	for i := 0; i < len(seg); i++ {
		if seg[i] < '0' || seg[i] > '9' {
			return 0, false
		}
	}
	n, err := strconv.Atoi(seg)
	if err != nil || n < 0 {
		return 0, false
	}
	return n, true
}

// valueAtPathLocal is an in-process mirror of the engine's `path_get`
// navigation (numeric segments index arrays, otherwise they are object
// keys). Used only by pathMove, which needs Go-side mutation of the
// containers it resolves.
func valueAtPathLocal(root any, path string) (any, bool) {
	if path == "" {
		return root, true
	}
	current := root
	for _, part := range strings.Split(path, ".") {
		switch c := current.(type) {
		case map[string]any:
			v, ok := c[part]
			if !ok {
				return nil, false
			}
			current = v
		case []any:
			idx, ok := parseIndex(part)
			if !ok || idx >= len(c) {
				return nil, false
			}
			current = c[idx]
		default:
			return nil, false
		}
	}
	return current, true
}

func arrayAtPathLocal(root any, path string) ([]any, bool) {
	v, ok := valueAtPathLocal(root, path)
	if !ok {
		return nil, false
	}
	arr, ok := v.([]any)
	return arr, ok
}

// replaceAtPathLocal overwrites the value at an EXISTING path (no
// auto-vivification — pathMove only ever writes back arrays it resolved a
// moment earlier). Returns false if the parent no longer resolves.
func replaceAtPathLocal(root map[string]any, path string, value any) bool {
	if path == "" {
		return false
	}
	parentPath, last := "", path
	if i := strings.LastIndex(path, "."); i >= 0 {
		parentPath, last = path[:i], path[i+1:]
	}
	var parent any = root
	if parentPath != "" {
		var ok bool
		parent, ok = valueAtPathLocal(root, parentPath)
		if !ok {
			return false
		}
	}
	switch p := parent.(type) {
	case map[string]any:
		p[last] = value
		return true
	case []any:
		idx, ok := parseIndex(last)
		if !ok || idx >= len(p) {
			return false
		}
		p[idx] = value
		return true
	default:
		return false
	}
}

// spliceRemove returns a fresh slice without element i (i must be in range).
func spliceRemove(arr []any, i int) []any {
	out := make([]any, 0, len(arr)-1)
	out = append(out, arr[:i]...)
	return append(out, arr[i+1:]...)
}

// spliceInsert returns a fresh slice with item inserted at i (0 <= i <= len).
func spliceInsert(arr []any, i int, item any) []any {
	out := make([]any, 0, len(arr)+1)
	out = append(out, arr[:i]...)
	out = append(out, item)
	return append(out, arr[i:]...)
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
