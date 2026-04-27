# Error Handling in Hypen Parser

## Overview

The Hypen parser uses **Chumsky** for parsing with **Ariadne** for error reporting, providing:
- ✅ Precise error locations (line, column)
- ✅ Context-aware error messages
- ✅ Beautiful colored output
- ✅ Multiple error reporting

## How Errors Look

### Basic Error Output

When using raw Chumsky errors:

```rust
use hypen_parser::parse_component;

let input = r#"Text("Hello"#;
match parse_component(input) {
    Err(errors) => {
        for error in errors {
            println!("{}", error);
        }
    }
    Ok(_) => {}
}
```

**Output:**
```
found '"' expected identifier, or ')'
```

### Pretty Error Output (with Ariadne)

When using Ariadne's pretty printing:

```rust
use hypen_parser::{parse_component, print_parse_errors};

let input = r#"Text("Hello"#;
if let Err(errors) = parse_component(input) {
    print_parse_errors("myfile.hypen", input, &errors);
}
```

**Output:**
```
Error: Parse error
   ╭─[myfile.hypen:1:6]
   │
 1 │ Text("Hello
   │      ┬
   │      ╰── found '"' expected identifier, or ')'
───╯
```

## Error Types & Examples

### 1. Unclosed String

**Input:**
```hypen
Text("Hello
```

**Error:**
```
Error: Parse error
   ╭─[example.hypen:1:6]
   │
 1 │ Text("Hello
   │      ┬
   │      ╰── found '"' expected identifier, or ')'
───╯
```

### 2. Missing Closing Parenthesis

**Input:**
```hypen
Text("Hello"
```

**Error:**
```
Error: Parse error
   ╭─[example.hypen:1:13]
   │
 1 │ Text("Hello"
   │             │
   │             ╰─ found end of input expected ',', or ')'
───╯
```

### 3. Missing Closing Brace

**Input:**
```hypen
Column {
    Text("Hello")
```

**Error:**
```
Error: Parse error
   ╭─[example.hypen:2:19]
   │
 2 │     Text("Hello")
   │                   │
   │                   ╰─ found end of input expected '{', '.', any, or '}'
───╯
```

### 4. Invalid Syntax in Arguments

**Input:**
```hypen
Text(key: , value: 123)
```

**Error:**
```
Error: Parse error
   ╭─[example.hypen:1:9]
   │
 1 │ Text(key: , value: 123)
   │         ┬
   │         ╰── found ':' expected identifier, ',', or ')'
───╯
```

### 5. Complex Nested Error

**Input:**
```hypen
Column {
    Row {
        Button("Sign In")
            .padding(16
        Text("Footer")
    }
}
```

**Error:**
```
Error: Parse error
   ╭─[example.hypen:4:24]
   │
 4 │             .padding(16
   │                        │
   │                        ╰─ found end of input expected ',', or ')'
───╯
```

## Error API

### Basic API

```rust
use hypen_parser::parse_component;
use chumsky::error::Rich;

let result: Result<ComponentSpecification, Vec<Rich<char>>>
    = parse_component(input);
```

The error type `Rich<char>` provides:
- `span()` - Location in source (start, end)
- `found()` - What token was found
- `expected()` - What tokens were expected
- `reason()` - Error reason/context

### Pretty Printing API

```rust
use hypen_parser::print_parse_errors;

// Print to stdout with colors
print_parse_errors("filename.hypen", source_code, &errors);
```

```rust
use hypen_parser::format_parse_errors;

// Get as string for logging
let error_text = format_parse_errors("filename.hypen", source_code, &errors);
log::error!("{}", error_text);
```

## Best Practices

### 1. Production Error Handling

