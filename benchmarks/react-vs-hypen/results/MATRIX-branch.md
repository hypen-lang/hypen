# React vs Hypen — version matrix

Run 2026-11-12 21:11 UTC on **E2B hypen-bench-4c-8192m (sandbox A)**: Intel(R) Xeon(R) Processor @ 2.60GHz, 4 vCPU, 7957 MB, linux x64 6.1.189+. Chromium 151.0.7922.34, Bun 1.4.4. 5 interleaved rounds, 9 min.

Every build below ran in the same process against the same browser on the same machine, round-robin, with the starting build rotated every scenario (`bench/matrix.ts`). Cells are the median of all samples pooled across rounds.

## Builds

| build | what it is | list | JS (gzip) | WASM (gzip) |
|---|---:|---:|---:|---:|
| `react` | apps/react | every row in the DOM | 197 kB (63 kB) | – |
| `react-virtual` | apps/react | windowed | 232 kB (73 kB) | – |
| `hypen-develop-eager` | checkout d7a9e63 (List lazy: false) | every row in the DOM | 644 kB (186 kB) | 1668 kB (597 kB) |
| `hypen-develop` | checkout d7a9e63 | windowed | 644 kB (186 kB) | 1668 kB (597 kB) |
| `hypen-branch-eager` | checkout 700d835 (List lazy: false) | every row in the DOM | 646 kB (186 kB) | 1669 kB (597 kB) |
| `hypen-branch` | checkout 700d835 | windowed | 646 kB (186 kB) | 1669 kB (597 kB) |

## Host stability

A fixed framework-free workload runs at the start of every round. Across 5 rounds: JS 37.1–46.9 ms (±11.5%), DOM build + layout 91.1–112 ms (±10.0%). Load average 0.16 at start, 1.27 at end. Differences between builds smaller than that spread are noise.

## Every row in the DOM — interaction latency

Click to post-paint of the last mutated frame, in ms, and the ratio to `react` (above 1× is slower than React). This number is rounded up to a frame boundary, so anything that fits in one frame reads ~16 ms for everyone.

| scenario | react | hypen-develop-eager | hypen-branch-eager |
|---|---:|---:|---:|
| `create-1k` | 158 | 177 (1.12×) | 167 (1.06×) |
| `replace-1k` | 172 | 239 (1.39×) | 213 (1.24×) |
| `append-1k` | 151 | 226 (1.50×) | 196 (1.30×) |
| `update-10th` | 21.8 | 21.0 (0.96×) | 21.2 (0.97×) |
| `update-all` | 35.8 | 43.0 (1.20×) | 42.2 (1.18×) |
| `select-row` | 16.2 | 16.1 (0.99×) | 16.3 (1.01×) |
| `swap-rows` | 103 | 19.5 (0.19×) | 19.8 (0.19×) |
| `remove-row` | 27.9 | 26.9 (0.97×) | 28.6 (1.03×) |
| `clear` | 15.0 | 25.8 (1.73×) | 18.8 (1.26×) |
| **geomean vs react** | 1.00× | **0.98×** | **0.92×** |

## Every row in the DOM — main-thread CPU per interaction

Chromium's `TaskDuration` counter, read before and after each interaction (script + WASM + style + layout + paint on the main thread), in ms. Not frame-quantised, so it separates the builds on the small updates.

| scenario | react | hypen-develop-eager | hypen-branch-eager |
|---|---:|---:|---:|
| `create-1k` | 163 | 200 (1.23×) | 183 (1.12×) |
| `replace-1k` | 181 | 257 (1.42×) | 238 (1.31×) |
| `append-1k` | 170 | 251 (1.47×) | 213 (1.25×) |
| `update-10th` | 10.3 | 19.1 (1.86×) | 13.2 (1.28×) |
| `update-all` | 33.4 | 50.9 (1.53×) | 43.6 (1.31×) |
| `select-row` | 3.4 | 4.7 (1.39×) | 5.2 (1.53×) |
| `swap-rows` | 137 | 18.3 (0.13×) | 12.1 (0.09×) |
| `remove-row` | 15.8 | 32.4 (2.06×) | 29.6 (1.87×) |
| `clear` | 15.7 | 34.2 (2.18×) | 25.5 (1.62×) |
| **geomean vs react** | 1.00× | **1.22×** | **1.03×** |

## Windowed lists

`react-virtual` is the React app with TanStack Virtual; the Hypen build is one whose `List` is virtualized by default. Both keep only the rows near the viewport in the DOM, so most interactions fit in a single frame and the latency column is mostly the frame clock — read the CPU column.

Latency (ms):

