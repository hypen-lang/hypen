package remote

// The per-connection device plane (RFC 001) of a server (on by default):
// the native half around the Rust broker. The broker (remote/device.Broker,
// the engine module's `hypen_device_*` ABI) owns the protocol state
// machine; this file pumps the socket into it, drains its outputs into the
// socket and the handler API, and drives its timers from tick().

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	core "github.com/hypen-space/core"
	"github.com/hypen-space/core/device"
	wire "github.com/hypen-space/core/remote/device"
)

// DeviceConfig holds the device plane's options (RemoteServer.
// ConfigureDevice). The plane itself is on by default; zero fields keep
// the defaults. Connection admission is not a device option: see
// RemoteServer.AllowedOrigins / Authenticate.
type DeviceConfig struct {
	// MaxRetainedBytes is the per-connection retained upload budget
	// (0 = 128 MiB).
	MaxRetainedBytes uint64
	// AggregateRetainedBytes is the budget shared by every connection of
	// this server (0 = the engine's default process budget,
	// DEFAULT_PROCESS_RETAINED_BYTES: 1 GiB).
	AggregateRetainedBytes uint64
	// MaxItemBytes caps a single blob item below the registry's limits
	// (0 = registry limits).
	MaxItemBytes uint64
	// BrokerOverrides are extra members of the broker configuration JSON
	// (hypen-engine-rs/src/wasm/device_binding.rs), e.g. "scheduler",
	// "revisionOverrides", "controlStreamTimeoutMs". Advanced/testing seam;
	// unknown members are rejected by the broker.
	BrokerOverrides map[string]any
}

// deviceSettings is a server's device plane: its configuration and the
// aggregate retained-bytes budget its connections share.
type deviceSettings struct {
	cfg DeviceConfig
	agg *aggregateBudget
}

func newDeviceSettings(cfg DeviceConfig) *deviceSettings {
	return &deviceSettings{cfg: cfg, agg: newAggregateBudget(cfg.AggregateRetainedBytes)}
}

// processRetainedDefault caches the engine's default process budget
// (Rust's DEFAULT_PROCESS_RETAINED_BYTES, reported by
// hypen_device_constants as defaultProcessRetainedBytes) once an engine
// instance has reported it; 0 until then.
var processRetainedDefault atomic.Uint64

// aggregateLimit is the aggregate budget in bytes: n, or for n == 0 the
// engine's default — 0 (unresolved) while no instance has reported it yet;
// aggregateBudget.resolve settles it before any byte is retained.
func aggregateLimit(n uint64) uint64 {
	if n != 0 {
		return n
	}
	return processRetainedDefault.Load()
}

// aggregateBudget is the retained-bytes budget shared by every connection
// of one server. Each connection's broker runs in its own engine-module
// instance (a trap resets only that connection), so the Rust pool — which
// lives in one instance's memory — cannot span connections: each instance
// gets a private pool capped at the aggregate limit, and the plane
// reconciles the pool's usage into this budget after every broker call.
// A call that grows the total past the limit terminates the request whose
// bytes pushed it over exactly as the broker's own budget check does
// (`cancel` to the client, the request settles throttled), before any of
// its outputs leave.
type aggregateBudget struct {
	limit atomic.Uint64
	used  atomic.Uint64
}

func newAggregateBudget(limit uint64) *aggregateBudget {
	a := &aggregateBudget{}
	a.limit.Store(aggregateLimit(limit))
	return a
}

// Limit is the budget in bytes (0 until resolved).
func (a *aggregateBudget) Limit() uint64 { return a.limit.Load() }

// resolve settles an unresolved (default) limit from rt's engine constants
// and returns the limit.
func (a *aggregateBudget) resolve(rt *wire.BrokerRuntime) (uint64, error) {
	if n := a.limit.Load(); n != 0 {
		return n, nil
	}
	def := processRetainedDefault.Load()
	if def == 0 {
		c, err := rt.Constants()
		if err != nil {
			return 0, err
		}
		v, ok := c["defaultProcessRetainedBytes"].(float64)
		if !ok || v < 1 {
			return 0, fmt.Errorf("engine constants: bad defaultProcessRetainedBytes %v", c["defaultProcessRetainedBytes"])
		}
		def = uint64(v)
		processRetainedDefault.Store(def)
	}
	a.limit.CompareAndSwap(0, def)
	return a.limit.Load(), nil
}

