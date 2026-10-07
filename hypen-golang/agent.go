package core

import (
	"encoding/json"
	"fmt"

	"github.com/tetratelabs/wazero/api"
)

// agent.go — the engine's external capability surface, for callers that are
// NOT the rendered UI: MCP servers, REST APIs, CLIs, agents.
//
// DispatchAction fires whatever handler name it is handed, including
// `__hypen_bind` (an arbitrary state write) and `router.replace`. That is
// correct for a renderer, whose reachable set is bounded by what is on
// screen, and wrong for anyone else. The functions here route through the
// engine's guarded entry points instead, which accept only what the
// developer declared: `.onAction()` handlers, `Router { Route(...) }` paths,
// and `.bind(@state.x)` fields.
//
// The rule itself lives in Rust (hypen-engine-rs/src/agent_core.rs) and is
// shared by every SDK. This file is the Go binding surface — it must never
// re-implement the check, only carry the call across the FFI boundary.

// External names of the framework-provided capabilities. They mirror the
// constants in hypen-engine-rs/src/agent.rs and are offered for convenience
// only — the engine's guard, not this list, decides what is dispatchable, and
// ListActions reports which of them the current app actually declares.
//
// The `hypen.` prefix is reserved: it keeps a built-in from colliding with a
// real module action (Link declares its own "navigate"), and modules may not
// declare names under it.
const (
	// ActionNavigate takes {"to": "/path"} and lowers to router.push.
	ActionNavigate = "hypen.navigate"
	// ActionBack takes no payload and lowers to router.back.
	ActionBack = "hypen.back"
	// ActionSetInput takes {"field": "...", "value": ...} and lowers to
	// __hypen_bind — but only after the field is matched against the
	// .bind()-declared set reported by ListBindings.
	ActionSetInput = "hypen.set_input"
)

// AgentAction is one externally dispatchable action.
type AgentAction struct {
	// Name an external caller passes to DispatchExternal. For module
	// actions this is the declared action name; for built-ins it is the
	// external alias ("hypen.navigate", "hypen.back", "hypen.set_input").
	Name string `json:"name"`
	// Owning module scope. Empty for the primary module and for built-ins.
	Module string `json:"module"`
	// True for framework-provided capabilities, false for module actions.
	Builtin bool `json:"builtin"`
}

// AgentRoute is one declared route, as a navigation target for
// "hypen.navigate".
type AgentRoute struct {
	// Pattern exactly as declared (e.g. "/user-profile/:id").
	Path string `json:"path"`
	// Names of the :param segments, in order. Empty for a static route.
	Params []string `json:"params"`
	// Module scope of the enclosing Router, if any.
	ModuleScope string `json:"moduleScope"`
}

// BoundInput is one .bind()-declared writable input, as a field for
// "hypen.set_input".
type BoundInput struct {
	// State path the bind writes, exactly as .bind(@state.x) declared it.
	Path string `json:"path"`
	// Prop the value lands on — "value", "checked", "on" or "playback".
	// "checked"/"on" mean the field is boolean, so a caller can type the
	// field without reading state first.
	Prop string `json:"prop"`
	// Element type that declared the bind ("Input", "Checkbox", …).
	ElementType string `json:"elementType"`
	// Module scope of the declaring element, if any.
	ModuleScope string `json:"moduleScope"`
	// Pattern of the enclosing Route, if any — which screen the field is
	// on. The same field name under two routes is two different form
	// fields to a caller deciding what to fill in. Empty for a bind
	// declared outside any Route.
	Route string `json:"route,omitempty"`
	// The field's human label, taken from a static "placeholder" or
	// "label" prop and from nothing else. An interpolated placeholder
	// yields "" here, never its rendered value — the engine does not read
	// state into the manifest.
	Label string `json:"label,omitempty"`
}

// moduleUnregisterer is implemented by engines that can drop a destroyed
// module's externally reachable surface. Asserted for rather than added to
// IEngine so alternative implementations (MockEngine, remote engines) stay
// valid without it.
type moduleUnregisterer interface {
	UnregisterModule(name string)
}

