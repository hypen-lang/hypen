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
- `core.LogHandler` — a pluggable log handler for routing Hypen logs into an
  application's own logging system (`slog`, `zap`, `logrus`, ...), reaching
  parity with the TypeScript and Kotlin SDKs. Install one with
  `core.SetLogHandler(h)`; `core.SetLogHandler(nil)` restores the default
  writer-based behaviour, and `core.GetLogHandler()` reports the current one.
  Handlers receive `(tag, format string, args ...any)` — the raw format string
  and its arguments, not a rendered line — so structured loggers can keep the
  template intact. Level filtering stays in the SDK, so handlers never re-check
  it. `core.LogHandlerFunc` adapts a single `func(level, tag, format, args...)`
  into a handler. Logs from the `remote` package route to the same handler
  (filtered by `remote.SetLogLevel`), so one handler covers the whole SDK. The
  existing `io.Writer` path (`SetLogOutput`, per-logger `SetOutput`) is
  unchanged and remains the default when no handler is installed.
- WebSocket **permessage-deflate compression (RFC 7692), enabled by
  default** on every upgrade and dial path in `remote`. Negotiated per
  connection, so peers that don't advertise the extension fall back to
  uncompressed frames automatically. Opt out via
  `ServerConfig.DisableCompression` / `RemoteServer.DisableCompression()`
  on the server and `EngineOptions.DisableCompression` on the client.
  New `RemoteServer.Upgrader()` returns the configured
  `websocket.Upgrader` so custom HTTP endpoints inherit the setting, and
  `RemoteServer.CompressionEnabled()` reports it. Note that
  `gorilla/websocket` supports no-context-takeover mode only.
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
