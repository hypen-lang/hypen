package device

// Tests of the Go binding of the Rust device broker (broker.go) against the
// shipped engine module (../../hypen_engine.wasm, the file the root package
// embeds).

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
)

var (
	testRTOnce sync.Once
	testRT     *BrokerRuntime
	testRTErr  error
)

func sharedTestRuntime(t testing.TB) *BrokerRuntime {
	t.Helper()
	testRTOnce.Do(func() {
		wasm, err := os.ReadFile("../../hypen_engine.wasm")
		if err != nil {
			testRTErr = err
			return
		}
		testRT, testRTErr = NewBrokerRuntime(wasm)
	})
	if testRTErr != nil {
		t.Fatal(testRTErr)
	}
	return testRT
}

const testAck = `{"protocolVersion":1,"binary":true,"capabilities":[` +
	`{"name":"core.capabilities","version":1},{"name":"file.save","version":1},` +
	`{"name":"gallery.pick","version":1},{"name":"mic.record","version":1},` +
	`{"name":"permission.query","version":1}]}`

func newTestBroker(t *testing.T, rt *BrokerRuntime, pool Pool) *Broker {
	t.Helper()
	b, err := rt.NewBroker([]byte(`{"ack":`+testAck+`}`), pool, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = b.Destroy() })
	if _, err := b.Start(0); err != nil {
		t.Fatal(err)
	}
	if ok, err := b.OwnerActivated("m1", 1, 0); !ok || err != nil {
		t.Fatalf("activate: %v %v", ok, err)
	}
	return b
}

func testFrame(id uint32, seq uint32, payload []byte) []byte {
	f := make([]byte, 12+len(payload))
	f[0] = 1
	binary.LittleEndian.PutUint32(f[4:], id)
	binary.LittleEndian.PutUint32(f[8:], seq)
	copy(f[12:], payload)
	return f
}

