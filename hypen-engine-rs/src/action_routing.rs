//! Internal UI action envelope. Old engines do not recognize the entry point,
//! so mixed-version applications fail closed instead of ignoring ownership.
use crate::{dispatch::Action, engine_core::EngineCore, error::EngineError, ir::NodeId};
use serde_json::Value;

pub const UI_ACTION: &str = "__hypen_dispatch";
const SCOPED: &str = "__hypen_scoped:";

pub fn scoped_action_name(scope: &str, name: &str) -> String {
    format!("{SCOPED}{}:{name}", scope.to_lowercase())
}

pub fn split_scoped_action(name: &str) -> Option<(&str, &str)> {
    name.strip_prefix(SCOPED)?.split_once(':')
}

/// A renderer `.bind` write awaiting [`EngineCore::apply_renderer_bind_writes`].
#[derive(Debug, Clone)]
pub struct RendererBindWrite {
    node: NodeId,
    prop: &'static str,
    /// Path below the declared bind path (empty for the whole value).
    subpath: String,
    value: Value,
}

pub fn safe_state_path(path: &str) -> bool {
    !path.is_empty()
        && path
            .split('.')
            .all(|s| !s.is_empty() && !matches!(s, "__proto__" | "constructor" | "prototype"))
}

impl EngineCore {
    pub(crate) fn has_routable_handler(&self, name: &str) -> bool {
        self.registered_actions
            .iter()
            .any(|n| n == name || split_scoped_action(n).is_some_and(|(_, a)| a == name))
    }

    /// Resolve live nodes, including effective primary scope and inherited
    /// scope through control-flow wrappers. Detached cached routes are inert.
    ///
    /// One narrow exception for removed nodes: `exit_completion` names the
    /// action of a `node`-addressed envelope, and when `node` is gone but
    /// left an exit tombstone (it rooted a `Remove { transition: true }` and
    /// carried `.onAnimationComplete` with exactly this action), the
    /// tombstone's recorded owner stands in for the live walk — the `.exit`
    /// completion fires after the engine already removed the node. Callers
    /// that must never reach a removed node (`fromNode`) pass `None`.
    fn ui_node_scope(
        &self,
        id: &str,
        exit_completion: Option<&str>,
    ) -> Result<String, EngineError> {
        let bad = || EngineError::ActionNotFound("stale UI action target".into());
        let key = id.parse::<u64>().map_err(|_| bad())?;
        let node = NodeId::from(slotmap::KeyData::from_ffi(key));
        let scope = match self.tree.attached_scope(node) {
            Some(scope) => scope,
            None => self
                .tree
                .exit_tombstone(node)
                .filter(|t| {
                    exit_completion.is_some_and(|name| !name.starts_with("__") && name == t.action)
                })
                .ok_or_else(bad)?
                .scope
                .clone(),
        };
        if let Some(scope) = scope.as_ref() {
            if self.modules.contains_key(scope) {
                return Ok(scope.clone());
            }
            if self
                .module
                .as_ref()
                .is_some_and(|m| m.module.name.eq_ignore_ascii_case(scope))
            {
                return Ok(String::new());
            }
            if crate::agent_core::effective_scope(self, &Some(scope.clone())).is_some() {
                return Err(bad());
            }
        }
        Ok(String::new())
    }

