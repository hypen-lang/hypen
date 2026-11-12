# React vs Hypen — version matrix

Run 2026-11-12 22:26 UTC on **E2B hypen-bench-4c-8192m (sandbox A)**: Intel(R) Xeon(R) Processor @ 2.60GHz, 4 vCPU, 7957 MB, linux x64 6.1.189+. Chromium 151.0.7922.34, Bun 1.4.4. 5 interleaved rounds, 12 min.

Every build below ran in the same process against the same browser on the same machine, round-robin, with the starting build rotated every scenario (`bench/matrix.ts`). Cells are the median of all samples pooled across rounds.

## Builds

| build | what it is | list | JS (gzip) | WASM (gzip) |
|---|---:|---:|---:|---:|
| `react` | apps/react | every row in the DOM | 197 kB (63 kB) | – |
| `react-virtual` | apps/react | windowed | 232 kB (73 kB) | – |
| `hypen-develop-eager` | checkout d7a9e63 (List lazy: false) | every row in the DOM | 644 kB (186 kB) | 1668 kB (597 kB) |
| `hypen-develop` | checkout d7a9e63 | windowed | 644 kB (186 kB) | 1668 kB (597 kB) |
| `hypen-branch-eager` | checkout cea1a2b (List lazy: false) | every row in the DOM | 645 kB (186 kB) | 1668 kB (597 kB) |
| `hypen-branch` | checkout cea1a2b | windowed | 645 kB (186 kB) | 1668 kB (597 kB) |

## Host stability

A fixed framework-free workload runs at the start of every round. Across 5 rounds: JS 49.3–64.2 ms (±14.9%), DOM build + layout 140–228 ms (±26.8%). Load average 0.16 at start, 0.83 at end. Differences between builds smaller than that spread are noise.

## Every row in the DOM — interaction latency

Click to post-paint of the last mutated frame, in ms, and the ratio to `react` (above 1× is slower than React). This number is rounded up to a frame boundary, so anything that fits in one frame reads ~16 ms for everyone.

| scenario | react | hypen-develop-eager | hypen-branch-eager |
|---|---:|---:|---:|
| `create-1k` | 260 | 310 (1.19×) | 313 (1.20×) |
| `replace-1k` | 263 | 333 (1.27×) | 299 (1.14×) |
| `append-1k` | 255 | 331 (1.30×) | 280 (1.10×) |
| `update-10th` | 26.3 | 24.9 (0.95×) | 26.1 (1.00×) |
| `update-all` | 60.9 | 79.6 (1.31×) | 73.5 (1.21×) |
| `select-row` | 17.2 | 17.2 (1.00×) | 16.7 (0.97×) |
| `swap-rows` | 155 | 22.8 (0.15×) | 23.4 (0.15×) |
| `remove-row` | 50.4 | 46.3 (0.92×) | 56.1 (1.11×) |
| `clear` | 39.9 | 42.7 (1.07×) | 39.7 (0.99×) |
| **geomean vs react** | 1.00× | **0.89×** | **0.87×** |

## Every row in the DOM — main-thread CPU per interaction

Chromium's `TaskDuration` counter, read before and after each interaction (script + WASM + style + layout + paint on the main thread), in ms. Not frame-quantised, so it separates the builds on the small updates.

| scenario | react | hypen-develop-eager | hypen-branch-eager |
|---|---:|---:|---:|
| `create-1k` | 279 | 330 (1.18×) | 346 (1.24×) |
| `replace-1k` | 267 | 372 (1.39×) | 323 (1.21×) |
| `append-1k` | 271 | 345 (1.27×) | 294 (1.08×) |
| `update-10th` | 19.9 | 36.4 (1.83×) | 29.4 (1.48×) |
| `update-all` | 65.1 | 92.5 (1.42×) | 75.4 (1.16×) |
| `select-row` | 7.8 | 10.7 (1.36×) | 13.1 (1.67×) |
| `swap-rows` | 174 | 31.5 (0.18×) | 26.0 (0.15×) |
| `remove-row` | 44.6 | 62.6 (1.40×) | 63.6 (1.43×) |
| `clear` | 41.4 | 64.1 (1.55×) | 46.2 (1.12×) |
| **geomean vs react** | 1.00× | **1.13×** | **1.01×** |

## Windowed lists

`react-virtual` is the React app with TanStack Virtual; the Hypen build is one whose `List` is virtualized by default. Both keep only the rows near the viewport in the DOM, so most interactions fit in a single frame and the latency column is mostly the frame clock — read the CPU column.

