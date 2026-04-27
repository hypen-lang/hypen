package core

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"sync"
	"time"
)

// defaultGenerateSessionID returns a random 128-bit hex-encoded string.
// Falls back to a timestamp-based ID if crypto/rand is unavailable
// (extremely rare — would only happen on a broken or sandboxed system).
func defaultGenerateSessionID() string {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		// Fallback: encode the unix nanoseconds as hex. Not collision-
		// resistant under load, but the SessionManager retries on collision.
		ns := time.Now().UnixNano()
		fallback := make([]byte, 16)
		for i := 0; i < 8; i++ {
			fallback[i] = byte(ns >> (8 * i))
		}
		return hex.EncodeToString(fallback)
	}
	return hex.EncodeToString(buf[:])
}

// SessionInfo is the immutable view of a session passed to lifecycle
// handlers. Mirrors Kotlin/Swift `SessionInfo`.
type SessionInfo struct {
	ID              string
	CreatedAt       time.Time
	LastConnectedAt time.Time
	Props           map[string]any
}

// ConcurrentPolicy controls how the SessionManager handles a second
// connection attempt for the same session ID.
type ConcurrentPolicy int

const (
	// ConcurrentKickOld: a new connection kicks the existing one (default).
	// The kicked connection ID is returned from TrackConnection so the
	// caller can close it.
	ConcurrentKickOld ConcurrentPolicy = iota
	// ConcurrentRejectNew: a new connection is rejected when one already
	// exists. TrackConnection returns nil to signal the rejection.
	ConcurrentRejectNew
	// ConcurrentAllowMultiple: any number of connections may attach to a
	// single session.
	ConcurrentAllowMultiple
)

// SessionConfig configures a SessionManager.
type SessionConfig struct {
	// TTL is how long a suspended session is preserved before it expires.
	// Default is 1 hour.
	TTL time.Duration
	// Concurrent controls the multi-connection policy. Default is
	// ConcurrentKickOld.
	Concurrent ConcurrentPolicy
	// GenerateID is the session ID generator. Default is `uuid.NewString`.
	GenerateID func() string
}

// Session is the live mutable state owned by SessionManager. The struct
// fields are protected by an internal mutex; callers should treat the
// public methods as the only way to read or write the session.
type Session struct {
	id        string
	ttl       time.Duration
	createdAt time.Time

	mu              sync.Mutex
	lastConnectedAt time.Time
	props           map[string]any
}

// ID returns the session's unique identifier.
func (s *Session) ID() string { return s.id }

// TTL returns the session's expiration window after the last connection
// drops.
func (s *Session) TTL() time.Duration { return s.ttl }

// CreatedAt returns the time the session was created.
func (s *Session) CreatedAt() time.Time { return s.createdAt }

// Info returns a snapshot of the session as a SessionInfo, which is the
// shape passed to lifecycle handlers.
func (s *Session) Info() SessionInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	propsCopy := make(map[string]any, len(s.props))
	for k, v := range s.props {
		propsCopy[k] = v
	}
	return SessionInfo{
		ID:              s.id,
		CreatedAt:       s.createdAt,
		LastConnectedAt: s.lastConnectedAt,
		Props:           propsCopy,
	}
}

// touch updates the lastConnectedAt timestamp. Called by ResumeSession.
func (s *Session) touch() {
	s.mu.Lock()
	s.lastConnectedAt = time.Now()
	s.mu.Unlock()
}

// pendingSession holds a suspended session and its TTL timer.
type pendingSession struct {
	session    *Session
	savedState map[string]any
	timer      *time.Timer
}

// SessionManager owns session lifecycle: create, suspend, resume, expire.
//
// A session is "active" while at least one connection is attached. When
// the last connection drops, the host calls SuspendSession with the saved
// state and an onExpire callback; the session moves to the pending pool
// and a TTL timer starts. If the client reconnects within the window,
// ResumeSession cancels the timer and moves the session back to active.
// Otherwise the timer fires, removes the pending entry, and invokes the
// onExpire callback.
//
// Mirrors the Kotlin and Swift SessionManagers in shape — see
// hypen-server-swift/Sources/HypenServer/Session.swift for the reference.
type SessionManager struct {
	config SessionConfig

	mu                sync.Mutex
	activeSessions    map[string]*Session
	pendingSessions   map[string]*pendingSession
	sessionConnections map[string]map[any]struct{}
}

