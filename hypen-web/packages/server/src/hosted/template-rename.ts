/**
 * Renaming the components a `.hypen` template refers to, with the engine's
 * own parser (`renameTemplateComponents` of the wasm build): component tags
 * and the template's `module X` / `component X` declaration are renamed;
 * strings, comments, bindings and argument values are never touched.
 *
 * This is how a package's templates are made to say `AcmeCheckout__Cart {}`
 * where their author wrote `Cart {}` (see "names" in `module-package.ts`).
 */

import * as wasm from "../../wasm-node/hypen_engine.js";
import { HostedModuleSetupError } from "./errors.js";

type RenameFn = (source: string, renamesJson: string) => string;

/**
 * `template` with every component named by a key of `renames` renamed to
 * its value. Returns `template` itself when nothing in it is renamed.
 *
 * @throws {HostedModuleSetupError} `TEMPLATE_INVALID` when the template does
 *   not parse or a new name is not a component name; `ENGINE_UNSUPPORTED`
 *   when the engine build predates the helper.
 */
export function renameTemplateComponents(
  template: string,
  renames: Readonly<Record<string, string>>,
  where: { module?: string; file?: string } = {}
): string {
  if (Object.keys(renames).length === 0) return template;
  const rename = (wasm as unknown as { renameTemplateComponents?: RenameFn }).renameTemplateComponents;
  if (typeof rename !== "function") {
    throw new HostedModuleSetupError(
      "This engine build cannot rename template components (it predates namespaced module packages).",
      { code: "ENGINE_UNSUPPORTED", ...where, hint: "update @hypen-space/server" }
    );
  }
  try {
    return rename(template, JSON.stringify(renames));
  } catch (cause) {
    const message =
      cause !== null && typeof cause === "object" && "message" in cause
        ? String((cause as { message: unknown }).message)
        : String(cause);
    throw new HostedModuleSetupError(
      `The template${where.module ? ` of "${where.module}"` : ""} could not be installed under the package's names: ${message}`,
      {
        code: "TEMPLATE_INVALID",
        ...where,
        hint: "the package's template is not valid Hypen: rebuild the package (`hypen build --target wasm`) — its build checks templates",
        cause,
      }
    );
  }
}
