package core

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sync"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
	"github.com/tetratelabs/wazero/imports/wasi_snapshot_preview1"
)

// portable.go — thin Go wrappers over the engine's `hypen_portable_*` WASI
// exports. The canonical implementations of diff, route-match, and
// session-step live in Rust at hypen-engine-rs/src/portable/; this
// file is the Go binding surface.

// portableRuntime owns a minimal wazero runtime dedicated to evaluating
// the stateless `hypen_portable_*` functions. A single process-wide
// instance is enough; the three functions are pure and share no state
// with the main render engine.
type portableRuntime struct {
	ctx     context.Context
	runtime wazero.Runtime
	module  api.Module

	fnAlloc            api.Function
	fnFree             api.Function
	fnDiffPaths        api.Function
	fnMatchPath        api.Function
	fnDiscoverRouters  api.Function
	fnSessionStep      api.Function
	fnPathGet          api.Function
	fnPathHas          api.Function
	fnPathSet          api.Function
	fnPathDelete       api.Function
	fnEncodeURI        api.Function
	fnDecodeURI        api.Function
	fnParseQuery       api.Function
	fnBuildURL         api.Function
	fnGetResultLen     api.Function
	fnGetResult        api.Function
	fnGetLastErrorLen  api.Function
	fnGetLastError     api.Function
	fnClearLastError   api.Function
	fnInit             api.Function

	mu sync.Mutex
}

var (
	sharedPortable     *portableRuntime
	sharedPortableOnce sync.Once
	sharedPortableErr  error
)

// getPortable lazily instantiates a process-wide wazero runtime for the
// stateless portable helpers. Returns the same instance on every call.
func getPortable() (*portableRuntime, error) {
	sharedPortableOnce.Do(func() {
		sharedPortable, sharedPortableErr = newPortableRuntime(embeddedWasm)
	})
	return sharedPortable, sharedPortableErr
}

func newPortableRuntime(wasmBytes []byte) (*portableRuntime, error) {
	ctx := context.Background()
	runtime := wazero.NewRuntime(ctx)

	if _, err := wasi_snapshot_preview1.Instantiate(ctx, runtime); err != nil {
		runtime.Close(ctx)
		return nil, fmt.Errorf("portable: instantiate WASI: %w", err)
	}

	compiled, err := runtime.CompileModule(ctx, wasmBytes)
	if err != nil {
		runtime.Close(ctx)
		return nil, fmt.Errorf("portable: compile: %w", err)
	}

	module, err := runtime.InstantiateModule(ctx, compiled, wazero.NewModuleConfig().
		WithStdout(os.Stdout).
		WithStderr(os.Stderr))
	if err != nil {
		runtime.Close(ctx)
		return nil, fmt.Errorf("portable: instantiate module: %w", err)
	}

	p := &portableRuntime{
		ctx:               ctx,
		runtime:           runtime,
		module:            module,
		fnAlloc:           module.ExportedFunction("wasi_alloc"),
		fnFree:            module.ExportedFunction("wasi_free"),
		fnDiffPaths:       module.ExportedFunction("hypen_portable_diff_paths"),
		fnMatchPath:       module.ExportedFunction("hypen_portable_match_path"),
		fnDiscoverRouters: module.ExportedFunction("hypen_discover_routers"),
		fnSessionStep:     module.ExportedFunction("hypen_portable_session_step"),
		fnPathGet:         module.ExportedFunction("hypen_portable_path_get"),
		fnPathHas:         module.ExportedFunction("hypen_portable_path_has"),
		fnPathSet:         module.ExportedFunction("hypen_portable_path_set"),
		fnPathDelete:      module.ExportedFunction("hypen_portable_path_delete"),
		fnEncodeURI:       module.ExportedFunction("hypen_portable_encode_uri_component"),
		fnDecodeURI:       module.ExportedFunction("hypen_portable_decode_uri_component"),
		fnParseQuery:      module.ExportedFunction("hypen_portable_parse_query"),
		fnBuildURL:        module.ExportedFunction("hypen_portable_build_url"),
		fnGetResultLen:    module.ExportedFunction("hypen_get_portable_result_len"),
		fnGetResult:       module.ExportedFunction("hypen_get_portable_result"),
		fnGetLastErrorLen: module.ExportedFunction("hypen_get_last_error_len"),
		fnGetLastError:    module.ExportedFunction("hypen_get_last_error"),
		fnClearLastError:  module.ExportedFunction("hypen_clear_last_error"),
		fnInit:            module.ExportedFunction("hypen_init"),
	}

	for name, fn := range map[string]api.Function{
		"wasi_alloc":                          p.fnAlloc,
		"wasi_free":                           p.fnFree,
		"hypen_portable_diff_paths":           p.fnDiffPaths,
		"hypen_portable_match_path":           p.fnMatchPath,
		"hypen_discover_routers":              p.fnDiscoverRouters,
		"hypen_portable_session_step":         p.fnSessionStep,
		"hypen_portable_path_get":             p.fnPathGet,
		"hypen_portable_path_has":             p.fnPathHas,
		"hypen_portable_path_set":             p.fnPathSet,
		"hypen_portable_path_delete":          p.fnPathDelete,
		"hypen_portable_encode_uri_component": p.fnEncodeURI,
		"hypen_portable_decode_uri_component": p.fnDecodeURI,
		"hypen_portable_parse_query":          p.fnParseQuery,
		"hypen_portable_build_url":            p.fnBuildURL,
		"hypen_get_portable_result_len":       p.fnGetResultLen,
		"hypen_get_portable_result":           p.fnGetResult,
	} {
		if fn == nil {
			runtime.Close(ctx)
			return nil, fmt.Errorf("portable: WASM export missing: %s", name)
		}
	}

	// hypen_init keeps the error-buffer thread-local primed, but the
	// portable functions themselves don't require the main engine state.
	if p.fnInit != nil {
		_, _ = p.fnInit.Call(ctx)
	}

	return p, nil
}

