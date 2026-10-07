/**
 * Playground Samples
 */

export interface Sample {
  name: string;
  hypen: string;
  logic: string;
}

export const samples: Record<string, Sample> = {
  counter: {
    name: "Counter",
    hypen: `Column {
  Text("Count: @{state.count}")
    .fontSize(24)
    .fontWeight("bold")
    .margin(16)

  Row {
    Button {
      Text("-")
        .fontSize(20)
        .padding(8)
    }
      .onClick("@actions.decrement")
      .margin(4)

    Button {
      Text("Reset")
        .padding(8)
    }
      .onClick("@actions.reset")
      .margin(4)

    Button {
      Text("+")
        .fontSize(20)
        .padding(8)
    }
      .onClick("@actions.increment")
      .margin(4)
  }
}
  .padding(24)
  .backgroundColor("#f5f5f5")
  .width("100%")
  .height("100%")`,
    logic: `import { app } from "@hypen-space/core";

type CounterState = {
  count: number;
};

export default app
  .defineState<CounterState>({ count: 0 })
  .onCreated(async (state) => {
    console.log("Counter initialized");
  })
  .onAction("increment", async ({ state }) => {
    state.count++;
    console.log("Count incremented:", state.count);
  })
  .onAction("decrement", async ({ state }) => {
    state.count--;
    console.log("Count decremented:", state.count);
  })
  .onAction("reset", async ({ state }) => {
    state.count = 0;
    console.log("Count reset:", state.count);
  })
  .build();`,
  },

  profile: {
    name: "Profile Page",
    hypen: `Column {
  Text("Welcome, @{state.user?.name ?? 'Guest'}")
    .fontSize(28)
    .fontWeight("bold")
    .margin(16)

  Text("@{state.user ? 'Premium User' : 'Sign in to continue'}")
    .fontSize(14)
    .color("#666")
    .margin(8)

  Button {
    Text("Sign in with Google")
      .padding(12)
      .color("white")
  }
    .onClick("@actions.signInWithGoogle")
    .backgroundColor("#4285f4")
    .borderRadius(4)
    .margin(16)
}
  .padding(24)
  .backgroundColor("#ffffff")`,
    logic: `import { app } from "@hypen-space/core";

type User = {
  id: string;
  name: string;
  premium: boolean;
};

type ProfileState = {
  user: User | null;
};

export default app
  .defineState<ProfileState>({ user: null })
  .onCreated(async (state) => {
    console.log("ProfilePage created");
  })
  .onAction("signInWithGoogle", async ({ state }) => {
    // Simulate Google sign-in
    state.user = {
      id: "1",
      name: "Ada Lovelace",
      premium: true,
    };
  })
  .build();`,
  },

  todo: {
    name: "Todo List",
    hypen: `Column {
  Text("My Tasks")
    .fontSize(24)
    .fontWeight("bold")
    .margin(16)

  Row {
    Input("@state.newTask")
      .placeholder("Add a new task... (press Enter)")
      .width("300px")
      .padding(8)
      .margin(4)
      .onInput("@actions.updateNewTask")
      .onKey("@actions.addTask")

    Button {
      Text("Add")
        .padding(8)
    }
      .onClick("@actions.addTask")
      .backgroundColor("#4caf50")
      .color("white")
      .margin(4)
  }

  Column {
    Text("@{state.tasks.length} tasks")
      .fontSize(12)
      .color("#999")
      .margin(8)
    
    List(@state.tasks) {
      Text("• @{item.text}")
        .margin(4)
        .fontSize(14)
    }
  }
}
  .padding(24)
  .backgroundColor("#fafafa")`,
    logic: `import { app } from "@hypen-space/core";

type TodoState = {
  tasks: Array<{ id: string; text: string; done: boolean }>;
  newTask: string;
};

export default app
  .defineState<TodoState>({
    tasks: [],
    newTask: "",
  })
  .onCreated(async (state) => {
    state.tasks = [
      { id: "1", text: "Learn Hypen", done: false },
      { id: "2", text: "Build an app", done: false },
    ];
  })
  .onAction("updateNewTask", async ({ action, state }) => {
    // Update newTask from input event
    state.newTask = action.payload?.input || action.payload?.value || "";
    console.log("New task input:", state.newTask);
  })
  .onAction("addTask", async ({ state }) => {
    if (state.newTask.trim()) {
      state.tasks.push({
        id: Date.now().toString(),
        text: state.newTask,
        done: false,
      });
      state.newTask = "";
      console.log("Task added! Total tasks:", state.tasks.length);
    }
  })
  .build();`,
  },

  charts: {
    name: "Charts",
    hypen: `Column {
  Heading("Sales dashboard")
    .fontSize(20)
  Text("Tap a bar to select it · move over the line for a tooltip")
    .fontSize(13)
    .color("#64748b")

  Chart(y: [0, 100]) {
    Axis(x)
    Axis(y, ticks: 4, grid: true)
    Bars(data: @state.months, x: "month", y: "units", highlight: @state.selected, radius: 3)
      .fill("#3b82f6")
      .onClick(@actions.selectMonth)
    Rule(y: 75)
      .stroke("#f59e0b")
    Marker(x: "Jun", y: 75, anchor: "top") {
      Badge("target")
    }
  }
    .height(220)
    .color("#64748b")

  Text("@{state.selectedLabel}")
    .fontSize(14)
    .fontWeight("bold")
    .marginTop(4)

  Chart {
    Axis(x, label: "Week")
    Axis(y, ticks: 3)
    Area(points: @state.revenue)
      .fill("#10b981")
    Line(points: @state.revenue, smooth: true)
      .stroke("#10b981")
      .strokeWidth(3)
      .glow("#10b981")
      .transition("d 300ms ease-out")
      .onMove(@actions.hoverPoint)
      .onMouseLeave(@actions.clearHover)
    Points(points: @state.hoverPoints, radius: 5)
      .fill("#10b981")
    Marker(x: @state.hover.x, y: @state.hover.y) {
      Card {
        Text("@{state.hover.label}")
          .fontSize(12)
      }
        .padding(6)
    }
  }
    .height(200)
    .color("#64748b")
    .marginTop(12)

  Row {
    Button {
      Text("Add a week")
        .padding(8)
    }
      .onClick(@actions.addWeek)
    Chart {
      Line(points: @state.revenue)
        .stroke("#8b5cf6")
    }
      .width(120)
      .height(32)
    Text("@{state.trend}")
      .fontSize(13)
      .color("#64748b")
  }
    .gap(12)
    .alignItems("center")
    .marginTop(12)
}
  .padding(24)
  .gap(8)
  .backgroundColor("#f8fafc")
  .width("100%")
  .height("100%")`,
    logic: `import { app } from "@hypen-space/core";

type Month = { month: string; units: number };

type ChartsState = {
  months: Month[];
  revenue: number[];
  selected: number | null;
  selectedLabel: string;
  hover: { x: number; y: number; label: string } | null;
  hoverPoints: number[][];
  trend: string;
};

const months: Month[] = [
  { month: "Jan", units: 42 }, { month: "Feb", units: 58 }, { month: "Mar", units: 31 },
  { month: "Apr", units: 77 }, { month: "May", units: 64 }, { month: "Jun", units: 89 },
];

export default app
  .defineState<ChartsState>({
    months,
    revenue: [12, 18, 15, 24, 22, 31, 28],
    selected: null,
    selectedLabel: "Nothing selected yet",
    hover: null,
    hoverPoints: [],
    trend: "7 weeks",
  })
  .onAction<{ index: number; x: string; y: number }>("selectMonth", async ({ state, action }) => {
    const { index, x, y } = action.payload!;
    state.selected = index;
    state.selectedLabel = x + ": " + y + " units";
  })
  .onAction<{ x: number; y: number }>("hoverPoint", async ({ state, action }) => {
    const { x, y } = action.payload!;
    state.hover = { x, y, label: "Week " + (x + 1) + ": $" + y + "k" };
    state.hoverPoints = [[x, y]];
  })
  .onAction("clearHover", async ({ state }) => {
    state.hover = null;
    state.hoverPoints = [];
  })
  .onAction("addWeek", async ({ state }) => {
    const last = state.revenue[state.revenue.length - 1] ?? 20;
    state.revenue = [...state.revenue, Math.max(5, Math.round(last + (Math.random() - 0.4) * 12))];
    state.trend = state.revenue.length + " weeks";
  })
  .build();`,
  },
  form: {
    name: "Form Example",
    hypen: `Column {
  Text("Contact Form")
    .fontSize(24)
    .fontWeight("bold")
    .margin(16)

  Column {
    Text("Name")
      .fontSize(14)
      .margin(4)

    Input("@state.name")
      .placeholder("Enter your name")
      .width("100%")
      .padding(8)
      .margin(4)

    Text("Email")
      .fontSize(14)
      .margin(4)

    Input("@state.email")
      .placeholder("Enter your email")
      .type("email")
      .width("100%")
      .padding(8)
      .margin(4)

    Button {
      Text("Submit")
        .padding(12)
        .color("white")
    }
      .onClick("@actions.submit")
      .backgroundColor("#2196f3")
      .borderRadius(4)
      .margin(16)
  }
    .width("400px")
}
  .padding(24)`,
    logic: `import { app } from "@hypen-space/core";

type FormState = {
  name: string;
  email: string;
  submitted: boolean;
};

export default app
  .defineState<FormState>({
    name: "",
    email: "",
    submitted: false,
  })
  .onAction("submit", async ({ state }) => {
    console.log("Submitting form:", {
      name: state.name,
      email: state.email,
    });

    state.submitted = true;

    // Reset after 2 seconds
    setTimeout(() => {
      state.submitted = false;
    }, 2000);
  })
  .build();`,
  },
};
