package compatibility

import (
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"

	core "github.com/hypen-lang/hypen/hypen-golang"
)

// Real-engine runner for render-category fixtures (rendering,
// reconciliation, control-flow): drives the WASI engine the Go SDK embeds
// (hypen_engine.wasm via wazero), matches each step's patches against the
// fixture id-agnostically (the same rules as the Rust runner), and applies
// every batch to a renderer model (screen) that enforces the patch
// protocol — including clearChildren (hypen-web/docs/clear-children.md).

type engineFixture struct {
	Name  string `json:"name"`
	Input struct {
		Source       string         `json:"source"`
		InitialState map[string]any `json:"initialState"`
		Module       *ModuleConfig  `json:"module"`
	} `json:"input"`
	Expected *engineExpect `json:"expected"`
	Steps    []engineStep  `json:"steps"`
}

type engineExpect struct {
	Patches          []map[string]any `json:"patches"`
	PatchCount       *int             `json:"patchCount"`
	PatchTypes       []string         `json:"patchTypes"`
	StrictPatchOrder bool             `json:"strictPatchOrder"`
}

type engineStep struct {
	Description string `json:"description"`
	Action      string `json:"action"`
	Source      string `json:"source"`
	StateChange *struct {
		NewValues map[string]any `json:"newValues"`
	} `json:"stateChange"`
	Viewport *struct {
		ElementType string `json:"elementType"`
		Start       uint32 `json:"start"`
		End         uint32 `json:"end"`
	} `json:"viewport"`
	Animation           any              `json:"animation"`
	ExpectedPatches     []map[string]any `json:"expectedPatches"`
	ExpectedPatchCount  *int             `json:"expectedPatchCount"`
	ExpectedPatchTypes  []string         `json:"expectedPatchTypes"`
	StrictPatchOrder    bool             `json:"strictPatchOrder"`
	ForbiddenPatchTypes []string         `json:"forbiddenPatchTypes"`
	ForbiddenPatches    []map[string]any `json:"forbiddenPatches"`
}

// runEngineFixture replays one render-category fixture on the real engine.
func runEngineFixture(t *testing.T, path string) {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var fx engineFixture
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), `"semantics"`) {
		// core.Patch has no Semantics field, so the Go SDK drops the
		// semantics block of create/setSemantics patches on decode.
		t.Skip("the Go SDK's core.Patch does not carry accessibility semantics yet")
	}
	for _, step := range fx.Steps {
		switch step.Action {
		case "initialRender", "updateState", "setViewport":
		default:
			t.Skipf("step action %q is not driven by the Go real-engine runner yet", step.Action)
		}
		if step.Animation != nil {
			t.Skip("batch-animation contexts are not exposed by the Go engine binding")
		}
	}

	engine, err := core.NewDefaultEngine()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { engine.Close() })
	if err := engine.RegisterDefaultPrimitives(); err != nil {
		t.Fatal(err)
	}
	name, actions, keys := "TestModule", []string{}, []string{}
	if m := fx.Input.Module; m != nil {
		name = m.Name
		if m.Actions != nil {
			actions = m.Actions
		}
		if m.StateKeys != nil {
			keys = m.StateKeys
		}
	}
	initial := fx.Input.InitialState
	if initial == nil {
		initial = map[string]any{}
	}
	engine.SetModule(name, actions, keys, initial)

	scr := newScreen()
	if len(fx.Steps) == 0 {
		patches, err := engine.RenderSource(fx.Input.Source)
		if err != nil {
			t.Fatal(err)
		}
		actual := toWire(t, patches)
		scr.apply(t, "initial render", actual)
		if e := fx.Expected; e != nil {
			assertEngineStep(t, "initial render", actual, scr, engineStep{
				ExpectedPatches:    e.Patches,
				ExpectedPatchCount: e.PatchCount,
				ExpectedPatchTypes: e.PatchTypes,
				StrictPatchOrder:   e.StrictPatchOrder,
			})
		}
		return
	}

	firstOfType := map[string]string{}
	for i, step := range fx.Steps {
		label := step.Description
		if label == "" {
			label = fmt.Sprintf("step %d", i)
		}
		var patches []core.Patch
		switch step.Action {
		case "initialRender":
			patches, err = engine.RenderSource(fx.Input.Source)
		case "updateState":
			if step.StateChange == nil {
				t.Fatalf("%s: updateState without stateChange", label)
			}
			patches, err = engine.UpdateState(step.StateChange.NewValues)
		case "setViewport":
			id, ok := firstOfType[step.Viewport.ElementType]
			if !ok {
				t.Fatalf("%s: no %s created yet", label, step.Viewport.ElementType)
			}
			patches, err = engine.SetListViewport(id, step.Viewport.Start, step.Viewport.End)
		}
		if err != nil {
			t.Fatalf("%s: %v", label, err)
		}
		actual := toWire(t, patches)
		for _, p := range actual {
			if p["type"] == "create" {
				et, _ := p["elementType"].(string)
				if _, seen := firstOfType[et]; !seen {
					firstOfType[et] = p["id"].(string)
				}
			}
		}
		scr.apply(t, label, actual)
		assertEngineStep(t, label, actual, scr, step)
	}
}

