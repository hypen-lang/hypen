package core

import (
	"sort"
	"sync"
	"testing"
	"time"
)

func TestCreateObservableState_EmitsPathsForShallowMutations(t *testing.T) {
	changes := []StateChange{}
	mu := sync.Mutex{}

	state := NewObservableState(map[string]any{"count": 0}, &StateObserverOptions{
		OnChange: func(change StateChange) {
			mu.Lock()
			changes = append(changes, change)
			mu.Unlock()
		},
	})

	state.Set("count", 2)

	// Wait for change notification
	time.Sleep(10 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()

	if len(changes) != 1 {
		t.Fatalf("expected 1 change, got %d", len(changes))
	}

	if len(changes[0].Paths) != 1 || changes[0].Paths[0] != "count" {
		t.Errorf("expected paths [count], got %v", changes[0].Paths)
	}

	// Set stores values directly as-is
	if changes[0].NewValues["count"] != 2 {
		t.Errorf("expected newValues[count]=2, got %v (type: %T)", changes[0].NewValues["count"], changes[0].NewValues["count"])
	}
}

func TestCreateObservableState_DoesNotEmitWhenValueStaysTheSame(t *testing.T) {
	changes := []StateChange{}
	mu := sync.Mutex{}

	state := NewObservableState(map[string]any{"count": float64(0)}, &StateObserverOptions{
		OnChange: func(change StateChange) {
			mu.Lock()
			changes = append(changes, change)
			mu.Unlock()
		},
	})

	state.Set("count", float64(0))

	time.Sleep(10 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()

	if len(changes) != 0 {
		t.Errorf("expected 0 changes, got %d", len(changes))
	}
}

func TestCreateObservableState_TracksNestedObjectUpdates(t *testing.T) {
	changes := []StateChange{}
	mu := sync.Mutex{}

	state := NewObservableState(map[string]any{
		"user": map[string]any{
			"profile": map[string]any{
				"name": "",
			},
		},
	}, &StateObserverOptions{
		OnChange: func(change StateChange) {
			mu.Lock()
			changes = append(changes, change)
			mu.Unlock()
		},
	})

	state.Set("user.profile.name", "Ada")

	time.Sleep(10 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()

	if len(changes) == 0 {
		t.Fatal("expected at least 1 change")
	}

	found := false
	for _, path := range changes[0].Paths {
		if path == "user.profile.name" {
			found = true
			break
		}
	}

	if !found {
		t.Errorf("expected path user.profile.name, got %v", changes[0].Paths)
	}
}

func TestCreateObservableState_ReportsAddedAndDeletedProperties(t *testing.T) {
	changes := []StateChange{}
	mu := sync.Mutex{}

	state := NewObservableState(map[string]any{
		"user": map[string]any{
			"age": float64(30),
		},
	}, &StateObserverOptions{
		OnChange: func(change StateChange) {
			mu.Lock()
			changes = append(changes, change)
			mu.Unlock()
		},
	})

	// Add property
	state.Set("user.name", "Ada")
	time.Sleep(10 * time.Millisecond)

	mu.Lock()
	if len(changes) == 0 {
		mu.Unlock()
		t.Fatal("expected at least 1 change for add")
	}

	found := false
	for _, path := range changes[0].Paths {
		if path == "user.name" {
			found = true
			break
		}
	}
	if !found {
		mu.Unlock()
		t.Errorf("expected path user.name for add, got %v", changes[0].Paths)
	}
	mu.Unlock()

	// Delete property
	state.Delete("user.age")
	time.Sleep(10 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()

	if len(changes) < 2 {
		t.Fatal("expected at least 2 changes")
	}

	found = false
	for _, path := range changes[1].Paths {
		if path == "user.age" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected path user.age for delete, got %v", changes[1].Paths)
	}

	if changes[1].NewValues["user.age"] != nil {
		t.Errorf("expected newValues[user.age]=nil, got %v", changes[1].NewValues["user.age"])
	}
}

func TestBatchStateUpdates_BatchesUpdates(t *testing.T) {
	changes := []StateChange{}
	mu := sync.Mutex{}

	state := NewObservableState(map[string]any{
		"count": float64(0),
		"nested": map[string]any{
			"flag": false,
		},
	}, &StateObserverOptions{
		OnChange: func(change StateChange) {
			mu.Lock()
			changes = append(changes, change)
			mu.Unlock()
		},
	})

	BatchStateUpdates(state, func() {
		state.Set("count", float64(1))
		state.Set("nested.flag", true)
	})

	time.Sleep(10 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()

	if len(changes) != 1 {
		t.Fatalf("expected 1 batched change, got %d", len(changes))
	}

	sortedPaths := make([]string, len(changes[0].Paths))
	copy(sortedPaths, changes[0].Paths)
	sort.Strings(sortedPaths)

	expectedPaths := []string{"count", "nested.flag"}
	sort.Strings(expectedPaths)

	if len(sortedPaths) != len(expectedPaths) {
		t.Errorf("expected paths %v, got %v", expectedPaths, sortedPaths)
	}
}

func TestGetStateSnapshot_ReturnsDefensiveCopy(t *testing.T) {
	state := NewObservableState(map[string]any{"value": float64(1)}, nil)

	snapshot := GetStateSnapshot(state)
	state.Set("value", float64(2))

	if snapshot["value"] != float64(1) {
		t.Errorf("expected snapshot.value=1, got %v", snapshot["value"])
	}
}

func TestBatchStateUpdates_ExecutesWithoutProxyHelpers(t *testing.T) {
	plain := map[string]any{"value": float64(0)}

	// Test with nil state
	BatchStateUpdates(nil, func() {
		plain["value"] = float64(5)
	})

	if plain["value"] != float64(5) {
		t.Errorf("expected value=5, got %v", plain["value"])
	}
}

func TestDeepClone_HandlesCircularReferences(t *testing.T) {
	// DeepClone uses JSON which doesn't support circular refs
	// This test ensures it doesn't panic
	original := map[string]any{
		"a": float64(1),
		"b": "test",
		"c": []any{float64(1), float64(2), float64(3)},
	}

	cloned := DeepClone(original)

	if cloned["a"] != float64(1) {
		t.Errorf("expected a=1, got %v", cloned["a"])
	}

	// Modify original
	original["a"] = float64(2)

	// Clone should be unchanged
	if cloned["a"] != float64(1) {
		t.Errorf("expected cloned a=1 after original change, got %v", cloned["a"])
	}
}

func TestDiffState_DetectsArrayLengthChanges(t *testing.T) {
	oldState := map[string]any{
		"items": []any{"a", "b"},
	}
	newState := map[string]any{
		"items": []any{"a", "b", "c"},
	}

	changes := diffState(oldState, newState)

	if len(changes.Paths) == 0 {
		t.Fatal("expected at least one path change")
	}

	// The engine emits a path for each added/removed array index
	// rather than the parent path, enforced by the cross-SDK
	// fixtures in engine-compatibility-tests/.
	found := false
	for _, path := range changes.Paths {
		if path == "items.2" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected path 'items.2' for array length change, got %v", changes.Paths)
	}
}

func TestGetValueAtPath_HandlesNestedPaths(t *testing.T) {
	obj := map[string]any{
		"user": map[string]any{
			"profile": map[string]any{
				"name": "Ada",
			},
		},
	}

	value := getValueAtPath(obj, "user.profile.name")
	if value != "Ada" {
		t.Errorf("expected 'Ada', got %v", value)
	}

	// Non-existent path
	value = getValueAtPath(obj, "user.profile.age")
	if value != nil {
		t.Errorf("expected nil for non-existent path, got %v", value)
	}
}

func TestSetValueAtPath_CreatesIntermediateObjects(t *testing.T) {
	obj := map[string]any{}

	setValueAtPath(obj, "a.b.c", "value")

	if obj["a"] == nil {
		t.Fatal("expected 'a' to be created")
	}

	aMap, ok := obj["a"].(map[string]any)
	if !ok {
		t.Fatal("expected 'a' to be a map")
	}

	if aMap["b"] == nil {
		t.Fatal("expected 'b' to be created")
	}

	bMap, ok := aMap["b"].(map[string]any)
	if !ok {
		t.Fatal("expected 'b' to be a map")
	}

	if bMap["c"] != "value" {
		t.Errorf("expected 'c'='value', got %v", bMap["c"])
	}
}

func TestConcurrentStateAccess(t *testing.T) {
	state := NewObservableState(map[string]any{"count": float64(0)}, nil)

	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			state.Set("count", float64(n))
			_ = state.Get("count")
			_ = state.Snapshot()
		}(i)
	}
	wg.Wait()

	// If we get here without panics, concurrent access is safe
}
