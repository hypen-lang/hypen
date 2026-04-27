# Contributing to Hypen

Thank you for your interest in contributing to Hypen! This document provides guidelines and information for contributors.

## Code of Conduct

Please be respectful and constructive in all interactions. We're building something together.

## Getting Started

### Repository Structure

Hypen is a monorepo containing multiple packages:

| Directory | Description | Language |
|-----------|-------------|----------|
| `parser/` | Hypen DSL parser | Rust |
| `hypen-engine-rs/` | Core reactive engine | Rust/WASM |
| `hypen-web/` | Web SDK and renderers | TypeScript |
| `hypen-cli/` | CLI tools | TypeScript |
| `hypen-renderer-swift/` | iOS/macOS renderer | Swift |
| `hypen-renderer-android/` | Android renderer | Kotlin |
| `hypen-golang/` | Go implementation | Go |
| `hypen-lsp/` | Language Server | TypeScript |
| `hypen-docs/` | Documentation site | Fumadocs/Next.js |

### Development Setup

Pick the area you want to work on rather than trying to bootstrap every platform at once.

#### Rust Components (Parser, Engine)

```bash
# Prerequisites: Rust 1.70+, wasm-pack

# Parser
cd parser
cargo test

# Engine
cd hypen-engine-rs
cargo test
./build-wasm.sh  # Build WASM targets
```

#### TypeScript Components (Web SDK, CLI)

```bash
# Prerequisites: Bun 1.0+ or Node.js 18+

cd hypen-web
bun install
bun test
bun run playground  # Interactive development
```

For CLI work:

```bash
cd hypen-cli
bun install
bun test
```

For docs work:

```bash
cd hypen-docs
bun install
bun dev
```

#### Mobile Renderers

- **iOS**: Xcode 15+, Swift 6.0+
- **Android**: Android Studio, Kotlin 1.9+

## How to Contribute

### Reporting Bugs

1. Check existing issues to avoid duplicates
2. Use the bug report template when it fits, or open a plain issue with the same details
3. Include:
   - Hypen version
   - Platform (Web/iOS/Android)
   - Minimal reproduction code
   - Expected vs actual behavior

### Suggesting Features

1. Open a discussion or issue
2. Describe the use case
3. Provide examples of how the feature would work

### Submitting Pull Requests

1. **Fork** the repository
2. **Create a branch** from `main`:
   ```bash
   git checkout -b feature/your-feature-name
   ```
3. **Make your changes** following our coding standards
4. **Write tests** for new functionality
5. **Run the relevant tests** for the packages you changed:
   ```bash
   # Rust
   cargo test

   # TypeScript
   bun test
   ```
6. **Commit** with conventional commit messages:
   ```
   feat: add responsive breakpoint support
   fix: correct padding calculation in Column
   docs: update applicator reference
   ```
7. **Push** and open a Pull Request

### Commit Message Format

We use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` - New feature
- `fix:` - Bug fix
- `docs:` - Documentation only
- `style:` - Code style (formatting, semicolons)
- `refactor:` - Code change that neither fixes a bug nor adds a feature
- `perf:` - Performance improvement
- `test:` - Adding or updating tests
- `chore:` - Maintenance tasks

### Pull Request Guidelines

- Keep PRs focused on a single change
- Update documentation if needed
- Add tests for new features
- Ensure all CI checks pass
- Request review from maintainers

## Coding Standards

### Rust

- Follow [Rust API Guidelines](https://rust-lang.github.io/api-guidelines/)
- Use `cargo fmt` before committing
- Run `cargo clippy` and address warnings
- Document public APIs with doc comments

### TypeScript

- Use TypeScript strict mode
- Prefer explicit types over `any`
- Use `bun fmt` or Prettier for formatting

### Swift

- Follow [Swift API Design Guidelines](https://www.swift.org/documentation/api-design-guidelines/)
- Use Swift 6 concurrency patterns
- Support all Apple platforms where applicable

### Kotlin

- Follow [Kotlin Coding Conventions](https://kotlinlang.org/docs/coding-conventions.html)
- Use Jetpack Compose best practices

## Testing

### Running Tests

```bash
# All Rust tests
cd parser && cargo test
cd hypen-engine-rs && cargo test

# TypeScript tests
cd hypen-web && bun test

# Specific test file
cargo test test_component_parsing
bun test tests/variant-handling.test.ts
```

### Writing Tests

- Test edge cases and error conditions
- Use descriptive test names
- Follow Given-When-Then pattern where appropriate

## Documentation

- Update relevant README files
- Add doc comments to public APIs
- Update `hypen-docs/` for user-facing changes
- Include code examples

## Questions?

- Open a [GitHub Discussion](https://github.com/hypen-lang/hypen/discussions)
- Check existing documentation in `hypen-docs/`

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
