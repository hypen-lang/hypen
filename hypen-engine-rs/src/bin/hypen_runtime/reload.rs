//! Hot reload: what a changed file means, and the watcher that notices.
//!
//! - A changed `.wasm` swaps the instance of **every scope currently backed
//!   by that file** — looked up in the live module table, so scopes minted
//!   after boot (per-usage instances added by a template edit) reload too.
//!   Engine state is preserved across the swap: the fresh instance is woken
//!   with `on_activated` instead of being re-`init`ed. (A *crashed* module
//!   has no state worth preserving and is restarted from its config.)
//!   The rebuilt component is compiled **before** the engine lock is taken
//!   (once, however many scopes the file backs), so requests keep being
//!   served while a large module compiles; only the swap itself is locked.
//! - A changed `.hypen` updates that template's source, re-plans per-usage
//!   instances in `--app` mode, and re-renders the entry. The reconcile
//!   delta is an out-of-band render: it updates the tree `GET /patches`
//!   serves and is pushed to SSE subscribers. The re-plan mints any scope
//!   the edit introduced and, once the new templates are rendered, **retires
//!   every per-usage scope no template references any more**: its
//!   `on_destroyed` runs, the engine forgets the scope and the host instance
//!   is destroyed. (If the re-render fails, the old tree is still on screen
//!   and still uses those scopes, so they are kept until an edit renders.)
//! - In single-module mode (`--ui`), the template's root declaration is also
//!   the module's `init` config (`module Counter(start: 5)`). When an edit
//!   changes that config the module is **re-seeded**: restarted with a fresh
//!   instance and `init(new config)`, its previous state dropped — the same
//!   thing `--app` mode does when a usage's config changes (it mints a fresh
//!   instance for the new config and retires the old one). An edit that
//!   leaves the config alone keeps the instance and its state.
//!
//! ## What is watched
//!
//! The **directories** containing the files, not the files. Build tools
//! replace a `.wasm` by writing a temporary file and renaming it over the
//! old one; a watch on the file itself follows the old inode and goes
//! silent after the first such rebuild. Events from a watched directory are
//! filtered down to the paths that mean something — read from the live
//! module table each time, so the `.wasm` of a scope minted after boot is
//! covered too (as long as it lives in an already-watched directory, which
//! `--app`'s "inside the manifest directory" rule makes the common case).
//!
//! The OS watcher reports *opens* as well as writes, and reloading a file
//! reads it — so every reload would echo back as a new "change" and reload
//! again, forever. [`ChangeFilter`] breaks the loop: an event only counts if
//! the file's modification time or size actually moved.

use std::collections::HashMap;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use hypen_engine::ModuleGrants;
use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};

use crate::app::{canonical, instance_spec, plan_usages, Core, Health, Runtime};
use crate::template;
use crate::cli::ActionSource;
use crate::error::{one_line, ModuleStage, RuntimeError};
use crate::sync::lock;

const DEBOUNCE: Duration = Duration::from_millis(200);

/// One thing a batch of file changes caused.
#[derive(Debug)]
pub enum ReloadEvent {
    ModuleReloaded { scope: String },
    ModuleReloadFailed { scope: String, error: RuntimeError },
    TemplateUpdated { name: String },
    TemplateReadFailed { name: String, error: RuntimeError },
    ScopeMinted { scope: String, config: serde_json::Value },
    MintFailed { scope: String, error: RuntimeError },
    /// A per-usage scope no template references any more was torn down.
    ScopeRetired { scope: String },
    /// It was torn down, but its `on_destroyed` hook (or the host) objected.
    ScopeRetiredWithError { scope: String, error: RuntimeError },
    /// Single-module mode: the template's declaration config changed, so the
    /// module was restarted with it.
    ModuleReseeded { scope: String, config: serde_json::Value },
    ModuleReseedFailed { scope: String, error: RuntimeError },
    Rerendered { entry: String },
    RerenderFailed { error: RuntimeError },
}

