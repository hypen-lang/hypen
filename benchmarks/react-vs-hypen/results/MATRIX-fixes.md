# React vs Hypen — version matrix

Run 2026-11-10 18:04 UTC on **E2B hypen-bench-4c-8192m (sandbox A)**: Intel(R) Xeon(R) Processor @ 2.60GHz, 4 vCPU, 7957 MB, linux x64 6.1.189+. Chromium 151.0.7922.34, Bun 1.4.4. 5 interleaved rounds, 10 min.

Every build below ran in the same process against the same browser on the same machine, round-robin, with the starting build rotated every scenario (`bench/matrix.ts`). Cells are the median of all samples pooled across rounds.

## Builds

| build | what it is | list | JS (gzip) | WASM (gzip) |
|---|---:|---:|---:|---:|
| `react` | apps/react | every row in the DOM | 197 kB (63 kB) | – |
| `react-virtual` | apps/react | windowed | 232 kB (73 kB) | – |
| `hypen-develop-eager` | checkout 22b5c5e (List lazy: false) | every row in the DOM | 640 kB (185 kB) | 4464 kB (778 kB) |
| `hypen-develop` | checkout 22b5c5e | windowed | 639 kB (185 kB) | 4464 kB (778 kB) |
| `hypen-fixed-eager` | checkout 8bb77db (List lazy: false) | every row in the DOM | 644 kB (186 kB) | 1668 kB (597 kB) |
| `hypen-fixed` | checkout 8bb77db | windowed | 644 kB (186 kB) | 1668 kB (597 kB) |

## Host stability

A fixed framework-free workload runs at the start of every round. Across 5 rounds: JS 47.4–48.6 ms (±1.3%), DOM build + layout 108–122 ms (±6.2%). Load average 0.24 at start, 0.72 at end. Differences between builds smaller than that spread are noise.

## Every row in the DOM — interaction latency

Click to post-paint of the last mutated frame, in ms, and the ratio to `react` (above 1× is slower than React). This number is rounded up to a frame boundary, so anything that fits in one frame reads ~16 ms for everyone.

| scenario | react | hypen-develop-eager | hypen-fixed-eager |
|---|---:|---:|---:|
| `create-1k` | 182 | 215 (1.18×) | 195 (1.07×) |
| `replace-1k` | 178 | 265 (1.49×) | 248 (1.39×) |
| `append-1k` | 176 | 258 (1.46×) | 228 (1.30×) |
| `update-10th` | 22.0 | 21.9 (1.00×) | 21.7 (0.99×) |
| `update-all` | 39.5 | 58.2 (1.47×) | 49.3 (1.25×) |
| `select-row` | 16.5 | 16.3 (0.99×) | 16.2 (0.98×) |
| `swap-rows` | 108 | 21.0 (0.19×) | 19.7 (0.18×) |
| `remove-row` | 29.9 | 34.5 (1.16×) | 31.4 (1.05×) |
| `clear` | 17.0 | 32.8 (1.93×) | 34.5 (2.03×) |
| **geomean vs react** | 1.00× | **1.05×** | **0.99×** |

## Every row in the DOM — main-thread CPU per interaction

Chromium's `TaskDuration` counter, read before and after each interaction (script + WASM + style + layout + paint on the main thread), in ms. Not frame-quantised, so it separates the builds on the small updates.

| scenario | react | hypen-develop-eager | hypen-fixed-eager |
|---|---:|---:|---:|
| `create-1k` | 190 | 223 (1.17×) | 221 (1.16×) |
| `replace-1k` | 201 | 298 (1.49×) | 276 (1.37×) |
| `append-1k` | 191 | 294 (1.54×) | 235 (1.23×) |
| `update-10th` | 11.0 | 24.8 (2.27×) | 22.4 (2.04×) |
| `update-all` | 46.5 | 64.0 (1.38×) | 54.8 (1.18×) |
| `select-row` | 4.1 | 17.7 (4.35×) | 5.3 (1.30×) |
| `swap-rows` | 130 | 24.5 (0.19×) | 15.8 (0.12×) |
| `remove-row` | 20.9 | 44.1 (2.11×) | 39.8 (1.91×) |
| `clear` | 19.7 | 39.2 (1.98×) | 49.2 (2.49×) |
| **geomean vs react** | 1.00× | **1.45×** | **1.15×** |