Latency (ms):

| scenario | react-virtual | hypen-develop | hypen-branch |
|---|---:|---:|---:|
| `create-1k` | 19.4 | 34.1 (1.76×) | 31.5 (1.62×) |
| `replace-1k` | 19.5 | 68.5 (3.51×) | 54.8 (2.81×) |
| `append-1k` | 15.6 | 32.5 (2.08×) | 21.6 (1.38×) |
| `update-10th` | 15.7 | 15.9 (1.02×) | 15.9 (1.01×) |
| `update-all` | 16.9 | 24.7 (1.46×) | 21.6 (1.28×) |
| `select-row` | 15.4 | 15.5 (1.00×) | 15.6 (1.02×) |
| `swap-rows` | 16.1 | 16.0 (0.99×) | 15.8 (0.98×) |
| `remove-row` | 16.9 | 21.6 (1.28×) | 32.4 (1.92×) |
| `clear` | 14.6 | 14.4 (0.99×) | 14.6 (1.00×) |
| **geomean vs react-virtual** | 1.00× | **1.42×** | **1.36×** |

Main-thread CPU (ms):

| scenario | react-virtual | hypen-develop | hypen-branch |
|---|---:|---:|---:|
| `create-1k` | 15.5 | 39.5 (2.55×) | 37.2 (2.40×) |
| `replace-1k` | 14.4 | 69.7 (4.85×) | 55.9 (3.89×) |
| `append-1k` | 5.5 | 34.0 (6.21×) | 23.0 (4.19×) |
| `update-10th` | 4.5 | 10.1 (2.23×) | 9.9 (2.18×) |
| `update-all` | 6.9 | 26.3 (3.80×) | 23.6 (3.41×) |
| `select-row` | 4.6 | 9.2 (2.00×) | 8.2 (1.79×) |
| `swap-rows` | 6.4 | 11.7 (1.84×) | 10.8 (1.70×) |
| `remove-row` | 6.5 | 27.0 (4.13×) | 35.8 (5.48×) |
| `clear` | 4.3 | 9.4 (2.17×) | 8.9 (2.06×) |
| **geomean vs react-virtual** | 1.00× | **3.03×** | **2.78×** |

Rows actually in the DOM after each scenario:

| scenario | react-virtual | hypen-develop | hypen-branch |
|---|---:|---:|---:|
| `create-1k` | 26 | 30 | 30 |
| `replace-1k` | 26 | 30 | 30 |
| `append-1k` | 26 | 30 | 30 |
| `update-10th` | 26 | 30 | 30 |
| `update-all` | 26 | 30 | 30 |
| `select-row` | 26 | 30 | 30 |
| `swap-rows` | 26 | 30 | 30 |
| `remove-row` | 26 | 30 | 30 |
| `clear` | 0 | 0 | 0 |

## DOM work per interaction

Nodes added / removed / attribute writes / text writes, from a MutationObserver.

| scenario | react | react-virtual | hypen-develop-eager | hypen-develop | hypen-branch-eager | hypen-branch |
|---|---:|---:|---:|---:|---:|---:|
| `create-1k` | 1000/0/0/1 | 26/0/1/1 | 1000/0/0/1 | 30/0/91/1 | 1000/0/0/1 | 30/0/91/1 |
| `replace-1k` | 1000/1000/0/0 | 26/26/0/0 | 1000/1000/0/0 | 30/30/90/0 | 1000/1000/0/0 | 30/30/90/0 |
| `append-1k` | 1000/0/0/1 | 0/0/1/1 | 1000/0/0/1 | 0/0/31/1 | 1000/0/0/1 | 0/0/31/1 |
| `update-10th` | 0/0/0/100 | 0/0/0/3 | 0/0/100/100 | 0/0/3/3 | 0/0/0/100 | 0/0/0/3 |
| `update-all` | 0/0/0/1000 | 0/0/0/26 | 0/0/1000/1000 | 0/0/30/30 | 0/0/0/1000 | 0/0/0/30 |
| `select-row` | 0/0/2/0 | 0/0/2/0 | 0/0/2/0 | 0/0/2/0 | 0/0/2/0 | 0/0/2/0 |
| `swap-rows` | 997/997/0/0 | 1/1/0/0 | 2/2/0/0 | 2/2/3/0 | 2/2/0/0 | 2/2/3/0 |
| `remove-row` | 0/1/0/1 | 1/1/1/1 | 0/1/0/1 | 1/1/61/1 | 0/1/0/1 | 1/1/61/1 |
| `clear` | 0/1000/0/1 | 0/26/1/1 | 0/1000/0/1 | 0/30/1/1 | 0/1000/0/1 | 0/30/1/1 |

