package core

import (
	"sync"
	"testing"
)

func TestHypenRouter_InitialPath(t *testing.T) {
	router := NewHypenRouter()

	path := router.GetCurrentPath()
	if path != "/" {
		t.Errorf("expected initial path '/', got %s", path)
	}
}

func TestHypenRouter_PushUpdatesPath(t *testing.T) {
	router := NewHypenRouter()

	router.Push("/dashboard")

	path := router.GetCurrentPath()
	if path != "/dashboard" {
		t.Errorf("expected path '/dashboard', got %s", path)
	}
}

func TestHypenRouter_ReplaceUpdatesPath(t *testing.T) {
	router := NewHypenRouter()

	router.Replace("/settings")

	path := router.GetCurrentPath()
	if path != "/settings" {
		t.Errorf("expected path '/settings', got %s", path)
	}
}

func TestHypenRouter_GetStateReturnsPreviousPath(t *testing.T) {
	router := NewHypenRouter()

	router.Push("/first")
	router.Push("/second")

	state := router.GetState()
	if state.PreviousPath != "/first" {
		t.Errorf("expected previousPath '/first', got %s", state.PreviousPath)
	}
	if state.CurrentPath != "/second" {
		t.Errorf("expected currentPath '/second', got %s", state.CurrentPath)
	}
}

func TestHypenRouter_MatchPath_ExactMatch(t *testing.T) {
	router := NewHypenRouter()

	router.Push("/users")
	match := router.MatchPath("/users", "/users")

	if match == nil {
		t.Fatal("expected match for exact path")
	}

	if len(match.Params) != 0 {
		t.Errorf("expected no params, got %v", match.Params)
	}
}

func TestHypenRouter_MatchPath_NoMatch(t *testing.T) {
	router := NewHypenRouter()

	match := router.MatchPath("/users", "/settings")

	if match != nil {
		t.Error("expected no match for different paths")
	}
}

func TestHypenRouter_MatchPath_WildcardMatch(t *testing.T) {
	router := NewHypenRouter()

	// Pattern /dashboard/* should match /dashboard/anything
	match := router.MatchPath("/dashboard/*", "/dashboard/users")
	if match == nil {
		t.Fatal("expected match for wildcard pattern")
	}

	// Should also match exact prefix
	match = router.MatchPath("/dashboard/*", "/dashboard")
	if match == nil {
		t.Fatal("expected match for exact prefix")
	}

	// Should not match unrelated paths
	match = router.MatchPath("/dashboard/*", "/settings")
	if match != nil {
		t.Error("expected no match for unrelated path")
	}
}

func TestHypenRouter_MatchPath_ParameterMatch(t *testing.T) {
	router := NewHypenRouter()

	match := router.MatchPath("/users/:id", "/users/123")

	if match == nil {
		t.Fatal("expected match for parameter pattern")
	}

	if match.Params["id"] != "123" {
		t.Errorf("expected id='123', got %v", match.Params["id"])
	}
}

func TestHypenRouter_MatchPath_MultipleParameters(t *testing.T) {
	router := NewHypenRouter()

	match := router.MatchPath("/users/:userId/posts/:postId", "/users/42/posts/99")

	if match == nil {
		t.Fatal("expected match")
	}

	if match.Params["userId"] != "42" {
		t.Errorf("expected userId='42', got %v", match.Params["userId"])
	}
	if match.Params["postId"] != "99" {
		t.Errorf("expected postId='99', got %v", match.Params["postId"])
	}
}

func TestHypenRouter_MatchPath_InvalidInputs(t *testing.T) {
	router := NewHypenRouter()

	if router.MatchPath("", "/users") != nil {
		t.Error("expected nil for empty pattern")
	}

	if router.MatchPath("/users", "") != nil {
		t.Error("expected nil for empty path")
	}
}

func TestHypenRouter_OnNavigate_CallsImmediately(t *testing.T) {
	router := NewHypenRouter()
	called := false

	router.OnNavigate(func(route RouteState) {
		called = true
	})

	if !called {
		t.Error("expected callback to be called immediately")
	}
}

