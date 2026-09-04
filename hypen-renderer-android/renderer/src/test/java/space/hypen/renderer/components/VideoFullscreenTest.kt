package space.hypen.renderer.components

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Renderer-local fullscreen intent — the pure half of `VideoFullscreen.kt`.
 *
 * Contract: `hypen-docs/content/docs/guide/components.mdx`
 * §"Fullscreen: `videoIntent("fullscreen")` (renderer-local)". Parity
 * reference: the DOM handler in
 * `hypen-web/packages/web/src/dom/applicators/events.ts`, which accepts a
 * string equal to `"fullscreen"` and bails on anything else, and which does
 * nothing when the node has no Video wrapper above it.
 */
class VideoFullscreenTest {

    // ── Intent parsing ─────────────────────────────────────────────────────

    @Test
    fun `the fullscreen wire name parses`() {
        assertEquals(VideoIntent.FULLSCREEN, videoIntentOf("fullscreen"))
    }

    @Test
    fun `parsing is exact, matching the DOM string compare`() {
        // The DOM does `intent !== "fullscreen"` — no trimming, no casing.
        assertNull(videoIntentOf("Fullscreen"))
        assertNull(videoIntentOf("FULLSCREEN"))
        assertNull(videoIntentOf(" fullscreen"))
    }

    @Test
    fun `non-strings and unknown intents are not intents`() {
        assertNull(videoIntentOf(null))
        assertNull(videoIntentOf(42))
        assertNull(videoIntentOf(true))
        assertNull(videoIntentOf(listOf("fullscreen")))
        // Unknown intents are inert, not errors: the doc promises the prop
        // can be authored everywhere today.
        assertNull(videoIntentOf("pip"))
        assertNull(videoIntentOf(""))
    }

    // ── Prop lookup ────────────────────────────────────────────────────────

    @Test
    fun `the applicator wire form is read`() {
        // `.videoIntent("fullscreen")` lowers to `videoIntent.0`.
        assertEquals("fullscreen", videoIntentProp(mapOf("videoIntent.0" to "fullscreen")))
    }

    @Test
    fun `the bare prop form is read`() {
        assertEquals("fullscreen", videoIntentProp(mapOf("videoIntent" to "fullscreen")))
    }

    @Test
    fun `the applicator form wins over the bare form`() {
        val props = mapOf("videoIntent.0" to "fullscreen", "videoIntent" to "pip")
        assertEquals("fullscreen", videoIntentProp(props))
    }

    @Test
    fun `an element without the prop has no intent`() {
        assertNull(videoIntentProp(mapOf("slot.0" to "controls")))
        assertNull(videoIntentOf(videoIntentProp(emptyMap())))
    }

    // ── Toggle state machine ───────────────────────────────────────────────

    @Test
    fun `the intent toggles fullscreen on and back off`() {
        // The same button is the way in and the way out (the doc's example
        // ships exactly one fullscreen control).
        val entered = applyVideoIntent(current = false, intent = VideoIntent.FULLSCREEN, insideVideo = true)
        assertTrue(entered)
        val left = applyVideoIntent(current = entered, intent = VideoIntent.FULLSCREEN, insideVideo = true)
        assertFalse(left)
    }

    @Test
    fun `the intent is inert outside a Video subtree`() {
        // No enclosing Video means no container to fullscreen — the DOM
        // walks up for the video wrapper and returns when it finds none.
        assertFalse(applyVideoIntent(current = false, intent = VideoIntent.FULLSCREEN, insideVideo = false))
        assertTrue(applyVideoIntent(current = true, intent = VideoIntent.FULLSCREEN, insideVideo = false))
    }

    @Test
    fun `an absent intent never changes the presentation`() {
        assertFalse(applyVideoIntent(current = false, intent = null, insideVideo = true))
        assertTrue(applyVideoIntent(current = true, intent = null, insideVideo = true))
    }

    // ── Companion action ───────────────────────────────────────────────────
    // "An `.onClick` wired alongside still dispatches normally" (contract).
    // The intent's own clickable is the innermost handler, so it is the one
    // that must dispatch that action.

    @Test
    fun `a plain onClick alongside the intent is dispatched`() {
        val action = videoIntentCompanionAction(
            mapOf("videoIntent.0" to "fullscreen", "onClick.0" to "@actions.tracked"),
        )
        assertEquals("tracked", action?.actionName)
        assertEquals(emptyMap<String, Any?>(), action?.payload)
    }

    @Test
    fun `the grouped object form keeps its payload`() {
        // Same shape the applicator registry hands OnClickApplicator.
        val action = videoIntentCompanionAction(
            mapOf(
                "videoIntent.0" to "fullscreen",
                "onClick.0" to "@actions.tracked",
                "onClick.id" to 7,
            ),
        )
        assertEquals("tracked", action?.actionName)
        assertEquals(mapOf<String, Any?>("id" to 7), action?.payload)
    }

    @Test
    fun `the positional Button action is dispatched too`() {
        // `Button("@actions.x").videoIntent("fullscreen")` — ButtonComponent
        // stands its own clickable down, so this is the only dispatcher.
        assertEquals(
            "open",
            videoIntentCompanionAction(mapOf("action" to "@actions.open"))?.actionName,
        )
        assertEquals(
            "open",
            videoIntentCompanionAction(mapOf("action.0" to "@actions.open"))?.actionName,
        )
    }

    @Test
    fun `onClick wins over onPress and the positional action`() {
        val action = videoIntentCompanionAction(
            mapOf(
                "onClick.0" to "@actions.clicked",
                "onPress.0" to "@actions.pressed",
                "action" to "@actions.positional",
            ),
        )
        assertEquals("clicked", action?.actionName)
    }

    @Test
    fun `an intent node with no action dispatches nothing`() {
        assertNull(videoIntentCompanionAction(mapOf("videoIntent.0" to "fullscreen")))
        // Non-action junk under the name is not an action either.
        assertNull(videoIntentCompanionAction(mapOf("onClick.0" to "not an action ref")))
    }

    @Test
    fun `unrelated props with a shared prefix are not mistaken for the action`() {
        // `onClickAway` starts with "onClick" but is a different applicator.
        assertNull(videoIntentCompanionAction(mapOf("onClickAway.0" to "@actions.away")))
    }

    @Test
    fun `toggling is a closed cycle`() {
        // Presentation-only: no accumulating state, N taps land on N % 2.
        var fullscreen = false
        repeat(5) {
            fullscreen = applyVideoIntent(fullscreen, VideoIntent.FULLSCREEN, insideVideo = true)
        }
        assertTrue(fullscreen)
        fullscreen = applyVideoIntent(fullscreen, VideoIntent.FULLSCREEN, insideVideo = true)
        assertFalse(fullscreen)
    }
}
