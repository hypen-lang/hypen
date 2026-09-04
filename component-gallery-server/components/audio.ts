/**
 * Audio Component Example
 * Audio player element.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const audioExample = {
  module: app.defineState({}).build(),
  ui: `
Column {
  Text("Audio Component")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("Raw Audio")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Audio(src: "__HYPEN_GALLERY_FIXTURE_BASE__/fixtures/sample.wav?platform=__HYPEN_GALLERY_PLATFORM__&example=audio&generation=__HYPEN_GALLERY_GENERATION__")
    .marginBottom(24)

  Text("Styled Audio")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Audio(src: "__HYPEN_GALLERY_FIXTURE_BASE__/fixtures/sample.wav?platform=__HYPEN_GALLERY_PLATFORM__&example=audio&generation=__HYPEN_GALLERY_GENERATION__", controls: true)
      .fillMaxWidth(true)
  }
  .padding(16)
  .backgroundColor("#f9fafb")
  .cornerRadius(8)
  .fillMaxWidth(true)
  .marginBottom(24)

  Text("Audio Card")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Row {
      Column {
        Text("Horse Sound")
          .color("#fff")
          .fontWeight("600")
      }
      .backgroundColor("#8b5cf6")
      .width(64)
      .height(64)
      .cornerRadius(8)
      .horizontalAlignment("center")
      .verticalAlignment("center")

      Column {
        Text("Horse.mp3")
          .fontWeight("600")
          .marginBottom(4)
        Text("Sample audio file")
          .fontSize(14)
          .color("#666")
      }
      .marginLeft(12)
    }
    .horizontalAlignment("center")
    .marginBottom(12)

    Audio(src: "__HYPEN_GALLERY_FIXTURE_BASE__/fixtures/sample.wav?platform=__HYPEN_GALLERY_PLATFORM__&example=audio&generation=__HYPEN_GALLERY_GENERATION__", controls: true)
      .fillMaxWidth(true)
  }
  .padding(16)
  .backgroundColor("#fff")
  .cornerRadius(12)
  .border({width: 1, color: "#e5e7eb"})
  .fillMaxWidth(true)
  .marginBottom(24)

  Text("Playlist Example")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Row {
      Column {
        Text("1")
          .color("#3b82f6")
          .fontWeight("600")
      }
      .width(32)

      Column {
        Text("Track 1")
          .fontWeight("500")
        Text("0:02")
          .fontSize(12)
          .color("#666")
      }
      .weight(1)
    }
    .padding(12)
    .backgroundColor("#eff6ff")
    .cornerRadius(8)
    .horizontalAlignment("center")

    Row {
      Column {
        Text("2")
          .color("#666")
          .fontWeight("600")
      }
      .width(32)

      Column {
        Text("Track 2")
          .fontWeight("500")
        Text("0:03")
          .fontSize(12)
          .color("#666")
      }
      .weight(1)
    }
    .padding(12)
    .horizontalAlignment("center")

    Row {
      Column {
        Text("3")
          .color("#666")
          .fontWeight("600")
      }
      .width(32)

      Column {
        Text("Track 3")
          .fontWeight("500")
        Text("0:04")
          .fontSize(12)
          .color("#666")
      }
      .weight(1)
    }
    .padding(12)
    .horizontalAlignment("center")
  }
  .backgroundColor("#fff")
  .cornerRadius(8)
  .border({width: 1, color: "#e5e7eb"})
  .fillMaxWidth(true)
}
.padding(24)
.fillMaxSize(true)
.backgroundColor("#ffffff")
`
};