// apply moves the budget by a connection's usage change (old → now) and
// reports whether the total now exceeds the limit.
func (a *aggregateBudget) apply(old, now uint64) bool {
	var total uint64
	if now >= old {
		total = a.used.Add(now - old)
	} else {
		total = a.used.Add(^(old - now - 1))
	}
	limit := a.limit.Load()
	return now > old && limit != 0 && total > limit
}

// InUse reports the bytes currently retained across the server's
// connections (diagnostics and tests).
func (a *aggregateBudget) InUse() uint64 { return a.used.Load() }

var (
	brokerModuleMu sync.Mutex
	brokerModule   *wire.BrokerModule
	helperRT       *wire.BrokerRuntime
)

// sharedBrokerModule is the engine module compiled once per process for
// device brokers; each connection instantiates its own instance from it.
func sharedBrokerModule() (*wire.BrokerModule, error) {
	brokerModuleMu.Lock()
	defer brokerModuleMu.Unlock()
	return sharedBrokerModuleLocked()
}

func sharedBrokerModuleLocked() (*wire.BrokerModule, error) {
	if brokerModule != nil {
		return brokerModule, nil
	}
	m, err := wire.CompileBrokerModule(core.EngineWASM(), wire.WithCompilationCache(core.SharedCompilationCache()))
	if err != nil {
		return nil, err
	}
	brokerModule = m
	return m, nil
}

// helperRuntime is the instance that runs the broker-free helpers (the
// hello selection), replaced when a trap poisoned it. It holds no broker,
// so a trap there never touches a connection's device plane.
func helperRuntime() (*wire.BrokerRuntime, error) {
	brokerModuleMu.Lock()
	defer brokerModuleMu.Unlock()
	if helperRT != nil && helperRT.Err() == nil {
		return helperRT, nil
	}
	m, err := sharedBrokerModuleLocked()
	if err != nil {
		return nil, err
	}
	rt, err := m.NewRuntime()
	if err != nil {
		return nil, err
	}
	if helperRT != nil {
		_ = helperRT.Close()
	}
	helperRT = rt
	return rt, nil
}

// brokerConfig builds the broker configuration JSON for ack.
func (d *deviceSettings) brokerConfig(ack json.RawMessage) ([]byte, error) {
	cfg := map[string]any{}
	for k, v := range d.cfg.BrokerOverrides {
		cfg[k] = v
	}
	cfg["ack"] = ack
	if d.cfg.MaxRetainedBytes > 0 {
		cfg["maxRetainedBytes"] = d.cfg.MaxRetainedBytes
	}
	if d.cfg.MaxItemBytes > 0 {
		cfg["maxItemBytes"] = d.cfg.MaxItemBytes
	}
	return json.Marshal(cfg)
}

// DeviceTransport is the device route of a SessionTransport: dedicated
// text and binary sends, disjoint from OutgoingMessage (RFC 001 §5). A
// transport without it never gets a device plane.
type DeviceTransport interface {
	// SendDeviceText writes one device JSON message as a text frame.
	SendDeviceText(text []byte) error
	// SendBinary writes one binary device frame.
	SendBinary(frame []byte) error
}

// sessionDevice is one connection's device plane: it implements
// device.Plane for the handler API on top of the connection's broker,
// which runs in the connection's own engine-module instance (rt).
type sessionDevice struct {
	s     *RemoteSession
	rt    *wire.BrokerRuntime
	pool  wire.Pool
	agg   *aggregateBudget
	b     *wire.Broker
	tr    DeviceTransport
	start time.Time

	mu     sync.Mutex
	closed bool
	sinks  map[uint32]device.Sink
	timer  *time.Timer
	// retained is this connection's share of agg (its pool's usage at the
	// last reconciliation); aggThrottled holds requests terminated for the
	// aggregate budget, whose cancelled settlement is reported throttled.
	retained     uint64
	aggThrottled map[uint32]struct{}

	// sendMu orders socket writes across drains: it is taken before mu is
	// released, so writes leave in broker output order.
	sendMu sync.Mutex
	// inflight counts bytes handed to the socket and not yet written; it
	// is reported to the broker as the transport's buffered amount.
	inflight atomic.Int64
}

