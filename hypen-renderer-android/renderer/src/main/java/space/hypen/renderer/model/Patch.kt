package space.hypen.renderer.model

import com.squareup.moshi.Json
import com.squareup.moshi.JsonClass

/**
 * Represents the type of patch operation.
 */
enum class PatchType {
    @Json(name = "create")
    CREATE,

    @Json(name = "setProp")
    SET_PROP,

    @Json(name = "removeProp")
    REMOVE_PROP,

    @Json(name = "setText")
    SET_TEXT,

    @Json(name = "insert")
    INSERT,

    @Json(name = "move")
    MOVE,

    @Json(name = "remove")
    REMOVE,

    @Json(name = "attachEvent")
    ATTACH_EVENT,

    @Json(name = "detachEvent")
    DETACH_EVENT,

    /**
     * Unlink a subtree from its parent without destroying it. The
     * renderer keeps the element and its descendants alive under
     * the same id; a subsequent ATTACH reinserts them, an optional
     * REMOVE tears them down normally.
     *
     * Used by the engine's Router subtree cache to preserve
     * off-screen routes between navigations.
     */
    @Json(name = "detach")
    DETACH,

    /**
     * Reattach a previously-detached subtree to a parent.
     * `id` must still be in the renderer's element map.
     */
    @Json(name = "attach")
    ATTACH,

    /**
     * Replace an element's accessibility semantics after a reactive change
     * (templated accessible name, bound self-state, bound checked, reactive
     * activedescendant). Carries the complete re-resolved block in
     * [Patch.semantics]; the renderer re-applies it with the same
     * translation it runs at create. A null block clears the semantics.
     */
    @Json(name = "setSemantics")
    SET_SEMANTICS,

    /**
     * Animation transaction prelude: a batch-wide animation spec
     * ([Patch.spec]) that applies to every whitelisted prop the batch
     * writes, on any element.
     *
     * Honored at batch index 0 ONLY (protocol invariant 3,
     * "first-patch-only preludes") — a prelude anywhere else, or inside a
     * replayed initialTree, is not a stamp. Consumed by
     * `AnimationCoordinator.beginBatch`; see
     * `.notes/ANIMATION_ANDROID.md` ("`batchAnimation` — the
     * transaction prelude").
     */
    @Json(name = "batchAnimation")
    BATCH_ANIMATION,
}

/**
 * Represents a patch operation from the Hypen engine.
 * Patches are atomic UI updates that describe how to modify the render tree.
 */
@JsonClass(generateAdapter = true)
data class Patch(
    val type: PatchType,
    val id: String? = null,
    val elementType: String? = null,
    val props: Map<String, Any?>? = null,
    val name: String? = null,
    val value: Any? = null,
    val text: String? = null,
    val parentId: String? = null,
    val beforeId: String? = null,
    val eventName: String? = null,
    /**
     * Engine-derived accessibility semantics block (camelCase JSON object —
     * role/name/state/hidden/…, same shape as the web wire format). Present
     * on CREATE for elements with derivable a11y and on every SET_SEMANTICS.
     */
    val semantics: Map<String, Any?>? = null,
    /**
     * Set on a REMOVE whose subtree root carried an `__anim.exit` spec:
     * the renderer owns the corpse and may defer teardown to play the
     * exit (protocol invariant 2, "renderers own corpses"). Only the
     * flagged root carries it; descendants arrive as plain removes.
     *
     * The wire omits the key entirely when false (`serde` skip-if-false),
     * hence the `false` default. Honoured by `ComposeRenderer.onRemove` —
     * see `.notes/ANIMATION_ANDROID.md`.
     */
    val transition: Boolean = false,
    /**
     * Animation spec carried by a [PatchType.BATCH_ANIMATION] prelude
     * (`{duration, curve, delay, props}`). Null on every other patch type.
     */
    val spec: Map<String, Any?>? = null,
) {
    companion object {
        /**
         * Create a CREATE patch for a new element.
         */
        fun create(
            id: String,
            elementType: String,
            props: Map<String, Any?> = emptyMap(),
        ) = Patch(
            type = PatchType.CREATE,
            id = id,
            elementType = elementType,
            props = props,
        )

        /**
         * Create a SET_PROP patch to update a property.
         */
        fun setProp(
            id: String,
            name: String,
            value: Any?,
        ) = Patch(
            type = PatchType.SET_PROP,
            id = id,
            name = name,
            value = value,
        )

        /**
         * Create a REMOVE_PROP patch to remove a property.
         */
        fun removeProp(
            id: String,
            name: String,
        ) = Patch(
            type = PatchType.REMOVE_PROP,
            id = id,
            name = name,
        )

        /**
         * Create a SET_TEXT patch to update text content.
         */
        fun setText(
            id: String,
            text: String,
        ) = Patch(
            type = PatchType.SET_TEXT,
            id = id,
            text = text,
        )

        /**
         * Create an INSERT patch to add an element to the tree.
         */
        fun insert(
            parentId: String,
            id: String,
            beforeId: String? = null,
        ) = Patch(
            type = PatchType.INSERT,
            parentId = parentId,
            id = id,
            beforeId = beforeId,
        )

        /**
         * Create a MOVE patch to reposition an element.
         */
        fun move(
            parentId: String,
            id: String,
            beforeId: String? = null,
        ) = Patch(
            type = PatchType.MOVE,
            parentId = parentId,
            id = id,
            beforeId = beforeId,
        )

        /**
         * Create a REMOVE patch to delete an element.
         *
         * [transition] flags the root of a subtree carrying an
         * `__anim.exit` spec (see [Patch.transition]).
         */
        fun remove(
            id: String,
            transition: Boolean = false,
        ) = Patch(
            type = PatchType.REMOVE,
            id = id,
            transition = transition,
        )

        /**
         * Create a BATCH_ANIMATION prelude carrying a batch-wide
         * animation spec.
         */
        fun batchAnimation(spec: Map<String, Any?>?) =
            Patch(
                type = PatchType.BATCH_ANIMATION,
                spec = spec,
            )

        /**
         * Create an ATTACH_EVENT patch.
         */
        fun attachEvent(
            id: String,
            eventName: String,
        ) = Patch(
            type = PatchType.ATTACH_EVENT,
            id = id,
            eventName = eventName,
        )

        /**
         * Create a DETACH_EVENT patch.
         */
        fun detachEvent(
            id: String,
            eventName: String,
        ) = Patch(
            type = PatchType.DETACH_EVENT,
            id = id,
            eventName = eventName,
        )

        /**
         * Create a SET_SEMANTICS patch replacing an element's semantics.
         */
        fun setSemantics(
            id: String,
            semantics: Map<String, Any?>?,
        ) = Patch(
            type = PatchType.SET_SEMANTICS,
            id = id,
            semantics = semantics,
        )

        /**
         * Create a DETACH patch to unlink a subtree without destroying it.
         */
        fun detach(id: String) =
            Patch(
                type = PatchType.DETACH,
                id = id,
            )

        /**
         * Create an ATTACH patch to reinsert a previously-detached subtree.
         */
        fun attach(
            parentId: String,
            id: String,
            beforeId: String? = null,
        ) = Patch(
            type = PatchType.ATTACH,
            parentId = parentId,
            id = id,
            beforeId = beforeId,
        )
    }
}
