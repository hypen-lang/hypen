package remote

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	core "github.com/hypen-space/core"
	"github.com/hypen-space/core/device"
)

// deviceHost is implemented by SessionHosts that carry a device plane
// (RemoteServer: on by default; deviceSettings returns nil when it is
// off). Optional, so other SessionHost implementations keep compiling and
// stay UI-only.
type deviceHost interface {
	deviceSettings() *deviceSettings
}

// sessionOwnerSeq numbers the device identities the session assigns to the
// modules it runs handlers for.
var sessionOwnerSeq atomic.Uint64

// ReceiveBinary feeds a client → server binary device frame (RFC 001
// §2.3). Transport adapters call it for binary WebSocket messages; without
// a device plane the frame is dropped (no storage is allocated).
func (s *RemoteSession) ReceiveBinary(frame []byte) {
	s.mu.Lock()
	dev := s.dev
	destroyed := s.destroyed
	s.mu.Unlock()
	if destroyed || dev == nil {
		return
	}
	dev.onFrame(frame)
}

// DeviceEnabled reports whether this connection negotiated a live device
// plane.
func (s *RemoteSession) DeviceEnabled() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.dev != nil && !s.dev.isClosed()
}

// ResumeToken is the resume credential this connection's sessionAck
// carried ("" when the host's device plane is off).
func (s *RemoteSession) ResumeToken() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.resumeToken
}

// DeviceOwner returns the device identity (moduleInstanceId, activation)
// the session uses for module (lowercase name; "" = the primary module).
func (s *RemoteSession) DeviceOwner(module string) (device.Owner, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	o, ok := s.owners[strings.ToLower(module)]
	return o, ok
}

// deviceInfo is the broker snapshot of this connection (tests).
func (s *RemoteSession) deviceInfo() (map[string]any, error) {
	s.mu.Lock()
	dev := s.dev
	s.mu.Unlock()
	if dev == nil {
		return nil, fmt.Errorf("no device plane")
	}
	return dev.info()
}

// deviceAdmitted is the device plane's security admission (RFC 001 §5):
// the host's plane is on, the connection's upgrade was admitted (when
// connection admission is configured, recorded by CreateSession), the
// transport has a device route, and connections do not share a session
// under allow-multiple (which would fan one session's work out across
// sockets).
func (s *RemoteSession) deviceAdmitted() (DeviceTransport, bool) {
	if s.deviceCfg == nil || !s.upgradeAdmitted {
		return nil, false
	}
	tr, ok := s.transport.(DeviceTransport)
	if !ok {
		return nil, false
	}
	if sm := s.host.SessionManager(); sm != nil && sm.Config().Concurrent == core.ConcurrentAllowMultiple {
		logServer.Debug("Session %s: device plane refused — allow-multiple is on", s.ID)
		return nil, false
	}
	return tr, true
}

// helloDevice extracts hello.device as raw JSON, or nil when absent,
// duplicated (ambiguous) or not admitted here. Untrusted: it is strictly
// decoded by the broker's selection.
func (s *RemoteSession) helloDevice(hello []byte, member json.RawMessage) json.RawMessage {
	if len(member) == 0 {
		return nil
	}
	if _, ok := s.deviceAdmitted(); !ok {
		return nil
	}
	if topLevelMemberCount(hello, "device") != 1 {
		logServer.Warn("Session %s: hello.device repeated — device plane disabled", s.ID)
		return nil
	}
	return member
}

// selectDevice runs the broker-backed server's handshake selection
// (`select_device_ack` in Rust). nil = device plane disabled.
func (s *RemoteSession) selectDevice(hello json.RawMessage) json.RawMessage {
	if hello == nil {
		return nil
	}
	if _, ok := s.deviceAdmitted(); !ok {
		return nil
	}
	rt, err := helperRuntime()
	if err != nil {
		logServer.Error("Session %s: device broker runtime unavailable: %v", s.ID, err)
		return nil
	}
	ack, err := rt.Negotiate(hello, true)
	if err != nil {
		logServer.Warn("Session %s: device selection failed — device plane disabled: %v", s.ID, err)
		return nil
	}
	if ack == nil {
		logServer.Info("Session %s: invalid or disjoint hello.device — device plane disabled", s.ID)
	}
	return ack
}