// writeString copies `s` into WASM memory and returns (ptr, len).
// The caller owns the allocation and must free it with freePtr.
func (p *portableRuntime) writeString(s string) (uint32, uint32, error) {
	if s == "" {
		return 0, 0, nil
	}
	bytes := []byte(s)
	results, err := p.fnAlloc.Call(p.ctx, uint64(len(bytes)))
	if err != nil {
		return 0, 0, fmt.Errorf("portable: wasi_alloc: %w", err)
	}
	ptr := uint32(results[0])
	if !p.module.Memory().Write(ptr, bytes) {
		return 0, 0, fmt.Errorf("portable: memory write out of range")
	}
	return ptr, uint32(len(bytes)), nil
}

func (p *portableRuntime) freePtr(ptr, size uint32) {
	if ptr == 0 {
		return
	}
	_, _ = p.fnFree.Call(p.ctx, uint64(ptr), uint64(size))
}

// readResult pulls the JSON result of the last `hypen_portable_*` call
// back into host memory.
func (p *portableRuntime) readResult() ([]byte, error) {
	res, err := p.fnGetResultLen.Call(p.ctx)
	if err != nil {
		return nil, fmt.Errorf("portable: get_portable_result_len: %w", err)
	}
	length := uint32(res[0])
	if length == 0 {
		return nil, nil
	}
	ptrRes, err := p.fnAlloc.Call(p.ctx, uint64(length))
	if err != nil {
		return nil, fmt.Errorf("portable: wasi_alloc result buffer: %w", err)
	}
	ptr := uint32(ptrRes[0])
	defer p.freePtr(ptr, length)

	if _, err := p.fnGetResult.Call(p.ctx, uint64(ptr), uint64(length)); err != nil {
		return nil, fmt.Errorf("portable: hypen_get_portable_result: %w", err)
	}
	buf, ok := p.module.Memory().Read(ptr, length)
	if !ok {
		return nil, fmt.Errorf("portable: memory read out of range")
	}
	// memory.Read returns a borrowed slice; copy before freeing.
	out := make([]byte, len(buf))
	copy(out, buf)
	return out, nil
}

