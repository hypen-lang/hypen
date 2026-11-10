package core

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
)

func testThemeOptions() ThemeOptions {
	return ThemeOptions{
		Tokens: Tokens{
			"color": Tokens{
				"brand":   "#0066ff",
				"primary": "{color.brand}",
				"surface": "#ffffff",
				"ink":     "#111111",
			},
			"space": map[string]int{"sm": 8, "md": 16},
			"font":  map[string]string{"body": "Inter"},
		},
		Schemes: map[string]Tokens{
			"dark":  {"color": Tokens{"brand": "#66a3ff", "surface": "#111111", "ink": "#f5f5f5"}},
			"sepia": {"color": Tokens{"surface": "#f4ecd8"}},
		},
	}
}

func testTheme() *Theme { return NewTheme(testThemeOptions()) }

func mustToken(t *testing.T, theme *Theme, path string) any {
	t.Helper()
	v, ok := theme.Token(path)
	if !ok {
		t.Fatalf("token %q is missing", path)
	}
	return v
}

// themeProps lists "name=value" for every prop carried by create / setProp
// patches, sorted.
func themeProps(patches []Patch) []string {
	out := []string{}
	add := func(name string, value any) {
		data, _ := json.Marshal(value)
		out = append(out, name+"="+string(data))
	}
	for _, p := range patches {
		switch p.Type {
		case PatchCreate:
			for name, value := range p.Props {
				add(name, value)
			}
		case PatchSetProp:
			add(p.Name, p.Value)
		}
	}
	sort.Strings(out)
	return out
}

func containsAll(have []string, want ...string) bool {
	set := make(map[string]bool, len(have))
	for _, h := range have {
		set[h] = true
	}
	for _, w := range want {
		if !set[w] {
			return false
		}
	}
	return true
}

// ── cross-SDK fixture ─────────────────────────────────────────────────────

type themeFixtureCase struct {
	Name       string            `json:"name"`
	Tokens     Tokens            `json:"tokens"`
	Schemes    map[string]Tokens `json:"schemes"`
	Preference string            `json:"preference"`
	System     string            `json:"system"`
	Expected   struct {
		Scheme   string `json:"scheme"`
		Tokens   Tokens `json:"tokens"`
		Problems int    `json:"problems"`
	} `json:"expected"`
}

func TestThemeResolveFixture(t *testing.T) {
	p, err := filepath.Abs(filepath.Join("..", "engine-compatibility-tests", "fixtures", "theme", "resolve.json"))
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var fixture struct {
		Cases []themeFixtureCase `json:"cases"`
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	if len(fixture.Cases) == 0 {
		t.Fatal("fixture has no cases")
	}
	for _, c := range fixture.Cases {
		t.Run(c.Name, func(t *testing.T) {
			theme := NewTheme(ThemeOptions{
				Tokens:       c.Tokens,
				Schemes:      c.Schemes,
				Scheme:       c.Preference,
				SystemScheme: c.System,
			})
			if got := theme.Preference(); got != c.Preference {
				t.Fatalf("preference = %q, want %q", got, c.Preference)
			}
			if got := theme.Scheme(); got != c.Expected.Scheme {
				t.Errorf("scheme = %q, want %q", got, c.Expected.Scheme)
			}
			// Through JSON, as the engine receives them.
			raw, err := json.Marshal(theme.Tokens())
			if err != nil {
				t.Fatal(err)
			}
			var got Tokens
			if err := json.Unmarshal(raw, &got); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, c.Expected.Tokens) {
				t.Errorf("tokens = %s, want %v", raw, c.Expected.Tokens)
			}
			if got := len(theme.Problems()); got != c.Expected.Problems {
				t.Errorf("problems = %d (%v), want %d", got, theme.Problems(), c.Expected.Problems)
			}
		})
	}
}

// ── tokens ────────────────────────────────────────────────────────────────

func TestThemeTokensKeepTheirGoTypes(t *testing.T) {
	theme := testTheme()
	if got := mustToken(t, theme, "space.md"); got != 16 {
		t.Errorf("space.md = %#v, want int 16", got)
	}
	if got := mustToken(t, theme, "color.primary"); got != "#0066ff" {
		t.Errorf("color.primary = %#v", got)
	}
	if group, ok := mustToken(t, theme, "font").(Tokens); !ok || group["body"] != "Inter" {
		t.Errorf("font = %#v, want a Tokens group", mustToken(t, theme, "font"))
	}
}

