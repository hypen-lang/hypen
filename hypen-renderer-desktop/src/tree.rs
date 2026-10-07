//! Renderer-side virtual tree.
//!
//! Mirrors the engine's node graph by replaying the [`Patch`] stream the
//! engine emits. Phase 1 supports the structural patches needed to render a
//! single static tree: `Create`, `Insert`, `SetProp`, `RemoveProp`,
//! `Remove`, `Move`. `Detach` / `Attach` (Router cache) and `SetText`
//! (reserved by the engine) are stubbed and will land in a later phase.

use hypen_engine::Patch;
use rustc_hash::FxRandomState;
use serde_json::Value;
use std::collections::HashMap;

/// The synthetic parent ID used by the engine for top-level nodes.
pub const ROOT_ID: &str = "root";

/// A node's resolved props, keyed by applicator / CSS property name.
///
/// Not the default hasher. `style::node_style_with` probes dozens of
/// applicator names against a node that carries a handful, and each probe
/// tries up to three spellings (`padding`, `padding.0`, `padding-left`),
/// so the overwhelming majority of lookups are misses whose entire cost
/// is the hash. Callgrind put SipHash at ~42% of the instructions retired
/// in a style build, ahead of every piece of actual layout work.
///
/// [`FxRandomState`] rather than the deterministic `FxBuildHasher`,
/// because the usual excuse for dropping SipHash does not apply here:
/// these keys are not all authored locally. `remote.rs` applies `Patch`
/// streams from a RemoteServer, and their prop keys land in this map
/// unvalidated and with no cap on how many. Against an unseeded
/// multiplicative hash those are offline-constructible — 20k colliding
/// 8-byte keys took under a second to generate and turned a 1.9 ms
/// insert into 46 ms, on the event-loop thread. Seeding per process
/// removes the precomputation and keeps the win.
pub type PropMap = HashMap<String, Value, FxRandomState>;

/// A flat node in the renderer tree.
#[derive(Debug, Clone)]
pub struct Node {
    pub id: String,
    pub element_type: String,
    pub props: PropMap,
    /// Engine-derived accessibility semantics (role, name, hidden, …), carried
    /// from the Create patch so the AccessKit translation can use the engine's
    /// accessible name/role instead of layout heuristics.
    pub semantics: Option<hypen_engine::ir::Semantics>,
}

impl Node {
    /// True when any prop key carries a variant marker (`@bp` / `:state`,
    /// e.g. `padding@md.0`, `backgroundColor:hover.0`). Conservative — a
    /// `@` / `:` with an unrecognised token also returns `true`, which
    /// only costs the caller the slow path, never correctness. This is
    /// the style resolver's fast-path gate: the overwhelmingly common
    /// plainly-styled node answers `false` with a byte scan and skips
    /// the per-lookup key parsing in `style::pick_base` entirely.
    #[inline]
    pub fn has_variant_prop_keys(&self) -> bool {
        self.props
            .keys()
            .any(|k| k.as_bytes().iter().any(|&b| b == b'@' || b == b':'))
    }

    /// Convenience: positional text content lives at prop key `"0"`.
    /// Returns the value as a string for any JSON scalar — strings
    /// pass through verbatim, numbers / booleans get stringified.
    /// Without the scalar fallback, bindings like
    /// `Text("@{state.user.postsCount}")` (where the engine resolves
    /// the path to a `Number(42)`) silently rendered nothing because
    /// `Value::as_str()` only matches `String`. Profile's "42 Posts /
    /// 1.2k Followers / 3 Following" labels were the visible victim.
    pub fn text_content(&self) -> Option<std::borrow::Cow<'_, str>> {
        let v = self.props.get("0")?;
        match v {
            Value::String(s) => Some(std::borrow::Cow::Borrowed(s.as_str())),
            Value::Number(n) => Some(std::borrow::Cow::Owned(n.to_string())),
            Value::Bool(b) => Some(std::borrow::Cow::Owned(b.to_string())),
            Value::Null => None,
            // Arrays / objects don't have a sensible scalar form;
            // upstream binding resolution should never produce one
            // for a Text content, but if it does we render nothing
            // rather than dumping JSON into the UI.
            _ => None,
        }
    }
}

