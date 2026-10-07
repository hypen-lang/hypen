// Package remote — transport-agnostic session primitives.
//
// One `RemoteSession` owns one logical client: a dedicated WASM engine, a
// state map, a session id, and the full hello → sessionAck → initialTree →
// streaming-patches protocol. It does NOT know how bytes reach the client;
// that is the job of `SessionTransport`, a minimal `{ Send, Close }`
// contract that can be backed by gorilla/websocket, nhooyr/websocket, an
// SSE response writer, an in-process channel, or anything else.
//
// Backend devs can plug Hypen into an existing HTTP/WebSocket stack by:
//
//	server.Prepare()
//	session, _ := server.CreateSession(transport)
//	// forward incoming messages
//	session.Receive(msg)
//	// on disconnect
//	session.Destroy()
//
// `RemoteServer.Listen()` is unchanged — it is now sugar over these
// primitives backed by a gorilla/websocket adapter.
package remote

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	core "github.com/hypen-space/core"
	"github.com/hypen-space/core/device"
	wire "github.com/hypen-space/core/remote/device"
)

// SessionTransport is the minimal seam a RemoteSession uses to reach its
// client. Implement this to back sessions with any transport.
//
// Send may be called concurrently; implementations must serialise writes
// if the underlying connection requires it (gorilla/websocket does).
type SessionTransport interface {
	Send(message OutgoingMessage) error
	Close(code int, reason string) error
}

// OutgoingMessage is a server→client message. It is satisfied by the
// *Message types defined in types.go (each has a GetType() method).
type OutgoingMessage = Message

// SessionAckMessage is emitted in response to a client hello.
type SessionAckMessage struct {
	Type       MessageType `json:"type"`
	SessionID  string      `json:"sessionId"`
	IsNew      bool        `json:"isNew"`
	IsRestored bool        `json:"isRestored"`
	// ResumeToken is the resume credential (RFC 001 §5), in every ack
	// while the server's device plane is on (the default): fresh per
	// acknowledged connection, required next to the session id to resume
	// a session that negotiated a device plane. Treat it as a secret.
	ResumeToken string `json:"resumeToken,omitempty"`
	// Device is the negotiated sessionAck.device (RFC 001 §2.2); absent
	// when the device plane is disabled for this connection.
	Device json.RawMessage `json:"device,omitempty"`
}

// GetType reports this message's protocol type.
func (m *SessionAckMessage) GetType() MessageType { return MessageTypeSessionAck }

// SessionExpiredMessage notifies a client that their session has been
// evicted (ttl expiry, kicked by policy, or manually).
type SessionExpiredMessage struct {
	Type      MessageType `json:"type"`
	SessionID string      `json:"sessionId"`
	Reason    string      `json:"reason"` // "ttl" | "kicked" | "manual"
}

// GetType reports this message's protocol type.
func (m *SessionExpiredMessage) GetType() MessageType { return "sessionExpired" }

// SessionHost is the subset of RemoteServer state a RemoteSession needs.
// Kept as an interface so sessions can be unit-tested against a fake and
// so alternate hosts (e.g. a Durable-Object wrapper) can satisfy it
// without subclassing RemoteServer.
type SessionHost interface {
	Module() *ModuleConfig
	ModuleName() string
	UI() string
	SourceDir() string
	Resources() map[string]string
	Definition() *core.ModuleDefinition

	SessionManager() *core.SessionManager

	// OnSessionReady fires after a session's hello → initialTree flow
	// completes successfully. Used to surface the server-level
	// OnConnection callbacks.
	OnSessionReady(session *RemoteSession, client *Client)

	// OnSessionDestroyed fires at the end of Destroy(). Used to remove
	// the session from server bookkeeping and fire OnDisconnection
	// callbacks.
	OnSessionDestroyed(session *RemoteSession, client *Client)
}

// SessionOption tweaks a session's construction. Use the WithXxx helpers.
type SessionOption func(*sessionOptions)

type sessionOptions struct {
	clientID     string
	helloGraceMs int // 0 means "use default"; -1 disables
	socketHandle interface{}
	// upgradeRequest is the HTTP upgrade request of the connection
	// (WithUpgradeRequest); deviceAdmitted is CreateSession's admission
	// verdict for it.
	upgradeRequest *http.Request
	deviceAdmitted bool
}

// WithUpgradeRequest passes the connection's HTTP upgrade request to
// CreateSession. With connection admission configured (AllowedOrigins /
// Authenticate) the server admits the device plane only for a session
// whose upgrade request was admitted (RemoteServer.Admit, which the
// Upgrader() origin check runs); without it the session is UI-only.
func WithUpgradeRequest(r *http.Request) SessionOption {
	return func(o *sessionOptions) { o.upgradeRequest = r }
}

// withDeviceAdmission records CreateSession's admission verdict.
func withDeviceAdmission(admitted bool) SessionOption {
	return func(o *sessionOptions) { o.deviceAdmitted = admitted }
}

// WithClientID overrides the auto-generated client id. Useful for tests.
func WithClientID(id string) SessionOption {
	return func(o *sessionOptions) { o.clientID = id }
}

// WithHelloGraceMs sets the grace period before a connection that has not
// sent hello is auto-initialised as a legacy (no-session-id) client.
// Pass 0 for the default (1000 ms); pass -1 to disable entirely (useful
// for transports where the first message may be deliberately delayed,
// e.g. SSE where the client hellos via a separate POST).
//
// The grace applies whether or not the device plane is on: a session the
// grace timer initialises is UI-only (no device plane) unless the client
// later sends a hello offering `device` (a late hello re-acks with the
// selection without reinitialising app state).
func WithHelloGraceMs(ms int) SessionOption {
	return func(o *sessionOptions) { o.helloGraceMs = ms }
}

// WithSocketHandle stores an opaque value on the session (e.g. the raw
// *websocket.Conn) so legacy APIs that take the socket as a key can
// still route through the session.
func WithSocketHandle(handle interface{}) SessionOption {
	return func(o *sessionOptions) { o.socketHandle = handle }
}

var sessionCounter uint64

