# @hypen-space/ios-streamer

Stream and control iOS Simulators over HTTP — MJPEG video, tap/swipe/text input, boot/shutdown — via `xcrun simctl` and (optionally) [`fb-idb`](https://fbidb.io).

> macOS only. Requires Xcode command line tools (`xcrun`). Input forwarding requires [`idb`](https://fbidb.io); without it the streamer runs read-only.

## Quickstart

```bash
# 1. Start the streamer
bunx @hypen-space/ios-streamer --port 7711

# 2. List simulators and pick a UDID
curl http://127.0.0.1:7711/devices

# 3. Boot it if needed (or use `xcrun simctl boot <udid>`)
curl -X POST http://127.0.0.1:7711/devices/<udid>/boot

# 4. Open the live stream in a browser
open "http://127.0.0.1:7711/stream/<udid>?fps=15"
```

### Embed the stream

Drop it straight into an `<img>` — MJPEG plays in any browser, no JS required:

```html
<img src="http://127.0.0.1:7711/stream/<udid>?fps=15" />
```

Or use the H.264 MP4 endpoint in a `<video>` tag (requires `ffmpeg` on PATH):

```html
<video src="http://127.0.0.1:7711/video/<udid>" autoplay muted playsinline></video>
```

## Use

```bash
bunx @hypen-space/ios-streamer --port 7711
# → http://127.0.0.1:7711
```

Or programmatically:

```ts
import { startServer } from "@hypen-space/ios-streamer";

const server = await startServer({ port: 7711, fps: 12 });
console.log(server.url);
// later: server.stop()
```

Programmatic-only, no server:

```ts
import { listDevices, boot, screenshot, dispatchInput } from "@hypen-space/ios-streamer";

const devices = await listDevices();
const booted = devices.find((d) => d.state === "Booted")!;
await dispatchInput(booted.udid, { type: "tap", x: 100, y: 200 });
const jpeg = await screenshot(booted.udid);
```

## HTTP API

| Method | Path                                   | Body                                                  | Returns                       |
| ------ | -------------------------------------- | ----------------------------------------------------- | ----------------------------- |
| GET    | `/health`                              | —                                                     | `{ ok, idb, ffmpeg, fps }`    |
| GET    | `/devices`                             | —                                                     | `{ devices: Simulator[] }`    |
| POST   | `/devices/:udid/boot`                  | —                                                     | `{ ok: true }`                |
| POST   | `/devices/:udid/shutdown`              | —                                                     | `{ ok: true }`                |
| GET    | `/devices/:udid/screenshot.jpg`        | —                                                     | `image/jpeg`                  |
| GET    | `/stream/:udid?fps=12`                 | —                                                     | `multipart/x-mixed-replace`   |
| GET    | `/video/:udid`                         | —                                                     | `video/mp4` (fragmented H.264, requires ffmpeg) |
| POST   | `/devices/:udid/input`                 | `{ type: "tap" \| "swipe" \| "text" \| "key", ... }` | `{ ok: true }` or `501`       |

The `/stream/:udid` response can be embedded directly in an `<img>`:

```html
<img src="http://127.0.0.1:7711/stream/AAA-BBB-CCC?fps=15" />
```

## How it works

* **Listing / boot / shutdown** → `xcrun simctl`
* **Low-latency MJPEG** → `xcrun simctl io <udid> screenshot --type=jpeg -` polled at `fps`. Each JPEG is pushed as a fresh MJPEG part. Zero dependencies, plays in any `<img>`.
* **H.264 fragmented MP4** → `xcrun simctl io <udid> recordVideo --codec=h264 <fifo>` piped through `ffmpeg -c:v copy -f mp4 -movflags frag_keyframe+empty_moov+default_base_moof pipe:1`, served as `video/mp4` and consumable directly in a `<video>` tag. Requires `ffmpeg` on PATH.
* **Input** → `idb ui tap|swipe|text|button` (Facebook's [fb-idb](https://fbidb.io))

## Install

```bash
bun add -D @hypen-space/ios-streamer
brew install facebook/fb/idb-companion   # for input
pip3 install fb-idb                       # for input
```

## License

MIT
