#!/usr/bin/env bash
#
# publish-gallery.sh — Build gallery apps and upload to Cloudflare R2
#
# Usage:
#   ./scripts/publish-gallery.sh --platform android|ios|both --version X.Y.Z --bucket <name> [--force]
#

set -euo pipefail

# ─── Defaults ─────────────────────────────────────────────
PLATFORM="both"
VERSION=""
BUCKET="hypen"
FORCE=false
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ─── Usage ────────────────────────────────────────────────
usage() {
  cat <<EOF
Usage: $(basename "$0") --version <X.Y.Z> [--platform <android|ios|both>] [--bucket <name>] [--force]

Options:
  --platform, -p   Target platform: android, ios, or both (default: both)
  --version, -v    Version string (e.g. 0.1.0, v1.2.3)
  --bucket, -b     R2 bucket URL (default: hypen R2 bucket)
  --force, -f      Overwrite existing artifacts in R2
  --help, -h       Show this help
EOF
  exit 1
}

# ─── Parse args ───────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform|-p) PLATFORM="$2"; shift 2 ;;
    --version|-v)  VERSION="$2"; shift 2 ;;
    --bucket|-b)   BUCKET="$2"; shift 2 ;;
    --force|-f)    FORCE=true; shift ;;
    --help|-h)     usage ;;
    *)             echo "Unknown option: $1"; usage ;;
  esac
done

[[ -z "$VERSION" ]]  && { echo "Error: --version is required"; usage; }

# ─── Normalize version ────────────────────────────────────
normalize_version() {
  local v="$1"
  # Strip leading v
  v="${v#v}"
  # Convert - and _ to .
  v="${v//[-_]/.}"
  # Validate: 2-4 numeric segments
  if ! echo "$v" | grep -qE '^[0-9]+(\.[0-9]+){1,3}$'; then
    echo "Error: Invalid version '$1'. Expected 2-4 numeric segments (e.g. 0.1.0)"
    exit 1
  fi
  echo "$v"
}

VERSION="$(normalize_version "$VERSION")"
echo "Version: $VERSION"

# ─── Check wrangler ───────────────────────────────────────
if ! command -v wrangler &>/dev/null; then
  echo "Error: wrangler CLI not found. Install with: npm install -g wrangler"
  exit 1
fi

# ─── R2 helpers ───────────────────────────────────────────
r2_exists() {
  local key="$1"
  # Try to get the object, piping to /dev/null. If it succeeds, the object exists.
  if wrangler r2 object get "$BUCKET/$key" --pipe --remote > /dev/null 2>&1; then
    return 0
  fi
  return 1
}

r2_upload() {
  local key="$1"
  local file="$2"
  local content_type="$3"

  echo "  Uploading $key ..."
  wrangler r2 object put "$BUCKET/$key" \
    --file "$file" \
    --content-type "$content_type" \
    --cache-control "public, max-age=31536000, immutable" \
    --remote
  echo "  Uploaded: $key"
}

r2_upload_checksum() {
  local key="$1"
  local file="$2"
  local sha256
  sha256="$(shasum -a 256 "$file" | awk '{print $1}')"
  local checksum_file
  checksum_file="$(mktemp)"
  echo "$sha256" > "$checksum_file"

  echo "  SHA256: $sha256"
  wrangler r2 object put "$BUCKET/${key}.sha256" \
    --file "$checksum_file" \
    --content-type "text/plain" \
    --remote
  rm -f "$checksum_file"
}

# ─── Build + Upload Android ──────────────────────────────
build_and_upload_android() {
  local key="android/hypen-gallery-${VERSION}.apk"
  local apk_path="$ROOT_DIR/hypen-renderer-android/app/build/outputs/apk/release/app-release.apk"

  echo ""
  echo "=== Android ==="

  # Check if already uploaded
  if ! $FORCE && r2_exists "$key"; then
    echo "  Error: $key already exists in R2. Use --force to overwrite."
    exit 1
  fi

  # Build
  echo "  Building release APK..."
  (cd "$ROOT_DIR/hypen-renderer-android" && ./gradlew :app:assembleRelease)

  if [[ ! -f "$apk_path" ]]; then
    echo "  Error: APK not found at $apk_path"
    exit 1
  fi

  echo "  APK size: $(du -h "$apk_path" | awk '{print $1}')"

  # Upload
  r2_upload "$key" "$apk_path" "application/vnd.android.package-archive"
  r2_upload_checksum "$key" "$apk_path"

  echo "  URL: https://red-water-3890.ian-dae.workers.dev/$key"
}

# ─── Build + Upload iOS ──────────────────────────────────
build_and_upload_ios() {
  local key="ios/hypen-gallery-${VERSION}.zip"
  local project_dir="$ROOT_DIR/hypen-renderer-swift/Gallery/HypenGallery"
  local derived_data="$project_dir/DerivedData/HypenGallery"
  local build_dir="$derived_data/Build/Products/Debug-iphonesimulator"
  local app_path="$build_dir/HypenGallery.app"
  local zip_path="$ROOT_DIR/hypen-renderer-swift/Gallery/build/HypenGallery.zip"

  echo ""
  echo "=== iOS ==="

  # Check if already uploaded
  if ! $FORCE && r2_exists "$key"; then
    echo "  Error: $key already exists in R2. Use --force to overwrite."
    exit 1
  fi

  # Build for simulator (simctl install requires a simulator .app)
  echo "  Building for iOS Simulator..."
  xcodebuild build \
    -project "$project_dir/HypenGallery.xcodeproj" \
    -scheme HypenGallery \
    -configuration Debug \
    -destination "generic/platform=iOS Simulator" \
    -derivedDataPath "$derived_data" \
    CODE_SIGNING_ALLOWED=NO

  if [[ ! -d "$app_path" ]]; then
    echo "  Error: .app not found at $app_path"
    exit 1
  fi

  # Zip the .app bundle
  echo "  Zipping .app bundle..."
  mkdir -p "$(dirname "$zip_path")"
  (cd "$build_dir" && zip -r -q "$zip_path" HypenGallery.app)

  echo "  Zip size: $(du -h "$zip_path" | awk '{print $1}')"

  # Upload
  r2_upload "$key" "$zip_path" "application/zip"
  r2_upload_checksum "$key" "$zip_path"

  echo "  URL: https://red-water-3890.ian-dae.workers.dev/$key"
}

# ─── Main ─────────────────────────────────────────────────
echo "Publishing Hypen Gallery v${VERSION} to R2 bucket: $BUCKET"

case "$PLATFORM" in
  android) build_and_upload_android ;;
  ios)     build_and_upload_ios ;;
  both)
    build_and_upload_android
    build_and_upload_ios
    ;;
  *) echo "Error: Invalid platform '$PLATFORM'. Use android, ios, or both."; exit 1 ;;
esac

echo ""
echo "Done!"
