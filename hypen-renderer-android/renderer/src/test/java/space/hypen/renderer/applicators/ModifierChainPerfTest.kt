package space.hypen.renderer.applicators

import androidx.compose.ui.Modifier
import org.junit.Assume.assumeTrue
import org.junit.Test
import space.hypen.renderer.model.HypenElement

/**
 * Manual measurement for audit finding Android #6: an animated element
 * regenerates its applicator modifier chain every frame (`setAnimatedOverride`
 * bumps the props revision, `HypenApp` recomputes `applyAllWithVariants`).
 * This times one such recompute for a richly styled node. Run with
 * `HYPEN_PERF=1 ./gradlew :renderer:testDebugUnitTest --tests '*ModifierChainPerfTest*'`
 * (stop the daemon first so it inherits the variable).
 */
class ModifierChainPerfTest {
    private fun element(props: Map<String, Any?>) = HypenElement(id = "card", elementType = "column", props = props)

    private fun timeIt(label: String, runs: Int, body: () -> Unit) {
        repeat(200) { body() }
        val samples = LongArray(runs) {
            val t = System.nanoTime()
            body()
            System.nanoTime() - t
        }
        samples.sort()
        val median = samples[runs / 2] / 1000.0
        val p95 = samples[(runs * 95 / 100).coerceAtMost(runs - 1)] / 1000.0
        println("[perf] $label: median %.1f µs  p95 %.1f µs  ($runs runs)".format(median, p95))
    }

    @Test
    fun `modifier chain rebuild cost per frame`() {
        assumeTrue(System.getenv("HYPEN_PERF") != null)
        val registry = createDefaultApplicatorRegistry() as DefaultApplicatorRegistry

        val simple = element(
            mapOf(
                "padding.0" to 16.0,
                "backgroundColor.0" to "#1e293b",
                "borderRadius.0" to 12.0,
                "opacity.0" to 0.8,
            ),
        )
        val complex = element(
            mapOf(
                "padding.0" to 16.0,
                "margin.0" to 8.0,
                "width.0" to 320.0,
                "height.0" to 180.0,
                "backgroundColor.0" to "#1e293b",
                "borderRadius.0" to 12.0,
                "border.0" to 1.0,
                "borderColor.0" to "#334155",
                "shadow.0" to 8.0,
                "opacity.0" to 0.8,
                "translateX.0" to 12.0,
                "translateY.0" to -4.0,
                "scale.0" to 1.05,
                "rotate.0" to 2.0,
                "linearGradient.0" to "to right, #0ea5e9, #6366f1",
                "clipToBounds.0" to true,
                "alignment.0" to "center",
                "gap.0" to 8.0,
            ),
        )
        val withVariants = element(
            complex.props + mapOf(
                "backgroundColor:hover.0" to "#334155",
                "opacity@md.0" to 1.0,
                "padding@lg.0" to 24.0,
            ),
        )

        for ((label, el) in listOf("4 props" to simple, "18 props" to complex, "18 props + 3 variants" to withVariants)) {
            val ctx = ApplicatorContext(element = el, actionDispatcher = null)
            timeIt("applyAllWithVariants, $label", 2000) {
                registry.applyAllWithVariants(Modifier, el, ctx)
            }
        }
        // The per-frame path on top: one animated override write, which copies
        // the override map and bumps the revision before the chain rebuilds.
        timeIt("setAnimatedOverride (one glide step)", 2000) {
            complex.setAnimatedOverride("opacity.0", 0.5)
        }
    }
}
