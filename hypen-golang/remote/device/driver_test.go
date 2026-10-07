package device

// Test driver and fixture helpers for the conformance runners
// (conformance_test.go, conformance_shared_test.go): a thin driver around
// the REAL Rust broker in the server role, reached through this package's
// WASI binding exactly as package remote drives it. It plays the client by
// feeding text and frames, drains Poll like the SDK's pump and records
// every output. It interprets nothing itself — every protocol verdict comes
// from the broker. (Go counterpart of the Kotlin SDK's BrokerDriver.)

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"unicode/utf8"
)

// ---- shared fixture tree -----------------------------------------------------------

// compatPath resolves a path under engine-compatibility-tests/ (go test runs
// with cwd = this package directory); a missing file fails, never skips.
func compatPath(t testing.TB, parts ...string) string {
	t.Helper()
	p, err := filepath.Abs(filepath.Join(append([]string{"..", "..", "..", "engine-compatibility-tests"}, parts...)...))
	if err != nil {
		t.Fatalf("resolve %v: %v", parts, err)
	}
	if _, err := os.Stat(p); err != nil {
		t.Fatalf("shared fixture %s is required: %v", p, err)
	}
	return p
}

// parseFixture decodes fixture JSON into generic values (json.Number for
// numbers, so integers compare exactly); a duplicate key anywhere is a
// fixture error (encoding/json would silently keep the last value).
func parseFixture(data []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	v, err := fixtureValue(dec)
	if err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errors.New("trailing data after fixture JSON")
	}
	return v, nil
}

func fixtureValue(dec *json.Decoder) (any, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	d, ok := tok.(json.Delim)
	if !ok {
		return tok, nil
	}
	switch d {
	case '{':
		out := map[string]any{}
		for dec.More() {
			kt, err := dec.Token()
			if err != nil {
				return nil, err
			}
			key := kt.(string)
			if _, dup := out[key]; dup {
				return nil, fmt.Errorf("duplicate key %q", key)
			}
			v, err := fixtureValue(dec)
			if err != nil {
				return nil, err
			}
			out[key] = v
		}
		_, err := dec.Token() // '}'
		return out, err
	case '[':
		out := []any{}
		for dec.More() {
			v, err := fixtureValue(dec)
			if err != nil {
				return nil, err
			}
			out = append(out, v)
		}
		_, err := dec.Token() // ']'
		return out, err
	}
	return nil, fmt.Errorf("unexpected delimiter %v", d)
}

func loadFixture(t testing.TB, path string) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%s: %v", path, err)
	}
	v, err := parseFixture(raw)
	if err != nil {
		t.Fatalf("%s: invalid fixture JSON: %v", path, err)
	}
	doc, ok := v.(map[string]any)
	if !ok {
		t.Fatalf("%s: fixture is not an object", path)
	}
	return doc
}

// ---- generic JSON helpers ------------------------------------------------------------

// parseJSON parses JSON the broker produced (or a fixture fragment) into the
// generic form used for comparisons.
func parseJSON(t testing.TB, data []byte) any {
	t.Helper()
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		t.Fatalf("invalid JSON: %v\n%s", err, data)
	}
	return v
}

func mustJSON(t testing.TB, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func obj(v any) map[string]any { m, _ := v.(map[string]any); return m }

func str(v any) (string, bool) { s, ok := v.(string); return s, ok }

func sv(v any) string { s, _ := v.(string); return s }

// num reads an integer JSON number (json.Number from UseNumber decoding).
func num(v any) (int64, bool) {
	n, ok := v.(json.Number)
	if !ok {
		return 0, false
	}
	i, err := n.Int64()
	return i, err == nil
}

func mustNum(t testing.TB, v any) int64 {
	t.Helper()
	n, ok := num(v)
	if !ok {
		t.Fatalf("expected an integer, got %#v", v)
	}
	return n
}

func jnum(n int64) json.Number { return json.Number(strconv.FormatInt(n, 10)) }

// with returns a shallow copy of m with key set to v.
func with(m map[string]any, key string, v any) map[string]any {
	out := make(map[string]any, len(m)+1)
	for k, x := range m {
		out[k] = x
	}
	out[key] = v
	return out
}

func decodeHex(t testing.TB, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatalf("bad hex %q: %v", s, err)
	}
	return b
}

