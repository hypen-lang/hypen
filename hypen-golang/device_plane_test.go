package core

// Device plane (RFC 001) plumbing in the core module system: handler
// contexts expose Device(), module instances tie activation authority to
// their lifecycle, the ManagedRouter binds routed modules, and the session
// manager issues resume credentials.

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/hypen-space/core/device"
)

// recordingPlane is a device.Plane that records owner lifecycle calls and
// the owners/specs of opened requests.
type recordingPlane struct {
	mu     sync.Mutex
	events []string
	specs  []device.OpenSpec
	// held settles every request with a held result charge.
	held bool
}

func (p *recordingPlane) log(s string) {
	p.mu.Lock()
	p.events = append(p.events, s)
	p.mu.Unlock()
}
func (p *recordingPlane) Supports(string) bool                  { return true }
func (p *recordingPlane) SelectedVersion(string) (uint32, bool) { return 1, true }
func (p *recordingPlane) Cancel(uint32)                         {}
func (p *recordingPlane) Consumed(uint32, int, int)             {}
func (p *recordingPlane) ReleaseResult(id uint32)               { p.log("release " + itoa(id)) }
func (p *recordingPlane) CurrentDispatch() device.Dispatch      { return device.Dispatch{} }
func (p *recordingPlane) OwnerActivated(id string, a uint32) {
	p.log("activated " + id + " " + itoa(a))
}
func (p *recordingPlane) OwnerDeactivated(id string, a uint32) {
	p.log("deactivated " + id + " " + itoa(a))
}
func (p *recordingPlane) OwnerDestroyed(id string) { p.log("destroyed " + id) }
func (p *recordingPlane) FileSaveParams(name, ct string, data []byte) (json.RawMessage, error) {
	return json.Marshal(map[string]any{"channel": 0, "name": name, "contentType": ct, "bytes": len(data)})
}
func (p *recordingPlane) Open(s device.OpenSpec, sink device.Sink) (uint32, error) {
	p.mu.Lock()
	p.specs = append(p.specs, s)
	p.mu.Unlock()
	sink.Settled(device.Outcome{OK: true, Held: p.held, Result: json.RawMessage(`{"status":"granted"}`)})
	return uint32(len(p.specs)), nil
}

func itoa(v uint32) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func TestHandlerContextsAlwaysHaveADevice(t *testing.T) {
	var ctx ActionHandlerContext
	d := ctx.Device()
	if d == nil || d.Enabled() || d.Supports("gallery.pick") {
		t.Fatal("zero context must expose an unavailable device")
	}
	if _, err := d.Request(context.Background(), "permission.query", nil); device.CodeOf(err) != device.CodeUnavailable {
		t.Fatalf("err = %v", err)
	}
	var typed TypedActionContext[struct{}]
	if typed.Device() == nil || typed.Device().Enabled() {
		t.Fatal("typed zero context must expose an unavailable device")
	}
	plane := &recordingPlane{}
	bound := device.Bind(plane, device.Owner{ModuleInstanceID: "x", ActivationID: 1})
	if got := ctx.WithDevice(bound).Device(); got != bound {
		t.Fatal("WithDevice not carried")
	}
}

type devModState struct {
	Status string `json:"status"`
}

func TestModuleInstanceDrivesActivationAuthority(t *testing.T) {
	plane := &recordingPlane{}
	engine := NewMockEngine()
	var owners []device.Owner
	def := NewApp(devModState{}).Name("Scanner").
		OnAction("go", func(ctx TypedActionContext[devModState]) {
			owners = append(owners, ctx.Device().Owner())
			st, err := ctx.Device().Permissions().Query(context.Background(), device.PermissionBluetooth)
			if err != nil {
				t.Errorf("query: %v", err)
			}
			ctx.State.Status = string(st)
		}).Build()
	m := NewModuleInstance(engine, def, AsNested(), WithDevicePlane(plane))
	id := m.DeviceOwner().ModuleInstanceID
	if !strings.HasPrefix(id, "scanner#") || m.DeviceOwner().ActivationID != 0 {
		t.Fatalf("identity = %+v", m.DeviceOwner())
	}
	m.Activate()
	_ = engine.DispatchAction("go", nil)
	m.Deactivate()
	m.Activate()
	_ = engine.DispatchAction("go", nil)
	m.Destroy()

	want := []string{
		"activated " + id + " 1",
		"deactivated " + id + " 1",
		"activated " + id + " 2",
		"deactivated " + id + " 2",
		"destroyed " + id,
	}
	if strings.Join(plane.events, "|") != strings.Join(want, "|") {
		t.Fatalf("lifecycle = %v\nwant %v", plane.events, want)
	}
	if len(owners) != 2 || owners[0].ActivationID != 1 || owners[1].ActivationID != 2 || owners[0].ModuleInstanceID != id {
		t.Fatalf("handler owners = %+v", owners)
	}
	if len(plane.specs) != 2 || plane.specs[1].Owner.ActivationID != 2 {
		t.Fatalf("specs = %+v", plane.specs)
	}
	if m.GetState()["status"] != "granted" {
		t.Fatalf("state = %v", m.GetState())
	}
	// Two instances of one definition never share an identity.
	other := NewModuleInstance(NewMockEngine(), def, AsNested(), WithDevicePlane(plane))
	if other.DeviceOwner().ModuleInstanceID == id {
		t.Fatal("instance ids collide")
	}
}

