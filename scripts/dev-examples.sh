#!/usr/bin/env bash
#
# Run the Cloudflare example apps locally with `wrangler dev`.
#
#   scripts/dev-examples.sh                  # launcher set: home-screen todo calculator
#   scripts/dev-examples.sh all              # every example with a CF worker
#   scripts/dev-examples.sh todo calculator  # just these
#   scripts/dev-examples.sh --local ...      # run against this checkout's engine + packages
#   scripts/dev-examples.sh --local --fresh  # ...rebuilding the package dists first
#
# Then open http://localhost:8787 (the home-screen launcher embeds the others;
# its icons point at the local ports below by default).
#
# The examples depend on the PUBLISHED @hypen-space/* and hypen-engine
# packages, so a plain `bun install && bun run dev` in any example works from a
# fresh clone — no WASM build, no `file:` links. This script just runs several
# of them at once, which needs a few things lined up:
#
#   1. Fixed ports. examples/home-screen's launcher points each icon at
#      ws://localhost:<port>/ws (src/endpoints.ts); the table below must match.
#
#   2. Every `wrangler dev` defaults its debugging inspector to port 9230;
#      concurrent instances need distinct --inspector-port values or the
#      second one dies with "Address already in use (127.0.0.1:9230)".
#      Set HYPEN_EXAMPLES_INSPECTOR_BASE to move the range (default 9230).
#
#   3. wrangler dev fronts the Worker with its own ProxyWorker, pinned to
#      compatibilityDate 2023-12-18 — so it re-negotiates permessage-deflate
#      WITH context takeover toward the browser even when the example sets
#      `no_web_socket_compression`. Browsers then keep the connection UI-only
#      (RFC 001 §2.3: no device plane, no uploads). The script adds the same
#      flag to the installed wrangler's ProxyWorker. Local dev only; deployed
#      Workers take the flag from wrangler.jsonc.
#
#   4. (--local only) To test unreleased engine/SDK changes, the installed
#      hypen-engine and @hypen-space/{core,web,cf} are overwritten with this
#      checkout's builds: hypen-engine-rs/pkg/web (build it with
#      `cd hypen-engine-rs && ./build-wasm.sh`) and the hypen-web package
#      dists (rebuilt here when stale or with --fresh). The local engine
#      build includes the device broker; the published 0.6.5 one may not, in
#      which case wrangler logs "Device plane off: no device broker … —
#      sessions stay UI-only" and device features (e.g. home-screen's Files
#      uploads) are unavailable. Everything else works without --local.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINE_DIR="$REPO_ROOT/hypen-engine-rs"
WEB_DIR="$REPO_ROOT/hypen-web"
LOG_DIR="${TMPDIR:-/tmp}/hypen-dev-examples"
mkdir -p "$LOG_DIR"

# name -> "relative-dir http-port" (ports must match examples/home-screen/cloudflare/src/launcher.ts APPS)
#
# Deliberately NOT a `declare -A` associative array: macOS still ships bash
# 3.2, which has none. Worse, it fails obscurely rather than loudly — bash
# 3.2 parses `[home-screen]=` as an arithmetic subscript, so `set -u` aborts
# with "home: unbound variable" (it read `home - screen`). A newline-delimited
# table + a lookup function works on every bash.
EXAMPLES_TABLE="
home-screen examples/home-screen/cloudflare 8787
simple examples/simple/cf 8788
todo examples/todo/cloudflare 8789
calorie-counter examples/calorie-counter/cloudflare 8790
movie-discovery examples/movie-discovery/cloudflare 8791
food-ordering examples/food-ordering/cloudflare 8792
social examples/social/cloudflare 8793
calculator examples/calculator/cloudflare 8794
hypeflix examples/hypeflix/cloudflare 8795
"

# Echoes "relative-dir http-port" for a known name, nothing for an unknown one.
example_entry() {
  local want="$1" name rel port
  while read -r name rel port; do
    [[ -z "$name" ]] && continue
    if [[ "$name" == "$want" ]]; then
      echo "$rel $port"
      return 0
    fi
  done <<<"$EXAMPLES_TABLE"
  return 1
}

example_names() {
  while read -r name _rel _port; do
    [[ -z "$name" ]] && continue
    echo "$name"
  done <<<"$EXAMPLES_TABLE"
}

DEFAULT_SET=(home-screen todo calculator)
ALL_SET=(home-screen simple todo calorie-counter movie-discovery food-ordering social calculator hypeflix)

FRESH=0
LOCAL=0
SELECTED=()
for arg in "$@"; do
  case "$arg" in
    --fresh) FRESH=1; LOCAL=1 ;;
    --local) LOCAL=1 ;;
    all) SELECTED=("${ALL_SET[@]}") ;;
    *)
      if ! example_entry "$arg" >/dev/null; then
        echo "Unknown example '$arg'. Known: $(example_names | tr '\n' ' ')" >&2
        exit 1
      fi
      SELECTED+=("$arg")
      ;;
  esac
