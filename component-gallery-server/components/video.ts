/**
 * Video Component Example
 * Video player element: single source, playlist auto-advance, poster,
 * and error handling. Full contract: hypen-docs/content/docs/guide/components.mdx
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const videoExample = {
  module: app
    .defineState({
      currentTrack: 0,
      playbackDone: false,
      lastError: "",
    })
    .onAction("trackChanged", ({ action, state }) => {
      state.currentTrack = action.payload?.index ?? 0;
    })
    .onAction("playbackDone", ({ state }) => {
      state.playbackDone = true;
    })
    .onAction("playbackFailed", ({ action, state }) => {
      const status = action.payload?.status;
      const message = action.payload?.message ?? "unknown error";
      state.lastError = status ? `HTTP ${status}: ${message}` : message;
    })
    .build(),
  ui: `
Column {
  Text("Video Component")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("Raw Video")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Video(src: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4", title: "Big Buck Bunny")
    .width(320)
    .height(180)
    .marginBottom(24)

  Text("Video with Controls")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Video(src: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4", controls: true, title: "Big Buck Bunny")
    .width(320)
    .height(180)
    .marginBottom(24)

  Text("Poster (shown before playback starts)")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Video(
    src: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4",
    poster: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/images/ElephantsDream.jpg",
    controls: true,
    title: "Elephants Dream"
  )
    .width(320)
    .height(180)
    .marginBottom(24)

  Text("Playlist (auto-advances; track @{state.currentTrack})")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Video(
    playlist: [
      "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4",
      "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4",
      "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerFun.mp4"
    ],
    controls: true,
    title: "For Bigger shorts playlist",
    onTrackChange: @actions.trackChanged,
    onEnded: @actions.playbackDone
  )
    .width(320)
    .height(180)
    .marginBottom(8)

  Text("Queue finished: @{state.playbackDone}")
    .fontSize(13)
    .color("#666")
    .marginBottom(24)

  Text("Error Handling (bad URL dispatches onError)")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Video(
    src: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/DoesNotExist.mp4",
    controls: true,
    title: "Broken stream demo",
    onError: @actions.playbackFailed
  )
    .width(320)
    .height(180)
    .marginBottom(8)

  Text("Last error: @{state.lastError}")
    .fontSize(13)
    .color("#ef4444")
    .marginBottom(24)

  Text("Autoplay (Muted)")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Video(src: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4", autoplay: true, muted: true, controls: true, title: "Big Buck Bunny (autoplay)")
    .width(320)
    .height(180)
    .marginBottom(24)

  Text("Looping Video")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Video(src: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4", loop: true, controls: true, title: "Big Buck Bunny (loop)")
    .width(320)
    .height(180)
    .marginBottom(24)

  Text("Full Width Video")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Video(src: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4", controls: true, title: "Big Buck Bunny (full width)")
      .fillMaxWidth(true)
      .height(200)
  }
  .padding(16)
  .backgroundColor("#f9fafb")
  .cornerRadius(8)
  .fillMaxWidth(true)
}
.padding(24)
.fillMaxSize(true)
.backgroundColor("#ffffff")
`
};
