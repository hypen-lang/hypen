/**
 * Put the wallpaper renditions (`public/wallpapers/<version>/*.avif`) into the
 * `FILES` R2 bucket under `assets/wallpapers/<version>/`, where the Worker
 * serves them from (src/wallpapers.ts).
 *
 *   bun run wallpapers:upload            # wrangler dev's local R2 (.wrangler/state)
 *   bun run wallpapers:upload --remote   # the deployed bucket (needs `wrangler login`)
 *   … --bucket <name>                    # if you renamed `bucket_name` in wrangler.jsonc
 *   … --force                            # local: re-upload even if already done
 *
 * Only ever writes keys under `assets/wallpapers/`; it never lists, changes or
 * deletes anything else (the bucket also holds visitors' drive files). Run it
 * once per environment and again whenever `WALLPAPER_ASSET_VERSION` changes.
 * `scripts/dev-examples.sh` runs the local variant for you.
 */
import { readdir } from "node:fs/promises";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { WALLPAPER_ASSET_VERSION } from "../src/unsplash";
import { WALLPAPER_HEADERS, WALLPAPER_R2_PREFIX } from "../src/wallpapers";

const args = process.argv.slice(2);
const remote = args.includes("--remote");
const force = args.includes("--force");
const bucketFlag = args.indexOf("--bucket");
const bucket = bucketFlag >= 0 ? args[bucketFlag + 1] : "hypen-home-files";
if (!bucket) throw new Error("--bucket needs a name");

const root = new URL("../", import.meta.url).pathname;
const sourceDir = `${root}public/wallpapers/${WALLPAPER_ASSET_VERSION}/`;
const files = (await readdir(sourceDir)).filter((f) => /^[A-Za-z0-9_-][A-Za-z0-9._-]*\.avif$/.test(f)).sort();
if (files.length === 0) throw new Error(`no .avif files in ${sourceDir} (run \`bun run wallpapers:download\`)`);

// Local uploads are skipped once done: wrangler's local R2 lives in
// .wrangler/state, so deleting that directory also resets this marker.
const marker = `${root}.wrangler/state/wallpapers-${bucket}-${WALLPAPER_ASSET_VERSION}.uploaded`;
if (!remote && !force && existsSync(marker)) {
  console.log(`wallpapers ${WALLPAPER_ASSET_VERSION} already in local R2 (${bucket}); --force to redo`);
  process.exit(0);
}

async function put(file: string): Promise<void> {
  const key = `${bucket}/${WALLPAPER_R2_PREFIX}${WALLPAPER_ASSET_VERSION}/${file}`;
  const proc = Bun.spawn(
    [
      "bunx", "wrangler", "r2", "object", "put", key,
      "--file", `${sourceDir}${file}`,
      "--content-type", WALLPAPER_HEADERS["Content-Type"]!,
      "--cache-control", WALLPAPER_HEADERS["Cache-Control"]!,
      remote ? "--remote" : "--local",
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(`${key}: wrangler exited ${code}\n${out}${err}`);
  console.log(`${remote ? "remote" : "local"} ${key}`);
}

// A few at a time remotely; one at a time into the local SQLite-backed store.
const queue = [...files];
const workers = Array.from({ length: remote ? 4 : 1 }, async () => {
  for (let file = queue.shift(); file; file = queue.shift()) await put(file);
});
await Promise.all(workers);

if (!remote) {
  mkdirSync(`${root}.wrangler/state`, { recursive: true });
  writeFileSync(marker, files.join("\n") + "\n");
}
console.log(`${files.length} wallpapers → ${bucket}/${WALLPAPER_R2_PREFIX}${WALLPAPER_ASSET_VERSION}/`);