// newSessionDevice instantiates the connection's own engine-module instance
// from module and creates its broker there.
func newSessionDevice(s *RemoteSession, module *wire.BrokerModule, agg *aggregateBudget, tr DeviceTransport, config []byte) (*sessionDevice, error) {
	rt, err := module.NewRuntime()
	if err != nil {
		return nil, err
	}
	p := &sessionDevice{
		s: s, rt: rt, agg: agg, tr: tr, start: time.Now(),
		sinks: make(map[uint32]device.Sink), aggThrottled: make(map[uint32]struct{}),
	}
	// The instance's private pool: the aggregate cap applies to this
	// connection alone inside Rust; reconcile() spans connections.
	limit, err := agg.resolve(rt)
	if err != nil {
		_ = rt.Close()
		return nil, err
	}
	pool, err := rt.NewPool(limit)
	if err != nil {
		_ = rt.Close()
		return nil, err
	}
	b, err := rt.NewBroker(config, pool, p.now())
	if err != nil {
		_ = rt.Close()
		return nil, err
	}
	p.pool, p.b = pool, b
	return p, nil
}

// now is the broker clock: monotonic milliseconds since the plane opened.
func (p *sessionDevice) now() uint64 {
	return uint64(time.Since(p.start) / time.Millisecond)
}

// start opens the connection-owned core.capabilities stream (before any
// module callback can request device work).
func (p *sessionDevice) startPlane() error {
	var startErr error
	p.do(func(now uint64) error {
		_, err := p.b.Start(now)
		var ref *wire.Refusal
		if errors.As(err, &ref) {
			startErr = err
			return nil
		}
		return err
	})
	return startErr
}

// do runs op on the broker with the plane lock held, then drains the
// broker's outputs (releasing the lock).
func (p *sessionDevice) do(op func(now uint64) error) {
	p.doFor(nil, op)
}

// doFor is do for an input that may grow retained bytes: grower names the
// request it grew (for the aggregate budget).
func (p *sessionDevice) doFor(grower func() (uint32, bool), op func(now uint64) error) {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return
	}
	if err := op(p.now()); err != nil && p.brokerFailed(err) {
		p.failLocked(err)
		return
	}
	if err := p.reconcileLocked(grower); err != nil {
		p.failLocked(err)
		return
	}
	p.flushAndUnlock()
}

// reconcileLocked folds this connection's retained bytes into the server's
// aggregate budget. When the last input pushed the total over the limit,
// the request that grew (grower) is terminated as the broker's own budget
// check would: `cancel` goes out and it settles throttled. Called with
// p.mu held.
func (p *sessionDevice) reconcileLocked(grower func() (uint32, bool)) error {
	used, err := p.rt.PoolInUse(p.pool)
	if err != nil {
		return err
	}
	over := p.agg.apply(p.retained, used)
	p.retained = used
	if !over {
		return nil
	}
	id, ok := uint32(0), false
	if grower != nil {
		id, ok = grower()
	}
	if !ok {
		// Nothing attributable grew (cannot happen for a broker input
		// that reserves): leave it to the next reservation.
		logServer.Warn("Session %s: aggregate retained bytes over budget (%d > %d)", p.s.ID, p.agg.InUse(), p.agg.Limit())
		return nil
	}
	if live, err := p.b.IsLive(id); err != nil || !live {
		return err
	}
	logServer.Warn("Session %s: request %d exceeds the server's aggregate retained-byte budget (%d bytes) — throttled", p.s.ID, id, p.agg.Limit())
	p.aggThrottled[id] = struct{}{}
	if err := p.b.Cancel(id, p.now()); err != nil {
		return err
	}
	used, err = p.rt.PoolInUse(p.pool)
	if err != nil {
		return err
	}
	p.agg.apply(p.retained, used)
	p.retained = used
	return nil
}

// releaseRetainedLocked returns this connection's share of the aggregate
// budget (the plane is gone). Called with p.mu held.
func (p *sessionDevice) releaseRetainedLocked() {
	p.agg.apply(p.retained, 0)
	p.retained = 0
}

// brokerFailed reports whether err means the broker is unusable (a trap
// or a destroyed handle), as opposed to a refused input.
func (p *sessionDevice) brokerFailed(err error) bool {
	return errors.Is(err, wire.ErrBrokerRuntimeFailed) || errors.Is(err, wire.ErrBrokerClosed)
}

