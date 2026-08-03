#!/usr/bin/env bash
#
# Run the Cloudflare example apps locally with `wrangler dev`.
#
#   scripts/dev-examples.sh                  # launcher set: home-screen simple todo calculator
#   scripts/dev-examples.sh all              # every example with a CF worker
#   scripts/dev-examples.sh todo calculator  # just these
#   scripts/dev-examples.sh --fresh ...      # force-rebuild WASM + package dists first
#
# Then open http://localhost:8787 (the home-screen launcher embeds the others).
#
# This script exists because three non-obvious things must line up before
# `wrangler dev` works from a fresh clone:
#
#   1. WASM first. The examples depend on `hypen-engine` as
#      `file:../../../hypen-engine-rs/pkg/web` — a build artifact that does
#      not exist in a fresh checkout. Same for the @hypen-space/* package
#      dists (wrangler's esbuild resolves the `import` export condition,
#      which points at dist/).
#
#   2. bun installs `file:` deps as per-file SYMLINK farms, and esbuild
#      resolves each symlink to its real path — so imports inside
#      @hypen-space/cf re-resolve from hypen-web/packages/cf/ (no
#      node_modules there) and the build fails with
#      'Could not resolve "hypen-engine"'. Workaround: dereference the
#      local packages into real copies (cp -rL) after install.
#
#   3. Every `wrangler dev` defaults its debugging inspector to port 9230;
#      concurrent instances need distinct --inspector-port values or the
#      second one dies with "Address already in use (127.0.0.1:9230)".
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINE_DIR="$REPO_ROOT/hypen-engine-rs"
WEB_DIR="$REPO_ROOT/hypen-web"
LOG_DIR="${TMPDIR:-/tmp}/hypen-dev-examples"
mkdir -p "$LOG_DIR"

# name -> "relative-dir http-port" (ports must match examples/home-screen APPS)
declare -A EXAMPLES=(
  [home-screen]="examples/home-screen/cloudflare 8787"
  [simple]="examples/simple/cf 8788"
  [todo]="examples/todo/cloudflare 8789"
  [calorie-counter]="examples/calorie-counter/cloudflare 8790"
  [movie-discovery]="examples/movie-discovery/cloudflare 8791"
  [food-ordering]="examples/food-ordering/cloudflare 8792"
  [social]="examples/social/cloudflare 8793"
  [calculator]="examples/calculator/cloudflare 8794"
)
DEFAULT_SET=(home-screen simple todo calculator)
ALL_SET=(home-screen simple todo calorie-counter movie-discovery food-ordering social calculator)

FRESH=0
SELECTED=()
for arg in "$@"; do
  case "$arg" in
    --fresh) FRESH=1 ;;
    all) SELECTED=("${ALL_SET[@]}") ;;
    *)
      if [[ -z "${EXAMPLES[$arg]:-}" ]]; then
        echo "Unknown example '$arg'. Known: ${!EXAMPLES[*]}" >&2
        exit 1
      fi
      SELECTED+=("$arg")
      ;;
  esac
done
[[ ${#SELECTED[@]} -eq 0 ]] && SELECTED=("${DEFAULT_SET[@]}")

command -v bun >/dev/null || { echo "bun is required (https://bun.sh)" >&2; exit 1; }

# ---- 1. Engine WASM (web target) ----------------------------------------
if [[ $FRESH -eq 1 || ! -f "$ENGINE_DIR/pkg/web/package.json" ]]; then
  echo "==> Building engine WASM (pkg/web)..."
  (cd "$ENGINE_DIR" && bun x wasm-pack build --target web --out-dir pkg/web --features js)
fi

# ---- 2. hypen-web package dists ------------------------------------------
if [[ $FRESH -eq 1 || ! -f "$WEB_DIR/packages/cf/dist/index.js" ]]; then
  echo "==> Building @hypen-space packages (core, web, cf)..."
  (cd "$WEB_DIR" && bun install && bun run build:core && bun run build:web)
  (cd "$WEB_DIR/packages/cf" && bun run build)
fi

# ---- 3. Install + dereference each example --------------------------------
# bun links file: deps as per-file symlinks; esbuild realpaths them, which
# breaks bare-import resolution inside the linked packages. Replace the
# local packages with real copies.
dereference() {
  local dir="$1"
  for pkg in "@hypen-space/cf" "@hypen-space/core" "@hypen-space/web" "hypen-engine"; do
    local src="$dir/node_modules/$pkg"
    [[ -d "$src" ]] || continue
    rm -rf "$src.real"
    cp -rL "$src" "$src.real" 2>/dev/null || true
    rm -rf "$src" && mv "$src.real" "$src"
  done
}

for name in "${SELECTED[@]}"; do
  read -r rel _port <<<"${EXAMPLES[$name]}"
  dir="$REPO_ROOT/$rel"
  echo "==> Installing $name ($rel)..."
  (cd "$dir" && bun install --silent)
  dereference "$dir"
  # Keep the engine copy current with the latest WASM build.
  rm -rf "$dir/node_modules/hypen-engine"
  cp -rL "$ENGINE_DIR/pkg/web" "$dir/node_modules/hypen-engine"
done

# ---- 4. Launch -------------------------------------------------------------
PIDS=()
cleanup() {
  echo
  echo "==> Stopping dev servers..."
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

inspector=9230
for name in "${SELECTED[@]}"; do
  read -r rel port <<<"${EXAMPLES[$name]}"
  dir="$REPO_ROOT/$rel"
  log="$LOG_DIR/$name.log"
  echo "==> Starting $name on :$port (inspector :$inspector, log: $log)"
  (cd "$dir" && bun x wrangler dev --port "$port" --inspector-port "$inspector" >"$log" 2>&1) &
  PIDS+=($!)
  inspector=$((inspector + 1))
done

# ---- 5. Wait for readiness -------------------------------------------------
echo "==> Waiting for servers..."
for name in "${SELECTED[@]}"; do
  read -r _rel port <<<"${EXAMPLES[$name]}"
  for _i in $(seq 1 60); do
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 "http://localhost:$port/" || true)
    [[ "$code" == "200" ]] && break
    sleep 2
  done
  if [[ "${code:-}" == "200" ]]; then
    echo "    $name  http://localhost:$port/  OK"
  else
    echo "    $name  http://localhost:$port/  NOT READY (see $LOG_DIR/$name.log)" >&2
  fi
done

echo
echo "Launcher: http://localhost:8787  (Ctrl-C stops everything)"
wait
