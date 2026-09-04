import sharp from "sharp";

export const CONTACT_SHEET_PLATFORMS = [
  "ios",
  "android",
  "web",
  "desktop",
  "canvas",
] as const;

export type ContactSheetPlatform = (typeof CONTACT_SHEET_PLATFORMS)[number];

export interface ContactSheetPanelSize {
  width: number;
  height: number;
}

export async function createPlatformContactSheet(
  images: Partial<Record<ContactSheetPlatform, Buffer>>,
  width: number,
  height: number,
  outputPath: string,
  panelSizes: Partial<Record<ContactSheetPlatform, ContactSheetPanelSize>> = {},
): Promise<void> {
  const labelHeight = 30;
  const sizes = CONTACT_SHEET_PLATFORMS.map(platform => panelSizes[platform] ?? { width, height });
  const totalWidth = sizes.reduce((total, size) => total + size.width, 0);
  const panelHeight = Math.max(...sizes.map(size => size.height));
  const panelLefts = sizes.map((_, index) =>
    sizes.slice(0, index).reduce((total, size) => total + size.width, 0),
  );
  const panels = await Promise.all(
    CONTACT_SHEET_PLATFORMS.map(async (platform, index) => {
      const image = images[platform];
      const size = sizes[index];
      if (image) {
        return sharp(image, { raw: { width, height, channels: 4 } })
          .extract({ left: 0, top: 0, width: size.width, height: size.height })
          .png()
          .toBuffer();
      }

      return sharp({
        create: {
          width: size.width,
          height: size.height,
          channels: 4,
          background: { r: 245, g: 245, b: 245, alpha: 1 },
        },
      })
        .composite([{
          input: Buffer.from(
            `<svg width="${size.width}" height="${size.height}">
              <text x="${size.width / 2}" y="${size.height / 2}" text-anchor="middle" fill="#777" font-family="sans-serif" font-size="18">UNAVAILABLE</text>
            </svg>`,
          ),
          left: 0,
          top: 0,
        }])
        .png()
        .toBuffer();
    }),
  );

  const labels = CONTACT_SHEET_PLATFORMS.map((platform, index) =>
    `<text x="${panelLefts[index] + sizes[index].width / 2}" y="20" text-anchor="middle" fill="#fff" font-family="sans-serif" font-size="14">${platform.toUpperCase()}</text>`,
  ).join("");

  await sharp({
    create: {
      width: totalWidth,
      height: panelHeight + labelHeight,
      channels: 4,
      background: { r: 40, g: 40, b: 40, alpha: 1 },
    },
  })
    .composite([
      ...panels.map((input, index) => ({ input, left: panelLefts[index], top: labelHeight })),
      {
        input: Buffer.from(
          `<svg width="${totalWidth}" height="${labelHeight}">
            <rect width="100%" height="100%" fill="#282828"/>
            ${labels}
          </svg>`,
        ),
        left: 0,
        top: 0,
      },
    ])
    .png()
    .toFile(outputPath);
}
