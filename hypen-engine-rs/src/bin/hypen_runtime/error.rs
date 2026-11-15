//! The runtime's single error type and its user-facing rendering.
//!
//! Every failure that can reach the user — a bad flag, an unreadable file, a
//! hostile app.json, a module that will not instantiate, a rejected HTTP
//! request — is a [`RuntimeError`] carrying *which* file / module / field was
//! involved and the underlying error as its `source`. [`render`] turns one
//! into the same three-part shape everywhere: a one-line summary, the cause
//! chain, and a hint when there is something concrete to do about it.

use std::fmt;
use std::path::PathBuf;

use hypen_engine::module_host::{DeniedCapability, HostError, ManifestGrant, StorageScope};
use hypen_engine::EngineError;

use crate::manifest::ManifestProblem;
use crate::server::request::RequestError;

/// Which step of bringing a module instance up (or swapping it) failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModuleStage {
    Register,
    Instantiate,
    Init,
    QueryActions,
    /// Freeing the host instance of a retired scope.
    Destroy,
}

impl fmt::Display for ModuleStage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            ModuleStage::Register => "register",
            ModuleStage::Instantiate => "instantiate",
            ModuleStage::Init => "init",
            ModuleStage::QueryActions => "query actions",
            ModuleStage::Destroy => "destroy",
        })
    }
}

/// Where a module's capability grants come from — decides how a
/// "missing capability" hint is phrased.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GrantSurface {
    /// `--app`: grants live in the module's app.json entry.
    AppManifest,
    /// Single-module mode: grants are `--grant-*` flags.
    CommandLine,
}

/// How to grant what a module was refused at link time: one sentence naming
/// every missing import and the exact grant for each, phrased for where
/// grants are written. `denied` is the host's structured answer
/// (`ModuleHost::denied_capabilities`), not parsed from an error message.
/// `None` when nothing was denied (the failure had another cause).
pub fn grant_hint(denied: &[DeniedCapability], entry: &str, surface: GrantSurface) -> Option<String> {
    let storage_name = |s: StorageScope| match s {
        StorageScope::Local => "local",
        StorageScope::App => "app",
        StorageScope::Cloud => "cloud",
    };
    let mut http = false;
    let mut storage: Vec<&'static str> = Vec::new();
    let mut imports: Vec<String> = Vec::new();
    for capability in denied {
        match capability.grant {
            ManifestGrant::Http if !http => {
                http = true;
                imports.push("wasi:http".to_string());
            }
            ManifestGrant::Storage(scope) if !storage.contains(&storage_name(scope)) => {
                storage.push(storage_name(scope));
                imports.push(format!("hypen:storage/{}", storage_name(scope)));
            }
            // A repeated capability, or one this runtime has no flag or
            // manifest field for yet: named by the host's own message.
            _ => {}
        }
    }
    if imports.is_empty() {
        return None;
    }

    let mut grants: Vec<String> = Vec::new();
    match surface {
        GrantSurface::AppManifest => {
            if http {
                grants.push("`\"http\": true`".to_string());
            }
            if !storage.is_empty() {
                let list: Vec<String> = storage.iter().map(|s| format!("\"{s}\"")).collect();
                grants.push(format!("`\"storage\": [{}]`", list.join(", ")));
            }
        }
        GrantSurface::CommandLine => {
            if http {
                grants.push("--grant-http".to_string());
            }
            if !storage.is_empty() {
                grants.push(format!("--grant-storage {}", storage.join(",")));
            }
        }
    }
    let what = if imports.len() == 1 { "it" } else { "them" };
    let imports = imports.join(" and ");
    Some(match surface {
        GrantSurface::AppManifest => format!(
            "the module imports {imports} but is not granted {what}; add {} to the `{entry}` \
             entry in app.json",
            grants.join(" and ")
        ),
        GrantSurface::CommandLine => format!(
            "the module imports {imports} but is not granted {what}; pass {}",
            grants.join(" ")
        ),
    })
}

#[derive(Debug, thiserror::Error)]
pub enum RuntimeError {
    /// A command-line mistake. Rendered with the usage text, exit code 2.
    #[error("{message}")]
    Usage { message: String },

    #[error("cannot {action} {}", path.display())]
    Io {
        /// What was being done: "read", "create", …
        action: &'static str,
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("app manifest {} is not valid JSON for an app manifest", path.display())]
    ManifestSyntax {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },

