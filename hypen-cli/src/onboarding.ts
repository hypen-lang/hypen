/**
 * First-run onboarding.
 *
 * The very first time someone runs the CLI on a machine — whether they
 * installed it globally, ran it through `bunx @hypen-space/cli`, or
 * teleported a session — we walk them through a short, paged tour that
 * explains what Hypen is and the handful of commands they'll use day to
 * day (`dev`, `studio`, `test`). It's a "press Enter to continue" flow
 * rendered as branded cards.
 *
 * Everything here is TTY-aware and opt-out friendly:
 *   - skipped entirely when stdin/stdout isn't a TTY (CI, pipes, teleport
 *     web sessions) so automated flows never block on a keypress;
 *   - skipped when `HYPEN_NO_ONBOARDING` is set or `CI` is truthy;
 *   - shown exactly once — a marker is written to `~/.hypen/onboarding.json`
 *     after the tour completes (or is skipped) so we never nag again;
 *   - forceable with `HYPEN_FORCE_ONBOARDING=1` for replays/testing.
 */

import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { pink, yellow, dim, boldPink } from "./colors.js";
import { renderBanner } from "./banner.js";

/** Location of the "you've seen onboarding" marker. */
export function getOnboardingMarkerPath(): string {
  // Honour $HOME/%USERPROFILE% over the cached os.homedir() so the path
  // tracks an overridden environment (and stays testable).
  const home =
    process.env.HOME || process.env.USERPROFILE || homedir();
  return join(home, ".hypen", "onboarding.json");
}

/** Whether the onboarding tour has already been completed on this machine. */
export function hasSeenOnboarding(): boolean {
  try {
    return existsSync(getOnboardingMarkerPath());
  } catch {
    return false;
  }
}

/** Record that the tour has been shown so we don't display it again. */
export function markOnboardingSeen(version: string): void {
  try {
    const markerPath = getOnboardingMarkerPath();
    mkdirSync(dirname(markerPath), { recursive: true });
    writeFileSync(
      markerPath,
      JSON.stringify({ version, seenAt: new Date().toISOString() }, null, 2)
    );
  } catch {
    // A missing marker just means we might show the tour again next time —
    // not worth failing the command over.
  }
}

/**
 * Decide whether the tour should run for this invocation. Pure (no I/O
 * side effects beyond reading the marker) so it's cheap to call on every
 * command.
 */
export function shouldRunOnboarding(): boolean {
  if (process.env.HYPEN_FORCE_ONBOARDING === "1") return true;
  if (process.env.HYPEN_NO_ONBOARDING) return false;
  if (process.env.CI) return false;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  return !hasSeenOnboarding();
}

// ── Card rendering ──────────────────────────────────────────────────────

const INDENT = "  ";
/** Total inner width of the card, including one space of padding each side. */
const CARD_WIDTH = 56;
/** Usable text width inside the card. */
const TEXT_WIDTH = CARD_WIDTH - 2;

