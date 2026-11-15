//! `hypen-runtime` — a minimal CLI that loads a `hypen:module` WASM
//! Component and drives it interactively or over HTTP.
//!
//! This is the "ship your whole app as a .wasm" entry point. Same engine,
//! same `WasmtimeHost`, same wasi:http — just packaged as a binary so you
//! can hand a user a `.wasm` and a one-liner to run it.
//!
//! # Usage
//!
//! ```text
//! hypen-runtime <module.wasm> [--scope name] [--serve PORT] [--actions a,b,c]
//!
//! Action routing is discovered from the module's `actions` export; the
//! `--actions` flag is an optional override.
//! ```
//!
//! ## REPL mode (default)
//!
//! Each stdin line: `<action> [json-payload]`. Stdout shows the resulting
//! module state. Ctrl-D / EOF exits. In a multi-module `--app`, qualify an
//! action with its scope (`<scope>:<action>`, e.g. `counter:increment`) when
//! more than one module exports the same action name.
//!
//! ## Server mode (`--serve PORT`)
//!
//! Opens an HTTP server on `127.0.0.1:PORT`:
//!
//! - `GET  /`         — static client (state viewer + action buttons)
//! - `GET  /state`    — `{ scope, state, states, actions }` as JSON, where
//!   `state` is the entry scope and `states` maps every module scope → state
//! - `GET  /patches`  — the full render log so far (initial tree + every
//!   re-render), as a JSON patch array; `[]` in state-only mode
//! - `POST /dispatch` — `{ action, payload, sender? }` body; dispatches and
//!   returns `{ state, states, patches, error? }`
//! - `GET  /events`   — Server-Sent Events stream of out-of-band render deltas
//!   (a `.hypen` hot reload, a delayed effect), so a live client updates without
//!   polling; dispatch deltas ride the `/dispatch` response instead
//!
//! Every module `.wasm` and `.hypen` is watched for hot reload (single-module
//! and `--app`); a `.wasm` change swaps the instance while preserving engine
//! state, a `.hypen` change re-renders the entry and pushes the delta over SSE.

use std::collections::{HashMap, HashSet};
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use hypen_engine::dispatch::Action;
use hypen_engine::ir::ast_to_ir_node;
use hypen_engine::module_host::{
    DualHost, Effect, ModuleHost, ModuleManifest, StorageScope,
};
use hypen_engine::portable::TemplateExpander;
use hypen_engine::{Engine, EngineError, ModuleGrants, Patch};

const CLIENT_HTML: &str = include_str!("hypen_runtime_client.html");

/// Shared sink the engine's render callback appends patch batches to, so the
/// REPL / HTTP layers can read what the declarative `.hypen` UI produced.
/// `None` when no `--ui` was given (state-only mode).
type PatchLog = Arc<Mutex<Vec<Patch>>>;

/// Live SSE subscribers. Each connected `GET /events` client parks a `Sender`
/// here; out-of-band renders (a `.hypen` hot-reload re-render, a delayed
/// effect's re-dispatch) are broadcast to all of them as one SSE `data:` frame.
/// Dead connections are pruned when a send fails.
type PatchStream = Arc<Mutex<Vec<std::sync::mpsc::Sender<String>>>>;

/// Server-push plumbing for `GET /events` (SSE). `subscribers` is the live
/// client list; `in_dispatch` is set by the HTTP `/dispatch` handler around the
/// engine dispatch so the render callback can *skip* broadcasting the patches
/// that the `/dispatch` response already carries — otherwise the client would
/// apply the same delta twice. Renders that are *not* inside a `/dispatch`
/// (hot reload, a delayed timer's re-dispatch) broadcast normally, which is the
/// whole point: the browser sees them without polling.
#[derive(Clone)]
struct LiveStream {
    subscribers: PatchStream,
    in_dispatch: Arc<std::sync::atomic::AtomicBool>,
}

impl LiveStream {
    fn new() -> Self {
        Self {
            subscribers: Arc::new(Mutex::new(Vec::new())),
            in_dispatch: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }

    /// Broadcast a rendered patch batch to every live SSE subscriber, unless a
    /// `/dispatch` is in flight (its HTTP response already carries the delta).
    /// Prunes subscribers whose receiver has hung up.
    fn broadcast(&self, patches: &[Patch]) {
        use std::sync::atomic::Ordering;
        if patches.is_empty() || self.in_dispatch.load(Ordering::SeqCst) {
            return;
        }
        let json = serde_json::to_string(patches).unwrap_or_else(|_| "[]".into());
        self.subscribers
            .lock()
            .unwrap()
            .retain(|tx| tx.send(json.clone()).is_ok());
    }
}

/// Collects engine-native effects (`Navigate` / `Delay`) the reducer emitted,
/// for the host to perform after a dispatch. The engine can't perform these
/// itself — navigation needs a router, delay needs a timer — so it hands them
/// to us via [`Engine::set_effect_handler`]. Each entry is `(scope, effect)`.
type EffectOutbox = Arc<Mutex<Vec<(String, Effect)>>>;

/// Install the render callback: append each patch batch to the shared log and
/// broadcast it to live SSE clients.
///
/// The engine's raw stream carries template-shaped list rows as
/// `RegisterTemplate`/`Instantiate`; the reference clients (the REPL dump and
/// `hypen_runtime_client.html`) only speak the plain `Create`+`Insert` wire, so
/// every batch is lowered through one session-lifetime [`TemplateExpander`].
fn install_render_sink(engine: &mut Engine, sink: PatchLog, live: LiveStream) {
    let expander = Mutex::new(TemplateExpander::new());
    engine.set_render_callback(move |patches: &[Patch]| {
        let patches = expander.lock().unwrap().expand(patches.to_vec());
        sink.lock().unwrap().extend_from_slice(&patches);
        live.broadcast(&patches);
    });
}

/// Install an effect handler that records `Navigate`/`Delay` into a fresh
/// outbox, and return the outbox. Call on the engine during boot.
fn install_effect_outbox(engine: &mut Engine) -> EffectOutbox {
    let outbox: EffectOutbox = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&outbox);
    engine.set_effect_handler(move |scope: &str, effect: &Effect| {
        sink.lock().unwrap().push((scope.to_string(), effect.clone()));
    });
    outbox
}

struct Args {
    /// Single-module mode: the .wasm path. `None` in `--app` (multi-module)
    /// mode.
    wasm_path: Option<PathBuf>,
    /// Multi-module mode: path to an app manifest (JSON) listing modules.
    app: Option<PathBuf>,
    actions: Vec<String>,
    scope: String,
    serve: Option<u16>,
    ui: Option<PathBuf>,
    /// Persist module `local`/`app` storage under this directory (one JSON
    /// snapshot per host ABI), so state survives process restarts.
    data_dir: Option<PathBuf>,
}

fn parse_args() -> Result<Args, String> {
    let mut wasm_path: Option<PathBuf> = None;
    let mut app: Option<PathBuf> = None;
    let mut actions: Vec<String> = Vec::new();
    let mut scope: Option<String> = None;
    let mut serve: Option<u16> = None;
    let mut ui: Option<PathBuf> = None;
    let mut data_dir: Option<PathBuf> = None;

    let mut iter = std::env::args().skip(1);
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "-h" | "--help" => return Err(USAGE.to_string()),
            "--app" => {
                app = Some(PathBuf::from(iter.next().ok_or("--app needs a manifest path")?));
            }
            "--actions" => {
                let v = iter.next().ok_or("--actions needs a value")?;
                actions = v.split(',').map(|s| s.trim().to_string()).collect();
            }
            "--scope" => {
                scope = Some(iter.next().ok_or("--scope needs a value")?);
            }
            "--serve" => {
                let v = iter.next().ok_or("--serve needs a port")?;
                serve = Some(v.parse().map_err(|e| format!("--serve: {e}"))?);
            }
            "--ui" => {
                ui = Some(PathBuf::from(iter.next().ok_or("--ui needs a .hypen path")?));
            }
            "--data-dir" => {
                data_dir = Some(PathBuf::from(iter.next().ok_or("--data-dir needs a directory")?));
            }
            s if s.starts_with("--") => return Err(format!("unknown flag: {s}\n\n{USAGE}")),
            _ => {
                if wasm_path.is_some() {
                    return Err(format!("unexpected arg: {arg}\n\n{USAGE}"));
                }
                wasm_path = Some(PathBuf::from(arg));
            }
        }
    }

    if app.is_some() && wasm_path.is_some() {
        return Err(format!("pass either <module.wasm> or --app, not both\n\n{USAGE}"));
    }
    if app.is_none() && wasm_path.is_none() {
        return Err(format!("missing <module.wasm> (or --app MANIFEST)\n\n{USAGE}"));
    }

    // In single-module mode the scope defaults to the .wasm file stem; in
    // --app mode the entry module's name becomes the scope (set in boot_app).
    let scope = scope.unwrap_or_else(|| {
        wasm_path
            .as_ref()
            .and_then(|p| p.file_stem())
            .and_then(|s| s.to_str())
            .unwrap_or("module")
            .to_string()
    });

    Ok(Args { wasm_path, app, actions, scope, serve, ui, data_dir })
}

const USAGE: &str = "\
hypen-runtime — drive a hypen:module .wasm interactively or over HTTP

