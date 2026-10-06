package space.hypen.renderer.anim

import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.Easing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animate
import androidx.compose.animation.core.tween
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import space.hypen.renderer.HypenLoggers
import space.hypen.renderer.model.HypenElement
import kotlin.math.sin

private val log = HypenLoggers.renderer.child("Anim")

/**
 * The Compose face of the animation protocol.
 *
 * Everything that decides WHETHER something animates lives in
 * [AnimationCoordinator]; this file only plays what it decided:
 *
 * - `.transition` (and therefore `.states`, whose pose flips arrive as
 *   ordinary SetProps with a synthesized scoped transition) is played by
 *   writing interpolated values back onto the element as animation
 *   overrides, so every whitelisted prop glides through its existing
 *   applicator/component with no per-prop special-casing.
 * - `.enter` / `.exit` / `.animate` are played as a single `graphicsLayer`
 *   pose (alpha + translation + scale + rotation). Routing every structural
 *   writer through ONE owner is what keeps a looping preset from fighting an
 *   exit playback (the precedence inversion the DOM hit with CSS animations
 *   outranking inline styles).
 * - An exiting subtree is excluded from interaction on all four planes
 *   before its playback starts.
 *
 * Deviation from the handoff notes, recorded deliberately: enter/exit are
 * NOT played with `AnimatedVisibility`. That composable inserts its own
 * layout node, which would break the Row/Column scope chain the renderer
 * relies on for `.weight()`, and it shrinks the exiting slot — whereas the
 * shipped web/canvas contract is that an exiting node keeps occupying layout
 * until finalize (hypen-web/docs/animation.md's recorded v1 limit). A
 * `graphicsLayer` pose keeps layout identical, keeps hit targets glued to
 * the pixels (protocol invariant 5, which Compose pays for us as long as
 * motion stays in modifiers), and gives an exact settle signal.
 */

/** Curve token → Compose easing, built from the PINNED bezier control points. */
fun AnimCurve.toEasing(): Easing =
    when (this) {
        AnimCurve.LINEAR -> LinearEasing
        // `spring` included: the wire contract is the fixed overshoot bezier
        // cubic-bezier(0.34, 1.56, 0.64, 1), NOT Compose's physics spring().
        else -> CubicBezierEasing(x1, y1, x2, y2)
    }

/** The single graphics pose every structural playback writes through. */
@Stable
internal class PlaybackPose {
    var alpha by mutableFloatStateOf(1f)
    var translationX by mutableFloatStateOf(0f)
    var translationY by mutableFloatStateOf(0f)
    var scale by mutableFloatStateOf(1f)
    var rotation by mutableFloatStateOf(0f)

    /** Shimmer sweep progress in `[0,1]`, or negative when inactive. */
    var shimmer by mutableFloatStateOf(-1f)

    /** True while an enter/exit owns the pose — a preset must not fight it. */
    var structural by mutableStateOf(false)

    fun identity() {
        alpha = 1f
        translationX = 0f
        translationY = 0f
        scale = 1f
        rotation = 0f
    }

    val isIdentity: Boolean
        get() = alpha == 1f && translationX == 0f && translationY == 0f &&
            scale == 1f && rotation == 0f && shimmer < 0f
}

/** A preset/enter/exit end pose, expressed as offsets from identity. */
private data class HiddenPose(
    val alpha: Float = 1f,
    val translationX: Float = 0f,
    val translationY: Float = 0f,
    val scale: Float = 1f,
)

private fun hiddenPose(
    presets: List<AnimPreset>,
    direction: AnimDirection?,
    rtl: Boolean,
    slidePx: Float,
): HiddenPose {
    var pose = HiddenPose()
    for (preset in presets) {
        pose =
            when (preset) {
                AnimPreset.FADE -> pose.copy(alpha = 0f)
                AnimPreset.SCALE -> pose.copy(scale = PRESET_SCALE_FROM)
                // An absent direction defaults to `leading` (core parity).
                AnimPreset.SLIDE ->
                    when (direction ?: AnimDirection.LEADING) {
                        AnimDirection.TOP -> pose.copy(translationY = -slidePx)
                        AnimDirection.BOTTOM -> pose.copy(translationY = slidePx)
                        AnimDirection.LEADING -> pose.copy(translationX = if (rtl) slidePx else -slidePx)
                        AnimDirection.TRAILING -> pose.copy(translationX = if (rtl) -slidePx else slidePx)
                    }
            }
    }
    return pose
}

/** `t = 0` → hidden, `t = 1` → the node's real pose. */
private fun PlaybackPose.applyProgress(hidden: HiddenPose, t: Float) {
    alpha = hidden.alpha + (1f - hidden.alpha) * t
    translationX = hidden.translationX * (1f - t)
    translationY = hidden.translationY * (1f - t)
    scale = hidden.scale + (1f - hidden.scale) * t
}