func TestThemeDoesNotShareMapsWithCaller(t *testing.T) {
	opts := testThemeOptions()
	theme := NewTheme(opts)
	opts.Tokens["color"].(Tokens)["surface"] = "#ff0000"
	theme.Toggle()
	theme.Toggle()
	if got := mustToken(t, theme, "color.surface"); got != "#ffffff" {
		t.Errorf("caller mutation leaked into the theme: %v", got)
	}
}

func TestThemeAliasProblems(t *testing.T) {
	var problems []string
	resolved := ResolveTokenAliases(Tokens{
		"a": "{b}", "b": "{a}", "c": "{nope}", "self": Tokens{"inner": "{self}"},
	}, func(p string) { problems = append(problems, p) })
	want := Tokens{"a": "{b}", "b": "{a}", "c": "{nope}", "self": Tokens{"inner": "{self}"}}
	if !reflect.DeepEqual(resolved, want) {
		t.Errorf("resolved = %v", resolved)
	}
	cycles := 0
	for _, p := range problems {
		if strings.Contains(p, "cycle") {
			cycles++
		}
	}
	if len(problems) != 4 || cycles != 3 {
		t.Errorf("problems = %v", problems)
	}
}

func TestThemeTokenReportsMissingOnce(t *testing.T) {
	var missing []string
	opts := testThemeOptions()
	opts.OnMissingToken = func(path, scheme string) { missing = append(missing, scheme+":"+path) }
	theme := NewTheme(opts)
	for i := 0; i < 2; i++ {
		if v, ok := theme.Token("color.nope"); ok || v != nil {
			t.Fatalf("Token(color.nope) = %v, %v", v, ok)
		}
	}
	if theme.Has("color.nope") || !theme.Has("color.ink") {
		t.Error("Has is wrong")
	}
	if !reflect.DeepEqual(missing, []string{"light:color.nope"}) {
		t.Errorf("missing = %v", missing)
	}
}

func TestThemeExtend(t *testing.T) {
	theme := testTheme()
	theme.Extend(Tokens{"radius": Tokens{"md": 8}}, "")
	theme.Extend(Tokens{"radius": Tokens{"md": 12}}, "dark")
	if got := mustToken(t, theme, "radius.md"); got != 8 {
		t.Errorf("radius.md = %v, want 8", got)
	}
	if err := theme.SetScheme("dark"); err != nil {
		t.Fatal(err)
	}
	if got := mustToken(t, theme, "radius.md"); got != 12 {
		t.Errorf("dark radius.md = %v, want 12", got)
	}
	if got := mustToken(t, theme, "color.ink"); got != "#f5f5f5" {
		t.Errorf("dark color.ink = %v", got)
	}
}

// ── schemes ───────────────────────────────────────────────────────────────

func TestThemeFollowsSystemByDefault(t *testing.T) {
	theme := testTheme()
	want := ThemeMeta{Scheme: "light", Preference: "system", System: "light", Schemes: []string{"dark", "sepia"}}
	if got := theme.Meta(); !reflect.DeepEqual(got, want) {
		t.Errorf("meta = %+v", got)
	}
	if err := theme.SetSystemScheme("dark"); err != nil {
		t.Fatal(err)
	}
	if theme.Scheme() != "dark" || mustToken(t, theme, "color.surface") != "#111111" {
		t.Errorf("did not follow the system scheme: %+v", theme.Meta())
	}
	if err := theme.SetSystemScheme("sepia"); err == nil {
		t.Error("SetSystemScheme accepted a non-system scheme")
	}
}

func TestThemeExplicitPreferenceWins(t *testing.T) {
	opts := testThemeOptions()
	opts.Scheme = "sepia"
	theme := NewTheme(opts)
	_ = theme.SetSystemScheme("dark")
	if theme.Scheme() != "sepia" || theme.SystemScheme() != "dark" {
		t.Fatalf("meta = %+v", theme.Meta())
	}
	if got := mustToken(t, theme, "color.surface"); got != "#f4ecd8" {
		t.Errorf("surface = %v", got)
	}
	if err := theme.SetScheme(SystemScheme); err != nil {
		t.Fatal(err)
	}
	if theme.Scheme() != "dark" {
		t.Errorf("scheme = %q, want the remembered system scheme", theme.Scheme())
	}
}

