// Router-app demonstrates multi-page routing with ManagedRouter:
// automatic module mount/unmount, persisted modules, route params,
// and cross-module events — each page expressed as a typed NewApp[T]
// module with its own .UI() template.
package main

import (
	"fmt"
	"log"

	core "github.com/hypen-space/core"
)

// ── Per-page state structs ───────────────────────────────────────────

type HomeState struct {
	Visits int `json:"visits"`
}

type ProfileState struct {
	UserID string `json:"userId"`
	Bio    string `json:"bio"`
}

type SettingsState struct {
	Theme    string `json:"theme"`
	Language string `json:"language"`
}

func main() {
	engine, err := core.NewDefaultEngine()
	if err != nil {
		log.Fatal(err)
	}
	defer func() {
		if closer, ok := any(engine).(interface{ Close() error }); ok {
			closer.Close()
		}
	}()

	app := &core.HypenApp{}
	ctx := core.NewHypenGlobalContext()
	router := core.NewHypenRouter()

	// ── Page modules ─────────────────────────────────────────────────

	homeDef := core.NewApp(
		HomeState{Visits: 0},
		&core.ModuleOptions{Name: "Home", Persist: core.BoolPtr(true)},
	).
		OnAction("recordVisit", func(ctx core.TypedActionContext[HomeState]) {
			ctx.State.Visits++
		}).
		UI(`
			Column {
				Text("Home").fontSize(32).fontWeight("bold")
				Text("Visits: @{state.visits}")
				Button("@actions.recordVisit") { Text("Record visit") }
			}
		`)
	app.Register("Home", homeDef)

	profileDef := core.NewApp(
		ProfileState{},
		&core.ModuleOptions{Name: "Profile"},
	).
		OnAction("loadProfile", func(ctx core.TypedActionContext[ProfileState]) {
			if m, ok := ctx.Action.Payload.(map[string]any); ok {
				if id, ok := m["id"].(string); ok {
					ctx.State.UserID = id
					ctx.State.Bio = fmt.Sprintf("Bio for user %s", id)
				}
			}
		}).
		OnAction("goHome", func(ctx core.TypedActionContext[ProfileState]) {
			if ctx.Context != nil {
				if r := ctx.Context.GetRouter(); r != nil {
					r.Push("/")
				}
			}
		}).
		UI(`
			Column {
				Text("Profile: @{state.userId}").fontSize(32).fontWeight("bold")
				Text("@{state.bio}")
				Button("@actions.goHome") { Text("Back to Home") }
			}
		`)
	app.Register("Profile", profileDef)

	settingsDef := core.NewApp(
		SettingsState{Theme: "light", Language: "en"},
		&core.ModuleOptions{Name: "Settings"},
	).
		OnAction("setTheme", func(ctx core.TypedActionContext[SettingsState]) {
			theme, _ := ctx.Action.Payload.(string)
			ctx.State.Theme = theme
			if ctx.Context != nil {
				ctx.Context.Emit("themeChanged", theme)
			}
		}).
		UI(`
			Column {
				Text("Settings").fontSize(32).fontWeight("bold")
				Text("Theme: @{state.theme}")
				Text("Language: @{state.language}")
			}
		`)
	app.Register("Settings", settingsDef)

	// ── Wire up routes ───────────────────────────────────────────────

	managed := core.NewManagedRouter(router, engine, app, ctx)
	managed.AddRoute(core.RouteDefinition{Path: "/", Component: "Home"})
	managed.AddRoute(core.RouteDefinition{Path: "/profile/:id", Component: "Profile"})
	managed.AddRoute(core.RouteDefinition{Path: "/settings", Component: "Settings"})

	ctx.On("themeChanged", func(payload any) {
		fmt.Printf("theme changed globally: %v\n", payload)
	})

	// ── Navigate ────────────────────────────────────────────────────

	managed.Start() // mounts Home at /

	if mod := managed.GetActiveModule(); mod != nil {
		mod.DispatchAction("recordVisit", nil)
		mod.DispatchAction("recordVisit", nil)
	}

	router.Push("/profile/42?tab=posts")
	if match := router.MatchPath("/profile/:id", router.GetCurrentPath()); match != nil {
		fmt.Printf("route param id=%s\n", match.Params["id"])
	}
	if mod := managed.GetActiveModule(); mod != nil {
		mod.DispatchAction("loadProfile", map[string]any{"id": "42"})
	}

	router.Push("/settings")
	if mod := managed.GetActiveModule(); mod != nil {
		mod.DispatchAction("setTheme", "dark")
	}

	// Back to Home — persisted, visits state survives.
	router.Push("/")
	if mod := managed.GetActiveModule(); mod != nil {
		mod.DispatchAction("recordVisit", nil)
		fmt.Printf("home visits after returning: %v\n", mod.GetState()["visits"])
	}

	managed.Stop()
}
