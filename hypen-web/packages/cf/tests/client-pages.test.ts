import { describe, it, expect } from "bun:test";
import { buildClientPages, servePage } from "../src/client-pages.js";

/**
 * buildClientPages turns built client bundles + chosen paths into the HTML
 * shells + bundle routes defineHypenWorker serves. servePage matches a GET
 * request against them. These cover custom paths, the DOM/Canvas shell choice,
 * the bundle-URL convention, and the GET/cache behaviour.
 */

describe("buildClientPages", () => {
  it("serves a DOM shell at the given path + its bundle at <path>/client.js", () => {
    const pages = buildClientPages({ routes: { "/": { js: "DOMJS" } }, title: "T" });
    expect(pages["/"]!.contentType).toContain("text/html");
    expect(pages["/"]!.body).toContain("data-hypen-renderer=\"dom\"");
    expect(pages["/"]!.body).toContain("<title>T</title>");
    expect(pages["/"]!.body).toContain('src="/client.js"');
    expect(pages["/"]!.body).not.toContain("id=\"status\"");
    expect(pages["/"]!.body).toContain("#app, #app * { font-family: inherit; }");
    expect(pages["/client.js"]!.body).toBe("DOMJS");
    expect(pages["/client.js"]!.contentType).toContain("javascript");
  });

  it("uses the Canvas shell for a canvas bundle, and a nested bundle URL", () => {
    const pages = buildClientPages({
      routes: { "/canvas": { js: "CJS", renderer: "canvas" } },
    });
    expect(pages["/canvas"]!.body).toContain('data-hypen-renderer="canvas"');
    expect(pages["/canvas"]!.body).toContain("<canvas id=\"app\">");
    expect(pages["/canvas"]!.body).toContain('src="/canvas/client.js"');
    expect(pages["/canvas"]!.body).not.toContain("id=\"status\"");
    expect(pages["/canvas/client.js"]!.body).toBe("CJS");
  });

  it("honours fully custom paths", () => {
    const pages = buildClientPages({
      routes: {
        "/app": { js: "D" },
        "/app/canvas": { js: "C", renderer: "canvas" },
      },
    });
    expect(Object.keys(pages).sort()).toEqual(
      ["/app", "/app/client.js", "/app/canvas", "/app/canvas/client.js"].sort(),
    );
  });
});

describe("servePage", () => {
  const pages = buildClientPages({ routes: { "/": { js: "JS" } } });

  it("serves a matching GET with cache headers (no-cache HTML, cached JS)", () => {
    const html = servePage(pages, new Request("http://x/"))!;
    expect(html.headers.get("cache-control")).toBe("no-cache");
    const js = servePage(pages, new Request("http://x/client.js"))!;
    expect(js.headers.get("cache-control")).toContain("max-age");
  });

  it("serves the root shell for unmatched document navigations", async () => {
    const html = servePage(
      pages,
      new Request("http://x/search", { headers: { accept: "text/html" } }),
    )!;

    expect(html.status).toBe(200);
    expect(html.headers.get("content-type")).toContain("text/html");
    expect(await html.text()).toContain('src="/client.js"');
  });

  it("returns null for unmatched non-document paths or a non-GET", () => {
    expect(
      servePage(
        pages,
        new Request("http://x/favicon.ico", { headers: { accept: "image/avif,image/webp,*/*" } }),
      ),
    ).toBeNull();
    expect(servePage(pages, new Request("http://x/", { method: "POST" }))).toBeNull();
  });
});
