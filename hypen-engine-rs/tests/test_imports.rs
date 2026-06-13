//! Tests for import support in the Hypen document pipeline.
//!
//! Verifies that documents with import statements parse correctly and that
//! the components within those documents convert through the IR pipeline
//! properly. This covers:
//!
//! - Parser: Document parsing with named/default/URL imports
//! - IR: Components extracted from documents convert to IR correctly
//! - Engine: Rendering components from parsed documents produces expected patches

mod common;

use hypen_engine::ir::Value;
use hypen_engine::lifecycle::{Module, ModuleInstance};
use hypen_engine::Engine;
use hypen_parser::{
    parse_document, parse_import, Document, ImportClause, ImportSource, ImportStatement,
};
use serde_json::json;
use std::sync::{Arc, Mutex};

// ============================================================================
// A. Parse Single Import Statements (6 tests)
// ============================================================================

#[test]
fn test_parse_named_import_from_local_path() {
    // GIVEN: Named import from a local path
    let input = r#"import { Button, Card } from "./components/ui""#;

    // WHEN: Parse the import
    let import = parse_import(input).unwrap();

    // THEN: Clause is Named with correct names
    assert!(matches!(import.clause, ImportClause::Named(_)));
    assert_eq!(import.imported_names(), vec!["Button", "Card"]);

    // AND: Source is Local
    assert!(matches!(import.source, ImportSource::Local(_)));
    assert_eq!(import.source_path(), "./components/ui");
}

#[test]
fn test_parse_default_import_from_local_path() {
    // GIVEN: Default import from a local path
    let input = r#"import HomePage from "./pages/HomePage""#;

    // WHEN: Parse the import
    let import = parse_import(input).unwrap();

    // THEN: Clause is Default with the correct name
    assert!(matches!(import.clause, ImportClause::Default(ref name) if name == "HomePage"));
    assert_eq!(import.imported_names(), vec!["HomePage"]);

    // AND: Source is Local
    assert!(matches!(import.source, ImportSource::Local(_)));
    assert_eq!(import.source_path(), "./pages/HomePage");
}

#[test]
fn test_parse_named_import_from_url() {
    // GIVEN: Named import from a URL
    let input = r#"import { Header, Footer } from "https://cdn.example.com/ui""#;

    // WHEN: Parse the import
    let import = parse_import(input).unwrap();

    // THEN: Source is Url
    assert!(matches!(import.source, ImportSource::Url(_)));
    assert_eq!(import.source_path(), "https://cdn.example.com/ui");
    assert_eq!(import.imported_names(), vec!["Header", "Footer"]);
}

#[test]
fn test_parse_default_import_from_url() {
    // GIVEN: Default import from an HTTP URL
    let input = r#"import Dashboard from "https://registry.hypen.space/components/dashboard""#;

    // WHEN: Parse the import
    let import = parse_import(input).unwrap();

    // THEN: Clause is Default and source is URL
    assert!(matches!(import.clause, ImportClause::Default(ref name) if name == "Dashboard"));
    assert!(matches!(import.source, ImportSource::Url(_)));
    assert_eq!(
        import.source_path(),
        "https://registry.hypen.space/components/dashboard"
    );
}

#[test]
fn test_parse_import_with_many_named_exports() {
    // GIVEN: Import with many named exports
    let input = r#"import { A, B, C, D, E, F } from "./widgets""#;

    // WHEN: Parse the import
    let import = parse_import(input).unwrap();

    // THEN: All 6 names are captured
    let names = import.imported_names();
    assert_eq!(names.len(), 6);
    assert_eq!(names, vec!["A", "B", "C", "D", "E", "F"]);
}

#[test]
fn test_parse_import_with_trailing_comma() {
    // GIVEN: Import with trailing comma in the named list
    let input = r#"import { Button, Card, } from "./ui""#;

    // WHEN: Parse the import
    let import = parse_import(input).unwrap();

    // THEN: Trailing comma is handled gracefully
    assert_eq!(import.imported_names().len(), 2);
    assert_eq!(import.imported_names(), vec!["Button", "Card"]);
}

