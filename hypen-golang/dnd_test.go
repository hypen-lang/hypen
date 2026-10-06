package core

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// dnd_test.go — host-side drag-and-drop tests (hypen-web/docs/dnd.md
// §4.1/§5): the pathMove mirror is pinned against the cross-SDK fixture
// engine-compatibility-tests/fixtures/dnd/path-move.json, and the reserved
// __hypen_reorder / __hypen_pin actions are exercised through a real
// ModuleInstance so both the state result and the engine notification are
// asserted.

// ---------------------------------------------------------------------------
// Fixture-driven pathMove conformance
// ---------------------------------------------------------------------------

type pathMoveFixture struct {
	Name     string `json:"name"`
	Function string `json:"function"`
	Cases    []struct {
		Name  string          `json:"name"`
		State json.RawMessage `json:"state"`
		Op    struct {
			FromPath string `json:"fromPath"`
			From     int    `json:"from"`
			ToPath   string `json:"toPath"`
			To       int    `json:"to"`
		} `json:"op"`
		Expected json.RawMessage `json:"expected"`
		Moved    bool            `json:"moved"`
	} `json:"cases"`
}

// pathMoveFixturePath locates the shared fixture relative to this package
// directory (go test runs with cwd = the package dir), the same way
// engine-compatibility-tests/runners/golang resolves its fixtures.
func pathMoveFixturePath(t *testing.T) string {
	t.Helper()
	p, err := filepath.Abs(filepath.Join("..", "engine-compatibility-tests", "fixtures", "dnd", "path-move.json"))
	if err != nil {
		t.Fatalf("resolve fixture path: %v", err)
	}
	if _, err := os.Stat(p); err != nil {
		t.Fatalf("path-move fixture not found at %s: %v", p, err)
	}
	return p
}

func loadPathMoveFixture(t *testing.T) pathMoveFixture {
	t.Helper()
	raw, err := os.ReadFile(pathMoveFixturePath(t))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var f pathMoveFixture
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("decode fixture: %v", err)
	}
	if f.Function != "path_move" {
		t.Fatalf("unexpected fixture function %q", f.Function)
	}
	if len(f.Cases) == 0 {
		t.Fatal("fixture has no cases")
	}
	return f
}

func decodeStateJSON(t *testing.T, raw json.RawMessage) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("decode state: %v", err)
	}
	return m
}

// jsonEqual compares two values after JSON normalisation so int/float64
// and slice-type differences never produce false negatives.
func jsonEqual(a, b any) bool {
	return reflect.DeepEqual(DeepCloneAny(a), DeepCloneAny(b))
}

func TestPathMove_FixtureConformance(t *testing.T) {
	fixture := loadPathMoveFixture(t)
	for _, c := range fixture.Cases {
		c := c
		t.Run(c.Name, func(t *testing.T) {
			state := decodeStateJSON(t, c.State)
			expected := decodeStateJSON(t, c.Expected)

			moved := pathMove(state, c.Op.FromPath, c.Op.From, c.Op.ToPath, c.Op.To)
			if moved != c.Moved {
				t.Errorf("moved: got %v, want %v", moved, c.Moved)
			}
			if !jsonEqual(state, expected) {
				got, _ := json.Marshal(state)
				want, _ := json.Marshal(expected)
				t.Errorf("state mismatch\n got: %s\nwant: %s", got, want)
			}
		})
	}
}