func TestModuleInstanceWithHostManagedOwner(t *testing.T) {
	plane := &recordingPlane{}
	owner := device.Owner{ModuleInstanceID: "app@s#1", ActivationID: 1}
	def := NewApp(devModState{}).Name("App").OnAction("go", func(ctx TypedActionContext[devModState]) {
		if ctx.Device().Owner() != owner {
			t.Errorf("owner = %+v", ctx.Device().Owner())
		}
	}).Build()
	engine := NewMockEngine()
	m := NewModuleInstance(engine, def, WithDeviceOwner(plane, owner))
	m.Activate()
	_ = engine.DispatchAction("go", nil)
	m.Destroy()
	if len(plane.events) != 0 {
		t.Fatalf("host-managed owner touched the plane: %v", plane.events)
	}
	if m.Device().Owner() != owner {
		t.Fatal("Device() owner")
	}
}

func TestModuleInstanceWithoutPlaneIsUnavailable(t *testing.T) {
	engine := NewMockEngine()
	var got error
	def := NewApp(devModState{}).Name("Plain").OnAction("go", func(ctx TypedActionContext[devModState]) {
		_, got = ctx.Device().Permissions().Query(context.Background(), device.PermissionCamera)
	}).Build()
	m := NewModuleInstance(engine, def)
	m.Activate()
	_ = engine.DispatchAction("go", nil)
	var de *device.Error
	if !errors.As(got, &de) || de.Code != device.CodeUnavailable || de.Detail != "device-disabled" {
		t.Fatalf("err = %v", got)
	}
}

func TestManagedRouterBindsRoutedModules(t *testing.T) {
	App.Clear()
	t.Cleanup(func() { App.Clear() })
	App.Register("Camera", NewApp(devModState{}).Name("Camera").Build())
	App.Register("Home", NewApp(devModState{}).Name("Home").Build())
	plane := &recordingPlane{}
	router := NewHypenRouter()
	mr := NewManagedRouter(router, NewMockEngine(), App, NewHypenGlobalContext()).SetDevicePlane(plane)
	mr.AddRoute(RouteDefinition{Path: "/", Component: "Home"})
	mr.AddRoute(RouteDefinition{Path: "/camera", Component: "Camera"})
	mr.Start()
	router.Push("/camera")
	mr.Stop()
	plane.mu.Lock()
	defer plane.mu.Unlock()
	joined := strings.Join(plane.events, "|")
	for _, want := range []string{"activated home#", "deactivated home#", "activated camera#", "deactivated camera#", "destroyed camera#"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("lifecycle %v lacks %q", plane.events, want)
		}
	}
}

