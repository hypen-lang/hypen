package space.hypen.renderer.virt

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.grid.LazyGridState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filterNotNull
import space.hypen.renderer.model.HypenElement
import space.hypen.renderer.render.ComposeRenderer
import kotlin.math.abs

/*
 * Compose glue for the `__virt.window` contract (docs/virtualization.md).
 * The math lives in Virtualization.kt (plain Kotlin, unit-tested); this file
 * only reads Compose layout state into it and sends what it decides.
 *
 * Two shapes:
 * - Lazy (List/Grid that scroll themselves, and a scrollable Column/Row whose
 *   sole child is a lazy ForEach): `total` slots, materialized rows or
 *   placeholders ([VirtSlots]), reporting from `layoutInfo` (§5).
 * - Padded (a windowed container that does not scroll itself, inside some
 *   ancestor scroller): leading/trailing padding stands in for the missing
 *   items, reporting from the element's clipped bounds in the root (§2/§3).
 */

/** The element's decoded `__virt.window`, or null. Reads snapshot state. */
fun HypenElement.virtWindow(): VirtWindow? = Virtualization.parse(props[VIRT_WINDOW_PROP])

/**
 * Per-list measured item extent (dp), fed by layout and read by
 * placeholders; the average of the materialized items (§2).
 */
class VirtMeasure {
    var totalDp: Double by mutableStateOf(0.0)
        private set
    var count: Int by mutableStateOf(0)
        private set

    fun itemSize(window: VirtWindow): Double = Virtualization.itemSize(window, totalDp, count)

    fun update(totalDp: Double, count: Int) {
        if (count <= 0 || totalDp <= 0) return
        // Ignore sub-dp jitter so padding does not oscillate on rounding.
        if (count == this.count && abs(totalDp / count - this.totalDp / this.count.coerceAtLeast(1)) < 0.5) return
        this.totalDp = totalDp
        this.count = count
    }
}

/** A stand-in for an unmaterialized item, [sizeDp] along the scroll axis. */
@Composable
fun VirtPlaceholder(sizeDp: Double, horizontal: Boolean) {
    val modifier = if (horizontal) {
        Modifier.width(sizeDp.dp)
    } else {
        Modifier.fillMaxWidth().height(sizeDp.dp)
    }
    Box(modifier = modifier)
}

/** One layout pass of a lazy container, as the reporters read it. */
private data class LazySample(val window: VirtWindow, val visible: ItemRange?, val measuredPx: Double, val measuredCount: Int)

private fun sample(window: VirtWindow?, slots: List<LaidOutSlot>, viewportStart: Int, viewportEnd: Int): LazySample? {
    if (window == null) return null
    val (sum, n) = Virtualization.measured(slots)
    return LazySample(window, Virtualization.visibleSlots(slots, viewportStart, viewportEnd, window.total), sum, n)
}

/**
 * Report a lazy container's viewport (§5): visible slots from its
 * `layoutInfo`, the average measured row extent into [measure], and §3's
 * report rules through a [ViewportTracker]. Runs per layout change, so at
 * most once per frame. State is only written in `collect`: the snapshotFlow
 * block runs in a read-only snapshot.
 */
@Composable
private fun VirtLazyReporter(
    element: HypenElement,
    stateKey: Any,
    measure: VirtMeasure,
    renderer: ComposeRenderer,
    read: () -> LazySample?,
) {
    val density = LocalDensity.current.density
    val tracker = remember(element.id) { ViewportTracker() }
    LaunchedEffect(element.id, stateKey) {
        snapshotFlow(read)
            .filterNotNull()
            .distinctUntilChanged()
            .collect { s ->
                measure.update(s.measuredPx / density, s.measuredCount)
                val visible = s.visible ?: return@collect
                tracker.next(s.window, visible)?.let { renderer.reportViewport(element.id, it.start, it.end) }
            }
    }
}

