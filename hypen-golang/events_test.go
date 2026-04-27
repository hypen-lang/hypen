package core

import (
	"sync"
	"testing"
)

func TestTypedEventEmitter_EmitsAndReceivesEvents(t *testing.T) {
	emitter := NewTypedEventEmitter()
	var received any

	emitter.On("userLogin", func(payload any) {
		received = payload
	})

	expected := map[string]any{"userId": "123", "username": "alice"}
	emitter.Emit("userLogin", expected)

	if received == nil {
		t.Fatal("expected to receive event")
	}

	receivedMap, ok := received.(map[string]any)
	if !ok {
		t.Fatalf("expected map, got %T", received)
	}

	if receivedMap["userId"] != "123" {
		t.Errorf("expected userId=123, got %v", receivedMap["userId"])
	}
	if receivedMap["username"] != "alice" {
		t.Errorf("expected username=alice, got %v", receivedMap["username"])
	}
}

func TestTypedEventEmitter_SupportsMultipleListeners(t *testing.T) {
	emitter := NewTypedEventEmitter()
	calls := []int{}
	mu := sync.Mutex{}

	emitter.On("testEvent", func(payload any) {
		mu.Lock()
		calls = append(calls, payload.(int))
		mu.Unlock()
	})

	emitter.On("testEvent", func(payload any) {
		mu.Lock()
		calls = append(calls, payload.(int)*2)
		mu.Unlock()
	})

	emitter.Emit("testEvent", 5)

	mu.Lock()
	defer mu.Unlock()

	if len(calls) != 2 {
		t.Fatalf("expected 2 calls, got %d", len(calls))
	}

	// Order may vary, but both values should be present
	hasOriginal := false
	hasDoubled := false
	for _, v := range calls {
		if v == 5 {
			hasOriginal = true
		}
		if v == 10 {
			hasDoubled = true
		}
	}

	if !hasOriginal || !hasDoubled {
		t.Errorf("expected [5, 10] in calls, got %v", calls)
	}
}

func TestTypedEventEmitter_UnsubscribeWorks(t *testing.T) {
	emitter := NewTypedEventEmitter()
	callCount := 0
	mu := sync.Mutex{}

	unsubscribe := emitter.On("testEvent", func(payload any) {
		mu.Lock()
		callCount++
		mu.Unlock()
	})

	emitter.Emit("testEvent", nil)

	mu.Lock()
	if callCount != 1 {
		mu.Unlock()
		t.Fatalf("expected 1 call, got %d", callCount)
	}
	mu.Unlock()

	unsubscribe()
	emitter.Emit("testEvent", nil)

	mu.Lock()
	defer mu.Unlock()
	if callCount != 1 {
		t.Errorf("expected 1 call after unsubscribe, got %d", callCount)
	}
}

func TestTypedEventEmitter_OnceAutoUnsubscribes(t *testing.T) {
	emitter := NewTypedEventEmitter()
	callCount := 0
	mu := sync.Mutex{}

	emitter.Once("testEvent", func(payload any) {
		mu.Lock()
		callCount++
		mu.Unlock()
	})

	emitter.Emit("testEvent", nil)
	emitter.Emit("testEvent", nil)
	emitter.Emit("testEvent", nil)

	mu.Lock()
	defer mu.Unlock()

	if callCount != 1 {
		t.Errorf("expected 1 call with Once, got %d", callCount)
	}
}

func TestTypedEventEmitter_ListenerCountReturnsCorrectCount(t *testing.T) {
	emitter := NewTypedEventEmitter()

	if emitter.ListenerCount("testEvent") != 0 {
		t.Errorf("expected 0 listeners initially")
	}

	emitter.On("testEvent", func(payload any) {})
	if emitter.ListenerCount("testEvent") != 1 {
		t.Errorf("expected 1 listener after first subscription")
	}

	emitter.On("testEvent", func(payload any) {})
	if emitter.ListenerCount("testEvent") != 2 {
		t.Errorf("expected 2 listeners after second subscription")
	}
}

func TestTypedEventEmitter_RemoveAllListeners(t *testing.T) {
	emitter := NewTypedEventEmitter()
	callCount := 0
	mu := sync.Mutex{}

	emitter.On("testEvent", func(payload any) {
		mu.Lock()
		callCount++
		mu.Unlock()
	})
	emitter.On("testEvent", func(payload any) {
		mu.Lock()
		callCount++
		mu.Unlock()
	})

	emitter.RemoveAllListeners("testEvent")
	emitter.Emit("testEvent", nil)

	mu.Lock()
	defer mu.Unlock()

	if callCount != 0 {
		t.Errorf("expected 0 calls after RemoveAllListeners, got %d", callCount)
	}
}

func TestTypedEventEmitter_ClearAll(t *testing.T) {
	emitter := NewTypedEventEmitter()
	callCount := 0
	mu := sync.Mutex{}

	emitter.On("event1", func(payload any) {
		mu.Lock()
		callCount++
		mu.Unlock()
	})
	emitter.On("event2", func(payload any) {
		mu.Lock()
		callCount++
		mu.Unlock()
	})

	emitter.ClearAll()
	emitter.Emit("event1", nil)
	emitter.Emit("event2", nil)

	mu.Lock()
	defer mu.Unlock()

	if callCount != 0 {
		t.Errorf("expected 0 calls after ClearAll, got %d", callCount)
	}
}

func TestTypedEventEmitter_EventNamesReturnsRegisteredEvents(t *testing.T) {
	emitter := NewTypedEventEmitter()

	if len(emitter.EventNames()) != 0 {
		t.Errorf("expected empty event names initially")
	}

	emitter.On("event1", func(payload any) {})
	emitter.On("event2", func(payload any) {})

	names := emitter.EventNames()
	if len(names) != 2 {
		t.Fatalf("expected 2 event names, got %d", len(names))
	}

	hasEvent1 := false
	hasEvent2 := false
	for _, n := range names {
		if n == "event1" {
			hasEvent1 = true
		}
		if n == "event2" {
			hasEvent2 = true
		}
	}

	if !hasEvent1 || !hasEvent2 {
		t.Errorf("expected event1 and event2 in names, got %v", names)
	}
}

func TestTypedEventEmitter_HandlerErrorDoesNotCrash(t *testing.T) {
	emitter := NewTypedEventEmitter()
	called := false

	emitter.On("testEvent", func(payload any) {
		panic("intentional panic")
	})

	emitter.On("testEvent", func(payload any) {
		called = true
	})

	// This should not panic
	emitter.Emit("testEvent", nil)

	if !called {
		t.Error("second handler should still be called after first panics")
	}
}

func TestTypedEventEmitter_ConcurrentAccess(t *testing.T) {
	emitter := NewTypedEventEmitter()
	var wg sync.WaitGroup

	// Concurrent subscriptions and emissions
	for i := 0; i < 100; i++ {
		wg.Add(2)
		go func() {
			defer wg.Done()
			unsub := emitter.On("testEvent", func(payload any) {})
			unsub()
		}()
		go func() {
			defer wg.Done()
			emitter.Emit("testEvent", nil)
		}()
	}

	wg.Wait()
	// If we get here without panics, concurrent access is safe
}

func TestCreateEventEmitter_CreatesNewEmitter(t *testing.T) {
	emitter := CreateEventEmitter()
	if emitter == nil {
		t.Error("expected non-nil emitter")
	}
}
