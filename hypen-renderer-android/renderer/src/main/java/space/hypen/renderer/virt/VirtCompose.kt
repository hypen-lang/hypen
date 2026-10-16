package space.hypen.renderer.virt

import androidx.compose.foundation.gestures.ScrollableState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.grid.LazyGridState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.compositionLocalOf
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
import androidx.compose.ui.semantics.CollectionInfo
import androidx.compose.ui.semantics.CollectionItemInfo
import androidx.compose.ui.semantics.collectionInfo
import androidx.compose.ui.semantics.collectionItemInfo
import androidx.compose.ui.semantics.semantics
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
fun HypenElement.virtWindow(): VirtWindow? = Virtualization.parseVirtWindow(props[VIRT_WINDOW_PROP])

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

/**
 * The nearest ancestor scroller on each axis. The padded path scrolls it to
 * keep its first visible row still when the window or the padding changes
 * (scroll anchoring, §2). Every scrolling container a windowed list can sit
 * in provides itself here ([ProvideVirtScroller]): a scrollable Column / Row
 * its `ScrollState`, the List / Grid lazy containers their lazy state.
 */
data class VirtScrollers(val vertical: ScrollableState? = null, val horizontal: ScrollableState? = null) {
    fun along(horizontal: Boolean): ScrollableState? = if (horizontal) this.horizontal else vertical
}

val LocalVirtScrollers = compositionLocalOf { VirtScrollers() }

/**
 * Make [state] the nearest scroller along its axis for [content]; `null`
 * (the container does not scroll) leaves the ancestors' in place. Always
 * call it, scrolling or not, so toggling scrolling keeps the content's
 * composition.
 */
@Composable
fun ProvideVirtScroller(state: ScrollableState?, horizontal: Boolean, content: @Composable () -> Unit) {
    val current = LocalVirtScrollers.current
    val next = when {
        state == null -> current
        horizontal -> current.copy(horizontal = state)
        else -> current.copy(vertical = state)
    }
    CompositionLocalProvider(LocalVirtScrollers provides next, content = content)
}

/**
 * The whole list's size for accessibility (§2): TalkBack announces "n
 * items" from the container's `collectionInfo` and each row's position from
 * its `collectionItemInfo` ([VirtItem]).
 *
 * On a lazy container this must sit in the `modifier` passed to it: Compose
 * (ui 1.7) applies a node's semantics modifiers innermost first, so this
 * outer one overrides the lazy layout's own `collectionInfo` (which says
 * `-1`, unknown, along the scroll axis).
 */