/// Renderer-side mirror of the engine's node graph.
///
/// Cheap to mutate, cheap to walk. Intentionally not thread-safe — owned
/// by the window's event-loop thread.
#[derive(Debug, Default)]
pub struct Tree {
    nodes: HashMap<String, Node>,
    /// `parent_id → ordered child ids`. The synthetic `"root"` parent is
    /// included here.
    children: HashMap<String, Vec<String>>,
    /// Reverse index: `child_id → parent_id`. Lets `Remove` /
    /// `Detach` look up the affected parent in O(1) instead of
    /// scanning every children list. Maintained in lockstep with
    /// `children` by every patch handler.
    parent_by_child: HashMap<String, String>,
    /// Roots of subtrees unlinked by `Detach` and not yet reattached
    /// or removed, in detach order (oldest first). `Detach` keeps the
    /// whole subtree alive (it backs the engine's Router keep-alive
    /// cache, which reattaches via `Attach`), so nothing here frees on
    /// its own — the engine's Router LRU is expected to emit `Remove`
    /// on eviction. This list backs [`Tree::evict_detached_over`], a
    /// safety backstop so a host that detaches without ever
    /// re-Attaching or Removing (a looping / buggy server) can't grow
    /// the node arena without bound.
    detached: Vec<String>,
    /// Live count of prop keys starting with `opacity` across every
    /// node (detached subtrees included, matching the scan these
    /// counters replace). Maintained by every prop mutation path so
    /// the layout pass's opacity post-pass gate is O(1) instead of a
    /// full per-frame prop scan — which measured ~1.4 ms/frame on an
    /// 11k-node tree.
    opacity_keys: usize,
    /// Same, for the transform prop vocabulary (`translateX` /
    /// `translateY` / `scale` / `rotate`).
    transform_keys: usize,
    /// `Some` while a raw-write bracket is open (see
    /// [`Tree::begin_raw_write_log`]); collects `(id, key)` for every
    /// `set_prop_raw` / `remove_prop_raw` inside it. `None` — the
    /// steady state — makes logging a single branch.
    raw_write_log: Option<Vec<(String, String)>>,
    /// A STRUCTURAL mutation (`Tree::apply`) happened while the
    /// bracket was open. Today the only tick-reachable `apply` is an
    /// exit finalize, which the classifier already rejects through
    /// `TickOutcome::finalized` — this flag exists so a future
    /// `tree.apply` added inside the tick can never silently escape
    /// the paint-only classification and leave a stale render.
    raw_structural_seen: bool,
}

/// Which paint-gate counters a prop key belongs to:
/// `(opacity, transform)`. Prefix-based, so variant-decorated keys
/// (`opacity@md.0`, `scale:hover.0`) count too — identical to the
/// full scans this replaces.
#[inline]
fn paint_gate_class(key: &str) -> (bool, bool) {
    (
        key.starts_with("opacity"),
        key.starts_with("translateX")
            || key.starts_with("translateY")
            || key.starts_with("scale")
            || key.starts_with("rotate")
            // The drag-and-drop runtime's local offsets ride the same
            // transform post-pass (`layout::node_local_transform`), so
            // they must open the gate too.
            || key.starts_with(crate::dnd::LOCAL_PROP_PREFIX)
            || key == "__dnd.pinX" || key == "__dnd.pinY",
    )
}

impl Tree {
    pub fn new() -> Self {
        let mut children = HashMap::new();
        children.insert(ROOT_ID.to_string(), Vec::new());
        Self {
            nodes: HashMap::new(),
            children,
            parent_by_child: HashMap::new(),
            detached: Vec::new(),
            opacity_keys: 0,
            transform_keys: 0,
            raw_write_log: None,
            raw_structural_seen: false,
        }
    }

    /// O(1): does any node carry an `opacity*` prop key? Gates the
    /// layout pass's effective-opacity post-pass.
    pub fn has_opacity_props(&self) -> bool {
        self.opacity_keys > 0
    }

    /// O(1): does any node carry a transform prop key? Gates the
    /// layout pass's transform post-pass.
    pub fn has_transform_props(&self) -> bool {
        self.transform_keys > 0
    }

    #[inline]
    fn count_key_added(&mut self, key: &str) {
        let (o, t) = paint_gate_class(key);
        if o {
            self.opacity_keys += 1;
        }
        if t {
            self.transform_keys += 1;
        }
    }

    #[inline]
    fn count_key_removed(&mut self, key: &str) {
        let (o, t) = paint_gate_class(key);
        if o {
            self.opacity_keys = self.opacity_keys.saturating_sub(1);
        }
        if t {
            self.transform_keys = self.transform_keys.saturating_sub(1);
        }
    }

    fn count_node_removed(&mut self, node: &Node) {
        let mut o = 0usize;
        let mut t = 0usize;
        for key in node.props.keys() {
            let (is_o, is_t) = paint_gate_class(key);
            o += is_o as usize;
            t += is_t as usize;
        }
        self.opacity_keys = self.opacity_keys.saturating_sub(o);
        self.transform_keys = self.transform_keys.saturating_sub(t);
    }

    /// O(1) parent lookup. Returns `None` for the synthetic root,
    /// detached subtrees, and unknown ids.
    pub fn parent_of(&self, id: &str) -> Option<&str> {
        self.parent_by_child.get(id).map(String::as_str)
    }

    pub fn root_children(&self) -> &[String] {
        self.children.get(ROOT_ID).map(Vec::as_slice).unwrap_or(&[])
    }

    pub fn children_of(&self, id: &str) -> &[String] {
        self.children.get(id).map(Vec::as_slice).unwrap_or(&[])
    }

    pub fn get(&self, id: &str) -> Option<&Node> {
        self.nodes.get(id)
    }

    /// Iterate every live node (live + detached subtrees alike — the
    /// `nodes` map holds both). Order is unspecified. Used by the window
    /// to scan for layout-affecting state variants after a patch flush.
    pub fn nodes(&self) -> impl Iterator<Item = &Node> {
        self.nodes.values()
    }

    /// Write a prop directly, bypassing the patch stream. Used by the
    /// animation runtime ([`crate::anim::DesktopAnimator`]) to write
    /// per-tick interpolated values into the REAL props — the same
    /// entries layout, paint, and hit-testing read (design constraint
    /// #5: never a paint-only presentation layer).
    pub(crate) fn set_prop_raw(&mut self, id: &str, name: &str, value: Value) {
        self.log_raw_write(id, name);
        let added = match self.nodes.get_mut(id) {
            Some(node) => node.props.insert(name.to_string(), value).is_none(),
            None => false,
        };
        if added {
            self.count_key_added(name);
        }
    }