// toWire re-reads the engine's patches as the JSON a remote client sees.
func toWire(t *testing.T, patches []core.Patch) []map[string]any {
	t.Helper()
	raw, err := json.Marshal(patches)
	if err != nil {
		t.Fatal(err)
	}
	var out []map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func assertEngineStep(t *testing.T, label string, actual []map[string]any, scr *screen, step engineStep) {
	t.Helper()
	dump := func() string { b, _ := json.Marshal(actual); return string(b) }
	if step.ExpectedPatchCount != nil && len(actual) != *step.ExpectedPatchCount {
		t.Errorf("%s: patch count %d, want %d: %s", label, len(actual), *step.ExpectedPatchCount, dump())
	}
	if step.ExpectedPatchTypes != nil {
		got := make([]string, len(actual))
		for i, p := range actual {
			got[i], _ = p["type"].(string)
		}
		if !reflect.DeepEqual(got, step.ExpectedPatchTypes) {
			t.Errorf("%s: patch types %v, want %v", label, got, step.ExpectedPatchTypes)
		}
	}
	if step.ExpectedPatches != nil {
		if step.StrictPatchOrder {
			ok := len(actual) == len(step.ExpectedPatches)
			for i := 0; ok && i < len(actual); i++ {
				ok = enginePatchMatches(actual[i], step.ExpectedPatches[i], scr)
			}
			if !ok {
				t.Errorf("%s: patch sequence mismatch\nactual:   %s", label, dump())
			}
		} else {
			used := make([]bool, len(actual))
			for _, want := range step.ExpectedPatches {
				found := false
				for i, p := range actual {
					if !used[i] && enginePatchMatches(p, want, scr) {
						used[i], found = true, true
						break
					}
				}
				if !found {
					t.Errorf("%s: no patch matches %v\nactual: %s", label, want, dump())
				}
			}
		}
	}
	for _, kind := range step.ForbiddenPatchTypes {
		for _, p := range actual {
			if p["type"] == kind {
				t.Errorf("%s: forbidden %s patch: %v", label, kind, p)
			}
		}
	}
	for _, f := range step.ForbiddenPatches {
		for _, p := range actual {
			if enginePatchMatches(p, f, scr) {
				t.Errorf("%s: forbidden patch %v matched %v", label, f, p)
			}
		}
	}
}

// enginePatchMatches is the id-agnostic structural match shared with the
// Rust runner: every field the fixture names must match; `before` /
// `target` are resolved through the elements created so far.
func enginePatchMatches(actual, want map[string]any, scr *screen) bool {
	for _, key := range []string{"type", "elementType", "name"} {
		if w, ok := want[key]; ok && actual[key] != w {
			return false
		}
	}
	if w, ok := want["value"]; ok && w != nil {
		if !jsonEqual(actual["value"], w) {
			return false
		}
	}
	if isNull, _ := want["valueIsNull"].(bool); isNull {
		if v, present := actual["value"]; !present || v != nil {
			return false
		}
	}
	props, _ := actual["props"].(map[string]any)
	if wp, ok := want["props"].(map[string]any); ok {
		for k, w := range wp {
			got, present := props[k]
			if !present || !jsonEqual(got, w) {
				return false
			}
		}
	}
	if absent, ok := want["absentProps"].([]any); ok {
		for _, k := range absent {
			if _, present := props[k.(string)]; present {
				return false
			}
		}
	}
	if w, ok := want["transition"].(bool); ok {
		got, _ := actual["transition"].(bool)
		if got != w {
			return false
		}
	}
	for _, key := range []string{"spec", "semantics"} {
		if w, ok := want[key]; ok && !jsonEqual(actual[key], w) {
			return false
		}
	}
	if anchor, ok := want["before"].(map[string]any); ok && !scr.createdMatches(actual["beforeId"], anchor) {
		return false
	}
	if anchor, ok := want["target"].(map[string]any); ok && !scr.createdMatches(actual["id"], anchor) {
		return false
	}
	return true
}

// screen is a renderer model: it applies every patch the way a renderer
// must, and fails the test on protocol violations a renderer would trip
// over (a patch naming a node already torn down, a clearChildren the
// engine promised never to send, a cleared element filled before its
// clear).
type screen struct {
	created  map[string]map[string]any // create patch by id, for anchors
	live     map[string]bool
	dead     map[string]bool
	children map[string][]string
	parent   map[string]string
}

func newScreen() *screen {
	return &screen{
		created:  map[string]map[string]any{},
		live:     map[string]bool{"root": true},
		dead:     map[string]bool{},
		children: map[string][]string{},
		parent:   map[string]string{},
	}
}

func (s *screen) createdMatches(id any, anchor map[string]any) bool {
	sid, _ := id.(string)
	c, ok := s.created[sid]
	if !ok {
		return false
	}
	if et, ok := anchor["elementType"]; ok && c["elementType"] != et {
		return false
	}
	props, _ := c["props"].(map[string]any)
	if wp, ok := anchor["props"].(map[string]any); ok {
		for k, w := range wp {
			if got, present := props[k]; !present || !jsonEqual(got, w) {
				return false
			}
		}
	}
	return true
}

func (s *screen) apply(t *testing.T, label string, batch []map[string]any) {
	t.Helper()
	filledThisBatch := map[string]bool{} // parents that gained a child in this batch
	for _, p := range batch {
		kind, _ := p["type"].(string)
		id, _ := p["id"].(string)
		parentID, _ := p["parentId"].(string)
		for _, ref := range []string{id, parentID} {
			if ref != "" && s.dead[ref] {
				t.Errorf("%s: %s names %s, already torn down by an earlier remove/clearChildren", label, kind, ref)
			}
		}
		switch kind {
		case "create":
			s.created[id] = p
			s.live[id] = true
			delete(s.dead, id)
		case "insert", "move", "attach":
			s.link(parentID, id, p["beforeId"])
			filledThisBatch[parentID] = true
		case "detach":
			s.unlink(id)
		case "remove":
			s.unlink(id)
			s.kill(id)
		case "clearChildren":
			switch {
			case id == "root":
				t.Errorf("%s: clearChildren on root", label)
			case !s.live[id]:
				t.Errorf("%s: clearChildren names unknown element %s", label, id)
			case len(s.children[id]) < 2:
				t.Errorf("%s: clearChildren on %s with %d children (a single leaving child must be a plain remove)", label, id, len(s.children[id]))
			case filledThisBatch[id]:
				t.Errorf("%s: clearChildren on %s after children were added to it in the same batch", label, id)
			}
			kids := s.children[id]
			delete(s.children, id)
			for _, k := range kids {
				delete(s.parent, k)
				s.kill(k)
			}
		}
	}
}

func (s *screen) link(parentID, id string, before any) {
	s.unlink(id)
	kids := s.children[parentID]
	at := len(kids)
	if b, _ := before.(string); b != "" {
		for i, k := range kids {
			if k == b {
				at = i
				break
			}
		}
	}
	kids = append(kids, "")
	copy(kids[at+1:], kids[at:])
	kids[at] = id
	s.children[parentID] = kids
	s.parent[id] = parentID
}

func (s *screen) unlink(id string) {
	p, ok := s.parent[id]
	if !ok {
		return
	}
	delete(s.parent, id)
	kids := s.children[p]
	for i, k := range kids {
		if k == id {
			s.children[p] = append(kids[:i:i], kids[i+1:]...)
			return
		}
	}
}

// kill tears down id and its whole subtree.
func (s *screen) kill(id string) {
	for _, k := range s.children[id] {
		delete(s.parent, k)
		s.kill(k)
	}
	delete(s.children, id)
	delete(s.live, id)
	s.dead[id] = true
}
