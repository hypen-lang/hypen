package remote

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/gorilla/websocket"
	core "github.com/hypen-space/core"
)

// ActionHandler handles an action dispatched from a client
type ActionHandler func(action string, payload any, state map[string]any) map[string]any

// ModuleConfig represents a module configuration for the server
type ModuleConfig struct {
	Name         string
	InitialState map[string]any
	OnAction     ActionHandler
}

// ServerConnectionCallback is called when a client connects/disconnects
type ServerConnectionCallback func(client *Client)

// RemoteServer streams Hypen apps over WebSocket. Listen() is the
// convenience entry point, but Prepare() + CreateSession(transport) let
// you plug Hypen into any HTTP/WebSocket stack — see
// examples/remote/ for Express, Fastify, and SSE integration patterns
// (the TypeScript SDK has the canonical examples; the pattern is
// identical here).
type RemoteServer struct {
	mu sync.RWMutex

	module     *ModuleConfig
	moduleName string
	definition *core.ModuleDefinition // Raw definition for per-action handler access
	ui         string
	config     ServerConfig
	sourceDir  string // When set, use engine + component resolver for patches

	sessions    map[*RemoteSession]struct{}
	connToSess  map[*websocket.Conn]*RemoteSession

	// sessionManager owns session lifecycle (create / suspend / resume /
	// expire) so briefly-disconnected clients can reconnect to their
	// previous state within the TTL window. Default TTL is 1 hour;
	// configure via WithSessionConfig.
	sessionManager *core.SessionManager

	onConnectionCallbacks    []ServerConnectionCallback
	onDisconnectionCallbacks []ServerConnectionCallback
	// Session-scoped hook: fires the moment a RemoteSession is
	// constructed, before the hello handshake or the initial render.
	// Callbacks get the session directly and can await `session.Ready()`
	// for the post-init step (e.g. registering the primary module in a
	// HypenGlobalContext, starting a ManagedRouter).
	onSessionCreateCallbacks []func(*RemoteSession)

	// Resources: flat map of name → raw SVG string
	resources map[string]string
	// When true (default), each new session auto-wires a ManagedRouter
	// from the `Router {}` blocks found in the primary template. Flip
	// off via DisableAutoRouter() when the host wants bespoke wiring
	// inside OnSessionCreate.
	autoRouter bool

	server   *http.Server
	upgrader websocket.Upgrader

	// Shutdown channel
	done chan struct{}
}

// NewRemoteServer creates a new RemoteServer
func NewRemoteServer() *RemoteServer {
	return &RemoteServer{
		moduleName:     "App",
		sessionManager: core.NewSessionManager(nil),
		config: ServerConfig{
			Port:     3000,
			Hostname: "0.0.0.0",
		},
		resources:  make(map[string]string),
		autoRouter: true,
		sessions:   make(map[*RemoteSession]struct{}),
		connToSess: make(map[*websocket.Conn]*RemoteSession),
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool {
				return true // Allow all origins
			},
		},
		done: make(chan struct{}),
	}
}

// ---------------------------------------------------------------------
// SessionHost adapter
//
// Kept as a small unexported wrapper so RemoteServer's builder methods
// (Module, Resources, …) don't collide with the SessionHost accessor
// names of the same concept.
// ---------------------------------------------------------------------

type serverSessionHost struct{ s *RemoteServer }

func (h serverSessionHost) Module() *ModuleConfig {
	h.s.mu.RLock()
	defer h.s.mu.RUnlock()
	return h.s.module
}

func (h serverSessionHost) ModuleName() string {
	h.s.mu.RLock()
	defer h.s.mu.RUnlock()
	return h.s.moduleName
}

func (h serverSessionHost) UI() string {
	h.s.mu.RLock()
	defer h.s.mu.RUnlock()
	return h.s.ui
}

func (h serverSessionHost) SourceDir() string {
	h.s.mu.RLock()
	defer h.s.mu.RUnlock()
	return h.s.sourceDir
}

func (h serverSessionHost) Resources() map[string]string {
	h.s.mu.RLock()
	defer h.s.mu.RUnlock()
	out := make(map[string]string, len(h.s.resources))
	for k, v := range h.s.resources {
		out[k] = v
	}
	return out
}

func (h serverSessionHost) Definition() *core.ModuleDefinition {
	h.s.mu.RLock()
	defer h.s.mu.RUnlock()
	return h.s.definition
}

func (h serverSessionHost) SessionManager() *core.SessionManager {
	h.s.mu.RLock()
	defer h.s.mu.RUnlock()
	return h.s.sessionManager
}

