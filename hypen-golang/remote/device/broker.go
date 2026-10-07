package device

// Go binding of the Rust device broker (RFC 001) over the WASI C ABI.
//
// Every server SDK runs ONE broker implementation: the sans-IO
// `hypen-engine` `device::DeviceBroker`. The Go SDK reaches it through the
// `hypen_device_*` exports of the engine module (hypen_engine.wasm, embedded
// by the root package) instantiated with wazero. This file only moves bytes
// across that ABI; the protocol state machine, its limits and its JSON
// shapes live in hypen-engine-rs/src/device/broker.rs and
// hypen-engine-rs/src/wasm/{wasi_device,device_binding}.rs.
//
// A BrokerRuntime is one engine-module instance holding brokers and
// retained-bytes pools. The ABI keeps its result and error buffers in
// module-global state, so every call into one runtime is serialised by the
// runtime's mutex; brokers of one runtime can therefore be driven from any
// goroutine.
//
// A trap (a Rust panic, an out-of-bounds access) leaves the instance's Rust
// state undefined, so it poisons the whole instance and every broker in it.
// Servers therefore give each connection its own instance: a BrokerModule
// compiles the engine module once and NewRuntime instantiates a fresh,
// isolated instance from it per broker, so one connection's trap resets
// only that connection's device plane.

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"sync"

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

// ErrBrokerRuntimeFailed reports that a call into the engine module trapped
// (a Rust panic or a wazero error). The runtime is unusable afterwards:
// every broker it holds must be treated as lost (connection reset).
var ErrBrokerRuntimeFailed = errors.New("device: broker runtime failed")

// ErrBrokerClosed reports a call on a destroyed broker handle.
var ErrBrokerClosed = errors.New("device: broker destroyed")

// ABIError is a negative status returned by a `hypen_device_*` call
// (unknown handle, bad input, malformed JSON) with the module's message.
type ABIError struct {
	Call    string
	Status  int32
	Message string
}

func (e *ABIError) Error() string {
	return fmt.Sprintf("device: %s status %d: %s", e.Call, e.Status, e.Message)
}

// BrokerRuntime is one instance of the engine module used for device
// brokers. NewBrokerRuntime compiles and instantiates a standalone one;
// BrokerModule.NewRuntime instantiates one from a module compiled once.
// Close releases the instance.
type BrokerRuntime struct {
	mu  sync.Mutex
	ctx context.Context
	// rt is the wazero runtime this instance owns (closed with it), or nil
	// for an instance of a shared BrokerModule.
	rt     wazero.Runtime
	mod    api.Module
	fns    map[string]api.Function
	failed error
	closed bool
}

// abiFunctions is every export the binding calls; NewBrokerRuntime fails
// when the module lacks one (an engine built without the device broker).
var abiFunctions = []string{
	"wasi_alloc", "wasi_free",
	"hypen_device_result_len", "hypen_device_result",
	"hypen_device_last_error_len", "hypen_device_last_error",
	"hypen_device_pool_create", "hypen_device_pool_destroy", "hypen_device_pool_in_use",
	"hypen_device_broker_create", "hypen_device_broker_destroy",
	"hypen_device_broker_start", "hypen_device_broker_open", "hypen_device_broker_cancel",
	"hypen_device_broker_release_result",
	"hypen_device_broker_consumed_events", "hypen_device_broker_consumed_data",
	"hypen_device_broker_owner_activated", "hypen_device_broker_owner_deactivated",
	"hypen_device_broker_owner_destroyed",
	"hypen_device_broker_on_text", "hypen_device_broker_on_frame",
	"hypen_device_broker_report_violation",
	"hypen_device_broker_tick", "hypen_device_broker_next_deadline",
	"hypen_device_broker_set_transport_buffered", "hypen_device_broker_poll",
	"hypen_device_broker_close", "hypen_device_broker_info",
	"hypen_device_broker_is_live", "hypen_device_broker_supports",
	"hypen_device_broker_selected_version", "hypen_device_broker_owner_is_active",
	"hypen_device_broker_admits_background", "hypen_device_broker_has_background_work",
	"hypen_device_broker_revision", "hypen_device_broker_reopen_core",
	"hypen_device_broker_outstanding_credit", "hypen_device_broker_outstanding_event_credit",
	"hypen_device_negotiate", "hypen_device_select_ack",
	"hypen_device_validate_hello", "hypen_device_validate_ack",
	"hypen_device_is_oversize_text", "hypen_device_sha256_hex",
	"hypen_device_file_save_params", "hypen_device_constants",
}

// RuntimeOption adjusts the wazero runtime configuration of a
// BrokerRuntime (e.g. WithCompilationCache).
type RuntimeOption func(wazero.RuntimeConfig) wazero.RuntimeConfig

// WithCompilationCache shares compiled code with other runtimes of the
// same module bytes (the root package's SharedCompilationCache).
func WithCompilationCache(c wazero.CompilationCache) RuntimeOption {
	return func(cfg wazero.RuntimeConfig) wazero.RuntimeConfig { return cfg.WithCompilationCache(c) }
}

// NewBrokerRuntime compiles and instantiates the engine module (wasm) as a
// standalone runtime for device brokers (it owns its wazero runtime). wasm
// is the engine module's bytes (the root package embeds them:
// core.EngineWASM()). Servers use a BrokerModule instead, which compiles
// once and instantiates per connection.
func NewBrokerRuntime(wasm []byte, opts ...RuntimeOption) (*BrokerRuntime, error) {
	m, err := CompileBrokerModule(wasm, opts...)
	if err != nil {
		return nil, err
	}
	r, err := m.NewRuntime()
	if err != nil {
		_ = m.Close()
		return nil, err
	}
	// The standalone runtime owns the wazero runtime: closing it releases
	// the compiled code too.
	r.rt = m.rt
	return r, nil
}

