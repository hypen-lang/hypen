//! `HypenApp` embeds for a desktop window — the counterpart of the DOM
//! renderer's `hypenapp.ts` component (and of `hypen-browser`'s tab-level
//! embeds, whose pure helpers live here and are re-exported there).
//!
//! A `HypenApp("ws://…")` element in a remote app's tree grafts a nested
//! remote app under itself. [`EmbeddingModule`] wraps the window's module
//! and does the grafting on the patch stream, so the window, layout and
//! paint pipeline see one ordinary merged tree:
//!
//! * each embed gets its own connection ([`remote_embed_connector`]: a
//!   UI-only [`RemoteModule`], like the web embed without a device
//!   factory) and an `e<n>:` id prefix, so its NodeIds can't collide with
//!   the host's or a sibling embed's;
//! * its `Insert { parent_id: "root" }` is re-rooted onto the HypenApp
//!   host node, which lays out like a Column (`flex-1 w-full` on the host
//!   sizes the embedded app);
//! * its nodes keep the asset-origin stamp their own `RemoteModule` put on
//!   them, so relative image URLs resolve against the EMBEDDED app's
//!   server, not the launcher's;
//! * node-addressed UI events (`dispatch_ui_action`) and virtual-list
//!   viewport reports route by the node's prefix to the stream that owns
//!   it, with the prefix stripped — no action-name rewriting is needed
//!   because every window event carries its node;
//! * the host's `.slot("loading")` / `.slot("error")` children are toggled
//!   with the same `Detach` / `Attach` patches the Router cache uses:
//!   loading shows until the embed's first patch batch, error shows when
//!   the connection fails before ever delivering a tree (or gives up), and
//!   neither shows while the embedded tree is live. Unslotted children
//!   render unconditionally, like the web.
//!
//! Lifecycle mirrors the web component: a Router `Detach` of the host's
//! subtree keeps the embed connected (a cached route re-attaches warm,
//! without a splash), while a real `Remove` of the host or an ancestor —
//! or a `ClearChildren` above it — closes the connection and reclaims
//! every node the embed still holds detached.

use crate::module::HypenModule;
use crate::remote::{ConnectionStatus, OwnedPatchCallback, RemoteModule, RemoteOptions};
use hypen_engine::Patch;
use indexmap::IndexMap;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

/// Embeds nested deeper than this are refused (with a log line) — a guard
/// against an app that embeds itself recursively.
pub const MAX_EMBED_DEPTH: usize = 4;

/// Module name an embed logs in as (every Hypen example serves `App`).
pub const EMBED_MODULE_NAME: &str = "App";

const ROOT_ID: &str = crate::tree::ROOT_ID;

/// Where an embed's connection stands, as far as slot visibility is
/// concerned. `Loading` until the first patch batch lands (a connected
/// socket that hasn't sent a tree yet still shows the splash), `Error` on
/// a connection failure before any tree (or a terminal give-up).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmbedStatus {
    Loading,
    Connected,
    Error,
}

/// `true` when a Create's element type is the HypenApp embed component.
pub fn is_hypenapp(element_type: &str) -> bool {
    element_type.eq_ignore_ascii_case("hypenapp")
}

/// Pull the WebSocket URL off a HypenApp node's props: positional (`"0"` —
/// what the engine emits for `HypenApp("wss://…")`) or named (`url`), with
/// the flattened `.0` spellings accepted for safety.
pub fn embed_url(props: &IndexMap<String, Value>) -> Option<String> {
    for key in ["0", "0.0", "url", "url.0"] {
        if let Some(v) = props.get(key).and_then(|v| v.as_str()) {
            if !v.trim().is_empty() {
                return Some(v.trim().to_string());
            }
        }
    }
    None
}

/// A node's slot tag (`.slot("loading")` flattens to `slot.0`).
pub fn slot_of(props: &IndexMap<String, Value>) -> Option<&str> {
    props
        .get("slot.0")
        .or_else(|| props.get("slot"))
        .and_then(|v| v.as_str())
}