// readLastError retrieves any error message set by a failed portable call.
func (p *portableRuntime) readLastError() string {
	if p.fnGetLastErrorLen == nil || p.fnGetLastError == nil {
		return ""
	}
	res, err := p.fnGetLastErrorLen.Call(p.ctx)
	if err != nil {
		return ""
	}
	length := uint32(res[0])
	if length == 0 {
		return ""
	}
	ptrRes, err := p.fnAlloc.Call(p.ctx, uint64(length))
	if err != nil {
		return ""
	}
	ptr := uint32(ptrRes[0])
	defer p.freePtr(ptr, length)
	if _, err := p.fnGetLastError.Call(p.ctx, uint64(ptr), uint64(length)); err != nil {
		return ""
	}
	if p.fnClearLastError != nil {
		_, _ = p.fnClearLastError.Call(p.ctx)
	}
	buf, ok := p.module.Memory().Read(ptr, length)
	if !ok {
		return ""
	}
	return string(buf)
}

// ─── Public functions ───────────────────────────────────────────────────

// PortableDiffEntry is one (path, value) pair returned by diffPathsViaEngine.
type PortableDiffEntry struct {
	Path  string `json:"path"`
	Value any    `json:"value"`
}

// DiffPathsViaEngine is the exported form of [`diffPathsViaEngine`] —
// used directly by the cross-SDK compatibility runner in
// `engine-compatibility-tests/runners/golang/portable_test.go` to
// feed fixtures through this SDK's binding of the canonical engine
// function. Application code should typically not call it directly;
// [`diffState`] is the ObservableState-friendly form.
func DiffPathsViaEngine(old, new any) ([]PortableDiffEntry, error) {
	return diffPathsViaEngine(old, new)
}

// MatchPathViaEngine is the exported form of [`matchPathViaEngine`]
// for the compatibility runner.
func MatchPathViaEngine(pattern, path string) (PortableRouteMatch, error) {
	return matchPathViaEngine(pattern, path)
}

// SessionStepViaEngine is the exported form for the compatibility
// runner. `stateJSON` and `eventJSON` are the serialised SessionState
// and SessionEvent from the engine's portable module. Returns the
// serialised SessionEffect JSON.
func SessionStepViaEngine(stateJSON, eventJSON string) (string, error) {
	p, err := getPortable()
	if err != nil {
		return "", err
	}
	p.mu.Lock()
	defer p.mu.Unlock()

	statePtr, stateLen, err := p.writeString(stateJSON)
	if err != nil {
		return "", err
	}
	defer p.freePtr(statePtr, stateLen)
	eventPtr, eventLen, err := p.writeString(eventJSON)
	if err != nil {
		return "", err
	}
	defer p.freePtr(eventPtr, eventLen)

	results, err := p.fnSessionStep.Call(p.ctx,
		uint64(statePtr), uint64(stateLen),
		uint64(eventPtr), uint64(eventLen))
	if err != nil {
		return "", err
	}
	if results[0] != 0 {
		return "", fmt.Errorf("SessionStepViaEngine: rc=%d: %s", results[0], p.readLastError())
	}
	buf, err := p.readResult()
	if err != nil {
		return "", err
	}
	return string(buf), nil
}

