// Package remote provides WebSocket-based Remote UI for Hypen apps.
//
// This package enables streaming Hypen applications over WebSocket,
// allowing server-side rendering with client-side display.
//
// # Server
//
// Create a WebSocket server that streams UI to connected clients:
//
//	server := remote.NewRemoteServer().
//	    WithState("Counter", map[string]any{"count": 0}).
//	    OnAction(func(action string, payload any, state map[string]any) map[string]any {
//	        if action == "increment" {
//	            state["count"] = state["count"].(int) + 1
//	        }
//	        return state
//	    }).
//	    UI(`Column { Text("Count: @{state.count}") }`).
//	    Listen(3000)
//
//	defer server.Stop()
//
// # Client
//
// Connect to a remote Hypen server:
//
//	client := remote.NewRemoteEngine("ws://localhost:3000/ws", nil).
//	    OnPatches(func(patches []remote.Patch) {
//	        // Apply patches to local renderer
//	    }).
//	    OnStateUpdate(func(state any) {
//	        // Handle state updates
//	    })
//
//	client.Connect()
//	defer client.Disconnect()
//
//	client.DispatchAction("increment", nil)
//
// # Protocol
//
// The Remote UI protocol uses JSON messages over WebSocket:
//
//   - initialTree: Sent on connection with initial state and patches
//   - patch: Incremental UI updates
//   - stateUpdate: Full state synchronization
//   - dispatchAction: Client-to-server action dispatch
//
// # Features
//
//   - Auto-reconnect with configurable retry logic
//   - Revision tracking for ordered patch application
//   - Connection state callbacks (connect, disconnect, error)
//   - Multi-client support with per-client state
//   - Broadcast capabilities for server-push updates
package remote
