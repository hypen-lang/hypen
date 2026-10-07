package core

import (
	"encoding/json"
	"testing"
)

// agent_test.go — the external capability surface (see agent.go).
//
// The invariant under test is the one the guard exists to hold: everything
// ListActions advertises dispatches, and dispatch accepts nothing else. In
// particular the framework internals a renderer legitimately reaches —
// __hypen_bind, router.replace — must stay unreachable from outside.

// newAgentTestEngine builds an engine with every primitive registered, so
// Input/Checkbox lower their .bind() applicators.
func newAgentTestEngine(t *testing.T) *WasmEngine {
	t.Helper()
	engine := newTestEngine(t)
	if err := engine.RegisterDefaultPrimitives(); err != nil {
		t.Fatalf("RegisterDefaultPrimitives: %v", err)
	}
	return engine
}

// recordActions registers a handler for each name and returns the log of
// (name, payload) pairs that actually reached one.
func recordActions(engine *WasmEngine, names ...string) *[]Action {
	log := &[]Action{}
	for _, name := range names {
		engine.OnAction(name, func(action Action) {
			*log = append(*log, action)
		})
	}
	return log
}

func actionNames(actions []AgentAction) []string {
	names := make([]string, 0, len(actions))
	for _, a := range actions {
		names = append(names, a.Name)
	}
	return names
}

func contains(haystack []string, needle string) bool {
	for _, s := range haystack {
		if s == needle {
			return true
		}
	}
	return false
}

func strPtr(s string) *string { return &s }

func TestListActionsAdvertisesDeclaredActions(t *testing.T) {
	engine := newAgentTestEngine(t)
	engine.SetModule("App", []string{"submit"}, []string{}, map[string]any{"name": ""})
	engine.RegisterModule("Cart", []string{"addToCart"}, []string{}, map[string]any{"total": 0})
	// Listed only once a handler exists: a declared name that would be
	// refused on dispatch is never advertised.
	recordActions(engine, "submit", "addToCart")

	actions, err := engine.ListActions()
	if err != nil {
		t.Fatalf("ListActions: %v", err)
	}

	names := actionNames(actions)
	if !contains(names, "submit") || !contains(names, "addToCart") {
		t.Fatalf("declared actions missing from listing: %v", names)
	}
	for _, hidden := range []string{"__hypen_bind", "router.push", "router.replace"} {
		if contains(names, hidden) {
			t.Errorf("framework internal %q must never be listed: %v", hidden, names)
		}
	}

	// Scope tells a caller which module owns the action; the primary
	// module's actions carry none.
	for _, a := range actions {
		switch a.Name {
		case "submit":
			if a.Module != "" || a.Builtin {
				t.Errorf("submit: got module=%q builtin=%v, want unscoped module action", a.Module, a.Builtin)
			}
		case "addToCart":
			if a.Module != "cart" {
				t.Errorf("addToCart: got module=%q, want %q", a.Module, "cart")
			}
		}
	}
}

func TestListedActionDispatchesExternally(t *testing.T) {
	engine := newAgentTestEngine(t)
	engine.SetModule("App", []string{"submit"}, []string{}, map[string]any{"name": ""})
	log := recordActions(engine, "submit")

	if err := engine.DispatchExternal("submit", map[string]any{"from": "mcp"}); err != nil {
		t.Fatalf("a listed action must dispatch: %v", err)
	}
	if len(*log) != 1 || (*log)[0].Name != "submit" {
		t.Fatalf("handler did not run: %+v", *log)
	}
}

func TestExternalDispatchRefusesFrameworkInternals(t *testing.T) {
	engine := newAgentTestEngine(t)
	if _, err := engine.RenderSource(`module App {
		Router { Route(path: "/") { Text("home") } }
		Input(placeholder: "Name").bind(@state.name)
	}`); err != nil {
		t.Fatalf("RenderSource: %v", err)
	}
	engine.SetModule("App", []string{"submit"}, []string{}, map[string]any{"name": ""})
	log := recordActions(engine, "__hypen_bind", "router.push", "router.replace", "router.forward")

	// __hypen_bind takes a caller-supplied path and assigns straight into
	// state; it stays behind set_input, which validates the field first.
	if err := engine.DispatchExternal("__hypen_bind", map[string]any{
		"path": "authToken", "value": "stolen",
	}); err == nil {
		t.Error("__hypen_bind must not be externally dispatchable")
	}

	// router.replace / router.forward manipulate history and have no
	// external meaning — only navigate/back are aliased.
	for _, hidden := range []string{"router.replace", "router.forward", "router.push"} {
		if err := engine.DispatchExternal(hidden, map[string]any{"to": "/admin"}); err == nil {
			t.Errorf("%q must not be externally dispatchable", hidden)
		}
	}

	if len(*log) != 0 {
		t.Fatalf("a refused dispatch must not reach a handler: %+v", *log)
	}
}