## Windowed lists

`react-virtual` is the React app with TanStack Virtual; the Hypen build is one whose `List` is virtualized by default. Both keep only the rows near the viewport in the DOM, so most interactions fit in a single frame and the latency column is mostly the frame clock — read the CPU column.

Latency (ms):

| scenario | react-virtual | hypen-develop | hypen-fixed |
|---|---:|---:|---:|
| `create-1k` | 19.4 | 27.3 (1.41×) | 23.4 (1.21×) |
| `replace-1k` | 18.5 | 42.9 (2.32×) | 39.3 (2.12×) |
| `append-1k` | 15.8 | 30.7 (1.94×) | 15.9 (1.00×) |
| `update-10th` | 16.0 | 15.9 (0.99×) | 15.8 (0.99×) |
| `update-all` | 16.3 | 17.3 (1.06×) | 16.8 (1.03×) |
| `select-row` | 15.7 | 15.7 (1.00×) | 15.5 (0.99×) |
| `swap-rows` | 16.1 | 15.9 (0.98×) | 16.0 (0.99×) |
| `remove-row` | 16.8 | 22.7 (1.36×) | 18.4 (1.10×) |
| `clear` | 15.1 | 15.1 (1.00×) | 15.0 (0.99×) |
| **geomean vs react-virtual** | 1.00× | **1.27×** | **1.12×** |

Main-thread CPU (ms):

| scenario | react-virtual | hypen-develop | hypen-fixed |
|---|---:|---:|---:|
| `create-1k` | 10.4 | 29.0 (2.78×) | 26.0 (2.50×) |
| `replace-1k` | 10.1 | 44.0 (4.36×) | 39.7 (3.93×) |
| `append-1k` | 3.0 | 31.5 (10.53×) | 14.1 (4.71×) |
| `update-10th` | 2.5 | 9.7 (3.88×) | 5.9 (2.37×) |
| `update-all` | 3.2 | 17.9 (5.57×) | 15.9 (4.95×) |
| `select-row` | 2.5 | 8.7 (3.52×) | 3.8 (1.52×) |
| `swap-rows` | 3.1 | 10.8 (3.53×) | 6.5 (2.10×) |
| `remove-row` | 4.1 | 23.6 (5.71×) | 19.2 (4.65×) |
| `clear` | 2.7 | 5.7 (2.16×) | 5.5 (2.09×) |
| **geomean vs react-virtual** | 1.00× | **4.22×** | **2.95×** |

Rows actually in the DOM after each scenario:

| scenario | react-virtual | hypen-develop | hypen-fixed |
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

| scenario | react | react-virtual | hypen-develop-eager | hypen-develop | hypen-fixed-eager | hypen-fixed |
|---|---:|---:|---:|---:|---:|---:|
| `create-1k` | 1000/0/0/1 | 26/0/1/1 | 1000/0/0/1 | 30/0/91/1 | 1000/0/0/1 | 30/0/91/1 |
| `replace-1k` | 1000/1000/0/0 | 26/26/0/0 | 1000/1000/0/0 | 30/30/180/0 | 1000/1000/0/0 | 30/30/90/0 |
| `append-1k` | 1000/0/0/1 | 0/0/1/1 | 1000/0/0/1 | 0/0/31/1 | 1000/0/0/1 | 0/0/31/1 |
| `update-10th` | 0/0/0/100 | 0/0/0/3 | 0/0/100/100 | 0/0/3/3 | 0/0/100/100 | 0/0/3/3 |
| `update-all` | 0/0/0/1000 | 0/0/0/26 | 0/0/1000/1000 | 0/0/30/30 | 0/0/1000/1000 | 0/0/30/30 |
| `select-row` | 0/0/2/0 | 0/0/2/0 | 0/0/2/0 | 0/0/2/0 | 0/0/2/0 | 0/0/2/0 |
| `swap-rows` | 997/997/0/0 | 1/1/0/0 | 2/2/0/0 | 2/2/6/0 | 2/2/0/0 | 2/2/3/0 |
| `remove-row` | 0/1/0/1 | 1/1/1/1 | 0/1/0/1 | 1/1/64/1 | 0/1/0/1 | 1/1/61/1 |
| `clear` | 0/1000/0/1 | 0/26/1/1 | 0/1000/0/1 | 0/30/91/1 | 0/1000/0/1 | 0/30/1/1 |

