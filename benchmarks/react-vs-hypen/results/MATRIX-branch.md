# React vs Hypen — version matrix

Run 2026-11-12 22:26 UTC on **E2B hypen-bench-4c-8192m (sandbox B)**: Intel(R) Xeon(R) Processor @ 2.60GHz, 4 vCPU, 7957 MB, linux x64 6.1.189+. Chromium 151.0.7922.34, Bun 1.4.4. 5 interleaved rounds, 10 min.

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

A fixed framework-free workload runs at the start of every round. Across 5 rounds: JS 37.7–45.4 ms (±10.2%), DOM build + layout 89.4–117 ms (±14.2%). Load average 0.25 at start, 0.90 at end. Differences between builds smaller than that spread are noise.

## Every row in the DOM — interaction latency

Click to post-paint of the last mutated frame, in ms, and the ratio to `react` (above 1× is slower than React). This number is rounded up to a frame boundary, so anything that fits in one frame reads ~16 ms for everyone.

| scenario | react | hypen-develop-eager | hypen-branch-eager |
|---|---:|---:|---:|
| `create-1k` | 156 | 201 (1.29×) | 187 (1.20×) |
| `replace-1k` | 177 | 232 (1.31×) | 225 (1.27×) |
| `append-1k` | 167 | 228 (1.37×) | 211 (1.26×) |
| `update-10th` | 22.4 | 20.1 (0.90×) | 21.6 (0.96×) |
| `update-all` | 38.6 | 50.8 (1.32×) | 48.6 (1.26×) |
| `select-row` | 15.8 | 15.9 (1.00×) | 15.7 (0.99×) |
| `swap-rows` | 98.3 | 18.7 (0.19×) | 19.9 (0.20×) |
| `remove-row` | 28.8 | 29.5 (1.03×) | 30.1 (1.05×) |
| `clear` | 17.1 | 30.1 (1.76×) | 26.5 (1.55×) |
| **geomean vs react** | 1.00× | **0.99×** | **0.97×** |

## Every row in the DOM — main-thread CPU per interaction

Chromium's `TaskDuration` counter, read before and after each interaction (script + WASM + style + layout + paint on the main thread), in ms. Not frame-quantised, so it separates the builds on the small updates.

| scenario | react | hypen-develop-eager | hypen-branch-eager |
|---|---:|---:|---:|
| `create-1k` | 165 | 207 (1.25×) | 190 (1.16×) |
| `replace-1k` | 190 | 254 (1.34×) | 255 (1.34×) |
| `append-1k` | 188 | 239 (1.27×) | 227 (1.21×) |
| `update-10th` | 12.2 | 22.7 (1.86×) | 19.0 (1.56×) |
| `update-all` | 38.0 | 53.1 (1.40×) | 52.2 (1.37×) |
| `select-row` | 4.1 | 6.3 (1.53×) | 7.5 (1.81×) |
| `swap-rows` | 104 | 20.6 (0.20×) | 14.9 (0.14×) |
| `remove-row` | 17.8 | 39.3 (2.21×) | 34.0 (1.91×) |
| `clear` | 18.1 | 43.0 (2.38×) | 29.4 (1.63×) |
| **geomean vs react** | 1.00× | **1.27×** | **1.14×** |

## Windowed lists

`react-virtual` is the React app with TanStack Virtual; the Hypen build is one whose `List` is virtualized by default. Both keep only the rows near the viewport in the DOM, so most interactions fit in a single frame and the latency column is mostly the frame clock — read the CPU column.

Latency (ms):

| scenario | react-virtual | hypen-develop | hypen-branch |
|---|---:|---:|---:|
| `create-1k` | 17.9 | 21.0 (1.17×) | 21.1 (1.18×) |
| `replace-1k` | 17.8 | 39.2 (2.20×) | 38.1 (2.14×) |
| `append-1k` | 15.4 | 15.5 (1.01×) | 15.5 (1.01×) |
| `update-10th` | 15.3 | 15.4 (1.01×) | 15.4 (1.00×) |
| `update-all` | 15.8 | 16.1 (1.02×) | 16.0 (1.01×) |
| `select-row` | 15.0 | 14.9 (0.99×) | 15.1 (1.01×) |
| `swap-rows` | 15.7 | 15.4 (0.98×) | 15.4 (0.98×) |
| `remove-row` | 16.0 | 16.0 (1.00×) | 16.6 (1.04×) |
| `clear` | 14.7 | 14.6 (1.00×) | 14.6 (1.00×) |
| **geomean vs react-virtual** | 1.00× | **1.11×** | **1.11×** |

