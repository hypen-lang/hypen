/**
 * elevation Applicator Example
 * Material Design style elevation levels.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const elevationExample = {
  module: app.defineState({}).build(),
  ui: `
Column {
  Text("elevation Applicator")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("Elevation levels (Material Design)")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Row {
    Column {
      Stack {
        Text("0")
          .fontSize(12)
      }
      .backgroundColor("#fff")
      .padding(16)
      .cornerRadius(8)
      .elevation(0)
      Text("elevation(0)")
        .fontSize(10)
        .color("#666")
        .marginTop(8)
    }
    .horizontalAlignment("center")

    Column {
      Stack {
        Text("1")
          .fontSize(12)
      }
      .backgroundColor("#fff")
      .padding(16)
      .cornerRadius(8)
      .elevation(1)
      Text("elevation(1)")
        .fontSize(10)
        .color("#666")
        .marginTop(8)
    }
    .horizontalAlignment("center")

    Column {
      Stack {
        Text("2")
          .fontSize(12)
      }
      .backgroundColor("#fff")
      .padding(16)
      .cornerRadius(8)
      .elevation(2)
      Text("elevation(2)")
        .fontSize(10)
        .color("#666")
        .marginTop(8)
    }
    .horizontalAlignment("center")

    Column {
      Stack {
        Text("4")
          .fontSize(12)
      }
      .backgroundColor("#fff")
      .padding(16)
      .cornerRadius(8)
      .elevation(4)
      Text("elevation(4)")
        .fontSize(10)
        .color("#666")
        .marginTop(8)
    }
    .horizontalAlignment("center")

    Column {
      Stack {
        Text("8")
          .fontSize(12)
      }
      .backgroundColor("#fff")
      .padding(16)
      .cornerRadius(8)
      .elevation(8)
      Text("elevation(8)")
        .fontSize(10)
        .color("#666")
        .marginTop(8)
    }
    .horizontalAlignment("center")
  }
  .gap(12)
  .padding(24)
  .backgroundColor("#f0f0f0")
  .cornerRadius(8)
  .marginBottom(24)

  Text("Higher elevations")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Row {
    Column {
      Stack {
        Text("12")
          .fontSize(12)
      }
      .backgroundColor("#fff")
      .padding(20)
      .cornerRadius(12)
      .elevation(12)
      Text("elevation(12)")
        .fontSize(10)
        .color("#666")
        .marginTop(8)
    }
    .horizontalAlignment("center")

    Column {
      Stack {
        Text("16")
          .fontSize(12)
      }
      .backgroundColor("#fff")
      .padding(20)
      .cornerRadius(12)
      .elevation(16)
      Text("elevation(16)")
        .fontSize(10)
        .color("#666")
        .marginTop(8)
    }
    .horizontalAlignment("center")

    Column {
      Stack {
        Text("24")
          .fontSize(12)
      }
      .backgroundColor("#fff")
      .padding(20)
      .cornerRadius(12)
      .elevation(24)
      Text("elevation(24)")
        .fontSize(10)
        .color("#666")
        .marginTop(8)
    }
    .horizontalAlignment("center")
  }
  .gap(24)
  .padding(24)
  .backgroundColor("#f0f0f0")
  .cornerRadius(8)
  .marginBottom(24)

  Text("Use cases")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Stack {
      Text("Card - elevation(2)")
        .fontWeight("500")
    }
    .backgroundColor("#fff")
    .padding(16)
    .cornerRadius(8)
    .elevation(2)
    .fillMaxWidth(true)

    Stack {
      Text("Raised Button - elevation(4)")
        .color("#fff")
        .fontWeight("500")
    }
    .backgroundColor("#3b82f6")
    .padding(12)
    .cornerRadius(8)
    .elevation(4)
    .horizontalAlignment("center")

    Stack {
      Text("Modal - elevation(16)")
        .fontWeight("500")
    }
    .backgroundColor("#fff")
    .padding(20)
    .cornerRadius(12)
    .elevation(16)
    .fillMaxWidth(true)
  }
  .gap(16)
}
.padding(24)
.fillMaxSize(true)
.backgroundColor("#e5e7eb")
`
};
