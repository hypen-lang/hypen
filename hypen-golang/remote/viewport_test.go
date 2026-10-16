// Tests for the client → server `viewport` message (virtualization
// contract §4, hypen-web/docs/virtualization.md): accepted only after
// hello, malformed reports dropped silently, the window moves on the
// sending session's engine only, and the result streams back as an
// ordinary `patch` — never an action, never a stateUpdate, never another
// session's traffic.
package remote

import (
	"encoding/json"
	"fmt"
	"math"
	"sync/atomic"
	"testing"
	"time"

	core "github.com/hypen-lang/hypen/hypen-golang"
)

type virtItem struct {
	ID   int    `json:"id"`
	Name string `json:"name"`
}

type virtState struct {
	Items []virtItem `json:"items"`
}

const virtUI = `module App {
	List(@state.items, key: "id", initialCount: 10) { Text("@{item.name}") }
}`

// newVirtDef builds a module with a 100-row list. Its "viewport" action
// handler counts calls: a viewport report must never reach it.
func newVirtDef(t *testing.T, actionCalls *atomic.Int32) *core.ModuleDefinition {
	t.Helper()
	core.App.Clear()
	t.Cleanup(func() { core.App.Clear() })
	items := make([]virtItem, 100)
	for i := range items {
		items[i] = virtItem{ID: i, Name: fmt.Sprintf("row %d", i)}
	}
	return core.NewApp(virtState{Items: items}).
		Name("App").
		OnAction("viewport", func(ctx core.TypedActionContext[virtState]) {
			actionCalls.Add(1)
		}).
		Build()
}

func newVirtServer(t *testing.T, def *core.ModuleDefinition) *RemoteServer {
	t.Helper()
	server := NewRemoteServer().WithDefinition(def).Source(t.TempDir()).UI(virtUI)
	if err := server.Prepare(); err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	return server
}

func newVirtSession(t *testing.T, server *RemoteServer) (*RemoteSession, *ChannelTransport) {
	t.Helper()
	tr := NewChannelTransport(256)
	sess, err := server.CreateSession(tr, WithHelloGraceMs(-1))
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	t.Cleanup(func() { _ = sess.Destroy() })
	return sess, tr
}

func sendJSON(t *testing.T, sess *RemoteSession, v any) {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := sess.Receive(b); err != nil {
		t.Fatalf("Receive(%s): %v", b, err)
	}
}

// helloAndList completes hello and returns the List element id from the
// initialTree, asserting the initial window is rows [0, 10).
func helloAndList(t *testing.T, sess *RemoteSession, tr *ChannelTransport) string {
	t.Helper()
	sendJSON(t, sess, map[string]any{"type": "hello"})
	msg := waitForMessage(t, tr, MessageTypeInitialTree, 5*time.Second)
	init, ok := msg.(*InitialTreeMessage)
	if !ok {
		t.Fatalf("no initialTree (got %T)", msg)
	}
	select {
	case <-sess.Ready():
	case <-time.After(5 * time.Second):
		t.Fatal("session never became ready")
	}
	listID := ""
	for _, p := range init.Patches {
		if p.Type == "create" && p.ElementType == "List" {
			listID = p.ID
		}
	}
	if listID == "" {
		t.Fatalf("initialTree has no List: %+v", init.Patches)
	}
	if w := windowOf(init.Patches, listID); w == nil || w["start"] != float64(0) || w["end"] != float64(10) || w["total"] != float64(100) {
		t.Fatalf("initial __virt.window = %v, want 0..10 of 100", w)
	}
	return listID
}

// windowOf returns the last `__virt.window` value set on listID, from
// either its create props or a setProp.
func windowOf(patches []Patch, listID string) map[string]any {
	var w map[string]any
	for _, p := range patches {
		if p.ID != listID {
			continue
		}
		switch p.Type {
		case "create":
			if v, ok := p.Props["__virt.window"].(map[string]any); ok {
				w = v
			}
		case "setProp":
			if p.Name == "__virt.window" {
				if v, ok := p.Value.(map[string]any); ok {
					w = v
				}
			}
		}
	}
	return w
}

func countCreated(patches []Patch, elementType string) int {
	n := 0
	for _, p := range patches {
		if p.Type == "create" && p.ElementType == elementType {
			n++
		}
	}
	return n
}

// expectSilence asserts nothing arrives on tr within d.
func expectSilence(t *testing.T, tr *ChannelTransport, d time.Duration, what string) {
	t.Helper()
	if msg := nextMessage(tr, d); msg != nil {
		t.Fatalf("%s: unexpected %s message: %+v", what, msg.GetType(), msg)
	}
}