// flushAndUnlock polls the broker, delivers handler traffic to the sinks,
// re-arms the timer and writes socket traffic in order. Called with p.mu
// held; returns with it released.
func (p *sessionDevice) flushAndUnlock() {
	_ = p.b.SetTransportBuffered(uint64(max64(p.inflight.Load(), 0)))
	outs, err := p.b.Poll()
	if err != nil {
		p.failLocked(err)
		return
	}
	var sends []wire.Output
	var closeOut *wire.Output
	for i := range outs {
		o := outs[i]
		switch o.Kind {
		case wire.OutputSendText, wire.OutputSendFrame:
			sends = append(sends, o)
			if o.Kind == wire.OutputSendFrame {
				p.inflight.Add(int64(len(o.Bytes)))
			}
		case wire.OutputEvent:
			if sink := p.sinks[o.ID]; sink != nil {
				sink.Event(o.Event)
			}
		case wire.OutputData:
			if sink := p.sinks[o.ID]; sink != nil {
				sink.Data(o.Channel, o.Bytes)
			}
		case wire.OutputSettled:
			outcome := p.outcomeLocked(o.ID, o.Outcome)
			if sink := p.sinks[o.ID]; sink != nil {
				delete(p.sinks, o.ID)
				sink.Settled(outcome)
			}
		case wire.OutputCloseConnection:
			closeOut = &o
		}
	}
	if closeOut != nil {
		p.closeLocked(device.CodeConnectionLost, "device plane closed")
	} else {
		p.armLocked()
	}
	p.sendMu.Lock()
	p.mu.Unlock()
	defer p.sendMu.Unlock()
	for _, o := range sends {
		var err error
		if o.Kind == wire.OutputSendText {
			err = p.tr.SendDeviceText(o.Text)
		} else {
			err = p.tr.SendBinary(o.Bytes)
			p.inflight.Add(-int64(len(o.Bytes)))
		}
		if err != nil {
			logServer.Debug("Session %s: device send failed: %v", p.s.ID, err)
		}
	}
	if closeOut != nil {
		logServer.Warn("Session %s: %s — closing (%d)", p.s.ID, closeOut.Reason, closeOut.Code)
		_ = p.s.transport.Close(closeOut.Code, closeOut.Reason)
	}
}

// outcomeLocked converts a settlement, reporting a request the aggregate
// budget terminated as throttled (the broker saw a server cancel).
func (p *sessionDevice) outcomeLocked(id uint32, o *wire.Outcome) device.Outcome {
	out := convertOutcome(o)
	if _, ok := p.aggThrottled[id]; ok {
		delete(p.aggThrottled, id)
		if !out.OK {
			out = device.Outcome{Code: device.CodeThrottled, Detail: "aggregate retained byte budget exceeded"}
		}
	}
	return out
}

// armLocked schedules the next tick at the broker's next deadline.
func (p *sessionDevice) armLocked() {
	next, ok, err := p.b.NextDeadline()
	if p.timer != nil {
		p.timer.Stop()
		p.timer = nil
	}
	if err != nil || !ok {
		return
	}
	now := p.now()
	var delay time.Duration
	if next > now {
		delay = time.Duration(next-now) * time.Millisecond
	}
	p.timer = time.AfterFunc(delay, p.onTimer)
}

func (p *sessionDevice) onTimer() {
	p.do(func(now uint64) error {
		_, _, err := p.b.Tick(now)
		return err
	})
}

// failLocked handles an unusable broker: every pending handler settles
// internal and the socket resets (the client reconnects with a full
// advertisement). Called with p.mu held; releases it.
func (p *sessionDevice) failLocked(cause error) {
	logServer.Error("Session %s: device broker failure: %v", p.s.ID, cause)
	sinks := p.sinks
	p.sinks = map[uint32]device.Sink{}
	p.closed = true
	if p.timer != nil {
		p.timer.Stop()
		p.timer = nil
	}
	_ = p.b.Destroy()
	// The instance is this connection's alone: nothing else is lost.
	_ = p.rt.Close()
	p.releaseRetainedLocked()
	p.mu.Unlock()
	for _, sink := range sinks {
		sink.Settled(device.Outcome{Code: device.CodeInternal, Detail: "device broker failure"})
	}
	_ = p.s.transport.Close(1011, "device broker failure")
}

// closeLocked closes the broker locally with code, settles every pending
// handler and destroys the handle. Called with p.mu held (kept).
func (p *sessionDevice) closeLocked(code device.Code, detail string) {
	if p.closed {
		return
	}
	p.closed = true
	if p.timer != nil {
		p.timer.Stop()
		p.timer = nil
	}
	if err := p.b.Close(code); err == nil {
		if outs, err := p.b.Poll(); err == nil {
			for _, o := range outs {
				if o.Kind != wire.OutputSettled {
					continue
				}
				outcome := p.outcomeLocked(o.ID, o.Outcome)
				if sink := p.sinks[o.ID]; sink != nil {
					delete(p.sinks, o.ID)
					sink.Settled(outcome)
				}
			}
		}
	}
	for id, sink := range p.sinks {
		delete(p.sinks, id)
		sink.Settled(device.Outcome{Code: code, Detail: detail})
	}
	_ = p.b.Destroy()
	_ = p.rt.Close()
	p.releaseRetainedLocked()
}

