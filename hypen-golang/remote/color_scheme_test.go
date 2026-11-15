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

// Client-reported system color scheme: hello.colorScheme, the `colorScheme`
// message, and the theme preference kept across a session resume.

const csLight, csDark = "#111111", "#f5f5f5"

// csServer is a themed server whose template binds one token that differs
// per scheme (ink) and one that does not (space.md). Its "pin" action
// selects the scheme named by the payload.
func csServer(t *testing.T) *RemoteServer {
	t.Helper()
	const name = "ColorSchemeApp"
	t.Cleanup(func() { core.App.Unregister(name) })
	theme := core.NewTheme(core.ThemeOptions{
		Tokens:  core.Tokens{"color": core.Tokens{"ink": csLight}, "space": core.Tokens{"md": 16}},
		Schemes: map[string]core.Tokens{"dark": {"color": core.Tokens{"ink": csDark}}},
	})
	def := core.NewApp(themeSessionState{}).
		Name(name).
		OnAction("pin", func(ctx core.TypedActionContext[themeSessionState]) {
			scheme, _ := ctx.Action.Payload.(string)
			if err := ctx.Theme().SetScheme(scheme); err != nil {
				t.Errorf("SetScheme(%q): %v", scheme, err)
			}
		}).
		UI(`Column {
			Text("ink").color(@theme.color.ink).padding(@theme.space.md)
			Button("@actions.pin") { Text("pin") }
		}`)
	return NewRemoteServer().WithDefinition(def).Theme(theme)
}

// csSession opens a session — feeding it `before` first, then a hello with
// the given extra fields — and returns it with its initial patches.
func csSession(t *testing.T, s *RemoteServer, hello map[string]any, before ...map[string]any) (*RemoteSession, *ChannelTransport, []Patch) {
	t.Helper()
	tr := NewChannelTransport(64)
	sess, err := s.CreateSession(tr, WithHelloGraceMs(-1))
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	t.Cleanup(func() { _ = sess.Destroy() })
	for _, msg := range before {
		csSend(t, sess, msg)
	}
	msg := map[string]any{"type": "hello"}
	for k, v := range hello {
		msg[k] = v
	}
	csSend(t, sess, msg)
	init := waitForMessage(t, tr, MessageTypeInitialTree, 5*time.Second)
	if init == nil {
		t.Fatal("no initialTree")
	}
	<-sess.Ready()
	return sess, tr, init.(*InitialTreeMessage).Patches
}

func csSend(t *testing.T, sess *RemoteSession, msg map[string]any) {
	t.Helper()
	data, _ := json.Marshal(msg)
	if err := sess.Receive(data); err != nil {
		t.Fatalf("Receive %v: %v", msg, err)
	}
}

// csDrain returns everything the session sent until it has been quiet for
// a moment. Receive is synchronous for these sessions (no device plane),
// so whatever a message caused is already queued.
func csDrain(tr *ChannelTransport) []Message {
	var out []Message
	for {
		select {
		case msg := <-tr.Out():
			out = append(out, msg)
		case <-time.After(100 * time.Millisecond):
			return out
		}
	}
}

func csPatches(msgs []Message) []Patch {
	var out []Patch
	for _, msg := range msgs {
		if p, ok := msg.(*PatchMessage); ok {
			out = append(out, p.Patches...)
		}
	}
	return out
}

func TestColorScheme_HelloSeedsTheFirstFrame(t *testing.T) {
	sess, tr, initial := csSession(t, csServer(t), map[string]any{"colorScheme": "dark"})
	if !patchesMention(initial, csDark) || patchesMention(initial, csLight) {
		t.Fatalf("first frame is not dark: %+v", initial)
	}
	// No light-then-dark flip: nothing follows the initial tree.
	if rest := csDrain(tr); len(rest) != 0 {
		t.Fatalf("messages after the initial tree: %+v", rest)
	}
	if th := sess.Theme(); th.SystemScheme() != "dark" || th.Preference() != core.SystemScheme || th.Scheme() != "dark" {
		t.Fatalf("theme = %+v", th.Meta())
	}
}

