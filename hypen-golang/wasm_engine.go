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

// WasmEngine provides a real Hypen engine implementation using the WASM engine via wazero.
// This implements IEngine and provides full rendering capabilities.
type WasmEngine struct {
	mu sync.RWMutex

	// wazero runtime and module
	runtime wazero.Runtime
	module  api.Module
	ctx     context.Context

	// Exported WASM functions
	fnInit                      api.Function
	fnDestroy                   api.Function
	fnRenderSource              api.Function
	fnRenderInto                api.Function
	fnUpdateState               api.Function
	fnUpdateStateSparse         api.Function
	fnUpdateModuleState         api.Function
	fnSetModule                 api.Function
	fnRegisterModule            api.Function
	fnRegisterAction            api.Function
	fnDispatchAction            api.Function
	fnRegisterPrimitive         api.Function
	fnRegisterDefaultPrimitives api.Function
	fnRegisterComponent         api.Function
	fnRegisterResources         api.Function
	fnGetPatchesLen             api.Function
	fnGetPatches                api.Function
	fnClearPatches              api.Function
	fnGetActionLen              api.Function
	fnGetAction                 api.Function
	fnClearAction               api.Function
	fnClearTree                 api.Function
	fnParseToJson               api.Function
	fnGetRevision               api.Function
	fnGetPendingImportsLen      api.Function
	fnGetPendingImports         api.Function
	fnClearPendingImports       api.Function
	// External capability surface (see agent.go)
	fnListExternalActions  api.Function
	fnListRoutes           api.Function
	fnListBindings         api.Function
	fnDispatchExternal     api.Function
	fnGetStateAt           api.Function
	fnUnregisterModule     api.Function
	fnGetExternalResultLen api.Function
	fnGetExternalResult    api.Function
	fnGetLastErrorLen      api.Function
	fnGetLastError         api.Function
	fnClearLastError       api.Function
	fnAlloc                api.Function
	fnFree                 api.Function

	// Action handlers (called when WASM dispatches actions back)
	actionHandlers map[string]func(action Action)

	// Patch callback (called when rendering produces patches)
	patchCallback func(patches []Patch)

	// Registered primitives
	primitives map[string]bool
}

// WasmEngineConfig configures the WASM engine
type WasmEngineConfig struct {
	// WasmPath is the path to the hypen_engine.wasm file
	WasmPath string

	// WasmBytes is the raw WASM bytes (alternative to WasmPath)
	WasmBytes []byte

	// Primitives to register (e.g., "Text", "Button", "Column", "Row")
	Primitives []string
}

var (
	compilationCacheOnce sync.Once
	compilationCache     wazero.CompilationCache
)

// SharedCompilationCache is the process-wide wazero compilation cache every
// runtime of the engine module uses (renderer engines and the device broker
// runtime): identical module bytes compile once per process.
func SharedCompilationCache() wazero.CompilationCache {
	compilationCacheOnce.Do(func() { compilationCache = wazero.NewCompilationCache() })
	return compilationCache
}

// NewDefaultEngine creates a WASM engine using the embedded binary.
// This is the simplest way to create an engine — no configuration needed.
func NewDefaultEngine() (*WasmEngine, error) {
	return NewWasmEngine(WasmEngineConfig{WasmBytes: embeddedWasm})
}

