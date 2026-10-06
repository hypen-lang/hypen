// Package device is the handler-facing API of the Device Capability
// Protocol (RFC 001) for Go modules served by the remote server.
//
// An action handler reaches the connection's device plane through its
// context:
//
//	OnAction("pick", func(ctx core.TypedActionContext[State]) {
//	    items, err := ctx.Device().Gallery().Pick(context.Background(),
//	        device.GalleryPickParams{MediaTypes: []device.MediaType{device.MediaTypePhoto}, MaxCount: 1})
//	    if err != nil {
//	        ctx.State.Error = err.Error() // denied, cancelled, unsupported, … are ordinary values
//	        return
//	    }
//	    ctx.State.PhotoBytes = len(items[0].Bytes) // hash-verified by the broker
//	})
//
// # Protocol state lives in Rust
//
// Every server SDK runs the same sans-IO broker (`hypen-engine`
// `device::DeviceBroker`, reached here through the engine module's WASI
// ABI, remote/device.Broker): request ids, owners and sweeps, leases,
// deadlines, credit, blob verification, downloads and bulk scheduling. This
// package only shapes that plane into Go: blocking calls with
// context.Context cancellation, typed helpers per capability, and errors as
// ordinary values (*Error with a closed Code).
//
// # Authority
//
// A Device is scoped to the invocation that received it: the module
// instance and the activation that was live when the handler started, and
// the dispatch's provenance. When the module is deactivated or destroyed,
// its activation-owned work is cancelled and new requests from the stale
// scope are refused (unavailable, "owner-inactive"). A Device obtained by a
// replayed or agent-originated dispatch can never open device work
// (unavailable, "syncActions.replay") — the restriction is a property of
// the value, so it survives goroutines and waits. With no device plane
// (device disabled on the server, not negotiated, or closed) every call fails
// unavailable ("device-disabled") and Supports reports false.
//
// # Waiting
//
// Calls block the calling goroutine until the device answers. While a
// handler waits, the session's dispatch slot is yielded: later actions of
// the same session run, and the handler resumes (holding the slot again)
// once the operation settles. Revalidate state after a wait — data may be
// stale even while the activation is live (RFC 001 §4).
package device

import (
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	wire "github.com/hypen-space/core/remote/device"
)

// Code is the closed device error taxonomy (RFC 001 §3).
type Code = wire.DeviceErrorCode

// Error codes.
const (
	CodeUnsupported    = wire.ErrorUnsupported
	CodeUnavailable    = wire.ErrorUnavailable
	CodeDenied         = wire.ErrorDenied
	CodeRevoked        = wire.ErrorRevoked
	CodeCancelled      = wire.ErrorCancelled
	CodeTimeout        = wire.ErrorTimeout
	CodeThrottled      = wire.ErrorThrottled
	CodeConnectionLost = wire.ErrorConnectionLost
	CodeInvalidParams  = wire.ErrorInvalidParams
	CodeInternal       = wire.ErrorInternal
)

// Error is a device operation's failure: an ordinary value, never a panic.
// Detail is the platform detail or the broker's local-refusal reason
// (untrusted text from the client where it came from the client).
type Error struct {
	Code   Code
	Detail string
	cause  error
}

func (e *Error) Error() string {
	if e.Detail == "" {
		return "device: " + string(e.Code)
	}
	return "device: " + string(e.Code) + " (" + e.Detail + ")"
}

// Unwrap exposes the context error when a caller's context ended the
// operation (errors.Is(err, context.Canceled) holds then).
func (e *Error) Unwrap() error { return e.cause }

// Is matches another *Error by Code (and by Detail when the target names
// one), so errors.Is(err, device.ErrDenied) works.
func (e *Error) Is(target error) bool {
	t, ok := target.(*Error)
	if !ok {
		return false
	}
	return t.Code == e.Code && (t.Detail == "" || t.Detail == e.Detail)
}

// Sentinels for errors.Is.
var (
	ErrUnsupported    = &Error{Code: CodeUnsupported}
	ErrUnavailable    = &Error{Code: CodeUnavailable}
	ErrDenied         = &Error{Code: CodeDenied}
	ErrRevoked        = &Error{Code: CodeRevoked}
	ErrCancelled      = &Error{Code: CodeCancelled}
	ErrTimeout        = &Error{Code: CodeTimeout}
	ErrThrottled      = &Error{Code: CodeThrottled}
	ErrConnectionLost = &Error{Code: CodeConnectionLost}
	ErrInvalidParams  = &Error{Code: CodeInvalidParams}
	ErrInternal       = &Error{Code: CodeInternal}
)

