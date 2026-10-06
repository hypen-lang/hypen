// Tests for attach mode on the agent surface:
//   - RemoteServer.Attach binds an AgentHandle to a live user session
//   - a handle dispatch reaches the USER's transport exactly like a click
//   - a guard refusal is silent: error, no traffic, no revision bump
//   - the handle never owns the session and goes inert once it is gone
package remote

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	core "github.com/hypen-space/core"
)

// attachCartState is the primary module's state for these tests. `total`
// is bound in the template so a handler mutation produces a real patch.
type attachCartState struct {
	Total int `json:"total"`
}

const attachTestUI = `module App {
	Text("total: @{state.total}")
	Button("@actions.addToCart") { Text("Add") }
}`

// attachFixture is one prepared server plus one hello-completed user
// session on a ChannelTransport, with sessionAck + initialTree drained.
type attachFixture struct {
	server    *RemoteServer
	session   *RemoteSession
	transport *ChannelTransport
	sessionID string
}

func newAttachFixture(t *testing.T) *attachFixture {
	t.Helper()
	core.App.Clear()
	t.Cleanup(func() { core.App.Clear() })

	appDef := core.NewApp(attachCartState{Total: 0}).
		Name("App").
		OnAction("addToCart", func(ctx core.TypedActionContext[attachCartState]) {
			ctx.State.Total++
		}).
		Build()

	// The engine only exists when BOTH Source and UI are configured.
	server := NewRemoteServer().
		WithDefinition(appDef).
		Source(t.TempDir()).
		UI(attachTestUI)
	if err := server.Prepare(); err != nil {
		t.Fatalf("Prepare: %v", err)
	}

	transport := NewChannelTransport(64)
	sess, err := server.CreateSession(transport, WithHelloGraceMs(-1))
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	t.Cleanup(func() { _ = sess.Destroy() })

	hello, _ := json.Marshal(map[string]any{"type": "hello"})
	if err := sess.Receive(hello); err != nil {
		t.Fatalf("Receive hello: %v", err)
	}
	ack := waitForMessage(t, transport, MessageTypeSessionAck, 5*time.Second)
	if ack == nil {
		t.Fatal("no sessionAck")
	}
	if waitForMessage(t, transport, MessageTypeInitialTree, 5*time.Second) == nil {
		t.Fatal("no initialTree")
	}
	select {
	case <-sess.Ready():
	case <-time.After(5 * time.Second):
		t.Fatal("session never became ready")
	}
	if sess.Engine() == nil {
		t.Fatal("fixture expects an engine-backed session")
	}

	return &attachFixture{
		server:    server,
		session:   sess,
		transport: transport,
		sessionID: ack.(*SessionAckMessage).SessionID,
	}
}

// nextMessage returns the next message on the user's transport, or nil
// if none arrives within timeout.
func nextMessage(tr *ChannelTransport, timeout time.Duration) Message {
	select {
	case msg, ok := <-tr.Out():
		if !ok {
			return nil
		}
		return msg
	case <-time.After(timeout):
		return nil
	}
}

// expectDispatchPair asserts the next two messages on the user's
// transport are a patch then a stateUpdate, both at wantRev, and returns
// the stateUpdate's `total`.
func expectDispatchPair(t *testing.T, tr *ChannelTransport, wantRev int) float64 {
	t.Helper()
	first := nextMessage(tr, 5*time.Second)
	patch, ok := first.(*PatchMessage)
	if !ok {
		t.Fatalf("first message after dispatch: want *PatchMessage, got %T (%+v)", first, first)
	}
	if patch.Revision != wantRev {
		t.Fatalf("patch revision = %d, want %d", patch.Revision, wantRev)
	}
	if len(patch.Patches) == 0 {
		t.Fatal("patch message carried no patches")
	}
	second := nextMessage(tr, 5*time.Second)
	upd, ok := second.(*StateUpdateMessage)
	if !ok {
		t.Fatalf("second message after dispatch: want *StateUpdateMessage, got %T (%+v)", second, second)
	}
	if upd.Revision != wantRev {
		t.Fatalf("stateUpdate revision = %d, want %d", upd.Revision, wantRev)
	}
	state, _ := upd.State.(map[string]any)
	total, _ := state["total"].(float64)
	if raw, isInt := state["total"].(int); isInt {
		total = float64(raw)
	}
	return total
}

