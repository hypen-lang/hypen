package compatibility

import (
	"encoding/json"
	"fmt"
	"os"
	"testing"

	core "github.com/hypen-lang/hypen/hypen-golang"
)

// Real-engine runner for action fixtures that carry `dispatchClientAction`
// steps: an action as an UNTRUSTED client would send it, fed to the
// engine's client entry (WASI hypen_dispatch_client_action, reached through
// core.WasmEngine.DispatchClientAction). The step's node selector needs the
// rendered tree, so these fixtures run on the WASI engine the Go SDK embeds,
// not on the MockEngine runActionTest uses.

type clientActionFixture struct {
	Input struct {
		Source       string         `json:"source"`
		InitialState map[string]any `json:"initialState"`
		Module       *ModuleConfig  `json:"module"`
	} `json:"input"`
	Steps []clientActionStep `json:"steps"`
}

type clientActionStep struct {
	Description        string         `json:"description"`
	Action             string         `json:"action"`
	DispatchAction     *Action        `json:"dispatchAction"`
	ClientAction       *clientAction  `json:"clientAction"`
	ExpectRefused      *bool          `json:"expectRefused"`
	ExpectedPatchCount *int           `json:"expectedPatchCount"`
	ExpectedState      map[string]any `json:"expectedState"`
}

type clientAction struct {
	Name    string `json:"name"`
	Payload any    `json:"payload"`
	Node    *struct {
		ElementType string         `json:"elementType"`
		Props       map[string]any `json:"props"`
	} `json:"node"`
	NodeID *string `json:"nodeId"`
}

// hasClientActionSteps reports whether a fixture drives the client entry.
func hasClientActionSteps(tc *TestCase) bool {
	for _, s := range tc.Steps {
		if s.Action == "dispatchClientAction" {
			return true
		}
	}
	return false
}

func runClientActionFixture(t *testing.T, path string) {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var fx clientActionFixture
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatal(err)
	}
	if fx.Input.Module == nil {
		t.Fatal("dispatchClientAction fixtures need input.module")
	}

	engine, err := core.NewDefaultEngine()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { engine.Close() })
	if err := engine.RegisterDefaultPrimitives(); err != nil {
		t.Fatal(err)
	}

	state := map[string]any{}
	for k, v := range fx.Input.InitialState {
		state[k] = v
	}
	keys := fx.Input.Module.StateKeys
	if keys == nil {
		keys = []string{}
	}
	actions := fx.Input.Module.Actions
	if actions == nil {
		actions = []string{}
	}
	engine.SetModule(fx.Input.Module.Name, actions, keys, state)
	for _, name := range actions {
		name := name
		engine.OnAction("__hypen_scoped::"+name, func(a core.Action) {
			if handler, ok := actionHandlers[name]; ok {
				state = handler(core.Action{Name: name, Payload: a.Payload}, state)
				if _, err := engine.UpdateState(state); err != nil {
					t.Errorf("UpdateState after %s: %v", name, err)
				}
			}
		})
	}

	type created struct {
		id, elementType string
		props           map[string]any
	}
	var creates []created
	record := func(patches []core.Patch) {
		for _, p := range patches {
			if p.Type == "create" {
				creates = append(creates, created{p.ID, p.ElementType, p.Props})
			}
		}
	}
	findNode := func(label, elementType string, props map[string]any) string {
		for _, c := range creates {
			if c.elementType != elementType {
				continue
			}
			match := true
			for k, v := range props {
				if !jsonEqual(c.props[k], v) {
					match = false
					break
				}
			}
			if match {
				return c.id
			}
		}
		t.Fatalf("%s: no %s created with props %v", label, elementType, props)
		return ""
	}

	for i, step := range fx.Steps {
		label := step.Description
		if label == "" {
			label = fmt.Sprintf("step %d", i)
		}
		switch step.Action {
		case "initialRender":
			patches, err := engine.RenderSource(fx.Input.Source)
			if err != nil {
				t.Fatalf("%s: %v", label, err)
			}
			record(patches)
			if step.ExpectedPatchCount != nil && len(patches) != *step.ExpectedPatchCount {
				t.Errorf("%s: patch count %d, want %d", label, len(patches), *step.ExpectedPatchCount)
			}
		case "dispatchAction":
			if step.DispatchAction == nil {
				t.Fatalf("%s: dispatchAction step needs `dispatchAction`", label)
			}
			if err := engine.DispatchAction(step.DispatchAction.Name, step.DispatchAction.Payload); err != nil {
				t.Errorf("%s: %v", label, err)
			}
		case "dispatchClientAction":
			ca := step.ClientAction
			if ca == nil {
				t.Fatalf("%s: dispatchClientAction step needs `clientAction`", label)
			}
			name, payload := ca.Name, ca.Payload
			var node string
			switch {
			case ca.Node != nil:
				node = findNode(label, ca.Node.ElementType, ca.Node.Props)
			case ca.NodeID != nil:
				node = *ca.NodeID
			}
			if ca.Node != nil || ca.NodeID != nil {
				name, payload = "__hypen_dispatch", map[string]any{"node": node, "action": ca.Name, "payload": ca.Payload}
			}
			err := engine.DispatchClientAction(name, payload)
			if step.ExpectRefused != nil {
				if *step.ExpectRefused && err == nil {
					t.Errorf("%s: client action was run, want it refused", label)
				}
				if !*step.ExpectRefused && err != nil {
					t.Errorf("%s: client action refused: %v", label, err)
				}
			}
		default:
			t.Fatalf("%s: step action %q is not driven by the Go client-action runner", label, step.Action)
		}
		for key, want := range step.ExpectedState {
			if got := state[key]; !jsonEqual(got, want) {
				t.Errorf("%s: state[%q] = %v, want %v", label, key, got, want)
			}
		}
	}
}
