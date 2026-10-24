// Server-based (no Source dir) apps: modules built with
// `.Name("Home").UI(tpl)` must render as components, and the auto-wired
// router must be reachable from lifecycle hooks via ctx.GetRouter().
//
// Regression guard for the Go `hypen init` server-based scaffold, which
// rendered a blank page (Home was never registered as a component) and
// whose OnActivated hooks saw a nil router.
package remote

import (
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	core "github.com/hypen-lang/hypen/hypen-golang"
)

const namedAppTemplate = `module App {
  Router {
    Route(path: "/") { Home() }
    Route(path: "/counter") { Counter() }
  }
}`

type namedHomeState struct {
	Greeting string `json:"greeting"`
}

type namedCounterState struct {
	Count int `json:"count"`
}

// startNamedSession boots a session for namedAppTemplate and returns it
// with the transport, after the initialTree has been sent.
func startNamedSession(t *testing.T) (*RemoteSession, *ChannelTransport, []byte) {
	t.Helper()
	appDef := core.NewApp(struct {
		Location string `json:"location"`
	}{Location: "/"}).Name("App").UI(namedAppTemplate)

	server := NewRemoteServer().WithDefinition(appDef).UI(namedAppTemplate)
	if err := server.Prepare(); err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	transport := NewChannelTransport(64)
	sess, err := server.CreateSession(transport, WithHelloGraceMs(-1))
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	t.Cleanup(func() { _ = sess.Destroy() })

	hello, _ := json.Marshal(map[string]any{"type": "hello"})
	if err := sess.Receive(hello); err != nil {
		t.Fatalf("Receive hello: %v", err)
	}
	deadline := time.After(5 * time.Second)
	for {
		select {
		case msg, ok := <-transport.Out():
			if !ok {
				t.Fatal("transport closed before initialTree")
			}
			if msg.GetType() == MessageTypeInitialTree {
				raw, _ := json.Marshal(msg)
				<-sess.Ready()
				return sess, transport, raw
			}
		case <-deadline:
			t.Fatal("timed out waiting for initialTree")
		}
	}
}

// drainUntil collects outgoing messages until one contains want.
func drainUntil(t *testing.T, transport *ChannelTransport, want string) {
	t.Helper()
	deadline := time.After(3 * time.Second)
	for {
		select {
		case msg, ok := <-transport.Out():
			if !ok {
				t.Fatalf("transport closed before %q appeared", want)
			}
			raw, _ := json.Marshal(msg)
			if strings.Contains(string(raw), want) {
				return
			}
		case <-deadline:
			t.Fatalf("timed out waiting for a message containing %q", want)
		}
	}
}

func TestNamedModuleUIRegistersComponent(t *testing.T) {
	core.App.Clear()
	t.Cleanup(func() { core.App.Clear() })

	core.NewApp(namedHomeState{Greeting: "home-body"}).
		Name("Home").
		UI(`module Home { Column { Text("@{state.greeting}") } }`)
	core.NewApp(namedCounterState{}).
		Name("Counter").
		UI(`module Counter { Text("counter-body") }`)

	_, _, initial := startNamedSession(t)
	if !strings.Contains(string(initial), "home-body") {
		t.Fatalf("initialTree does not render Home's template (blank screen): %s", initial)
	}
}

func TestNamedModuleUINavigatesToSecondModule(t *testing.T) {
	core.App.Clear()
	t.Cleanup(func() { core.App.Clear() })

	core.NewApp(namedHomeState{Greeting: "home-body"}).
		Name("Home").
		UI(`module Home { Text("@{state.greeting}") }`)
	core.NewApp(namedCounterState{}).
		Name("Counter").
		UI(`module Counter { Text("counter-body") }`)

	sess, transport, _ := startNamedSession(t)
	push, _ := json.Marshal(map[string]any{
		"type":    "dispatchAction",
		"action":  "router.push",
		"payload": map[string]any{"to": "/counter"},
	})
	if err := sess.Receive(push); err != nil {
		t.Fatalf("Receive router.push: %v", err)
	}
	drainUntil(t, transport, "counter-body")
}

func TestAutoRouterIsVisibleToLifecycleHooks(t *testing.T) {
	core.App.Clear()
	t.Cleanup(func() { core.App.Clear() })

	var mu sync.Mutex
	var routers []*core.HypenRouter
	core.NewApp(namedHomeState{Greeting: "home-body"}).
		Name("Home").
		OnActivated(func(_ *namedHomeState, ctx core.GlobalContext) {
			mu.Lock()
			defer mu.Unlock()
			routers = append(routers, ctx.GetRouter())
		}).
		UI(`module Home { Text("@{state.greeting}") }`)
	core.NewApp(namedCounterState{}).
		Name("Counter").
		UI(`module Counter { Text("counter-body") }`)

	startNamedSession(t)

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		n := len(routers)
		mu.Unlock()
		if n > 0 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(routers) == 0 {
		t.Fatal("Home.OnActivated never ran")
	}
	if routers[0] == nil {
		t.Fatal("ctx.GetRouter() is nil inside OnActivated; the auto-router must SetRouter on the session context")
	}
	if got := routers[0].GetCurrentPath(); got != "/" {
		t.Fatalf("router path in OnActivated = %q, want %q", got, "/")
	}
}
