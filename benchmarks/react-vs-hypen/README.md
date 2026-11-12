# React vs Hypen benchmark

Two apps. Same UI, same styles, same DOM — one written in React, one written
in Hypen — driven through the same scenarios by the same harness, in the same
browser, back to back.

```
benchmarks/react-vs-hypen/
├── shared/            the single source of truth both apps build from
│   ├── theme.ts       design tokens (colours, spacing, type scale)
│   ├── data.ts        seeded dataset + the row mutations each scenario runs
│   └── scenarios.ts   the scenario list, control ids and action names
├── apps/react/        React 19 + Vite
├── apps/hypen/        Hypen DSL + WASM engine in the browser, + Vite
├── bench/             harness: parity checker, drivers, report generators
├── scripts/           build-variants.ts (one build per SDK version), e2b.ts
└── results/           results.json, REPORT.md, parity.json, screenshots
```

## Running it

```bash
cd benchmarks/react-vs-hypen
bun install
bun run bench          # build both apps, then measure (~5 min)
bun run report         # results/results.json -> results/REPORT.md
```

Individual pieces:

```bash
bun run build          # build @hypen-space dists, copy WASM, build both apps
bun run parity         # structural diff only; exits non-zero on any mismatch
bun run validate       # re-time create-1k with a second, independent method
bun run profile        # CPU profile of one interaction, attributed by layer
bun bench/profile.ts react select-row         # any app, any scenario
bun bench/run.ts --only=create-1k,swap-rows --skip-parity
bun bench/smoke.ts hypen create-1k     # render one app once and screenshot it
bun run dev:react      # http://localhost:5301
bun run dev:hypen      # http://localhost:5302
```

## Comparing SDK versions (the matrix)

`bun run bench` compares React with the Hypen SDK in this checkout. To compare
several Hypen releases against React — and against each other — build one app
per version and run them all through the matrix driver:

```bash
# one static build per variant, into variants/<name>/
bun run variants react react-virtual \
  hypen@0.6.4 hypen@0.6.5 hypen@0.6.6 hypen@0.6.7 \
  "hypen-develop=../../../hypen-develop/hypen-web/packages" \
  "hypen-develop-eager=../../../hypen-develop/hypen-web/packages?lazy: false"

bun run matrix --rounds=8        # here, on this machine -> results/matrix.json
bun run matrix:report            # -> results/MATRIX.md
```

`hypen@<version>` bundles `apps/hypen` against the published npm tarballs (the
`dist/` and WASM a consumer installs). `<name>=<dir>` bundles it against a
checkout's `hypen-web/packages` — a git worktree of another branch, say — and
`?<args>` appends arguments to the benchmark's `List`. It is the same app
source every time, so the SDK is the only thing that varies.

SDKs that virtualize `List` by default render ~30 rows where React renders
1,000, which is a different amount of work, not a faster reconciler. So the
matrix keeps two comparisons apart: every-row-in-the-DOM builds against
`react` (use `?lazy: false` to opt a virtualizing SDK into this group), and
windowed builds against `react-virtual`, the same React app with TanStack
Virtual, the window as the scroll container and the same overscan rule.

### On a machine of a known shape (E2B)

```bash
export E2B_API_KEY=…
bun run e2b template                       # once: 4 vCPU / 8 GB, Chromium, Bun
bun run e2b run --rounds=8 --replicas=2    # -> results/matrix.json, matrix-b.json
bun run matrix:report --replicate=results/matrix-b.json
```

How the matrix keeps the ground level:

- **One machine per comparison.** Every build runs in the same process, on the
  same browser, in the same sandbox. Nothing is compared across machines: a
  sandbox template fixes the vCPU count and memory, but two sandboxes can still
  land on different physical hosts.
- **Interleaved, not batched.** A round visits each scenario and, within it,
  each build back to back, rotating which build goes first. A slow minute on
  the host costs every build about the same.
- **A noise floor you can read.** Each round starts with a fixed workload that
  involves no framework (a sort; building and laying out 20,000 elements). Its
  spread across rounds is printed in the report; differences smaller than it
  are not differences.
- **A replicate.** `--replicas=2` runs the entire matrix in a second sandbox at
  the same time. Absolute times differ between hosts; the ratios between
  builds should not, and the report prints both.