func TestAttach_DispatchReachesUserTransport(t *testing.T) {
	fx := newAttachFixture(t)

	handle, err := fx.server.Attach(fx.sessionID)
	if err != nil {
		t.Fatalf("Attach: %v", err)
	}
	if handle.SessionID() != fx.sessionID {
		t.Fatalf("handle.SessionID() = %q, want %q", handle.SessionID(), fx.sessionID)
	}
	if rev, err := handle.Revision(); err != nil || rev != 0 {
		t.Fatalf("initial Revision() = %d, %v; want 0, nil", rev, err)
	}

	if err := handle.Dispatch("addToCart", nil); err != nil {
		t.Fatalf("Dispatch: %v", err)
	}

	// The browser-side proof: the USER's transport gets the patch at
	// revision 1, then the stateUpdate at revision 1 carrying total=1.
	if total := expectDispatchPair(t, fx.transport, 1); total != 1 {
		t.Fatalf("stateUpdate total = %v, want 1", total)
	}
	if rev, err := handle.Revision(); err != nil || rev != 1 {
		t.Fatalf("Revision() after dispatch = %d, %v; want 1, nil", rev, err)
	}

	// The guarded read agrees with what went over the wire.
	got, err := handle.GetState(nil, strPtrRemote("total"))
	if err != nil {
		t.Fatalf("GetState: %v", err)
	}
	if string(got) != "1" {
		t.Fatalf("GetState(total) = %s, want 1", got)
	}

	// The handle never touched the session's lifecycle.
	select {
	case <-fx.session.Closed():
		t.Fatal("user session was closed by an attached dispatch")
	default:
	}
}

func TestAttach_ListActionsIsTheDeclaredSurface(t *testing.T) {
	fx := newAttachFixture(t)
	handle, err := fx.server.Attach(fx.sessionID)
	if err != nil {
		t.Fatalf("Attach: %v", err)
	}
	actions, err := handle.ListActions()
	if err != nil {
		t.Fatalf("ListActions: %v", err)
	}
	var sawDeclared bool
	for _, a := range actions {
		switch a.Name {
		case "addToCart":
			sawDeclared = true
		case "__hypen_bind", "router.push", "router.replace":
			t.Fatalf("framework internal %q leaked into ListActions", a.Name)
		}
	}
	if !sawDeclared {
		t.Fatalf("addToCart missing from ListActions: %+v", actions)
	}
}

func TestAttach_RefusalIsSilent(t *testing.T) {
	fx := newAttachFixture(t)
	handle, err := fx.server.Attach(fx.sessionID)
	if err != nil {
		t.Fatalf("Attach: %v", err)
	}

	refused := []struct {
		name    string
		payload any
	}{
		{"__hypen_bind", map[string]any{"path": "total", "value": 99}},
		{"router.push", map[string]any{"to": "/admin"}},
		{core.ActionNavigate, map[string]any{"to": "/"}}, // no Router declared
		{"noSuchAction", nil},
	}
	for _, tc := range refused {
		err := handle.Dispatch(tc.name, tc.payload)
		if err == nil {
			t.Fatalf("Dispatch(%q) must be refused", tc.name)
		}
		var engErr *core.EngineError
		if !errors.As(err, &engErr) {
			t.Fatalf("Dispatch(%q) error = %T (%v), want *core.EngineError", tc.name, err, err)
		}
	}

	// No traffic reached the user (bounded wait), and the revision is
	// untouched on both the handle and the session.
	if msg := nextMessage(fx.transport, 150*time.Millisecond); msg != nil {
		t.Fatalf("refused dispatch leaked %T onto the user's transport: %+v", msg, msg)
	}
	if rev, err := handle.Revision(); err != nil || rev != 0 {
		t.Fatalf("Revision() after refusals = %d, %v; want 0, nil", rev, err)
	}
	if fx.session.Revision() != 0 {
		t.Fatalf("session revision bumped to %d by a refusal", fx.session.Revision())
	}
	if got, _ := handle.GetState(nil, strPtrRemote("total")); string(got) != "0" {
		t.Fatalf("state changed by a refused dispatch: total=%s", got)
	}
	select {
	case <-fx.session.Closed():
		t.Fatal("user session was closed by a refused dispatch")
	default:
	}
}

