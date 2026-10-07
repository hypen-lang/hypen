package core_test

// Device broker (RFC 001) binding tests for the Go SDK: the `hypen_device_*`
// WASI C ABI of the SHIPPED engine module — hypen_engine.wasm in this
// directory, the exact file embed.go bakes into the SDK — driven through
// wazero the way the SDK's native layer drives it: handles, (ptr, len)
// strings in linear memory, the device result/last-error buffers, and the
// framed poll output `[u32 LE header_len][JSON array][payload bytes]` whose
// byte-carrying outputs reference the payload through offset/len.
//
// Rebuild the module with `cd hypen-engine-rs && ./build-wasm.sh`.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
	"github.com/tetratelabs/wazero/imports/wasi_snapshot_preview1"
)

// ABI status codes (hypen-engine-rs/src/wasm/wasi_device.rs).
const (
	abiErrHandle = -2
	abiErrInput  = -3
	abiErrJSON   = -4
)

type abiEnv struct {
	t   *testing.T
	ctx context.Context
	m   api.Module
}

func abiLoad(t *testing.T) *abiEnv {
	t.Helper()
	wasm, err := os.ReadFile("hypen_engine.wasm")
	if err != nil {
		t.Fatalf("read shipped engine module: %v", err)
	}
	ctx := context.Background()
	rt := wazero.NewRuntime(ctx)
	t.Cleanup(func() { rt.Close(ctx) })
	if _, err := wasi_snapshot_preview1.Instantiate(ctx, rt); err != nil {
		t.Fatal(err)
	}
	m, err := rt.InstantiateWithConfig(ctx, wasm, wazero.NewModuleConfig())
	if err != nil {
		t.Fatal(err)
	}
	return &abiEnv{t: t, ctx: ctx, m: m}
}

func (e *abiEnv) call(name string, args ...uint64) uint64 {
	e.t.Helper()
	f := e.m.ExportedFunction(name)
	if f == nil {
		e.t.Fatalf("the engine module does not export %s", name)
	}
	r, err := f.Call(e.ctx, args...)
	if err != nil {
		e.t.Fatalf("%s: %v", name, err)
	}
	if len(r) == 0 {
		return 0
	}
	return r[0]
}

// i32 / i64 reinterpret a raw wazero result as the signed ABI value.
func (e *abiEnv) i32(name string, args ...uint64) int32 { return int32(uint32(e.call(name, args...))) }
func (e *abiEnv) i64(name string, args ...uint64) int64 { return int64(e.call(name, args...)) }

// put copies b into freshly allocated linear memory: (ptr, len).
func (e *abiEnv) put(b []byte) (uint64, uint64) {
	e.t.Helper()
	if len(b) == 0 {
		return 0, 0
	}
	p := uint32(e.call("wasi_alloc", uint64(len(b))))
	if !e.m.Memory().Write(p, b) {
		e.t.Fatal("memory write out of range")
	}
	return uint64(p), uint64(len(b))
}

func (e *abiEnv) putS(s string) (uint64, uint64) { return e.put([]byte(s)) }

func (e *abiEnv) readBuf(lenFn, copyFn string) []byte {
	e.t.Helper()
	n := uint32(e.call(lenFn))
	if n == 0 {
		return nil
	}
	p := uint32(e.call("wasi_alloc", uint64(n)))
	if got := uint32(e.call(copyFn, uint64(p), uint64(n))); got != n {
		e.t.Fatalf("%s copied %d of %d bytes", copyFn, got, n)
	}
	b, ok := e.m.Memory().Read(p, n)
	if !ok {
		e.t.Fatal("memory read out of range")
	}
	out := append([]byte(nil), b...)
	e.call("wasi_free", uint64(p), uint64(n))
	return out
}

func (e *abiEnv) result() []byte {
	return e.readBuf("hypen_device_result_len", "hypen_device_result")
}

func (e *abiEnv) resultJSON(v any) {
	e.t.Helper()
	if err := json.Unmarshal(e.result(), v); err != nil {
		e.t.Fatalf("device result is not JSON: %v", err)
	}
}

func (e *abiEnv) lastError() string {
	return string(e.readBuf("hypen_device_last_error_len", "hypen_device_last_error"))
}

type abiOutput struct {
	Type    string          `json:"type"`
	Text    string          `json:"text"`
	ID      uint32          `json:"id"`
	Channel uint16          `json:"channel"`
	Offset  int             `json:"offset"`
	Len     int             `json:"len"`
	Code    int             `json:"code"`
	Reason  string          `json:"reason"`
	Event   json.RawMessage `json:"event"`
	Outcome json.RawMessage `json:"outcome"`
}

