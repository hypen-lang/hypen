# Changelog

All notable changes to `hypen-kotlin` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `compression` option on the `HypenServer { … }` builder (default `true`) requesting WebSocket permessage-deflate (RFC 7692). Because `HypenServer` is transport-agnostic and never installs Ktor's `WebSockets` plugin, the flag is advisory: read `server.compression` where you install the plugin and add `extensions { install(WebSocketDeflateExtension) }`. See the README's "WebSocket transport" section and `example-server/src/main/kotlin/Sockets.kt`, which is now wired this way.

### Changed
- **BREAKING:** Removed `IconPack`, the `SvgParser` class, and the `.icons()` / `.iconsFromDir()` / `.iconFromFile()` builder methods. Use `resources(map)` / `resourcesDir(dir)` / `resourcesFile(path)` instead — they forward raw SVG strings to the Rust engine, which now owns all SVG parsing. The `Icon("name")` / `Icon(@resources.name)` DSL syntax is unchanged.

## [0.4.32] - 2026-02-19

### Added
- Initial changelog for the Kotlin/JVM SDK
