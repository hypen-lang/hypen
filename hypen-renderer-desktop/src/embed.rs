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
//! Breadth and targets are bounded by an [`EmbedPolicy`] the host app can
//! configure ([`EmbeddingModule::with_policy`], [`crate::DesktopApp::embed_policy`]):
//! at most [`EmbedPolicy::max_embeds`] live embeds and
//! [`EmbedPolicy::max_per_owner`] per embedding stream, all on ONE shared
//! remote runtime thread; only `ws:` / `wss:` targets; from secure content
//! (`https:` / `wss:`) only `wss:` (the browser's mixed-content rule the DOM
//! `HypenApp` is subject to); and no private / loopback target from public
//! content (Chrome's Private Network Access rule) unless the host allows it
//! — checked on the URL's host and again on the address it RESOLVES to at
//! connect time, pinned for the connection (DNS rebinding; see
//! [`crate::remote::PublicAddressesOnly`]) — content that is itself local (an in-process module, a `localhost` dev
//! server) may embed local apps, as the launcher does. A refused embed shows
//! its `error` slot.
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
    /// The server is about to send a whole tree (`initialTree`): a fresh
    /// session after a reconnect. The next batch replaces the embed's old
    /// roots, as the DOM `HypenApp` clears on `onInitialTree`.
    InitialTree,
}

/// Limits on what `HypenApp` embeds the window will open (see the module
/// docs). Remote content decides how many HypenApp elements it creates and
/// where they point, so the host app bounds both.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmbedPolicy {
    /// Live embeds in the whole window (nested ones included).
    pub max_embeds: usize,
    /// Live embeds one stream (the window's app, or one embed) may open.
    pub max_per_owner: usize,
    /// When `Some`, the only `host` / `host:port` targets allowed (case-
    /// insensitive); listed private hosts are then allowed from any
    /// content. `None`: any public host.
    pub allowed_hosts: Option<Vec<String>>,
    /// Let PUBLIC content embed private / loopback targets too.
    pub allow_private_targets: bool,
}

impl Default for EmbedPolicy {
    fn default() -> Self {
        Self {
            max_embeds: 8,
            max_per_owner: 4,
            allowed_hosts: None,
            allow_private_targets: false,
        }
    }
}

impl EmbedPolicy {
    pub fn max_embeds(mut self, n: usize) -> Self {
        self.max_embeds = n;
        self
    }

    pub fn max_per_owner(mut self, n: usize) -> Self {
        self.max_per_owner = n;
        self
    }

    /// Restrict targets to these `host` / `host:port` entries.
    pub fn allow_hosts<I: IntoIterator<Item = S>, S: Into<String>>(mut self, hosts: I) -> Self {
        self.allowed_hosts = Some(hosts.into_iter().map(Into::into).collect());
        self
    }

    pub fn allow_private_targets(mut self, on: bool) -> Self {
        self.allow_private_targets = on;
        self
    }

    /// Whether content served from `owner` (a `ws(s):` / `http(s):` URL or
    /// origin; `None` = the host app's own in-process module) may embed
    /// `target`. `Err` carries the reason, for the log.
    pub fn check_target(&self, owner: Option<&str>, target: &str) -> Result<(), String> {
        let Some(t) = UrlParts::parse(target) else {
            return Err(format!("{target:?} is not a URL"));
        };
        if !matches!(t.scheme.as_str(), "ws" | "wss") {
            return Err(format!("{target:?}: only ws: / wss: targets"));
        }
        let owner = owner.and_then(UrlParts::parse);
        if owner.as_ref().is_some_and(UrlParts::is_secure) && t.scheme != "wss" {
            return Err(format!("{target:?}: insecure target from secure content"));
        }
        if let Some(allowed) = &self.allowed_hosts {
            let listed = allowed.iter().any(|a| {
                let a = a.trim().to_ascii_lowercase();
                a == t.host || a == t.host_port()
            });
            return if listed {
                Ok(())
            } else {
                Err(format!("{target:?}: host not in the allowlist"))
            };
        }
        // Private Network Access: a public page may not reach a private
        // address. Local content (no owner URL, or a private one) may.
        let owner_is_local = owner.as_ref().is_none_or(UrlParts::is_private);
        if t.is_private() && !owner_is_local && !self.allow_private_targets {
            return Err(format!("{target:?}: private target from public content"));
        }
        Ok(())
    }