// BrokerModule is the engine module compiled once for device brokers.
// NewRuntime instantiates a fresh, isolated BrokerRuntime from it (its own
// linear memory and Rust state; the compiled code is shared), so a trap in
// one instance never affects another. Safe for concurrent use.
type BrokerModule struct {
	ctx      context.Context
	rt       wazero.Runtime
	compiled wazero.CompiledModule

	mu     sync.Mutex
	closed bool
}

// CompileBrokerModule compiles the engine module (wasm) and instantiates
// the WASI host module its instances import.
func CompileBrokerModule(wasm []byte, opts ...RuntimeOption) (*BrokerModule, error) {
	ctx := context.Background()
	cfg := wazero.NewRuntimeConfig()
	for _, o := range opts {
		cfg = o(cfg)
	}
	rt := wazero.NewRuntimeWithConfig(ctx, cfg)
	if _, err := wasi_snapshot_preview1.Instantiate(ctx, rt); err != nil {
		_ = rt.Close(ctx)
		return nil, fmt.Errorf("device: instantiate WASI: %w", err)
	}
	compiled, err := rt.CompileModule(ctx, wasm)
	if err != nil {
		_ = rt.Close(ctx)
		return nil, fmt.Errorf("device: compile engine module: %w", err)
	}
	exports := compiled.ExportedFunctions()
	for _, name := range abiFunctions {
		if _, ok := exports[name]; !ok {
			_ = rt.Close(ctx)
			return nil, fmt.Errorf("device: engine module does not export %s (rebuild with ./build-wasm.sh)", name)
		}
	}
	return &BrokerModule{ctx: ctx, rt: rt, compiled: compiled}, nil
}

// NewRuntime instantiates a fresh engine-module instance. Close it when its
// brokers are done (it does not close the module).
func (m *BrokerModule) NewRuntime() (*BrokerRuntime, error) {
	m.mu.Lock()
	closed := m.closed
	m.mu.Unlock()
	if closed {
		return nil, errors.New("device: broker module closed")
	}
	// Anonymous: any number of instances of the one compiled module.
	mod, err := m.rt.InstantiateModule(m.ctx, m.compiled, wazero.NewModuleConfig().WithName(""))
	if err != nil {
		return nil, fmt.Errorf("device: instantiate engine module: %w", err)
	}
	r := &BrokerRuntime{ctx: m.ctx, mod: mod, fns: make(map[string]api.Function, len(abiFunctions))}
	for _, name := range abiFunctions {
		f := mod.ExportedFunction(name)
		if f == nil {
			_ = mod.Close(m.ctx)
			return nil, fmt.Errorf("device: engine module does not export %s (rebuild with ./build-wasm.sh)", name)
		}
		r.fns[name] = f
	}
	return r, nil
}

// Close releases the compiled module and every instance still open.
func (m *BrokerModule) Close() error {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return nil
	}
	m.closed = true
	m.mu.Unlock()
	return m.rt.Close(m.ctx)
}

// Close releases the module instance (and, for a standalone runtime, its
// wazero runtime). Every broker and pool it holds is gone; later calls fail
// with ErrBrokerRuntimeFailed. Idempotent.
func (r *BrokerRuntime) Close() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.failed == nil {
		r.failed = errors.New("device: broker runtime closed")
	}
	if r.closed {
		return nil
	}
	r.closed = true
	if r.rt != nil {
		return r.rt.Close(r.ctx)
	}
	return r.mod.Close(r.ctx)
}

// TrapForTesting makes the engine module trap (an out-of-bounds memory
// read inside a `hypen_device_*` export), exactly as a Rust panic would:
// the instance is poisoned and every broker it holds is lost. It exists
// for fault-isolation tests and drills; production code never calls it.
func (r *BrokerRuntime) TrapForTesting() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	// Far past the instance's linear memory: the hash reads it and traps.
	_, err := r.callLocked("hypen_device_sha256_hex", 0xFFFF_0000, 0x1_0000)
	if err == nil {
		return errors.New("device: the engine module did not trap")
	}
	return nil
}

// Err reports why the runtime is unusable, or nil while it is healthy.
func (r *BrokerRuntime) Err() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.failed
}

// ---- low-level calls (r.mu held) ------------------------------------------

func (r *BrokerRuntime) callLocked(name string, args ...uint64) (uint64, error) {
	if r.failed != nil {
		return 0, fmt.Errorf("%w: %v", ErrBrokerRuntimeFailed, r.failed)
	}
	res, err := r.fns[name].Call(r.ctx, args...)
	if err != nil {
		// A trap leaves Rust state (RefCell borrows, partially applied
		// transitions) undefined: poison the whole instance.
		r.failed = fmt.Errorf("%s: %w", name, err)
		return 0, fmt.Errorf("%w: %v", ErrBrokerRuntimeFailed, r.failed)
	}
	if len(res) == 0 {
		return 0, nil
	}
	return res[0], nil
}

func (r *BrokerRuntime) i32Locked(name string, args ...uint64) (int32, error) {
	v, err := r.callLocked(name, args...)
	return int32(uint32(v)), err
}

func (r *BrokerRuntime) i64Locked(name string, args ...uint64) (int64, error) {
	v, err := r.callLocked(name, args...)
	return int64(v), err
}

// buf is one allocation in linear memory.
type buf struct{ ptr, len uint64 }

