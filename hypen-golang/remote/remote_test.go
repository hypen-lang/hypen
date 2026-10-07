package remote

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// ============ Types Tests ============

func TestMessageType_Constants(t *testing.T) {
	if MessageTypeInitialTree != "initialTree" {
		t.Errorf("expected 'initialTree', got %s", MessageTypeInitialTree)
	}
	if MessageTypePatch != "patch" {
		t.Errorf("expected 'patch', got %s", MessageTypePatch)
	}
	if MessageTypeStateUpdate != "stateUpdate" {
		t.Errorf("expected 'stateUpdate', got %s", MessageTypeStateUpdate)
	}
	if MessageTypeDispatchAction != "dispatchAction" {
		t.Errorf("expected 'dispatchAction', got %s", MessageTypeDispatchAction)
	}
}

func TestConnectionState_Constants(t *testing.T) {
	if StateDisconnected != "disconnected" {
		t.Errorf("expected 'disconnected', got %s", StateDisconnected)
	}
	if StateConnecting != "connecting" {
		t.Errorf("expected 'connecting', got %s", StateConnecting)
	}
	if StateConnected != "connected" {
		t.Errorf("expected 'connected', got %s", StateConnected)
	}
	if StateError != "error" {
		t.Errorf("expected 'error', got %s", StateError)
	}
}

func TestDefaultEngineOptions(t *testing.T) {
	opts := DefaultEngineOptions()

	if !opts.AutoReconnect {
		t.Error("expected AutoReconnect to be true")
	}
	if opts.ReconnectInterval != 3*time.Second {
		t.Errorf("expected ReconnectInterval 3s, got %v", opts.ReconnectInterval)
	}
	if opts.MaxReconnectAttempts != 10 {
		t.Errorf("expected MaxReconnectAttempts 10, got %d", opts.MaxReconnectAttempts)
	}
}

func TestInitialTreeMessage_GetType(t *testing.T) {
	msg := &InitialTreeMessage{Type: MessageTypeInitialTree}
	if msg.GetType() != MessageTypeInitialTree {
		t.Errorf("expected %s, got %s", MessageTypeInitialTree, msg.GetType())
	}
}

func TestPatchMessage_GetType(t *testing.T) {
	msg := &PatchMessage{Type: MessageTypePatch}
	if msg.GetType() != MessageTypePatch {
		t.Errorf("expected %s, got %s", MessageTypePatch, msg.GetType())
	}
}

func TestStateUpdateMessage_GetType(t *testing.T) {
	msg := &StateUpdateMessage{Type: MessageTypeStateUpdate}
	if msg.GetType() != MessageTypeStateUpdate {
		t.Errorf("expected %s, got %s", MessageTypeStateUpdate, msg.GetType())
	}
}

func TestDispatchActionMessage_GetType(t *testing.T) {
	msg := &DispatchActionMessage{Type: MessageTypeDispatchAction}
	if msg.GetType() != MessageTypeDispatchAction {
		t.Errorf("expected %s, got %s", MessageTypeDispatchAction, msg.GetType())
	}
}

func TestPatch_JSON(t *testing.T) {
	patch := Patch{
		Type:        "create",
		ID:          "node_1",
		ElementType: "Text",
		Props:       map[string]any{"text": "Hello"},
	}

	data, err := json.Marshal(patch)
	if err != nil {
		t.Fatalf("failed to marshal: %v", err)
	}

	var decoded Patch
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("failed to unmarshal: %v", err)
	}

	if decoded.Type != "create" {
		t.Errorf("expected type 'create', got %s", decoded.Type)
	}
	if decoded.ID != "node_1" {
		t.Errorf("expected id 'node_1', got %s", decoded.ID)
	}
}

func TestInitialTreeMessage_JSON(t *testing.T) {
	msg := InitialTreeMessage{
		Type:     MessageTypeInitialTree,
		Module:   "Counter",
		State:    map[string]any{"count": 0},
		Patches:  []Patch{{Type: "create", ID: "1"}},
		Revision: 0,
	}

	data, err := json.Marshal(msg)
	if err != nil {
		t.Fatalf("failed to marshal: %v", err)
	}

	var decoded InitialTreeMessage
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("failed to unmarshal: %v", err)
	}

	if decoded.Type != MessageTypeInitialTree {
		t.Errorf("expected type 'initialTree', got %s", decoded.Type)
	}
	if decoded.Module != "Counter" {
		t.Errorf("expected module 'Counter', got %s", decoded.Module)
	}
	if len(decoded.Patches) != 1 {
		t.Errorf("expected 1 patch, got %d", len(decoded.Patches))
	}
}

