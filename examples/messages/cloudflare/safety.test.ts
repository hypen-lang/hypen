import { describe, expect, test } from "bun:test";
import { isPublicUrl, parseOpenGraph } from "./src/links";
import { cleanMessage, cleanName, cleanRoomName, firstUrl, safeHttpUrl, sniffImage } from "./src/text";

describe("link preview SSRF guard", () => {
  test.each([
    "http://localhost/",
    "http://127.0.0.1/",
    "http://10.0.0.5/",
    "http://172.20.1.1/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data",
    "http://100.64.0.1/",
    "http://0.0.0.0/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[fd00::1]/",
    "http://2130706433/",
    "http://0x7f.0.0.1/",
    "http://printer.local/",
    "http://db.internal/",
    "http://intranet/",
    "http://example.com:8080/",
    "http://user:pw@example.com/",
    "ftp://example.com/",
  ])("blocks %s", (url) => expect(isPublicUrl(url)).toBe(false));

  test.each(["https://example.com/", "http://news.ycombinator.com/item?id=1", "https://8.8.8.8/"])(
    "allows %s",
    (url) => expect(isPublicUrl(url)).toBe(true),
  );
});

describe("OpenGraph parsing", () => {
  test("reads og tags, decodes entities, refuses non-https images", () => {
    const og = parseOpenGraph(
      `<head><meta property="og:title" content="Tom &amp; Jerry"><meta name="description" content="A&#39;b">
       <meta property="og:image" content="http://cdn.example.com/x.png"></head>`,
      "https://example.com/page",
    );
    expect(og).toEqual({ site: "example.com", title: "Tom & Jerry", description: "A'b", image: "" });
  });

  test("resolves a relative https image against the page", () => {
    const og = parseOpenGraph(`<title>T</title><meta property="og:image" content="/i.png">`, "https://example.com/a/b");
    expect(og?.image).toBe("https://example.com/i.png");
  });
});

describe("text hygiene", () => {
  test("messages are trimmed, stripped of bidi/control chars and capped", () => {
    expect(cleanMessage("  hi‮there\u0007 ")).toBe("hithere");
    expect(cleanMessage("a\n\n\n\nb")).toBe("a\n\nb");
    expect(cleanMessage("   ")).toBeNull();
    expect([...cleanMessage("x".repeat(5000))!].length).toBe(1000);
  });

  test("names and room slugs", () => {
    expect(cleanName("  Ada   Lovelace ")).toBe("Ada Lovelace");
    expect(cleanName("")).toBeNull();
    expect(cleanRoomName("#Load Test!!")).toBe("load-test");
    expect(cleanRoomName("!")).toBeNull();
  });

  test("only http(s) URLs reach Link/Image", () => {
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("data:text/html,x")).toBeNull();
    expect(firstUrl("see https://example.com/x).")).toBe("https://example.com/x");
  });

  test("image sniffing never accepts SVG", () => {
    expect(sniffImage(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
  });
});
