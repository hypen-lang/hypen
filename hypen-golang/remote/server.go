package remote

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"weak"

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

	sessions   map[*RemoteSession]struct{}
	connToSess map[*websocket.Conn]*RemoteSession

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

	// device is the device plane's settings (RFC 001). The plane is on
	// by default: every connection whose hello offers `device` negotiates
	// it. ConfigureDevice changes the options; DisableDevice turns it off.
	device *deviceSettings
	// deviceOff is DisableDevice(): the server behaves exactly like a
	// UI-only server.
	deviceOff bool
	// Connection admission (RFC 001 §5), the app's ordinary connection
	// policy for UI and device traffic alike, enforced only when
	// configured (AllowedOrigins / Authenticate).
	allowedOrigins []string
	originsSet     bool
	authenticate   func(r *http.Request) bool
	// admitted records upgrade requests Admit accepted, so the upgrader's
	// origin check and CreateSession reuse the verdict instead of running
	// the authenticator again.
	admitted admissions
	// startup logs the one-time startup warnings (Prepare);
	// startupWarnings records them (tests).
	startup         sync.Once
	startupWarnings []string

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
		device:     newDeviceSettings(DeviceConfig{}),
		sessions:   make(map[*RemoteSession]struct{}),
		connToSess: make(map[*websocket.Conn]*RemoteSession),
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool {
				return true // Allow all origins
			},
			// permessage-deflate on by default, device plane or not;
			// negotiated per connection, so non-supporting clients fall
			// back automatically. gorilla only implements no context
			// takeover in both directions (every message deflated on its
			// own), which is what the device plane requires. Opt out via
			// Config or DisableCompression().
			EnableCompression: true,
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

func (h serverSessionHost) deviceSettings() *deviceSettings {
	h.s.mu.RLock()
	defer h.s.mu.RUnlock()
	if !h.s.deviceOnLocked() {
		return nil
	}
	return h.s.device
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
// Idempotent. The first successful call logs the server's one-time
// startup warnings (no admission configured; a setting that turned the
// device plane off) — it never refuses to start over device settings.
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
	s.startup.Do(s.logStartup)
	return nil
}

// Startup warning texts (tests match them).
const (
	warnNoAdmission         = "no AllowedOrigins/Authenticate configured — any client can connect; set them in production"
	warnDeviceAllowMultiple = "device plane off: the session config allows multiple connections per session (ConcurrentAllowMultiple), which would fan one session's device work out across sockets — use kick-old/reject-new to enable it"
)

// logStartup logs the one-time startup warnings and, with the device
// plane on, compiles the broker module off the hello path.
func (s *RemoteServer) logStartup() {
	s.mu.RLock()
	admission := s.admissionConfiguredLocked()
	deviceOn := s.deviceOnLocked()
	allowMultiple := !s.deviceOff && s.allowMultipleLocked()
	s.mu.RUnlock()
	var warnings []string
	if !admission {
		warnings = append(warnings, warnNoAdmission)
	}
	if allowMultiple {
		warnings = append(warnings, warnDeviceAllowMultiple)
	}
	s.mu.Lock()
	s.startupWarnings = warnings
	s.mu.Unlock()
	for _, w := range warnings {
		logServer.Warn("%s", w)
	}
	if deviceOn {
		// Compile the broker module (once per process) off the hello path.
		go func() {
			if _, err := sharedBrokerModule(); err != nil {
				logServer.Error("device broker module: %v", err)
			}
		}()
	}
}

