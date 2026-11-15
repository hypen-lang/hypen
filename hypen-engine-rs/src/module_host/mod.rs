//! WASM Component module hosting.
//!
//! This subsystem lets the engine run **Hypen modules compiled to WASM
//! Components** (implementing the `hypen:module` world in `/wit`) instead of
//! requiring the host language (JS/Swift/Kotlin/Go) to implement module
//! reducers. The module becomes a pure `(state, action) -> reducer-output`
//! function the engine drives; state stays canonical in the engine so the
//! existing path-based reactive system (`portable::diff`, `reactive::graph`)
//! works unchanged.
//!
//! ## Layering
//!
//! - The [`ModuleHost`] trait + the value types ([`HostAction`], [`Effect`],
//!   [`ReducerOutput`], [`ModuleManifest`]) are **always compiled** — they
//!   carry no heavy dependencies, so `Engine` can hold an
//!   `Option<Box<dyn ModuleHost>>` and the reducer→reactive wiring is
//!   testable with a mock host.
//! - The native runtime — `WasmtimeHost` (v0.1 ABI), `WasmtimeHostAsync`
//!   (v0.2 ABI) and `DualHost` (both) — lives in the `wasmtime` submodule
//!   behind the `module-loader` feature (it pulls in `wasmtime`) and is
//!   native-only (`wasmtime` cannot run inside a wasm32 guest). Its module
//!   docs state the sandbox model.
//! - `BridgedHost` delegates to a JS host when the engine itself runs in
//!   wasm32 (`module-loader-bridged`).
//!
//! See `/wit/ENGINE_INTEGRATION.md` for the full design.

use std::fmt;

// Storage backend shared by the wasmtime hosts (the bridged host keeps
// storage on the JS side).
#[cfg(all(feature = "module-loader", not(target_arch = "wasm32")))]
mod kv;
mod registry;
pub use registry::{BundledRegistry, ModuleRegistry, RegistryError};

#[cfg(all(feature = "module-loader", not(target_arch = "wasm32")))]
mod wasmtime;
#[cfg(all(feature = "module-loader", not(target_arch = "wasm32")))]
pub use wasmtime::{ExecStrategy, Host, ModuleLimits, WasmtimeHost, WasmtimeHostAsync};

#[cfg(all(feature = "module-loader", not(target_arch = "wasm32")))]
mod dual;
#[cfg(all(feature = "module-loader", not(target_arch = "wasm32")))]
pub use dual::{detect_abi, DualHost, ModuleAbi};

#[cfg(all(feature = "module-loader-bridged", target_arch = "wasm32"))]
mod bridged_host;
#[cfg(all(feature = "module-loader-bridged", target_arch = "wasm32"))]
pub use bridged_host::{BridgedHost, JsModuleHost};

/// Opaque handle to a live module instance held by a [`ModuleHost`].
///
/// Each host implementation issues these however it likes (slotmap key
/// internally; JS-issued integer for `BridgedHost`); the engine just holds
/// and passes them back. Round-trip across boundaries is exact `u64`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ModuleInstanceId(pub u64);

/// An action delivered to a module's `dispatch` export.
///
/// `name` matches `@actions.<name>` in the DSL; `payload` is JSON bytes.
#[derive(Debug, Clone)]
pub struct HostAction {
    pub name: String,
    pub payload: Vec<u8>,
}

impl HostAction {
    pub fn new(name: impl Into<String>, payload: Vec<u8>) -> Self {
        Self {
            name: name.into(),
            payload,
        }
    }
}

/// Log severity for [`Effect::Log`]. Mirrors the `log-level` enum in the WIT.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogLevel {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
}

/// A side effect a module asked the host to perform.
///
/// HTTP is deliberately *not* on this list: modules use `wasi:http`
/// directly via their language's idiomatic client (Rust `waki`/`reqwest`,
/// Go `net/http`, JS `fetch`), and the host supplies a `wasi:http`
/// implementation through its WASM runtime (`wasmtime-wasi-http` on
/// native, the platform `fetch`/`URLSession`/`OkHttp` on web/iOS/Android).
/// See `wit/hypen-module.wit`'s `module-x` world for the rationale.
#[derive(Debug, Clone)]
pub enum Effect {
    Delay { ms: u32, then: String },
    Navigate(String),
    Log { level: LogLevel, message: String },
}

