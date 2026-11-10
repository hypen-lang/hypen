# Gallery app releases

The Release workflow builds the Android gallery APK and a universal iOS Simulator
app for every release, then publishes both to the `hypen` Cloudflare R2 bucket:

- `android/hypen-gallery-X.Y.Z.apk`
- `ios/hypen-gallery-X.Y.Z.zip`
- A `.sha256` sidecar for each download

The existing `/android/latest` and `/ios/latest` download routes continue to work
with published CLI versions. Desktop installers remain on GitHub Releases.
The iOS ZIP supports Apple Silicon and Intel simulators; it is not a physical-device
IPA. The Android APK uses the gallery's debug signing identity.

## CI configuration

Repository Actions secrets:

- `ANDROID_GALLERY_DEBUG_KEYSTORE`: the existing debug keystore encoded as base64,
  using alias `androiddebugkey` and password `android`. Keep the key stable so users
  can update an installed gallery without uninstalling it.
- `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`: an R2 S3 API credential with Object
  Read & Write access limited to the `hypen` bucket.

Repository Actions variables:

- `R2_ENDPOINT_URL`: the account's S3 endpoint from R2 settings.
- `R2_BUCKET`: defaults to `hypen`.

PR checks build both apps without publishing or using release credentials. The
Gallery Apps workflow also accepts a release tag for a gallery-only run. Both
builds must pass before uploading. Existing objects are compared by hash and never
overwritten with different bytes. Retry an interrupted publish job using its same
build artifacts.

## Local builds

```sh
scripts/build-gallery.sh --platform android --version 0.6.8 --output-dir dist/gallery
scripts/build-gallery.sh --platform ios --version 0.6.8 --output-dir dist/gallery
```

Android requires Java and the Android SDK. iOS requires Xcode on macOS.
The separate `publish-gallery.sh` remains available for manual R2 publishing.
