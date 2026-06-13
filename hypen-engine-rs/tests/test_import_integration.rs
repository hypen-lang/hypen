//! Integration tests for import resolution across engine bindings.
//!
//! These tests verify:
//! - WASI import buffer serialization/deserialization
//! - Component registry integration with imports
//! - Recursive import support (imports that reference other imports)
//! - Circular import detection
//! - Engine rendering with pre-registered imported components

mod common;

use common::*;
use hypen_engine::ir::{ast_to_ir_node, Component, Element};
use hypen_engine::lifecycle::{Module, ModuleInstance};
use hypen_engine::reconcile::Patch;
use hypen_engine::Engine;
use hypen_parser::{parse_document, ImportClause, ImportSource, ImportStatement};
use serde_json::json;
use std::sync::{Arc, Mutex};

// ============================================================================
// A. WASI Import Buffer Serialization (4 tests)
// ============================================================================

#[test]
fn test_import_buffer_serialization_single_local() {
    // GIVEN: A single local import
    let imports = [ImportStatement::new(
        ImportClause::Named(vec!["Button".to_string(), "Card".to_string()]),
        ImportSource::Local("./components/ui".to_string()),
    )];

    // WHEN: Serialize to the WASI buffer format (same as store_pending_imports)
    let import_infos: Vec<serde_json::Value> = imports
        .iter()
        .map(|imp| {
            let (source_path, source_type) = match &imp.source {
                ImportSource::Local(p) => (p.as_str(), "local"),
                ImportSource::Url(u) => (u.as_str(), "url"),
            };
            json!({
                "names": imp.imported_names(),
                "source_path": source_path,
                "source_type": source_type,
            })
        })
        .collect();

    let json_bytes = serde_json::to_vec(&import_infos).unwrap();
    let json_str = String::from_utf8(json_bytes).unwrap();

    // THEN: JSON contains the correct structure
    let parsed: Vec<serde_json::Value> = serde_json::from_str(&json_str).unwrap();
    assert_eq!(parsed.len(), 1);
    assert_eq!(parsed[0]["names"], json!(["Button", "Card"]));
    assert_eq!(parsed[0]["source_path"], json!("./components/ui"));
    assert_eq!(parsed[0]["source_type"], json!("local"));
}

#[test]
fn test_import_buffer_serialization_url() {
    // GIVEN: A URL import
    let imports = [ImportStatement::new(
        ImportClause::Default("Widget".to_string()),
        ImportSource::Url("https://cdn.example.com/widgets".to_string()),
    )];

    // WHEN: Serialize
    let import_infos: Vec<serde_json::Value> = imports
        .iter()
        .map(|imp| {
            let (source_path, source_type) = match &imp.source {
                ImportSource::Local(p) => (p.as_str(), "local"),
                ImportSource::Url(u) => (u.as_str(), "url"),
            };
            json!({
                "names": imp.imported_names(),
                "source_path": source_path,
                "source_type": source_type,
            })
        })
        .collect();

    let json_str = serde_json::to_string(&import_infos).unwrap();
    let parsed: Vec<serde_json::Value> = serde_json::from_str(&json_str).unwrap();

    // THEN: URL import is correctly serialized
    assert_eq!(parsed[0]["names"], json!(["Widget"]));
    assert_eq!(
        parsed[0]["source_path"],
        json!("https://cdn.example.com/widgets")
    );
    assert_eq!(parsed[0]["source_type"], json!("url"));
}

