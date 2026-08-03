# Animation

Hypen animates through five applicators — `.transition()`, `.enter()`, `.exit()`, `.layout()`, and `.animate()`. Each declares *intent* on a node; the engine ships that intent to the renderer, which executes the motion natively (CSS transitions and keyframes on the DOM renderer; a per-frame numeric ticker on the Canvas renderer). Renderers without animation support simply snap — your UI stays correct on every platform.

## Quick Start

```hypen
// Animate future prop changes on this node
Text("@{state.score}")
    .fontSize("@{state.emphasized ? 32 : 18}")
    .transition(200, easeOut)

// Animate appearance and disappearance
If(condition: @state.showToast) {
    Row { Text("Saved!") }
        .enter(slide, fade, from: bottom)
        .exit(fade, duration: 150)
}

// Animate list reorders (FLIP)
ForEach(@state.items) { item ->
    Row { Text("@{item.title}") }
        .key("@{item.id}")
        .layout(spring)
}

// Ambient motion: looping and one-shot presets
Spinner {}.animate(spin)
Badge("LIVE").animate(pulse)
Row {}.animate(shimmer)                          // skeleton loading sweep
```

## `.transition()` — Animate Prop Changes

Declare once on a node that property changes should animate. Every later change to an animatable property (state binding update, conditional value flip) interpolates instead of snapping. Interruption is handled natively: a new value mid-flight retargets from the current visual value.

```hypen
.transition()                                    // defaults: 200ms, easeOut
.transition(200, easeOut)                        // positional: number → duration (ms), token → curve
.transition(duration: 300, curve: spring, delay: 50)
.transition(props: [opacity, translateY])        // scope to specific props
```

- Positional arguments: a number sets the duration in milliseconds, a bare token sets the curve.
- `props:` limits the transition to the listed properties. Entries outside the animatable whitelist (see below) are dropped with a warning; omit `props:` to animate every animatable property.
- Transition styles are applied at creation, before first paint — the initial render never animates.

## `.enter()` / `.exit()` — Animate Appearance and Removal

`.enter()` plays when a node is inserted (an `If` turning true, a `ForEach` item added). `.exit()` plays when it is removed — the renderer defers the actual teardown until the exit animation settles, so elements fade or slide out instead of vanishing.

```hypen
.enter(fade)                                     // single preset
.enter(slide, fade, from: bottom)                // presets compose; direction is a named arg
.enter(scale, duration: 250, curve: easeOut)
.exit(fade, duration: 150)
.exit(slide, to: trailing)
```

- Presets are bare tokens and compose: `.enter(slide, fade)` slides and fades together. With no preset, `fade` is the default.
- Direction is a named argument — `from:` on `.enter`, `to:` on `.exit`. Nested calls like `slide(from: bottom)` are not valid syntax.
- Enter plays only for nodes that appear after the initial render; the first paint of a screen never cascades enter animations, and a route restored from the Router cache reappears instantly.
- While a subtree is exit-animating it is inert: it ignores pointer events and its actions no longer dispatch.

## `.layout()` — Animate Reorders

When a keyed `ForEach` item moves, `.layout()` animates it from its old position to its new one (FLIP) instead of jumping.

```hypen
.layout()                                        // defaults: 300ms, spring
.layout(spring)
.layout(duration: 400, curve: easeInOut)
```

If the same reconciliation both moves and removes a node, the exit animation wins.

## `.animate()` — Preset Timelines

`.animate()` plays a built-in keyframe timeline on a node — ambient and decorative motion that isn't driven by a state change: spinners, live badges, skeleton shimmers, error shakes. The first positional token names the preset; everything else is a named argument.

```hypen
.animate(spin)                                   // per-preset defaults
.animate(pulse, duration: 800, repeat: 3, curve: easeInOut)
.animate(shake, delay: 100)
```

### Presets and defaults

| Preset | Motion | Duration | Repeat | Curve |
|--------|--------|----------|--------|-------|
| `pulse` | opacity breathes 1 → 0.5 → 1 | 1200ms | `loop` | `easeInOut` |
| `spin` | full 360° rotation | 800ms | `loop` | `linear` |
| `shimmer` | gradient highlight sweeps across (skeleton loading) | 1500ms | `loop` | `linear` |
| `shake` | horizontal wiggle | 400ms | `1` | `easeInOut` |

The preset *names* and timing defaults are the cross-renderer contract; the keyframe shapes are renderer-owned (CSS `@keyframes` on the DOM renderer).

### Arguments

