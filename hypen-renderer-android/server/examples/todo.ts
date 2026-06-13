import { app } from "../../../hypen-web/packages/core/src/index.ts";

export type TodoItem = { id: number; text: string; done: boolean };

export type TodoState = {
  tasks: TodoItem[];
  newTask: string;
};

export const todoModule = app
  .defineState<TodoState>({
    tasks: [
      { id: 1, text: "Learn Hypen", done: true },
      { id: 2, text: "Build an app", done: false },
      { id: 3, text: "Ship to production", done: false },
    ],
    newTask: "",
  })
  .onAction("addTask", async ({ state }) => {
    if (state.newTask.trim()) {
      state.tasks = [...state.tasks, {
        id: Date.now(),
        text: state.newTask,
        done: false
      }];
      state.newTask = "";
    }
  })
  .onAction("toggleTask", async ({ action, state }) => {
    const id = Number(action.payload?.id);
    state.tasks = state.tasks.map(t =>
      t.id === id ? { ...t, done: !t.done } : t
    );
  })
  .onAction("removeTask", async ({ action, state }) => {
    const id = Number(action.payload?.id);
    state.tasks = state.tasks.filter(t => t.id !== id);
  })
  .onAction("updateNewTask", async ({ action, state }) => {
    state.newTask = action.payload?.value ?? "";
  })
  .onAction("clearDone", async ({ state }) => {
    state.tasks = state.tasks.filter(t => !t.done);
  })
  .build();

export const todoUI = `
Column {
  Text("My Tasks")
    .fontSize(28)
    .fontWeight("bold")
    .color("#ffffff")
    .marginBottom(8)

  Text("@{state.tasks.length} tasks")
    .fontSize(14)
    .color("#888888")

  Row {
    Input(
      value: @state.newTask,
      placeholder: "Add a task..."
    )
      .onInput(@actions.updateNewTask)
      .flex(1)
      .padding(14)
      .backgroundColor("#1a1a1a")
      .color("#ffffff")
      .borderRadius(12)
      .borderWidth(1)
      .borderColor("#333333")

    Button {
      Text("Add")
        .fontSize(16)
        .fontWeight("600")
        .color("#000000")
    }
      .onClick(@actions.addTask)
      .paddingLeft(24)
      .paddingRight(24)
      .paddingTop(14)
      .paddingBottom(14)
      .backgroundColor("#FFA7E1")
      .borderRadius(12)
  }
    .gap(12)
    .marginTop(20)
    .verticalAlignment("center")

  Button {
    Text("Clear completed")
      .fontSize(14)
      .color("#888888")
  }
    .onClick(@actions.clearDone)
    .paddingLeft(16)
    .paddingRight(16)
    .paddingTop(10)
    .paddingBottom(10)
    .backgroundColor("#1a1a1a")
    .borderRadius(8)
    .marginTop(16)

  List(@state.tasks) {
    Row {
      Text("@{item.done ? '✓' : '○'}")
        .fontSize(20)
        .color("@{item.done ? '#22c55e' : '#666666'}")
        .width(32)

      Text("@{item.text}")
        .fontSize(16)
        .color("@{item.done ? '#666666' : '#ffffff'}")
        .textDecoration("@{item.done ? 'line-through' : 'none'}")
        .flex(1)

      Button {
        Text("×")
          .fontSize(18)
          .color("#ef4444")
      }
        .onClick(@actions.removeTask, id: "@{item.id}")
        .width(36)
        .height(36)
        .backgroundColor("#1a1a1a")
        .borderRadius(18)
        .horizontalAlignment("center")
        .verticalAlignment("center")
    }
      .padding(16)
      .backgroundColor("#111111")
      .borderRadius(12)
      .borderWidth(1)
      .borderColor("#333333")
      .verticalAlignment("center")
      .onClick(@actions.toggleTask, id: "@{item.id}")
  }
    .gap(10)
    .marginTop(20)
}
  .padding(24)
  .fillMaxSize()
  .backgroundColor("#000000")
`;
