//! Where rendered patches go: the [`PatchHub`].
//!
//! The engine's render callback hands every patch batch to
//! [`PatchHub::publish`], which
//!
//! 1. lowers template-shaped list rows (`RegisterTemplate` / `Instantiate`) to
//!    the plain `Create` + `Insert` wire the reference clients speak;
//! 2. folds the batch into a [`TreeMirror`] — the current rendered tree — so
//!    `GET /patches` can answer with a **snapshot** whose size is bounded by
//!    the live tree instead of replaying an ever-growing log;
//! 3. delivers the batch to **exactly one** consumer: the in-flight
//!    [`Capture`] if there is one (a `/dispatch` response, the REPL), or else
//!    every live SSE subscriber.
//!
//! Exactness of (3) rests on one rule, enforced by
//! [`Runtime`](crate::app::Runtime): renders only happen while the engine
//! lock is held, and a capture is opened and closed under that same lock. So
//! a batch is either inside some dispatch's capture window or it is not —
//! there is no moment where an out-of-band render (hot reload, a timer) can
//! land in both a dispatch response and the SSE stream.

use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};

use hypen_engine::ir::Semantics;
use hypen_engine::portable::TemplateExpander;
use hypen_engine::Patch;
use indexmap::IndexMap;
use serde_json::Value;

use crate::sync::lock;

/// Most concurrent SSE subscribers; further `GET /events` get a 503.
pub const MAX_SUBSCRIBERS: usize = 64;

/// Frames a subscriber may have queued before it is considered stalled and
/// dropped (its `EventSource` reconnects and resyncs from a snapshot).
const SUBSCRIBER_QUEUE: usize = 256;

/// The id of the virtual container top-level nodes are inserted into.
const ROOT: &str = "root";

// ── the mirror ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct MirrorNode {
    element_type: String,
    props: IndexMap<String, Value>,
    semantics: Option<Semantics>,
    text: Option<String>,
    /// Container this node is currently linked under (`None` = created but
    /// not inserted, or detached).
    parent: Option<Arc<str>>,
    children: Vec<Arc<str>>,
}

/// The rendered tree, reconstructed from the patch stream — the same
/// bookkeeping a DOM client does, minus the DOM.
#[derive(Debug, Default)]
pub struct TreeMirror {
    nodes: IndexMap<Arc<str>, MirrorNode>,
    root_children: Vec<Arc<str>>,
}

impl TreeMirror {
    fn children_of(&mut self, parent: &str) -> Option<&mut Vec<Arc<str>>> {
        if parent == ROOT {
            Some(&mut self.root_children)
        } else {
            self.nodes.get_mut(parent).map(|n| &mut n.children)
        }
    }

    /// Remove `id` from its current parent's child list (the node stays).
    fn unlink(&mut self, id: &str) {
        let Some(parent) = self.nodes.get_mut(id).and_then(|n| n.parent.take()) else {
            return;
        };
        if let Some(children) = self.children_of(&parent) {
            children.retain(|c| &**c != id);
        }
    }

    /// Link `id` under `parent`, before `before` (or last).
    fn link(&mut self, parent: &Arc<str>, id: &Arc<str>, before: Option<&Arc<str>>) {
        if !self.nodes.contains_key(id) || (&**parent != ROOT && !self.nodes.contains_key(parent)) {
            return;
        }
        self.unlink(id);
        let Some(children) = self.children_of(parent) else {
            return;
        };
        let at = before
            .and_then(|b| children.iter().position(|c| c == b))
            .unwrap_or(children.len());
        children.insert(at, Arc::clone(id));
        if let Some(node) = self.nodes.get_mut(id) {
            node.parent = Some(Arc::clone(parent));
        }
    }

    /// Drop `id` and everything under it.
    fn remove_subtree(&mut self, id: &str) {
        self.unlink(id);
        let mut stack = vec![id.to_string()];
        while let Some(next) = stack.pop() {
            if let Some(node) = self.nodes.swap_remove(next.as_str()) {
                stack.extend(node.children.iter().map(|c| c.to_string()));
            }
        }
    }