// caseBytes returns the exact bytes a text case stands for ("raw",
// "rawHex" or "rawRepeat"), or nil for a "message"/"value" case. Exactly
// one form must be present.
func caseBytes(t testing.TB, c map[string]any) []byte {
	t.Helper()
	forms := 0
	for _, k := range []string{"message", "raw", "rawHex", "rawRepeat", "value"} {
		if _, ok := c[k]; ok {
			forms++
		}
	}
	if forms != 1 {
		t.Fatalf("%v: exactly one case form, got %d", c["name"], forms)
	}
	if raw, ok := c["raw"].(string); ok {
		return []byte(raw)
	}
	if h, ok := c["rawHex"].(string); ok {
		return decodeHex(t, h)
	}
	if rep, ok := c["rawRepeat"].(map[string]any); ok {
		n := int(mustNum(t, rep["count"]))
		return []byte(sv(rep["prefix"]) + strings.Repeat(sv(rep["repeat"]), n) + sv(rep["suffix"]))
	}
	return nil
}

// ---- the broker driver ----------------------------------------------------------------

const driverModule = "conformance-module"

var (
	registryOnce sync.Once
	registryDoc  []map[string]any
)

// registryV1 is the canonical registry (schema/device/registry-v1.json),
// loaded once (callers must not mutate it).
func registryV1(t testing.TB) []map[string]any {
	t.Helper()
	registryOnce.Do(func() {
		doc := loadFixture(t, compatPath(t, "schema", "device", "registry-v1.json"))
		for _, c := range doc["capabilities"].([]any) {
			registryDoc = append(registryDoc, c.(map[string]any))
		}
	})
	if len(registryDoc) == 0 {
		t.Fatal("registry-v1.json lists no capabilities")
	}
	return registryDoc
}

// fullAck is a sessionAck.device selecting every registry capability at its
// highest revision, binary.
func fullAck(t testing.TB) map[string]any {
	t.Helper()
	caps := []any{}
	for _, c := range registryV1(t) {
		revs := c["revisions"].([]any)
		caps = append(caps, map[string]any{"name": c["name"], "version": obj(revs[len(revs)-1])["version"]})
	}
	return map[string]any{"protocolVersion": jnum(1), "binary": true, "capabilities": caps}
}

type drvEvent struct {
	id uint32
	ev any
}

type brokerDriver struct {
	t   testing.TB
	b   *Broker
	now uint64

	sent    []map[string]any // every server → client text, parsed
	frames  [][]byte
	events  []drvEvent
	data    map[uint32]*bytes.Buffer
	settled map[uint32]*Outcome
	closed  *Output
	// consume reports streamed chunks / events consumed at once (a prompt
	// handler).
	consume bool
}

func newDriver(t testing.TB, config map[string]any) *brokerDriver {
	t.Helper()
	b, err := sharedTestRuntime(t).NewBroker(mustJSON(t, config), Pool{}, 0)
	if err != nil {
		t.Fatalf("broker create: %v", err)
	}
	d := &brokerDriver{t: t, b: b, data: map[uint32]*bytes.Buffer{}, settled: map[uint32]*Outcome{}, consume: true}
	t.Cleanup(func() { _ = b.Destroy() })
	return d
}

func driverConfig(ack any, extra map[string]any) map[string]any {
	cfg := map[string]any{"ack": ack}
	for k, v := range extra {
		cfg[k] = v
	}
	return cfg
}