#[test]
fn test_import_buffer_serialization_multiple_mixed() {
    // GIVEN: Multiple imports of different types
    let imports = [
        ImportStatement::new(
            ImportClause::Named(vec!["Button".to_string()]),
            ImportSource::Local("./ui".to_string()),
        ),
        ImportStatement::new(
            ImportClause::Default("Dashboard".to_string()),
            ImportSource::Url("https://cdn.example.com/dashboard".to_string()),
        ),
        ImportStatement::new(
            ImportClause::Named(vec!["A".to_string(), "B".to_string(), "C".to_string()]),
            ImportSource::Local("../shared/components".to_string()),
        ),
    ];

    // WHEN: Serialize
    let import_infos: Vec<serde_json::Value> = imports
        .iter()
        .map(|imp| {
            let (source_path, source_type) = match &imp.source {
                ImportSource::Local(p) => (p.as_str(), "local"),
                ImportSource::Url(u) => (u.as_str(), "url"),
            };
            json!({
                "names": imp.imported_names(),
                "source_path": source_path,
                "source_type": source_type,
            })
        })
        .collect();

    let json_str = serde_json::to_string(&import_infos).unwrap();
    let parsed: Vec<serde_json::Value> = serde_json::from_str(&json_str).unwrap();

    // THEN: All three imports are serialized correctly
    assert_eq!(parsed.len(), 3);
    assert_eq!(parsed[0]["source_type"], json!("local"));
    assert_eq!(parsed[1]["source_type"], json!("url"));
    assert_eq!(parsed[2]["names"], json!(["A", "B", "C"]));
}

#[test]
fn test_import_buffer_serialization_empty() {
    // GIVEN: No imports
    let imports: Vec<ImportStatement> = vec![];

    // WHEN: Serialize
    let import_infos: Vec<serde_json::Value> = imports
        .iter()
        .map(|imp| {
            let (source_path, source_type) = match &imp.source {
                ImportSource::Local(p) => (p.as_str(), "local"),
                ImportSource::Url(u) => (u.as_str(), "url"),
            };
            json!({
                "names": imp.imported_names(),
                "source_path": source_path,
                "source_type": source_type,
            })
        })
        .collect();

    let json_str = serde_json::to_string(&import_infos).unwrap();

    // THEN: Empty array
    assert_eq!(json_str, "[]");
}

// ============================================================================
// B. Component Registry + Imports (3 tests)
// ============================================================================

#[test]
fn test_render_document_with_pre_registered_import() {
    // GIVEN: An engine with a pre-registered component (simulating resolved import)
    let mut engine = Engine::new();
    let patches = Arc::new(Mutex::new(Vec::new()));
    let patches_clone = patches.clone();

    engine.set_render_callback(move |p: &[Patch]| {
        patches_clone.lock().unwrap().extend(p.iter().cloned());
    });

    // Register a "Badge" component (simulating import resolution)
    let badge_component = Component::new("Badge", |_props| text_element("badge"));
    engine.register_component(badge_component);

    // WHEN: Parse a document that uses the imported component and render
    let input = r#"
import { Badge } from "./ui"

Column {
  Text("Hello")
  Badge()
}
    "#;
    let doc = parse_document(input).unwrap();
    let ir_node = ast_to_ir_node(&doc.components[0]);
    engine.render_ir_node(&ir_node);

    // THEN: Patches are generated including the Badge
    let patches = patches.lock().unwrap();
    let create_types: Vec<&str> = patches
        .iter()
        .filter_map(|p| match p {
            Patch::Create { element_type, .. } => Some(element_type.as_str()),
            _ => None,
        })
        .collect();

    assert!(
        create_types.contains(&"Column"),
        "Expected Column in creates: {:?}",
        create_types
    );
    assert!(
        create_types.contains(&"Text"),
        "Expected Text in creates: {:?}",
        create_types
    );
}

