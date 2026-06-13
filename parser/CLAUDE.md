# CLAUDE.md

This file provides guidance to Claude Code when working with the Hypen parser.

## Project Overview

`hypen-parser` is a Rust parser for the Hypen declarative UI language, built with Chumsky combinators. It takes Hypen DSL source strings and produces an AST used by the engine for rendering.

## Module Structure

```
parser/src/
├── lib.rs       # Public API exports
├── ast.rs       # AST type definitions (ComponentSpecification, Value, etc.)
├── parser.rs    # Core parser logic (Chumsky combinators)
├── tests.rs     # 114 tests covering all syntax features
├── error.rs     # Error formatting with Ariadne (cli feature)
├── wasm.rs      # WASM bindings (wasm feature)
└── main.rs      # CLI binary entry point
```

## Development Commands

```bash
cargo test                                 # Run all tests
cargo test test_name -- --nocapture        # Specific test with output
cargo run --example pretty_errors          # Pretty error display with Ariadne
cargo clippy                               # Lint
```

## Public API

```rust
// Parse functions
parse_component(input: &str) -> Result<ComponentSpecification, Vec<Error>>
parse_components(input: &str) -> Result<Vec<ComponentSpecification>, Vec<Error>>
parse_document(input: &str) -> Result<Document, Vec<Error>>
parse_import(input: &str) -> Result<ImportStatement, Vec<Error>>

// Error display (cli feature)
format_parse_errors(filename, input, errors) -> Vec<String>
print_parse_errors(filename, input, errors)
```

## Key AST Types

- `ComponentSpecification` — parsed component with name, arguments, applicators, children
- `Value` — enum: String, Number, Boolean, List, Map, Reference, DataSourceReference (deprecated alias for Reference)
- `ArgumentList` / `Argument` — positional and named arguments
- `ApplicatorSpecification` — dot-notation styling (`.padding(16)`)
- `Document` — top-level structure with imports and components
- `DeclarationType` — module, component, or regular declaration

## Architecture

The parser uses a three-phase approach:
1. **Value Parser** — parses literals, references, expressions, lists, maps
2. **Component Parser** — parses component name, arguments, children (recursive)
3. **Applicator Folding** — chains `.method()` applicators onto components

## Features

| Feature | Flag | Purpose |
|---------|------|---------|
| `cli` | default | Error formatting with Ariadne |
| `wasm` | optional | WASM bindings via wasm-bindgen |

## Adding a Parser Feature

1. Add test in `tests.rs`
2. Update AST types in `ast.rs` if needed
3. Modify parser combinators in `parser.rs`
4. Run `cargo test`
5. Update engine IR expansion in `../hypen-engine-rs/src/ir/expand.rs`