// putLocked copies b into linear memory; a zero-length run needs no pointer.
func (r *BrokerRuntime) putLocked(b []byte) (buf, error) {
	if len(b) == 0 {
		return buf{}, nil
	}
	p, err := r.callLocked("wasi_alloc", uint64(len(b)))
	if err != nil {
		return buf{}, err
	}
	if p == 0 || !r.mod.Memory().Write(uint32(p), b) {
		r.failed = errors.New("wasi_alloc returned an unusable pointer")
		return buf{}, ErrBrokerRuntimeFailed
	}
	return buf{ptr: p, len: uint64(len(b))}, nil
}

func (r *BrokerRuntime) freeLocked(b buf) {
	if b.len == 0 || r.failed != nil {
		return
	}
	_, _ = r.callLocked("wasi_free", b.ptr, b.len)
}

// readBufLocked copies one of the ABI's module-global buffers out.
func (r *BrokerRuntime) readBufLocked(lenFn, copyFn string) ([]byte, error) {
	n, err := r.callLocked(lenFn)
	if err != nil {
		return nil, err
	}
	n = uint64(uint32(n))
	if n == 0 {
		return nil, nil
	}
	p, err := r.callLocked("wasi_alloc", n)
	if err != nil {
		return nil, err
	}
	defer r.freeLocked(buf{ptr: p, len: n})
	got, err := r.callLocked(copyFn, p, n)
	if err != nil {
		return nil, err
	}
	b, ok := r.mod.Memory().Read(uint32(p), uint32(got))
	if !ok {
		r.failed = errors.New("device result buffer out of range")
		return nil, ErrBrokerRuntimeFailed
	}
	return append([]byte(nil), b...), nil
}

func (r *BrokerRuntime) resultLocked() ([]byte, error) {
	return r.readBufLocked("hypen_device_result_len", "hypen_device_result")
}

func (r *BrokerRuntime) abiErrorLocked(call string, status int32) error {
	msg, err := r.readBufLocked("hypen_device_last_error_len", "hypen_device_last_error")
	if err != nil {
		return err
	}
	return &ABIError{Call: call, Status: status, Message: string(msg)}
}

// withBytes runs f with each byte run copied into linear memory, freeing
// them afterwards.
func (r *BrokerRuntime) withBytesLocked(runs [][]byte, f func(bufs []buf) error) error {
	bufs := make([]buf, len(runs))
	defer func() {
		for _, b := range bufs {
			r.freeLocked(b)
		}
	}()
	for i, run := range runs {
		b, err := r.putLocked(run)
		if err != nil {
			return err
		}
		bufs[i] = b
	}
	return f(bufs)
}

// ---- helpers that need no broker ----------------------------------------------

// Negotiate runs the broker-backed server's handshake selection on the raw
// `hello.device` JSON: the `sessionAck.device` JSON, or nil when the hello
// is invalid (strict decoding, decision D7) or nothing mutual was found —
// device access is then disabled and UI-only operation continues.
// binaryRoute reports whether the transport carries binary frames.
func (r *BrokerRuntime) Negotiate(hello []byte, binaryRoute bool) (json.RawMessage, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []byte
	err := r.withBytesLocked([][]byte{hello}, func(b []buf) error {
		st, err := r.i32Locked("hypen_device_negotiate", b[0].ptr, b[0].len, boolArg(binaryRoute))
		if err != nil {
			return err
		}
		if st != 0 {
			return r.abiErrorLocked("negotiate", st)
		}
		out, err = r.resultLocked()
		return err
	})
	if err != nil {
		return nil, err
	}
	if string(out) == "null" || len(out) == 0 {
		return nil, nil
	}
	return json.RawMessage(out), nil
}

// resultCallLocked runs call over the byte runs and returns the result
// buffer (status 0), or the ABI error.
func (r *BrokerRuntime) resultCallLocked(call string, runs [][]byte, args func(b []buf) []uint64) ([]byte, error) {
	var out []byte
	err := r.withBytesLocked(runs, func(b []buf) error {
		st, err := r.i32Locked("hypen_device_"+call, args(b)...)
		if err != nil {
			return err
		}
		if st != 0 {
			return r.abiErrorLocked(call, st)
		}
		out, err = r.resultLocked()
		return err
	})
	return out, err
}

// ServerSide is the server half of a handshake selection
// (hypen_device_select_ack): the protocol versions, capability offers and
// binary route the server has.
type ServerSide struct {
	ProtocolVersions []uint32          `json:"protocolVersions"`
	Capabilities     []CapabilityOffer `json:"capabilities"`
	Binary           bool              `json:"binary"`
}

// CapabilityOffer is one `{name, versions}` offer (handshake-v1).
type CapabilityOffer struct {
	Name     string   `json:"name"`
	Versions []uint32 `json:"versions"`
}

