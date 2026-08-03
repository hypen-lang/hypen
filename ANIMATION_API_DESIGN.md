# Animation API Design — DX Exploration

Status: **Layers 1–7 implemented** — Options A + B, the presets-only slice
of Option E, Option C (`.states { onState(...) }` named visual states), the
`.onAnimationComplete` completion-event slice of Option F, Option H
shared-element transitions (`.sharedElement`), the **cheap subset of
Option D** transaction scope (`animate:` on event applicators, stamped onto
the patch batch via a `batchAnimation` prelude), and **Option G scrub
bindings** (`.scrub`/`.settle` between `.states` poses, renderer-resident)
are shipped (engine + DOM renderer + Canvas 2D renderer for A/B/C/D/E/F;
H and G are DOM-only so far — Canvas, iOS, Android, and desktop snap by
ignoring the new props/flag/prelude, which for H means a plain navigation
and for G a node that flips poses only when its bound state changes by
other means, and never dispatch completions; D's stamping is additionally
**TS-host-only** — Go and Kotlin hosts strip the dispatch stamp, see the
host matrix in §3).
The normative as-shipped surface is the *Shipped v1* section in §3 —
including the Canvas parity note recording what still snaps there (`.layout`
FLIP, `cornerRadius`, `shimmer`), the as-shipped H contract recording its
v1 cuts against the normative §H protocol, the as-shipped D contract
(wire prelude, binding signatures, stamp lifecycle, precedence, host
matrix), and the as-shipped G contract (four wire props, the interaction
formulas, and its v1 narrowings); author-defined `animation` blocks are
**rejected** (maintainer decision — no custom keyframe DSL; presets are
the timeline surface); C's stagger/group envelope and `.inState` chain
form stay deferred, and **D's full SDK `animate()` block is the sole
remaining proposal item**.
Scope: how animation should *look and feel* in the Hypen DSL and module SDK, what
each candidate shape costs us architecturally, and what we should learn (and
refuse to repeat) from CSS, React, Android, SwiftUI, and Rive.

---

## 1. Constraints that shape everything

Before comparing APIs, five facts about Hypen bound the design space:

1. **One patch stream, five renderers.** DOM, Canvas 2D, SwiftUI, Android, and
   desktop (Vello) all consume the same `Patch` enum. Whatever we design must be
   expressible as *declared intent* that each renderer executes natively (CSS
   transitions, `Animator`, SwiftUI animations, a rAF/vsync ticker). The engine
   must **never tick frames itself** — emitting `SetProp` per frame across the
   WASM boundary at 60–120 Hz is a non-starter.

2. **The DSL is purely declarative; applicators are the idiom.** Styling is
   `.padding(16)`, `.tw("...")`. Any animation syntax that doesn't read like an
   applicator chain will feel foreign. The AST *modeled* applicators with
   block bodies from the start (`ApplicatorSpecification.children`) — but,
   contrary to what this constraint originally claimed, the grammar could not
   parse them, so `.states { ... }` did require grammar work. *(Since
   shipped: the applicator-block production landed with Option C — any
   applicator may take a `{ }` block of full component children, and the
   chain may continue after the block — see Shipped v1 in §3.)*

3. **State is the only dynamic input.** Everything visual derives from
   `@{state.*}` through path-based dependency tracking. Animation is therefore
   fundamentally about *how a visual property travels between two states the
   reconciler already computes* — we never need a parallel "animated value"
   world like React does.

4. **`Remove` is eager.** The DOM renderer detaches the node from its parent the
   moment the patch arrives. Exit animations are structurally impossible today;
   any serious proposal needs a patch-protocol extension (deferred remove), not
   just syntax. *(Since shipped: an optional `transition` flag on `Remove` —
   see Shipped v1 in §3.)*

5. **What exists today is web-only string passthrough.** The
   `.transition("opacity 0.3s ease")` applicator sets `el.style.transition`
   verbatim, and `.tw()` accepts Tailwind's `transition-*` classes. Neither
   means anything on Canvas, iOS, Android, or desktop. This is the gap: Hypen's
   whole pitch is renderer-agnostic UI, and animation is currently the one
   place where that promise silently breaks. *(Since shipped: the string form
   is deprecated in favor of the portable `.transition(...)` — Shipped v1, §3.)*

There is one free asset worth calling out: the Router already emits
`Detach`/`Attach` for cached route subtrees. That pair is a natural seam for
route transitions (the "shared element / page slide" class of animation) —
whatever API we pick should be able to hang off it later.

---

## 2. Prior art: wins and mistakes

### CSS (transitions + `@keyframes`)

**Wins.** Implicit transitions are arguably the best animation DX ever shipped:
declare `transition: opacity 0.3s` once and *every* future change to that
property animates — cancellable, interruptible, retargetable, GPU-composited,
with `prefers-reduced-motion` as a system-level kill switch. The author
describes *policy*, the engine handles *mechanics*.

**Mistakes.** Exit was unsolved for ~15 years: a removed element is simply gone,
which birthed an entire ecosystem of "keep it mounted, toggle a class, listen
for `transitionend`, then really remove it" hacks (`@starting-style` and
`transition-behavior: allow-discrete` only landed in 2023+). Discrete/auto
values (`height: auto`, `display`) couldn't animate. `@keyframes` are stringly
referenced globals with no scoping. No springs until the `linear()` easing hack.
Orchestration (staggering, sequencing) is manual `delay` arithmetic that breaks
the moment you insert a step.

**Lesson for Hypen:** implicit "animate whatever changes" is the right default;
exit and sequencing must be designed in from day one, not bolted on.

### React (react-transition-group → Framer Motion)

**Wins.** React shipped nothing built-in, and the ecosystem's convergence point
— Framer Motion — is instructive: `animate={{opacity: 1}}` as declarative
target values, `layout` for automatic FLIP animations, `variants` for
orchestrated multi-element choreography with stagger, springs as first-class
citizens.

**Mistakes.** `AnimatePresence` exists *only* because VDOM removal is eager —
an awkward wrapper component that must intercept children diffing to delay
unmount. That's not a React quirk; it's exactly Hypen's constraint #4, and it
shows what happens when exit animation is solved at the library layer instead
of the reconciler layer: a special component with subtle keying rules everyone
gets wrong. Second mistake: animation driven by re-render (`useState` per
frame) was a trap every library had to engineer around — reinforcing constraint
#1 (never tick through the state system).

**Lesson for Hypen:** we control the reconciler, so exit animation should be an
IR/patch capability, not a wrapper component. Variants/stagger are worth
stealing; per-frame state updates are the anti-pattern to make impossible.

### Android (View anim → ObjectAnimator → MotionLayout → Compose)

**Wins.** Twenty years of API churn distilled into Compose's current, very good
answer: `animate*AsState` (implicit, per-value), `updateTransition`
(coordinated multi-property state transitions), `AnimatedVisibility`
(enter/exit), `animateContentSize` (layout), all interruptible and retargetable
by construction.

**Mistakes.** The original View animation system animated *pixels but not hit
targets* — the button visually moved but its touch area didn't. That's the
canonical warning about animating a presentation layer that the rest of the
system doesn't know about (relevant to Canvas/desktop renderers: hit-testing
must read animated positions). XML `ObjectAnimator` was verbose and stringly
(`"translationX"`). MotionLayout showed the ceiling of declarative keyframe
authoring in markup: powerful, but nobody could write or debug it without a
visual tool.

**Lesson for Hypen:** implicit per-value + a targeted enter/exit construct +
one coordinated-transition construct covers essentially everything app authors
need; interruption correctness is table stakes; keep hit-testing coupled to
animated geometry in retained renderers; if the format needs a GUI to author,
it's the wrong format for hand-written DSL.

### SwiftUI (`withAnimation`, `.animation(value:)`, `.transition`)

**Wins.** Two deep insights. First, the *transaction* model: `withAnimation {
state.open = true }` attaches the animation to the **cause of the change**, not
the view — the same state change can animate when user-initiated and snap when
programmatic. No other framework has this, and it maps beautifully onto Hypen's
action dispatch (an action handler is precisely a transaction). Second,
`.transition(.slide)` describes enter/exit *on the element*, and the framework
owns deferred removal — no `AnimatePresence` wrapper needed.

**Mistakes.** The original unscoped `.animation(spring())` modifier implicitly
animated *every* upstream change flowing through the view and had to be
deprecated — the hardest lesson in this whole survey: **implicit animation must
be scoped to a trigger (a value, a transaction), or it animates things the
author never intended.** Also: opaque behavior when animations compose (which
modifier wins?), and debugging "why did that animate" is famously hard.

**Lesson for Hypen:** offer the transaction form (it's uniquely aligned with
`@actions.*`), but *always scoped*; never ship an ambient "animate everything"
switch.

### Rive (designer-authored artifacts + state machines)

**Wins.** Rive's contract is the interesting part: designers author timelines
and a *state machine* in an editor; code sees only named **inputs** (booleans,
numbers, triggers). This is a clean designer/developer boundary, and the same
`.riv` file plays on every platform via a small runtime — philosophically
identical to Hypen's "same patches, every renderer" promise. State machines
also make genuinely complex interactive animation (blend states, gesture-driven
scrubbing) tractable where timeline-only systems collapse.

**Mistakes / limits.** The artifact is a black box to the layout system — it's
a canvas island that can't animate *your* button's padding or participate in
list reflow. The input contract is stringly and versioned by convention; a
renamed input fails at runtime.

**Lesson for Hypen:** don't embed the artifact — steal the *decomposition*.
Rive's model factors into four separable ideas, each of which maps onto
something Hypen already has or plans: (1) **timelines** — motion authored once,
named, reusable (→ Option E); (2) **states that play timelines**, not static
poses (→ Option C upgraded to reference E); (3) **inputs as the code contract**
— bool/number/trigger driving the machine (→ `@{state.*}` paths and
`@actions.*`, which are *better* than Rive's inputs: typed, LSP-renameable,
already reactive); (4) **number-driven blending/scrubbing** — a timeline
position driven by a continuous value rather than a clock (→ Option G). The deep lesson is the separation of *what
motion exists* (authored declaratively) from *when and how far it plays*
(driven by inputs). That separation, not the editor or the file format, is
what makes Rive flexible.

