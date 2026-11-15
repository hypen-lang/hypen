//! Hot reload: what a changed file means, and the watcher that notices.
//!
//! - A changed `.wasm` swaps the instance of **every scope currently backed
//!   by that file** — looked up in the live module table, so scopes minted
//!   after boot (per-usage instances added by a template edit) reload too.
//!   Engine state is preserved across the swap: the fresh instance is woken
//!   with `on_activated` instead of being re-`init`ed. (A *crashed* module
//!   has no state worth preserving and is restarted from its config.)
//! - A changed `.hypen` updates that template's source, re-plans per-usage
//!   instances in `--app` mode (minting any scope the edit introduced), and
//!   re-renders the entry. The reconcile delta is an out-of-band render: it
//!   updates the tree `GET /patches` serves and is pushed to SSE subscribers.
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

    /// React to a set of changed files (canonical paths).
    ///
    /// Each module swap takes the engine lock separately: registering a
    /// rebuilt component compiles it, which is slow, and requests should be
    /// able to interleave between modules rather than wait for all of them.
    /// A swap itself, and the whole template reload, are atomic.
    pub fn files_changed(&self, changed: &[PathBuf]) -> Vec<ReloadEvent> {
        let mut events = Vec::new();
        // The module table is read live, so scopes minted since boot are
        // included.
        let scopes: Vec<String> = self
            .core()
            .modules
            .iter()
            .filter(|m| changed.contains(&m.spec.wasm))
            .map(|m| m.spec.scope.clone())
            .collect();
        for scope in scopes {
            let mut core = self.core();
            let Some(index) = core.modules.iter().position(|m| m.spec.scope == scope) else {
                continue;
            };
            events.push(match core.reload_module(index) {
                Ok(()) => ReloadEvent::ModuleReloaded { scope },
                Err(error) => ReloadEvent::ModuleReloadFailed { scope, error },
            });
        }
        self.core().reload_templates(changed, &mut events);
        events
    }
}

impl Core {
    /// Re-register the module's bytes, bring up a fresh instance, re-wire
    /// the engine's routing to it (state untouched), destroy the old
    /// instance, and wake the new one with `on_activated`.
    fn reload_module(&mut self, index: usize) -> Result<(), RuntimeError> {
        let spec = self.modules[index].spec.clone();
        self.register_component(&spec)?;
        if self.modules[index].health == Health::Crashed {
            // Nothing to preserve: restart from config on the new bytes.
            return self.restart(index);
        }

        let scope = spec.scope.as_str();
        let surface = self.surface;
        let stage = |stage| {
            move |source| RuntimeError::Module {
                scope: scope.to_string(),
                stage,
                surface,
                source,
            }
        };
        let host = self
            .engine
            .module_host_mut()
            .ok_or(RuntimeError::Internal("no module host installed"))?;
        let new_id = host.instantiate(scope).map_err(stage(ModuleStage::Instantiate))?;

        // Re-query the rebuilt module's actions so adding or removing one
        // takes effect without a restart; keep the previous list if the query
        // fails or comes back empty. An `--actions` override stays in force.
        let actions = match &spec.actions {
            ActionSource::Override(list) => list.clone(),
            ActionSource::Discover => host
                .actions(new_id)
                .ok()
                .filter(|a| !a.is_empty())
                .unwrap_or_else(|| self.modules[index].actions.clone()),
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
        self.modules[index].actions = actions;

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

        self.replan(events);
        events.push(match self.render_entry() {
            Ok(()) => ReloadEvent::Rerendered { entry },
            Err(error) => ReloadEvent::RerenderFailed { error },
        });
    }

    /// App mode: re-run per-usage planning over the updated templates, mint
    /// any scope the edit introduced, and hand the engine the freshly
    /// rewritten sources.
    ///
    /// A usage that was removed keeps its instance alive (harmless — nothing
    /// references it; a restart compacts).
    fn replan(&mut self, events: &mut Vec<ReloadEvent>) {
        let Some(app) = self.ui.as_ref().and_then(|ui| ui.app.as_ref()) else {
            return;
        };
        let plan = plan_usages(&app.manifest, &app.raw);
        let fresh: Vec<_> = plan
            .instances
            .iter()
            .filter(|i| !self.modules.iter().any(|m| m.spec.scope == i.scope))
            .map(|i| (i.scope.clone(), i.config.clone(), instance_spec(&app.manifest, i)))
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

/// Watch every file [`Runtime::watch_paths`] names and feed real changes to
/// [`Runtime::files_changed`], logging what happened. The returned handle
/// must be kept alive for as long as watching should continue.
pub fn spawn_watcher(
    runtime: Arc<Runtime>,
) -> Result<Option<Debouncer<RecommendedWatcher>>, RuntimeError> {
    let paths = runtime.watch_paths();
    if paths.is_empty() {
        return Ok(None);
    }

    let on_change = Arc::clone(&runtime);
    let filter = Mutex::new(ChangeFilter::new(&paths));
    let mut debouncer = new_debouncer(DEBOUNCE, move |result: DebounceEventResult| match result {
        Err(e) => eprintln!("[reload] watch error: {e}"),
        Ok(events) => {
            let reported = events.iter().map(|e| canonical(&e.path));
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

    for path in &paths {
        debouncer
            .watcher()
            .watch(path, RecursiveMode::NonRecursive)
            .map_err(|source| RuntimeError::Watch { path: path.clone(), source })?;
    }
    eprintln!("[reload] watching {} file(s) ({}ms debounce)", paths.len(), DEBOUNCE.as_millis());
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

    #[test]
    fn reload_events_render_as_log_lines() {
        let event = ReloadEvent::ModuleReloaded { scope: "counter__a".into() };
        assert_eq!(event.to_string(), "counter__a reloaded");
        let event = ReloadEvent::MintFailed {
            scope: "counter__b".into(),
            error: RuntimeError::Internal("x"),
        };
        assert_eq!(event.to_string(), "minting `counter__b` failed: internal error: x");
        let event = ReloadEvent::ScopeMinted {
            scope: "counter__a".into(),
            config: serde_json::json!({ "start": 5 }),
        };
        assert_eq!(event.to_string(), "minted usage scope `counter__a` (config {\"start\":5})");
    }
}
