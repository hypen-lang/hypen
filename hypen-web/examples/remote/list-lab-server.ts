/**
 * List Lab: a manual test server for list virtualization.
 *
 *   cd hypen-web && bun run examples/remote/list-lab-server.ts
 *
 * Mode "fixed": the List scrolls itself (480 high). Mode "page": the List
 * grows to its full virtual height and the page scrolls it.
 *
 * Browser (DOM renderer): http://localhost:3000
 * Other clients: ws://localhost:3000, module "ListLab"
 */
import { app } from "../../packages/core/src/app.js";
import { RemoteServer } from "../../packages/server/src/remote/server.js";

type Row = { id: number; name: string; show: boolean };
type State = { rows: Row[]; banner: boolean; nextId: number; mode: "fixed" | "page" };

const make = (from: number, to: number): Row[] =>
  Array.from({ length: to - from }, (_, i) => ({
    id: from + i,
    name: `Row ${from + i}`,
    show: true,
  }));

const listLab = app
  .defineState<State>({ rows: make(0, 10_000), banner: false, nextId: 100_000, mode: process.env.MODE === "page" ? "page" : "fixed" })
  .onAction("prepend", ({ state }) => {
    const id = state.nextId++;
    state.rows = [{ id, name: `New ${id}`, show: true }, ...state.rows];
  })
  .onAction("append", ({ state }) => {
    const id = state.nextId++;
    state.rows = [...state.rows, { id, name: `New ${id}`, show: true }];
  })
  .onAction("removeFirst", ({ state }) => {
    state.rows = state.rows.slice(1);
  })
  .onAction("shuffleTop", ({ state }) => {
    const [first, ...rest] = state.rows;
    if (first) state.rows = [...rest, first];
  })
  .onAction("shrink", ({ state }) => {
    state.rows = state.rows.slice(0, 20);
  })
  .onAction("reset", ({ state }) => {
    state.rows = make(0, 10_000);
  })
  .onAction("toggleBanner", ({ state }) => {
    state.banner = !state.banner;
  })
  .onAction("toggleMode", ({ state }) => {
    state.mode = state.mode === "fixed" ? "page" : "fixed";
  })
  .onAction("deleteRow", ({ action, state }) => {
    const id = Number(action.payload?.id);
    state.rows = state.rows.filter((r) => r.id !== id);
  })
  .build();

const ui = `
  Column {
    If(@state.banner) {
      Text("Banner is on").padding(12).backgroundColor("#fde68a")
    }
    Row {
      Button { Text("Prepend") }.onClick(@actions.prepend).margin(4)
      Button { Text("Append") }.onClick(@actions.append).margin(4)
      Button { Text("Remove first") }.onClick(@actions.removeFirst).margin(4)
      Button { Text("Top to bottom") }.onClick(@actions.shuffleTop).margin(4)
      Button { Text("Shrink to 20") }.onClick(@actions.shrink).margin(4)
      Button { Text("Reset") }.onClick(@actions.reset).margin(4)
      Button { Text("Banner") }.onClick(@actions.toggleBanner).margin(4)
      Button { Text("Mode: @{state.mode}") }.onClick(@actions.toggleMode).margin(4)
    }
    When(value: @state.mode) {
      Case(match: "fixed") {
        List(@state.rows, key: "id") {
          Row {
            Text("@{item.name}").padding(12)
            Button { Text("Delete") }.onClick(@actions.deleteRow, id: "@{item.id}")
          }
          .exit(fade)
        }
        .height(480)
      }
      Else {
        List(@state.rows, key: "id") {
          Row {
            Text("@{item.name}").padding(12)
            Button { Text("Delete") }.onClick(@actions.deleteRow, id: "@{item.id}")
          }
          .exit(fade)
        }
      }
    }
    Text("Footer: below the list").padding(12)
  }
`;

new RemoteServer().module("ListLab", listLab).ui(ui).listen(Number(process.env.PORT ?? 3000));
console.log("List Lab: http://localhost:3000  (ws://localhost:3000, module ListLab)");
