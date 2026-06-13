/**
 * Browser-client page serving for `defineHypenWorker`.
 *
 * Given one or more pre-built client bundles (JS strings) and the paths to
 * serve them at, this builds the HTML shells + bundle routes and a request
 * matcher. `defineHypenWorker` uses it so an app's worker never hand-writes the
 * `GET / → page, upgrade → ws` plumbing.
 */

/** A built browser-client bundle + the renderer it drives. */
export interface ClientBundle {
  /** The bundled JS (a string — embedded via wrangler's Text rule). */
  js: string;
  /** Which renderer the bundle uses; selects the HTML shell. Default "dom". */
  renderer?: "dom" | "canvas";
}

export interface ClientPagesConfig {
  /**
   * Page path → client bundle. Defaults to `{ "/": dom, "/canvas": canvas }`
   * for whichever bundles are provided; override to serve at other paths.
   */
  routes: Record<string, ClientBundle>;
  /** `<title>` for the served HTML. Default "Hypen". */
  title?: string;
}

interface Served {
  contentType: string;
  body: string;
}

// Default system font stack applied to the page and inherited by the renderer
// subtree so app text renders in a sane sans-serif (not the browser's default
// serif). Components can still override per-element via `fontFamily` /
// Tailwind font utilities.
const FONT_STACK = `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;

const BASE_CSS = `
    body {
      font-family: ${FONT_STACK};
      -webkit-font-smoothing: antialiased;
      text-rendering: optimizeLegibility;
    }
    #app, #app * { font-family: inherit; }
    button, input, textarea, select { font: inherit; }`;

function domShell(title: string, scriptPath: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { height: 100%; }
    #app {
      width: 100vw;
      height: 100vh;
      min-height: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
${BASE_CSS}
  </style>
</head>
<body data-hypen-renderer="dom">
  <div id="app"></div>
  <script type="module" src="${scriptPath}"></script>
</body>
</html>`;
}

function canvasShell(title: string, scriptPath: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { height: 100%; }
    body { display: flex; align-items: center; justify-content: center; background: #000; }
    canvas#app { width: 100%; height: 100vh; background: #fff; }
${BASE_CSS}
  </style>
</head>
<body data-hypen-renderer="canvas">
  <canvas id="app"></canvas>
  <script type="module" src="${scriptPath}"></script>
</body>
</html>`;
}

/**
 * Build the served page/bundle map from a client-pages config. Returns a
 * path→response map: each page path serves an HTML shell, and a sibling
 * `<path>/client.js` (or `/client.js` for "/") serves its bundle.
 */
export function buildClientPages(config: ClientPagesConfig): Record<string, Served> {
  const title = config.title ?? "Hypen";
  const pages: Record<string, Served> = {};

  for (const [path, bundle] of Object.entries(config.routes)) {
    // Bundle URL: "/" → "/client.js"; "/canvas" → "/canvas/client.js".
    const jsPath = path === "/" ? "/client.js" : `${path.replace(/\/$/, "")}/client.js`;
    const shell =
      (bundle.renderer ?? "dom") === "canvas"
        ? canvasShell(title, jsPath)
        : domShell(title, jsPath);
    pages[path] = { contentType: "text/html; charset=utf-8", body: shell };
    pages[jsPath] = {
      contentType: "application/javascript; charset=utf-8",
      body: bundle.js,
    };
  }
  return pages;
}

/** Serve a built page map for a GET request, or null if no page matches. */
export function servePage(
  pages: Record<string, Served>,
  request: Request,
): Response | null {
  if (request.method !== "GET") return null;
  const pathname = new URL(request.url).pathname;
  const page = pages[pathname];
  if (!page) return null;
  return new Response(page.body, {
    headers: {
      "content-type": page.contentType,
      "cache-control": pathname.endsWith(".js") ? "public, max-age=3600" : "no-cache",
    },
  });
}
