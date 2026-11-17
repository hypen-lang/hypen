// What a remote client may trigger (Go port of
// hypen-web/tests/remote-client-action-admission.test.ts).
//
// A Remote UI client is untrusted: the server runs an action it sends only
// when it arrives as a `__hypen_dispatch` envelope addressed to a live node
// that declares that action (checked by the real engine's client entry,
// hypen_dispatch_client_action in hypen_engine.wasm). A pre-scoped
// `__hypen_scoped:<scope>:<name>`, a bare reserved write (`__hypen_bind`)
// and — unless the server listed it — a bare application name are refused
// before any handler runs.
package remote

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	core "github.com/hypen-lang/hypen/hypen-golang"
)

const admissionUI = `module Admin {
  Column {
    Text("Saves: @{state.saves}")
    Button { Text("Save") }.onClick(@actions.save)
    Input(placeholder: "Name").bind(@state.name)
    If(@state.isAdmin) {
      Button { Text("Wipe") }.onClick(@actions.wipe)
    }
  }
}`

type admissionState struct {
	Saves   int    `json:"saves"`
	Wiped   int    `json:"wiped"`
	Audits  int    `json:"audits"`
	Backs   int    `json:"backs"`
	Pushes  int    `json:"pushes"`
	Name    string `json:"name"`
	IsAdmin bool   `json:"isAdmin"`
}

func admissionDefinition(t *testing.T) *core.ModuleDefinition {
	t.Helper()
	core.App.Clear()
	t.Cleanup(func() { core.App.Clear() })
	return core.NewApp(admissionState{}).
		Name("Admin").
		OnAction("save", func(ctx core.TypedActionContext[admissionState]) { ctx.State.Saves++ }).
		// Bound only behind `If(@state.isAdmin)`.
		OnAction("wipe", func(ctx core.TypedActionContext[admissionState]) { ctx.State.Wiped++ }).
		// Registered, bound on no node at all.
		OnAction("audit", func(ctx core.TypedActionContext[admissionState]) { ctx.State.Audits++ }).
		OnAction("navigateBack", func(ctx core.TypedActionContext[admissionState]) { ctx.State.Backs++ }).
		OnAction("router.push", func(ctx core.TypedActionContext[admissionState]) { ctx.State.Pushes++ }).
		UI(admissionUI)
}

type admissionClient struct {
	t       *testing.T
	sess    *RemoteSession
	tr      *ChannelTransport
	patches []Patch
}

// connectAdmission opens a session on a server configured by `configure`
// (nil = the strict default).
func connectAdmission(t *testing.T, configure func(*RemoteServer)) *admissionClient {
	t.Helper()
	s := NewRemoteServer().WithDefinition(admissionDefinition(t)).DisableAutoRouter()
	if configure != nil {
		configure(s)
	}
	if err := s.Prepare(); err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	sess, tr := helloSession(t, s)
	init := waitForMessage(t, tr, MessageTypeInitialTree, 5*time.Second)
	if init == nil {
		t.Fatal("no initialTree")
	}
	<-sess.Ready()
	return &admissionClient{t: t, sess: sess, tr: tr, patches: init.(*InitialTreeMessage).Patches}
}

func (c *admissionClient) send(action string, payload any) {
	c.t.Helper()
	msg := map[string]any{"type": "dispatchAction", "module": "Admin", "action": action}
	if payload != nil {
		msg["payload"] = payload
	}
	raw, _ := json.Marshal(msg)
	if err := c.sess.Receive(raw); err != nil {
		c.t.Fatalf("Receive %s: %v", action, err)
	}
	c.drain()
}

// drain collects the patches the dispatch produced (the dispatch ran on the
// reader, so they are already queued).
func (c *admissionClient) drain() {
	for {
		select {
		case m := <-c.tr.Out():
			if pm, ok := m.(*PatchMessage); ok {
				c.patches = append(c.patches, pm.Patches...)
			}
		default:
			return
		}
	}
}

