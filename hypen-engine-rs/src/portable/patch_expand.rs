//! Template-patch expansion.
//!
//! The engine always emits `RegisterTemplate`/`Instantiate` for plannable
//! iterable rows — that IS the wire format. Boundaries whose consumers
//! cannot exploit template cloning (UniFFI, WASI, remote streaming) lower
//! the stream back into the exact `Create`+`Insert` run the pre-template
//! wire carried, using [`TemplateExpander`]. The expansion is canonical:
//! this file is the single source of truth, mirrored line-for-line by the
//! TypeScript implementation in `hypen-web/packages/core`.
//!
//! Unlike the rest of `portable`, the expander is *stateful*: registered
//! skeletons persist for the lifetime of a session (a `RegisterTemplate`
//! goes over the wire once, then every later batch's `Instantiate`s
//! reference it), so each boundary owns one `TemplateExpander` per engine
//! session.
//!
//! # Expansion contract
//!
//! For each `Instantiate`, walk the registered skeleton in DFS preorder
//! with counter `i`; the element's id is `nodes[i]`. Emit, per element:
//! `Create { id, elementType, props, semantics }` immediately followed by
//! `Insert` — the same interleaved preorder run
//! `reconcile::diff::create_element_node` produces. `Create.props` is the
//! skeleton node's static props merged with the `subs` entries for index
//! `i` (subs win on key collision; in practice disjoint — the skeleton
//! excludes dynamic keys). Engine-internal props were already stripped
//! from both sides when the template was planned, so the expander never
//! re-filters. The root's `Insert` uses the `Instantiate`'s
//! `parent_id`/`before_id`; every other element inserts under its
//! template-parent's assigned id with `before_id: None` (append).
//!
//! `RegisterTemplate` is consumed (stored) and dropped from the output.
//! An `Instantiate` that can't be expanded — unknown template id, or a
//! node-count mismatch against the skeleton — passes through unchanged
//! with a warning, never a panic. A malformed skeleton also passes its
//! `RegisterTemplate` through, so a downstream consumer that does speak
//! templates still receives the pair intact. All other patch kinds pass
//! through untouched, order preserved.

use crate::ir::Semantics;
use crate::logger::LogScope;
use crate::reconcile::Patch;
use indexmap::IndexMap;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;

/// One element of a parsed skeleton tree.
#[derive(Debug, Clone)]
struct SkeletonNode {
    element_type: String,
    /// Static props, in skeleton order.
    props: Vec<(String, Value)>,
    children: Vec<SkeletonNode>,
}

impl SkeletonNode {
    fn count(&self) -> usize {
        1 + self.children.iter().map(SkeletonNode::count).sum::<usize>()
    }
}

/// Parse a `RegisterTemplate.root` payload
/// (`{elementType, props, children: [...]}`). `None` = malformed.
fn parse_skeleton(value: &Value) -> Option<SkeletonNode> {
    let obj = value.as_object()?;
    let element_type = obj.get("elementType")?.as_str()?.to_string();
    let props = match obj.get("props") {
        None => Vec::new(),
        Some(Value::Object(map)) => map.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
        Some(_) => return None,
    };
    let children = match obj.get("children") {
        None => Vec::new(),
        Some(Value::Array(items)) => items
            .iter()
            .map(parse_skeleton)
            .collect::<Option<Vec<_>>>()?,
        Some(_) => return None,
    };
    Some(SkeletonNode {
        element_type,
        props,
        children,
    })
}

/// Lowers template patches (`RegisterTemplate`/`Instantiate`) back into the
/// plain `Create`+`Insert` runs they replace. One instance per engine
/// session per boundary — see the module docs for the full contract.
#[derive(Debug, Default)]
pub struct TemplateExpander {
    /// Registered skeletons with their precomputed element counts.
    templates: HashMap<String, (SkeletonNode, usize)>,
}

impl TemplateExpander {
    pub fn new() -> Self {
        Self::default()
    }

    /// Store a skeleton for later `Instantiate` expansion. Returns `false`
    /// (and warns) when the skeleton is malformed and was not stored.
    pub fn register(&mut self, template_id: &str, root: &Value) -> bool {
        match parse_skeleton(root) {
            Some(skeleton) => {
                let count = skeleton.count();
                self.templates
                    .insert(template_id.to_string(), (skeleton, count));
                true
            }
            None => {
                crate::log_warn!(
                    LogScope::Engine,
                    "template expander: malformed skeleton for template '{}'; passing template patches through unexpanded",
                    template_id
                );
                false
            }
        }
    }