func (h serverSessionHost) OnSessionReady(_ *RemoteSession, client *Client) {
	h.s.mu.RLock()
	cbs := make([]ServerConnectionCallback, len(h.s.onConnectionCallbacks))
	copy(cbs, h.s.onConnectionCallbacks)
	h.s.mu.RUnlock()
	for _, cb := range cbs {
		cb(client)
	}
}

func (h serverSessionHost) OnSessionDestroyed(session *RemoteSession, client *Client) {
	h.s.mu.Lock()
	delete(h.s.sessions, session)
	if conn, ok := session.SocketHandle().(*websocket.Conn); ok {
		delete(h.s.connToSess, conn)
	}
	cbs := make([]ServerConnectionCallback, len(h.s.onDisconnectionCallbacks))
	copy(cbs, h.s.onDisconnectionCallbacks)
	h.s.mu.Unlock()
	for _, cb := range cbs {
		cb(client)
	}
}

// ModuleName returns the configured primary module's public name. Kept
// as a convenience accessor; Module (the builder) is a setter.
func (s *RemoteServer) ModuleName() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.moduleName
}

// ---------------------------------------------------------------------
// Transport-agnostic public API
// ---------------------------------------------------------------------

// Prepare validates configuration. Must be called before CreateSession
// if you're bypassing Listen(). Currently a lightweight validator because
// the underlying session manager is created eagerly in NewRemoteServer;
// it is exposed for parity with other SDKs and for future work.
// Idempotent.
func (s *RemoteServer) Prepare() error {
	s.mu.RLock()
	mod := s.module
	ui := s.ui
	s.mu.RUnlock()
	if mod == nil {
		return fmt.Errorf("remote: module not set — call .Module() or .WithState() before Prepare()")
	}
	if ui == "" {
		return fmt.Errorf("remote: UI not set — call .UI() before Prepare()")
	}
	return nil
}

// CreateSession creates a RemoteSession driven by the supplied transport.
//
// Use this to integrate Hypen with an existing HTTP/WebSocket stack
// (Echo, Gin, Fiber, Chi, nhooyr/websocket, SSE, …). Feed incoming
// messages to session.Receive(data) and call session.Destroy() when the
// underlying connection closes.
//
// Returns an error if the server is not prepared.
func (s *RemoteServer) CreateSession(transport SessionTransport, opts ...SessionOption) (*RemoteSession, error) {
	if err := s.Prepare(); err != nil {
		return nil, err
	}
	sess := NewRemoteSession(serverSessionHost{s}, transport, opts...)
	s.mu.Lock()
	sess.AutoRouterEnabled = s.autoRouter
	s.sessions[sess] = struct{}{}
	if conn, ok := sess.SocketHandle().(*websocket.Conn); ok {
		s.connToSess[conn] = sess
	}
	cbs := make([]func(*RemoteSession), len(s.onSessionCreateCallbacks))
	copy(cbs, s.onSessionCreateCallbacks)
	s.mu.Unlock()
	for _, cb := range cbs {
		// Callbacks typically await session.Ready() or session.Closed(),
		// so run them on their own goroutine to keep CreateSession
		// non-blocking.
		go func(cb func(*RemoteSession), sess *RemoteSession) {
			defer func() {
				if r := recover(); r != nil {
					logServer.Error("OnSessionCreate callback panicked: %v", r)
				}
			}()
			cb(sess)
		}(cb, sess)
	}
	return sess, nil
}

// SessionHandler bundles the lifecycle entry points returned by
// CreateHandler, for framework-agnostic wiring in middleware-style
// stacks.
type SessionHandler struct {
	Session *RemoteSession
	Receive func(data []byte) error
	Destroy func() error
}

// CreateHandler returns a thin factory: call with a transport and get
// back { session, receive, destroy } wired up. Intended for mounting
// Hypen in middleware-style HTTP frameworks.
func (s *RemoteServer) CreateHandler() func(transport SessionTransport, opts ...SessionOption) (*SessionHandler, error) {
	return func(transport SessionTransport, opts ...SessionOption) (*SessionHandler, error) {
		sess, err := s.CreateSession(transport, opts...)
		if err != nil {
			return nil, err
		}
		return &SessionHandler{
			Session: sess,
			Receive: func(data []byte) error { return sess.Receive(data) },
			Destroy: func() error { return sess.Destroy() },
		}, nil
	}
}

// Sessions returns a snapshot slice of the currently-live sessions.
func (s *RemoteServer) Sessions() []*RemoteSession {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]*RemoteSession, 0, len(s.sessions))
	for sess := range s.sessions {
		out = append(out, sess)
	}
	return out
}