// RemoteSession owns one client's engine, state, and protocol state.
type RemoteSession struct {
	ID          string
	ConnectedAt time.Time

	host      SessionHost
	transport SessionTransport

	mu            sync.Mutex
	state         map[string]any
	nestedStates  map[string]map[string]any
	revision      int
	sessionID     string // set on hello
	helloReceived bool
	helloTimeout  *time.Timer
	engine        *core.WasmEngine
	destroyed     bool
	socketHandle  interface{}

	// dispatchMu serialises action dispatches into this session's engine
	// — a renderer click arriving via Receive and an attached agent
	// arriving via DispatchExternal never interleave. It is deliberately
	// NOT `mu`: a dispatch runs the module handler, which re-takes `mu`
	// to snapshot/commit state, and the engine's patch callback takes
	// `mu` under the engine mutex to bump the revision. Holding `mu`
	// across a dispatch would deadlock; holding dispatchMu is safe
	// because nothing on the dispatch path re-enters it. (Corollary: a
	// module handler must not call DispatchExternal on its own session.)
	dispatchMu sync.Mutex

	// Lifecycle broadcast channels. `readyCh` is closed once the hello
	// handshake + primary-module construction + initial render + router
	// auto-wiring (when enabled) have all completed — i.e. once every
	// action the engine's guard authorises has its host handler
	// installed; `closedCh` is closed once Destroy has finished its
	// teardown. Both are closed exactly once (the Destroy path also
	// closes readyCh defensively so a caller blocked on Ready() during
	// an unhealthy session doesn't deadlock).
	readyOnce  sync.Once
	closedOnce sync.Once
	readyCh    chan struct{}
	closedCh   chan struct{}

	// Per-session ManagedRouter auto-wired from `Router {}` blocks
	// found in the primary template. Nil when auto-wiring is disabled,
	// when no Routers live in the template, or when no registered
	// module matched any route body. Torn down alongside the session.
	autoManaged *core.ManagedRouter
	// autoPrimary is the primary-module handle the auto-wire registered
	// in globalCtx (and whose handlers it installed on the engine). A
	// device plane attached after the auto-wire is bound to it (and to
	// autoManaged) by attachDevice.
	autoPrimary *core.ModuleInstance
	// AutoRouterEnabled toggles the auto-wiring above. Flipped per
	// session by `RemoteServer` depending on whether the host called
	// `DisableAutoRouter()`.
	AutoRouterEnabled bool

	// Per-session GlobalContext handed to every action handler's
	// ActionHandlerContext.Context. Populated by autoWireManagedRouter
	// with the primary module + routed modules; action handlers
	// registered in registerActionHandlers close over this pointer so
	// they see whatever the auto-wire (which runs later) has inserted.
	// Without a session-scoped context, each handler dispatch would
	// build a fresh empty context and `GetModule("app")` / sibling
	// reads from routed children would always return nil.
	globalCtx *core.HypenGlobalContext

	// ---- device plane (RFC 001) ----

	// deviceCfg is the host's device settings (nil: the host's device
	// plane is off — DisableDevice, an incompatible setting, or a host
	// without one).
	deviceCfg *deviceSettings
	// upgradeAdmitted: the connection's upgrade passed the host's
	// connection admission (or none is configured); without it no device
	// plane is negotiated.
	upgradeAdmitted bool
	// dev is this connection's device plane (nil: disabled, not
	// negotiated, or closed).
	dev *sessionDevice
	// dispatchQ runs the dispatches of a session with a negotiated device
	// plane off the reader (nil until a plane attaches; UI-only sessions
	// dispatch on the reader, serialised by dispatchMu). Read it with
	// queue().
	dispatchQ atomic.Pointer[dispatchQueue]
	// curMu guards curDispatch, the dispatch holding the slot.
	curMu       sync.Mutex
	curDispatch *dispatchLease
	// resumeToken is the credential issued in this connection's ack.
	resumeToken string
	// initializedByGrace / ackIsNew support a late device hello.
	initializedByGrace bool
	ackIsNew           bool
	// owners are the device identities of the modules the session itself
	// runs handlers for (the primary and the registered nested modules),
	// keyed by lowercase module name ("" = primary).
	owners map[string]device.Owner
}

// NewRemoteSession constructs a session and starts its hello grace timer.
// Call from a transport adapter or from RemoteServer.CreateSession.
func NewRemoteSession(host SessionHost, transport SessionTransport, opts ...SessionOption) *RemoteSession {
	options := sessionOptions{}
	for _, opt := range opts {
		opt(&options)
	}

	clientID := options.clientID
	if clientID == "" {
		clientID = fmt.Sprintf("client_%d", atomic.AddUint64(&sessionCounter, 1))
	}

	// Copy initial state for this client.
	clientState := make(map[string]any)
	if mod := host.Module(); mod != nil && mod.InitialState != nil {
		for k, v := range mod.InitialState {
			clientState[k] = v
		}
	}

	s := &RemoteSession{
		ID:                clientID,
		ConnectedAt:       time.Now(),
		host:              host,
		transport:         transport,
		state:             clientState,
		socketHandle:      options.socketHandle,
		readyCh:           make(chan struct{}),
		closedCh:          make(chan struct{}),
		AutoRouterEnabled: true,
	}
	if dh, ok := host.(deviceHost); ok {
		s.deviceCfg = dh.deviceSettings()
		s.upgradeAdmitted = options.deviceAdmitted
	}

	// Hello grace timer. Clients that don't hello within the window get
	// auto-initialised as legacy (no sessionId, no props) connections —
	// with the device plane on or off; such a session has no device plane.
	graceMs := options.helloGraceMs
	switch {
	case graceMs == 0:
		graceMs = 1000
	case graceMs < 0:
		graceMs = 0
	}
	if graceMs > 0 {
		// Assign under s.mu: the callback (which clears helloTimeout under
		// s.mu) can fire before AfterFunc returns when the grace is short,
		// and an unguarded write here races with it.
		s.mu.Lock()
		s.helloTimeout = time.AfterFunc(time.Duration(graceMs)*time.Millisecond, func() {
			s.mu.Lock()
			if s.helloReceived || s.destroyed {
				s.mu.Unlock()
				return
			}
			s.helloReceived = true
			s.initializedByGrace = true
			s.helloTimeout = nil
			s.mu.Unlock()
			s.initializeSession("", nil, nil, "")
		})
		s.mu.Unlock()
	}

	return s
}

// SessionID returns the Hypen session id once hello has completed, or
// empty string before then.
func (s *RemoteSession) SessionID() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sessionID
}

// HelloReceived reports whether the client has completed its handshake.
func (s *RemoteSession) HelloReceived() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.helloReceived
}

// Revision returns the current render revision for this session.
func (s *RemoteSession) Revision() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.revision
}

// State returns a shallow copy of the current module state.
func (s *RemoteSession) State() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[string]any, len(s.state))
	for k, v := range s.state {
		out[k] = v
	}
	return out
}

// Engine returns the per-client WASM engine, or nil if hello hasn't run.
func (s *RemoteSession) Engine() *core.WasmEngine {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.engine
}

// UpdatePrimaryState merges a patch into the primary module's state
// (both the session-held snapshot and the engine) and triggers a
// reactive re-render. Use this for out-of-band state writes initiated
// by per-session helpers (e.g. mirroring a ManagedRouter path into
// `state.location` from an OnNavigate subscriber) that don't go through
// an action handler. Paths are relative to the primary module — for
// nested modules, drive the state through `engine.UpdateStateSparse`
// with the module scope directly.
func (s *RemoteSession) UpdatePrimaryState(patch map[string]any) {
	if len(patch) == 0 {
		return
	}
	s.mu.Lock()
	engine := s.engine
	if s.state == nil {
		s.state = make(map[string]any, len(patch))
	}
	for k, v := range patch {
		s.state[k] = v
	}
	s.mu.Unlock()
	if engine != nil {
		engine.UpdateState(patch)
	}
}

