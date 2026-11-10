//! Template reference extraction for static checking (`hypen check`).
//!
//! Parses a DSL source, expands it to IR, and reports every reference the
//! template makes, each located at `line:col`:
//!
//! * **state** — `@state.x`, `@{state.x}`, and `state.x` inside an `@{…}`
//!   expression (plus `.states { … }`-driven paths);
//! * **action** — `@actions.x` (and the reserved `@router.*` namespace,
//!   flagged `reserved`);
//! * **item** — a row reference: `@item.x`/`@{item.x}`, or `@{todo.x}` under
//!   a loop declaring `as: todo`, with whether an enclosing ForEach/List/Grid
//!   puts that name in scope;
//! * **dataSource** — `@provider.path` references that no enclosing loop
//!   claims as its row name;
//! * **component** — every author-written element type, flagged `builtin`
//!   when the engine or the renderers know it natively.
//!
//! The engine reports *facts*. Whether `state.user.name` exists, or whether
//! `@actions.save` has a handler, depends on the module, which only the host
//! can load — so validity is decided host-side (the CLI's
//! `check-template.ts`). Even "item reference outside any loop" is not
//! decidable per file: a component template written as a row
//! (`Text("@{item.title}")`) is legal when every caller instantiates it inside
//! a ForEach in *another* file, so the per-file fact (`inLoop: false`) is
//! reported and the cross-file verdict left to the host.
//!
//! The one rule this pass decides alone is about its own syntax: a
//! `// hypen-check-ignore [rule-id, …]` directive naming a rule id that is not
//! in [`ALL_CHECK_RULES`] fires [`CheckRule::UnknownIgnoreRule`] (mirroring
//! the accessibility pass's handling of `hypen-a11y-ignore`).
//!
//! Locations: the IR carries spans for elements only, so a reference is
//! located by finding its text (`state.user.name`, `actions.save`, …) inside
//! the span of the element that carries it — or, for control-flow nodes
//! (whose IR has no span), after the most recently visited element. Matches
//! inside `//` comments are skipped, and each occurrence is claimed once so
//! repeated identical references land on successive occurrences. A reference
//! whose text cannot be found is still reported, just without `line`/`col`.

use crate::ir::conformance::parse_ignore_directive;
use crate::ir::node::{Element, IRNode, Value};
use crate::ir::span::{LineIndex, SourceSpan};
use crate::ir::walk::{ForEachFrame, WalkCtx};
use crate::reactive::{parse_binding, Binding, BindingSource};
use serde::Serialize;
use std::collections::{HashMap, HashSet};

/// The rules `hypen check` applies to template references. The engine emits
/// only [`CheckRule::UnknownIgnoreRule`] itself; the others are decided by the
/// host against the loaded module, but their ids live here so the
/// `hypen-check-ignore` directive can be validated and hosts can detect a
/// stale binding (see [`all_check_rule_ids`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CheckRule {
    /// A state reference whose root key (or a key under a plain, non-empty
    /// object) is absent from the module's initial state.
    UnknownStatePath,
    /// `@actions.x` with no handler on the owning module.
    UnknownAction,
    /// An element type that is neither built in nor a known component.
    UnknownComponent,
    /// `@item…` used where no ForEach/List/Grid can supply a row.
    ItemOutsideLoop,
    /// `@theme.x.y` naming a token the project's theme file does not define
    /// (in every scheme, or only in some).
    UnknownThemeToken,
    /// A `// hypen-check-ignore` directive names a rule id that does not
    /// exist, so that entry suppresses nothing.
    UnknownIgnoreRule,
}

/// Every check rule, in declaration order — the source of the binding's
/// `templateCheckRules()` getter.
pub const ALL_CHECK_RULES: &[CheckRule] = &[
    CheckRule::UnknownStatePath,
    CheckRule::UnknownAction,
    CheckRule::UnknownComponent,
    CheckRule::ItemOutsideLoop,
    CheckRule::UnknownThemeToken,
    CheckRule::UnknownIgnoreRule,
];

impl CheckRule {
    /// Kebab-case id (the string in diagnostics and directives).
    pub fn id(self) -> String {
        match serde_json::to_value(self) {
            Ok(serde_json::Value::String(id)) => id,
            _ => unreachable!("CheckRule serializes as a kebab-case string"),
        }
    }
}

/// Kebab-case id of each entry in [`ALL_CHECK_RULES`].
pub fn all_check_rule_ids() -> Vec<String> {
    ALL_CHECK_RULES.iter().map(|rule| rule.id()).collect()
}

/// The data-source provider a theme publishes its tokens under
/// (`@theme.color.primary`). References to it are reported even from inside
/// expressions, so `unknown-theme-token` can be judged there too.
pub const THEME_PROVIDER: &str = "theme";

/// The directive token that suppresses template-check findings.
pub const CHECK_IGNORE_TOKEN: &str = "hypen-check-ignore";

