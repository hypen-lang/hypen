//! Command-line parsing: `argv` → a typed [`Command`].
//!
//! Parsing is total and pure ([`parse`] takes any iterator of strings), so
//! every flag combination is unit-testable. Flags that only make sense in one
//! mode live inside that mode's variant — there is no way to hold, say, an
//! `--allow-origin` list without `--serve`.

use std::path::PathBuf;
use std::time::Duration;

use hypen_engine::module_host::{ModuleManifest, StorageScope};

use crate::error::RuntimeError;
use crate::names::ScopeName;
use crate::server::request::Origin;

/// What the process was asked to do.
#[derive(Debug, PartialEq)]
pub enum Command {
    /// `-h` / `--help`: print [`USAGE`] and exit 0.
    Help,
    Run(Box<Options>),
}

#[derive(Debug, PartialEq)]
pub struct Options {
    pub source: Source,
    pub mode: Mode,
    /// Persist module `local`/`app` storage under this directory
    /// (`storage.json`), so state survives process restarts.
    pub data_dir: Option<PathBuf>,
    /// Per-call wall-clock budget for module exports (`--call-timeout-ms`);
    /// `None` keeps the host default.
    pub call_timeout: Option<Duration>,
    /// Keep compiled modules in this directory across runs (`--cache-dir`).
    /// Off unless given: the directory's contents are executed as code.
    pub cache_dir: Option<PathBuf>,
}

/// What to host.
#[derive(Debug, PartialEq)]
pub enum Source {
    /// One `.wasm`, optionally with a `--ui` template.
    Module(ModuleSource),
    /// A multi-module app manifest (`--app app.json`).
    App { manifest: PathBuf },
}

#[derive(Debug, PartialEq)]
pub struct ModuleSource {
    pub wasm: PathBuf,
    pub scope: ScopeName,
    pub ui: Option<PathBuf>,
    pub actions: ActionSource,
    pub grants: Grants,
}

/// Where a single module's routed action list comes from.
#[derive(Debug, Clone, PartialEq)]
pub enum ActionSource {
    /// Ask the module (its `actions` export). The default.
    Discover,
    /// `--actions a,b,c`: route exactly these.
    Override(Vec<String>),
}

/// Capabilities granted to the single module on the command line. Least
/// privilege by default: module-private `local` storage only, no network.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Grants {
    pub http: bool,
    /// Storage scopes granted beyond the always-available `local`.
    pub storage: Vec<StorageScope>,
}

impl Grants {
    /// Everything (`--grant-all`).
    fn all() -> Self {
        Grants { http: true, storage: vec![StorageScope::App, StorageScope::Cloud] }
    }

    /// The host manifest these grants amount to for `scope`.
    pub fn to_manifest(&self, scope: &ScopeName) -> ModuleManifest {
        ModuleManifest {
            name: scope.as_str().to_string(),
            storage: self.storage.clone(),
            http: self.http,
            ..ModuleManifest::default()
        }
    }
}

/// How to drive the hosted app.
#[derive(Debug, PartialEq)]
pub enum Mode {
    /// Read `<action> [payload]` lines from stdin.
    Repl,
    /// HTTP API + SSE + reference client on `127.0.0.1:port`.
    Serve {
        port: u16,
        /// Extra browser origins allowed to call the API (`--allow-origin`).
        allow_origins: Vec<Origin>,
        /// How long a client may take to send a request body
        /// (`--request-timeout-ms`); `None` keeps the server default.
        body_timeout: Option<Duration>,
    },
}

pub const USAGE: &str = "\
hypen-runtime — drive a hypen:module .wasm interactively or over HTTP

Usage:
  hypen-runtime <module.wasm> [--scope NAME] [--ui FILE.hypen] [--actions a,b,c]
                              [--grant-http] [--grant-storage app,cloud]
                              [--serve PORT [--allow-origin ORIGIN]...]
  hypen-runtime --app MANIFEST.json [--serve PORT [--allow-origin ORIGIN]...]
  (both forms: [--data-dir DIR] [--cache-dir DIR] [--call-timeout-ms N])