    /// The address rule an ALLOWED embed's connection must enforce: when
    /// the private-network rule applies (public content, no allowlist, no
    /// [`Self::allow_private_targets`]), the host the URL names must also
    /// RESOLVE to public addresses only — checked at connect time, on the
    /// address actually connected to ([`crate::remote::PublicAddressesOnly`]),
    /// so DNS rebinding and numeric host forms the URL check cannot see
    /// (`2130706433`, `127.1`) are refused too.
    pub fn address_rule(&self, owner: Option<&str>) -> AddressRule {
        let owner_is_local = owner
            .and_then(UrlParts::parse)
            .as_ref()
            .is_none_or(UrlParts::is_private);
        if self.allowed_hosts.is_none() && !self.allow_private_targets && !owner_is_local {
            AddressRule::PublicOnly
        } else {
            AddressRule::Any
        }
    }
}

/// What an embed connection must enforce on the address it connects to
/// (see [`EmbedPolicy::address_rule`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AddressRule {
    /// Whatever the host resolves to.
    Any,
    /// Public addresses only, resolved and pinned at connect time.
    PublicOnly,
}

/// Just what [`EmbedPolicy`] needs out of a URL.
struct UrlParts {
    scheme: String,
    /// Lower-case host, IPv6 without brackets.
    host: String,
    port: Option<u16>,
}

impl UrlParts {
    fn parse(url: &str) -> Option<Self> {
        let (scheme, rest) = url.trim().split_once("://")?;
        let authority = rest.split(['/', '?', '#']).next()?;
        let authority = authority.rsplit_once('@').map_or(authority, |(_, a)| a);
        let (host, port) = if let Some(v6) = authority.strip_prefix('[') {
            let (host, after) = v6.split_once(']')?;
            (host, after.strip_prefix(':'))
        } else {
            match authority.rsplit_once(':') {
                Some((h, p)) => (h, Some(p)),
                None => (authority, None),
            }
        };
        if host.is_empty() {
            return None;
        }
        let port = match port {
            Some(p) => Some(p.parse().ok()?),
            None => None,
        };
        Some(Self {
            scheme: scheme.to_ascii_lowercase(),
            host: host.to_ascii_lowercase(),
            port,
        })
    }

    fn host_port(&self) -> String {
        match self.port {
            Some(p) if self.host.contains(':') => format!("[{}]:{p}", self.host),
            Some(p) => format!("{}:{p}", self.host),
            None => self.host.clone(),
        }
    }

    fn is_secure(&self) -> bool {
        matches!(self.scheme.as_str(), "https" | "wss")
    }

    /// Loopback, private, link-local, CGNAT or unspecified addresses, and
    /// the `localhost` / `.local` names — what Chrome's Private Network
    /// Access treats as non-public. A public name that RESOLVES to a
    /// private address is caught at connect time instead
    /// ([`EmbedPolicy::address_rule`]).
    fn is_private(&self) -> bool {
        let host = self.host.trim_end_matches('.');
        if host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") {
            return true;
        }
        host.parse::<std::net::IpAddr>()
            .is_ok_and(is_non_public_ip)
    }
}

