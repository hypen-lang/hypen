# Changelog

All notable changes to `hypen-golang` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- Remote dispatch now strips the reserved `__hypenAnimate` payload key
  (the TS renderers' transaction-animation stamp, Option D) before module
  handlers run — handlers no longer observe renderer-internal directives.

### Known limitations
- The `animate:` event argument (transaction-scoped animation) is
  **TypeScript-host-only** for now. The Go host strips the stamp: the
  dispatch works, the resulting state flush snaps. Go's state-sync path
  (`NotifyStateChange` → `hypen_update_state`) has no animation envelope
  and the Go observable notifies synchronously per mutation, so honest
  stamping needs engine/interface work tracked separately. The
  `Patch.Spec` relay field remains so engine-emitted `batchAnimation`
  preludes survive transit.

### Changed
- **BREAKING:** Removed `IconPack`, the internal `svg.go` parser, and the `.Icons()` / `.IconsFromDir()` / `.IconFromFile()` builder methods. Use `Resources(map)` / `ResourcesDir(dir)` / `ResourcesFile(path)` instead — they forward raw SVG strings to the Rust engine, which now owns all SVG parsing. The `Icon("name")` / `Icon(@resources.name)` DSL syntax is unchanged.

### Added
- `core.NewApp[T]` — generic, strongly-typed module builder backed by a
  user-defined struct. Action and lifecycle handlers receive a
  `TypedActionContext[T]` / `*T` whose fields can be mutated directly; a
  diff against the pre-handler snapshot is batch-committed on return, so
  only changed top-level keys are notified to the engine.
- `core.TypedActionContext[T]`, `core.TypedActionHandler[T]`,
  `core.TypedLifecycleHandler[T]`.
- Documentation, doc comments, and the `examples/counter`,
  `examples/todo-app`, and `examples/router-app` programs updated to
  showcase the typed API as the recommended path. The untyped
  `NewAppBuilder` remains available and is the underlying foundation.

## [0.4.32] - 2026-02-19

### Added
- Initial changelog for the Go SDK
