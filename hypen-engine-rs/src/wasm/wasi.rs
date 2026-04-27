//! WASI-compatible bindings for Hypen Engine
//!
//! This module provides a C-compatible FFI interface for non-JavaScript WASM runtimes
//! like Go (wazero, wasmtime-go), Python (wasmtime, wasmer), Rust (wasmtime, wasmer),
//! and other languages that can embed WASM via WASI.
//!
//! ## Design
//!
//! Unlike the JS bindings which use wasm-bindgen and JavaScript types, this module uses:
//! - `extern "C"` functions with `#[no_mangle]` for stable ABI
//! - JSON strings for complex data exchange (passed as ptr+len pairs)
//! - A callback registration system using function table indices
//! - Memory allocation helpers for the host to allocate/free memory
//!
//! ## Usage Pattern
//!
//! 1. Host allocates memory using `wasi_alloc`
//! 2. Host writes JSON data to allocated memory
//! 3. Host calls engine functions with (ptr, len) pairs
//! 4. Engine processes and returns JSON via allocated memory
//! 5. Host reads result and frees memory using `wasi_free`
//!
//! For callbacks (patches, actions), the engine writes to a buffer and the host
//! polls for updates or uses WASI's event system.

use std::cell::RefCell;
use std::ffi::CStr;
use std::os::raw::c_char;

use crate::{
    dispatch::Action,
    engine_core::EngineCore,
    ir::{ast_to_ir_node, IRNode},
    lifecycle::ModuleInstance,
    reconcile::Patch,
    wasm::shared::{format_parse_errors, render_subtree_into, NodeIdIndex},
};

use super::ffi::{ActionPayload, ModuleConfig, SparseStateUpdate};

// Global engine instance for WASI (single-threaded).
// WASI runtimes are typically single-threaded, so we use thread-local storage.
thread_local! {
    static ENGINE: RefCell<Option<WasiEngine>> = RefCell::new(None);
    static PATCH_BUFFER: RefCell<Vec<u8>> = RefCell::new(Vec::new());
    static ACTION_BUFFER: RefCell<Vec<u8>> = RefCell::new(Vec::new());
    static IMPORT_BUFFER: RefCell<Vec<u8>> = RefCell::new(Vec::new());
    /// Stores a UTF-8 error message from the last failed operation.
    /// Populated whenever a function returns a non-zero error code.
    static ERROR_BUFFER: RefCell<Vec<u8>> = RefCell::new(Vec::new());
    /// Stores the JSON result of the last successful `hypen_portable_*`
    /// call. Read with [`hypen_get_portable_result`] / _len.
    static PORTABLE_BUFFER: RefCell<Vec<u8>> = RefCell::new(Vec::new());
}

/// Internal engine state for WASI.
///
/// Wraps `EngineCore` (shared with native `Engine` and `WasmEngine`) with the
/// WASI-specific extras: a captured root IR node, the host-registered action
/// list (whose names get serialized into `ACTION_BUFFER` on dispatch), an
/// O(1) node-id index used by `hypen_render_into` for lazy routing, and a
/// transient `active_action_scope` set by `hypen_dispatch_action` so the
/// follow-up `hypen_update_state` call can route to the right module without
/// the host having to track scopes itself.
struct WasiEngine {
    core: EngineCore,
    /// Index from compact node-ID strings to SlotMap keys. Shared with
    /// the JS binding (see `wasm::shared::NodeIdIndex`).
    node_id_index: NodeIdIndex,
    /// Active module scope set by `hypen_dispatch_action`. Read and cleared
    /// by the next `hypen_update_state` / `hypen_update_state_sparse` so
    /// host action handlers don't need to plumb the scope through themselves.
    active_action_scope: Option<String>,
}

impl WasiEngine {
    fn new() -> Self {
        Self {
            core: EngineCore::new(),
            node_id_index: NodeIdIndex::new(),
            active_action_scope: None,
        }
    }

    /// Filter spurious removes, index newly created node IDs for `render_into`,
    /// then write the patches to `PATCH_BUFFER` for the host to read.
    fn emit_patches(&mut self, mut patches: Vec<Patch>) {
        EngineCore::filter_spurious_removes(&mut patches);
        self.node_id_index.index_creates(&patches, &self.core);
        emit_patches_internal(&patches);
    }
}

// ============================================================================
// Memory Management
// ============================================================================

