# Changelog

All notable changes to `hypen-tailwind-parse` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- **Breaking:** `parse_classes` / `parse_class` now return `Result<_, TailwindError>`.
  CSS positioning utilities (`static`, `fixed`, `absolute`, `relative`, `sticky`),
  inset utilities (`top-*`, `right-*`, `bottom-*`, `left-*`, `inset-*`, `start-*`,
  `end-*`, including negative and arbitrary forms) and `sr-only`/`not-sr-only` are
  now hard errors instead of mapping to `position`/inset CSS. Hypen has no CSS
  positioning model — overlay with `Stack { ... }` + alignment, and use
  `VisuallyHidden` instead of `sr-only`.
- New `forbidden_utility_reason(utility)` helper exposes the check for tooling (LSP).

## [0.4.32] - 2026-02-19

### Added
- Initial changelog for the Tailwind CSS class parser
