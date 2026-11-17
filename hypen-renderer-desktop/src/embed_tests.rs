//! Tests for `crate::embed` — the HypenApp grafting layer, driven with
//! in-process fake connections.

use super::*;
use crate::tree::Tree;
use serde_json::json;
use std::sync::Mutex;

type Dispatch = (String, String, Option<Value>);

#[derive(Default)]
struct Fake {
    cb: Mutex<Option<OwnedPatchCallback>>,
    ui: Mutex<Vec<Dispatch>>,
    actions: Mutex<Vec<(String, Option<Value>)>>,
    viewports: Mutex<Vec<(String, usize, usize)>>,
    mounted: Mutex<bool>,
    /// `HypenModule::asset_origin` (`None`: an in-process module).
    origin: Option<Arc<str>>,
    /// Every `set_color_scheme` call, in order.
    schemes: Mutex<Vec<bool>>,
}

impl Fake {
    fn push(&self, patches: Vec<Patch>) {
        let cb = self.cb.lock().unwrap().clone().expect("callback wired");
        cb(patches);
    }
}

impl HypenModule for Fake {
    fn on_patches(&self, cb: Arc<dyn Fn(&[Patch]) + Send + Sync>) {
        self.on_owned_patches(Arc::new(move |p: Vec<Patch>| cb(&p)));
    }
    fn on_owned_patches(&self, cb: OwnedPatchCallback) {
        *self.cb.lock().unwrap() = Some(cb);
    }
    fn mount(&self) {
        *self.mounted.lock().unwrap() = true;
    }
    fn dispatch_action(&self, name: &str, payload: Option<Value>) {
        self.actions.lock().unwrap().push((name.into(), payload));
    }
    fn dispatch_ui_action(&self, node: &str, action: &str, payload: Option<Value>) {
        self.ui
            .lock()
            .unwrap()
            .push((node.into(), action.into(), payload));
    }
    fn set_list_viewport(&self, list_id: &str, start: usize, end: usize) {
        self.viewports
            .lock()
            .unwrap()
            .push((list_id.into(), start, end));
    }
    fn asset_origin(&self) -> Option<Arc<str>> {
        self.origin.clone()
    }
    fn set_color_scheme(&self, dark: bool) {
        self.schemes.lock().unwrap().push(dark);
    }
}

/// One connection the fake connector opened.
struct Conn {
    url: String,
    rule: AddressRule,
    module: Arc<Fake>,
    signal: EmbedSignalSink,
}

struct Harness {
    root: Arc<Fake>,
    module: EmbeddingModule,
    conns: Arc<Mutex<Vec<Conn>>>,
    out: Arc<Mutex<Vec<Patch>>>,
    tree: Tree,
}

impl Harness {
    fn new() -> Self {
        Self::with_root(Fake::default())
    }

    fn with_root(root: Fake) -> Self {
        let root = Arc::new(root);
        let conns: Arc<Mutex<Vec<Conn>>> = Arc::default();
        let sink = Arc::clone(&conns);
        let connector: EmbedConnector = Arc::new(move |url: &str, rule, signal: EmbedSignalSink| {
            let module = Arc::new(Fake::default());
            sink.lock().unwrap().push(Conn {
                url: url.into(),
                rule,
                module: Arc::clone(&module),
                signal,
            });
            module as Arc<dyn HypenModule>
        });
        let module =
            EmbeddingModule::with_connector(Arc::clone(&root) as Arc<dyn HypenModule>, connector);
        let out: Arc<Mutex<Vec<Patch>>> = Arc::default();
        let o = Arc::clone(&out);
        module.on_owned_patches(Arc::new(move |p: Vec<Patch>| o.lock().unwrap().extend(p)));
        module.mount();
        Self {
            root,
            module,
            conns,
            out,
            tree: Tree::new(),
        }
    }

    /// Drain what reached the window and apply it to a real renderer tree.
    fn take(&mut self) -> Vec<Patch> {
        let out = std::mem::take(&mut *self.out.lock().unwrap());
        self.tree.apply_batch(&out);
        out
    }

