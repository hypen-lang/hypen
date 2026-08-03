# Animation implementation notes — iOS / SwiftUI renderer

Handoff notes for implementing the shipped Hypen animation protocol
("Shipped v1", `ANIMATION_API_DESIGN.md` §3, lines 287–931 — normative) in
`hypen-renderer-swift`. Written against the code as of branch
`claude/hypen-animation-api-design-09ar7c`; every file:line anchor below was
verified against the actual sources. Four reference implementations exist:
DOM (`hypen-web/packages/web/src/dom/anim.ts` — CSS-native, the closest
analog to SwiftUI), Canvas (`packages/web/src/canvas/anim.ts`,
`CanvasAnimator` at :580 — tick-based fallback pattern), desktop
(`hypen-renderer-desktop/src/anim.rs`, `DesktopAnimator` at :709 — tick-based
in Rust, with the honest-degradation capability matrix in its module header,
:1–100), and scrub (`packages/web/src/dom/scrub.ts` — interaction contracts).
Read their module headers before writing code; they ARE the contracts.

## Where this renderer sits today

`HypenSwift` is a Remote-UI WebSocket client: JSON patches in
(`Sources/HypenSwift/Model/Patch.swift`, `Patch.from(dictionary:)` at :80),
applied to a `HypenElement` map by `HypenRenderer`
(`Sources/HypenSwift/Render/HypenRenderer.swift` — `applyPatches` :87,
`applyCreate` :130, `applySetProp` :172, `applyRemove` :316, `applyDetach`
:367, `applyAttach` :396). Each `HypenElement` is its own `ObservableObject`
(`Model/HypenElement.swift` :14–48): a `SetProp` invalidates exactly one
SwiftUI view (`HypenElementView.swift` — `HypenElementContentView` observes
its own element, :47–63). Styling flows through `HypenModifier`
(`Render/HypenModifier.swift`; opacity applied at :278, rotation/scale/offset
at :326–331).