// SelectAck runs the Rust handshake selection (`select_device_ack`) on the
// raw `hello.device` JSON against explicit server lists: the
// `sessionAck.device` JSON, or nil when device access is disabled (an
// invalid hello, decision D7, or nothing mutual). Negotiate is the same
// selection against the broker's own advertisement.
func (r *BrokerRuntime) SelectAck(hello []byte, server ServerSide) (json.RawMessage, error) {
	if server.ProtocolVersions == nil {
		server.ProtocolVersions = []uint32{}
	}
	if server.Capabilities == nil {
		server.Capabilities = []CapabilityOffer{}
	}
	cfg, err := json.Marshal(server)
	if err != nil {
		return nil, err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	out, err := r.resultCallLocked("select_ack", [][]byte{hello, cfg}, func(b []buf) []uint64 {
		return []uint64{b[0].ptr, b[0].len, b[1].ptr, b[1].len}
	})
	if err != nil || string(out) == "null" || len(out) == 0 {
		return nil, err
	}
	return json.RawMessage(out), nil
}

// InvalidError is the Rust strict decoder's verdict on a handshake value
// (ValidateHello / ValidateAck): the value is not valid.
type InvalidError struct{ Reason string }

func (e *InvalidError) Error() string { return "device: invalid: " + e.Reason }

func (r *BrokerRuntime) validate(call string, text []byte) (json.RawMessage, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	out, err := r.resultCallLocked(call, [][]byte{text}, func(b []buf) []uint64 {
		return []uint64{b[0].ptr, b[0].len}
	})
	if err != nil {
		return nil, err
	}
	var res struct {
		OK    bool            `json:"ok"`
		Value json.RawMessage `json:"value"`
		Error string          `json:"error"`
	}
	if err := json.Unmarshal(out, &res); err != nil {
		return nil, fmt.Errorf("device: %s result: %w", call, err)
	}
	if !res.OK {
		return nil, &InvalidError{Reason: res.Error}
	}
	return res.Value, nil
}

// ValidateHello strictly decodes `hello.device` with the Rust decoder: the
// decoded value re-encoded, or *InvalidError. Text that is not UTF-8 is an
// *ABIError (it never reaches the decoder).
func (r *BrokerRuntime) ValidateHello(hello []byte) (json.RawMessage, error) {
	return r.validate("validate_hello", hello)
}

// ValidateAck strictly decodes `sessionAck.device` (same result shape as
// ValidateHello).
func (r *BrokerRuntime) ValidateAck(ack []byte) (json.RawMessage, error) {
	return r.validate("validate_ack", ack)
}

// Sha256Hex is the lowercase hex SHA-256 the broker computes over data.
func (r *BrokerRuntime) Sha256Hex(data []byte) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if data == nil {
		data = []byte{}
	}
	out, err := r.resultCallLocked("sha256_hex", [][]byte{data}, func(b []buf) []uint64 {
		return []uint64{b[0].ptr, b[0].len}
	})
	return string(out), err
}

// FileSaveParams is the file.save@1 announcement for data, built by Rust
// (hypen_device_file_save_params): `{channel: 0, name, contentType, bytes,
// sha256}`, the same values the broker checks the download against.
func (r *BrokerRuntime) FileSaveParams(name, contentType string, data []byte) (json.RawMessage, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	out, err := r.resultCallLocked("file_save_params", [][]byte{[]byte(name), []byte(contentType), data}, func(b []buf) []uint64 {
		return []uint64{b[0].ptr, b[0].len, b[1].ptr, b[1].len, b[2].ptr, b[2].len}
	})
	if err != nil {
		return nil, err
	}
	return json.RawMessage(out), nil
}

