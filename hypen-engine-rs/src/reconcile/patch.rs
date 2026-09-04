use super::tree::ResolvedProps;
use crate::ir::{NodeId, Semantics};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use slotmap::Key;
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;

/// Serde shim so `ResolvedProps` (`Arc<IndexMap<...>>`) serializes exactly
/// as its inner map does. Predates the crate enabling serde's `rc` feature
/// (for the `Arc<str>` id fields), whose `Arc<T>` impls are equivalent;
/// kept explicit so the wire contract doesn't hinge on a feature flag.
/// Wire format is indistinguishable from a bare `IndexMap<String, Value>`.
mod resolved_props_serde {
    use super::ResolvedProps;
    use indexmap::IndexMap;
    use std::sync::Arc;

    pub fn serialize<S>(value: &ResolvedProps, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serde::Serialize::serialize(&**value, serializer)
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<ResolvedProps, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        use serde::Deserialize;
        IndexMap::deserialize(deserializer).map(Arc::new)
    }
}

/// Serde helper: skip a boolean flag when `false` so patches that don't set
/// it stay byte-identical to the pre-flag wire format.
fn is_false(value: &bool) -> bool {
    !*value
}

/// Cap on the per-thread id-string cache in [`node_id_str`]. When the map
/// grows past this it is cleared wholesale: ids are cheap to re-format, so
/// occasionally re-paying the formatting cost for live ids beats tracking
/// LRU order per lookup — and unbounded growth across a long session (ids
/// are never reused once their slot version bumps) is not acceptable.
const ID_STR_CACHE_CAP: usize = 262_144;

thread_local! {
    /// Memoized formatted id per `NodeId` FFI value, shared into patches by
    /// refcount. A node's id is mentioned in many patches over its lifetime
    /// (Create, Insert as child, Insert as parent of each child, SetProp,
    /// Move, Remove, Instantiate nodes lists...) — formatting it once and
    /// Arc-cloning thereafter removes a heap allocation per mention.
    ///
    /// Thread-local rather than global: WASM (the hot deployment target) is
    /// single-threaded so this IS the one cache; on native each thread just
    /// keeps its own copy, which is merely less shared, still correct.
    static ID_STR_CACHE: RefCell<HashMap<u64, Arc<str>>> = RefCell::new(HashMap::new());
}

/// Stable, compact serialization for NodeId.
///
/// Returns a decimal string derived directly from the slotmap key's FFI
/// representation (`KeyData::as_ffi()`), which packs the slot's index and
/// version into a `u64`. The result is deterministic per `NodeId` without
/// any cross-thread shared state — no mutex, no atomic counter; formatted
/// strings are memoized per thread (see [`ID_STR_CACHE`]) and shared by
/// refcount.
///
/// # Stability
///
/// This is an internal implementation detail. External consumers should
/// treat node ID strings in patches as opaque identifiers. The encoding
/// is stable within a process run but may change between engine versions.
#[doc(hidden)]
pub fn node_id_str(id: NodeId) -> Arc<str> {
    let ffi = id.data().as_ffi();
    ID_STR_CACHE.with(|cache| {
        let mut cache = cache.borrow_mut();
        if let Some(s) = cache.get(&ffi) {
            return Arc::clone(s);
        }
        if cache.len() >= ID_STR_CACHE_CAP {
            cache.clear();
        }
        let s: Arc<str> = Arc::from(ffi.to_string());
        cache.insert(ffi, Arc::clone(&s));
        s
    })
}