// TestAttach_WireIdenticalToClick dispatches once through the handle and
// once through the renderer path (Receive of a dispatchAction message)
// and checks both produce the same message shapes with consecutive
// revisions.
func TestAttach_WireIdenticalToClick(t *testing.T) {
	fx := newAttachFixture(t)
	handle, err := fx.server.Attach(fx.sessionID)
	if err != nil {
		t.Fatalf("Attach: %v", err)
	}

	if err := handle.Dispatch("addToCart", nil); err != nil {
		t.Fatalf("handle Dispatch: %v", err)
	}
	if total := expectDispatchPair(t, fx.transport, 1); total != 1 {
		t.Fatalf("after agent dispatch total = %v, want 1", total)
	}

	click, _ := json.Marshal(map[string]any{"type": "dispatchAction", "action": "addToCart"})
	if err := fx.session.Receive(click); err != nil {
		t.Fatalf("Receive click: %v", err)
	}
	if total := expectDispatchPair(t, fx.transport, 2); total != 2 {
		t.Fatalf("after click total = %v, want 2", total)
	}

	if err := handle.Dispatch("addToCart", map[string]any{"qty": 1}); err != nil {
		t.Fatalf("handle Dispatch (2): %v", err)
	}
	if total := expectDispatchPair(t, fx.transport, 3); total != 3 {
		t.Fatalf("after second agent dispatch total = %v, want 3", total)
	}
}

// TestAttach_AgentAndClickSerialize hammers the session from both sides
// concurrently; dispatchMu must keep every patch/stateUpdate pair intact
// and the revision sequence gap-free.
func TestAttach_AgentAndClickSerialize(t *testing.T) {
	fx := newAttachFixture(t)
	handle, err := fx.server.Attach(fx.sessionID)
	if err != nil {
		t.Fatalf("Attach: %v", err)
	}

	const perSide = 15
	click, _ := json.Marshal(map[string]any{"type": "dispatchAction", "action": "addToCart"})

	// Drain concurrently so the 64-slot transport buffer never blocks a
	// dispatcher.
	type pair struct {
		kind MessageType
		rev  int
	}
	var seen []pair
	var seenMu sync.Mutex
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			msg := nextMessage(fx.transport, 3*time.Second)
			if msg == nil {
				return
			}
			var rev int
			switch m := msg.(type) {
			case *PatchMessage:
				rev = m.Revision
			case *StateUpdateMessage:
				rev = m.Revision
			}
			seenMu.Lock()
			seen = append(seen, pair{msg.GetType(), rev})
			n := len(seen)
			seenMu.Unlock()
			if n == 2*2*perSide {
				return
			}
		}
	}()

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		for i := 0; i < perSide; i++ {
			if err := handle.Dispatch("addToCart", nil); err != nil {
				t.Errorf("agent Dispatch %d: %v", i, err)
			}
		}
	}()
	go func() {
		defer wg.Done()
		for i := 0; i < perSide; i++ {
			if err := fx.session.Receive(click); err != nil {
				t.Errorf("click %d: %v", i, err)
			}
		}
	}()
	wg.Wait()
	<-done

	seenMu.Lock()
	defer seenMu.Unlock()
	if len(seen) != 4*perSide {
		t.Fatalf("saw %d messages, want %d: %+v", len(seen), 4*perSide, seen)
	}
	for i := 0; i < len(seen); i += 2 {
		wantRev := i/2 + 1
		if seen[i].kind != MessageTypePatch || seen[i].rev != wantRev {
			t.Fatalf("message %d = %+v, want patch@%d", i, seen[i], wantRev)
		}
		if seen[i+1].kind != MessageTypeStateUpdate || seen[i+1].rev != wantRev {
			t.Fatalf("message %d = %+v, want stateUpdate@%d", i+1, seen[i+1], wantRev)
		}
	}
	if got, _ := handle.GetState(nil, strPtrRemote("total")); string(got) != "30" {
		t.Fatalf("final total = %s, want 30", got)
	}
}