// ListActions returns every action an external caller may dispatch right
// now: module-declared actions plus hypen.navigate / hypen.back /
// hypen.set_input, the
// last three only when the app declares the backing Router or .bind().
// Framework internals never appear.
func (e *WasmEngine) ListActions() ([]AgentAction, error) {
	var actions []AgentAction
	if err := e.readExternalList("list_external_actions", e.fnListExternalActions, &actions); err != nil {
		return nil, err
	}
	return actions, nil
}

// ListRoutes returns the app's declared routes — the argument schema for
// hypen.navigate. Read from the declared route table rather than the rendered
// route, so it changes with the template, not with navigation.
func (e *WasmEngine) ListRoutes() ([]AgentRoute, error) {
	var routes []AgentRoute
	if err := e.readExternalList("list_routes", e.fnListRoutes, &routes); err != nil {
		return nil, err
	}
	return routes, nil
}

// ListBindings returns every .bind()-declared writable input — the argument
// schema for hypen.set_input. A bind inside an unrendered branch is still
// listed: writing it is idempotent, and excluding it would churn the field
// list on every re-render.
func (e *WasmEngine) ListBindings() ([]BoundInput, error) {
	var bindings []BoundInput
	if err := e.readExternalList("list_bindings", e.fnListBindings, &bindings); err != nil {
		return nil, err
	}
	return bindings, nil
}

// readExternalList calls a no-argument listing export and decodes its JSON
// result from the engine's external-result buffer into out.
func (e *WasmEngine) readExternalList(op string, fn api.Function, out any) error {
	e.mu.Lock()
	defer e.mu.Unlock()

	if fn == nil || e.fnGetExternalResultLen == nil {
		return &EngineError{Code: ErrRender, Message: "hypen_" + op + " not available in WASM module"}
	}

	results, err := fn.Call(e.ctx)
	if err != nil {
		return &EngineError{Code: ErrRender, Message: op + " call failed", Cause: err}
	}
	if len(results) > 0 && results[0] != 0 {
		return &EngineError{
			Code:    ErrRender,
			Message: fmt.Sprintf("%s failed with code %d: %s", op, results[0], e.readLastError()),
		}
	}

	raw, err := e.readExternalResult()
	if err != nil {
		return err
	}
	if len(raw) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("%s: failed to parse result: %w", op, err)
	}
	return nil
}

// DispatchExternal dispatches an action on behalf of a caller that is not
// the rendered UI, then runs the registered handler for the *resolved*
// internal action — hypen.navigate arrives as router.push, hypen.set_input as
// __hypen_bind with a payload the engine's guard built from the declared
// bind set, never the one the caller supplied.
//
// Returns ErrActionNotFound when the name is not externally dispatchable,
// when a built-in is used in an app that does not declare the backing
// surface, or when hypen.set_input names an undeclared field.
func (e *WasmEngine) DispatchExternal(name string, payload any) error {
	action, err := e.dispatchExternalAndReadAction(name, payload)
	if err != nil {
		return err
	}
	if action == nil {
		return nil // authorised, but the host registered no handler for it
	}

	// Handler runs WITHOUT the WASM mutex so it can call UpdateState
	// freely — same two-phase shape as DispatchAction.
	if handler, ok := e.actionHandlers[action.Name]; ok && handler != nil {
		handler(*action)
	}
	return nil
}

