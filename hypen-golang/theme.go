package core

import (
	"fmt"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"sync"
)

// Theming and design tokens for Hypen apps.
//
// One Theme per app (one fork per session for Remote UI) owns the design
// tokens and the active color scheme, and publishes them to the engine as
// two data-source contexts:
//
//   - `theme`      — the resolved tokens: the base set with the active
//                    scheme's overrides merged on top. Templates read
//                    `.color(@theme.color.primary)`,
//                    `.padding(@theme.space.md)`, `Text("@{theme.font.body}")`.
//   - `appearance` — `{ scheme, preference, system, schemes }`, read as
//                    `@appearance.scheme` (e.g. to pick an icon).
//
// Switching scheme (SetScheme) pushes a new `theme` context; the engine
// diffs it against the previous one and re-renders only the nodes bound to
// tokens whose value actually changed.
//
// A token value may be an alias of another token, written
// `"{color.blue.500}"` (the whole string). Aliases are resolved after the
// scheme merge, so a semantic token defined once in the base set
// (`primary: "{color.brand}"`) follows a scheme that overrides
// `color.brand`.

const (
	// ThemeTokensProvider is the reserved data-source context carrying the
	// resolved tokens.
	ThemeTokensProvider = "theme"
	// ThemeMetaProvider is the reserved data-source context carrying
	// ThemeMeta (`{ scheme, preference, … }`).
	ThemeMetaProvider = "appearance"
	// SystemScheme is the preference that follows the platform's color
	// scheme.
	SystemScheme = "system"
	// SchemeLight and SchemeDark are the schemes a platform can report.
	SchemeLight = "light"
	SchemeDark  = "dark"
)

var logTheme = NewLogger("Theme")

// Tokens is a (possibly nested) set of design tokens: each value is a
// string, a number, a bool, or a nested Tokens group.
type Tokens = map[string]any

// ThemeOptions configures NewTheme.
type ThemeOptions struct {
	// Tokens shared by every scheme.
	Tokens Tokens
	// Schemes holds per-scheme overrides, merged over Tokens while that
	// scheme is active. "light" and "dark" are what "system" resolves to;
	// any other name is a scheme selected explicitly with SetScheme.
	Schemes map[string]Tokens
	// Scheme is the scheme to use: a scheme name, or "system" to follow
	// the platform. Defaults to "system".
	Scheme string
	// SystemScheme is what "system" resolves to until the platform reports
	// otherwise (SetSystemScheme): "light" or "dark". Defaults to "light".
	SystemScheme string
	// OnMissingToken is called the first time each missing token is looked
	// up via Token.
	OnMissingToken func(path, scheme string)
}

// ThemeMeta is the snapshot published as the `appearance` data source.
type ThemeMeta struct {
	// Scheme is the scheme in effect (never "system").
	Scheme string `json:"scheme"`
	// Preference is what was asked for: a scheme name or "system".
	Preference string `json:"preference"`
	// System is the platform's scheme as last reported.
	System string `json:"system"`
	// Schemes lists, sorted, the scheme names that have overrides defined.
	Schemes []string `json:"schemes"`
}

// ThemeChangeListener hears about scheme and token changes.
type ThemeChangeListener func(meta ThemeMeta)

// ContextEngine is the part of an engine a Theme publishes to. *WasmEngine
// implements it.
type ContextEngine interface {
	SetContext(name string, data any) ([]Patch, error)
}

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

var (
	// Segments a template reference (`@theme.a.b`) can address.
	themeReferenceableKey = regexp.MustCompile(`^[A-Za-z0-9_]+$`)
	themeAlias            = regexp.MustCompile(`^\{([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)\}$`)
)

// Longest alias chain followed before giving up (a cycle is reported earlier).
const themeMaxAliasDepth = 32

// normalizeTokens deep-copies tokens, turning every string-keyed map (a
// literal such as map[string]string included) into a Tokens group, so the
// theme never shares maps with its caller.
func normalizeTokens(tokens Tokens) Tokens {
	out := make(Tokens, len(tokens))
	for k, v := range tokens {
		out[k] = normalizeTokenValue(v)
	}
	return out
}