func TestColorScheme_MessageRerendersOnlyTheChangedProp(t *testing.T) {
	server := csServer(t)
	a, trA, initial := csSession(t, server, nil)
	b, trB, _ := csSession(t, server, nil)
	if !patchesMention(initial, csLight) {
		t.Fatalf("first frame without hello.colorScheme is not light: %+v", initial)
	}

	csSend(t, a, map[string]any{"type": "colorScheme", "scheme": "dark"})
	msgs := csDrain(trA)
	for _, msg := range msgs {
		if _, ok := msg.(*PatchMessage); !ok {
			t.Errorf("colorScheme answered with %T; want patch messages only", msg)
		}
	}
	patches := csPatches(msgs)
	if len(patches) != 1 || patches[0].Type != "setProp" || patches[0].Name != "color.0" || patches[0].Value != csDark {
		t.Fatalf("patches = %+v, want one setProp color.0=%s", patches, csDark)
	}

	// Reporting the same scheme again changes nothing.
	csSend(t, a, map[string]any{"type": "colorScheme", "scheme": "dark"})
	if again := csDrain(trA); len(again) != 0 {
		t.Errorf("repeated colorScheme sent %+v", again)
	}

	// The other session is untouched.
	if other := csDrain(trB); len(other) != 0 {
		t.Errorf("the other session received %+v", other)
	}
	if b.Theme().Scheme() != "light" || a.Theme().Scheme() != "dark" {
		t.Errorf("schemes: a=%q b=%q", a.Theme().Scheme(), b.Theme().Scheme())
	}
}

func TestColorScheme_ExplicitPreferenceMakesItANoOp(t *testing.T) {
	sess, tr, _ := csSession(t, csServer(t), map[string]any{"colorScheme": "dark"})

	csSend(t, sess, map[string]any{"type": "dispatchAction", "action": "pin", "payload": "light"})
	if patches := csPatches(csDrain(tr)); !patchesMention(patches, csLight) {
		t.Fatalf("handler's SetScheme(light) was not rendered: %+v", patches)
	}

	for _, scheme := range []string{"light", "dark"} {
		csSend(t, sess, map[string]any{"type": "colorScheme", "scheme": scheme})
		if msgs := csDrain(tr); len(msgs) != 0 {
			t.Errorf("colorScheme %s under an explicit preference sent %+v", scheme, msgs)
		}
	}
	if th := sess.Theme(); th.Scheme() != "light" || th.SystemScheme() != "dark" {
		t.Fatalf("theme = %+v", th.Meta())
	}

	// Back to "system": the remembered report takes effect.
	csSend(t, sess, map[string]any{"type": "dispatchAction", "action": "pin", "payload": "system"})
	if patches := csPatches(csDrain(tr)); !patchesMention(patches, csDark) {
		t.Fatalf("returning to system did not follow the reported scheme: %+v", patches)
	}
}

func TestColorScheme_MalformedValuesAreIgnored(t *testing.T) {
	server := csServer(t)
	for _, bad := range []any{"sepia", "system", "Dark", "", 7, true, nil, []string{"dark"}, map[string]any{"scheme": "dark"}} {
		sess, tr, initial := csSession(t, server, map[string]any{"colorScheme": bad})
		if !patchesMention(initial, csLight) {
			t.Errorf("hello.colorScheme=%#v changed the first frame: %+v", bad, initial)
		}
		csSend(t, sess, map[string]any{"type": "colorScheme", "scheme": bad})
		csSend(t, sess, map[string]any{"type": "colorScheme"})
		if msgs := csDrain(tr); len(msgs) != 0 {
			t.Errorf("colorScheme scheme=%#v sent %+v", bad, msgs)
		}
		if sess.Theme().SystemScheme() != "light" {
			t.Errorf("scheme=%#v changed the system scheme", bad)
		}
		_ = sess.Destroy()
	}
}

func TestColorScheme_IgnoredBeforeHelloAndWithoutATheme(t *testing.T) {
	// Before hello: dropped, not remembered.
	sess, _, initial := csSession(t, csServer(t), nil, map[string]any{"type": "colorScheme", "scheme": "dark"})
	if !patchesMention(initial, csLight) || sess.Theme().SystemScheme() != "light" {
		t.Errorf("a colorScheme message before hello took effect: %+v", initial)
	}

	// No theme registered: accepted and ignored.
	plain, tr := helloSession(t, NewRemoteServer().WithDefinition(qsDefinition(t)))
	if waitForMessage(t, tr, MessageTypeInitialTree, 5*time.Second) == nil {
		t.Fatal("no initialTree")
	}
	<-plain.Ready()
	csSend(t, plain, map[string]any{"type": "colorScheme", "scheme": "dark"})
	if msgs := csDrain(tr); len(msgs) != 0 {
		t.Errorf("colorScheme without a theme sent %+v", msgs)
	}
}

