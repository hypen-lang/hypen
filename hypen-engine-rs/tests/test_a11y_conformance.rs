//! Dev-mode accessibility conformance checks.
//!
//! Each rule must fire on the bad case AND stay silent on the inferrable good
//! case — the false-positive guard is the whole point. A check that fires on
//! correct code gets disabled, which is worse than no check.

use hypen_engine::ir::ast_to_ir_node;
use hypen_engine::{check_accessibility, A11yRule};
use hypen_parser::parse_component;

/// Parse + expand a component and run the conformance pass over it.
fn diagnose(src: &str) -> Vec<hypen_engine::A11yDiagnostic> {
    let component = parse_component(src).unwrap();
    check_accessibility(&ast_to_ir_node(&component))
}

fn rules(src: &str) -> Vec<A11yRule> {
    diagnose(src).into_iter().map(|d| d.rule).collect()
}

fn has(src: &str, rule: A11yRule) -> bool {
    rules(src).contains(&rule)
}

#[test]
fn missing_accessible_name_fires_on_icon_only_button_only() {
    // Bad: icon-only button has no derivable name.
    assert!(has(
        r#"Button { Icon("trash") }"#,
        A11yRule::MissingAccessibleName
    ));
    // Good: labelled button is silent.
    assert!(!has(r#"Button("Save")"#, A11yRule::MissingAccessibleName));
    assert!(!has(
        r#"Button { Icon("trash") Text("Delete") }"#,
        A11yRule::MissingAccessibleName
    ));
}

#[test]
fn control_flow_gated_label_is_flagged_missing() {
    // A button whose only content is behind a When can't be named statically.
    assert!(has(
        r#"Button { When(value: @state.x) { Case(match: "a") { Text("A") } } }"#,
        A11yRule::MissingAccessibleName
    ));
}

#[test]
fn image_missing_alt_fires_without_alt_only() {
    assert!(has(r#"Image(src: "/a.png")"#, A11yRule::ImageMissingAlt));
    // Good: alt present.
    assert!(!has(
        r#"Image(src: "/a.png", alt: "A cat")"#,
        A11yRule::ImageMissingAlt
    ));
}

#[test]
fn video_missing_label_fires_without_a_label_only() {
    // Bad: a video with no title/label — its content is a stream, nothing
    // derivable.
    assert!(has(
        r#"Video(src: "/a.mp4", controls: true)"#,
        A11yRule::VideoMissingLabel
    ));
    // Good: a `title` prop is the label.
    assert!(!has(
        r#"Video(src: "/a.mp4", title: "Big Buck Bunny")"#,
        A11yRule::VideoMissingLabel
    ));
    // Good: an explicit .label() supplies the name.
    assert!(!has(
        r#"Video(src: "/a.mp4").label("Product demo")"#,
        A11yRule::VideoMissingLabel
    ));
    // Good: decorative background video marked .hidden() is out of the tree.
    assert!(!has(
        r#"Video(src: "/bg.mp4").hidden()"#,
        A11yRule::VideoMissingLabel
    ));
    // A Video never fires the image or interactive-name rules.
    assert!(!has(r#"Video(src: "/a.mp4")"#, A11yRule::ImageMissingAlt));
    assert!(!has(
        r#"Video(src: "/a.mp4")"#,
        A11yRule::MissingAccessibleName
    ));
}

#[test]
fn heading_missing_level_fires_without_level_only() {
    assert!(has(r#"Heading("Title")"#, A11yRule::HeadingMissingLevel));
    // Good: level specified.
    assert!(!has(
        r#"Heading("Title", level: 2)"#,
        A11yRule::HeadingMissingLevel
    ));
}

#[test]
fn nested_interactive_fires_only_when_actually_nested() {
    // Bad: a Button inside a Link.
    assert!(has(
        r#"Link("Home") { Button("Go") }"#,
        A11yRule::NestedInteractive
    ));
    // Good: interactive control under a structural container is fine.
    assert!(!has(
        r#"Column { Button("Go") }"#,
        A11yRule::NestedInteractive
    ));
}

#[test]
fn form_control_missing_label_fires_on_unlabeled_input_only() {
    // Bad: an Input with no label has no accessible name (form controls get
    // their name from a label, not content).
    assert!(has(
        r#"Input(placeholder: "Name")"#,
        A11yRule::FormControlMissingLabel
    ));
    // Good: an explicit .label() supplies the name.
    assert!(!has(
        r#"Input(placeholder: "Email").label("Email")"#,
        A11yRule::FormControlMissingLabel
    ));
    // Good: positional text + .label() too.
    assert!(!has(
        r#"Input("x").label("Email")"#,
        A11yRule::FormControlMissingLabel
    ));
    // A Button is not a form control → unaffected by this rule.
    assert!(!has(
        r#"Button { Icon("trash") }"#,
        A11yRule::FormControlMissingLabel
    ));
    assert!(!has(r#"Button("Save")"#, A11yRule::FormControlMissingLabel));
}

#[test]
fn unknown_role_or_landmark_token_is_flagged() {
    // A typo'd token is silently ignored by derivation — the checker surfaces
    // it instead of leaving it broken.
    assert!(has(r#"Column.role("buton")"#, A11yRule::UnknownRoleToken));
    assert!(has(
        r#"Column { Text("x") }.landmark("regon")"#,
        A11yRule::UnknownRoleToken
    ));
    // Recognised tokens are silent.
    assert!(!has(r#"Card.role("list")"#, A11yRule::UnknownRoleToken));
    assert!(!has(
        r#"Column { Text("x") }.landmark("navigation")"#,
        A11yRule::UnknownRoleToken
    ));
}

#[test]
fn checkbox_visible_label_is_not_flagged_as_unlabeled() {
    // Checkbox/Switch render a <label> around the control, so their visible
    // label IS the accessible name — neither the positional nor the named
    // form should be flagged (the DX-review footgun: same string twice).
    for src in [
        r#"Checkbox("Accept terms")"#,
        r#"Checkbox(label: "Accept terms")"#,
        r#"Switch("Dark mode")"#,
    ] {
        assert!(
            !has(src, A11yRule::FormControlMissingLabel),
            "{src} has a visible label and must not be flagged"
        );
        assert!(
            !has(src, A11yRule::MissingAccessibleName),
            "{src} has a name and must not be flagged missing"
        );
    }
    // But a truly unlabeled checkbox is still flagged (as a missing name).
    assert!(has(r#"Checkbox {}"#, A11yRule::MissingAccessibleName));
}

#[test]
fn explicit_label_resolves_missing_name() {
    // An icon-only button warns; adding .label() silences it.
    assert!(has(
        r#"Button { Icon("trash") }"#,
        A11yRule::MissingAccessibleName
    ));
    assert!(!has(
        r#"Button { Icon("trash") }.label("Delete")"#,
        A11yRule::MissingAccessibleName
    ));
}

#[test]
fn hidden_decorative_elements_are_never_flagged() {
    // A decorative icon-only button marked .hidden() is out of the a11y tree,
    // so it must not be flagged missing-name.
    assert!(!has(
        r#"Button { Icon("trash") }.hidden()"#,
        A11yRule::MissingAccessibleName
    ));
    // A decorative image needs no alt.
    assert!(!has(
        r#"Image(src: "/divider.png").hidden()"#,
        A11yRule::ImageMissingAlt
    ));
}

#[test]
fn a_clean_tree_produces_no_diagnostics() {
    // Everything labelled and well-formed → silence.
    let clean = r#"Column {
        Heading("Welcome", level: 1)
        Image(src: "/a.png", alt: "A cat")
        Button("Save")
        Link("Home")
    }"#;
    assert!(
        diagnose(clean).is_empty(),
        "clean tree should produce no diagnostics, got: {:?}",
        diagnose(clean)
    );
}

#[test]
fn source_entry_point_parses_and_checks() {
    use hypen_engine::check_accessibility_source;

    let diags = check_accessibility_source(r#"Button { Icon("trash") }"#).unwrap();
    assert_eq!(diags.len(), 1);
    assert_eq!(diags[0].rule, A11yRule::MissingAccessibleName);
    assert_eq!(diags[0].element_type, "Button");

    // A clean source yields nothing.
    assert!(check_accessibility_source(r#"Button("Save")"#)
        .unwrap()
        .is_empty());

    // A syntax error surfaces as Err, not a panic.
    assert!(check_accessibility_source("Button(((").is_err());
}

#[test]
fn diagnostics_serialize_to_camel_case_json() {
    use hypen_engine::check_accessibility_source;

    let diags = check_accessibility_source(r#"Image(src: "/a.png")"#).unwrap();
    let json = serde_json::to_string(&diags[0]).unwrap();
    assert!(
        json.contains(r#""rule":"image-missing-alt""#),
        "got: {json}"
    );
    assert!(json.contains(r#""elementType":"Image""#), "got: {json}");
}

#[test]
fn diagnostics_carry_the_element_name_token_span() {
    // The span must be the byte range of the offending element's *name*
    // token — `Button` here — not the whole block.
    let src = r#"Column { Button { Icon("trash") } }"#;
    let diags = diagnose(src);
    assert_eq!(diags.len(), 1);
    let span = diags[0].span.expect("diagnostic should carry a span");
    assert_eq!(&src[span.start..span.end], "Button");
}

#[test]
fn located_entry_point_resolves_line_and_col() {
    use hypen_engine::check_accessibility_source_located;

    // Multi-line fixture with a multi-byte char ("é") on the line BEFORE the
    // finding and several on the SAME line before the token, locking the
    // codepoint-column rule (UTF-8 bytes would give a different column).
    let src = "Column {\n    Text(\"héllo\")\n    Text(\"éé\") Image(src: \"/a.png\")\n}";
    // Line 3 is `    Text("éé") Image(...)`; "Image" starts after
    // `    Text("éé") ` = 15 codepoints → codepoint column 16 (1-based).
    // In UTF-8 bytes that prefix is 17 bytes, so a byte-counting column
    // would (wrongly) report 18.
    let located = check_accessibility_source_located(src).unwrap();
    assert_eq!(located.len(), 1);
    assert_eq!(located[0].diagnostic.rule, A11yRule::ImageMissingAlt);
    assert_eq!(located[0].line, Some(3));
    assert_eq!(located[0].col, Some(16));

    // The raw span still underlines the name token for LSP consumers.
    let span = located[0].diagnostic.span.unwrap();
    assert_eq!(&src[span.start..span.end], "Image");

    // Syntax errors surface as Err, matching the unlocated entry point.
    assert!(check_accessibility_source_located("Button(((").is_err());
}

#[test]
fn located_diagnostics_serialize_flattened() {
    use hypen_engine::check_accessibility_source_located;

    let located = check_accessibility_source_located(r#"Image(src: "/a.png")"#).unwrap();
    let json = serde_json::to_string(&located[0]).unwrap();
    // Flattened: rule/message/span at the top level alongside line/col.
    assert!(
        json.contains(r#""rule":"image-missing-alt""#),
        "got: {json}"
    );
    assert!(
        json.contains(r#""span":{"start":0,"end":5}"#),
        "got: {json}"
    );
    assert!(json.contains(r#""line":1"#), "got: {json}");
    assert!(json.contains(r#""col":1"#), "got: {json}");
}

#[test]
fn dangling_reference_fires_only_when_target_id_is_missing() {
    // Resolving pair → silent.
    let resolving = r#"Column {
        Button("Show").controls("panel")
        Column { Text("Details") }.id("panel")
    }"#;
    assert!(!has(resolving, A11yRule::DanglingReference));

    // Reference with no matching .id() while the scope declares ids → flagged.
    let dangling = r#"Column {
        Button("Show").controls("pannel")
        Column { Text("Details") }.id("panel")
    }"#;
    let diags = diagnose(dangling);
    let finding = diags
        .iter()
        .find(|d| d.rule == A11yRule::DanglingReference)
        .expect("dangling .controls should be flagged");
    assert!(
        finding.message.contains("pannel"),
        "got: {}",
        finding.message
    );
    // The span points at the referring element's name token.
    let span = finding.span.expect("finding carries a span");
    assert_eq!(&dangling[span.start..span.end], "Button");
}

#[test]
fn dangling_reference_is_silent_when_scope_declares_no_ids() {
    // False-positive guard: a scope with zero .id() declarations is assumed
    // to reference ids minted outside Hypen (embedding, another file).
    let src = r#"Column { Button("Show").controls("external-panel") }"#;
    assert!(!has(src, A11yRule::DanglingReference));
}

#[test]
fn dangling_reference_covers_labelledby_and_describedby() {
    let src = r#"Column {
        Column { Text("Panel") }.id("panel-1").labelledby("tab-1")
        Input(placeholder: "Name").label("Name").describedby("hint-1")
    }"#;
    let rules: Vec<A11yRule> = diagnose(src)
        .into_iter()
        .filter(|d| d.rule == A11yRule::DanglingReference)
        .map(|d| d.rule)
        .collect();
    // Both tab-1 and hint-1 are undeclared → two findings.
    assert_eq!(rules.len(), 2, "got: {:?}", diagnose(src));
}

#[test]
fn cross_component_references_share_one_id_scope() {
    use hypen_engine::check_accessibility_trees;
    use hypen_parser::parse_components;

    // A tab in one component controls a panel declared in a sibling
    // component — checked together they resolve; one-by-one they would not.
    let src = r#"
        component Tabs { Button("Overview").controls("panel-overview") }
        component Panels { Column { Text("…") }.id("panel-overview") }
    "#;
    let components = parse_components(src).unwrap();
    let trees: Vec<_> = components.iter().map(ast_to_ir_node).collect();
    let dangling = check_accessibility_trees(&trees)
        .into_iter()
        .filter(|d| d.rule == A11yRule::DanglingReference)
        .count();
    assert_eq!(dangling, 0, "sibling-component target must resolve");
}

#[test]
fn findings_inside_control_flow_are_still_reported() {
    // An icon-only button nested inside a When branch must still be caught —
    // the checker recurses through control-flow containers.
    let src = r#"When(value: @state.x) {
        Case(match: "a") { Button { Icon("trash") } }
    }"#;
    assert!(has(src, A11yRule::MissingAccessibleName));
}

// ── Tabs auto-wiring (expand-time id graph) ──────────────────────────────

/// Expand a source and collect (element_type, semantics) for every element.
fn wired_semantics(src: &str) -> Vec<(String, hypen_engine::ir::Semantics)> {
    fn walk_elements(
        node: &hypen_engine::IRNode,
        out: &mut Vec<(String, hypen_engine::ir::Semantics)>,
    ) {
        if let hypen_engine::IRNode::Element(e) = node {
            if let Some(s) = &e.semantics {
                out.push((e.element_type.clone(), s.clone()));
            }
            for child in &e.ir_children {
                walk_elements(child, out);
            }
        }
    }
    let component = parse_component(src).unwrap();
    let mut out = Vec::new();
    walk_elements(&ast_to_ir_node(&component), &mut out);
    out
}

/// Expand a source to its root element.
fn expand_root(src: &str) -> hypen_engine::Element {
    let component = parse_component(src).unwrap();
    match ast_to_ir_node(&component) {
        hypen_engine::IRNode::Element(e) => e,
        other => panic!("expected an Element root, got {other:?}"),
    }
}

#[test]
fn tabs_with_an_id_get_their_tab_panel_graph_wired() {
    let src = r#"Tabs {
        Tab("Overview")
        Tab("Details")
        TabPanel { Text("Overview content") }
        TabPanel { Text("Details content") }
    }.id("settings")"#;

    let all = wired_semantics(src);
    let tabs: Vec<_> = all.iter().filter(|(t, _)| t == "Tab").collect();
    let panels: Vec<_> = all.iter().filter(|(t, _)| t == "TabPanel").collect();

    assert_eq!(tabs[0].1.id.as_deref(), Some("settings-tab-0"));
    assert_eq!(tabs[0].1.controls.as_deref(), Some("settings-panel-0"));
    assert_eq!(tabs[1].1.id.as_deref(), Some("settings-tab-1"));
    assert_eq!(tabs[1].1.controls.as_deref(), Some("settings-panel-1"));
    assert_eq!(panels[0].1.id.as_deref(), Some("settings-panel-0"));
    assert_eq!(panels[0].1.labelledby.as_deref(), Some("settings-tab-0"));
    assert_eq!(panels[1].1.id.as_deref(), Some("settings-panel-1"));
    assert_eq!(panels[1].1.labelledby.as_deref(), Some("settings-tab-1"));

    // And the wired graph is self-consistent: zero dangling references.
    assert!(
        !has(src, A11yRule::DanglingReference),
        "wired graph must resolve"
    );

    // Mixed children restructure: the tablist role moves to a synthetic
    // tab-only inner element (ARIA allows only tabs inside a tablist); the
    // outer container keeps the author id but no role, and the panels stay
    // its direct children.
    use hypen_engine::ir::Role;
    let root = expand_root(src);
    let root_sem = root.semantics.as_ref().expect("outer keeps its id");
    assert_eq!(root_sem.role, None);
    assert_eq!(root_sem.id.as_deref(), Some("settings"));
    let types: Vec<_> = root
        .ir_children
        .iter()
        .map(|c| c.as_element().unwrap().element_type.as_str())
        .collect();
    assert_eq!(types, ["Tabs", "TabPanel", "TabPanel"]);
    let inner = root.ir_children[0].as_element().unwrap();
    let inner_sem = inner.semantics.as_ref().unwrap();
    assert_eq!(inner_sem.role, Some(Role::Tablist));
    assert_eq!(inner_sem.id, None, "a copied id would be a DuplicateId");
    let inner_types: Vec<_> = inner
        .ir_children
        .iter()
        .map(|c| c.as_element().unwrap().element_type.as_str())
        .collect();
    assert_eq!(inner_types, ["Tab", "Tab"]);
}

/// This shape is the engine-output contract the axe-core harness renders by
/// hand ("the engine's auto-wired mixed Tabs shape" in
/// `hypen-web/tests/a11y.axe.test.ts`) — a change here means that hand-built
/// patch tree must change with it.
#[test]
fn tabs_mixed_children_restructure_into_tab_only_tablist() {
    use hypen_engine::ir::Role;

    let root =
        expand_root(r#"Tabs { Tab("Profile") TabPanel { Text("Profile settings") } }.id("s")"#);

    // Outer: plain group container — author id kept, tablist role gone.
    assert_eq!(root.element_type, "Tabs");
    let root_sem = root.semantics.as_ref().unwrap();
    assert_eq!(root_sem.role, None);
    assert_eq!(root_sem.id.as_deref(), Some("s"));

    // Inner synthetic tablist at the first tab's position, holding ONLY the
    // tab; the panel is the outer's direct child.
    assert_eq!(root.ir_children.len(), 2);
    let inner = root.ir_children[0].as_element().unwrap();
    assert_eq!(inner.element_type, "Tabs");
    assert_eq!(
        inner.semantics.as_ref().and_then(|s| s.role),
        Some(Role::Tablist)
    );
    assert_eq!(inner.ir_children.len(), 1);
    let tab = inner.ir_children[0].as_element().unwrap();
    assert_eq!(tab.element_type, "Tab");
    let tab_sem = tab.semantics.as_ref().unwrap();
    assert_eq!(tab_sem.role, Some(Role::Tab));
    assert_eq!(tab_sem.id.as_deref(), Some("s-tab-0"));
    assert_eq!(tab_sem.controls.as_deref(), Some("s-panel-0"));

    let panel = root.ir_children[1].as_element().unwrap();
    assert_eq!(panel.element_type, "TabPanel");
    let panel_sem = panel.semantics.as_ref().unwrap();
    assert_eq!(panel_sem.role, Some(Role::Tabpanel));
    assert_eq!(panel_sem.id.as_deref(), Some("s-panel-0"));
    assert_eq!(panel_sem.labelledby.as_deref(), Some("s-tab-0"));
}

#[test]
fn tabs_restructure_without_an_id_fixes_the_shape_but_mints_nothing() {
    // No author id → no deterministic namespace → no minted references, but
    // the ARIA ownership rule (tablist owns only tabs) must still hold.
    use hypen_engine::ir::Role;

    let root = expand_root(r#"Tabs { Tab("A") TabPanel { Text("a") } }"#);
    assert!(
        root.semantics.is_none(),
        "role cleared, nothing else derived"
    );
    let inner = root.ir_children[0].as_element().unwrap();
    assert_eq!(
        inner.semantics.as_ref().and_then(|s| s.role),
        Some(Role::Tablist)
    );
    let tab = inner.ir_children[0].as_element().unwrap();
    assert_eq!(tab.semantics.as_ref().unwrap().id, None);
    assert_eq!(tab.semantics.as_ref().unwrap().controls, None);
    assert_eq!(
        root.ir_children[1].as_element().unwrap().element_type,
        "TabPanel"
    );
}

#[test]
fn tabs_restructure_keeps_non_tab_children_in_relative_order() {
    // A leading non-tab child (e.g. a heading) stays before the synthetic
    // tablist, which lands where the FIRST tab was.
    let root = expand_root(
        r#"Tabs {
            Text("Settings")
            Tab("A")
            TabPanel { Text("a") }
            Tab("B")
            TabPanel { Text("b") }
        }.id("s")"#,
    );
    let types: Vec<_> = root
        .ir_children
        .iter()
        .map(|c| c.as_element().unwrap().element_type.as_str())
        .collect();
    assert_eq!(types, ["Text", "Tabs", "TabPanel", "TabPanel"]);
    let inner = root.ir_children[1].as_element().unwrap();
    assert_eq!(inner.ir_children.len(), 2);
}

#[test]
fn all_tabs_shape_keeps_the_container_as_the_tablist() {
    // Panels portaled elsewhere: no restructuring — the container IS the
    // tablist, exactly today's shape.
    use hypen_engine::ir::Role;

    let root = expand_root(r#"Tabs { Tab("A") Tab("B") }.id("s")"#);
    assert_eq!(
        root.semantics.as_ref().and_then(|s| s.role),
        Some(Role::Tablist)
    );
    let types: Vec<_> = root
        .ir_children
        .iter()
        .map(|c| c.as_element().unwrap().element_type.as_str())
        .collect();
    assert_eq!(types, ["Tab", "Tab"]);
}

/// Read a prop's static value off an expanded element.
fn static_prop<'a>(el: &'a hypen_engine::Element, key: &str) -> Option<&'a serde_json::Value> {
    match el.props.get(key) {
        Some(hypen_engine::Value::Static(v)) => Some(v),
        _ => None,
    }
}

#[test]
fn tabs_restructure_defaults_the_outer_to_column_and_mirrors_gap_onto_the_strip() {
    // Both DOM hosts are flex-row divs, so the restructured outer must
    // default to column (strip above panels) and the author's gap — which
    // spaced tab from tab pre-restructure — must be COPIED onto the strip:
    // present on both, so tabs stay spaced and the outer gap separates
    // strip from panels.
    let root = expand_root(r#"Tabs { Tab("A") TabPanel { Text("a") } }.gap(8).id("s")"#);
    assert_eq!(
        static_prop(&root, "flexDirection.0"),
        Some(&serde_json::json!("column"))
    );
    assert_eq!(
        static_prop(&root, "gap.0").and_then(|v| v.as_f64()),
        Some(8.0)
    );
    let inner = root.ir_children[0].as_element().unwrap();
    assert_eq!(
        static_prop(inner, "gap.0").and_then(|v| v.as_f64()),
        Some(8.0)
    );
}

#[test]
fn tabs_restructure_respects_an_author_flex_direction() {
    // Author overrides always win — both the applicator form
    // ("flexDirection.0") and a named-arg form ("flexDirection") suppress
    // the column default.
    let root =
        expand_root(r#"Tabs { Tab("A") TabPanel { Text("a") } }.flexDirection("row").id("s")"#);
    assert_eq!(
        static_prop(&root, "flexDirection.0"),
        Some(&serde_json::json!("row"))
    );

    let named = expand_root(
        r#"Tabs(flexDirection: "row-reverse") { Tab("A") TabPanel { Text("a") } }.id("s")"#,
    );
    assert_eq!(
        static_prop(&named, "flexDirection"),
        Some(&serde_json::json!("row-reverse"))
    );
    assert_eq!(static_prop(&named, "flexDirection.0"), None);
}

#[test]
fn tabs_restructure_mints_no_gap_when_the_author_set_none() {
    // No author gap → nothing to mirror; the strip carries no synthetic
    // spacing of its own.
    let root = expand_root(r#"Tabs { Tab("A") TabPanel { Text("a") } }.id("s")"#);
    assert_eq!(static_prop(&root, "gap.0"), None);
    let inner = root.ir_children[0].as_element().unwrap();
    assert_eq!(static_prop(inner, "gap.0"), None);
}

#[test]
fn all_tabs_shape_gets_no_layout_defaults() {
    // Layout intervention is restructuring-only: the all-tabs (portaled
    // panels) shape keeps the container as the tablist and its props
    // exactly as the author wrote them.
    let root = expand_root(r#"Tabs { Tab("A") Tab("B") }.gap(8).id("s")"#);
    assert_eq!(static_prop(&root, "flexDirection.0"), None);
    assert_eq!(
        static_prop(&root, "gap.0").and_then(|v| v.as_f64()),
        Some(8.0)
    );
}

#[test]
fn tabs_wiring_respects_author_supplied_ids() {
    let src = r#"Tabs {
        Tab("Overview").id("my-tab")
        TabPanel { Text("c") }
    }.id("settings")"#;

    let all = wired_semantics(src);
    let tab = all.iter().find(|(t, _)| t == "Tab").unwrap();
    let panel = all.iter().find(|(t, _)| t == "TabPanel").unwrap();
    // The author id wins; the minted controls reference still points at the
    // positionally-paired panel.
    assert_eq!(tab.1.id.as_deref(), Some("my-tab"));
    assert_eq!(tab.1.controls.as_deref(), Some("settings-panel-0"));
    assert_eq!(panel.1.id.as_deref(), Some("settings-panel-0"));
    assert_eq!(panel.1.labelledby.as_deref(), Some("settings-tab-0"));
}

#[test]
fn tabs_wiring_requires_an_id_and_matching_pair_counts() {
    // No .id() on the tablist → no deterministic namespace → no minted ids
    // (the shape still restructures; see
    // tabs_restructure_without_an_id_fixes_the_shape_but_mints_nothing).
    let unnamed = r#"Tabs { Tab("A") TabPanel { Text("a") } }"#;
    let all = wired_semantics(unnamed);
    let tab = all.iter().find(|(t, _)| t == "Tab").unwrap();
    assert_eq!(tab.1.id, None);
    assert_eq!(tab.1.controls, None);

    // Count mismatch (panels portaled elsewhere) → no minted references,
    // so no manufactured dangling findings.
    let mismatched = r#"Tabs { Tab("A") Tab("B") TabPanel { Text("a") } }.id("s")"#;
    let all = wired_semantics(mismatched);
    let tab = all.iter().find(|(t, _)| t == "Tab").unwrap();
    assert_eq!(tab.1.controls, None);
    assert!(!has(mismatched, A11yRule::DanglingReference));
}

#[test]
fn role_opt_in_participates_in_tabs_wiring() {
    // `.role("tab")` on a Button counts as a tab for wiring — the wiring is
    // role-driven, not element-name-driven.
    let src = r#"Tabs {
        Button("Overview").role("tab")
        Column { Text("c") }.role("tabpanel")
    }.id("s")"#;
    let all = wired_semantics(src);
    let tab = all.iter().find(|(t, _)| t == "Button").unwrap();
    let panel = all.iter().find(|(t, _)| t == "Column").unwrap();
    assert_eq!(tab.1.controls.as_deref(), Some("s-panel-0"));
    assert_eq!(panel.1.labelledby.as_deref(), Some("s-tab-0"));
}

// ── Conformance ↔ relationship composition (DX review §4.4, §5, finding H) ──

#[test]
fn labelledby_resolving_to_a_declared_id_satisfies_form_control_label() {
    // Labelling *by reference* is labelling: the relationship vocabulary and
    // the form-control rule must compose (DX review §4.4).
    let src = r#"Column {
        Text("Search settings").id("search-label")
        Input(placeholder: "Search").labelledby("search-label")
    }"#;
    assert!(!has(src, A11yRule::FormControlMissingLabel));
    assert!(!has(src, A11yRule::DanglingReference));
}

#[test]
fn dangling_labelledby_reports_the_dangle_not_the_missing_label() {
    // One finding per root cause: the unresolved reference is the defect —
    // nagging "add .label(...)" on top would tell the author to label twice.
    let src = r#"Column {
        Text("Search settings").id("search-label")
        Input(placeholder: "Search").labelledby("search-labe")
    }"#;
    let diags = diagnose(src);
    assert!(
        diags.iter().any(|d| d.rule == A11yRule::DanglingReference),
        "got: {diags:?}"
    );
    assert!(
        !diags
            .iter()
            .any(|d| d.rule == A11yRule::FormControlMissingLabel),
        "got: {diags:?}"
    );
}

#[test]
fn labelledby_with_no_ids_in_scope_gets_benefit_of_the_doubt() {
    // Same guard philosophy as DanglingReference: a scope declaring zero ids
    // is assumed to reference ids minted outside Hypen.
    let src = r#"Input(placeholder: "Search").labelledby("external-label")"#;
    assert!(!has(src, A11yRule::FormControlMissingLabel));
    assert!(!has(src, A11yRule::DanglingReference));
}

#[test]
fn bound_labelledby_counts_as_labelling_intent() {
    // A bound `.labelledby(...)` is None in static semantics but resolves at
    // reconcile — author intent, not a gap.
    let src = r#"Input(placeholder: "Search").labelledby(@state.labelId)"#;
    assert!(!has(src, A11yRule::FormControlMissingLabel));
}

#[test]
fn unlabeled_form_control_without_labelledby_still_fires() {
    // The carve-out must not swallow the base rule: an Input with neither a
    // label nor a labelledby stays flagged even with ids in scope.
    let src = r#"Column {
        Column { Text("x") }.id("some-anchor")
        Input(placeholder: "Search")
    }"#;
    assert!(has(src, A11yRule::FormControlMissingLabel));
}

#[test]
fn dynamic_ids_suppress_dangling_reference_for_the_scope() {
    // `.id("opt-@{item.id}")` mints its ids at reconcile, so the static id
    // universe is incomplete — a static reference into the ForEach-minted
    // graph must not false-positive as dangling (DX review §5).
    let src = r#"Column {
        Column { Text("x") }.id("static-anchor")
        Column {
            ForEach(items: @state.options) {
                Text("@{item.label}").role("option").id("opt-@{item.id}")
            }
        }.role("listbox").activedescendant("opt-1")
    }"#;
    assert!(!has(src, A11yRule::DanglingReference));
}

#[test]
fn without_dynamic_ids_the_same_dangling_reference_still_fires() {
    // The suppression is scoped to unverifiable graphs only — an all-static
    // scope keeps full validation.
    let src = r#"Column {
        Column { Text("x") }.id("static-anchor")
        Column { Text("A") }.role("listbox").label("Options").activedescendant("opt-1")
    }"#;
    assert!(has(src, A11yRule::DanglingReference));
}

#[test]
fn duplicate_static_ids_fire_on_the_second_declaration() {
    let src = r#"Column {
        Column { Text("a") }.id("panel")
        Row { Text("b") }.id("panel")
    }"#;
    let diags = diagnose(src);
    let dupes: Vec<_> = diags
        .iter()
        .filter(|d| d.rule == A11yRule::DuplicateId)
        .collect();
    assert_eq!(dupes.len(), 1, "got: {diags:?}");
    // The finding lands on the SECOND declaration.
    assert_eq!(dupes[0].element_type, "Row");
    let span = dupes[0].span.expect("finding carries a span");
    assert_eq!(&src[span.start..span.end], "Row");
    assert!(
        dupes[0].message.contains("panel"),
        "got: {}",
        dupes[0].message
    );
}

#[test]
fn distinct_and_templated_ids_are_not_duplicates() {
    let distinct = r#"Column {
        Column { Text("a") }.id("one")
        Row { Text("b") }.id("two")
    }"#;
    assert!(!has(distinct, A11yRule::DuplicateId));

    // Templated ids resolve at reconcile — never statically comparable.
    let templated = r#"Column {
        ForEach(items: @state.xs) { Text("@{item.label}").id("opt-@{item.id}") }
        ForEach(items: @state.ys) { Text("@{item.label}").id("opt-@{item.id}") }
    }"#;
    assert!(!has(templated, A11yRule::DuplicateId));
}

#[test]
fn same_id_in_sibling_conditional_branches_is_not_a_duplicate() {
    // Only one branch renders at a time, so the ids never coexist — and the
    // branch-declared id must still resolve references from outside.
    let src = r#"Column {
        When(value: @state.mode) {
            Case(match: "a") { Column { Text("A") }.id("panel") }
            Case(match: "b") { Column { Text("B") }.id("panel") }
        }
        Button("Show").controls("panel")
    }"#;
    assert!(!has(src, A11yRule::DuplicateId));
    assert!(!has(src, A11yRule::DanglingReference));
}

#[test]
fn duplicate_between_branch_and_enclosing_scope_still_fires() {
    // An id outside the conditional coexists with every branch at runtime.
    let src = r#"Column {
        Column { Text("outer") }.id("panel")
        When(value: @state.mode) {
            Case(match: "a") { Column { Text("A") }.id("panel") }
        }
    }"#;
    assert!(has(src, A11yRule::DuplicateId));
}

#[test]
fn tablist_wiring_skipped_fires_on_nonzero_pair_mismatch() {
    // wire_tablist bails silently on a count mismatch — the author who opted
    // in with .id() gets told why the graph is missing (DX review §5).
    let src = r#"Tabs {
        Tab("A")
        Tab("B")
        TabPanel { Text("a") }
    }.id("s")"#;
    let diags = diagnose(src);
    let finding = diags
        .iter()
        .find(|d| d.rule == A11yRule::TablistWiringSkipped)
        .expect("mismatched tablist should be flagged");
    assert_eq!(finding.element_type, "Tabs");
    assert!(
        finding.message.contains("2 tab"),
        "got: {}",
        finding.message
    );
    assert!(
        finding.message.contains("1 panel"),
        "got: {}",
        finding.message
    );
}

#[test]
fn tablist_wiring_skipped_stays_silent_on_legit_shapes() {
    // Zero panels inside = the documented fully-portaled shape.
    assert!(!has(
        r#"Tabs { Tab("A") Tab("B") }.id("s")"#,
        A11yRule::TablistWiringSkipped
    ));
    // Matched pairs wire successfully — nothing was skipped.
    assert!(!has(
        r#"Tabs { Tab("A") TabPanel { Text("a") } }.id("s")"#,
        A11yRule::TablistWiringSkipped
    ));
    // No .id() → the author never opted into auto-wiring.
    assert!(!has(
        r#"Tabs { Tab("A") Tab("B") TabPanel { Text("a") } }"#,
        A11yRule::TablistWiringSkipped
    ));
}

// ── Inline suppression: // hypen-a11y-ignore (DX review §4.6) ─────────────

/// Run the located pass — the boundary where directives are resolved.
fn locate(src: &str) -> Vec<hypen_engine::LocatedDiagnostic> {
    hypen_engine::check_accessibility_source_located(src).unwrap()
}

#[test]
fn same_line_trailing_directive_marks_the_finding_suppressed() {
    let src = "Column {\n    Image(src: \"/a.png\") // hypen-a11y-ignore\n}";
    let located = locate(src);
    // The finding is kept — counted, never silently dropped.
    assert_eq!(located.len(), 1);
    assert_eq!(located[0].diagnostic.rule, A11yRule::ImageMissingAlt);
    assert!(located[0].suppressed);
}

#[test]
fn previous_line_directive_suppresses_the_next_line() {
    let src = "Column {\n    // hypen-a11y-ignore\n    Image(src: \"/a.png\")\n}";
    let located = locate(src);
    assert_eq!(located.len(), 1);
    assert!(located[0].suppressed);
}

#[test]
fn rule_scoped_directive_suppresses_only_matching_rules() {
    // One line, two findings: the scoped directive must hit exactly one.
    let src =
        "Column {\n    Image(src: \"/a.png\").role(\"imgg\") // hypen-a11y-ignore image-missing-alt\n}";
    let located = locate(src);
    assert_eq!(located.len(), 2, "got: {located:?}");
    let by_rule = |rule: A11yRule| {
        located
            .iter()
            .find(|d| d.diagnostic.rule == rule)
            .unwrap_or_else(|| panic!("missing {rule:?} in {located:?}"))
    };
    assert!(by_rule(A11yRule::ImageMissingAlt).suppressed);
    assert!(
        !by_rule(A11yRule::UnknownRoleToken).suppressed,
        "a non-matching rule must NOT be suppressed"
    );
}

#[test]
fn bare_directive_suppresses_every_rule_on_the_line() {
    let src = "Column {\n    Image(src: \"/a.png\").role(\"imgg\") // hypen-a11y-ignore\n}";
    let located = locate(src);
    assert_eq!(located.len(), 2);
    assert!(located.iter().all(|d| d.suppressed), "got: {located:?}");
}

#[test]
fn scoped_directive_accepts_a_comma_separated_rule_list() {
    let src = "Column {\n    // hypen-a11y-ignore image-missing-alt, unknown-role-token\n    Image(src: \"/a.png\").role(\"imgg\")\n}";
    let located = locate(src);
    assert_eq!(located.len(), 2);
    assert!(located.iter().all(|d| d.suppressed), "got: {located:?}");
}

#[test]
fn trailing_directive_does_not_bleed_into_the_next_line() {
    // The previous-line form requires a comment-only line: a directive
    // trailing element A must not also suppress element B below it.
    let src =
        "Column {\n    Button { Icon(\"x\") } // hypen-a11y-ignore\n    Image(src: \"/a.png\")\n}";
    let located = locate(src);
    assert_eq!(located.len(), 2, "got: {located:?}");
    let button = located
        .iter()
        .find(|d| d.diagnostic.rule == A11yRule::MissingAccessibleName)
        .unwrap();
    let image = located
        .iter()
        .find(|d| d.diagnostic.rule == A11yRule::ImageMissingAlt)
        .unwrap();
    assert!(button.suppressed);
    assert!(!image.suppressed);
}

#[test]
fn directive_token_must_stand_alone_as_a_word() {
    // `hypen-a11y-ignored` (or any suffix) is not the directive.
    let src = "Column {\n    Image(src: \"/a.png\") // hypen-a11y-ignored\n}";
    let located = locate(src);
    assert_eq!(located.len(), 1);
    assert!(!located[0].suppressed);
}

#[test]
fn unrelated_comments_never_suppress() {
    let src = "Column {\n    // TODO: swap this image\n    Image(src: \"/a.png\")\n}";
    let located = locate(src);
    assert_eq!(located.len(), 1);
    assert!(!located[0].suppressed);
}

#[test]
fn suppressed_serializes_only_when_true() {
    let src = "Image(src: \"/a.png\") // hypen-a11y-ignore";
    let located = locate(src);
    let json = serde_json::to_string(&located[0]).unwrap();
    assert!(json.contains(r#""suppressed":true"#), "got: {json}");

    // Unsuppressed findings keep the pre-suppression JSON shape.
    let clean = locate(r#"Image(src: "/a.png")"#);
    let json = serde_json::to_string(&clean[0]).unwrap();
    assert!(!json.contains("suppressed"), "got: {json}");
}

#[test]
fn non_portable_aria_flags_the_escape_hatch() {
    let src = r#"Column { Text("Saving") }.aria("live", "polite")"#;
    let diags = diagnose(src);
    let finding = diags
        .iter()
        .find(|d| d.rule == A11yRule::NonPortableAria)
        .expect(".aria() should be flagged as web-only");
    assert!(
        finding.message.contains("web-only"),
        "got: {}",
        finding.message
    );
    // The single-argument form survives as the same aria.0 prop.
    assert!(has(
        r#"Column { Text("x") }.aria("busy")"#,
        A11yRule::NonPortableAria
    ));
    // No .aria() → silent.
    assert!(!has(
        r#"Column { Text("Saving") }"#,
        A11yRule::NonPortableAria
    ));
}

#[test]
fn unknown_live_region_token_is_flagged() {
    // The same silent-typo class as .role/.dir: a typo'd politeness token
    // derives nothing, so the checker must say so.
    assert!(has(
        r#"Column { Text("saving…") }.liveRegion("polte")"#,
        A11yRule::UnknownLiveToken
    ));
    // Recognised tokens are silent, in either case.
    assert!(!has(
        r#"Column { Text("saving…") }.liveRegion("polite")"#,
        A11yRule::UnknownLiveToken
    ));
    assert!(!has(
        r#"Column { Text("error") }.liveRegion("ASSERTIVE")"#,
        A11yRule::UnknownLiveToken
    ));
    // No .liveRegion at all → silent.
    assert!(!has(r#"Column { Text("x") }"#, A11yRule::UnknownLiveToken));
}

// ── Suppression hardening: full-expression trailing directives + unknown
//    rule ids in directives (third-pass review §2.2) ────────────────────────

#[test]
fn trailing_directive_on_the_last_line_of_an_applicator_chain_suppresses() {
    // The finding sits on the element-name line; the directive trails the
    // 4th line of the expression. The window runs to the chain's end.
    let src = "Button {\n    Icon(\"trash\")\n}\n    .padding(16) // hypen-a11y-ignore missing-accessible-name";
    let located = locate(src);
    assert_eq!(located.len(), 1, "got: {located:?}");
    assert_eq!(located[0].diagnostic.rule, A11yRule::MissingAccessibleName);
    assert!(located[0].suppressed);
}

#[test]
fn directive_on_a_mid_expression_line_suppresses() {
    let src = "Button {\n    Icon(\"trash\") // hypen-a11y-ignore missing-accessible-name\n}\n    .padding(16)";
    let located = locate(src);
    assert_eq!(located.len(), 1, "got: {located:?}");
    assert!(located[0].suppressed);
}

#[test]
fn directive_after_a_blank_line_does_not_suppress() {
    // The comment-only previous-line form requires the directive directly
    // above the element — a blank line breaks the association, so a
    // directive orphaned by edits can't latch onto a drifting element.
    let src =
        "Column {\n    // hypen-a11y-ignore image-missing-alt\n\n    Image(src: \"/a.png\")\n}";
    let located = locate(src);
    assert_eq!(located.len(), 1, "got: {located:?}");
    assert_eq!(located[0].diagnostic.rule, A11yRule::ImageMissingAlt);
    assert!(!located[0].suppressed);
}

#[test]
fn directive_below_the_expression_end_does_not_suppress() {
    // One line past the last applicator is outside the window: a directive
    // meant for the next sibling must not leak onto the element above it.
    let src = "Column {\n    Button {\n        Icon(\"trash\")\n    }\n        .padding(16)\n    // hypen-a11y-ignore missing-accessible-name\n    Text(\"next\")\n}";
    let located = locate(src);
    assert_eq!(located.len(), 1, "got: {located:?}");
    assert_eq!(located[0].diagnostic.rule, A11yRule::MissingAccessibleName);
    assert!(!located[0].suppressed);
}

#[test]
fn typoed_rule_id_in_a_directive_fires_unknown_ignore_rule_at_the_directive() {
    let src = "Column {\n    Image(src: \"/a.png\") // hypen-a11y-ignore image-missing-altt\n}";
    let located = locate(src);
    let unknown = located
        .iter()
        .find(|d| d.diagnostic.rule == A11yRule::UnknownIgnoreRule)
        .unwrap_or_else(|| panic!("expected unknown-ignore-rule in {located:?}"));
    assert!(!unknown.suppressed);
    assert_eq!(unknown.line, Some(2), "fires at the directive's line");
    assert!(
        unknown.diagnostic.message.contains("image-missing-altt"),
        "got: {}",
        unknown.diagnostic.message
    );
    // The span covers exactly the offending id.
    let span = unknown
        .diagnostic
        .span
        .expect("directive finding has a span");
    assert_eq!(&src[span.start..span.end], "image-missing-altt");
    // The typo'd directive suppressed nothing: the element finding still fires.
    let image = located
        .iter()
        .find(|d| d.diagnostic.rule == A11yRule::ImageMissingAlt)
        .unwrap();
    assert!(!image.suppressed);
}

#[test]
fn bare_directive_stays_silent_and_suppressing() {
    let src = "Column {\n    Image(src: \"/a.png\") // hypen-a11y-ignore\n}";
    let located = locate(src);
    assert_eq!(located.len(), 1, "no unknown-ignore-rule: {located:?}");
    assert!(located[0].suppressed);
}

#[test]
fn known_rule_ids_in_a_directive_never_fire_unknown_ignore_rule() {
    // Every published id, in one directive — the check must not false-positive
    // on correct directives.
    let ids = hypen_engine::ir::conformance::all_rule_ids().join(", ");
    let src = format!("Column {{\n    Text(\"x\") // hypen-a11y-ignore {ids}\n}}");
    let located = locate(&src);
    assert!(
        located
            .iter()
            .all(|d| d.diagnostic.rule != A11yRule::UnknownIgnoreRule),
        "got: {located:?}"
    );
}

#[test]
fn unknown_ignore_rule_findings_are_themselves_suppressible_by_listing_the_rule() {
    // Escape hatch: an id from a newer engine can be kept by explicitly
    // acknowledging it with `unknown-ignore-rule` in the same directive.
    let src =
        "Column {\n    Text(\"x\") // hypen-a11y-ignore some-future-rule, unknown-ignore-rule\n}";
    let located = locate(src);
    let unknown = located
        .iter()
        .find(|d| d.diagnostic.rule == A11yRule::UnknownIgnoreRule)
        .expect("the finding is kept, only marked suppressed");
    assert!(unknown.suppressed);
}
