//! Native `HypenApp(url)` embed support for desktop hosts.
//!
//! The engine treats `HypenApp` as an ordinary element. This module is the
//! renderer-side host: it notices `HypenApp` creates in any patch stream,
//! opens a nested [`RemoteModule`], rewrites embedded node ids under an
//! `e<n>:` prefix, grafts the remote root under the host node, and routes
//! embedded actions back to the right remote session.

use crate::module::HypenModule;
use crate::remote::{ConnectionStatus, RemoteModule};
use crate::tree::{Tree, ROOT_ID};
use hypen_engine::Patch;
use indexmap::IndexMap;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

type PatchCallback = Arc<dyn Fn(&[Patch]) + Send + Sync>;

/// Embeds nested deeper than this are refused. This mirrors hypen-browser and
/// prevents accidentally self-recursive apps from creating an unbounded socket
/// tree.
pub const MAX_EMBED_DEPTH: usize = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmbedStatus {
    Loading,
    Connected,
    Error,
}

/// One live `HypenApp` embed.
pub struct Embed {
    /// `e1:`, `e2:`, ...; both the node-id prefix and action marker.
    pub id_prefix: String,
    /// Renderer-side id of the HypenApp host node.
    pub host_id: String,
    /// Prefix of the stream that created the host node (`""` for the primary
    /// desktop module, `e2:` for a parent embed).
    pub owner_prefix: String,
    pub url: String,
    pub remote: Option<Arc<RemoteModule>>,
    pub app_root_ids: Vec<String>,
    pub active_root_ids: Vec<String>,
    pub loading_slot_ids: Vec<String>,
    pub error_slot_ids: Vec<String>,
    pub detached: HashSet<String>,
    pub status: EmbedStatus,
    pub expander: hypen_engine::TemplateExpander,
}

impl Embed {
    pub fn new(id_prefix: String, host_id: String, owner_prefix: String, url: String) -> Self {
        Self {
            id_prefix,
            host_id,
            owner_prefix,
            url,
            remote: None,
            app_root_ids: Vec::new(),
            active_root_ids: Vec::new(),
            loading_slot_ids: Vec::new(),
            error_slot_ids: Vec::new(),
            detached: HashSet::new(),
            status: EmbedStatus::Loading,
            expander: hypen_engine::TemplateExpander::new(),
        }
    }

    pub fn reconcile_visibility(&mut self) -> Vec<Patch> {
        let mut out = Vec::new();
        let show_loading = self.status == EmbedStatus::Loading;
        let show_error = self.status == EmbedStatus::Error;
        let show_content = self.status == EmbedStatus::Connected;

        fn set_visible(
            out: &mut Vec<Patch>,
            detached: &mut HashSet<String>,
            host: &str,
            id: &str,
            visible: bool,
        ) {
            if visible {
                if detached.remove(id) {
                    out.push(Patch::Attach {
                        parent_id: host.into(),
                        id: id.into(),
                        before_id: None,
                    });
                }
            } else if !detached.contains(id) {
                detached.insert(id.to_string());
                out.push(Patch::Detach { id: id.into() });
            }
        }

        for id in &self.loading_slot_ids {
            set_visible(&mut out, &mut self.detached, &self.host_id, id, show_loading);
        }
        for id in &self.error_slot_ids {
            set_visible(&mut out, &mut self.detached, &self.host_id, id, show_error);
        }
        for id in &self.active_root_ids {
            set_visible(&mut out, &mut self.detached, &self.host_id, id, show_content);
        }
        out
    }
}

/// A transparent [`HypenModule`] adapter that adds `HypenApp` hosting to any
/// local or remote module.
pub struct HypenAppHost {
    primary: Arc<dyn HypenModule>,
    inner: Arc<Mutex<HostInner>>,
}

#[derive(Default)]
struct HostInner {
    callback: Option<PatchCallback>,
    pending: Vec<Patch>,
    embeds: IndexMap<String, Embed>,
    next_embed_id: u64,
    detached_parents: HashMap<String, String>,
    tree: Tree,
}