func TestThemeToggle(t *testing.T) {
	opts := testThemeOptions()
	opts.SystemScheme = "dark"
	theme := NewTheme(opts)
	theme.Toggle()
	if theme.Preference() != "light" {
		t.Errorf("preference = %q, want light", theme.Preference())
	}
	theme.Toggle()
	if theme.Preference() != "dark" {
		t.Errorf("preference = %q, want dark", theme.Preference())
	}
}

func TestThemeUnknownScheme(t *testing.T) {
	opts := testThemeOptions()
	opts.Scheme = "neon"
	theme := NewTheme(opts)
	if theme.Preference() != SystemScheme {
		t.Errorf("preference = %q, want system", theme.Preference())
	}
	err := theme.SetScheme("neon")
	if err == nil || !strings.Contains(err.Error(), `unknown color scheme "neon"`) {
		t.Errorf("SetScheme(neon) = %v", err)
	}
	if theme.Preference() != SystemScheme {
		t.Error("a rejected scheme changed the preference")
	}
}

func TestThemeOnChangeFiresOnEffectiveChangesOnly(t *testing.T) {
	theme := testTheme()
	var seen []string
	off := theme.OnChange(func(meta ThemeMeta) { seen = append(seen, meta.Preference+"/"+meta.Scheme) })
	_ = theme.SetScheme("dark")
	_ = theme.SetScheme("dark")
	_ = theme.SetSystemScheme("dark")
	_ = theme.SetSystemScheme("dark")
	off()
	_ = theme.SetScheme("light")
	if !reflect.DeepEqual(seen, []string{"dark/dark", "dark/dark"}) {
		t.Errorf("seen = %v", seen)
	}
}

func TestThemeFork(t *testing.T) {
	host := testTheme()
	a := host.Fork("")
	b := host.Fork("dark")
	if a.Scheme() != "light" || b.Scheme() != "dark" {
		t.Fatalf("a=%q b=%q", a.Scheme(), b.Scheme())
	}
	_ = a.SetScheme("sepia")
	if host.Scheme() != "light" || b.Scheme() != "dark" {
		t.Errorf("a fork's scheme leaked: host=%q b=%q", host.Scheme(), b.Scheme())
	}
	host.Extend(Tokens{"radius": Tokens{"md": 8}}, "")
	// Shared store: a fork picks the new token up the next time it rebuilds.
	_ = b.SetScheme("light")
	if got := mustToken(t, b, "radius.md"); got != 8 {
		t.Errorf("fork radius.md = %v", got)
	}
}

// recordingContextEngine records every context it is handed.
type recordingContextEngine struct {
	mu    sync.Mutex
	calls []string
	last  map[string]string
}

func (e *recordingContextEngine) SetContext(name string, data any) ([]Patch, error) {
	raw, err := json.Marshal(data)
	if err != nil {
		return nil, err
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.last == nil {
		e.last = make(map[string]string)
	}
	e.calls = append(e.calls, name)
	e.last[name] = string(raw)
	return nil, nil
}

func TestThemeAttachPublishesNowAndOnChange(t *testing.T) {
	theme := testTheme()
	engine := &recordingContextEngine{}
	detach := theme.Attach(engine)
	if !reflect.DeepEqual(engine.calls, []string{"appearance", "theme"}) {
		t.Fatalf("attach published %v", engine.calls)
	}
	if got := engine.last["appearance"]; got != `{"scheme":"light","preference":"system","system":"light","schemes":["dark","sepia"]}` {
		t.Errorf("appearance = %s", got)
	}
	_ = theme.SetScheme("dark")
	if !strings.Contains(engine.last["theme"], `"surface":"#111111"`) || !strings.Contains(engine.last["appearance"], `"scheme":"dark"`) {
		t.Errorf("after SetScheme: %v", engine.last)
	}
	detach()
	n := len(engine.calls)
	_ = theme.SetScheme("light")
	if len(engine.calls) != n {
		t.Error("published after detach")
	}
}

// Run with -race: concurrent changes on a theme and its forks, with the
// attached engine ending on the theme's final snapshot.
func TestThemeConcurrentUse(t *testing.T) {
	host := testTheme()
	hostEngine := &recordingContextEngine{}
	host.Attach(hostEngine)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			fork := host.Fork("")
			fork.Attach(&recordingContextEngine{})
			off := fork.OnChange(func(ThemeMeta) {})
			defer off()
			for j := 0; j < 50; j++ {
				host.Toggle()
				fork.Toggle()
				host.Extend(Tokens{"n": Tokens{"v": j}}, "")
				_, _ = fork.Token("color.primary")
				_ = host.Problems()
				if _, err := json.Marshal(host.Tokens()); err != nil {
					t.Error(err)
				}
			}
		}()
	}
	wg.Wait()

	wantMeta, _ := json.Marshal(host.Meta())
	wantTokens, _ := json.Marshal(host.Tokens())
	hostEngine.mu.Lock()
	defer hostEngine.mu.Unlock()
	if got := hostEngine.last["appearance"]; got != string(wantMeta) {
		t.Errorf("engine's appearance = %s, want %s", got, wantMeta)
	}
	if got := hostEngine.last["theme"]; got != string(wantTokens) {
		t.Errorf("engine's theme = %s, want %s", got, wantTokens)
	}
}

