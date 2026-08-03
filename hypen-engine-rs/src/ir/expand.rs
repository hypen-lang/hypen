// AST → IR lowering - converts parser output to engine IR

use super::{ConditionalBranch, Element, IRNode, Props, RouterRoute, Value};
use crate::reactive::{extract_bindings_from_expression, parse_binding, Binding};
use hypen_parser::{ComponentSpecification, Value as ParserValue};
use std::collections::HashSet;

// Event handling is now done at the renderer level, not in the engine

/// Convert a CSS hyphenated property name to camelCase.
/// e.g., "background-color" → "backgroundColor", "align-items" → "alignItems"
/// Names without hyphens are returned unchanged.
fn css_to_camel_case(name: &str) -> String {
    if !name.contains('-') {
        return name.to_string();
    }
    let mut result = String::with_capacity(name.len());
    let mut capitalize_next = false;
    for ch in name.chars() {
        if ch == '-' {
            capitalize_next = true;
        } else if capitalize_next {
            result.extend(ch.to_uppercase());
            capitalize_next = false;
        } else {
            result.push(ch);
        }
    }
    result
}

/// Expand Tailwind classes into CSS properties
/// Returns a Vec of (prop_name, value) pairs with `.0` suffix,
/// consistent with regular applicator props.
/// CSS hyphenated names are converted to camelCase.
fn expand_tailwind_classes(classes: &str) -> Vec<(String, Value)> {
    let output = hypen_tailwind_parse::parse_classes(classes);
    let mut props = Vec::new();

    // Add base properties (no variant)
    for css_prop in &output.base {
        let camel = css_to_camel_case(&css_prop.property);
        props.push((
            format!("{}.0", camel),
            Value::Static(serde_json::Value::String(css_prop.value.clone())),
        ));
    }

    // Add variant properties with suffix notation
    // e.g., "padding@md.0" for responsive, "backgroundColor:hover.0" for state
    for (variant_key, css_props) in &output.variants {
        for css_prop in css_props {
            let camel = css_to_camel_case(&css_prop.property);
            let prop_key = format!("{}{}.0", camel, variant_key);
            props.push((
                prop_key,
                Value::Static(serde_json::Value::String(css_prop.value.clone())),
            ));
        }
    }

    props
}

/// Extract all @{state.xxx} and @{item.xxx} bindings from a template string
/// This handles both simple bindings like @{state.x} and expressions like @{state.x ? 'a' : 'b'}
/// Returns None if no bindings found, Some(bindings) if bindings exist
fn extract_bindings_from_template(s: &str) -> Option<Vec<Binding>> {
    let mut bindings = Vec::new();
    let mut seen_paths: HashSet<String> = HashSet::new();
    let mut pos = 0;

    // Look for @{ patterns and try to parse them
    while let Some(start) = s[pos..].find("@{") {
        let abs_start = pos + start;
        if let Some(end) = s[abs_start..].find('}') {
            let abs_end = abs_start + end;
            // Extract the full binding string including @{...}
            let binding_str = &s[abs_start..=abs_end];

            // Try to parse as a simple binding first
            if let Some(binding) = parse_binding(binding_str) {
                let path = binding.full_path_with_source();
                if !seen_paths.contains(&path) {
                    seen_paths.insert(path);
                    bindings.push(binding);
                }
            } else {
                // Not a simple binding - extract bindings from the expression
                let expr_content = &s[abs_start + 2..abs_end];
                for binding in extract_bindings_from_expression(expr_content) {
                    let path = binding.full_path_with_source();
                    if !seen_paths.contains(&path) {
                        seen_paths.insert(path);
                        bindings.push(binding);
                    }
                }
            }
            pos = abs_end + 1;
        } else {
            break;
        }
    }

    if bindings.is_empty() {
        None
    } else {
        Some(bindings)
    }
}

/// Process applicators from a parsed component and insert them as props.
///
/// Handles:
/// - `.tw(classes)` - expands Tailwind classes to CSS properties
/// - `.bind(path)` - two-way binding for form elements (state only)
/// - All other applicators - converted to namespaced props
///
/// `element_type` is used by `.bind()` to pick the correct bound property
/// (`checked` for Checkbox, `on` for Switch, `value` otherwise).
/// Breakpoint names recognised in a *responsive-object* applicator value
/// like `.gridColumns({default: 2, md: 3, lg: 4})`. Mirrors the tailwind
/// breakpoints every renderer already resolves via `name@bp` keys.
const RESPONSIVE_KEYS: &[&str] = &["default", "base", "sm", "md", "lg", "xl", "2xl"];

/// Insert an applicator prop, expanding a responsive-object value into
/// the same `name@bp.idx` suffix keys that tailwind `md:` classes
/// produce — the format every renderer (DOM media-query classes,
/// desktop `lookup_breakpoint`, Swift/Android variant resolution) already
/// understands. Without this, `.gridColumns({default: 2, md: 3})` reaches
/// renderers as one opaque object prop that each must special-case (most
/// don't — the DOM stringifies it to `"[object Object]"`).
///
/// Only objects whose keys are *all* breakpoint names are expanded;
/// composite-value objects such as `.size({width, height})` pass through
/// untouched as a single `name.idx` prop.
fn insert_applicator_prop(props: &mut Props, name: &str, idx_key: &str, value: Value) {
    if let Value::Static(serde_json::Value::Object(map)) = &value {
        let all_breakpoints =
            !map.is_empty() && map.keys().all(|k| RESPONSIVE_KEYS.contains(&k.as_str()));
        if all_breakpoints {
            for (bp, v) in map {
                let key = if bp == "default" || bp == "base" {
                    format!("{name}.{idx_key}")
                } else {
                    format!("{name}@{bp}.{idx_key}")
                };
                props.insert(key, Value::Static(v.clone()));
            }
            return;
        }
    }
    props.insert(format!("{name}.{idx_key}"), value);
}

