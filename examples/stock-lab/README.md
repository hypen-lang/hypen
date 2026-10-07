# Orbit — stock chart lab

One Hypen template and one TypeScript module, served to Web DOM, Web Canvas,
iOS (SwiftUI Canvas), Android (Compose Canvas), and Desktop (Vello).

## Run

From the repository root, install the Web SDK dependencies with `cd hypen-web && bun install`.
The server WASM has been rebuilt for chart primitive registration. To reproduce that build:

```sh
cd hypen-engine-rs
wasm-pack build --target nodejs --out-dir pkg/nodejs --features js,device-broker
cp pkg/nodejs/hypen_engine* ../hypen-web/packages/server/wasm-node/
cd ../examples/stock-lab
bun dev
```

In another terminal, run `bun web` from this folder. Open:

- DOM: http://localhost:3189
- Canvas: http://localhost:3189/?renderer=canvas
- iOS gallery URL: `ws://localhost:3188`
- Android emulator gallery URL: `ws://10.0.2.2:3188`
- Desktop, from the repository root:
  `cargo run -p hypen-renderer-desktop --example remote_screenshot -- ws://localhost:3188 /tmp/orbit-desktop.png`

`PORT` and `WEB_PORT` override the listeners. When changing PORT, use the web
client's `?ws=ws://localhost:NEW_PORT` parameter too. Restart the server after
editing the module/template; restart the web server after editing the client.

## What works

Search the four-symbol local catalog by ticker or company, select a stock,
change its history between 10/30/all sessions, add/remove watchlist entries,
and add paper holdings with shares and optional cost per share. Adding an
existing symbol updates its weighted average cost. The × button removes a
holding. Portfolio value, unrealized gain and allocation recalculate together.
Tap/move over the price line to inspect a datum; tap allocation bars to select.

Four charts exercise smooth Line + Area, Rule, interactive Marker, numeric
volume Bars, portfolio sparkline, and categorical allocation Bars with axes.
The app uses SafeArea and native-compatible `.scrollable(true)`.

## Data and persistence

IBM comes from the bundled Alpha Vantage daily sample, dated **2026-09-04**.
AAPL/MSFT/NVDA are **synthetic demo fixtures**, labeled in the app. Search is a
local catalog search, not an exchange-wide search service.

**Refresh daily prices** uses the documented public IBM demo endpoint by default.
Set `ALPHA_VANTAGE_API_KEY` on the server to a free personal key to refresh other
symbols. The key stays on the server. Requests have a 10-second timeout, validate
prices and cache successful results for 15 minutes. API failures leave the
current data intact and display a status message. Free service limits apply.

Source: https://www.alphavantage.co/documentation/#daily

Paper holdings/watchlists live in a server session (one-hour TTL); they are not
persisted to disk and do not survive a server restart. Each renderer has its
own session. The portfolio history revalues **today's holdings** at common
historical dates; it is not a transaction-based or time-weighted return chart.

## Black theme refresh

Both templates now use black backgrounds, charcoal cards, brighter active tabs,
and restrained lime/violet glow. `screenshots/orbit-refined-desktop.png` is the latest desktop preview.
The portfolio-first layout draws on the references in `INSPIRATION.md`. The five-renderer comparison captures below preserve
the original validation run and predate this visual refresh.

## Validation — 2026-09-06

| Renderer | Chart tests | Real render |
| --- | ---: | --- |
| Web DOM + Canvas | 106 passed | Both browser renderers captured |
| Desktop Vello | 55 passed | Production GPU screenshot exporter |
| iOS | 64 passed | Rebuilt gallery on iPhone 17 Pro / iOS 26.3 |
| Android | 81 passed | Rebuilt gallery on Pixel 8 emulator |

Four example tests (19 assertions) also pass; the example TypeScript check passes.
These cover portfolio arithmetic, weighted cost basis, invalid inputs, empty
holdings, search, selection, watchlist changes, and range updates.

Live UI checks: web search, selection, watchlist and range; canvas range; iOS
line hit → price tooltip and range changes. Android and desktop interactions
are covered by their automated chart suites; they were not manually exercised
through the emulator/window in this run. No physical-device or long-session
performance testing was performed. Tests cover more marks than this dashboard,
including Points and Path.

### Fix found by the dashboard

`.glow(color: "#b7ef5b", radius: 4)` is encoded by the engine as `glow.color`
and `glow.radius`. The three native chart style readers only accepted the
positional/object forms, so the glow silently disappeared. The same defect
applied to named shadow arguments. All three readers now collect named fields,
with regressions using the actual patch key format. The updated screenshots
show the glow. Existing positional forms remain supported.

### Comparison notes

The selected price ($234.89), period return (+8.60%), portfolio ($6,921.74),
unrealized gain (+$541.74), line shape and relative bar heights agree. Native
fonts, line spacing and safe-area chrome differ, so whole screens are not
pixel-identical. Desktop approximates glow with layered strokes; the other
renderers blur it. Native input placeholder contrast remains weak in the dark
theme; that is an existing input-renderer styling issue outside the chart fix.

Screenshots are real renderer captures, not mockups. Web and desktop app content
is 430 logical pixels wide; native device screenshots keep their native widths
and safe areas. The comparison sheet scales each capture proportionally to a
common display width. Web images were cropped from the browser capture; the
DOM capture was also rescaled to account for in-app browser screenshot zoom.
`ios-portfolio.png` shows the scrolled portfolio/allocation section.

Open http://localhost:3189/comparison for the screenshot gallery, or see
`screenshots/comparison.png`. To reproduce the compact study, run
`CHARTS_ONLY=1 PORT=3190 bun server.ts`, then connect the renderers to port 3190.
`Charts.hypen` uses the same state and chart components as the full app.
The sheet crops gallery chrome to focus on the chart content; the gallery
contains the original full captures.

## Re-run tests

```sh
bun test examples/stock-lab/market.test.ts
hypen-web/node_modules/.bin/tsc --noEmit -p examples/stock-lab/tsconfig.json
cd hypen-web && bun test tests/canvas-chart.test.ts tests/dom.chart-contract.test.ts tests/dom.chart-svg.test.ts
# From repository root:
cargo test -p hypen-renderer-desktop chart --lib
cd hypen-renderer-swift && swift test --filter Chart
cd hypen-renderer-android && ./gradlew :renderer:testDebugUnitTest --tests '*Chart*'
```

## Portfolio concept redesign

The latest layout has persistent Dashboard, Markets, Portfolio, and Watchlist tabs,
a four-stock grid, compact holding rows, regular typography and restrained white glow.
See INSPIRATION.md for the reference and current screenshots. Module validation:
5 tests / 31 assertions plus TypeScript checking. DOM navigation, search, stock
selection, watchlist changes and chart periods were exercised in the real preview.
