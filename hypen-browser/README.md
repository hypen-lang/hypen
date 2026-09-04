# Hypen Browser

The native desktop shell for Hypen apps — the desktop counterpart of the
iOS / Android Gallery apps. It opens with a home screen (URL bar + a
"Last opened" grid) and connects to any Hypen `RemoteServer` over
WebSocket, rendering the app natively via `hypen-renderer-desktop`
(winit + wgpu + Vello + cosmic-text).

## Install

Prebuilt, installable packages are produced by the
[`Desktop Installers`](../.github/workflows/desktop-installers.yml)
workflow and attached to GitHub releases:

| Platform | Package | Arch |
| --- | --- | --- |
| macOS | `.dmg` (drag to Applications) | arm64 + x86_64 |
| Windows | NSIS `…-setup.exe` | x86_64 |
| Linux | `.deb` + `.AppImage` + pacman (`.tar.gz` + `PKGBUILD`) | x86_64 |

The packages are currently **unsigned**, so the first launch needs one
extra step:

- **macOS**: right-click the app → *Open* (or clear the quarantine bit
  with `xattr -cr "/Applications/Hypen Browser.app"`).
- **Windows**: SmartScreen → *More info* → *Run anyway*.
- **Linux AppImage**: `chmod +x` the file, then run it (needs FUSE 2,
  stock on desktop distros).
- **Arch Linux**: download the release's `PKGBUILD` and
  `hypen-browser_…_x86_64.tar.gz` into one directory, then
  `makepkg -si` — pacman installs and tracks it like any package
  (`pacman -R hypen-browser` uninstalls).

## Build from source

```bash
cargo run --release -p hypen-browser
```

To build the installers locally (same tool CI uses):

```bash
cargo install cargo-packager --locked
cargo packager --release -p hypen-browser --out-dir dist
```

`cargo-packager` picks the formats native to the host OS by default;
packaging config lives in `Cargo.toml` under
`[package.metadata.packager]`.

## App icon

The icon lives in `assets/`:

- `icon.svg` — editable master design (dark tile, the pink/yellow brand
  wings, the white *h*).
- `icons/` — generated PNG set, `icon.ico` (Windows), `icon.icns`
  (macOS, with the Apple-style transparent margin).

The generated files are checked in. To regenerate after editing the
design, tweak the paths/colors in `assets/generate-icons.py` (keep
`icon.svg` in sync) and run:

```bash
pip install pillow
python3 assets/generate-icons.py
```

The icon reaches each platform through a different door, all wired up
already: `src/main.rs` sets the runtime window/taskbar icon
(Windows + Linux/X11), `build.rs` embeds `icon.ico` into the Windows
exe, and `cargo-packager` places the `.icns` in the macOS bundle and
installs the PNG set into the Linux hicolor theme.