Besides latency the matrix records **main-thread CPU per interaction**
(Chromium's `TaskDuration` counter, before and after). Latency is rounded up
to a frame boundary, so once an interaction fits in one frame every build
reads ~16 ms; the CPU figure keeps separating them.

## What is measured

**Interaction latency**, per scenario, as the median of repeated runs:

| Scenario | What it exercises |
|---|---|
| `create-1k` | building 1,000 rows (17,000 elements) from empty |
| `replace-1k` | replacing all 1,000 rows with 1,000 new ones |
| `append-1k` | growing an existing 1,000-row list to 2,000 |
| `update-10th` | a state change touching 100 of 1,000 rows |
| `update-all` | a state change touching all 1,000 rows, no structural change |
| `select-row` | a style-only change on 1 row out of 1,000 |
| `swap-rows` | reordering two rows (the keyed-move path) |
| `remove-row` | removing one row |
| `clear` | tearing the whole list down |

Six of those are state updates against an already-rendered list, which is
where most of a real app's time goes.

**DOM touched per interaction.** Every timed run also records how many nodes
were inserted and removed and how many attribute and text mutations landed.
That is the framework-neutral way to ask "did it re-render more than it had
to": React skipping 999 memoised rows and Hypen emitting a minimal patch set
both show up as small numbers, and over-rendering shows up as a large one.

**Scaling probe.** One 10,000-row render per app, reported separately because
it is a single sample rather than a median, and capped from the driver side.
The cap has to live in the driver: if a render is one long synchronous task,
the page's own `setTimeout` cannot fire until it finishes, so an in-page cap
would never trip. An uncapped attempt during development was still running
after 12 minutes, which is why the probe is bounded at all.

**Startup**, **bytes shipped** (raw and gzipped, JS and WASM separately), and
**JS heap** empty / at 1,000 rows / back to empty.

Chromium is taken from `/opt/pw-browsers/chromium` when present, otherwise
from `$CHROMIUM_PATH`, otherwise from whatever `playwright-core` resolves.

## What makes it a fair comparison

**The two apps cannot drift.** Colours, spacing, the type scale, the dataset,
the row mutations and the toolbar contents all come from `shared/`. The React
app spreads the tokens into inline styles; the Hypen app interpolates the same
token objects into its DSL template. Changing a colour changes both.

**Parity is verified, not asserted.** `bench/parity.ts` renders 50 rows in both
apps and walks the two trees in document order, comparing every node's tag
name, own text, 39 computed style properties and its on-screen rectangle. The
harness runs it as part of every benchmark and records the outcome in the
report. The last recorded run: **897 elements each, 0 mismatches.**

**Neither side is hobbled.** The React app is written the way a competent React
app is written — function components, `useState` with functional updates,
stable `useCallback` handlers, and a `memo`-wrapped row so changing one row
does not re-render the other 999. In `bun run bench` neither app is
virtualised; both put every row in the DOM. (The matrix adds a windowed pair —
see above.)

**The clock measures the same thing on both sides.** A scenario's duration is
the interval from the click to the moment after layout and paint of the frame
carrying the last DOM mutation that click caused (`bench/measure.ts`). It
waits on the DOM, not on React's scheduler or on Hypen's patch stream, so
neither framework's internals define the finish line. Idle-detection time is
excluded. Every scenario runs unmeasured warmup iterations first, on a fresh
page, and reports the median of the timed runs.

**Different amounts of DOM invalidate a timing.** After every timed run the
harness records element and row counts for both apps and flags any scenario
where they disagree.

## What it does not measure

- **Network.** Everything is served from localhost with no compression. Byte
  counts in the report are measured from the files on disk (raw and gzipped),
  so you can reason about transfer separately from parse and execute.
- **WASM memory.** The memory numbers are JS heap after a forced collection.
  Hypen's engine keeps its node tree in WASM linear memory, which that metric
  does not see, so its per-row heap figure is a floor, not a total.
- **Server-driven Hypen.** This benchmark runs the engine in the browser,
  which is the apples-to-apples comparison against a client-side React app.
  Hypen can also drive a client from a Cloudflare Worker over a socket (see
  `examples/*/cloudflare`); that is a different architecture with a different
  performance profile and is not what is measured here.

## Notes on the build

- `scripts/prepare.ts` builds `@hypen-space/core` and `@hypen-space/web` to
  their `dist/` and copies the browser WASM engine into
  `apps/hypen/public/wasm/`, so the Hypen app bundles the same artifacts an
  npm consumer installs. It does **not** run `@hypen-space/web-engine`'s build
  script: that script deletes its `wasm-browser/` directory and repopulates it
  from a fresh `wasm-pack` output, so running it without that toolchain
  destroys the checked-in engine binary. That package's four orchestrator
  files are bundled from source instead.
- The WASM engine is the artifact checked in at
  `hypen-web/packages/web-engine/wasm-browser/`. To benchmark engine changes,
  run `./build-wasm.sh` in `hypen-engine-rs/` first, then `bun run bench`.
- `apps/hypen/vite.config.ts` rewrites the synchronous `require()` calls in
  `@hypen-space/web`'s DOM component registry into static imports. Bundlers
  with CommonJS interop (bun, esbuild) tolerate those calls; Rollup — and
  therefore Vite — leaves `require` undefined and the app dies on first
  render. The rewrite is semantics-preserving: every specifier is a static
  relative path to a sibling ES module.
- Hypen action identifiers are spelled out (`createOneK`, not `create1k`)
  because the parser rejects digits inside an `@actions.<name>` reference.
