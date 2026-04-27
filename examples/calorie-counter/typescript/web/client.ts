import { RemoteEngine } from "@hypen-space/core/remote/client";
// Import from `/dom` so the bundler doesn't have to pull in the
// canvas renderer's Taffy/pretext deps just to use the DOM
// renderer.
import { createHypenClient } from "@hypen-space/web/dom";

const SESSION_KEY = "hypen-calorie-counter-session";
const WS_URL = "ws://localhost:3000";

const appContainer = document.getElementById("app")!;
const statusEl = document.getElementById("status")!;

function updateStatus(status: string) {
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

createHypenClient(appContainer, engine);

engine.onConnect(() => updateStatus("connecting"));

engine.onSessionEstablished(({ sessionId }) => {
  localStorage.setItem(SESSION_KEY, sessionId);
  updateStatus("connected");
});

engine.onDisconnect(() => updateStatus("disconnected"));

engine.connect();