// Module sets the module for this app
func (s *RemoteServer) Module(name string, module *ModuleConfig) *RemoteServer {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.moduleName = name
	s.module = module
	return s
}

// WithState sets up a simple module with initial state
func (s *RemoteServer) WithState(name string, initialState map[string]any) *RemoteServer {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.moduleName = name
	s.module = &ModuleConfig{
		Name:         name,
		InitialState: initialState,
	}
	return s
}

// WithDefinition wires a typed ModuleDefinition (built via core.NewApp[T]) as the
// primary module for this server. It adapts the per-action handlers stored in the
// definition into the server's ActionHandler format.
func (s *RemoteServer) WithDefinition(def *core.ModuleDefinition) *RemoteServer {
	s.mu.Lock()
	defer s.mu.Unlock()

	name := def.Name
	if name == "" {
		name = "App"
	}
	s.moduleName = name
	s.definition = def

	s.module = &ModuleConfig{
		Name:         name,
		InitialState: def.InitialState,
		// OnAction is kept as a fallback for non-engine paths (no sourceDir).
		OnAction: func(action string, payload any, state map[string]any) map[string]any {
			handler, ok := def.Handlers.OnAction[action]
			if !ok {
				return state
			}

			obs := core.NewObservableState(state, nil)
			handler(core.ActionHandlerContext{
				Action: core.ActionContext{
					Name:    action,
					Payload: payload,
				},
				State:   obs,
				Context: core.NewHypenGlobalContext(),
			})
			return obs.Snapshot()
		},
	}
	return s
}

// OnAction sets the action handler for the module
func (s *RemoteServer) OnAction(handler ActionHandler) *RemoteServer {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.module == nil {
		s.module = &ModuleConfig{
			Name:         s.moduleName,
			InitialState: make(map[string]any),
		}
	}
	s.module.OnAction = handler
	return s
}

// UI sets the UI DSL string
func (s *RemoteServer) UI(dsl string) *RemoteServer {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ui = dsl
	return s
}

// Config sets server configuration
func (s *RemoteServer) Config(config ServerConfig) *RemoteServer {
	s.mu.Lock()
	defer s.mu.Unlock()
	if config.Port > 0 {
		s.config.Port = config.Port
	}
	if config.Hostname != "" {
		s.config.Hostname = config.Hostname
	}
	return s
}

// Source sets the components directory for engine-backed rendering.
// When set, the server uses the WASM engine to render the UI and send patches.
func (s *RemoteServer) Source(dir string) *RemoteServer {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sourceDir = dir
	return s
}

// Resources registers a flat map of resource name → raw SVG string.
// Resources are made available to each client engine when it connects.
func (s *RemoteServer) Resources(resources map[string]string) *RemoteServer {
	s.mu.Lock()
	defer s.mu.Unlock()
	for name, svg := range resources {
		s.resources[name] = svg
	}
	return s
}

// ResourcesFile loads a JSON file containing a flat name→SVG map and registers
// all entries as resources.
func (s *RemoteServer) ResourcesFile(path string) *RemoteServer {
	resources, err := core.LoadResourcesFile(path)
	if err != nil {
		logServer.Error("Failed to load resources file %s: %v", path, err)
		return s
	}
	return s.Resources(resources)
}

// ResourcesDir loads every `.svg` file from a directory and registers each
// as a resource keyed by filename without extension.
// e.g. dir/heart.svg → Icon(@resources.heart).
func (s *RemoteServer) ResourcesDir(dir string) *RemoteServer {
	entries, err := os.ReadDir(dir)
	if err != nil {
		logServer.Error("Failed to read resources dir %s: %v", dir, err)
		return s
	}
	resources := make(map[string]string)
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if !strings.HasSuffix(name, ".svg") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			logServer.Error("Failed to read %s: %v", name, err)
			continue
		}
		key := strings.TrimSuffix(name, ".svg")
		resources[key] = string(data)
	}
	return s.Resources(resources)
}

// OnConnection registers a connection callback
func (s *RemoteServer) OnConnection(callback ServerConnectionCallback) *RemoteServer {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.onConnectionCallbacks = append(s.onConnectionCallbacks, callback)
	return s
}

// DisableAutoRouter turns off the per-session `ManagedRouter` that the
// server normally wires up automatically from the primary template's
// `Router {}` blocks. Use this when the host wants to construct its
// own ManagedRouter inside OnSessionCreate — e.g. to share one router
// across many sessions, pre-register nested modules, or swap in a
// custom route matcher.
func (s *RemoteServer) DisableAutoRouter() *RemoteServer {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.autoRouter = false
	return s
}

