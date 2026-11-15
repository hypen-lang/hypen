//! `app.json`: the raw serde model and the validated [`AppManifest`].
//!
//! Parse, don't validate: [`AppManifest::load`] is the only way to get an
//! `AppManifest`, and one that exists satisfies, by construction:
//!
//! - every module name is engine-addressable ([`ComponentName`]) and no two
//!   names share a scope (scopes are lowercased, so `Counter` / `counter`
//!   collide);
//! - `entry` names a listed module;
//! - every `ui` / `wasm` path exists and resolves — after canonicalisation,
//!   so `..` and symlinks are followed first — to a file inside the
//!   manifest's directory;
//! - every `reads` / `dispatches` target is the scope of a *stateful* module
//!   in the same manifest;
//! - a module is either [`ModuleKind::Stateful`] (wasm + capabilities) or
//!   [`ModuleKind::Stateless`] (template only, no capabilities to grant).

use std::path::{Path, PathBuf};

use hypen_engine::module_host::{HostPattern, InvalidHostPattern, ModuleManifest, StorageScope};

use crate::error::RuntimeError;
use crate::names::{ComponentName, NameError, ScopeName};

// ── raw model (exactly what's in the file) ──────────────────────────────────

#[derive(serde::Deserialize)]
struct RawManifest {
    entry: String,
    modules: Vec<RawModule>,
}

#[derive(serde::Deserialize)]
struct RawModule {
    name: String,
    #[serde(default)]
    wasm: Option<String>,
    ui: String,
    #[serde(default)]
    storage: Option<Vec<String>>,
    #[serde(default)]
    reads: Option<Vec<String>>,
    #[serde(default)]
    dispatches: Option<Vec<String>>,
    #[serde(default)]
    http: Option<bool>,
    #[serde(default, rename = "httpHosts")]
    http_hosts: Option<Vec<String>>,
}

// ── validated model ─────────────────────────────────────────────────────────

/// A validated app manifest. See the module docs for its invariants.
#[derive(Debug, Clone)]
pub struct AppManifest {
    entry: usize,
    modules: Vec<ModuleSpec>,
}

#[derive(Debug, Clone)]
pub struct ModuleSpec {
    /// Component name used in templates (`Counter()`); its lowercased form
    /// is the engine state scope.
    pub name: ComponentName,
    /// Canonical path of the module's `.hypen` template.
    pub ui: PathBuf,
    pub kind: ModuleKind,
}

#[derive(Debug, Clone)]
pub enum ModuleKind {
    /// Logic in a `.wasm` component, with the capabilities app.json grants it.
    Stateful {
        /// Canonical path of the module's `.wasm`.
        wasm: PathBuf,
        capabilities: Capabilities,
    },
    /// A template-only building block (`Header()`, `Card()`): UI, no state,
    /// no actions, no wasm instance.
    Stateless,
}

/// What app.json grants one stateful module. Deny by default: a field left
/// out grants nothing (module-private `local` storage only).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Capabilities {
    /// Storage scopes granted beyond `local`.
    pub storage: Vec<StorageScope>,
    /// Sibling scopes whose state the module may read / subscribe to.
    pub reads: Vec<ScopeName>,
    /// Sibling scopes the module may dispatch to.
    pub dispatches: Vec<ScopeName>,
    /// Outbound HTTP: blocking `wasi:http` and deferred `hypen:http/deferred`.
    pub http: bool,
    /// `httpHosts`: the hosts `http` is limited to. Empty = any host.
    pub http_hosts: Vec<HostPattern>,
}

impl Capabilities {
    /// The host manifest for an instance registered under `scope`. A
    /// per-usage (synthetic) instance inherits its backing module's grants.
    pub fn to_manifest(&self, scope: &str) -> ModuleManifest {
        ModuleManifest {
            name: scope.to_string(),
            storage: self.storage.clone(),
            reads: self.reads.iter().map(|s| s.as_str().to_string()).collect(),
            dispatches: self.dispatches.iter().map(|s| s.as_str().to_string()).collect(),
            http: self.http,
            http_hosts: self.http_hosts.clone(),
            ..ModuleManifest::default()
        }
    }
}

impl ModuleSpec {
    pub fn is_stateful(&self) -> bool {
        matches!(self.kind, ModuleKind::Stateful { .. })
    }
}

