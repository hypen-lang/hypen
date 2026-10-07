package device

// Every shared wire transcript (engine-compatibility-tests/fixtures/device/
// transcripts) replayed through the REAL Rust broker — reached through this
// package's WASI binding, exactly as package remote drives it — in the
// server role. Go port of hypen-engine-rs/tests/test_device_broker_transcripts.rs
// (and of the Kotlin SDK's DeviceBrokerTranscriptReplayTest); the SDK has no
// protocol implementation of its own, so this is its conformance runner.
//
// The harness plays the client: every c2s step goes into the broker (OnText
// / OnFrame) and the broker's Poll outputs are checked against the s2c
// steps:
//
//   - an s2c deviceRequest is produced by Open (or Start / a planned reopen
//     for core.capabilities) and must be exactly the message the broker
//     emits (ids translated to the broker's own monotone ids);
//   - an s2c cancel is produced by Cancel / an owner sweep / the planned
//     reopen and is emitted exactly once;
//   - an s2c frame is the next frame the broker's scheduler hands out, byte
//     for byte; an s2c renewLease n is reached by advancing the injected
//     clock on the fixed 5 s cadence; an s2c grant requires that the broker
//     also replenished that request and that the sender is not starved;
//   - a c2s violation is detected in its category: request-level ones
//     terminate the request invalidParams with exactly one cancel (none
//     after the client's own terminal); connection-level ones are counted
//     and touch no request; a terminal on the live core stream closes the
//     plane; an ignored step has no effect at all;
//   - an s2c step flagged as a violation is what a broken server sends: the
//     broker refuses to produce it.
//
// Every output is also checked on its own (well-formed controls, renewals
// from 1 and +1, well-formed non-empty ≤ 64 KiB channel-0 download frames
// with contiguous seq), and every success is checked against the
// transcript's result and the bytes actually delivered.
//
// The handshake fixtures among the transcripts pin BrokerRuntime.SelectAck;
// frames.json is replayed through a live broker (golden headers, invalid
// headers, the lossless seq rule). The fixture format itself is closed
// (validateFixture).

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// ---- the fixture format ----------------------------------------------------------------

func keysWithin(o any, allowed, required []string, at string) error {
	m, ok := o.(map[string]any)
	if !ok {
		return fmt.Errorf("%s: not an object", at)
	}
	for k := range m {
		found := false
		for _, a := range allowed {
			found = found || a == k
		}
		if !found {
			return fmt.Errorf("%s: unknown key %q", at, k)
		}
	}
	for _, k := range required {
		if _, ok := m[k]; !ok {
			return fmt.Errorf("%s: missing key %q", at, k)
		}
	}
	return nil
}

var violationCategories = []string{
	"malformed", "invalidPayload", "unsupported", "direction", "credit",
	"lease", "sequence", "blob", "owner", "connection",
}

func knownCategory(c string) bool {
	for _, k := range violationCategories {
		if k == c {
			return true
		}
	}
	return false
}