impl fmt::Display for ReloadEvent {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ReloadEvent::ModuleReloaded { scope } => write!(f, "{scope} reloaded"),
            ReloadEvent::ModuleReloadFailed { scope, error } => {
                write!(f, "{scope} failed: {}", one_line(error))
            }
            ReloadEvent::TemplateUpdated { name } => write!(f, "ui {name} updated"),
            ReloadEvent::TemplateReadFailed { name, error } => {
                write!(f, "ui {name} read failed: {}", one_line(error))
            }
            ReloadEvent::ScopeMinted { scope, config } => {
                write!(f, "minted usage scope `{scope}` (config {config})")
            }
            ReloadEvent::MintFailed { scope, error } => {
                write!(f, "minting `{scope}` failed: {}", one_line(error))
            }
            ReloadEvent::ScopeRetired { scope } => {
                write!(f, "retired usage scope `{scope}` (no template references it)")
            }
            ReloadEvent::ScopeRetiredWithError { scope, error } => {
                write!(f, "retired usage scope `{scope}`; its teardown failed: {}", one_line(error))
            }
            ReloadEvent::ModuleReseeded { scope, config } => write!(
                f,
                "`{scope}` re-initialised: its declaration config changed to {config} \
                 (previous state dropped)"
            ),
            ReloadEvent::ModuleReseedFailed { scope, error } => write!(
                f,
                "`{scope}` could not be re-initialised with its new declaration config \
                 (it keeps running with the old one): {}",
                one_line(error)
            ),
            ReloadEvent::Rerendered { entry } => write!(f, "ui re-rendered (entry `{entry}`)"),
            ReloadEvent::RerenderFailed { error } => {
                write!(f, "ui re-render failed: {}", one_line(error))
            }
        }
    }
}

impl Runtime {
    /// Every file whose change means something: each module's `.wasm` and
    /// each template, deduplicated.
    pub fn watch_paths(&self) -> Vec<PathBuf> {
        let core = self.core();
        let mut paths: Vec<PathBuf> = Vec::new();
        let wasm = core.modules.iter().map(|m| &m.spec.wasm);
        let templates = core.ui.iter().flat_map(|ui| ui.files.iter().map(|f| &f.path));
        for path in wasm.chain(templates) {
            if !paths.contains(path) {
                paths.push(path.clone());
            }
        }
        paths
    }

    /// The directories to watch so that every path in
    /// [`watch_paths`](Self::watch_paths) is covered, deduplicated.
    pub fn watch_dirs(&self) -> Vec<PathBuf> {
        let mut dirs: Vec<PathBuf> = Vec::new();
        for path in self.watch_paths() {
            let dir = match path.parent() {
                Some(dir) if !dir.as_os_str().is_empty() => dir.to_path_buf(),
                _ => PathBuf::from("."),
            };
            if !dirs.contains(&dir) {
                dirs.push(dir);
            }
        }
        dirs
    }

