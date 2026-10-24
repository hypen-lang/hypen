package remote

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	core "github.com/hypen-lang/hypen/hypen-golang"
)

const browserAccept = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"

func doHTTP(t *testing.T, h http.HandlerFunc, method, path, accept string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, nil)
	if accept != "" {
		req.Header.Set("Accept", accept)
	}
	rec := httptest.NewRecorder()
	h(rec, req)
	return rec
}

func isShell(rec *httptest.ResponseRecorder) bool {
	return rec.Code == http.StatusOK &&
		strings.Contains(rec.Header().Get("Content-Type"), "text/html") &&
		strings.Contains(rec.Body.String(), webClientPath)
}

// A browser navigating straight to an app route (deep link or reload on
// `/about`) gets the same shell as `/`; the client then starts the session
// at that path.
func TestWebClient_SPAFallbackServesShellForPageNavigations(t *testing.T) {
	s := NewRemoteServer()
	for _, path := range []string{"/", "/index.html", "/about", "/users/42", "/a/b/c/", "/v1.2/"} {
		if rec := doHTTP(t, s.handleHTTP, http.MethodGet, path, browserAccept); !isShell(rec) {
			t.Errorf("GET %s: want the app shell, got %d %q", path, rec.Code, rec.Body.String())
		}
	}
	// HEAD answers like GET, without a body.
	rec := doHTTP(t, s.handleHTTP, http.MethodHead, "/about", browserAccept)
	if rec.Code != http.StatusOK || rec.Body.Len() != 0 ||
		!strings.Contains(rec.Header().Get("Content-Type"), "text/html") {
		t.Errorf("HEAD /about: got %d %q %q", rec.Code, rec.Header().Get("Content-Type"), rec.Body.String())
	}
}

func TestWebClient_NonPageRequestsAreNotAnsweredWithHTML(t *testing.T) {
	s := NewRemoteServer()
	cases := []struct{ method, path, accept string }{
		{http.MethodGet, "/about", "application/json"}, // fetch/XHR
		{http.MethodGet, "/about", ""},                 // curl
		{http.MethodGet, "/logo.png", browserAccept},   // file-like
		{http.MethodGet, "/app/bundle.js", browserAccept},
		{http.MethodGet, "/__hypen__/nope", browserAccept}, // reserved prefix
		{http.MethodPost, "/about", browserAccept},
	}
	for _, c := range cases {
		rec := doHTTP(t, s.handleHTTP, c.method, c.path, c.accept)
		if rec.Code != http.StatusNotFound || strings.Contains(rec.Body.String(), "<html") {
			t.Errorf("%s %s (Accept %q): want 404 without HTML, got %d %q",
				c.method, c.path, c.accept, rec.Code, rec.Body.String())
		}
	}
	// The bundle itself is still served.
	if rec := doHTTP(t, s.handleHTTP, http.MethodGet, webClientPath, "*/*"); rec.Code != http.StatusOK ||
		!strings.Contains(rec.Header().Get("Content-Type"), "javascript") {
		t.Errorf("GET %s: got %d %q", webClientPath, rec.Code, rec.Header().Get("Content-Type"))
	}
}

// `/health` stays a probe for probes, and an app route for browsers.
func TestWebClient_HealthIsAProbeUnlessABrowserNavigates(t *testing.T) {
	s := NewRemoteServer()
	if rec := doHTTP(t, s.handleHealth, http.MethodGet, "/health", ""); rec.Body.String() != "OK" {
		t.Errorf("probe GET /health: got %q", rec.Body.String())
	}
	if rec := doHTTP(t, s.handleHealth, http.MethodGet, "/health", browserAccept); !isShell(rec) {
		t.Errorf("browser GET /health: want the app shell, got %q", rec.Body.String())
	}
	s.DisableWebClient()
	if rec := doHTTP(t, s.handleHealth, http.MethodGet, "/health", browserAccept); rec.Body.String() != "OK" {
		t.Errorf("browser GET /health without web client: got %q", rec.Body.String())
	}
}

func TestWebClient_DisabledKeepsHistoricalResponse(t *testing.T) {
	s := NewRemoteServer().DisableWebClient()
	rec := doHTTP(t, s.handleHTTP, http.MethodGet, "/about", browserAccept)
	if rec.Code != http.StatusOK || rec.Body.String() != "Hypen Remote Server" {
		t.Errorf("GET /about with web client disabled: got %d %q", rec.Code, rec.Body.String())
	}
}

