package core

import (
	"encoding/json"
	"math"
	"strconv"
)

// dnd.go — host side of drag-and-drop (hypen-web/docs/dnd.md).
//
// Renderers own the whole drag; on drop they dispatch one of two reserved
// actions that the SDK applies to the module's tracked state (never to
// engine state directly), exactly like `__hypen_bind`:
//
//	__hypen_reorder  { fromPath, from, toPath, to }   or   { path, from, to }
//	__hypen_pin      { path, x, y, xKey, yKey }
//
// Both handlers warn and no-op on malformed input — author/renderer input
// is never allowed to panic the host.

const (
	// ReorderActionName is the reserved action a renderer dispatches when a
	// `.sortable` drop reorders (or cross-list moves) an item. Semantics =
	// pathMove / engine `portable::path_move`: `to` is the moved item's
	// FINAL index in the destination array.
	ReorderActionName = "__hypen_reorder"
	// PinActionName is the reserved action a renderer dispatches when a
	// `.pinboard` drop repositions an item. `path` is the item's base path
	// ("<bindPath>.<index>" in user-field mode, "__dnd.<group>.<key>" in
	// reserved mode); the host writes `path.xKey` and `path.yKey` in one
	// batched flush.
	PinActionName = "__hypen_pin"
)

// ApplyReorderAction applies a `__hypen_reorder` payload to state. Accepts
// `path` as shorthand for fromPath == toPath. Explicit fromPath/toPath win
// when both are given; when fromPath is explicit, `path` is ignored entirely
// and a missing toPath defaults to fromPath (TS/Kotlin/Swift precedence).
// Returns the move's `moved` flag; a malformed payload logs a warning and
// returns false without touching state.
func ApplyReorderAction(state *ObservableState, payload any) bool {
	if state == nil {
		return false
	}
	m, ok := payload.(map[string]any)
	if !ok {
		logModule.Warn("%s: expected an object payload, got %T — ignored", ReorderActionName, payload)
		return false
	}
	// Precedence matches the TS/Kotlin/Swift hosts exactly: `path` is only
	// consulted when fromPath is absent, and a missing toPath always defaults
	// to the resolved fromPath — never to `path`. So `{fromPath, path}` is a
	// same-list move within fromPath, not a cross-list move to `path`.
	fromPath, _ := m["fromPath"].(string)
	if fromPath == "" {
		fromPath, _ = m["path"].(string)
	}
	toPath, _ := m["toPath"].(string)
	// A payload carrying only fromPath is a same-list move (plan §6.11,
	// matching the TS core); only toPath is still malformed.
	if toPath == "" {
		toPath = fromPath
	}
	if fromPath == "" {
		logModule.Warn("%s: missing fromPath/toPath (or path) in %v — ignored", ReorderActionName, m)
		return false
	}
	from, ok := payloadIndex(m["from"])
	if !ok {
		logModule.Warn("%s: `from` must be a non-negative integer, got %v — ignored", ReorderActionName, m["from"])
		return false
	}
	to, ok := payloadIndex(m["to"])
	if !ok {
		logModule.Warn("%s: `to` must be a non-negative integer, got %v — ignored", ReorderActionName, m["to"])
		return false
	}
	if !state.Move(fromPath, from, toPath, to) {
		logModule.Warn("%s: %s[%d] -> %s[%d] did not resolve to arrays in range — state untouched",
			ReorderActionName, fromPath, from, toPath, to)
		return false
	}
	return true
}

// ApplyPinAction applies a `__hypen_pin` payload to state: two path sets
// (`path.xKey`, `path.yKey`) inside one batch so observers see a single
// change carrying both paths. xKey/yKey default to "x"/"y". Returns false
// (after a warning) when the payload is malformed; state is then untouched.
func ApplyPinAction(state *ObservableState, payload any) bool {
	if state == nil {
		return false
	}
	m, ok := payload.(map[string]any)
	if !ok {
		logModule.Warn("%s: expected an object payload, got %T — ignored", PinActionName, payload)
		return false
	}
	path, ok := m["path"].(string)
	if !ok || path == "" {
		logModule.Warn("%s: missing `path` in %v — ignored", PinActionName, m)
		return false
	}
	x, ok := payloadNumber(m["x"])
	if !ok {
		logModule.Warn("%s: `x` must be a finite number, got %v — ignored", PinActionName, m["x"])
		return false
	}
	y, ok := payloadNumber(m["y"])
	if !ok {
		logModule.Warn("%s: `y` must be a finite number, got %v — ignored", PinActionName, m["y"])
		return false
	}
	xKey := pinFieldKey(m, "xKey", "x")
	yKey := pinFieldKey(m, "yKey", "y")

	BatchStateUpdates(state, func() {
		state.Set(path+"."+xKey, x)
		state.Set(path+"."+yKey, y)
	})
	return true
}

// pinFieldKey reads an optional field-name override, falling back to def
// when absent, empty, or not a string (a wrong type warns — it is a
// renderer bug, not something to silently reinterpret).
func pinFieldKey(m map[string]any, name, def string) string {
	v, present := m[name]
	if !present || v == nil {
		return def
	}
	s, ok := v.(string)
	if !ok {
		logModule.Warn("%s: `%s` must be a string, got %T — using %q", PinActionName, name, v, def)
		return def
	}
	if s == "" {
		return def
	}
	return s
}

// payloadNumber coerces the numeric representations a payload can arrive in
// (JSON float64/json.Number over the wire, Go ints from in-process
// dispatch) to a finite float64.
func payloadNumber(v any) (float64, bool) {
	var f float64
	switch n := v.(type) {
	case float64:
		f = n
	case float32:
		f = float64(n)
	case int:
		f = float64(n)
	case int8:
		f = float64(n)
	case int16:
		f = float64(n)
	case int32:
		f = float64(n)
	case int64:
		f = float64(n)
	case uint:
		f = float64(n)
	case uint8:
		f = float64(n)
	case uint16:
		f = float64(n)
	case uint32:
		f = float64(n)
	case uint64:
		f = float64(n)
	case json.Number:
		parsed, err := strconv.ParseFloat(n.String(), 64)
		if err != nil {
			return 0, false
		}
		f = parsed
	default:
		return 0, false
	}
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return 0, false
	}
	return f, true
}

// payloadIndex coerces a payload number to a non-negative integral index.
// A fractional value (e.g. 1.5) is malformed rather than truncated.
func payloadIndex(v any) (int, bool) {
	f, ok := payloadNumber(v)
	if !ok || f < 0 || f != math.Trunc(f) || f > math.MaxInt32 {
		return 0, false
	}
	return int(f), true
}