Usage:
  hypen-runtime <module.wasm> [--scope name] [--serve PORT] [--ui FILE.hypen]
                              [--actions a,b,c]
  hypen-runtime --app MANIFEST.json [--serve PORT]

Options:
  --app MANIFEST   Load a multi-module app from a JSON manifest with an
                   `entry` module name and a `modules` list of
                   {name, wasm, ui} entries. Each module's wasm is hosted
                   under its (lowercased) name as the state scope; its
                   .hypen is registered as a component so the entry
                   template can reference it (e.g. `Counter()`). Paths are
                   relative to the manifest.
  --actions LIST   Comma-separated action names to route. OPTIONAL — by
                   default the runtime asks the module via its `actions`
                   export, so you normally don't pass this. Use it only to
                   override (e.g. to force a specific subset).
  --scope NAME     Module scope name in the engine. Defaults to the file
                   stem of <module.wasm>.
  --data-dir DIR   Persist module local/app storage as JSON snapshots under
                   DIR, so module state survives runtime restarts.
  --serve PORT     Run an HTTP server on 127.0.0.1:PORT instead of the REPL.
                   GET /, /state and POST /dispatch let a browser drive the
                   module. Static client embedded.
  --ui FILE.hypen  Render a declarative UI against the module's state. The
                   .hypen template's `@{state.x}` bind to the module's state
                   and `@actions.x` route to its dispatch — logic lives in
                   the .wasm, UI in the .hypen, engine renders. REPL prints
                   the emitted patches; --serve exposes them at GET /patches.
  -h, --help       Show this help.

REPL syntax (per stdin line):
  <action-name> [json-payload]
  <scope>:<action-name> [json-payload]   (qualify when scopes share a name)

EOF / Ctrl-D exits.";

/// Set up the engine + module host. Returns the wired engine; caller picks
/// the I/O mode (REPL or HTTP).
///
/// Action routing is resolved from the module itself via its `actions`
/// export — the module is the single source of truth. `--actions` on the
/// command line, if given, overrides (handy for the `"*"` wildcard or
/// debugging). `args.actions` is updated in place to the resolved list so
/// the rest of the runtime (state envelope, hot reload) sees the truth.
///
/// A module `.wasm` the server should watch for hot reload: its engine state
/// scope, the file to watch, and the action list to re-wire. In `--app` mode
/// there is one per stateful module.
#[derive(Clone)]
struct ReloadTarget {
    scope: String,
    wasm: PathBuf,
    actions: Vec<String>,
    /// Capability manifest to re-register with on hot reload, so a swapped
    /// instance keeps the ACLs it booted with (grant-all in single-module
    /// mode; the app.json-derived grants in `--app`).
    manifest: ModuleManifest,
}

/// name → its `.hypen` UI source. Shared (behind a lock) between the component
/// resolver, which reads the current source on every render, and the `.hypen`
/// hot-reload watcher, which rewrites the changed module's source before
/// re-rendering the entry.
type UiSources = Arc<Mutex<HashMap<String, String>>>;

/// A module `.hypen` the server watches for UI hot reload: the component name
/// (its key in [`UiSources`]) and the file to watch. On change the watcher
/// rewrites `UiSources[name]`, clears the engine's resolved-component cache,
/// and re-renders the entry template (which re-resolves the changed source).
#[derive(Clone)]
struct UiReloadTarget {
    name: String,
    ui_path: PathBuf,
}

/// App-mode (`--app`) replan context for the `.hypen` watcher: everything
/// needed to re-run [`plan_per_usage`] over the updated raw sources and mint a
/// *new* synthetic scope live when an edit adds a distinct usage config
/// (previously a documented restart-only limitation). Raw sources are kept
/// separately from [`UiSources`] because the shared sources hold the
/// *rewritten* templates (references renamed to synthetic components) — a
/// replan must always start from the pristine files.
#[derive(Clone)]
struct UiReplan {
    manifest: AppManifest,
    manifest_dir: PathBuf,
    /// Pristine `.hypen` sources by module name (watcher updates on change).
    raw: Arc<Mutex<HashMap<String, String>>>,
    /// Scopes already registered + wired (base + previously minted
    /// synthetics), so a replan only mints what's genuinely new.
    wired: Arc<Mutex<HashSet<String>>>,
}

/// Everything the `.hypen` hot-reload watcher needs: the shared UI sources it
/// rewrites on change, the templates to watch, and the entry component name to
/// re-parse + re-render. `None` in state-only mode (no `--ui`, not `--app`).
struct UiReload {
    sources: UiSources,
    targets: Vec<UiReloadTarget>,
    entry: String,
    /// `Some` in `--app` mode: a template edit re-plans per-usage instances
    /// (minting new synthetic scopes) instead of just swapping raw source.
    replan: Option<UiReplan>,
}

type BootResult = (
    Engine,
    Option<PatchLog>,
    Vec<ReloadTarget>,
    EffectOutbox,
    Option<UiReload>,
    LiveStream,
);

/// Convert a parser AST [`hypen_parser::Value`] to a [`serde_json::Value`].
///
/// The engine lowers parser values to its *IR* `Value`, never to JSON, so no
/// such conversion exists upstream — the runtime carries this small one to turn
/// declaration-site module args into `init(config)` JSON. Integral numbers are
/// emitted as JSON integers (`7`, not `7.0`) so `module X(start: 7)` yields the
/// natural `{"start":7}`. Strings have their surrounding quotes trimmed (parser
/// `Value::String` keeps them, like `parser_value_to_ir` does). References
/// (`@state.x`) aren't literal config values; they're preserved as their source
/// string rather than silently dropped.
fn parser_value_to_json(value: &hypen_parser::Value) -> serde_json::Value {
    use hypen_parser::Value as V;
    match value {
        V::String(s) => {
            let trimmed = s.trim_matches(|c: char| c == '"' || c == '\'');
            serde_json::Value::String(trimmed.to_string())
        }
        V::Number(n) => {
            if n.fract() == 0.0 && n.is_finite() && *n >= i64::MIN as f64 && *n <= i64::MAX as f64 {
                serde_json::Value::Number((*n as i64).into())
            } else {
                serde_json::Number::from_f64(*n)
                    .map(serde_json::Value::Number)
                    .unwrap_or(serde_json::Value::Null)
            }
        }
        V::Boolean(b) => serde_json::Value::Bool(*b),
        V::List(items) => {
            serde_json::Value::Array(items.iter().map(parser_value_to_json).collect())
        }
        V::Map(map) => serde_json::Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), parser_value_to_json(v)))
                .collect(),
        ),
        V::Reference(r) | V::DataSourceReference(r) => serde_json::Value::String(r.clone()),
    }
}

/// A component's arguments as a JSON object: named args by key, positional args
/// by index (`"0"`, `"1"`, …), matching [`hypen_parser::ArgumentList::as_map`].
fn component_args_map(
    component: &hypen_parser::ComponentSpecification,
) -> serde_json::Map<String, serde_json::Value> {
    let mut obj = serde_json::Map::new();
    for arg in &component.arguments.arguments {
        match arg {
            hypen_parser::Argument::Named { key, value } => {
                obj.insert(key.clone(), parser_value_to_json(value));
            }
            hypen_parser::Argument::Positioned { position, value } => {
                obj.insert(position.to_string(), parser_value_to_json(value));
            }
        }
    }
    obj
}

/// The declaration-site config object for a module root (`module X(args)`), or
/// an empty object for a non-module root.
///
/// `module Counter(start: 5)` → `{"start":5}`. This is the *declaration* site
/// (the module's own default); a usage-site reference in a parent template
/// (`Counter(start: 5)`) is collected separately by [`collect_usage_config`]
/// and merged over this default.
fn module_config_value(component: &hypen_parser::ComponentSpecification) -> serde_json::Value {
    if component.declaration_type != hypen_parser::DeclarationType::Module {
        return serde_json::Value::Object(Default::default());
    }
    serde_json::Value::Object(component_args_map(component))
}

/// Byte-serialized [`module_config_value`], for callers that pass it straight to
/// `host.init` without merging (single-module `boot`).
fn module_config_bytes(component: &hypen_parser::ComponentSpecification) -> Vec<u8> {
    serde_json::to_vec(&module_config_value(component)).unwrap_or_else(|_| b"{}".to_vec())
}

/// A usage site: a `Counter(...)` reference to a stateful module inside some
/// template. Carries the containing template's name, the byte range of the
/// reference's name token (for renaming to a synthetic scope), and the usage
/// args.
#[derive(Clone)]
struct RefSite {
    template: String,
    name_range: std::ops::Range<usize>,
    usage: serde_json::Map<String, serde_json::Value>,
}

/// Recursively collect references to any stateful module in one template tree.
/// A `module X` *declaration* node is the module itself, not a usage, so it's
/// skipped; its argument-bearing descendants that name a stateful module are the
/// usage sites. Matches references by exact component name.
fn collect_ref_sites(
    component: &hypen_parser::ComponentSpecification,
    template: &str,
    stateful_names: &HashSet<String>,
    out: &mut HashMap<String, Vec<RefSite>>,
) {
    let is_decl = component.declaration_type == hypen_parser::DeclarationType::Module;
    if !is_decl && stateful_names.contains(&component.name) {
        out.entry(component.name.clone()).or_default().push(RefSite {
            template: template.to_string(),
            name_range: component.metadata.name_range.clone(),
            usage: component_args_map(component),
        });
    }
    for child in &component.children {
        collect_ref_sites(child, template, stateful_names, out);
    }
}

