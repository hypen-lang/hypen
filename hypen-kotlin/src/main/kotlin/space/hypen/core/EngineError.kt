package space.hypen.core

/**
 * Structured error type for Hypen Engine operations.
 *
 * SDK consumers can use `when` expressions to pattern-match on error variants
 * and handle different failure modes appropriately.
 *
 * Example:
 * ```kotlin
 * try {
 *     engine.renderSource(source)
 * } catch (e: EngineError) {
 *     when (e) {
 *         is EngineError.Parse -> println("Parse failed: ${e.detail}")
 *         is EngineError.ComponentNotFound -> println("Missing: ${e.componentName}")
 *         is EngineError.Render -> println("Render failed: ${e.detail}")
 *         is EngineError.ActionNotFound -> println("No handler for: ${e.actionName}")
 *         is EngineError.State -> println("State error: ${e.detail}")
 *     }
 * }
 * ```
 */
sealed class EngineError(message: String, cause: Throwable? = null) : Exception(message, cause) {

    /** Error parsing Hypen DSL source code. */
    class Parse(
        val detail: String,
        cause: Throwable? = null
    ) : EngineError("Parse error: $detail", cause)

    /** A referenced component was not found in the registry. */
    class ComponentNotFound(
        val componentName: String,
        cause: Throwable? = null
    ) : EngineError("Component not found: $componentName", cause)

    /** Error during rendering or reconciliation. */
    class Render(
        val detail: String,
        cause: Throwable? = null
    ) : EngineError("Render error: $detail", cause)

    /** No handler registered for the dispatched action. */
    class ActionNotFound(
        val actionName: String,
        cause: Throwable? = null
    ) : EngineError("No handler registered for action: $actionName", cause)

    /** Error related to state operations (invalid patch, deserialization failure). */
    class State(
        val detail: String,
        cause: Throwable? = null
    ) : EngineError("State error: $detail", cause)
}
