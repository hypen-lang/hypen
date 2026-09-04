//! Dev-mode accessibility conformance checks.
//!
//! Walks an expanded IR tree and flags **only** the gaps the engine cannot
//! derive its way out of — an interactive control with no accessible name, an
//! image with no alt text, a heading with no level, an interactive control
//! nested inside another. It stays silent wherever derivation succeeded; a
//! noisy check gets disabled, and a check that fires on correct code is worse
//! than none.
//!
//! This consumes the [`Semantics`](crate::ir::Semantics) already computed
//! during expansion, so it is purely a reporting pass. Hosts (dev builds, the
//! LSP) call [`check_accessibility`] and surface the diagnostics.
//!
//! Source locations: each diagnostic carries the offending element's
//! name-token byte span ([`SourceSpan`], threaded from the parser's AST
//! metadata through [`crate::ir::ast_to_ir_node`]). Hosts that hold the
//! source string resolve it to `line:col` via [`crate::ir::LineIndex`] — or
//! call [`check_accessibility_source_located`], which does both.
//!
//! Suppression: an inline `// hypen-a11y-ignore [rule-id, …]` line comment
//! (trailing on any line of the flagged element's expression — through the
//! end of a multiline applicator chain — or alone on the line directly
//! before it) marks matching findings [`LocatedDiagnostic::suppressed`].
//! Comments never reach the AST, so the directive is resolved here at the
//! located boundary, against the source string the host already supplies.
//! Suppressed findings are flagged, never dropped — hosts count and report
//! them ("N findings suppressed") so suppression can't silently hide real
//! gaps. A directive naming a rule id this engine doesn't implement fires
//! [`A11yRule::UnknownIgnoreRule`] instead of silently suppressing nothing.

use crate::ir::node::{Element, IRNode, Value};
use crate::ir::semantics::{is_known_dir_token, is_known_role_token, Role};
use crate::ir::span::{LineIndex, SourceSpan};
use serde::Serialize;

/// A single accessibility finding. Serializes to camelCase JSON for hosts /
/// dev tooling.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct A11yDiagnostic {
    /// Which rule fired.
    pub rule: A11yRule,
    /// The element type the finding is about (e.g. `"Button"`).
    pub element_type: String,
    /// Human-readable, actionable message.
    pub message: String,
    /// Byte span of the element's name token in the source, when the IR was
    /// built from parsed source (hand-built IR trees have no span). Hosts
    /// resolve it to `line:col` with the source string they already hold.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub span: Option<SourceSpan>,
    /// Byte span of the element's full expression (declaration keyword
    /// through the last applicator), when known. Consulted only for inline
    /// suppression matching — hosts point squiggles at `span`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expr_span: Option<SourceSpan>,
}

