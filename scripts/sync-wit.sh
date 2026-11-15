#!/usr/bin/env bash
# Regenerate (or verify) the vendored copies of the `hypen:module` WIT
# contract from its single source of truth at the repo root.
#
#   scripts/sync-wit.sh           regenerate the vendored copies
#   scripts/sync-wit.sh --check   exit 1 (with a diff) if any copy has drifted
#
# Canonical (edit these):   wit/       hypen:module@0.1.0 + wit/deps/
#                           wit-v0_2/  hypen:module@0.2.0 + wit-v0_2/deps/
# Generated (never edit):   hypen-cli/wit/        <- wit/
#                           hypen-cli/wit-v0_2/   <- wit-v0_2/
#                           hypen-cli/wit-tinygo/ <- wit/ + TinyGo-owned parts
#
# The vendored copies exist because the published @hypen-space/cli package has
# no repo root: it provisions hypen-cli/wit{,-v0_2} into users' Rust crates,
# passes them to jco, and hands hypen-cli/wit-tinygo to tinygo.
#
# Only *.wit files are mirrored (the canonical dirs also hold design docs).
# Runs from any cwd; needs only bash + coreutils + diff.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── The derivation table ─────────────────────────────────────────────────────

# Plain mirrors: every *.wit under <canonical> is copied byte-for-byte to
# <vendored>; any other file in <vendored> is stale and removed.
MIRRORS=(
  "wit:hypen-cli/wit"
  "wit-v0_2:hypen-cli/wit-v0_2"
)

# hypen-cli/wit-tinygo is the v0.1 package plus what TinyGo needs on top.
TINYGO_DIR="hypen-cli/wit-tinygo"
TINYGO_CANONICAL="wit"

# Derived into wit-tinygo:
#   deps/<pkg>/*.wit  <- wit/deps/<pkg>/*.wit, for EVERY package in wit/deps
#                        (hypen-engine, hypen-storage, hypen-http today; new canonical deps
#                        follow automatically).
#   world.wit (head)  <- wit/hypen-module.wit, byte-for-byte; the file is that
#                        content, one blank line, then the TinyGo-owned tail
#                        starting at TINYGO_TAIL_MARKER (see below).
TINYGO_WORLD="world.wit"            # name is hardcoded in hypen-cli/src/build-wasm.ts
TINYGO_WORLD_SRC="hypen-module.wit"
TINYGO_TAIL_MARKER="// ==== TINYGO-ONLY BELOW (hypen-cli-owned) ===="

# TinyGo-owned (kept in place, never regenerated):
#   world.wit tail     the `tinygo-module` world: `include module` + the
#                      wasi:cli/io/clocks/filesystem/random@0.2.0 imports that
#                      TinyGo's wasip2 runtime always pulls in, and
#                      hypen:http/deferred for modules that use it. Not part of the
#                      canonical contract; `wasm-tools component new` (run by
#                      tinygo) rejects a component whose imports its world
#                      does not declare.
#   deps/cli ... sockets  WASI 0.2.0 packages those imports resolve against.
#                      tinygo -wit-package needs them vendored; the canonical
#                      package resolves wasi:* from the host toolchain instead.
#   README.md          explains this split.
TINYGO_OWNED=(
  "README.md"
  "deps/cli"
  "deps/clocks"
  "deps/filesystem"
  "deps/io"
  "deps/random"
  "deps/sockets"
)

# ── Helpers ──────────────────────────────────────────────────────────────────

die() { echo "sync-wit: $*" >&2; exit 2; }

# mirror_wit <src-dir> <dest-dir>: copy every *.wit under src into dest.
mirror_wit() {
  local src="$1" dest="$2" f rel
  [[ -d "$src" ]] || die "canonical dir missing: $src"
  while IFS= read -r -d '' f; do
    rel="${f#"$src"/}"
    mkdir -p "$dest/$(dirname "$rel")"
    cp "$f" "$dest/$rel"
  done < <(find "$src" -type f -name '*.wit' -print0)
}