/** What the element renderer needs back from the animation layer. */
@Stable
class HypenAnimation internal constructor(
    /** Playback pose + exit-exclusion modifiers, applied outside the base chain. */
    val modifier: Modifier,
    /** True while this element is the root of a deferred (exiting) subtree. */
    val exiting: Boolean,
) {
    companion object {
        val None = HypenAnimation(Modifier, false)
    }
}

/**
 * Drive every animation channel for one element and return the modifier that
 * presents them. Safe to call for elements with no animation props: it
 * short-circuits to [HypenAnimation.None].
 */
@Composable
fun rememberHypenAnimation(
    element: HypenElement,
    coordinator: AnimationCoordinator?,
): HypenAnimation {
    if (coordinator == null) return HypenAnimation.None

    val id = element.id
    val revision = element.propsRevision
    val specs = remember(id, revision) { coordinator.specsFor(id) }
    val exitSpec = coordinator.exitPlaybackFor(id)
    val exiting = coordinator.hasExitPlayback(id)

    // Runs for EVERY element, including ones with no animation props of
    // their own: a `batchAnimation` transaction glides whitelisted writes on
    // any node in the batch. The driver is inert (one suspended collector)
    // until the coordinator actually queues a glide.
    DrivePropTransitions(element, coordinator)

    if (specs == null && !exiting) {
        return HypenAnimation.None
    }

    val density = LocalDensity.current
    val slidePx = remember(density) { with(density) { SLIDE_OFFSET_DP.dp.toPx() } }
    val rtl = LocalLayoutDirection.current == LayoutDirection.Rtl

    // `.enter` — claimed at the FIRST composition so the hidden pose is the
    // element's initial state and its first frame never flashes at full
    // opacity. One-shot by construction: a re-entry into composition (or a
    // cached Router attach, which is excluded upstream) finds nothing.
    val enterSpec = remember(id) { coordinator.consumePendingEnter(id) }

    // The hidden pose is baked into the remembered object rather than
    // written during composition.
    val pose =
        remember(id, enterSpec) {
            PlaybackPose().apply {
                if (enterSpec != null) {
                    applyProgress(hiddenPose(enterSpec.presets, enterSpec.from, rtl, slidePx), 0f)
                    structural = true
                }
            }
        }

    DriveEnter(id, enterSpec, coordinator, pose, rtl, slidePx)
    DriveExit(id, exitSpec, coordinator, pose, rtl, slidePx)
    DriveAnimatePreset(id, specs?.animate, coordinator, pose, slidePx)

    // The layer is gated on the node's CHANNELS, never on live pose values:
    // `graphicsLayer {}`'s lambda form reads the pose at layer-update time,
    // so a playback costs no recomposition — reading `pose.alpha` here to
    // decide would reintroduce one per frame.
    var modifier: Modifier = Modifier
    if (specs?.enter != null || specs?.exit != null || specs?.animate != null ||
        exiting || enterSpec != null
    ) {
        modifier =
            modifier.graphicsLayer {
                alpha = pose.alpha
                translationX = pose.translationX
                translationY = pose.translationY
                scaleX = pose.scale
                scaleY = pose.scale
                rotationZ = pose.rotation
            }
    }
    if (specs?.animate?.preset == AnimatePreset.SHIMMER) {
        modifier = modifier.shimmerOverlay(pose)
    }
    if (exiting) {
        modifier = modifier.exitExclusion()
    }
    return HypenAnimation(modifier, exiting)
}

/**
 * `.transition` — animated prop resolution.
 *
 * The coordinator has already decided, per prop write, whether it glides and
 * with which spec (transaction stamp vs node `.transition`, minus every
 * exclusion); this driver just plays the queue. Targets are read from
 * [HypenElement.rawProps] — reading through `props` would return the glide's
 * own in-flight presented value.
 */