/// What an embed's connection reports to the embedding layer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmbedSignal {
    /// A connect attempt failed and a retry is queued. Before the first
    /// tree this shows the error slot (the web embed's failed `connect()`);
    /// a later tree still replaces it.
    Retrying,
    /// The connection gave up for good.
    Failed,
}

/// Receives an embed connection's [`EmbedSignal`]s.
pub type EmbedSignalSink = Arc<dyn Fn(EmbedSignal) + Send + Sync>;

/// Opens the connection for one embed: given its URL and a signal sink,
/// returns the module whose patches are grafted under the host. The
/// default is [`remote_embed_connector`]; tests inject in-process fakes.
pub type EmbedConnector = Arc<dyn Fn(&str, EmbedSignalSink) -> Arc<dyn HypenModule> + Send + Sync>;

/// The production connector: a UI-only [`RemoteModule`] per embed (no
/// device host — the web embed is UI-only too unless its host supplies a
/// device factory), logged in as [`EMBED_MODULE_NAME`].
pub fn remote_embed_connector() -> EmbedConnector {
    Arc::new(|url: &str, signal: EmbedSignalSink| {
        let remote = RemoteModule::connect_with(
            url,
            EMBED_MODULE_NAME,
            RemoteOptions::default().device(None),
        );
        remote.on_status(move |status| match status {
            ConnectionStatus::Reconnecting { .. } => signal(EmbedSignal::Retrying),
            ConnectionStatus::Failed { .. } => signal(EmbedSignal::Failed),
            _ => {}
        });
        Arc::new(remote) as Arc<dyn HypenModule>
    })
}

// ---------------------------------------------------------------------------
// Shadow tree: just enough structure for lifecycle decisions
// ---------------------------------------------------------------------------

#[derive(Default)]
struct Link {
    /// Last parent. Kept across a `Detach` so a removal of an ancestor
    /// above the detach point (a cached route holding an embed) still
    /// finds the host.
    parent: Option<Arc<str>>,
    children: Vec<Arc<str>>,
    slot: Option<String>,
}

#[derive(Default)]
struct Shadow {
    nodes: HashMap<Arc<str>, Link>,
}

impl Shadow {
    fn create(&mut self, id: &Arc<str>, slot: Option<String>) {
        self.nodes.entry(Arc::clone(id)).or_default().slot = slot;
    }

    fn unlink(&mut self, id: &str) {
        let parent = self.nodes.get(id).and_then(|l| l.parent.clone());
        if let Some(parent) = parent {
            if let Some(p) = self.nodes.get_mut(parent.as_ref()) {
                p.children.retain(|c| c.as_ref() != id);
            }
        }
    }

    fn link(&mut self, parent: &Arc<str>, id: &Arc<str>) {
        self.unlink(id);
        self.nodes.entry(Arc::clone(id)).or_default().parent = Some(Arc::clone(parent));
        let p = self.nodes.entry(Arc::clone(parent)).or_default();
        if !p.children.iter().any(|c| c == id) {
            p.children.push(Arc::clone(id));
        }
    }

    fn remove(&mut self, id: &str) {
        self.unlink(id);
        let mut stack = vec![id.to_string()];
        while let Some(cur) = stack.pop() {
            if let Some(link) = self.nodes.remove(cur.as_str()) {
                stack.extend(link.children.iter().map(|c| c.to_string()));
            }
        }
    }

    fn children(&self, id: &str) -> Vec<Arc<str>> {
        self.nodes
            .get(id)
            .map(|l| l.children.clone())
            .unwrap_or_default()
    }

    fn slot(&self, id: &str) -> Option<&str> {
        self.nodes.get(id).and_then(|l| l.slot.as_deref())
    }

    /// `true` when `id` is `ancestor` or sits under it (detach-crossing).
    fn is_at_or_under(&self, id: &str, ancestor: &str) -> bool {
        let mut cur = Some(id);
        let mut hops = 0usize;
        while let Some(c) = cur {
            if c == ancestor {
                return true;
            }
            hops += 1;
            if hops > 100_000 {
                return false; // corrupt cycle guard
            }
            cur = self.nodes.get(c).and_then(|l| l.parent.as_deref());
        }
        false
    }