// attachDevice creates the connection's broker for ack, opens
// core.capabilities and activates the session's own module owners.
func (s *RemoteSession) attachDevice(ack json.RawMessage) {
	tr, ok := s.deviceAdmitted()
	if !ok {
		return
	}
	module, err := sharedBrokerModule()
	if err != nil {
		logServer.Error("Session %s: device broker module unavailable: %v", s.ID, err)
		return
	}
	cfg, err := s.deviceCfg.brokerConfig(ack)
	if err != nil {
		logServer.Error("Session %s: device broker config: %v", s.ID, err)
		return
	}
	// The connection's own engine-module instance: a trap there resets
	// this connection's device plane only.
	dev, err := newSessionDevice(s, module, s.deviceCfg.agg, tr, cfg)
	if err != nil {
		logServer.Error("Session %s: device broker: %v", s.ID, err)
		return
	}
	// Dispatches run off the reader from now on, so handlers can block on
	// device calls.
	s.installQueue()
	s.mu.Lock()
	if s.destroyed || s.dev != nil {
		s.mu.Unlock()
		dev.close()
		return
	}
	s.dev = dev
	s.mu.Unlock()

	if err := dev.startPlane(); err != nil {
		logServer.Warn("Session %s: core.capabilities not opened (%v) — device plane closed", s.ID, err)
		s.mu.Lock()
		s.dev = nil
		s.mu.Unlock()
		dev.close()
		return
	}

	// The session runs handlers for the primary module and every
	// registered nested module itself: each gets a device identity whose
	// single activation lasts as long as the connection.
	owners := map[string]device.Owner{"": s.newOwner(s.host.ModuleName())}
	primary := strings.ToLower(s.host.ModuleName())
	for _, name := range core.App.GetNames() {
		if strings.EqualFold(name, primary) {
			continue
		}
		owners[strings.ToLower(name)] = s.newOwner(name)
	}
	s.mu.Lock()
	s.owners = owners
	s.mu.Unlock()
	for _, o := range owners {
		dev.OwnerActivated(o.ModuleInstanceID, o.ActivationID)
	}
	s.bindAutoWiredDevice()
	logServer.Info("Session %s: device plane enabled", s.ID)
}

// bindAutoWiredDevice binds a plane that appeared after the Router
// auto-wire (a late device hello) to what the auto-wire built without
// one: the primary-module handle — whose engine handlers replaced the
// session's own — acts for the session's primary owner, and the
// ManagedRouter binds its routed instances (the active one starts an
// activation now; persisted ones on their next mount). On the normal
// path the auto-wire runs after the plane exists and binds at
// construction, so both are already bound (or absent) and this is a
// no-op.
func (s *RemoteSession) bindAutoWiredDevice() {
	plane, owner, ok := s.planeFor("")
	if !ok {
		return
	}
	s.mu.Lock()
	primary, managed := s.autoPrimary, s.autoManaged
	s.mu.Unlock()
	if primary != nil {
		primary.BindDeviceOwner(plane, owner)
	}
	if managed != nil {
		managed.SetDevicePlane(plane)
	}
}

func (s *RemoteSession) newOwner(module string) device.Owner {
	base := strings.ToLower(module)
	if base == "" {
		base = "app"
	}
	if len(base) > 200 {
		base = base[:200]
	}
	return device.Owner{
		ModuleInstanceID: fmt.Sprintf("%s@%s#%d", base, s.ID, sessionOwnerSeq.Add(1)),
		ActivationID:     1,
	}
}

// lateHelloWait bounds how long a late hello waits for the grace
// initialisation to finish.
const lateHelloWait = 30 * time.Second

