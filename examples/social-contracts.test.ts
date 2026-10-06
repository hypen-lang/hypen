import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

const root = import.meta.dir;

async function source(relativePath: string): Promise<string> {
  return Bun.file(`${root}/${relativePath}`).text();
}

describe("Social app contracts", () => {
  test("stories align Your story with the carousel and keep its blue plus badge", async () => {
    const stories = await source("social/cloudflare/src/components/Stories.hypen");
    const storyItem = await source("social/cloudflare/src/components/StoryItem.hypen");

    expect(stories).toContain('.tw("w-14 h-14 rounded-full")');
    // The badge is overlaid with a Stack aligned end/end — Hypen has no CSS
    // positioning, so `absolute`/`relative` must never appear.
    expect(stories).toContain('.tw("p-0.5 rounded-full")');
    expect(stories).toContain('.horizontalAlignment("end")');
    expect(stories).toContain('.verticalAlignment("end")');
    expect(stories).toContain('.borderColor("#0095f6")');
    expect(stories).toContain("@resources.plus");
    expect(stories).not.toMatch(/\b(absolute|relative)\b/);
    expect(storyItem).toContain('.tw("w-14 h-14 rounded-full")');
    expect(storyItem).toContain('.tw("p-0.5 rounded-full")');
  });

  test("the feed grows to three columns while every image stays inset and square", async () => {
    const home = await source("social/cloudflare/src/components/HomePage.hypen");
    const post = await source("social/cloudflare/src/components/Post.hypen");

    expect(home).toContain('Grid(@state.posts, key: "id")');
    expect(home).toContain(".gridColumns({default: 1, md: 2, xl: 3})");
    expect(post).toContain('.aspectRatio("1")');
    expect(post).toContain(".borderRadius(24)");
    expect(post).toContain('.tw("px-5")');
  });

  test("navigation has no create tab and inbox rows open a real conversation", async () => {
    const bottomNav = await source("social/cloudflare/src/components/BottomNav.hypen");
    const app = await source("social/cloudflare/src/components/App.hypen");
    const messages = await source("social/cloudflare/src/components/Messages.hypen");
    const conversation = await source("social/cloudflare/src/components/Conversation.hypen");
    const worker = await source("social/cloudflare/src/worker.ts");

    expect(bottomNav).not.toContain("plus-square");
    expect(app).toContain('Route(path: "/dm/:id")');
    expect(messages).toContain('.onClick(@router.push, to: "/dm/@{item.id}")');
    expect(conversation).toContain("List(@state.chatMessages");
    expect(conversation).toContain(".bind(@state.draft)");
    expect(worker).toContain("conversationModule");
  });

  test("messages use bounded avatars, rounded hover targets, and safe content", async () => {
    const app = await source("social/cloudflare/src/components/App.hypen");
    const messages = await source("social/cloudflare/src/components/Messages.hypen");
    const conversation = await source("social/cloudflare/src/components/Conversation.hypen");

    expect(app).toContain("SafeArea {");
    expect(messages).toContain(".width(48)");
    expect(messages).toContain(".height(48)");
    expect(messages).toContain("rounded-2xl overflow-hidden hover:bg-gray-100");
    expect(messages).toContain("rounded-xl items-center justify-center hover:bg-gray-100");
    expect(conversation).toContain("rounded-xl items-center justify-center hover:bg-gray-100");
  });

  test("follow relationships and canned replies are persisted by the module", async () => {
    const module = await source("social/cloudflare/src/module.ts");

    expect(module).toContain("SELECT 1 AS present FROM follows");
    expect(module).toContain("UPDATE users SET followers_count");
    expect(module).toContain("UPDATE users SET following_count");
    expect(module).toContain("const cannedReplies = [");
    expect(module).toContain("Math.random() * cannedReplies.length");
    expect(module).toContain("state.peer.id, reply");
  });

  test("the idempotent seed enriches existing databases", async () => {
    const schema = await source("social/cloudflare/src/schema.sql");
    const seed = await source("social/cloudflare/src/seed.sql");
    const db = new Database(":memory:");

    db.exec(schema);
    db.exec(seed);
    db.exec(seed);

    const count = (table: string) =>
      (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

    expect(count("users")).toBe(30);
    expect(count("posts")).toBe(55);
    expect(count("stories")).toBe(29);
    expect(count("conversations")).toBe(6);
    expect(count("messages")).toBe(16);
  });
});