---

## 3. Candidate DX designs

Eight candidates. They are **not mutually exclusive** — §5 argues for a
layered subset. Each comes with sample DSL (parseable with today's grammar: named args,
numbers-as-ms, maps, references, block applicators) and a SWOT.

Shared vocabulary used below — a **curve** is one of:

```hypen
easeIn | easeOut | easeInOut | linear
spring                      // sensible default (response/damping preset)
spring(bouncy) | spring(response: 0.4, damping: 0.7)
```

---

### Option A — Implicit per-node transitions (`.transition(...)`) **(implemented)**

CSS-transitions / `animate*AsState` school: declare once on the node that
property changes should animate; the reconciler already knows exactly which
props changed.

```hypen
Column {
    Text("@{state.score}")
        .fontSize("@{state.emphasized ? 32 : 18}")
        .transition(200, easeOut)                    // all animatable props

    Image(src: "@{state.avatar}")
        .opacity("@{state.loaded ? 1 : 0}")
        .transition(props: [opacity], duration: 300) // scoped to listed props
}
.tw("gap-2")
```

Mechanics: `.transition` compiles into a reserved prop (e.g. `__anim.transition`)
carried on `Patch::Create`; thereafter renderers interpolate any `SetProp` on
that node natively (CSS transition on DOM, `Animator` on Android, implicit
animation on SwiftUI, ticker on Canvas/Vello). Zero per-frame engine traffic.

| | |
|---|---|
| **S** | Smallest possible API; matches the existing applicator idiom exactly; covers the single most common need ("make this change not snap"); trivially incremental — renderers that don't support it yet just snap, which is graceful degradation for free. |
| **W** | Animates the *node*, not the *change*: can't express "animate on click but snap on data refresh" (SwiftUI's deprecated-modifier lesson lurks here — mitigated by the `props:` scoping form, fully solved only by Option D). No enter/exit, no orchestration. |
| **O** | Foundation everything else compiles down to — Options B–E can all lower into the same `__anim.*` prop channel, so building A first is pure runway. Reduced-motion handling lands in one place (renderers ignore `__anim` when the OS asks). |
| **T** | "Animatable prop" must be specified per-property across five renderers (what does animating `tw` mean? — answer: it doesn't; enumerate an animatable whitelist: opacity, transform-ish, colors, spacing, size). Canvas/desktop must keep hit-testing on animated geometry (Android's View-anim bug). |

---### Option B — Enter/exit/layout primitives (`.enter` / `.exit` / `.layout`) **(implemented)**

The structural half: animate what `If`, `ForEach`, and `Router` *do* — insert,
remove, move. SwiftUI `.transition` + Compose `AnimatedVisibility` + Framer
`layout`, but implemented in the reconciler where it belongs.

```hypen
If(condition: @state.showToast) {
    Row {
        Text("Saved!")
    }
    .enter(slide(from: bottom), fade)
    .exit(fade, duration: 150)
}

ForEach(@state.items) { item ->
    Row { Text("@{item.title}") }
        .key("@{item.id}")
        .enter(fade)
        .exit(slide(to: trailing))
        .layout(spring)          // FLIP: animate reorder/reflow moves
}
```

Mechanics: `.enter` decorates `Insert` patches (renderer plays it before/while
attaching). `.exit` **requires the deferred-remove protocol**: the engine emits
`RemoveAfterTransition { id }` (or a flag on `Remove`), the renderer plays the
exit and finalizes removal itself; engine-side the id is immediately dead (no
ack round-trip — renderers own the corpse). `.layout` decorates `Move` and
size-changing `SetProp`s with FLIP intent. `Detach`/`Attach` later get the same
treatment for route transitions.

| | |
|---|---|
| **S** | Solves the problem *no* userland layer can (eager `Remove`); no `AnimatePresence`-style wrapper component — the applicator sits on the thing that appears/disappears, which is where authors look for it; `ForEach` + `.layout` gives list reorder animation, a marquee demo for the engine's keyed differ. |
| **W** | The deferred-remove handshake is real protocol work across all five renderers and the compatibility test suite; edge cases are hairy (node re-inserted with the same key mid-exit; parent removed while child exits — rule: parent exit wins, children are dropped). |
| **T** | Renderer divergence: if DOM finalizes removal correctly but Android leaks exiting nodes, the same app behaves differently per platform — needs conformance tests in `engine-compatibility-tests/` from day one. Detached-but-exiting nodes must not receive events. |
| **O** | Enter/exit presets (`fade`, `slide`, `scale`) are a tiny closed vocabulary — easy to spec across renderers, easy for LLMs/codegen to emit (relevant: much Hypen code is generated). Route transitions fall out of the same mechanism later via Detach/Attach. |

---

### Shipped v1 — Layers 1–6 + completion events (normative as implemented)

Options A, B and C are implemented, plus the presets-only slice of Option E
(see the `.animate` block below), the `.onAnimationComplete` slice of
Option F (see the `.states` and completion blocks below), Option H
shared-element transitions (see the `.sharedElement` block below), and the
cheap subset of Option D transaction scope (see the `animate:` block at the
end of this section): engine
lowering (`ir/anim.rs` + `ir/expand.rs`), the deferred remove protocol, the
shared TS animation module (`@hypen-space/core`), the DOM renderer
(`packages/web/src/dom/anim.ts` + `anim-styles.ts` + `anim-complete.ts`),
and the Canvas 2D renderer (`packages/web/src/canvas/anim.ts` — see the
Canvas parity note below; Canvas does not play H). iOS, Android, and
desktop degrade to snap by ignoring the `__anim.*` props and the
`transition` flag — the spec-sanctioned behavior, no changes required there
(they also never dispatch completion events: nothing plays, nothing
completes; for H, ignoring the props means a plain navigation).
Where this section deviates from the sketches above, this section wins.

**Flat syntax only.** Nested calls do not parse — `slide(from: bottom)` and
`spring(bouncy)` are not valid Hypen. Presets and curves are bare tokens;
options are named arguments:

```hypen
.transition(200, easeOut)                        // positional: number → duration(ms), token → curve
.transition(duration: 300, curve: spring, delay: 50, props: [opacity, translateY])
.enter(slide, fade, from: bottom)                // presets compose; direction is a named arg
.exit(fade, duration: 150)
.exit(slide, to: trailing)
.layout(spring)                                  // .layout() → defaults
```

Vocabulary: curves `linear|easeIn|easeOut|easeInOut|spring` (`spring` is a
fixed overshoot preset — DOM maps it to `cubic-bezier(0.34,1.56,0.64,1)`;
parameterized springs deferred), presets `fade|slide|scale`, directions
`top|bottom|leading|trailing` (leading/trailing resolve against the layout
direction; slide offset 24px, scale hidden factor 0.95). Defaults: transition
`{200ms, easeOut}`, enter `{200ms, easeOut}` (presets default to `[fade]`),
exit `{150ms, easeIn}`, layout `{300ms, spring}`. Bindings in animation
arguments are rejected (warn + ignore); malformed arguments degrade to the
channel's defaults — never a hard error.

**Wire format.** Each applicator lowers to ONE reserved prop carrying ONE JSON
object, carried on `Create` and kept live via `SetProp` (routing is a single
`startsWith("__anim.")` check; JSON key order is not guaranteed):

```json
"__anim.transition": {"duration":200,"curve":"easeOut"}          // +"delay", +"props":[...] when scoped
"__anim.enter":      {"presets":["slide","fade"],"from":"bottom","duration":200,"curve":"easeOut"}
"__anim.exit":       {"presets":["fade"],"duration":150,"curve":"easeIn"}
"__anim.layout":     {"duration":300,"curve":"spring"}
```

**Deferred remove.** `Remove` gained an optional flag — deliberately not a new
variant (a flag degrades gracefully in naive renderers; a variant breaks every
exhaustive match):

```json
{"type":"remove","id":"7","transition":true}
```

Serde `default` + skip-if-false, so the wire is byte-identical to the old
protocol when the flag is absent. `transition: true` marks the root of a
subtree whose node carried `__anim.exit`; the renderer may play the exit and
finalize teardown itself. Engine-side the id is dead the moment the patch is
emitted — no ack round-trip, the renderer owns the corpse. Ordering contract:
the flagged root `Remove` is emitted FIRST, then its descendants as plain
Removes; descendants are plain even when they carry their own exit specs
(parent-remove-wins). Non-animated subtrees keep the pre-existing post-order
exactly. `Detach`/`Attach` (Router cache) stay instant in v1.

**Legacy passthrough.** `.transition("opacity 0.3s ease")` — a single
positional string containing whitespace — keeps the old web-only
`transition.0` path, now with a deprecation warning. A bare token
(`.transition(easeOut)`) takes the new channel.

**Shipped animatable whitelist** (filters `.transition(props: [...])`
engine-side; normative TS map `ANIMATABLE_PROPS` in `@hypen-space/core`, Rust
mirror in `ir/anim.rs`, drift pinned by a conformance fixture): `opacity`,
`translateX`, `translateY`, `scale`, `rotate`, `color`, `backgroundColor`,
`borderColor`, `cornerRadius`, `padding` plus its six directional forms
(`Top`/`Bottom`/`Left`/`Right`/`Horizontal`/`Vertical`), `margin` plus the
same six, `width`, `height`, `gap`, `fontSize`.

**`.animate` presets (Option E, presets-only).** The built-in-timelines slice
of Option E is shipped: `.animate(<preset>, ...)` with the closed preset
vocabulary `pulse|spin|shimmer|shake`. Author-defined `animation { }` blocks
are **rejected** (maintainer decision — see §E; the presets are the entire
timeline surface), and the `when:` trigger is likewise not shipped — a
preset under an `If` plays on enter, which covers the shake-on-error case
without binding plumbing. Flat syntax, same
rules as the other channels — the first positional token names the preset,
modifiers are named-only:

