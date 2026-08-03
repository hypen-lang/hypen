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
//!    Container.
//! 3. **Background tabs stay alive.** Inactive tabs' workers keep
//!    streaming patches; we apply them to the renderer's `Tree`
//!    anyway but immediately follow each root `Insert` with a
//!    `Detach` so the subtree doesn't appear in the viewport. On
//!    switch-back the wrapper emits `Attach` for every tracked root —
//!    no WebSocket round-trip, no spinner, no lost session state.
//! 4. **Routing actions.** Action names in `SHELL_ACTIONS` (plus
//!    `__hypen_bind` for shell-owned paths) go to the shell; the
//!    rest go to the active tab's remote.
//!
//! Detach / Attach are the same patches the engine's Router subtree
//! cache uses — the renderer's `Tree` already supports them
//! (`Tree::apply` matches both arms; `parent_by_child` and the
//! `nodes` map are decoupled so a detached subtree keeps its
//! `Node` entries and reconnect with `Attach` doesn't rebuild).

use crate::shell::{
    build_shell_module, push_debug_log, push_recents, push_tabs, ShellCommand, ShellState, TabInfo,
    SHELL_ACTIONS, SHELL_BIND_PATHS,
};
use crate::storage::Storage;
use hypen_engine::Patch;
use hypen_renderer_desktop::{ConnectionStatus, HypenModule, RemoteModule, Tree};
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
    /// The tab's WebSocket worker. Held for every open tab regardless
    /// of whether the tab is currently visible — background tabs keep
    /// receiving patches and updating their (detached) subtree in the
    /// renderer's `Tree`. Dropped only on `close_tab` / `go_home`.
    remote: Option<Arc<RemoteModule>>,
    /// Renderer-visible IDs the tab inserted at root level (rewritten
    /// to be children of the shell's viewport). Drives the
    /// `Detach` / `Attach` patch pairs the wrapper emits on tab
    /// switch and the `Remove` patches it emits on close.
    app_root_ids: Vec<String>,
    /// Patches buffered while the shell's viewport hadn't been
    /// discovered yet. Replayed once the viewport is known.
    queued: Vec<Patch>,
    /// `true` when this tab's roots are currently children of the
    /// shell viewport (visible). `false` when its roots have been
    /// `Detach`'d — the subtree is still in the renderer's `Tree`
    /// (and the worker keeps applying patches to it) but it isn't
    /// linked into the visible tree. Flipped by `attach_tab` /
    /// `detach_tab`.
    attached: bool,
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
    /// Shadow copy of the full forwarded UI tree (shell chrome + the
    /// active tab's content), kept in sync by `forward`. Serialised on
    /// demand by the `dump_tree` debug button.
    tree: Tree,
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
            tree: Tree::new(),
        }
    }
}

