use crate::ast::*;
use crate::parser::*;

#[test]
fn test_simple_component() {
    let input = "Text(\"Hello World\")";
    let result = parse_component(input);
    assert!(result.is_ok());

    let component = result.unwrap();
    assert_eq!(component.name, "Text");
    assert_eq!(component.arguments.arguments.len(), 1);
}

#[test]
fn test_component_without_arguments() {
    let input = "Column";
    let result = parse_component(input);
    assert!(result.is_ok());

    let component = result.unwrap();
    assert_eq!(component.name, "Column");
    assert_eq!(component.arguments.arguments.len(), 0);
}

#[test]
fn test_component_with_named_arguments() {
    let input = r#"Text(text: "Hello", color: red)"#;
    let result = parse_component(input);
    assert!(result.is_ok());

    let component = result.unwrap();
    assert_eq!(component.name, "Text");
    assert_eq!(component.arguments.arguments.len(), 2);

    // Check named arguments
    let text_arg = component.arguments.get_named("text");
    assert!(text_arg.is_some());
}

#[test]
fn test_component_with_children() {
    let input = r#"
        Column {
            Text("First line")
            Text("Second line")
        }
    "#;
    let result = parse_component(input);
    assert!(result.is_ok());

    let component = result.unwrap();
    assert_eq!(component.name, "Column");
    assert_eq!(component.children.len(), 2);
    assert_eq!(component.children[0].name, "Text");
    assert_eq!(component.children[1].name, "Text");
}

#[test]
fn test_component_with_applicators() {
    let input = r#"
        Text("Styled text")
            .backgroundColor(blue)
            .padding(16)
    "#;
    let result = parse_component(input);
    assert!(result.is_ok());

    let component = result.unwrap();
    assert_eq!(component.name, "Text");
    assert_eq!(component.applicators.len(), 2);
    assert_eq!(component.applicators[0].name, "backgroundColor");
    assert_eq!(component.applicators[1].name, "padding");
}

#[test]
fn test_nested_components() {
    let input = r#"
        Column {
            Row {
                Text("Left")
                Text("Right")
            }
            Text("Bottom")
        }
    "#;
    let result = parse_component(input);
    assert!(result.is_ok());

    let component = result.unwrap();
    assert_eq!(component.name, "Column");
    assert_eq!(component.children.len(), 2);

    // First child is Row with 2 Text children
    let row = &component.children[0];
    assert_eq!(row.name, "Row");
    assert_eq!(row.children.len(), 2);

    // Second child is Text
    assert_eq!(component.children[1].name, "Text");
}

#[test]
fn test_boolean_values() {
    let input = "Component(enabled: true, disabled: false)";
    let result = parse_component(input);
    assert!(result.is_ok());

    let component = result.unwrap();
    let enabled = component.arguments.get_named("enabled");
    let disabled = component.arguments.get_named("disabled");

    assert!(matches!(enabled, Some(Value::Boolean(true))));
    assert!(matches!(disabled, Some(Value::Boolean(false))));
}

#[test]
fn test_number_values() {
    let input = "Component(width: 100, height: 50.5)";
    let result = parse_component(input);
    assert!(result.is_ok());

    let component = result.unwrap();
    let width = component.arguments.get_named("width");
    let height = component.arguments.get_named("height");

    assert!(matches!(width, Some(Value::Number(100.0))));
    assert!(matches!(height, Some(Value::Number(50.5))));
}

#[test]
fn test_reference_values() {
    let input = "Text(@state.username)";
    let result = parse_component(input);
    assert!(result.is_ok());

    let component = result.unwrap();
    if let Some(Argument::Positioned { value, .. }) = component.arguments.arguments.first() {
        assert!(matches!(value, Value::Reference(_)));
    } else {
        panic!("Expected positional argument with reference");
    }
}

#[test]
fn test_resource_reference() {
    let input = "Icon(@resources.heart)";
    let result = parse_component(input);
    assert!(result.is_ok());

    let component = result.unwrap();
    assert_eq!(component.name, "Icon");
    if let Some(Argument::Positioned { value, .. }) = component.arguments.arguments.first() {
        match value {
            Value::Reference(r) => assert_eq!(r, "resources.heart"),
            _ => panic!("Expected Reference, got {:?}", value),
        }
    } else {
        panic!("Expected positional argument with reference");
    }
}

#[test]
fn test_resource_reference_hyphenated() {
    let input = "Icon(@resources.plus-square)";
    let result = parse_component(input);
    assert!(result.is_ok());

    let component = result.unwrap();
    if let Some(Argument::Positioned { value, .. }) = component.arguments.arguments.first() {
        match value {
            Value::Reference(r) => assert_eq!(r, "resources.plus-square"),
            _ => panic!("Expected Reference, got {:?}", value),
        }
    } else {
        panic!("Expected positional argument with reference");
    }
}

#[test]
fn test_list_values() {
    let input = r#"Component(items: [1, 2, 3])"#;
    let result = parse_component(input);
    assert!(result.is_ok());

    let component = result.unwrap();
    let items = component.arguments.get_named("items");

    assert!(matches!(items, Some(Value::List(_))));
}

#[test]
fn test_map_values() {
    let input = r#"Component(config: {width: 100, height: 200})"#;
    let result = parse_component(input);
    assert!(result.is_ok());

    let component = result.unwrap();
    let config = component.arguments.get_named("config");

    assert!(matches!(config, Some(Value::Map(_))));
}

#[test]
fn test_multiple_components() {
    let input = r#"
        Text("First")
        Text("Second")
        Text("Third")
    "#;
    let result = parse_components(input);
    assert!(result.is_ok());

    let components = result.unwrap();
    assert_eq!(components.len(), 3);
}

#[test]
fn test_complex_example() {
    let input = r#"
        Column {
            Text("Welcome, @state.username")
                .fontSize(18)
                .color(blue)

            Button("@actions.signIn") {
                Text("Sign In")
            }
            .padding(16)

            Row {
                Image(src: "logo.png")
                    .width(50)
                    .height(50)

                Text("Logo")
            }
        }
        .backgroundColor(white)
    "#;

    let result = parse_component(input);
    assert!(result.is_ok());

    let component = result.unwrap();
    assert_eq!(component.name, "Column");
    assert_eq!(component.applicators.len(), 1);
    assert_eq!(component.applicators[0].name, "backgroundColor");
    assert_eq!(component.children.len(), 3);
}

