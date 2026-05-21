//! `BrowserModule` — the `HypenModule` the desktop renderer drives.
//!
//! Composes many engines into one window:
//!
//! * **shell** — a local Rust module (`ShellState`) that renders the
//!   home screen and the floating island chrome (URL bar, tab strip,
//!   refresh / home buttons).
//! * **per-tab apps** — each open tab owns a `RemoteModule` that
//!   streams patches from a `RemoteServer` over WebSocket.
//!
//! Per-engine patches arrive on separate callbacks; we merge them
//! into the single stream the renderer expects:
//!
//! 1. **Namespacing IDs.** Shell IDs pass through verbatim. Each tab
//!    gets a unique numeric prefix (`a1:`, `a2:`, …) so a node in tab
//!    1 can never collide with a same-id node in tab 2 or the shell.
//! 2. **Re-rooting the active tab.** A tab's `Insert { parent_id:
//!    "root" }` is rewritten to point at the shell's viewport
//!    Container. Inactive tabs' patches don't reach the renderer at
//!    all — they're discarded until the user switches to that tab
//!    (which closes + reopens the tab's WebSocket).
//! 3. **Routing actions.** Action names in `SHELL_ACTIONS` (plus
//!    `__hypen_bind` for shell-owned paths) go to the shell; the
//!    rest go to the active tab's remote.
//!
//! Switching tabs is implemented as
//! `stop_remote(old_tab) → start_remote(new_tab)` — the new tab
//! reconnects rather than being kept alive in the background. This
//! keeps the implementation small in v1; per-tab patch journaling for
//! suspend / resume can land later.

use crate::shell::{
    build_shell_module, push_recents, push_tabs, ShellCommand, ShellState, TabInfo,
    SHELL_ACTIONS, SHELL_BIND_PATHS,
};
use crate::storage::Storage;
use hypen_engine::Patch;
use hypen_renderer_desktop::{ConnectionStatus, HypenModule, RemoteModule};
use hypen_server::prelude::*;
use indexmap::IndexMap;
use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

/// `"root"` is the synthetic parent ID used by every engine.
const ROOT_ID: &str = "root";

type PatchCallback = Arc<dyn Fn(&[Patch]) + Send + Sync>;

/// One open tab as tracked by the wrapper. The mirror of [`TabInfo`]
/// in the shell, plus the `RemoteModule` that owns the WebSocket and
/// the per-tab patch-routing bookkeeping.
struct Tab {
    info: TabInfo,
    /// `a1:`, `a2:`, … — prefix attached to every patch ID for this
    /// tab so its NodeIds don't collide with the shell's or any other
    /// tab's.
    id_prefix: String,
    /// `Some(_)` while the tab is the active one — patches from this
    /// tab's remote get rewritten and forwarded. `None` while
    /// inactive: the remote is torn down on switch-away in v1.
    remote: Option<Arc<RemoteModule>>,
    /// Renderer-visible IDs the tab created at the root (rewritten to
    /// be children of the shell's viewport). Used to emit `Remove`
    /// patches when the tab is closed or switched away from.
    app_root_ids: Vec<String>,
    /// Patches buffered while the shell's viewport hadn't been
    /// discovered yet. Replayed once the viewport is known.
    queued: Vec<Patch>,
}

pub struct BrowserModule {
    /// The shell's module instance. Always present; mounted lazily
    /// from `mount()`.
    shell: Arc<ModuleInstance<ShellState>>,
    /// Receives [`ShellCommand`]s the shell dispatched during the
    /// last action — drained at the end of `dispatch_action` so the
    /// swap happens on the same tick the user clicked.
    cmd_rx: Mutex<mpsc::Receiver<ShellCommand>>,
    inner: Arc<Mutex<Inner>>,
    storage: Arc<Mutex<Storage>>,
    /// Monotonic counter for tab id-prefix allocation. Each new tab
    /// bumps this; we don't reuse prefixes even across closes so a
    /// stale patch can never accidentally land on a freshly-allocated
    /// tab with the same prefix.
    next_tab_prefix_id: AtomicU64,
}

struct Inner {
    /// Callback the desktop renderer wired via `on_patches`. Patches
    /// from every engine are merged through this single sink.
    callback: Option<PatchCallback>,
    /// Patches that arrived from shell's `mount()` before the
    /// renderer wired its callback. Drained on first `on_patches`.
    pending: Vec<Patch>,
    /// Renderer-side ID of the shell's viewport container. Resolved
    /// on the second `Insert(parent="root")` we observe (Stack → first
    /// child Container). Until set, tab patches that target `"root"`
    /// are buffered per-tab.
    viewport_id: Option<String>,
    /// First shell `Insert(parent="root")` — the root Stack.
    shell_root_id: Option<String>,
    /// Whether we've recorded the first child of the Stack yet.
    seen_first_root_child: bool,
    /// Per-tab state, keyed by `Tab::info.id`. The active tab's
    /// `remote` is `Some`; everyone else's is `None`.
    tabs: IndexMap<String, Tab>,
    /// Id of the active tab. `None` when the home screen is showing.
    active_tab_id: Option<String>,
}

