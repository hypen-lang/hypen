//! Accessibility semantics carried on IR elements and emitted in patches.
//!
//! Semantics are *derived in the engine* from an element's type (and, in
//! later phases, its children and bound reactive state) and travel to every
//! renderer as a typed field on [`crate::reconcile::Patch::Create`]. Each
//! renderer translates the abstract [`Semantics`] block to its native
//! accessibility API — ARIA attributes on DOM, `Modifier.semantics {}` on
//! Compose, accessibility traits on SwiftUI.
//!
//! This is the carrier the accessibility design settled on instead of
//! stringly-typed `@a11y.*` props (which flowed through the same prop
//! pipeline that silently drops unknown keys). See
//! the accessibility guide (`hypen-docs/content/docs/guide/accessibility.mdx`).
//!
//! [`Semantics::derive`] implements the full derivation table: roles,
//! accessible names (including cross-node child templates via the hoisted
//! `__a11yName` prop), heading levels, reactive form state, `hidden`,
//! landmarks, live regions, and the cross-node reference vocabulary.

use crate::ir::node::{Element, IRNode, Props, Value};
use crate::reactive::Binding;
use serde::{Deserialize, Serialize};

/// An accessibility role — a platform-neutral statement of what a node *is*.
///
/// Roles are emitted only where they are *structurally certain* from the
/// component type. Uncertain cases deliberately emit no role rather than a
/// confident-but-wrong one — a wrong role is worse than none. In particular:
///
/// - `List` is keyed iteration, not a semantic list (it renders a flex
///   container, and people use it for grids/toolbars/galleries) → no role.
///   Authors opt in explicitly when it really is a list.
/// - `Card` is a generic container → no role (a `region` landmark per card
///   would be unnamed-landmark spam).
/// - `Icon` is decorative-or-meaningful — the engine can't tell which → no
///   role; authors mark intent.
/// - `Select` renders a native `<select>` (a listbox-backed control), so it is
///   `Listbox`, **not** `Combobox` — those are different interaction models.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    /// An interactive control that triggers an action.
    Button,
    /// A hyperlink.
    Link,
    /// A block of running text.
    Paragraph,
    /// A heading; pair with [`Semantics::level`] when the level is known.
    Heading,
    /// An image. Serializes to the ARIA token `"img"`.
    #[serde(rename = "img")]
    Img,
    /// A video player. Serializes to the token `"video"` — a Hypen-neutral
    /// token, since ARIA has no video role. Native `<video controls>` is
    /// already accessible; the role exists so the accessible *name* (from a
    /// `title`/`label`/`alt` prop, or an explicit `.label(...)`) has a home
    /// on the block and renderers without native media semantics (Canvas
    /// shadow, iOS, Android, desktop) can label the player. DOM renderers
    /// must treat this token as implicit on their native `<video>` host and
    /// not emit a literal `role="video"` attribute.
    Video,
    /// A single-line or multi-line text input.
    Textbox,
    /// A binary checkbox.
    Checkbox,
    /// An on/off switch.
    Switch,
    /// A listbox-backed select control (NOT an ARIA combobox).
    Listbox,
    /// A range/slider input.
    Slider,
    /// A progress indicator.
    Progressbar,
    /// An advisory status / live region (e.g. a spinner).
    Status,

    // --- Landmark roles (opt-in via `.landmark(...)` / `.role(...)`) ---
    /// Primary navigation landmark.
    Navigation,
    /// The main content landmark.
    Main,
    /// A generic, named region landmark.
    Region,
    /// A search landmark.
    Search,
    /// A banner (site header) landmark.
    Banner,
    /// A content-info (site footer) landmark.
    Contentinfo,
    /// A complementary (sidebar) landmark.
    Complementary,
    /// An explicit list (opt-in, e.g. `List.role("list")`).
    List,
    /// One item of an explicit list. Derived for the direct, role-less
    /// element children of a `list`-role container
    /// (`expand::wire_list_items`); opt-in elsewhere via `.role("listitem")`.
    Listitem,
    /// A modal dialog container (opt-in via `.role("dialog")`). Renderers use
    /// this to wire a focus trap so keyboard focus cycles within the dialog.
    Dialog,

    // --- Composite-widget roles (Tabs / Combobox vocabulary) ---
    /// A container of tabs. Structurally certain for the `Tabs` element;
    /// opt-in elsewhere via `.role("tablist")`. DOM renderers give tablists
    /// roving-tabindex keyboard behaviour.
    Tablist,
    /// One tab in a tablist; pairs with `.selected` self-state and a
    /// `.controls(panelId)` reference to its panel.
    Tab,
    /// The panel a tab controls; pairs with `.labelledby(tabId)`.
    Tabpanel,
    /// One option inside a listbox/combobox popup; the target of
    /// `aria-activedescendant`.
    #[serde(rename = "option")]
    OptionItem,
    /// A combobox host (input + popup). Pairs with `.expanded`,
    /// `.controls(popupId)`, and reactive `.activedescendant`.
    Combobox,
}

impl Role {
    /// Form-control roles whose accessible name must come from an
    /// *associated label* — their content is a value, not a name — and that
    /// do **not** self-label the way `Checkbox`/`Switch` do (those wrap
    /// their visible label text, which becomes their name at derive).
    ///
    /// This is the set eligible for label auto-association
    /// (`expand::wire_form_labels`); the conformance rule
    /// `FormControlMissingLabel` covers this set plus the self-labeling
    /// toggles, so the two stay defined against one vocabulary.
    pub fn needs_external_label(self) -> bool {
        matches!(
            self,
            Role::Textbox | Role::Listbox | Role::Slider | Role::Combobox
        )
    }
}

