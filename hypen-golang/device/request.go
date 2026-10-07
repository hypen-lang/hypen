package device

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"sync"
	"time"

	wire "github.com/hypen-space/core/remote/device"
)

// Option tunes one device operation.
type Option func(*options)

type options struct {
	timeout         time.Duration
	initialCredit   *uint64
	allowZeroCredit bool
	version         uint32
	lifetime        Lifetime
}

// WithTimeout sets the operation's overall deadline (clamped by the broker
// to the revision's maximum). A context deadline that is earlier wins.
func WithTimeout(d time.Duration) Option { return func(o *options) { o.timeout = d } }

// WithInitialCredit sets the initial credit: bytes for binary uploads,
// events for JSON streams (clamped to the revision). An explicit 0 on a
// client → server data plane is refused unless AllowZeroCredit is given.
func WithInitialCredit(n uint64) Option {
	return func(o *options) { o.initialCredit = &n }
}

// AllowZeroCredit accepts an explicit WithInitialCredit(0) (protocol-legal:
// the sender pauses and the broker widens the window).
func AllowZeroCredit() Option { return func(o *options) { o.allowZeroCredit = true } }

// WithVersion pins the exact revision; it must be the negotiated one.
func WithVersion(v uint32) Option { return func(o *options) { o.version = v } }

// WithLifetime selects the owner kind. Background moves ownership from the
// activation to the module instance, within the connection's pin cap
// (throttled beyond it) and only where the revision allows it.
func WithLifetime(l Lifetime) Option { return func(o *options) { o.lifetime = l } }

// Background is WithLifetime(LifetimeBackground).
func Background() Option { return WithLifetime(LifetimeBackground) }

// Blob is one verified binary item: its bytes were checked against the
// size and SHA-256 the client declared in its result.
type Blob struct {
	Channel     uint16
	Name        string
	ContentType string
	Bytes       []byte
	SHA256      string
}

// Result is a successful device operation.
type Result struct {
	Capability string
	// JSON is the client's result, validated against the selected revision.
	JSON  json.RawMessage
	Blobs []Blob
	// Simulated marks a result produced by a fake device host.
	Simulated bool
}

// Decode decodes the result JSON (already validated against the selected
// revision by the Rust broker) into v with encoding/json.
func (r *Result) Decode(v any) error {
	if err := json.Unmarshal(r.JSON, v); err != nil {
		return &Error{Code: CodeInvalidParams, Detail: "result: " + err.Error()}
	}
	return nil
}

// Item is one element of a stream: a JSON event or a data chunk.
type Item struct {
	// Event is a validated JSON event (JSON-event streams).
	Event json.RawMessage
	// Data is a chunk of a binary-upload stream, in order.
	Data    []byte
	Channel uint16
}

// IsData reports whether the item is a data chunk.
func (it Item) IsData() bool { return it.Event == nil }

// request is one open operation: the plane's Sink plus the waiting side.
type request struct {
	d          *Device
	capability string
	id         uint32

	mu      sync.Mutex
	queue   []Item
	outcome *Outcome
	wake    chan struct{} // capacity 1: "something arrived"
	done    chan struct{} // closed on settlement
	// unacked counts items handed to the consumer and not yet reported
	// consumed (events, chunks).
	unackedEvents, unackedChunks int
	// released: a held result's charge was handed to the scope or freed.
	released bool
}

func newRequest(d *Device, capability string) *request {
	return &request{d: d, capability: capability, wake: make(chan struct{}, 1), done: make(chan struct{})}
}

func (r *request) signal() {
	select {
	case r.wake <- struct{}{}:
	default:
	}
}

// Event implements Sink.
func (r *request) Event(ev json.RawMessage) {
	r.mu.Lock()
	r.queue = append(r.queue, Item{Event: ev})
	r.mu.Unlock()
	r.signal()
}

// Data implements Sink.
func (r *request) Data(channel uint16, chunk []byte) {
	r.mu.Lock()
	r.queue = append(r.queue, Item{Data: chunk, Channel: channel})
	r.mu.Unlock()
	r.signal()
}

// Settled implements Sink.
func (r *request) Settled(o Outcome) {
	r.mu.Lock()
	if r.outcome != nil {
		r.mu.Unlock()
		return
	}
	r.outcome = &o
	r.mu.Unlock()
	close(r.done)
	r.signal()
}

// ack reports every item the consumer has finished.
func (r *request) ack() {
	r.mu.Lock()
	ev, ch := r.unackedEvents, r.unackedChunks
	r.unackedEvents, r.unackedChunks = 0, 0
	r.mu.Unlock()
	if ev > 0 || ch > 0 {
		r.d.plane.Consumed(r.id, ev, ch)
	}
}

