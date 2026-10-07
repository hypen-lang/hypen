package device

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"reflect"
	"sync"
	"testing"
	"time"

	wire "github.com/hypen-space/core/remote/device"
)

// fakePlane is a scripted Plane: Open records the spec and hands the sink
// to the test, which plays the broker.
type fakePlane struct {
	mu        sync.Mutex
	supports  map[string]uint32
	specs     []OpenSpec
	sinks     map[uint32]Sink
	nextID    uint32
	refuse    *Error
	cancels   []uint32
	consumed  map[uint32][2]int
	released  []uint32
	dispatch  Dispatch
	lifecycle []string
	// onCancel settles a cancelled request (as the broker does).
	settleOnCancel bool
}

func newFakePlane() *fakePlane {
	return &fakePlane{
		supports:       map[string]uint32{"gallery.pick": 1, "permission.query": 1},
		sinks:          map[uint32]Sink{},
		consumed:       map[uint32][2]int{},
		nextID:         1,
		settleOnCancel: true,
	}
}

func (p *fakePlane) Supports(c string) bool { _, ok := p.supports[c]; return ok }
func (p *fakePlane) SelectedVersion(c string) (uint32, bool) {
	v, ok := p.supports[c]
	return v, ok
}
func (p *fakePlane) Open(spec OpenSpec, sink Sink) (uint32, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.specs = append(p.specs, spec)
	if p.refuse != nil {
		return 0, p.refuse
	}
	if spec.Replayed {
		return 0, &Error{Code: CodeUnavailable, Detail: "syncActions.replay"}
	}
	id := p.nextID
	p.nextID++
	p.sinks[id] = sink
	return id, nil
}
func (p *fakePlane) Cancel(id uint32) {
	p.mu.Lock()
	p.cancels = append(p.cancels, id)
	sink := p.sinks[id]
	delete(p.sinks, id)
	p.mu.Unlock()
	if sink != nil && p.settleOnCancel {
		sink.Settled(Outcome{Code: CodeCancelled})
	}
}
func (p *fakePlane) Consumed(id uint32, events, chunks int) {
	p.mu.Lock()
	c := p.consumed[id]
	p.consumed[id] = [2]int{c[0] + events, c[1] + chunks}
	p.mu.Unlock()
}
func (p *fakePlane) ReleaseResult(id uint32) {
	p.mu.Lock()
	p.released = append(p.released, id)
	p.mu.Unlock()
}
func (p *fakePlane) cancelled() []uint32 {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]uint32(nil), p.cancels...)
}
func (p *fakePlane) releases() []uint32 {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]uint32(nil), p.released...)
}
func (p *fakePlane) CurrentDispatch() Dispatch { return p.dispatch }
func (p *fakePlane) OwnerActivated(m string, a uint32) {
	p.lifecycle = append(p.lifecycle, "activated")
}
func (p *fakePlane) OwnerDeactivated(m string, a uint32) {
	p.lifecycle = append(p.lifecycle, "deactivated")
}
func (p *fakePlane) OwnerDestroyed(m string) { p.lifecycle = append(p.lifecycle, "destroyed") }

// FileSaveParams is the real Rust announcement (the engine module's
// hypen_device_file_save_params), as the remote plane builds it.
func (p *fakePlane) FileSaveParams(name, ct string, data []byte) (json.RawMessage, error) {
	rt, err := rustRuntime()
	if err != nil {
		return nil, err
	}
	return rt.FileSaveParams(name, ct, data)
}

var (
	rustRTOnce sync.Once
	rustRT     *wire.BrokerRuntime
	rustRTErr  error
)

func rustRuntime() (*wire.BrokerRuntime, error) {
	rustRTOnce.Do(func() {
		wasm, err := os.ReadFile("../hypen_engine.wasm")
		if err != nil {
			rustRTErr = err
			return
		}
		rustRT, rustRTErr = wire.NewBrokerRuntime(wasm)
	})
	return rustRT, rustRTErr
}

