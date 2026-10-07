package device

// The shared conformance corpora (engine-compatibility-tests/fixtures/device/
// conformance/) replayed through the ONE protocol implementation — the Rust
// engine, reached through this package's WASI binding exactly as the Go
// server reaches it. The SDK has no decoder, validator or negotiator of its
// own to test; what is checked here is that every verdict the corpora pin is
// what the broker / negotiation the SDK ships actually does (Go counterpart
// of the Kotlin SDK's DeviceBrokerConformanceTest):
//
//   - selection.json: BrokerRuntime.SelectAck gives exactly the expected ack
//     (or none), which always passes ValidateAck; a hello ValidateHello
//     refuses never selects anything (decision D7);
//   - messages.json "handshake": ValidateHello / ValidateAck verdicts, and
//     capabilitiesEvent snapshots fed to a live broker's core.capabilities
//     stream (invalid ⇒ the broker cancels it and closes the plane);
//   - payloads.json through a live broker: params at open (invalid ⇒
//     refused locally, nothing sent), results as the client's terminal
//     (valid ⇒ the handler's success, decoded by the SDK's typed structs;
//     invalid ⇒ invalidParams, never delivered), events on a live request of
//     that revision (invalid ⇒ the request terminates invalidParams);
//   - messages.json envelopes through a live broker: every invalid case is
//     rejected — a connection-level violation (JSON limits, no attributable
//     id) or, attributed to a live id (the corpus uses 17 and 1), the
//     termination of that request; no valid case is ever a connection-level
//     violation. The exact envelope decode/round-trip verdicts are the Rust
//     decoder's own corpus test (hypen-engine-rs/tests/test_device_conformance.rs);
//   - schema/device/registry-v1.json: the revision the broker enforces for
//     every registry entry is exactly that entry.
//
// A missing fixture fails; it never skips.

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func corpus(t *testing.T, name string) map[string]any {
	t.Helper()
	return loadFixture(t, compatPath(t, "fixtures", "device", "conformance", name))
}

func cases(t *testing.T, doc map[string]any, key string) []map[string]any {
	t.Helper()
	list, ok := doc[key].([]any)
	if !ok || len(list) == 0 {
		t.Fatalf("corpus has no %s cases", key)
	}
	out := make([]map[string]any, len(list))
	seen := map[string]bool{}
	for i, c := range list {
		out[i] = c.(map[string]any)
		name := sv(out[i]["name"])
		if name == "" || seen[name] {
			t.Fatalf("missing or duplicate case name %q", name)
		}
		seen[name] = true
	}
	return out
}

// ---- selection + handshake ---------------------------------------------------------

func TestConformanceSelectionThroughRust(t *testing.T) {
	rt := sharedTestRuntime(t)
	cs := cases(t, corpus(t, "selection.json"), "cases")
	if len(cs) < 28 {
		t.Fatalf("selection cases missing: %d", len(cs))
	}
	for _, c := range cs {
		c := c
		t.Run(sv(c["name"]), func(t *testing.T) {
			server := ServerSide{ProtocolVersions: []uint32{1}, Binary: c["serverBinary"] == true}
			if v, ok := c["serverProtocolVersions"]; ok {
				if err := json.Unmarshal(mustJSON(t, v), &server.ProtocolVersions); err != nil {
					t.Fatal(err)
				}
			}
			if err := json.Unmarshal(mustJSON(t, c["serverCapabilities"]), &server.Capabilities); err != nil {
				t.Fatal(err)
			}
			hello := mustJSON(t, c["hello"])
			ack, err := rt.SelectAck(hello, server)
			if err != nil {
				t.Fatalf("select_ack: %v", err)
			}
			if expect := c["expect"]; expect == nil {
				if ack != nil {
					t.Fatalf("expected device access disabled, got %s", ack)
				}
			} else {
				if ack == nil {
					t.Fatalf("expected %s, got none", mustJSON(t, expect))
				}
				if got := parseJSON(t, ack); !reflect.DeepEqual(got, expect) {
					t.Fatalf("selection mismatch\n want %s\n got  %s", mustJSON(t, expect), ack)
				}
				// What negotiation selects always passes the strict ack decoder.
				if _, err := rt.ValidateAck(ack); err != nil {
					t.Fatalf("selected ack refused by the strict decoder: %v", err)
				}
			}
			// D7: a hello the strict decoder refuses never selects anything.
			if _, err := rt.ValidateHello(hello); err != nil && ack != nil {
				t.Fatalf("an invalid hello (%v) must disable device access, got %s", err, ack)
			}
		})
	}
}

