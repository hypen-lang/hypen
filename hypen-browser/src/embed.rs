//! `HypenApp` embeds — the desktop counterpart of the DOM renderer's
//! `hypenapp.ts` component (and the mobile renderers' `HypenAppComponent`).
//!
//! A `HypenApp("wss://…")` element in any streamed tree (a tab's, or a
//! parent embed's) grafts a nested remote app under itself:
//!
//! * the embed gets its own `RemoteModule` and an `e<n>:` id prefix so
//!   its NodeIds can't collide with the host's or any sibling embed's;
//! * its `Insert { parent_id: "root" }` is re-rooted onto the HypenApp
//!   host node — the same rewrite tabs use, with the host in place of
//!   the shell viewport;
//! * action references inside the embedded tree are re-written to carry
//!   the embed's marker (`@actions.x` → `@actions.e3:x`), so when the
//!   renderer dispatches the resolved name the browser can route it to
//!   the embed's remote rather than the active tab's — the desktop
//!   dispatch path carries no node identity, so the marker rides in the
//!   action name itself;
//! * the host's `.slot("loading")` / `.slot("error")` children are
//!   toggled via the same `Detach` / `Attach` patches the Router cache
//!   uses: loading shows until the first patch batch arrives, the error
//!   slot shows when the connection fails, and neither shows while the
//!   embedded tree is live. Children without a recognized slot render
//!   unconditionally, mirroring the web semantics.
//!
//! Lifecycle mirrors the web component too: a Router `Detach` of the
//! host subtree keeps the connection warm (cached routes re-attach
//! without a spinner), while a real `Remove` — or closing the owning
//! tab — tears the embed down.

use hypen_engine::Patch;
use indexmap::IndexMap;
use serde_json::Value;
use std::collections::HashSet;
use std::sync::Arc;

use hypen_renderer_desktop::RemoteModule;

/// Embeds nested deeper than this are refused (with a log line) — a
/// guard against an app that embeds itself recursively.
pub const MAX_EMBED_DEPTH: usize = 4;

/// Where the embed's connection currently stands, as far as slot
/// visibility is concerned. `Loading` until the first patch batch
/// lands (a socket that's "connected" but hasn't sent a tree yet still
/// shows the splash), `Error` on a terminal connection failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmbedStatus {
    Loading,
    Connected,
    Error,
}

/// One live `HypenApp` embed.
pub struct Embed {
    /// `e1:`, `e2:`, … — both the NodeId prefix for the embedded tree
    /// and the action-name marker dispatch routing strips.
    pub id_prefix: String,
    /// Renderer-side id of the HypenApp host node (already carrying its
    /// own stream's prefix).
    pub host_id: String,
    /// The id prefix of the stream that created the host node (`a1:`
    /// for a tab, `e2:` for a parent embed). Drives transitive teardown
    /// when a tab closes.
    pub owner_prefix: String,
    pub url: String,
    /// The embed's WebSocket worker. `None` between registration and
    /// the (lock-free) connect step, and after teardown.
    pub remote: Option<Arc<RemoteModule>>,
    /// Rewritten root ids the embed inserted under the host node.
    pub app_root_ids: Vec<String>,
    /// Host-owned slot children, by kind, in insertion order.
    pub loading_slot_ids: Vec<String>,
    pub error_slot_ids: Vec<String>,
    /// Ids (slot children or embed roots) we've detached and not yet
    /// re-attached — reconciliation bookkeeping so we never emit a
    /// redundant Detach/Attach.
    pub detached: HashSet<String>,
    pub status: EmbedStatus,
    /// Lowers `RegisterTemplate`/`Instantiate` from the embed's server,
    /// exactly as each tab does for its own stream.
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
            loading_slot_ids: Vec::new(),
            error_slot_ids: Vec::new(),
            detached: HashSet::new(),
            status: EmbedStatus::Loading,
            expander: hypen_engine::TemplateExpander::new(),
        }
    }

    /// Emit the Detach / Attach patches that bring slot children and
    /// embed roots in line with the current status. Attach targets the
    /// host node; ordering within the returned batch doesn't matter
    /// (each patch touches a distinct id).
    pub fn reconcile_visibility(&mut self) -> Vec<Patch> {
        let mut out = Vec::new();
        let show_loading = self.status == EmbedStatus::Loading;
        let show_error = self.status == EmbedStatus::Error;
        let show_content = self.status == EmbedStatus::Connected;

        // Borrow-friendly local: apply the visibility rule for one id.
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
            set_visible(
                &mut out,
                &mut self.detached,
                &self.host_id,
                id,
                show_loading,
            );
        }
        for id in &self.error_slot_ids {
            set_visible(&mut out, &mut self.detached, &self.host_id, id, show_error);
        }
        for id in &self.app_root_ids {
            set_visible(
                &mut out,
                &mut self.detached,
                &self.host_id,
                id,
                show_content,
            );
        }
        out
    }
}

