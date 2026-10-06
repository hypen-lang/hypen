package remote

// Device plane (RFC 001) on the Go remote server, end to end over real
// WebSockets against the Rust broker: admission, handshake, resume tokens,
// the handler API for every data plane, cancellation, the replay firewall,
// module lifecycle sweeps and dispatch-slot yielding.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	core "github.com/hypen-space/core"
	"github.com/hypen-space/core/device"
)

type devState struct {
	Status string `json:"status"`
	Count  int    `json:"count"`
}

const devUI = `module App {
	Text("status: @{state.status} count: @{state.count}")
}`

// devApp is the primary module used by these tests; every handler records
// its outcome in rec.
func devApp(rec *recorder, cancelCh <-chan struct{}) *core.ModuleDefinition {
	bg := context.Background()
	return core.NewApp(devState{}).
		Name("App").
		OnAction("query", func(ctx core.TypedActionContext[devState]) {
			p, _ := ctx.Action.Payload.(map[string]any)
			perm, _ := p["permission"].(string)
			st, err := ctx.Device().Permissions().Query(bg, device.Permission(perm))
			ctx.State.Status = string(st)
			rec.put("query", st, err)
		}).
		OnAction("request", func(ctx core.TypedActionContext[devState]) {
			st, err := ctx.Device().Permissions().Request(bg, device.PermissionNotifications)
			rec.put("request", st, err)
		}).
		OnAction("pick", func(ctx core.TypedActionContext[devState]) {
			items, err := ctx.Device().Gallery().Pick(bg, device.GalleryPickParams{
				MediaTypes: []device.MediaType{device.MediaTypePhoto}, MaxCount: 1,
			})
			rec.put("pick", items, err)
		}).
		OnAction("pickLinger", func(ctx core.TypedActionContext[devState]) {
			// Like pick, but the handler keeps running (and so keeps its
			// result's retained-bytes charge) for a while after recording
			// its outcome: tests use it to hold open the window in which
			// rec.wait has returned but the charge is not yet released.
			items, err := ctx.Device().Gallery().Pick(bg, device.GalleryPickParams{
				MediaTypes: []device.MediaType{device.MediaTypePhoto}, MaxCount: 1,
			})
			rec.put("pickLinger", items, err)
			time.Sleep(150 * time.Millisecond)
		}).
		OnAction("save", func(ctx core.TypedActionContext[devState]) {
			data := bytes.Repeat([]byte("hypen-saved "), 12000) // > one 64 KiB frame
			res, err := ctx.Device().Save(bg, "report.txt", "text/plain", data)
			rec.put("save", res, err)
		}).
		OnAction("scan", func(ctx core.TypedActionContext[devState]) {
			var seen []device.BluetoothDevice
			err := ctx.Device().Bluetooth().Scan(bg, func(d device.BluetoothDevice) error {
				seen = append(seen, d)
				if len(seen) == 2 {
					return device.ErrStop
				}
				return nil
			})
			rec.put("scan", seen, err)
		}).
		OnAction("record", func(ctx core.TypedActionContext[devState]) {
			var got []byte
			res, err := ctx.Device().Mic().Record(bg, device.MicRecordParams{SampleRate: 16000}, func(chunk []byte) error {
				got = append(got, chunk...)
				return nil
			})
			rec.put("record", [2]any{got, res}, err)
		}).
		OnAction("timeout", func(ctx core.TypedActionContext[devState]) {
			c, cancel := context.WithTimeout(bg, 300*time.Millisecond)
			defer cancel()
			_, err := ctx.Device().Permissions().Request(c, device.PermissionCamera)
			rec.put("timeout", nil, err)
		}).
		OnAction("cancelme", func(ctx core.TypedActionContext[devState]) {
			c, cancel := context.WithCancel(bg)
			defer cancel()
			go func() {
				select {
				case <-cancelCh:
					cancel()
				case <-c.Done():
				}
			}()
			_, err := ctx.Device().Gallery().Pick(c, device.GalleryPickParams{
				MediaTypes: []device.MediaType{device.MediaTypePhoto}, MaxCount: 1,
			})
			rec.put("cancelme", nil, err)
		}).
		OnAction("supports", func(ctx core.TypedActionContext[devState]) {
			d := ctx.Device()
			v, ok := d.Version("gallery.pick")
			rec.put("supports", []any{d.Supports("gallery.pick"), d.Supports("nope.cap"), v, ok, d.Replayed()}, nil)
		}).
		OnAction("badParams", func(ctx core.TypedActionContext[devState]) {
			// Typed params the SDK does not validate: the Rust broker
			// refuses each at open (nothing is sent).
			d := ctx.Device()
			var errs []error
			_, err := d.Gallery().Pick(bg, device.GalleryPickParams{MediaTypes: []device.MediaType{device.MediaTypePhoto}, MaxCount: 17})
			errs = append(errs, err)
			_, err = d.Gallery().Pick(bg, device.GalleryPickParams{})
			errs = append(errs, err)
			d10 := uint64(10)
			_, err = d.Camera().Capture(bg, device.CameraCaptureParams{Mode: device.CaptureModePhoto, MaxDurationMs: &d10})
			errs = append(errs, err)
			_, err = d.Bluetooth().Select(bg, device.BluetoothSelectParams{Services: []string{"180D"}})
			errs = append(errs, err)
			_, err = d.Mic().Record(bg, device.MicRecordParams{SampleRate: 7999}, nil)
			errs = append(errs, err)
			_, err = d.Files().Pick(bg, device.FilePickParams{Accept: []string{strings.Repeat("a", 129)}, MaxCount: 1})
			errs = append(errs, err)
			rec.put("badParams", errs, nil)
		}).
		OnAction("bump", func(ctx core.TypedActionContext[devState]) {
			ctx.State.Count++
			rec.put("bump", ctx.State.Count, nil)
		}).
		OnAction("waitThenStatus", func(ctx core.TypedActionContext[devState]) {
			st, err := ctx.Device().Permissions().Query(bg, device.PermissionCamera)
			ctx.State.Status = "after-wait:" + string(st)
			rec.put("waitThenStatus", st, err)
		}).
		Build()
}

// setupDev serves the device app with the device plane on (the default;
// cfg nil = default options) and setup applied (e.g. admission).
func setupDev(t *testing.T, cfg *DeviceConfig, setup ...func(*RemoteServer)) (*devServer, *recorder, chan struct{}) {
	t.Helper()
	core.App.Clear()
	t.Cleanup(func() { core.App.Clear() })
	rec := newRecorder()
	cancelCh := make(chan struct{})
	if cfg == nil {
		cfg = &DeviceConfig{}
	}
	return newDevServer(t, cfg, devApp(rec, cancelCh), devUI, nil, setup...), rec, cancelCh
}

func deviceErrCode(err error) device.Code { return device.CodeOf(err) }

// ---- connection admission (RFC 001 §5) and compression -------------------------------

func TestDeviceAdmission(t *testing.T) {
	s, _, _ := setupDev(t, nil, func(srv *RemoteServer) {
		srv.AllowedOrigins("https://app.example").
			Authenticate(func(r *http.Request) bool {
				// Browsers (allowed Origin) carry a cookie; natives a bearer.
				return r.Header.Get("Authorization") == "Bearer test" || r.Header.Get("Cookie") == "sid=ok"
			})
	})
	cases := []struct {
		name   string
		header http.Header
		want   int
	}{
		{"foreign Origin is refused", http.Header{"Origin": {"https://evil.example"}, "Cookie": {"sid=ok"}}, http.StatusForbidden},
		{"allowed Origin still runs the authenticator", http.Header{"Origin": {"https://app.example"}}, http.StatusForbidden},
		{"allowed Origin + authenticated", http.Header{"Origin": {"https://app.example"}, "Cookie": {"sid=ok"}}, http.StatusSwitchingProtocols},
		{"native without credentials", http.Header{}, http.StatusForbidden},
		{"native with credentials", http.Header{"Authorization": {"Bearer test"}}, http.StatusSwitchingProtocols},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			conn, resp, err := dialDevice(t, s.url, tc.header)
			if resp == nil {
				t.Fatalf("no HTTP response: %v", err)
			}
			if resp.StatusCode != tc.want {
				t.Fatalf("status %d, want %d", resp.StatusCode, tc.want)
			}
			if conn != nil {
				conn.Close()
			}
		})
	}
}