// diffPathsViaEngine computes the dotted-path diff between two JSON-
// serialisable Go values. It routes through the engine's canonical
// `hypen_portable_diff_paths` — the Go SDK does NOT implement the
// algorithm itself.
func diffPathsViaEngine(old, new any) ([]PortableDiffEntry, error) {
	p, err := getPortable()
	if err != nil {
		return nil, err
	}
	oldJSON, err := json.Marshal(old)
	if err != nil {
		return nil, fmt.Errorf("diffPathsViaEngine: marshal old: %w", err)
	}
	newJSON, err := json.Marshal(new)
	if err != nil {
		return nil, fmt.Errorf("diffPathsViaEngine: marshal new: %w", err)
	}

	p.mu.Lock()
	defer p.mu.Unlock()

	oldPtr, oldLen, err := p.writeString(string(oldJSON))
	if err != nil {
		return nil, err
	}
	defer p.freePtr(oldPtr, oldLen)
	newPtr, newLen, err := p.writeString(string(newJSON))
	if err != nil {
		return nil, err
	}
	defer p.freePtr(newPtr, newLen)

	results, err := p.fnDiffPaths.Call(p.ctx,
		uint64(oldPtr), uint64(oldLen),
		uint64(newPtr), uint64(newLen))
	if err != nil {
		return nil, fmt.Errorf("diffPathsViaEngine: call: %w", err)
	}
	if results[0] != 0 {
		return nil, fmt.Errorf("diffPathsViaEngine: rc=%d: %s", results[0], p.readLastError())
	}

	buf, err := p.readResult()
	if err != nil {
		return nil, err
	}
	if len(buf) == 0 {
		return nil, nil
	}
	var entries []PortableDiffEntry
	if err := json.Unmarshal(buf, &entries); err != nil {
		return nil, fmt.Errorf("diffPathsViaEngine: unmarshal: %w", err)
	}
	return entries, nil
}

// PortableRouteMatch is the result of matchPathViaEngine.
type PortableRouteMatch struct {
	Matched bool              `json:"matched"`
	Params  map[string]string `json:"params"`
}

// matchPathViaEngine runs a URL pattern match through the engine's
// canonical `hypen_portable_match_path`.
func matchPathViaEngine(pattern, path string) (PortableRouteMatch, error) {
	p, err := getPortable()
	if err != nil {
		return PortableRouteMatch{}, err
	}

	p.mu.Lock()
	defer p.mu.Unlock()

	patPtr, patLen, err := p.writeString(pattern)
	if err != nil {
		return PortableRouteMatch{}, err
	}
	defer p.freePtr(patPtr, patLen)
	pathPtr, pathLen, err := p.writeString(path)
	if err != nil {
		return PortableRouteMatch{}, err
	}
	defer p.freePtr(pathPtr, pathLen)

	results, err := p.fnMatchPath.Call(p.ctx,
		uint64(patPtr), uint64(patLen),
		uint64(pathPtr), uint64(pathLen))
	if err != nil {
		return PortableRouteMatch{}, fmt.Errorf("matchPathViaEngine: call: %w", err)
	}
	if results[0] != 0 {
		return PortableRouteMatch{}, fmt.Errorf("matchPathViaEngine: rc=%d: %s", results[0], p.readLastError())
	}

	buf, err := p.readResult()
	if err != nil {
		return PortableRouteMatch{}, err
	}
	var out PortableRouteMatch
	if err := json.Unmarshal(buf, &out); err != nil {
		return PortableRouteMatch{}, fmt.Errorf("matchPathViaEngine: unmarshal: %w", err)
	}
	return out, nil
}

// ─── Route discovery ────────────────────────────────────────────────────

// DiscoveredRoute is one entry inside a DiscoveredRouter.
type DiscoveredRoute struct {
	// URL pattern (`/`, `/user-profile/:id`).
	Path string `json:"path"`
	// BFS-ordered element names inside the route body. SDK consumers
	// (e.g. RemoteSession auto-router) pick the first name registered
	// as a module in HypenApp.
	ElementNames []string `json:"element_names"`
}

// DiscoveredRouter describes one `Router { Route(path) { ... } ... }`
// block found in a template.
type DiscoveredRouter struct {
	// The enclosing `module X { ... }` scope (lowercased) of the
	// Router, or empty string at document root.
	ModuleScope string            `json:"module_scope,omitempty"`
	Routes      []DiscoveredRoute `json:"routes"`
}