/// Accessibility semantics for a single element.
///
/// Carried on [`crate::ir::Element`] (computed once during IR expansion) and
/// on [`crate::reconcile::Patch::Create`] (sent to renderers). Every field is
/// optional and skipped when empty, so a node with no semantics serializes to
/// nothing and the wire format is unchanged for the common case.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Semantics {
    /// What this node is. `None` when no role is structurally certain.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<Role>,

    /// Heading level (1–6) when known. `None` on a `Heading` means the level
    /// was not specified — the dev-mode conformance check flags this rather
    /// than silently assuming a level.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub level: Option<u8>,

    /// Whether this node represents in-progress / loading content (e.g. a
    /// spinner). Maps to `aria-busy` on DOM.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub busy: Option<bool>,

    /// Live-region politeness from `.liveRegion("polite" | "assertive")` —
    /// how assistive tech announces content changes inside this node. Maps
    /// to `aria-live` on DOM and the Canvas shadow tree; travels on the
    /// block to the native renderers without translation (no direct analog
    /// is wired yet). Only the two valid tokens derive — an unknown token
    /// derives nothing rather than a wrong announcement mode. Static-only
    /// by design, like [`dir`](Self::dir): politeness is a property of the
    /// region, not of reactive state.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live: Option<String>,

    /// Accessible name derived from the element's static text content, for
    /// roles that require a name (interactive controls). `None` when the name
    /// is not statically derivable — either because the element has no role
    /// that needs one, or because the content is dynamic (a `@{state}`
    /// template, resolved later at reconcile) or absent (see `name_missing`).
    ///
    /// On DOM this is usually *not* applied — the browser computes the
    /// accessible name from visible text content automatically — but it
    /// travels to renderers without that affordance (Canvas shadow, iOS,
    /// Android).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,

    /// `Some(true)` when this element's role *requires* an accessible name but
    /// none could be derived — an icon-only button, or nameable content hidden
    /// behind a control-flow boundary (`ForEach`/`When`/`Router`). The
    /// dev-mode conformance check surfaces these; the fix is an explicit
    /// `.label(...)`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name_missing: Option<bool>,

    /// `Some(true)` when [`name`](Self::name) came from an explicit author
    /// `.label(...)` rather than derived content. Renderers use this to decide
    /// whether to apply the name: a *derived* name is already conveyed by
    /// visible content (so DOM leaves it alone), but an *explicit* label is an
    /// intentional override and is applied as `aria-label`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name_explicit: Option<bool>,

    /// `Some(true)` when the author marked this element decorative via
    /// `.hidden()`. It is removed from the accessibility tree (`aria-hidden` on
    /// DOM); no other semantics apply.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hidden: Option<bool>,

    /// A supplementary description from `.description(...)` — extra context
    /// beyond the name. Maps to `aria-description` on DOM and to the
    /// string-hint accessibility APIs on native platforms.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,

    /// `aria-expanded` for disclosure controls (`.expanded(bool)`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expanded: Option<bool>,

    /// `aria-pressed` for toggle buttons (`.pressed(bool)`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pressed: Option<bool>,

    /// `aria-selected` for selectable items such as tabs (`.selected(bool)`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected: Option<bool>,

    /// `aria-current` token for the current item in a set
    /// (`.current("page" | "step" | "true" | …)`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current: Option<String>,

    /// `aria-checked` state for `Checkbox`/`Switch` controls bound via
    /// `.bind(@state.x)`. Resolved at reconcile from the control's bind-target
    /// prop (`checked` for `Checkbox`, `on` for `Switch`) — see
    /// [`Semantics::with_resolved_state`]. `None` until resolved (the bound
    /// value isn't known at expand time).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checked: Option<bool>,

    /// `aria-invalid` validity state for form controls
    /// (`.invalid(bool | @state.hasError)`). Resolved like the other
    /// self-state fields: a static value derives here, a bound one resolves
    /// at reconcile and stays live via `Patch::SetSemantics`. Consumed by the
    /// DOM renderer only for now (native renderers don't map it yet).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub invalid: Option<bool>,

    /// A *cross-node* relationship: the author-supplied id of the element this
    /// node controls (`.controls(id)`). Maps to `aria-controls` on DOM **only**
    /// — id-reference relationships do not survive to the string-hint native
    /// accessibility APIs (SwiftUI / AccessKit), so this is a web-leaning
    /// affordance. See the guide's "Platform support" section
    /// (`hypen-docs/content/docs/guide/accessibility.mdx`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub controls: Option<String>,

    /// A *cross-node* relationship: the author-supplied id of the element that
    /// describes this node (`.describedby(id)`). Maps to `aria-describedby` on
    /// DOM **only** — web-leaning for the same reason as
    /// [`controls`](Self::controls).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub describedby: Option<String>,

    /// The author-supplied stable id of *this* node (`.id("details-panel")`)
    /// — the anchor the id-reference relationships (`controls`/`describedby`/
    /// `labelledby`/`activeDescendant`) resolve against. Maps to the DOM `id`
    /// attribute. Travels on the block so a renderer that later grows a
    /// faithful id→node mapping (AccessKit) can consume it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,

    /// A *cross-node* relationship: the author-supplied id of the element that
    /// labels this node (`.labelledby(id)`) — the tabpanel→tab half of the
    /// Tabs pattern. Maps to `aria-labelledby` on DOM **only**.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub labelledby: Option<String>,

    /// A *reactive* cross-node reference: the author-supplied id of the
    /// currently-active descendant (`.activedescendant(@state.focusedId)`) —
    /// the roving focus pointer of composite widgets (combobox, listbox).
    /// Unlike `controls`/`describedby`, this is expected to be *bound*: a
    /// static value derives here, a bound one resolves at reconcile
    /// ([`with_resolved_state`](Self::with_resolved_state)) and re-emits via
    /// `Patch::SetSemantics` when its source path changes. Maps to
    /// `aria-activedescendant` on DOM **only**.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_descendant: Option<String>,

    /// A *cross-node* relationship: the author-supplied id of an element that
    /// is logically this node's child even though it is rendered elsewhere
    /// (`.owns(id)`) — a popup listbox portaled out of its combobox's
    /// subtree. Maps to `aria-owns` on DOM **only**.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owns: Option<String>,

    /// Text direction from `.dir("rtl" | "ltr" | "auto")` — the base
    /// direction of this node's text content, for mixed-direction UIs.
    /// Maps to the HTML `dir` attribute on DOM; native renderers translate
    /// to their layout-direction APIs (follow-up). Only the three valid
    /// tokens derive; an unknown token is ignored (no direction rather than
    /// a wrong one) and flagged by the `UnknownDirToken` conformance rule.
    /// Static-only by design — direction is a property of the content's
    /// language, not of reactive state, so a bound value is not resolved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dir: Option<String>,
}

impl Semantics {
    /// Derive semantics for an element from its type, props, and content.
    ///
    /// Returns `None` when the element carries no derivable semantics, so
    /// callers store `Option<Semantics>` and skip both allocation and
    /// serialization entirely for elements that have none.
    ///
    /// Only *structurally certain* roles are emitted; see [`Role`] for the
    /// types that deliberately derive nothing. For roles that require an
    /// accessible name (interactive controls), the name is derived from the
    /// element's static text content — see [`derive_name`].
    pub fn derive(element: &Element) -> Option<Self> {
        // `.hidden()` makes the element decorative: removed from the
        // accessibility tree, so no other semantics apply.
        if read_flag(&element.props, "hidden.0") {
            return Some(Semantics {
                hidden: Some(true),
                ..Self::default()
            });
        }

        let mut level = None;
        let mut busy = None;

        let role = match element.element_type.as_str() {
            "Button" => Some(Role::Button),
            "Link" => Some(Role::Link),
            "Paragraph" => Some(Role::Paragraph),
            "Heading" => {
                level = read_level(&element.props);
                Some(Role::Heading)
            }
            "Image" => Some(Role::Img),
            "Video" => Some(Role::Video),
            "Input" | "TextArea" => Some(Role::Textbox),
            "Checkbox" => Some(Role::Checkbox),
            "Switch" => Some(Role::Switch),
            "Select" => Some(Role::Listbox),
            "Slider" => Some(Role::Slider),
            // A media timeline is a slider to assistive tech; renderers
            // supply the value text (elapsed/duration) at runtime.
            "Scrubber" => Some(Role::Slider),
            "ProgressBar" => Some(Role::Progressbar),
            "Spinner" => {
                busy = Some(true);
                Some(Role::Status)
            }
            // Composite-widget types: unambiguous names, structurally certain.
            "Tabs" => Some(Role::Tablist),
            "Tab" => Some(Role::Tab),
            "TabPanel" => Some(Role::Tabpanel),
            "Option" => Some(Role::OptionItem),
            "Combobox" => Some(Role::Combobox),
            // Structural containers, control-flow, and intentionally-ambiguous
            // types (List/Card/Icon) derive nothing.
            _ => None,
        };

        // An explicit `.landmark(...)` / `.role(...)` opt-in overrides the
        // structural role — this is how the de-risked types (List/Card/generic
        // containers) acquire a role when the author intends one.
        let role = explicit_role(&element.props).or(role);

        let (name, name_explicit, name_missing) = derive_accessible_name(role, element);
        let description = read_static_string(&element.props, "description.0");

        let semantics = Semantics {
            role,
            level,
            busy,
            live: read_live_token(&element.props, "liveRegion.0"),
            name,
            name_missing,
            name_explicit,
            hidden: None,
            description,
            // Self-state from applicators (static here; bound values resolve at
            // reconcile in a later step).
            expanded: read_bool(&element.props, "expanded.0"),
            pressed: read_bool(&element.props, "pressed.0"),
            selected: read_bool(&element.props, "selected.0"),
            current: read_static_string(&element.props, "current.0"),
            // Bound checkbox/switch state resolves at reconcile, not here.
            checked: None,
            invalid: read_bool(&element.props, "invalid.0"),
            // Cross-node relationships: author-supplied target ids (static).
            controls: read_static_string(&element.props, "controls.0"),
            describedby: read_static_string(&element.props, "describedby.0"),
            // The id-reference anchor and the remaining reference vocabulary.
            id: read_static_string(&element.props, "id.0"),
            labelledby: read_static_string(&element.props, "labelledby.0"),
            // Usually bound (`.activedescendant(@state.x)`) — a static value
            // derives here, a bound one resolves at reconcile.
            active_descendant: read_static_string(&element.props, "activedescendant.0"),
            owns: read_static_string(&element.props, "owns.0"),
            dir: read_dir_token(&element.props, "dir.0"),
        };

        // A *bound* deferred prop (`.expanded(@state.open)` on a bare Column,
        // `.activedescendant(@state.focused)`, `.id("opt-@{item.id}")` in a
        // ForEach) contributes nothing statically, but the block must still
        // exist so reconcile has a base to resolve into — otherwise the
        // binding is silently dropped on elements with no other derivable
        // semantics. An all-default block serializes to `{}`, so the wire
        // cost is nil.
        let has_bound_deferred = [
            "expanded.0",
            "pressed.0",
            "selected.0",
            "current.0",
            "invalid.0",
            "id.0",
            "controls.0",
            "describedby.0",
            "labelledby.0",
            "owns.0",
            "activedescendant.0",
        ]
        .iter()
        .any(|key| {
            matches!(
                element.props.get(*key),
                Some(Value::Binding(_)) | Some(Value::TemplateString { .. })
            )
        });

        (semantics != Semantics::default() || has_bound_deferred).then_some(semantics)
    }