// Each admission check applies exactly when it is configured, independent
// of the device plane: an allowlist alone admits allowed browser Origins
// only (an Origin-less native request needs an authenticator, as in every
// other SDK); an authenticator alone runs for every
// request; with neither, every upgrade is admitted.
func TestAdmissionChecksApplyWhenConfigured(t *testing.T) {
	core.App.Clear()
	t.Cleanup(func() { core.App.Clear() })
	req := func(origin, auth string) *http.Request {
		r, _ := http.NewRequest("GET", "http://x/ws", nil)
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		if auth != "" {
			r.Header.Set("Authorization", auth)
		}
		return r
	}
	type tc struct {
		origin, auth string
		want         bool
	}
	check := func(name string, srv *RemoteServer, cases []tc) {
		t.Helper()
		for _, c := range cases {
			if got := srv.Admit(req(c.origin, c.auth)); got != c.want {
				t.Errorf("%s: Admit(Origin %q, auth %q) = %v, want %v", name, c.origin, c.auth, got, c.want)
			}
		}
	}
	check("allowlist only", NewRemoteServer().AllowedOrigins("https://app.example"), []tc{
		{"", "", false}, {"https://app.example", "", true}, {"https://APP.example", "", false}, {"https://evil.example", "", false},
	})
	bearer := func(r *http.Request) bool { return r.Header.Get("Authorization") == "Bearer ok" }
	check("authenticator only", NewRemoteServer().Authenticate(bearer), []tc{
		{"", "", false}, {"", "Bearer ok", true}, {"https://any.example", "Bearer ok", true}, {"https://any.example", "", false},
	})
	check("neither (default)", NewRemoteServer(), []tc{
		{"", "", true}, {"https://evil.example", "", true},
	})
	// Admission is not tied to the device plane: DisableDevice keeps it.
	check("allowlist, device off", NewRemoteServer().AllowedOrigins("https://app.example").DisableDevice(), []tc{
		{"https://evil.example", "", false}, {"https://app.example", "", true},
	})
}

// With no admission configured the server runs, admits every client, and
// logs ONE startup warning; the device plane is negotiated with no enable
// call. With admission configured there is no such warning.
func TestDeviceNoAdmissionAdmitsWithOneWarning(t *testing.T) {
	s, _, _ := setupDev(t, nil)
	for i := 0; i < 3; i++ {
		c := newDevClient(t, s.url, http.Header{"Origin": {"https://anything.example"}})
		if ack := c.hello(nil); ack["device"] == nil {
			t.Fatalf("no device plane without admission config: %v", ack)
		}
	}
	s.srv.mu.RLock()
	warnings := append([]string(nil), s.srv.startupWarnings...)
	s.srv.mu.RUnlock()
	if len(warnings) != 1 || warnings[0] != warnNoAdmission {
		t.Fatalf("startup warnings = %q, want exactly [%q]", warnings, warnNoAdmission)
	}

	configured, _, _ := setupDev(t, nil, func(srv *RemoteServer) {
		srv.Authenticate(func(r *http.Request) bool { return r.Header.Get("Authorization") == "Bearer test" })
	})
	c := newDevClient(t, configured.url, nil)
	c.hello(nil)
	configured.srv.mu.RLock()
	defer configured.srv.mu.RUnlock()
	if len(configured.srv.startupWarnings) != 0 {
		t.Fatalf("startup warnings with admission configured = %q", configured.srv.startupWarnings)
	}
}

// The device plane needs no call: a plain server (no ConfigureDevice, no
// admission) negotiates it for a hello offering `device`, with the
// default options.
func TestDeviceNegotiatedWithoutAnyEnableCall(t *testing.T) {
	core.App.Clear()
	t.Cleanup(func() { core.App.Clear() })
	rec := newRecorder()
	srv := NewRemoteServer().WithDefinition(devApp(rec, nil)).Source(t.TempDir()).UI(devUI)
	if !srv.DeviceEnabled() || !srv.CompressionEnabled() {
		t.Fatalf("defaults: DeviceEnabled %v CompressionEnabled %v", srv.DeviceEnabled(), srv.CompressionEnabled())
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", srv.handleWebSocket)
	hs := httptest.NewServer(mux)
	t.Cleanup(func() { srv.Stop(); hs.Close() })
	c := newDevClient(t, "ws"+strings.TrimPrefix(hs.URL, "http")+"/ws", http.Header{})
	ack := c.hello(nil)
	if ack["device"] == nil || ack["resumeToken"] == nil {
		t.Fatalf("plain server ack = %v", ack)
	}
	c.dispatch("query", map[string]any{"permission": "camera"})
	req := c.waitRequest("permission.query")
	c.respond(req["id"], map[string]any{"status": "granted"})
	if o := rec.wait(t, "query"); o.err != nil || o.value != device.PermissionGranted {
		t.Fatalf("query = %v %v", o.value, o.err)
	}
}

// DisableDevice is the single opt-out: the server behaves like a UI-only
// server — no device in the ack, no resume token, handlers see
// device-disabled. Compression is offered either way.
func TestDeviceDisableOptOut(t *testing.T) {
	core.App.Clear()
	t.Cleanup(func() { core.App.Clear() })
	rec := newRecorder()
	s := newDevServer(t, nil, devApp(rec, nil), devUI, nil) // nil cfg = DisableDevice
	if s.srv.DeviceEnabled() || !s.srv.CompressionEnabled() || !s.srv.Upgrader().EnableCompression {
		t.Fatal("DisableDevice: want device off and compression offered")
	}
	d := websocket.Dialer{EnableCompression: true, HandshakeTimeout: 5 * time.Second}
	conn, resp, err := d.Dial(s.url, nil)
	if err != nil {
		t.Fatal(err)
	}
	conn.Close()
	if ext := resp.Header.Get("Sec-WebSocket-Extensions"); !strings.Contains(ext, "permessage-deflate") {
		t.Fatalf("device-off server did not negotiate compression: %q", ext)
	}
	c := newDevClient(t, s.url, nil)
	ack := c.hello(nil)
	if _, has := ack["device"]; has || ack["resumeToken"] != nil {
		t.Fatalf("disabled server ack = %v", ack)
	}
	c.dispatch("query", map[string]any{"permission": "camera"})
	o := rec.wait(t, "query")
	var de *device.Error
	if !errors.As(o.err, &de) || de.Code != device.CodeUnavailable || de.Detail != "device-disabled" {
		t.Fatalf("disabled server device call: %v", o.err)
	}
	c.noRequest(100 * time.Millisecond)
}

// A setting incompatible with the device plane (a session config letting
// several connections share a session) never stops the server: it runs
// with the device plane off and ONE startup warning names the setting.
func TestDeviceIncompatibleSettingTurnsPlaneOffWithWarning(t *testing.T) {
	s, _, _ := setupDev(t, nil, func(srv *RemoteServer) {
		srv.sessionManager = core.NewSessionManager(&core.SessionConfig{Concurrent: core.ConcurrentAllowMultiple})
		srv.Authenticate(func(*http.Request) bool { return true })
	})
	if s.srv.DeviceEnabled() || !s.srv.CompressionEnabled() {
		t.Fatal("allow-multiple: want device off and compression offered")
	}
	c := newDevClient(t, s.url, nil)
	ack := c.hello(nil)
	if _, has := ack["device"]; has {
		t.Fatalf("allow-multiple server negotiated device: %v", ack)
	}
	s.srv.mu.RLock()
	defer s.srv.mu.RUnlock()
	if len(s.srv.startupWarnings) != 1 || s.srv.startupWarnings[0] != warnDeviceAllowMultiple {
		t.Fatalf("startup warnings = %q", s.srv.startupWarnings)
	}
}

// extensionRewriter rewrites the Sec-WebSocket-Extensions offer of the
// handshake request gorilla's Dialer writes (the Dialer refuses a custom
// header for it), so a test can send an arbitrary offer.
type extensionRewriter struct {
	net.Conn
	from, to []byte
	done     *atomic.Bool
}

func (c extensionRewriter) Write(p []byte) (int, error) {
	if !c.done.Load() && bytes.Contains(p, c.from) {
		c.done.Store(true)
		if _, err := c.Conn.Write(bytes.Replace(p, c.from, c.to, 1)); err != nil {
			return 0, err
		}
		return len(p), nil
	}
	return c.Conn.Write(p)
}

// Compression is on by default with the device plane on (and vice versa):
// a device-capable client offering `permessage-deflate;
// client_max_window_bits` (what browsers send) gets an answer carrying
// both server_no_context_takeover and client_no_context_takeover — every
// message compressed on its own — and still negotiates the device plane
// and runs device work over the compressed socket.
func TestDeviceServerCompressesWithoutContextTakeover(t *testing.T) {
	s, rec, _ := setupDev(t, nil)
	s.srv.Config(ServerConfig{Port: 1}) // a config silent on compression keeps it on
	if !s.srv.DeviceEnabled() || !s.srv.CompressionEnabled() || !s.srv.Upgrader().EnableCompression {
		t.Fatalf("defaults: DeviceEnabled %v CompressionEnabled %v", s.srv.DeviceEnabled(), s.srv.CompressionEnabled())
	}
	var rewritten atomic.Bool
	d := websocket.Dialer{
		EnableCompression: true,
		HandshakeTimeout:  5 * time.Second,
		NetDialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			conn, err := (&net.Dialer{}).DialContext(ctx, network, addr)
			if err != nil {
				return nil, err
			}
			return extensionRewriter{
				Conn: conn,
				from: []byte("Sec-WebSocket-Extensions: permessage-deflate; server_no_context_takeover; client_no_context_takeover\r\n"),
				to:   []byte("Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits\r\n"),
				done: &rewritten,
			}, nil
		},
	}
	conn, resp, err := d.Dial(s.url, http.Header{"Authorization": {"Bearer test"}})
	if err != nil {
		t.Fatal(err)
	}
	if !rewritten.Load() {
		t.Fatal("the handshake offer was not rewritten")
	}
	ext := resp.Header.Get("Sec-WebSocket-Extensions")
	params := map[string]bool{}
	for _, p := range strings.Split(ext, ";") {
		params[strings.TrimSpace(p)] = true
	}
	if !params["permessage-deflate"] || !params["server_no_context_takeover"] || !params["client_no_context_takeover"] {
		t.Fatalf("negotiated extension %q: want permessage-deflate with server_no_context_takeover and client_no_context_takeover", ext)
	}
	c := wrapDevClient(t, conn)
	ack := c.hello(nil)
	if ack["device"] == nil || ack["resumeToken"] == nil {
		t.Fatalf("compressed device-capable connection ack = %v", ack)
	}
	c.dispatch("query", map[string]any{"permission": "camera"})
	req := c.waitRequest("permission.query")
	c.respond(req["id"], map[string]any{"status": "granted"})
	if o := rec.wait(t, "query"); o.err != nil || o.value != device.PermissionGranted {
		t.Fatalf("query over a compressed socket = %v %v", o.value, o.err)
	}
}