/** [VirtLazyReporter] for a `LazyColumn` / `LazyRow`. */
@Composable
fun VirtLazyListReporter(
    element: HypenElement,
    state: LazyListState,
    measure: VirtMeasure,
    renderer: ComposeRenderer,
) = VirtLazyReporter(element, state, measure, renderer) {
    val info = state.layoutInfo
    sample(
        element.virtWindow(),
        info.visibleItemsInfo.map { LaidOutSlot(it.index, it.offset, it.size, materialized = it.key is String) },
        info.viewportStartOffset,
        info.viewportEndOffset,
    )
}

/** [VirtLazyReporter] for a `LazyVerticalGrid`; a row's extent is its items' height. */
@Composable
fun VirtLazyGridReporter(
    element: HypenElement,
    state: LazyGridState,
    measure: VirtMeasure,
    renderer: ComposeRenderer,
) = VirtLazyReporter(element, state, measure, renderer) {
    val info = state.layoutInfo
    sample(
        element.virtWindow(),
        info.visibleItemsInfo.map { LaidOutSlot(it.index, it.offset.y, it.size.height, materialized = it.key is String) },
        info.viewportStartOffset,
        info.viewportEndOffset,
    )
}

/**
 * The padded shape: when [window] is non-null, pad the container's leading
 * and trailing edges for the items outside the window and report the
 * visible range from where the container sits inside whatever clips it (its
 * nearest scrolling ancestor, or the root). A no-op when [window] is null.
 *
 * Applied innermost (after the applicators), so the padding sits inside the
 * element's own background/border, like the DOM renderer's padding.
 */
@Composable
fun Modifier.virtPadded(
    element: HypenElement,
    window: VirtWindow?,
    renderer: ComposeRenderer,
    horizontal: Boolean = false,
    columns: Int = 1,
): Modifier {
    if (window == null) return this
    val density = LocalDensity.current
    val measure = remember(element.id) { VirtMeasure() }
    val tracker = remember(element.id) { ViewportTracker() }
    // Real row extent (measured average), and the possibly smaller size the
    // padding stands in with so a huge list stays measurable.
    val size = measure.itemSize(window)
    val padSize = Virtualization.paddedItemSize(window, size, columns)
    val pad = Virtualization.windowPadding(window, padSize, columns)
    val latestWindow by rememberUpdatedState(window)
    val latestSize by rememberUpdatedState(size)
    val latestPadSize by rememberUpdatedState(padSize)
    val latestPad by rememberUpdatedState(pad)

    val positioned = onGloballyPositioned { coords ->
        val w = latestWindow
        val px = density.density
        // Average materialized row extent: the content between the paddings.
        val extentPx = (if (horizontal) coords.size.width else coords.size.height).toDouble()
        val contentDp = extentPx / px - latestPad.leading - latestPad.trailing
        measure.update(contentDp, Virtualization.rowsInWindow(w, columns))

        val clipped = coords.boundsInRoot()
        if (clipped.width <= 0f || clipped.height <= 0f) return@onGloballyPositioned
        val origin = coords.positionInRoot()
        val listTop = (if (horizontal) origin.x else origin.y).toDouble()
        val viewTop = (if (horizontal) clipped.left else clipped.top).toDouble()
        val viewExtent = (if (horizontal) clipped.width else clipped.height).toDouble()
        val visible = tracker.visibleFromGeometry(
            w,
            padSize = latestPadSize * px,
            rowSize = latestSize * px,
            listTop = listTop,
            viewportTop = viewTop,
            viewportExtent = viewExtent,
            columns = columns,
        )
        tracker.next(w, visible)?.let { renderer.reportViewport(element.id, it.start, it.end) }
    }
    val padding = if (horizontal) {
        Modifier.padding(start = pad.leading.dp, end = pad.trailing.dp)
    } else {
        Modifier.padding(top = pad.leading.dp, bottom = pad.trailing.dp)
    }
    return this.then(positioned).then(padding)
}
