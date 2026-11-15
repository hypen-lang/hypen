//! Link-time capability gating.
//!
//! A module's manifest decides which imports exist for it. A capability the
//! manifest does not grant is simply **not linked**, so a component that
//! imports it cannot be instantiated at all — there is no runtime
//! "permission denied" path for storage scopes or for HTTP as a whole.
//! (Two things are checked at call time instead: cross-module access —
//! `hypen:engine/state` is always linked and checked per target, see
//! `cross_module.rs` — and, once `http` is granted, the `httpHosts` allowlist
//! of each request, see `deferred_http.rs`.)
//!
//! [`inspect`] reads a component's imports up front so the refusal can name
//! the import and the manifest grant that would allow it, instead of
//! surfacing wasmtime's generic link error.

use std::fmt;

use wasmtime::component::{Component, Linker};
use wasmtime::Engine;

use super::error::{DeniedImport, RegisterError};
use super::host::Abi;
use super::store::HostState;
use crate::module_host::{ModuleManifest, StorageScope};

/// Something a module can import beyond the always-present WASI base
/// (clocks, random, stdio and friends over an empty [`HostState`] context).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Capability {
    /// `hypen:storage/{local,app,cloud}`.
    Storage(StorageScope),
    /// `wasi:http/*` — outbound HTTP, blocking.
    Http,
    /// `hypen:http/deferred` — outbound HTTP, queued. Granted by the same
    /// manifest `http` as [`Http`](Self::Http).
    DeferredHttp,
    /// `hypen:engine/state` — cross-module read / dispatch / subscribe.
    EngineState,
    /// `hypen:time/clock` (v0.2).
    Time,
}

impl Capability {
    /// Whether `manifest` grants this capability. Deny by default: only
    /// module-private storage and the capabilities that are safe for any
    /// module (the call-time-checked state interface, the virtualizable
    /// clock) are granted without being named.
    pub(crate) fn granted_by(self, manifest: &ModuleManifest) -> bool {
        match self {
            Capability::Storage(scope) => manifest.grants_storage(scope),
            Capability::Http | Capability::DeferredHttp => manifest.grants_http(),
            Capability::EngineState | Capability::Time => true,
        }
    }

    /// The manifest grant that allows this capability, for error messages.
    pub(crate) fn grant(self) -> CapabilityGrant {
        CapabilityGrant(self)
    }

    /// The capability an import belongs to, if it is one. `interface` is the
    /// import name without its `@version`.
    fn of_interface(interface: &str) -> Option<Self> {
        match interface {
            "hypen:storage/local" => Some(Capability::Storage(StorageScope::Local)),
            "hypen:storage/app" => Some(Capability::Storage(StorageScope::App)),
            "hypen:storage/cloud" => Some(Capability::Storage(StorageScope::Cloud)),
            "hypen:engine/state" => Some(Capability::EngineState),
            "hypen:time/clock" => Some(Capability::Time),
            "hypen:http/deferred" => Some(Capability::DeferredHttp),
            other if other.starts_with("wasi:http/") => Some(Capability::Http),
            _ => None,
        }
    }
}

/// Displays as the manifest entry that grants a capability.
pub(crate) struct CapabilityGrant(Capability);

impl fmt::Display for CapabilityGrant {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.0 {
            Capability::Storage(StorageScope::Local) => f.write_str("storage scope `local`"),
            Capability::Storage(StorageScope::App) => f.write_str("storage scope `app`"),
            Capability::Storage(StorageScope::Cloud) => f.write_str("storage scope `cloud`"),
            Capability::Http | Capability::DeferredHttp => f.write_str("`http`"),
            Capability::EngineState => f.write_str("cross-module state access"),
            Capability::Time => f.write_str("the clock"),
        }
    }
}

/// Adds one capability's interfaces to a linker.
pub(crate) type LinkFn = fn(&mut Linker<HostState>) -> wasmtime::Result<()>;

/// `wasi:http`, the same for both ABIs: the p2 surface. A v0.2 module blocks
/// its task on the p2 poll while fetching (suspending to the host's runtime)
/// until wasi:http p3 stabilizes.
pub(crate) const HTTP: (Capability, LinkFn) = (
    Capability::Http,
    wasmtime_wasi_http::p2::add_only_http_to_linker_async::<HostState>,
);

/// Split `pkg:name/iface@1.2.3` into the interface and its version.
fn split_version(import: &str) -> (&str, Option<&str>) {
    match import.split_once('@') {
        Some((interface, version)) => (interface, Some(version)),
        None => (import, None),
    }
}

