package core

import "testing"

// MockEngine.DispatchClientAction models the engine's client entry over the
// nodes a test declares (the real rule is pinned against hypen_engine.wasm in
// remote/client_action_test.go).
func TestMockEngine_DispatchClientAction(t *testing.T) {
	e := NewMockEngine()
	var ran []Action
	e.OnAction("__hypen_scoped::save", func(a Action) { ran = append(ran, a) })
	e.OnAction("__hypen_scoped::wipe", func(a Action) { ran = append(ran, a) })
	e.OnAction("__hypen_scoped::__hypen_bind", func(a Action) { ran = append(ran, a) })
	e.DeclareNodeAction("7", "", "save")
	e.DeclareNodeAction("8", "", "__hypen_bind")

	env := func(node, action string) map[string]any {
		return map[string]any{"node": node, "action": action, "payload": map[string]any{"n": 1}}
	}
	for _, c := range []struct {
		name    string
		payload any
	}{
		{"save", nil},                                 // bare name
		{"__hypen_scoped::save", nil},                 // pre-scoped name
		{"__hypen_bind", map[string]any{"path": "x"}}, // bare reserved write
		{mockUIEnvelope, env("7", "wipe")},            // node does not carry it
		{mockUIEnvelope, env("7", "__hypen_bind")},    // no .bind on the node
		{mockUIEnvelope, env("7", "__hypen_other")},   // other reserved name
		{mockUIEnvelope, env("7", mockUIEnvelope)},    // nested envelope
		{mockUIEnvelope, env("99", "save")},           // node never declared
		{mockUIEnvelope, "not a map"},
	} {
		if err := e.DispatchClientAction(c.name, c.payload); !IsEngineError(err, ErrActionNotFound) {
			t.Errorf("DispatchClientAction(%q, %v) = %v, want a refusal", c.name, c.payload, err)
		}
	}
	if len(ran) != 0 {
		t.Fatalf("refused actions ran: %+v", ran)
	}

	if err := e.DispatchClientAction(mockUIEnvelope, env("7", "save")); err != nil {
		t.Fatalf("bound envelope refused: %v", err)
	}
	if err := e.DispatchClientAction(mockUIEnvelope, env("8", "__hypen_bind")); err != nil {
		t.Fatalf("bound reserved write refused: %v", err)
	}
	if len(ran) != 2 || ran[0].Name != "__hypen_scoped::save" || ran[0].Sender != "7" ||
		ran[0].Payload.(map[string]any)["n"] != 1 || ran[1].Name != "__hypen_scoped::__hypen_bind" {
		t.Fatalf("ran %+v", ran)
	}

	e.RemoveNode("7")
	if err := e.DispatchClientAction(mockUIEnvelope, env("7", "save")); err == nil {
		t.Fatal("envelope on a removed node accepted")
	}
}