type abiBlob struct {
	Channel     uint16 `json:"channel"`
	ContentType string `json:"contentType"`
	Offset      int    `json:"offset"`
	Len         int    `json:"len"`
}

type abiOutcome struct {
	Ok     bool            `json:"ok"`
	Code   string          `json:"code"`
	Detail string          `json:"detail"`
	Result json.RawMessage `json:"result"`
	Blobs  []abiBlob       `json:"blobs"`
}

// abiBroker is one broker handle plus everything its polls produced.
type abiBroker struct {
	e       *abiEnv
	h       uint64
	sent    []map[string]any
	frames  [][]byte
	data    map[uint32][]byte
	settled map[uint32]abiOutcome
	blobs   map[uint32][][]byte
	closed  *abiOutput
}

func (e *abiEnv) broker(config string, pool uint64, now uint64) *abiBroker {
	e.t.Helper()
	p, l := e.putS(config)
	h := uint32(e.call("hypen_device_broker_create", p, l, pool, now))
	if h == 0 {
		e.t.Fatalf("broker_create: %s", e.lastError())
	}
	return &abiBroker{
		e: e, h: uint64(h),
		data:    map[uint32][]byte{},
		settled: map[uint32]abiOutcome{},
		blobs:   map[uint32][][]byte{},
	}
}

func (b *abiBroker) open(spec string, download []byte, now uint64) (id uint32, refusal map[string]any) {
	b.e.t.Helper()
	sp, sl := b.e.putS(spec)
	var dp, dl, has uint64
	if download != nil {
		dp, dl = b.e.put(download)
		has = 1
	}
	if st := b.e.i32("hypen_device_broker_open", b.h, sp, sl, dp, dl, has, now); st != 0 {
		b.e.t.Fatalf("broker_open status %d: %s", st, b.e.lastError())
	}
	var r struct {
		ID    *uint32        `json:"id"`
		Error map[string]any `json:"error"`
	}
	b.e.resultJSON(&r)
	if r.ID != nil {
		return *r.ID, nil
	}
	return 0, r.Error
}

func (b *abiBroker) mustOpen(spec string, download []byte, now uint64) uint32 {
	b.e.t.Helper()
	id, refusal := b.open(spec, download, now)
	if refusal != nil {
		b.e.t.Fatalf("open refused: %v", refusal)
	}
	return id
}

func (b *abiBroker) text(s string, now uint64) bool {
	b.e.t.Helper()
	p, l := b.e.putS(s)
	return b.e.i32("hypen_device_broker_on_text", b.h, p, l, now) == 1
}

func (b *abiBroker) frame(f []byte, now uint64) bool {
	b.e.t.Helper()
	p, l := b.e.put(f)
	return b.e.i32("hypen_device_broker_on_frame", b.h, p, l, now) == 1
}

func (b *abiBroker) activate(mid string, aid uint32, now uint64) bool {
	p, l := b.e.putS(mid)
	return b.e.i32("hypen_device_broker_owner_activated", b.h, p, l, uint64(aid), now) == 1
}

// drain polls until the broker has nothing left, collecting every output.
func (b *abiBroker) drain() []abiOutput {
	b.e.t.Helper()
	var all []abiOutput
	for i := 0; i < 64; i++ {
		// poll answers the number of outputs, or a negative error.
		n := b.e.i32("hypen_device_broker_poll", b.h)
		if n < 0 {
			b.e.t.Fatalf("poll status %d: %s", n, b.e.lastError())
		}
		buf := b.e.result()
		if len(buf) < 4 {
			b.e.t.Fatalf("poll framing too short: %d bytes", len(buf))
		}
		hl := binary.LittleEndian.Uint32(buf[:4])
		var outs []abiOutput
		if err := json.Unmarshal(buf[4:4+hl], &outs); err != nil {
			b.e.t.Fatalf("poll header: %v", err)
		}
		payload := buf[4+hl:]
		if len(outs) != int(n) {
			b.e.t.Fatalf("poll answered %d outputs but framed %d", n, len(outs))
		}
		if len(outs) == 0 {
			if len(payload) != 0 {
				b.e.t.Fatal("an empty poll carries payload bytes")
			}
			return all
		}
		for _, o := range outs {
			switch o.Type {
			case "sendText":
				var m map[string]any
				if err := json.Unmarshal([]byte(o.Text), &m); err != nil {
					b.e.t.Fatalf("sendText is not JSON: %v", err)
				}
				b.sent = append(b.sent, m)
			case "sendFrame":
				b.frames = append(b.frames, append([]byte(nil), payload[o.Offset:o.Offset+o.Len]...))
			case "data":
				b.data[o.ID] = append(b.data[o.ID], payload[o.Offset:o.Offset+o.Len]...)
			case "settled":
				var oc abiOutcome
				if err := json.Unmarshal(o.Outcome, &oc); err != nil {
					b.e.t.Fatal(err)
				}
				b.settled[o.ID] = oc
				for _, bl := range oc.Blobs {
					b.blobs[o.ID] = append(b.blobs[o.ID], append([]byte(nil), payload[bl.Offset:bl.Offset+bl.Len]...))
				}
			case "closeConnection":
				oc := o
				b.closed = &oc
			case "event":
			default:
				b.e.t.Fatalf("unknown output type %q", o.Type)
			}
		}
		all = append(all, outs...)
	}
	b.e.t.Fatal("broker never drained")
	return nil
}