    /// Process one patch batch: consume `RegisterTemplate`s, expand
    /// `Instantiate`s in place, pass every other patch through untouched.
    /// Order is preserved.
    pub fn expand(&mut self, patches: Vec<Patch>) -> Vec<Patch> {
        if !patches.iter().any(|p| {
            matches!(
                p,
                Patch::RegisterTemplate { .. } | Patch::Instantiate { .. }
            )
        }) {
            return patches;
        }

        let mut out = Vec::with_capacity(patches.len());
        for patch in patches {
            match patch {
                Patch::RegisterTemplate { template_id, root } => {
                    if !self.register(&template_id, &root) {
                        out.push(Patch::RegisterTemplate { template_id, root });
                    }
                }
                Patch::Instantiate {
                    template_id,
                    parent_id,
                    before_id,
                    nodes,
                    subs,
                    semantics,
                } => {
                    let known = self
                        .templates
                        .get(&template_id)
                        .map(|(_, count)| *count == nodes.len());
                    match known {
                        Some(true) => {
                            let (skeleton, _) = &self.templates[&template_id];
                            expand_instantiate(
                                skeleton, &parent_id, before_id, &nodes, subs, semantics, &mut out,
                            );
                        }
                        Some(false) => {
                            crate::log_warn!(
                                LogScope::Engine,
                                "template expander: Instantiate for '{}' carries {} node ids but the skeleton has {} elements; passing through",
                                template_id,
                                nodes.len(),
                                self.templates[&template_id].1
                            );
                            out.push(Patch::Instantiate {
                                template_id,
                                parent_id,
                                before_id,
                                nodes,
                                subs,
                                semantics,
                            });
                        }
                        None => {
                            crate::log_warn!(
                                LogScope::Engine,
                                "template expander: Instantiate for unknown template '{}'; passing through",
                                template_id
                            );
                            out.push(Patch::Instantiate {
                                template_id,
                                parent_id,
                                before_id,
                                nodes,
                                subs,
                                semantics,
                            });
                        }
                    }
                }
                other => out.push(other),
            }
        }
        out
    }
}

/// Per-instance expansion state shared by the preorder walk.
struct InstanceCtx<'a> {
    /// Per-element ids, DFS preorder over the skeleton.
    nodes: &'a [Arc<str>],
    /// Dynamic props grouped by element index; taken as visited.
    subs_by_node: HashMap<usize, Vec<(String, Value)>>,
    /// Semantics blocks by element index; taken as visited.
    semantics_by_node: HashMap<usize, Semantics>,
}

