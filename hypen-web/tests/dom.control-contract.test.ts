import { describe, expect, test } from "bun:test";
import { audioHandler } from "../packages/web/src/dom/components/audio";
import { checkboxHandler } from "../packages/web/src/dom/components/checkbox";
import { switchHandler } from "../packages/web/src/dom/components/switch";
import { ensureFakeDomGlobals, FakeElement } from "./fake-dom";

ensureFakeDomGlobals();

describe("DOM control defaults", () => {
  test("Audio shows controls by default and honors an explicit false", () => {
    const audio = audioHandler.create() as HTMLAudioElement;
    expect(audio.controls).toBe(true);

    audioHandler.applyProps!(audio, { controls: false });
    expect(audio.controls).toBe(false);
  });

  test("Checkbox uses a margin-free 20px visual footprint", () => {
    const wrapper = checkboxHandler.create() as unknown as FakeElement;
    const input = wrapper.children[0] as unknown as FakeElement;

    expect(input.style.width).toBe("20px");
    expect(input.style.height).toBe("20px");
    expect(input.style.margin).toBe("0");
    expect(input.style.flexShrink).toBe("0");
    expect(wrapper.style.minHeight).toBe("20px");
  });

  test("Switch checked styling is not blocked by an inline track color", () => {
    const wrapper = switchHandler.create() as unknown as FakeElement;
    const input = wrapper.children[1] as unknown as FakeElement;
    const style = wrapper.children[0] as unknown as FakeElement;

    expect(input.style.backgroundColor).toBeUndefined();
    expect(style.textContent).toContain(':checked');
    expect(style.textContent).toContain('background-color: #4CAF50');
  });
});