```rust
use hypen_parser::{parse_component, print_parse_errors};
use std::fs;

fn parse_file(path: &str) -> Result<ComponentSpecification, String> {
    let source = fs::read_to_string(path)
        .map_err(|e| format!("Failed to read file: {}", e))?;

    parse_component(&source).map_err(|errors| {
        // Log errors with full context
        let mut buffer = Vec::new();
        for error in &errors {
            use ariadne::*;
            Report::build(ReportKind::Error, path, error.span().start)
                .with_label(
                    Label::new((path, error.span().into_range()))
                        .with_message(format!("{}", error))
                        .with_color(Color::Red),
                )
                .finish()
                .write((path, Source::from(&source)), &mut buffer)
                .unwrap();
        }
        String::from_utf8(buffer).unwrap()
    })
}
```

### 2. Multiple File Parsing

```rust
fn parse_multiple_files(files: &[&str]) -> Vec<Result<ComponentSpecification, String>> {
    files.iter().map(|&file| {
        let source = std::fs::read_to_string(file).unwrap();
        parse_component(&source).map_err(|errors| {
            format_parse_errors(file, &source, &errors)
        })
    }).collect()
}
```

### 3. User-Friendly Error Messages

```rust
match parse_component(input) {
    Ok(component) => {
        println!("✓ Successfully parsed {}", component.name);
    }
    Err(errors) => {
        eprintln!("✗ Failed to parse component:");
        eprintln!();
        print_parse_errors("input", input, &errors);
        eprintln!();
        eprintln!("Hint: Check for unclosed strings, parentheses, or braces");
    }
}
```

### 4. Error Recovery

For parsing multiple components, continue on errors:

```rust
use hypen_parser::parse_components;

fn parse_all_or_partial(input: &str) -> Vec<ComponentSpecification> {
    match parse_components(input) {
        Ok(components) => components,
        Err(errors) => {
            // Log errors but return what we could parse
            eprintln!("Partial parse - some components may be missing");
            print_parse_errors("input", input, &errors);
            vec![] // or try to recover partial results
        }
    }
}
```

## Error Categories

Chumsky errors fall into these categories:

### Unexpected Token
- Found something the parser didn't expect
- Most common error type
- Usually indicates syntax error

### Unexpected End of Input
- Parser expected more tokens but file ended
- Usually means missing closing delimiter

### Expected One Of
- Parser expected specific tokens but found something else
- Helpful for understanding valid syntax at that position

## Improving Error Messages

Chumsky's error messages can be customized:

```rust
// In parser.rs - add labels to parsers
component_parser()
    .labelled("component")
    .then(/* ... */)
```

This makes errors say "expected component" instead of lower-level token names.

## Testing Error Handling

Always test error cases:

```rust
#[test]
fn test_unclosed_string_error() {
    let input = r#"Text("Hello"#;
    let result = parse_component(input);

    assert!(result.is_err());
    let errors = result.unwrap_err();
    assert!(!errors.is_empty());

    // Check error mentions the problem
    let error_msg = format!("{}", errors[0]);
    assert!(error_msg.contains("expected") || error_msg.contains("found"));
}
```

## Error Recovery Strategies

For IDE/LSP integration, consider:

1. **Partial parsing** - Parse what you can, skip invalid sections
2. **Error tokens** - Insert placeholder nodes for invalid syntax
3. **Multiple passes** - Try to recover and continue parsing
4. **Incremental parsing** - Only reparse changed sections

Chumsky supports error recovery through:
- `.recover_with()` combinators
- Custom error recovery strategies
- Fallback parsers

## Performance Considerations

- Error reporting is fast (microseconds)
- Pretty printing with Ariadne adds minimal overhead
- For bulk parsing, consider batching error reports
- Cache parsed results to avoid re-parsing on every error

## Summary

✅ **Chumsky provides**: Precise error locations and context
✅ **Ariadne provides**: Beautiful, colored error reports
✅ **Best practice**: Always use `print_parse_errors` for user-facing errors
✅ **Testing**: Include both success and error test cases
✅ **Production**: Log errors with full context and source location