// block waits on ch or ctx, yielding the dispatch slot meanwhile.
func (r *request) block(ctx context.Context, ch <-chan struct{}) error {
	select {
	case <-ch:
		return nil
	default:
	}
	if w := r.d.dispatch.Waiter; w != nil {
		w.BeginWait()
		defer w.EndWait()
	}
	select {
	case <-ch:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// cancel asks the plane to cancel the request (it settles cancelled,
// synchronously, unless it already settled).
func (r *request) cancel() { r.d.plane.Cancel(r.id) }

// next returns the next item, io.EOF after settlement once the queue is
// empty, or the context error (the request is then cancelled).
func (r *request) next(ctx context.Context) (Item, error) {
	r.ack()
	for {
		r.mu.Lock()
		if len(r.queue) > 0 {
			it := r.queue[0]
			r.queue = r.queue[1:]
			if it.IsData() {
				r.unackedChunks++
			} else {
				r.unackedEvents++
			}
			r.mu.Unlock()
			return it, nil
		}
		settled := r.outcome != nil
		r.mu.Unlock()
		if settled {
			return Item{}, io.EOF
		}
		if err := r.block(ctx, r.wake); err != nil {
			r.cancel()
			return Item{}, err
		}
	}
}

// settle drains (acknowledging and dropping) every remaining item until
// the request settles, and returns its result or error.
func (r *request) settle(ctx context.Context) (*Result, error) {
	for {
		_, err := r.next(ctx)
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			<-r.done // Cancel settles synchronously on the plane.
			r.mu.Lock()
			held := r.outcome != nil && r.outcome.OK && r.outcome.Held
			r.mu.Unlock()
			if held {
				// It completed anyway, but the caller never gets it.
				r.releaseHeld()
			}
			return nil, r.errorFor(ctx, err)
		}
	}
	r.ack()
	return r.result()
}

// errorFor maps a context-ended wait onto the settled outcome: a request
// that settled successfully anyway keeps its result's error nil.
func (r *request) errorFor(_ context.Context, ctxErr error) error {
	r.mu.Lock()
	o := r.outcome
	r.mu.Unlock()
	if o != nil && !o.OK && o.Code != CodeCancelled {
		return &Error{Code: o.Code, Detail: o.Detail}
	}
	code := CodeCancelled
	if errors.Is(ctxErr, context.DeadlineExceeded) {
		code = CodeTimeout
	}
	return &Error{Code: code, Detail: "context: " + ctxErr.Error(), cause: ctxErr}
}

func (r *request) result() (*Result, error) {
	r.mu.Lock()
	o := r.outcome
	r.mu.Unlock()
	if o == nil {
		return nil, &Error{Code: CodeInternal, Detail: "not settled"}
	}
	if !o.OK {
		return nil, &Error{Code: o.Code, Detail: o.Detail}
	}
	res := &Result{Capability: r.capability, JSON: o.Result, Blobs: o.Blobs, Simulated: o.Simulated}
	if o.Held {
		r.releaseHeld()
	}
	return res, nil
}

// releaseHeld hands the held result's retained-bytes charge to the handler
// scope (released when the handler returns), or releases it now when the
// Device is unscoped or its scope already ended. Once only.
func (r *request) releaseHeld() {
	r.mu.Lock()
	if r.released {
		r.mu.Unlock()
		return
	}
	r.released = true
	r.mu.Unlock()
	plane, id := r.d.plane, r.id
	release := func() { plane.ReleaseResult(id) }
	if s := r.d.scope; s != nil && s.defer_(release) {
		return
	}
	release()
}

// open validates the call, builds the spec and registers the request.
func (d *Device) open(ctx context.Context, capability string, params any, mode string, download []byte, opts []Option) (*request, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if !d.Enabled() {
		return nil, d.unavailable()
	}
	if err := ctx.Err(); err != nil {
		code := CodeCancelled
		if errors.Is(err, context.DeadlineExceeded) {
			code = CodeTimeout
		}
		return nil, &Error{Code: code, Detail: "context: " + err.Error(), cause: err}
	}
	raw, err := marshalParams(params)
	if err != nil {
		return nil, err
	}
	var o options
	for _, opt := range opts {
		opt(&o)
	}
	timeout := o.timeout
	if dl, ok := ctx.Deadline(); ok {
		left := time.Until(dl)
		if left < time.Millisecond {
			left = time.Millisecond
		}
		if timeout == 0 || left < timeout {
			timeout = left
		}
	}
	spec := OpenSpec{
		Capability:      capability,
		Version:         o.version,
		Params:          raw,
		Owner:           d.owner,
		Lifetime:        o.lifetime,
		Timeout:         timeout,
		InitialCredit:   o.initialCredit,
		AllowZeroCredit: o.allowZeroCredit,
		Mode:            mode,
		Download:        download,
		Replayed:        d.dispatch.Replayed,
		// Unary results are held until the handler scope ends (TS parity:
		// completed-but-unconsumed upload bytes keep counting).
		HoldResult: mode == "unary",
	}
	r := newRequest(d, capability)
	id, err := d.plane.Open(spec, r)
	if err != nil {
		var de *Error
		if errors.As(err, &de) {
			return nil, de
		}
		return nil, &Error{Code: CodeInternal, Detail: err.Error(), cause: err}
	}
	r.id = id
	return r, nil
}

// Request runs one unary operation (params: a remote/device params type,
// a map, json.RawMessage or nil) and blocks until it settles or ctx ends
// (then the request is cancelled and the error is cancelled — or timeout
// for a context deadline — unwrapping to ctx.Err()).
func (d *Device) Request(ctx context.Context, capability string, params any, opts ...Option) (*Result, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	r, err := d.open(ctx, capability, params, "unary", nil, opts)
	if err != nil {
		return nil, err
	}
	return r.settle(ctx)
}

// Save runs file.save: the client chooses a destination under its own
// consent, then pulls data within credit; the result is the byte count the
// client reports it wrote (checked against len(data) by the broker).
func (d *Device) Save(ctx context.Context, name, contentType string, data []byte, opts ...Option) (*SaveResult, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if !d.Enabled() {
		return nil, d.unavailable()
	}
	if data == nil {
		data = []byte{}
	}
	// The announcement is built by the broker's own code (Rust), so it
	// always matches what the broker verifies the transfer against.
	params, err := d.plane.FileSaveParams(name, contentType, data)
	if err != nil {
		return nil, &Error{Code: CodeInternal, Detail: "file.save params: " + err.Error(), cause: err}
	}
	r, err := d.open(ctx, "file.save", params, "unary", data, opts)
	if err != nil {
		return nil, err
	}
	res, err := r.settle(ctx)
	if err != nil {
		return nil, err
	}
	var out wire.FileSaveResult
	if err := res.Decode(&out); err != nil {
		return nil, err
	}
	return &SaveResult{BytesWritten: out.BytesWritten, Simulated: res.Simulated}, nil
}

// SaveResult is a completed file.save.
type SaveResult struct {
	BytesWritten uint64
	Simulated    bool
}

// Stream is an open streaming operation (JSON events or a binary-upload
// stream). Consume it with Next until io.EOF, then read Result; or call
// Result directly to drop the remaining items; Cancel ends it early.
type Stream struct {
	r   *request
	ctx context.Context
}

// Stream opens a streaming operation. ctx bounds the whole stream: when it
// ends, the stream is cancelled.
func (d *Device) Stream(ctx context.Context, capability string, params any, opts ...Option) (*Stream, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	r, err := d.open(ctx, capability, params, "stream", nil, opts)
	if err != nil {
		return nil, err
	}
	s := &Stream{r: r, ctx: ctx}
	if ctx.Done() != nil {
		go func() {
			select {
			case <-ctx.Done():
				d.plane.Cancel(r.id)
			case <-r.done:
			}
		}()
	}
	return s, nil
}

// ID is the stream's request id on its connection.
func (s *Stream) ID() uint32 { return s.r.id }

// Next returns the next event or data chunk. The previous item is reported
// consumed first (credit flows back as the consumer returns). io.EOF means
// the stream settled: call Result.
func (s *Stream) Next(ctx context.Context) (Item, error) {
	if ctx == nil {
		ctx = s.ctx
	}
	it, err := s.r.next(ctx)
	if err != nil && !errors.Is(err, io.EOF) {
		<-s.r.done
		return Item{}, s.r.errorFor(ctx, err)
	}
	return it, err
}

// Result waits for the stream to settle (acknowledging and dropping any
// unread items) and returns its verified result.
func (s *Stream) Result(ctx context.Context) (*Result, error) {
	if ctx == nil {
		ctx = s.ctx
	}
	return s.r.settle(ctx)
}

// Cancel ends the stream now (it settles cancelled unless already done).
func (s *Stream) Cancel() { s.r.d.plane.Cancel(s.r.id) }

// Done is closed once the stream settled.
func (s *Stream) Done() <-chan struct{} { return s.r.done }

// ErrStop, returned from a streaming callback (Mic.Record's onData,
// Bluetooth.Scan's onDevice), ends the stream: it is cancelled and the
// call returns without an error for a scan, or ErrCancelled for a
// recording (which has no result without its client's terminal).
var ErrStop = errors.New("device: stop")

// consume drives s with a callback per item; the item is acknowledged when
// the callback returns. A callback error cancels the stream.
func (s *Stream) consume(ctx context.Context, f func(Item) error) (*Result, error) {
	for {
		it, err := s.Next(ctx)
		if errors.Is(err, io.EOF) {
			return s.Result(ctx)
		}
		if err != nil {
			return nil, err
		}
		if cbErr := f(it); cbErr != nil {
			s.Cancel()
			<-s.r.done
			s.r.ack()
			if errors.Is(cbErr, ErrStop) {
				return nil, ErrStop
			}
			return nil, cbErr
		}
	}
}
