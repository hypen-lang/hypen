package remote

// Regression tests for the documented Go quick start (onboarding QA):
//   - core.NewApp(...).Name(...).UI(...).Build() compiles and WithDefinition
//     alone is enough (the module's template is the server UI),
//   - an inline UI renders without .Source(dir) (initialTree had
//     `patches: []`),
//   - Listen blocks until Stop, ListenAsync does not,
//   - the built-in web client is served at `/`.

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	core "github.com/hypen-space/core"
)

type qsCounterState struct {
	Count int `json:"count"`
}

const qsTemplate = `
Column {
    Text("Count: @{state.count}")
    Button("@actions.increment") { Text("+") }
}
`

func qsDefinition(t *testing.T) *core.ModuleDefinition {
	t.Helper()
	const name = "QuickStartCounter"
	t.Cleanup(func() { core.App.Unregister(name) })
	return core.NewApp(qsCounterState{}).
		Name(name).
		OnAction("increment", func(ctx core.TypedActionContext[qsCounterState]) {
			ctx.State.Count++
		}).
		UI(qsTemplate).
		Build() // documented chain: a no-op after UI()
}

// patchesMention reports whether any patch carries `text` in a prop value.
func patchesMention(patches []Patch, text string) bool {
	data, _ := json.Marshal(patches)
	return strings.Contains(string(data), text)
}

func helloSession(t *testing.T, s *RemoteServer) (*RemoteSession, *ChannelTransport) {
	t.Helper()
	transport := NewChannelTransport(64)
	sess, err := s.CreateSession(transport, WithHelloGraceMs(-1))
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	t.Cleanup(func() { _ = sess.Destroy() })
	hello, _ := json.Marshal(map[string]any{"type": "hello"})
	if err := sess.Receive(hello); err != nil {
		t.Fatalf("Receive hello: %v", err)
	}
	return sess, transport
}

func TestModuleDefinition_BuildIsNoOp(t *testing.T) {
	def := core.NewApp(qsCounterState{}).UI(`Text("x")`)
	if def.Build() != def {
		t.Fatal("ModuleDefinition.Build() must return the same definition")
	}
}

func TestWithDefinition_UsesModuleTemplate(t *testing.T) {
	def := qsDefinition(t)
	s := NewRemoteServer().WithDefinition(def)
	if err := s.Prepare(); err != nil {
		t.Fatalf("Prepare without UI(): %v", err)
	}
	if got := (serverSessionHost{s}).UI(); got != def.Template {
		t.Fatalf("server UI = %q, want module template", got)
	}

	// An explicit UI() wins regardless of call order.
	s1 := NewRemoteServer().UI(`Text("explicit")`).WithDefinition(def)
	s2 := NewRemoteServer().WithDefinition(def).UI(`Text("explicit")`)
	for i, srv := range []*RemoteServer{s1, s2} {
		if got := (serverSessionHost{srv}).UI(); got != `Text("explicit")` {
			t.Fatalf("case %d: explicit UI lost: %q", i, got)
		}
	}
}

func TestInlineUI_RendersWithoutSource(t *testing.T) {
	s := NewRemoteServer().WithDefinition(qsDefinition(t))
	sess, tr := helloSession(t, s)

	msg := waitForMessage(t, tr, MessageTypeInitialTree, 5*time.Second)
	if msg == nil {
		t.Fatal("no initialTree")
	}
	init := msg.(*InitialTreeMessage)
	if len(init.Patches) == 0 {
		t.Fatal("initialTree has no patches for an inline UI without Source()")
	}
	if !patchesMention(init.Patches, "Count: 0") {
		t.Fatalf("initial patches do not render the state: %+v", init.Patches)
	}
	<-sess.Ready()

	act, _ := json.Marshal(map[string]any{"type": "dispatchAction", "action": "increment"})
	if err := sess.Receive(act); err != nil {
		t.Fatalf("Receive dispatch: %v", err)
	}
	pm := waitForMessage(t, tr, MessageTypePatch, 5*time.Second)
	if pm == nil {
		t.Fatal("no patch after increment")
	}
	if !patchesMention(pm.(*PatchMessage).Patches, "Count: 1") {
		t.Fatalf("increment patch does not show Count: 1: %+v", pm.(*PatchMessage).Patches)
	}
}