func TestConformanceHandshakeThroughRust(t *testing.T) {
	rt := sharedTestRuntime(t)
	cs := cases(t, corpus(t, "messages.json"), "handshake")
	if len(cs) < 25 {
		t.Fatalf("handshake cases missing: %d", len(cs))
	}
	for _, c := range cs {
		c := c
		t.Run(sv(c["name"]), func(t *testing.T) {
			valid := c["valid"] == true
			text := caseBytes(t, c)
			isValue := text == nil
			if isValue {
				text = mustJSON(t, c["value"])
			}
			switch kind := sv(c["kind"]); kind {
			case "hello", "ack":
				validate := rt.ValidateHello
				if kind == "ack" {
					validate = rt.ValidateAck
				}
				got, err := validate(text)
				var inv *InvalidError
				var abi *ABIError
				switch {
				case err == nil:
				case errors.As(err, &inv):
				case errors.As(err, &abi) && !textOK(text):
					// Text that is not UTF-8 never reaches the decoder.
				default:
					t.Fatalf("host error: %v", err)
				}
				if (err == nil) != valid {
					t.Fatalf("verdict: valid=%v, got err=%v", valid, err)
				}
				// A valid value decodes to itself (no normalization drift).
				if valid && isValue && !reflect.DeepEqual(parseJSON(t, got), c["value"]) {
					t.Fatalf("decoded %s, want %s", got, text)
				}
			case "capabilitiesEvent":
				if !textOK(text) {
					if valid {
						t.Fatal("valid text must be UTF-8")
					}
					return
				}
				d := startedDriver(t, nil, nil)
				core, ok := d.coreStreamID()
				if !ok {
					t.Fatal("no core stream")
				}
				d.onText([]byte(fmt.Sprintf(`{"type":"deviceEvent","id":%d,"event":%s}`, core, text)))
				if valid {
					if n := d.cancelsFor(core); n != 0 {
						t.Fatal("a valid snapshot is never a violation")
					}
					if d.closed != nil && !strings.HasSuffix(d.closed.Reason, "core.capabilities withdrawn") {
						t.Fatalf("only withdrawing core closes the plane: %s", d.closed.Reason)
					}
				} else {
					if n := d.cancelsFor(core); n != 1 {
						t.Fatalf("an invalid snapshot is a known-id violation of the core stream (cancels %d)", n)
					}
					if d.closed == nil {
						t.Fatal("an invalid snapshot closes the device plane")
					}
				}
			default:
				t.Fatalf("kind %q", kind)
			}
		})
	}
}

// ---- payloads ------------------------------------------------------------------

// paramsFor is valid params the broker opens for capability (upload/stream
// plumbing for result and event cases), built from the SDK's typed structs.
func paramsFor(t *testing.T, capability, contentType string) json.RawMessage {
	t.Helper()
	var v any
	switch capability {
	case "gallery.pick":
		v = GalleryPickParams{MediaTypes: []MediaType{MediaTypePhoto, MediaTypeVideo}, MaxCount: 16}
	case "file.pick":
		v = FilePickParams{Accept: []string{"*/*"}, MaxCount: 16}
	case "camera.capture":
		mode := CaptureModePhoto
		if strings.HasPrefix(contentType, "video/") {
			mode = CaptureModeVideo
		}
		v = CameraCaptureParams{Mode: mode}
	case "mic.record":
		v = MicRecordParams{SampleRate: 16000, Format: MicFormatPCM16}
	case "permission.query", "permission.request":
		v = PermissionParams{Permission: PermissionCamera}
	case "bluetooth.select":
		v = BluetoothSelectParams{}
	case "bluetooth.scan":
		v = struct{}{}
	default:
		t.Fatalf("no params for %s", capability)
	}
	return mustJSON(t, v)
}