/// The accessibility rules this pass checks. Each is something the engine
/// *cannot* fix automatically — it needs the author.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum A11yRule {
    /// An interactive control (button/link) has no derivable accessible name.
    MissingAccessibleName,
    /// An image has no `alt` text.
    ImageMissingAlt,
    /// A heading does not specify its level.
    HeadingMissingLevel,
    /// An interactive control is nested inside another interactive control.
    NestedInteractive,
    /// A form control (textbox/checkbox/switch/listbox/slider) has no label.
    /// Form controls get their accessible name from an associated label, not
    /// their content, so an unlabeled one has no accessible name.
    FormControlMissingLabel,
    /// A `.role(...)` / `.landmark(...)` applicator used a token the engine
    /// doesn't recognise (e.g. a typo), so it was silently ignored.
    UnknownRoleToken,
    /// A `.dir(...)` applicator used a token other than `ltr`/`rtl`/`auto`,
    /// so it was silently ignored. Same guard as [`UnknownRoleToken`]: only
    /// a *static* string token can be validated — bound values are skipped.
    UnknownDirToken,
    /// A cross-node reference (`.controls`/`.describedby`/`.labelledby`/
    /// static `.activedescendant`) targets an id that no element in the
    /// checked scope declares via `.id(...)` — the ARIA equivalent of a
    /// dangling `for`/`id` pair, which fails silently at runtime.
    ///
    /// False-positive guard: only fired when the checked scope declares at
    /// least one `.id(...)` — a scope with none is assumed to reference ids
    /// minted outside Hypen (embedding) or in another file — and never when
    /// the scope contains any *dynamic* (bound/templated) `.id(...)`, whose
    /// ids exist only at reconcile (see [`IdScope::has_dynamic`]).
    DanglingReference,
    /// Two elements statically declare the same `.id(...)` in one checked
    /// scope. Id references resolve to exactly one element, so a duplicate
    /// makes every reference to that id ambiguous (an `activedescendant`
    /// lands on the wrong node). Fired on the *second* declaration; static
    /// ids only. Ids in sibling branches of a Conditional/Router are
    /// mutually exclusive at runtime and are not duplicates.
    DuplicateId,
    /// A tablist opted into auto-wiring with `.id(...)` but its direct
    /// children hold a nonzero, unequal number of tab-role and tabpanel-role
    /// elements, so `wire_tablist` skipped minting the whole tab↔panel id
    /// graph. Zero panels inside is the documented fully-portaled shape and
    /// stays silent — only a nonzero mismatch is a likely authoring mistake.
    TablistWiringSkipped,
    /// `.aria(...)` was used: a raw escape hatch that emits an `aria-*`
    /// attribute only the DOM renderer understands — Canvas/iOS/Android/
    /// desktop never see it. Informational: legitimate when no portable
    /// applicator covers the intent, but a portable one should win when it
    /// exists.
    NonPortableAria,
    /// A `.liveRegion(...)` applicator used a token other than
    /// `"polite"`/`"assertive"`, so it was silently ignored — the same
    /// silent-typo class as `UnknownRoleToken`/`UnknownDirToken`.
    UnknownLiveToken,
    /// A `// hypen-a11y-ignore` directive names a rule id this engine does
    /// not implement (a typo, or a rule from a newer engine), so that entry
    /// suppresses nothing — the same silent-failure class as the
    /// unknown-token rules, applied to the suppression syntax itself. Fired
    /// at the directive's own location during located resolution (directives
    /// live only in raw source); bare directives are unaffected.
    UnknownIgnoreRule,
    /// A `Video` has no accessible label. Its content is a media stream —
    /// nothing derivable — so without a `title`/`label`/`alt` prop (or an
    /// explicit `.label(...)`) the player has no accessible name. Same class
    /// as [`ImageMissingAlt`](Self::ImageMissingAlt).
    VideoMissingLabel,
}

/// Every rule the pass can emit, in declaration order. This is the single
/// source the WASM binding's `a11yRules()` getter reads, so hosts can detect
/// a stale prebuilt engine: a binding that predates a rule still exposes
/// `checkAccessibility` and looks current while silently never firing the
/// newer rule. The unit test below forces this list to stay exhaustive.
pub const ALL_RULES: &[A11yRule] = &[
    A11yRule::MissingAccessibleName,
    A11yRule::ImageMissingAlt,
    A11yRule::HeadingMissingLevel,
    A11yRule::NestedInteractive,
    A11yRule::FormControlMissingLabel,
    A11yRule::UnknownRoleToken,
    A11yRule::UnknownDirToken,
    A11yRule::DanglingReference,
    A11yRule::DuplicateId,
    A11yRule::TablistWiringSkipped,
    A11yRule::NonPortableAria,
    A11yRule::UnknownLiveToken,
    A11yRule::UnknownIgnoreRule,
    A11yRule::VideoMissingLabel,
];

impl A11yRule {
    /// Kebab-case id of this rule, derived via the same serde serialization
    /// that produces `A11yDiagnostic::rule` — the string hosts compare
    /// against and authors write in `// hypen-a11y-ignore` directives.
    pub fn id(self) -> String {
        match serde_json::to_value(self) {
            Ok(serde_json::Value::String(id)) => id,
            _ => unreachable!("A11yRule serializes as a kebab-case string"),
        }
    }
}

/// Kebab-case id of each entry in [`ALL_RULES`] — the exact strings hosts
/// compare against for rule-set drift detection.
pub fn all_rule_ids() -> Vec<String> {
    ALL_RULES.iter().map(|rule| rule.id()).collect()
}

/// Run the accessibility conformance pass over an expanded IR subtree.
///
/// Returns one [`A11yDiagnostic`] per finding, in document order. An empty
/// result means nothing actionable was found.
pub fn check_accessibility(node: &IRNode) -> Vec<A11yDiagnostic> {
    check_accessibility_trees(std::slice::from_ref(node))
}

/// Run the conformance pass over several expanded trees that share one id
/// scope — the components of a single document. Cross-node references
/// (`.controls("x")`) may legally target an `.id("x")` declared in a sibling
/// component, so id collection must span all of them before any tree is
/// checked; checking components one-by-one would false-positive on exactly
/// the composite patterns the reference vocabulary exists for.
pub fn check_accessibility_trees(trees: &[IRNode]) -> Vec<A11yDiagnostic> {
    let mut scope = IdScope::default();
    let mut diagnostics = Vec::new();
    for tree in trees {
        collect_ids(tree, &mut scope, &mut diagnostics);
    }
    for tree in trees {
        walk(tree, false, &scope, &mut diagnostics);
    }
    diagnostics
}