Options:
  --app MANIFEST   Load a multi-module app from a JSON manifest with an
                   `entry` module name and a `modules` list of
                   {name, wasm, ui} entries. Each module's wasm is hosted
                   under its (lowercased) name as the state scope; its
                   .hypen is registered as a component so the entry
                   template can reference it (e.g. `Counter()`). Paths are
                   relative to the manifest and must stay inside its
                   directory. Capabilities are deny-by-default and granted
                   per module in the manifest (`storage`, `reads`,
                   `dispatches`, `http`).
  --actions LIST   Comma-separated action names to route. OPTIONAL — by
                   default the runtime asks the module via its `actions`
                   export, so you normally don't pass this. Use it only to
                   override (e.g. to force a specific subset).
  --scope NAME     Module scope name in the engine (lowercased). Defaults to
                   the file stem of <module.wasm>.
  --ui FILE.hypen  Render a declarative UI against the module's state. The
                   .hypen template's `@{state.x}` bind to the module's state
                   and `@actions.x` route to its dispatch — logic lives in
                   the .wasm, UI in the .hypen, engine renders. REPL prints
                   the emitted patches; --serve exposes the tree at
                   GET /patches.
  --data-dir DIR   Persist module local/app storage as a JSON snapshot under
                   DIR, so module state survives runtime restarts.
  --cache-dir DIR  Keep compiled modules in DIR and reuse them on later runs, so
                   a module is compiled once instead of at every start (a
                   component that embeds a JS engine takes seconds to compile,
                   far longer in a debug build of this runtime). Off by
                   default — also with --data-dir — because DIR is trusted:
                   a file in it is native code this process will run. DIR is
                   created private (0700) if missing and refused if other
                   users can write to it; entries are keyed by the module's
                   bytes, the wasmtime version and the compiler settings, so
                   a stale entry is never loaded.
  --call-timeout-ms N
                   Wall-clock budget for one module call (default 5000). A
                   module that exceeds it is killed and restarted on the next
                   action.

Capabilities (single-module mode; with --app they come from the manifest):
  A module gets module-private `local` storage and nothing else unless
  granted. A module that imports an ungranted capability fails to start.
  --grant-http     Allow outbound HTTP (wasi:http).
  --grant-storage LIST
                   Comma-separated shared storage scopes to grant: app, cloud.
  --grant-all      Grant HTTP and every storage scope (trusted modules only).