/// Emit the interleaved `Create`+`Insert` preorder run for one instance.
/// Caller guarantees `nodes.len()` equals the skeleton's element count.
fn expand_instantiate(
    skeleton: &SkeletonNode,
    parent_id: &Arc<str>,
    before_id: Option<Arc<str>>,
    nodes: &[Arc<str>],
    subs: Vec<(usize, String, Value)>,
    semantics: Vec<(usize, Semantics)>,
    out: &mut Vec<Patch>,
) {
    let mut subs_by_node: HashMap<usize, Vec<(String, Value)>> = HashMap::new();
    for (index, key, value) in subs {
        subs_by_node.entry(index).or_default().push((key, value));
    }
    let mut ctx = InstanceCtx {
        nodes,
        subs_by_node,
        semantics_by_node: semantics.into_iter().collect(),
    };

    fn walk(
        node: &SkeletonNode,
        dfs: &mut usize,
        parent_id: &Arc<str>,
        before_id: Option<Arc<str>>,
        ctx: &mut InstanceCtx,
        out: &mut Vec<Patch>,
    ) {
        let my_index = *dfs;
        *dfs += 1;
        let id = ctx.nodes[my_index].clone();

        let mut props: IndexMap<String, Value> = IndexMap::with_capacity(node.props.len());
        for (key, value) in &node.props {
            props.insert(key.clone(), value.clone());
        }
        // Dynamic props travel per instance; they win on (theoretical)
        // key collision because they carry the instance's resolved value.
        if let Some(node_subs) = ctx.subs_by_node.remove(&my_index) {
            for (key, value) in node_subs {
                props.insert(key, value);
            }
        }

        out.push(Patch::Create {
            id: id.clone(),
            element_type: node.element_type.clone(),
            props: Arc::new(props),
            semantics: ctx.semantics_by_node.remove(&my_index),
        });
        out.push(Patch::Insert {
            parent_id: Arc::clone(parent_id),
            id: id.clone(),
            before_id,
        });

        for child in &node.children {
            // Non-root elements always append under their parent.
            walk(child, dfs, &id, None, ctx, out);
        }
    }

    let mut dfs = 0;
    walk(skeleton, &mut dfs, parent_id, before_id, &mut ctx, out);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn skeleton_row() -> Value {
        // Row(gap: 8) { Text(fontSize: 14) Text() } — index 0 = Row,
        // 1 = first Text, 2 = second Text (DFS preorder).
        json!({
            "elementType": "Row",
            "props": {"gap": 8},
            "children": [
                {"elementType": "Text", "props": {"fontSize": 14}, "children": []},
                {"elementType": "Text", "props": {}, "children": []},
            ],
        })
    }

    fn register(id: &str, root: Value) -> Patch {
        Patch::RegisterTemplate {
            template_id: id.to_string(),
            root,
        }
    }

    fn instantiate(
        id: &str,
        parent: &str,
        before: Option<&str>,
        nodes: &[&str],
        subs: Vec<(usize, &str, Value)>,
        semantics: Vec<(usize, Semantics)>,
    ) -> Patch {
        Patch::Instantiate {
            template_id: id.to_string(),
            parent_id: parent.into(),
            before_id: before.map(Into::into),
            nodes: nodes.iter().copied().map(Into::into).collect(),
            subs: subs
                .into_iter()
                .map(|(i, k, v)| (i, k.to_string(), v))
                .collect(),
            semantics,
        }
    }

    /// The full contract on one instance: interleaved C/I preorder, merged
    /// props, root anchored at the Instantiate's parent/before, children
    /// appended under their template parent, semantics on the right node.
    #[test]
    fn expands_to_interleaved_preorder_run() {
        let mut expander = TemplateExpander::new();
        let sem = Semantics {
            name: Some("first".to_string()),
            ..Default::default()
        };
        let out = expander.expand(vec![
            register("t1", skeleton_row()),
            instantiate(
                "t1",
                "7",
                Some("42"),
                &["10", "11", "12"],
                vec![(1, "0", json!("Hello"))],
                vec![(1, sem.clone())],
            ),
        ]);

        assert_eq!(out.len(), 6, "3 elements -> 3 Creates + 3 Inserts: {out:?}");
        match &out[0] {
            Patch::Create {
                id,
                element_type,
                props,
                semantics,
            } => {
                assert_eq!(id.as_ref(), "10");
                assert_eq!(element_type, "Row");
                assert_eq!(props.get("gap"), Some(&json!(8)));
                assert_eq!(props.len(), 1);
                assert!(semantics.is_none());
            }
            other => panic!("expected root Create, got {other:?}"),
        }
        match &out[1] {
            Patch::Insert {
                parent_id,
                id,
                before_id,
            } => {
                assert_eq!(parent_id.as_ref(), "7");
                assert_eq!(id.as_ref(), "10");
                assert_eq!(before_id.as_deref(), Some("42"));
            }
            other => panic!("expected root Insert, got {other:?}"),
        }
        match &out[2] {
            Patch::Create {
                id,
                element_type,
                props,
                semantics,
            } => {
                assert_eq!(id.as_ref(), "11");
                assert_eq!(element_type, "Text");
                assert_eq!(props.get("fontSize"), Some(&json!(14)));
                assert_eq!(props.get("0"), Some(&json!("Hello")), "sub must merge in");
                assert_eq!(semantics.as_ref(), Some(&sem));
            }
            other => panic!("expected first child Create, got {other:?}"),
        }
        match &out[3] {
            Patch::Insert {
                parent_id,
                id,
                before_id,
            } => {
                assert_eq!(
                    parent_id.as_ref(),
                    "10",
                    "child inserts under the root's id"
                );
                assert_eq!(id.as_ref(), "11");
                assert!(before_id.is_none(), "non-root inserts append");
            }
            other => panic!("expected first child Insert, got {other:?}"),
        }
        match (&out[4], &out[5]) {
            (
                Patch::Create { id: c_id, .. },
                Patch::Insert {
                    parent_id,
                    id: i_id,
                    before_id,
                },
            ) => {
                assert_eq!(c_id.as_ref(), "12");
                assert_eq!(i_id.as_ref(), "12");
                assert_eq!(parent_id.as_ref(), "10");
                assert!(before_id.is_none());
            }
            other => panic!("expected second child C/I, got {other:?}"),
        }
    }

    /// Registered skeletons persist across batches (session-lifetime state).
    #[test]
    fn registration_survives_across_batches() {
        let mut expander = TemplateExpander::new();
        let first = expander.expand(vec![register("t1", skeleton_row())]);
        assert!(first.is_empty(), "RegisterTemplate is consumed: {first:?}");

        let out = expander.expand(vec![instantiate(
            "t1",
            "root",
            None,
            &["1", "2", "3"],
            vec![],
            vec![],
        )]);
        assert_eq!(out.len(), 6);
    }

    /// An Instantiate whose template was never registered passes through
    /// unchanged (and warns) — never panics, never drops.
    #[test]
    fn unknown_template_passes_through() {
        let mut expander = TemplateExpander::new();
        let patch = instantiate("nope", "root", None, &["1"], vec![], vec![]);
        let out = expander.expand(vec![patch]);
        assert_eq!(out.len(), 1);
        assert!(
            matches!(&out[0], Patch::Instantiate { template_id, .. } if template_id == "nope"),
            "got {out:?}"
        );
    }

    /// A node-count mismatch against the skeleton passes through unchanged.
    #[test]
    fn node_count_mismatch_passes_through() {
        let mut expander = TemplateExpander::new();
        let out = expander.expand(vec![
            register("t1", skeleton_row()),
            instantiate("t1", "root", None, &["1", "2"], vec![], vec![]),
        ]);
        assert_eq!(out.len(), 1);
        assert!(matches!(&out[0], Patch::Instantiate { .. }), "got {out:?}");
    }

    /// A malformed skeleton passes its RegisterTemplate through so a
    /// downstream template-capable consumer still receives the pair.
    #[test]
    fn malformed_skeleton_passes_pair_through() {
        let mut expander = TemplateExpander::new();
        let out = expander.expand(vec![
            register("bad", json!({"props": {}})),
            instantiate("bad", "root", None, &["1"], vec![], vec![]),
        ]);
        assert_eq!(out.len(), 2, "both patches pass through: {out:?}");
        assert!(matches!(&out[0], Patch::RegisterTemplate { .. }));
        assert!(matches!(&out[1], Patch::Instantiate { .. }));
    }

    /// Non-template patches pass through untouched with order preserved,
    /// interleaved with expansions.
    #[test]
    fn other_patches_untouched_in_order() {
        let mut expander = TemplateExpander::new();
        let out = expander.expand(vec![
            Patch::SetProp {
                id: "5".into(),
                name: "color".to_string(),
                value: json!("red"),
            },
            register("t1", skeleton_row()),
            instantiate("t1", "root", None, &["1", "2", "3"], vec![], vec![]),
            Patch::Remove {
                id: "9".into(),
                transition: false,
            },
        ]);
        assert_eq!(out.len(), 8);
        assert!(matches!(&out[0], Patch::SetProp { id, .. } if id.as_ref() == "5"));
        assert!(matches!(&out[1], Patch::Create { .. }));
        assert!(matches!(&out[7], Patch::Remove { id, .. } if id.as_ref() == "9"));
    }

    /// A batch with no template patches is returned as-is (fast path).
    #[test]
    fn plain_batch_is_identity() {
        let mut expander = TemplateExpander::new();
        let out = expander.expand(vec![Patch::Detach { id: "3".into() }]);
        assert_eq!(out.len(), 1);
        assert!(matches!(&out[0], Patch::Detach { id } if id.as_ref() == "3"));
    }

    /// On a (theoretical) key collision the sub's per-instance value wins
    /// over the skeleton's static value.
    #[test]
    fn subs_win_on_key_collision() {
        let mut expander = TemplateExpander::new();
        let out = expander.expand(vec![
            register(
                "t1",
                json!({"elementType": "Text", "props": {"0": "static"}, "children": []}),
            ),
            instantiate(
                "t1",
                "root",
                None,
                &["1"],
                vec![(0, "0", json!("dynamic"))],
                vec![],
            ),
        ]);
        match &out[0] {
            Patch::Create { props, .. } => {
                assert_eq!(props.get("0"), Some(&json!("dynamic")));
                assert_eq!(props.len(), 1);
            }
            other => panic!("expected Create, got {other:?}"),
        }
    }
}