// sentFor returns the messages sent for request id with the given type.
func (b *abiBroker) sentFor(id uint32, typ string) []map[string]any {
	var out []map[string]any
	for _, m := range b.sent {
		if m["type"] == typ && uint32(m["id"].(float64)) == id {
			out = append(out, m)
		}
	}
	return out
}

func (b *abiBroker) info() map[string]any {
	b.e.t.Helper()
	if st := b.e.i32("hypen_device_broker_info", b.h); st != 0 {
		b.e.t.Fatalf("info status %d", st)
	}
	var m map[string]any
	b.e.resultJSON(&m)
	return m
}

func abiFrame(id uint32, ch uint16, seq uint32, p []byte) []byte {
	f := make([]byte, 12+len(p))
	f[0] = 1 // frame version
	binary.LittleEndian.PutUint16(f[2:], ch)
	binary.LittleEndian.PutUint32(f[4:], id)
	binary.LittleEndian.PutUint32(f[8:], seq)
	copy(f[12:], p)
	return f
}

const abiHello = `{"protocolVersions":[1],"binary":true,"capabilities":[` +
	`{"name":"core.capabilities","versions":[1]},{"name":"gallery.pick","versions":[1]},` +
	`{"name":"file.save","versions":[1]},{"name":"bluetooth.scan","versions":[1]},` +
	`{"name":"permission.query","versions":[1]}]}`

func abiNegotiate(t *testing.T, e *abiEnv) string {
	t.Helper()
	p, l := e.putS(abiHello)
	if st := e.i32("hypen_device_negotiate", p, l, 1); st != 0 {
		t.Fatalf("negotiate: %s", e.lastError())
	}
	return string(e.result())
}

func abiStarted(t *testing.T, e *abiEnv, extraConfig string, pool uint64) *abiBroker {
	t.Helper()
	ack := abiNegotiate(t, e)
	b := e.broker(`{"ack":`+ack+extraConfig+`}`, pool, 0)
	if st := e.i32("hypen_device_broker_start", b.h, 0); st != 0 {
		t.Fatalf("start: %s", e.lastError())
	}
	var core struct {
		ID *uint32 `json:"id"`
	}
	e.resultJSON(&core)
	if core.ID == nil {
		t.Fatal("start did not open core.capabilities")
	}
	if !b.activate("m1", 1, 0) {
		t.Fatal("activation refused")
	}
	b.drain()
	if len(b.sentFor(*core.ID, "deviceRequest")) != 1 {
		t.Fatal("core.capabilities request not sent")
	}
	return b
}

func TestDeviceBrokerABI_HandshakeHelpers(t *testing.T) {
	e := abiLoad(t)
	var ack struct {
		ProtocolVersion int  `json:"protocolVersion"`
		Binary          bool `json:"binary"`
		Capabilities    []struct {
			Name    string `json:"name"`
			Version int    `json:"version"`
		} `json:"capabilities"`
	}
	if err := json.Unmarshal([]byte(abiNegotiate(t, e)), &ack); err != nil {
		t.Fatal(err)
	}
	if ack.ProtocolVersion != 1 || !ack.Binary || len(ack.Capabilities) != 5 {
		t.Fatalf("ack %+v", ack)
	}

	// D7: a duplicate capability disables device access (null ack).
	dup := strings.Replace(abiHello, `]}]}`, `]},{"name":"file.save","versions":[1]}]}`, 1)
	p, l := e.putS(dup)
	e.call("hypen_device_negotiate", p, l, 1)
	if string(e.result()) != "null" {
		t.Fatal("a duplicate capability must disable device access")
	}

	p, l = e.putS(abiHello)
	e.call("hypen_device_validate_hello", p, l)
	var v struct {
		Ok bool `json:"ok"`
	}
	e.resultJSON(&v)
	if !v.Ok {
		t.Fatal("valid hello rejected")
	}

	sp, sl := e.putS(`{"protocolVersions":[1],"capabilities":[{"name":"core.capabilities","versions":[1]}],"binary":false}`)
	p, l = e.putS(abiHello)
	if st := e.i32("hypen_device_select_ack", p, l, sp, sl); st != 0 {
		t.Fatal(e.lastError())
	}
	var sel struct {
		Binary       bool             `json:"binary"`
		Capabilities []map[string]any `json:"capabilities"`
	}
	e.resultJSON(&sel)
	if sel.Binary || len(sel.Capabilities) != 1 {
		t.Fatalf("select_ack %+v", sel)
	}
	bad, bl := e.putS(`{"protocolVersions":[1]}`)
	if st := e.i32("hypen_device_select_ack", p, l, bad, bl); st != abiErrJSON {
		t.Fatalf("malformed server list: status %d", st)
	}

	e.call("hypen_device_constants")
	var c map[string]any
	e.resultJSON(&c)
	if c["devicePlaneCloseCode"].(float64) != 1012 || c["frameHeaderLen"].(float64) != 12 {
		t.Fatalf("constants %v", c)
	}
	e.call("hypen_device_server_advertisement")
	var adv []map[string]any
	e.resultJSON(&adv)
	if adv[0]["name"] != "core.capabilities" {
		t.Fatalf("advertisement %v", adv)
	}

	p, l = e.putS("abc")
	e.call("hypen_device_sha256_hex", p, l)
	if got := string(e.result()); got != "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" {
		t.Fatalf("sha256 %s", got)
	}
	p, l = e.putS(`{"type":"deviceEvent"}`)
	if e.i32("hypen_device_is_oversize_text", p, l) != 0 {
		t.Fatal("small text reported oversize")
	}
}