```hypen
.animate(spin)                                   // per-preset defaults
.animate(pulse, duration: 800, repeat: 3, curve: easeInOut)
.animate(shake, delay: 100)
```

`repeat:` is the token `loop` or a positive integer; `duration:`/`delay:` are
ms numbers; `curve:` uses the shared curve vocabulary. Per-preset defaults:
pulse `{1200ms, loop, easeInOut}`, spin `{800ms, loop, linear}`, shimmer
`{1500ms, loop, linear}`, shake `{400ms, 1, easeInOut}`. Validation mirrors
the other channels with one exception: an unknown or missing preset warns and
**omits the channel entirely** (there is no meaningful default timeline);
every other invalid argument (unknown curve/repeat token, bad number) warns
and keeps the preset default, and bindings warn + ignore — never a hard
error. Wire format (one object on the fifth reserved prop; `delay` only when
given):

```json
"__anim.animate": {"preset":"spin","duration":800,"repeat":"loop","curve":"linear"}
```

Keyframe *shapes* are renderer-owned — only the preset names and timing
defaults are normative (`ANIMATE_PRESETS` in `@hypen-space/core`, Rust mirror
in `ir/anim.rs`, drift pinned by conformance fixtures). The DOM renderer
plays presets via one injected stylesheet (`@keyframes hypen-*` + one class
per preset reading `--hypen-anim-*` CSS vars with the defaults as `var()`
fallbacks), not inline `el.style.animation` — `shimmer` is a gradient
`::after` overlay only a stylesheet can express. A changed spec restarts
playback (class removed, reflow forced, class re-added); a removed channel
clears class + vars; exiting nodes keep playing. On a cached-route `Attach`,
looping presets resume but finite-repeat presets do not replay (the
`.enter`-style no-replay contract). A preset whose keyframes touch
`opacity`/`transform` is suspended for the duration of a conflicting
enter/exit/FLIP playback on the same node, then resumed.

DOM renderer behaviors of note: enter plays only for nodes created in the same
patch batch (a cached `Attach` never enter-animates) and is suppressed on the
first-ever batch; exiting subtrees are marked `data-hypen-exiting` + `inert`
and their event dispatches are dropped; exit finalize runs on `transitionend`
with a `duration + delay + 80ms` timeout backbone; `.layout` FLIPs `Move`
patches only (zero-delta moves skip; exit wins over FLIP on the same node);
reduced motion snaps everything (exits finalize on a microtask). Known v1
limits: an exiting node still occupies layout (sibling-shift FLIP is roadmap
work), and a rapid `If` toggle shows the old node's exit and the new node's
enter simultaneously.