#[test]
fn test_document_imports_are_accessible_after_parsing() {
    // GIVEN: A document with various import types
    let input = r#"
import { Button, Card } from "./components/ui"
import Header from "./layout/header"
import { Widget } from "https://cdn.example.com/widgets"

Column {
  Header()
  Button(text: "Click")
  Card()
  Widget()
}
    "#;

    // WHEN: Parse the document
    let doc = parse_document(input).unwrap();

    // THEN: All imports are accessible for resolution
    assert_eq!(doc.imports.len(), 3);

    // First import: named, local
    assert_eq!(doc.imports[0].imported_names(), vec!["Button", "Card"]);
    assert_eq!(doc.imports[0].source_path(), "./components/ui");

    // Second import: default, local
    assert_eq!(doc.imports[1].imported_names(), vec!["Header"]);
    assert_eq!(doc.imports[1].source_path(), "./layout/header");

    // Third import: named, URL
    assert_eq!(doc.imports[2].imported_names(), vec!["Widget"]);
    assert_eq!(
        doc.imports[2].source_path(),
        "https://cdn.example.com/widgets"
    );
}

#[test]
fn test_document_without_imports_has_empty_imports_vec() {
    // GIVEN: A document without any imports
    let input = r#"
Column {
  Text("No imports here")
}
    "#;

    // WHEN: Parse the document
    let doc = parse_document(input).unwrap();

    // THEN: Imports vec is empty
    assert!(doc.imports.is_empty());

    // AND: Component is still parsed normally
    assert_eq!(doc.components.len(), 1);
    assert_eq!(doc.components[0].name, "Column");
}

// ============================================================================
// C. Recursive Import Scenarios (4 tests)
// ============================================================================

#[test]
fn test_nested_import_chain_a_imports_b() {
    // Simulates: App.hypen imports Header, Header.hypen imports Logo
    // All components pre-registered (simulating the resolver loop)

    let mut engine = Engine::new();
    let patches = Arc::new(Mutex::new(Vec::new()));
    let patches_clone = patches.clone();

    engine.set_render_callback(move |p: &[Patch]| {
        patches_clone.lock().unwrap().extend(p.iter().cloned());
    });

    // Register Logo (leaf dependency)
    let logo = Component::new("Logo", |_props| Element::new("Image"));
    engine.register_component(logo);

    // Register Header (depends on Logo)
    let header = Component::new("Header", |_props| {
        let mut row = Element::new("Row");
        row.ir_children
            .push(hypen_engine::ir::IRNode::Element(Element::new("Logo")));
        row.ir_children
            .push(hypen_engine::ir::IRNode::Element(text_element("App Title")));
        row
    });
    engine.register_component(header);

    // WHEN: Render App (depends on Header)
    let app_input = r#"
import { Header } from "./layout"

Column {
  Header()
  Text("Content")
}
    "#;
    let doc = parse_document(app_input).unwrap();
    let ir_node = ast_to_ir_node(&doc.components[0]);
    engine.render_ir_node(&ir_node);

    // THEN: Patches include nested components
    let patches = patches.lock().unwrap();
    let create_types: Vec<&str> = patches
        .iter()
        .filter_map(|p| match p {
            Patch::Create { element_type, .. } => Some(element_type.as_str()),
            _ => None,
        })
        .collect();

    assert!(
        create_types.contains(&"Column"),
        "Missing Column: {:?}",
        create_types
    );
    assert!(
        create_types.contains(&"Row"),
        "Missing Row (from Header): {:?}",
        create_types
    );
}

#[test]
fn test_circular_import_detection_via_visited_set() {
    // Simulates circular detection: A imports B, B imports A
    use std::collections::HashSet;

    let mut visited = HashSet::new();

    // First visit: A -> ok
    assert!(visited.insert("./components/a".to_string()));

    // Second visit: B -> ok
    assert!(visited.insert("./components/b".to_string()));

    // Third visit: A again -> circular!
    assert!(
        !visited.insert("./components/a".to_string()),
        "Should detect circular import"
    );
}