// ============ Client Tests ============

func TestNewRemoteEngine(t *testing.T) {
	engine := NewRemoteEngine("ws://localhost:3000/ws", nil)

	if engine.url != "ws://localhost:3000/ws" {
		t.Errorf("expected url 'ws://localhost:3000/ws', got %s", engine.url)
	}
	if engine.state != StateDisconnected {
		t.Errorf("expected state 'disconnected', got %s", engine.state)
	}
	if !engine.options.AutoReconnect {
		t.Error("expected AutoReconnect to be true by default")
	}
}

func TestNewRemoteEngine_WithOptions(t *testing.T) {
	opts := &EngineOptions{
		AutoReconnect:        false,
		ReconnectInterval:    5 * time.Second,
		MaxReconnectAttempts: 5,
	}

	engine := NewRemoteEngine("ws://localhost:3000/ws", opts)

	if engine.options.AutoReconnect {
		t.Error("expected AutoReconnect to be false")
	}
	if engine.options.ReconnectInterval != 5*time.Second {
		t.Errorf("expected ReconnectInterval 5s, got %v", engine.options.ReconnectInterval)
	}
	if engine.options.MaxReconnectAttempts != 5 {
		t.Errorf("expected MaxReconnectAttempts 5, got %d", engine.options.MaxReconnectAttempts)
	}
}

func TestRemoteEngine_GetConnectionState(t *testing.T) {
	engine := NewRemoteEngine("ws://localhost:3000/ws", nil)

	state := engine.GetConnectionState()
	if state != StateDisconnected {
		t.Errorf("expected 'disconnected', got %s", state)
	}
}

func TestRemoteEngine_GetCurrentState(t *testing.T) {
	engine := NewRemoteEngine("ws://localhost:3000/ws", nil)

	state := engine.GetCurrentState()
	if state != nil {
		t.Errorf("expected nil, got %v", state)
	}
}

func TestRemoteEngine_GetRevision(t *testing.T) {
	engine := NewRemoteEngine("ws://localhost:3000/ws", nil)

	rev := engine.GetRevision()
	if rev != 0 {
		t.Errorf("expected 0, got %d", rev)
	}
}

func TestRemoteEngine_CallbackChaining(t *testing.T) {
	engine := NewRemoteEngine("ws://localhost:3000/ws", nil)

	result := engine.
		OnPatches(func(patches []Patch) {}).
		OnStateUpdate(func(state any) {}).
		OnConnect(func() {}).
		OnDisconnect(func() {}).
		OnError(func(err error) {})

	if result != engine {
		t.Error("expected chained calls to return same engine")
	}
}

func TestRemoteEngine_DispatchAction_NotConnected(t *testing.T) {
	engine := NewRemoteEngine("ws://localhost:3000/ws", nil)

	err := engine.DispatchAction("test", nil)
	if err == nil {
		t.Error("expected error when not connected")
	}
	if !strings.Contains(err.Error(), "not connected") {
		t.Errorf("expected 'not connected' error, got %v", err)
	}
}

func TestRemoteEngine_Connect_InvalidURL(t *testing.T) {
	engine := NewRemoteEngine("not-a-valid-url", nil)

	err := engine.Connect()
	if err == nil {
		t.Error("expected error for invalid URL")
	}
}

// ============ Server Tests ============

func TestNewRemoteServer(t *testing.T) {
	server := NewRemoteServer()

	if server.moduleName != "App" {
		t.Errorf("expected moduleName 'App', got %s", server.moduleName)
	}
	if server.config.Port != 3000 {
		t.Errorf("expected port 3000, got %d", server.config.Port)
	}
	if server.config.Hostname != "0.0.0.0" {
		t.Errorf("expected hostname '0.0.0.0', got %s", server.config.Hostname)
	}
}

func TestRemoteServer_WithState(t *testing.T) {
	server := NewRemoteServer().
		WithState("Counter", map[string]any{"count": 0})

	if server.moduleName != "Counter" {
		t.Errorf("expected moduleName 'Counter', got %s", server.moduleName)
	}
	if server.module == nil {
		t.Fatal("expected module to be set")
	}
	if server.module.InitialState["count"] != 0 {
		t.Errorf("expected count 0, got %v", server.module.InitialState["count"])
	}
}

func TestRemoteServer_UI(t *testing.T) {
	server := NewRemoteServer().
		WithState("Test", map[string]any{}).
		UI("Text('Hello')")

	if server.ui != "Text('Hello')" {
		t.Errorf("expected UI 'Text('Hello')', got %s", server.ui)
	}
}

