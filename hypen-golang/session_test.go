package core

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestSessionManager_CreateAndGetActiveSession(t *testing.T) {
	mgr := NewSessionManager(nil)

	session := mgr.CreateSession(map[string]any{"user": "alice"})
	if session.ID() == "" {
		t.Fatal("expected non-empty session ID")
	}

	got := mgr.GetActiveSession(session.ID())
	if got == nil || got.ID() != session.ID() {
		t.Fatalf("GetActiveSession returned %v, want session with ID %s", got, session.ID())
	}

	info := session.Info()
	if info.Props["user"] != "alice" {
		t.Errorf("expected props.user='alice', got %v", info.Props["user"])
	}
}

func TestSessionManager_DefaultTTL(t *testing.T) {
	mgr := NewSessionManager(nil)
	session := mgr.CreateSession(nil)
	if session.TTL() != time.Hour {
		t.Errorf("expected default TTL of 1h, got %v", session.TTL())
	}
}

func TestSessionManager_CustomTTL(t *testing.T) {
	mgr := NewSessionManager(&SessionConfig{TTL: 5 * time.Minute})
	session := mgr.CreateSession(nil)
	if session.TTL() != 5*time.Minute {
		t.Errorf("expected TTL of 5m, got %v", session.TTL())
	}
}

func TestSessionManager_SuspendAndResume(t *testing.T) {
	mgr := NewSessionManager(&SessionConfig{TTL: 5 * time.Second})
	session := mgr.CreateSession(nil)
	id := session.ID()

	// Suspend with saved state
	expireFired := atomic.Bool{}
	suspended := mgr.SuspendSession(id, map[string]any{"count": 42}, func() {
		expireFired.Store(true)
	})
	if !suspended {
		t.Fatal("expected suspension to succeed")
	}

	// Active lookup should now return nil
	if mgr.GetActiveSession(id) != nil {
		t.Error("expected GetActiveSession to return nil after suspend")
	}

	// Resume should succeed and return the saved state
	resumed, savedState := mgr.ResumeSession(id)
	if resumed == nil {
		t.Fatal("expected ResumeSession to return the session")
	}
	if savedState["count"] != 42 {
		t.Errorf("expected savedState.count=42, got %v", savedState["count"])
	}

	// After resume, the session is back to active
	if mgr.GetActiveSession(id) == nil {
		t.Error("expected session to be active after resume")
	}

	// Wait past the TTL window — onExpire should NOT fire because we resumed.
	time.Sleep(100 * time.Millisecond)
	if expireFired.Load() {
		t.Error("onExpire should NOT have fired after resume cancelled the timer")
	}
}

func TestSessionManager_ExpireAfterTTL(t *testing.T) {
	mgr := NewSessionManager(&SessionConfig{TTL: 50 * time.Millisecond})
	session := mgr.CreateSession(nil)
	id := session.ID()

	expireFired := make(chan struct{})
	mgr.SuspendSession(id, nil, func() {
		close(expireFired)
	})

	select {
	case <-expireFired:
		// Expected — fired within the TTL window
	case <-time.After(500 * time.Millisecond):
		t.Fatal("onExpire did not fire within 500ms (expected ~50ms)")
	}

	// After expiration, the session is gone.
	if mgr.GetActiveSession(id) != nil {
		t.Error("expected session to be gone after expiration")
	}
	resumed, _ := mgr.ResumeSession(id)
	if resumed != nil {
		t.Error("expected ResumeSession to return nil after expiration")
	}
}

func TestSessionManager_ResumeUnknownSession(t *testing.T) {
	mgr := NewSessionManager(nil)
	resumed, savedState := mgr.ResumeSession("nonexistent")
	if resumed != nil || savedState != nil {
		t.Errorf("expected nil/nil for unknown session, got %v / %v", resumed, savedState)
	}
}

func TestSessionManager_TrackAndUntrackConnection(t *testing.T) {
	mgr := NewSessionManager(&SessionConfig{Concurrent: ConcurrentAllowMultiple})
	session := mgr.CreateSession(nil)

	conn1 := struct{ id int }{1}
	conn2 := struct{ id int }{2}

	// Initially zero connections
	if got := mgr.GetConnectionCount(session.ID()); got != 0 {
		t.Errorf("expected 0 connections, got %d", got)
	}

	// Track first
	mgr.TrackConnection(session.ID(), conn1)
	if got := mgr.GetConnectionCount(session.ID()); got != 1 {
		t.Errorf("expected 1 connection, got %d", got)
	}

	// Track second (allowed under AllowMultiple)
	mgr.TrackConnection(session.ID(), conn2)
	if got := mgr.GetConnectionCount(session.ID()); got != 2 {
		t.Errorf("expected 2 connections, got %d", got)
	}

	// Untrack one
	mgr.UntrackConnection(session.ID(), conn1)
	if got := mgr.GetConnectionCount(session.ID()); got != 1 {
		t.Errorf("expected 1 connection after untrack, got %d", got)
	}

	// Untrack the other
	mgr.UntrackConnection(session.ID(), conn2)
	if got := mgr.GetConnectionCount(session.ID()); got != 0 {
		t.Errorf("expected 0 connections after untracking both, got %d", got)
	}
}

