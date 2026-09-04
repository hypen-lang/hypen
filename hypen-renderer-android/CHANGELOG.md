# Changelog

All notable changes to `hypen-renderer-android` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Video v2 (`hypen-docs/content/docs/guide/components.mdx` §"Playback control & composition
  slots"): a contract player state (idle/loading/playing/paused/ended/error)
  derived from the ExoPlayer callbacks — a rebuffer re-enters `loading`
  without emitting `onPause`, `error` is sticky until the source list
  changes. `.bind(@state.playback)` two-way binds `{playing, position,
  duration, state}`: reports go out per key on the `__hypen_bind` channel
  with position throttled to 250 ms while playing (transitions immediate),
  inbound writes play/pause (a `true` write in `ended` restarts from 0) and
  seek behind the 1 s epsilon + last-reported echo guards. `startPosition`
  seeks once on the first READY. Children tagged `.slot("controls" |
  "loading" | "error" | "poster")` overlay the surface full-bleed and are
  shown/hidden strictly per the normative visibility table, never
  mounted/unmounted, so slot state survives transitions; a present slot
  replaces the built-in for that concern (`controls` also forces
  `useController = false`). New `Scrubber` component: wired to the enclosing
  player renderer-side, previews drags locally and commits on release via
  the bind or its `onSeek` action, with `progressBarRangeInfo` /
  `stateDescription` / `setProgress` for TalkBack; inert outside a Video.
  `muted` and `loop` are now re-applied live rather than at player creation.
- Animation stage 1 (#159): the daily-driver half of the shipped `__anim.*`
  protocol. `.transition` glides the 27 whitelisted props by interpolating
  the presented value back onto the element, so every prop animates through
  its existing applicator/component; `.states` pose flips glide for free
  through the engine's synthesized transition. `.enter`/`.exit` play as a
  single `graphicsLayer` pose, with the renderer-owned deferred-remove
  contract behind them: a `Remove{transition:true}` keeps the subtree alive,
  excludes it from touch, action dispatch, focus/IME and TalkBack
  immediately, and finalizes on natural settle OR the
  `duration + delay + 80ms` timeout backbone. `.animate` presets
  (pulse/spin/shake/shimmer) run with their normative timing defaults;
  looping presets never complete, a cached Router attach never replays a
  finite one. `batchAnimation` is honoured at batch index 0 only, with
  precedence `structural > transaction > node .transition > snap`. Reduced
  motion gates on `Settings.Global.ANIMATOR_DURATION_SCALE` with a live
  `ContentObserver`, and `.motion(essential)` exempts a node from all of it.
  `.onAnimationComplete` dispatches on NATURAL settle only.
  Curves are the pinned cubic beziers — `spring` is
  `cubic-bezier(0.34, 1.56, 0.64, 1)`, never Compose's physics `spring()`.

### Known limitations
- `.layout` (FLIP on `move`) is parsed and deliberately snapped, matching
  the canvas and desktop renderers; `.sharedElement` and `.scrub`/`.settle`
  remain unimplemented (stage 2). See the capability matrix in
  `ANIMATION.md`.

## [0.4.32] - 2026-02-19

### Added
- Initial changelog for the Android native renderer