    /// React to a set of changed files (canonical paths).
    ///
    /// Each changed `.wasm` is read and compiled first, **without the engine
    /// lock**: compiling a large component takes seconds, and dispatches and
    /// timers must not wait behind it. Each module swap then takes the lock
    /// separately (registering finds the bytes already compiled), so requests
    /// interleave between modules too. A swap itself, and the whole template
    /// reload, are atomic.
    pub fn files_changed(&self, changed: &[PathBuf]) -> Vec<ReloadEvent> {
        let mut events = Vec::new();
        // The module table is read live, so scopes minted since boot are
        // included.
        let mut by_file: Vec<(PathBuf, Vec<String>)> = Vec::new();
        for module in self.core().modules.iter().filter(|m| changed.contains(&m.spec.wasm)) {
            let scope = module.spec.scope.clone();
            match by_file.iter_mut().find(|(file, _)| *file == module.spec.wasm) {
                Some((_, scopes)) => scopes.push(scope),
                None => by_file.push((module.spec.wasm.clone(), vec![scope])),
            }
        }
        for (file, scopes) in by_file {
            let bytes = match std::fs::read(&file) {
                Ok(bytes) => bytes,
                Err(e) => {
                    let kind = e.kind();
                    for scope in scopes {
                        // One OS error cannot be cloned; rebuild it per scope.
                        let error =
                            RuntimeError::io("read", &file, std::io::Error::new(kind, e.to_string()));
                        events.push(ReloadEvent::ModuleReloadFailed { scope, error });
                    }
                    continue;
                }
            };
            // Kept until every scope of this file has registered, so they
            // all find the code compiled. A compile error is not reported
            // here: each scope's `register` reports it with its own name.
            let _precompiled = self
                .compiler()
                .and_then(|compiler| compiler.precompile(&file.display().to_string(), &bytes).ok());
            for scope in scopes {
                let mut core = self.core();
                let Some(index) = core.modules.iter().position(|m| m.spec.scope == scope) else {
                    continue;
                };
                events.push(match core.reload_module(index, &bytes) {
                    Ok(()) => ReloadEvent::ModuleReloaded { scope },
                    Err(error) => ReloadEvent::ModuleReloadFailed { scope, error },
                });
            }
        }
        self.core().reload_templates(changed, &mut events);
        events
    }
}

impl Core {
    /// Re-register the module from `bytes` (its rebuilt `.wasm`), bring up a
    /// fresh instance, re-wire the engine's routing to it (state untouched),
    /// destroy the old instance, and wake the new one with `on_activated`.
    fn reload_module(&mut self, index: usize, bytes: &[u8]) -> Result<(), RuntimeError> {
        let Some(module) = self.modules.get(index) else {
            return Err(RuntimeError::Internal("reload of an unknown module"));
        };
        let spec = module.spec.clone();
        let crashed = module.health == Health::Crashed;
        let previous_actions = module.actions.clone();
        self.register_bytes(&spec, bytes)?;
        if crashed {
            // Nothing to preserve: restart from config on the new bytes.
            return self.restart(index);
        }

        let scope = spec.scope.as_str();
        let host = self
            .engine
            .module_host_mut()
            .ok_or(RuntimeError::Internal("no module host installed"))?;
        let new_id = match host.instantiate(scope) {
            Ok(id) => id,
            Err(e) => return Err(self.module_error(&spec, ModuleStage::Instantiate, e)),
        };
        let host = self
            .engine
            .module_host_mut()
            .ok_or(RuntimeError::Internal("no module host installed"))?;

        // Re-query the rebuilt module's actions so adding or removing one
        // takes effect without a restart; keep the previous list if the query
        // fails or comes back empty. An `--actions` override stays in force.
        let actions = match &spec.actions {
            ActionSource::Override(list) => list.clone(),
            ActionSource::Discover => host
                .actions(new_id)
                .ok()
                .filter(|a| !a.is_empty())
                .unwrap_or(previous_actions),
        };

        // Wire the new instance before destroying the old one. If wiring
        // fails the old instance stays in charge and the new one is freed.
        let old_id = self.engine.module_instance_id(scope);
        if let Err(source) = self.engine.rewire_module_instance(
            scope,
            new_id,
            actions.clone(),
            ModuleGrants::from(&spec.manifest),
        ) {
            if let Some(host) = self.engine.module_host_mut() {
                let _ = host.destroy(new_id);
            }
            return Err(RuntimeError::Engine {
                scope: scope.to_string(),
                context: "cannot re-wire the reloaded module",
                source,
            });
        }
        if let (Some(old), Some(host)) = (old_id, self.engine.module_host_mut()) {
            if old != new_id {
                let _ = host.destroy(old);
            }
        }
        if let Some(module) = self.modules.get_mut(index) {
            module.actions = actions;
        }

        // Wake the fresh instance with the preserved state; this is also
        // where it re-registers cross-module subscriptions (the rewire
        // dropped the old instance's).
        self.activate(scope);
        Ok(())
    }

