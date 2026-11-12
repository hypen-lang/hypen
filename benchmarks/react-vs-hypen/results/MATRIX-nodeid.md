# React vs Hypen — version matrix

Run 2026-11-12 19:32 UTC on **E2B hypen-bench-4c-8192m (sandbox A)**: Intel(R) Xeon(R) Processor @ 2.60GHz, 4 vCPU, 7957 MB, linux x64 6.1.189+. Chromium 151.0.7922.34, Bun 1.4.4. 5 interleaved rounds, 11 min.

Every build below ran in the same process against the same browser on the same machine, round-robin, with the starting build rotated every scenario (`bench/matrix.ts`). Cells are the median of all samples pooled across rounds.

## Builds

| build | what it is | list | JS (gzip) | WASM (gzip) |
|---|---:|---:|---:|---:|
| `react` | apps/react | every row in the DOM | 197 kB (63 kB) | – |
| `react-virtual` | apps/react | windowed | 232 kB (73 kB) | – |
| `hypen-develop-eager` | checkout d7a9e63 (List lazy: false) | every row in the DOM | 644 kB (186 kB) | 1668 kB (597 kB) |
| `hypen-develop` | checkout d7a9e63 | windowed | 644 kB (186 kB) | 1668 kB (597 kB) |
| `hypen-nodeid-eager` | checkout a48e53f (List lazy: false) | every row in the DOM | 645 kB (186 kB) | 1668 kB (597 kB) |
| `hypen-nodeid` | checkout a48e53f | windowed | 645 kB (186 kB) | 1668 kB (597 kB) |

## Host stability

A fixed framework-free workload runs at the start of every round. Across 5 rounds: JS 56.4–58.9 ms (±2.2%), DOM build + layout 131–158 ms (±9.5%). Load average 0.45 at start, 0.49 at end. Differences between builds smaller than that spread are noise.

## Every row in the DOM — interaction latency

Click to post-paint of the last mutated frame, in ms, and the ratio to `react` (above 1× is slower than React). This number is rounded up to a frame boundary, so anything that fits in one frame reads ~16 ms for everyone.

| scenario | react | hypen-develop-eager | hypen-nodeid-eager |
|---|---:|---:|---:|
| `create-1k` | 217 | 256 (1.18×) | 231 (1.06×) |
| `replace-1k` | 220 | 302 (1.37×) | 272 (1.24×) |
| `append-1k` | 219 | 300 (1.37×) | 264 (1.21×) |
| `update-10th` | 24.1 | 23.8 (0.99×) | 24.1 (1.00×) |
| `update-all` | 47.3 | 63.7 (1.35×) | 66.4 (1.40×) |
| `select-row` | 16.4 | 16.4 (1.00×) | 15.4 (0.94×) |
| `swap-rows` | 138 | 22.8 (0.16×) | 22.5 (0.16×) |
| `remove-row` | 34.7 | 37.2 (1.07×) | 36.7 (1.06×) |
| `clear` | 21.3 | 34.3 (1.61×) | 30.8 (1.45×) |
| **geomean vs react** | 1.00× | **0.98×** | **0.93×** |

## Every row in the DOM — main-thread CPU per interaction

Chromium's `TaskDuration` counter, read before and after each interaction (script + WASM + style + layout + paint on the main thread), in ms. Not frame-quantised, so it separates the builds on the small updates.

| scenario | react | hypen-develop-eager | hypen-nodeid-eager |
|---|---:|---:|---:|
| `create-1k` | 233 | 271 (1.16×) | 252 (1.08×) |
| `replace-1k` | 243 | 318 (1.31×) | 301 (1.24×) |
| `append-1k` | 241 | 323 (1.34×) | 283 (1.17×) |
| `update-10th` | 14.2 | 30.6 (2.16×) | 24.3 (1.72×) |
| `update-all` | 49.8 | 67.2 (1.35×) | 70.9 (1.42×) |
| `select-row` | 5.4 | 6.7 (1.24×) | 8.8 (1.63×) |
| `swap-rows` | 152 | 27.6 (0.18×) | 21.9 (0.14×) |
| `remove-row` | 27.9 | 54.9 (1.97×) | 43.8 (1.57×) |
| `clear` | 23.5 | 43.5 (1.85×) | 37.2 (1.58×) |
| **geomean vs react** | 1.00× | **1.19×** | **1.09×** |