// SocketHandle returns whatever opaque value was passed via
// WithSocketHandle. Useful when legacy APIs take the raw socket as a key.
func (s *RemoteSession) SocketHandle() interface{} {
	return s.socketHandle
}

// Send emits a server→client message through the transport. Exposed so
// RemoteServer can fan out broadcasts across all sessions.
func (s *RemoteSession) Send(msg OutgoingMessage) error {
	s.mu.Lock()
	destroyed := s.destroyed
	s.mu.Unlock()
	if destroyed {
		return nil
	}
	if err := s.transport.Send(msg); err != nil {
		logServer.Error("Session %s send failed: %v", s.ID, err)
		return err
	}
	return nil
}

// Receive feeds a raw client → server message into the session. `data`
// may be the raw JSON bytes or an already-parsed RawMessage.
func (s *RemoteSession) Receive(data []byte) error {
	s.mu.Lock()
	if s.destroyed {
		s.mu.Unlock()
		return nil
	}
	dev := s.dev
	s.mu.Unlock()

	// Device JSON limits start BEFORE parsing (RFC 001 §2.1): over-limit
	// text announcing itself as a device message is dropped unparsed — a
	// connection-level violation attributable to no request.
	if dev != nil && len(data) > wire.MaxMessageBytes {
		if over, err := dev.rt.IsOversizeText(data); err == nil && over {
			dev.violation("device message over 1 MiB")
			return nil
		}
	}

	// Device messages go to the broker as raw text after reading only
	// their `type`: the broker decodes them strictly (RFC 001 §2.1), and a
	// lenient decode into RawMessage must never drop one it would have
	// attributed to a live request (decision D8). That includes a client
	// `deviceRequest`: only the server sends those, and one reusing a live
	// id is a known-id wrong-direction message the broker terminates
	// (cancel + invalidParams) — liveness before direction.
	if dev != nil {
		var head struct {
			Type MessageType `json:"type"`
		}
		if json.Unmarshal(data, &head) == nil && isDeviceMessageType(head.Type) {
			dev.onText(data)
			return nil
		}
	}

	var raw RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return fmt.Errorf("remote: invalid message: %w", err)
	}

	switch raw.Type {
	case MessageTypeHello:
		s.mu.Lock()
		if s.helloReceived {
			late := s.initializedByGrace
			s.mu.Unlock()
			if late {
				s.lateDeviceHello(data, raw.Device)
			}
			return nil
		}
		s.helloReceived = true
		if s.helloTimeout != nil {
			s.helloTimeout.Stop()
			s.helloTimeout = nil
		}
		s.mu.Unlock()

		var helloProps map[string]any
		if propsMap, ok := raw.Props.(map[string]any); ok {
			helloProps = propsMap
		}
		s.initializeSession(raw.SessionID, helloProps, s.helloDevice(data, raw.Device), raw.ResumeToken)
		return nil

	case MessageTypeDispatchAction:
		if s.deviceCfg != nil && !s.HelloReceived() {
			// Security admission (RFC 001 §5): a socket that has not
			// completed the hello handshake may not dispatch.
			logServer.Warn("Session %s: dispatchAction before hello — rejected", s.ID)
			return nil
		}
		s.handleDispatchAction(raw.Action, raw.Payload)
		return nil

	case "deviceRequest", "deviceResponse", "deviceEvent":
		// Device plane (RFC 001): routed to the broker, never through the
		// action/state path. The broker strictly decodes the raw text
		// (the encoding/json parse above only read `type`); without a
		// plane the message is dropped.
		if dev != nil {
			dev.onText(data)
		}
		return nil

	default:
		// Unknown message types are ignored for forward compatibility.
		return nil
	}
}

// Destroy tears down the session: runs OnDisconnect, suspends the Hypen
// session for later resumption (TTL permitting), closes the engine, and
// notifies the host. Idempotent.
func (s *RemoteSession) Destroy() error {
	s.mu.Lock()
	if s.destroyed {
		s.mu.Unlock()
		return nil
	}
	s.destroyed = true
	if s.helloTimeout != nil {
		s.helloTimeout.Stop()
		s.helloTimeout = nil
	}
	dev := s.dev
	s.dev = nil
	sessionID := s.sessionID
	engine := s.engine
	s.engine = nil
	stateCopy := make(map[string]any, len(s.state))
	for k, v := range s.state {
		stateCopy[k] = v
	}
	s.mu.Unlock()

	// The device plane dies with the connection: live requests settle
	// connectionLost; app state may resume, device work never does.
	if dev != nil {
		dev.close()
	}

	sm := s.host.SessionManager()

	// Session lifecycle: untrack this connection. If no connections remain
	// on the Hypen session, fire OnDisconnect, suspend the session for the
	// configured TTL, and arrange for OnExpire + engine tear-down when
	// the TTL elapses (or never, if a reconnect cancels the timer).
	if sessionID != "" && sm != nil {
		sm.UntrackConnection(sessionID, s.socketHandleOrSelf())
		if sm.GetConnectionCount(sessionID) == 0 {
			if session := sm.GetActiveSession(sessionID); session != nil {
				info := session.Info()
				s.fireDisconnectHandler(stateCopy, info)
				sm.SuspendSession(sessionID, stateCopy, func() {
					s.fireExpireHandler(info)
					if engine != nil {
						engine.Close()
					}
				})
			} else if engine != nil {
				engine.Close()
			}
		}
		// else: other connections share this session; leave the engine alone.
	} else if engine != nil {
		engine.Close()
	}

	s.mu.Lock()
	managed := s.autoManaged
	s.autoManaged = nil
	s.autoPrimary = nil
	s.mu.Unlock()
	if managed != nil {
		managed.Stop()
	}

	s.host.OnSessionDestroyed(s, &Client{ID: s.ID, ConnectedAt: s.ConnectedAt})
	// Unblock any callers waiting on Ready before Destroy (e.g. a
	// session that died during hello); Ready's contract is "init
	// completed OR teardown started", so closing it here is safe. Then
	// announce Closed.
	s.readyOnce.Do(func() { close(s.readyCh) })
	s.closedOnce.Do(func() { close(s.closedCh) })
	return nil
}

// ExpireAndClose notifies the client that their session has ended and
// closes the transport. Used by peer-routing to evict duplicate sessions
// under the kick-old concurrent policy.
func (s *RemoteSession) ExpireAndClose(reason string) {
	sid := s.SessionID()
	if sid != "" {
		_ = s.Send(&SessionExpiredMessage{
			Type:      "sessionExpired",
			SessionID: sid,
			Reason:    reason,
		})
	}
	_ = s.transport.Close(websocket.CloseNormalClosure, "session "+reason)
}