    /// Resolve a *deferred* (templated) accessible name from already-resolved
    /// props at reconcile time, returning the updated block.
    ///
    /// No-op unless this is a name-requiring role (button/link/img) whose name
    /// was not statically derivable at expand (a `@{state}` template in the
    /// element's own text/`alt` prop). The resolved value comes from the
    /// element's own resolved props; cross-node child templates are not
    /// resolved here.
    pub fn with_resolved_name(
        mut self,
        resolved: &indexmap::IndexMap<String, serde_json::Value>,
    ) -> Self {
        let needs = matches!(
            self.role,
            Some(Role::Button)
                | Some(Role::Link)
                | Some(Role::Img)
                | Some(Role::Video)
                | Some(Role::Checkbox)
                | Some(Role::Switch)
                | Some(Role::Tab)
                | Some(Role::OptionItem)
        );
        if !needs
            || self.name.is_some()
            || self.name_missing.is_some()
            || self.hidden == Some(true)
        {
            return self;
        }

        // `__a11yName` first: the hoisted child-spanning template (see
        // `hoisted_name_template`) is the full concatenation, including any
        // own text, so it supersedes the own-prop keys when present.
        let keys: &[&str] = match self.role {
            Some(Role::Img) => &["alt"],
            Some(Role::Video) => &["title", "title.0", "label", "alt"],
            Some(Role::Checkbox) | Some(Role::Switch) => &["0", "label"],
            _ => &["__a11yName", "0", "text"],
        };
        for key in keys {
            if let Some(text) = resolved.get(*key).and_then(|v| v.as_str()) {
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    self.name = Some(trimmed.to_string());
                    break;
                }
            }
        }
        self
    }

    /// Resolve the `aria-checked` state for a bound `Checkbox`/`Switch` from
    /// already-resolved props at reconcile time, returning the updated block.
    ///
    /// `.bind(@state.x)` writes the bound value into the control's bind-target
    /// prop (`checked` for `Checkbox`, `on` for `Switch`). Those props are not
    /// stripped, so they survive into the resolved props here. No-op unless the
    /// role is `Checkbox`/`Switch` and the relevant prop resolved to a JSON
    /// bool.
    ///
    /// Reactive *updates* after the initial render (re-emitting `checked` when
    /// the bound state changes) are not yet handled here.
    pub fn with_resolved_state(
        mut self,
        resolved: &indexmap::IndexMap<String, serde_json::Value>,
    ) -> Self {
        // `aria-checked` from the Checkbox/Switch bind target.
        let checked_key = match self.role {
            Some(Role::Checkbox) => Some("checked"),
            Some(Role::Switch) => Some("on"),
            _ => None,
        };
        if let Some(key) = checked_key {
            if self.checked.is_none() {
                if let Some(b) = resolved.get(key).and_then(|v| v.as_bool()) {
                    self.checked = Some(b);
                }
            }
        }

        // Self-state applicators (.expanded/.pressed/.selected/.current) whose
        // value was a `@{state}` binding deferred at expand. The applicator
        // props are intentionally NOT stripped, so the resolved value is
        // available here. Without this, a bound `.expanded(@state.open)` would
        // silently emit nothing — the "worse than nothing" trap.
        if self.expanded.is_none() {
            self.expanded = resolved.get("expanded.0").and_then(|v| v.as_bool());
        }
        if self.pressed.is_none() {
            self.pressed = resolved.get("pressed.0").and_then(|v| v.as_bool());
        }
        if self.selected.is_none() {
            self.selected = resolved.get("selected.0").and_then(|v| v.as_bool());
        }
        if self.invalid.is_none() {
            self.invalid = resolved.get("invalid.0").and_then(|v| v.as_bool());
        }
        if self.current.is_none() {
            self.current = resolved
                .get("current.0")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
        }

        // Cross-node id references: `.id`/`.controls`/`.describedby`/
        // `.labelledby`/`.owns`/`.activedescendant`. The applicator props are
        // not stripped (like the self-state props), so a bound or templated
        // value (`.id("opt-@{item.id}")` inside a ForEach — the "auto-minted
        // option ids" case, minted from the author's own item data) resolves
        // here — and re-resolves on every dirty render, which is what makes
        // `aria-activedescendant` track arrow-key state through the
        // SetSemantics re-emit. Unlike the fields above, these are NOT
        // `is_none`-guarded against overwrite: `with_resolved_state` always
        // runs on the *base* (derive-time) block where a bound value is None,
        // and an *empty* resolved value must also clear a previously-set one,
        // so recompute unconditionally when the prop is present.
        fn resolve_reference(
            resolved: &indexmap::IndexMap<String, serde_json::Value>,
            key: &str,
            field: &mut Option<String>,
        ) {
            if let Some(value) = resolved.get(key) {
                *field = value
                    .as_str()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string);
            }
        }
        resolve_reference(resolved, "id.0", &mut self.id);
        resolve_reference(resolved, "controls.0", &mut self.controls);
        resolve_reference(resolved, "describedby.0", &mut self.describedby);
        resolve_reference(resolved, "labelledby.0", &mut self.labelledby);
        resolve_reference(resolved, "owns.0", &mut self.owns);
        resolve_reference(resolved, "activedescendant.0", &mut self.active_descendant);
        self
    }
}

/// Resolve an element's accessible name, preferring an explicit author
/// `.label(...)` over content-derived names.
///
/// Returns `(name, explicit, missing)`. An explicit static label always wins
/// and clears any "missing" flag; a templated `.label(@{state.x})` defers to
/// reconcile (neither name nor missing); otherwise the name is derived from
/// content per [`derive_name`].
fn derive_accessible_name(
    role: Option<Role>,
    element: &Element,
) -> (Option<String>, Option<bool>, Option<bool>) {
    match explicit_label(&element.props) {
        Some(TextCollection::Static(label)) => (Some(label), Some(true), None),
        // A dynamic label — author-supplied, so not "missing", just resolved
        // later at reconcile.
        Some(TextCollection::Templated { .. }) => (None, None, None),
        // No usable explicit label → fall back to content-derived name.
        _ => {
            let (name, missing) = derive_name(role, element);
            (name, None, missing)
        }
    }
}