    /// `true` when `id` is in its last parent's children list.
    fn is_linked(&self, id: &str) -> bool {
        self.nodes
            .get(id)
            .and_then(|l| l.parent.as_deref())
            .and_then(|p| self.nodes.get(p))
            .is_some_and(|p| p.children.iter().any(|c| c.as_ref() == id))
    }

    fn apply(&mut self, patch: &Patch) {
        match patch {
            Patch::Create { id, props, .. } => self.create(id, slot_of(props).map(str::to_string)),
            Patch::Insert { parent_id, id, .. }
            | Patch::Move { parent_id, id, .. }
            | Patch::Attach { parent_id, id, .. } => self.link(parent_id, id),
            Patch::Detach { id } => self.unlink(id),
            Patch::Remove { id, .. } => self.remove(id),
            Patch::ClearChildren { id } => {
                for child in self.children(id) {
                    self.remove(&child);
                }
            }
            _ => {}
        }
    }
}

// ---------------------------------------------------------------------------
// One embed
// ---------------------------------------------------------------------------

/// One live embed, keyed in [`State::embeds`] by its `e1:`, `e2:`, …
/// NodeId prefix.
struct Embed {
    /// The HypenApp host node (in its owner's id space, already prefixed
    /// when the owner is itself an embed).
    host_id: Arc<str>,
    /// Prefix of the stream that created the host (`None` = the window's
    /// own module). Drives the depth guard.
    owner_prefix: Option<String>,
    url: String,
    module: Option<Arc<dyn HypenModule>>,
    /// Embed roots ever grafted under the host (Router-cached ones too).
    app_roots: Vec<Arc<str>>,
    /// Embed roots the embedded app currently has linked.
    active_roots: Vec<Arc<str>>,
    loading_slots: Vec<Arc<str>>,
    error_slots: Vec<Arc<str>>,
    /// Ids this layer detached (slot children, roots while errored) — so
    /// no Detach / Attach is ever emitted twice.
    detached: HashSet<Arc<str>>,
    status: EmbedStatus,
}

impl Embed {
    fn new(host_id: Arc<str>, owner_prefix: Option<String>, url: String) -> Self {
        Self {
            host_id,
            owner_prefix,
            url,
            module: None,
            app_roots: Vec::new(),
            active_roots: Vec::new(),
            loading_slots: Vec::new(),
            error_slots: Vec::new(),
            detached: HashSet::new(),
            status: EmbedStatus::Loading,
        }
    }

    /// Detach / Attach patches that bring slot children and embed roots in
    /// line with the current status.
    fn reconcile_visibility(&mut self) -> Vec<Patch> {
        let mut out = Vec::new();
        let host = Arc::clone(&self.host_id);
        let mut set = |detached: &mut HashSet<Arc<str>>, id: &Arc<str>, visible: bool| {
            if visible {
                if detached.remove(id) {
                    out.push(Patch::Attach {
                        parent_id: Arc::clone(&host),
                        id: Arc::clone(id),
                        before_id: None,
                    });
                }
            } else if detached.insert(Arc::clone(id)) {
                out.push(Patch::Detach { id: Arc::clone(id) });
            }
        };
        for id in &self.loading_slots {
            set(&mut self.detached, id, self.status == EmbedStatus::Loading);
        }
        for id in &self.error_slots {
            set(&mut self.detached, id, self.status == EmbedStatus::Error);
        }
        for id in &self.active_roots {
            set(
                &mut self.detached,
                id,
                self.status == EmbedStatus::Connected,
            );
        }
        out
    }
}

fn prefix_id(prefix: &str, id: &Arc<str>) -> Arc<str> {
    Arc::from(format!("{prefix}{id}"))
}

/// The stream prefix of a merged id (`"e3:12"` → `Some("e3:")`), `None`
/// for the window module's own ids.
fn stream_prefix_of(id: &str) -> Option<&str> {
    id.find(':').map(|i| &id[..=i])
}

// ---------------------------------------------------------------------------
// Merged-stream state
// ---------------------------------------------------------------------------

