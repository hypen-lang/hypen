package remote

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"

	core "github.com/hypen-space/core"
)

func TestDispatchQueueRunsInOrderOneAtATime(t *testing.T) {
	var current atomic.Pointer[dispatchLease]
	q := newDispatchQueue(func(l *dispatchLease) { current.Store(l) })
	var mu sync.Mutex
	var order []int
	var running atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		i := i
		wg.Add(1)
		q.enqueue(false, func() {
			defer wg.Done()
			if running.Add(1) != 1 {
				t.Error("two dispatches held the slot at once")
			}
			if current.Load() == nil {
				t.Error("no current dispatch while running")
			}
			mu.Lock()
			order = append(order, i)
			mu.Unlock()
			running.Add(-1)
		})
	}
	wg.Wait()
	for i, v := range order {
		if v != i {
			t.Fatalf("dispatch order = %v", order)
		}
	}
	// Give the last lease's finish a moment, then the slot is free.
	deadline := time.Now().Add(time.Second)
	for current.Load() != nil && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if current.Load() != nil {
		t.Fatal("current dispatch not cleared after the queue drained")
	}
}

func TestDispatchLeaseYieldsAndResumes(t *testing.T) {
	var cur atomic.Pointer[dispatchLease]
	q := newDispatchQueue(func(l *dispatchLease) { cur.Store(l) })
	release := make(chan struct{})
	var events []string
	var mu sync.Mutex
	log := func(s string) {
		mu.Lock()
		events = append(events, s)
		mu.Unlock()
	}
	done := make(chan struct{}, 2)
	q.enqueue(false, func() {
		l := cur.Load()
		log("A start")
		l.BeginWait()
		<-release // the device answer
		l.EndWait()
		if cur.Load() != l {
			t.Error("resumed dispatch is not current")
		}
		log("A end")
		done <- struct{}{}
	})
	q.enqueue(false, func() {
		log("B ran")
		done <- struct{}{}
	})
	<-done // B runs while A waits
	close(release)
	<-done
	mu.Lock()
	defer mu.Unlock()
	want := []string{"A start", "B ran", "A end"}
	for i := range want {
		if i >= len(events) || events[i] != want[i] {
			t.Fatalf("events = %v", events)
		}
	}
}

func TestDispatchLeaseSeveralWaitersAndLateGoroutines(t *testing.T) {
	var cur atomic.Pointer[dispatchLease]
	q := newDispatchQueue(func(l *dispatchLease) { cur.Store(l) })
	var leased *dispatchLease
	finished := make(chan struct{})
	q.enqueue(true, func() {
		leased = cur.Load()
		if !leased.replayed {
			t.Error("provenance lost")
		}
		var wg sync.WaitGroup
		for i := 0; i < 8; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				leased.BeginWait()
				time.Sleep(time.Millisecond)
				leased.EndWait()
			}()
		}
		wg.Wait()
		close(finished)
	})
	<-finished
	// After the dispatch finished, a goroutine it spawned may still wait:
	// it must not touch the slot.
	time.Sleep(5 * time.Millisecond)
	leased.BeginWait()
	leased.EndWait()
	ran := make(chan struct{})
	q.enqueue(false, func() { close(ran) })
	select {
	case <-ran:
	case <-time.After(2 * time.Second):
		t.Fatal("slot leaked: the next dispatch never ran")
	}
	// runInline takes the slot on the caller's goroutine.
	inline := false
	q.runInline(false, func() { inline = true })
	if !inline {
		t.Fatal("runInline did not run")
	}
}

func TestTopLevelMemberCount(t *testing.T) {
	for _, tc := range []struct {
		in   string
		want int
	}{
		{`{"type":"hello","device":{}}`, 1},
		{`{"type":"hello","device":{},"device":{}}`, 2},
		{`{"type":"hello","x":{"device":1}}`, 0},
		{`[1,2]`, 0},
		{`not json`, 0},
	} {
		if got := topLevelMemberCount([]byte(tc.in), "device"); got != tc.want {
			t.Errorf("%s: %d, want %d", tc.in, got, tc.want)
		}
	}
}

func TestCommitStateMergesChangedRootsOnDeviceSessions(t *testing.T) {
	roots := newChangedRoots()
	var notified int
	obs := core.NewObservableState(map[string]any{"a": 1.0, "b": map[string]any{"c": 1.0}, "gone": true},
		&core.StateObserverOptions{OnChange: roots.track(func(core.StateChange) { notified++ })})
	obs.Set("b.c", 2.0)
	obs.Delete("gone")
	base := map[string]any{"a": 5.0, "b": map[string]any{"c": 1.0}, "gone": true, "other": "kept"}

	deviceSess := &RemoteSession{}
	deviceSess.dispatchQ.Store(newDispatchQueue(func(*dispatchLease) {}))
	merged := deviceSess.commitState(base, obs, roots)
	if merged["a"] != 5.0 || merged["other"] != "kept" {
		t.Fatalf("unchanged roots were overwritten: %v", merged)
	}
	if merged["b"].(map[string]any)["c"] != 2.0 {
		t.Fatalf("changed root not merged: %v", merged)
	}
	if _, ok := merged["gone"]; ok {
		t.Fatal("deleted root survived")
	}
	if notified == 0 {
		t.Fatal("inner observer not called")
	}
	// UI-only sessions keep the historical full replacement.
	plain := &RemoteSession{}
	if got := plain.commitState(base, obs, roots); got["a"] != 1.0 || got["other"] != nil {
		t.Fatalf("UI-only commit = %v", got)
	}
}