// close ends the plane with the connection (nothing more is sent).
func (p *sessionDevice) close() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.closeLocked(device.CodeConnectionLost, "connection closed")
}

func convertOutcome(o *wire.Outcome) device.Outcome {
	if o == nil {
		return device.Outcome{Code: device.CodeInternal, Detail: "missing outcome"}
	}
	out := device.Outcome{OK: o.OK, Result: o.Result, Simulated: o.Simulated, Held: o.Held, Code: o.Code, Detail: o.Detail}
	for _, b := range o.Blobs {
		out.Blobs = append(out.Blobs, device.Blob{
			Channel: b.Channel, Name: b.Name, ContentType: b.ContentType, Bytes: b.Bytes,
		})
	}
	return out
}

func max64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

// ---- socket input ---------------------------------------------------------------

// onText feeds a client → server device text message.
func (p *sessionDevice) onText(text []byte) {
	p.doFor(func() (uint32, bool) {
		// Only a text that reserved bytes (a declared blobStart) is
		// attributed, and the broker accepted it: its id is well formed.
		var head struct {
			ID *uint32 `json:"id"`
		}
		if json.Unmarshal(text, &head) != nil || head.ID == nil {
			return 0, false
		}
		return *head.ID, true
	}, func(now uint64) error {
		_, err := p.b.OnText(text, now)
		return err
	})
}

// onFrame feeds a client → server binary frame.
func (p *sessionDevice) onFrame(frame []byte) {
	p.doFor(func() (uint32, bool) {
		if len(frame) < wire.FrameHeaderLen {
			return 0, false
		}
		return binary.LittleEndian.Uint32(frame[4:8]), true
	}, func(now uint64) error {
		_, err := p.b.OnFrame(frame, now)
		return err
	})
}

// violation counts a connection-level violation the host detected.
func (p *sessionDevice) violation(reason string) {
	p.do(func(now uint64) error { return p.b.ReportViolation(reason, now) })
}

// ---- device.Plane ---------------------------------------------------------------

func (p *sessionDevice) isClosed() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.closed
}

// Supports implements device.Plane.
func (p *sessionDevice) Supports(capability string) bool {
	if p.isClosed() {
		return false
	}
	ok, err := p.b.Supports(capability)
	return err == nil && ok
}

// SelectedVersion implements device.Plane.
func (p *sessionDevice) SelectedVersion(capability string) (uint32, bool) {
	if p.isClosed() {
		return 0, false
	}
	v, ok, err := p.b.SelectedVersion(capability)
	if err != nil {
		return 0, false
	}
	return v, ok
}

type openJSON struct {
	Capability       string          `json:"capability"`
	Version          *uint32         `json:"version,omitempty"`
	Params           json.RawMessage `json:"params"`
	ModuleInstanceID string          `json:"moduleInstanceId"`
	ActivationID     uint32          `json:"activationId"`
	Lifetime         string          `json:"lifetime,omitempty"`
	TimeoutMs        *uint64         `json:"timeoutMs,omitempty"`
	InitialCredit    *uint64         `json:"initialCredit,omitempty"`
	AllowZeroCredit  bool            `json:"allowZeroCredit,omitempty"`
	Mode             string          `json:"mode,omitempty"`
	HoldResult       bool            `json:"holdResult,omitempty"`
	Replayed         bool            `json:"replayed,omitempty"`
}

