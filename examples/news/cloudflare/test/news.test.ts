// Unit tests for the pure parts of the News example, against recorded
// upstream responses (test/fixtures, captured 2026-11-12 from the Wikimedia
// REST feed and the HN Firebase API; trimmed). Run: `bun test`.

import { describe, expect, test } from "bun:test";
import featured from "./fixtures/featured-2026-11-12.json";
import story from "./fixtures/story-50467087.json";
import comments from "./fixtures/comments-50467087.json";
import { decodeEntities, htmlToRichText, htmlToText, safeHref } from "../src/html";
import { CommentTree } from "../src/comments";
import { toFeaturedDigest, toStoryLite, type HnItem } from "../src/upstream";
import { toRows } from "../src/stories";
import { mapLimit } from "../src/format";

describe("html → safe text", () => {
  test("paragraphs, entities and links (HN comment shape)", () => {
    const r = htmlToRichText(
      'First &amp; foremost &#x27;quoted&#x27;<p>See <a href="https:&#x2F;&#x2F;example.com&#x2F;a?b=1" rel="nofollow">https:&#x2F;&#x2F;example.com&#x2F;a?b=1</a> now',
    );
    expect(r.text).toBe("First & foremost 'quoted'\n\nSee https://example.com/a?b=1 now");
    expect(r.links).toEqual([{ id: "l0", href: "https://example.com/a?b=1", label: "example.com/a?b=1" }]);
  });

  test("markup never survives, and decoded entities are not re-parsed", () => {
    const r = htmlToRichText('<script>alert(1)</script>x &lt;img src=x onerror=alert(1)&gt; <b onclick="y">bold</b>');
    expect(r.text).toBe("x <img src=x onerror=alert(1)> bold");
    expect(r.text).not.toContain("alert(1)</");
  });

  test("only absolute http(s) links become chips", () => {
    const r = htmlToRichText('<a href="javascript:alert(1)">a</a> <a href="./Rel">b</a> <a href="data:text/html,x">c</a>');
    expect(r.links).toEqual([]);
    expect(safeHref("https://ok.example/")).toBe("https://ok.example/");
    expect(safeHref("javascript:alert(1)")).toBeNull();
  });

  test("<pre> keeps its lines", () => {
    const r = htmlToRichText("Code:<p><pre><code>  a\n  b\n</code></pre>");
    expect(r.text).toContain("  a\n  b");
  });

  test("numeric entities and controls", () => {
    expect(decodeEntities("&#8212;&#x1F600;&#0;&#7;")).toBe("—😀");
    expect(htmlToText("<i>The End</i> (novel)")).toBe("The End (novel)");
  });
});

describe("Wikipedia featured feed", () => {
  const d = toFeaturedDigest(featured, "2026-11-12");

  test("picture of the day", () => {
    expect(d.potd?.caption).toBe("50 Korun banknote of Czechoslovakia, issued in 1929 by the National Bank of Czechoslovakia");
    expect(d.potd?.thumb).not.toContain("utm_");
    expect(d.potd?.page).toStartWith("https://commons.wikimedia.org/");
  });

  test("in the news: plain text + the bold article as tap target", () => {
    expect(d.news[0]!.text).toBe("In literature, The End of Everything by M. John Harrison wins the Booker Prize.");
    expect(d.news[0]!.title).toBe("The_End_of_Everything_(Harrison_novel)");
  });

  test("most read: ranked articles with views", () => {
    expect(d.mostRead.map((a) => a.title)).toEqual(["Ramayana:_Part_1", "Stacy_Keach", "Jensen_Huang", "David_Walliams"]);
    expect(d.mostRead[0]!.meta).toMatch(/K views$/);
    expect(d.mostRead[0]!.rank).toBe(1);
  });

  test("on this day: newest first", () => {
    const years = d.onThisDay.map((e) => e.year);
    expect(years).toEqual([...years].sort((a, b) => b - a));
    expect(d.onThisDay[0]!.text).toContain("Philae");
  });
});

describe("story rows + live deltas", () => {
  const base = toStoryLite(story as HnItem);

  test("StoryLite from a recorded item", () => {
    expect(base.domain).toBe("nvidianews.nvidia.com");
    expect(base.id).toBe(50467087);
  });

  test("re-ranks, new entrants and score bumps", () => {
    const a = { ...base, id: 1, score: 10 };
    const b = { ...base, id: 2, score: 20 };
    const c = { ...base, id: 3, score: 5 };
    const first = toRows([a, b], null);
    expect(first.map((r) => r.delta)).toEqual(["", ""]);
    const second = toRows([{ ...b, score: 25 }, a, c], null, first);
    expect(second.map((r) => [r.id, r.delta])).toEqual([["2", "▲1"], ["1", "▼1"], ["3", "NEW"]]);
    expect(second[0]!.bumped).toBe(true);
    expect(second[1]!.bumped).toBe(false);
  });
});

describe("comment tree", () => {
  const items = comments as HnItem[];
  const s = story as HnItem;

  test("loads top level, expands lazily, flattens with depth", () => {
    const tree = new CommentTree(s.id, s.by ?? "", s.kids);
    const page = tree.nextTopPage();
    expect(page).toEqual([50467199, 50467672, 50469788]);
    tree.showTop(items.filter((i) => page.includes(i.id)), page.length);
    let rows = tree.flatten();
    expect(rows.map((r) => r.depth)).toEqual([0, 0, 0]);
    expect(rows[0]!.toggleLabel).toBe("1 reply");

    const kids = tree.needsFetch(50467199)!;
    expect(kids).toEqual([50467349]);
    tree.attach(50467199, items.filter((i) => kids.includes(i.id)));
    rows = tree.flatten();
    expect(rows.map((r) => [r.id, r.depth])).toEqual([
      ["50467199", 0],
      ["50467349", 1],
      ["50467672", 0],
      ["50469788", 0],
    ]);
    expect(rows[1]!.indent).toBe(12);
    expect(rows[0]!.toggleLabel).toBe("Hide replies");

    // Collapse hides the body and the replies, and reports what it hides.
    tree.toggleCollapse(50467199);
    rows = tree.flatten();
    expect(rows.map((r) => r.id)).toEqual(["50467199", "50467672", "50469788"]);
    expect(rows[0]!.showBody).toBe(false);
    expect(rows[0]!.collapseLabel).toMatch(/^\[\+\d+\]$/);
  });

  test("comment HTML is converted for the renderer", () => {
    const tree = new CommentTree(s.id, s.by ?? "", s.kids);
    tree.showTop(items, 3);
    for (const row of tree.flatten()) {
      expect(row.text).not.toMatch(/<[a-z]/i);
      expect(row.text).not.toMatch(/&#x?[0-9a-f]+;/i);
    }
  });
});

test("mapLimit keeps order and bounds concurrency", async () => {
  let live = 0;
  let peak = 0;
  const out = await mapLimit([5, 1, 4, 2, 3], 2, async (n) => {
    live++;
    peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, n));
    live--;
    return n * 10;
  });
  expect(out).toEqual([50, 10, 40, 20, 30]);
  expect(peak).toBe(2);
});