// socketHandleOrSelf returns the stored socket handle if any, else the
// session pointer itself — so the SessionManager's internal connection
// set can use a stable unique key either way.
func (s *RemoteSession) socketHandleOrSelf() interface{} {
	if s.socketHandle != nil {
		return s.socketHandle
	}
	return s
}

// ---------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------

// initializeSession runs the hello → sessionAck → initialTree flow. Must
// be called exactly once, either on receiving a hello or after the hello
// grace timer fires.
func (s *RemoteSession) initializeSession(requestedSessionID string, helloProps map[string]any, helloDevice json.RawMessage, resumeToken string) {
	sm := s.host.SessionManager()
	if sm == nil {
		logServer.Error("Session %s initializeSession with nil SessionManager", s.ID)
		return
	}

	// Device handshake selection (RFC 001 §2.2) is pure and computed
	// before any side effect: a failure only disables the device plane.
	deviceAck := s.selectDevice(helloDevice)

	// Resume credential (RFC 001 §5): the public session id alone never
	// resumes a session that negotiated a device plane — the hello must
	// also present the resume token issued with it. A missing or wrong
	// token is a NEW session, never an error. A UI-only session keeps the
	// legacy id-only resume.
	if requestedSessionID != "" && sm.RequiresResumeToken(requestedSessionID) && !sm.VerifyResumeToken(requestedSessionID, resumeToken) {
		logServer.Info("Session %s: resume of %s without a valid resume token — new session", s.ID, requestedSessionID)
		requestedSessionID = ""
	}

	var session *core.Session
	var savedState map[string]any
	isRestored := false

	if requestedSessionID != "" {
		session, savedState = sm.ResumeSession(requestedSessionID)
		if session != nil {
			isRestored = true
		}
	}
	if session == nil {
		session = sm.CreateSession(helloProps)
	}
	_, _ = sm.TrackConnection(session.ID(), s.socketHandleOrSelf())

	token := ""
	if s.deviceCfg != nil {
		// Device plane on (the default): a fresh credential in every
		// ack; the previous one stops working.
		t, err := sm.IssueResumeToken(session.ID())
		if err != nil {
			logServer.Error("Session %s: resume token: %v", s.ID, err)
		}
		token = t
	}

	s.mu.Lock()
	s.sessionID = session.ID()
	s.resumeToken = token
	s.ackIsNew = !isRestored
	s.mu.Unlock()
	if deviceAck != nil {
		// From now on the session resumes only with its token.
		sm.MarkDeviceSession(session.ID())
	}

	// onReconnect hook — user can opt to restore the saved state.
	if isRestored && savedState != nil {
		s.fireReconnectHandler(session.Info(), savedState)
	}

	// Send sessionAck.
	if err := s.Send(&SessionAckMessage{
		Type:        MessageTypeSessionAck,
		SessionID:   session.ID(),
		IsNew:       !isRestored,
		IsRestored:  isRestored,
		ResumeToken: token,
		Device:      deviceAck,
	}); err != nil {
		logServer.Error("Failed to send sessionAck to %s: %v", s.ID, err)
		return
	}

	// The device plane opens right after the ack: core.capabilities first,
	// then the session's own module owners are activated — before any
	// handler can run.
	if deviceAck != nil {
		s.attachDevice(deviceAck)
	}

	// Render initial tree via engine (if sourceDir is set), else empty.
	patches := s.buildEngineAndInitialPatches()

	// Send initialTree.
	s.mu.Lock()
	state := s.stateCopyLocked()
	s.mu.Unlock()
	if err := s.Send(&InitialTreeMessage{
		Type:     MessageTypeInitialTree,
		Module:   s.host.ModuleName(),
		State:    state,
		Patches:  patches,
		Revision: 0,
	}); err != nil {
		logServer.Error("Failed to send initialTree to %s: %v", s.ID, err)
		return
	}
	logServer.Info("Sent initialTree to %s (%d patches)", s.ID, len(patches))

	// Auto-wire a ManagedRouter from the template's own `Router {}`
	// blocks. Keeps the Social example free of routing ceremony —
	// host code just registers modules and hands the template to
	// `RemoteServer.UI(...)`. Opt out via `RemoteServer.DisableAutoRouter()`.
	//
	// This MUST run before readyCh closes and before OnConnection fires:
	// the auto-wire is what installs the `router.*` host handlers that
	// back hypen.navigate / hypen.back. Until then the engine's guard
	// already authorises those built-ins (the template declares a
	// Router) but the resolved router.push finds no handler, so an
	// attached dispatch would return nil and emit a bare stateUpdate at
	// the unchanged revision — a silently dropped navigation that no
	// renderer click can ever produce (clicks arrive on this goroutine
	// only after Receive(hello) returns). Ready() therefore means "the
	// declared surface is fully backed", not just "initialTree sent".
	if s.AutoRouterEnabled {
		s.autoWireManagedRouter()
	}

	// Announce readiness, then notify the host → fires OnConnection
	// callbacks. Ready closes first so an OnConnection callback that
	// calls RemoteServer.Attach for this session finds it attachable.
	s.readyOnce.Do(func() { close(s.readyCh) })
	s.host.OnSessionReady(s, &Client{ID: s.ID, ConnectedAt: s.ConnectedAt})
}

