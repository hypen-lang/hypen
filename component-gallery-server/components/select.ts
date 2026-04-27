/**
 * Select Component Example
 * Dropdown selection input.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const selectExample = {
  module: app.defineState({ selected: "" }).build(),
  ui: `
Column {
  Text("Select Component")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("Raw Select")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Select {
    Text("Option 1")
    Text("Option 2")
    Text("Option 3")
  }
  .marginBottom(24)

  Text("Styled Selects")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Column {
      Text("Country")
        .fontSize(14)
        .fontWeight("500")
        .marginBottom(4)
      Select {
        Text("United States")
        Text("Canada")
        Text("United Kingdom")
        Text("Germany")
        Text("France")
      }
      .padding(12)
      .backgroundColor("#fff")
      .border({width: 1, color: "#d1d5db"})
      .cornerRadius(8)
      .fillMaxWidth(true)
    }

    Column {
      Text("Category")
        .fontSize(14)
        .fontWeight("500")
        .marginBottom(4)
      Select {
        Text("Technology")
        Text("Design")
        Text("Marketing")
        Text("Sales")
      }
      .padding(12)
      .backgroundColor("#f3f4f6")
      .cornerRadius(8)
      .fillMaxWidth(true)
    }

    Column {
      Text("Priority")
        .fontSize(14)
        .fontWeight("500")
        .marginBottom(4)
      Select {
        Text("Low")
        Text("Medium")
        Text("High")
        Text("Critical")
      }
      .padding(12)
      .backgroundColor("#fff")
      .border({width: 2, color: "#3b82f6"})
      .cornerRadius(8)
      .fillMaxWidth(true)
    }
  }
  .gap(16)
  .fillMaxWidth(true)
}
.padding(24)
.fillMaxSize(true)
.backgroundColor("#ffffff")
`
};
