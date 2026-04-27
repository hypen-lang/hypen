/**
 * Hypen CLI colors — ANSI 24-bit (truecolor) escape codes.
 *
 * Brand palette:
 *   Pink   #FFA7E1  rgb(255, 167, 225)
 *   Yellow #FFECA7  rgb(255, 236, 167)
 */

const enabled =
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== "dumb" &&
  !!process.stdout.isTTY;

function rgb(r: number, g: number, b: number) {
  return (text: string) =>
    enabled ? `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m` : text;
}

export const pink = rgb(255, 167, 225);
export const yellow = rgb(255, 236, 167);
export const dim = (text: string) => (enabled ? `\x1b[2m${text}\x1b[0m` : text);
export const bold = (text: string) => (enabled ? `\x1b[1m${text}\x1b[0m` : text);
export const boldPink = (text: string) => (enabled ? `\x1b[1;38;2;255;167;225m${text}\x1b[0m` : text);
export const boldYellow = (text: string) => (enabled ? `\x1b[1;38;2;255;236;167m${text}\x1b[0m` : text);
