// Package compatibility provides engine compatibility tests for the Go SDK.
//
// This test runner loads JSON test fixtures and verifies the Go SDK produces
// the same behavior as other SDK implementations.
//
// Run with: go test -v ./...
package compatibility

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	core "github.com/hypen-space/core"
)

// TestCase represents a compatibility test case loaded from JSON
type TestCase struct {
	Name        string    `json:"name"`
	Description string    `json:"description"`
	Category    string    `json:"category"`
	Priority    string    `json:"priority"`
	Input       TestInput `json:"input"`
	Expected    *Expected `json:"expected,omitempty"`
	Steps       []Step    `json:"steps,omitempty"`
	Skip        *Skip     `json:"skip,omitempty"`
}

// TestInput represents the input configuration for a test
type TestInput struct {
	Source       string         `json:"source"`
	InitialState map[string]any `json:"initialState"`
	Module       *ModuleConfig  `json:"module,omitempty"`
}

// ModuleConfig represents module configuration
type ModuleConfig struct {
	Name      string   `json:"name"`
	Actions   []string `json:"actions"`
	StateKeys []string `json:"stateKeys"`
}

// Expected represents expected outputs for simple tests
type Expected struct {
	Patches    []Patch `json:"patches,omitempty"`
	PatchCount *int    `json:"patchCount,omitempty"`
}

// Step represents a step in a multi-step test
type Step struct {
	Description        string       `json:"description"`
	Action             string       `json:"action"`
	StateChange        *StateChange `json:"stateChange,omitempty"`
	DispatchAction     *Action      `json:"dispatchAction,omitempty"`
	ExpectedPatches    []Patch      `json:"expectedPatches,omitempty"`
	ExpectedPatchCount *int         `json:"expectedPatchCount,omitempty"`
	ForbiddenPatches   []Patch      `json:"forbiddenPatches,omitempty"`
	ExpectedState      map[string]any `json:"expectedState,omitempty"`
}

// StateChange represents a state change notification
type StateChange struct {
	Paths     []string       `json:"paths"`
	NewValues map[string]any `json:"newValues"`
}

// Action represents an action to dispatch
type Action struct {
	Name    string `json:"name"`
	Payload any    `json:"payload,omitempty"`
	Sender  string `json:"sender,omitempty"`
}

// Patch represents a patch operation
type Patch struct {
	Type        string         `json:"type"`
	ID          string         `json:"id,omitempty"`
	ElementType string         `json:"elementType,omitempty"`
	Props       map[string]any `json:"props,omitempty"`
	Name        string         `json:"name,omitempty"`
	Value       any            `json:"value,omitempty"`
	Text        string         `json:"text,omitempty"`
	ParentID    string         `json:"parentId,omitempty"`
	BeforeID    string         `json:"beforeId,omitempty"`
	EventName   string         `json:"eventName,omitempty"`
}

// Skip configuration for tests
type Skip struct {
	Reason string   `json:"reason"`
	SDKs   []string `json:"sdks"`
}

// findFixtures recursively finds all JSON files in the fixtures directory.
// Skips `portable/` and `variant/` — those fixtures use different schemas
// and have their own runners (portable_test.go here; variant fixtures have
// runners in the Rust and TypeScript harnesses only).
func findFixtures(dir string) ([]string, error) {
	var fixtures []string

	err := filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() && (info.Name() == "portable" || info.Name() == "variant") {
			return filepath.SkipDir
		}
		if !info.IsDir() && strings.HasSuffix(info.Name(), ".json") {
			fixtures = append(fixtures, path)
		}
		return nil
	})

	return fixtures, err
}

// loadFixture loads and parses a test fixture from a JSON file
func loadFixture(path string) (*TestCase, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	var tc TestCase
	if err := json.Unmarshal(data, &tc); err != nil {
		return nil, err
	}

	return &tc, nil
}