// ============================================================================
// B. Parse Documents with Imports (5 tests)
// ============================================================================

#[test]
fn test_parse_document_with_imports_and_module() {
    // GIVEN: A full document with imports and a module
    let input = r#"
import { Button, Card } from "./components/ui"
import HomePage from "./pages/HomePage"

module App() {
  Column {
    HomePage()
    Button(text: "Click me")
  }
}
    "#;

    // WHEN: Parse the document
    let doc = parse_document(input).unwrap();

    // THEN: Both imports are captured
    assert_eq!(doc.imports.len(), 2);
    assert_eq!(doc.imports[0].imported_names(), vec!["Button", "Card"]);
    assert_eq!(doc.imports[1].imported_names(), vec!["HomePage"]);

    // AND: The component is captured
    assert_eq!(doc.components.len(), 1);
    assert_eq!(doc.components[0].name, "App");
}

#[test]
fn test_parse_document_without_imports() {
    // GIVEN: A document with no imports
    let input = r#"
module App() {
  Text("No imports here")
}
    "#;

    // WHEN: Parse the document
    let doc = parse_document(input).unwrap();

    // THEN: No imports, but component is present
    assert_eq!(doc.imports.len(), 0);
    assert_eq!(doc.components.len(), 1);
    assert_eq!(doc.components[0].name, "App");
}

#[test]
fn test_parse_document_only_imports() {
    // GIVEN: A document with only imports (e.g., a barrel file)
    let input = r#"
import { Button } from "./ui"
import Card from "./components"
import { List, Grid } from "https://cdn.example.com/layout"
    "#;

    // WHEN: Parse the document
    let doc = parse_document(input).unwrap();

    // THEN: All imports captured, no components
    assert_eq!(doc.imports.len(), 3);
    assert_eq!(doc.components.len(), 0);

    // AND: Mixed source types
    assert!(matches!(doc.imports[0].source, ImportSource::Local(_)));
    assert!(matches!(doc.imports[1].source, ImportSource::Local(_)));
    assert!(matches!(doc.imports[2].source, ImportSource::Url(_)));
}

#[test]
fn test_parse_document_with_comments_and_imports() {
    // GIVEN: A document with comments interspersed around imports
    let input = r#"
// UI components from local package
import { Button } from "./ui"

/* Layout components from CDN */
import { Row, Column } from "https://cdn.example.com/layout"

// Main app
module App() {
  Column {
    // Use the imported Row
    Row {
      Button(text: "Click")
    }
  }
}
    "#;

    // WHEN: Parse the document
    let doc = parse_document(input).unwrap();

    // THEN: Comments don't interfere with parsing
    assert_eq!(doc.imports.len(), 2);
    assert_eq!(doc.components.len(), 1);
    assert_eq!(doc.imports[0].imported_names(), vec!["Button"]);
    assert_eq!(doc.imports[1].imported_names(), vec!["Row", "Column"]);
}

#[test]
fn test_parse_document_multiple_components_with_imports() {
    // GIVEN: A document with imports and multiple component definitions
    let input = r#"
import { Icon } from "./icons"

component Header() {
  Row {
    Icon(name: "menu")
    Text("My App")
  }
}

module MainPage() {
  Column {
    Header()
    Text("Content")
  }
}
    "#;

    // WHEN: Parse the document
    let doc = parse_document(input).unwrap();

    // THEN: One import and two components
    assert_eq!(doc.imports.len(), 1);
    assert_eq!(doc.components.len(), 2);
    assert_eq!(doc.components[0].name, "Header");
    assert_eq!(doc.components[1].name, "MainPage");
}

// ============================================================================
// C. Document Components Through IR Pipeline (4 tests)
// ============================================================================

