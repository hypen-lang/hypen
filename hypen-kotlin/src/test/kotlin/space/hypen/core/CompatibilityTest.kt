package space.hypen.core

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory
import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Engine Compatibility Test Runner for Kotlin SDK.
 *
 * Loads JSON test fixtures and verifies the Kotlin SDK produces
 * the same behavior as other SDK implementations.
 */
class CompatibilityTest {

    private val json = Json { ignoreUnknownKeys = true }

    // Test fixture data classes
    @Serializable
    data class TestCase(
        val name: String,
        val description: String,
        val category: String,
        val priority: String? = null,
        val input: TestInput,
        val expected: Expected? = null,
        val steps: List<TestStep>? = null,
        val skip: Skip? = null
    )

    @Serializable
    data class TestInput(
        val source: String,
        val initialState: JsonObject? = null,
        val module: ModuleConfig? = null
    )

    @Serializable
    data class ModuleConfig(
        val name: String,
        val actions: List<String>? = null,
        val stateKeys: List<String>? = null
    )

    @Serializable
    data class Expected(
        val patches: List<JsonObject>? = null,
        val patchCount: Int? = null,
        val patchTypes: List<String>? = null
    )

    @Serializable
    data class TestStep(
        val description: String? = null,
        val action: String,
        val stateChange: StateChangeInput? = null,
        val dispatchAction: ActionInput? = null,
        val expectedPatches: List<JsonObject>? = null,
        val expectedPatchCount: Int? = null,
        val expectedPatchTypes: List<String>? = null,
        val forbiddenPatchTypes: List<String>? = null,
        val expectedState: JsonObject? = null
    )

    @Serializable
    data class StateChangeInput(
        val paths: List<String>,
        val newValues: JsonObject
    )

    @Serializable
    data class ActionInput(
        val name: String,
        val payload: JsonElement? = null
    )

    @Serializable
    data class Skip(
        val reason: String? = null,
        val sdks: List<String>? = null
    )

    // Action handlers for testing
    private val actionHandlers = mapOf<String, (Action, MutableMap<String, Any?>) -> Map<String, Any?>>(
        "handleClick" to { _, state ->
            state["clicked"] = true
            state
        },
        "selectItem" to { action, state ->
            val payload = action.payload?.toKotlinValue()
            if (payload is Map<*, *>) {
                state["selectedId"] = payload["id"]
            }
            state
        }
    )

    /**
     * The device-protocol fixture root (`fixtures/device`) — matched by
     * path, so only that directory is handed to the device runner and a
     * nested `device/` DSL category is still rendered here.
     */
    internal fun isDeviceFixtureRoot(fixturesDir: File, dir: File): Boolean =
        dir.canonicalFile == File(fixturesDir, "device").canonicalFile

    @org.junit.jupiter.api.Test
    fun `only fixtures-device is skipped, never a nested device category`() {
        val root = kotlin.io.path.createTempDirectory("compat-fixtures").toFile()
        try {
            val deviceRoot = File(root, "device").apply { mkdirs() }
            val nested = File(root, "components/device").apply { mkdirs() }
            val deeper = File(root, "device/device").apply { mkdirs() }
            assertTrue(isDeviceFixtureRoot(root, deviceRoot))
            assertTrue(isDeviceFixtureRoot(File(root, "."), File(root, "device/")), "path spelling must not matter")
            assertFalse(isDeviceFixtureRoot(root, nested), "a DSL category named device is still rendered")
            assertFalse(isDeviceFixtureRoot(root, deeper))
            assertFalse(isDeviceFixtureRoot(root, root))
        } finally {
            root.deleteRecursively()
        }
    }