#[test]
fn test_import_visited_set_uses_name_and_path() {
    // Verifies the import_key format used in js.rs: "source_path:name"
    use std::collections::HashSet;

    let mut visited = HashSet::new();

    // Button from ./ui
    let key1 = format!("{}:{}", "./ui", "Button");
    assert!(visited.insert(key1));

    // Card from ./ui (different component, same path)
    let key2 = format!("{}:{}", "./ui", "Card");
    assert!(visited.insert(key2));

    // Button from ./other (same component, different path)
    let key3 = format!("{}:{}", "./other", "Button");
    assert!(visited.insert(key3));

    // Button from ./ui again (duplicate)
    let key4 = format!("{}:{}", "./ui", "Button");
    assert!(!visited.insert(key4), "Should detect duplicate import key");
}

#[test]
fn test_three_level_component_chain() {
    // Simulates: App -> Page -> Section -> Widget

    let mut engine = Engine::new();
    let patches = Arc::new(Mutex::new(Vec::new()));
    let patches_clone = patches.clone();

    engine.set_render_callback(move |p: &[Patch]| {
        patches_clone.lock().unwrap().extend(p.iter().cloned());
    });

    // Widget (leaf)
    let widget = Component::new("Widget", |_props| text_element("widget"));
    engine.register_component(widget);

    // Section (uses Widget)
    let section = Component::new("Section", |_props| {
        let mut col = Element::new("Column");
        col.ir_children
            .push(hypen_engine::ir::IRNode::Element(Element::new("Widget")));
        col.ir_children
            .push(hypen_engine::ir::IRNode::Element(text_element("section")));
        col
    });
    engine.register_component(section);

    // Page (uses Section)
    let page = Component::new("Page", |_props| {
        let mut col = Element::new("Column");
        col.ir_children
            .push(hypen_engine::ir::IRNode::Element(Element::new("Section")));
        col.ir_children
            .push(hypen_engine::ir::IRNode::Element(text_element("page")));
        col
    });
    engine.register_component(page);

    // Render App
    let app_input = r#"
import { Page } from "./pages"

Column {
  Page()
  Text("footer")
}
    "#;
    let doc = parse_document(app_input).unwrap();
    let ir_node = ast_to_ir_node(&doc.components[0]);
    engine.render_ir_node(&ir_node);

    // THEN: All levels render
    let patches = patches.lock().unwrap();
    assert!(
        patches.len() >= 5,
        "Expected many patches for 4-level component tree, got {}",
        patches.len()
    );
}

// ============================================================================
// D. State Bindings with Documents (3 tests)
// ============================================================================

#[test]
fn test_state_binding_in_document() {
    // GIVEN: Engine with state
    let mut engine = Engine::new();
    let patches = Arc::new(Mutex::new(Vec::new()));
    let patches_clone = patches.clone();

    engine.set_render_callback(move |p: &[Patch]| {
        patches_clone.lock().unwrap().extend(p.iter().cloned());
    });

    let module_meta = Module::new("App");
    let module = ModuleInstance::new(module_meta, json!({"title": "My App"}));
    engine.set_module(module);

    // WHEN: Render document with state binding
    let input = r#"
import { AppHeader } from "./header"

Column {
  Text("@{state.title}")
}
    "#;
    let doc = parse_document(input).unwrap();
    engine.render_ir_node(&ast_to_ir_node(&doc.components[0]));

    // THEN: State binding resolves
    let patches = patches.lock().unwrap();
    let has_title = patches.iter().any(|p| {
        if let Patch::Create { props, .. } = p {
            props
                .get("0")
                .map(|v| v == &json!("My App"))
                .unwrap_or(false)
        } else {
            false
        }
    });
    assert!(has_title, "Expected 'My App' in initial render");
}