func TestSetInputOnlyWritesDeclaredFields(t *testing.T) {
	engine := newAgentTestEngine(t)
	if _, err := engine.RenderSource(`module App {
		Input(placeholder: "Name").bind(@state.name)
	}`); err != nil {
		t.Fatalf("RenderSource: %v", err)
	}
	engine.SetModule("App", []string{"submit"}, []string{}, map[string]any{"name": ""})
	log := recordActions(engine, "__hypen_bind")

	if err := engine.DispatchExternal(ActionSetInput, map[string]any{
		"field": "authToken", "value": "stolen",
	}); err == nil {
		t.Error("set_input must refuse a field no .bind() declares")
	}
	if len(*log) != 0 {
		t.Fatalf("a refused set_input must not reach __hypen_bind: %+v", *log)
	}

	if err := engine.DispatchExternal(ActionSetInput, map[string]any{
		"field": "name", "value": "Ada",
	}); err != nil {
		t.Fatalf("set_input on a declared field: %v", err)
	}
	if len(*log) != 1 {
		t.Fatalf("expected one __hypen_bind, got %+v", *log)
	}

	// The payload must be the one the guard built, not the caller's.
	payload, ok := (*log)[0].Payload.(map[string]any)
	if !ok {
		t.Fatalf("unexpected payload shape: %#v", (*log)[0].Payload)
	}
	if payload["path"] != "name" || payload["value"] != "Ada" {
		t.Fatalf("got %#v, want {path: name, value: Ada}", payload)
	}
}

func TestNavigateLowersToRouterPush(t *testing.T) {
	engine := newAgentTestEngine(t)
	if _, err := engine.RenderSource(`module App {
		Router { Route(path: "/cart") { Text("cart") } }
	}`); err != nil {
		t.Fatalf("RenderSource: %v", err)
	}
	log := recordActions(engine, "router.push", "router.back")

	if err := engine.DispatchExternal(ActionNavigate, map[string]any{"to": "/cart"}); err != nil {
		t.Fatalf("navigate: %v", err)
	}
	if len(*log) != 1 || (*log)[0].Name != "router.push" {
		t.Fatalf("navigate must arrive as router.push: %+v", *log)
	}
	payload, _ := (*log)[0].Payload.(map[string]any)
	if payload["to"] != "/cart" {
		t.Fatalf("payload must reach router.push untouched: %#v", (*log)[0].Payload)
	}
}

func TestBuiltinsAreRefusedWithoutTheirDeclaration(t *testing.T) {
	engine := newAgentTestEngine(t)
	if _, err := engine.RenderSource(`module App { Text("no router, no binds") }`); err != nil {
		t.Fatalf("RenderSource: %v", err)
	}
	recordActions(engine, "router.push", "__hypen_bind")

	actions, err := engine.ListActions()
	if err != nil {
		t.Fatalf("ListActions: %v", err)
	}
	names := actionNames(actions)
	for _, builtin := range []string{ActionNavigate, ActionBack, ActionSetInput} {
		if contains(names, builtin) {
			t.Errorf("%q listed though nothing declares it: %v", builtin, names)
		}
		if err := engine.DispatchExternal(builtin, map[string]any{"to": "/", "field": "x", "value": 1}); err == nil {
			t.Errorf("%q must be refused when the app declares no backing surface", builtin)
		}
	}
}

func TestListRoutesReportsTheDeclaredTable(t *testing.T) {
	engine := newAgentTestEngine(t)
	if _, err := engine.RenderSource(`module App {
		Router {
			Route(path: "/") { Text("home") }
			Route(path: "/user/:id") { Text("user") }
		}
	}`); err != nil {
		t.Fatalf("RenderSource: %v", err)
	}

	routes, err := engine.ListRoutes()
	if err != nil {
		t.Fatalf("ListRoutes: %v", err)
	}
	// Every declared route lists, not just the rendered one.
	if len(routes) != 2 {
		t.Fatalf("got %d routes, want 2: %+v", len(routes), routes)
	}
	if routes[0].Path != "/" || len(routes[0].Params) != 0 {
		t.Errorf("static route: %+v", routes[0])
	}
	if routes[1].Path != "/user/:id" || len(routes[1].Params) != 1 || routes[1].Params[0] != "id" {
		t.Errorf("param route: %+v", routes[1])
	}
	if routes[1].ModuleScope != "app" {
		t.Errorf("module scope: got %q, want %q", routes[1].ModuleScope, "app")
	}
}