/// Element types rendered natively that are not in
/// [`crate::ir::DEFAULT_PRIMITIVES`] — semantic composite widgets the engine
/// derives roles for and the structural types the renderers register.
/// Compared case-insensitively (renderers dispatch on the lowercased type).
const EXTRA_BUILTIN_ELEMENTS: &[&str] = &[
    "Link",
    "Tabs",
    "Tab",
    "TabPanel",
    "Option",
    "Combobox",
    "TextArea",
    "VisuallyHidden",
    "App",
    "HypenApp",
    "Router",
    "Route",
    "ForEach",
    "If",
    "When",
    "Case",
    "Else",
    "Fallback",
];

/// Whether `name` is an element type the engine/renderers handle natively,
/// with no component definition needed.
pub fn is_builtin_element(name: &str) -> bool {
    crate::ir::DEFAULT_PRIMITIVES
        .iter()
        .chain(EXTRA_BUILTIN_ELEMENTS)
        .any(|known| known.eq_ignore_ascii_case(name))
}

/// What a [`TemplateRef`] refers to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RefKind {
    State,
    Action,
    Item,
    DataSource,
    Component,
}

/// One located reference made by a template.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateRef {
    pub kind: RefKind,
    /// `state`: the state path (`user.name`); `action`: the action name;
    /// `item`: the reference as written (`item.title`, `todo.done`);
    /// `dataSource`: `provider.path`; `component`: the element type.
    pub name: String,
    /// Path segments under the root (state/item/dataSource); empty otherwise.
    pub path: Vec<String>,
    /// `item`: the row name (`item`, or the loop's `as:` name);
    /// `dataSource`: the provider.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
    /// Whether any ForEach/List/Grid encloses the reference in this file.
    pub in_loop: bool,
    /// `item` only: whether an enclosing loop supplies this row name. The
    /// reserved `item` is supplied by any loop; an `as:` name only by the
    /// loop that declares it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_scope: Option<bool>,
    /// `component` only: handled natively (see [`is_builtin_element`]).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub builtin: Option<bool>,
    /// `action` only: a framework namespace (`router.*`, `__*`, `hypen.*`)
    /// rather than a module action.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reserved: Option<bool>,
    /// True when the reference was extracted from an `@{…}` expression
    /// rather than written as a direct reference/interpolation.
    pub from_expression: bool,
    /// Module scope of the carrying node (`module X { … }` in this source).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub module_scope: Option<String>,
    /// The element the reference hangs off (`ForEach`/`Conditional` for
    /// control-flow sources).
    pub element_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub span: Option<SourceSpan>,
    /// 1-based line, when located.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<usize>,
    /// 1-based column in Unicode codepoints, when located.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub col: Option<usize>,
    /// A bare `// hypen-check-ignore` applies to this reference: every rule
    /// is suppressed for it.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub ignore_all: bool,
    /// Rule ids a rule-scoped `// hypen-check-ignore` suppresses for it.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub ignore_rules: Vec<String>,
}

/// A finding the engine decides on its own (see the module docs).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckDiagnostic {
    pub rule: CheckRule,
    pub element_type: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub span: Option<SourceSpan>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub col: Option<usize>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub suppressed: bool,
}

/// Everything [`template_refs_source`] knows about one source document.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateRefsReport {
    pub refs: Vec<TemplateRef>,
    pub diagnostics: Vec<CheckDiagnostic>,
    /// Names declared in this document with `module X { … }` /
    /// `component X { … }`.
    pub declared_components: Vec<String>,
    /// Names brought in by `import` statements.
    pub imported_components: Vec<String>,
}

/// Parse `source`, expand it, and extract every located reference plus the
/// engine-decided diagnostics. Returns the parse error message on a syntax
/// error.
pub fn template_refs_source(source: &str) -> Result<TemplateRefsReport, String> {
    let doc = hypen_parser::parse_document(source).map_err(|e| format!("{e:?}"))?;
    let trees: Vec<IRNode> = doc
        .components
        .iter()
        .map(crate::ir::ast_to_ir_node)
        .collect();
    let declared_components = doc
        .components
        .iter()
        .filter(|c| c.declaration_type != hypen_parser::DeclarationType::Component)
        .map(|c| c.name.clone())
        .collect();
    let imported_components = doc
        .imports
        .iter()
        .flat_map(|import| import.imported_names())
        .collect();
    Ok(TemplateRefsReport {
        refs: locate_refs(&trees, source),
        diagnostics: unknown_check_ignore_findings(source),
        declared_components,
        imported_components,
    })
}

/// A reference before location: what was found and where to look for it.
struct RawRef {
    kind: RefKind,
    name: String,
    path: Vec<String>,
    root: Option<String>,
    in_loop: bool,
    in_scope: Option<bool>,
    builtin: Option<bool>,
    reserved: Option<bool>,
    from_expression: bool,
    module_scope: Option<String>,
    element_type: String,
    /// How to find the reference in the source.
    locator: Locator,
    /// Byte window to search first (the carrying element's expression).
    window: (usize, usize),
    /// Start of the carrying element, for element-level directives.
    element_start: Option<usize>,
}

