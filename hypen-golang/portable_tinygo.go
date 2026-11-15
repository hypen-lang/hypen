//go:build tinygo

// Pure-Go implementations of the canonical portable helpers, for TinyGo
// builds where the embedded wazero engine (portable.go / wasm_engine.go) is
// unavailable. These let the authoring API (AppBuilder / ObservableState /
// ModuleDefinition) compile to a wasm component via `hypen build --target wasm`.
//
// The path and diff helpers are faithful ports of the canonical engine
// implementations (`hypen-engine-rs/src/portable/{path,diff}.rs`) — the same
// dotted-path / auto-vivification / diff semantics every Hypen SDK relies on,
// so a reducer's state mutations behave identically to the engine-backed path.
//
// The router / url / session helpers are not on a logic module's runtime path
// (a pure reducer never navigates or manages sessions), so they are stubs that
// fail loudly if a TinyGo-built module somehow reaches them.
package core

import (
	"encoding/json"
	"errors"
	"strconv"
)

// PortableDiffEntry is one (path, value) pair returned by diffPathsViaEngine.
type PortableDiffEntry struct {
	Path  string `json:"path"`
	Value any    `json:"value"`
}

// PortableRouteMatch is the result of matchPathViaEngine.
type PortableRouteMatch struct {
	Matched bool              `json:"matched"`
	Params  map[string]string `json:"params"`
}

var errNoEngineTinyGo = errors.New(
	"this operation needs the embedded engine, which is unavailable in a " +
		"TinyGo-built module (routing/sessions run host-side, not in the module)",
)

// ─── path helpers (port of portable/path.rs) ────────────────────────────────

func cloneJSON(v any) any {
	b, err := json.Marshal(v)
	if err != nil {
		return v
	}
	var out any
	if err := json.Unmarshal(b, &out); err != nil {
		return v
	}
	return out
}

func pathGetViaEngine(state any, path string) (any, error) {
	if path == "" {
		return state, nil
	}
	cur := state
	for _, part := range splitPath(path) {
		switch node := cur.(type) {
		case map[string]any:
			v, ok := node[part]
			if !ok {
				return nil, nil
			}
			cur = v
		case []any:
			idx, err := strconv.Atoi(part)
			if err != nil || idx < 0 || idx >= len(node) {
				return nil, nil
			}
			cur = node[idx]
		default:
			return nil, nil
		}
	}
	return cur, nil
}

func pathHasViaEngine(state any, path string) (bool, error) {
	if path == "" {
		return true, nil
	}
	cur := state
	for _, part := range splitPath(path) {
		switch node := cur.(type) {
		case map[string]any:
			v, ok := node[part]
			if !ok {
				return false, nil
			}
			cur = v
		case []any:
			idx, err := strconv.Atoi(part)
			if err != nil || idx < 0 || idx >= len(node) {
				return false, nil
			}
			cur = node[idx]
		default:
			return false, nil
		}
	}
	return true, nil
}

func pathSetViaEngine(state any, path string, value any) (map[string]any, error) {
	root := asRootMap(cloneJSON(state))
	if path == "" {
		return root, nil
	}
	var anyRoot any = root
	anyRoot = setRecursive(anyRoot, splitPath(path), value)
	return asRootMap(anyRoot), nil
}

func pathDeleteViaEngine(state any, path string) (map[string]any, bool, error) {
	root := asRootMap(cloneJSON(state))
	if path == "" {
		return root, false, nil
	}
	var anyRoot any = root
	newRoot, removed := deleteRecursive(anyRoot, splitPath(path))
	return asRootMap(newRoot), removed, nil
}

// setRecursive writes value at parts within node, auto-vivifying objects and
// growing arrays with nil padding — mirrors path_set in portable/path.rs.
func setRecursive(node any, parts []string, value any) any {
	if len(parts) == 0 {
		return value
	}
	part := parts[0]
	rest := parts[1:]

	if idx, err := strconv.Atoi(part); err == nil {
		if arr, ok := node.([]any); ok {
			for len(arr) <= idx {
				arr = append(arr, nil)
			}
			arr[idx] = setRecursive(arr[idx], rest, value)
			return arr
		}
	}
	m, ok := node.(map[string]any)
	if !ok {
		m = map[string]any{}
	}
	m[part] = setRecursive(m[part], rest, value)
	return m
}