    /// Remove a prop directly (animator settle restoring an
    /// originally-absent prop). See [`Tree::set_prop_raw`].
    pub(crate) fn remove_prop_raw(&mut self, id: &str, name: &str) {
        self.log_raw_write(id, name);
        let removed = match self.nodes.get_mut(id) {
            Some(node) => node.props.remove(name).is_some(),
            None => false,
        };
        if removed {
            self.count_key_removed(name);
        }
    }

    /// Start recording every `set_prop_raw` / `remove_prop_raw`
    /// `(id, key)` pair. The animation-frame driver brackets the
    /// animator tick with this so it learns EXACTLY which nodes the
    /// tick wrote — at the tree level, not by auditing the animator's
    /// many write sites — and can classify the frame paint-only.
    /// Logging is off outside the bracket, so raw writes elsewhere
    /// (scrub ticks, tests) cost nothing and can't leak into a stale
    /// log.
    pub(crate) fn begin_raw_write_log(&mut self) {
        self.raw_write_log = Some(Vec::new());
        self.raw_structural_seen = false;
    }

    /// Stop recording. Returns the writes since
    /// [`Tree::begin_raw_write_log`] in write order (duplicates
    /// preserved), and whether any STRUCTURAL mutation (`Tree::apply`)
    /// happened inside the bracket — a structural bracket must never
    /// classify paint-only, whatever the prop writes look like.
    pub(crate) fn end_raw_write_log(&mut self) -> (Vec<(String, String)>, bool) {
        let structural = std::mem::take(&mut self.raw_structural_seen);
        (self.raw_write_log.take().unwrap_or_default(), structural)
    }

    #[inline]
    fn log_raw_write(&mut self, id: &str, name: &str) {
        if let Some(log) = self.raw_write_log.as_mut() {
            log.push((id.to_string(), name.to_string()));
        }
    }