func TestListBindingsTypesFieldsByProp(t *testing.T) {
	engine := newAgentTestEngine(t)
	if _, err := engine.RenderSource(`module App {
		Column {
			Input(placeholder: "Name").bind(@state.name)
			Checkbox {}.bind(@state.agreed)
		}
	}`); err != nil {
		t.Fatalf("RenderSource: %v", err)
	}

	bindings, err := engine.ListBindings()
	if err != nil {
		t.Fatalf("ListBindings: %v", err)
	}
	byPath := map[string]BoundInput{}
	for _, b := range bindings {
		byPath[b.Path] = b
	}

	if got := byPath["name"].Prop; got != "value" {
		t.Errorf("name.prop = %q, want value", got)
	}
	// checked is the boolean-typed prop — the signal that lets a caller
	// type the field without reading state.
	if got := byPath["agreed"].Prop; got != "checked" {
		t.Errorf("agreed.prop = %q, want checked", got)
	}
	if got := byPath["name"].ElementType; got != "Input" {
		t.Errorf("name.element_type = %q, want Input", got)
	}
}

func TestListBindingsCarryRouteAndStaticLabel(t *testing.T) {
	engine := newAgentTestEngine(t)
	if _, err := engine.RenderSource(`module App {
		Column {
			Router {
				Route(path: "/profile") {
					Input(placeholder: "Your name").bind(@state.name)
				}
			}
			Input(placeholder: "@{state.hint}").bind(@state.query)
		}
	}`); err != nil {
		t.Fatalf("RenderSource: %v", err)
	}

	bindings, err := engine.ListBindings()
	if err != nil {
		t.Fatalf("ListBindings: %v", err)
	}
	byPath := map[string]BoundInput{}
	for _, b := range bindings {
		byPath[b.Path] = b
	}

	// Which screen the field is on, and what a human calls it.
	if got := byPath["name"].Route; got != "/profile" {
		t.Errorf("name.route = %q, want /profile", got)
	}
	if got := byPath["name"].Label; got != "Your name" {
		t.Errorf("name.label = %q, want Your name", got)
	}
	// Outside any Route there is no route; an interpolated placeholder is
	// never read — the engine does not render state into the manifest.
	if got := byPath["query"].Route; got != "" {
		t.Errorf("query.route = %q, want empty", got)
	}
	if got := byPath["query"].Label; got != "" {
		t.Errorf("query.label = %q, want empty (interpolated placeholder)", got)
	}
}

func TestGetStateAtReadsPrimaryAndNamedModules(t *testing.T) {
	engine := newAgentTestEngine(t)
	engine.SetModule("App", []string{}, []string{}, map[string]any{
		"user":      map[string]any{"name": "Ada", "email": "ada@example.com"},
		"authToken": "sk-live-DO-NOT-LEAK",
	})
	engine.RegisterModule("Cart", []string{}, []string{}, map[string]any{"total": 4780, "coupon": "SECRET10"})

	// Reads are gated to what the templates render: a module's declared
	// paths are harvested from its own rendered nodes, so the named module
	// declares its paths through a component that is on screen.
	if err := engine.RegisterComponent("Cart", `module Cart { Text("Total: @{state.total}") }`, "Cart"); err != nil {
		t.Fatalf("RegisterComponent: %v", err)
	}
	if _, err := engine.RenderSource(`module App {
		Column {
			Text("Hi @{state.user.name}")
			Cart
		}
	}`); err != nil {
		t.Fatalf("RenderSource: %v", err)
	}

	assertJSON := func(module, path *string, want string) {
		t.Helper()
		got, err := engine.GetStateAt(module, path)
		if err != nil {
			t.Fatalf("GetStateAt: %v", err)
		}
		var normalized any
		if err := json.Unmarshal(got, &normalized); err != nil {
			t.Fatalf("GetStateAt returned invalid JSON %q: %v", string(got), err)
		}
		if string(got) != want {
			t.Errorf("GetStateAt = %s, want %s", got, want)
		}
	}

	assertJSON(nil, strPtr("user.name"), `"Ada"`)
	assertJSON(strPtr("cart"), strPtr("total"), `4780`)
	// Module names are matched case-insensitively, mirroring RegisterModule.
	// A whole-module read is projected down to the rendered paths: the
	// coupon the UI never shows is simply absent.
	assertJSON(strPtr("Cart"), nil, `{"total":4780}`)
	assertJSON(nil, nil, `{"user":{"name":"Ada"}}`)
	// Unknown module, absent path and unrendered path are deliberately
	// indistinguishable.
	assertJSON(strPtr("ghost"), nil, `null`)
	assertJSON(nil, strPtr("user.missing"), `null`)
	assertJSON(nil, strPtr("user.email"), `null`)
	assertJSON(nil, strPtr("authToken"), `null`)
	assertJSON(strPtr("cart"), strPtr("coupon"), `null`)
}