func TestObservableState_Move_FixtureConformance(t *testing.T) {
	fixture := loadPathMoveFixture(t)
	for _, c := range fixture.Cases {
		c := c
		t.Run(c.Name, func(t *testing.T) {
			initial := decodeStateJSON(t, c.State)
			expected := decodeStateJSON(t, c.Expected)

			var changes []StateChange
			state := NewObservableState(initial, &StateObserverOptions{
				OnChange: func(change StateChange) { changes = append(changes, change) },
			})

			moved := state.Move(c.Op.FromPath, c.Op.From, c.Op.ToPath, c.Op.To)
			if moved != c.Moved {
				t.Errorf("moved: got %v, want %v", moved, c.Moved)
			}
			if got := state.Snapshot(); !jsonEqual(got, expected) {
				g, _ := json.Marshal(got)
				w, _ := json.Marshal(expected)
				t.Errorf("state mismatch\n got: %s\nwant: %s", g, w)
			}

			stateChanged := !jsonEqual(initial, expected)
			switch {
			case !stateChanged && len(changes) != 0:
				t.Errorf("state unchanged but %d change(s) were emitted: %+v", len(changes), changes)
			case stateChanged && len(changes) != 1:
				t.Fatalf("expected exactly one change notification, got %d", len(changes))
			case stateChanged:
				ch := changes[0]
				if len(ch.Paths) == 0 || len(ch.Paths) > 2 {
					t.Fatalf("expected one or two notified container paths, got %v", ch.Paths)
				}
				// Every leaf the engine's canonical diff reports must sit under
				// a notified container path — the notification must cover the
				// whole change so the engine re-renders everything affected.
				for _, leaf := range diffState(initial, expected).Paths {
					covered := false
					for _, p := range ch.Paths {
						if leaf == p || strings.HasPrefix(leaf, p+".") {
							covered = true
							break
						}
					}
					if !covered {
						t.Errorf("changed leaf %q is not covered by notified paths %v", leaf, ch.Paths)
					}
				}
				// Every notified path must carry the full new container value.
				for _, p := range ch.Paths {
					want, ok := valueAtPathLocal(expected, p)
					if !ok {
						t.Errorf("notified path %q does not resolve in expected state", p)
						continue
					}
					if !jsonEqual(ch.NewValues[p], want) {
						t.Errorf("NewValues[%q] = %v, want %v", p, ch.NewValues[p], want)
					}
				}
			}
		})
	}
}

// ---------------------------------------------------------------------------
// ObservableState.Move notification shape
// ---------------------------------------------------------------------------

func recordingState(initial map[string]any) (*ObservableState, *[]StateChange) {
	changes := &[]StateChange{}
	state := NewObservableState(initial, &StateObserverOptions{
		OnChange: func(change StateChange) { *changes = append(*changes, change) },
	})
	return state, changes
}

func TestObservableState_Move_SameArrayNotifiesOnePath(t *testing.T) {
	state, changes := recordingState(map[string]any{"tasks": []any{"a", "b", "c"}})

	if !state.Move("tasks", 0, "tasks", 2) {
		t.Fatal("expected move to succeed")
	}
	if len(*changes) != 1 {
		t.Fatalf("expected 1 change, got %d", len(*changes))
	}
	ch := (*changes)[0]
	if !reflect.DeepEqual(ch.Paths, []StatePath{"tasks"}) {
		t.Errorf("paths = %v, want [tasks]", ch.Paths)
	}
	if !jsonEqual(ch.NewValues["tasks"], []any{"b", "c", "a"}) {
		t.Errorf("NewValues[tasks] = %v", ch.NewValues["tasks"])
	}
}

func TestObservableState_Move_CrossArrayNotifiesBothPaths(t *testing.T) {
	state, changes := recordingState(map[string]any{
		"todo": []any{"a", "b"},
		"done": []any{"z"},
	})

	if !state.Move("todo", 1, "done", 0) {
		t.Fatal("expected move to succeed")
	}
	if len(*changes) != 1 {
		t.Fatalf("expected 1 change, got %d", len(*changes))
	}
	ch := (*changes)[0]
	if !reflect.DeepEqual(ch.Paths, []StatePath{"todo", "done"}) {
		t.Errorf("paths = %v, want [todo done]", ch.Paths)
	}
	if !jsonEqual(ch.NewValues["todo"], []any{"a"}) || !jsonEqual(ch.NewValues["done"], []any{"b", "z"}) {
		t.Errorf("NewValues = %v", ch.NewValues)
	}
}

func TestObservableState_Move_NestedDestinationNotifiesReaddressedPath(t *testing.T) {
	state, changes := recordingState(map[string]any{
		"entries": []any{
			map[string]any{"id": "f", "children": []any{}},
			map[string]any{"id": "a", "children": []any{"a1"}},
			map[string]any{"id": "b", "children": []any{"b1"}},
		},
	})

	if !state.Move("entries", 0, "entries.2.children", 1) {
		t.Fatal("expected move to succeed")
	}
	if len(*changes) != 1 {
		t.Fatalf("expected 1 change, got %d", len(*changes))
	}
	ch := (*changes)[0]
	// After removing entries[0] the target lives at entries.1.children.
	if !reflect.DeepEqual(ch.Paths, []StatePath{"entries", "entries.1.children"}) {
		t.Errorf("paths = %v, want [entries entries.1.children]", ch.Paths)
	}
	if !jsonEqual(ch.NewValues["entries.1.children"], []any{"b1", map[string]any{"id": "f", "children": []any{}}}) {
		t.Errorf("NewValues[entries.1.children] = %v", ch.NewValues["entries.1.children"])
	}
}

