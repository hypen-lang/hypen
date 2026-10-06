/**
 * The Hypen DSL template for the benchmark UI.
 *
 * Built as a template literal so the design tokens in `shared/theme.ts` are
 * the *same objects* the React app spreads into its inline styles. The static
 * parts (stat cards, toolbar buttons) are generated from the same shared
 * arrays React maps over, so neither side can quietly render a different
 * number of elements.
 *
 * The node-for-node correspondence with `apps/react/src/App.tsx` is:
 *
 *   Column root        <div style=root>
 *     Row header         <div style=header>
 *       Column             <div style=brandCol>  Text ×2
 *       Column             <div style=spacer>
 *       Text               <span style=rowCount>
 *     Row stats          <div style=statsRow>    Column ×4 with Text ×3
 *     Row toolbar        <div style=toolbar>     Button ×10 with Text ×1
 *     Column listWrap    <div style=listWrap>
 *       List rows          <div style=list>      17 nodes per row
 */

import { T, STATS } from "../../../shared/theme";
import { ACTION_OF, CONTROLS } from "../../../shared/scenarios";

const statCards = STATS.map(
  (s) => `
        Column {
          Text("${s.label}")
            .fontSize(${T.fsXs})
            .color("${T.textMuted}")

          Text("${s.value}")
            .fontSize(${T.fsXl})
            .fontWeight("600")
            .color("${T.text}")

          Text("${s.delta}")
            .fontSize(${T.fsXs})
            .color("${s.positive ? T.green : T.red}")
        }
          .flex(1)
          .gap(${T.gapXs})
          .padding(${T.padMd})
          .backgroundColor("${T.surface}")
          .border("1px solid ${T.border}")
          .borderRadius(${T.radiusMd})`,
).join("\n");

const toolbarButtons = CONTROLS.map(
  (c) => `
        Button {
          Text("${c.caption}")
            .fontSize(${T.fsSm})
            .color("${T.text}")
        }
          .aria("label", "${c.id}")
          .onClick(@actions.${ACTION_OF[c.id]})
          .backgroundColor("${T.surfaceAlt}")
          .border("1px solid ${T.border}")
          .borderRadius(${T.radiusSm})
          .paddingVertical(${T.padSm})
          .paddingHorizontal(${T.padMd})
          .horizontalAlignment("center")`,
).join("\n");

export const template = `
module App {
  Column {
    Row {
      Column {
        Text("Ops Console")
          .fontSize(${T.fsLg})
          .fontWeight("700")
          .color("${T.text}")

        Text("realtime pipeline health")
          .fontSize(${T.fsXs})
          .color("${T.textMuted}")
      }
        .gap(${T.gapXs})

      Column { }
        .flex(1)

      Text("@{state.rows.length} rows")
        .fontSize(${T.fsSm})
        .color("${T.textMuted}")
    }
      .padding(${T.padLg})
      .gap(${T.gapMd})
      .verticalAlignment("center")
      .borderBottom("1px solid ${T.border}")
      .width("100%")

    Row {${statCards}
    }
      .padding(${T.padLg})
      .gap(${T.gapMd})
      .width("100%")

    Row {${toolbarButtons}
    }
      .paddingHorizontal(${T.padLg})
      .gap(${T.gapSm})
      .verticalAlignment("center")
      .flexWrap("wrap")
      .width("100%")

    Column {
      List(@state.rows, key: "id") {
        Row {
          Column {
            Text("@{item.initials}")
              .fontSize(${T.fsSm})
              .fontWeight("700")
              .color("${T.textMuted}")
          }
            .width(${T.avatar})
            .height(${T.avatar})
            .borderRadius(${T.radiusSm})
            .backgroundColor("${T.surfaceAlt}")
            .horizontalAlignment("center")
            .verticalAlignment("center")

          Column {
            Text("@{item.name}")
              .fontSize(${T.fsMd})
              .color("${T.text}")

            Row {
              Text("@{item.team}")
                .fontSize(${T.fsXs})
                .color("${T.textFaint}")

              Text("·")
                .fontSize(${T.fsXs})
                .color("${T.textFaint}")

              Text("@{item.meta}")
                .fontSize(${T.fsXs})
                .color("${T.textFaint}")
            }
              .gap(${T.gapXs})
              .verticalAlignment("center")
          }
            .flex(1)
            .gap(${T.gapXs})

          Column {
            Text("@{item.status}")
              .fontSize(${T.fsXs})
              .fontWeight("600")
              .color("@{item.statusColor}")
          }
            .width(${T.statusWidth})

          Column {
            Text("@{item.value}")
              .fontSize(${T.fsSm})
              .color("${T.textMuted}")
          }
            .width(${T.valueWidth})

          Button {
            Text("Select")
              .fontSize(${T.fsXs})
              .color("${T.text}")
          }
            .aria("label", "row-select")
            .onClick(@actions.rowSelect, id: "@{item.id}")
            .backgroundColor("${T.surfaceAlt}")
            .borderRadius(${T.radiusSm})
            .paddingVertical(${T.gapXs})
            .paddingHorizontal(${T.gapSm})
            .horizontalAlignment("center")

          Button {
            Text("✕")
              .fontSize(${T.fsXs})
              .color("${T.textFaint}")
          }
            .aria("label", "row-remove")
            .onClick(@actions.rowRemove, id: "@{item.id}")
            .backgroundColor("transparent")
            .borderRadius(${T.radiusSm})
            .paddingVertical(${T.gapXs})
            .paddingHorizontal(${T.gapSm})
            .horizontalAlignment("center")
        }
          .width("100%")
          .gap(${T.gapMd})
          .padding(${T.padSm})
          .borderRadius(${T.radiusMd})
          .verticalAlignment("center")
          .backgroundColor("@{item.selected ? '${T.surfaceSelected}' : '${T.surface}'}")
          .border("@{item.selected ? '1px solid ${T.borderSelected}' : '1px solid ${T.border}'}")
      }
        .gap(${T.gapSm})
        .width("100%")
    }
      .padding(${T.padLg})
      .gap(${T.gapSm})
      .width("100%")
  }
    .minHeight("100vh")
    .width("100%")
    .backgroundColor("${T.bg}")
    .color("${T.text}")
    .fontFamily("${T.fontFamily}")
}
`;