// openLive opens a live request of capability (file.save with a matching
// download).
func openLive(t *testing.T, d *brokerDriver, capability, contentType string) uint32 {
	t.Helper()
	if capability == "file.save" {
		dl := bytes.Repeat([]byte{7}, 11)
		sha, err := sharedTestRuntime(t).Sha256Hex(dl)
		if err != nil {
			t.Fatal(err)
		}
		p := FileSaveParams{Channel: 0, Name: "f.bin", ContentType: "application/octet-stream", Bytes: uint64(len(dl)), Sha256: sha}
		return d.opened(spec(capability, json.RawMessage(mustJSON(t, p)), 1, nil), dl)
	}
	return d.opened(spec(capability, paramsFor(t, capability, contentType), 1, nil), nil)
}

func itemsOf(v any) []map[string]any {
	o := obj(v)
	if o == nil {
		return nil
	}
	if list, ok := o["items"].([]any); ok {
		var out []map[string]any
		for _, it := range list {
			m := obj(it)
			if m == nil {
				return nil
			}
			out = append(out, m)
		}
		return out
	}
	if m := obj(o["item"]); m != nil {
		return []map[string]any{m}
	}
	return nil
}

// upload streams one announced item of size bytes to live request id within
// the broker's credit; the actual SHA-256 of what was sent.
func upload(t *testing.T, d *brokerDriver, id uint32, item map[string]any, size int64) string {
	t.Helper()
	channel := uint16(mustNum(t, item["channel"]))
	d.onText(mustJSON(t, map[string]any{
		"type": "deviceEvent", "id": id,
		"event": map[string]any{"kind": "blobStart", "channel": channel, "contentType": item["contentType"]},
	}))
	h := sha256.New()
	var sent int64
	var seq uint32
	for sent < size {
		credit, ok := d.outstandingCredit(id)
		if !ok {
			t.Fatalf("request %d ended while uploading: %+v", id, d.settled[id])
		}
		if credit == 0 {
			t.Fatalf("the broker starved the upload at %d/%d bytes", sent, size)
		}
		n := min(int64(65536), size-sent, int64(credit))
		chunk := make([]byte, n)
		for i := range chunk {
			chunk[i] = byte((sent + int64(i)) * 31 % 251)
		}
		h.Write(chunk)
		d.onFrame(frame(id, channel, seq, chunk))
		seq++
		sent += n
	}
	return hex.EncodeToString(h.Sum(nil))
}

