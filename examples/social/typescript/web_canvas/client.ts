import { RemoteEngine } from "@hypen-space/core/remote/client";
import { createHypenClient } from "@hypen-space/web/canvas";

const SESSION_KEY = "hypen-instagram-session-canvas";
const WS_URL = "ws://localhost:3000";

const canvas = document.getElementById("app") as HTMLCanvasElement;

const savedSessionId = localStorage.getItem(SESSION_KEY);

const engine = new RemoteEngine(WS_URL, {
  autoReconnect: true,
  reconnectInterval: 3000,
  maxReconnectAttempts: 10,
  session: {
    id: savedSessionId ?? undefined,
    props: { platform: "web_canvas" },
  },
  navigation: {
    backAction: "navigateBack",
    viewStateKey: "location",
  },
});

createHypenClient(canvas, engine, {
  devicePixelRatio: window.devicePixelRatio,
  backgroundColor: "#ffffff",
});

engine.onSessionEstablished(({ sessionId }) => {
  localStorage.setItem(SESSION_KEY, sessionId);
});

engine.connect();