// OnSessionCreate registers a callback that fires the instant a
// RemoteSession is constructed — before the hello handshake and before
// the initial render. Use this to wire per-session helpers (a
// HypenRouter, HypenGlobalContext, ManagedRouter) that need access to
// `session.Engine()` or want to await `session.Ready()` for the
// primary module.
func (s *RemoteServer) OnSessionCreate(callback func(*RemoteSession)) *RemoteServer {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.onSessionCreateCallbacks = append(s.onSessionCreateCallbacks, callback)
	return s
}

// OnDisconnection registers a disconnection callback
func (s *RemoteServer) OnDisconnection(callback ServerConnectionCallback) *RemoteServer {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.onDisconnectionCallbacks = append(s.onDisconnectionCallbacks, callback)
	return s
}

// Listen starts the WebSocket server. Convenience wrapper that backs
// `Prepare()` + `CreateSession()` with a gorilla/websocket adapter. For
// custom integrations use the transport-agnostic primitives directly.
func (s *RemoteServer) Listen(port ...int) *RemoteServer {
	if err := s.Prepare(); err != nil {
		panic(err.Error())
	}

	s.mu.Lock()
	if len(port) > 0 {
		s.config.Port = port[0]
	}
	addr := fmt.Sprintf("%s:%d", s.config.Hostname, s.config.Port)
	s.mu.Unlock()

	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleHTTP)
	mux.HandleFunc("/ws", s.handleWebSocket)
	mux.HandleFunc("/health", s.handleHealth)

	s.server = &http.Server{
		Addr:    addr,
		Handler: mux,
	}

	go func() {
		logServer.Info("Hypen app streaming on ws://%s", addr)
		if err := s.server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logServer.Error("Server error: %v", err)
		}
	}()

	return s
}

// ListenAsync starts the server and returns immediately
func (s *RemoteServer) ListenAsync(port ...int) *RemoteServer {
	return s.Listen(port...)
}

// Stop stops the server and tears down all sessions.
func (s *RemoteServer) Stop() {
	s.mu.Lock()
	select {
	case <-s.done:
	default:
		close(s.done)
	}
	sessions := make([]*RemoteSession, 0, len(s.sessions))
	for sess := range s.sessions {
		sessions = append(sessions, sess)
	}
	srv := s.server
	s.server = nil
	s.mu.Unlock()

	for _, sess := range sessions {
		_ = sess.Destroy()
	}

	if srv != nil {
		srv.Close()
	}
}

// GetURL returns the server URL
func (s *RemoteServer) GetURL() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return fmt.Sprintf("ws://%s:%d/ws", s.config.Hostname, s.config.Port)
}

// GetClientCount returns the number of connected sessions.
func (s *RemoteServer) GetClientCount() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.sessions)
}

// Broadcast sends a message to all connected sessions.
func (s *RemoteServer) Broadcast(msg Message) {
	for _, sess := range s.Sessions() {
		_ = sess.Send(msg)
	}
}

func (s *RemoteServer) handleHTTP(w http.ResponseWriter, r *http.Request) {
	// Check if this is a WebSocket upgrade request
	if websocket.IsWebSocketUpgrade(r) {
		s.handleWebSocket(w, r)
		return
	}

	w.WriteHeader(http.StatusOK)
	w.Write([]byte("Hypen Remote Server"))
}

func (s *RemoteServer) handleHealth(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	w.Write([]byte("OK"))
}

// handleWebSocket is the gorilla/websocket adapter. It upgrades the
// request, wraps the connection as a SessionTransport, creates a
// RemoteSession, and starts the message-pumping goroutine.
func (s *RemoteServer) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		logServer.Error("WebSocket upgrade failed: %v", err)
		return
	}
	s.handleOpen(conn)
	go s.readMessages(conn)
}

// handleOpen wraps a freshly-upgraded gorilla connection as a session.
// Kept unexported; exposed here (same-package) so tests that drive
// hand-rolled websocket endpoints can continue to use it.
func (s *RemoteServer) handleOpen(conn *websocket.Conn) {
	transport := NewGorillaWebSocketTransport(conn)
	sess, err := s.CreateSession(transport, WithSocketHandle(conn))
	if err != nil {
		logServer.Error("CreateSession failed: %v", err)
		_ = conn.Close()
		return
	}
	_ = sess // registered in s.connToSess via WithSocketHandle
}

// readMessages pumps frames off a gorilla websocket into the session's
// Receive method and destroys the session on EOF. Kept unexported;
// tests drive it directly alongside handleOpen.
func (s *RemoteServer) readMessages(conn *websocket.Conn) {
	sess := s.sessionForConn(conn)
	if sess == nil {
		return
	}
	defer func() { _ = sess.Destroy() }()
	for {
		_, message, err := conn.ReadMessage()
		if err != nil {
			return
		}
		if err := sess.Receive(message); err != nil {
			logServer.Error("Receive on %s failed: %v", sess.ID, err)
		}
	}
}