// NewSessionManager creates a SessionManager with the given config.
// Pass nil for the default configuration (1 hour TTL, kick-old policy,
// UUID-based IDs).
func NewSessionManager(config *SessionConfig) *SessionManager {
	cfg := SessionConfig{}
	if config != nil {
		cfg = *config
	}
	if cfg.TTL <= 0 {
		cfg.TTL = time.Hour
	}
	if cfg.GenerateID == nil {
		cfg.GenerateID = defaultGenerateSessionID
	}
	return &SessionManager{
		config:             cfg,
		activeSessions:     make(map[string]*Session),
		pendingSessions:    make(map[string]*pendingSession),
		sessionConnections: make(map[string]map[any]struct{}),
	}
}

// CreateSession creates a new active session with the given props.
func (m *SessionManager) CreateSession(props map[string]any) *Session {
	m.mu.Lock()
	defer m.mu.Unlock()

	id := m.config.GenerateID()
	for attempts := 0; m.activeSessions[id] != nil || m.pendingSessions[id] != nil; attempts++ {
		if attempts >= 10 {
			panic("SessionManager.CreateSession: failed to generate unique session ID after 10 attempts")
		}
		id = m.config.GenerateID()
	}

	propsCopy := make(map[string]any, len(props))
	for k, v := range props {
		propsCopy[k] = v
	}
	now := time.Now()
	session := &Session{
		id:              id,
		ttl:             m.config.TTL,
		createdAt:       now,
		lastConnectedAt: now,
		props:           propsCopy,
	}
	m.activeSessions[id] = session
	return session
}

// GetActiveSession returns the active session with the given ID, or nil
// if none exists. Pending (suspended) sessions are not returned by this
// method — use ResumeSession to recover them.
func (m *SessionManager) GetActiveSession(id string) *Session {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.activeSessions[id]
}

// SuspendSession moves an active session to the pending pool with a TTL
// timer. The onExpire callback is invoked when the timer fires (i.e.
// when no client reconnects within the TTL window). If a reconnect
// arrives first, ResumeSession cancels the timer and onExpire is never
// called.
//
// Returns true if the session was suspended, false if no active session
// with the given ID was found.
func (m *SessionManager) SuspendSession(id string, savedState map[string]any, onExpire func()) bool {
	m.mu.Lock()
	session, ok := m.activeSessions[id]
	if !ok {
		m.mu.Unlock()
		return false
	}
	delete(m.activeSessions, id)

	// Snapshot the saved state under the lock so the caller can keep
	// mutating their map without affecting what we hold.
	stateCopy := make(map[string]any, len(savedState))
	for k, v := range savedState {
		stateCopy[k] = v
	}

	// Build the pending entry first; the timer is wired below so it can
	// reference the entry by ID.
	pending := &pendingSession{
		session:    session,
		savedState: stateCopy,
	}
	m.pendingSessions[id] = pending
	m.mu.Unlock()

	// Schedule expiration. The timer callback re-acquires the mutex,
	// removes the pending entry if it's still there (a concurrent resume
	// would have removed it already), and fires onExpire on the still-
	// suspended session.
	pending.timer = time.AfterFunc(session.ttl, func() {
		m.mu.Lock()
		_, stillPending := m.pendingSessions[id]
		if stillPending {
			delete(m.pendingSessions, id)
		}
		m.mu.Unlock()
		if stillPending && onExpire != nil {
			onExpire()
		}
	})

	return true
}

// ResumeSession pulls a session out of the pending pool and reactivates
// it. Returns the saved state and the session, or nil if the session is
// unknown or already expired. The caller is responsible for applying the
// saved state to the new module instance (typically via
// ModuleInstance.HandleReconnect).
func (m *SessionManager) ResumeSession(id string) (*Session, map[string]any) {
	m.mu.Lock()
	pending, ok := m.pendingSessions[id]
	if !ok {
		m.mu.Unlock()
		return nil, nil
	}
	delete(m.pendingSessions, id)
	m.mu.Unlock()

	// Cancel the TTL timer outside the lock — Stop() returns false if the
	// timer already fired, but the fire branch checks pendingSessions
	// (which we just emptied) so onExpire won't run a second time.
	pending.timer.Stop()
	pending.session.touch()

	m.mu.Lock()
	m.activeSessions[id] = pending.session
	m.mu.Unlock()

	return pending.session, pending.savedState
}