#[derive(Default)]
struct State {
    shadow: Shadow,
    embeds: IndexMap<String, Embed>,
    next_id: u64,
    sink: Option<OwnedPatchCallback>,
}

/// Side effects collected under the lock and run after it is released.
#[derive(Default)]
struct Deferred {
    to_connect: Vec<String>,
    dropped: Vec<Arc<dyn HypenModule>>,
}

impl State {
    fn depth_of(&self, owner: Option<&str>) -> usize {
        let mut depth = 0;
        let mut cur = owner.map(str::to_string);
        while let Some(p) = cur {
            depth += 1;
            if depth > MAX_EMBED_DEPTH {
                break;
            }
            cur = self.embeds.get(&p).and_then(|e| e.owner_prefix.clone());
        }
        depth
    }

    fn embed_hosted_by(&self, id: &str) -> Option<String> {
        self.embeds
            .iter()
            .find(|(_, e)| e.host_id.as_ref() == id)
            .map(|(p, _)| p.clone())
    }

    /// Push `patch` downstream and mirror it into the shadow tree.
    fn emit(&mut self, out: &mut Vec<Patch>, patch: Patch) {
        self.shadow.apply(&patch);
        out.push(patch);
    }

    /// Close `prefix`'s embed: drop its connection, remove its whole
    /// tree (linked, errored-detached and Router-cached alike) and the
    /// slot children this layer detached, and close the embeds nested in
    /// it.
    fn teardown(&mut self, prefix: &str, out: &mut Vec<Patch>, deferred: &mut Deferred) {
        let Some(embed) = self.embeds.shift_remove(prefix) else {
            return;
        };
        log::info!(
            "hypen embed {prefix} closed (host {} removed)",
            embed.host_id
        );
        deferred.to_connect.retain(|p| p != prefix);
        if let Some(m) = embed.module {
            deferred.dropped.push(m);
        }
        // Nested embeds die with their owner.
        let nested: Vec<String> = self
            .embeds
            .iter()
            .filter(|(_, e)| e.owner_prefix.as_deref() == Some(prefix))
            .map(|(p, _)| p.clone())
            .collect();
        for p in nested {
            self.teardown(&p, out, deferred);
        }
        let mut orphans: Vec<Arc<str>> = embed
            .detached
            .iter()
            .filter(|id| !id.starts_with(prefix))
            .cloned()
            .collect();
        // Every top of the embed's own forest: roots linked under the host
        // (a re-Created host keeps its slot in the window, so they would
        // linger), roots it holds detached, and Router-cached subtrees
        // deeper down. Nodes linked under another node of the embed go
        // with their parent.
        orphans.extend(
            self.shadow
                .nodes
                .iter()
                .filter(|(id, link)| {
                    id.starts_with(prefix)
                        && !(self.shadow.is_linked(id)
                            && link.parent.as_ref().is_some_and(|p| p.starts_with(prefix)))
                })
                .map(|(id, _)| Arc::clone(id)),
        );
        for id in orphans {
            if self.shadow.nodes.contains_key(id.as_ref()) {
                self.emit(
                    out,
                    Patch::Remove {
                        id,
                        transition: false,
                    },
                );
            }
        }
    }

    /// Close every embed whose host is at-or-under (`include_root`) or
    /// strictly under `root`.
    fn teardown_under(
        &mut self,
        root: &str,
        include_root: bool,
        out: &mut Vec<Patch>,
        deferred: &mut Deferred,
    ) {
        let doomed: Vec<String> = self
            .embeds
            .iter()
            .filter(|(_, e)| {
                (include_root || e.host_id.as_ref() != root)
                    && self.shadow.is_at_or_under(&e.host_id, root)
            })
            .map(|(p, _)| p.clone())
            .collect();
        for p in doomed {
            self.teardown(&p, out, deferred);
        }
    }