func TestSessionManager_KickOldPolicy(t *testing.T) {
	mgr := NewSessionManager(&SessionConfig{Concurrent: ConcurrentKickOld})
	session := mgr.CreateSession(nil)

	conn1 := &struct{}{}
	conn2 := &struct{}{}

	// First connection: nothing to kick
	kicked, ok := mgr.TrackConnection(session.ID(), conn1)
	if !ok || len(kicked) != 0 {
		t.Errorf("expected first connection to succeed with no kicks, got ok=%v kicked=%v", ok, kicked)
	}

	// Second connection: kicks the first
	kicked, ok = mgr.TrackConnection(session.ID(), conn2)
	if !ok {
		t.Error("expected second connection to succeed under KickOld")
	}
	if len(kicked) != 1 || kicked[0] != conn1 {
		t.Errorf("expected first connection to be kicked, got %v", kicked)
	}

	// Only one connection now
	if got := mgr.GetConnectionCount(session.ID()); got != 1 {
		t.Errorf("expected 1 connection after kick, got %d", got)
	}
}

func TestSessionManager_RejectNewPolicy(t *testing.T) {
	mgr := NewSessionManager(&SessionConfig{Concurrent: ConcurrentRejectNew})
	session := mgr.CreateSession(nil)

	conn1 := &struct{}{}
	conn2 := &struct{}{}

	// First connection: accepted
	_, ok := mgr.TrackConnection(session.ID(), conn1)
	if !ok {
		t.Error("expected first connection to be accepted")
	}

	// Second connection: rejected
	_, ok = mgr.TrackConnection(session.ID(), conn2)
	if ok {
		t.Error("expected second connection to be rejected under RejectNew")
	}
}

func TestSessionManager_DestroySession(t *testing.T) {
	mgr := NewSessionManager(nil)
	session := mgr.CreateSession(nil)
	id := session.ID()

	mgr.TrackConnection(id, "conn1")
	mgr.DestroySession(id)

	if mgr.GetActiveSession(id) != nil {
		t.Error("expected session to be gone after destroy")
	}
	if got := mgr.GetConnectionCount(id); got != 0 {
		t.Errorf("expected 0 connections after destroy, got %d", got)
	}
}

func TestSessionManager_SuspendDestroyDoesNotFireExpire(t *testing.T) {
	mgr := NewSessionManager(&SessionConfig{TTL: 50 * time.Millisecond})
	session := mgr.CreateSession(nil)
	id := session.ID()

	expireFired := atomic.Bool{}
	mgr.SuspendSession(id, nil, func() { expireFired.Store(true) })

	// Destroy before TTL elapses
	mgr.DestroySession(id)

	// Wait past the TTL — onExpire should NOT fire because the pending
	// entry was removed by Destroy.
	time.Sleep(150 * time.Millisecond)
	if expireFired.Load() {
		t.Error("onExpire should not fire after explicit DestroySession")
	}
}

func TestSessionManager_Stats(t *testing.T) {
	mgr := NewSessionManager(&SessionConfig{Concurrent: ConcurrentAllowMultiple})
	a := mgr.CreateSession(nil)
	b := mgr.CreateSession(nil)
	c := mgr.CreateSession(nil)

	mgr.TrackConnection(a.ID(), "x")
	mgr.TrackConnection(b.ID(), "x")
	mgr.TrackConnection(b.ID(), "y")
	mgr.SuspendSession(c.ID(), nil, func() {})

	stats := mgr.Stats()
	if stats.ActiveSessions != 2 {
		t.Errorf("expected 2 active sessions, got %d", stats.ActiveSessions)
	}
	if stats.PendingSessions != 1 {
		t.Errorf("expected 1 pending session, got %d", stats.PendingSessions)
	}
	if stats.TotalConnections != 3 {
		t.Errorf("expected 3 total connections, got %d", stats.TotalConnections)
	}
}

func TestSessionManager_ConcurrentSafety(t *testing.T) {
	mgr := NewSessionManager(&SessionConfig{Concurrent: ConcurrentAllowMultiple})
	session := mgr.CreateSession(nil)

	// Hammer the manager from multiple goroutines.
	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			conn := i
			mgr.TrackConnection(session.ID(), conn)
			_ = mgr.GetConnectionCount(session.ID())
			mgr.UntrackConnection(session.ID(), conn)
		}(i)
	}
	wg.Wait()

	// All connections untracked
	if got := mgr.GetConnectionCount(session.ID()); got != 0 {
		t.Errorf("expected 0 connections after concurrent track/untrack, got %d", got)
	}
}

func TestSessionManager_Shutdown(t *testing.T) {
	mgr := NewSessionManager(&SessionConfig{TTL: 50 * time.Millisecond})

	// Create a session and suspend it; the timer is now armed.
	session := mgr.CreateSession(nil)
	id := session.ID()
	expireFired := atomic.Bool{}
	mgr.SuspendSession(id, nil, func() { expireFired.Store(true) })

	// Shutdown should cancel the timer.
	mgr.Shutdown()

	// Wait past the TTL — expire must not fire.
	time.Sleep(150 * time.Millisecond)
	if expireFired.Load() {
		t.Error("onExpire should not fire after Shutdown")
	}

	// Manager should report empty stats.
	stats := mgr.Stats()
	if stats.ActiveSessions != 0 || stats.PendingSessions != 0 || stats.TotalConnections != 0 {
		t.Errorf("expected empty stats after shutdown, got %+v", stats)
	}
}
