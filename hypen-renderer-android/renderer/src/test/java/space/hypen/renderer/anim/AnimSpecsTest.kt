package space.hypen.renderer.anim

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Vocabulary + defensive-parsing conformance for the `__anim.*` channel.
 *
 * Mirrors the normative parser in `@hypen-space/core/animation`: the engine
 * always emits complete channel objects, so a missing or invalid REQUIRED
 * field marks the whole channel malformed (→ null → the renderer snaps), and
 * nothing here may throw.
 */
class AnimSpecsTest {
    private fun transitionWire(
        duration: Any? = 200.0,
        curve: Any? = "easeOut",
        extra: Map<String, Any?> = emptyMap(),
    ): Map<String, Any?> = mapOf("duration" to duration, "curve" to curve) + extra

    // ---------------------------------------------------------------- curves

    @Test
    fun `spring is the pinned overshoot bezier, not a physics spring`() {
        val spring = AnimCurve.SPRING
        assertEquals(0.34f, spring.x1)
        assertEquals(1.56f, spring.y1)
        assertEquals(0.64f, spring.x2)
        assertEquals(1f, spring.y2)
    }

    @Test
    fun `curve control points match the pinned CURVE_BEZIER_POINTS`() {
        assertEquals(listOf(0f, 0f, 1f, 1f), AnimCurve.LINEAR.points())
        assertEquals(listOf(0.42f, 0f, 1f, 1f), AnimCurve.EASE_IN.points())
        assertEquals(listOf(0f, 0f, 0.58f, 1f), AnimCurve.EASE_OUT.points())
        assertEquals(listOf(0.42f, 0f, 0.58f, 1f), AnimCurve.EASE_IN_OUT.points())
    }

    private fun AnimCurve.points() = listOf(x1, y1, x2, y2)

    @Test
    fun `unknown curve token is not a curve`() {
        assertNull(AnimCurve.from("bouncy"))
        assertNull(AnimCurve.from(null))
        assertNull(AnimCurve.from(3))
    }

    // ----------------------------------------------------------- transition

    @Test
    fun `transition parses duration curve and delay`() {
        val spec = AnimParse.transition(transitionWire(extra = mapOf("delay" to 40.0)))
        assertEquals(TransitionSpec(200, AnimCurve.EASE_OUT, 40), spec)
    }

    @Test
    fun `transition without delay defaults to zero`() {
        assertEquals(0, AnimParse.transition(transitionWire())?.delay)
    }

    @Test
    fun `transition missing duration or curve is malformed`() {
        assertNull(AnimParse.transition(mapOf("curve" to "linear")))
        assertNull(AnimParse.transition(mapOf("duration" to 100.0)))
        assertNull(AnimParse.transition(transitionWire(curve = "nope")))
        assertNull(AnimParse.transition(transitionWire(duration = -5.0)))
        assertNull(AnimParse.transition(transitionWire(duration = "200")))
    }

    @Test
    fun `transition props scope keeps only whitelisted names`() {
        val spec = AnimParse.transition(
            transitionWire(extra = mapOf("props" to listOf("opacity", "notAProp", "backgroundColor"))),
        )
        assertEquals(listOf("opacity", "backgroundColor"), spec?.props)
        assertTrue(spec!!.covers("opacity"))
        assertFalse(spec.covers("rotate"))
    }

    @Test
    fun `transition scope that filters to nothing voids the channel`() {
        assertNull(AnimParse.transition(transitionWire(extra = mapOf("props" to listOf("bogus")))))
        assertNull(AnimParse.transition(transitionWire(extra = mapOf("props" to "opacity"))))
    }

    @Test
    fun `unscoped transition covers every animatable prop`() {
        val spec = AnimParse.transition(transitionWire())!!
        assertTrue(spec.covers("opacity"))
        assertTrue(spec.covers("fontSize"))
    }

    @Test
    fun `transition tolerates a stringified JSON object`() {
        val spec = AnimParse.transition("""{"duration":250,"curve":"spring"}""")
        assertEquals(TransitionSpec(250, AnimCurve.SPRING), spec)
    }