// CodeOf returns the device error code carried by err, or "" when err is
// not a device error.
func CodeOf(err error) Code {
	var de *Error
	if errors.As(err, &de) {
		return de.Code
	}
	return ""
}

// Owner identifies the module instance and activation device work belongs
// to. The broker admits a request only for the module's current
// activation.
type Owner struct {
	ModuleInstanceID string
	ActivationID     uint32
}

// Lifetime selects who owns a request (RFC 001 §2.7).
type Lifetime = wire.Lifetime

// Lifetimes a handler may choose.
const (
	LifetimeActivation = wire.LifetimeActivation
	LifetimeBackground = wire.LifetimeBackground
)

// OpenSpec is what the handler API asks the plane to open.
type OpenSpec struct {
	Capability string
	// Version is the exact revision; 0 = the live selection's revision.
	Version uint32
	Params  json.RawMessage
	Owner   Owner
	// Lifetime "" = the revision's default.
	Lifetime Lifetime
	// Timeout 0 = the broker default; always clamped to the revision.
	Timeout time.Duration
	// InitialCredit nil = the data plane's default.
	InitialCredit   *uint64
	AllowZeroCredit bool
	// Mode "unary" | "stream" | "" (either).
	Mode string
	// Download carries file.save bytes (nil = none).
	Download []byte
	// Replayed is the replay firewall flag (RFC 001 §1.7).
	Replayed bool
	// HoldResult keeps a successful result's retained-bytes charge on the
	// connection's budget until the plane's ReleaseResult (the handler API
	// releases it when the handler scope ends): completed-but-unconsumed
	// upload bytes keep counting toward the quota while the handler still
	// holds them.
	HoldResult bool
}

// Outcome is a request's terminal outcome as the plane reports it.
type Outcome struct {
	OK        bool
	Result    json.RawMessage
	Blobs     []Blob
	Simulated bool
	// Held: the result's retained-bytes charge stays reserved until
	// Plane.ReleaseResult (only for specs opened with HoldResult).
	Held   bool
	Code   Code
	Detail string
}

// Sink receives one request's traffic from the plane, in order: events or
// data chunks, then exactly one settlement. Implementations never block.
type Sink interface {
	Event(event json.RawMessage)
	Data(channel uint16, chunk []byte)
	Settled(outcome Outcome)
}

// Waiter is the session's dispatch slot as a waiting handler sees it:
// BeginWait yields the slot, EndWait takes it back (blocking until free).
type Waiter interface {
	BeginWait()
	EndWait()
}

// Dispatch is the provenance of the dispatch currently running on a plane.
type Dispatch struct {
	// Replayed is true for replayed, broadcast-derived or agent-originated
	// dispatches: they can never acquire device authority.
	Replayed bool
	// Waiter is the dispatch's slot (nil outside a dispatch).
	Waiter Waiter
}

// Plane is one connection's device plane as the handler API sees it. The
// remote server implements it on top of the Rust broker.
type Plane interface {
	// Supports reports live, negotiated support (not a permission grant).
	Supports(capability string) bool
	// SelectedVersion is the live selection's revision of capability.
	SelectedVersion(capability string) (uint32, bool)
	// Open opens a request and registers sink for its traffic before any
	// of it can be delivered. A local refusal is returned as *Error.
	Open(spec OpenSpec, sink Sink) (uint32, error)
	// Cancel is a server-initiated cancel (the request settles cancelled).
	Cancel(id uint32)
	// FileSaveParams builds the file.save@1 announcement for data (in
	// Rust: channel, name, contentType, byte count and SHA-256 — the values
	// the broker checks the download against).
	FileSaveParams(name, contentType string, data []byte) (json.RawMessage, error)
	// Consumed reports that the consumer finished events JSON events and
	// chunks data chunks of request id (credit is replenished).
	Consumed(id uint32, events, chunks int)
	// ReleaseResult releases the retained-bytes charge of a held result
	// (Outcome.Held); idempotent.
	ReleaseResult(id uint32)
	// CurrentDispatch is the provenance of the dispatch running now.
	CurrentDispatch() Dispatch
	// OwnerActivated / OwnerDeactivated / OwnerDestroyed tie activation
	// authority to the module lifecycle.
	OwnerActivated(moduleInstanceID string, activationID uint32)
	OwnerDeactivated(moduleInstanceID string, activationID uint32)
	OwnerDestroyed(moduleInstanceID string)
}

