import { app } from "../../hypen-web/packages/core/src/index.ts";
import { RemoteServer } from "../../hypen-web/packages/server/src/remote/server.ts";
import { sha256Hex } from "../../hypen-web/packages/core/src/remote/device/index.ts";
import { mkdir, appendFile } from "node:fs/promises";

const ui = await Bun.file(new URL("app.hypen", import.meta.url)).text();
const names = ["gallery.pick", "file.pick", "file.save", "camera.capture", "mic.record", "bluetooth.select", "bluetooth.scan", "permission.query", "permission.request"] as const;
const saveBytes = new TextEncoder().encode("Device Lab payload 0123456789\n".repeat(3400));
await mkdir(new URL("results-2026-09-26/uploads", import.meta.url), { recursive: true });
const pending = new WeakMap<object, AbortController>();
let sequence = 0;
async function summarize(value: any): Promise<any> {
  if (value instanceof Uint8Array) {
    const sha256 = await sha256Hex(value);
    await Bun.write(new URL(`results-2026-09-26/uploads/${sha256}.bin`, import.meta.url), value);
    return { bytes: value.length, sha256 };
  }
  if (Array.isArray(value)) return Promise.all(value.map(summarize));
  if (value && typeof value === "object") return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([k,v]) => [k, await summarize(v)])));
  return value;
}
const builder = app.defineState({ server: "TS / Bun", runs: 0, result: "Connected. Choose a check.", detail: "", history: "" });
for (const name of ["status","query","permission","gallery","file","save","camera","record","scan","bluetooth","cancel","ping"]) {
  builder.onAction(name, async ({ state, context }) => {
    if (name === "cancel") { pending.get(state)?.abort(); return; }
    state.runs++;
    state.result = `${name}: running…`;
    state.detail = "";
    const abort = new AbortController();
    if (name !== "status" && name !== "ping") pending.set(state, abort);
    const options = { signal: abort.signal, timeoutMs: 45_000 };
    let result: any;
    try {
      const d = context.device;
      switch(name) {
        case "ping": result = { ok: true, value: "UI remains responsive" }; break;
        case "status": result = { ok: true, value: Object.fromEntries(names.map(n => [n,d.supports(n)])) }; break;
        case "query": result = await d.request("permission.query", { permission: "camera" }, options); break;
        case "permission": result = await d.request("permission.request", { permission: "microphone" }, options); break;
        case "gallery": result = await d.request("gallery.pick", { mediaTypes: ["photo"], maxCount: 1 }, options); break;
        case "file": result = await d.request("file.pick", { accept: ["text/plain", ".txt"], maxCount: 2 }, options); break;
        case "save": result = await d.save(saveBytes, { name: "device-lab.txt", contentType: "text/plain" }, options); break;
        case "camera": result = await d.request("camera.capture", { mode: "photo", facing: "back" }, options); break;
        case "bluetooth": result = await d.request("bluetooth.select", {}, options); break;
        case "record": {
          let count = 0;
          const stream = d.stream("mic.record", { format: "pcm16", sampleRate: 16000, channels: 1, maxDurationMs: 3000 }, options,
            { onData: chunk => { count += chunk.length; state.detail = `Audio received: ${count} bytes`; } });
          result = await stream.settled;
          break;
        }
        case "scan": {
          let count = 0;
          const stream = d.stream("bluetooth.scan", {}, options, () => { state.detail = `Devices: ${++count}`; });
          const timer = setTimeout(() => stream.cancel(), 3000);
          result = await stream.settled;
          clearTimeout(timer);
          break;
        }
      }
    } catch (error) { result = { ok: false, error: { code: "exception", platformDetail: String(error) } }; }
    const clean = await summarize(result);
    state.result = `${name}: ${clean.ok ? "OK" : clean.error?.code}`;
    state.detail = JSON.stringify(clean, null, 2);
    state.history = `${state.result}\n${state.history}`.split("\n").slice(0, 5).join("\n");
    await appendFile(new URL("results-2026-09-26/ts.jsonl", import.meta.url), JSON.stringify({ sequence: ++sequence, at: new Date().toISOString(), action: name, result: clean })+"\n");
    console.log(name, JSON.stringify(clean));
    if (pending.get(state) === abort) pending.delete(state);
  });
}
const server = new RemoteServer().module("App", builder.build()).ui(ui)
  .config({ hostname: "127.0.0.1", ...(process.env.DEVICE_LAB_NO_COMPRESSION === "1" ? { compression: false } : {}), webClient: false, allowedOrigins: ["http://127.0.0.1:45100"],
    authenticate: (request: Request) => new URL(request.url).searchParams.get("token") === "device-lab" });
await server.listen(45101);

const build = await Bun.build({ entrypoints: [new URL("web.ts", import.meta.url).pathname], target: "browser", format: "esm" });
if (!build.success) throw new Error(build.logs.join("\n"));
const bundle = await build.outputs[0].text();
Bun.serve({ hostname: "127.0.0.1", port: 45100, fetch(request) {
  const u = new URL(request.url);
  if(u.pathname === "/app.js") return new Response(bundle, { headers: { "content-type": "text/javascript" } });
  return new Response(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Device Lab</title><style>body{margin:0;background:#f1f5f9;font-family:system-ui}nav{padding:12px;background:#142334;color:white}a{color:white;margin:8px}#app{width:440px;min-height:680px;background:white;margin:12px auto}canvas{width:440px;height:740px;display:block}#connection{font-size:12px}</style><nav><a href="/?renderer=dom">DOM</a><a href="/?renderer=canvas">Canvas</a>Server <select id="server"><option value="45101">TS</option><option value="45102">Go</option><option value="45103">Kotlin</option><option value="45104">Swift</option><option value="45105">Rust</option></select> <span id="connection">Connecting</span></nav><div id="app"></div><script type="module" src="/app.js"></script>`, { headers: { "content-type": "text/html" } });
} });
console.log("Device Lab: http://127.0.0.1:45100 / native ws://127.0.0.1:45101?token=device-lab");