#[test]
fn test_document_component_converts_to_ir() {
    // GIVEN: A document with imports and a component
    let input = r#"
import { Button } from "./ui"

Column {
  Text("Hello")
  Button(text: "Click")
}
    "#;

    // WHEN: Parse document and convert first component to IR
    let doc = parse_document(input).unwrap();
    assert_eq!(doc.components.len(), 1);

    let ir_node = hypen_engine::ir::expand::ast_to_ir_node(&doc.components[0]);
    let element = match ir_node {
        hypen_engine::ir::IRNode::Element(e) => e,
        other => panic!("Expected Element, got {:?}", other),
    };

    // THEN: IR element has correct structure
    assert_eq!(element.element_type, "Column");
    assert_eq!(element.ir_children.len(), 2);
    assert!(
        matches!(&element.ir_children[0], hypen_engine::ir::IRNode::Element(e) if e.element_type == "Text")
    );
    assert!(
        matches!(&element.ir_children[1], hypen_engine::ir::IRNode::Element(e) if e.element_type == "Button")
    );
}

#[test]
fn test_document_module_converts_to_ir_with_bindings() {
    // GIVEN: A document with imports and a module using state bindings
    let input = r#"
import { Avatar } from "./components/avatar"

module ProfilePage() {
  Column {
    Avatar(src: "@{state.user.avatar}")
    Text("@{state.user.name}")
  }
}
    "#;

    // WHEN: Parse document and convert module component to IR
    let doc = parse_document(input).unwrap();
    let ir_node = hypen_engine::ir::expand::ast_to_ir_node(&doc.components[0]);
    let element = match ir_node {
        hypen_engine::ir::IRNode::Element(e) => e,
        other => panic!("Expected Element, got {:?}", other),
    };

    // THEN: Module wrapper is transparent — the root is the Column inside,
    // not the "ProfilePage" element (modules don't create visual elements).
    assert_eq!(element.element_type, "Column");

    // Column's children are the Avatar and Text
    let column = &element;
    assert_eq!(column.ir_children.len(), 2);

    // Avatar has a binding prop
    let avatar = match &column.ir_children[0] {
        hypen_engine::ir::IRNode::Element(e) => e,
        other => panic!("Expected Element for Avatar, got {:?}", other),
    };
    assert_eq!(avatar.element_type, "Avatar");
    match avatar.props.get("src").unwrap() {
        Value::Binding(binding) => {
            assert_eq!(binding.full_path(), "user.avatar");
        }
        other => panic!("Expected Binding value for avatar src, got {:?}", other),
    }

    // Text has a binding prop
    let text = match &column.ir_children[1] {
        hypen_engine::ir::IRNode::Element(e) => e,
        other => panic!("Expected Element for Text, got {:?}", other),
    };
    assert_eq!(text.element_type, "Text");
    match text.props.get("0").unwrap() {
        Value::Binding(binding) => {
            assert_eq!(binding.full_path(), "user.name");
        }
        other => panic!("Expected Binding value for text, got {:?}", other),
    }
}

#[test]
fn test_document_foreach_converts_to_ir_node() {
    // GIVEN: A document with a ForEach component (parsed directly as top-level)
    // Note: ForEach uses @state reference syntax, not @{state} template strings
    let input = r#"
import { ListItem } from "./list"

ForEach(items: @state.items, as: "item", key: "id") {
  ListItem(label: @item.name)
}
    "#;

    // WHEN: Parse document and convert to IRNode
    let doc = parse_document(input).unwrap();
    let ir_node = hypen_engine::ir::expand::ast_to_ir_node(&doc.components[0]);

    // THEN: Top-level is a ForEach IRNode
    match ir_node {
        hypen_engine::ir::IRNode::ForEach {
            source,
            item_name,
            template,
            ..
        } => {
            assert_eq!(source.full_path(), "items");
            assert_eq!(item_name, "item");
            assert_eq!(template.len(), 1);
        }
        other => panic!("Expected ForEach IRNode, got {:?}", other),
    }
}