func TestViewport_MovesWindowOnThisSessionOnly(t *testing.T) {
	var actionCalls atomic.Int32
	server := newVirtServer(t, newVirtDef(t, &actionCalls))
	a, trA := newVirtSession(t, server)
	b, trB := newVirtSession(t, server)
	listA := helloAndList(t, a, trA)
	listB := helloAndList(t, b, trB)
	// Drain anything trailing the handshake.
	for nextMessage(trA, 100*time.Millisecond) != nil {
	}
	for nextMessage(trB, 100*time.Millisecond) != nil {
	}
	revA := a.Revision()

	sendJSON(t, a, map[string]any{"type": "viewport", "listId": listA, "start": 40, "end": 55})

	msg := nextMessage(trA, 5*time.Second)
	pm, ok := msg.(*PatchMessage)
	if !ok {
		t.Fatalf("after viewport: want *PatchMessage, got %T (%+v)", msg, msg)
	}
	if pm.Revision != revA+1 {
		t.Errorf("patch revision = %d, want %d", pm.Revision, revA+1)
	}
	if pm.Module != "App" {
		t.Errorf("patch module = %q, want App", pm.Module)
	}
	if w := windowOf(pm.Patches, listA); w == nil || w["start"] != float64(40) || w["end"] != float64(55) || w["total"] != float64(100) {
		t.Fatalf("__virt.window = %v, want 40..55 of 100", w)
	}
	if got := countCreated(pm.Patches, "Text"); got != 15 {
		t.Errorf("rows created = %d, want 15", got)
	}
	removed := 0
	for _, p := range pm.Patches {
		if p.Type == "remove" {
			removed++
		}
	}
	if removed != 10 {
		t.Errorf("rows removed = %d, want 10", removed)
	}

	// Nothing else: no stateUpdate on this session, nothing at all on the
	// other one, and the "viewport" action handler never ran.
	expectSilence(t, trA, 300*time.Millisecond, "session A after viewport")
	expectSilence(t, trB, 300*time.Millisecond, "session B after A's viewport")
	if n := actionCalls.Load(); n != 0 {
		t.Errorf("viewport reached the action handler %d times", n)
	}
	if a.Revision() != revA+1 {
		t.Errorf("session A revision = %d, want %d", a.Revision(), revA+1)
	}
	if b.Revision() != 0 {
		t.Errorf("session B revision moved to %d", b.Revision())
	}

	// B's own window is untouched: its first viewport still removes
	// rows 0..10.
	sendJSON(t, b, map[string]any{"type": "viewport", "listId": listB, "start": 5, "end": 15})
	pb, ok := nextMessage(trB, 5*time.Second).(*PatchMessage)
	if !ok {
		t.Fatal("session B: no patch for its own viewport")
	}
	if w := windowOf(pb.Patches, listB); w == nil || w["start"] != float64(5) || w["end"] != float64(15) {
		t.Fatalf("session B __virt.window = %v, want 5..15", w)
	}
	if got := countCreated(pb.Patches, "Text"); got != 5 {
		t.Errorf("session B rows created = %d, want 5 (its window was still 0..10)", got)
	}
	expectSilence(t, trA, 200*time.Millisecond, "session A after B's viewport")
}

func TestViewport_BeforeHelloIgnored(t *testing.T) {
	var actionCalls atomic.Int32
	server := newVirtServer(t, newVirtDef(t, &actionCalls))
	sess, tr := newVirtSession(t, server)

	// The List id of a fresh engine is deterministic; any id works for the
	// "nothing happens" half, and the post-hello window proves the early
	// report was not applied later.
	for _, id := range []string{"0", "1", "2", "3", "4294967296", "4294967297"} {
		sendJSON(t, sess, map[string]any{"type": "viewport", "listId": id, "start": 40, "end": 55})
	}
	expectSilence(t, tr, 200*time.Millisecond, "viewport before hello")

	listID := helloAndList(t, sess, tr) // asserts the window is still 0..10
	_ = listID
	if n := actionCalls.Load(); n != 0 {
		t.Errorf("viewport reached the action handler %d times", n)
	}
}