// startedDriver is a started broker (core.capabilities open) with
// driverModule activation 1 live.
func startedDriver(t testing.TB, ack any, extra map[string]any) *brokerDriver {
	t.Helper()
	if ack == nil {
		ack = fullAck(t)
	}
	d := newDriver(t, driverConfig(ack, extra))
	d.start()
	if !d.activate(driverModule, 1) {
		t.Fatal("activation refused")
	}
	return d
}

func (d *brokerDriver) fatalf(format string, args ...any) {
	d.t.Helper()
	d.t.Fatalf(format, args...)
}

func (d *brokerDriver) drain() {
	d.t.Helper()
	for i := 0; i < 100000; i++ {
		out, err := d.b.Poll()
		if err != nil {
			d.fatalf("poll: %v", err)
		}
		if len(out) == 0 {
			return
		}
		var chunks, evs []uint32
		for i := range out {
			o := out[i]
			switch o.Kind {
			case OutputSendText:
				d.sent = append(d.sent, obj(parseJSON(d.t, o.Text)))
			case OutputSendFrame:
				d.frames = append(d.frames, o.Bytes)
			case OutputEvent:
				d.events = append(d.events, drvEvent{o.ID, parseJSON(d.t, o.Event)})
				evs = append(evs, o.ID)
			case OutputData:
				if d.data[o.ID] == nil {
					d.data[o.ID] = &bytes.Buffer{}
				}
				d.data[o.ID].Write(o.Bytes)
				chunks = append(chunks, o.ID)
			case OutputSettled:
				if _, dup := d.settled[o.ID]; dup {
					d.fatalf("request %d settled twice", o.ID)
				}
				d.settled[o.ID] = o.Outcome
			case OutputCloseConnection:
				if d.closed != nil {
					d.fatalf("device plane closed twice")
				}
				d.closed = &o
			}
		}
		if d.consume {
			for _, id := range chunks {
				_ = d.b.ConsumedData(id, 1, d.now)
			}
			for _, id := range evs {
				_ = d.b.ConsumedEvents(id, 1, d.now)
			}
		}
	}
	d.fatalf("broker never drained")
}

func (d *brokerDriver) start() uint32 {
	d.t.Helper()
	id, err := d.b.Start(d.now)
	if err != nil {
		d.fatalf("start: %v", err)
	}
	d.drain()
	return id
}

func (d *brokerDriver) activate(module string, activation uint32) bool {
	d.t.Helper()
	ok, err := d.b.OwnerIsActive(module, activation)
	if err == nil && !ok {
		ok, err = d.b.OwnerActivated(module, activation, d.now)
	}
	if err != nil {
		d.fatalf("activate: %v", err)
	}
	d.drain()
	return ok
}

// open opens spec (download = file.save bytes, nil = none): the id, or the
// local refusal. Host errors fail the test.
func (d *brokerDriver) open(spec map[string]any, download []byte) (uint32, *Refusal) {
	d.t.Helper()
	id, err := d.b.Open(mustJSON(d.t, spec), download, d.now)
	var ref *Refusal
	if errors.As(err, &ref) {
		d.drain()
		return 0, ref
	}
	if err != nil {
		d.fatalf("open: host error %v", err)
	}
	d.drain()
	return id, nil
}

func (d *brokerDriver) opened(spec map[string]any, download []byte) uint32 {
	d.t.Helper()
	id, ref := d.open(spec, download)
	if ref != nil {
		d.fatalf("refused: %s %s", ref.Code, ref.Detail)
	}
	return id
}

func (d *brokerDriver) onText(text []byte) bool {
	d.t.Helper()
	ok, err := d.b.OnText(text, d.now)
	if err != nil {
		d.fatalf("on_text: host error %v", err)
	}
	d.drain()
	return ok
}

func (d *brokerDriver) onFrame(frame []byte) bool {
	d.t.Helper()
	ok, err := d.b.OnFrame(frame, d.now)
	if err != nil {
		d.fatalf("on_frame: host error %v", err)
	}
	d.drain()
	return ok
}