// ── engine integration (the embedded WASM engine) ────────────────────────

func newThemeEngine(t *testing.T) *WasmEngine {
	t.Helper()
	engine, err := NewDefaultEngine()
	if err != nil {
		t.Fatalf("NewDefaultEngine: %v", err)
	}
	t.Cleanup(func() { engine.Close() })
	for _, p := range []string{"Text", "Column", "Row", "Button"} {
		if err := engine.RegisterPrimitive(p); err != nil {
			t.Fatalf("RegisterPrimitive %s: %v", p, err)
		}
	}
	return engine
}

type themeModState struct {
	N int `json:"n"`
}

func TestThemeEngine_TokensResolveInTemplates(t *testing.T) {
	engine := newThemeEngine(t)
	engine.SetModule("App", []string{}, []string{}, map[string]any{})
	testTheme().Attach(engine)

	patches, err := engine.RenderSource(`Column {
		Text("Hi").color(@theme.color.primary).padding(@theme.space.md)
		Text("@{theme.font.body} / @{appearance.scheme}")
	}.backgroundColor(@theme.color.surface)`)
	if err != nil {
		t.Fatalf("RenderSource: %v", err)
	}
	props := themeProps(patches)
	if !containsAll(props, `color.0="#0066ff"`, `padding.0=16`, `backgroundColor.0="#ffffff"`) {
		t.Errorf("applicators did not resolve @theme.*: %v", props)
	}
	if !strings.Contains(strings.Join(props, "\n"), `"Inter / light"`) {
		t.Errorf("template did not resolve @{theme.*} / @{appearance.*}: %v", props)
	}
}

func TestThemeEngine_SchemeSwitchEmitsOnlyChangedProps(t *testing.T) {
	engine := newThemeEngine(t)
	engine.SetModule("App", []string{}, []string{}, map[string]any{})
	theme := testTheme()
	theme.Attach(engine)
	if _, err := engine.RenderSource(`Column {
		Text("Hi").color(@theme.color.primary).padding(@theme.space.md)
		Text("@{theme.font.body}")
	}.backgroundColor(@theme.color.surface)`); err != nil {
		t.Fatalf("RenderSource: %v", err)
	}

	var patches []Patch
	engine.SetPatchCallback(func(batch []Patch) { patches = append(patches, batch...) })

	if err := theme.SetScheme("dark"); err != nil {
		t.Fatal(err)
	}
	for _, p := range patches {
		if p.Type != PatchSetProp {
			t.Errorf("unexpected %q patch on a scheme switch: %+v", p.Type, p)
		}
	}
	want := []string{`backgroundColor.0="#111111"`, `color.0="#66a3ff"`}
	if got := themeProps(patches); !reflect.DeepEqual(got, want) {
		t.Errorf("scheme switch patches = %v, want %v", got, want)
	}

	patches = nil
	_ = theme.SetSystemScheme("dark") // preference is explicit: no token changes
	if len(patches) != 0 {
		t.Errorf("system scheme change under an explicit preference emitted %+v", patches)
	}
}