func hexSHA(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

func mustPoll(t *testing.T, b *Broker) []Output {
	t.Helper()
	out, err := b.Poll()
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestBrokerRuntimeNegotiate(t *testing.T) {
	rt := sharedTestRuntime(t)
	ack, err := rt.Negotiate([]byte(`{"protocolVersions":[1],"binary":true,"capabilities":[`+
		`{"name":"core.capabilities","versions":[1]},{"name":"gallery.pick","versions":[1]}]}`), true)
	if err != nil || ack == nil {
		t.Fatalf("negotiate: %s %v", ack, err)
	}
	valid, err := rt.ValidateAck(ack)
	if err != nil {
		t.Fatalf("ack is not a valid sessionAck.device: %v", err)
	}
	var a struct {
		Capabilities []json.RawMessage `json:"capabilities"`
	}
	if err := json.Unmarshal(valid, &a); err != nil || len(a.Capabilities) != 2 {
		t.Fatalf("ack = %s", ack)
	}
	for _, bad := range []string{
		`{"protocolVersions":[1],"binary":true,"capabilities":[],"x":1}`,
		`{"protocolVersions":[2],"binary":true,"capabilities":[{"name":"core.capabilities","versions":[1]}]}`,
		`[1]`,
		`{"protocolVersions":[1],"binary":true,"capabilities":[{"name":"core.capabilities","versions":[1]}],"protocolVersions":[1]}`,
	} {
		if ack, err := rt.Negotiate([]byte(bad), true); err != nil || ack != nil {
			t.Errorf("negotiate(%s) = %s, %v; want disabled", bad, ack, err)
		}
	}
	c, err := rt.Constants()
	if err != nil || c["protocolVersion"].(float64) != 1 || c["devicePlaneCloseCode"].(float64) != 1012 {
		t.Fatalf("constants: %v %v", c, err)
	}
}

// FileSaveParams is Rust's file.save announcement: it decodes strictly as
// FileSaveParams and carries the byte count and SHA-256 of the data
// (including an empty payload and a name needing escapes).
func TestBrokerRuntimeFileSaveParams(t *testing.T) {
	rt := sharedTestRuntime(t)
	for _, tc := range []struct {
		name, ct string
		data     []byte
	}{
		{"a.txt", "text/plain", []byte("abc")},
		{`q"uo\te\u00e9.bin`, "application/octet-stream", bytes.Repeat([]byte{7}, 70_000)},
		{"empty", "text/plain", nil},
	} {
		raw, err := rt.FileSaveParams(tc.name, tc.ct, tc.data)
		if err != nil {
			t.Fatalf("%q: %v", tc.name, err)
		}
		dec := json.NewDecoder(bytes.NewReader(raw))
		dec.DisallowUnknownFields()
		var got FileSaveParams
		if err := dec.Decode(&got); err != nil {
			t.Fatalf("%q: %s: %v", tc.name, raw, err)
		}
		want := FileSaveParams{Channel: 0, Name: tc.name, ContentType: tc.ct, Bytes: uint64(len(tc.data)), Sha256: hexSHA(tc.data)}
		if got != want {
			t.Fatalf("%q: got %+v want %+v", tc.name, got, want)
		}
	}
}

func TestBrokerRuntimeRejectsNonEngineModules(t *testing.T) {
	if _, err := NewBrokerRuntime([]byte("not wasm")); err == nil {
		t.Fatal("instantiated garbage")
	}
}

func TestBrokerUploadRoundTrip(t *testing.T) {
	rt := sharedTestRuntime(t)
	b := newTestBroker(t, rt, Pool{})
	out := mustPoll(t, b)
	if len(out) == 0 || out[0].Kind != OutputSendText || !strings.Contains(string(out[0].Text), `"core.capabilities"`) {
		t.Fatalf("start outputs = %+v", out)
	}
	id, err := b.Open([]byte(`{"capability":"gallery.pick","params":{"mediaTypes":["photo"],"maxCount":1},"moduleInstanceId":"m1","activationId":1}`), nil, 1)
	if err != nil {
		t.Fatal(err)
	}
	if live, _ := b.IsLive(id); !live {
		t.Fatal("opened request not live")
	}
	mustPoll(t, b)
	photo := bytes.Repeat([]byte{7, 8, 9}, 30000)
	if ok, err := b.OnText([]byte(fmt.Sprintf(`{"type":"deviceEvent","id":%d,"event":{"kind":"blobStart","channel":0,"contentType":"image/jpeg","bytes":%d}}`, id, len(photo))), 2); !ok || err != nil {
		t.Fatalf("blobStart: %v %v", ok, err)
	}
	for i, off := 0, 0; off < len(photo); i++ {
		end := off + 65536
		if end > len(photo) {
			end = len(photo)
		}
		if ok, err := b.OnFrame(testFrame(id, uint32(i), photo[off:end]), 3); !ok || err != nil {
			t.Fatalf("frame %d: %v %v", i, ok, err)
		}
		off = end
	}
	if ok, _ := b.OnText([]byte(fmt.Sprintf(`{"type":"deviceResponse","id":%d,"result":{"items":[{"channel":0,"contentType":"image/jpeg","bytes":%d,"sha256":"%s"}]}}`, id, len(photo), hexSHA(photo))), 4); !ok {
		t.Fatal("result rejected")
	}
	var settled *Output
	for _, o := range mustPoll(t, b) {
		if o.Kind == OutputSettled && o.ID == id {
			oc := o
			settled = &oc
		}
	}
	if settled == nil || !settled.Outcome.OK || len(settled.Outcome.Blobs) != 1 || !bytes.Equal(settled.Outcome.Blobs[0].Bytes, photo) {
		t.Fatalf("settled = %+v", settled)
	}
}

// Regression: file.save of more than ~2 KiB trapped the broker under
// wazero v1.8.2's compiler (out of bounds memory access in
// hypen_device_broker_open); the SDK requires wazero ≥ v1.9.0.
func TestBrokerLargeDownload(t *testing.T) {
	rt := sharedTestRuntime(t)
	b := newTestBroker(t, rt, Pool{})
	mustPoll(t, b)
	data := bytes.Repeat([]byte("large download "), 20000) // 300 KB
	params, _ := json.Marshal(FileSaveParams{Channel: 0, Name: "big.txt", ContentType: "text/plain", Bytes: uint64(len(data)), Sha256: hexSHA(data)})
	spec := fmt.Sprintf(`{"capability":"file.save","params":%s,"moduleInstanceId":"m1","activationId":1}`, params)
	id, err := b.Open([]byte(spec), data, 1)
	if err != nil {
		t.Fatal(err)
	}
	if out := mustPoll(t, b); len(out) == 0 {
		t.Fatal("no deviceRequest")
	}
	if ok, err := b.OnText([]byte(fmt.Sprintf(`{"type":"deviceEvent","id":%d,"control":{"grant":1048576}}`, id)), 2); !ok || err != nil {
		t.Fatalf("grant: %v %v", ok, err)
	}
	var got []byte
	for i := 0; i < 64 && len(got) < len(data); i++ {
		for _, o := range mustPoll(t, b) {
			if o.Kind == OutputSendFrame {
				if len(o.Bytes) > FrameHeaderLen+64*1024 {
					t.Fatalf("frame of %d bytes", len(o.Bytes))
				}
				got = append(got, o.Bytes[12:]...)
			}
		}
		if _, _, err := b.Tick(3); err != nil {
			t.Fatal(err)
		}
	}
	if !bytes.Equal(got, data) {
		t.Fatalf("downloaded %d/%d bytes", len(got), len(data))
	}
	if ok, _ := b.OnText([]byte(fmt.Sprintf(`{"type":"deviceResponse","id":%d,"result":{"bytesWritten":%d}}`, id, len(data))), 4); !ok {
		t.Fatal("receipt rejected")
	}
	found := false
	for _, o := range mustPoll(t, b) {
		if o.Kind == OutputSettled && o.ID == id && o.Outcome.OK {
			found = true
		}
	}
	if !found {
		t.Fatal("download did not settle ok")
	}
}

func TestBrokerRefusalsAndQueries(t *testing.T) {
	rt := sharedTestRuntime(t)
	b := newTestBroker(t, rt, Pool{})
	_, err := b.Open([]byte(`{"capability":"camera.capture","params":{"mode":"photo"},"moduleInstanceId":"m1","activationId":1}`), nil, 1)
	var ref *Refusal
	if !errors.As(err, &ref) || ref.Code != ErrorUnsupported {
		t.Fatalf("unselected capability: %v", err)
	}
	_, err = b.Open([]byte(`{"capability":"permission.query","params":{"permission":"camera"},"moduleInstanceId":"m1","activationId":9}`), nil, 1)
	if !errors.As(err, &ref) || ref.Code != ErrorUnavailable || ref.Detail != "owner-inactive" {
		t.Fatalf("stale activation: %v", err)
	}
	_, err = b.Open([]byte(`{"capability":"permission.query","params":{"permission":"camera"},"moduleInstanceId":"m1","activationId":1,"replayed":true}`), nil, 1)
	if !errors.As(err, &ref) || ref.Code != ErrorUnavailable || ref.Detail != "syncActions.replay" {
		t.Fatalf("replayed: %v", err)
	}
	// Malformed open JSON is a host error, not a refusal.
	_, err = b.Open([]byte(`{"capability":1}`), nil, 1)
	var abi *ABIError
	if !errors.As(err, &abi) || abi.Status != abiErrJSON {
		t.Fatalf("malformed spec: %v", err)
	}
	if ok, _ := b.Supports("gallery.pick"); !ok {
		t.Fatal("supports")
	}
	if v, ok, _ := b.SelectedVersion("gallery.pick"); !ok || v != 1 {
		t.Fatal("selected version")
	}
	if _, ok, _ := b.SelectedVersion("camera.capture"); ok {
		t.Fatal("unselected version")
	}
	if active, _ := b.OwnerIsActive("m1", 1); !active {
		t.Fatal("owner active")
	}
	if admits, _ := b.AdmitsBackground("m1"); !admits {
		t.Fatal("admits background")
	}
	if has, _ := b.HasBackgroundWork("m1"); has {
		t.Fatal("background work")
	}
	info, err := b.Info()
	if err != nil || info["started"] != true {
		t.Fatalf("info %v %v", info, err)
	}
	if err := b.ReportViolation("host-detected", 2); err != nil {
		t.Fatal(err)
	}
	info, _ = b.Info()
	if info["connectionViolations"].(float64) != 1 {
		t.Fatalf("violations = %v", info["connectionViolations"])
	}
	// Owner sweeps: deactivation cancels the activation's request.
	id, err := b.Open([]byte(`{"capability":"permission.query","params":{"permission":"camera"},"moduleInstanceId":"m1","activationId":1}`), nil, 3)
	if err != nil {
		t.Fatal(err)
	}
	mustPoll(t, b)
	if err := b.OwnerDeactivated("m1", 1, 4); err != nil {
		t.Fatal(err)
	}
	var code DeviceErrorCode
	for _, o := range mustPoll(t, b) {
		if o.Kind == OutputSettled && o.ID == id {
			code = o.Outcome.Code
		}
	}
	if code != ErrorCancelled {
		t.Fatalf("swept outcome = %q", code)
	}
	if err := b.OwnerDestroyed("m1", 5); err != nil {
		t.Fatal(err)
	}
	if ok, _ := b.OwnerActivated("m1", 2, 6); ok {
		t.Fatal("destroyed module re-activated")
	}
}

func TestBrokerCloseDestroyAndPools(t *testing.T) {
	rt := sharedTestRuntime(t)
	pool, err := rt.NewPool(1 << 20)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rt.DestroyPool(pool) }()
	b := newTestBroker(t, rt, pool)
	id, err := b.Open([]byte(`{"capability":"gallery.pick","params":{"mediaTypes":["photo"],"maxCount":1},"moduleInstanceId":"m1","activationId":1}`), nil, 1)
	if err != nil {
		t.Fatal(err)
	}
	mustPoll(t, b)
	_, _ = b.OnText([]byte(fmt.Sprintf(`{"type":"deviceEvent","id":%d,"event":{"kind":"blobStart","channel":0,"contentType":"image/jpeg","bytes":5000}}`, id)), 2)
	_, _ = b.OnFrame(testFrame(id, 0, make([]byte, 5000)), 2)
	if n, err := rt.PoolInUse(pool); err != nil || n == 0 {
		t.Fatalf("pool in use = %d %v", n, err)
	}
	if err := b.Close(ErrorConnectionLost); err != nil {
		t.Fatal(err)
	}
	var code DeviceErrorCode
	for _, o := range mustPoll(t, b) {
		if o.Kind == OutputSettled && o.ID == id {
			code = o.Outcome.Code
		}
	}
	if code != ErrorConnectionLost {
		t.Fatalf("close outcome = %q", code)
	}
	if n, _ := rt.PoolInUse(pool); n != 0 {
		t.Fatalf("pool not released: %d", n)
	}
	if next, ok, err := b.Tick(9); err != nil || ok {
		t.Fatalf("closed broker has deadlines: %d %v %v", next, ok, err)
	}
	if err := b.Destroy(); err != nil {
		t.Fatal(err)
	}
	if err := b.Destroy(); err != nil {
		t.Fatal("destroy is not idempotent")
	}
	if _, err := b.Poll(); !errors.Is(err, ErrBrokerClosed) {
		t.Fatalf("poll after destroy: %v", err)
	}
	if err := rt.DestroyPool(Pool{handle: 999999}); err == nil {
		t.Fatal("unknown pool accepted")
	}
}

func TestBrokerIsOversizeText(t *testing.T) {
	rt := sharedTestRuntime(t)
	small := []byte(`{"type":"deviceEvent","id":1}`)
	if over, _ := rt.IsOversizeText(small); over {
		t.Fatal("small text oversize")
	}
	pad := strings.Repeat("x", MaxMessageBytes)
	if over, _ := rt.IsOversizeText([]byte(`{"type":"deviceEvent","pad":"` + pad + `"}`)); !over {
		t.Fatal("oversize device text not detected")
	}
	if over, _ := rt.IsOversizeText([]byte(`{"type":"dispatchAction","pad":"` + pad + `"}`)); over {
		t.Fatal("oversize UI text classified as device text")
	}
}

func TestDecodeFramedOutputsRejectsBadFraming(t *testing.T) {
	frame := func(header string, payload []byte) []byte {
		b := make([]byte, 4, 4+len(header)+len(payload))
		binary.LittleEndian.PutUint32(b, uint32(len(header)))
		b = append(b, header...)
		return append(b, payload...)
	}
	good := frame(`[{"type":"sendFrame","offset":0,"len":3},{"type":"closeConnection","code":1012,"reason":"r"}]`, []byte{1, 2, 3})
	out, err := DecodeFramedOutputs(good)
	if err != nil || len(out) != 2 || !bytes.Equal(out[0].Bytes, []byte{1, 2, 3}) || out[1].Code != 1012 {
		t.Fatalf("good framing: %+v %v", out, err)
	}
	for name, raw := range map[string][]byte{
		"short":            {1, 0},
		"header too long":  {200, 0, 0, 0, '[', ']'},
		"not json":         frame(`nope`, nil),
		"payload overflow": frame(`[{"type":"data","id":1,"offset":2,"len":5}]`, []byte{1, 2}),
		"negative":         frame(`[{"type":"data","id":1,"offset":-1,"len":1}]`, []byte{1}),
		"unknown type":     frame(`[{"type":"teleport"}]`, nil),
		"settled no oc":    frame(`[{"type":"settled","id":1}]`, nil),
	} {
		if _, err := DecodeFramedOutputs(raw); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

// A BrokerModule compiles the engine module once; every NewRuntime is an
// isolated instance. A trap poisons only the instance it happened in: its
// brokers fail with ErrBrokerRuntimeFailed while another instance's broker
// (mid-request) carries on, and new instances still work.
func TestBrokerModuleInstancesIsolateTraps(t *testing.T) {
	wasm, err := os.ReadFile("../../hypen_engine.wasm")
	if err != nil {
		t.Fatal(err)
	}
	m, err := CompileBrokerModule(wasm)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = m.Close() })
	newRT := func() *BrokerRuntime {
		rt, err := m.NewRuntime()
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = rt.Close() })
		return rt
	}
	rtA, rtB := newRT(), newRT()
	a, b := newTestBroker(t, rtA, Pool{}), newTestBroker(t, rtB, Pool{})
	mustPoll(t, a)
	mustPoll(t, b)
	// Handles are per instance: both instances hand out the same numbers.
	idB, err := b.Open([]byte(`{"capability":"permission.query","params":{"permission":"camera"},"moduleInstanceId":"m1","activationId":1}`), nil, 1)
	if err != nil {
		t.Fatal(err)
	}
	mustPoll(t, b)

	if err := rtA.TrapForTesting(); err != nil {
		t.Fatal(err)
	}
	if rtA.Err() == nil {
		t.Fatal("the trapped instance is not marked failed")
	}
	if _, err := a.Poll(); !errors.Is(err, ErrBrokerRuntimeFailed) {
		t.Fatalf("broker in the trapped instance: %v", err)
	}

	if rtB.Err() != nil {
		t.Fatalf("the other instance was poisoned: %v", rtB.Err())
	}
	if ok, err := b.OnText([]byte(fmt.Sprintf(`{"type":"deviceResponse","id":%d,"result":{"status":"granted"}}`, idB)), 2); !ok || err != nil {
		t.Fatalf("other instance's response: %v %v", ok, err)
	}
	settled := false
	for _, o := range mustPoll(t, b) {
		if o.Kind == OutputSettled && o.ID == idB && o.Outcome.OK {
			settled = true
		}
	}
	if !settled {
		t.Fatal("the other instance's request did not settle ok")
	}

	// A fresh instance of the same compiled module works.
	c := newTestBroker(t, newRT(), Pool{})
	if _, err := c.Poll(); err != nil {
		t.Fatal(err)
	}
	if err := rtA.Close(); err != nil {
		t.Fatal(err)
	}
	if err := rtA.Close(); err != nil {
		t.Fatal("Close must be idempotent")
	}
	if err := m.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := m.NewRuntime(); err == nil {
		t.Fatal("a closed module must refuse new instances")
	}
}