func TestLegacyOnAction_InlineUIRendersAndUpdates(t *testing.T) {
	s := NewRemoteServer().
		WithState("Counter", map[string]any{"count": 0}).
		OnAction(func(action string, _ any, state map[string]any) map[string]any {
			if action == "increment" {
				state["count"] = state["count"].(int) + 1
			}
			return state
		}).
		UI(qsTemplate)
	sess, tr := helloSession(t, s)

	msg := waitForMessage(t, tr, MessageTypeInitialTree, 5*time.Second)
	if msg == nil || !patchesMention(msg.(*InitialTreeMessage).Patches, "Count: 0") {
		t.Fatalf("legacy server initialTree did not render: %+v", msg)
	}
	<-sess.Ready()

	act, _ := json.Marshal(map[string]any{"type": "dispatchAction", "action": "increment"})
	if err := sess.Receive(act); err != nil {
		t.Fatalf("Receive dispatch: %v", err)
	}
	pm := waitForMessage(t, tr, MessageTypePatch, 5*time.Second)
	if pm == nil || !patchesMention(pm.(*PatchMessage).Patches, "Count: 1") {
		t.Fatalf("legacy OnAction did not re-render: %+v", pm)
	}
	su := waitForMessage(t, tr, MessageTypeStateUpdate, 5*time.Second)
	if su == nil {
		t.Fatal("no stateUpdate after legacy action")
	}
	if got := su.(*StateUpdateMessage); got.Revision != pm.(*PatchMessage).Revision {
		t.Fatalf("stateUpdate revision %d != patch revision %d", got.Revision, pm.(*PatchMessage).Revision)
	}
}

func freePort(t *testing.T) int {
	t.Helper()
	// Lane port range 4740-4759.
	for p := 4740; p <= 4759; p++ {
		ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", p))
		if err == nil {
			ln.Close()
			return p
		}
	}
	t.Skip("no free port in 4740-4759")
	return 0
}