// stateKeysFromMap returns the keys of a map[string]any as a slice.
// Kept at package level because RemoteSession also needs it.
func stateKeysFromMap(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	return keys
}

// corePatchesToRemote adapts the engine's Patch representation to the
// wire Patch used by this package.
func corePatchesToRemote(corePatches []core.Patch) []Patch {
	out := make([]Patch, len(corePatches))
	for i, p := range corePatches {
		out[i] = Patch{
			Type:        p.Type,
			ID:          p.ID,
			ElementType: p.ElementType,
			Props:       p.Props,
			Name:        p.Name,
			Value:       p.Value,
			Text:        p.Text,
			ParentID:    p.ParentID,
			BeforeID:    p.BeforeID,
			EventName:   p.EventName,
			Transition:  p.Transition,
			Spec:        p.Spec,
		}
	}
	return out
}

// sessionForConn returns the RemoteSession associated with a raw gorilla
// websocket connection, or nil if none. Used by the legacy per-conn
// public helpers (SendPatches, UpdateClientState, …).
func (s *RemoteServer) sessionForConn(conn *websocket.Conn) *RemoteSession {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.connToSess[conn]
}

// SendPatches sends patches to a specific client identified by their
// gorilla websocket connection. Retained for source compatibility;
// new code should call session.Send(&PatchMessage{...}) directly.
func (s *RemoteServer) SendPatches(conn *websocket.Conn, patches []Patch) {
	sess := s.sessionForConn(conn)
	if sess == nil {
		return
	}
	sess.mu.Lock()
	sess.revision++
	rev := sess.revision
	sess.mu.Unlock()
	_ = sess.Send(&PatchMessage{
		Type:     MessageTypePatch,
		Module:   s.ModuleName(),
		Patches:  patches,
		Revision: rev,
	})
}

// BroadcastPatches sends patches to all connected sessions.
func (s *RemoteServer) BroadcastPatches(patches []Patch) {
	for _, sess := range s.Sessions() {
		sess.mu.Lock()
		sess.revision++
		rev := sess.revision
		sess.mu.Unlock()
		_ = sess.Send(&PatchMessage{
			Type:     MessageTypePatch,
			Module:   s.ModuleName(),
			Patches:  patches,
			Revision: rev,
		})
	}
}

// UpdateClientState replaces a client's state and emits a state update.
// Retained for source compatibility; new code should drive state through
// the session's engine.
func (s *RemoteServer) UpdateClientState(conn *websocket.Conn, state map[string]any) {
	sess := s.sessionForConn(conn)
	if sess == nil {
		return
	}
	sess.mu.Lock()
	sess.state = state
	sess.revision++
	rev := sess.revision
	sess.mu.Unlock()
	_ = sess.Send(&StateUpdateMessage{
		Type:     MessageTypeStateUpdate,
		Module:   s.ModuleName(),
		State:    state,
		Revision: rev,
	})
}

// BroadcastState sends a state update to all connected sessions.
func (s *RemoteServer) BroadcastState(state map[string]any) {
	for _, sess := range s.Sessions() {
		sess.mu.Lock()
		sess.state = state
		sess.revision++
		rev := sess.revision
		sess.mu.Unlock()
		_ = sess.Send(&StateUpdateMessage{
			Type:     MessageTypeStateUpdate,
			Module:   s.ModuleName(),
			State:    state,
			Revision: rev,
		})
	}
}


// Serve is a convenience function to create and start a RemoteServer
func Serve(options ServeOptions) *RemoteServer {
	server := NewRemoteServer().
		WithState(options.ModuleName, options.InitialState).
		UI(options.UI)

	if options.OnAction != nil {
		server.OnAction(options.OnAction)
	}

	if options.Port > 0 || options.Hostname != "" {
		config := ServerConfig{
			Port:     options.Port,
			Hostname: options.Hostname,
		}
		server.Config(config)
	}

	if options.OnConnection != nil {
		server.OnConnection(options.OnConnection)
	}

	if options.OnDisconnection != nil {
		server.OnDisconnection(options.OnDisconnection)
	}

	return server.Listen(options.Port)
}

// ServeOptions contains options for the Serve convenience function
type ServeOptions struct {
	ModuleName      string
	InitialState    map[string]any
	UI              string
	Port            int
	Hostname        string
	OnAction        ActionHandler
	OnConnection    ServerConnectionCallback
	OnDisconnection ServerConnectionCallback
}
