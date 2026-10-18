package remote

import (
	_ "embed"
	"fmt"
	"net/http"
	"strings"
)

// The default browser client: the same bundle the TypeScript RemoteServer
// serves (hypen-web/packages/server/src/remote/web-client-entry.ts — the
// remote protocol client plus the DOM renderer, no WASM). It is embedded
// prebuilt because Go cannot bundle TypeScript; regenerate it with
// `go generate ./remote` (needs Bun and a hypen-web checkout next to
// hypen-golang) whenever the web renderer or remote client changes.
//
//go:generate sh -c "cd ../../hypen-web && bun build packages/server/src/remote/web-client-entry.ts --target browser --conditions=bun --format esm --minify > ../hypen-golang/remote/webclient/client.js"
//go:embed webclient/client.js
var webClientBundle []byte

// webClientPath is where the HTML shell loads the bundle from (same path
// as the TypeScript server).
const webClientPath = "/__hypen__/client.js"

// webClientHTML is the HTML shell served at `/` (and, as the SPA fallback,
// at any other app route a browser navigates to). The bundle dials back to
// the page's own host over WebSocket (`ws://host/`), which handleHTTP
// upgrades.
const webClientHTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Hypen App</title>
  <link rel="icon" href="data:,">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { height: 100%; }
    body { font-family: system-ui, -apple-system, sans-serif; }
    #app { width: 100vw; min-height: 100vh; display: flex; flex-direction: column; }
    #app > * { flex: 1; }
  </style>
</head>
<body>
  <div id="app"></div>
  <script type="module" src="` + webClientPath + `"></script>
</body>
</html>
`

// serveWebClient answers `/`, `/index.html`, the bundle path and — the SPA
// fallback that makes deep links and reloads on `/counter` work — any other
// page navigation (see isAppNavigation) with the HTML shell; the client then
// starts the session at that path (it moves the server's router with
// `router.replace` before showing the first frame) and keeps the address bar
// in step with `state.location` from then on. Returns false for any other
// request so the caller can fall through.
func serveWebClient(w http.ResponseWriter, r *http.Request) bool {
	switch r.URL.Path {
	case webClientPath:
		w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
		if r.Method != http.MethodHead {
			_, _ = w.Write(webClientBundle)
		}
		return true
	case "/", "/index.html":
		serveWebClientShell(w, r)
		return true
	}
	if isAppNavigation(r) {
		serveWebClientShell(w, r)
		return true
	}
	return false
}

func serveWebClientShell(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	if r.Method != http.MethodHead {
		_, _ = w.Write([]byte(webClientHTML))
	}
}

// acceptsHTML reports whether the request's Accept header lists text/html
// (a browser page navigation, not a fetch/XHR/asset request).
func acceptsHTML(r *http.Request) bool {
	for _, accept := range r.Header.Values("Accept") {
		for _, part := range strings.Split(accept, ",") {
			mediaType, _, _ := strings.Cut(part, ";")
			if strings.EqualFold(strings.TrimSpace(mediaType), "text/html") {
				return true
			}
		}
	}
	return false
}

// isAppNavigation reports whether r is a browser navigation to an app route
// the HTML shell should answer: a GET/HEAD that accepts HTML, outside the
// reserved `/__hypen__/` prefix, whose last path segment doesn't look like a
// file (`/logo.png`, `/app.js` stay 404s instead of returning HTML). Same
// rule as the TypeScript RemoteServer.
func isAppNavigation(r *http.Request) bool {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		return false
	}
	if !acceptsHTML(r) {
		return false
	}
	p := r.URL.Path
	if strings.HasPrefix(p, "/__hypen__/") {
		return false
	}
	last := p[strings.LastIndex(p, "/")+1:]
	if dot := strings.LastIndex(last, "."); dot >= 0 && dot < len(last)-1 && isAlnum(last[dot+1:]) {
		return false
	}
	return true
}

func isAlnum(s string) bool {
	for _, c := range s {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9') {
			return false
		}
	}
	return true
}

// webClientURL is the browser URL logged at startup.
func webClientURL(hostname string, port int) string {
	if hostname == "" || hostname == "0.0.0.0" || strings.HasPrefix(hostname, "::") {
		hostname = "localhost"
	}
	return fmt.Sprintf("http://%s:%d", hostname, port)
}
