# Vendored taffy: local patches

This directory is **taffy 0.10.1 exactly as published on crates.io**
(`.cargo_vcs_info.json`: upstream commit
`639f0acdd20f914f847abffbeaa903d66cae4882`), plus four local changes kept as
three patch files. The workspace uses it through `[patch.crates-io] taffy = { path = "third_party/taffy" }`
in the root `Cargo.toml` and excludes it from the workspace members. Only
`hypen-renderer-desktop` depends on taffy.

Licence: taffy is MIT (`license = "MIT"` in `Cargo.toml`; the published
crate ships no separate licence file). All sources and notices are kept
unchanged apart from the hunks below. Files added here (not in the upstream
crate): `PATCHES.md` and the three `hypen-*.patch` files. The published
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

## Patches in `src/compute/flexbox.rs` (`hypen-flex-container-auto-min.patch`)

That file carries two independent hunks, described in the next two sections.

### A flex container's definite-space main size counts each item's automatic minimum

**What.** `determine_container_main_size` (`src/compute/flexbox.rs`), in the
branch taken when the container's main size is auto but its available main
space is definite, sums each item's flex basis floored by its RESOLVED
minimum main size (`resolved_minimum_main_size`, i.e. the CSS automatic
`min-size: auto` content minimum when no explicit min is set) instead of the
style `min-size` alone.

**Why.** CSS flexbox §9.2/§9.3: an auto-sized container's main size comes
from its items' hypothetical main sizes, which are clamped by the automatic
minimum. A `flex: 1` (basis 0) item inside an auto-height column — MovieDB's
watchlist `Button(flex-1) { Row(flex-1) { poster; text } }` — counted as 0,
so the Button came out 0px tall, was centred in its card and its poster and
text spilled out below it. The MIN-/MAX-content branches of the same function
already use the resolved minimum.

Test: `layout::tests::button_wrapping_a_growing_row_is_as_tall_as_its_content`.

### An aspect-ratio item's hypothetical cross size comes from its used main size

**What.** `determine_hypothetical_cross_size`: an item with an `aspect_ratio`
and an auto cross size takes its hypothetical cross size from its target
(used) main size through the ratio, before falling back to the content-size
measure.

**Why.** CSS flexbox §9.4 step 7 lays the item out at its used main size
with its inherent sizing, so the ratio applies. taffy measured it in
`ContentSize` mode, which ignores the ratio, so Social's no-results
placeholders — `Row { Column.tw("flex-1 aspect-square") ×3 }` — were 0px
tall where Chrome draws three squares.

Test: `layout::tests::flex_one_aspect_square_tiles_in_a_row_are_square`.

## Patch: grid block-axis tracks maximise to their growth limits when the grid height is not definite (`hypen-grid-block-maximise.patch`)

**What.** `track_sizing_algorithm` (`src/compute/grid/track_sizing.rs`)
runs §11.6 "Maximise Tracks" in the BLOCK axis of a grid without a definite
height with infinite free space (`MaxContent`) instead of the available
space the parent passed (a definite viewport height, or a min-content probe).

**Why.** In browsers block layout never hands a box a definite available
block size, and a box's min-content block size is its laid-out content
height. With taffy's definite / min-content available space an `auto` row
whose items have a zero automatic minimum (`overflow: hidden` cards: the
Food ordering `Grid { MenuItem }`) stayed at a share of the viewport (or at
zero for a flex parent's automatic-minimum probe), the flex parent shrank the
Grid to that, and every card showed only its photo. Definite-height grids
(`flex-1` Grid rows stretching to fill, Social profile) and grids with a
`max-height` (whose available space taffy already clamps to it) are
unaffected.

Test: `layout::tests::auto_grid_rows_hold_the_full_height_of_overflow_hidden_cards`.