func TestAttach_UnknownSessionID(t *testing.T) {
	fx := newAttachFixture(t)
	for _, id := range []string{"", "nope", fx.sessionID + "x"} {
		h, err := fx.server.Attach(id)
		if !errors.Is(err, ErrNoSuchSession) {
			t.Fatalf("Attach(%q) = %v, %v; want ErrNoSuchSession", id, h, err)
		}
		if h != nil {
			t.Fatalf("Attach(%q) returned a handle on error", id)
		}
	}
}

func TestAttach_BeforeHelloIsNotReady(t *testing.T) {
	fx := newAttachFixture(t)
	// A second connection that never hellos has no session id and is not
	// ready; it must be invisible to Attach.
	tr := NewChannelTransport(8)
	pending, err := fx.server.CreateSession(tr, WithHelloGraceMs(-1))
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	t.Cleanup(func() { _ = pending.Destroy() })
	if pending.SessionID() != "" {
		t.Fatalf("pending session already has id %q", pending.SessionID())
	}
	// The ready session is still attachable alongside the pending one.
	if _, err := fx.server.Attach(fx.sessionID); err != nil {
		t.Fatalf("Attach ready session: %v", err)
	}
}

func TestAttach_NoEngineServer(t *testing.T) {
	// WithState + UI but no Source: the session runs the legacy shim and
	// never builds an engine, so there is no guarded surface to bind.
	server := NewRemoteServer().
		WithState("Counter", map[string]any{"count": 0}).
		UI(`Text("hi")`)
	if err := server.Prepare(); err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	transport := NewChannelTransport(16)
	sess, err := server.CreateSession(transport, WithHelloGraceMs(-1))
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	t.Cleanup(func() { _ = sess.Destroy() })
	hello, _ := json.Marshal(map[string]any{"type": "hello"})
	if err := sess.Receive(hello); err != nil {
		t.Fatalf("Receive hello: %v", err)
	}
	ack := waitForMessage(t, transport, MessageTypeSessionAck, 5*time.Second)
	if ack == nil {
		t.Fatal("no sessionAck")
	}
	if waitForMessage(t, transport, MessageTypeInitialTree, 5*time.Second) == nil {
		t.Fatal("no initialTree")
	}
	<-sess.Ready()

	h, err := server.Attach(ack.(*SessionAckMessage).SessionID)
	if !errors.Is(err, ErrNoEngine) {
		t.Fatalf("Attach on no-engine server = %v, %v; want ErrNoEngine", h, err)
	}
	// Calling the session primitive directly reports the same thing.
	if err := sess.DispatchExternal("anything", nil); !errors.Is(err, ErrNoEngine) {
		t.Fatalf("DispatchExternal on no-engine session = %v; want ErrNoEngine", err)
	}
	if msg := nextMessage(transport, 100*time.Millisecond); msg != nil {
		t.Fatalf("no-engine DispatchExternal leaked %T onto the transport", msg)
	}
}

func TestAttach_AfterDestroyIsInert(t *testing.T) {
	fx := newAttachFixture(t)
	handle, err := fx.server.Attach(fx.sessionID)
	if err != nil {
		t.Fatalf("Attach: %v", err)
	}

	// The USER tears the session down; the handle merely observes it.
	if err := fx.session.Destroy(); err != nil {
		t.Fatalf("Destroy: %v", err)
	}
	select {
	case <-fx.session.Closed():
	case <-time.After(5 * time.Second):
		t.Fatal("session never closed")
	}

	if err := handle.Dispatch("addToCart", nil); !errors.Is(err, ErrSessionClosed) {
		t.Fatalf("Dispatch after destroy = %v; want ErrSessionClosed", err)
	}
	if _, err := handle.ListActions(); !errors.Is(err, ErrSessionClosed) {
		t.Fatalf("ListActions after destroy = %v; want ErrSessionClosed", err)
	}
	if _, err := handle.GetState(nil, nil); !errors.Is(err, ErrSessionClosed) {
		t.Fatalf("GetState after destroy = %v; want ErrSessionClosed", err)
	}
	if _, err := handle.Revision(); !errors.Is(err, ErrSessionClosed) {
		t.Fatalf("Revision after destroy = %v; want ErrSessionClosed", err)
	}
	// The stale id no longer attaches.
	if _, err := fx.server.Attach(fx.sessionID); !errors.Is(err, ErrNoSuchSession) {
		t.Fatalf("Attach after destroy = %v; want ErrNoSuchSession", err)
	}
}

