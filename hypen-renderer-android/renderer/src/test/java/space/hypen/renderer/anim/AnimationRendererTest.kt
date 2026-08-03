package space.hypen.renderer.anim

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import space.hypen.renderer.model.Patch
import space.hypen.renderer.model.PatchType
import space.hypen.renderer.render.ActionDispatcher
import space.hypen.renderer.render.ComposeRenderer

/**
 * The animation protocol as it is actually driven — through patches applied
 * to a real [ComposeRenderer]. These exercise the wire-level contracts the
 * coordinator tests assume: the `transition` flag on Remove, root-first
 * ordering, first-patch-only preludes, the exiting-subtree dispatch gate and
 * `.onAnimationComplete` payloads.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class AnimationRendererTest {
    private val exitWire =
        mapOf("presets" to listOf("fade"), "duration" to 150.0, "curve" to "easeIn")
    private val transitionWire = mapOf("duration" to 100.0, "curve" to "linear")

    private class Harness(
        val renderer: ComposeRenderer,
        val coordinator: AnimationCoordinator,
        val dispatched: MutableList<Pair<String, Map<String, Any?>?>>,
    )

    private fun harness(
        motion: MotionPreference = AlwaysAnimate,
        scope: kotlinx.coroutines.CoroutineScope,
    ): Harness {
        val coordinator = AnimationCoordinator(motion, scope)
        val renderer = ComposeRenderer(animation = coordinator)
        val dispatched = mutableListOf<Pair<String, Map<String, Any?>?>>()
        renderer.setActionDispatcher(ActionDispatcher { action, payload -> dispatched.add(action to payload) })
        return Harness(renderer, coordinator, dispatched)
    }

    // ----------------------------------------------------- deferred remove

    @Test
    fun `a flagged remove keeps the corpse until the backbone fires`() = runTest {
        val h = harness(scope = backgroundScope)
        h.renderer.applyPatches(
            listOf(
                Patch.create("1", "column"),
                Patch.create("2", "text", mapOf(ANIM_EXIT_PROP to exitWire)),
                Patch.insert("root", "1"),
                Patch.insert("1", "2"),
            ),
        )

        h.renderer.applyPatches(listOf(Patch.remove("2", transition = true)))
        assertNotNull("exit-flagged node must not evict immediately", h.renderer.getElement("2"))
        assertTrue(h.renderer.getElement("1")!!.children.contains("2"))

        advanceTimeBy(231) // 150 + 0 + 80
        runCurrent()
        assertNull(h.renderer.getElement("2"))
        assertFalse(h.renderer.getElement("1")!!.children.contains("2"))
    }

    @Test
    fun `a flagged remove without an exit spec snaps, exactly as before`() = runTest {
        val h = harness(scope = backgroundScope)
        h.renderer.applyPatches(
            listOf(Patch.create("1", "text"), Patch.insert("root", "1")),
        )
        h.renderer.applyPatches(listOf(Patch.remove("1", transition = true)))
        assertNull(h.renderer.getElement("1"))
    }

    @Test
    fun `an unflagged remove is unchanged`() = runTest {
        val h = harness(scope = backgroundScope)
        h.renderer.applyPatches(
            listOf(
                Patch.create("1", "text", mapOf(ANIM_EXIT_PROP to exitWire)),
                Patch.insert("root", "1"),
            ),
        )
        h.renderer.applyPatches(listOf(Patch.remove("1")))
        assertNull("no transition flag means no deferral", h.renderer.getElement("1"))
    }

    @Test
    fun `descendant removes inside an exiting subtree defer to the root`() = runTest {
        val h = harness(scope = backgroundScope)
        h.renderer.applyPatches(
            listOf(
                Patch.create("root1", "column"),
                Patch.create("card", "column", mapOf(ANIM_EXIT_PROP to exitWire)),
                Patch.create("label", "text"),
                Patch.insert("root", "root1"),
                Patch.insert("root1", "card"),
                Patch.insert("card", "label"),
            ),
        )

        // Root-first wire ordering: the flagged root, then plain descendants.
        h.renderer.applyPatches(
            listOf(Patch.remove("card", transition = true), Patch.remove("label")),
        )
        assertNotNull(h.renderer.getElement("card"))
        assertNotNull("the whole subtree stays alive while the exit plays", h.renderer.getElement("label"))

        advanceTimeBy(231)
        runCurrent()
        assertNull(h.renderer.getElement("card"))
        assertNull(h.renderer.getElement("label"))
    }

    @Test
    fun `an exiting subtree cannot dispatch actions`() = runTest {
        val h = harness(scope = backgroundScope)
        h.renderer.applyPatches(
            listOf(
                Patch.create("card", "column", mapOf(ANIM_EXIT_PROP to exitWire)),
                Patch.create("btn", "button"),
                Patch.insert("root", "card"),
                Patch.insert("card", "btn"),
            ),
        )

        val liveContext = h.renderer.createApplicatorContext(h.renderer.getElement("btn")!!)
        liveContext.actionDispatcher?.dispatch("beforeExit", null)
        assertEquals(1, h.dispatched.size)

        h.renderer.applyPatches(listOf(Patch.remove("card", transition = true)))

        // Both a context built before the exit and one built after are gated:
        // engine-side these ids are already dead.
        liveContext.actionDispatcher?.dispatch("duringExit", null)
        h.renderer.createApplicatorContext(h.renderer.getElement("btn")!!)
            .actionDispatcher?.dispatch("duringExit2", null)
        assertEquals(listOf("beforeExit"), h.dispatched.map { it.first })
    }

    @Test
    fun `reduced motion tears an exit down immediately and completes nothing`() = runTest {
        val h = harness(motion = NeverAnimate, scope = backgroundScope)
        h.renderer.applyPatches(
            listOf(
                Patch.create(
                    "1",
                    "text",
                    mapOf(ANIM_EXIT_PROP to exitWire, "onAnimationComplete.0" to "@actions.done"),
                ),
                Patch.insert("root", "1"),
            ),
        )
        h.renderer.applyPatches(listOf(Patch.remove("1", transition = true)))
        runCurrent()
        assertNull(h.renderer.getElement("1"))
        assertTrue(h.dispatched.isEmpty())
    }

    // -------------------------------------------------------- completions

    @Test
    fun `exit completion dispatches the exact payload through the action channel`() = runTest {
        val h = harness(scope = backgroundScope)
        h.renderer.applyPatches(
            listOf(
                Patch.create(
                    "1",
                    "text",
                    mapOf(ANIM_EXIT_PROP to exitWire, "onAnimationComplete.0" to "@actions.faded"),
                ),
                Patch.insert("root", "1"),
            ),
        )
        h.renderer.applyPatches(listOf(Patch.remove("1", transition = true)))
        advanceTimeBy(231)
        runCurrent()

        assertEquals(listOf("faded" to mapOf<String, Any?>("animation" to "exit")), h.dispatched)
    }

    @Test
    fun `completion fields are written last and cannot be shadowed`() = runTest {
        val h = harness(scope = backgroundScope)
        h.renderer.applyPatches(
            listOf(
                Patch.create(
                    "1",
                    "text",
                    mapOf(
                        ANIM_EXIT_PROP to exitWire,
                        "onAnimationComplete.0" to "@actions.faded",
                        "onAnimationComplete.source" to "card",
                        "onAnimationComplete.animation" to "spoofed",
                    ),
                ),
                Patch.insert("root", "1"),
            ),
        )
        h.renderer.applyPatches(listOf(Patch.remove("1", transition = true)))
        advanceTimeBy(231)
        runCurrent()

        assertEquals(
            mapOf<String, Any?>("source" to "card", "animation" to "exit"),
            h.dispatched.single().second,
        )
    }

    @Test
    fun `a node without onAnimationComplete dispatches nothing`() = runTest {
        val h = harness(scope = backgroundScope)
        h.renderer.applyPatches(
            listOf(
                Patch.create("1", "text", mapOf(ANIM_EXIT_PROP to exitWire)),
                Patch.insert("root", "1"),
            ),
        )
        h.renderer.applyPatches(listOf(Patch.remove("1", transition = true)))
        advanceTimeBy(231)
        runCurrent()
        assertTrue(h.dispatched.isEmpty())
    }

    // ------------------------------------------------------ batch preludes

    @Test
    fun `a prelude at batch index 0 stamps the batch's whitelisted writes`() = runTest {
        val h = harness(scope = backgroundScope)
        h.renderer.applyPatches(listOf(Patch.create("1", "text"), Patch.insert("root", "1")))
        h.renderer.applyPatches(
            listOf(
                Patch.batchAnimation(mapOf("duration" to 300.0, "curve" to "spring")),
                Patch.setProp("1", "opacity.0", 0.4),
            ),
        )

        assertEquals(
            TransitionSpec(300, AnimCurve.SPRING),
            h.coordinator.consumePendingTransitions("1")["opacity.0"]?.spec,
        )
    }

    @Test
    fun `a prelude at any other index is not a stamp`() = runTest {
        val h = harness(scope = backgroundScope)
        h.renderer.applyPatches(listOf(Patch.create("1", "text"), Patch.insert("root", "1")))
        h.renderer.applyPatches(
            listOf(
                Patch.setProp("1", "opacity.0", 0.4),
                Patch.batchAnimation(mapOf("duration" to 300.0, "curve" to "spring")),
            ),
        )

        assertNull(h.renderer.getBatchAnimationSpec())
        assertTrue(h.coordinator.consumePendingTransitions("1").isEmpty())
    }

    @Test
    fun `a node transition glides an ordinary SetProp`() = runTest {
        val h = harness(scope = backgroundScope)
        h.renderer.applyPatches(
            listOf(
                Patch.create("1", "text", mapOf(ANIM_TRANSITION_PROP to transitionWire)),
                Patch.insert("root", "1"),
            ),
        )
        h.renderer.applyPatches(listOf(Patch.setProp("1", "backgroundColor.0", "#00ff00")))

        assertEquals(
            TransitionSpec(100, AnimCurve.LINEAR),
            h.coordinator.consumePendingTransitions("1")["backgroundColor.0"]?.spec,
        )
    }

    @Test
    fun `a glide carries the value the prop held before the write`() = runTest {
        val h = harness(scope = backgroundScope)
        h.renderer.applyPatches(
            listOf(
                Patch.create(
                    "1",
                    "text",
                    mapOf(ANIM_TRANSITION_PROP to transitionWire, "opacity.0" to 1.0),
                ),
                Patch.insert("root", "1"),
            ),
        )
        h.renderer.applyPatches(listOf(Patch.setProp("1", "opacity.0", 0.25)))

        val glide = h.coordinator.consumePendingTransitions("1")["opacity.0"]!!
        assertEquals(1.0, glide.from)
        assertEquals(0.25, h.renderer.getElement("1")!!.rawProps["opacity.0"])
    }

    @Test
    fun `a RemoveProp on a whitelisted prop glides back from its old value`() = runTest {
        val h = harness(scope = backgroundScope)
        h.renderer.applyPatches(
            listOf(
                Patch.create(
                    "1",
                    "text",
                    mapOf(ANIM_TRANSITION_PROP to transitionWire, "opacity.0" to 0.2),
                ),
                Patch.insert("root", "1"),
            ),
        )
        h.renderer.applyPatches(listOf(Patch.removeProp("1", "opacity.0")))
        assertEquals(0.2, h.coordinator.consumePendingTransitions("1")["opacity.0"]?.from)
    }

    @Test
    fun `an unknown patch type is still routed, and BATCH_ANIMATION mutates no tree state`() = runTest {
        val h = harness(scope = backgroundScope)
        h.renderer.applyPatches(
            listOf(
                Patch.batchAnimation(mapOf("duration" to 300.0, "curve" to "spring")),
                Patch.create("1", "text"),
                Patch.insert("root", "1"),
            ),
        )
        assertEquals("1", h.renderer.getRootId())
        assertEquals(PatchType.BATCH_ANIMATION, PatchType.valueOf("BATCH_ANIMATION"))
    }

    // ---------------------------------------------------------- overrides

    @Test
    fun `an animation override shadows the engine value and clears cleanly`() = runTest {
        val h = harness(scope = backgroundScope)
        h.renderer.applyPatches(
            listOf(Patch.create("1", "text", mapOf("opacity.0" to 1.0)), Patch.insert("root", "1")),
        )
        val element = h.renderer.getElement("1")!!

        element.setAnimatedOverride("opacity.0", 0.5)
        assertEquals(0.5, element.props["opacity.0"])
        assertEquals("the engine value is untouched", 1.0, element.rawProps["opacity.0"])
        assertTrue(element.hasAnimatedOverride("opacity.0"))

        element.clearAnimatedOverride("opacity.0")
        assertEquals(1.0, element.props["opacity.0"])
        assertFalse(element.hasAnimatedOverride("opacity.0"))
    }

    @Test
    fun `overrides preserve engine prop order`() = runTest {
        val h = harness(scope = backgroundScope)
        h.renderer.applyPatches(
            listOf(
                Patch.create(
                    "1",
                    "text",
                    linkedMapOf("background.0" to "red", "borderColor.0" to "blue", "padding.0" to 8.0),
                ),
                Patch.insert("root", "1"),
            ),
        )
        val element = h.renderer.getElement("1")!!
        element.setAnimatedOverride("borderColor.0", "#00ff00ff")
        assertEquals(
            listOf("background.0", "borderColor.0", "padding.0"),
            element.props.keys.toList(),
        )
    }

    @Test
    fun `clear resets the animation state machine`() = runTest {
        val h = harness(scope = backgroundScope)
        h.renderer.applyPatches(
            listOf(
                Patch.create("1", "text", mapOf(ANIM_EXIT_PROP to exitWire)),
                Patch.insert("root", "1"),
            ),
        )
        h.renderer.applyPatches(listOf(Patch.remove("1", transition = true)))
        assertTrue(h.coordinator.isExitingRoot("1"))

        h.renderer.clear()
        assertFalse(h.coordinator.isExitingRoot("1"))
        advanceTimeBy(1000)
        runCurrent()
        assertTrue(h.dispatched.isEmpty())
    }
}