    #[error("invalid app manifest {}: `{field}`", path.display())]
    Manifest {
        path: PathBuf,
        /// JSON path of the offending field, e.g. `modules[1].wasm`.
        field: String,
        #[source]
        problem: Box<ManifestProblem>,
    },

    #[error("cannot parse template {origin}: {message}")]
    Template { origin: String, message: String },

    #[error("template {origin} declares no component")]
    EmptyTemplate { origin: String },

    #[error("the module host could not start")]
    HostStart {
        #[source]
        source: HostError,
    },

    #[error("module `{scope}`: {stage} failed")]
    Module {
        scope: String,
        stage: ModuleStage,
        surface: GrantSurface,
        /// Where the module's grants are written: its app.json entry name
        /// (which differs from `scope` for a per-usage instance), or the
        /// scope itself in single-module mode.
        entry: String,
        /// The capabilities the host refused to link, when that is why
        /// instantiation failed (empty otherwise).
        denied: Vec<DeniedCapability>,
        #[source]
        source: HostError,
    },

    #[error("module `{scope}`: init returned a state that is not JSON")]
    InitState {
        scope: String,
        #[source]
        source: serde_json::Error,
    },

    #[error("module `{scope}`: {context}")]
    Engine {
        scope: String,
        /// What the runtime was asking the engine to do.
        context: &'static str,
        #[source]
        source: EngineError,
    },

    /// A dispatch the engine refused or that failed inside a module. The
    /// engine's own message is the summary.
    #[error(transparent)]
    Dispatch(EngineError),