@Composable
private fun DrivePropTransitions(
    element: HypenElement,
    coordinator: AnimationCoordinator,
) {
    LaunchedEffect(element, coordinator) {
        val jobs = mutableMapOf<String, Job>()
        var lastRaw: Map<String, Any?> = element.rawProps
        snapshotFlow { element.propsRevision }.collect {
            val raw = element.rawProps
            val glides = coordinator.consumePendingTransitions(element.id)

            // A snapped write to a prop a glide currently owns cancels that
            // glide and hands the prop straight back to the engine value
            // (Option D's snap-on-refresh guarantee, generalized).
            for ((key, job) in jobs.toList()) {
                if (key in glides) continue
                if (raw[key] != lastRaw[key]) {
                    jobs.remove(key)
                    job.cancel()
                    element.clearAnimatedOverride(key)
                }
            }

            for ((key, glide) in glides) {
                val base = AnimParse.animatableBase(key) ?: continue
                // Retarget from the CURRENT presented value when a glide is
                // already in flight (interruption continues from where the
                // eye is), otherwise from the value captured at patch time.
                val from = if (element.hasAnimatedOverride(key)) element.props[key] else glide.from
                val interpolate = AnimValues.interpolator(base, from, raw[key])
                jobs.remove(key)?.cancel()
                if (interpolate == null) {
                    // Unparseable or identical endpoints: show the final
                    // state, never a wrong pose (protocol invariant 6).
                    element.clearAnimatedOverride(key)
                    continue
                }
                val spec = glide.spec
                jobs[key] =
                    launch {
                        val self = coroutineContext[Job]
                        try {
                            animate(
                                initialValue = 0f,
                                targetValue = 1f,
                                animationSpec =
                                    tween(
                                        durationMillis = spec.duration,
                                        delayMillis = spec.delay,
                                        easing = spec.curve.toEasing(),
                                    ),
                            ) { t, _ -> element.setAnimatedOverride(key, interpolate(t)) }
                        } finally {
                            // Only the CURRENT owner of the key cleans up: a
                            // superseded glide's late cancellation must not
                            // clear the override its successor is writing.
                            if (jobs[key] === self) {
                                jobs.remove(key)
                                element.clearAnimatedOverride(key)
                            }
                        }
                    }
            }
            lastRaw = raw
        }
    }
}

/** `.enter` — hidden pose → real pose; completion on natural settle only. */
@Composable
private fun DriveEnter(
    id: String,
    spec: EnterSpec?,
    coordinator: AnimationCoordinator,
    pose: PlaybackPose,
    rtl: Boolean,
    slidePx: Float,
) {
    LaunchedEffect(id, spec) {
        if (spec == null) return@LaunchedEffect
        val hidden = hiddenPose(spec.presets, spec.from, rtl, slidePx)
        // The enter owns the node's pose: prop writes landing mid-enter snap
        // rather than fighting it (structural playbacks outrank transitions).
        coordinator.setPlaybackActive(id, true)
        var settled = false
        try {
            animate(
                initialValue = 0f,
                targetValue = 1f,
                animationSpec =
                    tween(
                        durationMillis = spec.duration,
                        delayMillis = spec.delay,
                        easing = spec.curve.toEasing(),
                    ),
            ) { t, _ -> pose.applyProgress(hidden, t) }
            settled = true
        } finally {
            pose.identity()
            pose.structural = false
            coordinator.setPlaybackActive(id, false)
            // Interrupted/superseded enters fire NOTHING (invariant 4).
            if (settled) coordinator.notifyEnterSettled(id)
        }
    }
}

/**
 * `.exit` — the renderer-owned corpse.
 *
 * The coordinator already excluded the subtree and armed the
 * `duration + delay + 80ms` finalize backbone; this plays the inverse
 * presets and reports the natural settle, which finalizes early. If this
 * composable never runs (backgrounded, never composed), the backbone still
 * tears the node down.
 */
@Composable
private fun DriveExit(
    id: String,
    spec: ExitSpec?,
    coordinator: AnimationCoordinator,
    pose: PlaybackPose,
    rtl: Boolean,
    slidePx: Float,
) {
    LaunchedEffect(id, spec) {
        if (spec == null) return@LaunchedEffect
        val hidden = hiddenPose(spec.presets, spec.to, rtl, slidePx)
        pose.structural = true
        coordinator.setPlaybackActive(id, true)
        if (spec.delay > 0) delay(spec.delay.toLong())
        animate(
            initialValue = 1f,
            targetValue = 0f,
            animationSpec = tween(durationMillis = spec.duration, easing = spec.curve.toEasing()),
        ) { t, _ -> pose.applyProgress(hidden, t) }
        coordinator.notifyExitSettled(id)
    }
}

/**
 * `.animate` presets. Keyframe shapes match the DOM stylesheet: pulse =
 * opacity 1→0.5→1, spin = 360° rotation, shake = damped ±translateX
 * oscillation, shimmer = a sweeping gradient band. Names and timing defaults
 * are normative; the shapes are renderer-owned.
 *
 * A preset never fights a structural playback: while `pose.structural` is
 * set the preset yields, and it resumes when the playback releases (exits
 * never release — the corpse is being torn down).
 */
