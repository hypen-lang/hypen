import { deflateSync } from "node:zlib";

const AVATAR_PALETTES = [
  [0x25, 0x63, 0xeb, 0xbf, 0xdb, 0xfe],
  [0x7c, 0x3a, 0xed, 0xdd, 0xd6, 0xfe],
  [0x0f, 0x76, 0x6e, 0x99, 0xf6, 0xe4],
  [0xbe, 0x12, 0x3c, 0xfe, 0xcd, 0xd3],
  [0xb4, 0x53, 0x09, 0xfe, 0xf3, 0xc7],
  [0x1d, 0x4e, 0xd8, 0xdb, 0xea, 0xfe],
  [0x9f, 0x12, 0x3f, 0xff, 0xe4, 0xe6],
  [0x04, 0x78, 0x57, 0xd1, 0xfa, 0xe5],
  [0x6d, 0x28, 0xd9, 0xed, 0xe9, 0xfe],
] as const;

function crc32(input: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const output = new Uint8Array(12 + data.length);
  const view = new DataView(output.buffer);
  view.setUint32(0, data.length);
  output.set(typeBytes, 4);
  output.set(data, 8);
  view.setUint32(8 + data.length, crc32(output.subarray(4, 8 + data.length)));
  return output;
}

function encodePng(width: number, height: number, pixels: Uint8Array): Uint8Array {
  const scanlines = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 4);
    scanlines[row] = 0;
    scanlines.set(pixels.subarray(y * width * 4, (y + 1) * width * 4), row + 1);
  }

  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width);
  headerView.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8); // RGBA, 8-bit, no interlace

  const parts = [
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(scanlines)),
    chunk("IEND", new Uint8Array()),
  ];
  const size = parts.reduce((total, part) => total + part.length, 0);
  const png = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

function setPixel(
  pixels: Uint8Array,
  width: number,
  x: number,
  y: number,
  color: readonly number[],
): void {
  const offset = (y * width + x) * 4;
  pixels[offset] = color[0];
  pixels[offset + 1] = color[1];
  pixels[offset + 2] = color[2];
  pixels[offset + 3] = 255;
}

function avatarFixture(index: number): Uint8Array {
  const width = 128;
  const height = 128;
  const palette = AVATAR_PALETTES[(index - 1) % AVATAR_PALETTES.length];
  const background = palette.slice(0, 3);
  const foreground = palette.slice(3, 6);
  const pixels = new Uint8Array(width * height * 4);
  const headX = 64 + ((index % 3) - 1) * 4;
  const headY = 45 + (index % 2) * 3;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const head = (x - headX) ** 2 + (y - headY) ** 2 <= 24 ** 2;
      const shoulders = ((x - 64) / 48) ** 2 + ((y - 124) / 50) ** 2 <= 1;
      setPixel(pixels, width, x, y, head || shoulders ? foreground : background);
    }
  }
  return encodePng(width, height, pixels);
}

function blurFixture(): Uint8Array {
  const width = 128;
  const height = 128;
  const pixels = new Uint8Array(width * height * 4);
  const colors = [
    [0x25, 0x63, 0xeb],
    [0xec, 0x48, 0x99],
    [0xf5, 0x9e, 0x0b],
    [0x10, 0xb9, 0x81],
  ] as const;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const tile = (Math.floor(x / 24) + Math.floor(y / 24)) % colors.length;
      const ring = (x - 64) ** 2 + (y - 64) ** 2 < 29 ** 2;
      setPixel(pixels, width, x, y, ring ? [255, 255, 255] : colors[tile]);
    }
  }
  return encodePng(width, height, pixels);
}

function roundedImageFixture(index: number): Uint8Array {
  const width = 96;
  const height = 96;
  const pixels = new Uint8Array(width * height * 4);
  const palettes = [
    [[0x1d, 0x4e, 0xd8], [0x93, 0xc5, 0xfd], [0xff, 0xff, 0xff]],
    [[0x9f, 0x12, 0x3f], [0xfb, 0x71, 0x85], [0xff, 0xe4, 0xe6]],
    [[0x04, 0x78, 0x57], [0x34, 0xd3, 0x99], [0xd1, 0xfa, 0xe5]],
  ] as const;
  const palette = palettes[(index - 1) % palettes.length];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const diagonal = Math.floor((x + y + index * 9) / 18) % 2;
      const center = (x - 48) ** 2 + (y - 48) ** 2 < (14 + index * 3) ** 2;
      setPixel(pixels, width, x, y, center ? palette[2] : palette[diagonal]);
    }
  }
  return encodePng(width, height, pixels);
}

function cardImageFixture(): Uint8Array {
  const width = 300;
  const height = 150;
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sky = y < 88;
      const stripe = Math.floor((x + y) / 28) % 2 === 0;
      const sun = (x - 236) ** 2 + (y - 38) ** 2 < 20 ** 2;
      const color = sun
        ? [0xfe, 0xf3, 0xc7]
        : sky
          ? (stripe ? [0x1d, 0x4e, 0xd8] : [0x25, 0x63, 0xeb])
          : (stripe ? [0x04, 0x78, 0x57] : [0x05, 0x96, 0x69]);
      setPixel(pixels, width, x, y, color);
    }
  }
  return encodePng(width, height, pixels);
}