// DisableCompression still turns compression off with the device plane on.
func TestDeviceServerDisableCompression(t *testing.T) {
	s, _, _ := setupDev(t, nil, func(srv *RemoteServer) { srv.DisableCompression() })
	if !s.srv.DeviceEnabled() || s.srv.CompressionEnabled() || s.srv.Upgrader().EnableCompression {
		t.Fatal("DisableCompression: want device on and compression off")
	}
	d := websocket.Dialer{EnableCompression: true, HandshakeTimeout: 5 * time.Second}
	conn, resp, err := d.Dial(s.url, http.Header{"Authorization": {"Bearer test"}})
	if err != nil {
		t.Fatal(err)
	}
	if ext := resp.Header.Get("Sec-WebSocket-Extensions"); strings.Contains(ext, "permessage-deflate") {
		t.Fatalf("compression negotiated after DisableCompression: %q", ext)
	}
	if ack := wrapDevClient(t, conn).hello(nil); ack["device"] == nil {
		t.Fatalf("uncompressed device-capable connection ack = %v", ack)
	}
}

// ---- handshake -----------------------------------------------------------------------

func TestDeviceHandshakeOpensCoreCapabilitiesBeforeInitialTree(t *testing.T) {
	s, _, _ := setupDev(t, nil)
	c := newDevClient(t, s.url, nil)
	c.send(deviceHelloMsg(nil))
	ack := c.waitAck()
	dev, ok := ack["device"].(map[string]any)
	if !ok {
		t.Fatalf("sessionAck without device: %v", ack)
	}
	if dev["protocolVersion"].(float64) != 1 || dev["binary"] != true {
		t.Fatalf("ack.device = %v", dev)
	}
	caps := map[string]bool{}
	for _, c := range dev["capabilities"].([]any) {
		caps[c.(map[string]any)["name"].(string)] = true
	}
	for _, want := range []string{"core.capabilities", "gallery.pick", "file.save", "mic.record", "camera.capture", "bluetooth.select", "bluetooth.scan", "permission.query"} {
		if !caps[want] {
			t.Errorf("capability %s not selected", want)
		}
	}
	tok, _ := ack["resumeToken"].(string)
	if len(tok) < 22 { // ≥ 128 bits base64url
		t.Fatalf("resume token %q too short", tok)
	}
	c.waitUI("initialTree")
	c.mu.Lock()
	core := c.coreID
	c.mu.Unlock()
	if core == 0 {
		t.Fatal("core.capabilities was not opened")
	}
}

func TestDeviceHandshakeInvalidHelloDisablesDevice(t *testing.T) {
	s, rec, _ := setupDev(t, nil)
	for name, hello := range map[string]string{
		"unknown member":    `{"type":"hello","device":{"protocolVersions":[1],"binary":true,"capabilities":[],"extra":1}}`,
		"duplicate device":  `{"type":"hello","device":{"protocolVersions":[1],"binary":true,"capabilities":[{"name":"core.capabilities","versions":[1]}]},"device":{"protocolVersions":[1],"binary":true,"capabilities":[{"name":"core.capabilities","versions":[1]}]}}`,
		"no common version": `{"type":"hello","device":{"protocolVersions":[9],"binary":true,"capabilities":[{"name":"core.capabilities","versions":[1]}]}}`,
		"duplicate names":   `{"type":"hello","device":{"protocolVersions":[1],"binary":true,"capabilities":[{"name":"core.capabilities","versions":[1]},{"name":"core.capabilities","versions":[1]}]}}`,
	} {
		t.Run(name, func(t *testing.T) {
			c := newDevClient(t, s.url, nil)
			c.sendRaw([]byte(hello))
			ack := c.waitAck()
			if _, has := ack["device"]; has {
				t.Fatalf("device selected for an invalid hello: %v", ack)
			}
			if ack["resumeToken"] == nil {
				t.Fatal("device-enabled host must still issue a resume token")
			}
			c.waitUI("initialTree")
			// UI continues; handlers see an unavailable device plane.
			c.dispatch("query", map[string]any{"permission": "camera"})
			o := rec.wait(t, "query")
			if deviceErrCode(o.err) != device.CodeUnavailable {
				t.Fatalf("err = %v, want unavailable", o.err)
			}
		})
	}
}

