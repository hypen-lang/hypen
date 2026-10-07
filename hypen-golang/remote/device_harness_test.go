package remote

// Shared harness for the device-plane tests: a RemoteServer (device plane
// on by default) on a real HTTP listener, and a scripted Go device client
// speaking the RFC 001 wire over a real WebSocket (gorilla).

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	core "github.com/hypen-space/core"
)

// devServer is a server listening on a loopback port (device plane on by
// default).
type devServer struct {
	srv  *RemoteServer
	http *httptest.Server
	url  string
}

// newDevServer serves def with ui (components: extra modules on disk, may
// be nil). cfg nil turns the device plane off (DisableDevice); otherwise
// cfg is passed to ConfigureDevice — the plane itself needs no call. setup
// runs on the server before it listens (e.g. to configure admission);
// without it no admission is configured (every client is admitted, the
// default).
func newDevServer(t *testing.T, cfg *DeviceConfig, def *core.ModuleDefinition, ui string, components map[string]string, setup ...func(*RemoteServer)) *devServer {
	t.Helper()
	dir := t.TempDir()
	if components != nil {
		dir = writeComponents(t, components)
	}
	srv := NewRemoteServer().WithDefinition(def).Source(dir).UI(ui)
	if cfg == nil {
		srv.DisableDevice()
	} else {
		srv.ConfigureDevice(*cfg)
	}
	for _, f := range setup {
		f(srv)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", srv.handleWebSocket)
	hs := httptest.NewServer(mux)
	t.Cleanup(func() {
		srv.Stop()
		hs.Close()
	})
	return &devServer{srv: srv, http: hs, url: "ws" + strings.TrimPrefix(hs.URL, "http") + "/ws"}
}

// devClient is a scripted device host over a real WebSocket.
type devClient struct {
	t    *testing.T
	conn *websocket.Conn
	wmu  sync.Mutex

	acks     chan map[string]any
	ui       chan map[string]any
	requests chan map[string]any
	controls chan map[string]any
	frames   chan []byte
	closed   chan struct{}

	mu        sync.Mutex
	coreID    float64
	leaseAcks int
	noLease   bool
	closeCode int
	closeText string
}

func dialDevice(t *testing.T, url string, header http.Header) (*websocket.Conn, *http.Response, error) {
	t.Helper()
	if header == nil {
		header = http.Header{"Authorization": {"Bearer test"}}
	}
	d := websocket.Dialer{HandshakeTimeout: 5 * time.Second}
	return d.Dial(url, header)
}

func newDevClient(t *testing.T, url string, header http.Header) *devClient {
	t.Helper()
	conn, _, err := dialDevice(t, url, header)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	return wrapDevClient(t, conn)
}

// wrapDevClient scripts a device host over an already-dialled connection
// (e.g. one dialled with compression).
func wrapDevClient(t *testing.T, conn *websocket.Conn) *devClient {
	t.Helper()
	c := &devClient{
		t: t, conn: conn,
		acks:     make(chan map[string]any, 16),
		ui:       make(chan map[string]any, 256),
		requests: make(chan map[string]any, 64),
		controls: make(chan map[string]any, 256),
		frames:   make(chan []byte, 256),
		closed:   make(chan struct{}),
	}
	conn.SetCloseHandler(func(code int, text string) error {
		c.mu.Lock()
		c.closeCode, c.closeText = code, text
		c.mu.Unlock()
		return nil
	})
	go c.read()
	t.Cleanup(func() { _ = conn.Close() })
	return c
}

func (c *devClient) read() {
	defer close(c.closed)
	for {
		kind, data, err := c.conn.ReadMessage()
		if err != nil {
			if ce, ok := err.(*websocket.CloseError); ok {
				c.mu.Lock()
				c.closeCode, c.closeText = ce.Code, ce.Text
				c.mu.Unlock()
			}
			return
		}
		if kind == websocket.BinaryMessage {
			c.frames <- data
			continue
		}
		var m map[string]any
		if err := json.Unmarshal(data, &m); err != nil {
			continue
		}
		switch m["type"] {
		case "sessionAck":
			c.acks <- m
		case "deviceRequest":
			if m["capability"] == "core.capabilities" {
				c.mu.Lock()
				c.coreID = m["id"].(float64)
				c.mu.Unlock()
				continue
			}
			c.requests <- m
		case "deviceEvent":
			ctl, _ := m["control"].(map[string]any)
			if seq, ok := ctl["renewLease"]; ok {
				c.mu.Lock()
				auto := !c.noLease
				if auto {
					c.leaseAcks++
				}
				c.mu.Unlock()
				if auto {
					c.send(map[string]any{"type": "deviceEvent", "id": m["id"], "control": map[string]any{"leaseAck": seq}})
				}
			}
			c.mu.Lock()
			isCore := m["id"].(float64) == c.coreID
			c.mu.Unlock()
			if !isCore {
				c.controls <- m
			}
		default:
			c.ui <- m
		}
	}
}

func (c *devClient) send(v any) {
	c.t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		c.t.Fatalf("marshal: %v", err)
	}
	c.sendRaw(b)
}

func (c *devClient) sendRaw(b []byte) {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	_ = c.conn.WriteMessage(websocket.TextMessage, b)
}

func (c *devClient) sendFrame(id uint32, channel uint16, seq uint32, payload []byte) {
	f := make([]byte, 12+len(payload))
	f[0] = 1
	binary.LittleEndian.PutUint16(f[2:], channel)
	binary.LittleEndian.PutUint32(f[4:], id)
	binary.LittleEndian.PutUint32(f[8:], seq)
	copy(f[12:], payload)
	c.wmu.Lock()
	defer c.wmu.Unlock()
	_ = c.conn.WriteMessage(websocket.BinaryMessage, f)
}

