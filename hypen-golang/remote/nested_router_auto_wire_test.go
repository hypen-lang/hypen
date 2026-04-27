// Nested-router auto-wiring parity test.
//
// Mirrors hypen-web/tests/nested-router-auto-wire.test.ts. When a
// per-route module's own template contains a `Router { Route ... }`
// block, the auto-wire in session.go must flatten nested routes into
// the session's ManagedRouter alongside top-level ones. Pushing to a
// nested path ("/home/feed") must mirror into the primary module's
// `location` state field.
//
// Regression guard for commit 77fadf05, which lifted a top-level-only
// filter from autoWireManagedRouter. A future refactor of the dedup
// loop or DiscoverRouters parsing could silently re-break nested
// routes; this test fails loudly when that happens.
package remote

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	core "github.com/hypen-space/core"
)

// writeComponents materialises a component tree on disk so
// RemoteServer.Source() can discover it. Each entry becomes
// <dir>/<name>/component.hypen — the same shape the TS test uses.
func writeComponents(t *testing.T, entries map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for name, dsl := range entries {
		sub := filepath.Join(dir, name)
		if err := os.MkdirAll(sub, 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", sub, err)
		}
		if err := os.WriteFile(filepath.Join(sub, "component.hypen"), []byte(dsl), 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	return dir
}

func TestNestedRouterAutoWire_RoutesDeclaredInNestedModuleNavigable(t *testing.T) {
	t.Run("nested route mirrors into primary state.location", func(t *testing.T) {
		core.App.Clear()
		t.Cleanup(func() { core.App.Clear() })

		dir := writeComponents(t, map[string]string{
			"App": `module App {
			  Router {
			    Route(path: "/") { Home() }
			    Route(path: "/settings") { Settings() }
			  }
			}`,
			// Home's own Router is the nested block. Pre-3.4 the
			// auto-wire silently skipped these — the session's
			// ManagedRouter had no entry for "/home/feed", so nav
			// pushed the URL but never mirrored into state.location.
			"Home": `module Home {
			  Column {
			    Text("home-root")
			    Router {
			      Route(path: "/home/feed") { Feed() }
			      Route(path: "/home/explore") { Explore() }
			    }
			  }
			}`,
			"Feed":     `module Feed { Text("feed-body") }`,
			"Explore":  `module Explore { Text("explore-body") }`,
			"Settings": `module Settings { Text("settings-body") }`,
		})

		// Register nested modules in the shared App registry so the
		// session's autoWireManagedRouter can resolve each Route's
		// ElementNames back to a known component.
		core.App.Module("Home").DefineState(map[string]any{}, nil).Build()
		core.App.Module("Feed").DefineState(map[string]any{}, nil).Build()
		core.App.Module("Explore").DefineState(map[string]any{}, nil).Build()
		core.App.Module("Settings").DefineState(map[string]any{}, nil).Build()

		server := NewRemoteServer().
			WithState("App", map[string]any{"location": "/"}).
			Source(dir).
			UI(`module App {
			  Router {
			    Route(path: "/") { Home() }
			    Route(path: "/settings") { Settings() }
			  }
			}`)
		if err := server.Prepare(); err != nil {
			t.Fatalf("Prepare: %v", err)
		}

		transport := NewChannelTransport(32)
		sess, err := server.CreateSession(transport, WithHelloGraceMs(-1))
		if err != nil {
			t.Fatalf("CreateSession: %v", err)
		}
		t.Cleanup(func() { _ = sess.Destroy() })

		hello, _ := json.Marshal(map[string]any{"type": "hello"})
		if err := sess.Receive(hello); err != nil {
			t.Fatalf("Receive hello: %v", err)
		}

		// Wait for initialTree so the engine and ManagedRouter are wired.
		deadline := time.After(5 * time.Second)
	waitReady:
		for {
			select {
			case msg, ok := <-transport.Out():
				if !ok {
					t.Fatal("transport closed before initialTree")
				}
				if msg.GetType() == MessageTypeInitialTree {
					break waitReady
				}
			case <-deadline:
				t.Fatal("timed out waiting for initialTree")
			}
		}

		// Dispatch router.push to the *nested* route. If the auto-wire
		// flattened nested routes correctly, the ManagedRouter matches
		// "/home/feed", HypenRouter fires OnNavigate, and the session's
		// mirror-to-location goroutine writes it back into state.
		push, _ := json.Marshal(map[string]any{
			"type":    "dispatchAction",
			"action":  "router.push",
			"payload": map[string]any{"to": "/home/feed"},
		})
		if err := sess.Receive(push); err != nil {
			t.Fatalf("Receive dispatchAction: %v", err)
		}

		// The mirror runs on a goroutine — poll briefly.
		var got string
		pollDeadline := time.Now().Add(3 * time.Second)
		for time.Now().Before(pollDeadline) {
			state := sess.State()
			if loc, ok := state["location"].(string); ok && loc == "/home/feed" {
				got = loc
				break
			}
			time.Sleep(25 * time.Millisecond)
		}
		if got != "/home/feed" {
			t.Fatalf("state.location = %q, want %q (nested route auto-wire regressed)",
				sess.State()["location"], "/home/feed")
		}
	})

	t.Run("top-level route still works alongside nested routes", func(t *testing.T) {
		core.App.Clear()
		t.Cleanup(func() { core.App.Clear() })

		dir := writeComponents(t, map[string]string{
			"App": `module App {
			  Router {
			    Route(path: "/") { Home() }
			    Route(path: "/settings") { Settings() }
			  }
			}`,
			"Home": `module Home {
			  Router {
			    Route(path: "/home/feed") { Feed() }
			  }
			}`,
			"Feed":     `module Feed { Text("feed") }`,
			"Settings": `module Settings { Text("settings") }`,
		})

		core.App.Module("Home").DefineState(map[string]any{}, nil).Build()
		core.App.Module("Feed").DefineState(map[string]any{}, nil).Build()
		core.App.Module("Settings").DefineState(map[string]any{}, nil).Build()

		server := NewRemoteServer().
			WithState("App", map[string]any{"location": "/"}).
			Source(dir).
			UI(`module App {
			  Router {
			    Route(path: "/") { Home() }
			    Route(path: "/settings") { Settings() }
			  }
			}`)
		if err := server.Prepare(); err != nil {
			t.Fatalf("Prepare: %v", err)
		}

		transport := NewChannelTransport(32)
		sess, err := server.CreateSession(transport, WithHelloGraceMs(-1))
		if err != nil {
			t.Fatalf("CreateSession: %v", err)
		}
		t.Cleanup(func() { _ = sess.Destroy() })

		hello, _ := json.Marshal(map[string]any{"type": "hello"})
		if err := sess.Receive(hello); err != nil {
			t.Fatalf("Receive hello: %v", err)
		}

		deadline := time.After(5 * time.Second)
	waitReady2:
		for {
			select {
			case msg, ok := <-transport.Out():
				if !ok {
					t.Fatal("transport closed before initialTree")
				}
				if msg.GetType() == MessageTypeInitialTree {
					break waitReady2
				}
			case <-deadline:
				t.Fatal("timed out waiting for initialTree")
			}
		}

		push, _ := json.Marshal(map[string]any{
			"type":    "dispatchAction",
			"action":  "router.push",
			"payload": map[string]any{"to": "/settings"},
		})
		if err := sess.Receive(push); err != nil {
			t.Fatalf("Receive dispatchAction: %v", err)
		}

		var got string
		pollDeadline := time.Now().Add(3 * time.Second)
		for time.Now().Before(pollDeadline) {
			state := sess.State()
			if loc, ok := state["location"].(string); ok && loc == "/settings" {
				got = loc
				break
			}
			time.Sleep(25 * time.Millisecond)
		}
		if got != "/settings" {
			t.Fatalf("state.location = %q, want %q", sess.State()["location"], "/settings")
		}
	})
}

// Regression guard for P2-A. Before this fix the auto-wire created a
// fresh HypenGlobalContext but never registered the primary module
// instance, so `context.GetModule("<primaryScope>")` always returned
// nil from a routed module's action handler. Routed modules that
// needed to read app-level state (e.g. `currentUser`) were silently
// broken under Go even though TS and Kotlin both register the primary.
func TestAutoWire_PrimaryIsVisibleToRoutedModules(t *testing.T) {
	core.App.Clear()
	t.Cleanup(func() { core.App.Clear() })

	dir := writeComponents(t, map[string]string{
		"App":  `module App { Router { Route(path: "/") { Home() } } }`,
		"Home": `module Home { Text("home-root") }`,
	})

	// The probe sits on Home's `checkApp` action. Its handler
	// records whether the auto-wired GlobalContext returned a non-nil
	// reference for the primary — and whether the snapshot state
	// carries the known sentinel value.
	type probeResult struct {
		saw          bool
		userSentinel string
	}
	result := &probeResult{}

	core.App.Module("Home").
		DefineState(map[string]any{}, nil).
		OnAction("checkApp", func(ctx core.ActionHandlerContext) {
			if ctx.Context == nil {
				return
			}
			ref := ctx.Context.GetModule("app")
			if ref == nil {
				return
			}
			result.saw = true
			state := ref.GetState()
			if v, ok := state["currentUser"].(string); ok {
				result.userSentinel = v
			}
		}).
		Build()

	// Build an App definition so `s.host.Definition()` returns
	// non-nil — the auto-wire's primary-instance registration requires
	// a definition to hang the wrapper off.
	appDef := core.App.Module("App").
		DefineState(map[string]any{
			"location":    "/",
			"currentUser": "alice",
		}, nil).
		Build()

	server := NewRemoteServer().
		WithDefinition(appDef).
		Source(dir).
		UI(`module App { Router { Route(path: "/") { Home() } } }`)
	if err := server.Prepare(); err != nil {
		t.Fatalf("Prepare: %v", err)
	}

	transport := NewChannelTransport(32)
	sess, err := server.CreateSession(transport, WithHelloGraceMs(-1))
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	t.Cleanup(func() { _ = sess.Destroy() })

	hello, _ := json.Marshal(map[string]any{"type": "hello"})
	if err := sess.Receive(hello); err != nil {
		t.Fatalf("Receive hello: %v", err)
	}

	deadline := time.After(5 * time.Second)
waitReady:
	for {
		select {
		case msg, ok := <-transport.Out():
			if !ok {
				t.Fatal("transport closed before initialTree")
			}
			if msg.GetType() == MessageTypeInitialTree {
				break waitReady
			}
		case <-deadline:
			t.Fatal("timed out waiting for initialTree")
		}
	}

	// Home is mounted at "/" by the auto-router's initial mount, so
	// the probe action is reachable via its scoped name.
	probe, _ := json.Marshal(map[string]any{
		"type":    "dispatchAction",
		"module":  "Home",
		"action":  "checkApp",
		"payload": map[string]any{},
	})
	if err := sess.Receive(probe); err != nil {
		t.Fatalf("Receive checkApp: %v", err)
	}

	// Give the dispatch a moment — handler is synchronous but the
	// transport write is goroutine-scheduled.
	pollDeadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(pollDeadline) {
		if result.saw {
			break
		}
		time.Sleep(25 * time.Millisecond)
	}

	if !result.saw {
		t.Fatal("context.GetModule(\"app\") returned nil from a routed module — " +
			"primary was not registered in the auto-wire GlobalContext (P2-A regressed).")
	}
	if result.userSentinel != "alice" {
		t.Fatalf("primary snapshot missing sentinel: got currentUser=%q, want %q",
			result.userSentinel, "alice")
	}
}

// Regression guard for P1-A. The primary template declares no
// "/home/feed" route — the nested route lives ONLY in Home's child
// template. Pre-fix, autoWireManagedRouter ran DiscoverRouters on
// s.host.UI() alone and never saw the nested block; navigating to
// "/home/feed" would mirror into state.location (HypenRouter.push
// unconditionally notifies) but Feed was never mounted by the
// ManagedRouter, so dispatching Feed's "probe" action would find no
// registered handler. This test proves Feed is actually mounted by
// firing its handler after a nested push.
func TestNestedRouterAutoWire_NestedRouterInChildTemplate(t *testing.T) {
	core.App.Clear()
	t.Cleanup(func() { core.App.Clear() })

	dir := writeComponents(t, map[string]string{
		// Primary declares only "/" -> Home. No "/home/feed" here.
		"App": `module App {
		  Router {
		    Route(path: "/") { Home() }
		  }
		}`,
		// Nested Router lives ONLY in the child template. Auto-wire
		// must iterate discovered child sources to find it.
		"Home": `module Home {
		  Column {
		    Text("home-root")
		    Router {
		      Route(path: "/home/feed") { Feed() }
		    }
		  }
		}`,
		"Feed": `module Feed { Text("feed-body") }`,
	})

	type probeResult struct {
		fired bool
	}
	result := &probeResult{}

	core.App.Module("Home").DefineState(map[string]any{}, nil).Build()
	// Feed's probe handler. If ManagedRouter never mounted Feed,
	// dispatchAction{module:"Feed",action:"probe"} will find no
	// registered handler and result.fired stays false.
	core.App.Module("Feed").
		DefineState(map[string]any{}, nil).
		OnAction("probe", func(ctx core.ActionHandlerContext) {
			result.fired = true
		}).
		Build()

	appDef := core.App.Module("App").
		DefineState(map[string]any{"location": "/"}, nil).
		Build()

	primaryUI := `module App {
	  Router {
	    Route(path: "/") { Home() }
	  }
	}`

	server := NewRemoteServer().
		WithDefinition(appDef).
		Source(dir).
		UI(primaryUI)
	if err := server.Prepare(); err != nil {
		t.Fatalf("Prepare: %v", err)
	}

	transport := NewChannelTransport(32)
	sess, err := server.CreateSession(transport, WithHelloGraceMs(-1))
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	t.Cleanup(func() { _ = sess.Destroy() })

	hello, _ := json.Marshal(map[string]any{"type": "hello"})
	if err := sess.Receive(hello); err != nil {
		t.Fatalf("Receive hello: %v", err)
	}

	deadline := time.After(5 * time.Second)
waitReady:
	for {
		select {
		case msg, ok := <-transport.Out():
			if !ok {
				t.Fatal("transport closed before initialTree")
			}
			if msg.GetType() == MessageTypeInitialTree {
				break waitReady
			}
		case <-deadline:
			t.Fatal("timed out waiting for initialTree")
		}
	}

	// Navigate to the nested route. ManagedRouter should mount Feed.
	push, _ := json.Marshal(map[string]any{
		"type":    "dispatchAction",
		"action":  "router.push",
		"payload": map[string]any{"to": "/home/feed"},
	})
	if err := sess.Receive(push); err != nil {
		t.Fatalf("Receive router.push: %v", err)
	}

	// Give ManagedRouter's async mount a beat to settle before probing.
	time.Sleep(50 * time.Millisecond)

	probe, _ := json.Marshal(map[string]any{
		"type":    "dispatchAction",
		"module":  "Feed",
		"action":  "probe",
		"payload": map[string]any{},
	})
	if err := sess.Receive(probe); err != nil {
		t.Fatalf("Receive probe: %v", err)
	}

	pollDeadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(pollDeadline) {
		if result.fired {
			break
		}
		time.Sleep(25 * time.Millisecond)
	}

	if !result.fired {
		t.Fatal("Feed.probe handler never fired — nested Router declared in child " +
			"template was not discovered by autoWireManagedRouter (P1-A regressed).")
	}
}
