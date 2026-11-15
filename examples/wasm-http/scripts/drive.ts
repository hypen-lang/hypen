/**
 * Drive the running example over its real protocol, like a renderer would:
 * connect a WebSocket, say hello, click "Refresh", and print what the server
 * streams back.
 *
 *   bun scripts/api.ts                                   # terminal 1
 *   bun ../../hypen-cli/bin/hypen.ts dev --port 3000     # terminal 2
 *   bun scripts/drive.ts ws://localhost:3000             # terminal 3
 *
 * Optional: a URL (and a time budget in ms) for the module to request
 * instead of its default endpoint —
 *
 *   bun scripts/drive.ts ws://localhost:3000 http://127.0.0.1:8787/slow 500
 */

type Patch = { type: string; id?: string; elementType?: string; props?: Record<string, unknown>; value?: unknown; semantics?: { name?: string } };

const [url = "ws://localhost:3000", target, timeout] = process.argv.slice(2);
const socket = new WebSocket(url);
const patches: Patch[] = [];

socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data)) as { type: string; patches?: Patch[] };
  if (message.type !== "initialTree" && message.type !== "patch") return;
  patches.push(...(message.patches ?? []));
  for (const patch of message.patches ?? []) {
    if (message.type === "patch" && patch.type === "setProp" && typeof patch.value === "string") {
      console.log(`    <- ${patch.value}`);
    }
  }
});

const settle = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

await new Promise<void>((done, fail) => {
  socket.addEventListener("open", () => done());
  socket.addEventListener("error", () => fail(new Error(`cannot connect to ${url}`)));
});
socket.send(JSON.stringify({ type: "hello" }));
while (!patches.some((p) => p.elementType === "Button")) await settle(20);

const refresh = patches.find((p) => p.type === "create" && p.elementType === "Button" && p.semantics?.name === "Refresh");
if (!refresh?.id) throw new Error('no "Refresh" button');

console.log(`\n  click "Refresh"${target ? ` (url: ${target}${timeout ? `, timeoutMs: ${timeout}` : ""})` : ""}`);
socket.send(
  JSON.stringify({
    type: "dispatchAction",
    module: "App",
    action: "__hypen_dispatch",
    payload: {
      node: refresh.id,
      action: "refresh",
      payload: { ...(target ? { url: target } : {}), ...(timeout ? { timeoutMs: Number(timeout) } : {}) },
    },
  })
);
// The first patch is the reducer's own ("loading…"); the response arrives later.
await settle(timeout ? Number(timeout) + 1000 : 1500);
socket.close();
