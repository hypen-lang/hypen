/**
 * ProgressBar Component Example
 * Visual progress indicator.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const progressbarExample = {
  module: app.defineState({}).build(),
  ui: `
Column {
  Text("ProgressBar Component")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("Raw ProgressBar")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  ProgressBar(value: 50)
    .fillMaxWidth(true)
    .marginBottom(24)

  Text("Styled Progress Bars")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Column {
      Row {
        Text("Downloads")
          .fontSize(14)
          .fontWeight("500")
        Spacer()
        Text("75%")
          .fontSize(14)
          .color("#666")
      }
      .marginBottom(8)
      ProgressBar(value: 75)
        .height(8)
        .cornerRadius(4)
        .fillMaxWidth(true)
    }

    Column {
      Row {
        Text("Storage")
          .fontSize(14)
          .fontWeight("500")
        Spacer()
        Text("45%")
          .fontSize(14)
          .color("#666")
      }
      .marginBottom(8)
      ProgressBar(value: 45)
        .height(8)
        .cornerRadius(4)
        .fillMaxWidth(true)
    }

    Column {
      Row {
        Text("Upload")
          .fontSize(14)
          .fontWeight("500")
        Spacer()
        Text("90%")
          .fontSize(14)
          .color("#666")
      }
      .marginBottom(8)
      ProgressBar(value: 90)
        .height(8)
        .cornerRadius(4)
        .fillMaxWidth(true)
    }
  }
  .gap(20)
  .padding(20)
  .backgroundColor("#f9fafb")
  .cornerRadius(12)
  .fillMaxWidth(true)
  .marginBottom(24)

  Text("Different Heights")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Text("Thin")
      .fontSize(12)
      .color("#666")
      .marginBottom(4)
    ProgressBar(value: 60)
      .height(4)
      .cornerRadius(2)
      .fillMaxWidth(true)

    Text("Normal")
      .fontSize(12)
      .color("#666")
      .marginBottom(4)
      .marginTop(12)
    ProgressBar(value: 60)
      .height(8)
      .cornerRadius(4)
      .fillMaxWidth(true)

    Text("Thick")
      .fontSize(12)
      .color("#666")
      .marginBottom(4)
      .marginTop(12)
    ProgressBar(value: 60)
      .height(16)
      .cornerRadius(8)
      .fillMaxWidth(true)
  }
}
.padding(24)
.fillMaxSize(true)
.backgroundColor("#ffffff")
`
};