func (c *admissionClient) envelope(node, action string, payload any) {
	c.t.Helper()
	if payload == nil {
		payload = map[string]any{}
	}
	c.send(uiActionEnvelope, map[string]any{"node": node, "action": action, "payload": payload})
}

// node is the wire id of the created node whose props carry `needle`.
func (c *admissionClient) node(needle string) string {
	c.t.Helper()
	for _, p := range c.patches {
		if p.Type != "create" {
			continue
		}
		props, _ := json.Marshal(p.Props)
		if strings.Contains(string(props), needle) {
			return p.ID
		}
	}
	all, _ := json.Marshal(c.patches)
	c.t.Fatalf("no node carrying %s in %s", needle, all)
	return ""
}

func (c *admissionClient) state() admissionState {
	c.t.Helper()
	raw, _ := json.Marshal(c.sess.State())
	var st admissionState
	if err := json.Unmarshal(raw, &st); err != nil {
		c.t.Fatalf("state: %v", err)
	}
	return st
}

func (c *admissionClient) expect(want admissionState) {
	c.t.Helper()
	if got := c.state(); got != want {
		c.t.Fatalf("state = %+v, want %+v", got, want)
	}
}

func TestClientAdmission_EnvelopeOnDeclaringNodeRuns(t *testing.T) {
	c := connectAdmission(t, nil)
	c.envelope(c.node("@save"), "save", nil)
	c.expect(admissionState{Saves: 1})
}

func TestClientAdmission_EnvelopeOnNodeWithoutTheActionIsRefused(t *testing.T) {
	c := connectAdmission(t, nil)
	save := c.node("@save")
	// The Save button carries `save`, not `wipe` / `audit` (both registered).
	c.envelope(save, "wipe", nil)
	c.envelope(save, "audit", nil)
	// The Input carries a `.bind`, no action.
	c.envelope(c.node(`"bind"`), "save", nil)
	c.expect(admissionState{})
}

func TestClientAdmission_BoundReservedWriteGoesThroughItsNodesBind(t *testing.T) {
	c := connectAdmission(t, nil)
	input := c.node(`"bind"`)
	c.envelope(input, "__hypen_bind", map[string]any{"path": "name", "value": "Ada"})
	c.expect(admissionState{Name: "Ada"})
	// …and only to the declared path.
	c.envelope(input, "__hypen_bind", map[string]any{"path": "isAdmin", "value": true})
	// …and only from a node that declares a `.bind`.
	c.envelope(c.node("@save"), "__hypen_bind", map[string]any{"path": "isAdmin", "value": true})
	c.expect(admissionState{Name: "Ada"})
}

func TestClientAdmission_PreScopedNameIsRefused(t *testing.T) {
	for _, cfg := range []func(*RemoteServer){nil, func(s *RemoteServer) { s.AllowAnyUnboundClientActions() }} {
		c := connectAdmission(t, cfg)
		c.send("__hypen_scoped::wipe", nil)
		c.send("__hypen_scoped::audit", map[string]any{"all": true})
		c.send("__hypen_scoped:admin:save", nil)
		c.expect(admissionState{})
	}
}

func TestClientAdmission_BareReservedWriteIsRefused(t *testing.T) {
	for _, cfg := range []func(*RemoteServer){
		nil,
		func(s *RemoteServer) { s.AllowAnyUnboundClientActions() },
		func(s *RemoteServer) { s.AllowUnboundClientActions("__hypen_bind", "__hypen_reorder", "__hypen_pin") },
	} {
		c := connectAdmission(t, cfg)
		c.send("__hypen_bind", map[string]any{"path": "isAdmin", "value": true})
		c.send(core.ReorderActionName, map[string]any{"path": "name", "from": 0, "to": 1})
		c.send(core.PinActionName, map[string]any{"path": "name.0", "x": 0, "y": 0})
		c.expect(admissionState{})
	}
}