    /// Run one (already id-namespaced) patch through the lifecycle rules,
    /// emitting it plus whatever it implies.
    fn route(&mut self, owner: Option<&str>, patch: Patch, out: &mut Vec<Patch>, d: &mut Deferred) {
        match &patch {
            Patch::Create {
                id,
                element_type,
                props,
                ..
            } if is_hypenapp(element_type) => {
                // A re-Create of a live host (the owner re-sent its tree)
                // replaces the embed rather than stacking a second one.
                if let Some(old) = self.embed_hosted_by(id) {
                    self.teardown(&old, out, d);
                }
                let host = Arc::clone(id);
                let url = embed_url(props);
                self.emit(out, patch);
                if self.depth_of(owner) >= MAX_EMBED_DEPTH {
                    log::warn!("hypen embed: HypenApp {host} exceeds max depth {MAX_EMBED_DEPTH}");
                    return;
                }
                let Some(url) = url else {
                    log::warn!("hypen embed: HypenApp {host} has no url");
                    return;
                };
                self.next_id += 1;
                let prefix = format!("e{}:", self.next_id);
                log::info!("hypen embed {prefix} → {url} (host {host})");
                self.embeds.insert(
                    prefix.clone(),
                    Embed::new(host, owner.map(str::to_string), url),
                );
                d.to_connect.push(prefix);
            }
            Patch::Insert { parent_id, id, .. } | Patch::Attach { parent_id, id, .. } => {
                let (parent, child) = (Arc::clone(parent_id), Arc::clone(id));
                self.emit(out, patch);
                let Some(prefix) = self.embed_hosted_by(&parent) else {
                    return;
                };
                if child.starts_with(prefix.as_str()) {
                    return; // the embed's own root — tracked by `graft`
                }
                let slot = self.shadow.slot(&child).map(str::to_string);
                let embed = self.embeds.get_mut(&prefix).expect("host embed");
                // A host-owned child re-linked by its owner is visible again
                // as far as the owner knows; reconcile from scratch.
                embed.detached.remove(&child);
                let list = match slot.as_deref() {
                    Some("loading") => &mut embed.loading_slots,
                    Some("error") => &mut embed.error_slots,
                    _ => return,
                };
                if !list.contains(&child) {
                    list.push(child);
                }
                for p in embed.reconcile_visibility() {
                    self.emit(out, p);
                }
            }
            Patch::Remove { id, .. } => {
                let id = Arc::clone(id);
                self.teardown_under(&id, true, out, d);
                for e in self.embeds.values_mut() {
                    e.loading_slots.retain(|s| *s != id);
                    e.error_slots.retain(|s| *s != id);
                    e.detached.remove(&id);
                }
                self.emit(out, patch);
            }
            Patch::ClearChildren { id } => {
                let id = Arc::clone(id);
                match self.embed_hosted_by(&id) {
                    // Clearing a host: the owner knows only its own
                    // children — lower to a Remove of each (linked ones and
                    // the slot children this layer detached), leaving the
                    // embedded tree alone.
                    Some(prefix) => {
                        let mut owned: Vec<Arc<str>> = self
                            .shadow
                            .children(&id)
                            .into_iter()
                            .filter(|c| !c.starts_with(prefix.as_str()))
                            .collect();
                        let embed = &self.embeds[&prefix];
                        for s in embed.loading_slots.iter().chain(&embed.error_slots) {
                            if embed.detached.contains(s) && !owned.contains(s) {
                                owned.push(Arc::clone(s));
                            }
                        }
                        for child in owned {
                            self.route(
                                owner,
                                Patch::Remove {
                                    id: child,
                                    transition: false,
                                },
                                out,
                                d,
                            );
                        }
                    }
                    None => {
                        self.teardown_under(&id, false, out, d);
                        self.emit(out, patch);
                    }
                }
            }
            _ => self.emit(out, patch),
        }
    }

