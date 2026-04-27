package space.hypen

import kotlinx.coroutines.delay
import kotlinx.serialization.Serializable
import space.hypen.core.*

private val log = createLogger("Counter")

@Serializable
data class CounterState(var count: Int = 0)

sealed interface CounterAction : HypenAction {
    data object Increment : CounterAction
    data object Decrement : CounterAction
    data object Reset : CounterAction
}

val counterModule = hypen(CounterState()) {
    name("Counter")

    ui("""
        Column {
            Text("Count: @{state.count}")
                .fontSize(48)
            Row {
                Button("@actions.Decrement") { Text("-") }
                Button("@actions.Reset") { Text("Reset") }
                Button("@actions.Increment") { Text("+") }
            }
        }
    """.trimIndent())

    // Lifecycle: log when the module is created
    onCreated { state, _ ->
        log.info("Counter module created with initial count=${state.count}")
    }

    onAction<CounterAction.Increment> { action, state, context ->
        state.count += 1
        log.debug("Incremented to ${state.count}")
    }

    onAction<CounterAction.Decrement> { action, state, context ->
        state.count -= 1
        log.debug("Decremented to ${state.count}")
    }

    // Async action: simulates a delayed reset (e.g. server-side confirmation)
    onActionAsync<CounterAction.Reset> { action, state, context ->
        log.info("Resetting counter (async)...")
        delay(300) // simulate async work
        state.count = 0
        log.info("Counter reset complete")
    }

    // Error handler: log and swallow errors gracefully
    onError { ctx ->
        log.error("Error in counter: ${ctx.error.message}", ctx.actionName ?: ctx.lifecycle ?: "")
        ErrorHandlerResult.Handled
    }
}