// validateFixture: the fixture format itself is closed — unknown
// document/step/frame keys, flags that are not true, unknown categories,
// and steps carrying more or less than one of message/raw/frame are
// fixture errors.
func validateFixture(doc map[string]any) error {
	if _, ok := doc["hello"]; ok {
		all := []string{"name", "description", "hello", "serverProtocolVersions", "serverBinary", "serverCapabilities", "expectAck"}
		return keysWithin(doc, all, all, "handshake fixture")
	}
	if err := keysWithin(doc, []string{"name", "description", "protocol", "ack", "serverCapabilities", "steps"},
		[]string{"name", "description", "protocol", "steps"}, "transcript"); err != nil {
		return err
	}
	if doc["protocol"] != json.Number("1") {
		return errors.New("only protocol 1 transcripts are defined")
	}
	steps, ok := doc["steps"].([]any)
	if !ok || len(steps) == 0 {
		return errors.New("steps must be a non-empty array")
	}
	for i, raw := range steps {
		at := fmt.Sprintf("step %d", i)
		if err := keysWithin(raw, []string{"dir", "message", "raw", "frame", "ignored", "expectViolation", "reaction"}, []string{"dir"}, at); err != nil {
			return err
		}
		st := raw.(map[string]any)
		if d := st["dir"]; d != "s2c" && d != "c2s" {
			return fmt.Errorf("%s: dir must be s2c or c2s", at)
		}
		kinds := 0
		for _, k := range []string{"message", "raw", "frame"} {
			if _, ok := st[k]; ok {
				kinds++
			}
		}
		if kinds != 1 {
			return fmt.Errorf("%s: exactly one of message/raw/frame", at)
		}
		if r, ok := st["raw"]; ok {
			if _, isText := r.(string); !isText {
				return fmt.Errorf("%s: raw is JSON text", at)
			}
		}
		flags := 0
		for _, f := range []string{"ignored", "reaction", "expectViolation"} {
			if _, ok := st[f]; ok {
				flags++
			}
		}
		if flags > 1 {
			return fmt.Errorf("%s: ignored/reaction/expectViolation are exclusive", at)
		}
		for _, f := range []string{"ignored", "reaction"} {
			if v, ok := st[f]; ok && v != true {
				return fmt.Errorf("%s: %s is true when present", at, f)
			}
		}
		if c, ok := st["expectViolation"]; ok {
			if s, isStr := c.(string); !isStr || !knownCategory(s) {
				return fmt.Errorf("%s: unknown violation category %v", at, c)
			}
		}
		if f, ok := st["frame"]; ok {
			if err := keysWithin(f, []string{"header", "hex", "payloadHex", "payloadFill"}, []string{"header", "hex"}, at); err != nil {
				return err
			}
			fm := f.(map[string]any)
			hdr := []string{"version", "flags", "channel", "requestId", "seq"}
			if err := keysWithin(fm["header"], hdr, hdr, at); err != nil {
				return err
			}
			_, hasHex := fm["payloadHex"]
			fill, hasFill := fm["payloadFill"]
			if hasHex && hasFill {
				return fmt.Errorf("%s: payloadHex and payloadFill are exclusive", at)
			}
			if hasFill {
				if err := keysWithin(fill, []string{"byte", "length"}, []string{"byte", "length"}, at); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

// The fixture format is closed and duplicate keys are fixture errors; these
// are the adversarial fixtures the loader must refuse (mirror of
// fixture_format_is_strictly_validated in the Rust runner).
func TestFixtureFormatIsStrictlyValidated(t *testing.T) {
	req := `{"type":"deviceRequest","id":2,"capability":"bluetooth.scan","version":1,"owner":{"moduleInstanceId":"m","activationId":1},"lifetime":"activation","timeoutMs":30000,"initialCredit":1,"params":{}}`
	doc := func(step string) string {
		return `{"name":"x","description":"x","protocol":1,"steps":[{"dir":"s2c","message":` + req + `},` + step + `]}`
	}
	validate := func(text string) error {
		v, err := parseFixture([]byte(text))
		if err != nil {
			return err
		}
		return validateFixture(v.(map[string]any))
	}
	if _, err := parseFixture([]byte(doc(`{"dir":"s2c","message":{"type":"deviceEvent","id":2,"control":{"grant":1},"control":{"cancel":true}}}`))); err == nil || !strings.Contains(err.Error(), "duplicate key") {
		t.Fatalf("duplicate key inside a step must be a fixture error, got %v", err)
	}
	for name, step := range map[string]string{
		"typo flag":         `{"dir":"c2s","message":{"type":"deviceResponse","id":2,"result":{}},"expectviolation":"direction"}`,
		"message and frame": `{"dir":"c2s","message":{"type":"deviceResponse","id":2,"result":{}},"frame":{"header":{"version":1,"flags":0,"channel":0,"requestId":2,"seq":0},"hex":"010000000200000000000000"}}`,
		"flag false":        `{"dir":"c2s","message":{"type":"deviceResponse","id":2,"result":{}},"ignored":false}`,
		"unknown category":  `{"dir":"c2s","message":{"type":"deviceResponse","id":2,"result":{}},"expectViolation":"nope"}`,
		"two flags":         `{"dir":"c2s","message":{"type":"deviceResponse","id":2,"result":{}},"ignored":true,"reaction":true}`,
		"raw not text":      `{"dir":"c2s","raw":{"type":"deviceResponse"}}`,
		"bad dir":           `{"dir":"up","message":{"type":"deviceResponse","id":2,"result":{}}}`,
	} {
		if validate(doc(step)) == nil {
			t.Errorf("%s: must be a fixture error", name)
		}
	}
	extra := strings.Replace(doc(`{"dir":"c2s","message":{"type":"deviceResponse","id":2,"result":{}}}`), `"protocol":1`, `"protocol":1,"extra":true`, 1)
	if validate(extra) == nil {
		t.Error("unknown top-level key must be a fixture error")
	}
	if err := validate(doc(`{"dir":"c2s","message":{"type":"deviceResponse","id":2,"result":{}}}`)); err != nil {
		t.Fatalf("well-formed fixture rejected: %v", err)
	}
}

// ---- transcript helpers ----------------------------------------------------------------

type transcript struct {
	name string
	doc  map[string]any
}

func loadTranscripts(t *testing.T) []transcript {
	t.Helper()
	dir := compatPath(t, "fixtures", "device", "transcripts")
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range entries {
		if !e.IsDir() && filepath.Ext(e.Name()) == ".json" {
			names = append(names, e.Name())
		}
	}
	if len(names) == 0 {
		t.Fatalf("no transcript fixtures in %s", dir)
	}
	sort.Strings(names)
	out := make([]transcript, 0, len(names))
	for _, file := range names {
		doc := loadFixture(t, filepath.Join(dir, file))
		if err := validateFixture(doc); err != nil {
			t.Fatalf("%s: %v", file, err)
		}
		name := strings.TrimSuffix(file, ".json")
		if sv(doc["name"]) != name {
			t.Fatalf("%s: fixture name %q must match its file name", file, doc["name"])
		}
		out = append(out, transcript{name, doc})
	}
	return out
}

func steps(doc map[string]any) []map[string]any {
	list := doc["steps"].([]any)
	out := make([]map[string]any, len(list))
	for i, s := range list {
		out[i] = s.(map[string]any)
	}
	return out
}

func msgOf(step map[string]any) map[string]any {
	if m := obj(step["message"]); m != nil {
		return m
	}
	return map[string]any{}
}

func flag(step map[string]any, key string) bool { _, ok := step[key]; return ok }

func frameBytes(t testing.TB, f map[string]any) []byte {
	t.Helper()
	out := decodeHex(t, sv(f["hex"]))
	if fill := obj(f["payloadFill"]); fill != nil {
		out = append(out, bytes.Repeat([]byte{byte(mustNum(t, fill["byte"]))}, int(mustNum(t, fill["length"])))...)
	}
	return out
}

type frameHeader struct {
	version, flags uint8
	channel        uint16
	requestID, seq uint32
}

func parseHeader(t testing.TB, f []byte) frameHeader {
	t.Helper()
	if len(f) < FrameHeaderLen {
		t.Fatalf("frame shorter than its header: %x", f)
	}
	return frameHeader{f[0], f[1], binary.LittleEndian.Uint16(f[2:]), binary.LittleEndian.Uint32(f[4:]), binary.LittleEndian.Uint32(f[8:])}
}

// downloadFrames is the payload of every unflagged s2c frame for transcript
// id after step from.
func downloadFrames(t testing.TB, st []map[string]any, from int, id int64) []byte {
	var out []byte
	for _, later := range st[from+1:] {
		f := obj(later["frame"])
		if f == nil {
			continue
		}
		if rid, _ := num(obj(f["header"])["requestId"]); later["dir"] == "s2c" && rid == id && !flag(later, "expectViolation") && !flag(later, "ignored") {
			out = append(out, frameBytes(t, f)[FrameHeaderLen:]...)
		}
	}
	return out
}

// downloadTable maps SHA-256 → download payload, from every transcript whose
// server sends the complete, matching bytes.
func downloadTable(t *testing.T, docs []transcript) map[string][]byte {
	rt := sharedTestRuntime(t)
	table := map[string][]byte{}
	for _, tr := range docs {
		if _, ok := tr.doc["steps"]; !ok {
			continue
		}
		st := steps(tr.doc)
		for i, step := range st {
			m := msgOf(step)
			if step["dir"] != "s2c" || m["type"] != "deviceRequest" || m["capability"] != "file.save" {
				continue
			}
			payload := downloadFrames(t, st, i, mustNum(t, m["id"]))
			params := obj(m["params"])
			sha, _ := rt.Sha256Hex(payload)
			if n, _ := num(params["bytes"]); int64(len(payload)) == n && sha == sv(params["sha256"]) {
				table[sha] = payload
			}
		}
	}
	return table
}

// unmappedBase: transcript ids no step maps to a broker id get an id the
// broker never allocates.
const unmappedBase = 0x4000_0000

type replayLog struct {
	texts   []map[string]any
	settled []uint32
	closed  *Output
}

type ackReq struct {
	id  uint32
	seq int64
}

type replay struct {
	t              *testing.T
	steps          []map[string]any
	b              *Broker
	now            uint64
	idMap          map[int64]uint32
	rev            map[uint32]int64
	selfAcking     map[int64]bool
	lease          map[uint32]int64
	transcriptLeas map[int64]int64
	grantsSince    map[uint32]int64
	cancels        map[uint32]int
	settled        map[uint32]*Outcome
	frames         []struct {
		id uint32
		f  []byte
	}
	frameSeq  map[uint32]uint32
	delivered map[uint32]*bytes.Buffer
	emitted   []map[string]any
	planes    map[uint32]string
	owners    map[uint32]map[string]any
	refused   map[int64]bool
	swept     map[uint32]bool
	closed    bool
	log       replayLog
}

func newReplay(t *testing.T, doc map[string]any) *replay {
	t.Helper()
	st := steps(doc)
	ack := doc["ack"]
	if ack == nil {
		ack = fullAck(t)
	}
	server := doc["serverCapabilities"]
	if server == nil {
		var offers []any
		for _, c := range obj(ack)["capabilities"].([]any) {
			offers = append(offers, map[string]any{"name": obj(c)["name"], "versions": []any{obj(c)["version"]}})
		}
		server = offers
	}
	extra := map[string]any{"serverCapabilities": server}
	// The transcript's own control-stream settings (host configuration).
	for _, s := range st {
		if m := msgOf(s); s["dir"] == "s2c" && m["type"] == "deviceRequest" && m["capability"] == CoreCapabilitiesName {
			extra["controlStreamInitialCredit"] = m["initialCredit"]
			extra["controlStreamTimeoutMs"] = m["timeoutMs"]
			break
		}
	}
	b, err := sharedTestRuntime(t).NewBroker(mustJSON(t, driverConfig(ack, extra)), Pool{}, 0)
	if err != nil {
		t.Fatalf("broker create: %v", err)
	}
	t.Cleanup(func() { _ = b.Destroy() })
	r := &replay{
		t: t, steps: st, b: b,
		idMap: map[int64]uint32{}, rev: map[uint32]int64{}, selfAcking: map[int64]bool{},
		lease: map[uint32]int64{}, transcriptLeas: map[int64]int64{}, grantsSince: map[uint32]int64{},
		cancels: map[uint32]int{}, settled: map[uint32]*Outcome{}, frameSeq: map[uint32]uint32{},
		delivered: map[uint32]*bytes.Buffer{}, planes: map[uint32]string{}, owners: map[uint32]map[string]any{},
		refused: map[int64]bool{}, swept: map[uint32]bool{},
	}
	for _, s := range st {
		m := msgOf(s)
		if _, ok := obj(m["control"])["leaseAck"]; s["dir"] == "c2s" && ok {
			r.selfAcking[mustNum(t, m["id"])] = true
		}
	}
	return r
}

func (r *replay) bid(t int64) uint32 {
	if b, ok := r.idMap[t]; ok {
		return b
	}
	return uint32(unmappedBase + t)
}

func (r *replay) link(t int64, b uint32) {
	r.idMap[t] = b
	r.rev[b] = t
}

func (r *replay) info() map[string]any {
	m, err := r.b.Info()
	if err != nil {
		r.t.Fatalf("info: %v", err)
	}
	return m
}

func (r *replay) started() bool { return r.info()["started"] == true }

func (r *replay) isClosed() bool { return r.info()["closed"] == true }

func (r *replay) connectionViolations() int64 {
	return int64(r.info()["connectionViolations"].(float64))
}

func (r *replay) coreStreamID() (uint32, bool) {
	v, ok := r.info()["coreStreamId"].(float64)
	return uint32(v), ok
}

func (r *replay) isLive(id uint32) bool {
	ok, err := r.b.IsLive(id)
	if err != nil {
		r.t.Fatalf("is_live: %v", err)
	}
	return ok
}

func (r *replay) revision(capability string, version int64) map[string]any {
	raw, err := r.b.Revision(capability, uint32(version))
	if err != nil {
		r.t.Fatalf("revision: %v", err)
	}
	if raw == nil {
		return nil
	}
	return obj(parseJSON(r.t, raw))
}

// pump drains the broker until quiescent, checking every output, acting as
// the handler and as a live client.
func (r *replay) pump(at string) {
	t := r.t
	t.Helper()
	for {
		out, err := r.b.Poll()
		if err != nil {
			t.Fatalf("%s: poll: %v", at, err)
		}
		if len(out) == 0 {
			return
		}
		var acks []ackReq
		var consumed []uint32
		for i := range out {
			o := out[i]
			switch o.Kind {
			case OutputSendText:
				m := obj(parseJSON(t, o.Text))
				id := uint32(mustNum(t, m["id"]))
				switch m["type"] {
				case "deviceRequest":
					rv := r.revision(sv(m["capability"]), mustNum(t, m["version"]))
					if rv == nil {
						t.Fatalf("%s: broker sent a request for a non-registry revision", at)
					}
					r.planes[id] = sv(rv["data"])
					r.owners[id] = obj(m["owner"])
					r.emitted = append(r.emitted, m)
				case "deviceEvent":
					control := obj(m["control"])
					if control == nil {
						t.Fatalf("%s: broker sent a capability event", at)
					}
					if len(control) != 1 {
						t.Fatalf("%s: exactly one control: %v", at, control)
					}
					if _, has := m["event"]; has {
						t.Fatalf("%s: broker sent a capability event", at)
					}
					switch {
					case control["cancel"] != nil:
						if control["cancel"] != true {
							t.Fatalf("%s: cancel must be true", at)
						}
						r.cancels[id]++
					case control["renewLease"] != nil:
						n := mustNum(t, control["renewLease"])
						if n != r.lease[id]+1 {
							t.Fatalf("%s: renewals start at 1 and increase by 1 (got %d after %d)", at, n, r.lease[id])
						}
						r.lease[id] = n
						if tid, ok := r.rev[id]; !ok || !r.selfAcking[tid] {
							acks = append(acks, ackReq{id, n})
						}
					case control["grant"] != nil:
						if p := r.planes[id]; p != "jsonEvents" && p != "binaryUpload" {
							t.Fatalf("%s: grant on a request without a client → server plane", at)
						}
						g := mustNum(t, control["grant"])
						if g < 1 {
							t.Fatalf("%s: grant ≥ 1", at)
						}
						r.grantsSince[id] += g
					default:
						t.Fatalf("%s: broker sent a client-side control %v", at, control)
					}
				default:
					t.Fatalf("%s: broker sent %v", at, m["type"])
				}
				r.log.texts = append(r.log.texts, m)
			case OutputSendFrame:
				h := parseHeader(t, o.Bytes)
				if h.version != 1 || h.flags != 0 || h.channel != 0 {
					t.Fatalf("%s: download frame header %+v", at, h)
				}
				if p := len(o.Bytes) - FrameHeaderLen; p < 1 || p > 65536 {
					t.Fatalf("%s: frame payload %d, want 1..=64 KiB", at, p)
				}
				if r.planes[h.requestID] != "binaryDownload" {
					t.Fatalf("%s: frame for a request without a download", at)
				}
				if h.seq != r.frameSeq[h.requestID] {
					t.Fatalf("%s: contiguous download seq: %d, want %d", at, h.seq, r.frameSeq[h.requestID])
				}
				r.frameSeq[h.requestID]++
				r.frames = append(r.frames, struct {
					id uint32
					f  []byte
				}{h.requestID, o.Bytes})
			case OutputEvent:
				// A consumer that has not caught up: no replenishing grants
				// beyond what the transcript shows.
			case OutputData:
				if r.delivered[o.ID] == nil {
					r.delivered[o.ID] = &bytes.Buffer{}
				}
				r.delivered[o.ID].Write(o.Bytes)
				consumed = append(consumed, o.ID)
			case OutputSettled:
				if _, dup := r.settled[o.ID]; dup {
					t.Fatalf("%s: request %d settled twice", at, o.ID)
				}
				r.settled[o.ID] = o.Outcome
				r.log.settled = append(r.log.settled, o.ID)
			case OutputCloseConnection:
				if r.log.closed != nil || r.closed {
					t.Fatalf("%s: closed twice", at)
				}
				r.log.closed = &o
				r.closed = true
			}
		}
		for _, id := range consumed {
			if err := r.b.ConsumedData(id, 1, r.now); err != nil {
				t.Fatal(err)
			}
		}
		for _, a := range acks {
			if r.isLive(a.id) {
				if _, err := r.b.OnText([]byte(fmt.Sprintf(`{"type":"deviceEvent","id":%d,"control":{"leaseAck":%d}}`, a.id, a.seq)), r.now); err != nil {
					t.Fatal(err)
				}
			}
		}
	}
}

func (r *replay) takeLog() replayLog {
	l := r.log
	r.log = replayLog{}
	return l
}

// activate registers the owner's activation as live (the host's module
// lifecycle).
func (r *replay) activate(owner map[string]any) bool {
	module, ok := str(owner["moduleInstanceId"])
	activation, ok2 := num(owner["activationId"])
	if !ok || !ok2 {
		return false
	}
	live, err := r.b.OwnerIsActive(module, uint32(activation))
	if err == nil && !live {
		live, err = r.b.OwnerActivated(module, uint32(activation), r.now)
	}
	if err != nil {
		r.t.Fatalf("activate: %v", err)
	}
	return live
}

func (r *replay) spec(m map[string]any) map[string]any {
	owner := obj(m["owner"])
	module, activation := "connection", any(jnum(1))
	if mid, ok := str(owner["moduleInstanceId"]); ok {
		module = mid
		if a, has := owner["activationId"]; has {
			activation = a
		}
	}
	params := m["params"]
	return map[string]any{
		"capability":       m["capability"],
		"version":          m["version"],
		"params":           params,
		"moduleInstanceId": module,
		"activationId":     activation,
		"lifetime":         m["lifetime"],
		"timeoutMs":        m["timeoutMs"],
		"initialCredit":    m["initialCredit"],
		// Transcript servers may open an upload at zero credit.
		"allowZeroCredit": true,
	}
}

// open opens m: the id, or the local refusal (host errors fail).
func (r *replay) open(m map[string]any, download []byte) (uint32, *Refusal) {
	id, err := r.b.Open(mustJSON(r.t, r.spec(m)), download, r.now)
	var ref *Refusal
	if errors.As(err, &ref) {
		return 0, ref
	}
	if err != nil {
		r.t.Fatalf("open: host error %v", err)
	}
	return id, nil
}

func (r *replay) ownedLive(owner map[string]any) map[uint32]bool {
	out := map[uint32]bool{}
	for id, o := range r.owners {
		if reflect.DeepEqual(o, owner) && r.isLive(id) {
			out[id] = true
		}
	}
	return out
}

func outcomeCode(o *Outcome) DeviceErrorCode {
	if o == nil || o.OK {
		return ""
	}
	return o.Code
}

type replayCounts struct {
	transcripts, handshakes, requests, c2sViolations, requestLevel, connectionLevel   int
	connectionCloses, s2cRefusals, framesMatched, ignored, successes, sweeps, reopens int
	faultyServerDownloads                                                             int
	requested, succeeded                                                              map[string]bool
	categories                                                                        map[string]bool
}

func (c *replayCounts) String() string {
	return fmt.Sprintf("transcripts=%d handshakes=%d requests=%d c2sViolations=%d requestLevel=%d connectionLevel=%d "+
		"connectionCloses=%d s2cRefusals=%d framesMatched=%d ignored=%d successes=%d sweeps=%d reopens=%d faultyServerDownloads=%d",
		c.transcripts, c.handshakes, c.requests, c.c2sViolations, c.requestLevel, c.connectionLevel,
		c.connectionCloses, c.s2cRefusals, c.framesMatched, c.ignored, c.successes, c.sweeps, c.reopens, c.faultyServerDownloads)
}

type pendingReaction struct {
	t      int64
	before int
}

func runReplay(t *testing.T, name string, doc map[string]any, table map[string][]byte, counts *replayCounts) {
	r := newReplay(t, doc)
	st := r.steps
	var pending *pendingReaction
	ended := false
	flaggedC2s, seenC2s := 0, 0
	for _, s := range st {
		if s["dir"] == "c2s" && flag(s, "expectViolation") {
			flaggedC2s++
		}
	}

	for i, step := range st {
		at := fmt.Sprintf("%s step %d", name, i)
		if ended {
			t.Fatalf("%s: nothing may follow a closed device connection", at)
		}
		dir := sv(step["dir"])
		reaction := flag(step, "reaction")
		ignored := flag(step, "ignored")
		category, hasCategory := str(step["expectViolation"])
		if hasCategory {
			counts.categories[category] = true
		}
		msg := msgOf(step)

		if dir == "s2c" {
			if reaction {
				if pending == nil {
					t.Fatalf("%s: reaction without a violation", at)
				}
				p := *pending
				pending = nil
				if n, _ := num(msg["id"]); n != p.t {
					t.Fatalf("%s: reaction id %v, want %d", at, msg["id"], p.t)
				}
				if obj(msg["control"])["cancel"] != true {
					t.Fatalf("%s: the server's reaction is cancel", at)
				}
				if r.cancels[r.bid(p.t)] != p.before+1 {
					t.Fatalf("%s: exactly one cancel (had %d, now %d)", at, p.before, r.cancels[r.bid(p.t)])
				}
				if r.closed {
					ended = true // a violated core stream takes the plane down
				}
				continue
			}
			if ignored {
				continue
			}
			if hasCategory {
				// A broken server's message: the broker never produces it.
				if msg["type"] == "deviceRequest" {
					counts.s2cRefusals++
					tid := mustNum(t, msg["id"])
					if msg["capability"] == CoreCapabilitiesName {
						if r.started() {
							if _, err := r.b.Start(r.now); err == nil {
								t.Fatalf("%s: a second core stream", at)
							}
						}
						r.activate(r.spec(msg))
						if _, ref := r.open(msg, nil); ref == nil {
							t.Fatalf("%s: app code opened core.capabilities", at)
						}
					} else {
						r.activate(obj(msg["owner"]))
						id, ref := r.open(msg, nil)
						if ref != nil {
							if category == "unsupported" && ref.Code != ErrorUnsupported && ref.Code != ErrorUnavailable {
								t.Fatalf("%s: %s %s", at, ref.Code, ref.Detail)
							}
						} else {
							// Clamped into a valid request: never the violating one.
							r.pump(at)
							if len(r.emitted) != 1 {
								t.Fatalf("%s: emitted %d requests", at, len(r.emitted))
							}
							got := r.emitted[0]
							r.emitted = nil
							if reflect.DeepEqual(with(msg, "id", jnum(int64(id))), got) {
								t.Fatalf("%s: broker emitted the violating request", at)
							}
							if err := r.b.Cancel(id, r.now); err != nil {
								t.Fatal(err)
							}
							r.pump(at)
							if _, mapped := r.idMap[tid]; mapped {
								t.Fatalf("%s: a refused transcript id is never live", at)
							}
						}
					}
					r.pump(at)
					if len(r.emitted) != 0 {
						t.Fatalf("%s: refused request was sent", at)
					}
				}
				continue
			}
			if f := obj(step["frame"]); f != nil {
				tid := mustNum(t, obj(f["header"])["requestId"])
				if r.refused[tid] {
					continue
				}
				b := r.bid(tid)
				r.pump(at)
				if len(r.frames) == 0 {
					t.Fatalf("%s: broker sent no frame", at)
				}
				got := r.frames[0]
				r.frames = r.frames[1:]
				if got.id != b {
					t.Fatalf("%s: frame for request %d, want %d", at, got.id, b)
				}
				if !bytes.Equal(got.f, withRequestID(frameBytes(t, f), b)) {
					t.Fatalf("%s: frame bytes differ", at)
				}
				counts.framesMatched++
				continue
			}
			switch msg["type"] {
			case "deviceRequest":
				tid := mustNum(t, msg["id"])
				counts.requests++
				isCore := msg["capability"] == CoreCapabilitiesName
				skip := false
				if isCore && !r.started() {
					if _, err := r.b.Start(r.now); err != nil {
						t.Fatalf("%s: start refused: %v", at, err)
					}
				} else if !isCore {
					if !r.activate(obj(msg["owner"])) {
						t.Fatalf("%s: activation refused", at)
					}
					var download []byte
					if rv := r.revision(sv(msg["capability"]), mustNum(t, msg["version"])); rv != nil && rv["data"] == "binaryDownload" {
						params := obj(msg["params"])
						declared := int(mustNum(t, params["bytes"]))
						dl := downloadFrames(t, st, i, tid)
						if len(dl) == 0 {
							dl = table[sv(params["sha256"])]
						}
						download = make([]byte, declared)
						copy(download, dl)
					}
					faulty := false
					if download != nil {
						sha, _ := sharedTestRuntime(t).Sha256Hex(download)
						faulty = sha != sv(obj(msg["params"])["sha256"])
					}
					id, ref := r.open(msg, download)
					if ref == nil {
						if faulty {
							t.Fatalf("%s: broker announced bytes it does not send", at)
						}
						r.link(tid, id)
					} else {
						// The transcript's server sends bytes that do not match
						// its own announcement: the broker never announces such a
						// download, and the client's success is the flagged
						// violation.
						if !faulty {
							t.Fatalf("%s: open refused: %s %s", at, ref.Code, ref.Detail)
						}
						if ref.Code != ErrorInvalidParams {
							t.Fatalf("%s: faulty download refused %s", at, ref.Code)
						}
						found := false
						for _, later := range st[i+1:] {
							lm := msgOf(later)
							_, hasResult := lm["result"]
							if n, _ := num(lm["id"]); later["dir"] == "c2s" && n == tid && lm["type"] == "deviceResponse" && hasResult && flag(later, "expectViolation") {
								found = true
							}
						}
						if !found {
							t.Fatalf("%s: a faulty download must end in a flagged success", at)
						}
						r.refused[tid] = true
						counts.faultyServerDownloads++
						skip = true
					}
				}
				if skip {
					continue
				}
				r.pump(at)
				if len(r.emitted) != 1 {
					t.Fatalf("%s: broker emitted %d requests", at, len(r.emitted))
				}
				emitted := r.emitted[0]
				r.emitted = nil
				emittedID := uint32(mustNum(t, emitted["id"]))
				if isCore {
					r.link(tid, emittedID)
					if core, ok := r.coreStreamID(); !ok || core != emittedID {
						t.Fatalf("%s: core stream id", at)
					}
				}
				want := with(msg, "id", jnum(int64(emittedID)))
				got := emitted
				if isCore {
					// Host configuration: the first core stream's credit is the
					// transcript's; a reopen reuses it.
					got = with(emitted, "initialCredit", want["initialCredit"])
				}
				if !reflect.DeepEqual(want, got) {
					t.Fatalf("%s: emitted request differs\n want %s\n got  %s", at, mustJSON(t, want), mustJSON(t, got))
				}
				if !isCore && !strings.HasPrefix(name, "violation-") {
					counts.requested[sv(msg["capability"])] = true
				}
			case "deviceEvent":
				tid := mustNum(t, msg["id"])
				if r.refused[tid] {
					continue
				}
				b := r.bid(tid)
				control := obj(msg["control"])
				if control == nil {
					t.Fatalf("%s: unexpected server step %v", at, msg)
				}
				switch {
				case control["renewLease"] != nil:
					n := mustNum(t, control["renewLease"])
					if n > r.transcriptLeas[tid] {
						r.transcriptLeas[tid] = n
					}
					for k := 0; k < 10 && r.lease[b] < n && r.isLive(b); k++ {
						r.now += 5000
						if _, _, err := r.b.Tick(r.now); err != nil {
							t.Fatal(err)
						}
						r.pump(at)
					}
					if r.lease[b] < n {
						t.Fatalf("%s: broker never renewed to %d", at, n)
					}
					if !r.isLive(b) {
						t.Fatalf("%s: the request expired while renewing", at)
					}
				case control["cancel"] != nil:
					if r.swept[b] {
						if r.cancels[b] != 1 {
							t.Fatalf("%s: swept request cancelled %d times", at, r.cancels[b])
						}
						continue
					}
					if !r.isLive(b) {
						t.Fatalf("%s: cancel of a non-live request", at)
					}
					if core, ok := r.coreStreamID(); ok && core == b {
						// Planned reopen: retire the old stream first.
						var next map[string]any
						for _, later := range st[i+1:] {
							if later["dir"] == "s2c" && !flag(later, "ignored") {
								next = later
								break
							}
						}
						if next == nil || msgOf(next)["capability"] != CoreCapabilitiesName {
							t.Fatalf("%s: core cancel is a reopen", at)
						}
						newID, ok, err := r.b.ReopenCoreCapabilities(r.now)
						if err != nil || !ok {
							t.Fatalf("%s: not reopened (%v)", at, err)
						}
						r.pump(at)
						if r.cancels[b] != 1 {
							t.Fatalf("%s: old stream cancelled %d times", at, r.cancels[b])
						}
						if isCancel(r.log.texts[len(r.log.texts)-1], b) {
							t.Fatalf("%s: the cancel precedes the new request", at)
						}
						if core, _ := r.coreStreamID(); core != newID {
							t.Fatalf("%s: core stream id after reopen", at)
						}
						counts.reopens++
						continue
					}
					// An owner sweep when the consecutive cancels cover exactly
					// one activation's live work; else a caller abandon.
					run := map[uint32]bool{}
					for _, later := range st[i:] {
						lm := msgOf(later)
						if later["dir"] != "s2c" || obj(lm["control"])["cancel"] == nil || flag(later, "reaction") {
							break
						}
						run[r.bid(mustNum(t, lm["id"]))] = true
					}
					owner := r.owners[b]
					if owner == nil {
						t.Fatalf("%s: request %d was not emitted by the broker", at, b)
					}
					if len(run) > 1 && reflect.DeepEqual(run, r.ownedLive(owner)) {
						module, ok1 := str(owner["moduleInstanceId"])
						activation, ok2 := num(owner["activationId"])
						if ok1 && ok2 {
							if err := r.b.OwnerDeactivated(module, uint32(activation), r.now); err != nil {
								t.Fatal(err)
							}
						}
						r.pump(at)
						for id := range run {
							if r.cancels[id] != 1 || outcomeCode(r.settled[id]) != ErrorCancelled {
								t.Fatalf("%s: swept %d: cancels %d outcome %+v", at, id, r.cancels[id], r.settled[id])
							}
							r.swept[id] = true
						}
						counts.sweeps++
					} else {
						if err := r.b.Cancel(b, r.now); err != nil {
							t.Fatal(err)
						}
						r.pump(at)
						if r.cancels[b] != 1 || outcomeCode(r.settled[b]) != ErrorCancelled {
							t.Fatalf("%s: one cancel: cancels %d outcome %+v", at, r.cancels[b], r.settled[b])
						}
					}
				case control["grant"] != nil:
					r.pump(at)
					granted := r.grantsSince[b]
					delete(r.grantsSince, b)
					if granted <= 0 {
						t.Fatalf("%s: the broker did not replenish where the transcript server did", at)
					}
					outstanding, ok, _ := r.b.OutstandingCredit(b)
					if !ok || outstanding == 0 {
						outstanding, _, _ = r.b.OutstandingEventCredit(b)
					}
					if outstanding == 0 {
						t.Fatalf("%s: sender starved", at)
					}
				default:
					t.Fatalf("%s: unexpected server step %v", at, msg)
				}
			default:
				t.Fatalf("%s: unexpected server step type %v", at, msg["type"])
			}
			log := r.takeLog()
			if len(r.emitted) > 0 {
				t.Fatalf("%s: unclaimed request %v", at, r.emitted[0])
			}
			if log.closed != nil {
				t.Fatalf("%s: unexpected close %+v", at, log.closed)
			}
			continue
		}

		// ---- c2s: the client's step into the broker ----
		if pending != nil {
			t.Fatalf("%s: missing server reaction", at)
		}
		r.pump(at)
		r.takeLog()
		var tid int64
		hasID := false
		isResponse := false
		violationsBefore := r.connectionViolations()
		var inputText, inputFrame []byte
		switch {
		case obj(step["frame"]) != nil:
			f := obj(step["frame"])
			tid, hasID = mustNum(t, obj(f["header"])["requestId"]), true
			inputFrame = withRequestID(frameBytes(t, f), r.bid(tid))
		case step["raw"] != nil:
			raw := sv(step["raw"])
			var head struct {
				ID *json.Number `json:"id"`
			}
			if json.Unmarshal([]byte(raw), &head) == nil && head.ID != nil {
				if n, err := head.ID.Int64(); err == nil {
					tid, hasID = n, true
				}
			}
			inputText = []byte(raw)
			if hasID {
				if b := r.bid(tid); int64(b) != tid {
					inputText = []byte(strings.ReplaceAll(raw, `"id":`+strconv.FormatInt(tid, 10), `"id":`+strconv.FormatUint(uint64(b), 10)))
				}
			}
		default:
			tid, hasID = mustNum(t, msg["id"]), true
			isResponse = msg["type"] == "deviceResponse"
			b := r.bid(tid)
			m := with(msg, "id", jnum(int64(b)))
			if ack, ok := num(obj(msg["control"])["leaseAck"]); ok {
				// The broker sends renewLease 1 WITH each request (§2.7): a
				// transcript whose server had not renewed yet sits below it.
				offset := r.lease[b] - r.transcriptLeas[tid]
				if offset < 0 {
					offset = 0
				}
				m = with(m, "control", map[string]any{"leaseAck": jnum(ack + offset)})
			}
			inputText = mustJSON(t, m)
		}
		if hasID && r.refused[tid] {
			if hasCategory {
				seenC2s++ // prevented at the source
			}
			continue
		}
		var b uint32
		wasLive, wasCore := false, false
		if hasID {
			b = r.bid(tid)
			wasLive = r.isLive(b)
			core, ok := r.coreStreamID()
			wasCore = ok && core == b
		}
		cancelsBefore := r.cancels[b]
		var err error
		if inputFrame != nil {
			_, err = r.b.OnFrame(inputFrame, r.now)
		} else {
			_, err = r.b.OnText(inputText, r.now)
		}
		if err != nil {
			t.Fatalf("%s: host error %v", at, err)
		}
		r.pump(at)
		log := r.takeLog()

		if ignored {
			counts.ignored++
			if wasLive {
				t.Fatalf("%s: an ignored step targets a live id", at)
			}
			if len(log.texts) > 0 || len(log.settled) > 0 || log.closed != nil {
				t.Fatalf("%s: ignored step had effects", at)
			}
			if r.connectionViolations() != violationsBefore {
				t.Fatalf("%s: ignored step was counted", at)
			}
			continue
		}

		if !hasCategory {
			if r.connectionViolations() != violationsBefore {
				t.Fatalf("%s: unexpected connection-level violation", at)
			}
			if log.closed != nil {
				t.Fatalf("%s: unexpected close %+v", at, log.closed)
			}
			if !hasID {
				t.Fatalf("%s: unattributable step", at)
			}
			for _, m := range log.texts {
				if isCancel(m, b) {
					t.Fatalf("%s: unexpected cancel", at)
				}
			}
			if wasLive && !r.isLive(b) {
				if !isResponse {
					t.Fatalf("%s: request ended by a non-terminal step", at)
				}
				o := r.settled[b]
				if o == nil {
					t.Fatalf("%s: not settled", at)
				}
				if e := obj(msg["error"]); e != nil {
					if string(outcomeCode(o)) != sv(e["code"]) {
						t.Fatalf("%s: settled %+v, want %v", at, o, e["code"])
					}
				} else {
					checkSuccess(t, at, r, b, msg, o)
					counts.successes++
					if !strings.HasPrefix(name, "violation-") {
						if req := r.emittedRequest(b); req != "" {
							counts.succeeded[req] = true
						}
					}
				}
			} else if wasLive && r.settled[b] != nil {
				t.Fatalf("%s: settled by a non-terminal step", at)
			}
			continue
		}

		seenC2s++
		counts.c2sViolations++
		var next map[string]any
		if i+1 < len(st) {
			next = st[i+1]
		}
		if category == "connection" {
			if !wasLive || r.isLive(b) {
				t.Fatalf("%s: the core stream ended", at)
			}
			if _, ok := r.coreStreamID(); ok {
				t.Fatalf("%s: core stream still live", at)
			}
			if log.closed == nil || log.closed.Code != 1012 {
				t.Fatalf("%s: device plane closed with 1012, got %+v", at, log.closed)
			}
			if !r.isClosed() {
				t.Fatalf("%s: broker not closed", at)
			}
			if i != len(st)-1 {
				t.Fatalf("%s: connection violations end the transcript", at)
			}
			counts.connectionCloses++
			ended = true
			continue
		}
		requestLevel := wasLive && !r.isLive(b)
		if !requestLevel {
			if category != "malformed" {
				t.Fatalf("%s: only malformed is connection-level (category %s)", at, category)
			}
			if r.connectionViolations() != violationsBefore+1 {
				t.Fatalf("%s: not counted", at)
			}
			if wasLive && !r.isLive(b) {
				t.Fatalf("%s: the named request must live on", at)
			}
			if len(log.texts) > 0 || len(log.settled) > 0 {
				t.Fatalf("%s: a request was touched", at)
			}
			if next != nil && flag(next, "reaction") {
				t.Fatalf("%s: no reaction", at)
			}
			counts.connectionLevel++
			continue
		}
		counts.requestLevel++
		if wasCore {
			// The violated stream was core.capabilities: cancel, then the
			// device plane closes.
			if len(log.texts) == 0 || !isCancel(log.texts[0], b) {
				t.Fatalf("%s: the reaction goes out first", at)
			}
			if !r.isClosed() {
				t.Fatalf("%s: broker not closed", at)
			}
		} else {
			if o := r.settled[b]; outcomeCode(o) != ErrorInvalidParams {
				t.Fatalf("%s: violation settled %+v", at, o)
			}
			if r.connectionViolations() != violationsBefore {
				t.Fatalf("%s: a request-level violation was counted", at)
			}
		}
		if isResponse {
			if r.cancels[b] != cancelsBefore {
				t.Fatalf("%s: no cancel after the client's own terminal", at)
			}
			if next != nil && flag(next, "reaction") {
				t.Fatalf("%s: no reaction follows a terminal", at)
			}
		} else {
			if next == nil || !flag(next, "reaction") {
				t.Fatalf("%s: reaction step expected", at)
			}
			pending = &pendingReaction{tid, cancelsBefore}
		}
	}
	if pending != nil {
		t.Fatalf("%s: transcript ends before the reaction", name)
	}
	if flaggedC2s != seenC2s {
		t.Fatalf("%s: %d c2s violations flagged, %d exercised", name, flaggedC2s, seenC2s)
	}
	if !ended && (r.log.closed != nil || r.isClosed()) {
		t.Fatalf("%s: the plane must stay up", name)
	}
	counts.transcripts++
}

// emittedRequest is the capability the broker sent request b for.
func (r *replay) emittedRequest(b uint32) string {
	for tid, id := range r.idMap {
		if id == b {
			for _, s := range r.steps {
				if m := msgOf(s); s["dir"] == "s2c" && m["type"] == "deviceRequest" {
					if n, _ := num(m["id"]); n == tid {
						return sv(m["capability"])
					}
				}
			}
		}
	}
	return ""
}

func checkSuccess(t *testing.T, at string, r *replay, b uint32, msg map[string]any, o *Outcome) {
	t.Helper()
	if !o.OK {
		t.Fatalf("%s: expected success, got %+v", at, o)
	}
	result := parseJSON(t, o.Result)
	if !reflect.DeepEqual(msg["result"], result) {
		t.Fatalf("%s: result passes through: want %s, got %s", at, mustJSON(t, msg["result"]), o.Result)
	}
	if _, sim := msg["simulated"]; sim != o.Simulated {
		t.Fatalf("%s: simulated flag", at)
	}
	items := itemsOf(result)
	rt := sharedTestRuntime(t)
	plane := r.planes[b]
	streamed := r.delivered[b]
	switch {
	case plane == "binaryUpload" && len(items) > 0 && streamed != nil:
		// Streamed: the handler received exactly the one verified item.
		if len(o.Blobs) != 0 || len(items) != 1 {
			t.Fatalf("%s: streamed result carries blobs", at)
		}
		sha, _ := rt.Sha256Hex(streamed.Bytes())
		if n, _ := num(items[0]["bytes"]); n != int64(streamed.Len()) || sha != sv(items[0]["sha256"]) {
			t.Fatalf("%s: delivered bytes do not verify", at)
		}
	case plane == "binaryUpload":
		if len(o.Blobs) != len(items) {
			t.Fatalf("%s: one blob per item: %d blobs, %d items", at, len(o.Blobs), len(items))
		}
		for k, blob := range o.Blobs {
			it := items[k]
			sha, _ := rt.Sha256Hex(blob.Bytes)
			if n, _ := num(it["channel"]); n != int64(blob.Channel) || sv(it["contentType"]) != blob.ContentType {
				t.Fatalf("%s: blob %d metadata", at, k)
			}
			if n, _ := num(it["bytes"]); n != int64(len(blob.Bytes)) || sha != sv(it["sha256"]) {
				t.Fatalf("%s: blob %d does not verify", at, k)
			}
		}
	default:
		if len(o.Blobs) != 0 {
			t.Fatalf("%s: blobs on a %s request", at, plane)
		}
	}
}

// ---- the tests ------------------------------------------------------------------------------

func TestTranscriptsReplayThroughTheRustBroker(t *testing.T) {
	docs := loadTranscripts(t)
	table := downloadTable(t, docs)
	counts := &replayCounts{requested: map[string]bool{}, succeeded: map[string]bool{}, categories: map[string]bool{}}
	rt := sharedTestRuntime(t)
	wire := 0
	for _, tr := range docs {
		tr := tr
		t.Run(tr.name, func(t *testing.T) {
			if hello, ok := tr.doc["hello"]; ok {
				checkHandshakeFixture(t, rt, tr.doc, hello)
				counts.handshakes++
				return
			}
			wire++
			runReplay(t, tr.name, tr.doc, table, counts)
		})
	}
	t.Log(counts)
	if len(docs) <= 100 || len(table) == 0 {
		t.Fatalf("the shared corpus is missing (%d docs, %d downloads)", len(docs), len(table))
	}
	if counts.transcripts != wire {
		t.Fatalf("every transcript replayed: %d of %d", counts.transcripts, wire)
	}
	// The corpus exercises every reaction path.
	floors := []struct {
		name string
		got  int
		min  int
	}{
		{"handshakes", counts.handshakes, 4},
		{"c2sViolations", counts.c2sViolations, 41},
		{"requestLevel", counts.requestLevel, 31},
		{"connectionLevel", counts.connectionLevel, 3},
		{"connectionCloses", counts.connectionCloses, 1},
		{"s2cRefusals", counts.s2cRefusals, 10},
		{"framesMatched", counts.framesMatched, 4},
		{"ignored", counts.ignored, 15},
		{"successes", counts.successes, 20},
		{"sweeps", counts.sweeps, 1},
		{"reopens", counts.reopens, 1},
		{"faultyServerDownloads", counts.faultyServerDownloads, 1},
	}
	for _, f := range floors {
		if f.got < f.min {
			t.Errorf("%s: %d, want ≥ %d (%s)", f.name, f.got, f.min, counts)
		}
	}
	// Every registry capability is requested by a positive transcript, and
	// every unary one completes there with a result the replay verified.
	for _, decl := range registryV1(t) {
		name := sv(decl["name"])
		if name == CoreCapabilitiesName {
			continue
		}
		if !counts.requested[name] {
			t.Errorf("%s: no positive transcript requests it", name)
		}
		unary := false
		for _, rev := range decl["revisions"].([]any) {
			unary = unary || obj(rev)["mode"] == "unary"
		}
		if unary && !counts.succeeded[name] {
			t.Errorf("%s: no positive transcript completes it", name)
		}
	}
	for _, c := range violationCategories {
		if !counts.categories[c] {
			t.Errorf("no transcript exercises violation category %q", c)
		}
	}
}

// checkHandshakeFixture: a handshake transcript pins the Rust selection
// (BrokerRuntime.SelectAck) for its hello and server lists.
func checkHandshakeFixture(t *testing.T, rt *BrokerRuntime, doc map[string]any, hello any) {
	t.Helper()
	server := ServerSide{Binary: doc["serverBinary"] == true}
	if err := json.Unmarshal(mustJSON(t, doc["serverProtocolVersions"]), &server.ProtocolVersions); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(mustJSON(t, doc["serverCapabilities"]), &server.Capabilities); err != nil {
		t.Fatal(err)
	}
	helloText := mustJSON(t, hello)
	ack, err := rt.SelectAck(helloText, server)
	if err != nil {
		t.Fatalf("select_ack: %v", err)
	}
	if expect := doc["expectAck"]; expect == nil {
		if ack != nil {
			t.Fatalf("expected device disabled, got %s", ack)
		}
	} else if ack == nil || !reflect.DeepEqual(parseJSON(t, ack), expect) {
		t.Fatalf("selection mismatch\n want %s\n got  %s", mustJSON(t, expect), ack)
	}
	if _, err := rt.ValidateHello(helloText); err != nil && ack != nil {
		t.Fatalf("an invalid hello (%v) must disable device access", err)
	}
}

// ---- frames.json through the broker --------------------------------------------------------

// The golden frame headers are what the frame helper (and so every frame the
// tests feed) encodes; a golden payload frame, retargeted at a live upload,
// is accepted and delivered byte for byte, and every broker download frame
// carries a golden-form header. The invalid headers are dropped (short) or
// counted as connection-level violations that touch no request (decision
// D3).
func TestGoldenFramesThroughTheBroker(t *testing.T) {
	doc := loadFixture(t, compatPath(t, "fixtures", "device", "frames.json"))
	golden, _ := doc["frames"].([]any)
	invalid, _ := doc["invalid"].([]any)
	if len(golden) == 0 || len(invalid) == 0 {
		t.Fatal("frames.json must carry golden and invalid entries")
	}
	payloads := 0
	for i, g := range golden {
		g := obj(g)
		h := obj(g["header"])
		raw := decodeHex(t, sv(g["hex"]))
		var payload []byte
		if p, ok := str(g["payloadHex"]); ok {
			payload = decodeHex(t, p)
		}
		want := frame(uint32(mustNum(t, h["requestId"])), uint16(mustNum(t, h["channel"])), uint32(mustNum(t, h["seq"])), payload)
		if mustNum(t, h["version"]) != 1 || mustNum(t, h["flags"]) != 0 || !bytes.Equal(want, raw) {
			t.Fatalf("golden %d: helper encodes %x, golden %x", i, want, raw)
		}
		if len(payload) == 0 {
			continue
		}
		payloads++
		// Retarget at a live gallery.pick upload (channel 0, seq 0).
		d := startedDriver(t, nil, nil)
		id := openLive(t, d, "gallery.pick", "")
		d.onText(mustJSON(t, map[string]any{"type": "deviceEvent", "id": id,
			"event": map[string]any{"kind": "blobStart", "channel": 0, "contentType": "image/jpeg", "bytes": len(payload)}}))
		if parseHeader(t, raw).channel != 0 || parseHeader(t, raw).seq != 0 {
			t.Fatalf("golden %d: expected a channel-0 seq-0 frame", i)
		}
		if !d.onFrame(withRequestID(raw, id)) {
			t.Fatalf("golden %d: the broker refused a golden frame", i)
		}
		sha, _ := sharedTestRuntime(t).Sha256Hex(payload)
		d.onText(mustJSON(t, map[string]any{"type": "deviceResponse", "id": id, "result": map[string]any{"items": []any{
			map[string]any{"channel": 0, "contentType": "image/jpeg", "bytes": len(payload), "sha256": sha}}}}))
		o := d.settled[id]
		if o == nil || !o.OK || len(o.Blobs) != 1 || !bytes.Equal(o.Blobs[0].Bytes, payload) {
			t.Fatalf("golden %d: upload outcome %+v", i, o)
		}
	}
	if payloads == 0 {
		t.Fatal("frames.json carries no golden payload frame")
	}

	// A broker download frame has the golden header form.
	d := startedDriver(t, nil, nil)
	id := openLive(t, d, "file.save", "")
	d.onText([]byte(fmt.Sprintf(`{"type":"deviceEvent","id":%d,"control":{"grant":1048576}}`, id)))
	if len(d.frames) != 1 || !bytes.Equal(d.frames[0][:FrameHeaderLen], frame(id, 0, 0, nil)) {
		t.Fatalf("download frames %x", d.frames)
	}

	for k, inv := range invalid {
		inv := obj(inv)
		reason := sv(inv["reason"])
		t.Run(fmt.Sprintf("invalid/%d-%s", k, reason), func(t *testing.T) {
			d := startedDriver(t, nil, nil)
			id := openLive(t, d, "gallery.pick", "")
			d.onText(mustJSON(t, map[string]any{"type": "deviceEvent", "id": id,
				"event": map[string]any{"kind": "blobStart", "channel": 0, "contentType": "image/jpeg"}}))
			raw := decodeHex(t, sv(inv["hex"]))
			if len(raw) >= 8 {
				raw = withRequestID(raw, id) // name the live request
			}
			before := d.connectionViolations()
			if d.onFrame(raw) {
				t.Fatal("an invalid frame was accepted")
			}
			switch {
			case reason == "shortHeader":
				if d.connectionViolations() != before {
					t.Fatal("a short header is dropped without effect")
				}
			case strings.HasPrefix(reason, "violation"):
				if d.connectionViolations() != before+1 {
					t.Fatal("a bad header is a counted connection-level violation")
				}
			default:
				t.Fatalf("unknown invalid-frame reason %q", reason)
			}
			if !d.isLive(id) || d.cancelsFor(id) != 0 || d.settled[id] != nil {
				t.Fatal("the request the untrusted header names is untouched")
			}
		})
	}
}

// frames.json "sequences" through a live upload: the lossless (pause) seq
// rule is the broker's. No registry revision has a dropOldest binary plane,
// so the dropOldest cases are reachable only in the Rust unit tests
// (frame_sequence_rules, lossless_sequence_up_to_u32_max_and_no_wrap); each
// is checked here to be one.
func TestFrameSequenceRulesThroughTheBroker(t *testing.T) {
	doc := loadFixture(t, compatPath(t, "fixtures", "device", "frames.json"))
	list, _ := obj(doc["sequences"])["cases"].([]any)
	if len(list) < 8 {
		t.Fatalf("frames.json must carry sequence cases, got %d", len(list))
	}
	pause := 0
	for _, raw := range list {
		c := obj(raw)
		name := sv(c["name"])
		if sv(c["overflow"]) != "pause" {
			for _, decl := range registryV1(t) {
				for _, rev := range decl["revisions"].([]any) {
					if obj(rev)["overflow"] == c["overflow"] && obj(rev)["data"] != "jsonEvents" && obj(rev)["data"] != "none" {
						t.Fatalf("%s: %s has a %v binary plane: replay it here", name, decl["name"], c["overflow"])
					}
				}
			}
			continue
		}
		pause++
		t.Run(name, func(t *testing.T) {
			var seqs []uint32
			if err := json.Unmarshal(mustJSON(t, c["seqs"]), &seqs); err != nil {
				t.Fatal(err)
			}
			d := startedDriver(t, nil, nil)
			id := openLive(t, d, "gallery.pick", "")
			d.onText(mustJSON(t, map[string]any{"type": "deviceEvent", "id": id,
				"event": map[string]any{"kind": "blobStart", "channel": 0, "contentType": "image/jpeg"}}))
			for k, s := range seqs {
				last := k == len(seqs)-1
				d.onFrame(frame(id, 0, s, []byte{byte(k)}))
				rejected := d.failureCode(id) == ErrorInvalidParams
				if rejected != (last && c["valid"] != true) {
					t.Fatalf("seq %d (#%d): rejected=%v, settled %+v", s, k, rejected, d.settled[id])
				}
			}
		})
	}
	if pause < 4 {
		t.Fatalf("lossless sequence cases missing: %d", pause)
	}
}
