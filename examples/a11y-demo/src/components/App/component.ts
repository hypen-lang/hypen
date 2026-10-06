import { app } from "@hypen-space/core";

type A11yDemoState = {
  photoAlt: string;
  detailsOpen: boolean;
  notify: boolean;
  darkMode: boolean;
  muted: boolean;
  overviewSelected: boolean;
  settingsSelected: boolean;
  activeFruit: string;
  activeFruitName: string;
  dialogOpen: boolean;
};

// Ids match the `.id(...)` anchors on the Option elements in component.hypen —
// the same author-data-driven id scheme `.activedescendant` expects.
const FRUITS = [
  { id: "fruit-0", name: "Apple" },
  { id: "fruit-1", name: "Banana" },
  { id: "fruit-2", name: "Cherry" },
];

// Alt texts the "Change photo description" action cycles through — each
// change must be re-announced by the screen reader (setSemantics re-emit).
const PHOTO_ALTS = [
  "A landscape placeholder photo",
  "A different landscape, now at golden hour",
  "The same landscape, but in winter",
];

export default app
  .defineState<A11yDemoState>({
    photoAlt: PHOTO_ALTS[0],
    detailsOpen: false,
    notify: false,
    darkMode: false,
    muted: false,
    overviewSelected: true,
    settingsSelected: false,
    activeFruit: FRUITS[0].id,
    activeFruitName: FRUITS[0].name,
    dialogOpen: false,
  })
  .onAction("cyclePhotoAlt", ({ state }) => {
    const next = (PHOTO_ALTS.indexOf(state.photoAlt) + 1) % PHOTO_ALTS.length;
    state.photoAlt = PHOTO_ALTS[next];
  })
  .onAction("toggleDetails", ({ state }) => {
    state.detailsOpen = !state.detailsOpen;
  })
  .onAction("toggleNotify", ({ state }) => {
    state.notify = !state.notify;
  })
  .onAction("toggleMute", ({ state }) => {
    state.muted = !state.muted;
  })
  .onAction("showOverview", ({ state }) => {
    state.overviewSelected = true;
    state.settingsSelected = false;
  })
  .onAction("showSettings", ({ state }) => {
    state.overviewSelected = false;
    state.settingsSelected = true;
  })
  .onAction("nextFruit", ({ state }) => {
    const index = FRUITS.findIndex((f) => f.id === state.activeFruit);
    const next = FRUITS[(index + 1) % FRUITS.length];
    state.activeFruit = next.id;
    state.activeFruitName = next.name;
  })
  .onAction("openDialog", ({ state }) => {
    state.dialogOpen = true;
  })
  .onAction("closeDialog", ({ state }) => {
    state.dialogOpen = false;
  })
  .build();
