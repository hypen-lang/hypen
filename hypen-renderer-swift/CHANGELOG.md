# Changelog

All notable changes to `HypenSwift` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Animation protocol relay (no playback yet): `Patch` now carries the
  deferred-remove `transition` flag and parses the `batchAnimation`
  prelude's `spec` instead of dropping the whole patch as an unknown
  type. `HypenRenderer` exposes the batch stamp as
  `currentBatchAnimation` (index 0 only) and surfaces the exit flag in
  `applyRemove`. Every channel still snaps — the sanctioned degradation;
  see `ANIMATION.md` for the implementation contract.

## [0.4.32] - 2026-02-19

### Added
- Initial changelog for the iOS/SwiftUI renderer