// DiscoverRouters parses a Hypen DSL source and returns every
// `Router { Route ... }` block it contains. Mirrors the TS
// `BaseEngine.discoverRouters` surface so both SDKs can auto-wire
// ManagedRouter against the template without the host having to
// repeat the route table in code.
func DiscoverRouters(source string) ([]DiscoveredRouter, error) {
	p, err := getPortable()
	if err != nil {
		return nil, err
	}
	return p.discoverRouters(source)
}

func (p *portableRuntime) discoverRouters(source string) ([]DiscoveredRouter, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.fnClearLastError != nil {
		_, _ = p.fnClearLastError.Call(p.ctx)
	}

	srcPtr, srcLen, err := p.writeString(source)
	if err != nil {
		return nil, err
	}
	defer p.freePtr(srcPtr, srcLen)

	results, err := p.fnDiscoverRouters.Call(p.ctx, uint64(srcPtr), uint64(srcLen))
	if err != nil {
		return nil, fmt.Errorf("discoverRouters: call: %w", err)
	}
	if results[0] != 0 {
		return nil, fmt.Errorf("discoverRouters: rc=%d: %s", results[0], p.readLastError())
	}

	buf, err := p.readResult()
	if err != nil {
		return nil, err
	}
	var out []DiscoveredRouter
	if err := json.Unmarshal(buf, &out); err != nil {
		return nil, fmt.Errorf("discoverRouters: unmarshal: %w", err)
	}
	return out, nil
}

// ─── Session state machine ──────────────────────────────────────────────

// portableSessionPolicy matches the engine's SessionPolicy serde tag.
type portableSessionPolicy string

const (
	portableKickOld       portableSessionPolicy = "kick-old"
	portableRejectNew     portableSessionPolicy = "reject-new"
	portableAllowMultiple portableSessionPolicy = "allow-multiple"
)

// policyToPortable maps the Go-facing ConcurrentPolicy enum to the
// engine's kebab-case serde tag.
func policyToPortable(p ConcurrentPolicy) portableSessionPolicy {
	switch p {
	case ConcurrentRejectNew:
		return portableRejectNew
	case ConcurrentAllowMultiple:
		return portableAllowMultiple
	default:
		return portableKickOld
	}
}

// sessionStepViaEngine asks the engine what to do with a new connection,
// given how many are already attached and the configured policy. The
// Go SessionManager continues to own timers and connection storage —
// this call only returns the decision.
func sessionStepViaEngine(policy ConcurrentPolicy, existingCount uint32) (string, error) {
	p, err := getPortable()
	if err != nil {
		return "", err
	}

	stateJSON := fmt.Sprintf(`{"policy":%q}`, policyToPortable(policy))
	eventJSON := fmt.Sprintf(`{"kind":"connect","existing_connection_count":%d}`, existingCount)

	p.mu.Lock()
	defer p.mu.Unlock()

	statePtr, stateLen, err := p.writeString(stateJSON)
	if err != nil {
		return "", err
	}
	defer p.freePtr(statePtr, stateLen)
	eventPtr, eventLen, err := p.writeString(eventJSON)
	if err != nil {
		return "", err
	}
	defer p.freePtr(eventPtr, eventLen)

	results, err := p.fnSessionStep.Call(p.ctx,
		uint64(statePtr), uint64(stateLen),
		uint64(eventPtr), uint64(eventLen))
	if err != nil {
		return "", fmt.Errorf("sessionStepViaEngine: call: %w", err)
	}
	if results[0] != 0 {
		return "", fmt.Errorf("sessionStepViaEngine: rc=%d: %s", results[0], p.readLastError())
	}

	buf, err := p.readResult()
	if err != nil {
		return "", err
	}
	// Effect is serialised as `{"kind":"accept_connection"}` etc. — pull
	// the "kind" field out.
	var effect struct {
		Kind string `json:"kind"`
	}
	if err := json.Unmarshal(buf, &effect); err != nil {
		return "", fmt.Errorf("sessionStepViaEngine: unmarshal: %w", err)
	}
	return effect.Kind, nil
}

