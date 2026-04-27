use hypen_parser::parse_component;

fn main() {
    println!("=== Hypen Parser Error Examples ===\n");

    // Example 1: Unclosed string
    println!("1. Unclosed string:");
    let input1 = r#"Text("Hello"#;
    match parse_component(input1) {
        Ok(_) => println!("  ✓ Parsed successfully (unexpected)"),
        Err(errors) => {
            println!("  ✗ Parse failed:");
            for error in errors {
                println!("    {}", error);
            }
        }
    }

    println!("\n2. Unclosed parentheses:");
    let input2 = r#"Text("Hello""#;
    match parse_component(input2) {
        Ok(_) => println!("  ✓ Parsed successfully (unexpected)"),
        Err(errors) => {
            println!("  ✗ Parse failed:");
            for error in errors {
                println!("    {}", error);
            }
        }
    }

    println!("\n3. Unclosed block:");
    let input3 = r#"
        Column {
            Text("Hello")
    "#;
    match parse_component(input3) {
        Ok(_) => println!("  ✓ Parsed successfully (unexpected)"),
        Err(errors) => {
            println!("  ✗ Parse failed:");
            for error in errors {
                println!("    {}", error);
            }
        }
    }

    println!("\n4. Invalid syntax:");
    let input4 = r#"Text(((("#;
    match parse_component(input4) {
        Ok(_) => println!("  ✓ Parsed successfully (unexpected)"),
        Err(errors) => {
            println!("  ✗ Parse failed:");
            for error in errors {
                println!("    {}", error);
            }
        }
    }

    println!("\n5. Missing closing brace:");
    let input5 = r#"
        Column {
            Row {
                Text("Inside")

        }
    "#;
    match parse_component(input5) {
        Ok(_) => println!("  ✓ Parsed successfully (unexpected)"),
        Err(errors) => {
            println!("  ✗ Parse failed:");
            for error in errors {
                println!("    {}", error);
            }
        }
    }

    println!("\n6. Valid input (for comparison):");
    let input6 = r#"
        Column {
            Text("Hello")
        }
    "#;
    match parse_component(input6) {
        Ok(component) => println!("  ✓ Successfully parsed component: {}", component.name),
        Err(errors) => {
            println!("  ✗ Parse failed (unexpected):");
            for error in errors {
                println!("    {}", error);
            }
        }
    }
}
