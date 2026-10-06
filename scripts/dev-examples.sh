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
#   4. wrangler dev fronts the Worker with its own ProxyWorker, pinned to
#      compatibilityDate 2023-12-18 — so it re-negotiates permessage-deflate
#      WITH context takeover toward the browser even when the example sets
#      `no_web_socket_compression`. Browsers then keep the connection UI-only
#      (RFC 001 §2.3: no device plane, no uploads). The script adds the same
#      flag to the installed wrangler's ProxyWorker. Local dev only; deployed
#      Workers take the flag from wrangler.jsonc.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINE_DIR="$REPO_ROOT/hypen-engine-rs"
WEB_DIR="$REPO_ROOT/hypen-web"
LOG_DIR="${TMPDIR:-/tmp}/hypen-dev-examples"
mkdir -p "$LOG_DIR"

# name -> "relative-dir http-port" (ports must match examples/home-screen APPS)
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

DEFAULT_SET=(home-screen simple todo calculator)
ALL_SET=(home-screen simple todo calorie-counter movie-discovery food-ordering social calculator hypeflix)

FRESH=0
SELECTED=()
for arg in "$@"; do
  case "$arg" in
    --fresh) FRESH=1 ;;
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

# ---- 1. Engine WASM (web target) ----------------------------------------
if [[ $FRESH -eq 1 || ! -f "$ENGINE_DIR/pkg/web/package.json" ]]; then
  echo "==> Building engine WASM (pkg/web)..."
  (cd "$ENGINE_DIR" && bun x wasm-pack build --target web --out-dir pkg/web --features js,device-broker)
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
if [[ $FRESH -eq 1 ]] || dists_stale; then
  echo "==> Building @hypen-space packages (core, web, device-web, cf)..."
  (cd "$WEB_DIR" && bun install && bun run build:core && bun run build:web && bun run build:device-web)
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

# Gotcha 4: let the device plane through wrangler's dev ProxyWorker.
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
  (cd "$dir" && bun install --silent)
  dereference "$dir"
  patch_wrangler_proxy "$dir"
  # Keep the engine + @hypen-space copies current with the local builds.
  rm -rf "$dir/node_modules/hypen-engine"
  cp -rL "$ENGINE_DIR/pkg/web" "$dir/node_modules/hypen-engine"
  for short in core web cf; do
    sync_local_pkg "$dir" "$short"
  done
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
echo "Launcher: http://localhost:8787  (Ctrl-C stops everything)"
wait