// Device is a handler's scoped view of the connection's device plane. The
// zero value and a nil *Device behave like an unavailable plane.
type Device struct {
	plane    Plane
	owner    Owner
	dispatch Dispatch
	detail   string
	// scope is the handler invocation this Device was handed to (nil for
	// an unscoped Device, e.g. one taken from a lifecycle callback).
	scope *scope
}

// scope is one handler invocation: the retained-bytes charges of results
// the handler received are released when it ends.
type scope struct {
	mu       sync.Mutex
	open     bool
	releases []func()
}

// defer_ queues release for the end of the scope; false when the scope has
// already ended (the caller releases at once).
func (s *scope) defer_(release func()) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.open {
		return false
	}
	s.releases = append(s.releases, release)
	return true
}

func (s *scope) end() {
	s.mu.Lock()
	releases := s.releases
	s.releases, s.open = nil, false
	s.mu.Unlock()
	for _, release := range releases {
		release()
	}
}

// Scoped returns a copy of d tied to a new handler scope, and the function
// that ends it. Hosts hand the copy to one handler invocation and call end
// when the handler returns: the uploaded bytes of every result it received
// keep counting toward the connection's retained-bytes budget until then
// (the handler still holds them), and are released by end. Results that
// arrive after end (a goroutine outliving the handler) are released as
// soon as they are delivered. end is idempotent.
func (d *Device) Scoped() (*Device, func()) {
	if !d.Enabled() {
		return d, func() {}
	}
	c := *d
	c.scope = &scope{open: true}
	var once sync.Once
	return &c, func() { once.Do(c.scope.end) }
}

// Bind scopes plane to owner and to the dispatch running now. A nil plane
// gives an unavailable Device ("device-disabled").
func Bind(plane Plane, owner Owner) *Device {
	if plane == nil {
		return Unavailable("device-disabled")
	}
	return &Device{plane: plane, owner: owner, dispatch: plane.CurrentDispatch()}
}

// Unavailable is a Device every call of which fails unavailable with
// detail (and whose Supports is false).
func Unavailable(detail string) *Device {
	return &Device{detail: detail}
}

// Enabled reports whether a device plane backs this Device.
func (d *Device) Enabled() bool { return d != nil && d.plane != nil }

// Owner is the module instance and activation this Device acts for.
func (d *Device) Owner() Owner {
	if d == nil {
		return Owner{}
	}
	return d.owner
}

// Replayed reports whether this Device belongs to a replayed or
// agent-originated dispatch (every open fails unavailable).
func (d *Device) Replayed() bool { return d != nil && d.dispatch.Replayed }

// Supports reports negotiated, live support for capability — not a
// permission grant.
func (d *Device) Supports(capability string) bool {
	return d.Enabled() && d.plane.Supports(capability)
}

// Version is the live selection's revision of capability.
func (d *Device) Version(capability string) (uint32, bool) {
	if !d.Enabled() {
		return 0, false
	}
	return d.plane.SelectedVersion(capability)
}

func (d *Device) unavailable() error {
	detail := "device-disabled"
	if d != nil && d.detail != "" {
		detail = d.detail
	}
	return &Error{Code: CodeUnavailable, Detail: detail}
}

// marshalParams turns caller params into JSON: nil = {}, json.RawMessage
// and []byte pass through, anything else goes through encoding/json. The
// broker validates the result at open; nothing is validated here.
func marshalParams(params any) (json.RawMessage, error) {
	switch p := params.(type) {
	case nil:
		return json.RawMessage(`{}`), nil
	case json.RawMessage:
		return p, nil
	case []byte:
		return json.RawMessage(p), nil
	}
	b, err := json.Marshal(params)
	if err != nil {
		return nil, &Error{Code: CodeInvalidParams, Detail: fmt.Sprintf("params: %v", err)}
	}
	return b, nil
}