// ─── Path operations ────────────────────────────────────────────────────
//
// These mirror the engine's `hypen_engine::portable::path` module and
// replace the per-SDK `setValueAtPath` / `getValueAtPath` / etc.
// implementations that used to live in state.go.

// pathGetViaEngine reads the value at `path` inside `state`. Returns
// the decoded Go value (may be nil if the path doesn't resolve) and
// an error only on marshalling / WASM failures.
func pathGetViaEngine(state any, path string) (any, error) {
	p, err := getPortable()
	if err != nil {
		return nil, err
	}
	stateJSON, err := json.Marshal(state)
	if err != nil {
		return nil, fmt.Errorf("pathGet: marshal state: %w", err)
	}

	p.mu.Lock()
	defer p.mu.Unlock()

	sp, sl, err := p.writeString(string(stateJSON))
	if err != nil {
		return nil, err
	}
	defer p.freePtr(sp, sl)
	pp, pl, err := p.writeString(path)
	if err != nil {
		return nil, err
	}
	defer p.freePtr(pp, pl)

	results, err := p.fnPathGet.Call(p.ctx,
		uint64(sp), uint64(sl), uint64(pp), uint64(pl))
	if err != nil {
		return nil, fmt.Errorf("pathGet: call: %w", err)
	}
	if results[0] != 0 {
		return nil, fmt.Errorf("pathGet: rc=%d: %s", results[0], p.readLastError())
	}
	buf, err := p.readResult()
	if err != nil {
		return nil, err
	}
	var out any
	if err := json.Unmarshal(buf, &out); err != nil {
		return nil, fmt.Errorf("pathGet: unmarshal: %w", err)
	}
	return out, nil
}

// pathHasViaEngine returns true iff `path` resolves inside `state`.
func pathHasViaEngine(state any, path string) (bool, error) {
	p, err := getPortable()
	if err != nil {
		return false, err
	}
	stateJSON, err := json.Marshal(state)
	if err != nil {
		return false, fmt.Errorf("pathHas: marshal: %w", err)
	}

	p.mu.Lock()
	defer p.mu.Unlock()

	sp, sl, err := p.writeString(string(stateJSON))
	if err != nil {
		return false, err
	}
	defer p.freePtr(sp, sl)
	pp, pl, err := p.writeString(path)
	if err != nil {
		return false, err
	}
	defer p.freePtr(pp, pl)

	results, err := p.fnPathHas.Call(p.ctx,
		uint64(sp), uint64(sl), uint64(pp), uint64(pl))
	if err != nil {
		return false, err
	}
	if results[0] != 0 {
		return false, fmt.Errorf("pathHas: rc=%d: %s", results[0], p.readLastError())
	}
	buf, err := p.readResult()
	if err != nil {
		return false, err
	}
	return string(buf) == "true", nil
}

// pathSetViaEngine writes `value` at `path` inside `state` and returns
// the updated state. Intermediate objects are auto-vivified; arrays are
// grown with nulls up to the target index.
func pathSetViaEngine(state any, path string, value any) (map[string]any, error) {
	p, err := getPortable()
	if err != nil {
		return nil, err
	}
	stateJSON, err := json.Marshal(state)
	if err != nil {
		return nil, fmt.Errorf("pathSet: marshal state: %w", err)
	}
	valueJSON, err := json.Marshal(value)
	if err != nil {
		return nil, fmt.Errorf("pathSet: marshal value: %w", err)
	}

	p.mu.Lock()
	defer p.mu.Unlock()

	sp, sl, err := p.writeString(string(stateJSON))
	if err != nil {
		return nil, err
	}
	defer p.freePtr(sp, sl)
	pp, pl, err := p.writeString(path)
	if err != nil {
		return nil, err
	}
	defer p.freePtr(pp, pl)
	vp, vl, err := p.writeString(string(valueJSON))
	if err != nil {
		return nil, err
	}
	defer p.freePtr(vp, vl)

	results, err := p.fnPathSet.Call(p.ctx,
		uint64(sp), uint64(sl),
		uint64(pp), uint64(pl),
		uint64(vp), uint64(vl))
	if err != nil {
		return nil, fmt.Errorf("pathSet: call: %w", err)
	}
	if results[0] != 0 {
		return nil, fmt.Errorf("pathSet: rc=%d: %s", results[0], p.readLastError())
	}
	buf, err := p.readResult()
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := json.Unmarshal(buf, &out); err != nil {
		return nil, fmt.Errorf("pathSet: unmarshal: %w", err)
	}
	return out, nil
}

