# Calorie Counter — Hypen Example

A cross-platform calorie-counter app showing off **inline `.ui(...)`
templates** and **SQLite-backed state** in the TypeScript SDK.

All UI lives inside its module file — one TypeScript file per screen,
each calling `.ui(hypen\`...\`)` at the end. No paired `.hypen` files.

## Design

Three primary screens, mirroring the mockup:

- **Home (`/`)** — today's eaten / kcal-left / burned hero, macro cards
  (Carbs / Protein / Fat), quick activity tiles, and a meal list
  (Breakfast / Lunch / Dinner / Snack) with per-slot progress.
- **Add Food (`/add`)** — search + category tabs (All / Recent /
  Meals / My Foods) driving a food list; tapping "+" logs the food
  against the meal that launched the screen.
- **Stats (`/stats`)** — Daily / Weekly toggle. Weekly shows a 7-bar
  chart with a dashed goal line plus an Average vs. Goal macro
  breakdown. Daily collapses to a single bar + the day's macros.

Plus **Diary (`/diary`)** (day-scoped food log with per-entry delete)
and **Profile (`/profile`)** (user + daily-goal readout).

## Structure

```
calorie-counter/
├── data/
│   ├── schema.sql              # SQLite schema (users/foods/food_entries/activities/meal_goals)
│   └── seed.sql                # Empty — waiting on the seed data you said you'd provide
└── typescript/
    ├── server/
    │   ├── index.ts            # RemoteServer wiring + hot reload
    │   ├── db.ts               # SQLite bootstrap (bun:sqlite)
    │   ├── queries.ts          # All DB reads/writes + row→view formatters
    │   └── components/         # One file per screen, inline `.ui(...)`
    │       ├── App.ts          # Shell + Router (primary module)
    │       ├── BottomNav.ts    # Stateless — reads App's `location`
    │       ├── Home.ts
    │       ├── AddFood.ts
    │       ├── Stats.ts
    │       ├── Diary.ts
    │       └── Profile.ts
    └── web/
        ├── index.html          # Phone-ish frame around #app
        ├── client.ts           # RemoteEngine + DOMRenderer
        └── serve.ts            # Dev server (Bun.build on the fly)
```

## How inline UI works here

Each screen is a **single-file component**: a `.ts` that
`export default`s a module definition ending in `.ui(hypen\`...\`)`.
The server's `.source(componentsDir)` hands the directory to
`discoverComponents`, which imports every `.ts` and pulls the
template off `module.template`. The App module's template owns the
top-level `Router { Route(path) { Home() } ... }`; every other
screen is named via `app.module("Home")...` so the engine's
component resolver can slot them into the active route.

Read the header comments in `typescript/server/components/App.ts`
and `BottomNav.ts` for the wiring details (primary module vs
nested, why BottomNav skips `app.module(...)`).

## Running

```bash
cd typescript
bun install

# Start the server (websocket on :3000):
bun run dev

# In a second terminal, start the web client on :3001:
bun run web
# Then open http://localhost:3001
```

The DB file (`calorie-counter.db`) is created on first boot from
`data/schema.sql`. Reset it any time with:

```bash
bun run db:reset
```

## Seeding

`data/seed.sql` is intentionally empty. Drop your `INSERT` statements
there when the seed data lands and run `bun run db:reset` to apply
them. The loader runs the seed SQL only when the `users` table is
empty, so adding new inserts later means: reset the DB first.

Rough shape the seed should cover, one `INSERT` block per table:

1. At least one user (`users.id = 'u1'` is the fallback the UI
   falls back to).
2. A handful of `foods` across categories `'popular'`, `'meal'`,
   `'my-food'` with `icon`, `calories`, `carbs_g`, `protein_g`,
   `fat_g`, `serving_label`, `sort_order`.
3. A few `food_entries` for today's date so Home isn't an empty
   screen.
4. One or two `activities` (walking / activity) for today.
5. Optional `meal_goals` rows to override the defaults (500 /
   768 / 800 / 332 for breakfast / lunch / dinner / snack).
