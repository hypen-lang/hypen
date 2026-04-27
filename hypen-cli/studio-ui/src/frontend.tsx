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
 *  full-screen with its close button wired to `window.close()`. Active file
 *  comes from `?file=<path>` so the pop-out inherits whatever the Studio
 *  tab was on when the user clicked "Open in new window". */
function StandaloneTestMode() {
  const file = new URLSearchParams(window.location.search).get("file");
  return <TestMode activeFile={file} onClose={() => window.close()} />;
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
