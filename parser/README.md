# Hypen Parser (Rust)

[![Rust](https://img.shields.io/badge/Rust-1.70+-orange?logo=rust)](https://www.rust-lang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](../LICENSE)

A Rust implementation of the Hypen DSL parser using [Chumsky](https://crates.io/crates/chumsky), a parser combinator library.

## Overview

This parser recreates the functionality of the original Kotlin Multiplatform parser (`hypen-parser-core`) in Rust, using Chumsky's combinator-based approach for elegant and composable parsing.

## Features

- ✅ **Component parsing**: Parse Hypen component declarations
- ✅ **Argument parsing**: Supports positional and named arguments
- ✅ **Value types**: Strings, numbers, booleans, lists, maps, and references (@state, @actions)
- ✅ **Nested components**: Full support for component hierarchies
- ✅ **Applicators**: Dot notation styling (e.g., `.padding(16)`, `.backgroundColor(blue)`)
- ✅ **Error handling**: Rich error messages with Chumsky's error reporting

## Installation

Add to your `Cargo.toml`:

```toml
[dependencies]
hypen-parser = { path = "path/to/hypen-parser" }
```

## Usage

### Parsing a Single Component

```rust
use hypen_parser::parse_component;

let input = r#"
    Text("Hello, World!")
        .fontSize(18)
        .color(blue)
"#;

match parse_component(input) {
    Ok(component) => {
        println!("Component: {}", component.name);
        println!("Applicators: {}", component.applicators.len());
    }
    Err(errors) => {
        for error in errors {
            println!("Parse error: {}", error);
        }
    }
}
```

### Parsing Multiple Components

```rust
use hypen_parser::parse_components;

let input = r#"
    Text("First")
    Text("Second")
    Text("Third")
"#;

let components = parse_components(input).unwrap();
assert_eq!(components.len(), 3);
```

### Complex Example

```rust
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

let component = parse_component(input).unwrap();
assert_eq!(component.name, "Column");
assert_eq!(component.children.len(), 3);
```

## Hypen Syntax

### Component Declaration

Hypen supports three types of declarations:

1. **Regular components** (stateless, wiped on re-render):
```hypen
ComponentName(arg1, arg2, key: value)
```

2. **Module declarations** (stateful, maintains state across lifecycle):
```hypen
module ProfilePage(userId: 123) {
    Text("User Profile")
}
```

3. **Component keyword declarations** (explicit stateless components):
```hypen
component Button(text: "Click Me") {
    Text(@state.text)
}
```

**Key Differences:**
- `module` - Maintains state throughout its lifecycle (persistent state)
- `component` - State is wiped on each re-render (ephemeral state)
- No keyword - Treated as a regular component (default behavior)

### Arguments

- **Positional**: `Text("Hello")`
- **Named**: `Text(text: "Hello", color: red)`
- **Strings**: Double (`"hello"`) or single (`'hello'`) quotes. Escape quotes with `\"` or `\'`.
- **Numbers**: `width: 100`, `height: 50.5`
- **Booleans**: `enabled: true`, `disabled: false`
- **Lists**: `items: [1, 2, 3]`
- **Maps**: `config: {width: 100, height: 200}`
- **References**: `@state.username`, `@actions.login`

### Nested Components

```hypen
Column {
    Text("First")
    Text("Second")
}
```

### Applicators (Styling)

```hypen
Text("Styled")
    .fontSize(18)
    .color(blue)
    .padding(16)
```

## Architecture

### AST Types

- **`ComponentSpecification`**: Represents a parsed component with name, arguments, applicators, and children
- **`ArgumentList`**: Collection of named or positional arguments
- **`Argument`**: Named or positional argument with a value
- **`Value`**: Enum for different value types (String, Number, Boolean, List, Map, Reference)
- **`ApplicatorSpecification`**: Styling/modifier applied to a component
- **`MetaData`**: Source location information

### Parser Structure

The parser uses recursive descent with combinator composition:

1. **Value Parser**: Parses all value types (strings, numbers, etc.)
2. **Component Parser**: Main recursive parser for components
3. **Applicator Folding**: Post-processing to attach applicators to their parent components

## Differences from Kotlin Parser

- Uses Chumsky's combinator approach instead of manual token processing
- Simpler ID generation (atomic counter vs UUID)
- More concise implementation due to Rust's type system and Chumsky's abstractions
- Better error messages out-of-the-box with Chumsky

## Error Handling

The parser uses **Chumsky** for parsing and **Ariadne** for beautiful error reporting.

### Basic Error Handling

```rust
use hypen_parser::parse_component;

let input = r#"Text("Unclosed string"#;

match parse_component(input) {
    Ok(component) => {
        // Success - work with component
        println!("Parsed: {}", component.name);
    }
    Err(errors) => {
        // Handle errors
        for error in errors {
            eprintln!("{}", error);
        }
    }
}
```

### Pretty Error Reports with Ariadne

For production use, use the `print_parse_errors` function for beautiful, colored error messages:

```rust
use hypen_parser::{parse_component, print_parse_errors};

let input = r#"
    Column {
        Text("Hello")
            .fontSize(18
        Text("Footer")
    }
"#;

match parse_component(input) {
    Ok(component) => { /* ... */ }
    Err(errors) => {
        // Prints beautiful error with context
        print_parse_errors("myfile.hypen", input, &errors);
    }
}
```

**Example error output:**

```
Error: Parse error
   ╭─[myfile.hypen:4:24]
   │
 4 │             .fontSize(18
   │                        ┬
   │                        ╰── found end of input expected ',', or ')'
───╯
```

### Error Types

Chumsky provides detailed error information including:
- **Span**: Exact location of the error in the source
- **Expected tokens**: What the parser was expecting
- **Found token**: What was actually encountered
- **Context**: Full parsing context

## Testing

### Run All Tests

```bash
cargo test
```

This runs the full test suite covering:
- Simple components
- Named and positional arguments
- All value types (strings, numbers, booleans, lists, maps, references)
- Nested components
- Applicators (styling)
- Complex hierarchies
- Whitespace handling

### Run Specific Tests

```bash
# Run a specific test
cargo test test_component_with_applicators

# Run tests matching a pattern
cargo test component

# Show test output
cargo test -- --nocapture
```

### Run Examples

```bash
# Basic usage example
cargo run

# Error handling examples
cargo run --example errors

# Pretty error display
cargo run --example pretty_errors

# Comprehensive usage examples
cargo run --example usage
```

### Test Coverage

Current test coverage includes:

| Feature | Tests | Status |
|---------|-------|--------|
| Simple components | ✓ | Passing |
| Arguments (named/positional) | ✓ | Passing |
| Value types | ✓ | Passing |
| Nested components | ✓ | Passing |
| Applicators | ✓ | Passing |
| Complex hierarchies | ✓ | Passing |
| Error handling | ✓ | Passing |
| Whitespace handling | ✓ | Passing |

## Performance

The parser is designed for correctness and clarity first. For production use, consider:

- Using `ariadne` for pretty error reporting
- Caching parsed results
- Implementing incremental parsing for large files

## Future Enhancements

- [ ] Source location tracking in AST nodes
- [ ] Better error recovery
- [ ] LSP integration for IDE support
- [ ] Incremental parsing support
- [ ] Performance benchmarks
- [ ] WASM target compilation

## License

Same as the parent Hypen project.

## Contributing

This parser is designed to match the behavior of the Kotlin parser in `hypen-parser-core`. When adding features, ensure compatibility with the original implementation.