func TestDeviceBrokerABI_UploadAndDownload(t *testing.T) {
	e := abiLoad(t)
	b := abiStarted(t, e, "", 0)

	// Upload: gallery.pick, one declared photo in two frames.
	id := b.mustOpen(`{"capability":"gallery.pick","params":{"mediaTypes":["photo"],"maxCount":1},"moduleInstanceId":"m1","activationId":1}`, nil, 1)
	b.drain()
	req := b.sentFor(id, "deviceRequest")
	if len(req) != 1 || req[0]["capability"] != "gallery.pick" {
		t.Fatalf("upload request %v", req)
	}
	photo := make([]byte, 70000)
	for i := range photo {
		photo[i] = byte(i * 7)
	}
	sum := sha256.Sum256(photo)
	if !b.text(fmt.Sprintf(`{"type":"deviceEvent","id":%d,"event":{"kind":"blobStart","channel":0,"contentType":"image/jpeg","bytes":%d}}`, id, len(photo)), 2) {
		t.Fatal("blobStart rejected")
	}
	if !b.frame(abiFrame(id, 0, 0, photo[:65536]), 3) || !b.frame(abiFrame(id, 0, 1, photo[65536:]), 3) {
		t.Fatal("frame rejected")
	}
	if !b.text(fmt.Sprintf(`{"type":"deviceResponse","id":%d,"result":{"items":[{"channel":0,"contentType":"image/jpeg","bytes":%d,"sha256":"%s"}]}}`, id, len(photo), hex.EncodeToString(sum[:])), 4) {
		t.Fatal("result rejected")
	}
	b.drain()
	up, ok := b.settled[id]
	if !ok || !up.Ok || len(up.Blobs) != 1 || up.Blobs[0].ContentType != "image/jpeg" {
		t.Fatalf("upload outcome %+v", up)
	}
	if !bytes.Equal(b.blobs[id][0], photo) {
		t.Fatal("uploaded bytes differ from the frames sent")
	}
	if e.i32("hypen_device_broker_is_live", b.h, uint64(id)) != 0 {
		t.Fatal("settled upload still live")
	}

	// Download: file.save announces, waits for a grant, sends frames.
	data := []byte("bytes for the client, from the Go SDK's broker")
	np, nl := e.putS("d.txt")
	cp, cl := e.putS("text/plain")
	dp, dl := e.put(data)
	e.call("hypen_device_file_save_params", np, nl, cp, cl, dp, dl)
	params := string(e.result())
	dlID := b.mustOpen(`{"capability":"file.save","params":`+params+`,"moduleInstanceId":"m1","activationId":1}`, data, 5)
	b.drain()
	if len(b.frames) != 0 {
		t.Fatal("download frames sent before any grant")
	}
	if dreq := b.sentFor(dlID, "deviceRequest"); len(dreq) != 1 || dreq[0]["initialCredit"].(float64) != 0 {
		t.Fatalf("download request %v", dreq)
	}
	if !b.text(fmt.Sprintf(`{"type":"deviceEvent","id":%d,"control":{"grant":65536}}`, dlID), 6) {
		t.Fatal("grant rejected")
	}
	b.drain()
	var got []byte
	for _, f := range b.frames {
		if binary.LittleEndian.Uint32(f[4:8]) != dlID {
			t.Fatal("frame for the wrong request")
		}
		got = append(got, f[12:]...)
	}
	if !bytes.Equal(got, data) {
		t.Fatalf("download bytes %q", got)
	}
	b.text(fmt.Sprintf(`{"type":"deviceResponse","id":%d,"result":{"bytesWritten":%d}}`, dlID, len(data)), 7)
	b.drain()
	if !b.settled[dlID].Ok {
		t.Fatalf("download outcome %+v", b.settled[dlID])
	}

	info := b.info()
	if info["liveCount"].(float64) != 1 || info["retainedBytes"].(float64) != 0 {
		t.Fatalf("info %v", info)
	}
	if dead := e.i64("hypen_device_broker_tick", b.h, 8); dead <= 8 {
		t.Fatalf("next deadline %d", dead)
	}
	cp, cl = e.putS("connectionLost")
	if st := e.i32("hypen_device_broker_close", b.h, cp, cl); st != 0 {
		t.Fatal(e.lastError())
	}
	if !b.info()["closed"].(bool) {
		t.Fatal("close did not close the broker")
	}
	if e.i32("hypen_device_broker_destroy", b.h) != 0 {
		t.Fatal("destroy")
	}
	if e.i32("hypen_device_broker_destroy", b.h) != abiErrHandle {
		t.Fatal("double destroy must report an unknown handle")
	}
}