/// Platform-agnostic patch operations for updating the UI.
///
/// Patches are the **wire protocol** between the Hypen engine and platform
/// renderers (DOM, Canvas, iOS UIKit, Android Views). Every mutation to the
/// UI tree is expressed as an ordered sequence of `Patch` values.
///
/// # Serialization
///
/// Patches serialize to JSON with a `"type"` discriminator and **camelCase**
/// field names for direct JavaScript consumption:
///
/// ```json
/// {"type": "create", "id": "1", "elementType": "Text", "props": {"0": "Hello"}}
/// {"type": "insert", "parentId": "root", "id": "1", "beforeId": null}
/// ```
///
/// # Node IDs
///
/// Node IDs are opaque string identifiers (currently compact integers like
/// `"1"`, `"42"`). Renderers must treat them as opaque — the format may
/// change between versions. The special parent ID `"root"` refers to the
/// renderer's root container.
///
/// # Ordering
///
/// Within a single render cycle, patches are ordered such that:
/// 1. `Create` always precedes `Insert` for the same node
/// 2. `SetProp`/`SetText` follow `Create` for new nodes
/// 3. `Remove` is always the last operation for a given node
/// 4. `Insert`/`Move` specify position via `before_id` (`None` = append)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Patch {
    /// Create a new element node with initial properties.
    ///
    /// The renderer should allocate a platform-native element and store it by
    /// `id`. The node is not yet visible — a subsequent `Insert` attaches it.
    ///
    /// `props` is `Arc<IndexMap<...>>` so emitting a `Create` for an existing
    /// `InstanceNode` is an Arc clone rather than a deep copy of the map.
    /// Wire format is unchanged — the custom serde shim serializes the
    /// inner map directly without exposing the Arc.
    #[serde(rename_all = "camelCase")]
    Create {
        /// Opaque node identifier. `Arc<str>` so the memoized formatted id
        /// (see [`node_id_str`]) is shared by refcount instead of reallocated
        /// per mention; serde (with the `rc` feature) serializes it exactly
        /// as a plain string, so the wire format is unchanged.
        id: Arc<str>,
        /// Element type name (e.g. `"Text"`, `"Column"`, `"Button"`)
        element_type: String,
        /// Initial properties. Key `"0"` is the positional text content.
        #[serde(with = "resolved_props_serde")]
        props: ResolvedProps,
        /// Accessibility semantics derived for this node, if any. Omitted from
        /// the wire entirely when `None`, so the format is unchanged for nodes
        /// with no derivable semantics. Renderers translate it to their native
        /// accessibility API (ARIA, Compose semantics, SwiftUI traits).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        semantics: Option<Semantics>,
    },

    /// Replace a node's accessibility semantics after a reactive change.
    ///
    /// Emitted by the reconciler when a dirty re-render produces a different
    /// resolved [`Semantics`] than the node last had — a templated accessible
    /// name (`Button("@{state.label}")`), bound self-state
    /// (`.expanded(@state.open)`), or bound `checked` whose source path
    /// changed. Carries the **complete** block (not a field delta) so the
    /// renderer re-applies idempotently with the same translation it ran at
    /// create; a dropped field must clear the corresponding native attribute.
    /// `semantics: None` means the node lost all derivable a11y → clear
    /// everything. Static-only trees never produce this patch.
    #[serde(rename_all = "camelCase")]
    SetSemantics {
        id: Arc<str>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        semantics: Option<Semantics>,
    },

    /// Update a single property on an existing node.
    #[serde(rename_all = "camelCase")]
    SetProp {
        id: Arc<str>,
        /// Property name (e.g. `"color"`, `"fontSize"`)
        name: String,
        /// New value
        value: Value,
    },

    /// Remove a property from an existing node (revert to default).
    #[serde(rename_all = "camelCase")]
    RemoveProp {
        id: Arc<str>,
        /// Property name to remove
        name: String,
    },

    /// Set the text content of a node.
    ///
    /// **Reserved for future use — not currently emitted by the engine.**
    /// The reconciler represents text changes as `SetProp { name: "0", ... }`
    /// (the positional content slot), so no production code path constructs
    /// a `SetText` patch today. Renderers must still handle this variant for
    /// forward compatibility; removing it would break the wire format.
    #[serde(rename_all = "camelCase")]
    SetText {
        id: Arc<str>,
        /// New text content
        text: String,
    },

    /// Insert a node as a child of `parent_id`.
    ///
    /// If `before_id` is `Some`, insert before that sibling. If `None`, append.
    #[serde(rename_all = "camelCase")]
    Insert {
        /// Parent node ID, or `"root"` for the root container
        parent_id: Arc<str>,
        id: Arc<str>,
        /// Insert before this sibling, or `null` to append
        before_id: Option<Arc<str>>,
    },

    /// Move an already-inserted node to a new position within its parent.
    #[serde(rename_all = "camelCase")]
    Move {
        parent_id: Arc<str>,
        id: Arc<str>,
        before_id: Option<Arc<str>>,
    },

    /// Remove a node from the tree and deallocate it.
    ///
    /// `transition: true` marks the **root** of a subtree whose node carried
    /// an `"__anim.exit"` spec in its resolved props: the renderer may play
    /// the exit animation and finalize the native teardown itself. The
    /// engine-side node is dead the moment the patch is emitted either way —
    /// there is no acknowledgement round-trip; the renderer owns the corpse.
    ///
    /// # Ordering contract
    ///
    /// For an animated subtree the flagged root `Remove` is emitted FIRST,
    /// followed by its descendants as plain Removes — the renderer must
    /// learn the subtree is exiting before descendant teardown arrives.
    /// Descendants are always plain regardless of their own exit specs
    /// (parent-remove-wins). Non-animated subtrees keep post-order
    /// (children before parents), byte-identical to the pre-flag protocol.
    ///
    /// The field is skipped when `false`, so renderers unaware of the flag
    /// see an unchanged wire format and snap — graceful degradation.
    #[serde(rename_all = "camelCase")]
    Remove {
        id: Arc<str>,
        #[serde(default, skip_serializing_if = "is_false")]
        transition: bool,
    },

    /// Detach a subtree from its parent without tearing it down.
    ///
    /// The renderer must **unlink** `id` from its parent's children list
    /// but keep the native element and its descendants alive (same
    /// identifier, same props, same children). A subsequent `Attach`
    /// can reinsert the subtree with zero rebuild work. If `Remove`
    /// arrives instead, the subtree is torn down normally.
    ///
    /// Used by the Router reconciler to cache off-screen route
    /// subtrees, so navigating back to a previously-visited route
    /// skips both the engine's keyed-diff work and the renderer's
    /// element-creation work.
    #[serde(rename_all = "camelCase")]
    Detach { id: Arc<str> },

    /// Reattach a previously-`Detach`ed subtree to a parent.
    ///
    /// The `id` must reference a still-alive native element that was
    /// detached earlier in the session. If `before_id` is `Some`, the
    /// subtree is inserted before that sibling; `None` appends.
    #[serde(rename_all = "camelCase")]
    Attach {
        /// Parent node ID, or `"root"` for the root container
        parent_id: Arc<str>,
        id: Arc<str>,
        /// Insert before this sibling, or `null` to append
        before_id: Option<Arc<str>>,
    },

    /// Register a reusable element template with the consumer.
    ///
    /// Emitted at most once per (template content) per session, always —
    /// template patches are the one wire format, with no capability
    /// negotiation. Consumers that can't exploit template cloning lower
    /// the stream back to plain `Create`+`Insert` runs via
    /// `portable::TemplateExpander` (the UniFFI, WASI, and remote-
    /// streaming boundaries do this internally). `root` is a plain JSON
    /// tree: `{elementType, props, children: [...]}` containing
    /// only statically-resolvable props; every dynamic (item- or
    /// state-bound) prop arrives per instance via `Instantiate.subs`.
    #[serde(rename_all = "camelCase")]
    RegisterTemplate {
        /// Opaque template identifier, referenced by `Instantiate`.
        template_id: String,
        /// Static skeleton tree (see above).
        root: Value,
    },

    /// Instantiate a registered template as one new subtree.
    ///
    /// Replaces the run of `Create`+`Insert` patches a template-shaped
    /// subtree would otherwise emit. `nodes` assigns an id to every element
    /// of the template in depth-first order (the renderer clones its
    /// prototype and walks the clone in the same order); `subs` carries
    /// `[nodeIndex, prop, value]` triples for every dynamic prop, applied
    /// exactly as a `SetProp` would be; `semantics` carries
    /// `[nodeIndex, block]` pairs for nodes with accessibility semantics.
    /// The subtree is inserted under `parent_id` before `before_id`
    /// (append when null) — one patch, one insertion.
    #[serde(rename_all = "camelCase")]
    Instantiate {
        /// Which registered template to clone.
        template_id: String,
        /// Parent to insert the instance under (`"root"` allowed).
        parent_id: Arc<str>,
        /// Insert-before anchor; `None` = append.
        before_id: Option<Arc<str>>,
        /// Per-element node ids, depth-first over the template.
        nodes: Vec<Arc<str>>,
        /// Dynamic prop substitutions: `[nodeIndex, propName, value]`.
        subs: Vec<(usize, String, Value)>,
        /// Accessibility semantics per node index, when present. Serialized
        /// as `nodeSemantics` so the name can't collide with the singular
        /// `semantics` block other patch kinds carry.
        #[serde(
            rename = "nodeSemantics",
            skip_serializing_if = "Vec::is_empty",
            default
        )]
        semantics: Vec<(usize, Semantics)>,
    },

    /// Batch-scoped animation prelude (Option D cheap subset — transaction-
    /// scoped animation).
    ///
    /// Emitted as the **FIRST** patch of a render cycle whose triggering
    /// state update carried an animation context (`update_state` /
    /// `update_state_sparse` with `animation: Some(spec)`). It addresses no
    /// node — it scopes the *batch*: renderers that understand it animate
    /// every prop change in the patches that follow using `spec`
    /// (precedence: batch spec > node `.transition` default > none).
    ///
    /// Additive protocol: renderers that don't know the type ignore it and
    /// snap — the rest of the batch is wire-identical to an unstamped one.
    /// A cycle that produces no patches emits no prelude either (no stamp
    /// without patches).
    ///
    /// `spec` is always a JSON object by the time it reaches the wire — the
    /// engine normalizes a bare curve string (`"spring"`) into
    /// `{"curve": "spring", "duration": 250}` and fills a missing
    /// `duration` with 250. Unknown fields pass through untouched;
    /// renderers own interpretation.
    #[serde(rename_all = "camelCase")]
    BatchAnimation {
        /// Animation spec object, e.g. `{"curve": "spring", "duration": 250}`
        spec: Value,
    },
}

