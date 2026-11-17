/**
 * The one way `hypen add` / `hypen remove` talk to a person. Commands print
 * and ask through a `Prompter`, so the consent flow is the same code whether
 * a terminal, a test or a recorded transcript is on the other end — and so a
 * non-interactive run can never be "answered" by accident: `interactive` is
 * false and the command must have its decisions as flags.
 */

import { createInterface } from "readline";

export interface Prompter {
  /** A person can answer questions (stdin is a TTY). */
  readonly interactive: boolean;
  /** Print one line. */
  say(line: string): void;
  /** Ask and wait for a line of input. Only called when `interactive`. */
  ask(question: string): Promise<string>;
  close(): void;
}

/** The terminal: interactive when stdin is a TTY. */
export function terminalPrompter(): Prompter {
  let rl: ReturnType<typeof createInterface> | null = null;
  return {
    interactive: process.stdin.isTTY === true,
    say: (line) => console.log(line),
    ask(question) {
      rl ??= createInterface({ input: process.stdin, output: process.stdout });
      const reader = rl;
      return new Promise((resolve) => reader.question(question, (answer) => resolve(answer)));
    },
    close() {
      rl?.close();
      rl = null;
    },
  };
}

/**
 * A prompter that answers from a script and records everything shown —
 * the screen a person would have seen, in order. For tests and transcripts.
 * Running out of answers is an error, not a silent default.
 */
export function scriptedPrompter(answers: readonly string[], interactive = true): Prompter & { screen: string[] } {
  const queue = [...answers];
  const screen: string[] = [];
  return {
    interactive,
    screen,
    say: (line) => void screen.push(line),
    ask(question) {
      const answer = queue.shift();
      if (answer === undefined) throw new Error(`scriptedPrompter: no answer left for: ${question}`);
      screen.push(`${question}${answer}`);
      return Promise.resolve(answer);
    },
    close() {},
  };
}