/// Read an explicit accessibility label from the `.label(...)` *applicator*
/// (prop key `label.0`). Deliberately ignores a bare `label` prop, which some
/// components (e.g. `Checkbox(label: …)`) use for their own visible label.
fn explicit_label(props: &Props) -> Option<TextCollection> {
    Some(classify_text_value(props.get("label.0")?))
}

/// Whether a boolean flag prop (e.g. the `hidden.0` produced by a zero-arg
/// `.hidden()` applicator) is present and true.
fn read_flag(props: &Props, key: &str) -> bool {
    matches!(props.get(key), Some(Value::Static(serde_json::Value::Bool(true))))
}

/// Read a static boolean prop. `None` when absent or dynamic (a bound value
/// resolves later at reconcile rather than being guessed here).
fn read_bool(props: &Props, key: &str) -> Option<bool> {
    match props.get(key) {
        Some(Value::Static(serde_json::Value::Bool(b))) => Some(*b),
        _ => None,
    }
}

/// Classify a Checkbox/Switch visible label (positional `0` or named `label`).
/// This is the control's accessible name; the `.label(...)` a11y applicator
/// (key `label.0`) is handled separately and overrides it.
fn control_label(props: &Props) -> TextCollection {
    for key in ["0", "label"] {
        if let Some(value) = props.get(key) {
            return classify_text_value(value);
        }
    }
    TextCollection::Empty
}

/// Read a non-empty static string prop (trimmed), if present.
fn read_static_string(props: &Props, key: &str) -> Option<String> {
    match props.get(key) {
        Some(Value::Static(serde_json::Value::String(s))) if !s.trim().is_empty() => {
            Some(s.trim().to_string())
        }
        _ => None,
    }
}

/// An explicit role from a `.role(token)` or `.landmark(token)` applicator.
/// Unrecognised tokens are ignored (no role rather than a wrong one).
fn explicit_role(props: &Props) -> Option<Role> {
    for key in ["role.0", "landmark.0"] {
        if let Some(Value::Static(serde_json::Value::String(token))) = props.get(key) {
            if let Some(role) = role_from_token(token) {
                return Some(role);
            }
        }
    }
    None
}

/// Whether `token` is a role/landmark token the engine recognises (used by the
/// conformance checker to flag typos like `.role("buton")`).
pub fn is_known_role_token(token: &str) -> bool {
    role_from_token(token).is_some()
}

/// Whether `token` is a text-direction token the engine recognises (used by
/// the conformance checker to flag typos like `.dir("rlt")`).
pub fn is_known_dir_token(token: &str) -> bool {
    matches!(
        token.trim().to_ascii_lowercase().as_str(),
        "rtl" | "ltr" | "auto"
    )
}

/// Read a validated `.dir(...)` token, normalised to lowercase. Unrecognised
/// tokens derive nothing — the conformance pass surfaces the typo instead of
/// this silently emitting a wrong direction.
fn read_dir_token(props: &Props, key: &str) -> Option<String> {
    read_static_string(props, key)
        .map(|t| t.to_ascii_lowercase())
        .filter(|t| is_known_dir_token(t))
}

/// Whether `token` is a live-region politeness token the engine recognises
/// (`polite` / `assertive` — the two `aria-live` announcement modes).
pub fn is_known_live_token(token: &str) -> bool {
    matches!(
        token.trim().to_ascii_lowercase().as_str(),
        "polite" | "assertive"
    )
}

/// Read a validated `.liveRegion(...)` token, normalised to lowercase.
/// Unrecognised tokens derive nothing — no announcement mode rather than a
/// wrong one.
fn read_live_token(props: &Props, key: &str) -> Option<String> {
    read_static_string(props, key)
        .map(|t| t.to_ascii_lowercase())
        .filter(|t| is_known_live_token(t))
}

/// Map an author-supplied ARIA-style token to a [`Role`].
fn role_from_token(token: &str) -> Option<Role> {
    match token.trim().to_ascii_lowercase().as_str() {
        "button" => Some(Role::Button),
        "link" => Some(Role::Link),
        "list" => Some(Role::List),
        "listitem" => Some(Role::Listitem),
        "navigation" | "nav" => Some(Role::Navigation),
        "main" => Some(Role::Main),
        "region" => Some(Role::Region),
        "search" => Some(Role::Search),
        "banner" | "header" => Some(Role::Banner),
        "contentinfo" | "footer" => Some(Role::Contentinfo),
        "complementary" | "aside" => Some(Role::Complementary),
        "dialog" => Some(Role::Dialog),
        "tablist" => Some(Role::Tablist),
        "tab" => Some(Role::Tab),
        "tabpanel" => Some(Role::Tabpanel),
        "option" => Some(Role::OptionItem),
        "combobox" => Some(Role::Combobox),
        "listbox" => Some(Role::Listbox),
        _ => None,
    }
}

/// Derive the accessible name (and missing flag) for an element, given its
/// already-computed role.
///
/// Only roles that *require* a name (interactive controls) get one; for
/// everything else the name is left unset. The name is gathered from static
/// text content, excluding `Icon` children, and **not** crossing control-flow
/// boundaries — content behind a `ForEach`/`When`/`Router` is treated as
/// missing (the author should supply an explicit label), not guessed.
fn derive_name(role: Option<Role>, element: &Element) -> (Option<String>, Option<bool>) {
    let collection = match role {
        // Controls whose accessible name comes from their text content.
        // Tabs and options are named by their visible text like buttons.
        Some(Role::Button) | Some(Role::Link) | Some(Role::Tab) | Some(Role::OptionItem) => {
            collect_text(element)
        }
        // An image's name is its alt text, not its content.
        Some(Role::Img) => image_alt(&element.props),
        // A video's name comes from a `title`/`label`/`alt` prop — its
        // content is a media stream, not nameable text.
        Some(Role::Video) => video_label(&element.props),
        // Checkbox/Switch render a `<label>` wrapping the control, so their
        // visible label text (positional `0` or named `label`) IS the
        // accessible name — including `Checkbox(label: "Accept")`, which must
        // not be flagged unlabeled.
        Some(Role::Checkbox) | Some(Role::Switch) => control_label(&element.props),
        _ => return (None, None),
    };

    match collection {
        // Fully static content → that's the name.
        TextCollection::Static(s) => (Some(s), None),
        // No text at all (icon-only image/button), or nameable content gated
        // behind control flow → required-but-missing.
        TextCollection::Empty | TextCollection::ControlFlow => (None, Some(true)),
        // Content includes a `@{state}` template — derivable, but only once
        // resolved at reconcile (a later step). Defer: neither name nor
        // missing. Child-spanning templates are hoisted onto the parent as
        // the synthetic `__a11yName` prop — see [`hoisted_name_template`].
        TextCollection::Templated { .. } => (None, None),
    }
}

