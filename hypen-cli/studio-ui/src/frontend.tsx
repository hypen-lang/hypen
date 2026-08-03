/**
 * This file is the entry point for the React app, it sets up the root
 * element and renders the App component to the DOM.
 *
 * It is included in `src/index.html`.
 */

import "./index.css";
import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { PreviewFrame } from "./components/preview-frame/PreviewFrame";
import { CellViewer } from "./components/preview-frame/CellViewer";
import { TestMode } from "./components/studio/TestMode";

/** Standalone Test Mode — same component the Studio overlay renders, but
 *  full-screen. Active file comes from `?file=<path>` so the pop-out
 *  inherits whatever the Studio tab was on when the user clicked
 *  "Open in new window". Close behaviour:
 *  - When this window was opened by `window.open(...)` (pop-out from the
 *    Toolbar), `window.close()` is allowed and tears it down.
 *  - When this is the *only* tab — opened by `hypen test` via the OS
 *    URL handler — browsers reject `window.close()`. Fall back to
 *    navigating to the full Studio at `/` so the X button always does
 *    something useful instead of looking broken. */
function StandaloneTestMode() {
  const file = new URLSearchParams(window.location.search).get("file");
  const handleClose = () => {
    // `window.opener` is non-null only for tabs created by another tab.
    if (window.opener) {
      window.close();
    } else {
      window.location.assign("/");
    }
  };
  return <TestMode activeFile={file} onClose={handleClose} />;
}

const elem = document.getElementById("root")!;
// Standalone routes used by Test Mode iframes / pop-outs.
const path = window.location.pathname;
let root: ReactNode = <App />;
if (path === "/preview-frame") root = <PreviewFrame />;
else if (path === "/cell-viewer") root = <CellViewer />;
else if (path === "/test-mode") root = <StandaloneTestMode />;

const app = <StrictMode>{root}</StrictMode>;

if (import.meta.hot) {
  // With hot module reloading, `import.meta.hot.data` is persisted.
  const root = (import.meta.hot.data.root ??= createRoot(elem));
  root.render(app);
} else {
  // The hot module reloading API is not available in production.
  createRoot(elem).render(app);
}