func TestRemoteServer_Config(t *testing.T) {
	server := NewRemoteServer().
		Config(ServerConfig{Port: 8080, Hostname: "localhost"})

	if server.config.Port != 8080 {
		t.Errorf("expected port 8080, got %d", server.config.Port)
	}
	if server.config.Hostname != "localhost" {
		t.Errorf("expected hostname 'localhost', got %s", server.config.Hostname)
	}
}

func TestRemoteServer_OnConnection(t *testing.T) {
	server := NewRemoteServer().
		OnConnection(func(client *Client) {
			// Callback registered
		})

	if len(server.onConnectionCallbacks) != 1 {
		t.Error("expected 1 connection callback")
	}
}

func TestRemoteServer_OnDisconnection(t *testing.T) {
	server := NewRemoteServer().
		OnDisconnection(func(client *Client) {
			// Callback registered
		})

	if len(server.onDisconnectionCallbacks) != 1 {
		t.Error("expected 1 disconnection callback")
	}
}

func TestRemoteServer_GetClientCount(t *testing.T) {
	server := NewRemoteServer()

	count := server.GetClientCount()
	if count != 0 {
		t.Errorf("expected 0 clients, got %d", count)
	}
}

func TestRemoteServer_Listen_PanicsWithoutModule(t *testing.T) {
	defer func() {
		if r := recover(); r == nil {
			t.Error("expected panic when module not set")
		}
	}()

	server := NewRemoteServer().
		UI("Text('Hello')")
	server.Listen(9999)
}

func TestRemoteServer_Listen_PanicsWithoutUI(t *testing.T) {
	defer func() {
		if r := recover(); r == nil {
			t.Error("expected panic when UI not set")
		}
	}()

	server := NewRemoteServer().
		WithState("Test", map[string]any{})
	server.Listen(9999)
}

func TestRemoteServer_GetURL(t *testing.T) {
	server := NewRemoteServer().
		Config(ServerConfig{Port: 8080, Hostname: "localhost"})

	url := server.GetURL()
	if url != "ws://localhost:8080/ws" {
		t.Errorf("expected 'ws://localhost:8080/ws', got %s", url)
	}
}

func TestRemoteServer_Chaining(t *testing.T) {
	server := NewRemoteServer().
		WithState("Counter", map[string]any{"count": 0}).
		UI("Text('Count')").
		Config(ServerConfig{Port: 8080}).
		OnConnection(func(client *Client) {}).
		OnDisconnection(func(client *Client) {})

	if server.moduleName != "Counter" {
		t.Error("chaining should preserve module name")
	}
	if server.ui != "Text('Count')" {
		t.Error("chaining should preserve UI")
	}
	if server.config.Port != 8080 {
		t.Error("chaining should preserve config")
	}
}

// ============ Integration Tests ============

// Helper to create a test WebSocket server
func createTestServer(t *testing.T) (*RemoteServer, *httptest.Server) {
	server := NewRemoteServer().
		WithState("Counter", map[string]any{"count": 0}).
		OnAction(func(action string, payload any, state map[string]any) map[string]any {
			if action == "increment" {
				count := state["count"].(int)
				state["count"] = count + 1
			}
			return state
		}).
		UI("Text('Count: @{state.count}')")

	// Create HTTP test server
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		upgrader := websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool { return true },
		}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Logf("upgrade error: %v", err)
			return
		}
		server.handleOpen(conn)
		go server.readMessages(conn)
	})

	httpServer := httptest.NewServer(mux)
	return server, httpServer
}

func TestIntegration_ClientConnectsToServer(t *testing.T) {
	server, httpServer := createTestServer(t)
	defer httpServer.Close()
	defer server.Stop()

	// Convert HTTP URL to WS URL
	wsURL := "ws" + strings.TrimPrefix(httpServer.URL, "http") + "/ws"

	// Track connection
	var connected bool
	var mu sync.Mutex

	client := NewRemoteEngine(wsURL, &EngineOptions{AutoReconnect: false})
	client.OnConnect(func() {
		mu.Lock()
		connected = true
		mu.Unlock()
	})

	err := client.Connect()
	if err != nil {
		t.Fatalf("failed to connect: %v", err)
	}
	defer client.Disconnect()

	// Wait for connection
	time.Sleep(100 * time.Millisecond)

	mu.Lock()
	if !connected {
		t.Error("expected OnConnect to be called")
	}
	mu.Unlock()

	if client.GetConnectionState() != StateConnected {
		t.Errorf("expected state 'connected', got %s", client.GetConnectionState())
	}
}