    /// Namespace one embed batch into the merged id space and track its
    /// roots: ids get the prefix, `root` becomes the host, a re-sent tree
    /// (reconnect) replaces the old roots, and the first batch flips the
    /// slots from loading to the live tree.
    fn graft(&mut self, prefix: &str, patches: Vec<Patch>, out: &mut Vec<Patch>, d: &mut Deferred) {
        let Some(embed) = self.embeds.get(prefix) else {
            return; // closed while the batch was in flight
        };
        let host = Arc::clone(&embed.host_id);
        let mut new_roots: Vec<Arc<str>> = Vec::new();
        let mut created: HashSet<Arc<str>> = HashSet::new();
        let mut has_detach = false;
        let mut rewritten = Vec::with_capacity(patches.len());
        let parent_of = |parent: &Arc<str>| -> (Arc<str>, bool) {
            if parent.as_ref() == ROOT_ID {
                (Arc::clone(&host), true)
            } else {
                (prefix_id(prefix, parent), false)
            }
        };
        for patch in patches {
            let p = match patch {
                Patch::Create {
                    id,
                    element_type,
                    props,
                    semantics,
                } => {
                    let id = prefix_id(prefix, &id);
                    created.insert(Arc::clone(&id));
                    Patch::Create {
                        id,
                        element_type,
                        props,
                        semantics,
                    }
                }
                Patch::SetSemantics { id, semantics } => Patch::SetSemantics {
                    id: prefix_id(prefix, &id),
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
                Patch::Insert {
                    parent_id,
                    id,
                    before_id,
                } => {
                    let (parent_id, is_root) = parent_of(&parent_id);
                    let id = prefix_id(prefix, &id);
                    if is_root {
                        new_roots.push(Arc::clone(&id));
                    }
                    Patch::Insert {
                        parent_id,
                        id,
                        before_id: before_id.map(|b| prefix_id(prefix, &b)),
                    }
                }
                Patch::Attach {
                    parent_id,
                    id,
                    before_id,
                } => {
                    let (parent_id, is_root) = parent_of(&parent_id);
                    let id = prefix_id(prefix, &id);
                    if is_root {
                        new_roots.push(Arc::clone(&id));
                    }
                    Patch::Attach {
                        parent_id,
                        id,
                        before_id: before_id.map(|b| prefix_id(prefix, &b)),
                    }
                }
                Patch::Move {
                    parent_id,
                    id,
                    before_id,
                } => Patch::Move {
                    parent_id: parent_of(&parent_id).0,
                    id: prefix_id(prefix, &id),
                    before_id: before_id.map(|b| prefix_id(prefix, &b)),
                },
                Patch::Remove { id, transition } => Patch::Remove {
                    id: prefix_id(prefix, &id),
                    transition,
                },
                // The engine never clears `root`; should one arrive, the
                // prefixed `root` names no node, so it stays the
                // protocol's ignored-unknown-id no-op instead of wiping the
                // host's slot children.
                Patch::ClearChildren { id } => Patch::ClearChildren {
                    id: prefix_id(prefix, &id),
                },
                Patch::Detach { id } => {
                    has_detach = true;
                    Patch::Detach {
                        id: prefix_id(prefix, &id),
                    }
                }
                p @ Patch::BatchAnimation { .. } => p,
                // A `RemoteModule` lowers templates before delivery; any
                // that reach here could only expand into unstamped nodes.
                Patch::RegisterTemplate { .. } | Patch::Instantiate { .. } => {
                    log::debug!("hypen embed {prefix}: dropping an unlowered template patch");
                    continue;
                }
            };
            rewritten.push(p);
        }

        let embed = self.embeds.get_mut(prefix).expect("embed present");
        // A root CREATED in a batch with no Router Detach means the server
        // re-sent its tree (a fresh session after a reconnect): remove the
        // old roots first, even when the ids repeat (the prelude Remove is
        // followed by the re-Create, so nothing flashes).
        let replaces = !has_detach && new_roots.iter().any(|r| created.contains(r));
        let mut prelude = Vec::new();
        if replaces && !embed.app_roots.is_empty() {
            for old in embed.app_roots.drain(..) {
                embed.detached.remove(&old);
                prelude.push(Patch::Remove {
                    id: old,
                    transition: false,
                });
            }
            embed.active_roots.clear();
        }
        for p in &rewritten {
            match p {
                Patch::Insert { parent_id, id, .. }
                | Patch::Attach { parent_id, id, .. }
                | Patch::Move { parent_id, id, .. }
                    if *parent_id == embed.host_id =>
                {
                    if !embed.app_roots.contains(id) {
                        embed.app_roots.push(Arc::clone(id));
                    }
                    if !embed.active_roots.contains(id) {
                        embed.active_roots.push(Arc::clone(id));
                    }
                    embed.detached.remove(id);
                }
                Patch::Detach { id } if embed.app_roots.contains(id) => {
                    embed.active_roots.retain(|r| r != id);
                }
                Patch::Remove { id, .. } => {
                    embed.app_roots.retain(|r| r != id);
                    embed.active_roots.retain(|r| r != id);
                    embed.detached.remove(id);
                }
                _ => {}
            }
        }
        // First live batch (or the first after an error): the embedded
        // tree owns the frame now. The slot flip is emitted after the
        // batch, once the roots it attaches exist.
        let first_tree = embed.status != EmbedStatus::Connected;
        if first_tree {
            embed.status = EmbedStatus::Connected;
        }
        let owner = Some(prefix.to_string());
        for p in prelude.into_iter().chain(rewritten) {
            self.route(owner.as_deref(), p, out, d);
        }
        if first_tree {
            if let Some(embed) = self.embeds.get_mut(prefix) {
                for p in embed.reconcile_visibility() {
                    self.emit(out, p);
                }
            }
        }
    }

    fn signal(&mut self, prefix: &str, signal: EmbedSignal, out: &mut Vec<Patch>) {
        let Some(embed) = self.embeds.get_mut(prefix) else {
            return;
        };
        let to_error = match signal {
            EmbedSignal::Failed => true,
            // A retry after a live tree keeps showing that tree (the web
            // embed does the same while it reconnects).
            EmbedSignal::Retrying => embed.status == EmbedStatus::Loading,
        };
        if !to_error || embed.status == EmbedStatus::Error {
            return;
        }
        log::info!("hypen embed {prefix} → error ({signal:?}, {})", embed.url);
        embed.status = EmbedStatus::Error;
        for p in embed.reconcile_visibility() {
            self.emit(out, p);
        }
    }

    fn deliver(&mut self, out: Vec<Patch>) {
        if out.is_empty() {
            return;
        }
        if let Some(sink) = self.sink.as_ref() {
            sink(out);
        }
    }
}

struct Core {
    state: Mutex<State>,
    connector: EmbedConnector,
}

impl Core {
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Process a batch and forward the result while holding the lock, so
    /// batches from different streams reach the window in a consistent
    /// order (a host's Create always precedes its embed's first Insert).
    fn process(self: &Arc<Self>, stream: Option<&str>, patches: Vec<Patch>) {
        let mut d = Deferred::default();
        {
            let mut g = self.lock();
            let mut out = Vec::with_capacity(patches.len());
            match stream {
                None => {
                    for p in patches {
                        g.route(None, p, &mut out, &mut d);
                    }
                }
                Some(prefix) => g.graft(prefix, patches, &mut out, &mut d),
            }
            g.deliver(out);
        }
        self.finish(d);
    }