done
[[ ${#SELECTED[@]} -eq 0 ]] && SELECTED=("${DEFAULT_SET[@]}")

command -v bun >/dev/null || { echo "bun is required (https://bun.sh)" >&2; exit 1; }

# ---- 1. Engine WASM (web target, --local only) ---------------------------
if [[ $LOCAL -eq 1 && ! -f "$ENGINE_DIR/pkg/web/package.json" ]]; then
  echo "--local needs the engine's web build at hypen-engine-rs/pkg/web." >&2
  echo "Build it first:  (cd hypen-engine-rs && ./build-wasm.sh)" >&2
  exit 1
fi

# ---- 2. hypen-web package dists ------------------------------------------
# Rebuild when missing OR stale: an existence-only check served examples a
# pre-existing dist even after renderer sources changed, which silently runs
# old renderer code against new templates (e.g. Video composition slots
# rendered as invisible <video> fallback children — no controls at all).
dists_stale() {
  local pkg src_dir marker
  # The cf client bundle (generic.js) bundles core+web sources, so EVERY
  # package's dist must be newer than EVERY package's src — a core/web
  # source change with an untouched cf/src still stales generic.js.
  # device-web rides inside generic.js too (the client's DeviceHost).
  local markers=(
    "$WEB_DIR/packages/core/dist/index.js"
    "$WEB_DIR/packages/web/dist/index.js"
    "$WEB_DIR/packages/device-web/dist/index.js"
    "$WEB_DIR/packages/cf/dist/index.js"
    "$WEB_DIR/packages/cf/dist/client/generic.js"
  )
  for marker in "${markers[@]}"; do
    [[ -f "$marker" ]] || return 0
    for pkg in core web device-web cf; do
      src_dir="$WEB_DIR/packages/$pkg/src"
      if [[ -n "$(find "$src_dir" "$WEB_DIR/packages/cf/client" -type f -newer "$marker" -print -quit 2>/dev/null)" ]]; then
        return 0
      fi
    done
  done
  return 1
}
if [[ $LOCAL -eq 1 ]] && { [[ $FRESH -eq 1 ]] || dists_stale; }; then
  echo "==> Building @hypen-space packages (core, web, device-web, cf)..."
  (cd "$WEB_DIR" && bun install && bun run build:core && bun run build:web && bun run build:device-web)
  (cd "$WEB_DIR/packages/cf" && bun run build)
fi

# ---- 3. Install each example ------------------------------------------------
# Gotcha 3: let the device plane through wrangler's dev ProxyWorker.
patch_wrangler_proxy() {
  local cli="$1/node_modules/wrangler/wrangler-dist/cli.js"
  [[ -f "$cli" ]] || return 0
  grep -q 'compatibilityDate: "2023-12-18",' "$cli" || return 0
  perl -0777 -pi -e 's/(compatibilityDate: "2023-12-18",\s*compatibilityFlags: \["nodejs_compat")\]/$1, "no_web_socket_compression"]/g' "$cli"
}

# Overwrite an example's installed @hypen-space package with the freshly
# built local one (package.json + dist + src + client, no nested
# node_modules). Without this, examples pinned to published versions run
# OLD runtime code against the NEW local engine WASM copied below — a
# protocol mismatch (e.g. published cores predate the engine's
# string-serialized patch batches, so the DO relays an unparsed JSON string
# and every client dies with "$.filter is not a function").
sync_local_pkg() {
  local dir="$1" short="$2"
  local srcdir="$WEB_DIR/packages/$short"
  local dest="$dir/node_modules/@hypen-space/$short"
  rm -rf "$dest"
  mkdir -p "$dest"
  cp "$srcdir/package.json" "$dest/"
  cp -rL "$srcdir/dist" "$dest/dist"
  [[ -d "$srcdir/src" ]] && cp -rL "$srcdir/src" "$dest/src"
  [[ -d "$srcdir/client" ]] && cp -rL "$srcdir/client" "$dest/client"
  return 0
}

for name in "${SELECTED[@]}"; do
  read -r rel _port <<<"$(example_entry "$name")"
  dir="$REPO_ROOT/$rel"
  echo "==> Installing $name ($rel)..."
  # A previous --local run overwrote packages that `bun install` would treat
  # as already installed; start clean so the published versions come back.
  if [[ $LOCAL -eq 0 && -f "$dir/node_modules/.hypen-local-overlay" ]]; then
    rm -rf "$dir/node_modules"
  fi
  (cd "$dir" && bun install --silent)
  patch_wrangler_proxy "$dir"
  if [[ $LOCAL -eq 1 ]]; then
    # Overlay this checkout's engine + @hypen-space builds (gotcha 4).
    touch "$dir/node_modules/.hypen-local-overlay"
    rm -rf "$dir/node_modules/hypen-engine"
    cp -rL "$ENGINE_DIR/pkg/web" "$dir/node_modules/hypen-engine"
    for short in core web cf; do
      sync_local_pkg "$dir" "$short"
    done
  fi
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

inspector="${HYPEN_EXAMPLES_INSPECTOR_BASE:-9230}"
for name in "${SELECTED[@]}"; do
  read -r rel port <<<"$(example_entry "$name")"
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
  read -r _rel port <<<"$(example_entry "$name")"
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
if [[ " ${SELECTED[*]} " == *" home-screen "* ]]; then
  echo "Launcher: http://localhost:8787  (Ctrl-C stops everything)"
else
  echo "Ctrl-C stops everything."
fi
wait
