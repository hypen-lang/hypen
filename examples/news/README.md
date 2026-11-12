# News — Hypen Example

"The Daily Hypen": Wikipedia's front page and Hacker News, live, as a
Cloudflare Worker. Real data only: the
[Hacker News Firebase API](https://github.com/HackerNews/API) and the
[Wikimedia REST feed](https://api.wikimedia.org/wiki/Feed_API). Neither needs a key.

```
examples/news/
└── cloudflare/
    ├── wrangler.jsonc          # Worker config (DOs: NewsDO per visitor, NewsHub shared). Port 8800
    ├── package.json
    ├── tsconfig.json
    ├── test/
    │   ├── news.test.ts        # bun test: HTML sanitiser, feed normalisers, comment tree, live deltas
    │   └── fixtures/           # recorded (trimmed) Wikimedia + HN responses
    └── src/
        ├── worker.ts           # defineHypenWorker + visitor cookie routing + scoped DO subclass
        ├── hub.ts              # NewsHub DO: the only thing that calls upstream; TTL cache
        ├── upstream.ts         # HN / Wikipedia fetches + normalisers
        ├── scope.ts            # per-visitor AsyncLocalStorage scope; saved stories + read history
        ├── comments.ts         # lazily loaded comment tree, flattened for one keyed ForEach
        ├── html.ts             # HN / Wikipedia HTML → safe text + link list
        ├── stories.ts          # story rows: read/saved flags, rank deltas, score bumps
        ├── actions.ts          # shared openStory / toggleSave, per-module polling timers
        ├── theme.ts            # palette + DSL snippets (story row, section header, skeletons)
        ├── format.ts, icons.ts
        └── components/
            ├── App.ts          # Router shell + persistent BottomNav
            ├── BottomNav.ts    # Today / Hacker News / On this day / Saved
            ├── Today.ts        # picture of the day, In the news, most read, live top HN, on this day
            ├── Hacker.ts       # Top / New / Best / Ask / Show / Jobs, live re-ranking
            ├── Story.ts        # story + collapsible threaded comments (/story/:id)
            ├── OnThisDay.ts    # timeline: selected / events / births / deaths
            ├── Article.ts      # Wikipedia page summary (/wiki/:title), shared-element hero
            └── Saved.ts        # bookmarks + read history
```

## Run it

```bash
cd examples/news/cloudflare
bun install
bun run dev          # wrangler dev → http://localhost:8800 (/canvas for the canvas renderer)
bun test             # unit tests against recorded fixtures
```

The port (8800) and inspector port (9242) are pinned in `wrangler.jsonc`, so
it can run next to the other examples. The home-screen launcher embeds it
with `HypenApp("ws://localhost:8800/ws")`.

## How it works

- **One upstream budget for everyone.** Visitor DOs never call HN or
  Wikipedia. They ask the `NewsHub` Durable Object (a single instance named
  `hub`) over DO RPC. The hub caches each response in memory with a TTL. HN
  lists are re-polled at most every 20 s, list items every 30 s, comments every
  5 min, and Wikipedia responses for 30 min to 6 h. Only the first 30 ids of a
  list are hydrated, 8 at a time. Every entry is single-flight, so concurrent
  askers share one fetch. Entries are also stale-on-error, which matters
  because Wikimedia answers bursts with 429. Wikimedia requests send a generic
  descriptive `User-Agent` / `Api-User-Agent`.
- **Live re-ordering.** While the Hacker News tab (or Today's top-6 block)
  is on screen, the module re-reads its list from the hub every 10 to 15 s and
  rewrites the keyed `stories` array. The reconciler turns that into
  Move/SetProp/Insert/Remove patches:
  - re-ranked rows glide into place (`.layout(spring)`) and show a ▲n / ▼n
    badge for one cycle;
  - stories that enter the top 30 slide in (`.enter`) and are marked NEW;
  - stories that drop out fade (`.exit`);
  - a row whose score rose flashes green under a `.transition`.

  A header line summarises each poll ("2 moved · 3 score updates"). The
  timers start in `onActivated`, stop in `onDeactivated`/`onDestroyed`, and
  re-enter the visitor scope on each tick.
- **Comment trees.** `Story` loads the story, then the first 12 top-level
  comments, and opens the first two threads one level deep. Anything deeper
  is fetched only when a reader taps "N replies". The tree stays on the
  server (`comments.ts`). The template renders its visible slice as one flat
  keyed list with a `depth`, an indent and a coloured thread rail, so expand,
  collapse (`[–]` / `[+N]`) and "show more threads" are keyed inserts and
  removes that animate.
- **HTML is never passed through.** HN comment text and Wikipedia blurbs
  are HTML. `html.ts` drops every tag and turns `<p>`/`<br>` into paragraph
  breaks, keeps `<pre>` whitespace, and decodes entities once, after the tags
  are gone, so `&lt;script&gt;` stays literal text. Anchors keep their
  visible text inline and are collected into a link list (absolute
  http/https only), which renders as tappable chips.
- **Opening the original.** Hypen has no "open URL" device capability, so
  external pages use `Link(href:, target: "_blank", rel: "noopener noreferrer")`.
  This covers "Read article", "On HN", comment link chips, the picture of the
  day, and "Read on Wikipedia".
- **Per-visitor library.** Each visitor is routed to their own `NewsDO` by
  an HttpOnly `hypen_news` cookie. The cookie is minted on the first page load
  or the first WebSocket upgrade. The second case matters because an embedded
  app never loads this worker's page, and Chromium stores cookies from the
  handshake response. Saved stories and read history live in that DO's
  storage. Read stories are dimmed in every list, and saved ones are tinted.
  Durable Objects of one class share an isolate, so a module-level "current
  storage" would race between visitors. `NewsDO` therefore wraps every entry
  point in `visitorScope.run({ storage, hub }, …)` (AsyncLocalStorage). This
  is the same pattern the home-screen example uses for its drive.
- **Shared elements.** Most-read cards, news thumbnails and timeline
  thumbnails fly into the article hero (`.sharedElement("wiki-hero")`). The
  list marks exactly one row's `hero` field right before it pushes the route.

## Known issues (engine / SDK, worked around here)

These were found against the published `hypen-engine@0.6.7`,
`@hypen-space/cf@0.6.7` and `@hypen-space/core@0.6.7`:

- **`clearChildren` is emitted but not applied.** When a keyed list loses
  every row at once (a tab switch), the engine sends one `clearChildren`
  patch. The generic client bundled in `@hypen-space/cf@0.6.7` has no case
  for it, so the old rows stay on screen. Taps on those rows then fail with
  "stale UI action target". The workaround is that every list row here has an
  `.exit(...)`, because rows with an exit transition always get per-row
  `remove` patches.
- **Alias + state in one expression.** Inside `ForEach(..., as: "t")`, an
  expression that mixes the alias with module state, such as
  `"@{state.kind == t.id ? … : …}"`, resolves to nothing, and the prop is
  never set. The workaround is to precompute flags per row (`t.active`, and
  `hero` for shared-element keys).
- **Bound `.label(...)` doesn't reach the DOM.** `.label("@{…}")` produces
  no `aria-label`. The static bookmark button uses `.label("Bookmark")`.
  Bound labels are kept where `hypen check` needs an accessible name.
- **`Icon` names resolve at template time.** `Icon("@{…}")` cannot switch
  glyphs, so the saved state is shown with colour and a tinted pill.
- **Spurious engine warning.** The log shows `Component "Link" did not
  resolve: it is not a registered primitive…`, but links render fine.
- **Canvas renderer.** On `/canvas`, the `Heading` titles do not render.
  The DOM client at `/` is the reference.