    /// Pick up changed templates, re-plan (app mode) and re-render.
    fn reload_templates(&mut self, changed: &[PathBuf], events: &mut Vec<ReloadEvent>) {
        let Some(ui) = self.ui.as_mut() else {
            return;
        };
        let mut any = false;
        for file in &ui.files {
            if !changed.contains(&file.path) {
                continue;
            }
            match std::fs::read_to_string(&file.path) {
                Ok(source) => {
                    match ui.app.as_mut() {
                        // App mode keeps the pristine source; the re-plan
                        // below produces what the engine sees.
                        Some(app) => {
                            app.raw.insert(file.name.clone(), source);
                        }
                        None => ui.sources.set(&file.name, source),
                    }
                    any = true;
                    events.push(ReloadEvent::TemplateUpdated { name: file.name.clone() });
                }
                Err(e) => events.push(ReloadEvent::TemplateReadFailed {
                    name: file.name.clone(),
                    error: RuntimeError::io("read", &file.path, e),
                }),
            }
        }
        if !any {
            return;
        }
        let entry = ui.entry.clone();

        self.reseed_from_declaration(events);
        let unreferenced = self.replan(events);
        match self.render_entry() {
            Ok(()) => {
                events.push(ReloadEvent::Rerendered { entry });
                // Only now does nothing on screen use them.
                for scope in unreferenced {
                    events.push(self.retire(&scope));
                }
            }
            // The old tree is still rendered and still bound to those
            // scopes: keep them. The next edit that renders retires them.
            Err(error) => events.push(ReloadEvent::RerenderFailed { error }),
        }
    }

    /// Single-module mode: if the edited template's root declaration now
    /// carries a different `init` config, restart the module with it (see
    /// the module docs). A template that does not parse is left to the
    /// re-render to report.
    fn reseed_from_declaration(&mut self, events: &mut Vec<ReloadEvent>) {
        let Some(ui) = self.ui.as_ref().filter(|ui| ui.app.is_none()) else {
            return;
        };
        let Some(source) = ui.sources.get(&ui.entry) else {
            return;
        };
        let Ok(root) = template::first_component(&source, &ui.entry) else {
            return;
        };
        let config = serde_json::Value::Object(template::declaration_config(&root));
        // Single-module mode hosts exactly one module: the template's.
        let [module] = self.modules.as_mut_slice() else {
            return;
        };
        if module.spec.config == config {
            return;
        }
        let scope = module.spec.scope.clone();
        let previous = std::mem::replace(&mut module.spec.config, config.clone());
        events.push(match self.restart(0) {
            Ok(()) => ReloadEvent::ModuleReseeded { scope, config },
            Err(error) => {
                // The old instance is still wired and running with the old
                // config; keep the spec truthful so a later edit retries.
                if let Some(module) = self.modules.first_mut() {
                    module.spec.config = previous;
                }
                ReloadEvent::ModuleReseedFailed { scope, error }
            }
        });
    }

    /// App mode: re-run per-usage planning over the updated templates, mint
    /// any scope the edit introduced, and hand the engine the freshly
    /// rewritten sources.
    ///
    /// Returns the hosted scopes the new plan no longer contains — usage
    /// sites the edit removed — for the caller to [`retire`](Self::retire)
    /// once the new templates are rendered.
    fn replan(&mut self, events: &mut Vec<ReloadEvent>) -> Vec<String> {
        let Some(app) = self.ui.as_ref().and_then(|ui| ui.app.as_ref()) else {
            return Vec::new();
        };
        let plan = plan_usages(&app.manifest, &app.raw);
        let fresh: Vec<_> = plan
            .instances
            .iter()
            .filter(|i| !self.modules.iter().any(|m| m.spec.scope == i.scope))
            .map(|i| (i.scope.clone(), i.config.clone(), instance_spec(&app.manifest, i)))
            .collect();
        // The entry is the app itself: never retired, whatever the plan says.
        let entry_scope = app.manifest.entry().name.scope().as_str().to_string();
        let unreferenced: Vec<String> = self
            .modules
            .iter()
            .map(|m| &m.spec.scope)
            .filter(|scope| **scope != entry_scope)
            .filter(|scope| !plan.instances.iter().any(|i| i.scope == **scope))
            .cloned()
            .collect();

        for (scope, config, spec) in fresh {
            // Best effort per instance: one bad usage does not take down the
            // rest of the reload.
            let minted = spec.and_then(|spec| self.mint(spec));
            events.push(match minted {
                Ok(()) => {
                    self.activate(&scope);
                    ReloadEvent::ScopeMinted { scope, config }
                }
                Err(error) => ReloadEvent::MintFailed { scope, error },
            });
        }
        if let Some(ui) = &self.ui {
            ui.sources.replace(plan.sources);
        }
        unreferenced
    }

