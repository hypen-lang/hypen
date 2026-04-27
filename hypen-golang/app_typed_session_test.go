package core

import (
	"testing"
	"time"
)

type sessionCounter struct {
	Count int `json:"count"`
}

func newTestSession(id string) SessionInfo {
	return SessionInfo{ID: id, CreatedAt: time.Now(), LastConnectedAt: time.Now()}
}

func TestTypedApp_TypedDisconnectReceivesTypedState(t *testing.T) {
	engine := NewFakeEngine()

	var seen int
	var seenSession string

	def := NewApp(sessionCounter{Count: 7}).
		OnDisconnect(func(ctx TypedDisconnectContext[sessionCounter]) {
			seen = ctx.State.Count
			seenSession = ctx.Session.ID
		}).
		Build()

	instance := NewModuleInstance(engine, def)
	defer instance.Destroy()

	instance.HandleDisconnect(newTestSession("sess-1"))

	if seen != 7 {
		t.Errorf("expected typed state Count=7, got %d", seen)
	}
	if seenSession != "sess-1" {
		t.Errorf("expected session id sess-1, got %q", seenSession)
	}
}

func TestTypedApp_TypedReconnectRestorePushesTypedValue(t *testing.T) {
	engine := NewFakeEngine()

	def := NewApp(sessionCounter{Count: 0}).
		OnReconnect(func(ctx TypedReconnectContext[sessionCounter]) {
			ctx.Restore(sessionCounter{Count: 42})
		}).
		Build()

	instance := NewModuleInstance(engine, def)
	defer instance.Destroy()

	instance.HandleReconnect(newTestSession("sess-1"), map[string]any{"count": 0})

	state := instance.GetState()
	got, ok := state["count"].(float64)
	if !ok {
		t.Fatalf("expected count to be float64, got %T (%v)", state["count"], state["count"])
	}
	if int(got) != 42 {
		t.Errorf("expected count == 42 after typed Restore, got %v", got)
	}
}