// TestAttach_ServerStopDoesNotComeFromHandle pins that the only path that
// destroys a user session is the user/server side: after Stop() the
// handle is inert, and before Stop() nothing a handle does closes it.
func TestAttach_ServerStopLeavesHandleInert(t *testing.T) {
	fx := newAttachFixture(t)
	handle, err := fx.server.Attach(fx.sessionID)
	if err != nil {
		t.Fatalf("Attach: %v", err)
	}
	if err := handle.Dispatch("addToCart", nil); err != nil {
		t.Fatalf("Dispatch: %v", err)
	}
	expectDispatchPair(t, fx.transport, 1)
	select {
	case <-fx.session.Closed():
		t.Fatal("handle activity closed the session")
	default:
	}

	fx.server.Stop()
	if err := handle.Dispatch("addToCart", nil); !errors.Is(err, ErrSessionClosed) {
		t.Fatalf("Dispatch after Stop = %v; want ErrSessionClosed", err)
	}
}

func strPtrRemote(s string) *string { return &s }

// ---------------------------------------------------------------------
// Ready-window regression: hypen.navigate right after Ready / from
// OnConnection.
//
// The guard authorises hypen.navigate as soon as the template declares a
// Router, but the `router.push` handler it resolves to is only installed
// by autoWireManagedRouter. Ready() (and OnConnection) must therefore
// fire AFTER the auto-wire, otherwise an attached navigation in that
// window is authorised, returns nil, bumps no revision, ships no patch,
// and emits a bare stateUpdate — a shape no renderer click can produce.
// ---------------------------------------------------------------------

type attachPageState struct {
	Label string `json:"label"`
}

const attachRouterUI = `module App {
	Router {
		Route(path: "/") { HomePage() }
		Route(path: "/about") { AboutPage() }
	}
}`

