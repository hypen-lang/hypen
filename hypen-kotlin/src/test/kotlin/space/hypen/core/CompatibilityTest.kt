package space.hypen.core

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*
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
            .onEnter { dir -> dir.name != "portable" && dir.name != "variant" }
            .filter { it.isFile && it.extension == "json" }
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
                    "rendering", "reconciliation", "control-flow", "animation" -> {
                        // These require a full engine implementation
                        println("Skipped: Test category '${testCase.category}' requires full engine (parser/renderer)")
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