/// Check a component's imports against the ABI and the manifest.
///
/// Returns the imports the manifest does not grant (empty = linkable), or an
/// error if the component was built for another `hypen:module` version.
pub(crate) fn inspect<A: Abi>(
    engine: &Engine,
    component: &Component,
    manifest: &ModuleManifest,
) -> Result<Vec<DeniedImport>, RegisterError> {
    let mut denied: Vec<DeniedImport> = Vec::new();
    for (import, _) in component.component_type().imports(engine) {
        let (interface, version) = split_version(import);
        if interface.starts_with("hypen:") && version.is_some_and(|v| v != A::VERSION) {
            return Err(RegisterError::WrongAbi {
                import: import.to_string(),
                served: A::VERSION,
            });
        }
        let Some(capability) = Capability::of_interface(interface) else {
            // WASI base or a types-only interface: nothing to grant. An
            // import nobody provides is reported by the link check.
            continue;
        };
        // One line per capability (`wasi:http` spans several interfaces).
        if !capability.granted_by(manifest) && !denied.iter().any(|d| d.capability == capability) {
            denied.push(DeniedImport {
                import: import.to_string(),
                capability,
            });
        }
    }
    Ok(denied)
}

/// Build the linker for a module: the WASI base plus exactly the
/// capabilities of the ABI's world that `manifest` grants.
pub(crate) fn build<A: Abi>(
    engine: &Engine,
    manifest: &ModuleManifest,
) -> wasmtime::Result<Linker<HostState>> {
    let mut linker: Linker<HostState> = Linker::new(engine);
    // Async WASI: blocking operations (`poll`, `pollable.block`, blocking
    // stream reads/writes) suspend the guest back to the host's runtime
    // instead of parking the host thread, so the call deadline covers them.
    // The p2 surface serves both ABIs — wasip2-built v0.2 guests still
    // import wasi:io / wasi:cli @0.2.x alongside their CM-async imports.
    wasmtime_wasi::p2::add_to_linker_async(&mut linker)?;

    for (capability, link) in A::CAPABILITIES {
        if capability.granted_by(manifest) {
            link(&mut linker)?;
        }
    }
    Ok(linker)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imports_map_to_capabilities() {
        use Capability::*;
        let of = |import: &str| Capability::of_interface(split_version(import).0);
        assert_eq!(
            of("hypen:storage/local@0.1.0"),
            Some(Storage(StorageScope::Local))
        );
        assert_eq!(
            of("hypen:storage/app@0.2.0"),
            Some(Storage(StorageScope::App))
        );
        assert_eq!(
            of("hypen:storage/cloud"),
            Some(Storage(StorageScope::Cloud))
        );
        assert_eq!(of("hypen:engine/state@0.1.0"), Some(EngineState));
        assert_eq!(of("hypen:time/clock@0.2.0"), Some(Time));
        assert_eq!(of("wasi:http/outgoing-handler@0.2.4"), Some(Http));
        assert_eq!(of("wasi:http/types@0.2.4"), Some(Http));
        assert_eq!(of("hypen:http/deferred@0.1.0"), Some(DeferredHttp));
        assert_eq!(of("hypen:http/other@0.1.0"), None);
        // Not capabilities: types-only interfaces and the WASI base.
        assert_eq!(of("hypen:storage/types@0.1.0"), None);
        assert_eq!(of("wasi:io/poll@0.2.4"), None);
        assert_eq!(of("wasi:httpx/thing"), None);
    }

    #[test]
    fn grants_are_deny_by_default() {
        let none = ModuleManifest::default();
        let all = ModuleManifest::all("m");
        for capability in [
            Capability::Storage(StorageScope::App),
            Capability::Storage(StorageScope::Cloud),
            Capability::Http,
            Capability::DeferredHttp,
        ] {
            assert!(!capability.granted_by(&none), "{capability:?}");
            assert!(capability.granted_by(&all), "{capability:?}");
        }
        for capability in [
            Capability::Storage(StorageScope::Local),
            Capability::EngineState,
            Capability::Time,
        ] {
            assert!(capability.granted_by(&none), "{capability:?}");
        }
        assert_eq!(
            Capability::Storage(StorageScope::Cloud).grant().to_string(),
            "storage scope `cloud`"
        );
        assert_eq!(Capability::Http.grant().to_string(), "`http`");
    }
}