func TestDeviceBrokerABI_RefusalsErrorsAndPools(t *testing.T) {
	e := abiLoad(t)
	pool := e.call("hypen_device_pool_create", 1<<20)
	if uint32(pool) == 0 {
		t.Fatal("pool_create")
	}
	b := abiStarted(t, e, `,"maxRetainedBytes":8192`, pool)
	other := abiStarted(t, e, "", pool)

	// Replay firewall: replayed dispatch is refused as a value.
	_, refusal := b.open(`{"capability":"gallery.pick","params":{"mediaTypes":["photo"],"maxCount":1},"moduleInstanceId":"m1","activationId":1,"replayed":true}`, nil, 1)
	if refusal == nil || refusal["code"] != "unavailable" {
		t.Fatalf("replayed open: %v", refusal)
	}
	// Activation authority: a stale activation is refused.
	if _, refusal = b.open(`{"capability":"permission.query","params":{"permission":"camera"},"moduleInstanceId":"m1","activationId":7}`, nil, 1); refusal == nil {
		t.Fatal("a stale activation must be refused")
	}
	// Host errors are statuses with a message.
	sp, sl := e.putS(`{"capability":"x","moduleInstanceId":"m1","activationId":1,"bogus":1}`)
	if st := e.i32("hypen_device_broker_open", b.h, sp, sl, 0, 0, 0, 1); st != abiErrJSON || e.lastError() == "" {
		t.Fatalf("unknown open member: status %d", st)
	}
	gp, gl := e.putS(`{"capability":"permission.query","params":{"permission":"camera"},"moduleInstanceId":"m1","activationId":1}`)
	if st := e.i32("hypen_device_broker_open", 9999, gp, gl, 0, 0, 0, 1); st != abiErrHandle {
		t.Fatalf("unknown handle: status %d", st)
	}
	cfg, cl := e.putS(`{"nope":1}`)
	if h := e.call("hypen_device_broker_create", cfg, cl, 0, 0); uint32(h) != 0 {
		t.Fatal("a config without ack must be refused")
	}
	bad := []byte{0xff, 0xfe}
	bp, bl := e.put(bad)
	if e.i32("hypen_device_broker_on_text", b.h, bp, bl, 1) != 0 {
		t.Fatal("non-UTF-8 device text must not be accepted")
	}
	if b.info()["connectionViolations"].(float64) < 1 {
		t.Fatal("non-UTF-8 device text must count as a connection violation")
	}

	// The shared pool is charged as bytes are declared and released by sweeps.
	id := b.mustOpen(`{"capability":"gallery.pick","params":{"mediaTypes":["photo"],"maxCount":1},"moduleInstanceId":"m1","activationId":1}`, nil, 1)
	b.text(fmt.Sprintf(`{"type":"deviceEvent","id":%d,"event":{"kind":"blobStart","channel":0,"contentType":"image/jpeg","bytes":4096}}`, id), 2)
	if in := e.i64("hypen_device_pool_in_use", pool); in < 4096 {
		t.Fatalf("pool in use %d after a 4096-byte blobStart", in)
	}
	mp, ml := e.putS("m1")
	e.call("hypen_device_broker_owner_destroyed", b.h, mp, ml, 3)
	b.drain()
	if oc := b.settled[id]; oc.Ok || oc.Code != "cancelled" {
		t.Fatalf("destroyed owner's upload: %+v", oc)
	}
	if len(b.sentFor(id, "deviceEvent")) == 0 {
		t.Fatal("a sweep must send cancel to the client")
	}
	if in := e.i64("hypen_device_pool_in_use", pool); in != 0 {
		t.Fatalf("pool in use %d after the sweep", in)
	}

	if e.i32("hypen_device_broker_destroy", other.h) != 0 || e.i32("hypen_device_broker_destroy", b.h) != 0 {
		t.Fatal("destroy")
	}
	if e.i32("hypen_device_pool_destroy", pool) != 0 {
		t.Fatal("pool_destroy")
	}
	if e.i64("hypen_device_pool_in_use", pool) != abiErrHandle {
		t.Fatal("destroyed pool must be an unknown handle")
	}
}