func TestIntegration_ClientReceivesInitialTree(t *testing.T) {
	server, httpServer := createTestServer(t)
	defer httpServer.Close()
	defer server.Stop()

	wsURL := "ws" + strings.TrimPrefix(httpServer.URL, "http") + "/ws"

	var receivedState any
	var mu sync.Mutex

	client := NewRemoteEngine(wsURL, &EngineOptions{AutoReconnect: false})
	client.OnStateUpdate(func(state any) {
		mu.Lock()
		receivedState = state
		mu.Unlock()
	})

	err := client.Connect()
	if err != nil {
		t.Fatalf("failed to connect: %v", err)
	}
	defer client.Disconnect()

	// Wait for initial tree (server waits 1s for hello before sending to legacy clients)
	time.Sleep(1500 * time.Millisecond)

	mu.Lock()
	if receivedState == nil {
		t.Error("expected to receive initial state")
	}
	mu.Unlock()

	currentState := client.GetCurrentState()
	if currentState == nil {
		t.Error("expected current state to be set")
	}
}

func TestIntegration_ClientDispatchesAction(t *testing.T) {
	server, httpServer := createTestServer(t)
	defer httpServer.Close()
	defer server.Stop()

	wsURL := "ws" + strings.TrimPrefix(httpServer.URL, "http") + "/ws"

	var stateUpdates []any
	var mu sync.Mutex

	client := NewRemoteEngine(wsURL, &EngineOptions{AutoReconnect: false})
	client.OnStateUpdate(func(state any) {
		mu.Lock()
		stateUpdates = append(stateUpdates, state)
		mu.Unlock()
	})

	err := client.Connect()
	if err != nil {
		t.Fatalf("failed to connect: %v", err)
	}
	defer client.Disconnect()

	// Wait for initial tree (server waits 1s for hello before sending to legacy clients)
	time.Sleep(1500 * time.Millisecond)

	// Dispatch increment action
	err = client.DispatchAction("increment", nil)
	if err != nil {
		t.Fatalf("failed to dispatch action: %v", err)
	}

	// Wait for state update
	time.Sleep(200 * time.Millisecond)

	mu.Lock()
	// Should have initial state + update after action
	if len(stateUpdates) < 2 {
		t.Errorf("expected at least 2 state updates, got %d", len(stateUpdates))
	}
	mu.Unlock()
}

func TestIntegration_ServerTracksClients(t *testing.T) {
	server, httpServer := createTestServer(t)
	defer httpServer.Close()
	defer server.Stop()

	wsURL := "ws" + strings.TrimPrefix(httpServer.URL, "http") + "/ws"

	client := NewRemoteEngine(wsURL, &EngineOptions{AutoReconnect: false})
	err := client.Connect()
	if err != nil {
		t.Fatalf("failed to connect: %v", err)
	}

	// Wait for connection to be registered
	time.Sleep(100 * time.Millisecond)

	count := server.GetClientCount()
	if count != 1 {
		t.Errorf("expected 1 client, got %d", count)
	}

	client.Disconnect()

	// Wait for disconnection
	time.Sleep(100 * time.Millisecond)

	count = server.GetClientCount()
	if count != 0 {
		t.Errorf("expected 0 clients after disconnect, got %d", count)
	}
}

func TestIntegration_MultipleClients(t *testing.T) {
	server, httpServer := createTestServer(t)
	defer httpServer.Close()
	defer server.Stop()

	wsURL := "ws" + strings.TrimPrefix(httpServer.URL, "http") + "/ws"

	clients := make([]*RemoteEngine, 3)
	for i := 0; i < 3; i++ {
		clients[i] = NewRemoteEngine(wsURL, &EngineOptions{AutoReconnect: false})
		err := clients[i].Connect()
		if err != nil {
			t.Fatalf("failed to connect client %d: %v", i, err)
		}
	}

	// Wait for all connections
	time.Sleep(100 * time.Millisecond)

	count := server.GetClientCount()
	if count != 3 {
		t.Errorf("expected 3 clients, got %d", count)
	}

	// Disconnect all
	for _, client := range clients {
		client.Disconnect()
	}

	time.Sleep(100 * time.Millisecond)

	count = server.GetClientCount()
	if count != 0 {
		t.Errorf("expected 0 clients, got %d", count)
	}
}

