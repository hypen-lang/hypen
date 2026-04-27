package core

import (
	"fmt"
	"sync"
)

// RouteMatch represents a matched route with extracted params
type RouteMatch struct {
	Params map[string]string
	Query  map[string]string
	Path   string
}

// RouteState represents the current route state
type RouteState struct {
	CurrentPath  string
	Params       map[string]string
	Query        map[string]string
	PreviousPath string
}

// RouteChangeCallback is called when the route changes
type RouteChangeCallback func(route RouteState)

// HypenRouter manages application routing
type HypenRouter struct {
	mu            sync.RWMutex
	currentPath   string
	previousPath  string
	params        map[string]string
	query         map[string]string
	subscribers   map[*RouteChangeCallback]struct{}
	isInitialized bool
	isUpdating    bool
}

// NewHypenRouter creates a new router
func NewHypenRouter() *HypenRouter {
	r := &HypenRouter{
		currentPath:   "/",
		previousPath:  "",
		params:        make(map[string]string),
		query:         make(map[string]string),
		subscribers:   make(map[*RouteChangeCallback]struct{}),
		isInitialized: true,
	}

	return r
}

// Push navigates to a new path
func (r *HypenRouter) Push(path string) {
	r.updatePath(path, true, false)
}

// Replace replaces current path without adding to history
func (r *HypenRouter) Replace(path string) {
	r.updatePath(path, true, true)
}

// Back goes back in history (no-op in server context)
func (r *HypenRouter) Back() {
	// No-op in server context
}

// Forward goes forward in history (no-op in server context)
func (r *HypenRouter) Forward() {
	// No-op in server context
}

// updatePath updates the current path
func (r *HypenRouter) updatePath(path string, updateHistory bool, replace bool) {
	r.mu.Lock()
	if r.isUpdating {
		r.mu.Unlock()
		return
	}
	r.isUpdating = true

	oldPath := r.currentPath
	r.previousPath = oldPath
	r.currentPath = path
	r.query = r.parseQueryFromPath(path)

	r.isUpdating = false
	r.mu.Unlock()

	// Notify happens outside the lock
	r.notifySubscribers()
}

// parseQueryFromPath delegates to the engine's canonical
// `hypen_portable_parse_query`. The engine returns both the clean
// path and the query map; we only keep the query portion because
// the router already tracks `currentPath` separately.
func (r *HypenRouter) parseQueryFromPath(path string) map[string]string {
	_, q, err := parseQueryViaEngine(path)
	if err != nil {
		panic(fmt.Sprintf("parseQueryFromPath: engine portable runtime unavailable: %v", err))
	}
	return q
}

// GetCurrentPath returns the current path
func (r *HypenRouter) GetCurrentPath() string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.currentPath
}

// GetParams returns current route params
func (r *HypenRouter) GetParams() map[string]string {
	r.mu.RLock()
	defer r.mu.RUnlock()

	result := make(map[string]string)
	for k, v := range r.params {
		result[k] = v
	}
	return result
}

// GetQuery returns current query params
func (r *HypenRouter) GetQuery() map[string]string {
	r.mu.RLock()
	defer r.mu.RUnlock()

	result := make(map[string]string)
	for k, v := range r.query {
		result[k] = v
	}
	return result
}

// GetState returns the full route state snapshot
func (r *HypenRouter) GetState() RouteState {
	r.mu.RLock()
	defer r.mu.RUnlock()

	state := RouteState{
		CurrentPath:  r.currentPath,
		Params:       make(map[string]string),
		Query:        make(map[string]string),
		PreviousPath: r.previousPath,
	}

	for k, v := range r.params {
		state.Params[k] = v
	}

	for k, v := range r.query {
		state.Query[k] = v
	}

	return state
}

// MatchPath matches a pattern against a path.
//
// Delegates to the engine's canonical `hypen_portable_match_path` at
// `hypen-engine-rs/src/portable/route.rs`. URL-decoding of captured
// params is performed here because the engine returns raw substring
// captures.
func (r *HypenRouter) MatchPath(pattern, path string) *RouteMatch {
	if pattern == "" || path == "" {
		return nil
	}

	result, err := matchPathViaEngine(pattern, path)
	if err != nil {
		panic(fmt.Sprintf("MatchPath: engine portable runtime unavailable: %v", err))
	}
	if !result.Matched {
		return nil
	}

	params := make(map[string]string, len(result.Params))
	for name, raw := range result.Params {
		if decoded, derr := decodeURIComponentViaEngine(raw); derr == nil {
			params[name] = decoded
		} else {
			params[name] = raw
		}
	}

	return &RouteMatch{
		Params: params,
		Query:  r.GetQuery(),
		Path:   path,
	}
}

// OnNavigate subscribes to route changes
func (r *HypenRouter) OnNavigate(callback RouteChangeCallback) func() {
	r.mu.Lock()
	callbackPtr := &callback
	r.subscribers[callbackPtr] = struct{}{}
	r.mu.Unlock()

	// Call immediately with current state
	func() {
		defer func() {
			if rec := recover(); rec != nil {
				// Log error but don't crash
			}
		}()
		callback(r.GetState())
	}()

	// Return unsubscribe function
	return func() {
		r.mu.Lock()
		defer r.mu.Unlock()
		delete(r.subscribers, callbackPtr)
	}
}

// notifySubscribers notifies all subscribers of route change
func (r *HypenRouter) notifySubscribers() {
	r.mu.RLock()
	// Copy subscribers to avoid holding lock during callbacks
	subscribers := make([]*RouteChangeCallback, 0, len(r.subscribers))
	for cb := range r.subscribers {
		subscribers = append(subscribers, cb)
	}
	r.mu.RUnlock()

	routeState := r.GetState()
	for _, callback := range subscribers {
		func() {
			defer func() {
				if rec := recover(); rec != nil {
					// Log error but don't crash
				}
			}()
			(*callback)(routeState)
		}()
	}
}

// IsActive checks if a path matches the current route
func (r *HypenRouter) IsActive(pattern string) bool {
	return r.MatchPath(pattern, r.GetCurrentPath()) != nil
}

// BuildURL composes a path + query map into a URL via the engine's
// canonical `hypen_portable_build_url`.
func (r *HypenRouter) BuildURL(path string, query map[string]string) string {
	out, err := buildURLViaEngine(path, query)
	if err != nil {
		panic(fmt.Sprintf("BuildURL: engine portable runtime unavailable: %v", err))
	}
	return out
}

// SetPath directly sets the current path (useful for testing)
func (r *HypenRouter) SetPath(path string) {
	r.updatePath(path, false, false)
}
