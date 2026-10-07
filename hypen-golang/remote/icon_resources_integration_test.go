package remote

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// TestResources_ReachEngineAndResolveIconReferences is the end-to-end
// regression test for the bug where `Icon(@resources.xxx)` rendered as
// "..." under the Go server. The server was loading resources into memory
// but never calling engine.RegisterResources, so the engine left
// "@resources.xxx" as a raw string in Create props instead of injecting
// resolved __iconPaths/__iconViewBox data.
func TestResources_ReachEngineAndResolveIconReferences(t *testing.T) {
	// 1. Prepare a source directory with a single component that uses an Icon.
	tmpDir := t.TempDir()
	compDir := filepath.Join(tmpDir, "App")
	if err := os.MkdirAll(compDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	appTemplate := `Icon(@resources.heart)`
	if err := os.WriteFile(filepath.Join(compDir, "component.hypen"), []byte(appTemplate), 0o644); err != nil {
		t.Fatalf("write component: %v", err)
	}

	// 2. Prepare a resources dir with heart.svg.
	resDir := filepath.Join(tmpDir, "resources")
	if err := os.MkdirAll(resDir, 0o755); err != nil {
		t.Fatalf("mkdir resources: %v", err)
	}
	heartSVG := `<svg viewBox="0 0 24 24"><path d="M12 21s-7-4.5-7-11a5 5 0 0 1 9-3 5 5 0 0 1 9 3c0 6.5-7 11-7 11z" stroke="currentColor" stroke-width="2" fill="none"/></svg>`
	if err := os.WriteFile(filepath.Join(resDir, "heart.svg"), []byte(heartSVG), 0o644); err != nil {
		t.Fatalf("write heart.svg: %v", err)
	}

	// 3. Stand up a RemoteServer in-process, wired like the social example.
	server := NewRemoteServer().
		WithState("App", map[string]any{}).
		UI(appTemplate).
		Source(tmpDir).
		ResourcesDir(resDir)

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		upgrader := websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Logf("upgrade: %v", err)
			return
		}
		server.handleOpen(conn)
		go server.readMessages(conn)
	})
	httpServer := httptest.NewServer(mux)
	defer httpServer.Close()
	defer server.Stop()

	// 4. Connect a raw websocket client and read frames until we see initialTree.
	wsURL := "ws" + strings.TrimPrefix(httpServer.URL, "http") + "/ws"
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial ws: %v", err)
	}
	defer conn.Close()

	// Generous: the legacy grace path compiles the WASM engine before it
	// sends initialTree, which takes well over 5 s under -race.
	_ = conn.SetReadDeadline(time.Now().Add(60 * time.Second))

	var initialTree map[string]any
	for i := 0; i < 10; i++ {
		_, data, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("read ws: %v", err)
		}
		var msg map[string]any
		if err := json.Unmarshal(data, &msg); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if msg["type"] == "initialTree" {
			initialTree = msg
			break
		}
	}
	if initialTree == nil {
		t.Fatal("did not receive initialTree message")
	}

	// 5. Walk the patches and find the Icon create patch. Assert that its
	//    props contain __iconPaths — proving the server registered resources
	//    with the engine and the engine resolved @resources.heart.
	patchesRaw, ok := initialTree["patches"].([]any)
	if !ok {
		t.Fatalf("initialTree.patches missing or wrong type: %+v", initialTree)
	}
	if len(patchesRaw) == 0 {
		t.Fatal("initialTree.patches is empty — server rendered nothing")
	}

	var iconCreate map[string]any
	for _, p := range patchesRaw {
		pm, _ := p.(map[string]any)
		if pm["type"] == "create" && pm["elementType"] == "Icon" {
			iconCreate = pm
			break
		}
	}
	if iconCreate == nil {
		t.Fatalf("no Icon create patch found; patches: %+v", patchesRaw)
	}

	props, ok := iconCreate["props"].(map[string]any)
	if !ok {
		t.Fatalf("Icon create patch has no props: %+v", iconCreate)
	}

	t.Logf("Icon create props: %+v", props)

	if _, hasIconPaths := props["__iconPaths"]; !hasIconPaths {
		t.Fatalf("REGRESSION: Icon props do not contain __iconPaths — resources were not registered with the engine. Props: %+v", props)
	}

	pathsArr, ok := props["__iconPaths"].([]any)
	if !ok || len(pathsArr) == 0 {
		t.Fatalf("__iconPaths is not a non-empty array: %v", props["__iconPaths"])
	}
	first, _ := pathsArr[0].(map[string]any)
	if d, _ := first["d"].(string); d == "" {
		t.Error("resolved icon path has empty d")
	}
}