/// The id universe of one checked scope, gathered before any tree is walked.
#[derive(Default)]
struct IdScope {
    /// Every statically-declared `.id(...)` (author-written or expand-minted).
    declared: std::collections::HashSet<String>,
    /// Whether any element in scope carries a *bound or templated* `.id(...)`
    /// (`.id("opt-@{item.id}")` inside a ForEach). Those ids exist only at
    /// reconcile, so the static id universe is incomplete: a reference into a
    /// dynamically-minted graph is indistinguishable from a genuine dangle.
    /// When set, [`A11yRule::DanglingReference`] is suppressed for the whole
    /// scope — the ForEach-minted option/tab graphs are exactly the
    /// composites the reference vocabulary exists for, and silence on
    /// something unverifiable beats flagging correct code.
    has_dynamic: bool,
}

/// First pass: gather every author-declared `.id(...)` in the tree, so the
/// reference check can resolve against the full scope regardless of where
/// the target sits relative to the referrer. Also detects dynamic ids (see
/// [`IdScope::has_dynamic`]) and reports a [`A11yRule::DuplicateId`] on the
/// second static declaration of an id — id references resolve to exactly one
/// element, so the `HashSet` deduping silently would hide a real ambiguity.
fn collect_ids(node: &IRNode, scope: &mut IdScope, out: &mut Vec<A11yDiagnostic>) {
    match node {
        IRNode::Element(element) => {
            if matches!(
                element.props.get("id.0"),
                Some(Value::Binding(_)) | Some(Value::TemplateString { .. })
            ) {
                scope.has_dynamic = true;
            }
            if let Some(id) = element.semantics.as_ref().and_then(|s| s.id.as_ref()) {
                if !scope.declared.insert(id.clone()) {
                    push_finding(
                        out,
                        element,
                        A11yRule::DuplicateId,
                        format!(
                            "{}: .id(\"{id}\") is already declared by another element in \
                             this scope — references resolve to only one of them, so \
                             rename one id",
                            element.element_type
                        ),
                    );
                }
            }
            for child in &element.ir_children {
                collect_ids(child, scope, out);
            }
        }
        IRNode::ForEach { template, .. } => {
            for child in template {
                collect_ids(child, scope, out);
            }
        }
        // Branches of a Conditional/Router are mutually exclusive at
        // runtime, so the same static id in two sibling branches is legal
        // (only one renders) — never a duplicate.
        IRNode::Conditional {
            branches, fallback, ..
        } => {
            let mut groups: Vec<&[IRNode]> =
                branches.iter().map(|b| b.children.as_slice()).collect();
            if let Some(fallback) = fallback {
                groups.push(fallback.as_slice());
            }
            collect_exclusive_branch_ids(&groups, scope, out);
        }
        IRNode::Router {
            routes, fallback, ..
        } => {
            let mut groups: Vec<&[IRNode]> = routes.iter().map(|r| r.children.as_slice()).collect();
            if let Some(fallback) = fallback {
                groups.push(fallback.as_slice());
            }
            collect_exclusive_branch_ids(&groups, scope, out);
        }
    }
}

/// Collect ids from mutually-exclusive branches: each branch is checked for
/// duplicates against the *enclosing* declarations only (a duplicate within
/// one branch, or against an id outside the conditional, still fires — those
/// coexist at runtime), and every branch's declarations are unioned into the
/// scope afterwards so cross-branch references still resolve.
fn collect_exclusive_branch_ids(
    branch_groups: &[&[IRNode]],
    scope: &mut IdScope,
    out: &mut Vec<A11yDiagnostic>,
) {
    let enclosing = scope.declared.clone();
    let mut union = std::mem::take(&mut scope.declared);
    for group in branch_groups {
        scope.declared = enclosing.clone();
        for child in *group {
            collect_ids(child, scope, out);
        }
        union.extend(std::mem::take(&mut scope.declared));
    }
    scope.declared = union;
}

/// Parse a component source string, expand it, and run the accessibility
/// conformance pass — the host-facing entry point (dev builds, the LSP, the
/// CLI). Returns the parse error message on a syntax error.
pub fn check_accessibility_source(source: &str) -> Result<Vec<A11yDiagnostic>, String> {
    let component = hypen_parser::parse_component(source).map_err(|e| format!("{e:?}"))?;
    Ok(check_accessibility(&crate::ir::ast_to_ir_node(&component)))
}