// The device plane being on does not remove the legacy hello grace: a
// client that never sends hello is initialised after the grace (1 s) as a
// UI-only session — no device in its ack, handlers see an unavailable
// device — and the connection stays open.
func TestDeviceServerKeepsHelloGraceForLegacyClients(t *testing.T) {
	s, rec, _ := setupDev(t, nil)
	c := newDevClient(t, s.url, nil)
	ack := c.waitAck()
	if _, has := ack["device"]; has {
		t.Fatalf("grace-initialised session got a device plane: %v", ack)
	}
	if ack["isNew"] != true {
		t.Fatalf("grace ack = %v", ack)
	}
	c.waitUI("initialTree")
	sess := sessionFor(t, s.srv, ack["sessionId"])
	if sess.DeviceEnabled() || planeOf(sess) != nil {
		t.Fatal("grace-initialised session has a device plane")
	}
	c.dispatch("query", map[string]any{"permission": "camera"})
	o := rec.wait(t, "query")
	var de *device.Error
	if !errors.As(o.err, &de) || de.Code != device.CodeUnavailable || de.Detail != "device-disabled" {
		t.Fatalf("grace session device call: %v", o.err)
	}
	c.noRequest(100 * time.Millisecond)
	select {
	case <-c.closed:
		t.Fatal("legacy connection closed")
	default:
	}
}

func TestDeviceDispatchBeforeHelloIsRejected(t *testing.T) {
	s, rec, _ := setupDev(t, nil)
	c := newDevClient(t, s.url, nil)
	c.dispatch("bump", nil)
	time.Sleep(200 * time.Millisecond)
	c.hello(nil)
	select {
	case o := <-rec.ch:
		t.Fatalf("pre-hello dispatch ran: %+v", o)
	case <-time.After(300 * time.Millisecond):
	}
}

// ---- resume tokens -------------------------------------------------------------------

func TestDeviceResumeRequiresTheCurrentToken(t *testing.T) {
	s, _, _ := setupDev(t, nil)
	c1 := newDevClient(t, s.url, nil)
	ack1 := c1.hello(nil)
	sid, tok1 := ack1["sessionId"].(string), ack1["resumeToken"].(string)
	c1.conn.Close()
	waitSuspended(t, s.srv, sid)

	// The public id alone never resumes: a new session.
	c2 := newDevClient(t, s.url, nil)
	ack2 := c2.hello(map[string]any{"sessionId": sid, "resumeToken": "not-the-token"})
	if ack2["sessionId"] == sid || ack2["isNew"] != true {
		t.Fatalf("resumed without the token: %v", ack2)
	}
	c2.conn.Close()

	// The right token resumes, and a fresh token replaces it.
	c3 := newDevClient(t, s.url, nil)
	ack3 := c3.hello(map[string]any{"sessionId": sid, "resumeToken": tok1})
	if ack3["sessionId"] != sid || ack3["isRestored"] != true {
		t.Fatalf("valid token did not resume: %v", ack3)
	}
	if ack3["resumeToken"] == tok1 || ack3["resumeToken"] == "" {
		t.Fatal("resume token was not rotated")
	}
	if _, ok := ack3["device"]; !ok {
		t.Fatal("resumed connection must negotiate its own device plane")
	}
	c3.conn.Close()
	waitSuspended(t, s.srv, sid)

	// The rotated-out token no longer works.
	c4 := newDevClient(t, s.url, nil)
	ack4 := c4.hello(map[string]any{"sessionId": sid, "resumeToken": tok1})
	if ack4["sessionId"] == sid {
		t.Fatal("a revoked resume token still resumed the session")
	}
}

// The token is required only to resume a session that negotiated a device
// plane. A UI-only session on the same (device-on) server — a legacy
// client whose hello offers no `device` — still gets a token in its ack
// but keeps the legacy id-only resume.
func TestResumeTokenRequiredOnlyForDeviceSessions(t *testing.T) {
	s, _, _ := setupDev(t, nil)

	// Legacy UI-only session: id alone resumes it.
	legacy := newDevClient(t, s.url, nil)
	legacy.send(map[string]any{"type": "hello"})
	ack := legacy.waitAck()
	if _, has := ack["device"]; has {
		t.Fatalf("hello without device negotiated one: %v", ack)
	}
	if tok, _ := ack["resumeToken"].(string); tok == "" {
		t.Fatalf("device-on server must always issue a resume token: %v", ack)
	}
	sid := ack["sessionId"].(string)
	legacy.waitUI("initialTree")
	legacy.conn.Close()
	waitSuspended(t, s.srv, sid)
	again := newDevClient(t, s.url, nil)
	again.send(map[string]any{"type": "hello", "sessionId": sid})
	if re := again.waitAck(); re["sessionId"] != sid || re["isRestored"] != true {
		t.Fatalf("legacy id-only resume refused: %v", re)
	}
	again.conn.Close()
	waitSuspended(t, s.srv, sid)

	// Device session: id alone starts a NEW session.
	dev := newDevClient(t, s.url, nil)
	dack := dev.hello(nil)
	if dack["device"] == nil {
		t.Fatalf("no device plane: %v", dack)
	}
	dsid := dack["sessionId"].(string)
	dev.conn.Close()
	waitSuspended(t, s.srv, dsid)
	// Even a resume attempt without device in the hello needs the token.
	idOnly := newDevClient(t, s.url, nil)
	idOnly.send(map[string]any{"type": "hello", "sessionId": dsid})
	if re := idOnly.waitAck(); re["sessionId"] == dsid || re["isNew"] != true {
		t.Fatalf("device session resumed by id alone: %v", re)
	}
	withToken := newDevClient(t, s.url, nil)
	if re := withToken.hello(map[string]any{"sessionId": dsid, "resumeToken": dack["resumeToken"]}); re["sessionId"] != dsid || re["isRestored"] != true {
		t.Fatalf("device session with its token not resumed: %v", re)
	}
}

