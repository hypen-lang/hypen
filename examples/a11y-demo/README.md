# a11y-demo

A single-screen Hypen app that exercises every semantics translation the
native renderers implement — the companion app for the on-device
VoiceOver/TalkBack validation checklist in
[`docs/plans/accessibility-native-validation.md`](../../docs/plans/accessibility-native-validation.md).

## What's on the screen

- Buttons with derived names, an explicit `.label(...)` override, and an
  icon-only button fixed with `.label` + `.description`
- A `.hidden()` decorative text
- An `Image` whose templated `alt` changes via an action (proves
  `setSemantics` live-updates reach the platform accessibility tree)
- A disclosure button with bound `.expanded` and `.controls`
- Bound `Checkbox` / `Switch` (plus a button that flips the same state from
  the module) and a `.pressed` toggle button
- A navigation landmark with a `.current("page")` item, and a search input
- A `Tabs { Tab … TabPanel … }.id("prefs")` widget (auto-wired id graph)
- A listbox with per-option `.id`s and a bound `.activedescendant`
- A conditional dialog (`.role("dialog")`)
- Headings with explicit levels structuring all of the above

## Run

Use the in-repo CLI (the published `@hypen-space/cli` may lag behind the
`check` command and the newest role vocabulary):

```bash
bun install

# Web (sanity check)
bun ../../hypen-cli/bin/hypen.ts dev

# Native (the point of this demo)
bun ../../hypen-cli/bin/hypen.ts run ios
bun ../../hypen-cli/bin/hypen.ts run android
```

## Conformance baseline

The demo must stay clean under the accessibility checker, so that anything
wrong on device is a *translation* bug, not an authoring bug:

```bash
bun ../../hypen-cli/bin/hypen.ts check
# expected: "No accessibility issues found.", exit 0
```