func TestViewport_MalformedIgnored(t *testing.T) {
	var actionCalls atomic.Int32
	server := newVirtServer(t, newVirtDef(t, &actionCalls))
	sess, tr := newVirtSession(t, server)
	listID := helloAndList(t, sess, tr)
	for nextMessage(tr, 100*time.Millisecond) != nil {
	}

	bad := []map[string]any{
		{"type": "viewport", "start": 40, "end": 55},                           // missing listId
		{"type": "viewport", "listId": "", "start": 40, "end": 55},             // empty listId
		{"type": "viewport", "listId": 7, "start": 40, "end": 55},              // listId not a string
		{"type": "viewport", "listId": listID, "end": 55},                      // missing start
		{"type": "viewport", "listId": listID, "start": 40},                    // missing end
		{"type": "viewport", "listId": listID, "start": -1, "end": 55},         // negative
		{"type": "viewport", "listId": listID, "start": 40, "end": -5},         // negative
		{"type": "viewport", "listId": listID, "start": 40.5, "end": 55},       // non-integer
		{"type": "viewport", "listId": listID, "start": "40", "end": 55},       // string
		{"type": "viewport", "listId": listID, "start": nil, "end": 55},        // null
		{"type": "viewport", "listId": listID, "start": true, "end": 55},       // bool
		{"type": "viewport", "listId": listID, "start": []int{40}, "end": 55},  // array
		{"type": "viewport", "listId": listID, "start": 40, "end": 55.0000001}, // non-integer
	}
	for _, m := range bad {
		b, _ := json.Marshal(m)
		if err := sess.Receive(b); err != nil {
			t.Errorf("malformed viewport %s returned an error: %v", b, err)
		}
	}
	expectSilence(t, tr, 300*time.Millisecond, "malformed viewports")
	if sess.Revision() != 0 {
		t.Errorf("revision moved to %d on malformed viewports", sess.Revision())
	}

	// The session is still healthy: a valid report after the garbage works.
	sendJSON(t, sess, map[string]any{"type": "viewport", "listId": listID, "start": 20, "end": 30})
	pm, ok := nextMessage(tr, 5*time.Second).(*PatchMessage)
	if !ok {
		t.Fatal("valid viewport after malformed ones produced no patch")
	}
	if w := windowOf(pm.Patches, listID); w == nil || w["start"] != float64(20) || w["end"] != float64(30) {
		t.Fatalf("__virt.window = %v, want 20..30", w)
	}
	if n := actionCalls.Load(); n != 0 {
		t.Errorf("viewport reached the action handler %d times", n)
	}
}

func TestViewport_UnknownListIDNoTraffic(t *testing.T) {
	var actionCalls atomic.Int32
	server := newVirtServer(t, newVirtDef(t, &actionCalls))
	sess, tr := newVirtSession(t, server)
	helloAndList(t, sess, tr)
	for nextMessage(tr, 100*time.Millisecond) != nil {
	}
	sendJSON(t, sess, map[string]any{"type": "viewport", "listId": "not-a-node", "start": 0, "end": 5})
	expectSilence(t, tr, 300*time.Millisecond, "viewport for an unknown list")
}

func TestViewportIndex_ClampsToU32(t *testing.T) {
	cases := []struct {
		in   any
		want uint32
		ok   bool
	}{
		{float64(0), 0, true},
		{float64(42), 42, true},
		{float64(math.MaxUint32), math.MaxUint32, true},
		{float64(math.MaxUint32) + 1, math.MaxUint32, true},
		{1e20, math.MaxUint32, true},
		{float64(-1), 0, false},
		{0.5, 0, false},
		{math.Inf(1), 0, false},
		{"3", 0, false},
		{nil, 0, false},
	}
	for _, c := range cases {
		got, ok := viewportIndex(c.in)
		if got != c.want || ok != c.ok {
			t.Errorf("viewportIndex(%v) = (%d, %v), want (%d, %v)", c.in, got, ok, c.want, c.ok)
		}
	}

	id, start, end, ok := parseViewport([]byte(`{"type":"viewport","listId":"9","start":3,"end":1e12}`))
	if !ok || id != "9" || start != 3 || end != math.MaxUint32 {
		t.Errorf("parseViewport clamp = (%q, %d, %d, %v)", id, start, end, ok)
	}
}

// TestViewport_EndToEndWebSocket drives two raw clients over real
// WebSockets: one scrolls, only it receives the window move, and neither
// receives a stateUpdate.
func TestViewport_EndToEndWebSocket(t *testing.T) {
	var actionCalls atomic.Int32
	ds := newDevServer(t, nil, newVirtDef(t, &actionCalls), virtUI, nil)

	dial := func() (*devClient, string) {
		c := newDevClient(t, ds.url, nil)
		c.send(map[string]any{"type": "hello"})
		c.waitAck()
		init := c.waitUI("initialTree")
		raw, _ := json.Marshal(init["patches"])
		var patches []Patch
		_ = json.Unmarshal(raw, &patches)
		listID := ""
		for _, p := range patches {
			if p.Type == "create" && p.ElementType == "List" {
				listID = p.ID
			}
		}
		if listID == "" {
			t.Fatal("initialTree has no List")
		}
		return c, listID
	}
	a, listA := dial()
	b, _ := dial()

	a.send(map[string]any{"type": "viewport", "listId": listA, "start": 90, "end": 100})
	m := a.waitUI("patch")
	if m["revision"] != float64(1) {
		t.Errorf("patch revision = %v, want 1", m["revision"])
	}
	raw, _ := json.Marshal(m["patches"])
	var patches []Patch
	_ = json.Unmarshal(raw, &patches)
	if w := windowOf(patches, listA); w == nil || w["start"] != float64(90) || w["end"] != float64(100) {
		t.Fatalf("__virt.window = %v, want 90..100", w)
	}
	if got := countCreated(patches, "Text"); got != 10 {
		t.Errorf("rows created = %d, want 10", got)
	}

	// Malformed and pre-hello-shaped garbage on the same socket: dropped,
	// the connection survives.
	a.sendRaw([]byte(`{"type":"viewport","listId":"` + listA + `","start":-3,"end":4}`))

	select {
	case extra := <-a.ui:
		t.Fatalf("client A: unexpected %v after viewport", extra["type"])
	case extra := <-b.ui:
		t.Fatalf("client B: unexpected %v after A's viewport", extra["type"])
	case <-a.closed:
		t.Fatal("client A disconnected")
	case <-time.After(400 * time.Millisecond):
	}
	if n := actionCalls.Load(); n != 0 {
		t.Errorf("viewport reached the action handler %d times", n)
	}
}

