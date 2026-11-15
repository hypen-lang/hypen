/**
 * `hypen build --target wasm` — public entry.
 *
 * The implementation lives in `./wasm/` (one module per responsibility: see
 * `./wasm/build.ts` for the map). This file is the stable import path —
 * `bin/hypen.ts` and the built `dist/src/build-wasm.js` load it — and
 * re-exports the build function plus the pieces that are useful on their own
 * (config parsing, discovery, toolchain lookup, WIT provisioning).
 */

export { BuildError, formatBuildError } from "./build-error.js";
export type { BuildErrorCode, BuildErrorInfo, ToolFailure } from "./build-error.js";

export { buildWasm } from "./wasm/build.js";
export type { BuildWasmOptions } from "./wasm/build.js";

export { parseModuleName, scopeOf } from "./wasm/types.js";
export type {
  Abi,
  BuiltModule,
  Capabilities,
  Discovery,
  GrantableStorage,
  Language,
  ModuleName,
  PrebuiltModule,
  Project,
  ScopeName,
  StatefulModule,
  StatelessComponent,
} from "./wasm/types.js";

export { parseWasmConfig, resolveModuleCapabilities } from "./wasm/config.js";
export type { ModuleGrants, PrebuiltDeclaration, WasmConfig } from "./wasm/config.js";
export {
  copyPrebuiltModules,
  declaredPrebuiltNames,
  prebuiltNames,
  resolvePrebuiltModules,
} from "./wasm/prebuilt.js";
export type { CopiedPrebuilt } from "./wasm/prebuilt.js";

export { detectLanguage, detectProjectLanguage } from "./wasm/discover.js";
export type { DetectedLanguage } from "./wasm/discover.js";

export type {
  AppManifest,
  AppManifestModule,
  StatefulManifestEntry,
  StatelessManifestEntry,
} from "./wasm/manifest.js";

export { JCO_VERSION, TINYGO_MIN_VERSION, findJco, resolveJco } from "./wasm/toolchain.js";
export type { JcoTool, ToolLookup } from "./wasm/toolchain.js";

export {
  DEFERRED_HTTP_IMPORT,
  PROVISIONED_MARKER,
  TS_BUILD_WORLD,
  provisionRustWit,
  sameTree,
  tsBuildWorld,
} from "./wasm/wit.js";
export type { TsWorldGrants } from "./wasm/wit.js";
export type { WitProvisioning } from "./wasm/wit.js";

export { classifyWasm } from "./wasm/artifact.js";
export { nodeStubPlugin, nodeStubSource } from "./wasm/node-stubs.js";

export type { BuildContext, ModuleBuilder } from "./wasm/builders/builder.js";
export { tsShimEntrySource } from "./wasm/builders/ts.js";
export type { TsSource } from "./wasm/builders/ts.js";
export { collectGoComponents, renderGoShim } from "./wasm/builders/go.js";
export type { GoMode, GoSource } from "./wasm/builders/go.js";
export { cdylibWasmFromCargoMessages, collectRustComponents, rustCrateAbi } from "./wasm/builders/rust.js";
export type { RustSource } from "./wasm/builders/rust.js";
