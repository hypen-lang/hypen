# Vendored taffy: local patches

This directory is **taffy 0.10.1 exactly as published on crates.io**
(`.cargo_vcs_info.json`: upstream commit
`639f0acdd20f914f847abffbeaa903d66cae4882`), plus one patch. The workspace
uses it through `[patch.crates-io] taffy = { path = "third_party/taffy" }`
in the root `Cargo.toml` and excludes it from the workspace members. Only
`hypen-renderer-desktop` depends on taffy.

Licence: taffy is MIT (`license = "MIT"` in `Cargo.toml`; the published
crate ships no separate licence file). All sources and notices are kept
unchanged apart from the hunk below. Files added here (not in the upstream
crate): `PATCHES.md`, `hypen-grid-area-percent.patch`. The published
`Cargo.lock` and the registry markers (`.cargo-ok`,
`.cargo_vcs_info.json`) are not copied.

## Patch: grid item minimum contribution resolves percentages against the grid area (`hypen-grid-area-percent.patch`)

**What.** `GridItem::minimum_contribution`
(`src/compute/grid/types/grid_item.rs`) resolves the item's own `size` and
`min_size` percentages against the item's grid-area estimate (the
`known_dimensions` argument the track-sizing pass already computes from the
other axis' tracks) instead of the grid container's inner size.

**Why.** CSS Grid §6.6 / §11.5: during track sizing an item's percentages
resolve against its grid area, never the container. taffy 0.10.1 already
does that for the min-/max-content contributions (`known_dimensions()`),
but the minimum contribution of an `auto`-minimum track used the
container. A `width: 100%; aspect-ratio: 1` photo in a 3-column grid
(`Grid { Image.tw("aspect-square w-full") }`, the Social / Photos grids)
therefore asked for a row as tall as the WHOLE grid is wide, so the desktop
renderer had to size Grid rows `min-content` instead of CSS's `auto` and
could not stretch rows to fill a definite-height grid like Chrome.

**Upstream.** Fixed upstream from taffy 0.11.0, as part of the
`grid_area_size` rework of `GridItem` (the same function there reads
`.maybe_resolve(grid_area_size, …)`; it is still so in 0.15.1). That
release also changes the public alignment API (`AlignSelf::Stretch` →
`AlignSelf::STRETCH` constants, `AlignItems` as a struct) and flexbox /
dimension internals, so the desktop renderer stays on 0.10.1 with this
one-hunk backport. Drop this vendored copy when moving to taffy ≥ 0.11.

Tests: `hypen-renderer-desktop` `layout::tests::flex_one_grid_rows_stretch_to_fill_like_css`,
`grid_of_aspect_square_thumbnails_unchanged` and
`bare_images_stretch_to_grid_tracks_while_explicit_size_wins` fail without
this patch once Grid rows are `auto`.