func TestIntegration_ConnectionCallbacks(t *testing.T) {
	var connectCalled, disconnectCalled bool
	var mu sync.Mutex

	server := NewRemoteServer().
		WithState("Test", map[string]any{}).
		UI("Text('Hello')").
		OnConnection(func(client *Client) {
			mu.Lock()
			connectCalled = true
			mu.Unlock()
		}).
		OnDisconnection(func(client *Client) {
			mu.Lock()
			disconnectCalled = true
			mu.Unlock()
		})

	// Create HTTP test server
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		upgrader := websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool { return true },
		}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		server.handleOpen(conn)
		go server.readMessages(conn)
	})

	httpServer := httptest.NewServer(mux)
	defer httpServer.Close()
	defer server.Stop()

	wsURL := "ws" + strings.TrimPrefix(httpServer.URL, "http") + "/ws"

	client := NewRemoteEngine(wsURL, &EngineOptions{AutoReconnect: false})
	err := client.Connect()
	if err != nil {
		t.Fatalf("failed to connect: %v", err)
	}

	// Server waits up to 1s for a "hello" message before treating the client as
	// legacy and sending sessionAck + initialTree (which fires connection callbacks).
	time.Sleep(1500 * time.Millisecond)

	mu.Lock()
	if !connectCalled {
		t.Error("expected connection callback to be called")
	}
	mu.Unlock()

	client.Disconnect()
	time.Sleep(200 * time.Millisecond)

	mu.Lock()
	if !disconnectCalled {
		t.Error("expected disconnection callback to be called")
	}
	mu.Unlock()
}

func TestIntegration_BroadcastPatches(t *testing.T) {
	server, httpServer := createTestServer(t)
	defer httpServer.Close()
	defer server.Stop()

	wsURL := "ws" + strings.TrimPrefix(httpServer.URL, "http") + "/ws"

	var patchesCalled int
	var mu sync.Mutex

	client := NewRemoteEngine(wsURL, &EngineOptions{AutoReconnect: false})
	client.OnPatches(func(patches []Patch) {
		mu.Lock()
		patchesCalled++
		mu.Unlock()
	})

	err := client.Connect()
	if err != nil {
		t.Fatalf("failed to connect: %v", err)
	}
	defer client.Disconnect()

	time.Sleep(100 * time.Millisecond)

	// Broadcast patches from server
	patches := []Patch{
		{Type: "create", ID: "test_1", ElementType: "Text"},
	}
	server.BroadcastPatches(patches)

	time.Sleep(100 * time.Millisecond)

	mu.Lock()
	if patchesCalled < 1 {
		t.Error("expected patches callback to be called")
	}
	mu.Unlock()
}

func TestIntegration_OutOfOrderPatches(t *testing.T) {
	// Test that out-of-order patches are rejected
	engine := NewRemoteEngine("ws://localhost:3000/ws", nil)

	// Simulate receiving initial tree
	initialData, _ := json.Marshal(RawMessage{
		Type:     MessageTypeInitialTree,
		Module:   "Test",
		State:    map[string]any{"count": 0},
		Revision: 5,
	})
	engine.handleMessage(initialData)

	if engine.GetRevision() != 5 {
		t.Errorf("expected revision 5, got %d", engine.GetRevision())
	}

	// Simulate receiving out-of-order patch (revision 3, should be ignored)
	patchData, _ := json.Marshal(RawMessage{
		Type:     MessageTypePatch,
		Module:   "Test",
		Patches:  []Patch{{Type: "create", ID: "1"}},
		Revision: 3, // Old revision
	})
	engine.handleMessage(patchData)

	// Revision should still be 5
	if engine.GetRevision() != 5 {
		t.Errorf("expected revision to remain 5, got %d", engine.GetRevision())
	}

	// Simulate receiving valid patch (revision 6)
	validPatchData, _ := json.Marshal(RawMessage{
		Type:     MessageTypePatch,
		Module:   "Test",
		Patches:  []Patch{{Type: "create", ID: "1"}},
		Revision: 6,
	})
	engine.handleMessage(validPatchData)

	if engine.GetRevision() != 6 {
		t.Errorf("expected revision 6, got %d", engine.GetRevision())
	}
}

func TestIntegration_ErrorCallback(t *testing.T) {
	var errorCalled bool
	var mu sync.Mutex

	engine := NewRemoteEngine("ws://localhost:3000/ws", &EngineOptions{AutoReconnect: false})
	engine.OnError(func(err error) {
		mu.Lock()
		errorCalled = true
		mu.Unlock()
	})

	// Try to connect to non-existent server
	_ = engine.Connect()

	time.Sleep(100 * time.Millisecond)

	mu.Lock()
	if !errorCalled {
		t.Error("expected error callback to be called")
	}
	mu.Unlock()
}