**Status (stage 1 landed, #158).** `Sources/HypenSwift/Animation/` now
implements the daily-driver layer: `.transition`, `.enter`/`.exit` with the
deferred-remove contract, `.states` glides, `.animate` presets,
`batchAnimation`, `.motion(essential)`, reduced motion, and
`.onAnimationComplete`. `HypenAnimator` owns the state (poses, exiting
subtrees, settle timers, completion dispatch); `AnimationModifiers.swift`
owns the pixels. STILL SNAPPING, deliberately: `.layout` FLIP,
`.sharedElement`, and `.scrub`/`.settle` (stage 2). Recorded narrowings live
in the iOS capability matrix in `hypen-web/docs/animation.md`; the rest of
this document is the contract those implementations were written against
and stays as written.

Who feeds it matters:

- **TS hosts** (`@hypen-space/server` RemoteServer) emit the full-fidelity
  JSON wire: `Remove.transition`, the `batchAnimation` prelude, all
  `__anim.*` props. The `__anim.*` props already arrive today (they ride
  `Create.props` / `SetProp`); the flag and the prelude also arrive — but
  `Patch.from(dictionary:)` never reads `transition` and returns `nil` for
  the unknown `batchAnimation` type (:98–100), so both are dropped
  client-side.
- **Swift host** (`hypen-server-swift`) consumes the UniFFI `Patch` record,
  which drops the flag and the prelude server-side (see FFI gap below), so
  clients of a Swift-hosted app can never animate exits/transactions until
  that is fixed — including *browser* clients (the policy comment in
  `hypen-engine-rs/src/uniffi/mod.rs:366–375` calls this out explicitly).

## Protocol invariants (non-negotiable)

Identical section in `hypen-renderer-android/ANIMATION.md`. These are the
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
   playback starts.
6. **Snap, don't error.** Malformed specs, unknown presets, unexpressible
   channels: warn (at most once) and show the correct final state. Every
   degradation in the desktop capability matrix (`desktop/src/anim.rs`
   header) is silent and honest. A renderer must never render a wrong pose
   to preserve a pretty animation.

## FFI prerequisites (do this first)

The uniffi boundary (`hypen-engine-rs/src/uniffi/mod.rs`) drops two things,
each with an in-code policy comment marking the exact spot:

1. **`Remove.transition`** — dropped at `InternalPatch::Remove { id, .. }`
   (mod.rs:366–387). Fix: add `#[uniffi(default = false)] pub transition:
   bool` to the flat `Patch` record (:229–245) and carry it in
   `from_internal`. The default keeps existing Kotlin/Swift constructors
   compiling (same trick as `semantics_json`, :243).
2. **`BatchAnimation` prelude** — dropped at
   `InternalPatch::BatchAnimation { .. } => return None` (mod.rs:254–264).
   Fix: add `BatchAnimation` to `PatchType` (:204–225) and a
   `#[uniffi(default = None)] pub spec_json: Option<String>` field; map
   `spec` through `serde_json::to_string`.

Also note mod.rs:622–624 / :663–664: `update_state` / `update_state_sparse`
pass `None` as the animation context — host-side stamping over uniffi is a
separate, later piece (see the stamp-lifecycle pitfall below); the patch
relay fix alone restores fidelity for TS-style stamped batches flowing
through a Swift host's engine only if the host also gains the optional
animation argument. For v1 mobile, relaying what the engine emits is the
priority.

**Regeneration procedure** (header of mod.rs:6–17,
`hypen-server-swift/build-engine.sh`):

```bash
cd hypen-engine-rs
cargo build --release --features uniffi
cargo run --features uniffi --bin uniffi-bindgen generate \
    --library ../target/release/libhypen_engine.{so|dylib} \
    --language swift  --out-dir ../hypen-server-swift/Sources/HypenEngine
# and, in the same change:
cargo run --features uniffi --bin uniffi-bindgen generate \
    --library ../target/release/libhypen_engine.so \
    --language kotlin --out-dir ../hypen-kotlin/src/main/kotlin
```

**Coordination warning:** the record layout is shared. Changing the uniffi
`Patch` record regenerates BOTH binding sets — you cannot ship the Swift
side alone. The generated Kotlin record is
`hypen-kotlin/src/main/kotlin/uniffi/hypen_engine/hypen_engine.kt:2580`;
its `FfiConverterTypePatch.read` is positional, so a stale generated file
mis-reads every field after the new one. Land the Rust change, both
regenerated files, and the downstream plumbing in one commit, and rebuild
`hypen-server-swift/hypen_engineFFI.xcframework` via `build-engine.sh`.

**Downstream plumbing (the relay chain each new field must survive):**

- Swift host: `hypen-server-swift/Sources/HypenServer/NativeEngine.swift`
  `convertPatch` (:283–324) must emit `"transition": true` (omit when
  false — wire stays byte-identical, matching serde skip-if-false) and
  `patchTypeName` (:326) must map the new case to `"batchAnimation"` with
  the parsed `spec`.
- Kotlin host: `NativeEngine.kt:412` (uniffi→core mapper) and the wire
  `Patch` in `space/hypen/core/Types.kt:69` (add `val transition: Boolean?
  = null` and `val spec: JsonElement? = null`; kotlinx default-omission
  keeps the wire unchanged). The relay itself
  (`HypenServer.kt`, `Json.encodeToJsonElement`) then passes them for free.
- This renderer: `Model/Patch.swift` — add `transition: Bool` (read
  `dictionary["transition"] as? Bool ?? false`) and a `batchAnimation`
  case carrying `spec: [String: Any]` (today's `default: return nil` at
  :98–100 silently eats it).
- Go already relays (`hypen-golang/remote/types.go` `Patch.Spec`); no work.

**The missing `__hypenAnimate` strip.** TS renderers smuggle the `animate:`
event argument across `dispatchAction` under the reserved payload key
`__hypenAnimate` (spec:722–734). Go strips it
(`hypen-golang/remote/session.go:965`), Kotlin strips it
(`HypenServer.kt:20` `RESERVED_ANIMATE_KEY`, strip at :386–401 with the
policy comment). **hypen-server-swift does not**:
`RemoteSession.handleDispatchAction` (Remote/RemoteSession.swift:795) passes
the payload straight to `ModuleInstance.dispatchAction`, so a Swift-hosted
module handler can observe the reserved key. Port the Kotlin strip verbatim
(remove the key from dictionary payloads before dispatch; it is a
renderer→host directive, never handler data). Regression test model:
`hypen-golang/remote/animate_strip_test.go`.

## Channel-by-channel mapping

Vocabulary source of truth: `hypen-engine-rs/src/ir/anim.rs` (`CURVES` :19,
`PRESETS` :22, `ANIMATE_PRESETS` :26, `DIRECTIONS` :29, `ANIMATABLE_PROPS`
:36–64 — 27 entries, `SCRUB_SOURCES`/`SCRUB_AXES` :1068–1071) mirrored by
`@hypen-space/core/animation` (`CURVE_TO_CSS` :134, `CURVE_BEZIER_POINTS`
:162, `ANIMATABLE_PROPS` :286, `ANIMATE_PRESETS` :433). Route on one
`hasPrefix("__anim.")` check. Wire shapes: spec:329–338.

| Channel | Wire prop | SwiftUI mapping | Priority |
|---|---|---|---|
| `.transition` | `__anim.transition` | scoped implicit `.animation(_:value:)` on the element view | P0 |
| `.enter`/`.exit` | `__anim.enter` / `__anim.exit` + flagged `Remove` | `.transition(AnyTransition)` + `withAnimation` around the children mutation; renderer-owned deferred teardown | P0 |
| `.states` | ordinary `SetProp`s + `__anim.states` label | free once `.transition` works | P0 (free) |
| `batchAnimation` | first-patch prelude | explicit `withAnimation` around the batch's prop mutations | P1 |
| `.layout` | `__anim.layout` on `Move` | `withAnimation` around the children reorder | P1 |
| `.animate` | `__anim.animate` | per-preset repeating animations (pulse/spin/shake; shimmer = gradient overlay) | P1 |
| `.motion(essential)` | `__anim.motion` `{essential:true}` | per-node exemption from the reduce-motion gate | P1 |
| `.sharedElement` | `__anim.sharedKey` + `__anim.shared` | `matchedGeometryEffect` across the Detach/Attach seam | P2 |
| `.scrub`/`.settle` | `__anim.scrub*` (four props) | `DragGesture` + display-link settle, full interaction contract | P2 |

### Curves — pin the bezier

`linear|easeIn|easeOut|easeInOut` map to the CSS beziers in
`CURVE_BEZIER_POINTS` (core/animation.ts:162) — SwiftUI's
`.easeIn`/`.easeOut`/`.easeInOut` use the same conventional control points,
so the named SwiftUI curves are acceptable. **`spring` is not SwiftUI's
spring.** The wire contract is a fixed overshoot bezier,
`cubic-bezier(0.34, 1.56, 0.64, 1)` (spec:319–321, `CURVE_TO_CSS` :139).
SwiftUI's `.spring()` is physics-based and feels different; pin it:

```swift
static func hypenCurve(_ token: String, duration: Double) -> Animation {
    switch token {
    case "spring": return .timingCurve(0.34, 1.56, 0.64, 1, duration: duration)
    case "linear": return .linear(duration: duration)
    case "easeIn": return .easeIn(duration: duration)
    case "easeInOut": return .easeInOut(duration: duration)
    default: return .easeOut(duration: duration)   // easeOut is the family default
    }
}
```

The canvas/desktop tickers reuse the shared numeric bezier evaluation
(`curveFunction`, core/animation.ts:269) precisely so all renderers trace
the same curve — SwiftUI's `timingCurve` is that same evaluation.

### `.transition` — scoped implicit animation

Because every element view observes exactly its own `HypenElement` and
re-renders on any prop change, the natural SwiftUI altitude is a per-element
implicit animation: in `HypenElementContentView`, when the element carries a
parsed `__anim.transition` spec, attach `.animation(anim, value: key)`
where `key` is an `Equatable` snapshot of the element's whitelisted (and,
when the spec carries `props:[...]`, scoped) prop values. That gives CSS
transition semantics for free: retargets mid-flight continue from the
current presentation value (spec §4 "Interruption is not optional", :1220).
Do NOT use `withAnimation` in `applySetProp` for this channel — a batch
mixes nodes with different specs and unspecced nodes, and transaction
precedence (below) needs per-node exclusion.

