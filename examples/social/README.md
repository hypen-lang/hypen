# Instagram Clone — Hypen Social Example

A cross-platform Instagram clone demonstrating Hypen's multi-language server support with shared UI components.

## Structure

```
social/
├── components/          # Shared Hypen UI components
│   ├── App/             # Root app layout with navigation
│   ├── Feed/            # Scrollable post feed
│   ├── Post/            # Individual post (image, likes, comments)
│   ├── Stories/         # Horizontal stories bar
│   ├── StoryItem/       # Individual story avatar
│   ├── Profile/         # User profile page
│   ├── CommentSection/  # Post comments view
│   └── BottomNav/       # Bottom tab navigation
├── typescript/          # TypeScript server (Bun + RemoteServer)
├── go/                  # Go server
├── kotlin/              # Kotlin server (Ktor)
├── rust/                # Rust server (Tokio)
└── swift/               # Swift server
```

## How It Works

All servers load the **same shared components** from `components/` and serve them to web (or native) clients via the Hypen remote protocol over WebSocket. Each server defines the same module with identical state and action handlers, just in its native language.

## Running

### TypeScript
```bash
cd typescript
bun run setup        # installs hypen-web's deps + this example's (see note)
bun run dev          # Start server on :3000
bun run web          # Start web client on :3001 (WEB_PORT=... to change)
```

> **First run:** the `@hypen-space/*` dependencies are `file:` links into
> this repo's `hypen-web/packages/*`, and those packages resolve their own
> dependencies (e.g. `@chenglou/pretext` for the web renderer) from
> `hypen-web/node_modules`. `bun run setup` installs both in one go
> (equivalent to `cd ../../../hypen-web && bun install`, then `bun install`
> here). Skipping it fails the web build with
> `Could not resolve: "@chenglou/pretext"`.

The web client connects to the backend on the page's host at `PORT` (default
3000) — the same variable every server below listens on — so
`PORT=4000 bun run dev` pairs with `PORT=4000 bun run web`. Point it at any
other server with `?ws=`, e.g. `http://localhost:3001/?ws=ws://localhost:4000`,
or set `WS_URL` for `bun run web`. The web client works with every backend
here (Go, Kotlin, Rust, Swift), not just the TypeScript one.

### Go
```bash
cd go
go run .
```

### Kotlin
```bash
cd kotlin
./gradlew run
```

### Rust
```bash
cd rust
cargo run
```

### Swift
```bash
cd swift
swift run
```

## Shared State

All servers manage the same state shape:

- `currentUser` — logged-in user
- `location` — current route path (`/`, `/search`, `/profile`, …), drives the `Router` in `App/component.hypen`
- `previousLocation` — last visited route, used by `goBack` / `closeStory`
- `posts` — feed posts with likes, saves, comments
- `stories` — story items with seen/unseen status
- `selectedPostComments` — comments for selected post
- `commentText` — current comment input
- `messages` — DM inbox (conversation previews with unread markers)
- `chatMessages` / `draft` — active DM thread (`/dm/:id`) and its composer input

> Photo uploads (new posts, avatar changes) through the device plane are
> implemented in the **Cloudflare** port (`cloudflare/`, the one the Home
> launcher embeds). See its README.
>
> DM threads (`Conversation` component + `conversations`/`messages` tables) are
> fully implemented in the **TypeScript** server. The other language servers
> still serve a mock conversation list; port the `Conversation` module to them
> to enable the thread view there.

## Actions

- `toggleLike` — like/unlike a post
- `toggleSave` — save/unsave a post
- `navigate` — push a route path onto the router (`{ to: "/profile" }`)
- `navigateBack` / `goBack` — pop back to `previousLocation`
- `postComment` — add a comment
- `openComments` — load comments for a post
- `sendMessage` — send a DM in the active conversation

## Desktop / Web

The shared components are responsive via `md:` Tailwind variants: on ≥768px
viewports each page renders as a centered, bordered column (Instagram-web
style) instead of stretching edge-to-edge, feed and grid images become inset
rounded cards, and stories render in a centered rounded phone frame.
Press-and-hold any feed or grid image on desktop to smoothly zoom it to full
size; releasing eases it back (`md:active:scale-*` + `transition-transform`).