/// A diagnostic with its span resolved to a human-facing source position.
///
/// `line`/`col` are **1-based**; `col` counts Unicode codepoints (the CLI
/// convention). LSP consumers need 0-based UTF-16 positions instead — they
/// should resolve `diagnostic.span` themselves via
/// [`LineIndex::locate_utf16`], not reuse these fields.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocatedDiagnostic {
    /// The underlying finding (including its raw byte span).
    #[serde(flatten)]
    pub diagnostic: A11yDiagnostic,
    /// 1-based source line, when the diagnostic has a span.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<usize>,
    /// 1-based column in Unicode codepoints, when the diagnostic has a span.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub col: Option<usize>,
    /// An inline `// hypen-a11y-ignore` directive matched this finding. The
    /// finding is kept (hosts count and report suppressed findings so
    /// suppression stays visible) but must not fail a check or squiggle.
    /// Omitted from JSON when false, so unsuppressed findings keep the shape
    /// older hosts expect.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub suppressed: bool,
}

/// The scope of one `// hypen-a11y-ignore` directive.
enum IgnoreDirective {
    /// Bare form — suppresses every rule.
    All,
    /// Rule-scoped form — suppresses only the listed kebab-case rule ids.
    Rules(Vec<String>),
}

impl IgnoreDirective {
    fn matches(&self, rule: A11yRule) -> bool {
        match self {
            IgnoreDirective::All => true,
            IgnoreDirective::Rules(ids) => ids.contains(&rule.id()),
        }
    }
}

/// Parse a `// hypen-a11y-ignore [rule-id[, rule-id…]]` directive out of one
/// source line, if present. The token must open a line comment's text and
/// stand alone as a word (`// hypen-a11y-ignored` is not a directive); the
/// remainder of the comment is a comma/whitespace-separated rule-id list, so
/// the bare form suppresses all rules. Comments live only in the raw source
/// (the parser strips them), which is exactly what this pass holds. A `//`
/// inside a string literal is skipped because the token won't follow it —
/// only the literal text `// hypen-a11y-ignore` inside a string can confuse
/// it, which is pathological enough to accept.
fn ignore_directive(line: &str) -> Option<IgnoreDirective> {
    let mut rest = line;
    while let Some(pos) = rest.find("//") {
        let comment = rest[pos + 2..].trim_start();
        if let Some(args) = comment.strip_prefix("hypen-a11y-ignore") {
            if args.is_empty() || args.starts_with(char::is_whitespace) {
                let ids: Vec<String> = args
                    .split(|c: char| c == ',' || c.is_whitespace())
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .collect();
                return Some(if ids.is_empty() {
                    IgnoreDirective::All
                } else {
                    IgnoreDirective::Rules(ids)
                });
            }
        }
        rest = &rest[pos + 2..];
    }
    None
}

/// Whether an inline directive suppresses a finding whose element name token
/// starts on `line` and whose expression ends on `end_line` (both 0-based):
/// a trailing directive on any line of that window — so the end of a
/// multiline applicator chain works — or a directive on a **comment-only**
/// previous line. The comment-only requirement keeps a trailing directive
/// scoped to its own element — it must not bleed onto the element below it —
/// and a blank line between a comment-only directive and the element breaks
/// the association (eslint-style; deliberately not relaxed, so a directive
/// orphaned by later edits doesn't silently latch onto whatever element
/// drifts beneath it).
fn inline_suppressed(lines: &[&str], line: usize, end_line: usize, rule: A11yRule) -> bool {
    for candidate in line..=end_line {
        let Some(text) = lines.get(candidate) else {
            break;
        };
        if let Some(directive) = ignore_directive(text) {
            if directive.matches(rule) {
                return true;
            }
        }
    }
    if line > 0 {
        let prev = lines[line - 1];
        if prev.trim_start().starts_with("//") {
            if let Some(directive) = ignore_directive(prev) {
                return directive.matches(rule);
            }
        }
    }
    false
}