// IsOversizeText reports whether text is a device message over the 1 MiB
// limit, decided without parsing it (RFC 001 §2.1). Only text above the
// limit is inspected.
func (r *BrokerRuntime) IsOversizeText(text []byte) (bool, error) {
	if len(text) <= MaxMessageBytes {
		return false, nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	var v int32
	err := r.withBytesLocked([][]byte{text}, func(b []buf) (err error) {
		v, err = r.i32Locked("hypen_device_is_oversize_text", b[0].ptr, b[0].len)
		if err == nil && v < 0 {
			err = r.abiErrorLocked("is_oversize_text", v)
		}
		return err
	})
	return v == 1, err
}

// Constants returns the protocol and broker constants the engine was built
// with (hypen_device_constants), as JSON.
func (r *BrokerRuntime) Constants() (map[string]any, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, err := r.i32Locked("hypen_device_constants"); err != nil {
		return nil, err
	}
	raw, err := r.resultLocked()
	if err != nil {
		return nil, err
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, err
	}
	return m, nil
}

// ---- pools --------------------------------------------------------------------

// Pool is an aggregate retained-bytes budget shared by several brokers of
// one runtime (every connection of a server). The zero Pool is "none".
type Pool struct{ handle uint32 }

// NewPool creates a pool of limit bytes.
func (r *BrokerRuntime) NewPool(limit uint64) (Pool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	h, err := r.callLocked("hypen_device_pool_create", limit)
	if err != nil {
		return Pool{}, err
	}
	return Pool{handle: uint32(h)}, nil
}

// PoolInUse reports the bytes currently reserved in p.
func (r *BrokerRuntime) PoolInUse(p Pool) (uint64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	v, err := r.i64Locked("hypen_device_pool_in_use", uint64(p.handle))
	if err != nil {
		return 0, err
	}
	if v < 0 {
		return 0, r.abiErrorLocked("pool_in_use", int32(v))
	}
	return uint64(v), nil
}

// DestroyPool drops the host's reference to p (brokers created with it keep
// sharing it until they are destroyed).
func (r *BrokerRuntime) DestroyPool(p Pool) error {
	if p.handle == 0 {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	st, err := r.i32Locked("hypen_device_pool_destroy", uint64(p.handle))
	if err != nil {
		return err
	}
	if st != 0 {
		return r.abiErrorLocked("pool_destroy", st)
	}
	return nil
}

// ---- brokers ------------------------------------------------------------------

// Broker is one connection's device broker (a handle into a
// BrokerRuntime). All methods are safe for concurrent use; the host still
// feeds one monotonic clock to every call of one broker.
type Broker struct {
	r      *BrokerRuntime
	handle uint32
	gone   bool // destroyed (guarded by r.mu)
}

// Refusal is a local refusal of open/start: nothing was sent.
type Refusal struct {
	Code   DeviceErrorCode `json:"code"`
	Detail string          `json:"detail,omitempty"`
}

func (e *Refusal) Error() string {
	if e.Detail == "" {
		return "device: " + string(e.Code)
	}
	return "device: " + string(e.Code) + ": " + e.Detail
}

// NewBroker creates a broker from its configuration JSON (the shape
// documented in hypen-engine-rs/src/wasm/device_binding.rs: `ack` required,
// limits optional), sharing pool (the zero Pool = none).
func (r *BrokerRuntime) NewBroker(config []byte, pool Pool, nowMs uint64) (*Broker, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var h uint64
	err := r.withBytesLocked([][]byte{config}, func(b []buf) (err error) {
		h, err = r.callLocked("hypen_device_broker_create", b[0].ptr, b[0].len, uint64(pool.handle), nowMs)
		if err == nil && uint32(h) == 0 {
			err = r.abiErrorLocked("broker_create", 0)
		}
		return err
	})
	if err != nil {
		return nil, err
	}
	return &Broker{r: r, handle: uint32(h)}, nil
}

// locked runs f with the runtime lock held, refusing destroyed handles.
func (b *Broker) locked(f func() error) error {
	b.r.mu.Lock()
	defer b.r.mu.Unlock()
	if b.gone {
		return ErrBrokerClosed
	}
	return f()
}

func (b *Broker) status(call string, st int32, err error) error {
	if err != nil {
		return err
	}
	if st < 0 {
		return b.r.abiErrorLocked(call, st)
	}
	return nil
}

// openResult decodes `{"id": n}` / `{"error": {...}}` from the result buffer.
func (b *Broker) openResultLocked() (uint32, *Refusal, error) {
	raw, err := b.r.resultLocked()
	if err != nil {
		return 0, nil, err
	}
	var res struct {
		ID    *uint32  `json:"id"`
		Error *Refusal `json:"error"`
	}
	if err := json.Unmarshal(raw, &res); err != nil {
		return 0, nil, fmt.Errorf("device: open result: %w", err)
	}
	if res.ID != nil {
		return *res.ID, nil, nil
	}
	if res.Error == nil {
		return 0, nil, errors.New("device: open result carries neither id nor error")
	}
	return 0, res.Error, nil
}

// Start opens the connection-owned core.capabilities stream (once, right
// after the handshake selected the device plane). A refusal is returned as
// *Refusal.
func (b *Broker) Start(nowMs uint64) (uint32, error) {
	var id uint32
	err := b.locked(func() error {
		st, err := b.r.i32Locked("hypen_device_broker_start", uint64(b.handle), nowMs)
		if err := b.status("broker_start", st, err); err != nil {
			return err
		}
		var ref *Refusal
		id, ref, err = b.openResultLocked()
		if err == nil && ref != nil {
			err = ref
		}
		return err
	})
	return id, err
}

// Open opens a request from the open JSON (device_binding.rs "Open JSON").
// download carries file.save bytes (nil = none). A local refusal (nothing
// sent) is returned as *Refusal; other errors are host errors.
func (b *Broker) Open(spec []byte, download []byte, nowMs uint64) (uint32, error) {
	var id uint32
	err := b.locked(func() error {
		return b.r.withBytesLocked([][]byte{spec, download}, func(bufs []buf) error {
			has := uint64(0)
			if download != nil {
				has = 1
			}
			st, err := b.r.i32Locked("hypen_device_broker_open", uint64(b.handle),
				bufs[0].ptr, bufs[0].len, bufs[1].ptr, bufs[1].len, has, nowMs)
			if err := b.status("broker_open", st, err); err != nil {
				return err
			}
			var ref *Refusal
			id, ref, err = b.openResultLocked()
			if err == nil && ref != nil {
				err = ref
			}
			return err
		})
	})
	return id, err
}

func (b *Broker) simple(call string, args ...uint64) error {
	return b.locked(func() error {
		st, err := b.r.i32Locked(call, append([]uint64{uint64(b.handle)}, args...)...)
		return b.status(call, st, err)
	})
}

// Cancel is a server-initiated cancel of request id (it settles cancelled).
func (b *Broker) Cancel(id uint32, nowMs uint64) error {
	return b.simple("hypen_device_broker_cancel", uint64(id), nowMs)
}

// ReleaseResult releases the retained-bytes charge of a result opened with
// holdResult (Outcome.Held); idempotent, a no-op for any other id.
func (b *Broker) ReleaseResult(id uint32) error {
	return b.simple("hypen_device_broker_release_result", uint64(id))
}

// ConsumedEvents reports that the consumer finished n JSON events of id.
func (b *Broker) ConsumedEvents(id uint32, n uint64, nowMs uint64) error {
	return b.simple("hypen_device_broker_consumed_events", uint64(id), n, nowMs)
}

// ConsumedData reports that the consumer finished the next chunks data
// chunks of stream id.
func (b *Broker) ConsumedData(id uint32, chunks uint32, nowMs uint64) error {
	return b.simple("hypen_device_broker_consumed_data", uint64(id), uint64(chunks), nowMs)
}

func (b *Broker) withText(call string, s string, f func(p buf) (int32, error)) (int32, error) {
	var v int32
	err := b.locked(func() error {
		return b.r.withBytesLocked([][]byte{[]byte(s)}, func(bufs []buf) error {
			st, err := f(bufs[0])
			if err := b.status(call, st, err); err != nil {
				return err
			}
			v = st
			return nil
		})
	})
	return v, err
}

// OwnerActivated records that moduleInstanceID became active as
// activationID (strictly increasing per instance); false for a stale
// activation or a destroyed instance.
func (b *Broker) OwnerActivated(moduleInstanceID string, activationID uint32, nowMs uint64) (bool, error) {
	v, err := b.withText("owner_activated", moduleInstanceID, func(p buf) (int32, error) {
		return b.r.i32Locked("hypen_device_broker_owner_activated", uint64(b.handle), p.ptr, p.len, uint64(activationID), nowMs)
	})
	return v == 1, err
}

// OwnerDeactivated ends activationID's authority: its activation-owned work
// is cancelled; background work survives.
func (b *Broker) OwnerDeactivated(moduleInstanceID string, activationID uint32, nowMs uint64) error {
	_, err := b.withText("owner_deactivated", moduleInstanceID, func(p buf) (int32, error) {
		return b.r.i32Locked("hypen_device_broker_owner_deactivated", uint64(b.handle), p.ptr, p.len, uint64(activationID), nowMs)
	})
	return err
}

// OwnerDestroyed cancels all of the module instance's work; it can never be
// activated again on this broker.
func (b *Broker) OwnerDestroyed(moduleInstanceID string, nowMs uint64) error {
	_, err := b.withText("owner_destroyed", moduleInstanceID, func(p buf) (int32, error) {
		return b.r.i32Locked("hypen_device_broker_owner_destroyed", uint64(b.handle), p.ptr, p.len, nowMs)
	})
	return err
}

// OwnerIsActive reports whether (moduleInstanceID, activationID) is the
// module's live activation.
func (b *Broker) OwnerIsActive(moduleInstanceID string, activationID uint32) (bool, error) {
	v, err := b.withText("owner_is_active", moduleInstanceID, func(p buf) (int32, error) {
		return b.r.i32Locked("hypen_device_broker_owner_is_active", uint64(b.handle), p.ptr, p.len, uint64(activationID))
	})
	return v == 1, err
}

// AdmitsBackground reports whether a new background request from the
// module fits the pin cap.
func (b *Broker) AdmitsBackground(moduleInstanceID string) (bool, error) {
	v, err := b.withText("admits_background", moduleInstanceID, func(p buf) (int32, error) {
		return b.r.i32Locked("hypen_device_broker_admits_background", uint64(b.handle), p.ptr, p.len)
	})
	return v == 1, err
}

// HasBackgroundWork reports whether the module owns live background work.
func (b *Broker) HasBackgroundWork(moduleInstanceID string) (bool, error) {
	v, err := b.withText("has_background_work", moduleInstanceID, func(p buf) (int32, error) {
		return b.r.i32Locked("hypen_device_broker_has_background_work", uint64(b.handle), p.ptr, p.len)
	})
	return v == 1, err
}

// OnText feeds one client → server device text message (raw bytes: invalid
// UTF-8 counts as a connection-level violation). True when it was for a
// live request.
func (b *Broker) OnText(text []byte, nowMs uint64) (bool, error) {
	var v int32
	err := b.locked(func() error {
		return b.r.withBytesLocked([][]byte{text}, func(bufs []buf) error {
			st, err := b.r.i32Locked("hypen_device_broker_on_text", uint64(b.handle), bufs[0].ptr, bufs[0].len, nowMs)
			if err := b.status("broker_on_text", st, err); err != nil {
				return err
			}
			v = st
			return nil
		})
	})
	return v == 1, err
}

// OnFrame feeds one client → server binary frame. True when accepted.
func (b *Broker) OnFrame(frame []byte, nowMs uint64) (bool, error) {
	var v int32
	err := b.locked(func() error {
		return b.r.withBytesLocked([][]byte{frame}, func(bufs []buf) error {
			st, err := b.r.i32Locked("hypen_device_broker_on_frame", uint64(b.handle), bufs[0].ptr, bufs[0].len, nowMs)
			if err := b.status("broker_on_frame", st, err); err != nil {
				return err
			}
			v = st
			return nil
		})
	})
	return v == 1, err
}

// ReportViolation counts a connection-level violation the host detected
// itself (e.g. over-limit device text it refused to parse).
func (b *Broker) ReportViolation(reason string, nowMs uint64) error {
	_, err := b.withText("report_violation", reason, func(p buf) (int32, error) {
		return b.r.i32Locked("hypen_device_broker_report_violation", uint64(b.handle), p.ptr, p.len, nowMs)
	})
	return err
}

// Tick runs every timer due at nowMs and returns the next deadline
// (absolute ms); ok is false when nothing is pending.
func (b *Broker) Tick(nowMs uint64) (next uint64, ok bool, err error) {
	err = b.locked(func() error {
		v, err := b.r.i64Locked("hypen_device_broker_tick", uint64(b.handle), nowMs)
		if err != nil {
			return err
		}
		if v < -1 {
			return b.r.abiErrorLocked("broker_tick", int32(v))
		}
		if v >= 0 {
			next, ok = uint64(v), true
		}
		return nil
	})
	return next, ok, err
}

// NextDeadline is the next deadline without running anything.
func (b *Broker) NextDeadline() (next uint64, ok bool, err error) {
	err = b.locked(func() error {
		v, err := b.r.i64Locked("hypen_device_broker_next_deadline", uint64(b.handle))
		if err != nil {
			return err
		}
		if v < -1 {
			return b.r.abiErrorLocked("broker_next_deadline", int32(v))
		}
		if v >= 0 {
			next, ok = uint64(v), true
		}
		return nil
	})
	return next, ok, err
}

// SetTransportBuffered reports the transport's buffered (accepted,
// unwritten) bytes; bulk frames are handed out only below the limit.
func (b *Broker) SetTransportBuffered(n uint64) error {
	return b.simple("hypen_device_broker_set_transport_buffered", n)
}

// Close closes the device plane locally: every live request settles with
// code (nothing is sent). Poll afterwards to collect the settlements.
func (b *Broker) Close(code DeviceErrorCode) error {
	_, err := b.withText("broker_close", string(code), func(p buf) (int32, error) {
		return b.r.i32Locked("hypen_device_broker_close", uint64(b.handle), p.ptr, p.len)
	})
	return err
}

// Destroy releases the handle (closing the broker with connectionLost when
// the host did not, so pooled bytes always return). Idempotent.
func (b *Broker) Destroy() error {
	b.r.mu.Lock()
	defer b.r.mu.Unlock()
	if b.gone {
		return nil
	}
	b.gone = true
	if b.r.failed != nil {
		return nil
	}
	st, err := b.r.i32Locked("hypen_device_broker_destroy", uint64(b.handle))
	return b.status("broker_destroy", st, err)
}

// Supports reports whether capability is in the live selection.
func (b *Broker) Supports(capability string) (bool, error) {
	v, err := b.withText("broker_supports", capability, func(p buf) (int32, error) {
		return b.r.i32Locked("hypen_device_broker_supports", uint64(b.handle), p.ptr, p.len)
	})
	return v == 1, err
}

// SelectedVersion is the live selection's revision of capability.
func (b *Broker) SelectedVersion(capability string) (uint32, bool, error) {
	var ver int64
	err := b.locked(func() error {
		return b.r.withBytesLocked([][]byte{[]byte(capability)}, func(bufs []buf) error {
			v, err := b.r.i64Locked("hypen_device_broker_selected_version", uint64(b.handle), bufs[0].ptr, bufs[0].len)
			if err != nil {
				return err
			}
			if v < -1 {
				return b.r.abiErrorLocked("broker_selected_version", int32(v))
			}
			ver = v
			return nil
		})
	})
	if err != nil || ver < 0 {
		return 0, false, err
	}
	return uint32(ver), true, nil
}

// IsLive reports whether request id is live.
func (b *Broker) IsLive(id uint32) (bool, error) {
	var v int32
	err := b.locked(func() error {
		st, err := b.r.i32Locked("hypen_device_broker_is_live", uint64(b.handle), uint64(id))
		v = st
		return b.status("broker_is_live", st, err)
	})
	return v == 1, err
}

// optI64 runs an i64-returning broker call where -1 means "none".
func (b *Broker) optI64(call string, args ...uint64) (uint64, bool, error) {
	var v int64
	err := b.locked(func() error {
		var err error
		v, err = b.r.i64Locked("hypen_device_broker_"+call, append([]uint64{uint64(b.handle)}, args...)...)
		if err != nil {
			return err
		}
		if v < -1 {
			return b.r.abiErrorLocked("broker_"+call, int32(v))
		}
		return nil
	})
	if err != nil || v < 0 {
		return 0, false, err
	}
	return uint64(v), true, nil
}

// OutstandingCredit is request id's outstanding upload/download byte
// credit; ok is false when id has none (not live, or no binary plane).
func (b *Broker) OutstandingCredit(id uint32) (credit uint64, ok bool, err error) {
	return b.optI64("outstanding_credit", uint64(id))
}

// OutstandingEventCredit is request id's outstanding JSON event credit.
func (b *Broker) OutstandingEventCredit(id uint32) (credit uint64, ok bool, err error) {
	return b.optI64("outstanding_event_credit", uint64(id))
}

// ReopenCoreCapabilities runs the planned reopen of core.capabilities now
// (the broker does it on its own before the stream's deadline): the new
// stream id; ok is false when nothing was reopened.
func (b *Broker) ReopenCoreCapabilities(nowMs uint64) (id uint32, ok bool, err error) {
	v, ok, err := b.optI64("reopen_core", nowMs)
	return uint32(v), ok, err
}

// Revision is the revision the broker enforces for capability@version (the
// registry revision or its configured override, maxItemBytes capped) as
// JSON, or nil when it is not a registry revision.
func (b *Broker) Revision(capability string, version uint32) (json.RawMessage, error) {
	var out []byte
	err := b.locked(func() error {
		return b.r.withBytesLocked([][]byte{[]byte(capability)}, func(bufs []buf) error {
			st, err := b.r.i32Locked("hypen_device_broker_revision", uint64(b.handle), bufs[0].ptr, bufs[0].len, uint64(version))
			if err := b.status("broker_revision", st, err); err != nil {
				return err
			}
			out, err = b.r.resultLocked()
			return err
		})
	})
	if err != nil || string(out) == "null" || len(out) == 0 {
		return nil, err
	}
	return json.RawMessage(out), nil
}

// Info returns the broker's snapshot JSON (device_binding::info_json).
func (b *Broker) Info() (map[string]any, error) {
	var m map[string]any
	err := b.locked(func() error {
		st, err := b.r.i32Locked("hypen_device_broker_info", uint64(b.handle))
		if err := b.status("broker_info", st, err); err != nil {
			return err
		}
		raw, err := b.r.resultLocked()
		if err != nil {
			return err
		}
		return json.Unmarshal(raw, &m)
	})
	return m, err
}

// ---- outputs ------------------------------------------------------------------

// OutputKind discriminates broker outputs.
type OutputKind uint8

const (
	// OutputSendText: send Text on the text channel.
	OutputSendText OutputKind = iota + 1
	// OutputSendFrame: send Bytes as a binary frame.
	OutputSendFrame
	// OutputEvent: a validated JSON stream event for request ID's consumer.
	OutputEvent
	// OutputData: upload bytes of a binary-upload stream, in order.
	OutputData
	// OutputSettled: request ID ended with Outcome (exactly once).
	OutputSettled
	// OutputCloseConnection: close the socket with Code/Reason.
	OutputCloseConnection
)

// Output is one thing the broker asks the host to do, in order.
type Output struct {
	Kind    OutputKind
	Text    []byte
	Bytes   []byte
	ID      uint32
	Channel uint16
	Event   json.RawMessage
	Outcome *Outcome
	Code    int
	Reason  string
}

// Outcome is a request's terminal outcome.
type Outcome struct {
	OK        bool
	Result    json.RawMessage
	Blobs     []OutcomeBlob
	Simulated bool
	Held      bool
	Code      DeviceErrorCode
	Detail    string
}

// OutcomeBlob is one verified upload item of a successful unary result.
type OutcomeBlob struct {
	Channel     uint16
	Name        string
	HasName     bool
	ContentType string
	Bytes       []byte
}

type wireBlob struct {
	Channel     uint16  `json:"channel"`
	Name        *string `json:"name"`
	ContentType string  `json:"contentType"`
	Offset      int     `json:"offset"`
	Len         int     `json:"len"`
}

type wireOutcome struct {
	OK        bool            `json:"ok"`
	Result    json.RawMessage `json:"result"`
	Blobs     []wireBlob      `json:"blobs"`
	Simulated bool            `json:"simulated"`
	Held      bool            `json:"held"`
	Code      DeviceErrorCode `json:"code"`
	Detail    string          `json:"detail"`
}

type wireOutput struct {
	Type    string          `json:"type"`
	Text    string          `json:"text"`
	ID      uint32          `json:"id"`
	Channel uint16          `json:"channel"`
	Offset  int             `json:"offset"`
	Len     int             `json:"len"`
	Code    int             `json:"code"`
	Reason  string          `json:"reason"`
	Event   json.RawMessage `json:"event"`
	Outcome *wireOutcome    `json:"outcome"`
}

// Poll drains every output the broker has now (plus at most one bulk
// scheduling turn: poll again while NextDeadline reports work due).
func (b *Broker) Poll() ([]Output, error) {
	var raw []byte
	err := b.locked(func() error {
		st, err := b.r.i32Locked("hypen_device_broker_poll", uint64(b.handle))
		if err := b.status("broker_poll", st, err); err != nil {
			return err
		}
		raw, err = b.r.resultLocked()
		return err
	})
	if err != nil {
		return nil, err
	}
	return DecodeFramedOutputs(raw)
}

// DecodeFramedOutputs decodes the WASI poll framing
// `[u32 LE header_len][JSON array][payload]` (device_binding::encode_framed).
func DecodeFramedOutputs(raw []byte) ([]Output, error) {
	if len(raw) < 4 {
		return nil, fmt.Errorf("device: poll framing too short (%d bytes)", len(raw))
	}
	hl := uint64(binary.LittleEndian.Uint32(raw[:4]))
	if 4+hl > uint64(len(raw)) {
		return nil, errors.New("device: poll header length exceeds the buffer")
	}
	payload := raw[4+hl:]
	var wire []wireOutput
	if err := json.Unmarshal(raw[4:4+hl], &wire); err != nil {
		return nil, fmt.Errorf("device: poll header: %w", err)
	}
	slice := func(off, n int) ([]byte, error) {
		if off < 0 || n < 0 || off+n > len(payload) {
			return nil, fmt.Errorf("device: payload run %d+%d out of range (%d)", off, n, len(payload))
		}
		return append([]byte(nil), payload[off:off+n]...), nil
	}
	out := make([]Output, 0, len(wire))
	for _, w := range wire {
		o := Output{ID: w.ID, Channel: w.Channel}
		switch w.Type {
		case "sendText":
			o.Kind = OutputSendText
			o.Text = []byte(w.Text)
		case "sendFrame":
			o.Kind = OutputSendFrame
			b, err := slice(w.Offset, w.Len)
			if err != nil {
				return nil, err
			}
			o.Bytes = b
		case "event":
			o.Kind = OutputEvent
			o.Event = w.Event
		case "data":
			o.Kind = OutputData
			b, err := slice(w.Offset, w.Len)
			if err != nil {
				return nil, err
			}
			o.Bytes = b
		case "settled":
			o.Kind = OutputSettled
			if w.Outcome == nil {
				return nil, errors.New("device: settled output without outcome")
			}
			oc := &Outcome{
				OK: w.Outcome.OK, Result: w.Outcome.Result, Simulated: w.Outcome.Simulated,
				Held: w.Outcome.Held, Code: w.Outcome.Code, Detail: w.Outcome.Detail,
			}
			for _, wb := range w.Outcome.Blobs {
				b, err := slice(wb.Offset, wb.Len)
				if err != nil {
					return nil, err
				}
				blob := OutcomeBlob{Channel: wb.Channel, ContentType: wb.ContentType, Bytes: b}
				if wb.Name != nil {
					blob.Name, blob.HasName = *wb.Name, true
				}
				oc.Blobs = append(oc.Blobs, blob)
			}
			o.Outcome = oc
		case "closeConnection":
			o.Kind = OutputCloseConnection
			o.Code = w.Code
			o.Reason = w.Reason
		default:
			return nil, fmt.Errorf("device: unknown broker output %q", w.Type)
		}
		out = append(out, o)
	}
	return out, nil
}

func boolArg(b bool) uint64 {
	if b {
		return 1
	}
	return 0
}