func TestClient_ConcurrentAccess(t *testing.T) {
	engine := NewRemoteEngine("ws://localhost:3000/ws", nil)

	var wg sync.WaitGroup

	// Concurrent reads
	for i := 0; i < 100; i++ {
		wg.Add(3)
		go func() {
			defer wg.Done()
			_ = engine.GetConnectionState()
		}()
		go func() {
			defer wg.Done()
			_ = engine.GetCurrentState()
		}()
		go func() {
			defer wg.Done()
			_ = engine.GetRevision()
		}()
	}

	wg.Wait()
	// If we get here without panics, concurrent access is safe
}

func TestServer_ConcurrentAccess(t *testing.T) {
	server := NewRemoteServer().
		WithState("Test", map[string]any{}).
		UI("Text('Hello')")

	var wg sync.WaitGroup

	// Concurrent reads
	for i := 0; i < 100; i++ {
		wg.Add(2)
		go func() {
			defer wg.Done()
			_ = server.GetClientCount()
		}()
		go func() {
			defer wg.Done()
			_ = server.GetURL()
		}()
	}

	wg.Wait()
	// If we get here without panics, concurrent access is safe
}

// ============ Compression Tests ============

// Compression is on by default, device plane or not: gorilla negotiates
// it with no context takeover in both directions (every message deflated
// on its own), which the device plane allows.
func TestRemoteServer_CompressionEnabledByDefault(t *testing.T) {
	server := NewRemoteServer()

	if server.config.DisableCompression {
		t.Error("expected compression to be enabled by default")
	}
	if !server.DeviceEnabled() {
		t.Error("expected the device plane to be on by default")
	}
	if !server.CompressionEnabled() {
		t.Error("expected CompressionEnabled() to report true by default (device plane on)")
	}
	if !server.Upgrader().EnableCompression {
		t.Error("expected upgrader to offer permessage-deflate by default (device plane on)")
	}

	// Turning the device plane off does not change compression.
	server.DisableDevice()
	if !server.CompressionEnabled() || !server.Upgrader().EnableCompression {
		t.Error("expected compression to stay on with the device plane off")
	}
}

func TestRemoteServer_DisableCompression(t *testing.T) {
	server := NewRemoteServer().DisableCompression()

	if !server.config.DisableCompression {
		t.Error("expected DisableCompression() to set config.DisableCompression")
	}
	if server.CompressionEnabled() {
		t.Error("expected CompressionEnabled() to report false")
	}
	if server.Upgrader().EnableCompression {
		t.Error("expected upgrader to stop offering permessage-deflate")
	}
}

func TestRemoteServer_Config_Compression(t *testing.T) {
	// A config that says nothing about compression must leave it on —
	// this is the whole reason the field is phrased negatively.
	server := NewRemoteServer().
		Config(ServerConfig{Port: 8080, Hostname: "localhost"})

	if !server.CompressionEnabled() {
		t.Error("expected zero-value DisableCompression to keep compression on")
	}
	if !server.Upgrader().EnableCompression {
		t.Error("expected upgrader to still offer permessage-deflate")
	}

	server.Config(ServerConfig{DisableCompression: true})
	if server.CompressionEnabled() {
		t.Error("expected Config to be able to turn compression off")
	}
	if server.Upgrader().EnableCompression {
		t.Error("expected upgrader compression to follow the config")
	}

	// ...and back on again.
	server.Config(ServerConfig{})
	if !server.CompressionEnabled() {
		t.Error("expected Config to be able to turn compression back on")
	}
}

func TestEngineOptions_CompressionDefaults(t *testing.T) {
	if DefaultEngineOptions().DisableCompression {
		t.Error("expected client compression to be enabled by default")
	}

	engine := NewRemoteEngine("ws://localhost:3000", nil)
	if engine.options.DisableCompression {
		t.Error("expected nil options to keep compression enabled")
	}

	engine = NewRemoteEngine("ws://localhost:3000", &EngineOptions{AutoReconnect: false})
	if engine.options.DisableCompression {
		t.Error("expected zero-value DisableCompression to keep compression enabled")
	}

	engine = NewRemoteEngine("ws://localhost:3000", &EngineOptions{DisableCompression: true})
	if !engine.options.DisableCompression {
		t.Error("expected DisableCompression to be honoured")
	}
}