Server:
  --serve PORT     Run an HTTP server on 127.0.0.1:PORT instead of the REPL:
                   GET / (reference client), GET /state, GET /patches,
                   POST /dispatch, GET /events (SSE). Requests must carry a
                   loopback Host header for this port; requests with an
                   Origin header are refused unless it is the server's own
                   origin or one given with --allow-origin. POST bodies must
                   be `Content-Type: application/json`, at most 1 MiB.
  --allow-origin ORIGIN
                   Also accept browser requests from ORIGIN (e.g.
                   http://localhost:5173) — for a client served by another
                   dev server. Repeatable. Requires --serve.
  --request-timeout-ms N
                   How long a client may take to send a POST body (default
                   10000). A request that takes longer is abandoned and
                   answered 408; it no longer counts against the 64 requests
                   handled at once. Requires --serve.
  -h, --help       Show this help.

Environment:
  HYPEN_RUNTIME_TIMINGS=1
                   Log, per module instance, how long registering (compile or
                   cache load) and starting (instantiate + init) took.

REPL syntax (per stdin line):
  <action-name> [json-payload]
  <scope>:<action-name> [json-payload]   (qualify when scopes share a name)

EOF / Ctrl-D exits.";

/// Parse the arguments after the program name.
pub fn parse<I>(args: I) -> Result<Command, RuntimeError>
where
    I: IntoIterator<Item = String>,
{
    let mut wasm: Option<PathBuf> = None;
    let mut app: Option<PathBuf> = None;
    let mut actions = ActionSource::Discover;
    let mut scope: Option<String> = None;
    let mut serve: Option<u16> = None;
    let mut ui: Option<PathBuf> = None;
    let mut data_dir: Option<PathBuf> = None;
    let mut call_timeout: Option<Duration> = None;
    let mut cache_dir: Option<PathBuf> = None;
    let mut body_timeout: Option<Duration> = None;
    let mut allow_origins: Vec<Origin> = Vec::new();
    let mut grants = Grants::default();
    // Single-module-only flags seen, to refuse them alongside --app.
    let mut module_only: Vec<&'static str> = Vec::new();

    let mut iter = args.into_iter();
    while let Some(arg) = iter.next() {
        let mut value = |what: &str| {
            iter.next()
                .ok_or_else(|| RuntimeError::usage(format!("{arg} needs {what}")))
        };
        match arg.as_str() {
            "-h" | "--help" => return Ok(Command::Help),
            "--app" => app = Some(PathBuf::from(value("a manifest path")?)),
            "--actions" => {
                let list = split_list(&value("a comma-separated list")?);
                if list.is_empty() {
                    return Err(RuntimeError::usage("--actions needs at least one action name"));
                }
                actions = ActionSource::Override(list);
                module_only.push("--actions");
            }
            "--scope" => {
                scope = Some(value("a name")?);
                module_only.push("--scope");
            }
            "--serve" => {
                let v = value("a port")?;
                serve = Some(v.parse().map_err(|e| {
                    RuntimeError::usage(format!("--serve: `{v}` is not a port number ({e})"))
                })?);
            }
            "--ui" => {
                ui = Some(PathBuf::from(value("a .hypen path")?));
                module_only.push("--ui");
            }
            "--data-dir" => data_dir = Some(PathBuf::from(value("a directory")?)),
            "--cache-dir" => cache_dir = Some(PathBuf::from(value("a directory")?)),
            "--call-timeout-ms" | "--request-timeout-ms" => {
                let v = value("a number of milliseconds")?;
                let ms: u64 = v.parse().ok().filter(|ms| *ms > 0).ok_or_else(|| {
                    RuntimeError::usage(format!(
                        "{arg}: `{v}` is not a positive number of milliseconds"
                    ))
                })?;
                let timeout = Some(Duration::from_millis(ms));
                if arg == "--call-timeout-ms" {
                    call_timeout = timeout;
                } else {
                    body_timeout = timeout;
                }
            }
            "--allow-origin" => {
                let v = value("an origin such as http://localhost:5173")?;
                let origin = Origin::parse(&v)
                    .map_err(|e| RuntimeError::usage(format!("--allow-origin: {e}")))?;
                if !allow_origins.contains(&origin) {
                    allow_origins.push(origin);
                }
            }
            "--grant-http" => {
                grants.http = true;
                module_only.push("--grant-http");
            }
            "--grant-storage" => {
                for name in split_list(&value("a comma-separated list of app, cloud")?) {
                    let scope = parse_storage_grant(&name)?;
                    if !grants.storage.contains(&scope) {
                        grants.storage.push(scope);
                    }
                }
                module_only.push("--grant-storage");
            }
            "--grant-all" => {
                grants = Grants::all();
                module_only.push("--grant-all");
            }
            s if s.starts_with('-') && s.len() > 1 => {
                return Err(RuntimeError::usage(format!("unknown flag: {s}")));
            }
            _ => {
                if wasm.is_some() {
                    return Err(RuntimeError::usage(format!("unexpected argument: {arg}")));
                }
                wasm = Some(PathBuf::from(arg));
            }
        }
    }

    let source = match (wasm, app) {
        (Some(_), Some(_)) => {
            return Err(RuntimeError::usage("pass either <module.wasm> or --app, not both"));
        }
        (None, None) => {
            return Err(RuntimeError::usage("missing <module.wasm> (or --app MANIFEST)"));
        }
        (None, Some(manifest)) => {
            if let Some(flag) = module_only.first() {
                return Err(RuntimeError::usage(format!(
                    "{flag} applies to a single <module.wasm>; with --app, scopes, templates \
                     and capabilities come from the manifest"
                )));
            }
            Source::App { manifest }
        }
        (Some(wasm), None) => {
            let scope = resolve_scope(scope.as_deref(), &wasm)?;
            Source::Module(ModuleSource { wasm, scope, ui, actions, grants })
        }
    };

    let mode = match serve {
        Some(port) => Mode::Serve { port, allow_origins, body_timeout },
        None => {
            if !allow_origins.is_empty() {
                return Err(RuntimeError::usage("--allow-origin requires --serve"));
            }
            if body_timeout.is_some() {
                return Err(RuntimeError::usage("--request-timeout-ms requires --serve"));
            }
            Mode::Repl
        }
    };

    Ok(Command::Run(Box::new(Options { source, mode, data_dir, call_timeout, cache_dir })))
}

fn split_list(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

fn parse_storage_grant(name: &str) -> Result<StorageScope, RuntimeError> {
    match name.to_lowercase().as_str() {
        // `local` is always granted; accepting it keeps copy-pasted lists working.
        "local" => Ok(StorageScope::Local),
        "app" => Ok(StorageScope::App),
        "cloud" => Ok(StorageScope::Cloud),
        other => Err(RuntimeError::usage(format!(
            "--grant-storage: unknown storage scope `{other}` (expected app or cloud)"
        ))),
    }
}

/// The module's scope: `--scope` if given, else the `.wasm` file stem.
fn resolve_scope(explicit: Option<&str>, wasm: &std::path::Path) -> Result<ScopeName, RuntimeError> {
    match explicit {
        Some(name) => {
            ScopeName::new(name).map_err(|e| RuntimeError::usage(format!("--scope: {e}")))
        }
        None => {
            let stem = wasm.file_stem().and_then(|s| s.to_str()).unwrap_or("module");
            ScopeName::new(stem).map_err(|e| {
                RuntimeError::usage(format!(
                    "cannot derive a scope name from {}: {e}; pass --scope NAME",
                    wasm.display()
                ))
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(args: &[&str]) -> Result<Command, RuntimeError> {
        parse(args.iter().map(|s| s.to_string()))
    }

    fn options(args: &[&str]) -> Options {
        match run(args) {
            Ok(Command::Run(o)) => *o,
            other => panic!("expected Run, got {other:?}"),
        }
    }

    fn usage_error(args: &[&str]) -> String {
        match run(args) {
            Err(RuntimeError::Usage { message }) => message,
            other => panic!("expected a usage error, got {other:?}"),
        }
    }

    #[test]
    fn single_module_defaults_are_least_privilege() {
        let o = options(&["dir/Counter_Module.wasm"]);
        let Source::Module(m) = &o.source else { panic!("module source") };
        assert_eq!(m.scope.as_str(), "counter_module", "file stem, lowercased");
        assert_eq!(m.actions, ActionSource::Discover);
        assert_eq!(m.grants, Grants::default());
        let manifest = m.grants.to_manifest(&m.scope);
        assert!(!manifest.http);
        assert!(manifest.storage.is_empty(), "local only");
        assert_eq!(o.mode, Mode::Repl);
    }

    #[test]
    fn grant_flags_build_the_manifest() {
        let o = options(&["m.wasm", "--grant-http", "--grant-storage", "app, cloud,app"]);
        let Source::Module(m) = &o.source else { panic!("module source") };
        assert!(m.grants.http);
        assert_eq!(m.grants.storage, vec![StorageScope::App, StorageScope::Cloud]);

        let o = options(&["m.wasm", "--grant-all"]);
        let Source::Module(m) = &o.source else { panic!("module source") };
        assert_eq!(m.grants, Grants::all());

        assert!(usage_error(&["m.wasm", "--grant-storage", "disk"]).contains("unknown storage scope"));
    }

    #[test]
    fn serve_carries_its_origins() {
        let o = options(&[
            "m.wasm", "--serve", "8080", "--allow-origin", "http://localhost:5173",
            "--allow-origin", "http://LOCALHOST:5173",
        ]);
        let Mode::Serve { port, allow_origins, body_timeout } = &o.mode else {
            panic!("serve mode")
        };
        assert_eq!(*port, 8080);
        assert_eq!(allow_origins.len(), 1, "duplicates collapse");
        assert_eq!(allow_origins[0].as_str(), "http://localhost:5173");
        assert_eq!(*body_timeout, None, "the server default applies");
    }

    #[test]
    fn cache_dir_and_request_timeout_are_opt_in() {
        let o = options(&["m.wasm", "--data-dir", "d"]);
        assert_eq!(o.cache_dir, None, "--data-dir does not imply a compilation cache");
        let o = options(&["--app", "app.json", "--cache-dir", "/tmp/c", "--serve", "0",
            "--request-timeout-ms", "250"]);
        assert_eq!(o.cache_dir, Some(PathBuf::from("/tmp/c")));
        let Mode::Serve { body_timeout, .. } = &o.mode else { panic!("serve mode") };
        assert_eq!(*body_timeout, Some(Duration::from_millis(250)));

        assert!(usage_error(&["m.wasm", "--cache-dir"]).contains("--cache-dir needs a directory"));
        assert!(usage_error(&["m.wasm", "--request-timeout-ms", "5"]).contains("requires --serve"));
        assert!(usage_error(&["m.wasm", "--serve", "1", "--request-timeout-ms", "0"])
            .contains("--request-timeout-ms: `0` is not a positive"));
        assert!(usage_error(&["m.wasm", "--serve", "1", "--request-timeout-ms", "soon"])
            .contains("--request-timeout-ms"));
    }

    #[test]
    fn help_wins_and_mistakes_are_usage_errors() {
        assert_eq!(run(&["--bogus", "--help"]).ok(), None);
        assert_eq!(run(&["--help"]).unwrap(), Command::Help);
        assert_eq!(run(&["-h", "m.wasm"]).unwrap(), Command::Help);

        assert!(usage_error(&[]).contains("missing <module.wasm>"));
        assert!(usage_error(&["a.wasm", "b.wasm"]).contains("unexpected argument"));
        assert!(usage_error(&["a.wasm", "--app", "app.json"]).contains("not both"));
        assert!(usage_error(&["a.wasm", "--serve"]).contains("--serve needs a port"));
        assert!(usage_error(&["a.wasm", "--serve", "http"]).contains("not a port number"));
        assert!(usage_error(&["a.wasm", "--frob"]).contains("unknown flag"));
        assert!(usage_error(&["a.wasm", "--allow-origin", "http://x.test"]).contains("requires --serve"));
        assert!(usage_error(&["a.wasm", "--serve", "1", "--allow-origin", "x.test/path"])
            .contains("--allow-origin"));
        assert!(usage_error(&["a.wasm", "--call-timeout-ms", "0"]).contains("positive"));
        assert!(usage_error(&["a.wasm", "--scope", "a:b"]).contains("--scope"));
        assert!(usage_error(&["a:b.wasm"]).contains("pass --scope"));
    }

    #[test]
    fn app_mode_refuses_single_module_flags() {
        let o = options(&["--app", "app.json", "--serve", "9", "--data-dir", "d"]);
        assert_eq!(o.source, Source::App { manifest: PathBuf::from("app.json") });
        assert_eq!(o.data_dir, Some(PathBuf::from("d")));
        for flag in [&["--grant-http"][..], &["--ui", "x.hypen"], &["--scope", "s"], &["--actions", "a"]] {
            let mut args = vec!["--app", "app.json"];
            args.extend_from_slice(flag);
            assert!(usage_error(&args).contains("with --app"), "{flag:?}");
        }
    }

    #[test]
    fn actions_override_and_timeout_parse() {
        let o = options(&["m.wasm", "--actions", "a, b", "--call-timeout-ms", "250"]);
        let Source::Module(m) = &o.source else { panic!("module source") };
        assert_eq!(m.actions, ActionSource::Override(vec!["a".into(), "b".into()]));
        assert_eq!(o.call_timeout, Some(Duration::from_millis(250)));
    }
}