func waitSuspended(t *testing.T, srv *RemoteServer, sid string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if srv.sessionManager.GetActiveSession(sid) == nil {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("session %s never suspended", sid)
}

// ---- handler API ---------------------------------------------------------------------

func TestDevicePermissionQueryTypedAndDenied(t *testing.T) {
	s, rec, _ := setupDev(t, nil)
	c := newDevClient(t, s.url, nil)
	c.hello(nil)

	c.dispatch("query", map[string]any{"permission": "camera"})
	req := c.waitRequest("permission.query")
	if req["params"].(map[string]any)["permission"] != "camera" {
		t.Fatalf("params = %v", req["params"])
	}
	owner := req["owner"].(map[string]any)
	if !strings.HasPrefix(owner["moduleInstanceId"].(string), "app@") || owner["activationId"].(float64) != 1 {
		t.Fatalf("owner = %v", owner)
	}
	if req["lifetime"] != "activation" {
		t.Fatalf("lifetime = %v", req["lifetime"])
	}
	c.respond(req["id"], map[string]any{"status": "granted"})
	o := rec.wait(t, "query")
	if o.err != nil || o.value != device.PermissionGranted {
		t.Fatalf("query = %v, %v", o.value, o.err)
	}
	st := c.waitState(func(st map[string]any) bool { return st["status"] == "granted" })
	_ = st

	// A permission outside the closed enum never reaches the wire.
	c.dispatch("query", map[string]any{"permission": "camra"})
	o = rec.wait(t, "query")
	if deviceErrCode(o.err) != device.CodeInvalidParams {
		t.Fatalf("typo: %v", o.err)
	}
	c.noRequest(150 * time.Millisecond)

	// Denial is an ordinary value.
	c.dispatch("request", nil)
	req = c.waitRequest("permission.request")
	c.respondErr(req["id"], "denied", "user-declined")
	o = rec.wait(t, "request")
	if !errors.Is(o.err, device.ErrDenied) {
		t.Fatalf("denied: %v", o.err)
	}
}

// The SDK has no params validator of its own: every typed helper encodes
// its params and the Rust broker refuses invalid ones at open, locally, as
// invalidParams naming the JSON path — nothing reaches the wire.
func TestDeviceInvalidTypedParamsRefusedByBroker(t *testing.T) {
	s, rec, _ := setupDev(t, nil)
	c := newDevClient(t, s.url, nil)
	c.hello(nil)
	c.dispatch("badParams", nil)
	o := rec.wait(t, "badParams")
	errs := o.value.([]error)
	if len(errs) != 6 {
		t.Fatalf("errs = %v", errs)
	}
	for i, err := range errs {
		var de *device.Error
		if !errors.As(err, &de) || de.Code != device.CodeInvalidParams || !strings.HasPrefix(de.Detail, "params") {
			t.Errorf("call %d: want a broker invalidParams refusal naming the params path, got %v", i, err)
		}
	}
	c.noRequest(150 * time.Millisecond)
}

func TestDeviceGalleryPickVerifiesBytes(t *testing.T) {
	s, rec, _ := setupDev(t, nil)
	c := newDevClient(t, s.url, nil)
	c.hello(nil)
	photo := bytes.Repeat([]byte{0xAB, 0xCD, 0x01}, 30000) // 90 KB: two frames

	c.dispatch("pick", nil)
	req := c.waitRequest("gallery.pick")
	id := req["id"]
	idU := uint32(id.(float64))
	c.event(id, map[string]any{"kind": "blobStart", "channel": 0, "contentType": "image/jpeg", "bytes": len(photo)})
	c.sendFrame(idU, 0, 0, photo[:65536])
	c.sendFrame(idU, 0, 1, photo[65536:])
	c.respond(id, map[string]any{"items": []any{map[string]any{
		"channel": 0, "contentType": "image/jpeg", "bytes": len(photo), "sha256": sha256Hex(photo),
	}}})
	o := rec.wait(t, "pick")
	if o.err != nil {
		t.Fatal(o.err)
	}
	items := o.value.([]device.Blob)
	if len(items) != 1 || !bytes.Equal(items[0].Bytes, photo) || items[0].SHA256 != sha256Hex(photo) || items[0].ContentType != "image/jpeg" {
		t.Fatalf("items = %+v", items)
	}

	// A lying client (hash of other bytes) fails invalidParams.
	c.dispatch("pick", nil)
	req = c.waitRequest("gallery.pick")
	id = req["id"]
	c.event(id, map[string]any{"kind": "blobStart", "channel": 0, "contentType": "image/jpeg", "bytes": 4})
	c.sendFrame(uint32(id.(float64)), 0, 0, []byte("real"))
	c.respond(id, map[string]any{"items": []any{map[string]any{
		"channel": 0, "contentType": "image/jpeg", "bytes": 4, "sha256": sha256Hex([]byte("fake")),
	}}})
	o = rec.wait(t, "pick")
	if deviceErrCode(o.err) != device.CodeInvalidParams {
		t.Fatalf("tampered upload: %v", o.err)
	}
}

func TestDeviceFileSaveDownload(t *testing.T) {
	s, rec, _ := setupDev(t, nil)
	c := newDevClient(t, s.url, nil)
	c.hello(nil)
	c.dispatch("save", nil)
	req := c.waitRequest("file.save")
	params := req["params"].(map[string]any)
	want := int(params["bytes"].(float64))
	if req["initialCredit"].(float64) != 0 || params["name"] != "report.txt" {
		t.Fatalf("file.save request = %v", req)
	}
	id := req["id"]
	c.send(map[string]any{"type": "deviceEvent", "id": id, "control": map[string]any{"grant": 1 << 20}})
	var got []byte
	for len(got) < want {
		select {
		case f := <-c.frames:
			if len(f) > 12+65536 {
				t.Fatalf("frame of %d bytes exceeds 64 KiB", len(f)-12)
			}
			got = append(got, f[12:]...)
		case <-time.After(10 * time.Second):
			t.Fatalf("download stalled at %d/%d", len(got), want)
		}
	}
	if sha256Hex(got) != params["sha256"] {
		t.Fatal("downloaded bytes do not match the announced sha256")
	}
	c.respond(id, map[string]any{"bytesWritten": len(got)})
	o := rec.wait(t, "save")
	if o.err != nil || o.value.(*device.SaveResult).BytesWritten != uint64(want) {
		t.Fatalf("save = %+v, %v", o.value, o.err)
	}
}

func TestDeviceBluetoothScanStreamStops(t *testing.T) {
	s, rec, _ := setupDev(t, nil)
	c := newDevClient(t, s.url, nil)
	c.hello(nil)
	c.dispatch("scan", nil)
	req := c.waitRequest("bluetooth.scan")
	id := req["id"]
	c.event(id, map[string]any{"device": map[string]any{"id": "aa:01", "name": "Speaker", "rssi": -41}})
	c.event(id, map[string]any{"device": map[string]any{"id": "aa:02", "rssi": -60}})
	c.waitControl(id.(float64), "cancel")
	o := rec.wait(t, "scan")
	if o.err != nil {
		t.Fatal(o.err)
	}
	seen := o.value.([]device.BluetoothDevice)
	if len(seen) != 2 || seen[0].ID != "aa:01" || *seen[0].Name != "Speaker" || seen[1].Rssi != -60 {
		t.Fatalf("seen = %+v", seen)
	}
}

func TestDeviceMicRecordStreamsData(t *testing.T) {
	s, rec, _ := setupDev(t, nil)
	c := newDevClient(t, s.url, nil)
	c.hello(nil)
	c.dispatch("record", nil)
	req := c.waitRequest("mic.record")
	id := req["id"]
	idU := uint32(id.(float64))
	pcm := bytes.Repeat([]byte{1, 0, 2, 0}, 8000) // 32000 bytes = 1 s mono 16 kHz
	c.event(id, map[string]any{"kind": "blobStart", "channel": 0, "contentType": "audio/L16"})
	c.sendFrame(idU, 0, 0, pcm[:16000])
	c.sendFrame(idU, 0, 1, pcm[16000:])
	c.respond(id, map[string]any{"durationMs": 1000, "item": map[string]any{
		"channel": 0, "contentType": "audio/L16", "bytes": len(pcm), "sha256": sha256Hex(pcm),
	}})
	o := rec.wait(t, "record")
	if o.err != nil {
		t.Fatal(o.err)
	}
	pair := o.value.([2]any)
	got, res := pair[0].([]byte), pair[1].(*device.MicRecordResult)
	if !bytes.Equal(got, pcm) || res.DurationMs != 1000 || res.Item.Sha256 != sha256Hex(pcm) {
		t.Fatalf("recording: %d bytes, %+v", len(got), res)
	}
}

func TestDeviceContextCancellationAndTimeout(t *testing.T) {
	s, rec, cancelCh := setupDev(t, nil)
	c := newDevClient(t, s.url, nil)
	c.hello(nil)

	c.dispatch("cancelme", nil)
	req := c.waitRequest("gallery.pick")
	close(cancelCh)
	c.waitControl(req["id"].(float64), "cancel")
	o := rec.wait(t, "cancelme")
	if !errors.Is(o.err, device.ErrCancelled) || !errors.Is(o.err, context.Canceled) {
		t.Fatalf("cancel: %v", o.err)
	}

	c.dispatch("timeout", nil)
	req = c.waitRequest("permission.request")
	if ms := req["timeoutMs"].(float64); ms > 300 || ms < 1 {
		t.Fatalf("context deadline not forwarded: timeoutMs %v", ms)
	}
	c.waitControl(req["id"].(float64), "cancel")
	o = rec.wait(t, "timeout")
	if !errors.Is(o.err, device.ErrTimeout) {
		t.Fatalf("timeout: %v", o.err)
	}
}

func TestDeviceLeaseRenewalsAreAcked(t *testing.T) {
	s, rec, _ := setupDev(t, nil)
	c := newDevClient(t, s.url, nil)
	c.hello(nil)
	c.dispatch("pick", nil)
	req := c.waitRequest("gallery.pick")
	// renewLease 1 goes out right after the request; the client acks it.
	ctl := c.waitControl(req["id"].(float64), "renewLease")
	if ctl["renewLease"].(float64) != 1 {
		t.Fatalf("first renewal = %v", ctl)
	}
	c.respond(req["id"], map[string]any{"items": []any{}})
	if o := rec.wait(t, "pick"); o.err != nil || len(o.value.([]device.Blob)) != 0 {
		t.Fatalf("empty pick: %v %v", o.value, o.err)
	}
	c.mu.Lock()
	acks := c.leaseAcks
	c.mu.Unlock()
	if acks < 2 { // core.capabilities + gallery.pick
		t.Fatalf("lease acks = %d", acks)
	}
}

func TestDeviceSupportsAndVersion(t *testing.T) {
	s, rec, _ := setupDev(t, nil)
	c := newDevClient(t, s.url, nil)
	c.hello(nil)
	c.dispatch("supports", nil)
	o := rec.wait(t, "supports")
	v := o.value.([]any)
	if v[0] != true || v[1] != false || v[2] != uint32(1) || v[3] != true || v[4] != false {
		t.Fatalf("supports = %v", v)
	}
}

// ---- replay firewall -----------------------------------------------------------------

func TestDeviceReplayFirewallRefusesAgentDispatch(t *testing.T) {
	s, rec, _ := setupDev(t, nil)
	c := newDevClient(t, s.url, nil)
	ack := c.hello(nil)
	var h *AgentHandle
	var err error
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		if h, err = s.srv.Attach(ack["sessionId"].(string)); err == nil {
			break
		}
	}
	if err != nil {
		t.Fatal(err)
	}
	if err := h.Dispatch("query", map[string]any{"permission": "camera"}); err != nil {
		t.Fatalf("agent dispatch: %v", err)
	}
	o := rec.wait(t, "query")
	var de *device.Error
	if !errors.As(o.err, &de) || de.Code != device.CodeUnavailable || de.Detail != "syncActions.replay" {
		t.Fatalf("agent dispatch reached the device: %v", o.err)
	}
	c.noRequest(200 * time.Millisecond)

	// The same action from the user's own connection is admitted.
	c.dispatch("query", map[string]any{"permission": "camera"})
	req := c.waitRequest("permission.query")
	c.respond(req["id"], map[string]any{"status": "prompt"})
	if o := rec.wait(t, "query"); o.err != nil {
		t.Fatal(o.err)
	}
}

