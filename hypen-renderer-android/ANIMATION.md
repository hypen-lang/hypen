# Animation implementation notes — Android / Jetpack Compose renderer

Handoff notes for implementing the shipped Hypen animation protocol
("Shipped v1", `ANIMATION_API_DESIGN.md` §3, lines 287–931 — normative) in
`hypen-renderer-android`. Written against branch
`claude/hypen-animation-api-design-09ar7c`; all file:line anchors verified
against the sources. Reference implementations, in usefulness order for
Compose: DOM (`hypen-web/packages/web/src/dom/anim.ts` — declarative-native,
the closest analog), Canvas (`packages/web/src/canvas/anim.ts`,
`CanvasAnimator` :580 — the tick-based fallback pattern when a native
facility can't express something), desktop
(`hypen-renderer-desktop/src/anim.rs`, `DesktopAnimator` :709 — tick-based
in Rust; its module header, :1–100, is the model for an honest per-channel
capability matrix), scrub (`packages/web/src/dom/scrub.ts` — interaction
contracts). Their module headers ARE the contracts; read them first.

## Capability matrix (as shipped — stage 1, #159)

Honest per-channel status, in the spirit of the desktop renderer's module
header. Everything not "done" degrades by snapping to the correct final
state; nothing errors.

| Channel | Status | Notes |
|---|---|---|
| `.transition` | **done** | All 27 whitelisted props. Interpolated values are written back as *animation overrides* on `HypenElement`, so each prop animates through its existing applicator/component — no per-prop special-casing. Colors interpolate in straight sRGB (NOT Compose's Oklab `Color.lerp`), matching canvas/DOM. Unparseable endpoints or a unit change (`50%`→`200px`) snap. |
| `.states` | **done** | Free via `.transition` (engine synthesizes a scoped one). `__anim.states` is parsed as the OBJECT `{"label": ...}`, tolerating a bare string; label changes time the `states` completion. |
| `.enter` / `.exit` | **done** | `graphicsLayer` pose, not `AnimatedVisibility` — see the deviation note below. Full deferred-remove contract: root-first ordering, descendant deferral, duplicate-flag folding, `duration+delay+80ms` backbone. |
| `batchAnimation` | **done** | Index-0-only stamp, per-batch spec model (Compose has no ambient transaction). Precedence `structural > transaction > node .transition > snap`; nodes created this batch, exiting nodes, and nodes with an in-flight playback are excluded. |
| `.animate` | **done** | pulse / spin / shake / shimmer with the normative timing defaults; looping vs finite; a cached `attach` never replays a finite repeat; presets yield to an in-flight enter/exit (one modifier owner, so no precedence inversion). |
| `.motion(essential)` | **done** | Exempts a node from every reduced-motion shortcut. |
| Reduced motion | **done** | `Settings.Global.ANIMATOR_DURATION_SCALE == 0` with a live `ContentObserver`. Enters skipped, exits finalized on the next tick, glides snapped, no completions. Non-zero developer scales (0.5×/5×) are deliberately NOT applied — we time our own playbacks and our finalize backbone off the same unscaled numbers. |
| `.onAnimationComplete` | **done** | Natural settle only. Payloads exactly `{animation}` / `{animation:"states", state}`; completion fields written last so custom args can't shadow them. |
| `.layout` | **parsed, snapped** | Sanctioned v1 snap (canvas/desktop precedent). `Modifier.animateItem` only works in Lazy containers, which this renderer's Column/Row children are not; `LookaheadScope` is the roadmap. |
| `.sharedElement` | **not implemented** | Stage 2. `SharedTransitionLayout` across the Detach/Attach seam. |
| `.scrub` / `.settle` | **not implemented** | Stage 2. The full interaction contract below still stands. |

**Recorded deviation — no `AnimatedVisibility`.** Enter/exit play as a
`graphicsLayer` pose (alpha + translation + scale) instead. Reasons:
`AnimatedVisibility` inserts its own layout node, which breaks the
Row/Column scope chain this renderer relies on to apply `.weight()` to the
element's own modifier; and it shrinks the exiting slot, whereas the shipped
web/canvas contract is that an exiting node keeps occupying layout until
finalize. A modifier-only pose keeps layout identical and keeps hit targets
glued to the pixels (invariant 5). The exact settle signal
`MutableTransitionState.isIdle` would have given us is replaced by the
`animate()` suspend function returning normally — same guarantee, and the
timeout backbone still runs when the composable never composes.

**Interaction exclusion — what is and isn't covered.** An exiting subtree is
excluded on four planes: pointer events (consumed at
`PointerEventPass.Initial` on the exiting root, so nothing beneath sees
them), action dispatch (gated at `ComposeRenderer.createApplicatorContext`,
which is the chokepoint every applicator-driven handler goes through),
accessibility (`Modifier.clearAndSetSemantics {}` on the root clears the
whole subtree), and focus (`Modifier.focusProperties { canFocus = false }`
plus an imperative `LocalFocusManager.clearFocus(force = true)` when the
exit begins, so the soft keyboard dismisses). **Not covered:** components
that capture `LocalActionDispatcher.current` directly (Button, Input,
Checkbox, Switch, Select, Slider, TextArea) hold the UNGATED dispatcher —
they are protected by the pointer consumption and the focus clear, but a
non-pointer, non-focus path inside one of those components could still
dispatch during an exit. Closing that would mean providing a per-element
gated `LocalActionDispatcher`, which is a `staticCompositionLocalOf` and
would invalidate the subtree on every change; deferred deliberately.

**Cost note.** An element with an in-flight glide bumps `propsRevision` per
frame, so its remembered applicator chain rebuilds per frame. That is the
price of animating every whitelisted prop through its existing applicator
rather than special-casing five of them in a graphics layer; structural
playbacks (enter/exit/presets) cost NO recomposition because
`graphicsLayer {}`'s lambda form reads the pose at layer-update time.

## Where this renderer sits today

This renderer is **already Jetpack Compose** (the spec's §2 Android history
— View anim → ObjectAnimator → MotionLayout → Compose,
ANIMATION_API_DESIGN.md:125 — is prior-art analysis, not a migration TODO;
the View-anim hit-target bug is why protocol invariant 5 exists). It is a
Remote-UI WebSocket client: JSON patches in
(`renderer/src/main/java/space/hypen/renderer/model/Patch.kt` — `PatchType`
enum :9, `Patch` data class :72; parsed by `remote/MessageParser.kt`),
applied by `ComposeRenderer`
(`renderer/src/main/java/space/hypen/renderer/render/ComposeRenderer.kt` —
`applyPatches` :79, `onCreate` :167, `onSetProp` :211, `onRemove` :300,
`onDetach` :342, `onAttach` :369). `HypenElement` props are
snapshot-backed (`bumpPropsRevision`, used at ComposeRenderer.kt:191/:217):
a `SetProp` recomposes only the composables reading that element. Styling
flows through `ApplicatorRegistry` → `Modifier` transforms
(`applicators/VisualEffectsApplicators.kt` — `rotate` :207, `scale` :234,
`graphicsLayer` clip :202). Nothing animates today: `__anim.*` props are
unknown names and snap — the sanctioned degradation.

Who feeds it matters:

- **TS hosts** emit the full-fidelity JSON wire (`Remove.transition`, the
  `batchAnimation` prelude, all `__anim.*` props). The props already reach
  this renderer; the flag is never read (`Patch.kt` has no field for it)
  and an unknown `batchAnimation` type never parses — both dropped
  client-side.
- **Kotlin host** (`hypen-kotlin` `HypenServer`) consumes the UniFFI
  `Patch` record, which drops the flag and the prelude server-side (the
  policy comments in `hypen-engine-rs/src/uniffi/mod.rs:254–264` and
  :366–375 mark the exact spots), so clients of a Kotlin-hosted app —
  including *browser* clients — cannot animate exits/transactions until
  the FFI gap is fixed.
- **Go host** already relays the prelude (`hypen-golang/remote/types.go`
  `Patch.Spec`) and the flag rides its JSON passthrough.

## Protocol invariants (non-negotiable)

Identical section in `hypen-renderer-swift/ANIMATION.md`. These are the
rules every renderer implementation has re-derived the hard way; do not
relitigate them.

1. **Never tick through the engine.** The engine declares intent; renderers
   interpolate (spec §1 constraint 1, §4 "Never tick in the engine",
   ANIMATION_API_DESIGN.md:1215). No per-frame `updateState`, no per-frame
   `dispatchAction`, no SetProp echo. Scrub in particular produces ZERO
   engine traffic while a finger or scroll is live (§6.1, spec:1290) — only
   the settle write crosses the boundary.
2. **Renderers own corpses.** A `Remove{transition:true}` means the
   engine-side id is dead the moment the patch is emitted — no ack
   round-trip ever (`reconcile/patch.rs:184–208`). The renderer plays the
   exit and finalizes teardown itself, on a `duration + delay + 80ms`
   timeout backbone (`dom/anim.ts:158` `SETTLE_GRACE_MS = 80`) even if the
   platform's completion callback never fires.
3. **First-patch-only preludes.** `batchAnimation` is a stamp only at batch
   index 0, on BOTH ends (engine emits it only there; renderers honor it
   only there — `dom/renderer.ts:247–252`). A prelude anywhere else, or in
   an accumulated/replayed initialTree, is not a stamp. This is what stops
   concatenated batches from over-scoping.
4. **Natural-settle-only completions.** `.onAnimationComplete` fires only
   when a playback settles naturally. Interrupted, superseded,
   reduced-motion-skipped, detached-subtree, and exiting-subtree playbacks
   fire NOTHING; looping presets never complete (spec:538–565). This
   removes most completion races by construction — do not "helpfully" fire
   on cancellation.
5. **Pixels never move without hit-targets.** The recurring lesson (spec §2
   Android View-anim history :125, §4 :1228, load-bearing in both the
   canvas and desktop tickers). Anything that moves must move its hit
   target, its focus target, and its accessibility node with it — or be
   excluded from all three for the duration. Conversely an exiting subtree
   is excluded from hit-testing/events/focus/a11y IMMEDIATELY, before the
   playback starts. Compose keeps hit-testing on the composed layout, so
   `Modifier.offset`/`graphicsLayer` used for playback moves the touch
   target with the pixels — the platform pays this invariant for you as
   long as motion stays in modifiers, never in a detached overlay.
6. **Snap, don't error.** Malformed specs, unknown presets, unexpressible
   channels: warn (at most once) and show the correct final state. Every
   degradation in the desktop capability matrix (`desktop/src/anim.rs`
   header) is silent and honest. A renderer must never render a wrong pose
   to preserve a pretty animation.

## FFI prerequisites (do this first)

Same Rust change as documented in the iOS notes (single source: do it
once). In `hypen-engine-rs/src/uniffi/mod.rs`:

1. Add `#[uniffi(default = false)] pub transition: bool` to the flat
   `Patch` record (:229–245); stop discarding it in `from_internal`'s
   `InternalPatch::Remove` arm (:366–387, the "KNOWN v1 LIMITATION"
   comment).
2. Add `PatchType::BatchAnimation` (:204–225) plus
   `#[uniffi(default = None)] pub spec_json: Option<String>`; replace the
   `InternalPatch::BatchAnimation { .. } => return None` drop (:254–264).

Regenerate BOTH binding sets in the same commit (`cargo build --release
--features uniffi`, then `uniffi-bindgen generate --library ...` for kotlin
AND swift — procedure in mod.rs:6–17). The generated Kotlin record is
`hypen-kotlin/src/main/kotlin/uniffi/hypen_engine/hypen_engine.kt:2580`;
`FfiConverterTypePatch.read` is positional, so a stale generated file
mis-reads every field after the new one.

**Kotlin-side plumbing** (each new field must survive the whole relay):

- `hypen-kotlin/.../core/NativeEngine.kt:412` — the uniffi→core `Patch`
  mapper: carry `transition` and map the new patch type to the wire name
  `"batchAnimation"` with the parsed `spec`.
- `hypen-kotlin/.../core/Types.kt:69` — the wire `Patch`: add
  `val transition: Boolean? = null` and `val spec: JsonElement? = null`
  (kotlinx default-omission keeps the wire byte-identical when absent —
  the serde skip-if-false contract, patch.rs:31–35, must survive the
  relay). `HypenServer`'s `Json.encodeToJsonElement(patch)` then relays
  them for free.
- **This renderer**: `model/Patch.kt` — add `val transition: Boolean =
  false` and a `BATCH_ANIMATION` patch type carrying `spec`;
  `MessageParser` must parse both (today an unknown type is dropped —
  correct degradation, but it eats the prelude forever).

**`__hypenAnimate`:** the Kotlin host already strips the reserved dispatch
key correctly (`HypenServer.kt:20` `RESERVED_ANIMATE_KEY`, strip with
policy comment at :386–401) — nothing to do here. (The Swift host is the
one missing it; see the iOS notes.)

## Channel-by-channel mapping

Vocabulary source of truth: `hypen-engine-rs/src/ir/anim.rs` (`CURVES` :19,
`PRESETS` :22, `ANIMATE_PRESETS` :26, `DIRECTIONS` :29, `ANIMATABLE_PROPS`
:36–64 — 27 entries, `SCRUB_SOURCES`/`SCRUB_AXES` :1068–1071), mirrored by
`@hypen-space/core/animation` (`CURVE_TO_CSS` :134, `CURVE_BEZIER_POINTS`
:162, `ANIMATE_PRESETS` :433). Route on one `startsWith("__anim.")` check.
Wire shapes: spec:329–338.

| Channel | Wire prop | Compose mapping | Priority |
|---|---|---|---|
| `.transition` | `__anim.transition` | animated prop resolution (`Animatable`/`animate*AsState`) at applicator altitude | P0 |
| `.enter`/`.exit` | `__anim.enter` / `__anim.exit` + flagged `Remove` | `AnimatedVisibility(MutableTransitionState)`; renderer-owned deferred teardown | P0 |
| `.states` | ordinary `SetProp`s + `__anim.states` label | free once `.transition` works | P0 (free) |
| `batchAnimation` | first-patch prelude | per-batch override spec consulted by the same animated resolution | P1 |
| `.layout` | `__anim.layout` on `Move` | sanctioned snap in v1 (canvas/desktop precedent); `LookaheadScope` is roadmap | P2 |
| `.animate` | `__anim.animate` | `rememberInfiniteTransition` / finite `Animatable` loops; shimmer = gradient overlay | P1 |
| `.motion(essential)` | `__anim.motion` `{essential:true}` | per-node exemption from the reduce-motion gate | P1 |
| `.sharedElement` | `__anim.sharedKey` + `__anim.shared` | `SharedTransitionLayout` across the Detach/Attach seam | P2 |
| `.scrub`/`.settle` | `__anim.scrub*` (four props) | `pointerInput` drag loop + `withFrameNanos` settle, full contract | P2 |

### Curves — pin the bezier

`linear|easeIn|easeOut|easeInOut` map to explicit `CubicBezierEasing`
instances built from `CURVE_BEZIER_POINTS` (core/animation.ts:162) — do NOT
substitute Compose's `FastOutSlowInEasing` family; they are different
curves. **`spring` is not Compose's `spring()`**: the wire contract is the
fixed overshoot bezier `cubic-bezier(0.34, 1.56, 0.64, 1)` (spec:319–321,
`CURVE_TO_CSS` :139), so:

```kotlin
val HypenSpring = CubicBezierEasing(0.34f, 1.56f, 0.64f, 1f)
fun hypenEasing(token: String): Easing = when (token) {
    "spring" -> HypenSpring
    "linear" -> LinearEasing
    "easeIn" -> CubicBezierEasing(0.42f, 0f, 1f, 1f)
    "easeInOut" -> CubicBezierEasing(0.42f, 0f, 0.58f, 1f)
    else -> CubicBezierEasing(0f, 0f, 0.58f, 1f)   // easeOut, the family default
}
// tween(durationMillis = spec.duration, delayMillis = spec.delay, easing = hypenEasing(spec.curve))
```

Note `CubicBezierEasing` accepts y-overshoot control points (1.56) — the
same evaluation the canvas/desktop tickers do numerically
(`curveFunction`, core/animation.ts:269).

### `.transition` — animated prop resolution

Props are read during composition through `ApplicatorRegistry.applyAll` /
component prop getters; the natural altitude is a per-element animated
resolver: when an element carries a parsed `__anim.transition` and a read
prop key is on the whitelist (and inside `props:[...]` when scoped),
resolve the value through a remembered `Animatable` keyed by element id +
prop, launching `animateTo(target, tween(...))` when the snapshot value
changes. `Animatable` gives the interruption contract natively (retarget
continues from current value — spec §4:1220); `animate*AsState` works for
float/color but hides retarget velocity — either is acceptable for tweens.
Interpolate colors in RGBA like canvas does (spec:440–443; unparseable
colors snap). Non-whitelisted props snap even mid-spec. The deprecated
legacy string form arrives as `transition.0` (ir/anim.rs:98) — web-only;
ignore it.

Because `.states` pose flips arrive as ordinary `SetProp`s with a
synthesized scoped `__anim.transition` (spec:522–536), this one mechanism
makes `.states` glide for free (`states-lowering.json`,
`states-switch.json`, `states-explicit-transition-wins.json`).
`__anim.states` (the label prop) is only needed for completion timing and
scrub anchoring — ignore until then.

### `.enter` / `.exit` — AnimatedVisibility + the deferred-remove contract

Presets (spec:319–327): `fade` → `fadeIn`/`fadeOut`; `slide` → a **24px**
offset toward/from the direction (`leading`/`trailing` resolve against
`LocalLayoutDirection`; use `slideIn { IntOffset(...) }` with the fixed
24px nudge — not a full-width slide, matching DOM/canvas); `scale` →
`scaleIn(initialScale = 0.95f)`. Presets compose with `+`. Defaults: enter
`{200ms, easeOut, [fade]}`, exit `{150ms, easeIn, [fade]}`.

The clean Compose shape: wrap each element view whose element carries
enter/exit specs in `AnimatedVisibility(visibleState =
remember { MutableTransitionState(initialVisible) }, enter = ..., exit =
...)`. `MutableTransitionState.isIdle`/`currentState` give an exact
natural-settle signal — Compose's advantage over SwiftUI here — which is
what completion events (P2) and exit finalize want. But keep the timeout
backbone anyway (invariant 2): a composable that never recomposes (backgrounded,
detached window) must still finalize.

**Enter rules** (dom/anim.ts:11–14; canvas and desktop match): play ONLY
for ids created in the current `applyPatches` batch; suppress the
first-ever batch; a cached Router `Attach` (`onAttach`, ComposeRenderer.kt:369)
NEVER enter-animates. Track a created-this-batch set in the renderer and
start such nodes with `MutableTransitionState(false).apply { targetState =
true }`; everything else composes visible with no transition.

**Exit — the deferred-remove protocol** (spec:340–356, patch.rs:184–208).
The wire order is: flagged root `Remove` FIRST, then descendants as plain
Removes (parent-remove-wins; descendants are plain even with their own exit
specs). Non-animated subtrees keep the old post-order. Required behavior in
`onRemove` (ComposeRenderer.kt:300):

1. `transition == true` and the element carries `__anim.exit` → do not
   evict from `elements`. Mark the id exiting.
2. **Immediately** exclude the subtree from interaction — all four planes
   (the DOM uses `data-hypen-exiting` + `inert`, dom/anim.ts:16, plus a
   dispatch-level guard at `dom/applicators/events.ts:278–280` because the
   engine-side ids are already dead): gate `dispatchAction` for elements
   in an exiting subtree (the renderer's `dispatchAction`,
   ComposeRenderer.kt:451, is the single chokepoint — check there),
   `Modifier.pointerInput`/clickables disabled for the subtree, semantics
   hidden (`Modifier.clearAndSetSemantics {}` or
   `semantics { invisibleToUser() }` — pointer gating alone leaves
   TalkBack live inside a corpse), and focus killed
   (`focusProperties { canFocus = false }`; clear focus if an `Input`
   inside the subtree owns it — the soft keyboard must dismiss).
3. Set the subtree's `MutableTransitionState.targetState = false` so the
   exit plays.
4. Finalize on `isIdle` (natural settle) OR the `duration + delay + 80ms`
   timer, whichever first (dom/anim.ts:158; desktop `finalize_overdue`
   :1639 exists for exactly the stalled-clock case). Finalize = evict root
   and all deferred descendants from `elements` (today's `onRemove` +
   `removeDescendants`, :300–329).
5. Plain Removes for ids **inside** an exiting subtree defer to the root's
   finalize (`deferToExitingAncestor`, dom/anim.ts:1059–1077). Fixture for
   the replacement shape: `exit-nested-descendant-removes.json`.
6. Duplicate flagged remove for an already-exiting id: keep one finalize
   (dom/anim.ts:984–990).

Known v1 web limit (spec:422–425): an exiting node still occupies layout.
`AnimatedVisibility` shrinks the slot as the exit plays — closer to the
sibling-shift roadmap; acceptable renderer-owned choreography.

Fixtures: `exit-deferred-remove.json`, `foreach-exit-remove.json`,
`enter-exit-lowering.json`.

### `batchAnimation` — the transaction prelude

After the FFI fix, honor `{"type":"batchAnimation","spec":{...}}` at batch
index 0 ONLY (invariant 3). Compose has no ambient `withAnimation`
transaction — implement the DOM/canvas model instead (spec:754–774): stash
the spec as "current batch spec" before applying patches, and have the
animated prop resolver use it as the tween for every whitelisted prop the
batch writes — on any node, `.transition` or not — then clear at flush
(the canvas rule, `CanvasAnimator`; desktop `ingest` :871–880 is the Rust
model). Precedence (normative): **structural playbacks
(enter/exit/FLIP/shared) > transaction > node `.transition` > snap.**
Exclusions: nodes with an in-flight enter/exit apply unstamped; nodes
created in the same batch are excluded (their queued enter owns the first
motion); exiting nodes snap. A node still settling from a *previous*
transaction retargets seamlessly. Reduced motion ignores stamps except for
`.motion(essential)` nodes. Fixture: `batch-animation-stamp.json`; schema:
`engine-compatibility-tests/schema/patch.schema.json`.

### `.layout` — sanctioned snap in v1

DOM FLIPs `Move` patches; canvas and desktop deliberately snap
(spec:451–454 — geometry owners must not run paint-only FLIPs, invariant
5). Compose's honest options are `Modifier.animateItem` (only inside Lazy
containers — this renderer's Column/Row children are not lazy) and
`LookaheadScope` (invasive). Recommendation: snap in v1, record it in this
file's capability matrix like desktop does, revisit with `LookaheadScope`
when the component layer stabilizes.

### `.animate` presets

Closed vocabulary `pulse|spin|shimmer|shake` (ir/anim.rs:26); keyframe
*shapes* renderer-owned, names + timing defaults normative
(`ANIMATE_PRESETS`, core/animation.ts:433: pulse `{1200, loop, easeInOut}`,
spin `{800, loop, linear}`, shimmer `{1500, loop, linear}`, shake
`{400, 1, easeInOut}`). DOM shapes to match: pulse = opacity 1→0.5→1;
spin = 360° rotation; shake = ±translateX oscillation; shimmer = moving
gradient overlay (Compose: `rememberInfiniteTransition` driving a
`Brush.linearGradient` offset in `drawWithCache` — feasible, P2). Loops via
`rememberInfiniteTransition`, finite repeats via `Animatable` +
`repeat(n)`. Carry-over contracts (spec:404–414): changed spec restarts;
removed channel stops; exiting nodes keep playing; cached `Attach` resumes
loops but never replays finite repeats; a preset animating opacity/
transform is suspended while an enter/exit plays on the same node, then
resumed (the DOM suspend machinery, dom/anim.ts:53–62 — in Compose the
equivalent trap is an infinite transition writing the same
`graphicsLayer` fields a playback needs; route both through one modifier
owner so the playback wins). Fixtures: `animate-lowering.json`,
`animate-repeat-forms.json`, `animate-unknown-preset.json` (unknown preset
⇒ channel omitted entirely).

### Reduced motion — `ANIMATOR_DURATION_SCALE` — and `.motion(essential)`

Android's "Remove animations" accessibility switch sets
`Settings.Global.ANIMATOR_DURATION_SCALE` to 0. Gate on it explicitly:

```kotlin
fun reducedMotion(context: Context): Boolean =
    Settings.Global.getFloat(context.contentResolver,
        Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
// equivalently: !ValueAnimator.areAnimatorsEnabled()
```

Register a `ContentObserver` on
`Settings.Global.getUriFor(ANIMATOR_DURATION_SCALE)` for live toggles —
the web renderers listen live (`matchMedia` change listener,
dom/anim.ts:462; canvas likewise, spec:457–459), and the parity bar is a
mid-session toggle taking effect without reconnect. Do NOT rely on Compose
scaling durations for you: regardless of what the Compose BOM in use does
with the scale, the protocol's reduced-motion contract is stronger than
duration-0 — snap everything, finalize exits immediately (post one frame,
mirroring the DOM's microtask, dom/anim.ts:1017–1027), skip enters, fire
no completions. Also beware developer-setting scales (0.5×/5×): if you let
the platform scale durations, scale the `duration + delay + 80ms` finalize
backbone identically or long-scale animations get truncated.

`__anim.motion` `{essential:true}` (ir/anim.rs:66–72, fixture
`motion-essential-lowering.json`, #149) exempts that node from ALL
reduced-motion shortcuts — essential nodes enter, exit, glide, and pulse
as if the switch were off (dom/anim.ts:67–73). Shared-element flights stay
globally skipped under reduced motion even for essential nodes (inherently
decorative). Scrub DRAGGING is exempt by spec (direct manipulation); only
the release settle snaps (spec:899–902).

### `.sharedElement` — SharedTransitionLayout across the Router seam

Wire: `__anim.sharedKey` (resolved string — the ONE animation argument
where bindings are legal, re-resolves as `SetProp`) + `__anim.shared`
(`{duration, curve}`, defaults `{350, spring}`) (spec:567–587,
`shared-element-lowering.json`). Compose's
`SharedTransitionLayout`/`Modifier.sharedElement` (androidx.compose
animation 1.7+) is the native mechanism; hold it to the v1 contract
(spec:589–652):

- Navigation shape = a batch containing BOTH a `Detach` and an
  `Attach`/`Insert`. Sources are keyed nodes **at-or-under the batch's
  detach roots only** — a persistent app-shell node sharing a key is never
  a source (v1 narrowing; the web shipped this after review found the
  shadowing bug).
- The **incoming** node's `__anim.shared` spec times the flight
  (`boundsTransform` returning the pinned-bezier tween).
- A match suppresses the incoming node's own `.enter` (one motion, not
  two); exiting nodes never participate as targets; a snapshot matching
  its own node (cached subtree persisting) is no match.
- Unmatched/unmeasurable keys = plain navigation, silent; dev-warn once
  per key for source-only/target-only keys.
- v1 is transform-only continuity (no content crossfade, no
  corner-radius/opacity interpolation — recorded roadmap, spec:636–652).
  Prefer `sharedElement` over `sharedBounds` (which crossfades).
- Zero-delta match = instant natural settle: enter stays suppressed and
  (if completions are implemented) `{ "animation": "sharedElement" }`
  dispatches immediately (spec:628–634). Reduced motion: no snapshot at
  all.
- Interruption must retarget from the current presentation position —
  the Compose shared-element APIs do this natively.

### `.scrub` / `.settle` — the full interaction contract

Wire: four static props (`__anim.scrub`, `__anim.scrubSettle`,
`__anim.scrubBind`, `__anim.scrubPoses` — spec:820–843,
`scrub-lowering.json`); `__anim.scrubPoses` materializes both endpoint
values per prop key so the renderer interpolates without knowing the pose
machinery. The normative contract is the `scrub.ts` module header (:1–94)
with pinned numbers (:126–136). Implement with `Modifier.pointerInput` +
`awaitPointerEventScope` (NOT `detectDragGestures` — its slop and consume
semantics don't match the contract):

- **Claim:** down opens a PENDING drag; claim (consume the pointer) only
  after ~6px axis travel (`SCRUB_SLOP_PX`, scrub.ts:128 — the pinned
  cross-renderer number; do not substitute `viewConfiguration.touchSlop`,
  which is ~8dp and device-dependent). A tap is a TOTAL no-op: no
  consume, no settle, no bind write, child clicks unaffected. Recorded
  deviation: grabbing a mid-settle element claims immediately. Only the
  claiming `pointerId` drives move/up/cancel; a second finger is noise.
- **Anchoring (the root defect of the adversarial review — see
  CHANGELOG.md Unreleased → Fixed, scrub entry):** mapping is RELATIVE:
  `p = pAtGrab + travel / (over[1] − over[0])`, rubber-banded on the
  result beyond [0,1] (`p' = bound + (p − bound) · rubberBand`; the shared
  normative implementation is `scrubProgress`, core/animation.ts:833 —
  port it, don't re-derive). Seed the anchor from the `__anim.states`
  label (`from`→0, `to`→1) at create and on every label SetProp landing
  while no interaction owns the node. Anchoring at 0 snapped open sheets
  closed — the bug both reviewers found independently.
- **Release:** velocity from the last ~5 samples, discarding samples older
  than ~100ms (`VELOCITY_WINDOW_MS`, scrub.ts:132; empty window ⇒ v = 0 —
  drag-hold-release projects nothing). Do not substitute Compose's
  `VelocityTracker` — its window differs; the formula is pinned. Project
  `p* = p + v · 150ms` (`SCRUB_PROJECTION_MS` :126); `p* >= 0.5` → `to`
  (tie pinned by test). Settle via a `withFrameNanos` loop writing the
  interpolated values — NOT a Compose animation: arrival must be an exact
  observable event (the bind write fires ON arrival) and a mid-settle grab
  needs the loop's live progress (scrub.ts:36–51).
- **Bind write + cleanup handshake:** on arrival dispatch
  `__hypen_bind {path, value: label}` — the exact `.bind` channel
  (`BaseModuleInstance.kt:134` registers the handler host-side). KEEP the
  final interpolated values until the FIRST `__anim.states` label SetProp
  — **any label, matching or not** — with a ~500ms timeout fallback
  (scrub.ts:53–59, :134).
- **Scroll source:** the `of:`-named container (resolved `id` prop —
  requires a small id→ScrollState/LazyListState registry; unmatched name
  warns once, falls back to nearest scrollable ancestor), offset maps
  ABSOLUTELY through `over`. No release: the bind write fires when
  progress crosses and RESTS at an endpoint (~150ms debounce). Deferral is
  quiescence-bounded: after ~150ms of mid-range rest, deferred engine
  writes flush (concede) and ownership releases until the next scroll
  event — a collapsing header must never dead-lock sibling updates.
- **Gesture wins:** engine SetProps to scrubbed keys defer (latest value,
  applied at cleanup) while an interaction owns the node. Precedence:
  **scrub > structural > transaction > node `.transition`**. Remove/detach
  mid-drag cancels everything; scrub sources detach BEFORE any exit
  playback; a cancelled settle never writes state; cached re-attach
  re-arms scroll sources.
- Reduced motion: drag unchanged; release settles instantly, then writes.
  Zero engine traffic during any drag or scroll tracking.

## Pitfalls (distilled from the hardening history)

All confirmed adversarial-review findings on the web implementations
(CHANGELOG.md Unreleased → Fixed, three entries; commits `46467f5b`,
`7c2d85eb`, `c657a4bd`). Mobile will hit the same classes.

- **Settle-takeover:** every path that supersedes a playback must clear
  ALL of the predecessor's bookkeeping (the web bug: a shared flight's
  pinned transform-origin survived takeover). In Compose: a superseded
  `Animatable` must be `stop()`ped/snapped, and any modifier state a
  playback pinned must be reset by every superseding path, not just its
  own settle.
- **Key aliasing (shared elements):** duplicate source keys keep the
  first; a node matching its own snapshot is no match; still-visible
  nodes are never sources; per-batch shared state resets at the START of
  the next pre-pass so a throwing batch can't leak snapshots.
- **Exit exclusion is four planes, not one:** touches, event dispatch,
  focus/IME, accessibility. Pointer gating alone leaves TalkBack and a
  focused `Input`'s keyboard live inside a corpse — the web needed `inert`
  plus a dispatch-level guard (`dom/applicators/events.ts:278–280`).
- **Stamp lifecycle races (if/when Kotlin-host stamping lands):**
  per-dispatch token identity, entry drain, first-flush consumption,
  post-sync clear, completion backstop — the 5-step lifecycle at
  spec:717–753. Engine side is already correct (`engine_core.rs:52`
  `pending_animation`, consumed at :409; no stamp without patches). Note
  Go *evaluated and declined* dispatch-side stamping for reasons
  (synchronous per-mutation notify, no batch boundary) that partially
  apply to the Kotlin observable too — read `hypen-golang/CHANGELOG.md`
  before attempting it.
- **Interaction lifecycle:** taps must be total no-ops; dead interactions
  never write state (cancel-before-exit ordering); ownership always
  releases (bounded deferral); ANY label completes the cleanup handshake.
- **First-batch suppression + no-replay-on-attach:** initial render must
  not cascade enters; cached routes (`onAttach`) must not replay enters or
  finite presets.
- **Precedence inversions:** identify which Compose mechanism wins by
  construction vs. which must win by contract — an `InfiniteTransition`
  writing `graphicsLayer` fields will fight an exit playback exactly the
  way a running CSS animation beat inline styles on the web
  (dom/anim.ts:53–62); route conflicting writers through one owner.

## Conformance graduation (the Kotlin runner)

Engine-side lowering is pinned by the 20 fixtures in
`engine-compatibility-tests/fixtures/animation/`, run by the Rust and TS
runners. The Kotlin runner currently skips the whole category:
`hypen-kotlin/src/test/kotlin/space/hypen/core/CompatibilityTest.kt:141`
lumps `"animation"` in with the render categories under "requires full
engine (parser/renderer)" (commit `ce69d598` made the skip intentional).
Graduation steps:

1. Land the uniffi FFI fix first. This is a hard gate: through today's
   boundary `exit-deferred-remove.json` (expects `transition: true`) and
   `batch-animation-stamp.json` (expects the prelude) CANNOT pass — the
   fields don't exist in the generated record.
2. Kotlin HAS a full engine (`NativeEngine.kt` over uniffi
   `render_source`/`update_state`) — implement a render-category runner
   that feeds `input.source` + `initialState` and asserts the
   `expected.patches` shapes (props including `__anim.*`, patch types,
   the flag), mirroring
   `engine-compatibility-tests/runners/rust/tests/compatibility.rs`.
3. Lift `"animation"` out of the skip arm; keep honoring per-fixture
   `skip.sdks` (several fixtures skip `golang`/`typescript` with recorded
   reasons — follow that pattern for anything Kotlin genuinely can't run,
   with a reason string).
4. Renderer-level verification is visual, not fixture-based: drive the
   gallery (`open_gallery.sh`, `run_on_sim.sh`, `sim_screen.sh`) against
   the same app on the DOM renderer. The spec's feel bar (spec:654–660):
   spring overshoot ≈9.5% of travel, `{350, spring}` shared flights, no
   double motion on matched enters, taps never stolen by scrub surfaces.
5. Update the host-matrix rows for uniffi/Android in
   `ANIMATION_API_DESIGN.md` §3 and `hypen-web/docs/animation.md` as each
   channel ships — both currently record Android as snap-everything, and
   that documentation is load-bearing.