/// How a reference is found in the source text.
enum Locator {
    /// The reference *is* a node (component refs): its name-token span.
    Exact(SourceSpan),
    /// A direct reference: try each literal spelling in order
    /// (`@{state.x}`, `@state.x`), then the bare text.
    Direct {
        spellings: Vec<String>,
        bare: String,
    },
    /// Inside a template-string literal: find the literal (once per
    /// `container` id — every binding of one template shares it), then
    /// `bare` within it. Falls back to a window search when the literal is
    /// not found verbatim (escape sequences).
    InTemplate {
        container: usize,
        template: String,
        bare: String,
    },
}

/// Walk the trees and collect every reference, then locate them in source.
fn locate_refs(trees: &[IRNode], source: &str) -> Vec<TemplateRef> {
    let mut raw = Vec::new();
    for tree in trees {
        collect(tree, source.len(), &mut raw);
    }

    let index = LineIndex::new(source);
    let lines: Vec<&str> = source.lines().collect();
    let mut claimed: HashSet<(usize, usize)> = HashSet::new();
    let mut containers: HashMap<usize, Option<usize>> = HashMap::new();
    raw.into_iter()
        .map(|r| {
            let span = locate(source, &r, &mut claimed, &mut containers);
            let located = span.map(|s| index.locate(s.start));
            let element_line = r.element_start.map(|start| index.locate(start).0);
            let (ignore_all, ignore_rules) = match located {
                Some((line, _)) => ref_ignore(&lines, line, element_line),
                None => (false, Vec::new()),
            };
            TemplateRef {
                kind: r.kind,
                name: r.name,
                path: r.path,
                root: r.root,
                in_loop: r.in_loop,
                in_scope: r.in_scope,
                builtin: r.builtin,
                reserved: r.reserved,
                from_expression: r.from_expression,
                module_scope: r.module_scope,
                element_type: r.element_type,
                span,
                line: located.map(|(line, _)| line),
                col: located.map(|(_, col)| col),
                ignore_all,
                ignore_rules,
            }
        })
        .collect()
}

/// Resolve a [`RawRef`]'s [`Locator`] to a span (see the module docs).
fn locate(
    source: &str,
    r: &RawRef,
    claimed: &mut HashSet<(usize, usize)>,
    containers: &mut HashMap<usize, Option<usize>>,
) -> Option<SourceSpan> {
    let whole = (0, source.len());
    let mut search = |needle: &str, window: (usize, usize)| {
        find_token(source, needle, window, claimed).map(|start| SourceSpan {
            start,
            end: start + needle.len(),
        })
    };
    match &r.locator {
        Locator::Exact(span) => Some(*span),
        Locator::Direct { spellings, bare } => spellings
            .iter()
            .find_map(|s| search(s, r.window))
            .or_else(|| search(bare, r.window))
            .or_else(|| spellings.iter().find_map(|s| search(s, whole)))
            .or_else(|| search(bare, whole)),
        Locator::InTemplate {
            container,
            template,
            bare,
        } => {
            let start = match containers.get(container) {
                Some(start) => *start,
                None => {
                    let start = search(template, r.window)
                        .or_else(|| search(template, whole))
                        .map(|s| s.start);
                    containers.insert(*container, start);
                    start
                }
            };
            match start {
                Some(start) => search(bare, (start, start + template.len())),
                None => search(bare, r.window).or_else(|| search(bare, whole)),
            }
        }
    }
}

/// Gathers references while walking; `anchor` is the start of the most
/// recently visited element, the search floor for control-flow nodes.
struct Collector<'a> {
    out: &'a mut Vec<RawRef>,
    source_len: usize,
    anchor: usize,
    /// Next template-string container id (see [`Locator::InTemplate`]).
    next_container: usize,
}

fn collect(tree: &IRNode, source_len: usize, out: &mut Vec<RawRef>) {
    let mut c = Collector {
        out,
        source_len,
        anchor: 0,
        next_container: 0,
    };
    c.walk(tree, &WalkCtx::default(), None);
}

