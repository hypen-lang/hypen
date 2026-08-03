package remote

import (
	"encoding/json"
	"fmt"
	"net/url"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// PatchCallback is called when patches are received
type PatchCallback func(patches []Patch)

// StateCallback is called when state is updated
type StateCallback func(state any)

// ConnectionCallback is called on connect/disconnect
type ConnectionCallback func()

// ErrorCallback is called when an error occurs
type ErrorCallback func(err error)

// RemoteEngine connects to a remote Hypen app over WebSocket
type RemoteEngine struct {
	mu sync.RWMutex

	reconnectStopped bool
	url              string
	options EngineOptions
	conn    *websocket.Conn
	state   ConnectionState

	reconnectAttempts int
	stopReconnect     chan struct{}

	// Callbacks
	patchCallbacks       []PatchCallback
	stateCallbacks       []StateCallback
	connectionCallbacks  []ConnectionCallback
	disconnectCallbacks  []ConnectionCallback
	errorCallbacks       []ErrorCallback

	// State
	currentState    any
	currentRevision int
	moduleName      string

	// Done channel for graceful shutdown
	done chan struct{}
}

// NewRemoteEngine creates a new RemoteEngine client
func NewRemoteEngine(wsURL string, options *EngineOptions) *RemoteEngine {
	opts := DefaultEngineOptions()
	if options != nil {
		if options.ReconnectInterval > 0 {
			opts.ReconnectInterval = options.ReconnectInterval
		}
		if options.MaxReconnectAttempts > 0 {
			opts.MaxReconnectAttempts = options.MaxReconnectAttempts
		}
		opts.AutoReconnect = options.AutoReconnect
		opts.DisableCompression = options.DisableCompression
	}

	return &RemoteEngine{
		url:           wsURL,
		options:       opts,
		state:         StateDisconnected,
		stopReconnect: make(chan struct{}),
		done:          make(chan struct{}),
	}
}

// Connect establishes a WebSocket connection to the server
func (e *RemoteEngine) Connect() error {
	e.mu.Lock()
	if e.state == StateConnected || e.state == StateConnecting {
		e.mu.Unlock()
		return nil
	}
	e.state = StateConnecting
	// Reinitialize the stop channel so future reconnect goroutines can run
	if e.reconnectStopped {
		e.stopReconnect = make(chan struct{})
		e.reconnectStopped = false
	}
	e.mu.Unlock()

	u, err := url.Parse(e.url)
	if err != nil {
		e.setState(StateError)
		return fmt.Errorf("invalid URL: %w", err)
	}

	// Copy DefaultDialer so we keep its proxy/handshake-timeout defaults
	// without mutating the package-level global, then offer
	// permessage-deflate (RFC 7692) unless the caller opted out. The
	// server answers with the extension or without it; either way the
	// connection works, and gorilla transparently (de)compresses when it
	// was negotiated. Only "no context takeover" mode is supported, so
	// each message is deflated in isolation.
	dialer := *websocket.DefaultDialer
	dialer.EnableCompression = !e.options.DisableCompression

	conn, _, err := dialer.Dial(u.String(), nil)
	if err != nil {
		e.setState(StateError)
		e.notifyError(err)
		return fmt.Errorf("dial failed: %w", err)
	}

	e.mu.Lock()
	e.conn = conn
	e.state = StateConnected
	e.reconnectAttempts = 0
	e.mu.Unlock()

	e.notifyConnect()

	// Start message reader
	go e.readMessages()

	return nil
}

// Disconnect closes the WebSocket connection
func (e *RemoteEngine) Disconnect() {
	e.mu.Lock()
	defer e.mu.Unlock()

	// Stop reconnection attempts (guard against double-close panic)
	if !e.reconnectStopped {
		close(e.stopReconnect)
		e.reconnectStopped = true
	}

	if e.conn != nil {
		e.conn.Close()
		e.conn = nil
	}

	e.state = StateDisconnected
}

// DispatchAction sends an action to the remote server
func (e *RemoteEngine) DispatchAction(action string, payload any) error {
	e.mu.RLock()
	if e.state != StateConnected || e.conn == nil {
		e.mu.RUnlock()
		return fmt.Errorf("not connected")
	}
	conn := e.conn
	moduleName := e.moduleName
	e.mu.RUnlock()

	msg := DispatchActionMessage{
		Type:    MessageTypeDispatchAction,
		Module:  moduleName,
		Action:  action,
		Payload: payload,
	}

	data, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("marshal failed: %w", err)
	}

	return conn.WriteMessage(websocket.TextMessage, data)
}

// OnPatches registers a callback for patch events
func (e *RemoteEngine) OnPatches(callback PatchCallback) *RemoteEngine {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.patchCallbacks = append(e.patchCallbacks, callback)
	return e
}

// OnStateUpdate registers a callback for state updates
func (e *RemoteEngine) OnStateUpdate(callback StateCallback) *RemoteEngine {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.stateCallbacks = append(e.stateCallbacks, callback)
	return e
}

// OnConnect registers a callback for connection events
func (e *RemoteEngine) OnConnect(callback ConnectionCallback) *RemoteEngine {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.connectionCallbacks = append(e.connectionCallbacks, callback)
	return e
}

// OnDisconnect registers a callback for disconnection events
func (e *RemoteEngine) OnDisconnect(callback ConnectionCallback) *RemoteEngine {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.disconnectCallbacks = append(e.disconnectCallbacks, callback)
	return e
}

