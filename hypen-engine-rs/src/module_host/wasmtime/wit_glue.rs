//! Conversions between a `bindgen!` world's generated types and the host's
//! neutral ones.
//!
//! The v0.1 and v0.2 WIT packages declare the same records, variants and
//! enums, but each `bindgen!` invocation generates its own nominal Rust
//! types for them, and no trait relates the two families — so generics
//! cannot express "the `Tier` of whichever world". This macro is the one
//! place those conversions are written; it is invoked once inside each ABI
//! module, where the bare `hypen::…` paths resolve to that module's
//! generated bindings. It contains conversions only — no behaviour — plus the
//! one import whose generated trait has the same (sync) shape in both worlds,
//! `hypen:http/deferred`, forwarded to the shared queue.

macro_rules! wit_conversions {
    () => {
        impl From<hypen::storage::types::Tier> for $crate::module_host::wasmtime::storage::Tier {
            fn from(tier: hypen::storage::types::Tier) -> Self {
                use hypen::storage::types::Tier as Wit;
                match tier {
                    Wit::Persistent => Self::Persistent,
                    Wit::Cache => Self::Cache,
                    Wit::Temp => Self::Temp,
                    Wit::Secure => Self::Secure,
                }
            }
        }

        impl From<$crate::module_host::wasmtime::storage::StorageError>
            for hypen::storage::types::Error
        {
            fn from(e: $crate::module_host::wasmtime::storage::StorageError) -> Self {
                use $crate::module_host::wasmtime::storage::StorageError as E;
                match e {
                    E::QuotaExceeded(over) => Self::QuotaExceeded(over),
                    E::Unavailable(why) => Self::Unavailable(why),
                    E::Backend(why) => Self::Backend(why),
                }
            }
        }

        impl From<$crate::module_host::wasmtime::storage::EntryMeta>
            for hypen::storage::types::EntryInfo
        {
            fn from(meta: $crate::module_host::wasmtime::storage::EntryMeta) -> Self {
                Self {
                    size: meta.size,
                    modified_ms: meta.modified_ms,
                    version: meta.version,
                }
            }
        }

        impl From<$crate::module_host::wasmtime::cross_module::CrossModuleError>
            for hypen::engine::state::Error
        {
            fn from(e: $crate::module_host::wasmtime::cross_module::CrossModuleError) -> Self {
                use $crate::module_host::wasmtime::cross_module::CrossModuleError as E;
                match e {
                    E::NotFound => Self::NotFound,
                    // The payload names the missing manifest grant.
                    E::PermissionDenied(grant) => {
                        Self::PermissionDenied(grant.manifest_field().to_string())
                    }
                    // The WIT has no dedicated "limit" case; `module-error`
                    // carries the human-readable reason.
                    E::Limit(why) => Self::ModuleError(why),
                }
            }
        }

        impl From<$crate::module_host::HttpRequestError> for hypen::http::deferred::Error {
            fn from(e: $crate::module_host::HttpRequestError) -> Self {
                use $crate::module_host::HttpRequestError as E;
                match e {
                    E::PermissionDenied(why) => Self::PermissionDenied(why),
                    E::InvalidRequest(why) => Self::InvalidRequest(why),
                    E::LimitExceeded(why) => Self::LimitExceeded(why),
                }
            }
        }

        impl From<hypen::http::deferred::Request> for $crate::module_host::HttpRequest {
            fn from(request: hypen::http::deferred::Request) -> Self {
                Self {
                    method: request.method,
                    url: request.url,
                    headers: request.headers,
                    body: request.body,
                    timeout_ms: request.timeout_ms,
                }
            }
        }

        impl hypen::http::deferred::Host for $crate::module_host::wasmtime::store::HostState {
            // Sync in both ABIs: `send` only queues.
            fn send(
                &mut self,
                req: hypen::http::deferred::Request,
                then: String,
                tag: Option<String>,
            ) -> Result<(), hypen::http::deferred::Error> {
                let queued = $crate::module_host::QueuedHttpRequest {
                    request: req.into(),
                    then,
                    tag,
                };
                Ok(self.deferred_http.send(queued)?)
            }
        }

        impl From<hypen::engine::state::Action> for $crate::module_host::HostAction {
            fn from(action: hypen::engine::state::Action) -> Self {
                Self {
                    name: action.name,
                    payload: action.payload,
                }
            }
        }

        impl From<hypen::module::types::Action> for $crate::module_host::HostAction {
            fn from(action: hypen::module::types::Action) -> Self {
                Self {
                    name: action.name,
                    payload: action.payload,
                }
            }
        }

        impl From<$crate::module_host::HostAction> for hypen::module::types::Action {
            fn from(action: $crate::module_host::HostAction) -> Self {
                Self {
                    name: action.name,
                    payload: action.payload,
                }
            }
        }

        impl From<hypen::module::types::LogLevel> for $crate::module_host::LogLevel {
            fn from(level: hypen::module::types::LogLevel) -> Self {
                use hypen::module::types::LogLevel as Wit;
                match level {
                    Wit::Trace => Self::Trace,
                    Wit::Debug => Self::Debug,
                    Wit::Info => Self::Info,
                    Wit::Warn => Self::Warn,
                    Wit::Error => Self::Error,
                }
            }
        }

        impl From<hypen::module::types::Effect> for $crate::module_host::Effect {
            fn from(effect: hypen::module::types::Effect) -> Self {
                use hypen::module::types::Effect as Wit;
                match effect {
                    Wit::Delay(d) => Self::Delay {
                        ms: d.ms,
                        then: d.then,
                    },
                    Wit::Navigate(path) => Self::Navigate(path),
                    Wit::Log(l) => Self::Log {
                        level: l.level.into(),
                        message: l.message,
                    },
                }
            }
        }

        impl From<hypen::module::types::ReducerOutput> for $crate::module_host::ReducerOutput {
            fn from(output: hypen::module::types::ReducerOutput) -> Self {
                Self {
                    // Bytes pass through untouched: the host does not parse
                    // or validate module state.
                    state: output.state,
                    effects: output.effects.into_iter().map(Into::into).collect(),
                    emit: output.emit.into_iter().map(Into::into).collect(),
                    // The cross-module requests are filled by the host from
                    // the call's window, not by the module's return value.
                    // Likewise filled by the host, from the call's
                    // `hypen:http/deferred` queue.
                    ..Default::default()
                }
            }
        }
    };
}

pub(crate) use wit_conversions;
