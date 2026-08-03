# Changelog

All notable changes to `hypen-renderer-android` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
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