| scenario | react-virtual | hypen-develop | hypen-branch |
|---|---:|---:|---:|
| `create-1k` | 18.0 | 19.5 (1.08×) | 19.4 (1.08×) |
| `replace-1k` | 18.1 | 35.9 (1.98×) | 37.2 (2.06×) |
| `append-1k` | 15.6 | 15.6 (1.00×) | 15.7 (1.01×) |
| `update-10th` | 15.5 | 15.7 (1.01×) | 15.6 (1.00×) |
| `update-all` | 16.2 | 16.2 (1.00×) | 16.2 (1.00×) |
| `select-row` | 15.5 | 15.4 (1.00×) | 15.5 (1.00×) |
| `swap-rows` | 15.9 | 15.7 (0.99×) | 15.8 (1.00×) |
| `remove-row` | 16.1 | 16.2 (1.00×) | 16.8 (1.04×) |
| `clear` | 14.9 | 15.0 (1.01×) | 14.9 (1.00×) |
| **geomean vs react-virtual** | 1.00× | **1.09×** | **1.10×** |

Main-thread CPU (ms):

| scenario | react-virtual | hypen-develop | hypen-branch |
|---|---:|---:|---:|
| `create-1k` | 8.0 | 22.7 (2.84×) | 23.3 (2.90×) |
| `replace-1k` | 8.9 | 36.7 (4.11×) | 37.9 (4.25×) |
| `append-1k` | 3.0 | 13.6 (4.56×) | 13.2 (4.41×) |
| `update-10th` | 2.3 | 5.5 (2.37×) | 5.4 (2.35×) |
| `update-all` | 3.3 | 13.3 (3.98×) | 12.7 (3.81×) |
| `select-row` | 2.0 | 3.8 (1.90×) | 3.6 (1.80×) |
| `swap-rows` | 2.7 | 5.4 (2.00×) | 5.4 (1.98×) |
| `remove-row` | 3.2 | 13.0 (4.12×) | 16.0 (5.05×) |
| `clear` | 2.2 | 4.6 (2.07×) | 4.4 (1.99×) |
| **geomean vs react-virtual** | 1.00× | **2.94×** | **2.96×** |

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
| `react` | 54.1 | 1.6 MB | 5.6 MB | 2.3 MB | 2074 | 10000 |
| `react-virtual` | 54.9 | 1.7 MB | 2.3 MB | 2.2 MB | 21.2 | 26 |
| `hypen-develop-eager` | 112 | 2.5 MB | 6.1 MB | 3.0 MB | 2189 | 10000 |
| `hypen-develop` | 108 | 2.5 MB | 3.1 MB | 2.9 MB | 120 | 30 |
| `hypen-branch-eager` | 111 | 2.5 MB | 6.2 MB | 3.0 MB | 2159 | 10000 |
| `hypen-branch` | 114 | 2.5 MB | 3.1 MB | 2.9 MB | 156 | 30 |

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
| `create-1k` | 25 | 144–174 | 17.6–18.2 | 170–196 | 18.2–22.0 | 157–182 | 17.9–22.9 |
| `replace-1k` | 15 | 147–185 | 17.8–18.4 | 224–250 | 32.9–40.5 | 188–227 | 31.3–37.9 |
| `append-1k` | 10 | 132–175 | 15.6–15.9 | 204–242 | 15.3–16.1 | 188–212 | 15.3–16.0 |
| `update-10th` | 20 | 21.4–22.5 | 15.5–15.7 | 18.2–21.9 | 15.5–15.8 | 20.9–21.4 | 15.5–16.0 |
| `update-all` | 20 | 33.9–38.7 | 16.1–16.5 | 40.0–50.0 | 16.0–16.3 | 41.5–45.5 | 16.1–16.4 |
| `select-row` | 20 | 15.6–16.5 | 15.3–15.8 | 15.8–16.3 | 15.3–15.7 | 15.9–16.5 | 15.2–15.7 |
| `swap-rows` | 20 | 82.8–120 | 15.7–16.1 | 15.6–20.4 | 15.5–15.9 | 19.3–20.1 | 15.6–16.6 |
| `remove-row` | 20 | 26.4–28.8 | 16.1–16.3 | 25.7–28.4 | 16.0–16.4 | 27.0–29.7 | 16.2–18.3 |
| `clear` | 20 | 14.7–15.5 | 14.7–15.2 | 24.4–27.6 | 14.7–15.1 | 17.8–21.1 | 14.8–15.1 |

## Replicate

The same builds, run independently on **E2B hypen-bench-4c-8192m (sandbox B)** (Intel(R) Xeon(R) Processor @ 2.60GHz, 4 vCPU, 7957 MB; calibration JS 48.0 ms vs 42.7 ms here). Geomean ratio to the baseline, this run → replicate:

| build | latency | CPU |
|---|---:|---:|
| `hypen-develop-eager` vs `react` | 0.98× → 0.97× | 1.22× → 1.19× |
| `hypen-develop` vs `react-virtual` | 1.09× → 1.10× | 2.94× → 3.15× |
| `hypen-branch-eager` vs `react` | 0.92× → 0.90× | 1.03× → 1.04× |
| `hypen-branch` vs `react-virtual` | 1.10× → 1.11× | 2.96× → 3.17× |