Notes:
- Only whitelisted props glide (`ANIMATABLE_PROPS`, ir/anim.rs:36); others
  snap even mid-spec. Non-scoped specs cover the whole whitelist.
- The deprecated legacy string form arrives as `transition.0`
  (ir/anim.rs:98) — web-only CSS passthrough; ignore it on iOS.
- `delay` is part of the spec shape; `.animation(anim.delay(delay))`.

### `.enter` / `.exit` — structural transitions + the deferred-remove contract

Presets (spec:319–327): `fade` → `.opacity`; `slide` → offset **24px**
toward/from `from:`/`to:` (`leading`/`trailing` resolve against
`layoutDirection` — use an alignment-aware offset, or
`.move(edge:)`+`.offset`; the web uses a fixed 24px nudge, not a full-width
move, so a custom `AnyTransition.modifier` with a 24pt offset is the
faithful shape); `scale` → `.scale(scale: 0.95)`. Presets compose
(`.combined(with:)`). Defaults: enter `{200ms, easeOut, [fade]}`, exit
`{150ms, easeIn, [fade]}`.

**Enter rules** (dom/anim.ts:11–14, playEnter :1365; canvas and desktop
match): play ONLY for nodes created in the same patch batch; suppress the
first-ever batch (initial render must not cascade); a cached Router
`Attach` NEVER enter-animates. Implementation: track ids `applyCreate`d in
the current `applyPatches` call; attach an asymmetric
`.transition(.asymmetric(insertion: enterTransition, removal:
exitTransition))` and perform the children-array insertion inside
`withAnimation(enterTiming)` only for that set. `applyAttach` never
qualifies. A shared-element match suppresses the node's own enter (see H).