**Canvas 2D parity (shipped).** The Canvas renderer plays the same `__anim.*`
channels via `CanvasAnimator` (`packages/web/src/canvas/anim.ts`), the
hand-written ticker/interpolator §4 called for: the renderer's coalescing
redraw loop is the clock (the engine never ticks — constraint #1), it re-arms
only while animations are in flight and stands down when the last one
settles, and easing reuses the shared numeric curve layer in
`@hypen-space/core` so canvas traces the DOM's CSS curves exactly. The
constraint-#5 rule (Android's View-anim lesson) is load-bearing in the
implementation: every interpolated value is written into the REAL
`VirtualNode` props *before* layout and hit-testing run each frame — never a
paint-only offset — and layout-affecting props (`width`, `height`, `gap`,
`fontSize`, `padding*`, `margin*`, `borderColor`) mark layout dirty every
tick so Taffy re-solves and hit targets follow the animated geometry. What
plays: `.transition` on the numeric whitelist plus RGBA color interpolation
for `color`/`backgroundColor`/`borderColor` (hex 3/4/6/8-digit, `rgb()`/
`rgba()`, basic named colors; unparseable colors snap), with mid-flight
retargets continuing from the last interpolated value; `.enter` `fade`/
`slide`/`scale` (RTL-aware slide, same batch rules as DOM — first-batch
suppression, cached `Attach` never enter-animates); `.exit` with deferred
teardown, immediate hit-test *and* scroll-target exclusion of the exiting
subtree, and finalize on settle or a `duration + delay + 80ms` timeout
backbone; `.animate` `pulse`/`spin`/`shake` via real `opacity`/`rotate`/
`translateX` props with DOM-matching keyframe shapes (finite repeats never
replay on cached attach; conflicting presets are suspended during enter/exit
playbacks). What still snaps on canvas, deliberately: `.layout` FLIP —
Taffy owns geometry and a transform-based FLIP would desync hit-testing from
painted position mid-reorder, exactly the divergence constraint #5 forbids,
so moves jump; `cornerRadius` transitions — canvas paint/layout consume
`borderRadius`, never the whitelist's `cornerRadius` key, so there is nothing
to interpolate honestly; and `shimmer` — a DOM-only gradient overlay with no
honest prop-level canvas equivalent (silent no-op). Reduced motion (guarded
`matchMedia`, live toggle) snaps everything including immediate exit
finalize; unknown or malformed specs parse to null and are silent no-ops.
Canvas caveat shared with static transform props: enter/exit transforms are
paint-time, so an entering node hit-tests at its final layout box for the
brief playback.

**`.states { onState(...) }` (Option C, shipped).** Named visual states via a
block applicator with `onState(<label>)` heads — this syntax **supersedes the
§C sketch's per-node `.inState(label) { ... }` chain form** (deferred, along
with the sketch's `stagger:` group envelope — see below):

```hypen
Image(src: "@{state.cover}")
    .width(100)
    .cornerRadius(4)
    .states(@state.cardState, transition: spring, duration: 250) {
        onState(collapsed).width(48).cornerRadius(8).opacity(0.9)
        onState(expanded).width(240).cornerRadius(16).tw("shadow-lg")
    }
```

Grammar note (correcting constraint #2's original assumption): the
`ApplicatorSpecification.children` field and the fold path predate Option C,
but the grammar could not parse a `{ }` block on an applicator when the
engine lowering first landed — the applicator-block production shipped with
Option C and the form above now parses directly from `.hypen` source. The
production is generic, not `.states`-specific: any applicator may be
followed by a block (whitespace/newlines/comments allowed between `)` and
`{`, exactly as for component blocks); block entries are full recursive
component specifications with their own applicator chains; the chain may
continue after a block (`.states(...) { ... }.padding(4)`); and a zero-arg
applicator with a block (`.modifier { ... }`) parses too. The conformance
fixtures now express `.states` inline in `source` — the interim
`input.applicators` fold-path escape hatch in the Rust runner has been
removed.

Header: the first positional MUST be a state reference (else warn + ignore
the whole applicator); named modifiers `transition:` (curve token —
deliberately not `curve:`), `duration:`/`delay:` (ms) with defaults
`{easeOut, 250, 0}`; one `.states` per node (extras warn + drop). Block:
only `onState(<label>)` entries — label is a bare identifier or string, pose
props chain as applicators on the head; a non-`onState` child, a label-less
`onState`, or an `onState` with children warns and skips that entry;
duplicate labels warn, last wins. Pose lowering reuses the ordinary
applicator→prop machinery (`.tw`, directional forms, variants all work
per-state) minus three exclusions that warn + drop: animation applicators
(including nested `.states`), `.bind`, and `on[A-Z]*` event applicators;
pose values must be static (bindings warn + drop that prop).

Mechanics, as implemented (not the sketch's "conditional IR" guess): each
prop key any pose overrides becomes an **engine-internal
`Value::StateSwitch`** — `{path, cases: label→JSON, default: the node's
final static base value for that key}`. `.states` is applied AFTER every
other applicator on the node, so the base/default is the chain's final
value regardless of where `.states` sits. Resolution
(`reconcile/resolve.rs`): read the state at `path`, stringify scalars
(string as-is, number/bool via `to_string`), pick the matching case, else
the default, else the prop resolves to **absent** (key omitted / RemoveProp
— fallback-to-base semantics). The driving path registers in the dependency
graph exactly like a `@{state.*}` binding (module-scope aware), so pose
flips flow out as ordinary `SetProp`/`RemoveProp`. `StateSwitch` never
reaches the wire — resolved props are plain JSON, zero renderer changes, and
snapping renderers always show the correct pose.

Two props are synthesized: `__anim.transition` from the header timing,
scoped via `props:` to the overridden keys on the animatable whitelist
(non-whitelist overridden props still switch, they just snap; no animatable
override → no spec, everything snaps) — an **explicit `.transition` on the
node wins** over the synthesized one, and the deprecated legacy string form
counts as explicit (suppresses synthesis with a warning); and
`__anim.states`, the active label as `{"label": "<label>"}` (a StateSwitch
over the labels themselves, default `null`), so animation-aware renderers
see pose changes as an ordinary SetProp — used to time the states settle
and stamp completion payloads; renderers that ignore it lose nothing.

```json
"__anim.transition": {"duration":250,"curve":"spring","props":["cornerRadius","width","opacity"]}
"__anim.states":     {"label":"collapsed"}        // null in the fallback-to-base pose
```

**`.onAnimationComplete` (Option F slice, shipped).** Exactly the §F design:
an ordinary event applicator (engine cost: zero — the anim interception does
not swallow it, pinned by a lowering test; it reaches renderers as the plain
`onAnimationComplete.0` action prop). The DOM and Canvas renderers dispatch
the action through the same channel clicks use when a playback on the node
settles **naturally**; payload contract (normative):

- finite `.animate` preset completes → `{ "animation": "<presetName>" }`
- `.enter` settles → `{ "animation": "enter" }`
- `.exit` settles (just before finalize — the node is still alive) →
  `{ "animation": "exit" }`
- a `.states` transition settles → `{ "animation": "states", "state":
  "<matched label>" }` — the DOM animator times this with the transition
  spec's duration+delay (per-prop `transitionend` is not a reliable settle
  signal for a multi-prop pose switch); the canvas animator uses its tick
  clock

Extra named args on the applicator merge under the payload; the
`animation`/`state` fields always win. Interrupted, superseded, and
reduced-motion-skipped playbacks fire NOTHING (this removes most completion
races by construction); looping presets never complete; a `.states` flip to
the default pose (`null` label) fires nothing; playbacks on
Router-detached (cached) or exit-animating subtrees fire nothing. The
remaining race is handled as §F prescribed: the payload names the animation
and pose so module machines drop stale completions — latest-wins. Nodes
without the prop dispatch nothing (a single lookup is the entire overhead).
Non-animating renderers never dispatch — completions are motion
choreography, not a correctness channel.

**`.sharedElement` shared-element transitions (Option H, shipped — DOM
renderer).** Engine side, exactly the §H decision: identity + timing, zero
geometry. `.sharedElement(<key>, curve: ..., duration: ...)` lowers to TWO
reserved props — the only animation applicator that splits — because the key
is the one animation argument where bindings are LEGAL (identity is data):

```json
"__anim.sharedKey": "cover-42"                        // the RESOLVED key string
"__anim.shared":    {"duration":350,"curve":"spring"}
```

The key (mandatory first positional) goes through the standard parser-value
conversion — plain string, template string (`"cover-@{item.id}"`), and pure
reference (`@state.heroKey`) all legal — and re-resolves per render,
reaching renderers as an ordinary `SetProp` when its driving state changes.
`__anim.shared` is static like every other channel: named-only
`duration:`/`curve:` with defaults `{350, "spring"}`; invalid timing
degrades to the defaults; `delay:` is not part of the shape (unknown-arg
warning); extra positionals warn and drop. A missing, empty, or
non-string-ish key warns and omits BOTH props. The incoming (target) node's
spec times the playback.

The five-step §H protocol, as implemented in the DOM renderer
(`packages/web/src/dom/anim.ts`):

1. **Measure outgoing.** When a batch has navigation shape — BOTH a
   `Detach` AND an `Attach`/`Insert` — a pre-pass snapshots the on-screen
   rect of every connected keyed node **at-or-under one of the batch's
   detach roots**, keyed by shared key, before the batch mutates the DOM.
   Disconnected or zero-rect sources skip silently; duplicate source keys
   keep the first. Per-batch shared state resets at the TOP of this
   pre-pass as well as at the end of every flush, so a batch that throws
   mid-apply cannot leak stale snapshots forward.
2. **Apply the batch.** The incoming tree builds and lays out normally.
3. **FLIP incoming.** Incoming keyed nodes — created this batch, or
   at/under a re-attached (cached Router) root — that match a snapshot play
   a FLIP: an inverted `translate(dx,dy) scale(sx,sy)` **prepended** to the
   node's base transform (the viewport-space correction must compose
   outside the base), `transform-origin` pinned to `top left` for the
   flight (the pin is tracked and cleared on every superseding/teardown
   path — enter, exit, `.layout` FLIP, forget, reset — not only the
   flight's own settle), played with the target's `__anim.shared` timing.
   Every match suppresses the node's own `.enter` for the batch — one
   motion, not two. Exiting nodes never participate as targets (exit
   wins); a snapshot matching its own node (a cached subtree persisting)
   is no match. Natural settle restores the base transition and transform,
   unpins the origin in the same synchronous update, and dispatches
   `{ "animation": "sharedElement" }` (natural-settle-only, like every
   other playback).
4. **Degrade silently.** Unmatched or unmeasurable keys mean a plain
   navigation — nothing errors. Dev diagnostics per §H's T-row: a key that
   matched nothing this navigation (source-only or target-only) warns ONCE
   per key, at WARN — visible at the logger's default level; duplicate
   source/target keys likewise. A self-matching persisted node and a
   matched target with no timing spec (sanctioned snap) are neither
   matches nor typos and never warn.
5. **Interruption retargets.** Falls out of step 1 for free: a mid-flight
   second navigation's `getBoundingClientRect` reads the animated
   presentation rect, so the next FLIP starts from where the element
   visually is — never the original source, as §H step 5 requires.

**Zero-delta completion semantics.** A match whose source and target rects
coincide (< 0.5px translation, < 0.5% scale delta) plays nothing — which IS
an instant natural settle: the enter stays suppressed AND
`{ "animation": "sharedElement" }` dispatches immediately, so a module
machine waiting on `.onAnimationComplete` never stalls
geometry-dependently. Under reduced motion no snapshot is taken at all —
no FLIP, no suppression, no completion.

**v1 cuts, recorded against the normative §H text.** Step 3's
"interpolating corner radius and opacity for visual continuity; crossfade
content when the two nodes' content differs" is NOT shipped — v1 is
transform-only continuity (translate + scale), an acknowledged deviation
from the normative protocol; corner-radius/opacity interpolation and the
content crossfade remain renderer roadmap. No overlay proxies: the incoming
element itself animates, and the detached source is never resurrected or
kept visible. Source scoping is a v1 NARROWING of step 1: "outgoing nodes
carrying `__anim.shared` keys" became "keyed nodes inside the batch's
detached subtree(s)" — a persistent app-shell node sharing a key stays
on-screen after the navigation, so it must neither source a FLIP out of a
still-visible element nor shadow the real outgoing source; still-visible
keyed nodes are simply not sources. Rotation/scale base transforms make the
prepended invert approximate (exact for identity and translate bases).
Canvas, iOS, Android, and desktop ignore both props — plain navigation, the
sanctioned total degradation — so H ships renderer-by-renderer exactly as
its S-row predicted.

**Feel check (visually verified in-browser).** The shipped defaults were
confirmed in a real browser session driving the list→detail→back flow: the
`spring` curve's overshoot measured ≈9.5% of travel past the target before
settling — reads as intentional bounce, not error — and `{350ms, spring}`
needed no tuning. Enter suppression on matched nodes, the once-per-key
unmatched warning, and the interrupted-flight retarget from the animated
position were all observed live.

**`animate:` transaction scope (Option D cheap subset, shipped — TS
hosts).** Exactly the §D O-row's "cheap, high-value subset": the `animate:`
named argument on event applicators, shipped as an override layer above
A–C so precedence never changes under authors. The full SDK `animate()`
block (handler-side `await animate(spec, () => { ... })`) remains proposal
— it waits on the dispatch pipeline growing general batch metadata.

```hypen
.onClick(@actions.toggleCart, animate: spring)
.onClick(@actions.expand, animate: {curve: easeOut, duration: 400})
```

**Wire contract.** One new patch type, emitted as the FIRST patch of a
render cycle whose triggering state update carried an animation context:

```json
{"type":"batchAnimation","spec":{"curve":"spring","duration":250}}
```

It addresses no node — it scopes the *batch*: every whitelisted prop
change in the patches that follow glides with the spec, on any node,
`.transition` or not. First-patch-only is normative on BOTH ends: the
engine only ever emits the prelude at index 0, and both TS renderers
honor it only at index 0 — a `batchAnimation` anywhere else is not a
stamp for that batch, so accumulated/concatenated batches cannot
over-scope (the remote session's initialTree accumulation drops preludes
outright for the same reason: a stamp scopes exactly one live batch,
never a replay). Renderers that don't know the type ignore it; the rest
of the batch is wire-identical to an unstamped one. The spec shape is the
`.transition` channel's; engine-side normalization
(`ir/anim.rs::normalize_batch_animation`) turns a bare curve token into
`{curve, duration: 250}` (unknown tokens warn and reject), fills a
missing `duration` on object specs, and rejects any other value with a
warning — the update proceeds unstamped, never a hard error. Conformance: the `batchAnimation`
shape in `patch.schema.json` plus the stamped-emission fixture
`fixtures/animation/batch-animation-stamp.json`, exercised by the Rust
and TypeScript runners.

**Binding signatures.** `updateState` / `updateStateSparse` gained an
optional trailing `animation` argument at every layer — old arities
unchanged, omitted/`null` = unstamped, byte-identical wire:

- Rust core: `EngineCore::update_state(scope, patch, Option<Value>)` /
  `update_state_sparse(scope, paths, values, Option<Value>)`
- wasm-bindgen (`wasm/js.rs`): `update_state(scope, patch, animation?)` /
  `update_state_sparse(scope, paths, values, animation?)`
- TS: `BaseEngine.updateState(scope, statePatch, animation?)` /
  `.updateStateSparse(scope, paths, values, animation?)`; the module
  runtime's `IEngine` carries the sparse form (the one its observable
  flush uses)
- WASI: the `hypen_update_state_sparse` JSON envelope gains an optional
  `animation` field; the full-patch `hypen_update_state` deliberately has
  none (the payload IS the state patch — a reserved key would collide with
  real state keys), so stamping is sparse-update-only on WASI.

**Stamp lifecycle.** Engine side: the normalized spec is stored as
`pending_animation` only when the update actually changed state (a no-op
dispatch never stamps); the next render cycle consumes it — the prelude
is prepended iff the cycle produced patches, and discarded silently
otherwise. **No stamp without patches, no leak across cycles.**

SDK side (`HypenModuleInstance` + the renderers): the renderer extracts
`animate:` from the applicator's own named-argument position — BEFORE
positional-payload merging, so a payload field named `animate` is user
data and survives untouched — and smuggles it across the dispatch
boundary under the reserved payload key `__hypenAnimate`
(`ACTION_ANIMATE_KEY`; `dispatchAction(name, payload)` is the only
channel through the WASM engine). `BaseEngine.onAction` lifts it back out
into the distinct `Action.animate` field, so module handlers never
observe the key. The module runtime then wraps the spec in a fresh token
object PER DISPATCH — every set/compare/clear is token identity, never
spec value identity, so two dispatches stamping the same `"spring"`
string cannot clear each other — and:

1. **Entry drain.** On dispatch entry it synchronously drains any
   pre-queued observable flush: mutations that predate this dispatch go
   out with the stamp of the dispatch that caused them, or none — a stamp
   can never land on mutations the action didn't cause.
2. **First-flush consumption.** The pending stamp is consumed by the
   FIRST flush after the handler starts (passed as the engine's
   `animation` argument) and cleared, so every later flush is unstamped.
3. **Microtask clear.** A `queueMicrotask` after the handler's
   synchronous portion clears an unconsumed stamp — the sync mutations'
   flush microtask was queued during the handler call, so it always wins;
   an awaited continuation always loses. After-`await` mutations are
   unstamped by construction.
4. **Last-unconsumed-stamp-wins.** A second stamped dispatch arriving
   while an earlier stamp is still pending (its handler never mutated, so
   the entry drain had nothing to flush) overwrites it.
5. **Completion backstop.** Handler completion clears the token's stamp
   if it somehow still pends — a dispatch's stamp never outlives its run.

**Precedence (normative, recorded in the DOM animator):** structural
playbacks (enter/exit/FLIP/shared) > transaction > node `.transition` >
snap. A node whose active settle belongs to a structural playback is
excluded from the transaction entirely — a stamped batch can never
retarget an in-flight playback's `transition-property` and snap it; a
node whose active settle is a *previous transaction's* is retargeted
(back-to-back stamped batches glide seamlessly). The transaction's
`transition-property` is scoped to exactly the props the stamped batch
wrote on that node (accumulated as the SetProps land), never the whole
whitelist; inline transition values are captured on first touch and
restored verbatim on settle (which keeps legacy string `.transition`
styling alive across a stamped batch); an UNSTAMPED write landing on a
still-open transaction settle window's written prop restores base first
and snaps — the snap-on-refresh guarantee holds mid-glide. Canvas: the
stamp is the batch's tick-interpolation spec, overriding the node's
`.transition` and animating nodes without one (same precedence;
same-batch-created nodes skip the transaction's rewind-to-previous so
their queued enter owns the first motion, and exiting nodes snap);
cleared at flush. Reduced motion ignores stamps entirely in both
renderers. Transaction glides dispatch no `.onAnimationComplete` —
completions belong to node-level playbacks.

**Host matrix.**

| Host / renderer | Behavior |
|---|---|
| DOM renderer | Honors the prelude (scoped CSS transitions, restore-on-settle) |
| Canvas 2D renderer | Honors the prelude (tick interpolation spec; canvas snap matrix still applies) |
| uniffi (iOS/Android/desktop) | **Drops** the prelude (`InternalPatch::BatchAnimation → None`) — mobile snaps, matching the Remove-flag policy; carrying it needs a `spec_json` field on the flat FFI record and both binding sets regenerated, deferred with the rest of the non-web animation work |
| Go SDK | **Relays but never generates**: `Patch.Spec` (`json:"spec,omitempty"`) exists so engine-emitted preludes survive transit, but dispatch-side stamping was evaluated and **declined** with recorded reasons — the Go observable notifies synchronously per mutation (no batch boundary to hang "first flush" on) and the Go host syncs state over the envelope-less full-patch WASI path (`NotifyStateChange` → `hypen_update_state`); the remote host strips the reserved `__hypenAnimate` dispatch key before handlers run. TS-host-only status documented in `hypen-golang/CHANGELOG.md` |
| Kotlin host | Strips the reserved dispatch key before handlers run; no stamping |

**Review hardening (adversarial pass, 22 regression tests).** Renderer:
structural playbacks now outrank transactions (a stamped batch can no
longer freeze a mid-enter preset or corrupt a shared flight's pinned
origin); legacy string `.transition` inline styling captured and restored
verbatim; transaction `transition-property` scoped to the props the batch
actually wrote, with an unstamped follow-up write snapping immediately
(the websocket-refresh guarantee); canvas skips the transaction rewind
for same-batch creations; the stamp is honored at batch head only and
remote initialTree accumulation drops preludes. Dispatch: per-dispatch
token identity for the pending stamp; dispatch-entry synchronous drain of
pending flushes; the reserved payload key stripped in the Go and Kotlin
hosts; the named `animate:` argument extracted before positional-payload
merging so user data named `animate` survives; Go stamping evaluated and
declined with the reasons recorded above.

**`.scrub`/`.settle` scrub bindings (Option G, shipped — engine + DOM
renderer).** The §G re-anchoring held: scrub interpolates between TWO of
the node's `.states` poses (`from:`/`to:` name pose labels), driven by a
renderer-resident source, and `.settle(bind:)` writes the winning label to
a `@state.*` path through the exact `.bind` channel. Syntax is **flat named
arguments** — the §G sketch's nested `gesture(axis: y, over: [...])` form
does not parse (the family rule); the source is a bare token:

```hypen
.scrub(from: closed, to: open, source: gesture, axis: y, over: [0, -400], rubberBand: 0.4)
.scrub(from: expanded, to: collapsed, source: scroll, axis: y, over: [0, 120], of: "feed")
.settle(curve: spring, duration: 300, bind: @state.sheetPhase)
```

Defaults: `source: gesture`, `axis: y`, `rubberBand: 0.4`, settle
`{spring, 300ms}`. `from:`/`to:`/`over:`/`bind:` are required. `over` is
the **DIRECTED** input range `[inputAtProgress0, inputAtProgress1]` — not
a min/max pair: an upward-opening sheet uses `[0, -400]`; only equal or
non-finite endpoints are rejected. `of:` (scroll only; warns and drops on
gesture sources) names the container by its resolved `id` prop.

**Wire contract — FOUR static reserved props**, applied in the same
deferred end-phase as `.states` (strictly after it, because
cross-validation reads the collected pose labels):

```json
"__anim.scrub":       {"from":"closed","to":"open","source":"gesture","axis":"y","over":[0,-400],"rubberBand":0.4}
"__anim.scrubSettle": {"curve":"spring","duration":300}
"__anim.scrubBind":   "sheetPhase"
"__anim.scrubPoses":  {"translateY.0":[400,0]}
```

`__anim.scrubPoses` is the piece the renderer cannot derive itself: the
engine **materializes both endpoint values per pose-overridden prop key**
at lowering (pose override, else the node's static base default, reusing
the StateSwitch values the states phase already built) so the renderer
interpolates without knowing StateSwitch exists. A key resolvable on only
one end warns and is skipped (it still flips with the pose — it just snaps
under scrub). Any hard violation — invalid `.scrub` args, missing/invalid
`.settle` or its `bind:`, no `.states` on the node, a `from:`/`to:` label
no pose declares — warns ONCE naming the reason and omits ALL FOUR props:
the node degrades to plain `.states` behavior, never a hard error. A
`.settle` without a `.scrub` warns and is ignored; one pair per node.

**DOM interaction contract** (normative, recorded in the `scrub.ts` module
header; formulas pinned numerically per the §G T-row):

- *Progress mapping.* `p = (input - over[0]) / (over[1] - over[0])`,
  rubber-banded on the RESULT beyond `[0,1]`:
  `p' = bound + (p - bound) · rubberBand` (`scrubProgress` in
  `@hypen-space/core/animation` is the shared normative implementation).
- *Gesture claim.* `pointerdown` opens a PENDING drag; the gesture claims
  the pointer (capture + `dragging`) only once axis travel exceeds ~6px
  slop — a tap is a total no-op (no capture, no settle, no bind write,
  child clicks unaffected). Recorded deviation: grabbing a mid-settle
  element claims immediately (the settle must not fight the finger). Only
  the claiming `pointerId` drives move/up/cancel.
- *Relative drag mapping.* `p = pAtGrab + travel / (over[1] - over[0])` —
  the anchor is the node's LIVE progress at grab, seeded from the
  `__anim.states` label (`from` → 0, `to` → 1) at create and on every
  label feed that lands while no interaction owns the node. A settled-open
  sheet re-drags from 1; a mid-settle catch continues from the settle's
  current progress; offset `over` ranges never jump.
- *Velocity + settle.* Last ~5 pointer samples, samples older than ~100ms
  at release discarded (empty window = v 0); projected
  `p* = p + v · 150ms` picks the target (`p* >= 0.5` → `to`, pinned). The
  settle is a rAF-driven inline-style animation on the shared numeric
  curves — deliberately NOT a CSS transition: it re-drives the drag's
  exact interpolation path (pixel-consistent), arrival is an exact
  observable event (the bind write fires ON arrival; `transitionend` is
  unreliable), a mid-settle grab needs the tick loop's current progress,
  and the injectable clock/rAF make tests deterministic.
- *Cleanup handshake.* After the bind write the final inline styles are
  KEPT until the engine's re-render lands (no flash): cleanup runs on the
  FIRST `__anim.states` label SetProp — **any label, matching or not**
  (any label proves the re-render landed; a raced different label must not
  hold stale visuals) — with a ~500ms timeout fallback.
- *Scroll source.* Listener on the `of:`-named ancestor (one-time dev warn
  + nearest-scrollable fallback when it matches nothing) else the nearest
  scrollable ancestor; offset maps ABSOLUTELY through `over`. No release
  exists: the bind write fires when progress crosses AND RESTS at an
  endpoint (~150ms debounce, cancelled on re-entry, same-label rewrites
  suppressed). Deferral and ownership are bounded by ACTIVE input: after
  ~150ms of mid-range quiescence, deferred engine writes flush (concede —
  live data lands; the next scroll event re-derives from current progress)
  and ownership releases until re-claimed.
- *Conflicts (gesture wins) and precedence.* Engine SetProps to scrubbed
  keys defer (latest value, applied at cleanup) while an interaction owns
  the node; other props flow normally. **Precedence (normative): scrub >
  structural playbacks > transaction > node `.transition`** — a
  scrub-active node is excluded from transaction application and
  enter/FLIP participation, and scrub engagement suspends a conflicting
  `.animate` preset (resumed at cleanup). A remove/detach mid-drag cancels
  everything and releases capture; an exiting node's scrub sources detach
  BEFORE any exit playback (the §G W-row rule), and a cancelled settle
  never dispatches its bind write; cached-route re-attach re-arms scroll
  sources. Base transforms compose: the element's static transform minus
  the scrub-owned function kinds is prefixed to every frame's transform.
- *Reduced motion.* Dragging works unchanged (direct manipulation is the
  user's own hand — the §G exemption); release settles INSTANTLY, then
  writes. Zero engine traffic during any drag or scroll tracking — the
  engine only ever hears the settle write, so remote-UI behavior is
  identical by construction (§6.1).

**Review hardening (adversarial pass, twelve findings, 19 regression
tests).** The root defect both reviewers found independently: drags
anchored at progress 0, so grabbing an open sheet snapped it closed —
fixed by the relative mapping + label-seeded anchor above. The rest:
6px slop gating claim (taps no longer steal child clicks or fire bind
writes), pointer-id filtering, the 100ms velocity staleness window
(drag-hold-release projects nothing), invalid reconfigures running full
cleanup, detach cancelling subtree scrub sources with re-arm on attach,
scroll deferral bounded by quiescence (collapsing headers can't dead-lock
sibling updates), flagged removes cancelling scrub before exit (dead
interactions never write state), base transforms composing through drags
instead of vanishing, presets suspending under scrub per the precedence
rule, ANY states label completing the awaitingCleanup handshake, and the
`>= 0.5` settle tie pinned by test.

**v1 narrowings, recorded against the §G sketch.** (1) **DOM-only**: the
Canvas renderer ignores all four channels (pinned by test — no playback,
no listeners, no engine traffic; iOS/Android/desktop likewise), so G ships
renderer-by-renderer like H did. (2) **Multi-touch is noise**: only the
claiming pointer participates; a second finger neither retargets nor
cancels. (3) **`of:` degrades, never fails**: an unmatched container name
warns once and falls back to the nearest scrollable ancestor. (4) The
sketch's state-driven `progress: "@{state.step}"` coarse-scrub form is
not shipped — sources are `gesture|scroll` only (the closed-vocabulary
rule: every new source is five renderer implementations).

---

### Option C — Named visual states / variants (`.states { }`) **(shipped as `.states { onState(...) }` — see Shipped v1; `.inState` chain form and `stagger:` deferred)**

Coordinated-transition school: Compose `updateTransition`, Framer `variants`,
MotionLayout's ConstraintSets. A node (or subtree) declares named looks; a
state binding selects one; the system animates between them, with orchestration.

```hypen
Column {
    Image(src: "@{state.cover}")
        .inState(collapsed) { .size(48) .cornerRadius(8) }
        .inState(expanded)  { .size(240) .cornerRadius(16) }

    Text("@{state.title}")
        .inState(collapsed) { .fontSize(14) }
        .inState(expanded)  { .fontSize(24) .padding(top: 12) }
}
.states(@state.cardState, transition: spring, stagger: 40)
```

Mechanics: compiles to conditional prop values keyed off one state path, plus a
group-level `__anim.group` spec so renderers coordinate timing/stagger across
the subtree. The reconciler already handles the diffing; the new part is the
grouped timing envelope.

| | |
|---|---|
| **S** | The only option that expresses *choreography* (many elements moving as one gesture, staggered children); dramatically better than the string-interpolation ternaries (`"@{state.x ? 32 : 18}"`) it replaces; block applicators parse (the AST modeled them from the start; the grammar production shipped with Option C). |
| **W** | Biggest syntax surface of the six; overlaps confusingly with plain conditional props unless docs are opinionated about when to use which; two sources of truth for a prop (base chain vs. state blocks) needs a clear precedence rule (state block wins). |
| **O** | This is the natural target for future *tooling* (a visual state editor à la Rive/MotionLayout writing DSL, not blobs) and for LSP support (rename-safe state names, completion inside `.inState`). Also the natural unit for design-system component libraries to ship (`Button` with `pressed`/`disabled` states). |
| **T** | MotionLayout's fate: if authors need a GUI to reason about it, hand-written usage stalls. Must stay small (no per-property keyframes inside states in v1). Engine cost: every variant is extra conditional IR — needs care to not bloat `expand.rs`. |

---

### Option D — Transaction-scoped animation (animate the *cause*) **(cheap subset shipped — `animate:` on event applicators, see Shipped v1; full SDK `animate()` block remains proposal)**

SwiftUI's `withAnimation`, mapped onto Hypen's actual write paths: actions and
module code. The animation rides the *state mutation batch*, so identical state
changes can animate or snap depending on who caused them.

```hypen
Button("@actions.toggleCart")
    .onClick(@actions.toggleCart, animate: spring)
```

```typescript
// module code — SDK side
.onAction("toggleCart", async ({ state, animate }) => {
  await animate(spring(), () => {
    state.cartOpen = !state.cartOpen;   // every patch caused by this flush animates
  });
  state.badgeSeen = true;               // outside the block: snaps
})
```

Mechanics: the sparse-update call (`updateStateSparse`) gains an optional
animation context; the engine stamps the resulting patch *batch* with it;
renderers animate every prop change in a stamped batch. No per-node
declaration needed.

| | |
|---|---|
| **S** | Uniquely correct semantics: "user tapped → glide; websocket refresh → snap" is inexpressible in A/B/C and common in real apps; zero DSL noise for the simple case; interruption is naturally correct (a new transaction retargets). |
| **W** | Spooky action at a distance — reading the DSL alone no longer tells you what animates (SwiftUI's debuggability complaint); requires plumbing through the entire dispatch pipeline (SDK → WASM boundary → dirty-tracking → patch emission) including remote/serialized protocol; cross-module `GlobalContext` writes inside an `animate` block raise scoping questions. |
| **O** | Composes multiplicatively with A–C rather than competing: transaction spec *overrides* node-level defaults (precedence: transaction > node `.transition` > none). The `animate:` arg on `.onClick` is a cheap, high-value subset shippable long before the full SDK plumbing. |
| **T** | If shipped *first*, authors use it for everything and every renderer must animate arbitrary batch diffs correctly — a much bigger conformance surface than A's per-node whitelist. Ship after A/B, as an override layer. |

---

### Option E — Named keyframe timelines (`animation` declarations) **(presets shipped; author-defined blocks REJECTED)**

CSS `@keyframes` / Rive timelines, DSL-native: reusable, multi-step, loopable —
for ambient and decorative motion that isn't driven by a state diff. *(Since
shipped: the built-in presets `pulse|spin|shimmer|shake` via `.animate(...)` —
exactly the "standard library" subset argued for in the O row below, minus
`bounce` and the `when:` trigger.)*

**Decision (maintainer): author-defined `animation { }` declarations are
REJECTED, not deferred — Hypen will not grow a custom keyframe-authoring DSL.**
The presets ARE the timeline surface; anything a hand-written timeline would
express is either ambient (a preset), state-driven (Option C poses), or
structural (enter/exit) — and the T-row's MotionLayout scope-creep risk is
avoided permanently by not opening the door. The example below is retained
for the historical record of what was considered.

```hypen
animation pulse {
    from { .scale(1.0) .opacity(1.0) }
    50%  { .scale(1.06) }
    to   { .scale(1.0) .opacity(0.85) }
}

Badge("LIVE")
    .animate(pulse, duration: 1200, repeat: loop)

Spinner {}
    .animate(spin, duration: 800, repeat: loop, curve: linear)

Card { ... }
    .animate(shake, when: "@{state.error != null}")   // fire on becoming true
```

Mechanics: timelines are document-level declarations (parser: new top-level
form alongside `module`/`component`); serialized once into the IR and shipped
in `Create` props by name+definition; renderers own playback. `when:` re-fires
on a false→true edge of the binding.

| | |
|---|---|
| **S** | Only option covering loops and multi-step sequences (spinners, pulses, shakes, skeleton shimmer — bread-and-butter ambient motion); named + reusable across components; maps almost 1:1 onto every backend's native facility (CSS keyframes, `AnimationSet`, Core Animation, ticker). |
| **W** | Doesn't interact with state diffs at all — a parallel system, and the `when:` trigger is a slightly awkward bridge; per-keyframe applicator blocks mean a new parser production and new IR types; easy to abuse for things A/B do better. |
| **O** | Standard library: ship `pulse`, `spin`, `shimmer`, `shake`, `bounce` as built-ins so most authors never *write* a timeline, only apply one — that's 90% of the value at 10% of the authoring cost, and keeps generated code clean. |
| **T** | Scope creep toward MotionLayout (per-keyframe easing, multiple tracks, scroll-linked timelines…). Draw the v1 line hard: single track, applicator-whitelist props only, no nesting. |

---

### Option F — Rive-inspired machine model **(decided: machine lives in the module; `.onAnimationComplete` shipped — see Shipped v1)**

Not embedding Rive artifacts — adopting Rive's *decomposition* natively:
motion authored as named timelines (Option E), a state machine deciding which
timeline plays, `@{state.*}` and `@actions.*` as the inputs.

**Decision.** The machine is ordinary module logic driving a phase value in
state; the DSL only *reflects* phases (via Option C, whose states may play
Option E timelines). A DSL-resident machine form (`animationMachine` with
declared transition edges) was considered and **rejected**: Hypen's line is
"components declarative, modules logical," and a state machine is logic — its
transition rules belong next to the rest of the module's behavior, in
testable host-language code, not in the view layer.

The one platform piece module-resident machines need is a **completion
signal**: sequencing ("when the draw-on finishes, advance to done") requires
the renderer to report that a timeline ended. This is an ordinary
renderer→engine event on the same channel clicks already use — no new
protocol, one new event applicator:

```hypen
Icon(name: "check")
    .inState(idle)    { .opacity(0.4) }
    .inState(drawing) { .animate(drawOn, duration: 600) }
    .inState(done)    { .animate(pulse, repeat: 2) }
    .states(@state.checkPhase, transition: easeOut)
    .onAnimationComplete(@actions.animationDone)   // payload: { animation: "drawOn" }
```

```typescript
// The machine, as plain module logic:
.onAction("save", async ({ state }) => { await save(); state.checkPhase = "drawing"; })
.onAction("animationDone", ({ action, state }) => {
  if (action.payload.animation === "drawOn") state.checkPhase = "done";
  if (action.payload.animation === "pulse")  state.checkPhase = "idle";
})
```

The differentiator vs. Rive itself: inputs aren't a stringly side-contract —
they're the same reactive state paths the rest of the UI uses, so the LSP can
rename them and the engine already tracks them. And because the machine is
host-language code, it can grow arbitrarily complex (async guards, data-driven
edges) without any DSL change.

| | |
|---|---|
| **S** | Motion with *memory* (hover→press→release plays differently than hover→leave) and cross-timeline sequencing, at the cost of **zero new grammar** — C + E + one event applicator; machine logic is unit-testable TypeScript/Kotlin/Go/Swift; the completion signal reuses the proven action channel. |
| **W** | Each machine transition round-trips through the dispatch pipeline — fine for discrete, human-scale transitions, but a machine hopping through many states in quick succession pays dispatch latency per hop; the machine graph isn't visible in the DSL (it lives in the module), so reading a component alone doesn't reveal the choreography. |
| **O** | An SDK `machine()` helper in `@hypen-space/core` (declare states/edges once, compiled onto `onAction`) would formalize the pattern without touching the language; future visual tooling can emit the module machine + DSL states as a pair. |
| **T** | Completion races: state may advance before a stale completion event arrives — the payload must carry the animation name (and the phase that started it) so handlers can drop completions for abandoned phases; semantics are latest-wins. Ship `.onAnimationComplete` *together with* C/E, or authors will bridge the gap with `setTimeout` guesses that drift from real durations. |

---

### Option G — Scrub bindings (continuous input, renderer-resident) **(shipped as `.scrub`/`.settle` on the DOM renderer — see Shipped v1 for the as-implemented contract and v1 narrowings; flat named args, not the nested source form below)**

The primitive for the entire gesture class: bottom sheets, pull-to-refresh,
collapsing headers, fling. A motion's *position* is bound to a continuous,
**renderer-resident** input source; the per-frame loop never touches the
engine (see §6.1 for why it must not).

*(Re-anchored after the Option E decision: author-defined timelines are
rejected, so scrub does NOT bind to a named timeline. Scrub interpolates
between two of the node's `.states` poses — the same pose vocabulary Option C
already ships — with `progress: 0` = the `from:` pose and `1` = the `to:`
pose. This is the more Hypen-native shape anyway: the gesture scrubs between
states the machine already owns, and the settle write lands on the same state
path that drives them.)*

```hypen
Sheet {
    ...
}
.states(@state.sheetPhase) {
    onState(closed).translateY(400)
    onState(open).translateY(0)
}
.scrub(from: closed, to: open,                       // scrubs between C poses
       source: gesture(axis: y, over: [0, 400], rubberBand: 0.4))
.settle(curve: spring, bind: @state.sheetPhase)      // ONE write, after settling

Header { ... }
    .states(@state.headerMode) {
        onState(expanded).height(120)
        onState(collapsed).height(48)
    }
    .scrub(from: expanded, to: collapsed, source: scroll(axis: y, over: [0, 120]))
```

Semantics:

- **Sources are renderer-resident.** `gesture(...)` (touch/pointer travel on
  the node), `scroll(...)` (nearest scrollable ancestor, or `of:` a named
  one). The renderer samples them locally each frame and seeks the timeline
  directly — zero engine traffic while the source is live. A state-driven
  form (`progress: "@{state.step}"`) is permitted for coarse, discrete
  scrubbing (steppers, onboarding progress) and documented as not-per-frame.
- **Settle.** On release, the current velocity is projected to pick the
  nearest target; the settle animation plays locally; then exactly one
  boundary crossing occurs — the winning target's key is written to the bound
  state path. `bind:` deliberately reuses the existing two-way `.bind()`
  idiom: the gesture is just another input device writing state.
- **Conflicts.** While a source is active, engine-driven writes to props owned
  by the scrubbed timeline are queued and applied at settle — the live gesture
  always wins until release.
- **Reduced motion.** Direct manipulation is exempt (the position is the
  user's own hand, not decorative motion); only the settle degrades to a snap.

| | |
|---|---|
| **S** | Closes the one structural gap in A–F with a single primitive; zero per-frame boundary traffic *by construction*, so it works identically in the remote-UI configuration (the server only ever sees the settle write); `settle(bind:)` needs no new state concepts. |
| **W** | The heaviest renderer work item in this doc: input sampling, timeline seeking, velocity-projected settle — five times; the source vocabulary must stay closed and small (every new source is five implementations); interaction rules with B needed for the same node (rule: an exiting node's scrub sources detach immediately). |
| **O** | Velocity handoff generalizes to route-level interactive transitions later (swipe-back navigation, iOS's signature feel); composes with H for grab-and-drag shared elements. |
| **T** | Platform divergence in *feel* (rubber-band constants, velocity projection math) — the spec must pin the formulas numerically, and `engine-compatibility-tests/` must cover ordering (state push mid-drag loses until release). Canvas/desktop must keep hit-testing on scrubbed geometry (constraint #5 applies doubly). |

---

### Option H — Shared-element transitions **(shipped on the DOM renderer — see Shipped v1 for the as-implemented contract and v1 cuts; engine tags, renderers match)**

The list-thumbnail-becomes-detail-hero effect. **Decision: geometry lives
entirely with the renderers.** The engine knows nothing about frames or
layout; it contributes exactly two things it already has — identity (a
resolved prop) and atomicity (navigation is one patch batch containing the
outgoing `Detach` and incoming `Attach`/`Insert`).

```hypen
// List route
Image(src: "@{item.coverUrl}")
    .sharedElement("cover-@{item.id}")

// Detail route
Image(src: "@{state.restaurant.coverUrl}")
    .sharedElement("cover-@{state.restaurant.id}", curve: spring, duration: 350)
```

Renderer protocol (normative — the spec each renderer implements):

1. When a patch batch contains both a `Detach` and an `Attach`/`Insert`,
   snapshot the on-screen frames of outgoing nodes carrying `__anim.shared`
   keys *before* applying the batch.
2. Apply the batch; lay out the incoming tree (invisible for at most one
   frame is permitted).
3. For each key present on **both** sides: animate the incoming node from the
   source frame to its natural frame — transform-based FLIP, interpolating
   corner radius and opacity for visual continuity; crossfade content when the
   two nodes' content differs.
4. Any key unmatched or unmeasurable (source scrolled out of view, hidden):
   skip silently — the navigation degrades to a plain route transition.
5. Interruption (back-navigation mid-flight): retarget from the current
   *presentation* frame, never restart from the original source.

| | |
|---|---|
| **S** | The marquee polish feature for the most common navigation in every example app, at **zero engine/protocol cost** — the Detach/Attach seam plus one prop; degradation is total and silent (unmatched key = ordinary navigation), so it can ship renderer-by-renderer. |
| **W** | "Specified once, implemented five times" is the entire cost, and it's real: measurement timing and FLIP quality will vary in feel; text shared-elements look poor without font-size interpolation (off-whitelist — the crossfade fallback applies). |
| **O** | The measurement machinery built here is the same machinery B's `.layout` FLIP needs — building either one funds the other; `component-gallery-server` screenshot testing can pin transition midpoints cross-renderer. |
| **T** | Renderer divergence is the top risk — without normative spec text plus a conformance suite, iOS/Android/web ship three different-feeling apps. Keys are resolved strings, so typos fail silently *by design* (step 4); mitigate with a dev-mode warning when a navigation carries a shared key that matched nothing. |

---

## 4. Cross-cutting requirements (apply to whichever subset ships)

- **Patch protocol.** All options lower into: (a) reserved `__anim.*` entries in
  `ResolvedProps` (cheap: `Arc`-shared, travels once on `Create`), (b) a batch
  animation stamp (Option D) *(since shipped: the first-patch `batchAnimation`
  prelude — see the D contract in §3)*, (c) `RemoveAfterTransition` semantics
  (Option B). Renderers that don't understand `__anim` snap — every option
  degrades gracefully by construction.
- **Never tick in the engine.** The engine declares; renderers interpolate.
  The Canvas and Vello renderers need a shared ticker/interpolator module — the
  one place we hand-write animation math; DOM/iOS/Android delegate to the
  platform. *(Since shipped for Canvas: `CanvasAnimator` in
  `packages/web/src/canvas/anim.ts` — see the Canvas parity note in §3.)*
- **Interruption is not optional.** Every spec must define retarget behavior
  (new target mid-flight → continue from current visual value + velocity for
  springs). This is Compose/SwiftUI table stakes and CSS-transitions semantics;
  test it in `engine-compatibility-tests/` explicitly.
- **Reduced motion is a default, not a feature.** Renderers must consult the
  platform setting and degrade (crossfade or snap) with zero author code; an
  explicit `.motion(essential)` opt-out marks the rare animation that carries
  meaning (e.g. a progress indicator).
- **Hit-testing follows animated geometry** in retained renderers (Canvas,
  desktop). Android's View-animation bug is the cautionary tale.
- **Serialization.** The Remote UI protocol carries patches; `__anim` props ride
  along for free, but the batch stamp (D) and deferred remove (B) need explicit
  protocol-version treatment in `src/serialize/remote.rs`. *(Since shipped for
  D: the prelude is an unknown-type no-op for old clients, and the remote
  session's initialTree accumulation drops preludes — a stamp scopes exactly
  one live batch, never a replay.)*

## 5. Recommendation: a layered path

The prior-art convergence is striking — CSS, Compose, SwiftUI, and Framer all
landed on the same trio: **implicit value transitions + enter/exit + one
coordination construct**. Hypen should follow that spine, in dependency order:

| Layer | Option | Why this order |
|---|---|---|
| 1 | **A** `.transition` — **shipped** | Smallest surface; establishes the `__anim` prop channel, the animatable-prop whitelist, curves vocabulary, reduced-motion and interruption semantics that every later layer reuses. Replaces the web-only string passthrough with a portable equivalent. |
| 2 | **B** `.enter`/`.exit`/`.layout` — **shipped** | The one thing only the engine can do (deferred remove). With A+B, Hypen matches the daily-driver animation DX of SwiftUI/Compose. |
| 3 | **E (presets only)** — **shipped** | Built-in `pulse`/`spin`/`shimmer`/`shake` applied via `.animate(name, ...)`; author-defined `animation` blocks are **rejected** (maintainer decision — no custom keyframe DSL, see §E). |
| 4 | **C** `.states` — **shipped** (`onState` heads) | Choreography, once A's semantics are proven. Shipped as per-node pose switches lowering to A's channel (StateSwitch props + a synthesized `.transition`); the group-timing/stagger envelope stays deferred. |
| 5 | **H** shared elements — **shipped** (DOM) | Pure renderer track — needs only A's `__anim` channel and the existing Detach/Attach seam, so it started early and shipped renderer-by-renderer as predicted: DOM first, silent degradation covering the stragglers (Canvas/iOS/Android/desktop pending). Shipped ahead of D/F/G precisely because it cost the engine nothing. |
| 6 | **D** transaction scope — **cheap subset shipped** | The cheap subset shipped first exactly as planned (`animate:` on event applicators → the `batchAnimation` prelude; TS hosts only — see the as-shipped D contract in §3); the full SDK `animate()` block waits on the dispatch pipeline growing batch metadata. Defined from day one as an *override* of node defaults so precedence never changes under authors. |
| 7 | **F** machine model — **`.onAnimationComplete` shipped** | Decided: machines live in module code. `.onAnimationComplete` shipped together with C, as argued — it's the piece that makes module-resident machines work. |
| 8 | **G** scrub bindings — **shipped** (DOM) | Shipped after C exactly as re-anchored: `.scrub` interpolates between two `.states` poses (engine materializes the endpoint values as `__anim.scrubPoses`), `.settle(bind:)` writes the winning label through the `.bind` channel. Per-renderer as predicted — engine lowering everywhere, DOM renderer first; Canvas/iOS/Android/desktop ignore the four channels (see the as-shipped G contract in §3). |

The deliberate rejections, for the record: no ambient unscoped implicit
animation (SwiftUI's deprecated modifier), no wrapper components for exit
(React's `AnimatePresence`), no frame ticking through the state/patch pipeline
(React's per-frame `setState` trap), no GUI-required declarative format
(MotionLayout), no DSL-resident state machines (`animationMachine` was
considered and rejected — machines are logic, and logic lives in modules; see
§F), and **no custom keyframe-authoring DSL** (author-defined `animation { }`
blocks rejected by maintainer decision — the built-in presets are the entire
timeline surface; ambient motion is a preset, state-driven motion is a C pose,
structural motion is enter/exit) — Rive's *decomposition* is adopted, its
editor-locked artifact model and view-layer machine are not.

---

## 6. Flexibility audit — stress-testing the layered DX

How far does A–H actually stretch? Scenario coverage, honestly scored:

| Scenario | Layer | Verdict |
|---|---|---|
| Prop change glide (expand card, fade image in) | A | ✅ core case |
| Toast/dialog/menu enter & exit | B | ✅ core case |
| List add/remove/reorder (FLIP) | B | ✅ engine's keyed differ makes this a marquee |
| Snap on data refresh, glide on user tap | D | ✅ shipped (cheap subset) — `animate:` on the dispatching event stamps the first flush; TS hosts only |
| Spinner, shimmer, pulse, shake | E | ✅ presets |
| Coordinated multi-element + stagger | C | ⚠️ per-node pose switches shipped; the `stagger:`/group envelope is **deferred** — sibling nodes driven by the same path flip together but with no offset choreography |
| Staggered *entrance* of a list | B+C | ⚠️ needs `stagger:` on a container's `.enter` — trivial extension, spec it in B (**deferred** with C's stagger envelope) |
| Sequencing ("draw check, then pulse, then fade") | F | ✅ shipped — `.onAnimationComplete` advances the module-resident machine |
| Motion with memory (press-release vs hover-leave paths) | F | ✅ machine in module code |
| Gesture-driven scrubbing (bottom sheet drag, pull-to-refresh) | G | ✅ shipped (DOM) — `.scrub`/`.settle` between `.states` poses, renderer-resident; other renderers ignore the channels |
| Scroll-linked (collapsing header, parallax) | G | ✅ shipped (DOM) — `source: scroll` maps a container offset through the same progress formula, with rest-debounced endpoint writes |
| Shared-element / hero transitions | H | ✅ shipped (DOM) — engine tags identity, the renderer matches geometry; transform-only in v1 |
| Fling/decay physics | G | ✅ shipped (DOM) — velocity-projected `.settle` (100ms sample window, 150ms projection) |
| Text/blur/path-morph animation | — | ❌ outside the animatable whitelist by design |
| Character/mascot-grade motion | — | ❌ wrong tool; hand-writing this in any DSL is, too |

### 6.1 Why scrub is renderer-resident (the rationale behind Option G)

Everything in A–F shares one execution model: a discrete change (state flip,
insert, action) starts an animation that then runs **on a clock**. One message
crosses the engine boundary — "opacity is 1, take 300ms getting there" — and
time does the rest inside the renderer. That's why A–F are cheap: they
decorate round-trips that already happen, never add new ones.

A dragged bottom sheet breaks the model in kind, not degree: while the finger
is down there is no target and no clock — the sheet's position at every
instant *is* a function of the finger's position at that instant, 60–120
times per second. Same shape for scroll-linked headers (position = f(scroll
offset)), pull-to-refresh, and fling physics (the release velocity feeds a
decay/settle, so that row of the table is the same gap).

Modeling this with today's tools — `.translateY("@{state.dragY}")` — would run
the *entire* reactive pipeline per frame: touch event → JS →
`updateStateSparse` → WASM boundary → dirty tracking → reconcile → `SetProp` →
boundary again → DOM. Per-frame serialization cost, a frame of added latency
(drag feels rubbery), and in the remote-UI configuration a *network*
round-trip per frame — flatly impossible. It is React's per-frame `setState`
trap (§2) rebuilt inside the engine.

Option G therefore relocates the per-frame loop, not the declaration: the DSL
declares the **relationship** once ("this timeline's progress = this gesture's
vertical travel, normalized over 0–400px"); the renderer — which already owns
both the touch events and the pixels — closes the loop locally every frame,
and the engine hears only the discrete boundary (the settle write). Hypen
already has a subsystem built on exactly this principle: **event handling
flows renderer-side, not through patches** — renderers attach listeners and
forward only semantic actions. Scrub is the continuous generalization: raw
high-frequency input stays local; only *meaning* crosses the boundary.

### 6.2 Why the engine can't orchestrate shared elements (the rationale behind Option H)

The effect is built from a lie: the list thumbnail and the detail-page hero
are different nodes in different route trees that have never met. Selling the
lie takes three steps — measure the source's frame as navigation starts,
measure the target's frame after the new route lays out, animate between the
two frames while both real elements hide.

Step one is where naive routers lose: the outgoing element is destroyed before
it can be measured. Hypen's router *happens* to keep it — navigation emits
`Detach` (subtree alive in the route cache), so both trees coexist during the
transition window. That precondition is the "seam," and it exists today for
free.

The reason Option H puts everything else renderer-side is structural, not
preferential: **the engine cannot orchestrate this, because the engine doesn't
know geometry** — layout happens renderer-side in every backend (DOM layout,
the canvas flexbox engine, SwiftUI's layout system). The engine's maximum
contribution is tagging two ids as the same logical element and delivering
the Detach and Attach atomically in one batch — which is exactly, and only,
what Option H asks of it. The measure-match-animate choreography is the
normative renderer protocol in §H, specified once, implemented five times.

### 6.3 The whitelist: a contract with a per-property price

Extending "same patches, same UI, five renderers" to animation means every
whitelisted property must be (a) interpolatable at all, (b) unambiguous about
what 50%-of-the-way looks like, and (c) cheap to update per frame on *every*
backend. Numbers and transforms pass trivially; colors pass once the spec
fixes a color space ("interpolate in OKLab", or web and iOS show different
halfway-purples). That set is the whitelist. The instructive failures:

- **Text content** fails (a): there is no halfway point between `"Save"` and
  `"Saved!"`. A count-up or crossfade is a *designed feature*, not
  interpolation.
- **Blur** fails (c) asymmetrically: compositor-accelerated on DOM, per-frame
  CPU pixel work on Canvas 2D — whitelisting it ships an app that's silky on
  web and a jank bomb on canvas, the exact divergence the whitelist prevents.
- **Path morphing** fails (b): topology matching between arbitrary shapes is a
  substantial subsystem (a large part of what Rive *is*), times five backends.
- **`height: auto`-style values** fail (a) subtly: "auto" isn't a number until
  layout runs, and layout is renderer-side — CSS's twenty-year problem, and
  why Option B's `.layout` animates measured *transforms* (FLIP) instead of
  the layout value.

So the whitelist is not a technical wall but a contract with per-property
admission cost: interpolation spec + five implementations + conformance tests
in `engine-compatibility-tests/`. Any single property can be admitted later;
*arbitrary*-prop animation can never be promised without giving up
multi-renderer identity. Off-whitelist props don't error — they snap.

### 6.4 Why the ceiling is where it is

Every option lowers into one `__anim` prop channel plus three patch
decorations (enter/exit/layout intent, batch stamps, deferred remove). G and
H proved the point in this very document: both were "gaps" until they were
specced as additions to that channel — scrub as a renderer-resident binding
prop, shared elements as an identity prop over the existing Detach/Attach —
with zero re-architecture. Remaining frontiers (stagger-on-enter, swipe-back
route scrubbing, blend states) follow the same path. The two real ceilings are deliberate: the animatable-prop
whitelist (§6.3) and no per-frame engine involvement (§6.1). Both can be
raised property-by-property or renderer-by-renderer; neither can be removed
without giving up what makes Hypen Hypen.
