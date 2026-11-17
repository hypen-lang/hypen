# wasm-module

A TypeScript Hypen app that uses a **Rust module**. Two modules, two
languages, one engine:

- **`Cart`** — an ordinary TypeScript module (`src/components/Cart/`).
- **`Pricing`** — a Rust crate built to a WebAssembly Component
  (`modules/pricing/`). The app points at that folder; `hypen dev` builds it
  and loads what it produces.

They talk in both directions:

| Direction | What happens | Needs |
|-----------|--------------|-------|
| Rust reads TypeScript | `Pricing` reads `Cart`'s items to compute the totals | `"reads": ["Cart"]` |
| Rust follows TypeScript | `Pricing` subscribes to `cart.count`, so the total updates on every cart change | `"reads": ["Cart"]` |
| Rust → TypeScript | At $50 or more `Pricing` dispatches `applyDiscount` to `Cart`; it arrives in `Cart`'s normal `onAction` handler with `action.sender === "pricing"` | `"dispatches": ["Cart"]` |
| TypeScript → Rust | `Cart`'s "Ask Pricing for a quote" button calls `context.getModule("pricing").dispatch("quote")` | nothing (app code is trusted) |
| UI → Rust | `Pricing`'s own "Toggle tax" button | nothing |

The app's `hypen.json` has one entry for the module project — no paths to
`.wasm` or `.hypen` files, no list of modules:

```json
"wasm": {
  "packages": {
    "./modules/pricing": {
      "source": true,
      "fallback": "./modules/pricing/prebuilt"
    }
  }
}
```

`"source": true` means "this is a module project in my repository: build
it". What `Pricing` may do is declared once, by the module project itself, in
`modules/pricing/hypen.json`:

```json
"wasm": {
  "language": "rust",
  "external": ["Cart"],
  "modules": {
    "Pricing": { "reads": ["Cart"], "dispatches": ["Cart"] }
  }
}
```

(`external` says `Cart` is a module of the app that hosts this one, not of
this project.) A source package is granted what it declares, so there is
nothing to repeat in the app. Remove `"dispatches"` there and add a grinder:
the dev server prints which module was refused and the field to add.

### Without a Rust toolchain

`"fallback"` names a built copy of the package, committed at
`modules/pricing/prebuilt/` (about 110 KB). When `cargo` or the
`wasm32-wasip2` target is missing — or with `HYPEN_NO_SOURCE_BUILD=1` —
`hypen dev` uses it and says so:

```
  Notice: ./modules/pricing: source builds are disabled (HYPEN_NO_SOURCE_BUILD) — using the prebuilt fallback ./modules/pricing/prebuilt. Changes to its sources are NOT picked up until it is built.
```

So the example runs on a machine with only Bun, but edits to
`modules/pricing/src/lib.rs` only take effect once the crate can be built.
The fallback is a snapshot: after changing the crate, refresh it (below).

## Run

From this directory, with the in-repo CLI:

```bash
bun ../../hypen-cli/bin/hypen.ts dev          # http://localhost:3000
```

Open the page and click around, or drive it from a second terminal over the
same WebSocket protocol a renderer uses:

```bash
bun scripts/drive.ts ws://localhost:3000
```

```
  click "Add grinder ($48.00)"
    <- Items: 2
    <- Discount: 10%
    <- Subtotal: $52.50
    <- Total: $47.25
    <- 10% off, decided by the "pricing" module.
    <- Discount applied: 10%
```

In this repository `tsconfig.json` points `@hypen-space/*` at the SDK sources
next to the example, so it always matches the checked-out engine. In your own
project, drop those `paths` and install the packages:
`bun add @hypen-space/core @hypen-space/server @hypen-space/module-host`.

## Working on the Rust module

With a toolchain (`rustup target add wasm32-wasip2`), `hypen dev` builds the
crate at startup, watches `modules/pricing/` and, when a source file changes,
rebuilds it and reloads the module in the open page — the cart and the totals
stay. A compile error is printed and the previous build keeps running.

`modules/pricing/` is also a Hypen project of its own:

```bash
cd modules/pricing
bun ../../../../hypen-cli/bin/hypen.ts build --target wasm   # dist/wasm/: Pricing.wasm, Pricing.hypen, app.json, hypen-modules.json
bun ../../../../hypen-cli/bin/hypen.ts pack --name hypen-example-pricing   # dist/pack/: an npm-publishable package
```

`dist/wasm/hypen-modules.json` is the package manifest: the module, the
SHA-256 of its component, and what it requests (`reads` / `dispatches` on
`Cart`). `dist/pack/` is what another app would install:

```bash
hypen add /path/to/modules/pricing/dist/pack      # shows the requests, asks, writes one hypen.json entry
```

Refresh the committed fallback after changing the crate:

```bash
bun run build:pricing     # hypen pack, then copies dist/pack to modules/pricing/prebuilt
git add -f modules/pricing/prebuilt/Pricing.wasm   # *.wasm is git-ignored repository-wide
```

The first build also provisions the crate's `wit/` directory (the
`hypen:module` WIT, marked `.hypen-provisioned` and kept up to date by the
CLI). It is committed here so plain `cargo build` works too.

## Files

```
hypen.json                          the app; points at modules/pricing as a source package
src/components/App/                 entry (TypeScript): lays out Cart and Pricing
src/components/Cart/                the TypeScript module
modules/pricing/src/lib.rs          the Rust module
modules/pricing/ui/Pricing/         its template
modules/pricing/hypen.json          the module project: what Pricing requests
modules/pricing/prebuilt/           the committed fallback package (hypen pack output)
scripts/drive.ts                    a 90-line protocol client
```

The example is booted and clicked through, in both directions, by
`hypen-cli/tests/example-wasm-module.test.ts` — on the fallback by default
(no toolchain is run), and building the crate with `HYPEN_WASM_E2E=1`.