// NewWasmEngine creates a new WASM-based Hypen engine
func NewWasmEngine(config WasmEngineConfig) (*WasmEngine, error) {
	ctx := context.Background()

	// Load WASM bytes
	var wasmBytes []byte
	var err error
	if len(config.WasmBytes) > 0 {
		wasmBytes = config.WasmBytes
	} else if config.WasmPath != "" {
		wasmBytes, err = os.ReadFile(config.WasmPath)
		if err != nil {
			return nil, fmt.Errorf("failed to read WASM file: %w", err)
		}
	} else {
		return nil, fmt.Errorf("either WasmPath or WasmBytes must be provided")
	}

	// Create wazero runtime. The compilation cache is process-wide, so the
	// engine module is compiled once and every later engine (one per
	// remote session) only instantiates it.
	runtime := wazero.NewRuntimeWithConfig(ctx, wazero.NewRuntimeConfig().WithCompilationCache(SharedCompilationCache()))

	// Instantiate WASI
	_, err = wasi_snapshot_preview1.Instantiate(ctx, runtime)
	if err != nil {
		runtime.Close(ctx)
		return nil, fmt.Errorf("failed to instantiate WASI: %w", err)
	}

	// Compile and instantiate the module
	compiled, err := runtime.CompileModule(ctx, wasmBytes)
	if err != nil {
		runtime.Close(ctx)
		return nil, fmt.Errorf("failed to compile WASM module: %w", err)
	}

	module, err := runtime.InstantiateModule(ctx, compiled, wazero.NewModuleConfig().
		WithStdout(os.Stdout).
		WithStderr(os.Stderr))
	if err != nil {
		runtime.Close(ctx)
		return nil, fmt.Errorf("failed to instantiate WASM module: %w", err)
	}

	engine := &WasmEngine{
		runtime:        runtime,
		module:         module,
		ctx:            ctx,
		actionHandlers: make(map[string]func(action Action)),
		primitives:     make(map[string]bool),
	}

	// Get exported functions
	engine.fnInit = module.ExportedFunction("hypen_init")
	engine.fnDestroy = module.ExportedFunction("hypen_destroy")
	engine.fnRenderSource = module.ExportedFunction("hypen_render_source")
	engine.fnRenderInto = module.ExportedFunction("hypen_render_into")
	engine.fnUpdateState = module.ExportedFunction("hypen_update_state")
	engine.fnUpdateStateSparse = module.ExportedFunction("hypen_update_state_sparse")
	engine.fnUpdateModuleState = module.ExportedFunction("hypen_update_module_state")
	engine.fnSetModule = module.ExportedFunction("hypen_set_module")
	engine.fnRegisterModule = module.ExportedFunction("hypen_register_module")
	engine.fnRegisterAction = module.ExportedFunction("hypen_register_action")
	engine.fnDispatchAction = module.ExportedFunction("hypen_dispatch_action")
	engine.fnRegisterPrimitive = module.ExportedFunction("hypen_register_primitive")
	engine.fnRegisterDefaultPrimitives = module.ExportedFunction("hypen_register_default_primitives")
	engine.fnRegisterComponent = module.ExportedFunction("hypen_register_component")
	engine.fnRegisterResources = module.ExportedFunction("hypen_register_resources")
	engine.fnGetPatchesLen = module.ExportedFunction("hypen_get_patches_len")
	engine.fnGetPatches = module.ExportedFunction("hypen_get_patches")
	engine.fnClearPatches = module.ExportedFunction("hypen_clear_patches")
	engine.fnGetActionLen = module.ExportedFunction("hypen_get_action_len")
	engine.fnGetAction = module.ExportedFunction("hypen_get_action")
	engine.fnClearAction = module.ExportedFunction("hypen_clear_action")
	engine.fnClearTree = module.ExportedFunction("hypen_clear_tree")
	engine.fnParseToJson = module.ExportedFunction("hypen_parse_to_json")
	engine.fnGetRevision = module.ExportedFunction("hypen_get_revision")
	engine.fnGetPendingImportsLen = module.ExportedFunction("hypen_get_pending_imports_len")
	engine.fnGetPendingImports = module.ExportedFunction("hypen_get_pending_imports")
	engine.fnClearPendingImports = module.ExportedFunction("hypen_clear_pending_imports")
	engine.fnListExternalActions = module.ExportedFunction("hypen_list_external_actions")
	engine.fnListRoutes = module.ExportedFunction("hypen_list_routes")
	engine.fnListBindings = module.ExportedFunction("hypen_list_bindings")
	engine.fnDispatchExternal = module.ExportedFunction("hypen_dispatch_external")
	engine.fnGetStateAt = module.ExportedFunction("hypen_get_state_at")
	engine.fnUnregisterModule = module.ExportedFunction("hypen_unregister_module")
	engine.fnGetExternalResultLen = module.ExportedFunction("hypen_get_external_result_len")
	engine.fnGetExternalResult = module.ExportedFunction("hypen_get_external_result")
	engine.fnGetLastErrorLen = module.ExportedFunction("hypen_get_last_error_len")
	engine.fnGetLastError = module.ExportedFunction("hypen_get_last_error")
	engine.fnClearLastError = module.ExportedFunction("hypen_clear_last_error")
	engine.fnAlloc = module.ExportedFunction("wasi_alloc")
	engine.fnFree = module.ExportedFunction("wasi_free")

	// Verify required functions exist
	if engine.fnInit == nil || engine.fnAlloc == nil {
		engine.Close()
		return nil, fmt.Errorf("WASM module missing required exports")
	}

	// Initialize the engine
	results, err := engine.fnInit.Call(ctx)
	if err != nil {
		engine.Close()
		return nil, fmt.Errorf("failed to initialize engine: %w", err)
	}
	if len(results) > 0 && results[0] != 0 {
		engine.Close()
		return nil, newWasmError("init", results[0])
	}

	// Register default primitives
	for _, prim := range config.Primitives {
		if err := engine.RegisterPrimitive(prim); err != nil {
			engine.Close()
			return nil, fmt.Errorf("failed to register primitive %s: %w", prim, err)
		}
	}

	return engine, nil
}