/// A synthetic-scope suffix for the k-th extra config (`1 → a`, `2 → b`, … `27 →
/// aa`). Letters only, deliberately: the parser rejects a component name ending
/// in a digit, and synthetic scopes are derived by lowercasing the renamed
/// component name, so `Counter__a` must stay a valid identifier.
fn alpha_suffix(mut n: usize) -> String {
    let mut s = String::new();
    while n > 0 {
        n -= 1;
        s.insert(0, (b'a' + (n % 26) as u8) as char);
        n /= 26;
    }
    s
}

/// A canonical string for a config object, stable across key insertion order —
/// so `Counter(a: 1, b: 2)` and `Counter(b: 2, a: 1)` dedupe to one instance.
fn canonical_key(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::Object(m) => {
            let sorted: std::collections::BTreeMap<_, _> = m.iter().collect();
            serde_json::to_string(&sorted).unwrap_or_default()
        }
        _ => serde_json::to_string(v).unwrap_or_default(),
    }
}

/// Split a usage-site arg map into (config args, optional `key:` disambiguator).
/// `key` is a scope-distinctness hint, not module state — it forces two
/// otherwise-identical references apart without ever reaching the module's
/// `init(config)`. Returns the map with `key` removed and the key's value (as a
/// string; a non-string `key` is stringified).
fn split_usage_key(
    usage: &serde_json::Map<String, serde_json::Value>,
) -> (serde_json::Map<String, serde_json::Value>, Option<String>) {
    let mut config = usage.clone();
    let key = config.remove("key").map(|v| match v {
        serde_json::Value::String(s) => s,
        other => other.to_string(),
    });
    (config, key)
}

/// The scope-distinctness key for one effective config: the config's canonical
/// key, folded together with the usage-site `key:` disambiguator (if any). Two
/// references with the same config but different `key:` yield different
/// distinctness keys → two instances; a `None` key falls back to the plain
/// config canonical, so keyless identical configs still dedupe to one instance.
fn distinct_key(config: &serde_json::Value, key: Option<&str>) -> String {
    match key {
        Some(k) => format!("{}\u{0}key={k}", canonical_key(config)),
        None => canonical_key(config),
    }
}

/// Merge usage args over a base (declaration-site default) config — the caller
/// overrides the default. An arg-less reference (`over` empty) yields the base.
fn merge_over(
    base: &serde_json::Value,
    over: &serde_json::Map<String, serde_json::Value>,
) -> serde_json::Value {
    let mut m = base.as_object().cloned().unwrap_or_default();
    for (k, val) in over {
        m.insert(k.clone(), val.clone());
    }
    serde_json::Value::Object(m)
}

/// Replace byte ranges in `source` with new identifiers. Applies highest-offset
/// first so earlier ranges stay valid (names are ASCII, so byte ranges are char
/// boundaries).
fn splice_names(source: &str, edits: &[(std::ops::Range<usize>, String)]) -> String {
    let mut edits = edits.to_vec();
    edits.sort_by_key(|e| std::cmp::Reverse(e.0.start));
    let mut out = source.to_string();
    for (range, new) in edits {
        if range.start <= out.len() && range.end <= out.len() {
            out.replace_range(range, &new);
        }
    }
    out
}

/// A backing module's source with its root `module X` declaration renamed to
/// `new_name`, so the engine scopes this synthetic copy distinctly.
fn rename_root_module(source: &str, new_name: &str) -> String {
    match hypen_parser::parse_document(source)
        .ok()
        .and_then(|d| d.components.into_iter().next())
    {
        Some(root) => splice_names(source, &[(root.metadata.name_range, new_name.to_string())]),
        None => source.to_string(),
    }
}

/// One planned wasm instance: the state scope it registers under (base = the
/// module's own lowercased name; synthetic = `name__uK`), the manifest module
/// backing it (`.wasm` + base `.hypen`), and its `init` config. References
/// resolve to this scope because the rewritten template renames them to the
/// matching synthetic component whose root declaration carries the same name.
struct PlannedInstance {
    scope: String,
    backing: String,
    config: serde_json::Value,
}

/// Plan one wasm instance per *distinct usage config*, across all templates, and
/// rewrite templates so the engine's declaration-name→scope rule yields one
/// scope per config.
///
/// For each stateful module: the declaration-site default and every distinct
/// effective config (default merged with a reference's args) get an instance.
/// The first needed config takes the base scope (the module's own name) — the
/// default when the module is the entry / referenced arg-less / unreferenced,
/// else the first configured reference — so the common single-config case stays
/// at the clean base scope. Extra distinct configs get synthetic scopes
/// (`name__uK`): their references are renamed to a synthetic component name, and
/// a synthetic source (the base template with its root declaration renamed) is
/// registered so the engine scopes it separately.
///
/// Returns the planned stateful instances and the rewritten sources by component
/// name (base templates with references renamed + one synthetic source per
/// synthetic scope). Same config referenced twice → one shared instance
/// (content-addressed); a reference can force a distinct instance for an
/// identical config with an explicit `key:` arg, which folds into the
/// distinctness key without leaking into the module's `init` config.
fn plan_per_usage(
    manifest: &AppManifest,
    raw_sources: &HashMap<String, String>,
) -> (Vec<PlannedInstance>, HashMap<String, String>) {
    let stateful_names: HashSet<String> = manifest
        .modules
        .iter()
        .filter(|m| m.wasm.is_some())
        .map(|m| m.name.clone())
        .collect();

    // Declaration-site default config per stateful module (its own `.hypen`
    // root `module X(args)`).
    let mut defaults: HashMap<String, serde_json::Value> = HashMap::new();
    for name in &stateful_names {
        let default = raw_sources
            .get(name)
            .and_then(|s| hypen_parser::parse_document(s).ok())
            .and_then(|d| d.components.into_iter().next())
            .map(|c| module_config_value(&c))
            .unwrap_or_else(|| serde_json::Value::Object(Default::default()));
        defaults.insert(name.clone(), default);
    }

    // Reference sites across every template.
    let mut ref_sites: HashMap<String, Vec<RefSite>> = HashMap::new();
    for m in &manifest.modules {
        if let Some(src) = raw_sources.get(&m.name) {
            if let Ok(doc) = hypen_parser::parse_document(src) {
                for comp in &doc.components {
                    collect_ref_sites(comp, &m.name, &stateful_names, &mut ref_sites);
                }
            }
        }
    }

    let mut instances: Vec<PlannedInstance> = Vec::new();
    let mut rewrites: HashMap<String, Vec<(std::ops::Range<usize>, String)>> = HashMap::new();
    let mut synthetic: Vec<(String, String)> = Vec::new(); // (synthetic name, backing name)

    for m in &manifest.modules {
        if m.wasm.is_none() {
            continue;
        }
        let name = &m.name;
        let default = defaults
            .get(name)
            .cloned()
            .unwrap_or_else(|| serde_json::Value::Object(Default::default()));
        let sites = ref_sites.get(name).cloned().unwrap_or_default();
        let is_entry = *name == manifest.entry;

        // Distinct effective configs, base-first when the default is needed
        // (entry, an arg-less/no-op reference, or no references at all). A
        // reference's `key:` arg is a scope disambiguator, not module state: it
        // is stripped from the effective config (so it never reaches `init`) but
        // folded into the distinctness key, so `Counter(start:5, key:"a")` and
        // `Counter(start:5, key:"b")` become two instances that both init with
        // `{"start":5}`. A keyed reference is never a no-op default collapse.
        let needs_default = is_entry
            || sites.is_empty()
            || sites.iter().any(|s| {
                let (config, key) = split_usage_key(&s.usage);
                key.is_none() && merge_over(&default, &config) == default
            });
        let mut ordered: Vec<serde_json::Value> = Vec::new();
        let mut index_of: HashMap<String, usize> = HashMap::new();
        if needs_default {
            index_of.insert(distinct_key(&default, None), 0);
            ordered.push(default.clone());
        }
        for s in &sites {
            let (config, key) = split_usage_key(&s.usage);
            let eff = merge_over(&default, &config);
            let dkey = distinct_key(&eff, key.as_deref());
            index_of.entry(dkey).or_insert_with(|| {
                ordered.push(eff.clone());
                ordered.len() - 1
            });
        }

        let base_scope = name.to_lowercase();
        for (idx, cfg) in ordered.iter().enumerate() {
            let (scope, component_name) = if idx == 0 {
                (base_scope.clone(), name.clone())
            } else {
                let sfx = alpha_suffix(idx);
                (format!("{base_scope}__{sfx}"), format!("{name}__{sfx}"))
            };
            if idx > 0 {
                synthetic.push((component_name, name.clone()));
            }
            instances.push(PlannedInstance {
                scope,
                backing: name.clone(),
                config: cfg.clone(),
            });
        }

        // Rename references that map to a synthetic scope.
        for s in &sites {
            let (config, key) = split_usage_key(&s.usage);
            let eff = merge_over(&default, &config);
            let idx = *index_of
                .get(&distinct_key(&eff, key.as_deref()))
                .unwrap_or(&0);
            if idx > 0 {
                rewrites
                    .entry(s.template.clone())
                    .or_default()
                    .push((s.name_range.clone(), format!("{name}__{}", alpha_suffix(idx))));
            }
        }
    }

    // Rewritten sources: base templates with their references renamed, then one
    // synthetic source per synthetic scope (root declaration renamed).
    let mut rewritten: HashMap<String, String> = HashMap::new();
    for m in &manifest.modules {
        let src = raw_sources.get(&m.name).cloned().unwrap_or_default();
        let out = match rewrites.get(&m.name) {
            Some(edits) => splice_names(&src, edits),
            None => src,
        };
        rewritten.insert(m.name.clone(), out);
    }
    for (synthetic_name, backing) in &synthetic {
        let base = rewritten.get(backing).cloned().unwrap_or_default();
        rewritten.insert(synthetic_name.clone(), rename_root_module(&base, synthetic_name));
    }

    (instances, rewritten)
}