/// What is wrong with one manifest field.
#[derive(Debug, thiserror::Error)]
pub enum ManifestProblem {
    #[error("{0}")]
    Name(#[from] NameError),
    #[error("duplicate module: `{name}` and `{other}` share the scope `{scope}` (scopes are case-insensitive)")]
    Duplicate { name: String, other: String, scope: String },
    #[error("the manifest lists no modules")]
    NoModules,
    #[error("entry module `{0}` is not in `modules`")]
    EntryNotListed(String),
    #[error("`{given}` cannot be resolved")]
    PathUnresolvable {
        given: String,
        #[source]
        source: std::io::Error,
    },
    #[error("`{given}` resolves to {}, outside the manifest directory {}", resolved.display(), root.display())]
    PathEscapes { given: String, resolved: PathBuf, root: PathBuf },
    #[error("`{given}` is not a file")]
    NotAFile { given: String },
    #[error("unknown storage scope `{0}` (expected local, app, or cloud)")]
    UnknownStorage(String),
    #[error("`{target}` is not a stateful module in this manifest")]
    UnknownTarget { target: String },
    #[error("stateless component `{module}` (no `wasm`) cannot be granted capabilities")]
    StatelessGrant { module: String },
    #[error("{0}")]
    HostPattern(#[from] InvalidHostPattern),
    #[error("`httpHosts` narrows the `http` grant, but `http` is not true for this module")]
    HostsWithoutHttp,
}

impl ManifestProblem {
    pub fn hint(&self) -> Option<String> {
        match self {
            ManifestProblem::PathEscapes { .. } => Some(
                "module files must live inside the manifest's directory; copy or build them \
                 there and use a relative path"
                    .to_string(),
            ),
            ManifestProblem::UnknownTarget { .. } => Some(
                "`reads` / `dispatches` take the names of modules listed in this manifest \
                 that have a `wasm`"
                    .to_string(),
            ),
            ManifestProblem::StatelessGrant { .. } => {
                Some("add a `wasm` for the module, or remove the capability fields".to_string())
            }
            ManifestProblem::HostPattern(_) => Some(
                "`httpHosts` entries look like \"api.example.com\", \"*.example.com\" or \
                 \"localhost:8080\"; leave the list out to allow any host"
                    .to_string(),
            ),
            ManifestProblem::HostsWithoutHttp => {
                Some("add `\"http\": true`, or remove `httpHosts`".to_string())
            }
            _ => None,
        }
    }
}

impl AppManifest {
    /// Read and validate the manifest at `path`.
    pub fn load(path: &Path) -> Result<Self, RuntimeError> {
        let source =
            std::fs::read_to_string(path).map_err(|e| RuntimeError::io("read", path, e))?;
        Self::parse(path, &source)
    }

    /// Validate manifest JSON that was read from `path` (paths in it are
    /// resolved against `path`'s directory).
    pub fn parse(path: &Path, source: &str) -> Result<Self, RuntimeError> {
        let raw: RawManifest = serde_json::from_str(source)
            .map_err(|source| RuntimeError::ManifestSyntax { path: path.to_path_buf(), source })?;
        let invalid = |field: String, problem: ManifestProblem| RuntimeError::Manifest {
            path: path.to_path_buf(),
            field,
            problem: Box::new(problem),
        };

        if raw.modules.is_empty() {
            return Err(invalid("modules".into(), ManifestProblem::NoModules));
        }

        let dir = match path.parent() {
            Some(p) if !p.as_os_str().is_empty() => p.to_path_buf(),
            _ => PathBuf::from("."),
        };
        let root = std::fs::canonicalize(&dir).map_err(|e| RuntimeError::io("resolve", &dir, e))?;

        // Names first: the capability targets below are checked against them.
        let mut names: Vec<ComponentName> = Vec::with_capacity(raw.modules.len());
        for (i, m) in raw.modules.iter().enumerate() {
            let field = format!("modules[{i}].name");
            let name = ComponentName::new(&m.name).map_err(|e| invalid(field.clone(), e.into()))?;
            if let Some(other) = names.iter().find(|n| n.scope() == name.scope()) {
                return Err(invalid(
                    field,
                    ManifestProblem::Duplicate {
                        name: name.to_string(),
                        other: other.to_string(),
                        scope: name.scope().to_string(),
                    },
                ));
            }
            names.push(name);
        }
        let stateful_scopes: Vec<ScopeName> = raw
            .modules
            .iter()
            .zip(&names)
            .filter(|(m, _)| m.wasm.is_some())
            .map(|(_, n)| n.scope())
            .collect();

        let mut modules = Vec::with_capacity(raw.modules.len());
        for (i, (m, name)) in raw.modules.iter().zip(names).enumerate() {
            let ui = confine(&root, &m.ui).map_err(|p| invalid(format!("modules[{i}].ui"), p))?;
            let kind = match &m.wasm {
                Some(wasm) => {
                    let wasm = confine(&root, wasm)
                        .map_err(|p| invalid(format!("modules[{i}].wasm"), p))?;
                    let capabilities = capabilities(m, i, &stateful_scopes)
                        .map_err(|(field, p)| invalid(field, p))?;
                    ModuleKind::Stateful { wasm, capabilities }
                }
                None => {
                    let grants_something = m.http == Some(true)
                        || [&m.storage, &m.reads, &m.dispatches, &m.http_hosts]
                            .iter()
                            .any(|list| list.as_ref().is_some_and(|l| !l.is_empty()));
                    if grants_something {
                        return Err(invalid(
                            format!("modules[{i}]"),
                            ManifestProblem::StatelessGrant { module: name.to_string() },
                        ));
                    }
                    ModuleKind::Stateless
                }
            };
            modules.push(ModuleSpec { name, ui, kind });
        }

        let entry = modules
            .iter()
            .position(|m| m.name.as_str() == raw.entry)
            .ok_or_else(|| {
                invalid("entry".into(), ManifestProblem::EntryNotListed(raw.entry.clone()))
            })?;

        Ok(AppManifest { entry, modules })
    }

    pub fn modules(&self) -> &[ModuleSpec] {
        &self.modules
    }

    /// The entry module — the root template that references the others.
    pub fn entry(&self) -> &ModuleSpec {
        // `entry` is an index found by `position` over `modules` in `parse`
        // and neither field is mutated afterwards.
        &self.modules[self.entry]
    }

    pub fn module(&self, name: &str) -> Option<&ModuleSpec> {
        self.modules.iter().find(|m| m.name.as_str() == name)
    }
}

/// Resolve a manifest-relative path and require it to be a file inside the
/// manifest directory. Canonicalising first means `..`, absolute paths and
/// symlinks are judged by where they actually lead.
fn confine(root: &Path, given: &str) -> Result<PathBuf, ManifestProblem> {
    let resolved = std::fs::canonicalize(root.join(given)).map_err(|source| {
        ManifestProblem::PathUnresolvable { given: given.to_string(), source }
    })?;
    if !resolved.starts_with(root) {
        return Err(ManifestProblem::PathEscapes {
            given: given.to_string(),
            resolved,
            root: root.to_path_buf(),
        });
    }
    if !resolved.is_file() {
        return Err(ManifestProblem::NotAFile { given: given.to_string() });
    }
    Ok(resolved)
}

fn capabilities(
    m: &RawModule,
    index: usize,
    stateful_scopes: &[ScopeName],
) -> Result<Capabilities, (String, ManifestProblem)> {
    let mut caps = Capabilities { http: m.http.unwrap_or(false), ..Capabilities::default() };

    for (j, s) in m.storage.iter().flatten().enumerate() {
        let scope = match s.to_lowercase().as_str() {
            "local" => StorageScope::Local,
            "app" => StorageScope::App,
            "cloud" => StorageScope::Cloud,
            _ => {
                return Err((
                    format!("modules[{index}].storage[{j}]"),
                    ManifestProblem::UnknownStorage(s.clone()),
                ));
            }
        };
        if !caps.storage.contains(&scope) {
            caps.storage.push(scope);
        }
    }

    let targets = |list: &Option<Vec<String>>,
                   key: &str|
     -> Result<Vec<ScopeName>, (String, ManifestProblem)> {
        let mut out: Vec<ScopeName> = Vec::new();
        for (j, t) in list.iter().flatten().enumerate() {
            let field = format!("modules[{index}].{key}[{j}]");
            let scope = ScopeName::new(t).map_err(|e| (field.clone(), e.into()))?;
            if !stateful_scopes.contains(&scope) {
                return Err((field, ManifestProblem::UnknownTarget { target: t.clone() }));
            }
            if !out.contains(&scope) {
                out.push(scope);
            }
        }
        Ok(out)
    };
    for (j, pattern) in m.http_hosts.iter().flatten().enumerate() {
        let pattern: HostPattern = pattern
            .parse()
            .map_err(|e: InvalidHostPattern| (format!("modules[{index}].httpHosts[{j}]"), e.into()))?;
        if !caps.http_hosts.contains(&pattern) {
            caps.http_hosts.push(pattern);
        }
    }
    if !caps.http_hosts.is_empty() && !caps.http {
        return Err((format!("modules[{index}].httpHosts"), ManifestProblem::HostsWithoutHttp));
    }

    caps.reads = targets(&m.reads, "reads")?;
    caps.dispatches = targets(&m.dispatches, "dispatches")?;
    Ok(caps)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A manifest directory with `app.hypen`, `counter.hypen`, `a.wasm`.
    fn app_dir() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        for f in ["app.hypen", "counter.hypen", "a.wasm"] {
            std::fs::write(dir.path().join(f), "x").expect("write fixture");
        }
        dir
    }

    fn parse(dir: &tempfile::TempDir, json: &str) -> Result<AppManifest, RuntimeError> {
        AppManifest::parse(&dir.path().join("app.json"), json)
    }

    /// The `(field, problem)` of an invalid manifest.
    fn problem(dir: &tempfile::TempDir, json: &str) -> (String, ManifestProblem) {
        match parse(dir, json) {
            Err(RuntimeError::Manifest { field, problem, .. }) => (field, *problem),
            other => panic!("expected an invalid-manifest error, got {other:?}"),
        }
    }

    const VALID: &str = r#"{ "entry": "App", "modules": [
        { "name": "App", "wasm": "a.wasm", "ui": "app.hypen",
          "storage": ["Cloud", "cloud"], "reads": ["Counter"], "dispatches": ["counter"], "http": true },
        { "name": "Counter", "wasm": "./a.wasm", "ui": "counter.hypen" },
        { "name": "Banner", "ui": "counter.hypen", "storage": [], "http": false }
    ] }"#;

    #[test]
    fn a_valid_manifest_becomes_the_domain_model() {
        let dir = app_dir();
        let m = parse(&dir, VALID).expect("valid manifest");
        assert_eq!(m.entry().name.as_str(), "App");
        assert_eq!(m.modules().len(), 3);

        let ModuleKind::Stateful { wasm, capabilities } = &m.entry().kind else {
            panic!("App is stateful");
        };
        let root = std::fs::canonicalize(dir.path()).unwrap();
        assert_eq!(*wasm, root.join("a.wasm"), "paths are canonical");
        assert_eq!(capabilities.storage, vec![StorageScope::Cloud], "case-insensitive, deduped");
        assert_eq!(capabilities.reads[0].as_str(), "counter", "targets are lowercased scopes");
        assert!(capabilities.http);

        let host = capabilities.to_manifest("app__a");
        assert_eq!(host.name, "app__a");
        assert_eq!(host.reads, vec!["counter"]);
        assert_eq!(host.dispatches, vec!["counter"]);
        assert!(host.http);

        // Omitted capability fields grant nothing.
        let ModuleKind::Stateful { capabilities, .. } = &m.module("Counter").unwrap().kind else {
            panic!("Counter is stateful");
        };
        assert_eq!(*capabilities, Capabilities::default());
        assert!(matches!(m.module("Banner").unwrap().kind, ModuleKind::Stateless));
        assert!(!m.module("Banner").unwrap().is_stateful());
    }

    #[test]
    fn syntax_errors_name_the_file() {
        let dir = app_dir();
        let err = parse(&dir, "{ not json").unwrap_err();
        assert!(matches!(err, RuntimeError::ManifestSyntax { .. }));
        assert!(err.to_string().contains("app.json"));
        // A missing required field is a syntax-level (serde) error too.
        assert!(matches!(
            parse(&dir, r#"{ "modules": [] }"#),
            Err(RuntimeError::ManifestSyntax { .. })
        ));
    }

    #[test]
    fn duplicate_names_are_rejected_case_insensitively() {
        let dir = app_dir();
        let (field, p) = problem(
            &dir,
            r#"{ "entry": "App", "modules": [
                { "name": "App", "ui": "app.hypen" },
                { "name": "APP", "ui": "counter.hypen" } ] }"#,
        );
        assert_eq!(field, "modules[1].name");
        assert!(matches!(p, ManifestProblem::Duplicate { ref scope, .. } if scope == "app"), "{p}");
    }

    #[test]
    fn unaddressable_names_are_rejected() {
        let dir = app_dir();
        for bad in ["a:b", "", "__hypen_x"] {
            let json = format!(
                r#"{{ "entry": "App", "modules": [
                    {{ "name": "App", "ui": "app.hypen" }},
                    {{ "name": "{bad}", "ui": "counter.hypen" }} ] }}"#
            );
            let (field, p) = problem(&dir, &json);
            assert_eq!(field, "modules[1].name");
            assert!(matches!(p, ManifestProblem::Name(_)), "{bad}: {p}");
        }
    }

    #[test]
    fn paths_are_confined_to_the_manifest_directory() {
        let outer = tempfile::tempdir().unwrap();
        std::fs::write(outer.path().join("secret.wasm"), "x").unwrap();
        let app = outer.path().join("app");
        std::fs::create_dir(&app).unwrap();
        std::fs::write(app.join("app.hypen"), "x").unwrap();
        let manifest = app.join("app.json");
        let escape = |wasm: &str| {
            let json = format!(
                r#"{{ "entry": "App", "modules": [ {{ "name": "App", "wasm": {}, "ui": "app.hypen" }} ] }}"#,
                serde_json::Value::String(wasm.to_string())
            );
            match AppManifest::parse(&manifest, &json) {
                Err(RuntimeError::Manifest { field, problem, .. }) => (field, *problem),
                other => panic!("expected an invalid-manifest error, got {other:?}"),
            }
        };

        // `..` out of the manifest directory.
        let (field, p) = escape("../secret.wasm");
        assert_eq!(field, "modules[0].wasm");
        assert!(matches!(p, ManifestProblem::PathEscapes { .. }), "{p}");
        assert!(p.hint().is_some());

        // An absolute path outside it.
        let abs = outer.path().join("secret.wasm");
        let (_, p) = escape(abs.to_str().unwrap());
        assert!(matches!(p, ManifestProblem::PathEscapes { .. }), "{p}");

        // A symlink inside the directory that leads outside it.
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&abs, app.join("link.wasm")).unwrap();
            let (_, p) = escape("link.wasm");
            assert!(matches!(p, ManifestProblem::PathEscapes { .. }), "{p}");
        }

        // A missing file, and a directory, are errors too.
        let (_, p) = escape("nope.wasm");
        assert!(matches!(p, ManifestProblem::PathUnresolvable { .. }), "{p}");
        let (_, p) = escape(".");
        assert!(matches!(p, ManifestProblem::NotAFile { .. }), "{p}");

        // `..` that stays inside is fine once resolved.
        std::fs::create_dir(app.join("sub")).unwrap();
        std::fs::write(app.join("ok.wasm"), "x").unwrap();
        let json = r#"{ "entry": "App", "modules": [ { "name": "App", "wasm": "sub/../ok.wasm", "ui": "app.hypen" } ] }"#;
        assert!(AppManifest::parse(&manifest, json).is_ok());
    }

    #[test]
    fn the_ui_path_is_confined_too() {
        let dir = app_dir();
        let (field, p) = problem(
            &dir,
            r#"{ "entry": "App", "modules": [ { "name": "App", "ui": "/etc/hostname" } ] }"#,
        );
        assert_eq!(field, "modules[0].ui");
        assert!(
            matches!(p, ManifestProblem::PathEscapes { .. } | ManifestProblem::PathUnresolvable { .. }),
            "{p}"
        );
    }

    #[test]
    fn the_entry_must_be_listed() {
        let dir = app_dir();
        let (field, p) = problem(
            &dir,
            r#"{ "entry": "Main", "modules": [ { "name": "App", "ui": "app.hypen" } ] }"#,
        );
        assert_eq!(field, "entry");
        assert!(matches!(p, ManifestProblem::EntryNotListed(ref n) if n == "Main"));

        let (field, p) = problem(&dir, r#"{ "entry": "App", "modules": [] }"#);
        assert_eq!(field, "modules");
        assert!(matches!(p, ManifestProblem::NoModules));
    }

    #[test]
    fn capability_targets_must_be_stateful_modules() {
        let dir = app_dir();
        // Unknown module.
        let (field, p) = problem(
            &dir,
            r#"{ "entry": "App", "modules": [
                { "name": "App", "wasm": "a.wasm", "ui": "app.hypen", "reads": ["ghost"] } ] }"#,
        );
        assert_eq!(field, "modules[0].reads[0]");
        assert!(matches!(p, ManifestProblem::UnknownTarget { .. }), "{p}");

        // A stateless component has no state to read or dispatch to.
        let (field, p) = problem(
            &dir,
            r#"{ "entry": "App", "modules": [
                { "name": "App", "wasm": "a.wasm", "ui": "app.hypen", "dispatches": ["Banner"] },
                { "name": "Banner", "ui": "counter.hypen" } ] }"#,
        );
        assert_eq!(field, "modules[0].dispatches[0]");
        assert!(matches!(p, ManifestProblem::UnknownTarget { .. }), "{p}");
    }

    #[test]
    fn storage_scopes_and_stateless_grants_are_checked() {
        let dir = app_dir();
        let (field, p) = problem(
            &dir,
            r#"{ "entry": "App", "modules": [
                { "name": "App", "wasm": "a.wasm", "ui": "app.hypen", "storage": ["app", "disk"] } ] }"#,
        );
        assert_eq!(field, "modules[0].storage[1]");
        assert!(matches!(p, ManifestProblem::UnknownStorage(ref s) if s == "disk"));

        let (field, p) = problem(
            &dir,
            r#"{ "entry": "App", "modules": [ { "name": "App", "ui": "app.hypen", "http": true } ] }"#,
        );
        assert_eq!(field, "modules[0]");
        assert!(matches!(p, ManifestProblem::StatelessGrant { .. }), "{p}");
    }

    #[test]
    fn http_hosts_are_parsed_once_and_need_the_http_grant() {
        use hypen_engine::module_host::HttpGrant;
        let dir = app_dir();
        let m = parse(
            &dir,
            r#"{ "entry": "App", "modules": [ { "name": "App", "wasm": "a.wasm", "ui": "app.hypen",
                 "http": true, "httpHosts": ["API.example.com", "*.example.com:8443", "api.example.com"] } ] }"#,
        )
        .expect("valid manifest");
        let ModuleKind::Stateful { capabilities, .. } = &m.entry().kind else { panic!("stateful") };
        let hosts: Vec<String> = capabilities.http_hosts.iter().map(ToString::to_string).collect();
        assert_eq!(hosts, ["api.example.com", "*.example.com:8443"], "canonical, deduped");
        let host = capabilities.to_manifest("app");
        assert_eq!(host.http_grant(), HttpGrant::Hosts(capabilities.http_hosts.clone()));

        let (field, p) = problem(
            &dir,
            r#"{ "entry": "App", "modules": [ { "name": "App", "wasm": "a.wasm", "ui": "app.hypen",
                 "http": true, "httpHosts": ["ok.test", "https://api.example.com/v1"] } ] }"#,
        );
        assert_eq!(field, "modules[0].httpHosts[1]");
        assert!(p.to_string().contains("drop the scheme"), "{p}");
        assert!(p.hint().is_some());

        let (field, p) = problem(
            &dir,
            r#"{ "entry": "App", "modules": [ { "name": "App", "wasm": "a.wasm", "ui": "app.hypen",
                 "httpHosts": ["api.example.com"] } ] }"#,
        );
        assert_eq!(field, "modules[0].httpHosts");
        assert!(matches!(p, ManifestProblem::HostsWithoutHttp), "{p}");

        let (_, p) = problem(
            &dir,
            r#"{ "entry": "App", "modules": [ { "name": "App", "ui": "app.hypen", "httpHosts": ["a.test"] } ] }"#,
        );
        assert!(matches!(p, ManifestProblem::StatelessGrant { .. }), "{p}");
    }
}