// newAttachRouterServer prepares a server whose primary template declares
// a Router with two routes, each backed by a registered module whose
// template lives under the source dir (the canonical `.Source()` shape).
// Only the server is built; callers create the session so they control
// the hello timing.
func newAttachRouterServer(t *testing.T) *RemoteServer {
	t.Helper()
	core.App.Clear()
	t.Cleanup(func() { core.App.Clear() })

	dir := t.TempDir()
	write := func(name, dsl string) {
		sub := filepath.Join(dir, name)
		if err := os.MkdirAll(sub, 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		if err := os.WriteFile(filepath.Join(sub, "component.hypen"), []byte(dsl), 0o644); err != nil {
			t.Fatalf("write: %v", err)
		}
	}
	write("App", attachRouterUI)
	write("HomePage", `module HomePage { Text("home-marker") }`)
	write("AboutPage", `module AboutPage { Text("about-marker") }`)

	core.NewApp(attachPageState{}).Name("HomePage").Build()
	core.NewApp(attachPageState{}).Name("AboutPage").Build()
	appDef := core.App.Module("App").
		DefineState(map[string]any{"location": "/"}, nil).
		Build()

	server := NewRemoteServer().
		WithDefinition(appDef).
		Source(dir).
		UI(attachRouterUI)
	if err := server.Prepare(); err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	return server
}

// waitForPatchContaining drains the user's transport until a patch
// message whose serialised patches contain needle arrives, or the
// deadline elapses. Returns the matching message or nil.
func waitForPatchContaining(tr *ChannelTransport, needle string, timeout time.Duration) *PatchMessage {
	deadline := time.After(timeout)
	for {
		select {
		case msg, ok := <-tr.Out():
			if !ok {
				return nil
			}
			pm, isPatch := msg.(*PatchMessage)
			if !isPatch {
				continue
			}
			raw, err := json.Marshal(pm.Patches)
			if err == nil && strings.Contains(string(raw), needle) {
				return pm
			}
		case <-deadline:
			return nil
		}
	}
}

// TestAttach_NavigateImmediatelyAfterReady attaches the instant Ready()
// unblocks — while the hello Receive is still running on its own
// goroutine — and expects hypen.navigate to actually reach the user's
// transport as a patch. Before the fix, Ready closed before the router
// handlers existed and the navigation was silently dropped.
func TestAttach_NavigateImmediatelyAfterReady(t *testing.T) {
	server := newAttachRouterServer(t)

	transport := NewChannelTransport(64)
	sess, err := server.CreateSession(transport, WithHelloGraceMs(-1))
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	t.Cleanup(func() { _ = sess.Destroy() })

	hello, _ := json.Marshal(map[string]any{"type": "hello"})
	recvErr := make(chan error, 1)
	go func() { recvErr <- sess.Receive(hello) }()

	// The whole hello flow (engine instantiation included) runs inside
	// this wait, so it is deliberately generous — under -race it takes
	// several seconds.
	select {
	case <-sess.Ready():
	case <-time.After(30 * time.Second):
		t.Fatal("session never became ready")
	}

	handle, err := server.Attach(sess.SessionID())
	if err != nil {
		t.Fatalf("Attach right after Ready: %v", err)
	}
	actions, err := handle.ListActions()
	if err != nil {
		t.Fatalf("ListActions: %v", err)
	}
	var sawNavigate bool
	for _, a := range actions {
		if a.Name == core.ActionNavigate {
			sawNavigate = true
		}
	}
	if !sawNavigate {
		t.Fatalf("hypen.navigate not advertised: %+v", actions)
	}

	before, err := handle.Revision()
	if err != nil {
		t.Fatalf("Revision: %v", err)
	}
	if err := handle.Dispatch(core.ActionNavigate, map[string]any{"to": "/about"}); err != nil {
		t.Fatalf("Dispatch(hypen.navigate): %v", err)
	}
	if pm := waitForPatchContaining(transport, "about-marker", 5*time.Second); pm == nil {
		t.Fatal("navigation authorised but no patch mounting /about reached the user's transport")
	}
	after, err := handle.Revision()
	if err != nil {
		t.Fatalf("Revision after navigate: %v", err)
	}
	if after <= before {
		t.Fatalf("revision did not advance on navigate: before=%d after=%d", before, after)
	}

	select {
	case err := <-recvErr:
		if err != nil {
			t.Fatalf("Receive hello: %v", err)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("Receive(hello) never returned")
	}
}

// TestAttach_NavigateFromOnConnection attaches from inside an
// OnConnection callback — the earliest host-visible moment for a new
// session — and expects the same navigation to land.
func TestAttach_NavigateFromOnConnection(t *testing.T) {
	server := newAttachRouterServer(t)

	var (
		attachErr   error
		dispatchErr error
		callbackRan = make(chan struct{})
	)
	server.OnConnection(func(client *Client) {
		defer close(callbackRan)
		var sessionID string
		for _, s := range server.Sessions() {
			if s.ID == client.ID {
				sessionID = s.SessionID()
			}
		}
		handle, err := server.Attach(sessionID)
		if err != nil {
			attachErr = err
			return
		}
		dispatchErr = handle.Dispatch(core.ActionNavigate, map[string]any{"to": "/about"})
	})

	transport := NewChannelTransport(64)
	sess, err := server.CreateSession(transport, WithHelloGraceMs(-1))
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	t.Cleanup(func() { _ = sess.Destroy() })

	hello, _ := json.Marshal(map[string]any{"type": "hello"})
	if err := sess.Receive(hello); err != nil {
		t.Fatalf("Receive hello: %v", err)
	}
	select {
	case <-callbackRan:
	case <-time.After(5 * time.Second):
		t.Fatal("OnConnection never fired")
	}
	if attachErr != nil {
		t.Fatalf("Attach from OnConnection: %v", attachErr)
	}
	if dispatchErr != nil {
		t.Fatalf("Dispatch from OnConnection: %v", dispatchErr)
	}
	if pm := waitForPatchContaining(transport, "about-marker", 5*time.Second); pm == nil {
		t.Fatal("navigation from OnConnection never reached the user's transport")
	}
}