impl Inner {
    fn new() -> Self {
        Self {
            callback: None,
            pending: Vec::new(),
            viewport_id: None,
            shell_root_id: None,
            seen_first_root_child: false,
            tabs: IndexMap::new(),
            active_tab_id: None,
        }
    }
}

impl BrowserModule {
    pub fn build(storage: Storage) -> Arc<Self> {
        let (cmd_tx, cmd_rx) = mpsc::channel::<ShellCommand>();
        let recents = storage.recent().to_vec();

        let app = HypenApp::default();
        let definition = build_shell_module(cmd_tx, recents);
        let shell = app
            .instantiate(Arc::new(definition))
            .expect("instantiate shell module");
        let shell = Arc::new(shell);

        let inner = Arc::new(Mutex::new(Inner::new()));

        // Wire the shell's patch callback. We scan structural patches
        // to learn the renderer-side viewport ID, then pass them
        // through to whatever the renderer wired into `on_patches`.
        let inner_for_shell = Arc::clone(&inner);
        shell.on_patches(move |patches: &[Patch]| {
            let forwarded = process_shell_patches(&inner_for_shell, patches);
            forward(&inner_for_shell, &forwarded);
        });

        Arc::new(Self {
            shell,
            cmd_rx: Mutex::new(cmd_rx),
            inner,
            storage: Arc::new(Mutex::new(storage)),
            next_tab_prefix_id: AtomicU64::new(1),
        })
    }

    /// Process every shell-emitted command after a dispatch. Called
    /// at the end of `dispatch_action` so the worker swap happens on
    /// the same tick the user's click came in.
    fn drain_commands(&self) {
        let cmds: Vec<ShellCommand> = {
            let rx = self.cmd_rx.lock().expect("cmd_rx poisoned");
            std::iter::from_fn(|| rx.try_recv().ok()).collect()
        };
        for cmd in cmds {
            match cmd {
                ShellCommand::OpenTab { url, name } => self.open_tab(url, name),
                ShellCommand::Refresh => self.refresh_active_tab(),
                ShellCommand::CloseTab { tab_id } => self.close_tab(&tab_id),
                ShellCommand::SwitchTab { tab_id } => self.switch_tab(&tab_id),
                ShellCommand::GoHome => self.go_home(),
                ShellCommand::DeleteRecent { url } => self.delete_recent(&url),
            }
        }
    }

    /// Open a new tab connected to `url` and make it the active one.
    /// Steps:
    /// 1. Tear down the currently-active tab's remote (its tree
    ///    leaves the viewport via `Remove`).
    /// 2. Record the visit in storage so it shows up under "Last
    ///    opened" even if the connection fails.
    /// 3. Allocate a new `Tab` (with a fresh `a<n>:` prefix) and a
    ///    `RemoteModule`; wire its patches + status callbacks.
    /// 4. Publish the updated tab list to the shell.
    fn open_tab(&self, url: String, name: String) {
        self.suspend_active_tab();

        if let Ok(mut s) = self.storage.lock() {
            s.record_visit(&name, &url);
            push_recents(&self.shell, s.recent().to_vec());
        }

        let prefix_n = self.next_tab_prefix_id.fetch_add(1, Ordering::Relaxed);
        let tab_id = format!("tab-{prefix_n}");
        let id_prefix = format!("a{prefix_n}:");

        let mut tab = Tab {
            info: TabInfo {
                id: tab_id.clone(),
                url: url.clone(),
                name,
                status: "connecting".into(),
                status_message: String::new(),
            },
            id_prefix: id_prefix.clone(),
            remote: None,
            app_root_ids: Vec::new(),
            queued: Vec::new(),
        };

        log::info!("hypen-browser: opening {url} in {tab_id}");
        let remote = Arc::new(RemoteModule::connect(url, "App"));

        // Patch callback — rewrites the tab's IDs and re-roots inserts
        // onto the shell's viewport. The closure must look the tab up
        // by id every batch (rather than capturing a strong ref to the
        // Tab) so closing the tab while patches are in flight just
        // drops them cleanly.
        let inner_for_remote = Arc::clone(&self.inner);
        let tab_id_for_remote = tab_id.clone();
        remote.on_patches(Arc::new(move |patches: &[Patch]| {
            let rewritten = process_tab_patches(
                &inner_for_remote,
                &tab_id_for_remote,
                patches,
            );
            if !rewritten.is_empty() {
                forward(&inner_for_remote, &rewritten);
            }
        }));

        // Status callback — surface lifecycle transitions on the
        // shell's tab strip so the user sees "connecting" → "connected"
        // → "reconnecting" / "failed" without polling.
        let inner_for_status = Arc::clone(&self.inner);
        let shell_for_status = Arc::clone(&self.shell);
        let tab_id_for_status = tab_id.clone();
        remote.on_status(move |status| {
            let snapshot = update_tab_status(
                &inner_for_status,
                &tab_id_for_status,
                status,
            );
            if let Some((tabs, active)) = snapshot {
                push_tabs(&shell_for_status, tabs, active);
            }
        });

        remote.mount();
        tab.remote = Some(remote);

        {
            let mut inner = self.inner.lock().expect("inner poisoned");
            inner.tabs.insert(tab_id.clone(), tab);
            inner.active_tab_id = Some(tab_id);
        }
        self.publish_tabs();
    }