#[test]
fn test_multiple_document_components_convert_independently() {
    // GIVEN: A document with imports and multiple component definitions
    let input = r#"
import { Icon } from "./icons"
import { Badge } from "./badges"

component NavItem(label: "default") {
  Row {
    Icon(name: "star")
    Text("@{state.label}")
  }
}

component Footer() {
  Row {
    Text("Copyright 2025")
    Badge(text: "v1.0")
  }
}
    "#;

    // WHEN: Parse document and convert each component to IR
    let doc = parse_document(input).unwrap();
    assert_eq!(doc.components.len(), 2);

    let nav_item = match hypen_engine::ir::expand::ast_to_ir_node(&doc.components[0]) {
        hypen_engine::ir::IRNode::Element(e) => e,
        other => panic!("Expected Element, got {:?}", other),
    };
    let footer = match hypen_engine::ir::expand::ast_to_ir_node(&doc.components[1]) {
        hypen_engine::ir::IRNode::Element(e) => e,
        other => panic!("Expected Element, got {:?}", other),
    };

    // THEN: Each component converts independently
    assert_eq!(nav_item.element_type, "NavItem");
    assert_eq!(nav_item.ir_children.len(), 1); // Row wrapper

    assert_eq!(footer.element_type, "Footer");
    assert_eq!(footer.ir_children.len(), 1); // Row wrapper

    let footer_row = match &footer.ir_children[0] {
        hypen_engine::ir::IRNode::Element(e) => e,
        other => panic!("Expected Element for footer Row, got {:?}", other),
    };
    assert_eq!(footer_row.ir_children.len(), 2);
    assert!(
        matches!(&footer_row.ir_children[0], hypen_engine::ir::IRNode::Element(e) if e.element_type == "Text")
    );
    assert!(
        matches!(&footer_row.ir_children[1], hypen_engine::ir::IRNode::Element(e) if e.element_type == "Badge")
    );
}

// ============================================================================
// D. Engine Rendering from Document Components (3 tests)
// ============================================================================

#[test]
fn test_engine_renders_component_from_document() {
    // GIVEN: An engine and a document with imports
    let mut engine = Engine::new();
    let patches = Arc::new(Mutex::new(Vec::new()));
    let patches_clone = patches.clone();

    engine.set_render_callback(move |p: &[hypen_engine::reconcile::Patch]| {
        patches_clone.lock().unwrap().extend(p.iter().cloned());
    });

    let input = r#"
import { Button } from "./ui"

Column {
  Text("Hello")
  Button(text: "Click")
}
    "#;

    // WHEN: Parse document and render the component
    let doc = parse_document(input).unwrap();
    let ir_node = hypen_engine::ir::expand::ast_to_ir_node(&doc.components[0]);
    engine.render_ir_node(&ir_node);

    // THEN: Patches are generated (Create patches for Column, Text, Button)
    let patches = patches.lock().unwrap();
    assert!(
        patches.len() >= 3,
        "Expected at least 3 patches (Column + Text + Button), got {}",
        patches.len()
    );

    // There should be Create patches for each element type
    let creates: Vec<_> = patches
        .iter()
        .filter(|p| matches!(p, hypen_engine::reconcile::Patch::Create { .. }))
        .collect();
    assert!(
        creates.len() >= 3,
        "Expected at least 3 Create patches, got {}",
        creates.len()
    );
}