// CreateSession creates a RemoteSession driven by the supplied transport.
//
// Use this to integrate Hypen with an existing HTTP/WebSocket stack
// (Echo, Gin, Fiber, Chi, nhooyr/websocket, SSE, …). Feed incoming
// messages to session.Receive(data) and call session.Destroy() when the
// underlying connection closes.
//
// When connection admission is configured (AllowedOrigins /
// Authenticate) the session gets a device plane only when its upgrade was
// admitted: pass the upgrade request with WithUpgradeRequest (after
// upgrading with Upgrader(), or after Admit). Without it, or when
// admission refuses the request, the session is UI-only (fail closed).
// With no admission configured every session may negotiate the device
// plane (it is on by default).
//
// Returns an error if the server is not prepared.
func (s *RemoteServer) CreateSession(transport SessionTransport, opts ...SessionOption) (*RemoteSession, error) {
	if err := s.Prepare(); err != nil {
		return nil, err
	}
	var o sessionOptions
	for _, opt := range opts {
		opt(&o)
	}
	admitted := true
	if s.admissionConfigured() {
		admitted = o.upgradeRequest != nil && s.Admit(o.upgradeRequest)
		if o.upgradeRequest != nil {
			// One admitted upgrade, one session.
			s.admitted.take(o.upgradeRequest)
		}
		if !admitted && s.DeviceEnabled() {
			logServer.Warn("CreateSession: upgrade not admitted (no WithUpgradeRequest, or refused) — device plane disabled for this session")
		}
	}
	opts = append(opts, withDeviceAdmission(admitted))
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

// Attach returns a non-owning AgentHandle bound to the live user session
// whose hello-acknowledged session id is sessionID. The session must have
// completed its hello → initialTree flow (Ready closed), not be destroyed
// (Closed open), and own an engine. Under a concurrent-connection policy
// that lets several connections share one session id, the first ready
// match is used.
//
// Returns ErrNoSuchSession when no ready, open session carries the id,
// and ErrNoEngine when one does but the server runs the legacy no-engine
// path (Source() and UI() not both configured).
//
// Ready closes only after the template's Router auto-wiring has installed
// the `router.*` handlers behind hypen.navigate / hypen.back, so a handle
// obtained here never lands in a window where the guard authorises a
// navigation the host cannot yet execute. Ready also closes before
// OnConnection callbacks fire, so attaching from one is supported. The
// exception is bespoke wiring: a host that calls DisableAutoRouter and
// starts its own ManagedRouter from an OnSessionCreate callback owns the
// ordering between that wiring and any Attach it performs.
//
// Attach is an in-process call — the developer invoking it from their
// own handler is the authorizer. It is deliberately not exposed as an
// HTTP route; the handle never destroys, suspends, or closes the session.
func (s *RemoteServer) Attach(sessionID string) (*AgentHandle, error) {
	if sessionID == "" {
		return nil, ErrNoSuchSession
	}
	var matchedWithoutEngine bool
	for _, sess := range s.Sessions() {
		if sess.SessionID() != sessionID {
			continue
		}
		select {
		case <-sess.Ready():
		default:
			continue // hello not complete yet
		}
		select {
		case <-sess.Closed():
			continue // already torn down
		default:
		}
		if sess.Engine() == nil {
			matchedWithoutEngine = true
			continue
		}
		return newAgentHandle(sess), nil
	}
	if matchedWithoutEngine {
		return nil, ErrNoEngine
	}
	return nil, ErrNoSuchSession
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
	// Unlike Port/Hostname there is no "unset" bool, so this is assigned
	// unconditionally: the zero value already means "compression on".
	s.config.DisableCompression = config.DisableCompression
	s.upgrader.EnableCompression = !config.DisableCompression
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

// ConfigureDevice sets the device plane's options (RFC 001): retained
// budgets, item caps and broker overrides; zero fields keep the defaults.
// The device plane itself needs no call — it is on by default, and every
// connection whose hello offers `device` gets one backed by the Rust
// device broker (the engine module's `hypen_device_*` ABI via wazero,
// compiled once per process; each connection's broker runs in its own
// module instance, so a trap resets only that connection). Handlers reach
// it through ctx.Device(). Configuring does not re-enable a plane turned
// off by DisableDevice.
//
// With the device plane on (the default):
//   - WebSocket compression stays on (unless DisableCompression): gorilla
//     negotiates permessage-deflate with server_no_context_takeover and
//     client_no_context_takeover only, so every message is compressed on
//     its own and device data never shares a compression history with
//     other messages — clients accept the device plane on such a socket;
//   - the socket read limit is 16 MiB (oversize device text reaches the
//     broker's pre-parse limit check);
//   - every acknowledged connection gets a resume token; resuming a
//     session that negotiated a device plane requires it, while UI-only
//     sessions keep the legacy id-only resume;
//   - a session with a negotiated plane runs its dispatches off the socket
//     reader, so handlers can block on device calls.
//
// Legacy clients are unaffected: one that never sends hello is still
// initialised after the hello grace (without a device plane), and one
// whose hello offers no `device` gets no device plane.
func (s *RemoteServer) ConfigureDevice(cfg DeviceConfig) *RemoteServer {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.device.cfg = cfg
	s.device.agg.limit.Store(aggregateLimit(cfg.AggregateRetainedBytes))
	return s
}

// DisableDevice turns the device plane off for this server — the single
// opt-out. The server then behaves exactly like a UI-only server: no
// device negotiation, no resume tokens, dispatches on the reader.
// Compression is independent of it (see DisableCompression).
func (s *RemoteServer) DisableDevice() *RemoteServer {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.deviceOff = true
	return s
}

// DeviceEnabled reports whether this server negotiates the device plane:
// true by default; false after DisableDevice or when a setting that is
// incompatible with it (a session config allowing multiple connections
// per session) turned it off.
func (s *RemoteServer) DeviceEnabled() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.deviceOnLocked()
}

func (s *RemoteServer) deviceOnLocked() bool {
	return !s.deviceOff && !s.allowMultipleLocked()
}

func (s *RemoteServer) allowMultipleLocked() bool {
	return s.sessionManager != nil && s.sessionManager.Config().Concurrent == core.ConcurrentAllowMultiple
}

// AllowedOrigins configures the Origin allowlist of connection admission
// (RFC 001 §5): an upgrade request WITH an `Origin` header must name one
// of these exact values (e.g. "https://app.example.com") or it is refused
// 403 (cross-site WebSocket hijacking defence). Requests without an Origin
// (native clients) are not affected by the allowlist — use Authenticate
// for them. Admission applies to UI and device traffic alike.
func (s *RemoteServer) AllowedOrigins(origins ...string) *RemoteServer {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.allowedOrigins = append([]string(nil), origins...)
	s.originsSet = true
	return s
}

// Authenticate configures the app authenticator of connection admission
// (RFC 001 §5): when set it must return true for every upgrade, with or
// without an Origin, or the upgrade is refused 403. Origin authenticates
// nothing — native clients present app credentials (e.g. an
// Authorization upgrade header).
func (s *RemoteServer) Authenticate(fn func(r *http.Request) bool) *RemoteServer {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.authenticate = fn
	return s
}

func (s *RemoteServer) admissionConfigured() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.admissionConfiguredLocked()
}