// Close releases all resources
func (e *WasmEngine) Close() error {
	e.mu.Lock()
	defer e.mu.Unlock()

	if e.fnDestroy != nil {
		e.fnDestroy.Call(e.ctx)
	}
	if e.runtime != nil {
		return e.runtime.Close(e.ctx)
	}
	return nil
}

// writeString writes a string to WASM memory and returns (ptr, len)
func (e *WasmEngine) writeString(s string) (uint32, uint32, error) {
	bytes := []byte(s)
	size := uint32(len(bytes))
	if size == 0 {
		return 0, 0, nil
	}

	// Allocate memory
	results, err := e.fnAlloc.Call(e.ctx, uint64(size))
	if err != nil {
		return 0, 0, fmt.Errorf("allocation failed: %w", err)
	}
	ptr := uint32(results[0])
	if ptr == 0 {
		return 0, 0, fmt.Errorf("allocation returned null")
	}

	// Write to memory
	if !e.module.Memory().Write(ptr, bytes) {
		e.fnFree.Call(e.ctx, uint64(ptr), uint64(size))
		return 0, 0, fmt.Errorf("memory write failed")
	}

	return ptr, size, nil
}

// readString reads a string from WASM memory
func (e *WasmEngine) readString(ptr, len uint32) (string, error) {
	if len == 0 {
		return "", nil
	}
	bytes, ok := e.module.Memory().Read(ptr, len)
	if !ok {
		return "", fmt.Errorf("memory read failed")
	}
	return string(bytes), nil
}

// freePtr frees memory allocated in WASM
func (e *WasmEngine) freePtr(ptr, size uint32) {
	if ptr != 0 && e.fnFree != nil {
		e.fnFree.Call(e.ctx, uint64(ptr), uint64(size))
	}
}

// RenderSource renders Hypen DSL source and returns patches
func (e *WasmEngine) RenderSource(source string) ([]Patch, error) {
	patches, cb, err := e.renderSourceLocked(source)
	if err != nil {
		return nil, err
	}

	// Invoke callback outside the lock to avoid deadlock if the callback
	// calls back into engine methods.
	if len(patches) > 0 && cb != nil {
		cb(patches)
	}
	return patches, nil
}

// renderSourceLocked performs the WASM render under the lock and returns
// patches plus the current callback, without invoking the callback.
func (e *WasmEngine) renderSourceLocked(source string) ([]Patch, func([]Patch), error) {
	e.mu.Lock()
	defer e.mu.Unlock()

	// Write source to memory
	ptr, size, err := e.writeString(source)
	if err != nil {
		return nil, nil, err
	}
	defer e.freePtr(ptr, size)

	// Call render
	results, err := e.fnRenderSource.Call(e.ctx, uint64(ptr), uint64(size))
	if err != nil {
		return nil, nil, &EngineError{Code: ErrRender, Message: "render call failed", Cause: err}
	}
	if len(results) > 0 && results[0] != 0 {
		return nil, nil, newWasmError("render", results[0])
	}

	patches, err := e.getPatches()
	if err != nil {
		return nil, nil, err
	}
	return patches, e.patchCallback, nil
}

// getPatches retrieves patches from the WASM buffer
func (e *WasmEngine) getPatches() ([]Patch, error) {
	// Get patches length
	results, err := e.fnGetPatchesLen.Call(e.ctx)
	if err != nil {
		return nil, err
	}
	patchLen := uint32(results[0])
	if patchLen == 0 {
		return []Patch{}, nil
	}

	// Allocate buffer for patches
	patchPtr, err := e.fnAlloc.Call(e.ctx, uint64(patchLen))
	if err != nil {
		return nil, err
	}
	ptr := uint32(patchPtr[0])
	defer e.freePtr(ptr, patchLen)

	// Copy patches to buffer
	_, err = e.fnGetPatches.Call(e.ctx, uint64(ptr), uint64(patchLen))
	if err != nil {
		return nil, err
	}

	// Read JSON from buffer
	jsonStr, err := e.readString(ptr, patchLen)
	if err != nil {
		return nil, err
	}

	// Clear patches buffer
	e.fnClearPatches.Call(e.ctx)

	// Parse patches
	var rawPatches []json.RawMessage
	if err := json.Unmarshal([]byte(jsonStr), &rawPatches); err != nil {
		return nil, fmt.Errorf("failed to parse patches: %w", err)
	}

	patches := make([]Patch, 0, len(rawPatches))
	for _, raw := range rawPatches {
		patch, err := parsePatchFromJSON(raw)
		if err != nil {
			return nil, err
		}
		patches = append(patches, patch)
	}

	return patches, nil
}

