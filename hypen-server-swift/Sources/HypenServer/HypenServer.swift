/// HypenServer — Swift SDK for building server-driven Hypen applications.
///
/// This package provides the module system for building Hypen applications
/// in Swift, including state management, action handling, lifecycle hooks,
/// and a WebSocket server for streaming UI to connected clients.
///
/// ## Quick Start
///
/// ```swift
/// import HypenServer
///
/// let server = RemoteServer()
///     .withState("Counter", ["count": 0])
///     .onAction { action, payload, state in
///         if action == "increment" {
///             var newState = state
///             newState["count"] = (state["count"] as? Int ?? 0) + 1
///             return newState
///         }
///         return nil
///     }
///     .ui("""
///         Column {
///             Text("Count: @{state.count}")
///             Button("@actions.increment") { Text("+") }
///         }
///     """)
///     .listen(3000)
/// ```
///
/// ## Module System
///
/// Use `AppBuilder` for more structured module definitions:
///
/// ```swift
/// let counter = AppBuilder(["count": 0])
///     .onCreated { state in
///         print("Module created with count: \(state.get("count") ?? 0)")
///     }
///     .onAction("increment") { ctx in
///         let count = ctx.state.get("count") as? Int ?? 0
///         ctx.state.set("count", count + 1)
///     }
///     .onAction("reset") { ctx in
///         ctx.state.set("count", 0)
///     }
///     .ui("""
///         Column {
///             Text("Count: @{state.count}")
///             Button("@actions.increment") { Text("+") }
///             Button("@actions.reset") { Text("Reset") }
///         }
///     """)
/// ```
public enum HypenServerVersion {
    public static let version = "0.5.4"
}
