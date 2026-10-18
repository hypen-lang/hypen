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

// webClientHTML is the HTML shell served at `/`. The bundle dials back to
// the page's own host over WebSocket (`ws://host/`), which handleHTTP
// upgrades.
const webClientHTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Hypen App</title>
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

// serveWebClient answers `/`, `/index.html` and the bundle path. Returns
// false for any other path so the caller can fall through.
func serveWebClient(w http.ResponseWriter, r *http.Request) bool {
	switch r.URL.Path {
	case "/", "/index.html":
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(webClientHTML))
		return true
	case webClientPath:
		w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
		_, _ = w.Write(webClientBundle)
		return true
	}
	return false
}

// webClientURL is the browser URL logged at startup.
func webClientURL(hostname string, port int) string {
	if hostname == "" || hostname == "0.0.0.0" || strings.HasPrefix(hostname, "::") {
		hostname = "localhost"
	}
	return fmt.Sprintf("http://%s:%d", hostname, port)
}