func (s *RemoteServer) admissionConfiguredLocked() bool {
	return s.originsSet || s.authenticate != nil
}

// Admit applies connection admission (RFC 001 §5) to an upgrade request:
// true when it may be upgraded. With neither AllowedOrigins nor
// Authenticate configured every request is admitted (and Prepare logs one
// startup warning). The verdict for r is remembered: the upgrader from
// Upgrader() (whose origin check is Admit) and CreateSession(…,
// WithUpgradeRequest(r)) reuse it, so the authenticator runs once per
// request.
//
// Hosts upgrading on their own endpoint upgrade with Upgrader() (or call
// Admit and refuse 403 themselves when using another WebSocket library)
// and pass the request to CreateSession with WithUpgradeRequest: with
// admission configured, a session whose upgrade was not admitted never
// gets a device plane.
func (s *RemoteServer) Admit(r *http.Request) bool {
	s.mu.RLock()
	origins, originsSet, auth := s.allowedOrigins, s.originsSet, s.authenticate
	s.mu.RUnlock()
	if !originsSet && auth == nil {
		return true
	}
	if r == nil {
		return false
	}
	if s.admitted.has(r) {
		return true
	}
	if !admitRequest(r, origins, originsSet, auth) {
		return false
	}
	s.admitted.add(r)
	return true
}

// admitRequest applies the configured admission checks to r.
func admitRequest(r *http.Request, origins []string, originsSet bool, auth func(*http.Request) bool) bool {
	origin := r.Header.Get("Origin")
	if originsSet && origin == "" && auth == nil {
		// An allowlist admits browsers only: a request without Origin
		// (a native client) needs the authenticator.
		return false
	}
	if originsSet && origin != "" {
		allowed := false
		for _, o := range origins {
			if o == origin {
				allowed = true
				break
			}
		}
		if !allowed {
			return false
		}
	}
	if auth != nil && !auth(r) {
		return false
	}
	return true
}

// DisableCompression turns off WebSocket permessage-deflate (RFC 7692),
// which every upgrade path in this server otherwise offers by default.
// Equivalent to Config(ServerConfig{DisableCompression: true}); provided
// as a builder for symmetry with DisableAutoRouter.
//
// Reach for this when payloads are already compressed (or tiny enough
// that per-message deflate costs more CPU than it saves bandwidth).
func (s *RemoteServer) DisableCompression() *RemoteServer {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.config.DisableCompression = true
	s.upgrader.EnableCompression = false
	return s
}

// CompressionEnabled reports whether this server offers permessage-deflate
// during the WebSocket handshake: true by default (device plane on or
// off), false after DisableCompression / ServerConfig.DisableCompression.
// The negotiated extension always carries server_no_context_takeover and
// client_no_context_takeover (the only mode gorilla implements), so it is
// safe for device traffic. Note that this is what the server *offers* —
// the extension is only actually used on connections whose client
// advertises it too.
func (s *RemoteServer) CompressionEnabled() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.compressionLocked()
}

