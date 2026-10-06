# Todo — Hypen Example

The todo sample from [hypen-landing](https://github.com/hypen-lang/hypen-landing)
(`src/lib/samples.ts`), running as a real Cloudflare worker: a dark-themed
task list with add / toggle / remove / clear-done, shared and live-synced
across every connected browser tab.

```
todo/
└── cloudflare/
    ├── src/
    │   ├── todo.ts        # The module: state, actions, inline DSL template
    │   └── worker.ts      # defineHypenWorker wiring (serveClient + syncActions)
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

Open `http://localhost:8787`, then open it again in a second tab and toggle a
task — both tabs update live. Deploy with `bun run deploy`.

## What it shows off

- **Two-way binding** — `Input(...).bind(@state.newTask)` with
  `.onKey(@actions.addTask)` for Enter-to-submit.
- **Deep proxy mutations** — `toggleTask` flips `task.done` in place and
  `addTask` uses `unshift`; no array reassignment or setState needed.
- **Expression bindings** — `@{state.tasks.length} tasks`,
  `@{item.done ? '#666' : '#fff'}` colors, conditional `line-through`.
- **Payload actions** — `.onClick(@actions.removeTask, id: "@{item.id}")`
  delivers `action.payload.id`; note the row's own `toggleTask` onClick with
  a nested button — the renderer scopes the dispatch correctly.
- **Durable Object persistence** — `.persist(durableObjectStore(global()))`
  keeps the list across DO hibernation and deploys.
- **Real-time multi-client sync** — `syncActions: true` plus the default
  routing (all `/ws` connections → one DO) makes the list collaborative.

## Deltas from the landing sample

Kept as close to `hypen-landing/src/lib/samples.ts` as possible. Differences:

- tasks are seeded in `initialState` instead of `onCreated`, so persistence
  hydration merges over them instead of being re-clobbered on cold start;
- added `.onKey(@actions.addTask)` so Enter actually submits (the sample's
  placeholder promises it);
- root `height("100%")` became `minHeight("100vh")` — this renders as a page,
  not inside the playground frame.