    /// Fold one patch into the tree. Patches that address unknown nodes are
    /// ignored, like a DOM client would.
    pub fn apply(&mut self, patch: &Patch) {
        match patch {
            Patch::Create { id, element_type, props, semantics } => {
                self.remove_subtree(id);
                self.nodes.insert(
                    Arc::clone(id),
                    MirrorNode {
                        element_type: element_type.clone(),
                        props: (**props).clone(),
                        semantics: semantics.clone(),
                        text: None,
                        parent: None,
                        children: Vec::new(),
                    },
                );
            }
            Patch::SetSemantics { id, semantics } => {
                if let Some(node) = self.nodes.get_mut(id) {
                    node.semantics = semantics.clone();
                }
            }
            Patch::SetProp { id, name, value } => {
                if let Some(node) = self.nodes.get_mut(id) {
                    node.props.insert(name.clone(), value.clone());
                }
            }
            Patch::RemoveProp { id, name } => {
                if let Some(node) = self.nodes.get_mut(id) {
                    node.props.shift_remove(name);
                }
            }
            Patch::SetText { id, text } => {
                if let Some(node) = self.nodes.get_mut(id) {
                    node.text = Some(text.clone());
                }
            }
            Patch::Insert { parent_id, id, before_id }
            | Patch::Move { parent_id, id, before_id }
            | Patch::Attach { parent_id, id, before_id } => {
                self.link(parent_id, id, before_id.as_ref());
            }
            Patch::Remove { id, .. } => self.remove_subtree(id),
            Patch::ClearChildren { id } => {
                let children = self.children_of(id).map(std::mem::take).unwrap_or_default();
                for child in children {
                    // Already unlinked by the `take`; drop the subtrees.
                    if let Some(node) = self.nodes.get_mut(&child) {
                        node.parent = None;
                    }
                    self.remove_subtree(&child);
                }
            }
            Patch::Detach { id } => self.unlink(id),
            // Lowered by the expander before they reach the mirror.
            Patch::RegisterTemplate { .. } | Patch::Instantiate { .. } => {}
            // A transient animation stamp for one batch; not tree state.
            Patch::BatchAnimation { .. } => {}
        }
    }

    /// The patches that rebuild the current tree from nothing: every live
    /// node's `Create` (with its current props), then the `Insert`s that link
    /// them. Detached subtrees are created and linked internally but not
    /// inserted, so a later `Attach` finds them.
    pub fn snapshot(&self) -> Vec<Patch> {
        let mut out = Vec::with_capacity(self.nodes.len() * 2);
        for (id, node) in &self.nodes {
            out.push(Patch::Create {
                id: Arc::clone(id),
                element_type: node.element_type.clone(),
                props: Arc::new(node.props.clone()),
                semantics: node.semantics.clone(),
            });
            if let Some(text) = &node.text {
                out.push(Patch::SetText { id: Arc::clone(id), text: text.clone() });
            }
        }
        let root: Arc<str> = Arc::from(ROOT);
        let containers = std::iter::once((&root, &self.root_children))
            .chain(self.nodes.iter().map(|(id, node)| (id, &node.children)));
        for (parent, children) in containers {
            for child in children {
                out.push(Patch::Insert {
                    parent_id: Arc::clone(parent),
                    id: Arc::clone(child),
                    before_id: None,
                });
            }
        }
        out
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.nodes.len()
    }
}

// ── the hub ─────────────────────────────────────────────────────────────────

struct Subscriber {
    id: u64,
    tx: SyncSender<Arc<str>>,
}

struct HubState {
    expander: TemplateExpander,
    mirror: TreeMirror,
    /// `Some` while a capture window is open.
    capture: Option<Vec<Patch>>,
    subscribers: Vec<Subscriber>,
    next_subscriber: u64,
}

/// See the module docs.
pub struct PatchHub {
    state: Mutex<HubState>,
}

/// `GET /events` refused: the subscriber cap is reached.
#[derive(Debug, PartialEq, Eq)]
pub struct TooManySubscribers;