- `duration:` / `delay:` — milliseconds.
- `repeat:` — the token `loop` (play forever) or a positive integer count: `repeat: loop`, `repeat: 3`.
- `curve:` — the shared curve vocabulary (see below).
- Modifiers are named-only; extra positional arguments are ignored with a warning.

Validation follows the family rules with one difference: an unknown or missing *preset* omits the animation entirely (with a warning) — there is no meaningful default timeline to fall back to. Every other invalid argument falls back to the preset's default, and state bindings are ignored with a warning, exactly as elsewhere.

### Behavior

- Playback starts when the node appears and restarts whenever the `.animate` spec itself changes (e.g. a conditional swaps the preset or duration).
- Author-defined timelines and a `when:` trigger (`.animate(shake, when: ...)`) are not in v1. For "play on becoming true", put the preset on a node inside an `If` — it plays when the node enters:

```hypen
If(condition: @state.error) {
    Card { Text("@{state.error}") }.animate(shake)
}
```

- On a route restored from the Router cache, looping presets resume but finite-repeat presets (like `shake`) do **not** replay — same no-replay contract as `.enter`.
- While an enter, exit, or FLIP move plays on the same node, a preset animating the same properties (`pulse`, `spin`, `shake`) is paused so the two never fight; it resumes when the playback settles. `shimmer` runs on an overlay and is never paused.
- `shimmer` sets `position: relative` on the node to anchor its overlay; absolutely-positioned descendants of a statically-positioned node will re-anchor to it while shimmer runs.

## Vocabulary

### Curves

| Token | CSS equivalent |
|-------|----------------|
| `linear` | `linear` |
| `easeIn` | `ease-in` |
| `easeOut` | `ease-out` |
| `easeInOut` | `ease-in-out` |
| `spring` | `cubic-bezier(0.34, 1.56, 0.64, 1)` (fixed overshoot; parameterized springs planned) |

### Presets (`.enter` / `.exit`)

| Preset | Hidden pose |
|--------|-------------|
| `fade` | `opacity: 0` |
| `slide` | 24px offset in the given direction (default `leading`) |
| `scale` | `scale(0.95)` |

(The `.animate` timeline presets — `pulse`, `spin`, `shimmer`, `shake` — are a separate vocabulary; see the table in the `.animate()` section above.)

### Directions

`top`, `bottom`, `leading`, `trailing`. `leading`/`trailing` are RTL-aware: they resolve against the nearest `dir` attribute (leading = left in LTR, right in RTL).

### Defaults

| Applicator | Duration | Curve | Extra |
|------------|----------|-------|-------|
| `.transition()` | 200ms | `easeOut` | all animatable props |
| `.enter()` | 200ms | `easeOut` | presets default to `[fade]` |
| `.exit()` | 150ms | `easeIn` | presets default to `[fade]` |
| `.layout()` | 300ms | `spring` | — |
| `.animate()` | per preset | per preset | repeat per preset — see the preset table above |

All five accept `duration:`, `curve:`, and `delay:` (milliseconds). Animation arguments must be static — state bindings inside them are ignored with a warning. Invalid arguments never break the render; they fall back to the defaults above (except an unknown `.animate` preset, which omits the animation).

## Animatable Properties

Only whitelisted properties animate — the set every renderer can interpolate consistently. Everything else (e.g. `display`, text content, `.tw()` classes) snaps.

| Hypen prop | CSS property |
|------------|--------------|
| `opacity` | `opacity` |
| `translateX`, `translateY`, `scale`, `rotate` | `transform` |
| `color` | `color` |
| `backgroundColor` | `background-color` |
| `borderColor` | `border-color` |
| `cornerRadius` | `border-radius` |
| `padding` (+ `paddingTop`/`Bottom`/`Left`/`Right`/`Horizontal`/`Vertical`) | `padding-*` |
| `margin` (+ the same six directional forms) | `margin-*` |
| `width`, `height` | `width`, `height` |
| `gap` | `gap` |
| `fontSize` | `font-size` |

## Reduced Motion

When the platform reports `prefers-reduced-motion: reduce`, everything snaps with zero author code: transitions are neutralized, enter and layout animations are skipped, exits remove immediately, and `.animate` presets do not play (the shimmer overlay is removed entirely, so no static highlight lingers). No opt-out exists yet (`.motion(essential)` is planned).

## Renderer Support

Animation degrades gracefully by design: the animation channel rides along as reserved props that unaware renderers ignore.