// ---- dispatch slot -------------------------------------------------------------------

func TestDeviceWaitYieldsTheDispatchSlot(t *testing.T) {
	s, rec, _ := setupDev(t, nil)
	c := newDevClient(t, s.url, nil)
	c.hello(nil)
	c.dispatch("waitThenStatus", nil)
	req := c.waitRequest("permission.query")
	// While that handler waits on the device, later actions still run.
	c.dispatch("bump", nil)
	if o := rec.wait(t, "bump"); o.value != 1 {
		t.Fatalf("bump = %v", o.value)
	}
	c.waitState(func(st map[string]any) bool { return st["count"] == float64(1) })
	c.respond(req["id"], map[string]any{"status": "granted"})
	if o := rec.wait(t, "waitThenStatus"); o.err != nil {
		t.Fatal(o.err)
	}
	// The resumed handler's commit merges: count survives, status lands.
	c.waitState(func(st map[string]any) bool {
		return st["status"] == "after-wait:granted" && st["count"] == float64(1)
	})
}

// ---- plane closure -------------------------------------------------------------------

func TestDeviceCoreCapabilitiesErrorClosesPlane(t *testing.T) {
	s, rec, _ := setupDev(t, nil)
	c := newDevClient(t, s.url, nil)
	c.hello(nil)
	c.dispatch("pick", nil)
	c.waitRequest("gallery.pick")
	c.mu.Lock()
	coreID := c.coreID
	c.mu.Unlock()
	c.respondErr(coreID, "unsupported", "")
	o := rec.wait(t, "pick")
	if !errors.Is(o.err, device.ErrConnectionLost) {
		t.Fatalf("pending request after plane close: %v", o.err)
	}
	code, reason := c.waitClosed()
	if code != 1012 || !strings.Contains(reason, "device plane closed") {
		t.Fatalf("close %d %q, want 1012", code, reason)
	}
}

func TestDeviceDisconnectSettlesConnectionLost(t *testing.T) {
	s, rec, _ := setupDev(t, nil)
	c := newDevClient(t, s.url, nil)
	c.hello(nil)
	c.dispatch("pick", nil)
	c.waitRequest("gallery.pick")
	c.conn.Close()
	o := rec.wait(t, "pick")
	if !errors.Is(o.err, device.ErrConnectionLost) {
		t.Fatalf("after disconnect: %v", o.err)
	}
}

func TestDeviceDisabledServerHandlersSeeUnavailable(t *testing.T) {
	core.App.Clear()
	t.Cleanup(func() { core.App.Clear() })
	rec := newRecorder()
	s := newDevServer(t, nil, devApp(rec, nil), devUI, nil)
	conn, _, err := dialDevice(t, s.url, http.Header{})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	hello, _ := json.Marshal(deviceHelloMsg(nil))
	_ = conn.WriteMessage(websocket.TextMessage, hello)
	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			t.Fatal(err)
		}
		var m map[string]any
		_ = json.Unmarshal(data, &m)
		if m["type"] == "sessionAck" {
			if _, has := m["device"]; has || m["resumeToken"] != nil {
				t.Fatalf("UI-only server acked device: %v", m)
			}
		}
		if m["type"] == "initialTree" {
			break
		}
	}
	d, _ := json.Marshal(map[string]any{"type": "dispatchAction", "action": "supports"})
	_ = conn.WriteMessage(websocket.TextMessage, d)
	o := rec.wait(t, "supports")
	if v := o.value.([]any); v[0] != false || v[3] != false {
		t.Fatalf("supports on a UI-only server = %v", v)
	}
	d, _ = json.Marshal(map[string]any{"type": "dispatchAction", "action": "query", "payload": map[string]any{"permission": "camera"}})
	_ = conn.WriteMessage(websocket.TextMessage, d)
	o = rec.wait(t, "query")
	var de *device.Error
	if !errors.As(o.err, &de) || de.Code != device.CodeUnavailable || de.Detail != "device-disabled" {
		t.Fatalf("UI-only device call: %v", o.err)
	}
}

// ---- module lifecycle: activation authority and sweeps -----------------------------

type routedState struct {
	Note string `json:"note"`
}