impl PatchHub {
    pub fn new() -> Self {
        PatchHub {
            state: Mutex::new(HubState {
                expander: TemplateExpander::new(),
                mirror: TreeMirror::default(),
                capture: None,
                subscribers: Vec::new(),
                next_subscriber: 0,
            }),
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, HubState> {
        lock(&self.state, "patch hub")
    }

    /// Accept one render batch from the engine. Called from the render
    /// callback, i.e. with the engine lock held.
    pub fn publish(&self, patches: &[Patch]) {
        let mut state = self.state();
        let patches = state.expander.expand(patches.to_vec());
        if patches.is_empty() {
            return;
        }
        for patch in &patches {
            state.mirror.apply(patch);
        }
        if let Some(captured) = state.capture.as_mut() {
            captured.extend(patches);
            return;
        }
        if state.subscribers.is_empty() {
            return;
        }
        let frame: Arc<str> = match serde_json::to_string(&patches) {
            Ok(json) => Arc::from(json),
            Err(e) => {
                eprintln!("[events] cannot serialise a patch batch: {e}");
                return;
            }
        };
        state.subscribers.retain(|sub| match sub.tx.try_send(Arc::clone(&frame)) {
            Ok(()) => true,
            // Stalled or gone: drop it. The client's EventSource reconnects
            // and resyncs from a snapshot.
            Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => false,
        });
    }

    /// Open a capture window: until the returned guard is finished or
    /// dropped, published batches are collected for the caller instead of
    /// being broadcast. Must be opened and closed under the engine lock.
    pub fn capture(&self) -> Capture<'_> {
        let mut state = self.state();
        debug_assert!(state.capture.is_none(), "capture windows do not nest");
        state.capture = Some(Vec::new());
        Capture { hub: self }
    }

    /// The patches that rebuild the current tree (see
    /// [`TreeMirror::snapshot`]).
    pub fn snapshot(&self) -> Vec<Patch> {
        self.state().mirror.snapshot()
    }

    /// Register an SSE subscriber. Dropping the [`Subscription`] removes it.
    pub fn subscribe(self: &Arc<Self>) -> Result<Subscription, TooManySubscribers> {
        let mut state = self.state();
        if state.subscribers.len() >= MAX_SUBSCRIBERS {
            return Err(TooManySubscribers);
        }
        let (tx, rx) = sync_channel(SUBSCRIBER_QUEUE);
        let id = state.next_subscriber;
        state.next_subscriber += 1;
        state.subscribers.push(Subscriber { id, tx });
        Ok(Subscription { id, frames: rx, hub: Arc::clone(self) })
    }

    #[cfg(test)]
    fn subscriber_count(&self) -> usize {
        self.state().subscribers.len()
    }

    #[cfg(test)]
    pub fn mirror_len(&self) -> usize {
        self.state().mirror.len()
    }
}

/// An open capture window (see [`PatchHub::capture`]).
pub struct Capture<'a> {
    hub: &'a PatchHub,
}

impl Capture<'_> {
    /// Close the window and take what was rendered inside it.
    pub fn finish(self) -> Vec<Patch> {
        self.hub.state().capture.take().unwrap_or_default()
    }
}

impl Drop for Capture<'_> {
    fn drop(&mut self) {
        // Closes the window on unwind too, so a panicking dispatch cannot
        // leave SSE muted. After `finish` this is a no-op.
        self.hub.state().capture = None;
    }
}

/// A live SSE subscriber: JSON patch-array frames arrive on `frames`.
pub struct Subscription {
    id: u64,
    pub frames: Receiver<Arc<str>>,
    hub: Arc<PatchHub>,
}