impl Collector<'_> {
    /// Pre-order walk carrying loop frames exactly as
    /// [`crate::ir::walk::walk_ir_ctx`] builds them, plus the nearest
    /// enclosing element — which bounds where a control-flow node's
    /// references can sit, and identifies props the `List(...)`/`Grid(...)`
    /// lowering mirrors onto both the wrapper element and its ForEach.
    fn walk(&mut self, node: &IRNode, ctx: &WalkCtx, parent: Option<&Element>) {
        // Control-flow nodes have no span: search from the last visited
        // element up to the end of the enclosing element.
        let flow_window = |anchor: usize, source_len: usize| {
            let (start, end) = parent
                .and_then(|p| p.expr_span)
                .map_or((0, source_len), |e| (e.start, e.end));
            (anchor.max(start), end)
        };
        match node {
            IRNode::Element(element) => {
                self.element(element, ctx);
                for child in &element.ir_children {
                    self.walk(child, ctx, Some(element));
                }
            }
            IRNode::ForEach {
                source,
                item_name,
                props,
                module_scope,
                template,
                ..
            } => {
                let site = Site {
                    element_type: "ForEach",
                    module_scope,
                    window: flow_window(self.anchor, self.source_len),
                    element_start: None,
                };
                // The loop's source resolves against the frames *outside* it.
                self.binding(source, false, ctx, &site, None);
                for (key, value) in props.iter() {
                    let mirrored = parent
                        .and_then(|p| p.props.get(key))
                        .is_some_and(|p| same_value(p, value));
                    if !key.starts_with("__") && !mirrored {
                        self.value(value, ctx, &site);
                    }
                }
                let mut frames = ctx.frames.clone();
                frames.push(ForEachFrame {
                    item_name: item_name.clone(),
                    collection: if source.is_state()
                        || ctx
                            .frame_for(source)
                            .is_some_and(|frame| &frame.module_scope == module_scope)
                    {
                        ctx.state_path(source)
                    } else {
                        None
                    },
                    module_scope: module_scope.clone(),
                });
                let inner = WalkCtx {
                    route: ctx.route.clone(),
                    frames,
                };
                for child in template {
                    self.walk(child, &inner, parent);
                }
            }
            IRNode::Conditional {
                value,
                branches,
                fallback,
                module_scope,
            } => {
                let site = Site {
                    element_type: "Conditional",
                    module_scope,
                    window: flow_window(self.anchor, self.source_len),
                    element_start: None,
                };
                self.value(value, ctx, &site);
                for branch in branches {
                    self.value(&branch.pattern, ctx, &site);
                    for child in &branch.children {
                        self.walk(child, ctx, parent);
                    }
                }
                for child in fallback.iter().flatten() {
                    self.walk(child, ctx, parent);
                }
            }
            // A Router's location binding is synthesized when the DSL omits
            // it, so it is not something the author necessarily wrote.
            IRNode::Router {
                routes, fallback, ..
            } => {
                for route in routes {
                    for child in &route.children {
                        self.walk(child, ctx, parent);
                    }
                }
                for child in fallback.iter().flatten() {
                    self.walk(child, ctx, parent);
                }
            }
        }
    }
}

/// Where a reference was found.
struct Site<'s> {
    element_type: &'s str,
    module_scope: &'s Option<String>,
    window: (usize, usize),
    element_start: Option<usize>,
}

impl Collector<'_> {
    fn element(&mut self, element: &Element, ctx: &WalkCtx) {
        // Synthesized elements (no span) and engine error nodes are not
        // something the author wrote.
        let Some(span) = element.span else {
            return;
        };
        if element.element_type.starts_with("__") {
            return;
        }
        self.anchor = span.start;
        let window = element
            .expr_span
            .map_or((span.start, self.source_len), |e| (e.start, e.end));
        self.push(RawRef {
            kind: RefKind::Component,
            name: element.element_type.clone(),
            path: Vec::new(),
            root: None,
            in_loop: ctx.in_for_each(),
            in_scope: None,
            builtin: Some(is_builtin_element(&element.element_type)),
            reserved: None,
            from_expression: false,
            module_scope: element.module_scope.clone(),
            element_type: element.element_type.clone(),
            locator: Locator::Exact(span),
            window,
            element_start: Some(span.start),
        });
        let site = Site {
            element_type: &element.element_type,
            module_scope: &element.module_scope,
            window,
            element_start: Some(span.start),
        };
        for (key, value) in element.props.iter() {
            // Reserved channels (`__bind`, `__anim.*`, `__dnd.*`) are
            // engine-lowered companions of props already visited.
            if !key.starts_with("__") {
                self.value(value, ctx, &site);
            }
        }
    }

    fn push(&mut self, r: RawRef) {
        self.out.push(r);
    }

    fn value(&mut self, value: &Value, ctx: &WalkCtx, site: &Site) {
        match value {
            Value::Binding(b) => self.binding(b, false, ctx, site, None),
            Value::TemplateString { template, bindings } => {
                let container = self.next_container;
                self.next_container += 1;
                let direct = direct_interpolations(template);
                for b in bindings {
                    let from_expression = !direct.contains(&b.full_path_with_source());
                    // Expression extraction also turns any `ident.path`
                    // (`Math.round`, quoted text) into a data-source binding;
                    // only a name an enclosing loop declares is meaningful —
                    // and the reserved `theme` provider, whose tokens the
                    // host can check against the project's theme file.
                    if from_expression
                        && matches!(&b.source, BindingSource::DataSource(name) if name != THEME_PROVIDER)
                        && ctx.frame_for(b).is_none()
                    {
                        continue;
                    }
                    self.binding(b, from_expression, ctx, site, Some((container, template)));
                }
            }
            Value::Action(name) => self.action(name, site),
            Value::StateSwitch { path, .. } => {
                let b = Binding::state(path.split('.').map(str::to_string).collect());
                self.binding(&b, false, ctx, site, None);
            }
            // Lists/maps keep nested references as strings (`"@{item.id}"`,
            // `"@actions.x"`) — see `parser_value_to_ir`.
            Value::Static(json) => self.static_json(json, ctx, site),
            Value::Resource(_) => {}
        }
    }

    fn static_json(&mut self, json: &serde_json::Value, ctx: &WalkCtx, site: &Site) {
        match json {
            serde_json::Value::String(s) => {
                if let Some(name) = s.strip_prefix("@actions.") {
                    self.action(name, site);
                } else if s.contains("@{") {
                    if let Some(b) = parse_binding(s) {
                        self.binding(&b, false, ctx, site, None);
                    }
                }
            }
            serde_json::Value::Array(items) => {
                for item in items {
                    self.static_json(item, ctx, site);
                }
            }
            serde_json::Value::Object(map) => {
                for item in map.values() {
                    self.static_json(item, ctx, site);
                }
            }
            _ => {}
        }
    }

    fn action(&mut self, name: &str, site: &Site) {
        let reserved = crate::agent_core::is_reserved_action_name(name);
        // `router.push` is written `@router.push`; everything else
        // `@actions.<name>`.
        let bare = if name.starts_with("router.") {
            name.to_string()
        } else {
            format!("actions.{name}")
        };
        self.push(RawRef {
            kind: RefKind::Action,
            name: name.to_string(),
            path: Vec::new(),
            root: None,
            in_loop: false,
            in_scope: None,
            builtin: None,
            reserved: Some(reserved),
            from_expression: false,
            module_scope: site.module_scope.clone(),
            element_type: site.element_type.to_string(),
            locator: Locator::Direct {
                spellings: vec![format!("@{bare}")],
                bare,
            },
            window: site.window,
            element_start: site.element_start,
        });
    }

    /// `container` is the enclosing template string (id, text), when the
    /// binding was extracted from one.
    fn binding(
        &mut self,
        b: &Binding,
        from_expression: bool,
        ctx: &WalkCtx,
        site: &Site,
        container: Option<(usize, &str)>,
    ) {
        let (kind, root, in_scope) = match &b.source {
            BindingSource::State => (RefKind::State, None, None),
            BindingSource::Item => (
                RefKind::Item,
                Some("item".to_string()),
                Some(ctx.in_for_each()),
            ),
            BindingSource::DataSource(name) => {
                if ctx.frame_for(b).is_some() {
                    (RefKind::Item, Some(name.clone()), Some(true))
                } else {
                    (RefKind::DataSource, Some(name.clone()), None)
                }
            }
        };
        let bare = b.full_path_with_source();
        let name = match kind {
            RefKind::State => b.full_path(),
            _ => bare.clone(),
        };
        let locator = match container {
            Some((container, template)) => Locator::InTemplate {
                container,
                template: template.to_string(),
                bare,
            },
            None => Locator::Direct {
                spellings: vec![format!("@{{{bare}}}"), format!("@{bare}")],
                bare,
            },
        };
        self.push(RawRef {
            kind,
            name,
            path: b.path.clone(),
            root,
            in_loop: ctx.in_for_each(),
            in_scope,
            builtin: None,
            reserved: None,
            from_expression,
            module_scope: site.module_scope.clone(),
            element_type: site.element_type.to_string(),
            locator,
            window: site.window,
            element_start: site.element_start,
        });
    }
}