#[test]
fn test_engine_renders_module_from_document_with_state() {
    // GIVEN: An engine with state and a document with a module
    let mut engine = Engine::new();
    let patches = Arc::new(Mutex::new(Vec::new()));
    let patches_clone = patches.clone();

    engine.set_render_callback(move |p: &[hypen_engine::reconcile::Patch]| {
        patches_clone.lock().unwrap().extend(p.iter().cloned());
    });

    // Set up a module with state
    let module_meta = Module::new("ProfilePage");
    let module = ModuleInstance::new(module_meta, json!({"user": {"name": "Alice"}}));
    engine.set_module(module);

    let input = r#"
import { Avatar } from "./avatar"

Column {
  Text("@{state.user.name}")
}
    "#;

    // WHEN: Parse document and render
    let doc = parse_document(input).unwrap();
    let ir_node = hypen_engine::ir::expand::ast_to_ir_node(&doc.components[0]);
    engine.render_ir_node(&ir_node);

    // THEN: Patches are generated with state bindings resolved
    let patches = patches.lock().unwrap();
    assert!(!patches.is_empty(), "Expected patches to be generated");

    // Binding is resolved into the Create patch props (prop "0" for positional arg)
    let has_alice = patches.iter().any(|p| {
        if let hypen_engine::reconcile::Patch::Create { props, .. } = p {
            props
                .get("0")
                .map(|v| v == &json!("Alice"))
                .unwrap_or(false)
        } else {
            false
        }
    });
    assert!(
        has_alice,
        "Expected a Create patch with prop '0'='Alice' from state binding"
    );
}

#[test]
fn test_engine_re_renders_after_state_update_with_document_source() {
    // GIVEN: An engine with state rendering a component from a document
    let mut engine = Engine::new();
    let patches = Arc::new(Mutex::new(Vec::new()));
    let patches_clone = patches.clone();

    engine.set_render_callback(move |p: &[hypen_engine::reconcile::Patch]| {
        patches_clone.lock().unwrap().extend(p.iter().cloned());
    });

    let module_meta = Module::new("CounterPage");
    let module = ModuleInstance::new(module_meta, json!({"count": 0}));
    engine.set_module(module);

    let input = r#"
import { CounterDisplay } from "./counter"

Column {
  Text("@{state.count}")
}
    "#;

    // Parse and initial render
    let doc = parse_document(input).unwrap();
    let ir_node = hypen_engine::ir::expand::ast_to_ir_node(&doc.components[0]);
    engine.render_ir_node(&ir_node);

    // Clear patches from initial render
    patches.lock().unwrap().clear();

    // WHEN: Update state
    engine.update_state(None, json!({"count": 42}));

    // THEN: Patches reflect the updated state via SetProp
    let patches = patches.lock().unwrap();
    let has_updated_prop = patches.iter().any(|p| match p {
        hypen_engine::reconcile::Patch::SetProp { name, value, .. } => {
            name == "0" && value == &json!(42)
        }
        _ => false,
    });
    assert!(
        has_updated_prop,
        "Expected a SetProp patch with value 42 after state update. Got patches: {:?}",
        *patches
    );
}

// ============================================================================
// E. ImportStatement API Tests (4 tests)
// ============================================================================

#[test]
fn test_import_statement_source_path_local() {
    // GIVEN: A local import
    let import = ImportStatement::new(
        ImportClause::Named(vec!["Button".to_string()]),
        ImportSource::Local("./components/ui".to_string()),
    );

    // THEN: source_path returns the local path
    assert_eq!(import.source_path(), "./components/ui");
}

#[test]
fn test_import_statement_source_path_url() {
    // GIVEN: A URL import
    let import = ImportStatement::new(
        ImportClause::Named(vec!["Widget".to_string()]),
        ImportSource::Url("https://cdn.example.com/widgets".to_string()),
    );

    // THEN: source_path returns the URL
    assert_eq!(import.source_path(), "https://cdn.example.com/widgets");
}

#[test]
fn test_import_statement_imported_names_named() {
    // GIVEN: A named import with multiple names
    let import = ImportStatement::new(
        ImportClause::Named(vec![
            "Button".to_string(),
            "Card".to_string(),
            "Input".to_string(),
        ]),
        ImportSource::Local("./ui".to_string()),
    );

    // THEN: imported_names returns all names
    assert_eq!(import.imported_names(), vec!["Button", "Card", "Input"]);
}

#[test]
fn test_import_statement_imported_names_default() {
    // GIVEN: A default import
    let import = ImportStatement::new(
        ImportClause::Default("HomePage".to_string()),
        ImportSource::Local("./pages/home".to_string()),
    );

    // THEN: imported_names returns single-element vec
    assert_eq!(import.imported_names(), vec!["HomePage"]);
}

