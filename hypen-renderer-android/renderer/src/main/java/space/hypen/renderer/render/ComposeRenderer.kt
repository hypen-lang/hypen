package space.hypen.renderer.render

import androidx.compose.runtime.*
import space.hypen.renderer.HypenLoggers
import space.hypen.renderer.anim.ANIM_PROP_PREFIX
import space.hypen.renderer.anim.AnimationCompletion
import space.hypen.renderer.anim.AnimationCompletionSink
import space.hypen.renderer.anim.AnimationCoordinator
import space.hypen.renderer.anim.animationCompleteAction
import space.hypen.renderer.applicators.ApplicatorContext
import space.hypen.renderer.applicators.ApplicatorRegistry
import space.hypen.renderer.applicators.createDefaultApplicatorRegistry
import space.hypen.renderer.components.ComponentRegistry
import space.hypen.renderer.components.createDefaultComponentRegistry
import space.hypen.renderer.model.HypenElement
import space.hypen.renderer.model.Patch
import space.hypen.renderer.model.PatchType
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

private val log = HypenLoggers.renderer

/**
 * Renderer that builds a Compose UI tree from Hypen patches.
 */
class ComposeRenderer(
    private val componentRegistry: ComponentRegistry = createDefaultComponentRegistry(),
    private val applicatorRegistry: ApplicatorRegistry = createDefaultApplicatorRegistry(),
    /**
     * Owns every `__anim.*` decision (see [AnimationCoordinator]). Injectable
     * so hosts can supply a live reduced-motion preference and tests can
     * supply a deterministic scheduler.
     */
    private val animation: AnimationCoordinator = AnimationCoordinator(),
) : Renderer {
    init {
        // Naturally-settled playbacks dispatch the element's
        // `.onAnimationComplete` action through the renderer's own action
        // channel, ungated: an exit completion by definition fires from
        // inside an exiting subtree.
        animation.setCompletionSink(
            AnimationCompletionSink { id, completion -> dispatchCompletion(id, completion) },
        )
    }

    // Lock for synchronizing access to elements and rootId across threads
    private val lock = Any()

    // Element storage — guarded by [lock]. Contains both attached
    // elements (reachable from [rootId] via children) and detached
    // elements (unlinked by a DETACH patch, kept alive here until
    // ATTACH or REMOVE arrives).
    private val elements = mutableMapOf<String, HypenElement>()

    // IDs that have been DETACH-ed but not yet ATTACH-ed or REMOVE-d.
    // Exposed via [getDetachedIds] so a Strategy 3 upgrade (limbo
    // container) can render them invisibly to preserve Compose
    // `remember`, `rememberScrollState`, focus, and animation state
    // across the detach → attach cycle.
    private val detachedIds = mutableSetOf<String>()

    // Animation transaction prelude for the batch currently being applied
    // (null when the batch carried no prelude). Guarded by [lock].
    //
    // Set from batch index 0 ONLY — protocol invariant 3,
    // "first-patch-only preludes": a `batchAnimation` patch at any other
    // index, or inside a replayed initialTree, is not a stamp. Each batch
    // overwrites this (with null when unstamped), which is the protocol's
    // "clear at flush" — the value must outlive `applyPatches` because the
    // consumer is composition, which runs after this returns.
    private var batchAnimationSpec: Map<String, Any?>? = null

    // Snapshot-backed so composables reading [getRootId] recompose when
    // the root changes; per-element updates flow through each element's
    // own snapshot state instead of a global version bump.
    private var rootIdState: String? by mutableStateOf(null)

    // Bumped once per batch. Kept for external observers and tests;
    // composition no longer keys on it.
    private val _treeVersion = MutableStateFlow(0)
    val treeVersion: StateFlow<Int> = _treeVersion.asStateFlow()

    // Action dispatcher
    private var actionDispatcher: ActionDispatcher? = null

    // Listeners
    private val stateListeners = mutableListOf<RendererStateListener>()

    /**
     * Set the action dispatcher for handling actions from the UI.
     */
    fun setActionDispatcher(dispatcher: ActionDispatcher) {
        this.actionDispatcher = dispatcher
    }

    /**
     * Add a state listener.
     */
    fun addStateListener(listener: RendererStateListener) {
        stateListeners.add(listener)
    }

    /**
     * Remove a state listener.
     */
    fun removeStateListener(listener: RendererStateListener) {
        stateListeners.remove(listener)
    }

    override fun applyPatches(patches: List<Patch>) {
        log.debug { "Applying ${patches.size} patches" }

        // Collect notifications to invoke after releasing the lock,
        // preventing deadlock if listeners call back into renderer APIs.
        // Each lambda receives a snapshot of listeners so that callbacks
        // can safely call addStateListener/removeStateListener without
        // causing ConcurrentModificationException.
        val deferredNotifications = mutableListOf<(List<RendererStateListener>) -> Unit>()

        // Snapshot listeners while holding the lock so the list cannot be
        // modified between the copy and the iteration.
        val listenersSnapshot = synchronized(lock) {
            // Protocol invariant 3, "first-patch-only preludes": the stamp is
            // read from batch index 0 ONLY — a `batchAnimation` patch at any
            // other index, or inside a replayed initialTree, is not a stamp,
            // which is what stops concatenated batches from over-scoping.
            // Compose has no ambient transaction, so the spec is held for the
            // batch and consulted per whitelisted prop write, DOM/canvas
            // style, then cleared at flush.
            batchAnimationSpec = patches.firstOrNull()
                ?.takeIf { it.type == PatchType.BATCH_ANIMATION }
                ?.spec
            animation.beginBatch(batchAnimationSpec)

            // First pass: apply all patches, collecting any inserts that fail
            // because parent/child doesn't exist yet (patch ordering issue from engine)
            val deferredInserts = mutableListOf<Patch>()

            for (patch in patches) {
                log.debug { "Patch: type=${patch.type}, id=${patch.id}, name=${patch.name}, value=${patch.value}, text=${patch.text}" }
                if (patch.type == PatchType.INSERT || patch.type == PatchType.MOVE) {
                    // Check if both parent and child exist before inserting
                    val parentId = patch.parentId
                    val id = patch.id
                    if (parentId != null && id != null && parentId != "root") {
                        if (elements[id] == null || elements[parentId] == null) {
                            deferredInserts.add(patch)
                            continue
                        }
                    }
                }
                applyPatch(patch, deferredNotifications)
            }

            // Second pass: retry deferred inserts now that all Creates have been processed
            if (deferredInserts.isNotEmpty()) {
                log.debug { "Retrying ${deferredInserts.size} deferred inserts" }
                for (patch in deferredInserts) {
                    applyPatch(patch, deferredNotifications)
                }
            }

            // Flush: queue the enters this batch earned and drop the
            // transaction stamp (strictly batch-scoped).
            animation.endBatch()

            stateListeners.toList()
        }

        // Invoke deferred listener notifications outside the lock
        for (notification in deferredNotifications) {
            notification(listenersSnapshot)
        }

        _treeVersion.value++

        // Notify listeners
        listenersSnapshot.forEach { it.onTreeChanged() }
    }

    private fun applyPatch(patch: Patch, deferred: MutableList<(List<RendererStateListener>) -> Unit>) {
        when (patch.type) {
            PatchType.CREATE -> onCreate(patch, deferred)
            PatchType.SET_PROP -> onSetProp(patch)
            PatchType.REMOVE_PROP -> onRemoveProp(patch)
            PatchType.SET_TEXT -> onSetText(patch)
            PatchType.INSERT -> onInsert(patch)
            PatchType.MOVE -> onMove(patch)
            PatchType.REMOVE -> onRemove(patch, deferred)
            PatchType.ATTACH_EVENT -> onAttachEvent(patch)
            PatchType.DETACH_EVENT -> onDetachEvent(patch)
            PatchType.DETACH -> onDetach(patch)
            PatchType.ATTACH -> onAttach(patch)
            PatchType.SET_SEMANTICS -> onSetSemantics(patch)
            PatchType.BATCH_ANIMATION -> onBatchAnimation(patch)
        }
    }

    /**
     * Animation transaction prelude — mutates no tree state.
     *
     * The stamp is picked up in [applyPatches] from batch index 0 only;
     * this handler runs for every prelude in the batch, and a prelude at
     * any other index is deliberately inert (protocol invariant 3, which
     * is what stops concatenated batches from over-scoping).
     */
    private fun onBatchAnimation(patch: Patch) {
        log.debug { "Batch animation prelude: spec=${patch.spec}" }
    }

    /**
     * Reactive accessibility re-emit: replace the element's whole semantics
     * block (null clears). Semantics are snapshot-backed, so the write
     * recomposes just the element, which re-applies `Modifier.semantics {}`
     * from the new block — the same translation as at create, so a dropped
     * field simply stops being applied.
     */
    private fun onSetSemantics(patch: Patch) {
        val id = patch.id ?: return
        val element = elements[id] ?: run {
            log.debug { "SET_SEMANTICS: element not found: $id" }
            return
        }
        element.semantics = patch.semantics
    }

    private fun onCreate(patch: Patch, deferred: MutableList<(List<RendererStateListener>) -> Unit>) {
        val id = patch.id ?: return
        val elementType = patch.elementType ?: return

        log.debug { "Creating element: $id (type: $elementType), props=${patch.props}" }

        val props = patch.props ?: emptyMap()

        // Extract text content from props if present
        val textContent = props["0"]?.toString() ?: props["text"]?.toString()

        val existing = elements[id]
        val element = if (existing != null) {
            // Reuse the live instance so composables already holding it
            // observe the replacement through its snapshot state instead
            // of rendering a stale node.
            if (existing.children.isNotEmpty()) {
                log.warn { "CREATE: replacing ${existing.elementType}($id) that had ${existing.children.size} children!" }
            }
            existing.elementType = elementType
            existing.replaceProps(props)
            existing.clearChildren()
            existing.textContent = textContent
            existing.semantics = patch.semantics
            existing.bumpPropsRevision()
            existing
        } else {
            HypenElement(
                id = id,
                elementType = elementType,
                props = props,
                textContent = textContent,
                semantics = patch.semantics,
            ).also { elements[id] = it }
        }

        // Set root if this is the first element
        if (rootIdState == null) {
            rootIdState = id
        }

        // Parse every `__anim.*` channel and register enter eligibility. A
        // node created in this batch is the ONLY node that may enter-animate
        // (a cached Router attach never does), and the first-ever batch is
        // suppressed so initial render doesn't cascade.
        animation.noteCreate(id, props)

        deferred.add { listeners -> listeners.forEach { it.onElementCreated(element) } }
    }

    private fun onSetProp(patch: Patch) {
        val id = patch.id ?: return
        val name = patch.name ?: return

        val element = elements[id] ?: return
        // Captured BEFORE the write: it is the glide's start value.
        val previous = element.rawProps[name]
        element.setProp(name, patch.value)
        element.bumpPropsRevision()

        noteAnimation(id, name, patch.value, previous)

        // Handle special props
        if (name == "0" || name == "text") {
            // Text content update
            element.textContent = patch.value?.toString()
        }

        log.debug { "Set prop: $id.$name = ${patch.value}" }
    }

    /**
     * Route one prop write to the animation coordinator: an `__anim.*` write
     * re-parses that channel, anything else is a candidate for a glide
     * (transaction stamp > node `.transition` > snap).
     */
    private fun noteAnimation(id: String, name: String, value: Any?, previous: Any?) {
        if (name.startsWith(ANIM_PROP_PREFIX)) {
            animation.noteAnimProp(id, name, value)
        } else {
            animation.noteSetProp(id, name, previous)
        }
    }

    private fun onRemoveProp(patch: Patch) {
        val id = patch.id ?: return
        val name = patch.name ?: return

        val element = elements[id] ?: return
        val previous = element.rawProps[name]
        if (element.removeProp(name)) {
            element.bumpPropsRevision()
        }

        noteAnimation(id, name, null, previous)

        if (name == "0" || name == "text") {
            element.textContent = null
        }

        log.debug { "Remove prop: $id.$name" }
    }

    private fun onSetText(patch: Patch) {
        val id = patch.id ?: return
        val text = patch.text ?: return

        val element = elements[id] ?: return
        element.textContent = text

        log.debug { "Set text: $id = $text" }
    }

    private fun onInsert(patch: Patch) {
        val parentId = patch.parentId ?: run {
            log.warn { "INSERT: missing parentId for id=${patch.id}" }
            return
        }
        val id = patch.id ?: return

        val child = elements[id] ?: run {
            log.warn { "INSERT: child $id NOT FOUND in elements (parent=$parentId)" }
            return
        }

        // Handle root insertion
        if (parentId == "root") {
            rootIdState = id
            log.debug { "Inserted as root: $id" }
            return
        }

        val parent = elements[parentId] ?: run {
            log.warn { "INSERT: parent $parentId NOT FOUND for child $id" }
            return
        }
        child.parentId = parentId

        parent.addChild(id, patch.beforeId)

        log.debug { "Inserted: $id into $parentId" }
    }

    private fun onMove(patch: Patch) {
        // Move is similar to insert with removal from old position
        val parentId = patch.parentId ?: return
        val id = patch.id ?: return

        val child = elements[id] ?: return

        // Remove from old parent
        child.parentId?.let { oldParentId ->
            elements[oldParentId]?.removeChild(id)
        }

        // Insert into new parent (same as insert)
        onInsert(patch)
    }

    /**
     * The deferred-remove contract (protocol invariant 2, "renderers own
     * corpses"): a `Remove{transition:true}` means the engine-side id is
     * already dead — there is no ack round-trip. When the flagged root
     * carries a usable `__anim.exit` spec the renderer keeps the subtree
     * alive, excludes it from interaction immediately, plays the exit, and
     * finalizes on natural settle OR the `duration + delay + 80ms` timeout
     * backbone, whichever is first.
     *
     * Wire ordering is root-first: the flagged root arrives before its
     * descendants' PLAIN removes, so a plain remove landing inside an
     * already-exiting subtree defers to that root's finalize instead of
     * tearing the subtree out from under the playback.
     *
     * A flagged root with no exit spec (or under reduced motion) falls
     * through to the ordinary immediate teardown — the sanctioned snap.
     */
    private fun onRemove(patch: Patch, deferred: MutableList<(List<RendererStateListener>) -> Unit>) {
        val id = patch.id ?: return
        val element = elements[id] ?: return

        if (patch.transition) {
            val subtree = mutableSetOf(id)
            collectSubtreeIds(element, subtree)
            if (animation.beginExit(id, subtree) { finalizeDeferredRemove(id) }) {
                log.debug { "REMOVE: exit deferred for $id (${subtree.size} ids held)" }
                return
            }
            log.debug { "REMOVE: exit-flagged root $id has no usable exit spec — snapping" }
        } else if (animation.deferToExitingAncestor(id) { finalizeDeferredRemove(id) }) {
            log.debug { "REMOVE: $id defers to its exiting ancestor" }
            return
        }

        evictSubtree(id, deferred)
    }

    /** Immediate teardown: the pre-animation behaviour, unchanged. */
    private fun evictSubtree(id: String, deferred: MutableList<(List<RendererStateListener>) -> Unit>) {
        val element = elements.remove(id) ?: return
        detachedIds.remove(id)
        animation.forget(id)

        // Remove from parent's children
        element.parentId?.let { parentId ->
            elements[parentId]?.removeChild(id)
        }

        // Recursively remove all descendants
        removeDescendants(element, deferred)

        if (rootIdState == id) {
            rootIdState = null
        }

        log.debug { "Removed: $id" }
        deferred.add { listeners -> listeners.forEach { it.onElementRemoved(id) } }
    }

    /**
     * Teardown for a remove the animation layer deferred. Runs off the patch
     * thread (natural settle or the timeout backbone), so it takes the lock
     * itself and notifies listeners after releasing it.
     */
    private fun finalizeDeferredRemove(id: String) {
        val notifications = mutableListOf<(List<RendererStateListener>) -> Unit>()
        val listenersSnapshot =
            synchronized(lock) {
                if (elements[id] == null) return
                evictSubtree(id, notifications)
                stateListeners.toList()
            }
        for (notification in notifications) {
            notification(listenersSnapshot)
        }
        _treeVersion.value++
        listenersSnapshot.forEach { it.onTreeChanged() }
    }

    /** Every id at-or-under [element], captured before any tree mutation. */
    private fun collectSubtreeIds(element: HypenElement, into: MutableSet<String>) {
        for (childId in element.children.toList()) {
            if (!into.add(childId)) continue
            elements[childId]?.let { collectSubtreeIds(it, into) }
        }
    }

    private fun removeDescendants(element: HypenElement, deferred: MutableList<(List<RendererStateListener>) -> Unit>) {
        for (childId in element.children.toList()) {
            val child = elements.remove(childId) ?: continue
            detachedIds.remove(childId)
            animation.forget(childId)
            deferred.add { listeners -> listeners.forEach { it.onElementRemoved(childId) } }
            removeDescendants(child, deferred)
        }
    }

    /**
     * Unlink an element from its parent without destroying it.
     *
     * The element, its props, and its entire subtree remain in
     * `elements`; only the one link in the parent's `children` list
     * is removed. A subsequent ATTACH can reinsert with zero
     * rebuild work.
     *
     * If REMOVE arrives for this id instead, the subtree is torn
     * down normally (and evicted from `detachedIds`).
     */
    private fun onDetach(patch: Patch) {
        val id = patch.id ?: run {
            log.debug("DETACH: missing id")
            return
        }
        val element = elements[id] ?: run {
            log.debug { "DETACH: element not found: $id" }
            return
        }

        element.parentId?.let { parentId ->
            elements[parentId]?.removeChild(id)
        }
        element.parentId = null
        detachedIds.add(id)

        if (rootIdState == id) {
            rootIdState = null
        }

        log.debug { "Detached: $id" }
    }

    /**
     * Reattach a previously-detached element to a parent.
     * The element must still be in `elements` (i.e., not REMOVE-d).
     */
    private fun onAttach(patch: Patch) {
        val id = patch.id ?: run {
            log.debug("ATTACH: missing id")
            return
        }
        val parentId = patch.parentId ?: run {
            log.debug { "ATTACH: missing parentId for id=$id" }
            return
        }
        val child = elements[id] ?: run {
            log.warn { "ATTACH: element $id not found (was it removed?)" }
            return
        }

        // "root" is the mount-container sentinel, same as in onInsert —
        // engine emits it when the cached subtree's parent chain
        // terminates at the mount point (Router at IR root). Must not
        // be looked up in `elements`.
        if (parentId == "root" && elements[parentId] == null) {
            child.parentId?.let { oldParentId ->
                elements[oldParentId]?.removeChild(id)
            }
            child.parentId = null
            rootIdState = id
            detachedIds.remove(id)
            animation.noteAttach(id)
            log.debug { "Attached at root: $id" }
            return
        }

        val parent = elements[parentId] ?: run {
            log.warn { "ATTACH: parent $parentId not found for id=$id" }
            return
        }

        // Defensive: if the element somehow still has a stale parent
        // link (engine bug), unlink it first.
        child.parentId?.let { oldParentId ->
            elements[oldParentId]?.removeChild(id)
        }

        child.parentId = parentId

        parent.addChild(id, patch.beforeId)

        detachedIds.remove(id)
        animation.noteAttach(id)
        log.debug { "Attached: $id -> $parentId (before: ${patch.beforeId ?: "end"})" }
    }

    private fun onAttachEvent(patch: Patch) {
        // Events are handled through props (onClick, etc.)
        log.debug { "Attach event: ${patch.id}.${patch.eventName}" }
    }

    private fun onDetachEvent(patch: Patch) {
        // Events are handled through props
        log.debug { "Detach event: ${patch.id}.${patch.eventName}" }
    }

    override fun getElement(id: String): HypenElement? = synchronized(lock) { elements[id] }

    override fun clear() {
        synchronized(lock) {
            elements.clear()
            detachedIds.clear()
            batchAnimationSpec = null
            rootIdState = null
        }
        // Drops in-flight playbacks and their finalize timers without
        // running them — the tree they would tear down is already gone.
        animation.reset()
        _treeVersion.value++
    }

    /**
     * Snapshot of currently-detached element ids.
     *
     * Each call returns a fresh list so callers cannot mutate the
     * renderer's internal set, and the lock is released before the
     * caller iterates. Used by Strategy 3 (limbo container) to
     * render detached subtrees invisibly so Compose preserves their
     * per-subtree state.
     */
    fun getDetachedIds(): List<String> = synchronized(lock) {
        detachedIds.toList()
    }

    /**
     * Animation spec stamped on the most recently applied batch, or null
     * if that batch carried no [PatchType.BATCH_ANIMATION] prelude at
     * index 0. Consumed by [animation] during the batch; kept observable
     * for tests and diagnostics.
     */
    fun getBatchAnimationSpec(): Map<String, Any?>? = synchronized(lock) {
        batchAnimationSpec
    }

    /** The animation state machine driving this tree's `__anim.*` channels. */
    fun getAnimationCoordinator(): AnimationCoordinator = animation

    /**
     * Fire an element's `.onAnimationComplete` action for a NATURALLY settled
     * playback. Payload is the applicator's own named args with the
     * completion fields written last, so `animation`/`state` can never be
     * shadowed.
     */
    private fun dispatchCompletion(id: String, completion: AnimationCompletion) {
        val element = getElement(id) ?: return
        val action = animationCompleteAction(element.props) ?: return
        val payload = LinkedHashMap<String, Any?>(action.payload)
        payload.putAll(completion.toPayload())
        log.debug { "Animation complete on $id: ${completion.animation}" }
        actionDispatcher?.dispatch(action.actionName, payload)
    }

    override fun dispatchAction(
        action: String,
        payload: Map<String, Any?>?,
    ) {
        actionDispatcher?.dispatch(action, payload)
    }

    /**
     * Get the root element ID. Snapshot-backed: calling this from
     * composition subscribes the caller to root changes.
     */
    fun getRootId(): String? = synchronized(lock) { rootIdState }

    /**
     * Get the component registry.
     */
    fun getComponentRegistry(): ComponentRegistry = componentRegistry

    /**
     * Get the applicator registry.
     */
    fun getApplicatorRegistry(): ApplicatorRegistry = applicatorRegistry

    /**
     * Get children of an element.
     */
    fun getChildren(id: String): List<HypenElement> = synchronized(lock) {
        val element = elements[id] ?: return emptyList()
        element.children.mapNotNull { elements[it] }
    }

    /**
     * Create applicator context for an element.
     *
     * The dispatcher is wrapped in the exiting-subtree guard: an element
     * inside a deferred (exiting) subtree is engine-side DEAD the moment the
     * flagged Remove is emitted, so nothing under it may dispatch. Pointer
     * gating alone is not enough — a handler can be invoked from focus, IME,
     * or a timer — so this chokepoint checks at dispatch time.
     */
    fun createApplicatorContext(element: HypenElement): ApplicatorContext {
        val dispatcher = actionDispatcher
        return ApplicatorContext(
            element = element,
            actionDispatcher =
                if (dispatcher == null) {
                    null
                } else {
                    ActionDispatcher { action, payload ->
                        if (animation.isInExitingSubtree(element.id)) {
                            log.debug { "Dropping '$action' from exiting subtree ${element.id}" }
                        } else {
                            dispatcher.dispatch(action, payload)
                        }
                    }
                },
        )
    }

}
