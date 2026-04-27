# Engine Compatibility Test Suite

A language-agnostic test suite to verify that different Hypen SDK implementations produce consistent behavior.

## Overview

This test suite ensures that all Hypen SDKs (TypeScript, Go, Kotlin, etc.) behave identically when:
- Rendering Hypen DSL source to patches
- Handling state bindings and updates
- Performing reconciliation (keyed diffing)
- Dispatching actions
- Managing module lifecycle

## Structure

```
engine-compatibility-tests/
├── schema/                    # JSON Schema definitions
│   ├── test-case.schema.json  # Main test case format
│   ├── patch.schema.json      # Patch operation schema
│   ├── state-change.schema.json
│   └── action.schema.json
│
├── fixtures/                  # Test fixtures by category
│   ├── rendering/             # DSL → patches
│   ├── state/                 # State bindings & updates
│   ├── reconciliation/        # Keyed diffing
│   ├── actions/               # Action dispatch
│   ├── control-flow/          # ForEach, When
│   └── lifecycle/             # Module lifecycle
│
└── runners/                   # SDK-specific test runners
    ├── typescript/            # Bun test runner
    ├── golang/                # Go test runner
    └── kotlin/                # Kotlin test runner (in hypen-kotlin)
```

## Running Tests

### TypeScript (WASM Engine)

```bash
cd runners/typescript
bun install
bun test
```

### Go (Native Engine)

```bash
cd runners/golang
go test -v ./...
```

### Kotlin (JVM)

```bash
cd ../hypen-kotlin
./gradlew test
```

## Test Case Format

Test cases are JSON files with the following structure:

```json
{
  "name": "test-case-name",
  "description": "What this test verifies",
  "category": "rendering|state|reconciliation|actions|control-flow|lifecycle",
  "priority": "P0|P1|P2",

  "input": {
    "source": "Text(\"Hello\")",
    "initialState": { "count": 0 },
    "module": {
      "name": "TestModule",
      "actions": ["increment"],
      "stateKeys": ["count"]
    }
  },

  "expected": {
    "patches": [
      { "type": "create", "id": "0", "elementType": "Text", "props": { "text": "Hello" } },
      { "type": "insert", "parentId": "root", "id": "0" }
    ]
  }
}
```

### Multi-Step Tests

For tests that require multiple interactions:

```json
{
  "name": "state-update-test",
  "description": "State updates produce minimal patches",
  "category": "state",

  "input": {
    "source": "Text(@{state.message})",
    "initialState": { "message": "Hello" },
    "module": { "name": "TestModule", "stateKeys": ["message"] }
  },

  "steps": [
    {
      "action": "initialRender",
      "expectedPatchCount": 2
    },
    {
      "action": "updateState",
      "stateChange": {
        "paths": ["message"],
        "newValues": { "message": "Updated" }
      },
      "expectedPatches": [
        { "type": "setProp", "id": "0", "name": "text", "value": "Updated" }
      ],
      "forbiddenPatches": [
        { "type": "create" },
        { "type": "remove" }
      ]
    }
  ]
}
```

## Test Categories

| Category | Description | Priority |
|----------|-------------|----------|
| `rendering` | Basic DSL → patch generation | P0 |
| `state` | State bindings, templates, updates | P0 |
| `reconciliation` | Keyed list diffing, minimal patches | P0 |
| `actions` | Action dispatch with payloads | P0 |
| `control-flow` | ForEach, When conditionals | P1 |
| `lifecycle` | Module onCreated, onDestroyed | P1 |

## Adding New Tests

1. Create a JSON file in the appropriate `fixtures/` subdirectory
2. Follow the schema in `schema/test-case.schema.json`
3. Run tests in both runners to verify consistency

### Naming Conventions

- Use kebab-case for file names: `keyed-list-reorder.json`
- Use descriptive names that explain what's being tested
- Include priority in the test case for CI filtering

## Skipping Tests

To skip a test for specific SDKs:

```json
{
  "name": "advanced-feature",
  "skip": {
    "reason": "Feature not yet implemented in Go SDK",
    "sdks": ["golang"]
  }
}
```

## Implementing a New Runner

To add support for a new SDK:

1. Create a directory under `runners/` (e.g., `runners/kotlin/`)
2. Implement a test runner that:
   - Loads all JSON files from `../../fixtures/`
   - Parses test cases according to the schema
   - Runs tests against the SDK's engine
   - Verifies patches match expected output
3. Handle `skip` configuration for your SDK name
4. Add documentation for running tests

### Required Test Runner Capabilities

- Load and parse JSON fixtures
- Initialize engine with module configuration
- Set render callback to collect patches
- Execute test steps (render, updateState, dispatchAction)
- Compare actual patches against expected
- Report forbidden patch violations

## Patch Types

All SDKs must support these patch operations:

| Type | Fields | Description |
|------|--------|-------------|
| `create` | `id`, `elementType`, `props` | Create new element |
| `setProp` | `id`, `name`, `value` | Update element property |
| `setText` | `id`, `text` | Update text content |
| `insert` | `parentId`, `id`, `beforeId?` | Insert element into parent |
| `move` | `parentId`, `id`, `beforeId?` | Move element to new position |
| `remove` | `id` | Remove element |
| `attachEvent` | `id`, `eventName` | Attach event listener |
| `detachEvent` | `id`, `eventName` | Detach event listener |

## CI Integration

Add to your CI pipeline:

```yaml
# GitHub Actions example
compatibility-tests:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4

    - name: TypeScript Tests
      run: |
        cd engine-compatibility-tests/runners/typescript
        bun install
        bun test

    - name: Go Tests
      run: |
        cd engine-compatibility-tests/runners/golang
        go test -v ./...
```

## Architecture Notes

### TypeScript SDK
- Wraps the WASM-compiled Rust engine
- Full parsing and rendering support
- Runs all test categories

### Go SDK
- Native Go implementation
- Currently provides module system (state, actions, lifecycle)
- Rendering tests require implementing a Go parser/renderer
- Skips rendering/reconciliation tests until engine is complete

### Kotlin SDK
- Native JVM implementation
- Provides full module system (state, actions, lifecycle)
- Idiomatic Kotlin DSL for module definition
- Tests run via Gradle/JUnit
- Located in `hypen-kotlin/` directory

### Future SDKs
- Swift: For iOS native SDKs
- Python: For ML/data science integrations

## Contributing

1. Add tests for any new engine feature
2. Ensure tests pass in all supported SDKs
3. Update `skip` configuration if a feature isn't implemented everywhere
4. Keep fixtures focused and minimal - test one thing per file