| Renderer | `.transition` | `.enter` / `.exit` | `.layout` | `.animate` | Behavior |
|----------|---------------|--------------------|-----------|------------| ---------|
| DOM (web) | Yes — CSS transitions | Yes — removal deferred until exit settles | Yes — FLIP | Yes — CSS keyframes | Full support |
| Canvas 2D | Yes — numeric ticker (`cornerRadius` snaps) | Yes — removal deferred until exit settles | Snap (moves jump) | `pulse` / `spin` / `shake` (`shimmer` is static) | Near-full support — see the matrix below |
| iOS (SwiftUI) | Snap | Snap (instant removal) | Snap | Static | Ignores animation props |
| Android (Compose) | Snap | Snap (instant removal) | Snap | Static | Ignores animation props |
| Desktop (Vello) | Snap | Snap (instant removal) | Snap | Static | Ignores animation props |

"Snap" means the UI is identical, minus the motion — nothing errors, nothing leaks.

### Canvas 2D capability matrix

The Canvas renderer has no compositor, so it plays the animation channel with a per-frame numeric ticker inside the renderer (the engine never ticks). Every interpolated value is written into the node's **real props before layout and hit-testing run** — never a paint-only presentation offset — so animated geometry stays clickable while it moves. Easing uses the same shared numeric curve implementations as the DOM renderer's CSS, so both renderers trace identical curves.

| Channel | Capability | Canvas behavior |
|---------|-----------|-----------------|
| `.transition` | Numeric props (`opacity`, `translateX`/`Y`, `scale`, `rotate`, `width`, `height`, `gap`, `fontSize`, `padding*`, `margin*`) | Interpolated per frame. Size/spacing/font props re-solve layout every tick, so hit-testing follows the animated geometry. Mid-flight retargets continue from the current interpolated value. |
| `.transition` | Color props (`color`, `backgroundColor`, `borderColor`) | Interpolated in RGBA. Accepts hex (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`), `rgb()`/`rgba()`, and basic named colors; anything unparseable snaps. `borderColor` also re-runs layout (the canvas keeps border styling on the layout object). |
| `.transition` | `cornerRadius` | Snap. Canvas paint reads `borderRadius`, never the whitelist's `cornerRadius` key — there is nothing to interpolate honestly. |
| `.transition` | Non-interpolable values, `duration: 0`, malformed spec | Snap. |
| `.enter` | `fade`, `slide`, `scale` | Played (slide is RTL-aware). Same batch rules as DOM: initial render never cascades enters, a route restored from the Router cache reappears instantly. Caveat: canvas transforms are paint-time, so a sliding/scaling node hit-tests at its final layout box during the brief playback — identical to a static transform prop on this renderer. |
| `.exit` | `fade`, `slide`, `scale` | Teardown deferred until the exit settles, with a `duration + delay + 80ms` timeout backbone in case frames stall. The exiting subtree is excluded from hit-testing and scroll targeting immediately. A removal without an exit spec snaps. |
| `.layout` | FLIP on moves | Silent no-op — moves snap. Deliberate: the canvas layout engine owns geometry, and a transform-based FLIP would move pixels away from their hit targets mid-reorder. |
| `.animate` | `pulse`, `spin`, `shake` | Played via real `opacity` / `rotate` / `translateX` props, with keyframe shapes matching the DOM stylesheet. A changed spec restarts playback; finite-repeat presets never replay on a cached-route re-attach. |
| `.animate` | `shimmer` | Silent no-op (node renders static). The DOM implements shimmer as a gradient overlay; there is no honest prop-level canvas equivalent. |
| Any | Reduced motion | Everything snaps: transitions land their targets, enters are skipped, `.animate` never starts, exits remove immediately. The preference is live — toggling it mid-session snaps all in-flight motion. |
| Any | Unknown or malformed spec | Silent no-op. |

## Legacy: `.transition("...")` String Form (Deprecated)

The old web-only form passes a CSS shorthand straight through to `el.style.transition`:

```hypen
Text("Old style").transition("opacity 0.3s ease")   // deprecated
```

It still works on the DOM renderer (detected as a single quoted string containing whitespace) but logs a deprecation warning and means nothing on any other renderer. Prefer the portable form:

```hypen
Text("New style").transition(duration: 300, curve: easeOut, props: [opacity])
```

## Notes & Limits

- An exit-animating node still occupies layout until its animation settles; siblings shift when it is finally removed.
- Rapidly toggling an `If` shows the old node's exit and the new node's enter at the same time — correct, but visually doubled.
- Enter/exit animate the node the applicator sits on as one unit; children removed with their parent follow the parent's exit (a child's own `.exit` does not play).
