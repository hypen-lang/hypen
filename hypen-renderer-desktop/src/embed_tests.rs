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
}

/// One connection the fake connector opened.
struct Conn {
    url: String,
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
        let root = Arc::new(Fake::default());
        let conns: Arc<Mutex<Vec<Conn>>> = Arc::default();
        let sink = Arc::clone(&conns);
        let connector: EmbedConnector = Arc::new(move |url: &str, signal: EmbedSignalSink| {
            let module = Arc::new(Fake::default());
            sink.lock().unwrap().push(Conn {
                url: url.into(),
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