// parsePatchFromJSON converts JSON to a Patch struct
func parsePatchFromJSON(raw json.RawMessage) (Patch, error) {
	// Use direct struct unmarshaling for correctness — JSON tags on Patch match the wire format
	var patch Patch
	if err := json.Unmarshal(raw, &patch); err != nil {
		return Patch{}, fmt.Errorf("failed to unmarshal patch: %w", err)
	}
	return patch, nil
}

// UpdateState updates the engine state with a patch
func (e *WasmEngine) UpdateState(statePatch map[string]any) ([]Patch, error) {
	e.mu.Lock()
	defer e.mu.Unlock()

	// Serialize state patch
	jsonBytes, err := json.Marshal(statePatch)
	if err != nil {
		return nil, err
	}

	// Write to memory
	ptr, size, err := e.writeString(string(jsonBytes))
	if err != nil {
		return nil, err
	}
	defer e.freePtr(ptr, size)

	// Call update state
	results, err := e.fnUpdateState.Call(e.ctx, uint64(ptr), uint64(size))
	if err != nil {
		return nil, &EngineError{Code: ErrState, Message: "update state call failed", Cause: err}
	}
	if len(results) > 0 && results[0] != 0 {
		return nil, newWasmError("update_state", results[0])
	}

	// Get patches and notify callback
	patches, err := e.getPatches()
	if err == nil && len(patches) > 0 && e.patchCallback != nil {
		e.patchCallback(patches)
	}
	return patches, err
}

// RegisterDefaultPrimitives registers every built-in Hypen element type
// (Text, Column, Row, Button, Image, Icon, etc.) with a single WASM call.
// Use this instead of calling RegisterPrimitive for each name; it guarantees
// the set stays in sync with the engine.
func (e *WasmEngine) RegisterDefaultPrimitives() error {
	if e.fnRegisterDefaultPrimitives == nil {
		return &EngineError{Code: ErrRender, Message: "WASM missing hypen_register_default_primitives export"}
	}
	results, err := e.fnRegisterDefaultPrimitives.Call(e.ctx)
	if err != nil {
		return &EngineError{Code: ErrRender, Message: "register_default_primitives call failed", Cause: err}
	}
	if len(results) > 0 && results[0] != 0 {
		return newWasmError("register_default_primitives", results[0])
	}
	return nil
}

// RegisterPrimitive registers a primitive element type
func (e *WasmEngine) RegisterPrimitive(name string) error {
	ptr, size, err := e.writeString(name)
	if err != nil {
		return err
	}
	defer e.freePtr(ptr, size)

	results, err := e.fnRegisterPrimitive.Call(e.ctx, uint64(ptr), uint64(size))
	if err != nil {
		return &EngineError{Code: ErrRender, Message: "register primitive call failed", Cause: err}
	}
	if len(results) > 0 && results[0] != 0 {
		return newWasmError("register_primitive", results[0])
	}

	e.primitives[name] = true
	return nil
}

// RegisterComponent registers a component from source
func (e *WasmEngine) RegisterComponent(name, source, path string) error {
	e.mu.Lock()
	defer e.mu.Unlock()

	namePtr, nameSize, err := e.writeString(name)
	if err != nil {
		return err
	}
	defer e.freePtr(namePtr, nameSize)

	sourcePtr, sourceSize, err := e.writeString(source)
	if err != nil {
		return err
	}
	defer e.freePtr(sourcePtr, sourceSize)

	pathPtr, pathSize, err := e.writeString(path)
	if err != nil {
		return err
	}
	defer e.freePtr(pathPtr, pathSize)

	results, err := e.fnRegisterComponent.Call(e.ctx,
		uint64(namePtr), uint64(nameSize),
		uint64(sourcePtr), uint64(sourceSize),
		uint64(pathPtr), uint64(pathSize))
	if err != nil {
		return &EngineError{Code: ErrRender, Message: "register component call failed", Cause: err}
	}
	if len(results) > 0 && results[0] != 0 {
		return newWasmError("register_component", results[0])
	}

	return nil
}