/// Resolve each diagnostic's byte span against `source`, producing
/// CLI-convention (1-based, codepoint-column) locations, and apply inline
/// `// hypen-a11y-ignore` directives (see [`inline_suppressed`]). Diagnostics
/// without a span pass through with `line`/`col` unset and are never
/// suppressible inline. Directives naming a rule id this engine doesn't
/// implement additionally produce an [`A11yRule::UnknownIgnoreRule`] finding
/// at the id's own location (see [`unknown_ignore_rule_findings`]). This is
/// the shared boundary: the WASM binding and
/// [`check_accessibility_source_located`] both route through here, so every
/// host gets one directive semantics.
pub fn locate_diagnostics(
    diagnostics: Vec<A11yDiagnostic>,
    source: &str,
) -> Vec<LocatedDiagnostic> {
    let index = LineIndex::new(source);
    let lines: Vec<&str> = source.lines().collect();
    let mut located: Vec<LocatedDiagnostic> = diagnostics
        .into_iter()
        .map(|diagnostic| {
            let located = diagnostic.span.map(|s| index.locate(s.start));
            let suppressed = located.is_some_and(|(line, _)| {
                // The window runs to the end of the element's expression so
                // a directive trailing a multiline applicator chain counts;
                // without an expr span it degrades to the single line.
                // `end - 1` is the expression's last byte — `end` itself is
                // exclusive and could sit on the terminating newline.
                let end_line = diagnostic
                    .expr_span
                    .filter(|s| s.end > s.start)
                    .map(|s| index.locate(s.end - 1).0)
                    .map_or(line, |end| end.max(line));
                inline_suppressed(&lines, line - 1, end_line - 1, diagnostic.rule)
            });
            LocatedDiagnostic {
                diagnostic,
                line: located.map(|(line, _)| line),
                col: located.map(|(_, col)| col),
                suppressed,
            }
        })
        .collect();
    located.extend(unknown_ignore_rule_findings(source, &index, &lines));
    located
}

/// Scan every `// hypen-a11y-ignore` directive in `source` for rule ids not
/// in [`ALL_RULES`] and report each as an [`A11yRule::UnknownIgnoreRule`]
/// finding spanning the offending id — a typo'd id suppresses nothing, and
/// without this the author gets no hint the directive itself is broken. Bare
/// directives carry no ids and are untouched. A directive that *explicitly*
/// lists `unknown-ignore-rule` suppresses these findings on its own line —
/// the escape hatch for ids a newer engine implements.
fn unknown_ignore_rule_findings(
    source: &str,
    index: &LineIndex,
    lines: &[&str],
) -> Vec<LocatedDiagnostic> {
    let known: std::collections::HashSet<String> = all_rule_ids().into_iter().collect();
    let mut findings = Vec::new();
    let mut line_start = 0usize;
    for (line_no, raw) in source.split_inclusive('\n').enumerate() {
        let line = raw.trim_end_matches('\n').trim_end_matches('\r');
        if let Some(IgnoreDirective::Rules(ids)) = ignore_directive(line) {
            // Ids are matched after the directive token, so an id string
            // appearing earlier in the line (e.g. inside code) can't skew
            // the span.
            let search_from = line
                .find("hypen-a11y-ignore")
                .map_or(0, |pos| pos + "hypen-a11y-ignore".len());
            for id in ids.iter().filter(|id| !known.contains(*id)) {
                let start = line[search_from..]
                    .find(id.as_str())
                    .map(|rel| line_start + search_from + rel);
                let span = start.map(|start| SourceSpan {
                    start,
                    end: start + id.len(),
                });
                let rule = A11yRule::UnknownIgnoreRule;
                let suppressed = inline_suppressed(lines, line_no, line_no, rule);
                let located = span.map(|s| index.locate(s.start));
                findings.push(LocatedDiagnostic {
                    diagnostic: A11yDiagnostic {
                        rule,
                        element_type: "hypen-a11y-ignore".to_string(),
                        message: format!(
                            "\"{id}\" is not a rule this engine implements, so this directive \
                             entry suppresses nothing — check the spelling against the rule \
                             list (or add `unknown-ignore-rule` to the directive if the id \
                             comes from a newer engine)"
                        ),
                        span,
                        expr_span: None,
                    },
                    line: located.map(|(line, _)| line),
                    col: located.map(|(_, col)| col),
                    suppressed,
                });
            }
        }
        line_start += raw.len();
    }
    findings
}

/// [`check_accessibility_source`] plus span→`line:col` resolution — the
/// entry point for hosts that want printable locations without holding a
/// [`LineIndex`] themselves. Returns the parse error message on a syntax
/// error.
pub fn check_accessibility_source_located(source: &str) -> Result<Vec<LocatedDiagnostic>, String> {
    Ok(locate_diagnostics(
        check_accessibility_source(source)?,
        source,
    ))
}

/// Whether a role denotes an interactive control (for nesting checks).
fn is_interactive(role: Option<Role>) -> bool {
    matches!(role, Some(Role::Button) | Some(Role::Link))
}