fn process_applicators(
    applicators: &[hypen_parser::ApplicatorSpecification],
    props: &mut Props,
    element_type: &str,
) {
    for applicator in applicators {
        // .tw(classes) → expand Tailwind to individual CSS props
        if applicator.name == "tw" {
            if let Some(arg) = applicator.arguments.arguments.first() {
                let class_string = match arg {
                    hypen_parser::Argument::Named { value, .. }
                    | hypen_parser::Argument::Positioned { value, .. } => {
                        if let ParserValue::String(s) = value {
                            s.trim_matches(|c: char| c == '"' || c == '\'').to_string()
                        } else {
                            continue;
                        }
                    }
                };
                for (prop_key, prop_value) in expand_tailwind_classes(&class_string) {
                    props.insert(prop_key, prop_value);
                }
            }
            continue;
        }

        // .bind(@state.path) or .bind(@datasource.path) → two-way binding
        if applicator.name == "bind" {
            if let Some(arg) = applicator.arguments.arguments.first() {
                let value = match arg {
                    hypen_parser::Argument::Named { value, .. }
                    | hypen_parser::Argument::Positioned { value, .. } => value,
                };
                let ir_value = parser_value_to_ir(value);
                if let Value::Binding(binding) = ir_value {
                    if binding.is_state() || binding.is_data_source() {
                        let path = if binding.is_data_source() {
                            // For data sources, include provider: "spacetime.selectedId"
                            binding.full_path_with_source()
                        } else {
                            binding.full_path()
                        };
                        let prop_name = match element_type {
                            "Checkbox" | "checkbox" => "checked",
                            "Switch" | "switch" => "on",
                            _ => "value",
                        };
                        props.insert(prop_name.to_string(), Value::Binding(binding));
                        props.insert(
                            "bind".to_string(),
                            Value::Static(serde_json::Value::String(path)),
                        );
                    }
                }
            }
            continue;
        }

        // Value-map variant form: .padding({ default: 8, md: 16, hover: "x" })
        // When the applicator has a SINGLE positional Map argument whose keys
        // are ALL variant tokens, lower it into suffixed variant props exactly
        // like the tailwind path:
        //   "default" -> "<name>.0"
        //   "md"      -> "<name>@md.0"
        //   "hover"   -> "<name>:hover.0"
        // Map values still flow through parser_value_to_ir so @{state.x}
        // bindings inside continue to work. If not all keys are variant tokens,
        // fall through to the default applicator handling unchanged.
        if applicator.arguments.arguments.len() == 1 {
            if let hypen_parser::Argument::Positioned {
                value: ParserValue::Map(map),
                ..
            } = &applicator.arguments.arguments[0]
            {
                if !map.is_empty()
                    && map
                        .keys()
                        .all(|k| crate::portable::variant::is_variant_token(k))
                {
                    for (variant, value) in map {
                        let prop_key = if variant == crate::portable::variant::DEFAULT_KEY {
                            format!("{}.0", applicator.name)
                        } else if crate::portable::variant::is_breakpoint(variant) {
                            format!("{}@{}.0", applicator.name, variant)
                        } else {
                            // state token
                            format!("{}:{}.0", applicator.name, variant)
                        };
                        props.insert(prop_key, parser_value_to_ir(value));
                    }
                    continue;
                }
            }
        }

        // All other applicators become namespaced props
        if applicator.arguments.arguments.is_empty() {
            // Zero-argument applicators default to boolean true
            // e.g. .fillMaxWidth() → fillMaxWidth = true
            props.insert(
                format!("{}.0", applicator.name),
                Value::Static(serde_json::json!(true)),
            );
        } else {
            for (i, arg) in applicator.arguments.arguments.iter().enumerate() {
                let (idx_key, value) = match arg {
                    hypen_parser::Argument::Named { key, value } => {
                        (key.clone(), parser_value_to_ir(value))
                    }
                    hypen_parser::Argument::Positioned { value, .. } => {
                        (i.to_string(), parser_value_to_ir(value))
                    }
                };
                insert_applicator_prop(props, &applicator.name, &idx_key, value);
            }
        }
    }
}

/// Convert parser AST to engine IRNode (first-class control flow constructs)
/// This detects ForEach, When, If, and List components and converts them to the appropriate IRNode variants
pub fn ast_to_ir_node(component: &ComponentSpecification) -> IRNode {
    // Module declarations (`module Search { Column { ... } }`) are semantic
    // wrappers for state scoping — they should NOT create a "Search" element
    // in the render tree. Unwrap to the first child so the output is just
    // the content (e.g., Column). The module name is captured by the component
    // system (is_module / module_name) for state scoping during reconciliation.
    if component.declaration_type == hypen_parser::DeclarationType::Module {
        if let Some(first_child) = component.children.first() {
            let mut ir = ast_to_ir_node(first_child);
            let scope = component.name.to_lowercase();
            // `propagate_module_scope_ir_node` handles every IRNode variant —
            // plain Element but also Router / ForEach / Conditional. The
            // Router case matters for `module App { Router { ... } }`
            // templates where the top-level child is a Router (not an
            // Element): discovery + dependency registration both need the
            // enclosing scope set.
            propagate_module_scope_ir_node(&mut ir, &scope);
            return ir;
        }
    }

    match component.name.as_str() {
        "ForEach" => convert_foreach(component),
        "When" => convert_when(component),
        "If" => convert_if(component),
        "Router" => convert_router(component),
        "List" | "Grid" => convert_list(component),
        _ => {
            // Regular element - convert children to IRNodes recursively
            let mut element = Element::new(&component.name);

            // Convert arguments to props
            for (i, arg) in component.arguments.arguments.iter().enumerate() {
                let (key, value) = match arg {
                    hypen_parser::Argument::Named { key, value } => {
                        (key.clone(), parser_value_to_ir(value))
                    }
                    hypen_parser::Argument::Positioned { value, .. } => {
                        let ir_value = parser_value_to_ir(value);
                        let key = if matches!(ir_value, Value::Action(_)) {
                            "action".to_string()
                        } else {
                            i.to_string()
                        };
                        (key, ir_value)
                    }
                };
                element.props.insert(key, value);
            }

            // Convert applicators to props
            process_applicators(
                &component.applicators,
                &mut element.props,
                &element.element_type,
            );

            // Optional key from first positional string argument
            if let Some(hypen_parser::Argument::Positioned {
                value: ParserValue::String(s),
                ..
            }) = component.arguments.arguments.first()
            {
                element.key = Some(s.clone());
            }

            // Convert children recursively as IRNodes
            // Check if this element should be treated as a list (has binding prop "0" and children)
            let has_binding_prop = element
                .props
                .get("0")
                .is_some_and(|v| matches!(v, Value::Binding(_)));
            if has_binding_prop && !component.children.is_empty() {
                // This is the legacy List pattern - convert to ForEach
                if let Some(Value::Binding(binding)) = element.props.get("0").cloned() {
                    let mut props = element.props.clone();
                    props.remove("0"); // Remove the array binding prop (uses COW)

                    let template: Vec<IRNode> =
                        component.children.iter().map(ast_to_ir_node).collect();

                    return IRNode::ForEach {
                        source: binding,
                        item_name: "item".to_string(),
                        key_path: None,
                        template,
                        props,
                        module_scope: None,
                    };
                }
            }

            // Convert children recursively as IRNodes to preserve ForEach/When/If
            element.ir_children = component.children.iter().map(ast_to_ir_node).collect();

            IRNode::Element(element)
        }
    }
}

// ---------------------------------------------------------------------------
// Argument-extraction helpers shared by control-flow converters.
// ---------------------------------------------------------------------------

/// Find the first named argument whose key matches any of `keys`.
fn find_named_arg<'a>(
    args: &'a [hypen_parser::Argument],
    keys: &[&str],
) -> Option<&'a ParserValue> {
    args.iter().find_map(|arg| match arg {
        hypen_parser::Argument::Named { key, value } if keys.contains(&key.as_str()) => Some(value),
        _ => None,
    })
}

/// Return the first positional argument value, if any.
fn first_positional_arg(args: &[hypen_parser::Argument]) -> Option<&ParserValue> {
    args.iter().find_map(|arg| match arg {
        hypen_parser::Argument::Positioned { value, .. } => Some(value),
        _ => None,
    })
}

/// Trim surrounding `"` or `'` from a parser String value.
fn parser_string_unquoted(value: &ParserValue) -> Option<String> {
    if let ParserValue::String(s) = value {
        Some(s.trim_matches(|c: char| c == '"' || c == '\'').to_string())
    } else {
        None
    }
}

/// Convert a parser value into an IR `Binding` if it resolves to one.
fn parser_to_binding(value: &ParserValue) -> Option<Binding> {
    match parser_value_to_ir(value) {
        Value::Binding(b) => Some(b),
        _ => None,
    }
}

/// Build an `__Error` element with `message` set to `msg`.
fn error_element(msg: impl Into<String>) -> IRNode {
    let mut err = Element::new("__Error");
    err.props.insert(
        "message".to_string(),
        Value::Static(serde_json::Value::String(msg.into())),
    );
    IRNode::Element(err)
}