# render <out-root>: write the expected vendored trees under <out-root>.
render() {
  local out="$1" m src dest pkg owned tdir="$ROOT/$TINYGO_DIR"

  for m in "${MIRRORS[@]}"; do
    src="${m%%:*}"; dest="${m#*:}"
    mkdir -p "$out/$dest"
    mirror_wit "$ROOT/$src" "$out/$dest"
  done

  # wit-tinygo: owned parts first, copied from the working tree as-is.
  mkdir -p "$out/$TINYGO_DIR"
  for owned in "${TINYGO_OWNED[@]}"; do
    [[ -e "$tdir/$owned" ]] || die "TinyGo-owned path missing: $TINYGO_DIR/$owned"
    mkdir -p "$out/$TINYGO_DIR/$(dirname "$owned")"
    cp -R "$tdir/$owned" "$out/$TINYGO_DIR/$owned"
  done

  # Derived deps: every canonical deps package.
  shopt -s nullglob
  for pkg in "$ROOT/$TINYGO_CANONICAL/deps"/*/; do
    pkg="$(basename "$pkg")"
    mkdir -p "$out/$TINYGO_DIR/deps/$pkg"
    mirror_wit "$ROOT/$TINYGO_CANONICAL/deps/$pkg" "$out/$TINYGO_DIR/deps/$pkg"
  done

  # Derived head + owned tail of world.wit.
  local world="$tdir/$TINYGO_WORLD"
  [[ -f "$world" ]] || die "$TINYGO_DIR/$TINYGO_WORLD missing"
  grep -qxF "$TINYGO_TAIL_MARKER" "$world" \
    || die "$TINYGO_DIR/$TINYGO_WORLD has no TinyGo tail marker line:
  $TINYGO_TAIL_MARKER
Restore it above the \`tinygo-module\` world so the script knows what to keep."
  {
    cat "$ROOT/$TINYGO_CANONICAL/$TINYGO_WORLD_SRC"
    echo
    sed -n "\\|^${TINYGO_TAIL_MARKER}\$|,\$p" "$world"
  } > "$out/$TINYGO_DIR/$TINYGO_WORLD"
}

# ── Main ─────────────────────────────────────────────────────────────────────

mode="sync"
case "${1:-}" in
  "") ;;
  --check) mode="check" ;;
  -h|--help) sed -n '2,19p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) die "unknown argument: $1 (expected --check or nothing)" ;;
esac

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
render "$tmp"

vendored=()
for m in "${MIRRORS[@]}"; do vendored+=("${m#*:}"); done
vendored+=("$TINYGO_DIR")

if [[ "$mode" == "check" ]]; then
  drift=0
  for d in "${vendored[@]}"; do
    if [[ ! -d "$ROOT/$d" ]]; then
      echo "MISSING  $d/"; drift=1; continue
    fi
    if ! out="$(diff -ru "$tmp/$d" "$ROOT/$d" 2>&1)"; then
      drift=1
      echo "DRIFTED  $d/  (--- expected from canonical, +++ working tree)"
      # Show repo-relative paths instead of the temp dir.
      printf '%s\n' "$out" | sed -e "s|$tmp/|<expected>/|g" -e "s|$ROOT/||g" | head -n 200
      echo
    fi
  done
  if (( drift )); then
    echo "The vendored hypen:module WIT copies are out of sync with wit/ and wit-v0_2/." >&2
    echo "Edit only the canonical dirs, then run: scripts/sync-wit.sh" >&2
    echo "(TinyGo-only parts of $TINYGO_DIR are listed in TINYGO_OWNED in the script.)" >&2
    exit 1
  fi
  echo "sync-wit: vendored WIT copies are in sync (${vendored[*]})."
  exit 0
fi

# Sync: refuse to delete files in wit-tinygo that the table doesn't classify.
unknown=()
while IFS= read -r -d '' f; do
  rel="${f#"$ROOT/$TINYGO_DIR"/}"
  [[ -e "$tmp/$TINYGO_DIR/$rel" ]] || unknown+=("$TINYGO_DIR/$rel")
done < <(find "$ROOT/$TINYGO_DIR" -type f -print0)
if (( ${#unknown[@]} )); then
  echo "sync-wit: these files in $TINYGO_DIR are neither derived from $TINYGO_CANONICAL/ nor listed" >&2
  echo "in TINYGO_OWNED; add them to TINYGO_OWNED in scripts/sync-wit.sh or delete them:" >&2
  printf '  %s\n' "${unknown[@]}" >&2
  exit 1
fi

changed=0
for d in "${vendored[@]}"; do
  if [[ -d "$ROOT/$d" ]] && diff -r "$tmp/$d" "$ROOT/$d" >/dev/null 2>&1; then
    continue
  fi
  changed=1
  rm -rf "${ROOT:?}/$d"
  mkdir -p "$(dirname "$ROOT/$d")"
  cp -R "$tmp/$d" "$ROOT/$d"
  echo "sync-wit: regenerated $d/"
done
(( changed )) || echo "sync-wit: already in sync (${vendored[*]})."