impl Patch {
    /// Construct a `Create` patch. `props` must already be an
    /// `Arc`-wrapped resolved-prop map; callers holding a bare
    /// `IndexMap` wrap it explicitly via `Arc::new(...)`. `semantics` is the
    /// node's derived accessibility block, or `None` when it has none.
    pub fn create(
        id: NodeId,
        element_type: String,
        props: ResolvedProps,
        semantics: Option<Semantics>,
    ) -> Self {
        Self::Create {
            id: node_id_str(id),
            element_type,
            props,
            semantics,
        }
    }

    /// Construct a `SetSemantics` patch carrying the node's full updated
    /// (already-resolved) semantics block, or `None` to clear.
    pub fn set_semantics(id: NodeId, semantics: Option<Semantics>) -> Self {
        Self::SetSemantics {
            id: node_id_str(id),
            semantics,
        }
    }

    pub fn set_prop(id: NodeId, name: String, value: Value) -> Self {
        Self::SetProp {
            id: node_id_str(id),
            name,
            value,
        }
    }

    pub fn remove_prop(id: NodeId, name: String) -> Self {
        Self::RemoveProp {
            id: node_id_str(id),
            name,
        }
    }

    pub fn set_text(id: NodeId, text: String) -> Self {
        Self::SetText {
            id: node_id_str(id),
            text,
        }
    }

