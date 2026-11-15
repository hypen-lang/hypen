//! The one place a failure becomes a [`HostError`].
//!
//! Every error names the module and the export (or import) it happened in.
//! The public [`HostError`] variants predate this split and are kept as they
//! are, so the distinctions are carried in the message:
//!
//! | cause                                        | variant        |
//! |----------------------------------------------|----------------|
//! | bytes are not a component / wrong world      | `Instantiate`  |
//! | import the manifest does not grant           | `Instantiate`  |
//! | component start trapped / timed out          | `Instantiate`  |
//! | guest trap, CPU timeout, host-call timeout, memory limit, host-call fault during an export | `Trap` (kills the instance) |
//! | export returned `Err(string)`                | `ModuleError` (instance stays alive) |
//! | call on a dead / destroyed / foreign id      | `DeadInstance` |
//! | name never registered                        | `UnknownModule`|
//! | host-side I/O (storage file)                 | `Runtime`      |

use std::fmt;
use std::time::Duration;

use wasmtime::Trap;

use super::limits::TotalMemoryLimiter;
use super::linker::Capability;
use crate::module_host::kv::ModuleName;
use crate::module_host::HostError;

/// A guest entry point the host calls.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Export {
    /// Component instantiation, which runs the component's start code.
    Start,
    Init,
    Dispatch,
    OnActivated,
    OnDeactivated,
    OnDestroyed,
    Actions,
}

impl fmt::Display for Export {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Export::Start => "component start",
            Export::Init => "export `init`",
            Export::Dispatch => "export `dispatch`",
            Export::OnActivated => "export `on-activated`",
            Export::OnDeactivated => "export `on-deactivated`",
            Export::OnDestroyed => "export `on-destroyed`",
            Export::Actions => "export `actions`",
        })
    }
}

/// Why a guest call did not run to completion. Each of these leaves the
/// store in an unknown state, so each kills the instance.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Fault {
    /// Guest code trapped (panic / `unreachable`, out-of-bounds, stack
    /// overflow, …).
    GuestTrap(String),
    /// Guest code was still *running* at the deadline (epoch interruption).
    CpuTimeout(Duration),
    /// The call was *parked in a host call* at the deadline (cancelled by
    /// the wall-clock timeout).
    HostCallTimeout(Duration),
    /// The guest trapped after the memory limiter refused a growth.
    MemoryLimit { budget_bytes: usize, trap: String },
    /// A host import failed in a way the guest cannot handle (not a trap in
    /// guest code): an invalid resource handle, an exhausted resource table.
    HostCall(String),
}

impl Fault {
    /// Classify the error a wasmtime call returned. `limiter` is the
    /// store's, consulted (and cleared) to attribute a trap that follows a
    /// refused memory growth.
    pub(crate) fn from_wasmtime(
        error: &wasmtime::Error,
        budget: Duration,
        limiter: &mut TotalMemoryLimiter,
    ) -> Self {
        let denied = limiter.take_denied();
        // `Trap` displays as "wasm trap: <what>"; the messages built here
        // already say "trapped".
        let describe = |trap: &Trap| {
            let text = trap.to_string();
            text.strip_prefix("wasm trap: ")
                .map(str::to_string)
                .unwrap_or(text)
        };
        match error.downcast_ref::<Trap>() {
            Some(Trap::Interrupt) => Fault::CpuTimeout(budget),
            Some(trap) if denied => Fault::MemoryLimit {
                budget_bytes: limiter.budget(),
                trap: describe(trap),
            },
            Some(trap) => Fault::GuestTrap(describe(trap)),
            // `{:#}` joins the context chain; a host-import failure has no
            // wasm backtrace worth more than its causes.
            None => Fault::HostCall(format!("{error:#}")),
        }
    }
}