// Results opened with holdResult keep their retained-bytes charge after
// settling (Outcome.Held) until ReleaseResult, which is idempotent.
func TestBrokerHoldResultAndRelease(t *testing.T) {
	rt := sharedTestRuntime(t)
	pool, err := rt.NewPool(1 << 20)
	if err != nil {
		t.Fatal(err)
	}
	b := newTestBroker(t, rt, pool)
	mustPoll(t, b)
	photo := bytes.Repeat([]byte{9}, 5000)
	id, err := b.Open([]byte(`{"capability":"gallery.pick","params":{"mediaTypes":["photo"],"maxCount":1},"moduleInstanceId":"m1","activationId":1,"holdResult":true}`), nil, 1)
	if err != nil {
		t.Fatal(err)
	}
	mustPoll(t, b)
	b.OnText([]byte(fmt.Sprintf(`{"type":"deviceEvent","id":%d,"event":{"kind":"blobStart","channel":0,"contentType":"image/jpeg","bytes":%d}}`, id, len(photo))), 2)
	b.OnFrame(testFrame(id, 0, photo), 2)
	b.OnText([]byte(fmt.Sprintf(`{"type":"deviceResponse","id":%d,"result":{"items":[{"channel":0,"contentType":"image/jpeg","bytes":%d,"sha256":"%s"}]}}`, id, len(photo), hexSHA(photo))), 3)
	var held bool
	for _, o := range mustPoll(t, b) {
		if o.Kind == OutputSettled && o.ID == id {
			if !o.Outcome.OK {
				t.Fatalf("outcome %+v", o.Outcome)
			}
			held = o.Outcome.Held
		}
	}
	if !held {
		t.Fatal("a holdResult upload must settle held")
	}
	if n, _ := rt.PoolInUse(pool); n < uint64(len(photo)) {
		t.Fatalf("held result charge %d, want >= %d", n, len(photo))
	}
	if err := b.ReleaseResult(id); err != nil {
		t.Fatal(err)
	}
	if err := b.ReleaseResult(id); err != nil {
		t.Fatal(err)
	}
	if n, _ := rt.PoolInUse(pool); n != 0 {
		t.Fatalf("after release: %d bytes still charged", n)
	}
}
