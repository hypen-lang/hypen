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
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	core "github.com/hypen-space/core"
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

	// Lifecycle broadcast channels. `readyCh` is closed once the hello
	// handshake + primary-module construction + initial render have all
	// completed; `closedCh` is closed once Destroy has finished its
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

	// Hello grace timer. Clients that don't hello within the window get
	// auto-initialised as legacy (no sessionId, no props) connections.
	graceMs := options.helloGraceMs
	switch {
	case graceMs == 0:
		graceMs = 1000
	case graceMs < 0:
		graceMs = 0
	}
	if graceMs > 0 {
		s.helloTimeout = time.AfterFunc(time.Duration(graceMs)*time.Millisecond, func() {
			s.mu.Lock()
			if s.helloReceived || s.destroyed {
				s.mu.Unlock()
				return
			}
			s.helloReceived = true
			s.helloTimeout = nil
			s.mu.Unlock()
			s.initializeSession("", nil)
		})
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
	s.mu.Unlock()

	var raw RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return fmt.Errorf("remote: invalid message: %w", err)
	}

	switch raw.Type {
	case MessageTypeHello:
		s.mu.Lock()
		if s.helloReceived {
			s.mu.Unlock()
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
		s.initializeSession(raw.SessionID, helloProps)
		return nil

	case MessageTypeDispatchAction:
		s.handleDispatchAction(raw.Action, raw.Payload)
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
	sessionID := s.sessionID
	engine := s.engine
	s.engine = nil
	stateCopy := make(map[string]any, len(s.state))
	for k, v := range s.state {
		stateCopy[k] = v
	}
	s.mu.Unlock()

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
func (s *RemoteSession) initializeSession(requestedSessionID string, helloProps map[string]any) {
	sm := s.host.SessionManager()
	if sm == nil {
		logServer.Error("Session %s initializeSession with nil SessionManager", s.ID)
		return
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

	s.mu.Lock()
	s.sessionID = session.ID()
	s.mu.Unlock()

	// onReconnect hook — user can opt to restore the saved state.
	if isRestored && savedState != nil {
		s.fireReconnectHandler(session.Info(), savedState)
	}

	// Send sessionAck.
	if err := s.Send(&SessionAckMessage{
		Type:       MessageTypeSessionAck,
		SessionID:  session.ID(),
		IsNew:      !isRestored,
		IsRestored: isRestored,
	}); err != nil {
		logServer.Error("Failed to send sessionAck to %s: %v", s.ID, err)
		return
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

	// Notify host → fires OnConnection callbacks.
	s.host.OnSessionReady(s, &Client{ID: s.ID, ConnectedAt: s.ConnectedAt})
	s.readyOnce.Do(func() { close(s.readyCh) })

	// Auto-wire a ManagedRouter from the template's own `Router {}`
	// blocks. Keeps the Social example free of routing ceremony —
	// host code just registers modules and hands the template to
	// `RemoteServer.UI(...)`. Opt out via `RemoteServer.DisableAutoRouter()`.
	if s.AutoRouterEnabled {
		s.autoWireManagedRouter()
	}
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
		primaryInstance := core.NewModuleInstance(engine, &defCopy, core.AsAlreadyInEngine())
		globalContext.RegisterModule(primaryScope, primaryInstance)
	}

	managed := core.NewManagedRouter(router, engine, core.App, globalContext)

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
// primary-module construction, and initial render have all completed.
// After `<-session.Ready()` unblocks, `Engine()` is non-nil. Also
// unblocks if Destroy runs before init — always pair with an isDestroyed
// check (via `Engine() != nil` or a `select` on `Closed()`) before
// touching session internals.
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
	onStateChange := func(change core.StateChange) {
		patch := make(map[string]any, len(change.NewValues))
		for path, val := range change.NewValues {
			patch[string(path)] = val
		}
		engine.UpdateState(patch)
	}

	if primaryDef != nil {
		for actionName, handler := range primaryDef.Handlers.OnAction {
			actionName := actionName
			handler := handler
			engine.OnAction(actionName, func(action core.Action) {
				s.mu.Lock()
				currentState := s.stateCopyLocked()
				s.mu.Unlock()
				obs := core.NewObservableState(currentState, &core.StateObserverOptions{
					OnChange: onStateChange,
				})
				handler(core.ActionHandlerContext{
					Action: core.ActionContext{
						Name:    action.Name,
						Payload: action.Payload,
						Sender:  action.Sender,
					},
					State:   obs,
					Context: s.globalCtx,
				})
				s.mu.Lock()
				s.state = obs.Snapshot()
				s.mu.Unlock()
			})
		}
	}

	// Two-way binding.
	engine.OnAction("__hypen_bind", func(action core.Action) {
		payload, ok := action.Payload.(map[string]interface{})
		if !ok {
			return
		}
		path, ok := payload["path"].(string)
		if !ok || path == "" {
			return
		}
		value := payload["value"]
		s.mu.Lock()
		currentState := s.stateCopyLocked()
		s.mu.Unlock()
		obs := core.NewObservableState(currentState, &core.StateObserverOptions{
			OnChange: onStateChange,
		})
		obs.Set(path, value)
		s.mu.Lock()
		s.state = obs.Snapshot()
		s.mu.Unlock()
	})

	// Nested modules.
	for _, name := range core.App.GetNames() {
		if strings.EqualFold(name, moduleName) {
			continue
		}
		def := core.App.Get(name)
		if def == nil {
			continue
		}
		for actionName, handler := range def.Handlers.OnAction {
			actionName := actionName
			handler := handler
			nestedName := name
			engine.OnAction(actionName, func(action core.Action) {
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
				obs := core.NewObservableState(stateCopy, &core.StateObserverOptions{
					OnChange: onStateChange,
				})
				handler(core.ActionHandlerContext{
					Action: core.ActionContext{
						Name:    action.Name,
						Payload: action.Payload,
						Sender:  action.Sender,
					},
					State:   obs,
					Context: s.globalCtx,
				})
				s.mu.Lock()
				s.nestedStates[nestedName] = obs.Snapshot()
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

// handleDispatchAction routes a client dispatch into the engine (or, for
// the legacy no-sourceDir path, the ModuleConfig.OnAction shim).
func (s *RemoteSession) handleDispatchAction(actionName string, payload any) {
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
