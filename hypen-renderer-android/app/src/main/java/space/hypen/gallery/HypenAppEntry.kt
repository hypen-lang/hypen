package space.hypen.gallery

import kotlinx.serialization.Serializable

/**
 * Represents a Hypen app entry in the gallery.
 */
@Serializable
data class HypenAppEntry(
    val id: String,
    val name: String,
    val url: String,
    val description: String = "",
    val iconUrl: String? = null,
    val lastConnected: Long = 0L,
    val isBuiltIn: Boolean = false,
)

/**
 * Built-in apps that are always shown in the gallery.
 */
object BuiltInApps {
    val apps = listOf(
        HypenAppEntry(
            id = "counter",
            name = "Counter",
            url = "ws://10.0.2.2:3000",
            description = "A simple counter demo app",
            isBuiltIn = true,
        ),
        HypenAppEntry(
            id = "todo",
            name = "Todo List",
            url = "ws://10.0.2.2:3001",
            description = "Manage your tasks",
            isBuiltIn = true,
        ),
        HypenAppEntry(
            id = "weather",
            name = "Weather",
            url = "ws://10.0.2.2:3002",
            description = "Check the weather forecast",
            isBuiltIn = true,
        ),
        HypenAppEntry(
            id = "notes",
            name = "Notes",
            url = "ws://10.0.2.2:3003",
            description = "Quick note taking app",
            isBuiltIn = true,
        ),
        HypenAppEntry(
            id = "calculator",
            name = "Calculator",
            url = "ws://10.0.2.2:3004",
            description = "Basic calculator",
            isBuiltIn = true,
        ),
        HypenAppEntry(
            id = "profile",
            name = "Profile",
            url = "ws://10.0.2.2:3005",
            description = "User profile demo",
            isBuiltIn = true,
        ),
    )
}