#[test]
fn test_empty_component() {
    let input = "Component()";
    let result = parse_component(input);
    assert!(result.is_ok());

    let component = result.unwrap();
    assert_eq!(component.name, "Component");
    assert_eq!(component.arguments.arguments.len(), 0);
}

#[test]
fn test_whitespace_handling() {
    let input = "   Text   (  \"Hello\"  )   ";
    let result = parse_component(input);
    assert!(result.is_ok());

    let component = result.unwrap();
    assert_eq!(component.name, "Text");
}

#[test]
fn test_empty_input() {
    let input = "";
    let result = parse_component(input);
    assert!(result.is_err());
}

#[test]
fn test_empty_components_list() {
    let input = "";
    let result = parse_components(input);
    // Empty input should fail or return empty list
    assert!(result.is_err() || result.unwrap().is_empty());
}

#[test]
fn test_component_without_parens() {
    let input = "Column";
    let result = parse_component(input);
    assert!(result.is_ok());

    let component = result.unwrap();
    assert_eq!(component.name, "Column");
    assert!(component.arguments.arguments.is_empty());
}

#[test]
fn test_component_with_empty_parens() {
    let input = "Column()";
    let result = parse_component(input);
    assert!(result.is_ok());

    let component = result.unwrap();
    assert_eq!(component.name, "Column");
    assert!(component.arguments.arguments.is_empty());
}

#[test]
fn test_special_chars_in_strings() {
    let input = r#"Text("Hello, World!")"#;
    let result = parse_component(input);
    assert!(result.is_ok());

    let component = result.unwrap();
    assert_eq!(component.name, "Text");
}

#[test]
fn test_nested_maps() {
    let input = r#"Component(config: {outer: {inner: value}})"#;
    let result = parse_component(input);
    assert!(result.is_ok());

    let component = result.unwrap();
    assert_eq!(component.name, "Component");

    let config = component.arguments.get_named("config");
    assert!(matches!(config, Some(Value::Map(_))));
}

#[test]
fn test_nested_lists() {
    let input = r#"Component(items: [[1, 2], [3, 4]])"#;
    let result = parse_component(input);
    assert!(result.is_ok());

    let component = result.unwrap();
    let items = component.arguments.get_named("items");
    assert!(matches!(items, Some(Value::List(_))));
}

#[test]
fn test_mixed_arguments() {
    let input = r#"Component(first, key: "value", 123, enabled: true)"#;
    let result = parse_component(input);
    assert!(result.is_ok());

    let component = result.unwrap();
    assert_eq!(component.arguments.arguments.len(), 4);

    // First is positional
    assert!(matches!(
        component.arguments.arguments[0],
        Argument::Positioned { .. }
    ));

    // Second is named
    assert!(matches!(
        component.arguments.arguments[1],
        Argument::Named { .. }
    ));
}

#[test]
fn test_deeply_nested_components() {
    let input = r#"
        A {
            B {
                C {
                    D {
                        E {
                            Text("Deep")
                        }
                    }
                }
            }
        }
    "#;
    let result = parse_component(input);
    assert!(result.is_ok());

    let component = result.unwrap();
    assert_eq!(component.name, "A");

    // Check that we can navigate to the deepest component
    let flattened = component.flatten();
    assert!(flattened.len() >= 6);
}

#[test]
fn test_component_with_block_and_applicators() {
    let input = r#"
        Column {
            Text("Child")
        }
        .padding(16)
        .backgroundColor(blue)
    "#;
    let result = parse_component(input);
    assert!(result.is_ok());

    let component = result.unwrap();
    assert_eq!(component.name, "Column");
    assert_eq!(component.children.len(), 1);
    assert_eq!(component.applicators.len(), 2);
}

#[test]
fn test_multiple_siblings() {
    let input = r#"
        Column {
            Text("First")
            Text("Second")
            Text("Third")
            Text("Fourth")
        }
    "#;
    let result = parse_component(input);
    assert!(result.is_ok());

    let component = result.unwrap();
    assert_eq!(component.children.len(), 4);
}

#[test]
fn test_components_with_and_without_args() {
    let input = r#"
        Column {
            Text("With args")
            Spacer
            Text("More args")
        }
    "#;
    let result = parse_component(input);
    assert!(result.is_ok());

    let component = result.unwrap();
    assert_eq!(component.children.len(), 3);
    assert_eq!(component.children[1].name, "Spacer");
    assert!(component.children[1].arguments.arguments.is_empty());
}

