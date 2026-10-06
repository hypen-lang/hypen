// Package remote provides WebSocket-based Remote UI for Hypen apps.
package remote

import (
	"encoding/json"
	"time"
)

// Patch represents a DOM patch (mirrors core.Patch)
type Patch struct {
	Type        string         `json:"type"`
	ID          string         `json:"id,omitempty"`
	ElementType string         `json:"elementType,omitempty"`
	Props       map[string]any `json:"props,omitempty"`
	Name        string         `json:"name,omitempty"`
	Value       any            `json:"value,omitempty"`
	Text        string         `json:"text,omitempty"`
	ParentID    string         `json:"parentId,omitempty"`
	BeforeID    string         `json:"beforeId,omitempty"`
	EventName   string         `json:"eventName,omitempty"`
	// Transition relays the engine's exit-animation flag on "remove"
	// patches to animation-capable remote clients (see core.Patch).
	Transition bool `json:"transition,omitempty"`
	// Spec relays the "batchAnimation" prelude's animation spec to
	// animation-capable remote clients (see core.Patch).
	Spec map[string]any `json:"spec,omitempty"`
}

// MessageType represents the type of remote message
type MessageType string

const (
	MessageTypeInitialTree    MessageType = "initialTree"
	MessageTypePatch          MessageType = "patch"
	MessageTypeStateUpdate    MessageType = "stateUpdate"
	MessageTypeDispatchAction MessageType = "dispatchAction"
	MessageTypeHello          MessageType = "hello"
	MessageTypeSessionAck     MessageType = "sessionAck"
)

// Message is the base interface for all remote messages
type Message interface {
	GetType() MessageType
}

// InitialTreeMessage is sent when a client first connects
type InitialTreeMessage struct {
	Type     MessageType `json:"type"`
	Module   string      `json:"module"`
	State    any         `json:"state"`
	Patches  []Patch     `json:"patches"`
	Revision int         `json:"revision"`
}

func (m *InitialTreeMessage) GetType() MessageType { return MessageTypeInitialTree }

// PatchMessage contains incremental UI updates
type PatchMessage struct {
	Type     MessageType `json:"type"`
	Module   string      `json:"module"`
	Patches  []Patch     `json:"patches"`
	Revision int         `json:"revision"`
}

func (m *PatchMessage) GetType() MessageType { return MessageTypePatch }

// StateUpdateMessage contains full state updates
type StateUpdateMessage struct {
	Type     MessageType `json:"type"`
	Module   string      `json:"module"`
	State    any         `json:"state"`
	Revision int         `json:"revision"`
}

func (m *StateUpdateMessage) GetType() MessageType { return MessageTypeStateUpdate }

// DispatchActionMessage is sent from client to dispatch an action
type DispatchActionMessage struct {
	Type    MessageType `json:"type"`
	Module  string      `json:"module"`
	Action  string      `json:"action"`
	Payload any         `json:"payload,omitempty"`
}

func (m *DispatchActionMessage) GetType() MessageType { return MessageTypeDispatchAction }

// RawMessage is used for parsing incoming messages
type RawMessage struct {
	Type      MessageType `json:"type"`
	Module    string      `json:"module,omitempty"`
	Action    string      `json:"action,omitempty"`
	Payload   any         `json:"payload,omitempty"`
	State     any         `json:"state,omitempty"`
	Patches   []Patch     `json:"patches,omitempty"`
	Revision  int         `json:"revision,omitempty"`
	SessionID string      `json:"sessionId,omitempty"`
	Props     any         `json:"props,omitempty"`
	// Device is hello.device (RFC 001 §2.2), kept as raw JSON: it is
	// strictly decoded by the broker's handshake selection, never by
	// encoding/json.
	Device json.RawMessage `json:"device,omitempty"`
	// ResumeToken is hello.resumeToken: the resume credential the server
	// issued in an earlier sessionAck.
	ResumeToken string `json:"resumeToken,omitempty"`
}

// Client represents a connected remote client
type Client struct {
	ID          string
	ConnectedAt time.Time
}

// ServerConfig contains server configuration options
type ServerConfig struct {
	Port     int
	Hostname string

	// DisableCompression opts out of WebSocket permessage-deflate
	// (RFC 7692), which is negotiated per connection and ON by default.
	//
	// The option is phrased negatively because a Go struct field can't
	// express "default true": the zero value has to mean "leave the
	// default alone", so `ServerConfig{Port: 3000}` keeps compression
	// enabled. This mirrors the `autoRouter` / `DisableAutoRouter()`
	// convention used elsewhere in this package.
	//
	// Compression is negotiated during the handshake — clients that
	// don't advertise `permessage-deflate` transparently fall back to
	// uncompressed frames. Note that gorilla/websocket (v1.5.1)
	// implements the extension in "no context takeover" mode only, so
	// each message is deflated in isolation without a shared sliding
	// window across messages.
	DisableCompression bool
}

// ConnectionState represents the client connection state
type ConnectionState string

const (
	StateDisconnected ConnectionState = "disconnected"
	StateConnecting   ConnectionState = "connecting"
	StateConnected    ConnectionState = "connected"
	StateError        ConnectionState = "error"
)

// EngineOptions configures the RemoteEngine client
type EngineOptions struct {
	AutoReconnect        bool
	ReconnectInterval    time.Duration
	MaxReconnectAttempts int

	// DisableCompression opts out of offering WebSocket
	// permessage-deflate (RFC 7692) during the handshake. Compression is
	// ON by default, so the zero value keeps it enabled — see
	// ServerConfig.DisableCompression for why the option is negative.
	// A server that doesn't accept the extension simply answers without
	// it and the connection stays uncompressed.
	DisableCompression bool
}

// DefaultEngineOptions returns sensible defaults
func DefaultEngineOptions() EngineOptions {
	return EngineOptions{
		AutoReconnect:        true,
		ReconnectInterval:    3 * time.Second,
		MaxReconnectAttempts: 10,
	}
}
