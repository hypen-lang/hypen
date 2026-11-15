/**
 * Prebuilt modules: `wasm.modules.<Name>.component` in hypen.json.
 *
 * A prebuilt module is one the project *installs* rather than compiles — a
 * `.wasm` Component built elsewhere (a Rust crate, another team's build,
 * `hypen build --target wasm` of another project) plus, usually, its
 * `.hypen` template:
 *
 * ```json
 * "wasm": { "modules": { "Pricing": {
 *   "component": "./modules/pricing/pricing.wasm",
 *   "template":  "./modules/pricing/Pricing.hypen",
 *   "reads": ["Cart"]
 * } } }
 * ```
 *
 * `hypen dev` loads it next to the project's own modules; `hypen build
 * --target wasm` copies it into the output and lists it in `app.json` with
 * its grants; a server-based `hypen build` copies the files beside the
 * bundle. This file resolves the declarations against the project — paths,
 * existence, "is it a component" — once, for all of them.
 */

import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "fs";
import { dirname, isAbsolute, join, relative, resolve } from "path";
import { BuildError } from "../build-error.js";
import { classifyWasm } from "./artifact.js";
import type { WasmConfig } from "./config.js";
import { isRecord, parseModuleName, scopeOf, type ModuleName, type PrebuiltModule } from "./types.js";

const CONFIG_FILE = "hypen.json";

function readHeader(path: string): Uint8Array {
  const fd = openSync(path, "r");
  try {
    const buf = new Uint8Array(8);
    return buf.subarray(0, readSync(fd, buf, 0, 8, 0));
  } finally {
    closeSync(fd);
  }
}

const isFile = (path: string): boolean => existsSync(path) && statSync(path).isFile();

/** The names declared prebuilt, as written. */
export function prebuiltNames(config: WasmConfig): Set<string> {
  const names = new Set<string>();
  for (const [name, entry] of config.modules) {
    if (entry.prebuilt) names.add(name);
  }
  return names;
}

/**
 * The names a raw (unparsed, possibly malformed) hypen.json `wasm` section
 * declares prebuilt. For commands that do not otherwise read the section
 * and must not start rejecting a config they used to ignore.
 */
export function declaredPrebuiltNames(rawWasm: unknown): string[] {
  if (!isRecord(rawWasm) || !isRecord(rawWasm.modules)) return [];
  return Object.entries(rawWasm.modules)
    .filter(([, entry]) => isRecord(entry) && entry.component !== undefined)
    .map(([name]) => name);
}

/**
 * Resolve every prebuilt declaration against `projectDir`, in hypen.json
 * order.
 *
 * @throws {BuildError} `PREBUILT_COMPONENT_MISSING` / `PREBUILT_COMPONENT_INVALID`
 *   / `PREBUILT_TEMPLATE_MISSING` naming the field, `MODULE_NAME_INVALID`,
 *   and `MODULE_NAME_COLLISION` when two prebuilt names share a scope.
 */
export function resolvePrebuiltModules(config: WasmConfig, projectDir: string): PrebuiltModule[] {
  const root = resolve(projectDir);
  const modules: PrebuiltModule[] = [];
  const byScope = new Map<string, ModuleName>();
  for (const [rawName, entry] of config.modules) {
    const declared = entry.prebuilt;
    if (!declared) continue;
    const name = parseModuleName(rawName);
    const field = `wasm.modules.${rawName}`;

    const other = byScope.get(scopeOf(name));
    if (other !== undefined) {
      throw new BuildError(
        `${CONFIG_FILE}: prebuilt modules "${other}" and "${name}" differ only by case: both would use the state scope "${scopeOf(name)}".`,
        { code: "MODULE_NAME_COLLISION", module: name, file: CONFIG_FILE, field, hint: "rename one of them" }
      );
    }
    byScope.set(scopeOf(name), name);

    const componentPath = resolve(root, declared.component);
    if (!isFile(componentPath)) {
      throw new BuildError(
        `${CONFIG_FILE}: the component of prebuilt module "${name}" was not found: ${componentPath}`,
        {
          code: "PREBUILT_COMPONENT_MISSING",
          module: name,
          file: componentPath,
          field: `${field}.component`,
          hint: `build the module (or copy its .wasm there), or fix the path — it is relative to the project root (${root})`,
        }
      );
    }
    const found = classifyWasm(readHeader(componentPath));
    if (found.kind !== "component") {
      const what =
        found.kind === "empty"
          ? "an empty file"
          : found.kind === "core-module"
            ? "a core WebAssembly module, not a Component"
            : "not a WebAssembly binary";
      throw new BuildError(
        `${CONFIG_FILE}: the component of prebuilt module "${name}" is ${what} (${componentPath}).`,
        {
          code: "PREBUILT_COMPONENT_INVALID",
          module: name,
          file: componentPath,
          field: `${field}.component`,
          hint:
            found.kind === "core-module"
              ? "build it as a component: `cargo build --release --target wasm32-wasip2` for Rust (wasm32-unknown-unknown and wasm32-wasip1 produce core modules)"
              : "point it at the module's `.wasm` Component",
        }
      );
    }

    let templatePath: string | undefined;
    let template: string | undefined;
    if (declared.template !== undefined) {
      templatePath = resolve(root, declared.template);
      if (!isFile(templatePath)) {
        throw new BuildError(
          `${CONFIG_FILE}: the template of prebuilt module "${name}" was not found: ${templatePath}`,
          {
            code: "PREBUILT_TEMPLATE_MISSING",
            module: name,
            file: templatePath,
            field: `${field}.template`,
            hint: `create the module's .hypen template there, or fix the path — it is relative to the project root (${root})`,
          }
        );
      }
      template = readFileSync(templatePath, "utf8").trim();
    }
    modules.push({ kind: "prebuilt", name, componentPath, templatePath, template, field });
  }
  return modules;
}

/** The files a prebuilt module was copied to. */
export interface CopiedPrebuilt {
  name: ModuleName;
  files: string[];
}

/**
 * Copy every prebuilt module's files under `outDir` at the same
 * project-relative paths, so a bundled server entry that names them
 * relative to its working directory finds them whether it is started from
 * the project root or from `outDir`. Files outside the project root cannot
 * be mirrored that way and are left where they are (reported by the caller).
 */
export function copyPrebuiltModules(
  modules: readonly PrebuiltModule[],
  projectDir: string,
  outDir: string
): { copied: CopiedPrebuilt[]; outside: CopiedPrebuilt[] } {
  const root = resolve(projectDir);
  const copied: CopiedPrebuilt[] = [];
  const outside: CopiedPrebuilt[] = [];
  for (const module of modules) {
    const inTree: string[] = [];
    const notInTree: string[] = [];
    for (const source of [module.componentPath, module.templatePath]) {
      if (source === undefined) continue;
      const rel = relative(root, source);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        notInTree.push(source);
        continue;
      }
      const target = join(outDir, rel);
      // The project root as outDir (or a file already inside it): nothing to do.
      if (resolve(target) !== resolve(source)) {
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(source, target);
      }
      inTree.push(target);
    }
    if (inTree.length > 0) copied.push({ name: module.name, files: inTree });
    if (notInTree.length > 0) outside.push({ name: module.name, files: notInTree });
  }
  return { copied, outside };
}