fn boot(args: &mut Args) -> Result<BootResult, String> {
    let wasm_path = args
        .wasm_path
        .clone()
        .ok_or("internal: boot called without a wasm_path")?;
    let bytes = std::fs::read(&wasm_path)
        .map_err(|e| format!("reading {}: {e}", wasm_path.display()))?;

    let mut engine = Engine::new();
    // Dual-ABI host: v0.1 sync and v0.2 CM-async components both boot here;
    // `register` sniffs which world the bytes target.
    let mut host = DualHost::with_options(
        Default::default(),
        Default::default(),
        args.data_dir.as_deref(),
    )
    .map_err(|e| format!("host: {e}"))?;
    host.register(&args.scope, &bytes, ModuleManifest::all(&args.scope))
        .map_err(|e| format!("register: {e}"))?;
    let id = host
        .instantiate(&args.scope)
        .map_err(|e| format!("instantiate: {e}"))?;

    // Parse the optional declarative UI *before* init so a `module X(args)`
    // root can seed the module's `init(config)`; keep the path + source + doc
    // around for the initial render and the `.hypen` hot-reload watcher.
    let ui_parsed = match &args.ui {
        None => None,
        Some(ui_path) => {
            let src = std::fs::read_to_string(ui_path)
                .map_err(|e| format!("reading ui {}: {e}", ui_path.display()))?;
            let doc = hypen_parser::parse_document(&src)
                .map_err(|e| format!("parsing ui {}: {e:?}", ui_path.display()))?;
            Some((ui_path.clone(), src, doc))
        }
    };

    // Declaration-site config: `module X(start: 5)` → init sees `{"start":5}`.
    // An absent UI, a non-module root, or an arg-less module all yield `{}`.
    let config_bytes = ui_parsed
        .as_ref()
        .and_then(|(_, _, doc)| doc.components.first())
        .map(module_config_bytes)
        .unwrap_or_else(|| b"{}".to_vec());

    let init_bytes = host
        .init(id, &config_bytes)
        .map_err(|e| format!("init: {e}"))?;
    let init_state: serde_json::Value =
        serde_json::from_slice(&init_bytes).map_err(|e| format!("init state: {e}"))?;

    // Ask the module what actions it handles, unless the operator forced a
    // list with --actions.
    if args.actions.is_empty() {
        args.actions = host
            .actions(id)
            .map_err(|e| format!("querying module actions: {e}"))?;
        eprintln!("[actions] discovered from module: {:?}", args.actions);
    }

    engine.set_module_host(Box::new(host));
    engine
        .register_module_instance(
            &args.scope,
            id,
            args.actions.clone(),
            ModuleGrants::none(),
            init_state,
        )
        .map_err(|e| format!("wiring module: {e}"))?;

    let live = LiveStream::new();

    // Optional declarative UI: render the already-parsed .hypen bound to the
    // module's state. The render callback appends each patch batch to a shared
    // log the REPL prints / the server exposes, and broadcasts out-of-band
    // renders to live SSE clients. This is the "logic-only module + declarative
    // UI + engine renders" model (see wit/AUTHORING_MODEL.md).
    let (patch_log, ui_reload) = match ui_parsed {
        None => (None, None),
        Some((ui_path, src, doc)) => {
            let log: PatchLog = Arc::new(Mutex::new(Vec::new()));
            let sink = Arc::clone(&log);
            let live_cb = live.clone();
            install_render_sink(&mut engine, sink, live_cb);

            let component = doc.components.first().ok_or("ui has no component")?;
            let ir = ast_to_ir_node(component);
            engine.render_ir_node(&ir); // initial render → fills the log

            // Share the entry source (keyed by scope) so the `.hypen` watcher
            // can rewrite it and re-render. Single-module mode has no component
            // resolver — the entry is re-parsed straight from this map.
            let sources: UiSources =
                Arc::new(Mutex::new(HashMap::from([(args.scope.clone(), src)])));
            let ui_reload = UiReload {
                sources,
                targets: vec![UiReloadTarget {
                    name: args.scope.clone(),
                    ui_path,
                }],
                entry: args.scope.clone(),
                // Single-module mode has no per-usage planning to redo.
                replan: None,
            };
            (Some(log), Some(ui_reload))
        }
    };

    let effects = install_effect_outbox(&mut engine);

    // Wake the module now that the render callback + effect outbox are
    // installed: run its `on_activated` and fold the result (subscriptions,
    // effects, emitted actions, state delta) so nothing it produces is dropped.
    if let Err(e) = engine.activate_module(&args.scope) {
        eprintln!("[boot] on_activated({}) failed: {e}", args.scope);
    }

    let targets = vec![ReloadTarget {
        scope: args.scope.clone(),
        wasm: wasm_path,
        actions: args.actions.clone(),
        manifest: ModuleManifest::all(&args.scope),
    }];
    Ok((engine, patch_log, targets, effects, ui_reload, live))
}

fn run() -> Result<(), String> {
    let mut args = parse_args()?;
    let (engine, patches, reload, effects, ui_reload, live) = if args.app.is_some() {
        boot_app(&mut args)?
    } else {
        boot(&mut args)?
    };

    match args.serve {
        Some(port) => serve(engine, args, port, patches, reload, effects, ui_reload, live),
        None => repl(engine, args, patches, effects),
    }
}

/// Render the current patch log as pretty JSON for the REPL.
fn dump_patches(log: &PatchLog) -> String {
    let patches = log.lock().unwrap();
    serde_json::to_string_pretty(&*patches).unwrap_or_else(|_| "[]".into())
}

// ── multi-module app loading (--app MANIFEST) ───────────────────────────────

#[derive(Clone, serde::Deserialize)]
struct AppManifest {
    /// Name of the entry module (matches a `name` below; its template is the
    /// root that references the others).
    entry: String,
    modules: Vec<ModuleEntry>,
}

#[derive(Clone, serde::Deserialize)]
struct ModuleEntry {
    /// Component name used in templates (e.g. `Counter()`), and — lowercased —
    /// the engine state scope.
    name: String,
    /// Path to the module's `.wasm` (logic), relative to the manifest.
    ///
    /// `None` for **stateless** components — template-only `.hypen` building
    /// blocks (e.g. a `Header()` or `Card()`) that have UI but no state or
    /// actions. They're registered with the component resolver so the entry
    /// can reference them by name, but no wasm instance is created.
    #[serde(default)]
    wasm: Option<PathBuf>,
    /// Path to the module's `.hypen` (declarative UI), relative to the
    /// manifest.
    ui: PathBuf,
    /// Storage scopes granted to this module: any of `"local"`, `"app"`,
    /// `"cloud"` (`local` is always granted regardless). Absent → all three,
    /// matching the pre-manifest grant-all default (`ModuleManifest::all`).
    #[serde(default)]
    storage: Option<Vec<String>>,
    /// Sibling module scopes this module may `hypen:engine/state.read` /
    /// `subscribe` to. Absent → none, matching `ModuleManifest::all`.
    #[serde(default)]
    reads: Option<Vec<String>>,
    /// Sibling module scopes this module may `hypen:engine/state.dispatch` to.
    /// Absent → none, matching `ModuleManifest::all`.
    #[serde(default)]
    dispatches: Option<Vec<String>>,
    /// Whether outbound HTTP (`wasi:http`) is granted. Absent → granted
    /// (the historical baseline); an explicit `false` denies at link time —
    /// a module importing `wasi:http` without the grant fails to
    /// instantiate, making egress auditable from app.json alone.
    #[serde(default)]
    http: Option<bool>,
}

/// Build a [`ModuleManifest`] for `scope` from a manifest entry's optional
/// capability fields. A field left out falls back to the historical grant-all
/// baseline (`ModuleManifest::all`: full storage, no cross-module
/// reads/dispatches), so app.json files written before capabilities existed
/// behave exactly as they did.
fn manifest_from_entry(scope: &str, entry: &ModuleEntry) -> Result<ModuleManifest, String> {
    let mut manifest = ModuleManifest::all(scope);
    if let Some(storage) = &entry.storage {
        manifest.storage = storage
            .iter()
            .map(|s| parse_storage_scope(s))
            .collect::<Result<Vec<_>, _>>()?;
    }
    if let Some(reads) = &entry.reads {
        manifest.reads = reads.iter().map(|s| s.to_lowercase()).collect();
    }
    if let Some(dispatches) = &entry.dispatches {
        manifest.dispatches = dispatches.iter().map(|s| s.to_lowercase()).collect();
    }
    if let Some(http) = entry.http {
        manifest.http = http;
    }
    Ok(manifest)
}

