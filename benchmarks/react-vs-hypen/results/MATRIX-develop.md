# React vs Hypen — version matrix

Run 2026-11-10 16:42 UTC on **E2B hypen-bench-4c-8192m (sandbox A)**: Intel(R) Xeon(R) Processor @ 2.60GHz, 4 vCPU, 7957 MB, linux x64 6.1.189+. Chromium 151.0.7922.34, Bun 1.4.4. 5 interleaved rounds, 7 min.

Every build below ran in the same process against the same browser on the same machine, round-robin, with the starting build rotated every scenario (`bench/matrix.ts`). Cells are the median of all samples pooled across rounds.

## Builds

| build | what it is | list | JS (gzip) | WASM (gzip) |
|---|---:|---:|---:|---:|
| `react` | apps/react | every row in the DOM | 197 kB (63 kB) | – |
| `hypen-develop-eager` | checkout bf5f766 (List lazy: false) | every row in the DOM | 632 kB (182 kB) | 1656 kB (585 kB) |
| `hypen-develop` | checkout bf5f766 | windowed | 632 kB (182 kB) | 1656 kB (585 kB) |
| `react-virtual` | apps/react | windowed | 232 kB (73 kB) | – |

## Host stability

A fixed framework-free workload runs at the start of every round. Across 5 rounds: JS 55.9–58.4 ms (±2.2%), DOM build + layout 127–163 ms (±14.0%). Load average 0.00 at start, 0.78 at end. Differences between builds smaller than that spread are noise.

## Every row in the DOM — interaction latency

Click to post-paint of the last mutated frame, in ms, and the ratio to `react` (above 1× is slower than React). This number is rounded up to a frame boundary, so anything that fits in one frame reads ~16 ms for everyone.

| scenario | react | hypen-develop-eager |
|---|---:|---:|
| `create-1k` | 208 | 237 (1.14×) |
| `replace-1k` | 210 | 306 (1.46×) |
| `append-1k` | 206 | 272 (1.32×) |
| `update-10th` | 22.4 | 22.9 (1.02×) |
| `update-all` | 40.4 | 59.1 (1.46×) |
| `select-row` | 16.2 | 15.9 (0.98×) |
| `swap-rows` | 114 | 21.8 (0.19×) |
| `remove-row` | 31.5 | 40.1 (1.27×) |
| `clear` | 18.3 | 36.8 (2.00×) |
| **geomean vs react** | 1.00× | **1.05×** |

## Every row in the DOM — main-thread CPU per interaction

Chromium's `TaskDuration` counter, read before and after each interaction (script + WASM + style + layout + paint on the main thread), in ms. Not frame-quantised, so it separates the builds on the small updates.

| scenario | react | hypen-develop-eager |
|---|---:|---:|
| `create-1k` | 213 | 254 (1.20×) |
| `replace-1k` | 225 | 323 (1.43×) |
| `append-1k` | 221 | 290 (1.32×) |
| `update-10th` | 11.7 | 26.9 (2.29×) |
| `update-all` | 44.1 | 65.8 (1.49×) |
| `select-row` | 4.1 | 18.2 (4.49×) |
| `swap-rows` | 119 | 29.3 (0.25×) |
| `remove-row` | 19.9 | 50.8 (2.56×) |
| `clear` | 19.6 | 45.1 (2.30×) |
| **geomean vs react** | 1.00× | **1.55×** |

## Windowed lists

`react-virtual` is the React app with TanStack Virtual; the Hypen build is one whose `List` is virtualized by default. Both keep only the rows near the viewport in the DOM, so most interactions fit in a single frame and the latency column is mostly the frame clock — read the CPU column.

Latency (ms):

| scenario | react-virtual | hypen-develop |
|---|---:|---:|
| `create-1k` | 19.0 | 29.3 (1.54×) |
| `replace-1k` | 18.9 | 50.3 (2.66×) |
| `append-1k` | 15.7 | 27.4 (1.75×) |
| `update-10th` | 15.8 | 15.7 (0.99×) |
| `update-all` | 16.3 | 17.7 (1.09×) |
| `select-row` | 15.4 | 15.5 (1.01×) |
| `swap-rows` | 15.9 | 15.7 (0.99×) |
| `remove-row` | 16.4 | 18.6 (1.13×) |
| `clear` | 15.0 | 15.1 (1.01×) |
| **geomean vs react-virtual** | 1.00× | **1.27×** |

Main-thread CPU (ms):

| scenario | react-virtual | hypen-develop |
|---|---:|---:|
| `create-1k` | 9.8 | 32.7 (3.34×) |
| `replace-1k` | 10.3 | 50.9 (4.95×) |
| `append-1k` | 3.3 | 28.1 (8.61×) |
| `update-10th` | 2.7 | 11.4 (4.14×) |
| `update-all` | 3.8 | 18.4 (4.81×) |
| `select-row` | 2.3 | 8.9 (3.81×) |
| `swap-rows` | 3.2 | 10.9 (3.42×) |
| `remove-row` | 3.8 | 19.3 (5.07×) |
| `clear` | 2.4 | 4.9 (2.01×) |
| **geomean vs react-virtual** | 1.00× | **4.16×** |

