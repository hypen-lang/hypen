/**
 * A TypeScript `RemoteServer` (device plane on by default) for the desktop
 * client's cross-language device tests (`tests/device_ts_server.rs`).
 *
 * Run with bun; prints `PORT=<n>` once listening. Admission follows RFC 001
 * §5: the authenticator is configured, so only upgrades carrying the bearer
 * token below are admitted (native clients send no Origin).
 *
 * Every action writes its outcome into state, rendered as `key:value` text,
 * so the Rust test reads results straight from the patch stream.
 */
import { app } from "../../../hypen-web/packages/core/src/index.ts";
import { sha256Hex } from "../../../hypen-web/packages/core/src/remote/device/index.ts";
import { RemoteServer } from "../../../hypen-web/packages/server/src/remote/server.ts";

const TOKEN = "Bearer desktop-e2e";
const KEYS = ["supports", "pick", "gallery", "save", "camera"] as const;
const saveBytes = new TextEncoder().encode("hypen desktop save ".repeat(9_000)); // ~171 KB, 3 frames

const code = (r: any) => `${r.error.code}${r.error.platformDetail ? "/" + r.error.platformDetail : ""}`;

const module = app
  .defineState<Record<string, string>>(Object.fromEntries(KEYS.map((k) => [k, "-"])))
  .onAction("supports", ({ state, context }) => {
    const d = context!.device;
    state.supports = ["file.pick", "file.save", "gallery.pick", "camera.capture", "mic.record"]
      .map((c) => `${c}=${d.supports(c)}`)
      .join(",");
  })
  .onAction("pick", async ({ state, context }) => {
    const r: any = await context!.device.request("file.pick", { accept: [], maxCount: 2 });
    if (!r.ok) {
      state.pick = code(r);
      return;
    }
    const parts: string[] = [];
    for (const it of r.value.items) {
      parts.push(`${it.name}|${it.contentType}|${it.bytes.byteLength}|${await sha256Hex(it.bytes)}`);
    }
    state.pick = parts.join(";");
  })
  .onAction("gallery", async ({ state, context }) => {
    const r: any = await context!.device.request("gallery.pick", { mediaTypes: ["photo"], maxCount: 1 });
    if (!r.ok) {
      state.gallery = code(r);
      return;
    }
    const it = r.value.items[0];
    state.gallery = `${it.contentType}|${it.bytes.byteLength}|${await sha256Hex(it.bytes)}`;
  })
  .onAction("save", async ({ state, context }) => {
    const r: any = await context!.device.save(saveBytes, { name: "report.txt", contentType: "text/plain" });
    state.save = r.ok ? `ok|${r.value.bytesWritten}|${await sha256Hex(saveBytes)}` : code(r);
  })
  .onAction("camera", async ({ state, context }) => {
    const r: any = await context!.device.request("camera.capture", { mode: "photo" });
    state.camera = r.ok ? "unexpected success" : code(r);
  })
  .build();

const server = new RemoteServer()
  .module("App", module)
  .ui(`Column { ${KEYS.map((k) => `Text("${k}:@{state.${k}}")`).join(" ")} }`)
  .config({
    authenticate: (req: Request) => req.headers.get("authorization") === TOKEN,
    webClient: false,
  });
await server.listen(0);
const port = (server as unknown as { server: { port: number } }).server.port;
console.log(`PORT=${port}`);
