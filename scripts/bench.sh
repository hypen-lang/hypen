#!/usr/bin/env bash
#
# Run the React vs Hypen benchmark from the repo root.
#
#   scripts/bench.sh                  # install, build, measure, write the report
#   scripts/bench.sh --parity         # structural diff only (fast, ~20s)
#   scripts/bench.sh --profile        # CPU profile of one Hypen interaction
#   scripts/bench.sh --report         # regenerate REPORT.md from existing results
#   scripts/bench.sh --quick          # scenarios only: skip the 10k probe + parity
#   scripts/bench.sh -- --only=create-1k,swap-rows      # pass args to the driver
#
# Results land in benchmarks/react-vs-hypen/results/ (results.json, REPORT.md,
# parity.json and the two parity screenshots).
#
# A full run takes roughly 20 minutes, most of it waiting on Hypen: a
# 1,000-row render costs it ~9s against React's ~0.3s, and every scenario
# rebuilds that list several times. --quick trims the two slowest optional
# steps; --only trims the scenario list.
#
# The build step (`bun run build` in the benchmark) compiles the
# @hypen-space/core and /web dists and copies the browser WASM engine into
# the Hypen app. It deliberately does NOT run wasm-pack: the benchmark uses
# the engine artifact checked in at
# hypen-web/packages/web-engine/wasm-browser/. To benchmark engine changes,
# run scripts/build-wasm.sh first.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BENCH_DIR="$REPO_ROOT/benchmarks/react-vs-hypen"

if ! command -v bun >/dev/null 2>&1; then
  echo "error: bun is required (https://bun.sh)" >&2
  exit 1
fi

cd "$BENCH_DIR"

mode="full"
driver_args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --parity)  mode="parity"; shift ;;
    --profile) mode="profile"; shift ;;
    --report)  mode="report"; shift ;;
    --quick)   mode="full"; driver_args+=(--skip-scaling --skip-parity); shift ;;
    --)        shift; driver_args+=("$@"); break ;;
    *)         driver_args+=("$1"); shift ;;
  esac
done

if [[ ! -d node_modules ]]; then
  echo "==> installing benchmark dependencies"
  bun install
fi

if [[ "$mode" == "report" ]]; then
  bun bench/report.ts
  echo "==> benchmarks/react-vs-hypen/results/REPORT.md"
  exit 0
fi

echo "==> building both apps"
bun run build

case "$mode" in
  parity)
    bun bench/parity.ts "${driver_args[@]}"
    ;;
  profile)
    bun run build:profile
    bun bench/profile.ts "${driver_args[@]}"
    ;;
  full)
    bun bench/run.ts "${driver_args[@]}"
    bun bench/report.ts
    echo "==> benchmarks/react-vs-hypen/results/REPORT.md"
    ;;
esac