impl Drop for Subscription {
    fn drop(&mut self) {
        self.hub.state().subscribers.retain(|s| s.id != self.id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn id(s: &str) -> Arc<str> {
        Arc::from(s)
    }

    fn create(node: &str, element_type: &str, props: Value) -> Patch {
        let props: IndexMap<String, Value> = props
            .as_object()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .collect();
        Patch::Create {
            id: id(node),
            element_type: element_type.into(),
            props: Arc::new(props),
            semantics: None,
        }
    }

    fn insert(parent: &str, node: &str, before: Option<&str>) -> Patch {
        Patch::Insert { parent_id: id(parent), id: id(node), before_id: before.map(id) }
    }

    fn set_prop(node: &str, name: &str, value: Value) -> Patch {
        Patch::SetProp { id: id(node), name: name.into(), value }
    }

    /// The tree as nested text, e.g. `Column[Text{0=a}, Button]`.
    fn shape(mirror: &TreeMirror) -> String {
        fn node(mirror: &TreeMirror, id: &str, out: &mut String) {
            let n = &mirror.nodes[id];
            out.push_str(&n.element_type);
            if !n.props.is_empty() {
                let props: Vec<String> = n.props.iter().map(|(k, v)| format!("{k}={v}")).collect();
                out.push_str(&format!("{{{}}}", props.join(",")));
            }
            if !n.children.is_empty() {
                out.push('[');
                for (i, c) in n.children.iter().enumerate() {
                    if i > 0 {
                        out.push_str(", ");
                    }
                    node(mirror, c, out);
                }
                out.push(']');
            }
        }
        let mut out = String::new();
        for (i, c) in mirror.root_children.iter().enumerate() {
            if i > 0 {
                out.push_str(" | ");
            }
            node(mirror, c, &mut out);
        }
        out
    }

    fn mirror_of(patches: &[Patch]) -> TreeMirror {
        let mut m = TreeMirror::default();
        for p in patches {
            m.apply(p);
        }
        m
    }

    fn sample() -> Vec<Patch> {
        vec![
            create("1", "Column", json!({})),
            create("2", "Text", json!({ "0": "Count: 0" })),
            create("3", "Button", json!({ "action": "@actions.increment" })),
            create("4", "Text", json!({ "0": "+1" })),
            insert("3", "4", None),
            insert("1", "2", None),
            insert("1", "3", None),
            insert("root", "1", None),
        ]
    }

    #[test]
    fn mirror_tracks_the_tree_and_snapshot_rebuilds_it() {
        let mut m = mirror_of(&sample());
        assert_eq!(
            shape(&m),
            r#"Column[Text{0="Count: 0"}, Button{action="@actions.increment"}[Text{0="+1"}]]"#
        );

        m.apply(&set_prop("2", "0", json!("Count: 1")));
        m.apply(&Patch::RemoveProp { id: id("3"), name: "action".into() });
        m.apply(&create("5", "Text", json!({ "0": "new" })));
        m.apply(&insert("1", "5", Some("2")));
        m.apply(&Patch::Move { parent_id: id("1"), id: id("3"), before_id: Some(id("5")) });
        assert_eq!(
            shape(&m),
            r#"Column[Button[Text{0="+1"}], Text{0="new"}, Text{0="Count: 1"}]"#
        );

        // A client that applies the snapshot ends up with the same tree.
        let rebuilt = mirror_of(&m.snapshot());
        assert_eq!(shape(&rebuilt), shape(&m));
        // The snapshot folds prop changes into the Create — no history.
        assert_eq!(m.snapshot().len(), m.len() * 2, "one Create + one Insert per node");
    }

    #[test]
    fn remove_drops_the_subtree_and_clear_children_empties_a_node() {
        let mut m = mirror_of(&sample());
        m.apply(&Patch::Remove { id: id("3"), transition: false });
        assert_eq!(shape(&m), r#"Column[Text{0="Count: 0"}]"#);
        assert_eq!(m.len(), 2, "the Button's child went with it");
        // The engine also emits Removes for descendants; they are no-ops now.
        m.apply(&Patch::Remove { id: id("4"), transition: false });

        let mut m = mirror_of(&sample());
        m.apply(&Patch::ClearChildren { id: id("1") });
        assert_eq!(shape(&m), "Column");
        assert_eq!(m.len(), 1);
    }

    #[test]
    fn detached_subtrees_survive_in_the_snapshot_for_a_later_attach() {
        let mut m = mirror_of(&sample());
        m.apply(&Patch::Detach { id: id("3") });
        assert_eq!(shape(&m), r#"Column[Text{0="Count: 0"}]"#);
        assert_eq!(m.len(), 4, "detached nodes are kept");

        let mut client = mirror_of(&m.snapshot());
        assert_eq!(shape(&client), shape(&m));
        let attach = Patch::Attach { parent_id: id("1"), id: id("3"), before_id: Some(id("2")) };
        m.apply(&attach);
        client.apply(&attach);
        assert_eq!(shape(&client), r#"Column[Button{action="@actions.increment"}[Text{0="+1"}], Text{0="Count: 0"}]"#);
        assert_eq!(shape(&client), shape(&m));
    }

    #[test]
    fn the_mirror_stays_bounded_under_churn() {
        let hub = PatchHub::new();
        hub.publish(&sample());
        for i in 0..10_000 {
            hub.publish(&[set_prop("2", "0", json!(format!("Count: {i}")))]);
            let row = format!("row{i}");
            hub.publish(&[create(&row, "Text", json!({})), insert("1", &row, None)]);
            hub.publish(&[Patch::Remove { id: id(&row), transition: false }]);
        }
        assert_eq!(hub.mirror_len(), 4, "30k batches later the tree is still 4 nodes");
        assert_eq!(hub.snapshot().len(), 8);
    }

    #[test]
    fn patches_addressing_unknown_nodes_are_ignored() {
        let mut m = TreeMirror::default();
        m.apply(&set_prop("ghost", "0", json!(1)));
        m.apply(&insert("ghost", "also-ghost", None));
        m.apply(&Patch::Remove { id: id("ghost"), transition: true });
        m.apply(&Patch::ClearChildren { id: id("ghost") });
        m.apply(&Patch::Detach { id: id("ghost") });
        assert!(m.snapshot().is_empty());
    }

    fn frames(sub: &Subscription) -> Vec<String> {
        sub.frames.try_iter().map(|f| f.to_string()).collect()
    }

    /// The double-delivery defect, at the unit level: an out-of-band render
    /// before, during-adjacent and after a dispatch's capture window. Every
    /// batch must reach exactly one consumer.
    #[test]
    fn every_batch_is_delivered_exactly_once() {
        let hub = Arc::new(PatchHub::new());
        let sub = hub.subscribe().unwrap();

        hub.publish(&sample()); // out-of-band (e.g. hot reload)
        let capture = hub.capture(); // a dispatch starts
        hub.publish(&[set_prop("2", "0", json!("in-dispatch"))]);
        let dispatch_delta = capture.finish(); // …and ends
        hub.publish(&[set_prop("2", "0", json!("timer"))]); // zero-delay timer right after

        let pushed = frames(&sub);
        assert_eq!(pushed.len(), 2, "the two out-of-band batches: {pushed:?}");
        assert!(pushed[0].contains("Column"));
        assert!(pushed[1].contains("timer"));
        assert!(pushed.iter().all(|f| !f.contains("in-dispatch")), "not pushed: {pushed:?}");

        let delta = serde_json::to_string(&dispatch_delta).unwrap();
        assert_eq!(dispatch_delta.len(), 1);
        assert!(delta.contains("in-dispatch"));
        assert!(!delta.contains("timer") && !delta.contains("Column"), "not in the response: {delta}");
    }

    #[test]
    fn an_abandoned_capture_does_not_mute_the_stream() {
        let hub = Arc::new(PatchHub::new());
        let sub = hub.subscribe().unwrap();
        {
            let _capture = hub.capture();
            hub.publish(&sample());
            // dropped without `finish` — e.g. the dispatch panicked
        }
        hub.publish(&[set_prop("2", "0", json!("after"))]);
        assert_eq!(frames(&sub).len(), 1);
    }

    #[test]
    fn subscribers_are_capped_and_removed_on_drop() {
        let hub = Arc::new(PatchHub::new());
        let subs: Vec<Subscription> =
            (0..MAX_SUBSCRIBERS).map(|_| hub.subscribe().unwrap()).collect();
        assert_eq!(hub.subscribe().err(), Some(TooManySubscribers));
        drop(subs);
        assert_eq!(hub.subscriber_count(), 0);
        assert!(hub.subscribe().is_ok());
    }

    #[test]
    fn a_stalled_subscriber_is_dropped_not_buffered_forever() {
        let hub = Arc::new(PatchHub::new());
        let stalled = hub.subscribe().unwrap();
        hub.publish(&sample());
        for i in 0..SUBSCRIBER_QUEUE + 10 {
            hub.publish(&[set_prop("2", "0", json!(i))]);
        }
        assert_eq!(hub.subscriber_count(), 0, "queue overflowed → dropped");
        assert_eq!(frames(&stalled).len(), SUBSCRIBER_QUEUE, "bounded backlog");
    }
}