/// Structural equality for IR values (`Value` has no `PartialEq`).
fn same_value(a: &Value, b: &Value) -> bool {
    matches!(
        (serde_json::to_value(a), serde_json::to_value(b)),
        (Ok(x), Ok(y)) if x == y
    )
}

/// The `@{…}` interpolations in a template string whose whole body is a
/// plain reference (`@{item.title}`), as opposed to an expression.
fn direct_interpolations(template: &str) -> HashSet<String> {
    template
        .split("@{")
        .skip(1)
        .filter_map(|part| part.split_once('}'))
        .map(|(expression, _)| expression.trim().to_string())
        .collect()
}

fn is_ident_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// Whether byte `pos` sits after a `//` line comment opener on its line
/// (`://` in URLs does not count).
fn in_line_comment(source: &str, pos: usize) -> bool {
    let line_start = source[..pos].rfind('\n').map_or(0, |i| i + 1);
    let prefix = &source[line_start..pos];
    prefix
        .match_indices("//")
        .any(|(i, _)| !prefix[..i].ends_with(':'))
}

/// Find an unclaimed occurrence of `needle` in `window`, outside comments and
/// not glued to a preceding identifier. An exact match (not followed by
/// another path character) wins over a prefix match (`state.items` inside
/// `state.items.length`, which extraction folds to the container).
fn find_token(
    source: &str,
    needle: &str,
    window: (usize, usize),
    claimed: &mut HashSet<(usize, usize)>,
) -> Option<usize> {
    let end = window.1.min(source.len());
    let start = window.0.min(end);
    let hay = source.get(start..end)?;
    let mut prefix_match = None;
    for (rel, _) in hay.match_indices(needle) {
        let pos = start + rel;
        if claimed.contains(&(pos, needle.len())) || in_line_comment(source, pos) {
            continue;
        }
        if source[..pos].chars().next_back().is_some_and(is_ident_char) {
            continue;
        }
        match source[pos + needle.len()..].chars().next() {
            Some(c) if is_ident_char(c) => continue,
            Some('.') => {
                prefix_match.get_or_insert(pos);
            }
            _ => {
                claimed.insert((pos, needle.len()));
                return Some(pos);
            }
        }
    }
    if let Some(pos) = prefix_match {
        claimed.insert((pos, needle.len()));
    }
    prefix_match
}