/// Parse a storage-scope string (`local`/`app`/`cloud`, case-insensitive) from
/// an app manifest into a [`StorageScope`].
fn parse_storage_scope(s: &str) -> Result<StorageScope, String> {
    match s.to_lowercase().as_str() {
        "local" => Ok(StorageScope::Local),
        "app" => Ok(StorageScope::App),
        "cloud" => Ok(StorageScope::Cloud),
        other => Err(format!(
            "unknown storage scope `{other}` (expected local, app, or cloud)"
        )),
    }
}

/// Load a multi-module app: register + instantiate each module's `.wasm` under
/// its scope, install a component resolver mapping each module name to its
/// `.hypen` source, then render the entry template. The engine's existing
/// component resolution + module-scope propagation composes the tree — each
/// referenced module renders bound to *its own* wasm instance's state.
fn boot_app(args: &mut Args) -> Result<BootResult, String> {
    let manifest_path = args.app.clone().unwrap();
    let manifest_dir = manifest_path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_default();
    let manifest_src = std::fs::read_to_string(&manifest_path)
        .map_err(|e| format!("reading manifest {}: {e}", manifest_path.display()))?;
    let manifest: AppManifest =
        serde_json::from_str(&manifest_src).map_err(|e| format!("parsing manifest: {e}"))?;

    let mut engine = Engine::new();
    // Dual-ABI host — a single --app may mix v0.1 and v0.2 modules.
    let mut host = DualHost::with_options(
        Default::default(),
        Default::default(),
        args.data_dir.as_deref(),
    )
    .map_err(|e| format!("host: {e}"))?;

    // One per module `.hypen`, for the UI hot-reload watcher.
    let mut ui_targets: Vec<UiReloadTarget> = Vec::new();
    let mut all_actions: Vec<String> = Vec::new();
    // (scope, id, actions, init_state) to wire into the engine after the host
    // is installed.
    let mut wirings: Vec<(String, _, Vec<String>, ModuleGrants, serde_json::Value)> = Vec::new();
    // One per stateful module, for the hot-reload watcher.
    let mut reload: Vec<ReloadTarget> = Vec::new();

    // Read every module's raw `.hypen` (stateful + stateless) and record it for
    // the hot-reload watcher.
    let mut raw_sources: HashMap<String, String> = HashMap::new();
    for m in &manifest.modules {
        let ui_path = manifest_dir.join(&m.ui);
        let ui_src = std::fs::read_to_string(&ui_path)
            .map_err(|e| format!("reading {} ui: {e}", m.name))?;
        raw_sources.insert(m.name.clone(), ui_src);
        ui_targets.push(UiReloadTarget {
            name: m.name.clone(),
            ui_path,
        });
    }

    // Plan one instance per distinct usage config and rewrite templates so each
    // maps to its own scope. Arg-less references and single-config modules keep
    // the base scope (`counter`); each extra distinct config gets `counter__uK`
    // via a renamed synthetic component the engine scopes separately.
    let (instances, rewritten_sources) = plan_per_usage(&manifest, &raw_sources);
    let ui_sources = rewritten_sources;
    let entry_ui = ui_sources.get(&manifest.entry).cloned();

    // Instantiate each planned instance under its scope, init'd with its config.
    // Several instances (a module's base + its synthetics) share one `.wasm`.
    let mut instance_count = 0usize;
    for inst in &instances {
        let m = manifest
            .modules
            .iter()
            .find(|mm| mm.name == inst.backing)
            .expect("planned instance's backing module is in the manifest");
        let wasm_rel = m.wasm.as_ref().expect("planned instances are stateful");
        let wasm_bytes = std::fs::read(manifest_dir.join(wasm_rel))
            .map_err(|e| format!("reading {} wasm: {e}", inst.backing))?;
        // Scoped capabilities from the backing module's manifest entry — a
        // synthetic instance inherits the same ACLs as its base.
        let acl = manifest_from_entry(&inst.scope, m)?;
        host.register(&inst.scope, &wasm_bytes, acl.clone())
            .map_err(|e| format!("register {}: {e}", inst.scope))?;
        let id = host
            .instantiate(&inst.scope)
            .map_err(|e| format!("instantiate {}: {e}", inst.scope))?;
        let config_bytes = serde_json::to_vec(&inst.config).unwrap_or_else(|_| b"{}".to_vec());
        let init_state: serde_json::Value = serde_json::from_slice(
            &host
                .init(id, &config_bytes)
                .map_err(|e| format!("init {}: {e}", inst.scope))?,
        )
        .map_err(|e| format!("init state {}: {e}", inst.scope))?;
        let actions = host
            .actions(id)
            .map_err(|e| format!("actions {}: {e}", inst.scope))?;
        all_actions.extend(actions.iter().cloned());
        let grants = ModuleGrants::from(&acl);
        reload.push(ReloadTarget {
            scope: inst.scope.clone(),
            wasm: manifest_dir.join(wasm_rel),
            actions: actions.clone(),
            manifest: acl,
        });
        wirings.push((inst.scope.clone(), id, actions, grants, init_state));
        instance_count += 1;
    }

    // Install the host (now holding every instance), then wire each instance's
    // state slot + action routing into the engine.
    engine.set_module_host(Box::new(host));
    let mut scopes: Vec<String> = Vec::with_capacity(wirings.len());
    for (scope, id, actions, grants, init_state) in wirings {
        engine
            .register_module_instance(&scope, id, actions, grants, init_state)
            .map_err(|e| format!("wiring module `{scope}`: {e}"))?;
        scopes.push(scope);
    }

    let entry_ui = entry_ui
        .ok_or_else(|| format!("entry module `{}` not found in manifest", manifest.entry))?;

    // Share the UI sources behind a lock so the `.hypen` hot-reload watcher can
    // rewrite a changed module's source; the resolver reads the current source
    // on every (re-)render.
    let ui_sources: UiSources = Arc::new(Mutex::new(ui_sources));

    // Component resolver: name → ResolvedComponent { source }. The engine
    // parses each on demand, tags `module X` declarations, and scopes their
    // bindings to X's state slot.
    let resolver_sources = Arc::clone(&ui_sources);
    engine.set_component_resolver(move |name, _ctx| {
        resolver_sources
            .lock()
            .unwrap()
            .get(name)
            .map(|src| hypen_engine::ir::ResolvedComponent {
                source: src.clone(),
                path: name.to_string(),
                passthrough: false,
                lazy: false,
            })
    });

    // The entry module's name becomes the reported scope; actions across all
    // modules drive the debug UI / state envelope.
    args.scope = manifest.entry.to_lowercase();
    all_actions.sort();
    all_actions.dedup();
    args.actions = all_actions;
    let stateless_count = manifest.modules.iter().filter(|m| m.wasm.is_none()).count();
    eprintln!(
        "[app] loaded {} instance(s){}; entry `{}`",
        instance_count,
        if stateless_count > 0 {
            format!(" + {stateless_count} stateless component(s)")
        } else {
            String::new()
        },
        manifest.entry
    );

    // Render the entry template; references to sibling modules resolve through
    // the resolver above.
    let live = LiveStream::new();
    let log: PatchLog = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&log);
    let live_cb = live.clone();
    install_render_sink(&mut engine, sink, live_cb);
    let doc = hypen_parser::parse_document(&entry_ui)
        .map_err(|e| format!("parsing entry ui: {e:?}"))?;
    let component = doc
        .components
        .first()
        .ok_or("entry ui has no component")?;
    let ir = ast_to_ir_node(component);
    engine.render_ir_node(&ir);

    let effects = install_effect_outbox(&mut engine);

    // Wake every wired instance once the render callback + effect outbox are
    // installed and the initial render has run, so an `on_activated` that
    // subscribes to (or reads) a sibling, emits effects, or mutates state has
    // its ReducerOutput folded — nothing dropped.
    for scope in &scopes {
        if let Err(e) = engine.activate_module(scope) {
            eprintln!("[app] on_activated({scope}) failed: {e}");
        }
    }

    let ui_reload = UiReload {
        sources: ui_sources,
        targets: ui_targets,
        entry: manifest.entry.clone(),
        replan: Some(UiReplan {
            manifest_dir,
            raw: Arc::new(Mutex::new(raw_sources)),
            wired: Arc::new(Mutex::new(scopes.iter().cloned().collect())),
            manifest,
        }),
    };
    Ok((engine, Some(log), reload, effects, Some(ui_reload), live))
}

// ── REPL mode ─────────────────────────────────────────────────────────────

