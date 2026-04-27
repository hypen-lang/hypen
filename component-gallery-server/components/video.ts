/**
 * Video Component Example
 * Video player element using Media3 ExoPlayer.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const videoExample = {
  module: app.defineState({}).build(),
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

  Video(src: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4")
    .width(320)
    .height(180)
    .marginBottom(24)

  Text("Video with Controls")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Video(src: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4", controls: true)
    .width(320)
    .height(180)
    .marginBottom(24)

  Text("Autoplay (Muted)")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Video(src: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4", autoplay: true, muted: true, controls: true)
    .width(320)
    .height(180)
    .marginBottom(24)

  Text("Looping Video")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Video(src: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4", loop: true, controls: true)
    .width(320)
    .height(180)
    .marginBottom(24)

  Text("Full Width Video")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Video(src: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4", controls: true)
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
