/**
 * Canvas Social Example
 *
 * A mini Instagram-style social feed rendered entirely to canvas via the
 * Canvas component routing feature. Uses the regular DOMRenderer — the
 * Canvas wrapper in the DSL causes all descendants to be routed to a
 * CanvasRenderer instance automatically.
 *
 * Demonstrates:
 * - Canvas component with automatic subtree routing
 * - Stateful module (posts, likes, comments)
 * - Actions with canvas-rendered buttons
 * - Text, Column, Row, Image-like tiles in canvas
 * - Scroll support for the feed (via overflow: "scroll")
 * - Text selection for post captions
 */

import { Engine } from "../packages/web-engine/src/engine.js";
import { app } from "../packages/core/src/app.js";
import { HypenModuleInstance } from "../packages/core/src/app.js";
import { createHypenClient } from "../packages/web/src/dom/index.js";

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

type Post = {
  id: number;
  user: string;
  caption: string;
  likes: number;
  liked: boolean;
};

type SocialState = {
  posts: Post[];
  activePostId: number;
  feedTitle: string;
};

const initialPosts: Post[] = [
  { id: 1, user: "ada", caption: "First post on canvas!", likes: 12, liked: false },
  { id: 2, user: "grace", caption: "Rendering text with pretext feels great.", likes: 34, liked: true },
  { id: 3, user: "linus", caption: "Taffy layout is fast.", likes: 8, liked: false },
  { id: 4, user: "donald", caption: "Reactive state + canvas = 🎨", likes: 56, liked: false },
  { id: 5, user: "margaret", caption: "Scroll this feed to see virtualization.", likes: 19, liked: true },
  { id: 6, user: "barbara", caption: "Selection works on captions too — try it.", likes: 41, liked: false },
  { id: 7, user: "edsger", caption: "Goto considered canvas-worthy.", likes: 27, liked: false },
  { id: 8, user: "alan", caption: "Turing complete, canvas rendered.", likes: 99, liked: true },
];

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

const socialModule = app
  .defineState<SocialState>({
    posts: initialPosts,
    activePostId: 0,
    feedTitle: "Canvas Feed",
  })
  .onCreated(async () => {
    console.log("Canvas social feed initialised");
  })
  .onAction("toggleLike", async ({ state, action }) => {
    const id = Number(action.payload?.postId ?? 0);
    const post = state.posts.find((p) => p.id === id);
    if (!post) return;
    post.liked = !post.liked;
    post.likes += post.liked ? 1 : -1;
  })
  .onAction("openPost", async ({ state, action }) => {
    state.activePostId = Number(action.payload?.postId ?? 0);
  })
  .onAction("closePost", async ({ state }) => {
    state.activePostId = 0;
  })
  .build();

// ---------------------------------------------------------------------------
// Hypen DSL
//
// Everything is wrapped in Canvas { ... } so the DOMRenderer will:
// 1. Create a <canvas> element in the DOM
// 2. Spin up a CanvasRenderer bound to that canvas
// 3. Route all child patches (Column, Text, Button, ForEach, etc.)
//    to the CanvasRenderer instead of creating DOM elements
// ---------------------------------------------------------------------------

const ui = `
Canvas(width: 480, height: 800) {
  Column {
    // Header bar
    Row {
      Text("@{state.feedTitle}")
        .fontSize(22)
        .fontWeight("bold")
        .color("#262626")
        .flexGrow(1)

      Text("✦")
        .fontSize(20)
        .color("#ed4956")
    }
      .padding(16)
      .backgroundColor("#ffffff")
      .borderWidth(1)
      .borderColor("#dbdbdb")

    // Scrollable feed
    Column {
      ForEach(state.posts, item: post) {
        Column {
          // Post header
          Row {
            // Avatar placeholder (circle)
            Column {}
              .width(36)
              .height(36)
              .backgroundColor("#f0b4d8")
              .borderRadius(18)
              .marginRight(10)

            Text("@{post.user}")
              .fontSize(14)
              .fontWeight("bold")
              .color("#262626")
              .flexGrow(1)

            Text("⋯")
              .fontSize(18)
              .color("#262626")
          }
            .padding(12)

          // Image placeholder (colored block)
          Column {}
            .width(480)
            .height(320)
            .backgroundColor("#fafafa")
            .borderWidth(1)
            .borderColor("#efefef")

          // Action bar
          Row {
            Button {
              Text("@{post.liked ? '♥' : '♡'}")
                .fontSize(24)
                .color("@{post.liked ? '#ed4956' : '#262626'}")
            }
              .backgroundColor("transparent")
              .padding(8)
              .action("@actions.toggleLike")

            Text("💬")
              .fontSize(22)
              .padding(8)

            Text("➤")
              .fontSize(22)
              .padding(8)
              .flexGrow(1)

            Text("🔖")
              .fontSize(22)
              .padding(8)
          }
            .padding(4)

          // Likes count
          Text("@{post.likes} likes")
            .fontSize(14)
            .fontWeight("bold")
            .color("#262626")
            .paddingLeft(12)
            .paddingRight(12)

          // Caption (selectable text)
          Row {
            Text("@{post.user}")
              .fontSize(14)
              .fontWeight("bold")
              .color("#262626")
              .marginRight(6)

            Text("@{post.caption}")
              .fontSize(14)
              .color("#262626")
              .flexGrow(1)
          }
            .padding(12)

          // Divider
          Column {}
            .height(1)
            .backgroundColor("#efefef")
            .marginTop(4)
            .marginBottom(4)
        }
          .backgroundColor("#ffffff")
          .marginBottom(8)
      }
    }
      .flexGrow(1)
      .overflow("scroll")
      .backgroundColor("#fafafa")
  }
    .flexGrow(1)
    .backgroundColor("#fafafa")
}
`;

// ---------------------------------------------------------------------------
// Page setup
// ---------------------------------------------------------------------------

async function main() {
  console.log("Starting canvas social example...");

  // Page chrome
  const header = document.createElement("div");
  header.style.cssText = "text-align: center; padding: 16px; font-family: system-ui, sans-serif;";
  header.innerHTML = `
    <h1 style="margin: 0 0 4px; color: #262626;">Canvas Social</h1>
    <p style="margin: 0; color: #8e8e8e; font-size: 14px;">
      Instagram-style feed rendered entirely to &lt;canvas&gt; via the Canvas component.
      Scroll, tap hearts, select captions.
    </p>
  `;
  document.body.appendChild(header);

  // Mount point — DOMRenderer will create the <canvas> element here
  const container = document.createElement("div");
  container.style.cssText = "max-width: 480px; margin: 0 auto; border: 1px solid #dbdbdb;";
  document.body.appendChild(container);

  // Initialize engine
  const engine = new Engine();
  await engine.init();
  console.log("Engine initialized");

  // Create DOM renderer — it will see the Canvas component in the DSL
  // and auto-route all descendants to a CanvasRenderer.
  createHypenClient(container, engine);

  // Create module instance
  new HypenModuleInstance(engine, socialModule);

  // Render UI
  await engine.renderSource(ui);
  console.log("Social feed rendered to canvas");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main);
} else {
  main();
}