impl fmt::Display for Fault {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Fault::GuestTrap(trap) => write!(f, "trapped: {trap}"),
            Fault::CpuTimeout(budget) => write!(
                f,
                "exceeded its {} ms CPU budget: guest code was still running at the deadline",
                budget.as_millis()
            ),
            Fault::HostCallTimeout(budget) => write!(
                f,
                "exceeded its {} ms wall-clock budget while blocked in a host call",
                budget.as_millis()
            ),
            Fault::MemoryLimit { budget_bytes, trap } => write!(
                f,
                "hit its {budget_bytes}-byte memory limit (a memory growth was denied, then: {trap})"
            ),
            Fault::HostCall(why) => write!(f, "failed in a host call: {why}"),
        }
    }
}

/// A [`Fault`] with its location: which module, which entry point.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CallFailure {
    pub module: ModuleName,
    pub export: Export,
    pub fault: Fault,
}

impl fmt::Display for CallFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "module '{}' {} {}", self.module, self.export, self.fault)
    }
}

impl CallFailure {
    /// The error for the call that failed. A failed component start never
    /// produced an instance, so it is an instantiation failure; anything
    /// later is reported as a trap (the instance is dead afterwards).
    pub(crate) fn to_host_error(&self) -> HostError {
        match self.export {
            Export::Start => HostError::Instantiate(self.to_string()),
            _ => HostError::Trap(self.to_string()),
        }
    }
}

/// The export ran to completion and returned `Err(string)`: a module-level
/// error, not a sandbox violation. The instance stays alive.
pub(crate) fn module_error(module: &ModuleName, export: Export, message: &str) -> HostError {
    HostError::ModuleError(format!("module '{module}' {export}: {message}"))
}

/// Why `register` refused a component.
#[derive(Debug)]
pub(crate) enum RegisterError {
    /// The bytes do not start with the WebAssembly magic number.
    NotWasm,
    /// A core module (`wasm32-unknown-unknown` / wasip1 output), not a
    /// component.
    CoreModule,
    /// A wasm binary wasmtime could not compile.
    Invalid(String),
    /// A component for another version of the `hypen:module` contract.
    WrongAbi {
        import: String,
        served: &'static str,
    },
    /// A component whose imports this host cannot satisfy even with every
    /// grant (it targets some other world).
    Unlinkable { world: &'static str, why: String },
    /// A component that lacks the world's exports.
    MissingExports { world: &'static str, why: String },
    /// The host itself could not build a linker.
    Host(String),
}

impl RegisterError {
    pub(crate) fn into_host_error(self, module: &str) -> HostError {
        let why = match self {
            RegisterError::NotWasm => {
                "the bytes are not a WebAssembly binary (no `\\0asm` header)".to_string()
            }
            RegisterError::CoreModule => "the bytes are a core WebAssembly module, not a \
                 component; build for `wasm32-wasip2` or wrap it with `wasm-tools component new`"
                .to_string(),
            RegisterError::Invalid(why) => format!("not a valid WebAssembly component: {why}"),
            RegisterError::WrongAbi { import, served } => format!(
                "it imports {import}, but this host serves hypen:module@{served}; register it \
                 with the host for that version (DualHost routes both)"
            ),
            RegisterError::Unlinkable { world, why } => {
                format!("its imports do not fit the {world} world: {why}")
            }
            RegisterError::MissingExports { world, why } => {
                format!("it does not export the {world} world: {why}")
            }
            RegisterError::Host(why) => format!("the host could not prepare a linker: {why}"),
        };
        HostError::Instantiate(format!("module '{module}' cannot be registered: {why}"))
    }
}

/// An import the component needs and the manifest does not grant. Reported
/// when the module is instantiated (link-time capability denial).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DeniedImport {
    /// The import as the component names it, e.g. `hypen:storage/cloud@0.1.0`.
    pub import: String,
    pub capability: Capability,
}

pub(crate) fn capability_denied(module: &ModuleName, denied: &[DeniedImport]) -> HostError {
    let list: Vec<String> = denied
        .iter()
        .map(|d| {
            format!(
                "imports {} but its manifest does not grant {}",
                d.import,
                d.capability.grant()
            )
        })
        .collect();
    HostError::Instantiate(format!("module '{module}' {}", list.join("; ")))
}
