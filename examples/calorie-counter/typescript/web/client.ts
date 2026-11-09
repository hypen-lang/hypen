import { RemoteEngine } from "@hypen-space/core/remote/client";
// Import from `/dom` so the bundler doesn't have to pull in the
// canvas renderer's Taffy/pretext deps just to use the DOM
// renderer.
import { DOMRenderer } from "@hypen-space/web/dom";

const SESSION_KEY = "hypen-calorie-counter-session";
// Which backend to talk to: `?ws=ws://host:port` wins, then the URL the web
// server injected into the page (serve.ts knows the backend's PORT / WS_URL),
// then the default backend port on this page's own host.
function resolveWsUrl(): string {
  const fromQuery = new URLSearchParams(location.search).get("ws");
  if (fromQuery) return fromQuery;
  const injected = document.querySelector<HTMLMetaElement>('meta[name="hypen-ws"]')?.content;
  if (injected) return injected;
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.hostname || "localhost"}:3000`;
}
const WS_URL = resolveWsUrl();

const appContainer = document.getElementById("app")!;
const statusEl = document.getElementById("status");

function updateStatus(status: string) {
  if (!statusEl) return;
  statusEl.textContent = status;
  statusEl.className = `status ${status}`;
}

const savedSessionId = localStorage.getItem(SESSION_KEY);

const engine = new RemoteEngine(WS_URL, {
  autoReconnect: true,
  reconnectInterval: 3000,
  maxReconnectAttempts: 10,
  session: {
    id: savedSessionId ?? undefined,
    props: { platform: "web" },
  },
  // Browser back/forward integration. `popstate` → dispatches the
  // server-side `navigateBack` action, which updates
  // `state.location` on App, which the engine-side Router IR uses to
  // swap the visible subtree. No client-side route resolution.
  navigation: {
    backAction: "navigateBack",
    viewStateKey: "location",
  },
});

const renderer = new DOMRenderer(appContainer, engine);

engine.onConnect(() => updateStatus("connecting"));

engine.onSessionEstablished(({ sessionId }) => {
  localStorage.setItem(SESSION_KEY, sessionId);
  updateStatus("connected");
});

engine.onPatches((patches) => {
  renderer.applyPatches(patches);
});

engine.onDisconnect(() => updateStatus("disconnected"));

engine.connect();