func TestObservableState_Move_SourceUnderDestinationNotifiesReaddressedSource(t *testing.T) {
	state, changes := recordingState(map[string]any{
		"entries": []any{map[string]any{"children": []any{"a1"}}, "x"},
	})

	if !state.Move("entries.0.children", 0, "entries", 0) {
		t.Fatal("expected move to succeed")
	}
	if !jsonEqual(state.Snapshot(), map[string]any{"entries": []any{"a1", map[string]any{"children": []any{}}, "x"}}) {
		t.Fatalf("state = %v", state.Snapshot())
	}
	if len(*changes) != 1 {
		t.Fatalf("expected 1 change, got %d", len(*changes))
	}
	ch := (*changes)[0]
	// Inserting at entries[0] pushed the source's parent element to index 1.
	if !reflect.DeepEqual(ch.Paths, []StatePath{"entries.1.children", "entries"}) {
		t.Errorf("paths = %v, want [entries.1.children entries]", ch.Paths)
	}
	if !jsonEqual(ch.NewValues["entries.1.children"], []any{}) {
		t.Errorf("NewValues[entries.1.children] = %v", ch.NewValues["entries.1.children"])
	}
}

// Tail-less nested cases (arrays-of-arrays): the destination or source array
// is a DIRECT element of the other array, so the re-addressed path is the
// bare index (Rust `tail: None`), never "entries.1." with a trailing dot.
func TestPathMove_DestinationIsElementOfSource(t *testing.T) {
	obj := map[string]any{"entries": []any{"x", []any{"a"}, []any{"b"}}}
	if !pathMove(obj, "entries", 0, "entries.2", 1) {
		t.Fatal("expected move into a sibling element to succeed (Rust returns true)")
	}
	if !jsonEqual(obj, map[string]any{"entries": []any{[]any{"a"}, []any{"b", "x"}}}) {
		t.Errorf("state = %v", obj)
	}
}

func TestObservableState_Move_DestinationIsElementOfSourceNotifiesReaddressedPath(t *testing.T) {
	state, changes := recordingState(map[string]any{"entries": []any{"x", []any{"a"}, []any{"b"}}})

	if !state.Move("entries", 0, "entries.2", 1) {
		t.Fatal("expected move to succeed")
	}
	if !jsonEqual(state.Snapshot(), map[string]any{"entries": []any{[]any{"a"}, []any{"b", "x"}}}) {
		t.Fatalf("state = %v", state.Snapshot())
	}
	if len(*changes) != 1 {
		t.Fatalf("expected 1 change, got %d", len(*changes))
	}
	ch := (*changes)[0]
	if !reflect.DeepEqual(ch.Paths, []StatePath{"entries", "entries.1"}) {
		t.Errorf("paths = %v, want [entries entries.1]", ch.Paths)
	}
	if !jsonEqual(ch.NewValues["entries.1"], []any{"b", "x"}) {
		t.Errorf("NewValues[entries.1] = %v", ch.NewValues["entries.1"])
	}
}

func TestObservableState_Move_SourceIsElementOfDestinationNotifiesReaddressedSource(t *testing.T) {
	state, changes := recordingState(map[string]any{"entries": []any{[]any{"a1"}, "x"}})

	if !state.Move("entries.0", 0, "entries", 0) {
		t.Fatal("expected move to succeed")
	}
	if !jsonEqual(state.Snapshot(), map[string]any{"entries": []any{"a1", []any{}, "x"}}) {
		t.Fatalf("state = %v", state.Snapshot())
	}
	if len(*changes) != 1 {
		t.Fatalf("expected 1 change, got %d", len(*changes))
	}
	ch := (*changes)[0]
	if !reflect.DeepEqual(ch.Paths, []StatePath{"entries.1", "entries"}) {
		t.Errorf("paths = %v, want [entries.1 entries]", ch.Paths)
	}
	if v, ok := ch.NewValues["entries.1"]; !ok || !jsonEqual(v, []any{}) {
		t.Errorf("NewValues[entries.1] = %v (present=%v), want []", v, ok)
	}
	for p := range ch.NewValues {
		if strings.HasSuffix(string(p), ".") {
			t.Errorf("malformed trailing-dot path notified: %q", p)
		}
	}
}

