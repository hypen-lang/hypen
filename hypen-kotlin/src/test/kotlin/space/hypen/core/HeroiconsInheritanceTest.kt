package space.hypen.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * End-to-end integration test proving that a heroicons-style SVG — where all
 * presentation attributes (`stroke`, `stroke-width`, `fill`) live on the root
 * `<svg>` element and the `<path>` child is bare — round-trips correctly
 * through `engine.registerResources(...)` and the Rust engine's `parse_svg`
 * SVG inheritance logic, producing an Icon Create patch whose first
 * `__iconPaths` entry carries `strokeWidth == 1.5`, `stroke == "currentColor"`,
 * and `fill == "none"`.
 */
class HeroiconsInheritanceTest {

    private val heartSvg =
        "<svg xmlns=\"http://www.w3.org/2000/svg\" fill=\"none\" viewBox=\"0 0 24 24\" " +
            "stroke-width=\"1.5\" stroke=\"currentColor\">" +
            "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" " +
            "d=\"M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733" +
            "-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12Z\"/>" +
            "</svg>"

    @Test
    fun `heroicons style svg inherits root presentation attributes via registerResources`() {
        // Skip gracefully if the UniFFI native library isn't available in this env
        assumeTrue(NativeEngine.isAvailable(), "Native Hypen engine library not available")

        NativeEngine().use { engine ->
            // The renderer needs the Icon primitive registered so the engine emits
            // an Icon element (rather than flagging it as an unknown component).
            engine.registerDefaultPrimitives()

            // Register a heroicons-style SVG keyed by "heart". Presentation attrs
            // (fill, stroke, stroke-width) live ONLY on the <svg> root — the inner
            // <path> has no stroke/fill/stroke-width and must inherit them.
            val resourcesJson = buildJsonObject { put("heart", heartSvg) }.toString()
            engine.registerResources(resourcesJson)

            // Drive a render of a single Icon referencing the resource.
            val patches = engine.renderSource("Icon(@resources.heart)")

            // Find the Icon create patch.
            val iconCreate = patches.firstOrNull { p ->
                p.type == PatchType.CREATE && p.elementType == "Icon"
            }
            assertNotNull(iconCreate, "expected a Create patch for an Icon element; got patches=$patches")

            val props = iconCreate.props
            assertNotNull(props, "Icon create patch must carry props; got $iconCreate")

            // __iconPaths is a JSON array of parsed path objects emitted by the Rust parse_svg.
            val iconPathsElement = props["__iconPaths"]
            assertNotNull(iconPathsElement, "Icon props must contain __iconPaths; props keys=${props.keys}")
            val iconPaths = (iconPathsElement as? JsonArray) ?: iconPathsElement.jsonArray
            assertTrue(iconPaths.isNotEmpty(), "__iconPaths must be non-empty")

            val firstPath: JsonObject = iconPaths[0].jsonObject

            // stroke-width on <svg> root was "1.5"; the bare <path> must inherit it.
            val strokeWidth = firstPath["strokeWidth"]?.jsonPrimitive?.doubleOrNull
            assertNotNull(strokeWidth, "first path must have a numeric strokeWidth; path=$firstPath")
            assertEquals(1.5, strokeWidth, 0.0001, "inherited strokeWidth must equal root value 1.5")

            // stroke="currentColor" on <svg> root must be inherited by the <path>.
            val stroke = firstPath["stroke"]?.jsonPrimitive?.content
            assertEquals("currentColor", stroke, "inherited stroke must equal root value")

            // fill="none" on <svg> root must be inherited by the <path>.
            val fill = firstPath["fill"]?.jsonPrimitive?.content
            assertEquals("none", fill, "inherited fill must equal root value")

            // The path `d` content must round-trip through the engine unchanged.
            val d = firstPath["d"]?.jsonPrimitive?.content
            assertNotNull(d, "first path must have a `d` string")
            assertTrue(d.startsWith("M21 8.25"), "`d` must round-trip; got: $d")
        }
    }
}