func (p *fakePlane) sink(t *testing.T, id uint32) Sink {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		p.mu.Lock()
		s := p.sinks[id]
		p.mu.Unlock()
		if s != nil {
			return s
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("request %d never opened", id)
	return nil
}

func (p *fakePlane) lastSpec() OpenSpec {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.specs[len(p.specs)-1]
}

var owner = Owner{ModuleInstanceID: "m#1", ActivationID: 3}

func TestUnavailableDevice(t *testing.T) {
	for _, d := range []*Device{nil, {}, Unavailable("device-disabled"), Bind(nil, owner)} {
		if d.Supports("gallery.pick") || d.Enabled() {
			t.Fatal("unavailable device reports support")
		}
		if _, ok := d.Version("gallery.pick"); ok {
			t.Fatal("unavailable device reports a version")
		}
		_, err := d.Request(context.Background(), "permission.query", nil)
		var de *Error
		if !errors.As(err, &de) || de.Code != CodeUnavailable || de.Detail != "device-disabled" {
			t.Fatalf("err = %v", err)
		}
		if _, err := d.Stream(context.Background(), "bluetooth.scan", nil); !errors.Is(err, ErrUnavailable) {
			t.Fatalf("stream err = %v", err)
		}
	}
	if _, err := Unavailable("closed").Save(context.Background(), "a", "b", []byte{1}); CodeOf(err) != CodeUnavailable {
		t.Fatal(err)
	}
}

func TestErrorMatching(t *testing.T) {
	err := error(&Error{Code: CodeDenied, Detail: "user-declined"})
	if !errors.Is(err, ErrDenied) || errors.Is(err, ErrCancelled) {
		t.Fatal("errors.Is by code")
	}
	if !errors.Is(err, &Error{Code: CodeDenied, Detail: "user-declined"}) || errors.Is(err, &Error{Code: CodeDenied, Detail: "other"}) {
		t.Fatal("errors.Is by code+detail")
	}
	if CodeOf(err) != CodeDenied || CodeOf(errors.New("x")) != "" {
		t.Fatal("CodeOf")
	}
	if err.Error() != "device: denied (user-declined)" || ErrDenied.Error() != "device: denied" {
		t.Fatalf("Error() = %q", err.Error())
	}
}

func TestRequestSpecAndResult(t *testing.T) {
	p := newFakePlane()
	d := Bind(p, owner)
	if !d.Supports("gallery.pick") || d.Supports("mic.record") || d.Owner() != owner || d.Replayed() {
		t.Fatal("bound device state")
	}
	done := make(chan struct{})
	var status PermissionStatus
	var err error
	go func() {
		defer close(done)
		status, err = d.Permissions().Query(context.Background(), PermissionCamera, WithTimeout(2*time.Second))
	}()
	s := p.sink(t, 1)
	spec := p.lastSpec()
	if spec.Capability != "permission.query" || spec.Owner != owner || spec.Mode != "unary" ||
		spec.Timeout != 2*time.Second || string(spec.Params) != `{"permission":"camera"}` {
		t.Fatalf("spec = %+v params %s", spec, spec.Params)
	}
	s.Settled(Outcome{OK: true, Result: json.RawMessage(`{"status":"granted"}`)})
	<-done
	if err != nil || status != PermissionGranted {
		t.Fatalf("%v %v", status, err)
	}
}

func TestRequestOptions(t *testing.T) {
	p := newFakePlane()
	d := Bind(p, owner)
	go func() {
		_, _ = d.Request(context.Background(), "gallery.pick", json.RawMessage(`{"mediaTypes":["photo"],"maxCount":1}`),
			WithInitialCredit(0), AllowZeroCredit(), WithVersion(1), Background())
	}()
	s := p.sink(t, 1)
	spec := p.lastSpec()
	if spec.InitialCredit == nil || *spec.InitialCredit != 0 || !spec.AllowZeroCredit || spec.Version != 1 || spec.Lifetime != LifetimeBackground {
		t.Fatalf("spec = %+v", spec)
	}
	s.Settled(Outcome{Code: CodeThrottled, Detail: "background pin cap reached"})
}

func TestLocalRefusalAndInvalidParams(t *testing.T) {
	p := newFakePlane()
	p.refuse = &Error{Code: CodeUnsupported, Detail: "x"}
	d := Bind(p, owner)
	if _, err := d.Request(context.Background(), "nope", nil); !errors.Is(err, ErrUnsupported) {
		t.Fatal(err)
	}
	// Typed params are not validated here: they are encoded as-is and the
	// plane (the Rust broker) judges them at open. Its local refusal comes
	// back unchanged as the helper's error. The real broker's verdicts on
	// these exact values are pinned in package remote
	// (TestDeviceInvalidTypedParamsRefusedByBroker).
	p.refuse = &Error{Code: CodeInvalidParams, Detail: "params.x: refused"}
	for _, c := range []struct {
		call func() error
		want string
	}{
		{func() error {
			_, err := d.Permissions().Query(context.Background(), Permission("camra"))
			return err
		}, `{"permission":"camra"}`},
		{func() error { _, err := d.Gallery().Pick(context.Background(), GalleryPickParams{}); return err }, `{"mediaTypes":null,"maxCount":0}`},
		{func() error {
			_, err := d.Camera().Capture(context.Background(), CameraCaptureParams{Mode: CaptureModePhoto, MaxDurationMs: ptr(uint64(10))})
			return err
		}, `{"mode":"photo","maxDurationMs":10}`},
		{func() error {
			_, err := d.Bluetooth().Select(context.Background(), BluetoothSelectParams{Services: []string{"180D"}})
			return err
		}, `{"services":["180D"]}`},
		// A nil Accept is "no filter": sent as [] (never null).
		{func() error { _, err := d.Files().Pick(context.Background(), FilePickParams{MaxCount: 1}); return err }, `{"accept":[],"maxCount":1}`},
	} {
		err := c.call()
		var de *Error
		if !errors.As(err, &de) || de.Code != CodeInvalidParams || de.Detail != "params.x: refused" {
			t.Fatalf("refusal not passed through: %v", err)
		}
		if got := string(p.lastSpec().Params); got != c.want {
			t.Fatalf("params sent to the plane = %s, want %s", got, c.want)
		}
	}
	// Params that cannot be encoded at all never reach the plane.
	n := len(p.specs)
	if _, err := d.Request(context.Background(), "x", func() {}); CodeOf(err) != CodeInvalidParams {
		t.Fatal(err)
	}
	if len(p.specs) != n {
		t.Fatal("unencodable params reached the plane")
	}
}

func ptr[T any](v T) *T { return &v }

func TestReplayedDispatchIsRefused(t *testing.T) {
	p := newFakePlane()
	p.dispatch = Dispatch{Replayed: true}
	d := Bind(p, owner)
	if !d.Replayed() {
		t.Fatal("provenance not captured")
	}
	// The provenance is a property of the value: later dispatches do not
	// launder it.
	p.dispatch = Dispatch{}
	_, err := d.Request(context.Background(), "permission.query", map[string]any{"permission": "camera"})
	var de *Error
	if !errors.As(err, &de) || de.Code != CodeUnavailable || de.Detail != "syncActions.replay" {
		t.Fatal(err)
	}
	if !p.lastSpec().Replayed {
		t.Fatal("replayed flag not forwarded")
	}
}

func TestContextCancellationCancelsAndUnwraps(t *testing.T) {
	p := newFakePlane()
	d := Bind(p, owner)
	ctx, cancel := context.WithCancel(context.Background())
	errCh := make(chan error, 1)
	go func() {
		_, err := d.Request(ctx, "gallery.pick", nil)
		errCh <- err
	}()
	p.sink(t, 1)
	cancel()
	err := <-errCh
	if !errors.Is(err, ErrCancelled) || !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
	if len(p.cancels) != 1 || p.cancels[0] != 1 {
		t.Fatalf("cancels = %v", p.cancels)
	}

	// A context deadline maps to timeout and bounds the broker deadline.
	ctx2, cancel2 := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel2()
	_, err = d.Request(ctx2, "gallery.pick", nil)
	if !errors.Is(err, ErrTimeout) || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("deadline err = %v", err)
	}
	if to := p.lastSpec().Timeout; to <= 0 || to > 50*time.Millisecond {
		t.Fatalf("timeout not bounded by the context: %v", to)
	}

	// An already-ended context never opens anything.
	n := len(p.specs)
	if _, err := d.Request(ctx, "gallery.pick", nil); !errors.Is(err, context.Canceled) || len(p.specs) != n {
		t.Fatal("request opened with a dead context")
	}
}