## Windowed lists

`react-virtual` is the React app with TanStack Virtual; the Hypen build is one whose `List` is virtualized by default. Both keep only the rows near the viewport in the DOM, so most interactions fit in a single frame and the latency column is mostly the frame clock — read the CPU column.

Latency (ms):

| scenario | react-virtual | hypen-develop | hypen-nodeid |
|---|---:|---:|---:|
| `create-1k` | 18.6 | 25.7 (1.38×) | 26.2 (1.41×) |
| `replace-1k` | 18.6 | 47.1 (2.53×) | 46.8 (2.52×) |
| `append-1k` | 15.2 | 17.4 (1.14×) | 18.3 (1.20×) |
| `update-10th` | 15.3 | 15.5 (1.02×) | 15.5 (1.01×) |
| `update-all` | 16.1 | 18.3 (1.13×) | 16.6 (1.03×) |
| `select-row` | 14.9 | 15.1 (1.01×) | 15.2 (1.02×) |
| `swap-rows` | 15.4 | 15.3 (0.99×) | 15.5 (1.01×) |
| `remove-row` | 16.3 | 19.9 (1.22×) | 18.4 (1.13×) |
| `clear` | 14.6 | 14.6 (1.00×) | 14.2 (0.97×) |
| **geomean vs react-virtual** | 1.00× | **1.21×** | **1.20×** |

Main-thread CPU (ms):

| scenario | react-virtual | hypen-develop | hypen-nodeid |
|---|---:|---:|---:|
| `create-1k` | 11.0 | 29.7 (2.69×) | 29.9 (2.70×) |
| `replace-1k` | 11.2 | 47.8 (4.28×) | 47.7 (4.27×) |
| `append-1k` | 3.8 | 18.4 (4.80×) | 19.5 (5.08×) |
| `update-10th` | 3.6 | 7.0 (1.94×) | 7.3 (2.02×) |
| `update-all` | 4.4 | 20.0 (4.52×) | 17.7 (4.00×) |
| `select-row` | 3.1 | 5.1 (1.66×) | 4.8 (1.57×) |
| `swap-rows` | 4.6 | 8.3 (1.79×) | 9.3 (2.01×) |
| `remove-row` | 4.6 | 21.2 (4.57×) | 21.2 (4.56×) |
| `clear` | 3.1 | 5.4 (1.71×) | 6.1 (1.93×) |
| **geomean vs react-virtual** | 1.00× | **2.82×** | **2.87×** |

Rows actually in the DOM after each scenario:

| scenario | react-virtual | hypen-develop | hypen-nodeid |
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

| scenario | react | react-virtual | hypen-develop-eager | hypen-develop | hypen-nodeid-eager | hypen-nodeid |
|---|---:|---:|---:|---:|---:|---:|
| `create-1k` | 1000/0/0/1 | 26/0/1/1 | 1000/0/0/1 | 30/0/91/1 | 1000/0/0/1 | 30/0/91/1 |
| `replace-1k` | 1000/1000/0/0 | 26/26/0/0 | 1000/1000/0/0 | 30/30/90/0 | 1000/1000/0/0 | 30/30/90/0 |
| `append-1k` | 1000/0/0/1 | 0/0/1/1 | 1000/0/0/1 | 0/0/31/1 | 1000/0/0/1 | 0/0/31/1 |
| `update-10th` | 0/0/0/100 | 0/0/0/3 | 0/0/100/100 | 0/0/3/3 | 0/0/100/100 | 0/0/3/3 |
| `update-all` | 0/0/0/1000 | 0/0/0/26 | 0/0/1000/1000 | 0/0/30/30 | 0/0/1000/1000 | 0/0/30/30 |
| `select-row` | 0/0/2/0 | 0/0/2/0 | 0/0/2/0 | 0/0/2/0 | 0/0/2/0 | 0/0/2/0 |
| `swap-rows` | 997/997/0/0 | 1/1/0/0 | 2/2/0/0 | 2/2/3/0 | 2/2/0/0 | 2/2/3/0 |
| `remove-row` | 0/1/0/1 | 1/1/1/1 | 0/1/0/1 | 1/1/61/1 | 0/1/0/1 | 1/1/61/1 |
| `clear` | 0/1000/0/1 | 0/26/1/1 | 0/1000/0/1 | 0/30/1/1 | 0/1000/0/1 | 0/30/1/1 |

