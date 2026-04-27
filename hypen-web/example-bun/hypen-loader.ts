/**
 * Hypen loader using Bun macros
 */

/**
 * Load a .hypen file as a string at build time
 */
export function loadHypen(path: string): string {
  return Bun.file(path).text();
}