/// Record a debug-console line through the global [`crate::devlog`]
/// buffer, and — when the console is open — push the refreshed snapshot
/// into the shell so the panel re-renders. Must be called with NO inner
/// lock held (it dispatches a shell action).
fn record_console(shell: &Arc<ModuleInstance<ShellState>>, line: String) {
    let console = crate::devlog::console();
    if !console.enabled() {
        return;
    }
    console.push(line);
    push_debug_log(shell, console.snapshot());
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
                ShellCommand::NavigateActive { url, name } => self.navigate_active_tab(url, name),
                ShellCommand::NewTab => self.new_tab(),
                ShellCommand::Refresh => self.refresh_active_tab(),
                ShellCommand::CloseTab { tab_id } => self.close_tab(&tab_id),
                ShellCommand::SwitchTab { tab_id } => self.switch_tab(&tab_id),
                ShellCommand::GoHome => self.go_home(),
                ShellCommand::DeleteRecent { url } => self.delete_recent(&url),
                ShellCommand::SetDebug(open) => {
                    crate::devlog::console().set_enabled(open);
                }
                ShellCommand::DumpTree => self.dump_tree(),
            }
        }
    }

    /// Serialise the current forwarded UI tree (shell chrome + active
    /// tab content) into the debug console. Opens the console if it was
    /// closed so the dump is visible.
    fn dump_tree(&self) {
        let console = crate::devlog::console();
        console.set_enabled(true);
        let dump = {
            let inner = self.inner.lock().expect("inner poisoned");
            serialize_tree(&inner.tree)
        };
        console.push(format!("── UI tree ──\n{dump}"));
        push_debug_log(&self.shell, console.snapshot());
    }

    /// Reuse the active tab's slot for a different URL. Drops the
    /// current connection (so we don't leak a WebSocket to the old
    /// destination) and opens a fresh one. From the user's POV the
    /// address bar just navigated like a browser. If no tab is
    /// active, falls back to `open_tab`.
    fn navigate_active_tab(&self, url: String, name: String) {
        let active = self
            .inner
            .lock()
            .expect("inner poisoned")
            .active_tab_id
            .clone();
        if let Some(id) = active {
            self.close_tab_silent(&id);
        }
        self.open_tab(url, name);
    }

    /// Detach the active tab so the home / address bar resurfaces;
    /// existing background tabs stay open and `+` simply creates a
    /// fresh slot the next `OpenTab` will fill.
    fn new_tab(&self) {
        let active = self
            .inner
            .lock()
            .expect("inner poisoned")
            .active_tab_id
            .clone();
        if let Some(id) = active {
            self.detach_tab(&id);
        }
        {
            let mut inner = self.inner.lock().expect("inner poisoned");
            inner.active_tab_id = None;
        }
        self.publish_tabs();
    }

    /// Open a new tab connected to `url` and make it the active one.
    /// The previously-active tab is *detached*, not closed — its
    /// WebSocket and subtree stay live in the background so switching
    /// back is instant. Steps:
    /// 1. `Detach` the currently-active tab's roots from the viewport.
    /// 2. Record the visit in storage so it shows up under "Last
    ///    opened" even if the connection fails.
    /// 3. Allocate a new `Tab` (with a fresh `a<n>:` prefix) and a
    ///    `RemoteModule`; wire its patches + status callbacks.
    /// 4. Publish the updated tab list to the shell.
    fn open_tab(&self, url: String, name: String) {
        log::debug!("hypen-browser: open_tab({url}) ENTER — locking inner to read active_tab_id");
        let prev_active = self
            .inner
            .lock()
            .expect("inner poisoned")
            .active_tab_id
            .clone();
        log::debug!("hypen-browser: open_tab({url}) released inner; prev_active={prev_active:?}");
        if let Some(old_id) = prev_active {
            log::debug!("hypen-browser: open_tab detaching prev {old_id}");
            self.detach_tab(&old_id);
            log::debug!("hypen-browser: open_tab detach({old_id}) returned");
        }

        log::debug!("hypen-browser: open_tab locking storage");
        if let Ok(mut s) = self.storage.lock() {
            log::debug!("hypen-browser: open_tab storage locked; recording visit");
            s.record_visit(&name, &url);
            log::debug!("hypen-browser: open_tab pushing recents to shell");
            push_recents(&self.shell, s.recent().to_vec());
            log::debug!("hypen-browser: open_tab push_recents returned");
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
            // Brand-new tab is active and its patches go straight to
            // the viewport — no Detach needed for incoming root
            // inserts.
            attached: true,
        };

        log::info!("hypen-browser: opening {url} in {tab_id}");
        let remote = Arc::new(RemoteModule::connect(url, "App"));

        // Patch callback — rewrites the tab's IDs and re-roots inserts
        // onto the shell's viewport. The closure must look the tab up
        // by id every batch (rather than capturing a strong ref to the
        // Tab) so closing the tab while patches are in flight just
        // drops them cleanly.
        let inner_for_remote = Arc::clone(&self.inner);
        let shell_for_remote = Arc::clone(&self.shell);
        let tab_id_for_remote = tab_id.clone();
        remote.on_patches(Arc::new(move |patches: &[Patch]| {
            log::debug!(
                "hypen-browser: tab {tab_id_for_remote} on_patches: {} patches in",
                patches.len(),
            );
            let rewritten = process_tab_patches(&inner_for_remote, &tab_id_for_remote, patches);
            log::debug!(
                "hypen-browser: tab {tab_id_for_remote} rewritten {} → forwarding",
                rewritten.len(),
            );
            if !rewritten.is_empty() {
                forward(&inner_for_remote, &rewritten);
            }
            // Debug console: record the incoming batch (no-op when the
            // console is closed).
            record_console(
                &shell_for_remote,
                format!("◀ in  {}", summarize_patches(patches)),
            );
        }));

        // Status callback — surface lifecycle transitions on the
        // shell's tab strip so the user sees "connecting" → "connected"
        // → "reconnecting" / "failed" without polling.
        let inner_for_status = Arc::clone(&self.inner);
        let shell_for_status = Arc::clone(&self.shell);
        let tab_id_for_status = tab_id.clone();
        remote.on_status(move |status| {
            log::info!(
                "hypen-browser: tab {tab_id_for_status} status -> {status:?} \
                 (thread={:?})",
                std::thread::current().name().unwrap_or("?"),
            );
            let snapshot = update_tab_status(&inner_for_status, &tab_id_for_status, status);
            if let Some((tabs, active)) = snapshot {
                log::debug!(
                    "hypen-browser: tab {tab_id_for_status} pushing tabs \
                     snapshot ({} tabs)",
                    tabs.len(),
                );
                push_tabs(&shell_for_status, tabs, active);
                log::debug!("hypen-browser: tab {tab_id_for_status} push_tabs done",);
            }
        });

        log::debug!("hypen-browser: {tab_id} mounting remote");
        remote.mount();
        log::debug!("hypen-browser: {tab_id} remote.mount() returned");
        tab.remote = Some(remote);

        {
            log::debug!("hypen-browser: {tab_id} taking inner lock to insert tab");
            let mut inner = self.inner.lock().expect("inner poisoned");
            inner.tabs.insert(tab_id.clone(), tab);
            inner.active_tab_id = Some(tab_id.clone());
            log::debug!("hypen-browser: {tab_id} inserted, releasing inner lock");
        }
        log::debug!("hypen-browser: {tab_id} publishing tabs to shell");
        self.publish_tabs();
        log::info!("hypen-browser: open_tab({tab_id}) returned");
    }

    /// Refresh the active tab by closing it and opening a new one to
    /// the same URL. Refresh deliberately *doesn't* use the Detach
    /// path — the user explicitly asked for a fresh session, so we
    /// drop the WebSocket and let the new tab handshake anew. The
    /// tab id changes; tabs after it in the strip don't move because
    /// `open_tab` always appends.
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
        self.close_tab_silent(&active_id);
        self.open_tab(url, name);
    }

    /// Close a tab by id. Tears down its WebSocket (drop the
    /// `RemoteModule` `Arc`) and emits `Remove` for every tracked
    /// root so the renderer's `Tree` reclaims the nodes. If the
    /// closed tab was the active one, the most recently-opened
    /// remaining tab is `Attach`ed in its place; if it was the last
    /// tab, the home screen returns.
    fn close_tab(&self, tab_id: &str) {
        let was_active = self
            .inner
            .lock()
            .expect("inner poisoned")
            .active_tab_id
            .as_deref()
            == Some(tab_id);
        self.close_tab_silent(tab_id);
        if !was_active {
            self.publish_tabs();
            return;
        }
        // Promote the most recently-opened survivor.
        let next = self
            .inner
            .lock()
            .expect("inner poisoned")
            .tabs
            .keys()
            .last()
            .cloned();
        if let Some(id) = next {
            {
                let mut inner = self.inner.lock().expect("inner poisoned");
                inner.active_tab_id = Some(id.clone());
            }
            self.attach_tab(&id);
        } else {
            self.inner.lock().expect("inner poisoned").active_tab_id = None;
        }
        self.publish_tabs();
    }

    /// Close a tab without promoting a successor or re-publishing the
    /// strip. Used by `close_tab` (which handles those itself),
    /// `refresh_active_tab` (which immediately opens a replacement),
    /// and `go_home` (which closes the lot in one pass).
    fn close_tab_silent(&self, tab_id: &str) {
        let removed = {
            let mut inner = self.inner.lock().expect("inner poisoned");
            inner.tabs.shift_remove(tab_id)
        };
        let Some(tab) = removed else {
            return;
        };
        // Only attached tabs have nodes linked into the viewport;
        // detached tabs' nodes still live in `Tree.nodes` but aren't
        // children of anything, so `Remove` still tears them down via
        // `remove_subtree`. Either way we send Remove for each id.
        let removes: Vec<Patch> = tab
            .app_root_ids
            .iter()
            .map(|id| Patch::Remove { id: id.clone() })
            .collect();
        if !removes.is_empty() {
            forward(&self.inner, &removes);
        }
        // Dropping the RemoteModule's Arc shuts down its worker.
        drop(tab.remote);
    }

    /// Make `tab_id` the active tab. Detach-then-attach — no
    /// reconnect, no spinner, the new tab's tree pops back in
    /// exactly where it was. No-op if `tab_id` is already active or
    /// doesn't exist.
    fn switch_tab(&self, tab_id: &str) {
        let (already_active, exists) = {
            let inner = self.inner.lock().expect("inner poisoned");
            (
                inner.active_tab_id.as_deref() == Some(tab_id),
                inner.tabs.contains_key(tab_id),
            )
        };
        if already_active || !exists {
            return;
        }

        let old_id = self
            .inner
            .lock()
            .expect("inner poisoned")
            .active_tab_id
            .clone();
        if let Some(old) = old_id {
            self.detach_tab(&old);
        }
        {
            let mut inner = self.inner.lock().expect("inner poisoned");
            inner.active_tab_id = Some(tab_id.to_string());
        }
        self.attach_tab(tab_id);
        self.publish_tabs();
    }

    /// Detach the tab's root subtrees from the viewport. The nodes
    /// stay alive in the renderer's `Tree`; the tab's worker keeps
    /// applying patches to them; on `attach_tab` they pop back
    /// instantly. No-op when the tab is already detached or unknown.
    fn detach_tab(&self, tab_id: &str) {
        let patches: Vec<Patch> = {
            let mut inner = self.inner.lock().expect("inner poisoned");
            let Some(tab) = inner.tabs.get_mut(tab_id) else {
                return;
            };
            if !tab.attached {
                return;
            }
            tab.attached = false;
            tab.app_root_ids
                .iter()
                .map(|id| Patch::Detach { id: id.clone() })
                .collect()
        };
        if !patches.is_empty() {
            forward(&self.inner, &patches);
        }
    }

    /// Re-attach a previously-detached tab's roots to the viewport.
    /// No-op if the tab is already attached, unknown, or the
    /// viewport id hasn't been resolved yet (the patches will be
    /// flushed from `tab.queued` once the shell's first child
    /// renders).
    fn attach_tab(&self, tab_id: &str) {
        let patches: Vec<Patch> = {
            let mut inner = self.inner.lock().expect("inner poisoned");
            let Some(viewport) = inner.viewport_id.clone() else {
                if let Some(tab) = inner.tabs.get_mut(tab_id) {
                    // Mark intent so the eventual viewport-discovery
                    // flush forwards this tab's patches as attached.
                    tab.attached = true;
                }
                return;
            };
            let Some(tab) = inner.tabs.get_mut(tab_id) else {
                return;
            };
            if tab.attached {
                return;
            }
            tab.attached = true;
            tab.app_root_ids
                .iter()
                .map(|id| Patch::Attach {
                    parent_id: viewport.clone(),
                    id: id.clone(),
                    before_id: None,
                })
                .collect()
        };
        if !patches.is_empty() {
            forward(&self.inner, &patches);
        }
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
            self.close_tab_silent(&id);
        }
        {
            let mut inner = self.inner.lock().expect("inner poisoned");
            inner.active_tab_id = None;
        }
        self.publish_tabs();
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
            let infos: Vec<TabInfo> = inner.tabs.values().map(|t| t.info.clone()).collect();
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
        log::debug!(
            "hypen-browser: dispatch_action name={name} target={} \
             (thread={:?})",
            match target {
                DispatchTarget::Shell => "shell",
                DispatchTarget::Remote => "remote",
            },
            std::thread::current().name().unwrap_or("?"),
        );
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
                    // Debug console: record the outgoing action.
                    record_console(&self.shell, format!("▶ out  action {name}"));
                } else {
                    log::debug!("hypen-browser: ignoring action {name} — no active tab",);
                }
            }
        }
        // Drain any `ShellCommand`s the shell's handler enqueued
        // during the dispatch — this is what swaps the active tab
        // when the user opens / closes / switches.
        log::debug!("hypen-browser: draining shell commands after {name}");
        self.drain_commands();
        log::debug!("hypen-browser: dispatch_action {name} done");
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
/// One-line summary of a patch batch for the debug console, e.g.
/// `12 patches · 3 Create 5 SetProp 4 Insert`.
fn summarize_patches(patches: &[Patch]) -> String {
    use std::collections::BTreeMap;
    let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
    for p in patches {
        let kind = match p {
            Patch::Create { .. } => "Create",
            Patch::SetProp { .. } => "SetProp",
            Patch::RemoveProp { .. } => "RemoveProp",
            Patch::SetText { .. } => "SetText",
            Patch::Insert { .. } => "Insert",
            Patch::Move { .. } => "Move",
            Patch::Remove { .. } => "Remove",
            Patch::Detach { .. } => "Detach",
            Patch::Attach { .. } => "Attach",
            Patch::SetSemantics { .. } => "SetSemantics",
        };
        *counts.entry(kind).or_default() += 1;
    }
    let breakdown = counts
        .iter()
        .map(|(k, n)| format!("{n} {k}"))
        .collect::<Vec<_>>()
        .join(" ");
    format!("{} patches · {breakdown}", patches.len())
}

