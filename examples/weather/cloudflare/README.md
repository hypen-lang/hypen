# Hypen Weather — Cloudflare Worker + Durable Object

A phone-first weather app on [Open-Meteo](https://open-meteo.com) (keyless):
current conditions for where you are, the next 24 hours as a chart plus an
hourly strip, a 7-day list with min/max range bars, detail tiles (feels like,
wind, humidity, sunrise/sunset, UV, US AQI), city search with autocomplete,
saved cities, and a °C/°F toggle. The background and surfaces follow the
current condition and day/night.

It is one inline module (`src/weather.ts`) served by `defineHypenWorker`, and
it runs standalone or inside the home-screen launcher via
`HypenApp("ws://localhost:8796/ws")`.

## Run locally

```bash
bun install
bun run dev        # wrangler dev → http://localhost:8796 (inspector 9238)
bun test           # data layer against recorded Open-Meteo responses
bun run typecheck
```

The port and inspector port are pinned in `wrangler.jsonc` (`dev`), so this
example never collides with a sibling's `wrangler dev`.

## Files

| File | What it does |
|---|---|
| `src/worker.ts` | `defineHypenWorker` + the `WeatherDO` subclass: visitor-cookie routing, geo capture, `geoScope` around every DO entry point |
| `src/weather.ts` | The module: state, actions, lifecycle (60 s ticker), persistence of saved cities + unit, and the DSL template |
| `src/openmeteo.ts` | Open-Meteo client: forecast / air quality / geocoding / ensemble fallback, TTL cache with in-flight de-dup, retry with backoff |
| `src/present.ts` | Pure forecast → view model: WMO codes, themes, unit conversion, 24 h strip, range bars, tiles |
| `src/icons.ts` | Multi-colour weather glyphs as SVG data URIs |
| `src/geo.ts` | `request.cf` geo → header → DO → `AsyncLocalStorage` |
| `fixtures/` | Recorded Open-Meteo responses used by `src/weather.test.ts` |

## How it works

**Location.** The default place is the viewer's edge location from
`request.cf` (city, region, coordinates). The worker stamps it into an
`x-hypen-geo` header, the DO keeps it (memory + DO storage, for hibernation)
and runs each entry point inside `geoScope.run(geo, …)`, which `onCreated`
reads. Under `wrangler dev`, `request.cf` comes from wrangler's local cf
data, so you get the dev machine's approximate location; with no geo at all
it falls back to San Francisco. The ➤ button returns to it.

The browser's own position would be better, but the device plane (RFC 001)
has no position capability yet: `permission.request("location")` only reports
a permission status. When a `location.get`-style capability lands, `onCreated`
can ask `context.device` first and keep `request.cf` as the fallback.

**Search.** The input is `.bind(@state.query).onInput(@actions.search)`.
Each keystroke queries the geocoding API (cached for a day per query), and a
sequence number drops responses that a newer keystroke has overtaken. Enter
picks the first result.

**Saved cities + unit.** `.persist()` gets a wrapper store that only writes
`{ unit, saved }` (and only when they changed), so forecasts, which are a
cache, never land in DO storage. Routing: the first page load sets a
`hypen_weather` cookie, so a visitor's reloads and tabs share one DO and one
saved list. Clients without the cookie (a `HypenApp` embed from another
site, a native shell) share one `weather:shared` DO and its saved list.

**Caching and live updates.** All upstream calls go through an in-isolate
TTL cache keyed on a ~1 km grid (forecast 10 min, AQI 30 min, geocoding 1 day)
with in-flight de-duplication and stale-if-error, plus `cf.cacheTtl` for the
edge cache when deployed. Each session runs a 60 s ticker that re-derives the
view from the cache (clock, the "Now" hour, "updated N min ago") and pulls a
fresh forecast once the TTL lapses, so open clients update without a reload.

**Rate limits.** Open-Meteo's free tier is limited per IP. 429 and 5xx
responses retry with exponential backoff (honouring `Retry-After`). A *daily*
429 is not retried: the forecast API is skipped for 30 minutes and the
**ensemble API** (also Open-Meteo, keyless, separate quota) stands in. The
ensemble's control run gives the hourly values, the share of members with
≥ 0.1 mm gives the precipitation probability (the same definition the
forecast API uses), daily min/max come from the hours, and sunrise/sunset
come from the sunrise equation. UV is not in that model, so its tile shows a
dash. The footer says when the fallback is in use.

## Deploy

```bash
bunx wrangler login   # one-time
bun run deploy
```

Set `allowedOrigins` / `authenticate` in `worker.ts` before a public deploy
(wrangler dev logs a reminder). Open-Meteo's free API is for non-commercial
use; see their terms.

## Notes and quirks

- `.label("@{…}")` with a binding expression produced no accessible name on
  the button, so the save star is two `If` branches with static labels.
- `.textAlign("right")` on a `Text` inside a `Row` renders the span with
  `align-self: stretch`, which top-aligns it in the row. The low temperature
  adds `.alignSelf("center")`.
- Per-row weather icons are `Image(src: "@{item.icon}")` data URIs because
  `Icon(@resources.x)` resolves its name statically.
