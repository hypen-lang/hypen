package space.hypen.renderer.render

import androidx.compose.runtime.*
import space.hypen.renderer.HypenLoggers
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
) : Renderer {
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
        }
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

        deferred.add { listeners -> listeners.forEach { it.onElementCreated(element) } }
    }

    private fun onSetProp(patch: Patch) {
        val id = patch.id ?: return
        val name = patch.name ?: return

        val element = elements[id] ?: return
        element.setProp(name, patch.value)
        element.bumpPropsRevision()

        // Handle special props
        if (name == "0" || name == "text") {
            // Text content update
            element.textContent = patch.value?.toString()
        }

        log.debug { "Set prop: $id.$name = ${patch.value}" }
    }

    private fun onRemoveProp(patch: Patch) {
        val id = patch.id ?: return
        val name = patch.name ?: return

        val element = elements[id] ?: return
        if (element.removeProp(name)) {
            element.bumpPropsRevision()
        }

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

    private fun onRemove(patch: Patch, deferred: MutableList<(List<RendererStateListener>) -> Unit>) {
        val id = patch.id ?: return

        val element = elements.remove(id) ?: return
        detachedIds.remove(id)

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

    private fun removeDescendants(element: HypenElement, deferred: MutableList<(List<RendererStateListener>) -> Unit>) {
        for (childId in element.children.toList()) {
            val child = elements.remove(childId) ?: continue
            detachedIds.remove(childId)
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
            rootIdState = null
        }
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
     */
    fun createApplicatorContext(element: HypenElement): ApplicatorContext =
        ApplicatorContext(
            element = element,
            actionDispatcher = actionDispatcher,
        )

}