/// `true` when a Create's element type is the HypenApp embed component.
pub fn is_hypenapp(element_type: &str) -> bool {
    element_type.eq_ignore_ascii_case("hypenapp")
}

/// Pull the WebSocket URL off a HypenApp node's props: positional
/// (`"0"` — what the engine emits for `HypenApp("wss://…")`) or named
/// (`url`), with the flattened `.0` spellings accepted for safety.
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

/// `true` for prop keys whose VALUE is an action reference: the bare
/// `action` (Button positional syntax) and the event applicators'
/// value slot (`onClick` / `onClick.0`, `onPlay`, `onHover.0`, …).
/// Named payload arguments (`onClick.to`, `onClick.id`) are data, not
/// references, and stay untouched.
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

/// Rewrite one action-reference string to carry the embed marker, or
/// `None` when the value isn't an action reference:
///
/// * `@actions.foo` → `@actions.<marker>foo`  (dispatches `<marker>foo`)
/// * `@router.push` → `@<marker>router.push`  (dispatches `<marker>router.push`)
/// * `@foo`         → `@<marker>foo`          — the engine lowers
///   `@actions.foo` to the bare form on the wire, so this is the
///   common case (dispatches `<marker>foo`)
///
/// The desktop renderer strips `@` / `@actions.` and treats the rest
/// as an opaque name, so the marker survives to `dispatch_action`
/// where the browser strips it and routes to the embed's remote.
/// `@{…}` interpolations and `@resources.` references pass through.
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

/// Rewrite a patch from an embed's stream so its interactive props
/// carry the embed marker:
///
/// * any string prop value that is an `@actions.` / `@router.`
///   reference (onClick, action, onSubmit, hover actions, media
///   actions, …) gets the marker spliced in via [`rewrite_action_ref`];
/// * `bind` paths (two-way `.bind(@state.x)`) get the marker prefixed,
///   so the `__hypen_bind` dispatch routes home too.
///
/// Non-string values and unrelated props pass through untouched; the
/// props map is only rebuilt when something actually changed.
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
                    let v = rewrite_value(k, v, marker).unwrap_or_else(|| v.clone());
                    rebuilt.insert(k.clone(), v);
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
        Patch::SetProp { id, name, value } => {
            let value = rewrite_value(&name, &value, marker).unwrap_or(value);
            Patch::SetProp { id, name, value }
        }
        p => p,
    }
}