func TestUnregisterModuleDropsItsActionsOnly(t *testing.T) {
	engine := newAgentTestEngine(t)
	engine.SetModule("App", []string{"refresh"}, []string{}, map[string]any{})
	engine.RegisterModule("Cart", []string{"addToCart"}, []string{}, map[string]any{"total": 0})
	engine.RegisterModule("Catalog", []string{"search"}, []string{}, map[string]any{})
	log := recordActions(engine, "refresh", "addToCart", "search")

	if err := engine.DispatchExternal("addToCart", nil); err != nil {
		t.Fatalf("addToCart before unregister: %v", err)
	}

	engine.UnregisterModule("Cart")

	if err := engine.DispatchExternal("addToCart", nil); err == nil {
		t.Error("a destroyed module's actions must stop being externally reachable")
	}
	if len(*log) != 1 {
		t.Fatalf("handler must have run exactly once, before unregister: %+v", *log)
	}

	names, err := engine.ListActions()
	if err != nil {
		t.Fatalf("ListActions: %v", err)
	}
	listed := actionNames(names)
	if contains(listed, "addToCart") {
		t.Errorf("unregistered action still listed: %v", listed)
	}
	if !contains(listed, "search") || !contains(listed, "refresh") {
		t.Errorf("siblings and the primary module must survive: %v", listed)
	}

	state, err := engine.GetStateAt(strPtr("cart"), nil)
	if err != nil {
		t.Fatalf("GetStateAt: %v", err)
	}
	if string(state) != "null" {
		t.Errorf("unregistered module state = %s, want null", state)
	}
	if catalog, _ := engine.GetStateAt(strPtr("catalog"), nil); string(catalog) == "null" {
		t.Error("sibling module state must survive")
	}
}

func TestUnregisterUnknownModuleIsANoop(t *testing.T) {
	engine := newAgentTestEngine(t)
	engine.RegisterModule("Cart", []string{"addToCart"}, []string{}, map[string]any{})
	recordActions(engine, "addToCart")

	engine.UnregisterModule("nosuchmodule")

	actions, err := engine.ListActions()
	if err != nil {
		t.Fatalf("ListActions: %v", err)
	}
	if !contains(actionNames(actions), "addToCart") {
		t.Errorf("unrelated module dropped: %v", actionNames(actions))
	}
}

func TestUnregisterReachesThePrimaryModule(t *testing.T) {
	// The primary slot's actions carry no scope, so a scope-match alone
	// never reaches them — and the app's main module lives exactly there.
	engine := newAgentTestEngine(t)
	engine.SetModule("App", []string{"refresh"}, []string{}, map[string]any{"authToken": "sekrit"})
	log := recordActions(engine, "refresh")

	engine.UnregisterModule("App")

	if err := engine.DispatchExternal("refresh", nil); err == nil {
		t.Error("a destroyed primary module's actions must stop being dispatchable")
	}
	if len(*log) != 0 {
		t.Fatalf("handler must not have run: %+v", *log)
	}

	actions, err := engine.ListActions()
	if err != nil {
		t.Fatalf("ListActions: %v", err)
	}
	if contains(actionNames(actions), "refresh") {
		t.Errorf("unregistered primary action still listed: %v", actionNames(actions))
	}
	if state, _ := engine.GetStateAt(nil, nil); string(state) != "null" {
		t.Errorf("primary state after unregister = %s, want null", state)
	}
}