/// Convert ForEach component to IRNode::ForEach
/// Syntax: ForEach(items: @{state.todos}, as: "todo", key: "id") { ... }
fn convert_foreach(component: &ComponentSpecification) -> IRNode {
    let args = &component.arguments.arguments;

    let source = find_named_arg(args, &["items", "in"])
        .or_else(|| first_positional_arg(args))
        .and_then(parser_to_binding);

    let item_name = find_named_arg(args, &["as"])
        .and_then(parser_string_unquoted)
        .unwrap_or_else(|| "item".to_string());

    let key_path = find_named_arg(args, &["key"]).and_then(parser_string_unquoted);

    // Other named args become container props.
    let mut props = Props::new();
    for arg in args {
        if let hypen_parser::Argument::Named { key, value } = arg {
            if !matches!(key.as_str(), "items" | "in" | "as" | "key") {
                props.insert(key.clone(), parser_value_to_ir(value));
            }
        }
    }

    process_applicators(&component.applicators, &mut props, "ForEach");
    let template: Vec<IRNode> = component.children.iter().map(ast_to_ir_node).collect();

    let Some(source) = source else {
        return error_element(
            "ForEach requires an 'items' binding (e.g., ForEach(items: @state.list))",
        );
    };

    IRNode::ForEach {
        source,
        item_name,
        key_path,
        template,
        props,
        module_scope: None,
    }
}

/// Convert List component to a `list` wrapper element with a ForEach IR child.
///
/// This preserves the `list` element type in patches so native renderers
/// (Android LazyColumn, iOS LazyVStack) can do virtualized scrolling,
/// while the engine handles iteration via the ForEach IR semantics.
///
/// Syntax: List(@state.items, key: "id") { ItemView() }
fn convert_list(component: &ComponentSpecification) -> IRNode {
    let element_type = &component.name;
    let args = &component.arguments.arguments;

    let source = find_named_arg(args, &["items", "in"])
        .or_else(|| first_positional_arg(args))
        .and_then(parser_to_binding);

    let item_name = find_named_arg(args, &["as"])
        .and_then(parser_string_unquoted)
        .unwrap_or_else(|| "item".to_string());

    let key_path = find_named_arg(args, &["key"]).and_then(parser_string_unquoted);

    // Pass through other named args (columns, gap, etc.) as props
    // so the renderer can use them for layout configuration.
    let mut extra_props = indexmap::IndexMap::<String, Value>::new();
    for arg in args {
        if let hypen_parser::Argument::Named { key, value } = arg {
            if !matches!(key.as_str(), "items" | "in" | "as" | "key") {
                extra_props.insert(key.clone(), parser_value_to_ir(value));
            }
        }
    }

    let Some(source) = source else {
        return error_element(format!(
            "{element_type} requires an array binding (e.g., {element_type}(@state.items))"
        ));
    };

    // Build the ForEach IR node for iteration
    let template: Vec<IRNode> = component.children.iter().map(ast_to_ir_node).collect();
    let mut foreach_props = Props::new();
    process_applicators(&component.applicators, &mut foreach_props, element_type);

    let foreach_ir = IRNode::ForEach {
        source,
        item_name,
        key_path,
        template,
        props: foreach_props.clone(),
        module_scope: None,
    };

    // Create a wrapper element that contains the ForEach as an IR child.
    // Applicator props (flex, backgroundColor, etc.) go on the wrapper element
    // so the renderer can style the container.
    let mut list_element = Element::new(element_type);
    // Copy applicator props onto the wrapper (e.g. flex.0, backgroundColor.0)
    for (key, value) in &foreach_props {
        list_element.props.insert(key.clone(), value.clone());
    }
    // Copy extra named args (columns, gap, etc.) as props for the renderer.
    // Use the `.0` suffix convention that applicators use, since renderers
    // expect props like `columns.0` and `gap.0`.
    for (key, value) in &extra_props {
        list_element
            .props
            .insert(format!("{}.0", key), value.clone());
    }
    list_element.ir_children.push(foreach_ir);

    IRNode::Element(list_element)
}

/// Convert When component to IRNode::Conditional
/// Syntax: When(value: @{state.status}) { Case(match: "loading") {...} Else {...} }
fn convert_when(component: &ComponentSpecification) -> IRNode {
    let args = &component.arguments.arguments;
    let condition_value = find_named_arg(args, &["value", "condition"])
        .or_else(|| first_positional_arg(args))
        .map(parser_value_to_ir);

    let mut branches = Vec::new();
    let mut fallback: Option<Vec<IRNode>> = None;

    // Parse children: Case and Else
    for child in &component.children {
        match child.name.as_str() {
            "Case" => {
                let case_args = &child.arguments.arguments;
                let pattern = find_named_arg(case_args, &["match"])
                    .or_else(|| first_positional_arg(case_args))
                    .map(parser_value_to_ir)
                    .unwrap_or(Value::Static(serde_json::Value::Null));

                let children: Vec<IRNode> = child.children.iter().map(ast_to_ir_node).collect();
                branches.push(ConditionalBranch::new(pattern, children));
            }
            "Else" => {
                let children: Vec<IRNode> = child.children.iter().map(ast_to_ir_node).collect();
                fallback = Some(children);
            }
            _ => {
                // Non-Case/Else children become part of a default branch
                // This handles the case where When children are direct elements
            }
        }
    }

    let Some(value) = condition_value else {
        return error_element(
            "When requires a 'value' argument (e.g., When(value: @state.status))",
        );
    };

    IRNode::Conditional {
        value,
        branches,
        fallback,
        module_scope: None,
    }
}

/// Convert If component to IRNode::Conditional (syntactic sugar over When with boolean matching)
/// Syntax: If(condition: @{state.loggedIn}) { ... Else { ... } }
fn convert_if(component: &ComponentSpecification) -> IRNode {
    let args = &component.arguments.arguments;
    let condition_value = find_named_arg(args, &["condition", "when"])
        .or_else(|| first_positional_arg(args))
        .map(parser_value_to_ir);

    // Separate then-branch children from Else children
    let mut then_children: Vec<IRNode> = Vec::new();
    let mut else_children: Option<Vec<IRNode>> = None;

    for child in &component.children {
        if child.name == "Else" {
            else_children = Some(child.children.iter().map(ast_to_ir_node).collect());
        } else {
            then_children.push(ast_to_ir_node(child));
        }
    }

    // Create branches: true branch with then_children
    let branches = vec![ConditionalBranch::new(
        Value::Static(serde_json::json!(true)),
        then_children,
    )];

    let Some(value) = condition_value else {
        return error_element(
            "If requires a 'condition' argument (e.g., If(condition: @state.loggedIn))",
        );
    };

    IRNode::Conditional {
        value,
        branches,
        fallback: else_children,
        module_scope: None,
    }
}