/// Directives that apply to a reference on 1-based `line` carried by an
/// element starting on `element_line`: trailing on the reference's own line,
/// alone on the line directly above it, or alone on the line directly above
/// the carrying element. Returns `(all, rule ids)`.
fn ref_ignore(lines: &[&str], line: usize, element_line: Option<usize>) -> (bool, Vec<String>) {
    let mut all = false;
    let mut ids: Vec<String> = Vec::new();
    let mut apply = |directive: Option<Option<Vec<String>>>| match directive {
        Some(None) => all = true,
        Some(Some(list)) => {
            for id in list {
                if !ids.contains(&id) {
                    ids.push(id);
                }
            }
        }
        None => {}
    };
    let comment_only_above = |l: usize| -> Option<Option<Vec<String>>> {
        // `l` is 1-based; the line above is index l - 2.
        let prev = lines.get(l.checked_sub(2)?)?;
        if prev.trim_start().starts_with("//") {
            parse_ignore_directive(prev, CHECK_IGNORE_TOKEN)
        } else {
            None
        }
    };
    if let Some(text) = lines.get(line - 1) {
        apply(parse_ignore_directive(text, CHECK_IGNORE_TOKEN));
    }
    apply(comment_only_above(line));
    if let Some(el) = element_line.filter(|el| *el != line) {
        apply(comment_only_above(el));
    }
    (all, ids)
}