// compressionTestServer stands up a counter app behind the server's own
// Upgrader (the one Listen() uses), and records the Sec-WebSocket-Extensions
// header each client offers.
func compressionTestServer(t *testing.T, configure func(*RemoteServer)) (*RemoteServer, *httptest.Server, func() string) {
	t.Helper()

	server := NewRemoteServer().
		WithState("Counter", map[string]any{"count": 0}).
		OnAction(func(action string, payload any, state map[string]any) map[string]any {
			if action == "increment" {
				count, _ := state["count"].(int)
				state["count"] = count + 1
			}
			return state
		}).
		UI("Text('Count: @{state.count}')")

	if configure != nil {
		configure(server)
	}

	var mu sync.Mutex
	var offered string

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		offered = r.Header.Get("Sec-WebSocket-Extensions")
		mu.Unlock()

		// Use the server's configured upgrader rather than a hand-rolled
		// one, so custom endpoints inherit the compression setting.
		upgrader := server.Upgrader()
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Logf("upgrade error: %v", err)
			return
		}
		server.handleOpen(conn)
		go server.readMessages(conn)
	})

	httpServer := httptest.NewServer(mux)
	return server, httpServer, func() string {
		mu.Lock()
		defer mu.Unlock()
		return offered
	}
}

// readUntil pumps frames off conn until one of the wanted message types
// arrives, or the deadline expires.
func readUntil(t *testing.T, conn *websocket.Conn, want MessageType) map[string]any {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	for i := 0; i < 20; i++ {
		_, data, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("read %s: %v", want, err)
		}
		var msg map[string]any
		if err := json.Unmarshal(data, &msg); err != nil {
			t.Fatalf("unmarshal %s: %v (raw=%q)", want, err, data)
		}
		if msg["type"] == string(want) {
			return msg
		}
	}
	t.Fatalf("never received %s", want)
	return nil
}

func TestIntegration_CompressedHandshakeAndRoundTrip(t *testing.T) {
	// Default server: device plane on, compression offered.
	server, httpServer, _ := compressionTestServer(t, nil)
	defer httpServer.Close()
	defer server.Stop()

	wsURL := "ws" + strings.TrimPrefix(httpServer.URL, "http") + "/ws"

	dialer := *websocket.DefaultDialer
	dialer.EnableCompression = true

	conn, resp, err := dialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial ws: %v", err)
	}
	defer conn.Close()

	// The server must have echoed the extension back in the 101 response
	// with no context takeover in BOTH directions (the only mode gorilla
	// implements, and the one the device plane requires).
	negotiated := resp.Header.Get("Sec-WebSocket-Extensions")
	if !strings.Contains(negotiated, "permessage-deflate") {
		t.Fatalf("expected permessage-deflate to be negotiated, got %q", negotiated)
	}
	for _, param := range []string{"server_no_context_takeover", "client_no_context_takeover"} {
		if !strings.Contains(negotiated, param) {
			t.Errorf("expected %s in the negotiated extension, got %q", param, negotiated)
		}
	}

	// The protocol must still work end-to-end over the compressed
	// connection: hello -> sessionAck -> initialTree -> action -> state.
	if err := conn.WriteJSON(map[string]any{"type": string(MessageTypeHello)}); err != nil {
		t.Fatalf("write hello: %v", err)
	}

	ack := readUntil(t, conn, MessageTypeSessionAck)
	if ack["sessionId"] == "" || ack["sessionId"] == nil {
		t.Error("expected sessionAck to carry a session id")
	}

	tree := readUntil(t, conn, MessageTypeInitialTree)
	if tree["module"] != "Counter" {
		t.Errorf("expected module 'Counter', got %v", tree["module"])
	}
	state, ok := tree["state"].(map[string]any)
	if !ok {
		t.Fatalf("expected initialTree state map, got %T", tree["state"])
	}
	if state["count"] != float64(0) {
		t.Errorf("expected initial count 0, got %v", state["count"])
	}

	if err := conn.WriteJSON(map[string]any{
		"type":   string(MessageTypeDispatchAction),
		"module": "Counter",
		"action": "increment",
	}); err != nil {
		t.Fatalf("write dispatchAction: %v", err)
	}

	update := readUntil(t, conn, MessageTypeStateUpdate)
	newState, ok := update["state"].(map[string]any)
	if !ok {
		t.Fatalf("expected stateUpdate state map, got %T", update["state"])
	}
	if newState["count"] != float64(1) {
		t.Errorf("expected count 1 after increment, got %v", newState["count"])
	}
}

func TestIntegration_CompressionDisabledSkipsNegotiation(t *testing.T) {
	server, httpServer, _ := compressionTestServer(t, func(s *RemoteServer) {
		s.DisableCompression()
	})
	defer httpServer.Close()
	defer server.Stop()

	wsURL := "ws" + strings.TrimPrefix(httpServer.URL, "http") + "/ws"

	dialer := *websocket.DefaultDialer
	dialer.EnableCompression = true

	conn, resp, err := dialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial ws: %v", err)
	}
	defer conn.Close()

	if got := resp.Header.Get("Sec-WebSocket-Extensions"); got != "" {
		t.Errorf("expected no extension when the server opts out, got %q", got)
	}

	// A compression-less connection must behave identically.
	if err := conn.WriteJSON(map[string]any{"type": string(MessageTypeHello)}); err != nil {
		t.Fatalf("write hello: %v", err)
	}
	tree := readUntil(t, conn, MessageTypeInitialTree)
	if tree["module"] != "Counter" {
		t.Errorf("expected module 'Counter', got %v", tree["module"])
	}
}