// allCaps is the advertisement of a client implementing every revision.
var allCaps = []map[string]any{
	{"name": "core.capabilities", "versions": []int{1}},
	{"name": "bluetooth.scan", "versions": []int{1}},
	{"name": "bluetooth.select", "versions": []int{1}},
	{"name": "camera.capture", "versions": []int{1}},
	{"name": "file.pick", "versions": []int{1}},
	{"name": "file.save", "versions": []int{1}},
	{"name": "gallery.pick", "versions": []int{1}},
	{"name": "mic.record", "versions": []int{1}},
	{"name": "permission.query", "versions": []int{1}},
	{"name": "permission.request", "versions": []int{1}},
}

func deviceHelloMsg(extra map[string]any) map[string]any {
	m := map[string]any{
		"type":   "hello",
		"device": map[string]any{"protocolVersions": []int{1}, "binary": true, "capabilities": allCaps},
	}
	for k, v := range extra {
		m[k] = v
	}
	return m
}

// hello sends a device hello and returns the sessionAck; it also waits
// for the initialTree.
func (c *devClient) hello(extra map[string]any) map[string]any {
	c.t.Helper()
	c.send(deviceHelloMsg(extra))
	ack := c.waitAck()
	c.waitUI("initialTree")
	return ack
}

func (c *devClient) waitAck() map[string]any {
	c.t.Helper()
	select {
	case a := <-c.acks:
		return a
	case <-time.After(30 * time.Second):
		c.t.Fatal("no sessionAck")
	}
	return nil
}

func (c *devClient) waitUI(typ string) map[string]any {
	c.t.Helper()
	deadline := time.After(30 * time.Second)
	for {
		select {
		case m := <-c.ui:
			if m["type"] == typ {
				return m
			}
		case <-deadline:
			c.t.Fatalf("no %s message", typ)
			return nil
		}
	}
}

// waitState waits for a stateUpdate whose state satisfies ok.
func (c *devClient) waitState(ok func(map[string]any) bool) map[string]any {
	c.t.Helper()
	deadline := time.After(30 * time.Second)
	for {
		select {
		case m := <-c.ui:
			if m["type"] != "stateUpdate" {
				continue
			}
			st, _ := m["state"].(map[string]any)
			if ok(st) {
				return st
			}
		case <-deadline:
			c.t.Fatal("state never matched")
			return nil
		}
	}
}

func (c *devClient) dispatch(action string, payload any) {
	m := map[string]any{"type": "dispatchAction", "action": action}
	if payload != nil {
		m["payload"] = payload
	}
	c.send(m)
}

func (c *devClient) waitRequest(capability string) map[string]any {
	c.t.Helper()
	select {
	case m := <-c.requests:
		if m["capability"] != capability {
			c.t.Fatalf("request for %v, want %s: %v", m["capability"], capability, m)
		}
		return m
	case <-time.After(30 * time.Second):
		c.t.Fatalf("no %s deviceRequest", capability)
	}
	return nil
}

func (c *devClient) noRequest(within time.Duration) {
	c.t.Helper()
	select {
	case m := <-c.requests:
		c.t.Fatalf("unexpected deviceRequest: %v", m)
	case <-time.After(within):
	}
}

// waitControl waits for a server control on id with the given key.
func (c *devClient) waitControl(id float64, key string) map[string]any {
	c.t.Helper()
	deadline := time.After(30 * time.Second)
	for {
		select {
		case m := <-c.controls:
			ctl, _ := m["control"].(map[string]any)
			if m["id"].(float64) == id {
				if _, ok := ctl[key]; ok {
					return ctl
				}
			}
		case <-deadline:
			c.t.Fatalf("no %s control for request %v", key, id)
			return nil
		}
	}
}

func (c *devClient) respond(id any, result any) {
	c.send(map[string]any{"type": "deviceResponse", "id": id, "result": result})
}

func (c *devClient) respondErr(id any, code, detail string) {
	e := map[string]any{"code": code}
	if detail != "" {
		e["platformDetail"] = detail
	}
	c.send(map[string]any{"type": "deviceResponse", "id": id, "error": e})
}

func (c *devClient) event(id any, ev any) {
	c.send(map[string]any{"type": "deviceEvent", "id": id, "event": ev})
}

func (c *devClient) waitClosed() (int, string) {
	c.t.Helper()
	select {
	case <-c.closed:
	case <-time.After(30 * time.Second):
		c.t.Fatal("connection not closed")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.closeCode, c.closeText
}

func sha256Hex(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

// recorder collects handler outcomes for assertions.
type recorder struct {
	ch chan outcomeRec
}

type outcomeRec struct {
	action string
	value  any
	err    error
}

func newRecorder() *recorder { return &recorder{ch: make(chan outcomeRec, 64)} }

func (r *recorder) put(action string, value any, err error) {
	r.ch <- outcomeRec{action: action, value: value, err: err}
}

func (r *recorder) wait(t *testing.T, action string) outcomeRec {
	t.Helper()
	deadline := time.After(30 * time.Second)
	for {
		select {
		case o := <-r.ch:
			if o.action == action {
				return o
			}
		case <-deadline:
			t.Fatalf("handler %s never finished", action)
			return outcomeRec{}
		}
	}
}
