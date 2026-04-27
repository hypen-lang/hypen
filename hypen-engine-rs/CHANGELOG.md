# Changelog

All notable changes to `hypen-engine` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- **BREAKING:** Removed the `IconPack` type, `Engine::register_icon_pack`, `ResourceRegistry::register_pack` / `register_data`, `parse_svg_to_json`, `load_icons_from_dir`, `load_icon_from_file`, and all corresponding UniFFI (`register_icon_pack`, `register_resources_from_dir`, `parse_svg_to_json`), WASM (`registerIconPack`), and WASI (`hypen_register_icon_pack`) bindings. SDKs now pass raw `name → svg` maps through `registerResources`; the engine parses SVG internally via the (still internal) `parse_svg`. `IconData` and `IconPath` are now engine-internal. The `Icon` component and `@resources.*` DSL syntax are unchanged.

## [0.4.32] - 2026-02-19

### Added
- Initial changelog for the core reactive engine
