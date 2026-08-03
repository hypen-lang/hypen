// Package remote provides WebSocket-based Remote UI for Hypen apps.
package remote

import (
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
}

// DefaultEngineOptions returns sensible defaults
func DefaultEngineOptions() EngineOptions {
	return EngineOptions{
		AutoReconnect:        true,
		ReconnectInterval:    3 * time.Second,
		MaxReconnectAttempts: 10,
	}
}