    /// Apply a single patch.
    ///
    /// Patches that reference unknown nodes are logged and skipped rather
    /// than panicking — the renderer should be forgiving of out-of-order
    /// streams from buggy hosts during development.
    ///
    /// NOTE on animation: this is the RAW structural application. The
    /// window routes every batch through
    /// [`crate::anim::DesktopAnimator::ingest`], which honors the
    /// `Remove { transition: true }` deferred-exit flag and the
    /// `BatchAnimation` prelude BEFORE patches reach this method —
    /// a flagged Remove that defers is withheld from the tree until its
    /// exit settles, and re-applied here at finalize. Calling `apply`
    /// directly (tests, headless tools) therefore snaps, which is the
    /// protocol's sanctioned degradation.
    pub fn apply(&mut self, patch: &Patch) {
        // Inside a raw-write bracket (the animation tick), a
        // structural apply must poison the paint-only classification
        // — see `raw_structural_seen`.
        if self.raw_write_log.is_some() {
            self.raw_structural_seen = true;
        }
        match patch {
            Patch::Create {
                id,
                element_type,
                props,
                semantics,
            } => {
                let mut prop_map =
                    PropMap::with_capacity_and_hasher(props.len(), FxRandomState::default());
                for (k, v) in props.iter() {
                    self.count_key_added(k);
                    prop_map.insert(k.clone(), v.clone());
                }
                let replaced = self.nodes.insert(
                    id.to_string(),
                    Node {
                        id: id.to_string(),
                        element_type: element_type.clone(),
                        props: prop_map,
                        semantics: semantics.clone(),
                    },
                );
                // A host re-Creating an existing id replaces the node —
                // its old props leave the tree with it.
                if let Some(old) = replaced {
                    self.count_node_removed(&old);
                }
                self.children.entry(id.to_string()).or_default();
            }
            Patch::SetProp { id, name, value } => {
                let added = match self.nodes.get_mut(id.as_ref()) {
                    Some(node) => node.props.insert(name.clone(), value.clone()).is_none(),
                    None => {
                        log::warn!("SetProp on unknown node {id}");
                        false
                    }
                };
                if added {
                    self.count_key_added(name);
                }
            }
            Patch::SetSemantics { id, semantics } => {
                // Reactive accessibility update: replace the node's whole
                // block (None clears it). The next `LayoutPass` rebuilds its
                // node_id→Semantics side-map from `Node.semantics`, so the
                // AccessKit tree picks the change up on the following push —
                // no per-field diffing here by design (see the Patch docs).
                if let Some(node) = self.nodes.get_mut(id.as_ref()) {
                    node.semantics = semantics.clone();
                } else {
                    log::warn!("SetSemantics on unknown node {id}");
                }
            }
            Patch::RemoveProp { id, name } => {
                let removed = match self.nodes.get_mut(id.as_ref()) {
                    Some(node) => node.props.remove(name).is_some(),
                    None => false,
                };
                if removed {
                    self.count_key_removed(name);
                }
            }
            Patch::SetText { id, text } => {
                // Reserved by the engine — currently unreachable in production.
                // Emulate by writing prop "0" so renderer behaviour stays
                // consistent if a host emits it. (`"0"` is in neither
                // paint-gate class, so no counter update is needed.)
                if let Some(node) = self.nodes.get_mut(id.as_ref()) {
                    node.props.insert("0".into(), Value::String(text.clone()));
                }
            }
            Patch::Insert {
                parent_id,
                id,
                before_id,
            } => {
                if self.would_cycle(parent_id, id) {
                    log::warn!("Insert of {id} under {parent_id} would create a cycle; skipping");
                    return;
                }
                // Detach from any prior parent in case the host
                // re-inserts without an explicit Move (defensive).
                if let Some(prev_parent) = self.parent_by_child.get(id.as_ref()).cloned() {
                    if let Some(siblings) = self.children.get_mut(&prev_parent) {
                        siblings.retain(|c| c.as_str() != id.as_ref());
                    }
                }
                let siblings = self.children.entry(parent_id.to_string()).or_default();
                Self::insert_at(siblings, id.to_string(), before_id.as_deref());
                self.parent_by_child
                    .insert(id.to_string(), parent_id.to_string());
                self.clear_detached(id);
            }
            Patch::Move {
                parent_id,
                id,
                before_id,
            } => {
                if self.would_cycle(parent_id, id) {
                    log::warn!("Move of {id} under {parent_id} would create a cycle; skipping");
                    return;
                }
                // Unlink from old parent (O(1) parent lookup, then
                // O(n_siblings) retain on just that one parent).
                if let Some(prev_parent) = self.parent_by_child.get(id.as_ref()).cloned() {
                    if let Some(siblings) = self.children.get_mut(&prev_parent) {
                        siblings.retain(|c| c.as_str() != id.as_ref());
                    }
                }
                let siblings = self.children.entry(parent_id.to_string()).or_default();
                Self::insert_at(siblings, id.to_string(), before_id.as_deref());
                self.parent_by_child
                    .insert(id.to_string(), parent_id.to_string());
                self.clear_detached(id);
            }
            Patch::Remove { id, .. } => {
                // O(1) parent lookup replaces the previous full
                // children-map scan to find the affected list.
                if let Some(prev_parent) = self.parent_by_child.remove(id.as_ref()) {
                    if let Some(siblings) = self.children.get_mut(&prev_parent) {
                        siblings.retain(|c| c.as_str() != id.as_ref());
                    }
                }
                self.clear_detached(id);
                self.remove_subtree(id);
            }
            Patch::Detach { id } => {
                // Unlink from parent without dropping the node — the
                // engine's Router subtree cache reattaches later via
                // Attach.
                if let Some(prev_parent) = self.parent_by_child.remove(id.as_ref()) {
                    if let Some(siblings) = self.children.get_mut(&prev_parent) {
                        siblings.retain(|c| c.as_str() != id.as_ref());
                    }
                }
                self.note_detached(id);
            }
            Patch::Attach {
                parent_id,
                id,
                before_id,
            } => {
                if self.would_cycle(parent_id, id) {
                    log::warn!("Attach of {id} under {parent_id} would create a cycle; skipping");
                    return;
                }
                // Defensive unlink, mirroring Insert/Move: a healthy
                // Attach targets a detached root (already out of every
                // children list), but a buggy host attaching a live
                // node must not leave it duplicated in its old parent.
                if let Some(prev_parent) = self.parent_by_child.get(id.as_ref()).cloned() {
                    if let Some(siblings) = self.children.get_mut(&prev_parent) {
                        siblings.retain(|c| c.as_str() != id.as_ref());
                    }
                }
                let siblings = self.children.entry(parent_id.to_string()).or_default();
                Self::insert_at(siblings, id.to_string(), before_id.as_deref());
                self.parent_by_child
                    .insert(id.to_string(), parent_id.to_string());
                self.clear_detached(id);
            }
            // Batch-scoped animation prelude: batch metadata, not a node
            // op — nothing to record in the tree. The animator consumes
            // it at batch head in `DesktopAnimator::ingest` (transaction-
            // scoped interpolation, Option D); if one reaches this raw
            // path (direct `apply` callers) it is structurally inert.
            Patch::BatchAnimation { .. } => {}
            // Template patches are lowered into plain Create+Insert runs
            // by the `TemplateExpander` in `flush_patches` before any
            // batch reaches the tree. One arriving here means the
            // expander passed it through (unknown template id / malformed
            // skeleton) — warn and skip, matching the expander's
            // never-panic degradation.
            Patch::RegisterTemplate { .. } | Patch::Instantiate { .. } => {
                log::warn!("unexpanded template patch reached Tree::apply; skipping");
            }
        }
    }

    /// Whether linking `id` under `parent_id` would put a cycle in the tree:
    /// the synthetic root never gets a parent, and a node never becomes its
    /// own ancestor. A cycle reachable from the root would send every
    /// recursive walk (layout, paint, accessibility) into unbounded
    /// recursion, so a hostile or buggy host's patch is refused instead.
    fn would_cycle(&self, parent_id: &str, id: &str) -> bool {
        if id == ROOT_ID {
            return true;
        }
        let mut cur = parent_id;
        // Bounded: an existing (unreachable) cycle cannot loop us forever.
        for _ in 0..=self.parent_by_child.len() {
            if cur == id {
                return true;
            }
            match self.parent_by_child.get(cur) {
                Some(p) => cur = p.as_str(),
                None => return false,
            }
        }
        true
    }