func waitHTTP(t *testing.T, url string) *http.Response {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		resp, err := http.Get(url)
		if err == nil {
			return resp
		}
		if time.Now().After(deadline) {
			t.Fatalf("GET %s: %v", url, err)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestListen_BlocksUntilStop_AndServesWebClient(t *testing.T) {
	port := freePort(t)
	s := NewRemoteServer().
		WithDefinition(qsDefinition(t)).
		Config(ServerConfig{Hostname: "127.0.0.1"})

	returned := make(chan struct{})
	go func() {
		s.Listen(port)
		close(returned)
	}()
	base := fmt.Sprintf("http://127.0.0.1:%d", port)

	resp := waitHTTP(t, base+"/")
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if !strings.Contains(resp.Header.Get("Content-Type"), "text/html") || !strings.Contains(string(body), webClientPath) {
		t.Fatalf("GET / did not serve the web client shell: %s %q", resp.Header.Get("Content-Type"), body)
	}
	resp = waitHTTP(t, base+webClientPath)
	js, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if !strings.Contains(resp.Header.Get("Content-Type"), "javascript") || len(js) < 1000 {
		t.Fatalf("client bundle not served: %s (%d bytes)", resp.Header.Get("Content-Type"), len(js))
	}

	// The browser client dials ws://host/ — the root must still upgrade.
	conn, _, err := websocket.DefaultDialer.Dial(fmt.Sprintf("ws://127.0.0.1:%d/", port), nil)
	if err != nil {
		t.Fatalf("ws dial at /: %v", err)
	}
	_ = conn.WriteJSON(map[string]any{"type": "hello"})
	var sawInitial bool
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	for !sawInitial {
		var m map[string]any
		if err := conn.ReadJSON(&m); err != nil {
			t.Fatalf("read: %v", err)
		}
		if m["type"] == string(MessageTypeInitialTree) {
			sawInitial = true
			if p, _ := m["patches"].([]any); len(p) == 0 {
				t.Fatal("initialTree over ws has no patches")
			}
		}
	}
	conn.Close()

	select {
	case <-returned:
		t.Fatal("Listen returned while the server was running")
	case <-time.After(100 * time.Millisecond):
	}
	s.Stop()
	select {
	case <-returned:
	case <-time.After(5 * time.Second):
		t.Fatal("Listen did not return after Stop")
	}
}

func TestListenAsync_ReturnsImmediately_WebClientCanBeDisabled(t *testing.T) {
	port := freePort(t)
	s := NewRemoteServer().
		WithDefinition(qsDefinition(t)).
		Config(ServerConfig{Hostname: "127.0.0.1"}).
		DisableWebClient()

	done := make(chan struct{})
	go func() {
		s.ListenAsync(port)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("ListenAsync blocked")
	}
	defer s.Stop()

	// Bound before returning: no retry needed.
	resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/", port))
	if err != nil {
		t.Fatalf("GET / right after ListenAsync: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(body) != "Hypen Remote Server" {
		t.Fatalf("web client served despite DisableWebClient: %q", body)
	}

	waited := make(chan struct{})
	go func() { s.Wait(); close(waited) }()
	s.Stop()
	select {
	case <-waited:
	case <-time.After(5 * time.Second):
		t.Fatal("Wait did not return after Stop")
	}
}

func TestListenAndServe_ReturnsBindError(t *testing.T) {
	port := freePort(t)
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	s := NewRemoteServer().
		WithDefinition(qsDefinition(t)).
		Config(ServerConfig{Hostname: "127.0.0.1"})
	if err := s.ListenAndServe(port); err == nil {
		t.Fatal("ListenAndServe on a taken port returned nil")
	}
}

// The DOM renderer sends clicks as a `__hypen_dispatch` envelope; the
// legacy map-style OnAction shim must see the plain action name.
func TestLegacyOnAction_UnwrapsRendererEnvelope(t *testing.T) {
	var got []string
	s := NewRemoteServer().
		WithState("Counter", map[string]any{"count": 0}).
		OnAction(func(action string, payload any, state map[string]any) map[string]any {
			got = append(got, action)
			if action == "increment" {
				state["count"] = state["count"].(int) + 1
			}
			return state
		}).
		UI(qsTemplate)
	sess, tr := helloSession(t, s)
	if waitForMessage(t, tr, MessageTypeInitialTree, 5*time.Second) == nil {
		t.Fatal("no initialTree")
	}
	<-sess.Ready()

	act, _ := json.Marshal(map[string]any{
		"type":   "dispatchAction",
		"action": "__hypen_dispatch",
		"payload": map[string]any{
			"node":    "1",
			"action":  "increment",
			"payload": map[string]any{"type": "click"},
		},
	})
	if err := sess.Receive(act); err != nil {
		t.Fatalf("Receive dispatch: %v", err)
	}
	pm := waitForMessage(t, tr, MessageTypePatch, 5*time.Second)
	if pm == nil || !patchesMention(pm.(*PatchMessage).Patches, "Count: 1") {
		t.Fatalf("enveloped click did not reach the shim (calls %v): %+v", got, pm)
	}
	if len(got) != 1 || got[0] != "increment" {
		t.Fatalf("shim saw %v, want [increment]", got)
	}
}

func TestUnwrapUIAction(t *testing.T) {
	cases := []struct {
		name    string
		payload any
		want    string
	}{
		{"increment", nil, "increment"},
		{"__hypen_dispatch", map[string]any{"action": "save", "payload": 1}, "save"},
		{"__hypen_dispatch", map[string]any{"action": "__hypen_bind"}, "__hypen_dispatch"},
		{"__hypen_dispatch", "not-a-map", "__hypen_dispatch"},
	}
	for _, c := range cases {
		if got, _ := unwrapUIAction(c.name, c.payload); got != c.want {
			t.Errorf("unwrapUIAction(%q, %v) = %q, want %q", c.name, c.payload, got, c.want)
		}
	}
}