// DestroySession removes a session entirely, whether active or pending,
// and cancels any TTL timer. Connection tracking for the session is
// cleared. The onExpire callback registered via SuspendSession is NOT
// fired by this method — destroy is for explicit teardown (e.g. on server
// shutdown), not expiration.
func (m *SessionManager) DestroySession(id string) {
	m.mu.Lock()
	delete(m.activeSessions, id)
	if pending, ok := m.pendingSessions[id]; ok {
		pending.timer.Stop()
		delete(m.pendingSessions, id)
	}
	delete(m.sessionConnections, id)
	m.mu.Unlock()
}

// TrackConnection associates a connection key with a session, applying
// the configured concurrent policy. Returns the set of connection keys
// that should be kicked (empty for AllowMultiple/first connection);
// returns nil when the engine says to reject.
//
// The policy decision (kick / reject / allow) is delegated to the
// engine's canonical `hypen_portable_session_step`; see
// `hypen-engine-rs/src/portable/session.rs`. This manager owns
// timers, connection maps, and socket handles; the engine owns the
// one-line decision.
func (m *SessionManager) TrackConnection(sessionID string, connKey any) ([]any, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()

	existing := m.sessionConnections[sessionID]

	effect, err := sessionStepViaEngine(m.config.Concurrent, uint32(len(existing)))
	if err != nil {
		panic(fmt.Sprintf("TrackConnection: engine portable runtime unavailable: %v", err))
	}

	switch effect {
	case "accept_and_kick_existing":
		kicked := make([]any, 0, len(existing))
		for k := range existing {
			kicked = append(kicked, k)
		}
		m.sessionConnections[sessionID] = map[any]struct{}{connKey: {}}
		return kicked, true
	case "reject_connection":
		return nil, false
	case "accept_connection":
		if existing == nil {
			existing = make(map[any]struct{})
			m.sessionConnections[sessionID] = existing
		}
		existing[connKey] = struct{}{}
		return nil, true
	default:
		panic(fmt.Sprintf("TrackConnection: unknown session effect %q from engine", effect))
	}
}

// UntrackConnection removes a connection from a session.
func (m *SessionManager) UntrackConnection(sessionID string, connKey any) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if conns, ok := m.sessionConnections[sessionID]; ok {
		delete(conns, connKey)
	}
}

// GetConnectionCount returns the number of active connections attached
// to the given session.
func (m *SessionManager) GetConnectionCount(sessionID string) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.sessionConnections[sessionID])
}

// SessionStats summarizes the current state of the manager.
type SessionStats struct {
	ActiveSessions   int
	PendingSessions  int
	TotalConnections int
}

// Stats returns a snapshot of session-manager activity.
func (m *SessionManager) Stats() SessionStats {
	m.mu.Lock()
	defer m.mu.Unlock()
	total := 0
	for _, conns := range m.sessionConnections {
		total += len(conns)
	}
	return SessionStats{
		ActiveSessions:   len(m.activeSessions),
		PendingSessions:  len(m.pendingSessions),
		TotalConnections: total,
	}
}

// Shutdown cancels all TTL timers and clears all session state. After
// Shutdown, the SessionManager should not be used again. Pending sessions
// are dropped silently — their onExpire callbacks are NOT fired (Shutdown
// is the "graceful server stop" path, not the "session expired" path).
func (m *SessionManager) Shutdown() {
	m.mu.Lock()
	for _, pending := range m.pendingSessions {
		pending.timer.Stop()
	}
	m.pendingSessions = make(map[string]*pendingSession)
	m.activeSessions = make(map[string]*Session)
	m.sessionConnections = make(map[string]map[any]struct{})
	m.mu.Unlock()
}
