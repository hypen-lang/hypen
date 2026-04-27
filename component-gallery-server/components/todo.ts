/**
 * Todo Example
 * Fully functional todo list with add, toggle, remove, and clear done.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

type Task = { id: string; text: string; done: boolean };
type TodoState = { tasks: Task[]; newTask: string };

export const todoExample = {
  module: app
    .defineState<TodoState>({
      tasks: [],
      newTask: "",
    })
    .onCreated(async (state) => {
      state.tasks = [
        { id: "1", text: "Learn Hypen", done: true },
        { id: "2", text: "Build an app", done: false },
        { id: "3", text: "Ship to production", done: false },
      ];
    })
    .onAction("addTask", async ({ state }) => {
      const text = state.newTask.trim();
      if (!text) return;
      state.tasks.unshift({ id: Date.now().toString(), text, done: false });
      state.newTask = "";
    })
    .onAction("toggleTask", async ({ action, state }) => {
      const id = action.payload?.id;
      const task = state.tasks.find(t => t.id === id);
      if (task) task.done = !task.done;
    })
    .onAction("removeTask", async ({ action, state }) => {
      const id = action.payload?.id;
      state.tasks = state.tasks.filter(t => t.id !== id);
    })
    .onAction("clearDone", async ({ state }) => {
      state.tasks = state.tasks.filter(t => !t.done);
    })
    .build(),

  ui: `
Column {
  Text("My Tasks")
    .fontSize(24)
    .fontWeight("bold")
    .color("#fff")

  Row {
    Input(placeholder: "Add a task…")
      .bind(@state.newTask)
      .padding(10)
      .border({width: 1, color: "#333"})
      .cornerRadius(10)
      .flex(1)
      .backgroundColor("#111")
      .color("#fff")
      .onKey(@actions.addTask)

    Button {
      Text("Add")
        .padding(10)
        .color("black")
    }
      .backgroundColor("#FFA7E1")
      .cornerRadius(10)
      .onClick(@actions.addTask)
  }
    .gap(10)
    .verticalAlignment("center")

  Row {
    Text("@{state.tasks.length} tasks")
      .fontSize(12)
      .color("#888")

    Button {
      Text("Clear done")
        .padding(8)
        .color("white")
    }
      .backgroundColor("#333")
      .cornerRadius(10)
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
        Text("Remove")
          .padding(6)
          .color("#666")
      }
        .backgroundColor("transparent")
        .onClick(@actions.removeTask, id: "@{item.id}")
    }
      .padding(12)
      .cornerRadius(12)
      .border({width: 1, color: "#333"})
      .verticalAlignment("center")
      .horizontalAlignment("space-between")
      .onClick(@actions.toggleTask, id: "@{item.id}")
  }
    .gap(8)
}
  .padding(24)
  .gap(14)
  .fillMaxSize(true)
  .backgroundColor("#000")
  .color("#fff")
`
};
