/**
 * Switch Component Example
 * Toggle switch input.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

export const switchExample = {
  module: app
    .defineState({ wifi: true, bluetooth: false, notifications: true })
    .onAction("toggleWifi", ({ state }) => { state.wifi = !state.wifi; })
    .onAction("toggleBluetooth", ({ state }) => { state.bluetooth = !state.bluetooth; })
    .onAction("toggleNotifications", ({ state }) => { state.notifications = !state.notifications; })
    .build(),
  ui: `
Column {
  Text("Switch Component")
    .fontSize(24)
    .fontWeight("700")
    .color("#1a1a1a")
    .marginBottom(24)

  Text("Raw Switch")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Switch()
    .marginBottom(24)

  Text("Styled Switches")
    .fontSize(14)
    .color("#666")
    .marginBottom(8)

  Column {
    Row {
      Column {
        Text("Wi-Fi")
          .fontWeight("500")
        Text("Connect to wireless networks")
          .fontSize(12)
          .color("#666")
      }
      .weight(1)
      Switch(checked: "@{state.wifi}")
        .onChange("@actions.toggleWifi")
    }
    .padding(16)
    .horizontalAlignment("center")

    Divider()
      .backgroundColor("#e5e7eb")

    Row {
      Column {
        Text("Bluetooth")
          .fontWeight("500")
        Text("Connect to nearby devices")
          .fontSize(12)
          .color("#666")
      }
      .weight(1)
      Switch(checked: "@{state.bluetooth}")
        .onChange("@actions.toggleBluetooth")
    }
    .padding(16)
    .horizontalAlignment("center")

    Divider()
      .backgroundColor("#e5e7eb")

    Row {
      Column {
        Text("Notifications")
          .fontWeight("500")
        Text("Receive push notifications")
          .fontSize(12)
          .color("#666")
      }
      .weight(1)
      Switch(checked: "@{state.notifications}")
        .onChange("@actions.toggleNotifications")
    }
    .padding(16)
    .horizontalAlignment("center")
  }
  .backgroundColor("#fff")
  .cornerRadius(12)
  .border({width: 1, color: "#e5e7eb"})
}
.padding(24)
.fillMaxSize(true)
.backgroundColor("#f9fafb")
`
};