/// Convert Router component to IRNode::Router
///
/// Syntax:
/// ```hypen
/// Router {
///     Route(path: "/") { Home() }
///     Route(path: "/users") { Users() }
///     Route.fallback { NotFound() }   // optional
/// }
/// ```
///
/// Optional `Router(value: @{state.x})` overrides the location source —
/// otherwise it defaults to `@{state.location}`.
fn convert_router(component: &ComponentSpecification) -> IRNode {
    let args = &component.arguments.arguments;
    let location = find_named_arg(args, &["value", "location"])
        .map(parser_value_to_ir)
        .unwrap_or_else(|| Value::Binding(Binding::state(vec!["location".to_string()])));

    let mut routes = Vec::new();
    let mut fallback: Option<Vec<IRNode>> = None;

    for child in &component.children {
        match child.name.as_str() {
            "Route" => {
                let route_args = &child.arguments.arguments;
                let path = find_named_arg(route_args, &["path", "0"])
                    .or_else(|| first_positional_arg(route_args))
                    .and_then(parser_string_unquoted);

                let Some(path) = path else {
                    // Skip routes without a path — ideally we'd error, but
                    // we mirror the When/If pattern of being lenient.
                    continue;
                };

                let route_children: Vec<IRNode> =
                    child.children.iter().map(ast_to_ir_node).collect();

                routes.push(RouterRoute::new(path, route_children));
            }
            // Convention for fallback: any non-Route child becomes part of
            // the fallback group. This lets users write `Router { Route(...){}; Else { ... } }`
            // or just leave a bare child as the fallback. Bare-element fallbacks
            // are more user-friendly than requiring a special wrapper.
            "Else" | "Fallback" => {
                let children: Vec<IRNode> = child.children.iter().map(ast_to_ir_node).collect();
                fallback = Some(children);
            }
            _ => {
                // Anything that isn't a Route or Else inside a Router is treated
                // as part of the implicit fallback. (Useful for `Router { Route(...){...} Text("Loading...") }` style.)
                let extra = ast_to_ir_node(child);
                fallback.get_or_insert_with(Vec::new).push(extra);
            }
        }
    }

    IRNode::Router {
        location,
        routes,
        fallback,
        module_scope: None,
    }
}

/// Convert parser Value to engine Value
fn parser_value_to_ir(value: &ParserValue) -> Value {
    match value {
        ParserValue::String(s) => {
            // Remove surrounding quotes if present
            let trimmed = s.trim_matches(|c: char| c == '"' || c == '\'');

            // Check if it's a pure binding (entire string is @{state.xxx} or @{item.xxx})
            if trimmed.starts_with("@{")
                && trimmed.ends_with('}')
                && !trimmed[2..trimmed.len() - 1].contains("@{")
            {
                // Try to parse as a simple binding first
                match parse_binding(trimmed) {
                    Some(binding) => Value::Binding(binding),
                    None => {
                        // Not a simple binding - might be an expression like @{state.active ? 'a' : 'b'}
                        // Extract bindings from the expression for dependency tracking
                        let bindings = extract_bindings_from_template(trimmed).unwrap_or_default();
                        Value::TemplateString {
                            template: trimmed.to_string(),
                            bindings,
                        }
                    }
                }
            } else if let Some(action_ref) = trimmed.strip_prefix("@actions.") {
                // @actions.xxx → action name
                Value::Action(action_ref.to_string())
            } else if let Some(router_method) = trimmed.strip_prefix("@router.") {
                // @router.{push|back|replace|forward} — first-class navigation
                // primitive. The `router.` namespace is reserved; the SDK's
                // `ManagedRouter` registers the handlers on `start()`. Stored
                // as a regular `Value::Action` with the namespace preserved in
                // the action name ("router.push") so the renderer dispatches
                // to the reserved slot without any special casing.
                Value::Action(format!("router.{}", router_method))
            } else if trimmed.contains("@{") {
                // Template string with embedded expressions or bindings
                // Extract any simple bindings we can find
                let bindings = extract_bindings_from_template(trimmed).unwrap_or_default();
                Value::TemplateString {
                    template: trimmed.to_string(),
                    bindings,
                }
            } else {
                Value::Static(serde_json::Value::String(trimmed.to_string()))
            }
        }
        ParserValue::Number(n) => Value::Static(serde_json::json!(*n)),
        ParserValue::Boolean(b) => Value::Static(serde_json::json!(*b)),
        ParserValue::List(items) => {
            let converted: Vec<serde_json::Value> = items
                .iter()
                .map(|v| match parser_value_to_ir(v) {
                    Value::Static(val) => val,
                    Value::Binding(binding) => {
                        serde_json::json!(format!("@{{{}}}", binding.full_path()))
                    }
                    Value::TemplateString { template, .. } => serde_json::json!(template),
                    Value::Action(s) => serde_json::json!(format!("@{}", s)),
                    Value::Resource(s) => serde_json::json!(format!("@resources.{}", s)),
                })
                .collect();
            Value::Static(serde_json::json!(converted))
        }
        ParserValue::Map(map) => {
            let mut json_map = serde_json::Map::new();
            for (k, v) in map {
                // Handle all value types, not just Static values
                // This preserves bindings like @{item.id} inside maps
                match parser_value_to_ir(v) {
                    Value::Static(val) => {
                        json_map.insert(k.clone(), val);
                    }
                    Value::Binding(binding) => {
                        // Preserve binding as a string representation for later resolution
                        json_map.insert(
                            k.clone(),
                            serde_json::json!(format!("@{{{}}}", binding.full_path_with_source())),
                        );
                    }
                    Value::TemplateString { template, .. } => {
                        json_map.insert(k.clone(), serde_json::json!(template));
                    }
                    Value::Action(s) => {
                        json_map.insert(k.clone(), serde_json::json!(format!("@actions.{}", s)));
                    }
                    Value::Resource(s) => {
                        json_map.insert(k.clone(), serde_json::json!(format!("@resources.{}", s)));
                    }
                }
            }
            Value::Static(serde_json::Value::Object(json_map))
        }
        ParserValue::Reference(ref_str) => {
            // References like @state.user, @actions.login, @item, @item.name, @spacetime.messages
            if ref_str.starts_with("state.") || ref_str.starts_with("item.") || ref_str == "item" {
                // Parse as binding, wrapping in @{}
                let binding_str = format!("@{{{}}}", ref_str);
                match parse_binding(&binding_str) {
                    Some(binding) => Value::Binding(binding),
                    None => Value::Static(serde_json::Value::String(ref_str.clone())),
                }
            } else if let Some(action_name) = ref_str.strip_prefix("actions.") {
                Value::Action(action_name.to_string())
            } else if let Some(router_method) = ref_str.strip_prefix("router.") {
                // `@router.push` / `@router.back` / `@router.replace` /
                // `@router.forward` — reserved navigation namespace. Stored
                // under the original "router.<method>" name so the SDK-side
                // `ManagedRouter.start()` can pre-register the handlers in
                // one place without engine-side special casing.
                Value::Action(format!("router.{}", router_method))
            } else if let Some(resource_name) = ref_str.strip_prefix("resources.") {
                Value::Resource(resource_name.to_string())
            } else if let Some(dot_pos) = ref_str.find('.') {
                // @provider.path → data source binding (e.g., @spacetime.messages)
                let provider = &ref_str[..dot_pos];
                let path: Vec<String> = ref_str[dot_pos + 1..]
                    .split('.')
                    .map(|s| s.to_string())
                    .collect();
                Value::Binding(Binding::data_source(provider, path))
            } else {
                Value::Static(serde_json::Value::String(ref_str.clone()))
            }
        }
        ParserValue::DataSourceReference(ref_str) => {
            // DEPRECATED: DataSourceReference is no longer produced by the parser.
            // Data sources now use @provider.path via Reference.
            // Kept for backward compatibility with serialized ASTs.
            if let Some(dot_pos) = ref_str.find('.') {
                let provider = &ref_str[..dot_pos];
                let path: Vec<String> = ref_str[dot_pos + 1..]
                    .split('.')
                    .map(|s| s.to_string())
                    .collect();
                Value::Binding(Binding::data_source(provider, path))
            } else {
                Value::Static(serde_json::Value::String(ref_str.clone()))
            }
        }
    }
}

/// Recursively set `module_scope` on an element and all its descendants.
///
/// Called during AST→IR conversion when the source is `module X { ... }`,
/// and from `ComponentRegistry::expand_ir_node_with_context` when expanding
/// a registered module-typed component into a tree.
pub(crate) fn propagate_module_scope_element(element: &mut Element, scope: &str) {
    element.module_scope = Some(scope.to_string());
    for ir_child in &mut element.ir_children {
        propagate_module_scope_ir_node(ir_child, scope);
    }
}

