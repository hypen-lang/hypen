/**
 * Test fixtures for module packages: write a `hypen-modules.json` package
 * (and a small app to install it into) from the committed WebAssembly
 * components of hypen-engine-rs/tests/fixtures. No toolchain involved.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import {
  PACKAGE_MANIFEST_FILE,
  asRequests,
  integrityOf,
  serializePackageManifest,
  type CapabilitySet,
  type PackageManifest,
} from "../../src/build-wasm";

export const FIXTURES = resolve(import.meta.dir, "..", "..", "..", "hypen-engine-rs", "tests", "fixtures");
export const fixture = (name: string): string => join(FIXTURES, name);
export const haveFixtures = (...names: string[]): boolean => names.every((n) => existsSync(fixture(n)));

export function write(path: string, content: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

export interface FixtureModule {
  name: string;
  /** A file of hypen-engine-rs/tests/fixtures. */
  wasm: string;
  template: string;
  requests?: Partial<CapabilitySet>;
}

export interface FixturePackage {
  name: string;
  version?: string;
  description?: string;
  modules: FixtureModule[];
  components?: Array<{ name: string; template: string }>;
  entry?: string;
  exports?: string[];
  /** Also write a package.json with the `"hypen"` marker (an npm package). */
  npm?: boolean;
}

/** Write a package into `dir`; returns its manifest. */
export function writePackage(dir: string, pkg: FixturePackage): PackageManifest {
  mkdirSync(dir, { recursive: true });
  const manifest: PackageManifest = {
    name: pkg.name,
    version: pkg.version ?? "1.0.0",
    description: pkg.description,
    entry: pkg.entry,
    exports: pkg.exports ?? (pkg.entry ? [pkg.entry] : [...pkg.modules.map((m) => m.name), ...(pkg.components ?? []).map((c) => c.name)]),
    modules: pkg.modules.map((m) => {
      copyFileSync(fixture(m.wasm), join(dir, `${m.name}.wasm`));
      write(join(dir, `${m.name}.hypen`), m.template);
      return {
        name: m.name,
        component: `${m.name}.wasm`,
        template: `${m.name}.hypen`,
        abi: "0.1",
        requests: asRequests({ reads: [], dispatches: [], storage: [], http: false, httpHosts: [], ...m.requests }),
        integrity: integrityOf(readFileSync(fixture(m.wasm))),
      };
    }),
    components: (pkg.components ?? []).map((c) => {
      write(join(dir, `${c.name}.hypen`), c.template);
      return { name: c.name, template: `${c.name}.hypen` };
    }),
  };
  write(join(dir, PACKAGE_MANIFEST_FILE), serializePackageManifest(manifest));
  if (pkg.npm) {
    write(
      join(dir, "package.json"),
      JSON.stringify({ name: pkg.name, version: manifest.version, hypen: { modules: PACKAGE_MANIFEST_FILE } }, null, 2) + "\n"
    );
  }
  return manifest;
}

export const COUNTER_UI = `module Counter {
  Column {
    Text("Count: @{state.count}")
    Button { Text("Count +1") }.onClick(@actions.increment)
  }
}`;

export const MIRROR_UI = `module Mirror {
  Column {
    Text("Seen: @{state.seen}")
    Button { Text("Bump the counter") }.onClick(@actions.bump)
    Counter {}
    Stamp()
  }
}`;

/** The root of {@link boardPackage}: it composes the package's other two modules. */
export const BOARD_UI = `// Board is the package's root: it places Mirror and Counter
module Board {
  Column {
    Text("Board: @{state.count} (Counter and Mirror are inside)")
    Button { Text("Board +1") }.onClick(@actions.increment)
    Mirror {}
  }
}`;

export const STAMP_UI = `Text("from the counters package")`;

/**
 * The standard two-module package, self-contained: `Mirror` is its root
 * (the entry and — by default — its only export). Mirror's template places
 * its sibling `Counter` and the template-only `Stamp`; Mirror's code reads,
 * dispatches to and subscribes to `counter` by that name; Counter's
 * component imports the `cloud` storage tier. An app uses ONE tag,
 * `Mirror {}`; Counter and Stamp are internal to the package.
 */
export function countersPackage(overrides: Partial<FixturePackage> = {}): FixturePackage {
  return {
    name: "@acme/counters",
    version: "1.2.0",
    description: "A counter and a module that mirrors it",
    entry: "Mirror",
    modules: [
      { name: "Mirror", wasm: "mirror_module.wasm", template: MIRROR_UI, requests: { reads: ["Counter"], dispatches: ["Counter"] } },
      { name: "Counter", wasm: "counter_module.wasm", template: COUNTER_UI, requests: { storage: ["cloud"] } },
    ],
    components: [{ name: "Stamp", template: STAMP_UI }],
    ...overrides,
  };
}

/** Mirror's template in {@link flatCountersPackage}: it does not place Counter. */
export const FLAT_MIRROR_UI = MIRROR_UI.replace("    Counter {}\n", "");

/**
 * The same two modules as a FLAT package: both are exported and the app
 * places each in its own template (`Mirror {}` and `Counter {}`); Mirror
 * still reads and dispatches to its sibling. `Stamp` stays internal.
 */
export function flatCountersPackage(overrides: Partial<FixturePackage> = {}): FixturePackage {
  const counters = countersPackage();
  return {
    ...counters,
    exports: ["Mirror", "Counter"],
    modules: counters.modules.map((m) => (m.name === "Mirror" ? { ...m, template: FLAT_MIRROR_UI } : m)),
    ...overrides,
  };
}

/**
 * {@link countersPackage} under a third module, `Board`, that is the root:
 * Board → Mirror → Counter. Only `Board` is exported.
 */
export function boardPackage(overrides: Partial<FixturePackage> = {}): FixturePackage {
  const counters = countersPackage();
  return {
    ...counters,
    name: "@acme/board",
    entry: "Board",
    modules: [{ name: "Board", wasm: "seeded_module.wasm", template: BOARD_UI }, ...counters.modules],
    ...overrides,
  };
}

/** A minimal TypeScript app: an `App` entry whose template is `body`. */
export function writeApp(dir: string, body = `Text("App: @{state.title}")`, wasm?: unknown): void {
  write(join(dir, "src/components/App/component.hypen"), `module App {\n  Column {\n    ${body}\n  }\n}`);
  write(
    join(dir, "src/components/App/component.ts"),
    `export default { actions: [], stateKeys: ["title"], initialState: { title: "mixed" }, handlers: { onAction: new Map() } };`
  );
  write(
    join(dir, "hypen.json"),
    JSON.stringify({ components: "./src/components", entry: "App", port: 3000, ...(wasm !== undefined ? { wasm } : {}) }, null, 2) + "\n"
  );
}
