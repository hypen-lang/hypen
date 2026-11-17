/**
 * `hypen modules`: the hosted modules of an app, grouped by package —
 * where each comes from, its version, and what it was granted versus what
 * it requests.
 */

import { existsSync } from "fs";
import { resolve } from "path";
import { BuildError } from "../build-error.js";
import { bold, boldYellow, dim, pink, yellow } from "../colors.js";
import type { PackageDeclaration } from "../wasm/config.js";
import {
  asGrant,
  capabilitiesOf,
  capabilityId,
  formatAddedRequests,
  locateModulePackage,
  installedNameOf,
  notCovered,
  packageDrift,
  planPackageNames,
  readModulePackage,
  unionGrant,
  type ResolvedPackage,
} from "../wasm/module-package.js";
import { asBuildError, builtManifestPath, selectFromPackage } from "../wasm/packages.js";
import { readProjectConfig } from "../project-config.js";
import { openAppProject } from "./store.js";

export interface ListedModule {
  /** Its name in the package — the one its author and its users know. */
  name: string;
  /**
   * The component name / state scope it is installed under: `name` for an
   * exported module (or what `as` renamed it to), a namespaced name for an
   * internal one. A debug detail.
   */
  installed: string;
  /** Whether the app's templates may use it. */
  exported: boolean;
  /** `map`: names it reads / dispatches to that are pointed at one of the app's modules. */
  mapped: Record<string, string>;
  granted: string[];
  requested: string[];
  /** Requested but not granted. */
  withheld: string[];
}

export interface ListedPackage {
  from: string;
  kind: "installed" | "source" | "module";
  name?: string;
  version?: string;
  /** `current`, `updated`, … or the reason it cannot be read. */
  status: string;
  /** A problem that stops `hypen dev` / `hypen build`. */
  problem?: string;
  modules: ListedModule[];
  /** Template-only components, by their names in the package. */
  components: string[];
  /** The names the app's templates may use (after `as`). */
  exports: string[];
  /** The namespace the package's internal names are installed under. */
  namespace?: string;
}

function describePackage(decl: PackageDeclaration, pkg: ResolvedPackage, projectLock: ReturnType<typeof openAppProject>["lock"]): ListedPackage {
  const selection = selectFromPackage(pkg, decl.only, decl.from, decl.field);
  const naming = planPackageNames(pkg.manifest, { namespace: decl.namespace, as: decl.as, from: decl.from });
  const selected = (name: string): boolean =>
    selection.modules.some((m) => m.name === name) || selection.components.some((c) => c.name === name);
  const modules = selection.modules.map((module): ListedModule => {
    const recorded = decl.grants.get(module.name);
    const base = asGrant({
      reads: recorded?.reads ?? [],
      dispatches: recorded?.dispatches ?? [],
      storage: recorded?.storage ?? [],
      http: recorded?.http ?? false,
      httpHosts: recorded?.httpHosts ?? [],
    });
    const grant = decl.trust === "requested" ? unionGrant(base, module.requests) : base;
    const installed = installedNameOf(naming, module.name);
    return {
      name: module.name,
      installed: installed?.installed ?? module.name,
      exported: installed?.exported ?? true,
      mapped: { ...decl.map.get(module.name) },
      granted: capabilitiesOf(grant).map(capabilityId),
      requested: capabilitiesOf(module.requests).map(capabilityId),
      withheld: notCovered(module.requests, grant).map(capabilityId),
    };
  });
  let status = decl.source ? `built from source${decl.trust === "requested" ? "; granted what it declares" : ""}` : "current";
  let problem: string | undefined;
  if (!decl.source) {
    const drift = packageDrift(pkg, projectLock[decl.from], selection.modules.map((m) => m.name));
    if (drift.status === "unrecorded") {
      status = "not reviewed";
      problem = `run \`hypen add ${decl.from}\` to review and record it`;
    } else if (drift.status === "updated") {
      status = `changed since review (${drift.from} → ${drift.to}), nothing new requested`;
    } else if (drift.status === "integrity") {
      status = "component changed under the reviewed version";
      problem = `${drift.modules.join(", ")}: not the bytes that were reviewed — run \`hypen add ${decl.from}\` if that is intended`;
    } else if (drift.status === "requests") {
      status = `requests more than was reviewed (${drift.from} → ${drift.to})`;
      problem = `${formatAddedRequests(drift.added)} — run \`hypen add ${decl.from}\``;
    }
  }
  return {
    from: decl.from,
    kind: decl.source ? "source" : "installed",
    name: pkg.manifest.name,
    version: pkg.manifest.version,
    status,
    problem,
    modules,
    components: selection.components.map((c) => c.name),
    exports: naming.names.filter((n) => n.exported && selected(n.name)).map((n) => n.installed),
    namespace: naming.namespace,
  };
}