/// Whether `ip` is not a public unicast address — what the embed policy's
/// private-network rule refuses from public content: loopback, private
/// (RFC 1918), link-local (incl. the `169.254.169.254` metadata service),
/// CGNAT `100.64/10`, `0.0.0.0/8`, broadcast / multicast, and on IPv6
/// loopback, unspecified, ULA `fc00::/7`, link-local `fe80::/10`,
/// site-local `fec0::/10`, multicast, plus every IPv4 address carried in
/// IPv6 (mapped `::ffff:a.b.c.d`, compatible `::a.b.c.d`, NAT64
/// `64:ff9b::/96`, 6to4 `2002::/16`) judged as that IPv4 address.
pub fn is_non_public_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => is_non_public_v4(v4),
        std::net::IpAddr::V6(v6) => {
            let seg = v6.segments();
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_non_public_v4(v4);
            }
            // IPv4-compatible `::a.b.c.d` (deprecated; `::` and `::1` are
            // themselves caught below).
            if seg[..6].iter().all(|&s| s == 0) && !v6.is_loopback() && !v6.is_unspecified() {
                return is_non_public_v4(std::net::Ipv4Addr::new(
                    (seg[6] >> 8) as u8,
                    seg[6] as u8,
                    (seg[7] >> 8) as u8,
                    seg[7] as u8,
                ));
            }
            // NAT64 well-known prefix 64:ff9b::/96.
            if seg[0] == 0x64 && seg[1] == 0xff9b && seg[2..6].iter().all(|&s| s == 0) {
                return is_non_public_v4(std::net::Ipv4Addr::new(
                    (seg[6] >> 8) as u8,
                    seg[6] as u8,
                    (seg[7] >> 8) as u8,
                    seg[7] as u8,
                ));
            }
            // 6to4 2002:AABB:CCDD::/48 carries AA.BB.CC.DD.
            if seg[0] == 0x2002 {
                return is_non_public_v4(std::net::Ipv4Addr::new(
                    (seg[1] >> 8) as u8,
                    seg[1] as u8,
                    (seg[2] >> 8) as u8,
                    seg[2] as u8,
                ));
            }
            let first = seg[0];
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (first & 0xfe00) == 0xfc00 // unique local fc00::/7
                || (first & 0xffc0) == 0xfe80 // link-local fe80::/10
                || (first & 0xffc0) == 0xfec0 // site-local fec0::/10
        }
    }
}

fn is_non_public_v4(v4: std::net::Ipv4Addr) -> bool {
    let [a, b, ..] = v4.octets();
    a == 0 // 0.0.0.0/8 ("this network"; 0.0.0.0 reaches the local host)
        || v4.is_loopback()
        || v4.is_private()
        || v4.is_link_local()
        || v4.is_broadcast()
        || v4.is_multicast()
        || (a == 100 && (64..128).contains(&b)) // CGNAT 100.64/10
}

/// Receives an embed connection's [`EmbedSignal`]s.
pub type EmbedSignalSink = Arc<dyn Fn(EmbedSignal) + Send + Sync>;

/// Opens the connection for one embed: given its URL and a signal sink,
/// returns the module whose patches are grafted under the host. The
/// default is [`remote_embed_connector`]; tests inject in-process fakes.
pub type EmbedConnector =
    Arc<dyn Fn(&str, AddressRule, EmbedSignalSink) -> Arc<dyn HypenModule> + Send + Sync>;

