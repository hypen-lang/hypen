// Tests for the reserved drag-and-drop outcome actions on the remote
// session (__hypen_reorder / __hypen_pin). Renderers behind the relay
// dispatch them like any action; the session must apply them to the
// module state and broadcast the resulting stateUpdate.
package remote

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"

	core "github.com/hypen-space/core"
)

func normalizeJSON(v any) any { return core.DeepCloneAny(v) }

// newDndSession builds an ENGINE-backed session (a source dir makes the
// session route dispatches through the WASM engine's action handlers, the
// path the reserved actions are registered on — the legacy no-sourceDir
// shim forwards every action to ModuleConfig.OnAction instead).
func newDndSession(t *testing.T) (*RemoteSession, *ChannelTransport) {
	t.Helper()
	core.App.Clear()
	t.Cleanup(func() { core.App.Clear() })
	s := NewRemoteServer().
		WithState("Board", map[string]any{
			"tasks": []any{"a", "b", "c"},
			"notes": []any{map[string]any{"id": "n1", "x": 0, "y": 0}},
		}).
		Source(t.TempDir()).
		UI(`module Board { Text("hi") }`)
	if err := s.Prepare(); err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	transport := NewChannelTransport(32)
	sess, err := s.CreateSession(transport, WithHelloGraceMs(-1))
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	t.Cleanup(func() { sess.Destroy() })

	hello, _ := json.Marshal(map[string]any{"type": "hello"})
	if err := sess.Receive(hello); err != nil {
		t.Fatalf("Receive hello: %v", err)
	}
	if msg := waitForMessage(t, transport, MessageTypeInitialTree, 5*time.Second); msg == nil {
		t.Fatal("no initialTree")
	}
	if sess.Engine() == nil {
		t.Fatal("expected an engine-backed session")
	}
	return sess, transport
}

func dispatch(t *testing.T, sess *RemoteSession, action string, payload map[string]any) {
	t.Helper()
	raw, _ := json.Marshal(map[string]any{"type": "dispatchAction", "action": action, "payload": payload})
	if err := sess.Receive(raw); err != nil {
		t.Fatalf("Receive dispatch: %v", err)
	}
}

func waitForState(t *testing.T, sess *RemoteSession, path string, want any) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		got, _ := core.PathGetViaEngine(sess.State(), path)
		if reflect.DeepEqual(normalizeJSON(got), normalizeJSON(want)) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s = %v, want %v", path, got, want)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestRemoteSession_ReorderActionAppliesToState(t *testing.T) {
	sess, _ := newDndSession(t)
	dispatch(t, sess, core.ReorderActionName, map[string]any{"path": "tasks", "from": 0, "to": 2})
	waitForState(t, sess, "tasks", []any{"b", "c", "a"})
}

func TestRemoteSession_PinActionAppliesBothFields(t *testing.T) {
	sess, _ := newDndSession(t)
	dispatch(t, sess, core.PinActionName, map[string]any{
		"path": "__dnd.board.n1", "x": 120, "y": 80, "xKey": "x", "yKey": "y",
	})
	waitForState(t, sess, "__dnd.board.n1", map[string]any{"x": 120, "y": 80})
	// Sibling user state is untouched.
	waitForState(t, sess, "notes.0", map[string]any{"id": "n1", "x": 0, "y": 0})
}

func TestRemoteSession_MalformedReorderLeavesStateUntouched(t *testing.T) {
	sess, _ := newDndSession(t)
	dispatch(t, sess, core.ReorderActionName, map[string]any{"path": "tasks", "from": 9, "to": 0})
	// Give the dispatch a moment, then assert nothing moved.
	time.Sleep(50 * time.Millisecond)
	waitForState(t, sess, "tasks", []any{"a", "b", "c"})
}