    /// Refresh the active tab by tearing down its WebSocket and
    /// re-opening with the same URL. The tab id is preserved so the
    /// strip doesn't lose focus.
    fn refresh_active_tab(&self) {
        let (active_id, url, name) = {
            let inner = self.inner.lock().expect("inner poisoned");
            let id = match inner.active_tab_id.clone() {
                Some(id) => id,
                None => return,
            };
            let tab = match inner.tabs.get(&id) {
                Some(t) => t,
                None => return,
            };
            (id, tab.info.url.clone(), tab.info.name.clone())
        };
        log::info!("hypen-browser: refreshing {active_id} ({url})");
        // Close + reopen under a fresh tab id is simpler than
        // surgically replacing the RemoteModule in place. The user
        // sees the tab disappear / reappear for one frame, which is
        // acceptable for an explicit refresh action.
        self.close_tab(&active_id);
        self.open_tab(url, name);
    }

    /// Close a tab by id. If it was the active one, the next tab in
    /// insertion order becomes active; if there are no more tabs, the
    /// home screen takes over.
    fn close_tab(&self, tab_id: &str) {
        let (removed_tab, next_active) = {
            let mut inner = self.inner.lock().expect("inner poisoned");
            let tab = match inner.tabs.shift_remove(tab_id) {
                Some(t) => t,
                None => return,
            };
            let next = if inner.active_tab_id.as_deref() == Some(tab_id) {
                inner
                    .tabs
                    .keys()
                    .last()
                    .cloned()
                    .inspect(|id| inner.active_tab_id = Some(id.clone()))
                    .or_else(|| {
                        inner.active_tab_id = None;
                        None
                    })
            } else {
                None
            };
            (tab, next)
        };

        // Emit Remove patches for everything the tab pinned to the
        // viewport — without this the home screen / next tab would
        // be painted on top of stale nodes.
        let removes: Vec<Patch> = removed_tab
            .app_root_ids
            .into_iter()
            .map(|id| Patch::Remove { id })
            .collect();
        if !removes.is_empty() {
            forward(&self.inner, &removes);
        }
        // Dropping the RemoteModule's Arc shuts down its worker.
        drop(removed_tab.remote);

        if let Some(id) = next_active {
            // Switch-away replays the new active tab's content. In v1
            // that means re-opening — same UX as a "refresh" of the
            // tab we just promoted.
            let (url, name) = {
                let inner = self.inner.lock().expect("inner poisoned");
                let tab = match inner.tabs.get(&id) {
                    Some(t) => t,
                    None => {
                        // Vanished between close and lookup; just
                        // re-publish without re-opening.
                        drop(inner);
                        self.publish_tabs();
                        return;
                    }
                };
                (tab.info.url.clone(), tab.info.name.clone())
            };
            self.close_tab(&id); // remove the inactive placeholder
            self.open_tab(url, name);
        } else {
            self.publish_tabs();
        }
    }

