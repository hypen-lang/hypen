// CI: resolve @hypen-space/* from this checkout instead of npm, so the
// CLI tests run against the repo's packages (and work before a bumped
// version is published).
const path = "package.json";
const pkg = await Bun.file(path).json();
const local: Record<string, string> = {
  "@hypen-space/core": "../hypen-web/packages/core",
  "@hypen-space/server": "../hypen-web/packages/server",
  "@hypen-space/web": "../hypen-web/packages/web",
  "@hypen-space/web-engine": "../hypen-web/packages/web-engine",
  "@hypen-space/lsp": "../hypen-lsp",
};
for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
  for (const name of Object.keys(pkg[field] ?? {})) {
    if (local[name]) pkg[field][name] = `file:${local[name]}`;
  }
}
// The linked packages depend on each other at the same version, so pin
// those transitive specifiers to the checkout as well.
pkg.overrides = { ...(pkg.overrides ?? {}) };
for (const [name, dir] of Object.entries(local)) pkg.overrides[name] = `file:${dir}`;
await Bun.write(path, JSON.stringify(pkg, null, 2) + "\n");
console.log("linked @hypen-space/* to the checkout");