/// Whether a role is a form control whose accessible name must come from a
/// label (rather than its text content): the externally-labeled set shared
/// with `expand::wire_form_labels` plus the self-labeling toggles
/// (Checkbox/Switch), whose label still has to exist.
fn is_form_control(role: Option<Role>) -> bool {
    role.is_some_and(|r| r.needs_external_label() || matches!(r, Role::Checkbox | Role::Switch))
}

fn walk(node: &IRNode, within_interactive: bool, scope: &IdScope, out: &mut Vec<A11yDiagnostic>) {
    match node {
        IRNode::Element(element) => check_element(element, within_interactive, scope, out),
        // Control-flow containers contribute no semantics themselves; recurse
        // into every branch/template so findings inside them are still caught.
        IRNode::ForEach { template, .. } => {
            for child in template {
                walk(child, within_interactive, scope, out);
            }
        }
        IRNode::Conditional {
            branches, fallback, ..
        } => {
            for branch in branches {
                for child in &branch.children {
                    walk(child, within_interactive, scope, out);
                }
            }
            if let Some(fallback) = fallback {
                for child in fallback {
                    walk(child, within_interactive, scope, out);
                }
            }
        }
        IRNode::Router {
            routes, fallback, ..
        } => {
            for route in routes {
                for child in &route.children {
                    walk(child, within_interactive, scope, out);
                }
            }
            if let Some(fallback) = fallback {
                for child in fallback {
                    walk(child, within_interactive, scope, out);
                }
            }
        }
    }
}

/// Push a finding, stamping it with the element's source spans.
fn push_finding(out: &mut Vec<A11yDiagnostic>, element: &Element, rule: A11yRule, message: String) {
    out.push(A11yDiagnostic {
        rule,
        element_type: element.element_type.clone(),
        message,
        span: element.span,
        expr_span: element.expr_span,
    });
}