func TestDeviceRoutedModuleSweptOnNavigation(t *testing.T) {
	core.App.Clear()
	t.Cleanup(func() { core.App.Clear() })
	rec := newRecorder()
	bg := context.Background()
	var mu sync.Mutex
	var stale *device.Device

	core.App.Register("Camera", core.NewApp(routedState{}).Name("Camera").
		OnAction("shoot", func(ctx core.TypedActionContext[routedState]) {
			mu.Lock()
			stale = ctx.Device()
			mu.Unlock()
			_, err := ctx.Device().Camera().Photo(bg, device.CameraFacingBack)
			rec.put("shoot", ctx.Device().Owner(), err)
		}).
		OnAction("staleShoot", func(ctx core.TypedActionContext[routedState]) {
			mu.Lock()
			d := stale
			mu.Unlock()
			_, err := d.Camera().Photo(bg, "")
			rec.put("staleShoot", ctx.Device().Owner(), err)
		}).
		Build())
	core.App.Register("Other", core.NewApp(routedState{}).Name("Other").Build())

	ui := `module App {
	  Router {
	    Route(path: "/") { Camera() }
	    Route(path: "/other") { Other() }
	  }
	}`
	s := newDevServer(t, &DeviceConfig{}, devApp(newRecorder(), nil), ui, map[string]string{
		"App":    ui,
		"Camera": `module Camera { Text("camera @{state.note}") }`,
		"Other":  `module Other { Text("other") }`,
	})
	c := newDevClient(t, s.url, nil)
	c.hello(nil)

	c.dispatch("shoot", nil)
	req := c.waitRequest("camera.capture")
	owner := req["owner"].(map[string]any)
	if !strings.HasPrefix(owner["moduleInstanceId"].(string), "camera#") || owner["activationId"].(float64) != 1 {
		t.Fatalf("routed owner = %v", owner)
	}
	// Navigating away deactivates the module: its activation-owned
	// request is cancelled on the wire and settles cancelled locally.
	c.dispatch("router.push", map[string]any{"to": "/other"})
	c.waitControl(req["id"].(float64), "cancel")
	o := rec.wait(t, "shoot")
	if !errors.Is(o.err, device.ErrCancelled) {
		t.Fatalf("swept request: %v", o.err)
	}

	// Back again: a NEW activation. A Device captured by the old one has
	// lost its authority; a fresh handler gets activation 2.
	c.dispatch("router.push", map[string]any{"to": "/"})
	time.Sleep(200 * time.Millisecond)
	c.dispatch("staleShoot", nil)
	o = rec.wait(t, "staleShoot")
	var de *device.Error
	if !errors.As(o.err, &de) || de.Code != device.CodeUnavailable || de.Detail != "owner-inactive" {
		t.Fatalf("stale activation: %v", o.err)
	}
	if o.value.(device.Owner).ActivationID != 2 {
		t.Fatalf("re-activation id = %+v", o.value)
	}
	c.noRequest(150 * time.Millisecond)
	c.dispatch("shoot", nil)
	req = c.waitRequest("camera.capture")
	if req["owner"].(map[string]any)["activationId"].(float64) != 2 {
		t.Fatalf("owner after re-activation = %v", req["owner"])
	}
	photo := []byte("jpeg-bytes")
	c.event(req["id"], map[string]any{"kind": "blobStart", "channel": 0, "contentType": "image/jpeg", "bytes": len(photo)})
	c.sendFrame(uint32(req["id"].(float64)), 0, 0, photo)
	c.respond(req["id"], map[string]any{"items": []any{map[string]any{
		"channel": 0, "contentType": "image/jpeg", "bytes": len(photo), "sha256": sha256Hex(photo),
	}}})
	if o := rec.wait(t, "shoot"); o.err != nil {
		t.Fatal(o.err)
	}
}

// ---- background lifetime and pin caps -------------------------------------------

func TestDeviceBackgroundPinCap(t *testing.T) {
	core.App.Clear()
	t.Cleanup(func() { core.App.Clear() })
	rec := newRecorder()
	bg := context.Background()
	scanBG := func(name string) func(ctx core.TypedActionContext[routedState]) {
		return func(ctx core.TypedActionContext[routedState]) {
			s, err := ctx.Device().Stream(bg, "bluetooth.scan", nil, device.Background())
			if err != nil {
				rec.put(name, nil, err)
				return
			}
			rec.put(name, s.ID(), nil)
		}
	}
	core.App.Register("Alpha", core.NewApp(routedState{}).Name("Alpha").OnAction("alphaScan", scanBG("alphaScan")).Build())
	core.App.Register("Beta", core.NewApp(routedState{}).Name("Beta").OnAction("betaScan", scanBG("betaScan")).Build())
	app := core.NewApp(devState{}).Name("App").OnAction("appScan", scanBG2(rec, bg)).Build()
	s := newDevServer(t, &DeviceConfig{BrokerOverrides: map[string]any{
		"maxBackgroundOwners": 2,
		"revisionOverrides": []any{map[string]any{
			"capability": "bluetooth.scan", "version": 1, "lifetimes": []string{"activation", "background"},
		}},
	}}, app, devUI, map[string]string{
		"App":   devUI,
		"Alpha": `module Alpha { Text("a") }`,
		"Beta":  `module Beta { Text("b") }`,
	})
	c := newDevClient(t, s.url, nil)
	c.hello(nil)

	c.dispatch("appScan", nil)
	if o := rec.wait(t, "appScan"); o.err != nil {
		t.Fatal(o.err)
	}
	req := c.waitRequest("bluetooth.scan")
	if req["lifetime"] != "background" {
		t.Fatalf("lifetime = %v", req["lifetime"])
	}
	if _, has := req["owner"].(map[string]any)["activationId"]; has {
		t.Fatalf("background owner carries an activation: %v", req["owner"])
	}
	c.dispatch("alphaScan", nil)
	if o := rec.wait(t, "alphaScan"); o.err != nil {
		t.Fatal(o.err)
	}
	c.waitRequest("bluetooth.scan")
	// A third module would exceed the cap of two pinned modules.
	c.dispatch("betaScan", nil)
	o := rec.wait(t, "betaScan")
	if !errors.Is(o.err, device.ErrThrottled) {
		t.Fatalf("pin cap: %v", o.err)
	}
	c.noRequest(150 * time.Millisecond)
}

func scanBG2(rec *recorder, bg context.Context) func(ctx core.TypedActionContext[devState]) {
	return func(ctx core.TypedActionContext[devState]) {
		s, err := ctx.Device().Stream(bg, "bluetooth.scan", nil, device.Background())
		if err != nil {
			rec.put("appScan", nil, err)
			return
		}
		rec.put("appScan", s.ID(), nil)
	}
}

// ---- oversize device text ------------------------------------------------------------

func TestDeviceOversizeTextIsAConnectionViolation(t *testing.T) {
	s, _, _ := setupDev(t, nil)
	c := newDevClient(t, s.url, nil)
	ack := c.hello(nil)
	big := `{"type":"deviceEvent","id":1,"event":{"pad":"` + strings.Repeat("x", 1<<20) + `"}}`
	c.sendRaw([]byte(big))
	var sess *RemoteSession
	for _, ss := range s.srv.Sessions() {
		if ss.SessionID() == ack["sessionId"] {
			sess = ss
		}
	}
	if sess == nil {
		t.Fatal("session not found")
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		info, err := sess.deviceInfo()
		if err == nil && info["connectionViolations"].(float64) >= 1 {
			if !strings.Contains(info["lastConnectionViolation"].(string), "1 MiB") {
				t.Fatalf("violation = %v", info["lastConnectionViolation"])
			}
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("oversize device text was not counted")
}

// A short hello grace (WithHelloGraceMs) initialises a device-less
// session, and a late hello still negotiates the device plane with a
// re-ack (RFC 001 §2.2) instead of being dropped.
func TestDeviceLateHelloAfterGrace(t *testing.T) {
	core.App.Clear()
	t.Cleanup(func() { core.App.Clear() })
	rec := newRecorder()
	srv := NewRemoteServer().WithDefinition(devApp(rec, nil)).Source(t.TempDir()).UI(devUI)
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		up := srv.Upgrader()
		conn, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		if _, err := srv.CreateSession(NewGorillaWebSocketTransport(conn), WithSocketHandle(conn), WithUpgradeRequest(r), WithHelloGraceMs(50)); err != nil {
			conn.Close()
			return
		}
		go srv.readMessages(conn)
	})
	hs := httptest.NewServer(mux)
	t.Cleanup(func() { srv.Stop(); hs.Close() })
	c := newDevClient(t, "ws"+strings.TrimPrefix(hs.URL, "http")+"/ws", http.Header{})
	first := c.waitAck()
	if _, has := first["device"]; has {
		t.Fatalf("grace ack carried device: %v", first)
	}
	c.waitUI("initialTree")
	c.send(deviceHelloMsg(nil))
	re := c.waitAck()
	if re["sessionId"] != first["sessionId"] || re["isRestored"] != false || re["device"] == nil {
		t.Fatalf("re-ack = %v", re)
	}
	c.dispatch("query", map[string]any{"permission": "camera"})
	req := c.waitRequest("permission.query")
	c.respond(req["id"], map[string]any{"status": "granted"})
	if o := rec.wait(t, "query"); o.err != nil {
		t.Fatal(o.err)
	}
}

