import { RemoteEngine } from "@hypen-space/core/remote/client";
import { createHypenClient } from "@hypen-space/web/dom";

const SESSION_KEY = "hypen-instagram-session";
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
  // Browser back/forward integration: popstate dispatches the server-side
  // `navigateBack` action, which updates `state.location`. The engine's
  // first-class Router IR node picks the matching route on the server and
  // emits patches that swap the rendered subtree — there is no client-side
  // route resolution.
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