// typedDecode checks the SDK's thin typed struct for a broker-validated
// value: the plain encoding/json decode the SDK does succeeds, and — as a
// test-only drift guard — a decode that refuses unknown members re-encodes
// to exactly the value (every member has a field, every omitempty is right).
func typedDecode(t *testing.T, what string, v any, into any) {
	t.Helper()
	raw := mustJSON(t, v)
	plain := reflect.New(reflect.TypeOf(into).Elem()).Interface()
	if err := json.Unmarshal(raw, plain); err != nil {
		t.Fatalf("%s: the SDK's typed decode failed: %v", what, err)
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(into); err != nil {
		t.Fatalf("%s: a member has no typed field: %v", what, err)
	}
	if back := parseJSON(t, mustJSON(t, into)); !reflect.DeepEqual(back, parseJSON(t, raw)) {
		t.Fatalf("%s: typed round trip drifted\n want %s\n got  %s", what, raw, mustJSON(t, into))
	}
}

func typedParams(capability string) any {
	switch capability {
	case "permission.query", "permission.request":
		return &PermissionParams{}
	case "gallery.pick":
		return &GalleryPickParams{}
	case "file.pick":
		return &FilePickParams{}
	case "file.save":
		return &FileSaveParams{}
	case "camera.capture":
		return &CameraCaptureParams{}
	case "mic.record":
		return &MicRecordParams{}
	case "bluetooth.select":
		return &BluetoothSelectParams{}
	case "bluetooth.scan":
		return &struct{}{}
	}
	return nil
}

func typedResult(capability string) any {
	switch capability {
	case "permission.query", "permission.request":
		return &PermissionResult{}
	case "bluetooth.select":
		return &BluetoothSelectResult{}
	case "gallery.pick":
		return &GalleryPickResult{}
	case "file.pick":
		return &FilePickResult{}
	case "camera.capture":
		return &CameraCaptureResult{}
	case "mic.record":
		return &MicRecordResult{}
	case "file.save":
		return &FileSaveResult{}
	case "bluetooth.scan":
		return &struct{}{}
	}
	return nil
}

func TestConformancePayloadsThroughTheBroker(t *testing.T) {
	cs := cases(t, corpus(t, "payloads.json"), "cases")
	if len(cs) < 270 {
		t.Fatalf("payload cases missing: %d", len(cs))
	}
	for _, c := range cs {
		c := c
		t.Run(sv(c["name"]), func(t *testing.T) {
			capability := sv(c["capability"])
			version := mustNum(t, c["version"])
			valid := c["valid"] == true
			d := startedDriver(t, nil, nil)
			switch kind := sv(c["kind"]); kind {
			case "params":
				checkParams(t, d, capability, version, c["value"], valid)
			case "result":
				checkResult(t, d, capability, c["value"], valid)
			case "event":
				checkEvent(t, d, capability, c["value"], valid)
			default:
				t.Fatalf("kind %q", kind)
			}
		})
	}
}

func checkParams(t *testing.T, d *brokerDriver, capability string, version int64, value any, valid bool) {
	t.Helper()
	if capability == CoreCapabilitiesName {
		// Only the broker opens the control stream; the params it sends are
		// the valid ones.
		core, _ := d.coreStreamID()
		reqs := d.sentFor(core, "deviceRequest")
		if len(reqs) != 1 {
			t.Fatalf("core stream requests: %v", reqs)
		}
		if emitted := reqs[0]["params"]; reflect.DeepEqual(emitted, value) != valid {
			t.Fatalf("core.capabilities params: the broker emits exactly the valid value (emitted %v)", emitted)
		}
		if _, ref := d.open(spec(capability, value, version, nil), nil); ref == nil {
			t.Fatal("application code never opens core.capabilities")
		}
		return
	}
	var download []byte
	if capability == "file.save" {
		download = []byte{0}
	}
	before := len(d.sent)
	id, ref := d.open(spec(capability, value, version, nil), download)
	if valid {
		if ref == nil {
			if n := len(d.sentFor(id, "deviceRequest")); n != 1 {
				t.Fatalf("deviceRequest sent %d times", n)
			}
		} else if capability != "file.save" || !strings.HasPrefix(ref.Detail, "params") {
			// file.save params must also describe the actual download bytes.
			t.Fatalf("valid params refused: %s %s", ref.Code, ref.Detail)
		}
		if into := typedParams(capability); into != nil {
			typedDecode(t, "params", value, into)
		}
		return
	}
	if ref == nil {
		t.Fatalf("invalid params were sent: %s", mustJSON(t, value))
	}
	want := ErrorUnsupported
	if d.revision(capability, uint32(version)) != nil {
		want = ErrorInvalidParams
	}
	if ref.Code != want {
		t.Fatalf("refusal %s (%s), want %s", ref.Code, ref.Detail, want)
	}
	if len(d.sent) != before {
		t.Fatal("a refusal sends nothing")
	}
}

func checkResult(t *testing.T, d *brokerDriver, capability string, value any, valid bool) {
	t.Helper()
	if capability == CoreCapabilitiesName {
		// Any terminal on the live control stream — valid or not — ends the
		// device plane (connection-owned: nothing is settled to a handler,
		// and no cancel follows the client's own terminal).
		core, _ := d.coreStreamID()
		d.onText([]byte(fmt.Sprintf(`{"type":"deviceResponse","id":%d,"result":%s}`, core, mustJSON(t, value))))
		if d.closed == nil || !strings.HasSuffix(d.closed.Reason, "core.capabilities ended") {
			t.Fatalf("closed = %+v", d.closed)
		}
		if d.cancelsFor(core) != 0 || d.settled[core] != nil {
			t.Fatal("the core stream terminal was answered or settled")
		}
		return
	}
	items := itemsOf(value)
	contentType := ""
	if len(items) > 0 {
		contentType, _ = str(items[0]["contentType"])
	}
	id := openLive(t, d, capability, contentType)
	result := value
	if capability == "file.save" {
		// The client grants after consent; the broker sends the whole download.
		d.onText([]byte(fmt.Sprintf(`{"type":"deviceEvent","id":%d,"control":{"grant":1048576}}`, id)))
		if len(d.frames) == 0 {
			t.Fatal("the broker sent no download within the grant")
		}
	}
	if valid && len(items) > 0 {
		// Stream the announced bytes; the corpus hash stands for bytes it
		// does not carry, so the harness reports the actual one.
		sums := make([]string, len(items))
		for i, it := range items {
			sums[i] = upload(t, d, id, it, mustNum(t, it["bytes"]))
		}
		result = rewriteItems(obj(value), sums)
	}
	d.onText([]byte(fmt.Sprintf(`{"type":"deviceResponse","id":%d,"result":%s}`, id, mustJSON(t, result))))
	o := d.settled[id]
	if o == nil {
		t.Fatalf("the terminal did not settle %d", id)
	}
	if valid {
		if !o.OK {
			t.Fatalf("valid result refused: %s %s", o.Code, o.Detail)
		}
		if !reflect.DeepEqual(parseJSON(t, o.Result), parseJSON(t, mustJSON(t, result))) {
			t.Fatalf("the handler sees %s, want %s", o.Result, mustJSON(t, result))
		}
		if into := typedResult(capability); into != nil {
			typedDecode(t, "result", parseJSON(t, o.Result), into)
		} else {
			t.Fatalf("no typed result for %s", capability)
		}
		return
	}
	if o.OK || o.Code != ErrorInvalidParams {
		t.Fatalf("invalid result reached the handler: %+v", o)
	}
	if d.cancelsFor(id) != 0 {
		t.Fatal("no cancel after the client's own terminal")
	}
}

func rewriteItems(result map[string]any, sums []string) map[string]any {
	patch := func(it any, sha string) any { return with(obj(it), "sha256", sha) }
	if list, ok := result["items"].([]any); ok {
		out := make([]any, len(list))
		for i, it := range list {
			out[i] = patch(it, sums[i])
		}
		return with(result, "items", out)
	}
	return with(result, "item", patch(result["item"], sums[0]))
}

func checkEvent(t *testing.T, d *brokerDriver, capability string, value any, valid bool) {
	t.Helper()
	text := mustJSON(t, value)
	if capability == CoreCapabilitiesName {
		core, _ := d.coreStreamID()
		d.onText([]byte(fmt.Sprintf(`{"type":"deviceEvent","id":%d,"event":%s}`, core, text)))
		want := 1
		if valid {
			want = 0
		}
		if d.cancelsFor(core) != want || (!valid && d.closed == nil) {
			t.Fatalf("core event: cancels %d closed %v", d.cancelsFor(core), d.closed)
		}
		return
	}
	contentType, _ := str(obj(value)["contentType"])
	id := openLive(t, d, capability, contentType)
	d.onText([]byte(fmt.Sprintf(`{"type":"deviceEvent","id":%d,"event":%s}`, id, text)))
	var delivered []any
	for _, e := range d.events {
		if e.id == id {
			delivered = append(delivered, e.ev)
		}
	}
	if !valid {
		if code := d.failureCode(id); code != ErrorInvalidParams {
			t.Fatalf("invalid event: %+v", d.settled[id])
		}
		if d.cancelsFor(id) != 1 {
			t.Fatal("the server's reaction is one cancel")
		}
		if len(delivered) != 0 {
			t.Fatal("an invalid event is never delivered")
		}
		return
	}
	if !d.isLive(id) || d.cancelsFor(id) != 0 {
		t.Fatalf("a valid event ended the request: %+v", d.settled[id])
	}
	// Capability events reach the handler; blobStart / progress are the
	// broker's.
	if kind, has := str(obj(value)["kind"]); has {
		if len(delivered) != 0 {
			t.Fatalf("%s is not delivered to the handler", kind)
		}
		return
	}
	if len(delivered) != 1 || !reflect.DeepEqual(delivered[0], value) {
		t.Fatalf("delivered %v, want %s", delivered, text)
	}
	typedDecode(t, "event", delivered[0], &BluetoothScanEvent{})
}

// ---- envelope messages --------------------------------------------------------------

func TestConformanceMessagesThroughTheBroker(t *testing.T) {
	doc := corpus(t, "messages.json")
	validCases, invalidCases := cases(t, doc, "valid"), cases(t, doc, "invalid")
	names := map[string]bool{}
	for _, c := range append(append([]map[string]any{}, validCases...), invalidCases...) {
		if names[sv(c["name"])] {
			t.Fatalf("duplicate case name %v", c["name"])
		}
		names[sv(c["name"])] = true
	}
	var textCases, requestLevel, connectionLevel, nonUTF8 int
	run := func(valid bool, c map[string]any) {
		text := caseBytes(t, c)
		if text != nil {
			textCases++
		} else {
			text = mustJSON(t, c["message"])
		}
		prefix := "invalid/"
		if valid {
			prefix = "valid/"
		}
		t.Run(prefix+sv(c["name"]), func(t *testing.T) {
			if valid && !textOK(text) {
				t.Fatal("valid text must be UTF-8")
			}
			d := startedDriver(t, nil, nil)
			// Make the corpus ids live: 1 is the control stream, 17 an
			// ordinary request.
			core, ok := d.coreStreamID()
			if !ok || core != 1 {
				t.Fatalf("core stream id = %d, %v", core, ok)
			}
			for last := core; last < 17; {
				last = openLive(t, d, "permission.query", "")
			}
			before := d.connectionViolations()
			// Text that is not UTF-8 goes to the broker too: the binding
			// counts it as a connection-level violation.
			d.onText(text)
			counted := d.connectionViolations() > before
			if valid {
				if counted {
					t.Fatal("a valid message is never a connection-level violation")
				}
				if d.closed != nil && d.closed.Reason == "repeated protocol violations" {
					t.Fatal("a valid message closed the plane")
				}
				return
			}
			var terminated []uint32
			for _, id := range []uint32{core, 17} {
				if d.cancelsFor(id) > 0 || d.failureCode(id) == ErrorInvalidParams {
					terminated = append(terminated, id)
				}
			}
			if !counted && len(terminated) == 0 {
				t.Fatalf("%v: accepted by the broker", c["reason"])
			}
			if counted && len(terminated) > 0 {
				t.Fatal("a violation is either connection- or request-level")
			}
			if counted {
				connectionLevel++
				if !textOK(text) {
					nonUTF8++
				}
			} else {
				requestLevel++
			}
			for _, id := range terminated {
				if id == core {
					if d.closed == nil {
						t.Fatal("a violated core stream closes the plane")
					}
				} else if d.failureCode(id) != ErrorInvalidParams {
					t.Fatalf("request %d: %+v", id, d.settled[id])
				}
			}
		})
	}
	for _, c := range validCases {
		run(true, c)
	}
	for _, c := range invalidCases {
		run(false, c)
	}
	if len(validCases) < 56 || len(invalidCases) < 199 {
		t.Errorf("corpus shrank: %d valid, %d invalid", len(validCases), len(invalidCases))
	}
	t.Logf("messages: %d text cases, %d connection-level (%d non-UTF-8), %d known-id", textCases, connectionLevel, nonUTF8, requestLevel)
	if textCases < 80 {
		t.Errorf("JSON-limit text cases missing: %d", textCases)
	}
	if connectionLevel < 80 {
		t.Errorf("connection-level rejections: %d", connectionLevel)
	}
	if requestLevel < 80 {
		t.Errorf("known-id rejections: %d", requestLevel)
	}
}

// ---- coverage ------------------------------------------------------------------------

// Every registry revision has payload coverage (valid and invalid params and
// result cases), and the permission revisions' valid names are exactly the
// SDK's Permission constants — each of which the broker opens.
func TestPayloadCorpusCoversEveryRevisionAndThePermissionEnum(t *testing.T) {
	cs := cases(t, corpus(t, "payloads.json"), "cases")
	has := func(capability string, version int64, kind string, valid bool) bool {
		for _, c := range cs {
			if sv(c["capability"]) == capability && mustNum(t, c["version"]) == version && sv(c["kind"]) == kind && (c["valid"] == true) == valid {
				return true
			}
		}
		return false
	}
	for _, decl := range registryV1(t) {
		name := sv(decl["name"])
		for _, rev := range decl["revisions"].([]any) {
			version := mustNum(t, obj(rev)["version"])
			for _, kind := range []string{"params", "result"} {
				for _, valid := range []bool{true, false} {
					if !has(name, version, kind, valid) {
						t.Errorf("%s@%d: no valid=%v %s case", name, version, valid, kind)
					}
				}
			}
		}
	}
	for _, capability := range []string{"permission.query", "permission.request"} {
		got := map[string]bool{}
		for _, c := range cs {
			if sv(c["capability"]) == capability && sv(c["kind"]) == "params" && c["valid"] == true {
				got[sv(obj(c["value"])["permission"])] = true
			}
		}
		want := map[string]bool{}
		for _, p := range AllPermissions() {
			want[string(p)] = true
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("%s: valid permission names %v, SDK constants %v", capability, got, want)
		}
		d := startedDriver(t, nil, nil)
		for _, p := range AllPermissions() {
			if _, ref := d.open(spec(capability, json.RawMessage(mustJSON(t, PermissionParams{Permission: p})), 1, nil), nil); ref != nil {
				t.Errorf("%s %s refused: %s", capability, p, ref.Detail)
			}
		}
	}
}

// Regression guard for the result replay above: a declared hash that does
// not match the streamed bytes is refused by the broker.
func TestStreamedUploadHashIsVerifiedByTheBroker(t *testing.T) {
	d := startedDriver(t, nil, nil)
	id := openLive(t, d, "gallery.pick", "")
	item := map[string]any{"channel": jnum(0), "contentType": "image/jpeg", "bytes": jnum(17)}
	actual := upload(t, d, id, item, 17)
	wrong, _ := sharedTestRuntime(t).Sha256Hex(make([]byte, 17))
	if actual == wrong {
		t.Fatal("test bytes collide")
	}
	d.onText(mustJSON(t, map[string]any{"type": "deviceResponse", "id": id,
		"result": map[string]any{"items": []any{with(item, "sha256", wrong)}}}))
	if d.failureCode(id) != ErrorInvalidParams {
		t.Fatalf("a wrong hash was accepted: %+v", d.settled[id])
	}
}

// The revision the broker enforces for every registry-v1.json entry is that
// entry; a revision outside the registry is none.
func TestBrokerEnforcesSharedRegistryV1(t *testing.T) {
	d := startedDriver(t, nil, nil)
	n := 0
	for _, decl := range registryV1(t) {
		for _, rev := range decl["revisions"].([]any) {
			want := obj(rev)
			got := d.revision(sv(decl["name"]), uint32(mustNum(t, want["version"])))
			if !reflect.DeepEqual(got, parseJSON(t, mustJSON(t, want))) {
				t.Errorf("%s: broker enforces %v, registry-v1 says %v", decl["name"], got, want)
			}
			n++
		}
	}
	if n < 10 {
		t.Fatalf("registry-v1 revisions missing: %d", n)
	}
	if d.revision("gallery.pick", 99) != nil || d.revision("nope.cap", 1) != nil {
		t.Fatal("non-registry revisions must be none")
	}
}
