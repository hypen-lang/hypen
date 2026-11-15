# wasm-module

A TypeScript Hypen app that uses a **prebuilt Rust module**. Two modules, two
languages, one engine:

- **`Cart`** — an ordinary TypeScript module (`src/components/Cart/`).
- **`Pricing`** — a Rust crate built to a WebAssembly Component
  (`modules/pricing/`), declared in `hypen.json` and loaded as is. The built
  `pricing.wasm` (about 110 KB) is committed, so the example runs without a
  Rust toolchain.

They talk in both directions:

| Direction | What happens | Needs |
|-----------|--------------|-------|
| Rust reads TypeScript | `Pricing` reads `Cart`'s items to compute the totals | `"reads": ["Cart"]` |
| Rust follows TypeScript | `Pricing` subscribes to `cart.count`, so the total updates on every cart change | `"reads": ["Cart"]` |
| Rust → TypeScript | At $50 or more `Pricing` dispatches `applyDiscount` to `Cart`; it arrives in `Cart`'s normal `onAction` handler with `action.sender === "pricing"` | `"dispatches": ["Cart"]` |
| TypeScript → Rust | `Cart`'s "Ask Pricing for a quote" button calls `context.getModule("pricing").dispatch("quote")` | nothing (app code is trusted) |
| UI → Rust | `Pricing`'s own "Toggle tax" button | nothing |

The grants live in `hypen.json`, next to the paths of the module's files:

```json
"wasm": {
  "modules": {
    "Pricing": {
      "component": "./modules/pricing/pricing.wasm",
      "template": "./modules/pricing/ui/Pricing/Pricing.hypen",
      "reads": ["Cart"],
      "dispatches": ["Cart"]
    }
  }
}
```

Remove `"dispatches"` and add a grinder: the dev server prints which module
was refused and the field to add.

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

## Rebuild the Rust module

`modules/pricing/` is a standalone crate and, with its own `hypen.json`, a
small Hypen project. Either command builds it:

```bash
rustup target add wasm32-wasip2

cd modules/pricing
cargo build --release --target wasm32-wasip2
cp target/wasm32-wasip2/release/pricing_module.wasm pricing.wasm
```

```bash
cd modules/pricing
bun ../../../../hypen-cli/bin/hypen.ts build --target wasm    # dist/wasm/Pricing.wasm
cp dist/wasm/Pricing.wasm pricing.wasm
```

The second is how a crate gets its `wit/` directory in the first place: the
CLI writes the `hypen:module` WIT there (marked `.hypen-provisioned`, and
kept up to date) before it runs cargo. It is committed here so plain `cargo
build` works.

With `hypen dev` running, copying a new `pricing.wasm` into place reloads the
module in the open page without a reconnect; the cart and the totals stay.

`*.wasm` is git-ignored repository-wide, so a rebuilt `pricing.wasm` has to
be staged with `git add -f examples/wasm-module/modules/pricing/pricing.wasm`.

## Files

```
hypen.json                          the app; declares Pricing and its grants
src/components/App/                 entry (TypeScript): lays out Cart and Pricing
src/components/Cart/                the TypeScript module
modules/pricing/src/lib.rs          the Rust module
modules/pricing/ui/Pricing/         its template
modules/pricing/pricing.wasm        the built component
scripts/drive.ts                    a 90-line protocol client
```

The example is booted and clicked through, in both directions, by
`hypen-cli/tests/example-wasm-module.test.ts`.