/// A cross-module subscription a reducer requested via
/// `hypen:engine/state.subscribe`. The *subscriber* is implicit — the module
/// whose dispatch produced this output — so it isn't carried here; the engine
/// tags it when folding.
#[derive(Debug, Clone)]
pub struct SubscribeRequest {
    /// Module whose state to observe.
    pub target: String,
    /// Dotted state path to watch (empty = the whole state).
    pub path: String,
    /// Action to dispatch back to the subscriber when the path changes.
    pub on_change: String,
}

/// What a module reducer returns. State is `None` when the action did not
/// change state (engine no-ops the reactive path).
#[derive(Debug, Clone, Default)]
pub struct ReducerOutput {
    pub state: Option<Vec<u8>>,
    pub effects: Vec<Effect>,
    pub emit: Vec<HostAction>,
    /// Cross-module dispatches the reducer requested via
    /// `hypen:engine/state.dispatch`, as `(target_module, action)`. The engine
    /// drains these after applying this output, routing each to its target.
    pub cross_dispatch: Vec<(String, HostAction)>,
    /// Cross-module subscriptions the reducer requested via
    /// `hypen:engine/state.subscribe`. The engine registers these and fires the
    /// `on_change` action when the target's state changes at the watched path.
    pub subscribe_requests: Vec<SubscribeRequest>,
}

/// A sibling module's state snapshot passed into a module's `dispatch` so its
/// `hypen:engine/state.read` calls can resolve. `(module_name, json_bytes)`.
pub type SiblingState = (String, Vec<u8>);

/// Storage visibility scope a module may be granted (mirrors the three
/// sister interfaces in `hypen:storage`). `Local` is always granted.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, serde::Serialize, serde::Deserialize,
)]
#[serde(rename_all = "lowercase")]
pub enum StorageScope {
    Local,
    App,
    Cloud,
}

/// Declares a module's identity and the capabilities it is granted.
///
/// **Deny by default**: a capability that is not named here is not granted.
/// `Default` and a deserialized manifest that omits a field both mean the
/// least privilege — module-private `local` storage only, no cross-module
/// access, no network. [`ModuleManifest::all`] is the explicit
/// grant-everything constructor.
///
/// The host enforces this at instantiation: storage scopes outside
/// `storage` and (without `http`) `wasi:http` are not linked, so a module
/// importing an ungranted capability fails to instantiate (link-time
/// capability denial). `reads`/`dispatches` gate cross-module access at call
/// time.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct ModuleManifest {
    pub name: String,
    pub version: String,
    /// Storage scopes granted *in addition to* `local` (always granted, and
    /// always private to the module). Omitted = `local` only.
    pub storage: Vec<StorageScope>,
    /// Names of sibling modules whose state this module may read or
    /// subscribe to. Omitted = none.
    pub reads: Vec<String>,
    /// Names of sibling modules this module may dispatch actions to.
    /// Omitted = none.
    pub dispatches: Vec<String>,
    /// Whether `wasi:http` (outbound HTTP egress) is granted. Omitted =
    /// denied; only an explicit `"http": true` links `wasi:http`. Enforced
    /// at link time like storage: an ungranted module that imports
    /// `wasi:http` fails to instantiate.
    pub http: bool,
}

impl ModuleManifest {
    /// A permissive manifest granting every storage scope and HTTP egress —
    /// for tests and explicitly trusted first-party modules. (Cross-module
    /// `reads`/`dispatches` name specific siblings, so they start empty.)
    /// Nothing falls back to this implicitly.
    pub fn all(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            version: "0.0.0".into(),
            storage: vec![StorageScope::Local, StorageScope::App, StorageScope::Cloud],
            reads: Vec::new(),
            dispatches: Vec::new(),
            http: true,
        }
    }

    /// Whether outbound HTTP (`wasi:http`) is granted.
    pub fn grants_http(&self) -> bool {
        self.http
    }

    pub fn grants_storage(&self, scope: StorageScope) -> bool {
        scope == StorageScope::Local || self.storage.contains(&scope)
    }
}