func TestClientAdmission_BareNameRefusedUnlessListed(t *testing.T) {
	names := []string{"save", "wipe", "audit", "navigateBack"}

	strict := connectAdmission(t, nil)
	for _, n := range names {
		strict.send(n, nil)
	}
	strict.expect(admissionState{})

	listed := connectAdmission(t, func(s *RemoteServer) { s.AllowUnboundClientActions("navigateBack") })
	for _, n := range names {
		listed.send(n, nil)
	}
	listed.expect(admissionState{Backs: 1})

	// The explicit opt-out: the pre-existing by-name behaviour.
	anyName := connectAdmission(t, func(s *RemoteServer) { s.AllowAnyUnboundClientActions() })
	for _, n := range names {
		anyName.send(n, nil)
	}
	anyName.expect(admissionState{Saves: 1, Wiped: 1, Audits: 1, Backs: 1})
}

func TestClientAdmission_RouterActionsAlwaysAdmitted(t *testing.T) {
	c := connectAdmission(t, nil)
	c.send("router.push", "/next")
	c.expect(admissionState{Pushes: 1})
}

func TestClientAdmission_MalformedOrNestedEnvelopeIsRefused(t *testing.T) {
	c := connectAdmission(t, func(s *RemoteServer) { s.AllowAnyUnboundClientActions() })
	save := c.node("@save")
	for _, inner := range []string{uiActionEnvelope, "__hypen_scoped::wipe", "__hypen_anything"} {
		c.envelope(save, inner, nil)
	}
	c.send(uiActionEnvelope, "not an object")
	c.send(uiActionEnvelope, map[string]any{"node": save})
	c.send(uiActionEnvelope, map[string]any{"node": "999999", "action": "save", "payload": map[string]any{}})
	c.send(uiActionEnvelope, map[string]any{"node": "1", "action": "save"})
	c.expect(admissionState{})
}

func TestClientAdmission_RefusalSendsNothingAndSessionStaysUsable(t *testing.T) {
	c := connectAdmission(t, nil)
	save := c.node("@save")
	c.drain()
	before := len(c.patches)
	for _, a := range []string{"wipe", "__hypen_scoped::wipe"} {
		raw, _ := json.Marshal(map[string]any{"type": "dispatchAction", "action": a})
		if err := c.sess.Receive(raw); err != nil {
			t.Fatalf("Receive: %v", err)
		}
		select {
		case m := <-c.tr.Out():
			t.Fatalf("refused %q produced a %s message", a, m.GetType())
		default:
		}
	}
	if len(c.patches) != before {
		t.Fatal("refused actions produced patches")
	}
	c.envelope(save, "save", nil)
	c.expect(admissionState{Saves: 1})
}

// A node that is not rendered for this client (behind `If(@state.isAdmin)`)
// cannot be addressed; once it is rendered, it can.
func TestClientAdmission_NodeNeverRenderedCannotBeAddressed(t *testing.T) {
	c := connectAdmission(t, nil)
	save := c.node("@save")
	// Guess ids around the live ones: none of them carries `wipe`.
	for _, p := range c.patches {
		if p.Type == "create" {
			c.envelope(p.ID, "wipe", nil)
		}
	}
	c.envelope(save, "wipe", nil)
	c.expect(admissionState{})

	c.envelope(c.node(`"bind"`), "__hypen_bind", map[string]any{"path": "name", "value": "x"})
	c.sess.UpdatePrimaryState(map[string]any{"isAdmin": true})
	c.drain()
	c.envelope(c.node("@wipe"), "wipe", nil)
	c.expect(admissionState{Wiped: 1, Name: "x", IsAdmin: true})
}

