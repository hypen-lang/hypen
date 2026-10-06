package remote

// Client-sent deviceRequest messages over a real WebSocket (RFC 001 §2,
// decision D8: liveness before direction). Only the server sends
// deviceRequest; the Go session must hand every client one to the Rust
// broker, which ignores it for an unknown id and, for a live id, cancels
// that request and settles it invalidParams — the shared transcript
// violation-request-from-client.

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/hypen-space/core/device"
)

// transcriptStep is one step of a shared device transcript fixture.
type transcriptStep struct {
	Dir             string         `json:"dir"`
	Message         map[string]any `json:"message"`
	ExpectViolation string         `json:"expectViolation"`
	Reaction        bool           `json:"reaction"`
}

func loadTranscript(t *testing.T, name string) []transcriptStep {
	t.Helper()
	p := filepath.Join("..", "..", "engine-compatibility-tests", "fixtures", "device", "transcripts", name+".json")
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("read transcript %s: %v", p, err)
	}
	var tr struct {
		Steps []transcriptStep `json:"steps"`
	}
	if err := json.Unmarshal(b, &tr); err != nil {
		t.Fatalf("decode transcript %s: %v", name, err)
	}
	return tr.Steps
}

// noControl asserts no server control other than a lease renewal (which
// the harness acks on its own) arrives within the window.
func (c *devClient) noControl(within time.Duration) {
	c.t.Helper()
	deadline := time.After(within)
	for {
		select {
		case m := <-c.controls:
			ctl, _ := m["control"].(map[string]any)
			if _, lease := ctl["renewLease"]; lease && len(ctl) == 1 {
				continue
			}
			c.t.Fatalf("unexpected server control: %v", m)
		case <-deadline:
			return
		}
	}
}

// noOutcome asserts no handler outcome is recorded within the window.
func (r *recorder) noOutcome(t *testing.T, within time.Duration) {
	t.Helper()
	select {
	case o := <-r.ch:
		t.Fatalf("unexpected handler outcome %s: %v, %v", o.action, o.value, o.err)
	case <-time.After(within):
	}
}

// The transcript's client deviceRequest, replayed on the id of a live
// server request, is a known-id wrong-direction message: the server sends
// `cancel` for that id and the handler sees invalidParams. The id is then
// retired, so a later (otherwise valid) answer is ignored, and the
// connection stays healthy.
func TestDeviceClientRequestOnLiveIDTerminatesRequest(t *testing.T) {
	steps := loadTranscript(t, "violation-request-from-client")
	var c2s map[string]any
	var reaction map[string]any
	for _, st := range steps {
		if st.Dir == "c2s" && st.ExpectViolation == "direction" {
			c2s = st.Message
		}
		if st.Dir == "s2c" && st.Reaction {
			reaction = st.Message
		}
	}
	if c2s == nil || c2s["type"] != "deviceRequest" || reaction == nil {
		t.Fatalf("transcript shape changed: c2s=%v reaction=%v", c2s, reaction)
	}
	wantCtl, _ := reaction["control"].(map[string]any)
	if wantCtl["cancel"] != true {
		t.Fatalf("transcript reaction is not a cancel: %v", reaction)
	}

	s, rec, _ := setupDev(t, nil)
	c := newDevClient(t, s.url, nil)
	c.hello(nil)

	c.dispatch("query", map[string]any{"permission": "camera"})
	req := c.waitRequest("permission.query")
	id := req["id"].(float64)

	// The transcript's message, re-targeted at the live id.
	msg := map[string]any{}
	for k, v := range c2s {
		msg[k] = v
	}
	msg["id"] = id
	c.send(msg)

	ctl := c.waitControl(id, "cancel")
	if ctl["cancel"] != true {
		t.Fatalf("cancel control = %v", ctl)
	}
	o := rec.wait(t, "query")
	if !errors.Is(o.err, device.ErrInvalidParams) {
		t.Fatalf("client deviceRequest on a live id: %v, %v", o.value, o.err)
	}

	// The id is retired: a late valid answer settles nothing.
	c.respond(id, map[string]any{"status": "granted"})
	rec.noOutcome(t, 150*time.Millisecond)
	c.noControl(50 * time.Millisecond)

	// The connection is still healthy: the next request works normally.
	c.dispatch("query", map[string]any{"permission": "microphone"})
	req2 := c.waitRequest("permission.query")
	if req2["id"].(float64) == id {
		t.Fatalf("retired id %v reused", id)
	}
	c.respond(req2["id"], map[string]any{"status": "granted"})
	o = rec.wait(t, "query")
	if o.err != nil || o.value != device.PermissionGranted {
		t.Fatalf("follow-up query = %v, %v", o.value, o.err)
	}
}

