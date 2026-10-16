package space.hypen.renderer

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.junit4.ComposeContentTestRule
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import space.hypen.renderer.components.LocalParentAllowsHorizontalExpansion
import space.hypen.renderer.model.Patch
import space.hypen.renderer.render.ComposeRenderer
import space.hypen.renderer.render.LocalComposeRenderer

/*
 * Shared harness for the Compose UI tests (Robolectric + createComposeRule):
 * mount a [ComposeRenderer] the way `HypenApp` does once connected, feed it
 * patch batches, and read semantics back.
 */

const val LOADING_TEXT = "loading…"

/** Viewport-report sink standing in for the engine (`RemoteEngine.setListViewport`). */
class FakeViewportEngine {
    data class Report(val listId: String, val start: Int, val end: Int)

    val reports = mutableListOf<Report>()

    fun attach(renderer: ComposeRenderer) = renderer.setViewportReporter { id, s, e -> reports += Report(id, s, e) }
}

/**
 * Render [renderer]'s root in a [size] host with the locals `HypenApp`
 * provides, through the same [HypenRoot] the connected app uses.
 */
fun ComposeContentTestRule.setHypenContent(
    renderer: ComposeRenderer,
    size: DpSize = DpSize(360.dp, 640.dp),
) {
    setContent {
        CompositionLocalProvider(
            LocalComposeRenderer provides renderer,
            LocalParentAllowsHorizontalExpansion provides true,
            LocalHypenViewport provides size,
        ) {
            Box(Modifier.size(size)) {
                HypenRoot(renderer) { Text(LOADING_TEXT) }
            }
        }
    }
}

/** Apply one patch batch on the UI thread and let composition, layout and effects settle. */
fun ComposeContentTestRule.apply(renderer: ComposeRenderer, patches: List<Patch>) {
    runOnIdle { renderer.applyPatches(patches) }
    waitForIdle()
}

fun virtWindow(total: Int, start: Int, end: Int): Map<String, Any?> =
    mapOf("total" to total.toDouble(), "start" to start.toDouble(), "end" to end.toDouble())

/** A `Text("row i")` row of [height] dp, id `r<i>`. */
fun row(i: Int, height: Double = 50.0): Patch = Patch.create("r$i", "Text", mapOf("0" to "row $i", "height.0" to height))

/** Create rows [range] and insert them, in order, into [parentId]. */
fun rows(parentId: String, range: IntRange, height: Double = 50.0): List<Patch> =
    range.map { row(it, height) } + range.map { Patch.insert(parentId, "r$it") }

fun hasCollectionInfo(rowCount: Int, columnCount: Int = 1) =
    SemanticsMatcher("CollectionInfo($rowCount x $columnCount)") {
        val info = it.config.getOrNull(SemanticsProperties.CollectionInfo)
        info != null && info.rowCount == rowCount && info.columnCount == columnCount
    }

fun hasCollectionItemRow(rowIndex: Int) =
    SemanticsMatcher("CollectionItemInfo(row $rowIndex)") {
        it.config.getOrNull(SemanticsProperties.CollectionItemInfo)?.rowIndex == rowIndex
    }

fun SemanticsNodeInteraction.positionInRoot(): Offset = fetchSemanticsNode().positionInRoot

fun SemanticsNodeInteraction.heightDp(density: Float): Dp = (fetchSemanticsNode().size.height / density).dp