**Exit — the deferred-remove protocol** (spec:340–356, patch.rs:184–208).
The renderer receives, FIRST, `{"type":"remove","id":X,"transition":true}`
for the subtree root, THEN its descendants as plain Removes
(parent-remove-wins; descendants are plain even if they carry their own
exit specs). Non-animated subtrees keep the old post-order — byte-identical
wire. Required behavior in `applyRemove`:

1. Flag set → do not delete. Mark the id exiting; keep the element in
   `elements` and in its parent's `children`.
2. **Immediately** exclude the subtree from interaction — this is the DOM's
   `data-hypen-exiting` + `inert` move (dom/anim.ts:16, :1005–1006) and it
   covers four planes at once; SwiftUI needs all four explicitly:
   `.allowsHitTesting(false)` (touches), drop any `dispatchAction` whose
   source element id is in an exiting subtree (the DOM does this at the
   single dispatch chokepoint, `dom/applicators/events.ts:278–280` — the
   engine-side ids are already dead, dispatching fires ghosts),
   `.accessibilityHidden(true)` (VoiceOver — `allowsHitTesting` does NOT
   hide a11y nodes), and kill focusability (`.focusable(false)` /
   `.focused` reset; a focused `TextField` inside an exiting subtree must
   resign — the keyboard case is exactly the class of hole the web review
   found).
3. Play the exit: remove the id from its parent's `children` inside
   `withAnimation(exitTiming)`; SwiftUI plays the removal transition on the
   departing view.