// OnError registers a callback for error events
func (e *RemoteEngine) OnError(callback ErrorCallback) *RemoteEngine {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.errorCallbacks = append(e.errorCallbacks, callback)
	return e
}

// GetConnectionState returns the current connection state
func (e *RemoteEngine) GetConnectionState() ConnectionState {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.state
}

// GetCurrentState returns the current app state
func (e *RemoteEngine) GetCurrentState() any {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.currentState
}

// GetRevision returns the current revision number
func (e *RemoteEngine) GetRevision() int {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.currentRevision
}

func (e *RemoteEngine) setState(state ConnectionState) {
	e.mu.Lock()
	e.state = state
	e.mu.Unlock()
}

func (e *RemoteEngine) readMessages() {
	defer func() {
		e.mu.Lock()
		if e.conn != nil {
			e.conn.Close()
			e.conn = nil
		}
		e.state = StateDisconnected
		e.mu.Unlock()

		e.notifyDisconnect()
		e.attemptReconnect()
	}()

	for {
		e.mu.RLock()
		conn := e.conn
		e.mu.RUnlock()

		if conn == nil {
			return
		}

		_, message, err := conn.ReadMessage()
		if err != nil {
			if websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
				return
			}
			e.notifyError(err)
			return
		}

		e.handleMessage(message)
	}
}

func (e *RemoteEngine) handleMessage(data []byte) {
	var raw RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		e.notifyError(fmt.Errorf("unmarshal failed: %w", err))
		return
	}

	switch raw.Type {
	case MessageTypeInitialTree:
		e.handleInitialTree(&raw)
	case MessageTypePatch:
		e.handlePatch(&raw)
	case MessageTypeStateUpdate:
		e.handleStateUpdate(&raw)
	}
}

func (e *RemoteEngine) handleInitialTree(msg *RawMessage) {
	e.mu.Lock()
	e.moduleName = msg.Module
	e.currentState = msg.State
	e.currentRevision = msg.Revision
	e.mu.Unlock()

	// Notify patch callbacks
	if len(msg.Patches) > 0 {
		e.notifyPatches(msg.Patches)
	}

	// Notify state callbacks
	e.notifyState(msg.State)
}

func (e *RemoteEngine) handlePatch(msg *RawMessage) {
	e.mu.Lock()
	// Check revision ordering
	if msg.Revision <= e.currentRevision {
		e.mu.Unlock()
		logClient.Warn("Out of order patch: expected > %d, got %d", e.currentRevision, msg.Revision)
		return
	}
	e.currentRevision = msg.Revision
	e.mu.Unlock()

	if len(msg.Patches) > 0 {
		e.notifyPatches(msg.Patches)
	}
}

func (e *RemoteEngine) handleStateUpdate(msg *RawMessage) {
	e.mu.Lock()
	e.currentState = msg.State
	e.mu.Unlock()

	e.notifyState(msg.State)
}

func (e *RemoteEngine) notifyPatches(patches []Patch) {
	e.mu.RLock()
	callbacks := make([]PatchCallback, len(e.patchCallbacks))
	copy(callbacks, e.patchCallbacks)
	e.mu.RUnlock()

	for _, cb := range callbacks {
		cb(patches)
	}
}

func (e *RemoteEngine) notifyState(state any) {
	e.mu.RLock()
	callbacks := make([]StateCallback, len(e.stateCallbacks))
	copy(callbacks, e.stateCallbacks)
	e.mu.RUnlock()

	for _, cb := range callbacks {
		cb(state)
	}
}

func (e *RemoteEngine) notifyConnect() {
	e.mu.RLock()
	callbacks := make([]ConnectionCallback, len(e.connectionCallbacks))
	copy(callbacks, e.connectionCallbacks)
	e.mu.RUnlock()

	for _, cb := range callbacks {
		cb()
	}
}

func (e *RemoteEngine) notifyDisconnect() {
	e.mu.RLock()
	callbacks := make([]ConnectionCallback, len(e.disconnectCallbacks))
	copy(callbacks, e.disconnectCallbacks)
	e.mu.RUnlock()

	for _, cb := range callbacks {
		cb()
	}
}

func (e *RemoteEngine) notifyError(err error) {
	e.mu.RLock()
	callbacks := make([]ErrorCallback, len(e.errorCallbacks))
	copy(callbacks, e.errorCallbacks)
	e.mu.RUnlock()

	for _, cb := range callbacks {
		cb(err)
	}
}

func (e *RemoteEngine) attemptReconnect() {
	if !e.options.AutoReconnect {
		return
	}

	for {
		e.mu.Lock()
		if e.reconnectAttempts >= e.options.MaxReconnectAttempts {
			e.mu.Unlock()
			logClient.Error("Max reconnection attempts reached")
			return
		}
		e.reconnectAttempts++
		attempt := e.reconnectAttempts
		e.mu.Unlock()

		logClient.Debug("Attempting to reconnect (%d/%d)...", attempt, e.options.MaxReconnectAttempts)

		select {
		case <-e.stopReconnect:
			return
		case <-time.After(e.options.ReconnectInterval):
			if err := e.Connect(); err != nil {
				logClient.Error("Reconnection failed: %v", err)
				continue // Retry on next iteration
			}
			return // Connected successfully
		}
	}
}