    /// Make `tab_id` the active tab. In v1, switching closes the old
    /// active tab's remote and re-opens the target tab so the user
    /// sees the freshest patch stream. (Background-keeping tabs alive
    /// across switches is a future enhancement.)
    fn switch_tab(&self, tab_id: &str) {
        let already_active = {
            let inner = self.inner.lock().expect("inner poisoned");
            inner.active_tab_id.as_deref() == Some(tab_id)
                && inner
                    .tabs
                    .get(tab_id)
                    .map(|t| t.remote.is_some())
                    .unwrap_or(false)
        };
        if already_active {
            return;
        }

        let target = {
            let inner = self.inner.lock().expect("inner poisoned");
            inner
                .tabs
                .get(tab_id)
                .map(|t| (t.info.url.clone(), t.info.name.clone()))
        };
        let (url, name) = match target {
            Some(t) => t,
            None => return,
        };

        // Drop the existing entry for the same id so open_tab's
        // suspend-then-open logic doesn't see a stale placeholder.
        {
            let mut inner = self.inner.lock().expect("inner poisoned");
            if let Some(prev) = inner.tabs.shift_remove(tab_id) {
                drop(prev.remote);
                // Emit removes for the dropped tab's content; the new
                // tab's tree will land in its place.
                let removes: Vec<Patch> = prev
                    .app_root_ids
                    .into_iter()
                    .map(|id| Patch::Remove { id })
                    .collect();
                if !removes.is_empty() {
                    drop(inner);
                    forward(&self.inner, &removes);
                }
            }
        }
        self.open_tab(url, name);
    }

    /// Close every tab and return to the home screen. Equivalent to
    /// pressing the home button in the island chrome.
    fn go_home(&self) {
        let ids: Vec<String> = {
            let inner = self.inner.lock().expect("inner poisoned");
            inner.tabs.keys().cloned().collect()
        };
        for id in ids {
            // Each close drops its own RemoteModule + emits Removes.
            // We accept the O(n^2) shift_remove cost — `tabs` is
            // user-driven and won't exceed a handful of entries.
            self.close_tab_no_promote(&id);
        }
        {
            let mut inner = self.inner.lock().expect("inner poisoned");
            inner.active_tab_id = None;
        }
        self.publish_tabs();
    }

    /// Same as [`Self::close_tab`] but doesn't promote a successor.
    /// Used by [`Self::go_home`] which closes every tab in one go.
    fn close_tab_no_promote(&self, tab_id: &str) {
        let removed = {
            let mut inner = self.inner.lock().expect("inner poisoned");
            inner.tabs.shift_remove(tab_id)
        };
        if let Some(tab) = removed {
            let removes: Vec<Patch> = tab
                .app_root_ids
                .into_iter()
                .map(|id| Patch::Remove { id })
                .collect();
            if !removes.is_empty() {
                forward(&self.inner, &removes);
            }
            drop(tab.remote);
        }
    }

    /// Drop the active tab's remote without removing it from the tab
    /// list. Used by [`Self::open_tab`] right before it allocates the
    /// new active tab — keeps `app_root_ids` cleared so the next
    /// tab's tree replaces the previous one cleanly.
    fn suspend_active_tab(&self) {
        let removes = {
            let mut inner = self.inner.lock().expect("inner poisoned");
            let id = match inner.active_tab_id.clone() {
                Some(id) => id,
                None => return,
            };
            let Some(tab) = inner.tabs.get_mut(&id) else {
                return;
            };
            let removes: Vec<Patch> = std::mem::take(&mut tab.app_root_ids)
                .into_iter()
                .map(|id| Patch::Remove { id })
                .collect();
            tab.queued.clear();
            tab.remote = None;
            removes
        };
        if !removes.is_empty() {
            forward(&self.inner, &removes);
        }
    }

    fn delete_recent(&self, url: &str) {
        if let Ok(mut s) = self.storage.lock() {
            s.remove_by_url(url);
            push_recents(&self.shell, s.recent().to_vec());
        }
    }

    /// Snapshot the current tab list + active id and push it into the
    /// shell so the strip re-renders.
    fn publish_tabs(&self) {
        let (infos, active) = {
            let inner = self.inner.lock().expect("inner poisoned");
            let infos: Vec<TabInfo> =
                inner.tabs.values().map(|t| t.info.clone()).collect();
            (infos, inner.active_tab_id.clone())
        };
        push_tabs(&self.shell, infos, active);
    }
}

impl HypenModule for BrowserModule {
    fn on_patches(&self, cb: PatchCallback) {
        let pending = {
            let mut inner = self.inner.lock().expect("inner poisoned");
            inner.callback = Some(Arc::clone(&cb));
            std::mem::take(&mut inner.pending)
        };
        if !pending.is_empty() {
            cb(&pending);
        }
    }

    fn mount(&self) {
        self.shell.mount();
    }

    fn dispatch_action(&self, name: &str, payload: Option<Value>) {
        let target = classify_dispatch(name, payload.as_ref());
        match target {
            DispatchTarget::Shell => {
                if let Err(e) = self.shell.dispatch_action(name, payload) {
                    log::warn!("hypen-browser: shell dispatch {name}: {e:?}");
                }
            }
            DispatchTarget::Remote => {
                let remote = {
                    let inner = self.inner.lock().expect("inner poisoned");
                    inner
                        .active_tab_id
                        .as_deref()
                        .and_then(|id| inner.tabs.get(id))
                        .and_then(|tab| tab.remote.as_ref().map(Arc::clone))
                };
                if let Some(remote) = remote {
                    remote.dispatch_action(name, payload);
                } else {
                    log::debug!(
                        "hypen-browser: ignoring action {name} — no active tab",
                    );
                }
            }
        }
        // Drain any `ShellCommand`s the shell's handler enqueued
        // during the dispatch — this is what swaps the active tab
        // when the user opens / closes / switches.
        self.drain_commands();
    }
}