    /// A bare action name more than one module handles: refused, never
    /// guessed. `candidates` are the `scope:action` forms that address one.
    #[error(
        "action `{action}` is handled by more than one module; address one of them: {}",
        quoted(candidates)
    )]
    AmbiguousAction { action: String, candidates: Vec<String> },

    /// No module handles the action as addressed. The summary is the
    /// engine's own (`engine`, always `ActionNotFound`) followed by
    /// `candidates`: the nearest `scope:action` forms that do exist
    /// (possibly none).
    #[error("{engine}{}", did_you_mean(candidates))]
    UnknownAction {
        /// The action name as given.
        name: String,
        candidates: Vec<String>,
        engine: EngineError,
    },

    /// A dispatch killed (trapped / timed out) one or more module instances,
    /// or found one still dead because its restart failed.
    #[error("module {} crashed{}", quoted(scopes), crash_reasons(reasons))]
    ModuleCrashed {
        scopes: Vec<String>,
        /// What the host says killed each instance it has a reason for
        /// (`ModuleHost::instance_status`), in `scopes` order.
        reasons: Vec<String>,
        #[source]
        source: EngineError,
    },

    #[error("too many pending timers for module `{scope}` (limit {limit}); dropped delay -> `{action}`")]
    TimerLimit {
        scope: String,
        action: String,
        limit: usize,
    },

    #[error("cannot listen on {addr}")]
    Bind {
        addr: String,
        #[source]
        source: Box<dyn std::error::Error + Send + Sync>,
    },

    #[error("cannot watch {} for changes", path.display())]
    Watch {
        path: PathBuf,
        #[source]
        source: notify_debouncer_mini::notify::Error,
    },

    #[error("cannot start the {what} thread")]
    Thread {
        what: &'static str,
        #[source]
        source: std::io::Error,
    },

    /// An HTTP request the server refused before it reached the engine.
    #[error(transparent)]
    Request(#[from] RequestError),

    /// A broken internal invariant (never caused by user input); reported
    /// instead of panicking.
    #[error("internal error: {0}")]
    Internal(&'static str),
}

fn did_you_mean(candidates: &[String]) -> String {
    if candidates.is_empty() {
        String::new()
    } else {
        format!("; did you mean {}?", quoted(candidates))
    }
}

fn crash_reasons(reasons: &[String]) -> String {
    if reasons.is_empty() {
        String::new()
    } else {
        format!(" ({})", reasons.join("; "))
    }
}

fn quoted(scopes: &[String]) -> String {
    scopes
        .iter()
        .map(|s| format!("`{s}`"))
        .collect::<Vec<_>>()
        .join(", ")
}

impl RuntimeError {
    pub fn io(action: &'static str, path: impl Into<PathBuf>, source: std::io::Error) -> Self {
        RuntimeError::Io { action, path: path.into(), source }
    }

    pub fn usage(message: impl Into<String>) -> Self {
        RuntimeError::Usage { message: message.into() }
    }

    /// Something concrete the user can do about this error, if anything.
    pub fn hint(&self) -> Option<String> {
        match self {
            RuntimeError::Module { entry, surface, denied, .. } => {
                grant_hint(denied, entry, *surface)
            }
            RuntimeError::AmbiguousAction { .. } => Some(
                "a UI client can instead send the `sender` node id with the bare name: the \
                 owning module is then resolved from the rendered tree"
                    .to_string(),
            ),
            RuntimeError::Manifest { problem, .. } => problem.hint(),
            RuntimeError::ModuleCrashed { .. } => Some(
                "the crashed instance's state is lost; the next action re-instantiates the \
                 module and re-runs init with its original config"
                    .to_string(),
            ),
            RuntimeError::Bind { .. } => {
                Some("is another process already using this port?".to_string())
            }
            RuntimeError::Request(e) => e.hint(),
            RuntimeError::Usage { .. } => Some("run with --help for usage".to_string()),
            _ => None,
        }
    }

    /// Process exit code for a startup failure.
    pub fn exit_code(&self) -> u8 {
        match self {
            RuntimeError::Usage { .. } => 2,
            _ => 1,
        }
    }
}

/// Summary and cause chain on one line (`summary: cause: cause`), for places
/// with a single message slot — a REPL `error:` line, an HTTP error body.
pub fn one_line(error: &RuntimeError) -> String {
    let mut out = error.to_string();
    let mut cause = std::error::Error::source(error);
    while let Some(c) = cause {
        out.push_str(&format!(": {c}"));
        cause = c.source();
    }
    out
}

/// The consistent user-facing rendering: summary, cause chain, hint.
///
/// ```text
/// error: module `fetcher`: instantiate failed
///   caused by: instantiation failed: module 'fetcher' imports wasi:http/types@0.2.6 but its manifest …
///   hint: the module imports wasi:http but is not granted it; add `"http": true` to the `Fetcher` entry …
/// ```
pub fn render(error: &RuntimeError) -> String {
    let mut out = format!("error: {error}");
    let mut cause = std::error::Error::source(error);
    while let Some(c) = cause {
        out.push_str(&format!("\n  caused by: {c}"));
        cause = c.source();
    }
    if let Some(hint) = error.hint() {
        out.push_str(&format!("\n  hint: {hint}"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn denied(import: &str, grant: ManifestGrant) -> DeniedCapability {
        DeniedCapability { import: import.into(), grant }
    }

    fn instantiate_error(
        scope: &str,
        entry: &str,
        surface: GrantSurface,
        denied: Vec<DeniedCapability>,
    ) -> RuntimeError {
        RuntimeError::Module {
            scope: scope.into(),
            stage: ModuleStage::Instantiate,
            surface,
            entry: entry.into(),
            denied,
            source: HostError::Instantiate(
                "module 'fetcher' imports wasi:http/types@0.2.6 but its manifest does not \
                 grant `http`"
                    .into(),
            ),
        }
    }

    #[test]
    fn render_shows_summary_cause_chain_and_hint() {
        let e = instantiate_error(
            "fetcher",
            "Fetcher",
            GrantSurface::AppManifest,
            vec![denied("wasi:http/types@0.2.6", ManifestGrant::Http)],
        );
        let text = render(&e);
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines[0], "error: module `fetcher`: instantiate failed");
        assert!(lines[1].starts_with("  caused by: instantiation failed: module 'fetcher' imports"));
        assert_eq!(
            lines[2],
            "  hint: the module imports wasi:http but is not granted it; add `\"http\": true` \
             to the `Fetcher` entry in app.json"
        );
    }

    #[test]
    fn capability_hint_follows_the_grant_surface() {
        let cloud = || vec![denied("hypen:storage/cloud@0.1.0", ManifestGrant::Storage(StorageScope::Cloud))];
        let e = instantiate_error("counter", "counter", GrantSurface::CommandLine, cloud());
        assert_eq!(
            e.hint().unwrap(),
            "the module imports hypen:storage/cloud but is not granted it; pass \
             --grant-storage cloud"
        );
        // A per-usage scope's grants live in its backing module's entry.
        let e = instantiate_error("counter__a", "Counter", GrantSurface::AppManifest, cloud());
        assert_eq!(
            e.hint().unwrap(),
            "the module imports hypen:storage/cloud but is not granted it; add \
             `\"storage\": [\"cloud\"]` to the `Counter` entry in app.json"
        );
    }

    /// Every missing grant is named, each once, in one hint per surface.
    #[test]
    fn capability_hint_names_every_missing_grant() {
        let all = || {
            vec![
                denied("hypen:storage/app@0.1.0", ManifestGrant::Storage(StorageScope::App)),
                denied("hypen:storage/cloud@0.1.0", ManifestGrant::Storage(StorageScope::Cloud)),
                denied("wasi:http/types@0.2.10", ManifestGrant::Http),
                denied("wasi:http/outgoing-handler@0.2.10", ManifestGrant::Http),
            ]
        };
        let e = instantiate_error("ts", "ts", GrantSurface::CommandLine, all());
        assert_eq!(
            e.hint().unwrap(),
            "the module imports hypen:storage/app and hypen:storage/cloud and wasi:http but \
             is not granted them; pass --grant-http --grant-storage app,cloud"
        );
        let e = instantiate_error("ts", "Ts", GrantSurface::AppManifest, all());
        assert_eq!(
            e.hint().unwrap(),
            "the module imports hypen:storage/app and hypen:storage/cloud and wasi:http but \
             is not granted them; add `\"http\": true` and `\"storage\": [\"app\", \"cloud\"]` \
             to the `Ts` entry in app.json"
        );
    }

    /// The hint comes from the host's structured denial only: an error whose
    /// text merely mentions an interface gets none.
    #[test]
    fn no_denial_no_capability_hint() {
        let e = instantiate_error("m", "m", GrantSurface::CommandLine, Vec::new());
        assert_eq!(e.hint(), None);
        let e = RuntimeError::Module {
            scope: "m".into(),
            stage: ModuleStage::Init,
            surface: GrantSurface::CommandLine,
            entry: "m".into(),
            denied: Vec::new(),
            source: HostError::Trap("wasi:http exploded".into()),
        };
        assert_eq!(e.hint(), None);
    }

    #[test]
    fn ambiguous_and_unknown_actions_list_their_candidates() {
        let e = RuntimeError::AmbiguousAction {
            action: "increment".into(),
            candidates: vec!["app:increment".into(), "counter:increment".into()],
        };
        assert_eq!(
            e.to_string(),
            "action `increment` is handled by more than one module; address one of them: \
             `app:increment`, `counter:increment`"
        );
        assert!(e.hint().unwrap().contains("`sender` node id"));

        let engine = || EngineError::ActionNotFound("frobnicate".into());
        let e = RuntimeError::UnknownAction {
            name: "counter:frobnicate".into(),
            candidates: vec!["counter:increment".into()],
            engine: engine(),
        };
        assert_eq!(
            one_line(&e),
            "No handler registered for action: frobnicate; did you mean `counter:increment`?"
        );
        let e = RuntimeError::UnknownAction { name: "x".into(), candidates: vec![], engine: engine() };
        assert_eq!(e.to_string(), "No handler registered for action: frobnicate");
    }

    #[test]
    fn io_errors_name_the_file_and_chain_the_os_error() {
        let e = RuntimeError::io(
            "read",
            "missing.wasm",
            std::io::Error::new(std::io::ErrorKind::NotFound, "No such file"),
        );
        assert_eq!(render(&e), "error: cannot read missing.wasm\n  caused by: No such file");
        assert_eq!(e.exit_code(), 1);
    }

    #[test]
    fn usage_errors_exit_with_2_and_dispatch_errors_keep_the_engine_text() {
        assert_eq!(RuntimeError::usage("unknown flag: --x").exit_code(), 2);
        let e = RuntimeError::Dispatch(EngineError::ActionNotFound("frobnicate".into()));
        assert_eq!(e.to_string(), "No handler registered for action: frobnicate");
    }

    #[test]
    fn crashed_modules_are_named_with_a_recovery_hint() {
        let e = RuntimeError::ModuleCrashed {
            scopes: vec!["limits".into()],
            reasons: Vec::new(),
            source: EngineError::ModuleError("module trapped: deadline".into()),
        };
        assert_eq!(
            one_line(&e),
            "module `limits` crashed: Module error: module trapped: deadline"
        );
        assert!(e.hint().unwrap().contains("re-instantiates"));

        // With the host's death reason, the summary says what killed it.
        let e = RuntimeError::ModuleCrashed {
            scopes: vec!["limits".into()],
            reasons: vec!["module 'limits' export `dispatch` exceeded its 100 ms CPU budget".into()],
            source: EngineError::ModuleError("x".into()),
        };
        assert_eq!(
            e.to_string(),
            "module `limits` crashed (module 'limits' export `dispatch` exceeded its 100 ms \
             CPU budget)"
        );
    }
}