func TestObservableState_Move_NoopAndFailureNotifyNobody(t *testing.T) {
	state, changes := recordingState(map[string]any{"tasks": []any{"a", "b"}, "meta": map[string]any{"n": 1}})

	if !state.Move("tasks", 1, "tasks", 1) {
		t.Error("same-index move should report true")
	}
	if state.Move("tasks", 5, "tasks", 0) {
		t.Error("out-of-range from should report false")
	}
	if state.Move("meta", 0, "tasks", 0) {
		t.Error("non-array from should report false")
	}
	if state.Move("tasks", 0, "missing", 0) {
		t.Error("missing destination should report false")
	}
	if state.Move("tasks", -1, "tasks", 0) || state.Move("tasks", 0, "tasks", -1) {
		t.Error("negative indices should report false")
	}
	if len(*changes) != 0 {
		t.Errorf("expected no notifications, got %+v", *changes)
	}
	if !jsonEqual(state.Snapshot(), map[string]any{"tasks": []any{"a", "b"}, "meta": map[string]any{"n": 1}}) {
		t.Errorf("state must be untouched, got %v", state.Snapshot())
	}
}

func TestObservableState_Move_InsideBatchFlushesOnce(t *testing.T) {
	state, changes := recordingState(map[string]any{"tasks": []any{"a", "b", "c"}, "n": float64(0)})

	BatchStateUpdates(state, func() {
		state.Move("tasks", 0, "tasks", 2)
		state.Set("n", float64(1))
		if len(*changes) != 0 {
			t.Fatal("nothing should flush inside the batch")
		}
	})
	if len(*changes) != 1 {
		t.Fatalf("expected 1 batched change, got %d", len(*changes))
	}
	ch := (*changes)[0]
	if !reflect.DeepEqual(ch.Paths, []StatePath{"tasks", "n"}) {
		t.Errorf("paths = %v", ch.Paths)
	}
	if !jsonEqual(ch.NewValues["tasks"], []any{"b", "c", "a"}) {
		t.Errorf("NewValues[tasks] = %v", ch.NewValues["tasks"])
	}
}

// ---------------------------------------------------------------------------
// __hypen_reorder / __hypen_pin dispatch through a ModuleInstance
// ---------------------------------------------------------------------------

func newBoardInstance(t *testing.T) (*MockEngine, *ModuleInstance) {
	t.Helper()
	engine := NewMockEngine()
	def := NewAppBuilder(map[string]any{
		"tasks": []any{"a", "b", "c", "d"},
		"todo":  []any{map[string]any{"id": "t1"}, map[string]any{"id": "t2"}},
		"doing": []any{map[string]any{"id": "d1"}},
		"notes": []any{map[string]any{"id": "n1", "x": float64(0), "y": float64(0)}},
	}, &ModuleOptions{Name: "Board"}).Build()
	inst := NewModuleInstance(engine, def)
	engine.ClearStateChanges()
	return engine, inst
}

func TestReorderAction_RegisteredOnModuleInstance(t *testing.T) {
	engine, _ := newBoardInstance(t)
	for _, name := range []string{ReorderActionName, PinActionName, "__hypen_bind"} {
		if !engine.HasAction(name) {
			t.Errorf("expected %s to be auto-registered", name)
		}
	}
}

func TestReorderAction_PathShorthand(t *testing.T) {
	engine, inst := newBoardInstance(t)

	// Wire-shaped payload: JSON numbers arrive as float64.
	engine.TriggerAction(ReorderActionName, map[string]any{
		"path": "tasks", "from": float64(0), "to": float64(2),
	})

	if got := inst.GetLiveState().Get("tasks"); !jsonEqual(got, []any{"b", "c", "a", "d"}) {
		t.Errorf("tasks = %v, want [b c a d]", got)
	}
	changes := engine.GetStateChanges()
	if len(changes) != 1 {
		t.Fatalf("expected 1 engine notification, got %d: %+v", len(changes), changes)
	}
	if changes[0].Scope != "" {
		t.Errorf("primary module should notify with empty scope, got %q", changes[0].Scope)
	}
	if !reflect.DeepEqual(changes[0].Paths, []string{"tasks"}) {
		t.Errorf("paths = %v, want [tasks]", changes[0].Paths)
	}
	if !jsonEqual(changes[0].Values["tasks"], []any{"b", "c", "a", "d"}) {
		t.Errorf("notified value = %v", changes[0].Values["tasks"])
	}
}