/// Recover a *hoistable* name template for a content-named element whose
/// nameable text is dynamic and spans children — the
/// `Button { Text("@{state.x}") }` case, where the child's template cannot
/// be resolved from the parent's own props at reconcile.
///
/// Returns the concatenated template (with its bindings) for expand to write
/// onto the parent as the synthetic `__a11yName` prop: the bindings then
/// register as *parent* dependencies (a child text change dirties the parent
/// and re-emits `Patch::SetSemantics`), and
/// [`Semantics::with_resolved_name`] reads the resolved value as a name
/// source. `None` whenever the name is already settled at derive (static,
/// explicit, missing, hidden), an author `.label(...)` — static or templated
/// — owns the name, or the element has no children (its own templated text
/// prop already resolves through `with_resolved_name`'s `0`/`text` keys).
pub(crate) fn hoisted_name_template(element: &Element) -> Option<Value> {
    let sem = element.semantics.as_ref()?;
    // Only content-named roles hoist; Img/Checkbox/Switch name from their
    // own props, which with_resolved_name already reads directly.
    if !matches!(
        sem.role,
        Some(Role::Button) | Some(Role::Link) | Some(Role::Tab) | Some(Role::OptionItem)
    ) {
        return None;
    }
    if sem.hidden == Some(true)
        || sem.name.is_some()
        || sem.name_missing.is_some()
        || element.props.contains_key("label.0")
        || element.ir_children.is_empty()
    {
        return None;
    }
    match collect_text(element) {
        TextCollection::Templated { template, bindings } if !bindings.is_empty() => {
            Some(Value::TemplateString { template, bindings })
        }
        _ => None,
    }
}

/// Classify an image's `alt` text (named arg or `.alt(...)` applicator).
fn image_alt(props: &Props) -> TextCollection {
    for key in ["alt", "alt.0"] {
        let Some(value) = props.get(key) else { continue };
        return classify_text_value(value);
    }
    TextCollection::Empty
}

/// Classify a video's accessible label: a `title` prop (named arg or
/// `.title(...)` applicator), or the `label`/`alt` named args for parity with
/// the other self-naming media/controls. The `.label(...)` a11y applicator
/// (key `label.0`) is handled separately and overrides all of these.
fn video_label(props: &Props) -> TextCollection {
    for key in ["title", "title.0", "label", "alt"] {
        let Some(value) = props.get(key) else { continue };
        return classify_text_value(value);
    }
    TextCollection::Empty
}

/// The outcome of gathering an element's nameable text content.
enum TextCollection {
    /// Concatenated static text.
    Static(String),
    /// No nameable text was found.
    Empty,
    /// At least one fragment is a `@{state}` binding/template (dynamic).
    /// Carries the recovered concatenated template text and its bindings so
    /// expand can hoist a child-spanning name onto the parent
    /// ([`hoisted_name_template`]).
    Templated {
        template: String,
        bindings: Vec<Binding>,
    },
    /// A control-flow boundary (`ForEach`/`When`/`Router`) was encountered;
    /// the name is not statically derivable.
    ControlFlow,
}

impl TextCollection {
    /// Combine two collections. Precedence: a control-flow boundary makes the
    /// whole name underivable; otherwise any dynamic fragment makes the whole
    /// name templated (static fragments fold into the template text);
    /// otherwise static fragments concatenate.
    fn merge(self, other: TextCollection) -> TextCollection {
        use TextCollection::*;
        match (self, other) {
            (ControlFlow, _) | (_, ControlFlow) => ControlFlow,
            (
                Templated {
                    template: a,
                    bindings: mut ab,
                },
                Templated {
                    template: b,
                    bindings: bb,
                },
            ) => {
                // Dedupe so a binding used by several fragments registers as
                // one dependency, matching template-extraction behaviour.
                for binding in bb {
                    if !ab.contains(&binding) {
                        ab.push(binding);
                    }
                }
                Templated {
                    template: format!("{a} {b}"),
                    bindings: ab,
                }
            }
            (Static(a), Templated { template, bindings }) => Templated {
                template: format!("{a} {template}"),
                bindings,
            },
            (Templated { template, bindings }, Static(b)) => Templated {
                template: format!("{template} {b}"),
                bindings,
            },
            (t @ Templated { .. }, Empty) | (Empty, t @ Templated { .. }) => t,
            (Static(a), Static(b)) => Static(format!("{a} {b}")),
            (Static(a), Empty) | (Empty, Static(a)) => Static(a),
            (Empty, Empty) => Empty,
        }
    }
}

/// Classify a string-ish prop value as nameable text: static content, a
/// templated fragment (with its recovered source text + bindings), or
/// nothing. The single classification every name source shares — own text,
/// explicit label, control label, image alt.
fn classify_text_value(value: &Value) -> TextCollection {
    match value {
        Value::Static(serde_json::Value::String(s)) if !s.trim().is_empty() => {
            TextCollection::Static(s.trim().to_string())
        }
        Value::Binding(binding) => TextCollection::Templated {
            template: format!("@{{{}}}", binding.full_path_with_source()),
            bindings: vec![binding.clone()],
        },
        Value::TemplateString { template, bindings } => TextCollection::Templated {
            template: template.clone(),
            bindings: bindings.clone(),
        },
        // Empty strings, non-string statics, actions, resources → no name.
        _ => TextCollection::Empty,
    }
}

/// Recursively gather nameable text from an element and its descendants,
/// excluding `Icon` children (they contribute a glyph, not a name).
fn collect_text(element: &Element) -> TextCollection {
    let mut acc = own_text(&element.props).unwrap_or(TextCollection::Empty);

    for child in &element.ir_children {
        let child_text = match child {
            IRNode::Element(e) if e.element_type == "Icon" => continue,
            IRNode::Element(e) => collect_text(e),
            // Any control-flow child means the nameable content is not static.
            IRNode::ForEach { .. } | IRNode::Conditional { .. } | IRNode::Router { .. } => {
                TextCollection::ControlFlow
            }
        };
        acc = acc.merge(child_text);
    }

    acc
}

/// Read an element's own text content from its `0` (positional) or `text`
/// prop, classifying it as static, dynamic, or absent.
fn own_text(props: &Props) -> Option<TextCollection> {
    for key in ["0", "text"] {
        let Some(value) = props.get(key) else { continue };
        return Some(classify_text_value(value));
    }
    None
}

