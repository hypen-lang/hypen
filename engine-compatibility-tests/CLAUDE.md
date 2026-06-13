# CLAUDE.md

This file provides guidance to Claude Code when working with engine compatibility tests.

## Project Overview

Language-agnostic test suite ensuring all Hypen SDKs (TypeScript, Go, Kotlin, Rust) produce consistent behavior. Tests are defined as JSON fixtures and run by per-SDK test runners.

## Directory Structure

```
engine-compatibility-tests/
├── fixtures/                  # Test cases (JSON)
│   ├── rendering/             # Basic rendering (text, props, nesting, applicators)
│   ├── state/                 # State bindings and updates
│   ├── reconciliation/        # List add/remove/reorder, deep tree updates
│   ├── actions/               # Action dispatch with/without payloads
│   ├── control-flow/          # ForEach, When conditions
│   ├── imports/               # Document imports and state bindings
│   └── lifecycle/             # Module lifecycle events
├── schema/                    # JSON schemas
│   ├── test-case.schema.json  # Fixture format definition
│   ├── patch.schema.json      # Patch format
│   ├── state-change.schema.json
│   └── action.schema.json
└── runners/                   # Per-SDK test runners
    ├── typescript/            # Bun test runner
    ├── golang/                # Go test runner
    └── rust/                  # Rust test runner (Cargo)
```

## Running Tests

```bash
# TypeScript runner
cd runners/typescript && bun test

# Go runner
cd runners/golang && go test -v ./...

# Rust runner
cd runners/rust && cargo test
```

## Adding a New Test Fixture

1. Create a JSON file in the appropriate `fixtures/` subdirectory
2. Follow the schema in `schema/test-case.schema.json`
3. Each fixture defines: input DSL, initial state, expected patches, and optionally state changes and actions
4. Set priority level (P0 = critical, P1 = important, P2 = nice-to-have)
5. Run all SDK runners to verify consistency

## Fixture Format

```json
{
  "name": "test-name",
  "description": "What this tests",
  "priority": "P0",
  "input": "Text(\"Hello\")",
  "initialState": {},
  "expectedPatches": [...],
  "skip": { "golang": "reason" }
}
```

The `skip` field allows temporarily skipping a test for specific SDKs with a reason.
