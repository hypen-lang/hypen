# Animation

Hypen animates through ten applicators — `.transition()`, `.enter()`, `.exit()`, `.layout()`, `.animate()`, `.states { }`, `.sharedElement()`, the `.scrub()`/`.settle()` pair, and the `.motion(essential)` reduced-motion opt-out — plus one completion event, `.onAnimationComplete()`, and one event argument, `animate:` (transaction-scoped animation — see its section below). Each declares *intent* on a node; the engine ships that intent to the renderer, which executes the motion natively (CSS transitions and keyframes on the DOM renderer; a per-frame numeric ticker on the Canvas renderer; a tick animator on desktop; SwiftUI's implicit animation on iOS; Compose animation on Android). A channel a renderer doesn't play simply snaps — your UI stays correct on every platform.

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

// Named visual states: one state path drives coordinated multi-prop looks
Image(src: "@{state.cover}")
    .width(100)
    .cornerRadius(4)
    .states(@state.cardState, transition: spring) {
        onState(collapsed).width(48).cornerRadius(8)
        onState(expanded).width(240).cornerRadius(16).tw("shadow-lg")
    }

// Shared-element continuity: the same key on two routes = one element across navigation
Image(src: "@{item.coverUrl}")
    .sharedElement("cover-@{item.id}")

// Drag between two poses; release writes the winning label back to state
Sheet { ... }
    .states(@state.sheetPhase) {
        onState(closed).translateY(400)
        onState(open).translateY(0)
    }
    .scrub(from: closed, to: open, over: [0, -400])
    .settle(bind: @state.sheetPhase)

// React when an animation finishes
Toast {}
    .enter(slide, from: bottom)
    .onAnimationComplete(@actions.toastSettled)  // payload: { animation: "enter" }
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

### Rapid toggling

Toggling an `If` off and back on before the exit finishes shows **both** nodes for a moment: the old node (engine-side already dead) plays its `.exit` while the new node — a fresh id — plays its `.enter` next to it. This is deliberate, and it is exactly what Framer Motion's `AnimatePresence` does in its default (`sync`) mode: an interrupted disappearance completes as an exit, a fresh appearance starts as an enter, and the two overlap rather than the new node teleporting into place or the corpse vanishing mid-fade. The doubled frame is the honest rendering of "it was leaving when you asked for it back."

If the doubling reads wrong for your UI, avoid the instant re-show: gate the re-show on the exit's `.onAnimationComplete`, debounce the driving state so a flicker never toggles the `If`, or restructure so the same *keyed* node stays mounted and animates with `.states` (a pose flip retargets in place — one node, never two).

## `.layout()` — Animate Reorders

When a keyed `ForEach` item moves, `.layout()` animates it from its old position to its new one (FLIP) instead of jumping.

```hypen
.layout()                                        // defaults: 300ms, spring
.layout(spring)
.layout(duration: 400, curve: easeInOut)
```

If the same reconciliation both moves and removes a node, the exit animation wins.

Removals shift siblings too: when a node is removed, its siblings that carry `.layout` FLIP from their pre-removal positions instead of snapping into the gap (DOM renderer; Canvas moves and removal shifts both snap — `.layout` is a sanctioned no-op there). For an exit-animated removal the siblings hold their places while the exit plays — the corpse still occupies layout — and FLIP at the moment it is finally torn down.

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
- Author-defined keyframe timelines are **rejected, not planned** (maintainer decision) — the built-in presets are the entire timeline surface. A `when:` trigger (`.animate(shake, when: ...)`) is not in v1 either. For "play on becoming true", put the preset on a node inside an `If` — it plays when the node enters:

```hypen
If(condition: @state.error) {
    Card { Text("@{state.error}") }.animate(shake)
}
```

- On a route restored from the Router cache, looping presets resume but finite-repeat presets (like `shake`) do **not** replay — same no-replay contract as `.enter`.
- While an enter, exit, or FLIP move plays on the same node, a preset animating the same properties (`pulse`, `spin`, `shake`) is paused so the two never fight; it resumes when the playback settles. `shimmer` runs on an overlay and is never paused.
- `shimmer` sets `position: relative` on the node to anchor its overlay; absolutely-positioned descendants of a statically-positioned node will re-anchor to it while shimmer runs.

## `.states { }` — Named Visual States

`.states` gives a node named *looks* selected by one state path — the coordinated-transition construct (Compose's `updateTransition`, Framer's `variants`). Instead of scattering ternaries across props, declare each pose once and flip a single state value; every overridden prop travels together, under one shared timing.

```hypen
Image(src: "@{state.cover}")
    .width(100)
    .cornerRadius(4)
    .states(@state.cardState, transition: spring, duration: 250) {
        onState(collapsed).width(48).cornerRadius(8).opacity(0.9)
        onState(expanded).width(240).cornerRadius(16).tw("shadow-lg")
    }
```

### Header

- The **first positional argument must be a state reference** (`@state.cardState`). Anything else — a literal, a missing argument — warns and ignores the whole applicator.
- Named arguments: `transition:` (a curve token — note the name, not `curve:`), `duration:` and `delay:` in milliseconds. Defaults: `easeOut`, 250ms, no delay.
- One `.states` per node; extras warn and are dropped.

### Poses

The block contains only `onState(<label>)` entries — the label is a bare identifier or a string, and the pose's props chain as applicators on the head. Anything else (a non-`onState` child, `onState` without a label, `onState` with a `{ }` body) warns and that entry is skipped; duplicate labels warn and the last one wins.

Pose applicators run through the **same machinery as normal applicator chains**, so `.tw("shadow-lg")`, directional forms (`.padding(top: 12)`), and breakpoint/state variants all work per pose. Three things are excluded inside a pose and warn + drop if used: animation applicators (`.transition`/`.enter`/`.exit`/`.layout`/`.animate`/nested `.states`), `.bind`, and event applicators (`onClick`, `onHover`, …). Pose values must be static — a `@{state.*}` binding inside a pose warns and drops that prop.

### Matching and fallback-to-base

At runtime the value at the driving path is **stringified and matched against the labels**: strings match as-is, numbers and booleans via their string form — state `2` matches `onState("2")` and state `true` matches `onState("true")` (quoted: a bare `true` lexes as a boolean, not a label). Then:

- **Matched pose** → its props apply, overriding the node's base chain (pose wins over base — the one precedence rule).
- **No matching pose** (unknown label, missing path, non-scalar value) → every overridden prop **falls back to the node's base value** from the rest of the applicator chain. A pose-only prop with no base value is removed entirely, as if never set.

`.states` is applied after everything else on the node regardless of where it sits in the chain, so "base" always means the chain's final values — a `.cornerRadius(4)` written after the `.states` block still wins as the fallback.

Prefer a plain conditional prop (`"@{state.x ? 32 : 18}"`) when exactly one prop changes; reach for `.states` when a *look* is several props that must move as one.

### Timing: the synthesized transition

`.states` synthesizes a `.transition` for the node from its `transition:`/`duration:`/`delay:` arguments, scoped to the overridden props that are in the animatable whitelist — so pose flips glide with zero extra declarations. Rules:

- An **explicit `.transition(...)` on the same node wins** over the synthesized one — write one to take manual control of timing and scoping. (The deprecated legacy string form `.transition("opacity 0.3s ease")` also counts as explicit: it suppresses synthesis with a warning, and pose switches then run on the author's CSS.)
- Overridden props **outside the animatable whitelist still switch — they just snap** (e.g. `.tw` classes).
- If nothing overridden is animatable, no transition is synthesized and everything snaps.

### Per-renderer behavior

A pose flip reaches renderers as ordinary `SetProp`/`RemoveProp` patches under the node's transition spec — there is no `.states` wire format and no renderer-side machinery. Consequences:

- **DOM** — pose flips glide via CSS transitions, exactly like hand-written `.transition` + prop changes.
- **Canvas 2D** — the numeric ticker interpolates them; the `.transition` capability matrix applies unchanged (colors interpolate in RGBA, `cornerRadius` snaps, etc.).
- **Desktop (Vello)** — the tick interpolator glides pose flips per the `.transition` matrix above (numeric + color; `cornerRadius` interpolates; uniform scale).
- **iOS (SwiftUI)** — pose flips glide through the same per-element implicit animation the `.transition` channel uses, so the engine-synthesized spec drives them for free.
- **Android (Compose)** — pose flips glide for free through the same animated prop resolution the `.transition` channel uses; the engine-synthesized spec drives them. The UI is always in the correct pose on every platform; only the motion differs.

The engine also ships the active label as the reserved `__anim.states` prop (`{"label": "expanded"}`, or `null` in the fallback-to-base pose) — animation-aware renderers use it to time the settle and stamp `.onAnimationComplete` payloads; renderers that ignore it lose nothing.

## `.sharedElement()` — Cross-Route Continuity

`.sharedElement(key)` tags a node as *the same visual element* across a navigation — the list-thumbnail-becomes-detail-hero effect. When a route change removes a keyed node from one screen and the next screen introduces a node with the same key, the incoming node animates from where the outgoing one sat (a transform FLIP) instead of appearing in place.

```hypen
// List route
Image(src: "@{item.coverUrl}")
    .sharedElement("cover-@{item.id}")

// Detail route
Image(src: "@{state.restaurant.coverUrl}")
    .sharedElement("cover-@{state.restaurant.id}", curve: spring, duration: 350)
```

### Syntax

- The **key is the first positional argument** and must be a string. It may contain template bindings (`"cover-@{item.id}"`) or be a pure state reference (`@state.heroKey`) — this is the **one animation argument where bindings are legal**, because identity is data: the key re-resolves whenever its driving state changes. A missing, empty, or non-string key warns and the whole applicator is ignored.
- `curve:` and `duration:` are named-only timing modifiers, defaults **350ms, `spring`**. The timing on the **incoming** (destination) node is the one that plays. Invalid timing falls back to the defaults; `delay:` is not accepted; extra positional arguments are ignored with a warning.

### How a match plays

The renderer runs a five-step protocol around any navigation batch (one that both detaches the outgoing route and attaches or inserts the incoming one):

1. **Measure the outgoing side.** Before the screen changes, the renderer snapshots the on-screen position and size of every keyed node leaving with the outgoing route. Keyed nodes in a persistent shell (outside the departing route) are never sources — a still-visible element can't animate away from itself.
2. **Apply the navigation.** The incoming route builds and lays out normally.
3. **FLIP the incoming side.** Each incoming node whose key matches a snapshot is posed over the source rect (translate + scale) and animates to its natural position with its own `curve:`/`duration:`.
4. **Degrade silently.** A key with no partner, or a source/target that can't be measured (scrolled away, hidden, zero-size), simply doesn't animate — the navigation is a plain route change. Nothing errors.
5. **Interruption retargets.** Navigating again mid-flight measures the element where it *currently is on screen* — the new FLIP continues from the animated position, never restarting from the original source.

If the same reconciliation also removes the incoming node, the exit wins — exiting nodes never become FLIP targets.

### The "one motion" rule

A matched node's own `.enter` is **suppressed** for that navigation — the element visually persisted across the route change, so playing an entrance would be a second motion on top of the FLIP. This holds even when the source and destination rects are identical (zero delta): nothing plays, but the match still counts — the enter stays suppressed and `.onAnimationComplete` fires `{ animation: "sharedElement" }` immediately, so a module machine waiting on the completion never stalls just because two screens happened to place the element identically.

### Dev-mode diagnostics

A shared key present on only one side of a navigation is silent by design (step 4) — but it is also exactly what a typo looks like. The renderer logs a warning at the default log level the **first** time each key matches nothing, and likewise once per key for duplicate keys within one navigation (the first occurrence wins). A key whose node simply persisted across the navigation, or a matched node without a timing spec, is neither a match nor a typo and does not warn.

### v1 limits

- **Transform-only continuity.** The FLIP interpolates position and size. Corner radius and opacity do not interpolate, and there is no content crossfade — if the two nodes' content differs, the incoming content appears at the source geometry and travels. Pairs that mostly match visually (same image, similar radius) look seamless; wildly different pairs look like what they are: one element morphing in size.
- **No overlay proxy.** The incoming element itself animates; the outgoing element is not kept visible or resurrected during the flight.
- **Approximate under rotated/scaled bases.** The inverted transform is prepended to the node's own base transform and its transform-origin is pinned for the flight; that is exact for untransformed and translated nodes, approximate when the node's base transform rotates or scales it.
- **DOM and desktop.** The native desktop (Vello) renderer also plays shared-element FLIPs, with narrowings: transform-only continuity, a single **uniform** scale factor (the DOM's independent `(sx, sy)` averages — exact when aspect is preserved), and a **global** reduced-motion skip (no `.motion(essential)` exemption). The Canvas, iOS, and Android renderers ignore the props — a plain navigation (see the renderer table below). Under reduced motion nothing is measured and nothing plays, everywhere.

## `.scrub()` / `.settle()` — Gesture and Scroll Bindings

`.scrub()` binds a node's position *between two of its `.states` poses* to a continuous input — the finger dragging a bottom sheet, the scroll offset collapsing a header. The interpolation runs entirely inside the renderer, frame by frame, with **zero engine traffic while the input is live**; the engine hears exactly one thing, at the end: `.settle()` writes the winning pose label to a state path, as one ordinary state write your module handles like any other.

```hypen
// Upward-opening bottom sheet: 400px of upward finger travel = closed → open
Sheet { ... }
    .states(@state.sheetPhase) {
        onState(closed).translateY(400)
        onState(open).translateY(0)
    }
    .scrub(from: closed, to: open, axis: y, over: [0, -400])
    .settle(curve: spring, duration: 300, bind: @state.sheetPhase)

// Collapsing header driven by the scroll container's offset
Header { ... }
    .states(@state.headerMode) {
        onState(expanded).height(120)
        onState(collapsed).height(48)
    }
    .scrub(from: expanded, to: collapsed, source: scroll, axis: y, over: [0, 120])
    .settle(bind: @state.headerMode)
```

### Syntax

Both applicators take **flat named arguments only** (the family rule — nested calls like `gesture(axis: y)` are not valid Hypen):

- `.scrub(from:, to:, source:, axis:, over:, rubberBand:, of:)`
  - `from:` / `to:` — **required.** Two pose labels from the *same node's* `.states` block: `from:` is the pose at progress 0, `to:` at progress 1.
  - `source:` — `gesture` (default; pointer travel on the node itself) or `scroll` (a scroll container's offset).
  - `axis:` — `x` or `y` (default `y`).
  - `over:` — **required.** The *directed* input range `[inputAtProgress0, inputAtProgress1]` in pixels of gesture travel or scroll offset. Direction matters — it is not a min/max pair: an upward-opening sheet uses `over: [0, -400]` (400px of *upward* travel takes progress 0 → 1). Only equal or non-finite endpoints are rejected.
  - `rubberBand:` — resistance factor 0..1 applied beyond the range (default 0.4; 0 = hard clamp). Out-of-range values clamp with a warning.
  - `of:` — scroll source only: names the scroll container by its `id` prop. On a gesture source it warns and is ignored; if it matches no ancestor, the renderer warns once and falls back to the nearest scrollable ancestor.
- `.settle(curve:, duration:, bind:)`
  - `curve:` / `duration:` — the release animation's timing, defaults `{spring, 300ms}` (no `delay:`).
  - `bind:` — **required.** A `@state.*` reference — the same path convention as the `.bind()` applicator. The winning pose label is written here.

### The model

- **Dragging interpolates renderer-side.** The engine materializes both endpoint values for every prop the `from`/`to` poses override (pose override, else the node's static base value) at lowering time, so the renderer can interpolate every frame without asking the engine anything. A prop that resolves on only one end warns and is excluded (it still flips with the pose — it just snaps under scrub).
- **Release settles to the nearest pose.** The release velocity (from the last ~5 pointer samples; samples older than ~100ms are discarded as stale) projects the progress ~150ms forward; projected progress ≥ 0.5 lands on `to`, otherwise `from`. The settle animation plays locally with the `.settle` timing, re-driving the exact interpolation path the drag used, so drag and settle are pixel-consistent.
- **Arrival is one ordinary state write.** The winning label is dispatched through the same channel `.bind()` uses. Your module sees a normal state change — a machine that also flips the same path from buttons or actions keeps working unchanged; the gesture is just another input device writing state.

### Gesture behavior

- **Taps pass through.** A gesture claims the pointer only after ~6px of travel along the axis — a plain tap is a total no-op: no capture, no settle, no state write, and clicks on children are unaffected. (One exception: grabbing a *mid-settle* element claims immediately — the settle must not fight your finger.)
- **Drags start from where the element is.** The mapping is relative to the pose the finger grabbed: a settled-open sheet re-drags from progress 1, a sheet caught mid-settle continues from its current progress, and `over:` ranges that don't start at 0 never jump. The anchor tracks the node's `.states` label, so a pose flipped by module code is picked up too.
- **Beyond the range, rubber-band.** Progress past 0 or 1 is resisted by the `rubberBand:` factor and springs back on release.
- **One finger drives the drag.** Only the claiming pointer's move/up/cancel events matter — a second finger is noise (v1).

### Scroll behavior

- Progress tracks the container's offset continuously through `over:` — there is no "release".
- The `bind:` write fires when progress crosses **and rests at** an endpoint (~150ms debounce at progress 0 or 1); moving back inside the range cancels it, and the same endpoint is never re-written for one rest.
- **Live data still updates.** Mid-range, scrub ownership is bounded by *active input*: after ~150ms of scroll quiescence, deferred engine writes flush and ownership releases — a collapsing header can't dam up sibling updates just by sitting still. The next scroll event re-claims and re-derives the scrub styles from current progress.

### Conflicts and precedence

**Precedence: scrub > structural playbacks > transaction > node `.transition`.**

- While a drag, settle, or post-settle window is active, engine writes to the scrubbed prop keys are deferred (latest value kept, applied at cleanup) — the live gesture always wins. All other props flow normally.
- A scrub-active node is excluded from transaction (`animate:`) application and enter/FLIP participation, and a conflicting `.animate` preset is suspended while scrubbed, resuming after.
- A removal or route detach mid-drag cancels everything cleanly — pointer capture released, no state write from a dead interaction. An exiting node's scrub sources detach *before* any exit playback; a cached-route re-attach re-arms scroll sources.
- Static transforms survive: a `.rotate(45)` applicator on the node composes with the scrub's transform lanes instead of vanishing mid-drag.

### The settle write and `.onAnimationComplete`

After the settle write, the final inline styles are held until the engine's re-render lands (no flash) — cleanup runs on the first `.states` label update from the engine, with a ~500ms fallback. The write flips the `.states` pose like any other state change, so the node's synthesized states transition applies (visually a no-op — the element is already there) and **`.onAnimationComplete` fires the normal `{ animation: "states", state: "<label>" }` completion**. Scrub and settle fire no completion event of their own — the states flip is the observable end.

### Reduced motion

Dragging works unchanged — direct manipulation is the user's own hand, not decorative motion. The release settles **instantly** (no animation), then writes.

### Requirements and degradation

`.scrub` requires, on the same node: a `.states` block declaring **both** the `from:` and `to:` labels, and a `.settle(bind: @state.…)`. Any hard violation — unknown pose label, missing/invalid `over:`, missing `.settle` or its `bind:`, no `.states` block — warns **once**, naming the reason, and the node degrades to plain `.states` behavior; never an error. A `.settle` without a `.scrub` warns and is ignored; one `.scrub`/`.settle` per node (extras warn and drop).

The pair lowers to four reserved props (`__anim.scrub`, `__anim.scrubSettle`, `__anim.scrubBind`, `__anim.scrubPoses` — the materialized endpoint values). **DOM and desktop in v1**: the native desktop (Vello) renderer also scrubs, via a renderer-resident scrubber driven off winit pointer/wheel events, with narrowings — winit's single OS cursor stands in for per-element pointer capture, multi-touch is moot (one cursor), and only numeric + color pose endpoints interpolate. The Canvas, iOS, and Android renderers ignore all four — the node still shows the correct pose whenever the bound state changes by other means; only the direct manipulation is missing.

## `.onAnimationComplete()` — Completion Events

`.onAnimationComplete(@actions.name)` dispatches an action when an animation on the node finishes — the piece that lets a module sequence motion ("when the enter settles, advance the phase") without `setTimeout` guesses that drift from real durations.

```hypen
.onAnimationComplete(@actions.animationDone)
.onAnimationComplete(@actions.animationDone, source: "card")   // extra args merge into the payload
```

It is an ordinary event applicator — same dispatch channel as `onClick`, no new syntax, and nodes without it pay zero overhead.

### Firing points and payloads

| Playback | Fires | Payload |
|----------|-------|---------|
| Finite `.animate` preset (e.g. `shake`, `repeat: 3`) | when the last iteration ends | `{ animation: "shake" }` (the preset name) |
| `.enter` | when the enter settles | `{ animation: "enter" }` |
| `.exit` | when the exit settles, just before teardown | `{ animation: "exit" }` |
| `.states` pose transition | when the synthesized (or explicit) transition's duration + delay elapses | `{ animation: "states", state: "expanded" }` (the matched label) |
| `.sharedElement` FLIP (DOM only) | when the FLIP settles — or immediately on a zero-delta match (nothing to play *is* an instant natural settle) | `{ animation: "sharedElement" }` |

Extra named arguments on the applicator merge into the payload; the `animation`/`state` fields always win over same-named custom args.

### The natural-settle-only rule

A completion fires **only when a playback settles naturally**. Everything else fires *nothing*:

- **Interrupted or superseded** — an enter cut short by an exit, a `.states` window superseded by another pose flip, a preset restarted by a spec change.
- **Reduced motion** — nothing played, so nothing completes.
- **Looping presets** (`pulse`, `spin`, `shimmer` at their defaults) — never complete.
- **`.states` falling back to the default pose** (no matched label) — there is no label to report.
- **Off-screen playbacks** — a node inside a Router-cached (detached) or exit-animating subtree.

**Routing.** Every renderer dispatches a completion as a node-addressed `__hypen_dispatch` envelope (`{node, action, payload}`), so the engine resolves the owning module from the node, which matters in multi-module apps. An exit completion arrives after the engine has removed the node, so when the engine emits the `transition: true` Remove for an exiting root that carries `.onAnimationComplete`, it keeps a small tombstone of that node's module and action (the last 128). A completion addressed to the removed root is accepted for that one action only; any other action on the removed id, a descendant, a plain removal or a Router-detached subtree stays inert, and the agent surface (`dispatch_external`) gains nothing from it.

This is deliberate: it removes most completion races by construction. The remaining race — state advanced again before a completion arrives — is handled by the payload carrying the animation name and pose label, so a handler simply drops completions for phases it has already left (latest-wins).

### The module-machine pattern

Completion events exist to drive *state machines in module code*: the DSL declares the poses, the module owns the transition logic, and `.onAnimationComplete` is the "timeline ended" input.

```hypen
Button("@actions.save") {
    Text("@{state.savePhase == 'done' ? 'Saved!' : 'Save'}")
}
.width(160)
.backgroundColor("#3b82f6")
.states(@state.savePhase, transition: easeOut, duration: 300) {
    onState(saving).opacity(0.6)
    onState(done).backgroundColor("#22c55e").width(48).cornerRadius(24)
}
.onAnimationComplete(@actions.animationDone)
```

```typescript
export default app
  .defineState<{ savePhase: string }>({ savePhase: "idle" })
  .onAction("save", async ({ state }) => {
    state.savePhase = "saving";
    await save();
    state.savePhase = "done";            // pose flip → transition plays → completion fires
  })
  .onAction("animationDone", ({ action, state }) => {
    // Advance only on the completion you expect — a stale completion for an
    // abandoned phase carries the wrong label and falls through harmlessly.
    if (action.payload.animation === "states" && action.payload.state === "done") {
      state.savePhase = "idle";          // no `idle` pose declared → back to the base look
    }
  });
```

### Per-renderer behavior

The DOM renderer implements all five firing points; the native desktop (Vello) renderer likewise dispatches all five (`sharedElement` included). The Canvas, iOS, and Android renderers implement the first four with identical payloads (`sharedElement` never fires on any of them — none plays shared-element FLIPs). Interrupted, superseded, and reduced-motion-skipped playbacks fire nothing everywhere. Treat completions as motion choreography, not as the only path to a correct end state: a machine like the one above still lands in a sensible pose everywhere — a channel a renderer snaps (e.g. `.layout` on mobile) just skips its timed hop.

## `animate:` — Transaction-Scoped Dispatch Animation

Every construct above animates the *node* — declare `.transition` on it and its prop changes glide no matter who caused them. `animate:` animates the *cause*: the same state change can glide when a user tap produced it and snap when a websocket refresh did. It is SwiftUI's `withAnimation` idea mapped onto Hypen's dispatch pipeline — the animation rides the action, not the element.

```hypen
Button("@actions.toggleCart") { Text("Cart") }
    .onClick(@actions.toggleCart, animate: spring)

Row {}.onClick(@actions.expand, animate: {curve: easeOut, duration: 400})
```

- Any event applicator accepts `animate:` as a named argument (it also covers keyboard activation of the same action).
- The value is a bare curve token (`spring`, `easeOut`, …) or a spec map — the same shape as the `.transition` channel (`curve:`, `duration:` in ms; `delay:` and `props:` also work). A bare token means `{curve: token, duration: 250}` — the engine fills the 250ms default on maps too. An unknown bare curve token, or a value that is neither a token nor a map, warns and the dispatch proceeds unstamped (snap) — never an error.

### Semantics: your action's patches glide; everything else snaps

The stamp rides that one dispatch. The **first** state flush the handler produces is stamped, and every whitelisted prop change it causes glides with the stamp's spec — on *every affected node*, whether or not the node declares a `.transition` of its own. Anything the action did *not* cause — a websocket push, a timer, another module's mutation — is unstamped and snaps, exactly as before. The guarantee is precise enough to hold mid-glide: an unstamped write that lands on a still-gliding prop snaps *immediately* (the node's own transition styling is restored first), so a data refresh can never be smeared by a stale tap's spec.

A handler that never mutates stamps nothing, and a stamped update whose diff turns out empty emits nothing — there is no stamp without patches.

### What's stamped: synchronous mutations only

The stamp covers the handler's synchronous mutations — everything up to the first flush. Mutations after an `await` are unstamped and snap:

```typescript
.onAction("toggleCart", async ({ state }) => {
  state.cartOpen = !state.cartOpen;   // stamped — glides with the animate: spec
  state.badgeCount += 1;              // same flush — glides too
  await syncCart();                   // the stamp is gone by the time this resumes
  state.lastSynced = Date.now();      // unstamped — snaps
});
```

Why the line sits exactly there: the synchronous mutations queue their state flush as a microtask *during* the handler call, and the stamp is cleared one microtask after the handler's synchronous portion returns — so the first flush always wins the race, and any awaited continuation (which resumes strictly later) always loses it. This is deliberate: "the visual response to the tap" is the synchronous mutation; whatever arrives after an await is data, and data snaps.

Two edge rules, both in the tap-glides/refresh-snaps spirit:

- Mutations already queued when a stamped dispatch arrives (e.g. a `.bind` write earlier in the same task) are flushed *before* the stamp is set — they go out with the stamp of the dispatch that caused them, or none. A tap can never animate mutations it didn't cause.
- If two stamped dispatches land before either handler flushes, the **last** dispatch's spec wins — its stamp replaces the unconsumed one.

### Precedence

**Structural playbacks > transaction > node `.transition` > snap.**

- A node mid enter, exit, FLIP, or shared-element playback is left out of the transaction entirely — a stamped batch never retargets or freezes an in-flight structural animation.
- On everything else, the transaction spec overrides the node's own `.transition` for the props the stamped batch actually writes (only those — props the batch didn't touch keep their normal behavior). When the glide settles, the node's own transition styling is restored — including the deprecated legacy string form, which is captured and restored verbatim.
- Back-to-back stamped dispatches retarget each other's glides seamlessly.

Transaction glides fire no `.onAnimationComplete` — completions belong to node-level playbacks.

### Renderer and host support

Every animating renderer honors the stamp: the DOM renderer via scoped CSS transitions, the Canvas renderer by using the spec as its tick-interpolation spec (its usual capability matrix applies — e.g. `cornerRadius` still snaps there), the native desktop (Vello) renderer through its tick animator (it consumes the engine's `batchAnimation` patch directly, not via UniFFI), and the iOS (SwiftUI) and Android (Compose) renderers as a per-batch spec consulted by their animated prop resolution — honored at batch index 0 only, under the same precedence chain. Renderers that don't recognize the prelude ignore it; the batch is wire-identical to an unstamped one otherwise.

`animate:` **stamping is TypeScript-host-only** for now: it stamps on the browser engine and on Node/Bun remote servers, and a TS-hosted stamp reaches every remote client — including the mobile renderers. On Go and Kotlin hosts the dispatch works and handlers run normally — the reserved key that carries the stamp is stripped before handlers see the payload, so it never leaks into user code — but nothing stamps and the resulting flush snaps. (Go's state-sync path notifies synchronously per mutation and has no animation envelope; honest stamping there is tracked separately — see `hypen-golang/CHANGELOG.md`.) The UniFFI boundary carries the prelude (`spec_json` on the flat `Patch` record) and the `Remove.transition` flag, and the Kotlin and Swift hosts relay both — but `update_state` has no animation parameter over FFI, so mobile hosts can relay engine-raised preludes, not originate one.

### Reduced motion

Stamps are ignored entirely under `prefers-reduced-motion: reduce` — stamped batches snap like everything else.

### The reserved argument is `animate:`, nothing else

Only the event applicator's own **named** `animate:` argument is reserved. A field named `animate` inside a positional payload object is ordinary user data and reaches the handler untouched:

```hypen
.onClick(@actions.save, animate: spring)          // stamp — the handler never sees it
.onClick(@actions.save, {animate: false})         // payload — arrives as action.payload.animate
```

The named argument is extracted *before* positional payload objects are merged, so the two never collide.

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
| `.states()` | 250ms | `easeOut` | curve is named `transition:`; synthesized spec scoped to the overridden animatable props |
| `.sharedElement()` | 350ms | `spring` | key is the first positional; no `delay:` |
| `.scrub()` + `.settle()` | settle: 300ms | settle: `spring` | `.scrub`: `source: gesture`, `axis: y`, `rubberBand: 0.4`; `from:`/`to:`/`over:` required. `.settle`: `bind:` required; no `delay:` |

All of them accept `duration:` (milliseconds) plus a curve — named `curve:` everywhere except `.states`, which names it `transition:` — and all but `.sharedElement` and `.settle` also accept `delay:`. (`.scrub` itself carries no timing at all — its motion is the input.) Animation arguments must be static — state bindings inside them are ignored with a warning — with one exception: the `.sharedElement` key, where bindings are the point (identity is data). Invalid arguments never break the render; they fall back to the defaults above (except an unknown `.animate` preset, which omits the animation, and a `.states` without a state reference or a `.sharedElement` without a key, which ignore the whole applicator).

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

When the platform reports `prefers-reduced-motion: reduce`, everything snaps with zero author code: transitions are neutralized, enter and layout animations are skipped, exits remove immediately, and `.animate` presets do not play (the shimmer overlay is removed entirely, so no static highlight lingers).

### `.motion(essential)` — the opt-out

The rare animation that *carries meaning* — a progress indicator, a status pulse, a countdown — can opt out per node:

```hypen
Spinner {}.animate(spin).motion(essential)
```

- `essential` is the **only** valid token; anything else (or a missing token) warns and the applicator is omitted — there is no "non-essential" marker to write.
- On a flagged node the animation-aware renderers behave exactly as if the preference were off: transitions glide, enters play, exits defer, presets run, `.states` completions fire, transaction (`animate:`) stamps apply, and a `.scrub` release settle animates. Everything *without* the flag keeps snapping.
- Removing the flag (a conditional `.motion` value resolving away) reverts the node to the default snap behavior immediately.
- Shared-element FLIPs remain skipped under reduced motion everywhere — cross-route continuity is inherently decorative.
- It lowers to the reserved `__anim.motion` prop (`{"essential": true}`); renderers that don't animate ignore it like every other channel. Use it sparingly — it exists for meaning-bearing motion, not for overriding a user preference wholesale.

## Renderer Support

Animation degrades gracefully by design: the animation channel rides along as reserved props that unaware renderers ignore.

| Renderer | `.transition` | `.enter` / `.exit` | `.layout` | `.animate` | `.states` | `.sharedElement` | `.scrub` / `.settle` | `.onAnimationComplete` | Behavior |
|----------|---------------|--------------------|-----------|------------|-----------|------------------|----------------------|------------------------|----------|
| DOM (web) | Yes — CSS transitions | Yes — removal deferred until exit settles | Yes — FLIP | Yes — CSS keyframes | Yes — pose flips glide | Yes — cross-route FLIP | Yes — drag/scroll scrubbing + settle write | Yes — all five firing points | Full support |
| Canvas 2D | Yes — numeric ticker (`cornerRadius` snaps) | Yes — removal deferred until exit settles | Snap (moves jump) | `pulse` / `spin` / `shake` (`shimmer` is static) | Yes — per the `.transition` matrix | Ignores the props (plain navigation) | Ignores the props (poses still flip via state) | Yes — four firing points (no `sharedElement`) | Near-full support — see the matrix below |
| Desktop (Vello) | Yes — tick interpolator (transforms + hit-testing follow) | Yes — removal deferred until exit settles | Yes — FLIP (same-redraw removal-sibling shift snaps) | `pulse` / `spin` / `shake` (`shimmer` snaps) | Yes — pose flips glide | Yes — cross-route FLIP (transform-only, uniform scale, reduced-motion skip) | Yes — drag/scroll scrubbing + settle write (single OS cursor) | Yes — all five firing points | Full parity — see the desktop matrix below |
| iOS (SwiftUI) | Yes — per-element implicit animation (pinned curves) | Yes — removal deferred until exit settles | Snap (moves jump) | `pulse` / `spin` / `shimmer` / `shake` (one-sided shake) | Yes — pose flips glide | Ignores the props (plain navigation) | Ignores the props | Yes — four firing points (no `sharedElement`) | Daily-driver channels supported — see the iOS matrix below |
| Android (Compose) | Yes — animated prop resolution (sRGB color lerp) | Yes — removal deferred until exit settles | Snap (moves jump) | `pulse` / `spin` / `shimmer` / `shake` | Yes — pose flips glide | Ignores the props (plain navigation) | Ignores the props | Yes — four firing points (no `sharedElement`) | Daily-driver channels supported — see the Android matrix below |

"Snap" means the UI is identical, minus the motion — nothing errors, nothing leaks. `.states` needs no renderer support at all (pose flips are ordinary prop patches), which is why even snapping renderers always show the correct pose.

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
| `.sharedElement` | Cross-route FLIP | Silent no-op — navigations are plain route changes. The identity/timing props are ignored. |
| `.scrub` / `.settle` | Gesture/scroll scrubbing | Silent no-op — all four `__anim.scrub*` props are ignored (no playback, no listeners, no engine traffic). The node still flips poses whenever the bound state changes by other means. |
| Any | Reduced motion | Everything snaps: transitions land their targets, enters are skipped, `.animate` never starts, exits remove immediately. The preference is live — toggling it mid-session snaps all in-flight motion. Nodes flagged `.motion(essential)` are exempt per node (see the Reduced Motion section). |
| Any | Unknown or malformed spec | Silent no-op. |

### Desktop (Vello) capability matrix

The native desktop renderer has **full animation parity** with the DOM renderer, implemented as a tick-based twin of the Canvas animator (`hypen-renderer-desktop/src/anim.rs` — the capability matrix there is the source of truth). The window's demand-driven redraw loop is the clock (the engine never ticks); every interpolated value — transforms included — is written into the real node props that Taffy layout and hit-testing read, so pointer, wheel, AccessKit, and caret targeting follow the animated geometry. It plays `.transition`, `.enter`/`.exit`, `.layout` FLIP, `.animate`, `.states`, `.sharedElement`, `.scrub`/`.settle`, `animate:` transaction stamps, and dispatches all five `.onAnimationComplete` firing points. The recorded v1 narrowings:

| Channel | Desktop behavior |
|---------|------------------|
| `.transition` | Numeric + color props interpolate (`cornerRadius` interpolates too, unlike Canvas). Transform props (`translateX`/`translateY`/`scale`/`rotate`) feed a per-item affine consumed by paint AND hit-testing. |
| `.scale` / transforms | **Uniform scale only** — the affine has a single scale factor, so the DOM's independent `(sx, sy)` collapses to their average (exact when aspect is preserved). Composition follows the DOM/CSS order (translation outside scale/rotate), not the Canvas order. |
| `.animate` `shimmer` | **Snaps** — a DOM gradient-overlay effect with no honest desktop equivalent (the one remaining no-op; `pulse`/`spin`/`shake` play). |
| `.layout` removal-sibling FLIP | Plays, **except** when an exit finalizes in the same redraw as a non-empty patch batch (the cached pre-teardown layout is already gone) — those siblings snap. The idle-frame path FLIPs correctly. |
| `.sharedElement` | Transform-only continuity (no corner-radius/opacity interpolation, no content crossfade, no overlay proxy), **uniform scale**, and a **global reduced-motion skip** (no `.motion(essential)` exemption — cross-route continuity is decorative). |
| `.scrub` / `.settle` | winit's single OS cursor stands in for per-element pointer capture; **multi-touch is moot** (one cursor); only **numeric + color pose endpoints** interpolate (a non-interpolable pose pair snaps). |
| Reduced motion | Gated by the `HYPEN_REDUCED_MOTION` env var + a programmatic setter (no reliable cross-platform OS query exists), not `matchMedia`. The per-node `.motion(essential)` opt-out works as elsewhere. |

### iOS (SwiftUI) capability matrix

The iOS renderer plays the daily-driver channels natively: SwiftUI's own animation system is the interpolator (the engine never ticks), driven by a per-element implicit `.animation(_:value:)` whose animation the renderer resolves per patch batch through the normative precedence chain (structural > transaction > node `.transition` > snap). Curves are the pinned CSS beziers, and `spring` is the fixed overshoot bezier `cubic-bezier(0.34, 1.56, 0.64, 1)` — **not** SwiftUI's physics spring. The recorded v1 narrowings:

| Channel | iOS behavior |
|---------|--------------|
| `.transition` | Whitelisted prop changes glide on the resolved animation. SwiftUI's implicit animation is view-scoped rather than property-scoped, so a batch that changes both an in-scope and an out-of-scope prop on the same node animates both; a scoped spec still correctly ignores out-of-scope changes as a *trigger*. |
| `.enter` / `.exit` | Played as `opacity` / `offset` / `scale` poses (`fade` / `slide` 24pt / `scale` 0.95), with the deferred-remove contract: the subtree stays alive and in layout, is excluded from hit-testing, event dispatch and accessibility immediately, and finalizes on the `duration + delay + 80ms` backbone. Focus/IME exclusion is a best-effort first-responder resign when the exiting subtree contains an input. |
| `.layout` | Snap — moves jump. Not implemented in v1. |
| `.animate` | `pulse` / `spin` / `shimmer` play with the normative timing; **`shake` is one-sided** (0 → 6pt) because SwiftUI's autoreversing repeat bounces between two endpoints only — same amplitude, duration and repeat count as the DOM's ±6/±4px oscillation. |
| `.sharedElement`, `.scrub` / `.settle` | Ignored — plain navigation, no gesture scrubbing. Not implemented in v1. |
| `.onAnimationComplete` | Four firing points (`enter`, `exit`, `states`, finite `<preset>`) with DOM payload parity. Settles are timer-derived rather than callback-derived, so an interrupted playback is superseded by cancelling its timer. |
| Reduced motion | `accessibilityReduceMotion` (the SwiftUI environment in views, `UIAccessibility`/`NSWorkspace` at patch-apply time). Everything snaps and flagged removes finalize synchronously; the per-node `.motion(essential)` opt-out works as elsewhere. |

### Android (Compose) capability matrix

The Android renderer plays the daily-driver channels natively (the capability matrix in `hypen-web/docs/animation.md` is the source of truth). Interpolated values are written back onto the element as animation overrides, so every whitelisted prop animates through its existing applicator/component — and because motion stays in Compose modifiers, hit targets, focus, and TalkBack follow the pixels for free. Curves are the pinned CSS beziers built as explicit `CubicBezierEasing` instances — `spring` is the fixed overshoot bezier `cubic-bezier(0.34, 1.56, 0.64, 1)`, **not** Compose's physics `spring()`. The recorded v1 narrowings:

| Channel | Android behavior |
|---------|------------------|
| `.transition` | All whitelisted props glide. Colors interpolate in straight sRGB (matching DOM/Canvas — **not** Compose's Oklab `Color.lerp`); unparseable endpoints or a unit change (`50%` → `200px`) snap. |
| `.enter` / `.exit` | Played as a `graphicsLayer` pose (alpha + translation + scale), deliberately **not** `AnimatedVisibility` — the exiting node keeps occupying layout until finalize, per the shipped contract. Full deferred-remove protocol: root-first ordering, descendant deferral, finalize on natural settle or the `duration + delay + 80ms` backbone. An exiting subtree is excluded on four planes immediately: pointer events, action dispatch, TalkBack semantics, and focus (the soft keyboard dismisses). |
| `.layout` | Parsed, snapped — moves jump (sanctioned; `Modifier.animateItem` only works in Lazy containers, `LookaheadScope` is roadmap). |
| `.animate` | All four presets play, `shimmer` included (gradient overlay). Looping presets never complete; a cached Router attach never replays a finite repeat; presets yield to an in-flight enter/exit on the same node. |
| `animate:` (transaction) | Honored at batch index 0 only, as a per-batch spec (Compose has no ambient transaction). Precedence `structural > transaction > node .transition > snap`; same-batch-created, exiting, and mid-playback nodes are excluded. |
| `.sharedElement`, `.scrub` / `.settle` | Ignored — plain navigation, no gesture scrubbing. Not implemented in v1 (stage 2: `SharedTransitionLayout` across the Detach/Attach seam). |
| `.onAnimationComplete` | Four firing points (`enter`, `exit`, `states`, finite `<preset>`) with DOM payload parity, natural settle only; completion fields are written last so custom args can't shadow them. |
| Reduced motion | `Settings.Global.ANIMATOR_DURATION_SCALE == 0` ("Remove animations") with a live `ContentObserver` — a mid-session toggle takes effect without reconnect. Developer duration scales (0.5×/5×) are deliberately not applied — playbacks and the finalize backbone time off the same unscaled numbers. The per-node `.motion(essential)` opt-out works as elsewhere. |

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

- An exit-animating node still occupies layout until its animation settles; siblings shift when it is finally removed. On the DOM renderer, siblings that carry `.layout` animate that shift (a FLIP from their pre-shift positions — for a plain removal it plays with the removal, for an exit-animated one when the exit finalizes); siblings without `.layout` snap.
- Rapidly toggling an `If` shows the old node's exit and the new node's enter at the same time — correct, but visually doubled. See "Rapid toggling" under `.enter()` / `.exit()` above.
- Enter/exit animate the node the applicator sits on as one unit; children removed with their parent follow the parent's exit (a child's own `.exit` does not play).