fn repl(
    mut engine: Engine,
    args: Args,
    patches: Option<PatchLog>,
    effects: EffectOutbox,
) -> Result<(), String> {
    let state = engine
        .get_module_state(&args.scope)
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    println!("ready: {state}");
    // When a UI is loaded, show the initial render tree and track how many
    // patches we've printed so each dispatch only prints the new ones.
    let mut printed = 0usize;
    if let Some(log) = &patches {
        println!("ui: {}", dump_patches(log));
        printed = log.lock().unwrap().len();
    }
    eprintln!("(type `<action> [payload]`; Ctrl-D to exit)");

    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    for line in stdin.lock().lines() {
        let line = line.map_err(|e| format!("stdin: {e}"))?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let (name, payload_str) = match trimmed.split_once(char::is_whitespace) {
            Some((n, p)) => (n, p.trim()),
            None => (trimmed, ""),
        };
        let payload: serde_json::Value = if payload_str.is_empty() {
            serde_json::Value::Object(Default::default())
        } else {
            match serde_json::from_str(payload_str) {
                Ok(v) => v,
                Err(e) => {
                    writeln!(stdout, "error: invalid JSON payload: {e}").ok();
                    continue;
                }
            }
        };

        // Report the scope the action targets: `scope:action` reports that
        // scope; a bare name reports the active scope (`--scope`).
        let target_scope = name
            .split_once(':')
            .map(|(s, _)| s.to_lowercase())
            .unwrap_or_else(|| args.scope.clone());
        let before = engine
            .get_module_state(&target_scope)
            .cloned()
            .unwrap_or(serde_json::Value::Null);

        if let Err(e) = dispatch_host_action(&mut engine, name, payload, None) {
            writeln!(stdout, "error: {e}").ok();
            continue;
        }

        let after = engine
            .get_module_state(&target_scope)
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        if after == before {
            writeln!(stdout, "state: <unchanged>").ok();
        } else {
            writeln!(stdout, "state: {after}").ok();
        }

        // Surface engine-native effects the reducer emitted. The REPL has no
        // shared engine to drive a timer, so Delay is reported rather than
        // scheduled (use `--serve` for real timers); Navigate is printed.
        for (scope, effect) in std::mem::take(&mut *effects.lock().unwrap()) {
            match effect {
                Effect::Navigate(path) => writeln!(stdout, "navigate: {path}").ok(),
                Effect::Delay { ms, then } => {
                    writeln!(stdout, "delay: {ms}ms -> {scope}:{then} (scheduled only under --serve)").ok()
                }
                Effect::Log { .. } => None,
            };
        }

        // If a UI is loaded, print the patches this dispatch produced (the
        // reactive re-render appended them to the log via the callback).
        if let Some(log) = &patches {
            let all = log.lock().unwrap();
            if all.len() > printed {
                let delta = serde_json::to_string(&all[printed..]).unwrap_or_else(|_| "[]".into());
                writeln!(stdout, "patches: {delta}").ok();
                printed = all.len();
            } else {
                writeln!(stdout, "patches: []").ok();
            }
        }
        stdout.flush().ok();
    }
    Ok(())
}

// ── server mode ────────────────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
fn serve(
    engine: Engine,
    args: Args,
    port: u16,
    patches: Option<PatchLog>,
    reload: Vec<ReloadTarget>,
    effects: EffectOutbox,
    ui_reload: Option<UiReload>,
    live: LiveStream,
) -> Result<(), String> {
    // `tiny_http` is single-threaded but accepts concurrent connections by
    // pushing each into a worker; for this CLI we serialize through one
    // mutex on the engine. The engine itself is single-threaded by design.
    let addr = format!("127.0.0.1:{port}");
    let server = tiny_http::Server::http(&addr).map_err(|e| format!("bind {addr}: {e}"))?;
    let engine = Arc::new(Mutex::new(engine));

    eprintln!("hypen-runtime: http://{addr}/   (module `{}`)", args.scope);

    // Hot-reload watcher over every module `.wasm` (swap the instance, preserve
    // state) AND every module `.hypen` template (re-render the entry
    // server-side) — single-module and multi-module `--app` alike. Holds the
    // OS-level file-watcher handle; dropping it stops watching. Nothing to
    // watch → no watcher.
    let _watcher_handle = if reload.is_empty() && ui_reload.is_none() {
        None
    } else {
        Some(spawn_reload_watcher(&engine, reload, ui_reload)?)
    };

    for mut req in server.incoming_requests() {
        let method = req.method().clone();
        let url = req.url().to_string();

        // `GET /events` is a long-lived Server-Sent Events stream. Park a
        // subscriber and hand the raw socket to a dedicated thread so the main
        // accept loop keeps serving; the render callback pushes each out-of-band
        // patch batch (hot reload, delayed effect) to it. `into_writer` gives us
        // the socket directly — tiny_http's `respond` is for one-shot bodies.
        if method == tiny_http::Method::Get && url == "/events" {
            let (tx, rx) = std::sync::mpsc::channel::<String>();
            live.subscribers.lock().unwrap().push(tx);
            std::thread::spawn(move || stream_events(req, rx));
            continue;
        }

        let resp = route(&method, &url, &mut req, &engine, &args, &patches, &effects, &live);
        if let Err(e) = req.respond(resp) {
            eprintln!("respond error: {e}");
        }
    }
    Ok(())
}

/// Drive one SSE connection: write the event-stream headers, then relay each
/// broadcast patch batch as a `data:` frame until the client disconnects (a
/// failed write) or the sender is dropped. Owns the socket for its lifetime.
fn stream_events(req: tiny_http::Request, rx: std::sync::mpsc::Receiver<String>) {
    let mut w = req.into_writer();
    let header = "HTTP/1.1 200 OK\r\n\
                  Content-Type: text/event-stream\r\n\
                  Cache-Control: no-cache\r\n\
                  Connection: keep-alive\r\n\
                  Access-Control-Allow-Origin: *\r\n\r\n";
    if w.write_all(header.as_bytes()).is_err() || w.flush().is_err() {
        return;
    }
    // A leading comment nudges EventSource to fire `onopen` immediately.
    if w.write_all(b": connected\n\n").is_err() || w.flush().is_err() {
        return;
    }
    for msg in rx {
        if w.write_all(format!("data: {msg}\n\n").as_bytes()).is_err() || w.flush().is_err() {
            break;
        }
    }
}

/// Drain the effect outbox and perform each engine-native effect the host owns:
/// `Navigate` is collected and returned (surfaced in the HTTP response), and
/// `Delay` spawns a timer that re-dispatches its `then` action to the
/// originating scope after `ms` — the Elm-style debounce/retry primitive. The
/// timer drains again so a delayed dispatch's own effects fire too.
fn drain_effects(
    engine: &Arc<Mutex<Engine>>,
    effects: &EffectOutbox,
    patches: &Option<PatchLog>,
) -> Vec<String> {
    let drained: Vec<(String, Effect)> = std::mem::take(&mut *effects.lock().unwrap());
    let mut navigations = Vec::new();
    for (scope, effect) in drained {
        match effect {
            Effect::Navigate(path) => navigations.push(path),
            Effect::Delay { ms, then } => {
                // Route the follow-up back to the module that scheduled it.
                let eng = Arc::clone(engine);
                let outbox = Arc::clone(effects);
                let plog = patches.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(ms as u64));
                    let _ = eng.lock().unwrap().dispatch_module_action(
                        &scope,
                        &then,
                        serde_json::Value::Null,
                    );
                    // The delayed dispatch may itself emit effects (chained
                    // delays, navigation) — process them now.
                    drain_effects(&eng, &outbox, &plog);
                });
            }
            // Log is handled engine-side and never reaches the outbox.
            Effect::Log { .. } => {}
        }
    }
    navigations
}