const ANSI = /\x1b\[[0-9;]*m/g;

/** Visible length of a string, ignoring ANSI colour escapes. */
function visibleLength(s: string): number {
  return s.replace(ANSI, "").length;
}

/** Right-pad a (possibly coloured) string to `width` visible columns. */
function padVisible(s: string, width: number): string {
  const pad = width - visibleLength(s);
  return pad > 0 ? s + " ".repeat(pad) : s;
}

interface Page {
  /** Card heading, rendered bold pink. */
  title: string;
  /** Body lines, pre-laid-out to fit within TEXT_WIDTH visible columns. */
  body: string[];
}

/** Format a `name  description` row for the command list on page one. */
function cmdRow(name: string, desc: string): string {
  return `${pink(name.padEnd(9))}${dim(desc)}`;
}

const PAGES: Page[] = [
  {
    title: "Welcome to Hypen",
    body: [
      "A declarative UI language + runtime for building",
      "cross-platform apps from a single codebase —",
      "web, iOS, and Android.",
      "",
      dim("The hypen CLI is your control center:"),
      "",
      cmdRow("init", "scaffold a new project"),
      cmdRow("dev", "run locally with hot reload"),
      cmdRow("studio", "open the visual IDE"),
      cmdRow("test", "preview across real devices"),
      cmdRow("build", "bundle for production"),
    ],
  },
  {
    title: "Run it  ·  hypen dev",
    body: [
      "Start the dev server with hot reload:",
      "",
      `  ${dim("$")} ${yellow("hypen dev")}`,
      "",
      "Edit any .hypen template or module file and",
      "the browser updates instantly — no refresh,",
      "with state preserved where possible.",
    ],
  },
  {
    title: "Design it  ·  hypen studio",
    body: [
      "Open Hypen Studio, a local visual IDE:",
      "",
      `  ${dim("$")} ${yellow("hypen studio")}`,
      "",
      "Browse your components, preview them live,",
      "and tweak the UI side by side with your code.",
    ],
  },
  {
    title: "Test it  ·  hypen test",
    body: [
      "Open Studio in Test Mode:",
      "",
      `  ${dim("$")} ${yellow("hypen test")}`,
      "",
      "Live previews across every surface, plus",
      "mirror to real iOS / Android devices to see",
      "how your app behaves out in the wild.",
    ],
  },
  {
    title: "Teach your AI  ·  skills",
    body: [
      "Hypen ships skill files that teach AI coding",
      "agents the Hypen DSL — so they write idiomatic",
      "components from day one.",
      "",
      `${pink("hypen init")}${dim(" offers to install them into:")}`,
      "",
      `  ${yellow(".claude/skills/hypen-ui.md")}  ${dim("(Claude Code)")}`,
      `  ${yellow(".agent/skills/hypen-ui.md")}   ${dim("(other agents)")}`,
    ],
  },
  {
    title: "You're all set",
    body: [
      "Create your first project:",
      "",
      `  ${dim("$")} ${yellow("hypen init")} ${yellow("my-app")}`,
      `  ${dim("$")} cd my-app`,
      `  ${dim("$")} ${yellow("hypen dev")}`,
      "",
      `Docs  ${pink("https://hypen.space/docs")}`,
    ],
  },
];

/** Render one card (no progress footer) to a string. */
function renderCard(page: Page): string {
  const top = INDENT + pink("╭" + "─".repeat(CARD_WIDTH) + "╮");
  const bottom = INDENT + pink("╰" + "─".repeat(CARD_WIDTH) + "╯");
  const blank = INDENT + pink("│") + " ".repeat(CARD_WIDTH) + pink("│");

  const line = (content: string) =>
    INDENT + pink("│") + " " + padVisible(content, TEXT_WIDTH) + " " + pink("│");

  const rows = [
    top,
    blank,
    line(boldPink(page.title)),
    blank,
    ...page.body.map(line),
    blank,
    bottom,
  ];
  return rows.join("\n");
}

/** Progress dots + key hint shown beneath the card. */
function renderFooter(current: number, total: number): string {
  const dots = Array.from({ length: total }, (_, i) =>
    i <= current ? pink("●") : dim("○")
  ).join(" ");
  const isLast = current === total - 1;
  const hint = isLast
    ? dim("Press Enter to finish")
    : dim("Press Enter to continue") + dim("  ·  ") + dim("q to skip");
  return `${INDENT}${dots}   ${hint}`;
}

function clearScreen(): void {
  // Clear the visible screen and home the cursor. Deliberately *not*
  // clearing the scrollback (no \x1b[3J) so we don't wipe the user's
  // terminal history out from under them.
  process.stdout.write("\x1b[2J\x1b[H");
}

/**
 * Read a single keypress in raw mode. Resolves with the raw string for the
 * key. Restores the terminal's previous raw state afterwards so later
 * readline-based prompts (e.g. `hypen init`) behave normally.
 */
function readKey(): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw ?? false;
    stdin.setRawMode?.(true);
    stdin.resume();
    const onData = (data: Buffer) => {
      stdin.removeListener("data", onData);
      stdin.setRawMode?.(wasRaw);
      stdin.pause();
      resolve(data.toString());
    };
    stdin.on("data", onData);
  });
}

/**
 * Render the paged tour. Advances on any key (Enter included); `q`/`Esc`
 * skip the rest; Ctrl+C exits the process the way users expect.
 */
export async function runOnboarding(version: string): Promise<void> {
  for (let i = 0; i < PAGES.length; i++) {
    clearScreen();
    console.log(renderBanner(version));
    console.log(renderCard(PAGES[i]!));
    console.log("");
    console.log(renderFooter(i, PAGES.length));

    const key = await readKey();
    if (key === "\x03") {
      // Ctrl+C — bail out the same way any interrupted CLI would.
      process.exit(0);
    }
    if (key === "q" || key === "Q" || key === "\x1b") {
      // Skip the remainder of the tour.
      break;
    }
  }
  clearScreen();
}

/**
 * Run the tour once, if appropriate, then mark it seen. Safe to call
 * unconditionally at startup — it no-ops outside a fresh interactive run.
 */
export async function maybeRunOnboarding(version: string): Promise<void> {
  if (!shouldRunOnboarding()) return;
  try {
    await runOnboarding(version);
  } finally {
    // Mark seen even on skip so we don't pester the user again.
    markOnboardingSeen(version);
  }
}
