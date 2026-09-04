# Hypen Component Gallery Screenshot Tests

Automated screenshot testing across the Web DOM, Web Canvas, Desktop Vello,
iOS, and Android renderers.

## Prerequisites

- **iOS**: Xcode with iOS Simulator
- **Android**: Android Studio with emulator or connected device
- **Web**: Chrome/Chromium installed
- **Canvas**: Chrome/Chromium installed (uses the production Canvas renderer)
- **Desktop**: desktop build dependencies and a GPU supported by Vello
- **Bun**: For running the test scripts

## Pinned test devices

Native screenshots are accepted only from the configured simulator/emulator. The runner never picks the first connected device. Before installing the gallery it verifies the exact device identity, OS/API level, screenshot pixel size, and Android density. Each saved native screenshot is checked again so a display override cannot silently change a run halfway through.

Capture waits for a fresh per-platform gallery connection and the server's initial tree. Examples that use gallery fixtures additionally wait until every local image was requested and native frames stop changing; web waits for decoded DOM images and two paint frames. Avatar, blur, and borderRadius rounded images use deterministic PNGs served by the component gallery, so these screenshots do not depend on Pravatar/Picsum or network timing. The server emits loopback URLs for web/iOS and the emulator host alias for Android.

The runner reuses ports 6555 and 5556 only when their service-specific health checks pass. A different listener on either port fails with its owning process details instead of being mistaken for the gallery or killed. Newly spawned servers must pass health before platform setup continues, and an early process exit is reported immediately.

Repository defaults pin the modern simulator and AVD used for current gallery development. Comparison normalization is configured separately:

| Platform | Default device | Required metrics |
| --- | --- | --- |
| Web DOM | Headless Chrome | 430×934 viewport |
| Canvas | Headless Chrome | 430×934 canvas |
| Desktop | Vello export | 430×934 logical pixels |
| iOS | `iPhone 17 Pro Max` | 1320×2868 screenshot |
| Android | `Pixel_8`, API 34 | 1080×2400 screenshot, 420 dpi |

The iOS name must resolve to exactly one available simulator. If multiple installed runtimes contain that name, pin its UDID. Android may have other phones or emulators connected; they are ignored unless they match the configured AVD. Pin the serial when more than one instance of that AVD is running.

iOS screenshot routing is non-interactive: each item terminates and relaunches HypenGallery with `--gallery-item <name>`. This avoids the iOS system confirmation shown for custom-URL `simctl openurl` calls and guarantees a fresh WebSocket generation for readiness checks. The app still supports `hypengallery://` through `onOpenURL` for manual use.

When the configured Android AVD is not already running, the runner always supplies an explicit emulator console port. It checks the standard even-port range, skips ports owned by connected emulators, verifies that both the console and adjacent ADB ports are free, and reserves the component/web gallery ports from consideration. For example, if `emulator-5554` is already running, port 5556 is skipped because the web gallery owns it, so the new AVD launches as `emulator-5558`. An explicit `--android-serial=emulator-5560` pins launch to console port 5560 and fails clearly if that console/ADB pair is unavailable.

Configure devices on the command line:

```bash
./run-tests.sh --ios-only \
  --ios-simulator="iPhone 17 Pro Max" \
  --ios-udid=00000000-0000-0000-0000-000000000000 \
  --ios-width=1320 --ios-height=2868

./run-tests.sh --android-only \
  --android-avd=Pixel_8 \
  --android-serial=emulator-5554 \
  --android-api=34 \
  --android-width=1080 --android-height=2400 \
  --android-density=420
```

Every option also has an environment equivalent, useful for a machine-local setup:

| CLI option | Environment variable |
| --- | --- |
| `--ios-simulator` | `HYPEN_IOS_SIMULATOR` |
| `--ios-udid` | `HYPEN_IOS_UDID` |
| `--ios-width`, `--ios-height` | `HYPEN_IOS_WIDTH`, `HYPEN_IOS_HEIGHT` |
| `--android-avd` | `HYPEN_ANDROID_AVD` |
| `--android-serial` | `HYPEN_ANDROID_SERIAL` |
| `--android-api` | `HYPEN_ANDROID_API` |
| `--android-width`, `--android-height` | `HYPEN_ANDROID_WIDTH`, `HYPEN_ANDROID_HEIGHT` |
| `--android-density` | `HYPEN_ANDROID_DENSITY` |