// newGraceDevServer serves def/ui/components (device plane on by default)
// with a short hello grace (WithHelloGraceMs), so the session can be
// initialised by the grace timer and receive its device hello late.
func newGraceDevServer(t *testing.T, def *core.ModuleDefinition, ui string, components map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	if components != nil {
		dir = writeComponents(t, components)
	}
	srv := NewRemoteServer().WithDefinition(def).Source(dir).UI(ui)
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		up := srv.Upgrader()
		conn, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		if _, err := srv.CreateSession(NewGorillaWebSocketTransport(conn), WithSocketHandle(conn), WithUpgradeRequest(r), WithHelloGraceMs(50)); err != nil {
			conn.Close()
			return
		}
		go srv.readMessages(conn)
	})
	hs := httptest.NewServer(mux)
	t.Cleanup(func() { srv.Stop(); hs.Close() })
	return "ws" + strings.TrimPrefix(hs.URL, "http") + "/ws"
}

// A late device hello on a Router app binds the plane to everything the
// grace initialisation's Router auto-wire built without one: the primary
// module's handlers (which the auto-wire's primary handle installed), the
// routed module active at the hello (a fresh activation at once), and a
// routed module persisted before the hello (its first activation on the
// next mount). Activation authority then follows navigation as usual.
func TestDeviceLateHelloBindsRouterModules(t *testing.T) {
	core.App.Clear()
	t.Cleanup(func() { core.App.Clear() })
	rec := newRecorder()
	bg := context.Background()
	otherActive := make(chan struct{}, 4)
	cameraActive := make(chan struct{}, 4)
	// OnActivated runs after the plane saw the new activation
	// (ModuleInstance.Activate: authority first), so a received signal
	// means the next dispatch acts under that activation.
	awaitActive := func(ch <-chan struct{}, what string) {
		t.Helper()
		select {
		case <-ch:
		case <-time.After(10 * time.Second):
			t.Fatalf("%s never re-activated", what)
		}
	}

	core.App.Register("Camera", core.NewApp(routedState{}).Name("Camera").
		OnActivated(func(*routedState, core.GlobalContext) {
			select {
			case cameraActive <- struct{}{}:
			default:
			}
		}).
		OnAction("shoot", func(ctx core.TypedActionContext[routedState]) {
			_, err := ctx.Device().Camera().Photo(bg, device.CameraFacingBack)
			rec.put("shoot", ctx.Device().Owner(), err)
		}).
		Build())
	core.App.Register("Other", core.NewApp(routedState{}).Name("Other").
		OnActivated(func(*routedState, core.GlobalContext) {
			select {
			case otherActive <- struct{}{}:
			default:
			}
		}).
		OnAction("look", func(ctx core.TypedActionContext[routedState]) {
			st, err := ctx.Device().Permissions().Query(bg, device.PermissionCamera)
			rec.put("look", []any{ctx.Device().Owner(), st}, err)
		}).
		Build())

	ui := `module App {
	  Router {
	    Route(path: "/") { Camera() }
	    Route(path: "/other") { Other() }
	  }
	}`
	url := newGraceDevServer(t, devApp(rec, nil), ui, map[string]string{
		"App":    ui,
		"Camera": `module Camera { Text("camera") }`,
		"Other":  `module Other { Text("other") }`,
	})
	c := newDevClient(t, url, http.Header{})
	first := c.waitAck()
	if _, has := first["device"]; has {
		t.Fatalf("grace ack carried device: %v", first)
	}
	c.waitUI("initialTree")

	// Before the hello: Camera (mounted at "/") is persisted plane-less
	// and Other becomes the active route. The auto-wire installs the
	// router.* handlers just after initialTree, so the push is retried
	// until it lands (navigation is idempotent).
	navigated := false
	for i := 0; i < 50 && !navigated; i++ {
		c.dispatch("router.push", map[string]any{"to": "/other"})
		select {
		case <-otherActive:
			navigated = true
		case <-time.After(200 * time.Millisecond):
		}
	}
	if !navigated {
		t.Fatal("navigation to /other never activated Other")
	}

	c.send(deviceHelloMsg(nil))
	re := c.waitAck()
	if re["sessionId"] != first["sessionId"] || re["device"] == nil {
		t.Fatalf("re-ack = %v", re)
	}

	// The primary module's handlers act for the session's primary owner.
	c.dispatch("query", map[string]any{"permission": "camera"})
	req := c.waitRequest("permission.query")
	if id, _ := req["owner"].(map[string]any)["moduleInstanceId"].(string); !strings.HasPrefix(id, "app@") {
		t.Fatalf("primary owner after late hello = %v", req["owner"])
	}
	c.respond(req["id"], map[string]any{"status": "granted"})
	if o := rec.wait(t, "query"); o.err != nil {
		t.Fatalf("primary handler after late hello: %v", o.err)
	}

	// The routed module active at the hello got its first activation.
	c.dispatch("look", nil)
	req = c.waitRequest("permission.query")
	owner := req["owner"].(map[string]any)
	if !strings.HasPrefix(owner["moduleInstanceId"].(string), "other#") || owner["activationId"].(float64) != 1 {
		t.Fatalf("active routed owner after late hello = %v", owner)
	}
	c.respond(req["id"], map[string]any{"status": "granted"})
	if o := rec.wait(t, "look"); o.err != nil {
		t.Fatalf("active routed handler after late hello: %v", o.err)
	} else if got := o.value.([]any); got[0].(device.Owner).ActivationID != 1 || got[1] != device.PermissionGranted {
		t.Fatalf("look = %v", got)
	}

	// The module persisted before the hello is bound on its next mount.
	// Drop Camera's initial (pre-hello) activation signal first.
	for drained := false; !drained; {
		select {
		case <-cameraActive:
		default:
			drained = true
		}
	}
	c.dispatch("router.push", map[string]any{"to": "/"})
	awaitActive(cameraActive, "Camera")
	c.dispatch("shoot", nil)
	req = c.waitRequest("camera.capture")
	owner = req["owner"].(map[string]any)
	if !strings.HasPrefix(owner["moduleInstanceId"].(string), "camera#") || owner["activationId"].(float64) != 1 {
		t.Fatalf("re-mounted routed owner after late hello = %v", owner)
	}
	// And its activation authority follows navigation: leaving the route
	// sweeps the request (cancel on the wire, cancelled locally).
	c.dispatch("router.push", map[string]any{"to": "/other"})
	c.waitControl(req["id"].(float64), "cancel")
	if o := rec.wait(t, "shoot"); !errors.Is(o.err, device.ErrCancelled) {
		t.Fatalf("swept request after late hello: %v", o.err)
	}

	// Other re-activated: a second activation. Wait for it before
	// dispatching, or "look" can race the navigation and run while no
	// routed module is active.
	awaitActive(otherActive, "Other")
	c.dispatch("look", nil)
	req = c.waitRequest("permission.query")
	if req["owner"].(map[string]any)["activationId"].(float64) != 2 {
		t.Fatalf("re-activated routed owner = %v", req["owner"])
	}
	c.respond(req["id"], map[string]any{"status": "denied"})
	if o := rec.wait(t, "look"); o.err != nil {
		t.Fatal(o.err)
	}
}

// A known-id device message that is invalid in a way encoding/json would
// also reject (a member of the wrong JSON type for the UI envelope) still
// reaches the broker, which terminates that request invalidParams (D8).
func TestDeviceInvalidKnownIDMessageTerminatesRequest(t *testing.T) {
	s, rec, _ := setupDev(t, nil)
	c := newDevClient(t, s.url, nil)
	c.hello(nil)
	c.dispatch("query", map[string]any{"permission": "camera"})
	req := c.waitRequest("permission.query")
	id := req["id"]
	c.send(map[string]any{"type": "deviceResponse", "id": id, "result": map[string]any{"status": "granted"}, "revision": "x"})
	o := rec.wait(t, "query")
	if !errors.Is(o.err, device.ErrInvalidParams) {
		t.Fatalf("invalid known-id message: %v", o.err)
	}
}
