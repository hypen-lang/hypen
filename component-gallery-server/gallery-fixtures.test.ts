import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { galleryFixture, galleryFixtureContentType, galleryFixtureNames } from "./gallery-fixtures";

describe("gallery fixtures", () => {
  test("contains deterministic image and audio media", () => {
    expect(galleryFixtureNames()).toEqual([
      "avatar-1.png", "avatar-2.png", "avatar-3.png", "avatar-4.png", "avatar-5.png",
      "avatar-6.png", "avatar-7.png", "avatar-8.png", "avatar-9.png", "blur.png",
      "rounded-image-1.png", "rounded-image-2.png", "rounded-image-3.png",
      "grid-1.png", "grid-2.png", "grid-3.png", "grid-4.png", "grid-5.png", "grid-6.png",
      "card.png", "image-200x150.png", "image-square-1.png", "image-square-2.png",
      "image-square-3.png", "image-300x200.png", "image-120x80-1.png",
      "image-120x80-2.png", "sample.wav",
    ]);
    for (const name of galleryFixtureNames().filter(name => name.endsWith(".png"))) {
      expect([...galleryFixture(name)!.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      expect(galleryFixtureContentType(name)).toBe("image/png");
    }
    expect(new TextDecoder().decode(galleryFixture("sample.wav")!.subarray(0, 4))).toBe("RIFF");
    expect(galleryFixtureContentType("sample.wav")).toBe("audio/wav");
    const wav = galleryFixture("sample.wav")!;
    const wavView = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(new TextDecoder().decode(wav.subarray(8, 12))).toBe("WAVE");
    expect(wavView.getUint32(24, true)).toBe(8_000);
    expect(wavView.getUint32(40, true)).toBe(16_000); // one second, mono 16-bit PCM
  });

  test("generates stable bytes", () => {
    expect(createHash("sha256").update(galleryFixture("avatar-1.png")!).digest("hex"))
      .toBe("4865d0a912caa4bb450555eec416f1dc2700493bef7f6187c6856b9efed9323a");
    expect(createHash("sha256").update(galleryFixture("blur.png")!).digest("hex"))
      .toBe("4e8385c762a36f53b6b0c77fb50e23e06486ed602ab825ca5207d43cc5be95d7");
    expect(createHash("sha256").update(galleryFixture("rounded-image-1.png")!).digest("hex"))
      .toBe("e3cf068bdbdf1035d5d788f0ffc7595597870682232ca6f2ea36e7e852bcfb43");
    expect(createHash("sha256").update(galleryFixture("grid-6.png")!).digest("hex"))
      .toBe("88b326e277878f848c6a4eed70a5facd98af5d6eb12b63fcb8a845a9b344ef40");
    expect(createHash("sha256").update(galleryFixture("card.png")!).digest("hex"))
      .toBe("b852504a90f31c9fe4f34ce36cd423f0db3f77d2fdb1cd3d428745d8d737a277");
    expect(createHash("sha256").update(galleryFixture("sample.wav")!).digest("hex"))
      .toBe("1524a1310ffec88cfe18aea6a0830cf53fa2212fa40849ce990f48bc591c1b23");
  });
});