// abiReserving starts a pooled broker holding one 50000-byte upload
// declaration (blobStart plus one received frame).
func abiReserving(t *testing.T, e *abiEnv, pool uint64) *abiBroker {
	t.Helper()
	b := abiStarted(t, e, "", pool)
	id := b.mustOpen(`{"capability":"gallery.pick","params":{"mediaTypes":["photo"],"maxCount":1},"moduleInstanceId":"m1","activationId":1}`, nil, 1)
	if !b.text(fmt.Sprintf(`{"type":"deviceEvent","id":%d,"event":{"kind":"blobStart","channel":0,"contentType":"image/jpeg","bytes":50000}}`, id), 2) {
		t.Fatal("blobStart not accepted")
	}
	if !b.frame(abiFrame(id, 0, 0, make([]byte, 2000)), 3) {
		t.Fatal("frame not accepted")
	}
	if got := b.info()["retainedBytes"].(float64); got != 50000 {
		t.Fatalf("retained %v, want 50000", got)
	}
	return b
}

// Destroying a broker the host never closed (a connection torn down on an
// error path) hands its reservation back to the shared pool; destroying one
// that was closed releases nothing twice.
func TestDeviceBrokerABI_DestroyWithoutCloseReturnsPooledBytes(t *testing.T) {
	e := abiLoad(t)
	pool := e.call("hypen_device_pool_create", 1<<30)
	kept := abiReserving(t, e, pool)
	freed := abiReserving(t, e, pool)
	if in := e.i64("hypen_device_pool_in_use", pool); in != 100000 {
		t.Fatalf("pool in use %d, want 100000", in)
	}
	if e.i32("hypen_device_broker_destroy", freed.h) != 0 {
		t.Fatal("destroy")
	}
	if in := e.i64("hypen_device_pool_in_use", pool); in != 50000 {
		t.Fatalf("pool in use %d after destroy without close, want 50000", in)
	}
	cp, cl := e.putS("connectionLost")
	if e.i32("hypen_device_broker_close", kept.h, cp, cl) != 0 {
		t.Fatal("close")
	}
	if in := e.i64("hypen_device_pool_in_use", pool); in != 0 {
		t.Fatalf("pool in use %d after close, want 0", in)
	}
	other := abiReserving(t, e, pool)
	if e.i32("hypen_device_broker_destroy", kept.h) != 0 {
		t.Fatal("destroy after close")
	}
	if in := e.i64("hypen_device_pool_in_use", pool); in != 50000 {
		t.Fatalf("pool in use %d after destroying a closed broker, want 50000", in)
	}
	e.call("hypen_device_broker_destroy", other.h)
	if in := e.i64("hypen_device_pool_in_use", pool); in != 0 {
		t.Fatalf("pool in use %d, want 0", in)
	}
	e.call("hypen_device_pool_destroy", pool)
}