func TestIntegration_UncompressedClientFallsBack(t *testing.T) {
	// Server offers permessage-deflate; a client that doesn't ask for it
	// must still connect and speak the protocol uncompressed.
	server, httpServer, _ := compressionTestServer(t, nil)
	defer httpServer.Close()
	defer server.Stop()

	wsURL := "ws" + strings.TrimPrefix(httpServer.URL, "http") + "/ws"

	dialer := *websocket.DefaultDialer
	dialer.EnableCompression = false

	conn, resp, err := dialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial ws: %v", err)
	}
	defer conn.Close()

	if got := resp.Header.Get("Sec-WebSocket-Extensions"); got != "" {
		t.Errorf("expected no extension for a non-offering client, got %q", got)
	}

	if err := conn.WriteJSON(map[string]any{"type": string(MessageTypeHello)}); err != nil {
		t.Fatalf("write hello: %v", err)
	}
	tree := readUntil(t, conn, MessageTypeInitialTree)
	if tree["module"] != "Counter" {
		t.Errorf("expected module 'Counter', got %v", tree["module"])
	}
}

func TestIntegration_RemoteEngineOffersCompression(t *testing.T) {
	server, httpServer, offered := compressionTestServer(t, nil)
	defer httpServer.Close()
	defer server.Stop()

	wsURL := "ws" + strings.TrimPrefix(httpServer.URL, "http") + "/ws"

	client := NewRemoteEngine(wsURL, &EngineOptions{AutoReconnect: false})
	if err := client.Connect(); err != nil {
		t.Fatalf("failed to connect: %v", err)
	}
	defer client.Disconnect()

	if got := offered(); !strings.Contains(got, "permessage-deflate") {
		t.Errorf("expected RemoteEngine to offer permessage-deflate, got %q", got)
	}
}

func TestIntegration_RemoteEngineCompressedRoundTrip(t *testing.T) {
	server, httpServer, _ := compressionTestServer(t, nil)
	defer httpServer.Close()
	defer server.Stop()

	wsURL := "ws" + strings.TrimPrefix(httpServer.URL, "http") + "/ws"

	var stateUpdates []any
	var mu sync.Mutex

	client := NewRemoteEngine(wsURL, &EngineOptions{AutoReconnect: false})
	client.OnStateUpdate(func(state any) {
		mu.Lock()
		stateUpdates = append(stateUpdates, state)
		mu.Unlock()
	})

	if err := client.Connect(); err != nil {
		t.Fatalf("failed to connect: %v", err)
	}
	defer client.Disconnect()

	// waitForUpdates polls until n state updates arrived. A fixed sleep
	// raced the server: the grace-timer initialisation compiles the WASM
	// engine before it sends initialTree, which can take longer than the
	// old 1.5 s window, so the dispatch then took the legacy path and the
	// initialTree arrived after the assertion.
	waitForUpdates := func(n int, within time.Duration) {
		t.Helper()
		deadline := time.Now().Add(within)
		for {
			mu.Lock()
			got := len(stateUpdates)
			mu.Unlock()
			if got >= n {
				return
			}
			if time.Now().After(deadline) {
				t.Fatalf("expected at least %d state updates over a compressed connection, got %d", n, got)
			}
			time.Sleep(10 * time.Millisecond)
		}
	}

	// The engine client doesn't send hello, so the server falls back to
	// its 1s legacy grace timer before sending initialTree.
	waitForUpdates(1, 30*time.Second)

	if err := client.DispatchAction("increment", nil); err != nil {
		t.Fatalf("failed to dispatch action: %v", err)
	}
	waitForUpdates(2, 10*time.Second)

	mu.Lock()
	defer mu.Unlock()
	if len(stateUpdates) < 2 {
		t.Fatalf("expected at least 2 state updates over a compressed connection, got %d", len(stateUpdates))
	}
	last, ok := stateUpdates[len(stateUpdates)-1].(map[string]any)
	if !ok {
		t.Fatalf("expected state map, got %T", stateUpdates[len(stateUpdates)-1])
	}
	if last["count"] != float64(1) {
		t.Errorf("expected count 1 after increment, got %v", last["count"])
	}
}
