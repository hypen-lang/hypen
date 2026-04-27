/**
 * Child Slots Example - demonstrates custom component with child slots
 * 
 * Shows how to create a custom Card component that accepts children
 * and renders them in specific locations using Children() placeholders.
 */

import { Engine, app, HypenModuleInstance } from "../packages/core/src/index.js";

type CardExampleState = {
  title: string;
  highlighted: boolean;
};

const cardModule = app
  .defineState<CardExampleState>({
    title: "Welcome Card",
    highlighted: false,
  })
  .onCreated(async (state) => {
    console.log("Card module created");
  })
  .onAction("toggleHighlight", async ({ state }) => {
    state.highlighted = !state.highlighted;
    console.log("Toggled highlight:", state.highlighted);
  })
  .build();

/**
 * Example 1: Simple Card with default children slot
 * 
 * Card {
 *   Text("This is the content")
 *   Button("Click me")
 * }
 */
const simpleCardExample = `
  module CardExample() {
    Column {
      Card {
        Text("Card Title")
        Text("Card content goes here")
        Button { Text("Toggle") }.onClick(@actions.toggleHighlight)
      }
    }
  }
`;

/**
 * Example 2: Card with named slots (header, body, footer)
 * Using .slot() applicator syntax
 * 
 * Card {
 *   Text("Header content").slot("header")
 *   Text("Body content").slot("body")
 *   Button("Footer action").slot("footer")
 * }
 */
const namedSlotsExample = `
  module AdvancedCard() {
    Column {
      CardWithSlots {
        Column {
          Text("@{state.title}")
        }.slot("header")
        Column {
          Text("This is the main content area")
          Text("You can add multiple elements here")
        }.slot("body")
        Row {
          Button { 
            Text("Highlight") 
          }.onClick(@actions.toggleHighlight)
        }.slot("footer")
      }
    }
  }
`;

// Card template: uses Children() as a default slot placeholder
const cardTemplate = `
  Column {
    Column {
      Text("Card")
        .fontWeight("bold")
    }
    .padding(16)
    .backgroundColor("#f0f0f0")

    Column {
      Children()
    }
    .padding(16)
  }
`;

// CardWithSlots template: uses Children().slot("name") for named slots
const cardWithSlotsTemplate = `
  Column {
    Column {
      Children().slot("header")
    }
    .padding(16)
    .backgroundColor("#2196F3")
    .color("white")

    Column {
      Children().slot("body")
    }
    .padding(24)

    Column {
      Children().slot("footer")
    }
    .padding(16)
    .backgroundColor("#f5f5f5")
    .borderTop("1px solid #ddd")
  }
`;

async function main() {
  const engine = new Engine();
  await engine.init();

  // Register component templates via the component resolver
  engine.setComponentResolver((componentName: string) => {
    if (componentName === "Card") {
      return { source: cardTemplate };
    }
    if (componentName === "CardWithSlots") {
      return { source: cardWithSlotsTemplate };
    }
    return null;
  });

  // Set render callback
  engine.setRenderCallback((patches) => {
    console.log("Patches:", JSON.stringify(patches, null, 2));
  });

  // Create module instance
  const moduleInstance = new HypenModuleInstance(engine, cardModule);

  console.log("\n=== Example 1: Simple Card ===");
  engine.renderSource(simpleCardExample);

  // Wait a bit then switch to named slots example
  setTimeout(() => {
    console.log("\n=== Example 2: Named Slots Card ===");
    engine.renderSource(namedSlotsExample);
  }, 3000);

  // Test action
  setTimeout(() => {
    console.log("\n=== Testing action ===");
    engine.dispatchAction("toggleHighlight");
  }, 5000);

  // Cleanup
  process.on("SIGINT", async () => {
    await moduleInstance.destroy();
    process.exit(0);
  });
}

// Run if this is the main module
if (import.meta.main) {
  main().catch(console.error);
}

export { cardModule, simpleCardExample, namedSlotsExample };