// RegisterResources registers a flat map of resource name → raw SVG string.
// The engine parses each SVG in Rust and stores the resolved data in its
// ResourceRegistry, so @resources.xxx references can be resolved during render.
func (e *WasmEngine) RegisterResources(resources map[string]string) error {
	if len(resources) == 0 {
		return nil
	}

	e.mu.Lock()
	defer e.mu.Unlock()

	if e.fnRegisterResources == nil {
		return &EngineError{Code: ErrRender, Message: "hypen_register_resources not available in WASM module"}
	}

	jsonBytes, err := json.Marshal(resources)
	if err != nil {
		return fmt.Errorf("failed to serialize resources: %w", err)
	}

	ptr, size, err := e.writeString(string(jsonBytes))
	if err != nil {
		return err
	}
	defer e.freePtr(ptr, size)

	results, err := e.fnRegisterResources.Call(e.ctx, uint64(ptr), uint64(size))
	if err != nil {
		return &EngineError{Code: ErrRender, Message: "register resources call failed", Cause: err}
	}
	if len(results) > 0 && results[0] != 0 {
		return newWasmError("register_resources", results[0])
	}

	return nil
}

// DispatchAction dispatches an action to the engine, then calls the
// registered handler WITHOUT holding the WASM mutex. This allows the
// handler to freely call UpdateState/UpdateModuleState.
func (e *WasmEngine) DispatchAction(name string, payload any) error {
	// Phase 1: send action to WASM engine and read back the pending action (locked)
	action, err := e.dispatchAndReadAction(name, payload)
	if err != nil {
		return err
	}
	if action == nil {
		return nil // no pending action
	}

	// Phase 2: call handler WITHOUT lock — handler can call UpdateState freely
	if handler, ok := e.actionHandlers[action.Name]; ok && handler != nil {
		handler(*action)
	}

	return nil
}

// dispatchAndReadAction sends the action to WASM and reads the pending action
// from the action buffer. Holds the mutex only for WASM calls.
func (e *WasmEngine) dispatchAndReadAction(name string, payload any) (*Action, error) {
	e.mu.Lock()
	defer e.mu.Unlock()

	actionMap := map[string]any{
		"name":    name,
		"payload": payload,
	}

	jsonBytes, err := json.Marshal(actionMap)
	if err != nil {
		return nil, err
	}

	ptr, size, err := e.writeString(string(jsonBytes))
	if err != nil {
		return nil, err
	}
	defer e.freePtr(ptr, size)

	results, err := e.fnDispatchAction.Call(e.ctx, uint64(ptr), uint64(size))
	if err != nil {
		return nil, &EngineError{Code: ErrActionNotFound, Message: "dispatch action call failed", Cause: err}
	}
	if len(results) > 0 && results[0] != 0 {
		return nil, newWasmError("dispatch_action", results[0])
	}

	return e.readPendingActionLocked()
}

// readPendingActionLocked drains the WASM action buffer into an Action, or
// returns (nil, nil) when the engine queued nothing. Caller must hold the
// mutex. Shared with the external capability surface (see agent.go), which
// queues the *resolved* action through the same buffer.
func (e *WasmEngine) readPendingActionLocked() (*Action, error) {
	lenResults, err := e.fnGetActionLen.Call(e.ctx)
	if err != nil {
		return nil, err
	}
	actionLen := uint32(lenResults[0])
	if actionLen == 0 {
		return nil, nil
	}

	actionPtr, err := e.fnAlloc.Call(e.ctx, uint64(actionLen))
	if err != nil {
		return nil, err
	}
	aPtr := uint32(actionPtr[0])
	defer e.freePtr(aPtr, actionLen)

	_, err = e.fnGetAction.Call(e.ctx, uint64(aPtr), uint64(actionLen))
	if err != nil {
		return nil, err
	}

	jsonStr, err := e.readString(aPtr, actionLen)
	if err != nil {
		return nil, err
	}

	e.fnClearAction.Call(e.ctx)

	var action Action
	if err := json.Unmarshal([]byte(jsonStr), &action); err != nil {
		return nil, err
	}

	return &action, nil
}

