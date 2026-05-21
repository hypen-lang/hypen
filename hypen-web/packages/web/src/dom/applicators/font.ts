/**
 * Font Applicators with Google Fonts support
 */

import type { ApplicatorHandler } from "./types.js";
import { toCssLength } from "./size.js";

// Track loaded Google Fonts to avoid duplicate link tags
const loadedGoogleFonts = new Set<string>();

// System font keywords that shouldn't be loaded from Google Fonts
const systemFontKeywords = new Set([
  "default", "system", "system-ui", "inherit", "initial", "unset",
  "serif", "sans-serif", "monospace", "cursive", "fantasy",
  "-apple-system", "BlinkMacSystemFont", "Segoe UI", "Arial", "Helvetica",
  "Times New Roman", "Georgia", "Courier New", "Verdana", "Tahoma",
]);

/**
 * Check if a font name is a system font or generic CSS font.
 */
function isSystemFont(fontName: string): boolean {
  const normalized = fontName.toLowerCase().trim();
  return systemFontKeywords.has(normalized) ||
         normalized.startsWith("-") ||
         normalized.startsWith("ui-");
}

/**
 * Load a Google Font by injecting a link tag.
 * @param fontName - The Google Font name (e.g., "Roboto", "Open Sans")
 */
function loadGoogleFont(fontName: string): void {
  const normalized = fontName.trim();

  // Skip if already loaded or is a system font
  if (loadedGoogleFonts.has(normalized) || isSystemFont(normalized)) {
    return;
  }

  // Mark as loading to avoid duplicates
  loadedGoogleFonts.add(normalized);

  // Create link element for Google Fonts
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(normalized)}:wght@100;200;300;400;500;600;700;800;900&display=swap`;

  // Add to document head
  document.head.appendChild(link);
}

/**
 * Parse a fontFamily value and load any Google Fonts.
 * Returns a CSS-safe font-family string.
 */
function processFontFamily(value: string): string {
  // Split by comma to handle font stacks
  const fonts = value.split(",").map(f => f.trim().replace(/["']/g, ""));

  for (const font of fonts) {
    if (!isSystemFont(font)) {
      loadGoogleFont(font);
    }
  }

  // Return original value with proper quoting for CSS
  return fonts.map(f => {
    // Quote font names that contain spaces or special characters
    if (f.includes(" ") && !f.startsWith('"') && !f.startsWith("'")) {
      return `"${f}"`;
    }
    return f;
  }).join(", ");
}

export const fontHandlers: Record<string, ApplicatorHandler> = {
  fontSize: (el, value) => {
    el.style.fontSize = toCssLength(value);
  },

  fontWeight: (el, value) => {
    el.style.fontWeight = String(value);
  },

  fontFamily: (el, value) => {
    const fontValue = String(value);
    // Process font family and load Google Fonts as needed
    el.style.fontFamily = processFontFamily(fontValue);
  },

  textAlign: (el, value) => {
    const v = String(value);
    el.style.textAlign = v;
    // `text-align: center | right | end | justify` only takes visible
    // effect when the box is wider than the text. Hypen's Text defaults
    // to `inline-block` (shrink-to-fit), so without this an author
    // writing `Text("Edit Profile").tw("text-center")` saw the same
    // left-flush text whether they set `text-center` or not (the
    // social Profile page Edit button). Stretch the box across its
    // flex parent and switch to block so the alignment has room to act.
    if (v === "center" || v === "right" || v === "end" || v === "justify") {
      if (!el.style.alignSelf) el.style.alignSelf = "stretch";
      if (!el.style.width) el.style.width = "100%";
      if (el.style.display === "inline-block" || !el.style.display) {
        el.style.display = "block";
      }
    }
  },

  lineHeight: (el, value) => {
    el.style.lineHeight = String(value);
  },

  fontStyle: (el, value) => {
    // Support: normal, italic, oblique
    el.style.fontStyle = String(value);
  },

  textTransform: (el, value) => {
    // Support: none, capitalize, uppercase, lowercase
    el.style.textTransform = String(value);
  },
};

// Export the font loading utility for manual use
export const GoogleFonts = {
  /**
   * Preload a Google Font before it's used.
   */
  preload: loadGoogleFont,

  /**
   * Check if a font has been loaded.
   */
  isLoaded: (fontName: string) => loadedGoogleFonts.has(fontName.trim()),

  /**
   * Get list of loaded fonts.
   */
  getLoadedFonts: () => Array.from(loadedGoogleFonts),

  /**
   * Popular Google Fonts for reference.
   */
  popular: [
    "Roboto",
    "Open Sans",
    "Lato",
    "Montserrat",
    "Poppins",
    "Inter",
    "Nunito",
    "Playfair Display",
    "Merriweather",
    "Source Code Pro",
    "Fira Code",
    "JetBrains Mono",
    "Raleway",
    "Ubuntu",
    "Oswald",
    "Quicksand",
    "Work Sans",
    "Rubik",
    "Karla",
    "DM Sans",
  ],
};
