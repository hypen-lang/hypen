# Calculator — Hypen Example

The calculator sample from [hypen-landing](https://github.com/hypen-lang/hypen-landing)
(`src/lib/samples.ts`), running as a real Cloudflare worker: an iOS-style
calculator whose whole keypad is one data-driven `Grid`.

```
calculator/
└── cloudflare/
    ├── src/
    │   ├── calculator.ts  # The module: button records, calc logic, DSL
    │   └── worker.ts      # defineHypenWorker wiring
    ├── wrangler.jsonc
    ├── package.json
    └── tsconfig.json
```

## Run it

```bash
cd cloudflare
bun install
bun run dev          # wrangler dev → http://localhost:8787
```

Deploy with `bun run deploy`.

## What it shows off

- **Data-driven `Grid`** — `Grid(@state.buttons, key: "label")` renders the
  entire keypad from one button template; per-item colors, font sizes, and
  column spans (`.gridColumn("@{item.span}")` gives 0 its double-width key)
  all come from the records in state.
- **One action for every key** —
  `.onClick(@actions.buttonPress, type: "@{item.type}", value: "@{item.label}")`;
  the handler switches on the payload, so digits, operators, equals, decimal,
  and C/+‑/-/% are a single `onAction`.
- **Server-side logic** — the arithmetic lives in the module on the worker;
  the browser only renders patches and sends key presses.

The DSL and logic are the landing sample verbatim, except the root
`height("100%")` becomes `height("100vh")` since this renders as a page
rather than inside the playground frame.
