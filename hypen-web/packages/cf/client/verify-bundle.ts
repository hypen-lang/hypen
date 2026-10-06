/**
 * Post-build assertion for `dist/client/generic.js`.
 *
 * This bundle is the browser client every `defineHypenWorker({ serveClient:
 * true })` worker serves, so whatever it lacks, every web app lacks. It is
 * built by bundling `@hypen-space/web`'s DOMRenderer — a *dependency*, which
 * means a stale copy in `packages/cf/node_modules/@hypen-space/web` silently
 * shadows the workspace package and gets bundled instead. Nothing fails; the
 * output is simply missing whatever the newer renderer added.
 *
 * That is not hypothetical: `@hypen-space/cf@0.6.0` shipped a 242 KB client
 * built against a leftover `@hypen-space/web@0.5.4`, which predates the DOM
 * animation runtime entirely. Every app published against it — todo,
 * home-screen, all of them — rendered correctly and animated nothing, on
 * every browser, with no console error to hint at why.
 *
 * So: assert on the symbols that only the current renderer contributes. A
 * missing marker means the bundle was built against the wrong dependency
 * tree; re-run `bun install` at the workspace root so `@hypen-space/web`
 * resolves to `packages/web`, then rebuild.
 */

const BUNDLE = "dist/client/generic.js";

/** Markers that must survive minification (string literals / stable ids). */
const REQUIRED: ReadonlyArray<{ marker: string; provides: string }> = [
  { marker: "__anim.", provides: "the __anim.* channel protocol" },
  { marker: "hypen-anim-styles", provides: "the animation keyframes stylesheet" },
  { marker: "hypen-a11y-styles", provides: "the reduced-motion / focus stylesheet" },
  { marker: "data-hypen-device-dialog", provides: "the device host's consent dialog (RFC 001)" },
  { marker: "drop-zone", provides: "the device host's picker drop zone" },
];

const file = Bun.file(BUNDLE);
if (!(await file.exists())) {
  console.error(`✗ ${BUNDLE} missing — did \`bun run build:client\` run?`);
  process.exit(1);
}

const source = await file.text();
const missing = REQUIRED.filter(({ marker }) => !source.includes(marker));

if (missing.length > 0) {
  console.error(`✗ ${BUNDLE} is missing runtime that the renderer should provide:\n`);
  for (const { marker, provides } of missing) {
    console.error(`    ${marker.padEnd(20)} — ${provides}`);
  }
  console.error(
    `\n  The bundle almost certainly resolved a stale @hypen-space/web from` +
      `\n  packages/cf/node_modules instead of the workspace package. Check with:` +
      `\n\n    cat node_modules/@hypen-space/web/package.json | grep version` +
      `\n\n  It must match packages/web/package.json. If it does not, remove the` +
      `\n  nested copy and re-run \`bun install\` from the workspace root.\n`,
  );
  process.exit(1);
}

console.log(
  `✓ ${BUNDLE} carries the animation runtime (${(source.length / 1024).toFixed(0)} KB)`,
);