func TestDeviceBrokerABI_LeasesStreamsAndBackground(t *testing.T) {
	e := abiLoad(t)
	b := abiStarted(t, e, `,"revisionOverrides":[{"capability":"bluetooth.scan","version":1,"lifetimes":["activation","background"]}]`, 0)
	mp, ml := e.putS("m1")

	// A background scan stream with JSON events.
	if e.i32("hypen_device_broker_admits_background", b.h, mp, ml) != 1 {
		t.Fatal("background not admitted")
	}
	scan := b.mustOpen(`{"capability":"bluetooth.scan","moduleInstanceId":"m1","activationId":1,"lifetime":"background","initialCredit":4}`, nil, 0)
	b.drain()
	renewals := func() int {
		n := 0
		for _, m := range b.sentFor(scan, "deviceEvent") {
			if c, ok := m["control"].(map[string]any); ok {
				if _, ok := c["renewLease"]; ok {
					n++
				}
			}
		}
		return n
	}
	if renewals() != 1 {
		t.Fatal("renewLease 1 must follow the request immediately")
	}
	if !b.text(fmt.Sprintf(`{"type":"deviceEvent","id":%d,"event":{"device":{"id":"dev-1","name":"Heart Rate","rssi":-60}}}`, scan), 100) {
		t.Fatal("scan event rejected")
	}
	b.drain()
	if e.i64("hypen_device_broker_outstanding_event_credit", b.h, uint64(scan)) != 3 {
		t.Fatal("an event must spend one event credit")
	}
	if st := e.i32("hypen_device_broker_consumed_events", b.h, uint64(scan), 1, 101); st != 0 {
		t.Fatal("consumed_events")
	}
	b.drain()

	// Renewals follow the 5 s cadence as the host ticks.
	next := e.i64("hypen_device_broker_tick", b.h, 101)
	if next <= 101 || next > 5000 {
		t.Fatalf("next deadline %d", next)
	}
	e.i64("hypen_device_broker_tick", b.h, 5000)
	b.drain()
	if renewals() != 2 {
		t.Fatalf("renewals after 5 s: %d", renewals())
	}
	if !b.text(fmt.Sprintf(`{"type":"deviceEvent","id":%d,"control":{"leaseAck":2}}`, scan), 5001) {
		t.Fatal("leaseAck rejected")
	}

	// Deactivation keeps background work; destruction sweeps it.
	e.call("hypen_device_broker_owner_deactivated", b.h, mp, ml, 1, 5002)
	if e.i32("hypen_device_broker_is_live", b.h, uint64(scan)) != 1 ||
		e.i32("hypen_device_broker_has_background_work", b.h, mp, ml) != 1 {
		t.Fatal("deactivation must keep background work")
	}
	if e.i32("hypen_device_broker_owner_is_active", b.h, mp, ml, 1) != 0 {
		t.Fatal("deactivated owner still active")
	}

	// A fabricated leaseAck (a renewal never sent) is a violation that ends
	// the request.
	b.text(fmt.Sprintf(`{"type":"deviceEvent","id":%d,"control":{"leaseAck":99}}`, scan), 5003)
	b.drain()
	if oc, ok := b.settled[scan]; !ok || oc.Ok {
		t.Fatalf("a fabricated leaseAck must end the request: %+v", oc)
	}
	if e.i32("hypen_device_broker_is_live", b.h, uint64(scan)) != 0 {
		t.Fatal("request still live after the violation")
	}
	e.call("hypen_device_broker_destroy", b.h)
}

func TestDeviceBrokerABI_QueriesRevisionAndServerConsumes(t *testing.T) {
	e := abiLoad(t)
	b := abiStarted(t, e, `,"maxItemBytes":2048`, 0)

	np, nl := e.putS("gallery.pick")
	if e.i32("hypen_device_broker_supports", b.h, np, nl) != 1 {
		t.Fatal("gallery.pick not supported")
	}
	if e.i64("hypen_device_broker_selected_version", b.h, np, nl) != 1 {
		t.Fatal("selected version")
	}
	xp, xl := e.putS("mic.record")
	if e.i32("hypen_device_broker_supports", b.h, xp, xl) != 0 ||
		e.i64("hypen_device_broker_selected_version", b.h, xp, xl) != -1 {
		t.Fatal("unselected capability reported as selected")
	}

	// revision: the effective revision, with maxItemBytes capped.
	if st := e.i32("hypen_device_broker_revision", b.h, np, nl, 1); st != 0 {
		t.Fatal(e.lastError())
	}
	raw := e.result()
	var rev map[string]any
	if err := json.Unmarshal(raw, &rev); err != nil {
		t.Fatal(err)
	}
	if rev["mode"] != "unary" || rev["data"] != "binaryUpload" || rev["maxItemBytes"].(float64) != 2048 {
		t.Fatalf("revision %v", rev)
	}
	e.call("hypen_device_broker_revision", b.h, np, nl, 42)
	if string(e.result()) != "null" {
		t.Fatal("an unknown revision must be null")
	}
	if st := e.i32("hypen_device_broker_revision", 9999, np, nl, 1); st != abiErrHandle {
		t.Fatalf("unknown handle: %d", st)
	}

	// server_consumes: the revision JSON feeds straight back.
	rp, rl := e.put(raw)
	if e.i32("hypen_device_server_consumes", rp, rl) != 1 {
		t.Fatal("a broker-backed server consumes gallery.pick")
	}
	for body, want := range map[string]int32{
		`{"mode":"stream","data":"binaryDownload"}`: 0,
		`{"mode":"stream","data":"none"}`:           0,
		`{"mode":"stream","data":"jsonEvents"}`:     1,
		`{"mode":"unary","data":"none"}`:            1,
		`{"mode":"stream"}`:                         abiErrJSON,
	} {
		p, l := e.putS(body)
		if got := e.i32("hypen_device_server_consumes", p, l); got != want {
			t.Fatalf("server_consumes(%s) = %d, want %d", body, got, want)
		}
	}
	bp, bl := e.put([]byte{0xff})
	if e.i32("hypen_device_server_consumes", bp, bl) != abiErrInput {
		t.Fatal("non-UTF-8 revision must be an input error")
	}

	// A unary JSON request settles with the client's validated result.
	pq := b.mustOpen(`{"capability":"permission.query","params":{"permission":"camera"},"moduleInstanceId":"m1","activationId":1}`, nil, 11)
	b.drain()
	if !b.text(fmt.Sprintf(`{"type":"deviceResponse","id":%d,"result":{"status":"granted"}}`, pq), 12) {
		t.Fatal("permission.query result rejected")
	}
	b.drain()
	if oc := b.settled[pq]; !oc.Ok || string(oc.Result) != `{"status":"granted"}` {
		t.Fatalf("permission.query outcome %+v", oc)
	}

	// The planned core.capabilities reopen hands out a fresh id.
	core := uint32(b.info()["coreStreamId"].(float64))
	if reopened := e.i64("hypen_device_broker_reopen_core", b.h, 10); reopened <= int64(core) {
		t.Fatalf("reopen_core %d (was %d)", reopened, core)
	}
	e.call("hypen_device_broker_destroy", b.h)
}