    /// Insert `id` into `siblings` before `before_id` (append when the
    /// anchor is absent). Callers must have unlinked `id` from its
    /// previous parent first (all patch handlers do, via the O(1)
    /// `parent_by_child` index) — the old per-call `retain` dedupe here
    /// made inserting N children under one parent O(N²), which showed
    /// up on every initial render of a long list.
    fn insert_at(siblings: &mut Vec<String>, id: String, before_id: Option<&str>) {
        debug_assert!(
            !siblings.contains(&id),
            "insert_at caller must unlink first"
        );
        match before_id {
            Some(before) => match siblings.iter().position(|c| c == before) {
                Some(idx) => siblings.insert(idx, id),
                None => siblings.push(id),
            },
            None => siblings.push(id),
        }
    }

    fn remove_subtree(&mut self, id: &str) {
        if let Some(children) = self.children.remove(id) {
            for child in &children {
                self.parent_by_child.remove(child);
                self.remove_subtree(child);
            }
        }
        if let Some(node) = self.nodes.remove(id) {
            self.count_node_removed(&node);
        }
    }

    /// Like [`Tree::remove_subtree`] but records every removed node id
    /// (root + descendants) into `out` so the caller can mirror the
    /// teardown into the Taffy tree.
    fn remove_subtree_collecting(&mut self, id: &str, out: &mut Vec<String>) {
        if let Some(children) = self.children.remove(id) {
            for child in &children {
                self.parent_by_child.remove(child);
                self.remove_subtree_collecting(child, out);
            }
        }
        if let Some(node) = self.nodes.remove(id) {
            self.count_node_removed(&node);
        }
        out.push(id.to_string());
    }

    /// Every node id inside a currently detached subtree (the Router
    /// keep-alive cache). `Detach` only unlinks the root from its
    /// parent — the subtree's own `children` edges stay intact, so a
    /// walk from each detached root covers it fully. Used by the
    /// window to suspend media playback in cached-off-screen routes.
    pub fn detached_node_ids(&self) -> std::collections::HashSet<String> {
        let mut ids = std::collections::HashSet::new();
        let mut stack: Vec<&str> = self.detached.iter().map(String::as_str).collect();
        while let Some(id) = stack.pop() {
            if !ids.insert(id.to_string()) {
                continue;
            }
            stack.extend(self.children_of(id).iter().map(String::as_str));
        }
        ids
    }

    /// Record `id` as a detached subtree root (most-recent last).
    fn note_detached(&mut self, id: &str) {
        self.detached.retain(|d| d != id);
        self.detached.push(id.to_string());
    }

    /// Drop `id` from the detached list — it's live again (Attach /
    /// Insert / Move) or gone (Remove).
    fn clear_detached(&mut self, id: &str) {
        if !self.detached.is_empty() {
            self.detached.retain(|d| d != id);
        }
    }

    /// Backstop against an unbounded detached arena. Tears down the
    /// oldest detached subtrees until at most `cap` remain, returning
    /// every removed node id so the caller can free the matching Taffy
    /// nodes. Returns empty in the common case (under cap).
    ///
    /// This should never fire in normal operation: the engine's Router
    /// keep-alive cache is itself a bounded LRU that emits `Remove` on
    /// eviction. It only catches a host that detaches without ever
    /// re-Attaching or Removing. Evicting a subtree the host still
    /// believes is cached makes a later `Attach` a no-op (that route
    /// renders blank until the host rebuilds it) — an acceptable
    /// degradation for an already-misbehaving server, and the reason
    /// the cap is set far above any sane Router LRU.
    pub fn evict_detached_over(&mut self, cap: usize) -> Vec<String> {
        let mut removed = Vec::new();
        while self.detached.len() > cap {
            let root = self.detached.remove(0);
            // Skip if it somehow became live without clearing the list.
            if self.parent_by_child.contains_key(&root) {
                continue;
            }
            self.remove_subtree_collecting(&root, &mut removed);
        }
        removed
    }

    /// Number of detached subtree roots currently held alive.
    pub fn detached_len(&self) -> usize {
        self.detached.len()
    }

