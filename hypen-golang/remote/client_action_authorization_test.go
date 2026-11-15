// A Remote UI client is untrusted: it runs an action only while a control
// bound to it is rendered for its session. Knowing a handler's name — bare,
// or in the engine's internal `__hypen_scoped:` form — is not authority.
package remote

import (
	"encoding/json"
	"reflect"
	"sync"
	"testing"
	"time"

	core "github.com/hypen-lang/hypen/hypen-golang"
)

const authUI = `module Admin {
  Column {
    Text("show: @{state.show}")
    Button("@actions.save") { Text("Save") }
    If(@state.show) { Button("@actions.wipe") { Text("Wipe") } }
  }
}`

type authState struct {
	Show bool `json:"show"`
}

type callLog struct {
	mu    sync.Mutex
	calls []string
}

func (c *callLog) add(name string) {
	c.mu.Lock()
	c.calls = append(c.calls, name)
	c.mu.Unlock()
}

func (c *callLog) want(t *testing.T, want ...string) {
	t.Helper()
	time.Sleep(100 * time.Millisecond)
	c.mu.Lock()
	defer c.mu.Unlock()
	if !reflect.DeepEqual(c.calls, want) {
		t.Fatalf("handlers ran: %v, want %v", c.calls, want)
	}
}

func authDefinition(log *callLog) *core.ModuleDefinition {
	return core.NewApp(authState{}).
		Name("Admin").
		OnAction("save", func(core.TypedActionContext[authState]) { log.add("save") }).
		OnAction("wipe", func(core.TypedActionContext[authState]) { log.add("wipe") }).
		OnAction("navigateBack", func(core.TypedActionContext[authState]) { log.add("navigateBack") }).
		UI(authUI).
		Build()
}

func authSession(t *testing.T, s *RemoteServer) func(action string, payload any) {
	t.Helper()
	core.App.Clear()
	t.Cleanup(func() { core.App.Clear() })
	sess, tr := helloSession(t, s)
	if waitForMessage(t, tr, MessageTypeInitialTree, 5*time.Second) == nil {
		t.Fatal("no initialTree")
	}
	<-sess.Ready()
	return func(action string, payload any) {
		t.Helper()
		m := map[string]any{"type": "dispatchAction", "action": action}
		if payload != nil {
			m["payload"] = payload
		}
		raw, _ := json.Marshal(m)
		if err := sess.Receive(raw); err != nil {
			t.Fatalf("Receive %s: %v", action, err)
		}
	}
}

// unrendered sends every spelling of an action no node renders, plus the
// framework's state writer by name.
func unrendered(send func(string, any)) {
	for _, name := range []string{"wipe", "__hypen_scoped::wipe", "__hypen_scoped:admin:wipe", "__hypen_scoped::save"} {
		send(name, nil)
	}
	send("__hypen_dispatch", map[string]any{"action": "wipe"})
	write := map[string]any{"path": "show", "value": true}
	send("__hypen_bind", write)
	send("__hypen_scoped::__hypen_bind", write)
	send("__hypen_scoped:admin:__hypen_bind", write)
	send("wipe", nil) // still hidden: the writes above changed nothing
}

func TestClientAction_NeedsARenderedBinding(t *testing.T) {
	log := &callLog{}
	send := authSession(t, NewRemoteServer().WithDefinition(authDefinition(log)))
	send("save", nil) // rendered: a bare name resolves to its binding
	send("navigateBack", nil)
	unrendered(send)
	log.want(t, "save")
}

func TestClientAction_AllowClientActionsNamesNodelessCalls(t *testing.T) {
	log := &callLog{}
	send := authSession(t, NewRemoteServer().
		WithDefinition(authDefinition(log)).
		AllowClientActions("navigateBack", "__hypen_bind"))
	send("navigateBack", nil)
	unrendered(send)
	log.want(t, "navigateBack")
}

// The map-style OnAction shim keeps its own handler table, so the engine
// only authorises: the shim runs an action the tree binds and nothing else.
func TestClientAction_LegacyShimNeedsARenderedBindingToo(t *testing.T) {
	log := &callLog{}
	send := authSession(t, NewRemoteServer().
		WithState("Admin", map[string]any{"show": false}).
		OnAction(func(action string, _ any, state map[string]any) map[string]any {
			log.add(action)
			return state
		}).
		UI(authUI))
	send("save", nil)
	send("navigateBack", nil)
	unrendered(send)
	log.want(t, "save")
}

// A UI is configured but the session has no engine (it failed to start, or
// the session was torn down): there is no tree to authorise against, so the
// shim must not run.
func TestClientAction_NoEngineFailsClosed(t *testing.T) {
	log := &callLog{}
	shim := func(action string, _ any, state map[string]any) map[string]any {
		log.add(action)
		return state
	}
	core.App.Clear()
	t.Cleanup(func() { core.App.Clear() })

	withUI := NewRemoteServer().WithState("Admin", map[string]any{"show": false}).OnAction(shim).UI(authUI)
	sess, tr := helloSession(t, withUI)
	if waitForMessage(t, tr, MessageTypeInitialTree, 5*time.Second) == nil {
		t.Fatal("no initialTree")
	}
	<-sess.Ready()
	sess.mu.Lock()
	sess.engine = nil
	sess.mu.Unlock()
	sess.dispatchNow("save", nil)
	sess.dispatchNow("wipe", nil)
	log.want(t)
}
