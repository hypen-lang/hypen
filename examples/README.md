# Examples

Every example is a complete Hypen app. Most deploy as a Cloudflare Worker and are live, so you can try them before cloning. The home screen embeds the others, so it is the best first stop.

| Example | What it shows | Live |
|---------|---------------|------|
| [`home-screen/`](home-screen/) | A phone-style launcher that embeds every other app with one `HypenApp("wss://…")` line each | [open](https://hypen-home-screen.ian-dae.workers.dev/) |
| [`todo/`](todo/) | Two-way binding, list animations, Durable Object persistence, agent interface | [open](https://hypen-todo.ian-dae.workers.dev/) |
| [`calculator/`](calculator/) | Grid layout and keyboard handling | [open](https://hypen-calculator.ian-dae.workers.dev/) |
| [`calorie-counter/`](calorie-counter/) | Inline `.ui(...)` modules, forms, charts | [open](https://hypen-calorie-counter.ian-dae.workers.dev/) |
| [`food-ordering/`](food-ordering/) | Multi-screen routing, nested modules, cart state | [open](https://hypen-food-ordering.ian-dae.workers.dev/) |
| [`movie-discovery/`](movie-discovery/) | Remote API data, shared element transitions, detail routes | [open](https://hypen-movie-discovery.ian-dae.workers.dev) |
| [`social/`](social/) | An Instagram-style feed with the same UI served from several server languages | [open](https://hypen-social.ian-dae.workers.dev/) |
| [`hypeflix/`](hypeflix/) | A Netflix-style browser with rows, hero banners and breakpoints | [open](https://hypen-hypeflix.ian-dae.workers.dev/) |
| [`simple/`](simple/) | The smallest Hypen-on-Cloudflare app: one file, a counter and two routes | run locally |
| [`stock-lab/`](stock-lab/) | One template with charts captured on all five renderers (the README hero image) | run locally |
| [`a11y-demo/`](a11y-demo/) | Every semantics translation the renderers perform, on one screen | run locally |
| [`device-lab/`](device-lab/) | Exercises the device capability plane against real clients | run locally |

## Running one locally

Each Cloudflare example lives under `<name>/cloudflare/` (or `simple/cf/`):

```bash
cd examples/todo/cloudflare
bun install
bun run dev        # wrangler dev → http://localhost:8787
```

`scripts/run.sh` runs several at once with a fixed port map. The deployed Workers pin the published `@hypen-space/*` versions; when working from this repo, `bun install` links the local packages instead.

The `*-contracts.test.ts` files next to the examples are cross-SDK contract tests: they drive the same example through each server SDK and assert identical patch output.