function galleryImageFixture(width: number, height: number, index: number): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  const palettes = [
    [[0x1d, 0x4e, 0xd8], [0x60, 0xa5, 0xfa]],
    [[0x04, 0x78, 0x57], [0x34, 0xd3, 0x99]],
    [[0x9f, 0x12, 0x3f], [0xfb, 0x71, 0x85]],
    [[0x7c, 0x2d, 0x12], [0xfb, 0x92, 0x3c]],
  ] as const;
  const palette = palettes[index % palettes.length];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const diagonal = Math.floor((x + y + index * 11) / 24) % 2;
      const highlight = (x - width * 0.7) ** 2 + (y - height * 0.3) ** 2 < Math.min(width, height) ** 2 * 0.035;
      setPixel(pixels, width, x, y, highlight ? [0xff, 0xf7, 0xed] : palette[diagonal]);
    }
  }
  return encodePng(width, height, pixels);
}

/** One second of deterministic mono PCM audio in a broadly supported WAV container. */
function audioFixture(): Uint8Array {
  const sampleRate = 8_000;
  const sampleCount = sampleRate;
  const bytesPerSample = 2;
  const dataSize = sampleCount * bytesPerSample;
  const wav = new Uint8Array(44 + dataSize);
  const view = new DataView(wav.buffer);
  const writeAscii = (offset: number, value: string) => {
    wav.set(new TextEncoder().encode(value), offset);
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, dataSize, true);

  for (let sample = 0; sample < sampleCount; sample++) {
    const envelope = Math.min(1, sample / 200, (sampleCount - sample) / 200);
    const value = Math.round(Math.sin(2 * Math.PI * 440 * sample / sampleRate) * 4_000 * envelope);
    view.setInt16(44 + sample * bytesPerSample, value, true);
  }
  return wav;
}

const fixtures = new Map<string, Uint8Array>([
  ...Array.from({ length: 9 }, (_, index) => [
    `avatar-${index + 1}.png`,
    avatarFixture(index + 1),
  ] as const),
  ["blur.png", blurFixture()],
  ...Array.from({ length: 3 }, (_, index) => [
    `rounded-image-${index + 1}.png`,
    roundedImageFixture(index + 1),
  ] as const),
  ...Array.from({ length: 6 }, (_, index) => [
    `grid-${index + 1}.png`,
    roundedImageFixture(index + 1),
  ] as const),
  ["card.png", cardImageFixture()],
  ["image-200x150.png", galleryImageFixture(200, 150, 0)],
  ["image-square-1.png", galleryImageFixture(100, 100, 1)],
  ["image-square-2.png", galleryImageFixture(100, 100, 2)],
  ["image-square-3.png", galleryImageFixture(100, 100, 3)],
  ["image-300x200.png", galleryImageFixture(300, 200, 0)],
  ["image-120x80-1.png", galleryImageFixture(120, 80, 1)],
  ["image-120x80-2.png", galleryImageFixture(120, 80, 2)],
  ["sample.wav", audioFixture()],
]);

export function galleryFixture(name: string): Uint8Array | undefined {
  return fixtures.get(name);
}

export function galleryFixtureNames(): string[] {
  return [...fixtures.keys()];
}

export function galleryFixtureContentType(name: string): string | undefined {
  if (!fixtures.has(name)) return undefined;
  return name.endsWith(".wav") ? "audio/wav" : "image/png";
}

export function fixtureNames(source: string): Set<string> {
  return new Set([...source.matchAll(/\/fixtures\/([^?"']+)/g)].map(match => match[1]));
}

export interface GalleryFixtureSourceOptions {
  fixtureBase: string;
  platform: string;
  example: string;
  generation: number;
}

/**
 * Resolve gallery fixture URLs before the DSL is sent to a renderer.
 *
 * Browsers resolve `/fixtures/...` against the gallery origin, but native
 * image loaders require an absolute URL. Keeping this normalization here also
 * ensures every fixture request carries the readiness identity used by the
 * screenshot runner.
 */
export function resolveGalleryFixtureSource(
  source: string,
  options: GalleryFixtureSourceOptions,
): string {
  const fixtureBase = options.fixtureBase.replace(/\/$/, "");
  const trackingQuery = new URLSearchParams({
    platform: options.platform,
    example: options.example,
    generation: String(options.generation),
  }).toString();

  const withPlaceholders = source
    .replaceAll("__HYPEN_GALLERY_FIXTURE_BASE__", fixtureBase)
    .replaceAll("__HYPEN_GALLERY_PLATFORM__", options.platform)
    .replaceAll("__HYPEN_GALLERY_GENERATION__", String(options.generation));

  return withPlaceholders.replace(
    /(["'])\/fixtures\/([^?"']+)(?:\?([^"']*))?\1/g,
    (_match, quote: string, name: string, query: string | undefined) =>
      `${quote}${fixtureBase}/fixtures/${name}?${query ? `${query}&` : ""}${trackingQuery}${quote}`,
  );
}
