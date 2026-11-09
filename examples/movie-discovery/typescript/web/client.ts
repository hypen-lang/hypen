import { RemoteEngine } from "@hypen-space/core/remote/client";
import { DOMRenderer } from "@hypen-space/web/dom";

const SESSION_KEY = "hypen-movie-discovery-session";
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
