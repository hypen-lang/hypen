package space.hypen

import kotlinx.coroutines.delay
import kotlinx.serialization.Serializable
import space.hypen.core.*

private val log = createLogger("Todo")

@Serializable
data class Todo(val text: String, val done: Boolean = false)

@Serializable
data class TodoState(
    var todos: List<Todo> = emptyList(),
    var loading: Boolean = false,
    var error: String? = null
)

sealed interface TodoAction : HypenAction {
    data class Add(val text: String) : TodoAction
    data class Toggle(val index: Int) : TodoAction
    data class Remove(val index: Int) : TodoAction
    data object Fetch : TodoAction
}

val todoModule = hypen(TodoState()) {
    name("Todo")

    ui("""
        Column {
            Text("Todo List")
                .fontSize(24)
                .fontWeight(bold)
            Row {
                Input(placeholder: "New todo...").bind(@state.newTodo)
                Button("@actions.Add") { Text("Add") }
            }
            Button("@actions.Fetch") { Text("Refresh") }
            Column {
                Text("@{state.error}")
                    .color(red)
            }
        }
    """.trimIndent())

    // Lifecycle: trigger initial fetch when the module is created
    onCreated { state, _ ->
        log.info("Todo module created, ${state.todos.size} todos loaded")
    }

    onAction<TodoAction.Add> { action, state, _ ->
        if (action.text.isNotBlank()) {
            state.todos = state.todos + Todo(text = action.text)
            log.debug("Added todo: ${action.text}")
        }
    }

    onAction<TodoAction.Toggle> { action, state, _ ->
        val idx = action.index
        if (idx in state.todos.indices) {
            state.todos = state.todos.mapIndexed { i, todo ->
                if (i == idx) todo.copy(done = !todo.done) else todo
            }
            log.debug("Toggled todo at index $idx")
        }
    }

    onAction<TodoAction.Remove> { action, state, _ ->
        val idx = action.index
        if (idx in state.todos.indices) {
            val removed = state.todos[idx]
            state.todos = state.todos.filterIndexed { i, _ -> i != idx }
            log.debug("Removed todo: ${removed.text}")
        }
    }

    // Async action with retry: simulates fetching todos from an API
    onActionAsync<TodoAction.Fetch> { _, state, _ ->
        state.loading = true
        state.error = null
        log.info("Fetching todos...")

        log.timeAsync("fetchTodos") {
            try {
                val todos = retry(RetryPresets.fast) {
                    // Simulate an API call
                    delay(200)
                    listOf(
                        Todo("Review pull request", done = true),
                        Todo("Write documentation"),
                        Todo("Deploy to staging")
                    )
                }
                state.todos = todos
                state.loading = false
                log.info("Fetched ${todos.size} todos")
            } catch (e: Exception) {
                state.loading = false
                state.error = "Failed to fetch todos: ${e.message}"
                log.error("Failed to fetch todos", e.message ?: "")
            }
        }
    }

    // Error handler: log and swallow errors, set error state for the UI
    onError { ctx ->
        log.error("Error in todo module: ${ctx.error.message}", ctx.actionName ?: ctx.lifecycle ?: "")
        ErrorHandlerResult.Handled
    }
}