/** What `hypen modules` shows, as data. Never throws for a broken package: it is listed with its problem. */
export function listPackages(projectDir: string): ListedPackage[] {
  const project = openAppProject(projectDir);
  const listed: ListedPackage[] = [];
  for (const decl of project.config.packages.values()) {
    try {
      let manifestPath: string;
      if (decl.source) {
        const dir = resolve(project.dir, decl.from);
        manifestPath = builtManifestPath(dir, readProjectConfig(dir).outDir);
        if (!existsSync(manifestPath)) {
          listed.push({ from: decl.from, kind: "source", status: "not built yet (built by `hypen dev` / `hypen build`)", modules: [], components: [], exports: [] });
          continue;
        }
      } else {
        manifestPath = locateModulePackage(decl.from, project.dir).manifestPath;
      }
      listed.push(describePackage(decl, readModulePackage(manifestPath), project.lock));
    } catch (err) {
      const e = asBuildError(err);
      listed.push({
        from: decl.from,
        kind: decl.source ? "source" : "installed",
        status: "unreadable",
        problem: e instanceof BuildError ? `${e.message}${e.hint ? ` (${e.hint})` : ""}` : String(err),
        modules: [],
        components: [],
        exports: [],
      });
    }
  }
  for (const [name, entry] of project.config.modules) {
    if (entry.prebuilt === undefined) continue;
    const granted = capabilitiesOf(asGrant(entry)).map(capabilityId);
    listed.push({
      from: entry.prebuilt.component,
      kind: "module",
      status: "declared by hand (wasm.modules); requests unknown",
      modules: [{ name, installed: name, exported: true, mapped: {}, granted, requested: [], withheld: [] }],
      components: [],
      exports: [name],
    });
  }
  return listed;
}

/** Render {@link listPackages} for a terminal. */
export function formatPackages(listed: readonly ListedPackage[]): string[] {
  if (listed.length === 0) {
    return ["", "  No hosted modules. Install a package with `hypen add <package>`.", ""];
  }
  const lines: string[] = [""];
  for (const pkg of listed) {
    const identity = pkg.name !== undefined && pkg.name !== pkg.from ? ` ${dim(`(${pkg.name})`)}` : "";
    lines.push(`  ${bold(pkg.from)}${identity}${pkg.version ? ` ${pkg.version}` : ""}  ${dim(pkg.status)}`);
    if (pkg.problem) lines.push(`    ${boldYellow("!")} ${pkg.problem}`);
    for (const module of pkg.modules) {
      // People know a module by its name in the package; how it is
      // installed is said once, below.
      const note = !module.exported ? dim("  (internal)") : module.installed !== module.name ? dim(`  (installed as ${module.installed})`) : "";
      lines.push(`    ${pink(module.name)}${note}`);
      lines.push(`      ${dim("granted:  ")} ${module.granted.join(", ") || dim("nothing")}`);
      if (pkg.kind !== "module") lines.push(`      ${dim("requested:")} ${module.requested.join(", ") || dim("nothing")}`);
      if (module.withheld.length > 0) lines.push(`      ${dim("withheld: ")} ${yellow(module.withheld.join(", "))}`);
      const mapped = Object.entries(module.mapped);
      if (mapped.length > 0) {
        lines.push(`      ${dim("mapped:   ")} ${mapped.map(([name, target]) => `${name} → the app's ${target}`).join(", ")}`);
      }
    }
    if (pkg.components.length > 0) lines.push(`    ${dim("components:")} ${pkg.components.join(", ")}`);
    if (pkg.kind !== "module" && pkg.exports.length > 0) {
      lines.push(`    ${dim("use:")} ${pkg.exports.map((e) => `${e} {}`).join(", ")}`);
    }
    if (pkg.namespace !== undefined && pkg.modules.some((m) => !m.exported)) {
      const example = pkg.modules.find((m) => !m.exported);
      lines.push(`    ${dim(`internal names are private to the package (installed as ${example?.installed}, …; they cannot clash with the app's)`)}`);
    }
    lines.push("");
  }
  return lines;
}
