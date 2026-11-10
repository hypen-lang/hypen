/**
 * Builds one static app per variant into `variants/<name>/`, plus a manifest
 * the matrix driver (`bench/matrix.ts`) reads.
 *
 *   bun scripts/build-variants.ts <spec>...
 *
 * Specs:
 *   react                      the plain React app (every row in the DOM)
 *   react-virtual              the same app with a windowed list
 *   hypen@0.6.7                the Hypen app against a published npm release
 *   <name>=<dir>               the Hypen app against a checkout's
 *                              `hypen-web/packages` directory
 *   <name>=<dir>?<list args>   …with extra `List` arguments, e.g.
 *                              `develop-eager=../wt/hypen-web/packages?lazy: false`
 *
 * Every Hypen variant is the SAME app source — `apps/hypen` — bundled against
 * a different SDK, so a difference between two of them is a difference
 * between the SDKs. Published releases are taken from the npm tarballs
 * (`dist/` + the shipped WASM), which is byte-for-byte what a consumer
 * installs. Checkouts get their `core` and `web` dists built first, exactly as
 * `scripts/prepare.ts` does.
 */

import { $ } from "bun";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const VARIANTS = resolve(root, "variants");
const VENDOR = resolve(root, ".vendor");
const SDK_PACKAGES = ["core", "web", "web-engine"] as const;

export interface Variant {
  name: string;
  framework: "react" | "hypen";
  /** Whether the list is windowed (only the rows near the viewport exist). */
  virtualized: boolean;
  /** Where the SDK came from, for the report. */
  source: string;
  wasmSha256?: string;
}

const sha256 = async (file: string) =>
  createHash("sha256").update(await readFile(file)).digest("hex");

async function fetchRelease(version: string): Promise<string> {
  const dir = resolve(VENDOR, version);
  for (const pkg of SDK_PACKAGES) {
    const dest = resolve(dir, pkg);
    if (existsSync(resolve(dest, "package.json"))) continue;
    await mkdir(dest, { recursive: true });
    const url = `https://registry.npmjs.org/@hypen-space/${pkg}/-/${pkg}-${version}.tgz`;
    console.log(`[variants] fetching ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const tgz = resolve(dir, `${pkg}.tgz`);
    await Bun.write(tgz, res);
    await $`tar xzf ${tgz} -C ${dest} --strip-components=1`;
    await rm(tgz);
  }
  return dir;
}

async function buildCheckoutDists(packages: string): Promise<void> {
  for (const pkg of ["core", "web"]) {
    console.log(`[variants] building ${packages}/${pkg}`);
    await $`bun run build.ts`.cwd(resolve(packages, pkg)).quiet();
  }
}

async function buildHypen(
  name: string,
  packages: string,
  listArgs: string,
): Promise<string> {
  const out = resolve(VARIANTS, name);
  const publicDir = resolve(VARIANTS, `.public-${name}`);
  const wasmSrc = resolve(packages, "web-engine/wasm-browser");
  await rm(publicDir, { recursive: true, force: true });
  await mkdir(resolve(publicDir, "wasm"), { recursive: true });
  for (const file of ["hypen_engine.js", "hypen_engine_bg.wasm"]) {
    await cp(resolve(wasmSrc, file), resolve(publicDir, "wasm", file));
  }
  await $`bunx vite build`
    .cwd(resolve(root, "apps/hypen"))
    .env({
      ...process.env,
      HYPEN_PACKAGES_DIR: packages,
      BENCH_OUT_DIR: out,
      BENCH_PUBLIC_DIR: publicDir,
      BENCH_LIST_ARGS: listArgs,
    })
    .quiet();
  await rm(publicDir, { recursive: true, force: true });
  return sha256(resolve(out, "wasm/hypen_engine_bg.wasm"));
}

async function buildReact(name: string, virtual: boolean): Promise<void> {
  await $`bunx vite build`
    .cwd(resolve(root, "apps/react"))
    .env({
      ...process.env,
      BENCH_OUT_DIR: resolve(VARIANTS, name),
      BENCH_VIRTUAL: virtual ? "1" : "",
    })
    .quiet();
}

/** Does this SDK window `List` by default? True once it ships the virtualizer. */
const virtualizes = (packages: string) =>
  existsSync(resolve(packages, "core/src/virtualization.ts")) ||
  existsSync(resolve(packages, "core/dist/virtualization.js"));

const specs = process.argv.slice(2);
if (specs.length === 0) {
  console.error("usage: bun scripts/build-variants.ts <spec>...  (see file header)");
  process.exit(1);
}

await mkdir(VARIANTS, { recursive: true });
const manifestPath = resolve(VARIANTS, "manifest.json");
// Re-running with a subset rebuilds just those and keeps the rest listed.
const previous: Variant[] = existsSync(manifestPath)
  ? JSON.parse(await readFile(manifestPath, "utf8"))
  : [];
const manifest: Variant[] = [];

for (const spec of specs) {
  let variant: Variant;
  if (spec === "react" || spec === "react-virtual") {
    const virtual = spec === "react-virtual";
    await buildReact(spec, virtual);
    variant = { name: spec, framework: "react", virtualized: virtual, source: "apps/react" };
  } else if (spec.startsWith("hypen@")) {
    const version = spec.slice("hypen@".length);
    const packages = await fetchRelease(version);
    const name = `hypen-${version}`;
    const wasmSha256 = await buildHypen(name, packages, "");
    variant = {
      name,
      framework: "hypen",
      virtualized: virtualizes(packages),
      source: `npm @hypen-space/*@${version}`,
      wasmSha256,
    };
  } else {
    const m = /^([\w.-]+)=([^?]+)(?:\?(.*))?$/.exec(spec);
    if (!m) throw new Error(`unrecognised variant spec: ${spec}`);
    const [, name, dir, listArgs = ""] = m;
    const packages = resolve(dir);
    await stat(resolve(packages, "web-engine/wasm-browser/hypen_engine_bg.wasm"));
    await buildCheckoutDists(packages);
    const wasmSha256 = await buildHypen(name, packages, listArgs);
    const rev = (await $`git rev-parse --short HEAD`.cwd(packages).text()).trim();
    variant = {
      name,
      framework: "hypen",
      virtualized: virtualizes(packages) && !/lazy:\s*false/.test(listArgs),
      source: `checkout ${rev}` + (listArgs ? ` (List ${listArgs})` : ""),
      wasmSha256,
    };
  }
  manifest.push(variant);
  console.log(`[variants] built ${variant.name}  (${variant.source})`);
}

const built = new Set(manifest.map((v) => v.name));
const merged = [...previous.filter((v) => !built.has(v.name)), ...manifest];
await writeFile(manifestPath, JSON.stringify(merged, null, 2));
console.log(`[variants] wrote variants/manifest.json (${merged.length} variants)`);
