/**
 * @hypen-space/device-fake — the explicit fake DeviceHost as its own package
 * (RFC 001 §1 pillar 11): separate package, production guard, `simulated`
 * marking on every terminal response, and a visible banner.
 */

import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import * as core from "@hypen-space/core/remote/device";
import type { DeviceEvent, DeviceRequest, DeviceResponse } from "@hypen-space/core/remote/device";
import {
  BANNER_ATTRIBUTE,
  FakeDeviceHost,
  hideBanner,
  showBanner,
} from "@hypen-space/device-fake";

function request(capability: string, params: Record<string, unknown>, id = 1): DeviceRequest {
  return {
    type: "deviceRequest",
    id,
    capability,
    version: 1,
    owner: { moduleInstanceId: "m", activationId: 1 },
    lifetime: "activation",
    timeoutMs: 5_000,
    // Only binary-upload revisions accept credit; others require 0 (§2.3).
    initialCredit: capability === "gallery.pick" ? 1024 * 1024 : 0,
    params,
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("@hypen-space/device-fake", () => {
  test("core no longer exports the fake host", () => {
    expect("FakeDeviceHost" in core).toBe(false);
  });

  test("refuses to initialize under NODE_ENV=production", () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(() => new FakeDeviceHost()).toThrow(/production/);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  test("every terminal response is marked simulated; events are not", async () => {
    const sent: Array<DeviceResponse | DeviceEvent> = [];
    const frames: Uint8Array[] = [];
    const client = new FakeDeviceHost()
      .galleryReturns(new TextEncoder().encode("fake-photo"), "image/png")
      .permissionReturns("denied")
      .client({ sendMessage: (m) => sent.push(m), sendBinary: (f) => frames.push(f) });

    client.handleMessage(request("gallery.pick", { mediaTypes: ["photo"], maxCount: 1 }, 1));
    client.handleMessage(request("permission.request", { permission: "camera" }, 2));
    client.handleMessage(request("bluetooth.scan", {}, 3)); // unscripted → unsupported
    await settle();

    const responses = sent.filter((m): m is DeviceResponse => m.type === "deviceResponse");
    expect(responses.length).toBe(3);
    for (const r of responses) expect(r.simulated).toBe(true);
    expect(responses.find((r) => r.id === 2)?.error?.code).toBe("denied");
    expect(responses.find((r) => r.id === 3)?.error?.code).toBe("unsupported");
    const pick = responses.find((r) => r.id === 1)!;
    expect((pick.result as { items: Array<{ bytes: number }> }).items[0]!.bytes).toBe(10);
    for (const e of sent.filter((m) => m.type === "deviceEvent")) {
      expect("simulated" in e).toBe(false);
    }
    expect(frames.length).toBe(1);
  });

  test("showBanner mounts one fixed 'Simulated device' banner per document", () => {
    const dom = new JSDOM("<!doctype html><html><body></body></html>");
    const doc = dom.window.document as unknown as Document;
    const banner = showBanner(doc)!;
    expect(banner).not.toBeNull();
    expect(banner.hasAttribute(BANNER_ATTRIBUTE)).toBe(true);
    expect(banner.textContent).toContain("Simulated device");
    expect(banner.style.position).toBe("fixed");
    expect(banner.getAttribute("role")).toBe("status");
    expect(showBanner(doc)).toBe(banner); // idempotent
    expect(doc.querySelectorAll(`[${BANNER_ATTRIBUTE}]`).length).toBe(1);
    hideBanner(doc);
    expect(doc.querySelector(`[${BANNER_ATTRIBUTE}]`)).toBeNull();
    dom.window.close();
  });

  test("showBanner is a no-op without a DOM", () => {
    const g = globalThis as { document?: unknown };
    const prev = g.document;
    delete g.document;
    try {
      expect(showBanner()).toBeNull();
    } finally {
      if (prev !== undefined) g.document = prev;
    }
  });

  test("client() and endpoint() mount the banner automatically when a DOM exists", () => {
    const dom = new JSDOM("<!doctype html><html><body></body></html>");
    const g = globalThis as { document?: unknown };
    const prev = g.document;
    g.document = dom.window.document;
    try {
      const doc = dom.window.document;
      new FakeDeviceHost().client({ sendMessage() {}, sendBinary() {} });
      expect(doc.querySelectorAll(`[${BANNER_ATTRIBUTE}]`).length).toBe(1);
      hideBanner(doc as unknown as Document);

      const endpoint = new FakeDeviceHost().galleryReturns(new Uint8Array(1)).endpoint();
      // The mandatory connection-owned control stream is always advertised.
      expect(endpoint.advertisement.capabilities).toEqual([
        { name: "core.capabilities", versions: [1] },
        { name: "gallery.pick", versions: [1] },
      ]);
      expect(doc.querySelector(`[${BANNER_ATTRIBUTE}]`)).toBeNull();
      endpoint.attach({ sendMessage() {}, sendBinary() {} });
      expect(doc.querySelectorAll(`[${BANNER_ATTRIBUTE}]`).length).toBe(1);
      endpoint.detach();
    } finally {
      if (prev === undefined) delete g.document;
      else g.document = prev;
      dom.window.close();
    }
  });
});