/// Render `tree` as an indented `<ElementType #id> "text"` outline,
/// one node per line, depth-first from the root. Used by the
/// `dump_tree` debug button.
fn serialize_tree(tree: &Tree) -> String {
    fn walk(tree: &Tree, id: &str, depth: usize, out: &mut String) {
        let indent = "  ".repeat(depth);
        if let Some(node) = tree.get(id) {
            let text = node
                .text_content()
                .map(|t| {
                    let t = t.trim();
                    let clipped: String = t.chars().take(40).collect();
                    format!(" \"{clipped}\"")
                })
                .unwrap_or_default();
            out.push_str(&format!("{indent}<{} #{}>{text}\n", node.element_type, id));
        } else {
            out.push_str(&format!("{indent}<? #{id}>\n"));
        }
        for child in tree.children_of(id) {
            walk(tree, child, depth + 1, out);
        }
    }
    let mut out = String::new();
    for root in tree.root_children() {
        walk(tree, root, 0, &mut out);
    }
    if out.is_empty() {
        out.push_str("(empty)\n");
    }
    out
}

fn forward(inner: &Arc<Mutex<Inner>>, patches: &[Patch]) {
    if patches.is_empty() {
        return;
    }
    log::trace!(
        "hypen-browser: forward({} patches, thread={:?}) — locking inner",
        patches.len(),
        std::thread::current().name().unwrap_or("?"),
    );
    let cb = {
        let mut g = inner.lock().expect("inner poisoned");
        // Keep the shadow tree in lockstep with what the renderer sees,
        // so the `dump_tree` debug button can serialise it on demand.
        g.tree.apply_batch(patches);
        if let Some(cb) = g.callback.as_ref() {
            Some(Arc::clone(cb))
        } else {
            log::debug!(
                "hypen-browser: forward buffered {} patches (no callback yet)",
                patches.len(),
            );
            g.pending.extend_from_slice(patches);
            None
        }
    };
    log::trace!("hypen-browser: forward released inner lock");
    if let Some(cb) = cb {
        log::trace!("hypen-browser: forward firing renderer callback");
        cb(patches);
        log::trace!("hypen-browser: forward renderer callback returned");
    }
}

