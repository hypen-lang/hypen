package device

// Native fuzz targets for the Go binding of the Rust broker: arbitrary
// client text and frames fed to a live broker (core.capabilities plus an
// ordinary request) through the WASI ABI exactly as package remote feeds
// socket input. The seed corpus — every message, raw text, handshake value
// and frame in the shared device fixtures — runs as ordinary tests under
// `go test`; `go test -fuzz=FuzzBroker…` explores beyond it. Invariants:
// no host error and no trap (the instance stays usable), every output
// decodes (poll framing, payload runs in range), every text the broker
// sends is a JSON device message it is allowed to send (a deviceRequest or
// a single-control deviceEvent), a request settles at most once, and the
// connection-violation count never decreases.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// seedFixtures walks the shared device fixtures, handing every text and
// frame seed to add.
// Identical seeds (the same message recurs across transcripts) are added
// once.
func seedFixtures(f *testing.F, addText func([]byte), addFrame func([]byte)) {
	root := compatPath(f, "fixtures", "device")
	seen := map[string]bool{}
	dedup := func(kind string, add func([]byte)) func([]byte) {
		return func(b []byte) {
			if key := kind + string(b); !seen[key] {
				seen[key] = true
				add(b)
			}
		}
	}
	text, frameSeed := dedup("t", addText), dedup("f", addFrame)
	err := filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() || !strings.HasSuffix(p, ".json") {
			return err
		}
		raw, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		var walk func(v any)
		walk = func(v any) {
			switch x := v.(type) {
			case map[string]any:
				if ty, ok := x["type"].(string); ok && strings.HasPrefix(ty, "device") {
					b, _ := json.Marshal(x)
					text(b)
				}
				for _, k := range []string{"value", "hello", "ack", "expectAck", "expect"} {
					if m, ok := x[k].(map[string]any); ok {
						b, _ := json.Marshal(m)
						text(b)
					}
				}
				if r, ok := x["raw"].(string); ok {
					text([]byte(r))
				}
				if h, ok := x["rawHex"].(string); ok {
					text(decodeHex(f, h))
				}
				if h, ok := x["hex"].(string); ok {
					frameSeed(decodeHex(f, h))
				}
				for _, y := range x {
					walk(y)
				}
			case []any:
				for _, y := range x {
					walk(y)
				}
			}
		}
		var v any
		if err := json.Unmarshal(raw, &v); err != nil {
			return err
		}
		walk(v)
		return nil
	})
	if err != nil {
		f.Fatalf("seed corpus: %v", err)
	}
}

// fuzzDriver is a started broker with the core stream (id 1) and a live
// gallery.pick upload (id 2, channel 0 announced) — ids the seeds name.
func fuzzDriver(t *testing.T) (*brokerDriver, uint32) {
	d := startedDriver(t, nil, nil)
	id := openLive(t, d, "gallery.pick", "")
	if core, _ := d.coreStreamID(); core != 1 || id != 2 {
		t.Fatalf("ids %d/%d: the seeds name 1 and 2", core, id)
	}
	d.onText([]byte(`{"type":"deviceEvent","id":2,"event":{"kind":"blobStart","channel":0,"contentType":"image/jpeg"}}`))
	return d, id
}

// checkFuzzOutputs pins the output invariants (the driver already failed on
// a host error, a double settle or a double close).
func checkFuzzOutputs(t *testing.T, d *brokerDriver, violationsBefore int64) {
	for _, m := range d.sent {
		switch m["type"] {
		case "deviceRequest":
		case "deviceEvent":
			if c := obj(m["control"]); len(c) != 1 || m["event"] != nil {
				t.Fatalf("the broker sent a non-control deviceEvent: %v", m)
			}
		default:
			t.Fatalf("the broker sent %v", m)
		}
	}
	if d.connectionViolations() < violationsBefore {
		t.Fatal("the violation count decreased")
	}
	if _, _, err := d.b.NextDeadline(); err != nil {
		t.Fatalf("broker unusable after input: %v", err)
	}
}

func FuzzBrokerOnText(f *testing.F) {
	seeds := 0
	seedFixtures(f, func(b []byte) { f.Add(b); seeds++ }, func([]byte) {})
	if seeds < 500 {
		f.Fatalf("seed corpus too small (%d seeds): are the shared fixtures missing?", seeds)
	}
	f.Fuzz(func(t *testing.T, text []byte) {
		d, _ := fuzzDriver(t)
		sent := len(d.sent)
		before := d.connectionViolations()
		d.onText(text)
		d.sent = d.sent[sent:]
		checkFuzzOutputs(t, d, before)
	})
}

func FuzzBrokerOnFrame(f *testing.F) {
	seeds := 0
	seedFixtures(f, func([]byte) {}, func(b []byte) { f.Add(b); seeds++ })
	for _, s := range [][]byte{frame(2, 0, 0, []byte("x")), frame(2, 0, 1, nil), frame(1, 0, 0, []byte{1}), frame(2, 7, 0, []byte{1})} {
		f.Add(s)
		seeds++
	}
	if seeds < 40 {
		f.Fatalf("seed corpus too small (%d frame seeds)", seeds)
	}
	f.Fuzz(func(t *testing.T, fr []byte) {
		d, _ := fuzzDriver(t)
		sent := len(d.sent)
		before := d.connectionViolations()
		d.onFrame(fr)
		d.sent = d.sent[sent:]
		checkFuzzOutputs(t, d, before)
	})
}