## Startup, memory, 10,000 rows

| build | ready (ms) | heap empty | heap @1k rows | heap after clear | create 10k (ms) | rows in DOM |
|---|---:|---:|---:|---:|---:|---:|
| `react` | 56.5 | 1.6 MB | 5.6 MB | 2.3 MB | 2455 | 10000 |
| `react-virtual` | 55.6 | 1.7 MB | 2.3 MB | 2.2 MB | 23.9 | 26 |
| `hypen-develop-eager` | 131 | 2.5 MB | 6.2 MB | 3.0 MB | 2942 | 10000 |
| `hypen-develop` | 131 | 2.5 MB | 3.1 MB | 2.9 MB | 200 | 30 |
| `hypen-fixed-eager` | 122 | 2.5 MB | 6.1 MB | 3.0 MB | 2711 | 10000 |
| `hypen-fixed` | 120 | 2.5 MB | 3.1 MB | 2.9 MB | 174 | 30 |

Heap is the JS heap after a forced GC; Hypen keeps its node tree in WASM linear memory, which this does not see. The 10k render is a single sample.

## Parity with the React app

50 rows rendered in both, every node compared (tag, text, 39 computed styles, rectangle). Windowed builds are not compared: they render a different number of rows by design.

| build | elements (react / hypen) | mismatches |
|---|---:|---:|
| `hypen-develop-eager` | 899 / 899 | 0 |
| `hypen-fixed-eager` | 899 / 899 | 0 |

## Spread

Latency, 25th–75th percentile of the pooled samples (ms), and sample count.

| scenario | n | react | react-virtual | hypen-develop-eager | hypen-develop | hypen-fixed-eager | hypen-fixed |
|---|---:|---:|---:|---:|---:|---:|---:|
| `create-1k` | 25 | 160–199 | 18.7–20.7 | 193–232 | 23.6–31.8 | 190–222 | 21.4–28.1 |
| `replace-1k` | 15 | 171–199 | 18.3–20.3 | 255–293 | 38.0–46.0 | 244–265 | 35.9–40.8 |
| `append-1k` | 10 | 157–200 | 15.7–15.9 | 225–287 | 24.0–39.0 | 215–253 | 15.7–16.8 |
| `update-10th` | 20 | 21.3–25.2 | 15.8–16.3 | 20.6–23.7 | 15.7–16.1 | 18.7–24.4 | 15.7–16.1 |
| `update-all` | 20 | 37.3–50.8 | 16.0–16.6 | 52.4–69.7 | 16.3–20.4 | 46.5–55.9 | 16.3–20.9 |
| `select-row` | 20 | 16.3–17.4 | 15.5–16.0 | 15.1–18.0 | 15.6–15.9 | 10.5–16.5 | 15.3–15.8 |
| `swap-rows` | 20 | 91.2–130 | 15.9–16.4 | 20.3–24.4 | 15.6–16.1 | 14.4–20.6 | 15.7–16.1 |
| `remove-row` | 20 | 29.2–40.3 | 16.6–17.3 | 33.3–45.5 | 17.6–28.6 | 29.6–34.3 | 16.8–23.0 |
| `clear` | 20 | 16.2–19.1 | 15.0–15.3 | 31.9–35.4 | 15.0–15.3 | 27.8–54.6 | 14.8–15.1 |

## Replicate

The same builds, run independently on **E2B hypen-bench-4c-8192m (sandbox B)** (Intel(R) Xeon(R) Processor @ 2.60GHz, 4 vCPU, 7957 MB; calibration JS 49.2 ms vs 47.5 ms here). Geomean ratio to the baseline, this run → replicate:

| build | latency | CPU |
|---|---:|---:|
| `hypen-develop-eager` vs `react` | 1.05× → 1.04× | 1.45× → 1.51× |
| `hypen-develop` vs `react-virtual` | 1.27× → 1.38× | 4.22× → 3.84× |
| `hypen-fixed-eager` vs `react` | 0.99× → 0.97× | 1.15× → 1.31× |
| `hypen-fixed` vs `react-virtual` | 1.12× → 1.21× | 2.95× → 2.84× |
