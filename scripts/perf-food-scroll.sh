#!/usr/bin/env bash
# Warm, end-to-end Food-grid scroll benchmark. Pass an optional output path to
# keep a baseline for before/after comparison:
#   scripts/perf-food-scroll.sh /tmp/food-scroll-before.txt
# Diagnostic variants can override HYPEN_FOOD_BENCH_IMAGES (0..30),
# HYPEN_FOOD_BENCH_IMAGE_WIDTH, and HYPEN_FOOD_BENCH_IMAGE_HEIGHT.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

run_benchmark() {
  CARGO_PROFILE_RELEASE_LTO=off \
  CARGO_PROFILE_RELEASE_OPT_LEVEL=3 \
  CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16 \
    cargo test --release -p hypen-renderer-desktop --lib \
      perf_bench_food_grid_scroll -- \
      --ignored --nocapture --test-threads=1
}

if [[ $# -gt 1 ]]; then
  echo "usage: $0 [output-file]" >&2
  exit 2
elif [[ $# == 1 ]]; then
  run_benchmark 2>&1 | tee "$1"
else
  run_benchmark
fi