type countingWaiter struct {
	mu           sync.Mutex
	begins, ends int
}

func (w *countingWaiter) BeginWait() { w.mu.Lock(); w.begins++; w.mu.Unlock() }
func (w *countingWaiter) EndWait()   { w.mu.Lock(); w.ends++; w.mu.Unlock() }

func TestWaitYieldsTheDispatchSlot(t *testing.T) {
	p := newFakePlane()
	w := &countingWaiter{}
	p.dispatch = Dispatch{Waiter: w}
	d := Bind(p, owner)
	done := make(chan error, 1)
	go func() {
		_, err := d.Request(context.Background(), "permission.query", map[string]any{"permission": "camera"})
		done <- err
	}()
	s := p.sink(t, 1)
	deadline := time.Now().Add(2 * time.Second)
	for {
		w.mu.Lock()
		b := w.begins
		w.mu.Unlock()
		if b == 1 || time.Now().After(deadline) {
			break
		}
		time.Sleep(time.Millisecond)
	}
	s.Settled(Outcome{OK: true, Result: json.RawMessage(`{"status":"prompt"}`)})
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if w.begins != 1 || w.ends != 1 {
		t.Fatalf("begin/end = %d/%d", w.begins, w.ends)
	}
	// A request that settled before the wait never yields.
	w2 := &countingWaiter{}
	p.dispatch = Dispatch{Waiter: w2}
	d2 := Bind(p, owner)
	p.refuse = nil
	go func() {
		s := p.sink(t, 2)
		s.Settled(Outcome{OK: true, Result: json.RawMessage(`{}`)})
	}()
	_, _ = d2.Request(context.Background(), "gallery.pick", nil)
	if w2.begins != w2.ends {
		t.Fatal("unbalanced waiter")
	}
}