fun Modifier.virtCollectionInfo(window: VirtWindow, horizontal: Boolean, columns: Int = 1): Modifier {
    val shape = Virtualization.collectionShape(window, horizontal, columns)
    return this.semantics { collectionInfo = CollectionInfo(rowCount = shape.rowCount, columnCount = shape.columnCount) }
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

/**
 * A materialized item's slot in a lazy container. Layout-transparent (the
 * content gets the slot's constraints unchanged); exposes the item's
 * whole-list position to accessibility (§2), so TalkBack counts from the
 * list's start rather than the window's. [columns] > 1 is a grid.
 */
@Composable
fun VirtItem(index: Int, horizontal: Boolean, columns: Int = 1, content: @Composable () -> Unit) {
    Box(modifier = Modifier.virtItemInfo(Virtualization.itemPosition(index, horizontal, columns)), propagateMinConstraints = true) {
        content()
    }
}

/** `collectionItemInfo` for one item's whole-list cell. */
fun Modifier.virtItemInfo(position: ItemPosition): Modifier = this.semantics {
    collectionItemInfo = CollectionItemInfo(
        rowIndex = position.rowIndex,
        rowSpan = 1,
        columnIndex = position.columnIndex,
        columnSpan = 1,
    )
}

/**
 * Padded-path rows' whole-list cells, by child node id
 * ([Virtualization.childPositions]). A padded container provides it around
 * its children ([ProvideVirtItemPositions]); `HypenElement` adds
 * [virtItemInfo] to its own modifier when its id is listed, so the row needs
 * no wrapper and its layout (weights, scopes) is untouched. Ids of deeper
 * descendants are never listed, so they are unaffected.
 */
val LocalVirtItemPositions = compositionLocalOf<Map<String, ItemPosition>?> { null }

/** Provide the padded rows' positions for [window] (a no-op when null). */
@Composable
fun ProvideVirtItemPositions(
    window: VirtWindow?,
    children: List<HypenElement>,
    horizontal: Boolean,
    columns: Int = 1,
    content: @Composable () -> Unit,
) {
    val positions = window?.let { Virtualization.childPositions(it, children, horizontal, columns) { c -> c.id } }
    CompositionLocalProvider(LocalVirtItemPositions provides positions, content = content)
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

    // Scroll anchoring (§2): when the window or the padding changes, scroll
    // the nearest scroller along our axis by however far the first visible
    // row moved ([Virtualization.anchorDelta], from the geometry of the last
    // layout). Runs after the composition that changed the padding and
    // before its layout, so the row never shows at the shifted position.
    val scroller = LocalVirtScrollers.current.along(horizontal)
    val anchor = remember(element.id) { PaddedAnchor() }
    val layout = PaddedLayout(window, padSize)
    SideEffect {
        val before = anchor.layout
        anchor.layout = layout
        val geometry = anchor.geometry
        if (before == null || before == layout || geometry == null || scroller == null) return@SideEffect
        val deltaDp = Virtualization.anchorDelta(before, layout, size, geometry)
        val deltaPx = (deltaDp * density.density).toFloat()
        if (abs(deltaPx) < 0.5f) return@SideEffect
        // A scroller clamps to its last measured range; a larger padding
        // may need more than that. The rest goes in after the next layout.
        anchor.pendingPx = deltaPx - scroller.dispatchRawDelta(deltaPx)
    }

    val positioned = onGloballyPositioned { coords ->
        val w = latestWindow
        val px = density.density
        // Average materialized row extent: the content between the paddings.
        val extentPx = (if (horizontal) coords.size.width else coords.size.height).toDouble()
        val contentDp = extentPx / px - latestPad.leading - latestPad.trailing
        measure.update(contentDp, Virtualization.windowRows(w, columns))

        if (abs(anchor.pendingPx) >= 0.5f && scroller != null) {
            val rest = anchor.pendingPx
            anchor.pendingPx = 0f
            scroller.dispatchRawDelta(rest)
        } else {
            anchor.pendingPx = 0f
        }

        val clipped = coords.boundsInRoot()
        if (clipped.width <= 0f || clipped.height <= 0f) {
            anchor.geometry = null
            return@onGloballyPositioned
        }
        val origin = coords.positionInRoot()
        val listTop = (if (horizontal) origin.x else origin.y).toDouble()
        val viewTop = (if (horizontal) clipped.left else clipped.top).toDouble()
        val viewExtent = (if (horizontal) clipped.width else clipped.height).toDouble()
        // One geometry (dp) for both the report and the next anchoring, so
        // they agree on which part of the list is on screen (§3 step 2).
        val geometry = ViewportGeometry(
            size = latestSize,
            scrolledPast = (viewTop - listTop) / px,
            viewportExtent = viewExtent / px,
            columns = columns,
        )
        anchor.geometry = geometry
        val visible = Virtualization.paddedVisibleRange(w, latestPadSize, latestSize, geometry)
        tracker.next(w, visible)?.let { renderer.reportViewport(element.id, it.start, it.end) }
    }
    val padding = if (horizontal) {
        Modifier.padding(start = pad.leading.dp, end = pad.trailing.dp)
    } else {
        Modifier.padding(top = pad.leading.dp, bottom = pad.trailing.dp)
    }
    return this.then(positioned).virtCollectionInfo(window, horizontal, columns).then(padding)
}

/**
 * Padded-path anchoring state, written only on the main thread (in
 * `SideEffect` and `onGloballyPositioned`): the layout last composed and
 * where the list sat in its scroller at the last layout (dp).
 */
private class PaddedAnchor {
    var layout: PaddedLayout? = null
    var geometry: ViewportGeometry? = null
    var pendingPx: Float = 0f
}

/**
 * Pick between a container's lazy shape and its padded shape from the
 * constraints it is actually measured with, not from the element tree: a
 * lazy container (`LazyColumn` / `LazyRow` / `LazyVerticalGrid`) cannot
 * measure under an unbounded main axis — it sits inside an ancestor scroller
 * along that axis (a scrollable Column holding a `.scrollable(true)` List)
 * and has no fixed size of its own — so it lays out padded there and scrolls
 * with the ancestor (§2), and lazily everywhere else.
 *
 * [modifier] (the element's applicators) goes on a wrapping box that
 * propagates its min constraints, so the inner container is sized exactly as
 * it was when it carried [modifier] itself; [content] gets whether the main
 * axis is bounded and lays out its container with a plain modifier.
 */
@Composable
fun LazyOrPadded(
    horizontal: Boolean,
    modifier: Modifier,
    content: @Composable (bounded: Boolean) -> Unit,
) {
    BoxWithConstraints(modifier = modifier, propagateMinConstraints = true) {
        content(if (horizontal) constraints.hasBoundedWidth else constraints.hasBoundedHeight)
    }
}

/**
 * True while a windowed container that would scroll itself renders padded
 * because its main axis is unbounded ([LazyOrPadded]): the Column / Row
 * handler must not add its own scroll modifier there (it would hit the same
 * unbounded constraint). Read once by the handler and reset for its children.
 */
val LocalSuppressOwnScroll = compositionLocalOf { false }
