/**
 * The file Studio opens first: the entry component's template inside the
 * configured components directory, or the entry script itself for
 * server-based projects (`"entry": "./src/app.ts"`).
 */
export function entryFilePath(project: { components?: string; entry?: string }): string {
  const entry = project.entry || "App";
  const strip = (p: string) => p.replace(/^\.\//, "").replace(/\/+$/, "");
  if (/\.(ts|js|mjs)$/.test(entry)) return strip(entry);
  const dir = strip(project.components || "./src/components");
  return `${dir ? dir + "/" : ""}${entry}/component.hypen`;
}