// autoWireManagedRouter inspects the primary UI for `Router { Route ... }`
// blocks, picks the first registered component in each route body, spins
// up a ManagedRouter against the session's engine, and mirrors the
// router path into the primary module's `location` field (if present).
//
// Both top-level routers (ModuleScope empty or == primary) and routers
// nested inside per-route module templates are registered, flattened
// into one route table. Nested routes share the parent's URL space;
// authors spell out the full prefix in `Route(path:)`. On pattern
// conflicts the outermost wins — `DiscoverRouters` emits outer blocks
// before inner ones and the de-dup below keeps the first entry seen.
func (s *RemoteSession) autoWireManagedRouter() {
	engine := s.Engine()
	if engine == nil {
		return
	}
	ui := s.host.UI()
	if ui == "" {
		return
	}

	// Collect router blocks from both the primary template AND every
	// discovered child component template. DiscoverRouters walks a
	// single IR tree and does not resolve `Foo()` component references
	// — child templates live in separate source strings under the
	// session's source dir. Running discover on each separately and
	// concatenating (primary first) gives the true cross-tree router
	// inventory. Without this pass, a nested `module Home { Router {
	// ... } }` block declared in `Home/component.hypen` (the canonical
	// `.source()`-discovery shape) is silently invisible to the SDK
	// and the nested route never mounts. The dedup loop below keeps
	// the first-seen path (outer emission order wins).
	var discovered []core.DiscoveredRouter
	runDiscover := func(source, label string) {
		blocks, err := core.DiscoverRouters(source)
		if err != nil {
			logServer.Error("Auto-router: discoverRouters failed on %s: %v", label, err)
			return
		}
		discovered = append(discovered, blocks...)
	}
	runDiscover(ui, s.ID)
	if sourceDir := s.host.SourceDir(); sourceDir != "" {
		children, cErr := core.DiscoverComponents(sourceDir, nil)
		if cErr != nil {
			logServer.Error("Auto-router: child discovery failed on %s: %v", s.ID, cErr)
		} else {
			for _, comp := range children {
				if comp.Template == "" {
					continue
				}
				runDiscover(comp.Template, s.ID+" / "+comp.Name)
			}
		}
	}
	if len(discovered) == 0 {
		return
	}

	router := core.NewHypenRouter()
	// Reuse the session-scoped GlobalContext that was set up in
	// buildEngineAndInitialPatches. Action handlers registered in
	// registerActionHandlers already close over this pointer, so the
	// primary + routed module registrations we add here are visible to
	// those handlers via ctx.Context.GetModule(...).
	s.mu.Lock()
	if s.globalCtx == nil {
		s.globalCtx = core.NewHypenGlobalContext()
	}
	globalContext := s.globalCtx
	s.mu.Unlock()

	// Register the primary module in the auto-wire context so routed
	// children can read app-level state via
	// `context.GetModule("<primary>")`. Matches the TS/Kotlin/Swift
	// SDKs; without this a routed module that calls GetModule("app")
	// would always get nil, even though the pattern is documented.
	//
	// Go's session doesn't construct a ModuleInstance for the primary
	// by default — the engine slot is filled via engine.SetModule at
	// init. `AsAlreadyInEngine()` gives us a handle without re-setting
	// the slot; the wrapper's state is hydrated from the session's
	// current state map so GetState() returns a live snapshot.
	primaryScope := strings.ToLower(s.host.ModuleName())
	if primaryDef := s.host.Definition(); primaryDef != nil {
		s.mu.Lock()
		stateCopy := s.stateCopyLocked()
		s.mu.Unlock()
		defCopy := *primaryDef
		if defCopy.InitialState == nil {
			defCopy.InitialState = map[string]any{}
		}
		// Overlay the session's current state over the def's initial
		// state so routed children see the real values (e.g. currentUser)
		// instead of zero-value defaults.
		for k, v := range stateCopy {
			defCopy.InitialState[k] = v
		}
		instanceOpts := []core.InstanceOption{core.AsAlreadyInEngine()}
		if plane, owner, ok := s.planeFor(""); ok {
			// The session owns the primary's activation; this handle only
			// stamps it on the handlers it installs.
			instanceOpts = append(instanceOpts, core.WithDeviceOwner(plane, owner))
		}
		primaryInstance := core.NewModuleInstance(engine, &defCopy, instanceOpts...)
		globalContext.RegisterModule(primaryScope, primaryInstance)
		s.mu.Lock()
		s.autoPrimary = primaryInstance
		s.mu.Unlock()
	}

	managed := core.NewManagedRouter(router, engine, core.App, globalContext)
	if plane, _, ok := s.planeFor(""); ok {
		managed.SetDevicePlane(plane)
	}

	added := 0
	seenPaths := make(map[string]bool)
	for _, r := range discovered {
		for _, route := range r.Routes {
			if seenPaths[route.Path] {
				logServer.Debug(
					"Auto-router: path %q already registered; ignoring nested duplicate",
					route.Path,
				)
				continue
			}
			component := ""
			for _, name := range route.ElementNames {
				if core.App.Has(name) {
					component = name
					break
				}
			}
			if component == "" {
				logServer.Debug(
					"Auto-router: no registered module matched route %q — skipping", route.Path,
				)
				continue
			}
			managed.AddRoute(core.RouteDefinition{Path: route.Path, Component: component})
			seenPaths[route.Path] = true
			added++
		}
	}
	if added == 0 {
		logServer.Debug("Auto-router: nothing to mount for %s", s.ID)
		return
	}
	logServer.Info("Auto-router: wired %d routes for %s", added, s.ID)

	// Mirror router path → primary module's `location` field, if the
	// state shape has one. Running on a goroutine keeps the write off
	// HypenRouter's synchronous notify path (Wazero rejects recursive
	// module entry just like the browser wasm-bindgen build does).
	s.mu.Lock()
	_, hasLocation := s.state["location"]
	s.mu.Unlock()
	if hasLocation {
		router.OnNavigate(func(rs core.RouteState) {
			path := rs.CurrentPath
			go s.UpdatePrimaryState(map[string]any{"location": path})
		})
	}

	managed.Start()
	s.mu.Lock()
	s.autoManaged = managed
	s.mu.Unlock()
}

// Ready returns a channel that is closed once the hello handshake,
// primary-module construction, initial render, and (unless the host
// called DisableAutoRouter) the template's Router auto-wiring have all
// completed. After `<-session.Ready()` unblocks, `Engine()` is non-nil
// and every hypen.* built-in the guard authorises has its backing
// `router.*` handler installed, so an attached DispatchExternal cannot
// land in a window where the navigation is authorised but dropped.
// Ready closes before OnConnection callbacks fire, so a callback may
// Attach to the session it is being told about. Also unblocks if
// Destroy runs before init — always pair with an isDestroyed check (via
// `Engine() != nil` or a `select` on `Closed()`) before touching session
// internals.
func (s *RemoteSession) Ready() <-chan struct{} {
	return s.readyCh
}

// Closed returns a channel that is closed once Destroy finishes its
// teardown. Use this for per-session cleanup (e.g. `ManagedRouter.Stop`).
func (s *RemoteSession) Closed() <-chan struct{} {
	return s.closedCh
}

