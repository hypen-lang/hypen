#!/usr/bin/env bash
# Build distributable demo runners without uploading them.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLATFORM=""
VERSION=""
OUTPUT_DIR="$ROOT_DIR/dist/gallery"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform) PLATFORM="$2"; shift 2 ;;
    --version) VERSION="${2#v}"; shift 2 ;;
    --output-dir) OUTPUT_DIR="$2"; shift 2 ;;
    *) echo "Usage: $0 --platform android|ios --version X.Y.Z [--output-dir DIR]" >&2; exit 1 ;;
  esac
done
if [[ ! "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  echo "Expected a release version X.Y.Z" >&2
  exit 1
fi
IFS=. read -r MAJOR MINOR PATCH <<< "$VERSION"
if (( MAJOR > 2000 || MINOR > 999 || PATCH > 999 )); then
  echo "Version exceeds Android versionCode limits" >&2
  exit 1
fi
VERSION_CODE=$((MAJOR * 1000000 + MINOR * 1000 + PATCH))
if (( VERSION_CODE < 1 )); then
  echo "Release version must be greater than 0.0.0" >&2
  exit 1
fi
mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"

case "$PLATFORM" in
  android)
    (cd "$ROOT_DIR/hypen-renderer-android" && ./gradlew :app:assembleRelease \
      "-PgalleryVersion=$VERSION" "-PgalleryVersionCode=$VERSION_CODE")
    cp "$ROOT_DIR/hypen-renderer-android/app/build/outputs/apk/release/app-release.apk" \
      "$OUTPUT_DIR/hypen-gallery.apk"
    ;;
  ios)
    PROJECT_DIR="$ROOT_DIR/hypen-renderer-swift/Gallery/HypenGallery"
    DERIVED_DATA="$OUTPUT_DIR/DerivedData"
    xcodebuild build \
      -project "$PROJECT_DIR/HypenGallery.xcodeproj" \
      -scheme HypenGallery \
      -configuration Debug \
      -destination 'generic/platform=iOS Simulator' \
      -derivedDataPath "$DERIVED_DATA" \
      'ARCHS=arm64 x86_64' ONLY_ACTIVE_ARCH=NO CODE_SIGNING_ALLOWED=NO \
      "MARKETING_VERSION=$VERSION" "CURRENT_PROJECT_VERSION=$VERSION_CODE"
    APP="$DERIVED_DATA/Build/Products/Debug-iphonesimulator/HypenGallery.app"
    # One simulator download works on both Apple Silicon and Intel Macs.
    lipo "$APP/HypenGallery" -verify_arch arm64 x86_64
    ditto -c -k --sequesterRsrc --keepParent "$APP" "$OUTPUT_DIR/hypen-gallery-ios-simulator.zip"
    ;;
  *) echo "--platform must be android or ios" >&2; exit 1 ;;
esac