    @TestFactory
    fun `Engine Compatibility Tests`(): List<DynamicTest> {
        val fixturesDir = File("../engine-compatibility-tests/fixtures")
        if (!fixturesDir.exists()) {
            return listOf(
                DynamicTest.dynamicTest("Fixtures directory not found") {
                    println("Warning: Fixtures directory not found at ${fixturesDir.absolutePath}")
                }
            )
        }

        val fixtures = fixturesDir.walkTopDown()
            // Skip `portable/` — different schema, separate runner
            // (PortableCompatibilityTest.kt). Skip `variant/` for the same
            // reason — its cases have no `input.source` (they exercise the
            // variant parse/resolve helpers, not the DSL pipeline), so they
            // fail TestCase deserialization at discovery time. Mirrors the
            // fixtures/variant/ skip the other DSL runners already have.
            // Skip `fixtures/device/` too — exactly that directory, never a
            // DSL fixture category that happens to be named `device` deeper in
            // the tree: device-protocol transcripts, frames and conformance
            // corpora are replayed through the Rust broker by their own
            // runners (space.hypen.remote.device.DeviceBrokerTranscriptReplayTest /
            // DeviceBrokerConformanceTest).
            .onEnter { dir -> dir.name != "portable" && dir.name != "variant" && !isDeviceFixtureRoot(fixturesDir, dir) }
            .filter { it.isFile && it.extension == "json" }
            // Skip state-transform fixtures that live beside test-case
            // fixtures (`dnd/path-move.json`, fixtures/dnd/README.md): they
            // carry a top-level `function` key instead of `input`/`steps`
            // and are replayed by PathMoveFixtureTest (DndHostTest.kt), not
            // rendered as DSL. The rest of `dnd/` IS test-case schema.
            .filter { file -> !isFunctionFixture(file) }
            .toList()

        return fixtures.map { file ->
            val testCase = json.decodeFromString<TestCase>(file.readText())
            val relativePath = file.relativeTo(fixturesDir).path

            DynamicTest.dynamicTest("[${testCase.category}] ${testCase.name}") {
                // Check if test should be skipped
                if (testCase.skip?.sdks?.contains("kotlin") == true) {
                    println("Skipped: ${testCase.skip.reason}")
                    return@dynamicTest
                }

                // Run the appropriate test based on category
                when (testCase.category) {
                    "actions" -> runActionTest(testCase)
                    "lifecycle" -> runLifecycleTest(testCase)
                    "state" -> runStateTest(testCase)
                    "rendering", "reconciliation", "control-flow" -> {
                        // These require a full engine implementation
                        println("Skipped: Test category '${testCase.category}' requires full engine (parser/renderer)")
                    }
                    "dnd" -> {
                        // Engine-side lowering fixtures (`__dnd.*` /
                        // `__anim.states*` props on Create/SetProp): replayed
                        // through the real NativeEngine so the wire a
                        // Kotlin-hosted app relays is byte-checked against the
                        // same fixtures the Rust/TS runners pin. The Kotlin
                        // HOST side (`__hypen_reorder`/`__hypen_pin`,
                        // `ObservableState.move`, path-move.json) is covered
                        // by DndHostTest.kt.
                        runRenderFixture(testCase)
                    }
                    "animation" -> {
                        // Intentional skip. Kotlin DOES have a full engine
                        // (NativeEngine over uniffi render_source/update_state),
                        // so this category is not blocked on the same thing as
                        // the render categories above. What remains, in order
                        // (graduation checklist: hypen-web/docs/animation.md,
                        // "Conformance graduation (the Kotlin runner)"):
                        //
                        //  1. The uniffi FFI change must land — a hard gate.
                        //     `Patch` needs `transition` on remove and a
                        //     `BatchAnimation` variant carrying `spec_json`
                        //     (hypen-engine-rs/src/uniffi/mod.rs), with BOTH
                        //     binding sets regenerated. Until then
                        //     `exit-deferred-remove.json` (expects
                        //     `transition: true`) and `batch-animation-stamp.json`
                        //     (expects the prelude) cannot pass: the fields do
                        //     not exist in the generated record. The SDK-side
                        //     relay for both is already in place
                        //     (Types.kt `Patch.transition`/`Patch.spec`,
                        //     NativeEngine.kt `toPatch`).
                        //  2. A render-category runner must exist here — feed
                        //     `input.source` + `initialState` through
                        //     NativeEngine and assert `expected.patches`
                        //     (types, `__anim.*` props, the flag), mirroring
                        //     engine-compatibility-tests/runners/rust/tests/compatibility.rs.
                        //     `runRenderFixture` (used by the `dnd` arm above)
                        //     is that runner; lifting this arm onto it is
                        //     step 2 once step 1's fields are verified.
                        //  3. Then lift this arm, keeping per-fixture
                        //     `skip.sdks` honored with reason strings.
                        //
                        // Renderer behaviour is NOT gated by this: these 20
                        // fixtures pin engine-side lowering only. The Android
                        // renderer's own animation support is verified visually
                        // against the DOM renderer, and it still snaps.
                        println("Skipped: Test category 'animation' pending the uniffi transition/BatchAnimation FFI change and a Kotlin render-category runner (see hypen-web/docs/animation.md)")
                    }
                    else -> {
                        println("Skipped: Unknown test category: ${testCase.category}")
                    }
                }
            }
        }
    }