// shouldSkip checks if a test should be skipped for the Go SDK
func shouldSkip(tc *TestCase) (bool, string) {
	if tc.Skip == nil {
		return false, ""
	}

	for _, sdk := range tc.Skip.SDKs {
		if sdk == "golang" {
			return true, tc.Skip.Reason
		}
	}

	return false, ""
}

// Action handler implementations for testing
var actionHandlers = map[string]func(action core.Action, state map[string]any) map[string]any{
	"handleClick": func(action core.Action, state map[string]any) map[string]any {
		state["clicked"] = true
		return state
	},
	"selectItem": func(action core.Action, state map[string]any) map[string]any {
		if payload, ok := action.Payload.(map[string]any); ok {
			state["selectedId"] = payload["id"]
		}
		return state
	},
}

// TestEngineCompatibility runs all compatibility tests
func TestEngineCompatibility(t *testing.T) {
	// Find fixtures directory relative to this test file
	fixturesDir := filepath.Join("..", "..", "fixtures")

	fixtures, err := findFixtures(fixturesDir)
	if err != nil {
		t.Fatalf("Failed to find fixtures: %v", err)
	}

	if len(fixtures) == 0 {
		t.Fatal("No fixtures found")
	}

	for _, fixturePath := range fixtures {
		tc, err := loadFixture(fixturePath)
		if err != nil {
			t.Errorf("Failed to load fixture %s: %v", fixturePath, err)
			continue
		}

		// Get relative path for test name
		relPath, _ := filepath.Rel(fixturesDir, fixturePath)

		t.Run(tc.Category+"/"+tc.Name, func(t *testing.T) {
			// Check if test should be skipped
			if skip, reason := shouldSkip(tc); skip {
				t.Skipf("Skipped for Go SDK: %s", reason)
				return
			}

			// Run the appropriate test based on category
			switch tc.Category {
			case "actions":
				runActionTest(t, tc)
			case "lifecycle":
				runLifecycleTest(t, tc)
			case "state":
				runStateTest(t, tc)
			case "rendering", "reconciliation", "control-flow":
				// These require a full engine implementation
				// Currently the Go SDK provides module system but not parser/renderer
				t.Skipf("Test category '%s' requires full engine (parser/renderer) - fixture: %s", tc.Category, relPath)
			default:
				t.Skipf("Unknown test category: %s", tc.Category)
			}
		})
	}
}

// runActionTest tests action dispatch functionality
func runActionTest(t *testing.T, tc *TestCase) {
	if tc.Input.Module == nil {
		t.Skip("No module configuration")
		return
	}

	// Create a mock engine
	engine := core.NewMockEngine()

	// Track state
	currentState := make(map[string]any)
	for k, v := range tc.Input.InitialState {
		currentState[k] = v
	}

	// Register module
	engine.SetModule(
		tc.Input.Module.Name,
		tc.Input.Module.Actions,
		tc.Input.Module.StateKeys,
		currentState,
	)

	// Register action handlers
	for _, actionName := range tc.Input.Module.Actions {
		actionName := actionName // Capture for closure
		engine.OnAction(actionName, func(action core.Action) {
			if handler, ok := actionHandlers[actionName]; ok {
				currentState = handler(action, currentState)
				// Notify state change
				paths := make([]string, 0, len(currentState))
				for k := range currentState {
					paths = append(paths, k)
				}
				engine.NotifyStateChange("", paths, currentState)
			}
		})
	}

	// Run test steps
	if tc.Steps != nil {
		for i, step := range tc.Steps {
			t.Logf("Step %d: %s", i+1, step.Description)

			switch step.Action {
			case "initialRender":
				// Skip - requires parser
				continue

			case "dispatchAction":
				if step.DispatchAction != nil {
					engine.TriggerAction(step.DispatchAction.Name, step.DispatchAction.Payload)
				}

			case "updateState":
				if step.StateChange != nil {
					for path, value := range step.StateChange.NewValues {
						setNestedValue(currentState, path, value)
					}
					engine.NotifyStateChange("", step.StateChange.Paths, step.StateChange.NewValues)
				}
			}

			// Verify expected state
			if step.ExpectedState != nil {
				for key, expected := range step.ExpectedState {
					actual := currentState[key]
					if !jsonEqual(actual, expected) {
						t.Errorf("State mismatch for key '%s': expected %v, got %v", key, expected, actual)
					}
				}
			}
		}
	}
}