/// Where an inbound action should be routed. Decided by name (and, for
/// `__hypen_bind`, by the path field in the payload).
enum DispatchTarget {
    Shell,
    Remote,
}

fn classify_dispatch(name: &str, payload: Option<&Value>) -> DispatchTarget {
    if name == "__hypen_bind" {
        let path = payload
            .and_then(|p| p.get("path"))
            .and_then(|p| p.as_str())
            .unwrap_or("");
        let head = path.split('.').next().unwrap_or(path);
        return if SHELL_BIND_PATHS.contains(&head) {
            DispatchTarget::Shell
        } else {
            DispatchTarget::Remote
        };
    }
    if SHELL_ACTIONS.contains(&name) {
        DispatchTarget::Shell
    } else {
        DispatchTarget::Remote
    }
}

// ---------------------------------------------------------------------------
// Patch routing
// ---------------------------------------------------------------------------

/// Forward a batch of already-namespaced patches to the renderer.
/// Buffers them if the renderer hasn't wired its callback yet.
fn forward(inner: &Arc<Mutex<Inner>>, patches: &[Patch]) {
    if patches.is_empty() {
        return;
    }
    let cb = {
        let mut g = inner.lock().expect("inner poisoned");
        if let Some(cb) = g.callback.as_ref() {
            Some(Arc::clone(cb))
        } else {
            g.pending.extend_from_slice(patches);
            None
        }
    };
    if let Some(cb) = cb {
        cb(patches);
    }
}

/// Inspect shell patches as they flow through. We don't rewrite shell
/// IDs — the shell is the "primary" engine, owning the `"root"`
/// namespace — but we sniff for the first two structural inserts so
/// we can learn the viewport's renderer ID. Also flushes any per-tab
/// queued patches that were waiting on the viewport id.
fn process_shell_patches(inner: &Arc<Mutex<Inner>>, patches: &[Patch]) -> Vec<Patch> {
    let mut queued_flush: Vec<Patch> = Vec::new();
    {
        let mut g = inner.lock().expect("inner poisoned");
        for patch in patches {
            if let Patch::Insert { parent_id, id, .. } = patch {
                if parent_id == ROOT_ID && g.shell_root_id.is_none() {
                    g.shell_root_id = Some(id.clone());
                } else if !g.seen_first_root_child {
                    if let Some(root) = g.shell_root_id.as_deref() {
                        if parent_id == root {
                            let viewport = id.clone();
                            g.viewport_id = Some(viewport.clone());
                            g.seen_first_root_child = true;
                            // Drain every tab's queued patches.
                            for tab in g.tabs.values_mut() {
                                let drained = std::mem::take(&mut tab.queued);
                                let mut local_roots = Vec::new();
                                let rewritten = rewrite_tab_batch(
                                    drained,
                                    &tab.id_prefix,
                                    &viewport,
                                    &mut local_roots,
                                );
                                tab.app_root_ids.extend(local_roots);
                                queued_flush.extend(rewritten);
                            }
                        }
                    }
                }
            }
        }
    }
    let mut out = patches.to_vec();
    out.extend(queued_flush);
    out
}

/// Translate a tab's patches into the merged stream. Returns the
/// rewritten patches; if the tab is inactive or unknown, returns
/// empty so the worker's output is silently dropped.
fn process_tab_patches(
    inner: &Arc<Mutex<Inner>>,
    tab_id: &str,
    patches: &[Patch],
) -> Vec<Patch> {
    let mut g = inner.lock().expect("inner poisoned");
    // Only the active tab forwards. Inactive tabs (none in v1, but
    // future-proof) keep their patches in the per-tab queue.
    let is_active = g.active_tab_id.as_deref() == Some(tab_id);
    if !is_active {
        return Vec::new();
    }
    let viewport = match g.viewport_id.clone() {
        Some(v) => v,
        None => {
            // Shell hasn't rendered yet; buffer per-tab so we can
            // replay once we learn the viewport id.
            if let Some(tab) = g.tabs.get_mut(tab_id) {
                tab.queued.extend_from_slice(patches);
            }
            return Vec::new();
        }
    };
    let prefix = match g.tabs.get(tab_id) {
        Some(t) => t.id_prefix.clone(),
        None => return Vec::new(),
    };
    let mut new_roots: Vec<String> = Vec::new();
    let rewritten = rewrite_tab_batch(patches.to_vec(), &prefix, &viewport, &mut new_roots);
    if let Some(tab) = g.tabs.get_mut(tab_id) {
        // Track new root ids so close-tab can `Remove` them.
        tab.app_root_ids.extend(new_roots);
        // Filter out any roots that were just removed by the same
        // batch.
        for p in &rewritten {
            if let Patch::Remove { id } = p {
                tab.app_root_ids.retain(|tracked| tracked != id);
            }
        }
    }
    rewritten
}

