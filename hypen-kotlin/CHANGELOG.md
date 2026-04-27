# Changelog

All notable changes to `hypen-kotlin` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- **BREAKING:** Removed `IconPack`, the `SvgParser` class, and the `.icons()` / `.iconsFromDir()` / `.iconFromFile()` builder methods. Use `resources(map)` / `resourcesDir(dir)` / `resourcesFile(path)` instead — they forward raw SVG strings to the Rust engine, which now owns all SVG parsing. The `Icon("name")` / `Icon(@resources.name)` DSL syntax is unchanged.

## [0.4.32] - 2026-02-19

### Added
- Initial changelog for the Kotlin/JVM SDK
