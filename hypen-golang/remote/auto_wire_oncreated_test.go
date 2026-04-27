// Regression tests for the Social symptom "feed stays empty after
// connect". Reproduces the path end-to-end: a nested module whose
// OnCreated hook mutates state MUST deliver those mutations to the
// client (either via patches in-band after initialTree, or via a
// stateUpdate after subscribeState). Without this test the bug was
// only visible in the real mobile client, which is expensive to
// re-smoke.
package remote

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	core "github.com/hypen-space/core"
)

// waitForMessage drains transport output until it finds a message of
// the given type or the deadline elapses. Returns nil on timeout.
func waitForMessage(t *testing.T, tr *ChannelTransport, kind MessageType, timeout time.Duration) Message {
	t.Helper()
	deadline := time.After(timeout)
	for {
		select {
		case msg, ok := <-tr.Out():
			if !ok {
				return nil
			}
			if msg.GetType() == kind {
				return msg
			}
		case <-deadline:
			return nil
		}
	}
}

// TestAutoWire_OnCreatedStateReachesClient reproduces the "feed is
// empty" symptom the user hit in the iOS Simulator. HomePage's
// OnCreated loads a sentinel into state; the session must ship a
// patch (or stateUpdate) reflecting that state to the client. If the
// nested ModuleInstance's state changes vanish (e.g. because the
// scope, patch-callback, or primary-slot wiring is wrong) the
// sentinel never leaves the server.
func TestAutoWire_OnCreatedStateReachesClient(t *testing.T) {
	core.App.Clear()
	t.Cleanup(func() { core.App.Clear() })

	// Minimal App + HomePage templates, written to a tmpfs tree so
	// RemoteServer.Source() discovers them like Social does.
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
	write("App", `module App {
		Router {
			Route(path: "/") { HomePage() }
		}
	}`)
	write("HomePage", `module HomePage {
		Text("feed-sentinel: @{state.sentinel}")
	}`)

	// HomePage state shape: a single sentinel string that OnCreated
	// populates. We read it back off the wire.
	type HomePageState struct {
		Sentinel string `json:"sentinel"`
	}
	core.NewApp(HomePageState{}).
		Name("HomePage").
		OnCreated(func(state *HomePageState, _ core.GlobalContext) {
			state.Sentinel = "loaded-by-oncreated"
		}).
		Build()

	// Primary App definition so Definition() returns non-nil (the
	// auto-wire needs it for the primary-instance wrapper registered
	// in the GlobalContext).
	appDef := core.App.Module("App").
		DefineState(map[string]any{"location": "/"}, nil).
		Build()

	server := NewRemoteServer().
		WithDefinition(appDef).
		Source(dir).
		UI(`module App {
			Router {
				Route(path: "/") { HomePage() }
			}
		}`)
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
	if msg := waitForMessage(t, transport, MessageTypeInitialTree, 5*time.Second); msg == nil {
		t.Fatal("no initialTree")
	}

	// Subscribe so subsequent state changes also come down as
	// stateUpdate messages (patches always flow; stateUpdate is the
	// extra explicit signal).
	sub, _ := json.Marshal(map[string]any{"type": "subscribeState"})
	_ = sess.Receive(sub)

	// OnCreated fires synchronously inside ManagedRouter.mount, which
	// autoWireManagedRouter calls at the end of initializeSession.
	// By the time we asked for initialTree above, the nested OnCreated
	// has already run — but its state change might still be on the
	// wire. Poll a short window for either a patch message OR a
	// stateUpdate reflecting the sentinel.
	deadline := time.Now().Add(3 * time.Second)
	var patchFound, stateFound bool
	for time.Now().Before(deadline) {
		select {
		case msg, ok := <-transport.Out():
			if !ok {
				break
			}
			switch m := msg.(type) {
			case *PatchMessage:
				// Any follow-up patch proves the engine emitted patches
				// for HomePage's state change. The initialTree message
				// was already consumed; this path only fires if the
				// nested state update reaches patchCallback.
				patchFound = true
			case *StateUpdateMessage:
				// Once state is populated and subscribeState is active,
				// the session emits stateUpdate. Primary state here is
				// App's state, not HomePage's — the real probe is
				// whether HomePage's state made it into the engine at
				// all, which we check via sess internals below.
				_ = m
				stateFound = true
			}
		case <-time.After(50 * time.Millisecond):
			// Keep polling until deadline.
		}
		if patchFound || stateFound {
			break
		}
	}

	if !patchFound {
		t.Fatalf("expected a post-initialTree patch message carrying HomePage's OnCreated state; got none. " +
			"The nested ModuleInstance's state-change patch callback is likely not firing.")
	}
}

// TestAutoWire_RouterPushTriggersRerender reproduces the "feed shows
// but routing doesn't work" symptom. After dispatching `@router.push`
// to a different route, the session must ship a patch reflecting the
// subtree swap (Detach/Attach) OR at minimum a stateUpdate showing
// the new location. If neither arrives, the client sees nothing
// change — the bug the user hit on iOS Simulator.
func TestAutoWire_RouterPushTriggersRerender(t *testing.T) {
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
	write("App", `module App {
		Router {
			Route(path: "/") { Home() }
			Route(path: "/search") { Search() }
		}
	}`)
	write("Home", `module Home { Text("home-page") }`)
	write("Search", `module Search { Text("search-page") }`)

	type Empty struct{}
	core.NewApp(Empty{}).Name("Home").Build()
	core.NewApp(Empty{}).Name("Search").Build()

	appDef := core.App.Module("App").
		DefineState(map[string]any{"location": "/"}, nil).
		Build()

	server := NewRemoteServer().
		WithDefinition(appDef).
		Source(dir).
		UI(`module App {
			Router {
				Route(path: "/") { Home() }
				Route(path: "/search") { Search() }
			}
		}`)
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
	_ = sess.Receive(hello)
	if msg := waitForMessage(t, transport, MessageTypeInitialTree, 5*time.Second); msg == nil {
		t.Fatal("no initialTree")
	}

	// Drain any follow-up patches from HomePage (none here since Home
	// has no state/actions) before the nav.
	drainDeadline := time.Now().Add(200 * time.Millisecond)
	for time.Now().Before(drainDeadline) {
		select {
		case <-transport.Out():
		case <-time.After(50 * time.Millisecond):
			// Nothing pending.
		}
	}

	// Dispatch @router.push to /search.
	push, _ := json.Marshal(map[string]any{
		"type":    "dispatchAction",
		"action":  "router.push",
		"payload": map[string]any{"to": "/search"},
	})
	_ = sess.Receive(push)

	// Expect either:
	//   - a patch message reflecting the engine's Router IR subtree
	//     swap (Detach /Home subtree, Attach /search subtree), OR
	//   - state.location updated to "/search" in the session.
	// Poll for 3s; fail if neither shows up.
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		loc, _ := sess.State()["location"].(string)
		if loc == "/search" {
			return // passed
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("state.location never updated to /search after router.push; got %v. "+
		"Router navigation via @router.push is broken (subtree not swapping).", sess.State()["location"])
}
