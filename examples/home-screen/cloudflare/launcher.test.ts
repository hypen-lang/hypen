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

  test("scales each app tile by seven percent while hovered", () => {
    const template = buildLauncherTemplate();

    expect(template).toContain(".scale(\"@{state.hoveredIcon == 'grid:/app/todo' ? 1.07 : 1}\")");
    expect(template).toContain(".scale(\"@{state.hoveredIcon == 'dock:/app/todo' ? 1.07 : 1}\")");
    expect(template).toContain(".transition(duration: 150, curve: easeOut, props: [scale])");
    expect(template).toContain('.onHover(@actions.iconHover, icon: "grid:/app/todo", hovered: true)');
    expect(template).toContain('.onMouseLeave(@actions.iconHover, icon: "grid:/app/todo", hovered: false)');
  });
});
