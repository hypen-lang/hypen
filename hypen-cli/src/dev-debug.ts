/**
 * Does a `DEBUG` env value (debug-module syntax: comma/space separated
 * namespaces, `*` wildcards, `-` exclusions) enable Hypen's namespace?
 */
export function isHypenDebugEnv(value: string | undefined): boolean {
  if (!value) return false;
  let enabled = false;
  for (const raw of value.split(/[\s,]+/)) {
    if (!raw) continue;
    const exclude = raw.startsWith("-");
    const pattern = exclude ? raw.slice(1) : raw;
    const re = new RegExp(
      "^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"
    );
    if (re.test("hypen") || re.test("hypen:dev")) {
      if (exclude) return false;
      enabled = true;
    }
  }
  return enabled;
}