/// Rewrite a whole batch of tab-origin patches. `new_roots` collects
/// the ids that became children of the shell's viewport.
fn rewrite_tab_batch(
    patches: Vec<Patch>,
    prefix: &str,
    viewport: &str,
    new_roots: &mut Vec<String>,
) -> Vec<Patch> {
    let mut out = Vec::with_capacity(patches.len());
    for patch in patches {
        out.push(rewrite_patch(patch, prefix, viewport, new_roots));
    }
    out
}

fn rewrite_patch(
    patch: Patch,
    prefix: &str,
    viewport: &str,
    new_roots: &mut Vec<String>,
) -> Patch {
    match patch {
        Patch::Create {
            id,
            element_type,
            props,
        } => Patch::Create {
            id: prefix_id(prefix, &id),
            element_type,
            props,
        },
        Patch::SetProp { id, name, value } => Patch::SetProp {
            id: prefix_id(prefix, &id),
            name,
            value,
        },
        Patch::RemoveProp { id, name } => Patch::RemoveProp {
            id: prefix_id(prefix, &id),
            name,
        },
        Patch::SetText { id, text } => Patch::SetText {
            id: prefix_id(prefix, &id),
            text,
        },
        Patch::Insert {
            parent_id,
            id,
            before_id,
        } => {
            let (parent, is_root_insert) = rewrite_parent(&parent_id, prefix, viewport);
            let prefixed_id = prefix_id(prefix, &id);
            if is_root_insert && !new_roots.contains(&prefixed_id) {
                new_roots.push(prefixed_id.clone());
            }
            Patch::Insert {
                parent_id: parent,
                id: prefixed_id,
                before_id: before_id.map(|b| prefix_id(prefix, &b)),
            }
        }
        Patch::Move {
            parent_id,
            id,
            before_id,
        } => {
            let (parent, _) = rewrite_parent(&parent_id, prefix, viewport);
            Patch::Move {
                parent_id: parent,
                id: prefix_id(prefix, &id),
                before_id: before_id.map(|b| prefix_id(prefix, &b)),
            }
        }
        Patch::Remove { id } => Patch::Remove {
            id: prefix_id(prefix, &id),
        },
        Patch::Detach { id } => Patch::Detach {
            id: prefix_id(prefix, &id),
        },
        Patch::Attach {
            parent_id,
            id,
            before_id,
        } => {
            let (parent, is_root_attach) = rewrite_parent(&parent_id, prefix, viewport);
            let prefixed_id = prefix_id(prefix, &id);
            if is_root_attach && !new_roots.contains(&prefixed_id) {
                new_roots.push(prefixed_id.clone());
            }
            Patch::Attach {
                parent_id: parent,
                id: prefixed_id,
                before_id: before_id.map(|b| prefix_id(prefix, &b)),
            }
        }
    }
}

/// Returns `(rewritten_parent_id, is_root_level_under_viewport)`.
fn rewrite_parent(parent_id: &str, prefix: &str, viewport: &str) -> (String, bool) {
    if parent_id == ROOT_ID {
        (viewport.to_string(), true)
    } else {
        (prefix_id(prefix, parent_id), false)
    }
}

fn prefix_id(prefix: &str, id: &str) -> String {
    let mut s = String::with_capacity(prefix.len() + id.len());
    s.push_str(prefix);
    s.push_str(id);
    s
}

/// Translate a `ConnectionStatus` into the `(status, message)` pair
/// the shell's UI renders. Pure function for testability.
fn status_strings(status: &ConnectionStatus) -> (String, String) {
    match status {
        ConnectionStatus::Connecting => ("connecting".into(), String::new()),
        ConnectionStatus::Connected => ("connected".into(), String::new()),
        ConnectionStatus::Reconnecting { attempt } => {
            ("reconnecting".into(), format!("attempt {attempt}"))
        }
        ConnectionStatus::Failed { reason } => ("failed".into(), reason.clone()),
        ConnectionStatus::Closed => ("closed".into(), String::new()),
    }
}