func TestAdmitUnboundClientAction(t *testing.T) {
	refused := func(name string, policy UnboundClientActions) bool {
		err := admitUnboundClientAction(name, policy)
		if err == nil {
			return false
		}
		var r *ClientActionRefusedError
		if !errors.As(err, &r) {
			t.Fatalf("refusal of %q is %T, want *ClientActionRefusedError", name, err)
		}
		return true
	}
	for _, n := range []string{"router.push", "router.replace", "router.back", "router.forward"} {
		if refused(n, UnboundClientActions{}) {
			t.Errorf("%q refused by default", n)
		}
	}
	for _, n := range []string{"save", "router.pushAll", "router", ""} {
		if !refused(n, UnboundClientActions{}) {
			t.Errorf("%q admitted by default", n)
		}
	}
	if refused("goBack", UnboundClientActions{Names: []string{"goBack"}}) {
		t.Error("listed name refused")
	}
	if !refused("goback", UnboundClientActions{Names: []string{"goBack"}}) {
		t.Error("names are case-sensitive")
	}
	if refused("anything", UnboundClientActions{Any: true}) {
		t.Error("Any refused an application name")
	}
	for _, policy := range []UnboundClientActions{
		{},
		{Any: true},
		{Names: []string{"__hypen_bind", "__hypen_scoped:a:b", "__hypen_dispatch"}},
	} {
		for _, n := range []string{"__hypen_bind", "__hypen_reorder", "__hypen_pin", "__hypen_scoped:a:b", "__hypen_scoped::x", "__hypen_x"} {
			if !refused(n, policy) {
				t.Errorf("%q admitted under %+v", n, policy)
			}
		}
	}
}

// The real engine's client entry, without a session: what
// WasmEngine.DispatchClientAction accepts and refuses.
func TestWasmEngine_DispatchClientAction(t *testing.T) {
	engine, err := core.NewDefaultEngine()
	if err != nil {
		t.Fatal(err)
	}
	defer engine.Close()
	if err := engine.RegisterDefaultPrimitives(); err != nil {
		t.Fatal(err)
	}
	engine.SetModule("App", []string{"go", "other"}, []string{}, map[string]any{})
	var ran []string
	for _, n := range []string{"go", "other"} {
		n := n
		engine.OnAction("__hypen_scoped::"+n, func(a core.Action) { ran = append(ran, n+":"+fmt.Sprint(a.Payload)) })
	}
	patches, err := engine.RenderSource(`Column { Button { Text("Go") }.onClick(@actions.go) Text("plain") }`)
	if err != nil {
		t.Fatal(err)
	}
	ids := map[string]string{}
	for _, p := range patches {
		if p.Type == "create" {
			if _, seen := ids[p.ElementType]; !seen {
				ids[p.ElementType] = p.ID
			}
		}
	}
	env := func(node, action string) map[string]any {
		return map[string]any{"node": node, "action": action, "payload": 7}
	}
	for _, c := range []struct {
		name    string
		payload any
	}{
		{"go", nil},
		{"__hypen_scoped::go", nil},
		{"__hypen_bind", map[string]any{"path": "x", "value": 1}},
		{uiActionEnvelope, env(ids["Text"], "go")},
		{uiActionEnvelope, env(ids["Button"], "other")},
		{uiActionEnvelope, env("424242", "go")},
		{uiActionEnvelope, "nope"},
	} {
		err := engine.DispatchClientAction(c.name, c.payload)
		if !core.IsEngineError(err, core.ErrActionNotFound) {
			t.Errorf("DispatchClientAction(%q, %v) = %v, want a refusal", c.name, c.payload, err)
		}
	}
	if len(ran) != 0 {
		t.Fatalf("refused actions ran handlers: %v", ran)
	}
	if err := engine.DispatchClientAction(uiActionEnvelope, env(ids["Button"], "go")); err != nil {
		t.Fatalf("bound envelope refused: %v", err)
	}
	if fmt.Sprint(ran) != "[go:7]" {
		t.Fatalf("handlers ran %v, want [go:7]", ran)
	}
	resolved, err := engine.ResolveClientAction(uiActionEnvelope, env(ids["Button"], "go"))
	if err != nil || resolved == nil || resolved.Name != "__hypen_scoped::go" || fmt.Sprint(resolved.Payload) != "7" {
		t.Fatalf("ResolveClientAction = %+v, %v", resolved, err)
	}
	if fmt.Sprint(ran) != "[go:7]" {
		t.Fatalf("ResolveClientAction ran a handler: %v", ran)
	}
}