    @Test
    fun `malformed channel values never throw`() {
        for (value in listOf(null, 3, true, listOf(1, 2), "not json", "{", emptyMap<String, Any?>())) {
            assertNull(AnimParse.transition(value))
            assertNull(AnimParse.enter(value))
            assertNull(AnimParse.exit(value))
            assertNull(AnimParse.animate(value))
            assertNull(AnimParse.layout(value))
        }
    }

    // ----------------------------------------------------------- enter/exit

    @Test
    fun `enter parses presets and direction`() {
        val spec = AnimParse.enter(
            mapOf(
                "presets" to listOf("slide", "fade"),
                "duration" to 200.0,
                "curve" to "easeOut",
                "from" to "top",
            ),
        )
        assertEquals(listOf(AnimPreset.SLIDE, AnimPreset.FADE), spec?.presets)
        assertEquals(AnimDirection.TOP, spec?.from)
    }

    @Test
    fun `exit reads the to direction, not from`() {
        val spec = AnimParse.exit(
            mapOf(
                "presets" to listOf("fade"),
                "duration" to 150.0,
                "curve" to "easeIn",
                "to" to "trailing",
                "from" to "top",
            ),
        )
        assertEquals(AnimDirection.TRAILING, spec?.to)
    }

    @Test
    fun `an invalid direction is dropped, not channel-voiding`() {
        val spec = AnimParse.enter(
            mapOf("presets" to listOf("fade"), "duration" to 200.0, "curve" to "easeOut", "from" to "sideways"),
        )
        assertNull(spec?.from)
        assertEquals(listOf(AnimPreset.FADE), spec?.presets)
    }

    @Test
    fun `enter with no recognizable preset is malformed`() {
        assertNull(
            AnimParse.enter(mapOf("presets" to listOf("wobble"), "duration" to 200.0, "curve" to "easeOut")),
        )
        assertNull(AnimParse.enter(mapOf("duration" to 200.0, "curve" to "easeOut")))
    }

    // -------------------------------------------------------------- animate

    @Test
    fun `animate preset defaults match the normative table`() {
        assertEquals(1200, AnimatePreset.PULSE.defaultDuration)
        assertNull(AnimatePreset.PULSE.defaultRepeat)
        assertEquals(AnimCurve.EASE_IN_OUT, AnimatePreset.PULSE.defaultCurve)

        assertEquals(800, AnimatePreset.SPIN.defaultDuration)
        assertEquals(AnimCurve.LINEAR, AnimatePreset.SPIN.defaultCurve)

        assertEquals(1500, AnimatePreset.SHIMMER.defaultDuration)
        assertEquals(AnimCurve.LINEAR, AnimatePreset.SHIMMER.defaultCurve)

        assertEquals(400, AnimatePreset.SHAKE.defaultDuration)
        assertEquals(1, AnimatePreset.SHAKE.defaultRepeat)
        assertEquals(AnimCurve.EASE_IN_OUT, AnimatePreset.SHAKE.defaultCurve)
    }

    @Test
    fun `animate loop and finite repeat forms`() {
        val loop = AnimParse.animate(
            mapOf("preset" to "spin", "duration" to 800.0, "curve" to "linear", "repeat" to "loop"),
        )
        assertTrue(loop!!.loops)
        assertNull(loop.repeat)

        val finite = AnimParse.animate(
            mapOf("preset" to "shake", "duration" to 400.0, "curve" to "easeInOut", "repeat" to 3.0),
        )
        assertFalse(finite!!.loops)
        assertEquals(3, finite.repeat)
    }

    @Test
    fun `animate rejects unknown presets and bad repeats`() {
        assertNull(
            AnimParse.animate(mapOf("preset" to "wiggle", "duration" to 400.0, "curve" to "linear", "repeat" to 1.0)),
        )
        assertNull(
            AnimParse.animate(mapOf("preset" to "spin", "duration" to 400.0, "curve" to "linear", "repeat" to 0.0)),
        )
        assertNull(
            AnimParse.animate(mapOf("preset" to "spin", "duration" to 400.0, "curve" to "linear", "repeat" to 1.5)),
        )
        assertNull(AnimParse.animate(mapOf("preset" to "spin", "duration" to 400.0, "curve" to "linear")))
    }