// The embedded bundle is the TS web client with URL sync (history entries
// carry the route's path; deep links and back/forward move the server's
// router with router.replace). Guards against a stale `go generate`.
func TestWebClient_BundleSyncsTheURL(t *testing.T) {
	js := string(webClientBundle)
	for _, want := range []string{"router.replace", "pushState", "popstate"} {
		if !strings.Contains(js, want) {
			t.Errorf("embedded client.js lacks %q — rerun `go generate ./remote`", want)
		}
	}
}

func TestAcceptsHTML(t *testing.T) {
	for accept, want := range map[string]bool{
		browserAccept:                       true,
		"TEXT/HTML":                         true,
		"text/html;q=0.9":                   true,
		"application/json":                  false,
		"text/htmlx":                        false,
		"*/*":                               false,
		"application/xhtml+xml, text/plain": false,
	} {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.Header.Set("Accept", accept)
		if got := acceptsHTML(req); got != want {
			t.Errorf("acceptsHTML(%q) = %v, want %v", accept, got, want)
		}
	}
}

// The web client keeps the address bar in step with `state.location`
// (pushState on navigation, router.replace for deep links and
// back/forward), so every navigation must END with a stateUpdate carrying
// the new location — the router mirrors the path into state off the
// dispatch path, after the dispatch's own stateUpdate was sent.
func TestNavigation_LastStateUpdateCarriesNewLocation(t *testing.T) {
	core.App.Clear()
	t.Cleanup(func() { core.App.Clear() })

	appUI := `module App {
	  Router {
	    Route(path: "/") { Home() }
	    Route(path: "/settings") { Settings() }
	  }
	}`
	dir := writeComponents(t, map[string]string{
		"App":      appUI,
		"Home":     `module Home { Text("home") }`,
		"Settings": `module Settings { Text("settings") }`,
	})
	core.App.Module("Home").DefineState(map[string]any{}, nil).Build()
	core.App.Module("Settings").DefineState(map[string]any{}, nil).Build()

	server := NewRemoteServer().
		WithState("App", map[string]any{"location": "/"}).
		Source(dir).
		UI(appUI)
	if err := server.Prepare(); err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	transport := NewChannelTransport(64)
	sess, err := server.CreateSession(transport, WithHelloGraceMs(-1))
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	t.Cleanup(func() { _ = sess.Destroy() })

	send := func(msg map[string]any) {
		t.Helper()
		data, _ := json.Marshal(msg)
		if err := sess.Receive(data); err != nil {
			t.Fatalf("Receive %v: %v", msg["type"], err)
		}
	}
	location := func(m OutgoingMessage) (string, bool) {
		su, ok := m.(*StateUpdateMessage)
		if !ok {
			return "", false
		}
		raw, _ := json.Marshal(su.State)
		var st map[string]any
		_ = json.Unmarshal(raw, &st)
		loc, ok := st["location"].(string)
		return loc, ok
	}
	// Reads until a stateUpdate with `want` arrives, then drains briefly
	// and returns the location of the last stateUpdate seen.
	lastLocationAfter := func(want string) string {
		t.Helper()
		last := ""
		deadline := time.After(10 * time.Second)
		for last != want {
			select {
			case m := <-transport.Out():
				if loc, ok := location(m); ok {
					last = loc
				}
			case <-deadline:
				t.Fatalf("no stateUpdate with location %q (last %q)", want, last)
			}
		}
		for {
			select {
			case m := <-transport.Out():
				if loc, ok := location(m); ok {
					last = loc
				}
			case <-time.After(300 * time.Millisecond):
				return last
			}
		}
	}

	send(map[string]any{"type": "hello"})
	if got := lastLocationAfter("/"); got != "/" {
		t.Fatalf("after hello: last location %q", got)
	}
	send(map[string]any{
		"type": "dispatchAction", "action": "router.push",
		"payload": map[string]any{"to": "/settings"},
	})
	if got := lastLocationAfter("/settings"); got != "/settings" {
		t.Fatalf("after router.push: last stateUpdate location %q, want /settings", got)
	}
	send(map[string]any{
		"type": "dispatchAction", "action": "router.replace",
		"payload": map[string]any{"to": "/"},
	})
	if got := lastLocationAfter("/"); got != "/" {
		t.Fatalf("after router.replace: last stateUpdate location %q, want /", got)
	}
}