func TestThemeEngine_SetAndRemoveContext(t *testing.T) {
	engine := newThemeEngine(t)
	engine.SetModule("App", []string{}, []string{}, map[string]any{})
	if _, err := engine.SetContext("brand", map[string]any{"name": "Acme"}); err != nil {
		t.Fatalf("SetContext: %v", err)
	}
	patches, err := engine.RenderSource(`Text("@{brand.name}")`)
	if err != nil {
		t.Fatalf("RenderSource: %v", err)
	}
	if !strings.Contains(strings.Join(themeProps(patches), "\n"), `"Acme"`) {
		t.Fatalf("context did not resolve: %v", themeProps(patches))
	}

	var viaCallback []Patch
	engine.SetPatchCallback(func(batch []Patch) { viaCallback = append(viaCallback, batch...) })
	patches, err = engine.SetContext("brand", map[string]any{"name": "Globex"})
	if err != nil {
		t.Fatalf("SetContext: %v", err)
	}
	if got := themeProps(patches); len(got) != 1 || !strings.Contains(got[0], `"Globex"`) {
		t.Errorf("SetContext patches = %v", got)
	}
	if !reflect.DeepEqual(themeProps(viaCallback), themeProps(patches)) {
		t.Errorf("patch callback saw %v, SetContext returned %v", themeProps(viaCallback), themeProps(patches))
	}
	if _, err := engine.SetContext("brand", func() {}); err == nil {
		t.Error("SetContext accepted data that does not marshal")
	}
	if _, err := engine.RemoveContext("brand"); err != nil {
		t.Errorf("RemoveContext: %v", err)
	}
}

// A handler runs inside DispatchAction; switching scheme from it must reach
// the renderer (no re-entrancy failure, no deadlock).
func TestThemeEngine_HandlerSwitchesScheme(t *testing.T) {
	engine := newThemeEngine(t)
	theme := testTheme()
	ctx := NewHypenGlobalContext()
	ctx.SetTheme(theme)

	var viaContext, viaShorthand *Theme
	def := NewApp(themeModState{}).
		OnCreated(func(_ *themeModState, gc GlobalContext) { viaContext = gc.GetTheme() }).
		OnAction("go", func(c TypedActionContext[themeModState]) {
			viaShorthand = c.Theme()
			if err := c.Theme().SetScheme("dark"); err != nil {
				t.Errorf("SetScheme in handler: %v", err)
			}
			c.State.N++
		}).
		Build()
	instance := NewModuleInstance(engine, def, WithGlobalContext(ctx))
	defer instance.Destroy()
	if viaContext != theme {
		t.Error("lifecycle handlers do not reach the theme through GlobalContext.GetTheme()")
	}

	theme.Attach(engine)
	if _, err := engine.RenderSource(`Column {
		Text("x").color(@theme.color.ink)
		Text("n=@{state.n}")
		Button("@actions.go") { Text("go") }
	}`); err != nil {
		t.Fatalf("RenderSource: %v", err)
	}
	var patches []Patch
	engine.SetPatchCallback(func(batch []Patch) { patches = append(patches, batch...) })

	if err := engine.DispatchAction("go", nil); err != nil {
		t.Fatalf("DispatchAction: %v", err)
	}
	if viaShorthand != theme {
		t.Fatal("handler did not run, or ctx.Theme() is not the registered theme")
	}
	got := themeProps(patches)
	if !containsAll(got, `color.0="#f5f5f5"`) {
		t.Errorf("handler's scheme switch was not rendered: %v", got)
	}
	if !strings.Contains(strings.Join(got, "\n"), `"n=1"`) {
		t.Errorf("handler's state change was not rendered: %v", got)
	}
}

func TestActionHandlerContextThemeIsNilWithoutOne(t *testing.T) {
	if (ActionHandlerContext{}).Theme() != nil {
		t.Error("Theme() without a context should be nil")
	}
	var nilCtx *HypenGlobalContext
	if (ActionHandlerContext{Context: nilCtx}).Theme() != nil {
		t.Error("Theme() with a nil *HypenGlobalContext should be nil")
	}
	if (ActionHandlerContext{Context: NewHypenGlobalContext()}).Theme() != nil {
		t.Error("Theme() with no registered theme should be nil")
	}
}