// buildEngineAndInitialPatches creates the per-client WASM engine,
// registers resources / components / modules / action handlers, renders
// the DSL once to produce the initial patch stream, and installs the
// patch callback for subsequent updates. Returns the initial patches.
// Returns an empty slice if no sourceDir/ui is configured.
func (s *RemoteSession) buildEngineAndInitialPatches() []Patch {
	sourceDir := s.host.SourceDir()
	ui := s.host.UI()
	if sourceDir == "" || ui == "" {
		return []Patch{}
	}

	// Build engine. core.NewDefaultEngine handles filepath.Abs etc via
	// the default loader.
	engine, err := core.NewDefaultEngine()
	if err != nil {
		logServer.Error("Engine creation failed for %s: %v", s.ID, err)
		return []Patch{}
	}

	if err := engine.RegisterDefaultPrimitives(); err != nil {
		logServer.Error("Failed to register default primitives: %v", err)
	}

	if err := engine.RegisterResources(s.host.Resources()); err != nil {
		logServer.Error("Failed to register resources: %v", err)
	}

	// Discover and register components.
	discovered, discErr := core.DiscoverComponents(sourceDir, nil)
	if discErr != nil {
		logServer.Error("Component discovery failed: %v", discErr)
	} else {
		for _, comp := range discovered {
			if regErr := engine.RegisterComponent(comp.Name, comp.Template, comp.HypenPath); regErr != nil {
				logServer.Error("Failed to register component %s: %v", comp.Name, regErr)
			}
		}
	}

	// Primary module.
	moduleName := s.host.ModuleName()
	primaryDef := s.host.Definition()
	// Non-nil slice so json.Marshal emits `[]` instead of `null`.
	// The Rust engine's ModuleConfig expects `actions: Vec<String>`
	// which rejects null with "invalid type: null, expected a
	// sequence" — surfaces as `SetModule status 2` at the Go layer.
	// Primary modules that register no actions (e.g. a routing shell)
	// still need the field present.
	allActions := []string{}
	if primaryDef != nil {
		allActions = append(allActions, primaryDef.Actions...)
	}

	s.mu.Lock()
	stateKeys := stateKeysFromMap(s.state)
	initialStateCopy := s.stateCopyLocked()
	s.nestedStates = make(map[string]map[string]any)
	// Per-session GlobalContext, created before registerActionHandlers
	// so action closures can close over a stable pointer. autoWire
	// (later in initializeSession) populates primary + routed modules
	// into this same instance — no fresh allocation per dispatch.
	if s.globalCtx == nil {
		s.globalCtx = core.NewHypenGlobalContext()
	}
	s.mu.Unlock()

	engine.SetModule(moduleName, allActions, stateKeys, initialStateCopy)

	// Nested modules.
	for _, name := range core.App.GetNames() {
		if strings.EqualFold(name, moduleName) {
			continue
		}
		def := core.App.Get(name)
		if def == nil {
			continue
		}
		engine.RegisterModule(name, def.Actions, def.StateKeys, def.InitialState)
		nestedState := make(map[string]any, len(def.InitialState))
		for k, v := range def.InitialState {
			nestedState[k] = v
		}
		s.mu.Lock()
		s.nestedStates[name] = nestedState
		s.mu.Unlock()
	}

	// Action handlers. Must be registered before renderSource so the
	// initial render sees the action scope.
	s.registerActionHandlers(engine, moduleName, primaryDef)

	enginePatches, err := engine.RenderSource(ui)
	patches := []Patch{}
	if err == nil {
		patches = corePatchesToRemote(enginePatches)
	} else {
		logServer.Error("Engine render failed for %s: %v", s.ID, err)
	}

	// Install patch callback for subsequent patches emitted by UpdateState.
	engine.SetPatchCallback(func(enginePatches []core.Patch) {
		s.mu.Lock()
		s.revision++
		rev := s.revision
		s.mu.Unlock()
		msg := &PatchMessage{
			Type:     MessageTypePatch,
			Module:   moduleName,
			Patches:  corePatchesToRemote(enginePatches),
			Revision: rev,
		}
		if err := s.Send(msg); err != nil {
			logServer.Error("Failed to send patches to %s: %v", s.ID, err)
		}
	})

	s.mu.Lock()
	s.engine = engine
	s.mu.Unlock()

	return patches
}

// registerActionHandlers wires primary + nested module handlers into the
// engine so engine.DispatchAction routes through the action scope. State
// mutations inside handlers flow back via ObservableState.OnChange and
// engine.UpdateState, which produces patches shipped via the patch
// callback installed in buildEngineAndInitialPatches.
func (s *RemoteSession) registerActionHandlers(
	engine *core.WasmEngine,
	moduleName string,
	primaryDef *core.ModuleDefinition,
) {
	stateObserver := func(scope string) func(core.StateChange) {
		return func(change core.StateChange) { engine.NotifyStateChange(scope, change.Paths, change.NewValues) }
	}
	onStateChange := stateObserver("")

	if primaryDef != nil {
		for actionName, handler := range primaryDef.Handlers.OnAction {
			actionName := actionName
			handler := handler
			engine.OnAction("__hypen_scoped::"+actionName, func(action core.Action) {
				s.mu.Lock()
				currentState := s.stateCopyLocked()
				s.mu.Unlock()
				roots := newChangedRoots()
				obs := core.NewObservableState(currentState, &core.StateObserverOptions{
					OnChange: roots.track(onStateChange),
				})
				runScoped(s.bindDevice(""), func(dev *device.Device) {
					handler(core.ActionHandlerContext{
						Action: core.ActionContext{
							Name:    actionName,
							Payload: action.Payload,
							Sender:  action.Sender,
						},
						State:   obs,
						Context: s.globalCtx,
					}.WithDevice(dev))
				})
				s.mu.Lock()
				s.state = s.commitState(s.state, obs, roots)
				s.mu.Unlock()
			})
		}
	}

	// Two-way binding.
	registerReserved := func(scope, stateKey string) {
		for _, actionName := range []string{"__hypen_bind", core.ReorderActionName, core.PinActionName} {
			name := actionName
			engine.OnAction("__hypen_scoped:"+strings.ToLower(scope)+":"+name, func(action core.Action) {
				s.mu.Lock()
				current := s.stateCopyLocked()
				if scope != "" {
					current = make(map[string]any)
					for k, v := range s.nestedStates[stateKey] {
						current[k] = v
					}
				}
				s.mu.Unlock()
				obs := core.NewObservableState(current, &core.StateObserverOptions{OnChange: stateObserver(scope)})
				switch name {
				case core.ReorderActionName:
					core.ApplyReorderAction(obs, action.Payload)
				case core.PinActionName:
					core.ApplyPinAction(obs, action.Payload)
				default:
					if p, ok := action.Payload.(map[string]interface{}); ok {
						if path, ok := p["path"].(string); ok && path != "" {
							obs.Set(path, p["value"])
						}
					}
				}
				s.mu.Lock()
				if scope == "" {
					s.state = obs.Snapshot()
				} else {
					s.nestedStates[stateKey] = obs.Snapshot()
				}
				s.mu.Unlock()
			})
		}
	}
	registerReserved("", "")

	// Nested modules.
	for _, name := range core.App.GetNames() {
		if strings.EqualFold(name, moduleName) {
			continue
		}
		def := core.App.Get(name)
		if def == nil {
			continue
		}
		registerReserved(name, name)
		for actionName, handler := range def.Handlers.OnAction {
			actionName := actionName
			handler := handler
			nestedName := name
			engine.OnAction("__hypen_scoped:"+strings.ToLower(nestedName)+":"+actionName, func(action core.Action) {
				s.mu.Lock()
				currentState := s.nestedStates[nestedName]
				if currentState == nil {
					currentState = make(map[string]any)
				}
				// shallow copy
				stateCopy := make(map[string]any, len(currentState))
				for k, v := range currentState {
					stateCopy[k] = v
				}
				s.mu.Unlock()
				roots := newChangedRoots()
				obs := core.NewObservableState(stateCopy, &core.StateObserverOptions{
					OnChange: roots.track(stateObserver(nestedName)),
				})
				runScoped(s.bindDevice(strings.ToLower(nestedName)), func(dev *device.Device) {
					handler(core.ActionHandlerContext{
						Action: core.ActionContext{
							Name:    actionName,
							Payload: action.Payload,
							Sender:  action.Sender,
						},
						State:   obs,
						Context: s.globalCtx,
					}.WithDevice(dev))
				})
				s.mu.Lock()
				s.nestedStates[nestedName] = s.commitState(s.nestedStates[nestedName], obs, roots)
				s.mu.Unlock()
			})
		}
	}
}

