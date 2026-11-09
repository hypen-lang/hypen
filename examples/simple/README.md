# Hypen Simple

The smallest Hypen app there is: one module with a counter and a two-route
`Router`, written inline in a single file.

| Variant | Where | Run |
|---------|-------|-----|
| Cloudflare Worker (one file) | [`cf/`](cf/README.md) | `cd cf && bun install && bun run dev` → http://localhost:8787 |

Start here if you want to see the whole shape of a Hypen app — state, an
action, an inline template, and `@router.push` navigation — without any
component files, client code, or WASM wiring. For bigger apps see
`calorie-counter/`, `food-ordering/`, and `social/`.
