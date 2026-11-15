package remote

import (
	"encoding/json"
	"testing"
	"time"

	core "github.com/hypen-lang/hypen/hypen-golang"
)

type themeSessionState struct {
	Taps int `json:"taps"`
}

// Each session forks the server's theme: its tokens are in the initial
// tree, a handler's scheme switch re-renders that client, and another
// client's scheme is untouched.
func TestRemoteServerTheme_PerSessionFork(t *testing.T) {
	const name = "ThemedApp"
	t.Cleanup(func() { core.App.Unregister(name) })

	theme := core.NewTheme(core.ThemeOptions{
		Tokens:  core.Tokens{"color": core.Tokens{"ink": "#111111"}},
		Schemes: map[string]core.Tokens{"dark": {"color": core.Tokens{"ink": "#f5f5f5"}}},
	})
	def := core.NewApp(themeSessionState{}).
		Name(name).
		OnAction("toggle", func(ctx core.TypedActionContext[themeSessionState]) {
			if ctx.Theme() == nil {
				t.Error("handler has no theme")
				return
			}
			ctx.Theme().Toggle()
		}).
		UI(`Column {
			Text("ink").color(@theme.color.ink)
			Text("@{appearance.scheme}")
			Button("@actions.toggle") { Text("toggle") }
		}`)
	server := NewRemoteServer().WithDefinition(def).Theme(theme)

	a, trA := helloSession(t, server)
	b, trB := helloSession(t, server)
	for _, tr := range []*ChannelTransport{trA, trB} {
		msg := waitForMessage(t, tr, MessageTypeInitialTree, 5*time.Second)
		if msg == nil || !patchesMention(msg.(*InitialTreeMessage).Patches, "#111111") {
			t.Fatalf("initialTree does not carry the light token: %+v", msg)
		}
	}
	<-a.Ready()
	<-b.Ready()

	if a.Theme() == nil || b.Theme() == nil || a.Theme() == b.Theme() || a.Theme() == theme {
		t.Fatalf("sessions must each hold their own fork: a=%p b=%p host=%p", a.Theme(), b.Theme(), theme)
	}

	act, _ := json.Marshal(map[string]any{"type": "dispatchAction", "action": "toggle"})
	if err := a.Receive(act); err != nil {
		t.Fatalf("Receive dispatch: %v", err)
	}
	pm := waitForMessage(t, trA, MessageTypePatch, 5*time.Second)
	if pm == nil {
		t.Fatal("no patch after the handler switched scheme")
	}
	// The appearance and theme contexts each publish; collect until the
	// stateUpdate that ends the dispatch.
	patches := append([]Patch{}, pm.(*PatchMessage).Patches...)
collect:
	for {
		select {
		case msg := <-trA.Out():
			if p, ok := msg.(*PatchMessage); ok {
				patches = append(patches, p.Patches...)
				continue
			}
			if msg.GetType() == MessageTypeStateUpdate {
				break collect
			}
		case <-time.After(5 * time.Second):
			t.Fatal("no stateUpdate after the dispatch")
		}
	}
	if !patchesMention(patches, "#f5f5f5") || !patchesMention(patches, `"dark"`) {
		t.Fatalf("scheme switch was not rendered for the session: %+v", patches)
	}

	if a.Theme().Scheme() != "dark" || b.Theme().Scheme() != "light" || theme.Scheme() != "light" {
		t.Fatalf("schemes: a=%q b=%q host=%q", a.Theme().Scheme(), b.Theme().Scheme(), theme.Scheme())
	}
	select {
	case msg := <-trB.Out():
		t.Fatalf("the other session received %T after a's scheme switch", msg)
	case <-time.After(100 * time.Millisecond):
	}

	// After teardown the fork no longer publishes into the closed engine.
	fork := a.Theme()
	if err := a.Destroy(); err != nil {
		t.Fatalf("Destroy: %v", err)
	}
	fork.Toggle()
}

func TestRemoteServerWithoutTheme(t *testing.T) {
	sess, tr := helloSession(t, NewRemoteServer().WithDefinition(qsDefinition(t)))
	if waitForMessage(t, tr, MessageTypeInitialTree, 5*time.Second) == nil {
		t.Fatal("no initialTree")
	}
	<-sess.Ready()
	if sess.Theme() != nil {
		t.Fatal("a server without a theme gave the session one")
	}
}