/// Allocate memory in the WASM linear memory
/// Returns a pointer to the allocated memory, or 0 on failure
#[no_mangle]
pub extern "C" fn wasi_alloc(size: usize) -> *mut u8 {
    let mut buf = Vec::with_capacity(size);
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

/// Free memory previously allocated with wasi_alloc
#[no_mangle]
pub extern "C" fn wasi_free(ptr: *mut u8, size: usize) {
    if !ptr.is_null() {
        unsafe {
            let _ = Vec::from_raw_parts(ptr, 0, size);
        }
    }
}

/// Get the length of a null-terminated string
#[no_mangle]
pub extern "C" fn wasi_strlen(ptr: *const c_char) -> usize {
    if ptr.is_null() {
        return 0;
    }
    unsafe { CStr::from_ptr(ptr).to_bytes().len() }
}

// ============================================================================
// Error Reporting
// ============================================================================

/// Store a human-readable error message for the last failed operation.
fn set_last_error(msg: &str) {
    ERROR_BUFFER.with(|buf| {
        *buf.borrow_mut() = msg.as_bytes().to_vec();
    });
}

/// Convenience: store an error and return the given code in one expression.
fn fail(code: i32, msg: &str) -> i32 {
    set_last_error(msg);
    code
}

/// Get the byte length of the last error message.
/// Returns 0 if there is no error.
#[no_mangle]
pub extern "C" fn hypen_get_last_error_len() -> usize {
    ERROR_BUFFER.with(|buf| buf.borrow().len())
}

/// Copy the last error message into the provided buffer.
/// Returns the number of bytes copied.
///
/// Typical host usage:
/// ```c
/// int rc = hypen_render_source(src, len);
/// if (rc != 0) {
///     size_t err_len = hypen_get_last_error_len();
///     char *err = (char *)wasi_alloc(err_len);
///     hypen_get_last_error(err, err_len);
///     // err now contains the UTF-8 error message
/// }
/// ```
#[no_mangle]
pub extern "C" fn hypen_get_last_error(out_ptr: *mut u8, out_len: usize) -> usize {
    ERROR_BUFFER.with(|buf| {
        let error = buf.borrow();
        let copy_len = error.len().min(out_len);
        if copy_len > 0 && !out_ptr.is_null() {
            unsafe {
                std::ptr::copy_nonoverlapping(error.as_ptr(), out_ptr, copy_len);
            }
        }
        copy_len
    })
}

/// Clear the error buffer.
#[no_mangle]
pub extern "C" fn hypen_clear_last_error() {
    ERROR_BUFFER.with(|buf| buf.borrow_mut().clear());
}

// ============================================================================
// Engine Lifecycle
// ============================================================================

/// Initialize the engine
/// Returns 0 on success, non-zero on error
#[no_mangle]
pub extern "C" fn hypen_init() -> i32 {
    ENGINE.with(|engine| {
        *engine.borrow_mut() = Some(WasiEngine::new());
    });
    // Clear any stale error from a previous session
    ERROR_BUFFER.with(|buf| buf.borrow_mut().clear());
    0
}

/// Destroy the engine and free resources
#[no_mangle]
pub extern "C" fn hypen_destroy() {
    ENGINE.with(|engine| {
        *engine.borrow_mut() = None;
    });
    PATCH_BUFFER.with(|buf| buf.borrow_mut().clear());
    ACTION_BUFFER.with(|buf| buf.borrow_mut().clear());
    ERROR_BUFFER.with(|buf| buf.borrow_mut().clear());
}

/// Get the current revision number
#[no_mangle]
pub extern "C" fn hypen_get_revision() -> u64 {
    ENGINE.with(|engine| engine.borrow().as_ref().map(|e| e.core.revision).unwrap_or(0))
}

// ============================================================================
// Rendering
// ============================================================================

/// Render Hypen DSL source code
///
/// # Arguments
/// * `source_ptr` - Pointer to UTF-8 source string
/// * `source_len` - Length of source string in bytes
///
/// # Returns
/// 0 on success, non-zero error code on failure.
/// Error details can be retrieved with `hypen_get_last_error` / `hypen_get_last_error_len`.
#[no_mangle]
pub extern "C" fn hypen_render_source(source_ptr: *const u8, source_len: usize) -> i32 {
    let source = match ptr_to_str(source_ptr, source_len) {
        Ok(s) => s,
        Err(_) => return fail(1, "hypen_render_source: invalid UTF-8 source pointer"),
    };

    ENGINE.with(|engine| {
        let mut engine_ref = engine.borrow_mut();
        let engine = match engine_ref.as_mut() {
            Some(e) => e,
            None => {
                return fail(
                    2,
                    "hypen_render_source: engine not initialized (call hypen_init first)",
                )
            }
        };

        match hypen_parser::parse_document(source) {
            Ok(doc) => {
                // Serialize imports to the import buffer for SDK to query
                store_pending_imports(&doc.imports);

                if let Some(component) = doc.components.first() {
                    let ir_node = ast_to_ir_node(component);
                    render_internal(engine, &ir_node);
                }
                0
            }
            Err(errs) => {
                let msg = format!(
                    "hypen_render_source: parse error: {}",
                    format_parse_errors(&errs)
                );
                fail(3, &msg)
            }
        }
    })
}

/// Render into a specific parent node (for lazy routing)
///
/// # Arguments
/// * `source_ptr/len` - Hypen DSL source to render
/// * `parent_id_ptr/len` - Parent node ID string
/// * `state_ptr/len` - JSON state object (or empty for null)
///
/// # Returns
/// 0 on success, non-zero on error
#[no_mangle]
pub extern "C" fn hypen_render_into(
    source_ptr: *const u8,
    source_len: usize,
    parent_id_ptr: *const u8,
    parent_id_len: usize,
    state_ptr: *const u8,
    state_len: usize,
) -> i32 {
    let source = match ptr_to_str(source_ptr, source_len) {
        Ok(s) => s,
        Err(_) => return fail(1, "hypen_render_into: invalid UTF-8 source pointer"),
    };
    let parent_id_str = match ptr_to_str(parent_id_ptr, parent_id_len) {
        Ok(s) => s,
        Err(_) => return fail(1, "hypen_render_into: invalid UTF-8 parent_id pointer"),
    };
    let state: serde_json::Value = if state_len == 0 {
        serde_json::Value::Null
    } else {
        match ptr_to_str(state_ptr, state_len) {
            Ok(s) => serde_json::from_str(s).unwrap_or(serde_json::Value::Null),
            Err(_) => serde_json::Value::Null,
        }
    };

    ENGINE.with(|engine| {
        let mut engine_ref = engine.borrow_mut();
        let engine = match engine_ref.as_mut() {
            Some(e) => e,
            None => {
                return fail(
                    2,
                    "hypen_render_into: engine not initialized (call hypen_init first)",
                )
            }
        };

        let doc = match hypen_parser::parse_document(source) {
            Ok(d) => d,
            Err(errs) => {
                let msg = format!(
                    "hypen_render_into: parse error: {}",
                    format_parse_errors(&errs)
                );
                return fail(3, &msg);
            }
        };

        // Store imports for SDK to query
        store_pending_imports(&doc.imports);

        let component = match doc.components.first() {
            Some(c) => c,
            None => return fail(3, "hypen_render_into: document contains no components"),
        };

        let ir_node = ast_to_ir_node(component);
        let expanded = engine.core.component_registry.expand_ir_node(&ir_node);

        // O(1) lookup via the node-ID index
        let parent_id = match engine.node_id_index.lookup(parent_id_str) {
            Some(id) => id,
            None => {
                return fail(
                    4,
                    &format!(
                        "hypen_render_into: parent node '{}' not found in tree",
                        parent_id_str
                    ),
                )
            }
        };

        let mut patches = Vec::new();
        render_subtree_into(&mut engine.core, parent_id, &expanded, &state, &mut patches);
        engine.emit_patches(patches);
        0
    })
}

/// Internal render helper.
///
/// Delegates to `EngineCore::render_ir_node` for the shared
/// expand → resolve-icons → auto-register-modules → reconcile → patches pipeline,
/// then emits the patches via the WASI patch buffer.
fn render_internal(engine: &mut WasiEngine, ir_node: &IRNode) {
    let patches = engine.core.render_ir_node(ir_node);
    engine.emit_patches(patches);
}

// ============================================================================
// State Management
// ============================================================================

/// Update state with a JSON patch
///
/// # Arguments
/// * `patch_ptr/len` - JSON object with state changes
///
/// # Returns
/// 0 on success, non-zero on error
#[no_mangle]
pub extern "C" fn hypen_update_state(patch_ptr: *const u8, patch_len: usize) -> i32 {
    let patch_str = match ptr_to_str(patch_ptr, patch_len) {
        Ok(s) => s,
        Err(_) => return fail(1, "hypen_update_state: invalid UTF-8 patch pointer"),
    };

    let patch: serde_json::Value = match serde_json::from_str(patch_str) {
        Ok(v) => v,
        Err(e) => return fail(2, &format!("hypen_update_state: invalid JSON: {}", e)),
    };

    ENGINE.with(|engine| {
        let mut engine_ref = engine.borrow_mut();
        let engine = match engine_ref.as_mut() {
            Some(e) => e,
            None => return fail(3, "hypen_update_state: engine not initialized"),
        };

        let scope = engine.active_action_scope.take();
        if engine.core.update_state(scope.as_deref(), patch) {
            render_dirty_internal(engine);
        }
        0
    })
}

/// Internal: update a named module's state and re-render affected nodes.
/// Returns 0 on success, non-zero on error.
///
/// `EngineCore::register_module` lowercases the scope name, so the
/// existence check and update must too.
fn update_module_state_internal(engine: &mut WasiEngine, name: &str, patch: serde_json::Value) -> i32 {
    let canonical = name.to_lowercase();
    if !engine.core.modules.contains_key(&canonical) {
        return fail(4, &format!("update_module_state: module '{}' not found", name));
    }
    if engine.core.update_state(Some(&canonical), patch) {
        render_dirty_internal(engine);
    }
    0
}

/// Update a named module's state and re-render affected nodes.
///
/// # Arguments
/// * `config_ptr/len` - JSON object with { "name": "<module_name>", "state": { ... } }
///
/// # Returns
/// 0 on success, non-zero on error
#[no_mangle]
pub extern "C" fn hypen_update_module_state(config_ptr: *const u8, config_len: usize) -> i32 {
    let config_str = match ptr_to_str(config_ptr, config_len) {
        Ok(s) => s,
        Err(_) => return fail(1, "hypen_update_module_state: invalid UTF-8 config pointer"),
    };

    #[derive(serde::Deserialize)]
    struct ModuleStateUpdate {
        name: String,
        state: serde_json::Value,
    }

    let update: ModuleStateUpdate = match serde_json::from_str(config_str) {
        Ok(v) => v,
        Err(e) => return fail(2, &format!("hypen_update_module_state: invalid JSON: {}", e)),
    };

    ENGINE.with(|engine| {
        let mut engine_ref = engine.borrow_mut();
        let engine = match engine_ref.as_mut() {
            Some(e) => e,
            None => return fail(3, "hypen_update_module_state: engine not initialized"),
        };

        // EngineCore::update_state canonicalizes the scope, so we pass the
        // host-supplied name through unchanged.
        update_module_state_internal(engine, &update.name, update.state)
    })
}

/// Update state with sparse path-value pairs (more efficient for large state)
///
/// # Arguments
/// * `update_ptr/len` - JSON object with { paths: string[], values: object }
///
/// # Returns
/// 0 on success, non-zero on error
#[no_mangle]
pub extern "C" fn hypen_update_state_sparse(update_ptr: *const u8, update_len: usize) -> i32 {
    let update_str = match ptr_to_str(update_ptr, update_len) {
        Ok(s) => s,
        Err(_) => return fail(1, "hypen_update_state_sparse: invalid UTF-8 update pointer"),
    };

    let update: SparseStateUpdate = match serde_json::from_str(update_str) {
        Ok(v) => v,
        Err(e) => {
            return fail(
                2,
                &format!("hypen_update_state_sparse: invalid JSON: {}", e),
            )
        }
    };

    ENGINE.with(|engine| {
        let mut engine_ref = engine.borrow_mut();
        let engine = match engine_ref.as_mut() {
            Some(e) => e,
            None => return fail(3, "hypen_update_state_sparse: engine not initialized"),
        };

        let scope = engine.active_action_scope.take();
        if engine
            .core
            .update_state_sparse(scope.as_deref(), &update.paths, &update.values)
        {
            render_dirty_internal(engine);
        }
        0
    })
}

fn render_dirty_internal(engine: &mut WasiEngine) {
    let patches = engine.core.render_dirty();
    if !patches.is_empty() {
        engine.emit_patches(patches);
    }
}

// ============================================================================
// Data Source Context
// ============================================================================

/// Set (or replace) a named data source context.
///
/// Registers the provider, stores the data, and re-renders bound nodes.
/// Sparse merging should happen at the host layer before calling this.
///
/// # Arguments
/// * `name_ptr/len` - UTF-8 provider name (e.g., "spacetime")
/// * `data_ptr/len` - JSON data object
///
/// # Returns
/// 0 on success, non-zero on error
#[no_mangle]
pub extern "C" fn hypen_set_context(
    name_ptr: *const u8,
    name_len: usize,
    data_ptr: *const u8,
    data_len: usize,
) -> i32 {
    let name = match ptr_to_str(name_ptr, name_len) {
        Ok(s) => s,
        Err(_) => return fail(1, "hypen_set_context: invalid UTF-8 name pointer"),
    };
    let data_str = match ptr_to_str(data_ptr, data_len) {
        Ok(s) => s,
        Err(_) => return fail(1, "hypen_set_context: invalid UTF-8 data pointer"),
    };
    let data: serde_json::Value = match serde_json::from_str(data_str) {
        Ok(v) => v,
        Err(e) => return fail(2, &format!("hypen_set_context: invalid JSON: {}", e)),
    };

    ENGINE.with(|cell| {
        let mut engine = cell.borrow_mut();
        let engine = match engine.as_mut() {
            Some(e) => e,
            None => {
                return fail(
                    3,
                    "hypen_set_context: engine not initialized (call hypen_init first)",
                )
            }
        };

        engine.core.set_context(name, data);
        render_dirty_internal(engine);
        0
    })
}

/// Remove a data source context entirely.
///
/// Drops the provider's state and re-renders bound nodes (they resolve to null).
///
/// # Arguments
/// * `name_ptr/len` - UTF-8 provider name
///
/// # Returns
/// 0 on success, non-zero on error
#[no_mangle]
pub extern "C" fn hypen_remove_context(name_ptr: *const u8, name_len: usize) -> i32 {
    let name = match ptr_to_str(name_ptr, name_len) {
        Ok(s) => s,
        Err(_) => return fail(1, "hypen_remove_context: invalid UTF-8 name pointer"),
    };

    ENGINE.with(|cell| {
        let mut engine = cell.borrow_mut();
        let engine = match engine.as_mut() {
            Some(e) => e,
            None => {
                return fail(
                    2,
                    "hypen_remove_context: engine not initialized (call hypen_init first)",
                )
            }
        };

        engine.core.remove_context(name);
        render_dirty_internal(engine);
        0
    })
}

// ============================================================================
// Module Management
// ============================================================================

/// Set the module configuration
///
/// # Arguments
/// * `config_ptr/len` - JSON ModuleConfig object
///
/// # Returns
/// 0 on success, non-zero on error
#[no_mangle]
pub extern "C" fn hypen_set_module(config_ptr: *const u8, config_len: usize) -> i32 {
    let config_str = match ptr_to_str(config_ptr, config_len) {
        Ok(s) => s,
        Err(_) => return fail(1, "hypen_set_module: invalid UTF-8 config pointer"),
    };

    let config: ModuleConfig = match serde_json::from_str(config_str) {
        Ok(v) => v,
        Err(e) => return fail(2, &format!("hypen_set_module: invalid JSON: {}", e)),
    };

    ENGINE.with(|engine| {
        let mut engine_ref = engine.borrow_mut();
        let engine = match engine_ref.as_mut() {
            Some(e) => e,
            None => return fail(3, "hypen_set_module: engine not initialized"),
        };

        let instance = ModuleInstance::from_config(
            &config.name,
            config.actions,
            config.state_keys,
            config.initial_state,
        );
        engine.core.set_module(instance);
        0
    })
}

/// Register a named module for multi-module apps.
///
/// Unlike `hypen_set_module` (which sets the *primary* module), this adds
/// a secondary module whose state is scoped to components rendered with
/// `module <name> { ... }` in the DSL.
///
/// # Arguments
/// * `config_ptr/len` - JSON ModuleConfig object (same schema as hypen_set_module)
///
/// # Returns
/// 0 on success, non-zero on error
#[no_mangle]
pub extern "C" fn hypen_register_module(config_ptr: *const u8, config_len: usize) -> i32 {
    let config_str = match ptr_to_str(config_ptr, config_len) {
        Ok(s) => s,
        Err(_) => return fail(1, "hypen_register_module: invalid UTF-8 config pointer"),
    };

    let config: ModuleConfig = match serde_json::from_str(config_str) {
        Ok(v) => v,
        Err(e) => return fail(2, &format!("hypen_register_module: invalid JSON: {}", e)),
    };

    ENGINE.with(|engine| {
        let mut engine_ref = engine.borrow_mut();
        let engine = match engine_ref.as_mut() {
            Some(e) => e,
            None => return fail(3, "hypen_register_module: engine not initialized"),
        };

        let instance = ModuleInstance::from_config(
            &config.name,
            config.actions,
            config.state_keys,
            config.initial_state,
        );
        engine.core.register_module(config.name, instance);
        0
    })
}

// ============================================================================
// Actions
// ============================================================================

/// Register an action handler (the name will be captured when dispatched)
///
/// # Arguments
/// * `name_ptr/len` - Action name string
///
/// # Returns
/// 0 on success, non-zero on error
#[no_mangle]
pub extern "C" fn hypen_register_action(name_ptr: *const u8, name_len: usize) -> i32 {
    let name = match ptr_to_str(name_ptr, name_len) {
        Ok(s) => s.to_string(),
        Err(_) => return fail(1, "hypen_register_action: invalid UTF-8 name pointer"),
    };

    ENGINE.with(|engine| {
        let mut engine_ref = engine.borrow_mut();
        if let Some(e) = engine_ref.as_mut() {
            e.core.registered_actions.push(name);
            0
        } else {
            fail(2, "hypen_register_action: engine not initialized")
        }
    })
}

/// Dispatch an action
///
/// # Arguments
/// * `action_ptr/len` - JSON ActionPayload object { name, payload }
///
/// # Returns
/// 0 on success, non-zero on error
#[no_mangle]
pub extern "C" fn hypen_dispatch_action(action_ptr: *const u8, action_len: usize) -> i32 {
    let action_str = match ptr_to_str(action_ptr, action_len) {
        Ok(s) => s,
        Err(_) => return fail(1, "hypen_dispatch_action: invalid UTF-8 action pointer"),
    };

    let action_payload: ActionPayload = match serde_json::from_str(action_str) {
        Ok(v) => v,
        Err(e) => return fail(2, &format!("hypen_dispatch_action: invalid JSON: {}", e)),
    };

    ENGINE.with(|engine| {
        let mut engine_ref = engine.borrow_mut();
        let engine = match engine_ref.as_mut() {
            Some(e) => e,
            None => return fail(3, "hypen_dispatch_action: engine not initialized"),
        };

        // Set active scope so the next hypen_update_state routes to the correct module
        engine.active_action_scope = engine.core.action_scope_for(&action_payload.name);

        // Registered action: serialize the Action envelope. Otherwise fall
        // back to the shared data-source classifier on EngineCore.
        if engine.core.registered_actions.contains(&action_payload.name) {
            let action = Action::new(&action_payload.name).with_payload(action_payload.payload);
            ACTION_BUFFER.with(|buf| {
                if let Ok(json) = serde_json::to_vec(&action) {
                    *buf.borrow_mut() = json;
                }
            });
        } else if let Some(ds_action) = engine
            .core
            .build_data_source_action(&action_payload.name, action_payload.payload)
        {
            ACTION_BUFFER.with(|buf| {
                if let Ok(json) = serde_json::to_vec(&ds_action) {
                    *buf.borrow_mut() = json;
                }
            });
        }
        0
    })
}

// ============================================================================
// Component Registration
// ============================================================================

/// Register a primitive element type (skips component resolution)
///
/// # Arguments
/// * `name_ptr/len` - Primitive name string (e.g., "Text", "Button")
///
/// # Returns
/// 0 on success, non-zero on error
#[no_mangle]
pub extern "C" fn hypen_register_primitive(name_ptr: *const u8, name_len: usize) -> i32 {
    let name = match ptr_to_str(name_ptr, name_len) {
        Ok(s) => s,
        Err(_) => return fail(1, "hypen_register_primitive: invalid UTF-8 name pointer"),
    };

    ENGINE.with(|engine| {
        let mut engine_ref = engine.borrow_mut();
        if let Some(e) = engine_ref.as_mut() {
            e.core.component_registry.register_primitive(name);
            0
        } else {
            fail(2, "hypen_register_primitive: engine not initialized")
        }
    })
}

/// Register all standard Hypen primitives (Text, Column, Row, Button, etc.)
///
/// # Returns
/// 0 on success, non-zero on error
#[no_mangle]
pub extern "C" fn hypen_register_default_primitives() -> i32 {
    ENGINE.with(|engine| {
        let mut engine_ref = engine.borrow_mut();
        if let Some(e) = engine_ref.as_mut() {
            e.core.component_registry.register_default_primitives();
            0
        } else {
            fail(
                2,
                "hypen_register_default_primitives: engine not initialized",
            )
        }
    })
}

/// Register a component from source
///
/// # Arguments
/// * `name_ptr/len` - Component name
/// * `source_ptr/len` - Hypen DSL source
/// * `path_ptr/len` - Source file path
///
/// # Returns
/// 0 on success, non-zero on error
#[no_mangle]
pub extern "C" fn hypen_register_component(
    name_ptr: *const u8,
    name_len: usize,
    source_ptr: *const u8,
    source_len: usize,
    path_ptr: *const u8,
    path_len: usize,
) -> i32 {
    let name = match ptr_to_str(name_ptr, name_len) {
        Ok(s) => s.to_string(),
        Err(_) => return fail(1, "hypen_register_component: invalid UTF-8 name pointer"),
    };
    let source = match ptr_to_str(source_ptr, source_len) {
        Ok(s) => s,
        Err(_) => return fail(1, "hypen_register_component: invalid UTF-8 source pointer"),
    };
    let path = match ptr_to_str(path_ptr, path_len) {
        Ok(s) => s.to_string(),
        Err(_) => return fail(1, "hypen_register_component: invalid UTF-8 path pointer"),
    };

    ENGINE.with(|engine| {
        let mut engine_ref = engine.borrow_mut();
        let engine = match engine_ref.as_mut() {
            Some(e) => e,
            None => return fail(2, "hypen_register_component: engine not initialized"),
        };

        match hypen_parser::parse_component(source) {
            Ok(component_spec) => {
                let ir_node = ast_to_ir_node(&component_spec);
                let ir_element = match ir_node {
                    IRNode::Element(e) => e,
                    _ => return fail(3, "hypen_register_component: component root must be an element"),
                };
                let is_module = component_spec.declaration_type
                    == hypen_parser::DeclarationType::Module;
                let module_name = if is_module {
                    Some(component_spec.name.to_lowercase())
                } else {
                    None
                };
                let mut component = crate::ir::Component::new(name, move |_props| ir_element.clone())
                    .with_source_path(&path);
                if is_module {
                    component.is_module = true;
                    component.module_name = module_name;
                }
                engine.core.component_registry.register(component);
                0
            }
            Err(errs) => {
                let msg = format!(
                    "hypen_register_component: parse error: {}",
                    format_parse_errors(&errs)
                );
                fail(3, &msg)
            }
        }
    })
}

// ============================================================================
// Resource Registration
// ============================================================================

/// Register SVG resources with the engine as a flat `{ "name": "<svg>..." }` JSON map.
///
/// The engine parses each raw SVG string and stores it in its resource registry,
/// so that `Icon(@resources.xxx)` references get resolved into concrete path
/// data during render. This is the WASI equivalent of `Engine::register_resources`
/// / wasm-bindgen `registerResources` / UniFFI `register_resources` — adding it
/// here lets hosts (like the Go SDK) skip their own SVG parsing and centralize
/// all parsing in the engine for cross-language parity.
///
/// # Returns
/// 0 on success, non-zero on error (1: invalid UTF-8, 2: invalid JSON, 3: engine not initialized)
#[no_mangle]
pub extern "C" fn hypen_register_resources(json_ptr: *const u8, json_len: usize) -> i32 {
    let json_str = match ptr_to_str(json_ptr, json_len) {
        Ok(s) => s,
        Err(_) => return fail(1, "hypen_register_resources: invalid UTF-8 JSON pointer"),
    };

    let map: indexmap::IndexMap<String, String> = match serde_json::from_str(json_str) {
        Ok(v) => v,
        Err(e) => {
            return fail(
                2,
                &format!("hypen_register_resources: invalid JSON (expected {{name: svg}} map): {}", e),
            )
        }
    };

    ENGINE.with(|engine| {
        let mut engine_ref = engine.borrow_mut();
        if let Some(e) = engine_ref.as_mut() {
            e.core.register_resources(map);
            0
        } else {
            fail(3, "hypen_register_resources: engine not initialized")
        }
    })
}

// ============================================================================
// Buffer Access (for retrieving patches and actions)
// ============================================================================

/// Get the size of the patch buffer
#[no_mangle]
pub extern "C" fn hypen_get_patches_len() -> usize {
    PATCH_BUFFER.with(|buf| buf.borrow().len())
}

/// Copy patches to the provided buffer
/// Returns the number of bytes copied
#[no_mangle]
pub extern "C" fn hypen_get_patches(out_ptr: *mut u8, out_len: usize) -> usize {
    PATCH_BUFFER.with(|buf| {
        let patches = buf.borrow();
        let copy_len = patches.len().min(out_len);
        if copy_len > 0 && !out_ptr.is_null() {
            unsafe {
                std::ptr::copy_nonoverlapping(patches.as_ptr(), out_ptr, copy_len);
            }
        }
        copy_len
    })
}

/// Clear the patch buffer (call after processing patches)
#[no_mangle]
pub extern "C" fn hypen_clear_patches() {
    PATCH_BUFFER.with(|buf| buf.borrow_mut().clear());
}

/// Get the size of the action buffer
#[no_mangle]
pub extern "C" fn hypen_get_action_len() -> usize {
    ACTION_BUFFER.with(|buf| buf.borrow().len())
}

/// Copy the pending action to the provided buffer
/// Returns the number of bytes copied
#[no_mangle]
pub extern "C" fn hypen_get_action(out_ptr: *mut u8, out_len: usize) -> usize {
    ACTION_BUFFER.with(|buf| {
        let action = buf.borrow();
        let copy_len = action.len().min(out_len);
        if copy_len > 0 && !out_ptr.is_null() {
            unsafe {
                std::ptr::copy_nonoverlapping(action.as_ptr(), out_ptr, copy_len);
            }
        }
        copy_len
    })
}

/// Clear the action buffer (call after processing the action)
#[no_mangle]
pub extern "C" fn hypen_clear_action() {
    ACTION_BUFFER.with(|buf| buf.borrow_mut().clear());
}

// ============================================================================
// Import Support
// ============================================================================

/// Get the size of the pending imports buffer
/// After calling hypen_render_source, this returns the size of the JSON-serialized
/// import statements that were found in the document.
/// Returns 0 if there are no imports.
#[no_mangle]
pub extern "C" fn hypen_get_pending_imports_len() -> usize {
    IMPORT_BUFFER.with(|buf| buf.borrow().len())
}

/// Copy pending imports JSON to the provided buffer
/// The JSON format is: [{ "names": ["Button", "Card"], "source_path": "./ui", "source_type": "local" }, ...]
/// Returns the number of bytes copied
#[no_mangle]
pub extern "C" fn hypen_get_pending_imports(out_ptr: *mut u8, out_len: usize) -> usize {
    IMPORT_BUFFER.with(|buf| {
        let imports = buf.borrow();
        let copy_len = imports.len().min(out_len);
        if copy_len > 0 && !out_ptr.is_null() {
            unsafe {
                std::ptr::copy_nonoverlapping(imports.as_ptr(), out_ptr, copy_len);
            }
        }
        copy_len
    })
}

/// Clear the pending imports buffer (call after processing imports)
#[no_mangle]
pub extern "C" fn hypen_clear_pending_imports() {
    IMPORT_BUFFER.with(|buf| buf.borrow_mut().clear());
}

// ============================================================================
// Utility Functions
// ============================================================================

/// Clear the engine tree
#[no_mangle]
pub extern "C" fn hypen_clear_tree() {
    ENGINE.with(|engine| {
        if let Some(e) = engine.borrow_mut().as_mut() {
            e.core.tree.clear();
        }
    });
}

/// Parse Hypen DSL and return AST as JSON
/// The result is written to the patch buffer (reused for convenience)
///
/// # Returns
/// 0 on success, non-zero on error
#[no_mangle]
pub extern "C" fn hypen_parse_to_json(source_ptr: *const u8, source_len: usize) -> i32 {
    let source = match ptr_to_str(source_ptr, source_len) {
        Ok(s) => s,
        Err(_) => return fail(1, "hypen_parse_to_json: invalid UTF-8 source pointer"),
    };

    match hypen_parser::parse_component(source) {
        Ok(component) => match serde_json::to_vec_pretty(&component) {
            Ok(json) => {
                PATCH_BUFFER.with(|buf| *buf.borrow_mut() = json);
                0
            }
            Err(e) => fail(
                2,
                &format!("hypen_parse_to_json: JSON serialization error: {}", e),
            ),
        },
        Err(errs) => {
            let msg = format!(
                "hypen_parse_to_json: parse error: {}",
                format_parse_errors(&errs)
            );
            fail(3, &msg)
        }
    }
}

// ============================================================================
// Internal Helpers
// ============================================================================

/// Convert a pointer + length to a string slice
fn ptr_to_str<'a>(ptr: *const u8, len: usize) -> Result<&'a str, ()> {
    if ptr.is_null() {
        // Null pointer with zero length is a valid empty string
        if len == 0 {
            return Ok("");
        }
        return Err(());
    }
    unsafe {
        let slice = std::slice::from_raw_parts(ptr, len);
        std::str::from_utf8(slice).map_err(|_| ())
    }
}

/// Write patches to the buffer
fn emit_patches_internal(patches: &[Patch]) {
    if let Ok(json) = serde_json::to_vec(patches) {
        PATCH_BUFFER.with(|buf| *buf.borrow_mut() = json);
    }
}

/// Serialize import statements to the import buffer for SDK consumption
fn store_pending_imports(imports: &[hypen_parser::ImportStatement]) {
    if imports.is_empty() {
        IMPORT_BUFFER.with(|buf| buf.borrow_mut().clear());
        return;
    }

    // Serialize to a simple JSON format the SDKs can parse
    let import_infos: Vec<serde_json::Value> = imports
        .iter()
        .map(|imp| {
            let (source_path, source_type) = match &imp.source {
                hypen_parser::ImportSource::Local(p) => (p.as_str(), "local"),
                hypen_parser::ImportSource::Url(u) => (u.as_str(), "url"),
            };
            serde_json::json!({
                "names": imp.imported_names(),
                "source_path": source_path,
                "source_type": source_type,
            })
        })
        .collect();

    if let Ok(json) = serde_json::to_vec(&import_infos) {
        IMPORT_BUFFER.with(|buf| *buf.borrow_mut() = json);
    }
}

// ============================================================================
// Portable helpers (see engine::portable)
// ============================================================================
//
// WASI C FFI surface for the engine's portable helpers. Each call
// stores its JSON result in `PORTABLE_BUFFER`; the host retrieves it
// with `hypen_get_portable_result_len` / `hypen_get_portable_result`.
//
// Input format: UTF-8 JSON, passed as (ptr, len) pairs.
// Output format: UTF-8 JSON, written into `PORTABLE_BUFFER`.
// Return codes: 0 = success, non-zero = error (see `hypen_get_last_error`).

fn write_portable_result(bytes: Vec<u8>) {
    PORTABLE_BUFFER.with(|buf| *buf.borrow_mut() = bytes);
}

/// Parse a Hypen DSL source and return every `Router { Route … }` block
/// it contains. Result JSON layout matches the wasm-bindgen
/// `discoverRouters` return — `[{ "module_scope": null|"name",
/// "routes": [{ "path": "...", "element_names": ["..."] }] }]`. SDKs
/// that call into this pick the first `element_names` entry that maps
/// to a registered module, matching the TS `BaseEngine.discoverRouters`
/// logic.
#[no_mangle]
pub extern "C" fn hypen_discover_routers(src_ptr: *const u8, src_len: usize) -> i32 {
    let src = match ptr_to_str(src_ptr, src_len) {
        Ok(s) => s,
        Err(_) => return fail(1, "hypen_discover_routers: invalid UTF-8 source pointer"),
    };

    let doc = match hypen_parser::parse_document(src) {
        Ok(d) => d,
        Err(e) => {
            // Include the formatted parser error batch so server logs can point
            // at the exact line — mirrors render_source's error shape.
            let msg = crate::wasm::shared::format_parse_errors(&e);
            return fail(2, &format!("hypen_discover_routers: parse error: {msg}"));
        }
    };

    let mut routers = Vec::new();
    for component in &doc.components {
        let ir = crate::ir::ast_to_ir_node(component);
        routers.extend(crate::ir::discover_routers(&ir));
    }

    match serde_json::to_vec(&routers) {
        Ok(bytes) => {
            write_portable_result(bytes);
            0
        }
        Err(e) => fail(3, &format!("hypen_discover_routers: serialise: {e}")),
    }
}

/// Compute the dotted-path diff between two JSON blobs.
///
/// Result JSON layout: `[{"path": "...", "value": <any>}, ...]`.
/// See [`crate::portable::diff_paths`] for semantics.
#[no_mangle]
pub extern "C" fn hypen_portable_diff_paths(
    old_ptr: *const u8,
    old_len: usize,
    new_ptr: *const u8,
    new_len: usize,
) -> i32 {
    let old_str = match ptr_to_str(old_ptr, old_len) {
        Ok(s) => s,
        Err(_) => return fail(1, "hypen_portable_diff_paths: invalid UTF-8 old pointer"),
    };
    let new_str = match ptr_to_str(new_ptr, new_len) {
        Ok(s) => s,
        Err(_) => return fail(1, "hypen_portable_diff_paths: invalid UTF-8 new pointer"),
    };

    let old_val: serde_json::Value = match serde_json::from_str(old_str) {
        Ok(v) => v,
        Err(e) => return fail(2, &format!("hypen_portable_diff_paths: bad old JSON: {e}")),
    };
    let new_val: serde_json::Value = match serde_json::from_str(new_str) {
        Ok(v) => v,
        Err(e) => return fail(2, &format!("hypen_portable_diff_paths: bad new JSON: {e}")),
    };

    let entries: Vec<serde_json::Value> = crate::portable::diff_paths(&old_val, &new_val)
        .into_iter()
        .map(|e| serde_json::json!({ "path": e.path, "value": e.new_value }))
        .collect();

    match serde_json::to_vec(&entries) {
        Ok(bytes) => {
            write_portable_result(bytes);
            0
        }
        Err(e) => fail(3, &format!("hypen_portable_diff_paths: serialise: {e}")),
    }
}

/// Match a URL pattern against a path.
///
/// Result JSON layout: `{"matched": bool, "params": {"id": "42"}}`.
/// See [`crate::portable::match_path`] for semantics.
#[no_mangle]
pub extern "C" fn hypen_portable_match_path(
    pattern_ptr: *const u8,
    pattern_len: usize,
    path_ptr: *const u8,
    path_len: usize,
) -> i32 {
    let pattern = match ptr_to_str(pattern_ptr, pattern_len) {
        Ok(s) => s,
        Err(_) => return fail(1, "hypen_portable_match_path: invalid UTF-8 pattern pointer"),
    };
    let path = match ptr_to_str(path_ptr, path_len) {
        Ok(s) => s,
        Err(_) => return fail(1, "hypen_portable_match_path: invalid UTF-8 path pointer"),
    };

    let json = match crate::portable::match_path(pattern, path) {
        Some(m) => {
            let params: serde_json::Map<String, serde_json::Value> = m
                .params
                .into_iter()
                .map(|(k, v)| (k, serde_json::Value::String(v)))
                .collect();
            serde_json::json!({ "matched": true, "params": params })
        }
        None => serde_json::json!({ "matched": false, "params": {} }),
    };

    match serde_json::to_vec(&json) {
        Ok(bytes) => {
            write_portable_result(bytes);
            0
        }
        Err(e) => fail(3, &format!("hypen_portable_match_path: serialise: {e}")),
    }
}

/// Advance the session state machine by one event.
///
/// `state_ptr/len` and `event_ptr/len` are the serialised
/// `SessionState` / `SessionEvent`. Result is the serialised
/// `SessionEffect`.
#[no_mangle]
pub extern "C" fn hypen_portable_session_step(
    state_ptr: *const u8,
    state_len: usize,
    event_ptr: *const u8,
    event_len: usize,
) -> i32 {
    let state_str = match ptr_to_str(state_ptr, state_len) {
        Ok(s) => s,
        Err(_) => return fail(1, "hypen_portable_session_step: invalid UTF-8 state pointer"),
    };
    let event_str = match ptr_to_str(event_ptr, event_len) {
        Ok(s) => s,
        Err(_) => return fail(1, "hypen_portable_session_step: invalid UTF-8 event pointer"),
    };

    let state: crate::portable::SessionState = match serde_json::from_str(state_str) {
        Ok(v) => v,
        Err(e) => return fail(2, &format!("hypen_portable_session_step: bad state: {e}")),
    };
    let event: crate::portable::SessionEvent = match serde_json::from_str(event_str) {
        Ok(v) => v,
        Err(e) => return fail(2, &format!("hypen_portable_session_step: bad event: {e}")),
    };

    let effect = crate::portable::session_step(&state, &event);
    match serde_json::to_vec(&effect) {
        Ok(bytes) => {
            write_portable_result(bytes);
            0
        }
        Err(e) => fail(3, &format!("hypen_portable_session_step: serialise: {e}")),
    }
}

/// Return the byte length of the last `hypen_portable_*` result.
#[no_mangle]
pub extern "C" fn hypen_get_portable_result_len() -> usize {
    PORTABLE_BUFFER.with(|buf| buf.borrow().len())
}

/// Copy the last `hypen_portable_*` result into the caller's buffer.
/// Returns the number of bytes copied.
#[no_mangle]
pub extern "C" fn hypen_get_portable_result(out_ptr: *mut u8, out_len: usize) -> usize {
    PORTABLE_BUFFER.with(|buf| {
        let src = buf.borrow();
        let copy_len = src.len().min(out_len);
        if copy_len > 0 && !out_ptr.is_null() {
            unsafe {
                std::ptr::copy_nonoverlapping(src.as_ptr(), out_ptr, copy_len);
            }
        }
        copy_len
    })
}

/// Clear the portable result buffer. Optional — each portable call
/// overwrites the previous result.
#[no_mangle]
pub extern "C" fn hypen_clear_portable_result() {
    PORTABLE_BUFFER.with(|buf| buf.borrow_mut().clear());
}

// ────────────────────────────────────────────────────────────────────────
// Portable path + URL helpers
// ────────────────────────────────────────────────────────────────────────
//
// Same ptr+len calling convention as the other `hypen_portable_*`
// functions; results go into `PORTABLE_BUFFER`, retrieved via the
// existing `hypen_get_portable_result_len` / `hypen_get_portable_result`.

/// path_get: read JSON value at a dotted path. Result is JSON (or "null").
#[no_mangle]
pub extern "C" fn hypen_portable_path_get(
    value_ptr: *const u8,
    value_len: usize,
    path_ptr: *const u8,
    path_len: usize,
) -> i32 {
    let value_str = match ptr_to_str(value_ptr, value_len) {
        Ok(s) => s,
        Err(_) => return fail(1, "hypen_portable_path_get: invalid UTF-8 value pointer"),
    };
    let path = match ptr_to_str(path_ptr, path_len) {
        Ok(s) => s,
        Err(_) => return fail(1, "hypen_portable_path_get: invalid UTF-8 path pointer"),
    };
    let v: serde_json::Value = match serde_json::from_str(value_str) {
        Ok(v) => v,
        Err(e) => return fail(2, &format!("hypen_portable_path_get: bad JSON: {e}")),
    };
    let out = crate::portable::path_get(&v, path).unwrap_or(serde_json::Value::Null);
    match serde_json::to_vec(&out) {
        Ok(bytes) => {
            write_portable_result(bytes);
            0
        }
        Err(e) => fail(3, &format!("hypen_portable_path_get: serialise: {e}")),
    }
}

/// path_has: returns `"true"` / `"false"` (JSON booleans).
#[no_mangle]
pub extern "C" fn hypen_portable_path_has(
    value_ptr: *const u8,
    value_len: usize,
    path_ptr: *const u8,
    path_len: usize,
) -> i32 {
    let value_str = match ptr_to_str(value_ptr, value_len) {
        Ok(s) => s,
        Err(_) => return fail(1, "hypen_portable_path_has: invalid UTF-8 value pointer"),
    };
    let path = match ptr_to_str(path_ptr, path_len) {
        Ok(s) => s,
        Err(_) => return fail(1, "hypen_portable_path_has: invalid UTF-8 path pointer"),
    };
    let v: serde_json::Value = match serde_json::from_str(value_str) {
        Ok(v) => v,
        Err(e) => return fail(2, &format!("hypen_portable_path_has: bad JSON: {e}")),
    };
    let out = if crate::portable::path_has(&v, path) { "true" } else { "false" };
    write_portable_result(out.as_bytes().to_vec());
    0
}

/// path_set: write `new_value_json` at `path` inside `value_json`.
/// Result is the updated JSON.
#[no_mangle]
pub extern "C" fn hypen_portable_path_set(
    value_ptr: *const u8,
    value_len: usize,
    path_ptr: *const u8,
    path_len: usize,
    new_value_ptr: *const u8,
    new_value_len: usize,
) -> i32 {
    let value_str = match ptr_to_str(value_ptr, value_len) {
        Ok(s) => s,
        Err(_) => return fail(1, "hypen_portable_path_set: invalid UTF-8 value pointer"),
    };
    let path = match ptr_to_str(path_ptr, path_len) {
        Ok(s) => s,
        Err(_) => return fail(1, "hypen_portable_path_set: invalid UTF-8 path pointer"),
    };
    let new_value_str = match ptr_to_str(new_value_ptr, new_value_len) {
        Ok(s) => s,
        Err(_) => return fail(1, "hypen_portable_path_set: invalid UTF-8 new-value pointer"),
    };
    let mut v: serde_json::Value = match serde_json::from_str(value_str) {
        Ok(v) => v,
        Err(e) => return fail(2, &format!("hypen_portable_path_set: bad value JSON: {e}")),
    };
    let nv: serde_json::Value = match serde_json::from_str(new_value_str) {
        Ok(v) => v,
        Err(e) => return fail(2, &format!("hypen_portable_path_set: bad new-value JSON: {e}")),
    };
    crate::portable::path_set(&mut v, path, nv);
    match serde_json::to_vec(&v) {
        Ok(bytes) => {
            write_portable_result(bytes);
            0
        }
        Err(e) => fail(3, &format!("hypen_portable_path_set: serialise: {e}")),
    }
}

/// path_delete: remove whatever lives at `path`. Result JSON:
/// `{"json": <updated>, "removed": bool}`.
#[no_mangle]
pub extern "C" fn hypen_portable_path_delete(
    value_ptr: *const u8,
    value_len: usize,
    path_ptr: *const u8,
    path_len: usize,
) -> i32 {
    let value_str = match ptr_to_str(value_ptr, value_len) {
        Ok(s) => s,
        Err(_) => return fail(1, "hypen_portable_path_delete: invalid UTF-8 value pointer"),
    };
    let path = match ptr_to_str(path_ptr, path_len) {
        Ok(s) => s,
        Err(_) => return fail(1, "hypen_portable_path_delete: invalid UTF-8 path pointer"),
    };
    let mut v: serde_json::Value = match serde_json::from_str(value_str) {
        Ok(v) => v,
        Err(e) => return fail(2, &format!("hypen_portable_path_delete: bad JSON: {e}")),
    };
    let removed = crate::portable::path_delete(&mut v, path);
    let out = serde_json::json!({ "json": v, "removed": removed });
    match serde_json::to_vec(&out) {
        Ok(bytes) => {
            write_portable_result(bytes);
            0
        }
        Err(e) => fail(3, &format!("hypen_portable_path_delete: serialise: {e}")),
    }
}

/// encode_uri_component: output is raw UTF-8, not wrapped in JSON.
#[no_mangle]
pub extern "C" fn hypen_portable_encode_uri_component(
    input_ptr: *const u8,
    input_len: usize,
) -> i32 {
    let input = match ptr_to_str(input_ptr, input_len) {
        Ok(s) => s,
        Err(_) => return fail(1, "hypen_portable_encode_uri_component: invalid UTF-8"),
    };
    write_portable_result(crate::portable::encode_uri_component(input).into_bytes());
    0
}

/// decode_uri_component: output is raw UTF-8.
#[no_mangle]
pub extern "C" fn hypen_portable_decode_uri_component(
    input_ptr: *const u8,
    input_len: usize,
) -> i32 {
    let input = match ptr_to_str(input_ptr, input_len) {
        Ok(s) => s,
        Err(_) => return fail(1, "hypen_portable_decode_uri_component: invalid UTF-8"),
    };
    write_portable_result(crate::portable::decode_uri_component(input).into_bytes());
    0
}

/// parse_query: result JSON `{"path": "...", "query": {...}}`.
#[no_mangle]
pub extern "C" fn hypen_portable_parse_query(
    input_ptr: *const u8,
    input_len: usize,
) -> i32 {
    let input = match ptr_to_str(input_ptr, input_len) {
        Ok(s) => s,
        Err(_) => return fail(1, "hypen_portable_parse_query: invalid UTF-8"),
    };
    let (path, query) = crate::portable::parse_query(input);
    let out = serde_json::json!({ "path": path, "query": query });
    match serde_json::to_vec(&out) {
        Ok(bytes) => {
            write_portable_result(bytes);
            0
        }
        Err(e) => fail(3, &format!("hypen_portable_parse_query: serialise: {e}")),
    }
}

/// build_url: path + JSON object of query params → URL string (raw UTF-8).
#[no_mangle]
pub extern "C" fn hypen_portable_build_url(
    path_ptr: *const u8,
    path_len: usize,
    query_ptr: *const u8,
    query_len: usize,
) -> i32 {
    let path = match ptr_to_str(path_ptr, path_len) {
        Ok(s) => s,
        Err(_) => return fail(1, "hypen_portable_build_url: invalid UTF-8 path"),
    };
    let query_str = match ptr_to_str(query_ptr, query_len) {
        Ok(s) => s,
        Err(_) => return fail(1, "hypen_portable_build_url: invalid UTF-8 query"),
    };
    let map: std::collections::BTreeMap<String, String> = match serde_json::from_str(query_str) {
        Ok(m) => m,
        Err(e) => return fail(2, &format!("hypen_portable_build_url: bad query JSON: {e}")),
    };
    write_portable_result(crate::portable::build_url(path, &map).into_bytes());
    0
}
