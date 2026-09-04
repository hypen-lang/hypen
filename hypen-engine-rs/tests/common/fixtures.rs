//! Test fixtures - pre-built elements, components, and test data
#![allow(dead_code)]

use hypen_engine::ir::{Component, Element, IRNode, Props, Value};
use hypen_engine::lifecycle::{Module, ModuleInstance};
use hypen_engine::reactive::Binding;
use hypen_engine::reconcile::Patch;
use indexmap::indexmap;
use serde_json::json;
use std::sync::{Arc, Mutex};

// ========== Element Fixtures ==========

/// Creates a simple Text element with static content
///
/// # Example
/// ```
/// let elem = text_element("Hello");
/// assert_eq!(elem.element_type, "Text");
/// ```
pub fn text_element(content: &str) -> Element {
    Element {
        element_type: "Text".to_string(),
        props: Props::from_map(indexmap! {
            "text".to_string() => Value::Static(json!(content))
        }),
        ir_children: Vec::new(),
        key: None,
        module_scope: None,
        semantics: None,
        span: None,
        expr_span: None,
    }
}

/// Creates a Text element with a binding (state or item)
///
/// # Example
/// ```
/// let elem = text_element_with_binding("user.name");
/// // When rendered with state {user: {name: "Alice"}}, displays "Alice"
/// let elem = text_element_with_binding("item.name");
/// // Creates an item binding for use in List children
/// ```
pub fn text_element_with_binding(path: &str) -> Element {
    let binding = if let Some(stripped) = path.strip_prefix("item.") {
        // Item binding: "item.name" -> Binding::item(["name"])
        let path_parts: Vec<String> = stripped.split('.').map(|s| s.to_string()).collect();
        Binding::item(path_parts)
    } else if path == "item" {
        // Bare item binding
        Binding::item(vec![])
    } else {
        // State binding
        let path_parts: Vec<String> = path.split('.').map(|s| s.to_string()).collect();
        Binding::state(path_parts)
    };
    Element {
        element_type: "Text".to_string(),
        props: Props::from_map(indexmap! {
            "text".to_string() => Value::Binding(binding)
        }),
        ir_children: Vec::new(),
        key: None,
        module_scope: None,
        semantics: None,
        span: None,
        expr_span: None,
    }
}

/// Creates a Column element with children
pub fn column_with_children(children: Vec<Element>) -> Element {
    Element {
        element_type: "Column".to_string(),
        props: Props::new(),
        ir_children: children.into_iter().map(IRNode::Element).collect(),
        key: None,
        module_scope: None,
        semantics: None,
        span: None,
        expr_span: None,
    }
}

/// Creates a Row element with children
pub fn row_with_children(children: Vec<Element>) -> Element {
    Element {
        element_type: "Row".to_string(),
        props: Props::new(),
        ir_children: children.into_iter().map(IRNode::Element).collect(),
        key: None,
        module_scope: None,
        semantics: None,
        span: None,
        expr_span: None,
    }
}

/// Creates an Image element with a URL
pub fn image_element(url: &str) -> Element {
    Element {
        element_type: "Image".to_string(),
        props: Props::from_map(indexmap! {
            "src".to_string() => Value::Static(json!(url))
        }),
        ir_children: Vec::new(),
        key: None,
        module_scope: None,
        semantics: None,
        span: None,
        expr_span: None,
    }
}

/// Creates a Button element with text
pub fn button_element(text: &str) -> Element {
    Element {
        element_type: "Button".to_string(),
        props: Props::from_map(indexmap! {
            "text".to_string() => Value::Static(json!(text))
        }),
        ir_children: Vec::new(),
        key: None,
        module_scope: None,
        semantics: None,
        span: None,
        expr_span: None,
    }
}

/// Creates a Button with an action handler
pub fn button_with_action(text: &str, action: &str) -> Element {
    Element {
        element_type: "Button".to_string(),
        props: Props::from_map(indexmap! {
            "text".to_string() => Value::Static(json!(text)),
            "onClick".to_string() => Value::Action(action.to_string())
        }),
        ir_children: Vec::new(),
        key: None,
        module_scope: None,
        semantics: None,
        span: None,
        expr_span: None,
    }
}

/// Creates an element with a key for reconciliation
pub fn keyed_text_element(content: &str, key: &str) -> Element {
    Element {
        element_type: "Text".to_string(),
        props: Props::from_map(indexmap! {
            "text".to_string() => Value::Static(json!(content))
        }),
        ir_children: Vec::new(),
        key: Some(key.to_string()),
        module_scope: None,
        semantics: None,
        span: None,
        expr_span: None,
    }
}

/// Creates a generic element with custom props
pub fn element_with_props(element_type: &str, props: Props) -> Element {
    Element {
        element_type: element_type.to_string(),
        props,
        ir_children: Vec::new(),
        key: None,
        module_scope: None,
        semantics: None,
        span: None,
        expr_span: None,
    }
}

// ========== Component Fixtures ==========

/// Creates a simple component that always renders the same content
pub fn simple_component(name: &str, content: &str) -> Component {
    let content_owned = content.to_string();
    Component::new(name, move |_props| text_element(&content_owned))
}