func TestReorderAction_CrossListExplicitPaths(t *testing.T) {
	engine, inst := newBoardInstance(t)

	engine.TriggerAction(ReorderActionName, map[string]any{
		"fromPath": "todo", "from": 1, "toPath": "doing", "to": 0,
	})

	state := inst.GetLiveState()
	if !jsonEqual(state.Get("todo"), []any{map[string]any{"id": "t1"}}) {
		t.Errorf("todo = %v", state.Get("todo"))
	}
	if !jsonEqual(state.Get("doing"), []any{map[string]any{"id": "t2"}, map[string]any{"id": "d1"}}) {
		t.Errorf("doing = %v", state.Get("doing"))
	}
	changes := engine.GetStateChanges()
	if len(changes) != 1 || !reflect.DeepEqual(changes[0].Paths, []string{"todo", "doing"}) {
		t.Fatalf("expected one notification for [todo doing], got %+v", changes)
	}
}

func TestReorderAction_ExplicitPathsWinOverShorthand(t *testing.T) {
	engine, inst := newBoardInstance(t)

	engine.TriggerAction(ReorderActionName, map[string]any{
		"path": "tasks", "fromPath": "todo", "toPath": "doing", "from": 0, "to": 1,
	})

	state := inst.GetLiveState()
	if !jsonEqual(state.Get("tasks"), []any{"a", "b", "c", "d"}) {
		t.Errorf("tasks must be untouched, got %v", state.Get("tasks"))
	}
	if !jsonEqual(state.Get("doing"), []any{map[string]any{"id": "d1"}, map[string]any{"id": "t1"}}) {
		t.Errorf("doing = %v", state.Get("doing"))
	}
}

// Parity with TS app.ts / Kotlin BaseModuleInstance / Swift ModuleInstance:
// once fromPath is explicit, `path` is ignored, so a missing toPath defaults
// to fromPath (same-list move) rather than to `path` (cross-list move).
func TestReorderAction_PathIgnoredWhenFromPathExplicit(t *testing.T) {
	engine, inst := newBoardInstance(t)

	engine.TriggerAction(ReorderActionName, map[string]any{
		"fromPath": "todo", "path": "doing", "from": 0, "to": 1,
	})

	state := inst.GetLiveState()
	if !jsonEqual(state.Get("todo"), []any{map[string]any{"id": "t2"}, map[string]any{"id": "t1"}}) {
		t.Errorf("todo should be reordered in place, got %v", state.Get("todo"))
	}
	if !jsonEqual(state.Get("doing"), []any{map[string]any{"id": "d1"}}) {
		t.Errorf("doing must be untouched, got %v", state.Get("doing"))
	}
	changes := engine.GetStateChanges()
	if len(changes) != 1 || !reflect.DeepEqual(changes[0].Paths, []string{"todo"}) {
		t.Fatalf("expected one notification for [todo] only, got %+v", changes)
	}
}

func TestReorderAction_ToBeyondLengthClamps(t *testing.T) {
	engine, inst := newBoardInstance(t)
	engine.TriggerAction(ReorderActionName, map[string]any{"path": "tasks", "from": 0, "to": 99})
	if got := inst.GetLiveState().Get("tasks"); !jsonEqual(got, []any{"b", "c", "d", "a"}) {
		t.Errorf("tasks = %v, want [b c d a]", got)
	}
}

// Plan §6.11: a payload carrying only fromPath is a same-list move
// (toPath = fromPath), aligned with the TS core.
func TestReorderAction_OnlyFromPathIsSameListMove(t *testing.T) {
	engine, inst := newBoardInstance(t)
	engine.TriggerAction(ReorderActionName, map[string]any{"fromPath": "tasks", "from": 0, "to": 1})

	if got := inst.GetLiveState().Get("tasks"); !jsonEqual(got, []any{"b", "a", "c", "d"}) {
		t.Errorf("tasks = %v, want [b a c d]", got)
	}
	changes := engine.GetStateChanges()
	if len(changes) != 1 {
		t.Fatalf("expected 1 engine notification, got %d: %+v", len(changes), changes)
	}
	if !reflect.DeepEqual(changes[0].Paths, []string{"tasks"}) {
		t.Errorf("paths = %v, want [tasks]", changes[0].Paths)
	}
}