/// Errors a [`ModuleHost`] can return.
#[derive(Debug)]
pub enum HostError {
    /// No module registered under this name.
    UnknownModule(String),
    /// The instance was killed by a trap or timeout, was destroyed, or the
    /// id was never issued by this host.
    DeadInstance,
    /// The module's export returned `Err(string)`.
    ModuleError(String),
    /// The call did not run to completion: the component trapped, overran
    /// its CPU or wall-clock budget, or hit its memory limit (the message
    /// says which). The instance is dead afterwards.
    Trap(String),
    /// Registration or instantiation failed: the bytes are not a component
    /// of the host's world, an import is not granted by the manifest (the
    /// message names it), or component start failed.
    Instantiate(String),
    /// State/payload (de)serialization failed.
    Codec(String),
    /// Anything else the runtime reported.
    Runtime(String),
}

impl fmt::Display for HostError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            HostError::UnknownModule(n) => write!(f, "unknown module: {n}"),
            HostError::DeadInstance => write!(f, "module instance is dead"),
            HostError::ModuleError(e) => write!(f, "module returned error: {e}"),
            HostError::Trap(e) => write!(f, "module trapped: {e}"),
            HostError::Instantiate(e) => write!(f, "instantiation failed: {e}"),
            HostError::Codec(e) => write!(f, "codec error: {e}"),
            HostError::Runtime(e) => write!(f, "runtime error: {e}"),
        }
    }
}

impl std::error::Error for HostError {}

/// Hosts WASM Component modules and drives their reducer + lifecycle exports.
///
/// Implemented by the native wasmtime hosts and by a JS-bridged host for when
/// the engine itself runs in the browser. The engine is agnostic to which it
/// holds.
pub trait ModuleHost: Send {
    /// Register a module type from component bytes + its manifest. Idempotent;
    /// re-registering the same name replaces the bytes (hot reload).
    fn register(
        &mut self,
        name: &str,
        component_bytes: &[u8],
        manifest: ModuleManifest,
    ) -> Result<(), HostError>;

    /// Create a fresh instance of a registered module.
    fn instantiate(&mut self, name: &str) -> Result<ModuleInstanceId, HostError>;

    /// Tear down an instance, reclaiming its linear memory.
    fn destroy(&mut self, id: ModuleInstanceId) -> Result<(), HostError>;

    /// Call `init(config) -> state`. Runs once per instance.
    fn init(&mut self, id: ModuleInstanceId, config: &[u8]) -> Result<Vec<u8>, HostError>;

    /// Call `dispatch(state, action) -> reducer-output`.
    ///
    /// `siblings` carries the snapshots the module is permitted to read via
    /// `hypen:engine/state.read` (the host still enforces the per-target ACL
    /// from the manifest). Returned `cross_dispatch` entries are sibling
    /// dispatches the reducer requested, for the engine to route.
    fn dispatch(
        &mut self,
        id: ModuleInstanceId,
        state: &[u8],
        action: HostAction,
        siblings: &[SiblingState],
    ) -> Result<ReducerOutput, HostError>;

    /// Lifecycle: module became visible.
    ///
    /// `siblings` carries the snapshots the module may read via
    /// `hypen:engine/state.read` (same as [`dispatch`](Self::dispatch)), so an
    /// `on_activated` reducer can `read`, `dispatch` to, and `subscribe` to
    /// siblings. The returned [`ReducerOutput`] (state delta, effects, emitted
    /// actions, cross-dispatch, subscriptions) is folded by the engine.
    fn on_activated(
        &mut self,
        id: ModuleInstanceId,
        state: &[u8],
        siblings: &[SiblingState],
    ) -> Result<ReducerOutput, HostError>;

    /// Lifecycle: module left the screen.
    fn on_deactivated(
        &mut self,
        id: ModuleInstanceId,
        state: &[u8],
    ) -> Result<ReducerOutput, HostError>;

    /// Lifecycle: instance about to be destroyed.
    fn on_destroyed(&mut self, id: ModuleInstanceId, state: &[u8]) -> Result<(), HostError>;

    /// The action names this module's `dispatch` accepts (the module's
    /// `actions` export). Hosts call this once after instantiation to wire
    /// routing without an out-of-band action list. A `"*"` entry means
    /// "accept any action name".
    fn actions(&mut self, id: ModuleInstanceId) -> Result<Vec<String>, HostError>;
}