/// Creates a component that uses a prop
pub fn component_with_prop(name: &str, prop_name: &str) -> Component {
    let prop_name_owned = prop_name.to_string();
    Component::new(name, move |props| {
        let value = props
            .get(&prop_name_owned)
            .and_then(|v| v.as_str())
            .unwrap_or("default");
        text_element(value)
    })
}

/// Creates a component that wraps children in a Column
pub fn container_component(name: &str) -> Component {
    Component::new(name, |_props| column_with_children(vec![]))
}

// ========== Module Fixtures ==========

/// Creates a simple module with a name
pub fn simple_module(name: &str) -> Module {
    Module::new(name)
}

/// Creates a module instance with initial state
pub fn module_instance_with_state(name: &str, state: serde_json::Value) -> ModuleInstance {
    let module = Module::new(name);
    ModuleInstance::new(module, state)
}

/// Creates a module instance with user data
pub fn user_module() -> ModuleInstance {
    module_instance_with_state(
        "UserModule",
        json!({
            "user": {
                "name": "Alice",
                "email": "alice@example.com",
                "age": 30
            },
            "isLoggedIn": true
        }),
    )
}

/// Creates a module instance with a counter
pub fn counter_module() -> ModuleInstance {
    module_instance_with_state(
        "CounterModule",
        json!({
            "count": 0
        }),
    )
}

/// Creates a module instance with a list
pub fn list_module() -> ModuleInstance {
    module_instance_with_state(
        "ListModule",
        json!({
            "items": [
                {"id": 1, "name": "Item 1"},
                {"id": 2, "name": "Item 2"},
                {"id": 3, "name": "Item 3"}
            ]
        }),
    )
}

// ========== Tree Fixtures ==========

/// Creates a nested tree structure for testing
/// Returns: Column { Text("A"), Row { Text("B"), Text("C") }, Text("D") }
pub fn nested_tree() -> Element {
    column_with_children(vec![
        text_element("A"),
        row_with_children(vec![text_element("B"), text_element("C")]),
        text_element("D"),
    ])
}

/// Creates a deep tree (nested Columns)
pub fn deep_tree(depth: usize) -> Element {
    let mut element = text_element("Leaf");
    for _ in 0..depth {
        element = column_with_children(vec![element]);
    }
    element
}

/// Creates a wide tree (many children)
pub fn wide_tree(num_children: usize) -> Element {
    let children: Vec<Element> = (0..num_children)
        .map(|i| text_element(&format!("Child {}", i)))
        .collect();
    column_with_children(children)
}

/// Creates a list of keyed elements
pub fn keyed_list(items: &[&str]) -> Vec<Element> {
    items
        .iter()
        .enumerate()
        .map(|(i, &text)| keyed_text_element(text, &i.to_string()))
        .collect()
}

// ========== Callback Fixtures ==========

/// Creates a patch capture callback
/// Returns (captured_patches, callback_function)
///
/// Captured batches are lowered through a [`TemplateExpander`] the way
/// every plain-patch boundary does, so tests written against the
/// pre-template `Create`/`Insert` wire keep asserting that shape. Tests
/// that pin the collapsed (`RegisterTemplate`/`Instantiate`) wire itself
/// use their own raw callback instead.
#[allow(clippy::type_complexity)]
pub fn patch_capture() -> (Arc<Mutex<Vec<Patch>>>, impl Fn(&[Patch])) {
    let patches = Arc::new(Mutex::new(Vec::new()));
    let patches_clone = patches.clone();
    let expander = Mutex::new(hypen_engine::TemplateExpander::new());
    let callback = move |new_patches: &[Patch]| {
        let lowered = expander.lock().unwrap().expand(new_patches.to_vec());
        patches_clone.lock().unwrap().extend(lowered);
    };
    (patches, callback)
}

/// Creates a call counter callback
/// Returns (call_count, callback_function)
pub fn call_counter() -> (Arc<Mutex<usize>>, impl Fn()) {
    let count = Arc::new(Mutex::new(0));
    let count_clone = count.clone();
    let callback = move || {
        *count_clone.lock().unwrap() += 1;
    };
    (count, callback)
}

// ========== State Fixtures ==========

/// Sample user state
pub fn user_state() -> serde_json::Value {
    json!({
        "user": {
            "id": 1,
            "name": "Alice",
            "email": "alice@example.com",
            "profile": {
                "avatar": "https://example.com/avatar.jpg",
                "bio": "Software developer"
            }
        }
    })
}

/// Sample cart state
pub fn cart_state() -> serde_json::Value {
    json!({
        "cart": {
            "items": [
                {"id": 1, "name": "Product A", "price": 10.0, "quantity": 2},
                {"id": 2, "name": "Product B", "price": 25.0, "quantity": 1}
            ],
            "total": 45.0
        }
    })
}

/// Sample form state
pub fn form_state() -> serde_json::Value {
    json!({
        "form": {
            "name": "",
            "email": "",
            "message": "",
            "errors": {}
        }
    })
}
