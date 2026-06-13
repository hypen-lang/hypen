import { RemoteEngine } from "@hypen-space/core/remote/client";
import { DOMRenderer } from "@hypen-space/web/dom";

const SESSION_KEY = "hypen-movie-discovery-session";
const WS_URL = new URLSearchParams(window.location.search).get("ws") ?? "ws://localhost:3177";

const appContainer = document.getElementById("app")!;

function updateStatus(_status: string) {
  // Intentionally hidden for example apps; keep lifecycle hooks simple.
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
engine.onPatches((patches) => renderer.applyPatches(patches));
engine.onDisconnect(() => updateStatus("disconnected"));

engine.connect();