    pub fn insert(parent_id: NodeId, id: NodeId, before_id: Option<NodeId>) -> Self {
        Self::Insert {
            parent_id: node_id_str(parent_id),
            id: node_id_str(id),
            before_id: before_id.map(node_id_str),
        }
    }

    /// Insert a root node into the "root" container
    pub fn insert_root(id: NodeId) -> Self {
        Self::Insert {
            parent_id: "root".into(),
            id: node_id_str(id),
            before_id: None,
        }
    }

    pub fn move_node(parent_id: NodeId, id: NodeId, before_id: Option<NodeId>) -> Self {
        Self::Move {
            parent_id: node_id_str(parent_id),
            id: node_id_str(id),
            before_id: before_id.map(node_id_str),
        }
    }

    pub fn remove(id: NodeId) -> Self {
        Self::Remove {
            id: node_id_str(id),
            transition: false,
        }
    }

    /// Construct a `Remove` flagged with `transition: true` — the root of an
    /// exiting subtree. See the ordering contract on [`Patch::Remove`].
    pub fn remove_with_transition(id: NodeId) -> Self {
        Self::Remove {
            id: node_id_str(id),
            transition: true,
        }
    }

    /// Emit a `Detach` patch for the given node.
    ///
    /// Instructs the renderer to unlink the subtree rooted at `id`
    /// from its parent without destroying the native element. A
    /// subsequent `Attach` can reinsert it.
    pub fn detach(id: NodeId) -> Self {
        Self::Detach {
            id: node_id_str(id),
        }
    }

    /// Emit an `Attach` patch to reinsert a previously-detached node
    /// as a child of `parent_id` (with optional `before_id` position).
    pub fn attach(parent_id: NodeId, id: NodeId, before_id: Option<NodeId>) -> Self {
        Self::Attach {
            parent_id: node_id_str(parent_id),
            id: node_id_str(id),
            before_id: before_id.map(node_id_str),
        }
    }

    /// Construct the batch-scoped animation prelude carrying an
    /// already-normalized spec object. See [`Patch::BatchAnimation`] for
    /// the batch-stamping contract.
    pub fn batch_animation(spec: Value) -> Self {
        Self::BatchAnimation { spec }
    }

    /// Emit an `Attach` patch targeting the `"root"` container. Used when
    /// a control-flow container (Router/Conditional) sitting at the IR
    /// root caches and re-attaches its matched route's subtree — the
    /// attach has to bypass the container's own (never-created) NodeId.
    pub fn attach_root(id: NodeId, before_id: Option<NodeId>) -> Self {
        Self::Attach {
            parent_id: "root".into(),
            id: node_id_str(id),
            before_id: before_id.map(node_id_str),
        }
    }
}
