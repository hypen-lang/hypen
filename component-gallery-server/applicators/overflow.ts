/**
 * overflow Applicator Example
 * Controls how content overflows its container.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const overflowExample = {
  module: app.defineState({}).build(),
  ui: `
Column {
  Text("overflow Applicator")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("Overflow options")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Row {
    Column {
      Text("visible")
        .fontSize(12)
        .color("#666")
        .marginBottom(4)
      Stack {
        Text("This text overflows the container and is visible outside")
          .fontSize(12)
      }
      .backgroundColor("#e0e7ff")
      .padding(8)
      .width(80)
      .height(60)
      .overflow("visible")
    }
    .width(80)

    Column {
      Text("hidden")
        .fontSize(12)
        .color("#666")
        .marginBottom(4)
      Stack {
        Text("This text overflows the container but is hidden")
          .fontSize(12)
      }
      .backgroundColor("#dcfce7")
      .padding(8)
      .width(80)
      .height(60)
      .overflow("hidden")
    }
    .width(80)

    Column {
      Text("scroll")
        .fontSize(12)
        .color("#666")
        .marginBottom(4)
      Stack {
        Text("This text overflows and shows scrollbars always")
          .fontSize(12)
      }
      .backgroundColor("#fef3c7")
      .padding(8)
      .width(80)
      .height(60)
      .overflow("scroll")
    }
    .width(80)

    Column {
      Text("auto")
        .fontSize(12)
        .color("#666")
        .marginBottom(4)
      Stack {
        Text("This text overflows and shows scrollbars when needed")
          .fontSize(12)
      }
      .backgroundColor("#fee2e2")
      .padding(8)
      .width(80)
      .height(60)
      .overflow("auto")
    }
    .width(80)
  }
  .gap(8)
  .marginBottom(32)

  Text("Scrollable content")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Stack {
    Column {
      Text("Scrollable List")
        .fontWeight("600")
        .marginBottom(8)
      Text("Item 1")
        .padding(8)
        .backgroundColor("#f0f0f0")
        .cornerRadius(4)
      Text("Item 2")
        .padding(8)
        .backgroundColor("#f0f0f0")
        .cornerRadius(4)
      Text("Item 3")
        .padding(8)
        .backgroundColor("#f0f0f0")
        .cornerRadius(4)
      Text("Item 4")
        .padding(8)
        .backgroundColor("#f0f0f0")
        .cornerRadius(4)
      Text("Item 5")
        .padding(8)
        .backgroundColor("#f0f0f0")
        .cornerRadius(4)
      Text("Item 6")
        .padding(8)
        .backgroundColor("#f0f0f0")
        .cornerRadius(4)
      Text("Item 7")
        .padding(8)
        .backgroundColor("#f0f0f0")
        .cornerRadius(4)
      Text("Item 8")
        .padding(8)
        .backgroundColor("#f0f0f0")
        .cornerRadius(4)
    }
    .gap(4)
  }
  .backgroundColor("#fff")
  .padding(16)
  .cornerRadius(8)
  .border({width: 1, color: "#e5e7eb"})
  .height(200)
  .overflow("auto")
  .fillMaxWidth(true)
  .marginBottom(24)

  Text("Clipped image")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Stack {
    Image(src: "__HYPEN_GALLERY_FIXTURE_BASE__/fixtures/image-300x200.png?platform=__HYPEN_GALLERY_PLATFORM__&example=overflow&generation=__HYPEN_GALLERY_GENERATION__")
      .width(300)
      .height(200)
  }
  .width(150)
  .height(100)
  .overflow("hidden")
  .cornerRadius(8)
}
.padding(24)
.fillMaxSize(true)
.backgroundColor("#ffffff")
`
};