    /// Apply a batch in order. Convenience wrapper.
    pub fn apply_batch(&mut self, patches: &[Patch]) {
        for p in patches {
            self.apply(p);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hypen_engine::Patch;
    use indexmap::IndexMap;
    use serde_json::{json, Value};
    use std::sync::Arc;

    /// Build an `Arc<IndexMap<String, Value>>` for `Patch::Create`'s `props`.
    fn props(entries: &[(&str, Value)]) -> Arc<IndexMap<String, Value>> {
        let mut map = IndexMap::new();
        for (k, v) in entries {
            map.insert((*k).to_string(), v.clone());
        }
        Arc::new(map)
    }

    fn create(id: &str, element_type: &str, entries: &[(&str, Value)]) -> Patch {
        Patch::Create {
            id: id.into(),
            element_type: element_type.to_string(),
            props: props(entries),
            semantics: None,
        }
    }

    fn insert(parent_id: &str, id: &str, before_id: Option<&str>) -> Patch {
        Patch::Insert {
            parent_id: parent_id.into(),
            id: id.into(),
            before_id: before_id.map(Into::into),
        }
    }

    fn move_patch(parent_id: &str, id: &str, before_id: Option<&str>) -> Patch {
        Patch::Move {
            parent_id: parent_id.into(),
            id: id.into(),
            before_id: before_id.map(Into::into),
        }
    }

    #[test]
    fn apply_create_then_insert_makes_root_child() {
        let mut tree = Tree::new();
        tree.apply(&create("a", "Text", &[("0", json!("Hello"))]));
        tree.apply(&insert(ROOT_ID, "a", None));

        assert_eq!(tree.root_children(), &["a".to_string()]);
        let node = tree.get("a").expect("node a should exist");
        assert_eq!(node.id, "a");
        assert_eq!(node.element_type, "Text");
        assert_eq!(node.props.get("0"), Some(&json!("Hello")));
    }

    #[test]
    fn insert_with_before_id_positions_correctly() {
        let mut tree = Tree::new();
        tree.apply(&create("a", "Text", &[]));
        tree.apply(&insert(ROOT_ID, "a", None));
        tree.apply(&create("b", "Text", &[]));
        tree.apply(&insert(ROOT_ID, "b", None));
        // Insert "c" before "b" — should land between a and b.
        tree.apply(&create("c", "Text", &[]));
        tree.apply(&insert(ROOT_ID, "c", Some("b")));

        assert_eq!(
            tree.root_children(),
            &["a".to_string(), "c".to_string(), "b".to_string()]
        );
    }

    #[test]
    fn insert_with_unknown_before_id_appends() {
        let mut tree = Tree::new();
        tree.apply(&create("a", "Text", &[]));
        tree.apply(&insert(ROOT_ID, "a", None));
        tree.apply(&create("b", "Text", &[]));
        // before_id refers to a sibling that doesn't exist — graceful append.
        tree.apply(&insert(ROOT_ID, "b", Some("ghost")));

        assert_eq!(tree.root_children(), &["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn set_prop_updates_existing_node_props() {
        let mut tree = Tree::new();
        tree.apply(&create("a", "Text", &[("0", json!("hi"))]));
        tree.apply(&Patch::SetProp {
            id: "a".into(),
            name: "color".into(),
            value: json!("red"),
        });

        let node = tree.get("a").expect("node a should exist");
        assert_eq!(node.props.get("color"), Some(&json!("red")));
        // Original prop should still be present.
        assert_eq!(node.props.get("0"), Some(&json!("hi")));
    }

    #[test]
    fn set_prop_on_unknown_node_is_a_noop() {
        let mut tree = Tree::new();
        // Should not panic; just logged.
        tree.apply(&Patch::SetProp {
            id: "ghost".into(),
            name: "color".into(),
            value: json!("red"),
        });
        assert!(tree.get("ghost").is_none());
    }

    #[test]
    fn remove_prop_removes_the_key() {
        let mut tree = Tree::new();
        tree.apply(&create("a", "Text", &[("color", json!("red"))]));
        tree.apply(&Patch::RemoveProp {
            id: "a".into(),
            name: "color".into(),
        });
        let node = tree.get("a").expect("node a should exist");
        assert!(!node.props.contains_key("color"));
    }

    #[test]
    fn remove_cascades_subtree() {
        // a -> b -> c
        let mut tree = Tree::new();
        tree.apply(&create("a", "Column", &[]));
        tree.apply(&insert(ROOT_ID, "a", None));
        tree.apply(&create("b", "Column", &[]));
        tree.apply(&insert("a", "b", None));
        tree.apply(&create("c", "Text", &[]));
        tree.apply(&insert("b", "c", None));

        // Sanity check the linkage before removal.
        assert_eq!(tree.children_of("a"), &["b".to_string()]);
        assert_eq!(tree.children_of("b"), &["c".to_string()]);

        tree.apply(&Patch::Remove {
            id: "a".into(),
            transition: false,
        });

        // Nodes are gone.
        assert!(tree.get("a").is_none());
        assert!(tree.get("b").is_none());
        assert!(tree.get("c").is_none());

        // Parent-child links are gone.
        assert!(tree.root_children().is_empty());
        assert!(tree.children_of("a").is_empty());
        assert!(tree.children_of("b").is_empty());
        assert!(tree.children_of("c").is_empty());
    }

    #[test]
    fn move_repositions_within_parent() {
        let mut tree = Tree::new();
        for id in ["a", "b", "c"] {
            tree.apply(&create(id, "Text", &[]));
            tree.apply(&insert(ROOT_ID, id, None));
        }
        assert_eq!(
            tree.root_children(),
            &["a".to_string(), "b".to_string(), "c".to_string()]
        );

        // Move "c" to before "a".
        tree.apply(&move_patch(ROOT_ID, "c", Some("a")));

        assert_eq!(
            tree.root_children(),
            &["c".to_string(), "a".to_string(), "b".to_string()]
        );
    }

    #[test]
    fn set_text_writes_to_prop_zero() {
        let mut tree = Tree::new();
        tree.apply(&create("a", "Text", &[("0", json!("old"))]));
        tree.apply(&Patch::SetText {
            id: "a".into(),
            text: "new".into(),
        });
        let node = tree.get("a").expect("node a should exist");
        assert_eq!(node.props.get("0"), Some(&json!("new")));
    }

    #[test]
    fn apply_batch_processes_in_order() {
        let mut tree = Tree::new();
        let batch = vec![
            create("a", "Column", &[]),
            insert(ROOT_ID, "a", None),
            create("b", "Text", &[("0", json!("child"))]),
            insert("a", "b", None),
            Patch::SetProp {
                id: "b".into(),
                name: "color".into(),
                value: json!("blue"),
            },
        ];
        tree.apply_batch(&batch);

        assert_eq!(tree.root_children(), &["a".to_string()]);
        assert_eq!(tree.children_of("a"), &["b".to_string()]);
        let b = tree.get("b").expect("node b should exist");
        assert_eq!(b.props.get("color"), Some(&json!("blue")));
        assert_eq!(b.props.get("0"), Some(&json!("child")));
    }

    #[test]
    fn detach_and_attach_are_currently_noops() {
        let mut tree = Tree::new();
        tree.apply(&create("a", "Column", &[]));
        tree.apply(&insert(ROOT_ID, "a", None));
        tree.apply(&create("b", "Text", &[]));
        tree.apply(&insert("a", "b", None));

        let root_before: Vec<String> = tree.root_children().to_vec();
        let a_children_before: Vec<String> = tree.children_of("a").to_vec();

        // Phase 4+ will implement these; currently they should be no-ops.
        tree.apply(&Patch::Detach { id: "b".into() });
        tree.apply(&Patch::Attach {
            parent_id: "a".into(),
            id: "b".into(),
            before_id: None,
        });

        assert_eq!(tree.root_children(), root_before.as_slice());
        assert_eq!(tree.children_of("a"), a_children_before.as_slice());
        assert!(tree.get("a").is_some());
        assert!(tree.get("b").is_some());
    }

    #[test]
    fn detached_node_ids_covers_whole_subtrees_and_clears_on_attach() {
        let mut tree = Tree::new();
        tree.apply(&create("route", "Column", &[]));
        tree.apply(&insert(ROOT_ID, "route", None));
        tree.apply(&create("vid", "Video", &[]));
        tree.apply(&insert("route", "vid", None));
        tree.apply(&create("other", "Text", &[]));
        tree.apply(&insert(ROOT_ID, "other", None));
        assert!(tree.detached_node_ids().is_empty());

        tree.apply(&Patch::Detach { id: "route".into() });
        let detached = tree.detached_node_ids();
        assert!(detached.contains("route"), "detached root included");
        assert!(
            detached.contains("vid"),
            "descendants of the detached root included"
        );
        assert!(!detached.contains("other"), "live siblings excluded");

        tree.apply(&Patch::Attach {
            parent_id: ROOT_ID.into(),
            id: "route".into(),
            before_id: None,
        });
        assert!(tree.detached_node_ids().is_empty(), "attach clears the set");
    }

    #[test]
    fn node_text_content_returns_prop_zero_string() {
        let mut tree = Tree::new();
        tree.apply(&create("a", "Text", &[("0", json!("hello world"))]));
        let node = tree.get("a").expect("node a should exist");
        assert_eq!(node.text_content().as_deref(), Some("hello world"));

        // Numeric prop "0" now stringifies for display — Profile-page
        // counts (`postsCount = Number(42)`) and any other scalar
        // bindings render their string form rather than nothing.
        tree.apply(&create("b", "Text", &[("0", json!(42))]));
        let node_b = tree.get("b").expect("node b should exist");
        assert_eq!(node_b.text_content().as_deref(), Some("42"));

        // Missing prop "0" should return None.
        tree.apply(&create("c", "Text", &[]));
        let node_c = tree.get("c").expect("node c should exist");
        assert!(node_c.text_content().is_none());
    }

    #[test]
    fn parent_of_tracks_inserts_moves_and_removes() {
        let mut tree = Tree::new();
        tree.apply(&create("col", "Column", &[]));
        tree.apply(&insert("root", "col", None));
        tree.apply(&create("a", "Text", &[("0", json!("a"))]));
        tree.apply(&insert("col", "a", None));
        assert_eq!(tree.parent_of("col"), Some("root"));
        assert_eq!(tree.parent_of("a"), Some("col"));

        // Move `a` under `root` directly.
        tree.apply(&Patch::Move {
            parent_id: "root".into(),
            id: "a".into(),
            before_id: None,
        });
        assert_eq!(tree.parent_of("a"), Some("root"));
        assert!(!tree.children_of("col").contains(&"a".to_string()));

        // Remove drops the parent_by_child entry.
        tree.apply(&Patch::Remove {
            id: "a".into(),
            transition: false,
        });
        assert_eq!(tree.parent_of("a"), None);
    }

    #[test]
    fn detach_attach_round_trips_parent_index() {
        let mut tree = Tree::new();
        tree.apply(&create("col", "Column", &[]));
        tree.apply(&insert("root", "col", None));
        tree.apply(&create("post", "Container", &[]));
        tree.apply(&insert("col", "post", None));
        assert_eq!(tree.parent_of("post"), Some("col"));

        tree.apply(&Patch::Detach { id: "post".into() });
        assert_eq!(tree.parent_of("post"), None);
        assert!(!tree.children_of("col").contains(&"post".to_string()));
        // Node itself stays alive — Router cache keeps the subtree.
        assert!(tree.get("post").is_some());

        tree.apply(&Patch::Attach {
            parent_id: "col".into(),
            id: "post".into(),
            before_id: None,
        });
        assert_eq!(tree.parent_of("post"), Some("col"));
        assert!(tree.children_of("col").contains(&"post".to_string()));
    }

    #[test]
    fn attach_and_remove_clear_the_detached_backstop() {
        let mut tree = Tree::new();
        tree.apply(&create("col", "Column", &[]));
        tree.apply(&insert("root", "col", None));
        tree.apply(&create("a", "Container", &[]));
        tree.apply(&insert("col", "a", None));
        tree.apply(&create("b", "Container", &[]));
        tree.apply(&insert("col", "b", None));

        tree.apply(&Patch::Detach { id: "a".into() });
        tree.apply(&Patch::Detach { id: "b".into() });
        assert_eq!(tree.detached_len(), 2);

        // Reattaching one and removing the other both drop their
        // detached-list entries so the backstop doesn't double-count.
        tree.apply(&Patch::Attach {
            parent_id: "col".into(),
            id: "a".into(),
            before_id: None,
        });
        tree.apply(&Patch::Remove {
            id: "b".into(),
            transition: false,
        });
        assert_eq!(tree.detached_len(), 0);
    }

    #[test]
    fn paint_gate_counters_track_every_mutation_path() {
        let mut tree = Tree::new();
        assert!(!tree.has_opacity_props() && !tree.has_transform_props());

        // Create with a gate prop counts; variant decorations count too.
        tree.apply(&create("a", "Container", &[("opacity", json!(0.5))]));
        tree.apply(&create("b", "Container", &[("translateX@md.0", json!(4))]));
        assert!(tree.has_opacity_props() && tree.has_transform_props());

        // SetProp adds only on a NEW key; overwrites don't double-count.
        tree.apply(&Patch::SetProp {
            id: "a".into(),
            name: "scale".into(),
            value: json!(1.2),
        });
        tree.apply(&Patch::SetProp {
            id: "a".into(),
            name: "scale".into(),
            value: json!(1.4),
        });
        // RemoveProp decrements; a second remove of the same key doesn't.
        tree.apply(&Patch::RemoveProp {
            id: "a".into(),
            name: "scale".into(),
        });
        tree.apply(&Patch::RemoveProp {
            id: "a".into(),
            name: "scale".into(),
        });
        assert!(tree.has_transform_props(), "b's translateX still live");

        // Raw animator writes and removals balance.
        tree.set_prop_raw("a", "rotate", json!(45.0));
        tree.remove_prop_raw("a", "rotate");
        tree.remove_prop_raw("a", "rotate");

        // Re-Create replacing a node forgets its old props.
        tree.apply(&create("a", "Container", &[]));
        assert!(!tree.has_opacity_props(), "replaced node's opacity gone");

        // Subtree teardown forgets descendants' props.
        tree.apply(&insert(ROOT_ID, "b", None));
        tree.apply(&Patch::Remove {
            id: "b".into(),
            transition: false,
        });
        assert!(
            !tree.has_transform_props(),
            "removed subtree's transform gone"
        );
    }

    #[test]
    fn evict_detached_over_tears_down_oldest_subtrees() {
        let mut tree = Tree::new();
        tree.apply(&create("col", "Column", &[]));
        tree.apply(&insert("root", "col", None));

        // Detach 5 single-child subtrees: parent `pN` with child `cN`.
        for i in 0..5 {
            let p = format!("p{i}");
            let c = format!("c{i}");
            tree.apply(&create(&p, "Container", &[]));
            tree.apply(&insert("col", &p, None));
            tree.apply(&create(&c, "Text", &[("0", json!("x"))]));
            tree.apply(&insert(&p, &c, None));
            tree.apply(&Patch::Detach {
                id: p.as_str().into(),
            });
        }
        assert_eq!(tree.detached_len(), 5);

        // Keep at most 2 — the 3 oldest roots (p0..p2) and their
        // children get torn down; the returned ids cover both.
        let removed = tree.evict_detached_over(2);
        assert_eq!(tree.detached_len(), 2);
        for i in 0..3 {
            assert!(tree.get(&format!("p{i}")).is_none(), "p{i} freed");
            assert!(tree.get(&format!("c{i}")).is_none(), "c{i} freed");
            assert!(removed.contains(&format!("p{i}")));
            assert!(removed.contains(&format!("c{i}")));
        }
        // The two most-recently-detached survive for re-Attach.
        assert!(tree.get("p3").is_some());
        assert!(tree.get("p4").is_some());

        // Under-cap eviction is a no-op.
        assert!(tree.evict_detached_over(2).is_empty());
    }

    #[test]
    fn hostile_reparenting_never_creates_a_cycle() {
        let mut tree = Tree::new();
        tree.apply(&create("a", "Column", &[]));
        tree.apply(&create("b", "Column", &[]));
        tree.apply(&insert(ROOT_ID, "a", None));
        tree.apply(&insert("a", "b", None));
        // The root under its own descendant, a node under itself, a node
        // under its own child: each refused, the tree unchanged.
        tree.apply(&insert("b", ROOT_ID, None));
        tree.apply(&insert("a", "a", None));
        tree.apply(&move_patch("b", "a", None));
        tree.apply(&Patch::Attach {
            parent_id: "b".into(),
            id: "a".into(),
            before_id: None,
        });
        assert_eq!(tree.root_children(), ["a".to_string()]);
        assert_eq!(tree.children_of("a"), ["b".to_string()]);
        assert!(tree.children_of("b").is_empty());
        // Legitimate moves still work.
        tree.apply(&move_patch(ROOT_ID, "b", None));
        assert_eq!(tree.root_children(), ["a".to_string(), "b".to_string()]);
    }
}