func TestStreamNextAcknowledgesAndEOF(t *testing.T) {
	p := newFakePlane()
	d := Bind(p, owner)
	st, err := d.Stream(context.Background(), "bluetooth.scan", nil)
	if err != nil {
		t.Fatal(err)
	}
	if p.lastSpec().Mode != "stream" || st.ID() != 1 {
		t.Fatalf("spec %+v", p.lastSpec())
	}
	s := p.sink(t, 1)
	s.Event(json.RawMessage(`{"device":{"id":"a","rssi":-1}}`))
	s.Event(json.RawMessage(`{"device":{"id":"b","rssi":-2}}`))
	it, err := st.Next(nil)
	if err != nil || it.IsData() || string(it.Event) != `{"device":{"id":"a","rssi":-1}}` {
		t.Fatalf("%+v %v", it, err)
	}
	if p.consumed[1] != [2]int{} {
		t.Fatal("acknowledged before the consumer returned")
	}
	if _, err := st.Next(nil); err != nil {
		t.Fatal(err)
	}
	if p.consumed[1] != [2]int{1, 0} {
		t.Fatalf("consumed = %v", p.consumed[1])
	}
	s.Data(0, []byte{1, 2})
	s.Settled(Outcome{OK: true, Result: json.RawMessage(`{}`)})
	it, err = st.Next(nil)
	if err != nil || !it.IsData() || len(it.Data) != 2 {
		t.Fatalf("%+v %v", it, err)
	}
	if _, err := st.Next(nil); !errors.Is(err, io.EOF) {
		t.Fatalf("after settle: %v", err)
	}
	if p.consumed[1] != [2]int{2, 1} {
		t.Fatalf("consumed = %v", p.consumed[1])
	}
	res, err := st.Result(nil)
	if err != nil || string(res.JSON) != `{}` {
		t.Fatal(err)
	}
	select {
	case <-st.Done():
	default:
		t.Fatal("Done not closed")
	}
}

func TestStreamContextCancels(t *testing.T) {
	p := newFakePlane()
	d := Bind(p, owner)
	ctx, cancel := context.WithCancel(context.Background())
	st, err := d.Stream(ctx, "bluetooth.scan", nil)
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	select {
	case <-st.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("context end did not cancel the stream")
	}
	if _, err := st.Result(context.Background()); !errors.Is(err, ErrCancelled) {
		t.Fatal(err)
	}
}

