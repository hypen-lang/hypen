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

use crate::embed::{
    embed_url, is_hypenapp, rewrite_embed_patch_actions, slot_of, split_embed_marker, Embed,
    EmbedStatus, MAX_EMBED_DEPTH,
};
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
    /// close. This includes Router-cached roots that are not currently
    /// visible.
    app_root_ids: Vec<String>,
    /// Root ids the remote app currently considers visible. A Router can
    /// leave several entries in `app_root_ids` while only one route is linked
    /// to `root`; tab suspension must restore this set, not every cached root.
    active_root_ids: Vec<String>,
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
    /// Lowers `RegisterTemplate`/`Instantiate` from the tab's server
    /// into the plain `Create`+`Insert` runs the id-rewriting and the
    /// desktop renderer consume. Remote servers should expand before
    /// streaming, but a raw host may not — one expander per tab
    /// (per session) makes the merged stream template-free either way.
    expander: hypen_engine::TemplateExpander,
}

fn track_tab_roots(tab: &mut Tab, patches: &[Patch], viewport: &str) {
    for patch in patches {
        match patch {
            Patch::Insert { parent_id, id, .. }
            | Patch::Attach { parent_id, id, .. }
            | Patch::Move { parent_id, id, .. }
                if parent_id.as_ref() == viewport =>
            {
                if !tab.app_root_ids.iter().any(|root| root == id.as_ref()) {
                    tab.app_root_ids.push(id.to_string());
                }
                if !tab.active_root_ids.iter().any(|root| root == id.as_ref()) {
                    tab.active_root_ids.push(id.to_string());
                }
            }
            Patch::Detach { id } => {
                tab.active_root_ids
                    .retain(|root| root.as_str() != id.as_ref());
            }
            Patch::Remove { id, .. } => {
                tab.app_root_ids.retain(|root| root.as_str() != id.as_ref());
                tab.active_root_ids
                    .retain(|root| root.as_str() != id.as_ref());
            }
            _ => {}
        }
    }
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
    /// Live `HypenApp` embeds keyed by their marker/prefix (`e1:`).
    /// Registered when a HypenApp Create flows through any stream
    /// (tab or parent embed); torn down when the host node is
    /// Removed or the owning tab closes.
    embeds: IndexMap<String, Embed>,
    /// Monotonic counter for embed marker allocation. Never reused, so
    /// a stale action name can't route to a fresh embed.
    next_embed_id: u64,
    /// `detached id → parent at detach time`. `Tree::apply(Detach)`
    /// deletes the `parent_by_child` entry, so an ancestor walk through
    /// the shadow tree dead-ends at every detach boundary; this map
    /// bridges those gaps so a `Remove` above a cached (Detached) route
    /// still tears down the embeds inside it. Maintained by the embed
    /// lifecycle scan (server-stream Detach/Attach) and by the slot
    /// reconcile paths (our own Detaches).
    detached_parents: std::collections::HashMap<String, String>,
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
            embeds: IndexMap::new(),
            next_embed_id: 1,
            detached_parents: std::collections::HashMap::new(),
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
            let mut forwarded = process_shell_patches(&inner_for_shell, patches);
            // The pre-viewport flush can carry tab batches (and thus
            // HypenApp creates) — run the embed lifecycle over the
            // combined stream. Shell-origin ids carry no stream prefix,
            // so shell patches are inert to the scan.
            let lifecycle = handle_embed_lifecycle(&inner_for_shell, &forwarded);
            forwarded.extend(lifecycle.extra);
            forward(&inner_for_shell, &forwarded);
            // The host Create/Insert must reach the renderer before a fast
            // embedded worker can send children targeting that host.
            for marker in lifecycle.to_connect {
                connect_embed(&inner_for_shell, marker);
            }
        });

        Arc::new(Self {
            shell,
            cmd_rx: Mutex::new(cmd_rx),
            inner,
            storage: Arc::new(Mutex::new(storage)),
            next_tab_prefix_id: AtomicU64::new(1),
        })
    }

    /// Open `raw` in a fresh tab as if the user had typed it into the
    /// address bar — used by the binary for a URL passed on the command
    /// line (`hypen-browser ws://localhost:3000`, what `hypen run
    /// desktop` invokes). Safe to call before the renderer wires
    /// `on_patches`: shell patches buffer in `Inner::pending` until then.
    pub fn open_url(&self, raw: &str) {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return;
        }
        let url = crate::storage::normalize_url(trimmed);
        let name = crate::storage::pretty_name(&url);
        self.open_tab(url, name);
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
            active_root_ids: Vec::new(),
            queued: Vec::new(),
            // Brand-new tab is active and its patches go straight to
            // the viewport — no Detach needed for incoming root
            // inserts.
            attached: true,
            expander: hypen_engine::TemplateExpander::new(),
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
            let mut rewritten = process_tab_patches(&inner_for_remote, &tab_id_for_remote, patches);
            // HypenApp embeds: register / tear down any the batch
            // creates or removes, and reconcile their slot visibility.
            let lifecycle = handle_embed_lifecycle(&inner_for_remote, &rewritten);
            rewritten.extend(lifecycle.extra);
            log::debug!(
                "hypen-browser: tab {tab_id_for_remote} rewritten {} → forwarding",
                rewritten.len(),
            );
            if !rewritten.is_empty() {
                forward(&inner_for_remote, &rewritten);
            }
            for marker in lifecycle.to_connect {
                connect_embed(&inner_for_remote, marker);
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
        let (removed, dead_embeds, mut embed_detached) = {
            let mut inner = self.inner.lock().expect("inner poisoned");
            let removed = inner.tabs.shift_remove(tab_id);
            // Tear down the tab's embeds too — transitively, so an
            // embed hosted inside another embed dies with the tab.
            // Linked embed nodes are descendants of the tab's roots
            // and die with the Removes below; anything an embed
            // Detached (slot children, errored roots) sits in no
            // children list and needs its own Remove, or it leaks.
            let mut dead: Vec<Embed> = Vec::new();
            let mut detached_ids: Vec<String> = Vec::new();
            if let Some(tab) = removed.as_ref() {
                let mut owners: Vec<String> = vec![tab.id_prefix.clone()];
                while let Some(owner) = owners.pop() {
                    let doomed: Vec<String> = inner
                        .embeds
                        .iter()
                        .filter(|(_, e)| e.owner_prefix == owner)
                        .map(|(m, _)| m.clone())
                        .collect();
                    for marker in doomed {
                        if let Some(e) = inner.embeds.shift_remove(&marker) {
                            owners.push(e.id_prefix.clone());
                            detached_ids.extend(e.detached.iter().cloned());
                            dead.push(e);
                        }
                    }
                }
                // Drop the detach-bridge entries the closing tab owned
                // (server-cached routes and dead embeds' slots alike).
                let tab_prefix = tab.id_prefix.clone();
                let dead_prefixes: Vec<String> = dead.iter().map(|e| e.id_prefix.clone()).collect();
                inner.detached_parents.retain(|k, _| {
                    !k.starts_with(&tab_prefix)
                        && !dead_prefixes.iter().any(|p| k.starts_with(p.as_str()))
                });
            }
            (removed, dead, detached_ids)
        };
        drop(dead_embeds);
        let Some(tab) = removed else {
            return;
        };
        // Only attached tabs have nodes linked into the viewport;
        // detached tabs' nodes still live in `Tree.nodes` but aren't
        // children of anything, so `Remove` still tears them down via
        // `remove_subtree`. Either way we send Remove for each id.
        let mut removes: Vec<Patch> = tab
            .app_root_ids
            .iter()
            .map(|id| Patch::Remove {
                id: id.as_str().into(),
                transition: false,
            })
            .collect();
        embed_detached.sort();
        embed_detached.dedup();
        removes.extend(embed_detached.into_iter().map(|id| Patch::Remove {
            id: id.into(),
            transition: false,
        }));
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
            tab.active_root_ids
                .iter()
                .map(|id| Patch::Detach {
                    id: id.as_str().into(),
                })
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
            tab.active_root_ids
                .iter()
                .map(|id| Patch::Attach {
                    parent_id: viewport.as_str().into(),
                    id: id.as_str().into(),
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
            let mut inner = self.inner.lock().expect("inner poisoned");
            // Publish Home BEFORE removing the active app roots. Removing
            // first produces a real empty-viewport frame between the two
            // synchronous shell callbacks; the native window can present and
            // retain that dark frame even though the final merged Tree is
            // correct. With no active tab the shell immediately inserts the
            // Previous Visits surface while the old roots are still alive,
            // then the teardown below removes those roots behind it.
            inner.active_tab_id = None;
            inner.tabs.keys().cloned().collect()
        };
        self.publish_tabs();
        for id in ids {
            // Each close drops its own RemoteModule + emits Removes.
            // We accept the O(n^2) shift_remove cost — `tabs` is
            // user-driven and won't exceed a handful of entries.
            self.close_tab_silent(&id);
        }
        // Final pass removes the now-closed tabs from the strip and changes
        // the collapsed chip from an empty tab URL to the labelled Home pill.
        self.publish_tabs();
    }

    fn delete_recent(&self, url: &str) {
        if let Ok(mut s) = self.storage.lock() {
            s.remove_by_url(url);
            push_recents(&self.shell, s.recent().to_vec());
        }
    }

    /// Route a dispatched action to the embed its marker names.
    /// Returns `false` when the name (or bind path) carries no live
    /// embed marker, so the normal shell/tab routing takes over.
    fn try_dispatch_embed(&self, name: &str, payload: &Option<Value>) -> bool {
        // Two shapes: `e3:playFeatured` (an @actions / @router ref) and
        // `__hypen_bind` whose payload path is `e3:query`.
        let (remote, name, payload) = {
            let g = self.inner.lock().expect("inner poisoned");
            if name == "__hypen_bind" {
                let Some(path) = payload
                    .as_ref()
                    .and_then(|p| p.get("path"))
                    .and_then(|p| p.as_str())
                else {
                    return false;
                };
                let Some((marker, rest)) = split_embed_marker(path, |m| g.embeds.contains_key(m))
                else {
                    return false;
                };
                let Some(remote) = g
                    .embeds
                    .get(&marker)
                    .and_then(|e| e.remote.as_ref().map(Arc::clone))
                else {
                    return true; // marker matched but worker gone — swallow
                };
                let mut rewritten = payload.clone().unwrap_or(Value::Null);
                if let Some(obj) = rewritten.as_object_mut() {
                    obj.insert("path".into(), Value::String(rest.to_string()));
                }
                (remote, "__hypen_bind".to_string(), Some(rewritten))
            } else {
                let Some((marker, rest)) = split_embed_marker(name, |m| g.embeds.contains_key(m))
                else {
                    return false;
                };
                let Some(remote) = g
                    .embeds
                    .get(&marker)
                    .and_then(|e| e.remote.as_ref().map(Arc::clone))
                else {
                    return true;
                };
                (remote, rest.to_string(), payload.clone())
            }
        };
        log::debug!("hypen-browser: dispatch_action {name} → embed");
        let payload_summary = payload
            .as_ref()
            .map(|value| format!(" payload={value}"))
            .unwrap_or_default();
        remote.dispatch_action(&name, payload);
        record_console(
            &self.shell,
            format!("▶ out  embed action {name}{payload_summary}"),
        );
        true
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
        // HypenApp embeds first: action names (and `__hypen_bind`
        // paths) from embedded subtrees carry the embed's marker —
        // spliced in by `rewrite_embed_patch_actions` — because the
        // renderer's dispatch path has no node identity to route by.
        if self.try_dispatch_embed(name, &payload) {
            return;
        }
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
            Patch::BatchAnimation { .. } => "BatchAnimation",
            Patch::RegisterTemplate { .. } => "RegisterTemplate",
            Patch::Instantiate { .. } => "Instantiate",
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
                if parent_id.as_ref() == ROOT_ID && g.shell_root_id.is_none() {
                    g.shell_root_id = Some(id.to_string());
                } else if !g.seen_first_root_child {
                    if let Some(root) = g.shell_root_id.as_deref() {
                        if parent_id.as_ref() == root {
                            let viewport = id.to_string();
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
                                    track_tab_roots(t, &rewritten, &viewport);
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
    // Lower template patches first so everything downstream — the
    // pre-viewport buffer included — carries the plain wire.
    let patches: Vec<Patch> = match g.tabs.get_mut(tab_id) {
        Some(t) => t.expander.expand(patches.to_vec()),
        None => return Vec::new(),
    };
    let (prefix, attached, source_url) = match g.tabs.get(tab_id) {
        Some(t) => (t.id_prefix.clone(), t.attached, t.info.url.clone()),
        None => return Vec::new(),
    };
    // DOM clients resolve `/poster/foo` and other root-relative media URLs
    // against the page origin. A native renderer has no document URL, so do
    // that small browser responsibility here while the owning tab endpoint is
    // still known. This is what makes Hypeflix's same-origin poster proxy work
    // in the Desktop Browser instead of handing the image loader `/poster/foo`.
    let patches = absolutize_tab_media_urls(patches, &source_url);
    let viewport = match g.viewport_id.clone() {
        Some(v) => v,
        None => {
            // Shell hasn't rendered yet; buffer per-tab so we can
            // replay once we learn the viewport id.
            if let Some(tab) = g.tabs.get_mut(tab_id) {
                tab.queued.extend_from_slice(&patches);
            }
            return Vec::new();
        }
    };
    let mut new_roots: Vec<Arc<str>> = Vec::new();
    let rewritten = rewrite_tab_batch(patches, &prefix, &viewport, &mut new_roots);
    let created: std::collections::HashSet<&str> = rewritten
        .iter()
        .filter_map(|patch| match patch {
            Patch::Create { id, .. } => Some(id.as_ref()),
            _ => None,
        })
        .collect();
    // A normal Router transition also creates/inserts a new root, but it
    // Detaches the previous route in the same batch so it can Attach it on
    // Back/Home. Treating that Create as a reconnect replacement destroys the
    // cached route immediately and turns the later Attach into a black frame.
    // A genuine reconnect InitialTree has fresh root Creates without a route
    // cache Detach, so it remains the replacement signal.
    let has_route_cache_detach = rewritten
        .iter()
        .any(|patch| matches!(patch, Patch::Detach { .. }));
    let has_replacement_root =
        !has_route_cache_detach && new_roots.iter().any(|root| created.contains(root.as_ref()));
    let mut prelude = Vec::new();
    if let Some(tab) = g.tabs.get_mut(tab_id) {
        // A hibernated/reconnected server re-sends an InitialTree while the
        // Browser still owns the previous tree. Replace those roots before
        // applying the new Create/Insert batch; otherwise the two sessions'
        // trees stack (and same-id restarts leave stale descendants behind).
        // An Attach is deliberately not a replacement signal.
        if has_replacement_root && !tab.app_root_ids.is_empty() {
            for old in tab.app_root_ids.drain(..) {
                prelude.push(Patch::Remove {
                    id: old.into(),
                    transition: false,
                });
            }
            tab.active_root_ids.clear();
        }
        // Keep ownership (all cached Router roots) separate from the remote
        // app's currently linked route. Browser tab suspension restores only
        // `active_root_ids`; otherwise switching back to a HomeScreen tab
        // revives Hypeflix, Social, MovieDB, etc. at the same time.
        track_tab_roots(tab, &rewritten, &viewport);
        // Drop pending roots removed by the same batch before the background
        // tab visibility pass below.
        for p in &rewritten {
            if let Patch::Remove { id, .. } = p {
                new_roots.retain(|nr| nr != id);
            }
        }
    }
    // Background tab: detach every fresh root so the user only sees
    // the active tab's tree. The renderer's Tree keeps the nodes
    // around; an Attach on switch-back puts them right back where
    // they were.
    let mut out = prelude;
    out.extend(rewritten);
    if !attached {
        for id in new_roots {
            out.push(Patch::Detach { id });
        }
    }
    out
}

/// Resolve root-relative Image/Video media props against a tab's WebSocket
/// endpoint (`wss:` → `https:`, `ws:` → `http:`). The renderer deliberately
/// stays transport-agnostic; only the Browser knows which remote origin owns a
/// streamed tree.
fn absolutize_tab_media_urls(patches: Vec<Patch>, endpoint: &str) -> Vec<Patch> {
    let Some((http_scheme, authority)) = websocket_http_origin(endpoint) else {
        return patches;
    };

    let resolve = |value: &mut Value| {
        let Value::String(raw) = value else { return };
        if raw.starts_with("//") {
            *raw = format!("{http_scheme}:{raw}");
        } else if raw.starts_with('/') {
            *raw = format!("{http_scheme}://{authority}{raw}");
        }
    };
    let is_media_prop = |name: &str| {
        matches!(
            hypen_engine::portable::parse_prop_key(name).base.as_str(),
            "src" | "poster"
        )
    };

    patches
        .into_iter()
        .map(|patch| match patch {
            Patch::Create {
                id,
                element_type,
                props,
                semantics,
            } => {
                let is_media = matches!(
                    element_type.to_ascii_lowercase().as_str(),
                    "image" | "video" | "audio"
                );
                if !is_media {
                    return Patch::Create {
                        id,
                        element_type,
                        props,
                        semantics,
                    };
                }
                let mut resolved = (*props).clone();
                for (name, value) in resolved.iter_mut() {
                    if is_media_prop(name) {
                        resolve(value);
                    }
                }
                Patch::Create {
                    id,
                    element_type,
                    props: Arc::new(resolved),
                    semantics,
                }
            }
            Patch::SetProp {
                id,
                name,
                mut value,
            } if is_media_prop(&name) => {
                resolve(&mut value);
                Patch::SetProp { id, name, value }
            }
            other => other,
        })
        .collect()
}

fn websocket_http_origin(endpoint: &str) -> Option<(&'static str, &str)> {
    let (scheme, rest) = if let Some(rest) = endpoint.strip_prefix("wss://") {
        ("https", rest)
    } else if let Some(rest) = endpoint.strip_prefix("ws://") {
        ("http", rest)
    } else {
        return None;
    };
    let authority = rest.split('/').next()?.split('?').next()?;
    (!authority.is_empty()).then_some((scheme, authority))
}

// ---------------------------------------------------------------------------
// HypenApp embeds
// ---------------------------------------------------------------------------

/// The stream prefix a rewritten id carries (`"a1:12"` → `"a1:"`).
/// `None` for shell-origin ids, which are never prefixed.
fn stream_prefix_of(id: &str) -> Option<String> {
    id.find(':').map(|i| id[..=i].to_string())
}

/// How many embed hops sit above `owner_prefix` (a tab prefix is depth
/// 0). Guards against an app that embeds itself recursively.
fn embed_depth(embeds: &IndexMap<String, Embed>, owner_prefix: &str) -> usize {
    let mut depth = 0;
    let mut current = owner_prefix.to_string();
    while let Some(e) = embeds.get(&current) {
        depth += 1;
        if depth > MAX_EMBED_DEPTH {
            break;
        }
        current = e.owner_prefix.clone();
    }
    depth
}

/// Mirror a slot-reconcile batch into `detached_parents`: the ids we
/// Detach are host children, so the host is their bridge parent for
/// the Remove-scan's ancestor walk; an Attach makes them live again.
fn track_reconcile(
    detached_parents: &mut std::collections::HashMap<String, String>,
    host: &str,
    patches: &[Patch],
) {
    for p in patches {
        match p {
            Patch::Detach { id } => {
                detached_parents.insert(id.to_string(), host.to_string());
            }
            Patch::Attach { id, .. } => {
                detached_parents.remove(id.as_ref());
            }
            _ => {}
        }
    }
}

/// Scan an already-rewritten batch for embed lifecycle events:
///
/// * a `HypenApp` Create registers a new embed (connected after the
///   lock is released, exactly like `open_tab` does for tabs);
/// * an Insert / Attach of a direct child under a known host records
///   the child's slot tag and reconciles visibility;
/// * a Remove whose subtree contains a host tears the embed down
///   (its nodes die with the subtree; we just drop the worker).
///
/// Returns extra patches (slot Detach / Attach) to append to the batch
/// — they touch ids the batch just inserted, so they must ride in the
/// same forward() call to stay ordered.
#[derive(Default)]
struct EmbedLifecycle {
    extra: Vec<Patch>,
    to_connect: Vec<String>,
}

fn handle_embed_lifecycle(inner: &Arc<Mutex<Inner>>, batch: &[Patch]) -> EmbedLifecycle {
    use std::collections::HashMap;

    let mut extra: Vec<Patch> = Vec::new();
    let mut to_connect: Vec<String> = Vec::new();
    let mut torn_down: Vec<Embed> = Vec::new();
    {
        let mut g = inner.lock().expect("inner poisoned");
        // Props of nodes created in THIS batch — slot children are
        // created alongside their Insert, before `forward` has applied
        // anything to the shadow tree.
        let mut created: HashMap<&str, &Arc<IndexMap<String, Value>>> = HashMap::new();
        for patch in batch {
            match patch {
                Patch::Create {
                    id,
                    element_type,
                    props,
                    ..
                } => {
                    created.insert(id.as_ref(), props);
                    if !is_hypenapp(element_type) {
                        continue;
                    }
                    let Some(owner_prefix) = stream_prefix_of(id) else {
                        // Shell-origin id — the shell can't embed.
                        continue;
                    };
                    // A re-Create of a host that already has a live
                    // embed (tab server restarted and re-sent its tree
                    // with the same ids) REPLACES it: tear the old one
                    // down and reclaim its grafted / detached nodes so
                    // the fresh embed doesn't render alongside stale
                    // content or leak subtrees.
                    let stale: Option<String> = g
                        .embeds
                        .iter()
                        .find(|(_, e)| e.host_id.as_str() == id.as_ref())
                        .map(|(m, _)| m.clone());
                    if let Some(old_marker) = stale {
                        if let Some(old) = g.embeds.shift_remove(&old_marker) {
                            log::info!(
                                "hypen-browser: embed {old_marker} replaced (host {id} re-created)",
                            );
                            for stale_id in old.app_root_ids.iter().chain(old.detached.iter()) {
                                g.detached_parents.remove(stale_id);
                                extra.push(Patch::Remove {
                                    id: stale_id.as_str().into(),
                                    transition: false,
                                });
                            }
                            torn_down.push(old);
                        }
                    }
                    if embed_depth(&g.embeds, &owner_prefix) >= MAX_EMBED_DEPTH {
                        log::warn!(
                            "hypen-browser: HypenApp at {id} exceeds max embed depth \
                             ({MAX_EMBED_DEPTH}); not connecting",
                        );
                        continue;
                    }
                    let Some(url) = embed_url(props) else {
                        log::warn!("hypen-browser: HypenApp at {id} has no url prop");
                        continue;
                    };
                    let marker = format!("e{}:", g.next_embed_id);
                    g.next_embed_id += 1;
                    log::info!(
                        "hypen-browser: embed {marker} → {url} (host {id}, owner {owner_prefix})",
                    );
                    g.embeds.insert(
                        marker.clone(),
                        Embed::new(marker.clone(), id.to_string(), owner_prefix, url),
                    );
                    to_connect.push(marker);
                }
                Patch::Detach { id } => {
                    // `Tree::apply(Detach)` deletes the parent link, so
                    // remember it — the Remove-scan's ancestor walk
                    // needs to cross detach boundaries (a cached route
                    // holding an embed, removed via an ancestor).
                    if let Some(parent) = g.tree.parent_of(id) {
                        let parent = parent.to_string();
                        g.detached_parents.insert(id.to_string(), parent);
                    }
                }
                Patch::Insert { parent_id, id, .. } | Patch::Attach { parent_id, id, .. } => {
                    // Re-linked — the node is reachable through live
                    // parent links again.
                    g.detached_parents.remove(id.as_ref());
                    let Some((marker, embed_prefix)) = g
                        .embeds
                        .iter()
                        .find(|(_, e)| e.host_id.as_str() == parent_id.as_ref())
                        .map(|(m, e)| (m.clone(), e.id_prefix.clone()))
                    else {
                        continue;
                    };
                    // Only host-owned children get slot handling; the
                    // embed's own roots are tracked by
                    // `process_embed_patches` and skipped here.
                    if id.as_ref().starts_with(embed_prefix.as_str()) {
                        continue;
                    }
                    let slot = created
                        .get(id.as_ref())
                        .and_then(|p| slot_of(p))
                        .map(str::to_string);
                    // Fall back to the shadow tree for children that
                    // were created in an earlier batch (router-cache
                    // re-attach).
                    let slot = slot.or_else(|| {
                        g.tree
                            .get(id)
                            .and_then(|n| {
                                n.props
                                    .get("slot.0")
                                    .or_else(|| n.props.get("slot"))
                                    .and_then(|v| v.as_str())
                            })
                            .map(str::to_string)
                    });
                    let Some(embed) = g.embeds.get_mut(&marker) else {
                        continue;
                    };
                    match slot.as_deref() {
                        Some("loading") => {
                            if !embed.loading_slot_ids.iter().any(|s| s == id.as_ref()) {
                                embed.loading_slot_ids.push(id.to_string());
                            }
                        }
                        Some("error") => {
                            if !embed.error_slot_ids.iter().any(|s| s == id.as_ref()) {
                                embed.error_slot_ids.push(id.to_string());
                            }
                        }
                        _ => continue,
                    }
                    let host = embed.host_id.clone();
                    let patches = embed.reconcile_visibility();
                    track_reconcile(&mut g.detached_parents, &host, &patches);
                    extra.extend(patches);
                }
                Patch::Remove { id, .. } => {
                    // Tear down every embed whose host sits inside the
                    // removed subtree. The shadow tree hasn't applied
                    // this batch yet, so live ancestor chains are
                    // intact; `detached_parents` bridges the gaps
                    // Detach cut (a cached route holding an embed,
                    // removed via an ancestor above the detach point).
                    let doomed: Vec<String> = g
                        .embeds
                        .iter()
                        .filter(|(_, e)| {
                            let mut cur = Some(e.host_id.as_str());
                            while let Some(c) = cur {
                                if c == id.as_ref() {
                                    return true;
                                }
                                cur = g
                                    .tree
                                    .parent_of(c)
                                    .or_else(|| g.detached_parents.get(c).map(String::as_str));
                            }
                            false
                        })
                        .map(|(marker, _)| marker.clone())
                        .collect();
                    for marker in doomed {
                        if let Some(e) = g.embeds.shift_remove(&marker) {
                            log::info!(
                                "hypen-browser: embed {marker} torn down (host {} removed)",
                                e.host_id,
                            );
                            // The subtree Remove reclaims linked nodes
                            // only — anything this embed Detached (slot
                            // children while connected, roots while
                            // errored) sits in no children list and
                            // must be removed explicitly or it leaks.
                            for d in &e.detached {
                                g.detached_parents.remove(d);
                                extra.push(Patch::Remove {
                                    id: d.as_str().into(),
                                    transition: false,
                                });
                            }
                            torn_down.push(e);
                        }
                        to_connect.retain(|m| m != &marker);
                    }
                    g.detached_parents.remove(id.as_ref());
                }
                _ => {}
            }
        }
    }
    // Dropping a RemoteModule Arc shuts down its worker — do it
    // outside the lock, like `close_tab_silent`.
    drop(torn_down);
    EmbedLifecycle { extra, to_connect }
}

/// Open the embed's WebSocket and wire its callbacks. Runs without the
/// inner lock held (mirrors `open_tab`): the worker thread's callbacks
/// take the lock themselves.
fn connect_embed(inner: &Arc<Mutex<Inner>>, marker: String) {
    let url = {
        let g = inner.lock().expect("inner poisoned");
        match g.embeds.get(&marker) {
            Some(e) => e.url.clone(),
            // Torn down before we got here (host removed in the same
            // batch) — nothing to connect.
            None => return,
        }
    };
    let remote = Arc::new(RemoteModule::connect(url, "App"));

    let inner_for_patches = Arc::clone(inner);
    let marker_for_patches = marker.clone();
    remote.on_patches(Arc::new(move |patches: &[Patch]| {
        let mut rewritten = process_embed_patches(&inner_for_patches, &marker_for_patches, patches);
        // Embedded apps can embed further apps.
        let lifecycle = handle_embed_lifecycle(&inner_for_patches, &rewritten);
        rewritten.extend(lifecycle.extra);
        if !rewritten.is_empty() {
            forward(&inner_for_patches, &rewritten);
        }
        for marker in lifecycle.to_connect {
            connect_embed(&inner_for_patches, marker);
        }
    }));

    let inner_for_status = Arc::clone(inner);
    let marker_for_status = marker.clone();
    remote.on_status(move |status| {
        let error = matches!(status, ConnectionStatus::Failed { .. });
        log::info!("hypen-browser: embed {marker_for_status} status -> {status:?}");
        if !error {
            // Loading stays until the first patch batch; reconnects
            // keep showing the last live tree, like the web embed.
            return;
        }
        let patches = {
            let mut g = inner_for_status.lock().expect("inner poisoned");
            let Some(embed) = g.embeds.get_mut(&marker_for_status) else {
                return;
            };
            embed.status = EmbedStatus::Error;
            let host = embed.host_id.clone();
            let patches = embed.reconcile_visibility();
            track_reconcile(&mut g.detached_parents, &host, &patches);
            patches
        };
        if !patches.is_empty() {
            forward(&inner_for_status, &patches);
        }
    });

    remote.mount();

    let stale = {
        let mut g = inner.lock().expect("inner poisoned");
        match g.embeds.get_mut(&marker) {
            Some(e) => {
                e.remote = Some(remote);
                None
            }
            // Embed vanished while we were connecting — drop the
            // fresh worker immediately.
            None => Some(remote),
        }
    };
    drop(stale);
}

/// Translate one embed's patches into the merged stream: template
/// expansion, id prefixing, re-rooting onto the HypenApp host node,
/// and action-name marking — plus replacement-root handling for
/// reconnects and the loading→connected slot flip on the first batch.
fn process_embed_patches(inner: &Arc<Mutex<Inner>>, marker: &str, patches: &[Patch]) -> Vec<Patch> {
    let mut g = inner.lock().expect("inner poisoned");
    let Some(embed) = g.embeds.get_mut(marker) else {
        return Vec::new();
    };
    let patches = embed.expander.expand(patches.to_vec());
    let patches = absolutize_tab_media_urls(patches, &embed.url);
    let prefix = embed.id_prefix.clone();
    let host = embed.host_id.clone();

    let mut new_roots: Vec<Arc<str>> = Vec::new();
    let rewritten: Vec<Patch> = rewrite_tab_batch(patches, &prefix, &host, &mut new_roots)
        .into_iter()
        .map(|p| rewrite_embed_patch_actions(p, &prefix))
        .collect();

    let embed = g.embeds.get_mut(marker).expect("embed still present");

    // A fresh root created in this batch while old roots exist means
    // the server re-sent its tree (reconnect / new session): replace,
    // don't stack.
    let created: std::collections::HashSet<&str> = rewritten
        .iter()
        .filter_map(|p| match p {
            Patch::Create { id, .. } => Some(id.as_ref()),
            _ => None,
        })
        .collect();
    let mut prelude: Vec<Patch> = Vec::new();
    // A root CREATED in this batch (an Attach never counts) means the
    // server re-sent its tree — a fresh session after a reconnect.
    // That holds even when the fresh session reuses the same node ids
    // (engines restart NodeId allocation, so re-sent roots usually DO
    // collide): remove every old root first, or nodes present only in
    // the old session would linger under the host. The same-id root's
    // prelude Remove is immediately followed by its re-Create in the
    // batch, so nothing flashes.
    // A normal Router transition creates the incoming route root while
    // detaching the outgoing root in the same batch. Preserve that cached
    // root; a reconnect InitialTree creates a root without a route Detach.
    let has_route_cache_detach = rewritten
        .iter()
        .any(|patch| matches!(patch, Patch::Detach { .. }));
    let has_replacement_root =
        !has_route_cache_detach && new_roots.iter().any(|r| created.contains(r.as_ref()));
    if has_replacement_root && !embed.app_root_ids.is_empty() {
        for old in embed.app_root_ids.drain(..) {
            embed.detached.remove(&old);
            prelude.push(Patch::Remove {
                id: old.into(),
                transition: false,
            });
        }
        embed.active_root_ids.clear();
    }
    // Ownership and visibility are separate: Router Detach keeps an owned
    // root cached but removes it from the active set. Status recovery may
    // re-attach only the roots the remote app currently considers active.
    for p in &rewritten {
        match p {
            Patch::Insert { parent_id, id, .. }
            | Patch::Attach { parent_id, id, .. }
            | Patch::Move { parent_id, id, .. }
                if parent_id.as_ref() == host =>
            {
                if !embed.app_root_ids.iter().any(|root| root == id.as_ref()) {
                    embed.app_root_ids.push(id.to_string());
                }
                if !embed.active_root_ids.iter().any(|root| root == id.as_ref()) {
                    embed.active_root_ids.push(id.to_string());
                }
                embed.detached.remove(id.as_ref());
            }
            Patch::Detach { id } if embed.app_root_ids.iter().any(|root| root == id.as_ref()) => {
                embed
                    .active_root_ids
                    .retain(|root| root.as_str() != id.as_ref());
                embed.detached.insert(id.to_string());
            }
            Patch::Remove { id, .. } => {
                embed.app_root_ids.retain(|r| r.as_str() != id.as_ref());
                embed
                    .active_root_ids
                    .retain(|root| root.as_str() != id.as_ref());
                embed.detached.remove(id.as_ref());
            }
            _ => {}
        }
    }

    // First live batch: the embedded tree owns the frame now.
    let mut out = prelude;
    out.extend(rewritten);
    if embed.status != EmbedStatus::Connected {
        embed.status = EmbedStatus::Connected;
        out.extend(embed.reconcile_visibility());
    }
    out
}

/// Rewrite a whole batch of tab-origin patches. `new_roots` collects
/// the ids that became children of the shell's viewport.
fn rewrite_tab_batch(
    patches: Vec<Patch>,
    prefix: &str,
    viewport: &str,
    new_roots: &mut Vec<Arc<str>>,
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
    new_roots: &mut Vec<Arc<str>>,
) -> Patch {
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
        Patch::Remove { id, transition } => Patch::Remove {
            id: prefix_id(prefix, &id),
            transition,
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
        // Batch-scoped animation prelude: carries no node ids, so the
        // namespacing rewrite has nothing to touch — pass it through
        // untouched at the head of its batch.
        p @ Patch::BatchAnimation { .. } => p,
        // Template patches are lowered by the per-tab `TemplateExpander`
        // before the rewrite, so these arms only see the expander's
        // degraded pass-throughs (unknown template id / malformed
        // skeleton). Rewrite their ids anyway so the merged stream stays
        // consistently namespaced; the renderer skips what it can't
        // expand.
        p @ Patch::RegisterTemplate { .. } => p,
        Patch::Instantiate {
            template_id,
            parent_id,
            before_id,
            nodes,
            subs,
            semantics,
        } => {
            let (parent, is_root_insert) = rewrite_parent(&parent_id, prefix, viewport);
            let nodes: Vec<Arc<str>> = nodes.iter().map(|n| prefix_id(prefix, n)).collect();
            if is_root_insert {
                if let Some(root) = nodes.first() {
                    if !new_roots.contains(root) {
                        new_roots.push(root.clone());
                    }
                }
            }
            Patch::Instantiate {
                template_id,
                parent_id: parent,
                before_id: before_id.map(|b| prefix_id(prefix, &b)),
                nodes,
                subs,
                semantics,
            }
        }
    }
}

/// Returns `(rewritten_parent_id, is_root_level_under_viewport)`.
fn rewrite_parent(parent_id: &str, prefix: &str, viewport: &str) -> (Arc<str>, bool) {
    if parent_id == ROOT_ID {
        (viewport.into(), true)
    } else {
        (prefix_id(prefix, parent_id), false)
    }
}

fn prefix_id(prefix: &str, id: &str) -> Arc<str> {
    let mut s = String::with_capacity(prefix.len() + id.len());
    s.push_str(prefix);
    s.push_str(id);
    s.into()
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

    /// Exercises the exact live nesting that the standalone renderer tests do
    /// not cover: Browser tab -> Home Screen -> HypenApp(MovieDB). The merged
    /// stream is replayed through Desktop's retained tree/layout/painter so a
    /// cached inner route cannot silently disappear behind healthy shell UI.
    #[test]
    #[ignore = "hits the live Home Screen and MovieDB deploys"]
    fn live_embedded_movie_db_back_restores_home_through_desktop_paint() {
        let storage = Storage::at_path(std::env::temp_dir().join(format!(
            "hypen-browser-live-back-{}-{}.json",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        )));
        let module = BrowserModule::build(storage);
        let batches: Arc<Mutex<Vec<Vec<Patch>>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&batches);
        module.on_patches(Arc::new(move |patches| {
            sink.lock().unwrap().push(patches.to_vec());
        }));
        module.mount();
        module.open_url("wss://hypen-home-screen.ian-dae.workers.dev/ws");
        std::thread::sleep(std::time::Duration::from_secs(4));

        // Enter the launcher's MovieDB route, which creates the nested embed.
        module.dispatch_action("router.push", Some(json!({"to": "/app/movies"})));
        std::thread::sleep(std::time::Duration::from_secs(5));
        {
            let inner = module.inner.lock().unwrap();
            let live_cinebox_ids: Vec<String> = inner
                .tree
                .nodes()
                .filter(|node| {
                    node.element_type == "Text" && node.text_content().as_deref() == Some("Cinebox")
                })
                .filter(|node| {
                    let mut top = node.id.as_str();
                    while top != hypen_renderer_desktop::tree::ROOT_ID {
                        let Some(parent) = inner.tree.parent_of(top) else {
                            break;
                        };
                        top = parent;
                    }
                    top == hypen_renderer_desktop::tree::ROOT_ID
                })
                .map(|node| node.id.clone())
                .collect();
            assert_eq!(
                live_cinebox_ids.len(),
                1,
                "MovieDB must graft exactly one live Cinebox tree; live ids: {live_cinebox_ids:?}\nembeds: {}\n{}",
                inner
                    .embeds
                    .iter()
                    .map(|(marker, embed)| format!(
                        "{marker} host={} roots={:?} detached={:?}",
                        embed.host_id, embed.app_root_ids, embed.detached
                    ))
                    .collect::<Vec<_>>()
                    .join("\n"),
                serialize_tree(&inner.tree),
            );
        }
        let marker = {
            let inner = module.inner.lock().unwrap();
            inner
                .embeds
                .iter()
                .find(|(_, embed)| embed.url.contains("movie-discovery"))
                .map(|(marker, _)| marker.clone())
                .expect("Home Screen must create the MovieDB HypenApp embed")
        };

        module.dispatch_action(
            &format!("{marker}openMovie"),
            Some(json!({"movieId": "tt1375666", "token": "featured"})),
        );
        std::thread::sleep(std::time::Duration::from_secs(3));
        module.dispatch_action(&format!("{marker}back"), None);
        std::thread::sleep(std::time::Duration::from_secs(3));

        // Browser's own merged shadow tree must already have the cached Home
        // linked again; this catches namespacing/action/slot reconciliation.
        let cinebox_id = {
            let inner = module.inner.lock().unwrap();
            let id = inner
                .tree
                .nodes()
                .find(|node| {
                    node.element_type == "Text" && node.text_content().as_deref() == Some("Cinebox")
                })
                .map(|node| node.id.clone())
                .expect("MovieDB Home text must be attached after Back");
            id
        };

        // Replay exactly what Browser forwarded, retaining every Desktop
        // subsystem across batches just like the real window.
        let batches = batches.lock().unwrap();
        let mut tree = Tree::new();
        let mut taffy = hypen_renderer_desktop::layout::TaffyState::new();
        let mut animator = hypen_renderer_desktop::anim::DesktopAnimator::new();
        let mut expander = hypen_engine::TemplateExpander::new();
        let mut painter = hypen_renderer_desktop::paint::vello_painter::VelloPainter::new();
        let viewport = hypen_renderer_desktop::style::Viewport::new(1024.0, 720.0);
        let mut generation = 0_u64;
        let mut final_layout = None;
        let mut final_paths = 0;
        for raw in batches.iter() {
            let expanded = expander.expand(raw.clone());
            let outcome = animator.ingest(&expanded, &mut tree);
            if !taffy.apply_patches(&outcome.forwarded, &tree, 1.0, viewport) {
                taffy.mark_needs_rebuild();
            }
            generation = generation.wrapping_add(1);
            let layout = hypen_renderer_desktop::layout::LayoutPass::compute_with_state(
                &mut taffy,
                &tree,
                painter.text_engine_mut(),
                (1024, 720),
                1.0,
                0.0,
                &std::collections::HashMap::new(),
                generation,
            );
            painter.invalidate_subtree_cache();
            final_paths = painter
                .build_scene(&layout, (1024, 720), 1.0, 0.0)
                .encoding()
                .path_tags
                .len();
            final_layout = Some(layout);
        }
        let layout = final_layout.expect("Browser emitted patches");
        let cinebox = layout
            .item_by_id(&cinebox_id)
            .expect("merged Desktop layout must emit MovieDB Home after Back");
        assert!(cinebox.rect.w > 0.0 && cinebox.rect.h > 0.0);
        assert!(
            final_paths > 0,
            "returned merged frame must encode paint paths"
        );
    }

    /// Regression for the Food app's real cached-route failure: Search ->
    /// Home used to leave the Browser viewport black even though the remote
    /// server emitted an Attach for its cached Home route.
    #[test]
    #[ignore = "hits the live Food Ordering deploy"]
    fn live_food_search_home_restores_through_desktop_paint() {
        let storage = Storage::at_path(std::env::temp_dir().join(format!(
            "hypen-browser-live-food-home-{}-{}.json",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        )));
        let module = BrowserModule::build(storage);
        let batches: Arc<Mutex<Vec<Vec<Patch>>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&batches);
        module.on_patches(Arc::new(move |patches| {
            sink.lock().unwrap().push(patches.to_vec());
        }));
        module.mount();
        module.open_url("wss://hypen-food-ordering.ian-dae.workers.dev/ws");
        std::thread::sleep(std::time::Duration::from_secs(4));
        module.dispatch_action("router.push", Some(json!({"to": "/search"})));
        std::thread::sleep(std::time::Duration::from_secs(2));
        module.dispatch_action("router.push", Some(json!({"to": "/"})));
        std::thread::sleep(std::time::Duration::from_secs(3));

        let home_heading_id = {
            let inner = module.inner.lock().unwrap();
            let candidate = inner
                .tree
                .nodes()
                .find(|node| {
                    node.element_type == "Text"
                        && node.text_content().as_deref() == Some("Crave Cart")
                })
                .map(|node| node.id.clone());
            candidate.unwrap_or_else(|| {
                panic!(
                    "Food Home heading must remain in Browser's merged tree:\n{}",
                    serialize_tree(&inner.tree)
                )
            })
        };

        let batches = batches.lock().unwrap();
        let mut tree = Tree::new();
        let mut taffy = hypen_renderer_desktop::layout::TaffyState::new();
        let mut animator = hypen_renderer_desktop::anim::DesktopAnimator::new();
        let mut expander = hypen_engine::TemplateExpander::new();
        let mut painter = hypen_renderer_desktop::paint::vello_painter::VelloPainter::new();
        let viewport = hypen_renderer_desktop::style::Viewport::new(1024.0, 720.0);
        let mut generation = 0_u64;
        let mut final_layout = None;
        let mut final_paths = 0;
        for raw in batches.iter() {
            let expanded = expander.expand(raw.clone());
            let outcome = animator.ingest(&expanded, &mut tree);
            if !taffy.apply_patches(&outcome.forwarded, &tree, 1.0, viewport) {
                taffy.mark_needs_rebuild();
            }
            generation = generation.wrapping_add(1);
            let layout = hypen_renderer_desktop::layout::LayoutPass::compute_with_state(
                &mut taffy,
                &tree,
                painter.text_engine_mut(),
                (1024, 720),
                1.0,
                0.0,
                &std::collections::HashMap::new(),
                generation,
            );
            painter.invalidate_subtree_cache();
            final_paths = painter
                .build_scene(&layout, (1024, 720), 1.0, 0.0)
                .encoding()
                .path_tags
                .len();
            final_layout = Some(layout);
        }
        let layout = final_layout.expect("Browser emitted Food patches");
        let heading = layout
            .item_by_id(&home_heading_id)
            .expect("reattached Food Home must be present in Desktop layout");
        assert!(heading.rect.w > 0.0 && heading.rect.h > 0.0);
        assert!(final_paths > 0, "reattached Food Home must repaint");
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
        // Movie DB's detail view uses a module-local `back` action, while
        // declarative apps may use the reserved `router.back` action. Neither
        // belongs to browser chrome/history; both must cross the WebSocket to
        // the hosted app's ManagedRouter.
        assert!(matches!(
            classify_dispatch("back", None),
            DispatchTarget::Remote
        ));
        assert!(matches!(
            classify_dispatch("router.back", None),
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
    fn tab_media_urls_resolve_against_the_remote_http_origin() {
        let patches = absolutize_tab_media_urls(
            vec![
                create_with(
                    "poster",
                    "Image",
                    &[("src", json!("/poster/big-buck-bunny"))],
                ),
                create_with(
                    "video",
                    "Video",
                    &[
                        ("src", json!("https://cdn.example/movie.mp4")),
                        ("poster.0", json!("/poster/sintel")),
                    ],
                ),
                Patch::SetProp {
                    id: "poster".into(),
                    name: "src".into(),
                    value: json!("/poster/updated"),
                },
            ],
            "wss://hypeflix.example/ws?session=abc",
        );

        let values: Vec<Value> = patches
            .iter()
            .flat_map(|patch| match patch {
                Patch::Create { props, .. } => props.values().cloned().collect(),
                Patch::SetProp { value, .. } => vec![value.clone()],
                _ => Vec::new(),
            })
            .collect();
        assert!(values.contains(&json!("https://hypeflix.example/poster/big-buck-bunny")));
        assert!(values.contains(&json!("https://hypeflix.example/poster/sintel")));
        assert!(values.contains(&json!("https://hypeflix.example/poster/updated")));
        assert!(values.contains(&json!("https://cdn.example/movie.mp4")));
    }

    #[test]
    fn tab_media_url_resolution_preserves_non_websocket_transports() {
        let original = vec![create_with(
            "poster",
            "Image",
            &[("src", json!("/poster/local"))],
        )];
        assert_eq!(
            format!(
                "{:?}",
                absolutize_tab_media_urls(original.clone(), "file:///tmp/app")
            ),
            format!("{original:?}"),
        );
        assert_eq!(
            websocket_http_origin("ws://localhost:5556/app"),
            Some(("http", "localhost:5556"))
        );
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
                    active_root_ids: vec!["a99:1".into(), "a99:2".into()],
                    queued: Vec::new(),
                    attached: true,
                    expander: hypen_engine::TemplateExpander::new(),
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
                Patch::Remove { id, .. } => Some(id.as_ref()),
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
                        active_root_ids: vec![format!("a{n}:1")],
                        queued: Vec::new(),
                        attached: n == 3,
                        expander: hypen_engine::TemplateExpander::new(),
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
                Patch::Remove { id, .. } => Some(id.as_ref()),
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
    fn go_home_restores_the_shell_home_after_an_active_app() {
        let (module, captured) = fresh_browser_with_capture();
        install_tab(&module, "tab-movies", "a1:", &[], true);
        module.inner.lock().unwrap().active_tab_id = Some("tab-movies".into());
        push_tabs(
            &module.shell,
            vec![TabInfo {
                id: "tab-movies".into(),
                url: "wss://movies.example/ws".into(),
                name: "Movies".into(),
                status: "connected".into(),
                status_message: String::new(),
            }],
            Some("tab-movies".into()),
        );
        ingest_tab_batch(
            &module,
            "tab-movies",
            &[
                create_with("1", "Column", &[]),
                insert("root", "1"),
                create_with("2", "Text", &[("0", json!("Movie DB"))]),
                insert("1", "2"),
            ],
        );

        let during = serialize_tree(&module.inner.lock().unwrap().tree);
        assert!(during.contains("Movie DB"), "active app missing:\n{during}");
        assert!(
            !during.contains("Hypen Browser"),
            "home should be hidden while a tab is active:\n{during}"
        );

        let before = captured.lock().unwrap().len();
        module.dispatch_action("go_home", None);

        {
            let captured = captured.lock().unwrap();
            let emitted = &captured[before..];
            let home_create = emitted.iter().position(|patch| match patch {
                Patch::Create { props, .. } => props
                    .values()
                    .any(|value| value.as_str() == Some("Hypen Browser")),
                _ => false,
            });
            let app_remove = emitted.iter().position(
                |patch| matches!(patch, Patch::Remove { id, .. } if id.as_ref() == "a1:1"),
            );
            assert!(
                home_create.is_some() && app_remove.is_some() && home_create < app_remove,
                "Home must be made visible before the active app is removed; got {emitted:?}"
            );
        }

        let after = serialize_tree(&module.inner.lock().unwrap().tree);
        assert!(
            after.contains("Hypen Browser"),
            "browser Home must restore the shell home subtree:\n{after}"
        );
        assert!(
            !after.contains("Movie DB"),
            "closed app must no longer be attached:\n{after}"
        );
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
                active_root_ids: roots.iter().map(|s| (*s).to_string()).collect(),
                queued: Vec::new(),
                attached,
                expander: hypen_engine::TemplateExpander::new(),
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
                Patch::Detach { id } => Some(id.as_ref()),
                _ => None,
            })
            .collect();
        let attaches: Vec<(&str, &str)> = new_patches
            .iter()
            .filter_map(|p| match p {
                Patch::Attach { parent_id, id, .. } => Some((parent_id.as_ref(), id.as_ref())),
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
                Patch::Remove { id, .. } if id.starts_with("a1:") || id.starts_with("a2:") => {
                    Some(id.as_ref())
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
                    Patch::Remove { id, .. } if id.starts_with("a1:")
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
            Patch::Create { id, .. } => assert_eq!(id.as_ref(), "a7:1"),
            _ => panic!("expected Create, got {:?}", out[0]),
        }
        match &out[1] {
            Patch::Insert { parent_id, id, .. } => {
                assert_eq!(parent_id.as_ref(), viewport);
                assert_eq!(id.as_ref(), "a7:1");
            }
            _ => panic!("expected Insert, got {:?}", out[1]),
        }
        match &out[2] {
            Patch::Detach { id } => assert_eq!(id.as_ref(), "a7:1"),
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
    fn route_root_create_does_not_delete_the_detached_cached_route() {
        let (module, captured) = fresh_browser_with_capture();
        install_tab(&module, "tab-route", "a3:", &[], true);
        module.inner.lock().unwrap().active_tab_id = Some("tab-route".into());

        ingest_tab_batch(
            &module,
            "tab-route",
            &[
                create_with("1", "Column", &[]),
                insert("root", "1"),
                create_with("11", "Text", &[("0", json!("Cached Home"))]),
                insert("1", "11"),
            ],
        );
        let before = captured.lock().unwrap().len();

        // The Router caches Home, then creates Search as the new active root.
        ingest_tab_batch(
            &module,
            "tab-route",
            &[
                Patch::Detach { id: "1".into() },
                create_with("2", "Column", &[]),
                insert("root", "2"),
            ],
        );
        let route_patches = captured.lock().unwrap()[before..].to_vec();
        assert!(
            !route_patches
                .iter()
                .any(|patch| matches!(patch, Patch::Remove { id, .. } if id.as_ref() == "a3:1")),
            "creating Search must not delete cached Home: {route_patches:?}",
        );

        ingest_tab_batch(
            &module,
            "tab-route",
            &[
                Patch::Detach { id: "2".into() },
                Patch::Attach {
                    parent_id: "root".into(),
                    id: "1".into(),
                    before_id: None,
                },
            ],
        );

        let returned = serialize_tree(&module.inner.lock().unwrap().tree);
        assert!(
            returned.contains("Cached Home"),
            "Attach must restore the cached route after Search:\n{returned}",
        );
    }

    #[test]
    fn tab_resume_restores_only_the_active_nested_app_route() {
        let (module, _captured) = fresh_browser_with_capture();
        install_tab(&module, "tab-home", "a3:", &[], true);
        module.inner.lock().unwrap().active_tab_id = Some("tab-home".into());

        // HomeScreen root, followed by its cached Hypeflix app route.
        ingest_tab_batch(
            &module,
            "tab-home",
            &[create_with("1", "Column", &[]), insert("root", "1")],
        );
        ingest_tab_batch(
            &module,
            "tab-home",
            &[
                Patch::Detach { id: "1".into() },
                create_with("2", "Column", &[]),
                insert("root", "2"),
                create_with("21", "Text", &[("0", json!("HYPEFLIX"))]),
                insert("2", "21"),
            ],
        );

        // Leaving and returning to the Browser tab must not revive cached
        // Home beside Hypeflix.
        module.detach_tab("tab-home");
        module.attach_tab("tab-home");
        let viewport = module.inner.lock().unwrap().viewport_id.clone().unwrap();
        {
            let inner = module.inner.lock().unwrap();
            assert_eq!(inner.tree.parent_of("a3:2"), Some(viewport.as_str()));
            assert_eq!(inner.tree.parent_of("a3:1"), None);
        }

        // Switch the launcher's active route from Hypeflix to MovieDB, then
        // suspend/resume once more. Only MovieDB may be linked to the viewport;
        // every earlier app remains cached and detached.
        ingest_tab_batch(
            &module,
            "tab-home",
            &[
                Patch::Detach { id: "2".into() },
                create_with("3", "Column", &[]),
                insert("root", "3"),
                create_with("31", "Text", &[("0", json!("Cinebox"))]),
                insert("3", "31"),
            ],
        );
        module.detach_tab("tab-home");
        module.attach_tab("tab-home");

        let inner = module.inner.lock().unwrap();
        assert_eq!(inner.tabs["tab-home"].app_root_ids.len(), 3);
        assert_eq!(inner.tabs["tab-home"].active_root_ids, vec!["a3:3"]);
        assert_eq!(inner.tree.parent_of("a3:1"), None);
        assert_eq!(inner.tree.parent_of("a3:2"), None);
        assert_eq!(inner.tree.parent_of("a3:3"), Some(viewport.as_str()));
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
    fn tab_reconnect_with_same_ids_replaces_the_old_root_before_create() {
        // Durable Object hibernation reconstructs the server engine while the
        // Browser keeps painting the last tree. Node ids commonly restart at
        // the same values, so the replacement InitialTree must remove the old
        // root before re-creating it or stale children survive and the page is
        // visibly duplicated.
        let (module, _captured) = fresh_browser_with_capture();
        install_tab(&module, "tab-1", "a9:", &["a9:1"], true);

        let again = vec![
            create_with("1", "Column", &[]),
            create_with("2", "Text", &[("text", json!("restored"))]),
            insert("root", "1"),
            insert("1", "2"),
        ];
        let out = process_tab_patches(&module.inner, "tab-1", &again);

        assert!(
            matches!(&out[0], Patch::Remove { id, transition: false } if id.as_ref() == "a9:1"),
            "expected the old root removed before the replacement tree, got {out:?}",
        );
        assert!(
            matches!(&out[1], Patch::Create { id, .. } if id.as_ref() == "a9:1"),
            "replacement Create must follow the prelude Remove, got {out:?}",
        );
        assert_eq!(
            module.inner.lock().unwrap().tabs["tab-1"].app_root_ids,
            vec!["a9:1".to_string()],
        );
    }

    /// End-to-end check of the safe-area integration: a hosted app that
    /// wraps its content in `SafeArea` must come out padded clear of the
    /// island chrome, while the SafeArea itself still fills the window
    /// (so its background bleeds behind the chrome).
    ///
    /// Lays the *merged* tree (shell chrome + tab content) out through
    /// the desktop renderer's own layout pass with the insets `main.rs`
    /// installs, and contrasts it with the same tree at zero insets —
    /// which is what the browser did before, content pinned at y=0
    /// underneath the toolbar.
    #[test]
    fn hosted_apps_draw_under_the_island_and_clear_only_the_window_controls() {
        use hypen_renderer_desktop::layout::LayoutPass;
        use hypen_renderer_desktop::text::TextEngine;

        let (module, _captured) = fresh_browser_with_capture();
        install_tab(&module, "tab-fg", "a9:", &[], true);
        module.inner.lock().unwrap().active_tab_id = Some("tab-fg".into());
        // Tell the shell about the tab too, so it swaps the home screen
        // out of the viewport and renders the island chrome overlay.
        push_tabs(
            &module.shell,
            vec![TabInfo {
                id: "tab-fg".into(),
                url: "ws://tab-fg".into(),
                name: "tab-fg".into(),
                status: "connected".into(),
                status_message: String::new(),
            }],
            Some("tab-fg".into()),
        );

        // The app's own tree: a full-bleed SafeArea wrapping its content.
        let out = ingest_tab_batch(
            &module,
            "tab-fg",
            &[
                create_with(
                    "1",
                    "SafeArea",
                    &[("width.0", json!("100%")), ("height.0", json!("100%"))],
                ),
                insert("root", "1"),
                create_with("2", "Text", &[("0", json!("Hello from the app"))]),
                insert("1", "2"),
            ],
        );
        let id_of = |element_type: &str| -> String {
            out.iter()
                .find_map(|p| match p {
                    Patch::Create {
                        id,
                        element_type: t,
                        ..
                    } if &**t == element_type => Some(id.to_string()),
                    _ => None,
                })
                .unwrap_or_else(|| panic!("no {element_type} in the forwarded stream: {out:?}"))
        };
        let (safe_area, text) = (id_of("SafeArea"), id_of("Text"));

        let inner = module.inner.lock().unwrap();
        let mut fonts = TextEngine::new();
        let viewport = (1024, 720);
        let rect = |pass: &LayoutPass, id: &str| pass.item_by_id(id).expect("laid out").rect;

        // The browser configures no safe-area insets of its own: the
        // island chrome is a floating overlay hosted apps draw under by
        // design, so a SafeArea-wrapped app lays out full-bleed — the
        // chrome is NOT reserved.
        let bare = LayoutPass::compute(&inner.tree, &mut fonts, viewport, 1.0);
        let area = rect(&bare, &safe_area);
        assert_eq!(
            (area.x, area.y, area.h),
            (0.0, 0.0, viewport.1 as f32),
            "the SafeArea itself stays full-bleed",
        );
        assert_eq!(
            rect(&bare, &text).y,
            0.0,
            "the island chrome must not push hosted content down",
        );

        // The one inset the browser window does get comes from the
        // renderer itself: under the macOS unified titlebar (main.rs
        // sets `.unified_titlebar(true)`) the window-controls bar is
        // the platform top inset, and SafeArea content clears exactly
        // that. Simulated explicitly so the assertion holds on any
        // host OS.
        let macos = LayoutPass::compute_with_safe_area(
            &inner.tree,
            &mut fonts,
            viewport,
            1.0,
            hypen_renderer_desktop::SafeAreaInsets::default(),
            hypen_renderer_desktop::window_controls_platform_insets(true, true),
        );
        assert_eq!(
            (rect(&macos, &safe_area).y, rect(&macos, &text).y),
            (0.0, hypen_renderer_desktop::WINDOW_CONTROLS_BAR_HEIGHT),
            "SafeArea content clears the window-controls bar and nothing more",
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
                Patch::Remove { id, .. } => Some(id.as_ref()),
                _ => None,
            })
            .collect();
        let attached_under_viewport: Vec<&str> = new_patches
            .iter()
            .filter_map(|p| match p {
                Patch::Attach { parent_id, id, .. } if parent_id.as_ref() == viewport => {
                    Some(id.as_ref())
                }
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
                Patch::Detach { id } => Some(id.as_ref()),
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

    // -----------------------------------------------------------------
    // HypenApp embeds
    // -----------------------------------------------------------------

    fn create_with(id: &str, element_type: &str, entries: &[(&str, Value)]) -> Patch {
        let mut m = IndexMap::new();
        for (k, v) in entries {
            m.insert((*k).to_string(), v.clone());
        }
        Patch::Create {
            id: id.into(),
            element_type: element_type.into(),
            props: Arc::new(m),
            semantics: None,
        }
    }

    fn insert(parent: &str, id: &str) -> Patch {
        Patch::Insert {
            parent_id: parent.into(),
            id: id.into(),
            before_id: None,
        }
    }

    /// Feed a raw tab batch through the same pipeline the tab's
    /// on_patches closure runs: rewrite, embed lifecycle, forward.
    fn ingest_tab_batch(module: &Arc<BrowserModule>, tab_id: &str, batch: &[Patch]) -> Vec<Patch> {
        let mut rewritten = process_tab_patches(&module.inner, tab_id, batch);
        let lifecycle = handle_embed_lifecycle(&module.inner, &rewritten);
        rewritten.extend(lifecycle.extra);
        forward(&module.inner, &rewritten);
        for marker in lifecycle.to_connect {
            connect_embed(&module.inner, marker);
        }
        rewritten
    }

    /// A launcher-style app-route batch: route Column → HypenApp with a
    /// loading and an error slot child. Raw (unprefixed) ids.
    fn hypenapp_route_batch(url: &str) -> Vec<Patch> {
        vec![
            create_with("50", "Column", &[]),
            insert("root", "50"),
            create_with(
                "51",
                "HypenApp",
                &[("0", json!(url)), ("flex.0", json!("1"))],
            ),
            insert("50", "51"),
            create_with("52", "Column", &[("slot.0", json!("loading"))]),
            insert("51", "52"),
            create_with("53", "Column", &[("slot.0", json!("error"))]),
            insert("51", "53"),
        ]
    }

    #[test]
    fn hypenapp_create_registers_embed_and_hides_error_slot() {
        let (module, _captured) = fresh_browser_with_capture();
        install_tab(&module, "tab-1", "a9:", &[], true);

        // Port 1 refuses instantly — the worker just retries in the
        // background until the module (and its embeds) drop.
        let out = ingest_tab_batch(
            &module,
            "tab-1",
            &hypenapp_route_batch("ws://127.0.0.1:1/nope"),
        );

        let inner = module.inner.lock().unwrap();
        assert_eq!(inner.embeds.len(), 1);
        let (marker, embed) = inner.embeds.iter().next().unwrap();
        assert_eq!(marker, "e1:");
        assert_eq!(embed.host_id, "a9:51");
        assert_eq!(embed.owner_prefix, "a9:");
        assert_eq!(embed.url, "ws://127.0.0.1:1/nope");
        assert_eq!(embed.loading_slot_ids, vec!["a9:52".to_string()]);
        assert_eq!(embed.error_slot_ids, vec!["a9:53".to_string()]);
        // The error slot is hidden while loading; the loading slot stays.
        assert!(
            out.iter()
                .any(|p| matches!(p, Patch::Detach { id } if id.as_ref() == "a9:53")),
            "expected a Detach for the error slot, got {out:?}",
        );
        assert!(!out
            .iter()
            .any(|p| matches!(p, Patch::Detach { id } if id.as_ref() == "a9:52")));
    }

    #[test]
    fn embed_patches_graft_under_host_and_carry_action_markers() {
        let (module, _captured) = fresh_browser_with_capture();
        install_tab(&module, "tab-1", "a9:", &[], true);
        ingest_tab_batch(
            &module,
            "tab-1",
            &hypenapp_route_batch("ws://127.0.0.1:1/nope"),
        );

        // Simulate the embed's initial tree arriving from its server.
        let batch = vec![
            create_with("1", "Column", &[]),
            insert("root", "1"),
            create_with(
                "2",
                "Button",
                &[
                    ("onClick.0", json!("@actions.play")),
                    ("bind", json!("query")),
                ],
            ),
            insert("1", "2"),
        ];
        let out = process_embed_patches(&module.inner, "e1:", &batch);

        // Root re-rooted onto the HypenApp host, ids prefixed.
        assert!(
            out.iter().any(|p| matches!(
                p,
                Patch::Insert { parent_id, id, .. }
                    if parent_id.as_ref() == "a9:51" && id.as_ref() == "e1:1"
            )),
            "expected the embed root under the host, got {out:?}",
        );
        // Action + bind props carry the marker.
        let button = out.iter().find_map(|p| match p {
            Patch::Create { id, props, .. } if id.as_ref() == "e1:2" => Some(props),
            _ => None,
        });
        let props = button.expect("button create present");
        assert_eq!(props.get("onClick.0"), Some(&json!("@actions.e1:play")));
        assert_eq!(props.get("bind"), Some(&json!("e1:query")));
        // First batch flips loading → connected: the loading slot hides.
        assert!(out
            .iter()
            .any(|p| matches!(p, Patch::Detach { id } if id.as_ref() == "a9:52")));

        // A follow-up batch emits no further slot patches.
        let out2 = process_embed_patches(
            &module.inner,
            "e1:",
            &[Patch::SetProp {
                id: "2".into(),
                name: "0".into(),
                value: json!("Play now"),
            }],
        );
        assert_eq!(out2.len(), 1);
        let inner = module.inner.lock().unwrap();
        let embed = inner.embeds.get("e1:").unwrap();
        assert_eq!(embed.app_root_ids, vec!["e1:1".to_string()]);
        assert_eq!(embed.status, EmbedStatus::Connected);
    }

    #[test]
    fn embed_connection_is_deferred_until_its_host_batch_is_forwarded() {
        let (module, captured) = fresh_browser_with_capture();
        install_tab(&module, "tab-1", "a9:", &[], true);
        let raw = hypenapp_route_batch("ws://127.0.0.1:1/nope");
        let rewritten = process_tab_patches(&module.inner, "tab-1", &raw);
        let lifecycle = handle_embed_lifecycle(&module.inner, &rewritten);

        assert_eq!(lifecycle.to_connect.len(), 1);
        let marker = &lifecycle.to_connect[0];
        assert!(
            module.inner.lock().unwrap().embeds[marker].remote.is_none(),
            "lifecycle scan must register, but not start, the worker",
        );
        assert!(
            module.inner.lock().unwrap().tree.get("a9:51").is_none(),
            "the host has not reached the forwarded shadow tree yet",
        );

        let mut host_batch = rewritten;
        host_batch.extend(lifecycle.extra);
        forward(&module.inner, &host_batch);

        assert!(module.inner.lock().unwrap().tree.get("a9:51").is_some());
        assert!(captured.lock().unwrap().iter().any(
            |patch| matches!(patch, Patch::Create { id, element_type, .. }
                if id.as_ref() == "a9:51" && element_type == "HypenApp")
        ));
        // Do not connect the intentionally invalid URL; the production
        // callbacks perform that step only after this forwarding point.
    }

    #[test]
    fn embed_media_urls_resolve_against_the_embedded_app_origin() {
        let (module, _captured) = fresh_browser_with_capture();
        install_tab(&module, "tab-1", "a9:", &[], true);
        ingest_tab_batch(
            &module,
            "tab-1",
            &hypenapp_route_batch("wss://hypeflix.example/ws"),
        );

        let out = process_embed_patches(
            &module.inner,
            "e1:",
            &[
                create_with("1", "Column", &[]),
                insert("root", "1"),
                create_with("2", "Image", &[("src", json!("/poster/sintel"))]),
                insert("1", "2"),
                create_with(
                    "3",
                    "Video",
                    &[("poster.0", json!("/poster/big-buck-bunny"))],
                ),
                insert("1", "3"),
            ],
        );

        let media_props: Vec<&Arc<IndexMap<String, Value>>> = out
            .iter()
            .filter_map(|patch| match patch {
                Patch::Create {
                    element_type,
                    props,
                    ..
                } if element_type == "Image" || element_type == "Video" => Some(props),
                _ => None,
            })
            .collect();
        assert_eq!(
            media_props[0].get("src"),
            Some(&json!("https://hypeflix.example/poster/sintel"))
        );
        assert_eq!(
            media_props[1].get("poster.0"),
            Some(&json!("https://hypeflix.example/poster/big-buck-bunny"))
        );
    }

    #[test]
    fn embed_reconnect_replaces_the_old_root() {
        let (module, _captured) = fresh_browser_with_capture();
        install_tab(&module, "tab-1", "a9:", &[], true);
        ingest_tab_batch(
            &module,
            "tab-1",
            &hypenapp_route_batch("ws://127.0.0.1:1/nope"),
        );
        let first = vec![create_with("1", "Column", &[]), insert("root", "1")];
        forward(
            &module.inner,
            &process_embed_patches(&module.inner, "e1:", &first),
        );

        // Fresh session after a reconnect: new ids, new root.
        let second = vec![create_with("7", "Column", &[]), insert("root", "7")];
        let out = process_embed_patches(&module.inner, "e1:", &second);
        assert!(
            matches!(&out[0], Patch::Remove { id, .. } if id.as_ref() == "e1:1"),
            "expected the stale root removed first, got {out:?}",
        );
        let inner = module.inner.lock().unwrap();
        assert_eq!(
            inner.embeds.get("e1:").unwrap().app_root_ids,
            vec!["e1:7".to_string()],
        );
        assert_eq!(
            inner.embeds.get("e1:").unwrap().active_root_ids,
            vec!["e1:7".to_string()],
        );
    }

    #[test]
    fn embed_status_recovery_restores_only_the_active_router_root() {
        let (module, _captured) = fresh_browser_with_capture();
        install_tab(&module, "tab-1", "a9:", &[], true);
        ingest_tab_batch(
            &module,
            "tab-1",
            &hypenapp_route_batch("ws://127.0.0.1:1/nope"),
        );
        forward(
            &module.inner,
            &process_embed_patches(
                &module.inner,
                "e1:",
                &[create_with("1", "Column", &[]), insert("root", "1")],
            ),
        );

        // The nested app's Router caches root 1 and activates a freshly
        // created root 2. This is navigation, not a reconnect replacement.
        let route_change = process_embed_patches(
            &module.inner,
            "e1:",
            &[
                Patch::Detach { id: "1".into() },
                create_with("2", "Column", &[]),
                insert("root", "2"),
            ],
        );
        assert!(
            !route_change
                .iter()
                .any(|patch| matches!(patch, Patch::Remove { id, .. } if id.as_ref() == "e1:1")),
            "Router navigation must preserve the cached outgoing root: {route_change:?}",
        );
        forward(&module.inner, &route_change);
        {
            let inner = module.inner.lock().unwrap();
            let embed = &inner.embeds["e1:"];
            assert_eq!(
                embed.app_root_ids,
                vec!["e1:1".to_string(), "e1:2".to_string()]
            );
            assert_eq!(embed.active_root_ids, vec!["e1:2".to_string()]);
            assert!(embed.detached.contains("e1:1"));
        }

        // A connection error hides the active root. Recovery must restore
        // root 2 only; reattaching cached root 1 would stack two full apps.
        let error_patches = {
            let mut inner = module.inner.lock().unwrap();
            let embed = inner.embeds.get_mut("e1:").unwrap();
            embed.status = EmbedStatus::Error;
            embed.reconcile_visibility()
        };
        assert!(error_patches
            .iter()
            .any(|patch| matches!(patch, Patch::Detach { id } if id.as_ref() == "e1:2")));
        forward(&module.inner, &error_patches);

        let recovered = {
            let mut inner = module.inner.lock().unwrap();
            let embed = inner.embeds.get_mut("e1:").unwrap();
            embed.status = EmbedStatus::Connected;
            embed.reconcile_visibility()
        };
        assert!(recovered.iter().any(|patch| matches!(patch,
            Patch::Attach { id, .. } if id.as_ref() == "e1:2"
        )));
        assert!(
            !recovered.iter().any(|patch| matches!(patch,
                Patch::Attach { id, .. } if id.as_ref() == "e1:1"
            )),
            "cached inactive root must stay detached: {recovered:?}",
        );
    }

    #[test]
    fn remove_of_the_route_subtree_tears_the_embed_down() {
        let (module, _captured) = fresh_browser_with_capture();
        install_tab(&module, "tab-1", "a9:", &[], true);
        ingest_tab_batch(
            &module,
            "tab-1",
            &hypenapp_route_batch("ws://127.0.0.1:1/nope"),
        );
        assert_eq!(module.inner.lock().unwrap().embeds.len(), 1);

        // The launcher's router evicts the cached /app route: a Remove
        // of the route Column ("50" → "a9:50"), an ancestor of the host.
        ingest_tab_batch(
            &module,
            "tab-1",
            &[Patch::Remove {
                id: "50".into(),
                transition: false,
            }],
        );
        assert!(module.inner.lock().unwrap().embeds.is_empty());
    }

    #[test]
    fn detach_of_the_route_subtree_keeps_the_embed_warm() {
        let (module, _captured) = fresh_browser_with_capture();
        install_tab(&module, "tab-1", "a9:", &[], true);
        ingest_tab_batch(
            &module,
            "tab-1",
            &hypenapp_route_batch("ws://127.0.0.1:1/nope"),
        );

        // Router-cache navigation away: Detach, not Remove.
        ingest_tab_batch(&module, "tab-1", &[Patch::Detach { id: "50".into() }]);
        assert_eq!(
            module.inner.lock().unwrap().embeds.len(),
            1,
            "a cached route must keep its embed connected",
        );
    }

    #[test]
    fn close_tab_tears_down_embeds_transitively() {
        let (module, _captured) = fresh_browser_with_capture();
        install_tab(&module, "tab-1", "a9:", &[], true);
        {
            let mut inner = module.inner.lock().unwrap();
            inner.embeds.insert(
                "e1:".into(),
                Embed::new("e1:".into(), "a9:51".into(), "a9:".into(), "ws://x".into()),
            );
            // Nested embed hosted inside e1's subtree.
            inner.embeds.insert(
                "e2:".into(),
                Embed::new("e2:".into(), "e1:4".into(), "e1:".into(), "ws://y".into()),
            );
            // An embed owned by a DIFFERENT tab must survive.
            inner.embeds.insert(
                "e3:".into(),
                Embed::new("e3:".into(), "a7:2".into(), "a7:".into(), "ws://z".into()),
            );
        }
        module.close_tab_silent("tab-1");
        let inner = module.inner.lock().unwrap();
        assert!(!inner.embeds.contains_key("e1:"));
        assert!(!inner.embeds.contains_key("e2:"));
        assert!(inner.embeds.contains_key("e3:"));
    }

    #[test]
    fn hypenapp_recreate_replaces_the_stale_embed() {
        // A tab server restart re-sends its tree with the SAME node
        // ids. The HypenApp re-Create must replace the old embed (one
        // worker, one registration) and reclaim its grafted roots and
        // detached nodes rather than stacking a duplicate.
        let (module, _captured) = fresh_browser_with_capture();
        install_tab(&module, "tab-1", "a9:", &[], true);
        ingest_tab_batch(
            &module,
            "tab-1",
            &hypenapp_route_batch("ws://127.0.0.1:1/nope"),
        );
        // Give the first embed a grafted root.
        forward(
            &module.inner,
            &process_embed_patches(
                &module.inner,
                "e1:",
                &[create_with("1", "Column", &[]), insert("root", "1")],
            ),
        );

        let out = ingest_tab_batch(
            &module,
            "tab-1",
            &hypenapp_route_batch("ws://127.0.0.1:1/nope"),
        );
        let inner = module.inner.lock().unwrap();
        assert_eq!(inner.embeds.len(), 1, "old embed must be replaced");
        assert!(inner.embeds.contains_key("e2:"));
        assert!(!inner.embeds.contains_key("e1:"));
        // Replacing the tab root reclaims the stale embed root transitively;
        // no second explicit Remove(e1:1) is needed for a linked descendant.
        assert!(
            out.iter()
                .any(|p| matches!(p, Patch::Remove { id, .. } if id.as_ref() == "a9:50")),
            "expected the stale tab root removed, got {out:?}",
        );
    }

    #[test]
    fn teardown_removes_the_detached_slot_subtrees() {
        // While loading, the error slot child is Detached — it sits in
        // no children list, so the route subtree's Remove can't reach
        // it. Teardown must Remove it explicitly or it leaks.
        let (module, _captured) = fresh_browser_with_capture();
        install_tab(&module, "tab-1", "a9:", &[], true);
        ingest_tab_batch(
            &module,
            "tab-1",
            &hypenapp_route_batch("ws://127.0.0.1:1/nope"),
        );
        let out = ingest_tab_batch(
            &module,
            "tab-1",
            &[Patch::Remove {
                id: "50".into(),
                transition: false,
            }],
        );
        assert!(module.inner.lock().unwrap().embeds.is_empty());
        assert!(
            out.iter()
                .any(|p| matches!(p, Patch::Remove { id, .. } if id.as_ref() == "a9:53")),
            "expected the detached error slot removed, got {out:?}",
        );
    }

    #[test]
    fn remove_above_a_detached_route_still_tears_the_embed_down() {
        // Router-cache a route (Detach severs the parent link in the
        // Tree), then Remove an ANCESTOR of the detach point — the
        // detach-parent bridge must carry the walk across the gap.
        let (module, _captured) = fresh_browser_with_capture();
        install_tab(&module, "tab-1", "a9:", &[], true);
        let mut batch = vec![create_with("40", "Column", &[]), insert("root", "40")];
        batch.extend(vec![
            create_with("50", "Column", &[]),
            insert("40", "50"),
            create_with("51", "HypenApp", &[("0", json!("ws://127.0.0.1:1/nope"))]),
            insert("50", "51"),
        ]);
        ingest_tab_batch(&module, "tab-1", &batch);
        assert_eq!(module.inner.lock().unwrap().embeds.len(), 1);

        // Cache the route: its parent link in the Tree is now gone.
        ingest_tab_batch(&module, "tab-1", &[Patch::Detach { id: "50".into() }]);
        // Remove the ancestor above the detach point.
        ingest_tab_batch(
            &module,
            "tab-1",
            &[Patch::Remove {
                id: "40".into(),
                transition: false,
            }],
        );
        assert!(
            module.inner.lock().unwrap().embeds.is_empty(),
            "the embed inside the cached route must be torn down",
        );
    }

    #[test]
    fn embed_reconnect_with_same_ids_still_replaces_the_root() {
        // A fresh session's engine restarts NodeId allocation, so the
        // re-sent tree's root collides with the old one. Replacement
        // must still be detected (Create of a root while old roots
        // exist), or old-session leftovers linger under the host.
        let (module, _captured) = fresh_browser_with_capture();
        install_tab(&module, "tab-1", "a9:", &[], true);
        ingest_tab_batch(
            &module,
            "tab-1",
            &hypenapp_route_batch("ws://127.0.0.1:1/nope"),
        );
        let first = vec![create_with("1", "Column", &[]), insert("root", "1")];
        forward(
            &module.inner,
            &process_embed_patches(&module.inner, "e1:", &first),
        );

        let again = vec![create_with("1", "Column", &[]), insert("root", "1")];
        let out = process_embed_patches(&module.inner, "e1:", &again);
        assert!(
            matches!(&out[0], Patch::Remove { id, .. } if id.as_ref() == "e1:1"),
            "expected the old-session root removed first, got {out:?}",
        );
        let inner = module.inner.lock().unwrap();
        assert_eq!(
            inner.embeds.get("e1:").unwrap().app_root_ids,
            vec!["e1:1".to_string()],
        );
    }

    #[test]
    fn embed_marked_actions_are_swallowed_not_sent_to_the_tab() {
        // With the embed registered but its worker gone, a marked
        // action must be swallowed (routing matched) rather than
        // falling through to the active tab's remote; an unmarked
        // action must fall through to normal routing.
        let (module, _captured) = fresh_browser_with_capture();
        {
            let mut inner = module.inner.lock().unwrap();
            inner.embeds.insert(
                "e1:".into(),
                Embed::new("e1:".into(), "a9:51".into(), "a9:".into(), "ws://x".into()),
            );
        }
        assert!(module.try_dispatch_embed("e1:play", &None));
        assert!(module.try_dispatch_embed(
            "__hypen_bind",
            &Some(json!({"path": "e1:query", "value": "x"})),
        ));
        assert!(!module.try_dispatch_embed("play", &None));
        assert!(!module.try_dispatch_embed("e4:play", &None));
        assert!(!module.try_dispatch_embed(
            "__hypen_bind",
            &Some(json!({"path": "query", "value": "x"})),
        ));
    }
}
