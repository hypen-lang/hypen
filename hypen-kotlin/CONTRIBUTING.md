# Contributing to Hypen Kotlin SDK

Thank you for your interest in contributing to the Hypen Kotlin SDK! This document provides guidelines and instructions for contributing.

## Getting Started

### Prerequisites

- JDK 17 or higher
- Gradle 8.x (or use the wrapper)
- An IDE with Kotlin support (IntelliJ IDEA recommended)

### Building the Project

```bash
# Clone the repository
git clone https://github.com/hypen-space/hypen-engine-rs.git
cd hypen-engine-rs/hypen-kotlin

# Build the library
./gradlew build

# Run tests
./gradlew test
```

## Development Workflow

### Code Style

This project follows the [Kotlin Coding Conventions](https://kotlinlang.org/docs/coding-conventions.html). Key points:

- Use 4 spaces for indentation (no tabs)
- Maximum line length: 120 characters
- Use meaningful names for classes, functions, and variables
- Prefer immutability (`val` over `var`)
- Use Kotlin idioms (null safety, extension functions, etc.)

### Project Structure

```
hypen-kotlin/
├── src/
│   ├── main/kotlin/space/hypen/core/
│   │   ├── Types.kt           # Core types (Patch, Action, StateChange)
│   │   ├── Engine.kt          # IEngine interface and MockEngine
│   │   ├── ObservableState.kt # Reactive state container
│   │   ├── AppBuilder.kt      # Fluent module builder
│   │   ├── ModuleInstance.kt  # Runtime module management
│   │   ├── GlobalContext.kt   # Cross-module communication
│   │   ├── Router.kt          # Navigation and routing
│   │   ├── Dsl.kt             # Kotlin DSL extensions
│   │   └── Utils.kt           # JSON and utility functions
│   └── test/kotlin/space/hypen/core/
│       └── CompatibilityTest.kt  # Compatibility test suite
├── build.gradle.kts
├── settings.gradle.kts
└── README.md
```

## Making Changes

### 1. Create a Branch

```bash
git checkout -b feature/your-feature-name
```

### 2. Make Your Changes

- Write clean, well-documented code
- Follow the existing code patterns
- Add tests for new functionality
- Ensure all tests pass

### 3. Run Tests

```bash
# Run all tests
./gradlew test

# Run specific test class
./gradlew test --tests "space.hypen.core.CompatibilityTest"
```

### 4. Compatibility Tests

The SDK must pass the shared compatibility test suite in `engine-compatibility-tests/`. This ensures consistent behavior with the TypeScript and Go SDKs.

```bash
# Run compatibility tests
./gradlew test --tests "*CompatibilityTest*"
```

### 5. Submit a Pull Request

- Push your branch to GitHub
- Create a pull request with a clear description
- Reference any related issues

## Testing Guidelines

### Unit Tests

Write unit tests for all new functionality:

```kotlin
import kotlin.test.*

class MyFeatureTest {
    @Test
    fun `feature does expected thing`() {
        // Arrange
        val state = ObservableState(mapOf("count" to 0))

        // Act
        state.set("count", 1)

        // Assert
        assertEquals(1, state.get("count"))
    }
}
```

### Testing with MockEngine

Use `MockEngine` for testing modules without the full engine:

```kotlin
@Test
fun `action increments count`() {
    val engine = mockEngine()

    val counter = hypen {
        state { "count" to 0 }
        action("increment") { ctx ->
            val count = ctx.state.get("count") as? Int ?: 0
            ctx.state.set("count", count + 1)
        }
    }

    val instance = counter.createInstance(engine)
    engine.triggerAction("increment")

    assertEquals(1, instance.getState()["count"])
}
```

## API Compatibility

The Kotlin SDK must maintain API compatibility with the TypeScript and Go SDKs. When adding features:

1. Check if the feature exists in TypeScript (`hypen-web/packages/core/`)
2. Check if the feature exists in Go (`hypen-golang/`)
3. Implement with consistent behavior and naming

### Key Compatibility Points

| TypeScript | Go | Kotlin |
|------------|-----|--------|
| `app.defineState()` | `NewAppBuilder()` | `hypen { }` or `AppBuilder.defineState()` |
| `state.get("path")` | `state.Get("path")` | `state.get("path")` |
| `state.set("path", value)` | `state.Set("path", value)` | `state.set("path", value)` |
| `onAction("name", handler)` | `OnAction("name", handler)` | `action("name") { }` |
| `onCreated(handler)` | `OnCreated(handler)` | `onCreated { }` |
| `onDestroyed(handler)` | `OnDestroyed(handler)` | `onDestroyed { }` |

## Reporting Issues

When reporting bugs, please include:

1. Kotlin version
2. JDK version
3. Steps to reproduce
4. Expected behavior
5. Actual behavior
6. Relevant code snippets

## Feature Requests

For feature requests:

1. Check existing issues first
2. Describe the use case
3. Explain how it fits with existing SDKs
4. Provide example API if possible

## Code of Conduct

- Be respectful and inclusive
- Focus on constructive feedback
- Help others learn and grow

## Questions?

- Open an issue for questions
- Check the [documentation](../hypen-docs/src/docs/servers/kotlin.md)
- Review existing tests for examples

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
