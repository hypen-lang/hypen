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

### Linux build dependencies

The Browser builds the desktop renderer with its device capabilities on
(camera, microphone, Bluetooth), and those link system libraries. Without them
the build stops in a `-sys` crate: `libdbus-sys` (D-Bus not found by
`pkg-config`), `v4l2-sys-mit` (bindgen: "Unable to find libclang") or
`alsa-sys`. On Debian / Ubuntu, install these first:

```bash
sudo apt-get install -y build-essential pkg-config \
  libdbus-1-dev libclang-dev libasound2-dev
```

| Package | Needed by |
| --- | --- |
| `build-essential` (gcc, g++) | `openh264-sys2`, the bundled OpenH264 encoder used by camera video capture |
| `pkg-config` | locating the system libraries below |
| `libdbus-1-dev` | `libdbus-sys`, used by Bluetooth (BlueZ over D-Bus) |
| `libclang-dev` | `v4l2-sys-mit`, which runs bindgen over the kernel's V4L2 camera headers |
| `libasound2-dev` | `alsa-sys`, used by microphone capture (ALSA) |

`nasm` is optional. When it is on `PATH`, OpenH264 uses its assembly kernels.

Windowing and GPU libraries are loaded at runtime, so they need no `-dev`
packages to build. To run the Browser you need an X11 or Wayland session and a
Vulkan or GL driver. Most desktops already have these. A minimal system needs
`libx11-6`, `libxkbcommon-x11-0`, `libwayland-client0`, `libvulkan1` and
`mesa-vulkan-drivers` (or your GPU vendor's driver).

On Fedora, the equivalent packages are `gcc-c++ pkgconf-pkg-config
dbus-devel clang-devel alsa-lib-devel`. On Arch, they are `base-devel dbus
clang alsa-lib`.

For a development build with an always-on native frame-time / equivalent FPS / process CPU / resident
RAM overlay, enable `dev`. The sampler and HUD are completely absent from
normal builds:

```bash
cargo run -p hypen-browser --features dev
# Combine with inline media when the GStreamer runtime is installed:
cargo run -p hypen-browser --features dev,video
```

The base build shows Video posters and chrome but intentionally carries no
native decoder. To play inline Video/Audio, install GStreamer and enable the
Browser's forwarding feature:

```bash
# macOS
brew install gstreamer
cargo run --release -p hypen-browser --features video

# Debian / Ubuntu (development headers + common codecs)
sudo apt install libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev \
  gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-libav
cargo run --release -p hypen-browser --features video
```

On Windows, install both the MSVC x86-64 GStreamer development and runtime
packages from the GStreamer project, then build with `--features video`. A
packaged video-enabled Browser must ship against the matching runtime/plugins;
the normal installers therefore remain decoder-free until that native runtime
is bundled by the packaging workflow.

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