// Open implements device.Plane.
func (p *sessionDevice) Open(spec device.OpenSpec, sink device.Sink) (uint32, error) {
	body := openJSON{
		Capability: spec.Capability, Params: spec.Params,
		ModuleInstanceID: spec.Owner.ModuleInstanceID, ActivationID: spec.Owner.ActivationID,
		Lifetime: string(spec.Lifetime), InitialCredit: spec.InitialCredit,
		AllowZeroCredit: spec.AllowZeroCredit, Mode: spec.Mode, Replayed: spec.Replayed,
		HoldResult: spec.HoldResult,
	}
	if spec.Version != 0 {
		v := spec.Version
		body.Version = &v
	}
	if spec.Timeout > 0 {
		ms := uint64(spec.Timeout / time.Millisecond)
		if ms == 0 {
			ms = 1
		}
		body.TimeoutMs = &ms
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return 0, &device.Error{Code: device.CodeInvalidParams, Detail: err.Error()}
	}
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return 0, &device.Error{Code: device.CodeUnavailable, Detail: "device-disabled"}
	}
	id, err := p.b.Open(raw, spec.Download, p.now())
	if err != nil {
		var ref *wire.Refusal
		if errors.As(err, &ref) {
			// A refusal can still queue outputs (e.g. id exhaustion
			// closes the plane).
			p.flushAndUnlock()
			return 0, &device.Error{Code: ref.Code, Detail: ref.Detail}
		}
		if p.brokerFailed(err) {
			p.failLocked(err)
			return 0, &device.Error{Code: device.CodeInternal, Detail: "device broker failure"}
		}
		// A host error (malformed spec): nothing was opened.
		p.mu.Unlock()
		return 0, &device.Error{Code: device.CodeInvalidParams, Detail: err.Error()}
	}
	p.sinks[id] = sink
	p.flushAndUnlock()
	return id, nil
}

// Cancel implements device.Plane.
func (p *sessionDevice) Cancel(id uint32) {
	p.do(func(now uint64) error { return p.b.Cancel(id, now) })
}

// FileSaveParams implements device.Plane: the announcement comes from Rust
// (hypen_device_file_save_params). It runs on the broker-free helper
// instance, so it answers even after this connection's instance closed
// (the open then fails as the closed plane does).
func (p *sessionDevice) FileSaveParams(name, contentType string, data []byte) (json.RawMessage, error) {
	rt, err := helperRuntime()
	if err != nil {
		return nil, err
	}
	return rt.FileSaveParams(name, contentType, data)
}

// ReleaseResult implements device.Plane.
func (p *sessionDevice) ReleaseResult(id uint32) {
	p.do(func(uint64) error { return p.b.ReleaseResult(id) })
}

// Consumed implements device.Plane.
func (p *sessionDevice) Consumed(id uint32, events, chunks int) {
	p.do(func(now uint64) error {
		if events > 0 {
			if err := p.b.ConsumedEvents(id, uint64(events), now); err != nil {
				return err
			}
		}
		if chunks > 0 {
			return p.b.ConsumedData(id, uint32(chunks), now)
		}
		return nil
	})
}

// CurrentDispatch implements device.Plane.
func (p *sessionDevice) CurrentDispatch() device.Dispatch {
	return p.s.currentDispatch()
}

// OwnerActivated implements device.Plane.
func (p *sessionDevice) OwnerActivated(moduleInstanceID string, activationID uint32) {
	p.do(func(now uint64) error {
		_, err := p.b.OwnerActivated(moduleInstanceID, activationID, now)
		return err
	})
}

// OwnerDeactivated implements device.Plane.
func (p *sessionDevice) OwnerDeactivated(moduleInstanceID string, activationID uint32) {
	p.do(func(now uint64) error { return p.b.OwnerDeactivated(moduleInstanceID, activationID, now) })
}

// OwnerDestroyed implements device.Plane.
func (p *sessionDevice) OwnerDestroyed(moduleInstanceID string) {
	p.do(func(now uint64) error { return p.b.OwnerDestroyed(moduleInstanceID, now) })
}

// info is the broker snapshot (tests and diagnostics).
func (p *sessionDevice) info() (map[string]any, error) {
	if p.isClosed() {
		return nil, fmt.Errorf("device plane closed")
	}
	return p.b.Info()
}

// ---- hello helpers -----------------------------------------------------------------

// topLevelMemberCount counts the top-level members named key in a JSON
// object (a duplicated `device` member disables the device plane: its
// value would be ambiguous, decision D4).
func topLevelMemberCount(data []byte, key string) int {
	dec := json.NewDecoder(strings.NewReader(string(data)))
	tok, err := dec.Token()
	if err != nil || tok != json.Delim('{') {
		return 0
	}
	n := 0
	for dec.More() {
		k, err := dec.Token()
		if err != nil {
			return n
		}
		if s, ok := k.(string); ok && s == key {
			n++
		}
		var skip json.RawMessage
		if err := dec.Decode(&skip); err != nil {
			return n
		}
	}
	return n
}
