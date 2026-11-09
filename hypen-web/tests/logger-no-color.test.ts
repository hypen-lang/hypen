/**
 * The framework logger honours NO_COLOR (https://no-color.org): "[Remote]"
 * (and every other tag) prints without ANSI escapes when it is set.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { configureLogger, frameworkLoggers } from "../packages/core/src/logger";

const ESC = "\x1b[";
const saved = process.env.NO_COLOR;

afterEach(() => {
  if (saved === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = saved;
  configureLogger({ colors: true });
});

function captureWarnTag(): string {
  const spy = spyOn(console, "warn").mockImplementation(() => {});
  try {
    frameworkLoggers.remote.warn("hello");
    return String(spy.mock.calls[0]?.[0]);
  } finally {
    spy.mockRestore();
  }
}

describe("logger NO_COLOR", () => {
  test("colored tag by default", () => {
    delete process.env.NO_COLOR;
    configureLogger({ colors: true });
    const tag = captureWarnTag();
    expect(tag).toContain(ESC);
    expect(tag).toContain("[Remote]");
  });

  test("NO_COLOR strips the ANSI color from the tag", () => {
    process.env.NO_COLOR = "1";
    configureLogger({ colors: true });
    expect(captureWarnTag()).toBe("[Remote]");
  });

  test("an empty NO_COLOR does not disable colors", () => {
    process.env.NO_COLOR = "";
    configureLogger({ colors: true });
    expect(captureWarnTag()).toContain(ESC);
  });
});