    // ------------------------------------------------------- states, motion

    @Test
    fun `states label parses the object form the engine emits`() {
        assertEquals("open", AnimParse.statesLabel(mapOf("label" to "open")))
        assertEquals("open", AnimParse.statesLabel("""{"label":"open"}"""))
    }

    @Test
    fun `states label tolerates a bare string`() {
        // Recorded tolerance: the desktop renderer shipped a bug reading this
        // channel as a bare string, so hosts flattening the object are
        // accepted rather than silently losing the pose label.
        assertEquals("open", AnimParse.statesLabel("open"))
    }

    @Test
    fun `states label degrades to null`() {
        assertNull(AnimParse.statesLabel(null))
        assertNull(AnimParse.statesLabel(mapOf("label" to 3)))
        assertNull(AnimParse.statesLabel(mapOf("other" to "open")))
    }

    @Test
    fun `motion essential requires exactly true`() {
        assertTrue(AnimParse.motionEssential(mapOf("essential" to true)))
        assertTrue(AnimParse.motionEssential("""{"essential":true}"""))
        assertFalse(AnimParse.motionEssential(mapOf("essential" to "true")))
        assertFalse(AnimParse.motionEssential(mapOf("essential" to false)))
        assertFalse(AnimParse.motionEssential(null))
    }

    // -------------------------------------------------------- node + batch

    @Test
    fun `node parses every channel off one props map`() {
        val specs = AnimParse.node(
            mapOf(
                "text" to "hello",
                ANIM_TRANSITION_PROP to transitionWire(),
                ANIM_ENTER_PROP to mapOf("presets" to listOf("fade"), "duration" to 200.0, "curve" to "easeOut"),
                ANIM_EXIT_PROP to mapOf("presets" to listOf("fade"), "duration" to 150.0, "curve" to "easeIn"),
                ANIM_ANIMATE_PROP to mapOf(
                    "preset" to "pulse", "duration" to 1200.0, "curve" to "easeInOut", "repeat" to "loop",
                ),
                ANIM_MOTION_PROP to mapOf("essential" to true),
                ANIM_STATES_PROP to mapOf("label" to "open"),
            ),
        )
        assertEquals(200, specs.transition?.duration)
        assertEquals(200, specs.enter?.duration)
        assertEquals(150, specs.exit?.duration)
        assertEquals(AnimatePreset.PULSE, specs.animate?.preset)
        assertTrue(specs.motionEssential)
        assertEquals("open", specs.statesLabel)
        assertFalse(specs.isEmpty)
    }

    @Test
    fun `node with no animation props is empty`() {
        assertTrue(AnimParse.node(mapOf("text" to "hi", "opacity.0" to 1.0)).isEmpty)
    }

    @Test
    fun `batch spec normalizes like a transition`() {
        assertEquals(
            TransitionSpec(250, AnimCurve.SPRING),
            AnimParse.batchSpec(mapOf("duration" to 250.0, "curve" to "spring")),
        )
        assertNull(AnimParse.batchSpec(null))
        assertNull(AnimParse.batchSpec(mapOf("curve" to "spring")))
    }

    // ------------------------------------------------------ prop-key routing

    @Test
    fun `animatable base resolves the applicator arg suffix`() {
        assertEquals("backgroundColor", AnimParse.animatableBase("backgroundColor.0"))
        assertEquals("opacity", AnimParse.animatableBase("opacity"))
    }

    @Test
    fun `non-whitelisted, variant and anim props never glide`() {
        assertNull(AnimParse.animatableBase("text"))
        assertNull(AnimParse.animatableBase("fontWeight.0"))
        assertNull(AnimParse.animatableBase("backgroundColor@md.0"))
        assertNull(AnimParse.animatableBase("color:hover.0"))
        assertNull(AnimParse.animatableBase(ANIM_TRANSITION_PROP))
    }

    @Test
    fun `the whitelist has the 27 normative entries`() {
        assertEquals(27, ANIMATABLE_PROPS.size)
        assertTrue(COLOR_ANIMATABLE_PROPS.all { it in ANIMATABLE_PROPS })
    }
}