    fn finish(self: &Arc<Self>, d: Deferred) {
        drop(d.dropped); // closes the torn-down connections, outside the lock
        for prefix in d.to_connect {
            self.connect(prefix);
        }
    }

    /// Open the embed's connection and wire its callbacks. Runs without the
    /// lock: a module may deliver its backlog / status synchronously.
    fn connect(self: &Arc<Self>, prefix: String) {
        let Some(url) = self.lock().embeds.get(&prefix).map(|e| e.url.clone()) else {
            return;
        };
        let weak = Arc::downgrade(self);
        let signal_prefix = prefix.clone();
        let signal: EmbedSignalSink = Arc::new(move |s| {
            if let Some(core) = weak.upgrade() {
                let mut g = core.lock();
                let mut out = Vec::new();
                g.signal(&signal_prefix, s, &mut out);
                g.deliver(out);
            }
        });
        let module = (self.connector)(&url, signal);
        let weak = Arc::downgrade(self);
        let batch_prefix = prefix.clone();
        module.on_owned_patches(Arc::new(move |patches: Vec<Patch>| {
            if let Some(core) = weak.upgrade() {
                core.process(Some(&batch_prefix), patches);
            }
        }));
        module.mount();
        let stale = {
            let mut g = self.lock();
            match g.embeds.get_mut(&prefix) {
                Some(e) => {
                    e.module = Some(module);
                    None
                }
                // Closed while connecting.
                None => Some(module),
            }
        };
        drop(stale);
    }

