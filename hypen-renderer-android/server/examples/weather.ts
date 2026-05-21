import { app } from "../../../hypen-web/packages/core/src/index.ts";

export type WeatherState = {
  city: string;
  temp: number;
  condition: string;
  humidity: number;
  wind: number;
};

export const weatherModule = app
  .defineState<WeatherState>({
    city: "San Francisco",
    temp: 18,
    condition: "Partly Cloudy",
    humidity: 65,
    wind: 12,
  })
  .onAction("refresh", async ({ state }) => {
    state.temp = Math.floor(Math.random() * 10) + 15;
    state.humidity = Math.floor(Math.random() * 30) + 50;
    const conditions = ["Sunny", "Partly Cloudy", "Cloudy", "Light Rain"];
    state.condition = conditions[Math.floor(Math.random() * conditions.length)];
  })
  .build();

export const weatherUI = `
Column {
  Column {
    Text("@{state.city}")
      .fontSize(28)
      .fontWeight("600")
      .color("#ffffff")

    Text("@{state.condition}")
      .fontSize(16)
      .color("rgba(255,255,255,0.8)")
      .marginTop(4)
  }
  .padding(32)
  .horizontalAlignment("center")

  Column {
    Text("@{state.temp}°")
      .fontSize(120)
      .fontWeight("200")
      .color("#ffffff")
  }
  .horizontalAlignment("center")
  .paddingTop(32)
  .paddingBottom(32)

  Row {
    Column {
      Text("@{state.humidity}%")
        .fontSize(24)
        .fontWeight("600")
        .color("#ffffff")
      Text("Humidity")
        .fontSize(14)
        .color("rgba(255,255,255,0.7)")
        .marginTop(4)
    }
    .horizontalAlignment("center")
    .flex(1)

    Column {
      Text("@{state.wind} km/h")
        .fontSize(24)
        .fontWeight("600")
        .color("#ffffff")
      Text("Wind")
        .fontSize(14)
        .color("rgba(255,255,255,0.7)")
        .marginTop(4)
    }
    .horizontalAlignment("center")
    .flex(1)
  }
  .padding(32)

  Column {
    Text("5-Day Forecast")
      .fontSize(16)
      .fontWeight("600")
      .color("rgba(255,255,255,0.9)")
      .marginBottom(20)

    Row {
      Column {
        Text("Mon")
          .fontSize(14)
          .color("rgba(255,255,255,0.7)")
        Text("19°")
          .fontSize(20)
          .fontWeight("600")
          .color("#ffffff")
          .marginTop(8)
        Text("12°")
          .fontSize(14)
          .color("rgba(255,255,255,0.5)")
      }
      .horizontalAlignment("center")
      .flex(1)

      Column {
        Text("Tue")
          .fontSize(14)
          .color("rgba(255,255,255,0.7)")
        Text("17°")
          .fontSize(20)
          .fontWeight("600")
          .color("#ffffff")
          .marginTop(8)
        Text("11°")
          .fontSize(14)
          .color("rgba(255,255,255,0.5)")
      }
      .horizontalAlignment("center")
      .flex(1)

      Column {
        Text("Wed")
          .fontSize(14)
          .color("rgba(255,255,255,0.7)")
        Text("20°")
          .fontSize(20)
          .fontWeight("600")
          .color("#ffffff")
          .marginTop(8)
        Text("13°")
          .fontSize(14)
          .color("rgba(255,255,255,0.5)")
      }
      .horizontalAlignment("center")
      .flex(1)

      Column {
        Text("Thu")
          .fontSize(14)
          .color("rgba(255,255,255,0.7)")
        Text("16°")
          .fontSize(20)
          .fontWeight("600")
          .color("#ffffff")
          .marginTop(8)
        Text("10°")
          .fontSize(14)
          .color("rgba(255,255,255,0.5)")
      }
      .horizontalAlignment("center")
      .flex(1)

      Column {
        Text("Fri")
          .fontSize(14)
          .color("rgba(255,255,255,0.7)")
        Text("18°")
          .fontSize(20)
          .fontWeight("600")
          .color("#ffffff")
          .marginTop(8)
        Text("11°")
          .fontSize(14)
          .color("rgba(255,255,255,0.5)")
      }
      .horizontalAlignment("center")
      .flex(1)
    }
  }
  .padding(24)
  .marginTop(16)
  .backgroundColor("rgba(255,255,255,0.15)")
  .borderRadius(20)
  .marginLeft(24)
  .marginRight(24)

  Spacer()

    Text("Refresh Weather")
      .fontSize(16)
      .fontWeight("600")
      .color("#0ea5e9")
  .onClick(@actions.refresh)
  .paddingLeft("32px")
  .paddingRight("32px")
  .paddingTop("16pt")
  .paddingBottom("16pt")
  .backgroundColor("#ffffff")
  .borderRadius(30)
  .marginBottom(32)
}
.fillMaxSize()
.backgroundColor("#0ea5e9")
.horizontalAlignment("center")
`;


We have an important task for you. You will be dedicated to fixing our hypen-renderer-android library.
You will read `./component-gallery-server/components.md`, line by line.
Each line represents a component or an applicator in our renderer. Some of them might have issues.
Your goal is to go over each, visually compare it and fix issues if they exists.
Your flow will be as this:
1. Open a deep  link for an applicator or component from component library using a command. ( example: `adb shell am start -a android.intent.action.VIEW -d "hypengallery://components?name=Text"`)
2. Take a screenshot (`adb exec-out screencap -p > screenshot.png`)
3. Look at the screenshot. Verify that applicator/component works ok. If it doesnt, fix the rendering code for that component/applicator in hypen-renderer-android/renderer.
Once you fix it, run `./gradlew :app:installDebug` to build and install it, once that is done, go back to #1.
4. If it needs no fixing or is fixed, go to the next component.

Do not stop until all are covered. Any comments along the way should be written in comments.md.