// lateDeviceHello handles a hello on a session the grace timer already
// initialised (a slow client): negotiate and re-ack without
// reinitialising app state (RFC 001 §2.2).
//
// It first waits for the grace initialisation to finish (Ready): the
// re-ack must follow the first ack and initialTree, and the plane must
// be attached after the Router auto-wire so attachDevice can bind what
// the auto-wire built. The grace init runs on its timer goroutine and
// never waits on this reader, so the wait cannot deadlock; teardown also
// closes Ready. An initialisation that aborted without closing Ready
// (its sends failed) is bounded by the handshake timeout: the hello is
// then dropped rather than stalling the reader.
func (s *RemoteSession) lateDeviceHello(hello []byte, member json.RawMessage) {
	timer := time.NewTimer(lateHelloWait)
	select {
	case <-s.readyCh:
		timer.Stop()
	case <-timer.C:
		logServer.Warn("Session %s: late hello dropped — initialisation did not complete", s.ID)
		return
	}
	s.mu.Lock()
	sid, isNew, token, has, destroyed := s.sessionID, s.ackIsNew, s.resumeToken, s.dev != nil, s.destroyed
	s.mu.Unlock()
	if has || sid == "" || destroyed {
		return
	}
	ack := s.selectDevice(s.helloDevice(hello, member))
	if ack != nil {
		if sm := s.host.SessionManager(); sm != nil {
			sm.MarkDeviceSession(sid)
		}
	}
	_ = s.Send(&SessionAckMessage{
		Type:        MessageTypeSessionAck,
		SessionID:   sid,
		IsNew:       isNew,
		IsRestored:  false,
		ResumeToken: token,
		Device:      ack,
	})
	if ack != nil {
		s.attachDevice(ack)
	}
}

// planeFor returns the live plane and the owner the session uses for
// module ("" = primary).
func (s *RemoteSession) planeFor(module string) (device.Plane, device.Owner, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.dev == nil {
		return nil, device.Owner{}, false
	}
	owner, ok := s.owners[module]
	if !ok {
		return nil, device.Owner{}, false
	}
	return s.dev, owner, true
}

// bindDevice is the Device a handler of module ("" = primary) receives.
func (s *RemoteSession) bindDevice(module string) *device.Device {
	plane, owner, ok := s.planeFor(module)
	if !ok {
		return device.Unavailable("device-disabled")
	}
	return device.Bind(plane, owner)
}

// runScoped runs one handler invocation with d scoped to it: results the
// handler receives keep their retained-bytes charge until it returns
// (even by panic), like the TypeScript handler scope.
func runScoped(d *device.Device, handler func(*device.Device)) {
	scoped, end := d.Scoped()
	defer end()
	handler(scoped)
}

func (s *RemoteSession) setCurrentDispatch(l *dispatchLease) {
	s.curMu.Lock()
	s.curDispatch = l
	s.curMu.Unlock()
}

// currentDispatch is the provenance of the dispatch holding the slot.
// Outside the slot (a lifecycle callback, a goroutine) there is no waiter
// and the provenance is the user's own connection.
func (s *RemoteSession) currentDispatch() device.Dispatch {
	s.curMu.Lock()
	l := s.curDispatch
	s.curMu.Unlock()
	if l == nil {
		return device.Dispatch{}
	}
	return device.Dispatch{Replayed: l.replayed, Waiter: l}
}

// changedRoots records the top-level state keys a handler changed, so a
// session with a device plane merges only those into the shared state: a
// handler that yielded its dispatch slot while waiting on the device must
// not overwrite what later dispatches committed meanwhile.
type changedRoots struct {
	mu    sync.Mutex
	roots map[string]struct{}
}

func newChangedRoots() *changedRoots { return &changedRoots{roots: map[string]struct{}{}} }

func (c *changedRoots) track(next func(core.StateChange)) func(core.StateChange) {
	return func(ch core.StateChange) {
		c.mu.Lock()
		for _, p := range ch.Paths {
			root := p
			if i := strings.IndexAny(p, ".["); i >= 0 {
				root = p[:i]
			}
			c.roots[root] = struct{}{}
		}
		c.mu.Unlock()
		if next != nil {
			next(ch)
		}
	}
}

// commitState folds a handler's result into base. UI-only sessions keep
// the historical full replacement; sessions with a negotiated device
// plane merge the changed roots.
func (s *RemoteSession) commitState(base map[string]any, obs *core.ObservableState, roots *changedRoots) map[string]any {
	snap := obs.Snapshot()
	if s.queue() == nil {
		return snap
	}
	out := make(map[string]any, len(base)+len(snap))
	for k, v := range base {
		out[k] = v
	}
	roots.mu.Lock()
	defer roots.mu.Unlock()
	for root := range roots.roots {
		if v, ok := snap[root]; ok {
			out[root] = v
		} else {
			delete(out, root)
		}
	}
	return out
}
