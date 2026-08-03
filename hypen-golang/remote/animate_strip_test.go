// Tests for the reserved transaction-animation payload key strip (Option D).
//
// TypeScript renderers carry an event applicator's `animate:` stamp across
// dispatchAction under the reserved "__hypenAnimate" payload key. The Go
// host does not implement transaction stamping, but the key is a
// renderer→host directive either way — module handlers must never observe
// it. handleDispatchAction strips it before both the engine path and the
// legacy ModuleConfig.OnAction shim.
package remote

import (
	"encoding/json"
	"testing"
	"time"
)

func TestStripReservedAnimateKey(t *testing.T) {
	payload := map[string]any{
		"postId":           "p1",
		reservedAnimateKey: "spring",
	}
	got := stripReservedAnimateKey(payload)
	m, ok := got.(map[string]any)
	if !ok {
		t.Fatalf("expected map, got %T", got)
	}
	if _, present := m[reservedAnimateKey]; present {
		t.Fatal("reserved key must be stripped")
	}
	if m["postId"] != "p1" {
		t.Fatalf("user keys must survive, got %+v", m)
	}

	// Non-map payloads pass through untouched.
	if got := stripReservedAnimateKey("plain"); got != "plain" {
		t.Fatalf("non-map payload changed: %v", got)
	}
	if got := stripReservedAnimateKey(nil); got != nil {
		t.Fatalf("nil payload changed: %v", got)
	}

	// A user-data `animate` key (not the reserved key) is NOT stripped —
	// only the reserved cross-boundary key is a directive.
	user := map[string]any{"animate": false}
	m = stripReservedAnimateKey(user).(map[string]any)
	if v, present := m["animate"]; !present || v != false {
		t.Fatalf("plain 'animate' user key must survive, got %+v", m)
	}
}

func TestDispatchAction_StripsReservedAnimateKeyBeforeHandler(t *testing.T) {
	seen := make(chan any, 1)
	s := NewRemoteServer().
		WithState("Counter", map[string]any{"count": 0}).
		OnAction(func(action string, payload any, state map[string]any) map[string]any {
			seen <- payload
			return state
		}).
		UI(`Text("hi")`)
	if err := s.Prepare(); err != nil {
		t.Fatalf("Prepare: %v", err)
	}

	transport := NewChannelTransport(16)
	sess, err := s.CreateSession(transport, WithHelloGraceMs(-1))
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	defer sess.Destroy()

	hello, _ := json.Marshal(map[string]any{"type": "hello"})
	if err := sess.Receive(hello); err != nil {
		t.Fatalf("Receive hello: %v", err)
	}

	dispatch, _ := json.Marshal(map[string]any{
		"type":   "dispatchAction",
		"action": "doThing",
		"payload": map[string]any{
			"postId":           "p1",
			reservedAnimateKey: "spring",
		},
	})
	if err := sess.Receive(dispatch); err != nil {
		t.Fatalf("Receive dispatch: %v", err)
	}

	select {
	case payload := <-seen:
		m, ok := payload.(map[string]any)
		if !ok {
			t.Fatalf("expected map payload, got %T", payload)
		}
		if _, present := m[reservedAnimateKey]; present {
			t.Fatal("handler observed the reserved __hypenAnimate key")
		}
		if m["postId"] != "p1" {
			t.Fatalf("user payload keys must survive, got %+v", m)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("handler never fired")
	}
}