    /// Resolve the envelope once, before any host handler runs. Scope names
    /// in application payloads are never used as UI routing authority.
    pub fn route_ui_action(&self, mut action: Action) -> Result<Action, EngineError> {
        if action.name == UI_ACTION {
            let envelope = action.payload.take().unwrap_or(Value::Null);
            let invalid = || EngineError::ActionNotFound("invalid scoped UI action".into());
            let node = envelope
                .get("node")
                .and_then(Value::as_str)
                .ok_or_else(invalid)?;
            let name = envelope
                .get("action")
                .and_then(Value::as_str)
                .ok_or_else(invalid)?;
            if name == UI_ACTION || name.starts_with(SCOPED) {
                return Err(invalid());
            }
            let scope = self.ui_node_scope(node, Some(name))?;
            let from_scope = envelope
                .get("fromNode")
                .and_then(Value::as_str)
                .map(|id| self.ui_node_scope(id, None))
                .transpose()?;
            self.validate_ui_write(
                node,
                name,
                envelope.get("payload"),
                envelope.get("fromNode").and_then(Value::as_str),
            )?;
            if name == "__hypen_reorder" && from_scope.as_ref().is_some_and(|s| s != &scope) {
                return Err(EngineError::ActionNotFound(
                    "cross-module reorder requires an application handler".into(),
                ));
            }
            action.name = scoped_action_name(&scope, name);
            action.payload = envelope.get("payload").cloned();
            action.sender = Some(node.to_string());
            if let Some(Value::Object(payload)) = action.payload.as_mut() {
                if let Some(from) = from_scope {
                    payload.insert("fromScope".into(), Value::String(from));
                    payload.insert("toScope".into(), Value::String(scope));
                }
            }
            // A renderer speaking the new protocol must never reach an old
            // name-global host callback when multiple owners exist.
            if !self.registered_actions.contains(&action.name) {
                if ((self.modules.is_empty() || name.starts_with("router."))
                    && self.registered_actions.iter().any(|a| a == name))
                    || self.build_data_source_action(name, Value::Null).is_some()
                {
                    action.name = name.to_string();
                } else {
                    return Err(invalid());
                }
            }
            if name == "__hypen_bind" {
                self.note_renderer_bind_write(node, envelope.get("payload"));
            }
        } else if split_scoped_action(&action.name).is_some() {
            if !self.registered_actions.contains(&action.name) {
                return Err(EngineError::ActionNotFound(
                    "unregistered scoped action".into(),
                ));
            }
        } else {
            let suffix = format!(":{}", action.name);
            let mut matches = self
                .registered_actions
                .iter()
                .filter(|n| n.starts_with(SCOPED) && n.ends_with(&suffix));
            if let Some(name) = matches.next() {
                if matches.next().is_some() {
                    return Err(EngineError::ActionNotFound(
                        "ambiguous unscoped action".into(),
                    ));
                }
                action.name = name.clone();
            } else if action.name.starts_with("__hypen_") && self.modules.len() > 1 {
                return Err(EngineError::ActionNotFound(
                    "unscoped reserved action".into(),
                ));
            }
        }
        Ok(action)
    }

    /// Record an accepted renderer `.bind` write (see
    /// [`EngineCore::renderer_bind_writes`]). Only a write through a real
    /// `.bind()` applicator (`__bind` declares the path) onto its bound
    /// value prop qualifies — a settle's pose-label write must still flip
    /// the node's `.states` pose, which the renderer waits for.
    fn note_renderer_bind_write(&self, node: &str, payload: Option<&Value>) {
        let Some(id) = node.parse::<u64>().ok() else {
            return;
        };
        let node_id = NodeId::from(slotmap::KeyData::from_ffi(id));
        let Some(target) = self.tree.get(node_id) else {
            return;
        };
        let (Some(path), Some(value)) = (
            payload.and_then(|p| p.get("path")).and_then(Value::as_str),
            payload.and_then(|p| p.get("value")),
        ) else {
            return;
        };
        let Some(declared) = target.props.get("__bind").and_then(Value::as_str) else {
            return;
        };
        let subpath = if path == declared {
            String::new()
        } else if let Some(rest) = path.strip_prefix(&format!("{declared}.")) {
            rest.to_string()
        } else {
            return;
        };
        let prop = crate::agent_core::bind_prop_for(&target.element_type);
        // Only the Video playback struct. Text fields count on the echo:
        // their renderers match each answer against the ordered outstanding
        // keystrokes (`hypen-web/packages/web/src/bind-echo.ts`, one answer
        // per state-changing write) — with no answers that queue never
        // drains and a genuine module reset to an earlier value would be
        // taken for a stale echo. Scalar controls (checkbox, switch, select,
        // slider) report a level the echo merely repeats.
        if prop != "playback" {
            return;
        }
        if let Ok(mut writes) = self.renderer_bind_writes.lock() {
            writes.push(RendererBindWrite {
                node: node_id,
                prop,
                subpath,
                value: value.clone(),
            });
        }
    }