Main-thread CPU (ms):

| scenario | react-virtual | hypen-develop | hypen-branch |
|---|---:|---:|---:|
| `create-1k` | 8.9 | 23.4 (2.62×) | 24.4 (2.72×) |
| `replace-1k` | 9.9 | 40.1 (4.06×) | 39.2 (3.96×) |
| `append-1k` | 3.5 | 15.2 (4.39×) | 15.9 (4.58×) |
| `update-10th` | 2.7 | 6.2 (2.27×) | 6.0 (2.20×) |
| `update-all` | 3.7 | 14.4 (3.89×) | 15.3 (4.13×) |
| `select-row` | 2.6 | 4.2 (1.60×) | 4.2 (1.58×) |
| `swap-rows` | 3.3 | 6.1 (1.87×) | 6.4 (1.94×) |
| `remove-row` | 3.9 | 14.5 (3.70×) | 15.8 (4.03×) |
| `clear` | 2.7 | 5.4 (2.00×) | 5.0 (1.83×) |
| **geomean vs react-virtual** | 1.00× | **2.75×** | **2.79×** |

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
| `react` | 53.4 | 1.6 MB | 5.6 MB | 2.3 MB | 2053 | 10000 |
| `react-virtual` | 55.7 | 1.7 MB | 2.3 MB | 2.2 MB | 25.7 | 26 |
| `hypen-develop-eager` | 120 | 2.5 MB | 6.3 MB | 3.0 MB | 2242 | 10000 |
| `hypen-develop` | 118 | 2.5 MB | 3.1 MB | 2.9 MB | 187 | 30 |
| `hypen-branch-eager` | 115 | 2.5 MB | 6.3 MB | 3.0 MB | 2286 | 10000 |
| `hypen-branch` | 120 | 2.5 MB | 3.1 MB | 2.9 MB | 123 | 30 |

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
| `create-1k` | 25 | 149–179 | 17.5–18.3 | 194–218 | 19.5–22.9 | 164–205 | 18.3–24.1 |
| `replace-1k` | 15 | 148–188 | 17.7–18.0 | 221–241 | 35.7–43.0 | 200–249 | 36.6–41.2 |
| `append-1k` | 10 | 157–185 | 15.2–15.5 | 210–253 | 15.3–15.9 | 194–231 | 15.1–15.9 |
| `update-10th` | 20 | 21.6–23.3 | 15.1–15.6 | 16.5–22.1 | 15.2–15.6 | 20.6–23.0 | 15.1–15.6 |
| `update-all` | 20 | 35.2–42.7 | 15.7–16.1 | 48.6–54.1 | 16.0–16.3 | 47.0–53.4 | 15.9–16.4 |
| `select-row` | 20 | 15.6–16.1 | 14.8–15.3 | 9.6–16.2 | 14.7–15.2 | 14.8–16.1 | 14.9–15.3 |
| `swap-rows` | 20 | 89.9–111 | 15.5–15.8 | 13.2–20.9 | 14.8–15.6 | 18.3–20.7 | 15.2–16.5 |
| `remove-row` | 20 | 27.1–30.1 | 15.9–16.6 | 28.7–32.0 | 15.7–16.6 | 29.2–30.9 | 16.1–17.4 |
| `clear` | 20 | 16.3–18.5 | 14.4–14.9 | 27.8–31.5 | 14.5–14.8 | 25.1–28.0 | 14.5–14.9 |

## Replicate

The same builds, run independently on **E2B hypen-bench-4c-8192m (sandbox A)** (Intel(R) Xeon(R) Processor @ 2.60GHz, 4 vCPU, 7957 MB; calibration JS 50.0 ms vs 37.8 ms here). Geomean ratio to the baseline, this run → replicate:

| build | latency | CPU |
|---|---:|---:|
| `hypen-develop-eager` vs `react` | 0.99× → 0.89× | 1.27× → 1.13× |
| `hypen-develop` vs `react-virtual` | 1.11× → 1.42× | 2.75× → 3.03× |
| `hypen-branch-eager` vs `react` | 0.97× → 0.87× | 1.14× → 1.01× |
| `hypen-branch` vs `react-virtual` | 1.11× → 1.36× | 2.79× → 2.78× |