// reservedAnimateKey is the cross-boundary payload key TypeScript renderers
// use to carry an event applicator's `animate:` transaction-animation stamp
// (Option D) across dispatchAction. It is a renderer→host directive, never
// handler data: TS hosts lift it into a distinct Action field; the Go host
// does not implement transaction stamping (its state-sync path has no
// animation envelope), so the key is stripped here — module handlers must
// never observe it either way.
const reservedAnimateKey = "__hypenAnimate"

// stripReservedAnimateKey removes the reserved transaction-animation stamp
// from a decoded dispatch payload, if present. Non-map payloads pass through.
func stripReservedAnimateKey(payload any) any {
	if m, ok := payload.(map[string]any); ok {
		delete(m, reservedAnimateKey)
	}
	return payload
}

// liveEngine snapshots the session's engine for a caller that is not the
// renderer. Returns ErrSessionClosed once Destroy has run and ErrNoEngine
// when the session never built one (no Source/UI configured, or hello has
// not completed yet).
func (s *RemoteSession) liveEngine() (*core.WasmEngine, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.destroyed {
		return nil, ErrSessionClosed
	}
	if s.engine == nil {
		return nil, ErrNoEngine
	}
	return s.engine, nil
}

// DispatchExternal dispatches an action into this session's engine on
// behalf of a caller that is NOT the rendered UI — an attached agent, an
// MCP server, an operator tool. It routes through the engine's guarded
// `DispatchExternal`, so only what the developer declared is reachable:
// `.OnAction()` handlers plus the hypen.navigate / hypen.back /
// hypen.set_input built-ins when the app declares their backing surface.
// Framework internals (`__hypen_bind`, `router.*`) are refused.
//
// On success the user's transport receives exactly what a renderer click
// on this session produces: the engine's patch callback ships a `patch`
// message with the bumped revision, followed by the same `stateUpdate`
// tail `handleDispatchAction` emits. A guard refusal returns the engine's
// error before anything runs — no handler, no traffic on the transport,
// no revision change.
//
// Dispatches are serialised with renderer dispatches via dispatchMu, so
// an agent and a click on the same session never interleave. The
// session's own lifecycle is untouched: this never destroys, suspends,
// or closes it. Do not call from inside a module handler of the same
// session (dispatchMu is not re-entrant).
func (s *RemoteSession) DispatchExternal(name string, payload any) error {
	if q := s.queue(); q != nil {
		// An agent is not this connection's user: its dispatch can never
		// acquire device authority (replay firewall, RFC 001 §1.7).
		var err error
		q.runInline(true, func() { err = s.dispatchExternalNow(name, payload) })
		return err
	}
	s.dispatchMu.Lock()
	if q := s.queue(); q != nil {
		// A device plane attached while this dispatch waited.
		s.dispatchMu.Unlock()
		var err error
		q.runInline(true, func() { err = s.dispatchExternalNow(name, payload) })
		return err
	}
	defer s.dispatchMu.Unlock()
	return s.dispatchExternalNow(name, payload)
}

func (s *RemoteSession) dispatchExternalNow(name string, payload any) error {
	engine, err := s.liveEngine()
	if err != nil {
		return err
	}

	// Keep the renderer-only animation stamp away from handlers on this
	// path too, without mutating the caller's map.
	if m, ok := payload.(map[string]any); ok {
		if _, has := m[reservedAnimateKey]; has {
			cp := make(map[string]any, len(m))
			for k, v := range m {
				cp[k] = v
			}
			payload = stripReservedAnimateKey(cp)
		}
	}

	// The guard decides here. A refusal returns before any handler runs,
	// so nothing below (and no patch callback) fires.
	if err := engine.DispatchExternal(name, payload); err != nil {
		return err
	}

	s.sendStateUpdate(s.host.ModuleName())
	return nil
}

// sendStateUpdate ships the post-dispatch `stateUpdate` message carrying
// the current primary-module state snapshot at the current wire revision.
// Shared by the renderer dispatch path and DispatchExternal so both emit
// the identical tail.
func (s *RemoteSession) sendStateUpdate(moduleName string) {
	s.mu.Lock()
	rev := s.revision
	state := s.stateCopyLocked()
	s.mu.Unlock()
	_ = s.Send(&StateUpdateMessage{
		Type:     MessageTypeStateUpdate,
		Module:   moduleName,
		State:    state,
		Revision: rev,
	})
}

// handleDispatchAction routes a client dispatch into the engine (or, for
// the legacy no-sourceDir path, the ModuleConfig.OnAction shim).
func (s *RemoteSession) handleDispatchAction(actionName string, payload any) {
	if q := s.queue(); q != nil {
		// Device plane negotiated: run off the reader (see dispatchQueue).
		q.enqueue(false, func() { s.dispatchNow(actionName, payload) })
		return
	}
	// Serialise against attached-agent dispatches (see dispatchMu).
	s.dispatchMu.Lock()
	if q := s.queue(); q != nil {
		// A device plane attached while this dispatch waited.
		s.dispatchMu.Unlock()
		q.enqueue(false, func() { s.dispatchNow(actionName, payload) })
		return
	}
	defer s.dispatchMu.Unlock()
	s.dispatchNow(actionName, payload)
}

// queue is the session's dispatch queue: non-nil once a device plane
// attached (installQueue), nil for UI-only sessions.
func (s *RemoteSession) queue() *dispatchQueue { return s.dispatchQ.Load() }

// installQueue switches the session's dispatches to the off-reader queue
// when its device plane attaches. Taking dispatchMu waits for an in-flight
// reader/agent dispatch; dispatchers that were waiting for it re-check
// queue() and move to the queue, so the two paths never interleave.
func (s *RemoteSession) installQueue() {
	if s.queue() != nil {
		return
	}
	s.dispatchMu.Lock()
	s.dispatchQ.CompareAndSwap(nil, newDispatchQueue(s.setCurrentDispatch))
	s.dispatchMu.Unlock()
}