func deleteRecursive(node any, parts []string) (any, bool) {
	if len(parts) == 0 {
		return node, false
	}
	part := parts[0]
	if len(parts) == 1 {
		if idx, err := strconv.Atoi(part); err == nil {
			if arr, ok := node.([]any); ok {
				if idx >= 0 && idx < len(arr) {
					return append(arr[:idx], arr[idx+1:]...), true
				}
				return arr, false
			}
		}
		if m, ok := node.(map[string]any); ok {
			if _, present := m[part]; present {
				delete(m, part)
				return m, true
			}
			return m, false
		}
		return node, false
	}

	rest := parts[1:]
	if idx, err := strconv.Atoi(part); err == nil {
		if arr, ok := node.([]any); ok {
			if idx >= 0 && idx < len(arr) {
				child, removed := deleteRecursive(arr[idx], rest)
				arr[idx] = child
				return arr, removed
			}
			return arr, false
		}
	}
	if m, ok := node.(map[string]any); ok {
		child, present := m[part]
		if !present {
			return m, false
		}
		newChild, removed := deleteRecursive(child, rest)
		m[part] = newChild
		return m, removed
	}
	return node, false
}

func splitPath(path string) []string {
	out := []string{}
	start := 0
	for i := 0; i < len(path); i++ {
		if path[i] == '.' {
			out = append(out, path[start:i])
			start = i + 1
		}
	}
	out = append(out, path[start:])
	return out
}

func asRootMap(v any) map[string]any {
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return map[string]any{}
}

// ─── diff (port of portable/diff.rs) ─────────────────────────────────────────

func diffPathsViaEngine(old, new any) ([]PortableDiffEntry, error) {
	out := []PortableDiffEntry{}
	diffInto("", cloneJSON(old), cloneJSON(new), &out)
	return out, nil
}

func diffInto(prefix string, old, new any, out *[]PortableDiffEntry) {
	oldMap, oldIsMap := old.(map[string]any)
	newMap, newIsMap := new.(map[string]any)
	if oldIsMap && newIsMap {
		for k, ov := range oldMap {
			p := joinPath(prefix, k)
			if nv, ok := newMap[k]; ok {
				diffInto(p, ov, nv, out)
			} else {
				*out = append(*out, PortableDiffEntry{Path: p, Value: nil})
			}
		}
		for k, nv := range newMap {
			if _, ok := oldMap[k]; !ok {
				*out = append(*out, PortableDiffEntry{Path: joinPath(prefix, k), Value: nv})
			}
		}
		return
	}

	oldArr, oldIsArr := old.([]any)
	newArr, newIsArr := new.([]any)
	if oldIsArr && newIsArr {
		if len(newArr) < len(oldArr) && prefix != "" {
			*out = append(*out, PortableDiffEntry{Path: prefix, Value: newArr})
			return
		}
		maxLen := len(oldArr)
		if len(newArr) > maxLen {
			maxLen = len(newArr)
		}
		for i := 0; i < maxLen; i++ {
			p := joinPath(prefix, strconv.Itoa(i))
			switch {
			case i < len(oldArr) && i < len(newArr):
				diffInto(p, oldArr[i], newArr[i], out)
			case i >= len(oldArr):
				*out = append(*out, PortableDiffEntry{Path: p, Value: newArr[i]})
			default:
				*out = append(*out, PortableDiffEntry{Path: p, Value: nil})
			}
		}
		return
	}

	if !jsonEqual(old, new) && prefix != "" {
		*out = append(*out, PortableDiffEntry{Path: prefix, Value: new})
	}
}

// joinPath lives in state.go (shared by both build configurations); its
// empty-prefix behavior is identical to the canonical diff's join.

// jsonEqual compares two JSON-shaped scalars by marshaled form — avoids
// reflect.DeepEqual surprises across numeric kinds while staying TinyGo-safe.
func jsonEqual(a, b any) bool {
	ab, err1 := json.Marshal(a)
	bb, err2 := json.Marshal(b)
	if err1 != nil || err2 != nil {
		return false
	}
	if len(ab) != len(bb) {
		return false
	}
	for i := range ab {
		if ab[i] != bb[i] {
			return false
		}
	}
	return true
}

// ─── router / url / session — not on a reducer's runtime path ────────────────

func matchPathViaEngine(pattern, path string) (PortableRouteMatch, error) {
	return PortableRouteMatch{}, errNoEngineTinyGo
}

func parseQueryViaEngine(full string) (string, map[string]string, error) {
	return "", nil, errNoEngineTinyGo
}

func buildURLViaEngine(path string, query map[string]string) (string, error) {
	return "", errNoEngineTinyGo
}

func decodeURIComponentViaEngine(input string) (string, error) {
	return "", errNoEngineTinyGo
}

func sessionStepViaEngine(policy ConcurrentPolicy, existingCount uint32) (string, error) {
	return "", errNoEngineTinyGo
}

// NewDefaultEngine is unavailable under TinyGo (it constructs the wazero-backed
// WasmEngine). A TinyGo-built module is driven by the host engine, not an
// embedded one, so CreateInstance() is never used in that mode.
func NewDefaultEngine() (IEngine, error) {
	return nil, errNoEngineTinyGo
}