func TestHypenRouter_OnNavigate_NotifiesOnChange(t *testing.T) {
	router := NewHypenRouter()
	callCount := 0
	mu := sync.Mutex{}

	router.OnNavigate(func(route RouteState) {
		mu.Lock()
		callCount++
		mu.Unlock()
	})

	router.Push("/new-path")

	mu.Lock()
	defer mu.Unlock()

	// Called once immediately, and once for the push
	if callCount < 2 {
		t.Errorf("expected at least 2 calls, got %d", callCount)
	}
}

func TestHypenRouter_OnNavigate_ReturnsUnsubscribe(t *testing.T) {
	router := NewHypenRouter()
	callCount := 0
	mu := sync.Mutex{}

	unsubscribe := router.OnNavigate(func(route RouteState) {
		mu.Lock()
		callCount++
		mu.Unlock()
	})

	mu.Lock()
	initialCount := callCount
	mu.Unlock()

	unsubscribe()
	router.Push("/test")

	mu.Lock()
	finalCount := callCount
	mu.Unlock()

	if finalCount != initialCount {
		t.Error("expected no more calls after unsubscribe")
	}
}

func TestHypenRouter_IsActive(t *testing.T) {
	router := NewHypenRouter()

	router.Push("/users")

	if !router.IsActive("/users") {
		t.Error("expected /users to be active")
	}

	if router.IsActive("/settings") {
		t.Error("expected /settings to not be active")
	}
}

func TestHypenRouter_BuildURL_WithoutQuery(t *testing.T) {
	router := NewHypenRouter()

	url := router.BuildURL("/users", nil)
	if url != "/users" {
		t.Errorf("expected '/users', got %s", url)
	}

	url = router.BuildURL("/users", map[string]string{})
	if url != "/users" {
		t.Errorf("expected '/users', got %s", url)
	}
}

func TestHypenRouter_BuildURL_WithQuery(t *testing.T) {
	router := NewHypenRouter()

	url := router.BuildURL("/users", map[string]string{
		"page": "1",
		"sort": "name",
	})

	// URL should contain path and query params
	if url != "/users?page=1&sort=name" && url != "/users?sort=name&page=1" {
		t.Errorf("expected URL with query params, got %s", url)
	}
}

func TestHypenRouter_SetPath(t *testing.T) {
	router := NewHypenRouter()

	router.SetPath("/test")

	if router.GetCurrentPath() != "/test" {
		t.Errorf("expected path '/test', got %s", router.GetCurrentPath())
	}
}

func TestHypenRouter_GetParams(t *testing.T) {
	router := NewHypenRouter()

	// Initially empty
	params := router.GetParams()
	if len(params) != 0 {
		t.Errorf("expected empty params, got %v", params)
	}
}

func TestHypenRouter_GetQuery(t *testing.T) {
	router := NewHypenRouter()

	// Initially empty
	query := router.GetQuery()
	if len(query) != 0 {
		t.Errorf("expected empty query, got %v", query)
	}
}

func TestHypenRouter_BackAndForward_NoOp(t *testing.T) {
	router := NewHypenRouter()

	// Should not panic
	router.Back()
	router.Forward()
}

func TestHypenRouter_ConcurrentAccess(t *testing.T) {
	router := NewHypenRouter()
	var wg sync.WaitGroup

	for i := 0; i < 100; i++ {
		wg.Add(3)
		go func() {
			defer wg.Done()
			router.Push("/test")
		}()
		go func() {
			defer wg.Done()
			_ = router.GetCurrentPath()
		}()
		go func() {
			defer wg.Done()
			_ = router.GetState()
		}()
	}

	wg.Wait()
	// If we get here without panics, concurrent access is safe
}

func TestHypenRouter_MatchPath_URLDecodesParams(t *testing.T) {
	router := NewHypenRouter()

	match := router.MatchPath("/users/:name", "/users/John%20Doe")

	if match == nil {
		t.Fatal("expected match")
	}

	if match.Params["name"] != "John Doe" {
		t.Errorf("expected decoded name 'John Doe', got %v", match.Params["name"])
	}
}