fn check_element(
    element: &Element,
    within_interactive: bool,
    scope: &IdScope,
    out: &mut Vec<A11yDiagnostic>,
) {
    let semantics = element.semantics.as_ref();
    let role = semantics.and_then(|s| s.role);
    let ty = &element.element_type;

    // Required-but-missing accessible name. The message is tailored: an image
    // wants alt text, an interactive control wants a label or text content.
    if semantics.and_then(|s| s.name_missing) == Some(true) {
        if matches!(role, Some(Role::Img)) {
            push_finding(
                out,
                element,
                A11yRule::ImageMissingAlt,
                format!("{ty} has no alt text — add `alt: \"…\"` describing the image"),
            );
        } else if matches!(role, Some(Role::Video)) {
            push_finding(
                out,
                element,
                A11yRule::VideoMissingLabel,
                format!(
                    "{ty} has no accessible label — add `title: \"…\"` (or `.label(\"…\")`) \
                     describing the video"
                ),
            );
        } else {
            push_finding(
                out,
                element,
                A11yRule::MissingAccessibleName,
                format!("interactive {ty} has no accessible name — add visible text or a label"),
            );
        }
    }

    // Form control with no label: a textbox/checkbox/switch/listbox/slider
    // gets its accessible name from an associated label, not its content, so
    // an unlabeled one has no name. `semantics.name` being Some means an
    // explicit `.label(...)` was applied (derive_accessible_name sets an
    // explicit name for any role), so stay silent. `name_missing` does not
    // cover these roles — derive_name only flags button/link/img — so this
    // rule is the sole coverage for unlabeled form controls.
    //
    // `.labelledby(...)` also names the control — by reference. Resolved
    // against a declared id it IS the label; unresolved with ids in scope it
    // already fires DanglingReference (one finding per root cause, and
    // "add a .label" on top would tell the author to label twice); with no
    // ids declared it gets the same benefit of the doubt DanglingReference
    // gives (the target may be minted outside Hypen). A bound/templated
    // `.labelledby(...)` is `None` in semantics but resolves at reconcile —
    // author intent, not a gap — so the raw prop counts too.
    let labelled_by_reference = semantics.and_then(|s| s.labelledby.as_ref()).is_some()
        || element.props.contains_key("labelledby.0");
    if is_form_control(role)
        && semantics.and_then(|s| s.name.as_ref()).is_none()
        && semantics.and_then(|s| s.name_missing) != Some(true)
        && !labelled_by_reference
    {
        // An opt-in role (`.role("listbox")` on a generic container) is not a
        // native form control and is outside `wire_form_labels`' reach, so
        // the auto-association hint would be a dead end there.
        let message = if element.props.contains_key("role.0") {
            format!(
                "{ty} with an opted-in form-control role has no accessible name — \
                 add a `.label(\"…\")` or `.labelledby(id)`"
            )
        } else {
            format!(
                "form control {ty} has no label — add a `.label(\"…\")` (or place a static \
                 Text right before it under a parent with `.id(\"…\")` to auto-associate) \
                 so it has an accessible name"
            )
        };
        push_finding(out, element, A11yRule::FormControlMissingLabel, message);
    }

    // A `.role(...)` / `.landmark(...)` with an unrecognised token was silently
    // ignored by derivation — surface the typo instead.
    for key in ["role.0", "landmark.0"] {
        if let Some(Value::Static(serde_json::Value::String(token))) = element.props.get(key) {
            if !is_known_role_token(token) {
                push_finding(
                    out,
                    element,
                    A11yRule::UnknownRoleToken,
                    format!(
                        "{ty}: unknown {} token \"{token}\" was ignored — check the spelling",
                        key.trim_end_matches(".0")
                    ),
                );
            }
        }
    }

    // A `.dir(...)` with an unrecognised token was silently ignored by
    // derivation — surface the typo. Only a static string is checked (a
    // bound value can't be validated at IR time), so this cannot fire on
    // correct code.
    if let Some(Value::Static(serde_json::Value::String(token))) = element.props.get("dir.0") {
        if !is_known_dir_token(token) {
            push_finding(
                out,
                element,
                A11yRule::UnknownDirToken,
                format!(
                    "{ty}: unknown dir token \"{token}\" was ignored — expected \
                     \"ltr\", \"rtl\" or \"auto\""
                ),
            );
        }
    }

    // A `.liveRegion(...)` with an unrecognised token was silently ignored by
    // derivation — surface the typo. Static strings only, same guard as the
    // dir-token rule.
    if let Some(Value::Static(serde_json::Value::String(token))) = element.props.get("liveRegion.0")
    {
        if !crate::ir::semantics::is_known_live_token(token) {
            push_finding(
                out,
                element,
                A11yRule::UnknownLiveToken,
                format!(
                    "{ty}: unknown liveRegion token \"{token}\" was ignored — expected \
                     \"polite\" or \"assertive\""
                ),
            );
        }
    }

    // Heading without a level: the document outline is meaningless without it.
    if matches!(role, Some(Role::Heading)) && semantics.and_then(|s| s.level).is_none() {
        push_finding(
            out,
            element,
            A11yRule::HeadingMissingLevel,
            format!("{ty} has no level — set `level: N` (1–6) so the outline is correct"),
        );
    }

    // Tabs auto-wiring silently bails on a pair-count mismatch
    // (`expand::wire_tablist`) — an author who opted in with `.id(...)` gets
    // no id graph and no explanation. Fire only on a *nonzero* mismatch among
    // direct children: zero panels inside is the documented fully-portaled
    // shape (panels live elsewhere and are hand-wired), so it stays silent.
    if matches!(role, Some(Role::Tablist)) && semantics.and_then(|s| s.id.as_ref()).is_some() {
        let child_role = |child: &IRNode| {
            child
                .as_element()
                .and_then(|e| e.semantics.as_ref())
                .and_then(|s| s.role)
        };
        let tabs = element
            .ir_children
            .iter()
            .filter(|c| child_role(c) == Some(Role::Tab))
            .count();
        let panels = element
            .ir_children
            .iter()
            .filter(|c| child_role(c) == Some(Role::Tabpanel))
            .count();
        if tabs > 0 && panels > 0 && tabs != panels {
            push_finding(
                out,
                element,
                A11yRule::TablistWiringSkipped,
                format!(
                    "{ty} has {tabs} tab(s) but {panels} panel(s) among its direct children, \
                     so the tab↔panel id graph was not auto-wired — balance the pairs, or \
                     move every panel outside and wire `.id`/`.controls`/`.labelledby` by hand"
                ),
            );
        }
    }

    // `.aria(...)` emits a raw aria-* attribute only the DOM renderer
    // understands — Canvas/iOS/Android/desktop never see it. Informational,
    // not a defect: it is the sanctioned escape hatch, but a portable
    // applicator carries the same intent to every renderer when one exists.
    if element.props.contains_key("aria.0") {
        push_finding(
            out,
            element,
            A11yRule::NonPortableAria,
            format!(
                "{ty}: .aria(...) is web-only — the raw aria-* attribute is invisible to \
                 the Canvas/iOS/Android/desktop renderers; prefer a portable applicator \
                 (.label/.role/.expanded/…) when one exists"
            ),
        );
    }

    // Dangling cross-node references: `.controls("x")` where nothing in the
    // checked scope declares `.id("x")` fails silently at runtime, exactly
    // like a dangling HTML `for`/`id` pair. Guards: only fire when the scope
    // declares at least one id — a scope with none is assumed to reference
    // ids minted outside Hypen (embedding) or in another file — and never
    // when any dynamic `.id(...)` exists in scope (the static id universe is
    // then incomplete, see `IdScope::has_dynamic`).
    if !scope.declared.is_empty() && !scope.has_dynamic {
        if let Some(sem) = semantics {
            let references = [
                ("controls", &sem.controls),
                ("describedby", &sem.describedby),
                ("labelledby", &sem.labelledby),
                ("owns", &sem.owns),
                // Only a *static* activedescendant is visible here; bound
                // ones are None at IR time and resolve at reconcile.
                ("activedescendant", &sem.active_descendant),
            ];
            for (applicator, target) in references {
                if let Some(target) = target {
                    if !scope.declared.contains(target) {
                        push_finding(
                            out,
                            element,
                            A11yRule::DanglingReference,
                            format!(
                                "{ty}: .{applicator}(\"{target}\") references an id no element \
                                 declares — add `.id(\"{target}\")` to the target (or ignore if \
                                 it lives outside this document)"
                            ),
                        );
                    }
                }
            }
        }
    }

    // Interactive nested inside interactive (e.g. a Button inside a Link):
    // ambiguous activation and broken keyboard semantics.
    let interactive = is_interactive(role);
    if interactive && within_interactive {
        push_finding(
            out,
            element,
            A11yRule::NestedInteractive,
            format!("interactive {ty} is nested inside another interactive control"),
        );
    }

    let child_within_interactive = within_interactive || interactive;
    for child in &element.ir_children {
        walk(child, child_within_interactive, scope, out);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `ALL_RULES` must cover every [`A11yRule`] variant. The `match` below
    /// is exhaustive with no wildcard, so adding a variant to the enum fails
    /// this test at *compile* time until it is listed here — and the
    /// containment/length asserts then fail until `ALL_RULES` carries it too.
    #[test]
    fn all_rules_covers_every_variant() {
        let every = [
            A11yRule::MissingAccessibleName,
            A11yRule::ImageMissingAlt,
            A11yRule::HeadingMissingLevel,
            A11yRule::NestedInteractive,
            A11yRule::FormControlMissingLabel,
            A11yRule::UnknownRoleToken,
            A11yRule::UnknownDirToken,
            A11yRule::DanglingReference,
            A11yRule::DuplicateId,
            A11yRule::TablistWiringSkipped,
            A11yRule::NonPortableAria,
            A11yRule::UnknownLiveToken,
            A11yRule::UnknownIgnoreRule,
            A11yRule::VideoMissingLabel,
        ];
        for rule in every {
            match rule {
                A11yRule::MissingAccessibleName
                | A11yRule::ImageMissingAlt
                | A11yRule::HeadingMissingLevel
                | A11yRule::NestedInteractive
                | A11yRule::FormControlMissingLabel
                | A11yRule::UnknownRoleToken
                | A11yRule::UnknownDirToken
                | A11yRule::DanglingReference
                | A11yRule::DuplicateId
                | A11yRule::TablistWiringSkipped
                | A11yRule::NonPortableAria
                | A11yRule::UnknownLiveToken
                | A11yRule::UnknownIgnoreRule
                | A11yRule::VideoMissingLabel => {}
            }
            assert!(
                ALL_RULES.contains(&rule),
                "ALL_RULES is missing {rule:?} — the a11yRules() binding would drift"
            );
        }
        assert_eq!(
            ALL_RULES.len(),
            every.len(),
            "ALL_RULES has entries not covered by the exhaustive list above"
        );
    }

    /// Pins the exact kebab-case ids hosts see in `A11yDiagnostic::rule` —
    /// the TS `EXPECTED_A11Y_RULES` lists (core SDK, CLI, LSP) mirror these
    /// strings for drift detection.
    #[test]
    fn all_rule_ids_serialize_to_the_published_kebab_case_ids() {
        assert_eq!(
            all_rule_ids(),
            [
                "missing-accessible-name",
                "image-missing-alt",
                "heading-missing-level",
                "nested-interactive",
                "form-control-missing-label",
                "unknown-role-token",
                "unknown-dir-token",
                "dangling-reference",
                "duplicate-id",
                "tablist-wiring-skipped",
                "non-portable-aria",
                "unknown-live-token",
                "unknown-ignore-rule",
                "video-missing-label",
            ]
        );
    }
}