4. Finalize on a timer: `duration + delay + 80ms` (the backbone every
   implementation uses — dom/anim.ts:158, canvas, desktop
   `finalize_overdue` :1639). Finalization purges the root AND all deferred
   descendants from `elements`. There is no completion handshake to wait
   for — SwiftUI gives no reliable "removal transition finished" callback,
   and the timeout backbone is the contract anyway.
5. Plain Removes arriving for ids **inside** an exiting subtree defer to
   the root's finalize (dom/anim.ts `deferToExitingAncestor` :1059–1077).
   Do not tear children out from under a playing exit. See fixture
   `exit-nested-descendant-removes.json` for the subtree-replacement shape.
6. A flagged remove for an already-exiting id: restart/keep the newest
   finalize, never double-finalize (dom/anim.ts:984–990).

Known v1 limit to inherit knowingly: an exiting node still occupies layout
until finalize (spec:422–425); with the SwiftUI removal-transition
approach the slot collapses at step 3 instead — closer to the roadmap
sibling-shift behavior and acceptable (renderer-owned choreography).

Fixtures: `exit-deferred-remove.json` (root-first, flag, no descendant
Removes), `foreach-exit-remove.json` (every removed keyed item roots its own
flagged Remove), `enter-exit-lowering.json` (wire shapes).

### `.states` — free, if `.transition` works

Pose flips arrive as ordinary `SetProp`/`RemoveProp` (StateSwitch never
reaches the wire — spec:507–520); the engine synthesizes
`__anim.transition` scoped to the overridden animatable keys (spec:522–536)
unless an explicit one exists (`states-explicit-transition-wins.json`).
So a snapping renderer is already pose-correct, and an animating renderer
glides poses through the `.transition` mapping with zero extra work.
`__anim.states` (`{"label": ...}`, null = base pose) exists for completion
timing and scrub anchoring only — ignore it until you implement those.
Fixtures: `states-lowering.json`, `states-switch.json`,
`states-fallback.json`.

### `batchAnimation` — the transaction prelude

After the FFI fix, honor `{"type":"batchAnimation","spec":{...}}` at batch
index 0 ONLY (invariant 3). SwiftUI happens to have the exact primitive the
option was modeled on (spec §D cites `withAnimation` by name): wrap the
batch's `SetProp` applications in `withAnimation(specTiming)`. Precedence
chain (normative, spec:754–774): **structural playbacks (enter/exit/FLIP/
shared) > transaction > node `.transition` > snap.** Concretely: nodes with
an in-flight enter/exit are excluded from the transaction (apply their
props without animation); nodes created in the same batch are excluded
(their queued enter owns the first motion — the canvas rule, spec:770);
exiting nodes snap; the transaction overrides a node's own `.transition`
for the props the batch writes. An implicit per-node
`.animation(_:value:)` outranks an ambient `withAnimation` transaction in
SwiftUI, which INVERTS the required precedence for `.transition` nodes —
suspend the per-node implicit animation (set the animation to the
transaction's timing, or key the value snapshot so it doesn't change) for
nodes the stamped batch touches. Reduced motion ignores stamps except for
`.motion(essential)` nodes. Fixture: `batch-animation-stamp.json`; schema:
`engine-compatibility-tests/schema/patch.schema.json`.

### `.layout` — FLIP on moves

DOM plays FLIP on `Move` patches only (zero-delta skips; exit wins —
dom/anim.ts:20–31, :794, :833). SwiftUI equivalent: perform the
`applyMove` children mutation inside `withAnimation(layoutTiming)`; identity
(`HypenElementView` keyed by element id) makes SwiftUI animate the
reposition. Canvas and desktop deliberately snap `.layout` (spec:451–454)
— snapping is sanctioned if this fights the layout system; do not ship a
paint-only transform FLIP (invariant 5).

### `.animate` presets