// pathDeleteViaEngine removes whatever lives at `path`. Returns the
// updated state and whether anything was actually removed.
func pathDeleteViaEngine(state any, path string) (map[string]any, bool, error) {
	p, err := getPortable()
	if err != nil {
		return nil, false, err
	}
	stateJSON, err := json.Marshal(state)
	if err != nil {
		return nil, false, fmt.Errorf("pathDelete: marshal: %w", err)
	}

	p.mu.Lock()
	defer p.mu.Unlock()

	sp, sl, err := p.writeString(string(stateJSON))
	if err != nil {
		return nil, false, err
	}
	defer p.freePtr(sp, sl)
	pp, pl, err := p.writeString(path)
	if err != nil {
		return nil, false, err
	}
	defer p.freePtr(pp, pl)

	results, err := p.fnPathDelete.Call(p.ctx,
		uint64(sp), uint64(sl), uint64(pp), uint64(pl))
	if err != nil {
		return nil, false, err
	}
	if results[0] != 0 {
		return nil, false, fmt.Errorf("pathDelete: rc=%d: %s", results[0], p.readLastError())
	}
	buf, err := p.readResult()
	if err != nil {
		return nil, false, err
	}
	var out struct {
		JSON    map[string]any `json:"json"`
		Removed bool           `json:"removed"`
	}
	if err := json.Unmarshal(buf, &out); err != nil {
		return nil, false, fmt.Errorf("pathDelete: unmarshal: %w", err)
	}
	return out.JSON, out.Removed, nil
}

// ─── URL helpers ────────────────────────────────────────────────────────

// encodeURIComponentViaEngine percent-encodes `input`.
func encodeURIComponentViaEngine(input string) (string, error) {
	p, err := getPortable()
	if err != nil {
		return "", err
	}

	p.mu.Lock()
	defer p.mu.Unlock()

	ip, il, err := p.writeString(input)
	if err != nil {
		return "", err
	}
	defer p.freePtr(ip, il)

	results, err := p.fnEncodeURI.Call(p.ctx, uint64(ip), uint64(il))
	if err != nil {
		return "", err
	}
	if results[0] != 0 {
		return "", fmt.Errorf("encodeURIComponent: rc=%d: %s", results[0], p.readLastError())
	}
	buf, err := p.readResult()
	if err != nil {
		return "", err
	}
	return string(buf), nil
}

// decodeURIComponentViaEngine decodes percent escapes and `+` → space.
func decodeURIComponentViaEngine(input string) (string, error) {
	p, err := getPortable()
	if err != nil {
		return "", err
	}

	p.mu.Lock()
	defer p.mu.Unlock()

	ip, il, err := p.writeString(input)
	if err != nil {
		return "", err
	}
	defer p.freePtr(ip, il)

	results, err := p.fnDecodeURI.Call(p.ctx, uint64(ip), uint64(il))
	if err != nil {
		return "", err
	}
	if results[0] != 0 {
		return "", fmt.Errorf("decodeURIComponent: rc=%d: %s", results[0], p.readLastError())
	}
	buf, err := p.readResult()
	if err != nil {
		return "", err
	}
	return string(buf), nil
}

