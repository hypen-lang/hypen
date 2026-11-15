/**
 * Project discovery that is the same for every language: which language a
 * project is, what sits in its components directory, and whether the set of
 * components found can be built at all (names, collisions, entry).
 */

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { BuildError } from "../build-error.js";
import { scopeOf, type Discovery, type Language, type ModuleName, type Project } from "./types.js";

/** The file whose presence at the project root marks a language. */
const LANGUAGE_MARKERS: ReadonlyArray<{ language: Language; file: string }> = [
  { language: "rust", file: "Cargo.toml" },
  { language: "go", file: "go.mod" },
];

/** A project's language and how it was decided. */
export type DetectedLanguage =
  | { language: Language; from: "config" }
  /** Detected from a marker file at the project root. */
  | { language: Language; from: "marker"; file: string }
  /** No marker: TypeScript, the `hypen init` default. */
  | { language: "ts"; from: "default" };

/**
 * Decide the project's source language. An explicit `override` (hypen.json
 * `wasm.language`) wins; otherwise Rust projects have a `Cargo.toml`, Go
 * projects a `go.mod`, and anything else is TypeScript.
 *
 * @throws {BuildError} `LANGUAGE_AMBIGUOUS` when both markers are present and
 *   nothing says which one the modules are written in.
 */
export function detectProjectLanguage(projectDir: string, override?: Language): DetectedLanguage {
  if (override !== undefined) return { language: override, from: "config" };
  const present = LANGUAGE_MARKERS.filter((m) => existsSync(join(projectDir, m.file)));
  const [first, second] = present;
  if (first === undefined) return { language: "ts", from: "default" };
  if (second !== undefined) {
    throw new BuildError(
      `Cannot tell which language to build: ${projectDir} has both ${first.file} and ${second.file}.`,
      {
        code: "LANGUAGE_AMBIGUOUS",
        field: "wasm.language",
        hint: `say which one the modules are written in: "wasm": { "language": "${first.language}" } (or "${second.language}") in hypen.json`,
      }
    );
  }
  return { language: first.language, from: "marker", file: first.file };
}

/** `detectProjectLanguage`, reduced to the language. */
export function detectLanguage(projectDir: string, override?: Language): Language {
  return detectProjectLanguage(projectDir, override).language;
}

/** Module sources of each language found in one component directory. */
export interface ComponentSources {
  /** A TS module file in one of the layouts TS discovery recognises. */
  ts: boolean;
  /** Any `.go` file. */
  go: boolean;
  /** A `Cargo.toml` (the directory is a crate). */
  rust: boolean;
}

/** One subdirectory of the components directory that carries a template. */
export interface ComponentDir {
  /** The directory's name: the component name, unvalidated. */
  name: string;
  dir: string;
  files: string[];
  template: string;
  sources: ComponentSources;
}

/** Which languages' module sources a directory holds, judged by file names. */
export function componentSources(name: string, files: readonly string[]): ComponentSources {
  return {
    ts: ["component.ts", "index.ts", `${name}.ts`].some((f) => files.includes(f)),
    go: files.some((f) => f.endsWith(".go")),
    rust: files.includes("Cargo.toml"),
  };
}

/**
 * The component directories of a Go or Rust project: every subdirectory with
 * a `component.hypen` or `<Name>.hypen`. Sorted by name, so the manifest (and
 * the order modules are compiled in) does not depend on directory-entry
 * order, which varies between filesystems.
 */
export function scanComponentDirs(componentsDir: string): ComponentDir[] {
  const found: ComponentDir[] = [];
  for (const name of readdirSync(componentsDir).sort()) {
    const dir = join(componentsDir, name);
    let files: string[];
    try {
      if (!statSync(dir).isDirectory()) continue;
      files = readdirSync(dir);
    } catch {
      // A dangling symlink or an unreadable directory holds no component.
      continue;
    }
    const hypenFile = files.find((f) => f === "component.hypen" || f === `${name}.hypen`);
    if (hypenFile === undefined) continue;
    found.push({
      name,
      dir,
      files,
      template: readFileSync(join(dir, hypenFile), "utf8").trim(),
      sources: componentSources(name, files),
    });
  }
  return found;
}