// TestViewport_RemoteEngineClient sends the report through the Go
// RemoteEngine client (a legacy, hello-less client: the server initialises
// it after the hello grace).
func TestViewport_RemoteEngineClient(t *testing.T) {
	var actionCalls atomic.Int32
	ds := newDevServer(t, nil, newVirtDef(t, &actionCalls), virtUI, nil)

	patchCh := make(chan []Patch, 16)
	var states atomic.Int32
	client := NewRemoteEngine(ds.url, &EngineOptions{AutoReconnect: false})
	client.OnPatches(func(p []Patch) { patchCh <- p })
	client.OnStateUpdate(func(any) { states.Add(1) })

	if err := client.SetListViewport("1", 0, 1); err == nil {
		t.Fatal("SetListViewport before Connect should fail")
	}
	if err := client.Connect(); err != nil {
		t.Fatalf("Connect: %v", err)
	}
	defer client.Disconnect()

	var initial []Patch
	select {
	case initial = <-patchCh:
	case <-time.After(10 * time.Second):
		t.Fatal("no initialTree")
	}
	listID := ""
	for _, p := range initial {
		if p.Type == "create" && p.ElementType == "List" {
			listID = p.ID
		}
	}
	if listID == "" {
		t.Fatal("initialTree has no List")
	}
	statesBefore := states.Load()

	if err := client.SetListViewport(listID, 50, 60); err != nil {
		t.Fatalf("SetListViewport: %v", err)
	}
	select {
	case moved := <-patchCh:
		if w := windowOf(moved, listID); w == nil || w["start"] != float64(50) || w["end"] != float64(60) {
			t.Fatalf("__virt.window = %v, want 50..60", w)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no patches for the viewport")
	}
	time.Sleep(300 * time.Millisecond)
	if states.Load() != statesBefore {
		t.Error("viewport produced a stateUpdate")
	}
	if client.GetRevision() != 1 {
		t.Errorf("client revision = %d, want 1", client.GetRevision())
	}
}

// TestViewport_ContractTableRows pins the rows every server SDK agrees on
// (see hypen-sdk-rs viewport_contract_table_rows): `-0` and `1e1` are
// integers; re-reporting the current window sends nothing and keeps the
// revision; `start > end` is forwarded and the engine keeps the single
// item at `start`.
func TestViewport_ContractTableRows(t *testing.T) {
	var actionCalls atomic.Int32
	server := newVirtServer(t, newVirtDef(t, &actionCalls))
	sess, tr := newVirtSession(t, server)
	listID := helloAndList(t, sess, tr)
	for nextMessage(tr, 100*time.Millisecond) != nil {
	}

	// The initial window [0, 10) again, spelled -0 / 1e1: a no-op.
	if err := sess.Receive([]byte(`{"type":"viewport","listId":"` + listID + `","start":-0,"end":1e1}`)); err != nil {
		t.Fatalf("Receive: %v", err)
	}
	expectSilence(t, tr, 300*time.Millisecond, "viewport repeating the current window")
	if sess.Revision() != 0 {
		t.Fatalf("revision moved to %d on a no-op viewport", sess.Revision())
	}

	sendJSON(t, sess, map[string]any{"type": "viewport", "listId": listID, "start": 50, "end": 10})
	pm, ok := nextMessage(tr, 5*time.Second).(*PatchMessage)
	if !ok {
		t.Fatal("start > end produced no patch")
	}
	if w := windowOf(pm.Patches, listID); w == nil || w["start"] != float64(50) || w["end"] != float64(51) {
		t.Fatalf("__virt.window = %v, want 50..51", w)
	}
	if pm.Revision != 1 {
		t.Errorf("patch revision = %d, want 1", pm.Revision)
	}
}