// file.save through the raw ABI at the sizes around the wazero compiler
// fault this SDK once hit (wazero < v1.9 trapped with an out-of-bounds
// access in hypen_device_broker_open for any download above ~2 KiB; the
// module pins v1.12.0): every size opens, streams within credit in
// order, and settles ok — including 64 KiB+ downloads spanning several
// frames and scheduling turns. Runs on wazero's default engine (the
// optimizing compiler on amd64/arm64), the one the SDK uses.
func TestDeviceBrokerABI_FileSaveAcrossSizes(t *testing.T) {
	e := abiLoad(t)
	b := abiStarted(t, e, "", 0)
	now := uint64(1)
	for _, size := range []int{1, 2047, 2048, 2049, 4096, 65535, 65536, 65537, 131072 + 17, 200_000} {
		data := make([]byte, size)
		for i := range data {
			data[i] = byte(i*131 + size)
		}
		np, nl := e.putS("f.bin")
		cp, cl := e.putS("application/octet-stream")
		dp, dl := e.put(data)
		if st := e.i32("hypen_device_file_save_params", np, nl, cp, cl, dp, dl); st != 0 {
			t.Fatalf("file_save_params(%d): %s", size, e.lastError())
		}
		params := string(e.result())
		now++
		id := b.mustOpen(`{"capability":"file.save","params":`+params+`,"moduleInstanceId":"m1","activationId":1}`, data, now)
		b.frames = nil
		b.drain()
		if len(b.frames) != 0 {
			t.Fatalf("size %d: frames before any grant", size)
		}
		now++
		if !b.text(fmt.Sprintf(`{"type":"deviceEvent","id":%d,"control":{"grant":%d}}`, id, 262144), now) {
			t.Fatalf("size %d: grant rejected", size)
		}
		var got []byte
		seq := uint32(0)
		for turn := 0; turn < 64 && len(got) < size; turn++ {
			b.frames = nil
			b.drain()
			for _, f := range b.frames {
				if binary.LittleEndian.Uint32(f[4:8]) != id || binary.LittleEndian.Uint32(f[8:12]) != seq {
					t.Fatalf("size %d: frame for id %d seq %d, want %d/%d", size,
						binary.LittleEndian.Uint32(f[4:8]), binary.LittleEndian.Uint32(f[8:12]), id, seq)
				}
				if len(f)-12 > 65536 || len(f) == 12 {
					t.Fatalf("size %d: frame payload of %d bytes", size, len(f)-12)
				}
				seq++
				got = append(got, f[12:]...)
			}
			now++
			if dead := e.i64("hypen_device_broker_tick", b.h, now); dead < -1 {
				t.Fatalf("tick: %s", e.lastError())
			}
		}
		if !bytes.Equal(got, data) {
			t.Fatalf("size %d: downloaded %d bytes, want the exact payload", size, len(got))
		}
		now++
		if !b.text(fmt.Sprintf(`{"type":"deviceResponse","id":%d,"result":{"bytesWritten":%d}}`, id, size), now) {
			t.Fatalf("size %d: receipt rejected", size)
		}
		b.drain()
		if oc := b.settled[id]; !oc.Ok {
			t.Fatalf("size %d: outcome %+v", size, oc)
		}
	}
}
