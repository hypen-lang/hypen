# React vs Hypen — version matrix

Run 2026-11-10 16:25 UTC on **E2B hypen-bench-4c-8192m (sandbox A)**: Intel(R) Xeon(R) Processor @ 2.60GHz, 4 vCPU, 7957 MB, linux x64 6.1.189+. Chromium 151.0.7922.34, Bun 1.4.4. 5 interleaved rounds, 16 min.

Every build below ran in the same process against the same browser on the same machine, round-robin, with the starting build rotated every scenario (`bench/matrix.ts`). Cells are the median of all samples pooled across rounds.

## Builds

| build | what it is | list | JS (gzip) | WASM (gzip) |
|---|---:|---:|---:|---:|
| `react` | apps/react | every row in the DOM | 197 kB (63 kB) | – |
| `hypen-0.6.4` | npm @hypen-space/*@0.6.4 | every row in the DOM | 440 kB (125 kB) | 2185 kB (683 kB) |
| `hypen-0.6.5` | npm @hypen-space/*@0.6.5 | every row in the DOM | 611 kB (175 kB) | 2386 kB (741 kB) |
| `hypen-0.6.6` | npm @hypen-space/*@0.6.6 | every row in the DOM | 635 kB (179 kB) | 3114 kB (913 kB) |
| `hypen-0.6.7` | npm @hypen-space/*@0.6.7 | every row in the DOM | 616 kB (177 kB) | 4313 kB (748 kB) |
| `hypen-develop-eager` | checkout bf5f766 (List lazy: false) | every row in the DOM | 632 kB (182 kB) | 1656 kB (585 kB) |
| `hypen-develop` | checkout bf5f766 | windowed | 632 kB (182 kB) | 1656 kB (585 kB) |
| `react-virtual` | apps/react | windowed | 232 kB (73 kB) | – |

## Host stability

A fixed framework-free workload runs at the start of every round. Across 5 rounds: JS 46.0–54.4 ms (±8.7%), DOM build + layout 112–152 ms (±17.5%). Load average 0.23 at start, 1.03 at end. Differences between builds smaller than that spread are noise.

## Every row in the DOM — interaction latency

Click to post-paint of the last mutated frame, in ms, and the ratio to `react` (above 1× is slower than React). This number is rounded up to a frame boundary, so anything that fits in one frame reads ~16 ms for everyone.

| scenario | react | hypen-0.6.4 | hypen-0.6.5 | hypen-0.6.6 | hypen-0.6.7 | hypen-develop-eager |
|---|---:|---:|---:|---:|---:|---:|
| `create-1k` | 177 | 401 (2.26×) | 212 (1.20×) | 205 (1.16×) | 209 (1.18×) | 215 (1.21×) |
| `replace-1k` | 190 | 793 (4.17×) | 257 (1.35×) | 254 (1.33×) | 259 (1.36×) | 257 (1.35×) |
| `append-1k` | 170 | 550 (3.24×) | 243 (1.43×) | 234 (1.38×) | 244 (1.44×) | 236 (1.39×) |
| `update-10th` | 22.0 | 34.6 (1.57×) | 22.4 (1.01×) | 22.2 (1.01×) | 22.5 (1.02×) | 21.3 (0.97×) |
| `update-all` | 36.9 | 109 (2.96×) | 53.2 (1.44×) | 54.2 (1.47×) | 55.0 (1.49×) | 53.2 (1.44×) |
| `select-row` | 16.4 | 21.2 (1.29×) | 16.2 (0.99×) | 16.3 (0.99×) | 16.1 (0.98×) | 16.2 (0.98×) |
| `swap-rows` | 105 | 28.3 (0.27×) | 20.8 (0.20×) | 21.1 (0.20×) | 20.8 (0.20×) | 20.8 (0.20×) |
| `remove-row` | 29.1 | 51.7 (1.78×) | 35.2 (1.21×) | 35.8 (1.23×) | 33.6 (1.15×) | 33.1 (1.14×) |
| `clear` | 16.3 | 137 (8.44×) | 34.3 (2.11×) | 33.0 (2.03×) | 32.5 (2.00×) | 32.3 (1.98×) |
| **geomean vs react** | 1.00× | **2.08×** | **1.06×** | **1.05×** | **1.05×** | **1.04×** |

## Every row in the DOM — main-thread CPU per interaction

Chromium's `TaskDuration` counter, read before and after each interaction (script + WASM + style + layout + paint on the main thread), in ms. Not frame-quantised, so it separates the builds on the small updates.

| scenario | react | hypen-0.6.4 | hypen-0.6.5 | hypen-0.6.6 | hypen-0.6.7 | hypen-develop-eager |
|---|---:|---:|---:|---:|---:|---:|
| `create-1k` | 186 | 403 (2.17×) | 221 (1.19×) | 220 (1.19×) | 223 (1.20×) | 221 (1.19×) |
| `replace-1k` | 199 | 817 (4.11×) | 290 (1.46×) | 274 (1.38×) | 290 (1.46×) | 287 (1.44×) |
| `append-1k` | 187 | 567 (3.03×) | 248 (1.32×) | 258 (1.38×) | 258 (1.38×) | 254 (1.36×) |
| `update-10th` | 11.5 | 35.8 (3.12×) | 22.9 (2.00×) | 25.1 (2.19×) | 22.4 (1.96×) | 23.5 (2.05×) |
| `update-all` | 36.5 | 116 (3.19×) | 58.4 (1.60×) | 57.4 (1.57×) | 59.0 (1.62×) | 55.8 (1.53×) |
| `select-row` | 3.5 | 22.3 (6.32×) | 18.2 (5.16×) | 17.0 (4.82×) | 14.6 (4.15×) | 18.1 (5.13×) |
| `swap-rows` | 112 | 29.2 (0.26×) | 25.9 (0.23×) | 23.5 (0.21×) | 22.2 (0.20×) | 23.2 (0.21×) |
| `remove-row` | 17.4 | 53.5 (3.07×) | 38.9 (2.24×) | 44.1 (2.53×) | 38.4 (2.21×) | 40.4 (2.32×) |
| `clear` | 16.7 | 148 (8.84×) | 38.8 (2.32×) | 37.3 (2.23×) | 36.1 (2.16×) | 35.1 (2.10×) |
| **geomean vs react** | 1.00× | **2.84×** | **1.53×** | **1.52×** | **1.46×** | **1.50×** |

## Windowed lists

`react-virtual` is the React app with TanStack Virtual; the Hypen build is one whose `List` is virtualized by default. Both keep only the rows near the viewport in the DOM, so most interactions fit in a single frame and the latency column is mostly the frame clock — read the CPU column.

Latency (ms):

| scenario | react-virtual | hypen-develop |
|---|---:|---:|
| `create-1k` | 18.5 | 25.5 (1.38×) |
| `replace-1k` | 18.4 | 44.2 (2.40×) |
| `append-1k` | 15.8 | 24.1 (1.53×) |
| `update-10th` | 15.8 | 15.8 (1.00×) |
| `update-all` | 16.6 | 17.0 (1.02×) |
| `select-row` | 15.6 | 15.6 (1.00×) |
| `swap-rows` | 15.9 | 15.8 (0.99×) |
| `remove-row` | 16.5 | 17.4 (1.05×) |
| `clear` | 15.3 | 15.2 (1.00×) |
| **geomean vs react-virtual** | 1.00× | **1.21×** |

Main-thread CPU (ms):

| scenario | react-virtual | hypen-develop |
|---|---:|---:|
| `create-1k` | 9.2 | 29.6 (3.21×) |
| `replace-1k` | 9.5 | 45.2 (4.74×) |
| `append-1k` | 3.0 | 24.8 (8.34×) |
| `update-10th` | 2.6 | 9.3 (3.61×) |
| `update-all` | 3.7 | 16.5 (4.46×) |
| `select-row` | 2.1 | 7.5 (3.55×) |
| `swap-rows` | 3.0 | 10.4 (3.44×) |
| `remove-row` | 3.3 | 17.7 (5.32×) |
| `clear` | 2.2 | 4.5 (2.03×) |
| **geomean vs react-virtual** | 1.00× | **4.01×** |

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

| scenario | react | hypen-0.6.4 | hypen-0.6.5 | hypen-0.6.6 | hypen-0.6.7 | hypen-develop-eager | hypen-develop | react-virtual |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `create-1k` | 1000/0/0/1 | 1000/0/4000/1 | 1000/0/0/1 | 1000/0/0/1 | 1000/0/0/1 | 1000/0/0/1 | 30/0/91/1 | 26/0/1/1 |
| `replace-1k` | 1000/1000/0/0 | 1000/1000/7000/0 | 1000/1000/0/0 | 1000/1000/0/0 | 1000/1000/0/0 | 1000/1000/0/0 | 30/30/180/0 | 26/26/0/0 |
| `append-1k` | 1000/0/0/1 | 1000/0/4000/1 | 1000/0/0/1 | 1000/0/0/1 | 1000/0/0/1 | 1000/0/0/1 | 0/0/31/1 | 0/0/1/1 |
| `update-10th` | 0/0/0/100 | 0/0/0/100 | 0/0/100/100 | 0/0/100/100 | 0/0/100/100 | 0/0/100/100 | 0/0/3/3 | 0/0/0/3 |
| `update-all` | 0/0/0/1000 | 0/0/0/1000 | 0/0/1000/1000 | 0/0/1000/1000 | 0/0/1000/1000 | 0/0/1000/1000 | 0/0/30/30 | 0/0/0/26 |
| `select-row` | 0/0/2/0 | 0/0/2/0 | 0/0/2/0 | 0/0/2/0 | 0/0/2/0 | 0/0/2/0 | 0/0/2/0 | 0/0/2/0 |
| `swap-rows` | 997/997/0/0 | 2/2/8/0 | 2/2/0/0 | 2/2/0/0 | 2/2/0/0 | 2/2/0/0 | 2/2/6/0 | 1/1/0/0 |
| `remove-row` | 0/1/0/1 | 0/1/3/1 | 0/1/0/1 | 0/1/0/1 | 0/1/0/1 | 0/1/0/1 | 1/1/64/1 | 1/1/1/1 |
| `clear` | 0/1000/0/1 | 0/1000/3000/1 | 0/1000/0/1 | 0/1000/0/1 | 0/1000/0/1 | 0/1000/0/1 | 0/30/91/1 | 0/26/1/1 |

## Startup, memory, 10,000 rows

| build | ready (ms) | heap empty | heap @1k rows | heap after clear | create 10k (ms) | rows in DOM |
|---|---:|---:|---:|---:|---:|---:|
| `react` | 56.9 | 1.6 MB | 5.6 MB | 2.3 MB | – | – |
| `hypen-0.6.4` | 116 | 2.2 MB | 6.3 MB | 2.6 MB | – | – |
| `hypen-0.6.5` | 125 | 2.4 MB | 6.2 MB | 2.9 MB | – | – |
| `hypen-0.6.6` | 128 | 2.5 MB | 6.2 MB | 3.0 MB | – | – |
| `hypen-0.6.7` | 120 | 2.5 MB | 6.2 MB | 2.9 MB | – | – |
| `hypen-develop-eager` | 119 | 2.5 MB | 6.1 MB | 3.0 MB | – | – |
| `hypen-develop` | 122 | 2.5 MB | 3.1 MB | 2.9 MB | – | – |
| `react-virtual` | 55.1 | 1.7 MB | 2.3 MB | 2.2 MB | – | – |

Heap is the JS heap after a forced GC; Hypen keeps its node tree in WASM linear memory, which this does not see. The 10k render is a single sample.

## Spread

Latency, 25th–75th percentile of the pooled samples (ms), and sample count.

| scenario | n | react | hypen-0.6.4 | hypen-0.6.5 | hypen-0.6.6 | hypen-0.6.7 | hypen-develop-eager | hypen-develop | react-virtual |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `create-1k` | 25 | 154–190 | 385–414 | 191–221 | 191–218 | 193–224 | 191–222 | 24.0–29.2 | 18.3–18.9 |
| `replace-1k` | 15 | 166–201 | 778–825 | 247–277 | 242–263 | 251–284 | 255–280 | 39.2–51.1 | 18.1–18.7 |
| `append-1k` | 10 | 154–182 | 518–576 | 216–252 | 228–254 | 227–259 | 222–246 | 23.6–25.1 | 15.5–16.0 |
| `update-10th` | 20 | 21.6–23.3 | 33.8–36.6 | 21.5–23.6 | 20.5–24.0 | 21.4–23.1 | 20.6–23.7 | 15.7–16.0 | 15.6–15.9 |
| `update-all` | 20 | 34.9–39.1 | 105–121 | 50.7–60.2 | 52.6–63.0 | 53.2–58.4 | 50.2–56.7 | 16.5–18.1 | 16.3–16.8 |
| `select-row` | 20 | 16.2–16.5 | 20.8–22.8 | 12.0–16.5 | 13.5–16.6 | 15.1–16.4 | 14.3–16.6 | 15.5–15.7 | 15.5–15.7 |
| `swap-rows` | 20 | 95.5–108 | 27.7–29.4 | 19.5–22.2 | 18.7–22.5 | 20.0–22.3 | 19.9–21.4 | 15.8–16.0 | 15.8–16.3 |
| `remove-row` | 20 | 28.1–30.7 | 49.7–53.9 | 33.5–37.4 | 33.9–41.7 | 33.0–35.0 | 31.7–35.2 | 16.7–18.9 | 16.4–16.6 |
| `clear` | 20 | 15.8–17.2 | 130–153 | 31.2–35.8 | 31.2–35.5 | 31.1–33.8 | 31.2–33.5 | 15.1–15.3 | 15.0–15.4 |

## Replicate

The same builds, run independently on **E2B hypen-bench-4c-8192m (sandbox B)** (Intel(R) Xeon(R) Processor @ 2.60GHz, 4 vCPU, 7957 MB; calibration JS 42.0 ms vs 48.2 ms here). Geomean ratio to the baseline, this run → replicate:

| build | latency | CPU |
|---|---:|---:|
| `hypen-0.6.4` vs `react` | 2.08× → 2.13× | 2.84× → 2.97× |
| `hypen-0.6.5` vs `react` | 1.06× → 1.05× | 1.53× → 1.56× |
| `hypen-0.6.6` vs `react` | 1.05× → 1.05× | 1.52× → 1.64× |
| `hypen-0.6.7` vs `react` | 1.05× → 1.05× | 1.46× → 1.61× |
| `hypen-develop-eager` vs `react` | 1.04× → 1.06× | 1.50× → 1.59× |
| `hypen-develop` vs `react-virtual` | 1.21× → 1.19× | 4.01× → 4.01× |