/// Update the recorded status for a tab and return a snapshot of the
/// shell-facing tab list so the caller can push it through
/// `push_tabs`. Returns `None` if the tab no longer exists (the
/// worker fired after a close, for instance).
fn update_tab_status(
    inner: &Arc<Mutex<Inner>>,
    tab_id: &str,
    status: &ConnectionStatus,
) -> Option<(Vec<TabInfo>, Option<String>)> {
    let mut g = inner.lock().expect("inner poisoned");
    let tab = g.tabs.get_mut(tab_id)?;
    let (s, m) = status_strings(status);
    tab.info.status = s;
    tab.info.status_message = m;
    let infos: Vec<TabInfo> = g.tabs.values().map(|t| t.info.clone()).collect();
    Some((infos, g.active_tab_id.clone()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Fresh BrowserModule pointed at a throwaway storage file plus
    /// a patch sink that captures every batch the wrapper forwards.
    fn fresh_browser_with_capture() -> (Arc<BrowserModule>, Arc<Mutex<Vec<Patch>>>) {
        let storage = Storage::at_path(std::env::temp_dir().join(format!(
            "hypen-browser-itest-{}-{}.json",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        )));
        let module = BrowserModule::build(storage);
        let captured: Arc<Mutex<Vec<Patch>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&captured);
        module.on_patches(Arc::new(move |patches| {
            sink.lock().unwrap().extend_from_slice(patches);
        }));
        module.mount();
        (module, captured)
    }

    #[test]
    fn classify_dispatch_routes_shell_actions_to_shell() {
        assert!(matches!(
            classify_dispatch("connect", None),
            DispatchTarget::Shell
        ));
        assert!(matches!(
            classify_dispatch("refresh", None),
            DispatchTarget::Shell
        ));
        assert!(matches!(
            classify_dispatch("close_tab", None),
            DispatchTarget::Shell
        ));
        assert!(matches!(
            classify_dispatch("delete_recent", None),
            DispatchTarget::Shell
        ));
        assert!(matches!(
            classify_dispatch("increment", None),
            DispatchTarget::Remote
        ));
    }

    #[test]
    fn classify_dispatch_routes_bind_by_path_head() {
        let shell_bind = json!({"path": "url_input", "value": "x"});
        let app_bind = json!({"path": "todos.0.title", "value": "x"});
        let tabs_bind = json!({"path": "tabs", "value": "x"});
        assert!(matches!(
            classify_dispatch("__hypen_bind", Some(&shell_bind)),
            DispatchTarget::Shell
        ));
        assert!(matches!(
            classify_dispatch("__hypen_bind", Some(&app_bind)),
            DispatchTarget::Remote
        ));
        assert!(matches!(
            classify_dispatch("__hypen_bind", Some(&tabs_bind)),
            DispatchTarget::Shell
        ));
    }

    #[test]
    fn status_strings_maps_every_variant_to_a_stringified_pair() {
        assert_eq!(
            status_strings(&ConnectionStatus::Connecting),
            ("connecting".into(), String::new())
        );
        assert_eq!(
            status_strings(&ConnectionStatus::Connected),
            ("connected".into(), String::new())
        );
        assert_eq!(
            status_strings(&ConnectionStatus::Reconnecting { attempt: 3 }),
            ("reconnecting".into(), "attempt 3".into())
        );
        assert_eq!(
            status_strings(&ConnectionStatus::Failed {
                reason: "boom".into()
            }),
            ("failed".into(), "boom".into())
        );
        assert_eq!(
            status_strings(&ConnectionStatus::Closed),
            ("closed".into(), String::new())
        );
    }

    #[test]
    fn real_shell_mount_resolves_viewport_to_a_real_node_id() {
        let storage = Storage::at_path(std::env::temp_dir().join(format!(
            "hypen-browser-viewport-test-{}.json",
            std::process::id()
        )));
        let module = BrowserModule::build(storage);
        module.on_patches(Arc::new(|_| {}));
        module.mount();
        let inner = module.inner.lock().unwrap();
        assert!(inner.shell_root_id.is_some());
        assert!(inner.viewport_id.is_some());
    }

    #[test]
    fn browser_module_routes_toggle_island_to_the_shell() {
        let (module, _captured) = fresh_browser_with_capture();
        let before = module.shell.get_state().island_expanded;
        module.dispatch_action("toggle_island", None);
        assert_ne!(module.shell.get_state().island_expanded, before);
    }

    #[test]
    fn browser_module_swallows_unknown_actions_with_no_active_tab() {
        let (module, _captured) = fresh_browser_with_capture();
        module.dispatch_action("nonexistent_action", None);
        assert!(module.shell.get_state().tabs.is_empty());
    }

    #[test]
    fn close_tab_emits_remove_patches_for_tracked_app_roots() {
        // Build a tab manually (skipping the real WebSocket worker)
        // so we can populate app_root_ids and confirm close_tab emits
        // a Remove for each.
        let (module, captured) = fresh_browser_with_capture();
        let tab_id = "tab-test";
        {
            let mut inner = module.inner.lock().unwrap();
            inner.tabs.insert(
                tab_id.into(),
                Tab {
                    info: TabInfo {
                        id: tab_id.into(),
                        url: "ws://x".into(),
                        name: "X".into(),
                        status: "connected".into(),
                        status_message: String::new(),
                    },
                    id_prefix: "a99:".into(),
                    remote: None,
                    app_root_ids: vec!["a99:1".into(), "a99:2".into()],
                    queued: Vec::new(),
                },
            );
            inner.active_tab_id = Some(tab_id.into());
        }
        let before = captured.lock().unwrap().len();

        module.close_tab(tab_id);

        let after = captured.lock().unwrap();
        let removes: Vec<&str> = after[before..]
            .iter()
            .filter_map(|p| match p {
                Patch::Remove { id } => Some(id.as_str()),
                _ => None,
            })
            .collect();
        assert!(
            removes.contains(&"a99:1") && removes.contains(&"a99:2"),
            "close_tab must Remove every tracked root; got {removes:?}",
        );
        assert!(module.inner.lock().unwrap().tabs.is_empty());
        assert!(module.inner.lock().unwrap().active_tab_id.is_none());
    }

    #[test]
    fn go_home_closes_every_open_tab() {
        let (module, captured) = fresh_browser_with_capture();
        {
            let mut inner = module.inner.lock().unwrap();
            for n in 1..=3u32 {
                let id = format!("tab-{n}");
                inner.tabs.insert(
                    id.clone(),
                    Tab {
                        info: TabInfo {
                            id: id.clone(),
                            url: format!("ws://x{n}"),
                            name: format!("X{n}"),
                            status: "connected".into(),
                            status_message: String::new(),
                        },
                        id_prefix: format!("a{n}:"),
                        remote: None,
                        app_root_ids: vec![format!("a{n}:1")],
                        queued: Vec::new(),
                    },
                );
            }
            inner.active_tab_id = Some("tab-3".into());
        }
        let before = captured.lock().unwrap().len();

        module.dispatch_action("go_home", None);

        assert!(module.inner.lock().unwrap().tabs.is_empty());
        assert!(module.inner.lock().unwrap().active_tab_id.is_none());
        let after = captured.lock().unwrap();
        let removes: Vec<&str> = after[before..]
            .iter()
            .filter_map(|p| match p {
                Patch::Remove { id } => Some(id.as_str()),
                _ => None,
            })
            .collect();
        for n in 1..=3 {
            let expected = format!("a{n}:1");
            assert!(
                removes.contains(&expected.as_str()),
                "go_home must Remove every tab's roots; missing {expected}; got {removes:?}",
            );
        }
    }

    #[test]
    fn delete_recent_drops_storage_entry_and_pushes_refreshed_list() {
        let path = std::env::temp_dir().join(format!(
            "hypen-browser-del-{}-{}.json",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_file(&path);
        let mut storage = Storage::at_path(path.clone());
        storage.record_visit("A", "ws://a");
        storage.record_visit("B", "ws://b");
        let module = BrowserModule::build(storage);
        module.on_patches(Arc::new(|_| {}));
        module.mount();

        module.dispatch_action(
            "delete_recent",
            Some(json!({"url": "ws://a"})),
        );

        // Storage on disk updated.
        let reloaded = Storage::at_path(path.clone());
        let urls: Vec<&str> = reloaded.recent().iter().map(|a| a.url.as_str()).collect();
        assert_eq!(urls, vec!["ws://b"]);

        // Shell state mirrors it too (delete_recent locally retains
        // anyway, but the wrapper also pushes the storage-fresh list).
        let shell_urls: Vec<String> = module
            .shell
            .get_state()
            .recents
            .iter()
            .map(|r| r.url.clone())
            .collect();
        assert_eq!(shell_urls, vec!["ws://b".to_string()]);

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn on_patches_drains_shell_patches_buffered_before_wiring() {
        let storage = Storage::at_path(std::env::temp_dir().join(format!(
            "hypen-browser-wireup-{}.json",
            std::process::id()
        )));
        let module = BrowserModule::build(storage);
        module.mount();
        assert!(!module.inner.lock().unwrap().pending.is_empty());

        let captured: Arc<Mutex<Vec<Patch>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&captured);
        module.on_patches(Arc::new(move |patches| {
            sink.lock().unwrap().extend_from_slice(patches);
        }));
        assert!(!captured.lock().unwrap().is_empty());
    }
}
