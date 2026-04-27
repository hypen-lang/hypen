// Portable helper compatibility tests — cross-SDK.
//
// Every JSON fixture under engine-compatibility-tests/fixtures/portable/
// is loaded here and fed through the Go SDK's engine-backed bindings.
// The Go host must return byte-equal output to the engine's canonical
// implementation, and therefore to every other SDK that routes through
// the same Rust code.
package compatibility

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"testing"

	core "github.com/hypen-space/core"
)

type portableFixture struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Function    string          `json:"function"`
	Input       json.RawMessage `json:"input"`
	Expected    json.RawMessage `json:"expected"`
}

func portableFixturesRoot() string {
	// runners/golang/ → ../../fixtures/portable
	abs, err := filepath.Abs(filepath.Join("..", "..", "fixtures", "portable"))
	if err != nil {
		panic(err)
	}
	return abs
}

func loadPortableFixtures(t *testing.T) []portableFixture {
	t.Helper()
	var out []portableFixture
	root := portableFixturesRoot()
	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() || filepath.Ext(path) != ".json" {
			return nil
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		var f portableFixture
		if err := json.Unmarshal(raw, &f); err != nil {
			return fmt.Errorf("%s: %w", path, err)
		}
		out = append(out, f)
		return nil
	})
	if err != nil {
		t.Fatalf("walk portable fixtures: %v", err)
	}
	if len(out) == 0 {
		t.Fatalf("no portable fixtures found at %s", root)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

func TestPortableFixtures(t *testing.T) {
	for _, fixture := range loadPortableFixtures(t) {
		fixture := fixture
		t.Run(fixture.Name, func(t *testing.T) {
			switch fixture.Function {
			case "diff_paths":
				runDiffPathsFixture(t, fixture)
			case "match_path":
				runMatchPathFixture(t, fixture)
			case "session_step":
				runSessionStepFixture(t, fixture)
			case "path_get":
				runPathGetFixture(t, fixture)
			case "path_has":
				runPathHasFixture(t, fixture)
			case "path_set":
				runPathSetFixture(t, fixture)
			case "path_delete":
				runPathDeleteFixture(t, fixture)
			case "encode_uri_component":
				runEncodeURIFixture(t, fixture)
			case "decode_uri_component":
				runDecodeURIFixture(t, fixture)
			case "parse_query":
				runParseQueryFixture(t, fixture)
			case "build_url":
				runBuildURLFixture(t, fixture)
			default:
				t.Fatalf("unknown portable function %q", fixture.Function)
			}
		})
	}
}

func runDiffPathsFixture(t *testing.T, f portableFixture) {
	var input struct {
		Old any `json:"old"`
		New any `json:"new"`
	}
	if err := json.Unmarshal(f.Input, &input); err != nil {
		t.Fatalf("unmarshal input: %v", err)
	}

	got, err := core.DiffPathsViaEngine(input.Old, input.New)
	if err != nil {
		t.Fatalf("DiffPathsViaEngine: %v", err)
	}

	// Round-trip to JSON to normalise types (e.g. float64 vs int).
	gotRaw, _ := json.Marshal(got)
	var gotGeneric []map[string]any
	_ = json.Unmarshal(gotRaw, &gotGeneric)

	var wantGeneric []map[string]any
	if err := json.Unmarshal(f.Expected, &wantGeneric); err != nil {
		t.Fatalf("unmarshal expected: %v", err)
	}

	sortByPath := func(xs []map[string]any) {
		sort.Slice(xs, func(i, j int) bool {
			return fmt.Sprint(xs[i]["path"]) < fmt.Sprint(xs[j]["path"])
		})
	}
	sortByPath(gotGeneric)
	sortByPath(wantGeneric)

	if !reflect.DeepEqual(gotGeneric, wantGeneric) {
		t.Fatalf("mismatch:\n  got:  %v\n  want: %v", gotGeneric, wantGeneric)
	}
}

func runMatchPathFixture(t *testing.T, f portableFixture) {
	var input struct {
		Pattern string `json:"pattern"`
		Path    string `json:"path"`
	}
	if err := json.Unmarshal(f.Input, &input); err != nil {
		t.Fatalf("unmarshal input: %v", err)
	}

	got, err := core.MatchPathViaEngine(input.Pattern, input.Path)
	if err != nil {
		t.Fatalf("MatchPathViaEngine: %v", err)
	}

	// The engine returns {"matched": bool, "params": {...}}.
	var want struct {
		Matched bool              `json:"matched"`
		Params  map[string]string `json:"params"`
	}
	if err := json.Unmarshal(f.Expected, &want); err != nil {
		t.Fatalf("unmarshal expected: %v", err)
	}

	if got.Matched != want.Matched {
		t.Fatalf("matched mismatch: got %v want %v", got.Matched, want.Matched)
	}
	// Empty-param maps might come back as nil; treat them as equal.
	if len(got.Params) == 0 && len(want.Params) == 0 {
		return
	}
	if !reflect.DeepEqual(got.Params, want.Params) {
		t.Fatalf("params mismatch: got %v want %v", got.Params, want.Params)
	}
}

func runSessionStepFixture(t *testing.T, f portableFixture) {
	var input struct {
		State json.RawMessage `json:"state"`
		Event json.RawMessage `json:"event"`
	}
	if err := json.Unmarshal(f.Input, &input); err != nil {
		t.Fatalf("unmarshal input: %v", err)
	}

	gotRaw, err := core.SessionStepViaEngine(string(input.State), string(input.Event))
	if err != nil {
		t.Fatalf("SessionStepViaEngine: %v", err)
	}

	var got, want map[string]any
	if err := json.Unmarshal([]byte(gotRaw), &got); err != nil {
		t.Fatalf("unmarshal got: %v (raw=%q)", err, gotRaw)
	}
	if err := json.Unmarshal(f.Expected, &want); err != nil {
		t.Fatalf("unmarshal expected: %v", err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("mismatch: got %v want %v", got, want)
	}
}

// ─── Path + URL fixture runners ─────────────────────────────────────────

func jsonEq(t *testing.T, got, want any, name string) {
	t.Helper()
	gotBytes, _ := json.Marshal(got)
	wantBytes, _ := json.Marshal(want)
	if string(gotBytes) != string(wantBytes) {
		// Reparse so unordered maps/arrays compare equal via DeepEqual.
		var g, w any
		_ = json.Unmarshal(gotBytes, &g)
		_ = json.Unmarshal(wantBytes, &w)
		if !reflect.DeepEqual(g, w) {
			t.Fatalf("%s mismatch:\n  got:  %s\n  want: %s", name, string(gotBytes), string(wantBytes))
		}
	}
}

type pathInput struct {
	Value    any    `json:"value"`
	Path     string `json:"path"`
	NewValue any    `json:"new_value,omitempty"`
}

func runPathGetFixture(t *testing.T, f portableFixture) {
	var in pathInput
	if err := json.Unmarshal(f.Input, &in); err != nil {
		t.Fatalf("unmarshal input: %v", err)
	}
	got, err := core.PathGetViaEngine(in.Value, in.Path)
	if err != nil {
		t.Fatalf("PathGetViaEngine: %v", err)
	}
	var want any
	if err := json.Unmarshal(f.Expected, &want); err != nil {
		t.Fatalf("unmarshal expected: %v", err)
	}
	jsonEq(t, got, want, "path_get")
}

func runPathHasFixture(t *testing.T, f portableFixture) {
	var in pathInput
	if err := json.Unmarshal(f.Input, &in); err != nil {
		t.Fatalf("unmarshal input: %v", err)
	}
	got, err := core.PathHasViaEngine(in.Value, in.Path)
	if err != nil {
		t.Fatalf("PathHasViaEngine: %v", err)
	}
	var want bool
	if err := json.Unmarshal(f.Expected, &want); err != nil {
		t.Fatalf("unmarshal expected: %v", err)
	}
	if got != want {
		t.Fatalf("path_has mismatch: got %v want %v", got, want)
	}
}

func runPathSetFixture(t *testing.T, f portableFixture) {
	var in pathInput
	if err := json.Unmarshal(f.Input, &in); err != nil {
		t.Fatalf("unmarshal input: %v", err)
	}
	got, err := core.PathSetViaEngine(in.Value, in.Path, in.NewValue)
	if err != nil {
		t.Fatalf("PathSetViaEngine: %v", err)
	}
	var want any
	if err := json.Unmarshal(f.Expected, &want); err != nil {
		t.Fatalf("unmarshal expected: %v", err)
	}
	jsonEq(t, got, want, "path_set")
}

func runPathDeleteFixture(t *testing.T, f portableFixture) {
	var in pathInput
	if err := json.Unmarshal(f.Input, &in); err != nil {
		t.Fatalf("unmarshal input: %v", err)
	}
	updated, removed, err := core.PathDeleteViaEngine(in.Value, in.Path)
	if err != nil {
		t.Fatalf("PathDeleteViaEngine: %v", err)
	}
	got := map[string]any{"json": updated, "removed": removed}
	var want any
	if err := json.Unmarshal(f.Expected, &want); err != nil {
		t.Fatalf("unmarshal expected: %v", err)
	}
	jsonEq(t, got, want, "path_delete")
}

func runEncodeURIFixture(t *testing.T, f portableFixture) {
	var input string
	if err := json.Unmarshal(f.Input, &input); err != nil {
		t.Fatalf("unmarshal input: %v", err)
	}
	got, err := core.EncodeURIComponentViaEngine(input)
	if err != nil {
		t.Fatalf("EncodeURIComponentViaEngine: %v", err)
	}
	var want string
	if err := json.Unmarshal(f.Expected, &want); err != nil {
		t.Fatalf("unmarshal expected: %v", err)
	}
	if got != want {
		t.Fatalf("encode mismatch: got %q want %q", got, want)
	}
}

func runDecodeURIFixture(t *testing.T, f portableFixture) {
	var input string
	if err := json.Unmarshal(f.Input, &input); err != nil {
		t.Fatalf("unmarshal input: %v", err)
	}
	got, err := core.DecodeURIComponentViaEngine(input)
	if err != nil {
		t.Fatalf("DecodeURIComponentViaEngine: %v", err)
	}
	var want string
	if err := json.Unmarshal(f.Expected, &want); err != nil {
		t.Fatalf("unmarshal expected: %v", err)
	}
	if got != want {
		t.Fatalf("decode mismatch: got %q want %q", got, want)
	}
}

func runParseQueryFixture(t *testing.T, f portableFixture) {
	var input string
	if err := json.Unmarshal(f.Input, &input); err != nil {
		t.Fatalf("unmarshal input: %v", err)
	}
	path, query, err := core.ParseQueryViaEngine(input)
	if err != nil {
		t.Fatalf("ParseQueryViaEngine: %v", err)
	}
	got := map[string]any{"path": path, "query": query}
	var want any
	if err := json.Unmarshal(f.Expected, &want); err != nil {
		t.Fatalf("unmarshal expected: %v", err)
	}
	jsonEq(t, got, want, "parse_query")
}

func runBuildURLFixture(t *testing.T, f portableFixture) {
	var in struct {
		Path  string            `json:"path"`
		Query map[string]string `json:"query"`
	}
	if err := json.Unmarshal(f.Input, &in); err != nil {
		t.Fatalf("unmarshal input: %v", err)
	}
	got, err := core.BuildURLViaEngine(in.Path, in.Query)
	if err != nil {
		t.Fatalf("BuildURLViaEngine: %v", err)
	}
	var want string
	if err := json.Unmarshal(f.Expected, &want); err != nil {
		t.Fatalf("unmarshal expected: %v", err)
	}
	if got != want {
		t.Fatalf("build_url mismatch: got %q want %q", got, want)
	}
}
