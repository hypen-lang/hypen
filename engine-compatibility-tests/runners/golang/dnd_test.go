package compatibility

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"

	core "github.com/hypen-space/core"
)

// Replay the same wire assertions as the Rust DnD fixture runner, using the
// actual WASI engine. Missing and explicit-null props are intentionally distinct.
func runDndFixture(t *testing.T, path string) {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Input struct {
			Source       string         `json:"source"`
			InitialState map[string]any `json:"initialState"`
			Module       struct {
				Name      string   `json:"name"`
				Actions   []string `json:"actions"`
				StateKeys []string `json:"stateKeys"`
			} `json:"module"`
		} `json:"input"`
		Steps    []map[string]any `json:"steps"`
		Expected map[string]any   `json:"expected"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	engine, err := core.NewDefaultEngine()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { engine.Close() })
	input := fixture.Input
	engine.SetModule(input.Module.Name, input.Module.Actions, input.Module.StateKeys, input.InitialState)
	if len(fixture.Steps) == 0 {
		patches, err := engine.RenderSource(input.Source)
		if err != nil {
			t.Fatal(err)
		}
		assertDndPatches(t, patches, fixture.Expected, true)
		return
	}
	for _, step := range fixture.Steps {
		var patches []core.Patch
		switch step["action"] {
		case "initialRender":
			patches, err = engine.RenderSource(input.Source)
		case "updateState":
			change := step["stateChange"].(map[string]any)
			patches, err = engine.UpdateState(change["newValues"].(map[string]any))
		default:
			t.Fatalf("unsupported DnD fixture action: %v", step["action"])
		}
		if err != nil {
			t.Fatal(err)
		}
		assertDndPatches(t, patches, step, false)
	}
}

func assertDndPatches(t *testing.T, patches []core.Patch, spec map[string]any, single bool) {
	t.Helper()
	raw, err := json.Marshal(patches)
	if err != nil {
		t.Fatal(err)
	}
	var actual []map[string]any
	if err := json.Unmarshal(raw, &actual); err != nil {
		t.Fatal(err)
	}
	countKey, typesKey, patchesKey := "expectedPatchCount", "expectedPatchTypes", "expectedPatches"
	if single {
		countKey, typesKey, patchesKey = "patchCount", "patchTypes", "patches"
	}
	if count, ok := spec[countKey].(float64); ok && len(actual) != int(count) {
		t.Fatalf("patch count: want %v, got %d: %s", count, len(actual), raw)
	}
	if types, ok := spec[typesKey].([]any); ok {
		got := make([]any, len(actual))
		for i, patch := range actual {
			got[i] = patch["type"]
		}
		if !reflect.DeepEqual(got, types) {
			t.Errorf("patch types: want %v, got %v", types, got)
		}
	}
	used := make([]bool, len(actual))
	if expected, ok := spec[patchesKey].([]any); ok {
		for _, value := range expected {
			want := value.(map[string]any)
			found := false
			for i, patch := range actual {
				if !used[i] && dndPatchMatches(patch, want) {
					used[i], found = true, true
					break
				}
			}
			if !found {
				t.Errorf("no patch matches %v; actual: %s", want, raw)
			}
		}
	}
	if forbidden, ok := spec["forbiddenPatchTypes"].([]any); ok {
		for _, kind := range forbidden {
			for _, patch := range actual {
				if patch["type"] == kind {
					t.Errorf("forbidden %v patch: %v", kind, patch)
				}
			}
		}
	}
}

func dndPatchMatches(actual, expected map[string]any) bool {
	for _, key := range []string{"type", "elementType", "name", "value"} {
		if want, required := expected[key]; required {
			got, present := actual[key]
			if !present || !reflect.DeepEqual(got, want) {
				return false
			}
		}
	}
	props, _ := actual["props"].(map[string]any)
	if expectedProps, ok := expected["props"].(map[string]any); ok {
		for key, want := range expectedProps {
			got, present := props[key]
			if !present || !reflect.DeepEqual(got, want) {
				return false
			}
		}
	}
	if absent, ok := expected["absentProps"].([]any); ok {
		for _, key := range absent {
			if _, present := props[key.(string)]; present {
				return false
			}
		}
	}
	return true
}