// dispatchNow runs one renderer dispatch (the caller serialises).
func (s *RemoteSession) dispatchNow(actionName string, payload any) {
	s.mu.Lock()
	destroyed := s.destroyed
	s.mu.Unlock()
	if destroyed && s.queue() != nil {
		return
	}

	// Strip the reserved transaction-animation stamp BEFORE either path —
	// engine-routed handlers and the legacy OnAction shim both receive the
	// payload from here.
	payload = stripReservedAnimateKey(payload)

	s.mu.Lock()
	engine := s.engine
	s.mu.Unlock()

	moduleName := s.host.ModuleName()

	if engine != nil {
		if err := engine.DispatchAction(actionName, payload); err != nil {
			logServer.Error("Engine DispatchAction failed: %v", err)
		}
		s.sendStateUpdate(moduleName)
		return
	}

	// Legacy path: no sourceDir, no engine. Use the ModuleConfig shim.
	module := s.host.Module()
	if module == nil || module.OnAction == nil {
		return
	}
	s.mu.Lock()
	currentState := s.stateCopyLocked()
	s.mu.Unlock()
	newState := module.OnAction(actionName, payload, currentState)
	if newState == nil {
		return
	}
	s.mu.Lock()
	s.state = newState
	s.revision++
	rev := s.revision
	s.mu.Unlock()
	_ = s.Send(&StateUpdateMessage{
		Type:     MessageTypeStateUpdate,
		Module:   moduleName,
		State:    newState,
		Revision: rev,
	})
}

func (s *RemoteSession) stateCopyLocked() map[string]any {
	out := make(map[string]any, len(s.state))
	for k, v := range s.state {
		out[k] = v
	}
	return out
}

// fireReconnectHandler invokes the typed definition's OnReconnect handler.
// If the handler doesn't call its Restore callback, the saved state is
// applied directly.
func (s *RemoteSession) fireReconnectHandler(info core.SessionInfo, savedState map[string]any) {
	def := s.host.Definition()

	apply := func(state map[string]any) {
		s.mu.Lock()
		s.state = make(map[string]any, len(state))
		for k, v := range state {
			s.state[k] = v
		}
		s.mu.Unlock()
	}

	if def == nil || def.Handlers.OnReconnect == nil {
		apply(savedState)
		return
	}

	didRestore := false
	restore := func(restoredState map[string]any) {
		didRestore = true
		apply(restoredState)
	}
	func() {
		defer func() {
			if r := recover(); r != nil {
				logServer.Error("OnReconnect handler panicked: %v", r)
			}
		}()
		def.Handlers.OnReconnect(core.ReconnectContext{
			Session: info,
			Restore: restore,
		})
	}()
	if !didRestore {
		apply(savedState)
	}
}

func (s *RemoteSession) fireDisconnectHandler(state map[string]any, info core.SessionInfo) {
	def := s.host.Definition()
	if def == nil || def.Handlers.OnDisconnect == nil {
		return
	}
	defer func() {
		if r := recover(); r != nil {
			logServer.Error("OnDisconnect handler panicked: %v", r)
		}
	}()
	def.Handlers.OnDisconnect(core.DisconnectContext{
		State:   core.NewObservableState(state, nil),
		Session: info,
	})
}

func (s *RemoteSession) fireExpireHandler(info core.SessionInfo) {
	def := s.host.Definition()
	if def == nil || def.Handlers.OnExpire == nil {
		return
	}
	defer func() {
		if r := recover(); r != nil {
			logServer.Error("OnExpire handler panicked: %v", r)
		}
	}()
	def.Handlers.OnExpire(core.ExpireContext{Session: info})
}

// ---------------------------------------------------------------------
// Built-in transports
// ---------------------------------------------------------------------

// GorillaWebSocketTransport is a SessionTransport backed by a
// gorilla/websocket connection. Writes are serialised via an internal
// mutex (gorilla requires a single concurrent writer).
type GorillaWebSocketTransport struct {
	Conn *websocket.Conn
	mu   sync.Mutex
}

// NewGorillaWebSocketTransport wraps a gorilla *websocket.Conn as a
// SessionTransport.
func NewGorillaWebSocketTransport(conn *websocket.Conn) *GorillaWebSocketTransport {
	return &GorillaWebSocketTransport{Conn: conn}
}

// Send serialises msg as JSON and writes a text frame.
func (t *GorillaWebSocketTransport) Send(msg OutgoingMessage) error {
	data, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("remote: marshal %T: %w", msg, err)
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.Conn.WriteMessage(websocket.TextMessage, data)
}

// SendDeviceText writes one device JSON message as a text frame (the
// device route, disjoint from OutgoingMessage — RFC 001 §5).
func (t *GorillaWebSocketTransport) SendDeviceText(text []byte) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.Conn.WriteMessage(websocket.TextMessage, text)
}

// SendBinary writes one binary device frame.
func (t *GorillaWebSocketTransport) SendBinary(frame []byte) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.Conn.WriteMessage(websocket.BinaryMessage, frame)
}

// Close writes a close frame and tears down the underlying connection.
func (t *GorillaWebSocketTransport) Close(code int, reason string) error {
	t.mu.Lock()
	msg := websocket.FormatCloseMessage(code, reason)
	_ = t.Conn.WriteControl(websocket.CloseMessage, msg, time.Now().Add(time.Second))
	t.mu.Unlock()
	return t.Conn.Close()
}

// ChannelTransport is an in-memory SessionTransport that buffers outgoing
// messages on a Go channel. Natural for tests and for bridging to
// streaming HTTP transports (SSE, chunked, HTTP/2 push).
//
// Callers MUST drain Out() (or explicitly call Close) or Send will block
// once the channel fills up.
type ChannelTransport struct {
	out    chan OutgoingMessage
	closed chan struct{}
	mu     sync.Mutex
}

// NewChannelTransport creates a ChannelTransport with the given buffer.
// A buffer of 0 means synchronous hand-off; 64 is a reasonable default.
func NewChannelTransport(buffer int) *ChannelTransport {
	return &ChannelTransport{
		out:    make(chan OutgoingMessage, buffer),
		closed: make(chan struct{}),
	}
}

// Out returns the receive side of the message channel. Closed when the
// transport is closed.
func (t *ChannelTransport) Out() <-chan OutgoingMessage { return t.out }

// Send enqueues msg for the consumer. Returns an error if already closed.
func (t *ChannelTransport) Send(msg OutgoingMessage) error {
	select {
	case <-t.closed:
		return fmt.Errorf("remote: transport closed")
	default:
	}
	select {
	case t.out <- msg:
		return nil
	case <-t.closed:
		return fmt.Errorf("remote: transport closed")
	}
}

// Close signals the transport is done; Out() is closed and further Send
// calls return an error. Idempotent.
func (t *ChannelTransport) Close(code int, reason string) error {
	_ = code
	_ = reason
	t.mu.Lock()
	defer t.mu.Unlock()
	select {
	case <-t.closed:
		return nil
	default:
		close(t.closed)
		close(t.out)
	}
	return nil
}

// isDeviceMessageType reports whether a client → server text message
// belongs to the device plane (RFC 001 §2). Every one of them — including
// the wrong-direction `deviceRequest` — goes to the broker, which alone
// decides liveness, direction and validity (decision D8).
func isDeviceMessageType(t MessageType) bool {
	switch t {
	case "deviceRequest", "deviceResponse", "deviceEvent":
		return true
	}
	return false
}