// parseQueryViaEngine splits `full` into (clean_path, query_map).
func parseQueryViaEngine(full string) (string, map[string]string, error) {
	p, err := getPortable()
	if err != nil {
		return "", nil, err
	}

	p.mu.Lock()
	defer p.mu.Unlock()

	ip, il, err := p.writeString(full)
	if err != nil {
		return "", nil, err
	}
	defer p.freePtr(ip, il)

	results, err := p.fnParseQuery.Call(p.ctx, uint64(ip), uint64(il))
	if err != nil {
		return "", nil, err
	}
	if results[0] != 0 {
		return "", nil, fmt.Errorf("parseQuery: rc=%d: %s", results[0], p.readLastError())
	}
	buf, err := p.readResult()
	if err != nil {
		return "", nil, err
	}
	var out struct {
		Path  string            `json:"path"`
		Query map[string]string `json:"query"`
	}
	if err := json.Unmarshal(buf, &out); err != nil {
		return "", nil, fmt.Errorf("parseQuery: unmarshal: %w", err)
	}
	if out.Query == nil {
		out.Query = map[string]string{}
	}
	return out.Path, out.Query, nil
}

// buildURLViaEngine composes path + query map into a URL string.
func buildURLViaEngine(path string, query map[string]string) (string, error) {
	p, err := getPortable()
	if err != nil {
		return "", err
	}
	if query == nil {
		query = map[string]string{}
	}
	qj, err := json.Marshal(query)
	if err != nil {
		return "", fmt.Errorf("buildURL: marshal query: %w", err)
	}

	p.mu.Lock()
	defer p.mu.Unlock()

	pp, pl, err := p.writeString(path)
	if err != nil {
		return "", err
	}
	defer p.freePtr(pp, pl)
	qp, ql, err := p.writeString(string(qj))
	if err != nil {
		return "", err
	}
	defer p.freePtr(qp, ql)

	results, err := p.fnBuildURL.Call(p.ctx,
		uint64(pp), uint64(pl), uint64(qp), uint64(ql))
	if err != nil {
		return "", err
	}
	if results[0] != 0 {
		return "", fmt.Errorf("buildURL: rc=%d: %s", results[0], p.readLastError())
	}
	buf, err := p.readResult()
	if err != nil {
		return "", err
	}
	return string(buf), nil
}

// ─── Exported test surface ──────────────────────────────────────────────
//
// Mirrors DiffPathsViaEngine / MatchPathViaEngine / SessionStepViaEngine
// above. Used exclusively by the cross-SDK compatibility runner at
// engine-compatibility-tests/runners/golang/.

// PathGetViaEngine exports [`pathGetViaEngine`] for the compat runner.
func PathGetViaEngine(state any, path string) (any, error) {
	return pathGetViaEngine(state, path)
}

// PathHasViaEngine exports [`pathHasViaEngine`] for the compat runner.
func PathHasViaEngine(state any, path string) (bool, error) {
	return pathHasViaEngine(state, path)
}

// PathSetViaEngine exports [`pathSetViaEngine`] for the compat runner.
func PathSetViaEngine(state any, path string, value any) (map[string]any, error) {
	return pathSetViaEngine(state, path, value)
}

// PathDeleteViaEngine exports [`pathDeleteViaEngine`] for the compat runner.
func PathDeleteViaEngine(state any, path string) (map[string]any, bool, error) {
	return pathDeleteViaEngine(state, path)
}

// EncodeURIComponentViaEngine exports the percent-encoder for the compat runner.
func EncodeURIComponentViaEngine(input string) (string, error) {
	return encodeURIComponentViaEngine(input)
}

// DecodeURIComponentViaEngine exports the percent-decoder for the compat runner.
func DecodeURIComponentViaEngine(input string) (string, error) {
	return decodeURIComponentViaEngine(input)
}

// ParseQueryViaEngine exports the query parser for the compat runner.
func ParseQueryViaEngine(full string) (string, map[string]string, error) {
	return parseQueryViaEngine(full)
}

// BuildURLViaEngine exports the URL builder for the compat runner.
func BuildURLViaEngine(path string, query map[string]string) (string, error) {
	return buildURLViaEngine(path, query)
}