func (d *brokerDriver) info() map[string]any {
	d.t.Helper()
	m, err := d.b.Info()
	if err != nil {
		d.fatalf("info: %v", err)
	}
	return m
}

func (d *brokerDriver) connectionViolations() int64 {
	return int64(d.info()["connectionViolations"].(float64))
}

// coreStreamID is the live core.capabilities stream id (ok false: none).
func (d *brokerDriver) coreStreamID() (uint32, bool) {
	v, ok := d.info()["coreStreamId"].(float64)
	return uint32(v), ok
}

func (d *brokerDriver) isLive(id uint32) bool {
	d.t.Helper()
	ok, err := d.b.IsLive(id)
	if err != nil {
		d.fatalf("is_live: %v", err)
	}
	return ok
}

// revision is the effective revision the broker enforces, or nil.
func (d *brokerDriver) revision(capability string, version uint32) map[string]any {
	d.t.Helper()
	raw, err := d.b.Revision(capability, version)
	if err != nil {
		d.fatalf("revision: %v", err)
	}
	if raw == nil {
		return nil
	}
	return obj(parseJSON(d.t, raw))
}

func (d *brokerDriver) sentFor(id uint32, typ string) []map[string]any {
	var out []map[string]any
	for _, m := range d.sent {
		if n, _ := num(m["id"]); m["type"] == typ && n == int64(id) {
			out = append(out, m)
		}
	}
	return out
}

func isCancel(m map[string]any, id uint32) bool {
	n, _ := num(m["id"])
	_, has := obj(m["control"])["cancel"]
	return m["type"] == "deviceEvent" && n == int64(id) && has
}

func (d *brokerDriver) cancelsFor(id uint32) int {
	n := 0
	for _, m := range d.sent {
		if isCancel(m, id) {
			n++
		}
	}
	return n
}

// failureCode is the failure code request id settled with ("" = not
// settled, or settled ok).
func (d *brokerDriver) failureCode(id uint32) DeviceErrorCode {
	if o := d.settled[id]; o != nil && !o.OK {
		return o.Code
	}
	return ""
}

func (d *brokerDriver) outstandingCredit(id uint32) (uint64, bool) {
	d.t.Helper()
	c, ok, err := d.b.OutstandingCredit(id)
	if err != nil {
		d.fatalf("outstanding_credit: %v", err)
	}
	return c, ok
}

// spec is an open spec for driverModule activation 1.
func spec(capability string, params any, version int64, extra map[string]any) map[string]any {
	m := map[string]any{
		"capability":       capability,
		"version":          jnum(version),
		"params":           params,
		"moduleInstanceId": driverModule,
		"activationId":     jnum(1),
	}
	for k, v := range extra {
		m[k] = v
	}
	return m
}

// frame is a v1 binary frame: version 1, flags 0, channel, request id, seq,
// payload (RFC 001 §2.3; pinned to the golden bytes in frames.json by
// TestGoldenFramesThroughTheBroker).
func frame(id uint32, channel uint16, seq uint32, payload []byte) []byte {
	f := make([]byte, FrameHeaderLen+len(payload))
	f[0] = 1
	binary.LittleEndian.PutUint16(f[2:], channel)
	binary.LittleEndian.PutUint32(f[4:], id)
	binary.LittleEndian.PutUint32(f[8:], seq)
	copy(f[FrameHeaderLen:], payload)
	return f
}

// withRequestID rewrites a frame's request id (transcript ids map to the
// broker's own).
func withRequestID(f []byte, id uint32) []byte {
	out := append([]byte(nil), f...)
	if len(out) >= 8 {
		binary.LittleEndian.PutUint32(out[4:8], id)
	}
	return out
}

func textOK(b []byte) bool { return utf8.Valid(b) }