#[derive(Default)]
pub struct EmbedLifecycle {
    pub extra: Vec<Patch>,
    pub to_connect: Vec<String>,
}

impl HypenAppHost {
    pub fn new(primary: Arc<dyn HypenModule>) -> Arc<Self> {
        let inner = Arc::new(Mutex::new(HostInner {
            next_embed_id: 1,
            tree: Tree::new(),
            ..HostInner::default()
        }));
        let host = Arc::new(Self {
            primary: Arc::clone(&primary),
            inner,
        });

        let weak = Arc::downgrade(&host);
        primary.on_patches(Arc::new(move |patches: &[Patch]| {
            let Some(host) = weak.upgrade() else {
                return;
            };
            host.forward_primary_patches(patches);
        }));

        host
    }

    fn forward_primary_patches(&self, patches: &[Patch]) {
        let mut forwarded = patches.to_vec();
        let lifecycle = handle_embed_lifecycle(&self.inner, &forwarded);
        forwarded.extend(lifecycle.extra);
        forward(&self.inner, &forwarded);
        for marker in lifecycle.to_connect {
            connect_embed(&self.inner, marker);
        }
    }

    fn try_dispatch_embed(&self, name: &str, payload: &Option<Value>) -> bool {
        let (remote, name, payload) = {
            let g = self.inner.lock().expect("embed host inner poisoned");
            if name == "__hypen_bind" {
                let Some(path) = payload
                    .as_ref()
                    .and_then(|p| p.get("path"))
                    .and_then(Value::as_str)
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
                    return true;
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
        remote.dispatch_action(&name, payload);
        true
    }

    fn try_dispatch_embed_ui(&self, envelope: Value) -> bool {
        let route = {
            let g = self.inner.lock().expect("embed host inner poisoned");
            route_ui_envelope(&g, envelope)
        };
        match route {
            UiRoute::Primary(payload) => {
                self.primary
                    .dispatch_action(hypen_engine::action_routing::UI_ACTION, Some(payload));
            }
            UiRoute::Remote(remote, payload) => {
                remote.dispatch_action(hypen_engine::action_routing::UI_ACTION, Some(payload));
            }
            UiRoute::Drop(reason) => {
                log::debug!("desktop embed: UI envelope dropped - {reason}");
            }
        }
        true
    }
}

impl HypenModule for HypenAppHost {
    fn on_patches(&self, cb: PatchCallback) {
        let pending = {
            let mut g = self.inner.lock().expect("embed host inner poisoned");
            g.callback = Some(Arc::clone(&cb));
            std::mem::take(&mut g.pending)
        };
        if !pending.is_empty() {
            cb(&pending);
        }
    }

    fn mount(&self) {
        self.primary.mount();
    }

    fn dispatch_action(&self, name: &str, payload: Option<Value>) {
        if name == hypen_engine::action_routing::UI_ACTION {
            self.try_dispatch_embed_ui(payload.unwrap_or(Value::Null));
            return;
        }
        if self.try_dispatch_embed(name, &payload) {
            return;
        }
        self.primary.dispatch_action(name, payload);
    }
}

pub fn is_hypenapp(element_type: &str) -> bool {
    element_type.eq_ignore_ascii_case("hypenapp")
}

pub fn embed_url(props: &IndexMap<String, Value>) -> Option<String> {
    for key in ["0", "0.0", "url", "url.0"] {
        if let Some(v) = props.get(key).and_then(Value::as_str) {
            if !v.trim().is_empty() {
                return Some(v.trim().to_string());
            }
        }
    }
    None
}

pub fn slot_of(props: &IndexMap<String, Value>) -> Option<&str> {
    props
        .get("slot.0")
        .or_else(|| props.get("slot"))
        .and_then(Value::as_str)
}

pub fn is_event_key(key: &str) -> bool {
    if key == "action" || key == "action.0" {
        return true;
    }
    let base = key.strip_suffix(".0").unwrap_or(key);
    base.len() > 2
        && base.starts_with("on")
        && base.as_bytes()[2].is_ascii_uppercase()
        && !base.contains('.')
}

pub fn rewrite_action_ref(raw: &str, marker: &str) -> Option<String> {
    if let Some(rest) = raw.strip_prefix("@actions.") {
        return Some(format!("@actions.{marker}{rest}"));
    }
    let rest = raw.strip_prefix('@')?;
    if rest.starts_with('{') || rest.starts_with("resources.") || rest.is_empty() {
        return None;
    }
    Some(format!("@{marker}{rest}"))
}

pub fn rewrite_embed_patch_actions(patch: Patch, marker: &str) -> Patch {
    fn rewrite_value(key: &str, value: &Value, marker: &str) -> Option<Value> {
        let s = value.as_str()?;
        if key == "bind" || key == "bind.0" {
            return Some(Value::String(format!("{marker}{s}")));
        }
        if !is_event_key(key) {
            return None;
        }
        rewrite_action_ref(s, marker).map(Value::String)
    }

    match patch {
        Patch::Create {
            id,
            element_type,
            props,
            semantics,
        } => {
            let needs_rewrite = props
                .iter()
                .any(|(k, v)| rewrite_value(k, v, marker).is_some());
            let props = if needs_rewrite {
                let mut rebuilt = IndexMap::with_capacity(props.len());
                for (k, v) in props.iter() {
                    rebuilt.insert(
                        k.clone(),
                        rewrite_value(k, v, marker).unwrap_or_else(|| v.clone()),
                    );
                }
                Arc::new(rebuilt)
            } else {
                props
            };
            Patch::Create {
                id,
                element_type,
                props,
                semantics,
            }
        }
        Patch::SetProp { id, name, value } => Patch::SetProp {
            value: rewrite_value(&name, &value, marker).unwrap_or(value),
            id,
            name,
        },
        p => p,
    }
}

pub fn split_embed_marker(
    name: &str,
    is_live_marker: impl Fn(&str) -> bool,
) -> Option<(String, &str)> {
    let (head, rest) = name.split_once(':')?;
    if rest.is_empty() {
        return None;
    }
    let marker = format!("{head}:");
    if is_live_marker(&marker) {
        Some((marker, rest))
    } else {
        None
    }
}

pub fn stream_prefix_of(id: &str) -> Option<String> {
    let (head, _) = id.split_once(':')?;
    Some(format!("{head}:"))
}

pub fn prefix_id(prefix: &str, id: &str) -> Arc<str> {
    let mut s = String::with_capacity(prefix.len() + id.len());
    s.push_str(prefix);
    s.push_str(id);
    s.into()
}

pub fn rewrite_embed_batch(
    patches: Vec<Patch>,
    prefix: &str,
    host: &str,
    new_roots: &mut Vec<Arc<str>>,
) -> Vec<Patch> {
    patches
        .into_iter()
        .map(|patch| rewrite_patch(patch, prefix, host, new_roots))
        .collect()
}

fn rewrite_patch(
    patch: Patch,
    prefix: &str,
    host: &str,
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
            let (parent_id, is_root_insert) = rewrite_parent(&parent_id, prefix, host);
            let id = prefix_id(prefix, &id);
            if is_root_insert && !new_roots.contains(&id) {
                new_roots.push(Arc::clone(&id));
            }
            Patch::Insert {
                parent_id,
                id,
                before_id: before_id.map(|b| prefix_id(prefix, &b)),
            }
        }
        Patch::Move {
            parent_id,
            id,
            before_id,
        } => {
            let (parent_id, _) = rewrite_parent(&parent_id, prefix, host);
            Patch::Move {
                parent_id,
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
            let (parent_id, is_root_attach) = rewrite_parent(&parent_id, prefix, host);
            let id = prefix_id(prefix, &id);
            if is_root_attach && !new_roots.contains(&id) {
                new_roots.push(Arc::clone(&id));
            }
            Patch::Attach {
                parent_id,
                id,
                before_id: before_id.map(|b| prefix_id(prefix, &b)),
            }
        }
        p @ Patch::BatchAnimation { .. } | p @ Patch::RegisterTemplate { .. } => p,
        Patch::Instantiate {
            template_id,
            parent_id,
            before_id,
            nodes,
            subs,
            semantics,
        } => {
            let (parent_id, is_root_insert) = rewrite_parent(&parent_id, prefix, host);
            let nodes: Vec<Arc<str>> = nodes.iter().map(|n| prefix_id(prefix, n)).collect();
            if is_root_insert {
                if let Some(root) = nodes.first() {
                    if !new_roots.contains(root) {
                        new_roots.push(Arc::clone(root));
                    }
                }
            }
            Patch::Instantiate {
                template_id,
                parent_id,
                before_id: before_id.map(|b| prefix_id(prefix, &b)),
                nodes,
                subs,
                semantics,
            }
        }
    }
}

fn rewrite_parent(parent_id: &str, prefix: &str, host: &str) -> (Arc<str>, bool) {
    if parent_id == ROOT_ID {
        (host.into(), true)
    } else {
        (prefix_id(prefix, parent_id), false)
    }
}

fn embed_depth(embeds: &IndexMap<String, Embed>, owner_prefix: &str) -> usize {
    let mut depth = 0;
    let mut current = owner_prefix.to_string();
    while let Some(e) = embeds.get(&current) {
        depth += 1;
        current = e.owner_prefix.clone();
    }
    depth
}

fn track_reconcile(detached_parents: &mut HashMap<String, String>, host: &str, patches: &[Patch]) {
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

fn handle_embed_lifecycle(inner: &Arc<Mutex<HostInner>>, batch: &[Patch]) -> EmbedLifecycle {
    let mut extra = Vec::new();
    let mut to_connect = Vec::new();
    let mut torn_down = Vec::new();
    {
        let mut g = inner.lock().expect("embed host inner poisoned");
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
                    let owner_prefix = stream_prefix_of(id).unwrap_or_default();
                    let stale = g
                        .embeds
                        .iter()
                        .find(|(_, e)| e.host_id.as_str() == id.as_ref())
                        .map(|(m, _)| m.clone());
                    if let Some(old_marker) = stale {
                        if let Some(old) = g.embeds.shift_remove(&old_marker) {
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
                        log::warn!("desktop embed: {id} exceeds max depth {MAX_EMBED_DEPTH}");
                        continue;
                    }
                    let Some(url) = embed_url(props) else {
                        log::warn!("desktop embed: HypenApp at {id} has no url prop");
                        continue;
                    };
                    let marker = format!("e{}:", g.next_embed_id);
                    g.next_embed_id += 1;
                    g.embeds.insert(
                        marker.clone(),
                        Embed::new(marker.clone(), id.to_string(), owner_prefix, url),
                    );
                    to_connect.push(marker);
                }
                Patch::Detach { id } => {
                    if let Some(parent) = g.tree.parent_of(id).map(str::to_string) {
                        g.detached_parents.insert(id.to_string(), parent);
                    }
                }
                Patch::Insert { parent_id, id, .. } | Patch::Attach { parent_id, id, .. } => {
                    g.detached_parents.remove(id.as_ref());
                    let Some((marker, embed_prefix)) = g
                        .embeds
                        .iter()
                        .find(|(_, e)| e.host_id.as_str() == parent_id.as_ref())
                        .map(|(m, e)| (m.clone(), e.id_prefix.clone()))
                    else {
                        continue;
                    };
                    if id.as_ref().starts_with(embed_prefix.as_str()) {
                        continue;
                    }
                    let slot = created
                        .get(id.as_ref())
                        .and_then(|p| slot_of(p))
                        .map(str::to_string)
                        .or_else(|| {
                            g.tree
                                .get(id)
                                .and_then(|n| {
                                    n.props
                                        .get("slot.0")
                                        .or_else(|| n.props.get("slot"))
                                        .and_then(Value::as_str)
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
    drop(torn_down);
    EmbedLifecycle { extra, to_connect }
}

fn connect_embed(inner: &Arc<Mutex<HostInner>>, marker: String) {
    let url = {
        let g = inner.lock().expect("embed host inner poisoned");
        match g.embeds.get(&marker) {
            Some(e) => e.url.clone(),
            None => return,
        }
    };
    let remote = Arc::new(RemoteModule::connect(url, "App"));

    let inner_for_patches = Arc::clone(inner);
    let marker_for_patches = marker.clone();
    remote.on_patches(Arc::new(move |patches: &[Patch]| {
        let mut rewritten = process_embed_patches(&inner_for_patches, &marker_for_patches, patches);
        let lifecycle = handle_embed_lifecycle(&inner_for_patches, &rewritten);
        rewritten.extend(lifecycle.extra);
        forward(&inner_for_patches, &rewritten);
        for marker in lifecycle.to_connect {
            connect_embed(&inner_for_patches, marker);
        }
    }));

    let inner_for_status = Arc::clone(inner);
    let marker_for_status = marker.clone();
    remote.on_status(move |status| {
        if !matches!(status, ConnectionStatus::Failed { .. }) {
            return;
        }
        let patches = {
            let mut g = inner_for_status
                .lock()
                .expect("embed host inner poisoned");
            let Some(embed) = g.embeds.get_mut(&marker_for_status) else {
                return;
            };
            embed.status = EmbedStatus::Error;
            let host = embed.host_id.clone();
            let patches = embed.reconcile_visibility();
            track_reconcile(&mut g.detached_parents, &host, &patches);
            patches
        };
        forward(&inner_for_status, &patches);
    });

    remote.mount();

    let stale = {
        let mut g = inner.lock().expect("embed host inner poisoned");
        match g.embeds.get_mut(&marker) {
            Some(e) => {
                e.remote = Some(remote);
                None
            }
            None => Some(remote),
        }
    };
    drop(stale);
}

fn process_embed_patches(
    inner: &Arc<Mutex<HostInner>>,
    marker: &str,
    patches: &[Patch],
) -> Vec<Patch> {
    let mut g = inner.lock().expect("embed host inner poisoned");
    let Some(embed) = g.embeds.get_mut(marker) else {
        return Vec::new();
    };
    let patches = embed.expander.expand(patches.to_vec());
    let prefix = embed.id_prefix.clone();
    let host = embed.host_id.clone();
    let mut new_roots = Vec::new();
    let rewritten: Vec<Patch> = rewrite_embed_batch(patches, &prefix, &host, &mut new_roots)
        .into_iter()
        .map(|p| rewrite_embed_patch_actions(p, &prefix))
        .collect();

    let embed = g.embeds.get_mut(marker).expect("embed still present");
    let created: HashSet<&str> = rewritten
        .iter()
        .filter_map(|p| match p {
            Patch::Create { id, .. } => Some(id.as_ref()),
            _ => None,
        })
        .collect();
    let has_route_cache_detach = rewritten.iter().any(|p| matches!(p, Patch::Detach { .. }));
    let has_replacement_root =
        !has_route_cache_detach && new_roots.iter().any(|r| created.contains(r.as_ref()));
    let mut out = Vec::new();
    if has_replacement_root && !embed.app_root_ids.is_empty() {
        for old in embed.app_root_ids.drain(..) {
            embed.detached.remove(&old);
            out.push(Patch::Remove {
                id: old.into(),
                transition: false,
            });
        }
        embed.active_root_ids.clear();
    }

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
                embed.active_root_ids.retain(|root| root.as_str() != id.as_ref());
                embed.detached.insert(id.to_string());
            }
            Patch::Remove { id, .. } => {
                embed.app_root_ids.retain(|r| r.as_str() != id.as_ref());
                embed.active_root_ids.retain(|r| r.as_str() != id.as_ref());
                embed.detached.remove(id.as_ref());
            }
            _ => {}
        }
    }

    out.extend(rewritten);
    if embed.status != EmbedStatus::Connected {
        embed.status = EmbedStatus::Connected;
        let host = embed.host_id.clone();
        let patches = embed.reconcile_visibility();
        track_reconcile(&mut g.detached_parents, &host, &patches);
        out.extend(patches);
    }
    out
}

fn forward(inner: &Arc<Mutex<HostInner>>, patches: &[Patch]) {
    if patches.is_empty() {
        return;
    }
    let cb = {
        let mut g = inner.lock().expect("embed host inner poisoned");
        g.tree.apply_batch(patches);
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

enum UiRoute {
    Primary(Value),
    Remote(Arc<RemoteModule>, Value),
    Drop(&'static str),
}

fn route_ui_envelope(g: &HostInner, envelope: Value) -> UiRoute {
    let Some(node) = envelope.get("node").and_then(Value::as_str) else {
        return UiRoute::Drop("envelope without a node");
    };
    let Some(prefix) = stream_prefix_of(node) else {
        return UiRoute::Primary(envelope);
    };
    let Some(embed) = g.embeds.get(&prefix) else {
        return UiRoute::Drop("node from a closed embed");
    };
    let Some(remote) = embed.remote.as_ref() else {
        return UiRoute::Drop("embed has no live connection");
    };
    match localize_ui_envelope(&envelope, &prefix, &embed.id_prefix) {
        Some(payload) => UiRoute::Remote(Arc::clone(remote), payload),
        None => UiRoute::Drop("malformed envelope"),
    }
}

fn localize_ui_envelope(envelope: &Value, prefix: &str, marker: &str) -> Option<Value> {
    let mut out = envelope.as_object()?.clone();
    let node = out.get("node")?.as_str()?.strip_prefix(prefix)?.to_string();
    out.insert("node".into(), Value::String(node));
    if let Some(from) = out.get("fromNode").and_then(Value::as_str) {
        let local = from
            .strip_prefix(prefix)
            .map(|s| Value::String(s.to_string()))
            .unwrap_or(Value::Null);
        out.insert("fromNode".into(), local);
    }
    let strip = |v: &mut Value| {
        if let Some(rest) = v.as_str().and_then(|s| s.strip_prefix(marker)) {
            *v = Value::String(rest.to_string());
        }
    };
    if let Some(action) = out.get_mut("action") {
        strip(action);
    }
    if let Some(payload) = out.get_mut("payload").and_then(Value::as_object_mut) {
        for key in ["path", "fromPath", "toPath"] {
            if let Some(v) = payload.get_mut(key) {
                strip(v);
            }
        }
    }
    Some(Value::Object(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn props(entries: &[(&str, Value)]) -> Arc<IndexMap<String, Value>> {
        let mut m = IndexMap::new();
        for (k, v) in entries {
            m.insert((*k).to_string(), v.clone());
        }
        Arc::new(m)
    }

    #[test]
    fn embed_url_reads_positional_and_named() {
        assert_eq!(
            embed_url(&props(&[("0", json!("wss://a.example/ws"))])).as_deref(),
            Some("wss://a.example/ws")
        );
        assert_eq!(
            embed_url(&props(&[("url", json!("ws://b"))])).as_deref(),
            Some("ws://b")
        );
        assert_eq!(embed_url(&props(&[("flex.0", json!("1"))])), None);
    }

    #[test]
    fn rewrite_action_ref_marks_actions_router_and_bare_refs() {
        assert_eq!(
            rewrite_action_ref("@actions.playFeatured", "e3:").as_deref(),
            Some("@actions.e3:playFeatured")
        );
        assert_eq!(
            rewrite_action_ref("@router.push", "e3:").as_deref(),
            Some("@e3:router.push")
        );
        assert_eq!(
            rewrite_action_ref("@increment", "e3:").as_deref(),
            Some("@e3:increment")
        );
        assert_eq!(rewrite_action_ref("@resources.play", "e3:"), None);
        assert_eq!(rewrite_action_ref("@{state.label}", "e3:"), None);
    }

    #[test]
    fn rewrite_embed_patch_actions_rewrites_create_props_and_bind() {
        let p = Patch::Create {
            id: "1".into(),
            element_type: "Button".into(),
            props: props(&[
                ("onClick.0", json!("@actions.play")),
                ("onClick.id", json!("42")),
                ("bind", json!("query")),
                ("0", json!("@somebody")),
            ]),
            semantics: None,
        };
        let Patch::Create { props: out, .. } = rewrite_embed_patch_actions(p, "e7:") else {
            panic!("expected Create");
        };
        assert_eq!(out.get("onClick.0"), Some(&json!("@actions.e7:play")));
        assert_eq!(out.get("onClick.id"), Some(&json!("42")));
        assert_eq!(out.get("bind"), Some(&json!("e7:query")));
        assert_eq!(out.get("0"), Some(&json!("@somebody")));
    }

    #[test]
    fn split_embed_marker_only_matches_live_markers() {
        let live = |m: &str| m == "e3:";
        assert_eq!(
            split_embed_marker("e3:playFeatured", live),
            Some(("e3:".into(), "playFeatured"))
        );
        assert_eq!(split_embed_marker("e9:foo", live), None);
        assert_eq!(split_embed_marker("plain", live), None);
    }

    #[test]
    fn reconcile_visibility_walks_the_status_machine() {
        let mut e = Embed::new("e1:".into(), "host".into(), "".into(), "ws://x".into());
        e.loading_slot_ids.push("loading".into());
        e.error_slot_ids.push("error".into());

        let out = e.reconcile_visibility();
        assert_eq!(out.len(), 1);
        assert!(matches!(&out[0], Patch::Detach { id } if id.as_ref() == "error"));
        assert!(e.reconcile_visibility().is_empty());

        e.status = EmbedStatus::Connected;
        let out = e.reconcile_visibility();
        assert_eq!(out.len(), 1);
        assert!(matches!(&out[0], Patch::Detach { id } if id.as_ref() == "loading"));

        e.app_root_ids.push("e1:1".into());
        e.active_root_ids.push("e1:1".into());
        e.status = EmbedStatus::Error;
        let out = e.reconcile_visibility();
        assert!(out.iter().any(|p| matches!(p, Patch::Attach { parent_id, id, .. }
            if parent_id.as_ref() == "host" && id.as_ref() == "error")));
        assert!(out.iter().any(|p| matches!(p, Patch::Detach { id } if id.as_ref() == "e1:1")));
    }

    #[test]
    fn rewrite_embed_batch_prefixes_ids_and_reroots_root_inserts() {
        let raw = vec![
            Patch::Create {
                id: "1".into(),
                element_type: "Column".into(),
                props: props(&[]),
                semantics: None,
            },
            Patch::Insert {
                parent_id: ROOT_ID.into(),
                id: "1".into(),
                before_id: None,
            },
        ];
        let mut roots = Vec::new();
        let out = rewrite_embed_batch(raw, "e1:", "host", &mut roots);
        assert!(matches!(&out[0], Patch::Create { id, .. } if id.as_ref() == "e1:1"));
        assert!(matches!(&out[1], Patch::Insert { parent_id, id, .. }
            if parent_id.as_ref() == "host" && id.as_ref() == "e1:1"));
        assert_eq!(roots, vec![Arc::<str>::from("e1:1")]);
    }
}