func normalizeTokenValue(v any) any {
	if m, ok := v.(map[string]any); ok {
		return normalizeTokens(m)
	}
	rv := reflect.ValueOf(v)
	if rv.Kind() == reflect.Map && rv.Type().Key().Kind() == reflect.String {
		out := make(Tokens, rv.Len())
		for it := rv.MapRange(); it.Next(); {
			out[it.Key().String()] = normalizeTokenValue(it.Value().Interface())
		}
		return out
	}
	return v
}

// mergeTokens deep-merges primary over fallback into a new map.
func mergeTokens(fallback, primary Tokens) Tokens {
	out := make(Tokens, len(fallback)+len(primary))
	for _, src := range []Tokens{fallback, primary} {
		for k, v := range src {
			group, ok := v.(Tokens)
			if !ok {
				out[k] = v
				continue
			}
			existing, _ := out[k].(Tokens)
			out[k] = mergeTokens(existing, group)
		}
	}
	return out
}

func lookupToken(tokens Tokens, path string) (any, bool) {
	var cur any = tokens
	for _, seg := range strings.Split(path, ".") {
		group, ok := cur.(Tokens)
		if !ok {
			return nil, false
		}
		cur = group[seg]
	}
	return cur, cur != nil
}

func sortedTokenKeys(tokens Tokens) []string {
	keys := make([]string, 0, len(tokens))
	for k := range tokens {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// ResolveTokenAliases returns a copy of tokens with every `"{path}"` alias
// replaced by the value it points at (a leaf or a whole group). An alias
// that is missing or part of a cycle is reported through report (which may
// be nil) and left as written. Keys are visited in sorted order, so the
// problems come out in a stable order.
func ResolveTokenAliases(tokens Tokens, report func(problem string)) Tokens {
	if report == nil {
		report = func(string) {}
	}

	follow := func(value any, at string) any {
		seen := []string{at}
		cur := value
		for depth := 0; depth < themeMaxAliasDepth; depth++ {
			s, isString := cur.(string)
			if !isString {
				return cur
			}
			match := themeAlias.FindStringSubmatch(s)
			if match == nil {
				return cur
			}
			target := match[1]
			cyclic := strings.HasPrefix(at, target+".")
			for _, visited := range seen {
				cyclic = cyclic || visited == target
			}
			if cyclic {
				report("Token alias cycle: " + strings.Join(append(seen, target), " -> "))
				return value
			}
			next, ok := lookupToken(tokens, target)
			if !ok {
				report(fmt.Sprintf("Token %q aliases %q, which is not defined", at, target))
				return value
			}
			seen = append(seen, target)
			cur = next
		}
		report(fmt.Sprintf("Token %q has an alias chain longer than %d", at, themeMaxAliasDepth))
		return value
	}

	var walk func(group Tokens, prefix string, depth int) Tokens
	walk = func(group Tokens, prefix string, depth int) Tokens {
		out := make(Tokens, len(group))
		for _, k := range sortedTokenKeys(group) {
			v := group[k]
			at := k
			if prefix != "" {
				at = prefix + "." + k
			}
			resolved := v
			if _, isGroup := v.(Tokens); !isGroup {
				resolved = follow(v, at)
			}
			// A group reached through an alias can itself hold aliases (and
			// could alias back into its own parent), hence the depth bound.
			if sub, isGroup := resolved.(Tokens); isGroup && depth < themeMaxAliasDepth {
				resolved = walk(sub, at, depth+1)
			}
			out[k] = resolved
		}
		return out
	}
	return walk(tokens, "", 0)
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

// themeStore is the token set a Theme and its forks share.
type themeStore struct {
	mu      sync.RWMutex
	base    Tokens
	schemes map[string]Tokens
}

func (s *themeStore) schemeNames() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	names := make([]string, 0, len(s.schemes))
	for name := range s.schemes {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// selectable lists the scheme names SetScheme accepts besides "system".
func (s *themeStore) selectable() []string {
	names := []string{SchemeLight, SchemeDark}
	for _, name := range s.schemeNames() {
		if name != SchemeLight && name != SchemeDark {
			names = append(names, name)
		}
	}
	return names
}

func (s *themeStore) isSelectable(preference string) bool {
	if preference == SystemScheme {
		return true
	}
	for _, name := range s.selectable() {
		if name == preference {
			return true
		}
	}
	return false
}

type themeEngineEntry struct {
	id     uint64
	engine ContextEngine
}

type themeListenerEntry struct {
	id       uint64
	listener ThemeChangeListener
}

// Theme owns design tokens and the active color scheme and publishes them
// to the engines it is attached to. Create one with NewTheme. All methods
// are safe for concurrent use.
//
// Publishing is synchronous: SetScheme, Toggle, SetSystemScheme and Extend
// return once every attached engine has re-rendered. They may be called
// from action and lifecycle handlers (handlers run outside the engine's
// lock), but not from an engine patch callback or a ThemeChangeListener's
// own engine callback — the same rule as for state updates.
type Theme struct {
	store          *themeStore
	onMissingToken func(path, scheme string)

	// publishMu serialises engine publishes so engines always end on the
	// latest snapshot. Never taken while mu is held.
	publishMu sync.Mutex

	mu         sync.RWMutex
	preference string
	system     string
	resolved   Tokens
	problems   []string
	warned     map[string]bool
	engines    []themeEngineEntry
	listeners  []themeListenerEntry
	nextID     uint64
}

// NewTheme creates the app's theme. Attach it to the engine before the
// first render (Theme.Attach), or register it on a remote server so every
// session gets its own fork.
func NewTheme(options ThemeOptions) *Theme {
	store := &themeStore{
		base:    normalizeTokens(options.Tokens),
		schemes: make(map[string]Tokens, len(options.Schemes)),
	}
	for name, tokens := range options.Schemes {
		store.schemes[name] = normalizeTokens(tokens)
	}
	t := newThemeOnStore(store, options.Scheme, options.SystemScheme, options.OnMissingToken)
	t.warnUnreferenceableKeys(store.base, "")
	for _, name := range store.schemeNames() {
		t.warnUnreferenceableKeys(store.schemes[name], "")
	}
	return t
}

func newThemeOnStore(store *themeStore, scheme, system string, onMissing func(path, scheme string)) *Theme {
	t := &Theme{
		store:          store,
		onMissingToken: onMissing,
		preference:     SystemScheme,
		system:         SchemeLight,
		warned:         make(map[string]bool),
	}
	switch system {
	case "", SchemeLight:
	case SchemeDark:
		t.system = SchemeDark
	default:
		logTheme.Warn("Unknown system color scheme %q; assuming %q", system, SchemeLight)
	}
	if scheme != "" {
		if store.isSelectable(scheme) {
			t.preference = scheme
		} else {
			logTheme.Warn("Unknown color scheme %q; following the system scheme", scheme)
		}
	}
	t.rebuildLocked()
	return t
}

// Scheme returns the scheme in effect: the preference, or the system
// scheme when the preference is "system".
func (t *Theme) Scheme() string {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return t.schemeLocked()
}

// Preference returns what was asked for: a scheme name or "system".
func (t *Theme) Preference() string {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return t.preference
}

// SystemScheme returns the platform's scheme as last reported.
func (t *Theme) SystemScheme() string {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return t.system
}

// Schemes returns, sorted, the scheme names that have overrides defined.
func (t *Theme) Schemes() []string {
	return t.store.schemeNames()
}

// Meta returns the `appearance` data-source payload.
func (t *Theme) Meta() ThemeMeta {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return t.metaLocked()
}

// Tokens returns the resolved tokens currently published as `theme`. The
// returned map is shared: treat it as read-only.
func (t *Theme) Tokens() Tokens {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return t.resolved
}

// Problems returns the alias problems (missing target, cycle) in the active
// scheme's tokens.
func (t *Theme) Problems() []string {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return append([]string{}, t.problems...)
}

// SetScheme selects a scheme by name, or "system" to follow the platform,
// then republishes to every attached engine. It returns an error for a
// name that is neither "light" / "dark" / "system" nor defined in Schemes.
func (t *Theme) SetScheme(preference string) error {
	if !t.store.isSelectable(preference) {
		known := append([]string{SystemScheme}, t.store.selectable()...)
		return fmt.Errorf("unknown color scheme %q (known: %s)", preference, strings.Join(known, ", "))
	}
	t.mu.Lock()
	if preference == t.preference {
		t.mu.Unlock()
		return nil
	}
	before := t.schemeLocked()
	t.preference = preference
	if t.schemeLocked() != before {
		t.rebuildLocked()
	}
	meta := t.metaLocked()
	t.mu.Unlock()
	t.changed(meta)
	return nil
}

// Toggle flips between "light" and "dark", starting from whichever is in
// effect.
func (t *Theme) Toggle() {
	next := SchemeDark
	if t.Scheme() == SchemeDark {
		next = SchemeLight
	}
	_ = t.SetScheme(next) // light and dark are always selectable
}

// SetSystemScheme reports the platform's scheme ("light" or "dark"). It
// takes effect immediately when the preference is "system"; otherwise it
// is remembered for when it is.
func (t *Theme) SetSystemScheme(scheme string) error {
	if scheme != SchemeLight && scheme != SchemeDark {
		return fmt.Errorf("unknown system color scheme %q (known: %s, %s)", scheme, SchemeLight, SchemeDark)
	}
	t.mu.Lock()
	if scheme == t.system {
		t.mu.Unlock()
		return nil
	}
	before := t.schemeLocked()
	t.system = scheme
	if t.schemeLocked() != before {
		t.rebuildLocked()
	}
	meta := t.metaLocked()
	t.mu.Unlock()
	t.changed(meta)
	return nil
}

// Extend merges more tokens in — into the base set when scheme is "", or
// into that scheme's overrides — and republishes. This is how a component
// package contributes defaults. Forks share the tokens and pick the change
// up the next time their own scheme changes.
func (t *Theme) Extend(tokens Tokens, scheme string) {
	tokens = normalizeTokens(tokens)

	t.store.mu.Lock()
	if scheme == "" {
		t.store.base = mergeTokens(t.store.base, tokens)
	} else {
		t.store.schemes[scheme] = mergeTokens(t.store.schemes[scheme], tokens)
	}
	t.store.mu.Unlock()

	t.mu.Lock()
	t.warnUnreferenceableKeysLocked(tokens, "")
	if scheme != "" && scheme != t.schemeLocked() {
		t.mu.Unlock()
		return
	}
	t.rebuildLocked()
	meta := t.metaLocked()
	t.mu.Unlock()
	t.changed(meta)
}

// Has reports whether path resolves in the active scheme.
func (t *Theme) Has(path string) bool {
	t.mu.RLock()
	defer t.mu.RUnlock()
	_, ok := lookupToken(t.resolved, path)
	return ok
}

// Token returns a token's value in the active scheme (a leaf or a whole
// Tokens group), for use in handlers. A missing token returns (nil, false)
// and, the first time, logs a warning and calls OnMissingToken.
func (t *Theme) Token(path string) (any, bool) {
	t.mu.RLock()
	value, ok := lookupToken(t.resolved, path)
	t.mu.RUnlock()
	if ok {
		return value, true
	}

	t.mu.Lock()
	key := "missing:" + path
	first := !t.warned[key]
	t.warned[key] = true
	scheme := t.schemeLocked()
	t.mu.Unlock()
	if first {
		logTheme.Warn("Missing theme token %q for scheme %q", path, scheme)
		if t.onMissingToken != nil {
			t.onMissingToken(path, scheme)
		}
	}
	return nil, false
}

// Attach publishes `theme` and `appearance` to engine now and on every
// change. The returned function stops publishing (it does not remove the
// contexts). Attach before the first render so `@theme.*` resolves in it.
func (t *Theme) Attach(engine ContextEngine) (detach func()) {
	t.publishMu.Lock()
	t.mu.Lock()
	t.nextID++
	id := t.nextID
	t.engines = append(t.engines, themeEngineEntry{id: id, engine: engine})
	meta, tokens := t.metaLocked(), t.resolved
	t.mu.Unlock()
	publishTheme(engine, meta, tokens)
	t.publishMu.Unlock()

	return func() {
		t.mu.Lock()
		defer t.mu.Unlock()
		for i, entry := range t.engines {
			if entry.id == id {
				t.engines = append(t.engines[:i:i], t.engines[i+1:]...)
				return
			}
		}
	}
}

// OnChange registers a listener for scheme and token changes, called after
// the attached engines have been updated. The returned function
// unsubscribes it.
func (t *Theme) OnChange(listener ThemeChangeListener) (unsubscribe func()) {
	t.mu.Lock()
	t.nextID++
	id := t.nextID
	t.listeners = append(t.listeners, themeListenerEntry{id: id, listener: listener})
	t.mu.Unlock()

	return func() {
		t.mu.Lock()
		defer t.mu.Unlock()
		for i, entry := range t.listeners {
			if entry.id == id {
				t.listeners = append(t.listeners[:i:i], t.listeners[i+1:]...)
				return
			}
		}
	}
}

// Fork returns a new Theme with its own scheme preference that shares this
// one's tokens — one per Remote UI session. An empty preference inherits
// this theme's. The fork starts with no engines and no listeners.
func (t *Theme) Fork(preference string) *Theme {
	t.mu.RLock()
	if preference == "" {
		preference = t.preference
	}
	system := t.system
	t.mu.RUnlock()
	return newThemeOnStore(t.store, preference, system, t.onMissingToken)
}

// ── internals ─────────────────────────────────────────────────────────────

func (t *Theme) schemeLocked() string {
	if t.preference == SystemScheme {
		return t.system
	}
	return t.preference
}

func (t *Theme) metaLocked() ThemeMeta {
	return ThemeMeta{
		Scheme:     t.schemeLocked(),
		Preference: t.preference,
		System:     t.system,
		Schemes:    t.store.schemeNames(),
	}
}

// rebuildLocked recomputes the resolved tokens for the scheme in effect.
// The caller holds t.mu (or is still constructing t).
func (t *Theme) rebuildLocked() {
	t.store.mu.RLock()
	merged := t.store.base
	if overrides, ok := t.store.schemes[t.schemeLocked()]; ok {
		merged = mergeTokens(merged, overrides)
	}
	t.store.mu.RUnlock()

	t.problems = nil
	t.resolved = ResolveTokenAliases(merged, func(problem string) {
		t.problems = append(t.problems, problem)
		if !t.warned[problem] {
			t.warned[problem] = true
			logTheme.Warn("%s", problem)
		}
	})
}

func (t *Theme) warnUnreferenceableKeys(tokens Tokens, prefix string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.warnUnreferenceableKeysLocked(tokens, prefix)
}

func (t *Theme) warnUnreferenceableKeysLocked(tokens Tokens, prefix string) {
	for _, k := range sortedTokenKeys(tokens) {
		at := k
		if prefix != "" {
			at = prefix + "." + k
		}
		if !themeReferenceableKey.MatchString(k) && !t.warned[at] {
			t.warned[at] = true
			logTheme.Warn("Token key %q cannot be referenced from a template; use letters, digits and \"_\" only", at)
		}
		if group, ok := tokens[k].(Tokens); ok {
			t.warnUnreferenceableKeysLocked(group, at)
		}
	}
}

func publishTheme(engine ContextEngine, meta ThemeMeta, tokens Tokens) {
	if _, err := engine.SetContext(ThemeMetaProvider, meta); err != nil {
		logTheme.Error("Failed to publish %s context: %v", ThemeMetaProvider, err)
	}
	if _, err := engine.SetContext(ThemeTokensProvider, tokens); err != nil {
		logTheme.Error("Failed to publish %s context: %v", ThemeTokensProvider, err)
	}
}

// changed publishes the current snapshot to every attached engine, then
// tells the listeners about meta. Called without t.mu held, so engines and
// listeners may read the theme. The snapshot is taken under publishMu:
// when changes race, the last publish carries the newest state.
func (t *Theme) changed(meta ThemeMeta) {
	t.publishMu.Lock()
	t.mu.RLock()
	engines := append([]themeEngineEntry(nil), t.engines...)
	current, tokens := t.metaLocked(), t.resolved
	t.mu.RUnlock()
	for _, entry := range engines {
		publishTheme(entry.engine, current, tokens)
	}
	t.publishMu.Unlock()

	t.mu.RLock()
	listeners := append([]themeListenerEntry(nil), t.listeners...)
	t.mu.RUnlock()
	for _, entry := range listeners {
		func() {
			defer func() {
				if r := recover(); r != nil {
					logTheme.Error("Theme change listener panicked: %v", r)
				}
			}()
			entry.listener(meta)
		}()
	}
}

// themeOf returns ctx's theme, tolerating a nil context.
func themeOf(ctx GlobalContext) *Theme {
	if ctx == nil {
		return nil
	}
	if v := reflect.ValueOf(ctx); v.Kind() == reflect.Pointer && v.IsNil() {
		return nil
	}
	return ctx.GetTheme()
}