const LANGUAGE_NAMES: Record<Language, string> = { ts: "TypeScript", go: "Go", rust: "Rust" };

/**
 * Reject a component that would be emitted as a stateless template although
 * it carries module sources in another language. One build compiles one
 * language; silently dropping such a module would produce an app whose
 * actions go nowhere.
 */
export function assertNoForeignModule(
  component: { name: string; dir: string; sources: ComponentSources },
  building: Language,
  prebuilt?: ReadonlySet<string>
): void {
  // A component declared prebuilt has its module already (the declared
  // `.wasm`); sources lying next to its template are how it was built, not
  // something this build would silently leave out.
  if (prebuilt?.has(component.name)) return;
  const foreign = (["ts", "go", "rust"] as const).find((l) => l !== building && component.sources[l]);
  if (foreign === undefined) return;
  throw new BuildError(
    `Component "${component.name}" has ${LANGUAGE_NAMES[foreign]} module sources, but this is a ` +
      `${LANGUAGE_NAMES[building]} build: it would be emitted as a stateless template and its ` +
      `module left out.`,
    {
      code: "LANGUAGE_MIXED",
      module: component.name,
      file: component.dir,
      field: "wasm.language",
      hint:
        `a wasm build compiles one language: set "wasm": { "language": "${foreign}" } in hypen.json ` +
        `if the project's modules are ${LANGUAGE_NAMES[foreign]}, or remove the ${LANGUAGE_NAMES[foreign]} sources from ${component.name}`,
    }
  );
}

/**
 * Check that what discovery found can be built: at least one component, no
 * two names sharing a scope, and an entry that is a stateful module.
 * `entryHint` says what a module of this language needs to look like.
 */
export function assertBuildable<S>(
  discovery: Discovery<S>,
  project: Project,
  entryHint: string
): void {
  const { stateful, stateless } = discovery;
  const all: ModuleName[] = [...stateful, ...stateless].map((c) => c.name);

  if (all.length === 0) {
    throw new BuildError(`No components found in ${project.componentsDir}.`, {
      code: "NO_COMPONENTS",
      file: project.componentsDir,
      hint: `add a component (e.g. ${project.entry}/component.hypen plus its module), or point "components" in hypen.json at the right directory`,
    });
  }

  // Scopes are lowercased names, and output files are `<Name>.wasm` /
  // `<Name>.hypen` — which also collide on case-insensitive filesystems.
  const byScope = new Map<string, ModuleName>();
  for (const name of all) {
    const scope = scopeOf(name);
    const other = byScope.get(scope);
    if (other !== undefined) {
      throw new BuildError(
        `Components "${other}" and "${name}" differ only by case: both would use the state scope "${scope}".`,
        {
          code: "MODULE_NAME_COLLISION",
          module: name,
          hint: `rename one of them (the engine keys modules by lowercased name)`,
        }
      );
    }
    byScope.set(scope, name);
  }

  if (stateful.some((m) => m.name === project.entry)) return;

  const entryIsStateless = stateless.some((c) => c.name === project.entry);
  if (stateful.length === 0 && entryIsStateless) {
    throw new BuildError(
      `No stateful modules found in ${project.componentsDir}: every component is template-only, ` +
        `so there is nothing to compile to wasm.`,
      {
        code: "NO_STATEFUL_MODULES",
        module: project.entry,
        file: project.componentsDir,
        hint: entryHint,
      }
    );
  }
  throw new BuildError(
    `Entry module "${project.entry}" not found among stateful components ` +
      `(${stateful.map((m) => m.name).join(", ") || "none"}).`,
    {
      code: "ENTRY_NOT_FOUND",
      module: project.entry,
      field: "entry",
      hint: entryIsStateless
        ? `"${project.entry}" is a stateless (template-only) component. ${entryHint}`
        : entryHint,
    }
  );
}