/// Read a heading level (clamped to 1–6) from `level` / `level.0` props.
/// Accepts the named-argument form (`Heading("x", level: 2)`) and the
/// applicator form (`.level(2)`).
fn read_level(props: &Props) -> Option<u8> {
    for key in ["level", "level.0"] {
        if let Some(Value::Static(v)) = props.get(key) {
            // The parser models numbers as f64, so a literal `level: 2` arrives
            // as a JSON float; accept both integer and float encodings.
            let n = v.as_u64().or_else(|| v.as_f64().map(|f| f as u64));
            if let Some(n) = n {
                return Some(n.clamp(1, 6) as u8);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ir::node::Props;
    use indexmap::indexmap;
    use serde_json::json;

    fn derive(ty: &str) -> Option<Semantics> {
        Semantics::derive(&Element::new(ty))
    }

    fn role_of(ty: &str) -> Option<Role> {
        derive(ty).and_then(|s| s.role)
    }

    /// Build a Text element carrying static content at prop `0`.
    fn text(content: &str) -> Element {
        Element::new("Text").with_prop("0", Value::Static(json!(content)))
    }

    /// Build an element of `ty` with the given children.
    fn with_children(ty: &str, children: Vec<Element>) -> Element {
        let mut el = Element::new(ty);
        el.ir_children = children.into_iter().map(IRNode::Element).collect();
        el
    }

    #[test]
    fn derives_structurally_certain_roles() {
        assert_eq!(role_of("Button"), Some(Role::Button));
        assert_eq!(role_of("Link"), Some(Role::Link));
        assert_eq!(role_of("Paragraph"), Some(Role::Paragraph));
        assert_eq!(role_of("Heading"), Some(Role::Heading));
        assert_eq!(role_of("Image"), Some(Role::Img));
        assert_eq!(role_of("Video"), Some(Role::Video));
        assert_eq!(role_of("Input"), Some(Role::Textbox));
        assert_eq!(role_of("TextArea"), Some(Role::Textbox));
        assert_eq!(role_of("Checkbox"), Some(Role::Checkbox));
        assert_eq!(role_of("Switch"), Some(Role::Switch));
        assert_eq!(role_of("Slider"), Some(Role::Slider));
        assert_eq!(role_of("ProgressBar"), Some(Role::Progressbar));
    }

    #[test]
    fn select_is_listbox_not_combobox() {
        // A native <select> is listbox-backed, not an ARIA combobox.
        assert_eq!(role_of("Select"), Some(Role::Listbox));
    }

    #[test]
    fn spinner_is_a_busy_status() {
        let s = derive("Spinner").unwrap();
        assert_eq!(s.role, Some(Role::Status));
        assert_eq!(s.busy, Some(true));
    }

    #[test]
    fn ambiguous_and_structural_types_derive_nothing() {
        // The de-risked cases: a confident wrong role is worse than none.
        // List is keyed iteration, Card is a generic container, Icon is
        // decorative-or-meaningful — none get an automatic role.
        for ty in ["List", "Card", "Icon", "Text", "Column", "Row", "Stack", "Whatever"] {
            assert_eq!(derive(ty), None, "{ty} must not derive semantics");
        }
    }

    fn heading_with_props(props: Props) -> Element {
        let mut el = Element::new("Heading");
        *el.props.make_mut() = props.inner().clone();
        el
    }

    #[test]
    fn heading_reads_level_from_named_and_applicator_props() {
        let named = Props::from_map(indexmap! { "level".to_string() => Value::Static(json!(3)) });
        assert_eq!(Semantics::derive(&heading_with_props(named)).unwrap().level, Some(3));

        let applied =
            Props::from_map(indexmap! { "level.0".to_string() => Value::Static(json!(1)) });
        assert_eq!(Semantics::derive(&heading_with_props(applied)).unwrap().level, Some(1));

        // Out-of-range levels clamp into 1..=6.
        let big = Props::from_map(indexmap! { "level".to_string() => Value::Static(json!(9)) });
        assert_eq!(Semantics::derive(&heading_with_props(big)).unwrap().level, Some(6));
    }

    #[test]
    fn button_derives_its_name_from_own_text() {
        let el = Element::new("Button").with_prop("0", Value::Static(json!("Save")));
        let s = Semantics::derive(&el).unwrap();
        assert_eq!(s.name.as_deref(), Some("Save"));
        assert_eq!(s.name_missing, None);
    }

    #[test]
    fn button_derives_name_from_text_children_excluding_icons() {
        // Button { Icon("trash") Text("Delete") } → name "Delete" (icon excluded).
        let el = with_children(
            "Button",
            vec![Element::new("Icon").with_prop("0", Value::Static(json!("trash"))), text("Delete")],
        );
        assert_eq!(Semantics::derive(&el).unwrap().name.as_deref(), Some("Delete"));
    }

    #[test]
    fn button_concatenates_nested_text() {
        // Button { Column { Text("a") Text("b") } } → "a b".
        let el = with_children("Button", vec![with_children("Column", vec![text("a"), text("b")])]);
        assert_eq!(Semantics::derive(&el).unwrap().name.as_deref(), Some("a b"));
    }

    #[test]
    fn icon_only_button_is_name_missing() {
        let el = with_children(
            "Button",
            vec![Element::new("Icon").with_prop("0", Value::Static(json!("trash")))],
        );
        let s = Semantics::derive(&el).unwrap();
        assert_eq!(s.name, None);
        assert_eq!(s.name_missing, Some(true));
    }

    #[test]
    fn content_behind_control_flow_is_name_missing() {
        // A nameable child gated by a When/ForEach can't be derived statically.
        let mut el = Element::new("Button");
        el.ir_children = vec![IRNode::Conditional {
            value: Value::Static(json!("x")),
            branches: vec![],
            fallback: None,
            module_scope: None,
        }];
        let s = Semantics::derive(&el).unwrap();
        assert_eq!(s.name, None);
        assert_eq!(s.name_missing, Some(true));
    }

    #[test]
    fn templated_name_is_deferred_not_missing() {
        // Button("@{state.label}") → name resolved later at reconcile, so it is
        // neither derived nor flagged missing here.
        use crate::reactive::Binding;
        let el = Element::new("Button").with_prop(
            "0",
            Value::Binding(Binding::state(vec!["label".to_string()])),
        );
        let s = Semantics::derive(&el).unwrap();
        assert_eq!(s.name, None);
        assert_eq!(s.name_missing, None);
        assert_eq!(s.role, Some(Role::Button));
    }

    #[test]
    fn image_name_comes_from_alt() {
        let described = Element::new("Image").with_prop("alt", Value::Static(json!("A cat")));
        let s = Semantics::derive(&described).unwrap();
        assert_eq!(s.name.as_deref(), Some("A cat"));
        assert_eq!(s.name_missing, None);

        // No alt → required-but-missing.
        let bare = Element::new("Image").with_prop("src", Value::Static(json!("/a.png")));
        let s = Semantics::derive(&bare).unwrap();
        assert_eq!(s.role, Some(Role::Img));
        assert_eq!(s.name_missing, Some(true));
    }

    #[test]
    fn video_name_comes_from_title_label_or_alt() {
        // `title` named arg is the primary label source.
        let titled = Element::new("Video").with_prop("title", Value::Static(json!("Big Buck Bunny")));
        let s = Semantics::derive(&titled).unwrap();
        assert_eq!(s.name.as_deref(), Some("Big Buck Bunny"));
        assert_eq!(s.name_missing, None);

        // `label` and `alt` named args work too (parity with Image/Checkbox).
        let labelled = Element::new("Video").with_prop("label", Value::Static(json!("Trailer")));
        assert_eq!(Semantics::derive(&labelled).unwrap().name.as_deref(), Some("Trailer"));

        // No title/label/alt → required-but-missing, like an alt-less Image.
        let bare = Element::new("Video").with_prop("src", Value::Static(json!("/a.mp4")));
        let s = Semantics::derive(&bare).unwrap();
        assert_eq!(s.role, Some(Role::Video));
        assert_eq!(s.name_missing, Some(true));

        // An explicit `.label(...)` applicator overrides and is explicit.
        let explicit = with_label(
            Element::new("Video").with_prop("src", Value::Static(json!("/a.mp4"))),
            "Product demo",
        );
        let s = Semantics::derive(&explicit).unwrap();
        assert_eq!(s.name.as_deref(), Some("Product demo"));
        assert_eq!(s.name_explicit, Some(true));
        assert_eq!(s.name_missing, None);
    }

    #[test]
    fn templated_video_title_resolves_at_reconcile() {
        use crate::reactive::Binding;
        // Video(title: @state.videoTitle) → deferred at derive, resolved from
        // the reconcile-time props via with_resolved_name.
        let el = Element::new("Video").with_prop(
            "title",
            Value::Binding(Binding::state(vec!["videoTitle".to_string()])),
        );
        let s = Semantics::derive(&el).unwrap();
        assert_eq!(s.name, None);
        assert_eq!(s.name_missing, None);

        let resolved = indexmap! { "title".to_string() => json!("Episode 2") };
        assert_eq!(s.with_resolved_name(&resolved).name.as_deref(), Some("Episode 2"));
    }

    #[test]
    fn non_interactive_roles_get_no_name() {
        // Headings/paragraphs/images don't take a content-derived accessible
        // name in this phase.
        let el = Element::new("Paragraph").with_prop("0", Value::Static(json!("body")));
        let s = Semantics::derive(&el).unwrap();
        assert_eq!(s.name, None);
        assert_eq!(s.name_missing, None);
    }

    #[test]
    fn heading_without_level_emits_role_but_no_level() {
        // Level unspecified ⇒ no silent default (the conformance check warns).
        let s = derive("Heading").unwrap();
        assert_eq!(s.role, Some(Role::Heading));
        assert_eq!(s.level, None);
    }

    #[test]
    fn role_tokens_serialize_to_aria_vocabulary() {
        let button = Element::new("Button").with_prop("0", Value::Static(json!("Save")));
        assert_eq!(
            serde_json::to_string(&Semantics::derive(&button).unwrap()).unwrap(),
            r#"{"role":"button","name":"Save"}"#
        );
        // Image serializes to the ARIA token "img", not "image"; alt → name.
        let image = Element::new("Image").with_prop("alt", Value::Static(json!("Logo")));
        assert_eq!(
            serde_json::to_string(&Semantics::derive(&image).unwrap()).unwrap(),
            r#"{"role":"img","name":"Logo"}"#
        );
        assert_eq!(
            serde_json::to_string(&derive("Spinner").unwrap()).unwrap(),
            r#"{"role":"status","busy":true}"#
        );
        // Video serializes to the Hypen-neutral token "video"; title → name.
        let video = Element::new("Video").with_prop("title", Value::Static(json!("Intro")));
        assert_eq!(
            serde_json::to_string(&Semantics::derive(&video).unwrap()).unwrap(),
            r#"{"role":"video","name":"Intro"}"#
        );
    }

    #[test]
    fn empty_interactive_control_serializes_name_missing() {
        // A Button with no content is name-missing on the wire.
        assert_eq!(
            serde_json::to_string(&derive("Button").unwrap()).unwrap(),
            r#"{"role":"button","nameMissing":true}"#
        );
    }

    #[test]
    fn empty_semantics_serializes_to_object_with_skipped_fields() {
        assert_eq!(serde_json::to_string(&Semantics::default()).unwrap(), "{}");
    }

    /// Apply the `.label(x)` applicator (prop `label.0`) to an element.
    fn with_label(mut el: Element, label: &str) -> Element {
        el.props.insert("label.0".to_string(), Value::Static(json!(label)));
        el
    }

    #[test]
    fn explicit_label_supplies_a_name_for_icon_only_buttons() {
        let icon_only = with_children(
            "Button",
            vec![Element::new("Icon").with_prop("0", Value::Static(json!("trash")))],
        );
        let labelled = with_label(icon_only, "Delete");
        let s = Semantics::derive(&labelled).unwrap();
        assert_eq!(s.name.as_deref(), Some("Delete"));
        assert_eq!(s.name_explicit, Some(true));
        assert_eq!(s.name_missing, None);
    }

    #[test]
    fn explicit_label_overrides_derived_content_name() {
        let button = with_label(
            Element::new("Button").with_prop("0", Value::Static(json!("Save"))),
            "Submit the form",
        );
        let s = Semantics::derive(&button).unwrap();
        assert_eq!(s.name.as_deref(), Some("Submit the form"));
        assert_eq!(s.name_explicit, Some(true));
    }

    #[test]
    fn hidden_makes_an_element_decorative_only() {
        let mut icon = Element::new("Icon").with_prop("0", Value::Static(json!("star")));
        icon.props.insert("hidden.0".to_string(), Value::Static(json!(true)));
        let s = Semantics::derive(&icon).unwrap();
        assert_eq!(s.hidden, Some(true));
        assert_eq!(s.role, None);
        assert_eq!(s.name, None);
        assert_eq!(s.name_missing, None);
    }

    /// Apply an applicator prop (e.g. `role.0`) to an element.
    fn with_applicator(mut el: Element, key: &str, value: &str) -> Element {
        el.props.insert(key.to_string(), Value::Static(json!(value)));
        el
    }

    #[test]
    fn self_state_applicators_set_their_fields() {
        let mut el = Element::new("Button").with_prop("0", Value::Static(json!("Menu")));
        el.props.insert("expanded.0".into(), Value::Static(json!(true)));
        el.props.insert("pressed.0".into(), Value::Static(json!(false)));
        el.props.insert("current.0".into(), Value::Static(json!("page")));
        let s = Semantics::derive(&el).unwrap();
        assert_eq!(s.expanded, Some(true));
        assert_eq!(s.pressed, Some(false));
        assert_eq!(s.current.as_deref(), Some("page"));
        assert_eq!(s.selected, None);
    }

    #[test]
    fn bound_self_state_is_deferred_not_guessed() {
        use crate::reactive::Binding;
        let el = Element::new("Column").with_prop(
            "expanded.0",
            Value::Binding(Binding::state(vec!["open".to_string()])),
        );
        // A bound value isn't resolved at derive time → left for reconcile,
        // but the block itself must survive (all-default) so the reconcile
        // resolution has somewhere to land — even on a generic container
        // with no other derivable semantics.
        let s = Semantics::derive(&el);
        assert!(s.is_some(), "bound .expanded on a bare Column must keep the block");
        assert_eq!(s.and_then(|s| s.expanded), None);
    }

    #[test]
    fn checkbox_label_is_the_accessible_name() {
        // Positional and named visible-label forms both become the name.
        let positional = Element::new("Checkbox").with_prop("0", Value::Static(json!("Accept")));
        assert_eq!(Semantics::derive(&positional).unwrap().name.as_deref(), Some("Accept"));

        let named = Element::new("Switch").with_prop("label", Value::Static(json!("Dark mode")));
        assert_eq!(Semantics::derive(&named).unwrap().name.as_deref(), Some("Dark mode"));

        // A bare checkbox has no name → required-but-missing.
        let bare = Element::new("Checkbox");
        assert_eq!(Semantics::derive(&bare).unwrap().name_missing, Some(true));
    }

    #[test]
    fn bound_self_state_resolves_at_reconcile() {
        // A self-state field deferred at expand (None) resolves from the
        // reconcile-time resolved props — not silently dropped.
        let s = Semantics {
            role: Some(Role::Button),
            ..Default::default()
        };
        let resolved = indexmap! {
            "expanded.0".to_string() => json!(true),
            "current.0".to_string() => json!("page"),
        };
        let out = s.with_resolved_state(&resolved);
        assert_eq!(out.expanded, Some(true));
        assert_eq!(out.current.as_deref(), Some("page"));

        // An already-set (static) value is not overwritten.
        let stat = Semantics {
            expanded: Some(false),
            ..Default::default()
        };
        assert_eq!(
            stat.with_resolved_state(&indexmap! { "expanded.0".to_string() => json!(true) })
                .expanded,
            Some(false)
        );
    }

    #[test]
    fn description_applicator_supplies_a_supplementary_description() {
        let el = with_applicator(
            Element::new("Button").with_prop("0", Value::Static(json!("Delete"))),
            "description.0",
            "This cannot be undone",
        );
        let s = Semantics::derive(&el).unwrap();
        assert_eq!(s.name.as_deref(), Some("Delete"));
        assert_eq!(s.description.as_deref(), Some("This cannot be undone"));
    }

    #[test]
    fn landmark_opt_in_gives_a_container_a_role() {
        let nav = with_applicator(Element::new("Column"), "landmark.0", "navigation");
        assert_eq!(Semantics::derive(&nav).unwrap().role, Some(Role::Navigation));

        let region = with_applicator(Element::new("Card"), "landmark.0", "region");
        assert_eq!(Semantics::derive(&region).unwrap().role, Some(Role::Region));
    }

    #[test]
    fn role_opt_in_overrides_structural_role() {
        // `.role("list")` on a Card opts into a list role.
        let listed = with_applicator(Element::new("Card"), "role.0", "list");
        assert_eq!(Semantics::derive(&listed).unwrap().role, Some(Role::List));
    }

    #[test]
    fn landmark_tokens_serialize_to_aria_vocabulary() {
        let footer = with_applicator(Element::new("Row"), "landmark.0", "footer");
        // "footer" maps to the ARIA token "contentinfo".
        assert_eq!(
            serde_json::to_string(&Semantics::derive(&footer).unwrap()).unwrap(),
            r#"{"role":"contentinfo"}"#
        );
    }

    #[test]
    fn dialog_role_opt_in_maps_to_dialog() {
        // `.role("dialog")` on a generic container opts into the dialog role,
        // which renderers use to wire a focus trap.
        let dialog = with_applicator(Element::new("Column"), "role.0", "dialog");
        assert_eq!(Semantics::derive(&dialog).unwrap().role, Some(Role::Dialog));
        assert_eq!(
            serde_json::to_string(&Semantics::derive(&dialog).unwrap()).unwrap(),
            r#"{"role":"dialog"}"#
        );
    }

    #[test]
    fn unknown_role_token_is_ignored() {
        let bogus = with_applicator(Element::new("Column"), "role.0", "wat");
        assert_eq!(Semantics::derive(&bogus), None);
    }

    #[test]
    fn bound_checkbox_state_resolves_aria_checked() {
        // A Checkbox bound via `.bind(@state.agreed)` reads its `checked`
        // bind-target prop from resolved props.
        let s = Semantics {
            role: Some(Role::Checkbox),
            ..Semantics::default()
        };
        let resolved = indexmap! { "checked".to_string() => json!(true) };
        assert_eq!(s.with_resolved_state(&resolved).checked, Some(true));

        // A Switch reads `on` instead.
        let s = Semantics {
            role: Some(Role::Switch),
            ..Semantics::default()
        };
        let resolved = indexmap! { "on".to_string() => json!(false) };
        assert_eq!(s.clone().with_resolved_state(&resolved).checked, Some(false));

        // Non-bool / non-toggle roles leave `checked` unset.
        let s = Semantics {
            role: Some(Role::Button),
            ..Semantics::default()
        };
        let resolved = indexmap! { "checked".to_string() => json!(true) };
        assert_eq!(s.with_resolved_state(&resolved).checked, None);
    }

    #[test]
    fn composite_widget_types_derive_their_roles() {
        assert_eq!(role_of("Tabs"), Some(Role::Tablist));
        assert_eq!(role_of("Tab"), Some(Role::Tab));
        assert_eq!(role_of("TabPanel"), Some(Role::Tabpanel));
        assert_eq!(role_of("Option"), Some(Role::OptionItem));
        assert_eq!(role_of("Combobox"), Some(Role::Combobox));
    }

    #[test]
    fn composite_role_tokens_serialize_to_aria_vocabulary() {
        let tab = Element::new("Tab").with_prop("0", Value::Static(json!("Overview")));
        assert_eq!(
            serde_json::to_string(&Semantics::derive(&tab).unwrap()).unwrap(),
            r#"{"role":"tab","name":"Overview"}"#
        );
        let opt = with_applicator(Element::new("Column"), "role.0", "option");
        assert_eq!(Semantics::derive(&opt).unwrap().role, Some(Role::OptionItem));
    }

    #[test]
    fn tab_and_option_derive_names_from_content_like_buttons() {
        let tab = Element::new("Tab").with_prop("0", Value::Static(json!("Details")));
        let s = Semantics::derive(&tab).unwrap();
        assert_eq!(s.name.as_deref(), Some("Details"));

        // An empty tab is required-but-missing, like an icon-only button.
        let bare = Element::new("Tab");
        assert_eq!(Semantics::derive(&bare).unwrap().name_missing, Some(true));
    }

    #[test]
    fn owns_derives_from_its_applicator() {
        let combo = with_applicator(Element::new("Combobox"), "owns.0", "popup-1");
        assert_eq!(Semantics::derive(&combo).unwrap().owns.as_deref(), Some("popup-1"));
    }

    #[test]
    fn templated_references_resolve_at_reconcile() {
        use crate::reactive::Binding;
        // `.id(@item.x)`-style values are deferred at derive and resolve from
        // the reconcile-time props — the ForEach per-item id case.
        let el = Element::new("Column").with_prop(
            "id.0",
            Value::Binding(Binding::state(vec!["optId".to_string()])),
        );
        let base = Semantics::derive(&el).expect("bound reference keeps the block alive");
        assert_eq!(base.id, None);

        let resolved = indexmap! { "id.0".to_string() => json!("opt-42") };
        assert_eq!(base.with_resolved_state(&resolved).id.as_deref(), Some("opt-42"));
    }

    #[test]
    fn id_anchor_and_labelledby_derive_from_their_applicators() {
        let panel = with_applicator(
            with_applicator(Element::new("Column"), "id.0", "panel-1"),
            "labelledby.0",
            "tab-1",
        );
        let s = Semantics::derive(&panel).unwrap();
        assert_eq!(s.id.as_deref(), Some("panel-1"));
        assert_eq!(s.labelledby.as_deref(), Some("tab-1"));
    }

    #[test]
    fn static_activedescendant_derives_and_serializes_camel_case() {
        let el = with_applicator(Element::new("Column"), "activedescendant.0", "opt-2");
        let s = Semantics::derive(&el).unwrap();
        assert_eq!(s.active_descendant.as_deref(), Some("opt-2"));
        assert_eq!(
            serde_json::to_string(&s).unwrap(),
            r#"{"activeDescendant":"opt-2"}"#
        );
    }

    #[test]
    fn bound_activedescendant_resolves_and_re_resolves_at_reconcile() {
        use crate::reactive::Binding;
        // Bound value → deferred at derive, but the block must still exist
        // (even all-default) so reconcile has a base to resolve into.
        let el = Element::new("Column").with_prop(
            "activedescendant.0",
            Value::Binding(Binding::state(vec!["focused".to_string()])),
        );
        let base = Semantics::derive(&el);
        assert!(base.is_some(), "bound deferred prop must keep the block alive");
        assert_eq!(base.as_ref().and_then(|s| s.active_descendant.clone()), None);

        // Resolves from the reconcile-time props…
        let resolved = indexmap! { "activedescendant.0".to_string() => json!("opt-3") };
        let s = base.clone().unwrap().with_resolved_state(&resolved);
        assert_eq!(s.active_descendant.as_deref(), Some("opt-3"));

        // …and re-resolves to a NEW value on the next render (not sticky) —
        // this is what the SetSemantics re-emit depends on.
        let resolved = indexmap! { "activedescendant.0".to_string() => json!("opt-4") };
        let s = base.unwrap().with_resolved_state(&resolved);
        assert_eq!(s.active_descendant.as_deref(), Some("opt-4"));
    }

    #[test]
    fn cross_node_relationship_applicators_set_their_target_ids() {
        // `.controls("panel")` / `.describedby("hint")` carry an author-supplied
        // target id string — a web-leaning relationship (see the design doc).
        let el = with_applicator(
            with_applicator(
                Element::new("Button").with_prop("0", Value::Static(json!("Toggle"))),
                "controls.0",
                "panel",
            ),
            "describedby.0",
            "hint",
        );
        let s = Semantics::derive(&el).unwrap();
        assert_eq!(s.controls.as_deref(), Some("panel"));
        assert_eq!(s.describedby.as_deref(), Some("hint"));
    }

    #[test]
    fn hidden_clears_what_would_be_a_missing_name() {
        // A hidden icon-only button must not be flagged name-missing.
        let mut button = with_children(
            "Button",
            vec![Element::new("Icon").with_prop("0", Value::Static(json!("x")))],
        );
        button.props.insert("hidden.0".to_string(), Value::Static(json!(true)));
        let s = Semantics::derive(&button).unwrap();
        assert_eq!(s.hidden, Some(true));
        assert_eq!(s.name_missing, None);
    }
}
