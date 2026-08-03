import { app } from "@hypen-space/core";
import { durableObjectStore, global } from "@hypen-space/cf";

// Todo — the todo sample from hypen-landing (src/lib/samples.ts), ported to
// run as a Cloudflare worker. The DSL template is the landing sample
// verbatim; the module differs only where the platform does:
//
//   - tasks are seeded in initialState instead of onCreated, so DO
//     persistence can hydrate over them cleanly (onCreated re-seeding on
//     every cold start would clobber the stored list);
//   - `.persist(durableObjectStore(global()))` keeps the list across DO
//     hibernation and deploys;
//   - `syncActions: true` in worker.ts mirrors changes to every connected
//     client — one shared list per deployment, live in all tabs.
//
// Beyond `.bind()` + payload actions, this one exercises DEEP proxy
// mutations: `toggleTask` flips `task.done` in place and `addTask` uses
// `unshift`, rather than reassigning the array.

export type Task = { id: string; text: string; done: boolean };
export type TodoState = { tasks: Task[]; newTask: string };

export default app
  .defineState<TodoState>({
    tasks: [
      { id: "1", text: "Learn Hypen", done: true },
      { id: "2", text: "Build an app", done: false },
      { id: "3", text: "Ship to production", done: false },
    ],
    newTask: "",
  })
  .persist(durableObjectStore<TodoState>(global<TodoState>()))
  .onAction("addTask", async ({ state }) => {
    const text = state.newTask.trim();
    if (!text) return;
    state.tasks.unshift({ id: Date.now().toString(), text, done: false });
    state.newTask = "";
  })
  .onAction<{ id: string }>("toggleTask", async ({ action, state }) => {
    const id = action.payload?.id;
    const task = state.tasks.find((t) => t.id === id);
    if (task) task.done = !task.done;
  })
  .onAction<{ id: string }>("removeTask", async ({ action, state }) => {
    const id = action.payload?.id;
    state.tasks = state.tasks.filter((t) => t.id !== id);
  })
  .onAction("clearDone", async ({ state }) => {
    state.tasks = state.tasks.filter((t) => !t.done);
  })
  .ui(`
    module App {
      Column {
        Text("My Tasks")
          .fontSize(24)
          .fontWeight("bold")
          .color("#fff")

        Row {
          Input(placeholder: "Add a task… (Enter)")
            .bind(@state.newTask)
            .onKey(@actions.addTask)
            .padding(10)
            .border("1px solid #333")
            .borderRadius(10)
            .flex(1)
            .backgroundColor("#111")
            .color("#fff")

          Button {
            Text("Add").padding(10).color("black")
          }
            .backgroundColor("#FFA7E1")
            .borderRadius(10)
            .onClick(@actions.addTask)
        }
          .gap(10)
          .verticalAlignment("center")

        Row {
          Text("@{state.tasks.length} tasks")
            .fontSize(12)
            .color("#888")

          Button {
            Text("Clear done").padding(8).color("white")
          }
            .backgroundColor("#333")
            .borderRadius(10)
            .onClick(@actions.clearDone)
        }
          .horizontalAlignment("space-between")
          .verticalAlignment("center")

        List(@state.tasks) {
          Row {
            Text("@{item.text}")
              .color("@{item.done ? '#666' : '#fff'}")
              .textDecoration("@{item.done ? 'line-through' : 'none'}")

            Button {
              Text("Remove").padding(6).color("#666")
            }
              .backgroundColor("transparent")
              .onClick(@actions.removeTask, id: "@{item.id}")
          }
            .padding(12)
            .borderRadius(12)
            .border("1px solid #333")
            .verticalAlignment("center")
            .horizontalAlignment("space-between")
            .onClick(@actions.toggleTask, id: "@{item.id}")
        }
          .gap(8)
      }
        .padding(24)
        .gap(14)
        .width("100%")
        .minHeight("100vh")
        .backgroundColor("#000")
        .color("#fff")
    }
  `);