    /// Tear down a hosted scope nothing references: run its `on_destroyed`,
    /// remove it from the engine (state, routing, subscriptions), destroy
    /// the host instance and forget the module. The teardown always
    /// completes; a failing hook or host is reported, not obeyed.
    fn retire(&mut self, scope: &str) -> ReloadEvent {
        let id = self.engine.module_instance_id(scope);
        // Runs `on_destroyed`, then unwires the scope whether or not the
        // hook succeeded.
        let hook = self.engine.destroy_module(scope);
        let destroyed = match (id, self.engine.module_host_mut()) {
            (Some(id), Some(host)) => host.destroy(id),
            _ => Ok(()),
        };
        let spec = self
            .modules
            .iter()
            .position(|m| m.spec.scope == scope)
            .map(|index| self.modules.remove(index).spec);

        let scope = scope.to_string();
        if let Err(source) = hook {
            let error = RuntimeError::Engine {
                scope: scope.clone(),
                context: "on_destroyed failed while retiring the scope",
                source,
            };
            return ReloadEvent::ScopeRetiredWithError { scope, error };
        }
        match (destroyed, spec) {
            // A crashed instance is already gone from the host's point of
            // view only after `destroy`; `DeadInstance` here means there was
            // nothing left to free.
            (Err(source), Some(spec))
                if !matches!(source, hypen_engine::module_host::HostError::DeadInstance) =>
            {
                let error = self.module_error(&spec, ModuleStage::Destroy, source);
                ReloadEvent::ScopeRetiredWithError { scope, error }
            }
            _ => ReloadEvent::ScopeRetired { scope },
        }
    }
}

/// What we last saw of a watched file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Fingerprint {
    modified: SystemTime,
    len: u64,
}

impl Fingerprint {
    /// `None` while the file cannot be stat'ed (e.g. mid-replace by a build).
    fn of(path: &Path) -> Option<Self> {
        let meta = std::fs::metadata(path).ok()?;
        Some(Fingerprint { modified: meta.modified().ok()?, len: meta.len() })
    }
}

/// Separates real file changes from watcher noise (see the module docs).
#[derive(Debug, Default)]
struct ChangeFilter {
    seen: HashMap<PathBuf, Fingerprint>,
}

impl ChangeFilter {
    /// Start from the files' current state: only later changes count.
    fn new(paths: &[PathBuf]) -> Self {
        let seen = paths
            .iter()
            .filter_map(|p| Some((p.clone(), Fingerprint::of(p)?)))
            .collect();
        ChangeFilter { seen }
    }

    /// The paths among `reported` whose content actually changed since they
    /// were last seen, each once.
    fn changed(&mut self, reported: impl IntoIterator<Item = PathBuf>) -> Vec<PathBuf> {
        let mut changed: Vec<PathBuf> = Vec::new();
        for path in reported {
            // A file that is momentarily gone is not a change yet; its
            // reappearance will be.
            let Some(now) = Fingerprint::of(&path) else {
                continue;
            };
            if self.seen.get(&path) == Some(&now) {
                continue;
            }
            self.seen.insert(path.clone(), now);
            if !changed.contains(&path) {
                changed.push(path);
            }
        }
        changed
    }
}

