# Hypen Component Gallery Screenshot Tests

Automated screenshot testing across iOS, Android, and Web platforms.

## Prerequisites

- **iOS**: Xcode with iOS Simulator
- **Android**: Android Studio with emulator or connected device
- **Web**: Chrome/Chromium installed
- **Bun**: For running the test scripts

## Usage

### Run all tests (iOS, Android, Web)

```bash
./run-tests.sh
```

### Platform-specific tests

Pick at most one `--*-only` flag — they are mutually exclusive. Omit all to run every platform.

```bash
./run-tests.sh --ios-only
./run-tests.sh --android-only
./run-tests.sh --web-only
```

Or skip individual platforms (combinable):

```bash
./run-tests.sh --skip-android            # iOS + Web
./run-tests.sh --skip-android --skip-web # iOS only
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