// dispatchExternalAndReadAction sends the external dispatch to WASM and
// reads back the resolved action the guard queued. Holds the mutex only for
// the WASM calls.
func (e *WasmEngine) dispatchExternalAndReadAction(name string, payload any) (*Action, error) {
	e.mu.Lock()
	defer e.mu.Unlock()

	if e.fnDispatchExternal == nil {
		return nil, &EngineError{Code: ErrActionNotFound, Message: "hypen_dispatch_external not available in WASM module"}
	}

	namePtr, nameSize, err := e.writeString(name)
	if err != nil {
		return nil, err
	}
	defer e.freePtr(namePtr, nameSize)

	// A nil payload is passed as a zero-length buffer: the guard
	// distinguishes "no payload" from an empty one (hypen.set_input
	// requires one, hypen.back takes none).
	var payloadPtr, payloadSize uint32
	if payload != nil {
		jsonBytes, err := json.Marshal(payload)
		if err != nil {
			return nil, err
		}
		payloadPtr, payloadSize, err = e.writeString(string(jsonBytes))
		if err != nil {
			return nil, err
		}
		defer e.freePtr(payloadPtr, payloadSize)
	}

	results, err := e.fnDispatchExternal.Call(e.ctx,
		uint64(namePtr), uint64(nameSize),
		uint64(payloadPtr), uint64(payloadSize))
	if err != nil {
		return nil, &EngineError{Code: ErrActionNotFound, Message: "dispatch external call failed", Cause: err}
	}
	if len(results) > 0 && results[0] != 0 {
		// The engine's message names the exact refusal (unknown action,
		// undeclared hypen.set_input field, built-in with no declaration), so
		// carry it through instead of flattening it to a code.
		return nil, newExternalDispatchError(results[0], e.readLastError())
	}

	return e.readPendingActionLocked()
}

// GetStateAt reads module state, whole or at a dotted path. Pass nil for
// module to read the primary module, or a registered module's name
// (case-insensitive); pass nil for path to read the whole tree.
//
// Returns JSON "null" when the module is unknown *or* the path is absent —
// the engine deliberately does not distinguish the two, so a caller cannot
// probe for state it is not being shown.
func (e *WasmEngine) GetStateAt(module, path *string) (json.RawMessage, error) {
	e.mu.Lock()
	defer e.mu.Unlock()

	if e.fnGetStateAt == nil {
		return nil, &EngineError{Code: ErrState, Message: "hypen_get_state_at not available in WASM module"}
	}

	var moduleStr, pathStr string
	if module != nil {
		moduleStr = *module
	}
	if path != nil {
		pathStr = *path
	}

	modulePtr, moduleSize, err := e.writeString(moduleStr)
	if err != nil {
		return nil, err
	}
	defer e.freePtr(modulePtr, moduleSize)

	pathPtr, pathSize, err := e.writeString(pathStr)
	if err != nil {
		return nil, err
	}
	defer e.freePtr(pathPtr, pathSize)

	results, err := e.fnGetStateAt.Call(e.ctx,
		uint64(modulePtr), uint64(moduleSize),
		uint64(pathPtr), uint64(pathSize))
	if err != nil {
		return nil, &EngineError{Code: ErrState, Message: "get state at call failed", Cause: err}
	}
	if len(results) > 0 && results[0] != 0 {
		return nil, &EngineError{
			Code:    ErrState,
			Message: fmt.Sprintf("get_state_at failed with code %d: %s", results[0], e.readLastError()),
		}
	}

	raw, err := e.readExternalResult()
	if err != nil {
		return nil, err
	}
	if len(raw) == 0 {
		return json.RawMessage("null"), nil
	}
	return json.RawMessage(raw), nil
}

// UnregisterModule drops a module and every action it declared, so a
// destroyed module's state and actions stop being externally reachable.
//
// Call this on DESTROY only. The engine's module registry is otherwise
// append-only by design, and that retention is load-bearing: under the
// default persist behaviour ManagedRouter keeps an off-screen module
// registered precisely so siblings can still read its state. Calling this on
// an ordinary unmount would break the persist cache and every cross-module
// read. Unknown names are a no-op.
func (e *WasmEngine) UnregisterModule(name string) {
	e.mu.Lock()
	defer e.mu.Unlock()

	if e.fnUnregisterModule == nil {
		logModule.Error("UnregisterModule: hypen_unregister_module not available in WASM module")
		return
	}

	ptr, size, err := e.writeString(name)
	if err != nil {
		logModule.Error("UnregisterModule: failed to write name: %v", err)
		return
	}
	defer e.freePtr(ptr, size)

	results, err := e.fnUnregisterModule.Call(e.ctx, uint64(ptr), uint64(size))
	if err != nil {
		logModule.Error("UnregisterModule WASM call failed: %v", err)
	} else if len(results) > 0 && results[0] != 0 {
		logModule.Error("UnregisterModule returned non-zero status: %d", results[0])
	}
}