## Startup, memory, 10,000 rows

| build | ready (ms) | heap empty | heap @1k rows | heap after clear | create 10k (ms) | rows in DOM |
|---|---:|---:|---:|---:|---:|---:|
| `react` | 84.0 | 1.6 MB | 5.6 MB | 2.3 MB | 2772 | 10000 |
| `react-virtual` | 85.8 | 1.7 MB | 2.3 MB | 2.2 MB | 48.2 | 26 |
| `hypen-develop-eager` | 194 | 2.5 MB | 6.2 MB | 3.0 MB | 3113 | 10000 |
| `hypen-develop` | 191 | 2.5 MB | 3.1 MB | 2.9 MB | 195 | 30 |
| `hypen-branch-eager` | 174 | 2.5 MB | 6.2 MB | 3.0 MB | 2939 | 10000 |
| `hypen-branch` | 180 | 2.5 MB | 3.1 MB | 2.9 MB | 178 | 30 |

Heap is the JS heap after a forced GC; Hypen keeps its node tree in WASM linear memory, which this does not see. The 10k render is a single sample.

## Parity with the React app

50 rows rendered in both, every node compared (tag, text, 39 computed styles, rectangle). Windowed builds are not compared: they render a different number of rows by design.

| build | elements (react / hypen) | mismatches |
|---|---:|---:|
| `hypen-develop-eager` | 899 / 899 | 0 |
| `hypen-branch-eager` | 899 / 899 | 0 |

## Spread

Latency, 25th–75th percentile of the pooled samples (ms), and sample count.

| scenario | n | react | react-virtual | hypen-develop-eager | hypen-develop | hypen-branch-eager | hypen-branch |
|---|---:|---:|---:|---:|---:|---:|---:|
| `create-1k` | 25 | 232–322 | 18.8–21.2 | 282–359 | 27.9–41.5 | 273–464 | 27.4–43.8 |
| `replace-1k` | 15 | 238–284 | 18.5–21.0 | 320–441 | 55.7–83.1 | 285–349 | 52.7–60.6 |
| `append-1k` | 10 | 223–289 | 15.2–15.9 | 304–336 | 20.3–34.4 | 260–319 | 18.6–33.9 |
| `update-10th` | 20 | 25.3–33.9 | 15.3–16.2 | 20.4–29.1 | 15.4–16.7 | 24.7–33.5 | 15.6–16.5 |
| `update-all` | 20 | 47.5–82.5 | 16.6–17.4 | 69.7–120 | 21.0–32.5 | 66.2–99.3 | 19.5–30.8 |
| `select-row` | 20 | 16.7–19.3 | 15.1–15.7 | 16.4–18.6 | 15.0–16.0 | 12.6–17.5 | 15.5–16.0 |
| `swap-rows` | 20 | 146–258 | 15.8–16.3 | 20.7–23.8 | 15.7–16.5 | 22.7–26.3 | 15.3–16.3 |
| `remove-row` | 20 | 40.1–62.7 | 16.6–17.6 | 42.9–62.7 | 19.0–32.4 | 43.1–70.1 | 27.4–34.1 |
| `clear` | 20 | 22.6–48.9 | 14.5–14.9 | 37.9–72.3 | 14.2–14.7 | 32.6–54.4 | 14.3–14.9 |

## Replicate

The same builds, run independently on **E2B hypen-bench-4c-8192m (sandbox B)** (Intel(R) Xeon(R) Processor @ 2.60GHz, 4 vCPU, 7957 MB; calibration JS 37.8 ms vs 50.0 ms here). Geomean ratio to the baseline, this run → replicate:

| build | latency | CPU |
|---|---:|---:|
| `hypen-develop-eager` vs `react` | 0.89× → 0.99× | 1.13× → 1.27× |
| `hypen-develop` vs `react-virtual` | 1.42× → 1.11× | 3.03× → 2.75× |
| `hypen-branch-eager` vs `react` | 0.87× → 0.97× | 1.01× → 1.14× |
| `hypen-branch` vs `react-virtual` | 1.36× → 1.11× | 2.78× → 2.79× |