func (s *RemoteServer) compressionLocked() bool {
	return !s.config.DisableCompression
}

// Upgrader returns a copy of the websocket.Upgrader this server uses for
// its built-in Listen() path, already carrying the configured
// compression and origin settings. Hosts wiring Hypen into their own
// HTTP stack should upgrade with this (rather than a hand-rolled
// Upgrader) so custom endpoints honour the same configuration.
//
// The upgrader admits per connection admission (RFC 001 §5): its
// CheckOrigin is Admit, so with AllowedOrigins / Authenticate configured a
// request with a foreign Origin, or one the authenticator refuses, is
// refused 403 before any upgrade (with neither configured every request
// is admitted). Pass the request on with CreateSession(…,
// WithUpgradeRequest(r)).
func (s *RemoteServer) Upgrader() websocket.Upgrader {
	s.mu.RLock()
	defer s.mu.RUnlock()
	up := s.upgrader
	up.EnableCompression = s.compressionLocked()
	up.CheckOrigin = s.Admit
	return up
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

	// Each session's device plane (its broker and engine-module instance)
	// closes with the session.
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
	// Connection admission (RFC 001 §5) before upgrading.
	if !s.Admit(r) {
		logServer.Warn("WebSocket upgrade refused (Origin %q)", r.Header.Get("Origin"))
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}
	// Snapshot under the lock: Config()/DisableCompression() may mutate
	// the upgrader while connections are being served.
	up := s.Upgrader()
	conn, err := up.Upgrade(w, r, nil)
	if err != nil {
		logServer.Error("WebSocket upgrade failed: %v", err)
		return
	}
	logServer.Debug(
		"WebSocket upgraded (compression offered: %v, client extensions: %q)",
		up.EnableCompression, r.Header.Get("Sec-WebSocket-Extensions"),
	)
	s.handleOpen(conn, WithUpgradeRequest(r))
	go s.readMessages(conn)
}

// handleOpen wraps a freshly-upgraded gorilla connection as a session.
// Kept unexported; exposed here (same-package) so tests that drive
// hand-rolled websocket endpoints can continue to use it.
//
// Compression is a property of the already-completed handshake, so a
// caller upgrading on its own endpoint controls it via its own Upgrader
// — use RemoteServer.Upgrader() to inherit this server's settings.
func (s *RemoteServer) handleOpen(conn *websocket.Conn, opts ...SessionOption) {
	transport := NewGorillaWebSocketTransport(conn)
	sess, err := s.CreateSession(transport, append([]SessionOption{WithSocketHandle(conn)}, opts...)...)
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
	if s.DeviceEnabled() {
		// Device plane on (the default): oversize device text must
		// reach the broker's pre-parse limit
		// check (a counted violation), not kill the socket; beyond this
		// the connection is closed (1009).
		conn.SetReadLimit(16 << 20)
	}
	for {
		kind, message, err := conn.ReadMessage()
		if err != nil {
			return
		}
		if kind == websocket.BinaryMessage {
			sess.ReceiveBinary(message)
			continue
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

// admissions is the set of upgrade requests Admit accepted, held weakly:
// an entry disappears when CreateSession consumes it or when the request
// is garbage collected (an upgrade that failed after admission).
type admissions struct {
	mu  sync.Mutex
	set map[weak.Pointer[http.Request]]struct{}
}

func (a *admissions) add(r *http.Request) {
	k := weak.Make(r)
	a.mu.Lock()
	if a.set == nil {
		a.set = make(map[weak.Pointer[http.Request]]struct{})
	}
	_, dup := a.set[k]
	a.set[k] = struct{}{}
	a.mu.Unlock()
	if !dup {
		runtime.AddCleanup(r, func(k weak.Pointer[http.Request]) { a.remove(k) }, k)
	}
}

func (a *admissions) has(r *http.Request) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	_, ok := a.set[weak.Make(r)]
	return ok
}

// take removes r's admission, reporting whether it was recorded.
func (a *admissions) take(r *http.Request) bool {
	return a.remove(weak.Make(r))
}

func (a *admissions) remove(k weak.Pointer[http.Request]) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	_, ok := a.set[k]
	delete(a.set, k)
	return ok
}

// size is the number of recorded admissions (tests).
func (a *admissions) size() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return len(a.set)
}
