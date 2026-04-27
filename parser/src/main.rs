use hypen_parser::parse_component;

fn main() {
    let example = r#"
        Column {
            Text("Hello, World!")
                .fontSize(18)
                .color(blue)

            Button("@actions.signIn") {
                Text("Sign In")
            }
            .padding(16)
        }
        .backgroundColor(white)
    "#;

    match parse_component(example) {
        Ok(component) => {
            println!("Successfully parsed component!");
            println!("Component name: {}", component.name);
            println!("Children count: {}", component.children.len());
            println!("Applicators: {}", component.applicators.len());
            println!("\nFull AST: {:#?}", component);
        }
        Err(errors) => {
            println!("Parse errors:");
            for error in errors {
                println!("  {}", error);
            }
        }
    }
}
