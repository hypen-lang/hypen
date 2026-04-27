use hypen_parser::{parse_component, print_parse_errors};

fn main() {
    println!("=== Hypen Parser Error Examples with Ariadne ===\n");

    // Example 1: Unclosed string
    println!("Example 1: Unclosed string\n");
    let input1 = r#"Text("Hello"#;
    if let Err(errors) = parse_component(input1) {
        print_parse_errors("example.hypen", input1, &errors);
    }

    println!("\n{}\n", "=".repeat(60));

    // Example 2: Unclosed parentheses
    println!("Example 2: Unclosed parentheses\n");
    let input2 = r#"Text("Hello""#;
    if let Err(errors) = parse_component(input2) {
        print_parse_errors("example.hypen", input2, &errors);
    }

    println!("\n{}\n", "=".repeat(60));

    // Example 3: Unclosed block
    println!("Example 3: Unclosed block\n");
    let input3 = r#"Column {
    Text("Hello")
    Row {
        Text("World")
"#;
    if let Err(errors) = parse_component(input3) {
        print_parse_errors("example.hypen", input3, &errors);
    }

    println!("\n{}\n", "=".repeat(60));

    // Example 4: Invalid syntax in arguments
    println!("Example 4: Invalid syntax in arguments\n");
    let input4 = r#"Text(key: , value: 123)"#;
    if let Err(errors) = parse_component(input4) {
        print_parse_errors("example.hypen", input4, &errors);
    }

    println!("\n{}\n", "=".repeat(60));

    // Example 5: Complex nested error
    println!("Example 5: Complex nested error\n");
    let input5 = r#"Column {
    Text("Header")
        .fontSize(18)
        .color(blue)

    Row {
        Button("Sign In")
            .padding(16
        Text("Footer")
    }
}
"#;
    if let Err(errors) = parse_component(input5) {
        print_parse_errors("example.hypen", input5, &errors);
    }

    println!("\n{}\n", "=".repeat(60));

    // Example 6: Show a successful parse
    println!("Example 6: Valid input (success)\n");
    let input6 = r#"Column {
    Text("Hello")
        .fontSize(18)
}"#;
    match parse_component(input6) {
        Ok(component) => println!("✓ Successfully parsed component: {}\n", component.name),
        Err(errors) => print_parse_errors("example.hypen", input6, &errors),
    }
}