// GetRevision returns the current engine revision
func (e *WasmEngine) GetRevision() uint64 {
	e.mu.RLock()
	defer e.mu.RUnlock()

	results, err := e.fnGetRevision.Call(e.ctx)
	if err != nil {
		return 0
	}
	return results[0]
}

// ClearTree clears the render tree
func (e *WasmEngine) ClearTree() {
	e.mu.Lock()
	defer e.mu.Unlock()

	if e.fnClearTree != nil {
		e.fnClearTree.Call(e.ctx)
	}
}

// ParseToJSON parses Hypen DSL and returns AST as JSON
func (e *WasmEngine) ParseToJSON(source string) (string, error) {
	e.mu.Lock()
	defer e.mu.Unlock()

	ptr, size, err := e.writeString(source)
	if err != nil {
		return "", err
	}
	defer e.freePtr(ptr, size)

	results, err := e.fnParseToJson.Call(e.ctx, uint64(ptr), uint64(size))
	if err != nil {
		return "", &EngineError{Code: ErrParse, Message: "parse call failed", Cause: err}
	}
	if len(results) > 0 && results[0] != 0 {
		return "", newWasmError("parse", results[0])
	}

	// Get result from patch buffer (reused for convenience)
	lenResults, err := e.fnGetPatchesLen.Call(e.ctx)
	if err != nil {
		return "", err
	}
	jsonLen := uint32(lenResults[0])
	if jsonLen == 0 {
		return "{}", nil
	}

	// Allocate buffer
	bufPtr, err := e.fnAlloc.Call(e.ctx, uint64(jsonLen))
	if err != nil {
		return "", err
	}
	ptr = uint32(bufPtr[0])
	defer e.freePtr(ptr, jsonLen)

	// Copy result
	_, err = e.fnGetPatches.Call(e.ctx, uint64(ptr), uint64(jsonLen))
	if err != nil {
		return "", err
	}

	// Read JSON
	jsonStr, err := e.readString(ptr, jsonLen)
	if err != nil {
		return "", err
	}

	// Clear buffer
	e.fnClearPatches.Call(e.ctx)

	return jsonStr, nil
}

// GetPendingImports retrieves pending imports from the last render.
// After calling RenderSource, the engine stores any import statements found in the document.
// Call this to get them, then resolve each import and register the component via RegisterComponent.
func (e *WasmEngine) GetPendingImports() ([]ImportInfo, error) {
	// Get imports buffer length
	results, err := e.fnGetPendingImportsLen.Call(e.ctx)
	if err != nil {
		return nil, err
	}
	importLen := uint32(results[0])
	if importLen == 0 {
		return []ImportInfo{}, nil
	}

	// Allocate buffer
	bufPtr, err := e.fnAlloc.Call(e.ctx, uint64(importLen))
	if err != nil {
		return nil, err
	}
	ptr := uint32(bufPtr[0])
	defer e.freePtr(ptr, importLen)

	// Copy imports to buffer
	_, err = e.fnGetPendingImports.Call(e.ctx, uint64(ptr), uint64(importLen))
	if err != nil {
		return nil, err
	}

	// Read JSON
	jsonStr, err := e.readString(ptr, importLen)
	if err != nil {
		return nil, err
	}

	// Clear imports buffer
	e.fnClearPendingImports.Call(e.ctx)

	// Parse import info
	var imports []ImportInfo
	if err := json.Unmarshal([]byte(jsonStr), &imports); err != nil {
		return nil, fmt.Errorf("failed to parse imports: %w", err)
	}

	return imports, nil
}

// ImportInfo represents an import found in a rendered document
type ImportInfo struct {
	Names      []string `json:"names"`
	SourcePath string   `json:"source_path"`
	SourceType string   `json:"source_type"`
}

// RenderDocument renders source that may contain import statements.
// It renders the source, then automatically resolves any imports using the provided
// ComponentResolver, registers the resolved components, and re-renders.
func (e *WasmEngine) RenderDocument(source string, resolver *ComponentResolver) ([]Patch, error) {
	// First render to discover imports
	patches, err := e.RenderSource(source)
	if err != nil {
		return nil, err
	}

	// Check for pending imports
	e.mu.Lock()
	imports, err := e.GetPendingImports()
	e.mu.Unlock()
	if err != nil {
		return patches, nil // Return initial patches even if import query fails
	}

	if len(imports) == 0 || resolver == nil {
		return patches, nil
	}

	// Resolve and register each import
	for _, imp := range imports {
		stmt := importInfoToStatement(imp)
		resolved, err := resolver.Resolve(stmt)
		if err != nil {
			continue // Skip failed imports
		}

		for name, comp := range resolved {
			e.mu.Lock()
			regErr := e.registerComponentInternal(name, comp.Template, "")
			e.mu.Unlock()
			if regErr != nil {
				continue
			}
		}
	}

	// Re-render now that components are registered
	return e.RenderSource(source)
}