    private fun runActionTest(tc: TestCase) {
        val module = tc.input.module ?: run {
            println("Skipped: No module configuration")
            return
        }

        // Create mock engine
        val engine = MockEngine()

        // Track state
        val currentState = tc.input.initialState?.toKotlinValue() as? MutableMap<String, Any?>
            ?: mutableMapOf()

        // Set up module
        engine.setModule(
            module.name,
            module.actions ?: emptyList(),
            module.stateKeys ?: emptyList(),
            currentState
        )

        // Register action handlers
        for (actionName in module.actions ?: emptyList()) {
            engine.onAction(actionName) { action ->
                val handler = actionHandlers[actionName]
                if (handler != null) {
                    val newState = handler(action, currentState.toMutableMap())
                    currentState.clear()
                    currentState.putAll(newState)
                    // Notify state change
                    engine.updateState("", currentState.keys.toList(), currentState)
                }
            }
        }

        // Run test steps
        tc.steps?.forEachIndexed { index, step ->
            println("Step ${index + 1}: ${step.description ?: step.action}")

            when (step.action) {
                "initialRender" -> {
                    // Skip - requires parser
                }
                "dispatchAction" -> {
                    step.dispatchAction?.let { action ->
                        engine.triggerAction(action.name, action.payload?.toKotlinValue())
                    }
                }
                "updateState" -> {
                    step.stateChange?.let { change ->
                        val newValues = change.newValues.toKotlinValue() as? Map<String, Any?> ?: emptyMap()
                        newValues.forEach { (path, value) ->
                            setNestedValue(currentState, path, value)
                        }
                        engine.updateState("", change.paths, newValues)
                    }
                }
            }

            // Verify expected state
            step.expectedState?.let { expected ->
                val expectedMap = expected.toKotlinValue() as? Map<String, Any?> ?: emptyMap()
                expectedMap.forEach { (key, expectedValue) ->
                    val actualValue = currentState[key]
                    assertTrue(
                        deepEquals(actualValue, expectedValue),
                        "State mismatch for key '$key': expected $expectedValue, got $actualValue"
                    )
                }
            }
        }
    }

    private fun runLifecycleTest(tc: TestCase) {
        val module = tc.input.module ?: run {
            println("Skipped: No module configuration")
            return
        }

        // Track lifecycle events
        var createdCalled = false
        var destroyedCalled = false

        // Build module definition
        val initialState = tc.input.initialState?.toKotlinValue() as? Map<String, Any?>
            ?: emptyMap()

        val definition = AppBuilder.defineState(initialState.toMutableMap())
            .onCreated { state, _ ->
                createdCalled = true
                state.set("initialized", true)
            }
            .onDestroyed { _, _ ->
                destroyedCalled = true
            }
            .build()

        // Create mock engine and module instance
        val engine = MockEngine()
        val instance = ModuleInstance(engine, definition, null, null)

        // Verify onCreated was called
        assertTrue(createdCalled, "onCreated was not called")

        // Check expected state
        tc.steps?.forEach { step ->
            step.expectedState?.let { expected ->
                val state = instance.getState()
                val expectedMap = expected.toKotlinValue() as? Map<String, Any?> ?: emptyMap()
                expectedMap.forEach { (key, expectedValue) ->
                    val actualValue = state[key]
                    assertTrue(
                        deepEquals(actualValue, expectedValue),
                        "State mismatch for key '$key': expected $expectedValue, got $actualValue"
                    )
                }
            }
        }

        // Test destroy
        instance.destroy()
        assertTrue(destroyedCalled, "onDestroyed was not called")
    }