/// Report every `// hypen-check-ignore` id that is not a check rule. A
/// directive explicitly listing `unknown-ignore-rule` suppresses these on its
/// own line (the escape hatch for ids from a newer engine).
fn unknown_check_ignore_findings(source: &str) -> Vec<CheckDiagnostic> {
    let known: HashSet<String> = all_check_rule_ids().into_iter().collect();
    let index = LineIndex::new(source);
    let unknown_id = CheckRule::UnknownIgnoreRule.id();
    let mut findings = Vec::new();
    let mut line_start = 0usize;
    for raw in source.split_inclusive('\n') {
        let line = raw.trim_end_matches('\n').trim_end_matches('\r');
        if let Some(Some(ids)) = parse_ignore_directive(line, CHECK_IGNORE_TOKEN) {
            let search_from = line
                .find(CHECK_IGNORE_TOKEN)
                .map_or(0, |pos| pos + CHECK_IGNORE_TOKEN.len());
            let suppressed = ids.contains(&unknown_id);
            for id in ids.iter().filter(|id| !known.contains(*id)) {
                let span = line[search_from..].find(id.as_str()).map(|rel| SourceSpan {
                    start: line_start + search_from + rel,
                    end: line_start + search_from + rel + id.len(),
                });
                let located = span.map(|s| index.locate(s.start));
                findings.push(CheckDiagnostic {
                    rule: CheckRule::UnknownIgnoreRule,
                    element_type: CHECK_IGNORE_TOKEN.to_string(),
                    message: format!(
                        "\"{id}\" is not a template check rule, so this directive entry \
                         suppresses nothing — check the spelling against the rule list \
                         (or add `unknown-ignore-rule` if the id comes from a newer engine)"
                    ),
                    span,
                    line: located.map(|(l, _)| l),
                    col: located.map(|(_, c)| c),
                    suppressed,
                });
            }
        }
        line_start += raw.len();
    }
    findings
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refs(source: &str) -> Vec<TemplateRef> {
        template_refs_source(source).expect("parses").refs
    }

    fn of_kind(refs: &[TemplateRef], kind: RefKind) -> Vec<&TemplateRef> {
        refs.iter().filter(|r| r.kind == kind).collect()
    }

    fn find<'a>(refs: &'a [TemplateRef], kind: RefKind, name: &str) -> &'a TemplateRef {
        refs.iter()
            .find(|r| r.kind == kind && r.name == name)
            .unwrap_or_else(|| panic!("no {kind:?} ref {name}: {refs:#?}"))
    }

    #[test]
    fn every_rule_is_listed_with_its_published_id() {
        let every = [
            CheckRule::UnknownStatePath,
            CheckRule::UnknownAction,
            CheckRule::UnknownComponent,
            CheckRule::ItemOutsideLoop,
            CheckRule::UnknownThemeToken,
            CheckRule::UnknownIgnoreRule,
        ];
        for rule in every {
            // Exhaustive: a new variant fails to compile until listed.
            match rule {
                CheckRule::UnknownStatePath
                | CheckRule::UnknownAction
                | CheckRule::UnknownComponent
                | CheckRule::ItemOutsideLoop
                | CheckRule::UnknownThemeToken
                | CheckRule::UnknownIgnoreRule => {}
            }
            assert!(ALL_CHECK_RULES.contains(&rule));
        }
        assert_eq!(ALL_CHECK_RULES.len(), every.len());
        assert_eq!(
            all_check_rule_ids(),
            [
                "unknown-state-path",
                "unknown-action",
                "unknown-component",
                "item-outside-loop",
                "unknown-theme-token",
                "unknown-ignore-rule",
            ]
        );
    }

    #[test]
    fn theme_refs_inside_expressions_are_reported_and_located() {
        let src = "Column {\n    Text(\"@{appearance.scheme == 'dark' ? theme.color.a : theme.color.b}\")\n    Text(\"@{Math.round(state.n)}\")\n}";
        let r = refs(src);
        let ds = of_kind(&r, RefKind::DataSource);
        let names: Vec<&str> = ds.iter().map(|d| d.name.as_str()).collect();
        assert_eq!(names, ["theme.color.a", "theme.color.b"]);
        assert!(ds.iter().all(|d| d.from_expression && d.root.as_deref() == Some("theme")));
        assert_eq!(ds[0].line, Some(2));
        assert!(ds[0].col < ds[1].col);
    }

    #[test]
    fn state_refs_in_every_spelling_are_located() {
        let src = "Column {\n    Text(@state.title)\n    Text(\"Hi @{state.user.name}\")\n    Text(\"@{state.count > 0 ? 'some' : 'none'}\")\n}";
        let r = refs(src);
        let title = find(&r, RefKind::State, "title");
        assert_eq!((title.line, title.col), (Some(2), Some(10)));
        assert!(!title.from_expression);
        let name = find(&r, RefKind::State, "user.name");
        assert_eq!(name.path, vec!["user", "name"]);
        assert_eq!((name.line, name.col), (Some(3), Some(16)));
        assert!(!name.from_expression);
        let count = find(&r, RefKind::State, "count");
        assert!(count.from_expression);
        assert_eq!(count.line, Some(4));
    }

    #[test]
    fn actions_and_router_refs() {
        let src = "Column {\n    Button { Text(\"Go\") }.onClick(@actions.save, id: 1)\n    Button { Text(\"Nav\") }.onClick(@router.push, to: \"/x\")\n}";
        let r = refs(src);
        let save = find(&r, RefKind::Action, "save");
        assert_eq!(save.reserved, Some(false));
        assert_eq!((save.line, save.col), (Some(2), Some(35)));
        assert_eq!(save.element_type, "Button");
        let push = find(&r, RefKind::Action, "router.push");
        assert_eq!(push.reserved, Some(true));
        assert_eq!(push.line, Some(3));
    }

    #[test]
    fn nested_for_each_with_aliases_scopes_item_refs() {
        let src = r#"Column {
    List(@state.products, as: product) {
        Text("@{product.title}")
        List(@product.variants, as: v) {
            Text("@{v.size} of @{product.title}")
            Text("@{item.sku}")
        }
    }
    Text("@{item.oops}")
}"#;
        let r = refs(src);
        // The loop source is a state ref; the nested source a row ref.
        let products = find(&r, RefKind::State, "products");
        assert!(!products.in_loop);
        assert_eq!(products.element_type, "ForEach");
        assert_eq!(products.line, Some(2));
        let variants = find(&r, RefKind::Item, "product.variants");
        assert_eq!(variants.in_scope, Some(true));
        assert_eq!(variants.line, Some(4));

        let size = find(&r, RefKind::Item, "v.size");
        assert_eq!(size.root.as_deref(), Some("v"));
        assert_eq!(size.in_scope, Some(true));
        assert!(size.in_loop);

        // `item` inside any loop is in scope; outside every loop it is not.
        let sku = find(&r, RefKind::Item, "item.sku");
        assert_eq!(sku.in_scope, Some(true));
        let oops = find(&r, RefKind::Item, "item.oops");
        assert_eq!(oops.in_scope, Some(false));
        assert!(!oops.in_loop);
        assert_eq!(oops.line, Some(9));

        // Two `product.title` refs land on successive occurrences.
        let titles: Vec<_> = r
            .iter()
            .filter(|x| x.name == "product.title")
            .map(|x| x.line)
            .collect();
        assert_eq!(titles, vec![Some(3), Some(5)]);
    }

    #[test]
    fn alias_used_outside_its_loop_is_a_data_source_fact() {
        let r = refs(
            "Column {\n    Text(@spacetime.messages)\n    Text(\"@{Math.round(state.x)}\")\n}",
        );
        let ds = of_kind(&r, RefKind::DataSource);
        // The direct reference is reported; `Math.round` from expression
        // extraction is not.
        assert_eq!(ds.len(), 1);
        assert_eq!(ds[0].name, "spacetime.messages");
        assert_eq!(ds[0].root.as_deref(), Some("spacetime"));
        assert!(find(&r, RefKind::State, "x").from_expression);
    }

    #[test]
    fn conditionals_and_their_branches() {
        let src = r#"Column {
    If(condition: @state.open) {
        Text("@{state.detail}")
    }
    When(value: @state.status) {
        Case(match: "ready") { Button { Text("Go") }.onClick(@actions.go) }
        Else { Text("@{item.x}") }
    }
}"#;
        let r = refs(src);
        assert_eq!(find(&r, RefKind::State, "open").element_type, "Conditional");
        assert_eq!(find(&r, RefKind::State, "open").line, Some(2));
        assert_eq!(find(&r, RefKind::State, "detail").line, Some(3));
        assert_eq!(find(&r, RefKind::State, "status").line, Some(5));
        assert_eq!(find(&r, RefKind::Action, "go").line, Some(6));
        assert_eq!(find(&r, RefKind::Item, "item.x").in_scope, Some(false));
    }

    #[test]
    fn router_children_are_walked() {
        let src = r#"Router {
    Route(path: "/") { Home() }
    Route(path: "/p/:id") { Text("@{state.page}").onClick(@actions.open) }
}"#;
        let r = refs(src);
        let home = find(&r, RefKind::Component, "Home");
        assert_eq!(home.builtin, Some(false));
        assert_eq!((home.line, home.col), (Some(2), Some(24)));
        assert_eq!(find(&r, RefKind::State, "page").line, Some(3));
        assert_eq!(find(&r, RefKind::Action, "open").line, Some(3));
        // Route/Router themselves are control flow, not component refs.
        assert!(of_kind(&r, RefKind::Component)
            .iter()
            .all(|c| c.name != "Route" && c.name != "Router"));
    }

    #[test]
    fn components_are_flagged_builtin_or_not_and_carry_loop_context() {
        let src = "Column {\n    Text(\"a\")\n    tabs { }\n    ForEach(items: @state.posts) { PostCard() }\n}";
        let r = refs(src);
        assert_eq!(find(&r, RefKind::Component, "Text").builtin, Some(true));
        // Case-insensitive, like the renderers.
        assert_eq!(find(&r, RefKind::Component, "tabs").builtin, Some(true));
        let card = find(&r, RefKind::Component, "PostCard");
        assert_eq!(card.builtin, Some(false));
        assert!(card.in_loop);
    }

    #[test]
    fn module_scope_and_declarations_are_reported() {
        let report =
            template_refs_source("module Counter {\n    Text(\"@{state.count}\")\n}").unwrap();
        assert_eq!(report.declared_components, vec!["Counter"]);
        let count = find(&report.refs, RefKind::State, "count");
        assert_eq!(count.module_scope.as_deref(), Some("counter"));
    }

    #[test]
    fn length_and_comment_occurrences_do_not_misplace_refs() {
        let src = "Column {\n    // shows @state.items here\n    Text(\"@{state.items.length} items\")\n}";
        let r = refs(src);
        let items = find(&r, RefKind::State, "items");
        assert_eq!(items.line, Some(3));
    }

    #[test]
    fn check_ignore_directives_scope_to_their_reference() {
        let src = r#"Column {
    Text("@{state.a}") // hypen-check-ignore unknown-state-path
    // hypen-check-ignore
    Text("@{state.b}")
    Text("@{state.c}")
    // hypen-check-ignore unknown-action
    Button { Text("x") }
        .onClick(@actions.d)
}"#;
        let r = refs(src);
        let a = find(&r, RefKind::State, "a");
        assert_eq!(a.ignore_rules, vec!["unknown-state-path"]);
        assert!(!a.ignore_all);
        assert!(find(&r, RefKind::State, "b").ignore_all);
        let c = find(&r, RefKind::State, "c");
        assert!(!c.ignore_all && c.ignore_rules.is_empty());
        // Element-level: the directive above the Button covers the action on
        // its applicator line.
        assert_eq!(
            find(&r, RefKind::Action, "d").ignore_rules,
            vec!["unknown-action"]
        );
    }

    #[test]
    fn unknown_ignore_ids_are_reported() {
        let report = template_refs_source(
            "Column {\n    Text(\"x\") // hypen-check-ignore unknown-stat-path\n    Text(\"y\") // hypen-check-ignore future-rule, unknown-ignore-rule\n}",
        )
        .unwrap();
        assert_eq!(report.diagnostics.len(), 2);
        let typo = &report.diagnostics[0];
        assert_eq!(typo.rule, CheckRule::UnknownIgnoreRule);
        assert_eq!((typo.line, typo.col), (Some(2), Some(37)));
        assert!(!typo.suppressed);
        assert!(report.diagnostics[1].suppressed);
    }

    #[test]
    fn map_arguments_keep_their_nested_refs() {
        let r = refs("ForEach(items: @state.rows) {\n    Button { Text(\"x\") }.onClick(@actions.pick, data: {id: @item.id})\n}");
        let id = find(&r, RefKind::Item, "item.id");
        assert_eq!(id.in_scope, Some(true));
        assert_eq!(id.line, Some(2));
    }

    /// `List(@state.x) { … }.display(...)` lowers to a wrapper element AND a
    /// ForEach that both carry the applicator props. The mirrored copy must
    /// not be reported twice — and must not steal a later sibling's
    /// occurrence of the same text.
    #[test]
    fn list_wrapper_props_are_reported_once_and_stay_in_place() {
        let src = r#"Column {
    List(@state.cart) {
        Text("@{item.name}")
    }
    .display("@{state.cart.length > 0 ? 'flex' : 'none'}")
    Column { Text("x") }
        .display("@{state.cart.length > 0 ? 'flex' : 'none'}")
}"#;
        let r = refs(src);
        let mut lines: Vec<_> = r
            .iter()
            .filter(|x| x.kind == RefKind::State && x.name == "cart")
            .map(|x| (x.line, x.element_type.as_str()))
            .collect();
        lines.sort();
        assert_eq!(
            lines,
            vec![(Some(2), "ForEach"), (Some(5), "List"), (Some(7), "Column"),]
        );
    }

    #[test]
    fn parse_errors_surface() {
        assert!(template_refs_source("Column {").is_err());
    }
}