/// Recursively set `module_scope` on every Element inside an IRNode tree,
/// including ForEach/Conditional/Router control-flow nodes.
pub(crate) fn propagate_module_scope_ir_node(node: &mut IRNode, scope: &str) {
    crate::ir::walk::walk_ir_mut(node, &mut |n| match n {
        IRNode::Element(el) => el.module_scope = Some(scope.to_string()),
        IRNode::ForEach { module_scope, .. }
        | IRNode::Conditional { module_scope, .. }
        | IRNode::Router { module_scope, .. } => {
            *module_scope = Some(scope.to_string());
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use hypen_parser::parse_component;

    /// Helper: parse → ast_to_ir_node → unwrap Element
    fn parse_to_element(input: &str) -> Element {
        let component = parse_component(input).unwrap();
        match ast_to_ir_node(&component) {
            IRNode::Element(e) => e,
            other => panic!("Expected Element, got {:?}", other),
        }
    }

    #[test]
    fn test_simple_conversion() {
        let input = r#"Text("Hello World")"#;
        let element = parse_to_element(input);

        assert_eq!(element.element_type, "Text");
        assert_eq!(element.props.len(), 1);
    }

    #[test]
    fn test_binding_conversion() {
        let input = r#"Text("@{state.user.name}")"#;
        let element = parse_to_element(input);

        // Check that binding was parsed correctly
        let first_prop = element.props.values().next().unwrap();
        match first_prop {
            Value::Binding(binding) => {
                assert_eq!(binding.path, vec!["user", "name"]);
                assert_eq!(binding.full_path(), "user.name");
            }
            _ => panic!("Expected binding, got: {:?}", first_prop),
        }
    }

    #[test]
    fn test_children_conversion() {
        let input = r#"
            Column {
                Text("First")
                Text("Second")
            }
        "#;
        let element = parse_to_element(input);

        assert_eq!(element.element_type, "Column");
        assert_eq!(element.ir_children.len(), 2);
        assert!(matches!(&element.ir_children[0], IRNode::Element(e) if e.element_type == "Text"));
        assert!(matches!(&element.ir_children[1], IRNode::Element(e) if e.element_type == "Text"));
    }

    #[test]
    fn test_onclick_applicator_conversion() {
        let input = r#"Text("Click me").onClick("@actions.increment")"#;
        let element = parse_to_element(input);

        assert_eq!(element.element_type, "Text");
        // onClick should now be in props, not events
        assert!(element.props.contains_key("onClick.0"));
    }

    #[test]
    fn test_button_onclick_argument() {
        let input = r#"Button(onClick: "@actions.submit") { Text("Submit") }"#;
        let element = parse_to_element(input);

        assert_eq!(element.element_type, "Button");
        // onClick argument should be in props
        assert!(element.props.contains_key("onClick"));
        // Should have one child
        assert_eq!(element.ir_children.len(), 1);
    }

    #[test]
    fn test_template_string_conversion() {
        let input = r#"Text("Count: @{state.count}")"#;
        let element = parse_to_element(input);

        // Check that template string was parsed correctly
        let first_prop = element.props.values().next().unwrap();
        match first_prop {
            Value::TemplateString { template, bindings } => {
                assert_eq!(template, "Count: @{state.count}");
                assert_eq!(bindings.len(), 1);
                assert_eq!(bindings[0].full_path(), "count");
            }
            _ => panic!("Expected TemplateString, got: {:?}", first_prop),
        }
    }

    #[test]
    fn test_template_string_multiple_bindings() {
        let input = r#"Text("Hello @{state.user.name}, you have @{state.count} messages")"#;
        let element = parse_to_element(input);

        let first_prop = element.props.values().next().unwrap();
        match first_prop {
            Value::TemplateString { template, bindings } => {
                assert_eq!(
                    template,
                    "Hello @{state.user.name}, you have @{state.count} messages"
                );
                assert_eq!(bindings.len(), 2);
                assert_eq!(bindings[0].full_path(), "user.name");
                assert_eq!(bindings[1].full_path(), "count");
            }
            _ => panic!("Expected TemplateString, got: {:?}", first_prop),
        }
    }

    #[test]
    fn test_static_string_no_bindings() {
        let input = r#"Text("Hello World")"#;
        let element = parse_to_element(input);

        let first_prop = element.props.values().next().unwrap();
        match first_prop {
            Value::Static(val) => {
                assert_eq!(val.as_str().unwrap(), "Hello World");
            }
            _ => panic!("Expected Static, got: {:?}", first_prop),
        }
    }

    #[test]
    fn test_item_reference_conversion() {
        // Test @item.name reference syntax
        let input = r#"Text(text: @item.name)"#;
        let element = parse_to_element(input);

        let text_prop = element.props.get("text").unwrap();
        match text_prop {
            Value::Binding(binding) => {
                assert!(binding.is_item(), "Should be an item binding");
                assert_eq!(binding.path, vec!["name"]);
                assert_eq!(binding.full_path(), "name");
                assert_eq!(binding.full_path_with_source(), "item.name");
            }
            _ => panic!("Expected item Binding, got: {:?}", text_prop),
        }
    }

    #[test]
    fn test_item_reference_nested_path() {
        // Test @item.user.profile.name reference syntax
        let input = r#"Text(text: @item.user.profile.name)"#;
        let element = parse_to_element(input);

        let text_prop = element.props.get("text").unwrap();
        match text_prop {
            Value::Binding(binding) => {
                assert!(binding.is_item(), "Should be an item binding");
                assert_eq!(binding.path, vec!["user", "profile", "name"]);
                assert_eq!(binding.full_path(), "user.profile.name");
            }
            _ => panic!("Expected item Binding, got: {:?}", text_prop),
        }
    }

    #[test]
    fn test_bare_item_reference() {
        // Test @item reference (the whole item object)
        let input = r#"Component(data: @item)"#;
        let element = parse_to_element(input);

        let data_prop = element.props.get("data").unwrap();
        match data_prop {
            Value::Binding(binding) => {
                assert!(binding.is_item(), "Should be an item binding");
                assert!(
                    binding.path.is_empty(),
                    "Path should be empty for bare @item"
                );
                assert_eq!(binding.full_path_with_source(), "item");
            }
            _ => panic!("Expected item Binding, got: {:?}", data_prop),
        }
    }

    #[test]
    fn test_item_binding_in_template_string() {
        // Test @{item.name} in a template string
        let input = r#"Text("Hello @{item.name}!")"#;
        let element = parse_to_element(input);

        let first_prop = element.props.values().next().unwrap();
        match first_prop {
            Value::TemplateString { template, bindings } => {
                assert_eq!(template, "Hello @{item.name}!");
                assert_eq!(bindings.len(), 1);
                assert!(bindings[0].is_item(), "Should be an item binding");
                assert_eq!(bindings[0].full_path(), "name");
            }
            _ => panic!(
                "Expected TemplateString with item binding, got: {:?}",
                first_prop
            ),
        }
    }

    #[test]
    fn test_mixed_state_and_item_bindings() {
        // Test template with both @{state.xxx} and @{item.xxx}
        let input = r#"Text("@{state.prefix}: @{item.name}")"#;
        let element = parse_to_element(input);

        let first_prop = element.props.values().next().unwrap();
        match first_prop {
            Value::TemplateString { template, bindings } => {
                assert_eq!(template, "@{state.prefix}: @{item.name}");
                assert_eq!(bindings.len(), 2);
                assert!(bindings[0].is_state(), "First should be state binding");
                assert_eq!(bindings[0].full_path(), "prefix");
                assert!(bindings[1].is_item(), "Second should be item binding");
                assert_eq!(bindings[1].full_path(), "name");
            }
            _ => panic!("Expected TemplateString, got: {:?}", first_prop),
        }
    }

    #[test]
    fn test_tw_applicator_expansion() {
        // Test that .tw() applicator expands to CSS properties with .0 suffix
        let input = r#"Text("Hello").tw("p-4 text-blue-500")"#;
        let element = parse_to_element(input);

        // Should have expanded padding and color (with .0 suffix, camelCase)
        assert!(
            element.props.contains_key("padding.0"),
            "Should have padding.0 prop"
        );
        assert!(
            element.props.contains_key("color.0"),
            "Should have color.0 prop"
        );

        // Check padding value
        if let Value::Static(val) = element.props.get("padding.0").unwrap() {
            assert_eq!(val.as_str().unwrap(), "1rem");
        } else {
            panic!("Expected static padding value");
        }

        // Check color value
        if let Value::Static(val) = element.props.get("color.0").unwrap() {
            assert_eq!(val.as_str().unwrap(), "#3b82f6");
        } else {
            panic!("Expected static color value");
        }
    }

    #[test]
    fn test_tw_applicator_with_variants() {
        // Test that .tw() applicator handles responsive variants
        let input = r#"Text("Hello").tw("p-4 md:p-8 hover:bg-white")"#;
        let element = parse_to_element(input);

        // Should have base padding (with .0 suffix)
        assert!(
            element.props.contains_key("padding.0"),
            "Should have padding.0 prop"
        );

        // Should have variant properties (camelCase + variant + .0)
        assert!(
            element.props.contains_key("padding@md.0"),
            "Should have padding@md.0 prop"
        );
        assert!(
            element.props.contains_key("backgroundColor:hover.0"),
            "Should have backgroundColor:hover.0 prop"
        );

        // Check values
        if let Value::Static(val) = element.props.get("padding@md.0").unwrap() {
            assert_eq!(val.as_str().unwrap(), "2rem");
        }
        if let Value::Static(val) = element.props.get("backgroundColor:hover.0").unwrap() {
            assert_eq!(val.as_str().unwrap(), "#ffffff");
        }
    }

    #[test]
    fn test_responsive_object_applicator_expands_to_breakpoint_props() {
        // `.gridColumns({default: 2, md: 3, lg: 4})` must expand into the
        // same `name@bp.0` suffix props tailwind `md:` classes produce, so
        // every renderer resolves it — instead of one opaque object prop.
        let input = r#"Column {}.gridColumns({default: 2, md: 3, lg: 4})"#;
        let element = parse_to_element(input);
        let get = |k: &str| match element.props.get(k) {
            Some(Value::Static(v)) => v.as_f64(),
            _ => None,
        };
        assert_eq!(get("gridColumns.0"), Some(2.0), "default → unsuffixed base key");
        assert_eq!(get("gridColumns@md.0"), Some(3.0));
        assert_eq!(get("gridColumns@lg.0"), Some(4.0));
    }

    #[test]
    fn test_non_breakpoint_object_applicator_is_not_expanded() {
        // A composite-value object (not all-breakpoint keys) stays a single
        // prop — must not be mistaken for a responsive object.
        let input = r#"Column {}.size({width: 10, height: 20})"#;
        let element = parse_to_element(input);
        assert!(
            matches!(
                element.props.get("size.0"),
                Some(Value::Static(serde_json::Value::Object(_)))
            ),
            "composite {{width,height}} object passes through intact",
        );
        assert!(element.props.get("size@md.0").is_none());
    }

    #[test]
    fn test_tw_applicator_visual_regressions() {
        let input = r#"Column {}.tw("bg-gradient-to-br from-indigo-950 via-slate-900 to-fuchsia-950 bg-white/10 border-white/10 shadow-xl shadow-2xl opacity-60 backdrop-blur-[18px]")"#;
        let element = parse_to_element(input);

        let expected = [
            (
                "backgroundImage.0",
                "linear-gradient(to bottom right, #1e1b4b, #0f172a, #4a044e)",
            ),
            ("backgroundColor.0", "rgba(255, 255, 255, 0.1)"),
            ("borderColor.0", "rgba(255, 255, 255, 0.1)"),
            ("boxShadow.0", "0 25px 50px -12px rgb(0 0 0 / 0.25)"),
            ("opacity.0", "0.6"),
            ("backdropFilter.0", "blur(18px)"),
        ];

        for (key, value) in expected {
            match element.props.get(key) {
                Some(Value::Static(actual)) => assert_eq!(actual.as_str().unwrap(), value),
                other => panic!("Expected static prop {key}, got {other:?}"),
            }
        }
    }

    #[test]
    fn test_value_map_variant_breakpoints() {
        // .padding({ default: 8, md: 16 }) lowers to padding.0 + padding@md.0
        let input = r#"Text("Hi").padding({default: 8, md: 16})"#;
        let element = parse_to_element(input);

        assert!(
            element.props.contains_key("padding.0"),
            "Should have padding.0 prop"
        );
        assert!(
            element.props.contains_key("padding@md.0"),
            "Should have padding@md.0 prop"
        );

        if let Value::Static(val) = element.props.get("padding.0").unwrap() {
            assert_eq!(val.as_f64().unwrap(), 8.0);
        } else {
            panic!("expected static padding.0");
        }
        if let Value::Static(val) = element.props.get("padding@md.0").unwrap() {
            assert_eq!(val.as_f64().unwrap(), 16.0);
        } else {
            panic!("expected static padding@md.0");
        }
    }

    #[test]
    fn test_value_map_variant_state() {
        // .backgroundColor({ default: "red", hover: "blue" })
        let input = r#"Box {}.backgroundColor({default: "red", hover: "blue"})"#;
        let element = parse_to_element(input);

        assert!(
            element.props.contains_key("backgroundColor.0"),
            "Should have backgroundColor.0 prop"
        );
        assert!(
            element.props.contains_key("backgroundColor:hover.0"),
            "Should have backgroundColor:hover.0 prop"
        );

        if let Value::Static(val) = element.props.get("backgroundColor:hover.0").unwrap() {
            assert_eq!(val.as_str().unwrap(), "blue");
        } else {
            panic!("expected static backgroundColor:hover.0");
        }
    }

    #[test]
    fn test_value_map_variant_preserves_binding() {
        // Bindings inside a variant map value must survive lowering.
        let input = r#"Text("Hi").padding({default: 8, md: "@{state.gap}"})"#;
        let element = parse_to_element(input);

        assert!(element.props.contains_key("padding@md.0"));
        assert!(
            matches!(
                element.props.get("padding@md.0").unwrap(),
                Value::Binding(_)
            ),
            "binding inside variant map should be preserved"
        );
    }

    #[test]
    fn test_non_variant_map_is_passthrough() {
        // A map whose keys are NOT all variant tokens must NOT be hijacked;
        // it falls through to default applicator handling as a single .0 prop.
        let input = r#"Box {}.gradient({from: "red", to: "blue"})"#;
        let element = parse_to_element(input);

        // Default handling: single positional arg -> "gradient.0" holding a map.
        assert!(
            element.props.contains_key("gradient.0"),
            "non-variant map should remain a single gradient.0 prop"
        );
        // And it must NOT have produced variant-suffixed keys.
        assert!(!element.props.contains_key("gradient@from.0"));
        assert!(!element.props.contains_key("gradient:to.0"));
    }

    #[test]
    fn test_named_arg_applicator_unaffected() {
        // .padding(top: 8) is a Named arg, not a Map; must stay padding.top.
        let input = r#"Text("Hi").padding(top: 8)"#;
        let element = parse_to_element(input);
        assert!(
            element.props.contains_key("padding.top"),
            "named-arg applicator must remain padding.top"
        );
        assert!(!element.props.contains_key("padding.0"));
    }

    #[test]
    fn test_tw_mixed_with_other_applicators() {
        // Test .tw() combined with other applicators
        let input = r#"Text("Hello").tw("p-4").fontSize(18)"#;
        let element = parse_to_element(input);

        // Should have expanded tailwind (with .0 suffix, same as regular applicators)
        assert!(element.props.contains_key("padding.0"));

        // Should also have regular applicator
        assert!(element.props.contains_key("fontSize.0"));
    }

    #[test]
    fn test_css_to_camel_case() {
        assert_eq!(
            super::css_to_camel_case("background-color"),
            "backgroundColor"
        );
        assert_eq!(super::css_to_camel_case("align-items"), "alignItems");
        assert_eq!(
            super::css_to_camel_case("justify-content"),
            "justifyContent"
        );
        assert_eq!(super::css_to_camel_case("max-width"), "maxWidth");
        assert_eq!(
            super::css_to_camel_case("border-top-left-radius"),
            "borderTopLeftRadius"
        );
        // No hyphens → unchanged
        assert_eq!(super::css_to_camel_case("padding"), "padding");
        assert_eq!(super::css_to_camel_case("color"), "color");
    }

    #[test]
    fn test_tw_full_class_set() {
        // Test the exact class set from the user's issue
        let input =
            r#"Column {}.tw("p-6 items-center justify-center w-full h-full bg-black text-white")"#;
        let element = parse_to_element(input);

        // All props should be camelCase with .0 suffix
        assert!(
            element.props.contains_key("padding.0"),
            "Should have padding.0"
        );
        assert!(
            element.props.contains_key("alignItems.0"),
            "Should have alignItems.0"
        );
        assert!(
            element.props.contains_key("justifyContent.0"),
            "Should have justifyContent.0"
        );
        assert!(element.props.contains_key("width.0"), "Should have width.0");
        assert!(
            element.props.contains_key("height.0"),
            "Should have height.0"
        );
        assert!(
            element.props.contains_key("backgroundColor.0"),
            "Should have backgroundColor.0"
        );
        assert!(element.props.contains_key("color.0"), "Should have color.0");

        // Check values
        if let Value::Static(val) = element.props.get("padding.0").unwrap() {
            assert_eq!(val.as_str().unwrap(), "1.5rem");
        }
        if let Value::Static(val) = element.props.get("backgroundColor.0").unwrap() {
            assert_eq!(val.as_str().unwrap(), "#000000");
        }
        if let Value::Static(val) = element.props.get("color.0").unwrap() {
            assert_eq!(val.as_str().unwrap(), "#ffffff");
        }
        if let Value::Static(val) = element.props.get("width.0").unwrap() {
            assert_eq!(val.as_str().unwrap(), "100%");
        }
        if let Value::Static(val) = element.props.get("height.0").unwrap() {
            assert_eq!(val.as_str().unwrap(), "100%");
        }
    }

    #[test]
    fn test_bind_applicator_expansion() {
        let input = r#"Input(placeholder: "Type...").bind(@state.message)"#;
        let element = parse_to_element(input);

        // Should have "value" as a binding
        match element.props.get("value").unwrap() {
            Value::Binding(binding) => {
                assert!(binding.is_state());
                assert_eq!(binding.full_path(), "message");
            }
            _ => panic!("Expected binding for value prop"),
        }

        // Should have "bind" with the state path string
        match element.props.get("bind").unwrap() {
            Value::Static(val) => assert_eq!(val.as_str().unwrap(), "message"),
            _ => panic!("Expected static string for bind prop"),
        }
    }

    #[test]
    fn test_bind_applicator_nested_path() {
        let input = r#"Input(placeholder: "Email").bind(@state.user.email)"#;
        let element = parse_to_element(input);

        match element.props.get("value").unwrap() {
            Value::Binding(binding) => {
                assert!(binding.is_state());
                assert_eq!(binding.full_path(), "user.email");
            }
            _ => panic!("Expected binding for value prop"),
        }

        match element.props.get("bind").unwrap() {
            Value::Static(val) => assert_eq!(val.as_str().unwrap(), "user.email"),
            _ => panic!("Expected static string for bind prop"),
        }
    }

    #[test]
    fn test_bind_applicator_item_binding_ignored() {
        // .bind(@item.x) should NOT produce bind props (can't write back to iteration items)
        let input = r#"Input(placeholder: "Name").bind(@item.name)"#;
        let element = parse_to_element(input);

        assert!(
            !element.props.contains_key("bind"),
            "Item bindings should not produce bind prop"
        );
        assert!(
            !element.props.contains_key("value"),
            "Item bindings should not produce value prop"
        );
    }

    #[test]
    fn test_bind_applicator_in_ir_node() {
        // Test that bind works through ast_to_ir_node too
        let input = r#"Textarea(placeholder: "Message").bind(@state.msg)"#;
        let component = parse_component(input).unwrap();
        let ir_node = ast_to_ir_node(&component);

        match ir_node {
            IRNode::Element(element) => {
                match element.props.get("value").unwrap() {
                    Value::Binding(binding) => {
                        assert!(binding.is_state());
                        assert_eq!(binding.full_path(), "msg");
                    }
                    _ => panic!("Expected binding for value prop"),
                }
                match element.props.get("bind").unwrap() {
                    Value::Static(val) => assert_eq!(val.as_str().unwrap(), "msg"),
                    _ => panic!("Expected static string for bind prop"),
                }
            }
            _ => panic!("Expected Element IRNode"),
        }
    }

    #[test]
    fn test_bind_checkbox_uses_checked_prop() {
        let input = r#"Checkbox(label: "Accept").bind(@state.accepted)"#;
        let element = parse_to_element(input);

        // Should have "checked" (not "value") as a binding
        assert!(
            !element.props.contains_key("value"),
            "Checkbox bind should not set value prop"
        );
        match element.props.get("checked").unwrap() {
            Value::Binding(binding) => {
                assert!(binding.is_state());
                assert_eq!(binding.full_path(), "accepted");
            }
            _ => panic!("Expected binding for checked prop"),
        }

        match element.props.get("bind").unwrap() {
            Value::Static(val) => assert_eq!(val.as_str().unwrap(), "accepted"),
            _ => panic!("Expected static string for bind prop"),
        }
    }

    #[test]
    fn test_bind_switch_uses_on_prop() {
        let input = r#"Switch(label: "Dark mode").bind(@state.darkMode)"#;
        let element = parse_to_element(input);

        // Should have "on" (not "value") as a binding
        assert!(
            !element.props.contains_key("value"),
            "Switch bind should not set value prop"
        );
        match element.props.get("on").unwrap() {
            Value::Binding(binding) => {
                assert!(binding.is_state());
                assert_eq!(binding.full_path(), "darkMode");
            }
            _ => panic!("Expected binding for on prop"),
        }

        match element.props.get("bind").unwrap() {
            Value::Static(val) => assert_eq!(val.as_str().unwrap(), "darkMode"),
            _ => panic!("Expected static string for bind prop"),
        }
    }

    #[test]
    fn test_bind_select_uses_value_prop() {
        let input = r#"Select(options: ["a", "b"]).bind(@state.selected)"#;
        let element = parse_to_element(input);

        // Select should use "value" prop
        match element.props.get("value").unwrap() {
            Value::Binding(binding) => {
                assert!(binding.is_state());
                assert_eq!(binding.full_path(), "selected");
            }
            _ => panic!("Expected binding for value prop"),
        }

        match element.props.get("bind").unwrap() {
            Value::Static(val) => assert_eq!(val.as_str().unwrap(), "selected"),
            _ => panic!("Expected static string for bind prop"),
        }
    }

    // ── @datasource.path reference tests ─────────────────────────────────

    #[test]
    fn test_at_data_source_reference_simple() {
        // @spacetime.messages should produce a Binding::DataSource
        let input = r#"Text(data: @spacetime.messages)"#;
        let element = parse_to_element(input);

        match element.props.get("data").unwrap() {
            Value::Binding(binding) => {
                assert!(binding.is_data_source());
                assert_eq!(binding.provider(), Some("spacetime"));
                assert_eq!(binding.path, vec!["messages"]);
                assert_eq!(binding.full_path_with_source(), "spacetime.messages");
            }
            other => panic!("Expected DataSource binding, got: {:?}", other),
        }
    }

    #[test]
    fn test_at_data_source_reference_nested_path() {
        // @firebase.user.profile.name should produce a nested DataSource binding
        let input = r#"Text(@firebase.user.profile.name)"#;
        let element = parse_to_element(input);

        let text_prop = element.props.get("0").unwrap();
        match text_prop {
            Value::Binding(binding) => {
                assert!(binding.is_data_source());
                assert_eq!(binding.provider(), Some("firebase"));
                assert_eq!(binding.path, vec!["user", "profile", "name"]);
            }
            other => panic!("Expected DataSource binding, got: {:?}", other),
        }
    }

    #[test]
    fn test_data_source_uses_at_prefix() {
        // @spacetime.messages should produce a DataSource binding
        let input = r#"Text(data: @spacetime.messages)"#;
        let element = parse_to_element(input);

        let binding = match element.props.get("data").unwrap() {
            Value::Binding(b) => b,
            other => panic!("Expected binding from @, got: {:?}", other),
        };

        assert!(binding.is_data_source());
        assert_eq!(binding.provider(), Some("spacetime"));
        assert_eq!(binding.path, vec!["messages"]);
    }

    #[test]
    fn test_at_data_source_mixed_with_state() {
        // @state.count and @spacetime.messages in the same component
        let input = r#"Text(count: @state.count, data: @spacetime.messages)"#;
        let element = parse_to_element(input);

        match element.props.get("count").unwrap() {
            Value::Binding(binding) => {
                assert!(binding.is_state());
                assert_eq!(binding.full_path(), "count");
            }
            other => panic!("Expected state binding, got: {:?}", other),
        }

        match element.props.get("data").unwrap() {
            Value::Binding(binding) => {
                assert!(binding.is_data_source());
                assert_eq!(binding.provider(), Some("spacetime"));
                assert_eq!(binding.path, vec!["messages"]);
            }
            other => panic!("Expected DataSource binding, got: {:?}", other),
        }
    }

    #[test]
    fn test_at_actions_data_source_method() {
        // @actions.spacetime.sendMessage should produce Action("spacetime.sendMessage")
        let input = r#"Button(onClick: @actions.spacetime.sendMessage)"#;
        let element = parse_to_element(input);

        match element.props.get("onClick").unwrap() {
            Value::Action(action_name) => {
                assert_eq!(action_name, "spacetime.sendMessage");
            }
            other => panic!("Expected Action, got: {:?}", other),
        }
    }

    #[test]
    fn test_bind_data_source_reference() {
        // .bind(@spacetime.selectedId) should work like .bind(@state.x) but with data source
        let input = r#"Input(placeholder: "Search").bind(@spacetime.selectedId)"#;
        let element = parse_to_element(input);

        // Should have "value" as a data source binding
        match element.props.get("value").unwrap() {
            Value::Binding(binding) => {
                assert!(binding.is_data_source());
                assert_eq!(binding.provider(), Some("spacetime"));
                assert_eq!(binding.path, vec!["selectedId"]);
            }
            other => panic!(
                "Expected DataSource binding for value prop, got: {:?}",
                other
            ),
        }

        // Should have "bind" with the full data source path
        match element.props.get("bind").unwrap() {
            Value::Static(val) => {
                assert_eq!(val.as_str().unwrap(), "spacetime.selectedId");
            }
            other => panic!("Expected static string for bind prop, got: {:?}", other),
        }
    }

    #[test]
    fn test_resource_reference_conversion() {
        let input = r#"Icon(@resources.heart)"#;
        let element = parse_to_element(input);

        assert_eq!(element.element_type, "Icon");
        match element.props.get("0").unwrap() {
            Value::Resource(name) => assert_eq!(name, "heart"),
            other => panic!("Expected Value::Resource, got: {:?}", other),
        }
    }

    #[test]
    fn test_resource_reference_hyphenated_conversion() {
        let input = r#"Icon(@resources.plus-square)"#;
        let element = parse_to_element(input);

        assert_eq!(element.element_type, "Icon");
        match element.props.get("0").unwrap() {
            Value::Resource(name) => assert_eq!(name, "plus-square"),
            other => panic!("Expected Value::Resource, got: {:?}", other),
        }
    }

    #[test]
    fn test_resource_reference_named_arg() {
        let input = r#"Icon(name: @resources.search)"#;
        let element = parse_to_element(input);

        match element.props.get("name").unwrap() {
            Value::Resource(name) => assert_eq!(name, "search"),
            other => panic!("Expected Value::Resource, got: {:?}", other),
        }
    }

    // ---------------------------------------------------------------
    // @router namespace — first-class navigation primitive. Reserved
    // action name "router.<method>" is routed to the SDK's
    // ManagedRouter at `start()` time; users don't register it.
    // ---------------------------------------------------------------

    #[test]
    fn test_router_push_reference() {
        let input = r#"Button(text: "Go").onClick(@router.push, to: "/profile")"#;
        let element = parse_to_element(input);

        // Applicator pipeline namespaces prop keys as `onClick.0`,
        // `onClick.to`.
        match element.props.get("onClick.0").unwrap() {
            Value::Action(name) => assert_eq!(name, "router.push"),
            other => panic!("Expected Value::Action(\"router.push\"), got: {:?}", other),
        }

        match element.props.get("onClick.to").unwrap() {
            Value::Static(val) => assert_eq!(val.as_str().unwrap(), "/profile"),
            other => panic!("Expected Value::Static(/profile), got: {:?}", other),
        }
    }

    #[test]
    fn test_router_back_reference_no_payload() {
        let input = r#"Button(text: "Back").onClick(@router.back)"#;
        let element = parse_to_element(input);

        match element.props.get("onClick.0").unwrap() {
            Value::Action(name) => assert_eq!(name, "router.back"),
            other => panic!("Expected Value::Action(\"router.back\"), got: {:?}", other),
        }
    }

    #[test]
    fn test_router_replace_quoted_string_form() {
        // Quoted form: `.onClick("@router.replace")` — must resolve to
        // the same Value::Action as the bare-reference form.
        let input = r#"Button(text: "R").onClick("@router.replace", to: "/x")"#;
        let element = parse_to_element(input);

        match element.props.get("onClick.0").unwrap() {
            Value::Action(name) => assert_eq!(name, "router.replace"),
            other => panic!(
                "Expected Value::Action(\"router.replace\"), got: {:?}",
                other
            ),
        }
    }
}
