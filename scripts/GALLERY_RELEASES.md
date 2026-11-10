# Gallery app releases

The Release workflow builds the Android gallery APK and the iOS Simulator app
for every release and attaches them to the same GitHub release as the desktop
installers. The CLI downloads these assets with `hypen run android` and
`hypen run ios`:

- `hypen-gallery.apk`
- `hypen-gallery-ios-simulator.zip` (Apple Silicon and Intel simulators)
- A `.sha256` file for each download
- `hypen-gallery-version.txt`

The iOS ZIP is a Simulator app, not an IPA for physical devices or the App Store.
The Android APK uses the gallery's debug signing identity.

## CI configuration

Set the repository Actions secret `ANDROID_GALLERY_DEBUG_KEYSTORE` to the base64
encoding of the existing gallery debug keystore. It must use the standard Android
debug alias/password (`androiddebugkey` / `android`). Keep this key stable so users
can update an installed gallery without uninstalling it. Pull request builds use
a temporary debug identity and never upload to a release.

The Gallery Apps workflow also accepts an existing release tag for a gallery-only
run. Both builds must succeed before publishing. Existing release assets are
compared before upload; differing files are never overwritten. To retry an
interrupted upload, rerun the failed publish job so it uses the same build artifacts.

## Local builds

```sh
scripts/build-gallery.sh --platform android --version 0.6.8 --output-dir dist/gallery
scripts/build-gallery.sh --platform ios --version 0.6.8 --output-dir dist/gallery
```

Android requires Java and the Android SDK. iOS requires Xcode on macOS.
The separate `publish-gallery.sh` script remains available for manual R2 uploads;
it is not used by the GitHub release workflow.
