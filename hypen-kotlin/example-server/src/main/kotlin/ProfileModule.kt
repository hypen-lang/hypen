package space.hypen

import kotlinx.serialization.Serializable
import space.hypen.core.*

private val log = createLogger("Profile")

@Serializable
data class ProfileState(
    var name: String = "Alice",
    var bio: String = "Hypen developer",
    var theme: String = "dark",
    var newsletter: Boolean = false,
    var darkMode: Boolean = true
)

sealed interface ProfileAction : HypenAction {
    data object SetTheme : ProfileAction
}

val profileModule = hypen(ProfileState()) {
    name("Profile")

    ui("""
        Column {
            Text("@{state.name}")
                .fontSize(24)
                .fontWeight(bold)
            Text("@{state.bio}")
                .color(gray)
            Column {
                Input(placeholder: "Name").bind(@state.name)
                Textarea(placeholder: "Bio").bind(@state.bio)
                Row {
                    Checkbox {}.bind(@state.newsletter)
                    Text("Subscribe to newsletter")
                }
                Row {
                    Switch {}.bind(@state.darkMode)
                    Text("Dark mode")
                }
                Row {
                    Button("@actions.SetTheme") { Text("Toggle theme") }
                }
            }
                .padding(16)
        }
    """.trimIndent())

    onCreated { state, _ ->
        log.info("Profile module created for user=${state.name}")
    }

    onAction<ProfileAction.SetTheme> { _, state, _ ->
        state.theme = if (state.theme == "dark") "light" else "dark"
        log.debug("Theme toggled to ${state.theme}")
    }

    // Session lifecycle: called when the client disconnects
    onDisconnect { state, session ->
        log.info("Profile state saved for session=${session.id} (user=${state.name})")
    }

    // Session lifecycle: called when a client reconnects to a suspended session
    onReconnect { session, restore ->
        log.info("Profile state restored for session=${session.id}")
    }

    // Error handler: catches errors gracefully
    onError { ctx ->
        log.error("Error in profile: ${ctx.error.message}", ctx.actionName ?: ctx.lifecycle ?: "")
        ErrorHandlerResult.Handled
    }
}