    /// Fold pending renderer `.bind` writes into their nodes' resolved bound
    /// props, so the next diff treats the renderer's own value as already
    /// sent. Called at the top of every reconcile entry point.
    pub(crate) fn apply_renderer_bind_writes(&mut self) {
        let writes = match self.renderer_bind_writes.get_mut() {
            Ok(writes) if !writes.is_empty() => std::mem::take(writes),
            _ => return,
        };
        for write in writes {
            let Some(node) = self.tree.get_mut(write.node) else {
                continue;
            };
            // Only a prop the engine resolves from a binding: a static one
            // never re-diffs, so there is nothing to suppress.
            if matches!(
                node.raw_props.get(write.prop),
                None | Some(crate::ir::Value::Static(_))
            ) {
                continue;
            }
            let Some(current) = node.props.get(write.prop) else {
                continue;
            };
            let next = if write.subpath.is_empty() {
                write.value
            } else {
                let mut next = current.clone();
                crate::portable::path::path_set(&mut next, &write.subpath, write.value);
                next
            };
            node.props.insert(write.prop, next);
        }
    }

    fn validate_ui_write(
        &self,
        node: &str,
        name: &str,
        payload: Option<&Value>,
        from: Option<&str>,
    ) -> Result<(), EngineError> {
        if !matches!(name, "__hypen_bind" | "__hypen_reorder" | "__hypen_pin") {
            return Ok(());
        }
        let invalid = || EngineError::ActionNotFound("invalid UI write target".into());
        let p = payload.and_then(Value::as_object).ok_or_else(invalid)?;
        let props = |id: &str| {
            id.parse::<u64>()
                .ok()
                .and_then(|id| self.tree.get(NodeId::from(slotmap::KeyData::from_ffi(id))))
        };
        let target = props(node).ok_or_else(invalid)?;
        let bind = |id: &str| {
            props(id)
                .and_then(|n| n.props.get("bind"))
                .and_then(Value::as_str)
        };
        let path = |key: &str| {
            p.get(key)
                .and_then(Value::as_str)
                .filter(|s| safe_state_path(s))
        };
        if name == "__hypen_reorder" {
            let source = path("fromPath")
                .or_else(|| path("path"))
                .ok_or_else(invalid)?;
            let dest = path("toPath").unwrap_or(source);
            if bind(from.unwrap_or(node)) != Some(source)
                || bind(node) != Some(dest)
                || p.get("from").and_then(Value::as_u64).is_none()
                || p.get("to").and_then(Value::as_u64).is_none()
            {
                return Err(invalid());
            }
        } else {
            let path = path("path").ok_or_else(invalid)?;
            let declared = bind(node);
            if name == "__hypen_bind" {
                // A `.scrub`/`.settle` node writes its winning pose label to
                // the settle's declared `bind:` path (`__anim.scrubBind`)
                // through the same channel — exactly that path, no subfields.
                let settle = target
                    .props
                    .get(crate::ir::anim::ANIM_SCRUB_BIND_PROP)
                    .and_then(Value::as_str);
                // Struct-valued controls (video) report individual subfields.
                if !declared.is_some_and(|b| path == b || path.starts_with(&format!("{b}.")))
                    && settle != Some(path)
                {
                    return Err(invalid());
                }
            } else {
                let group = target
                    .props
                    .get("__dnd.pin")
                    .and_then(|v| v.get("group"))
                    .and_then(Value::as_str)
                    .or_else(|| target.props.get("__dnd.pinGroup").and_then(Value::as_str));
                if !declared.is_some_and(|b| {
                    path.strip_prefix(&format!("{b}."))
                        .is_some_and(|index| index.parse::<usize>().is_ok())
                }) && !group.is_some_and(|g| {
                    path.strip_prefix(&format!("__dnd.{g}."))
                        .is_some_and(|key| !key.is_empty())
                }) {
                    return Err(invalid());
                }
                for key in ["xKey", "yKey"] {
                    if let Some(value) = p.get(key) {
                        if !value
                            .as_str()
                            .is_some_and(|v| safe_state_path(v) && !v.contains('.'))
                        {
                            return Err(invalid());
                        }
                    }
                }
                if !["x", "y"].iter().all(|axis| {
                    p.get(*axis)
                        .and_then(Value::as_f64)
                        .is_some_and(f64::is_finite)
                }) {
                    return Err(invalid());
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        ir::{Element, Value as Prop},
        lifecycle::{Module, ModuleInstance},
        reconcile::node_id_str,
        Engine,
    };
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    fn setup() -> (Engine, NodeId, NodeId, Arc<Mutex<Vec<String>>>) {
        let mut engine = Engine::new();
        engine.set_module(ModuleInstance::new(Module::new("App"), json!({})));
        let calls = Arc::new(Mutex::new(Vec::new()));
        let root = engine
            .core
            .tree
            .create_node(&Element::new("Column"), &json!({}));
        engine.core.tree.set_root(root);
        let mut ids = Vec::new();
        for scope in ["alpha", "beta"] {
            engine.register_module(
                scope,
                ModuleInstance::new(Module::new(scope), json!({"items":[1,2]})),
            );
            let mut element =
                Element::new("Column").with_prop("bind", Prop::Static(json!("items")));
            element.module_scope = Some(scope.into());
            let id = engine.core.tree.create_node(&element, &json!({}));
            engine.core.tree.add_child(root, id, None);
            ids.push(id);
            for name in ["__hypen_bind", "__hypen_reorder", "__hypen_pin", "sorted"] {
                let calls = calls.clone();
                engine.on_action(scoped_action_name(scope, name), move |_| {
                    calls.lock().unwrap().push(scope.into())
                });
            }
        }
        (engine, ids[0], ids[1], calls)
    }
    fn ui(node: NodeId, action: &str, payload: Value) -> Action {
        Action::new(UI_ACTION)
            .with_payload(json!({"node":node_id_str(node),"action":action,"payload":payload}))
    }

    #[test]
    fn identical_paths_route_to_the_live_owner_and_callbacks_share_that_scope() {
        let (mut engine, alpha, beta, calls) = setup();
        engine
            .dispatch_action(ui(
                alpha,
                "__hypen_reorder",
                json!({"path":"items","from":0,"to":1}),
            ))
            .unwrap();
        engine
            .dispatch_action(ui(alpha, "sorted", json!({})))
            .unwrap();
        engine
            .dispatch_action(ui(beta, "__hypen_bind", json!({"path":"items","value":[]})))
            .unwrap();
        assert_eq!(*calls.lock().unwrap(), vec!["alpha", "alpha", "beta"]);
        assert!(engine
            .dispatch_action(
                Action::new("__hypen_bind").with_payload(json!({"path":"items","value":[]}))
            )
            .is_err());
    }

    #[test]
    fn cross_owner_transfers_and_stale_or_forged_writes_are_inert() {
        let (mut engine, alpha, beta, calls) = setup();
        let mut action = ui(
            beta,
            "__hypen_reorder",
            json!({"path":"items","from":0,"to":1}),
        );
        action.payload.as_mut().unwrap()["fromNode"] = json!(node_id_str(alpha));
        assert!(engine.dispatch_action(action).is_err());
        assert!(engine
            .dispatch_action(ui(alpha, "__hypen_bind", json!({"path":"other","value":1})))
            .is_err());
        assert!(engine
            .dispatch_action(ui(
                alpha,
                "__hypen_bind",
                json!({"path":"items.__proto__.bad","value":1})
            ))
            .is_err());
        let root = engine.core.tree.root().unwrap();
        engine.core.tree.remove_child(root, alpha);
        assert!(engine
            .dispatch_action(ui(alpha, "sorted", json!({})))
            .is_err());
        assert!(calls.lock().unwrap().is_empty());
        engine
            .dispatch_action(ui(beta, "sorted", json!({})))
            .unwrap();
        assert_eq!(*calls.lock().unwrap(), vec!["beta"]);
    }

    #[test]
    fn settle_bind_path_is_an_accepted_write_target() {
        let (mut engine, alpha, _, calls) = setup();
        let mut element = Element::new("Column").with_prop(
            crate::ir::anim::ANIM_SCRUB_BIND_PROP,
            Prop::Static(json!("sheetPhase")),
        );
        element.module_scope = Some("alpha".into());
        let sheet = engine.core.tree.create_node(&element, &json!({}));
        engine.core.tree.add_child(alpha, sheet, None);
        engine
            .dispatch_action(ui(
                sheet,
                "__hypen_bind",
                json!({"path":"sheetPhase","value":"open"}),
            ))
            .unwrap();
        assert_eq!(*calls.lock().unwrap(), vec!["alpha"]);
        // Only the declared settle path: no other path, no subfields.
        for path in ["other", "sheetPhase.x", "items"] {
            assert!(engine
                .dispatch_action(ui(
                    sheet,
                    "__hypen_bind",
                    json!({"path":path,"value":"open"})
                ))
                .is_err());
        }
        assert_eq!(calls.lock().unwrap().len(), 1);
    }

    #[test]
    fn wrappers_inherit_scope_and_primary_module_names_normalize() {
        let (mut engine, alpha, _, calls) = setup();
        let child = engine
            .core
            .tree
            .create_node(&Element::new("Button"), &json!({}));
        engine.core.tree.add_child(alpha, child, None);
        engine
            .dispatch_action(ui(child, "sorted", json!({})))
            .unwrap();
        assert_eq!(*calls.lock().unwrap(), vec!["alpha"]);
        let root = engine.core.tree.root().unwrap();
        engine.core.tree.get_mut(root).unwrap().module_scope = Some("app".into());
        engine.on_action(scoped_action_name("", "clicked"), |_| {});
        engine
            .dispatch_action(ui(root, "clicked", json!({})))
            .unwrap();
    }

    #[test]
    fn exit_tombstones_are_dropped_by_a_tree_clear() {
        let mut engine = Engine::new();
        engine.set_module(ModuleInstance::new(
            Module::new("App"),
            json!({"show": true}),
        ));
        engine.on_action(scoped_action_name("", "done"), |_| {});
        let doc = hypen_parser::parse_document(
            r#"Column { If(@state.show) { Row { Text("x") }.exit(fade).onAnimationComplete(@actions.done) } }"#,
        )
        .unwrap();
        engine.render_ir_node(&crate::ir::ast_to_ir_node(&doc.components[0]));
        let root = engine.core.tree.root().unwrap();
        let cond = engine.core.tree.get(root).unwrap().children[0];
        let row = engine.core.tree.get(cond).unwrap().children[0];
        engine.update_state(None, json!({"show": false}));
        assert!(engine.core.tree.exit_tombstone(row).is_some());
        engine
            .dispatch_action(ui(row, "done", json!({"animation": "exit"})))
            .unwrap();
        engine.core.tree.clear();
        assert!(engine
            .dispatch_action(ui(row, "done", json!({"animation": "exit"})))
            .is_err());
    }

    /// A bound Video's own playback reports are not echoed back to it; a
    /// module write that differs from what it reported still is.
    #[test]
    fn renderer_bind_writes_are_not_echoed_to_the_writing_node() {
        let mut engine = Engine::new();
        engine.set_module(ModuleInstance::new(
            Module::new("App"),
            json!({"playback": {"playing": false}, "name": ""}),
        ));
        engine.on_action(scoped_action_name("", "__hypen_bind"), |_| {});
        let patches = Arc::new(Mutex::new(Vec::new()));
        let captured = patches.clone();
        engine.set_render_callback(move |p| captured.lock().unwrap().extend(p.iter().cloned()));
        let doc = hypen_parser::parse_document(
            r#"Column {
                Video(src: "a.mp4", autoplay: true).bind(@state.playback)
                Input().bind(@state.name)
            }"#,
        )
        .unwrap();
        engine.render_ir_node(&crate::ir::ast_to_ir_node(&doc.components[0]));
        let root = engine.core.tree.root().unwrap();
        let video = engine.core.tree.get(root).unwrap().children[0];
        let input = engine.core.tree.get(root).unwrap().children[1];
        let set_props = |patches: &Arc<Mutex<Vec<crate::reconcile::Patch>>>, key: &str| {
            patches
                .lock()
                .unwrap()
                .iter()
                .filter_map(|p| match p {
                    crate::reconcile::Patch::SetProp { name, value, .. } if name == key => {
                        Some(value.clone())
                    }
                    _ => None,
                })
                .collect::<Vec<_>>()
        };

        // Autoplay pending: the renderer reports `false`, then starts and
        // reports `true`; the host flushes both writes as one state update.
        patches.lock().unwrap().clear();
        for (key, value) in [("playing", json!(false)), ("state", json!("loading"))] {
            engine
                .dispatch_action(ui(
                    video,
                    "__hypen_bind",
                    json!({"path": format!("playback.{key}"), "value": value}),
                ))
                .unwrap();
        }
        engine
            .dispatch_action(ui(
                video,
                "__hypen_bind",
                json!({"path":"playback.playing","value":true}),
            ))
            .unwrap();
        engine.update_state(
            None,
            json!({"playback": {"playing": true, "state": "loading"}}),
        );
        assert!(
            set_props(&patches, "playback").is_empty(),
            "the renderer's own report must not echo back: {:?}",
            patches.lock().unwrap()
        );

        // A text field keeps its echo: its renderer reconciles keystrokes
        // against one answer per write (bind-echo.ts).
        engine
            .dispatch_action(ui(
                input,
                "__hypen_bind",
                json!({"path":"name","value":"ab"}),
            ))
            .unwrap();
        engine.update_state(None, json!({"name": "ab"}));
        assert_eq!(set_props(&patches, "value"), vec![json!("ab")]);

        // A genuine module command still reaches the renderer.
        engine.update_state(
            None,
            json!({"playback": {"playing": false, "state": "loading"}}),
        );
        assert_eq!(
            set_props(&patches, "playback"),
            vec![json!({"playing": false, "state": "loading"})]
        );
        // ...including flipping a field back to a value the renderer
        // itself reported earlier.
        engine.update_state(
            None,
            json!({"playback": {"playing": true, "state": "loading"}}),
        );
        assert_eq!(
            set_props(&patches, "playback")[1..],
            [json!({"playing": true, "state": "loading"})]
        );
    }

    /// `render_subtree_into` (WasmEngine::renderInto / hypen_render_into, the
    /// lazy-route path) folds pending renderer bind writes before diffing,
    /// like every other reconcile entry point: a bound Video's own playback
    /// report is not echoed back through a subtree render.
    #[test]
    fn render_subtree_into_does_not_echo_renderer_bind_writes() {
        let mut engine = Engine::new();
        engine.set_module(ModuleInstance::new(
            Module::new("App"),
            json!({"playback": {"playing": false}}),
        ));
        engine.on_action(scoped_action_name("", "__hypen_bind"), |_| {});
        let parse = |src: &str| {
            let doc = hypen_parser::parse_document(src).unwrap();
            crate::ir::ast_to_ir_node(&doc.components[0])
        };
        engine.render_ir_node(&parse("Column {}"));
        let root = engine.core.tree.root().unwrap();

        let video_ir = parse(r#"Video(src: "a.mp4").bind(@state.playback)"#);
        let created = engine.core.render_subtree_into(
            root,
            &video_ir,
            &json!({"playback": {"playing": false}}),
        );
        assert!(created
            .iter()
            .any(|p| matches!(p, crate::reconcile::Patch::Create { element_type, .. } if element_type == "Video")));
        let video = engine.core.tree.get(root).unwrap().children[0];
        let playback_sets = |patches: &[crate::reconcile::Patch]| {
            patches
                .iter()
                .filter(|p| {
                    matches!(p, crate::reconcile::Patch::SetProp { name, .. } if name == "playback")
                })
                .count()
        };

        // The renderer reports it started playing; the host's state now
        // says so too. Re-rendering the subtree must not echo it back.
        engine
            .dispatch_action(ui(
                video,
                "__hypen_bind",
                json!({"path": "playback.playing", "value": true}),
            ))
            .unwrap();
        let echoed = engine.core.render_subtree_into(
            root,
            &video_ir,
            &json!({"playback": {"playing": true}}),
        );
        assert_eq!(playback_sets(&echoed), 0, "echoed: {echoed:?}");

        // A genuine module command still reaches the renderer.
        let command = engine.core.render_subtree_into(
            root,
            &video_ir,
            &json!({"playback": {"playing": false}}),
        );
        assert_eq!(playback_sets(&command), 1, "{command:?}");
    }

    /// The Photos-viewer path end to end: a real `.scrub`/`.settle` node's
    /// settle write is accepted and, once applied, flips the `.states` pose —
    /// the `__anim.states` label SetProp renderers fire
    /// `.onAnimationComplete` from.
    #[test]
    fn settle_write_from_a_lowered_scrub_node_routes_and_flips_the_pose() {
        let mut engine = Engine::new();
        engine.set_module(ModuleInstance::new(
            Module::new("App"),
            json!({"sheetPhase": "closed"}),
        ));
        let writes = Arc::new(Mutex::new(Vec::new()));
        let sink = writes.clone();
        engine.on_action(scoped_action_name("", "__hypen_bind"), move |a| {
            sink.lock().unwrap().push(a.payload.clone().unwrap())
        });
        let patches = Arc::new(Mutex::new(Vec::new()));
        let captured = patches.clone();
        engine.set_render_callback(move |p| captured.lock().unwrap().extend(p.iter().cloned()));
        let doc = hypen_parser::parse_document(
            r#"Column { Box().translateY(400)
                .scrub(from: closed, to: open, over: [0, 400])
                .settle(bind: @state.sheetPhase)
                .states(@state.sheetPhase) {
                    onState(closed).translateY(400)
                    onState(open).translateY(0)
                }
                .onAnimationComplete(@actions.done) }"#,
        )
        .unwrap();
        engine.render_ir_node(&crate::ir::ast_to_ir_node(&doc.components[0]));
        let root = engine.core.tree.root().unwrap();
        let sheet = engine.core.tree.get(root).unwrap().children[0];

        engine
            .dispatch_action(ui(
                sheet,
                "__hypen_bind",
                json!({"path":"sheetPhase","value":"open"}),
            ))
            .unwrap();
        assert_eq!(
            *writes.lock().unwrap(),
            vec![json!({"path":"sheetPhase","value":"open"})]
        );

        patches.lock().unwrap().clear();
        engine.update_state(None, json!({"sheetPhase": "open"}));
        let flipped = patches.lock().unwrap().iter().any(|p| {
            matches!(p, crate::reconcile::Patch::SetProp { name, value, .. }
                if name == "__anim.states" && value["label"] == "open")
        });
        assert!(flipped, "got {:?}", patches.lock().unwrap());
    }
}
