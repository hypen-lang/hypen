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
  /** HTML shells only: the mount prefix ("" for "/") app routes live under. */
  base?: string;
  html?: boolean;
}

/** "/" → ""; "/canvas/" → "/canvas". */
function pageBase(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed === "" ? "" : trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** Does the request's `Accept` header list `text/html` (a page navigation)? */
function acceptsHtml(request: Request): boolean {
  const accept = request.headers.get("accept");
  return accept !== null && /(^|[,\s])text\/html(\s*[;,]|\s*$)/i.test(accept);
}

/**
 * The shell answering a page navigation to `pathname` that no page matches
 * exactly (SPA fallback, so deep links and reloads on `/about` work): the
 * page mounted at the longest prefix of the path. A last segment that looks
 * like a file (`/logo.png`) is never a page.
 */
function fallbackPage(
  pages: Record<string, Served>,
  pathname: string,
): Served | undefined {
  const last = pathname.slice(pathname.lastIndexOf("/") + 1);
  if (/\.[a-z0-9]+$/i.test(last)) return undefined;
  let best: Served | undefined;
  let bestLen = -1;
  for (const page of Object.values(pages)) {
    if (!page.html) continue;
    const base = page.base ?? "";
    const inside = base === "" || pathname === base || pathname.startsWith(`${base}/`);
    if (inside && base.length > bestLen) {
      best = page;
      bestLen = base.length;
    }
  }
  return best;
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

function domShell(title: string, scriptPath: string, base: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <link rel="icon" href="data:,">
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
<body data-hypen-renderer="dom" data-hypen-base="${base}">
  <div id="app"></div>
  <script type="module" src="${scriptPath}"></script>
</body>
</html>`;
}

function canvasShell(title: string, scriptPath: string, base: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <link rel="icon" href="data:,">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { height: 100%; }
    body { display: flex; align-items: center; justify-content: center; background: #000; }
    canvas#app { width: 100%; height: 100vh; background: #fff; }
${BASE_CSS}
  </style>
</head>
<body data-hypen-renderer="canvas" data-hypen-base="${base}">
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
    // The client maps app routes under this prefix ("/canvas" + "/about").
    const base = pageBase(path);
    const shell =
      (bundle.renderer ?? "dom") === "canvas"
        ? canvasShell(title, jsPath, escapeAttr(base))
        : domShell(title, jsPath, escapeAttr(base));
    pages[path] = { contentType: "text/html; charset=utf-8", body: shell, base, html: true };
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
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const pathname = new URL(request.url).pathname;
  let page = pages[pathname];
  if (!page && acceptsHtml(request)) page = fallbackPage(pages, pathname);
  if (!page) return null;
  return new Response(request.method === "HEAD" ? null : page.body, {
    headers: {
      "content-type": page.contentType,
      "cache-control": pathname.endsWith(".js") ? "public, max-age=3600" : "no-cache",
    },
  });
}
