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
| `hypen-browser/` | Desktop Hypen Browser | Rust |
| `hypen-lsp/` | Language Server | TypeScript |
| `hypen-docs/` | Documentation site | Fumadocs/Next.js |

### Development Setup

Pick the area you want to work on rather than trying to bootstrap every platform at once.
All commands below are run from the repository root; each block uses a `( cd … )`
subshell so you can paste them in order without ending up in the wrong directory.

#### Rust Components (Parser, Engine)

```bash
# Prerequisites: Rust 1.70+, wasm-pack, and the wasm32-wasip1 target:
#   cargo install wasm-pack        (or the installer at https://rustwasm.github.io/wasm-pack/)
#   rustup target add wasm32-wasip1

# Parser
(cd parser && cargo test)

# Engine
(cd hypen-engine-rs && cargo test)

# Build the WASM targets (same as `bun run build:wasm` from the root)
hypen-engine-rs/build-wasm.sh
```

`build-wasm.sh` does not install missing tools on its own: it stops and tells
you what to install. Pass `--install-tools` (or set `HYPEN_INSTALL_TOOLS=1`) if
you want it to run `cargo install wasm-pack` / `rustup target add` for you.

Expect `build-wasm.sh` to modify **committed files outside the engine**. It
copies the fresh builds into `hypen-web/` (server, web-engine and the test
fixture glue) and `hypen-golang/hypen_engine.wasm`, then regenerates the UniFFI
bindings in `hypen-kotlin/` and `hypen-server-swift/`. Only commit those files
when your change actually touches the engine; otherwise discard them. For
JS-only iterations, `HYPEN_SKIP_BINDINGS=1` (or `bun run build:wasm:js`) skips
the slow bindings step.

#### Hypen Browser (desktop)

`hypen-browser/` links system libraries (D-Bus, libclang, ALSA) for its device
capabilities. On Linux, install the packages listed under
[Linux build dependencies](hypen-browser/README.md#linux-build-dependencies)
before `cargo build -p hypen-browser`, or the build stops in a `-sys` crate.

#### TypeScript Components (Web SDK, CLI)

```bash
# Prerequisites: Bun 1.0+ or Node.js 18+

(cd hypen-web && bun install && bun test)
(cd hypen-web && bun run playground)  # Interactive development
```

For CLI work:

```bash
(cd hypen-cli && bun install)
(cd hypen-lsp && bun install)   # needed by hypen-cli's LSP integration tests
(cd hypen-cli && bun test)
```

The studio's LSP integration tests (`studio-ui/src/lib/lsp-server.test.ts`)
spawn the real server from `hypen-lsp/`, which needs that package's own
dependencies. Without `hypen-lsp/node_modules` those 4 tests are skipped with a
warning telling you to run the install above.

For docs work:

```bash
(cd hypen-docs && bun install && bun dev)
```

> **Lockfiles:** several packages depend on published `@hypen-space/*`
> versions by caret range, so a plain `bun install` may re-resolve them and
> rewrite the committed `bun.lock` (e.g. `hypen-cli/bun.lock`). Don't commit
> that drift as part of an unrelated change — discard it with
> `git restore -- '*bun.lock'`, or use `bun install --frozen-lockfile` to see
> whether a lockfile is out of date. Lockfile refreshes belong in their own PR.

#### Go SDK

```bash
# Prerequisites: Go 1.25+ (hypen-golang/go.mod declares `go 1.25.0`;
# older toolchains refuse to build it unless GOTOOLCHAIN can download 1.25)
(cd hypen-golang && go test ./...)
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
# All Rust tests (from the repository root)
(cd parser && cargo test)
(cd hypen-engine-rs && cargo test)

# TypeScript tests
(cd hypen-web && bun test)

# Specific test
(cd parser && cargo test test_component_parsing)
(cd hypen-web && bun test tests/variant-handling.test.ts)
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