// A plane that appears after an instance was built (late device hello)
// binds in place: an active instance starts an activation at once, an
// inactive one on its next Activate; a second bind, a nil plane or a
// destroyed instance change nothing.
func TestModuleInstanceBindDevicePlaneLate(t *testing.T) {
	plane := &recordingPlane{}
	engine := NewMockEngine()
	var owners []device.Owner
	def := NewApp(devModState{}).Name("Scanner").OnAction("go", func(ctx TypedActionContext[devModState]) {
		owners = append(owners, ctx.Device().Owner())
		if _, err := ctx.Device().Permissions().Query(context.Background(), device.PermissionCamera); err != nil {
			t.Errorf("query: %v", err)
		}
	}).Build()
	m := NewModuleInstance(engine, def, AsNested())
	m.Activate()
	if m.BindDevicePlane(nil) {
		t.Fatal("nil plane bound")
	}
	if !m.BindDevicePlane(plane) {
		t.Fatal("late bind refused")
	}
	if m.BindDevicePlane(&recordingPlane{}) {
		t.Fatal("second bind accepted")
	}
	id := m.DeviceOwner().ModuleInstanceID
	_ = engine.DispatchAction("go", nil)
	m.Deactivate()
	m.Activate()
	m.Destroy()
	want := []string{
		"activated " + id + " 1",
		"deactivated " + id + " 1",
		"activated " + id + " 2",
		"deactivated " + id + " 2",
		"destroyed " + id,
	}
	if strings.Join(plane.events, "|") != strings.Join(want, "|") {
		t.Fatalf("lifecycle = %v\nwant %v", plane.events, want)
	}
	if len(owners) != 1 || owners[0] != (device.Owner{ModuleInstanceID: id, ActivationID: 1}) {
		t.Fatalf("handler owners = %+v", owners)
	}
	if m.BindDevicePlane(&recordingPlane{}) {
		t.Fatal("destroyed instance bound")
	}

	// Inactive at bind time: nothing until the next Activate.
	lazy := &recordingPlane{}
	n := NewModuleInstance(NewMockEngine(), def, AsNested())
	if !n.BindDevicePlane(lazy) || len(lazy.events) != 0 {
		t.Fatalf("inactive bind touched the plane: %v", lazy.events)
	}
	n.Activate()
	if len(lazy.events) != 1 || lazy.events[0] != "activated "+n.DeviceOwner().ModuleInstanceID+" 1" {
		t.Fatalf("first activation = %v", lazy.events)
	}
}

func TestModuleInstanceBindDeviceOwnerLate(t *testing.T) {
	plane := &recordingPlane{}
	owner := device.Owner{ModuleInstanceID: "app@s#9", ActivationID: 1}
	engine := NewMockEngine()
	var got []device.Owner
	def := NewApp(devModState{}).Name("App").OnAction("go", func(ctx TypedActionContext[devModState]) {
		got = append(got, ctx.Device().Owner())
		if _, err := ctx.Device().Permissions().Query(context.Background(), device.PermissionCamera); err != nil {
			t.Errorf("query: %v", err)
		}
	}).Build()
	m := NewModuleInstance(engine, def, AsAlreadyInEngine())
	m.Activate()
	if m.BindDeviceOwner(nil, owner) {
		t.Fatal("nil plane bound")
	}
	if !m.BindDeviceOwner(plane, owner) || m.BindDeviceOwner(plane, owner) {
		t.Fatal("bind owner: want first accepted, second refused")
	}
	_ = engine.DispatchAction("go", nil)
	m.Deactivate()
	m.Destroy()
	if len(plane.events) != 0 {
		t.Fatalf("host-managed owner touched the plane: %v", plane.events)
	}
	if len(got) != 1 || got[0] != owner || m.DeviceOwner() != owner {
		t.Fatalf("owners = %+v / %+v", got, m.DeviceOwner())
	}
	if len(plane.specs) != 1 || plane.specs[0].Owner != owner {
		t.Fatalf("specs = %+v", plane.specs)
	}
}

// SetDevicePlane on a router that is already running binds the active
// routed module (a fresh activation now) and the persisted ones (on their
// next mount); modules constructed afterwards get the plane at birth.
func TestManagedRouterSetDevicePlaneAfterStart(t *testing.T) {
	App.Clear()
	t.Cleanup(func() { App.Clear() })
	App.Register("Home", NewApp(devModState{}).Name("Home").Build())
	App.Register("Camera", NewApp(devModState{}).Name("Camera").Build())
	App.Register("Map", NewApp(devModState{}).Name("Map").Build())
	plane := &recordingPlane{}
	router := NewHypenRouter()
	mr := NewManagedRouter(router, NewMockEngine(), App, NewHypenGlobalContext())
	mr.AddRoute(RouteDefinition{Path: "/", Component: "Home"})
	mr.AddRoute(RouteDefinition{Path: "/camera", Component: "Camera"})
	mr.AddRoute(RouteDefinition{Path: "/map", Component: "Map"})
	mr.Start()
	home := mr.GetActiveModule()
	router.Push("/camera") // Home persisted plane-less
	camera := mr.GetActiveModule()
	if home == nil || camera == nil || home == camera {
		t.Fatal("routes did not mount")
	}

	mr.SetDevicePlane(plane)
	cam := camera.DeviceOwner()
	if cam.ActivationID != 1 {
		t.Fatalf("active module owner after late plane = %+v", cam)
	}
	router.Push("/") // Camera persisted (deactivated), Home re-mounted
	router.Push("/map")
	mapID := mr.GetActiveModule().DeviceOwner().ModuleInstanceID
	mr.Stop()

	homeID := home.DeviceOwner().ModuleInstanceID
	plane.mu.Lock()
	defer plane.mu.Unlock()
	want := []string{
		"activated " + cam.ModuleInstanceID + " 1",
		"deactivated " + cam.ModuleInstanceID + " 1",
		"activated " + homeID + " 1",
		"deactivated " + homeID + " 1",
		"activated " + mapID + " 1",
	}
	joined := strings.Join(plane.events, "|")
	if !strings.HasPrefix(joined, strings.Join(want, "|")) {
		t.Fatalf("lifecycle = %v\nwant prefix %v", plane.events, want)
	}
	if !strings.HasPrefix(mapID, "map#") {
		t.Fatalf("map id = %q", mapID)
	}
}