func TestReorderAction_MalformedPayloadsAreNoops(t *testing.T) {
	malformed := map[string]any{
		"non-object":        "tasks",
		"nil":               nil,
		"missing-path":      map[string]any{"from": 0, "to": 1},
		"empty-path":        map[string]any{"path": "", "from": 0, "to": 1},
		"only-toPath":       map[string]any{"toPath": "tasks", "from": 0, "to": 1},
		"missing-from":      map[string]any{"path": "tasks", "to": 1},
		"string-index":      map[string]any{"path": "tasks", "from": "0", "to": 1},
		"fractional-index":  map[string]any{"path": "tasks", "from": 0.5, "to": 1},
		"negative-index":    map[string]any{"path": "tasks", "from": -1, "to": 1},
		"from-out-of-range": map[string]any{"path": "tasks", "from": 9, "to": 1},
		"not-an-array":      map[string]any{"path": "notes.0", "from": 0, "to": 1},
		"missing-dest":      map[string]any{"fromPath": "tasks", "from": 0, "toPath": "nope", "to": 0},
		"same-index-noop":   map[string]any{"path": "tasks", "from": 2, "to": 2},
	}
	for name, payload := range malformed {
		payload := payload
		t.Run(name, func(t *testing.T) {
			engine, inst := newBoardInstance(t)
			before := inst.GetLiveState().Snapshot()

			engine.TriggerAction(ReorderActionName, payload) // must not panic

			if after := inst.GetLiveState().Snapshot(); !jsonEqual(before, after) {
				t.Errorf("state changed on malformed payload: %v -> %v", before, after)
			}
			if changes := engine.GetStateChanges(); len(changes) != 0 {
				t.Errorf("expected no engine notification, got %+v", changes)
			}
		})
	}
}

func TestReorderAction_NestedModuleNotifiesWithScope(t *testing.T) {
	engine := NewMockEngine()
	primary := NewAppBuilder(map[string]any{"count": 0}, &ModuleOptions{Name: "App"}).Build()
	NewModuleInstance(engine, primary)

	listDef := NewAppBuilder(map[string]any{"items": []any{"x", "y", "z"}}, &ModuleOptions{Name: "List"}).Build()
	list := NewModuleInstance(engine, listDef, AsNested())
	engine.ClearStateChanges()

	// The engine resolves the originating node to this module-specific handler.
	engine.TriggerAction("__hypen_scoped:list:"+ReorderActionName, map[string]any{"path": "items", "from": 2, "to": 0})

	if got := list.GetLiveState().Get("items"); !jsonEqual(got, []any{"z", "x", "y"}) {
		t.Errorf("items = %v, want [z x y]", got)
	}
	changes := engine.GetStateChanges()
	if len(changes) != 1 || changes[0].Scope != "List" {
		t.Fatalf("expected one notification scoped to List, got %+v", changes)
	}
}

func TestPinAction_ReservedPathAutoVivifiesAndBatches(t *testing.T) {
	engine, inst := newBoardInstance(t)

	engine.TriggerAction(PinActionName, map[string]any{
		"path": "__dnd.board.n1", "x": float64(120), "y": float64(80), "xKey": "x", "yKey": "y",
	})

	state := inst.GetLiveState()
	if got := state.Get("__dnd.board.n1.x"); got != float64(120) {
		t.Errorf("__dnd.board.n1.x = %v (%T), want 120", got, got)
	}
	if got := state.Get("__dnd.board.n1.y"); got != float64(80) {
		t.Errorf("__dnd.board.n1.y = %v (%T), want 80", got, got)
	}
	changes := engine.GetStateChanges()
	if len(changes) != 1 {
		t.Fatalf("expected the two sets to land in ONE notification, got %d: %+v", len(changes), changes)
	}
	if !reflect.DeepEqual(changes[0].Paths, []string{"__dnd.board.n1.x", "__dnd.board.n1.y"}) {
		t.Errorf("paths = %v", changes[0].Paths)
	}
	if changes[0].Values["__dnd.board.n1.x"] != float64(120) || changes[0].Values["__dnd.board.n1.y"] != float64(80) {
		t.Errorf("values = %v", changes[0].Values)
	}
}

