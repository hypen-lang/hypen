package remote

import (
	"encoding/json"
	"errors"

	core "github.com/hypen-space/core"
)

// agent.go — attach mode for the agent surface.
//
// An AgentHandle binds an external caller (an MCP server, a REST route, an
// operator CLI, an LLM agent) to ONE live user session, so guarded
// dispatches and reads run on that user's engine and the user's own
// transport receives the resulting patches — the human watching the
// screen sees the cart badge tick. Obtain one via RemoteServer.Attach.
//
// Authorization is the developer's: Attach is an in-process call made from
// the developer's own handler, so whoever calls it is the authorizer. There
// is no HTTP route for it.

var (
	// ErrNoSuchSession is returned by Attach when no live, hello-completed
	// session carries the requested id (unknown id, hello not yet
	// completed, or the session has already been destroyed).
	ErrNoSuchSession = errors.New("remote: no ready session with that id")

	// ErrNoEngine is returned when the session exists but never built an
	// engine — the server was configured without both Source() and UI(),
	// so it runs the legacy no-engine shim, which exposes no guarded
	// external surface.
	ErrNoEngine = errors.New("remote: session has no engine (attach requires Source() and UI())")

	// ErrSessionClosed is returned by every handle method once the user
	// session behind it has been destroyed. The handle itself is inert
	// from then on; obtain a fresh one via Attach if the user reconnects.
	ErrSessionClosed = errors.New("remote: session closed")
)

// AgentHandle is a non-owning view of one live user session for callers
// that are not the rendered UI.
//
//   - Dispatch goes through the engine's guarded DispatchExternal — never
//     the renderer's permissive dispatchAction path — so only declared
//     `.OnAction()` handlers and the hypen.* built-ins the app backs are
//     reachable. A refusal returns an error and emits no traffic on the
//     user's transport and no revision bump.
//   - A successful Dispatch emits on the user's transport exactly what a
//     click on that session emits: a `patch` message at the next revision,
//     then a `stateUpdate` at the same revision.
//   - The handle never owns, destroys, suspends, or closes the session.
//     Dropping a handle has no effect on the user; destroying the user's
//     session makes every handle method return ErrSessionClosed.
//
// There is no Manifest() on the Go handle: the WASI layer the Go SDK loads
// (hypen-engine-rs/src/wasm/wasi.rs) exports no mcp_manifest, unlike the
// uniffi (Kotlin/Swift) and wasm-bindgen (TypeScript) bindings. Build a
// manifest host-side from ListActions plus the engine's ListRoutes /
// ListBindings if you need one.
type AgentHandle struct {
	session   *RemoteSession
	sessionID string
}

func newAgentHandle(session *RemoteSession) *AgentHandle {
	return &AgentHandle{session: session, sessionID: session.SessionID()}
}

// SessionID returns the Hypen session id this handle is bound to.
func (h *AgentHandle) SessionID() string { return h.sessionID }

// ListActions returns every action an external caller may dispatch on the
// session right now: declared module actions plus whichever hypen.*
// built-ins the app backs. Framework internals never appear.
func (h *AgentHandle) ListActions() ([]core.AgentAction, error) {
	engine, err := h.session.liveEngine()
	if err != nil {
		return nil, err
	}
	return engine.ListActions()
}

// Dispatch fires a guarded external dispatch on the user's session. See
// RemoteSession.DispatchExternal for the full contract; in short, success
// means the user's transport has received the resulting patch and
// stateUpdate, and an error means nothing happened.
func (h *AgentHandle) Dispatch(name string, payload any) error {
	return h.session.DispatchExternal(name, payload)
}

// GetState reads module state, whole or at a dotted path, through the
// engine's redacting read. Pass nil for module to read the primary
// module; pass nil for path to read the whole tree. Returns JSON "null"
// when the module is unknown or the path is absent — the engine does not
// distinguish the two, so a caller cannot probe for state it is not shown.
func (h *AgentHandle) GetState(module, path *string) (json.RawMessage, error) {
	engine, err := h.session.liveEngine()
	if err != nil {
		return nil, err
	}
	return engine.GetStateAt(module, path)
}

// Revision returns the session's current wire revision — the number the
// user's renderer last saw on a `patch` / `stateUpdate` message. Errors
// with ErrSessionClosed once the session is gone.
func (h *AgentHandle) Revision() (int, error) {
	if _, err := h.session.liveEngine(); err != nil {
		return 0, err
	}
	return h.session.Revision(), nil
}
