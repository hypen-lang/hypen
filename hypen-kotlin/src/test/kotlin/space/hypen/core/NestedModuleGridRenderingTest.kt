package space.hypen.core

import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Integration test for nested module Grid rendering via the native engine.
 *
 * Mirrors the Rust SDK test `test_nested_module_grid_renders_items` in
 * hypen-sdk-rs/tests/integration.rs. Verifies that a nested module with
 * a Grid(@state.explorePosts) iterating over scoped state produces the
 * expected Create patches (Grid + 3 Image elements).
 */
class NestedModuleGridRenderingTest {

    @BeforeEach
    fun resetRegistry() {
        HypenApp.clear()
    }

    @Test
    fun `nested module Grid renders items from scoped state`() {
        // NativeEngine.isAvailable() catches Exception but not Error (NoClassDefFoundError).
        // Wrap in a try-catch to handle class-loading failures gracefully.
        val engineAvailable = try {
            NativeEngine.isAvailable()
        } catch (_: Throwable) {
            false
        }
        assumeTrue(engineAvailable, "Native Hypen engine library not available")

        NativeEngine().use { engine ->
            engine.registerDefaultPrimitives()

            // 1. Set App as primary module with state {"currentView": "search"}
            val appDef = AppBuilder.defineState(
                mapOf("currentView" to "search"),
                ModuleOptions(name = "App")
            ).build()
            ModuleInstance(engine, appDef)

            // 2. Register Search as a named module with 3 explorePosts
            val searchDef = AppBuilder.defineState(
                mapOf(
                    "searchQuery" to "",
                    "explorePosts" to listOf(
                        mapOf("id" to "p1", "imageUrl" to "https://img1.jpg"),
                        mapOf("id" to "p2", "imageUrl" to "https://img2.jpg"),
                        mapOf("id" to "p3", "imageUrl" to "https://img3.jpg")
                    )
                ),
                ModuleOptions(name = "Search")
            ).build()
            NestedModuleInstance(engine, searchDef)

            // 3. Register the Search component DSL
            engine.registerComponent(
                "Search",
                """
                module Search {
                    Column {
                        Input(placeholder: "Search")
                        Grid(@state.explorePosts, key: "id") {
                            Image(src: "@{item.imageUrl}")
                        }
                    }
                }
                """.trimIndent()
            )

            // 4. Render App with conditional Search inclusion
            val patches = engine.renderSource(
                """
                module App {
                    Column {
                        If(condition: "@{state.currentView == 'search'}") {
                            Search()
                        }
                    }
                }
                """.trimIndent()
            )

            // 5. Collect all Create patches and their element types
            val createElementTypes = patches
                .filter { it.type == PatchType.CREATE }
                .mapNotNull { it.elementType }

            // 6. Assert Grid element is created
            assertTrue(
                createElementTypes.contains("Grid"),
                "Initial render should create a Grid element. Got: $createElementTypes"
            )

            // 7. Assert 3 Image elements are created (one per explorePost)
            val imageCount = createElementTypes.count { it == "Image" }
            assertEquals(
                3, imageCount,
                "Should create 3 Image elements for 3 explorePosts. Got creates: $createElementTypes"
            )
        }
    }
}
