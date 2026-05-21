import { app } from "../../../hypen-web/packages/core/src/index.ts";

export type NotesState = {
  notes: Array<{ id: number; title: string; preview: string; date: string; color: string }>;
  selectedId: number | null;
};

export const notesModule = app
  .defineState<NotesState>({
    notes: [
      { id: 1, title: "Meeting Notes", preview: "Discuss Q4 roadmap and priorities...", date: "Today", color: "#fef3c7" },
      { id: 2, title: "Shopping List", preview: "Milk, eggs, bread, butter...", date: "Yesterday", color: "#dbeafe" },
      { id: 3, title: "Ideas", preview: "New app concept for productivity...", date: "Dec 15", color: "#f3e8ff" },
      { id: 4, title: "Book Notes", preview: "Key takeaways from Atomic Habits...", date: "Dec 10", color: "#dcfce7" },
    ],
    selectedId: null,
  })
  .onAction("selectNote", async ({ action, state }) => {
    state.selectedId = action.payload?.id;
  })
  .onAction("addNote", async ({ state }) => {
    const colors = ["#fef3c7", "#dbeafe", "#f3e8ff", "#dcfce7", "#fee2e2"];
    state.notes = [
      { id: Date.now(), title: "New Note", preview: "Start writing...", date: "Just now", color: colors[Math.floor(Math.random() * colors.length)] },
      ...state.notes,
    ];
  })
  .build();

export const notesUI = `
Column {
  Row {
    Text("Notes")
      .fontSize(28)
      .fontWeight("600")
      .color("#1a1a1a")

    Spacer()

    Button {
      Text("+")
        .fontSize(20)
        .fontWeight("600")
        .color("#ffffff")
    }
    .onClick(@actions.addNote)
    .width(40)
    .height(40)
    .backgroundColor("#8b5cf6")
    .borderRadius(20)
    .horizontalAlignment("center")
    .verticalAlignment("center")
  }
  .padding(24)
  .verticalAlignment("center")

  Column {
    Text("4 notes")
      .fontSize(14)
      .color("#9ca3af")
  }
  .paddingLeft(24)
  .paddingRight(24)
  .marginBottom(16)

  Column {
    Column {
      Row {
        Text("Meeting Notes")
          .fontSize(16)
          .fontWeight("600")
          .color("#1a1a1a")
        Spacer()
        Text("Today")
          .fontSize(12)
          .color("#9ca3af")
      }
      .marginBottom(8)

      Text("Discuss Q4 roadmap and priorities...")
        .fontSize(14)
        .color("#6b7280")
    }
    .padding(16)
    .backgroundColor("#fef3c7")
    .borderRadius(12)

    Column {
      Row {
        Text("Shopping List")
          .fontSize(16)
          .fontWeight("600")
          .color("#1a1a1a")
        Spacer()
        Text("Yesterday")
          .fontSize(12)
          .color("#9ca3af")
      }
      .marginBottom(8)

      Text("Milk, eggs, bread, butter...")
        .fontSize(14)
        .color("#6b7280")
    }
    .padding(16)
    .backgroundColor("#dbeafe")
    .borderRadius(12)

    Column {
      Row {
        Text("Ideas")
          .fontSize(16)
          .fontWeight("600")
          .color("#1a1a1a")
        Spacer()
        Text("Dec 15")
          .fontSize(12)
          .color("#9ca3af")
      }
      .marginBottom(8)

      Text("New app concept for productivity...")
        .fontSize(14)
        .color("#6b7280")
    }
    .padding(16)
    .backgroundColor("#f3e8ff")
    .borderRadius(12)

    Column {
      Row {
        Text("Book Notes")
          .fontSize(16)
          .fontWeight("600")
          .color("#1a1a1a")
        Spacer()
        Text("Dec 10")
          .fontSize(12)
          .color("#9ca3af")
      }
      .marginBottom(8)

      Text("Key takeaways from Atomic Habits...")
        .fontSize(14)
        .color("#6b7280")
    }
    .padding(16)
    .backgroundColor("#dcfce7")
    .borderRadius(12)
  }
  .gap(12)
  .paddingLeft(24)
  .paddingRight(24)
}
.fillMaxSize()
.backgroundColor("#ffffff")
`;