func TestScanAndRecordHelpers(t *testing.T) {
	p := newFakePlane()
	d := Bind(p, owner)
	var ids []string
	errCh := make(chan error, 1)
	go func() {
		errCh <- d.Bluetooth().Scan(context.Background(), func(dev BluetoothDevice) error {
			ids = append(ids, dev.ID)
			if len(ids) == 2 {
				return ErrStop
			}
			return nil
		})
	}()
	s := p.sink(t, 1)
	for _, id := range []string{"x1", "x2", "x3"} {
		s.Event(json.RawMessage(`{"device":{"id":"` + id + `","rssi":-3}}`))
	}
	if err := <-errCh; err != nil || len(ids) != 2 {
		t.Fatalf("scan: %v %v", ids, err)
	}
	if len(p.cancels) != 1 {
		t.Fatal("ErrStop did not cancel the scan")
	}

	// A malformed event is an error value, never a panic.
	go func() {
		errCh <- d.Bluetooth().Scan(context.Background(), nil)
	}()
	s = p.sink(t, 2)
	s.Event(json.RawMessage(`{"device":{"id":"x","rssi":"loud"}}`))
	if err := <-errCh; CodeOf(err) != CodeInvalidParams {
		t.Fatalf("malformed event: %v", err)
	}

	// Mic: chunks in order, then the verified result.
	type out struct {
		res *MicRecordResult
		err error
	}
	recCh := make(chan out, 1)
	var got []byte
	go func() {
		r, err := d.Mic().Record(context.Background(), MicRecordParams{SampleRate: 8000}, func(c []byte) error {
			got = append(got, c...)
			return nil
		})
		recCh <- out{r, err}
	}()
	s = p.sink(t, 3)
	if spec := p.lastSpec(); string(spec.Params) != `{"sampleRate":8000,"format":"pcm16"}` {
		t.Fatalf("mic params %s", spec.Params)
	}
	s.Data(0, []byte{1, 2})
	s.Data(0, []byte{3, 4})
	s.Settled(Outcome{OK: true, Result: json.RawMessage(`{"durationMs":0,"item":{"channel":0,"contentType":"audio/L16","bytes":4,"sha256":"` +
		"9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a" + `"}}`)})
	o := <-recCh
	if o.err != nil || len(got) != 4 || o.res.Item.Bytes != 4 {
		t.Fatalf("record: %v %v %v", got, o.res, o.err)
	}
}

func TestSaveBuildsTheAnnouncement(t *testing.T) {
	// Instantiate the engine module up front (slow under -race), so the
	// sink wait below measures only the Save.
	if _, err := rustRuntime(); err != nil {
		t.Fatal(err)
	}
	p := newFakePlane()
	d := Bind(p, owner)
	done := make(chan error, 1)
	var res *SaveResult
	go func() {
		var err error
		res, err = d.Files().Save(context.Background(), "a.txt", "text/plain", []byte("abc"))
		done <- err
	}()
	s := p.sink(t, 1)
	spec := p.lastSpec()
	// The announcement is Rust's (hypen_device_file_save_params), passed
	// through unchanged.
	var params map[string]any
	if err := json.Unmarshal(spec.Params, &params); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"channel": 0.0, "name": "a.txt", "contentType": "text/plain", "bytes": 3.0,
		"sha256": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"}
	if string(spec.Download) != "abc" || spec.Capability != "file.save" || !reflect.DeepEqual(params, want) {
		t.Fatalf("spec %+v params %s", spec, spec.Params)
	}
	s.Settled(Outcome{OK: true, Result: json.RawMessage(`{"bytesWritten":3}`), Simulated: true})
	if err := <-done; err != nil || res.BytesWritten != 3 || !res.Simulated {
		t.Fatalf("%+v %v", res, err)
	}
}

func TestPickJoinsVerifiedBytes(t *testing.T) {
	p := newFakePlane()
	d := Bind(p, owner)
	type out struct {
		b   []Blob
		err error
	}
	ch := make(chan out, 1)
	go func() {
		b, err := d.Files().Pick(context.Background(), FilePickParams{Accept: []string{"text/plain"}, MaxCount: 2})
		ch <- out{b, err}
	}()
	s := p.sink(t, 1)
	sha := "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
	s.Settled(Outcome{OK: true,
		Result: json.RawMessage(`{"items":[{"channel":0,"name":"a.txt","contentType":"text/plain","bytes":3,"sha256":"` + sha + `"}]}`),
		Blobs:  []Blob{{Channel: 0, ContentType: "text/plain", Bytes: []byte("abc")}},
	})
	o := <-ch
	if o.err != nil || len(o.b) != 1 || o.b[0].Name != "a.txt" || o.b[0].SHA256 != sha || string(o.b[0].Bytes) != "abc" {
		t.Fatalf("%+v %v", o.b, o.err)
	}

	// Result/bytes disagreement (no bytes for a declared channel) is an error.
	go func() {
		b, err := d.Gallery().Pick(context.Background(), GalleryPickParams{MediaTypes: []MediaType{MediaTypePhoto}, MaxCount: 1})
		ch <- out{b, err}
	}()
	s = p.sink(t, 2)
	s.Settled(Outcome{OK: true, Result: json.RawMessage(`{"items":[{"channel":0,"contentType":"image/jpeg","bytes":3,"sha256":"` + sha + `"}]}`)})
	if o := <-ch; CodeOf(o.err) != CodeInternal {
		t.Fatalf("missing bytes: %v", o.err)
	}
}