/// Inspect shell patches as they flow through. We don't rewrite shell
/// IDs — the shell is the "primary" engine, owning the `"root"`
/// namespace — but we sniff for the first two structural inserts so
/// we can learn the viewport's renderer ID. Also flushes any per-tab
/// queued patches that were waiting on the viewport id.
fn process_shell_patches(inner: &Arc<Mutex<Inner>>, patches: &[Patch]) -> Vec<Patch> {
    log::trace!(
        "hypen-browser: process_shell_patches({} in, thread={:?}) — locking inner",
        patches.len(),
        std::thread::current().name().unwrap_or("?"),
    );
    let mut queued_flush: Vec<Patch> = Vec::new();
    {
        let mut g = inner.lock().expect("inner poisoned");
        log::trace!("hypen-browser: process_shell_patches inner locked");
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
                            // Drain every tab's queued patches into
                            // the outbound stream. We can't know each
                            // tab's `attached` from outside the loop
                            // without a second borrow, so capture it
                            // up front and append per-tab.
                            let tab_ids: Vec<String> = g.tabs.keys().cloned().collect();
                            for tid in tab_ids {
                                let (prefix, attached) = match g.tabs.get(&tid) {
                                    Some(t) => (t.id_prefix.clone(), t.attached),
                                    None => continue,
                                };
                                let drained: Vec<Patch> = match g.tabs.get_mut(&tid) {
                                    Some(t) => std::mem::take(&mut t.queued),
                                    None => continue,
                                };
                                let mut local_roots = Vec::new();
                                let rewritten = rewrite_tab_batch(
                                    drained,
                                    &prefix,
                                    &viewport,
                                    &mut local_roots,
                                );
                                if let Some(t) = g.tabs.get_mut(&tid) {
                                    t.app_root_ids.extend(local_roots.iter().cloned());
                                    // Filter out roots that were
                                    // Removed in the same drain.
                                    for p in &rewritten {
                                        if let Patch::Remove { id } = p {
                                            t.app_root_ids.retain(|tr| tr != id);
                                        }
                                    }
                                }
                                queued_flush.extend(rewritten);
                                // Background tabs: detach the freshly
                                // inserted roots so they don't flash
                                // into the viewport.
                                if !attached {
                                    for root in local_roots {
                                        queued_flush.push(Patch::Detach { id: root });
                                    }
                                }
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

/// Translate a tab's patches into the merged stream. The tab's
/// `attached` flag decides whether new root inserts stay linked to
/// the viewport or are immediately detached — inactive (background)
/// tabs apply their patches to the renderer's `Tree` so the subtree
/// stays current, but the subtree itself is unlinked so it isn't
/// drawn.
///
/// Returns the rewritten patches; returns empty when the tab isn't
/// known (worker fired after a close, for instance).
fn process_tab_patches(inner: &Arc<Mutex<Inner>>, tab_id: &str, patches: &[Patch]) -> Vec<Patch> {
    let mut g = inner.lock().expect("inner poisoned");
    let (prefix, attached) = match g.tabs.get(tab_id) {
        Some(t) => (t.id_prefix.clone(), t.attached),
        None => return Vec::new(),
    };
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
    let mut new_roots: Vec<String> = Vec::new();
    let mut rewritten = rewrite_tab_batch(patches.to_vec(), &prefix, &viewport, &mut new_roots);
    if let Some(tab) = g.tabs.get_mut(tab_id) {
        // Track new root ids so future Detach / Attach / Remove
        // patches know which ids to operate on.
        tab.app_root_ids.extend(new_roots.iter().cloned());
        // Filter out any roots that were just removed by the same
        // batch.
        for p in &rewritten {
            if let Patch::Remove { id } = p {
                tab.app_root_ids.retain(|tracked| tracked != id);
                // Also drop the matching pending new_root if the
                // worker emitted Create + Insert + Remove all in the
                // same batch (rare but possible).
                new_roots.retain(|nr| nr != id);
            }
        }
    }
    // Background tab: detach every fresh root so the user only sees
    // the active tab's tree. The renderer's Tree keeps the nodes
    // around; an Attach on switch-back puts them right back where
    // they were.
    if !attached {
        for id in new_roots {
            rewritten.push(Patch::Detach { id });
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

fn rewrite_patch(patch: Patch, prefix: &str, viewport: &str, new_roots: &mut Vec<String>) -> Patch {
    match patch {
        Patch::Create {
            id,
            element_type,
            props,
            semantics,
        } => Patch::Create {
            id: prefix_id(prefix, &id),
            element_type,
            props,
            semantics,
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
        Patch::SetSemantics { id, semantics } => Patch::SetSemantics {
            id: prefix_id(prefix, &id),
            semantics,
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
    log::debug!(
        "hypen-browser: update_tab_status({tab_id}) locking inner (thread={:?})",
        std::thread::current().name().unwrap_or("?"),
    );
    let mut g = inner.lock().expect("inner poisoned");
    log::debug!("hypen-browser: update_tab_status({tab_id}) inner locked");
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
    fn serialize_tree_renders_indented_outline() {
        let props = |entries: &[(&str, Value)]| {
            let mut m = IndexMap::new();
            for (k, v) in entries {
                m.insert((*k).to_string(), v.clone());
            }
            Arc::new(m)
        };
        let mut tree = Tree::new();
        tree.apply_batch(&[
            Patch::Create {
                id: "col".into(),
                element_type: "Column".into(),
                props: props(&[]),
                semantics: None,
            },
            Patch::Insert {
                parent_id: "root".into(),
                id: "col".into(),
                before_id: None,
            },
            Patch::Create {
                id: "t".into(),
                element_type: "Text".into(),
                props: props(&[("0", json!("Hello"))]),
                semantics: None,
            },
            Patch::Insert {
                parent_id: "col".into(),
                id: "t".into(),
                before_id: None,
            },
        ]);
        let dump = serialize_tree(&tree);
        assert!(dump.contains("<Column #col>"), "got:\n{dump}");
        assert!(dump.contains("  <Text #t> \"Hello\""), "got:\n{dump}");
        assert_eq!(serialize_tree(&Tree::new()), "(empty)\n");
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
                    attached: true,
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
                        attached: n == 3,
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

        module.dispatch_action("delete_recent", Some(json!({"url": "ws://a"})));

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

    /// Helper: directly insert a `Tab` into a freshly-built
    /// `BrowserModule` without spinning up a real `RemoteModule`.
    /// Used by every Detach/Attach test below — we never need a real
    /// WebSocket to exercise the patch-routing logic.
    fn install_tab(
        module: &Arc<BrowserModule>,
        id: &str,
        prefix: &str,
        roots: &[&str],
        attached: bool,
    ) {
        let mut inner = module.inner.lock().unwrap();
        inner.tabs.insert(
            id.into(),
            Tab {
                info: TabInfo {
                    id: id.into(),
                    url: format!("ws://{id}"),
                    name: id.into(),
                    status: "connected".into(),
                    status_message: String::new(),
                },
                id_prefix: prefix.into(),
                remote: None,
                app_root_ids: roots.iter().map(|s| (*s).to_string()).collect(),
                queued: Vec::new(),
                attached,
            },
        );
    }

    #[test]
    fn switch_tab_emits_detach_for_old_and_attach_for_new() {
        // Two tabs installed (no real RemoteModules). One active +
        // attached, one inactive + detached. Switching must Detach
        // the first and Attach the second — no Remove, no spinner.
        let (module, captured) = fresh_browser_with_capture();
        install_tab(&module, "tab-A", "a1:", &["a1:1", "a1:2"], true);
        install_tab(&module, "tab-B", "a2:", &["a2:1"], false);
        module.inner.lock().unwrap().active_tab_id = Some("tab-A".into());
        let viewport = module
            .inner
            .lock()
            .unwrap()
            .viewport_id
            .clone()
            .expect("viewport must be known after mount");
        let before = captured.lock().unwrap().len();

        module.dispatch_action("switch_tab", Some(json!({"tabId": "tab-B"})));

        let after = captured.lock().unwrap();
        let new_patches = &after[before..];
        let detaches: Vec<&str> = new_patches
            .iter()
            .filter_map(|p| match p {
                Patch::Detach { id } => Some(id.as_str()),
                _ => None,
            })
            .collect();
        let attaches: Vec<(&str, &str)> = new_patches
            .iter()
            .filter_map(|p| match p {
                Patch::Attach { parent_id, id, .. } => Some((parent_id.as_str(), id.as_str())),
                _ => None,
            })
            .collect();
        // Filter to Removes for the tabs' app subtrees (prefixed
        // `a1:` / `a2:`). The shell may legitimately Remove its own
        // overlay nodes when state-derived conditionals re-evaluate
        // (e.g. swapping the loading overlay for the connected app);
        // those aren't what this test guards against.
        let app_removes: Vec<&str> = new_patches
            .iter()
            .filter_map(|p| match p {
                Patch::Remove { id } if id.starts_with("a1:") || id.starts_with("a2:") => {
                    Some(id.as_str())
                }
                _ => None,
            })
            .collect();
        assert!(
            detaches.contains(&"a1:1") && detaches.contains(&"a1:2"),
            "old active tab's roots must be Detach'd; got {detaches:?}",
        );
        assert!(
            attaches.iter().any(|(p, i)| *p == viewport && *i == "a2:1"),
            "new tab's roots must be Attach'd under viewport; got {attaches:?}",
        );
        assert!(
            app_removes.is_empty(),
            "Detach/Attach swap must NOT Remove any tab app subtree; got {app_removes:?}",
        );

        // Active state flipped; both tabs still in the list.
        let inner = module.inner.lock().unwrap();
        assert_eq!(inner.active_tab_id.as_deref(), Some("tab-B"));
        assert_eq!(inner.tabs.len(), 2);
        assert!(!inner.tabs["tab-A"].attached);
        assert!(inner.tabs["tab-B"].attached);
    }

    #[test]
    fn switch_tab_to_already_active_is_a_noop() {
        let (module, captured) = fresh_browser_with_capture();
        install_tab(&module, "tab-A", "a1:", &["a1:1"], true);
        module.inner.lock().unwrap().active_tab_id = Some("tab-A".into());
        let before = captured.lock().unwrap().len();
        module.dispatch_action("switch_tab", Some(json!({"tabId": "tab-A"})));
        let after = captured.lock().unwrap();
        // Only the shell's own state-change patches (from the
        // optimistic `state.active_tab_id` assignment in
        // shell::switch_tab handler + the publish_tabs refresh) —
        // no Detach / Attach / Remove for the app subtree.
        let app_patches: usize = after[before..]
            .iter()
            .filter(|p| {
                matches!(
                    p,
                    Patch::Detach { id } if id.starts_with("a1:")
                ) || matches!(
                    p,
                    Patch::Attach { id, .. } if id.starts_with("a1:")
                ) || matches!(
                    p,
                    Patch::Remove { id } if id.starts_with("a1:")
                )
            })
            .count();
        assert_eq!(app_patches, 0, "self-switch must not touch app roots");
    }

    #[test]
    fn process_tab_patches_detaches_new_roots_for_inactive_tabs() {
        // An inactive tab receives an Insert(parent=root) from its
        // worker. The renderer must end up with the node created +
        // tracked but NOT linked to the viewport — implemented as
        // Insert(viewport) immediately followed by Detach.
        let (module, _captured) = fresh_browser_with_capture();
        install_tab(&module, "tab-bg", "a7:", &[], false);
        let viewport = module.inner.lock().unwrap().viewport_id.clone().unwrap();

        let in_patches = vec![
            Patch::Create {
                id: "1".into(),
                element_type: "Column".into(),
                props: Arc::new(IndexMap::new()),
                semantics: None,
            },
            Patch::Insert {
                parent_id: "root".into(),
                id: "1".into(),
                before_id: None,
            },
        ];
        let out = process_tab_patches(&module.inner, "tab-bg", &in_patches);

        // Expect: Create(a7:1), Insert(parent=viewport, id=a7:1), Detach(a7:1).
        assert_eq!(out.len(), 3, "got {out:?}");
        match &out[0] {
            Patch::Create { id, .. } => assert_eq!(id, "a7:1"),
            _ => panic!("expected Create, got {:?}", out[0]),
        }
        match &out[1] {
            Patch::Insert { parent_id, id, .. } => {
                assert_eq!(parent_id, &viewport);
                assert_eq!(id, "a7:1");
            }
            _ => panic!("expected Insert, got {:?}", out[1]),
        }
        match &out[2] {
            Patch::Detach { id } => assert_eq!(id, "a7:1"),
            _ => panic!(
                "expected trailing Detach for background tab; got {:?}",
                out[2]
            ),
        }

        // The id is tracked so future Attach (on switch-to) targets it.
        assert_eq!(
            module.inner.lock().unwrap().tabs["tab-bg"].app_root_ids,
            vec!["a7:1".to_string()],
        );
    }

    #[test]
    fn process_tab_patches_does_not_detach_active_tab_roots() {
        let (module, _captured) = fresh_browser_with_capture();
        install_tab(&module, "tab-fg", "a3:", &[], true);
        module.inner.lock().unwrap().active_tab_id = Some("tab-fg".into());

        let in_patches = vec![
            Patch::Create {
                id: "1".into(),
                element_type: "Text".into(),
                props: Arc::new(IndexMap::new()),
                semantics: None,
            },
            Patch::Insert {
                parent_id: "root".into(),
                id: "1".into(),
                before_id: None,
            },
        ];
        let out = process_tab_patches(&module.inner, "tab-fg", &in_patches);
        assert!(
            !out.iter().any(|p| matches!(p, Patch::Detach { .. })),
            "active tab's roots must NOT be Detach'd; got {out:?}",
        );
    }

    #[test]
    fn close_active_tab_attaches_next_survivor() {
        // Two tabs; close the active one; the surviving tab should
        // be promoted and re-attached so its tree comes back into
        // view (no reconnect).
        let (module, captured) = fresh_browser_with_capture();
        install_tab(&module, "tab-A", "a1:", &["a1:1"], true);
        install_tab(&module, "tab-B", "a2:", &["a2:1"], false);
        module.inner.lock().unwrap().active_tab_id = Some("tab-A".into());
        let viewport = module.inner.lock().unwrap().viewport_id.clone().unwrap();
        let before = captured.lock().unwrap().len();

        module.dispatch_action("close_tab", Some(json!({"tabId": "tab-A"})));

        let after = captured.lock().unwrap();
        let new_patches = &after[before..];
        // Removed roots are the closed tab's; attaches are the survivor's.
        let removed: Vec<&str> = new_patches
            .iter()
            .filter_map(|p| match p {
                Patch::Remove { id } => Some(id.as_str()),
                _ => None,
            })
            .collect();
        let attached_under_viewport: Vec<&str> = new_patches
            .iter()
            .filter_map(|p| match p {
                Patch::Attach { parent_id, id, .. } if *parent_id == viewport => Some(id.as_str()),
                _ => None,
            })
            .collect();
        assert!(
            removed.contains(&"a1:1"),
            "closed tab's root must be Removed; got {removed:?}"
        );
        assert!(
            attached_under_viewport.contains(&"a2:1"),
            "survivor's root must be Attach'd to viewport; got {attached_under_viewport:?}",
        );

        let inner = module.inner.lock().unwrap();
        assert_eq!(inner.active_tab_id.as_deref(), Some("tab-B"));
        assert!(inner.tabs["tab-B"].attached);
    }

    #[test]
    fn open_tab_detaches_previous_active_without_closing_it() {
        // The currently-active tab must keep its RemoteModule + node
        // tree when the user opens a fresh URL — switching back
        // (close the new tab) should restore it via Attach.
        let (module, captured) = fresh_browser_with_capture();
        install_tab(&module, "tab-A", "a1:", &["a1:1"], true);
        module.inner.lock().unwrap().active_tab_id = Some("tab-A".into());

        let before = captured.lock().unwrap().len();
        // We can't actually `open_tab` without spinning up a worker;
        // exercise just the detach side that open_tab calls.
        module.detach_tab("tab-A");

        let after = captured.lock().unwrap();
        let detaches: Vec<&str> = after[before..]
            .iter()
            .filter_map(|p| match p {
                Patch::Detach { id } => Some(id.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(detaches, vec!["a1:1"], "must Detach (not Remove)");

        // Tab still in the list, just not attached anymore.
        let inner = module.inner.lock().unwrap();
        assert!(inner.tabs.contains_key("tab-A"));
        assert!(!inner.tabs["tab-A"].attached);
        // And app_root_ids preserved so a later Attach can reuse them.
        assert_eq!(inner.tabs["tab-A"].app_root_ids, vec!["a1:1".to_string()]);
    }

    #[test]
    fn detach_then_attach_is_idempotent_when_already_in_state() {
        let (module, captured) = fresh_browser_with_capture();
        install_tab(&module, "tab-A", "a1:", &["a1:1"], false);
        let before = captured.lock().unwrap().len();
        // Already detached — must not emit a duplicate Detach.
        module.detach_tab("tab-A");
        assert_eq!(captured.lock().unwrap().len(), before);

        // Attaching for the first time emits one Attach; second call
        // is a no-op.
        module.attach_tab("tab-A");
        let after_first = captured.lock().unwrap().len();
        assert!(after_first > before);
        module.attach_tab("tab-A");
        assert_eq!(captured.lock().unwrap().len(), after_first);
    }

    #[test]
    fn on_patches_drains_shell_patches_buffered_before_wiring() {
        let storage = Storage::at_path(
            std::env::temp_dir().join(format!("hypen-browser-wireup-{}.json", std::process::id())),
        );
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