// RenderDocumentResult contains the result of RenderDocumentWithModules.
type RenderDocumentResult struct {
	// Patches from the final render
	Patches []Patch
	// NestedModules maps component name → ModuleInstance for each stateful
	// module that was auto-instantiated from the app registry.
	NestedModules map[string]*ModuleInstance
}

// RenderDocumentWithModules renders source, resolves imports, registers
// components, AND auto-instantiates nested module instances for any resolved
// component that is a stateful module in the app registry.
//
// This is the Go equivalent of the TypeScript SDK's Hypen.mount() flow:
// render → resolve imports → create nested module instances → re-render.
func (e *WasmEngine) RenderDocumentWithModules(
	source string,
	resolver *ComponentResolver,
	app *HypenApp,
	globalContext *HypenGlobalContext,
	routerContext *RouterContext,
) (*RenderDocumentResult, error) {
	// Use the existing RenderDocument for import resolution and template registration
	patches, err := e.RenderDocument(source, resolver)
	if err != nil {
		return nil, err
	}

	// Auto-instantiate nested modules from the app registry
	nested := CreateNestedModuleInstances(e, app, globalContext, routerContext)

	// If we created nested modules, re-render so the engine sees all state
	if len(nested) > 0 {
		patches, err = e.RenderSource(source)
		if err != nil {
			return &RenderDocumentResult{Patches: patches, NestedModules: nested}, err
		}
	}

	return &RenderDocumentResult{Patches: patches, NestedModules: nested}, nil
}

// registerComponentInternal registers a component without locking (caller must hold lock)
func (e *WasmEngine) registerComponentInternal(name, source, path string) error {
	namePtr, nameSize, err := e.writeString(name)
	if err != nil {
		return err
	}
	defer e.freePtr(namePtr, nameSize)

	sourcePtr, sourceSize, err := e.writeString(source)
	if err != nil {
		return err
	}
	defer e.freePtr(sourcePtr, sourceSize)

	pathPtr, pathSize, err := e.writeString(path)
	if err != nil {
		return err
	}
	defer e.freePtr(pathPtr, pathSize)

	results, err := e.fnRegisterComponent.Call(e.ctx,
		uint64(namePtr), uint64(nameSize),
		uint64(sourcePtr), uint64(sourceSize),
		uint64(pathPtr), uint64(pathSize))
	if err != nil {
		return &EngineError{Code: ErrRender, Message: "register component call failed", Cause: err}
	}
	if len(results) > 0 && results[0] != 0 {
		return newWasmError("register_component", results[0])
	}

	return nil
}

// importInfoToStatement converts an ImportInfo to an ImportStatement
func importInfoToStatement(info ImportInfo) ImportStatement {
	clause := ImportClause{
		Type:  ImportClauseNamed,
		Names: info.Names,
	}

	var source ImportSource
	if info.SourceType == "url" {
		source = ImportSource{
			Type: ImportSourceURL,
			URL:  info.SourcePath,
		}
	} else {
		source = ImportSource{
			Type: ImportSourceLocal,
			Path: info.SourcePath,
		}
	}

	return ImportStatement{
		Clause: clause,
		Source: source,
	}
}

// ============================================================================
// IEngine interface implementation
// ============================================================================

// SetModule implements IEngine.SetModule
func (e *WasmEngine) SetModule(name string, actions []string, stateKeys []string, initialState any) {
	e.mu.Lock()
	defer e.mu.Unlock()

	config := map[string]any{
		"name":          name,
		"actions":       actions,
		"state_keys":    stateKeys,
		"initial_state": initialState,
	}

	jsonBytes, err := json.Marshal(config)
	if err != nil {
		return
	}

	ptr, size, err := e.writeString(string(jsonBytes))
	if err != nil {
		return
	}
	defer e.freePtr(ptr, size)

	results, err := e.fnSetModule.Call(e.ctx, uint64(ptr), uint64(size))
	if err != nil {
		logModule.Error("SetModule WASM call failed: %v", err)
	} else if len(results) > 0 && results[0] != 0 {
		logModule.Error("SetModule returned non-zero status: %d", results[0])
	}
}