    /// The module owning merged id `node`, and the id in its own space.
    fn owner_of(&self, node: &str) -> Option<(Arc<dyn HypenModule>, String)> {
        let prefix = stream_prefix_of(node)?;
        let g = self.lock();
        let module = g.embeds.get(prefix)?.module.clone()?;
        Some((module, node[prefix.len()..].to_string()))
    }
}

/// A [`HypenModule`] that renders `HypenApp` embeds found in the wrapped
/// module's stream (see the module docs). [`crate::DesktopApp::connect`]
/// wraps every remote connection in one.
pub struct EmbeddingModule {
    root: Arc<dyn HypenModule>,
    core: Arc<Core>,
}

impl EmbeddingModule {
    /// Wrap `root`, connecting embeds with [`remote_embed_connector`].
    pub fn new(root: Arc<dyn HypenModule>) -> Self {
        Self::with_connector(root, remote_embed_connector())
    }

    /// Wrap `root` with a custom embed connector.
    pub fn with_connector(root: Arc<dyn HypenModule>, connector: EmbedConnector) -> Self {
        Self {
            root,
            core: Arc::new(Core {
                state: Mutex::new(State::default()),
                connector,
            }),
        }
    }

    /// Number of live embeds (diagnostics / tests).
    pub fn embed_count(&self) -> usize {
        self.core.lock().embeds.len()
    }
}

impl HypenModule for EmbeddingModule {
    fn on_patches(&self, cb: Arc<dyn Fn(&[Patch]) + Send + Sync>) {
        self.on_owned_patches(Arc::new(move |patches: Vec<Patch>| cb(&patches)));
    }

    fn on_owned_patches(&self, cb: OwnedPatchCallback) {
        self.core.lock().sink = Some(cb);
        let weak = Arc::downgrade(&self.core);
        self.root
            .on_owned_patches(Arc::new(move |patches: Vec<Patch>| {
                if let Some(core) = weak.upgrade() {
                    core.process(None, patches);
                }
            }));
    }

    fn mount(&self) {
        self.root.mount();
    }

    fn dispatch_action(&self, name: &str, payload: Option<Value>) {
        self.root.dispatch_action(name, payload);
    }

    fn dispatch_ui_action(&self, node: &str, action: &str, payload: Option<Value>) {
        let localize_from = |payload: Option<Value>, prefix: Option<&str>| -> Option<Value> {
            let mut payload = payload?;
            if let Some(obj) = payload.as_object_mut() {
                if let Some(from) = obj.get("fromNode").and_then(Value::as_str) {
                    let local = match (stream_prefix_of(from), prefix) {
                        (None, None) => Value::String(from.to_string()),
                        (Some(p), Some(q)) if p == q => Value::String(from[p.len()..].to_string()),
                        // A node from another stream means nothing there.
                        _ => Value::Null,
                    };
                    obj.insert("fromNode".into(), local);
                }
            }
            Some(payload)
        };
        match stream_prefix_of(node) {
            None => self
                .root
                .dispatch_ui_action(node, action, localize_from(payload, None)),
            Some(prefix) => match self.core.owner_of(node) {
                Some((module, local)) => {
                    module.dispatch_ui_action(&local, action, localize_from(payload, Some(prefix)))
                }
                None => log::debug!("hypen embed: dropping {action} for closed embed node {node}"),
            },
        }
    }

    fn set_list_viewport(&self, list_id: &str, start: usize, end: usize) {
        match stream_prefix_of(list_id) {
            None => self.root.set_list_viewport(list_id, start, end),
            Some(_) => {
                if let Some((module, local)) = self.core.owner_of(list_id) {
                    module.set_list_viewport(&local, start, end);
                }
            }
        }
    }

    fn asset_origin(&self) -> Option<Arc<str>> {
        self.root.asset_origin()
    }
}

#[cfg(test)]
#[path = "embed_tests.rs"]
mod tests;
