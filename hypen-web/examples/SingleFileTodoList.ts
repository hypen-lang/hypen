/**
 * Single-File Todo List Example
 *
 * Demonstrates:
 * - Single-file component with .ui(hypen`...`)
 * - List rendering with @{item.x} bindings
 * - Complex state management
 * - Multiple actions
 */

import { app, hypen, state, item } from "../packages/core/src/index.js";

type Todo = {
  id: number;
  text: string;
  done: boolean;
};

type TodoListState = {
  todos: Todo[];
  newTodoText: string;
  filter: "all" | "active" | "completed";
};

export default app
  .defineState<TodoListState>({
    todos: [
      { id: 1, text: "Learn Hypen", done: true },
      { id: 2, text: "Build something cool", done: false },
      { id: 3, text: "Ship it!", done: false },
    ],
    newTodoText: "",
    filter: "all",
  })
  .onAction("addTodo", ({ state }) => {
    if (!state.newTodoText.trim()) return;

    state.todos = [
      ...state.todos,
      {
        id: Date.now(),
        text: state.newTodoText.trim(),
        done: false,
      },
    ];
    state.newTodoText = "";
  })
  .onAction("toggleTodo", ({ action, state }) => {
    const { id } = action.payload as { id: number };
    state.todos = state.todos.map((todo) =>
      todo.id === id ? { ...todo, done: !todo.done } : todo
    );
  })
  .onAction("deleteTodo", ({ action, state }) => {
    const { id } = action.payload as { id: number };
    state.todos = state.todos.filter((todo) => todo.id !== id);
  })
  .onAction("clearCompleted", ({ state }) => {
    state.todos = state.todos.filter((todo) => !todo.done);
  })
  .onAction("setFilter", ({ action, state }) => {
    state.filter = action.payload as "all" | "active" | "completed";
  })
  .ui(hypen`
    Column {
      Text("Todo List")
        .fontSize(28)
        .fontWeight("bold")
        .color("#00ff88")
        .marginBottom(24)

      Row {
        Input("@{state.newTodoText}")
          .placeholder("What needs to be done?")
          .flex(1)
          .padding(12)
          .backgroundColor("#2a2a2a")
          .border("1px solid #3a3a3a")
          .borderRadius(8)
          .color("#e0e0e0")
          .fontSize(16)

        Button {
          Text("Add")
            .color("#0a0a0a")
            .fontWeight("600")
        }
        .onClick("@actions.addTodo")
        .padding(12)
        .paddingLeft(24)
        .paddingRight(24)
        .backgroundColor("#00ff88")
        .borderRadius(8)
        .border("none")
        .cursor("pointer")
        .marginLeft(8)
      }
      .marginBottom(24)

      Row {
        Button {
          Text("All")
            .color("#e0e0e0")
            .fontSize(14)
        }
        .onClick("@actions.setFilter", filter: "all")
        .padding(8)
        .paddingLeft(16)
        .paddingRight(16)
        .backgroundColor("#2a2a2a")
        .borderRadius(4)
        .border("1px solid #3a3a3a")
        .cursor("pointer")

        Button {
          Text("Active")
            .color("#e0e0e0")
            .fontSize(14)
        }
        .onClick("@actions.setFilter", filter: "active")
        .padding(8)
        .paddingLeft(16)
        .paddingRight(16)
        .backgroundColor("#2a2a2a")
        .borderRadius(4)
        .border("1px solid #3a3a3a")
        .cursor("pointer")

        Button {
          Text("Completed")
            .color("#e0e0e0")
            .fontSize(14)
        }
        .onClick("@actions.setFilter", filter: "completed")
        .padding(8)
        .paddingLeft(16)
        .paddingRight(16)
        .backgroundColor("#2a2a2a")
        .borderRadius(4)
        .border("1px solid #3a3a3a")
        .cursor("pointer")
      }
      .gap(8)
      .marginBottom(16)

      List(@state.todos) {
        Row {
          Checkbox("@{item.done}")
            .onClick("@actions.toggleTodo", id: "@{item.id}")

          Text("@{item.text}")
            .flex(1)
            .fontSize(16)
            .color("@{item.done ? '#666' : '#e0e0e0'}")
            .textDecoration("@{item.done ? 'line-through' : 'none'}")
            .marginLeft(12)

          Button {
            Text("x")
              .color("#888")
              .fontSize(18)
          }
          .onClick("@actions.deleteTodo", id: "@{item.id}")
          .padding(4)
          .paddingLeft(12)
          .paddingRight(12)
          .backgroundColor("transparent")
          .border("none")
          .cursor("pointer")
        }
        .padding(12)
        .backgroundColor("#1a1a1a")
        .borderRadius(8)
        .marginBottom(8)
        .verticalAlignment("center")
      }

      Row {
        Text("@{state.todos.length} items")
          .color("#666")
          .fontSize(14)

        Button {
          Text("Clear completed")
            .color("#888")
            .fontSize(14)
        }
        .onClick("@actions.clearCompleted")
        .padding(8)
        .backgroundColor("transparent")
        .border("none")
        .cursor("pointer")
      }
      .horizontalAlignment("space-between")
      .marginTop(16)
    }
    .padding(32)
    .backgroundColor("#0a0a0a")
    .borderRadius(16)
    .border("1px solid #1a1a1a")
    .maxWidth(500)
    .width("100%")
  `);