// A report that arrives after hello but before the session's theme fork
// exists is remembered and applied when the fork is created.
func TestColorScheme_ReportBeforeTheForkIsApplied(t *testing.T) {
	server := csServer(t)
	tr := NewChannelTransport(64)
	sess, err := server.CreateSession(tr, WithHelloGraceMs(-1))
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	t.Cleanup(func() { _ = sess.Destroy() })

	// The state Receive(hello) is in between marking the hello received
	// and building the engine.
	sess.mu.Lock()
	sess.helloReceived = true
	sess.mu.Unlock()
	csSend(t, sess, map[string]any{"type": "colorScheme", "scheme": "dark"})
	sess.initializeSession("", nil, nil, "")

	init := waitForMessage(t, tr, MessageTypeInitialTree, 5*time.Second)
	if init == nil || !patchesMention(init.(*InitialTreeMessage).Patches, csDark) {
		t.Fatalf("the early report was lost: %+v", init)
	}
}

func TestColorScheme_ResumeKeepsThePreference(t *testing.T) {
	server := csServer(t)
	first, tr, _ := csSession(t, server, nil)
	csSend(t, first, map[string]any{"type": "dispatchAction", "action": "pin", "payload": "dark"})
	csDrain(tr)
	id := first.SessionID()
	if id == "" {
		t.Fatal("no session id")
	}
	if err := first.Destroy(); err != nil {
		t.Fatalf("Destroy: %v", err)
	}

	// Resumed within the TTL, reporting a light system: the explicit dark
	// preference still wins, from the first frame.
	resumed, _, initial := csSession(t, server, map[string]any{"sessionId": id, "colorScheme": "light"})
	if resumed.SessionID() != id {
		t.Fatalf("session was not resumed: %q != %q", resumed.SessionID(), id)
	}
	if th := resumed.Theme(); th.Preference() != "dark" || th.Scheme() != "dark" {
		t.Fatalf("resumed theme = %+v, want preference dark", th.Meta())
	}
	if !patchesMention(initial, csDark) || patchesMention(initial, csLight) {
		t.Fatalf("resumed first frame is not dark: %+v", initial)
	}

	// A brand-new session starts from the host theme's preference.
	fresh, _, _ := csSession(t, server, nil)
	if th := fresh.Theme(); th.Preference() != core.SystemScheme || th.Scheme() != "light" {
		t.Fatalf("a new session inherited another session's preference: %+v", th.Meta())
	}
}

// The Go client over a real WebSocket: the option travels in hello, and
// SetColorScheme sends the message.
func TestColorScheme_RemoteEngineClient(t *testing.T) {
	server := csServer(t)
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", server.handleWebSocket)
	hs := httptest.NewServer(mux)
	t.Cleanup(func() {
		server.Stop()
		hs.Close()
	})

	patchCh := make(chan []Patch, 16)
	client := NewRemoteEngine("ws"+strings.TrimPrefix(hs.URL, "http")+"/ws", &EngineOptions{ColorScheme: "dark"})
	client.OnPatches(func(p []Patch) { patchCh <- p })
	if err := client.SetColorScheme("neon"); err == nil {
		t.Error("SetColorScheme accepted an unknown scheme")
	}
	if err := client.Connect(); err != nil {
		t.Fatalf("Connect: %v", err)
	}
	defer client.Disconnect()

	next := func(what string) []Patch {
		t.Helper()
		select {
		case p := <-patchCh:
			return p
		case <-time.After(10 * time.Second):
			t.Fatalf("no %s", what)
			return nil
		}
	}
	if initial := next("initialTree"); !patchesMention(initial, csDark) || patchesMention(initial, csLight) {
		t.Fatalf("hello.colorScheme did not seed the first frame: %+v", initial)
	}

	if err := client.SetColorScheme("dark"); err != nil { // already reported
		t.Fatalf("SetColorScheme: %v", err)
	}
	if err := client.SetColorScheme("light"); err != nil {
		t.Fatalf("SetColorScheme: %v", err)
	}
	if patches := next("patch after SetColorScheme"); len(patches) != 1 || patches[0].Name != "color.0" || patches[0].Value != csLight {
		t.Fatalf("patches = %+v, want one setProp color.0=%s", patches, csLight)
	}
	select {
	case extra := <-patchCh:
		t.Fatalf("unexpected extra patches: %+v", extra)
	case <-time.After(150 * time.Millisecond):
	}
}
