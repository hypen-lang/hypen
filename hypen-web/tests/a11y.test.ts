import { describe, expect, test, mock, afterEach } from "bun:test";
import {
  logA11yDiagnostics,
  type A11yDiagnostic,
} from "../packages/core/src/a11y";

describe("logA11yDiagnostics", () => {
  const originalWarn = console.warn;

  afterEach(() => {
    console.warn = originalWarn;
  });

  test("formats each finding as a11y[<rule>] <elementType>: <message>", () => {
    const diags: A11yDiagnostic[] = [
      {
        rule: "icon-only-control",
        elementType: "Button",
        message: "icon-only control needs an accessible label",
      },
      {
        rule: "missing-alt",
        elementType: "Image",
        message: "image is missing alt text",
      },
    ];

    const warn = mock(() => {});
    console.warn = warn;

    const lines = logA11yDiagnostics(diags);

    expect(lines).toEqual([
      "a11y[icon-only-control] Button: icon-only control needs an accessible label",
      "a11y[missing-alt] Image: image is missing alt text",
    ]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]?.[0]).toBe(lines[0]);
    expect(warn.mock.calls[1]?.[0]).toBe(lines[1]);
  });

  test("returns an empty array and warns nothing for no findings", () => {
    const warn = mock(() => {});
    console.warn = warn;

    expect(logA11yDiagnostics([])).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });
});
