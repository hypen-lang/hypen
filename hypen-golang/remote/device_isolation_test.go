package remote

// Device-plane admission on bring-your-own endpoints, per-connection
// engine-module instances (trap isolation), the server-wide aggregate
// retained-bytes budget across those instances, and held upload results.

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	core "github.com/hypen-space/core"
	"github.com/hypen-space/core/device"
)

// sessionFor returns the server session whose sessionAck carried sid.
func sessionFor(t *testing.T, srv *RemoteServer, sid any) *RemoteSession {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		for _, s := range srv.Sessions() {
			if s.SessionID() == sid {
				return s
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("no server session for %v", sid)
	return nil
}

func planeOf(s *RemoteSession) *sessionDevice {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.dev
}

// byoServer serves the device app on hand-written endpoints (the
// bring-your-own-endpoint path: the host upgrades and calls CreateSession
// itself). auths counts authenticator calls.
func byoServer(t *testing.T, auths *atomic.Int32) (*RemoteServer, func(path string) string) {
	t.Helper()
	core.App.Clear()
	t.Cleanup(func() { core.App.Clear() })
	srv := NewRemoteServer().WithDefinition(devApp(newRecorder(), nil)).Source(t.TempDir()).UI(devUI).
		AllowedOrigins("https://app.example").
		Authenticate(func(r *http.Request) bool {
			auths.Add(1)
			return r.Header.Get("Authorization") == "Bearer test"
		})
	serve := func(conn *websocket.Conn, opts ...SessionOption) {
		if _, err := srv.CreateSession(NewGorillaWebSocketTransport(conn), append([]SessionOption{WithSocketHandle(conn)}, opts...)...); err != nil {
			conn.Close()
			return
		}
		go srv.readMessages(conn)
	}
	permissive := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	mux := http.NewServeMux()
	// The documented path: the server's Upgrader + WithUpgradeRequest.
	mux.HandleFunc("/byo", func(w http.ResponseWriter, r *http.Request) {
		up := srv.Upgrader()
		conn, err := up.Upgrade(w, r, nil)
		if err != nil {
			return // the upgrader answered 403
		}
		serve(conn, WithUpgradeRequest(r))
	})
	// A host that skipped admission entirely.
	mux.HandleFunc("/rogue", func(w http.ResponseWriter, r *http.Request) {
		conn, err := permissive.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		serve(conn)
	})
	// A host that upgraded without admitting but passes the request on:
	// CreateSession admits (or refuses) it itself.
	mux.HandleFunc("/unchecked", func(w http.ResponseWriter, r *http.Request) {
		conn, err := permissive.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		serve(conn, WithUpgradeRequest(r))
	})
	hs := httptest.NewServer(mux)
	t.Cleanup(func() { srv.Stop(); hs.Close() })
	return srv, func(path string) string { return "ws" + strings.TrimPrefix(hs.URL, "http") + path }
}

// RemoteServer.Upgrader() admits per the configured connection admission
// (403 otherwise) — it used to fail open with a permissive origin check —
// and the admission verdict is reused by CreateSession, so the
// authenticator runs once per connection.
func TestDeviceUpgraderAdmitsOnBringYourOwnEndpoint(t *testing.T) {
	var auths atomic.Int32
	srv, url := byoServer(t, &auths)

	for _, tc := range []struct {
		name   string
		header http.Header
	}{
		{"foreign Origin", http.Header{"Origin": {"https://evil.example"}, "Authorization": {"Bearer test"}}},
		{"allowed Origin, authenticator refuses", http.Header{"Origin": {"https://app.example"}}},
		{"no Origin, no credentials", http.Header{}},
	} {
		conn, resp, err := dialDevice(t, url("/byo"), tc.header)
		if conn != nil {
			conn.Close()
		}
		if err == nil || resp == nil || resp.StatusCode != http.StatusForbidden {
			t.Fatalf("%s: upgrade %v (status %v), want 403", tc.name, err, resp)
		}
	}

	auths.Store(0)
	c := newDevClient(t, url("/byo"), nil)
	ack := c.hello(nil)
	if ack["device"] == nil {
		t.Fatalf("admitted BYO connection got no device plane: %v", ack)
	}
	if n := auths.Load(); n != 1 {
		t.Fatalf("authenticator ran %d times for one connection, want 1", n)
	}
	if n := srv.admitted.size(); n != 0 {
		t.Fatalf("%d admissions left after CreateSession consumed them", n)
	}
	c.dispatch("query", map[string]any{"permission": "camera"})
	req := c.waitRequest("permission.query")
	c.respond(req["id"], map[string]any{"status": "granted"})
	if !sessionFor(t, srv, ack["sessionId"]).DeviceEnabled() {
		t.Fatal("admitted session reports no device plane")
	}
}

// With admission configured, CreateSession refuses the device plane to a
// session whose upgrade was not admitted: a host that skipped admission,
// or that passes a request admission refuses, gets a UI-only session
// (fail closed).
func TestDeviceCreateSessionRefusesUnadmittedUpgrades(t *testing.T) {
	var auths atomic.Int32
	srv, url := byoServer(t, &auths)

	for _, tc := range []struct {
		name, path string
		header     http.Header
	}{
		{"no upgrade request (admission skipped)", "/rogue", http.Header{"Authorization": {"Bearer test"}}},
		{"foreign Origin passed on unchecked", "/unchecked", http.Header{"Origin": {"https://evil.example"}, "Authorization": {"Bearer test"}}},
		{"no credentials passed on unchecked", "/unchecked", http.Header{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := newDevClient(t, url(tc.path), tc.header)
			ack := c.hello(nil)
			if _, has := ack["device"]; has {
				t.Fatalf("unadmitted upgrade negotiated a device plane: %v", ack)
			}
			sess := sessionFor(t, srv, ack["sessionId"])
			if sess.DeviceEnabled() || planeOf(sess) != nil {
				t.Fatal("unadmitted session has a device plane")
			}
			// Handlers see an unavailable device; nothing reaches the client.
			c.dispatch("query", map[string]any{"permission": "camera"})
			c.noRequest(200 * time.Millisecond)
		})
	}

	// The unchecked endpoint still admits a request that passes D1 (the
	// authenticator runs in CreateSession then).
	auths.Store(0)
	c := newDevClient(t, url("/unchecked"), nil)
	if ack := c.hello(nil); ack["device"] == nil {
		t.Fatalf("admissible request refused on the unchecked endpoint: %v", ack)
	}
	if n := auths.Load(); n != 1 {
		t.Fatalf("authenticator ran %d times, want 1", n)
	}
}

// Listen's own handler admits before upgrading and reuses the verdict: the
// authenticator runs once per connection there too.
func TestDeviceBuiltInEndpointAuthenticatesOnce(t *testing.T) {
	var auths atomic.Int32
	s, _, _ := setupDev(t, nil, func(srv *RemoteServer) {
		srv.Authenticate(func(r *http.Request) bool {
			auths.Add(1)
			return r.Header.Get("Authorization") == "Bearer test"
		})
	})
	c := newDevClient(t, s.url, nil)
	if ack := c.hello(nil); ack["device"] == nil {
		t.Fatalf("no device plane: %v", ack)
	}
	if n := auths.Load(); n != 1 {
		t.Fatalf("authenticator ran %d times, want 1", n)
	}
	if n := s.srv.admitted.size(); n != 0 {
		t.Fatalf("%d admissions left over", n)
	}
}

// Each connection's broker runs in its own engine-module instance (the
// module is compiled once): a trap in one connection's instance resets
// that connection's device plane only; every other connection keeps
// working, and new connections still negotiate.
func TestDeviceTrapInOneConnectionLeavesOthersWorking(t *testing.T) {
	s, rec, _ := setupDev(t, nil)
	a := newDevClient(t, s.url, nil)
	ackA := a.hello(nil)
	b := newDevClient(t, s.url, nil)
	ackB := b.hello(nil)
	sessA, sessB := sessionFor(t, s.srv, ackA["sessionId"]), sessionFor(t, s.srv, ackB["sessionId"])
	devA, devB := planeOf(sessA), planeOf(sessB)
	if devA == nil || devB == nil {
		t.Fatal("both connections should have a device plane")
	}
	if devA.rt == devB.rt {
		t.Fatal("connections share one engine-module instance")
	}

	// B has a request in flight across A's trap.
	b.dispatch("pick", nil)
	pending := b.waitRequest("gallery.pick")

	if err := devA.rt.TrapForTesting(); err != nil {
		t.Fatal(err)
	}
	a.dispatch("query", map[string]any{"permission": "camera"})
	if o := rec.wait(t, "query"); !errors.Is(o.err, device.ErrInternal) {
		t.Fatalf("request on the trapped connection: %v", o.err)
	}
	if code, reason := a.waitClosed(); code != 1011 || !strings.Contains(reason, "device broker failure") {
		t.Fatalf("trapped connection closed %d %q, want 1011", code, reason)
	}

	// B is untouched: its pending request completes, new ones work.
	photo := bytes.Repeat([]byte{7, 8, 9}, 1000)
	id := pending["id"]
	b.event(id, map[string]any{"kind": "blobStart", "channel": 0, "contentType": "image/jpeg", "bytes": len(photo)})
	b.sendFrame(uint32(id.(float64)), 0, 0, photo)
	b.respond(id, map[string]any{"items": []any{map[string]any{
		"channel": 0, "contentType": "image/jpeg", "bytes": len(photo), "sha256": sha256Hex(photo),
	}}})
	if o := rec.wait(t, "pick"); o.err != nil {
		t.Fatalf("other connection's pick after the trap: %v", o.err)
	}
	b.dispatch("query", map[string]any{"permission": "microphone"})
	req := b.waitRequest("permission.query")
	b.respond(req["id"], map[string]any{"status": "denied"})
	if o := rec.wait(t, "query"); o.err != nil || o.value != device.PermissionDenied {
		t.Fatalf("other connection's query after the trap: %v %v", o.value, o.err)
	}
	if !sessB.DeviceEnabled() {
		t.Fatal("the other connection lost its device plane")
	}

	// A fresh connection negotiates and works.
	c := newDevClient(t, s.url, nil)
	if ack := c.hello(nil); ack["device"] == nil {
		t.Fatalf("new connection after a trap: %v", ack)
	}
	c.dispatch("query", map[string]any{"permission": "camera"})
	req = c.waitRequest("permission.query")
	c.respond(req["id"], map[string]any{"status": "granted"})
	if o := rec.wait(t, "query"); o.err != nil {
		t.Fatal(o.err)
	}
}

// The default aggregate budget is the engine's own default process budget
// (Rust's DEFAULT_PROCESS_RETAINED_BYTES), read from the broker's
// constants rather than restated in Go; an explicit budget wins, and
// reconfiguring with 0 goes back to the engine default.
func TestDeviceAggregateBudgetDefaultIsTheEngines(t *testing.T) {
	s, _, _ := setupDev(t, nil)
	c := newDevClient(t, s.url, nil)
	c.hello(nil)
	rt, err := helperRuntime()
	if err != nil {
		t.Fatal(err)
	}
	consts, err := rt.Constants()
	if err != nil {
		t.Fatal(err)
	}
	want, ok := consts["defaultProcessRetainedBytes"].(float64)
	if !ok || want < 1 {
		t.Fatalf("engine constants: defaultProcessRetainedBytes = %v", consts["defaultProcessRetainedBytes"])
	}
	agg := s.srv.device.agg
	if got := agg.Limit(); got != uint64(want) {
		t.Fatalf("default aggregate budget %d, engine default %v", got, want)
	}
	s.srv.ConfigureDevice(DeviceConfig{AggregateRetainedBytes: 12_345})
	if got := agg.Limit(); got != 12_345 {
		t.Fatalf("explicit aggregate budget %d", got)
	}
	s.srv.ConfigureDevice(DeviceConfig{})
	if got := agg.Limit(); got != uint64(want) {
		t.Fatalf("reconfigured default aggregate budget %d, engine default %v", got, want)
	}
}

// The server's aggregate retained-bytes budget spans connections although
// each broker lives in its own instance: bytes one connection retains
// count against every other, the request that pushes the total over is
// terminated (cancel to its client, throttled to its handler) and the
// others are unaffected; every byte returns when requests end.
func TestDeviceAggregateBudgetSpansConnections(t *testing.T) {
	s, rec, _ := setupDev(t, &DeviceConfig{AggregateRetainedBytes: 150_000})
	agg := s.srv.device.agg
	a := newDevClient(t, s.url, nil)
	a.hello(nil)
	b := newDevClient(t, s.url, nil)
	b.hello(nil)

	photo := bytes.Repeat([]byte{0x5A, 0x11}, 50_000) // 100 KB
	a.dispatch("pick", nil)
	reqA := a.waitRequest("gallery.pick")
	idA := reqA["id"]
	a.event(idA, map[string]any{"kind": "blobStart", "channel": 0, "contentType": "image/jpeg", "bytes": len(photo)})
	waitFor(t, "connection A's declaration to be reserved", func() bool { return agg.InUse() >= uint64(len(photo)) })

	b.dispatch("pick", nil)
	reqB := b.waitRequest("gallery.pick")
	idB := reqB["id"]
	b.event(idB, map[string]any{"kind": "blobStart", "channel": 0, "contentType": "image/jpeg", "bytes": len(photo)})
	b.waitControl(idB.(float64), "cancel")
	o := rec.wait(t, "pick")
	var de *device.Error
	if !errors.As(o.err, &de) || de.Code != device.CodeThrottled || !strings.Contains(de.Detail, "aggregate") {
		t.Fatalf("over-budget request: %v", o.err)
	}
	if in := agg.InUse(); in > agg.Limit() {
		t.Fatalf("aggregate left over budget: %d > %d", in, agg.Limit())
	}

	// A completes normally.
	a.sendFrame(uint32(idA.(float64)), 0, 0, photo[:65536])
	a.sendFrame(uint32(idA.(float64)), 0, 1, photo[65536:])
	a.respond(idA, map[string]any{"items": []any{map[string]any{
		"channel": 0, "contentType": "image/jpeg", "bytes": len(photo), "sha256": sha256Hex(photo),
	}}})
	if o := rec.wait(t, "pick"); o.err != nil {
		t.Fatalf("within-budget request: %v", o.err)
	}
	waitFor(t, "every retained byte to return", func() bool { return agg.InUse() == 0 })

	// With the budget free again B's next upload fits. B's handler lingers
	// after recording its outcome, so its result's charge outlives rec.wait.
	b.dispatch("pickLinger", nil)
	reqB = b.waitRequest("gallery.pick")
	idB = reqB["id"]
	b.event(idB, map[string]any{"kind": "blobStart", "channel": 0, "contentType": "image/jpeg", "bytes": len(photo)})
	b.sendFrame(uint32(idB.(float64)), 0, 0, photo[:65536])
	b.sendFrame(uint32(idB.(float64)), 0, 1, photo[65536:])
	b.respond(idB, map[string]any{"items": []any{map[string]any{
		"channel": 0, "contentType": "image/jpeg", "bytes": len(photo), "sha256": sha256Hex(photo),
	}}})
	if o := rec.wait(t, "pickLinger"); o.err != nil {
		t.Fatalf("after the budget freed: %v", o.err)
	}
	// The handler records its outcome before it returns, and B's result
	// keeps its charge until the handler returns (the held-result scope),
	// so rec.wait observes the outcome while B's 100 KB is still reserved.
	// Wait for the release, or A's next 100 KB below would total 200 KB
	// against the 150 KB budget and be throttled.
	waitFor(t, "B's held result to be released", func() bool { return agg.InUse() == 0 })

	// A connection that goes away returns its share.
	a.dispatch("pick", nil)
	reqA = a.waitRequest("gallery.pick")
	a.event(reqA["id"], map[string]any{"kind": "blobStart", "channel": 0, "contentType": "image/jpeg", "bytes": len(photo)})
	waitFor(t, "the new declaration to be reserved", func() bool { return agg.InUse() >= uint64(len(photo)) })
	a.conn.Close()
	if o := rec.wait(t, "pick"); !errors.Is(o.err, device.ErrConnectionLost) {
		t.Fatalf("after disconnect: %v", o.err)
	}
	waitFor(t, "the closed connection's bytes to return", func() bool { return agg.InUse() == 0 })
}

// A unary upload result keeps its retained-bytes charge while the handler
// that received it runs (it still holds the bytes) and releases it when
// the handler returns — the TypeScript holdResult/release_result scope.
func TestDeviceHeldResultChargeLastsUntilTheHandlerReturns(t *testing.T) {
	core.App.Clear()
	t.Cleanup(func() { core.App.Clear() })
	got := make(chan int, 1)
	release := make(chan struct{})
	finished := make(chan struct{}, 1)
	def := core.NewApp(devState{}).Name("App").
		OnAction("holdpick", func(ctx core.TypedActionContext[devState]) {
			items, err := ctx.Device().Gallery().Pick(context.Background(), device.GalleryPickParams{
				MediaTypes: []device.MediaType{device.MediaTypePhoto}, MaxCount: 1,
			})
			if err != nil {
				got <- -1
				return
			}
			got <- len(items[0].Bytes)
			<-release
			finished <- struct{}{}
		}).
		Build()
	s := newDevServer(t, &DeviceConfig{}, def, devUI, nil)
	c := newDevClient(t, s.url, nil)
	ack := c.hello(nil)
	sess := sessionFor(t, s.srv, ack["sessionId"])
	retained := func() float64 {
		info, err := sess.deviceInfo()
		if err != nil {
			t.Fatal(err)
		}
		return info["retainedBytes"].(float64)
	}

	photo := bytes.Repeat([]byte{1, 2, 3, 4}, 20_000) // 80 KB
	c.dispatch("holdpick", nil)
	req := c.waitRequest("gallery.pick")
	id := req["id"]
	c.event(id, map[string]any{"kind": "blobStart", "channel": 0, "contentType": "image/jpeg", "bytes": len(photo)})
	c.sendFrame(uint32(id.(float64)), 0, 0, photo[:65536])
	c.sendFrame(uint32(id.(float64)), 0, 1, photo[65536:])
	c.respond(id, map[string]any{"items": []any{map[string]any{
		"channel": 0, "contentType": "image/jpeg", "bytes": len(photo), "sha256": sha256Hex(photo),
	}}})
	if n := <-got; n != len(photo) {
		t.Fatalf("handler got %d bytes", n)
	}
	if r := retained(); r < float64(len(photo)) {
		t.Fatalf("retained %v bytes while the handler still holds the result, want >= %d", r, len(photo))
	}
	if in := s.srv.device.agg.InUse(); in < uint64(len(photo)) {
		t.Fatalf("aggregate %d while the result is held", in)
	}
	close(release)
	<-finished
	waitFor(t, "the held charge to be released", func() bool { return retained() == 0 && s.srv.device.agg.InUse() == 0 })
}

func waitFor(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if ok() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}