// RegisterModule registers a named module for multi-module apps.
// Unlike SetModule (which sets the primary module), this adds a secondary
// module whose state is scoped to components rendered with `module <name> { ... }`.
func (e *WasmEngine) RegisterModule(name string, actions []string, stateKeys []string, initialState any) {
	e.mu.Lock()
	defer e.mu.Unlock()

	if e.fnRegisterModule == nil {
		logModule.Error("RegisterModule: hypen_register_module not available in WASM module")
		return
	}

	config := map[string]any{
		"name":          name,
		"actions":       actions,
		"state_keys":    stateKeys,
		"initial_state": initialState,
	}

	jsonBytes, err := json.Marshal(config)
	if err != nil {
		logModule.Error("RegisterModule: failed to marshal config: %v", err)
		return
	}

	ptr, size, err := e.writeString(string(jsonBytes))
	if err != nil {
		logModule.Error("RegisterModule: failed to write config: %v", err)
		return
	}
	defer e.freePtr(ptr, size)

	results, err := e.fnRegisterModule.Call(e.ctx, uint64(ptr), uint64(size))
	if err != nil {
		logModule.Error("RegisterModule WASM call failed: %v", err)
	} else if len(results) > 0 && results[0] != 0 {
		logModule.Error("RegisterModule returned non-zero status: %d", results[0])
	}
}

// OnAction implements IEngine.OnAction
func (e *WasmEngine) OnAction(actionName string, handler func(action Action)) {
	e.mu.Lock()
	defer e.mu.Unlock()

	e.actionHandlers[actionName] = handler

	// Register action with WASM
	ptr, size, err := e.writeString(actionName)
	if err != nil {
		return
	}
	defer e.freePtr(ptr, size)

	results, err := e.fnRegisterAction.Call(e.ctx, uint64(ptr), uint64(size))
	if err != nil {
		logModule.Error("RegisterAction WASM call failed for %q: %v", actionName, err)
	} else if len(results) > 0 && results[0] != 0 {
		logModule.Error("RegisterAction %q returned non-zero status: %d", actionName, results[0])
	}
}

// NotifyStateChange implements IEngine.NotifyStateChange.
//
// An empty scope routes the update through UpdateState — the WASI engine's
// active_action_scope then routes it to the owning module during dispatch,
// or to the primary slot otherwise. A non-empty scope routes the update
// explicitly to the named module via hypen_update_module_state, bypassing
// active_action_scope. Nested modules use this path when their state mutates
// outside a dispatch window (e.g. from a goroutine).
func (e *WasmEngine) NotifyStateChange(scope string, paths []string, changedValues map[string]any) {
	_, _ = e.UpdateModuleState(scope, changedValues)
}

// UpdateModuleState writes a state patch into the named module's state tree,
// bypassing active_action_scope. Use this when a nested module's state
// mutates outside of an action handler (e.g., from a goroutine) and the host
// must be explicit about which scope to target.
func (e *WasmEngine) UpdateModuleState(scope string, patch map[string]any) ([]Patch, error) {
	e.mu.Lock()
	defer e.mu.Unlock()

	if e.fnUpdateModuleState == nil {
		return nil, &EngineError{Code: ErrState, Message: "hypen_update_module_state not available in WASM module"}
	}

	config := map[string]any{
		"name":  scope,
		"state": patch,
	}

	jsonBytes, err := json.Marshal(config)
	if err != nil {
		return nil, err
	}

	ptr, size, err := e.writeString(string(jsonBytes))
	if err != nil {
		return nil, err
	}
	defer e.freePtr(ptr, size)

	results, err := e.fnUpdateModuleState.Call(e.ctx, uint64(ptr), uint64(size))
	if err != nil {
		return nil, &EngineError{Code: ErrState, Message: "update module state call failed", Cause: err}
	}
	if len(results) > 0 && results[0] != 0 {
		return nil, newWasmError("update_module_state", results[0])
	}

	patches, err := e.getPatches()
	if err == nil && len(patches) > 0 && e.patchCallback != nil {
		e.patchCallback(patches)
	}
	return patches, err
}

// SetPatchCallback sets a callback for when patches are generated
func (e *WasmEngine) SetPatchCallback(callback func(patches []Patch)) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.patchCallback = callback
}

// Verify WasmEngine implements IEngine
var _ IEngine = (*WasmEngine)(nil)