Closed vocabulary `pulse|spin|shimmer|shake` (ir/anim.rs:26); keyframe
*shapes* are renderer-owned, only names + timing defaults are normative
(spec:402–414; defaults at `ANIMATE_PRESETS`, core/animation.ts:433: pulse
`{1200, loop, easeInOut}`, spin `{800, loop, linear}`, shimmer
`{1500, loop, linear}`, shake `{400, 1, easeInOut}`). DOM shapes to match:
pulse = opacity 1→0.5→1; spin = 360° rotation; shake = ±translateX
oscillation; shimmer = moving gradient overlay (SwiftUI: an overlay
`LinearGradient` masked and offset-animated; feasible, P2). Use repeating
animations on view-local state (`.repeatForever`/`repeatCount`) or iOS 17
`keyframeAnimator`. Contracts that carry over regardless of mechanism
(spec:404–414): a changed spec restarts playback; a removed channel stops
it; exiting nodes keep playing; a cached `Attach` resumes loops but never
replays finite repeats; a preset touching opacity/transform is suspended
while an enter/exit/FLIP plays on the same node, then resumed (the DOM
suspend machinery, dom/anim.ts:53–62). Fixtures: `animate-lowering.json`,
`animate-repeat-forms.json`, `animate-unknown-preset.json` (unknown preset
⇒ no channel at all).

### Reduced motion and `.motion(essential)`

