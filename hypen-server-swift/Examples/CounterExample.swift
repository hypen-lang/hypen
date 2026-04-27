/// Example: Counter module using the simple server API.
///
/// Run with:
/// ```
/// swift run CounterExample
/// ```
///
/// Connect from an iOS client:
/// ```swift
/// HypenView(url: "ws://localhost:3000/ws")
/// ```

import Foundation
import HypenServer

// MARK: - Simple API (like Go SDK)

func counterSimple() {
    let _ = RemoteServer()
        .withState("Counter", ["count": 0])
        .onAction { action, _, state in
            switch action {
            case "increment":
                var newState = state
                newState["count"] = (state["count"] as? Int ?? 0) + 1
                return newState
            case "decrement":
                var newState = state
                newState["count"] = (state["count"] as? Int ?? 0) - 1
                return newState
            case "reset":
                var newState = state
                newState["count"] = 0
                return newState
            default:
                return nil
            }
        }
        .ui("""
            Column {
                Text("Count: @{state.count}")
                    .fontSize(24)
                Row {
                    Button("@actions.decrement") { Text("-") }
                    Button("@actions.reset") { Text("Reset") }
                    Button("@actions.increment") { Text("+") }
                }
            }
        """)
        .onConnection { client in
            print("Client connected: \(client.id)")
        }
        .onDisconnection { client in
            print("Client disconnected: \(client.id)")
        }
        .listen(3000)
}

// MARK: - AppBuilder API (like Kotlin SDK)

func counterWithBuilder() {
    let counterModule = AppBuilder(["count": 0])
        .onCreated { state in
            print("Counter module created, initial count: \(state.get("count") ?? 0)")
        }
        .onAction("increment") { ctx in
            let count = ctx.state.get("count") as? Int ?? 0
            ctx.state.set("count", count + 1)
        }
        .onAction("decrement") { ctx in
            let count = ctx.state.get("count") as? Int ?? 0
            ctx.state.set("count", count - 1)
        }
        .onAction("reset") { ctx in
            ctx.state.set("count", 0)
        }
        .onDestroyed { state in
            print("Counter module destroyed, final count: \(state.get("count") ?? 0)")
        }
        .ui("""
            Column {
                Text("Count: @{state.count}")
                    .fontSize(24)
                Row {
                    Button("@actions.decrement") { Text("-") }
                    Button("@actions.reset") { Text("Reset") }
                    Button("@actions.increment") { Text("+") }
                }
            }
        """)

    let _ = RemoteServer()
        .module("Counter", counterModule)
        .ui("""
            Column {
                Text("Count: @{state.count}")
                    .fontSize(24)
                Row {
                    Button("@actions.decrement") { Text("-") }
                    Button("@actions.reset") { Text("Reset") }
                    Button("@actions.increment") { Text("+") }
                }
            }
        """)
        .listen(3000)
}

// MARK: - Todo App Example

func todoApp() {
    let todoModule = AppBuilder(["todos": [] as [Any], "input": ""])
        .onAction("add") { ctx in
            let input = ctx.state.get("input") as? String ?? ""
            guard !input.isEmpty else { return }

            var todos = ctx.state.get("todos") as? [[String: Any]] ?? []
            todos.append([
                "id": UUID().uuidString,
                "text": input,
                "done": false
            ])
            ctx.state.set("todos", todos)
            ctx.state.set("input", "")
        }
        .onAction("toggle") { ctx in
            guard let id = ctx.action.payload as? String else { return }
            var todos = ctx.state.get("todos") as? [[String: Any]] ?? []
            if let index = todos.firstIndex(where: { $0["id"] as? String == id }) {
                todos[index]["done"] = !(todos[index]["done"] as? Bool ?? false)
                ctx.state.set("todos", todos)
            }
        }
        .onAction("remove") { ctx in
            guard let id = ctx.action.payload as? String else { return }
            var todos = ctx.state.get("todos") as? [[String: Any]] ?? []
            todos.removeAll { $0["id"] as? String == id }
            ctx.state.set("todos", todos)
        }
        .ui("""
            Column {
                Text("Todo List")
                    .fontSize(24)
                    .fontWeight(bold)
                Row {
                    Input(placeholder: "Add todo...").bind(@state.input)
                    Button("@actions.add") { Text("Add") }
                }
            }
        """)

    let _ = RemoteServer()
        .module("Todo", todoModule)
        .ui("""
            Column {
                Text("Todo List")
                    .fontSize(24)
                    .fontWeight(bold)
                Row {
                    Input(placeholder: "Add todo...").bind(@state.input)
                    Button("@actions.add") { Text("Add") }
                }
            }
        """)
        .listen(3001)
}

// MARK: - Convenience Function

func counterWithServe() {
    let _ = serve(
        moduleName: "Counter",
        initialState: ["count": 0],
        ui: """
            Column {
                Text("Count: @{state.count}")
                Button("@actions.increment") { Text("+") }
            }
        """,
        onAction: { action, _, state in
            if action == "increment" {
                var s = state
                s["count"] = (state["count"] as? Int ?? 0) + 1
                return s
            }
            return nil
        },
        port: 3002
    )
}