// ============================================================================
// F. Document Construction API Tests (3 tests)
// ============================================================================

#[test]
fn test_document_empty() {
    // GIVEN/WHEN: Create an empty document
    let doc = Document::empty();

    // THEN: No imports or components
    assert_eq!(doc.imports.len(), 0);
    assert_eq!(doc.components.len(), 0);
}

#[test]
fn test_document_new_with_imports_and_components() {
    // GIVEN: Imports and a parsed component
    let imports = vec![ImportStatement::new(
        ImportClause::Named(vec!["Button".to_string()]),
        ImportSource::Local("./ui".to_string()),
    )];

    let component_input = r#"Column { Text("Hello") }"#;
    let component = hypen_parser::parse_component(component_input).unwrap();

    // WHEN: Create a document
    let doc = Document::new(imports, vec![component]);

    // THEN: Document contains the import and component
    assert_eq!(doc.imports.len(), 1);
    assert_eq!(doc.components.len(), 1);
    assert_eq!(doc.imports[0].source_path(), "./ui");
    assert_eq!(doc.components[0].name, "Column");
}

#[test]
fn test_document_parsed_twice_has_same_structure() {
    // GIVEN: Two documents parsed from the same input
    let input = r#"
import { Button } from "./ui"

Text("Hello")
    "#;

    let doc1 = parse_document(input).unwrap();
    let doc2 = parse_document(input).unwrap();

    // THEN: Both have the same imports and component structure
    assert_eq!(doc1.imports.len(), doc2.imports.len());
    assert_eq!(doc1.imports[0].clause, doc2.imports[0].clause);
    assert_eq!(doc1.imports[0].source, doc2.imports[0].source);
    assert_eq!(doc1.components.len(), doc2.components.len());
    assert_eq!(doc1.components[0].name, doc2.components[0].name);
}

// ============================================================================
// G. Edge Cases (4 tests)
// ============================================================================

#[test]
fn test_parse_import_with_relative_parent_path() {
    // GIVEN: Import with parent directory traversal
    let input = r#"import { SharedButton } from "../shared/ui""#;

    // WHEN: Parse the import
    let import = parse_import(input).unwrap();

    // THEN: Path is preserved as-is
    assert_eq!(import.source_path(), "../shared/ui");
    assert!(matches!(import.source, ImportSource::Local(_)));
}

#[test]
fn test_parse_import_with_deep_local_path() {
    // GIVEN: Import with deeply nested local path
    let input = r#"import { Widget } from "./components/design-system/atoms/widget""#;

    // WHEN: Parse the import
    let import = parse_import(input).unwrap();

    // THEN: Full path is preserved
    assert_eq!(
        import.source_path(),
        "./components/design-system/atoms/widget"
    );
}

#[test]
fn test_document_preserves_import_order() {
    // GIVEN: Document with multiple imports in specific order
    let input = r#"
import { A } from "./first"
import { B } from "./second"
import { C } from "./third"

Text("test")
    "#;

    // WHEN: Parse the document
    let doc = parse_document(input).unwrap();

    // THEN: Import order is preserved
    assert_eq!(doc.imports.len(), 3);
    assert_eq!(doc.imports[0].source_path(), "./first");
    assert_eq!(doc.imports[1].source_path(), "./second");
    assert_eq!(doc.imports[2].source_path(), "./third");
}

#[test]
fn test_document_with_single_named_import() {
    // GIVEN: Named import with only one name (could be confused with default)
    let input = r#"import { Button } from "./ui""#;

    // WHEN: Parse as document
    let doc = parse_document(input).unwrap();

    // THEN: It's a Named import, not Default
    assert_eq!(doc.imports.len(), 1);
    assert!(matches!(doc.imports[0].clause, ImportClause::Named(_)));
    assert_eq!(doc.imports[0].imported_names(), vec!["Button"]);
}
