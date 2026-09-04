/**
 * The benchmark contract.
 *
 * Both apps render one toolbar button per entry here, labelled with its
 * `id` via `aria-label`, so the driver can address them with the identical
 * selector `[aria-label="<id>"]` regardless of framework. Everything the
 * driver needs to know about a scenario — what to click, what has to be true
 * before it runs, how many times to repeat it — lives in this one file.
 */

export interface Scenario {
  /** Stable id; doubles as the button's aria-label and the results key. */
  id: string;
  /** Toolbar button caption. */
  caption: string;
  /** Human-readable description for the report. */
  description: string;
  /** Buttons to click (and settle) before each measured run. */
  setup?: string[];
  /** Measured repetitions (after `warmup` unmeasured ones). */
  repeat: number;
  warmup: number;
}

export const SCENARIOS: Scenario[] = [
  {
    id: "create-1k",
    caption: "Create 1k",
    description: "Render 1,000 rows (17,000 elements) into an empty list",
    setup: ["clear"],
    repeat: 5,
    warmup: 1,
  },
  {
    id: "replace-1k",
    caption: "Replace 1k",
    description: "Replace all 1,000 rows with 1,000 freshly generated ones",
    setup: ["create-1k"],
    repeat: 3,
    warmup: 1,
  },
  {
    id: "append-1k",
    caption: "Append 1k",
    description: "Append 1,000 rows to an existing 1,000-row list",
    setup: ["clear", "create-1k"],
    repeat: 2,
    warmup: 1,
  },
  {
    id: "update-10th",
    caption: "Update every 10th",
    description: "Mutate the name of every 10th row of 1,000 (100 text updates)",
    setup: ["clear", "create-1k"],
    repeat: 4,
    warmup: 1,
  },
  {
    id: "update-all",
    caption: "Update all",
    description:
      "Mutate the name of every one of 1,000 rows — a state change that " +
      "touches every row but adds and removes nothing",
    setup: ["clear", "create-1k"],
    repeat: 4,
    warmup: 1,
  },
  {
    id: "select-row",
    caption: "Select row",
    description: "Toggle the highlight on a single row out of 1,000",
    setup: ["clear", "create-1k"],
    repeat: 4,
    warmup: 1,
  },
  {
    id: "swap-rows",
    caption: "Swap rows",
    description: "Swap row 1 and row 998 of a 1,000-row list",
    setup: ["clear", "create-1k"],
    repeat: 4,
    warmup: 1,
  },
  {
    id: "remove-row",
    caption: "Remove row",
    description: "Remove one row from a 1,000-row list",
    setup: ["clear", "create-1k"],
    repeat: 4,
    warmup: 1,
  },
  {
    id: "clear",
    caption: "Clear",
    description: "Remove all 1,000 rows",
    setup: ["clear", "create-1k"],
    repeat: 4,
    warmup: 1,
  },
];

/** Rows rendered by the parity check (small enough to diff every node). */
export const PARITY_ROWS = 50;

/**
 * Extra control that isn't a measured scenario: renders exactly
 * `PARITY_ROWS` rows so the parity checker can diff every node.
 */
export const PARITY_CONTROL = { id: "parity", caption: `Parity ${PARITY_ROWS}` };

/**
 * Not a measured scenario either: a single, capped 10,000-row render used to
 * probe how each runtime scales past the 1,000-row list. It is run once per
 * app with a hard time limit rather than repeated, because a runtime that
 * needs minutes for it would otherwise dominate the whole suite's runtime.
 */
export const SCALING_CONTROL = {
  id: "create-10k",
  caption: "Create 10k",
  rows: 10000,
  capMs: 180000,
};

/** Every control the apps must expose, including ones used only as setup. */
export const CONTROL_IDS = Array.from(
  new Set([
    ...SCENARIOS.flatMap((s) => [s.id, ...(s.setup ?? [])]),
    SCALING_CONTROL.id,
    PARITY_CONTROL.id,
  ]),
);

/**
 * Toolbar buttons, in render order. Both apps iterate this list, so the
 * button count, order and captions are identical by construction.
 */
export const CONTROLS: { id: string; caption: string }[] = [
  ...SCENARIOS.map((s) => ({ id: s.id, caption: s.caption })),
  { id: SCALING_CONTROL.id, caption: SCALING_CONTROL.caption },
  PARITY_CONTROL,
];

/**
 * DSL action identifier for each control.
 *
 * Not just `camelCase(id)`: the Hypen parser rejects digits inside an
 * `@actions.<name>` reference — `@actions.create1k` fails with
 * `unexpected '{'` pointing at the enclosing module's brace — so the numbers
 * are spelled out. The kebab `id` is still what the driver clicks; only the
 * action identifier differs.
 */
export const ACTION_OF: Record<string, string> = {
  "create-1k": "createOneK",
  "create-10k": "createTenK",
  "replace-1k": "replaceOneK",
  "append-1k": "appendOneK",
  "update-10th": "updateEveryTenth",
  "update-all": "updateAll",
  "select-row": "selectRow",
  "swap-rows": "swapRows",
  "remove-row": "removeRow",
  clear: "clear",
  parity: "parity",
};

/** Scenario metadata by id, for the report. */
export const BY_ID: Record<string, Scenario> = Object.fromEntries(
  SCENARIOS.map((s) => [s.id, s]),
);

/** Elements the app renders per row — asserted by the parity checker. */
export const ELEMENTS_PER_ROW = 17;