@Composable
private fun DriveAnimatePreset(
    id: String,
    spec: AnimateSpec?,
    coordinator: AnimationCoordinator,
    pose: PlaybackPose,
    slidePx: Float,
) {
    // A cached Router re-attach resumes looping presets but must never
    // replay a FINITE repeat (parity with "a cached attach never enters").
    val resumed = remember(id) { coordinator.consumeResumedFromCache(id) }
    LaunchedEffect(id, spec, resumed) {
        if (spec == null) return@LaunchedEffect
        if (!coordinator.motionAllowed(id)) return@LaunchedEffect
        if (resumed && !spec.loops) return@LaunchedEffect
        if (spec.delay > 0) delay(spec.delay.toLong())
        val easing = spec.curve.toEasing()
        var iteration = 0
        try {
            while (spec.loops || iteration < (spec.repeat ?: 1)) {
                animate(
                    initialValue = 0f,
                    targetValue = 1f,
                    animationSpec = tween(durationMillis = spec.duration, easing = easing),
                ) { t, _ ->
                    if (pose.structural) return@animate
                    when (spec.preset) {
                        AnimatePreset.PULSE -> pose.alpha = 1f - 0.5f * (1f - kotlin.math.cos(2f * Math.PI.toFloat() * t)) / 2f
                        AnimatePreset.SPIN -> pose.rotation = 360f * t
                        AnimatePreset.SHAKE -> pose.translationX = shakeOffset(t, slidePx)
                        AnimatePreset.SHIMMER -> pose.shimmer = t
                    }
                }
                iteration++
            }
            // Looping presets never complete (invariant 4); a finite one
            // that ran to the end settled naturally.
            if (!spec.loops) coordinator.notifyPresetCompleted(id, spec.preset)
        } finally {
            if (!pose.structural) {
                when (spec.preset) {
                    AnimatePreset.PULSE -> pose.alpha = 1f
                    AnimatePreset.SPIN -> pose.rotation = 0f
                    AnimatePreset.SHAKE -> pose.translationX = 0f
                    AnimatePreset.SHIMMER -> pose.shimmer = -1f
                }
            }
        }
    }
}

/**
 * The DOM `hypen-shake` keyframes (0/20/40/60/80/100% at 0/-6/6/-4/4/0 px),
 * expressed as a decaying sine so Compose can evaluate it continuously.
 * `slidePx` carries the density scale so the throw is 6dp, not 6px.
 */
private fun shakeOffset(t: Float, slidePx: Float): Float {
    val amplitude = slidePx / 4f // 24dp slide unit → 6dp shake throw
    return (sin(2f * Math.PI.toFloat() * 2.5f * t) * amplitude * (1f - t)).toFloat()
}

/** A translucent band sweeping across the element (the `shimmer` preset). */
private fun Modifier.shimmerOverlay(pose: PlaybackPose): Modifier =
    drawWithContent {
        drawContent()
        val progress = pose.shimmer
        if (progress < 0f) return@drawWithContent
        // Sweeps from 200% to -100% of the width, matching the DOM keyframes.
        val span = size.width * 3f
        val start = size.width * 2f - span * progress
        drawRect(
            brush =
                Brush.linearGradient(
                    colors =
                        listOf(
                            Color.Transparent,
                            Color.White.copy(alpha = 0.35f),
                            Color.Transparent,
                        ),
                    start = Offset(start, 0f),
                    end = Offset(start + size.width, size.height),
                ),
        )
    }

/**
 * Exclude an exiting subtree from interaction on all four planes. The
 * engine-side ids are already dead the moment the flagged Remove is emitted,
 * so nothing under here may steal a touch, take focus, speak to TalkBack, or
 * dispatch an action.
 *
 * Action dispatch is gated separately, at the renderer's applicator-context
 * chokepoint, because a component can hold a dispatcher captured before the
 * exit began.
 */
private fun Modifier.exitExclusion(): Modifier =
    this
        .pointerInput(Unit) {
            awaitPointerEventScope {
                while (true) {
                    // Consume at the Initial pass: the whole subtree below
                    // never sees the event.
                    awaitPointerEvent(PointerEventPass.Initial).changes.forEach { it.consume() }
                }
            }
        }
        .focusProperties { canFocus = false }
        .clearAndSetSemantics { }

/**
 * Drop the soft keyboard and the focus ring when a subtree starts exiting.
 * Focus is process-wide state, so it is cleared imperatively rather than by
 * a modifier — `focusProperties` alone stops future focus, not current.
 */
@Composable
fun ClearFocusOnExit(exiting: Boolean) {
    val focusManager = LocalFocusManager.current
    DisposableEffect(exiting) {
        if (exiting) {
            runCatching { focusManager.clearFocus(force = true) }
                .onFailure { log.debug { "clearFocus on exit failed: $it" } }
        }
        onDispose { }
    }
}