func TestPinAction_UserFieldModeWithCustomKeysAndDefaults(t *testing.T) {
	engine, inst := newBoardInstance(t)

	// Custom field names (`.pinboard(x: "left", y: "top")`).
	engine.TriggerAction(PinActionName, map[string]any{
		"path": "notes.0", "x": 10, "y": 20, "xKey": "left", "yKey": "top",
	})
	note := inst.GetLiveState().Get("notes.0")
	if !jsonEqual(note, map[string]any{"id": "n1", "x": 0, "y": 0, "left": 10, "top": 20}) {
		t.Errorf("notes.0 = %v", note)
	}

	// xKey/yKey omitted ⇒ "x"/"y".
	engine.ClearStateChanges()
	engine.TriggerAction(PinActionName, map[string]any{"path": "notes.0", "x": 3.5, "y": 4})
	note = inst.GetLiveState().Get("notes.0")
	if !jsonEqual(note, map[string]any{"id": "n1", "x": 3.5, "y": 4, "left": 10, "top": 20}) {
		t.Errorf("notes.0 = %v", note)
	}
	if changes := engine.GetStateChanges(); len(changes) != 1 || !reflect.DeepEqual(changes[0].Paths, []string{"notes.0.x", "notes.0.y"}) {
		t.Errorf("expected one notification for [notes.0.x notes.0.y], got %+v", changes)
	}
}

func TestPinAction_UnchangedCoordinateIsNotRenotified(t *testing.T) {
	engine, _ := newBoardInstance(t)
	// notes.0 already has x=0; only y changes.
	engine.TriggerAction(PinActionName, map[string]any{"path": "notes.0", "x": 0, "y": 9})
	changes := engine.GetStateChanges()
	if len(changes) != 1 || !reflect.DeepEqual(changes[0].Paths, []string{"notes.0.y"}) {
		t.Errorf("expected only notes.0.y to be notified, got %+v", changes)
	}
}

func TestPinAction_MalformedPayloadsAreNoops(t *testing.T) {
	malformed := map[string]any{
		"non-object":   42,
		"missing-path": map[string]any{"x": 1, "y": 2},
		"empty-path":   map[string]any{"path": "", "x": 1, "y": 2},
		"missing-x":    map[string]any{"path": "notes.0", "y": 2},
		"string-y":     map[string]any{"path": "notes.0", "x": 1, "y": "2"},
		"nan-x":        map[string]any{"path": "notes.0", "x": nan(), "y": 2},
	}
	for name, payload := range malformed {
		payload := payload
		t.Run(name, func(t *testing.T) {
			engine, inst := newBoardInstance(t)
			before := inst.GetLiveState().Snapshot()

			engine.TriggerAction(PinActionName, payload) // must not panic

			if after := inst.GetLiveState().Snapshot(); !jsonEqual(before, after) {
				t.Errorf("state changed on malformed payload: %v -> %v", before, after)
			}
			if changes := engine.GetStateChanges(); len(changes) != 0 {
				t.Errorf("expected no engine notification, got %+v", changes)
			}
		})
	}
}

func TestPinAction_NonStringKeyFallsBackToDefault(t *testing.T) {
	engine, inst := newBoardInstance(t)
	engine.TriggerAction(PinActionName, map[string]any{"path": "notes.0", "x": 1, "y": 2, "xKey": 7, "yKey": nil})
	note := inst.GetLiveState().Get("notes.0")
	if !jsonEqual(note, map[string]any{"id": "n1", "x": 1, "y": 2}) {
		t.Errorf("notes.0 = %v", note)
	}
}

func TestApplyActions_NilStateIsSafe(t *testing.T) {
	if ApplyReorderAction(nil, map[string]any{"path": "a", "from": 0, "to": 1}) {
		t.Error("nil state must report false")
	}
	if ApplyPinAction(nil, map[string]any{"path": "a", "x": 1, "y": 1}) {
		t.Error("nil state must report false")
	}
}

func nan() float64 {
	zero := 0.0
	return zero / zero
}