#[test]
fn test_error_unclosed_brace() {
    let input = r#"
        Column {
            Text("Hello")
    "#;
    let result = parse_component(input);
    assert!(result.is_err());
}

#[test]
fn test_error_unclosed_paren() {
    let input = r#"Text("Hello""#;
    let result = parse_component(input);
    assert!(result.is_err());
}

#[test]
fn test_error_invalid_syntax() {
    let input = "Text(((";
    let result = parse_component(input);
    assert!(result.is_err());
}

#[test]
fn test_list_with_mixed_types() {
    let input = r#"Component(items: [1, "text", true, {key: value}])"#;
    let result = parse_component(input);
    assert!(result.is_ok());

    let component = result.unwrap();
    let items = component.arguments.get_named("items");
    assert!(matches!(items, Some(Value::List(_))));

    if let Some(Value::List(list)) = items {
        assert_eq!(list.len(), 4);
    }
}

#[test]
fn test_trailing_commas() {
    let input = r#"Component(a: 1, b: 2,)"#;
    let result = parse_component(input);
    assert!(result.is_ok());

    let component = result.unwrap();
    assert_eq!(component.arguments.arguments.len(), 2);
}

#[test]
fn test_list_trailing_comma() {
    let input = r#"Component(items: [1, 2, 3,])"#;
    let result = parse_component(input);
    assert!(result.is_ok());
}

#[test]
fn test_map_trailing_comma() {
    let input = r#"Component(config: {a: 1, b: 2,})"#;
    let result = parse_component(input);
    assert!(result.is_ok());
}

#[test]
fn test_component_name_case_sensitivity() {
    let inputs = vec!["Text", "text", "TEXT", "MyComponent", "my_component"];

    for name in inputs {
        let input = format!("{}(\"test\")", name);
        let result = parse_component(&input);
        assert!(result.is_ok(), "Failed to parse: {}", name);
        assert_eq!(result.unwrap().name, name);
    }
}

// Note: Applicators with children blocks is an advanced feature
// that may not be supported in the initial implementation
#[test]
#[ignore]
fn test_applicators_with_children() {
    let input = r#"
        Container
            .modifier {
                Text("Inside modifier")
            }
    "#;
    let result = parse_component(input);
    assert!(result.is_ok());

    let component = result.unwrap();
    assert_eq!(component.name, "Container");
    assert_eq!(component.applicators.len(), 1);
    assert_eq!(component.applicators[0].name, "modifier");
    assert_eq!(component.applicators[0].children.len(), 1);
}

#[test]
fn test_module_declaration() {
    let input = r#"
        module ProfilePage(userId: 123) {
            Column {
                Text("User Profile")
            }
        }
    "#;
    let result = parse_component(input);
    assert!(result.is_ok());

    let component = result.unwrap();
    assert_eq!(component.name, "ProfilePage");
    assert_eq!(component.declaration_type, DeclarationType::Module);
    assert_eq!(component.arguments.arguments.len(), 1);
    assert_eq!(component.children.len(), 1);
}

#[test]
fn test_component_declaration() {
    let input = r#"
        component Button(text: "Click Me") {
            Text(@state.text)
        }
    "#;
    let result = parse_component(input);
    assert!(result.is_ok());

    let component = result.unwrap();
    assert_eq!(component.name, "Button");
    assert_eq!(
        component.declaration_type,
        DeclarationType::ComponentKeyword
    );
    assert_eq!(component.children.len(), 1);
}

#[test]
fn test_regular_component_no_keyword() {
    let input = r#"Text("Hello")"#;
    let result = parse_component(input);
    assert!(result.is_ok());

    let component = result.unwrap();
    assert_eq!(component.name, "Text");
    assert_eq!(component.declaration_type, DeclarationType::Component);
}

#[test]
fn test_module_without_args() {
    let input = r#"
        module HomePage {
            Text("Welcome")
        }
    "#;
    let result = parse_component(input);
    assert!(result.is_ok());

    let component = result.unwrap();
    assert_eq!(component.name, "HomePage");
    assert_eq!(component.declaration_type, DeclarationType::Module);
}

#[test]
fn test_component_without_block() {
    let input = r#"component Divider"#;
    let result = parse_component(input);
    assert!(result.is_ok());

    let component = result.unwrap();
    assert_eq!(component.name, "Divider");
    assert_eq!(
        component.declaration_type,
        DeclarationType::ComponentKeyword
    );
}

#[test]
fn test_nested_module_and_components() {
    let input = r#"
        module App {
            component Header {
                Text("App Title")
            }
            Column {
                Text("Content")
            }
        }
    "#;
    let result = parse_component(input);
    assert!(result.is_ok());

    let component = result.unwrap();
    assert_eq!(component.declaration_type, DeclarationType::Module);
    assert_eq!(component.children.len(), 2);
    assert_eq!(
        component.children[0].declaration_type,
        DeclarationType::ComponentKeyword
    );
    assert_eq!(
        component.children[1].declaration_type,
        DeclarationType::Component
    );
}

#[test]
fn test_named_import() {
    let input = r#"import { Button, Card } from "./components/ui""#;
    let result = parse_import(input);
    assert!(result.is_ok());

    let import = result.unwrap();
    let names = import.imported_names();
    assert_eq!(names.len(), 2);
    assert!(names.contains(&"Button".to_string()));
    assert!(names.contains(&"Card".to_string()));
    assert_eq!(import.source_path(), "./components/ui");
    assert!(matches!(import.source, ImportSource::Local(_)));
}

#[test]
fn test_default_import() {
    let input = r#"import HomePage from "./pages/HomePage""#;
    let result = parse_import(input);
    assert!(result.is_ok());

    let import = result.unwrap();
    assert!(matches!(import.clause, ImportClause::Default(_)));
    let names = import.imported_names();
    assert_eq!(names.len(), 1);
    assert_eq!(names[0], "HomePage");
    assert_eq!(import.source_path(), "./pages/HomePage");
}

#[test]
fn test_url_import() {
    let input = r#"import { Header, Footer } from "https://cdn.example.com/ui""#;
    let result = parse_import(input);
    assert!(result.is_ok());

    let import = result.unwrap();
    assert!(matches!(import.source, ImportSource::Url(_)));
    assert_eq!(import.source_path(), "https://cdn.example.com/ui");
}

#[test]
fn test_document_with_imports() {
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

    let result = parse_document(input);
    assert!(result.is_ok());

    let doc = result.unwrap();
    assert_eq!(doc.imports.len(), 2);
    assert_eq!(doc.components.len(), 1);
    assert_eq!(doc.components[0].name, "App");
    assert_eq!(doc.components[0].declaration_type, DeclarationType::Module);
}

#[test]
fn test_document_without_imports() {
    let input = r#"
module App() {
  Text("No imports")
}
    "#;

    let result = parse_document(input);
    assert!(result.is_ok());

    let doc = result.unwrap();
    assert_eq!(doc.imports.len(), 0);
    assert_eq!(doc.components.len(), 1);
}

#[test]
fn test_document_only_imports() {
    let input = r#"
import { Button } from "./ui"
import Card from "./components"
    "#;

    let result = parse_document(input);
    assert!(result.is_ok());

    let doc = result.unwrap();
    assert_eq!(doc.imports.len(), 2);
    assert_eq!(doc.components.len(), 0);
}

#[test]
fn test_multiple_named_imports() {
    let input = r#"import { A, B, C, D, E } from "./components""#;
    let result = parse_import(input);
    assert!(result.is_ok());

    let import = result.unwrap();
    let names = import.imported_names();
    assert_eq!(names.len(), 5);
}

#[test]
fn test_import_trailing_comma() {
    let input = r#"import { Button, Card, } from "./ui""#;
    let result = parse_import(input);
    assert!(result.is_ok());

    let import = result.unwrap();
    assert_eq!(import.imported_names().len(), 2);
}

// ============================================================================
// Comment Parsing Tests
// ============================================================================

#[test]
fn test_line_comment_before_component() {
    let input = r#"
        // This is a comment
        Text("Hello")
    "#;
    let result = parse_component(input);
    assert!(result.is_ok());

    let component = result.unwrap();
    assert_eq!(component.name, "Text");
}

#[test]
fn test_line_comment_after_component() {
    let input = r#"
        Text("Hello")
        // This is a comment
    "#;
    let result = parse_component(input);
    assert!(result.is_ok());

    let component = result.unwrap();
    assert_eq!(component.name, "Text");
}

#[test]
fn test_block_comment_before_component() {
    let input = r#"
        /* This is a block comment */
        Text("Hello")
    "#;
    let result = parse_component(input);
    assert!(result.is_ok());

    let component = result.unwrap();
    assert_eq!(component.name, "Text");
}

#[test]
fn test_block_comment_after_component() {
    let input = r#"
        Text("Hello")
        /* This is a block comment */
    "#;
    let result = parse_component(input);
    assert!(result.is_ok());

    let component = result.unwrap();
    assert_eq!(component.name, "Text");
}

#[test]
fn test_multiline_block_comment() {
    let input = r#"
        /*
         * This is a multiline
         * block comment
         */
        Text("Hello")
    "#;
    let result = parse_component(input);
    assert!(result.is_ok());

    let component = result.unwrap();
    assert_eq!(component.name, "Text");
}

#[test]
fn test_comment_between_components() {
    let input = r#"
        Column {
            Text("First")
            // Comment between children
            Text("Second")
        }
    "#;
    let result = parse_component(input);
    assert!(result.is_ok());

    let component = result.unwrap();
    assert_eq!(component.children.len(), 2);
}

#[test]
fn test_block_comment_between_components() {
    let input = r#"
        Column {
            Text("First")
            /* Comment between children */
            Text("Second")
        }
    "#;
    let result = parse_component(input);
    assert!(result.is_ok());

    let component = result.unwrap();
    assert_eq!(component.children.len(), 2);
}

#[test]
fn test_comment_in_arguments() {
    let input = r#"
        Text(
            // This is the text argument
            "Hello",
            // This is the color argument
            color: blue
        )
    "#;
    let result = parse_component(input);
    assert!(result.is_ok());

    let component = result.unwrap();
    assert_eq!(component.arguments.arguments.len(), 2);
}

#[test]
fn test_block_comment_in_arguments() {
    let input = r#"
        Text(
            /* text */ "Hello",
            /* color */ color: blue
        )
    "#;
    let result = parse_component(input);
    assert!(result.is_ok());

    let component = result.unwrap();
    assert_eq!(component.arguments.arguments.len(), 2);
}

#[test]
fn test_comment_between_applicators() {
    let input = r#"
        Text("Styled text")
            .backgroundColor(blue)
            // Add padding
            .padding(16)
    "#;
    let result = parse_component(input);
    assert!(result.is_ok());

    let component = result.unwrap();
    assert_eq!(component.applicators.len(), 2);
}

#[test]
fn test_block_comment_between_applicators() {
    let input = r#"
        Text("Styled text")
            .backgroundColor(blue)
            /* Add padding */
            .padding(16)
    "#;
    let result = parse_component(input);
    assert!(result.is_ok());

    let component = result.unwrap();
    assert_eq!(component.applicators.len(), 2);
}

#[test]
fn test_comment_in_list() {
    let input = r#"
        Component(items: [
            1,
            // Comment in list
            2,
            3
        ])
    "#;
    let result = parse_component(input);
    assert!(result.is_ok());

    let component = result.unwrap();
    let items = component.arguments.get_named("items");
    assert!(matches!(items, Some(Value::List(_))));

    if let Some(Value::List(list)) = items {
        assert_eq!(list.len(), 3);
    }
}

#[test]
fn test_comment_in_map() {
    let input = r#"
        Component(config: {
            // Width setting
            width: 100,
            /* Height setting */
            height: 200
        })
    "#;
    let result = parse_component(input);
    assert!(result.is_ok());

    let component = result.unwrap();
    let config = component.arguments.get_named("config");
    assert!(matches!(config, Some(Value::Map(_))));
}

#[test]
fn test_comment_after_declaration_keyword() {
    let input = r#"
        module /* module name */ ProfilePage {
            Text("Profile")
        }
    "#;
    let result = parse_component(input);
    assert!(result.is_ok());

    let component = result.unwrap();
    assert_eq!(component.name, "ProfilePage");
    assert_eq!(component.declaration_type, DeclarationType::Module);
}

#[test]
fn test_comment_in_import() {
    let input = r#"
        // Import UI components
        import { Button, Card } from "./ui"
    "#;
    let result = parse_import(input);
    assert!(result.is_ok());

    let import = result.unwrap();
    assert_eq!(import.imported_names().len(), 2);
}

#[test]
fn test_comment_in_import_list() {
    let input = r#"
        import {
            // Button component
            Button,
            /* Card component */
            Card
        } from "./ui"
    "#;
    let result = parse_import(input);
    assert!(result.is_ok());

    let import = result.unwrap();
    assert_eq!(import.imported_names().len(), 2);
}

#[test]
fn test_comment_between_import_and_from() {
    let input = r#"import { Button } /* from the ui module */ from "./ui""#;
    let result = parse_import(input);
    assert!(result.is_ok());
}

#[test]
fn test_document_with_comments() {
    let input = r#"
        // Import statements
        import { Button } from "./ui"

        /* Main application module */
        module App {
            // Welcome text
            Text("Hello")
        }
    "#;

    let result = parse_document(input);
    assert!(result.is_ok());

    let doc = result.unwrap();
    assert_eq!(doc.imports.len(), 1);
    assert_eq!(doc.components.len(), 1);
}

#[test]
fn test_multiple_comments_in_sequence() {
    let input = r#"
        // First comment
        // Second comment
        /* Block comment */
        // Third comment
        Text("Hello")
    "#;
    let result = parse_component(input);
    assert!(result.is_ok());

    let component = result.unwrap();
    assert_eq!(component.name, "Text");
}

#[test]
fn test_comment_with_special_chars() {
    let input = r#"
        // Comment with special chars: !@#$%^&*()
        Text("Hello")
    "#;
    let result = parse_component(input);
    assert!(result.is_ok());
}

#[test]
fn test_block_comment_with_stars() {
    let input = r#"
        /***
         *** Fancy comment
         ***/
        Text("Hello")
    "#;
    let result = parse_component(input);
    assert!(result.is_ok());
}

#[test]
fn test_inline_comment_style() {
    let input = r#"Text("Hello") // inline comment"#;
    let result = parse_component(input);
    assert!(result.is_ok());

    let component = result.unwrap();
    assert_eq!(component.name, "Text");
}

#[test]
fn test_complex_example_with_comments() {
    let input = r#"
        // Main application layout
        Column {
            /* Header section */
            Text("Welcome")
                .fontSize(24)  // Large font
                .color(blue)   // Blue color

            // Content section
            Row {
                // Left side
                Text("Left")
                // Right side
                Text("Right")
            }
            .padding(16) /* Add padding around row */
        }
        .backgroundColor(white) // White background
    "#;

    let result = parse_component(input);
    assert!(result.is_ok());

    let component = result.unwrap();
    assert_eq!(component.name, "Column");
    assert_eq!(component.children.len(), 2);
    assert_eq!(component.applicators.len(), 1);
}

#[test]
fn test_comment_inside_string_not_parsed_as_comment() {
    // Comments inside strings should be treated as string content, not comments
    let input = r#"Text("// this is not a comment")"#;
    let result = parse_component(input);
    assert!(result.is_ok());

    let component = result.unwrap();
    if let Some(Argument::Positioned { value, .. }) = component.arguments.arguments.first() {
        // The string parser includes quotes in the stored value via to_slice()
        assert!(matches!(value, Value::String(s) if s.contains("// this is not a comment")));
    } else {
        panic!("Expected positional string argument");
    }
}

#[test]
fn test_block_comment_inside_string_not_parsed_as_comment() {
    let input = r#"Text("/* not a comment */")"#;
    let result = parse_component(input);
    assert!(result.is_ok());

    let component = result.unwrap();
    if let Some(Argument::Positioned { value, .. }) = component.arguments.arguments.first() {
        // The string parser includes quotes in the stored value via to_slice()
        assert!(matches!(value, Value::String(s) if s.contains("/* not a comment */")));
    } else {
        panic!("Expected positional string argument");
    }
}

#[test]
fn test_unclosed_block_comment_error() {
    let input = r#"/* unclosed comment Text("Hello")"#;
    let result = parse_component(input);
    assert!(result.is_err());
}

#[test]
fn test_empty_line_comment() {
    let input = r#"
        //
        Text("Hello")
    "#;
    let result = parse_component(input);
    assert!(result.is_ok());
}

#[test]
fn test_empty_block_comment() {
    let input = r#"
        /**/
        Text("Hello")
    "#;
    let result = parse_component(input);
    assert!(result.is_ok());
}

#[test]
fn test_empty_braces_with_applicators() {
    let input = r#"Column { }.padding(16)"#;
    let result = parse_component(input);
    println!("Result: {:?}", result);
    assert!(
        result.is_ok(),
        "Should parse empty braces with applicators: {:?}",
        result
    );

    let component = result.unwrap();
    assert_eq!(component.name, "Column");
    assert!(component.children.is_empty());
    assert_eq!(component.applicators.len(), 1);
    assert_eq!(component.applicators[0].name, "padding");
}

#[test]
fn test_empty_braces_with_custom_applicator_and_identifier_arg() {
    let input = r#"Column { }.test(something)"#;
    let result = parse_component(input);
    assert!(
        result.is_ok(),
        "Should parse empty braces with .test(something): {:?}",
        result
    );

    let component = result.unwrap();
    assert_eq!(component.name, "Column");
    assert!(component.children.is_empty());

    assert_eq!(component.applicators.len(), 1);
    assert_eq!(component.applicators[0].name, "test");

    // `something` is parsed as a bare identifier value, which maps to Value::String("something")
    assert_eq!(
        component.applicators[0].arguments.get_positioned(0),
        Some(&Value::String("something".to_string()))
    );
}

#[test]
fn test_empty_braces_no_applicators() {
    let input = r#"Column { }"#;
    let result = parse_component(input);
    println!("Result: {:?}", result);
    assert!(result.is_ok(), "Should parse empty braces: {:?}", result);

    let component = result.unwrap();
    assert_eq!(component.name, "Column");
    assert!(component.children.is_empty());
}

// ============================================================================
// Responsive Value Map Tests (Breakpoint DX)
// ============================================================================

#[test]
fn test_breakpoint_value_map_simple() {
    // Test: .fontSize({default: 16, md: 18, lg: 24})
    let input = r#"Text("Hello").fontSize({default: 16, md: 18, lg: 24})"#;
    let result = parse_component(input);
    assert!(
        result.is_ok(),
        "Should parse breakpoint value map: {:?}",
        result
    );

    let component = result.unwrap();
    assert_eq!(component.applicators.len(), 1);
    assert_eq!(component.applicators[0].name, "fontSize");

    let arg = component.applicators[0].arguments.get_positioned(0);
    match arg {
        Some(Value::Map(map)) => {
            assert_eq!(map.get("default"), Some(&Value::Number(16.0)));
            assert_eq!(map.get("md"), Some(&Value::Number(18.0)));
            assert_eq!(map.get("lg"), Some(&Value::Number(24.0)));
        }
        _ => panic!("Expected Map value, got: {:?}", arg),
    }
}

#[test]
fn test_breakpoint_value_map_multiple_applicators() {
    // Test multiple applicators with breakpoint maps
    let input = r#"Text("Hello").fontSize({default: 16, md: 18}).padding({default: 8, lg: 32})"#;
    let result = parse_component(input);
    assert!(
        result.is_ok(),
        "Should parse multiple breakpoint maps: {:?}",
        result
    );

    let component = result.unwrap();
    assert_eq!(component.applicators.len(), 2);
    assert_eq!(component.applicators[0].name, "fontSize");
    assert_eq!(component.applicators[1].name, "padding");

    // Both should have map values
    assert!(matches!(
        component.applicators[0].arguments.get_positioned(0),
        Some(Value::Map(_))
    ));
    assert!(matches!(
        component.applicators[1].arguments.get_positioned(0),
        Some(Value::Map(_))
    ));
}

#[test]
fn test_breakpoint_value_map_with_strings() {
    // Test breakpoint map with string values (e.g., colors)
    let input = r#"Text("Hello").color({default: "black", dark: "white"})"#;
    let result = parse_component(input);
    assert!(
        result.is_ok(),
        "Should parse breakpoint map with strings: {:?}",
        result
    );

    let component = result.unwrap();
    let arg = component.applicators[0].arguments.get_positioned(0);
    match arg {
        Some(Value::Map(map)) => {
            // Parser keeps quotes in string values
            assert_eq!(
                map.get("default"),
                Some(&Value::String("\"black\"".to_string()))
            );
            assert_eq!(
                map.get("dark"),
                Some(&Value::String("\"white\"".to_string()))
            );
        }
        _ => panic!("Expected Map value, got: {:?}", arg),
    }
}

// ============================================================================
// Tailwind .tw() Applicator Tests
// ============================================================================

#[test]
fn test_tw_applicator_simple() {
    // Test: .tw("p-4 text-blue-500")
    let input = r#"Text("Hello").tw("p-4 text-blue-500")"#;
    let result = parse_component(input);
    assert!(
        result.is_ok(),
        "Should parse .tw() applicator: {:?}",
        result
    );

    let component = result.unwrap();
    assert_eq!(component.applicators.len(), 1);
    assert_eq!(component.applicators[0].name, "tw");

    let arg = component.applicators[0].arguments.get_positioned(0);
    // Parser keeps quotes in string values
    assert_eq!(
        arg,
        Some(&Value::String("\"p-4 text-blue-500\"".to_string()))
    );
}

#[test]
fn test_tw_applicator_with_responsive_classes() {
    // Test Tailwind responsive variants in .tw()
    let input = r#"Text("Hello").tw("p-2 md:p-4 lg:p-8 hover:bg-blue-500")"#;
    let result = parse_component(input);
    assert!(
        result.is_ok(),
        "Should parse .tw() with responsive classes: {:?}",
        result
    );

    let component = result.unwrap();
    let arg = component.applicators[0].arguments.get_positioned(0);
    // Parser keeps quotes in string values
    assert_eq!(
        arg,
        Some(&Value::String(
            "\"p-2 md:p-4 lg:p-8 hover:bg-blue-500\"".to_string()
        ))
    );
}

#[test]
fn test_tw_applicator_combined_with_regular_applicators() {
    // Test combining .tw() with regular applicators
    let input = r#"Text("Hello").tw("p-4 rounded-lg").fontSize(18).onClick("@actions.click")"#;
    let result = parse_component(input);
    assert!(
        result.is_ok(),
        "Should parse .tw() combined with applicators: {:?}",
        result
    );

    let component = result.unwrap();
    assert_eq!(component.applicators.len(), 3);
    assert_eq!(component.applicators[0].name, "tw");
    assert_eq!(component.applicators[1].name, "fontSize");
    assert_eq!(component.applicators[2].name, "onClick");
}

#[test]
fn test_tw_and_breakpoint_maps_combined() {
    // Test combining .tw() with breakpoint value maps
    let input = r#"Text("Hello").tw("rounded-lg shadow").fontSize({default: 16, md: 20})"#;
    let result = parse_component(input);
    assert!(
        result.is_ok(),
        "Should parse .tw() with breakpoint maps: {:?}",
        result
    );

    let component = result.unwrap();
    assert_eq!(component.applicators.len(), 2);
    assert_eq!(component.applicators[0].name, "tw");
    assert_eq!(component.applicators[1].name, "fontSize");

    // First should be string, second should be map
    assert!(matches!(
        component.applicators[0].arguments.get_positioned(0),
        Some(Value::String(_))
    ));
    assert!(matches!(
        component.applicators[1].arguments.get_positioned(0),
        Some(Value::Map(_))
    ));
}

#[test]
fn test_single_quoted_strings() {
    // Single-quoted strings allow embedding double quotes
    let input = r#"Text('hello "world"')"#;
    let result = parse_component(input);
    assert!(result.is_ok(), "Single-quoted strings should parse");
    let comp = result.unwrap();
    assert_eq!(comp.arguments.arguments.len(), 1);
    match comp.arguments.get_positioned(0) {
        Some(Value::String(s)) => assert_eq!(s, r#"'hello "world"'"#),
        other => panic!("Expected string, got {:?}", other),
    }
}

#[test]
fn test_escaped_quotes_in_strings() {
    // Escaped quotes inside double-quoted strings
    let input = r#"Text("hello \"world\"")"#;
    let result = parse_component(input);
    assert!(result.is_ok(), "Escaped quotes should parse");
    let comp = result.unwrap();
    assert_eq!(comp.arguments.arguments.len(), 1);
    match comp.arguments.get_positioned(0) {
        Some(Value::String(s)) => assert_eq!(s, r#""hello \"world\"""#),
        other => panic!("Expected string, got {:?}", other),
    }
}

#[test]
fn test_single_quotes_with_interpolation_and_nested_doubles() {
    // Real-world use case: ternary with double quotes inside single-quoted string
    let input = r##"Row {
        Text("hello")
    }
    .background('@{item.role === "user" ? "#007bff" : "#333"}')
    "##;
    let result = parse_component(input);
    assert!(
        result.is_ok(),
        "Single-quoted string with embedded double quotes should parse"
    );
    let comp = result.unwrap();
    assert_eq!(comp.applicators.len(), 1);
    assert_eq!(comp.applicators[0].name, "background");
}

#[test]
fn test_unescaped_nested_quotes_still_fail() {
    // Unescaped nested double quotes should still fail
    let input = r#"Text("hello "world"")"#;
    let result = parse_component(input);
    assert!(
        result.is_err(),
        "Unescaped nested double quotes should fail"
    );
}

#[test]
fn test_complex_template_with_list_and_applicators() {
    let input = r#"Column {
    Text("wow really").color(black)
    List(@state.messages) {
      Row {
        Text("@{item.content}")
      }
      .background("@{item.color}")
      .padding(16)
      .borderRadius(8)
      .margin(8)
      .alignItems("center")
      .justifyContent("center")
      .width("100%")
      .height("100%")
    }
   Row {
    Textarea(placeholder: "Enter message...")
    .bind(@state.input)
    .height(100)
    .width("80%")
   }
   Button {
    Text("Send")
    .onClick("@actions.sendMessage", message: @state.input)
   }
  }.fillMaxHeight()"#;
    let result = parse_component(input);
    assert!(
        result.is_ok(),
        "Complex template with list, applicators, and bind should parse"
    );
    let comp = result.unwrap();
    assert_eq!(comp.name, "Column");
    assert_eq!(comp.children.len(), 4); // Text, List, Row, Button
    assert_eq!(comp.applicators.len(), 1); // .fillMaxHeight()
    assert_eq!(comp.applicators[0].name, "fillMaxHeight");
}

// ============================================================================
// Data Source Reference (@provider.path) Tests
// ============================================================================

#[test]
fn test_data_source_reference_simple() {
    let input = "ForEach(items: @spacetime.messages)";
    let result = parse_component(input);
    assert!(
        result.is_ok(),
        "Should parse data source reference: {:?}",
        result
    );

    let component = result.unwrap();
    let items = component.arguments.get_named("items");
    assert!(matches!(items, Some(Value::Reference(s)) if s == "spacetime.messages"));
}

#[test]
fn test_data_source_reference_nested_path() {
    let input = "Text(@firebase.user.profile.name)";
    let result = parse_component(input);
    assert!(
        result.is_ok(),
        "Should parse nested data source reference: {:?}",
        result
    );

    let component = result.unwrap();
    if let Some(Argument::Positioned { value, .. }) = component.arguments.arguments.first() {
        assert!(matches!(value, Value::Reference(s) if s == "firebase.user.profile.name"));
    } else {
        panic!("Expected positional data source reference argument");
    }
}

#[test]
fn test_data_source_reference_in_foreach() {
    let input = r#"
        ForEach(items: @spacetime.message, key: "id") {
            Text("@{item.text}")
        }
    "#;
    let result = parse_component(input);
    assert!(
        result.is_ok(),
        "Should parse ForEach with data source: {:?}",
        result
    );

    let component = result.unwrap();
    let items = component.arguments.get_named("items");
    assert!(matches!(items, Some(Value::Reference(s)) if s == "spacetime.message"));
    assert_eq!(component.children.len(), 1);
}

#[test]
fn test_data_source_reference_with_applicators() {
    let input = r#"
        Text(@spacetime.user.displayName)
            .fontSize(18)
            .color(blue)
    "#;
    let result = parse_component(input);
    assert!(
        result.is_ok(),
        "Should parse data source ref with applicators: {:?}",
        result
    );

    let component = result.unwrap();
    assert_eq!(component.applicators.len(), 2);
}

#[test]
fn test_multiple_data_source_references() {
    let input = r#"Component(users: @spacetime.user, messages: @firebase.chat.messages)"#;
    let result = parse_component(input);
    assert!(
        result.is_ok(),
        "Should parse multiple data source references: {:?}",
        result
    );

    let component = result.unwrap();
    let users = component.arguments.get_named("users");
    let messages = component.arguments.get_named("messages");
    assert!(matches!(users, Some(Value::Reference(s)) if s == "spacetime.user"));
    assert!(matches!(messages, Some(Value::Reference(s)) if s == "firebase.chat.messages"));
}

#[test]
fn test_data_source_reference_mixed_with_state() {
    let input = r#"Component(data: @spacetime.messages, count: @state.count)"#;
    let result = parse_component(input);
    assert!(
        result.is_ok(),
        "Should parse mixed data source and state refs: {:?}",
        result
    );

    let component = result.unwrap();
    let data = component.arguments.get_named("data");
    let count = component.arguments.get_named("count");
    assert!(matches!(data, Some(Value::Reference(_))));
    assert!(matches!(count, Some(Value::Reference(_))));
}

// ============================================================================
// Escape Sequence & Error Detection Tests
// ============================================================================

#[test]
fn test_escaped_quote_not_unclosed_string() {
    // A string with escaped quotes should NOT be detected as unclosed
    let input = r#"Text("hello \"world\"")"#;
    let result = parse_component(input);
    assert!(
        result.is_ok(),
        "Escaped quotes should not cause unclosed string detection: {:?}",
        result
    );
}

#[test]
fn test_single_quoted_escaped_not_unclosed() {
    // Single-quoted string with escaped single quote
    let input = r#"Text('it\'s working')"#;
    let result = parse_component(input);
    assert!(
        result.is_ok(),
        "Escaped single quotes should not cause unclosed string: {:?}",
        result
    );
}

#[test]
fn test_error_detection_with_escaped_quotes_in_unclosed() {
    use crate::error::format_parse_errors;
    // An actually unclosed string that contains escaped quotes
    // The string starts at the first " and the \" should not close it
    let input = r#"Text("hello \"world)"#;
    let result = parse_component(input);
    assert!(
        result.is_err(),
        "Should fail - string is genuinely unclosed"
    );

    let errors = result.unwrap_err();
    let formatted = format_parse_errors("test.hyp", input, &errors);
    assert!(
        formatted.contains("unclosed string"),
        "Error should mention unclosed string, got: {}",
        formatted
    );
}

// ============================================================================
// Nested Block Comment Tests
// ============================================================================

#[test]
fn test_nested_block_comment() {
    let input = r#"
        /* outer /* inner */ still comment */
        Text("Hello")
    "#;
    let result = parse_component(input);
    assert!(
        result.is_ok(),
        "Nested block comments should parse: {:?}",
        result
    );
    let comp = result.unwrap();
    assert_eq!(comp.name, "Text");
}

#[test]
fn test_deeply_nested_block_comment() {
    let input = r#"
        /* level 1 /* level 2 /* level 3 */ back to 2 */ back to 1 */
        Text("Hello")
    "#;
    let result = parse_component(input);
    assert!(
        result.is_ok(),
        "Deeply nested block comments should parse: {:?}",
        result
    );
}

#[test]
fn test_block_comment_with_url() {
    // URLs containing /* or */ patterns should work in nested comment mode
    let input = r#"
        /* See: https://example.com/path */
        Text("Hello")
    "#;
    let result = parse_component(input);
    assert!(
        result.is_ok(),
        "Block comment with URL should parse: {:?}",
        result
    );
}

// ============================================================================
// Number Overflow Tests
// ============================================================================

#[test]
fn test_very_large_number_rejected() {
    // A number so large it overflows to f64::INFINITY should be rejected
    let huge = format!("Text({})", "9".repeat(400));
    let result = parse_component(&huge);
    assert!(
        result.is_err(),
        "Very large number should produce a parse error, not silently become infinity"
    );
}

#[test]
fn test_normal_large_number_accepted() {
    // A large but representable number should still work
    let input = "Text(999999999999)";
    let result = parse_component(input);
    assert!(
        result.is_ok(),
        "Large but representable numbers should still work: {:?}",
        result
    );
}

#[test]
fn test_negative_large_number_rejected() {
    let huge = format!("Text(-{})", "9".repeat(400));
    let result = parse_component(&huge);
    assert!(
        result.is_err(),
        "Very large negative number should produce a parse error"
    );
}

#[test]
fn test_unclosed_double_quote_string() {
    // Text("unclosed) - missing closing double quote
    let input = r#"Text("unclosed)"#;
    let result = parse_component(input);
    assert!(
        result.is_err(),
        "Should fail - unclosed double-quoted string"
    );
    let errors = result.unwrap_err();
    let err_str = format!("{:?}", errors);
    assert!(
        err_str.contains("closing quote"),
        "Error should mention closing quote, got: {}",
        err_str
    );
}

#[test]
fn test_triple_quote_string_error() {
    // Text(""") - extra quote after empty string
    let input = r#"Text(""")"#;
    let result = parse_component(input);
    assert!(
        result.is_err(),
        "Should fail - malformed triple-quote string"
    );
}

#[test]
fn test_escaped_closing_quote_unclosed() {
    // Text("hello\") - escaped closing quote makes string unclosed
    let input = "Text(\"hello\\\")";
    let result = parse_component(input);
    assert!(
        result.is_err(),
        "Should fail - escaped closing quote means string is unclosed"
    );
    let errors = result.unwrap_err();
    let err_str = format!("{:?}", errors);
    assert!(
        err_str.contains("closing quote"),
        "Error should mention closing quote, got: {}",
        err_str
    );
}

#[test]
fn test_unclosed_single_quote_string() {
    // Text('unclosed) - missing closing single quote
    let input = "Text('unclosed)";
    let result = parse_component(input);
    assert!(
        result.is_err(),
        "Should fail - unclosed single-quoted string"
    );
    let errors = result.unwrap_err();
    let err_str = format!("{:?}", errors);
    assert!(
        err_str.contains("closing quote"),
        "Error should mention closing quote, got: {}",
        err_str
    );
}

#[test]
fn test_name_range_records_the_name_token_span() {
    // The component name's byte span is recorded in metadata so downstream
    // diagnostics (a11y conformance, LSP) can point at file:line:col.
    let input = r#"Column { Button("Save") }"#;
    let component = parse_component(input).unwrap();
    let range = component.metadata.name_range.clone();
    assert_eq!(&input[range], "Column");

    let button = &component.children[0];
    let range = button.metadata.name_range.clone();
    assert_eq!(&input[range], "Button");
}

#[test]
fn test_name_range_with_module_keyword_and_leading_whitespace() {
    let input = "  module Search {\n    Text(\"hi\")\n  }";
    let component = parse_component(input).unwrap();
    let range = component.metadata.name_range.clone();
    assert_eq!(&input[range], "Search");

    let text = &component.children[0];
    let range = text.metadata.name_range.clone();
    assert_eq!(&input[range], "Text");
}

#[test]
fn test_expr_range_covers_a_multiline_applicator_chain() {
    // The full-expression span must end at the LAST applicator's ')' so
    // downstream tooling (a11y suppression directives) can match a trailing
    // comment on any line of the chain to this element.
    let input = "Button {\n    Icon(\"trash\")\n}\n    .padding(16)\n    .color(red)\n    .margin(8)";
    let component = parse_component(input).unwrap();
    let range = component.metadata.expr_range.clone();
    assert_eq!(range.start, 0);
    assert!(
        input[range.clone()].ends_with(".margin(8)"),
        "expr_range should end at the last applicator, got: {:?}",
        &input[range]
    );
    assert_eq!(range.end, input.len());
}

#[test]
fn test_expr_range_excludes_trailing_whitespace_and_comments() {
    // Padding consumes trailing whitespace/comments after the last token;
    // the expression span must not include them (a stray comment between two
    // elements belongs to neither).
    let input = "Column {\n    Text(\"a\")\n}\n    .padding(16) // trailing note\n\n";
    let component = parse_component(input).unwrap();
    let range = component.metadata.expr_range.clone();
    assert!(
        input[range].ends_with(".padding(16)"),
        "expr_range must stop at the applicator's ')'"
    );
}

#[test]
fn test_expr_range_without_applicators_ends_at_the_children_block() {
    let input = "Column {\n    Text(\"a\")\n}";
    let component = parse_component(input).unwrap();
    let range = component.metadata.expr_range.clone();
    assert_eq!(&input[range], input);

    // A child's expression covers exactly its own text.
    let text = &component.children[0];
    let range = text.metadata.expr_range.clone();
    assert_eq!(&input[range], "Text(\"a\")");
}

#[test]
fn test_expr_range_starts_at_the_declaration_keyword() {
    let input = "  module Search {\n    Text(\"hi\")\n  }";
    let component = parse_component(input).unwrap();
    let range = component.metadata.expr_range.clone();
    assert_eq!(range.start, input.find("module").unwrap());
    assert!(input[range].ends_with('}'));
}

#[test]
fn test_expr_range_bare_component_covers_name_and_args() {
    let input = "Text(\"hello\")";
    let component = parse_component(input).unwrap();
    assert_eq!(&input[component.metadata.expr_range.clone()], input);

    // No args, no children, no applicators: the name token is the whole
    // expression.
    let input = "Divider";
    let component = parse_component(input).unwrap();
    assert_eq!(&input[component.metadata.expr_range.clone()], "Divider");
}

#[test]
fn test_hypenapp_with_slot_children() {
    // HypenApp embed with loading/error slot children (customizable slots).
    let input = r#"HypenApp("ws://x") {
        Column { Text("Opening") }.slot("loading")
        Column { Text("Failed") }.slot("error")
    }.tw("flex-1")"#;
    let result = parse_component(input);
    assert!(result.is_ok(), "parse failed: {:?}", result.err());

    let spec = result.unwrap();
    assert_eq!(spec.name, "HypenApp");
    assert_eq!(spec.children.len(), 2);

    let slot_count = spec
        .children
        .iter()
        .flat_map(|c| c.applicators.iter())
        .filter(|a| a.name == "slot")
        .count();
    assert_eq!(slot_count, 2, "expected two .slot() applicators on children");
}
