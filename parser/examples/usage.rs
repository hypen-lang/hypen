use hypen_parser::{parse_component, print_parse_errors, Argument, Value};

fn main() {
    println!("=== Hypen Parser Usage Examples ===\n");

    // Example 1: Simple component
    example_1();

    println!("\n{}\n", "=".repeat(70));

    // Example 2: Extracting arguments
    example_2();

    println!("\n{}\n", "=".repeat(70));

    // Example 3: Working with applicators
    example_3();

    println!("\n{}\n", "=".repeat(70));

    // Example 4: Navigating component tree
    example_4();

    println!("\n{}\n", "=".repeat(70));

    // Example 5: Error handling
    example_5();
}

fn example_1() {
    println!("Example 1: Parsing a simple component\n");

    let input = r#"Text("Hello, World!")"#;
    println!("Input: {}\n", input);

    match parse_component(input) {
        Ok(component) => {
            println!("✓ Component name: {}", component.name);
            println!("✓ Arguments count: {}", component.arguments.arguments.len());

            if let Some(Argument::Positioned { value, .. }) = component.arguments.arguments.first()
            {
                println!("✓ First argument: {:?}", value);
            }
        }
        Err(errors) => {
            print_parse_errors("input.hypen", input, &errors);
        }
    }
}

fn example_2() {
    println!("Example 2: Extracting named and positional arguments\n");

    let input = r#"Button(text: "Click Me", enabled: true, color: blue)"#;
    println!("Input: {}\n", input);

    match parse_component(input) {
        Ok(component) => {
            println!("✓ Component: {}", component.name);

            // Get named argument
            if let Some(text) = component.arguments.get_named("text") {
                println!("✓ Text argument: {:?}", text);
            }

            // Get boolean argument
            if let Some(Value::Boolean(enabled)) = component.arguments.get_named("enabled") {
                println!("✓ Enabled: {}", enabled);
            }

            // Iterate all arguments
            println!("\nAll arguments:");
            for (i, arg) in component.arguments.arguments.iter().enumerate() {
                match arg {
                    Argument::Named { key, value } => {
                        println!("  [{}] {} = {:?}", i, key, value);
                    }
                    Argument::Positioned { position, value } => {
                        println!("  [{}] pos {} = {:?}", i, position, value);
                    }
                }
            }
        }
        Err(errors) => {
            print_parse_errors("input.hypen", input, &errors);
        }
    }
}

fn example_3() {
    println!("Example 3: Working with applicators (styling)\n");

    let input = r#"
        Text("Styled Text")
            .fontSize(18)
            .color(blue)
            .padding(16)
    "#;
    println!("Input: {}\n", input);

    match parse_component(input) {
        Ok(component) => {
            println!("✓ Component: {}", component.name);
            println!("✓ Applicators count: {}", component.applicators.len());

            println!("\nApplicators:");
            for applicator in &component.applicators {
                print!("  .{}(", applicator.name);
                for (i, arg) in applicator.arguments.arguments.iter().enumerate() {
                    if i > 0 {
                        print!(", ");
                    }
                    match arg {
                        Argument::Named { key, value } => print!("{}: {:?}", key, value),
                        Argument::Positioned { value, .. } => print!("{:?}", value),
                    }
                }
                println!(")");
            }
        }
        Err(errors) => {
            print_parse_errors("input.hypen", input, &errors);
        }
    }
}

fn example_4() {
    println!("Example 4: Navigating the component tree\n");

    let input = r#"
        Column {
            Text("Header")
                .fontSize(24)

            Row {
                Button("Left")
                Button("Right")
            }

            Text("Footer")
        }
    "#;
    println!("Input: {}\n", input);

    match parse_component(input) {
        Ok(component) => {
            println!("✓ Root component: {}", component.name);
            println!("✓ Children count: {}", component.children.len());

            // Walk the tree
            println!("\nComponent tree:");
            print_tree(&component, 0);

            // Flatten to list
            let all_components = component.flatten();
            println!(
                "\nFlattened tree ({} total components):",
                all_components.len()
            );
            for comp in &all_components {
                println!(
                    "  - {} (applicators: {})",
                    comp.name,
                    comp.applicators.len()
                );
            }
        }
        Err(errors) => {
            print_parse_errors("input.hypen", input, &errors);
        }
    }
}

fn print_tree(component: &hypen_parser::ComponentSpecification, depth: usize) {
    let indent = "  ".repeat(depth);
    print!("{}{}", indent, component.name);

    if !component.applicators.is_empty() {
        print!(" [");
        for (i, app) in component.applicators.iter().enumerate() {
            if i > 0 {
                print!(", ");
            }
            print!(".{}", app.name);
        }
        print!("]");
    }
    println!();

    for child in &component.children {
        print_tree(child, depth + 1);
    }
}

fn example_5() {
    println!("Example 5: Proper error handling\n");

    let inputs = [
        r#"Text("Valid input")"#,
        r#"Text("Missing closing paren"#,
        r#"Column { Text("Unclosed block"#,
    ];

    for (i, input) in inputs.iter().enumerate() {
        println!("Input {}: {}\n", i + 1, input);

        match parse_component(input) {
            Ok(component) => {
                println!("✓ Success: parsed component '{}'", component.name);
            }
            Err(errors) => {
                println!("✗ Parse error:");
                print_parse_errors(&format!("input-{}.hypen", i + 1), input, &errors);
            }
        }

        if i < inputs.len() - 1 {
            println!("\n{}\n", "-".repeat(60));
        }
    }
}
