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

/**
 * Protocol conformance for [AnimationCoordinator] — the layer that decides
 * WHETHER anything animates. Everything asserted here is renderer behaviour,
 * not plumbing: batch lifecycle, enter eligibility, the deferred-remove
 * contract including the timeout backbone, transaction precedence, the
 * reduced-motion gate and natural-settle-only completions.
 *
 * The coordinator takes its scheduler by injection, so the timeout backbone
 * runs on `runTest`'s virtual clock and every timing assertion is exact.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class AnimationCoordinatorTest {
    private val enterWire =
        mapOf("presets" to listOf("fade"), "duration" to 200.0, "curve" to "easeOut")
    private val exitWire =
        mapOf("presets" to listOf("fade"), "duration" to 150.0, "curve" to "easeIn")
    private val transitionWire = mapOf("duration" to 100.0, "curve" to "linear")

    private class RecordingSink : AnimationCompletionSink {
        val completions = mutableListOf<Pair<String, AnimationCompletion>>()

        override fun dispatch(id: String, completion: AnimationCompletion) {
            completions.add(id to completion)
        }
    }

    /** Applies one batch of "patches" the way ComposeRenderer does. */
    private fun AnimationCoordinator.batch(stamp: Map<String, Any?>? = null, body: () -> Unit) {
        beginBatch(stamp)
        body()
        endBatch()
    }

    // ------------------------------------------------------------- enters

    @Test
    fun `the first-ever batch never enter-animates`() = runTest {
        val coordinator = AnimationCoordinator(AlwaysAnimate, backgroundScope)
        coordinator.batch { coordinator.noteCreate("1", mapOf(ANIM_ENTER_PROP to enterWire)) }
        assertNull(coordinator.consumePendingEnter("1"))
    }

    @Test
    fun `a node created after the first batch enter-animates once`() = runTest {
        val coordinator = AnimationCoordinator(AlwaysAnimate, backgroundScope)
        coordinator.batch { coordinator.noteCreate("root", emptyMap()) }
        coordinator.batch { coordinator.noteCreate("1", mapOf(ANIM_ENTER_PROP to enterWire)) }

        assertEquals(200, coordinator.consumePendingEnter("1")?.duration)
        // One-shot: an enter never replays.
        assertNull(coordinator.consumePendingEnter("1"))
    }

    @Test
    fun `a cached attach never enter-animates`() = runTest {
        val coordinator = AnimationCoordinator(AlwaysAnimate, backgroundScope)
        coordinator.batch { coordinator.noteCreate("root", emptyMap()) }
        coordinator.batch { coordinator.noteCreate("1", mapOf(ANIM_ENTER_PROP to enterWire)) }
        // Navigating away and back re-attaches the cached subtree.
        coordinator.batch { coordinator.noteAttach("1") }
        assertNull(coordinator.consumePendingEnter("1"))
    }

    @Test
    fun `a cached attach is flagged so finite presets do not replay`() = runTest {
        val coordinator = AnimationCoordinator(AlwaysAnimate, backgroundScope)
        coordinator.batch { coordinator.noteAttach("1") }
        assertTrue(coordinator.consumeResumedFromCache("1"))
        assertFalse(coordinator.consumeResumedFromCache("1"))
    }

    @Test
    fun `reduced motion skips enters but a motion-essential node still enters`() = runTest {
        val coordinator = AnimationCoordinator(NeverAnimate, backgroundScope)
        coordinator.batch { coordinator.noteCreate("root", emptyMap()) }
        coordinator.batch {
            coordinator.noteCreate("plain", mapOf(ANIM_ENTER_PROP to enterWire))
            coordinator.noteCreate(
                "essential",
                mapOf(ANIM_ENTER_PROP to enterWire, ANIM_MOTION_PROP to mapOf("essential" to true)),
            )
        }
        assertNull(coordinator.consumePendingEnter("plain"))
        assertNotNull(coordinator.consumePendingEnter("essential"))
    }

    // ------------------------------------------------ transition precedence

    @Test
    fun `a node transition glides its whitelisted props`() = runTest {
        val coordinator = AnimationCoordinator(AlwaysAnimate, backgroundScope)
        coordinator.batch { coordinator.noteCreate("1", mapOf(ANIM_TRANSITION_PROP to transitionWire)) }
        // Third argument is the value the prop held BEFORE the write.
        coordinator.batch { coordinator.noteSetProp("1", "opacity.0", 1.0) }

        val queued = coordinator.consumePendingTransitions("1")
        assertEquals(TransitionSpec(100, AnimCurve.LINEAR), queued["opacity.0"]?.spec)
        // The pre-write value is captured with the glide so the driver never
        // has to reconstruct where the animation starts from.
        assertEquals(1.0, queued["opacity.0"]?.from)
        // Draining is one-shot.
        assertTrue(coordinator.consumePendingTransitions("1").isEmpty())
    }

    @Test
    fun `non-whitelisted props snap even under a transition`() = runTest {
        val coordinator = AnimationCoordinator(AlwaysAnimate, backgroundScope)
        coordinator.batch { coordinator.noteCreate("1", mapOf(ANIM_TRANSITION_PROP to transitionWire)) }
        coordinator.batch { coordinator.noteSetProp("1", "fontWeight.0", 700.0) }
        assertTrue(coordinator.consumePendingTransitions("1").isEmpty())
    }

    @Test
    fun `a scoped transition only covers the props it names`() = runTest {
        val coordinator = AnimationCoordinator(AlwaysAnimate, backgroundScope)
        coordinator.batch {
            coordinator.noteCreate(
                "1",
                mapOf(ANIM_TRANSITION_PROP to transitionWire + mapOf("props" to listOf("opacity"))),
            )
        }
        coordinator.batch {
            coordinator.noteSetProp("1", "opacity.0", 0.5)
            coordinator.noteSetProp("1", "translateX.0", 12.0)
        }
        val queued = coordinator.consumePendingTransitions("1")
        assertEquals(setOf("opacity.0"), queued.keys)
    }

    @Test
    fun `a node created in this batch is excluded — its enter owns the first motion`() = runTest {
        val coordinator = AnimationCoordinator(AlwaysAnimate, backgroundScope)
        coordinator.batch { coordinator.noteCreate("root", emptyMap()) }
        coordinator.batch {
            coordinator.noteCreate("1", mapOf(ANIM_TRANSITION_PROP to transitionWire))
            coordinator.noteSetProp("1", "opacity.0", 0.5)
        }
        assertTrue(coordinator.consumePendingTransitions("1").isEmpty())
    }

    @Test
    fun `the transaction stamp overrides the node transition`() = runTest {
        val coordinator = AnimationCoordinator(AlwaysAnimate, backgroundScope)
        coordinator.batch { coordinator.noteCreate("1", mapOf(ANIM_TRANSITION_PROP to transitionWire)) }
        coordinator.batch(stamp = mapOf("duration" to 300.0, "curve" to "spring")) {
            coordinator.noteSetProp("1", "opacity.0", 0.5)
        }
        assertEquals(
            TransitionSpec(300, AnimCurve.SPRING),
            coordinator.consumePendingTransitions("1")["opacity.0"]?.spec,
        )
    }

    @Test
    fun `the transaction stamp glides a node with no transition of its own`() = runTest {
        val coordinator = AnimationCoordinator(AlwaysAnimate, backgroundScope)
        coordinator.batch { coordinator.noteCreate("1", emptyMap()) }
        coordinator.batch(stamp = mapOf("duration" to 300.0, "curve" to "spring")) {
            coordinator.noteSetProp("1", "backgroundColor.0", "#ff0000")
        }
        assertNotNull(coordinator.consumePendingTransitions("1")["backgroundColor.0"])
    }

    @Test
    fun `the stamp is cleared per batch — the next unstamped write snaps`() = runTest {
        val coordinator = AnimationCoordinator(AlwaysAnimate, backgroundScope)
        coordinator.batch { coordinator.noteCreate("1", emptyMap()) }
        coordinator.batch(stamp = mapOf("duration" to 300.0, "curve" to "spring")) {
            coordinator.noteSetProp("1", "opacity.0", 0.5)
        }
        coordinator.consumePendingTransitions("1")

        coordinator.batch { coordinator.noteSetProp("1", "opacity.0", 1.0) }
        assertTrue(coordinator.consumePendingTransitions("1").isEmpty())
        assertNull(coordinator.currentTransactionSpec())
    }

    @Test
    fun `a malformed stamp degrades to unstamped`() = runTest {
        val coordinator = AnimationCoordinator(AlwaysAnimate, backgroundScope)
        coordinator.batch { coordinator.noteCreate("1", emptyMap()) }
        coordinator.batch(stamp = mapOf("curve" to "spring")) {
            coordinator.noteSetProp("1", "opacity.0", 0.5)
        }
        assertTrue(coordinator.consumePendingTransitions("1").isEmpty())
    }

    @Test
    fun `an in-flight structural playback outranks both spec sources`() = runTest {
        val coordinator = AnimationCoordinator(AlwaysAnimate, backgroundScope)
        coordinator.batch { coordinator.noteCreate("1", mapOf(ANIM_TRANSITION_PROP to transitionWire)) }
        coordinator.setPlaybackActive("1", true)
        coordinator.batch(stamp = mapOf("duration" to 300.0, "curve" to "spring")) {
            coordinator.noteSetProp("1", "opacity.0", 0.5)
        }
        assertTrue(coordinator.consumePendingTransitions("1").isEmpty())
    }

    @Test
    fun `reduced motion ignores stamps except for motion-essential nodes`() = runTest {
        val coordinator = AnimationCoordinator(NeverAnimate, backgroundScope)
        coordinator.batch {
            coordinator.noteCreate("plain", mapOf(ANIM_TRANSITION_PROP to transitionWire))
            coordinator.noteCreate(
                "essential",
                mapOf(ANIM_TRANSITION_PROP to transitionWire, ANIM_MOTION_PROP to mapOf("essential" to true)),
            )
        }
        coordinator.batch(stamp = mapOf("duration" to 300.0, "curve" to "spring")) {
            coordinator.noteSetProp("plain", "opacity.0", 0.5)
            coordinator.noteSetProp("essential", "opacity.0", 0.5)
        }
        assertTrue(coordinator.consumePendingTransitions("plain").isEmpty())
        assertNotNull(coordinator.consumePendingTransitions("essential")["opacity.0"])
    }

    // ------------------------------------------------- deferred remove/exit

    @Test
    fun `a flagged remove without an exit spec is not deferred`() = runTest {
        val coordinator = AnimationCoordinator(AlwaysAnimate, backgroundScope)
        coordinator.batch { coordinator.noteCreate("1", emptyMap()) }
        assertFalse(coordinator.beginExit("1", setOf("1")) { })
    }

    @Test
    fun `a flagged remove with an exit spec defers and finalizes on the backbone`() = runTest {
        val coordinator = AnimationCoordinator(AlwaysAnimate, backgroundScope)
        var finalized = false
        coordinator.batch { coordinator.noteCreate("1", mapOf(ANIM_EXIT_PROP to exitWire)) }

        assertTrue(coordinator.beginExit("1", setOf("1")) { finalized = true })
        assertTrue(coordinator.isExitingRoot("1"))
        assertFalse(finalized)

        // duration(150) + delay(0) + SETTLE_GRACE_MS(80) = 230ms.
        advanceTimeBy(229)
        runCurrent()
        assertFalse("finalized before the backbone elapsed", finalized)

        advanceTimeBy(2)
        runCurrent()
        assertTrue(finalized)
        assertFalse(coordinator.isExitingRoot("1"))
    }

    @Test
    fun `the backbone budget includes the exit delay`() = runTest {
        val coordinator = AnimationCoordinator(AlwaysAnimate, backgroundScope)
        var finalized = false
        coordinator.batch {
            coordinator.noteCreate("1", mapOf(ANIM_EXIT_PROP to exitWire + mapOf("delay" to 100.0)))
        }
        coordinator.beginExit("1", setOf("1")) { finalized = true }

        advanceTimeBy(300)
        runCurrent()
        assertFalse(finalized)
        advanceTimeBy(31)
        runCurrent()
        assertTrue(finalized)
    }

    @Test
    fun `a natural settle finalizes early and cancels the backbone`() = runTest {
        val coordinator = AnimationCoordinator(AlwaysAnimate, backgroundScope)
        var finalizeCount = 0
        coordinator.batch { coordinator.noteCreate("1", mapOf(ANIM_EXIT_PROP to exitWire)) }
        coordinator.beginExit("1", setOf("1")) { finalizeCount++ }

        advanceTimeBy(150)
        coordinator.notifyExitSettled("1")
        assertEquals(1, finalizeCount)

        // The backbone must not fire a second teardown.
        advanceTimeBy(1000)
        runCurrent()
        assertEquals(1, finalizeCount)
    }

    @Test
    fun `plain removes inside an exiting subtree defer to the root's finalize`() = runTest {
        val coordinator = AnimationCoordinator(AlwaysAnimate, backgroundScope)
        val order = mutableListOf<String>()
        coordinator.batch {
            coordinator.noteCreate("root", mapOf(ANIM_EXIT_PROP to exitWire))
            coordinator.noteCreate("child", emptyMap())
        }
        coordinator.beginExit("root", setOf("root", "child")) { order.add("root") }
        assertTrue(coordinator.isInExitingSubtree("child"))

        // Root-first wire ordering: the descendant's PLAIN remove arrives next.
        assertTrue(coordinator.deferToExitingAncestor("child") { order.add("child") })
        assertTrue(order.isEmpty())

        advanceTimeBy(231)
        runCurrent()
        // Descendants finalize before the root, exactly once each.
        assertEquals(listOf("child", "root"), order)
    }

    @Test
    fun `deferToExitingAncestor is false outside an exiting subtree`() = runTest {
        val coordinator = AnimationCoordinator(AlwaysAnimate, backgroundScope)
        coordinator.batch { coordinator.noteCreate("1", emptyMap()) }
        assertFalse(coordinator.deferToExitingAncestor("1") { })
    }

    @Test
    fun `a duplicate flagged remove keeps exactly one finalize sequence`() = runTest {
        val coordinator = AnimationCoordinator(AlwaysAnimate, backgroundScope)
        var count = 0
        coordinator.batch { coordinator.noteCreate("1", mapOf(ANIM_EXIT_PROP to exitWire)) }
        assertTrue(coordinator.beginExit("1", setOf("1")) { count++ })
        assertTrue(coordinator.beginExit("1", setOf("1")) { count++ })

        advanceTimeBy(231)
        runCurrent()
        // Both finalizers run, but only once, from ONE settle.
        assertEquals(2, count)
        assertFalse(coordinator.isExitingRoot("1"))
    }

    @Test
    fun `reduced motion finalizes an exit immediately and plays nothing`() = runTest {
        val coordinator = AnimationCoordinator(NeverAnimate, backgroundScope)
        val sink = RecordingSink()
        coordinator.setCompletionSink(sink)
        var finalized = false
        coordinator.batch {
            coordinator.noteCreate(
                "1",
                mapOf(ANIM_EXIT_PROP to exitWire, ANIM_COMPLETE_PROP + ".0" to "@actions.done"),
            )
        }

        // Still deferred (the renderer owns the corpse) so the subtree is
        // excluded from interaction, but nothing plays and nothing completes.
        assertTrue(coordinator.beginExit("1", setOf("1")) { finalized = true })
        assertNull(coordinator.exitPlaybackFor("1"))
        runCurrent()
        assertTrue(finalized)
        assertTrue(sink.completions.isEmpty())
    }

    @Test
    fun `an exiting node's prop writes snap`() = runTest {
        val coordinator = AnimationCoordinator(AlwaysAnimate, backgroundScope)
        coordinator.batch {
            coordinator.noteCreate(
                "1",
                mapOf(ANIM_TRANSITION_PROP to transitionWire, ANIM_EXIT_PROP to exitWire),
            )
        }
        coordinator.beginExit("1", setOf("1")) { }
        coordinator.batch { coordinator.noteSetProp("1", "opacity.0", 0.0) }
        assertTrue(coordinator.consumePendingTransitions("1").isEmpty())
    }

    // ---------------------------------------------------------- completions

    @Test
    fun `exit completion fires on natural settle with the exact payload`() = runTest {
        val coordinator = AnimationCoordinator(AlwaysAnimate, backgroundScope)
        val sink = RecordingSink()
        coordinator.setCompletionSink(sink)
        coordinator.batch { coordinator.noteCreate("1", mapOf(ANIM_EXIT_PROP to exitWire)) }
        coordinator.beginExit("1", setOf("1")) { }

        advanceTimeBy(231)
        runCurrent()
        assertEquals(listOf("1" to AnimationCompletion("exit")), sink.completions)
        assertEquals(mapOf("animation" to "exit"), sink.completions.single().second.toPayload())
    }

    @Test
    fun `an interrupted exit fires nothing`() = runTest {
        val coordinator = AnimationCoordinator(AlwaysAnimate, backgroundScope)
        val sink = RecordingSink()
        coordinator.setCompletionSink(sink)
        coordinator.batch { coordinator.noteCreate("1", mapOf(ANIM_EXIT_PROP to exitWire)) }
        coordinator.beginExit("1", setOf("1")) { }

        coordinator.finalizeExitNow("1")
        advanceTimeBy(1000)
        runCurrent()
        assertTrue(sink.completions.isEmpty())
    }

    @Test
    fun `enter completion payload is exactly the animation field`() = runTest {
        val coordinator = AnimationCoordinator(AlwaysAnimate, backgroundScope)
        val sink = RecordingSink()
        coordinator.setCompletionSink(sink)
        coordinator.batch { coordinator.noteCreate("1", mapOf(ANIM_ENTER_PROP to enterWire)) }
        coordinator.notifyEnterSettled("1")
        assertEquals(mapOf("animation" to "enter"), sink.completions.single().second.toPayload())
    }

    @Test
    fun `an enter inside an exiting subtree fires nothing`() = runTest {
        val coordinator = AnimationCoordinator(AlwaysAnimate, backgroundScope)
        val sink = RecordingSink()
        coordinator.setCompletionSink(sink)
        coordinator.batch {
            coordinator.noteCreate("1", mapOf(ANIM_ENTER_PROP to enterWire, ANIM_EXIT_PROP to exitWire))
        }
        coordinator.beginExit("1", setOf("1")) { }
        coordinator.notifyEnterSettled("1")
        assertTrue(sink.completions.isEmpty())
    }

    @Test
    fun `finite preset completion carries the preset name`() = runTest {
        val coordinator = AnimationCoordinator(AlwaysAnimate, backgroundScope)
        val sink = RecordingSink()
        coordinator.setCompletionSink(sink)
        coordinator.batch { coordinator.noteCreate("1", emptyMap()) }
        coordinator.notifyPresetCompleted("1", AnimatePreset.SHAKE)
        assertEquals(mapOf("animation" to "shake"), sink.completions.single().second.toPayload())
    }

    @Test
    fun `reduced motion suppresses completions`() = runTest {
        val coordinator = AnimationCoordinator(NeverAnimate, backgroundScope)
        val sink = RecordingSink()
        coordinator.setCompletionSink(sink)
        coordinator.batch { coordinator.noteCreate("1", emptyMap()) }
        coordinator.notifyEnterSettled("1")
        coordinator.notifyPresetCompleted("1", AnimatePreset.SHAKE)
        assertTrue(sink.completions.isEmpty())
    }

    // --------------------------------------------------------------- states

    @Test
    fun `a states label change completes after the node's transition settles`() = runTest {
        val coordinator = AnimationCoordinator(AlwaysAnimate, backgroundScope)
        val sink = RecordingSink()
        coordinator.setCompletionSink(sink)
        coordinator.batch {
            coordinator.noteCreate(
                "1",
                mapOf(ANIM_TRANSITION_PROP to transitionWire, ANIM_STATES_PROP to mapOf("label" to "closed")),
            )
        }
        // Create-time pose resolution is not a transition: nothing completes.
        advanceTimeBy(1000)
        runCurrent()
        assertTrue(sink.completions.isEmpty())

        coordinator.batch { coordinator.noteAnimProp("1", ANIM_STATES_PROP, mapOf("label" to "open")) }
        advanceTimeBy(179) // 100 + 0 + 80
        runCurrent()
        assertTrue(sink.completions.isEmpty())

        advanceTimeBy(2)
        runCurrent()
        assertEquals(
            mapOf("animation" to "states", "state" to "open"),
            sink.completions.single().second.toPayload(),
        )
    }

    @Test
    fun `a superseding label change cancels the pending states completion`() = runTest {
        val coordinator = AnimationCoordinator(AlwaysAnimate, backgroundScope)
        val sink = RecordingSink()
        coordinator.setCompletionSink(sink)
        coordinator.batch {
            coordinator.noteCreate(
                "1",
                mapOf(ANIM_TRANSITION_PROP to transitionWire, ANIM_STATES_PROP to mapOf("label" to "a")),
            )
        }
        coordinator.batch { coordinator.noteAnimProp("1", ANIM_STATES_PROP, mapOf("label" to "b")) }
        advanceTimeBy(50)
        coordinator.batch { coordinator.noteAnimProp("1", ANIM_STATES_PROP, mapOf("label" to "c")) }
        advanceTimeBy(1000)
        runCurrent()

        // Exactly one completion, for the surviving label.
        assertEquals(1, sink.completions.size)
        assertEquals("c", sink.completions.single().second.state)
    }

    @Test
    fun `re-emitting the same states label opens no window`() = runTest {
        val coordinator = AnimationCoordinator(AlwaysAnimate, backgroundScope)
        val sink = RecordingSink()
        coordinator.setCompletionSink(sink)
        coordinator.batch {
            coordinator.noteCreate(
                "1",
                mapOf(ANIM_TRANSITION_PROP to transitionWire, ANIM_STATES_PROP to mapOf("label" to "a")),
            )
        }
        coordinator.batch { coordinator.noteAnimProp("1", ANIM_STATES_PROP, mapOf("label" to "a")) }
        advanceTimeBy(1000)
        runCurrent()
        assertTrue(sink.completions.isEmpty())
    }

    @Test
    fun `states pose flips glide through the synthesized transition`() = runTest {
        val coordinator = AnimationCoordinator(AlwaysAnimate, backgroundScope)
        // The engine synthesizes a scoped `__anim.transition` for `.states`,
        // so a pose flip is an ordinary SetProp on the overridden props.
        coordinator.batch {
            coordinator.noteCreate(
                "1",
                mapOf(
                    ANIM_TRANSITION_PROP to transitionWire + mapOf("props" to listOf("translateY", "opacity")),
                    ANIM_STATES_PROP to mapOf("label" to "closed"),
                ),
            )
        }
        coordinator.batch {
            coordinator.noteSetProp("1", "translateY.0", 0.0)
            coordinator.noteAnimProp("1", ANIM_STATES_PROP, mapOf("label" to "open"))
        }
        assertNotNull(coordinator.consumePendingTransitions("1")["translateY.0"])
    }

    // ---------------------------------------------------------------- misc

    @Test
    fun `an unknown anim channel is ignored, not fatal`() = runTest {
        val coordinator = AnimationCoordinator(AlwaysAnimate, backgroundScope)
        coordinator.batch { coordinator.noteCreate("1", mapOf(ANIM_TRANSITION_PROP to transitionWire)) }
        coordinator.noteAnimProp("1", "__anim.unknownChannel", mapOf("x" to 1))
        assertNotNull(coordinator.specsFor("1")?.transition)
    }

    @Test
    fun `removing the transition channel stops future glides`() = runTest {
        val coordinator = AnimationCoordinator(AlwaysAnimate, backgroundScope)
        coordinator.batch { coordinator.noteCreate("1", mapOf(ANIM_TRANSITION_PROP to transitionWire)) }
        coordinator.batch { coordinator.noteAnimProp("1", ANIM_TRANSITION_PROP, null) }
        coordinator.batch { coordinator.noteSetProp("1", "opacity.0", 0.5) }
        assertTrue(coordinator.consumePendingTransitions("1").isEmpty())
    }

    @Test
    fun `reset drops in-flight exits without running their finalizers`() = runTest {
        val coordinator = AnimationCoordinator(AlwaysAnimate, backgroundScope)
        var finalized = false
        coordinator.batch { coordinator.noteCreate("1", mapOf(ANIM_EXIT_PROP to exitWire)) }
        coordinator.beginExit("1", setOf("1")) { finalized = true }
        coordinator.reset()

        advanceTimeBy(1000)
        runCurrent()
        assertFalse(finalized)
        assertFalse(coordinator.isExitingRoot("1"))
    }
}