/// The production connector: a UI-only [`RemoteModule`] per embed (no
/// device host — the web embed is UI-only too unless its host supplies a
/// device factory), logged in as [`EMBED_MODULE_NAME`].
pub fn remote_embed_connector() -> EmbedConnector {
    Arc::new(|url: &str, rule: AddressRule, signal: EmbedSignalSink| {
        // Every embed shares one remote runtime thread.
        let public_only = (rule == AddressRule::PublicOnly)
            .then(crate::remote::PublicAddressesOnly::new);
        let remote = RemoteModule::connect_with(
            url,
            EMBED_MODULE_NAME,
            RemoteOptions::default()
                .device(None)
                .shared_runtime(true)
                .public_addresses_only(public_only),
        );
        let tree_signal = Arc::clone(&signal);
        remote.on_initial_tree(move || tree_signal(EmbedSignal::InitialTree));
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
    /// Refused by the [`EmbedPolicy`]: never connected, shows its error
    /// slot, does not count toward the limits.
    refused: bool,
    /// An `initialTree` was announced after a tree had rendered: the next
    /// batch replaces the old roots.
    reset_pending: bool,
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
            refused: false,
            reset_pending: false,
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
/// for the window module's own ids. An escaped root id (`"r:…"`, see
/// [`escape_root_id`]) has the prefix `"r:"`, which names no embed; use
/// [`split_merged`] to tell the streams apart.
fn stream_prefix_of(id: &str) -> Option<&str> {
    id.find(':').map(|i| &id[..=i])
}

/// Prefix of a window-module id that itself contains a `:` in the merged
/// id space. Embed prefixes are `e<n>:`, so this one is never an embed's.
const ROOT_ESCAPE: &str = "r:";

/// A window-module id in the merged space. The module's ids are passed
/// through unprefixed, so one that contains a `:` would read as an embed's
/// node (`"e1:2"`): its patches would land on — and its events route to —
/// the embedded app's node. Such ids are escaped as `"r:" + id`; every
/// other id stays as it is (no allocation).
fn escape_root_id(id: Arc<str>) -> Arc<str> {
    if id.contains(':') {
        Arc::from(format!("{ROOT_ESCAPE}{id}"))
    } else {
        id
    }
}

/// Which stream owns a merged id (`None`: the window module) and the id
/// in that stream's own space.
fn split_merged(id: &str) -> (Option<&str>, &str) {
    match stream_prefix_of(id) {
        None => (None, id),
        Some(ROOT_ESCAPE) => (None, &id[ROOT_ESCAPE.len()..]),
        Some(p) => (Some(p), &id[p.len()..]),
    }
}

/// [`escape_root_id`] over every node id a window-module patch carries.
fn escape_root_patch(patch: Patch) -> Patch {
    let e = escape_root_id;
    match patch {
        Patch::Create {
            id,
            element_type,
            props,
            semantics,
        } => Patch::Create {
            id: e(id),
            element_type,
            props,
            semantics,
        },
        Patch::SetSemantics { id, semantics } => Patch::SetSemantics {
            id: e(id),
            semantics,
        },
        Patch::SetProp { id, name, value } => Patch::SetProp {
            id: e(id),
            name,
            value,
        },
        Patch::RemoveProp { id, name } => Patch::RemoveProp { id: e(id), name },
        Patch::SetText { id, text } => Patch::SetText { id: e(id), text },
        Patch::Insert {
            parent_id,
            id,
            before_id,
        } => Patch::Insert {
            parent_id: e(parent_id),
            id: e(id),
            before_id: before_id.map(e),
        },
        Patch::Attach {
            parent_id,
            id,
            before_id,
        } => Patch::Attach {
            parent_id: e(parent_id),
            id: e(id),
            before_id: before_id.map(e),
        },
        Patch::Move {
            parent_id,
            id,
            before_id,
        } => Patch::Move {
            parent_id: e(parent_id),
            id: e(id),
            before_id: before_id.map(e),
        },
        Patch::Remove { id, transition } => Patch::Remove {
            id: e(id),
            transition,
        },
        Patch::ClearChildren { id } => Patch::ClearChildren { id: e(id) },
        Patch::Detach { id } => Patch::Detach { id: e(id) },
        other => other,
    }
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
    policy: EmbedPolicy,
    /// Origin of the window's own module (`None`: an in-process module).
    root_origin: Option<Arc<str>>,
}

/// Side effects collected under the lock and run after it is released.
#[derive(Default)]
struct Deferred {
    to_connect: Vec<String>,
    dropped: Vec<Arc<dyn HypenModule>>,
}

impl State {
    /// Why the [`EmbedPolicy`] refuses an embed of `url` by stream `owner`.
    /// The URL the content of stream `owner` came from (`None` owner: the
    /// window module's origin, itself `None` for an in-process module).
    fn owner_url(&self, owner: Option<&str>) -> Option<&str> {
        match owner {
            None => self.root_origin.as_deref(),
            Some(prefix) => self.embeds.get(prefix).map(|e| e.url.as_str()),
        }
    }

    fn refusal(&self, owner: Option<&str>, url: &str) -> Option<String> {
        let owner_url = self.owner_url(owner);
        if let Err(reason) = self.policy.check_target(owner_url, url) {
            return Some(reason);
        }
        let live = || self.embeds.values().filter(|e| !e.refused);
        if live().count() >= self.policy.max_embeds {
            return Some(format!(
                "{} live embeds (max_embeds)",
                self.policy.max_embeds
            ));
        }
        if live()
            .filter(|e| e.owner_prefix.as_deref() == owner)
            .count()
            >= self.policy.max_per_owner
        {
            return Some(format!(
                "{} embeds from one stream (max_per_owner)",
                self.policy.max_per_owner
            ));
        }
        None
    }

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
                let refusal = self.refusal(owner, &url);
                self.next_id += 1;
                let prefix = format!("e{}:", self.next_id);
                let mut embed = Embed::new(host.clone(), owner.map(str::to_string), url);
                if let Some(reason) = refusal {
                    log::warn!("hypen embed: HypenApp {host} refused: {reason}");
                    embed.refused = true;
                    embed.status = EmbedStatus::Error;
                    self.embeds.insert(prefix, embed);
                    return;
                }
                log::info!("hypen embed {prefix} → {} (host {host})", embed.url);
                self.embeds.insert(prefix.clone(), embed);
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
        let mut rewritten = Vec::with_capacity(patches.len());
        let parent_of = |parent: &Arc<str>| -> Arc<str> {
            if parent.as_ref() == ROOT_ID {
                Arc::clone(&host)
            } else {
                prefix_id(prefix, parent)
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
                    let id = prefix_id(prefix, &id);
                    Patch::Insert {
                        parent_id: parent_of(&parent_id),
                        id,
                        before_id: before_id.map(|b| prefix_id(prefix, &b)),
                    }
                }
                Patch::Attach {
                    parent_id,
                    id,
                    before_id,
                } => {
                    let id = prefix_id(prefix, &id);
                    Patch::Attach {
                        parent_id: parent_of(&parent_id),
                        id,
                        before_id: before_id.map(|b| prefix_id(prefix, &b)),
                    }
                }
                Patch::Move {
                    parent_id,
                    id,
                    before_id,
                } => Patch::Move {
                    parent_id: parent_of(&parent_id),
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
                Patch::Detach { id } => Patch::Detach {
                    id: prefix_id(prefix, &id),
                },
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
        // The connection announced an `initialTree` (EmbedSignal::
        // InitialTree) after a tree had rendered: the server re-sent its
        // whole tree (a fresh session after a reconnect). Remove the old
        // roots first, even when the ids repeat (the prelude Remove is
        // followed by the re-Create, so nothing flashes). Only that
        // explicit marker counts — an ordinary batch that creates and
        // inserts a root (a top-level conditional swapping one of several
        // roots, a Router's first visit) is incremental.
        let replaces = std::mem::take(&mut embed.reset_pending);
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
            EmbedSignal::InitialTree => {
                if !embed.app_roots.is_empty() {
                    embed.reset_pending = true;
                }
                return;
            }
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
                        g.route(None, escape_root_patch(p), &mut out, &mut d);
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
        let target = {
            let g = self.lock();
            g.embeds.get(&prefix).map(|e| {
                let rule = g
                    .policy
                    .address_rule(g.owner_url(e.owner_prefix.as_deref()));
                (e.url.clone(), rule)
            })
        };
        let Some((url, rule)) = target else {
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
        let module = (self.connector)(&url, rule, signal);
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
        let (Some(prefix), local) = split_merged(node) else {
            return None;
        };
        let g = self.lock();
        let module = g.embeds.get(prefix)?.module.clone()?;
        Some((module, local.to_string()))
    }
}

/// Rewrite a UI-action envelope's node ids (`node`, `fromNode`, and a
/// nested `payload.fromNode`) from the merged id space into the space of
/// the stream with `prefix` (`None` = the window module). An id from a
/// different stream means nothing there and becomes `null`.
fn localize_envelope(mut envelope: Value, prefix: Option<&str>) -> Value {
    let localize = |id: &str| -> Value {
        match (split_merged(id), prefix) {
            ((None, local), None) => Value::String(local.to_string()),
            ((Some(p), local), Some(q)) if p == q => Value::String(local.to_string()),
            _ => Value::Null,
        }
    };
    if let Some(obj) = envelope.as_object_mut() {
        for key in ["node", "fromNode"] {
            if let Some(id) = obj.get(key).and_then(Value::as_str).map(str::to_string) {
                obj.insert(key.into(), localize(&id));
            }
        }
        if let Some(inner) = obj.get_mut("payload").and_then(Value::as_object_mut) {
            if let Some(id) = inner
                .get("fromNode")
                .and_then(Value::as_str)
                .map(str::to_string)
            {
                inner.insert("fromNode".into(), localize(&id));
            }
        }
    }
    envelope
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
        let state = State {
            root_origin: root.asset_origin(),
            ..State::default()
        };
        Self {
            root,
            core: Arc::new(Core {
                state: Mutex::new(state),
                connector,
            }),
        }
    }

    /// Replace the [`EmbedPolicy`] (limits and allowed targets) for embeds
    /// created from now on.
    pub fn with_policy(self, policy: EmbedPolicy) -> Self {
        self.core.lock().policy = policy;
        self
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
        // A node-addressed UI envelope (`__hypen_dispatch` — what the
        // drag-and-drop runtime sends: `{node, fromNode, action, payload}`)
        // belongs to the stream that owns its node, with the ids in that
        // stream's own space; anything else is the window module's.
        if name == hypen_engine::action_routing::UI_ACTION {
            let node = payload
                .as_ref()
                .and_then(|p| p.get("node"))
                .and_then(Value::as_str)
                .map(str::to_string);
            if let (Some(node), Some(envelope)) = (node, payload.as_ref()) {
                let (prefix, _) = split_merged(&node);
                let envelope = localize_envelope(envelope.clone(), prefix);
                match prefix {
                    None => self.root.dispatch_action(name, Some(envelope)),
                    Some(_) => match self.core.owner_of(&node) {
                        Some((module, _)) => module.dispatch_action(name, Some(envelope)),
                        None => log::debug!(
                            "hypen embed: dropping a UI action for closed embed node {node}"
                        ),
                    },
                }
                return;
            }
            // No `node`: the window module's — with any embed id in it
            // (`fromNode`) blanked like any other cross-stream id.
            let payload = payload.map(|envelope| localize_envelope(envelope, None));
            self.root.dispatch_action(name, payload);
            return;
        }
        self.root.dispatch_action(name, payload);
    }

    fn dispatch_ui_action(&self, node: &str, action: &str, payload: Option<Value>) {
        let localize_from = |payload: Option<Value>, prefix: Option<&str>| -> Option<Value> {
            let mut payload = payload?;
            if let Some(obj) = payload.as_object_mut() {
                if let Some(from) = obj.get("fromNode").and_then(Value::as_str) {
                    let local = match (split_merged(from), prefix) {
                        ((None, local), None) => Value::String(local.to_string()),
                        ((Some(p), local), Some(q)) if p == q => Value::String(local.to_string()),
                        // A node from another stream means nothing there.
                        _ => Value::Null,
                    };
                    obj.insert("fromNode".into(), local);
                }
            }
            Some(payload)
        };
        match split_merged(node) {
            (None, local) => self
                .root
                .dispatch_ui_action(local, action, localize_from(payload, None)),
            (Some(prefix), _) => match self.core.owner_of(node) {
                Some((module, local)) => {
                    module.dispatch_ui_action(&local, action, localize_from(payload, Some(prefix)))
                }
                None => log::debug!("hypen embed: dropping {action} for closed embed node {node}"),
            },
        }
    }

    fn set_list_viewport(&self, list_id: &str, start: usize, end: usize) {
        match split_merged(list_id) {
            (None, local) => self.root.set_list_viewport(local, start, end),
            (Some(_), _) => {
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