    private fun runStateTest(tc: TestCase) {
        // Most state tests require rendering - skip if they depend on patches
        if (tc.expected?.patches != null) {
            println("Skipped: Test requires rendering engine")
            return
        }

        tc.steps?.forEach { step ->
            if (step.expectedPatches != null || step.expectedPatchCount != null) {
                println("Skipped: Test requires rendering engine")
                return
            }
        }

        // Create observable state
        val initialState = tc.input.initialState?.toKotlinValue() as? Map<String, Any?>
            ?: emptyMap()
        val state = ObservableState(initialState.toMutableMap())

        // Run steps that don't require rendering
        tc.steps?.forEachIndexed { index, step ->
            println("Step ${index + 1}: ${step.description ?: step.action}")

            if (step.action == "updateState") {
                step.stateChange?.let { change ->
                    val newValues = change.newValues.toKotlinValue() as? Map<String, Any?> ?: emptyMap()
                    newValues.forEach { (path, value) ->
                        state.set(path, value)
                    }
                }
            }

            // Verify expected state
            step.expectedState?.let { expected ->
                val snapshot = state.getAll()
                val expectedMap = expected.toKotlinValue() as? Map<String, Any?> ?: emptyMap()
                expectedMap.forEach { (key, expectedValue) ->
                    val actualValue = snapshot[key]
                    assertTrue(
                        deepEquals(actualValue, expectedValue),
                        "State mismatch for key '$key': expected $expectedValue, got $actualValue"
                    )
                }
            }
        }
    }

    // ------------------------------------------------------------------
    // Render-category runner (real engine)
    // ------------------------------------------------------------------

    /**
     * Replay a `test-case.schema.json` fixture through the real
     * [NativeEngine]: `input.source` + `input.initialState` are rendered and
     * every step's / the top-level `expected` block is asserted with the SAME
     * matching rules as the Rust runner
     * (`hypen-engine-rs/tests/test_dnd.rs::dnd_fixtures`):
     *
     * - `patchCount` / `patchTypes` (or the `expected`-prefixed step names)
     *   compare the whole batch;
     * - each entry of `patches` / `expectedPatches` must be matched by a
     *   distinct actual patch: same `type`, `elementType` when given, every
     *   listed `props` key present with an equal value (`null` in the fixture
     *   means PRESENT with an explicit JSON null), no `absentProps` key
     *   present, and `name` / `value` equal for setProp;
     * - `forbiddenPatchTypes` must not appear in the batch.
     *
     * `updateState` steps go through the Kotlin host's real engine entry
     * point — the sparse `paths` + path-keyed values form `ObservableState`
     * feeds — whenever every fixture path resolves inside `newValues`;
     * otherwise the nested object is deep-merged (`updateStateJson`), which
     * is what the Rust runner does.
     */
    private fun runRenderFixture(tc: TestCase) {
        val engineAvailable = runCatching { NativeEngine.isAvailable() }.getOrDefault(false)
        assumeTrue(
            engineAvailable,
            "Native Hypen engine library not available (build it with scripts/generate-bindings.sh)",
        )

        NativeEngine().use { engine ->
            engine.registerDefaultPrimitives()
            // Fixture element names outside the default set (Card, Note,
            // Seat, …) are plain primitives from the fixture's point of view.
            expectedElementTypes(tc).forEach { engine.registerPrimitive(it) }

            val module = tc.input.module
            @Suppress("UNCHECKED_CAST")
            val initialState = tc.input.initialState?.toKotlinValue() as? Map<String, Any?> ?: emptyMap()
            engine.setModule(
                module?.name ?: "TestModule",
                module?.actions ?: emptyList(),
                module?.stateKeys ?: emptyList(),
                initialState,
            )

            val steps = tc.steps
            if (steps.isNullOrEmpty()) {
                val patches = engine.renderSource(tc.input.source)
                assertRenderStep(tc.name, "single", patches, tc.expected)
                return
            }
            steps.forEachIndexed { index, step ->
                val label = step.description ?: "step ${index + 1}"
                val patches: List<Patch> = when (step.action) {
                    "initialRender" -> engine.renderSource(tc.input.source)
                    "updateState" -> {
                        val change = step.stateChange
                            ?: error("[${tc.name}] $label: updateState step without stateChange")
                        applyFixtureStateChange(engine, change)
                    }
                    else -> error("[${tc.name}] $label: unsupported render-fixture action '${step.action}'")
                }
                assertRenderStep(
                    tc.name,
                    label,
                    patches,
                    patchCount = step.expectedPatchCount,
                    patchTypes = step.expectedPatchTypes,
                    expectedPatches = step.expectedPatches,
                    forbiddenPatchTypes = step.forbiddenPatchTypes,
                )
            }
        }
    }

