# Testing Guide

## Quick Start

```bash
# Run all tests
cargo test

# Run tests with output
cargo test -- --nocapture

# Run a specific test
cargo test test_component_with_applicators

# Run tests matching a pattern
cargo test component
```

## Running Examples

```bash
# Main example (demonstrates basic parsing)
cargo run

# Error handling examples (basic)
cargo run --example errors

# Pretty error display with Ariadne
cargo run --example pretty_errors

# Comprehensive usage examples
cargo run --example usage
```

## Test Organization

### Unit Tests (`src/tests.rs`)

All parser tests are in `src/tests.rs`. The test suite includes:

#### 1. Basic Component Parsing
- `test_simple_component` - Parse simple components with arguments
- `test_component_without_arguments` - Components without parentheses
- `test_empty_component` - Empty argument lists

#### 2. Argument Parsing
- `test_component_with_named_arguments` - Named arguments
- `test_boolean_values` - Boolean true/false
- `test_number_values` - Integer and float numbers
- `test_reference_values` - @state and @actions references
- `test_list_values` - Array/list syntax
- `test_map_values` - Map/object syntax

#### 3. Component Hierarchy
- `test_component_with_children` - Nested components
- `test_nested_components` - Deep nesting
- `test_multiple_components` - Multiple root components

#### 4. Styling & Applicators
- `test_component_with_applicators` - Dot notation styling

#### 5. Complex Scenarios
- `test_complex_example` - Real-world complex component tree
- `test_whitespace_handling` - Various whitespace formats

## Adding New Tests

To add a new test:

```rust
#[test]
fn test_my_feature() {
    let input = r#"
        MyComponent(arg: value)
    "#;

    let result = parse_component(input);
    assert!(result.is_ok());

    let component = result.unwrap();
    assert_eq!(component.name, "MyComponent");
    // Add more assertions...
}
```

## Error Testing

For error cases, verify the parser fails gracefully:

```rust
#[test]
fn test_error_case() {
    let input = r#"InvalidSyntax(((("#;
    let result = parse_component(input);
    assert!(result.is_err());

    // Optionally check error details
    if let Err(errors) = result {
        assert!(!errors.is_empty());
    }
}
```

## Benchmarking

To add benchmarks (requires nightly Rust):

```toml
# Add to Cargo.toml
[dev-dependencies]
criterion = "0.5"

[[bench]]
name = "parser_bench"
harness = false
```

Then create `benches/parser_bench.rs`:

```rust
use criterion::{black_box, criterion_group, criterion_main, Criterion};
use hypen_parser::parse_component;

fn benchmark_simple(c: &mut Criterion) {
    c.bench_function("parse simple component", |b| {
        b.iter(|| {
            parse_component(black_box(r#"Text("Hello")"#))
        })
    });
}

criterion_group!(benches, benchmark_simple);
criterion_main!(benches);
```

Run with: `cargo bench`

## Test Coverage

Generate coverage report (requires `cargo-tarpaulin`):

```bash
# Install
cargo install cargo-tarpaulin

# Run coverage
cargo tarpaulin --out Html

# Open report
open tarpaulin-report.html
```

## Continuous Integration

Example GitHub Actions workflow (`.github/workflows/test.yml`):

```yaml
name: Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - uses: actions-rs/toolchain@v1
        with:
          toolchain: stable
      - run: cargo test --all-features
```

## Debugging Tests

```bash
# Run with logging (if using env_logger)
RUST_LOG=debug cargo test

# Run single test with full output
cargo test test_component_with_applicators -- --nocapture --test-threads=1

# Show what tests would run without running them
cargo test -- --list
```

## Test Data

Keep test input organized:

```rust
// Simple test cases
const SIMPLE_TEXT: &str = r#"Text("Hello")"#;
const NESTED_COLUMN: &str = r#"
    Column {
        Text("A")
        Text("B")
    }
"#;

#[test]
fn test_with_constant() {
    let result = parse_component(SIMPLE_TEXT);
    assert!(result.is_ok());
}
```

## Common Test Patterns

### Assert Component Structure

```rust
let component = parse_component(input).unwrap();
assert_eq!(component.name, "Column");
assert_eq!(component.children.len(), 2);
assert_eq!(component.applicators.len(), 1);
```

### Check Argument Values

```rust
let text_value = component.arguments.get_named("text");
assert!(matches!(text_value, Some(Value::String(_))));
```

### Verify Error Messages

```rust
let errors = parse_component(bad_input).unwrap_err();
assert!(!errors.is_empty());
// Check that error mentions what was expected
```

## Performance Testing

Create `examples/perf.rs` for ad-hoc performance testing:

```rust
use std::time::Instant;
use hypen_parser::parse_component;

fn main() {
    let input = /* large component tree */;

    let start = Instant::now();
    for _ in 0..1000 {
        let _ = parse_component(input);
    }
    let duration = start.elapsed();

    println!("1000 parses in {:?}", duration);
    println!("Average: {:?}", duration / 1000);
}
```

Run with: `cargo run --release --example perf`