// Echoing the server's own deviceRequest back verbatim — the natural
// reflection bug in a client — hits the same path.
func TestDeviceClientEchoOfServerRequestTerminatesIt(t *testing.T) {
	s, rec, _ := setupDev(t, nil)
	c := newDevClient(t, s.url, nil)
	c.hello(nil)

	c.dispatch("query", map[string]any{"permission": "camera"})
	req := c.waitRequest("permission.query")
	id := req["id"].(float64)
	c.send(req)

	c.waitControl(id, "cancel")
	o := rec.wait(t, "query")
	if !errors.Is(o.err, device.ErrInvalidParams) {
		t.Fatalf("echoed request: %v, %v", o.value, o.err)
	}
}

// A client deviceRequest for an id that is not live is ignored whatever it
// says (unknown ids are ignored in any direction): no cancel, and the live
// request is still answered normally.
func TestDeviceClientRequestOnUnknownIDIsIgnored(t *testing.T) {
	s, rec, _ := setupDev(t, nil)
	c := newDevClient(t, s.url, nil)
	c.hello(nil)

	c.dispatch("query", map[string]any{"permission": "camera"})
	req := c.waitRequest("permission.query")
	id := req["id"].(float64)

	unknown := map[string]any{}
	for k, v := range req {
		unknown[k] = v
	}
	unknown["id"] = id + 1000
	c.send(unknown)
	// Malformed and for an unknown id: still ignored, never attributed.
	c.send(map[string]any{"type": "deviceRequest", "id": id + 1001})

	c.noControl(150 * time.Millisecond)
	rec.noOutcome(t, 10*time.Millisecond)

	c.respond(id, map[string]any{"status": "granted"})
	o := rec.wait(t, "query")
	if o.err != nil || o.value != device.PermissionGranted {
		t.Fatalf("live request after ignored client requests: %v, %v", o.value, o.err)
	}
}

// A malformed client deviceRequest attributable to a live id terminates
// that request invalidParams, with a cancel (the client's message was not
// a terminal, so the server tells it).
func TestDeviceMalformedClientRequestOnLiveIDTerminatesRequest(t *testing.T) {
	s, rec, _ := setupDev(t, nil)
	c := newDevClient(t, s.url, nil)
	c.hello(nil)

	c.dispatch("query", map[string]any{"permission": "camera"})
	req := c.waitRequest("permission.query")
	id := req["id"].(float64)
	c.send(map[string]any{"type": "deviceRequest", "id": id})

	c.waitControl(id, "cancel")
	o := rec.wait(t, "query")
	if !errors.Is(o.err, device.ErrInvalidParams) {
		t.Fatalf("malformed client request on live id: %v, %v", o.value, o.err)
	}
}

func TestIsDeviceMessageType(t *testing.T) {
	for _, typ := range []MessageType{"deviceRequest", "deviceResponse", "deviceEvent"} {
		if !isDeviceMessageType(typ) {
			t.Errorf("%s not routed to the device plane", typ)
		}
	}
	for _, typ := range []MessageType{"hello", "dispatchAction", "stateUpdate", "device", ""} {
		if isDeviceMessageType(typ) {
			t.Errorf("%q routed to the device plane", typ)
		}
	}
}
