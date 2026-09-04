import { describe, expect, test } from "bun:test";
import { buildLauncherTemplate } from "./src/launcher";

describe("home screen layout", () => {
  test("centers the clock and weather card explicitly", () => {
    const template = buildLauncherTemplate();
    const widget = template.slice(
      template.indexOf("// ----- Clock + weather widget -----"),
      template.indexOf("// ----- App grid -----"),
    );

    expect(widget).toContain('.alignSelf("center")');
  });
});