// runLifecycleTest tests module lifecycle hooks
func runLifecycleTest(t *testing.T, tc *TestCase) {
	if tc.Input.Module == nil {
		t.Skip("No module configuration")
		return
	}

	// Track lifecycle events
	createdCalled := false
	destroyedCalled := false

	// Build module definition
	initialState := make(map[string]any)
	for k, v := range tc.Input.InitialState {
		initialState[k] = v
	}

	definition := core.NewAppBuilder(initialState, nil).
		OnCreated(func(state *core.ObservableState, ctx core.GlobalContext) {
			createdCalled = true
			state.Set("initialized", true)
		}).
		OnDestroyed(func(state *core.ObservableState, ctx core.GlobalContext) {
			destroyedCalled = true
		}).
		Build()

	// Create mock engine and module instance
	engine := core.NewMockEngine()
	instance := core.NewModuleInstance(engine, definition)

	// Verify onCreated was called
	if !createdCalled {
		t.Error("onCreated was not called")
	}

	// Check expected state if specified
	if tc.Steps != nil {
		for _, step := range tc.Steps {
			if step.ExpectedState != nil {
				state := instance.GetState()
				for key, expected := range step.ExpectedState {
					actual := state[key]
					if !jsonEqual(actual, expected) {
						t.Errorf("State mismatch for key '%s': expected %v, got %v", key, expected, actual)
					}
				}
			}
		}
	}

	// Test destroy
	instance.Destroy()
	if !destroyedCalled {
		t.Error("onDestroyed was not called")
	}
}

// runStateTest tests state management functionality
func runStateTest(t *testing.T, tc *TestCase) {
	// Most state tests require rendering - skip if they depend on patches
	if tc.Expected != nil && tc.Expected.Patches != nil {
		t.Skip("Test requires rendering engine")
		return
	}

	if tc.Steps != nil {
		for _, step := range tc.Steps {
			if step.ExpectedPatches != nil || step.ExpectedPatchCount != nil {
				t.Skip("Test requires rendering engine")
				return
			}
		}
	}

	// Create observable state
	state := core.NewObservableState(tc.Input.InitialState, nil)

	// Run steps that don't require rendering
	if tc.Steps != nil {
		for i, step := range tc.Steps {
			t.Logf("Step %d: %s", i+1, step.Description)

			if step.Action == "updateState" && step.StateChange != nil {
				for path, value := range step.StateChange.NewValues {
					state.Set(path, value)
				}
			}

			// Verify expected state
			if step.ExpectedState != nil {
				snapshot := state.GetAll()
				for key, expected := range step.ExpectedState {
					actual := snapshot[key]
					if !jsonEqual(actual, expected) {
						t.Errorf("State mismatch for key '%s': expected %v, got %v", key, expected, actual)
					}
				}
			}
		}
	}
}

// Helper: set nested value by dot-notation path
func setNestedValue(obj map[string]any, path string, value any) {
	parts := strings.Split(path, ".")
	current := obj

	for i := 0; i < len(parts)-1; i++ {
		part := parts[i]
		if _, ok := current[part]; !ok {
			current[part] = make(map[string]any)
		}
		if next, ok := current[part].(map[string]any); ok {
			current = next
		} else {
			return
		}
	}

	current[parts[len(parts)-1]] = value
}

// Helper: compare values as JSON for deep equality
func jsonEqual(a, b any) bool {
	aJSON, err1 := json.Marshal(a)
	bJSON, err2 := json.Marshal(b)
	if err1 != nil || err2 != nil {
		return false
	}
	return string(aJSON) == string(bJSON)
}
