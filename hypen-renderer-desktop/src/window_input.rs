//! `App`-method extension for Input editing, IME, keyboard, and click
//! dispatch. Lives in its own file via `#[path]` from `window.rs` so
//! the main file can stay focused on App/state and the
//! ApplicationHandler dispatch loop. The methods all attach to the
//! same `App` defined in the parent.

use super::*;

/// Resolve editing state directly from the renderer Tree, with the newest
/// unacknowledged local value taking precedence. Keyboard delivery must not
/// depend on a LayoutPass: a second key can legally arrive before the first
/// key's requested redraw.
pub(crate) fn controlled_input_state(
    tree: &Tree,
    optimistic: &HashMap<String, OptimisticInputEdit>,
    id: &str,
) -> Option<(String, String)> {
    let node = tree.get(id)?;
    if !node.element_type.eq_ignore_ascii_case("Input") {
        return None;
    }
    let bind_path = node
        .props
        .get("bind")
        .or_else(|| node.props.get("bind.0"))?
        .as_str()?
        .to_string();
    let value = optimistic
        .get(id)
        .map(|edit| edit.value.clone())
        .or_else(|| {
            node.props
                .get("value")
                .or_else(|| node.props.get("value.0"))
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_default();
    Some((value, bind_path))
}

impl App {
    /// Find the focused Input (if any) and return `(node_id, value, bind_path)`.
    pub(super) fn focused_input(&self) -> Option<(String, String, String)> {
        let id = self.focused.clone()?;
        // An Input inside an exit-animating subtree is engine-side
        // dead: typing, IME composition, and `__hypen_bind` dispatch
        // all stop the moment the exit begins. (Focus itself is cleared
        // on the flush that starts the exit; this guards the window
        // between events.)
        if self.exit_excluded(&id) {
            return None;
        }
        let (value, bind_path) = controlled_input_state(&self.tree, &self.optimistic_inputs, &id)?;
        Some((id, value, bind_path))
    }

    /// Look up an Input's `(value, font_size, rect)` by node id. Used
    /// by mouse-driven cursor positioning + drag-select.
    pub(super) fn lookup_input(&self, id: &str) -> Option<(String, f32, crate::layout::Rect)> {
        let layout = self.layout.as_ref()?;
        let item = layout.item_by_id(id)?;
        match &item.kind {
            ItemKind::Input {
                value, font_size, ..
            } => Some((value.clone(), *font_size, item.rect)),
            _ => None,
        }
    }

    /// Read the current selection of `id`, defaulting to a caret at
    /// the end of `value`.
    pub(super) fn selection_of(&self, id: &str, value: &str) -> Selection {
        self.input_selections
            .get(id)
            .copied()
            .unwrap_or_else(|| Selection::caret(value.len()))
            .clamped(value.len())
    }

    /// Look up the registered [`ShortcutBinding`] for the current key
    /// event. Returns the matching binding or `None`.
    ///
    /// Modifier rules:
    /// - `cmd_or_ctrl` matches either Cmd (macOS) or Ctrl
    ///   (Linux/Windows) — both via `clipboard_modifier()`.
    /// - `shift` / `alt` must match the binding exactly (no
    ///   `false` accepting `true`, else `Cmd+Shift+L` would also
    ///   match `Cmd+L`).
    ///
    /// Unmodified shortcuts are suppressed while an `Input` is
    /// focused so typing letters into the address bar can't fire a
    /// `Cmd-less` `l` binding — which would be impossible to type at
    /// all otherwise.
    fn match_shortcut(
        &self,
        ev: &KeyEvent,
        shift: bool,
        cmd: bool,
        editing_focused: bool,
    ) -> Option<&crate::window::ShortcutBinding> {
        let alt = self.modifiers.alt_key();
        let key_name = match ev.logical_key.as_ref() {
            Key::Character(s) => s.to_lowercase(),
            Key::Named(NamedKey::Escape) => "Escape".to_string(),
            Key::Named(NamedKey::Enter) => "Enter".to_string(),
            Key::Named(NamedKey::Tab) => "Tab".to_string(),
            Key::Named(NamedKey::Space) => "Space".to_string(),
            Key::Named(NamedKey::ArrowUp) => "ArrowUp".to_string(),
            Key::Named(NamedKey::ArrowDown) => "ArrowDown".to_string(),
            Key::Named(NamedKey::ArrowLeft) => "ArrowLeft".to_string(),
            Key::Named(NamedKey::ArrowRight) => "ArrowRight".to_string(),
            _ => return None,
        };
        self.shortcuts.iter().find(|b| {
            if b.combo.cmd_or_ctrl != cmd {
                return false;
            }
            if b.combo.shift != shift || b.combo.alt != alt {
                return false;
            }
            if editing_focused && !b.combo.cmd_or_ctrl {
                // Unmodified shortcut while typing — would steal
                // characters from the focused Input.
                return false;
            }
            b.combo.key.eq_ignore_ascii_case(&key_name)
        })
    }

    /// Apply `mutate(value, sel)` to the focused Input and dispatch
    /// `__hypen_bind` if the value changed. Returns true if anything
    /// changed (including a pure selection move).
    pub(super) fn edit_focused_input<F>(&mut self, mutate: F) -> bool
    where
        F: FnOnce(&str, Selection) -> (String, Selection),
    {
        let (id, value, bind_path) = match self.focused_input() {
            Some(x) => x,
            None => return false,
        };
        let sel = self.selection_of(&id, &value);
        let (new_value, new_sel) = mutate(&value, sel);
        let new_sel = new_sel.clamped(new_value.len());
        if new_value == value && new_sel == sel {
            return false;
        }
        self.input_selections.insert(id.clone(), new_sel);
        if new_value != value {
            self.optimistic_inputs
                .entry(id.clone())
                .or_default()
                .push(new_value.clone());
            // Optimistic local update: stamp the Input's `value` prop
            // directly into the Tree before dispatching to the engine.
            // The engine will eventually echo back a SetProp patch with
            // the same value (a full state → reconcile → patch round-
            // trip), but that's slow over WebSocket — long enough that
            // every keystroke would visibly lag the displayed text.
            // Synthesise the same `SetProp` patch locally and apply it
            // so the next layout pass picks up the new value. The
            // engine's echo is then a no-op (same value already in
            // place), which is the same pattern every web framework
            // uses for controlled inputs.
            let patch = hypen_engine::Patch::SetProp {
                id: id.as_str().into(),
                name: "value".to_string(),
                value: serde_json::Value::String(new_value.clone()),
            };
            self.tree.apply(&patch);
            // `value` is paint/a11y state, not geometry. Refresh the cached
            // item in place so another keyboard event arriving before the
            // redraw can still resolve the focused Input. Invalidating the
            // whole layout here made burst typing drop every event that landed
            // between the first key and its paint.
            let scale = self
                .window
                .as_ref()
                .map(|window| window.scale_factor() as f32)
                .unwrap_or(1.0);
            let viewport = self.logical_viewport();
            if let Some(layout) = self.layout.as_mut() {
                let affected = HashSet::from([id.clone()]);
                layout.refresh_paint_only(&self.tree, &affected, viewport, scale);
                self.layout_generation = self.layout_generation.wrapping_add(1);
            }
            // Same reason as `flush_patches`: the focused Input's
            // cached scene fragment now has the wrong text and needs
            // re-encoding. Bulk-clear; the next paint rebuilds only
            // the visible subtrees.
            self.painter.invalidate_subtree_cache();
            self.damage.add_full();
            if let Some(w) = self.window.as_ref() {
                w.request_redraw();
            }
            self.module.dispatch_action(
                "__hypen_bind",
                Some(json!({ "path": bind_path, "value": new_value })),
            );
            // Also forward an `onInput` action if the focused Input has one
            // wired via `.onInput(@actions.foo)`. Web renderers attach a
            // separate `input` listener for this; the desktop path edits the
            // value directly, so we dispatch the action manually with the
            // same payload shape (`value` / `input`) other renderers use.
            if let Some(node) = self.tree.get(&id) {
                if let Some((action, mut payload_args)) =
                    crate::layout::resolve_named_event_action(node, "onInput")
                {
                    let payload_obj = payload_args.as_object_mut();
                    let mut obj = match payload_obj {
                        Some(o) => std::mem::take(o),
                        None => serde_json::Map::new(),
                    };
                    obj.insert("type".to_string(), json!("input"));
                    obj.insert("value".to_string(), json!(new_value.clone()));
                    obj.insert("input".to_string(), json!(new_value.clone()));
                    self.module
                        .dispatch_action(&action, Some(serde_json::Value::Object(obj)));
                }
            }
        }
        true
    }

    /// Replace the selected range (or insert at the caret if collapsed)
    /// with `replacement`. Used by typing + paste. `pub(crate)` so the
    /// test module can exercise the pure logic without an `App`.
    pub(crate) fn replace_selection_with(
        value: &str,
        sel: Selection,
        replacement: &str,
    ) -> (String, Selection) {
        let lo = sel.min().min(value.len());
        let hi = sel.max().min(value.len());
        let mut new = String::with_capacity(value.len() - (hi - lo) + replacement.len());
        new.push_str(&value[..lo]);
        new.push_str(replacement);
        new.push_str(&value[hi..]);
        let caret = lo + replacement.len();
        (new, Selection::caret(caret))
    }

    pub(super) fn copy_focused_selection(&mut self) -> bool {
        let (id, value, _) = match self.focused_input() {
            Some(x) => x,
            None => return false,
        };
        let sel = self.selection_of(&id, &value);
        if sel.is_collapsed() {
            return false;
        }
        let text = value[sel.min()..sel.max()].to_string();
        match self.clipboard_get() {
            Some(cb) => match cb.set_text(text) {
                Ok(()) => true,
                Err(e) => {
                    log::warn!("clipboard copy failed: {e}");
                    false
                }
            },
            None => false,
        }
    }

    pub(super) fn cut_focused_selection(&mut self) -> bool {
        if !self.copy_focused_selection() {
            return false;
        }
        self.edit_focused_input(|val, sel| Self::replace_selection_with(val, sel, ""))
    }

    pub(super) fn paste_into_focused_input(&mut self) -> bool {
        let pasted = match self.clipboard_get().and_then(|cb| cb.get_text().ok()) {
            Some(s) => s,
            None => return false,
        };
        // Single-line `Input` strips embedded newlines; Textarea will
        // preserve them when multi-line editing lands.
        let cleaned: String = pasted.replace(['\n', '\r'], " ");
        if cleaned.is_empty() {
            return false;
        }
        self.edit_focused_input(|val, sel| Self::replace_selection_with(val, sel, &cleaned))
    }

    /// Apply a winit `Ime` event to the focused Input. Pure transition
    /// (toggling flags / setting preedit) lives in
    /// [`apply_ime_transition`]; this method is the side-effecting
    /// adapter that calls `edit_focused_input` on `Commit`.
    pub(super) fn handle_ime(&mut self, event: Ime) {
        let focused_input_id = self.focused_input().map(|(id, _, _)| id);
        let effect = apply_ime_transition(
            &mut self.ime_preedit,
            &mut self.ime_active,
            focused_input_id.as_deref(),
            event,
        );
        if let ImeEffect::Commit(text) = effect {
            // Insertion goes through the same primitive typing uses,
            // so a non-empty selection is replaced and the caret
            // advances to the end of the inserted text.
            self.edit_focused_input(|val, sel| Self::replace_selection_with(val, sel, &text));
        }
    }

    /// Toggle `set_ime_allowed` on the window so the OS IME activates
    /// when an `Input` is focused and dismisses otherwise. Also updates
    /// `set_ime_cursor_area` so candidate windows position near the
    /// caret instead of in the corner.
    pub(super) fn sync_ime_to_focus(&mut self) {
        let want_ime = self.focused_input().is_some();
        let Some(window) = self.window.as_ref() else {
            return;
        };
        if want_ime != self.ime_active {
            window.set_ime_allowed(want_ime);
            self.ime_active = want_ime;
            if !want_ime {
                self.ime_preedit = None;
                self.last_ime_target = None;
            }
        }
        if want_ime {
            // Only call `set_ime_cursor_area` when the focused Input's
            // rect or identity actually moves. The OS winit backends
            // translate this into platform syscalls that are cheap
            // individually but show up in profiles when called every
            // frame on a focused input that hasn't moved.
            if let Some(id) = self.focused.as_deref() {
                if self.lookup_input(id).is_some() {
                    // IME candidate windows position in SCREEN space —
                    // use the transform-aware visual rect so a
                    // transformed Input's candidates track the pixels.
                    let rect = self
                        .layout
                        .as_ref()
                        .and_then(|l| l.item_by_id(id))
                        .map(|it| it.visual_rect())
                        .expect("lookup_input implies layout item");
                    let target = (
                        id.to_string(),
                        (rect.x as i32, rect.y as i32, rect.w as u32, rect.h as u32),
                    );
                    if self.last_ime_target.as_ref() != Some(&target) {
                        use winit::dpi::PhysicalPosition as P;
                        use winit::dpi::PhysicalSize as S;
                        window.set_ime_cursor_area(
                            P::new(target.1 .0, target.1 .1),
                            S::new(target.1 .2, target.1 .3),
                        );
                        self.last_ime_target = Some(target);
                    }
                }
            }
        }
    }

    pub(super) fn dispatch_focused(&mut self) -> bool {
        // A focused `.videoIntent(...)` control performs its intent on
        // Enter / Space — keyboard parity with the pointer path (and the
        // reason such a node is focusable with no `.onClick` at all).
        let intent = self
            .focused
            .clone()
            .filter(|id| !self.exit_excluded(id))
            .and_then(|id| self.layout.as_ref()?.item_by_id(&id)?.video_intent);
        let intent_handled = match intent {
            Some(i) => {
                self.perform_video_intent(i);
                true
            }
            None => false,
        };
        let resolved = self.layout.as_ref().and_then(|layout| {
            focused_dispatch(layout, self.focused.as_deref(), &|id| {
                self.exit_excluded(id)
            })
        });
        if let Some((action, payload)) = resolved {
            // Same rule as the click path: a derived `onPlay` is the
            // built-in's own event and must not fire when a
            // presentation-only intent consumed the activation.
            let derived_play = payload
                .as_ref()
                .and_then(|p| p.get("type"))
                .and_then(|v| v.as_str())
                == Some("play");
            if intent_handled && derived_play {
                return true;
            }
            log::debug!("dispatch (kbd): {action} payload={payload:?}");
            self.module.dispatch_action(&action, payload);
            true
        } else {
            intent_handled
        }
    }

    /// Handle keyboard input. Tab walks focus forward, Shift+Tab back;
    /// Enter / Space activates the focused actionable; Escape clears
    /// focus. While an `Input` is focused, editing keys mutate its
    /// text + selection and dispatch `__hypen_bind`. Ctrl/Cmd shortcuts
    /// (A / C / X / V) cover select-all + clipboard.
    pub(super) fn handle_keyboard(&mut self, ev: &KeyEvent) -> bool {
        if ev.state != ElementState::Pressed {
            return false;
        }

        let editing_focused = self.focused_input().is_some();
        let shift = self.modifiers.shift_key();
        let cmd = self.clipboard_modifier();

        if cmd && editing_focused {
            match ev.logical_key.as_ref() {
                Key::Character(s) if s.eq_ignore_ascii_case("a") => {
                    return self.edit_focused_input(|val, _| {
                        (val.to_string(), Selection::range(0, val.len()))
                    });
                }
                Key::Character(s) if s.eq_ignore_ascii_case("c") => {
                    return self.copy_focused_selection();
                }
                Key::Character(s) if s.eq_ignore_ascii_case("x") => {
                    return self.cut_focused_selection();
                }
                Key::Character(s) if s.eq_ignore_ascii_case("v") => {
                    return self.paste_into_focused_input();
                }
                _ => {}
            }
        }

        // Caller-registered shortcuts beat the renderer's default Tab /
        // Enter / Space. We let editing-focused state silence
        // unmodified shortcuts so single-letter bindings don't fight
        // text input — Cmd+L over a focused address bar should STILL
        // fire (the user explicitly wants to re-focus / select-all),
        // so the cmd-modified path is allowed through.
        if let Some(binding) = self.match_shortcut(ev, shift, cmd, editing_focused) {
            log::debug!("dispatch shortcut: {}", binding.action);
            self.module
                .dispatch_action(&binding.action, binding.payload.clone());
            return true;
        }

        // Video v2: Left / Right on a focused `Scrubber` seek by ±5 s
        // with an immediate commit (no preview phase) — the keyboard
        // analogue of a native range input's arrow step. Checked before
        // the editing-focused arrow handling below; the two are mutually
        // exclusive (a Scrubber is never a text input).
        if !editing_focused {
            let step = match ev.logical_key.as_ref() {
                Key::Named(NamedKey::ArrowLeft) => {
                    Some(-crate::window::window_video::SCRUB_KEY_STEP)
                }
                Key::Named(NamedKey::ArrowRight) => {
                    Some(crate::window::window_video::SCRUB_KEY_STEP)
                }
                _ => None,
            };
            if let Some(step) = step {
                if self.video_scrub_key(step) {
                    return true;
                }
            }
        }

        match ev.logical_key.as_ref() {
            Key::Named(NamedKey::Tab) => {
                let layout = match self.layout.as_ref() {
                    Some(l) => l,
                    None => return false,
                };
                // Exit-animating ids are excluded from the Tab order —
                // they still paint (mid-exit) but are engine-side dead,
                // so focus walks past them exactly like hit-testing
                // walks past them.
                let next = if shift {
                    layout
                        .focus_prev_excluding(self.focused.as_deref(), &|id| self.exit_excluded(id))
                } else {
                    layout
                        .focus_next_excluding(self.focused.as_deref(), &|id| self.exit_excluded(id))
                };
                if next != self.focused {
                    self.focused = next;
                    // Keyboard-driven focus shows the ring (`:focus-visible`).
                    self.focus_visible = true;
                    // Focus may land on an item outside the visible window
                    // (culling only emits viewport ± buffer); bring it into
                    // view so Tab never selects something invisible.
                    self.scroll_focused_into_view();
                    return true;
                }
                false
            }
            Key::Named(NamedKey::Escape) => self.focused.take().is_some(),
            Key::Named(NamedKey::Backspace) if editing_focused => {
                self.edit_focused_input(|val, sel| {
                    if !sel.is_collapsed() {
                        return Self::replace_selection_with(val, sel, "");
                    }
                    if sel.head == 0 {
                        return (val.to_string(), sel);
                    }
                    let prev = prev_char_boundary(val, sel.head);
                    let mut new = String::with_capacity(val.len());
                    new.push_str(&val[..prev]);
                    new.push_str(&val[sel.head..]);
                    (new, Selection::caret(prev))
                })
            }
            Key::Named(NamedKey::Delete) if editing_focused => {
                self.edit_focused_input(|val, sel| {
                    if !sel.is_collapsed() {
                        return Self::replace_selection_with(val, sel, "");
                    }
                    if sel.head >= val.len() {
                        return (val.to_string(), sel);
                    }
                    let next = next_char_boundary(val, sel.head);
                    let mut new = String::with_capacity(val.len());
                    new.push_str(&val[..sel.head]);
                    new.push_str(&val[next..]);
                    (new, Selection::caret(sel.head))
                })
            }
            Key::Named(NamedKey::ArrowLeft) if editing_focused => {
                // Word-step modifier: Ctrl on Win/Linux, Option (Alt)
                // on macOS — both common conventions, both supported.
                let word_step = self.modifiers.control_key() || self.modifiers.alt_key();
                self.edit_focused_input(move |val, sel| {
                    let new_head = if word_step {
                        crate::text_nav::word_start(val, sel.head)
                    } else if shift || sel.is_collapsed() {
                        prev_char_boundary(val, sel.head)
                    } else {
                        sel.min()
                    };
                    let anchor = if shift { sel.anchor } else { new_head };
                    (val.to_string(), Selection::range(anchor, new_head))
                })
            }
            Key::Named(NamedKey::ArrowRight) if editing_focused => {
                let word_step = self.modifiers.control_key() || self.modifiers.alt_key();
                self.edit_focused_input(move |val, sel| {
                    let new_head = if word_step {
                        crate::text_nav::word_end(val, sel.head)
                    } else if shift || sel.is_collapsed() {
                        next_char_boundary(val, sel.head)
                    } else {
                        sel.max()
                    };
                    let anchor = if shift { sel.anchor } else { new_head };
                    (val.to_string(), Selection::range(anchor, new_head))
                })
            }
            Key::Named(NamedKey::Home) if editing_focused => {
                self.edit_focused_input(move |val, sel| {
                    let anchor = if shift { sel.anchor } else { 0 };
                    (val.to_string(), Selection::range(anchor, 0))
                })
            }
            Key::Named(NamedKey::End) if editing_focused => {
                self.edit_focused_input(move |val, sel| {
                    let len = val.len();
                    let anchor = if shift { sel.anchor } else { len };
                    (val.to_string(), Selection::range(anchor, len))
                })
            }
            Key::Named(NamedKey::Enter) | Key::Named(NamedKey::Space) if !editing_focused => {
                self.dispatch_focused()
            }
            _ => {
                if editing_focused {
                    if let Some(text) = ev.text.as_deref() {
                        let clean: String = text.chars().filter(|c| !c.is_control()).collect();
                        if !clean.is_empty() {
                            return self.edit_focused_input(|val, sel| {
                                Self::replace_selection_with(val, sel, &clean)
                            });
                        }
                    }
                }
                false
            }
        }
    }

    /// Handle a mouse-up. Dispatches an action only when the pointer
    /// is still over the same actionable that received mouse-down.
    /// Drag-select state clears regardless.
    pub(super) fn handle_click(&mut self) {
        let (px, py) = (self.cursor.x as f32, self.cursor.y as f32);
        let pressed_id = self.pressed.take();
        // Press tint always disappears on release; damage the released
        // button so it repaints in the un-pressed colour.
        if let Some(id) = pressed_id.as_deref() {
            if let Some(r) = self.item_damage_rect(id) {
                self.damage.add_region(r);
            }
        }
        // Resolve the dispatch inside the layout borrow, act on it
        // after the borrow ends — the video playback toggle (feature
        // `video`) needs `&mut self`.
        let mut resolved: Option<(Option<String>, Option<serde_json::Value>)> = None;
        #[cfg(feature = "video")]
        let mut video_target: Option<String> = None;
        // Renderer-local `.videoIntent(...)` on the released item (only
        // set for a node inside a Video subtree — layout resolves that).
        let mut intent: Option<crate::video_v2::VideoIntent> = None;
        if let Some(layout) = self.layout.as_ref() {
            // Exit-animating subtrees are excluded: their ids are
            // engine-side dead, so a click during the exit playback
            // must not dispatch (mirrors the DOM renderer's
            // exiting-subtree event drop).
            if let Some(item) =
                layout.hit_excluding(px, py, &|id| self.animator.is_exit_excluded(&self.tree, id))
            {
                // A click only fires when the press AND release land on
                // the same actionable. `unwrap_or(false)` rejects the
                // case where nothing was pressed (e.g. press landed on
                // an inert area, but layout reflowed an actionable
                // under the cursor before release) — without this,
                // mid-frame patches arriving via `AppEvent::Wake` could
                // dispatch actions the user never aimed at.
                let same_target = pressed_id
                    .as_deref()
                    .map(|id| id == item.node_id)
                    .unwrap_or(false);
                if same_target {
                    resolved = Some((item.action.clone(), item.action_payload.clone()));
                    intent = item.video_intent;
                    #[cfg(feature = "video")]
                    if matches!(item.kind, crate::layout::ItemKind::Video { .. }) {
                        video_target = Some(item.node_id.clone());
                    }
                }
            }
        }
        if let Some((action, payload)) = resolved {
            // Renderer-local intent first: fullscreen is performed HERE,
            // with no dispatch and no module round trip. It is
            // presentation only, so it also stands in for the built-in
            // tap-to-toggle on that tap — a fullscreen button must not
            // pause the player on the way out.
            let intent_handled = match intent {
                Some(i) => {
                    self.perform_video_intent(i);
                    true
                }
                None => false,
            };
            // Feature `video`: a click on a Video surface toggles
            // playback and dispatches the contract play/pause events
            // itself (`App::handle_video_click`). A *derived* `onPlay`
            // item action (payload `type == "play"`, resolved by
            // `resolve_video_play_action`) must then not double-fire;
            // an explicit `.onClick` still dispatches alongside the
            // toggle.
            #[cfg(feature = "video")]
            let toggled = match video_target.as_deref() {
                Some(id) if !intent_handled => self.handle_video_click(id),
                _ => false,
            };
            #[cfg(not(feature = "video"))]
            let toggled = false;
            // The derived `onPlay` action is the built-in's own event:
            // whichever built-in consumed the tap (playback toggle, or a
            // presentation-only intent that replaced it) suppresses it.
            let suppress = (toggled || intent_handled)
                && payload
                    .as_ref()
                    .and_then(|p| p.get("type"))
                    .and_then(|v| v.as_str())
                    == Some("play");
            if !suppress {
                if let Some(action) = action {
                    log::debug!("dispatch action: {action} payload={payload:?}");
                    self.module.dispatch_action(&action, payload);
                }
            }
        }
        self.dragging_input = None;
        // Press release: the only pixels that have changed are the
        // pressed button's rect (tint cleared) and possibly the
        // dispatched action's downstream effect (which arrives via
        // patches and does its own damage). Don't blow up to full
        // damage just because a click happened.
        if let Some(w) = self.window.as_ref() {
            w.request_redraw();
        }
    }
}

/// Resolve the keyboard-activation dispatch (Enter / Space) for the
/// focused id. Exit-animating ids resolve to `None` — a focused button
/// mid-exit dispatches nothing, mirroring the pointer paths'
/// exclusion. Free function so the guard is testable without a
/// GPU-backed `App`.
pub(crate) fn focused_dispatch(
    layout: &LayoutPass,
    focused: Option<&str>,
    excluded: &dyn Fn(&str) -> bool,
) -> Option<(String, Option<serde_json::Value>)> {
    let id = focused?;
    if excluded(id) {
        return None;
    }
    let item = layout.item_by_id(id)?;
    item.action
        .clone()
        .map(|a| (a, item.action_payload.clone()))
}