/// Route table entry: given a dispatched action name, find the embed
/// marker it carries. Returns `(marker, remainder)` when `name` starts
/// with a *registered* marker — the caller supplies the membership
/// test so unrelated names containing `:` (or a stale marker) fall
/// through to the normal tab routing.
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
        let p = props(&[("0", json!("wss://a.example/ws"))]);
        assert_eq!(embed_url(&p).as_deref(), Some("wss://a.example/ws"));
        let p = props(&[("url", json!("ws://b"))]);
        assert_eq!(embed_url(&p).as_deref(), Some("ws://b"));
        let p = props(&[("flex.0", json!("1"))]);
        assert_eq!(embed_url(&p), None);
        let p = props(&[("0", json!("   "))]);
        assert_eq!(embed_url(&p), None);
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
        // The engine lowers `@actions.foo` to the bare `@foo` on the wire.
        assert_eq!(
            rewrite_action_ref("@increment", "e3:").as_deref(),
            Some("@e3:increment")
        );
        assert_eq!(rewrite_action_ref("plain text", "e3:"), None);
        assert_eq!(rewrite_action_ref("@resources.play", "e3:"), None);
        assert_eq!(rewrite_action_ref("@{state.label}", "e3:"), None);
    }

    #[test]
    fn is_event_key_matches_value_slots_only() {
        assert!(is_event_key("onClick"));
        assert!(is_event_key("onClick.0"));
        assert!(is_event_key("onPlay"));
        assert!(is_event_key("action"));
        assert!(is_event_key("action.0"));
        assert!(!is_event_key("onClick.to"));
        assert!(!is_event_key("onClick.id"));
        assert!(!is_event_key("0"));
        assert!(!is_event_key("once.0"));
        assert!(!is_event_key("color.0"));
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
                ("color.0", json!("#fff")),
                // Positional TEXT content that happens to start with @
                // must never be treated as an action reference.
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
        assert_eq!(out.get("color.0"), Some(&json!("#fff")));
        assert_eq!(out.get("0"), Some(&json!("@somebody")));
    }

    #[test]
    fn rewrite_embed_patch_actions_leaves_untouched_creates_shared() {
        // No action-ish props — the Arc must be reused, not deep-cloned.
        let shared = props(&[("color.0", json!("#fff"))]);
        let p = Patch::Create {
            id: "1".into(),
            element_type: "Text".into(),
            props: Arc::clone(&shared),
            semantics: None,
        };
        let Patch::Create { props: out, .. } = rewrite_embed_patch_actions(p, "e7:") else {
            panic!("expected Create");
        };
        assert!(Arc::ptr_eq(&out, &shared));
    }

    #[test]
    fn rewrite_embed_patch_actions_rewrites_setprop() {
        let p = Patch::SetProp {
            id: "1".into(),
            name: "onClick.0".into(),
            value: json!("@router.back"),
        };
        let Patch::SetProp { value, .. } = rewrite_embed_patch_actions(p, "e2:") else {
            panic!("expected SetProp");
        };
        assert_eq!(value, json!("@e2:router.back"));
    }

    #[test]
    fn split_embed_marker_only_matches_live_markers() {
        let live = |m: &str| m == "e3:";
        assert_eq!(
            split_embed_marker("e3:playFeatured", live),
            Some(("e3:".into(), "playFeatured"))
        );
        assert_eq!(
            split_embed_marker("e3:router.push", live),
            Some(("e3:".into(), "router.push"))
        );
        assert_eq!(split_embed_marker("e9:foo", live), None);
        assert_eq!(split_embed_marker("plain", live), None);
        assert_eq!(split_embed_marker("weird:", live), None);
    }

    #[test]
    fn reconcile_visibility_walks_the_status_machine() {
        let mut e = Embed::new("e1:".into(), "a1:9".into(), "a1:".into(), "ws://x".into());
        e.loading_slot_ids.push("a1:10".into());
        e.error_slot_ids.push("a1:11".into());

        // Loading: error slot detaches, loading stays.
        let out = e.reconcile_visibility();
        assert_eq!(out.len(), 1);
        assert!(matches!(&out[0], Patch::Detach { id } if id.as_ref() == "a1:11"));

        // Reconcile again: nothing new to do.
        assert!(e.reconcile_visibility().is_empty());

        // First patches arrived: loading detaches, roots (none yet) stay.
        e.status = EmbedStatus::Connected;
        let out = e.reconcile_visibility();
        assert_eq!(out.len(), 1);
        assert!(matches!(&out[0], Patch::Detach { id } if id.as_ref() == "a1:10"));

        // Connection failed: error re-attaches under the host, roots detach.
        e.app_root_ids.push("e1:1".into());
        e.status = EmbedStatus::Error;
        let out = e.reconcile_visibility();
        assert!(out
            .iter()
            .any(|p| matches!(p, Patch::Attach { parent_id, id, .. }
                if parent_id.as_ref() == "a1:9" && id.as_ref() == "a1:11")));
        assert!(out
            .iter()
            .any(|p| matches!(p, Patch::Detach { id } if id.as_ref() == "e1:1")));

        // Recovered: roots re-attach, error hides again.
        e.status = EmbedStatus::Connected;
        let out = e.reconcile_visibility();
        assert!(out
            .iter()
            .any(|p| matches!(p, Patch::Attach { parent_id, id, .. }
                if parent_id.as_ref() == "a1:9" && id.as_ref() == "e1:1")));
        assert!(out
            .iter()
            .any(|p| matches!(p, Patch::Detach { id } if id.as_ref() == "a1:11")));
    }
}