/// Canonicalize a path for change-event matching, falling back to the path
/// as-given if it doesn't currently resolve (e.g. mid-rewrite by a build).
fn canon(p: &std::path::Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

/// Re-parse the entry template from the current UI sources and render it
/// through the engine, appending the reconcile patches to the render log via
/// the engine's render callback. Called by the `.hypen` hot-reload watcher
/// after it rewrites a changed module's source. `clear_resolved_components`
/// drops cached component expansions so referenced modules pick up their new
/// source on this render; `render_ir_node` then reconciles against the live
/// tree and emits only the delta.
fn rerender_entry_ui(
    engine: &Arc<Mutex<Engine>>,
    ui_sources: &UiSources,
    entry: &str,
) -> Result<(), String> {
    let entry_src = ui_sources
        .lock()
        .unwrap()
        .get(entry)
        .cloned()
        .ok_or_else(|| format!("entry `{entry}` missing from ui sources"))?;
    let doc = hypen_parser::parse_document(&entry_src)
        .map_err(|e| format!("parsing entry ui: {e:?}"))?;
    let component = doc.components.first().ok_or("entry ui has no component")?;
    let ir = ast_to_ir_node(component);

    let mut eng = engine.lock().unwrap();
    eng.clear_resolved_components();
    eng.render_ir_node(&ir);
    Ok(())
}

/// Register + instantiate + init + wire one freshly planned per-usage
/// instance — the same steps `boot_app` runs at startup, applied live from
/// the `.hypen` watcher when an edit introduces a new distinct usage config.
fn mint_planned_instance(
    engine: &Arc<Mutex<Engine>>,
    rp: &UiReplan,
    inst: &PlannedInstance,
) -> Result<(), String> {
    let m = rp
        .manifest
        .modules
        .iter()
        .find(|mm| mm.name == inst.backing)
        .ok_or_else(|| format!("backing module `{}` not in manifest", inst.backing))?;
    let wasm_rel = m
        .wasm
        .as_ref()
        .ok_or_else(|| format!("`{}` is stateless; nothing to mint", inst.backing))?;
    let bytes = std::fs::read(rp.manifest_dir.join(wasm_rel))
        .map_err(|e| format!("reading {} wasm: {e}", inst.backing))?;
    // A synthetic instance inherits its base module's ACLs, like at boot.
    let acl = manifest_from_entry(&inst.scope, m)?;
    let config = serde_json::to_vec(&inst.config).unwrap_or_else(|_| b"{}".to_vec());

    let mut eng = engine.lock().unwrap();
    let host = eng.module_host_mut().ok_or("no module host installed")?;
    let grants = ModuleGrants::from(&acl);
    host.register(&inst.scope, &bytes, acl)
        .map_err(|e| format!("register: {e}"))?;
    let id = host.instantiate(&inst.scope).map_err(|e| format!("instantiate: {e}"))?;
    let init_bytes = host.init(id, &config).map_err(|e| format!("init: {e}"))?;
    let actions = host.actions(id).unwrap_or_default();
    let state: serde_json::Value =
        serde_json::from_slice(&init_bytes).map_err(|e| format!("init state: {e}"))?;
    eng.register_module_instance(&inst.scope, id, actions, grants, state)
        .map_err(|e| format!("wiring module: {e}"))?;
    // Same wake-up boot gives every wired instance.
    if let Err(e) = eng.activate_module(&inst.scope) {
        eprintln!("[reload] on_activated({}) failed: {e}", inst.scope);
    }
    Ok(())
}

/// Re-run per-usage planning over the updated raw sources: mint any scope the
/// edit introduced (new distinct usage config → new synthetic instance,
/// live — previously a restart-only limitation), then swap the freshly
/// rewritten templates (including any new synthetic component source) into
/// the shared resolver map.
fn replan_app_ui(
    engine: &Arc<Mutex<Engine>>,
    rp: &UiReplan,
    sources: &UiSources,
) -> Result<(), String> {
    let raw = rp.raw.lock().unwrap().clone();
    let (instances, rewritten) = plan_per_usage(&rp.manifest, &raw);

    for inst in &instances {
        if rp.wired.lock().unwrap().contains(&inst.scope) {
            continue;
        }
        // Best-effort per instance: a failed mint is logged and skipped so
        // one bad usage doesn't take down the rest of the reload.
        match mint_planned_instance(engine, rp, inst) {
            Ok(()) => {
                rp.wired.lock().unwrap().insert(inst.scope.clone());
                eprintln!(
                    "[reload] minted usage scope `{}` (config {})",
                    inst.scope, inst.config
                );
            }
            Err(e) => eprintln!("[reload] minting `{}` failed: {e}", inst.scope),
        }
    }

    // Removed usages keep their instances alive (harmless — no template
    // references them anymore); a restart compacts. Swapping the whole map is
    // what keeps existing synthetic references correctly renamed after edits.
    *sources.lock().unwrap() = rewritten;
    Ok(())
}

/// Watch every module `.wasm` and every module `.hypen`, hot-reloading on
/// change. Works for both single-module and multi-module `--app`.
///
/// - A `.wasm` change swaps the owning scope's instance; engine state is
///   preserved across the swap (the fresh instance is woken via `on_activated`
///   rather than re-`init`-ed). Several scopes can be backed by the *same*
///   `.wasm` (e.g. two `Counter()`s), so one file change reloads every scope
///   that references it.
/// - A `.hypen` change rewrites the shared UI source for that component and
///   re-renders the entry template server-side. The reconcile delta is appended
///   to the patch log `GET /patches` returns *and* broadcast to live `GET
///   /events` (SSE) subscribers via the render callback, so a connected browser
///   updates without a manual refresh.
///
/// Returns the debouncer handle; the caller must keep it alive for the
/// duration of the server (drop = stop watching).
fn spawn_reload_watcher(
    engine: &Arc<Mutex<Engine>>,
    targets: Vec<ReloadTarget>,
    ui_reload: Option<UiReload>,
) -> Result<notify_debouncer_mini::Debouncer<notify_debouncer_mini::notify::RecommendedWatcher>, String>
{
    use notify_debouncer_mini::{new_debouncer, notify::RecursiveMode};
    use std::time::Duration;

    let engine = Arc::clone(engine);
    let targets_cb = targets.clone();

    // UI hot-reload wiring, cloned out of `ui_reload` for the callback (which
    // must own everything it touches). Empty / `None` in state-only mode.
    let ui_targets_cb: Vec<UiReloadTarget> =
        ui_reload.as_ref().map(|u| u.targets.clone()).unwrap_or_default();
    let ui_sources_cb: Option<UiSources> = ui_reload.as_ref().map(|u| Arc::clone(&u.sources));
    let entry_cb: Option<String> = ui_reload.as_ref().map(|u| u.entry.clone());
    let replan_cb: Option<UiReplan> = ui_reload.as_ref().and_then(|u| u.replan.clone());

    let mut debouncer = new_debouncer(
        Duration::from_millis(200),
        move |res: notify_debouncer_mini::DebounceEventResult| match res {
            Err(e) => eprintln!("[reload] watch error: {e}"),
            Ok(events) => {
                if events.is_empty() {
                    return;
                }
                let changed: Vec<PathBuf> = events.iter().map(|e| canon(&e.path)).collect();

                // 1) Module `.wasm` changed → swap the instance, preserve state.
                for t in &targets_cb {
                    if !changed.iter().any(|c| *c == canon(&t.wasm)) {
                        continue;
                    }
                    if let Err(e) = reload_module(&engine, &t.wasm, &t.scope, &t.actions, &t.manifest) {
                        eprintln!("[reload] {} failed: {e}", t.scope);
                    } else {
                        eprintln!("[reload] {} reloaded", t.scope);
                    }
                }

                // 2) Template `.hypen` changed → rewrite the shared UI source
                // and re-render the entry server-side. One re-render covers all
                // templates that changed in this debounce window.
                if let (Some(sources), Some(entry)) = (&ui_sources_cb, &entry_cb) {
                    let mut any_ui = false;
                    for t in &ui_targets_cb {
                        if !changed.iter().any(|c| *c == canon(&t.ui_path)) {
                            continue;
                        }
                        match std::fs::read_to_string(&t.ui_path) {
                            Ok(src) => {
                                // App mode keeps pristine sources separately:
                                // the replan below rewrites them (synthetic
                                // renames) before they reach the resolver map.
                                match &replan_cb {
                                    Some(rp) => {
                                        rp.raw.lock().unwrap().insert(t.name.clone(), src);
                                    }
                                    None => {
                                        sources.lock().unwrap().insert(t.name.clone(), src);
                                    }
                                }
                                any_ui = true;
                                eprintln!("[reload] ui {} updated", t.name);
                            }
                            Err(e) => eprintln!("[reload] ui {} read failed: {e}", t.name),
                        }
                    }
                    if any_ui {
                        // App mode: re-plan per-usage instances first — an
                        // edit that adds a new distinct usage config mints its
                        // synthetic scope live before the re-render binds it.
                        if let Some(rp) = &replan_cb {
                            if let Err(e) = replan_app_ui(&engine, rp, sources) {
                                eprintln!("[reload] replan failed: {e}");
                            }
                        }
                        match rerender_entry_ui(&engine, sources, entry) {
                            Ok(()) => eprintln!("[reload] ui re-rendered (entry `{entry}`)"),
                            Err(e) => eprintln!("[reload] ui re-render failed: {e}"),
                        }
                    }
                }
            }
        },
    )
    .map_err(|e| format!("watcher: {e}"))?;

    // Watch each distinct `.wasm` once (multiple scopes may share a file).
    let mut watched: Vec<PathBuf> = Vec::new();
    for t in &targets {
        if watched.iter().any(|w| w == &t.wasm) {
            continue;
        }
        debouncer
            .watcher()
            .watch(&t.wasm, RecursiveMode::NonRecursive)
            .map_err(|e| format!("watching {}: {e}", t.wasm.display()))?;
        watched.push(t.wasm.clone());
    }

    // Also watch each distinct `.hypen` template for UI hot reload.
    let mut ui_watched: Vec<PathBuf> = Vec::new();
    if let Some(u) = &ui_reload {
        for t in &u.targets {
            if ui_watched.iter().any(|w| w == &t.ui_path) {
                continue;
            }
            debouncer
                .watcher()
                .watch(&t.ui_path, RecursiveMode::NonRecursive)
                .map_err(|e| format!("watching {}: {e}", t.ui_path.display()))?;
            ui_watched.push(t.ui_path.clone());
        }
    }

    eprintln!(
        "[reload] watching {} module file(s) + {} template(s) (200ms debounce)",
        watched.len(),
        ui_watched.len()
    );
    Ok(debouncer)
}

/// Re-register the module bytes, instantiate a fresh component, hand it the
/// engine's *current* state via `on_activated`, re-wire the engine's action
/// routing to the new instance, then destroy the old instance. State is not
/// touched on the engine side — it's the same `EngineCore::modules` slot.
fn reload_module(
    engine: &Arc<Mutex<Engine>>,
    wasm_path: &PathBuf,
    scope: &str,
    actions: &[String],
    manifest: &ModuleManifest,
) -> Result<(), String> {
    let bytes = std::fs::read(wasm_path)
        .map_err(|e| format!("read {}: {e}", wasm_path.display()))?;

    let mut eng = engine.lock().unwrap();

    let host = eng
        .module_host_mut()
        .ok_or("no module host installed")?;
    host.register(scope, &bytes, manifest.clone())
        .map_err(|e| format!("re-register: {e}"))?;
    let new_id = host.instantiate(scope).map_err(|e| format!("instantiate: {e}"))?;

    // Re-query the reloaded module's actions so adding/removing an action
    // in source + rebuild takes effect without restarting the runtime.
    // Fall back to the prior list if the query fails or returns empty.
    let fresh_actions = eng
        .module_host_mut()
        .and_then(|h| h.actions(new_id).ok())
        .filter(|a| !a.is_empty())
        .unwrap_or_else(|| actions.to_vec());

    // Destroy the old instance after the new one is up — order matters,
    // in case the new instance needs to read something the old one wrote.
    let old_id = eng.module_instance_id(scope);
    eng.rewire_module_instance(scope, new_id, fresh_actions, ModuleGrants::from(manifest))
        .map_err(|e| format!("rewire: {e}"))?;
    if let Some(old) = old_id {
        if old != new_id {
            if let Some(host) = eng.module_host_mut() {
                let _ = host.destroy(old);
            }
        }
    }

    // Wake the freshly-wired instance with the engine's preserved state: run
    // its `on_activated` and fold whatever it returns — re-registering any
    // cross-module subscriptions (rewire cleared the old ones), plus effects /
    // emitted actions. State is untouched, so a no-op hook folds to nothing.
    if let Err(e) = eng.activate_module(scope) {
        eprintln!("[reload] on_activated({scope}) failed: {e}");
    }

    Ok(())
}

/// Route an action arriving from the REPL or the dev HTTP endpoint.
///
/// `Engine::dispatch_action` is the renderer-facing entry and only accepts
/// what the UI envelope rules allow. This reference runtime additionally
/// offers two operator conveniences, mapped onto engine APIs here:
/// - `sender` (the clicked node's id) becomes a `__hypen_dispatch` envelope,
///   so the engine resolves the owning scope by node ownership;
/// - `Scope:action` addresses a hosted module directly through the
///   host-trusted `Engine::dispatch_module_action`.
fn dispatch_host_action(
    engine: &mut Engine,
    name: &str,
    payload: serde_json::Value,
    sender: Option<&str>,
) -> Result<(), EngineError> {
    if let Some(node) = sender {
        let envelope = serde_json::json!({ "node": node, "action": name, "payload": payload });
        match engine.dispatch_action(Action::new("__hypen_dispatch").with_payload(envelope)) {
            // The node is not owned by a scope that handles `name`: fall back
            // to the sender-less forms below.
            Err(EngineError::ActionNotFound(_)) => {}
            other => return other,
        }
    }
    if let Some((scope, action)) = name.split_once(':') {
        if engine.module_instance_id(scope).is_some() {
            return engine.dispatch_module_action(scope, action, payload);
        }
    }
    engine.dispatch_action(Action::new(name).with_payload(payload))
}

#[allow(clippy::too_many_arguments)]
fn route(
    method: &tiny_http::Method,
    url: &str,
    req: &mut tiny_http::Request,
    engine: &Arc<Mutex<Engine>>,
    args: &Args,
    patches: &Option<PatchLog>,
    effects: &EffectOutbox,
    live: &LiveStream,
) -> tiny_http::Response<io::Cursor<Vec<u8>>> {
    use tiny_http::Method::*;
    match (method, url) {
        (Get, "/") => html_resp(CLIENT_HTML),
        (Get, "/state") => json_resp(200, &state_envelope(engine, args)),
        (Get, "/patches") => {
            // The full patch log so far (rendered tree + every reactive
            // re-render). A DOM client applies these in order; `[]` when no
            // --ui was given.
            let body = match patches {
                Some(log) => {
                    let p = log.lock().unwrap();
                    serde_json::to_value(&*p).unwrap_or_else(|_| serde_json::json!([]))
                }
                None => serde_json::json!([]),
            };
            json_resp(200, &body)
        }
        (Post, "/dispatch") => {
            let mut body = String::new();
            if let Err(e) = req.as_reader().read_to_string(&mut body) {
                return json_resp(400, &serde_json::json!({ "error": format!("body: {e}") }));
            }
            handle_dispatch(&body, engine, args, patches, effects, live)
        }
        _ => json_resp(404, &serde_json::json!({ "error": "not found" })),
    }
}

fn handle_dispatch(
    body: &str,
    engine: &Arc<Mutex<Engine>>,
    args: &Args,
    patches: &Option<PatchLog>,
    effects: &EffectOutbox,
    live: &LiveStream,
) -> tiny_http::Response<io::Cursor<Vec<u8>>> {
    #[derive(serde::Deserialize)]
    struct Req {
        action: String,
        #[serde(default)]
        payload: serde_json::Value,
        /// Patch-wire node id of the element that fired the action. Lets the
        /// engine resolve the dispatching module's scope when several modules
        /// export the same action name. Optional — the DOM client supplies it.
        #[serde(default)]
        sender: Option<String>,
    }

    let req: Req = match serde_json::from_str(body) {
        Ok(r) => r,
        Err(e) => {
            return json_resp(400, &serde_json::json!({ "error": format!("bad JSON: {e}") }));
        }
    };

    // Snapshot the patch-log length before dispatch so we can return just the
    // patches this dispatch produces (the reactive re-render appends them via
    // the render callback). The DOM client applies this delta incrementally.
    let before = patches
        .as_ref()
        .map(|l| l.lock().unwrap().len())
        .unwrap_or(0);

    let mut eng = engine.lock().unwrap();
    // Suppress SSE broadcast for the reactive re-render this dispatch triggers —
    // the delta rides back in this HTTP response, so a live client that also
    // received it over `/events` would apply it twice. Renders outside a
    // dispatch (hot reload, a delayed timer) are not gated, so they still push.
    use std::sync::atomic::Ordering;
    live.in_dispatch.store(true, Ordering::SeqCst);
    let dispatch_result = dispatch_host_action(
        &mut eng,
        &req.action,
        req.payload.clone(),
        req.sender.as_deref(),
    );
    live.in_dispatch.store(false, Ordering::SeqCst);
    let state = eng
        .get_module_state(&args.scope)
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    // Every module scope's post-dispatch state — a cross-module dispatch can
    // touch siblings, so a single-scope `state` would hide that.
    let states: serde_json::Map<String, serde_json::Value> = eng
        .modules()
        .iter()
        .map(|(name, inst)| (name.clone(), inst.get_state().clone()))
        .collect();
    drop(eng);

    // Perform engine-native effects the reducer emitted: Navigate is surfaced
    // in the response; Delay schedules a timer (which may append more patches
    // later — polled via /patches or /state).
    let navigate = drain_effects(engine, effects, patches);

    let delta = match patches {
        Some(log) => {
            let p = log.lock().unwrap();
            serde_json::to_value(&p[before.min(p.len())..]).unwrap_or_else(|_| serde_json::json!([]))
        }
        None => serde_json::json!([]),
    };

    match dispatch_result {
        Ok(()) => json_resp(
            200,
            &serde_json::json!({ "state": state, "states": states, "patches": delta, "navigate": navigate }),
        ),
        Err(e) => json_resp(
            200,
            &serde_json::json!({ "state": state, "states": states, "patches": delta, "navigate": navigate, "error": e.to_string() }),
        ),
    }
}

fn state_envelope(engine: &Arc<Mutex<Engine>>, args: &Args) -> serde_json::Value {
    let eng = engine.lock().unwrap();
    // `state` = the entry scope (backwards-compatible). `states` = every
    // registered module scope, so a multi-module `--app` exposes sibling
    // state too — not just the entry.
    let state = eng
        .get_module_state(&args.scope)
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let states: serde_json::Map<String, serde_json::Value> = eng
        .modules()
        .iter()
        .map(|(name, inst)| (name.clone(), inst.get_state().clone()))
        .collect();
    serde_json::json!({
        "scope": args.scope,
        "actions": args.actions,
        "state": state,
        "states": states,
    })
}

fn json_resp(
    status: u16,
    body: &serde_json::Value,
) -> tiny_http::Response<io::Cursor<Vec<u8>>> {
    let bytes = serde_json::to_vec(body).unwrap();
    tiny_http::Response::from_data(bytes)
        .with_status_code(status)
        .with_header(
            "Content-Type: application/json"
                .parse::<tiny_http::Header>()
                .unwrap(),
        )
}

fn html_resp(html: &str) -> tiny_http::Response<io::Cursor<Vec<u8>>> {
    tiny_http::Response::from_data(html.as_bytes().to_vec())
        .with_status_code(200)
        .with_header(
            "Content-Type: text/html; charset=utf-8"
                .parse::<tiny_http::Header>()
                .unwrap(),
        )
}

fn main() {
    if let Err(e) = run() {
        eprintln!("{e}");
        std::process::exit(1);
    }
}