// newExternalDispatchError maps a hypen_dispatch_external return code to an
// EngineError. Code 4 is the guard's refusal — the interesting one, and the
// only outcome an external caller can provoke with a well-formed call.
func newExternalDispatchError(code uint64, detail string) *EngineError {
	msg := detail
	switch code {
	case 1:
		if msg == "" {
			msg = "invalid action name or payload string"
		}
		return &EngineError{Code: ErrActionNotFound, Message: msg}
	case 2:
		if msg == "" {
			msg = "invalid payload JSON"
		}
		return &EngineError{Code: ErrState, Message: msg}
	case 3:
		if msg == "" {
			msg = "engine not initialized"
		}
		return &EngineError{Code: ErrNotInitialized, Message: msg}
	case 4:
		if msg == "" {
			msg = "action is not externally dispatchable"
		}
		return &EngineError{Code: ErrActionNotFound, Message: msg}
	default:
		return &EngineError{
			Code:    ErrActionNotFound,
			Message: fmt.Sprintf("dispatch_external failed with code %d: %s", code, detail),
		}
	}
}

// readExternalResult copies the JSON result of the last external-surface
// call out of WASM memory. Caller must hold the mutex.
//
// The external surface has a buffer of its own rather than sharing the
// portable-helper buffer, so a host that interleaves the two — routers call
// hypen_portable_match_path on every navigation — cannot clobber one result
// with the other.
func (e *WasmEngine) readExternalResult() ([]byte, error) {
	results, err := e.fnGetExternalResultLen.Call(e.ctx)
	if err != nil {
		return nil, err
	}
	length := uint32(results[0])
	if length == 0 {
		return nil, nil
	}

	ptrResults, err := e.fnAlloc.Call(e.ctx, uint64(length))
	if err != nil {
		return nil, err
	}
	ptr := uint32(ptrResults[0])
	defer e.freePtr(ptr, length)

	if _, err := e.fnGetExternalResult.Call(e.ctx, uint64(ptr), uint64(length)); err != nil {
		return nil, err
	}

	buf, ok := e.module.Memory().Read(ptr, length)
	if !ok {
		return nil, fmt.Errorf("external result: memory read out of range")
	}
	// Memory().Read hands back a borrowed slice; copy before the deferred free.
	out := make([]byte, len(buf))
	copy(out, buf)
	return out, nil
}

// readLastError drains the engine's error buffer. Returns "" when the
// module predates the error-reporting exports or nothing was recorded.
// Caller must hold the mutex.
func (e *WasmEngine) readLastError() string {
	if e.fnGetLastErrorLen == nil || e.fnGetLastError == nil {
		return ""
	}
	results, err := e.fnGetLastErrorLen.Call(e.ctx)
	if err != nil {
		return ""
	}
	length := uint32(results[0])
	if length == 0 {
		return ""
	}

	ptrResults, err := e.fnAlloc.Call(e.ctx, uint64(length))
	if err != nil {
		return ""
	}
	ptr := uint32(ptrResults[0])
	defer e.freePtr(ptr, length)

	if _, err := e.fnGetLastError.Call(e.ctx, uint64(ptr), uint64(length)); err != nil {
		return ""
	}
	msg, err := e.readString(ptr, length)
	if err != nil {
		return ""
	}
	if e.fnClearLastError != nil {
		_, _ = e.fnClearLastError.Call(e.ctx)
	}
	return msg
}
