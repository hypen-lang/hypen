#!/usr/bin/env bash
#
# Run the desktop renderer's headless perf benchmarks
# (hypen-renderer-desktop/src/perf_bench.rs) the way the perf passes
# have been measuring them: pinned release profile, one suite at a
# time, optionally under a Raspberry-Pi-class CPU quota, optionally
# rendered as FPS.
#
#   scripts/perf-desktop.sh                     # frame matrix (update/scroll/anim × tiers × resolutions)
#   scripts/perf-desktop.sh --sweeps            # resolution + node-count scaling sweeps
#   scripts/perf-desktop.sh --micro             # ingest / style / layout / encode micro-benches
#   scripts/perf-desktop.sh --all               # every perf_bench* suite
#   scripts/perf-desktop.sh --filter NAME       # any test-name filter verbatim
#   scripts/perf-desktop.sh --fps               # append best/typical FPS to each [perf] line
#   scripts/perf-desktop.sh --pi4               # run under a Pi-4-class CPU quota (25%)
#   scripts/perf-desktop.sh --pi5               # run under a Pi-5-class CPU quota (65%)
#   scripts/perf-desktop.sh --quota 40          # arbitrary CPU quota percentage
#   scripts/perf-desktop.sh --build-only        # just build the bench binary
#
# Profile: LTO off / opt-level 3 / 16 codegen units — measured
# indistinguishable from the shipping profile for these CPU-bound
# benches, and it keeps the edit-measure loop to seconds instead of
# minutes. Keep the same flags on BOTH sides of any comparison.
#
# Comparing against another revision (e.g. main): perf_bench.rs keeps
# each frame's invalidation/relayout recipe between
# "── invalidation recipe ──" markers — check out the other revision,
# swap the marked recipe bodies to match that revision's
# App::flush_patches / App::redraw behaviour, and run this script with
# identical flags on both sides.
#
# Pi-class runs use a Linux cgroup CPU quota (cgroup v1 or v2, needs
# root or delegated write access to /sys/fs/cgroup). The quota models
# CPU *throughput*, not a real Pi's per-core IPC or memory bandwidth:
# treat the ratios between configurations as the signal and confirm
# absolute numbers on hardware. Quota period is 4000µs, so frames
# under ~1ms at --pi4 fit inside a single scheduler slice — medians
# that jump far above the mins indicate frames straddling the slice
# boundary (duty-cycle stalls), which is itself useful signal about
# contended-scheduler behaviour.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PROFILE_ENV=(
  CARGO_PROFILE_RELEASE_LTO=off
  CARGO_PROFILE_RELEASE_OPT_LEVEL=3
  CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16
)

filter="perf_bench_frame_update_matrix"
quota_pct=""
quota_label=""
fps=0
build_only=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --matrix)     filter="perf_bench_frame_update_matrix"; shift ;;
    --sweeps)     filter="perf_bench_scaling"; shift ;;
    --micro)      filter="perf_bench_patch_ingest perf_bench_style_resolution perf_bench_layout_pass_feed perf_bench_scene_encode"; shift ;;
    --all)        filter="perf_bench"; shift ;;
    --filter)     filter="$2"; shift 2 ;;
    --fps)        fps=1; shift ;;
    --pi4)        quota_pct=25; quota_label="Pi-4-class"; shift ;;
    --pi5)        quota_pct=65; quota_label="Pi-5-class"; shift ;;
    --quota)      quota_pct="$2"; quota_label="${2}%-quota"; shift 2 ;;
    --build-only) build_only=1; shift ;;
    -h|--help)    sed -n '2,44p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "error: unknown argument '$1' (see --help)" >&2; exit 1 ;;
  esac
done

echo "==> building bench binary (release, pinned profile)"
env "${PROFILE_ENV[@]}" \
  cargo test --release -p hypen-renderer-desktop --lib --no-run --quiet
if [[ "$build_only" == 1 ]]; then
  exit 0
fi

# The measured command. Runs through cargo so we never have to guess
# the hashed test-binary path; the binary is prebuilt above, so cargo
# adds only startup overhead, outside every timed region.
run_benches() {
  # shellcheck disable=SC2086  # $filter is deliberately word-split:
  # libtest treats each word as an OR'd name filter.
  env "${PROFILE_ENV[@]}" \
    cargo test --release -p hypen-renderer-desktop --lib --quiet -- \
    --ignored $filter --nocapture --test-threads=1
}

