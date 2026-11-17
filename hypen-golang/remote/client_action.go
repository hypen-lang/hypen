package remote

// Admission of actions received from a remote client.
//
// A Remote UI client is a thin renderer on someone else's device: whatever
// it puts in a `dispatchAction` message is untrusted. The engine's
// DispatchAction is the same-trust-domain entry — it runs a registered
// `__hypen_scoped:<scope>:<name>` as given, a bare name one module handles,
// and a bare `__hypen_bind` to an arbitrary state path — so wire input never
// goes to it directly. It is admitted here first (the Go port of
// hypen-web/packages/core/src/remote/client-action.ts):
//
//   - a `__hypen_dispatch` envelope is authorised by the engine's client
//     entry (WasmEngine.DispatchClientAction): the addressed node must be
//     live, attached, and itself declare the action (`.onClick(@actions.x)`,
//     `.bind(...)` for the reserved writes);
//   - every other `__hypen_*` name (a pre-scoped name, a bare reserved
//     write) is refused;
//   - a bare application name is refused unless the server listed it with
//     RemoteServer.AllowUnboundClientActions (or accepts any with
//     AllowAnyUnboundClientActions) — the escape hatch for actions a client
//     legitimately sends with no node behind it (a web client's
//     `navigation.backAction`, a custom client's command). The four router
//     actions are always admitted: navigation is bounded by the route
//     table, and URL sync sends them.

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
)

const (
	clientReservedPrefix = "__hypen_"
	clientScopedPrefix   = "__hypen_scoped:"
)

// routerClientActions are the bare names a client may always send.
var routerClientActions = map[string]bool{
	"router.push":    true,
	"router.replace": true,
	"router.back":    true,
	"router.forward": true,
}

// UnboundClientActions is a server's policy for bare action names a client
// sends with no node behind them. The zero value is strict: only the four
// `router.*` actions are accepted by name. Names lists further accepted
// names; Any accepts every application name (any name exactly one module
// handles — the pre-admission behaviour). Neither ever admits a `__hypen_*`
// name outside an envelope.
type UnboundClientActions struct {
	Any   bool
	Names []string
}

// UnboundClientActionsHost is implemented by SessionHosts that carry an
// unbound-client-action policy (RemoteServer.AllowUnboundClientActions).
// Optional, so other SessionHost implementations keep compiling; a host
// without it is strict.
type UnboundClientActionsHost interface {
	UnboundClientActions() UnboundClientActions
}

// ClientActionRefusedError is a client action the server will not run. It
// never reaches a handler; the session logs it and drops the message.
type ClientActionRefusedError struct {
	Action string
	Reason string
}

func (e *ClientActionRefusedError) Error() string {
	return fmt.Sprintf("client action %q refused (%s)", e.Action, e.Reason)
}

// admitUnboundClientAction reports whether a non-envelope name from the wire
// may be dispatched as given, or why not.
func admitUnboundClientAction(name string, policy UnboundClientActions) error {
	if name == "" {
		return &ClientActionRefusedError{Action: name, Reason: "malformed action name"}
	}
	if strings.HasPrefix(name, clientScopedPrefix) {
		return &ClientActionRefusedError{Action: name, Reason: "pre-scoped name"}
	}
	if strings.HasPrefix(name, clientReservedPrefix) {
		return &ClientActionRefusedError{Action: name, Reason: "reserved name outside an envelope"}
	}
	if routerClientActions[name] || policy.Any {
		return nil
	}
	for _, allowed := range policy.Names {
		if allowed == name {
			return nil
		}
	}
	return &ClientActionRefusedError{
		Action: name,
		Reason: "not sent from a node that declares it; list it with AllowUnboundClientActions to accept it by name",
	}
}

// envelopeInnerAction is the `action` an envelope names, for log lines.
func envelopeInnerAction(payload any) string {
	if env, ok := payload.(map[string]any); ok {
		if inner, ok := env["action"].(string); ok && inner != "" {
			return inner
		}
	}
	return uiActionEnvelope
}

// templateActionRef matches an `@actions.<name>` reference in DSL source.
var templateActionRef = regexp.MustCompile(`@actions\.([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)`)

// templateActionNames lists the `@actions.<name>` references in the given
// DSL sources, sorted and deduplicated. The legacy map-style OnAction shim
// registers no per-action handlers, so the session registers one shim
// handler per referenced name: the engine's client entry only resolves an
// envelope to an action that has a handler. Over-matching (a reference in a
// comment) is harmless — the client entry still requires the addressed node
// to carry the binding — and a name read from the server's own templates
// never comes from the client.
func templateActionNames(sources ...string) []string {
	seen := map[string]bool{}
	for _, src := range sources {
		for _, m := range templateActionRef.FindAllStringSubmatch(src, -1) {
			name := m[1]
			if strings.HasPrefix(name, clientReservedPrefix) {
				continue
			}
			seen[name] = true
		}
	}
	out := make([]string, 0, len(seen))
	for name := range seen {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}
