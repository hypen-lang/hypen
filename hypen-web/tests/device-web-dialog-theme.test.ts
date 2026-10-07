/**
 * The host dialogs' styling hooks: one stylesheet per document, stable class
 * names, and the `theme` option mapped onto `--hypen-device-*` properties.
 */
import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { CaptureDialog, ConsentDialog } from "../packages/device-web/src/ui";

function doc() {
  return new JSDOM("<!doctype html><html><head></head><body></body></html>").window.document;
}

describe("device dialog theming", () => {
  test("installs one stylesheet and themes the consent dialog", () => {
    const d = doc();
    const dialog = new ConsentDialog(d.body, 0, { accent: "#e11d48", radius: "8px", colorScheme: "dark" });
    void dialog.present("https://app.example", "choose a photo", ["image/*"], { accept: "image/*", multiple: false });
    void new ConsentDialog(d.body, 0).present("https://app.example", "save a file");

    expect(d.querySelectorAll("style[data-hypen-device-styles]").length).toBe(1);
    const root = d.querySelector<HTMLElement>("[data-hypen-device-dialog]")!;
    expect(root.style.getPropertyValue("--hypen-device-accent")).toBe("#e11d48");
    expect(root.style.getPropertyValue("--hypen-device-radius")).toBe("8px");
    expect(root.getAttribute("data-hypen-device-scheme")).toBe("dark");
    expect(root.style.position).toBe("fixed");
    expect(root.querySelector(".hypen-device-origin")!.textContent).toBe("https://app.example");
    expect(root.querySelector('[data-hypen-device="continue"]')!.className).toContain("hypen-device-btn-primary");
    dialog.dismiss();
  });

  test("the drop zone reports its arming state as data-state", async () => {
    const d = doc();
    const dialog = new ConsentDialog(d.body, 10);
    void dialog.present("https://app.example", "choose a file", [], { accept: "", multiple: true });
    const zone = d.querySelector('[data-hypen-device="drop-zone"]')!;
    expect(zone.getAttribute("data-state")).toBe("disarmed");
    await new Promise((r) => setTimeout(r, 30));
    expect(zone.getAttribute("data-state")).toBe("armed");
    dialog.dismiss();
  });

  test("the capture dialog takes the same theme", () => {
    const d = doc();
    const capture = new CaptureDialog(d.body, "https://app.example", "photo", 0, () => {}, { accent: "#16a34a" });
    expect(capture.root.style.getPropertyValue("--hypen-device-accent")).toBe("#16a34a");
    expect(capture.video.className).toBe("hypen-device-preview");
    capture.close();
  });
});