Gate on `@Environment(\.accessibilityReduceMotion)` (or
`UIAccessibility.isReduceMotionEnabled` + its notification for live
toggles — the web listens live, dom/anim.ts:462). Reduced motion: snap
everything, finalize exits immediately (next runloop tick, mirroring the
DOM's microtask — dom/anim.ts:1017–1027), skip enters/FLIPs, no completions.
`__anim.motion` `{essential:true}` (ir/anim.rs:66–72, fixture
`motion-essential-lowering.json`, #149) exempts that node from ALL
reduced-motion shortcuts — essential nodes enter, exit, glide, and pulse as
if the preference were off (dom/anim.ts:67–73). Two global exceptions keep
their skip even for essential nodes on the web: shared-element FLIPs
(inherently decorative) — mirror that. Scrub DRAGGING is exempt from
reduced motion by spec (direct manipulation is the user's hand); only the
release settle snaps (spec:899–902).

### `.sharedElement` — matchedGeometryEffect across the Router seam

Wire: `__anim.sharedKey` (resolved string; the ONE animation arg where
bindings are legal — re-resolves as SetProp) + `__anim.shared`
(`{duration, curve}`, defaults `{350, spring}`) (spec:567–587,
`shared-element-lowering.json`). SwiftUI's `matchedGeometryEffect(id:in:)`
is the native five-step protocol — but hold it to the v1 contract
(spec:589–652):

- Navigation shape = a batch containing BOTH a `Detach` and an
  `Attach`/`Insert`. Sources are keyed nodes **at-or-under the batch's
  detach roots only** (v1 narrowing: a persistent app-shell node sharing a
  key is never a source). With mGE: give the outgoing (detaching) view
  `isSource: true` only when it is inside a detach root.
- The **incoming** node's `__anim.shared` spec times the flight; wrap the
  attach mutation in `withAnimation(sharedTiming)`.
- A match suppresses the incoming node's own `.enter` for the batch — one
  motion, not two. Exiting nodes never participate as targets. A snapshot
  matching its own node (cached subtree persisting) is no match.
- Unmatched/unmeasurable keys degrade to a plain navigation, silently;
  dev-warn once per key for source-only/target-only keys.
- v1 is transform-only continuity. mGE interpolates the full frame and
  (with matched modifiers) more — that is a *richer* motion than the web's;
  acceptable, but do not add content crossfade/corner interpolation
  deliberately; they are recorded roadmap, not v1.
- Zero-delta match = instant natural settle: enter stays suppressed (and,
  if you implement completions, `{ "animation": "sharedElement" }`
  dispatches immediately — spec:628–634). Under reduced motion: no
  snapshot, no suppression, nothing.
- Interruption: a mid-flight second navigation must retarget from the
  current presentation position — mGE does this natively.

### `.scrub` / `.settle` — the full interaction contract

Wire: four static props (`__anim.scrub`, `__anim.scrubSettle`,
`__anim.scrubBind`, `__anim.scrubPoses` — spec:820–843,
`scrub-lowering.json`). `__anim.scrubPoses` materializes both endpoint
values per prop key so the renderer interpolates without knowing the pose
machinery. The normative interaction contract lives in the `scrub.ts`
module header (:1–94) with pinned numbers (:126–136); implement it exactly:

- **Claim:** touch-down opens a PENDING drag; claim only after ~6px axis
  travel (`SCRUB_SLOP_PX`, scrub.ts:128) — a tap is a TOTAL no-op (no
  settle, no bind write, child taps unaffected). Recorded deviation:
  grabbing a mid-settle element claims immediately. `DragGesture`'s
  `minimumDistance` approximates the slop but fires SwiftUI's recognizer
  arbitration; a `UIPanGestureRecognizer` bridge gives the contract's
  semantics more faithfully (axis-locked slop, explicit cancellation).
  Only the claiming touch drives the drag; a second finger is noise.
- **Anchoring (the root defect of the adversarial review — CHANGELOG
  Unreleased→Fixed, scrub entry):** mapping is RELATIVE:
  `p = pAtGrab + travel / (over[1] − over[0])`, rubber-banded on the
  result beyond [0,1] (`p' = bound + (p − bound) · rubberBand`; shared
  normative impl `scrubProgress`, core/animation.ts:833). Seed the anchor
  from the `__anim.states` label (`from`→0, `to`→1) at create and on every
  label SetProp that lands while no interaction owns the node. A
  settled-open sheet re-drags from 1 — anchoring at 0 snapped open sheets
  closed, the bug both reviewers found independently.
- **Release:** velocity from the last ~5 samples, discarding samples older
  than ~100ms (`VELOCITY_WINDOW_MS`, scrub.ts:132; empty window ⇒ v=0 — a
  drag-hold-release projects nothing); project `p* = p + v·150ms`
  (`SCRUB_PROJECTION_MS` :126); `p* >= 0.5` → `to` (tie pinned by test).
  Settle via your own frame loop (`CADisplayLink` / `TimelineView`), NOT a
  SwiftUI animation: arrival must be an exact observable event (the bind
  write fires ON arrival), and a mid-settle grab needs the loop's current
  progress (scrub.ts:36–51 gives the four reasons).
- **Bind write + cleanup handshake:** on arrival dispatch
  `__hypen_bind {path, value: label}` — the exact channel `.bind` uses.
  KEEP the final interpolated values until the FIRST `__anim.states` label
  SetProp arrives — **any label, matching or not** (a raced different label
  must not hold stale visuals) — with a ~500ms timeout fallback
  (scrub.ts:53–59, :134).
- **Scroll source:** listener on the `of:`-named container (resolved `id`
  prop; unmatched name warns once and falls back to nearest scrollable),
  offset maps ABSOLUTELY through `over`. No release exists: the bind write
  fires when progress crosses and RESTS at an endpoint (~150ms debounce).
  Deferral is quiescence-bounded: after ~150ms of mid-range rest, deferred
  engine writes flush (concede) and ownership releases until the next
  scroll event (a collapsing header must not dead-lock sibling updates).
- **Gesture wins:** engine SetProps to scrubbed keys defer (latest value,
  applied at cleanup) while an interaction owns the node. Precedence:
  **scrub > structural > transaction > node `.transition`**. Remove/detach
  mid-drag cancels everything and releases the touch; scrub sources detach
  BEFORE any exit playback; a cancelled settle never writes state;
  cached-route re-attach re-arms scroll sources.
- Reduced motion: drag unchanged; release settles instantly, then writes.
  Zero engine traffic during any drag or scroll tracking.

## Pitfalls (distilled from the hardening history)

Every one of these was a confirmed adversarial-review finding on the web
implementations (CHANGELOG.md Unreleased → Fixed, three entries; commit
trail `46467f5b`, `7c2d85eb`, `c657a4bd`). Mobile will hit the same ones.

- **Settle-takeover:** every path that supersedes a playback must clear ALL
  of the predecessor's bookkeeping, not just its animation. The web bug:
  a shared flight's pinned `transform-origin` survived an enter/exit/FLIP
  takeover and skewed the next motion. Audit each "start X" path for what
  it leaves behind on Y.
- **Key aliasing (shared elements):** duplicate source keys keep the first;
  a node matching its own snapshot is no match; still-visible nodes are
  never sources. Reset per-batch shared state at the START of the next
  pre-pass too, so a batch that throws mid-apply can't leak snapshots.
- **Exit exclusion is four planes, not one:** touches, event dispatch,
  focus/keyboard, accessibility. The web needed `inert` + a dispatch-level
  guard (events.ts:280); `allowsHitTesting(false)` alone leaves VoiceOver
  and a focused text field live inside a corpse.
- **Stamp lifecycle races (when Swift-host stamping lands):** per-dispatch
  token identity (two dispatches stamping the same `"spring"` string must
  not clear each other), entry drain of pre-queued flushes, first-flush
  consumption, post-sync-portion clear, completion backstop — the 5-step
  lifecycle at spec:717–753. Engine side is already correct
  (`engine_core.rs:52` `pending_animation`, consumed at :409; no stamp
  without patches).
- **Interaction lifecycle:** taps must be total no-ops; dead interactions
  never write state (cancel-before-exit ordering); ownership must always
  release (bounded deferral); ANY label completes the cleanup handshake.
- **First-batch suppression + no-replay-on-attach:** initial render must
  not cascade enters; cached routes must not replay enters or finite
  presets. Both are easy to forget on the Attach path.
- **Precedence inversions:** check which SwiftUI mechanism wins in *its*
  cascade vs. which must win in ours (implicit `.animation` vs
  `withAnimation` is the iOS instance of the web's "running CSS animation
  beats inline styles" trap, dom/anim.ts:53–62).

## Conformance graduation checklist

Engine-side lowering is already pinned by the 20 fixtures in
`engine-compatibility-tests/fixtures/animation/` (run by the Rust and TS
runners; `golang` carries a recorded skip). For iOS:

1. Land the uniffi fields + both regenerated bindings + relay plumbing
   (above); delete the two "deferred with the rest of the non-web animation
   work" policy comments in uniffi/mod.rs.
2. Add the `__hypenAnimate` strip to `RemoteSession.handleDispatchAction`
   with a test mirroring `animate_strip_test.go`.
3. Extend `Model/Patch.swift` parsing (+ tests modeled on the wire shapes
   in `exit-deferred-remove.json` and `batch-animation-stamp.json` — the
   flag must parse, an unknown-type prelude must not be silently dropped).
4. Implement P0 (transition, enter/exit + deferred remove, states glide),
   then P1, then P2, each with `swift test` coverage of the contracts
   (root-first ordering, defer-to-exiting-ancestor, timeout finalize,
   first-batch suppression, attach no-replay, reduced-motion snap).
5. Visual verification via the gallery flow (`run_on_sim.sh` /
   `sim_screen.sh`) against the DOM renderer playing the same app — the
   spec's "feel check" (spec:654–660) is the bar: spring overshoot ≈9.5%,
   `{350, spring}` shared flights, no double motion on matched enters.
6. Update the host matrix rows for uniffi/iOS in `ANIMATION_API_DESIGN.md`
   §3 and `hypen-web/docs/animation.md` when each channel ships (both
   currently record iOS as snap-everything, which is load-bearing
   documentation — keep it truthful).