/// The paths among `reported` (canonical) that are files the runtime cares
/// about right now. A directory watch reports every entry of the directory —
/// editor swap files, a build tool's temporaries, unrelated assets.
fn relevant(reported: impl IntoIterator<Item = PathBuf>, watched: &[PathBuf]) -> Vec<PathBuf> {
    let mut relevant: Vec<PathBuf> = Vec::new();
    for path in reported {
        if watched.contains(&path) && !relevant.contains(&path) {
            relevant.push(path);
        }
    }
    relevant
}

/// Watch the directories of every file [`Runtime::watch_paths`] names and
/// feed real changes to those files to [`Runtime::files_changed`], logging
/// what happened (see the module docs for why directories). The returned
/// handle must be kept alive for as long as watching should continue.
pub fn spawn_watcher(
    runtime: Arc<Runtime>,
) -> Result<Option<Debouncer<RecommendedWatcher>>, RuntimeError> {
    let paths = runtime.watch_paths();
    let dirs = runtime.watch_dirs();
    if dirs.is_empty() {
        return Ok(None);
    }

    let on_change = Arc::clone(&runtime);
    let filter = Mutex::new(ChangeFilter::new(&paths));
    let mut debouncer = new_debouncer(DEBOUNCE, move |result: DebounceEventResult| match result {
        Err(e) => eprintln!("[reload] watch error: {e}"),
        Ok(events) => {
            // Read live: a template edit may have minted or retired scopes.
            let watched = on_change.watch_paths();
            let reported = relevant(events.iter().map(|e| canonical(&e.path)), &watched);
            let changed = lock(&filter, "reload filter").changed(reported);
            if changed.is_empty() {
                return;
            }
            for event in on_change.files_changed(&changed) {
                eprintln!("[reload] {event}");
            }
        }
    })
    .map_err(|source| RuntimeError::Watch { path: PathBuf::from("."), source })?;

    for dir in &dirs {
        debouncer
            .watcher()
            .watch(dir, RecursiveMode::NonRecursive)
            .map_err(|source| RuntimeError::Watch { path: dir.clone(), source })?;
    }
    eprintln!(
        "[reload] watching {} file(s) in {} director{} ({}ms debounce)",
        paths.len(),
        dirs.len(),
        if dirs.len() == 1 { "y" } else { "ies" },
        DEBOUNCE.as_millis()
    );
    Ok(Some(debouncer))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Rewrite `path` and force its mtime forward, so the test does not
    /// depend on filesystem timestamp granularity.
    fn rewrite(path: &Path, contents: &str, age: Duration) {
        std::fs::write(path, contents).unwrap();
        let file = std::fs::OpenOptions::new().write(true).open(path).unwrap();
        file.set_modified(SystemTime::UNIX_EPOCH + age).unwrap();
    }

    /// The reload loop: reloading a file reads it, the watcher reports the
    /// read, and that must not count as a change.
    #[test]
    fn reads_and_repeated_events_are_not_changes() {
        let dir = tempfile::tempdir().unwrap();
        let wasm = dir.path().join("a.wasm");
        rewrite(&wasm, "v1", Duration::from_secs(1_000));
        let mut filter = ChangeFilter::new(std::slice::from_ref(&wasm));

        // Events with nothing changed on disk (an open, a read).
        assert!(filter.changed([wasm.clone()]).is_empty());
        let _ = std::fs::read(&wasm).unwrap();
        assert!(filter.changed([wasm.clone(), wasm.clone()]).is_empty());

        // A real rewrite — even with identical bytes — is a change, once.
        rewrite(&wasm, "v1", Duration::from_secs(2_000));
        assert_eq!(filter.changed([wasm.clone(), wasm.clone()]), vec![wasm.clone()]);
        // …and the reload's own read of it is not another one.
        let _ = std::fs::read(&wasm).unwrap();
        assert!(filter.changed([wasm.clone()]).is_empty());

        // Same mtime, different size still counts.
        rewrite(&wasm, "v2-longer", Duration::from_secs(2_000));
        assert_eq!(filter.changed([wasm.clone()]), vec![wasm.clone()]);
    }

    #[test]
    fn vanished_files_wait_for_their_return_and_new_files_count_once() {
        let dir = tempfile::tempdir().unwrap();
        let wasm = dir.path().join("a.wasm");
        rewrite(&wasm, "v1", Duration::from_secs(1_000));
        let mut filter = ChangeFilter::new(std::slice::from_ref(&wasm));

        // Mid-replace by a build: gone for a moment.
        std::fs::remove_file(&wasm).unwrap();
        assert!(filter.changed([wasm.clone()]).is_empty());
        rewrite(&wasm, "v2", Duration::from_secs(3_000));
        assert_eq!(filter.changed([wasm.clone()]), vec![wasm.clone()]);

        // A file the filter has never seen is a change the first time.
        let other = dir.path().join("b.hypen");
        rewrite(&other, "x", Duration::from_secs(1_000));
        assert_eq!(filter.changed([other.clone()]), vec![other.clone()]);
        assert!(filter.changed([other]).is_empty());
    }

    /// A directory watch reports everything in the directory; only the
    /// files the runtime hosts count, each once.
    #[test]
    fn directory_events_are_filtered_to_the_watched_files() {
        let watched = [PathBuf::from("/app/a.wasm"), PathBuf::from("/app/app.hypen")];
        let reported = [
            "/app/a.wasm.tmp123",
            "/app/a.wasm",
            "/app/.app.hypen.swp",
            "/app/a.wasm",
            "/app/notes.txt",
            "/elsewhere/a.wasm",
        ]
        .map(PathBuf::from);
        assert_eq!(relevant(reported, &watched), vec![PathBuf::from("/app/a.wasm")]);
        assert!(relevant([PathBuf::from("/app/a.wasm")], &[]).is_empty());
    }

    /// The way build tools write: a temporary file renamed over the old one.
    /// The path now names a new inode; the filter sees a change exactly once.
    #[test]
    fn a_file_replaced_by_rename_is_one_change() {
        let dir = tempfile::tempdir().unwrap();
        let wasm = dir.path().join("a.wasm");
        rewrite(&wasm, "v1", Duration::from_secs(1_000));
        let mut filter = ChangeFilter::new(std::slice::from_ref(&wasm));

        let tmp = dir.path().join("a.wasm.tmp");
        rewrite(&tmp, "v2", Duration::from_secs(2_000));
        std::fs::rename(&tmp, &wasm).unwrap();
        // The directory watch reports both names; only the watched one counts.
        let reported = relevant([tmp.clone(), wasm.clone()], std::slice::from_ref(&wasm));
        assert_eq!(filter.changed(reported), vec![wasm.clone()]);
        assert!(filter.changed([wasm.clone()]).is_empty());
        assert_eq!(std::fs::read_to_string(&wasm).unwrap(), "v2");
    }

    #[test]
    fn reload_events_render_as_log_lines() {
        let event = ReloadEvent::ModuleReloaded { scope: "counter__a".into() };
        assert_eq!(event.to_string(), "counter__a reloaded");
        let event = ReloadEvent::MintFailed {
            scope: "counter__b".into(),
            error: RuntimeError::Internal("x"),
        };
        assert_eq!(event.to_string(), "minting `counter__b` failed: internal error: x");
        let event = ReloadEvent::ScopeRetired { scope: "counter__a".into() };
        assert_eq!(
            event.to_string(),
            "retired usage scope `counter__a` (no template references it)"
        );
        let event = ReloadEvent::ModuleReseeded {
            scope: "seeded".into(),
            config: serde_json::json!({ "start": 9 }),
        };
        assert_eq!(
            event.to_string(),
            "`seeded` re-initialised: its declaration config changed to {\"start\":9} \
             (previous state dropped)"
        );
        let event = ReloadEvent::ScopeMinted {
            scope: "counter__a".into(),
            config: serde_json::json!({ "start": 5 }),
        };
        assert_eq!(event.to_string(), "minted usage scope `counter__a` (config {\"start\":5})");
    }
}
