# Changelog

All notable changes to `hypen-engine` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Native module host: each distinct component is compiled once per host (content-addressed, shared across registered names and both `DualHost` ABIs); `HostConfig` (`Host::with_config` / `DualHost::with_config`) with an opt-in on-disk compilation cache (`cache_dir`; `hypen-runtime --cache-dir`, UniFFI `"cacheDir"`); `ComponentCompiler` / `PrecompiledComponent` for compiling off the host's thread; `compile_stats()`.
- `ModuleHost::instance_status` (→ `InstanceStatus`) and `ModuleHost::denied_capabilities` (→ `DeniedCapability` / `ManifestGrant`), both with default implementations. UniFFI `HypenModuleHost`: `is_alive`, `death_reason`, `denied_capabilities`.
- `set_virtual_clock` on the v0.1 host too (it was v0.2-only).
- `hypen-runtime`: `--cache-dir`, `--request-timeout-ms`; `module_crashed` errors carry the host's death reason (`error.reasons`); `error.candidates` on ambiguous / unknown actions.

### Changed
- `hypen:storage` `entry-info.modified-ms` is now the time of the last write (it was always 0). The storage snapshot format is 3; format 2 is read and migrated.
- `hypen-runtime --serve`: a bare action name exported by several modules is `409 ambiguous_action` (was `500 module_error`); capability hints name every missing grant and, for a per-usage scope, the backing module's app.json entry.
- `hypen-runtime` hot reload: a usage site removed by a template edit retires its instance; a `--ui` edit that changes the root declaration's config re-initialises the single module.

### Fixed
- `hypen-runtime --serve`: a `.wasm` replaced by rename stopped being hot-reloaded after the first rebuild; a stalled request body held an in-flight slot indefinitely; a refused request with an unsent body blocked its handler (or the accept loop); a request declaring an unallocatable `Content-Length` aborted the process.

### Changed
- **BREAKING:** Removed the `IconPack` type, `Engine::register_icon_pack`, `ResourceRegistry::register_pack` / `register_data`, `parse_svg_to_json`, `load_icons_from_dir`, `load_icon_from_file`, and all corresponding UniFFI (`register_icon_pack`, `register_resources_from_dir`, `parse_svg_to_json`), WASM (`registerIconPack`), and WASI (`hypen_register_icon_pack`) bindings. SDKs now pass raw `name → svg` maps through `registerResources`; the engine parses SVG internally via the (still internal) `parse_svg`. `IconData` and `IconPath` are now engine-internal. The `Icon` component and `@resources.*` DSL syntax are unchanged.

## [0.4.32] - 2026-02-19

### Added
- Initial changelog for the core reactive engine