CLI options take precedence over environment variables. A mismatch fails before the gallery screenshots begin and reports the actual and expected values; change an expected metric only when deliberately adopting a new baseline.

## Screenshot comparison geometry

Run `./compare.sh` after capture. The comparison rejects screenshots that do not match the configured device profile, removes only the gallery's host chrome, then converts native pixels to logical units without stretching:

| Platform | Logical scale | Host chrome removed |
| --- | --- | --- |
| Web | 1 pixel per CSS pixel | none |
| Canvas | 1 pixel per canvas pixel | none |
| Desktop | 1 exported pixel per logical unit | none |
| iOS | 3 pixels per point | 136pt top, 34pt bottom |
| Android | density / 160 pixels per dp | 116dp top, 24dp bottom |

The normalized images keep their native logical viewport widths. They are anchored at the top-left of a shared 440×934 canvas, with unused space filled white. This intentionally exposes viewport-driven layout differences instead of hiding them with non-uniform resizing.

Each gallery page produces one labeled contact strip, ordered **iOS, Android,
Web, Desktop, Canvas**. Pairwise “visual diff in pixels” panels are not emitted;
the JSON report still contains all ten pairwise similarity measurements.

### Publishing to the docs

From `hypen-docs`, run `bun run comparison:update`. It captures the registered
gallery, generates the five-platform strips, copies them into
`public/comparison`, and regenerates the docs manifest from `components.json`
and `applicators.json`. New registered examples therefore appear on the
comparison page without editing MDX. Known visual differences may be published;
missing or invalid platform captures still fail the update.

The comparison accepts the same `--ios-width`, `--ios-height`, `--android-width`, `--android-height`, and `--android-density` options/environment variables as the capture runner. For an intentionally different host shell, configure logical-unit crops with `--ios-scale`, `--ios-crop-top`, `--ios-crop-bottom`, `--android-crop-top`, and `--android-crop-bottom`; their environment equivalents are the upper-case `HYPEN_*` names. Web, Canvas, and Desktop dimensions can be set with their corresponding `--<platform>-width`/`--<platform>-height` options or upper-case `HYPEN_*` environment variables.

## Usage

### Run all tests (Web DOM, Canvas, Desktop, iOS, Android)

```bash
./run-tests.sh
```

### Platform-specific tests

Pick at most one `--*-only` flag — they are mutually exclusive. Omit all to run every platform.

```bash
./run-tests.sh --ios-only
./run-tests.sh --android-only
./run-tests.sh --web-only
./run-tests.sh --canvas-only
./run-tests.sh --desktop-only
```

Or skip individual platforms (combinable):

```bash
./run-tests.sh --skip-ios --skip-android # Web + Canvas + Desktop
./run-tests.sh --skip-canvas --skip-desktop
```

### Test specific component/applicator

```bash
./run-tests.sh --component=button
./run-tests.sh --component=padding
```

### Skip installation (if apps are already installed)

```bash
./run-tests.sh --skip-install
```

### Skip server start (if component server is already running)

```bash
./run-tests.sh --skip-server
```

### Resume after failure/interruption

If the test run gets stuck or fails, you can resume from where it left off:

```bash
./run-tests.sh --resume
```

### Force a clean re-run

Delete the progress file and start over:

```bash
./run-tests.sh --fresh
```

### Custom timeout (default: 10 seconds per screenshot)

```bash
./run-tests.sh --timeout=15000  # 15 seconds
```

### Combine options

```bash
./run-tests.sh --ios-only --component=button --skip-install
./run-tests.sh --resume --timeout=20000
```

## Output

Screenshots are saved to `./results/` with the naming convention:

```
{component_name}_{platform}.png
```

Examples:
- `button_ios.png`
- `button_android.png`
- `button_web.png`
- `button_canvas.png`
- `button_desktop.png`
- `padding_ios.png`

## Test Data

The test runner reads from:
- `../components.json` - List of components to test
- `../applicators.json` - List of applicators to test

## Directory Structure

```
screenshot-tests/
├── run-tests.sh      # Shell wrapper
├── run-tests.ts      # Main test runner (Bun/TypeScript)
├── README.md         # This file
└── results/          # Screenshot output directory
    ├── .gitignore
    └── *.png         # Generated screenshots
```