    /** Every `elementType` named by the fixture's expected patches. */
    private fun expectedElementTypes(tc: TestCase): Set<String> {
        val all = (tc.expected?.patches ?: emptyList()) + (tc.steps?.flatMap { it.expectedPatches ?: emptyList() } ?: emptyList())
        return all.mapNotNull { (it["elementType"] as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }.toSet()
    }

    /**
     * Feed a fixture `stateChange` to the engine the way the Kotlin host does
     * (sparse paths, values keyed by path) when the nested `newValues` object
     * carries a value at every listed path; deep-merge otherwise.
     */
    private fun applyFixtureStateChange(engine: NativeEngine, change: StateChangeInput): List<Patch> {
        val byPath = LinkedHashMap<String, Any?>()
        for (path in change.paths) {
            val element = resolveJsonPath(change.newValues, path) ?: return engine.updateStateJson("", change.newValues.toString())
            byPath[path] = element.toKotlinValue()
        }
        val received = mutableListOf<Patch>()
        engine.setRenderCallback { received.addAll(it) }
        engine.updateState("", change.paths, byPath)
        engine.setRenderCallback { }
        return received
    }

    private fun resolveJsonPath(root: JsonElement, path: String): JsonElement? {
        var current: JsonElement = root
        for (part in path.split(".")) {
            current = when (current) {
                is JsonObject -> current[part] ?: return null
                is JsonArray -> part.toIntOrNull()?.let { current.getOrNull(it) } ?: return null
                else -> return null
            }
        }
        return current
    }

    private fun assertRenderStep(name: String, label: String, patches: List<Patch>, expected: Expected?) =
        assertRenderStep(
            name,
            label,
            patches,
            patchCount = expected?.patchCount,
            patchTypes = expected?.patchTypes,
            expectedPatches = expected?.patches,
            forbiddenPatchTypes = null,
        )

    private fun assertRenderStep(
        name: String,
        label: String,
        patches: List<Patch>,
        patchCount: Int?,
        patchTypes: List<String>?,
        expectedPatches: List<JsonObject>?,
        forbiddenPatchTypes: List<String>?,
    ) {
        val dump = { patches.joinToString("\n") { describePatch(it) } }
        if (patchCount != null) {
            assertEquals(patchCount, patches.size, "[$name] $label: patch count\n${dump()}")
        }
        if (patchTypes != null) {
            assertEquals(patchTypes, patches.map { it.type }, "[$name] $label: patch types\n${dump()}")
        }
        if (expectedPatches != null) {
            val used = BooleanArray(patches.size)
            for (e in expectedPatches) {
                val idx = patches.indices.firstOrNull { i -> !used[i] && patchMatches(patches[i], e) }
                    ?: throw AssertionError("[$name] $label: no patch matches $e\nActual:\n${dump()}")
                used[idx] = true
            }
        }
        forbiddenPatchTypes?.forEach { f ->
            assertFalse(patches.any { it.type == f }, "[$name] $label: forbidden patch type '$f' emitted\n${dump()}")
        }
    }

    private fun describePatch(p: Patch): String = buildString {
        append(p.type)
        p.id?.let { append(" id=").append(it) }
        p.elementType?.let { append(" ").append(it) }
        p.name?.let { append(" name=").append(it) }
        p.value?.let { append(" value=").append(it) }
        p.props?.let { append(" props=").append(JsonObject(it)) }
    }

    private fun patchMatches(actual: Patch, expected: JsonObject): Boolean {
        val type = (expected["type"] as? JsonPrimitive)?.content ?: return false
        if (actual.type != type) return false
        (expected["elementType"] as? JsonPrimitive)?.content?.let { if (actual.elementType != it) return false }
        (expected["props"] as? JsonObject)?.forEach { (k, want) ->
            // `null` in the fixture means PRESENT with an explicit null:
            // Map.get distinguishes a missing key (null) from JsonNull.
            val have = actual.props?.get(k) ?: return false
            if (!jsonEquals(have, want)) return false
        }
        (expected["absentProps"] as? JsonArray)?.forEach { k ->
            val key = (k as? JsonPrimitive)?.content ?: return@forEach
            if (actual.props?.containsKey(key) == true) return false
        }
        (expected["name"] as? JsonPrimitive)?.content?.let { if (actual.name != it) return false }
        expected["value"]?.let { want ->
            val have = actual.value ?: return false
            if (!jsonEquals(have, want)) return false
        }
        return true
    }

    /** `100 == 100.0`; objects need equal key sets (the runners' `json_values_equal`). */
    private fun jsonEquals(a: JsonElement, b: JsonElement): Boolean = when {
        a is JsonObject && b is JsonObject ->
            a.size == b.size && a.all { (k, v) -> b[k]?.let { jsonEquals(v, it) } == true }
        a is JsonArray && b is JsonArray ->
            a.size == b.size && a.zip(b).all { (v, w) -> jsonEquals(v, w) }
        a is JsonPrimitive && b is JsonPrimitive && !a.isString && !b.isString -> {
            val x = a.doubleOrNull
            val y = b.doubleOrNull
            if (x != null && y != null) x == y else a == b
        }
        else -> a == b
    }

    /** True when the fixture is a `{function, ...}` state-transform fixture rather than a test case. */
    private fun isFunctionFixture(file: File): Boolean =
        (runCatching { json.parseToJsonElement(file.readText()) }.getOrNull() as? JsonObject)
            ?.containsKey("function") == true

    private fun setNestedValue(obj: MutableMap<String, Any?>, path: String, value: Any?) {
        val parts = path.split(".")
        var current: MutableMap<String, Any?> = obj

        for (i in 0 until parts.size - 1) {
            val part = parts[i]
            @Suppress("UNCHECKED_CAST")
            current = current.getOrPut(part) { mutableMapOf<String, Any?>() } as MutableMap<String, Any?>
        }

        current[parts.last()] = value
    }

    @Suppress("UNCHECKED_CAST")
    private fun JsonElement.toKotlinValue(): Any? = when (this) {
        is JsonNull -> null
        is JsonPrimitive -> {
            when {
                isString -> content
                content == "true" -> true
                content == "false" -> false
                content.contains(".") -> content.toDoubleOrNull() ?: content
                else -> content.toLongOrNull()?.toInt() ?: content.toIntOrNull() ?: content
            }
        }
        is JsonObject -> this.mapValues { it.value.toKotlinValue() }.toMutableMap()
        is JsonArray -> this.map { it.toKotlinValue() }.toMutableList()
    }
}