// Unary results are opened with HoldResult: the retained-bytes charge of a
// held result stays on the connection's budget until the handler scope
// ends (TS parity), and is released at once when there is no open scope.
func TestHeldResultReleasedWhenTheScopeEnds(t *testing.T) {
	p := newFakePlane()
	ok := Outcome{OK: true, Held: true, Result: json.RawMessage(`{"status":"granted"}`)}
	query := func(d *Device, ctx context.Context) chan error {
		done := make(chan error, 1)
		go func() {
			_, err := d.Request(ctx, "permission.query", json.RawMessage(`{"permission":"camera"}`))
			done <- err
		}()
		return done
	}

	// Scoped: held until end, released once.
	d, end := Bind(p, owner).Scoped()
	done := query(d, context.Background())
	s := p.sink(t, 1)
	if !p.lastSpec().HoldResult {
		t.Fatal("a unary request must be opened with HoldResult")
	}
	s.Settled(ok)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if got := p.releases(); len(got) != 0 {
		t.Fatalf("released inside the scope: %v", got)
	}
	end()
	end()
	if got := p.releases(); len(got) != 1 || got[0] != 1 {
		t.Fatalf("releases after end = %v, want [1]", got)
	}

	// Unscoped (e.g. a lifecycle callback): released on delivery.
	done = query(Bind(p, owner), context.Background())
	p.sink(t, 2).Settled(ok)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if got := p.releases(); len(got) != 2 || got[1] != 2 {
		t.Fatalf("unscoped releases = %v", got)
	}

	// A result arriving after the scope ended (a goroutine outliving its
	// handler) is released at once.
	d, end = Bind(p, owner).Scoped()
	done = query(d, context.Background())
	s = p.sink(t, 3)
	end()
	s.Settled(ok)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if got := p.releases(); len(got) != 3 || got[2] != 3 {
		t.Fatalf("late releases = %v", got)
	}

	// Not held: nothing to release.
	d, end = Bind(p, owner).Scoped()
	done = query(d, context.Background())
	p.sink(t, 4).Settled(Outcome{OK: true, Result: json.RawMessage(`{"status":"granted"}`)})
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	end()
	if got := p.releases(); len(got) != 3 {
		t.Fatalf("an unheld result was released: %v", got)
	}

	// A caller whose context ended never gets the value: a held success
	// that raced the cancel is released anyway.
	p.settleOnCancel = false
	d, end = Bind(p, owner).Scoped()
	ctx, cancel := context.WithCancel(context.Background())
	done = query(d, ctx)
	s = p.sink(t, 5)
	cancel()
	for len(p.cancelled()) == 0 {
		time.Sleep(time.Millisecond)
	}
	s.Settled(ok)
	if err := <-done; !errors.Is(err, ErrCancelled) {
		t.Fatalf("err = %v", err)
	}
	end()
	if got := p.releases(); len(got) != 4 || got[3] != 5 {
		t.Fatalf("raced releases = %v", got)
	}

	// Streams and unavailable Devices are never held / scoped.
	go func() { _, _ = Bind(p, owner).Stream(context.Background(), "bluetooth.scan", nil) }()
	p.sink(t, 6)
	if p.lastSpec().HoldResult {
		t.Fatal("a stream must not hold its result")
	}
	u, endU := Unavailable("device-disabled").Scoped()
	endU()
	if u.Enabled() {
		t.Fatal("scoping an unavailable Device enabled it")
	}
}