func TestSessionManagerResumeTokens(t *testing.T) {
	sm := NewSessionManager(nil)
	s := sm.CreateSession(nil)
	if sm.VerifyResumeToken(s.ID(), "") || sm.VerifyResumeToken(s.ID(), "x") {
		t.Fatal("verified without an issued token")
	}
	tok, err := sm.IssueResumeToken(s.ID())
	if err != nil || len(tok) < 43 { // 256 bits base64url
		t.Fatalf("token %q %v", tok, err)
	}
	if !sm.VerifyResumeToken(s.ID(), tok) || sm.VerifyResumeToken("other", tok) || sm.VerifyResumeToken(s.ID(), tok[:len(tok)-1]) {
		t.Fatal("verification")
	}
	tok2, _ := sm.IssueResumeToken(s.ID())
	if tok2 == tok || sm.VerifyResumeToken(s.ID(), tok) || !sm.VerifyResumeToken(s.ID(), tok2) {
		t.Fatal("issuing did not rotate the token")
	}
	sm.DestroySession(s.ID())
	if sm.VerifyResumeToken(s.ID(), tok2) {
		t.Fatal("token outlived its session")
	}
	if sm.Config().Concurrent != ConcurrentKickOld {
		t.Fatal("Config()")
	}
}

// Only a session that negotiated a device plane requires its resume token;
// the mark is sticky for the session's life and dropped with it.
func TestSessionManagerDeviceSessionsRequireTheToken(t *testing.T) {
	sm := NewSessionManager(nil)
	ui := sm.CreateSession(nil)
	dev := sm.CreateSession(nil)
	sm.MarkDeviceSession(dev.ID())
	if sm.RequiresResumeToken(ui.ID()) {
		t.Fatal("UI-only session requires a token")
	}
	if !sm.RequiresResumeToken(dev.ID()) {
		t.Fatal("device session does not require a token")
	}
	sm.DestroySession(dev.ID())
	if sm.RequiresResumeToken(dev.ID()) {
		t.Fatal("mark outlived its session")
	}
}

func TestEngineWASMIsTheEmbeddedModule(t *testing.T) {
	b := EngineWASM()
	if len(b) < 8 || string(b[:4]) != "\x00asm" {
		t.Fatal("EngineWASM is not a wasm module")
	}
	if SharedCompilationCache() != SharedCompilationCache() {
		t.Fatal("compilation cache is not shared")
	}
}

// A module instance's handler invocation is a device scope: a held result
// the handler received keeps its retained-bytes charge until the handler
// returns, then it is released exactly once.
func TestModuleInstanceHandlerScopeReleasesHeldResults(t *testing.T) {
	plane := &recordingPlane{held: true}
	engine := NewMockEngine()
	def := NewApp(devModState{}).Name("Picker").
		OnAction("go", func(ctx TypedActionContext[devModState]) {
			if _, err := ctx.Device().Permissions().Query(context.Background(), device.PermissionCamera); err != nil {
				t.Errorf("query: %v", err)
			}
			if !plane.specs[len(plane.specs)-1].HoldResult {
				t.Error("unary request opened without HoldResult")
			}
			plane.log("handler returns")
		}).Build()
	m := NewModuleInstance(engine, def, AsNested(), WithDevicePlane(plane))
	m.Activate()
	_ = engine.DispatchAction("go", nil)
	var tail []string
	for _, e := range plane.events {
		if e == "handler returns" || strings.HasPrefix(e, "release ") {
			tail = append(tail, e)
		}
	}
	if strings.Join(tail, "|") != "handler returns|release 1" {
		t.Fatalf("events = %v, want the release after the handler returned", plane.events)
	}
}