    fn conn(&self, i: usize) -> Arc<Fake> {
        Arc::clone(&self.conns.lock().unwrap()[i].module)
    }

    fn signal(&self, i: usize, s: EmbedSignal) {
        let sig = Arc::clone(&self.conns.lock().unwrap()[i].signal);
        sig(s);
    }

    fn children(&self, id: &str) -> Vec<String> {
        self.tree.children_of(id).to_vec()
    }
}

fn create(id: &str, ty: &str, props: &[(&str, Value)]) -> Patch {
    let mut m = IndexMap::new();
    for (k, v) in props {
        m.insert((*k).to_string(), v.clone());
    }
    Patch::Create {
        id: id.into(),
        element_type: ty.into(),
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

/// The launcher's app frame: `frame > host(HypenApp) > {loading, error}`.
fn launcher_frame() -> Vec<Patch> {
    vec![
        create("frame", "Column", &[]),
        insert("root", "frame"),
        create("host", "HypenApp", &[("0", json!("ws://todo.test/ws"))]),
        insert("frame", "host"),
        create("loading", "Stack", &[("slot.0", json!("loading"))]),
        insert("host", "loading"),
        create("error", "Column", &[("slot.0", json!("error"))]),
        insert("host", "error"),
        create("note", "Text", &[("0", json!("always"))]),
        insert("host", "note"),
    ]
}

/// The embedded todo app's initial tree.
fn todo_tree() -> Vec<Patch> {
    vec![
        create("1", "Column", &[]),
        insert("root", "1"),
        create("2", "Button", &[("onClick", json!("@actions.add"))]),
        insert("1", "2"),
    ]
}

#[test]
fn helpers_read_url_and_slot_props() {
    let mut p = IndexMap::new();
    p.insert("0".to_string(), json!(" wss://a.example/ws "));
    p.insert("slot.0".to_string(), json!("loading"));
    assert_eq!(embed_url(&p).as_deref(), Some("wss://a.example/ws"));
    assert_eq!(slot_of(&p), Some("loading"));
    let mut named = IndexMap::new();
    named.insert("url".to_string(), json!("ws://b"));
    assert_eq!(embed_url(&named).as_deref(), Some("ws://b"));
    assert_eq!(embed_url(&IndexMap::new()), None);
    assert!(is_hypenapp("HypenApp") && is_hypenapp("hypenapp") && !is_hypenapp("App"));
}

#[test]
fn a_hypenapp_host_connects_and_shows_only_its_loading_slot() {
    let mut h = Harness::new();
    h.root.push(launcher_frame());
    h.take();
    assert_eq!(h.module.embed_count(), 1);
    let conns = h.conns.lock().unwrap();
    assert_eq!(conns.len(), 1);
    assert_eq!(conns[0].url, "ws://todo.test/ws");
    assert!(*conns[0].module.mounted.lock().unwrap());
    drop(conns);
    assert_eq!(
        h.children("host"),
        vec!["loading", "note"],
        "loading shows, the error slot is detached, unslotted children stay"
    );
}

#[test]
fn the_embedded_tree_is_namespaced_and_grafted_under_the_host() {
    let mut h = Harness::new();
    h.root.push(launcher_frame());
    h.take();
    h.conn(0).push(todo_tree());
    let out = h.take();
    assert!(out
        .iter()
        .any(|p| matches!(p, Patch::Create { id, .. } if id.as_ref() == "e1:1")));
    assert_eq!(
        h.children("host"),
        vec!["note", "e1:1"],
        "the first tree replaces the loading slot"
    );
    assert_eq!(h.children("e1:1"), vec!["e1:2"]);
    // Props (and so the embed's asset-origin stamp) pass through untouched.
    let node = h.tree.get("e1:2").expect("embedded button");
    assert_eq!(node.props.get("onClick"), Some(&json!("@actions.add")));
}

#[test]
fn ui_events_and_viewports_route_to_the_stream_that_owns_the_node() {
    let mut h = Harness::new();
    h.root.push(launcher_frame());
    h.take();
    h.conn(0).push(todo_tree());
    h.take();

    h.module
        .dispatch_ui_action("e1:2", "add", Some(json!({"fromNode": "e1:1", "x": 1})));
    h.module
        .dispatch_ui_action("frame", "goHome", Some(json!({"fromNode": "e1:1"})));
    h.module.set_list_viewport("e1:1", 3, 9);
    h.module.dispatch_action("router.replace", None);

    let embedded = h.conn(0);
    assert_eq!(
        *embedded.ui.lock().unwrap(),
        vec![(
            "2".to_string(),
            "add".to_string(),
            Some(json!({"fromNode": "1", "x": 1}))
        )]
    );
    assert_eq!(
        *embedded.viewports.lock().unwrap(),
        vec![("1".to_string(), 3, 9)]
    );
    assert_eq!(
        *h.root.ui.lock().unwrap(),
        vec![(
            "frame".to_string(),
            "goHome".to_string(),
            Some(json!({"fromNode": null}))
        )],
        "a foreign drag origin means nothing to the root engine"
    );
    assert_eq!(h.root.actions.lock().unwrap().len(), 1);
}

#[test]
fn a_failed_first_connect_shows_the_error_slot_and_a_later_tree_recovers() {
    let mut h = Harness::new();
    h.root.push(launcher_frame());
    h.take();
    h.signal(0, EmbedSignal::Retrying);
    h.take();
    assert_eq!(h.children("host"), vec!["note", "error"]);

    h.conn(0).push(todo_tree());
    h.take();
    assert_eq!(h.children("host"), vec!["note", "e1:1"]);

    // A retry with a live tree keeps the tree…
    h.signal(0, EmbedSignal::Retrying);
    h.take();
    assert_eq!(h.children("host"), vec!["note", "e1:1"]);
    // …giving up shows the error slot.
    h.signal(0, EmbedSignal::Failed);
    h.take();
    assert_eq!(h.children("host"), vec!["note", "error"]);
}

#[test]
fn a_router_detach_keeps_the_embed_alive_and_a_remove_closes_it() {
    let mut h = Harness::new();
    h.root.push(launcher_frame());
    h.take();
    h.conn(0).push(todo_tree());
    h.take();
    let weak = Arc::downgrade(&h.conn(0));

    // Navigating away caches the route: the connection stays up and the
    // embed keeps applying patches into the detached subtree.
    h.root.push(vec![Patch::Detach { id: "frame".into() }]);
    h.take();
    assert_eq!(h.module.embed_count(), 1);
    h.conn(0).push(vec![Patch::SetProp {
        id: "2".into(),
        name: "color".into(),
        value: json!("red"),
    }]);
    let out = h.take();
    assert!(matches!(&out[..], [Patch::SetProp { id, .. }] if id.as_ref() == "e1:2"));
    h.root.push(vec![Patch::Attach {
        parent_id: "root".into(),
        id: "frame".into(),
        before_id: None,
    }]);
    h.take();
    assert_eq!(h.children("host"), vec!["note", "e1:1"], "re-attaches warm");

    // A real Remove of an ancestor closes it and reclaims the slot
    // children this layer had detached.
    h.root.push(vec![Patch::Remove {
        id: "frame".into(),
        transition: false,
    }]);
    let out = h.take();
    assert_eq!(h.module.embed_count(), 0);
    for slot in ["loading", "error"] {
        assert!(
            out.iter()
                .any(|p| matches!(p, Patch::Remove { id, .. } if id.as_ref() == slot)),
            "detached slot `{slot}` must be removed with its host: {out:?}"
        );
    }
    drop(h.conns.lock().unwrap().drain(..));
    assert!(
        weak.upgrade().is_none(),
        "the embed's connection was dropped"
    );
    // In-flight batches from a closed embed are ignored.
    assert!(h.tree.get("e1:1").is_none());
}

#[test]
fn removing_a_cached_route_closes_its_embed_and_reclaims_cached_subtrees() {
    let mut h = Harness::new();
    h.root.push(launcher_frame());
    h.take();
    h.conn(0).push(todo_tree());
    h.take();
    // The embedded app's own Router caches a route subtree.
    h.conn(0).push(vec![
        Patch::Detach { id: "2".into() },
        create("3", "Text", &[]),
        insert("1", "3"),
    ]);
    h.take();
    h.root.push(vec![Patch::Detach { id: "frame".into() }]);
    h.take();
    h.root.push(vec![Patch::Remove {
        id: "frame".into(),
        transition: false,
    }]);
    let out = h.take();
    assert_eq!(h.module.embed_count(), 0);
    assert!(
        out.iter()
            .any(|p| matches!(p, Patch::Remove { id, .. } if id.as_ref() == "e1:2")),
        "the embed's Router-cached subtree is reclaimed: {out:?}"
    );
}

#[test]
fn clearing_a_host_removes_only_the_owners_children() {
    let mut h = Harness::new();
    h.root.push(launcher_frame());
    h.take();
    h.conn(0).push(todo_tree());
    h.take();
    h.root
        .push(vec![Patch::ClearChildren { id: "host".into() }]);
    let out = h.take();
    assert!(!out.iter().any(|p| matches!(p, Patch::ClearChildren { .. })));
    assert_eq!(h.children("host"), vec!["e1:1"], "the embedded tree stays");
    assert_eq!(h.module.embed_count(), 1);
    for gone in ["loading", "error", "note"] {
        assert!(h.tree.get(gone).is_none(), "{gone} removed");
    }
}

#[test]
fn a_resent_tree_after_reconnect_replaces_the_old_roots() {
    let mut h = Harness::new();
    h.root.push(launcher_frame());
    h.take();
    h.conn(0).push(todo_tree());
    h.take();
    // The connection announces the re-sent tree (`initialTree`).
    h.signal(0, EmbedSignal::InitialTree);
    h.conn(0).push(vec![
        create("1", "Column", &[("fresh", json!(true))]),
        insert("root", "1"),
    ]);
    h.take();
    assert_eq!(h.children("host"), vec!["note", "e1:1"]);
    assert_eq!(
        h.children("e1:1"),
        Vec::<String>::new(),
        "old children gone"
    );
    assert_eq!(
        h.tree.get("e1:1").unwrap().props.get("fresh"),
        Some(&json!(true))
    );
}

#[test]
fn embeds_nest_with_their_own_prefix_and_close_with_their_owner() {
    let mut h = Harness::new();
    h.root.push(launcher_frame());
    h.take();
    h.conn(0).push(vec![
        create("1", "Column", &[]),
        insert("root", "1"),
        create("9", "HypenApp", &[("url", json!("ws://inner.test/ws"))]),
        insert("1", "9"),
    ]);
    h.take();
    assert_eq!(h.module.embed_count(), 2);
    assert_eq!(h.conns.lock().unwrap()[1].url, "ws://inner.test/ws");
    h.conn(1)
        .push(vec![create("1", "Text", &[]), insert("root", "1")]);
    h.take();
    assert_eq!(h.children("e1:9"), vec!["e2:1"]);
    h.module.dispatch_ui_action("e2:1", "tap", None);
    assert_eq!(h.conn(1).ui.lock().unwrap()[0].0, "1");

    h.root.push(vec![Patch::Remove {
        id: "host".into(),
        transition: false,
    }]);
    h.take();
    assert_eq!(h.module.embed_count(), 0);
}

#[test]
fn a_recreated_host_replaces_its_embed() {
    let mut h = Harness::new();
    h.root.push(launcher_frame());
    h.take();
    h.conn(0).push(todo_tree());
    h.take();
    h.root.push(vec![create(
        "host",
        "HypenApp",
        &[("0", json!("ws://todo.test/ws"))],
    )]);
    h.take();
    assert_eq!(h.module.embed_count(), 1);
    assert_eq!(h.conns.lock().unwrap().len(), 2, "a fresh connection");
    assert!(h.tree.get("e1:1").is_none(), "the old embed's tree is gone");
    h.conn(1).push(todo_tree());
    let out = h.take();
    assert!(out
        .iter()
        .any(|p| matches!(p, Patch::Create { id, .. } if id.as_ref() == "e2:1")));
    assert_eq!(h.children("host"), vec!["note", "e2:1"]);
}

#[test]
fn a_host_without_a_url_or_too_deep_does_not_connect() {
    let mut h = Harness::new();
    h.root.push(vec![
        create("host", "HypenApp", &[]),
        insert("root", "host"),
    ]);
    h.take();
    assert_eq!(h.module.embed_count(), 0);

    // An app that embeds itself: each level hosts the next.
    let mut h = Harness::new();
    h.root.push(vec![
        create("h", "HypenApp", &[("0", json!("ws://self"))]),
        insert("root", "h"),
    ]);
    for level in 0..(MAX_EMBED_DEPTH + 2) {
        let conns = h.conns.lock().unwrap().len();
        if level >= conns {
            break;
        }
        h.conn(level).push(vec![
            create("h", "HypenApp", &[("0", json!("ws://self"))]),
            insert("root", "h"),
        ]);
    }
    assert_eq!(h.conns.lock().unwrap().len(), MAX_EMBED_DEPTH);
}

/// An embedded app with several roots whose top-level conditional swaps
/// one of them creates + inserts a root in an ordinary batch — that is NOT
/// a re-sent tree: the other root must survive (only `initialTree` resets).
#[test]
fn a_top_level_conditional_swap_in_a_multi_root_app_is_incremental() {
    let mut h = Harness::new();
    h.root.push(launcher_frame());
    h.take();
    h.conn(0).push(vec![
        create("1", "Column", &[]),
        insert("root", "1"),
        create("2", "Text", &[("0", json!("banner"))]),
        insert("root", "2"),
    ]);
    h.take();
    assert_eq!(h.children("host"), vec!["note", "e1:1", "e1:2"]);
    // `When` swaps the banner: remove 2, create + insert 3 under root.
    h.conn(0).push(vec![
        Patch::Remove {
            id: "2".into(),
            transition: false,
        },
        create("3", "Text", &[("0", json!("other banner"))]),
        insert("root", "3"),
    ]);
    h.take();
    assert_eq!(
        h.children("host"),
        vec!["note", "e1:1", "e1:3"],
        "the untouched root stays"
    );
    // A reconnect's initialTree, by contrast, replaces every old root.
    h.signal(0, EmbedSignal::InitialTree);
    h.conn(0)
        .push(vec![create("1", "Column", &[]), insert("root", "1")]);
    h.take();
    assert_eq!(h.children("host"), vec!["note", "e1:1"]);
}

/// Drag and drop inside an embed: the DnD runtime sends node-addressed
/// `__hypen_dispatch` envelopes through `dispatch_action`; they reach the
/// embed that owns the node, with its ids un-prefixed.
#[test]
fn node_addressed_ui_envelopes_route_to_the_owning_embed() {
    let mut h = Harness::new();
    h.root.push(launcher_frame());
    h.take();
    h.conn(0).push(todo_tree());
    h.take();
    let ui = hypen_engine::action_routing::UI_ACTION;
    h.module.dispatch_action(
        ui,
        Some(json!({
            "node": "e1:1",
            "fromNode": "e1:2",
            "action": "__hypen_reorder",
            "payload": {"path": "state.items", "from": 0, "to": 1}
        })),
    );
    // A host-zone drop of an embed row: the foreign origin means nothing
    // to the window's engine.
    h.module.dispatch_action(
        ui,
        Some(json!({"node": "frame", "fromNode": "e1:2", "action": "drop", "payload": {}})),
    );
    assert_eq!(
        *h.conn(0).actions.lock().unwrap(),
        vec![(
            ui.to_string(),
            Some(json!({
                "node": "1",
                "fromNode": "2",
                "action": "__hypen_reorder",
                "payload": {"path": "state.items", "from": 0, "to": 1}
            }))
        )]
    );
    assert_eq!(
        *h.root.actions.lock().unwrap(),
        vec![(
            ui.to_string(),
            Some(json!({"node": "frame", "fromNode": null, "action": "drop", "payload": {}}))
        )]
    );
}

#[test]
fn the_embed_policy_bounds_breadth_and_targets() {
    let mut h = Harness::new();
    // One stream creating many HypenApps: only `max_per_owner` connect.
    let mut batch = vec![create("col", "Column", &[]), insert("root", "col")];
    for i in 0..20 {
        let id = format!("h{i}");
        batch.push(create(
            &id,
            "HypenApp",
            &[("0", json!(format!("ws://app{i}.test/ws")))],
        ));
        batch.push(insert("col", &id));
    }
    h.root.push(batch);
    h.take();
    let policy = EmbedPolicy::default();
    assert_eq!(h.conns.lock().unwrap().len(), policy.max_per_owner);
    // Removing a live one frees its slot for the next host.
    h.root.push(vec![Patch::Remove {
        id: "h0".into(),
        transition: false,
    }]);
    h.root.push(vec![
        create("late", "HypenApp", &[("0", json!("ws://late.test/ws"))]),
        insert("col", "late"),
    ]);
    h.take();
    assert_eq!(h.conns.lock().unwrap().len(), policy.max_per_owner + 1);
    assert_eq!(
        h.conns.lock().unwrap().last().unwrap().url,
        "ws://late.test/ws"
    );
}

#[test]
fn embed_targets_follow_mixed_content_and_private_network_rules() {
    let p = EmbedPolicy::default();
    // Local content (in-process module / localhost dev server) may embed
    // local apps — the launcher.
    assert!(p.check_target(None, "ws://localhost:8789/ws").is_ok());
    assert!(p
        .check_target(Some("http://localhost:8787"), "ws://127.0.0.1:8789/ws")
        .is_ok());
    // Public content may not reach private / loopback targets…
    for private in [
        "ws://localhost:3000/ws",
        "ws://127.0.0.1/ws",
        "ws://[::1]:9000/ws",
        "ws://10.0.0.5/ws",
        "ws://192.168.1.2/ws",
        "ws://169.254.169.254/ws",
        "ws://printer.local/ws",
    ] {
        assert!(
            p.check_target(Some("http://apps.example.com"), private)
                .is_err(),
            "{private}"
        );
    }
    // …unless the host app allows it.
    assert!(p
        .clone()
        .allow_private_targets(true)
        .check_target(Some("http://apps.example.com"), "ws://127.0.0.1/ws")
        .is_ok());
    // Mixed content: secure content embeds only wss.
    assert!(p
        .check_target(
            Some("https://apps.example.com"),
            "ws://other.example.com/ws"
        )
        .is_err());
    assert!(p
        .check_target(
            Some("wss://apps.example.com/ws"),
            "wss://other.example.com/ws"
        )
        .is_ok());
    // Only WebSocket targets.
    assert!(p.check_target(None, "http://example.com/").is_err());
    assert!(p.check_target(None, "file:///etc/passwd").is_err());
    // An allowlist is exclusive.
    let listed = EmbedPolicy::default().allow_hosts(["apps.example.com", "localhost:8789"]);
    assert!(listed
        .check_target(Some("https://a.b"), "wss://apps.example.com/ws")
        .is_ok());
    assert!(listed.check_target(None, "ws://localhost:8789/ws").is_ok());
    assert!(listed.check_target(None, "ws://localhost:8790/ws").is_err());
}

#[test]
fn a_refused_embed_shows_its_error_slot_and_never_connects() {
    let mut h = Harness::new();
    h.module = EmbeddingModule::with_connector(Arc::clone(&h.root) as Arc<dyn HypenModule>, {
        let conns = Arc::clone(&h.conns);
        Arc::new(move |url: &str, rule, signal: EmbedSignalSink| {
            let module = Arc::new(Fake::default());
            conns.lock().unwrap().push(Conn {
                url: url.into(),
                rule,
                module: Arc::clone(&module),
                signal,
            });
            module as Arc<dyn HypenModule>
        })
    })
    .with_policy(EmbedPolicy::default().allow_hosts(["allowed.test"]));
    let out = Arc::clone(&h.out);
    h.module
        .on_owned_patches(Arc::new(move |p: Vec<Patch>| out.lock().unwrap().extend(p)));
    h.root.push(launcher_frame());
    h.take();
    assert!(
        h.conns.lock().unwrap().is_empty(),
        "todo.test is not allowed"
    );
    assert_eq!(h.children("host"), vec!["error", "note"]);
}

// ---------------------------------------------------------------------------
// final-leftovers: DNS rebinding — the private-network rule on the RESOLVED
// address, and root ids that look like embed ids.
// ---------------------------------------------------------------------------

#[test]
fn public_content_embeds_connect_public_addresses_only() {
    // Window app served from a public origin: its embed must enforce the
    // rule at connect time (a public NAME may resolve privately).
    let mut h = Harness::with_root(Fake {
        origin: Some(Arc::from("https://apps.example.com")),
        ..Fake::default()
    });
    h.root.push(vec![
        create("host", "HypenApp", &[("0", json!("wss://todo.example.com/ws"))]),
        insert("root", "host"),
    ]);
    h.take();
    {
        let conns = h.conns.lock().unwrap();
        assert_eq!(conns.len(), 1);
        assert_eq!(conns[0].rule, AddressRule::PublicOnly);
    }
    // Local content (an in-process module) embeds local apps freely.
    let mut local = Harness::new();
    local.root.push(launcher_frame());
    local.take();
    assert_eq!(local.conns.lock().unwrap()[0].rule, AddressRule::Any);
    // An explicit allowlist, or allow_private_targets, lifts the rule.
    let policy = EmbedPolicy::default();
    assert_eq!(
        policy.address_rule(Some("https://a.example")),
        AddressRule::PublicOnly
    );
    assert_eq!(policy.address_rule(Some("http://localhost:8787")), AddressRule::Any);
    assert_eq!(policy.address_rule(None), AddressRule::Any);
    assert_eq!(
        policy
            .clone()
            .allow_private_targets(true)
            .address_rule(Some("https://a.example")),
        AddressRule::Any
    );
    assert_eq!(
        policy
            .allow_hosts(["a.example"])
            .address_rule(Some("https://a.example")),
        AddressRule::Any
    );
}

#[test]
fn non_public_addresses_are_classified_in_every_spelling() {
    use std::net::IpAddr;
    for ip in [
        "127.0.0.1",
        "127.8.9.10",
        "10.1.2.3",
        "172.16.0.1",
        "192.168.1.1",
        "169.254.169.254",
        "100.64.0.1",
        "100.127.255.254",
        "0.0.0.0",
        "0.1.2.3",
        "255.255.255.255",
        "::1",
        "::",
        "fc00::1",
        "fd12:3456::1",
        "fe80::1",
        "fec0::1",
        "::ffff:127.0.0.1",
        "::ffff:169.254.169.254",
        "::ffff:10.0.0.1",
        "::127.0.0.1",
        "64:ff9b::7f00:1",
        "64:ff9b::a9fe:a9fe",
        "2002:7f00:1::",
        "2002:c0a8:101::1",
        "ff02::1",
    ] {
        let ip: IpAddr = ip.parse().unwrap();
        assert!(is_non_public_ip(ip), "{ip} must be non-public");
    }
    for ip in [
        "8.8.8.8",
        "1.1.1.1",
        "100.63.255.255",
        "100.128.0.1",
        "172.32.0.1",
        "2606:4700::1111",
        "::ffff:8.8.8.8",
        "64:ff9b::808:808",
        "2002:808:808::",
    ] {
        let ip: IpAddr = ip.parse().unwrap();
        assert!(!is_non_public_ip(ip), "{ip} is public");
    }
}

/// A root id that happens to contain a `:` is the window module's own
/// node: it routes to the root (not to a look-alike embed prefix) and can
/// never address, overwrite or collide with an embed's node.
#[test]
fn root_ids_that_look_like_embed_ids_stay_the_roots() {
    let mut h = Harness::new();
    h.root.push(launcher_frame());
    h.take();
    let conn_module = Arc::clone(&h.conns.lock().unwrap()[0].module);
    conn_module.push(todo_tree());
    h.take();
    assert!(h.tree.get("e1:2").is_some(), "the embed's button is e1:2");
    // The window app creates a node whose raw id spells the embed's.
    h.root.push(vec![
        create("e1:2", "Text", &[("0", json!("spoof"))]),
        insert("frame", "e1:2"),
        Patch::SetProp {
            id: "e1:1".into(),
            name: "backgroundColor".into(),
            value: json!("red"),
        },
    ]);
    let out = h.take();
    assert_eq!(
        h.tree.get("e1:2").map(|n| n.element_type.clone()).as_deref(),
        Some("Button"),
        "the embed's node is untouched: {out:?}"
    );
    assert!(
        h.tree
            .get("e1:1")
            .is_some_and(|n| !n.props.contains_key("backgroundColor")),
        "the window app cannot restyle the embed's node"
    );
    // The root's own colon id round-trips to the root, unprefixed.
    let spoof = h
        .tree
        .children_of("frame")
        .iter()
        .find(|id| h.tree.get(id).is_some_and(|n| n.element_type == "Text"))
        .cloned()
        .expect("the root's text is in the window");
    h.module.dispatch_ui_action(&spoof, "click", None);
    assert_eq!(h.root.ui.lock().unwrap().last().unwrap().0, "e1:2");
    assert!(conn_module.ui.lock().unwrap().is_empty());
}

/// Review gap: the private-network URL check's spelling variants (the
/// trailing-dot FQDN form of `localhost`, case, IPv4-mapped / compatible
/// IPv6, the metadata address) — none of them pinned before.
#[test]
fn private_target_spellings_are_refused_from_public_content() {
    let policy = EmbedPolicy::default();
    let public = Some("https://apps.example.com");
    for target in [
        "wss://localhost./ws",
        "wss://LOCALHOST:8787/ws",
        "wss://app.localhost./ws",
        "wss://printer.local./ws",
        "wss://[::ffff:127.0.0.1]/ws",
        "wss://[::ffff:7f00:1]:8787/ws",
        "wss://[::127.0.0.1]/ws",
        "wss://169.254.169.254/ws",
        "wss://0.0.0.0/ws",
        "wss://100.64.1.2/ws",
        "wss://[fd00::1]/ws",
    ] {
        assert!(
            policy.check_target(public, target).is_err(),
            "{target} must be refused from public content"
        );
    }
    assert!(policy.check_target(public, "wss://todo.example.com/ws").is_ok());
}

/// Review follow-up: a UI envelope WITHOUT a `node` goes to the window
/// module, but an embed's node id in it (`fromNode`) is blanked — it used
/// to be forwarded verbatim, leaking the embed's merged ids to the window
/// app's server.
#[test]
fn a_nodeless_ui_envelope_never_carries_an_embed_id_to_the_window() {
    let mut h = Harness::new();
    h.root.push(launcher_frame());
    h.take();
    h.conn(0).push(todo_tree());
    h.take();
    let ui = hypen_engine::action_routing::UI_ACTION;
    h.module.dispatch_action(
        ui,
        Some(json!({"fromNode": "e1:2", "action": "drop", "payload": {"fromNode": "e1:1"}})),
    );
    assert_eq!(
        *h.root.actions.lock().unwrap(),
        vec![(
            ui.to_string(),
            Some(json!({"fromNode": null, "action": "drop", "payload": {"fromNode": null}}))
        )]
    );
    assert!(h.conn(0).actions.lock().unwrap().is_empty());
}

#[test]
fn the_window_color_scheme_reaches_the_root_live_embeds_and_later_embeds() {
    let mut h = Harness::new();
    // Reported before any embed exists: the root hears it.
    h.module.set_color_scheme(true);
    assert_eq!(*h.root.schemes.lock().unwrap(), vec![true]);

    // An embed connected afterwards is told the current scheme on connect.
    h.root.push(launcher_frame());
    h.take();
    assert_eq!(*h.conn(0).schemes.lock().unwrap(), vec![true]);

    // A change reaches the root and every live embed.
    h.module.set_color_scheme(false);
    assert_eq!(*h.root.schemes.lock().unwrap(), vec![true, false]);
    assert_eq!(*h.conn(0).schemes.lock().unwrap(), vec![true, false]);
}