Rows actually in the DOM after each scenario:

| scenario | react-virtual | hypen-develop |
|---|---:|---:|
| `create-1k` | 26 | 30 |
| `replace-1k` | 26 | 30 |
| `append-1k` | 26 | 30 |
| `update-10th` | 26 | 30 |
| `update-all` | 26 | 30 |
| `select-row` | 26 | 30 |
| `swap-rows` | 26 | 30 |
| `remove-row` | 26 | 30 |
| `clear` | 0 | 0 |

## DOM work per interaction

Nodes added / removed / attribute writes / text writes, from a MutationObserver.

| scenario | react | hypen-develop-eager | hypen-develop | react-virtual |
|---|---:|---:|---:|---:|
| `create-1k` | 1000/0/0/1 | 1000/0/0/1 | 30/0/91/1 | 26/0/1/1 |
| `replace-1k` | 1000/1000/0/0 | 1000/1000/0/0 | 30/30/180/0 | 26/26/0/0 |
| `append-1k` | 1000/0/0/1 | 1000/0/0/1 | 0/0/31/1 | 0/0/1/1 |
| `update-10th` | 0/0/0/100 | 0/0/100/100 | 0/0/3/3 | 0/0/0/3 |
| `update-all` | 0/0/0/1000 | 0/0/1000/1000 | 0/0/30/30 | 0/0/0/26 |
| `select-row` | 0/0/2/0 | 0/0/2/0 | 0/0/2/0 | 0/0/2/0 |
| `swap-rows` | 997/997/0/0 | 2/2/0/0 | 2/2/6/0 | 1/1/0/0 |
| `remove-row` | 0/1/0/1 | 0/1/0/1 | 1/1/64/1 | 1/1/1/1 |
| `clear` | 0/1000/0/1 | 0/1000/0/1 | 0/30/91/1 | 0/26/1/1 |

## Startup, memory, 10,000 rows

| build | ready (ms) | heap empty | heap @1k rows | heap after clear | create 10k (ms) | rows in DOM |
|---|---:|---:|---:|---:|---:|---:|
| `react` | 67.3 | 1.6 MB | 5.6 MB | 2.3 MB | 2613 | 10000 |
| `hypen-develop-eager` | 135 | 2.5 MB | 6.2 MB | 3.0 MB | 2899 | 10000 |
| `hypen-develop` | 137 | 2.5 MB | 3.1 MB | 2.9 MB | 227 | 30 |
| `react-virtual` | 62.1 | 1.7 MB | 2.3 MB | 2.2 MB | 30.0 | 26 |

Heap is the JS heap after a forced GC; Hypen keeps its node tree in WASM linear memory, which this does not see. The 10k render is a single sample.

## Parity with the React app

50 rows rendered in both, every node compared (tag, text, 39 computed styles, rectangle). Windowed builds are not compared: they render a different number of rows by design.

| build | elements (react / hypen) | mismatches |
|---|---:|---:|
| `hypen-develop-eager` | 899 / 899 | 0 |

## Spread

Latency, 25th–75th percentile of the pooled samples (ms), and sample count.

| scenario | n | react | hypen-develop-eager | hypen-develop | react-virtual |
|---|---:|---:|---:|---:|---:|
| `create-1k` | 25 | 185–224 | 221–256 | 27.1–32.1 | 18.7–19.4 |
| `replace-1k` | 15 | 198–234 | 284–317 | 48.5–51.8 | 18.6–19.2 |
| `append-1k` | 10 | 189–227 | 260–279 | 26.1–28.4 | 15.4–15.8 |
| `update-10th` | 20 | 22.0–23.0 | 22.0–23.9 | 15.5–16.1 | 15.7–16.1 |
| `update-all` | 20 | 39.1–47.6 | 56.7–64.9 | 16.6–20.1 | 16.0–16.5 |
| `select-row` | 20 | 16.0–16.3 | 12.0–17.0 | 15.4–15.8 | 15.3–15.7 |
| `swap-rows` | 20 | 107–120 | 21.0–22.5 | 15.5–15.9 | 15.6–16.1 |
| `remove-row` | 20 | 31.0–32.2 | 38.3–44.7 | 18.1–20.7 | 16.2–16.8 |
| `clear` | 20 | 17.8–19.5 | 35.5–39.8 | 14.9–15.3 | 14.9–15.1 |

## Replicate

The same builds, run independently on **E2B hypen-bench-4c-8192m (sandbox B)** (Intel(R) Xeon(R) Processor @ 2.60GHz, 4 vCPU, 7957 MB; calibration JS 38.9 ms vs 56.1 ms here). Geomean ratio to the baseline, this run → replicate:

| build | latency | CPU |
|---|---:|---:|
| `hypen-develop-eager` vs `react` | 1.05× → 1.10× | 1.55× → 1.60× |
| `hypen-develop` vs `react-virtual` | 1.27× → 1.18× | 4.16× → 4.01× |