# ---------------------------------------------------------------------------
# CPU quota (Pi-class) plumbing: create a cgroup with quota/period =
# quota_pct%, move THIS shell into it (children inherit), run, clean up.
# Period 4000µs; the kernel's minimum quota is 1000µs, hence pct >= 25
# at this period — smaller percentages get a proportionally longer
# period so the duty cycle stays representable.
# ---------------------------------------------------------------------------
CG_NAME="hypen-perf-desktop-$$"
CG_DIR=""

cleanup_cgroup() {
  if [[ -n "$CG_DIR" && -d "$CG_DIR" ]]; then
    # Move ourselves back out so the group can be removed.
    if [[ -w "$(dirname "$CG_DIR")/cgroup.procs" ]]; then
      echo "$$" > "$(dirname "$CG_DIR")/cgroup.procs" 2>/dev/null || true
    fi
    rmdir "$CG_DIR" 2>/dev/null || true
  fi
}
trap cleanup_cgroup EXIT

enter_quota_cgroup() {
  local pct="$1"
  local period_us=4000
  local quota_us=$(( period_us * pct / 100 ))
  if (( quota_us < 1000 )); then
    period_us=$(( 1000 * 100 / pct ))
    quota_us=1000
  fi

  if [[ -w /sys/fs/cgroup/cgroup.procs ]] || [[ -f /sys/fs/cgroup/cgroup.controllers ]]; then
    # cgroup v2 (unified hierarchy)
    CG_DIR="/sys/fs/cgroup/$CG_NAME"
    mkdir "$CG_DIR" 2>/dev/null || {
      echo "error: cannot create $CG_DIR — Pi-class runs need root (or a delegated cgroup)" >&2
      exit 1
    }
    # The cpu controller must be enabled for the child; ignore failure
    # when it already is.
    echo "+cpu" > /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null || true
    echo "$quota_us $period_us" > "$CG_DIR/cpu.max"
    echo "$$" > "$CG_DIR/cgroup.procs"
  elif [[ -d /sys/fs/cgroup/cpu ]]; then
    # cgroup v1
    CG_DIR="/sys/fs/cgroup/cpu/$CG_NAME"
    mkdir "$CG_DIR" 2>/dev/null || {
      echo "error: cannot create $CG_DIR — Pi-class runs need root (or a delegated cgroup)" >&2
      exit 1
    }
    echo "$period_us" > "$CG_DIR/cpu.cfs_period_us"
    echo "$quota_us"  > "$CG_DIR/cpu.cfs_quota_us"
    echo "$$" > "$CG_DIR/cgroup.procs"
  else
    echo "error: no cgroup cpu controller found; Pi-class quota runs are Linux-only" >&2
    exit 1
  fi
  echo "==> CPU quota: ${pct}% (${quota_us}µs / ${period_us}µs, cgroup $CG_DIR)"
}

# ---------------------------------------------------------------------------
# FPS rendering: append "best / typical" frames-per-second to each
# [perf] line, derived from the min / median frame times. These are
# CPU frame-budget indicators (how many frames the CPU work could
# sustain), not display refresh rates.
# ---------------------------------------------------------------------------
render_fps() {
  python3 -c '
import re, sys

UNITS = {"ns": 1e-6, "µs": 1e-3, "us": 1e-3, "ms": 1.0, "s": 1e3}

def to_ms(num, unit):
    return float(num) * UNITS[unit]

def fps(ms):
    if ms <= 0:
        return "inf"
    v = 1000.0 / ms
    return f"{v:,.0f}" if v >= 10 else f"{v:.1f}"

pat = re.compile(
    r"min\s+([0-9.]+)(ns|µs|us|ms|s)\s+median\s+([0-9.]+)(ns|µs|us|ms|s)"
)
for line in sys.stdin:
    line = line.rstrip("\n")
    m = pat.search(line)
    if m and line.lstrip().startswith("[perf]"):
        best = fps(to_ms(m.group(1), m.group(2)))
        typical = fps(to_ms(m.group(3), m.group(4)))
        print(f"{line}   -> {best} / {typical} fps (best/typical)")
    else:
        print(line)
'
}

if [[ -n "$quota_pct" ]]; then
  echo "==> mode: $quota_label"
  enter_quota_cgroup "$quota_pct"
fi

echo "==> running: $filter"
if [[ "$fps" == 1 ]]; then
  run_benches | render_fps
else
  run_benches
fi
