/**
 * Drive the running example over its real protocol, like a renderer would:
 * connect a WebSocket, say hello, read the initial tree, click buttons by
 * sending `__hypen_dispatch` envelopes, and print what the server streams.
 *
 *   bun ../../hypen-cli/bin/hypen.ts dev --port 3000     # in one terminal
 *   bun scripts/drive.ts ws://localhost:3000             # in another
 */

type Patch = { type: string; id?: string; elementType?: string; props?: Record<string, unknown>; value?: unknown; semantics?: { name?: string } };

const url = process.argv[2] ?? "ws://localhost:3000";
const socket = new WebSocket(url);
const patches: Patch[] = [];
let waiting: (() => void) | null = null;

socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data)) as { type: string; patches?: Patch[] };
  if (message.type === "initialTree" || message.type === "patch") {
    patches.push(...(message.patches ?? []));
    for (const patch of message.patches ?? []) {
      if (message.type === "patch" && patch.type === "setProp" && typeof patch.value === "string") {
        console.log(`    <- ${patch.value}`);
      }
    }
  }
  waiting?.();
});

const settle = (ms = 250) => new Promise<void>((done) => setTimeout(done, ms));
const nextMessage = () => new Promise<void>((done) => (waiting = done));

function button(label: string): string {
  const found = patches.find((p) => p.type === "create" && p.elementType === "Button" && p.semantics?.name === label);
  if (!found?.id) throw new Error(`no button "${label}"`);
  return found.id;
}

/** The current text of every Text node, in tree order. */
function texts(): string[] {
  const byNode = new Map<string, string>();
  for (const p of patches) {
    if (p.type === "create" && p.elementType === "Text" && typeof p.props?.["0"] === "string") byNode.set(p.id!, p.props["0"] as string);
    if (p.type === "setProp" && byNode.has(p.id!) && typeof p.value === "string") byNode.set(p.id!, p.value);
  }
  return [...byNode.values()];
}

async function click(label: string, action: string): Promise<void> {
  console.log(`\n  click "${label}"`);
  socket.send(JSON.stringify({ type: "dispatchAction", module: "App", action: "__hypen_dispatch", payload: { node: button(label), action, payload: {} } }));
  await settle();
}

await new Promise<void>((done, fail) => {
  socket.addEventListener("open", () => done());
  socket.addEventListener("error", () => fail(new Error(`cannot connect to ${url}`)));
});
socket.send(JSON.stringify({ type: "hello" }));
while (!patches.length) await nextMessage();
await settle();

const show = (title: string) => {
  console.log(`\n  ${title}`);
  for (const line of texts().filter((t) => /^(Items|Discount|Subtotal|Tax|Total|Quotes|\d+% off|No discount)/.test(t))) {
    console.log(`    ${line}`);
  }
};

show("initial tree");
// TypeScript module's own button; the Rust module follows through its subscription.
await click("Add coffee ($4.50)", "addCoffee");
// Crosses the $50 threshold: Rust reads Cart, then dispatches applyDiscount to it.
await click("Add grinder ($48.00)", "addGrinder");
// TypeScript -> Rust through context.getModule("pricing").dispatch("quote").
await click("Ask Pricing for a quote", "requestQuote");
// The Rust module's own button.
await click("Toggle tax (8%)", "toggleTax");
show("final state");
socket.close();