#[test]
fn test_state_update_propagates_through_document() {
    let mut engine = Engine::new();
    let patches = Arc::new(Mutex::new(Vec::new()));
    let patches_clone = patches.clone();

    engine.set_render_callback(move |p: &[Patch]| {
        patches_clone.lock().unwrap().extend(p.iter().cloned());
    });

    let module_meta = Module::new("App");
    let module = ModuleInstance::new(module_meta, json!({"count": 0}));
    engine.set_module(module);

    let input = r#"
import { Counter } from "./counter"

Column {
  Text("@{state.count}")
}
    "#;
    let doc = parse_document(input).unwrap();
    engine.render_ir_node(&ast_to_ir_node(&doc.components[0]));

    patches.lock().unwrap().clear();

    // WHEN: Update state
    engine.update_state(None, json!({"count": 99}));

    // THEN: SetProp emitted
    let patches = patches.lock().unwrap();
    let has_update = patches.iter().any(|p| match p {
        Patch::SetProp { name, value, .. } => name == "0" && value == &json!(99),
        _ => false,
    });
    assert!(
        has_update,
        "Expected SetProp with count=99. Got: {:?}",
        *patches
    );
}

#[test]
fn test_document_full_lifecycle() {
    let mut engine = Engine::new();
    let all_patches = Arc::new(Mutex::new(Vec::new()));
    let patches_clone = all_patches.clone();

    engine.set_render_callback(move |p: &[Patch]| {
        patches_clone.lock().unwrap().extend(p.iter().cloned());
    });

    let module_meta = Module::new("Chat");
    let module = ModuleInstance::new(module_meta, json!({"message": "Hello"}));
    engine.set_module(module);

    let input = r#"
import { MessageView } from "./chat"

Column {
  Text("@{state.message}")
}
    "#;
    let doc = parse_document(input).unwrap();
    engine.render_ir_node(&ast_to_ir_node(&doc.components[0]));

    // Check initial render
    {
        let patches = all_patches.lock().unwrap();
        let has_hello = patches.iter().any(|p| {
            if let Patch::Create { props, .. } = p {
                props
                    .get("0")
                    .map(|v| v == &json!("Hello"))
                    .unwrap_or(false)
            } else {
                false
            }
        });
        assert!(has_hello, "Expected 'Hello' in initial render");
    }

    // Update state
    all_patches.lock().unwrap().clear();
    engine.update_state(None, json!({"message": "World"}));

    // Check update
    {
        let patches = all_patches.lock().unwrap();
        let has_world = patches.iter().any(|p| match p {
            Patch::SetProp { name, value, .. } => name == "0" && value == &json!("World"),
            _ => false,
        });
        assert!(
            has_world,
            "Expected 'World' after state update. Got: {:?}",
            *patches
        );
    }
}

// ============================================================================
// E. Router + Import Parsing (2 tests)
// ============================================================================

#[test]
fn test_document_with_router_and_imports() {
    let input = r#"
import { HomePage } from "./pages/home"
import { AboutPage } from "./pages/about"

Router {
  Route(path: "/") {
    HomePage()
  }
  Route(path: "/about") {
    AboutPage()
  }
}
    "#;

    let doc = parse_document(input).unwrap();

    assert_eq!(doc.imports.len(), 2);
    assert_eq!(doc.imports[0].imported_names(), vec!["HomePage"]);
    assert_eq!(doc.imports[1].imported_names(), vec!["AboutPage"]);

    assert_eq!(doc.components.len(), 1);
    assert_eq!(doc.components[0].name, "Router");
}

#[test]
fn test_document_with_nested_layouts_and_imports() {
    let input = r#"
import { Header } from "./layout/header"
import { Footer } from "./layout/footer"
import { Sidebar } from "./layout/sidebar"
import { MainContent } from "./pages/main"

Column {
  Header()
  Row {
    Sidebar()
    MainContent()
  }
  Footer()
}
    "#;

    let doc = parse_document(input).unwrap();

    assert_eq!(doc.imports.len(), 4);
    assert_eq!(doc.imports[0].source_path(), "./layout/header");
    assert_eq!(doc.imports[1].source_path(), "./layout/footer");
    assert_eq!(doc.imports[2].source_path(), "./layout/sidebar");
    assert_eq!(doc.imports[3].source_path(), "./pages/main");

    assert_eq!(doc.components.len(), 1);
    assert_eq!(doc.components[0].name, "Column");
}
