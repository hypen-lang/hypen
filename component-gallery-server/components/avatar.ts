/**
 * Avatar Component Example
 * User profile picture or initials.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const avatarExample = {
  module: app.defineState({}).build(),
  ui: `
Column {
  Text("Avatar Component")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("Raw Avatar")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Avatar(src: "https://i.pravatar.cc/100?1")
    .marginBottom(24)

  Text("Avatar Sizes")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Row {
    Column {
      Avatar(src: "https://i.pravatar.cc/100?2")
        .width(32)
        .height(32)
        .cornerRadius(16)
      Text("XS")
        .fontSize(10)
        .color("#666")
        .marginTop(4)
    }
    .horizontalAlignment("center")

    Column {
      Avatar(src: "https://i.pravatar.cc/100?3")
        .width(40)
        .height(40)
        .cornerRadius(20)
      Text("SM")
        .fontSize(10)
        .color("#666")
        .marginTop(4)
    }
    .horizontalAlignment("center")

    Column {
      Avatar(src: "https://i.pravatar.cc/100?4")
        .width(56)
        .height(56)
        .cornerRadius(28)
      Text("MD")
        .fontSize(10)
        .color("#666")
        .marginTop(4)
    }
    .horizontalAlignment("center")

    Column {
      Avatar(src: "https://i.pravatar.cc/100?5")
        .width(72)
        .height(72)
        .cornerRadius(36)
      Text("LG")
        .fontSize(10)
        .color("#666")
        .marginTop(4)
    }
    .horizontalAlignment("center")

    Column {
      Avatar(src: "https://i.pravatar.cc/100?6")
        .width(96)
        .height(96)
        .cornerRadius(48)
      Text("XL")
        .fontSize(10)
        .color("#666")
        .marginTop(4)
    }
    .horizontalAlignment("center")
  }
  .gap(16)
  .marginBottom(24)

  Text("Avatar with Initials")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Row {
    Column {
      Text("JD")
        .color("#fff")
        .fontWeight("600")
    }
    .backgroundColor("#3b82f6")
    .width(48)
    .height(48)
    .cornerRadius(24)
    .horizontalAlignment("center")
    .verticalAlignment("center")

    Column {
      Text("AB")
        .color("#fff")
        .fontWeight("600")
    }
    .backgroundColor("#22c55e")
    .width(48)
    .height(48)
    .cornerRadius(24)
    .horizontalAlignment("center")
    .verticalAlignment("center")

    Column {
      Text("MK")
        .color("#fff")
        .fontWeight("600")
    }
    .backgroundColor("#f59e0b")
    .width(48)
    .height(48)
    .cornerRadius(24)
    .horizontalAlignment("center")
    .verticalAlignment("center")

    Column {
      Text("RW")
        .color("#fff")
        .fontWeight("600")
    }
    .backgroundColor("#8b5cf6")
    .width(48)
    .height(48)
    .cornerRadius(24)
    .horizontalAlignment("center")
    .verticalAlignment("center")
  }
  .gap(12)
  .marginBottom(24)

  Text("Avatar Group")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Row {
    Avatar(src: "https://i.pravatar.cc/100?7")
      .width(40)
      .height(40)
      .cornerRadius(20)
      .border({width: 2, color: "#fff"})
    Avatar(src: "https://i.pravatar.cc/100?8")
      .width(40)
      .height(40)
      .cornerRadius(20)
      .border({width: 2, color: "#fff"})
      .marginLeft(-12)
    Avatar(src: "https://i.pravatar.cc/100?9")
      .width(40)
      .height(40)
      .cornerRadius(20)
      .border({width: 2, color: "#fff"})
      .marginLeft(-12)
    Column {
      Text("+5")
        .color("#666")
        .fontSize(12)
        .fontWeight("600")
    }
    .backgroundColor("#e5e7eb")
    .width(40)
    .height(40)
    .cornerRadius(20)
    .horizontalAlignment("center")
    .verticalAlignment("center")
    .marginLeft(-12)
    .border({width: 2, color: "#fff"})
  }
}
.padding(24)
.fillMaxSize(true)
.backgroundColor("#ffffff")
`
};
