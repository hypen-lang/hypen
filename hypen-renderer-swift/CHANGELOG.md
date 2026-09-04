# Changelog

All notable changes to `HypenSwift` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Video v2** (`docs/components/video.md` §"Playback control & composition
  slots"): a `VideoPlayerStateMachine` derives the normative
  `idle/loading/playing/paused/ended/error` state from AVPlayer signals;
  `.bind(@state.playback)` reports `{playing, position, duration, state}`
  back as per-key `__hypen_bind` writes (position throttled to 250 ms,
  transitions immediate) and applies inbound writes as play/pause/seek
  (1 s seek epsilon + clamp + last-reported echo guard); `startPosition`
  seeks once when the item becomes ready; `.slot("controls"|"loading"|
  "error"|"poster")` children overlay the player full-bleed, shown/hidden
  strictly per the spec's visibility table without ever being unmounted;
  and a new `Scrubber` component drives the enclosing player renderer-side
  (local drag preview, commit on release, VoiceOver-adjustable ±5 s).
  All the logic is pure and unit-tested in `VideoPlayback.swift`.

- Animation protocol relay (no playback yet): `Patch` now carries the
  deferred-remove `transition` flag and parses the `batchAnimation`
  prelude's `spec` instead of dropping the whole patch as an unknown
  type. `HypenRenderer` exposes the batch stamp as
  `currentBatchAnimation` (index 0 only) and surfaces the exit flag in
  `applyRemove`. Every channel still snaps — the sanctioned degradation;
  see `ANIMATION.md` for the implementation contract.

### Fixed
- Video `onEnded.completed` on a playlist is now `isLast && !loop`, so a
  wrapping queue reports `completed: false` (matches DOM/canvas/Android/
  desktop; iOS was the outlier).
- A looping single-source Video no longer dispatches `onEnded` on every
  lap — it loops silently, native-style, exactly like the DOM's `el.loop`.
- No more spurious `onPause`: pausing at the end of an item is part of the
  ended transition, and a rebuffer re-enters `loading` instead of pausing.

## [0.4.32] - 2026-02-19

### Added
- Initial changelog for the iOS/SwiftUI renderer