## Startup, memory, 10,000 rows

| build | ready (ms) | heap empty | heap @1k rows | heap after clear | create 10k (ms) | rows in DOM |
|---|---:|---:|---:|---:|---:|---:|
| `react` | 63.7 | 1.6 MB | 5.6 MB | 2.3 MB | 2810 | 10000 |
| `react-virtual` | 66.9 | 1.7 MB | 2.3 MB | 2.2 MB | 29.9 | 26 |
| `hypen-develop-eager` | 140 | 2.5 MB | 6.1 MB | 3.0 MB | 2935 | 10000 |
| `hypen-develop` | 144 | 2.5 MB | 3.1 MB | 2.9 MB | 180 | 30 |
| `hypen-nodeid-eager` | 140 | 2.5 MB | 6.2 MB | 3.0 MB | 2725 | 10000 |
| `hypen-nodeid` | 150 | 2.5 MB | 3.1 MB | 2.9 MB | 172 | 30 |

Heap is the JS heap after a forced GC; Hypen keeps its node tree in WASM linear memory, which this does not see. The 10k render is a single sample.

## Parity with the React app

50 rows rendered in both, every node compared (tag, text, 39 computed styles, rectangle). Windowed builds are not compared: they render a different number of rows by design.

| build | elements (react / hypen) | mismatches |
|---|---:|---:|
| `hypen-develop-eager` | 899 / 899 | 0 |
| `hypen-nodeid-eager` | 899 / 899 | 0 |

## Spread

Latency, 25th–75th percentile of the pooled samples (ms), and sample count.

| scenario | n | react | react-virtual | hypen-develop-eager | hypen-develop | hypen-nodeid-eager | hypen-nodeid |
|---|---:|---:|---:|---:|---:|---:|---:|
| `create-1k` | 25 | 190–250 | 18.5–19.6 | 235–268 | 23.2–29.5 | 212–258 | 23.7–29.2 |
| `replace-1k` | 15 | 216–241 | 18.2–19.0 | 276–315 | 44.8–51.6 | 252–293 | 43.3–52.4 |
| `append-1k` | 10 | 207–254 | 15.0–15.4 | 260–310 | 16.0–21.8 | 247–278 | 17.2–28.1 |
| `update-10th` | 20 | 23.7–24.9 | 15.1–15.6 | 20.1–25.5 | 15.4–15.8 | 23.6–27.2 | 15.3–16.0 |
| `update-all` | 20 | 43.5–56.8 | 15.7–16.5 | 60.3–67.6 | 17.1–25.3 | 62.4–81.2 | 15.9–18.5 |
| `select-row` | 20 | 16.1–16.8 | 14.5–15.3 | 16.1–16.8 | 14.7–15.4 | 11.9–16.6 | 14.9–15.5 |
| `swap-rows` | 20 | 132–176 | 15.0–15.7 | 15.9–24.8 | 14.9–15.7 | 19.3–23.8 | 15.0–16.1 |
| `remove-row` | 20 | 33.2–39.3 | 16.1–16.9 | 35.3–54.7 | 17.5–27.5 | 35.7–43.0 | 16.8–25.0 |
| `clear` | 20 | 19.9–28.0 | 14.4–14.9 | 32.5–40.9 | 14.5–14.8 | 29.0–34.4 | 13.8–14.5 |

## Replicate

The same builds, run independently on **E2B hypen-bench-4c-8192m (sandbox B)** (Intel(R) Xeon(R) Processor @ 2.60GHz, 4 vCPU, 7957 MB; calibration JS 50.2 ms vs 56.6 ms here). Geomean ratio to the baseline, this run → replicate:

| build | latency | CPU |
|---|---:|---:|
| `hypen-develop-eager` vs `react` | 0.98× → 1.00× | 1.19× → 1.25× |
| `hypen-develop` vs `react-virtual` | 1.21× → 1.25× | 2.82× → 2.78× |
| `hypen-nodeid-eager` vs `react` | 0.93× → 0.95× | 1.09× → 1.12× |
| `hypen-nodeid` vs `react-virtual` | 1.20× → 1.26× | 2.87× → 2.79× |
